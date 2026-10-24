/* LocalMapGeometry — чистые геометрические хелперы локальной карты (W23).
   Главный поток импортирует каркас сцены без Wasm-ядра: только типы
   wire-протокола, никаких значимых импортов. Точная обратная exp-проекция
   позволяет сравнить одно физическое направление в двух кадрах; апофема
   задана тем же геометрическим шагом, что и шесть соседних центров. */

import type { LocalMapPatch, PatchCell, Vec3 } from './local-map-contract.ts';

/** Апофема правильного гекса в долях R_patch: половина шага центров 1,15 R. */
export const CENTER_HEX_APOTHEM_RATIO = 1.15 / 2;

/** Число угловых слотов кольца юбки: 6 направлений θ_k = k·π/3. */
export const SKIRT_RING_COUNT = 6;

/**
 * Сопоставление 6 гексов кластера (slot 0..5, направление θ_k = k·π/3) реальным
 * соседним ячейкам из `patch.cells.slice(1)` по ближайшему направлению в
 * касательном кадре: (u, v) = (dot(cell.center, east), dot(cell.center, north)).
 * Жадное сопоставление по глобальному минимуму углового расстояния даёт
 * взаимно-однозначное соответствие без дубликатов (6 слотов ↔ 6 ячеек).
 */
export function mapNeighborCellsToSlots(patch: LocalMapPatch): readonly PatchCell[] {
  const neighbors = patch.cells.slice(1);
  const { east, north } = patch.frame;
  const tangentAngle: number[] = [];
  for (const cell of neighbors) {
    const u =
      (cell.center[0] as number) * (east[0] as number)
      + (cell.center[1] as number) * (east[1] as number)
      + (cell.center[2] as number) * (east[2] as number);
    const v =
      (cell.center[0] as number) * (north[0] as number)
      + (cell.center[1] as number) * (north[1] as number)
      + (cell.center[2] as number) * (north[2] as number);
    tangentAngle.push(Math.atan2(v, u));
  }
  const pairs: Array<{ slot: number; cell: number; dist: number }> = [];
  for (let k = 0; k < SKIRT_RING_COUNT; k++) {
    const slotAngle = (k * Math.PI) / 3;
    for (let c = 0; c < neighbors.length; c++) {
      // Модуль с приведением к [0, 2π): разница углов может превысить 2π.
      let dist = Math.abs((tangentAngle[c] as number) - slotAngle) % (2 * Math.PI);
      if (dist > Math.PI) dist = 2 * Math.PI - dist;
      pairs.push({ slot: k, cell: c, dist });
    }
  }
  pairs.sort((a, b) => a.dist - b.dist);
  const slotTaken = new Array<boolean>(SKIRT_RING_COUNT).fill(false);
  const cellTaken = new Array<boolean>(neighbors.length).fill(false);
  const result: Array<PatchCell | null> = new Array(SKIRT_RING_COUNT).fill(null);
  for (const pair of pairs) {
    if (slotTaken[pair.slot] || cellTaken[pair.cell]) continue;
    slotTaken[pair.slot] = true;
    cellTaken[pair.cell] = true;
    result[pair.slot] = neighbors[pair.cell] ?? null;
  }
  // Защита от вырожденных патчей (меньше 6 соседей): пустые слоты замыкаются на центр.
  const fallback = (patch.cells[0] ?? neighbors[0]) as PatchCell;
  return result.map((cell) => cell ?? fallback);
}

/**
 * Сферическое проседание касательной плоскости на расстоянии r от центра:
 * Δz_drop = R_p − sqrt(max(0, R_p² − r²)). При R_p ≤ 1 проседание выключено
 * (обратная совместимость с плоской локальной картой).
 */
export function planetCurvatureDropM(planetRadiusM: number, rM: number): number {
  if (!(planetRadiusM > 1)) return 0;
  return planetRadiusM - Math.sqrt(Math.max(0, planetRadiusM * planetRadiusM - rM * rM));
}

/**
 * Обратная к localPointToDirection exp-карта. Применяется для сравнения
 * ОДНОЙ физической точки в касательных кадрах двух разных патчей (m.13).
 */
export function directionToLocalPoint(patch: LocalMapPatch, dir: Vec3): { u: number; v: number } {
  const { origin, east, north, radiusM } = patch.frame;
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(origin, dir))));
  const sin = Math.sin(theta);
  const scale = sin > 1e-10 ? theta * radiusM / sin : radiusM;
  return { u: dot(dir, east) * scale, v: dot(dir, north) * scale };
}

/** Ландшафт назначения для подписи перехода на соседний гекс (A-17). */
export function neighborTerrainKind(cell: PatchCell, seaLevel: number): string {
  if (cell.elevation < seaLevel) return 'океан';
  if (cell.lakeWeight > 0) return 'озеро';
  // muLand — непрерывная береговая принадлежность. До 0.80 ячейка ещё несёт
  // линию берега на масштабе перехода, даже если её центр уже выше seaLevel.
  if (cell.muLand < 0.8) return 'берег';
  // Нулевой порог streamWeight маркировал почти всю дренируемую сушу рекой.
  // Оставляем верхнюю половину нормированного потока либо крупное устойчивое
  // русло с площадью стока не меньше 20 000 км².
  const meaningfulRiver = cell.streamWeight >= 0.5
    || (cell.streamWeight >= 0.35 && cell.riverAccumulation >= 20_000);
  if (meaningfulRiver) return 'река';
  return 'суша';
}
