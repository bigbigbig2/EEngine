/**
 * tonemap_sdr：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

export const TONEMAP_EXPOSURE_SIZE = 4;

export const TONEMAP_UNADAPTED_DEFAULT_COMPENSATION = 1;

export const TONEMAP_SDR_WGSL = /* wgsl */ `
const POS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

struct Exposure {
  value: f32,
};

@group(0) @binding(0) var input_color: texture_2d<f32>;
@group(0) @binding(1) var<uniform> exposure: Exposure;

struct VsOut {
  @builtin(position) pos: vec4f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var out: VsOut;
  out.pos = vec4f(POS[vi], 0.0, 1.0);
  return out;
}

// ACES 近似曲线的分子与分母组合。
fn usd_compose_transform(x: vec3f) -> vec3f {
  let a = x * (x + 0.0245786) - 0.000090537;
  let b = x * (0.983729 * x + 0.4329510) + 0.238081;
  return a / b;
}

// 应用 ACES 风格的色彩空间变换和曲线映射。
fn scene_write_payload(c: vec3f) -> vec3f {
  let m1 = mat3x3f(
    vec3f(0.59719, 0.07600, 0.02840),
    vec3f(0.35458, 0.90834, 0.13383),
    vec3f(0.04823, 0.01566, 0.83777)
  );
  let m2 = mat3x3f(
    vec3f( 1.60475, -0.10208, -0.00327),
    vec3f(-0.53108,  1.10813, -0.07276),
    vec3f(-0.07367, -0.00605,  1.07602)
  );
  var j = m1 * c;
  j = usd_compose_transform(j);
  j = m2 * j;
  return saturate(j);
}

// 将线性颜色编码为 sRGB。
fn update_memory_address_mode(c: vec3f) -> vec3f {
  let hi = pow(c, vec3f(0.41666666666)) * 1.055 - vec3f(0.055);
  let lo = c * 12.92;
  return select(lo, hi, c > vec3f(0.0031308));
}

// 生成稳定的屏幕空间三角噪声。
fn rgbe_read_multiple_tap(p: vec2f) -> f32 {
  var s = fract(p * vec2f(5.3987, 5.4421));
  s += dot(s.yx, s.xy + vec2f(21.5351, 14.3137));
  let m = s.x * s.y;
  return fract(m * 95.4307) + fract(m * 75.04961) - 1.0;
}

// 生成适用于 8 位输出的抖动偏移。
fn dither_color_8bit_triangle_noise(p: vec2f) -> f32 {
  return rgbe_read_multiple_tap(p) / 255.0;
}

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  let ic = vec2i(coord.xy);
  var rgb = textureLoad(input_color, ic, 0).rgb;
  rgb *= exposure.value;
  rgb = scene_write_payload(rgb);
  rgb = update_memory_address_mode(rgb);
  rgb += dither_color_8bit_triangle_noise(coord.xy);
  return vec4f(rgb, 1.0);
}
`;
