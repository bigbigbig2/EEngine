import { LIGHT_DATABASE_READ_WGSL, POINT_LIGHT_DESCRIPTOR, SPOT_LIGHT_DESCRIPTOR,
  DIRECTIONAL_LIGHT_DESCRIPTOR, LIGHT_FLAG_CASTS_SHADOW } from "../gpu/LightDatabase.js";
import { CLUSTER_METADATA_FLAG_FALLBACK } from "../render/ClusteredLightingReference.js";
import { SURFACE_CELL_TILE_PLAN_BYTES } from "../gpu/GpuSurfaceCellPlanAbi.js";

/** Lighting-owned rate predicate. Reads the SAME current light database and
 * cluster publication as the heavy worker. Full list equality is authoritative;
 * an equal hash or material is never a proof of light-set identity. Punctual
 * distance/cutoff/cone ranges use existing production attenuation math. Shadow
 * state without a receiver-region certificate rejects this direct component;
 * environment and unrelated fields retain their own rates. */
export const SURFACE_CELL_LIGHTING_RISK_WGSL = /* wgsl */ `
${LIGHT_DATABASE_READ_WGSL}
fn saturate(value:f32)->f32 {return clamp(value,0.0,1.0);}
struct CellClusterMetadata {offset:u32,point_count:u32,spot_count:u32,flags:u32,}
struct CellClusterData {attempted:u32,written:u32,capacity:u32,overflow:u32,active_written:u32,_reserved0:u32,_reserved1:u32,_reserved2:u32,data:array<u32>,}
@group(2) @binding(0) var<storage,read> cell_light_records:array<u32>;
@group(2) @binding(1) var<storage,read> cell_cluster_lookup:array<CellClusterMetadata>;
@group(2) @binding(2) var<storage,read> cell_cluster_data:CellClusterData;
@group(2) @binding(3) var<uniform> cell_cluster_parameters:vec3f;
fn cell_cluster_at(pixel:vec2f,depth:f32)->u32 {
 let dimensions=(vec2u(cell_settings.width,cell_settings.height)+vec2u(31u))/32u;
 let projected=fma(depth,cell_cluster_parameters.x,cell_cluster_parameters.y);
 if projected<=0.0{return 0xffffffffu;}
 let slice=min(23u,u32(max(0.0,log2(projected)*cell_cluster_parameters.z)));
 let xy=vec2u(u32(pixel.x/32.0),u32((f32(cell_settings.height)-pixel.y)/32.0));
 return xy.x+(xy.y+slice*dimensions.y)*dimensions.x;
}
fn cell_light_lists_equal(a:u32,b:u32)->bool {
 if a>=arrayLength(&cell_cluster_lookup)||b>=arrayLength(&cell_cluster_lookup){return false;}
 let left=cell_cluster_lookup[a];let right=cell_cluster_lookup[b];
 if ((left.flags|right.flags)&${CLUSTER_METADATA_FLAG_FALLBACK}u)!=0u{return false;}
 if left.point_count!=right.point_count||left.spot_count!=right.spot_count{return false;}
 let count=left.point_count+left.spot_count;
 if left.offset+count>min(cell_cluster_data.written,arrayLength(&cell_cluster_data.data))||
  right.offset+count>min(cell_cluster_data.written,arrayLength(&cell_cluster_data.data)){return false;}
 if a==b{return true;}
 for(var i=0u;i<count;i++){if cell_cluster_data.data[left.offset+i]!=cell_cluster_data.data[right.offset+i]{return false;}}
 return true;
}
fn cell_punctual_safe(position:vec3f,radius:f32,cutoff:f32,flags:u32,spot:bool,direction:vec3f,cone_cos:f32,penumbra_cos:f32,
 world_low:vec3f,world_high:vec3f)->bool {
 let center=(world_low+world_high)*0.5;let region_radius=length((world_high-world_low)*0.5);
 let vector=position-center;let distance=length(vector);
 let nearest=max(0.0,distance-region_radius);let farthest=distance+region_radius;
 let maximum=light_sphere_distance_attenuation(nearest,radius,cutoff);let minimum=light_sphere_distance_attenuation(farthest,radius,cutoff);
 if maximum<=0.0{return true;}
 if (flags&${LIGHT_FLAG_CASTS_SHADOW}u)!=0u{return false;}
 if distance<=region_radius||distance<=1e-6{return false;}
 let angle=asin(clamp(region_radius/distance,0.0,1.0));if angle>0.05235987756{return false;}
 if (maximum-minimum)/max(maximum,1e-8)>0.02{return false;}
 if spot {
  let direction_length=length(direction);if direction_length<=1e-6{return false;}
  let center_angle=acos(clamp(dot(vector/distance,-direction/direction_length),-1.0,1.0));
  let low=cos(min(3.14159265359,center_angle+angle));let high=cos(max(0.0,center_angle-angle));
  let a=light_get_spot_attenuation(cone_cos,penumbra_cos,low);let b=light_get_spot_attenuation(cone_cos,penumbra_cos,high);
  if b-a>0.02{return false;}
 }
 return true;
}
fn cell_direct_group_safe(mask:vec2u,lanes:ptr<workgroup,array<SurfaceCellLane,64>>,origin:vec2u,rect:vec4f,world_low:vec3f,world_high:vec3f,pixel_scale:f32)->bool {
 let first=cell_first(mask);var cluster=0xffffffffu;
 for(var lane=0u;lane<64u;lane++){
  if !cell_member(mask,lane){continue;}
  let pixel=origin+vec2u(lane%8u,lane/8u);let local_tile=cell_local_tile;
  let facts=cell_workspace.facts[local_tile*64u+lane];let candidate=facts.w&0x7fffffffu;
 if facts.w==0xffffffffu{return false;}
  if cluster==0xffffffffu{cluster=candidate;}else if !cell_light_lists_equal(cluster,candidate){return false;}
 }
 if cluster>=arrayLength(&cell_cluster_lookup){return false;}
 let metadata=cell_cluster_lookup[cluster];
 if (metadata.flags&${CLUSTER_METADATA_FLAG_FALLBACK}u)!=0u{return false;}
 let count=metadata.point_count+metadata.spot_count;
 if metadata.offset+count>min(cell_cluster_data.written,arrayLength(&cell_cluster_data.data)){return false;}
 for(var i=0u;i<count;i++){
  let light_index=cell_cluster_data.data[metadata.offset+i];
  if i<metadata.point_count {
   let light=${POINT_LIGHT_DESCRIPTOR.marshalling_method_read}(&cell_light_records,light_index);
   if !cell_punctual_safe(light.position,light.radius,light.distance,light.flags,false,vec3f(0.0),0.0,0.0,world_low,world_high){return false;}
  }else{
   let light=${SPOT_LIGHT_DESCRIPTOR.marshalling_method_read}(&cell_light_records,light_index);
   if !cell_punctual_safe(light.position,light.radius,light.distance,light.flags,true,light.direction,light.coneCos,light.penumbraCos,world_low,world_high){return false;}
  }
 }
 var directional=directional_lights_iteration_mask(&cell_light_records);
 for(var i=0u;i<32u;i++){
  if (directional&(1u<<i))==0u{continue;}
  let light=${DIRECTIONAL_LIGHT_DESCRIPTOR.marshalling_method_read}(&cell_light_records,i);
  if (light.flags&${LIGHT_FLAG_CASTS_SHADOW}u)!=0u && (settings.appearance2.y&1u)!=0u{return false;}
 }
 // Physical solar shadow follows the same actual VSM-enabled provider fact.
 if (settings.appearance2.y&3u)==3u{return false;}
 return true;
}
fn cell_publish_lane_fact(pixel:vec2u)->vec4u {
 if pixel.x>=cell_settings.width||pixel.y>=cell_settings.height{return vec4u(0xffffffffu);}
 let key=textureLoad(cell_visibility,vec2i(pixel),0).x;if key==0xffffffffu{return vec4u(0xffffffffu);}
 let slot=cell_geometry_slot(key);let entry=cell_material_entry(cell_geometry_source(slot,key).y);
 var cluster=0xffffffffu;
 let interpolation=winner_interpolate(cell_geometry_coefficients(slot,key),vec2f(pixel)+vec2f(0.5),vec2f(f32(cell_settings.width),f32(cell_settings.height)));
 if (interpolation.flags&1u)!=0u {
  let position=cell_geometry_corner(slot,key,5u).xyz*interpolation.weights.x+cell_geometry_corner(slot,key,11u).xyz*interpolation.weights.y+cell_geometry_corner(slot,key,17u).xyz*interpolation.weights.z;
  let depth=-(cell_camera.view_matrix*vec4f(position,1.0)).z;cluster=cell_cluster_at(vec2f(pixel)+vec2f(0.5),depth);
  if cluster<arrayLength(&cell_cluster_lookup){let metadata=cell_cluster_lookup[cluster];
   if (metadata.flags&${CLUSTER_METADATA_FLAG_FALLBACK}u)==0u && metadata.point_count+metadata.spot_count==0u &&
     directional_lights_iteration_mask(&cell_light_records)==0u && (settings.appearance2.y&2u)==0u{cluster|=0x80000000u;}}
 }
 return vec4u(key,slot,entry,cluster);
}
var<workgroup> cell_published_primitive_keys:array<u32,64>;
@compute @workgroup_size(64)
fn publish_cell_facts(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
 if group.x>=cell_settings.tile_count { return; }
 cell_local_tile=group.x;
 let tile=cell_workspace.plans[group.x*${SURFACE_CELL_TILE_PLAN_BYTES/4}u+4u];
 let pixel=vec2u((tile%cell_settings.tiles_x)*8u+lane%8u,(tile/cell_settings.tiles_x)*8u+lane/8u);
 let fact=cell_publish_lane_fact(pixel);
 cell_workspace.facts[group.x*64u+lane]=fact;
 cell_published_primitive_keys[lane]=fact.x;
 workgroupBarrier();
 var primitive=lane;
 if fact.x!=0xffffffffu {
   for(var member=0u;member<lane;member++) {
     if cell_published_primitive_keys[member]==fact.x { primitive=member; break; }
   }
 }
 cell_workspace.primitives[group.x*64u+lane]=primitive;
}
`;
