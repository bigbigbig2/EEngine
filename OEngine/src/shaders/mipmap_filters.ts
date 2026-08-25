/**
 * mipmap_filters：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

export const MIPMAP_PARAMS_BYTES = 8;

export const MIPMAP_FULLSCREEN_VERTEX_WGSL = /* wgsl */ `
const positions = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  var output: VertexOutput;
  let ndc = positions[vertex_index];
  output.position = vec4f(ndc, 0.0, 1.0);
  output.uv = fma(ndc, vec2f(0.5, -0.5), vec2f(0.5));
  return output;
}
`;

const MIPMAP_BINDINGS = /* wgsl */ `
struct MipmapParams {
  output_resolution: vec2u,
};

@group(0) @binding(0) var img_sampler: sampler;
@group(0) @binding(1) var img: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: MipmapParams;
`;

const UV_TO_TEXEL = /* wgsl */ `
fn uv_to_texel_coordinate(uv: vec2f, resolution: vec2u) -> vec2f {
  return fma(uv, vec2f(resolution), vec2f(-0.5));
}

fn texel_coordinate_to_uv(texel: vec2f, resolution: vec2u) -> vec2f {
  return (texel + 0.5) / vec2f(resolution);
}
`;

const BC_CUBIC = /* wgsl */ `
fn debug_group_size(value: f32, b: f32, c: f32) -> f32 {
  let x = abs(value);
  var result = 0.0;
  let x2 = x * x;
  let x3 = x * x * x;
  if (x < 1.0) {
    result =
      (12.0 - 9.0 * b - 6.0 * c) * x3 +
      (-18.0 + 12.0 * b + 6.0 * c) * x2 +
      (6.0 - 2.0 * b);
  } else if (x <= 2.0) {
    result =
      (-b - 6.0 * c) * x3 +
      (6.0 * b + 30.0 * c) * x2 +
      (-12.0 * b - 48.0 * c) * x +
      (8.0 * b + 24.0 * c);
  }
  return result / 6.0;
}
`;

export const MIPMAP_FILTER_LINEAR_WGSL = /* wgsl */ `
${MIPMAP_BINDINGS}

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(img, img_sampler, uv);
}
`;

export const MIPMAP_FILTER_LINEAR_NORMAL_WGSL = /* wgsl */ `
${MIPMAP_BINDINGS}

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let sample_value = textureSample(img, img_sampler, uv);
  var normal = sample_value.rgb * 2.0 - 1.0;
  normal = normalize(normal);
  normal = normal * 0.5 + 0.5;
  return vec4f(normal, sample_value.a);
}
`;

export const MIPMAP_FILTER_MAGIC_BASE_WGSL = /* wgsl */ `
${MIPMAP_BINDINGS}
${UV_TO_TEXEL}

fn filter_magic_kernel(value: f32) -> f32 {
  let x = abs(value);
  if (x <= 0.5) {
    return 0.75 - x * x;
  } else if (x <= 1.5) {
    let edge = 1.5 - x;
    return 0.5 * edge * edge;
  }
  return 0.0;
}

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let input_resolution = textureDimensions(img, 0);
  let output_resolution = params.output_resolution;
  let scale = max(
    vec2f(1.0),
    vec2f(input_resolution) / vec2f(output_resolution)
  );
  let center = uv_to_texel_coordinate(uv, input_resolution);
  const support = 1.5;
  let radius = support * scale;
  let minimum = vec2u(max(floor(center - radius), vec2f(0.0)));
  let maximum = vec2u(min(
    ceil(center + radius),
    vec2f(input_resolution) - 1.0
  ));
  var color = vec4f(0.0);
  var weight_sum = 0.0;
  for (var y = minimum.y; y <= maximum.y; y++) {
    let distance_y = abs(f32(y) - center.y) / scale.y;
    if (distance_y >= support) { continue; }
    let weight_y = filter_magic_kernel(distance_y);
    for (var x = minimum.x; x <= maximum.x; x++) {
      let distance_x = abs(f32(x) - center.x) / scale.x;
      if (distance_x >= support) { continue; }
      let weight = filter_magic_kernel(distance_x) * weight_y;
      color += textureLoad(img, vec2u(x, y), 0) * weight;
      weight_sum += weight;
    }
  }
  if (weight_sum > 0.00001) {
    color /= weight_sum;
  }
  return color;
}
`;

