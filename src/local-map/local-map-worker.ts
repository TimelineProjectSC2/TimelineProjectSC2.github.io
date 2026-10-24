/* LocalMapWorker — CPU-генератор локальной карты (Этапы 8/9, CR-01 PR 5).
   Модуль 2 из четырёх распила site/shared/temp_code_structures.js (И-5).
   --------------------------------------------------------------------------
   Архитектурный базис (LOCKED CONTRACT): worker — единственный источник
   истины: генерирует heightfield, zone_map (Uint8Array RG), terraform_map
   (Uint8Array R) и scatter-инстансы; всё отдаётся Transferable-буферами.
   Вход по И-3 — канонический срез 7 ячеек глобуса v=128 (LocalMapPatch из
   local-map-contract.ts): сэмплы полей обязаны идти через единый 3D-сэмплер
   planet-core / planet-geography, а спавн структур — через buildingSpawnMask
   (вода, озёра, русла рек, крутые склоны запрещены).

   Поля wire-протокола ниже разделяет с рендерером (local-map-renderer.ts)
   только через `import type` — у модуля есть побочный эффект регистрации
   onmessage, и value-импорт из него тащил бы его в главный поток.

   Stage-8.12d: распил. Рельеф — local-map-heightfield.ts, русла — local-map-rivers.ts,
   здесь оркестрация и юбка. Публичные имена реэкспортируются отсюда. */

import {
  baseElevationOf,
  buildBuildingSpawnMask,
  isWaterCell,
  localPointToDirection,
  nearestPatchCell,
  patchSpanMeters,
  verifyPatchInvariants,
  waterLevelOf,
} from './local-map-contract.ts';
import type { BuildingSpawnRule, LocalMapPatch, PatchCell } from './local-map-contract.ts';
import type { MeshModuleId } from './local-map-mesh.ts';
import type { GeographyProfileInput } from '../../site/shared/planet-geography.ts';
// Stage-8.10b (A-12b): чистые геометрические хелперы живут в
// local-map-geometry.ts — главный поток импортирует их оттуда напрямую,
// а не через этот модуль (который тащит ядро). Реэкспорт нужен для
// обратной совместимости публичного API воркера и Node-тестов.
import { CENTER_HEX_APOTHEM_RATIO, SKIRT_RING_COUNT, mapNeighborCellsToSlots, planetCurvatureDropM } from './local-map-geometry.ts';

export { SKIRT_RING_COUNT, mapNeighborCellsToSlots, planetCurvatureDropM };

import {
  HEIGHTFIELD_RES, TERRAFORM_RES, METERS_PER_ELEVATION_UNIT,
  PROFILE_DETAIL_AMPLITUDE_M, RING_LEVELS,
  HEX_APOTHEM_RATIO, CENTER_HEX_RADIUS_RATIO, SKIRT_HEX_SPACING_RATIO, hashFloat, hashFloat2,
  valueNoise2D, clusterHexMetric, buildNeighborRingCells,
  sampleLocalTerrainHeightM, smooth01, clampScalar, buildBaseHeightfield,
} from './local-map-heightfield.ts';
import type { LocalMapRingCell } from './local-map-heightfield.ts';
import { RIVER_HALF_WIDTH_RATIO, RIVER_DEPTH_RATIO, riverSegments, riverCarveFactor, applyRiverCarve } from './local-map-rivers.ts';

export {
  HEIGHTFIELD_RES, TERRAFORM_RES, METERS_PER_ELEVATION_UNIT, LAND_FBM_AMPLITUDE_M,
  PROFILE_DETAIL_AMPLITUDE_M, DETAIL_LATTICE_STEPS, LOCAL_HEX_CORE_RADIUS_RATIO,
  LOCAL_PATCH_RAMP_START_RATIO, LOCAL_PATCH_RAMP_END_RATIO, LOCAL_PATCH_FALL_START_RATIO,
  LOCAL_PATCH_FALL_END_RATIO, TERRAFORM_LAND_MIN, TERRAFORM_ALPHA_SPAN, RING_LEVELS, RING_HF_RES,
  MAX_RING_CELLS, HEX_APOTHEM_RATIO, CENTER_HEX_RADIUS_RATIO, SKIRT_HEX_SPACING_RATIO, ridgedFbm,
  generateTerraformMap, hexMetric2D, clusterHexMetric,
} from './local-map-heightfield.ts';
export type { RingLevel, LocalMapRingCell } from './local-map-heightfield.ts';
export { RIVER_HALF_WIDTH_RATIO, RIVER_DEPTH_RATIO } from './local-map-rivers.ts';

export const ZONE_RES = 64;
export const MAX_INSTANCES = 4096;

/** Ёмкость LRU-кэша локальных участков (И-3, Патч 8). */
export const LOCAL_MAP_CACHE_LIMIT = 8;

/** Данные инстанса: 8 float × 4 Б = 32 байта (контракт layout-а шейдера). */
export type InstanceData = readonly [
  x: number, y: number, z: number, yaw: number,
  sx: number, sy: number, sz: number, tintPacked: number,
];

export interface ScatterInstance {
  readonly moduleId: MeshModuleId;
  readonly data: InstanceData;
}

export interface InstancePack {
  readonly buffer: Float32Array;
  readonly count: number;
}

export type InstanceBuffers = Partial<Record<MeshModuleId, InstancePack>>;

export interface LocalMapMeta {
  readonly radiusM: number;
  readonly hfRes: number;
  readonly zoneRes: number;
  readonly tfRes: number;
  /** Число высаженных инстансов 3D-структур (после маски И-3.4). */
  readonly totalInstances?: number;
  /** Доля точек рельефа, где разрешён спавн (buildingSpawnMask == 1). */
  readonly buildableFraction?: number;
  /** Доля точек рельефа, попавших в воду/озёра канонических ячеек (И-3.2). */
  readonly waterFraction?: number;
  readonly minHeightM?: number;
  readonly maxHeightM?: number;
  /** Время CPU-генерации участка, мс (гейт G4: <= 150 мс). */
  readonly genMs?: number;
  /** Ключ участка (§8.8); по умолчанию строка канонического центра. */
  readonly patchKey?: string;
  /** Число сгенерированных ячеек колец 1..neighborRings (Stage-8.7). */
  readonly ringCellCount?: number;
  /** Время генерации колец, мс (Stage-8.7, гейт <= 20 мс). */
  readonly ringGenMs?: number;
}

export interface LocalMapWorkerRequest {
  /** Канонический срез 7 ячеек глобуса v=128 (И-3): обязателен для воркера. */
  readonly patch: LocalMapPatch;
  readonly seed: number;
  readonly placeId: number;
  readonly radiusM: number;
  readonly centerLat?: number;
  readonly centerLon?: number;
  /** Правило маски спавна (И-3.4); по умолчанию DEFAULT_BUILDING_SPAWN_RULE. */
  readonly spawnRule?: BuildingSpawnRule;
  /** Профиль планеты для единого 3D-сэмплера полей (И-3.1); без него — только fBm. */
  readonly profile?: GeographyProfileInput;
  /** Ключ участка §8.8 — ключ LRU-кэша и метки `meta.patchKey`. */
  readonly patchKey?: string;
  /**
   * Stage-8.7: число колец соседних областей вокруг активного гекса, 0..5
   * (по умолчанию 5). 0 отключает кольца, но не возвращает старое поле main.
   * Кольца требуют профиля (единый 3D-сэмплер).
   */
  readonly neighborRings?: number;
}

export interface LocalMapWorkerResponse {
  readonly heightfield: Float32Array;
  readonly zoneMap: Uint8Array;
  readonly terraformMap: Uint8Array;
  readonly instanceBuffers: InstanceBuffers;
  readonly meta: LocalMapMeta;
  /**
   * Stage-8.7: ячейки колец 1..neighborRings вокруг активного гекса.
   * Отсутствует при neighborRings = 0 или без профиля (нет 3D-сэмпера).
   */
  readonly ringCells?: readonly LocalMapRingCell[];
}

