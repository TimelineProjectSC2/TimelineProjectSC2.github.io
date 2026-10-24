/* LocalMap heightfield — рельеф локальной карты (Stage-8.14, W23b).
   Длинноволновое sampleElevation выбирается в узлах 65² и интерполируется;
   коротковолновая деталь fBm/detail считается в каждой вершине по общему
   направлению планеты. Patch7 задаёт только воду/озёра/реки, а не якорь
   морского дна. Врез русла — local-map-rivers.ts, оркестрация — worker.ts. */

import {
  isWaterCell,
  localPointToDirection,
  nearestPatchCell,
  samplePatchFields,
  waterLevelOf,
} from './local-map-contract.ts';
import type { LocalMapPatch, PatchCell, Vec3 } from './local-map-contract.ts';
import type { FieldSampler } from '../../site/shared/planet-geography.ts';
import { CENTER_HEX_APOTHEM_RATIO, SKIRT_RING_COUNT } from './local-map-geometry.ts';
import { sampleElevation } from '../../site/shared/planet-elevation-field.ts';

// ---- Константы рельефа и терраформинга ----
// ---- Константы контракта ----
export const HEIGHTFIELD_RES = 256;

export const TERRAFORM_RES = 256;

/** Вертикальная шкала канонических высот (медиана суши Земли ≈ 600 м). */
export const METERS_PER_ELEVATION_UNIT = 8570;

/** Амплитуда локального fBm-рельефа суши и морского дна, м. */
export const LAND_FBM_AMPLITUDE_M = 240;

/** Амплитуда дополнительной детали суши и морского дна, м. */
export const PROFILE_DETAIL_AMPLITUDE_M = 120;

/** 64 интервала/65 узлов для медленного длинноволнового поля планеты. */
export const ELEVATION_LATTICE_STEPS = 64;
/** Исторический размер диагностической решётки detail, не источник короткой детали. */
export const DETAIL_LATTICE_STEPS = 64;

/**
 * Исторические коэффициенты полосы 0.62…1.02 Stage-8.5 сохранены для
 * совместимости диагностик; W23 НЕ умножает на них высоту sampleElevation.
 * Новый воротник юбки смешивается отдельно в полосе 1.005…1.35 апофемы.
 */
export const LOCAL_HEX_CORE_RADIUS_RATIO = 0.85;
export const LOCAL_PATCH_RAMP_START_RATIO = 0.62;
export const LOCAL_PATCH_RAMP_END_RATIO = 1.02;
export const LOCAL_PATCH_FALL_START_RATIO = 1.0;
export const LOCAL_PATCH_FALL_END_RATIO = 1.85;

/**
 * Stage-8.5: явный водный маркер `terraform_map`. Байт `0` означает
 * «вода/озеро канонической ячейки Patch7», а любая точка суши несёт минимум
 * `TERRAFORM_LAND_MIN = 2` — даже там, где терраформинга нет вовсе. Байт `1`
 * означает водный стрежень реки над/около seaLevel, поэтому потребитель карты
 * (шейдер рельефа) отличает сушу, реку и зеркало без эвристики по высоте,
 * а не по совпадению «нулевой альфы» с нулевой высотой.
 */
export const TERRAFORM_LAND_MIN = 2;

/** Stage-8.5: знаменатель альфы терраформинга — `255 − TERRAFORM_LAND_MIN`. */
export const TERRAFORM_ALPHA_SPAN = 253;

// ---- Stage-8.7: кольца соседних областей вокруг активного гекса ----
/** Уровень кольца вокруг канонического центра Patch7 (1 — ближайшие 6 соседей). */
export type RingLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Stage-8.7: ячейка кольца вокруг активного гекса. Воркер 2 читает
 * `heightfield`/`waterMask` как готовые буферы и не пересчитывает высоты.
 * `offsetM` — смещение центра ячейки в метрах в касательной плоскости участка
 * (x, y), совместимое с координатами основного heightfield.
 */
