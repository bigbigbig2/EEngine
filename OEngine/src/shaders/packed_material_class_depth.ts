import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";

export function materialClassDepthValue(kernelClass: number): number {
  if (!Number.isInteger(kernelClass) || kernelClass < 0 || kernelClass >= 7) {
    throw new RangeError("Material kernel class must be an integer in [0, 6]");
  }
  return (kernelClass + 1) / 8;
}

/** Writes one deterministic depth value per VisibilityKey material class. */
export const PACKED_MATERIAL_CLASS_DEPTH_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}

@group(0) @binding(0) var visibility_keys: texture_2d<u32>;

struct ClassDepthOutput {
  @builtin(frag_depth) depth: f32,
}

@vertex
fn packed_material_class_depth_vs(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  return vec4f(positions[vertex_index], 0.0, 1.0);
}

@fragment
fn packed_material_class_depth_fs(@builtin(position) position: vec4f) -> ClassDepthOutput {
  let key = textureLoad(visibility_keys, vec2i(position.xy), 0).r;
  if !oengine_visibility_key_is_valid(key) { discard; }
  let kernel_class = oengine_visibility_key_kernel_class(key);
  // Values are strictly ordered and remain representable in depth32float.
  return ClassDepthOutput((f32(kernel_class) + 1.0) / 8.0);
}
`;
