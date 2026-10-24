/* LocalMapRenderer — main-thread WebGL2 рендерер локальной карты
   (Этапы 8/9, CR-01 PR 5). Модуль 3 из четырёх распила
   site/shared/temp_code_structures.js (И-5).
   --------------------------------------------------------------------------
   Патч 8 (Этап 8): приём данных воркера переведён на порционную (staged)
   GPU-догрузку. GPU-ресурсы создаются ОДИН раз при инициализации, а данные
   очередного участка заливаются порциями через `gl.bufferSubData` по
   кадровому бюджету времени (по умолчанию 3 мс) — без пересоздания VAO и без
   фризов кадра во время dive-in перехода с глобуса на локальную карту.

   Контракт GPU-ресурсов:
   - terrain VAO: `terrainIdxBuf` (`Uint32Array`, `gl.UNSIGNED_INT`,
     (res - 1)² * 6 индексов) статичен и заливается один раз; `terrainPosBuf`
     и `terrainNormBuf` предвыделены на res² * 3 * 4 байт `DYNAMIC_DRAW` и
     обновляются порциями через `bufferSubData`;
   - VAO модуля: статические позиции/нормали/индексы меша плюс предвыделенный
     instance VBO (MAX_INSTANCES * 32 Б) с атрибутами location 2 и 3
     (`vertexAttribDivisor = 1`), настроенными один раз.

   Шейдеры — local-map-shaders.ts; layout-контракт атрибутов (locations 0…3,
   divisor 1 у инстансов) зафиксирован в обоих модулях. */

// Типы wire-протокола — только import type: value-импорт из модуля воркера
// тащил бы его побочный эффект регистрации onmessage в главный поток.
import {
  SKY_DOME_FRAGMENT_SHADER,
  SKY_DOME_VERTEX_SHADER,
  STRUCTURE_FRAGMENT_SHADER,
  STRUCTURE_VERTEX_SHADER,
  TERRAIN_FRAGMENT_SHADER,
  TERRAIN_VERTEX_SHADER,
} from './local-map-shaders.ts';
import type {
  HorizonSkirtData,
  LocalMapWorkerResponse,
  InstanceBuffers,
} from './local-map-worker.ts';
import type { MeshData, MeshLibrary } from './local-map-mesh.ts';

/**
 * Структурное расширение wire-контракта Stage-8.7. Воркер добавляет эти поля
 * независимо; рендерер не импортирует value-константы из модуля воркера.
 */
export type RingLevel = 1 | 2 | 3 | 4 | 5;

export interface RingCellLike {
  readonly cell: number;
  readonly ring: RingLevel;
  readonly center: readonly [number, number, number];
  readonly offsetM: readonly [number, number];
  readonly hfRes: number;
  /** Ширина сетки сэмплов кольца; по умолчанию ширина GPU-квадрата 2·R_patch. */
  readonly spanM?: number;
  readonly heightfield: Float32Array;
  readonly waterMask: Uint8Array;
  readonly minHeightM: number;
  readonly maxHeightM: number;
}

export type LocalMapRendererWorkerResponse = LocalMapWorkerResponse & {
  readonly ringCells?: readonly RingCellLike[];
};

export interface LocalMapRingStats {
  /** Число активных ячеек колец 1…5. */
  cells: number;
  /** Занятые ими байты в общих position/normal/local/water/index-буферах. */
  bytes: number;
}

/** Хард-кап инстансов на модуль (зеркало контракта воркера: MAX_INSTANCES). */
export const MAX_INSTANCES_PER_MODULE = 4096;
/** Байт на инстанс: 8 float (a_inst_pos_yaw + a_inst_scale_tint). */
export const INSTANCE_STRIDE_BYTES = 32;
/** Размер порции заливки вершин/нормалей/инстансов, байт. */
export const UPLOAD_CHUNK_BYTES = 96 * 1024;
/** Бюджет одной порции staged-догрузки по умолчанию, мс. */
export const DEFAULT_UPLOAD_BUDGET_MS = 3.0;

export interface LocalMapGpuMesh {
  readonly vao: WebGLVertexArrayObject | null;
  readonly indexCount: number;
}

export interface LocalMapInstanceVbo {
  readonly vbo: WebGLBuffer | null;
  count: number;
}

export interface LocalMapVaoStats {
  /** Сколько раз создавался VAO рельефа (контракт Патча 8: ровно 1). */
  terrainVaoCreates: number;
  /** Сколько раз создавались VAO модулей построек. */
  moduleVaoCreates: number;
  /** Число порционных вызовов `gl.bufferSubData`. */
  stagedSubDataCalls: number;
}

export interface LocalMapPrograms {
  readonly terrainProgram: WebGLProgram;
  readonly structureProgram: WebGLProgram;
}

/** Состояние камеры для купола неба (Stage-8 Planetary Horizon). */
export interface LocalMapCameraState {
  readonly pitch: number;
  readonly yaw: number;
  readonly fovY: number;
  readonly aspect: number;
  readonly heightM: number;
}

export interface LocalMapRenderOptions {
  readonly lightDir?: readonly [number, number, number];
  readonly ambientColor?: readonly [number, number, number];
  readonly fogColor?: readonly [number, number, number];
  /** Начало кругового тумана в долях radiusM (по умолчанию 0.72). */
  readonly fogStartRatio?: number;
  /** Конец кругового тумана в долях radiusM (по умолчанию 0.98). */
  readonly fogEndRatio?: number;
  /** Абсолютное начало тумана, м (приоритетнее fogStartRatio). */
  readonly fogStart?: number;
  /** Абсолютный конец тумана, м (приоритетнее fogEndRatio). */
  readonly fogEnd?: number;
  /** Радиус планеты R_p для сферического проседания, м (0 — выключено). */
  readonly planetRadiusM?: number;
  /** Радиус детального участка R_patch для оптического блюра, м. */
  readonly focusRadiusM?: number;
  /** Шаг гексов d_hex для сетки 6 колец, м. */
  readonly hexSizeM?: number;
  /** Цвет атмосферного лимба у горизонта. */
  readonly horizonColor?: readonly [number, number, number];
  /** Камера для купола неба; без неё скайдом не рисуется. */
  readonly camera?: LocalMapCameraState;
  /**
   * Альфа купола неба/лимба (по умолчанию 1.0 — непрозрачный дневной купол
   * с облаками; явное значение 0..1 сохраняет обратную совместимость).
   */
  readonly skyAlpha?: number;
  /** Явный флаг непрозрачного купола неба (совместимость с прежними вызовами). */
  readonly opaqueSkyDome?: boolean;
}

const DEFAULT_LIGHT_DIR: readonly [number, number, number] = [0.42, 0.28, 0.86];
const DEFAULT_AMBIENT: readonly [number, number, number] = [0.42, 0.45, 0.48];
const DEFAULT_FOG_COLOR: readonly [number, number, number] = [0.68, 0.75, 0.82];
const DEFAULT_HORIZON_COLOR: readonly [number, number, number] = [0.76, 0.82, 0.88];
const FOG_START_RATIO = 0.72;
const FOG_END_RATIO = 0.98;
const LOCAL_STRIDE_BYTES = 2 * Float32Array.BYTES_PER_ELEMENT;