export interface LocalMapRingCell {
  /**
   * Детерминированный синтетический индекс отрисовки (порядок обхода колец).
   * НЕ канонический `cell` сетки Голдберга: кольца 2..5 строятся как плоская
   * гексагональная решётка в касательной плоскости вокруг Patch7. Для перехода
   * между гексами используйте `activePatchReady.patch.cells[1..6]` (канон).
   */
  readonly cell: number;
  readonly ring: RingLevel;
  /** 3D-центр ячейки на единичной сфере. */
  readonly center: readonly [number, number, number];
  /**
   * Видимое смещение центра в сжатой касательной плоскости, м. Канонический
   * `center` остаётся физическим направлением семплирования на сфере.
   */
  readonly offsetM: readonly [number, number];
  /** Разрешение heightfield ячейки (RING_HF_RES[ring]). */
  readonly hfRes: number;
  /** Физический span сэмплов, м; равен span GPU-геометрии = 2·R_patch. */
  readonly spanM: number;
  /** Heightfield ячейки кольца, м относительно seaLevel. */
  readonly heightfield: Float32Array;
  /** 1 — точка ниже уровня воды ячейки (море), 0 — суша. */
  readonly waterMask: Uint8Array;
  readonly minHeightM: number;
  readonly maxHeightM: number;
}

/** Максимальный уровень кольца (1..5). */
export const RING_LEVELS = 5;

/**
 * Разрешение heightfield по кольцам: [центр, 1..5]. Кольцо 1 — 64×64,
 * кольцо 5 — 4×4; разрешение падает с ростом кольца (экспоненциальный LOD
 * §15.1 матрицы оркестрации). Значения обязаны совпадать с зеркальным
 * контрактом рендерера `RING_HF_RES` в `src/local-map/local-map-renderer.ts`,
 * иначе ячейки отбрасываются как выходящие за предел слота.
 */
export const RING_HF_RES: readonly number[] = Object.freeze([256, 64, 32, 16, 8, 4]);

/** Максимум ячеек колец 1..5: центр + 6 + 12 + 18 + 24 + 30 = 91. */
export const MAX_RING_CELLS = 91;

/** √3/2 — отношение апофемы правильного шестиугольника к радиусу описанной окружности. */
export const HEX_APOTHEM_RATIO = 0.8660254037844386;

/** Доля R_patch: шаг центров соседних гексов канонической сетки кластера Patch7. */
export const SKIRT_HEX_SPACING_RATIO = 1.15;

/** Радиус описанной окружности: апофема 1,15·R/2, радиус = апофема/(√3/2). */
export const CENTER_HEX_RADIUS_RATIO = CENTER_HEX_APOTHEM_RATIO / HEX_APOTHEM_RATIO;

