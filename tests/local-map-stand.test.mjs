/* Тест измерительного стенда локальной карты (Stage-8.14 / W23).
   Большинство метрик проверяются на вычислимость/отрицательные контроли, а
   W23 дополнительно закрепляет физическую геометрию 6 соседей, общее поле
   65²/256² и пороги m.8/m.9 на 40 детерминированных морских пятнах.
   Старые golden из tests/local-map-stage8.test.mjs здесь не переписываются.

   Запуск: node --test tests/local-map-stand.test.mjs
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;
const PlanetElevationField = require('../site/shared/planet-elevation-field.ts');
const { GLOBE_CELL_SCALE, GLOBE_RELIEF } = require('../site/shared/planet-globe.ts');
const Geometry = require('../src/local-map/local-map-geometry.ts');
const Heightfield = require('../src/local-map/local-map-heightfield.ts');
const Contract = require('../src/local-map/local-map-contract.ts');
const Worker = require('../src/local-map/local-map-worker.ts');

const TOOL_PATH = fileURLToPath(new URL('../tools/stand_local_map.mjs', import.meta.url));

/** Публичный API стенда: тест меряет тем же кодом, что и CLI. */
const stand = await import(TOOL_PATH);

/** Число метрик стенда: 7 исходных (Stage-8.12d) + 7 новых (Stage-8.14, шаг 1). */
const METRIC_COUNT = 14;

/** Разумные пределы значений метрик (на порядки больше ожидаемых величин). */
const VALUE_LIMITS = {
  'ступень кромки русла': 1000,
  'глубина воды в центре русла': 20000,
  // Створов не больше, чем граней у гекса.
  'непрерывность русла через грань': 6,
  'фактура рельефа (RMS колец)': 100,
  'перепад вершин на суше': 1000,
  'перепад waterDepthM патч/юбка': 1000,
  'доля площади гекса под врезом': 100,
  'размах суши / ширина кадра': 500,
  'размах океанского дна': 500,
  'средний уклон': 1000,
  'гипсометрия p90−p10': 100,
  'гладкость контура воды': 100,
  'непрерывность A↔B': 20000,
  'согласованность LOD': 20000,
};

const report = await stand.runStand({ world: 'a29' });

test('стенд: конфигурация измерений зафиксирована владельцем', () => {
  assert.deepEqual(
    stand.CONTROL_CELLS,
    [37488, 37518, 37548, 37519, 137363, 137390, 137436],
    'список контрольных ячеек не меняется',
  );
  assert.equal(stand.THRESHOLDS.bankStepM, 2, 'ступень кромки русла ≤ 2 м (только область вреза)');
  assert.equal(stand.THRESHOLDS.riverDepthM, 3, 'глубина воды в центре русла: минимум диапазона 3 м');
  assert.equal(stand.THRESHOLDS.riverDepthMaxM, 12, 'глубина воды в центре русла: потолок диапазона 12 м');
  assert.equal(stand.THRESHOLDS.continuityFraction, 1, 'непрерывность: 100 % фактических створов');
  assert.equal(stand.THRESHOLDS.textureRatioMin, 0.7, 'коридор фактуры: 0,7…');
  assert.equal(stand.THRESHOLDS.textureRatioMax, 1.3, 'коридор фактуры: …1,3');
  assert.equal(stand.THRESHOLDS.landStepM, 6, 'перепад вершин на суше ≤ 6 м');
  assert.equal(stand.THRESHOLDS.waterDepthDeltaM, 0.5, 'перепад waterDepthM ≤ 0,5 м');
  assert.equal(stand.THRESHOLDS.carveAreaMaxPct, 12, 'доля площади гекса под врезом ≤ 12 %');
  assert.equal(stand.CARVE_AREA_GRID, 44, 'метрика 7: сетка 44×44');
  assert.equal(stand.CARVE_AREA_RADIUS_RATIO, 0.95, 'метрика 7: радиус 0,95·R');
  // W23: обновлены только m.8/m.9; остальные пороги m.10…m.14 не смягчаются.
  assert.equal(stand.THRESHOLDS.landReliefMinPct, 3, 'm.8 размах суши: минимум 3 %');
  assert.equal(stand.THRESHOLDS.landReliefMaxPct, 8, 'm.8 размах суши: максимум 8 %');
  assert.equal(stand.THRESHOLDS.oceanReliefMinPct, 1, 'm.9 размах океанского дна ≥ 1 %');
  assert.equal(stand.THRESHOLDS.meanSlopeMinPct, 4, 'm.10 средний уклон ≥ 4 %');
  assert.equal(stand.THRESHOLDS.hypsometryMinPct, 20, 'm.11 гипсометрия p90−p10: минимум полосы 20 %');
  assert.equal(stand.THRESHOLDS.hypsometryMaxPct, 35, 'm.11 гипсометрия p90−p10: потолок полосы 35 %');
  assert.equal(stand.THRESHOLDS.waterContourSmoothMinPct, 40, 'm.12 гладкость контура воды ≥ 40 %');
  assert.equal(stand.THRESHOLDS.hexContinuityMaxM, 1, 'm.13 непрерывность A↔B ≤ 1 м');
  assert.equal(stand.THRESHOLDS.lodConsistencyMaxM, 2, 'm.14 согласованность LOD ≤ 2 м');
  assert.equal(stand.HEX_EDGE_SAMPLES, 16, 'm.13: ровно 16 точек вдоль грани гекса');
  assert.equal(stand.LOD_FINE_RES, 256, 'm.14: детальный LOD 256');
  assert.equal(stand.LOD_COARSE_RES, 64, 'm.14: грубый LOD 64');
});

test('стенд: таблица покрывает все 7 контрольных ячеек и все 14 метрик', () => {
  assert.equal(report.rows.length, stand.CONTROL_CELLS.length * METRIC_COUNT);
  const metrics = new Set();
  for (const cell of stand.CONTROL_CELLS) {
    const rows = report.rows.filter((row) => row.cell === cell);
    assert.equal(rows.length, METRIC_COUNT, `у ячейки ${cell} ровно ${METRIC_COUNT} метрик`);
    assert.equal(new Set(rows.map((row) => row.metric)).size, METRIC_COUNT, `метрики ячейки ${cell} не повторяются`);
    for (const row of rows) metrics.add(row.metric);
  }
  assert.equal(metrics.size, METRIC_COUNT, 'в таблице четырнадцать разных метрик');
  assert.deepEqual(
    [...metrics].sort(),
    Object.keys(VALUE_LIMITS).sort(),
    'набор метрик соответствует заданным владельцем',
  );
});

