/** Local VT integration, not a replacement for any Spark encoding/filtering stage.
 * Each invocation writes only the owner containing the addressed logical texel.
 * Per-owner dispatches use one sampled image binding, avoiding a sixteen-image
 * bindless requirement. Complete ownership is proved by the CPU directory/index. */
export const imagePageAssemblySource = `
struct Params {
  logicalSize: vec2<i32>,
  pageOrigin: vec2<i32>,
  ownerOrigin: vec2<i32>,
  address: vec2<u32>,
  constants: vec4<i32>,
};
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: Params;

fn addressed(value: i32, size: i32, mode: u32) -> i32 {
  if (mode == 0u) {
    return clamp(value, 0, size - 1);
  }
  let period = select(size, size * 2, mode == 2u);
  let wrapped = ((value % period) + period) % period;
  return select(period - 1 - wrapped, wrapped, wrapped < size);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id.xy >= textureDimensions(destination))) {
    return;
  }
  let logical = vec2<i32>(id.xy) + params.pageOrigin;
  let coordinate = vec2<i32>(
    addressed(logical.x, params.logicalSize.x, params.address.x),
    addressed(logical.y, params.logicalSize.y, params.address.y)
  ) - params.ownerOrigin;
  if (any(coordinate < vec2<i32>(0)) || any(coordinate >= vec2<i32>(textureDimensions(source)))) {
    return;
  }
  var color = textureLoad(source, coordinate, 0);
  for (var channel = 0u; channel < 4u; channel++) {
    if (params.constants[channel] >= 0) {
      color[channel] = f32(params.constants[channel]) / 255.0;
    }
  }
  textureStore(destination, id.xy, color);
}
`;

/** Exact R8 output shares the same addressed owner assembly. Four bytes per word
 * avoid overlapping byte stores; each row uses WebGPU's 256-byte copy pitch. */
export const imagePageExactSource = `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let extent = textureDimensions(source);
  if (id.x >= (extent.x + 3u) / 4u || id.y >= extent.y) {
    return;
  }
  var packed = 0u;
  for (var byte = 0u; byte < 4u; byte++) {
    let value = textureLoad(source, vec2<i32>(i32(id.x * 4u + byte), i32(id.y)), 0).r;
    packed |= u32(round(clamp(value, 0.0, 1.0) * 255.0)) << (byte * 8u);
  }
  let pitch = ((extent.x + 255u) / 256u) * 64u;
  output[id.y * pitch + id.x] = packed;
}
`;