// ---- Детерминированный хэш (pcg-подобный) ----
function pcgHash(state: number): number {
  // PCG-XSH-RR: один раунд
  state = state >>> 0;
  state = (Math.imul(state, 747796405) + 2891336453) >>> 0;
  const word = (((state >>> ((state >>> 28) + 4)) ^ state) * 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

function hash2(ix: number, iy: number, seed: number): number {
  // 2D → uint32: один раунд PCG по XOR-смешанным входам. Два раунда
  // (как в первой версии) давали тот же детерминизм, но вдвое дороже —
  // гейт G4 (worker-генерация <= 150 мс) оставляет запас на слабых машинах.
  const mixed = (Math.imul(ix | 0, 0x9E3779B1) ^ Math.imul(iy | 0, 0x85EBCA77) ^ Math.imul(seed | 0, 0xC2B2AE3D)) >>> 0;
  return pcgHash(mixed);
}

export function hashFloat(ix: number, iy: number, seed: number): number {
  // 2D → [0, 1)
  return (hash2(ix, iy, seed) >>> 0) / 4294967296;
}

export function hashFloat2(ix: number, iy: number, seed: number): [number, number] {
  // Два независимых [0,1)
  const h1 = hashFloat(ix, iy, seed);
  const h2 = hashFloat(ix, iy, seed ^ 0x9E3779B9);
  return [h1, h2];
}

// ---- fBm (value noise с хешем, 6 октав) ----
// Для краткости — простой value noise. В продакшене заменить на Simplex.
export function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  // smoothstep
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hashFloat(ix, iy, seed);
  const b = hashFloat(ix + 1, iy, seed);
  const c = hashFloat(ix, iy + 1, seed);
  const d = hashFloat(ix + 1, iy + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fBm(x: number, y: number, seed: number, octaves = 6, lacunarity = 2.0, gain = 0.5): number {
  let amp = 1, freq = 1, sum = 0, maxAmp = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2D(x * freq, y * freq, seed + i * 7919) * amp;
    maxAmp += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / maxAmp;   // нормализовано в [0, 1]
}

/**
 * Stage-8.3: гребневой мультифрактал (ridged fBm) горных хребтов юбки
 * горизонта. Каждая октава складывается «гармошкой» вокруг середины шума
 * (`ridge = 1 - |2n - 1|`), возводится в квадрат для острых гребней и
 * взвешивается результатом предыдущей октавы: детали живут на гребнях,
 * а межгорные долины остаются гладкими. Нормировано в [0, 1].
 */
export function ridgedFbm(x: number, y: number, seed: number, octaves = 5): number {
  let amp = 1, freq = 1, sum = 0, maxAmp = 0, weight = 1;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise2D(x * freq, y * freq, seed + i * 7919);
    const ridge = 1 - Math.abs(2 * n - 1);
    let sharp = ridge * ridge;
    sharp *= weight;
    weight = Math.min(1, Math.max(0, sharp * 1.6));
    sum += sharp * amp;
    maxAmp += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return maxAmp > 0 ? sum / maxAmp : 0;   // нормализовано в [0, 1]
}

export function generateTerraformMap(): Uint8Array {
  // Stage-8.3: мягкий гауссов спад от центра. Радиус «разутюживания» уменьшен
  // (sigma = 0.18 · рез.), а максимальная альфа ограничена 0.42 вместо 1.0 —
  // долина внутри гекса сохраняет живой природный микрорельеф холмов и ложбин,
  // а не превращается в плоский бетонный стол под застройкой.
  // Stage-8.5: гауссов профиль сохраняется, но минимальная подложка суши
  // поднята до TERRAFORM_LAND_MIN — байт суши никогда не равен 0 или 1, иначе
  // на пологой равнине в масштабах 10…1250 км шейдер принимал сухую землю за
  // водное зеркало (нулевая альфа терраформинга выглядела как маркер воды).
  const map = new Uint8Array(TERRAFORM_RES * TERRAFORM_RES);
  const cx = TERRAFORM_RES / 2, cy = TERRAFORM_RES / 2;
  const sigma = TERRAFORM_RES * 0.18;

  for (let y = 0; y < TERRAFORM_RES; y++) {
    for (let x = 0; x < TERRAFORM_RES; x++) {
      const dx = x - cx, dy = y - cy;
      const r2 = dx * dx + dy * dy;
      const alpha = Math.min(0.42, Math.exp(-r2 / (2 * sigma * sigma)));
      map[y * TERRAFORM_RES + x] = Math.max(TERRAFORM_LAND_MIN, Math.floor(alpha * 255));
    }
  }
  return map;
}

/**
 * Единая гексагональная метрика кластера: точное расстояние от центра
 * шестиугольника с плоским верхом/боком до его 6 прямых граней по нормали.
 * Точка лежит внутри шестиугольника с апофемой `apothem` тогда и только
 * тогда, когда `hexMetric2D(x, y) <= apothem`; линии уровня — идеальные
 * правильные шестиугольники (вершины на лучах k·π/3, нормали граней на
 * лучах π/6 + k·π/3).
 */
export function hexMetric2D(x: number, y: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  return Math.max(ax * 0.8660254037844386 + ay * 0.5, ay);
}

/**
 * Метрика кластера Patch7: тот же гекс, повёрнутый так, что нормали его граней
 * смотрят ровно на θ_k = k·π/3 — направления центров 6 соседей. Поворот на 30°
 * для шестиугольника (симметрия 6-го порядка) эквивалентен перестановке осей,
 * поэтому контуры колец считаются через `hexMetric2D(y, x)`.
 *
 * Именно этой метрикой шейдер обрезает центральный меш 257 × 257 по контуру
 * активного гекса, поэтому воротник юбки сшивается с ним по `clusterHexMetric`,
 * а не по евклидову радиусу: `hexDist <= centerApothemM` — внутри гекса.
 */
export function clusterHexMetric(x: number, y: number): number {
  return hexMetric2D(y, x);
}

interface Tangent2D { readonly u: number; readonly v: number; }

/** Обратная exp-карта: центр канонической ячейки → (u, v) касательной плоскости, м. */
export function cellTangentMeters(patch: LocalMapPatch, cell: PatchCell): Tangent2D {
  const { origin, east, north, radiusM } = patch.frame;
  const dot = (a: readonly number[], b: readonly number[]): number =>
    (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number) + (a[2] as number) * (b[2] as number);
  const cosTheta = Math.min(1, Math.max(-1, dot(cell.center, origin)));
  const theta = Math.acos(cosTheta);
  const sinTheta = Math.sin(theta);
  // chord = theta * R, u = chord * dot(dir, east) / sin(theta) — точный обратный exp-мап.
  const scale = sinTheta > 1e-9 ? (theta * radiusM) / sinTheta : radiusM;
  return { u: dot(cell.center, east) * scale, v: dot(cell.center, north) * scale };
}

// ---- Stage-8.7: обход колец вокруг активного гекса (гекс-решётка) ----
/**
 *hex-расстояние по осям (q, r): half-grid metric (|q| + |r| + |q + r|) / 2.
 * Кольцо L — ячейки ровно на расстоянии L от центра (6L ячеек).
 */
function hexDistance(q: number, r: number): number {
  return (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
}

/**
 * Stage-8.7: канонические осевые координаты (q, r) кольца L — все ячейки на
 * hex-расстоянии L от центра. Кольцо 1 — 6 соседей, кольцо 2 — 12, кольцо 5 —
 * 30 (в сумме 90 ячеек + центр = MAX_RING_CELLS). Порядок детерминированный.
 */
function hexRingAxial(ring: number): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  const bound = 2 * ring;
  for (let q = -bound; q <= bound; q++) {
    for (let r = -bound; r <= bound; r++) {
      if (hexDistance(q, r) === ring) result.push([q, r]);
    }
  }
  return result;
}

/**
 * Кольца используют то же поле и аналитическую локальную деталь. Длинную
 * волну берём из разрежённой решётки с тем же шагом Nyquist span/res: один
 * sampleElevation на каждый узел, а не на каждый пиксель 64² соседей.
 * Физическая ширина span = 2·R_patch совпадает с сеткой рендерера.
 */
function buildRingCellHeightfield(
  patch: LocalMapPatch,
  offsetX: number,
  offsetY: number,
  res: number,
  span: number,
  planetSeed: number,
  withDetail: boolean,
): { heightfield: Float32Array; waterMask: Uint8Array } {
  const heightfield = new Float32Array(res * res);
  const waterMask = new Uint8Array(res * res);
  const stepM = span / res;
  // На дальних кольцах ресемплинг 4² уже не нужен; ближнее кольцо 64²
  // обходится 17² обращениями к полю на ячейку (6 соседей).
  const steps = Math.min(res, Math.max(4, Math.floor(res / 4)));
  const lattice = sampleElevationLattice(patch, span / 2, stepM, offsetX, offsetY, steps);
  const gridRatio = steps / res;
  for (let y = 0; y < res; y++) {
    const wy = offsetY + (y - res / 2) * stepM;
    for (let x = 0; x < res; x++) {
      const wx = offsetX + (x - res / 2) * stepM;
      const dir = localPointToDirection(patch, wx, wy);
      const h = elevationFromLattice(lattice, steps, x * gridRatio, y * gridRatio)
        + sampleLocalTerrainDetailM(dir, patch.frame.radiusM, planetSeed, withDetail);
      const idx = y * res + x;
      heightfield[idx] = h;
      waterMask[idx] = h < 0 ? 1 : 0;
    }
  }
  return { heightfield, waterMask };
}

/**
 * Stage-8.7: обход колец 1..neighborRings от канонического центра Patch7.
 * Кольцо 1 — реальные 6 соседей Patch7 (точные центры и смещения). Кольца 2..5 —
 * плоская гексагональная решётка в касательной плоскости: 6 соседей сортируются
 * по азимуту, два смежных (N0, N1) служат базисом, ячейка кольца L в осевых
 * координатах (q, r) лежит в q·N0 + r·N1. Порядок внутри кольца — по азимуту.
 */
export function buildNeighborRingCells(
  patch: LocalMapPatch,
  neighborRings: number,
  radiusPatchM: number,
  planetSeed: number,
  withDetail: boolean,
): LocalMapRingCell[] {
  const normAngle = (a: number): number => (a + 2 * Math.PI) % (2 * Math.PI);
  const sorted: Array<{ cell: PatchCell; off: Tangent2D; angle: number }> = [];
  for (let k = 0; k < SKIRT_RING_COUNT; k++) {
    const cell = patch.cells[k + 1] as PatchCell;
    const off = cellTangentMeters(patch, cell);
    sorted.push({ cell, off, angle: Math.atan2(off.v, off.u) });
  }
  sorted.sort((a, b) => normAngle(a.angle) - normAngle(b.angle));
  const n0 = sorted[0] as { off: Tangent2D };
  const n1 = sorted[1] as { off: Tangent2D };
  const dHex = Math.hypot(n0.off.u, n0.off.v);   // физическое расстояние до соседа кольца 1
  // A-17: heightfield колец по-прежнему семплируется в физических координатах
  // планеты, но GPU-позиции используют тот же сжатый шаг, что юбка горизонта.
  // Раньше offsetM оставался физическим (~60 км), тогда как юбка ставила тот
  // же соседний центр на 2.875 км: две поверхности описывали разные места.
  const visualHexSpacingM = SKIRT_HEX_SPACING_RATIO * radiusPatchM;
  const visualScale = visualHexSpacingM / Math.max(1, dHex);
  const ringCells: LocalMapRingCell[] = [];
  let cellIndex = 0;
  for (let ring = 1; ring <= neighborRings; ring++) {
    const hfRes = RING_HF_RES[ring] as number;
    const entries: Array<{ x: number; y: number; center?: Vec3 }> = [];
    if (ring === 1) {
      for (const item of sorted) {
        entries.push({ x: item.off.u, y: item.off.v, center: item.cell.center });
      }
    } else {
      for (const [q, r] of hexRingAxial(ring)) {
        entries.push({ x: q * n0.off.u + r * n1.off.u, y: q * n0.off.v + r * n1.off.v });
      }
      entries.sort((a, b) => {
        const angA = normAngle(Math.atan2(a.y, a.x));
        const angB = normAngle(Math.atan2(b.y, b.x));
        if (angA !== angB) return angA - angB;
        return Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y);
      });
    }
    for (const entry of entries) {
      const center = entry.center ?? localPointToDirection(patch, entry.x, entry.y);
      const spanM = 2 * radiusPatchM;
      const built = buildRingCellHeightfield(
        patch, entry.x, entry.y, hfRes, spanM, planetSeed, withDetail,
      );
      let minH = Infinity;
      let maxH = -Infinity;
      for (let i = 0; i < built.heightfield.length; i++) {
        const h = built.heightfield[i] as number;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
      const entryScale = ring === 1
        ? visualHexSpacingM / Math.max(1, Math.hypot(entry.x, entry.y))
        : visualScale;
      ringCells.push({
        cell: cellIndex++,
        ring: ring as RingLevel,
        center,
        offsetM: [entry.x * entryScale, entry.y * entryScale],
        hfRes,
        spanM,
        heightfield: built.heightfield,
        waterMask: built.waterMask,
        minHeightM: minH === Infinity ? 0 : minH,
        maxHeightM: maxH === -Infinity ? 0 : maxH,
      });
    }
  }
  return ringCells;
}

/**
 * Старая диагностическая решётка 65² (в т. ч. для tools/analysis/ocean_side).
 * W23 не использует её для генерации: каждая вершина выбирает sampleElevation
 * по собственному направлению и шагу 2·R/hfRes. Старый выигрыш G4 утрачен.
 */
export interface LocalFieldLattice {
  readonly elevation: Float32Array;
  readonly detail: Float32Array;
}

export function sampleDetailLattice(
  patch: LocalMapPatch, sampler: FieldSampler, radiusM: number,
): LocalFieldLattice {
  const nodes = DETAIL_LATTICE_STEPS + 1;
  const elevation = new Float32Array(nodes * nodes);
  const detailLattice = new Float32Array(nodes * nodes);
  const scratch = new Float32Array(8);
  for (let j = 0; j < nodes; j++) {
    const v = ((j / DETAIL_LATTICE_STEPS) - 0.5) * 2 * radiusM;
    for (let i = 0; i < nodes; i++) {
      const u = ((i / DETAIL_LATTICE_STEPS) - 0.5) * 2 * radiusM;
      const fields = samplePatchFields(patch, sampler, u, v, scratch);
      const index = j * nodes + i;
      const detail = fields[5] as number;
      elevation[index] = fields[0] as number;
      detailLattice[index] = detail < -1 ? -1 : detail > 1 ? 1 : detail;
    }
  }
  return { elevation, detail: detailLattice };
}

export function sampleDetailAt(lattice: Float32Array, tx: number, ty: number): number {
  const nodes = DETAIL_LATTICE_STEPS + 1;
  const fx = Math.min(DETAIL_LATTICE_STEPS - 1e-9, Math.max(0, tx * DETAIL_LATTICE_STEPS));
  const fy = Math.min(DETAIL_LATTICE_STEPS - 1e-9, Math.max(0, ty * DETAIL_LATTICE_STEPS));
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const ax = fx - ix, ay = fy - iy;
  const i0 = iy * nodes + ix;
  const i1 = i0 + 1;
  const i2 = i0 + nodes;
  const i3 = i2 + 1;
  const top = (lattice[i0] as number) * (1 - ax) + (lattice[i1] as number) * ax;
  const bottom = (lattice[i2] as number) * (1 - ax) + (lattice[i3] as number) * ax;
  return top * (1 - ay) + bottom * ay;
}

export function smooth01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

export function clampScalar(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Результат базового прохода рельефа: всё, что нужно проходу вреза русла. */
export interface BaseHeightfield {
  /**
   * h_natural ДО вреза русла, м, в двойной точности. Врез (и A-27 долина)
   * применяется к этой величине до округления во Float32 — как и раньше.
   */
  readonly heightM: Float64Array;
  /** 1 — точка суши канонической ячейки (не вода, не озеро и не океан), 0 — вода. */
  readonly landMask: Uint8Array;
  /**
   * terraform_map: байт 0 уже стоит на воде/океане/озере; на суше значения ещё
   * не подняты до TERRAFORM_LAND_MIN — это делает проход вреза русла.
   */
  readonly terraformMap: Uint8Array;
  /** Число точек воды (для meta.waterFraction). */
  readonly waterPoints: number;
}

/**
 * Исторический диагностический сэмплер зерна A-31: не участвует в вычислении
 * W23 heightfield/юбки, но оставлен для совместимости экспорта и теста
 * полосного ограничения амплитуды в tests/local-map-texture-812d.test.mjs.
 */
export function sampleLandGrainT(
  ux: number,
  uy: number,
  seed: number,
  detailSigned: number | null,
): number {
  // Амплитуда ×3 не должна утроить скачок между соседями: старая ветвь
  // запасного горизонта уменьшает частоту зерна, сохраняя его диапазон.
  const fbmT = fBm(ux * 0.40, uy * 0.40, seed, 4, 2.0, 0.45);
  if (detailSigned === null) return fbmT;
  const detail01 = detailSigned * 0.5 + 0.5;
  const ridgeT = ridgedFbm(ux * 0.22, uy * 0.22, seed ^ 0x2F5A11, 3);
  return clampScalar(0.52 * fbmT + 0.30 * detail01 + 0.18 * ridgeT, 0, 1);
}

/**
 * Сэмпл одной физической точки планеты: никаких поправок относительно центра
 * активного гекса или канонического якоря Patch7. Две проекции той же `dir`
 * с тем же шагом и общим seed различаются только округлением координат
 * exp-карты (контроль W23: < 10⁻⁹ м). `stepM` —
 * фактический шаг исходной сетки (а НЕ шаг решётки для интерполяции).
 *
 * Два канала малой детали заданы в *мировых* координатах единичной сферы,
 * умноженных на радиус планеты, а не в локальной касательной плоскости/seed
 * ячейки. Поэтому и суша, и океан имеют одинаковый механизм микрорельефа.
 */
/**
 * Узловое поле на квадрате [offsetX ± radiusM, offsetY ± radiusM].
 * Шаг Nyquist — шаг ИСХОДНОГО heightfield, а не редкой решётки: иначе на
 * разных LOD изменится состав октав и появится шов даже у одного `dir`.
 * В продукте steps=64 даёт ровно 65² выборок sampleElevation на участок.
 */
export function sampleElevationLattice(
  patch: LocalMapPatch,
  radiusM: number,
  sourceStepM: number,
  offsetX = 0,
  offsetY = 0,
  steps = ELEVATION_LATTICE_STEPS,
): Float64Array {
  const nodes = steps + 1;
  const grid = new Float64Array(nodes * nodes);
  const intervalM = (2 * radiusM) / steps;
  for (let y = 0; y <= steps; y++) {
    const wy = offsetY - radiusM + y * intervalM;
    for (let x = 0; x <= steps; x++) {
      const dir = localPointToDirection(patch, offsetX - radiusM + x * intervalM, wy);
      grid[y * nodes + x] = sampleElevation(dir, sourceStepM);
    }
  }
  return grid;
}

/** Билинейная выборка внутреннего интервала узлов (0 ≤ gx, gy < steps). */
export function elevationFromLattice(lattice: Float64Array, steps: number, gx: number, gy: number): number {
  const x = Math.floor(gx), y = Math.floor(gy);
  const tx = gx - x, ty = gy - y;
  const i = y * (steps + 1) + x;
  const top = (lattice[i] as number) * (1 - tx) + (lattice[i + 1] as number) * tx;
  const bottom = (lattice[i + steps + 1] as number) * (1 - tx)
    + (lattice[i + steps + 2] as number) * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Малая деталь — только по мировому `dir`, на КАЖДОЙ вершине без интерполяции. */
export function sampleLocalTerrainDetailM(
  dir: Vec3,
  planetRadiusM: number,
  seed: number,
  withDetail: boolean,
): number {
  // Две линейно независимые оси в 3D дают непрерывный общий адрес шума по
  // всей сфере (нет меридианного шва долгот/полюсного скачка). Период первой
  // октавы фиксирован в МЕТРАХ, не в долях R_patch или в шагах LOD.
  const scale = planetRadiusM / 5200;
  const ux = scale * (dir[0] * 0.80 - dir[1] * 0.60);
  const uy = scale * (dir[1] * 0.60 + dir[2] * 0.80);
  const macro = fBm(ux, uy, seed, 3);
  const detail = withDetail
    ? valueNoise2D(ux * 1.8 + 13.7, uy * 1.8 - 7.9, seed ^ 0x2F5A11)
    : 0.5;
  return (macro * 2 - 1) * LAND_FBM_AMPLITUDE_M
    + (detail * 2 - 1) * (withDetail ? PROFILE_DETAIL_AMPLITUDE_M : 0);
}

/** Прямая поформенная выборка без решётки — эталон точности для диагностики. */
export function sampleLocalTerrainHeightM(
  dir: Vec3,
  stepM: number,
  planetRadiusM: number,
  seed: number,
  withDetail: boolean,
): number {
  return sampleElevation(dir, stepM) + sampleLocalTerrainDetailM(dir, planetRadiusM, seed, withDetail);
}

/**
 * Поле вершин без вреза рек. На 65² узлах sampleElevation выбирается
 * по направлению exp-карты (полоса 2·R/hfRes), в каждую вершину приходит
 * билинейная планетная высота + свежая локальная деталь по её `dir`.
 * Patch7 меняет лишь маски и зеркало озера, не высоту моря/суши.
 */
export function buildBaseHeightfield(
  patch: LocalMapPatch,
  radiusM: number,
  planetSeed: number,
  spawnMask: Uint8Array,
  withDetail: boolean,
): BaseHeightfield {
  const hfRes = HEIGHTFIELD_RES;
  const stepM = (2 * radiusM) / hfRes;
  const heightM = new Float64Array(hfRes * hfRes);
  const landMask = new Uint8Array(hfRes * hfRes);
  const terraformMap = generateTerraformMap();
  const fieldLattice = sampleElevationLattice(patch, radiusM, stepM);
  const gridRatio = ELEVATION_LATTICE_STEPS / hfRes;
  let waterPoints = 0;

  for (let y = 0; y < hfRes; y++) {
    for (let x = 0; x < hfRes; x++) {
      const idx = y * hfRes + x;
      const wx = (x - hfRes / 2) * stepM;
      const wy = (y - hfRes / 2) * stepM;
      const dir = localPointToDirection(patch, wx, wy);
      const cell = nearestPatchCell(patch, dir);
      const isWater = isWaterCell(cell, patch.seaLevel);
      if (isWater || cell.streamWeight > 0) spawnMask[idx] = 0;

      if (isWater) {
        waterPoints++;
        terraformMap[idx] = 0;
      } else {
        landMask[idx] = 1;
      }
      // Озёрное зеркало — отдельный гидрологический контракт; во всех
      // прочих точках планетное поле и короткая деталь независимы от Patch7.
      if (cell.lakeWeight > 0) {
        heightM[idx] = (waterLevelOf(cell, patch.seaLevel) - patch.seaLevel) * METERS_PER_ELEVATION_UNIT;
      } else {
        heightM[idx] = elevationFromLattice(fieldLattice, ELEVATION_LATTICE_STEPS,
          x * gridRatio, y * gridRatio)
          + sampleLocalTerrainDetailM(dir, patch.frame.radiusM, planetSeed, withDetail);
      }
    }
  }
  return { heightM, landMask, terraformMap, waterPoints };
}