test('стенд: каждая строка таблицы заполнена и имеет валидный статус', () => {
  for (const row of report.rows) {
    assert.equal(typeof row.cell, 'number');
    assert.ok(row.zone.length > 0, `у ячейки ${row.cell} есть зона`);
    assert.ok(row.metric.length > 0);
    assert.ok(row.threshold.length > 0, `у метрики ${row.metric} есть порог`);
    assert.ok(row.valueText.length > 0);
    assert.ok(['PASS', 'FAIL', 'N/A'].includes(row.status), `статус ${row.status} допустим`);
    if (row.status === 'N/A') {
      assert.equal(row.value, null, 'неприменимая метрика не имеет значения');
    } else {
      assert.equal(typeof row.value, 'number');
    }
  }
});

test('стенд: значения метрик конечны и лежат в разумных пределах', () => {
  for (const row of report.rows) {
    if (row.value === null) continue;
    assert.ok(Number.isFinite(row.value), `${row.metric}: значение конечно (${row.value})`);
    assert.ok(row.value >= 0, `${row.metric}: значение неотрицательно (${row.value})`);
    const limit = VALUE_LIMITS[row.metric];
    assert.ok(limit !== undefined, `у метрики ${row.metric} есть предел проверки`);
    assert.ok(row.value <= limit, `${row.metric}: значение ${row.value} в пределах ${limit}`);
  }
});

test('стенд: непрерывность через грань измеряется целым числом фактических створов', () => {
  const rows = report.rows.filter((row) => row.metric === 'непрерывность русла через грань');
  assert.equal(rows.length, stand.CONTROL_CELLS.length);
  for (const row of rows) {
    if (row.status === 'N/A') {
      assert.equal(row.value, null, 'нет створов — нет значения, а не 0/0');
      continue;
    }
    assert.ok(Number.isInteger(row.value), 'число непрерывных створов — целое');
    const match = /^(\d+)\/(\d+) створ/.exec(row.valueText);
    assert.ok(match, `значение имеет формат «2/2 створа» (получено: ${row.valueText})`);
    assert.equal(Number(match[1]), row.value, 'числитель равен числу непрерывных створов');
    const total = Number(match[2]);
    assert.ok(total >= 1 && total <= 6, 'знаменатель — число створов, не больше граней гекса');
    assert.ok(row.value <= total, 'непрерывных створов не больше всех створов');
  }
});

test('стенд: доля площади под врезом измерима на каждой ячейке и выражена в процентах', () => {
  const rows = report.rows.filter((row) => row.metric === 'доля площади гекса под врезом');
  assert.equal(rows.length, stand.CONTROL_CELLS.length);
  for (const row of rows) {
    assert.notEqual(row.status, 'N/A', 'метрика 7 применима всегда: нет вреза — честные 0 %');
    assert.ok(row.value >= 0 && row.value <= 100, `доля в пределах 0…100 % (${row.value})`);
    assert.match(row.valueText, /%/, 'значение выражено в процентах');
    assert.match(row.detail, /точек с carve > 0: \d+ из 1936/, 'в detail — счётчик точек сетки 44×44');
  }
});

test('стенд: ступень кромки сообщает число вершин в области вреза', () => {
  const rows = report.rows.filter((row) => row.metric === 'ступень кромки русла');
  assert.equal(rows.length, stand.CONTROL_CELLS.length);
  for (const row of rows) {
    if (row.status === 'N/A') {
      assert.match(
        row.detail,
        /нет русла|carve = 0/,
        'N/A объясняется отсутствием русла или нулевым врезом, а не молча',
      );
    } else {
      assert.match(row.detail, /вершин в области вреза: [1-9]\d* из \d+/, 'в detail — число вершин области вреза');
    }
  }
});

test('стенд: в мире A-17 речные метрики реально измеряются хотя бы на одной ячейке', async () => {
  // Кросс-проверка измеримости (не порогов): в A-29 врезанного русла на
  // контрольных ячейках может не быть, и тогда все речные строки — честные
  // N/A. В A-17 топология Patch7 несёт входы русла, поэтому хотя бы один
  // створ и хотя бы один профиль с carve > 0 обязаны измериться числом.
  const a17 = await stand.runStand({ world: 'a17', radiusM: 2500 });
  const continuity = a17.rows.filter((row) => row.metric === 'непрерывность русла через грань');
  assert.ok(
    continuity.some((row) => row.status !== 'N/A' && /^\d+\/\d+ створ/.test(row.valueText)),
    'хотя бы один створ измерен в формате «N/M створа»',
  );
  const bank = a17.rows.filter((row) => row.metric === 'ступень кромки русла');
  assert.ok(
    bank.some((row) => row.status !== 'N/A' && /вершин в области вреза: [1-9]/.test(row.detail)),
    'хотя бы один профиль пересекает область вреза',
  );
  const carveArea = a17.rows.filter((row) => row.metric === 'доля площади гекса под врезом');
  assert.ok(
    carveArea.some((row) => row.value > 0),
    'хотя бы на одной ячейке поле вреза ненулевое',
  );

  // m.2 по ветвям (карточка 18c): порог в таблице, подпись ветви в detail и
  // статус обязаны быть согласованы со значением в КАЖДОЙ измеренной строке —
  // морская ветвь не имеет потолка, речная имеет диапазон 3…12 м.
  const depths = a17.rows.filter((row) => row.metric === 'глубина воды в центре русла');
  for (const row of depths) {
    if (row.status === 'N/A') continue;
    if (row.threshold === '≥ 3 м') {
      assert.match(row.detail, /морская ветвь/, `ячейка ${row.cell}: морская ветвь подписана в detail`);
      assert.equal(
        row.status,
        row.value >= stand.THRESHOLDS.riverDepthM ? 'PASS' : 'FAIL',
        `ячейка ${row.cell}: у морской ветви нет потолка (значение ${row.value} м)`,
      );
    } else {
      assert.equal(row.threshold, '3…12 м', `ячейка ${row.cell}: порог — одна из двух ветвей`);
      assert.match(row.detail, /речная ветвь/, `ячейка ${row.cell}: речная ветвь подписана в detail`);
      assert.equal(
        row.status,
        row.value >= stand.THRESHOLDS.riverDepthM && row.value <= stand.THRESHOLDS.riverDepthMaxM ? 'PASS' : 'FAIL',
        `ячейка ${row.cell}: речная ветвь держит диапазон 3…12 м (значение ${row.value} м)`,
      );
    }
  }
  // Известный ответ карточки 18c: четыре океанские ячейки A-17 с входом
  // русла измеряются морской ветвью (глубина моря, а не каньон вреза).
  for (const cell of [37488, 37518, 137363, 137436]) {
    const row = depths.find((entry) => entry.cell === cell);
    assert.ok(row, `у ячейки ${cell} есть строка глубины`);
    assert.equal(row.threshold, '≥ 3 м', `ячейка ${cell}: порог морской ветви`);
    assert.match(row.detail, /морская ветвь/, `ячейка ${cell}: подпись «морская ветвь»`);
  }
});