export const MIPMAP_FILTER_MITCHELL_WGSL = /* wgsl */ `
${MIPMAP_BINDINGS}
${UV_TO_TEXEL}
${BC_CUBIC}

fn filter_mitchell(value: f32) -> f32 {
  return debug_group_size(value, 1.0 / 3.0, 1.0 / 3.0);
}

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let input_resolution = textureDimensions(img, 0);
  let output_resolution = params.output_resolution;
  let scale = max(
    vec2f(1.0),
    vec2f(input_resolution) / vec2f(output_resolution)
  );
  let center = uv_to_texel_coordinate(uv, input_resolution);
  let radius = scale;
  let minimum = vec2u(max(floor(center - radius), vec2f(0.0)));
  let maximum = vec2u(min(
    ceil(center + radius),
    vec2f(input_resolution) - 1.0
  ));
  var color = vec4f(0.0);
  var weight_sum = 0.0;
  for (var y = minimum.y; y <= maximum.y; y++) {
    let weight_y = filter_mitchell(abs(f32(y) - center.y) / scale.y * 2.0);
    for (var x = minimum.x; x <= maximum.x; x++) {
      let weight_x = filter_mitchell(abs(f32(x) - center.x) / scale.x * 2.0);
      let weight = weight_x * weight_y;
      color += textureLoad(img, vec2u(x, y), 0) * weight;
      weight_sum += weight;
    }
  }
  if (weight_sum > 0.00001) {
    color /= weight_sum;
  }
  return color;
}
`;

export const MIPMAP_FILTER_MKS_2021_WGSL = /* wgsl */ `
${MIPMAP_BINDINGS}
${UV_TO_TEXEL}

fn filter_mks_2021(value: f32) -> f32 {
  let x = abs(value);
  if (x <= 0.5) {
    return (577.0 / 576.0) - (239.0 / 144.0) * x * x;
  } else if (x <= 1.5) {
    return (1.0 / 144.0) * (140.0 * x * x - 379.0 * x + 239.0);
  } else if (x <= 2.5) {
    return -(1.0 / 144.0) * (24.0 * x * x - 113.0 * x + 130.0);
  } else if (x <= 3.5) {
    return (1.0 / 144.0) * (4.0 * x * x - 27.0 * x + 45.0);
  } else if (x <= 4.5) {
    let edge = 2.0 * x - 9.0;
    return -(1.0 / 1152.0) * edge * edge;
  }
  return 0.0;
}

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let input_resolution = textureDimensions(img, 0);
  let output_resolution = params.output_resolution;
  let scale = max(
    vec2f(1.0),
    vec2f(input_resolution) / vec2f(output_resolution)
  );
  let center = uv_to_texel_coordinate(uv, input_resolution);
  var radius = vec2f(5.0);
  if (scale.x > 1.0) { radius.x = ceil(3.5 * scale.x); }
  if (scale.y > 1.0) { radius.y = ceil(3.5 * scale.y); }
  let minimum = vec2u(max(floor(center - radius), vec2f(0.0)));
  let maximum = vec2u(min(
    ceil(center + radius),
    vec2f(input_resolution) - 1.0
  ));
  var color = vec4f(0.0);
  var weight_sum = 0.0;
  for (var y = minimum.y; y <= maximum.y; y++) {
    let distance_y = abs(f32(y) - center.y) / scale.y;
    if (distance_y >= 4.5) { continue; }
    let weight_y = filter_mks_2021(distance_y);
    for (var x = minimum.x; x <= maximum.x; x++) {
      let distance_x = abs(f32(x) - center.x) / scale.x;
      if (distance_x >= 4.5) { continue; }
      let weight = filter_mks_2021(distance_x) * weight_y;
      color += textureLoad(img, vec2u(x, y), 0) * weight;
      weight_sum += weight;
    }
  }
  if (weight_sum > 1e-7) {
    color /= weight_sum;
  }
  return color;
}
`;

