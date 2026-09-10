import { counterByteOffset } from "../debug/GpuFrameCounters.js";
import { GPU_TRIANGLE_SETUP_RECORD_WGSL } from "../gpu/GpuExactRasterAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";

const SETUP_VISIBLE_HITS = counterByteOffset("setupVisiblePixelHits") / 4;
const SETUP_VISIBLE_FALLBACKS = counterByteOffset("setupVisiblePixelFallbacks") / 4;

/** Sampled-only visibility-to-TriangleSetup evidence; never part of the normal frame. */
export const PACKED_TRIANGLE_SETUP_EVIDENCE_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_TRIANGLE_SETUP_RECORD_WGSL}

const COUNTER_SETUP_VISIBLE_HITS: u32 = ${SETUP_VISIBLE_HITS}u;
const COUNTER_SETUP_VISIBLE_FALLBACKS: u32 = ${SETUP_VISIBLE_FALLBACKS}u;

struct SetupEvidenceQueueHeader {
  written: u32,
  attempted: u32,
  peak: u32,
  overflow: u32,
  fallback: u32,
  capacity: u32,
  rejected_cone: u32,
  rejected_hzb: u32,
}

struct SetupEvidenceWork {
  instance_record_index: u32,
  geometry_record_index: u32,
  meshlet_record_index: u32,
  local_triangle_index: u32,
  material_handle: u32,
  raster_flags: u32,
  setup_index: u32,
  exact_flags: u32,
}

struct SetupEvidenceQueue {
  opaque_header: SetupEvidenceQueueHeader,
  mask_header: SetupEvidenceQueueHeader,
  elements: array<SetupEvidenceWork>,
}

@group(0) @binding(0) var visibility_keys: texture_2d<u32>;
@group(0) @binding(1) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage, read> triangle_setups: array<OEngineTriangleSetupRecord>;
@group(0) @binding(3) var<storage, read_write> counters: array<atomic<u32>>;

@compute @workgroup_size(8, 8, 1)
fn packed_triangle_setup_evidence(@builtin(global_invocation_id) id: vec3u) {
  let dimensions = textureDimensions(visibility_keys);
  if id.x >= dimensions.x || id.y >= dimensions.y { return; }
  let key = textureLoad(visibility_keys, vec2<i32>(id.xy), 0).r;
  if !oengine_visibility_key_is_valid(key) { return; }

  let decoded = oengine_visibility_key_decode(key);
  if meshlet_work.header.generation == 0u ||
      decoded.meshlet_work_slot >= min(meshlet_work.header.written_count,
        meshlet_work.header.capacity) ||
      decoded.meshlet_work_slot >= arrayLength(&meshlet_work.elements) { return; }
  // Step 4 deliberately disconnects the old per-triangle cache identity.
  // Step 5 introduces the independent LargeTriangle Setup mapping.
  atomicAdd(&counters[COUNTER_SETUP_VISIBLE_FALLBACKS], 1u);
}
`;
