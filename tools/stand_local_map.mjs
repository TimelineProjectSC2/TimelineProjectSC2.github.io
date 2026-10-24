#!/usr/bin/env node
/* Стенд измерительных метрик качества локальной карты (Stage-8.12d, шаг 1).
 * ---------------------------------------------------------------------------
 * Один инструмент вместо потока «снимок глазами → отдельная карточка дефекта».
 * Печатает таблицу метрик по 7 контрольным ячейкам канонической сетки
 * Земли v=128 и служит оракулом для распила (шаг 2): после починки стенд
 * должен перейти из красного в зелёный без ручной правки отчёта.
 *
 *   node tools/stand_local_map.mjs            печать таблицы, всегда exit 0
 *   node tools/stand_local_map.mjs --gate     exit 1, если хотя бы одна метрика красная
 *   node tools/stand_local_map.mjs --json     та же таблица в JSON
 *   node tools/stand_local_map.mjs --profile=a17   другой мир (профиль A-17)
 *   node tools/stand_local_map.mjs --radius-m=2500 переопределить радиус участка (м)
 *   node tools/stand_local_map.mjs --flat-fixture  негативный контроль (плоская фикстура)
 *
 * Гейт по умолчанию выключен: пороги красные намеренно (фиксируют текущие
 * дефекты), CI ломать нельзя. Включать гейт можно только после того, как
 * волна починки закроет красные метрики.
 *
 * ЧТО ИЗМЕРЯЕТСЯ (метрики и пороги заданы владельцем; определения 1, 3 и
 * порог 2 переопределены карточкой воркера 18b, метрика 7 добавлена ей же;
 * метрики 8–14 добавлены карточкой воркера 26, Stage-8.14 шаг 1):
 *   1. ступень кромки русла      — поперечный профиль русла, max |Δh| между
 *                                   соседними вершинами heightfield, только
 *                                   по вершинам области вреза (carve > 0) ≤ 2 м
 *   2. глубина воды в центре русла — глубина воды на оси русла          3…12 м
 *   3. непрерывность русла через грань гекса — вода в пределах одного
 *                                   текселя по обе стороны грани в фактических
 *                                   створах Patch7 (входы + выход к воде)
 *                                   100 % створов
 *   4. фактура рельефа            — RMS высоты в трёх кольцах (патч,
 *                                   воротник, юбка); отношение любой пары
 *                                   в пределах                              0,7…1,3
 *   5. перепад между соседними вершинами на суше — max |Δh| на суше     ≤ 6 м
 *   6. перепад waterDepthM патч/юбка на одинаковой глубине               ≤ 0,5 м
 *   7. доля площади гекса под врезом — доля точек сетки 44×44 (±0,95·R),
 *                                   где riverCarveFactor > 0            ≤ 12 %
 *   8. размах суши / окно 5 км    — Δh по вершинам суши / 5 000 м      3…8 %
 *   9. размах океанского дна      — Δh по вершинам океана / 5 000 м     ≥ 1 %
 *  10. средний уклон              — средний |Δh|/dx по парам соседних
 *                                   вершин heightfield                   ≥ 4 %
 *  11. гипсометрия p90−p10        — (p90 − p10) / (max − min)           ≥ 40 % размаха
 *  12. гладкость контура воды     — доля промежуточных значений
 *                                   0 < mask < 1 вдоль контура воды     ≥ 40 %
 *  13. непрерывность A↔B          — max |h_A − h_B| на общей грани двух
 *                                   разных гексов A и B (16 точек)       ≤ 1 м
 *  14. согласованность LOD        — max |h_256 − h_64| одного гекса на
 *                                   разрешениях 256 и 64                 ≤ 2 м
 *
 * Почему 1 и 3 переопределены (карточка 18b): прежняя 1 мерила профиль
 * шириной 391 м при долине ±150 м — кромку вместе с природным зерном суши,
 * где соседняя метрика 5 разрешает 6 м, и порог 2 м был недостижим by
 * design. Прежняя 3 требовала воду в 16 точках по периметру гекса, а у реки
 * один исток и один сток: честная реализация даёт 1…2 из 16, и порог 16/16
 * выполним только 16 лучами из центра («паутиной»). Метрика 7 ловит именно
 * паутину: река с долиной даёт единицы процентов, 16 лучей — 22,5 % при
 * halfWidth 0,03 и 32,4 % при 0,045 (проверено на ветке с паутиной).
 *
 * ЧТО ИСПОЛЬЗУЕТСЯ ИЗ ПРОДАКШН-КОДА:
 *   - src/local-map/local-map-contract.ts: buildPatch7 (канонический срез
 *     7 ячеек), isWaterCell, nearestPatchCell, localPointToDirection;
 *   - src/local-map/local-map-rivers.ts (если модуль уже выделен распилом):
 *     riverSegments и riverCarveFactor — теми же segments/halfWidth, что
 *     считает воркер, стенд строит поле вреза для метрик 1 и 7. Если файла
 *     ещё нет (база до распила), используются дословные копии приватных
 *     riverSegments/riverCarveFactor/cellTangentMeters из
 *     local-map-worker.ts — по той же причине и с той же поме́ткой, что и
 *     копии ниже; числа распила при этом побайтово те же;
 *   - src/local-map/local-map-worker.ts: generateLocalMap (heightfield,
 *     terraform_map), generateHorizonSkirt (юбка, маски воды/русла),
 *     clusterHexMetric, HEX_APOTHEM_RATIO, CENTER_HEX_RADIUS_RATIO,
 *     SKIRT_* (радиусы колец), HEIGHTFIELD_RES, RIVER_HALF_WIDTH_RATIO,
 *     METERS_PER_ELEVATION_UNIT;
 *   - site/shared/geodesic-grid.ts + site/shared/planet-surface.ts: каноническая
 *     сетка и поверхность c100-soft-v2.
 * Ничего в src/ этот инструмент не правит: стенд только меряет.
 *
 * ЧТО ПРИШЛОСЬ СКОПИРОВАТЬ (и почему):
 *   - билинейную выборку heightfield (bilinearHeight) и выборку высоты юбки
 *     вдоль луча (skirtHeightAt) — в продакшн-коде это приватные функции
 *     воркера (sampleInnerHeightfield и тело generateHorizonSkirt), а
 *     src/ править нельзя; копии взяты дословно из
 *     tests/local-map-stage8.test.mjs, чтобы числа совпадали с прошлыми
 *     отчётами A-17/A-29;
 *   - формулу оптической глубины waterDepthM (GLSL-шейдер
 *     local-map-shaders.ts, ветка openSea) — в шейдере нет CPU-эквивалента;
 *     используется та же CPU-реплика, что и в диагностике A-29
 *     (pelagicDepth = 7,25 м, surfShoal = 0,8).
 * Обе копии помечены в коде и повторяют эталонные измерения A-17/A-29.
 *
 * ФИКСТУРЫ (копии из tests/local-map-stage8.test.mjs, значения не переписаны):
 *   A17_PROFILE, A29_PROFILE, список контрольных ячеек. По умолчанию радиус
 *   участка берётся из GLOBE_CELL_SCALE (≈ 52 136 м); m.8/m.9/m.10 меряются
 *   в независимом фиксированном окне 5 000 м.
 *   По умолчанию стенд мерит мир A-29 (masterSeedHex a29a29a29a29a29a): это
 *   тот мир, на котором закрыт A-29, и числа метрики 6 совпадают с его
 *   диагностикой (0,067 / 0,091 / 0,070 / 0,074 м на четырёх ячейках).
 *   Мир A-17 (seedText korhal-iv) доступен через --profile=a17: в нём
 *   каноническая топология Patch7 содержит реку у шести из семи ячеек, поэтому
 *   метрики 1–3 там измеримы шире, — стенд нужен и как кросс-проверка.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;
const Contract = require('../src/local-map/local-map-contract.ts');
const Geometry = require('../src/local-map/local-map-geometry.ts');
const { GLOBE_CELL_SCALE, GLOBE_RELIEF } = require('../site/shared/planet-globe.ts');
const Worker = require('../src/local-map/local-map-worker.ts');
const Heightfield = require('../src/local-map/local-map-heightfield.ts');

// Модуль русел после распила local-map-worker.ts (Stage-8.12d, шаг распила):
// если файл есть, поле вреза считается ПРОИЗВОДСТВЕННЫМИ riverSegments /
// riverCarveFactor — именно так стенд видит и 16 вспомогательных лучей
// «паутины», если воркер их добавил в свои сегменты. Если файла нет (база
// стенда старше распила), ниже работают дословные копии тех же приватных
// функций воркера. Молча подменять производственный модуль копиями при его
// наличии нельзя: при битом экспорте стенд падает, а не меряет копию.
const RIVERS_PATH = fileURLToPath(new URL('../src/local-map/local-map-rivers.ts', import.meta.url));
const Rivers = existsSync(RIVERS_PATH) ? require('../src/local-map/local-map-rivers.ts') : null;
if (Rivers && (typeof Rivers.riverSegments !== 'function' || typeof Rivers.riverCarveFactor !== 'function')) {
  throw new Error('stand_local_map: src/local-map/local-map-rivers.ts есть, но не экспортирует riverSegments/riverCarveFactor');
}

// ---------------------------------------------------------------------------
// Фикстуры — копии из tests/local-map-stage8.test.mjs (значения не менять).
// ---------------------------------------------------------------------------

const A17_PROFILE = {
  seedText: 'korhal-iv',
  radiusKm: 6371,
  surfaceClass: 'terrestrial',
  presetId: 'earthlike_balanced',
  geographyVersion: 'c100-soft-v2',
  continentMeanCells: 400,
  continentVariation: 0.8,
  oceanBasinMeanCells: 6000,
  drainageMeanCells: 72,
  oceanPctl: 70,
  shelfBelowPctl: 67,
  shelfAbovePctl: 73,
  highlandLandPctl: 75,
  mountainLandPctl: 92,
  aridLandPctl: 25,
  wetLandPctl: 75,
  coldPctl: 20,
  hotPctl: 80,
  streamFlowPctl: 90,
  majorRiverFlowPctl: 99,
  coastSoftWidthCells: 3,
  continentSoftWidthCells: 4,
  biomeSoftWidthCells: 2,
  transitionEntropyPctl: 90,
};

const A29_PROFILE = {
  ...A17_PROFILE,
  masterSeedHex: 'a29a29a29a29a29a',
  oceanPctl: 90,
  shelfBelowPctl: 87,
  shelfAbovePctl: 93,
};

/** Контрольные ячейки канонической сетки Земли v=128 (заданы владельцем). */
const CONTROL_CELLS = [37488, 37518, 37548, 37519, 137363, 137390, 137436];

/** Профи мира: профиль + seed сектора (те же значения, что в отчётах A-17/A-29). */
const WORLDS = {
  a17: { profile: A17_PROFILE, seed: 0x4f9f2cab, label: 'A-17 (korhal-iv)' },
  a29: { profile: A29_PROFILE, seed: 0xa29b2026, label: 'A-29 (a29a29a29a29a29a)' },
};

const PLACE_ID = 2;
const DEFAULT_RADIUS_M = GLOBE_CELL_SCALE.strategicPatchRadiusM;
/** Фиксированное окно (м) для метрик рельефа и уклона m.8, m.9, m.10 — независимо от radiusM. */
const RELIEF_WINDOW_WIDTH_M = 5000;
const RELIEF_WINDOW_RADIUS_M = RELIEF_WINDOW_WIDTH_M / 2;
const CANONICAL_V = 128;
/** Азимутов профиля батиметрии A-29 (метрика 6; метрика 3 азимутами больше не мерит). */
const AZIMUTHS = 16;
/** Метрика 7: сетка точек поля вреза — 44×44 центра ячеек квадрата ±0,95·R. */
const CARVE_AREA_GRID = 44;
const CARVE_AREA_RADIUS_RATIO = 0.95;
/** Шаг профиля батиметрии A-29, м. */
const BATHY_STEP_M = 45;
/** Число шагов профиля батиметрии A-29 (точки границы + 6 пар через 45 м). */
const BATHY_STEPS = 6;
/** Метрика 13: число точек вдоль общей грани двух соседних гексов A и B. */
const HEX_EDGE_SAMPLES = 16;
/** Метрика 14: детальное и грубое разрешения LOD одного и того же гекса. */
const LOD_FINE_RES = 256;
const LOD_COARSE_RES = 64;

// ---------------------------------------------------------------------------
// Пороги метрик — заданы владельцем, менять нельзя.
// ---------------------------------------------------------------------------

const THRESHOLDS = {
  bankStepM: 2,
  // Метрика 2 — диапазон, а не только минимум (карточка 18b): без потолка
  // воркер вырыл 18,4 м, и именно из-за этой глубины кромка метрики 1 не
  // могла стать пологой. riverDepthM оставлен как имя минимума диапазона.
  // Потолок действует только на речную ветвь (маркер 1, карточка 18c):
  // у морской ветви (маркер 0) глубина — это глубина моря, потолка нет.
  riverDepthM: 3,
  riverDepthMaxM: 12,
  // Метрика 3: непрерывны должны быть все фактические створы (100 %).
  continuityFraction: 1,
  textureRatioMin: 0.7,
  textureRatioMax: 1.3,
  landStepM: 6,
  waterDepthDeltaM: 0.5,
  // Метрика 7: потолок доли площади под врезом, %.
  carveAreaMaxPct: 12,
  // Метрики 8–14 (Stage-8.14, шаг 1, Воркер 26; шаг 2, Воркер 26b): форма и сквозная непрерывность.
  landReliefMinPct: 3,
  landReliefMaxPct: 8,
  oceanReliefMinPct: 1,
  meanSlopeMinPct: 4,
  hypsometryMinPct: 20,
  hypsometryMaxPct: 35,
  waterContourSmoothMinPct: 40,
  hexContinuityMaxM: 1,
  lodConsistencyMaxM: 2,
};

/** Ориентиры гипсометрии (печатаются в detail m.11, в вердикте не участвуют). */
const HYPSO_EARTH_REFERENCE_PCT = 19.4;
const HYPSO_DOMAIN_REFERENCE_PCT = 28.1;
const HYPSO_PREV_THRESHOLD_PCT = 35;

