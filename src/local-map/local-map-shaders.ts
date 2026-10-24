/* LocalMapShaders — GLSL ES 3.00 шейдеры локальной карты (Этапы 8/9, CR-01 PR 5;
   Stage-8 Planetary Horizon: кривизна планеты, оптический блюр горизонта,
   атмосферная дымка и купол неба.
   Stage-8.2/8.3: выделение только активного центрального гекса тонкой
   деликатной кромкой, бесшовный сферический горизонт с 3-каскадной живой
   альпийской долиной, скальными хребтами и дневным куполом со слоисто-кучевыми
   облаками, плавно растворяющимися в атмосферной дымке.
   Stage-8.6: объёмная вода с батиметрией, Fresnel-отражением неба, солнечным
   бликом и пеной прибоя, рендеринг рек на любой высоте с галечной поймой и
   пять отчётливых гипсометрических поясов суши от пляжа до снежных вершин.
   --------------------------------------------------------------------------
   Поля шейдеров обязаны совпадать с контрактом VAO рендерера
   (local-map-renderer.ts):
   - location 0: a_position (per-vertex), location 1: a_normal (per-vertex);
   - location 2: a_inst_pos_yaw (divisor 1), location 3: a_inst_scale_tint
     (divisor 1) — 32 байта на инстанс, упаковка packTint из local-map-worker.ts;
   - t_zoning: usampler2D (RG8UI, строго GL_NEAREST), t_terraform: sampler2D
     (R8, GL_LINEAR).
   Сферическое проседание Δz = R_p − sqrt(R_p² − r²) выполняется в вершинных
   шейдерах по uniform u_planetRadiusM (0.0 — плоская карта, старое поведение). */

import { CENTER_HEX_APOTHEM_RATIO } from './local-map-geometry.ts';

// ============================================================
//  structure.vert — Instanced structures vertex shader
// ============================================================
export const STRUCTURE_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

// Per-vertex (из VAO модуля)
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;

// Per-instance (divisor = 1)
layout(location = 2) in vec4 a_inst_pos_yaw;     // (x, y, z, yaw)
layout(location = 3) in vec4 a_inst_scale_tint;   // (sx, sy, sz, packed_tint)

uniform mat4 u_viewProj;
uniform vec3 u_lightDir;         // normalised, world space
uniform vec3 u_fogColor;
uniform float u_fogStart;        // 0.75 * R_gen
uniform float u_fogEnd;          // R_gen
uniform float u_planetRadiusM;   // <= 1.0 — сферическое проседание выключено

out vec3 v_normal;
out vec3 v_worldPos;
out vec4 v_tint;
out float v_fog;

vec4 unpackTint(float packed) {
  uint u = floatBitsToUint(packed);
  return vec4(
    float(u & 0xFFu),
    float((u >> 8u) & 0xFFu),
    float((u >> 16u) & 0xFFu),
    float((u >> 24u) & 0xFFu)
  ) / 255.0;
}

void main() {
  float c = cos(a_inst_pos_yaw.w);
  float s = sin(a_inst_pos_yaw.w);
  float sx = a_inst_scale_tint.x;
  float sy = a_inst_scale_tint.y;
  float sz = a_inst_scale_tint.z;

  // T * R_z * S  (column-major)
  mat4 model = mat4(
     sx*c,  sx*s, 0.0, 0.0,
    -sy*s,  sy*c, 0.0, 0.0,
     0.0,   0.0,  sz,  0.0,
     a_inst_pos_yaw.x, a_inst_pos_yaw.y, a_inst_pos_yaw.z, 1.0
  );

  vec4 worldPos = model * vec4(a_position, 1.0);

  // Здания стоят на изогнутой поверхности: та же формула проседания, что и у
  // рельефа, — без зависания над сферическим горизонтом.
  float r2 = dot(worldPos.xy, worldPos.xy);
  float curvatureDrop = (u_planetRadiusM > 1.0)
    ? (u_planetRadiusM - sqrt(max(0.0, u_planetRadiusM * u_planetRadiusM - r2)))
    : 0.0;
  vec4 curvedPos = vec4(worldPos.x, worldPos.y, worldPos.z - curvatureDrop, 1.0);
  gl_Position   = u_viewProj * curvedPos;

  // Нормаль: (R * S)^-T ≈ R * S^-1 для осевого масштабирования
  mat3 normalMat = mat3(
     c/sx,  s/sx, 0.0,
    -s/sy,  c/sy, 0.0,
     0.0,   0.0,  1.0/sz
  );
  v_normal   = normalize(normalMat * a_normal);
  v_worldPos = worldPos.xyz;
  v_tint     = unpackTint(a_inst_scale_tint.w);

  // Circular distance fog
  float dist = length(worldPos.xy);     // от центра карты (origin)
  v_fog = clamp((dist - u_fogStart) / (u_fogEnd - u_fogStart), 0.0, 1.0);
}
`;

// ============================================================
//  structure.frag — Instanced structures fragment shader
// ============================================================
export const STRUCTURE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

in vec3  v_normal;
in vec3  v_worldPos;
in vec4  v_tint;
in float v_fog;

uniform vec3  u_lightDir;
uniform vec3  u_ambientColor;
uniform vec3  u_fogColor;

out vec4 fragColor;

void main() {
  // Simple directional + ambient
  vec3 N = normalize(v_normal);
  float NdL = max(dot(N, u_lightDir), 0.0);

  vec3 diffuse = v_tint.rgb * (u_ambientColor + vec3(NdL));

  // Простейшее AO: затемнение у основания (z близко к 0)
  float ao = smoothstep(0.0, 0.3, v_worldPos.z / 20.0);  // 20м = масштаб здания
  diffuse *= mix(0.6, 1.0, ao);

  // Fog
  vec3 finalColor = mix(diffuse, u_fogColor, v_fog);

  fragColor = vec4(finalColor, 1.0);
}
`;

// ============================================================
//  terrain.vert — Terrain vertex shader
// ============================================================
export const TERRAIN_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in float a_waterMask;
layout(location = 3) in vec2 a_ringLocal;
layout(location = 4) in float a_riverMask;

uniform mat4 u_viewProj;
uniform float u_fogStart;
uniform float u_fogEnd;
uniform float u_terrainSize;     // 2 * R_gen в метрах
uniform float u_planetRadiusM;   // <= 1.0 — плоская карта (обратная совместимость)

out vec3 v_worldPos;
out vec3 v_normal;
out vec2 v_uv;         // для сэмплинга зон
out float v_fog;
out vec3 v_viewVec;    // вектор от точки поверхности к камере (для Fresnel и блика воды)
out float v_waterMask; // семантическая маска воды, нормализованная в 0..1
out vec2 v_ringLocal;  // локальные XY ячейки для batch-draw без per-cell uniform
out float v_riverMask; // семантическая маска стрежня юбки, 0..1

