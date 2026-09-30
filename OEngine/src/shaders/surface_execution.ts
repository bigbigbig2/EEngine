import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_SHADING_MATERIAL_WGSL, GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL } from "../gpu/GpuShadingMaterialAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { GPU_SPARSE_SHADING_VIEW_WGSL } from "../gpu/GpuSparseShadingFrameAbi.js";
import { GPU_SHADING_SURFACE_LITE_WGSL } from "../gpu/GpuComputeMaterialAbi.js";
import { GPU_SURFACE_KERNEL_DEMAND } from "../gpu/GpuSurfaceProgramSpecialization.js";
import { SURFACE_EXCEPTION_LANES, SURFACE_EXECUTION_WGSL, SURFACE_WORK_THREADS } from "../render/surface/SurfaceExecutionAbi.js";
import type { SurfacePhysicalBindingPlan } from "../render/surface/SurfaceKernelBindingPlan.js";
import { bindingDeclaration } from "./surface_binding_declarations.js";
import { SHADING_FREQUENCY_ANCHOR_WGSL } from "./shading_frequency.js";
import { geometryWgsl, lightingWgsl, materialEvaluationWgsl, textureWgsl } from "./surface_material_kernel.js";
import { ATMOSPHERE_RUNTIME_WGSL } from "./atmosphere/runtime.js";
import { LINEAR_REC709_TO_REC2020_WGSL } from "./working_color.js";

export const SURFACE_WORK_CONTROL_WGSL = /* wgsl */ `
${SURFACE_EXECUTION_WGSL}
struct SurfaceWorkParameters { capacity:u32, max_dispatch_x:u32, width:u32, height:u32, };
@group(0) @binding(0) var<storage, read_write> work:SurfaceWorkQueue;
@group(0) @binding(1) var<storage, read_write> indirect:SurfaceIndirectArgs;
@group(0) @binding(2) var<uniform> parameters:SurfaceWorkParameters;
@compute @workgroup_size(1)
fn initialize() {
  work.header=SurfaceWorkHeader(parameters.capacity,parameters.max_dispatch_x,
    parameters.width,parameters.height);
  for(var lane=0u;lane<${SURFACE_EXCEPTION_LANES}u;lane++) {
    atomicStore(&work.lanes[lane].attempted,0u);
    atomicStore(&work.lanes[lane].overflow,0u);
    work.lanes[lane].dispatch_x=0u;
  }
}
@compute @workgroup_size(1)
fn finalize() {
  for(var lane=0u;lane<${SURFACE_EXCEPTION_LANES}u;lane++) {
    let attempted=atomicLoad(&work.lanes[lane].attempted);
    let overflow=atomicLoad(&work.lanes[lane].overflow)!=0u || attempted>work.header.capacity;
    let count=min(attempted,work.header.capacity);
    let groups=(count+${SURFACE_WORK_THREADS - 1}u)/${SURFACE_WORK_THREADS}u;
    let dispatch_x=min(groups,work.header.max_dispatch_x);
    let dispatch_y=select(0u,(groups+max(dispatch_x,1u)-1u)/max(dispatch_x,1u),groups>0u);
    work.lanes[lane].dispatch_x=dispatch_x;
    indirect.args[lane*2u]=select(vec4u(dispatch_x,dispatch_y,1u,0u),
      vec4u(0u,0u,1u,0u),overflow);
    indirect.args[lane*2u+1u]=select(vec4u(0u,0u,1u,0u),
      vec4u((work.header.width+7u)/8u,(work.header.height+7u)/8u,1u,0u),overflow);
  }
}
`;

export type SurfaceExecutionMode = "dense" | "binned" | "fallback";

