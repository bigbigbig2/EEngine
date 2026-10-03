import { SURFACE_CELL_PLANE_COUNT, SURFACE_CELL_FIELD_COUNT, SURFACE_CELL_TILE_PLAN_BYTES, SURFACE_CELL_PLANE_BYTES, surfaceCellWorkspaceWgsl } from "../gpu/GpuSurfaceCellPlanAbi.js";

/** Compact reference classifier. It keeps the production fact ABI explicit and
 * performs the bounded 8x8 partition in one workgroup. The production cutover
 * may split this source into merge stages without changing the workspace ABI. */
export function surfaceCellClassifyStageWgsl(factLibrary: string, tileCapacity = 4096,
  stageIndex = 0, planeStart = 0, planeCount = SURFACE_CELL_PLANE_COUNT,
  entryPoint = "classify_cells", validateBounds: boolean | "field" | "field-geometry" | "full" | "single" = true): string {
  if (!factLibrary.includes("fn surface_cell_load(") || !factLibrary.includes("fn surface_cell_compatible(")) throw new Error("Surface classifier requires complete fact producers");
  const groupPredicate = validateBounds ? "surface_cell_group_valid_stage(plane,region,&cell_facts,origin)" : "cell_region_compatible(plane,region)";
  return /* wgsl */ `
struct CellSettings { width:u32,height:u32,tiles_x:u32,first_tile:u32,tile_count:u32,batch_target_capacity:u32,generation:u32,reserved:u32, }
struct SurfaceCellLane { identity:vec4u,winner:u32,source:u32,enabled:u32,publication:u32, }
${surfaceCellWorkspaceWgsl(tileCapacity)}
@group(0) @binding(0) var<uniform> cell_settings:CellSettings;
@group(0) @binding(1) var cell_visibility:texture_2d<u32>;
@group(0) @binding(2) var<storage,read_write> cell_workspace:SurfaceCellWorkspace;
var<workgroup> cell_facts:array<SurfaceCellLane,64>;
var<workgroup> cell_owner:array<u32,64>;
fn cell_bit(lane:u32)->vec2u {if lane<32u{return vec2u(1u<<lane,0u);}return vec2u(0u,1u<<(lane-32u));}
fn cell_member(mask:vec2u,lane:u32)->bool{return any((mask&cell_bit(lane))!=vec2u(0u));}
fn cell_first(mask:vec2u)->u32 {if mask.x!=0u{return firstTrailingBit(mask.x);}if mask.y!=0u{return 32u+firstTrailingBit(mask.y);}return 0xffffffffu;}
fn cell_region(lane:u32,width:u32,height:u32)->vec2u {let origin=vec2u((lane%8u)/width*width,(lane/8u)/height*height);var mask=vec2u(0u);for(var y=0u;y<height;y++){for(var x=0u;x<width;x++){mask|=cell_bit((origin.y+y)*8u+origin.x+x);}}return mask;}
fn cell_plan_at(tile:u32,plane:u32)->u32{return tile*${SURFACE_CELL_TILE_PLAN_BYTES/4}u+16u+plane*${SURFACE_CELL_PLANE_BYTES/4}u;}
fn cell_map_at(tile:u32,plane:u32)->u32{return (tile*${SURFACE_CELL_PLANE_COUNT}u+plane)*24u;}
fn cell_map_write(tile:u32,plane:u32,lane:u32,value:u32){let bit=lane*6u;let at=cell_map_at(tile,plane)+(bit>>5u);let shift=bit&31u;cell_workspace.maps[at]=cell_workspace.maps[at]|(value<<shift);if shift>26u{cell_workspace.maps[at+1u]=cell_workspace.maps[at+1u]|(value>>(32u-shift));}}
fn cell_map_write_base(base:u32,lane:u32,value:u32){let bit=lane*6u;let at=base+(bit>>5u);let shift=bit&31u;cell_workspace.maps[at]=cell_workspace.maps[at]|(value<<shift);if shift>26u{cell_workspace.maps[at+1u]=cell_workspace.maps[at+1u]|(value>>(32u-shift));}}
fn cell_region_compatible(plane:u32,region:vec2u)->bool{for(var i=0u;i<64u;i++){if !cell_member(region,i){continue;}for(var j=0u;j<i;j++){if cell_member(region,j)&&!surface_cell_compatible(plane,cell_facts[i],cell_facts[j]){return false;}}}return true;}
${factLibrary.replaceAll("cell_counts[", "cell_workspace.counters[").replaceAll("cell_plans[", "cell_workspace.plans[").replaceAll("cell_maps[", "cell_workspace.maps[")}
  ${validateBounds ? surfaceCellStageGroupValidWgsl(planeStart, planeCount, validateBounds === "single" ? "single" : validateBounds === "field" ? "field" : validateBounds === "field-geometry" ? "field-geometry" : "full") : ""}
@compute @workgroup_size(64) fn ${entryPoint}(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
 let tile=group.x;if tile>=cell_settings.tile_count{return;}
 let absolute=cell_settings.first_tile+tile;let origin=vec2u((absolute%cell_settings.tiles_x)*8u,(absolute/cell_settings.tiles_x)*8u);let pixel=origin+vec2u(lane%8u,lane/8u);
 var fact=SurfaceCellLane(vec4u(0u),0xffffffffu,0u,0u,0u);if pixel.x<cell_settings.width&&pixel.y<cell_settings.height{let winner=textureLoad(cell_visibility,vec2i(pixel),0).x;if winner!=0xffffffffu{fact=surface_cell_load(pixel,winner);}}
 cell_facts[lane]=fact;workgroupBarrier();
 if lane==0u {
  for(var plane=${planeStart}u;plane<${planeStart + planeCount}u;plane++){
   var valid=0u;var publication=true;var coverage=vec2u(0u);for(var i=0u;i<64u;i++){cell_owner[i]=i;if (cell_facts[i].enabled&(1u<<plane))!=0u{valid++;coverage|=cell_bit(i);publication=publication&&(cell_facts[i].publication&(1u<<plane))!=0u;}}
   var irregular=false;for(var i=0u;i<64u;i++){if (cell_facts[i].enabled&(1u<<plane))!=0u{for(var j=0u;j<i;j++){if (cell_facts[j].enabled&(1u<<plane))!=0u&&!surface_cell_compatible(plane,cell_facts[i],cell_facts[j]){irregular=true;}}}}
   var mode=4u;var rate=0u;var slots=valid;
   var identityCount=0u;for(var i=0u;i<64u;i++){if (cell_facts[i].enabled&(1u<<plane))!=0u{var seen=false;for(var j=0u;j<i;j++){if (cell_facts[j].enabled&(1u<<plane))!=0u&&all(cell_facts[j].identity==cell_facts[i].identity){seen=true;}}if !seen{identityCount++;}}}
   if valid==0u{mode=0u;slots=0u;}else if publication{mode=1u;slots=0u;}else if irregular{mode=select(2u,4u,identityCount<valid);slots=select(64u,identityCount,identityCount<valid);}else{
    var gridRate=10u;if plane==15u||plane==16u{gridRate=15u;}var gridWidth=1u<<(gridRate&3u);var gridHeight=1u<<((gridRate>>2u)&3u);var regular=true;
    for(var i=0u;i<64u;i++){if (cell_facts[i].enabled&(1u<<plane))!=0u{let region=cell_region(i,gridWidth,gridHeight);if !${groupPredicate}{regular=false;}}}
    if regular{mode=3u;rate=gridRate;slots=(8u>>((gridRate)&3u))*(8u>>((gridRate>>2u)&3u));}else{mode=2u;slots=64u;}
   }
   let at=cell_plan_at(tile,plane);cell_workspace.plans[at]=mode|(rate<<8u);cell_workspace.plans[at+3u]=slots;cell_workspace.plans[at+4u]=coverage.x;cell_workspace.plans[at+5u]=coverage.y;
   if plane==0u{let header=tile*${SURFACE_CELL_TILE_PLAN_BYTES/4}u;cell_workspace.plans[header]=origin.x;cell_workspace.plans[header+1u]=origin.y;cell_workspace.plans[header+2u]=coverage.x;cell_workspace.plans[header+3u]=coverage.y;}
   if mode==4u{for(var i=0u;i<64u;i++){if (cell_facts[i].enabled&(1u<<plane))!=0u{var representative=i;for(var j=0u;j<i;j++){if (cell_facts[j].enabled&(1u<<plane))!=0u&&all(cell_facts[j].identity==cell_facts[i].identity){representative=j;break;}}cell_map_write(tile,plane,i,representative);cell_map_write_base(cell_map_at(tile,plane)+12u,i,representative);}}}
   if irregular|| (mode==3u&&valid>slots){atomicAdd(&cell_workspace.counters[plane*4u+2u],1u);}
   atomicAdd(&cell_workspace.counters[plane*4u],slots);
  }
 }
 workgroupBarrier();
}
`;
}

