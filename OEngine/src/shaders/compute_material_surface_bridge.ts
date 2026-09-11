/** Pure format bridge; it must never contain material or texture-bank access. */
export const COMPUTE_MATERIAL_SURFACE_BRIDGE_WGSL = /* wgsl */ `
@group(0) @binding(0) var compute_normal: texture_2d<u32>;
@group(0) @binding(1) var compute_albedo_ao: texture_2d<f32>;
@group(0) @binding(2) var compute_emissive: texture_2d<u32>;
@group(0) @binding(3) var compute_pbr_metadata_velocity: texture_2d<u32>;

const FULLSCREEN_POSITIONS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f(3.0, -1.0),
  vec2f(-1.0, 3.0)
);

@vertex
fn bridge_vertex(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  return vec4f(FULLSCREEN_POSITIONS[vertex_index], 0.0, 1.0);
}

struct BridgeOutput {
  @location(0) pbr: vec2f,
  @location(1) normal: vec4u,
  @location(2) albedo_ao: vec4f,
  @location(3) emissive: u32,
  @location(4) velocity: vec2f,
  @location(5) metadata: u32,
}

@fragment
fn bridge_fragment(@builtin(position) position: vec4f) -> BridgeOutput {
  let pixel = vec2i(position.xy);
  let packed = textureLoad(compute_pbr_metadata_velocity, pixel, 0);
  if packed.y == 0u { discard; }
  var output: BridgeOutput;
  output.pbr = unpack2x16unorm(packed.x);
  output.normal = textureLoad(compute_normal, pixel, 0);
  output.albedo_ao = textureLoad(compute_albedo_ao, pixel, 0);
  output.emissive = textureLoad(compute_emissive, pixel, 0).r;
  output.velocity = unpack2x16float(packed.z);
  output.metadata = packed.y;
  return output;
}
`;
