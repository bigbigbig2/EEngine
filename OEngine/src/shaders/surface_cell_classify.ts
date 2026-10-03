import { surfaceCellGroupValidationWgsl } from "./surface_cell_group_validation.js";
import { SURFACE_CELL_PLANE_COUNT, SURFACE_CELL_TILE_PLAN_BYTES, SURFACE_CELL_PLANE_BYTES, surfaceCellWorkspaceWgsl } from "../gpu/GpuSurfaceCellPlanAbi.js";

/** Fixed bottom-up cell hierarchy. Disjoint candidates execute cooperatively;
 * lane zero only publishes the final compact plan. */
export function surfaceCellClassifyStageWgsl(factLibrary: string, tileCapacity = 4096,
  stageIndex = 0, planeStart = 0, planeCount = SURFACE_CELL_PLANE_COUNT,
  entryPoint = "classify_cells", validateBounds: boolean | "field" | "field-geometry" | "full" | "single" = true): string {
  if (!factLibrary.includes("fn surface_cell_load(") || !factLibrary.includes("fn surface_cell_compatible(")) throw new Error("Surface classifier requires complete fact producers");
  const specializedBounds = typeof validateBounds === "string";
  const groupPredicate = specializedBounds
    ? "surface_cell_group_valid_stage(plane,region,&cell_facts,origin)"
    : validateBounds
      ? "surface_cell_group_valid(plane,region,&cell_facts,origin)"
      : "cell_region_compatible(plane,region)";
  return /* wgsl */ `
struct CellSettings { width:u32,height:u32,tiles_x:u32,first_tile:u32,tile_count:u32,batch_target_capacity:u32,generation:u32,reserved:u32, }
struct SurfaceCellLane { identity:vec4u,winner:u32,source:u32,enabled:u32,publication:u32, }
${surfaceCellWorkspaceWgsl(tileCapacity)}
@group(0) @binding(0) var<uniform> cell_settings:CellSettings;
@group(0) @binding(1) var cell_visibility:texture_2d<u32>;
@group(0) @binding(2) var<storage,read_write> cell_workspace:SurfaceCellWorkspace;
var<workgroup> cell_facts:array<SurfaceCellLane,64>;
var<workgroup> cell_owner:array<u32,64>;
var<workgroup> cell_representatives:array<u32,64>;
var<workgroup> cell_plane_state:vec4u;
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
  ${specializedBounds ? surfaceCellGroupValidationWgsl(planeStart, planeCount) : ""}
@compute @workgroup_size(64) fn ${entryPoint}(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
 let tile=group.x;if tile>=cell_settings.tile_count{return;}
 let absolute=cell_settings.first_tile+tile;let origin=vec2u((absolute%cell_settings.tiles_x)*8u,(absolute/cell_settings.tiles_x)*8u);let pixel=origin+vec2u(lane%8u,lane/8u);
 var fact=SurfaceCellLane(vec4u(0u),0xffffffffu,0u,0u,0u);if pixel.x<cell_settings.width&&pixel.y<cell_settings.height{let winner=textureLoad(cell_visibility,vec2i(pixel),0).x;if winner!=0xffffffffu{fact=surface_cell_load(pixel,winner);}}
 cell_facts[lane]=fact;workgroupBarrier();
 for(var plane=${planeStart}u;plane<${planeStart + planeCount}u;plane++) {
   cell_owner[lane]=lane;
   if lane==0u {
     var coverage=vec2u(0u);
     var publication=true;
     for(var member=0u;member<64u;member++) {
       if (cell_facts[member].enabled&(1u<<plane))!=0u {
         coverage|=cell_bit(member);
         publication=publication && (cell_facts[member].publication&(1u<<plane))!=0u;
       }
     }
     var irregular=false;
     let root=cell_first(coverage);
     if root!=0xffffffffu && !publication {
       for(var member=root+1u;member<64u;member++) {
         if cell_member(coverage,member) && !surface_cell_compatible(plane,cell_facts[root],cell_facts[member]) {
           irregular=true;
           break;
         }
       }
     }
     cell_plane_state=vec4u(coverage,countOneBits(coverage.x)+countOneBits(coverage.y),select(0u,1u,publication)|select(0u,2u,irregular));
   }
   workgroupBarrier();
   let coverage=cell_plane_state.xy;
   let valid=cell_plane_state.z;
   let irregular=(cell_plane_state.w&2u)!=0u;
   var mode=4u;
   var rate=0u;
   var slots=valid;
   if valid==0u { mode=0u; slots=0u; }
   else if (cell_plane_state.w&1u)!=0u { mode=1u; slots=0u; }
   // Sixteen independent quads, then four parents, then one diffuse parent.
   // Invocations own disjoint regions; only the level boundary synchronizes.
   for(var exponent=1u;exponent<=3u;exponent++) {
     let width=1u<<exponent;
     let columns=8u>>exponent;
     let supported=exponent<3u || plane==15u || plane==16u;
     if mode==4u && supported && lane<columns*columns {
       let first=(lane/columns)*width*8u+(lane%columns)*width;
       var remaining=cell_region(first,width,width)&coverage;
       loop {
         let representative=cell_first(remaining);
         if representative==0xffffffffu { break; }
         var region=cell_bit(representative);
         for(var candidate=representative+1u;candidate<64u;candidate++) {
           if cell_member(remaining,candidate) &&
             (!irregular || surface_cell_compatible(plane,cell_facts[candidate],cell_facts[representative])) {
             region|=cell_bit(candidate);
           }
         }
         remaining&=~region;
         if countOneBits(region.x)+countOneBits(region.y)<=1u { continue; }
         var children_valid=true;
         if exponent>1u {
           for(var member=0u;member<64u;member++) {
             if !cell_member(region,member) { continue; }
             let child=cell_region(member,width>>1u,width>>1u)&region;
             if cell_owner[member]!=cell_first(child) { children_valid=false; break; }
           }
         }
         if children_valid && ${groupPredicate} {
           for(var member=0u;member<64u;member++) {
             if cell_member(region,member) { cell_owner[member]=representative; }
           }
         }
       }
     }
     workgroupBarrier();
   }
   if lane==0u {
    if mode==4u {
     slots = 0u;
     for (var member = 0u; member < 64u; member++) {
       if cell_member(coverage,member) && cell_owner[member] == member {
         cell_representatives[slots] = member;
         slots++;
       }
     }
     for (var member = 0u; member < 64u; member++) {
       if !cell_member(coverage,member) { continue; }
       let representative = cell_owner[member];
       for (var index = 0u; index < slots; index++) {
         if cell_representatives[index] == representative { cell_owner[member] = index; break; }
       }
     }
     // A genuinely all-fine tile uses implicit lane addressing, not a map.
     if slots == valid { mode = 2u; slots = 64u; }
     else if !irregular {
       // Recover implicit grids from the accepted groups, never infer sharing
       // from identity alone. Failed coarse cells retain their local fine groups.
       var exponent = select(2u,3u,plane==15u || plane==16u);
       loop {
         let width = 1u << exponent;
         var grid = true;
         for (var member = 0u; member < 64u; member++) {
           if !cell_member(coverage,member) { continue; }
           let region = cell_region(member,width,width) & coverage;
           let first = cell_first(region);
           if cell_representatives[cell_owner[member]] != first { grid=false; break; }
         }
         if grid {
           mode = 3u;
           rate = exponent | (exponent << 2u);
           slots = (8u >> exponent) * (8u >> exponent);
           break;
         }
         if exponent == 1u { break; }
         exponent--;
       }
     }
   }
   if lane==0u {
   let at=cell_plan_at(tile,plane);cell_workspace.plans[at]=mode|(rate<<8u);
   cell_workspace.plans[at+2u]=cell_map_at(tile,plane);
   cell_workspace.plans[at+3u]=slots;cell_workspace.plans[at+4u]=coverage.x;cell_workspace.plans[at+5u]=coverage.y;
   if plane==0u{let header=tile*${SURFACE_CELL_TILE_PLAN_BYTES/4}u;cell_workspace.plans[header]=origin.x;cell_workspace.plans[header+1u]=origin.y;cell_workspace.plans[header+2u]=coverage.x;cell_workspace.plans[header+3u]=coverage.y;}
   if mode == 4u {
     let map = cell_map_at(tile,plane);
     for (var word = 0u; word < 24u; word++) { cell_workspace.maps[map + word] = 0u; }
     for (var member = 0u; member < 64u; member++) {
       if cell_member(coverage, member) { cell_map_write(tile,plane,member,cell_owner[member]); }
     }
     for (var index = 0u; index < slots; index++) {
       cell_map_write_base(map + 12u,index,cell_representatives[index]);
     }
   }
   if irregular|| (mode==3u&&valid>slots){atomicAdd(&cell_workspace.counters[plane*4u+2u],1u);}
   atomicAdd(&cell_workspace.counters[plane*4u],slots);
   }
  }
   workgroupBarrier();
 }
 ${factLibrary.includes("var<private> cell_texture_nodes") ? "if cell_settings.reserved!=0u && cell_texture_nodes!=0u { atomicAdd(&cell_workspace.counters[106u],cell_texture_nodes); }" : ""}
}
`;
}

/** Synthetic GPU fixtures use the same bounded hierarchy and coverage ABI. */
export function surfaceCellClassifyWgsl(factLibrary: string, tileCapacity = 4096): string {
  return surfaceCellClassifyStageWgsl(factLibrary, tileCapacity, 0, 0, SURFACE_CELL_PLANE_COUNT, "classify_cells");
}
