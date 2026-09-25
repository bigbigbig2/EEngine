import { GPU_SHADING_SURFACE_LITE_WGSL } from "../gpu/GpuComputeMaterialAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_SHADING_MATERIAL_WGSL, GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL } from "../gpu/GpuShadingMaterialAbi.js";
import { gpuSurfaceProgramSpecialization } from "../gpu/GpuSurfaceProgramSpecialization.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_SPARSE_SHADING_VIEW_WGSL } from "../gpu/GpuSparseShadingFrameAbi.js";
import type { SurfacePhysicalBindingPlan, SurfacePhysicalBinding } from "../render/surface/SurfaceKernelBindingPlan.js";
import type { SurfaceProgramClosure } from "../render/surface/SurfaceProducts.js";
import { SHADING_WORK_THREADS, SHADING_WORK_WGSL } from "../render/surface/ShadingWorkAbi.js";
import {
  geometryWgsl, isFastUnlitFactor, lightingWgsl, materialEvaluationWgsl, textureWgsl
} from "./surface_material_kernel.js";

/** New ShadingWork entry point; only Surface mathematics and the view ABI are extracted. */
export function createSurfaceMaterialProgramWgsl(
  closure: Readonly<SurfaceProgramClosure>,
  plan: Readonly<SurfacePhysicalBindingPlan>,
  classId: number
): string {
  if (!Number.isInteger(classId) || classId < 0 || classId >= 64 ||
      (classId & 15) !== closure.kernel.programId) {
    throw new RangeError("Surface ShadingWork class does not match material program");
  }
  if (closure.layoutSignature !== plan.signature) {
    throw new Error("Surface program/layout signature mismatch");
  }
  const kernel = closure.kernel;
  const specialization = gpuSurfaceProgramSpecialization(kernel.programId, kernel.outputDependencyMask);
  const fastUnlit = isFastUnlitFactor(kernel);
  const usesTextures = plan.bindings.some(binding => binding.role === "texture-routes");
  const names = plan.bindings.map(bindingDeclaration).join("\n");
  const surfaceType = fastUnlit ? "" : /* wgsl */ `
struct OEngineSparseSurface {
  base_color: vec3f, alpha: f32,
  shading_normal: vec3f, roughness: f32,
  geometric_normal: vec3f, metallic: f32,
  emissive: vec3f, material_ao: f32,
  position_ws: vec3f, velocity: vec2f,
  view_depth: f32, flags: u32,
}`;
  const route = usesTextures ? /* wgsl */ `
fn sparse_texture_route_valid(material_slot: u32, slot: u32, texture_ref: u32) -> bool {
  let route = texture_descriptor_routing_heap[
    material_slot * ${GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL}u + slot
  ];
  return route.texture_ref == texture_ref &&
    route.texture_generation == shading_view.texture_generation &&
    route.publication_revision == shading_view.publication_revision &&
    route.texture_binding_set_id == material_records[material_slot].texture_binding_set_id;
}` : "";
  const geometryCheck = specialization.reconstructTriangle
    ? closure.virtualGeometry
      ? "if work.instance_slot >= arrayLength(&instance_records) { textureStore(output_hdr, vec2i(pixel), SURFACE_ERROR_COLOR); return; }"
      : `if work.instance_slot >= arrayLength(&instance_records) ||
          work.geometry_slot >= shading_view.geometry_count ||
          instance_records[work.instance_slot].geometry_record_index != work.geometry_slot ||
          asset_metadata_heap[shading_view.geometry_generation_word_base + work.geometry_slot] !=
            oengine_instance_geometry_generation(instance_records[work.instance_slot]) {
        textureStore(output_hdr, vec2i(pixel), SURFACE_ERROR_COLOR); return;
      }`
    : "";
  const evaluation = fastUnlit
    ? "let radiance = material.payload.base_color_factor.xyz; let alpha = material.payload.base_color_factor.w;"
    : `let surface = sparse_evaluate_geometry(pixel, work,
        oengine_visibility_key_local_primitive(item.visibility_key), material_slot, material);
      if surface_identity_failed { textureStore(output_hdr, vec2i(pixel), SURFACE_ERROR_COLOR); return; }
      let radiance = ${specialization.lit ? "sparse_direct(surface, pixel)" : "surface.base_color"};
      let alpha = surface.alpha;`;
  return [
    SHADING_WORK_WGSL,
    GPU_VISIBILITY_KEY_WGSL,
    GPU_MESHLET_RASTER_WORK_WGSL,
    GPU_SHADING_MATERIAL_WGSL,
    // Necessary 240-byte camera/asset ABI is extracted from the dormant owner;
    // the former Pass, descriptor and ShadingBin layout are not imported.
    GPU_SPARSE_SHADING_VIEW_WGSL,
    fastUnlit ? "" : surfaceType,
    fastUnlit ? "" : GPU_SHADING_SURFACE_LITE_WGSL,
    names,
    "const SURFACE_ERROR_COLOR: vec4f = vec4f(1.0, 0.0, 1.0, 1.0);",
    "var<private> surface_identity_failed: bool = false;",
    "fn sparse_identity_error() { surface_identity_failed = true; }",
    "fn surface_identity_error() { surface_identity_failed = true; }",
    route,
    specialization.reconstructTriangle ? geometryWgsl(closure.virtualGeometry) : "",
    usesTextures ? textureWgsl(kernel) : "",
    specialization.lit ? lightingWgsl(false, false) : "",
    fastUnlit ? "" : materialEvaluationWgsl(kernel),
    /* wgsl */ `
@compute @workgroup_size(${SHADING_WORK_THREADS})
fn shade(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let class_work = classes.entries[${classId}u];
  let local = (group.y * class_work.dispatch_x + group.x) * ${SHADING_WORK_THREADS}u + lane;
  if local >= class_work.count { return; }
  let slot = class_work.start + local;
  if slot >= work.header.written { return; }
  let item = work.records[slot];
  let pixel = vec2u(item.pixel % shading_view.width, item.pixel / shading_view.width);
  if !oengine_visibility_key_is_valid(item.visibility_key) {
    textureStore(output_hdr, vec2i(pixel), SURFACE_ERROR_COLOR); return;
  }
  let work_slot = oengine_visibility_key_meshlet_work_slot(item.visibility_key);
  if meshlet_work.header.generation == 0u || work_slot >= meshlet_work.header.written_count {
    textureStore(output_hdr, vec2i(pixel), SURFACE_ERROR_COLOR); return;
  }
  let work = meshlet_work.elements[work_slot];
  let material_slot = work.material_slot_or_range;
  if material_slot >= shading_view.material_count || material_slot >= arrayLength(&material_records) {
    textureStore(output_hdr, vec2i(pixel), SURFACE_ERROR_COLOR); return;
  }
  let material = material_records[material_slot];
  if material.program_id != ${kernel.programId}u ||
     ((work.packed_raster_flags >> 8u) & 63u) !=
       material.texture_binding_set_id * 16u + material.program_id ||
     material.material_generation != shading_view.material_generation ||
     material.texture_generation != shading_view.texture_generation ||
     material.publication_revision != shading_view.publication_revision {
    textureStore(output_hdr, vec2i(pixel), SURFACE_ERROR_COLOR); return;
  }
  ${geometryCheck}
  ${evaluation}
  textureStore(output_hdr, vec2i(pixel), vec4f(radiance * shading_view.pre_exposure, alpha));
}`
  ].filter(Boolean).join("\n");
}

