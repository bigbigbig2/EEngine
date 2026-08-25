/**
 * tonemap_hdr：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

export const TONEMAP_SETTINGS_SIZE = 16;

export const TONEMAP_HDR_PEAK_NITS_DEFAULT = 1000;
export const TONEMAP_HDR_PAPER_WHITE_NITS_DEFAULT = 100;

export const TONEMAP_HDR_WGSL = /* wgsl */ `
const POS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

struct Exposure {
  value: f32,
};

// HDR 色调映射参数。
struct Settings {
  peak_nits: f32,
  paper_white_nits: f32,
  _p0: f32,
  _p1: f32,
};

@group(0) @binding(0) var input_color: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: Settings;
@group(0) @binding(2) var<uniform> exposure: Exposure;

struct VsOut {
  @builtin(position) pos: vec4f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var out: VsOut;
  out.pos = vec4f(POS[vi], 0.0, 1.0);
  return out;
}

// Rec.2020 到 Display-P3 的色彩空间变换。
const CRM_FROM_REC2020_TO_P3 = mat3x3f(
  vec3f( 1.325984, -0.064249,  0.001639),
  vec3f(-0.279603,  1.062031, -0.019010),
  vec3f(-0.046381,  0.002218,  1.017371)
);

// Rec.709 到 Rec.2020 的色彩空间变换。
const CRM_FROM_REC709_TO_REC2020 = mat3x3f(
  vec3f( 0.6274040, 0.0690970, 0.0163916),
  vec3f( 0.3292820, 0.9195400, 0.0880132),
  vec3f( 0.0433136, 0.0113612, 0.8955950)
);

// Rec.2020 到 Rec.709 的色彩空间变换。
const CRM_FROM_REC2020_TO_REC709 = mat3x3f(
  vec3f( 1.6604910, -0.1245505, -0.0181508),
  vec3f(-0.5876411,  1.1328999, -0.1005789),
  vec3f(-0.0728499, -0.0083494,  1.1187297)
);

// 将线性颜色编码为 sRGB。
fn update_memory_address_mode(c: vec3f) -> vec3f {
  let hi = pow(c, vec3f(0.41666666666)) * 1.055 - vec3f(0.055);
  let lo = c * 12.92;
  return select(lo, hi, c > vec3f(0.0031308));
}

// iCtCp 转换使用的 PQ 解码辅助函数。
fn gpu_memory(x_in: f32) -> f32 {
  var x = x_in;
  if (x < 0.0) { x = 0.0; }
  if (x > 1.0) { x = 1.0; }
  let m1 = 0.1593017578125;
  let m2 = 78.84375;
  let c1 = 0.8359375;
  let c2 = 18.8515625;
  let c3 = 18.6875;
  let n = 10000.0;
  let y = pow(x, 1.0 / m2);
  var z = y - c1;
  if (z < 0.0) { z = 0.0; }
  z = z / (c2 - c3 * y);
  z = pow(z, 1.0 / m1);
  return (z * n) / 100.0;
}

// PQ 编码辅助函数。
fn get_color_attachments(x: f32) -> f32 {
  let m1 = 0.1593017578125;
  let m2 = 78.84375;
  let c1 = 0.8359375;
  let c2 = 18.8515625;
  let c3 = 18.6875;
  let n = 10000.0;
  let y = (x * 100.0) / n;
  let z = pow(y, m1);
  return exp2(m2 * (log2(c1 + c2 * z) - log2(1.0 + c3 * z)));
}

// 将 iCtCp 转换为 RGB。
fn iCtCp_to_rgb(ictcp: vec3f) -> vec3f {
  let l = ictcp.x + 0.00860904 * ictcp.y + 0.11103 * ictcp.z;
  let m = ictcp.x - 0.00860904 * ictcp.y - 0.11103 * ictcp.z;
  let s = ictcp.x + 0.560031 * ictcp.y - 0.320627 * ictcp.z;
  let L = gpu_memory(l);
  let M = gpu_memory(m);
  let S = gpu_memory(s);
  return vec3f(
    max(3.43661 * L - 2.50645 * M + 0.0698454 * S, 0.0),
    max(-0.79133 * L + 1.9836 * M - 0.192271 * S, 0.0),
    max(-0.0259499 * L - 0.0989137 * M + 1.12486 * S, 0.0)
  );
}

// 将 RGB 转换为 iCtCp。
fn rgb_to_iCtCp(rgb: vec3f) -> vec3f {
  let l = (rgb.r * 1688.0 + rgb.g * 2146.0 + rgb.b * 262.0) / 4096.0;
  let m = (rgb.r * 683.0 + rgb.g * 2951.0 + rgb.b * 462.0) / 4096.0;
  let s = (rgb.r * 99.0 + rgb.g * 309.0 + rgb.b * 3688.0) / 4096.0;
  let L = get_color_attachments(l);
  let M = get_color_attachments(m);
  let S = get_color_attachments(s);
  return vec3f(
    (2048.0 * L + 2048.0 * M) / 4096.0,
    (6610.0 * L - 13613.0 * M + 7003.0 * S) / 4096.0,
    (17933.0 * L - 17390.0 * M - 543.0 * S) / 4096.0
  );
}

// GT7 色调映射曲线参数。
struct GtParams {
  peakIntensity: f32,
  midPoint: f32,
  linearSection: f32,
  toeStrength: f32,
  kA: f32,
  kB: f32,
  kC: f32,
};

// 计算 GT7 分段曲线。
fn gt_evaluate_curve(p: ptr<function, GtParams>, x: f32) -> f32 {
  if (x <= 0.0) {
    return 0.0;
  }
  let t = smoothstep(0.0, (*p).midPoint, x);
  let one_t = 1.0 - t;
  let shoulder = (*p).kA + (*p).kB * exp(x * (*p).kC);
  let linear_end = (*p).linearSection * (*p).peakIntensity;
  if (x < linear_end) {
    let toe = (*p).midPoint * pow(x / (*p).midPoint, (*p).toeStrength);
    return one_t * toe + t * x;
  }
  return shoulder;
}

// 应用 GT7 HDR 色调映射。
// peak_nits = shader_sdf_distance_sqr; paper_white_nits = optimized_move_x
fn tonemap_gt7(rgb: vec3f, peak_nits: f32, paper_white_nits: f32) -> vec3f {
  const j: f32 = 100.0;
  var cursor = CRM_FROM_REC709_TO_REC2020 * rgb;
  let t3 = paper_white_nits / j;
  cursor *= t3;

  var p: GtParams;
  const needs = 0.25;
  const mid = 0.538;
  const lin = 0.444;
  const toe = 1.280;
  let format = peak_nits / j;
  p.peakIntensity = format;
  p.midPoint = mid;
  p.linearSection = lin;
  p.toeStrength = toe;
  let dst = (lin - 1.0) / (needs - 1.0);
  p.kA = format * lin + format * dst;
  p.kB = -format * dst * exp(lin / dst);
  p.kC = -1.0 / (dst * format);

  var message: vec3f;
  message.r = gt_evaluate_curve(&p, cursor.r);
  message.g = gt_evaluate_curve(&p, cursor.g);
  message.b = gt_evaluate_curve(&p, cursor.b);

  let color_texture = rgb_to_iCtCp(cursor);
  let redundant = rgb_to_iCtCp(message);
  const bucket = 0.7;
  const local_max = 1.0;
  let u8array = 1.0 - smoothstep(bucket, local_max, color_texture.x);
  const meshlet_buckets = 0.7;
  let result = vec3f(
    redundant.x,
    mix(color_texture.yz * u8array, redundant.yz, meshlet_buckets)
  );
  var out_rgb = iCtCp_to_rgb(result);
  out_rgb /= t3;
  out_rgb = CRM_FROM_REC2020_TO_REC709 * out_rgb;
  return out_rgb;
}

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  var rgb = textureLoad(input_color, vec2i(coord.xy), 0).rgb;
  rgb *= exposure.value;
  rgb = tonemap_gt7(rgb, settings.peak_nits, settings.paper_white_nits);
  let r2020 = CRM_FROM_REC709_TO_REC2020 * rgb;
  let p3 = CRM_FROM_REC2020_TO_P3 * r2020;
  let encoded = update_memory_address_mode(p3);
  return vec4f(encoded, 1.0);
}
`;