// ---- Box Blur (separable, 2 прохода) ----
export function boxBlurSeparable(src: Float32Array, w: number, h: number, kernelRadius: number): Float32Array {
  const dst = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  const k = kernelRadius;
  const d = 2 * k + 1;

  // Горизонтальный проход
  for (let row = 0; row < h; row++) {
    let sum = 0;
    // Инициализация окна для первого пикселя строки
    for (let dx = -k; dx <= k; dx++) {
      sum += src[row * w + Math.max(0, Math.min(dx, w - 1))] as number;
    }
    tmp[row * w] = sum / d;
    for (let col = 1; col < w; col++) {
      const addIdx = Math.min(col + k, w - 1);
      const remIdx = Math.max(col - k - 1, 0);
      sum += (src[row * w + addIdx] as number) - (src[row * w + remIdx] as number);
      tmp[row * w + col] = sum / d;
    }
  }

  // Вертикальный проход
  for (let col = 0; col < w; col++) {
    let sum = 0;
    for (let dy = -k; dy <= k; dy++) {
      sum += tmp[Math.max(0, Math.min(dy, h - 1)) * w + col] as number;
    }
    dst[col] = sum / d;
    for (let row = 1; row < h; row++) {
      const addIdx = Math.min(row + k, h - 1);
      const remIdx = Math.max(row - k - 1, 0);
      sum += (tmp[addIdx * w + col] as number) - (tmp[remIdx * w + col] as number);
      dst[row * w + col] = sum / d;
    }
  }

  return dst;
}

// ---- Генерация текстурных карт (CPU) ----
export function generateZoneMap(seed: number, placeId: number): Uint8Array {
  // Stage-8.3: органические поселковые кластеры и хутора в природной долине
  // вместо сплошной концентрической «мишени» до d = 0.95. Гладкий 2D-шум
  // clusterNoise вырезает компактные гроздья застройки только в долине
  // (d < 0.78): большая часть гекса остаётся природным ландшафтом
  // (zone = 0, density = 0 — луга и склоны), а внутри гроздей радиус по-прежнему
  // задаёт характер застройки (ядро → пром → жилая → периметр) и плотность,
  // достаточную для спавна зданий в scatterInstances.
  const map = new Uint8Array(ZONE_RES * ZONE_RES * 2); // RG
  const cx = ZONE_RES / 2, cy = ZONE_RES / 2;
  const maxR = ZONE_RES / 2;
  const baseSeed = seed ^ (placeId * 48611);

  for (let y = 0; y < ZONE_RES; y++) {
    for (let x = 0; x < ZONE_RES; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy) / maxR;  // 0..1+
      const clusterNoise = valueNoise2D(x * 0.14, y * 0.14, baseSeed ^ 0x71C9);

      let zone = 0, density = 0;                      // Природный ландшафт
      if (d < 0.78) {
        // Порог грозди растёт к краю долины: у ядра посёлок плотнее и шире,
        // к периферии остаются лишь редкие хутора на сильных гребнях шума.
        const radialT = Math.min(1, Math.max(0, (d - 0.10) / 0.68));
        const radialSmooth = radialT * radialT * (3 - 2 * radialT);
        const threshold = 0.51 + 0.15 * radialSmooth;
        if (clusterNoise > threshold) {
          // Сила грозди: 0 на органической границе пятна, 1 в его сердцевине.
          const strength = Math.min(1, (clusterNoise - threshold) / 0.22);
          const jitter = hashFloat(x, y, baseSeed + 1) * 20;
          if (d < 0.13) {
            zone = 4; density = Math.floor(190 + strength * 55 + jitter);   // Ядро
          } else if (d < 0.32) {
            zone = 2; density = Math.floor(150 + strength * 75 + jitter);   // Пром
          } else if (d < 0.60) {
            zone = 1; density = Math.floor(120 + strength * 75 + jitter);   // Лёгкая застройка
          } else {
            zone = 3; density = Math.floor(95 + strength * 65 + jitter);    // Периметр/хутора
          }
        }
      }

      const idx = (y * ZONE_RES + x) * 2;
      map[idx] = zone;
      map[idx + 1] = Math.min(255, Math.max(0, density));
    }
  }
  return map;
}

/**
 * И-3.2/И-3.4: вода, озёра и русла не получают зонирования. Тексели `zone_map`,
 * попавшие в водные канонические ячейки Patch7, переводятся в зону 0 (пустошь)
 * с нулевой плотностью — шейдер рельефа по `zone == 0u` и глубине ниже
 * `seaLevel` плавно тонирует их водно-бирюзовым оттенком, а `scatterInstances`
 * не ставит над ними ни одного здания. При переданном `radiusM > 0` тексель
 * проверяется и на размахе `patchSpanMeters(patch)`, и на локальном размахе
 * `2 · radiusM` — малый детальный участок не наследует зонирование сухих
 * соседей, попавших на края полного патча.
 */
export function applyWaterZoning(
  zoneMap: Uint8Array,
  patch: LocalMapPatch,
  radiusM?: number,
): Uint8Array {
  const zRes = ZONE_RES;
  const span = patchSpanMeters(patch);
  // При малом radiusM детальный участок занимает лишь центральную часть
  // patchSpanMeters, поэтому тексель проверяется ещё и на локальном размахе
  // 2 · radiusM: иначе зонирование «сухих соседей» перекрывало бы озеро.
  const localSpan = typeof radiusM === 'number' && radiusM > 0 ? 2 * radiusM : 0;
  const isWaterOrRiver = (u: number, v: number): boolean => {
    const cell = nearestPatchCell(patch, localPointToDirection(patch, u, v));
    return isWaterCell(cell, patch.seaLevel) || cell.streamWeight > 0;
  };
  for (let zy = 0; zy < zRes; zy++) {
    const v = ((zy + 0.5) / zRes - 0.5) * span;
    const vLocal = localSpan > 0 ? ((zy + 0.5) / zRes - 0.5) * localSpan : 0;
    for (let zx = 0; zx < zRes; zx++) {
      const u = ((zx + 0.5) / zRes - 0.5) * span;
      const wetOnSpan = isWaterOrRiver(u, v);
      if (!wetOnSpan) {
        if (localSpan <= 0) continue;
        const uLocal = ((zx + 0.5) / zRes - 0.5) * localSpan;
        if (!isWaterOrRiver(uLocal, vLocal)) continue;
      }
      const idx = (zy * zRes + zx) * 2;
      zoneMap[idx] = 0;
      zoneMap[idx + 1] = 0;
    }
  }
  return zoneMap;
}

// ---- ZONE_MODULES (зеркало контракта) ----
export type ZoneId = 1 | 2 | 3 | 4;

export interface ZoneModuleDef {
  readonly id: MeshModuleId;
  readonly weight: number;
  readonly scale: readonly [number, number];
  readonly hScale: readonly [number, number];
}

export const ZONE_MODULES: Readonly<Record<ZoneId, readonly ZoneModuleDef[]>> = {
  1: [
    { id: 'hab_box', weight: 0.50, scale: [0.8, 1.2], hScale: [0.8, 1.3] },
    { id: 'container', weight: 0.35, scale: [0.6, 1.0], hScale: [0.5, 1.0] },
    { id: 'comm_mast', weight: 0.15, scale: [0.9, 1.1], hScale: [1.2, 2.0] },
  ],
  2: [
    { id: 'factory', weight: 0.40, scale: [1.2, 1.8], hScale: [1.0, 1.5] },
    { id: 'silo_tank', weight: 0.30, scale: [0.9, 1.3], hScale: [1.0, 1.8] },
    { id: 'pipe_stack', weight: 0.20, scale: [1.0, 1.5], hScale: [1.5, 2.5] },
    { id: 'cargo_bay', weight: 0.10, scale: [1.0, 1.4], hScale: [0.8, 1.2] },
  ],
  3: [
    { id: 'guard_tower', weight: 0.50, scale: [0.9, 1.2], hScale: [1.4, 2.2] },
    { id: 'barrier', weight: 0.35, scale: [1.0, 1.5], hScale: [0.6, 1.0] },
    { id: 'radar_dish', weight: 0.15, scale: [1.0, 1.3], hScale: [1.2, 1.8] },
  ],
  4: [
    { id: 'hq_center', weight: 0.60, scale: [1.5, 2.2], hScale: [1.2, 1.8] },
    { id: 'dome_vault', weight: 0.40, scale: [1.2, 1.7], hScale: [1.0, 1.5] },
  ],
};