void main() {
  v_waterMask = a_waterMask;
  v_ringLocal = a_ringLocal;
  v_riverMask = a_riverMask;
  // v_worldPos хранит ИСХОДНУЮ гипсометрическую высоту a_position.z: вода
  // (z <= 0) и изолинии считаются над уровнем моря, а не по просевшему z.
  v_worldPos  = a_position;
  v_normal    = a_normal;

  // UV: мировые координаты → [0,1] (центр карты = 0.5, 0.5)
  v_uv = a_position.xy / u_terrainSize + 0.5;

  float dist = length(a_position.xy);
  v_fog = clamp((dist - u_fogStart) / (u_fogEnd - u_fogStart), 0.0, 1.0);

  // Сферическое проседание касательной плоскости: Δz = R − sqrt(R² − r²).
  float r2 = dot(a_position.xy, a_position.xy);
  float curvatureDrop = (u_planetRadiusM > 1.0)
    ? (u_planetRadiusM - sqrt(max(0.0, u_planetRadiusM * u_planetRadiusM - r2)))
    : 0.0;
  vec3 curvedPos = vec3(a_position.x, a_position.y, a_position.z - curvatureDrop);
  gl_Position = u_viewProj * vec4(curvedPos, 1.0);

  // Положение камеры в мировых координатах из обратной матрицы перспективы:
  // столбец invViewProj[2] пропорционален однородным координатам глаза камеры.
  float vpDet = determinant(u_viewProj);
  mat4 invViewProj = (abs(vpDet) > 1e-12) ? inverse(u_viewProj) : mat4(1.0);
  vec4 camHom = invViewProj[2];
  vec3 camEye = (abs(camHom.w) > 1e-7)
    ? (camHom.xyz / camHom.w)
    : vec3(0.0, -max(u_terrainSize * 0.45, 400.0), max(u_terrainSize * 0.35, 300.0));
  v_viewVec = camEye - curvedPos;
}
`;

// ============================================================
//  terrain.frag — Terrain fragment shader
// ============================================================
export const TERRAIN_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

in vec3  v_worldPos;
in vec3  v_normal;
in vec2  v_uv;
in float v_fog;
in vec3  v_viewVec;
in float v_waterMask;
in vec2 v_ringLocal;
in float v_riverMask;

uniform usampler2D u_zoning_map;     // RG8UI
uniform sampler2D  u_terraform_map;  // R8
uniform vec3  u_lightDir;
uniform vec3  u_ambientColor;
uniform vec3  u_fogColor;
uniform vec3  u_horizonColor;        // цвет атмосферного лимба у горизонта
uniform float u_fogStart;
uniform float u_fogEnd;
uniform float u_isSkirt;             // 1.0 — планетарная юбка, 0.0 — центр/кольца
uniform float u_ringLevel;           // 0 — центр/юбка, 1..5 — кольцевой LOD
uniform float u_ringFade;            // 0 — полная детализация, 1 — дальнее кольцо
uniform float u_focusRadiusM;        // радиус детального участка R_patch
uniform float u_hexSizeM;            // шаг гексов d_hex в метрах

out vec4 fragColor;

// Палитра живой долины: солнечные луга и тёплые грунтовые площадки усадеб.
const vec3 ZONE_COLORS[5] = vec3[5](
  vec3(0.36, 0.49, 0.20),   // 0: залитый солнцем травянистый склон
  vec3(0.46, 0.48, 0.28),   // 1: жилая усадьба (травяно-землистый двор)
  vec3(0.56, 0.49, 0.37),   // 2: хозяйственная площадка (тёплая терракота)
  vec3(0.52, 0.47, 0.35),   // 3: периметр (утоптанный грунт)
  vec3(0.58, 0.52, 0.42)    // 4: центральный двор (светлая песчаная почва)
);

// Вода/озёра/русла (И-3.2, И-3.3, Stage-8.6): прозрачная бирюзовая отмель и
// глубокая тёмно-индиговая океаническая бездна.
const vec3 SHALLOW_WATER_COLOR = vec3(0.14, 0.46, 0.50);
const vec3 DEEP_WATER_COLOR    = vec3(0.02, 0.13, 0.25);

/**
 * Гексагональная метрика правильного шестиугольника: hexMetric2D(p) = 1 —
 * граница гекса с апофемой 1 (плоские стороны смотрят на 30°, 90°, 150°…),
 * вершины лежат на 0°, 60°, 120°…
 */
float hexMetric2D(vec2 p) {
  vec2 a = abs(p);
  return max(a.x * 0.8660254 + a.y * 0.5, a.y);
}

/** Компактный детерминированный 2D-хеш без sin()-артефактов точности. */
float terrainHash2D(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** Плавный 2D value-шум с эрмитовой интерполяцией в диапазоне [0, 1]. */
float terrainValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = terrainHash2D(i);
  float b = terrainHash2D(i + vec2(1.0, 0.0));
  float c = terrainHash2D(i + vec2(0.0, 1.0));
  float d = terrainHash2D(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Билинейный сэмплер RG8UI-карты зон с мягкой долей покрытия. */
void sampleZoningBilinear(vec3 naturalColor, out vec3 zoneColor, out float zoneWeight) {
  vec2 zGrid = v_uv * 64.0 - 0.5;
  ivec2 ij = ivec2(floor(zGrid));
  vec2 f = smoothstep(0.0, 1.0, fract(zGrid));

  uint z00 = texelFetch(u_zoning_map, clamp(ij + ivec2(0, 0), ivec2(0), ivec2(63)), 0).r;
  uint z10 = texelFetch(u_zoning_map, clamp(ij + ivec2(1, 0), ivec2(0), ivec2(63)), 0).r;
  uint z01 = texelFetch(u_zoning_map, clamp(ij + ivec2(0, 1), ivec2(0), ivec2(63)), 0).r;
  uint z11 = texelFetch(u_zoning_map, clamp(ij + ivec2(1, 1), ivec2(0), ivec2(63)), 0).r;
  vec3 c00 = (z00 > 0u && z00 < 5u) ? ZONE_COLORS[z00] : naturalColor;
  vec3 c10 = (z10 > 0u && z10 < 5u) ? ZONE_COLORS[z10] : naturalColor;
  vec3 c01 = (z01 > 0u && z01 < 5u) ? ZONE_COLORS[z01] : naturalColor;
  vec3 c11 = (z11 > 0u && z11 < 5u) ? ZONE_COLORS[z11] : naturalColor;
  float w00 = (z00 > 0u && z00 < 5u) ? 1.0 : 0.0;
  float w10 = (z10 > 0u && z10 < 5u) ? 1.0 : 0.0;
  float w01 = (z01 > 0u && z01 < 5u) ? 1.0 : 0.0;
  float w11 = (z11 > 0u && z11 < 5u) ? 1.0 : 0.0;

  zoneColor = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
  zoneWeight = mix(mix(w00, w10, f.x), mix(w01, w11, f.x), f.y);
}

void main() {
  bool isCentral = u_isSkirt < 0.5 && u_ringLevel < 0.5;
  bool isRing = u_isSkirt < 0.5 && u_ringLevel >= 0.5;
  float ringFade = isRing ? clamp(u_ringFade, 0.0, 1.0) : 0.0;
  float dist = length(v_worldPos.xy);
  // Апофема активного центрального гекса и гексагональная метрика (ориентация clusterHexMetric: yx).
  float hexApothem = u_focusRadiusM * ${CENTER_HEX_APOTHEM_RATIO.toFixed(3)};
  float centerHexDist = hexMetric2D(v_worldPos.yx);
  float ringHexDist = isRing ? hexMetric2D(v_ringLocal.yx) : 0.0;

  // Центральный участок обрезается строгим правильным шестиугольником:
  // 6 прямых сторон активного гекса (с микрозапасом 1.003 для бесшовного
  // перекрытия с воротником юбки). Страховочное круглое отсечение теперь
  // покрывает и вершины гекса (R_описанный ≈ 0,66395·R_patch).
  if (isCentral && u_focusRadiusM > 1.0 && dist > u_focusRadiusM * ${((CENTER_HEX_APOTHEM_RATIO / (Math.sqrt(3) / 2)) * 1.01).toFixed(6)}) {
    discard;
  }
  if (isCentral && u_focusRadiusM > 1.0 && centerHexDist > hexApothem * 1.003) {
    discard;
  }
  // Каждая кольцевая сетка покрывает квадрат вокруг собственного центра;
  // общий гексагональный срез убирает перекрытия соседних LOD-ячеек.
  if (isRing && u_focusRadiusM > 1.0 && ringHexDist > hexApothem * 1.003) {
    discard;
  }

  // Юбка не наследует краевые тексели карт центрального участка.
  uint zone = 0u;
  float terraformBlend = 0.0;
  float rawTerraform = 1.0;
  float minNeighborTf1 = 1.0;
  float minNeighborTf2 = 1.0;
  float maxNeighborTf3 = 0.0;
  if (isCentral) {
    rawTerraform = texture(u_terraform_map, v_uv).r;
    float tfE1 = textureOffset(u_terraform_map, v_uv, ivec2( 1,  0)).r;
    float tfW1 = textureOffset(u_terraform_map, v_uv, ivec2(-1,  0)).r;
    float tfN1 = textureOffset(u_terraform_map, v_uv, ivec2( 0,  1)).r;
    float tfS1 = textureOffset(u_terraform_map, v_uv, ivec2( 0, -1)).r;
    float tfNE = textureOffset(u_terraform_map, v_uv, ivec2( 1,  1)).r;
    float tfNW = textureOffset(u_terraform_map, v_uv, ivec2(-1,  1)).r;
    float tfSE = textureOffset(u_terraform_map, v_uv, ivec2( 1, -1)).r;
    float tfSW = textureOffset(u_terraform_map, v_uv, ivec2(-1, -1)).r;
    minNeighborTf1 = min(
      min(min(tfE1, tfW1), min(tfN1, tfS1)),
      min(min(tfNE, tfNW), min(tfSE, tfSW))
    );
    float tfE2 = textureOffset(u_terraform_map, v_uv, ivec2( 2,  0)).r;
    float tfW2 = textureOffset(u_terraform_map, v_uv, ivec2(-2,  0)).r;
    float tfN2 = textureOffset(u_terraform_map, v_uv, ivec2( 0,  2)).r;
    float tfS2 = textureOffset(u_terraform_map, v_uv, ivec2( 0, -2)).r;
    minNeighborTf2 = min(minNeighborTf1, min(min(tfE2, tfW2), min(tfN2, tfS2)));
    float tfE4 = textureOffset(u_terraform_map, v_uv, ivec2( 4,  0)).r;
    float tfW4 = textureOffset(u_terraform_map, v_uv, ivec2(-4,  0)).r;
    float tfN4 = textureOffset(u_terraform_map, v_uv, ivec2( 0,  4)).r;
    float tfS4 = textureOffset(u_terraform_map, v_uv, ivec2( 0, -4)).r;
    maxNeighborTf3 = max(
      max(max(max(tfE1, tfW1), max(tfN1, tfS1)), max(max(tfE2, tfW2), max(tfN2, tfS2))),
      max(max(tfE4, tfW4), max(tfN4, tfS4))
    );

    vec2 zGrid = v_uv * 64.0 - 0.5;
    ivec2 nearestZone = clamp(ivec2(floor(zGrid + 0.5)), ivec2(0), ivec2(63));
    zone = texelFetch(u_zoning_map, nearestZone, 0).r;
    terraformBlend = rawTerraform;
    // Цвет зон полностью гасим до границы активного гекса: на срезе центральный
    // меш и юбка используют один и тот же природный цвет без скачка.
    float innerEdgeFade = 1.0 - smoothstep(hexApothem * 0.58, hexApothem * 0.90, centerHexDist);
    terraformBlend *= innerEdgeFade;
  }

  // Первые 3–4 круга гексов остаются чёткими: оптическое размытие начинается
  // только за clearHexRadius и плавно нарастает к дальним кольцам горизонта.
  float clearHexRadius = hexApothem * 3.6;
  float blur = (u_focusRadiusM > 1.0 && u_fogEnd * 0.92 > clearHexRadius)
    ? smoothstep(clearHexRadius, u_fogEnd * 0.92, centerHexDist)
    : ((u_focusRadiusM > 1.0 && centerHexDist > clearHexRadius) ? 1.0 : 0.0);
  // Единый LOD-fade сглаживает нормали, рябь и макроцвет до общей дымки юбки.
  blur = max(blur, ringFade * 0.85);

  // Признак водного зеркала дополнительно проверяет сырую маску терраформинга
  // в центре и неизменность мировой высоты на юбке: пологая суша не может
  // ошибочно попасть в цвет океана ни при каком масштабе.
  vec3 rawSafeNormal = (dot(v_normal, v_normal) > 1e-8)
    ? normalize(v_normal)
    : vec3(0.0, 0.0, 1.0);
  // A-17b: одинаковая полоса затухания микрорельефа по обе стороны грани.
  // Внутри резкость плавно нарастает от границы, снаружи возвращается после
  // воротника; скачка normal/slope, делавшего центр отдельной плиткой, нет.
  float centerEdgeSmooth = isCentral
    ? smoothstep(hexApothem * 0.70, hexApothem * 0.98, centerHexDist)
    : 0.0;
  float skirtEdgeSmooth = (u_isSkirt >= 0.5)
    ? 1.0 - smoothstep(hexApothem * 1.02, hexApothem * 1.35, centerHexDist)
    : 0.0;
  vec3 safeNormal = normalize(mix(rawSafeNormal, vec3(0.0, 0.0, 1.0), max(centerEdgeSmooth, skirtEdgeSmooth)));
  float normalHoriz = length(safeNormal.xy);
  float zStep = abs(dFdx(v_worldPos.z)) + abs(dFdy(v_worldPos.z));
  bool ringWater = isRing && v_waterMask > 0.5;
  bool skirtWater = u_isSkirt >= 0.5 && v_waterMask > 0.5;
  bool skirtRiver = u_isSkirt >= 0.5 && v_riverMask > 0.5;
  bool centralWater = isCentral && rawTerraform < 0.002;
  bool centralRiver = isCentral && rawTerraform >= 0.002 && rawTerraform < 0.006;
  bool waterMirrorSurface = isCentral
    ? (centralWater && zStep < 0.02)
    : isRing
      ? (ringWater && zStep < 0.005)
      : (skirtWater && normalHoriz < 0.0015 && zStep < 0.02);
  bool isFlatWaterMirror = (zone == 0u) && (normalHoriz < 0.0015) && waterMirrorSurface;

  // Stage-8.6: распознавание рек на любой высоте по явному маркеру воды
  // в terraform_map (байт 0 → rawTerraform < 0.002) и влажная галечно-песчаная
  // пойма вдоль водных текселей (0.002 <= rawTerraform < 0.012).
  bool isExplicitWaterTexel = centralWater || centralRiver || ringWater || skirtWater || skirtRiver;
  bool isRiverStream = centralRiver || skirtRiver;
  float riverBankMask = 0.0;
  if (isCentral && zone == 0u && !isFlatWaterMirror && !isExplicitWaterTexel && v_worldPos.z > 0.05) {
    bool isBankBand = (rawTerraform >= 0.002) && (rawTerraform < 0.012);
    float nearWaterEdge = max(
      1.0 - smoothstep(0.0016, 0.0052, minNeighborTf1),
      (1.0 - smoothstep(0.0016, 0.0042, minNeighborTf2)) * 0.62
    );
    float bankBandWeight = isBankBand
      ? (1.0 - smoothstep(0.0094, 0.0120, rawTerraform))
      : (1.0 - smoothstep(0.0020, 0.0420, rawTerraform)) * 0.85;
    float bankNoise = terrainValueNoise(v_worldPos.xy / max(u_focusRadiusM, 600.0) * 34.0 + vec2(9.2, -4.7));
    riverBankMask = clamp(nearWaterEdge * bankBandWeight * mix(0.80, 1.14, bankNoise), 0.0, 1.0)
      * (1.0 - smoothstep(hexApothem * 0.82, hexApothem * 0.98, centerHexDist));
  }

  // Stage-8.6: пять отчётливых гипсометрических поясов суши
  // (пляж → низинный луг → предгорья → высокогорные скалы → снежные пики).
  float altM = max(0.0, v_worldPos.z);
  float beltJitter = (!isRing || u_ringLevel < 4.5)
    ? (terrainValueNoise(v_worldPos.xy / max(u_focusRadiusM, 600.0) * 2.6) - 0.5) * 18.0
    : 0.0;
  float effAltM = max(0.0, altM + beltJitter);
  float beachAltM = max(0.0, altM + beltJitter * smoothstep(2.2, 16.0, altM) * 0.32);
  float slopeSteep = clamp(1.0 - safeNormal.z, 0.0, 1.0);
  float slopeRock = smoothstep(0.03, 0.28, slopeSteep);

  // Пояс 1 (0 … 7 м): тёплый песок и ракушечник с влажной кромкой у воды (0 … 2.2 м).
  vec3 belt1Beach = mix(vec3(0.55, 0.50, 0.38), vec3(0.74, 0.68, 0.52), smoothstep(0.4, 2.2, altM));
  // Пояс 2 (7 … 85 м): речная пойма и сочные низинные луга.
  vec3 belt2Meadow = mix(vec3(0.26, 0.46, 0.18), ZONE_COLORS[0], smoothstep(10.0, 78.0, effAltM));
  // Пояс 3 (85 … 175 м): предгорья, оливково-охристый суглинок и сухие террасы.
  vec3 belt3Foothill = mix(vec3(0.49, 0.50, 0.26), vec3(0.58, 0.52, 0.34), smoothstep(90.0, 168.0, effAltM));
  // Пояс 4 (175 … 290 м): субальпийское высокогорье, буро-сланцевый и базальтовый камень.
  vec3 belt4Rock = mix(vec3(0.48, 0.45, 0.41), vec3(0.36, 0.35, 0.34), slopeRock * 0.46);
  // Пояс 5 (> 290 м): светлый гранит и снежно-ледниковые шапки на гребнях;
  // отвесные сбросы остаются тёмно-каменными.
  float snowSlopeRetention = clamp(1.0 - slopeSteep * 0.55, 0.0, 1.0)
    * (1.0 - smoothstep(0.18, 0.38, slopeSteep) * 0.66);
  float snowCover = clamp(smoothstep(278.0, 316.0, effAltM) * snowSlopeRetention, 0.0, 1.0);
  vec3 alpineGranite = mix(vec3(0.54, 0.53, 0.52), vec3(0.36, 0.35, 0.35), slopeRock * 0.68);
  vec3 belt5Alpine = mix(alpineGranite, vec3(0.86, 0.90, 0.94), snowCover);

  vec3 naturalColor = belt1Beach;
  naturalColor = mix(naturalColor, belt2Meadow,   smoothstep(5.4, 9.0, beachAltM));
  naturalColor = mix(naturalColor, belt3Foothill, smoothstep(75.0, 95.0, effAltM));
  naturalColor = mix(naturalColor, belt4Rock,     smoothstep(164.0, 187.0, effAltM));
  naturalColor = mix(naturalColor, belt5Alpine,   smoothstep(278.0, 304.0, effAltM));

  // Тонкие изолинии каждые 16 м остаются только внутри активного гекса:
  // плавно затухают до границы hexApothem и полностью погашены на юбке.
  float contourPhase = abs(fract(v_worldPos.z / 16.0) - 0.5);
  float contourFade  = (u_focusRadiusM > 1.0)
    ? (1.0 - smoothstep(hexApothem * 0.72, hexApothem * 0.96, centerHexDist))
    : 1.0;
  float contourLine  = (isFlatWaterMirror || isRiverStream)
    ? 0.0
    : (1.0 - smoothstep(0.0, 0.045, contourPhase)) * contourFade * (isCentral ? 1.0 : 0.0);
  naturalColor      *= (1.0 - 0.05 * contourLine);

  // 3 каскада процедурной текстуры поверхности суши (v_worldPos.z > 0.0)
  // в нормированных мировых координатах (единое поле для центра и юбки).
  // Ровное водное зеркало (в том числе озеро выше seaLevel) сухопутной
  // текстуры не получает вовсе.
  if (v_worldPos.z > 0.0 && !isFlatWaterMirror && (!isRing || u_ringLevel < 4.5)) {
    vec2 surfCoord = v_worldPos.xy / max(u_focusRadiusM, 1.0);
    const mat2 OCTAVE_ROT = mat2(0.80, 0.60, -0.60, 0.80);
    float vegBeltMask = smoothstep(6.0, 11.5, beachAltM) * (1.0 - smoothstep(158.0, 190.0, effAltM));
    float highRockMask = smoothstep(160.0, 195.0, effAltM) * (1.0 - snowCover * 0.85);

    // Кольца 3–4 сохраняют макрорельеф, но не тратят ALU на микро- и meso-зерно.
    if (!isRing || u_ringLevel < 2.5) {
    // 1. Ближний каскад: микрозерно травы и дернины в растительных поясах,
    //    нейтральное минерально-фирновое зерно на песке, скалах и снежниках.
    float microFade = 1.0 - smoothstep(0.0, 0.52, blur);
    float microGrain = terrainValueNoise(surfCoord * 44.0) * 0.62
      + terrainValueNoise((OCTAVE_ROT * surfCoord) * 96.0 + vec2(13.7, 7.9)) * 0.38;
    vec3 meadowGrain = mix(vec3(0.86, 0.92, 0.78), vec3(1.10, 1.07, 0.97), microGrain);
    vec3 mineralGrain = mix(vec3(0.93, 0.94, 0.95), vec3(1.06, 1.06, 1.07), microGrain);
    vec3 surfaceGrain = mix(mineralGrain, meadowGrain, vegBeltMask);
    float grainStrength = microFade * mix(0.66, 0.28, snowCover);
    naturalColor *= mix(vec3(1.0), surfaceGrain, grainStrength);
    float erosionNoise = terrainValueNoise((OCTAVE_ROT * surfCoord) * 10.5 + vec2(7.3, -4.8));
    float erosionThread = 1.0 - smoothstep(0.025, 0.095, abs(erosionNoise - 0.50));
    float trailBreakup = smoothstep(0.36, 0.72, terrainValueNoise(surfCoord * 5.2 + vec2(-8.1, 3.6)));
    float trailMask = erosionThread * trailBreakup * microFade * vegBeltMask;
    naturalColor = mix(naturalColor, vec3(0.61, 0.55, 0.39), trailMask * 0.20);

    // 2. Средний каскад: пятнистость дернины в долине/предгорьях, умеренные
    //    конусы осыпей на склонах и усиленный выход скал и кулуаров в поясе 4.
    float mesoFade = 1.0 - smoothstep(0.20, 0.86, blur);
    float mesoPatch = terrainValueNoise(surfCoord * 7.5 + vec2(4.2, -9.1)) * 0.60
      + terrainValueNoise((OCTAVE_ROT * surfCoord) * 17.5 + vec2(-6.4, 15.3)) * 0.40;
    vec3 biomeMottle = mix(vec3(0.24, 0.40, 0.15), vec3(0.48, 0.51, 0.25), mesoPatch);
    vec3 slopeRockTone = mix(vec3(0.33, 0.31, 0.29), vec3(0.51, 0.48, 0.44), mesoPatch);
    float talusBelt = smoothstep(55.0, 105.0, effAltM) * (1.0 - smoothstep(235.0, 285.0, effAltM));
    float talusMask = smoothstep(0.03, 0.09, slopeSteep)
      * (1.0 - smoothstep(0.16, 0.30, slopeSteep)) * talusBelt;
    vec3 talusTone = vec3(0.64, 0.59, 0.49) * mix(0.94, 1.04, mesoPatch);
    float boostedSlopeRock = clamp(
      slopeRock * mix(1.0, 1.42, highRockMask) + highRockMask * 0.24,
      0.0, 1.0
    ) * (1.0 - snowCover * 0.82);
    naturalColor = mix(naturalColor, biomeMottle, mesoFade * 0.18 * vegBeltMask);
    naturalColor = mix(naturalColor, slopeRockTone, boostedSlopeRock * 0.64 * mesoFade);
    naturalColor = mix(naturalColor, talusTone, talusMask * 0.28 * mesoFade);

    vec2 gullyCoord = vec2(
      dot(surfCoord, vec2(0.92, 0.39)) * 23.0,
      dot(surfCoord, vec2(-0.39, 0.92)) * 3.6
    );
    float gullyNoise = terrainValueNoise(gullyCoord + vec2(11.7, -6.2));
    float couloir = (1.0 - smoothstep(0.035, 0.13, abs(gullyNoise - 0.50)))
      * smoothstep(0.32, 0.70, mesoPatch);
    float couloirDepth = mix(0.22, 0.38, highRockMask) * (1.0 - snowCover * 0.55);
    naturalColor *= 1.0 - couloirDepth * couloir * boostedSlopeRock * mesoFade;
    }

    // 3. Дальний каскад: крупномасштабная светотень котловин без затирания
    //    5 высотных поясов и воздушная перспектива горных хребтов.
    float macroBasin = terrainValueNoise(surfCoord * 1.35 + vec2(-11.2, 5.8)) * 0.65
      + terrainValueNoise((OCTAVE_ROT * surfCoord) * 3.10 + vec2(8.6, -14.4)) * 0.35;
    float macroShade = mix(0.91, 1.09, macroBasin);
    naturalColor *= mix(1.0, macroShade, mix(0.14, 0.30, blur) * (1.0 - snowCover * 0.45));
    vec3 mountainHaze = mix(u_fogColor, u_horizonColor, 0.42);
    float aerialPerspective = smoothstep(0.12, 0.92, v_fog) * mix(0.06, 0.26, blur);
    naturalColor = mix(naturalColor, mountainHaze, aerialPerspective);

    // Влажная галечно-песчаная пойма вдоль берегов речного русла на любой высоте.
    if (riverBankMask > 0.0) {
      float pebbleNoise = terrainValueNoise(surfCoord * 68.0 + vec2(-5.4, 8.1));
      vec3 wetShingle = vec3(0.41, 0.39, 0.33);
      vec3 dryPebble  = vec3(0.65, 0.60, 0.48);
      float wetEdge   = 1.0 - smoothstep(0.0015, 0.0068, rawTerraform);
      vec3 bankColor  = mix(dryPebble, wetShingle, wetEdge * 0.72) * mix(0.92, 1.08, pebbleNoise);
      naturalColor    = mix(naturalColor, bankColor, riverBankMask * 0.88);
    }
  }

  // Застройка остаётся маленькими усадьбами в зелени: вместо бетонной
  // сетки 64×64 — мягкие проплешины и тропинки тёплого грунта.
  vec3 zoneColor = naturalColor;
  float zoneWeight = 0.0;
  if (isCentral) {
    sampleZoningBilinear(naturalColor, zoneColor, zoneWeight);
    vec2 padCoord = v_worldPos.xy / max(u_focusRadiusM, 1.0);
    float padPatch = terrainValueNoise(padCoord * 9.5 + vec2(3.8, 12.4));
    float pathNoise = terrainValueNoise(padCoord * 4.2 + vec2(-15.1, 2.7));
    float footpath = 1.0 - smoothstep(0.035, 0.13, abs(pathNoise - 0.50));
    float padFade = 1.0 - blur * 0.80;
    // Шум органически размывает билинейную границу поселения, не оставляя
    // квадратных углов, а внутренние дворы превращает в мягкие пятна грунта.
    if (zoneWeight > 0.0 && zoneWeight < 1.0) {
      zoneWeight = smoothstep(0.0, 1.0, clamp(zoneWeight + (padPatch - 0.5) * 0.28, 0.0, 1.0));
    }
    if (zoneWeight > 0.0) {
      vec3 bareSoil = mix(zoneColor, vec3(0.64, 0.56, 0.40), 0.48);
      zoneColor = mix(zoneColor, bareSoil, smoothstep(0.34, 0.72, padPatch) * 0.55 * padFade);
      zoneColor = mix(zoneColor, vec3(0.62, 0.55, 0.41), footpath * 0.28 * padFade);
    }
  }
  vec3 baseColor = mix(naturalColor, zoneColor, terraformBlend * zoneWeight * 0.36);

  // Stage-8.5.1: мягкая кромка прибоя. На полярной сетке юбки 145 × 85
  // переходный треугольник «океан ↔ суша» имеет две вершины z == 0 и одну
  // z > 0, поэтому интерполяция даёт v_worldPos.z > 0 по ВСЕЙ площади
  // треугольника и вода обрывалась строго по прямым рёбрам треугольников.
  // Двухоктавный шум береговой кромки искривляет урез на малых высотах
  // (0…5.5 м), поэтому линия прибоя проходит сквозь внутренность
  // треугольников плавной природной дугой без единого зубца.
  vec2 shoreUv = v_worldPos.xy / max(u_focusRadiusM, 600.0);
  float shoreWave = (terrainValueNoise(shoreUv * 3.4 + vec2(4.1, -2.7)) - 0.5) * 1.8
                  + (terrainValueNoise(shoreUv * 9.8 + vec2(-7.3, 5.4)) - 0.5) * 0.7;
  float effectiveShoreZ = v_worldPos.z + shoreWave * smoothstep(0.0, 5.0, v_worldPos.z);
  bool coastalBand = isRing ? ringWater : (skirtWater || centralWater);
  bool isCoastalShore = coastalBand && (effectiveShoreZ < 4.8);

  // И-3.2/И-3.3 и Stage-8.6: объёмная глубокая вода с батиметрией, двухоктавной
  // микро-рябью волн, Fresnel-отражением неба, солнечным бликом и пеной прибоя.
  float waterSurfaceMask = 0.0;
  float waterSpecTerm = 0.0;
  vec3 waterSurfaceNormal = vec3(0.0, 0.0, 1.0);
  if (zone == 0u && (v_worldPos.z <= 0.0 || ringWater || skirtWater || isFlatWaterMirror || isCoastalShore || isRiverStream)) {
    float depthBelowZero = max(0.0, -v_worldPos.z);
    float waterBlend = isFlatWaterMirror ? 1.0 : smoothstep(0.0, 3.0, depthBelowZero);

    // Оптическая глубина waterDepthM: реальная отрицательная батиметрия,
    // плавный уход в глубину от берега/центра и подводная батиметрическая волна.
    float bathyWave = terrainValueNoise(shoreUv * 0.85) * 18.0;
    float bathyShelf = terrainValueNoise(shoreUv * 2.35 + vec2(-4.8, 7.1)) * 6.0;
    float openSeaProgress = smoothstep(0.08, 2.40, dist / max(u_focusRadiusM, 600.0));
    float centerHexShoalFade = 1.0 - smoothstep(hexApothem * 0.62, hexApothem * 0.92, centerHexDist);
    float nearLandInHex = isCentral
      ? smoothstep(0.003, 0.0075, maxNeighborTf3) * centerHexShoalFade
      : 0.0;
    float surfShoal = 1.0 - smoothstep(0.0, 1.75, effectiveShoreZ);

    float waterDepthM = 0.0;
    if (isRiverStream) {
      float thalweg = (centralRiver || skirtRiver)
        ? 1.0 : (1.0 - smoothstep(0.0, 0.0019, rawTerraform));
      waterDepthM = mix(1.4, 8.8, thalweg) + terrainValueNoise(shoreUv * 14.0) * 3.2;
    } else if (isFlatWaterMirror && v_worldPos.z > 0.0) {
      waterDepthM = (openSeaProgress * 16.0 + bathyWave * 0.85 + bathyShelf * 0.60)
        * (1.0 - nearLandInHex * 0.80);
    } else {
      // Единая C1-непрерывная формула через v_worldPos.z == 0.0: на океане
      // (z <= 0) surfShoal == 1.0, а на прибрежных треугольниках юбки (z > 0)
      // плавно выводит глубину к прозрачной отмели у линии прибоя без скачка по рёбрам.
      float pelagicDepth = openSeaProgress * 22.0 + bathyWave + bathyShelf;
      waterDepthM = (depthBelowZero * 1.35 + pelagicDepth) * surfShoal
        * (1.0 - nearLandInHex * 0.78);
    }

    // Трёхступенчатый градиент глубины: прозрачная бирюзовая отмель
    // (SHALLOW_WATER_COLOR) → морская лазурь → глубокая индиговая бездна.
    vec3 midAzureWater = vec3(0.05, 0.30, 0.44);
    vec3 abyssWater = mix(vec3(0.02, 0.13, 0.25), DEEP_WATER_COLOR, 0.5);
    vec3 waterColor = mix(SHALLOW_WATER_COLOR, midAzureWater, smoothstep(0.7, 9.5, waterDepthM));
    waterColor = mix(waterColor, abyssWater, smoothstep(8.5, 32.0, waterDepthM));

    // Двухоктавная скрещённая микро-рябь волн (18.0 и 42.0), модулирующая
    // нормаль водной глади, мягкий солнечный блик и Fresnel-отражение неба.
    // Кольцо 5 оставляет только базовый градиент глубины без микро-ALU.
    float waveOct2 = 0.0;
    float waterSpec = 0.0;
    if (!isRing || u_ringLevel < 4.5) {
    const mat2 WAVE_ROT = mat2(0.80, -0.60, 0.60, 0.80);
    float waveOct1 = terrainValueNoise(shoreUv * 18.0);
    waveOct2 = terrainValueNoise(shoreUv * 42.0);
    float waveCross1 = terrainValueNoise((WAVE_ROT * shoreUv) * 18.0 + vec2(6.3, -4.1));
    float waveCross2 = terrainValueNoise((WAVE_ROT * shoreUv) * 42.0 + vec2(-9.2, 5.7));
    float waveRipple = (waveOct1 - 0.5) * 0.36 + (waveCross1 - 0.5) * 0.32
                     + (waveOct2 - 0.5) * 0.17 + (waveCross2 - 0.5) * 0.15;

    float rippleFade = 1.0 - smoothstep(0.18, 0.86, blur);
    float waveDx = (terrainValueNoise(shoreUv * 18.0 + vec2(0.32, 0.0)) - waveOct1) * 0.65
                 + (terrainValueNoise((WAVE_ROT * shoreUv) * 42.0 + vec2(-8.88, 5.7)) - waveCross2) * 0.35;
    float waveDy = (terrainValueNoise(shoreUv * 18.0 + vec2(0.0, 0.32)) - waveOct1) * 0.65
                 + (terrainValueNoise(shoreUv * 42.0 + vec2(0.0, 0.32)) - waveOct2) * 0.35;
    vec3 waterBaseN = isRiverStream
      ? normalize(mix(safeNormal, vec3(0.0, 0.0, 1.0), 0.78))
      : vec3(0.0, 0.0, 1.0);
    waterSurfaceNormal = normalize(vec3(
      waterBaseN.xy + vec2(waveDx, waveDy) * (0.26 * rippleFade),
      waterBaseN.z
    ));

    waterColor += vec3(0.04, 0.07, 0.08) * waveRipple * rippleFade
      * (1.0 - smoothstep(2.0, 16.0, waterDepthM));

    vec3 viewDir = (dot(v_viewVec, v_viewVec) > 1e-6)
      ? normalize(v_viewVec)
      : normalize(vec3(-v_worldPos.xy * 0.35, max(u_focusRadiusM * 0.65, 300.0)));
    vec3 sunDir = (dot(u_lightDir, u_lightDir) > 1e-6)
      ? normalize(u_lightDir)
      : vec3(0.0, 0.0, 1.0);
    float NoV = clamp(dot(waterSurfaceNormal, viewDir), 0.0, 1.0);
    float oneMinusNoV = 1.0 - NoV;
    float fresnel = (oneMinusNoV * oneMinusNoV) * (oneMinusNoV * oneMinusNoV);
    waterColor = mix(waterColor, u_horizonColor, fresnel * 0.32);

    vec3 halfSum = sunDir + viewDir;
    vec3 halfVec = (dot(halfSum, halfSum) > 1e-6) ? normalize(halfSum) : vec3(0.0, 0.0, 1.0);
    float NoH = max(dot(waterSurfaceNormal, halfVec), 1e-4);
    float horizonSpecFade = 1.0 - smoothstep(0.65, 0.98, v_fog);
    waterSpec = (pow(NoH, 44.0) * 0.24 + pow(NoH, 160.0) * 0.26)
              * mix(0.55, 1.0, rippleFade) * horizonSpecFade;
    }

    float riverWater = isRiverStream
      ? ((centralRiver || skirtRiver) ? 1.0 : (1.0 - smoothstep(0.0014, 0.0021, rawTerraform) * 0.24))
      : 0.0;
    float shoreWater = (isFlatWaterMirror || ringWater || skirtWater)
      ? 1.0
      : max(max(waterBlend, riverWater), 1.0 - smoothstep(0.0, 1.8, effectiveShoreZ));
    float waterOpacity = mix(0.86, 0.99, smoothstep(1.5, 10.0, waterDepthM));
    waterSurfaceMask = clamp(shoreWater * waterOpacity, 0.0, 1.0);
    waterSpecTerm = waterSpec * shoreWater;
    baseColor = mix(baseColor, waterColor, waterSurfaceMask);

    // Тонкая светлая пенная кромка прибоя вдоль полосы 0.0 < effectiveShoreZ < 1.6.
    if (!isFlatWaterMirror && !isRiverStream && coastalBand
        && (!isRing || u_ringLevel < 2.5)
        && effectiveShoreZ > 0.0 && effectiveShoreZ < 1.6) {
      float foamNoise = terrainValueNoise(shoreUv * 28.0 + vec2(3.7, -6.2)) * 0.62 + waveOct2 * 0.38;
      float foamEnvelope = smoothstep(0.02, 0.36, effectiveShoreZ)
                         * (1.0 - smoothstep(0.88, 1.58, effectiveShoreZ));
      float foamLine = foamEnvelope * smoothstep(0.26, 0.74, foamNoise) * (1.0 - blur * 0.68);
      baseColor = mix(baseColor, vec3(0.90, 0.95, 0.97), foamLine * 0.76);
    }

    // Влажный тёмно-песчаный накат и сухая песчаная полоса пляжа выше прибоя.
    if (!isFlatWaterMirror && !isRiverStream && coastalBand && (!isRing || u_ringLevel < 4.5)) {
      float wetSwash = smoothstep(0.9, 1.8, effectiveShoreZ)
        * (1.0 - smoothstep(2.0, 3.0, effectiveShoreZ));
      float beachBand = smoothstep(1.8, 3.0, effectiveShoreZ)
        * (1.0 - smoothstep(3.6, 4.8, effectiveShoreZ));
      baseColor = mix(baseColor, vec3(0.55, 0.50, 0.38), wetSwash * 0.62);
      baseColor = mix(baseColor, vec3(0.74, 0.68, 0.52), beachBand * 0.72);
    }
  }

  // Деликатная кромка ТОЛЬКО активного гекса: узкая приглушённая линия
  // поверх непрерывного ландшафта, без светящихся фасок и сетки соседей.
  float hexGlow = 0.0;
  float hexCoreLine = 0.0;
  if (isCentral && u_focusRadiusM > 1.0) {
    hexGlow = smoothstep(hexApothem * 0.975, hexApothem * 0.998, centerHexDist)
      * (1.0 - smoothstep(hexApothem * 0.998, hexApothem * 1.022, centerHexDist));
    hexCoreLine = smoothstep(hexApothem * 0.991, hexApothem * 0.999, centerHexDist)
      * (1.0 - smoothstep(hexApothem * 0.999, hexApothem * 1.007, centerHexDist));
  }

  // Нормаль освещения едина для центра и юбки; на воде подмешивается рябь волн.
  vec3 terrainN = normalize(mix(safeNormal, vec3(0.0, 0.0, 1.0), blur * 0.72));
  vec3 N = normalize(mix(terrainN, waterSurfaceNormal, waterSurfaceMask));
  vec3 lightVec = (dot(u_lightDir, u_lightDir) > 1e-6) ? normalize(u_lightDir) : vec3(0.0, 0.0, 1.0);
  float NdL = max(dot(N, lightVec), 0.0);
  vec3 lit  = baseColor * (u_ambientColor + vec3(NdL * 0.8))
            + vec3(1.0, 0.96, 0.88) * waterSpecTerm;

  if (isCentral && u_focusRadiusM > 1.0) {
    vec3 hexRimColor = mix(vec3(0.22, 0.78, 0.88), vec3(0.92, 0.97, 1.0), hexCoreLine);
    float hexRimWeight = clamp(hexGlow * 0.18 + hexCoreLine * 0.58, 0.0, 0.68);
    lit = mix(lit, hexRimColor, hexRimWeight);
  }

  // Воздушная дымка и туман начинаются только за пределами активного гекса;
  // рельеф рендерится непрозрачно (alpha = 1.0) встык с куполом неба.
  float outsideHex = (u_focusRadiusM > 1.0)
    ? smoothstep(hexApothem * 0.98, hexApothem * 1.15, centerHexDist)
    : 1.0;
  vec3 finalColor;
  if (u_focusRadiusM > 1.0) {
    float haze = smoothstep(0.0, 0.72, v_fog) * 0.68 * outsideHex;
    vec3 hazed = mix(lit, u_horizonColor, haze);
    finalColor = mix(hazed, u_fogColor, smoothstep(0.35, 0.98, v_fog) * outsideHex);
  } else {
    finalColor = mix(lit, u_fogColor, v_fog);
  }
  fragColor = vec4(finalColor, 1.0);
}
`;

