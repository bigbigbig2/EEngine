/**
 * color_grading：线性 HDR 色彩分级着色器。
 *
 * 参考 Filament ColorGrading（Apache-2.0，见 docs/references/porting/R5-0x-color-grading.md）
 * 的 lift/gamma/gain、saturation、contrast 不变量，全程保持在线性 HDR 域；
 * tone mapping 与 sRGB 编码由后续 TonemapPass 完成，本阶段不做任何非线性输出变换。
 *
 * 默认参数（lift=gamma=gain=1、saturation=1、contrast=1）为恒等变换，保证
 * ColorGrading 作为固定顺序中的常开阶段不改变像素值。
 */

export const COLOR_GRADING_FORMAT = "rgba16float" as const;

export const COLOR_GRADING_WGSL = /* wgsl */ `
const POS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

const REC709_LUMA = vec3f(0.2126, 0.7152, 0.0722);

struct ColorGradingSettings {
  lift: vec3f,
  gamma: vec3f,
  gain: vec3f,
  saturation: f32,
  contrast: f32,
};

@group(0) @binding(0) var input_color: texture_2d<f32>;
@group(0) @binding(1) var<uniform> settings: ColorGradingSettings;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  return vec4f(POS[vi], 0.0, 1.0);
}

fn rgb_luminance(c: vec3f) -> f32 {
  return dot(c, REC709_LUMA);
}

@fragment
fn fs_main(@builtin(position) coord: vec4f) -> @location(0) vec4f {
  var color = textureLoad(input_color, vec2i(coord.xy), 0).rgb;

  // 1. ASC CDL lift/gamma/gain（线性域，逐通道）：
  //    out = (color * gain + lift) ^ (1/gamma)
  //    默认 lift=0 / gamma=1 / gain=1 为恒等变换。
  let slope = color * settings.gain + settings.lift;
  color = pow(max(slope, vec3f(0.0)), vec3f(1.0) / max(settings.gamma, vec3f(1e-4)));

  // 2. saturation：向 Rec.709 亮度混合，saturation=1 恒等。
  let luma = rgb_luminance(color);
  color = mix(vec3f(luma), color, settings.saturation);

  // 3. contrast：log2 空间按通道斜率缩放（等价 Filament 的 log2 contrast），
  //    contrast=1 恒等。
  color = exp2(log2(max(color, vec3f(1e-5))) * settings.contrast);

  return vec4f(color, 1.0);
}
`;