function isZoneId(value: number): value is ZoneId {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

// Предвычисляем CDF для weighted random
const ZONE_CDF: Record<ZoneId, number[]> = { 1: [], 2: [], 3: [], 4: [] };
for (const zone of [1, 2, 3, 4] as ZoneId[]) {
  let cumul = 0;
  for (const m of ZONE_MODULES[zone]) {
    cumul += m.weight;
    ZONE_CDF[zone].push(cumul);
  }
}

export function pickModule(zone: ZoneId, rand01: number): ZoneModuleDef {
  const cdf = ZONE_CDF[zone];
  const modules = ZONE_MODULES[zone];
  for (let i = 0; i < cdf.length; i++) {
    if (rand01 < (cdf[i] as number)) return modules[i] as ZoneModuleDef;
  }
  return modules[modules.length - 1] as ZoneModuleDef;
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

export function packTint(r: number, g: number, b: number, a: number): number {
  const u32 = ((r & 0xFF) | ((g & 0xFF) << 8) | ((b & 0xFF) << 16) | ((a & 0xFF) << 24)) >>> 0;
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = u32;
  return new Float32Array(buf)[0] as number;
}

// ---- ПАЛИТРЫ ОТТЕНКОВ ----
export type Rgb = readonly [number, number, number];
export const TINT_PALETTES: Readonly<Record<ZoneId, readonly Rgb[]>> = {
  1: [[180, 180, 190], [160, 155, 140], [140, 150, 160]],   // серо-стальной, песочный
  2: [[200, 120, 50], [180, 160, 100], [150, 150, 150]],   // индустриальный оранж
  3: [[100, 110, 100], [120, 120, 80], [90, 100, 90]],     // камуфляж / тёмный
  4: [[200, 200, 210], [170, 190, 220], [220, 220, 230]],  // светлый штаб
};

// ---- Scatter Engine ----
export function scatterInstances(
  zoneMap: Uint8Array,
  heightfield: Float32Array,
  radiusM: number,
  seed: number,
  placeId: number,
  spawnMask?: Uint8Array | null,
): ScatterInstance[] {
  const instances: ScatterInstance[] = [];              // будет max 4096
  const hfRes = HEIGHTFIELD_RES;
  const zRes = ZONE_RES;
  const cellWorldSize = (2 * radiusM) / hfRes;         // метры на ячейку heightfield
  const baseSeed = seed ^ (placeId * 91939);

  // Jittered Grid: шаг зависит от зоны, но для простоты — фиксированный шаг
  // и фильтрация по density
  const GRID_STEP = 4;                                  // в ячейках heightfield (≈ 4 * cellWorldSize метров)

  // Пройдём по grid
  for (let gy = 0; gy < hfRes; gy += GRID_STEP) {
    for (let gx = 0; gx < hfRes; gx += GRID_STEP) {
      if (instances.length >= MAX_INSTANCES) break;

      // Jitter
      const [jx, jy] = hashFloat2(gx, gy, baseSeed);
      const px = gx + jx * GRID_STEP * 0.8;
      const py = gy + jy * GRID_STEP * 0.8;

      const pxi = Math.floor(px), pyi = Math.floor(py);
      if (pxi < 0 || pxi >= hfRes || pyi < 0 || pyi >= hfRes) continue;

      // И-3.4: buildingSpawnMask — спавн 3D-структур запрещён над водой,
      // озёрами, руслами рек и крутыми склонами (см. local-map-contract.ts).
      if (spawnMask && spawnMask[pyi * hfRes + pxi] === 0) continue;

      // Сэмплируем зону (64×64 → перемасштабируем координаты)
      const zx = Math.floor((px / hfRes) * zRes);
      const zy = Math.floor((py / hfRes) * zRes);
      const zIdx = (zy * zRes + zx) * 2;
      const zoneValue = zoneMap[zIdx] as number;
      const density = zoneMap[zIdx + 1] as number;

      if (!isZoneId(zoneValue)) continue;               // пустошь и мусор — пропуск
      const zone = zoneValue;

      // Проверка плотности
      const spawnRoll = hashFloat(gx + 1, gy + 1, baseSeed + 3);
      if (spawnRoll > density / 255) continue;

      // Inset: проверяем соседние ячейки зоны на смену зоны
      let onBorder = false;
      for (const [dx2, dy2] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nzx = zx + dx2, nzy = zy + dy2;
        if (nzx < 0 || nzy < 0 || nzx >= zRes || nzy >= zRes) { onBorder = true; break; }
        if (zoneMap[(nzy * zRes + nzx) * 2] !== zone) { onBorder = true; break; }
      }
      if (onBorder) continue;

      // Выбираем модуль
      const moduleRoll = hashFloat(gx + 2, gy + 2, baseSeed + 7);
      const mod = pickModule(zone, moduleRoll);

      // Мировые координаты (origin = центр карты)
      const worldX = (px - hfRes / 2) * cellWorldSize;
      const worldY = (py - hfRes / 2) * cellWorldSize;
      const worldZ = heightfield[pyi * hfRes + pxi] as number;

      // Yaw
      const yaw = hashFloat(gx + 3, gy + 3, baseSeed + 11) * Math.PI * 2;

      // Scale (масштабируется к физическому окну обзора, чтобы постройки
      // были читаемы и на 1,2 км тактического участка, и на региональном обзоре)
      const sRoll = hashFloat(gx + 4, gy + 4, baseSeed + 13);
      const hRoll = hashFloat(gx + 5, gy + 5, baseSeed + 17);
      const worldScale = Math.max(1.8, radiusM / 320);
      const sx = lerp(mod.scale[0], mod.scale[1], sRoll) * worldScale;
      const sy = sx;  // квадратный footprint (или отдельный roll для sy)
      const sz = lerp(mod.hScale[0], mod.hScale[1], hRoll) * worldScale;

      // Tint
      const palette = TINT_PALETTES[zone];
      const tIdx = Math.floor(hashFloat(gx + 6, gy + 6, baseSeed + 19) * palette.length);
      const [tr, tg, tb] = palette[Math.min(tIdx, palette.length - 1)] as Rgb;
      const tintPacked = packTint(tr, tg, tb, 255);

      instances.push({
        moduleId: mod.id,
        data: [worldX, worldY, worldZ, yaw, sx, sy, sz, tintPacked],
      });
    }
    if (instances.length >= MAX_INSTANCES) break;
  }

  return instances;
}

// ---- Группировка инстансов по модулю ----
export function packInstancesByModule(instances: readonly ScatterInstance[]): InstanceBuffers {
  interface MutableGroup {
    buffer: Float32Array;
    count: number;
    offset: number;
  }
  const groups: Partial<Record<MeshModuleId, MutableGroup>> = {};
  const counts: Partial<Record<MeshModuleId, number>> = {};

  // Подсчёт
  for (const inst of instances) {
    counts[inst.moduleId] = (counts[inst.moduleId] ?? 0) + 1;
  }

  // Аллокация
  for (const id of Object.keys(counts) as MeshModuleId[]) {
    const count = counts[id] as number;
    groups[id] = { buffer: new Float32Array(count * 8), count, offset: 0 };
  }

  // Заполнение
  for (const inst of instances) {
    const g = groups[inst.moduleId] as MutableGroup;
    g.buffer.set(inst.data, g.offset * 8);
    g.offset++;
  }

  // Результат: { moduleId: { buffer: Float32Array, count: N } }
  const result: InstanceBuffers = {};
  for (const id of Object.keys(groups) as MeshModuleId[]) {
    const g = groups[id] as MutableGroup;
    result[id] = { buffer: g.buffer, count: g.count };
  }
  return result;
}

// ---------------------------------------------------------------------------
// И-3.1/И-3.3: касательный кадр патча — координаты 7 канонических ячеек в метрах
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stage-8.5: гладкая интерполяция Patch7 внутри generateLocalMap — без прямых
// жёстких граней Вороного между каноническими ячейками
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LRU-кэш локальных участков (до 8 записей, Патч 8)
// ---------------------------------------------------------------------------

interface LocalMapCacheEntry {
  readonly response: LocalMapWorkerResponse;
  readonly fingerprint: string;
}

const LOCAL_MAP_CACHE = new Map<string, LocalMapCacheEntry>();

/** Ключ участка: `${patchKey || centerCell}:${radiusM}:${seed}:${placeId}`. */
export function localMapCacheKey(request: LocalMapWorkerRequest): string {
  const center = request.patchKey || String(request.patch.centerCell);
  return `${center}:${request.radiusM}:${request.seed}:${request.placeId}`;
}

/** Отпечаток входных данных, влияющих на рельеф помимо ключа участка. */
function localMapFingerprint(request: LocalMapWorkerRequest): string {
  const seedHex = request.profile ? String(request.profile['masterSeedHex'] ?? '') : 'none';
  const rule = request.spawnRule
    ? `${request.spawnRule.minLand}/${request.spawnRule.maxSlope}`
    : 'default';
  // Stage-8.7: neighborRings входит в отпечаток — ringCells=0 и ringCells=5
  // не должны berkongsiовать запись кэша.
  const rings = String(clampScalar(Math.floor(request.neighborRings ?? RING_LEVELS), 0, RING_LEVELS));
  return `${seedHex}|${rule}|${rings}`;
}

function cloneInstanceBuffers(instanceBuffers: InstanceBuffers): InstanceBuffers {
  const copy: Record<string, InstancePack> = {};
  for (const [id, pack] of Object.entries(instanceBuffers)) {
    if (!pack) continue;
    copy[id] = { buffer: new Float32Array(pack.buffer), count: pack.count };
  }
  return copy as InstanceBuffers;
}

/** Глубокая копия ответа: кэш и Transferable-буферы вызывающего не пересекаются. */
export function cloneLocalMapResponse(response: LocalMapWorkerResponse): LocalMapWorkerResponse {
  return {
    heightfield: new Float32Array(response.heightfield),
    zoneMap: new Uint8Array(response.zoneMap),
    terraformMap: new Uint8Array(response.terraformMap),
    instanceBuffers: cloneInstanceBuffers(response.instanceBuffers),
    meta: { ...response.meta },
    ...(response.ringCells ? {
      ringCells: response.ringCells.map((cell) => ({
        ...cell,
        center: [cell.center[0], cell.center[1], cell.center[2]] as readonly [number, number, number],
        offsetM: [cell.offsetM[0], cell.offsetM[1]] as readonly [number, number],
        heightfield: new Float32Array(cell.heightfield),
        waterMask: new Uint8Array(cell.waterMask),
      })),
    } : {}),
  };
}

function readCache(key: string, fingerprint: string | null): LocalMapWorkerResponse | undefined {
  const entry = LOCAL_MAP_CACHE.get(key);
  if (!entry) return undefined;
  if (fingerprint !== null && entry.fingerprint !== fingerprint) {
    LOCAL_MAP_CACHE.delete(key);
    return undefined;
  }
  // Освежаем порядок LRU: последняя запись — самая свежая.
  LOCAL_MAP_CACHE.delete(key);
  LOCAL_MAP_CACHE.set(key, entry);
  return cloneLocalMapResponse(entry.response);
}

function writeCache(key: string, request: LocalMapWorkerRequest, response: LocalMapWorkerResponse): void {
  LOCAL_MAP_CACHE.delete(key);
  LOCAL_MAP_CACHE.set(key, {
    response: cloneLocalMapResponse(response),
    fingerprint: localMapFingerprint(request),
  });
  while (LOCAL_MAP_CACHE.size > LOCAL_MAP_CACHE_LIMIT) {
    const oldest = LOCAL_MAP_CACHE.keys().next();
    if (oldest.done) break;
    LOCAL_MAP_CACHE.delete(oldest.value);
  }
}

/** Кэшированный участок или `undefined`; буферы всегда клонируются. */
export function getCachedLocalMap(key: string): LocalMapWorkerResponse | undefined {
  return readCache(key, null);
}

/** Полная очистка LRU-кэша участков (смена планеты/профиля). */
export function clearLocalMapCache(): void {
  LOCAL_MAP_CACHE.clear();
}

/** Текущее число записей кэша (диагностика). */
export function localMapCacheSize(): number {
  return LOCAL_MAP_CACHE.size;
}

// ---- Main Entry Point ----
/**
 * Генерация остаётся асинхронной по контракту worker. W23 намеренно меняет
 * значения heightfield и юбки на общее высотное поле; старые золотые хэши
 * Stage-8.10b больше не описывают результат и не переписываются здесь.
 */
export async function generateLocalMap(request: LocalMapWorkerRequest): Promise<LocalMapWorkerResponse> {
  const { patch, seed, placeId, radiusM } = request;
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const hfRes = HEIGHTFIELD_RES;

  // И-3: вход воркера — только валидный канонический срез 7 ячеек глобуса.
  const report = verifyPatchInvariants(patch);
  if (!report.ok) {
    throw new Error('LocalMapWorker: патч 7 ячеек нарушил инварианты И-3: ' + JSON.stringify(report.checks));
  }

  const cacheKey = localMapCacheKey(request);
  const cached = readCache(cacheKey, localMapFingerprint(request));
  if (cached) return cached;

  // 0. И-3.4: маска спавна нужна и для смешивания терраформинга, и для scatter.
  const spawnMask = buildBuildingSpawnMask(patch, hfRes, request.spawnRule);

  // 1. Высота по общему физическому направлению, затем врез русла.
  //    Ни водный Patch7, ни spawnMask, ни терраформинг не смешиваются с высотой.
  const cellSeed = (seed ^ Math.imul((patch.centerCell + 1) >>> 0, 0x9E3779B1)) >>> 0;
  // Общий seed всего мира, НЕ идентификатор ячейки: одинаковое направление
  // планеты даёт одинаковую деталь во всех перекрывающихся участках.
  const planetSeed = (seed ^ Math.imul((placeId + 1) >>> 0, 0x85EBCA6B)) >>> 0;
  const base = buildBaseHeightfield(patch, radiusM, planetSeed, spawnMask, !!request.profile);
  // У старого «устья без streamWeight» есть релаксация с НЕОГРАНИЧЕННОЙ
  // повторной постановкой вершин в очередь (rivers.ts). На общем метрическом
  // поле с крутыми склонами она способна расти без конца. При вызове только
  // для этого устья переключаем режим вреза на обычный (сегмент outlet,
  // маски и глубина сохраняются), не трогая river-контракт/оригинал Patch7.
  const mouthCell = patch.river.outlet && patch.cells[patch.river.outlet.slot + 1];
  const isMouth = !patch.river.flowsThroughCenter && patch.river.inlets.length === 0
    && !!mouthCell && isWaterCell(mouthCell, patch.seaLevel);
  const carvePatch: LocalMapPatch = isMouth
    ? { ...patch, river: { ...patch.river, flowsThroughCenter: true } }
    : patch;
  const heightfield = applyRiverCarve(carvePatch, radiusM, base, spawnMask);
  const terraformMap = base.terraformMap;
  const waterPoints = base.waterPoints;
  let buildablePoints = 0;
  for (let i = 0; i < hfRes * hfRes; i++) if (spawnMask[i] === 1) buildablePoints++;

  // Терраформинг по гауссиане ЦЕНТРА ПАТЧА больше не смешивается с высотой:
  // на одной физической точке у двух патчей альфа была разной (шов). Карта
  // terraformMap остаётся для маркеров воды и зонирования/материала.

  // 4. Zone map: вода/озёра/русла остаются без зонирования (И-3.2/И-3.4).
  //    radiusM передаётся, чтобы зонирование учитывало и локальный размах
  //    детального участка, а не только полный patchSpanMeters.
  const zoneMap = applyWaterZoning(generateZoneMap(cellSeed, placeId), patch, radiusM);

  // 5. Scatter (И-3.4: маска запрета спавна отбраковывает воду/озёра/русла/склоны)
  const instances = scatterInstances(zoneMap, heightfield, radiusM, cellSeed, placeId, spawnMask);
  const instanceBuffers = packInstancesByModule(instances);

  // Финальные границы высот после вреза рек.
  let finalMin = Infinity;
  let finalMax = -Infinity;
  for (let i = 0; i < heightfield.length; i++) {
    const h = heightfield[i] as number;
    if (h < finalMin) finalMin = h;
    if (h > finalMax) finalMax = h;
  }

  // Stage-8.7: кольца соседних областей вокруг активного гекса. Кольца
  // требуют профиль — без профиля ringCells отсутствуют.
  const neighborRings = clampScalar(Math.floor(request.neighborRings ?? RING_LEVELS), 0, RING_LEVELS);
  let ringCells: LocalMapRingCell[] | undefined;
  let ringCellCount = 0;
  let ringGenMs = 0;
  if (neighborRings > 0 && request.profile) {
    const ringStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    ringCells = buildNeighborRingCells(
      patch, neighborRings, radiusM, planetSeed, true,
    );
    ringCellCount = ringCells.length;
    ringGenMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - ringStartedAt;
  }

  const totalPoints = hfRes * hfRes;
  const genMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
  const response: LocalMapWorkerResponse = {
    heightfield,
    zoneMap,
    terraformMap,
    instanceBuffers,
    meta: {
      radiusM,
      hfRes: HEIGHTFIELD_RES,
      zoneRes: ZONE_RES,
      tfRes: TERRAFORM_RES,
      totalInstances: instances.length,
      buildableFraction: totalPoints > 0 ? buildablePoints / totalPoints : 0,
      waterFraction: totalPoints > 0 ? waterPoints / totalPoints : 0,
      minHeightM: finalMin === Infinity ? 0 : finalMin,
      maxHeightM: finalMax === -Infinity ? 0 : finalMax,
      genMs,
      patchKey: request.patchKey || String(patch.centerCell),
      ...(ringCellCount > 0 ? { ringCellCount, ringGenMs } : {}),
    },
    ...(ringCells ? { ringCells } : {}),
  };

  writeCache(cacheKey, request, response);
  return response;
}

// ---------------------------------------------------------------------------
// Stage-8.2: непрерывная сферическая юбка горизонта вокруг выделенного
// центрального гекса активной ячейки. Единая полярная сетка 145 × 85 без
// 6 отдельных плит-лепестков и без провалов фасок: высоты воротника сшиваются
// с детальным мешем центрального гекса строго по гексагональной метрике
// `clusterHexMetric(x, y)` (бесшовный шестиугольный срез), а весь горизонт
// получает честный радиус кривизны планеты.
//
// W23: юбка сэмплирует то же мировое поле, что и центральный heightfield;
// только маска воды и зеркало озера определяются гидрологией Patch7.
// ---------------------------------------------------------------------------

/** Угловых сегментов контура горизонта: 6 секторов × 24 шагов (145 узлов с замыканием). */
export const SKIRT_ANGULAR_SEGMENTS = 144;
/** Радиальных шагов единой полярной сетки горизонта: 36 плотных + 48 до сферы (85 рядов). */
export const SKIRT_RADIAL_RINGS = 84;
/**
 * Радиальных шагов плотного воротника: 36 из 84. Новое поле W23 может
 * дать остаток интерполяции на срезе > 1 м — он отражён в стенде.
 */
export const SKIRT_COLLAR_RINGS = 36;
/** Юбка начинается ВНУТРИ новой апофемы (0,575 R), иначе вдоль граней зияет щель. */
export const SKIRT_INNER_RADIUS_RATIO = CENTER_HEX_APOTHEM_RATIO * 0.9;
/** Доля R_patch: внешний радиус плотного воротника вокруг выделенного гекса. */
export const SKIRT_COLLAR_END_RADIUS_RATIO = 1.15;
/** Число шагов d_hex от центра юбки до сферического горизонта (R_outer = 10.0 · d_hex). */
export const SKIRT_OUTER_SPACING_RATIO = 10.0;
/** Отношение радиуса планеты к внешнему радиусу юбки (плавная кривизна горизонта). */
export const SKIRT_PLANET_RADIUS_SPACING_RATIO = 3.6;
/** Доля апофемы центрального гекса: начало полосы смешивания высот воротника. */
export const SKIRT_COLLAR_BLEND_START_RATIO = 1.005;
/** Доля апофемы центрального гекса: конец полосы смешивания (срез + 0.345 · A). */
export const SKIRT_COLLAR_BLEND_END_RATIO = 1.35;
/** Доля R_patch: страховочная граница точной выборки heightfield (сетка res × res). */
export const SKIRT_HEIGHTFIELD_GUARD_RATIO = 0.98;
/**
 * Stage-8.5.1: «разумный кап» размаха положительных высот макро-решётки, м.
 * Исторический экспорт амплитуды по решётке для автономных диагностик
 * Stage-8.5.1; в W23 физическая высота юбки от него не зависит.
 */
export const SKIRT_LATTICE_RELIEF_CAP_M = 240;
/** Число ячеек канонической сетки Голдберга v = 128: 10v² + 2. */
const GOLDBERG_V128_CELLS = 10 * 128 * 128 + 2;

/**
 * Геометрия непрерывной сферической юбки горизонта вокруг выделенного
 * центрального гекса активной ячейки (единая полярная сетка 145 × 85).
 */
export interface HorizonSkirtData {
  /** (x, y, z) в метрах; сферическое проседание добавляет вершинный шейдер. */
  readonly positions: Float32Array;
  /** Гладкие нормали по конечным разностям полярной сетки (nx, ny, nz), nz > 0. */
  readonly normals: Float32Array;
  /** 255 — океан/озеро; 0 — суша. Семантика едина с центральным патчем. */
  readonly waterMask: Uint8Array;
  /** 255 — водный стрежень русла; 0 — не русло. */
  readonly riverMask: Uint8Array;
  readonly indices: Uint32Array;
  /** R_inner = 0,9 · апофема = 0,5175 · R_patch — юбка перекрывает грани. */
  readonly innerRadiusM: number;
  /** R_outer = 10.0 · d_hex = 11.5 · R_patch — сферический горизонт юбки. */
  readonly outerRadiusM: number;
  /** R_planet = 3.6 · R_outer — честный радиус кривизны горизонта, м. */
  readonly planetRadiusM: number;
  /** Шаг центров гексов канонической сетки d_hex = 1.15 · R_patch, м. */
  readonly hexSpacingM: number;
  /** Число соседних гексов Patch7 (всегда 6). */
  readonly ringCount: number;
}

/** Шаг центров соседних гексов сетки Голдберга v=128: d_hex ≈ 0.009418 · R_p. */
export function hexSpacingMeters(planetRadiusM: number): number {
  return Math.sqrt(
    (8 * Math.PI * planetRadiusM * planetRadiusM) / (Math.sqrt(3) * GOLDBERG_V128_CELLS),
  );
}

// mapNeighborCellsToSlots и planetCurvatureDropM перенесены в
// local-map-geometry.ts (Stage-8.10b, A-12b) — см. реэкспорт выше.

/** Билинейная выборка детального heightfield участка (сетка res×res на радиус radiusM). */
function sampleInnerHeightfield(
  heightfield: Float32Array,
  res: number,
  radiusM: number,
  x: number,
  y: number,
): number {
  const cellSize = (2 * radiusM) / res;
  const gx = clampScalar(x / cellSize + res / 2, 0, res - 1.0001);
  const gy = clampScalar(y / cellSize + res / 2, 0, res - 1.0001);
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const ax = gx - ix;
  const ay = gy - iy;
  const i00 = iy * res + ix;
  const i10 = i00 + 1;
  const i01 = i00 + res;
  const i11 = i01 + 1;
  const top = (heightfield[i00] as number) * (1 - ax) + (heightfield[i10] as number) * ax;
  const bottom = (heightfield[i01] as number) * (1 - ax) + (heightfield[i11] as number) * ax;
  return top * (1 - ay) + bottom * ay;
}

/** Каналы elevation и detail единого 3D-сэмплера в узлах макро-решётки. */
interface SkirtElevationLattice {
  readonly elevation: Float32Array;
  readonly detail: Float32Array;
}

/** Только водная СЕМАНТИКА Patch7 для цвета и масок, не высота грунта. */
function skirtSemanticWater(
  patch: LocalMapPatch,
  neighborSlots: readonly PatchCell[],
  radiusPatchM: number,
  x: number,
  y: number,
  r: number,
): number {
  const center = patch.cells[0] as PatchCell;
  const collarEndM = SKIRT_COLLAR_END_RADIUS_RATIO * radiusPatchM;
  const centerApothemM = CENTER_HEX_RADIUS_RATIO * HEX_APOTHEM_RATIO * radiusPatchM;
  const phi = (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI);
  const slot = phi / (Math.PI / 3);
  const k0 = Math.floor(slot) % SKIRT_RING_COUNT;
  const c0 = neighborSlots[k0] as PatchCell;
  const c1 = neighborSlots[(k0 + 1) % SKIRT_RING_COUNT] as PatchCell;
  const angularBlend = smooth01(slot - Math.floor(slot));
  const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
  const isOcean = (cell: PatchCell): boolean => cell.elevation < patch.seaLevel && cell.lakeWeight === 0;
  const centerIsOcean = isOcean(center);
  // Для океана водная маска проходит воротник целиком до выхода на берег;
  // континентальное озеро держит зеркало на большей дальности.
  const oceanBlendStartM = collarEndM + 0.12 * radiusPatchM;
  const neighborBlend = centerIsOcean
    ? smooth01((r - oceanBlendStartM) / (0.8 * radiusPatchM))
    : smooth01((r - centerApothemM) / Math.max(1, collarEndM - centerApothemM));
  const centerIsLake = center.lakeWeight > 0 && waterLevelOf(center, patch.seaLevel) > patch.seaLevel;
  const waterBlend = centerIsLake
    ? smooth01((r - 1.8 * radiusPatchM) / (2.4 * radiusPatchM))
    : neighborBlend;
  const waterOf = (cell: PatchCell): number => Number(isOcean(cell) || cell.lakeWeight > 0);
  return mix(waterOf(center), mix(waterOf(c0), waterOf(c1), angularBlend), waterBlend);
}

/** Мягкое продолжение русла в соседних ячейках юбки горизонта. */
function skirtRiverCarveFactor(
  patch: LocalMapPatch,
  neighborSlots: readonly PatchCell[],
  x: number,
  y: number,
  r: number,
  radiusPatchM: number,
  riverHalfWidthM: number,
): number {
  const centerApothemM = CENTER_HEX_RADIUS_RATIO * HEX_APOTHEM_RATIO * radiusPatchM;
  if (r <= centerApothemM || !(riverHalfWidthM > 0)) return 0;
  let carve = 0;
  for (let k = 0; k < neighborSlots.length; k++) {
    const cell = neighborSlots[k] as PatchCell;
    // Только каноническая связь через общую грань. streamWeight > 0 у любого
    // соседа не означает, что его русло пересекает именно эту грань.
    const linkedByRiver = patch.river.inlets.some((edge) => edge.neighborCell === cell.cell)
      || patch.river.outlet?.neighborCell === cell.cell;
    if (!linkedByRiver) continue;
    const angle = (k * Math.PI) / 3;
    const along = x * Math.cos(angle) + y * Math.sin(angle);
    if (along < centerApothemM) continue;
    const cross = -x * Math.sin(angle) + y * Math.cos(angle);
    const distance = Math.abs(cross);
    if (distance >= riverHalfWidthM) continue;
    const t = 1 - distance / riverHalfWidthM;
    // Ноль точно на грани подхватывает вырез innerHeightfield; к концу полосы
    // смешивания каноническое продолжение уже имеет полную глубину. Отказ от
    // slot-зависимого меандра гарантирует тот же створ после перецентровки.
    const radial = smooth01((r - centerApothemM) / (0.30 * radiusPatchM));
    carve = Math.max(carve, radial * t * t * (3 - 2 * t));
  }
  return carve;
}

/**
 * Диагностика прежней амплитуды горных гребней юбки, м — перепад высот Patch7
 * (канонические высоты центра и 6 угловых слотов `mapNeighborCellsToSlots`)
 * плюс размах канала `detail` макро-решётки. Равнинный патч даёт малую
 * амплитуду (открытая равнина вокруг гекса), контрастный горный — большую;
 * искусственной зависимости от `radiusPatchM` больше нет.
 *
 * Stage-8.5.1: на морском патче перепад Patch7 равен нулю (все 7 ячеек —
 * океан), и юбка за воротником оставалась плоским зеркалом, хотя во 2–4
 * кольце из океана уже выходит настоящий берег. Поэтому амплитуда учитывает
 * ещё и размах положительных высот калиброванного канала `elevation`
 * макро-решётки над `patch.seaLevel` (в метрах, с капом
 * `SKIRT_LATTICE_RELIEF_CAP_M`): у вышедшей из моря суши появляются
 * естественные прибрежные холмы и гряды.
 *
 * Экспортируется для тестов Stage-8.5.1 (проверка вклада макро-решётки в
 * амплитуду гребней на морском патче).
 */
export function skirtLocalReliefAmplitudeM(
  patch: LocalMapPatch,
  neighborSlots: readonly PatchCell[],
  centerCanonElev: number,
  elevLattice: SkirtElevationLattice | null,
  elevCalibration = 0,
): number {
  const canon = (cell: PatchCell): number => isWaterCell(cell, patch.seaLevel)
    ? waterLevelOf(cell, patch.seaLevel) : baseElevationOf(cell);
  let minElev = centerCanonElev;
  let maxElev = centerCanonElev;
  for (const cell of neighborSlots) {
    const elev = canon(cell);
    if (elev < minElev) minElev = elev;
    if (elev > maxElev) maxElev = elev;
  }
  const patchReliefM = (maxElev - minElev) * METERS_PER_ELEVATION_UNIT;
  if (!elevLattice) return patchReliefM;
  let minDetail = Infinity;
  let maxDetail = -Infinity;
  for (let i = 0; i < elevLattice.detail.length; i++) {
    const value = elevLattice.detail[i] as number;
    if (value < minDetail) minDetail = value;
    if (value > maxDetail) maxDetail = value;
  }
  const detailReliefM = Number.isFinite(minDetail) && Number.isFinite(maxDetail)
    ? (maxDetail - minDetail) * PROFILE_DETAIL_AMPLITUDE_M
    : 0;
  // Размах положительных высот исторической макро-решётки для диагностики.
  let maxLatticeAboveSeaM = 0;
  for (let i = 0; i < elevLattice.elevation.length; i++) {
    const aboveSeaM = ((elevLattice.elevation[i] as number) + elevCalibration - patch.seaLevel)
      * METERS_PER_ELEVATION_UNIT;
    if (aboveSeaM > maxLatticeAboveSeaM) maxLatticeAboveSeaM = aboveSeaM;
  }
  const latticeReliefM = Math.min(SKIRT_LATTICE_RELIEF_CAP_M, maxLatticeAboveSeaM);
  return Math.max(patchReliefM, latticeReliefM) + detailReliefM;
}

/**
 * Генерация непрерывной сферической юбки горизонта вокруг выделенного
 * центрального гекса активной ячейки (Stage-8.2, вместо кластера из 7 плит):
 *
 * - Единая полярная сетка `(SKIRT_ANGULAR_SEGMENTS + 1) × (SKIRT_RADIAL_RINGS + 1)`
 *   = 145 × 85 = 12 325 вершин и 96 × 56 × 6 = 32 256 индексов: горизонт
 *   непрерывен по всем направлениям, без 6 отдельных плит-лепестков и без
 *   физических провалов фасок `bevelDropM`.
 * - Первые `SKIRT_COLLAR_RINGS = 36` радиальных шагов — плотный воротник от
 *   `R_inner = 0.9 · A` до `1.15 · R_patch`; остальные 48 шагов — от
 *   `1.15 · R_patch` до `R_outer = 10.0 · d_hex = 11.5 · R_patch` по степени
 *   `Math.pow(t, 1.35)` (сгущение линий у выделенного гекса).
 * - Гексагональная сшивка высот воротника: шейдер обрезает центральный меш
 *   257 × 257 строго по контуру `clusterHexMetric(x, y) <= A`, где
 *   `A = centerApothemM = CENTER_HEX_RADIUS_RATIO · HEX_APOTHEM_RATIO · R_patch`.
 *   При `hexDist <= 1.005 · A` высота равна ТОЧНОЙ билинейной выборке
 *   `innerHeightfield` (`blend = 0`) — на всём шестиугольном срезе нет ни
 *   ступеньки, ни щели. На полосе `1.005 · A < hexDist <= 1.35 · A` высота
 *   плавно смешивается через `smooth01` с тем же мировым полем.
 * - Кривизна — `R_planet = 3.6 · R_outer` (проседание касательной плоскости
 *   применяет вершинный шейдер); нормали — гладкие конечные разности полярной
 *   сетки с угловым замыканием `i % SKIRT_ANGULAR_SEGMENTS` и ориентацией `nz > 0`.
 */
export async function generateHorizonSkirt(
  request: LocalMapWorkerRequest,
  innerHeightfield?: Float32Array,
): Promise<HorizonSkirtData> {
  const patch = request.patch;
  const neighborSlots = mapNeighborCellsToSlots(patch);
  const radiusPatchM = request.radiusM;
  // Апофема выделенного центрального гекса: ровно тот контур, по которому шейдер
  // обрезает центральный меш 257 × 257 (hexApothem = 0,575 · R_patch).
  const centerApothemM = CENTER_HEX_RADIUS_RATIO * HEX_APOTHEM_RATIO * radiusPatchM;
  const innerRadiusM = SKIRT_INNER_RADIUS_RATIO * radiusPatchM;
  const hexSpacingM = SKIRT_HEX_SPACING_RATIO * radiusPatchM;
  const outerRadiusM = SKIRT_OUTER_SPACING_RATIO * hexSpacingM;
  // Stage-8.5: кривизна горизонта берётся от НАСТОЯЩЕГО физического радиуса
  // планеты (`patch.frame.radiusM = surface.radiusKm · 1000`, для Земли
  // 6 371 000 м), а не только от визуального радиуса участка. Формула
  // 3.6 · R_outer сохранена как нижняя граница: начиная с шага масштаба
  // ~308 км R_outer превышает радиус планеты и сферическое проседание в
  // касательной плоскости вырождается (r > R_planet). Ниже этого порога
  // горизонт гнётся по реальной планете — на 10 км Δz = 0.26 км вместо 8 км,
  // на 100 км — 26 км вместо 82 км, — то есть кривизна плавная и физичная.
  const planetRadiusM = Math.max(
    patch.frame.radiusM || 0,
    SKIRT_PLANET_RADIUS_SPACING_RATIO * outerRadiusM,
  );

  // Параметры общего планетарного поля зависят от планеты/placeId, а не от
  // активной ячейки. Никакая макро-решётка с калибровкой по её центру не нужна.
  const planetSeed = (request.seed
    ^ Math.imul((request.placeId + 1) >>> 0, 0x85EBCA6B)) >>> 0;

  const innerRes = HEIGHTFIELD_RES;
  const hasCollar = !!innerHeightfield && innerHeightfield.length >= innerRes * innerRes;
  const collarHeights = hasCollar ? (innerHeightfield as Float32Array) : null;

  const angularCount = SKIRT_ANGULAR_SEGMENTS + 1;   // 145 узлов с угловым замыканием
  const radialCount = SKIRT_RADIAL_RINGS + 1;        // 85 радиальных рядов
  const vertexCount = angularCount * radialCount;    // 12 325 вершин
  const positions = new Float32Array(vertexCount * 3);
  const waterMask = new Uint8Array(vertexCount);
  const riverMask = new Uint8Array(vertexCount);
  const riverHalfWidthM = Math.max((4 * radiusPatchM) / HEIGHTFIELD_RES,
    radiusPatchM * RIVER_HALF_WIDTH_RATIO);
  const centerRiverSegments = riverSegments(patch, radiusPatchM, riverHalfWidthM);

  // Радиусы рядов: 36 плотных шагов воротника от R_inner до 1.15 · R_patch,
  // затем 48 шагов к горизонту по степени t^1.35.
  const collarEndM = SKIRT_COLLAR_END_RADIUS_RATIO * radiusPatchM;
  const outerSteps = SKIRT_RADIAL_RINGS - SKIRT_COLLAR_RINGS;
  const ringRadius = new Float64Array(radialCount);
  for (let j = 0; j <= SKIRT_COLLAR_RINGS; j++) {
    ringRadius[j] = innerRadiusM + (collarEndM - innerRadiusM) * (j / SKIRT_COLLAR_RINGS);
  }
  for (let j = SKIRT_COLLAR_RINGS + 1; j < radialCount; j++) {
    const t = (j - SKIRT_COLLAR_RINGS) / outerSteps;
    ringRadius[j] = collarEndM + (outerRadiusM - collarEndM) * Math.pow(t, 1.35);
  }

  const blendStartM = SKIRT_COLLAR_BLEND_START_RATIO * centerApothemM;
  const blendEndM = SKIRT_COLLAR_BLEND_END_RATIO * centerApothemM;
  const blendSpanM = blendEndM - blendStartM;
  const guardM = SKIRT_HEIGHTFIELD_GUARD_RATIO * radiusPatchM;
  const fieldStepM = (2 * radiusPatchM) / HEIGHTFIELD_RES;
  // В воротнике и на всех кольцах юбка получает ТО ЖЕ непрерывное поле,
  // что центральная сетка и LOD, даже при автономном вызове без профиля.
  const fieldHeightAt = (x: number, y: number, r: number): number => {
    const dir = localPointToDirection(patch, x, y);
    const cell = nearestPatchCell(patch, dir);
    if (cell.lakeWeight > 0) {
      return (waterLevelOf(cell, patch.seaLevel) - patch.seaLevel) * METERS_PER_ELEVATION_UNIT;
    }
    let h = sampleLocalTerrainHeightM(
      dir, fieldStepM, patch.frame.radiusM, planetSeed, !!request.profile,
    );
    if (!isWaterCell(cell, patch.seaLevel)) {
      const riverDepthM = Math.max(10, radiusPatchM * RIVER_DEPTH_RATIO * 1.8);
      const channel = skirtRiverCarveFactor(
        patch, neighborSlots, x, y, r, radiusPatchM, riverHalfWidthM,
      );
      const valley = skirtRiverCarveFactor(
        patch, neighborSlots, x, y, r, radiusPatchM, riverHalfWidthM * 2.4,
      );
      h -= riverDepthM * (0.45 * valley + 0.55 * channel);
    }
    return h;
  };

  for (let j = 0; j < radialCount; j++) {
    const r = ringRadius[j] as number;
    for (let i = 0; i < angularCount; i++) {
      const phi = (i / SKIRT_ANGULAR_SEGMENTS) * Math.PI * 2;
      const x = r * Math.cos(phi);
      const y = r * Math.sin(phi);
      // Гексагональная метрика кластера: внутри выделенного гекса hexDist <= A.
      const hexDist = clusterHexMetric(x, y);

      let z: number;
      if (collarHeights && hexDist <= blendEndM) {
        // Точная билинейная выборка детального heightfield участка: тот же
        // рельеф, что у обрезанного по гексу центрального меша 257 × 257.
        const innerZ = sampleInnerHeightfield(collarHeights, innerRes, radiusPatchM,
          clampScalar(x, -guardM, guardM), clampScalar(y, -guardM, guardM));
        if (hexDist <= blendStartM) {
          // Шестиугольный срез: высота совпадает 1-в-1 (blend = 0, без ступеньки).
          z = innerZ;
        } else {
          const blend = smooth01((hexDist - blendStartM) / blendSpanM);
          const planetaryZ = fieldHeightAt(x, y, r);
          z = innerZ + (planetaryZ - innerZ) * blend;
        }
      } else {
        z = fieldHeightAt(x, y, r);
      }

      const vertex = j * angularCount + i;
      const idx = vertex * 3;
      positions[idx] = x;
      positions[idx + 1] = y;
      positions[idx + 2] = z;

      // A-17b: цветовой вход воды/русла больше не выводится косвенно из
      // высоты и нормали. Та же аналитическая Patch7-семантика действует по
      // обе стороны грани, не завися от грубой макро-решётки 33×33.
      const semanticWater = skirtSemanticWater(patch, neighborSlots, radiusPatchM, x, y, r);
      if (semanticWater >= 0.5) waterMask[vertex] = 255;
      const centerRiver = riverCarveFactor(x, y, centerRiverSegments, riverHalfWidthM);
      const skirtRiver = skirtRiverCarveFactor(
        patch, neighborSlots, x, y, r, radiusPatchM, riverHalfWidthM,
      );
      if (semanticWater < 0.5 && Math.max(centerRiver, skirtRiver) >= 0.45) riverMask[vertex] = 255;
    }
  }

  // Индексы непрерывной полярной сетки: (144 × 84) quad'ов = 72 576 индексов.
  // Порядок обхода — CCW из +z (грань вверх), как у плоского меша рельефа.
  const indices = new Uint32Array(SKIRT_ANGULAR_SEGMENTS * SKIRT_RADIAL_RINGS * 6);
  let ptr = 0;
  for (let j = 0; j < SKIRT_RADIAL_RINGS; j++) {
    for (let i = 0; i < SKIRT_ANGULAR_SEGMENTS; i++) {
      const a = j * angularCount + i;
      const b = a + 1;
      const c = (j + 1) * angularCount + i;
      const d = c + 1;
      indices[ptr++] = a; indices[ptr++] = c; indices[ptr++] = b;
      indices[ptr++] = b; indices[ptr++] = c; indices[ptr++] = d;
    }
  }

  // Гладкие нормали по конечным разностям полярной сетки: тангенс вдоль кольца
  // (с угловым замыканием i % SKIRT_ANGULAR_SEGMENTS) и тангенс вдоль радиуса;
  // n = t_angular × t_radial, ориентация — в верхнюю полусферу (nz > 0).
  const normals = new Float32Array(vertexCount * 3);
  const vertexAt = (i: number, j: number): number => (j * angularCount + i) * 3;
  for (let j = 0; j < radialCount; j++) {
    const jPrev = j > 0 ? j - 1 : j;
    const jNext = j < radialCount - 1 ? j + 1 : j;
    for (let i = 0; i < angularCount; i++) {
      const iPrev = (i - 1 + SKIRT_ANGULAR_SEGMENTS) % SKIRT_ANGULAR_SEGMENTS;
      const iNext = (i + 1) % SKIRT_ANGULAR_SEGMENTS;
      const aPrev = vertexAt(iPrev, j);
      const aNext = vertexAt(iNext, j);
      const rPrev = vertexAt(i, jPrev);
      const rNext = vertexAt(i, jNext);
      const tax = (positions[aNext] as number) - (positions[aPrev] as number);
      const tay = (positions[aNext + 1] as number) - (positions[aPrev + 1] as number);
      const taz = (positions[aNext + 2] as number) - (positions[aPrev + 2] as number);
      const trx = (positions[rNext] as number) - (positions[rPrev] as number);
      const tryy = (positions[rNext + 1] as number) - (positions[rPrev + 1] as number);
      const trz = (positions[rNext + 2] as number) - (positions[rPrev + 2] as number);

      let nx = tay * trz - taz * tryy;
      let ny = taz * trx - tax * trz;
      let nz = tax * tryy - tay * trx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-9) {
        nx /= len;
        ny /= len;
        nz /= len;
      } else {
        nx = 0; ny = 0; nz = 1;
      }
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }

      const idx = vertexAt(i, j);
      normals[idx] = nx;
      normals[idx + 1] = ny;
      normals[idx + 2] = nz;
    }
  }

  return {
    positions,
    normals,
    waterMask,
    riverMask,
    indices,
    innerRadiusM,
    outerRadiusM,
    planetRadiusM,
    hexSpacingM,
    ringCount: SKIRT_RING_COUNT,
  };
}