/** Stage-specialized conservative predicate. The full fact library remains
 * available for the producers, but a classifier stage only reaches the field
 * or signal families assigned to it. This keeps Dawn's compiler call graph
 * bounded without dropping any of the V1 safety predicates. */
function surfaceCellStageGroupValidWgsl(planeStart: number, planeCount: number, mode: "field" | "field-geometry" | "full" | "single"): string {
  const end = planeStart + planeCount;
  const fieldStage = planeStart < SURFACE_CELL_FIELD_COUNT;
  const signalStage = end > SURFACE_CELL_FIELD_COUNT;
  const fixedField = planeCount === 1 && fieldStage ? `${planeStart}u` : "field";
  const fixedGroup = planeCount === 1 && fieldStage ? "cell_group_field_fixed(mask,lanes,rect)" : "cell_group_field(plane,mask,lanes,rect)";
  const fixedFunction = planeCount === 1 && fieldStage ? `fn cell_group_field_fixed(mask:vec2u,lanes:ptr<workgroup,array<SurfaceCellLane,64>>,rect:vec4f)->AppearanceBound4{var result=AppearanceBound4(vec4f(1e30),vec4f(-1e30),vec4u(1u));for(var i=0u;i<64u;i++){if !cell_member(mask,i){continue;}var seen=false;for(var j=0u;j<i;j++){if cell_member(mask,j)&&(*lanes)[j].winner==(*lanes)[i].winner{seen=true;break;}}if seen{continue;}let context=cell_bound_context((*lanes)[i],rect);result=cell_merge_bound(result,cell_evaluate_bound(${fixedField},context));}return result;}` : "";
  const common = mode === "field" || mode === "single" ? "" : `let root=(*lanes)[first];let root_plane=cell_geometry_plane(root.source,root.winner);\n var world=AppearanceBound4(vec4f(1e30),vec4f(-1e30),vec4u(1u));var scale=1e30;\n for(var i=0u;i<64u;i++){\n  if !cell_member(mask,i){continue;}let context=cell_bound_context((*lanes)[i],rect);let position=cell_attribute_box(5u);world=cell_merge_bound(world,position);var dx2=0.0;var dy2=0.0;\n  for(var c=0u;c<3u;c++){let value=cell_scalar_attribute(5u,c);if !ab_valid(value.value)||!ab_valid(value.dx)||!ab_valid(value.dy){return false;}dx2+=cell_max_magnitude(value.dx)*cell_max_magnitude(value.dx);dy2+=cell_max_magnitude(value.dy)*cell_max_magnitude(value.dy);}\n  let pixel_scale=max(sqrt(dx2),sqrt(dy2));scale=min(scale,pixel_scale);\n  let plane_values=vec3f(dot(root_plane,cell_geometry_corner(cell_bound_slot,cell_bound_key,5u)),dot(root_plane,cell_geometry_corner(cell_bound_slot,cell_bound_key,11u)),dot(root_plane,cell_geometry_corner(cell_bound_slot,cell_bound_key,17u)));\n  let distance=cell_scalar_footprint(cell_geometry_coefficients(cell_bound_slot,cell_bound_key),plane_values,rect.xy,rect.zw,vec2f(f32(cell_settings.width),f32(cell_settings.height))).value;\n  if !ab_valid(distance)||max(abs(distance.low),abs(distance.high))>pixel_scale*0.5{return false;}\n }`;
  return /* wgsl */ `${fixedFunction}
fn surface_cell_group_valid_stage(plane:u32,mask:vec2u,lanes:ptr<workgroup,array<SurfaceCellLane,64>>,origin:vec2u)->bool {
 let first=cell_first(mask);if first==0xffffffffu{return false;}let rect=cell_rect_from_mask(mask,origin);${common}
 ${fieldStage ? `${mode === "single" ? `if plane<${SURFACE_CELL_FIELD_COUNT}u{return cell_field_budget(${fixedField},cell_evaluate_bound(${fixedField},cell_bound_context((*lanes)[first],rect)));}` : `if plane<${SURFACE_CELL_FIELD_COUNT}u{let value=${fixedGroup};return cell_field_budget(${fixedField},value);}`}` : ""}
 ${signalStage ? `
 if plane>=${SURFACE_CELL_FIELD_COUNT}u{
  let normal=cell_group_field(6u,mask,lanes,rect);let mapped=cell_group_field(select(6u,12u,plane>=19u),mask,lanes,rect);
  if any(normal.known.xyz==vec3u(0u))||any(mapped.known.xyz==vec3u(0u)){return false;}
  if cell_normal_box_cone(normal.low.xyz,normal.high.xyz).w<0.0{return false;}
  let dependencies=cell_material_signal_dependencies(plane,cell_material_entry(cell_geometry_source(root.source,root.winner).y));
  for(var field=0u;field<15u;field++){if (dependencies&(1u<<field))==0u||field==6u||field==12u{continue;}if !cell_field_budget(field,cell_group_field(field,mask,lanes,rect)){return false;}}
  if plane>=17u{let roughness=cell_group_field(select(3u,11u,plane>=19u),mask,lanes,rect);if roughness.known.x==0u||roughness.low.x<0.35{return false;}if cell_normal_box_cone(cell_view_box().low.xyz,cell_view_box().high.xyz).w<0.9986295348{return false;}}
  if plane==15u{let coat=cell_group_field(10u,mask,lanes,rect);if coat.known.x==0u{return false;}if coat.high.x>0.0&&cell_normal_box_cone(cell_view_box().low.xyz,cell_view_box().high.xyz).w<0.9986295348{return false;}}
  if plane==15u||plane==17u||plane==19u{return cell_direct_group_safe(mask,lanes,origin,rect,world.low.xyz,world.high.xyz,scale);}
  return true;
 }` : ""}
 return false;
}
`;
}

/** Complete production entry point retained for small fixtures. Runtime uses
 * the five bounded stage entry points so Chromium does not compile one
 * monolithic dynamic-plane kernel on the frame path. */
export function surfaceCellClassifyWgsl(factLibrary: string, tileCapacity = 4096): string {
  return surfaceCellClassifyStageWgsl(factLibrary, tileCapacity, 0, 0, SURFACE_CELL_PLANE_COUNT, "classify_cells");
}
