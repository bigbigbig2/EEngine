import type { AppearanceFieldBoundProgram } from "./appearance_field_bounds.js";
import { APPEARANCE_FIELD_BOUND_WGSL } from "./appearance_field_bounds.js";
import { SURFACE_CELL_ADDRESS_MATH_WGSL } from "./surface_cell_address_math.js";
import { surfaceCellGeometryMathWgsl } from "./surface_cell_geometry_setup.js";
import { textureLocalVariationQueryWgsl } from "./texture_local_variation_query.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";
import { SURFACE_CELL_GEOMETRY_PROBE_LIMIT, surfaceCellGeometryArenaWgsl } from "../gpu/GpuSurfaceCellGeometryAbi.js";
import { GPU_TEXTURE_REF_ROUTING_SHIFT, GPU_TEXTURE_REF_ROUTING_MASK, GPU_TEXTURE_REF_INVALID } from "../gpu/GpuTextureRefAbi.js";
import { GPU_MATERIAL_VISIBILITY_SAMPLER as S } from "../gpu/GpuMaterialVisibilityAbi.js";
import { APPEARANCE_MATERIAL_CONSTANT_WGSL } from "./appearance_material_constants.js";
import { SURFACE_APPEARANCE_BOUND_PROGRAM_WORDS } from "../gpu/GpuSurfaceAppearanceBoundsAbi.js";

/** Complete Geometry/Appearance predicates for the partition producer. The
 * Lighting owner supplies the direct-light set/shadow/spatial predicate; the
 * Appearance static owner supplies actual product bounds. Neither has a silent
 * always-false/unknown implementation in this production library. */