export function localMapTransferables(response: LocalMapWorkerResponse): Transferable[] {
  const transferables: Transferable[] = [
    response.heightfield.buffer as ArrayBuffer,
    response.zoneMap.buffer as ArrayBuffer,
    response.terraformMap.buffer as ArrayBuffer,
  ];
  for (const pack of Object.values(response.instanceBuffers)) {
    if (pack) transferables.push(pack.buffer.buffer as ArrayBuffer);
  }
  // Stage-8.7: буферы колец передаются zero-copy alongside с основными буферами.
  for (const cell of response.ringCells ?? []) {
    transferables.push(cell.heightfield.buffer as ArrayBuffer);
    transferables.push(cell.waterMask.buffer as ArrayBuffer);
  }
  return transferables;
}

// Регистрация обработчика — только при подключении файла как dedicated worker.
interface WorkerScopeLike {
  onmessage: ((event: MessageEvent<LocalMapWorkerRequest>) => void) | null;
  postMessage(message: LocalMapWorkerResponse, transfer?: Transferable[]): void;
  importScripts?: unknown;
}
const workerScope = globalThis as unknown as Partial<WorkerScopeLike> & { importScripts?: unknown };
if (typeof workerScope.postMessage === 'function' && typeof workerScope.importScripts === 'function') {
  workerScope.onmessage = (event: MessageEvent<LocalMapWorkerRequest>): void => {
    // Stage-8.10b (A-12b): генерация асинхронна — сэмплер поднимает ядро
    // через динамический импорт. Ошибка генерации логируется в воркере,
    // главный поток узнаёт о ней через тайм-аут/перезагрузку worker.
    void generateLocalMap(event.data).then(
      (response) => {
        (workerScope.postMessage as WorkerScopeLike['postMessage'])(response, localMapTransferables(response));
      },
      (error: unknown) => {
        console.error('LocalMapWorker: генерация локальной карты завершилась ошибкой:', error);
      },
    );
  };
}
