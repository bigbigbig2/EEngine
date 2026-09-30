import type { SurfacePhysicalBinding } from "../render/surface/SurfaceKernelBindingPlan.js";

export function bindingDeclaration(binding: Readonly<SurfacePhysicalBinding>): string {
  const prefix = `@group(${binding.group}) @binding(${binding.binding})`;
  switch (binding.role) {
    case "shading-work": return `${prefix} var<storage, read_write> work:SurfaceSampleWork;`;
    case "visibility-key": return `${prefix} var visibility_texture: texture_2d<u32>;`;
    case "sample-results": return binding.kind === "sampled-uint"
      ? `${prefix} var sample_results: texture_2d<u32>;`
      : `${prefix} var sample_results: texture_storage_2d<rgba32uint, write>;`;
    case "indirect-visibility": return `${prefix} var<storage, read> xe_visibility_words: array<u32>;`;
    case "sample-profile": return `${prefix} var<uniform> sample_dispatch: vec4u;`;
    case "meshlet-work": return `${prefix} var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;`;
    case "material-records": return `${prefix} var<storage, read> material_records: array<OEngineShadingMaterialRecord>;`;
    case "frame-view": return `${prefix} var<uniform> shading_view: OEngineSparseShadingView;`;
    case "pre-exposure": return `${prefix} var<uniform> radiometry_pre_exposure: RadiometryPreExposure;`;
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
    case "physical-environment-sun": return `${prefix} var<uniform> physical_environment_sun: PhysicalEnvironmentSun;`;
    case "physical-environment-transmittance": return `${prefix} var physical_environment_transmittance: texture_2d<f32>;`;
    case "physical-sky-irradiance": return `${prefix} var physical_sky_irradiance: texture_2d<f32>;`;
    case "physical-sky-irradiance-sampler": return `${prefix} var physical_sky_sampler: sampler;`;
    case "physical-sky-specular": return `${prefix} var environment_specular: texture_2d<f32>;`;
    case "physical-sky-dfg": return `${prefix} var split_sum: texture_2d<f32>;`;
    case "physical-sky-specular-sampler": return `${prefix} var environment_sampler: sampler;`;
    case "vsm-page-table": return `${prefix} var<storage, read> vsm_page_table: array<VsmPageEntry>;`;
    case "vsm-atlas-depth": return `${prefix} var vsm_atlas_depth: texture_depth_2d;`;
    case "vsm-sampling-constants": return `${prefix} var<uniform> vsm_constants: VsmSamplingConstants;`;
  }
}
