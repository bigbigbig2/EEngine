import type { AppearancePublishedEntry } from "../gpu/GpuAppearancePublication.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { winnerPrimitiveArenaConsumerWgsl } from "./winner_primitive_work.js";
import { surfaceGeometrySourceReaderWgsl } from "./surface_geometry_reader.js";
import { appearanceGeometryInputKind, appearanceInputLayout } from "./appearance_demand_inputs.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import { GPU_FRAME_ATTRIBUTE_VECTORS } from "../gpu/GpuFrameGeometryAttributesAbi.js";

/** Final task input producer, separate from reservation so the complete ordinary
 * and Product source miss profile stays within sixteen storage bindings. */
export function appearanceGeometryInputsWgsl(entries: readonly AppearancePublishedEntry[], product: boolean): string {
  const programs = [...new Map(entries.map(entry => [entry.programIndex, entry])).values()];
  return /* wgsl */ `requires unrestricted_pointer_parameters;
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${PACKED_CAMERA_TYPE.wgsl_declaration}
struct Settings { extent: vec4u, geometry: vec4u, source: vec4u, source_payload: vec4u }
@group(0) @binding(0) var<uniform> settings: Settings;
@group(0) @binding(1) var visibility: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> tasks: array<vec4u>;
@group(0) @binding(3) var<storage, read> metadata: array<vec4u>;
@group(0) @binding(4) var<storage, read_write> task_inputs: array<vec4f>;
@group(0) @binding(5) var<storage, read> demand_constants: array<f32>;
@group(0) @binding(6) var<storage, read> task_extent: vec4u;
@group(0) @binding(7) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(8) var<storage, read> demand_geometry: array<u32>;
@group(0) @binding(9) var<storage, read> demand_attributes: array<vec4f>;
@group(0) @binding(10) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
@group(0) @binding(11) var<storage, read> vertex_payload: array<u32>;
@group(0) @binding(18) var<uniform> camera: CommandEncoder;
${product ? `@group(0) @binding(12) var<storage, read> product_heap: array<u32>;
${Array.from({length:4},(_,i)=>`@group(0) @binding(${13+i}) var<storage, read> product_bank_${i}: array<u32>;`).join("\n")}` : ""}
${winnerPrimitiveArenaConsumerWgsl("demand_geometry", false)}
${surfaceGeometrySourceReaderWgsl(product, "demand_geometry")}
var<private> demand_instance: OEngineFrameInstanceRecord;
fn demand_attribute(ids: vec3u, weights: vec3f, field: u32) -> vec4f {
  if surface_direct_source { return surface_source_attribute(ids,weights,field); }
  return demand_attributes[ids.x*${GPU_FRAME_ATTRIBUTE_VECTORS}u+field]*weights.x+demand_attributes[ids.y*${GPU_FRAME_ATTRIBUTE_VECTORS}u+field]*weights.y+demand_attributes[ids.z*${GPU_FRAME_ATTRIBUTE_VECTORS}u+field]*weights.z;
}
fn demand_geometry_input(kind: u32, ids: vec3u, weights: vec3f) -> vec4f {
  if kind>=8u {
    let transform=oengine_instance_current_object_to_world(demand_instance.source);
    let position=(transform*vec4f(demand_attribute(ids,weights,5u).xyz,1.0)).xyz;
    if kind==8u { return vec4f(normalize(camera.transform[3].xyz-position),0.0); }
    if kind==9u { return vec4f(camera.transform[3].xyz,1.0); }
    if kind==10u { return vec4f(position,1.0); }
    if kind==13u { return camera.view_matrix*vec4f(position,1.0); }
    let a=demand_attribute(ids,vec3f(1.0,0.0,0.0),5u).xyz;
    let b=demand_attribute(ids,vec3f(0.0,1.0,0.0),5u).xyz;
    let c=demand_attribute(ids,vec3f(0.0,0.0,1.0),5u).xyz;
    let geometric=normalize(cross((transform*vec4f(b-a,0.0)).xyz,(transform*vec4f(c-a,0.0)).xyz));
    let normal=oengine_frame_instance_normal(demand_instance.normal_x,demand_instance.normal_y,demand_instance.normal_z.xyz,
      demand_attribute(ids,weights,0u).xyz,geometric);
    if kind==11u { return vec4f(normal,0.0); }
    if kind==14u { return camera.view_matrix*vec4f(normal,0.0); }
    let local=demand_attribute(ids,weights,1u);
    let tangent=(transform*vec4f(local.xyz,0.0)).xyz;
    let projected=tangent-normal*dot(normal,tangent);
    var basis:vec3f;
    if dot(projected,projected)>1e-20 { basis=normalize(projected); }
    else { basis=normalize(cross(select(vec3f(0.0,0.0,1.0),vec3f(0.0,1.0,0.0),abs(normal.z)>0.99),normal)); }
    return vec4f(basis,local.w*sign(demand_instance.normal_x.w));
  }
  switch kind {
    case 1u: { return vec4f(demand_attribute(ids,weights,2u).xy,0.0,0.0); }
    case 2u: { return vec4f(demand_attribute(ids,weights,2u).zw,0.0,0.0); }
    case 3u: { return demand_attribute(ids,weights,4u); }
    case 4u: { return demand_attribute(ids,weights,3u); }
    case 5u: { return demand_attribute(ids,weights,0u); }
    case 6u: { return demand_attribute(ids,weights,1u); }
    default: { return demand_attribute(ids,weights,5u); }
  }
}
@compute @workgroup_size(64)
fn geometry_inputs(@builtin(global_invocation_id) id: vec3u) {
  if id.x>=task_extent.w { return; }
  let task=tasks[id.x]; let meta=metadata[id.x];
  let position=vec2u(meta.z%settings.extent.x,meta.z/settings.extent.x);
  let key=textureLoad(visibility,vec2i(position),0).x;
  let decoded=oengine_visibility_key_decode(key);
  let work=meshlet_work.elements[decoded.meshlet_work_slot];
  demand_instance=frame_instances[work.instance_slot];
  let at=settings.geometry.y+4u+decoded.meshlet_work_slot*4u;
  surface_direct_source=false;
  var interpolation: WinnerInterpolation; var ids: vec3u;
  if demand_geometry[at+2u]!=0u {
    interpolation=winner_arena_interpolate_key(key,vec2f(position)+0.5,vec2f(settings.extent.xy),settings.geometry.x,settings.geometry.y);
    let packed=demand_geometry[demand_geometry[settings.geometry.x+7u]+demand_geometry[at+1u]+decoded.local_primitive];
    ids=vec3u(packed&255u,(packed>>8u)&255u,(packed>>16u)&255u)+vec3u(demand_geometry[at]);
  } else {
    interpolation=winner_interpolate(surface_source_coefficients(work,decoded.local_primitive),vec2f(position)+0.5,vec2f(settings.extent.xy));
    ids=vec3u(0u,1u,2u);
  }
${programs.map(entry=>`  if meta.w==${entry.programIndex}u {
${entry.program.inputs.map((input,index)=>{
    const kind=appearanceGeometryInputKind(input,entry.program);
    const neighbor=appearanceInputLayout(entry.program).neighborBase+index*2;
    return (kind===0?"":`    task_inputs[task.z+${index}u]=demand_geometry_input(${kind}u,ids,interpolation.weights);\n`)+
      `    task_inputs[task.z+${neighbor}u]=${kind===0?`task_inputs[task.z+${index}u]`:`demand_geometry_input(${kind}u,ids,interpolation.weights+interpolation.dx)`};\n`+
      `    task_inputs[task.z+${neighbor+1}u]=${kind===0?`task_inputs[task.z+${index}u]`:`demand_geometry_input(${kind}u,ids,interpolation.weights+interpolation.dy)`};`;
  }).filter(Boolean).join("\n")}
  }`).join("\n")}
}
`;
}
