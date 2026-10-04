import { SURFACE_CELL_TILE_PLAN_BYTES } from "../gpu/GpuSurfaceCellPlanAbi.js";
import { SURFACE_CELL_ADDRESS_WORDS } from "../gpu/GpuSurfaceReferenceAbi.js";
import { SURFACE_EXECUTION_WORDS } from "../gpu/GpuSurfaceExecutionProfileAbi.js";

/** Geometry owner address stage. It uses the admitted primitive setup and the
 * same winner interpolation as the sole GeometryRecord producer. Only the
 * publication's input closure is materialized; no graph, texture or PBR work. */
export const SURFACE_CELL_ADDRESSES_WGSL = /* wgsl */ `
fn cell_address_write4(at:u32,value:vec4f) {
  let words=bitcast<vec4u>(value);
  for(var channel=0u;channel<4u;channel++) { cell_workspace.addresses[at+channel]=words[channel]; }
}
fn cell_address_attribute(setup:CellGeometrySetup,attribute_index:u32,weights:vec3f)->vec4f {
  return setup.corners[attribute_index]*weights.x+setup.corners[attribute_index+6u]*weights.y+setup.corners[attribute_index+12u]*weights.z;
}
fn cell_address_scalar(setup:CellGeometrySetup,attribute_index:u32,channel:u32,rect:vec4f)->CellScalarFootprint {
  let corners=vec3f(setup.corners[attribute_index][channel],setup.corners[attribute_index+6u][channel],setup.corners[attribute_index+12u][channel]);
  return cell_scalar_footprint(setup.coefficients,corners,rect.xy,rect.zw,vec2f(f32(cell_settings.width),f32(cell_settings.height)));
}
@compute @workgroup_size(64)
fn publish_cell_addresses(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
  if group.x>=cell_settings.tile_count { return; }
  let tile=group.x;cell_local_tile=tile;
  let leaf=tile*64u+lane;
  let published=cell_workspace.facts[leaf];
  if published.x==0xffffffffu || published.z>=settings.appearance1.z { return; }
  if published.y>=settings.geometry.y { return; }
  let setup:CellGeometrySetup=geometry_arena.setups[published.y];
  let absolute=cell_workspace.plans[tile*${SURFACE_CELL_TILE_PLAN_BYTES/4}u+4u];
  let origin=vec2u((absolute%cell_settings.tiles_x)*8u,(absolute/cell_settings.tiles_x)*8u);
  let pixel=origin+vec2u(lane%8u,lane/8u);
  let interpolation=winner_interpolate(setup.coefficients,vec2f(pixel)+vec2f(0.5),vec2f(f32(cell_settings.width),f32(cell_settings.height)));
  let at=leaf*${SURFACE_CELL_ADDRESS_WORDS}u;
  cell_workspace.addresses[at]=setup.identity.x;
  cell_workspace.addresses[at+1u]=setup.identity.y;
  cell_workspace.addresses[at+2u]=setup.identity.z;
  cell_workspace.addresses[at+3u]=setup.source.z;
  cell_workspace.addresses[at+4u]=setup.source.y;
  cell_workspace.addresses[at+5u]=setup.source_address.z;
  cell_workspace.addresses[at+6u]=setup.source_address.y;
  cell_workspace.addresses[at+7u]=setup.continuity[0u].x;
  cell_workspace.addresses[at+8u]=setup.identity.w;
  cell_workspace.addresses[at+9u]=setup.continuity[0u].y;
  cell_workspace.addresses[at+10u]=setup.continuity[0u].z;
  // UV2 has no sheet lineage. Preserve the primitive namespace in the key.
  cell_workspace.addresses[at+11u]=setup.source_address.y;
  cell_workspace.addresses[at+12u]=setup.source.w;
  cell_workspace.addresses[at+13u]=pixel.y*cell_settings.width+pixel.x;
  cell_workspace.addresses[at+14u]=published.y;
  cell_workspace.addresses[at+93u]=interpolation.flags;
  cell_workspace.addresses[at+130u]=setup.source_address.w;
  cell_address_write4(at+132u,setup.world_plane);
  var flips=0u;
  if (setup.source_address.w&16u)!=0u {
    for(var point=0u;point<3u;point++) {
      var weights=interpolation.weights;
      if point==1u { weights+=interpolation.dx; }
      if point==2u { weights+=interpolation.dy; }
      let world=cell_address_attribute(setup,5u,weights).xyz;
      var normal=cell_address_attribute(setup,0u,weights).xyz;
      if dot(normal,normal)<=1e-20 { normal=setup.world_plane.xyz; }
      flips|=select(0u,1u<<point,dot(normal,cell_camera.transform[3u].xyz-world)<0.0);
    }
  }
  cell_workspace.addresses[at+131u]=flips;
  let input_mask=appearance_metadata[settings.appearance2.w+published.z*${SURFACE_EXECUTION_WORDS}u+2u];
  let rect=cell_rect_from_mask(cell_region(lane,2u,2u),origin);
  var valid_uv=0u;
  for(var uv=0u;uv<3u;uv++) {
    if (input_mask&(1u<<(uv+1u)))==0u { continue; }
    let attribute_index=select(2u,4u,uv==2u);
    let component=select(0u,2u,uv==1u);
    let center=cell_address_attribute(setup,attribute_index,interpolation.weights);
    let dx=cell_address_attribute(setup,attribute_index,interpolation.weights+interpolation.dx)-center;
    let dy=cell_address_attribute(setup,attribute_index,interpolation.weights+interpolation.dy)-center;
    var known=true;
    for(var channel=0u;channel<2u;channel++) {
      let c=component+channel;
      cell_workspace.addresses[at+16u+uv*6u+channel]=bitcast<u32>(center[c]);
      cell_workspace.addresses[at+18u+uv*6u+channel]=bitcast<u32>(dx[c]);
      cell_workspace.addresses[at+20u+uv*6u+channel]=bitcast<u32>(dy[c]);
      known=known && center[c]==center[c] && dx[c]==dx[c] && dy[c]==dy[c] &&
        max(abs(center[c]),max(abs(dx[c]),abs(dy[c])))<=3.402823466e38;
    }
    valid_uv|=select(0u,1u<<uv,known);
  }
  cell_workspace.addresses[at+15u]=valid_uv;
  if (input_mask&(1u<<4u))!=0u {
    let color=cell_address_attribute(setup,3u,interpolation.weights);
    cell_address_write4(at+34u,color);
    cell_address_write4(at+38u,cell_address_attribute(setup,3u,interpolation.weights+interpolation.dx)-color);
    cell_address_write4(at+42u,cell_address_attribute(setup,3u,interpolation.weights+interpolation.dy)-color);
  }
  // Exact raw inputs determine normalized/derived inputs in Appearance. View
  // dependent inputs additionally carry the authoritative camera revision.
  for(var attribute_index=0u;attribute_index<3u;attribute_index++) {
    var needed=(input_mask&((1u<<7u)|(1u<<8u)|(1u<<10u)|(1u<<13u)))!=0u;
    var source=5u;
    if attribute_index==1u { source=0u;needed=(input_mask&((1u<<5u)|(1u<<6u)|(1u<<11u)|(1u<<12u)|(1u<<14u)))!=0u; }
    if attribute_index==2u { source=1u;needed=(input_mask&((1u<<6u)|(1u<<12u)))!=0u; }
    if !needed { continue; }
    let base=at+94u+attribute_index*12u;
    cell_address_write4(base,cell_address_attribute(setup,source,interpolation.weights));
    cell_address_write4(base+4u,cell_address_attribute(setup,source,interpolation.weights+interpolation.dx));
    cell_address_write4(base+8u,cell_address_attribute(setup,source,interpolation.weights+interpolation.dy));
  }
}
`;