test('стенд: сводка таблицы согласована с её строками', () => {
  const summary = report.summary;
  assert.equal(summary.total, report.rows.length);
  assert.equal(summary.pass + summary.fail + summary.na, report.rows.length);
  assert.equal(summary.failCount, summary.fail);
  assert.equal(summary.failedMetrics.length, new Set(summary.failedMetrics).size);
  for (const metric of summary.failedMetrics) {
    assert.ok(report.rows.some((row) => row.metric === metric && row.status === 'FAIL'));
  }
});

test('стенд: гейт возвращает 1 при красной метрике и 0 при полном PASS', () => {
  assert.equal(stand.gateExitCode({ fail: 1, pass: 10, na: 0 }), 1);
  assert.equal(stand.gateExitCode({ fail: 3, pass: 0, na: 0 }), 1);
  assert.equal(stand.gateExitCode({ fail: 0, pass: 42, na: 0 }), 0);
  assert.equal(stand.gateExitCode({ fail: 0, pass: 0, na: 42 }), 0, 'один N/A — не FAIL');
});

test('стенд: метрики формы и сквозной непрерывности (m.8…m.14) вычислимы на живой карте', () => {
  const newMetrics = [
    stand.METRIC_TITLES.landRelief,
    stand.METRIC_TITLES.oceanRelief,
    stand.METRIC_TITLES.meanSlope,
    stand.METRIC_TITLES.hypsometry,
    stand.METRIC_TITLES.waterContour,
    stand.METRIC_TITLES.hexContinuity,
    stand.METRIC_TITLES.lodConsistency,
  ];
  for (const metric of newMetrics) {
    const rows = report.rows.filter((row) => row.metric === metric);
    assert.equal(rows.length, stand.CONTROL_CELLS.length, `у метрики «${metric}» по строке на каждую контрольную ячейку`);
    const measured = rows.filter((row) => row.status !== 'N/A');
    assert.ok(measured.length > 0, `метрика «${metric}» реально измеряется хотя бы на одной ячейке`);
    for (const row of measured) {
      assert.ok(Number.isFinite(row.value) && row.value >= 0, `${metric}: конечное неотрицательное число (${row.value})`);
    }
  }

  for (const row of report.rows.filter((r) => r.metric === stand.METRIC_TITLES.hexContinuity)) {
    assert.notEqual(row.status, 'N/A', `ячейка ${row.cell}: у каждого контрольного гекса есть 6 соседей A↔B`);
    assert.match(row.valueText, /м$/, 'непрерывность A↔B выражена в метрах');
    assert.match(row.detail, /16 точек грани/, 'в detail указано 16 точек грани');
    assert.equal(
      row.status,
      row.value <= stand.THRESHOLDS.hexContinuityMaxM ? 'PASS' : 'FAIL',
      'статус m.13 строго соответствует порогу ≤ 1 м',
    );
  }

  for (const row of report.rows.filter((r) => r.metric === stand.METRIC_TITLES.lodConsistency)) {
    assert.notEqual(row.status, 'N/A', `ячейка ${row.cell}: гекс представлен и на 256, и на 64`);
    assert.match(row.valueText, /м$/, 'согласованность LOD выражена в метрах');
    assert.match(row.detail, /LOD 256 против 64/, 'в detail указано сравнение 256 против 64');
    assert.equal(
      row.status,
      row.value <= stand.THRESHOLDS.lodConsistencyMaxM ? 'PASS' : 'FAIL',
      'статус m.14 строго соответствует порогу ≤ 2 м',
    );
  }
});

test('негативный контроль (правило 2): плоская фикстура с постоянной высотой', () => {
  for (const constantHeightM of [0, 42.5, -31.5]) {
    const flat = stand.runFlatFixtureControl({ constantHeightM, radiusM: 2500 });
    assert.equal(flat.rows.length, 7, 'в негативном контроле ровно семь новых метрик m.8…m.14');
    for (const row of flat.rows) {
      assert.notEqual(row.status, 'N/A', `${row.metric}: на береговой плоской фикстуре не уходит в N/A`);
      assert.equal(row.value, 0, `${row.metric}: на постоянной высоте h=${constantHeightM} м измерено 0`);
    }

    // Все пять метрик формы и гладкости контура (m.8…m.12) обязаны возвращать FAIL на плоскости.
    for (const title of [
      stand.METRIC_TITLES.landRelief,
      stand.METRIC_TITLES.oceanRelief,
      stand.METRIC_TITLES.meanSlope,
      stand.METRIC_TITLES.hypsometry,
      stand.METRIC_TITLES.waterContour,
    ]) {
      const row = flat.rows.find((entry) => entry.metric === title);
      assert.equal(row?.status, 'FAIL', `${title} на плоской плите h=${constantHeightM} м обязана давать FAIL`);
    }

    // m.13 и m.14 — полунормы расхождения |h₁ − h₂| ≤ ε: при h_A ≡ h_B ≡ h_64 ≡ const
    // честное расхождение тождественно равно 0 м (PASS); подгонять их под FAIL нельзя.
    for (const title of [stand.METRIC_TITLES.hexContinuity, stand.METRIC_TITLES.lodConsistency]) {
      const row = flat.rows.find((entry) => entry.metric === title);
      assert.equal(row?.status, 'PASS', `${title}: на совпадающей константе |C − C| = 0 м (PASS)`);
    }
    assert.equal(stand.gateExitCode(flat.summary), 1, 'плоская фикстура валит гейт стенда');
  }
});

