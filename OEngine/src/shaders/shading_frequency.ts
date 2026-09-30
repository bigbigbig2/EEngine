import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_MATERIAL_VISIBILITY_FLAGS } from "../gpu/GpuMaterialVisibilityAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_MATERIAL_FLAGS, GPU_SHADING_MATERIAL_WGSL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_SHADING_PROGRAM } from "../gpu/GpuShadingProgramAbi.js";
import { GPU_SPARSE_SHADING_VIEW_WGSL } from "../gpu/GpuSparseShadingFrameAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { SHADING_FREQUENCY_COARSE4_BIT, SHADING_FREQUENCY_TILE_SIZE } from "../render/surface/ShadingFrequencyPlanAbi.js";

/** Conservative local pre-material planner. Zero means full-rate Surface. */
export const SHADING_FREQUENCY_PLAN_WGSL = /* wgsl */ `
${GPU_VISIBILITY_KEY_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_SHADING_MATERIAL_WGSL}
${GPU_INSTANCE_RECORD_WGSL}
${GPU_SPARSE_SHADING_VIEW_WGSL}
@group(0) @binding(0) var frequency_key: texture_2d<u32>;
@group(0) @binding(1) var frequency_depth: texture_depth_2d;
@group(0) @binding(2) var<storage, read> frequency_meshlets: OEngineMeshletWorkQueueRead;
@group(0) @binding(3) var<storage, read> frequency_materials: array<OEngineShadingMaterialRecord>;
@group(0) @binding(4) var<storage, read> frequency_instances: array<OEngineInstanceRecord>;
@group(0) @binding(5) var<uniform> frequency_view: OEngineSparseShadingView;
@group(0) @binding(6) var frequency_plan: texture_storage_2d<r32uint, write>;
@group(0) @binding(7) var frequency_candidates: texture_2d<u32>;

fn frequency_camera_static() -> bool {
  // Identical view matrices plus static instances guarantee uniform zero motion.
  for (var c = 0u; c < 4u; c++) {
    for (var r = 0u; r < 4u; r++) {
      if frequency_view.current_view_projection[c][r] !=
         frequency_view.previous_view_projection[c][r] { return false; }
    }
  }
  return true;
}
fn frequency_static(instance: OEngineInstanceRecord) -> bool {
  if !oengine_instance_motion_valid(instance) { return false; }
  return all(instance.previous_from_current_affine_0 == vec4f(1.0, 0.0, 0.0, 0.0)) &&
    all(instance.previous_from_current_affine_1 == vec4f(0.0, 1.0, 0.0, 0.0)) &&
    all(instance.previous_from_current_affine_2 == vec4f(0.0, 0.0, 1.0, 0.0));
}
fn frequency_eligible(key: u32) -> bool {
  if !oengine_visibility_key_is_valid(key) || frequency_meshlets.header.generation == 0u { return false; }
  let work_slot = oengine_visibility_key_meshlet_work_slot(key);
  if work_slot >= frequency_meshlets.header.written_count { return false; }
  let meshlet = frequency_meshlets.elements[work_slot];
  if meshlet.material_slot_or_range >= frequency_view.material_count ||
     meshlet.material_slot_or_range >= arrayLength(&frequency_materials) ||
     meshlet.instance_slot >= arrayLength(&frequency_instances) { return false; }
  let material = frequency_materials[meshlet.material_slot_or_range];
  if material.material_generation != frequency_view.material_generation ||
     material.texture_generation != frequency_view.texture_generation ||
     material.publication_revision != frequency_view.publication_revision ||
     material.family != 0u || material.texture_binding_set_id != 0u ||
     ((meshlet.packed_raster_flags >> 8u) & 63u) != material.program_id { return false; }
  let uniform_texture = material.program_id == ${GPU_SHADING_PROGRAM.UnlitTexture}u &&
    (material.flags & ${GPU_SHADING_MATERIAL_FLAGS.UniformBaseTexture}u) != 0u &&
    material.payload.flags == ${GPU_MATERIAL_VISIBILITY_FLAGS.Valid | GPU_MATERIAL_VISIBILITY_FLAGS.Unlit | GPU_MATERIAL_VISIBILITY_FLAGS.HasAlphaTexture}u;
  let constant_factor = material.program_id == ${GPU_SHADING_PROGRAM.UnlitFactor}u &&
    material.payload.flags == ${GPU_MATERIAL_VISIBILITY_FLAGS.Valid | GPU_MATERIAL_VISIBILITY_FLAGS.Unlit}u;
  return (constant_factor || uniform_texture) && material.payload.alpha_mode == 0u &&
    frequency_static(frequency_instances[meshlet.instance_slot]);
}
fn frequency_block_eligible(origin: vec2u, rate: u32) -> bool {
  if origin.x + rate > frequency_view.width || origin.y + rate > frequency_view.height { return false; }
  let key = textureLoad(frequency_key, vec2i(origin), 0).x;
  if !frequency_eligible(key) { return false; }
  let depth0 = textureLoad(frequency_depth, vec2i(origin), 0);
  for (var y = 0u; y < rate; y++) {
    for (var x = 0u; x < rate; x++) {
      let pixel = origin + vec2u(x, y);
      if textureLoad(frequency_key, vec2i(pixel), 0).x != key ||
         abs(textureLoad(frequency_depth, vec2i(pixel), 0) - depth0) > 1e-5 { return false; }
    }
  }
  return true;
}
@compute @workgroup_size(8, 8)
fn plan(@builtin(global_invocation_id) id: vec3u) {
  let tiles = (vec2u(frequency_view.width, frequency_view.height) + vec2u(${SHADING_FREQUENCY_TILE_SIZE - 1}u)) /
    vec2u(${SHADING_FREQUENCY_TILE_SIZE}u);
  if id.x >= tiles.x || id.y >= tiles.y { return; }
  var mask = 0u;
  if frequency_camera_static() {
    let origin = id.xy * ${SHADING_FREQUENCY_TILE_SIZE}u;
    if frequency_block_eligible(origin, ${SHADING_FREQUENCY_TILE_SIZE}u) {
      mask = ${SHADING_FREQUENCY_COARSE4_BIT}u;
    } else {
      for (var cell = 0u; cell < 4u; cell++) {
        let cell_origin = origin + vec2u((cell & 1u) * 2u, (cell >> 1u) * 2u);
        if frequency_block_eligible(cell_origin, 2u) { mask |= 1u << cell; }
      }
    }
  }
  for (var cell = 0u; cell < 4u; cell++) {
    let candidate_pixel = id.xy * 2u + vec2u(cell & 1u, cell >> 1u);
    if all(candidate_pixel < textureDimensions(frequency_candidates)) {
      mask |= (textureLoad(frequency_candidates, vec2i(candidate_pixel), 0).x & 3u) << (16u + cell * 2u);
    }
  }
  textureStore(frequency_plan, vec2i(id.xy), vec4u(mask, 0u, 0u, 0u));
}
`;

/** Dense alone reads the plan; Binned exceptions stay full rate. */
export const SHADING_FREQUENCY_ANCHOR_WGSL = /* wgsl */ `
fn oengine_shading_rate(pixel: vec2u) -> u32 {
  let tile = pixel / ${SHADING_FREQUENCY_TILE_SIZE}u;
  let mask = textureLoad(frequency_plan, vec2i(tile), 0).x;
  if (mask & ${SHADING_FREQUENCY_COARSE4_BIT}u) != 0u { return 4u; }
  let cell = ((pixel.y & 3u) >> 1u) * 2u + ((pixel.x & 3u) >> 1u);
  if (mask & (1u << cell)) != 0u { return 2u; }
  return 1u;
}
fn oengine_shading_anchor(pixel: vec2u) -> vec2u {
  let rate = oengine_shading_rate(pixel);
  return (pixel / rate) * rate;
}
`;
