import { APPEARANCE_FIELD_WIDTHS } from "../gpu/GpuAppearanceCacheAbi.js";
import { SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS, SURFACE_CELL_FIELD_CERTIFICATE_WORDS,
  SURFACE_CELL_GEOMETRY_CERTIFICATE_WORDS } from "../gpu/GpuSurfaceCellPlanAbi.js";

/** Local Continuity-Domain Signal Sampling certificate integration. Scratch is
 * one immutable leaf certificate per primitive/quad (<=64 per tile), shared by
 * all planes and hierarchy levels. No node x domain x plane certificate table.
 * A coarse anchor is an existing covered fine-sample location; material sampling
 * retains its original GeometryRecord gradients. The leaf interval includes the
 * complete analytic/filter support, not just the four sampled values. */
export const SURFACE_CELL_CERTIFICATE_WGSL = /* wgsl */ `
const CELL_CERTIFICATE_GEOMETRY_WORDS:u32=${SURFACE_CELL_GEOMETRY_CERTIFICATE_WORDS}u;
const CELL_CERTIFICATE_FIELD_WORDS:u32=${SURFACE_CELL_FIELD_CERTIFICATE_WORDS}u;
const CELL_CERTIFICATE_FIELD_OFFSET:array<u32,15>=array<u32,15>(${SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS.map(n=>`${n}u`).join(",")});
const CELL_CERTIFICATE_FIELD_WIDTH:array<u32,15>=array<u32,15>(${APPEARANCE_FIELD_WIDTHS.map(n=>`${n}u`).join(",")});

fn cell_leaf_certificate(tile:u32,lane:u32)->u32 {
  let primitive=cell_workspace.primitives[tile*64u+lane];
  let x=(lane%8u)&~1u;
  let y=(lane/8u)&~1u;
  for(var row=0u;row<2u;row++) {
    for(var column=0u;column<2u;column++) {
      let member=(y+row)*8u+x+column;
      if cell_workspace.primitives[tile*64u+member]==primitive { return member; }
    }
  }
  return lane;
}
fn cell_certificate_members(tile:u32,mask:vec2u)->vec2u {
  var result=vec2u(0u);
  var pending=mask;
  for(var count=0u;count<64u;count++) {
    let member=cell_first(pending);
    if member==0xffffffffu { break; }
    pending&=~cell_bit(member);
    result|=cell_bit(cell_leaf_certificate(tile,member));
  }
  return result;
}
fn cell_certificate_box(tile:u32,leaf:u32,component:u32)->AppearanceBound4 {
  let at=(tile*64u+leaf)*CELL_CERTIFICATE_GEOMETRY_WORDS;
  let base=at+component*6u;
  let low=bitcast<vec3f>(vec3u(cell_workspace.geometry_certificates[base],cell_workspace.geometry_certificates[base+1u],cell_workspace.geometry_certificates[base+2u]));
  let high=bitcast<vec3f>(vec3u(cell_workspace.geometry_certificates[base+3u],cell_workspace.geometry_certificates[base+4u],cell_workspace.geometry_certificates[base+5u]));
  let known=select(0u,1u,(cell_workspace.geometry_certificates[at+31u]&(1u<<component))!=0u);
  return AppearanceBound4(vec4f(low,0.0),vec4f(high,0.0),vec4u(known,known,known,1u));
}
fn cell_certificate_field(tile:u32,leaf:u32,field:u32)->AppearanceBound4 {
  let at=(tile*64u+leaf)*CELL_CERTIFICATE_FIELD_WORDS;
  let offset=CELL_CERTIFICATE_FIELD_OFFSET[field];
  let width=CELL_CERTIFICATE_FIELD_WIDTH[field];
  let known=cell_workspace.field_certificates[at+50u]>>(offset/2u);
  var value=AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(1u));
  for(var channel=0u;channel<width;channel++) {
    value.low[channel]=bitcast<f32>(cell_workspace.field_certificates[at+offset+channel]);
    value.high[channel]=bitcast<f32>(cell_workspace.field_certificates[at+offset+width+channel]);
    value.known[channel]=(known>>channel)&1u;
  }
  return value;
}
fn cell_candidate_field(tile:u32,leaves:vec2u,field:u32)->AppearanceBound4 {
  var value=AppearanceBound4(vec4f(1e30),vec4f(-1e30),vec4u(1u));
  var pending=leaves;
  for(var count=0u;count<64u;count++) {
    let leaf=cell_first(pending);
    if leaf==0xffffffffu { break; }
    pending&=~cell_bit(leaf);
    value=cell_merge_bound(value,cell_certificate_field(tile,leaf,field));
  }
  return value;
}
fn cell_write_certificate_box(at:u32,component:u32,value:AppearanceBound4)->u32 {
  let base=at+component*6u;
  for(var channel=0u;channel<3u;channel++) {
    cell_workspace.geometry_certificates[base+channel]=bitcast<u32>(value.low[channel]);
    cell_workspace.geometry_certificates[base+3u+channel]=bitcast<u32>(value.high[channel]);
  }
  return select(0u,1u<<component,all(value.known.xyz!=vec3u(0u)));
}
var<workgroup> cell_certificate_diagnostics:array<vec4u,64>;
var<workgroup> cell_texture_certificate_diagnostics:array<vec2u,64>;
fn cell_finish_certificate_diagnostics(lane:u32,geometry_count:u32,field_count:u32) {
  cell_certificate_diagnostics[lane]=vec4u(geometry_count,field_count,cell_texture_nodes,cell_context_count);
  cell_texture_certificate_diagnostics[lane]=vec2u(cell_texture_query_count,cell_texture_reuse_count);
  workgroupBarrier();
  if lane==0u && cell_settings.reserved!=0u {
    var sum=vec4u(0u);
    var texture_sum=vec2u(0u);
    for(var member=0u;member<64u;member++) { sum+=cell_certificate_diagnostics[member]; texture_sum+=cell_texture_certificate_diagnostics[member]; }
    atomicAdd(&cell_workspace.counters[108u],sum.x);
    atomicAdd(&cell_workspace.counters[109u],sum.y);
    atomicAdd(&cell_workspace.counters[106u],sum.z);
    atomicAdd(&cell_workspace.counters[110u],sum.w);
    atomicAdd(&cell_workspace.counters[111u],texture_sum.x);
    atomicAdd(&cell_workspace.counters[112u],texture_sum.y);
  }
}
@compute @workgroup_size(64)
fn publish_cell_geometry_certificates(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
  if group.x>=cell_settings.tile_count { return; }
  let tile=group.x;
  let absolute=cell_settings.first_tile+tile;
  let origin=vec2u((absolute%cell_settings.tiles_x)*8u,(absolute/cell_settings.tiles_x)*8u);
  let pixel=origin+vec2u(lane%8u,lane/8u);
  let published=cell_workspace.facts[tile*64u+lane];
  var count=0u;
  if published.x!=0xffffffffu && cell_leaf_certificate(tile,lane)==lane {
    let fact=surface_cell_load(pixel,published.x);
    let rect=cell_rect_from_mask(cell_region(lane,2u,2u),origin);
    let context=cell_bound_context(fact,rect);
    let at=(tile*64u+lane)*CELL_CERTIFICATE_GEOMETRY_WORDS;
    var known=cell_write_certificate_box(at,0u,cell_attribute_box(5u));
    known|=cell_write_certificate_box(at,1u,cell_world_normal_box());
    known|=cell_write_certificate_box(at,2u,cell_world_tangent_box());
    known|=cell_write_certificate_box(at,3u,cell_view_box());
    var dx2=0.0;
    var dy2=0.0;
    var valid=true;
    for(var channel=0u;channel<3u;channel++) {
      let position=cell_scalar_attribute(5u,channel);
      valid=valid && ab_valid(position.value) && ab_valid(position.dx) && ab_valid(position.dy);
      dx2+=cell_max_magnitude(position.dx)*cell_max_magnitude(position.dx);
      dy2+=cell_max_magnitude(position.dy)*cell_max_magnitude(position.dy);
    }
    let plane=cell_lane_geometry[fact.source].plane;
    let values=vec3f(dot(plane,cell_bound_setup.corners[5u]),dot(plane,cell_bound_setup.corners[11u]),dot(plane,cell_bound_setup.corners[17u]));
    let residual=cell_scalar_footprint(cell_bound_setup.coefficients,values,rect.xy,rect.zw,vec2f(f32(cell_settings.width),f32(cell_settings.height))).value;
    cell_workspace.geometry_certificates[at+24u]=bitcast<u32>(residual.low);
    cell_workspace.geometry_certificates[at+25u]=bitcast<u32>(residual.high);
    for(var channel=0u;channel<4u;channel++) { cell_workspace.geometry_certificates[at+26u+channel]=bitcast<u32>(plane[channel]); }
    cell_workspace.geometry_certificates[at+30u]=bitcast<u32>(max(sqrt(dx2),sqrt(dy2)));
    cell_workspace.geometry_certificates[at+31u]=known|select(0u,16u,valid && ab_valid(residual));
    count=1u;
  }
  cell_finish_certificate_diagnostics(lane,count,0u);
}
@compute @workgroup_size(64)
fn publish_cell_field_certificates(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
  if group.x>=cell_settings.tile_count { return; }
  let tile=group.x;
  let absolute=cell_settings.first_tile+tile;
  let origin=vec2u((absolute%cell_settings.tiles_x)*8u,(absolute/cell_settings.tiles_x)*8u);
  let pixel=origin+vec2u(lane%8u,lane/8u);
  let published=cell_workspace.facts[tile*64u+lane];
  var count=0u;
  if published.x!=0xffffffffu && cell_leaf_certificate(tile,lane)==lane {
    let fact=surface_cell_load(pixel,published.x);
    let context=cell_bound_context(fact,cell_rect_from_mask(cell_region(lane,2u,2u),origin));
    let at=(tile*64u+lane)*CELL_CERTIFICATE_FIELD_WORDS;
    var known=0u;
    // One live context and texture equivalence cache; no private fields[15].
    for(var field=0u;field<15u;field++) {
      var value=cell_evaluate_bound(field,context);
      let descriptor=cell_field_descriptor(context.y,field);
      if (cell_bound_setup.continuity[1u].w&descriptor.y)!=0u { value.known=vec4u(0u); }
      let offset=CELL_CERTIFICATE_FIELD_OFFSET[field];
      let width=CELL_CERTIFICATE_FIELD_WIDTH[field];
      for(var channel=0u;channel<width;channel++) {
        cell_workspace.field_certificates[at+offset+channel]=bitcast<u32>(value.low[channel]);
        cell_workspace.field_certificates[at+offset+width+channel]=bitcast<u32>(value.high[channel]);
        known|=(value.known[channel]&1u)<<(offset/2u+channel);
      }
    }
    cell_workspace.field_certificates[at+50u]=known;
    count=1u;
  }
  cell_finish_certificate_diagnostics(lane,0u,count);
}
`;

/** Independent numerical fixtures exercise the exact production reader and
 * parent merge without constructing a second geometry/material producer. */
export const SURFACE_CELL_CERTIFICATE_READ_WGSL = SURFACE_CELL_CERTIFICATE_WGSL.slice(0,
  SURFACE_CELL_CERTIFICATE_WGSL.indexOf("fn cell_write_certificate_box"));