test('синтетические пробы m.8…m.14: метрики чувствительны в обе стороны (не захардкожены в FAIL)', () => {
  const res = 256;
  const radiusM = 2500;
  // Наклонный рельеф: суша x >= 128 поднимается на 750 м (15 % от 2R = 5000 м),
  // океан x < 128 опускается на 350 м (7 % от 2R), плавная полоса маски воды.
  const heightfield = new Float32Array(res * res);
  const terraformMap = new Uint8Array(res * res);
  const waterMask = new Float32Array(res * res);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const idx = y * res + x;
      const u = x / (res - 1);
      const v = y / (res - 1);
      if (x < res / 2) {
        terraformMap[idx] = 0;
        heightfield[idx] = -350 * (1 - x / (res / 2 - 1)) - 10 * v;
      } else {
        terraformMap[idx] = 2;
        heightfield[idx] = 740 * ((x - res / 2) / (res / 2 - 1)) + 10 * v;
      }
      // Плавная переходная полоса шириной 6 текселей вокруг x = 128 (все промежуточные 0 < mask < 1).
      waterMask[idx] = Math.min(1, Math.max(0, 0.5 - (x - 127.5) / 6));
    }
  }
  const local = { heightfield, terraformMap, waterMask, meta: { radiusM, hfRes: res, tfRes: res } };

  const m8 = stand.measureLandRelief(local, radiusM);
  assert.ok(m8.value >= 10 && m8.value <= 25, `m.8 в целевом коридоре 10…25 % (${m8.value})`);
  const m9 = stand.measureOceanRelief(local, null, radiusM);
  assert.ok(m9.value >= 5, `m.9 ≥ 5 % (${m9.value})`);
  const m10 = stand.measureMeanSlope(local, radiusM);
  assert.ok(m10.value >= 4, `m.10 ≥ 4 % (${m10.value})`);
  // Степенной планетный профиль с межквантильным размахом p90−p10 ≈ 28 % (внутри коридора 20…35 %).
  const syntheticPlanetElev = new Float32Array(1001);
  for (let i = 0; i < syntheticPlanetElev.length; i++) {
    const t = (i / (syntheticPlanetElev.length - 1)) * 2 - 1;
    syntheticPlanetElev[i] = Math.sign(t) * Math.pow(Math.abs(t), 5.7);
  }
  const m11 = stand.measureHypsometry(syntheticPlanetElev);
  assert.ok(
    m11.value >= stand.THRESHOLDS.hypsometryMinPct && m11.value <= stand.THRESHOLDS.hypsometryMaxPct,
    `m.11 в полосе 20…35 % (${m11.value})`,
  );
  assert.equal(m11.status, 'PASS');
  const m12 = stand.measureWaterContourSmoothness(local, null, radiusM);
  assert.ok(m12.value >= 40, `m.12 ≥ 40 % на гладкой маске (${m12.value})`);

  // Наоборот, m.13 и m.14 обязаны ловить ступеньки A↔B (> 1 м) и LOD (> 2 м).
  const mismatchProbe = stand.runFlatFixtureControl({
    constantHeightM: 10,
    neighborHeightOffsetM: 2.5,
    lodHeightOffsetM: 3.5,
  });
  const m13Row = mismatchProbe.rows.find((r) => r.metric === stand.METRIC_TITLES.hexContinuity);
  const m14Row = mismatchProbe.rows.find((r) => r.metric === stand.METRIC_TITLES.lodConsistency);
  assert.equal(m13Row?.status, 'FAIL', 'm.13 ловит ступеньку A↔B 2,5 м > 1 м');
  assert.ok(Math.abs(m13Row.value - 2.5) < 1e-3, `m.13 измеряет 2,5 м (${m13Row.value})`);
  assert.equal(m14Row?.status, 'FAIL', 'm.14 ловит ступеньку LOD 3,5 м > 2 м');
  assert.ok(Math.abs(m14Row.value - 3.5) < 1e-3, `m.14 измеряет 3,5 м (${m14Row.value})`);
});

test('стенд: CLI печатает таблицу и без --gate всегда выходит с кодом 0', () => {
  const result = spawnSync('node', [TOOL_PATH], { encoding: 'utf8' });
  assert.equal(result.status, 0, `код возврата: ${result.status} ${result.stderr ?? ''}`);
  const out = result.stdout;
  assert.match(out, /ячейка\s+зона\s+метрика\s+значение\s+порог\s+статус/);
  assert.match(out, /SUMMARY/);
  assert.match(out, /FAIL: \d+/);
  for (const cell of stand.CONTROL_CELLS) {
    assert.ok(out.includes(String(cell)), `в таблице есть ячейка ${cell}`);
  }
});