/** One hot Dense kernel and fixed profile/family exception kernels. */
export function surfaceExecutionWgsl(plan: SurfacePhysicalBindingPlan,
  mode: SurfaceExecutionMode, lane: number, hasLit: boolean, virtualGeometry: boolean,
  vsmShadowEnabled = false, virtualBankCount = 4, textureBankMask = 0x1ff,
  virtualUnlitFallback = false, physicalEnvironment = true): string {
  if (mode !== "dense" && (!Number.isInteger(lane) || lane < 0 || lane >= SURFACE_EXCEPTION_LANES)) {
    throw new RangeError("Surface exception lane is invalid");
  }
  const kernel = { programId: 15, outputDependencyMask: GPU_SURFACE_KERNEL_DEMAND.Motion,
    textureBankMask };
  // A-D validation only needs the visibility-to-unlit color contract. Product
  // virtual geometry reconstruction is intentionally deferred for this path;
  // keeping its large pointer-heavy helper in the first unlit pipeline makes
  // Dawn spend seconds compiling and can trigger a driver watchdog.
  const minimalVirtualUnlit = virtualUnlitFallback && virtualGeometry && !hasLit;
  const coatedOnly = hasLit && mode !== "dense" && (lane === 0 || (lane & 1) === 0);
  const unlit = minimalVirtualUnlit ? "" : coatedOnly ? "" : materialEvaluationWgsl({ ...kernel, programId: 3 }, true)
    .replace("fn sparse_evaluate_geometry(", "fn sparse_evaluate_unlit_geometry(");
  const lit = hasLit ? materialEvaluationWgsl(kernel, false, coatedOnly) : "";
  const scalarAo = plan.bindings.some(binding => binding.role === "indirect-visibility");
  const names = plan.bindings.map(binding => {
    const prefix = `@group(${binding.group}) @binding(${binding.binding})`;
    if (binding.role === "shading-work") return `${prefix} var<storage, read_write> work:SurfaceWorkQueue;`;
    if (binding.role === "visibility-key") return `${prefix} var visibility_texture:texture_2d<u32>;`;
    return bindingDeclaration(binding);
  }).join("\n");
  const surfaceType = /* wgsl */ `
struct RadiometryPreExposure { value: f32, _pad: vec3f, }
struct OEngineSparseSurface {
  base_color: vec3f, alpha: f32,
  shading_normal: vec3f, roughness: f32,
  geometric_normal: vec3f, metallic: f32,
  emissive: vec3f, material_ao: f32,
  position_ws: vec3f, velocity: vec2f,
  view_depth: f32, flags: u32,
  specular_weight: f32, specular_color: vec3f, ior: f32,
  coat_factor: f32, coat_roughness: f32, coat_normal: vec3f,
}
fn sparse_invalid_surface() -> OEngineSparseSurface {
  return OEngineSparseSurface(vec3f(0.0),0.0,vec3f(0.0),1.0,vec3f(0.0),0.0,
    vec3f(0.0),1.0,vec3f(0.0),vec2f(0.0),0.0,0u,
    1.0,vec3f(1.0),1.5,0.0,0.0,vec3f(0.0,0.0,1.0));
}`;
  const route = /* wgsl */ `
fn sparse_texture_route_valid(material_slot:u32,slot:u32,texture_ref:u32)->bool {
  let route=texture_descriptor_routing_heap[material_slot*${GPU_SHADING_TEXTURE_ROUTES_PER_MATERIAL}u+slot];
  return route.texture_ref==texture_ref &&
    route.texture_generation==shading_view.texture_generation &&
    route.publication_revision==shading_view.publication_revision &&
    route.texture_binding_set_id==material_records[material_slot].texture_binding_set_id;
}`;
  const geometryCheck = virtualGeometry
    ? "if work_item.instance_slot >= arrayLength(&instance_records) { surface_identity_error(); }"
    : `if work_item.instance_slot >= arrayLength(&instance_records) ||
      work_item.geometry_slot >= shading_view.geometry_count ||
      instance_records[work_item.instance_slot].geometry_record_index != work_item.geometry_slot ||
      asset_metadata_heap[shading_view.geometry_generation_word_base+work_item.geometry_slot] !=
        oengine_instance_geometry_generation(instance_records[work_item.instance_slot]) {
      surface_identity_error();
    }`;
  const shadeHit = /* wgsl */ `
${mode === "dense" ? SHADING_FREQUENCY_ANCHOR_WGSL : ""}
fn surface_store(pixel:vec2u,color:vec4f) {
  let rate=${mode === "dense" ? "oengine_shading_rate(pixel)" : "1u"};
  // Material, texture, direct light, and IBL inputs arrive as linear Rec.709.
  // Convert once at the HDR product boundary before the GPU P_t multiplier.
  let rec2020=oengine_linear_rec709_to_rec2020(color.rgb);
  for(var y=0u;y<rate;y++) {
    for(var x=0u;x<rate;x++) {
      let output_pixel=pixel+vec2u(x,y);
      textureStore(output_hdr,vec2i(output_pixel),vec4f(rec2020*radiometry_pre_exposure.value,color.a));
    }
  }
}
fn surface_error(pixel:vec2u) {
  surface_store(pixel,vec4f(1.0,0.0,1.0,1.0));
}
fn surface_hit(pixel:vec2u,key:u32,work_item:OEngineMeshletRasterWork,
  material_slot:u32,material:OEngineShadingMaterialRecord) {
  ${geometryCheck}
  if surface_identity_failed { surface_error(pixel); return; }
  ${minimalVirtualUnlit ? `
  let base_color = material.payload.base_color_factor;
  surface_store(pixel,base_color);
  return;` : `
  let primitive=oengine_visibility_key_local_primitive(key);
  var surface:OEngineSparseSurface;
  ${coatedOnly ?
    "surface=sparse_evaluate_geometry(pixel,work_item,primitive,material_slot,material);" :
    `if material.family==0u {
      surface=sparse_evaluate_unlit_geometry(pixel,work_item,primitive,material_slot,material);
    } else {
      ${hasLit ? "surface=sparse_evaluate_geometry(pixel,work_item,primitive,material_slot,material);" :
        "surface=sparse_evaluate_unlit_geometry(pixel,work_item,primitive,material_slot,material);"}
    }`}
  if surface_identity_failed { surface_error(pixel); return; }
  var radiance=surface.base_color;
  ${hasLit ? "if material.family!=0u { radiance=sparse_direct(surface,pixel); }" : ""}
  surface_store(pixel,vec4f(radiance,surface.alpha));
  `}
}
fn surface_material(pixel:vec2u,key:u32,report_error:bool)->u32 {
  let work_slot=oengine_visibility_key_meshlet_work_slot(key);
  if meshlet_work.header.generation==0u || work_slot>=meshlet_work.header.written_count {
    if report_error { surface_error(pixel); } return 0xfffffffeu;
  }
  let work_item=meshlet_work.elements[work_slot];
  let material_slot=work_item.material_slot_or_range;
  if material_slot>=shading_view.material_count || material_slot>=arrayLength(&material_records) {
    if report_error { surface_error(pixel); } return 0xfffffffeu;
  }
  let material=material_records[material_slot];
  if material.family>2u || material.texture_binding_set_id>3u ||
     ((work_item.packed_raster_flags>>8u)&63u)!=
       material.texture_binding_set_id*16u+material.program_id ||
     material.material_generation!=shading_view.material_generation ||
     material.texture_generation!=shading_view.texture_generation ||
     material.publication_revision!=shading_view.publication_revision {
    if report_error { surface_error(pixel); } return 0xfffffffeu;
  }
  let coated=material.family==2u;
  let set_id=material.texture_binding_set_id;
  var lane=select(0u,1u+(set_id-1u)*2u+u32(coated),set_id!=0u);
  if set_id==0u && !coated { lane=0xffffffffu; }
  return lane;
}
`;
  const entry = mode === "dense" ? /* wgsl */ `
var<workgroup> exception_counts:array<atomic<u32>,${SURFACE_EXCEPTION_LANES}>;
var<workgroup> exception_bases:array<u32,${SURFACE_EXCEPTION_LANES}>;
var<workgroup> exception_local:array<u32,64>;
@compute @workgroup_size(8,8)
fn shade(@builtin(global_invocation_id) id:vec3u,
  @builtin(local_invocation_index) thread:u32) {
  if thread<${SURFACE_EXCEPTION_LANES}u {
    atomicStore(&exception_counts[thread],0u);
  }
  workgroupBarrier();
  var lane=0xffffffffu;
  var key=0u;
  let pixel=id.xy;
  if id.x<shading_view.width && id.y<shading_view.height {
    key=textureLoad(visibility_texture,vec2i(pixel),0).x;
    if oengine_visibility_key_is_valid(key) && all(oengine_shading_anchor(pixel)==pixel) {
      let classified=surface_material(pixel,key,true);
      if classified==0xffffffffu {
        let work_slot=oengine_visibility_key_meshlet_work_slot(key);
        let work_item=meshlet_work.elements[work_slot];
        let material_slot=work_item.material_slot_or_range;
        surface_hit(pixel,key,work_item,material_slot,material_records[material_slot]);
      } else if classified<${SURFACE_EXCEPTION_LANES}u {
        lane=classified;
      }
    }
  }
  if lane<${SURFACE_EXCEPTION_LANES}u {
    exception_local[thread]=atomicAdd(&exception_counts[lane],1u);
  }
  workgroupBarrier();
  if thread<${SURFACE_EXCEPTION_LANES}u {
    let count=atomicLoad(&exception_counts[thread]);
    let base=atomicAdd(&work.lanes[thread].attempted,count);
    exception_bases[thread]=base;
    if base+count>work.header.capacity {
      atomicStore(&work.lanes[thread].overflow,1u);
    }
  }
  workgroupBarrier();
  if lane<${SURFACE_EXCEPTION_LANES}u {
    let index=exception_bases[lane]+exception_local[thread];
    if index<work.header.capacity {
      work.records[lane*work.header.capacity+index]=SurfaceWorkRecord(
        pixel.y*shading_view.width+pixel.x,key);
    }
  }
}` : mode === "binned" ? /* wgsl */ `
@compute @workgroup_size(${SURFACE_WORK_THREADS})
fn shade(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) thread:u32) {
  let index=(group.y*work.lanes[exception_lane].dispatch_x+group.x)*${SURFACE_WORK_THREADS}u+thread;
  if index>=min(atomicLoad(&work.lanes[exception_lane].attempted),work.header.capacity) ||
     atomicLoad(&work.lanes[exception_lane].overflow)!=0u { return; }
  let item=work.records[exception_lane*work.header.capacity+index];
  let pixel=vec2u(item.pixel%shading_view.width,item.pixel/shading_view.width);
  let key=item.visibility_key;
  if !oengine_visibility_key_is_valid(key) { surface_error(pixel); return; }
  let work_slot=oengine_visibility_key_meshlet_work_slot(key);
  if meshlet_work.header.generation==0u || work_slot>=meshlet_work.header.written_count {
    surface_error(pixel); return;
  }
  let work_item=meshlet_work.elements[work_slot];
  let material_slot=work_item.material_slot_or_range;
  if material_slot>=shading_view.material_count || material_slot>=arrayLength(&material_records) {
    surface_error(pixel); return;
  }
  surface_hit(pixel,key,work_item,material_slot,material_records[material_slot]);
}` : /* wgsl */ `
@compute @workgroup_size(8,8)
fn shade(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=shading_view.width || id.y>=shading_view.height ||
     atomicLoad(&work.lanes[exception_lane].overflow)==0u { return; }
  let pixel=id.xy;
  let key=textureLoad(visibility_texture,vec2i(pixel),0).x;
  if !oengine_visibility_key_is_valid(key) { return; }
  let work_slot=oengine_visibility_key_meshlet_work_slot(key);
  if meshlet_work.header.generation==0u || work_slot>=meshlet_work.header.written_count {
    surface_error(pixel); return;
  }
  let work_item=meshlet_work.elements[work_slot];
  let material_slot=work_item.material_slot_or_range;
  if material_slot>=shading_view.material_count || material_slot>=arrayLength(&material_records) {
    surface_error(pixel); return;
  }
  let material=material_records[material_slot];
  let lane=surface_material(pixel,key,false);
  if lane!=exception_lane { return; }
  surface_hit(pixel,key,work_item,material_slot,material);
}`;
  return ["requires unrestricted_pointer_parameters;",
    SURFACE_EXECUTION_WGSL,GPU_VISIBILITY_KEY_WGSL,GPU_MESHLET_RASTER_WORK_WGSL,
    GPU_INSTANCE_RECORD_WGSL,
    GPU_SHADING_MATERIAL_WGSL,GPU_SPARSE_SHADING_VIEW_WGSL,GPU_SHADING_SURFACE_LITE_WGSL,
    surfaceType,
    names,"var<private> surface_identity_failed:bool=false;",
    "fn sparse_identity_error(){surface_identity_failed=true;}",
    "fn surface_identity_error(){surface_identity_failed=true;}",
    route,minimalVirtualUnlit ? "" : geometryWgsl(virtualGeometry, virtualBankCount),
    minimalVirtualUnlit ? "" : textureWgsl(kernel),
    hasLit ? lightingWgsl(vsmShadowEnabled,physicalEnvironment,scalarAo,
      vsmShadowEnabled ? "vsm" : "legacy") : "",
    hasLit && physicalEnvironment ? ATMOSPHERE_RUNTIME_WGSL : "",
    unlit,lit,LINEAR_REC709_TO_REC2020_WGSL,shadeHit,entry].filter(Boolean).join("\n");
}