export function surfaceCellProductionFactsWgsl(programs: readonly AppearanceFieldBoundProgram[],
  product: boolean, directRiskLibrary: string, productBoundLibrary: string | null, dictionaryCapacity=65536,
  fieldMask: ReadonlySet<number> | null = null, includeGenericValidation = true): string {
  const selected = fieldMask === null ? programs : programs.map(program => ({ ...program,
    source: restrictAppearanceBoundSource(program.source, fieldMask) }));
  const hasProductSamples=selected.some(program=>program.source.includes("=ab_product("));
  if (!directRiskLibrary.includes("fn cell_direct_group_safe(") || (hasProductSamples&&!productBoundLibrary?.includes("fn ab_product("))) {
    throw new Error("Surface cell facts require real Lighting and static-product bound providers");
  }
  const source = /* wgsl */ `
struct CellFactSettings {
 source:vec4u,source_payload:vec4u,
 appearance0:vec4u, // constants, routes, bounds, directory word offsets
 appearance1:vec4u, // material lookup, lookup count, entry count, publication generation
 geometry:vec4u, // dictionary capacity, setup capacity, source generation, submitted epoch
 appearance2:vec4u, // constant palette offset, provider flags, reserved, reserved
}
@group(1) @binding(0) var<uniform> settings:CellFactSettings;
@group(1) @binding(1) var<storage,read> geometry_arena:CellGeometryArenaRead;
@group(1) @binding(3) var<storage,read> meshlet_work:OEngineMeshletWorkQueueRead;
@group(1) @binding(4) var<storage,read> source_heap:array<u32>;
@group(1) @binding(5) var<storage,read> vertex_payload:array<u32>;
@group(1) @binding(6) var<storage,read> frame_instances:array<OEngineFrameInstanceRecord>;
@group(1) @binding(7) var<storage,read_write> appearance_metadata:array<u32>;
@group(1) @binding(8) var<storage,read> texture_variation:array<u32>;
${product ? `@group(1) @binding(9) var<storage,read> product_heap:array<u32>;
${Array.from({length:4},(_,i)=>`@group(1) @binding(${i+10}) var<storage,read> product_bank_${i}:array<u32>;`).join("\n")}` : ""}
${PACKED_CAMERA_TYPE.wgsl_declaration}
@group(1) @binding(14) var<uniform> cell_camera:CommandEncoder;
${surfaceCellGeometryMathWgsl(product)}
${surfaceCellGeometryArenaWgsl(dictionaryCapacity,false)}
${APPEARANCE_FIELD_BOUND_WGSL}
${APPEARANCE_MATERIAL_CONSTANT_WGSL}
${SURFACE_CELL_ADDRESS_MATH_WGSL}
${textureLocalVariationQueryWgsl()}
var<private> cell_direct_key:u32=0xffffffffu;
var<private> cell_direct_setup:CellGeometrySetup;
var<private> cell_bound_slot:u32;
var<private> cell_bound_key:u32;
var<private> cell_current_rect:vec4f;
fn cell_geometry_hash(key:u32)->u32 {var v=key;v^=v>>16u;v*=0x7feb352du;v^=v>>15u;v*=0x846ca68bu;return v^(v>>16u);}
fn cell_geometry_slot(key:u32)->u32 {
 let hash=cell_geometry_hash(key);let mask=settings.geometry.x-1u;
 for(var probe=0u;probe<${SURFACE_CELL_GEOMETRY_PROBE_LIMIT}u;probe++){
  let entry=cell_dictionary[(hash+probe)&mask];if entry.key==0xffffffffu{break;}
  if entry.key==key{return entry.slot;}
 }
 return 0xffffffffu;
}
fn cell_ensure_direct_geometry(key:u32) {
 if cell_direct_key!=key{cell_direct_setup=cell_build_geometry_setup(key);cell_direct_key=key;atomicAdd(&cell_counts[105u],1u);}
}
fn cell_geometry_identity(slot:u32,key:u32)->vec4u {if slot<settings.geometry.y{return geometry_setups[slot].identity;}cell_ensure_direct_geometry(key);return cell_direct_setup.identity;}
fn cell_geometry_source(slot:u32,key:u32)->vec4u {if slot<settings.geometry.y{return geometry_setups[slot].source;}cell_ensure_direct_geometry(key);return cell_direct_setup.source;}
fn cell_geometry_continuity(slot:u32,key:u32,row:u32)->vec4u {if slot<settings.geometry.y{return geometry_setups[slot].continuity[row];}cell_ensure_direct_geometry(key);return cell_direct_setup.continuity[row];}
fn cell_geometry_address(slot:u32,key:u32)->vec4u {if slot<settings.geometry.y{return geometry_setups[slot].source_address;}cell_ensure_direct_geometry(key);return cell_direct_setup.source_address;}
fn cell_geometry_plane(slot:u32,key:u32)->vec4f {if slot<settings.geometry.y{return geometry_setups[slot].world_plane;}cell_ensure_direct_geometry(key);return cell_direct_setup.world_plane;}
fn cell_geometry_coefficients(slot:u32,key:u32)->WinnerCoefficients {if slot<settings.geometry.y{return geometry_setups[slot].coefficients;}cell_ensure_direct_geometry(key);return cell_direct_setup.coefficients;}
fn cell_geometry_corner(slot:u32,key:u32,index:u32)->vec4f {if slot<settings.geometry.y{return geometry_setups[slot].corners[index];}cell_ensure_direct_geometry(key);return cell_direct_setup.corners[index];}
fn cell_material_entry(material:u32)->u32 {
 if material>=settings.appearance1.y{return 0xffffffffu;}
 let entry=appearance_metadata[settings.appearance1.x+material];return select(0xffffffffu,entry,entry<settings.appearance1.z);
}
fn cell_directory(entry:u32)->vec4u {
 let at=settings.appearance0.w+entry*8u;
 return vec4u(appearance_metadata[at+1u],appearance_metadata[at+2u],appearance_metadata[at+3u],appearance_metadata[at+7u]);
}
fn cell_field_descriptor(program:u32,field:u32)->vec4u {
 let directory=settings.appearance0.z+program*${SURFACE_APPEARANCE_BOUND_PROGRAM_WORDS}u;
 let at=settings.appearance0.z+appearance_metadata[directory]+field*4u;
 return vec4u(appearance_metadata[at],appearance_metadata[at+1u],appearance_metadata[at+2u],appearance_metadata[at+3u]);
}
fn cell_field_present(program:u32)->u32 {
 var result=0u;for(var field=0u;field<15u;field++){if cell_field_descriptor(program,field).x!=0xffffffffu{result|=1u<<field;}}return result;
}
fn cell_scalar_attribute(field:u32,channel:u32)->CellScalarFootprint {
 return cell_scalar_footprint(cell_geometry_coefficients(cell_bound_slot,cell_bound_key),vec3f(cell_geometry_corner(cell_bound_slot,cell_bound_key,field)[channel],cell_geometry_corner(cell_bound_slot,cell_bound_key,field+6u)[channel],cell_geometry_corner(cell_bound_slot,cell_bound_key,field+12u)[channel]),
  cell_current_rect.xy,cell_current_rect.zw,vec2f(f32(cell_settings.width),f32(cell_settings.height)));
}
fn cell_attribute_box(field:u32)->AppearanceBound4 {
 var result:AppearanceBound4;
 for(var c=0u;c<4u;c++){let f=cell_scalar_attribute(field,c);result.low[c]=f.value.low;result.high[c]=f.value.high;result.known[c]=f.value.known;}
 return result;
}
fn cell_normalize_box(v:AppearanceBound4)->AppearanceBound4 {
 let length2=ab_add(ab_add(ab_square(ab_channel(v,0u)),ab_square(ab_channel(v,1u))),ab_square(ab_channel(v,2u)));
 if !ab_valid(length2)||length2.low<=1e-12{return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u));}
 let length=ab_sqrt(length2);var result=v;
 for(var c=0u;c<3u;c++){let normalized=ab_divide(ab_channel(v,c),length);result.low[c]=normalized.low;result.high[c]=normalized.high;result.known[c]=normalized.known;}
 return result;
}
fn cell_world_normal_box()->AppearanceBound4 {return cell_normalize_box(cell_attribute_box(0u));}
fn cell_world_tangent_box()->AppearanceBound4 {
 let normal=cell_world_normal_box();let tangent=cell_attribute_box(1u);var product=ab_exact(0.0);
 for(var c=0u;c<3u;c++){product=ab_add(product,ab_multiply(ab_channel(normal,c),ab_channel(tangent,c)));}
 var result=tangent;
 for(var c=0u;c<3u;c++){let projected=ab_subtract(ab_channel(tangent,c),ab_multiply(ab_channel(normal,c),product));result.low[c]=projected.low;result.high[c]=projected.high;result.known[c]=projected.known;}
 return cell_normalize_box(result);
}
fn cell_matrix_box(matrix:mat4x4f,v:AppearanceBound4,point:bool)->AppearanceBound4 {
 var result:AppearanceBound4;
 for(var row=0u;row<3u;row++){
  var sum=ab_exact(select(0.0,matrix[3u][row],point));
  for(var c=0u;c<3u;c++){sum=ab_add(sum,ab_multiply(ab_exact(matrix[c][row]),ab_channel(v,c)));}
  result.low[row]=sum.low;result.high[row]=sum.high;result.known[row]=sum.known;
 }
 return result;
}
fn cell_view_box()->AppearanceBound4 {
 var world=cell_attribute_box(5u);
 for(var c=0u;c<3u;c++){let value=ab_subtract(ab_exact(cell_camera.transform[3u][c]),ab_channel(world,c));world.low[c]=value.low;world.high[c]=value.high;world.known[c]=value.known;}
 return cell_normalize_box(world);
}
fn cell_input_kind(context:vec4u,index:u32)->u32 {
 let header=settings.appearance0.z+context.y*${SURFACE_APPEARANCE_BOUND_PROGRAM_WORDS}u;
 let at=settings.appearance0.z+appearance_metadata[header+1u]+index;return appearance_metadata[at];
}
fn ab_constant(context:vec4u,slot:u32)->f32 {
 return bitcast<f32>(appearance_metadata[settings.appearance0.x+cell_directory(context.z).y+slot]);
}
fn ab_input(context:vec4u,index:u32,channel:u32)->AppearanceBound {
 let kind=cell_input_kind(context,index);
 if kind==1u{return cell_scalar_attribute(2u,channel).value;}
 if kind==2u{return cell_scalar_attribute(2u,channel+2u).value;}
 if kind==3u{return cell_scalar_attribute(4u,channel).value;}
 if kind==4u{return cell_scalar_attribute(3u,channel).value;}
 if kind==5u||kind==11u{return ab_channel(cell_world_normal_box(),channel);}
 if kind==6u||kind==12u{return ab_channel(cell_world_tangent_box(),channel);}
 if kind==7u||kind==10u{return cell_scalar_attribute(5u,channel).value;}
 if kind==8u{return ab_channel(cell_view_box(),channel);}
 if kind==9u{return ab_exact(cell_camera.transform[3u][channel]);}
 if kind==13u{return ab_channel(cell_matrix_box(cell_camera.view_matrix,cell_attribute_box(5u),true),channel);}
 if kind==14u{return ab_channel(cell_matrix_box(cell_camera.view_matrix,cell_world_normal_box(),false),channel);}
 return ab_unknown();
}
fn ab_input_gradient(context:vec4u,index:u32,channel:u32,axis:u32)->AppearanceBound {
 let kind=cell_input_kind(context,index);var value:CellScalarFootprint;
 if kind==1u{value=cell_scalar_attribute(2u,channel);}else if kind==2u{value=cell_scalar_attribute(2u,channel+2u);}
 else if kind==3u{value=cell_scalar_attribute(4u,channel);}else if kind==4u{value=cell_scalar_attribute(3u,channel);}
 else if kind==7u||kind==10u{value=cell_scalar_attribute(5u,channel);}else if kind==9u{return ab_exact(0.0);}else{return ab_unknown();}
 if axis==0u{return value.dx;}return value.dy;
}
fn cell_uv_transform(u:AppearanceBound,v:AppearanceBound,scale:vec2f,rotation:vec2f,offset:vec2f)->array<AppearanceBound,2> {
 let x=ab_multiply(u,ab_exact(scale.x));let y=ab_multiply(v,ab_exact(scale.y));
 return array<AppearanceBound,2>(ab_add(ab_subtract(ab_multiply(ab_exact(rotation.x),x),ab_multiply(ab_exact(rotation.y),y)),ab_exact(offset.x)),
  ab_add(ab_add(ab_multiply(ab_exact(rotation.y),x),ab_multiply(ab_exact(rotation.x),y)),ab_exact(offset.y)));
}
fn cell_min_magnitude(a:AppearanceBound)->f32 {if a.low<=0.0&&a.high>=0.0{return 0.0;}return min(abs(a.low),abs(a.high));}
fn cell_max_magnitude(a:AppearanceBound)->f32 {return max(abs(a.low),abs(a.high));}
fn ab_texture(context:vec4u,sample:u32,u:AppearanceBound,v:AppearanceBound,udx:AppearanceBound,udy:AppearanceBound,vdx:AppearanceBound,vdy:AppearanceBound)->AppearanceBound4 {
 let route=settings.appearance0.y+(cell_directory(context.z).z+sample)*16u;
 let texture_reference=appearance_metadata[route];let sampler=appearance_metadata[route+1u];
 let fallback=bitcast<vec4f>(vec4u(appearance_metadata[route+12u],appearance_metadata[route+13u],appearance_metadata[route+14u],appearance_metadata[route+15u]));
 if texture_reference==${GPU_TEXTURE_REF_INVALID}u{return AppearanceBound4(fallback,fallback,vec4u(1u));}
 let identity=vec3u(appearance_metadata[route+2u],appearance_metadata[route+10u],appearance_metadata[route+3u]);
 if identity.x==0u{return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u));}
 let values=bitcast<vec4f>(vec4u(appearance_metadata[route+4u],appearance_metadata[route+5u],appearance_metadata[route+6u],appearance_metadata[route+7u]));
 let rotation=bitcast<vec2f>(vec2u(appearance_metadata[route+8u],appearance_metadata[route+9u]));
 let uv=cell_uv_transform(u,v,values.zw,rotation,values.xy);
 let dx=cell_uv_transform(udx,vdx,values.zw,rotation,vec2f(0.0));let dy=cell_uv_transform(udy,vdy,values.zw,rotation,vec2f(0.0));
 if !ab_valid(uv[0])||!ab_valid(uv[1])||!ab_valid(dx[0])||!ab_valid(dx[1])||!ab_valid(dy[0])||!ab_valid(dy[1]){
  return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u));
 }
 let descriptor=identity.x*8u;let dimensions=vec2f(f32(texture_variation[descriptor]),f32(texture_variation[descriptor+1u]));
 let lower=max(length(vec2f(cell_min_magnitude(dx[0]),cell_min_magnitude(dx[1]))*dimensions),length(vec2f(cell_min_magnitude(dy[0]),cell_min_magnitude(dy[1]))*dimensions));
 let upper=max(length(vec2f(cell_max_magnitude(dx[0]),cell_max_magnitude(dx[1]))*dimensions),length(vec2f(cell_max_magnitude(dy[0]),cell_max_magnitude(dy[1]))*dimensions));
 var lod=vec2f(log2(max(lower,1.0)),log2(max(upper,1.0)));
 let code=(sampler&${S.MipMask}u)>>${S.MipShift}u;
 if code!=${S.FullMipCode}u{lod=max(lod,vec2f(f32(code)));}
 // textureSampleGrad has implementation-defined LOD precision. Enclose both
 // adjacent choices around the analytic footprint, rather than treating a
 // software log2 as exact hardware mip selection.
 lod=vec2f(max(0.0,lod.x-1.0),lod.y+1.0);
 let wu=sampler&3u;let wv=(sampler>>2u)&3u;
 let wrap=vec2u(select(wu,3u-wu,wu!=0u),select(wv,3u-wv,wv!=0u));
 let filters=select(0u,3u,(sampler&${S.LinearBit}u)!=0u);
 let range=tv_query(identity,vec2f(uv[0].low,uv[1].low),vec2f(uv[0].high,uv[1].high),lod,wrap,filters);
 atomicAdd(&cell_counts[106u],range.nodes);
 var result=AppearanceBound4(range.low,range.high,vec4u(range.known));
 let routing=(texture_reference&${GPU_TEXTURE_REF_ROUTING_MASK}u)>>${GPU_TEXTURE_REF_ROUTING_SHIFT}u;
 if routing!=0u{let channel=select(3u,0u,routing==1u);let alpha=ab_channel(result,channel);
  result=AppearanceBound4(vec4f(1.0,1.0,1.0,alpha.low),vec4f(1.0,1.0,1.0,alpha.high),vec4u(1u,1u,1u,alpha.known));}
 return result;
}
${productBoundLibrary??""}
${selected.map(program=>program.source).join("\n")}
${selected.map(program=>program.materialSource).join("\n")}
fn cell_constant_palette(entry:u32)->u32 {return settings.appearance2.x+entry*64u;}
@compute @workgroup_size(64) fn publish_cell_material_constants(@builtin(global_invocation_id) id:vec3u){
 let entry=id.x;if entry>=settings.appearance1.z{return;}
 let program=cell_directory(entry).x;let context=vec4u(0u,program,entry,0u);var result:MaterialConstantResult;
 switch program {
 ${programs.map((_p,i)=>`case ${i}u:{result=ab_field_${i}_material(context);}`).join("\n")}
 default:{}
 }
 let at=cell_constant_palette(entry);
 appearance_metadata[at]=result.mask;appearance_metadata[at+1u]=result.exact_mask;
 appearance_metadata[at+2u]=settings.geometry.w;appearance_metadata[at+3u]=settings.appearance1.w;
 for(var field=0u;field<15u;field++){let value=bitcast<vec4u>(result.values[field]);
  for(var c=0u;c<4u;c++){appearance_metadata[at+4u+field*4u+c]=value[c];}}
}
fn cell_evaluate_bound(field:u32,context:vec4u)->AppearanceBound4 {
 let palette=cell_constant_palette(context.z);
 if (appearance_metadata[palette]&(1u<<field))!=0u {
  let at=palette+4u+field*4u;let value=bitcast<vec4f>(vec4u(appearance_metadata[at],appearance_metadata[at+1u],appearance_metadata[at+2u],appearance_metadata[at+3u]));
  return AppearanceBound4(value,value,vec4u(1u));
 }
 let descriptor=cell_field_descriptor(context.y,field);
 if descriptor.x==0xffffffffu {
  var fallback=vec4f(0.0);if field==6u||field==12u{fallback.z=1.0;}
  else if field==3u||field==4u||field==8u||field==9u||field==11u||field>=13u{fallback=vec4f(1.0);}
  else if field==7u{fallback.x=1.5;}
  return AppearanceBound4(fallback,fallback,vec4u(1u));
 }
 switch context.y {
 ${programs.map((_p,i)=>`case ${i}u:{return ab_field_${i}(descriptor.x,context);}`).join("\n")}
 default:{return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u));}
 }
}
fn cell_bound_context(fact:SurfaceCellLane,rect:vec4f)->vec4u {
 cell_bound_slot=fact.source;cell_bound_key=fact.winner;cell_current_rect=rect;
 let entry=cell_material_entry(cell_geometry_source(fact.source,fact.winner).y);return vec4u(fact.source,cell_directory(entry).x,entry,fact.winner);
}
fn cell_signal_dependencies(plane:u32)->u32 {
 if plane==15u{return (1u<<6u)|(1u<<10u)|(1u<<13u);}
 if plane==16u{return (1u<<6u)|(1u<<13u);}
 if plane>=19u{return (1u<<10u)|(1u<<11u)|(1u<<12u)|(1u<<14u);}
 return (1u<<0u)|(1u<<2u)|(1u<<3u)|(1u<<6u)|(1u<<7u)|(1u<<8u)|(1u<<9u)|(1u<<10u)|(1u<<13u);
}
fn cell_material_signal_dependencies(plane:u32,entry:u32)->u32 {
 var mask=cell_signal_dependencies(plane);
 if plane==17u||plane==18u{
  let palette=cell_constant_palette(entry);
  if (appearance_metadata[palette]&(1u<<2u))!=0u&&bitcast<f32>(appearance_metadata[palette+4u+2u*4u])==0.0{mask&=~1u;}
 }
 return mask;
}
fn surface_cell_load(pixel:vec2u,winner:u32)->SurfaceCellLane {
 let tile=(pixel.y/8u)*cell_settings.tiles_x+pixel.x/8u;let lane=(pixel.y%8u)*8u+pixel.x%8u;
 let published=cell_workspace.facts[(tile-cell_settings.first_tile)*64u+lane];
 if published.x!=winner{atomicAdd(&cell_counts[104u],1u);return SurfaceCellLane(vec4u(0u),winner,0xffffffffu,0u,0u);}
 let identity=cell_geometry_identity(published.y,winner);let continuity=cell_geometry_continuity(published.y,winner,0u);let entry=published.z;
 if entry>=settings.appearance1.z{atomicAdd(&cell_counts[104u],1u);return SurfaceCellLane(vec4u(0u),winner,published.y,0u,0u);}
 let program=cell_directory(entry).x;let palette=cell_constant_palette(entry);
 let presence=cell_field_present(program);var enabled=presence;
 let lit=(presence&((1u<<2u)|(1u<<3u)|(1u<<6u)|(1u<<7u)))!=0u;
 if lit{enabled|=63u<<15u;}
 if published.w!=0xffffffffu && (published.w&0x80000000u)!=0u{enabled&=~((1u<<15u)|(1u<<17u)|(1u<<19u));}
 let constants=appearance_metadata[palette];let publication=constants&presence;
 // A publication-only absent coat has no lighting work or packet/history slot.
 if lit&&(constants&(1u<<10u))!=0u{
  let coat=bitcast<f32>(appearance_metadata[palette+4u+10u*4u]);
  if coat<=0.0{enabled&=~((1u<<19u)|(1u<<20u));}
 }
 return SurfaceCellLane(vec4u(identity.xyz,continuity.x),winner,published.y,enabled,publication);
}
fn cell_seam_compatible(mask:u32,a:SurfaceCellLane,b:SurfaceCellLane)->bool {
 let ac=cell_geometry_continuity(a.source,a.winner,0u);let bc=cell_geometry_continuity(b.source,b.winner,0u);
 let ad=cell_geometry_continuity(a.source,a.winner,1u);let bd=cell_geometry_continuity(b.source,b.winner,1u);
 if (mask&1u)!=0u && ac.y!=bc.y{return false;}
 if (mask&2u)!=0u && ac.z!=bc.z{return false;}
 if (mask&4u)!=0u && ac.w!=bc.w{return false;}
 if (mask&8u)!=0u && ad.x!=bd.x{return false;}
 if (mask&16u)!=0u && ad.y!=bd.y{return false;}
 // UV2 has no chart lineage publication yet. Only this field's closure uses a
 // representation-local primitive namespace, never the blanket winner gate.
 if (mask&64u)!=0u && any(cell_geometry_address(a.source,a.winner).xyz!=cell_geometry_address(b.source,b.winner).xyz){return false;}
 return true;
}
fn surface_cell_compatible(plane:u32,a:SurfaceCellLane,b:SurfaceCellLane)->bool {
 if a.identity.w==0u || any(a.identity!=b.identity){return false;}
 let sa=cell_geometry_source(a.source,a.winner);let sb=cell_geometry_source(b.source,b.winner);
 if cell_geometry_identity(a.source,a.winner).w!=cell_geometry_identity(b.source,b.winner).w||any(sa.zw!=sb.zw)||sa.y!=sb.y{return false;}
 let entry=cell_material_entry(sa.y);let program=cell_directory(entry).x;
 var fields=cell_material_signal_dependencies(plane,entry);if plane<15u{fields=1u<<plane;}
 for(var field=0u;field<15u;field++){if (fields&(1u<<field))!=0u{
  let seam=cell_field_descriptor(program,field).y;if !cell_seam_compatible(seam,a,b){return false;}
 }}
 if plane>=15u && !cell_seam_compatible(12u,a,b){return false;}
 return true;
}
fn cell_merge_bound(a:AppearanceBound4,b:AppearanceBound4)->AppearanceBound4 {
 return AppearanceBound4(min(a.low,b.low),max(a.high,b.high),a.known&b.known);
}
fn cell_group_field(field:u32,mask:vec2u,lanes:ptr<workgroup,array<SurfaceCellLane,64>>,rect:vec4f)->AppearanceBound4 {
 var result=AppearanceBound4(vec4f(1e30),vec4f(-1e30),vec4u(1u));
 for(var i=0u;i<64u;i++) {if !cell_member(mask,i){continue;}var seen=false;
  for(var j=0u;j<i;j++){if cell_member(mask,j)&&(*lanes)[j].winner==(*lanes)[i].winner{seen=true;break;}}
  if seen{continue;}
  let context=cell_bound_context((*lanes)[i],rect);result=cell_merge_bound(result,cell_evaluate_bound(field,context));
 }
 return result;
}
fn cell_field_budget(field:u32,value:AppearanceBound4)->bool {
 let width=select(1u,3u,field==0u||field==5u||field==6u||field==9u||field==12u);
 for(var c=0u;c<width;c++){if value.known[c]==0u{return false;}}
 if field==6u||field==12u{return cell_normal_box_cone(value.low.xyz,value.high.xyz).w>=0.9986295348;}
 var tolerance=0.02;if field==5u{tolerance*=max(1.0,max(max(abs(value.high.x),abs(value.high.y)),abs(value.high.z)));}
 for(var c=0u;c<width;c++){if value.high[c]-value.low[c]>tolerance{return false;}}return true;
}
${directRiskLibrary}
fn surface_cell_group_valid(plane:u32,mask:vec2u,lanes:ptr<workgroup,array<SurfaceCellLane,64>>,origin:vec2u)->bool {
 let first=cell_first(mask);if first==0xffffffffu{return false;}
 let rect=cell_rect_from_mask(mask,origin);
 let root=(*lanes)[first];let root_plane=cell_geometry_plane(root.source,root.winner);
 var world=AppearanceBound4(vec4f(1e30),vec4f(-1e30),vec4u(1u));
 var normal=world;var tangent=world;var view=world;var scale=1e30;
 for(var i=0u;i<64u;i++){
  if !cell_member(mask,i){continue;}var seen=false;
  for(var j=0u;j<i;j++){if cell_member(mask,j)&&(*lanes)[j].winner==(*lanes)[i].winner{seen=true;break;}}
  if seen{continue;}
  let context=cell_bound_context((*lanes)[i],rect);let position=cell_attribute_box(5u);world=cell_merge_bound(world,position);
  var dx2=0.0;var dy2=0.0;
  for(var c=0u;c<3u;c++){
   let value=cell_scalar_attribute(5u,c);if !ab_valid(value.value)||!ab_valid(value.dx)||!ab_valid(value.dy){return false;}
   dx2+=cell_max_magnitude(value.dx)*cell_max_magnitude(value.dx);dy2+=cell_max_magnitude(value.dy)*cell_max_magnitude(value.dy);
  }
  let pixel_scale=max(sqrt(dx2),sqrt(dy2));scale=min(scale,pixel_scale);
  // Preserve correlation across XYZ: an inclined coplanar wall is still a
  // plane. Summing independent position boxes would reject every coarse cell.
  let plane_values=vec3f(dot(root_plane,cell_geometry_corner(cell_bound_slot,cell_bound_key,5u)),dot(root_plane,cell_geometry_corner(cell_bound_slot,cell_bound_key,11u)),dot(root_plane,cell_geometry_corner(cell_bound_slot,cell_bound_key,17u)));
  let distance=cell_scalar_footprint(cell_geometry_coefficients(cell_bound_slot,cell_bound_key),plane_values,rect.xy,rect.zw,vec2f(f32(cell_settings.width),f32(cell_settings.height))).value;
  if !ab_valid(distance)||max(abs(distance.low),abs(distance.high))>pixel_scale*0.5{return false;}
  if plane>=15u{normal=cell_merge_bound(normal,cell_world_normal_box());tangent=cell_merge_bound(tangent,cell_world_tangent_box());view=cell_merge_bound(view,cell_view_box());}
  if plane<15u {
   let descriptor=cell_field_descriptor(context.y,plane);
   if (cell_geometry_continuity(cell_bound_slot,cell_bound_key,1u).w&descriptor.y)!=0u{return false;}
  }
 }
 if plane<15u {
  let value=cell_group_field(plane,mask,lanes,rect);let valid=cell_field_budget(plane,value);
  if !valid{atomicAdd(&cell_counts[88u+plane],1u);}return valid;
 }
 if any(normal.known.xyz==vec3u(0u)){return false;}
 let mapped=cell_group_field(select(6u,12u,plane>=19u),mask,lanes,rect);
 if any(mapped.known.xyz==vec3u(0u)){return false;}
 let nc=cell_normal_box_cone(normal.low.xyz,normal.high.xyz);var tc=vec4f(1.0,0.0,0.0,1.0);let mc=cell_normal_box_cone(mapped.low.xyz,mapped.high.xyz);
 if any(mapped.low.xy!=vec2f(0.0))||any(mapped.high.xy!=vec2f(0.0)){
  if any(tangent.known.xyz==vec3u(0u)){return false;}tc=cell_normal_box_cone(tangent.low.xyz,tangent.high.xyz);
 }
 if min(nc.w,min(tc.w,mc.w))<0.0{return false;}
 if acos(clamp(nc.w,-1.0,1.0))+acos(clamp(tc.w,-1.0,1.0))+acos(clamp(mc.w,-1.0,1.0))>0.05235987756{return false;}
 let dependencies=cell_material_signal_dependencies(plane,cell_material_entry(cell_geometry_source(root.source,root.winner).y));
 for(var field=0u;field<15u;field++){
  if (dependencies&(1u<<field))==0u||field==6u||field==12u{continue;}
  let value=cell_group_field(field,mask,lanes,rect);if !cell_field_budget(field,value){return false;}
 }
 if plane>=17u {
  let roughness=cell_group_field(select(3u,11u,plane>=19u),mask,lanes,rect);
  if roughness.known.x==0u||roughness.low.x<0.35{return false;}
  if any(view.known.xyz==vec3u(0u)){return false;}
  if cell_normal_box_cone(view.low.xyz,view.high.xyz).w<0.9986295348{return false;}
 }
 if plane==15u{
  let coat=cell_group_field(10u,mask,lanes,rect);
  if coat.known.x==0u{return false;}
  if coat.high.x>0.0 && (any(view.known.xyz==vec3u(0u))||cell_normal_box_cone(view.low.xyz,view.high.xyz).w<0.9986295348){return false;}
 }
 if plane==15u||plane==17u||plane==19u{return cell_direct_group_safe(mask,lanes,origin,rect,world.low.xyz,world.high.xyz,scale);}
 return true;
}
`.replaceAll("cell_dictionary[","geometry_arena.dictionary[").replaceAll("geometry_setups[","geometry_arena.setups[");
  return includeGenericValidation ? source : removeWgslFunction(source, "surface_cell_group_valid");
}

