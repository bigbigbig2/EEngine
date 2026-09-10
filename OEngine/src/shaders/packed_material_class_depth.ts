import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_WGSL } from "../gpu/GpuMaterialVisibilityAbi.js";

export function materialClassDepthValue(kernelClass: number): number {
  if (!Number.isInteger(kernelClass) || kernelClass < 0 || kernelClass >= 7) {
    throw new RangeError("Material kernel class must be an integer in [0, 6]");
  }
  return (kernelClass + 1) / 8;
}

/** Writes one deterministic depth value per VisibilityKey material class. */
export const PACKED_MATERIAL_CLASS_DEPTH_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_MATERIAL_VISIBILITY_RECORD_WGSL}

@group(0) @binding(0) var visibility_keys: texture_2d<u32>;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> materials: array<OEngineMaterialVisibilityRecord>;

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
  let decoded = oengine_visibility_key_decode(key);
  let work_slot = decoded.meshlet_work_slot;
  if meshlet_work.header.generation == 0u ||
      work_slot >= min(meshlet_work.header.written_count, meshlet_work.header.capacity) ||
      work_slot >= arrayLength(&meshlet_work.elements) { discard; }
  let work = meshlet_work.elements[work_slot];
  if (work.packed_profile_lod >> 24u) != OENGINE_VISIBILITY_KEY_PARTITION ||
      work.material_slot_or_range >= arrayLength(&materials) { discard; }
  let kernel_class = materials[work.material_slot_or_range].kernel_class;
  if kernel_class >= 7u { discard; }
  // Values are strictly ordered and remain representable in depth32float.
  return ClassDepthOutput((f32(kernel_class) + 1.0) / 8.0);
}
`;