function bindingDeclaration(binding: Readonly<SurfacePhysicalBinding>): string {
  const prefix = `@group(${binding.group}) @binding(${binding.binding})`;
  switch (binding.role) {
    case "shading-work": return `${prefix} var<storage, read> work: ShadingWorkQueueRead;`;
    case "shading-work-classes": return `${prefix} var<storage, read> classes: ShadingWorkClassesRead;`;
    case "meshlet-work": return `${prefix} var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;`;
    case "material-records": return `${prefix} var<storage, read> material_records: array<OEngineShadingMaterialRecord>;`;
    case "frame-view": return `${prefix} var<uniform> shading_view: OEngineSparseShadingView;`;
    case "radiance-output": return `${prefix} var output_hdr: texture_storage_2d<rgba16float, write>;`;
    case "visibility-depth": return `${prefix} var visibility_depth: texture_depth_2d;`;
    case "instance-records": return `${prefix} var<storage, read> instance_records: array<OEngineInstanceRecord>;`;
    case "geometry-metadata": return `${prefix} var<storage, read> asset_metadata_heap: array<u32>;`;
    case "vertex-payload": return `${prefix} var<storage, read> vertex_payload_heap: array<u32>;`;
    case "virtual-product-metadata": return `${prefix} var<storage, read> virtual_product_metadata: array<u32>;`;
    case "virtual-product-banks": return `${prefix} var<storage, read> virtual_product_bank_${binding.element}: array<u32>;`;
    case "texture-routes": return `${prefix} var<storage, read> texture_descriptor_routing_heap: array<OEngineShadingTextureRoute>;`;
    case "texture-banks": return `${prefix} var oengine_texture_bank_${binding.element}: texture_2d_array<f32>;`;
    case "texture-samplers": {
      const names = ["repeat_linear", "clamp_linear", "mirror_linear",
        "repeat_nearest", "clamp_nearest", "mirror_nearest"];
      return `${prefix} var sampler_${names[binding.element]}: sampler;`;
    }
    case "direct-light-records": return `${prefix} var<storage, read> node: array<u32>;`;
    case "direct-light-cluster-lookup": return `${prefix} var<storage, read> cluster_lookup: array<ClusterMetadata>;`;
    case "direct-light-cluster-data": return `${prefix} var<storage, read> cluster_data: ClusterData;`;
    case "direct-light-cluster-params": return `${prefix} var<uniform> cluster_parameters: vec3f;`;
  }
}