export const MIPMAP_FILTER_MAGIC_SHARP_WGSL = /* wgsl */ `
${MIPMAP_BINDINGS}

fn add_children(distance: i32) -> f32 {
  if (distance == 0) { return 17.0 / 12.0; }
  else if (distance == 1) { return -35.0 / 144.0; }
  else if (distance == 2) { return 1.0 / 24.0; }
  else if (distance == 3) { return -1.0 / 144.0; }
  return 0.0;
}

@fragment
fn main(
  @builtin(position) fragment_position: vec4f,
  @location(0) uv: vec2f
) -> @location(0) vec4f {
  let input_resolution = textureDimensions(img, 0);
  let center = vec2i(floor(fragment_position.xy));
  const radius = 3;
  let minimum = max(center - radius, vec2i(0));
  let maximum = min(center + radius, vec2i(input_resolution) - 1);
  var color = vec4f(0.0);
  var weight_sum = 0.0;
  for (var y = minimum.y; y <= maximum.y; y++) {
    let weight_y = add_children(abs(y - center.y));
    for (var x = minimum.x; x <= maximum.x; x++) {
      let weight = add_children(abs(x - center.x)) * weight_y;
      color += textureLoad(img, vec2i(x, y), 0) * weight;
      weight_sum += weight;
    }
  }
  if (weight_sum > 0.00001) {
    color /= weight_sum;
  }
  return color;
}
`;

export const MIPMAP_FILTER_CATMULL_ROM_WGSL = /* wgsl */ `
${MIPMAP_BINDINGS}
${UV_TO_TEXEL}
${BC_CUBIC}

fn filter_catmullrom(value: f32) -> f32 {
  return debug_group_size(value, 0.0, 0.5);
}

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let input_resolution = textureDimensions(img, 0);
  let output_resolution = params.output_resolution;
  let scale = max(
    vec2f(1.0),
    vec2f(input_resolution) / vec2f(output_resolution)
  );
  let center = uv_to_texel_coordinate(uv, input_resolution);
  let radius = scale;
  let minimum = vec2u(max(floor(center - radius), vec2f(0.0)));
  let maximum = vec2u(min(
    ceil(center + radius),
    vec2f(input_resolution) - 1.0
  ));
  var color = vec4f(0.0);
  var weight_sum = 0.0;
  for (var y = minimum.y; y <= maximum.y; y++) {
    let weight_y = filter_catmullrom(abs(f32(y) - center.y) / scale.y * 2.0);
    for (var x = minimum.x; x <= maximum.x; x++) {
      let weight_x = filter_catmullrom(abs(f32(x) - center.x) / scale.x * 2.0);
      let weight = weight_x * weight_y;
      color += textureLoad(img, vec2u(x, y), 0) * weight;
      weight_sum += weight;
    }
  }
  if (weight_sum > 0.00001) {
    color /= weight_sum;
  }
  return color;
}
`;

export const MIPMAP_FILTER_WRONSKI_2021_WGSL = /* wgsl */ `
${MIPMAP_BINDINGS}
${UV_TO_TEXEL}

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let input_resolution = textureDimensions(img, 0);
  let output_resolution = params.output_resolution;
  let scale = max(
    vec2f(1.0),
    (vec2f(input_resolution) * 0.5) / vec2f(output_resolution)
  );
  let center = uv_to_texel_coordinate(uv, input_resolution);
  const offsets = array<f32, 6>(
    -5.198, -3.151, -1.331, 1.331, 3.151, 5.198
  );
  const weights = array<f32, 6>(
    0.115, -0.304, 0.689, 0.689, -0.304, 0.115
  );
  var color = vec4f(0.0);
  var weight_sum = 0.0;
  for (var y = 0; y < 6; y++) {
    for (var x = 0; x < 6; x++) {
      let weight = weights[x] * weights[y];
      let sample_texel = center + vec2f(offsets[x], offsets[y]) * scale;
      let sample_uv = texel_coordinate_to_uv(sample_texel, input_resolution);
      color += textureSampleLevel(img, img_sampler, sample_uv, 0.0) * weight;
      weight_sum += weight;
    }
  }
  if (weight_sum > 0.00001) {
    color /= weight_sum;
  }
  return color;
}
`;

export const MIPMAP_FILTER_WGSL_BY_ID: Readonly<Record<number, string>> = {
  0: MIPMAP_FILTER_LINEAR_WGSL,
  1: MIPMAP_FILTER_LINEAR_NORMAL_WGSL,
  2: MIPMAP_FILTER_MITCHELL_WGSL,
  3: MIPMAP_FILTER_MAGIC_BASE_WGSL,
  4: MIPMAP_FILTER_MKS_2021_WGSL,
  5: MIPMAP_FILTER_MAGIC_SHARP_WGSL,
  6: MIPMAP_FILTER_CATMULL_ROM_WGSL,
  7: MIPMAP_FILTER_WRONSKI_2021_WGSL
};