function removeWgslFunction(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}`); if (start < 0) return source;
  const open = source.indexOf("{", start); if (open < 0) return source;
  let depth = 0, end = open;
  for (; end < source.length; end++) {
    const character = source[end];
    if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return source.slice(0, start) + source.slice(end + 1);
  }
  return source;
}

/** Keep the complete generated function envelope while removing unreachable
 * field cases for a bounded classifier stage. Material constant publication
 * still uses the unfiltered program, so this is a compile-size partition, not
 * a semantic approximation of the appearance graph. */
function restrictAppearanceBoundSource(source: string, fields: ReadonlySet<number>): string {
  const switchAt = source.indexOf("switch field");
  if (switchAt < 0 || fields.size === 0) return source;
  const open = source.indexOf("{", switchAt);
  if (open < 0) return source;
  const cases: string[] = [];
  const pattern = /case\s+(\d+)u\s*:\s*\{/g;
  pattern.lastIndex = open + 1;
  for (;;) {
    const match = pattern.exec(source);
    if (!match) break;
    const number = Number(match[1]);
    const bodyOpen = match.index + match[0].length - 1;
    let depth = 0, end = bodyOpen;
    for (; end < source.length; end++) {
      const character = source[end];
      if (character === "{") depth++;
      else if (character === "}" && --depth === 0) break;
    }
    if (fields.has(number)) cases.push(source.slice(match.index, end + 1));
    pattern.lastIndex = end + 1;
  }
  if (cases.length === 0) return source;
  return `${source.slice(0, open + 1)}\n${cases.join("\n")}\ndefault:{return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u));}\n}}`;
}
