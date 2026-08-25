/**
 * hzb_reduce：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

const FS_VS = /* wgsl */ `
const POS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var out: VsOut;
  let p = POS[vi];
  out.pos = vec4f(p, 0.0, 1.0);
  // 全屏三角的纹理坐标使用 WebGPU 屏幕空间方向：X 从左到右，
  // Y 从上到下。这里必须保留 fma 的表达式顺序和 Y 轴负缩放；普通的
  // p * 0.5 + 0.5 会把 HZB 每一级垂直镜像，破坏细层级的深度对应关系。
  out.uv = fma(p, vec2f(0.5, -0.5), vec2f(0.5));
  return out;
}
`;

export const HZB_FROM_DEPTH_WGSL = /* wgsl */ `
${FS_VS}

struct ResUbo {
  width: u32,
  height: u32,
};

@group(0) @binding(0) var<uniform> output_resolution: ResUbo;
@group(0) @binding(1) var this_hit: texture_depth_2d;

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f,
) -> @location(0) vec2f {
  let output_texel_size2 = 0.5 / vec2f(f32(output_resolution.width), f32(output_resolution.height));
  let uv_min = uv - output_texel_size2;
  let uv_max = uv + output_texel_size2;

  let source_resolution = textureDimensions(this_hit);
  let source_resolution_f = vec2f(source_resolution);

  const EPSILON: f32 = 1e-6;
  let safe_uv_min = uv_min + EPSILON;
  let safe_uv_max = uv_max - EPSILON;

  let source_bounds_min = max(
    vec2i(floor(safe_uv_min * source_resolution_f)),
    vec2i(0)
  );
  let source_bounds_max = min(
    vec2i(ceil(safe_uv_max * source_resolution_f)),
    vec2i(source_resolution) - vec2i(1)
  );

  // reverse-Z: far≈0 near≈1；初值 min=1 max=0 再收紧
  var out_min: f32 = 1.0;
  var out_max: f32 = 0.0;

  for (var y = source_bounds_min.y; y <= source_bounds_max.y; y++) {
    for (var x = source_bounds_min.x; x <= source_bounds_max.x; x++) {
      let d = textureLoad(this_hit, vec2i(x, y), 0);
      out_min = min(d, out_min);
      out_max = max(d, out_max);
    }
  }
  return vec2f(out_min, out_max);
}
`;

export const HZB_FROM_DEPTH_CLIP_WGSL = /* wgsl */ `
${FS_VS}

struct ClipRegion {
  value: vec4f,
};

struct ResUbo {
  width: u32,
  height: u32,
};

@group(0) @binding(0) var<uniform> clip_region: ClipRegion;
@group(0) @binding(1) var<uniform> output_resolution: ResUbo;
@group(0) @binding(2) var this_hit: texture_depth_2d;

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f,
) -> @location(0) vec2f {
  let output_texel_size2 = 0.5 / vec2f(
    f32(output_resolution.width),
    f32(output_resolution.height)
  );
  let uv_min = uv - output_texel_size2;
  let uv_max = uv + output_texel_size2;

  const EPSILON: f32 = 1e-6;
  let safe_uv_min = uv_min + EPSILON;
  let safe_uv_max = uv_max - EPSILON;
  let local_resolution = clip_region.value.zw;

  let local_bounds_min = max(
    vec2i(floor(safe_uv_min * local_resolution)),
    vec2i(0)
  );
  let local_bounds_max = min(
    vec2i(ceil(safe_uv_max * local_resolution)),
    vec2i(local_resolution)
  );
  let atlas_offset = vec2i(clip_region.value.xy);
  let source_bounds_min = local_bounds_min + atlas_offset;
  let source_bounds_max = local_bounds_max + atlas_offset;

  var out_min: f32 = 1.0;
  var out_max: f32 = 0.0;
  for (var y = source_bounds_min.y; y < source_bounds_max.y; y++) {
    for (var x = source_bounds_min.x; x < source_bounds_max.x; x++) {
      let d = textureLoad(this_hit, vec2i(x, y), 0);
      out_min = min(d, out_min);
      out_max = max(d, out_max);
    }
  }
  return vec2f(out_min, out_max);
}
`;

export const HZB_REDUCE_MIP_WGSL = /* wgsl */ `
${FS_VS}

struct ResUbo {
  width: u32,
  height: u32,
};

@group(0) @binding(0) var<uniform> output_resolution: ResUbo;
@group(0) @binding(1) var this_hit: texture_2d<f32>;

@fragment
fn fs_main(
  @builtin(position) coord: vec4f,
  @location(0) uv: vec2f,
) -> @location(0) vec2f {
  let output_texel_size2 = 0.5 / vec2f(f32(output_resolution.width), f32(output_resolution.height));
  let uv_min = uv - output_texel_size2;
  let uv_max = uv + output_texel_size2;

  let source_resolution = textureDimensions(this_hit);
  let source_resolution_f = vec2f(source_resolution);

  const EPSILON: f32 = 1e-6;
  let safe_uv_min = uv_min + EPSILON;
  let safe_uv_max = uv_max - EPSILON;

  let source_bounds_min = max(
    vec2i(floor(safe_uv_min * source_resolution_f)),
    vec2i(0)
  );
  let source_bounds_max = min(
    vec2i(ceil(safe_uv_max * source_resolution_f)),
    vec2i(source_resolution) - vec2i(1)
  );

  var out_min: f32 = 1.0;
  var out_max: f32 = 0.0;

  for (var y = source_bounds_min.y; y <= source_bounds_max.y; y++) {
    for (var x = source_bounds_min.x; x <= source_bounds_max.x; x++) {
      let texel = textureLoad(this_hit, vec2i(x, y), 0);
      out_min = min(texel.x, out_min);
      out_max = max(texel.y, out_max);
    }
  }
  return vec2f(out_min, out_max);
}
`;
