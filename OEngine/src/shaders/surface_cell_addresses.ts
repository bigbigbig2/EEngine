import { SURFACE_CELL_TILE_PLAN_BYTES } from "../gpu/GpuSurfaceCellPlanAbi.js";
import { SURFACE_CELL_ADDRESS_WORDS } from "../gpu/GpuSurfaceReferenceAbi.js";
import { SURFACE_EXECUTION_WORDS } from "../gpu/GpuSurfaceExecutionProfileAbi.js";
import { SURFACE_FIELD_IDENTITY_WORDS, SURFACE_FIELD_EXECUTION_PROFILE_WORD } from "../gpu/GpuSurfaceFieldIdentityAbi.js";

/** Geometry owner address stage. It uses the admitted primitive setup and the
 * same winner interpolation as the sole GeometryRecord producer. Only the
 * publication's input closure is materialized; no graph, texture or PBR work. */
export const SURFACE_CELL_ADDRESSES_WGSL = /* wgsl */ `
fn cell_address_write4(at:u32,value:vec4f) {
  let words=bitcast<vec4u>(value);
  for(var channel=0u;channel<4u;channel++) { cell_workspace.signal_witnesses[at+channel]=words[channel]; }
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
  cell_workspace.addresses[at+16u]=interpolation.flags;
  cell_workspace.addresses[at+17u]=setup.source_address.w;
  var input_mask=0u;
  let palette=cell_constant_palette(published.z);
  let constant_mask=appearance_metadata[palette];
  for(var field=0u;field<15u;field++) {
    if (constant_mask&(1u<<field))!=0u { continue; }
    let descriptor=settings.appearance2.z+(published.z*15u+field)*${SURFACE_FIELD_IDENTITY_WORDS}u;
    let profile=appearance_metadata[descriptor+${SURFACE_FIELD_EXECUTION_PROFILE_WORD}u];
    let uv_mask=appearance_metadata[descriptor+6u];
    let canonical=(appearance_metadata[descriptor+3u]&1u)!=0u && countOneBits(uv_mask)==1u;
    let proof_supported=(appearance_metadata[profile+15u]&4u)!=0u &&
      appearance_metadata[profile+8u]<=64u && appearance_metadata[profile+10u]<=4u;
    if appearance_metadata[profile+3u]==1u || (canonical && proof_supported) {
      input_mask|=appearance_metadata[descriptor+6u];
    }
  }
  var semantic=appearance_metadata[settings.appearance2.w + published.z * ${SURFACE_EXECUTION_WORDS}u + 5u];
  if semantic==3u {
    let color_guard=cell_address_attribute(setup,3u,interpolation.weights).xyz;
    let guard_safe=all(color_guard==color_guard) && all(abs(color_guard)<=vec3f(2.0));
    semantic=select(0u,3u,guard_safe);
  }
  cell_workspace.addresses[at+18u]=semantic;
  var valid_uv=0u;
  for(var uv=0u;uv<3u;uv++) {
    if (input_mask&(1u<<uv))==0u { continue; }
    let attribute_index=select(2u,4u,uv==2u);
    let component=select(0u,2u,uv==1u);
    let center=cell_address_attribute(setup,attribute_index,interpolation.weights);
    let dx=cell_address_attribute(setup,attribute_index,interpolation.weights+interpolation.dx)-center;
    let dy=cell_address_attribute(setup,attribute_index,interpolation.weights+interpolation.dy)-center;
    var known=true;
    for(var channel=0u;channel<2u;channel++) {
      let c=component+channel;
      cell_workspace.uv_witnesses[leaf*18u+uv*6u+channel]=bitcast<u32>(center[c]);
      cell_workspace.uv_witnesses[leaf*18u+2u+uv*6u+channel]=bitcast<u32>(dx[c]);
      cell_workspace.uv_witnesses[leaf*18u+4u+uv*6u+channel]=bitcast<u32>(dy[c]);
      known=known && center[c]==center[c] && dx[c]==dx[c] && dy[c]==dy[c] &&
        max(abs(center[c]),max(abs(dx[c]),abs(dy[c])))<=3.402823466e38;
    }
    valid_uv|=select(0u,1u<<uv,known);
  }
  cell_workspace.addresses[at+15u]=valid_uv;
  if cell_settings.reserved!=0u {
    atomicAdd(&cell_workspace.counters[84u],1u);
    atomicAdd(&cell_workspace.counters[85u],countOneBits(input_mask));
    atomicAdd(&cell_workspace.counters[86u],countOneBits(input_mask)*24u);
    atomicAdd(&cell_workspace.counters[94u],select(0u,1u,semantic==3u));
    atomicAdd(&cell_workspace.counters[95u],select(0u,1u,semantic!=3u));
  }
}
@compute @workgroup_size(64)
fn publish_cell_signal_witnesses(@builtin(global_invocation_id) id:vec3u) {
  let leaf=id.x;
  if leaf>=cell_settings.tile_count*64u { return; }
  cell_local_tile=leaf/64u;
  let published=cell_workspace.facts[leaf];
  if published.x==0xffffffffu || published.y>=settings.geometry.y || published.z>=settings.appearance1.z { return; }
  let at=leaf*${SURFACE_CELL_ADDRESS_WORDS}u;
  let fact=surface_cell_load(vec2u(cell_workspace.addresses[at+13u]%cell_settings.width,
    cell_workspace.addresses[at+13u]/cell_settings.width),published.x);
  var eligible=0u;
  for(var kind=0u;kind<6u;kind++) {
    if (fact.enabled&(1u<<(15u+kind)))==0u { continue; }
    let fields=cell_material_signal_dependencies(15u+kind,published.z,leaf);
    var cacheable=true;
    for(var field=0u;field<15u;field++) {
      if (fields&(1u<<field))==0u { continue; }
      let reference=reference_field(leaf,field);
      cacheable=cacheable && reference.kind!=SURFACE_REFERENCE_TRANSIENT && reference.kind!=SURFACE_REFERENCE_INVALID;
    }
    if cacheable { eligible|=1u<<kind; }
  }
  cell_workspace.addresses[at+19u]=eligible;
  if eligible==0u { return; }
  let setup=geometry_arena.setups[published.y];
  let pixel=cell_workspace.addresses[at+13u];
  let interpolation=winner_interpolate(setup.coefficients,
    vec2f(f32(pixel%cell_settings.width),f32(pixel/cell_settings.width))+vec2f(0.5),
    vec2f(f32(cell_settings.width),f32(cell_settings.height)));
  let position=cell_address_attribute(setup,5u,interpolation.weights);
  let normal=cell_address_attribute(setup,0u,interpolation.weights);
  let tangent=cell_address_attribute(setup,1u,interpolation.weights);
  cell_address_write4(leaf*12u,position);
  cell_address_write4(leaf*12u+4u,normal);
  cell_address_write4(leaf*12u+8u,tangent);
  var facing_normal=normal.xyz;
  if dot(facing_normal,facing_normal)<=1e-20 { facing_normal=setup.world_plane.xyz; }
  cell_workspace.addresses[at+20u]=select(0u,1u,(setup.source_address.w&16u)!=0u &&
    dot(facing_normal,cell_camera.transform[3u].xyz-position.xyz)<0.0);
  if cell_settings.reserved!=0u {
    atomicAdd(&cell_workspace.counters[87u],1u);
    atomicAdd(&cell_workspace.counters[88u],48u);
  }
}
`;