/** Коэффициенты глобуса и его шкала K из тех же модулей, что и страница. */
const GLOBE_LAND_RELIEF_FACTOR = GLOBE_RELIEF.landMax;
const GLOBE_OCEAN_RELIEF_FACTOR = GLOBE_RELIEF.oceanMax;
const DEFAULT_GLOBE_SCALE_K = Worker.METERS_PER_ELEVATION_UNIT;

/** CPU-реплика оптической глубины waterDepthM (ветка openSea шейдера, A-29). */
const PELAGIC_DEPTH_M = 7.25;
const SURF_SHOAL = 0.8;
/** Допуск «вода выше зеркала моря», м: поверхность моря в карте — это z = 0. */
const WATER_LEVEL_TOL_M = 0.1;

// ---------------------------------------------------------------------------
// Разбор аргументов
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    gate: false,
    json: false,
    world: 'a29',
    radiusM: DEFAULT_RADIUS_M,
    flatFixture: false,
    flatHeightM: 0,
    hypsoReferencePct: null,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--gate') options.gate = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--flat-fixture') options.flatFixture = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--profile=')) {
      const name = arg.slice('--profile='.length);
      if (!Object.prototype.hasOwnProperty.call(WORLDS, name)) {
        throw new Error(`Неизвестный профиль: ${name} (доступны: ${Object.keys(WORLDS).join(', ')})`);
      }
      options.world = name;
    } else if (arg.startsWith('--radius-m=')) {
      const value = Number(arg.slice('--radius-m='.length));
      if (!Number.isFinite(value) || value <= 0) throw new Error('--radius-m должно быть положительным числом');
      options.radiusM = value;
    } else if (arg.startsWith('--flat-height-m=')) {
      const value = Number(arg.slice('--flat-height-m='.length));
      if (!Number.isFinite(value)) throw new Error('--flat-height-m должно быть конечным числом');
      options.flatHeightM = value;
    } else if (arg.startsWith('--hypso-reference=')) {
      const value = Number(arg.slice('--hypso-reference='.length));
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error('--hypso-reference должно быть числом от 0 до 100');
      }
      options.hypsoReferencePct = value;
    } else {
      throw new Error(`Неизвестный аргумент: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Использование: node tools/stand_local_map.mjs [--gate] [--json] [--profile=a17|a29] [--radius-m=2500] [--hypso-reference=28.1] [--flat-fixture]',
    '',
    '  (без флагов)         печать таблицы метрик по 7 контрольным ячейкам, всегда exit 0',
    '  --gate               exit 1, если хотя бы одна метрика красная (гейт выключен по умолчанию)',
    '  --json               та же таблица в JSON',
    '  --profile            мир измерения: a29 (по умолчанию) или a17',
    '  --radius-m           радиус участка, м (по умолчанию GLOBE_CELL_SCALE.strategicPatchRadiusM ≈ 52 136)',
    '  --hypso-reference    подставить ориентир гипсометрии (%) в detail m.11 (в вердикте не участвует)',
    '  --flat-fixture       негативный контроль на синтетическом плоском heightfield (h = const)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Вспомогательные выборки (копии из tests/local-map-stage8.test.mjs — см. шапку)
// ---------------------------------------------------------------------------

/** Реплика билинейной выборки sampleInnerHeightfield воркера (сетка res × res). */
function bilinearHeight(heightfield, res, radiusM, px, py) {
  const cellSize = (2 * radiusM) / res;
  const gx = Math.min(res - 1.0001, Math.max(0, px / cellSize + res / 2));
  const gy = Math.min(res - 1.0001, Math.max(0, py / cellSize + res / 2));
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const ax = gx - ix;
  const ay = gy - iy;
  const i00 = iy * res + ix;
  const h00 = heightfield[i00];
  const h10 = heightfield[i00 + 1];
  const h01 = heightfield[i00 + res];
  const h11 = heightfield[i00 + res + 1];
  if (h00 === h10 && h00 === h01 && h00 === h11) return h00;
  return (h00 * (1 - ax) + h10 * ax) * (1 - ay)
    + (h01 * (1 - ax) + h11 * ax) * ay;
}

/** Высота юбки вдоль луча angularIndex на расстоянии radiusM (копия A-17). */
function skirtHeightAt(skirt, angularIndex, radiusM) {
  const angularCount = Worker.SKIRT_ANGULAR_SEGMENTS + 1;
  let previousRadius = 0;
  let previousZ = 0;
  for (let j = 0; j <= Worker.SKIRT_RADIAL_RINGS; j++) {
    const index = (j * angularCount + angularIndex) * 3;
    const radius = Math.hypot(skirt.positions[index], skirt.positions[index + 1]);
    const z = skirt.positions[index + 2];
    if (j > 0 && radius >= radiusM) {
      const t = (radiusM - previousRadius) / (radius - previousRadius);
      return previousZ + (z - previousZ) * t;
    }
    previousRadius = radius;
    previousZ = z;
  }
  return previousZ;
}

/** Индекс ближайшей вершины юбки к точке (angularIndex, radiusM). */
function skirtVertexNear(skirt, angularIndex, radiusM) {
  const angularCount = Worker.SKIRT_ANGULAR_SEGMENTS + 1;
  let best = 0;
  let bestDistance = Infinity;
  for (let j = 0; j <= Worker.SKIRT_RADIAL_RINGS; j++) {
    const p = (j * angularCount + angularIndex) * 3;
    const radius = Math.hypot(skirt.positions[p], skirt.positions[p + 1]);
    const distance = Math.abs(radius - radiusM);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = p;
    }
  }
  return best / 3;
}

/** Тексель terraform_map в точке касательной плоскости (копия A-17b). */
function terraformTexel(map, res, radiusM, x, y) {
  const cellSize = 2 * radiusM / res;
  const ix = Math.max(0, Math.min(res - 1, Math.floor(x / cellSize + res / 2)));
  const iy = Math.max(0, Math.min(res - 1, Math.floor(y / cellSize + res / 2)));
  return map[iy * res + ix];
}

/** RMS по выборке значений. */
function rms(values) {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum / values.length);
}

/** Медиана выборки (для уровня суши вокруг русла). */
function median(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] + sorted[mid]) / 2);
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Поле вреза русла: производственные riverSegments/riverCarveFactor
// (src/local-map/local-map-rivers.ts), а до распила — дословные копии
// приватных функций local-map-worker.ts (помечены fallback*).
// ---------------------------------------------------------------------------

/** КОПИЯ (fallback до распила): обратная exp-карта cellTangentMeters воркера. */
function fallbackCellTangentMeters(patch, cell) {
  const { origin, east, north, radiusM } = patch.frame;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cosTheta = Math.min(1, Math.max(-1, dot(cell.center, origin)));
  const theta = Math.acos(cosTheta);
  const sinTheta = Math.sin(theta);
  const scale = sinTheta > 1e-9 ? (theta * radiusM) / sinTheta : radiusM;
  return { u: dot(cell.center, east) * scale, v: dot(cell.center, north) * scale };
}

const cellTangentMeters = typeof Heightfield?.cellTangentMeters === 'function'
  ? Heightfield.cellTangentMeters
  : fallbackCellTangentMeters;

/** КОПИЯ (fallback до распила): riverSegments воркера (И-3.3). */
function fallbackRiverSegments(patch, radiusM, halfWidthM) {
  const raw = [];
  if (patch.river.flowsThroughCenter || patch.river.inlets.length > 0) {
    for (const edge of patch.river.inlets) {
      const cell = patch.cells[edge.slot + 1];
      if (!cell) continue;
      const inlet = fallbackCellTangentMeters(patch, cell);
      raw.push({ u0: inlet.u, v0: inlet.v, u1: 0, v1: 0 });
    }
    if (patch.river.outlet) {
      const cell = patch.cells[patch.river.outlet.slot + 1];
      if (cell) {
        const outlet = fallbackCellTangentMeters(patch, cell);
        raw.push({ u0: 0, v0: 0, u1: outlet.u, v1: outlet.v });
      }
    }
    if (raw.length === 0 && patch.river.flowsThroughCenter) {
      raw.push({ u0: -2 * radiusM, v0: 0, u1: 2 * radiusM, v1: 0 });
    }
  }
  return raw.map((seg) => ({
    ...seg,
    minU: Math.min(seg.u0, seg.u1) - halfWidthM,
    minV: Math.min(seg.v0, seg.v1) - halfWidthM,
    maxU: Math.max(seg.u0, seg.u1) + halfWidthM,
    maxV: Math.max(seg.v0, seg.v1) + halfWidthM,
  }));
}

/** КОПИЯ (fallback до распила): distanceToSegment воркера. */
function fallbackDistanceToSegment(wx, wy, seg) {
  const dx = seg.u1 - seg.u0;
  const dy = seg.v1 - seg.v0;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((wx - seg.u0) * dx + (wy - seg.v0) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = seg.u0 + dx * t;
  const py = seg.v0 + dy * t;
  return Math.hypot(wx - px, wy - py);
}

/** КОПИЯ (fallback до распила): riverCarveFactor воркера. */
function fallbackRiverCarveFactor(wx, wy, segments, halfWidthM) {
  if (segments.length === 0 || !(halfWidthM > 0)) return 0;
  let best = Infinity;
  for (const seg of segments) {
    if (wx < seg.minU || wx > seg.maxU || wy < seg.minV || wy > seg.maxV) continue;
    const d = fallbackDistanceToSegment(wx, wy, seg);
    if (d < best) best = d;
  }
  if (best === Infinity) return 0;
  if (best >= halfWidthM) return 0;
  const t = 1 - best / halfWidthM;
  return t * t * (3 - 2 * t);
}

const riverSegmentsImpl = Rivers ? Rivers.riverSegments : fallbackRiverSegments;
const riverCarveFactorImpl = Rivers ? Rivers.riverCarveFactor : fallbackRiverCarveFactor;
/** Откуда взяты segments/carve: 'local-map-rivers.ts' или копия до распила. */
const RIVER_CARVE_SOURCE = Rivers ? 'local-map-rivers.ts' : 'копия приватных функций local-map-worker.ts (модуля rivers ещё нет)';

/**
 * Поле вреза патча теми же segments/halfWidth, что считает воркер при
 * генерации heightfield: halfWidthM = max(2·cellSize, radiusM ·
 * RIVER_HALF_WIDTH_RATIO) и segments = riverSegments(patch, radiusM,
 * halfWidthM). Экспортируемая константа полуширины берётся из модуля русел,
 * если он есть, иначе из воркера (значение одно и то же — 0,03).
 */
function buildRiverCarveField(patch, radiusM) {
  const res = Worker.HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / res;
  const halfWidthRatio = (Rivers && Number.isFinite(Rivers.RIVER_HALF_WIDTH_RATIO))
    ? Rivers.RIVER_HALF_WIDTH_RATIO
    : Worker.RIVER_HALF_WIDTH_RATIO;
  const halfWidthM = Math.max(2 * cellSize, radiusM * halfWidthRatio);
  const segments = riverSegmentsImpl(patch, radiusM, halfWidthM);
  return {
    segments,
    halfWidthM,
    halfWidthRatio,
    cellSize,
    res,
    carveAt: (wx, wy) => riverCarveFactorImpl(wx, wy, segments, halfWidthM),
  };
}

/** Касательные координаты вершины heightfield по её индексу, м. */
function vertexCoordsM(index, res, cellSize) {
  return {
    x: ((index % res) - res / 2) * cellSize,
    y: (Math.floor(index / res) - res / 2) * cellSize,
  };
}

// ---------------------------------------------------------------------------
// Геометрия русла: каноническая топология Patch7 (inlets/outlet)
// ---------------------------------------------------------------------------

/**
 * Оси русла, заданные канонической топологией Patch7: для каждой грани, через
 * которую по И-3.3 входит или выходит сток, — азимут соседней ячейки в
 * касательном кадре. Азимут берётся только из экспортируемых данных патча
 * (frame.east/frame.north и PatchCell.center).
 */
function riverAxes(patch) {
  const { east, north } = patch.frame;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const edges = [
    ...patch.river.inlets.map((edge) => ({ slot: edge.slot, kind: 'вход', cell: edge.neighborCell })),
    ...(patch.river.outlet ? [{ slot: patch.river.outlet.slot, kind: 'выход', cell: patch.river.outlet.neighborCell }] : []),
  ];
  return edges.map((edge) => {
    const cell = patch.cells[edge.slot + 1];
    const azimuth = Math.atan2(dot(cell.center, north), dot(cell.center, east));
    return { ...edge, azimuth, neighborIsWater: Contract.isWaterCell(cell, patch.seaLevel) };
  });
}

/**
 * Фактические створы метрики 3 (карточка 18b): каждая грань входа русла
 * (patch.river.inlets) плюс грань выхода (patch.river.outlet) ТОЛЬКО если
 * сосед за ней — вода (isWaterCell): выход на сушу — это сток в следующий
 * гекс суши, а не устье, и створом не считается.
 */
function riverGateAxes(patch) {
  return riverAxes(patch).filter(
    (axis) => axis.kind === 'вход' || axis.neighborIsWater,
  );
}

/** Русское склонение слова «створ» для формата значения метрики 3. */
function gateWord(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'створ';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'створа';
  return 'створов';
}

/** Радиус контура центрального гекса по азимуту (продакшн-метрика кластера). */
function hexBoundaryRadiusM(radiusM, azimuth) {
  const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * radiusM;
  return apothemM / Worker.clusterHexMetric(Math.cos(azimuth), Math.sin(azimuth));
}

/**
 * Поперечный профиль русла: строка/столбец сетки heightfield поперёк оси
 * русла, проходящий через середину оси внутри гекса. Ширина профиля — 2,5
 * полуширины русла (производственная константа RIVER_HALF_WIDTH_RATIO).
 */
function riverCrossSection(patch, radiusM, axis, halfWidthM) {
  const res = Worker.HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / res;
  const boundaryM = hexBoundaryRadiusM(radiusM, axis.azimuth);
  const midRadiusM = boundaryM * 0.5;
  const midX = Math.cos(axis.azimuth) * midRadiusM;
  const midY = Math.sin(axis.azimuth) * midRadiusM;
  // Ось профиля перпендикулярна руслу: идём по той сетке, что ближе к ней.
  const perpX = -Math.sin(axis.azimuth);
  const perpY = Math.cos(axis.azimuth);
  const alongX = Math.abs(perpX) >= Math.abs(perpY);
  const steps = Math.max(1, Math.round((2.5 * halfWidthM) / cellSize));
  // primary — индекс вдоль профиля (x при alongX, иначе y), secondary —
  // фиксированный поперечный индекс. До карточки 18b пара была переставлена:
  // профиль проходил через отражённую точку (midY, midX), а не через
  // середину русла, поэтому поле вреза на нём было тождественно нулём даже
  // при существующих сегментах и метрика 1 мерила зерно суши в стороне от
  // реки. Профиль обязан проходить через (midX, midY) — как и сказано выше.
  const centerIndex = alongX
    ? Math.round(midX / cellSize + res / 2)
    : Math.round(midY / cellSize + res / 2);
  const centerIndexOther = alongX
    ? Math.round(midY / cellSize + res / 2)
    : Math.round(midX / cellSize + res / 2);
  const indices = [];
  for (let k = -steps; k <= steps; k++) {
    const primary = centerIndex + k;
    const secondary = centerIndexOther;
    if (primary < 0 || secondary < 0 || primary >= res || secondary >= res) continue;
    indices.push(alongX ? secondary * res + primary : primary * res + secondary);
  }
  return { indices, centerVertex: indices[Math.floor(indices.length / 2)], halfWidthM, boundaryM, midRadiusM };
}

// ---------------------------------------------------------------------------
// Метрики
// ---------------------------------------------------------------------------

/**
 * Метрика 1 — ступень кромки русла: максимальный |Δh| между соседними
 * вершинами heightfield поперёк оси русла (порог ≤ 2 м), только в области
 * вреза (карточка 18b). В максимум включаются только ступени, у которых
 * хотя бы одна из двух вершин лежит в области вреза (carve > 0): так сама
 * кромка — переход от carve = 0 к carve > 0 — измеряется, а природное зерно
 * суши вне области вреза (его меряет метрика 5 с порогом 6 м) — нет.
 * Если carve = 0 на всём профиле, метрика неприменима (value = null), а не 0:
 * нулевая ступень несуществующей кромки — ложный PASS.
 */
function measureBankStep(local, crossSection, carveField) {
  const heightfield = local.heightfield;
  const carve = crossSection.indices.map((index) => {
    const { x, y } = vertexCoordsM(index, carveField.res, carveField.cellSize);
    return carveField.carveAt(x, y);
  });
  const inAreaCount = carve.filter((value) => value > 0).length;
  if (inAreaCount === 0) {
    return {
      value: null,
      inAreaCount,
      profileCount: crossSection.indices.length,
      detail: 'carve = 0 на всём профиле — вершин в области вреза нет, кромку мерить негде',
    };
  }
  let maxStep = 0;
  let at = null;
  let considered = 0;
  for (let k = 1; k < crossSection.indices.length; k++) {
    if (carve[k - 1] <= 0 && carve[k] <= 0) continue;
    considered++;
    const a = crossSection.indices[k - 1];
    const b = crossSection.indices[k];
    const delta = Math.abs(heightfield[a] - heightfield[b]);
    if (delta > maxStep) {
      maxStep = delta;
      at = k;
    }
  }
  if (considered === 0) {
    return {
      value: null,
      inAreaCount,
      profileCount: crossSection.indices.length,
      detail: 'в области вреза нет соседних пар вершин профиля',
    };
  }
  return {
    value: maxStep,
    inAreaCount,
    profileCount: crossSection.indices.length,
    detail: `вершин в области вреза: ${inAreaCount} из ${crossSection.indices.length} профиля; `
      + (at === null ? 'все ступени в области вреза нулевые' : `максимум на шаге ${at} профиля`),
  };
}

/**
 * Вердикт метрики 2 по семантике центральной вершины профиля (карточка 18c).
 * Потолок 12 м существует, чтобы врезанная река не превращалась в каньон,
 * поэтому диапазон 3…12 м применяется только к речной ветви (маркер 1 —
 * врезанное русло суши; сюда же относится маркер суши ≥ 2 — воды в русле
 * нет, глубина 0). У морской ветви (маркер 0, зеркало моря) «глубина русла» —
 * это глубина моря, и потолка у неё нет: с ним океанские устья мира A-17
 * (31,5…52,4 м) падали FAIL, а «исправить» их можно было бы только обмелив
 * океан, то есть сломав батиметрию A-29. Там остаётся только ≥ 3 м.
 * violation — выход за свою ветвь в метрах (0 при PASS), margin — запас до
 * ближайшей границы своей ветви; по ним выбирается худшая ось патча.
 */
function riverDepthVerdict(value, marker) {
  const min = THRESHOLDS.riverDepthM;
  const max = THRESHOLDS.riverDepthMaxM;
  if (marker === 0) {
    return {
      branch: 'sea',
      branchLabel: 'морская ветвь (маркер 0, зеркало моря)',
      thresholdText: '≥ 3 м',
      pass: value >= min,
      violation: value >= min ? 0 : min - value,
      margin: value - min,
    };
  }
  return {
    branch: 'river',
    branchLabel: marker === 1
      ? 'речная ветвь (маркер 1, врезанное русло суши)'
      : 'речная ветвь (в центре русла суша, маркер ≥ 2)',
    thresholdText: '3…12 м',
    pass: value >= min && value <= max,
    violation: value < min ? min - value : value > max ? value - max : 0,
    margin: Math.min(value - min, max - value),
  };
}

/**
 * Метрика 2 — глубина воды в центре русла. Дно — высота heightfield на оси
 * русла; уровень воды — зеркало моря (0) для морской ячейки, уровень суши
 * (берег) для врезанного русла. Порог зависит от ветви (см.
 * riverDepthVerdict): речная — 3…12 м, морская — ≥ 3 м. Если в центре русла
 * воды нет вовсе (русло не врезано — маркер суши), глубина равна нулю: это и
 * есть измеряемый дефект «река пропала».
 */
function measureRiverDepth(local, crossSection) {
  const heightfield = local.heightfield;
  const terraform = local.terraformMap;
  const bed = heightfield[crossSection.centerVertex];
  const marker = terraform[crossSection.centerVertex] ?? 0;
  if (marker >= 2) {
    return {
      value: 0,
      marker,
      ...riverDepthVerdict(0, marker),
      detail: `в центре русла суша (${round(bed, 1)} м) — воды нет`,
    };
  }
  let surface;
  if (marker === 0) {
    surface = 0;   // зеркало моря
  } else {
    const land = [];
    for (const index of crossSection.indices) {
      if ((terraform[index] ?? 0) >= 2) land.push(heightfield[index]);
    }
    surface = land.length > 0 ? median(land) : heightfield[crossSection.centerVertex];
  }
  const depth = Math.max(0, surface - bed);
  return {
    value: depth,
    marker,
    ...riverDepthVerdict(depth, marker),
    detail: `дно ${round(bed, 1)} м, уровень ${round(surface, 1)} м`,
  };
}

/**
 * Метрика 3 — непрерывность русла через грань гекса в ФАКТИЧЕСКИХ створах
 * (карточка 18b): вода должна быть в пределах одного текселя по обе стороны
 * грани именно там, где русло её пересекает по канонической топологии
 * Patch7, — на гранях входов (inlets) и на грани выхода к воде (outlet с
 * соседом-водой). Знаменатель — число таких створов, а не 16 азимутов по
 * периметру: у реки один исток и один сток, честная реализация даёт 1…2
 * створа. Порог — 100 % створов.
 *
 * Вода считается присутствующей, если СЕМАНТИКА (маркер terraform_map на
 * стороне патча, маска воды/русла на стороне юбки) говорит «вода» И геометрия
 * не противоречит: морская вода должна лежать ниже зеркала моря (z = 0),
 * русло — выше него (его поверхность лежит на уровне суши). Один только
 * маркер без воды — это как раз дефект «ложная вода на суше».
 *
 * Применимость: если створов по топологии нет — N/A. Особый случай — грань
 * единственного выхода к воде без притоков и без потока через центр:
 * flowReceiver есть у КАЖДОЙ ячейки суши (это направление стока, а не река),
 * поэтому створ образуется, только если воркер при этом реально врезает
 * русло (segments непусты). Если топология утверждает реку (есть входы или
 * поток через центр), створы считаются независимо от воркера — иначе
 * отсутствующую реку метрика прятала бы в N/A вместо FAIL.
 */
function measureFaceContinuity(local, skirt, patch, radiusM, carveField) {
  const res = Worker.HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / res;
  const gates = riverGateAxes(patch);
  const topologyAssertsRiver = patch.river.inlets.length > 0 || patch.river.flowsThroughCenter;
  const workerCarvesRiver = carveField.segments.length > 0;
  if (gates.length === 0) {
    const outlet = patch.river.outlet;
    return {
      value: null,
      total: 0,
      detail: outlet
        ? `створов нет: входов нет, выход (слот ${outlet.slot}) ведёт на сушу — устья к воде нет`
        : 'створов нет: в Patch7 нет ни входов русла, ни выхода к воде',
    };
  }
  if (!topologyAssertsRiver && !workerCarvesRiver) {
    return {
      value: null,
      total: gates.length,
      detail: `створов нет: есть только выход стока к воде (${gates.map((gate) => `слот ${gate.slot}`).join(', ')}) `
        + 'без притоков и без потока через центр, а сегментов вреза воркер не строит — русла нет',
    };
  }
  let continuous = 0;
  const perGate = [];
  for (const gate of gates) {
    const azimuth = gate.azimuth;
    const normalized = ((azimuth % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const angularIndex = Math.round((normalized / (Math.PI * 2)) * Worker.SKIRT_ANGULAR_SEGMENTS)
      % Worker.SKIRT_ANGULAR_SEGMENTS;
    const boundaryM = hexBoundaryRadiusM(radiusM, azimuth);
    const innerRadiusM = boundaryM - cellSize;
    const innerX = Math.cos(azimuth) * innerRadiusM;
    const innerY = Math.sin(azimuth) * innerRadiusM;
    const innerZ = bilinearHeight(local.heightfield, res, radiusM, innerX, innerY);
    const innerMarker = terraformTexel(local.terraformMap, res, radiusM, innerX, innerY);
    const innerWater = innerMarker === 0 ? innerZ <= WATER_LEVEL_TOL_M : innerMarker === 1;
    const outerRadiusM = boundaryM + cellSize;
    const outerZ = skirtHeightAt(skirt, angularIndex, outerRadiusM);
    const vertex = skirtVertexNear(skirt, angularIndex, outerRadiusM);
    const outerRiver = skirt.riverMask[vertex] > 127;
    const outerWater = outerRiver
      ? true
      : skirt.waterMask[vertex] > 127 && outerZ <= WATER_LEVEL_TOL_M;
    if (innerWater && outerWater) continuous++;
    perGate.push(
      `${gate.kind} слот ${gate.slot}: внутри ${innerWater ? 'вода есть' : 'воды нет'}, снаружи ${outerWater ? 'вода есть' : 'воды нет'}`,
    );
  }
  return {
    value: continuous,
    total: gates.length,
    detail: perGate.join('; '),
  };
}

/**
 * Метрика 7 — доля площади гекса под врезом (карточка 18b, порог ≤ 12 %):
 * сетка 44×44 центров ячеек квадрата ±0,95·R (R = радиус участка), точка
 * засчитывается, если riverCarveFactor > 0 в ней при тех же
 * segments/halfWidth, что у воркера. Смысл — ловить «паутину»: честная река
 * с долиной занимает единицы процентов, а 16 лучей из центра дали 22,5 %
 * при halfWidth 0,03 и 32,4 % при 0,045. Метрика применима всегда: нет
 * сегментов — честные 0 %, а не N/A.
 */
function measureCarveArea(carveField, radiusM) {
  const grid = CARVE_AREA_GRID;
  const extentM = CARVE_AREA_RADIUS_RATIO * radiusM;
  const stepM = (2 * extentM) / grid;
  let hits = 0;
  for (let iy = 0; iy < grid; iy++) {
    const y = -extentM + (iy + 0.5) * stepM;
    for (let ix = 0; ix < grid; ix++) {
      const x = -extentM + (ix + 0.5) * stepM;
      if (carveField.carveAt(x, y) > 0) hits++;
    }
  }
  const total = grid * grid;
  return {
    value: (hits / total) * 100,
    hits,
    total,
    detail: `точек с carve > 0: ${hits} из ${total} (сетка ${grid}×${grid}, ±${CARVE_AREA_RADIUS_RATIO}·R); `
      + `сегментов русла: ${carveField.segments.length}, halfWidth = ${round(carveField.halfWidthM, 1)} м `
      + `(${carveField.halfWidthRatio}·R), поле вреза: ${RIVER_CARVE_SOURCE}`,
  };
}

/**
 * Метрика 4 — фактура рельефа: RMS высоты в трёх кольцах (патч — центральный
 * гекс heightfield, воротник — плотные кольца юбки, юбка — дальние кольца).
 * Порог: отношение любой пары в пределах 0,7…1,3.
 */
function measureTexture(local, skirt, radiusM) {
  const res = Worker.HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / res;
  const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * radiusM;
  const innerRadiusM = Worker.SKIRT_INNER_RADIUS_RATIO * radiusM;
  const collarEndM = Worker.SKIRT_COLLAR_END_RADIUS_RATIO * radiusM;
  const patchValues = [];
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const wx = (x - res / 2) * cellSize;
      const wy = (y - res / 2) * cellSize;
      if (Worker.clusterHexMetric(wx, wy) <= apothemM) patchValues.push(local.heightfield[y * res + x]);
    }
  }
  const angularCount = Worker.SKIRT_ANGULAR_SEGMENTS + 1;
  const collarValues = [];
  const skirtValues = [];
  for (let j = 0; j <= Worker.SKIRT_RADIAL_RINGS; j++) {
    for (let i = 0; i < angularCount; i++) {
      const v = (j * angularCount + i) * 3;
      const radius = Math.hypot(skirt.positions[v], skirt.positions[v + 1]);
      const z = skirt.positions[v + 2];
      if (radius >= innerRadiusM && radius <= collarEndM) collarValues.push(z);
      else if (radius > collarEndM) skirtValues.push(z);
    }
  }
  const rmsPatch = rms(patchValues);
  const rmsCollar = rms(collarValues);
  const rmsSkirt = rms(skirtValues);
  const pairs = [
    { name: 'патч/воротник', ratio: rmsCollar / rmsPatch },
    { name: 'патч/юбка', ratio: rmsSkirt / rmsPatch },
    { name: 'воротник/юбка', ratio: rmsSkirt / rmsCollar },
  ].map((pair) => ({
    ...pair,
    // Выход за коридор 0,7…1,3: 1 — ровно на границе коридора, > 1 — за ним.
    violation: Math.max(pair.ratio / THRESHOLDS.textureRatioMax, THRESHOLDS.textureRatioMin / pair.ratio),
  }));
  const worst = pairs.reduce((a, b) => (b.violation > a.violation ? b : a));
  return {
    value: worst.ratio,
    pairs,
    detail: `RMS патч ${round(rmsPatch, 1)} м, воротник ${round(rmsCollar, 1)} м, юбка ${round(rmsSkirt, 1)} м; `
      + pairs.map((pair) => `${pair.name} = ${pair.ratio.toFixed(2)}×`).join(', ')
      + `; худшая пара ${worst.name} = ${worst.ratio.toFixed(2)}×`,
  };
}

/**
 * Метрика 5 — перепад между соседними вершинами heightfield на суше
 * (порог ≤ 6 м). На воде перепад не измеряется — метрика неприменима.
 */
function measureLandStep(local) {
  const res = Worker.HEIGHTFIELD_RES;
  const heightfield = local.heightfield;
  const terraform = local.terraformMap;
  let maxStep = 0;
  let landTexels = 0;
  for (let i = 0; i < heightfield.length; i++) {
    if ((terraform[i] ?? 0) >= 2) landTexels++;
  }
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      if ((terraform[i] ?? 0) < 2) continue;
      if (x + 1 < res && (terraform[i + 1] ?? 0) >= 2) {
        const delta = Math.abs(heightfield[i] - heightfield[i + 1]);
        if (delta > maxStep) maxStep = delta;
      }
      if (y + 1 < res && (terraform[i + res] ?? 0) >= 2) {
        const delta = Math.abs(heightfield[i] - heightfield[i + res]);
        if (delta > maxStep) maxStep = delta;
      }
    }
  }
  return {
    value: maxStep,
    landTexels,
    detail: `текселей суши: ${landTexels}`,
  };
}

/**
 * Метрика 6 — перепад waterDepthM патч/юбка на одинаковой глубине
 * (порог ≤ 0,5 м). Профиль тот же, что в диагностике A-29: 16 азимутов ×
 * (точка границы + 6 пар через 45 м), глубина считается CPU-репликой формулы
 * шейдера (pelagicDepth = 7,25 м, surfShoal = 0,8).
 *
 * Сравниваются только пары, где вода есть С ОБЕИХ сторон (маркер воды на
 * стороне патча, маска воды на стороне юбки): шейдер считает waterDepthM только
 * там, где вода нарисована, поэтому пара «вода ↔ суша» не имеет глубины и
 * измеряется метрикой 3 (непрерывность через грань).
 */
function measureWaterDepthDelta(local, skirt, radiusM) {
  const res = Worker.HEIGHTFIELD_RES;
  const guardM = Worker.SKIRT_HEIGHTFIELD_GUARD_RATIO * radiusM;
  const boundaryM = Worker.SKIRT_COLLAR_END_RADIUS_RATIO * radiusM;
  let maxDelta = 0;
  let waterPairs = 0;
  let totalPairs = 0;
  let worst = null;
  for (let az = 0; az < AZIMUTHS; az++) {
    const azimuth = (az / AZIMUTHS) * Math.PI * 2;
    const angularIndex = (az * Worker.SKIRT_ANGULAR_SEGMENTS) / AZIMUTHS;
    for (let step = 0; step <= BATHY_STEPS; step++) {
      const distanceM = step * BATHY_STEP_M;
      const innerRadiusM = Math.max(0, boundaryM - distanceM);
      const innerX = Math.max(-guardM, Math.min(guardM, Math.cos(azimuth) * innerRadiusM));
      const innerY = Math.max(-guardM, Math.min(guardM, Math.sin(azimuth) * innerRadiusM));
      const innerHeightM = bilinearHeight(local.heightfield, res, radiusM, innerX, innerY);
      const outerHeightM = skirtHeightAt(skirt, angularIndex, boundaryM + distanceM);
      const innerMarker = terraformTexel(local.terraformMap, res, radiusM, innerX, innerY);
      const outerRadiusM = boundaryM + distanceM;
      const vertex = skirtVertexNear(skirt, angularIndex, outerRadiusM);
      const outerRiver = skirt.riverMask[vertex] > 127;
      const outerWater = outerRiver
        || (skirt.waterMask[vertex] > 127 && outerHeightM <= WATER_LEVEL_TOL_M);
      totalPairs++;
      if (!(innerMarker === 0 || innerMarker === 1) || !outerWater) continue;
      waterPairs++;
      const innerDepthM = Math.max(0, -innerHeightM);
      const outerDepthM = Math.max(0, -outerHeightM);
      const innerWaterDepthM = (innerDepthM * 1.35 + PELAGIC_DEPTH_M) * SURF_SHOAL;
      const outerWaterDepthM = (outerDepthM * 1.35 + PELAGIC_DEPTH_M) * SURF_SHOAL;
      const delta = Math.abs(innerWaterDepthM - outerWaterDepthM);
      if (delta > maxDelta) {
        maxDelta = delta;
        worst = { azimuthDeg: az * (360 / AZIMUTHS), distanceM, innerHeightM, outerHeightM };
      }
    }
  }
  return {
    value: maxDelta,
    waterPairs,
    totalPairs,
    detail: worst
      ? `пар с водой по обе стороны: ${waterPairs} из ${totalPairs}; худшая пара: азимут ${worst.azimuthDeg}°, ${worst.distanceM} м, высоты ${round(worst.innerHeightM, 2)} / ${round(worst.outerHeightM, 2)} м`
      : `пар с водой по обе стороны нет (${totalPairs} пар измерено)`,
    hasWater: waterPairs > 0,
  };
}

// ---------------------------------------------------------------------------
// Метрики 8–14 (Stage-8.14, шаг 1): форма и сквозная непрерывность
// ---------------------------------------------------------------------------

/** Линейный квантиль по уже отсортированному массиву. */
function quantileSorted(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

/**
 * Приводит маску воды к диапазону [0, 1].
 * Uint8Array со значениями 0..255 (контракт gl.UNSIGNED_BYTE normalized у
 * skirt.waterMask / skirt.riverMask) делится на 255; бинарный буфер {0, 1}
 * (контракт ringCell.waterMask) остаётся {0, 1}, чтобы единица не стала 1/255.
 */
function normalizeMaskArray(mask) {
  if (mask instanceof Float32Array || mask instanceof Float64Array) {
    const out = new Float32Array(mask.length);
    for (let i = 0; i < mask.length; i++) out[i] = Math.min(1, Math.max(0, mask[i]));
    return out;
  }
  let maxVal = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > maxVal) maxVal = mask[i];
  }
  const scale = maxVal > 1 ? 1 / 255 : 1;
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = Math.min(1, Math.max(0, mask[i] * scale));
  return out;
}

/** Проверка попадания вершины (x, y) сетки res × res в фиксированное окно 5 000 м вокруг центра. */
function inReliefWindow(x, y, res, cellSize) {
  const wx = (x + 0.5 - res / 2) * cellSize;
  const wy = (y + 0.5 - res / 2) * cellSize;
  return Math.abs(wx) <= RELIEF_WINDOW_RADIUS_M && Math.abs(wy) <= RELIEF_WINDOW_RADIUS_M;
}

/**
 * Метрика 8 — размах суши / ширина кадра (порог 3…8 %):
 * Δh = max(h) − min(h) по вершинам суши heightfield (terraform_map >= 2)
 * в пределах фиксированного окна 5 000 м вокруг центра, отнесённый к константе
 * окна RELIEF_WINDOW_WIDTH_M = 5 000 м (независимо от radiusM), в процентах.
 * На чисто океанском участке — N/A.
 */
function measureLandRelief(local, radiusM) {
  const srcLocal = local.windowLocal ?? local;
  const res = srcLocal.meta?.hfRes ?? Worker.HEIGHTFIELD_RES;
  const localRadiusM = Number.isFinite(srcLocal.meta?.radiusM) && srcLocal.meta.radiusM > 0
    ? srcLocal.meta.radiusM
    : (Number.isFinite(radiusM) && radiusM > 0 ? radiusM : RELIEF_WINDOW_RADIUS_M);
  const cellSize = (2 * localRadiusM) / res;
  const heightfield = srcLocal.heightfield;
  const terraform = srcLocal.terraformMap;
  const minMarker = Worker.TERRAFORM_LAND_MIN ?? 2;
  let minH = Infinity;
  let maxH = -Infinity;
  let landVertices = 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      if (!inReliefWindow(x, y, res, cellSize)) continue;
      const i = y * res + x;
      if ((terraform[i] ?? 0) < minMarker) continue;
      const h = heightfield[i];
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      landVertices++;
    }
  }
  if (landVertices === 0) {
    return {
      value: null,
      landVertices: 0,
      deltaM: null,
      frameWidthM: RELIEF_WINDOW_WIDTH_M,
      detail: 'на участке нет суши',
    };
  }
  const deltaM = maxH - minH;
  const frameWidthM = RELIEF_WINDOW_WIDTH_M;
  const pct = (deltaM / frameWidthM) * 100;
  return {
    value: pct,
    landVertices,
    deltaM,
    minH,
    maxH,
    frameWidthM,
    detail: `Δh = ${round(deltaM, 2)} м (${round(minH, 2)}…${round(maxH, 2)} м) при окне ${round(frameWidthM, 1)} м, вершин суши: ${landVertices}`,
  };
}

/**
 * Метрика 9 — размах океанского дна (порог ≥ 1 %):
 * Δh = max(h) − min(h) по вершинам океана heightfield (terraform_map == 0,
 * исключая зеркала континентальных озёр lakeWeight > 0) в пределах
 * фиксированного окна 5 000 м вокруг центра, отнесённый к константе окна
 * RELIEF_WINDOW_WIDTH_M = 5 000 м (независимо от radiusM), %.
 */
function measureOceanRelief(local, patch, radiusM) {
  const srcLocal = local.windowLocal ?? local;
  const res = srcLocal.meta?.hfRes ?? Worker.HEIGHTFIELD_RES;
  const localRadiusM = Number.isFinite(srcLocal.meta?.radiusM) && srcLocal.meta.radiusM > 0
    ? srcLocal.meta.radiusM
    : (Number.isFinite(radiusM) && radiusM > 0 ? radiusM : RELIEF_WINDOW_RADIUS_M);
  const cellSize = (2 * localRadiusM) / res;
  const heightfield = srcLocal.heightfield;
  const terraform = srcLocal.terraformMap;
  const hasLakeCell = patch ? patch.cells.some((c) => c.lakeWeight > 0) : false;
  let minH = Infinity;
  let maxH = -Infinity;
  let oceanVertices = 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      if (!inReliefWindow(x, y, res, cellSize)) continue;
      const i = y * res + x;
      if ((terraform[i] ?? 2) !== 0) continue;
      if (hasLakeCell) {
        const wx = (x - res / 2) * cellSize;
        const wy = (y - res / 2) * cellSize;
        const near = Contract.nearestPatchCell(patch, Contract.localPointToDirection(patch, wx, wy));
        if (near.lakeWeight > 0) continue;
      }
      const h = heightfield[i];
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      oceanVertices++;
    }
  }
  if (oceanVertices === 0) {
    return {
      value: null,
      oceanVertices: 0,
      deltaM: null,
      frameWidthM: RELIEF_WINDOW_WIDTH_M,
      detail: 'на участке нет океанского дна',
    };
  }
  const deltaM = maxH - minH;
  const frameWidthM = RELIEF_WINDOW_WIDTH_M;
  const pct = (deltaM / frameWidthM) * 100;
  return {
    value: pct,
    oceanVertices,
    deltaM,
    minH,
    maxH,
    frameWidthM,
    detail: `Δh = ${round(deltaM, 2)} м (${round(minH, 2)}…${round(maxH, 2)} м) при окне ${round(frameWidthM, 1)} м, вершин океана: ${oceanVertices}`,
  };
}

/**
 * Метрика 10 — средний уклон (порог ≥ 4 %):
 * среднее значение (|h_a − h_b| / cellSize) × 100 % по всем ортогональным
 * парам соседних вершин heightfield в пределах фиксированного окна 5 000 м
 * вокруг центра (независимо от radiusM).
 */
function measureMeanSlope(local, radiusM) {
  const srcLocal = local.windowLocal ?? local;
  const res = srcLocal.meta?.hfRes ?? Worker.HEIGHTFIELD_RES;
  const localRadiusM = Number.isFinite(srcLocal.meta?.radiusM) && srcLocal.meta.radiusM > 0
    ? srcLocal.meta.radiusM
    : (Number.isFinite(radiusM) && radiusM > 0 ? radiusM : RELIEF_WINDOW_RADIUS_M);
  const cellSize = (2 * localRadiusM) / res;
  const heightfield = srcLocal.heightfield;
  let slopeSumPct = 0;
  let pairs = 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      if (!inReliefWindow(x, y, res, cellSize)) continue;
      const i = y * res + x;
      const h = heightfield[i];
      if (x + 1 < res && inReliefWindow(x + 1, y, res, cellSize)) {
        slopeSumPct += (Math.abs(h - heightfield[i + 1]) / cellSize) * 100;
        pairs++;
      }
      if (y + 1 < res && inReliefWindow(x, y + 1, res, cellSize)) {
        slopeSumPct += (Math.abs(h - heightfield[i + res]) / cellSize) * 100;
        pairs++;
      }
    }
  }
  const meanPct = pairs > 0 ? slopeSumPct / pairs : 0;
  return {
    value: meanPct,
    pairs,
    cellSizeM: cellSize,
    windowWidthM: RELIEF_WINDOW_WIDTH_M,
    detail: `пар соседних вершин в окне ${RELIEF_WINDOW_WIDTH_M} м: ${pairs}, шаг сетки ${round(cellSize, 2)} м`,
  };
}

function formatCommaDecimal(value, digits = 1) {
  return Number(value).toFixed(digits).replace('.', ',');
}

function extractElevationArray(source) {
  if (!source) return new Float64Array(0);
  if (ArrayBuffer.isView(source) || Array.isArray(source)) {
    return Float64Array.from(source);
  }
  if (source.elevation && (ArrayBuffer.isView(source.elevation) || Array.isArray(source.elevation))) {
    return Float64Array.from(source.elevation);
  }
  if (source.heightfield && (ArrayBuffer.isView(source.heightfield) || Array.isArray(source.heightfield))) {
    return Float64Array.from(source.heightfield);
  }
  return new Float64Array(0);
}

/**
 * Метрика 11 — гипсометрия p90−p10 (гейт: полоса 20…35 %):
 * считается ТОЛЬКО по суше (elev > surface.seaLevel) всей планеты (сетка v=128)
 * как (p90 − p10) / (max − min).
 * На v=128 для A-29 даёт 45,93 % (p10 0,2954 / p50 0,3540 / p90 0,4685 / max 0,6600,
 * суша 16 596 из 163 842). Земля даёт 19,4 % (пик 8 848 м), наш домен при K = 8 570
 * и пике 6 147 м — 28,1 %.
 * При нулевом размахе (идеально плоское поле) возвращает 0 % и статус FAIL (а не 100 %).
 */
function measureHypsometry(source, options = {}) {
  const hasCustomReference = Number.isFinite(options.hypsoReferencePct);
  const referencePct = hasCustomReference ? options.hypsoReferencePct : HYPSO_DOMAIN_REFERENCE_PCT;
  const domainText = hasCustomReference
    ? `профиль ${formatCommaDecimal(referencePct, 1)} %`
    : `наш домен ${formatCommaDecimal(HYPSO_DOMAIN_REFERENCE_PCT, 1)} %`;
  const referenceDetail = `ориентир: Земля ${formatCommaDecimal(HYPSO_EARTH_REFERENCE_PCT, 1)} %, `
    + `${domainText}, прежний порог ${HYPSO_PREV_THRESHOLD_PCT} %`;

  const rawElev = extractElevationArray(source);
  const totalCells = rawElev.length;
  const seaLevel = Number.isFinite(options.seaLevel)
    ? options.seaLevel
    : (Number.isFinite(source?.seaLevel) ? source.seaLevel : null);

  let sorted;
  if (seaLevel !== null) {
    const land = [];
    for (let i = 0; i < rawElev.length; i++) {
      if (rawElev[i] > seaLevel) land.push(rawElev[i]);
    }
    sorted = Float64Array.from(land);
  } else {
    sorted = rawElev;
  }
  sorted.sort();
  const landCells = sorted.length;
  if (landCells === 0) {
    return {
      value: 0,
      minH: 0,
      maxH: 0,
      p10: 0,
      p50: 0,
      p90: 0,
      span: 0,
      band: 0,
      spanM: 0,
      bandM: 0,
      landCells: 0,
      totalCells,
      sampleCount: 0,
      referencePct,
      pass: false,
      status: 'FAIL',
      detail: `нет наземных ячеек (суша 0 из ${totalCells}); ${referenceDetail}`,
    };
  }
  const minH = sorted[0];
  const maxH = sorted[landCells - 1];
  const span = maxH - minH;
  const p10 = sorted[Math.floor(landCells * 0.10)];
  const p50 = sorted[Math.floor(landCells * 0.50)];
  const p90 = sorted[Math.floor(landCells * 0.90)];
  const band = p90 - p10;
  // Негативный контроль: идеально плоское поле (span === 0) обязано давать 0 % и FAIL, а не 100 %.
  const pct = span > 0 ? (band / span) * 100 : 0;
  const pass = span > 0
    && pct >= THRESHOLDS.hypsometryMinPct
    && pct <= THRESHOLDS.hypsometryMaxPct;
  return {
    value: pct,
    minH,
    maxH,
    p10,
    p50,
    p90,
    span,
    band,
    spanM: span,
    bandM: band,
    landCells,
    totalCells,
    sampleCount: landCells,
    referencePct,
    pass,
    status: pass ? 'PASS' : 'FAIL',
    detail: `p10 ${formatCommaDecimal(p10, 4)} / p50 ${formatCommaDecimal(p50, 4)} / p90 ${formatCommaDecimal(p90, 4)} / max ${formatCommaDecimal(maxH, 4)}, `
      + `p90−p10 = ${formatCommaDecimal(band, 4)} при размахе ${formatCommaDecimal(span, 4)} `
      + `(суша ${landCells} из ${totalCells}, v=${CANONICAL_V}); ${referenceDetail}`,
  };
}

/**
 * Метрика 12 — гладкость контура воды (порог ≥ 40 % промежуточных значений
 * 0 < mask < 1): доля вершин с 0 < mask < 1 среди всех вершин контурной
 * полосы перехода вода↔суша (где в 4-окрестности есть и < 1, и > 0).
 * Внутри активного гекса опрашивается маска патча (local.waterMask при
 * наличии, иначе семантика terraform_map), снаружи — waterMask/riverMask юбки.
 * Если на участке и юбке нет контура воды (сплошной океан или сплошная суша),
 * метрика возвращает N/A.
 */
function measureWaterContourSmoothness(local, skirt, radiusM) {
  const res = local.meta?.hfRes ?? Worker.HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / res;
  const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * radiusM;
  let localMask;
  if (local.waterMask) {
    localMask = normalizeMaskArray(local.waterMask);
    if (local.riverMask) {
      const rm = normalizeMaskArray(local.riverMask);
      for (let i = 0; i < localMask.length; i++) localMask[i] = Math.max(localMask[i], rm[i]);
    }
  } else {
    localMask = new Float32Array(res * res);
    const tf = local.terraformMap;
    for (let i = 0; i < res * res; i++) {
      const marker = tf[i] ?? 2;
      localMask[i] = (marker === 0 || marker === 1) ? 1 : 0;
    }
  }

  let contourCount = 0;
  let intermediateCount = 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const wx = (x - res / 2) * cellSize;
      const wy = (y - res / 2) * cellSize;
      if (Worker.clusterHexMetric(wx, wy) > apothemM) continue;
      const idx = y * res + x;
      const m = localMask[idx];
      let minN = m;
      let maxN = m;
      if (x > 0) {
        minN = Math.min(minN, localMask[idx - 1]);
        maxN = Math.max(maxN, localMask[idx - 1]);
      }
      if (x + 1 < res) {
        minN = Math.min(minN, localMask[idx + 1]);
        maxN = Math.max(maxN, localMask[idx + 1]);
      }
      if (y > 0) {
        minN = Math.min(minN, localMask[idx - res]);
        maxN = Math.max(maxN, localMask[idx - res]);
      }
      if (y + 1 < res) {
        minN = Math.min(minN, localMask[idx + res]);
        maxN = Math.max(maxN, localMask[idx + res]);
      }
      if (minN < 1 && maxN > 0) {
        contourCount++;
        if (m > 0 && m < 1) intermediateCount++;
      }
    }
  }

  if (skirt && skirt.waterMask && skirt.positions) {
    const angSegs = Worker.SKIRT_ANGULAR_SEGMENTS;
    const angCount = angSegs + 1;
    const radCount = Worker.SKIRT_RADIAL_RINGS + 1;
    const wm = normalizeMaskArray(skirt.waterMask);
    const rm = skirt.riverMask ? normalizeMaskArray(skirt.riverMask) : null;
    const sm = new Float32Array(wm.length);
    for (let i = 0; i < sm.length; i++) sm[i] = rm ? Math.max(wm[i], rm[i]) : wm[i];
    for (let j = 0; j < radCount; j++) {
      for (let i = 0; i < angSegs; i++) {
        const v = j * angCount + i;
        const x = skirt.positions[v * 3];
        const y = skirt.positions[v * 3 + 1];
        if (Worker.clusterHexMetric(x, y) <= apothemM) continue;
        const m = sm[v];
        let minN = m;
        let maxN = m;
        const iPrev = (i - 1 + angSegs) % angSegs;
        const iNext = (i + 1) % angSegs;
        minN = Math.min(minN, sm[j * angCount + iPrev], sm[j * angCount + iNext]);
        maxN = Math.max(maxN, sm[j * angCount + iPrev], sm[j * angCount + iNext]);
        if (j > 0) {
          minN = Math.min(minN, sm[(j - 1) * angCount + i]);
          maxN = Math.max(maxN, sm[(j - 1) * angCount + i]);
        }
        if (j + 1 < radCount) {
          minN = Math.min(minN, sm[(j + 1) * angCount + i]);
          maxN = Math.max(maxN, sm[(j + 1) * angCount + i]);
        }
        if (minN < 1 && maxN > 0) {
          contourCount++;
          if (m > 0 && m < 1) intermediateCount++;
        }
      }
    }
  }

  if (contourCount === 0) {
    return {
      value: null,
      contourCount: 0,
      intermediateCount: 0,
      detail: 'на участке нет контура воды',
    };
  }
  const pct = (intermediateCount / contourCount) * 100;
  return {
    value: pct,
    contourCount,
    intermediateCount,
    detail: `промежуточных вершин (0 < mask < 1): ${intermediateCount} из ${contourCount} вершин контура воды`,
  };
}

function normalizeAngleDeg(deg) {
  let a = deg % 360;
  if (a <= -180) a += 360;
  else if (a > 180) a -= 360;
  return a;
}

function formatSignedCommaDeg(deg, digits = 1) {
  const sign = deg >= 0 ? '+' : '−';
  return `${sign}${formatCommaDecimal(Math.abs(deg), digits)}°`;
}

/**
 * Метрика 13: 16 физических направлений на общей биссектрисе центров A/B.
 * Они проецируются в оба касательных кадра точной ОБРАТНОЙ exp-картой. Старый
 * тест использовал одинаковые координаты с шагом 2·A, хотя реальные центры
 * Голдберга не обязаны лежать на идеальной решётке: он мерил две РАЗНЫЕ точки.
 * Синтетический контроль рампы сохраняет режим идеальной плоской решётки.
 */
function measureHexContinuity(localA, patchA, neighborMap, radiusM, options = {}) {
  const resA = localA.meta?.hfRes ?? Worker.HEIGHTFIELD_RES;
  const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * radiusM;
  const halfEdgeM = apothemM / Math.sqrt(3);
  const rampSlopeK = halfEdgeM > 0 ? 100 / halfEdgeM : 0;
  const slotsA = Worker.mapNeighborCellsToSlots(patchA);
  const azimuthOffsetRad = Number.isFinite(options.azimuthOffsetRad)
    ? options.azimuthOffsetRad
    : ((Number.isFinite(options.azimuthOffsetDeg) ? options.azimuthOffsetDeg : 0) * Math.PI) / 180;
  const useSlotScale = options.useSlotScale === true;
  const syntheticPlane = options.syntheticPlane === true;
  const faces = [];

  for (let slotA = 0; slotA < slotsA.length; slotA++) {
    const cellEntryInA = slotsA[slotA];
    const cellB = cellEntryInA.cell;
    const entryB = neighborMap.get(cellB);
    if (!entryB) continue;
    const slotsB = Worker.mapNeighborCellsToSlots(entryB.patch);
    const slotB = slotsB.findIndex((candidate) => candidate.cell === patchA.centerCell);
    if (slotB < 0) continue;
    const cellEntryInB = slotsB[slotB];

    const tanA = cellTangentMeters(patchA, cellEntryInA);
    const tanB = cellTangentMeters(entryB.patch, cellEntryInB);
    const trueAngA = Math.atan2(tanA.v, tanA.u);
    const trueAngB = Math.atan2(tanB.v, tanB.u);
    const angA = useSlotScale ? (slotA * Math.PI) / 3 : trueAngA + azimuthOffsetRad;
    const angB = useSlotScale ? (slotB * Math.PI) / 3 : trueAngB + azimuthOffsetRad;

    const trueAzimuthADeg = (trueAngA * 180) / Math.PI;
    const trueAzimuthBDeg = (trueAngB * 180) / Math.PI;
    const slotAzimuthADeg = slotA * 60;
    const slotAzimuthBDeg = slotB * 60;
    const slotVsTrueDeg = normalizeAngleDeg(trueAzimuthADeg - slotAzimuthADeg);
    const slotVsTrueBDeg = normalizeAngleDeg(trueAzimuthBDeg - slotAzimuthBDeg);

    // Контроль шкалы на аналитической рампе h = k·x (перепад 100 м на полуребре):
    // при истинной шкале шов равен 0 м, при сдвиге на угол Δφ он растёт пропорционально.
    const dAngTrue = trueAngA + Math.PI - trueAngB;
    const cosDTrue = Math.cos(dAngTrue);
    const sinDTrue = Math.sin(dAngTrue);
    const centerShiftX = 2 * apothemM * Math.cos(trueAngA);

    const resB = entryB.local.meta?.hfRes ?? Worker.HEIGHTFIELD_RES;
    let faceMaxDeltaM = 0;
    let faceRampDeltaM = 0;
    let faceMaxDistanceDeltaM = 0;
    const actualSpacingM = Math.hypot(tanA.u, tanA.v);
    const centerA = patchA.frame.origin;
    const centerB = entryB.patch.frame.origin;
    const mid = centerA.map((v, k) => v + centerB[k]);
    const midLen = Math.hypot(...mid);
    const middle = mid.map((v) => v / midLen);
    const normal = [
      centerA[1] * centerB[2] - centerA[2] * centerB[1],
      centerA[2] * centerB[0] - centerA[0] * centerB[2],
      centerA[0] * centerB[1] - centerA[1] * centerB[0],
    ];
    const nLen = Math.hypot(...normal);
    const alongEdge = normal.map((v) => v / nLen);
    let worstSample = 0;
    for (let p = 0; p < HEX_EDGE_SAMPLES; p++) {
      const s = ((p + 0.5) / HEX_EDGE_SAMPLES - 0.5) * 2 * halfEdgeM;
      let xA, yA, xB, yB;
      if (syntheticPlane) {
        xA = apothemM * Math.cos(angA) - s * Math.sin(angA);
        yA = apothemM * Math.sin(angA) + s * Math.cos(angA);
        const sB = -s;
        xB = apothemM * Math.cos(angB) - sB * Math.sin(angB);
        yB = apothemM * Math.sin(angB) + sB * Math.cos(angB);
      } else {
        // Направление на БИССЕКТРИСЕ A/B: симметрично относительно центров
        // на сфере. Обратные exp-проекции сохраняют ровно тот же физический dir.
        const theta = s / patchA.frame.radiusM;
        const dir = middle.map((v, k) => v * Math.cos(theta) + alongEdge[k] * Math.sin(theta));
        const localA = Geometry.directionToLocalPoint(patchA, dir);
        const localB = Geometry.directionToLocalPoint(entryB.patch, dir);
        xA = localA.u;
        yA = localA.v;
        xB = localB.u;
        yB = localB.v;
        faceMaxDistanceDeltaM = Math.max(
          faceMaxDistanceDeltaM,
          Math.abs(Math.hypot(xA, yA) - Math.hypot(xB, yB)),
        );
      }
      const hA = bilinearHeight(localA.heightfield, resA, radiusM, xA, yA);
      const hB = bilinearHeight(entryB.local.heightfield, resB, radiusM, xB, yB);
      const deltaM = Math.abs(hA - hB);
      if (deltaM > faceMaxDeltaM) {
        faceMaxDeltaM = deltaM;
        worstSample = p;
      }
      const rampHA = rampSlopeK * xA;
      const rampHB = syntheticPlane
        ? rampSlopeK * (centerShiftX + xB * cosDTrue - yB * sinDTrue)
        : rampHA;
      const rampDeltaM = Math.abs(rampHA - rampHB);
      if (rampDeltaM > faceRampDeltaM) faceRampDeltaM = rampDeltaM;
    }
    faces.push({
      slotA,
      cellB,
      slotB,
      angA,
      angB,
      trueAngA,
      trueAngB,
      azimuthADeg: (angA * 180) / Math.PI,
      azimuthBDeg: (angB * 180) / Math.PI,
      trueAzimuthADeg,
      trueAzimuthBDeg,
      slotAzimuthADeg,
      slotAzimuthBDeg,
      slotVsTrueDeg,
      slotVsTrueBDeg,
      rampSeamDeltaM: faceRampDeltaM,
      maxDistanceDeltaM: faceMaxDistanceDeltaM,
      idealApothemDeltaM: actualSpacingM / 2 - apothemM,
      maxDeltaM: faceMaxDeltaM,
      worstSample,
    });
  }

  if (faces.length === 0) {
    return {
      value: null,
      faces: [],
      rampSeamMaxDeltaM: 0,
      azimuthScaleOk: true,
      pass: false,
      status: 'N/A',
      detail: 'нет шестиугольных соседей для сравнения A↔B',
    };
  }
  const worst = faces.reduce((a, b) => (b.maxDeltaM > a.maxDeltaM ? b : a));
  const rampSeamMaxDeltaM = Math.max(...faces.map((f) => f.rampSeamDeltaM));
  const azimuthScaleOk = rampSeamMaxDeltaM <= 0.1;
  const pass = azimuthScaleOk && worst.maxDeltaM <= THRESHOLDS.hexContinuityMaxM
    && faces.every((face) => face.maxDistanceDeltaM <= 1);
  const slotDiffs = faces.map((f) => f.slotVsTrueDeg);
  const minSlotDiff = Math.min(...slotDiffs);
  const maxSlotDiff = Math.max(...slotDiffs);
  const slotDiagText = faces.map((f) => `с${f.slotA}=${formatSignedCommaDeg(f.slotVsTrueDeg, 1)}`).join(', ');
  return {
    value: worst.maxDeltaM,
    faces,
    worst,
    rampSeamMaxDeltaM,
    minSlotVsTrueDeg: minSlotDiff,
    maxSlotVsTrueDeg: maxSlotDiff,
    azimuthScaleOk,
    pass,
    status: pass ? 'PASS' : 'FAIL',
    detail: `худшая грань: слот ${worst.slotA} ↔ сосед ${worst.cellB} (слот ${worst.slotB}), `
      + `${HEX_EDGE_SAMPLES} точек грани, max |Δh| = ${round(worst.maxDeltaM, 2)} м (точка ${worst.worstSample + 1}/${HEX_EDGE_SAMPLES}); `
      + `слот·60° против истинного азимута: ${slotDiagText} (диапазон ${formatSignedCommaDeg(minSlotDiff, 1)}…${formatSignedCommaDeg(maxSlotDiff, 1)}); `
      + `по граням: ${faces.map((f) => `с${f.slotA}(${f.cellB})=${round(f.maxDeltaM, 1)}м`).join(', ')}; `
      + (syntheticPlane
        ? 'синтетическая рампа идеальных центров'
        : `один dir в кадрах A/B; max Δ расстояния до центров = ${round(Math.max(...faces.map((f) => f.maxDistanceDeltaM)), 4)} м; `
          + `отклонение реальной половины шага от апофемы = ${round(worst.idealApothemDeltaM, 1)} м`),
  };
}

/**
 * Контроль шкалы азимутов m.13 на синтетическом поле-рампе h = k·x
 * (k = 100 / halfEdgeM — на полуребре перепад ровно 100 м):
 * строит растры 256×256 для патча A и всех его 6 соседей B так, что вдоль
 * истинного шва высоты совпадают, и вызывает measureHexContinuity.
 * При истинной шкале шов равен 0 ± 0,1 м; при сдвиге шкалы он растёт пропорционально.
 */
function runRampAzimuthControl(patchA, neighborPatches, radiusM = DEFAULT_RADIUS_M, options = {}) {
  const res = options.hfRes ?? LOD_FINE_RES;
  const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * radiusM;
  const halfEdgeM = apothemM / Math.sqrt(3);
  const halfEdgeDropM = options.halfEdgeDropM ?? 100;
  const k = halfEdgeDropM / halfEdgeM;
  const cellSize = (2 * radiusM) / res;

  const hfA = new Float32Array(res * res);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const wx = (x - res / 2) * cellSize;
      hfA[y * res + x] = k * wx;
    }
  }
  const localA = {
    heightfield: hfA,
    meta: { radiusM, hfRes: res, tfRes: res },
  };

  const slotsA = Worker.mapNeighborCellsToSlots(patchA);
  const neighborMap = new Map();
  for (let slotA = 0; slotA < slotsA.length; slotA++) {
    const cellEntryInA = slotsA[slotA];
    const cellB = cellEntryInA.cell;
    const rawEntryB = neighborPatches instanceof Map ? neighborPatches.get(cellB) : neighborPatches[cellB];
    const patchB = rawEntryB?.patch ?? rawEntryB;
    if (!patchB) continue;
    const slotsB = Worker.mapNeighborCellsToSlots(patchB);
    const slotB = slotsB.findIndex((c) => c.cell === patchA.centerCell);
    if (slotB < 0) continue;

    const tanA = cellTangentMeters(patchA, cellEntryInA);
    const tanB = cellTangentMeters(patchB, slotsB[slotB]);
    const trueAngA = Math.atan2(tanA.v, tanA.u);
    const trueAngB = Math.atan2(tanB.v, tanB.u);
    const dAng = trueAngA + Math.PI - trueAngB;
    const cosD = Math.cos(dAng);
    const sinD = Math.sin(dAng);
    const centerShiftX = 2 * apothemM * Math.cos(trueAngA);

    const hfB = new Float32Array(res * res);
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const bx = (x - res / 2) * cellSize;
        const by = (y - res / 2) * cellSize;
        const ax = centerShiftX + bx * cosD - by * sinD;
        hfB[y * res + x] = k * ax;
      }
    }
    neighborMap.set(cellB, {
      patch: patchB,
      local: {
        heightfield: hfB,
        meta: { radiusM, hfRes: res, tfRes: res },
      },
    });
  }

  return measureHexContinuity(localA, patchA, neighborMap, radiusM, { ...options, syntheticPlane: true });
}

/** Среднее межцентровое расстояние dHex (м) до соседей патча (как в buildNeighborRingCells). */
function computePatchHexSpanM(patch) {
  const slots = Worker.mapNeighborCellsToSlots(patch);
  let sumDist = 0;
  let distCount = 0;
  for (const s of slots) {
    const pos = cellTangentMeters(patch, s);
    const d = Math.hypot(pos.u, pos.v);
    if (d > 1) {
      sumDist += d;
      distCount++;
    }
  }
  return distCount > 0 ? sumDist / distCount : patch.frame.radiusM * 0.01;
}

/**
 * Метрика 14 — согласованность LOD (порог ≤ 2 м):
 * сравнивает ОДИН И ТОТ ЖЕ гекс C на разрешении 256×256 (активный центральный
 * heightfield) и на разрешении 64×64 (кольцевой LOD 1 RING_HF_RES[1] = 64 того
 * же гекса C до перехода камеры на него) на ОДИНАКОВОМ физическом span.
 * У центрального кадра и кольцевого LOD 64 физический span = 2·radiusM
 * (≈ 104 км при продуктовом радиусе); обе сетки опрашиваются на общем окне
 * commonSpanM = min(fineSpanM, coarseSpanM) с переводом между 3D кадрами.
 */
function measureLodConsistency(local256, patchC, coarseViews, radiusM) {
  if (!coarseViews || coarseViews.length === 0) {
    return {
      value: null,
      views: [],
      detail: `нет представления гекса на разрешении ${LOD_COARSE_RES}×${LOD_COARSE_RES}`,
    };
  }
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const resFine = local256.meta?.hfRes ?? LOD_FINE_RES;
  const fineSpanM = Number.isFinite(local256.meta?.spanM) && local256.meta.spanM > 0
    ? local256.meta.spanM
    : 2 * (local256.meta?.radiusM ?? radiusM);
  const fineRadiusM = fineSpanM / 2;
  const views = [];

  for (const view of coarseViews) {
    const resCoarse = view.hfRes;
    const coarseSpanM = Number.isFinite(view.spanM) && view.spanM > 0
      ? view.spanM
      : (view.patch ? computePatchHexSpanM(view.patch) : 2 * radiusM);
    const coarseRadiusM = coarseSpanM / 2;
    const commonSpanM = Math.min(fineSpanM, coarseSpanM);
    const cellSizeCommon = commonSpanM / resCoarse;
    const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * (commonSpanM / 2);
    const eNeC = dot3(view.frameEast, patchC.frame.east);
    const eNnC = dot3(view.frameEast, patchC.frame.north);
    const nNeC = dot3(view.frameNorth, patchC.frame.east);
    const nNnC = dot3(view.frameNorth, patchC.frame.north);
    let maxDeltaM = 0;
    let points = 0;
    for (let y = 0; y < resCoarse; y++) {
      for (let x = 0; x < resCoarse; x++) {
        const lx = (x - resCoarse / 2) * cellSizeCommon;
        const ly = (y - resCoarse / 2) * cellSizeCommon;
        if (Worker.clusterHexMetric(lx, ly) > apothemM) continue;
        const cx = lx * eNeC + ly * nNeC;
        const cy = lx * eNnC + ly * nNnC;
        const h64 = coarseSpanM === commonSpanM
          ? view.heightfield[y * resCoarse + x]
          : bilinearHeight(view.heightfield, resCoarse, coarseRadiusM, lx, ly);
        const h256 = bilinearHeight(local256.heightfield, resFine, fineRadiusM, cx, cy);
        const deltaM = Math.abs(h256 - h64);
        if (deltaM > maxDeltaM) maxDeltaM = deltaM;
        points++;
      }
    }
    views.push({
      sourceLabel: view.sourceLabel,
      hfRes: resCoarse,
      fineSpanM,
      coarseSpanM,
      commonSpanM,
      points,
      maxDeltaM,
    });
  }

  const worst = views.reduce((a, b) => (b.maxDeltaM > a.maxDeltaM ? b : a));
  return {
    value: worst.maxDeltaM,
    views,
    worst,
    detail: `LOD ${resFine} против ${worst.hfRes} (ракурс соседа ${worst.sourceLabel}, `
      + `общий span ${round(worst.commonSpanM, 1)} м при span64=${round(worst.coarseSpanM, 1)} м, `
      + `точек в гексе: ${worst.points}): max |Δh| = ${round(worst.maxDeltaM, 2)} м`,
  };
}

/**
 * Вертикальное преувеличение глобуса (только печать, без порога):
 *   суша  GLOBE_RELIEF.landMax · R / ((elevMax − sea) · K)
 *   океан GLOBE_RELIEF.oceanMax · R / ((sea − elevMin) · K)
 *   плюс отношение «океан / суша».
 * Причина: site/shared/planet-globe.ts (GLOBE_RELIEF) нормирует высоту на размах поля,
 * поэтому глобус от смены K не меняется вообще.
 */
function measureGlobeVerticalExaggeration(surface, options = {}) {
  const scaleK = Number.isFinite(options.scaleK) && options.scaleK > 0
    ? options.scaleK
    : DEFAULT_GLOBE_SCALE_K;
  const radiusM = Number.isFinite(options.radiusM) && options.radiusM > 0
    ? options.radiusM
    : ((surface?.radiusKm ?? 6371) * 1000);
  const seaLevel = Number.isFinite(surface?.seaLevel) ? surface.seaLevel : 0;
  const elevationMax = Number.isFinite(surface?.elevationMax) ? surface.elevationMax : 0;
  const elevationMin = Number.isFinite(surface?.elevationMin) ? surface.elevationMin : 0;
  const landSpan = elevationMax - seaLevel;
  const oceanSpan = seaLevel - elevationMin;
  const landExaggeration = landSpan > 0
    ? (GLOBE_LAND_RELIEF_FACTOR * radiusM) / (landSpan * scaleK)
    : 0;
  const oceanExaggeration = oceanSpan > 0
    ? (GLOBE_OCEAN_RELIEF_FACTOR * radiusM) / (oceanSpan * scaleK)
    : 0;
  const oceanToLandRatio = landExaggeration > 0 ? oceanExaggeration / landExaggeration : 0;
  return {
    scaleK,
    radiusM,
    seaLevel,
    elevationMin,
    elevationMax,
    landSpan,
    oceanSpan,
    landExaggeration,
    oceanExaggeration,
    oceanToLandRatio,
    detail: `суша ${formatCommaDecimal(landExaggeration, 1)}×, океан ${formatCommaDecimal(oceanExaggeration, 1)}×, `
      + `отношение океан/суша = ${formatCommaDecimal(oceanToLandRatio, 2)} `
      + `(при K = ${scaleK}, R = ${radiusM} м, sea = ${round(seaLevel, 4)}, `
      + `elevMin = ${round(elevationMin, 4)}, elevMax = ${round(elevationMax, 4)}; `
      + `факторы landMax=${GLOBE_LAND_RELIEF_FACTOR}, oceanMax=${GLOBE_OCEAN_RELIEF_FACTOR}; `
      + `site/shared/planet-globe.ts:GLOBE_RELIEF нормирует высоту на размах поля)`,
  };
}

// ---------------------------------------------------------------------------
// Зона контрольной ячейки (тип местности по канонической Patch7)
// ---------------------------------------------------------------------------

function zoneOf(patch) {
  const center = patch.cells[0];
  if (center.lakeWeight > 0) return 'озеро';
  if (Contract.isWaterCell(center, patch.seaLevel)) return 'океан';
  if (patch.river.inlets.length > 0 || patch.river.outlet) return 'река';
  return 'суша';
}

// ---------------------------------------------------------------------------
// Сборка таблицы
// ---------------------------------------------------------------------------

const METRIC_TITLES = {
  bankStep: 'ступень кромки русла',
  riverDepth: 'глубина воды в центре русла',
  continuity: 'непрерывность русла через грань',
  texture: 'фактура рельефа (RMS колец)',
  landStep: 'перепад вершин на суше',
  waterDepth: 'перепад waterDepthM патч/юбка',
  carveArea: 'доля площади гекса под врезом',
  landRelief: 'размах суши / ширина кадра',
  oceanRelief: 'размах океанского дна',
  meanSlope: 'средний уклон',
  hypsometry: 'гипсометрия p90−p10',
  waterContour: 'гладкость контура воды',
  hexContinuity: 'непрерывность A↔B',
  lodConsistency: 'согласованность LOD',
};

function metricRow(cell, zone, metric, value, valueText, threshold, status, detail) {
  // Неприменимая метрика не имеет значения: null, а не 0 (чтобы «нет данных»
  // нельзя было спутать с «измерено ноль»).
  return {
    cell,
    zone,
    metric,
    value: status === 'N/A' ? null : value,
    valueText: status === 'N/A' ? '—' : valueText,
    threshold,
    status,
    detail,
  };
}

/**
 * Единая запись строк метрик 8–14 (используется и основным прогоном стенда,
 * и негативным контролем на плоской синтетической фикстуре).
 */
function buildFormAndContinuityRows({
  cell,
  zone,
  local,
  skirt,
  patch,
  neighborMap,
  coarseViews,
  radiusM,
  planetSurface,
  planetElevation,
  hypsoReferencePct,
}) {
  const rows = [];

  // --- Метрика 8: размах суши / ширина кадра ---
  const landRelief = measureLandRelief(local, radiusM);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.landRelief,
    landRelief.value === null ? null : round(landRelief.value, 3),
    landRelief.value === null ? '—' : `${landRelief.value.toFixed(2)} %`,
    '3…8 %',
    landRelief.value === null
      ? 'N/A'
      : (landRelief.value >= THRESHOLDS.landReliefMinPct && landRelief.value <= THRESHOLDS.landReliefMaxPct ? 'PASS' : 'FAIL'),
    landRelief.detail,
  ));

  // --- Метрика 9: размах океанского дна ---
  const oceanRelief = measureOceanRelief(local, patch, radiusM);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.oceanRelief,
    oceanRelief.value === null ? null : round(oceanRelief.value, 3),
    oceanRelief.value === null ? '—' : `${oceanRelief.value.toFixed(2)} %`,
    '≥ 1 %',
    oceanRelief.value === null
      ? 'N/A'
      : (oceanRelief.value >= THRESHOLDS.oceanReliefMinPct ? 'PASS' : 'FAIL'),
    oceanRelief.detail,
  ));

  // --- Метрика 10: средний уклон ---
  const meanSlope = measureMeanSlope(local, radiusM);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.meanSlope,
    round(meanSlope.value, 3), `${meanSlope.value.toFixed(2)} %`,
    '≥ 4 %',
    meanSlope.value >= THRESHOLDS.meanSlopeMinPct ? 'PASS' : 'FAIL',
    meanSlope.detail,
  ));

  // --- Метрика 11: гипсометрия p90−p10 (по суше elev > seaLevel всей планеты v=128) ---
  const hypsometry = measureHypsometry(planetSurface ?? planetElevation ?? local, { hypsoReferencePct });
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.hypsometry,
    round(hypsometry.value, 2), `${hypsometry.value.toFixed(2)} %`,
    '20…35 %',
    hypsometry.pass ? 'PASS' : 'FAIL',
    hypsometry.detail,
  ));

  // --- Метрика 12: гладкость контура воды ---
  const waterContour = measureWaterContourSmoothness(local, skirt, radiusM);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.waterContour,
    waterContour.value === null ? null : round(waterContour.value, 2),
    waterContour.value === null ? '—' : `${waterContour.value.toFixed(1)} %`,
    '≥ 40 %',
    waterContour.value === null
      ? 'N/A'
      : (waterContour.value >= THRESHOLDS.waterContourSmoothMinPct ? 'PASS' : 'FAIL'),
    waterContour.detail,
  ));

  // --- Метрика 13: непрерывность A↔B ---
  const hexContinuity = measureHexContinuity(local, patch, neighborMap, radiusM);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.hexContinuity,
    hexContinuity.value === null ? null : round(hexContinuity.value, 3),
    hexContinuity.value === null ? '—' : `${round(hexContinuity.value, 2)} м`,
    '≤ 1 м',
    hexContinuity.value === null
      ? 'N/A'
      : (hexContinuity.pass ? 'PASS' : 'FAIL'),
    hexContinuity.detail,
  ));

  // --- Метрика 14: согласованность LOD (256 против 64) ---
  const lodConsistency = measureLodConsistency(local, patch, coarseViews, radiusM);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.lodConsistency,
    lodConsistency.value === null ? null : round(lodConsistency.value, 3),
    lodConsistency.value === null ? '—' : `${round(lodConsistency.value, 2)} м`,
    '≤ 2 м',
    lodConsistency.value === null
      ? 'N/A'
      : (lodConsistency.value <= THRESHOLDS.lodConsistencyMaxM ? 'PASS' : 'FAIL'),
    lodConsistency.detail,
  ));

  return rows;
}

async function getOrBuildCellEntry(cellCache, grid, surface, world, cell, radiusM) {
  const cacheKey = `${cell}:${radiusM}`;
  if (cellCache.has(cacheKey)) return cellCache.get(cacheKey);
  if (grid.neighborCount[cell] !== 6) return null;
  const patch = Contract.buildPatch7(grid, surface, cell);
  const request = {
    patch,
    seed: world.seed,
    placeId: PLACE_ID,
    radiusM,
    profile: world.profile,
    neighborRings: 1,
    patchKey: `stand-${world.label}-${cell}-r${radiusM}`,
  };
  Worker.clearLocalMapCache();
  const local = await Worker.generateLocalMap(request);
  const entry = { patch, request, local };
  cellCache.set(cacheKey, entry);
  return entry;
}

async function measureCell(grid, surface, world, cell, radiusM, cellCache = new Map(), options = {}) {
  const centerEntry = await getOrBuildCellEntry(cellCache, grid, surface, world, cell, radiusM);
  const { patch, request, local } = centerEntry;
  const windowEntry = radiusM === RELIEF_WINDOW_RADIUS_M
    ? centerEntry
    : await getOrBuildCellEntry(cellCache, grid, surface, world, cell, RELIEF_WINDOW_RADIUS_M);
  const localForForm = radiusM === RELIEF_WINDOW_RADIUS_M
    ? local
    : { ...local, windowLocal: windowEntry?.local };
  const skirt = await Worker.generateHorizonSkirt(request, local.heightfield);
  const zone = zoneOf(patch);
  const rows = [];

  // Соседние гексы B (тем же generateLocalMap) для метрик 13 (A↔B) и 14 (LOD 64).
  const neighborMap = new Map();
  const coarseViews = [];
  const centerDir = patch.cells[0].center;
  for (let k = 1; k < patch.cells.length; k++) {
    const nbCell = patch.cells[k].cell;
    const nbEntry = await getOrBuildCellEntry(cellCache, grid, surface, world, nbCell, radiusM);
    if (!nbEntry) continue;
    neighborMap.set(nbCell, nbEntry);
    if (nbEntry.local.ringCells) {
      const ring64 = nbEntry.local.ringCells.find((rc) => (
        rc.ring === 1
        && rc.hfRes === LOD_COARSE_RES
        && Math.hypot(
          rc.center[0] - centerDir[0],
          rc.center[1] - centerDir[1],
          rc.center[2] - centerDir[2],
        ) < 1e-5
      ));
      if (ring64) {
        coarseViews.push({
          sourceLabel: String(nbCell),
          frameEast: nbEntry.patch.frame.east,
          frameNorth: nbEntry.patch.frame.north,
          hfRes: ring64.hfRes,
          spanM: ring64.spanM ?? computePatchHexSpanM(nbEntry.patch),
          heightfield: ring64.heightfield,
        });
      }
    }
  }

  // --- Поле вреза воркера: общее для метрик 1, 2 (применимость), 3 и 7 ---
  const carveField = buildRiverCarveField(patch, radiusM);

  // --- Метрики 1–2: русло по канонической топологии Patch7 ---
  // Применимость определяет поле вреза: если carve = 0 на всех профилях,
  // врезанного русла нет и обе метрики — N/A (а не ступень 0 м / глубина 0 м:
  // несуществующую реку нельзя ни «пропустить», ни «завалить»).
  const axes = riverAxes(patch);
  if (axes.length === 0) {
    rows.push(metricRow(cell, zone, METRIC_TITLES.bankStep, null, '—', '≤ 2 м', 'N/A', 'в Patch7 нет русла'));
    rows.push(metricRow(cell, zone, METRIC_TITLES.riverDepth, null, '—', '3…12 м / ≥ 3 м', 'N/A', 'в Patch7 нет русла'));
  } else {
    const measuredAxes = axes.map((axis) => {
      const crossSection = riverCrossSection(patch, radiusM, axis, carveField.halfWidthM);
      return {
        axis,
        crossSection,
        bank: measureBankStep(local, crossSection, carveField),
        depth: measureRiverDepth(local, crossSection),
      };
    });
    const carvedAxes = measuredAxes.filter((entry) => entry.bank.value !== null);
    if (carvedAxes.length === 0) {
      const profileCount = measuredAxes.reduce((sum, entry) => sum + entry.bank.profileCount, 0);
      const noCarveDetail = `carve = 0 на всём профиле: вершин в области вреза 0 из ${profileCount} `
        + `(сегментов русла: ${carveField.segments.length}) — врезанного русла нет`;
      rows.push(metricRow(cell, zone, METRIC_TITLES.bankStep, null, '—', '≤ 2 м', 'N/A', noCarveDetail));
      rows.push(metricRow(cell, zone, METRIC_TITLES.riverDepth, null, '—', '3…12 м / ≥ 3 м', 'N/A', noCarveDetail));
    } else {
      let worst = carvedAxes[0];
      // Худшая ось по глубине — не «самая мелкая», а худшая в СВОЕЙ ветви:
      // сначала любая красная ось (по наибольшему выходу за порог ветви),
      // иначе ось с наименьшим запасом до границы своей ветви. Так морская
      // глубина 31 м (PASS) не маскирует речной каньон 18 м (FAIL) и наоборот.
      let worstDepth = carvedAxes[0];
      for (const entry of carvedAxes) {
        if (entry.bank.value > worst.bank.value) worst = entry;
        const candidate = entry.depth;
        const current = worstDepth.depth;
        const candidateWorse = candidate.pass !== current.pass
          ? !candidate.pass
          : !candidate.pass
            ? candidate.violation > current.violation
            : candidate.margin < current.margin;
        if (candidateWorse) worstDepth = entry;
      }
      rows.push(metricRow(
        cell, zone, METRIC_TITLES.bankStep, round(worst.bank.value), `${round(worst.bank.value, 2)} м`, '≤ 2 м',
        worst.bank.value <= THRESHOLDS.bankStepM ? 'PASS' : 'FAIL',
        `худшая грань: ${worst.axis.kind} (слот ${worst.axis.slot}); ${worst.bank.detail}`,
      ));
      const depth = worstDepth.depth;
      rows.push(metricRow(
        cell, zone, METRIC_TITLES.riverDepth, round(depth.value), `${round(depth.value, 2)} м`,
        depth.thresholdText,
        depth.pass ? 'PASS' : 'FAIL',
        `${worstDepth.axis.kind} (слот ${worstDepth.axis.slot}), ${depth.branchLabel}: ${depth.detail}`
          + (carvedAxes.length > 1 ? `; осей с врезом: ${carvedAxes.length}, статус — по худшей оси в её ветви` : ''),
      ));
    }
  }

  // --- Метрика 3: непрерывность воды в фактических створах ---
  const continuity = measureFaceContinuity(local, skirt, patch, radiusM, carveField);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.continuity,
    continuity.value, continuity.value === null ? '—' : `${continuity.value}/${continuity.total} ${gateWord(continuity.total)}`,
    '100 % створов',
    continuity.value === null
      ? 'N/A'
      : (continuity.value / continuity.total >= THRESHOLDS.continuityFraction ? 'PASS' : 'FAIL'),
    continuity.detail,
  ));

  // --- Метрика 4: фактура рельефа ---
  const texture = measureTexture(local, skirt, radiusM);
  const textureOk = texture.pairs.every(
    (pair) => pair.ratio >= THRESHOLDS.textureRatioMin && pair.ratio <= THRESHOLDS.textureRatioMax,
  );
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.texture, round(texture.value, 3), `${texture.value.toFixed(2)}×`,
    '0,70…1,30×', textureOk ? 'PASS' : 'FAIL', texture.detail,
  ));

  // --- Метрика 5: перепад вершин на суше ---
  const land = measureLandStep(local);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.landStep, round(land.value), `${round(land.value, 2)} м`, '≤ 6 м',
    land.landTexels === 0 ? 'N/A' : (land.value <= THRESHOLDS.landStepM ? 'PASS' : 'FAIL'),
    land.landTexels === 0 ? 'на участке нет суши' : land.detail,
  ));

  // --- Метрика 6: перепад waterDepthM патч/юбка ---
  const waterDepth = measureWaterDepthDelta(local, skirt, radiusM);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.waterDepth, round(waterDepth.value), `${round(waterDepth.value, 3)} м`,
    '≤ 0,5 м',
    !waterDepth.hasWater ? 'N/A' : (waterDepth.value <= THRESHOLDS.waterDepthDeltaM ? 'PASS' : 'FAIL'),
    waterDepth.hasWater ? waterDepth.detail : 'на стыке нет воды',
  ));

  // --- Метрика 7: доля площади гекса под врезом ---
  const carveArea = measureCarveArea(carveField, radiusM);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.carveArea, round(carveArea.value, 2), `${carveArea.value.toFixed(1)} %`,
    '≤ 12 %',
    carveArea.value <= THRESHOLDS.carveAreaMaxPct ? 'PASS' : 'FAIL',
    carveArea.detail,
  ));

  // --- Метрики 8–14: форма и сквозная непрерывность ---
  rows.push(...buildFormAndContinuityRows({
    cell,
    zone,
    local: localForForm,
    skirt,
    patch,
    neighborMap,
    coarseViews,
    radiusM,
    planetSurface: surface,
    planetElevation: surface.elevation,
    hypsoReferencePct: options.hypsoReferencePct,
  }));

  return rows;
}

// ---------------------------------------------------------------------------
// Негативный контроль (правило 2): синтетический плоский heightfield (h = const)
// ---------------------------------------------------------------------------

/** Кэш неизменяемой канонической геодезической сетки и поверхности мира. */
let cachedGrid = null;
const cachedSurfaces = new Map();

function getCanonicalGrid() {
  if (!cachedGrid) cachedGrid = GeodesicGrid.build(CANONICAL_V);
  return cachedGrid;
}

function getWorldSurface(worldName) {
  if (!cachedSurfaces.has(worldName)) {
    const world = WORLDS[worldName];
    if (!world) throw new Error(`Неизвестный профиль: ${worldName}`);
    cachedSurfaces.set(worldName, PlanetSurface.generateSurface(getCanonicalGrid(), world.profile));
  }
  return cachedSurfaces.get(worldName);
}

/**
 * Прогоняет все семь новых метрик (m.8…m.14) на заведомо плоской синтетической
 * фикстуре с постоянной высотой heightfield (h = constantHeightM всюду: на
 * активном гексе A 256×256, на всех 6 соседних гексах B 256×256, на грубом LOD
 * 64×64 и на юбке) и ступенчатой границей вода/суша (x < 0 — океан 0, x >= 0 —
 * суша TERRAFORM_LAND_MIN = 2), чтобы ни одна из 7 метрик не ушла в N/A.
 */
export function runFlatFixtureControl(options = {}) {
  const radiusM = options.radiusM ?? DEFAULT_RADIUS_M;
  const constantHeightM = options.constantHeightM ?? 0;
  const neighborHeightOffsetM = options.neighborHeightOffsetM ?? 0;
  const lodHeightOffsetM = options.lodHeightOffsetM ?? 0;
  const cell = options.cell ?? 137390;
  const grid = getCanonicalGrid();
  const surface = getWorldSurface('a29');
  const basePatch = Contract.buildPatch7(grid, surface, cell);
  // В плоской фикстуре исключаем озёрную поправку, чтобы левая половина x < 0
  // честно попадала в океанское дно, а правая x >= 0 — в сушу.
  const patch = {
    ...basePatch,
    cells: basePatch.cells.map((c) => ({ ...c, lakeId: -1, lakeWeight: 0 })),
  };

  const res = LOD_FINE_RES;
  const heightfield = new Float32Array(res * res).fill(constantHeightM);
  const terraformMap = new Uint8Array(res * res);
  const landMarker = Worker.TERRAFORM_LAND_MIN ?? 2;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      terraformMap[y * res + x] = x < res / 2 ? 0 : landMarker;
    }
  }
  const local = {
    heightfield,
    terraformMap,
    meta: { radiusM, hfRes: res, tfRes: res },
  };

  // Плоская полярная юбка с той же постоянной высотой и бинарной маской воды.
  const angSegs = Worker.SKIRT_ANGULAR_SEGMENTS;
  const angCount = angSegs + 1;
  const radCount = Worker.SKIRT_RADIAL_RINGS + 1;
  const innerR = Worker.SKIRT_INNER_RADIUS_RATIO * radiusM;
  const outerR = Worker.SKIRT_OUTER_SPACING_RATIO * Worker.SKIRT_HEX_SPACING_RATIO * radiusM;
  const positions = new Float32Array(angCount * radCount * 3);
  const skirtWaterMask = new Uint8Array(angCount * radCount);
  const skirtRiverMask = new Uint8Array(angCount * radCount);
  for (let j = 0; j < radCount; j++) {
    const r = innerR + (outerR - innerR) * (j / Worker.SKIRT_RADIAL_RINGS);
    for (let i = 0; i < angCount; i++) {
      const phi = (i / angSegs) * Math.PI * 2;
      const x = r * Math.cos(phi);
      const y = r * Math.sin(phi);
      const v = j * angCount + i;
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = constantHeightM;
      skirtWaterMask[v] = x < 0 ? 255 : 0;
    }
  }
  const skirt = {
    positions,
    waterMask: skirtWaterMask,
    riverMask: skirtRiverMask,
  };

  // Все 6 соседних гексов B и грубый LOD 64×64 по умолчанию имеют ту же
  // постоянную высоту h = constantHeightM (чистая плоская плита h ≡ const).
  const neighborMap = new Map();
  for (let k = 1; k < patch.cells.length; k++) {
    const nbCell = patch.cells[k].cell;
    if (grid.neighborCount[nbCell] !== 6) continue;
    const nbPatch = Contract.buildPatch7(grid, surface, nbCell);
    neighborMap.set(nbCell, {
      patch: nbPatch,
      local: {
        heightfield: new Float32Array(res * res).fill(constantHeightM + neighborHeightOffsetM),
        terraformMap: new Uint8Array(res * res).fill(landMarker),
        meta: { radiusM, hfRes: res, tfRes: res },
      },
    });
  }

  const coarseViews = [{
    sourceLabel: 'flat-64',
    frameEast: patch.frame.east,
    frameNorth: patch.frame.north,
    hfRes: LOD_COARSE_RES,
    spanM: options.coarseSpanM ?? computePatchHexSpanM(patch),
    heightfield: new Float32Array(LOD_COARSE_RES * LOD_COARSE_RES).fill(constantHeightM + lodHeightOffsetM),
  }];

  const flatPlanetElevation = options.planetElevation
    ?? new Float32Array(grid.cellCount).fill(constantHeightM);
  const flatPlanetSurface = options.planetSurface ?? {
    elevation: flatPlanetElevation,
    seaLevel: constantHeightM - 1,
  };

  const rows = buildFormAndContinuityRows({
    cell,
    zone: 'плоская фикстура',
    local,
    skirt,
    patch,
    neighborMap,
    coarseViews,
    radiusM,
    planetSurface: flatPlanetSurface,
    planetElevation: flatPlanetElevation,
    hypsoReferencePct: options.hypsoReferencePct,
  });
  const summary = summarizeRows(rows);
  return {
    tool: 'stand_local_map',
    mode: 'flat-fixture',
    cell,
    constantHeightM,
    radiusM,
    thresholds: { ...THRESHOLDS },
    rows,
    summary,
    gate: options.gate === true,
    gatePassed: gateExitCode(summary) === 0,
  };
}

// ---------------------------------------------------------------------------
// Печать
// ---------------------------------------------------------------------------

function formatTable(rows, summary) {
  const header = ['ячейка', 'зона', 'метрика', 'значение', 'порог', 'статус'];
  const table = [header, ...rows.map((row) => [
    String(row.cell),
    row.zone,
    row.metric,
    row.valueText,
    row.threshold,
    row.status,
  ])];
  table.push([
    'SUMMARY',
    '—',
    '—',
    '—',
    '—',
    `FAIL: ${summary.fail} (FAIL ${summary.fail} / PASS ${summary.pass} / N/A ${summary.na})`,
  ]);
  const widths = header.map((_, column) => Math.max(...table.map((line) => line[column].length)));
  const lines = table.map((line) => line
    .map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])))
    .join('  '));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Публичный API стенда (используется тестом tests/local-map-stand.test.mjs)
// ---------------------------------------------------------------------------

/** Сводка по таблице: сколько PASS / FAIL / N/A и какие метрики красные. */
export function summarizeRows(rows) {
  const summary = {
    total: rows.length,
    pass: rows.filter((row) => row.status === 'PASS').length,
    fail: rows.filter((row) => row.status === 'FAIL').length,
    na: rows.filter((row) => row.status === 'N/A').length,
  };
  summary.failedMetrics = [...new Set(rows.filter((row) => row.status === 'FAIL').map((row) => row.metric))];
  summary.failCount = summary.fail;
  return summary;
}

/** Код возврата гейта: 1 при красной метрике, 0 при полном PASS. */
export function gateExitCode(summary) {
  return summary.fail > 0 ? 1 : 0;
}

/**
 * Полный прогон стенда: таблица метрик по всем контрольным ячейкам.
 * Опции: { world: 'a29' | 'a17', radiusM: число, hypsoReferencePct: число | null }.
 */
export async function runStand(options = {}) {
  const worldName = options.world ?? 'a29';
  const world = WORLDS[worldName];
  if (!world) throw new Error(`Неизвестный профиль: ${worldName}`);
  const radiusM = options.radiusM ?? DEFAULT_RADIUS_M;
  const grid = getCanonicalGrid();
  const surface = getWorldSurface(worldName);
  const cellCache = new Map();
  const rows = [];
  for (const cell of CONTROL_CELLS) {
    rows.push(...await measureCell(grid, surface, world, cell, radiusM, cellCache, options));
  }
  const summary = summarizeRows(rows);
  const globeVerticalExaggeration = measureGlobeVerticalExaggeration(surface, {
    scaleK: options.scaleK,
  });
  return {
    tool: 'stand_local_map',
    world: worldName,
    worldLabel: world.label,
    radiusM,
    canonicalV: CANONICAL_V,
    controlCells: [...CONTROL_CELLS],
    riverCarveSource: RIVER_CARVE_SOURCE,
    thresholds: { ...THRESHOLDS },
    globeVerticalExaggeration,
    rows,
    summary,
    gate: options.gate === true,
    gatePassed: gateExitCode(summary) === 0,
  };
}

export {
  CONTROL_CELLS,
  THRESHOLDS,
  WORLDS,
  METRIC_TITLES,
  DEFAULT_RADIUS_M,
  RELIEF_WINDOW_WIDTH_M,
  RELIEF_WINDOW_RADIUS_M,
  CANONICAL_V,
  CARVE_AREA_GRID,
  CARVE_AREA_RADIUS_RATIO,
  HEX_EDGE_SAMPLES,
  LOD_FINE_RES,
  LOD_COARSE_RES,
  RIVER_CARVE_SOURCE,
  HYPSO_EARTH_REFERENCE_PCT,
  HYPSO_DOMAIN_REFERENCE_PCT,
  HYPSO_PREV_THRESHOLD_PCT,
  GLOBE_LAND_RELIEF_FACTOR,
  GLOBE_OCEAN_RELIEF_FACTOR,
  DEFAULT_GLOBE_SCALE_K,
  cellTangentMeters,
  computePatchHexSpanM,
  runRampAzimuthControl,
  measureLandRelief,
  measureOceanRelief,
  measureMeanSlope,
  measureHypsometry,
  measureWaterContourSmoothness,
  measureHexContinuity,
  measureLodConsistency,
  measureGlobeVerticalExaggeration,
  formatTable,
  parseArgs,
  usage,
};

// ---------------------------------------------------------------------------
// Главный сценарий (только при запуске как CLI)
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  const report = options.flatFixture
    ? runFlatFixtureControl({
        radiusM: options.radiusM,
        constantHeightM: options.flatHeightM,
        hypsoReferencePct: options.hypsoReferencePct,
        gate: options.gate,
      })
    : await runStand(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (options.flatFixture) {
    console.log(`STAND_LOCAL_MAP mode=flat-fixture h=${report.constantHeightM}m radiusM=${report.radiusM}`);
    console.log(formatTable(report.rows, report.summary));
    if (report.summary.failedMetrics.length > 0) {
      console.log(`Красные метрики: ${report.summary.failedMetrics.join(', ')}`);
    }
  } else {
    console.log(`STAND_LOCAL_MAP мир=${report.worldLabel} radiusM=${report.radiusM} v=${report.canonicalV}`);
    console.log(formatTable(report.rows, report.summary));
    if (report.globeVerticalExaggeration) {
      console.log(`Вертикальное преувеличение глобуса (без порога): ${report.globeVerticalExaggeration.detail}`);
    }
    if (report.summary.failedMetrics.length > 0) {
      console.log(`Красные метрики: ${report.summary.failedMetrics.join(', ')}`);
    }
  }
  process.exit(options.gate ? gateExitCode(report.summary) : 0);
}