test('стенд: --json отдаёт те же поля, что и таблица', () => {
  const result = spawnSync('node', [TOOL_PATH, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `код возврата: ${result.status} ${result.stderr ?? ''}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.rows.length, stand.CONTROL_CELLS.length * METRIC_COUNT);
  for (const row of parsed.rows) {
    for (const field of ['cell', 'zone', 'metric', 'value', 'valueText', 'threshold', 'status', 'detail']) {
      assert.ok(field in row, `в JSON-строке есть поле ${field}`);
    }
  }
  assert.equal(parsed.summary.fail + parsed.summary.pass + parsed.summary.na, parsed.rows.length);
  assert.deepEqual(parsed.controlCells, stand.CONTROL_CELLS);
});

test('стенд: --flat-fixture работает из CLI и с --gate возвращает 1', () => {
  const plain = spawnSync('node', [TOOL_PATH, '--flat-fixture', '--json'], { encoding: 'utf8' });
  assert.equal(plain.status, 0, `без --gate код 0: ${plain.stderr ?? ''}`);
  const parsed = JSON.parse(plain.stdout);
  assert.equal(parsed.mode, 'flat-fixture');
  assert.equal(parsed.rows.length, 7);
  assert.equal(parsed.summary.fail, 5);
  assert.equal(parsed.summary.pass, 2);

  const gated = spawnSync('node', [TOOL_PATH, '--flat-fixture', '--gate'], { encoding: 'utf8' });
  assert.equal(gated.status, 1, 'плоская фикстура с --gate обязана возвращать exit code 1');
});

test('стенд: код возврата --gate согласован с числом красных строк', () => {
  const result = spawnSync('node', [TOOL_PATH, '--gate'], { encoding: 'utf8' });
  assert.equal(result.status, stand.gateExitCode(report.summary), 'гейт считает те же строки, что и таблица');
  assert.ok(result.status === 0 || result.status === 1);
});

test('стенд: неизвестный профиль и неизвестный аргумент отвергаются', () => {
  assert.throws(() => stand.parseArgs(['--profile=unknown']), /Неизвестный профиль/);
  assert.throws(() => stand.parseArgs(['--nope']), /Неизвестный аргумент/);
  const options = stand.parseArgs(['--gate', '--json', '--flat-fixture', '--flat-height-m=12', '--profile=a17', '--radius-m=1200']);
  assert.deepEqual(
    {
      gate: options.gate,
      json: options.json,
      flatFixture: options.flatFixture,
      flatHeightM: options.flatHeightM,
      world: options.world,
      radiusM: options.radiusM,
    },
    { gate: true, json: true, flatFixture: true, flatHeightM: 12, world: 'a17', radiusM: 1200 },
  );
});

// ---------------------------------------------------------------------------
// Новые тесты W26b (пункты 1–4 + дополнение #234): шкала азимутов m.13 на
// рампе h = k·x, фиксированное окно 5 000 м (m.8/m.9/m.10), одинаковый span
// m.14, наземная гипсометрия m.11 (elev > seaLevel) и преувеличение глобуса.
// ---------------------------------------------------------------------------

test('W26b п.1: m.13 (measureHexContinuity) — контроль азимута на рампе h = k·x (0 ± 0,1 м), диагностика слот·60° и пометка W23', () => {
  const grid = GeodesicGrid.build(stand.CANONICAL_V);
  const surface = PlanetSurface.generateSurface(grid, stand.WORLDS.a29.profile);
  const radiusM = stand.DEFAULT_RADIUS_M;

  for (const cell of stand.CONTROL_CELLS) {
    const patchA = Contract.buildPatch7(grid, surface, cell);
    const neighborPatches = new Map();
    for (let k = 1; k < patchA.cells.length; k++) {
      const nbCell = patchA.cells[k].cell;
      if (grid.neighborCount[nbCell] !== 6) continue;
      neighborPatches.set(nbCell, Contract.buildPatch7(grid, surface, nbCell));
    }

    // На синтетическом поле-рампе h = k·x (перепад 100 м на полуребре)
    // при истинной шкале азимутов шов равен 0 ± 0,1 м на всех 7 ячейках.
    const rampTrue = stand.runRampAzimuthControl(patchA, neighborPatches, radiusM);
    assert.equal(rampTrue.faces.length, 6, `ячейка ${cell}: все 6 шестиугольных граней сопоставлены`);
    assert.ok(
      rampTrue.value <= 0.1,
      `ячейка ${cell}: на рампе h = k·x при истинной шкале шов 0 ± 0,1 м (${rampTrue.value})`,
    );
    assert.equal(rampTrue.azimuthScaleOk, true);
    assert.equal(rampTrue.status, 'PASS');
  }

  // Проверяем ненулевую диагностику «слот·60° против истинного азимута» и пометку W23 в detail отчёта:
  // #37488: −29,6…−30,3°, #37548: до −90,4°, #37436: +14,6…+17,8°.
  const row37488 = report.rows.find((r) => r.cell === 37488 && r.metric === stand.METRIC_TITLES.hexContinuity);
  const row37548 = report.rows.find((r) => r.cell === 37548 && r.metric === stand.METRIC_TITLES.hexContinuity);
  const row137436 = report.rows.find((r) => r.cell === 137436 && r.metric === stand.METRIC_TITLES.hexContinuity);

  assert.match(row37488.detail, /слот·60° против истинного азимута:.*диапазон −30,3°…−29,6°/);
  assert.match(row37548.detail, /слот·60° против истинного азимута:.*−90,4°/);
  assert.match(row137436.detail, /слот·60° против истинного азимута:.*диапазон \+14,6°…\+17,8°/);

  for (const row of report.rows.filter((r) => r.metric === stand.METRIC_TITLES.hexContinuity)) {
    assert.match(row.detail, /один dir в кадрах A\/B; max Δ расстояния до центров = 0 м/);
  }
});

test('W26b п.1 (негативный контроль «сдвинутая шкала» на рампе h = k·x): при сдвиге на 30° шов растёт пропорционально и падает', () => {
  const grid = GeodesicGrid.build(stand.CANONICAL_V);
  const surface = PlanetSurface.generateSurface(grid, stand.WORLDS.a29.profile);
  const radiusM = stand.DEFAULT_RADIUS_M;
  const patchA = Contract.buildPatch7(grid, surface, 37488);
  const neighborPatches = new Map();
  for (let k = 1; k < patchA.cells.length; k++) {
    const nbCell = patchA.cells[k].cell;
    neighborPatches.set(nbCell, Contract.buildPatch7(grid, surface, nbCell));
  }

  // На синтетической рампе h = k·x (перепад 100 м на полуребре):
  // при 0° шов ≤ 0,1 м (PASS); при 10°, 20°, 30° шов монотонно и пропорционально растёт.
  const r0 = stand.runRampAzimuthControl(patchA, neighborPatches, radiusM, { azimuthOffsetDeg: 0 });
  const r10 = stand.runRampAzimuthControl(patchA, neighborPatches, radiusM, { azimuthOffsetDeg: 10 });
  const r20 = stand.runRampAzimuthControl(patchA, neighborPatches, radiusM, { azimuthOffsetDeg: 20 });
  const r30 = stand.runRampAzimuthControl(patchA, neighborPatches, radiusM, { azimuthOffsetDeg: 30 });
  const rSlot = stand.runRampAzimuthControl(patchA, neighborPatches, radiusM, { useSlotScale: true });

  assert.ok(r0.value <= 0.1, `при 0° шов равен 0 ± 0,1 м (${r0.value})`);
  assert.equal(r0.status, 'PASS');
  assert.ok(r10.value > 50 && r10.value < r20.value, `при 10° шов вырос до ~60 м (${r10.value})`);
  assert.ok(r20.value > 100 && r20.value < r30.value, `при 20° шов вырос до ~118 м (${r20.value})`);
  assert.ok(r30.value > 150, `при 30° шов вырос пропорционально до ~173 м (${r30.value})`);
  assert.equal(r30.azimuthScaleOk, false);
  assert.equal(r30.status, 'FAIL', 'при сдвиге на 30° проверка на рампе обязана падать');

  // Прежняя шкала slot·π/3 (на #37488 смещённая на ~−30°) на той же рампе тоже обязана падать.
  assert.ok(rSlot.value > 150, `прежняя шкала slot·60° на #37488 даёт разрыв ~173 м (${rSlot.value})`);
  assert.equal(rSlot.status, 'FAIL');
});

test('W26b доп. п.2 (негативный контроль окна 5 000 м): --radius-m=2500 и --radius-m=52136 дают ОДИНАКОВЫЕ m.8 / m.9 / m.10', async () => {
  assert.equal(stand.RELIEF_WINDOW_WIDTH_M, 5000, 'ширина фиксированного окна равна 5 000 м');
  assert.equal(stand.DEFAULT_RADIUS_M, GLOBE_CELL_SCALE.strategicPatchRadiusM);

  const rep2500 = await stand.runStand({ radiusM: 2500 });
  const rep52136 = report;
  const targetMetrics = [
    stand.METRIC_TITLES.landRelief,
    stand.METRIC_TITLES.oceanRelief,
    stand.METRIC_TITLES.meanSlope,
  ];

  for (const cell of stand.CONTROL_CELLS) {
    for (const metric of targetMetrics) {
      const a = rep2500.rows.find((r) => r.cell === cell && r.metric === metric);
      const b = rep52136.rows.find((r) => r.cell === cell && r.metric === metric);
      assert.equal(b.value, a.value, `ячейка ${cell} (${metric}): value при radiusM=52136 равен radiusM=2500`);
      assert.equal(b.valueText, a.valueText, `ячейка ${cell} (${metric}): valueText совпадает`);
      assert.equal(b.status, a.status, `ячейка ${cell} (${metric}): status совпадает`);
      assert.equal(b.detail, a.detail, `ячейка ${cell} (${metric}): detail совпадает`);
    }
  }

  // Прямая проверка фильтра окна 5 000 м: выброс за пределами |x| <= 2500 м при radiusM=52136 игнорируется.
  const res = stand.LOD_FINE_RES;
  const hfBig = new Float32Array(res * res).fill(10);
  const tfBig = new Uint8Array(res * res).fill(2);
  // Кладём огромный пик +5000 м в угол (x = 0, y = 0), который при radiusM=52136 лежит на −52 км (вне окна ±2500 м).
  hfBig[0] = 5000;
  const localBig = {
    heightfield: hfBig,
    terraformMap: tfBig,
    meta: { radiusM: 52136, hfRes: res, tfRes: res },
  };
  const m8Windowed = stand.measureLandRelief(localBig, 52136);
  assert.equal(m8Windowed.value, 0, 'выброс вне окна 5 000 м не влияет на m.8');
  assert.equal(m8Windowed.frameWidthM, 5000, 'знаменатель m.8 равен фиксированному окну 5 000 м');
});

test('W26b п.2: m.14 (measureLodConsistency) сравнивает одинаковый span — 0 м на константном поле и ≤ 2 м на реальном', () => {
  const grid = GeodesicGrid.build(stand.CANONICAL_V);
  const surface = PlanetSurface.generateSurface(grid, stand.WORLDS.a29.profile);
  const radiusM = 2500;
  const resFine = stand.LOD_FINE_RES;
  const resCoarse = stand.LOD_COARSE_RES;

  // 1) На константном поле при реальном span грубого LOD (dHex ≈ 59–64,5 км против 5 км у 256)
  //    рассогласование строго равно 0.
  for (const constantH of [0, -252.5, 137.25]) {
    const patchC = Contract.buildPatch7(grid, surface, 37488);
    const nbCell = patchC.cells[1].cell;
    const patchB = Contract.buildPatch7(grid, surface, nbCell);
    const dHexB = stand.computePatchHexSpanM(patchB);
    assert.ok(dHexB > 50_000 && dHexB < 70_000, `span грубого LOD dHex в пределах 50…70 км (${dHexB})`);

    const local256 = {
      heightfield: new Float32Array(resFine * resFine).fill(constantH),
      meta: { radiusM, hfRes: resFine, tfRes: resFine },
    };
    const coarseViews = [{
      sourceLabel: String(nbCell),
      frameEast: patchB.frame.east,
      frameNorth: patchB.frame.north,
      hfRes: resCoarse,
      spanM: dHexB,
      heightfield: new Float32Array(resCoarse * resCoarse).fill(constantH),
    }];
    const resConst = stand.measureLodConsistency(local256, patchC, coarseViews, radiusM);
    assert.equal(resConst.value, 0, `на константном поле h=${constantH} рассогласование ровно 0`);
    assert.equal(resConst.worst.commonSpanM, 2 * radiusM, 'сравнение ведётся на одинаковом span = 5000 м');
  }

  // 2) На реальном планетном поле высот (sampleElevation на сетке 256 при span 5 км
  //    и на сетке 64 при span dHex = 59–64,5 км) рассогласование ≤ 2 м на всех 7 ячейках.
  for (const cell of stand.CONTROL_CELLS) {
    const patchC = Contract.buildPatch7(grid, surface, cell);
    const fineSpanM = 2 * radiusM;
    const stepFineM = fineSpanM / resFine;
    const hf256 = new Float32Array(resFine * resFine);
    for (let y = 0; y < resFine; y++) {
      const wy = ((y - resFine / 2) / resFine) * fineSpanM;
      for (let x = 0; x < resFine; x++) {
        const wx = ((x - resFine / 2) / resFine) * fineSpanM;
        const dir = Contract.localPointToDirection(patchC, wx, wy);
        hf256[y * resFine + x] = PlanetElevationField.sampleElevation(
          dir, stepFineM, stand.WORLDS.a29.profile,
        );
      }
    }
    const nbCell = patchC.cells[1].cell;
    const patchB = Contract.buildPatch7(grid, surface, nbCell);
    const dHexB = stand.computePatchHexSpanM(patchB);
    const stepCoarseM = dHexB / resCoarse;
    const hf64 = new Float32Array(resCoarse * resCoarse);
    for (let y = 0; y < resCoarse; y++) {
      const wy = ((y - resCoarse / 2) / resCoarse) * dHexB;
      for (let x = 0; x < resCoarse; x++) {
        const wx = ((x - resCoarse / 2) / resCoarse) * dHexB;
        const dir = Contract.localPointToDirection(patchC, wx, wy);
        hf64[y * resCoarse + x] = PlanetElevationField.sampleElevation(
          dir, stepCoarseM, stand.WORLDS.a29.profile,
        );
      }
    }
    const m14Real = stand.measureLodConsistency(
      { heightfield: hf256, meta: { radiusM, hfRes: resFine } },
      patchC,
      [{
        sourceLabel: String(nbCell),
        frameEast: patchC.frame.east,
        frameNorth: patchC.frame.north,
        hfRes: resCoarse,
        spanM: dHexB,
        heightfield: hf64,
      }],
      radiusM,
    );
    assert.ok(
      m14Real.value <= stand.THRESHOLDS.lodConsistencyMaxM,
      `ячейка ${cell}: на реальном поле рассогласование LOD ≤ 2 м (${m14Real.value})`,
    );
  }

  // Живая карта на R≈52 км честно сообщает residual LOD (не золотое число 2 м).
  for (const oceanCell of [37488, 37518, 37548, 37519, 137363]) {
    const row = report.rows.find((r) => r.cell === oceanCell && r.metric === stand.METRIC_TITLES.lodConsistency);
    assert.ok(row && Number.isFinite(row.value), `живая карта ${oceanCell}: m.14 измерима`);
    assert.equal(row.status, row.value <= stand.THRESHOLDS.lodConsistencyMaxM ? 'PASS' : 'FAIL');
  }
});

test('W26b п.3: m.11 (measureHypsometry) считается ТОЛЬКО по суше elev > seaLevel (45,93 %, 16 596 из 163 842), гейт 20…35 % и --hypso-reference', () => {
  const grid = GeodesicGrid.build(stand.CANONICAL_V);
  const surface = PlanetSurface.generateSurface(grid, stand.WORLDS.a29.profile);
  const direct = stand.measureHypsometry(surface);
  assert.equal(direct.totalCells, 163_842, 'всего ячеек сетки v=128: 163 842');
  assert.equal(direct.landCells, 16_596, 'наземных ячеек elev > seaLevel: 16 596');
  assert.equal(Number(direct.p10.toFixed(4)), 0.2954, `p10 = 0,2954 (${direct.p10})`);
  assert.equal(Number(direct.p50.toFixed(4)), 0.3540, `p50 = 0,3540 (${direct.p50})`);
  assert.equal(Number(direct.p90.toFixed(4)), 0.4685, `p90 = 0,4685 (${direct.p90})`);
  assert.equal(Number(direct.maxH.toFixed(4)), 0.6600, `max = 0,6600 (${direct.maxH})`);
  assert.equal(Number(direct.value.toFixed(2)), 45.93, `ожидаемое значение на v=128: 45,93 % (${direct.value})`);
  assert.equal(direct.status, 'FAIL', '45,93 % вне полосы 20…35 % даёт FAIL');
  assert.match(direct.detail, /p10 0,2954 \/ p50 0,3540 \/ p90 0,4685 \/ max 0,6600/);
  assert.match(direct.detail, /суша 16596 из 163842/);
  assert.match(direct.detail, /ориентир: Земля 19,4 %, наш домен 28,1 %, прежний порог 35 %/);

  // Во всех 7 строках отчёта m.11 равен 45.93 % и имеет порог 20…35 %.
  const m11Rows = report.rows.filter((r) => r.metric === stand.METRIC_TITLES.hypsometry);
  assert.equal(m11Rows.length, stand.CONTROL_CELLS.length);
  for (const row of m11Rows) {
    assert.equal(row.threshold, '20…35 %');
    assert.equal(row.value, 45.93);
    assert.equal(row.valueText, '45.93 %');
    assert.equal(row.status, 'FAIL');
    assert.match(row.detail, /суша 16596 из 163842/);
  }

  // Флаг --hypso-reference=<pct> подставляет ориентир другого профиля в detail, но НЕ меняет вердикт.
  const parsedOpts = stand.parseArgs(['--hypso-reference=24.6']);
  assert.equal(parsedOpts.hypsoReferencePct, 24.6);
  const withCustomRef = stand.measureHypsometry(surface, { hypsoReferencePct: 24.6 });
  assert.match(withCustomRef.detail, /ориентир: Земля 19,4 %, профиль 24,6 %, прежний порог 35 %/);
  assert.equal(withCustomRef.value, direct.value, 'значение m.11 не зависит от --hypso-reference');
  assert.equal(withCustomRef.status, direct.status, 'вердикт m.11 не зависит от --hypso-reference');
});

test('W26b п.3 (негативный контроль m.11): идеально плоское поле даёт FAIL и 0 %, а не 100 %', () => {
  for (const constElev of [0, -0.5, 0.2832, 42.5]) {
    const flatField = new Float32Array(163_842).fill(constElev);
    const res = stand.measureHypsometry(flatField);
    assert.equal(res.value, 0, `плоское поле elev=${constElev} обязано давать 0 %, а не 100 %`);
    assert.notEqual(res.value, 100);
    assert.equal(res.pass, false);
    assert.equal(res.status, 'FAIL', `плоское поле elev=${constElev} обязано давать FAIL`);
  }
});

test('W26b п.4: вертикальное преувеличение глобуса (печать без порога, суша/океан и отношение)', () => {
  // Значения сверяются с GLOBE_RELIEF, а не с устаревшими 0,022/0,008.
  const refEx = stand.measureGlobeVerticalExaggeration(
    {
      radiusKm: 6371,
      seaLevel: 0.283141,
      elevationMax: 0.638,
      elevationMin: -1.0,
    },
    { scaleK: 8570 },
  );
  assert.equal(refEx.landExaggeration, GLOBE_RELIEF.landMax * 6_371_000 / ((0.638 - 0.283141) * 8570));
  assert.equal(refEx.oceanExaggeration, GLOBE_RELIEF.oceanMax * 6_371_000 / ((0.283141 + 1) * 8570));
  assert.equal(Number(refEx.oceanToLandRatio.toFixed(2)), 0.50, `отношение 0,50 (${refEx.oceanToLandRatio})`);

  // Отношение океан/суша не меняется от смены K (глобус нормирует высоту на размах поля).
  const refEx900 = stand.measureGlobeVerticalExaggeration(
    {
      radiusKm: 6371,
      seaLevel: 0.283141,
      elevationMax: 0.638,
      elevationMin: -1.0,
    },
    { scaleK: 900 },
  );
  assert.ok(
    Math.abs(refEx900.oceanToLandRatio - refEx.oceanToLandRatio) < 1e-12,
    'отношение океан/суша инвариантно к K',
  );

  // В живом отчёте стенда поле присутствует и не добавляет порога в таблицу.
  assert.ok(report.globeVerticalExaggeration, 'в отчёте стенда есть globeVerticalExaggeration');
  assert.ok(report.globeVerticalExaggeration.landExaggeration > 0);
  assert.ok(report.globeVerticalExaggeration.oceanExaggeration > 0);
  assert.match(report.globeVerticalExaggeration.detail, /site\/shared\/planet-globe\.ts:GLOBE_RELIEF/);
});

// W23: проверяем физическую границу и поле отдельно от исторических golden
// тестов Stage-8 (их значения не обновляются на этой ветке).
test('W23: апофема 29 978 м, все 6 идеальных соседей замощают общие грани без щелей/нахлёстов', () => {
  const radiusM = stand.DEFAULT_RADIUS_M;
  const a = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * radiusM;
  const d = Worker.SKIRT_HEX_SPACING_RATIO * radiusM;
  assert.ok(Math.abs(radiusM - GLOBE_CELL_SCALE.strategicPatchRadiusM) < 1e-8);
  assert.ok(Math.abs(a - GLOBE_CELL_SCALE.cellApothemM) < 1e-8);
  assert.ok(Math.abs(d - GLOBE_CELL_SCALE.cellCenterSpacingM) < 1e-8);
  assert.ok(Math.abs(a / Worker.HEX_APOTHEM_RATIO - GLOBE_CELL_SCALE.cellEdgeM) < 1e-8);
  assert.ok(Math.abs(Worker.CENTER_HEX_RADIUS_RATIO - 0.6639528095680696) < 1e-12);
  assert.ok(Worker.SKIRT_INNER_RADIUS_RATIO * radiusM < a, 'воротник начинается внутри грани');
  assert.ok(Worker.LOCAL_PATCH_RAMP_START_RATIO * a < a);
  assert.ok(Worker.LOCAL_PATCH_RAMP_END_RATIO * a > a);
  assert.ok(Worker.LOCAL_PATCH_RAMP_END_RATIO * a < a / Worker.HEX_APOTHEM_RATIO);
  const Shaders = require('../src/local-map/local-map-shaders.ts');
  assert.match(Shaders.TERRAIN_FRAGMENT_SHADER, /hexApothem = u_focusRadiusM \* 0\.575/);

  const halfEdge = a / Math.sqrt(3);
  for (let slot = 0; slot < 6; slot++) {
    const phi = slot * Math.PI / 3;
    const nx = Math.cos(phi), ny = Math.sin(phi);
    for (let i = 0; i <= 16; i++) {
      const along = (i / 16 * 2 - 1) * halfEdge;
      const x = a * nx - along * ny;
      const y = a * ny + along * nx;
      const metricA = Worker.clusterHexMetric(x, y);
      const metricB = Worker.clusterHexMetric(x - d * nx, y - d * ny);
      assert.ok(Math.abs(metricA - a) < 1e-8 && Math.abs(metricB - a) < 1e-8,
        `слот ${slot}, отсчёт ${i}: общая грань одновременно на обоих контурах`);
      if (i === 8) {
        const beyondA = Worker.clusterHexMetric(x + nx, y + ny);
        const insideB = Worker.clusterHexMetric(x + nx - d * nx, y + ny - d * ny);
        assert.ok(beyondA > a && insideB < a, 'по разные стороны грани ровно один владелец');
      }
    }
  }
});

test('W23: одно направление через два кадра и на шагах 65²/256² имеет одинаковую высоту; растровый остаток — интерполяция', () => {
  const grid = GeodesicGrid.build(stand.CANONICAL_V);
  const surface = PlanetSurface.generateSurface(grid, stand.WORLDS.a29.profile);
  const patchA = Contract.buildPatch7(grid, surface, 37488);
  const patchB = Contract.buildPatch7(grid, surface, 37519);
  const centerA = patchA.frame.origin, centerB = patchB.frame.origin;
  const centerSum = centerA.map((v, i) => v + centerB[i]);
  const midLen = Math.hypot(...centerSum);
  const mid = centerSum.map((v) => v / midLen);
  const cross = [
    centerA[1] * centerB[2] - centerA[2] * centerB[1],
    centerA[2] * centerB[0] - centerA[0] * centerB[2],
    centerA[0] * centerB[1] - centerA[1] * centerB[0],
  ];
  const normalLen = Math.hypot(...cross);
  const along = cross.map((v) => v / normalLen);
  const radiusM = stand.DEFAULT_RADIUS_M;
  const halfEdge = GLOBE_CELL_SCALE.cellApothemM / Math.sqrt(3);
  const seed = (stand.WORLDS.a29.seed ^ Math.imul(3, 0x85EBCA6B)) >>> 0;
  const frameSamples = [];
  for (let p = 0; p < 16; p++) {
    const s = ((p + 0.5) / 16 - 0.5) * 2 * halfEdge;
    const theta = s / patchA.frame.radiusM;
    const dir = mid.map((v, i) => v * Math.cos(theta) + along[i] * Math.sin(theta));
    const a = Geometry.directionToLocalPoint(patchA, dir);
    const b = Geometry.directionToLocalPoint(patchB, dir);
    assert.ok(Math.abs(Math.hypot(a.u, a.v) - Math.hypot(b.u, b.v)) < 1e-4,
      'физическая точка на общей биссектрисе равноудалена от обоих центров');
    frameSamples.push({ dir, a, b });
  }

  const bilinear = (hf, res, point) => {
    const gx = Math.min(res - 1.0001, Math.max(0, point.u * res / (2 * radiusM) + res / 2));
    const gy = Math.min(res - 1.0001, Math.max(0, point.v * res / (2 * radiusM) + res / 2));
    const x = Math.floor(gx), y = Math.floor(gy), tx = gx - x, ty = gy - y;
    const i = y * res + x;
    return (hf[i] * (1 - tx) + hf[i + 1] * tx) * (1 - ty)
      + (hf[i + res] * (1 - tx) + hf[i + res + 1] * tx) * ty;
  };
  const rasterErrors = [];
  const directErrors = [];
  for (const res of [65, 256]) {
    const stepM = (2 * radiusM) / res;
    let maxDirect = 0;
    for (const { dir, a, b } of frameSamples) {
      const fromA = Contract.localPointToDirection(patchA, a.u, a.v);
      const fromB = Contract.localPointToDirection(patchB, b.u, b.v);
      assert.ok(Math.hypot(...fromA.map((v, i) => v - dir[i])) < 1e-10);
      assert.ok(Math.hypot(...fromB.map((v, i) => v - dir[i])) < 1e-10);
      const hA = Heightfield.sampleLocalTerrainHeightM(fromA, stepM, patchA.frame.radiusM, seed, true);
      const hB = Heightfield.sampleLocalTerrainHeightM(fromB, stepM, patchB.frame.radiusM, seed, true);
      maxDirect = Math.max(maxDirect, Math.abs(hA - hB));
    }
    assert.ok(maxDirect <= 1, `шаг ${res}²: равные физические точки отличаются не более 1 м (${maxDirect})`);
    directErrors.push(maxDirect);

    const makeGrid = (patch) => {
      const heights = new Float32Array(res * res);
      for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
          const dir = Contract.localPointToDirection(patch, (x - res / 2) * stepM, (y - res / 2) * stepM);
          heights[y * res + x] = Heightfield.sampleLocalTerrainHeightM(dir, stepM, patch.frame.radiusM, seed, true);
        }
      }
      return heights;
    };
    const gridA = makeGrid(patchA), gridB = makeGrid(patchB);
    const maxRaster = Math.max(...frameSamples.map(({ a, b }) =>
      Math.abs(bilinear(gridA, res, a) - bilinear(gridB, res, b))));
    rasterErrors.push(maxRaster);
  }
  console.log(`W23: прямой сэмпл A/B 65²=${directErrors[0].toExponential(3)} м, 256²=${directErrors[1].toExponential(3)} м; растры ${rasterErrors[0].toFixed(3)} / ${rasterErrors[1].toFixed(3)} м`);
  assert.ok(rasterErrors[1] < rasterErrors[0],
    `остаток растра убывает с шагом: 65² ${rasterErrors[0]} м → 256² ${rasterErrors[1]} м`);
});