/** Стадии staged-догрузки (Патч 8). */
const STAGE_TEXTURES = 0;
const STAGE_POSITIONS = 1;
const STAGE_NORMALS = 2;
const STAGE_INSTANCES = 3;
const STAGE_RING_INDICES = 4;
const STAGE_RING_POSITIONS = 5;
const STAGE_RING_NORMALS = 6;
const STAGE_RING_WATER = 7;
const STAGE_COUNT = 4;
const STAGE_COUNT_WITH_RINGS = 8;

/** Контракт LOD Stage-8.7: индекс соответствует номеру кольца. */
const RING_LEVELS = 5;
const RING_HF_RES: readonly number[] = Object.freeze([256, 64, 32, 16, 8, 4]);
const RING_SLOT_BASE: readonly number[] = Object.freeze([0, 0, 6, 18, 36, 60]);
const VERTEX_STRIDE_BYTES = 3 * Float32Array.BYTES_PER_ELEMENT;
const INDEX_STRIDE_BYTES = Uint32Array.BYTES_PER_ELEMENT;

interface RingSlotLayout {
  readonly level: RingLevel;
  readonly vertexOffset: number;
  readonly indexOffset: number;
}

interface RingDrawItem {
  readonly cell: RingCellLike;
  readonly level: RingLevel;
  readonly res: number;
  /** Абсолютные смещения в общих буферах центрального меша и колец. */
  readonly vertexOffset: number;
  readonly indexOffset: number;
  readonly indexCount: number;
}

function buildRingSlotLayout(): readonly RingSlotLayout[] {
  const slots: RingSlotLayout[] = [];
  let vertexOffset = 0;
  let indexOffset = 0;
  for (let level = 1; level <= RING_LEVELS; level++) {
    const res = RING_HF_RES[level] as number;
    for (let slot = 0; slot < level * 6; slot++) {
      slots.push({ level: level as RingLevel, vertexOffset, indexOffset });
      vertexOffset += res * res;
      indexOffset += (res - 1) * (res - 1) * 6;
    }
  }
  return slots;
}

const RING_SLOT_LAYOUT = buildRingSlotLayout();
const RING_VERTEX_CAPACITY = RING_SLOT_LAYOUT.reduce(
  (sum, slot) => {
    const res = RING_HF_RES[slot.level] as number;
    return sum + res * res;
  }, 0,
);
const RING_INDEX_CAPACITY = RING_SLOT_LAYOUT.reduce(
  (sum, slot) => {
    const res = RING_HF_RES[slot.level] as number;
    return sum + (res - 1) * (res - 1) * 6;
  }, 0,
);

/** Записывает CCW-квады сетки в общий Uint32-индексный буфер. */
function writeGridIndices(
  target: Uint32Array,
  targetOffset: number,
  res: number,
  vertexOffset: number,
  fromRow: number,
  toRow: number,
): void {
  const quadsPerRow = res - 1;
  let ptr = targetOffset;
  for (let y = fromRow; y < toRow; y++) {
    for (let x = 0; x < quadsPerRow; x++) {
      const tl = vertexOffset + y * res + x;
      const tr = tl + 1;
      const bl = tl + res;
      const br = bl + 1;
      target[ptr++] = tl; target[ptr++] = bl; target[ptr++] = tr;
      target[ptr++] = tr; target[ptr++] = bl; target[ptr++] = br;
    }
  }
}

interface PendingUpload {
  data: LocalMapRendererWorkerResponse;
  /** Размер сетки рельефа payload-а (для позиций/нормалей). */
  readonly res: number;
  readonly rings: readonly RingDrawItem[];
  readonly totalStages: number;
  stage: number;
  /** Курсор строк сетки на стадиях positions/normals. */
  row: number;
  /** Порядок модулей на стадии instances. */
  moduleIds: string[];
  moduleIndex: number;
  /** Курсор инстансов текущего модуля (в инстансах, не в байтах). */
  moduleInstance: number;
  /** Текущая ячейка и строка на стадиях порционной заливки колец. */
  ringIndex: number;
  ringRow: number;
}

interface LocalMapModuleBuffers {
  position: WebGLBuffer | null;
  normal: WebGLBuffer | null;
  index: WebGLBuffer | null;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class StructureRenderer {
  private gl: WebGL2RenderingContext;
  private meshLibrary: Record<string, LocalMapGpuMesh> | null;
  private moduleBuffers: Record<string, LocalMapModuleBuffers>;
  private terrainVAO: WebGLVertexArrayObject | null;
  private terrainPosBuf: WebGLBuffer | null;
  private terrainNormBuf: WebGLBuffer | null;
  private terrainWaterBuf: WebGLBuffer | null;
  private terrainLocalBuf: WebGLBuffer | null;
  private terrainIdxBuf: WebGLBuffer | null;
  private terrainRes: number;
  private terrainIndexCount: number;
  /** Общие с буферами центра слоты колец; VAO остаётся неизменным. */
  private ringStorageAllocated: boolean;
  private activeRings: readonly RingDrawItem[];
  private ringBytes: number;
  private indexScratch: Uint32Array;
  private texZoning: WebGLTexture | null;
  private texTerraform: WebGLTexture | null;
  private instanceVBOs: Record<string, LocalMapInstanceVbo>;
  private pending: PendingUpload | null;
  private scratch: Float32Array;
  private programs: LocalMapPrograms | null;
  private uniformCache: Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>;
  private stats: LocalMapVaoStats;
  /** Бюджет порции по умолчанию (переопределяется enqueueWorkerData). */
  private uploadBudgetMs: number;
  // Stage-8: ресурсы планетарной юбки 6 колец и купола неба создаются
  // ЛЕНИВО только в setHorizonSkirt — initMeshLibrary/onWorkerData/
  // compilePrograms инварианты тестов (VAO/программы) не нарушают.
  private skirtVAO: WebGLVertexArrayObject | null;
  private skirtPosBuf: WebGLBuffer | null;
  private skirtNormBuf: WebGLBuffer | null;
  private skirtWaterBuf: WebGLBuffer | null;
  private skirtRiverBuf: WebGLBuffer | null;
  private skirtIdxBuf: WebGLBuffer | null;
  private skyVAO: WebGLVertexArrayObject | null;
  private skyProgram: WebGLProgram | null;
  private skirtIndexCount: number;
  private skirt: HorizonSkirtData | null;
  ready: boolean;
  /** Метка размеров последнего принятого payload (hfRes/zoneRes/tfRes/radiusM). */
  meta: LocalMapWorkerResponse['meta'] | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.meshLibrary = null;   // { moduleId: { vao, indexCount } }
    this.moduleBuffers = {};
    this.terrainVAO = null;
    this.terrainPosBuf = null;
    this.terrainNormBuf = null;
    this.terrainWaterBuf = null;
    this.terrainLocalBuf = null;
    this.terrainIdxBuf = null;
    this.terrainRes = 0;
    this.terrainIndexCount = 0;
    this.ringStorageAllocated = false;
    this.activeRings = [];
    this.ringBytes = 0;
    this.indexScratch = new Uint32Array(0);
    this.texZoning = null;
    this.texTerraform = null;
    this.instanceVBOs = {};    // { moduleId: { vbo, count } }
    this.pending = null;
    this.scratch = new Float32Array(0);
    this.programs = null;
    this.uniformCache = new Map();
    this.stats = { terrainVaoCreates: 0, moduleVaoCreates: 0, stagedSubDataCalls: 0 };
    this.uploadBudgetMs = DEFAULT_UPLOAD_BUDGET_MS;
    this.skirtVAO = null;
    this.skirtPosBuf = null;
    this.skirtNormBuf = null;
    this.skirtWaterBuf = null;
    this.skirtRiverBuf = null;
    this.skirtIdxBuf = null;
    this.skyVAO = null;
    this.skyProgram = null;
    this.skirtIndexCount = 0;
    this.skirt = null;
    this.ready = false;
    this.meta = null;
  }