// ============================================================
//  sky-dome.vert — полноэкранный треугольник купола неба/лимба
// ============================================================
export const SKY_DOME_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

out vec2 v_ndc;

void main() {
  // Полноэкранный треугольник без атрибутов и буферов (gl_VertexID 0..2).
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_ndc = p * 2.0 - 1.0;
  // z = 0.9999: купол рисуется с depthMask(false), рельеф всегда проходит тест.
  gl_Position = vec4(p * 2.0 - 1.0, 0.9999, 1.0);
}
`;

// ============================================================
//  sky-dome.frag — сферический горизонт, лимб атмосферы и солнечный ореол
// ============================================================
export const SKY_DOME_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_ndc;

uniform float u_camPitch;        // наклон камеры, рад
uniform float u_camYaw;          // азимут камеры, рад
uniform float u_fovY;            // вертикальный FOV, рад
uniform float u_aspect;          // ширина / высота
uniform float u_camHeightM;      // высота камеры над поверхностью, м
uniform float u_planetRadiusM;   // R_p, м
uniform vec3  u_lightDir;        // направление на солнце, нормализовано
uniform vec3  u_fogColor;        // плотная дымка планетарного диска
uniform vec3  u_horizonColor;    // светящийся атмосферный лимб
uniform float u_skyAlpha;        // 1 — непрозрачный купол (по умолчанию)

out vec4 fragColor;

float skyHash2D(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** Гладкий 2D value-шум для облачной проекции на плоскость небосвода. */
float skyValueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = skyHash2D(i);
  float b = skyHash2D(i + vec2(1.0, 0.0));
  float c = skyHash2D(i + vec2(0.0, 1.0));
  float d = skyHash2D(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Пять октав с поворотом: крупные облачные массы и мягкие кучевые края. */
float skyFbm(vec2 p) {
  const mat2 OCTAVE_ROT = mat2(0.80, 0.60, -0.60, 0.80);
  float sum = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 5; octave++) {
    sum += skyValueNoise(p) * amplitude;
    p = (OCTAVE_ROT * p) * 2.03 + vec2(13.1, 7.7);
    amplitude *= 0.5;
  }
  return sum / 0.96875;
}

void main() {
  float tanHalfY = tan(u_fovY * 0.5);

  // Базис камеры совпадает с localViewProjection планетарной страницы.
  vec3 forward = normalize(vec3(
    -cos(u_camPitch) * cos(u_camYaw),
    -cos(u_camPitch) * sin(u_camYaw),
    -sin(u_camPitch)
  ));
  vec3 right = vec3(-sin(u_camYaw), cos(u_camYaw), 0.0);
  vec3 up = vec3(
    -sin(u_camPitch) * cos(u_camYaw),
    -sin(u_camPitch) * sin(u_camYaw),
     cos(u_camPitch)
  );
  vec3 dir = normalize(
    forward
    + right * (v_ndc.x * tanHalfY * u_aspect)
    + up * (v_ndc.y * tanHalfY)
  );

  // Физический угол депрессии сферического горизонта: θ = −acos(R/(R+h)).
  float horizonCos = clamp(
    u_planetRadiusM / (u_planetRadiusM + max(1.0, u_camHeightM)),
    0.0, 1.0
  );
  float horizonAngle = -acos(horizonCos);
  float beta = asin(clamp(dir.z, -1.0, 1.0));

  // Дневное небо: молочно-голубая дымка над горами переходит в глубокий
  // серо-голубой зенит, без ночного космоса и звёзд.
  vec3 zenithColor = vec3(0.38, 0.50, 0.66);
  float skyT = smoothstep(horizonAngle, horizonAngle + 0.85, beta);
  vec3 sky = mix(u_horizonColor, zenithColor, skyT);
  float horizonMilk = 1.0 - smoothstep(horizonAngle, horizonAngle + 0.28, beta);
  sky = mix(sky, mix(u_fogColor, u_horizonColor, 0.65), horizonMilk * 0.28);

  // Мягкий дневной солнечный ореол остаётся под облачным слоем.
  float sunDot = max(dot(dir, normalize(u_lightDir)), 0.0);
  float halo = pow(sunDot, 24.0) * 0.14 + pow(sunDot, 160.0) * 0.48;
  sky += vec3(1.0, 0.94, 0.80) * halo;

  // Слоисто-кучевая облачность на плоской проекции луча. Два масштаба
  // пятиоктавного шума образуют отдельные нижний и высокий слои; разница
  // полей даёт объёмные серебристые вершины и серо-сизые основания.
  if (beta > horizonAngle - 0.04) {
    vec2 cloudPlane = dir.xy / max(dir.z + 0.22, 0.12);
    vec2 stratifiedPlane = cloudPlane * vec2(0.78, 1.22);
    float cloudBase = skyFbm(stratifiedPlane * 0.82 + vec2(3.7, -8.2));
    float cloudDetail = skyFbm(stratifiedPlane * 2.15 + vec2(-11.4, 5.6));
    float cloudField = cloudBase * 0.74 + cloudDetail * 0.26;
    float lowerCloud = smoothstep(0.47, 0.65, cloudField);
    float upperCloud = smoothstep(0.57, 0.74, cloudDetail) * 0.34;
    float cloudDensity = clamp(lowerCloud + upperCloud * (1.0 - lowerCloud), 0.0, 1.0);
    float cloudHorizonFade = smoothstep(horizonAngle - 0.04, horizonAngle + 0.20, beta);
    cloudDensity *= cloudHorizonFade;

    float silverLining = clamp(0.46 + (cloudDetail - cloudBase) * 2.60 + sunDot * 0.16, 0.0, 1.0);
    float topLight = smoothstep(0.18, 0.82, silverLining);
    vec3 cloudBaseColor = vec3(0.52, 0.56, 0.62);
    vec3 cloudTopColor = vec3(0.95, 0.96, 0.98);
    vec3 cloudColor = mix(cloudBaseColor, cloudTopColor, topLight);
    cloudColor = mix(cloudColor, cloudTopColor, upperCloud * 0.30);
    float cloudDistanceHaze = 1.0 - smoothstep(horizonAngle + 0.02, horizonAngle + 0.38, beta);
    cloudColor = mix(cloudColor, u_horizonColor, cloudDistanceHaze * 0.65);
    sky = mix(sky, cloudColor, cloudDensity * mix(0.68, 0.90, skyT));
  }

  // Диск планеты ниже линии горизонта: плотная дымка, в которую без шва
  // уходит сферическая юбка горизонта рельефа.
  float diskT = smoothstep(horizonAngle - 0.12, horizonAngle, beta);
  vec3 disk = mix(u_fogColor, u_horizonColor, diskT);
  float above = smoothstep(horizonAngle - 0.12, horizonAngle + 0.08, beta);

  vec3 color = mix(disk, sky, above);
  fragColor = vec4(color, clamp(u_skyAlpha, 0.0, 1.0));
}
`;