test('W23: m.8 = 3…8 % на суше, m.9 ≥ 1 % минимум в 30 из 40 случайных морских окон по 5 км', async () => {
  const land = report.rows.find((r) => r.cell === 137436 && r.metric === stand.METRIC_TITLES.landRelief);
  assert.ok(land.value >= 3 && land.value <= 8, `окно суши: ${land.value} %`);
  const grid = GeodesicGrid.build(stand.CANONICAL_V);
  const surface = PlanetSurface.generateSurface(grid, stand.WORLDS.a29.profile);
  const oceans = [];
  for (let c = 0; c < grid.cellCount; c++) {
    if (grid.neighborCount[c] !== 6 || surface.elevation[c] >= surface.seaLevel || surface.lakeWeight[c] > 0) continue;
    if (Array.from({ length: 6 }, (_, k) => grid.neighbors[c * 6 + k])
      .every((n) => surface.elevation[n] < surface.seaLevel && surface.lakeWeight[n] === 0)) oceans.push(c);
  }
  // Фиксированный LCG, выбор без повторений, без ручного отбора «удачных» ячеек.
  let state = 0x23102026;
  const cells = new Set();
  while (cells.size < 40) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    cells.add(oceans[state % oceans.length]);
  }
  let passed = 0;
  const failures = [];
  for (const cell of cells) {
    const patch = Contract.buildPatch7(grid, surface, cell);
    const local = await Worker.generateLocalMap({
      patch, seed: stand.WORLDS.a29.seed, placeId: 2,
      radiusM: stand.RELIEF_WINDOW_WIDTH_M / 2,
      profile: stand.WORLDS.a29.profile, neighborRings: 0,
    });
    const { value } = stand.measureOceanRelief(local, patch, stand.RELIEF_WINDOW_WIDTH_M / 2);
    if (value >= 1) passed++;
    else failures.push(`${cell}:${value?.toFixed(2)}%`);
  }
  console.log(`W23: морские окна m.9 ≥ 1 %: ${passed}/40`);
  assert.ok(passed >= 30, `m.9: ${passed}/40 морских пятен ≥ 1 %; остаток ${failures.join(', ')}`);
});