  // ---- Инициализация библиотеки мешей (один раз при старте) ----
  initMeshLibrary(meshes: MeshLibrary | Readonly<Record<string, MeshData>>): void {
    // meshes = buildMeshLibrary() из local-map-mesh.ts
    const gl = this.gl;
    const library: Record<string, LocalMapGpuMesh> = {};
    const buffers: Record<string, LocalMapModuleBuffers> = {};

    for (const [id, mesh] of Object.entries(meshes)) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      // Positions → location 0
      const posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

      // Normals → location 1
      const normBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

      // Index buffer
      const idxBuf = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

      // Патч 8: instance VBO предвыделен на хард-кап инстансов, атрибуты
      // location 2/3 с divisor = 1 настраиваются здесь ОДИН раз — смена
      // участка обновляет инстансы только через gl.bufferSubData.
      const instVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, instVbo);
      gl.bufferData(gl.ARRAY_BUFFER, MAX_INSTANCES_PER_MODULE * INSTANCE_STRIDE_BYTES, gl.DYNAMIC_DRAW);

      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, INSTANCE_STRIDE_BYTES, 0);
      gl.vertexAttribDivisor(2, 1);

      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, INSTANCE_STRIDE_BYTES, 16);
      gl.vertexAttribDivisor(3, 1);

      gl.bindVertexArray(null);

      library[id] = { vao, indexCount: mesh.indexCount };
      buffers[id] = { position: posBuf, normal: normBuf, index: idxBuf };
      this.instanceVBOs[id] = { vbo: instVbo, count: 0 };
      this.stats.moduleVaoCreates++;
    }
    this.meshLibrary = library;
    this.moduleBuffers = buffers;
  }

  // ---- Патч 8: постановка данных воркера в очередь порционной догрузки ----
  enqueueWorkerData(data: LocalMapRendererWorkerResponse, budgetMs: number = DEFAULT_UPLOAD_BUDGET_MS): void {
    // latest-wins: новый участок вытесняет незавершённую догрузку предыдущего.
    const res = data.meta.hfRes;
    const moduleIds = Object.keys(data.instanceBuffers);
    this.meta = data.meta;
    this.ensureTerrainVao(res);
    const rings = this.createRingDrawItems(data.ringCells ?? []);
    if (rings.length > 0) this.ensureRingStorage();
    this.activeRings = rings;
    this.ringBytes = rings.reduce(
      (sum, item) => sum + item.res * item.res * (VERTEX_STRIDE_BYTES * 2 + LOCAL_STRIDE_BYTES + 1)
        + item.indexCount * INDEX_STRIDE_BYTES,
      0,
    );
    this.pending = {
      data,
      res,
      rings,
      totalStages: rings.length > 0 ? STAGE_COUNT_WITH_RINGS : STAGE_COUNT,
      stage: STAGE_TEXTURES,
      row: 0,
      moduleIds,
      moduleIndex: 0,
      moduleInstance: 0,
      ringIndex: 0,
      ringRow: 0,
    };
    // До завершения очередной порции кадр не рисует недогруженный участок.
    this.ready = false;
    // Кадровый бюджет запоминается и применяется в processPendingUpload(),
    // если его вызывают без явного аргумента (цикл рендера страницы).
    if (Number.isFinite(budgetMs) && budgetMs > 0) this.uploadBudgetMs = budgetMs;
  }

  /**
   * Отрабатывает порции staged-догрузки в пределах бюджета.
   * @returns `true`, когда вся загрузка завершена (очередь пуста).
   */
  processPendingUpload(budgetMs: number = this.uploadBudgetMs): boolean {
    if (!this.pending) return true;
    const deadline = Number.isFinite(budgetMs) ? nowMs() + Math.max(0, budgetMs) : Infinity;

    for (;;) {
      const done = this.stepUpload();
      if (done) {
        this.pending = null;
        this.ready = true;
        return true;
      }
      if (nowMs() >= deadline) return false;
    }
  }

  isUploading(): boolean {
    return this.pending !== null;
  }

  /** Прогресс staged-догрузки: 0..1 (1 — всё залито). */
  getUploadProgress(): number {
    const pending = this.pending;
    if (!pending) return this.ready ? 1 : 0;
    const res = pending.res;
    let fraction = 0;
    if (pending.stage === STAGE_POSITIONS) fraction = res > 0 ? pending.row / res : 1;
    else if (pending.stage === STAGE_NORMALS) fraction = res > 0 ? pending.row / res : 1;
    else if (pending.stage === STAGE_INSTANCES) {
      const total = pending.moduleIds.length;
      const moduleFraction = total > 0 ? pending.moduleIndex / total : 1;
      fraction = moduleFraction;
    } else if (pending.stage >= STAGE_RING_INDICES) {
      const total = pending.rings.length;
      const item = pending.rings[pending.ringIndex];
      const rows = item
        ? (pending.stage === STAGE_RING_INDICES ? item.res - 1 : item.res)
        : 1;
      const cellFraction = item ? pending.ringRow / Math.max(1, rows) : 0;
      fraction = total > 0 ? (pending.ringIndex + cellFraction) / total : 1;
    }
    const value = (pending.stage + fraction) / pending.totalStages;
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }

  getVaoStats(): LocalMapVaoStats {
    return { ...this.stats };
  }

  /** Фактически занятые активными кольцами ресурсы для приёмочного гейта G6.3. */
  getRingStats(): LocalMapRingStats {
    return { cells: this.activeRings.length, bytes: this.ringBytes };
  }

  // ---- Приём данных от Worker (синхронная совместимость) ----
  onWorkerData(data: LocalMapRendererWorkerResponse): void {
    this.enqueueWorkerData(data, Infinity);
    this.processPendingUpload(Infinity);
  }

  // ---- Террейн: VAO и буферы создаются один раз на res (Патч 8) ----
  private ensureTerrainVao(res: number): void {
    const gl = this.gl;
    if (this.terrainVAO && this.terrainRes === res) return;
    if (this.terrainVAO) this.disposeTerrain();

    this.terrainRes = res;
    const quadsPerRow = Math.max(0, res - 1);
    this.terrainIndexCount = quadsPerRow * quadsPerRow * 6;

    // Индексный буфер статичен для сетки res×res: Uint32Array, UNSIGNED_INT.
    const indices = new Uint32Array(this.terrainIndexCount);
    writeGridIndices(indices, 0, res, 0, 0, quadsPerRow);

    const vao = gl.createVertexArray();
    this.terrainVAO = vao;
    gl.bindVertexArray(vao);

    this.terrainPosBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, res * res * 3 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    this.terrainNormBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainNormBuf);
    gl.bufferData(gl.ARRAY_BUFFER, res * res * 3 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    // Байтовая водная маска колец: normalized UNSIGNED_BYTE → float 0..1.
    // Центральная часть остаётся нулевой и использует прежнюю terraform-текстуру.
    this.terrainWaterBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainWaterBuf);
    gl.bufferData(gl.ARRAY_BUFFER, res * res, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, true, 0, 0);

    // Локальные XY нужны гексагональному срезу при batch-draw целого кольца.
    this.terrainLocalBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainLocalBuf);
    gl.bufferData(gl.ARRAY_BUFFER, res * res * LOCAL_STRIDE_BYTES, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);

    this.terrainIdxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.terrainIdxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    this.stats.terrainVaoCreates++;
  }

  /**
   * Раскладывает ячейки по стабильным слотам 6·ring. Порядок payload не влияет
   * на GPU-адреса: сортировка по (ring, cell) убирает мерцание при latest-wins.
   */
  private createRingDrawItems(cells: readonly RingCellLike[]): readonly RingDrawItem[] {
    const sorted = cells.slice().sort((a, b) => a.ring - b.ring || a.cell - b.cell);
    const usedByRing = [0, 0, 0, 0, 0, 0];
    const items: RingDrawItem[] = [];
    const centralVertexCount = this.terrainRes * this.terrainRes;
    for (const cell of sorted) {
      const level = cell.ring;
      const res = Math.floor(cell.hfRes);
      const maxRes = RING_HF_RES[level];
      const slot = usedByRing[level] as number;
      if (!maxRes || res < 2 || res > maxRes || slot >= level * 6) continue;
      if (cell.heightfield.length < res * res || cell.waterMask.length < res * res) continue;
      const layout = RING_SLOT_LAYOUT[(RING_SLOT_BASE[level] as number) + slot];
      if (!layout) continue;
      usedByRing[level] = slot + 1;
      items.push({
        cell,
        level,
        res,
        vertexOffset: centralVertexCount + layout.vertexOffset,
        indexOffset: this.terrainIndexCount + layout.indexOffset,
        indexCount: (res - 1) * (res - 1) * 6,
      });
    }
    return items;
  }

  /**
   * Один раз расширяет уже существующие terrainPosBuf/NormBuf/IdxBuf. VAO и
   * сами WebGLBuffer-объекты не пересоздаются; последующие участки идут только
   * через bufferSubData независимо от числа видимых колец.
   */
  private ensureRingStorage(): void {
    if (this.ringStorageAllocated) return;
    const gl = this.gl;
    const res = this.terrainRes;
    const centralVertexCount = res * res;
    const totalVertices = centralVertexCount + RING_VERTEX_CAPACITY;
    const totalIndices = this.terrainIndexCount + RING_INDEX_CAPACITY;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, totalVertices * VERTEX_STRIDE_BYTES, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainNormBuf);
    gl.bufferData(gl.ARRAY_BUFFER, totalVertices * VERTEX_STRIDE_BYTES, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainWaterBuf);
    gl.bufferData(gl.ARRAY_BUFFER, totalVertices, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainLocalBuf);
    gl.bufferData(gl.ARRAY_BUFFER, totalVertices * LOCAL_STRIDE_BYTES, gl.DYNAMIC_DRAW);

    const indices = new Uint32Array(totalIndices);
    writeGridIndices(indices, 0, res, 0, 0, res - 1);
    for (const slot of RING_SLOT_LAYOUT) {
      const slotRes = RING_HF_RES[slot.level] as number;
      writeGridIndices(
        indices,
        this.terrainIndexCount + slot.indexOffset,
        slotRes,
        centralVertexCount + slot.vertexOffset,
        0,
        slotRes - 1,
      );
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.terrainIdxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.ringStorageAllocated = true;
  }

  /** Одна порция staged-догрузки. `true` — очередь исчерпана. */
  private stepUpload(): boolean {
    const pending = this.pending;
    if (!pending) return true;
    const gl = this.gl;
    const data = pending.data;
    const meta = data.meta;
    const res = pending.res;

    if (pending.stage === STAGE_TEXTURES) {
      this.uploadTextures(data);
      pending.stage = STAGE_POSITIONS;
      pending.row = 0;
      return false;
    }

    if (pending.stage === STAGE_POSITIONS || pending.stage === STAGE_NORMALS) {
      const rowsPerChunk = Math.max(1, Math.floor(UPLOAD_CHUNK_BYTES / Math.max(1, res * 3 * 4)));
      const from = pending.row;
      const to = Math.min(res, from + rowsPerChunk);
      const floatCount = (to - from) * res * 3;
      if (this.scratch.length < floatCount) this.scratch = new Float32Array(floatCount);
      const lines = to - from;

      if (pending.stage === STAGE_POSITIONS) {
        this.fillPositions(data.heightfield, res, meta.radiusM, from, lines);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainPosBuf);
      } else {
        this.fillNormals(data.heightfield, res, meta.radiusM, from, lines);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainNormBuf);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, from * res * 3 * 4, this.scratch.subarray(0, floatCount));
      this.stats.stagedSubDataCalls++;

      pending.row = to;
      if (pending.row >= res) {
        pending.stage = pending.stage === STAGE_POSITIONS ? STAGE_NORMALS : STAGE_INSTANCES;
        pending.row = 0;
      }
      return false;
    }

    if (pending.stage >= STAGE_RING_INDICES) {
      return this.uploadNextRingChunk(pending.stage);
    }

    // STAGE_INSTANCES: порционная заливка instance VBO по модулям.
    if (!this.uploadNextInstanceChunk(data.instanceBuffers)) return false;
    if (pending.rings.length > 0) {
      pending.stage = STAGE_RING_INDICES;
      pending.ringIndex = 0;
      pending.ringRow = 0;
      return false;
    }
    return true;
  }

  private uploadTextures(data: LocalMapWorkerResponse): void {
    const gl = this.gl;
    const meta = data.meta;

    if (!this.texZoning) this.texZoning = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texZoning);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RG8UI,
      meta.zoneRes, meta.zoneRes, 0,
      gl.RG_INTEGER, gl.UNSIGNED_BYTE, data.zoneMap,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (!this.texTerraform) this.texTerraform = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texTerraform);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R8,
      meta.tfRes, meta.tfRes, 0,
      gl.RED, gl.UNSIGNED_BYTE, data.terraformMap,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private fillPositions(heightfield: Float32Array, res: number, radiusM: number, from: number, lines: number): void {
    const cellSize = (2 * radiusM) / res;
    const scratch = this.scratch;
    let out = 0;
    for (let y = from; y < from + lines; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        scratch[out++] = (x - res / 2) * cellSize;
        scratch[out++] = (y - res / 2) * cellSize;
        scratch[out++] = heightfield[i] as number;
      }
    }
  }

  private fillNormals(heightfield: Float32Array, res: number, radiusM: number, from: number, lines: number): void {
    const cellSize = (2 * radiusM) / res;
    const scratch = this.scratch;
    let out = 0;
    for (let y = from; y < from + lines; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        const hL = x > 0 ? heightfield[i - 1] as number : heightfield[i] as number;
        const hR = x < res - 1 ? heightfield[i + 1] as number : heightfield[i] as number;
        const hD = y > 0 ? heightfield[i - res] as number : heightfield[i] as number;
        const hU = y < res - 1 ? heightfield[i + res] as number : heightfield[i] as number;
        const nx = (hL - hR) / (2 * cellSize);
        const ny = (hD - hU) / (2 * cellSize);
        const len = Math.hypot(nx, ny, 1.0);
        scratch[out++] = nx / len;
        scratch[out++] = ny / len;
        scratch[out++] = 1.0 / len;
      }
    }
  }

  /** Позиции кольцевой ячейки в метрах общего касательного кадра активного гекса. */
  private fillRingPositions(
    item: RingDrawItem,
    radiusM: number,
    from: number,
    lines: number,
  ): void {
    const { cell, res } = item;
    const cellSize = (cell.spanM ?? 2 * radiusM) / res;
    const [offsetX, offsetY] = cell.offsetM;
    const scratch = this.scratch;
    let out = 0;
    for (let y = from; y < from + lines; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        scratch[out++] = offsetX + (x - res / 2) * cellSize;
        scratch[out++] = offsetY + (y - res / 2) * cellSize;
        // heightfield уже содержит метрическую высоту; center — канонический
        // идентификатор на сфере, а не дополнительное смещение касательного меша.
        scratch[out++] = cell.heightfield[i] as number;
      }
    }
  }

  /** Локальные XY для гексагонального среза без uniform на каждую ячейку. */
  private fillRingLocal(item: RingDrawItem, radiusM: number, from: number, lines: number): void {
    const { cell, res } = item;
    const cellSize = (cell.spanM ?? 2 * radiusM) / res;
    const scratch = this.scratch;
    let out = 0;
    for (let y = from; y < from + lines; y++) {
      for (let x = 0; x < res; x++) {
        scratch[out++] = (x - res / 2) * cellSize;
        scratch[out++] = (y - res / 2) * cellSize;
      }
    }
  }

  /** Нормали кольцевой ячейки по центральным конечным разностям её heightfield. */
  private fillRingNormals(
    item: RingDrawItem,
    radiusM: number,
    from: number,
    lines: number,
  ): void {
    const { cell, res } = item;
    const cellSize = (cell.spanM ?? 2 * radiusM) / res;
    const heightfield = cell.heightfield;
    const scratch = this.scratch;
    let out = 0;
    for (let y = from; y < from + lines; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        const hL = x > 0 ? heightfield[i - 1] as number : heightfield[i] as number;
        const hR = x < res - 1 ? heightfield[i + 1] as number : heightfield[i] as number;
        const hD = y > 0 ? heightfield[i - res] as number : heightfield[i] as number;
        const hU = y < res - 1 ? heightfield[i + res] as number : heightfield[i] as number;
        const nx = (hL - hR) / (2 * cellSize);
        const ny = (hD - hU) / (2 * cellSize);
        const len = Math.hypot(nx, ny, 1.0);
        scratch[out++] = nx / len;
        scratch[out++] = ny / len;
        scratch[out++] = 1.0 / len;
      }
    }
  }

  /** Одна порция индексов, позиций, нормалей или водной маски ячейки. */
  private uploadNextRingChunk(stage: number): boolean {
    const pending = this.pending;
    if (!pending) return true;
    const gl = this.gl;
    if (pending.ringIndex >= pending.rings.length) {
      if (stage === STAGE_RING_WATER) return true;
      pending.stage = stage === STAGE_RING_INDICES
        ? STAGE_RING_POSITIONS
        : stage === STAGE_RING_POSITIONS ? STAGE_RING_NORMALS : STAGE_RING_WATER;
      pending.ringIndex = 0;
      pending.ringRow = 0;
      return false;
    }

    const item = pending.rings[pending.ringIndex] as RingDrawItem;
    const res = item.res;
    const isIndices = stage === STAGE_RING_INDICES;
    const isWater = stage === STAGE_RING_WATER;
    const rowCount = isIndices ? res - 1 : res;
    const rowBytes = isIndices
      ? (res - 1) * 6 * INDEX_STRIDE_BYTES
      : isWater ? res : res * VERTEX_STRIDE_BYTES;
    const rowsPerChunk = Math.max(1, Math.floor(UPLOAD_CHUNK_BYTES / Math.max(1, rowBytes)));
    const from = pending.ringRow;
    const to = Math.min(rowCount, from + rowsPerChunk);
    const lines = to - from;

    if (isIndices) {
      const indexCount = lines * (res - 1) * 6;
      if (this.indexScratch.length < indexCount) this.indexScratch = new Uint32Array(indexCount);
      writeGridIndices(this.indexScratch, 0, res, item.vertexOffset, from, to);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.terrainIdxBuf);
      gl.bufferSubData(
        gl.ELEMENT_ARRAY_BUFFER,
        (item.indexOffset + from * (res - 1) * 6) * INDEX_STRIDE_BYTES,
        this.indexScratch.subarray(0, indexCount),
      );
    } else if (isWater) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainWaterBuf);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        item.vertexOffset + from * res,
        item.cell.waterMask.subarray(from * res, to * res),
      );
    } else {
      const floatCount = lines * res * 3;
      if (this.scratch.length < floatCount) this.scratch = new Float32Array(floatCount);
      if (stage === STAGE_RING_POSITIONS) {
        this.fillRingPositions(item, pending.data.meta.radiusM, from, lines);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainPosBuf);
      } else {
        this.fillRingNormals(item, pending.data.meta.radiusM, from, lines);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainNormBuf);
      }
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        (item.vertexOffset + from * res) * VERTEX_STRIDE_BYTES,
        this.scratch.subarray(0, floatCount),
      );
      if (stage === STAGE_RING_POSITIONS) {
        const localFloatCount = lines * res * 2;
        this.fillRingLocal(item, pending.data.meta.radiusM, from, lines);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainLocalBuf);
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          (item.vertexOffset + from * res) * LOCAL_STRIDE_BYTES,
          this.scratch.subarray(0, localFloatCount),
        );
        this.stats.stagedSubDataCalls++;
      }
    }
    this.stats.stagedSubDataCalls++;
    pending.ringRow = to;
    if (pending.ringRow >= rowCount) {
      pending.ringIndex++;
      pending.ringRow = 0;
    }
    return false;
  }

  /**
   * Заливает очередную порцию инстансов. `true` — стадия завершена
   * (все модули обновлены).
   */
  private uploadNextInstanceChunk(instanceBuffers: InstanceBuffers): boolean {
    const gl = this.gl;
    const pending = this.pending;
    if (!pending) return true;
    const chunkInstances = Math.max(1, Math.floor(UPLOAD_CHUNK_BYTES / INSTANCE_STRIDE_BYTES));

    while (pending.moduleIndex < pending.moduleIds.length) {
      const moduleId = pending.moduleIds[pending.moduleIndex] as string;
      const pack = instanceBuffers[moduleId as keyof InstanceBuffers];
      const entry = this.instanceVBOs[moduleId];
      if (!pack || !entry) {
        pending.moduleIndex++;
        pending.moduleInstance = 0;
        continue;
      }
      const total = Math.min(pack.count, MAX_INSTANCES_PER_MODULE);
      entry.count = total;

      if (pending.moduleInstance >= total) {
        pending.moduleIndex++;
        pending.moduleInstance = 0;
        continue;
      }

      const from = pending.moduleInstance;
      const to = Math.min(total, from + chunkInstances);
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.vbo);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        from * INSTANCE_STRIDE_BYTES,
        pack.buffer.subarray(from * 8, to * 8),
      );
      this.stats.stagedSubDataCalls++;
      pending.moduleInstance = to;
      return false;
    }

    // Модули, отсутствующие в новом payload, гасим (count = 0).
    for (const [moduleId, entry] of Object.entries(this.instanceVBOs)) {
      if (!instanceBuffers[moduleId as keyof InstanceBuffers]) entry.count = 0;
    }
    return true;
  }

  // ---- Stage-8: планетарная юбка 6 колец и купол неба (ленивая инициализация) ----
  /**
   * Назначает геометрию планетарной юбки. VAO/буферы юбки и программа купола
   * неба создаются ТОЛЬКО здесь (не в initMeshLibrary/onWorkerData/
   * compilePrograms), поэтому инварианты staged-догрузки Патча 8 сохраняются.
   * Передача `null` освобождает все GPU-ресурсы горизонта.
   */
  setHorizonSkirt(skirt: HorizonSkirtData | null): void {
    const gl = this.gl;
    if (!skirt) {
      this.disposeSkirt();
      return;
    }
    if (!this.skirtVAO) {
      this.skirtVAO = gl.createVertexArray();
      gl.bindVertexArray(this.skirtVAO);

      this.skirtPosBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.skirtPosBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

      this.skirtNormBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.skirtNormBuf);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

      this.skirtWaterBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.skirtWaterBuf);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.UNSIGNED_BYTE, true, 0, 0);

      this.skirtRiverBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.skirtRiverBuf);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 1, gl.UNSIGNED_BYTE, true, 0, 0);

      this.skirtIdxBuf = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.skirtIdxBuf);
      gl.bindVertexArray(null);

      // Пустой VAO для полноэкранного треугольника купола (без атрибутов).
      this.skyVAO = gl.createVertexArray();
      // Скайдом — третья программа: на createProgram это влияет только при
      // реально включённом горизонте.
      this.skyProgram = this.linkProgram(
        SKY_DOME_VERTEX_SHADER, SKY_DOME_FRAGMENT_SHADER, 'sky-dome');
    }

    gl.bindVertexArray(this.skirtVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skirtPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, skirt.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skirtNormBuf);
    gl.bufferData(gl.ARRAY_BUFFER, skirt.normals, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skirtWaterBuf);
    gl.bufferData(gl.ARRAY_BUFFER, skirt.waterMask, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skirtRiverBuf);
    gl.bufferData(gl.ARRAY_BUFFER, skirt.riverMask, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.skirtIdxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, skirt.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.skirtIndexCount = skirt.indices.length;
    this.skirt = skirt;
  }

  /** Рисует купол неба/лимба полноэкранным треугольником без записи глубины. */
  private drawSky(
    program: WebGLProgram,
    fogColor: readonly [number, number, number],
    horizonColor: readonly [number, number, number],
    lightDir: readonly [number, number, number],
    camera: LocalMapCameraState,
    skyAlpha: number,
  ): void {
    const gl = this.gl;
    const planetRadiusM = this.skirt ? this.skirt.planetRadiusM : 0;
    gl.useProgram(program);
    gl.uniform1f(this.uniform(program, 'u_camPitch'), camera.pitch);
    gl.uniform1f(this.uniform(program, 'u_camYaw'), camera.yaw);
    gl.uniform1f(this.uniform(program, 'u_fovY'), camera.fovY);
    gl.uniform1f(this.uniform(program, 'u_aspect'), camera.aspect);
    gl.uniform1f(this.uniform(program, 'u_camHeightM'), camera.heightM);
    gl.uniform1f(this.uniform(program, 'u_planetRadiusM'), planetRadiusM);
    // Альфа купола неба (по умолчанию 1.0 — полноценный непрозрачный скайдом).
    gl.uniform1f(this.uniform(program, 'u_skyAlpha'), skyAlpha);
    gl.uniform3fv(this.uniform(program, 'u_lightDir'), lightDir);
    gl.uniform3fv(this.uniform(program, 'u_fogColor'), fogColor);
    gl.uniform3fv(this.uniform(program, 'u_horizonColor'), horizonColor);

    gl.depthMask(false);
    gl.bindVertexArray(this.skyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.depthMask(true);
  }

  /** Рисует планетарную юбку 6 колец текущей terrain-программой. */
  private drawSkirt(program: WebGLProgram): void {
    if (!this.skirtVAO || this.skirtIndexCount === 0) return;
    const gl = this.gl;
    gl.useProgram(program);
    // В зоне воротника юбка перекрывается с центральным мешем: небольшой
    // polygon offset уводит её назад по глубине, чтобы центральный рельеф
    // гарантированно выигрывал без z-fighting на совпадающих высотах.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(RING_LEVELS + 1, (RING_LEVELS + 1) * 2);
    gl.bindVertexArray(this.skirtVAO);
    gl.drawElements(gl.TRIANGLES, this.skirtIndexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  private disposeSkirt(): void {
    const gl = this.gl;
    if (this.skirtPosBuf) gl.deleteBuffer(this.skirtPosBuf);
    if (this.skirtNormBuf) gl.deleteBuffer(this.skirtNormBuf);
    if (this.skirtWaterBuf) gl.deleteBuffer(this.skirtWaterBuf);
    if (this.skirtRiverBuf) gl.deleteBuffer(this.skirtRiverBuf);
    if (this.skirtIdxBuf) gl.deleteBuffer(this.skirtIdxBuf);
    if (this.skirtVAO) gl.deleteVertexArray(this.skirtVAO);
    if (this.skyVAO) gl.deleteVertexArray(this.skyVAO);
    if (this.skyProgram) gl.deleteProgram(this.skyProgram);
    this.skirtPosBuf = null;
    this.skirtNormBuf = null;
    this.skirtWaterBuf = null;
    this.skirtRiverBuf = null;
    this.skirtIdxBuf = null;
    this.skirtVAO = null;
    this.skyVAO = null;
    this.skyProgram = null;
    this.skirtIndexCount = 0;
    this.skirt = null;
  }

  // ---- Программы шейдеров ----
  compilePrograms(): LocalMapPrograms {
    if (this.programs) return this.programs;
    const terrainProgram = this.linkProgram(TERRAIN_VERTEX_SHADER, TERRAIN_FRAGMENT_SHADER, 'terrain');
    const structureProgram = this.linkProgram(STRUCTURE_VERTEX_SHADER, STRUCTURE_FRAGMENT_SHADER, 'structure');
    this.programs = { terrainProgram, structureProgram };
    return this.programs;
  }

  private compileShader(type: number, source: string, label: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error(`LocalMapRenderer: не удалось создать шейдер ${label}`);
    gl.shaderSource(shader, source.trimStart());
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`LocalMapRenderer: ошибка компиляции шейдера ${label}: ${log ?? ''}`);
    }
    return shader;
  }

  private linkProgram(vsSource: string, fsSource: string, label: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource, `${label}.vert`);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource, `${label}.frag`);
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error(`LocalMapRenderer: не удалось создать программу ${label}`);
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`LocalMapRenderer: ошибка линковки программы ${label}: ${log ?? ''}`);
    }
    return program;
  }

  private uniform(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    const gl = this.gl;
    let cache = this.uniformCache.get(program);
    if (!cache) {
      cache = new Map();
      this.uniformCache.set(program, cache);
    }
    if (cache.has(name)) {
      const cached = cache.get(name);
      return cached === undefined ? null : cached;
    }
    const location = gl.getUniformLocation(program, name);
    cache.set(name, location);
    return location;
  }

  // ---- Render Loop ----
  /**
   * Порядок 5 → 1, один draw на непрерывный диапазон уровня. При контрактном
   * RING_HF_RES все 6·level ячеек смежны, поэтому пять колец стоят пять draws.
   */
  private drawRingTerrain(shaderProgram: WebGLProgram): void {
    if (!this.ready || this.activeRings.length === 0) return;
    const gl = this.gl;
    gl.useProgram(shaderProgram);
    gl.uniform1f(this.uniform(shaderProgram, 'u_isSkirt'), 0.0);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.bindVertexArray(this.terrainVAO);
    for (let level = RING_LEVELS; level >= 1; level--) {
      let runOffset = 0;
      let runCount = 0;
      let runEnd = 0;
      for (const item of this.activeRings) {
        if (item.level !== level) continue;
        if (runCount === 0) {
          gl.uniform1f(this.uniform(shaderProgram, 'u_ringLevel'), level);
          gl.uniform1f(
            this.uniform(shaderProgram, 'u_ringFade'),
            (level - 1) / (RING_LEVELS - 1),
          );
          // Дальнее кольцо глубже, центральный патч рисуется без смещения.
          gl.polygonOffset(level, level * 2);
          runOffset = item.indexOffset;
        } else if (item.indexOffset !== runEnd) {
          gl.drawElements(
            gl.TRIANGLES, runCount, gl.UNSIGNED_INT, runOffset * INDEX_STRIDE_BYTES,
          );
          runOffset = item.indexOffset;
          runCount = 0;
        }
        runCount += item.indexCount;
        runEnd = item.indexOffset + item.indexCount;
      }
      if (runCount > 0) {
        gl.drawElements(
          gl.TRIANGLES, runCount, gl.UNSIGNED_INT, runOffset * INDEX_STRIDE_BYTES,
        );
      }
    }
    gl.bindVertexArray(null);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.uniform1f(this.uniform(shaderProgram, 'u_ringLevel'), 0.0);
    gl.uniform1f(this.uniform(shaderProgram, 'u_ringFade'), 0.0);
  }

  drawTerrain(shaderProgram: WebGLProgram): void {
    if (!this.ready) return;
    const gl = this.gl;

    gl.useProgram(shaderProgram);

    // Bind textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texZoning);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texTerraform);

    gl.bindVertexArray(this.terrainVAO);
    gl.drawElements(gl.TRIANGLES, this.terrainIndexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  drawStructures(shaderProgram: WebGLProgram): void {
    if (!this.ready) return;
    const gl = this.gl;

    gl.useProgram(shaderProgram);

    for (const [moduleId, inst] of Object.entries(this.instanceVBOs)) {
      if (inst.count === 0) continue;
      const mesh = this.meshLibrary ? this.meshLibrary[moduleId] : null;
      if (!mesh) continue;

      gl.bindVertexArray(mesh.vao);
      gl.drawElementsInstanced(
        gl.TRIANGLES,
        mesh.indexCount,
        gl.UNSIGNED_SHORT,     // Меш-индексы — 16-bit (модули маленькие, <100 вершин)
        0,
        inst.count,
      );
    }

    gl.bindVertexArray(null);
  }

  /** Полный кадр: небо → кольца 5…1 → центр → юбка → постройки. */
  renderFrame(viewProj: Float32Array, options: LocalMapRenderOptions = {}): void {
    const gl = this.gl;
    const { terrainProgram, structureProgram } = this.compilePrograms();
    const radiusM = this.meta ? this.meta.radiusM : 0;
    const lightDir = options.lightDir ?? DEFAULT_LIGHT_DIR;
    const ambient = options.ambientColor ?? DEFAULT_AMBIENT;
    const fogColor = options.fogColor ?? DEFAULT_FOG_COLOR;
    const horizonColor = options.horizonColor ?? DEFAULT_HORIZON_COLOR;
    // Абсолютные метры тумана (Stage-8) имеют приоритет над ratio-вариантами.
    const fogStart = Number.isFinite(options.fogStart)
      ? (options.fogStart as number)
      : this.skirt && options.fogStartRatio === undefined
        ? this.skirt.outerRadiusM * 0.64
        : radiusM * (options.fogStartRatio ?? FOG_START_RATIO);
    const fogEnd = Number.isFinite(options.fogEnd)
      ? (options.fogEnd as number)
      : this.skirt && options.fogEndRatio === undefined
        ? this.skirt.outerRadiusM * FOG_END_RATIO
        : radiusM * (options.fogEndRatio ?? FOG_END_RATIO);
    const terrainSize = 2 * radiusM;
    const planetRadiusM = options.planetRadiusM ?? this.skirt?.planetRadiusM ?? 0;
    const focusRadiusM = options.focusRadiusM ?? radiusM;
    const hexSizeM = options.hexSizeM ?? this.skirt?.hexSpacingM ?? 0;
    // По умолчанию дневной купол, облака и атмосферный лимб рендерятся
    // непрозрачно (skyAlpha = 1.0); явный options.skyAlpha сохраняет совместимость.
    const rawSkyAlpha = typeof options?.skyAlpha === 'number' ? options.skyAlpha : 1.0;
    const skyAlpha = Number.isFinite(rawSkyAlpha)
      ? Math.min(1, Math.max(0, rawSkyAlpha))
      : 1.0;

    // Альфа-смешивание нужно только при полупрозрачном куполе (skyAlpha < 1.0);
    // в штатном непрозрачном режиме рельеф и скайдом сшиваются с alpha = 1.0.
    // Проверки typeof нужны для mock-контекста в Node-тестах.
    const blendingEnabled = this.skirt !== null
      && skyAlpha < 1.0
      && typeof gl.enable === 'function'
      && typeof gl.blendFunc === 'function'
      && typeof gl.BLEND === 'number'
      && typeof gl.SRC_ALPHA === 'number'
      && typeof gl.ONE_MINUS_SRC_ALPHA === 'number';
    if (blendingEnabled) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    // 1. Купол атмосферы и горизонта (depthMask выключен внутри drawSky).
    if (this.skirt && this.skyProgram && this.skyVAO && options.camera) {
      this.drawSky(this.skyProgram, fogColor, horizonColor, lightDir, options.camera, skyAlpha);
    }

    // 2. Рельеф: общие юниформы для юбки и центрального участка.
    gl.useProgram(terrainProgram);
    gl.uniformMatrix4fv(this.uniform(terrainProgram, 'u_viewProj'), false, viewProj);
    gl.uniform1f(this.uniform(terrainProgram, 'u_terrainSize'), terrainSize);
    gl.uniform3fv(this.uniform(terrainProgram, 'u_lightDir'), lightDir);
    gl.uniform3fv(this.uniform(terrainProgram, 'u_ambientColor'), ambient);
    gl.uniform3fv(this.uniform(terrainProgram, 'u_fogColor'), fogColor);
    gl.uniform3fv(this.uniform(terrainProgram, 'u_horizonColor'), horizonColor);
    gl.uniform1f(this.uniform(terrainProgram, 'u_fogStart'), fogStart);
    gl.uniform1f(this.uniform(terrainProgram, 'u_fogEnd'), fogEnd);
    gl.uniform1f(this.uniform(terrainProgram, 'u_planetRadiusM'), planetRadiusM);
    gl.uniform1f(this.uniform(terrainProgram, 'u_focusRadiusM'), focusRadiusM);
    gl.uniform1f(this.uniform(terrainProgram, 'u_hexSizeM'), hexSizeM);
    gl.uniform1i(this.uniform(terrainProgram, 'u_zoning_map'), 0);
    gl.uniform1i(this.uniform(terrainProgram, 'u_terraform_map'), 1);
    gl.uniform1f(this.uniform(terrainProgram, 'u_ringLevel'), 0.0);
    gl.uniform1f(this.uniform(terrainProgram, 'u_ringFade'), 0.0);

    // Текстуры читает только центральный участок; ветка юбки в шейдере
    // игнорирует их, поэтому CLAMP_TO_EDGE не растягивает зоны на горизонт.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texZoning);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texTerraform);

    if (this.ready && this.activeRings.length > 0) {
      // Stage-8.7: кольца 5 → 1 → центральный патч → сферическая юбка.
      this.drawRingTerrain(terrainProgram);
      gl.uniform1f(this.uniform(terrainProgram, 'u_isSkirt'), 0.0);
      this.drawTerrain(terrainProgram);
      if (this.skirt && this.skirtVAO) {
        gl.uniform1f(this.uniform(terrainProgram, 'u_isSkirt'), 1.0);
        this.drawSkirt(terrainProgram);
        gl.uniform1f(this.uniform(terrainProgram, 'u_isSkirt'), 0.0);
      }
    } else {
      // Без колец сохраняется прежний порядок Stage-8.6 и его wire-контракт.
      if (this.skirt && this.skirtVAO) {
        gl.uniform1f(this.uniform(terrainProgram, 'u_isSkirt'), 1.0);
        this.drawSkirt(terrainProgram);
        gl.uniform1f(this.uniform(terrainProgram, 'u_isSkirt'), 0.0);
      } else {
        gl.uniform1f(this.uniform(terrainProgram, 'u_isSkirt'), 0.0);
      }
      this.drawTerrain(terrainProgram);
    }

    // 3. 3D-структуры (с тем же сферическим проседанием).
    gl.useProgram(structureProgram);
    gl.uniformMatrix4fv(this.uniform(structureProgram, 'u_viewProj'), false, viewProj);
    gl.uniform3fv(this.uniform(structureProgram, 'u_lightDir'), lightDir);
    gl.uniform3fv(this.uniform(structureProgram, 'u_ambientColor'), ambient);
    gl.uniform3fv(this.uniform(structureProgram, 'u_fogColor'), fogColor);
    gl.uniform1f(this.uniform(structureProgram, 'u_fogStart'), fogStart);
    gl.uniform1f(this.uniform(structureProgram, 'u_fogEnd'), fogEnd);
    gl.uniform1f(this.uniform(structureProgram, 'u_planetRadiusM'), planetRadiusM);
    this.drawStructures(structureProgram);

    // 4. Состояние GL возвращается в исходное: альфа-смешивание нужно только
    //    на время кадра локальной карты (прозрачный край кластера).
    if (blendingEnabled && typeof gl.disable === 'function') {
      gl.disable(gl.BLEND);
    }
  }

  // ---- Освобождение GPU-ресурсов ----
  dispose(): void {
    const gl = this.gl;
    this.disposeTerrain();
    this.disposeSkirt();

    for (const [moduleId, entry] of Object.entries(this.instanceVBOs)) {
      if (entry.vbo) gl.deleteBuffer(entry.vbo);
      this.instanceVBOs[moduleId] = { vbo: null, count: 0 };
    }
    this.instanceVBOs = {};

    for (const mesh of Object.values(this.meshLibrary ?? {})) {
      if (mesh.vao) gl.deleteVertexArray(mesh.vao);
    }
    for (const buffers of Object.values(this.moduleBuffers)) {
      if (buffers.position) gl.deleteBuffer(buffers.position);
      if (buffers.normal) gl.deleteBuffer(buffers.normal);
      if (buffers.index) gl.deleteBuffer(buffers.index);
    }
    this.meshLibrary = null;
    this.moduleBuffers = {};

    if (this.texZoning) gl.deleteTexture(this.texZoning);
    if (this.texTerraform) gl.deleteTexture(this.texTerraform);
    this.texZoning = null;
    this.texTerraform = null;

    if (this.programs) {
      gl.deleteProgram(this.programs.terrainProgram);
      gl.deleteProgram(this.programs.structureProgram);
      this.programs = null;
    }
    this.uniformCache.clear();

    this.pending = null;
    this.meta = null;
    this.activeRings = [];
    this.ringBytes = 0;
    this.ready = false;
  }

  private disposeTerrain(): void {
    const gl = this.gl;
    if (this.terrainPosBuf) gl.deleteBuffer(this.terrainPosBuf);
    if (this.terrainNormBuf) gl.deleteBuffer(this.terrainNormBuf);
    if (this.terrainWaterBuf) gl.deleteBuffer(this.terrainWaterBuf);
    if (this.terrainLocalBuf) gl.deleteBuffer(this.terrainLocalBuf);
    if (this.terrainIdxBuf) gl.deleteBuffer(this.terrainIdxBuf);
    if (this.terrainVAO) gl.deleteVertexArray(this.terrainVAO);
    this.terrainPosBuf = null;
    this.terrainNormBuf = null;
    this.terrainWaterBuf = null;
    this.terrainLocalBuf = null;
    this.terrainIdxBuf = null;
    this.terrainVAO = null;
    this.terrainRes = 0;
    this.terrainIndexCount = 0;
    this.ringStorageAllocated = false;
  }
}
