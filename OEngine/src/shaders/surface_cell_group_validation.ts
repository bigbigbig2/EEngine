/** Classification consumes immutable Geometry/Field/Texture certificates. The
 * two bounded families share every leaf proof; no generated graph is evaluated
 * by a field, signal or parent candidate. */
export const SURFACE_CELL_CLASSIFY_STAGES = Object.freeze([
  { first: 0, count: 15 },
  { first: 15, count: 6 }
] as const);
/** Finite compile families. Shared texture closures (in particular ORM) stay in
 * one family; fields are evaluated once and all hierarchy planes consume the
 * same published leaf products. This is not a per-field dispatch scheme. */
export const SURFACE_CELL_CERTIFICATE_FAMILIES = Object.freeze([
  Object.freeze([0, 1, 5]),
  Object.freeze([2, 3, 4, 7, 8, 9]),
  Object.freeze([6, 10, 11, 12, 13, 14])
]);

export function surfaceCellGroupValidationWgsl(planeStart: number, planeCount: number): string {
  const signals=planeStart+planeCount>15;
  return /* wgsl */ `
fn surface_cell_group_valid_stage(plane:u32,mask:vec2u,lanes:ptr<workgroup,array<SurfaceCellLane,64>>,origin:vec2u)->bool {
  let first=cell_first(mask);
  if first==0xffffffffu { return false; }
  let tile=cell_local_tile;
  let leaves=cell_certificate_members(tile,mask);
  let root=(*lanes)[first];
  let root_plane=cell_lane_geometry[root.source].plane;
  let entry=cell_material_entry(cell_lane_geometry[root.source].source.y);
  let empty=AppearanceBound4(vec4f(1e30),vec4f(-1e30),vec4u(1u));
  var world=empty;
  ${signals ? "var normal=empty;\n  var tangent=empty;\n  var view=empty;" : ""}
  var scale=1e30;
  var pending=leaves;
  for(var count=0u;count<64u;count++) {
    let leaf=cell_first(pending);
    if leaf==0xffffffffu { break; }
    pending&=~cell_bit(leaf);
    let at=(tile*64u+leaf)*CELL_CERTIFICATE_GEOMETRY_WORDS;
    if (cell_workspace.geometry_certificates[at+31u]&17u)!=17u { return false; }
    let position=cell_certificate_box(tile,leaf,0u);
    world=cell_merge_bound(world,position);
    let pixel_scale=bitcast<f32>(cell_workspace.geometry_certificates[at+30u]);
    scale=min(scale,pixel_scale);
    let child_plane=bitcast<vec4f>(vec4u(cell_workspace.geometry_certificates[at+26u],cell_workspace.geometry_certificates[at+27u],
      cell_workspace.geometry_certificates[at+28u],cell_workspace.geometry_certificates[at+29u]));
    // Convert the child-relative correlated residual to the parent plane.
    // Merely merging child residuals would lose the anchor/plane change.
    var distance=AppearanceBound(bitcast<f32>(cell_workspace.geometry_certificates[at+24u]),
      bitcast<f32>(cell_workspace.geometry_certificates[at+25u]),1u);
    let delta=root_plane-child_plane;
    distance=ab_add(distance,ab_exact(delta.w));
    for(var channel=0u;channel<3u;channel++) {
      distance=ab_add(distance,ab_multiply(ab_exact(delta[channel]),ab_channel(position,channel)));
    }
    if !ab_valid(distance) || max(abs(distance.low),abs(distance.high))>pixel_scale*0.5 { return false; }
    ${signals ? `normal=cell_merge_bound(normal,cell_certificate_box(tile,leaf,1u));
    tangent=cell_merge_bound(tangent,cell_certificate_box(tile,leaf,2u));
    view=cell_merge_bound(view,cell_certificate_box(tile,leaf,3u));` : ""}
  }
  if plane<15u { return cell_field_budget(plane,cell_candidate_field(tile,leaves,plane)); }
  ${signals ? `
  let dependencies=cell_material_signal_dependencies(plane,entry);
  for(var field=0u;field<15u;field++) {
    if (dependencies&(1u<<field))!=0u && !cell_field_budget(field,cell_candidate_field(tile,leaves,field)) { return false; }
  }
  if any(normal.known.xyz==vec3u(0u)) { return false; }
  let normal_cone=cell_normal_box_cone(normal.low.xyz,normal.high.xyz);
  if normal_cone.w<0.0 { return false; }
  let mapped_field=select(6u,12u,plane>=19u);
  let mapped=cell_candidate_field(tile,leaves,mapped_field);
  if any(mapped.known.xyz==vec3u(0u)) { return false; }
  let mapped_cone=cell_normal_box_cone(mapped.low.xyz,mapped.high.xyz);
  var tangent_cone=vec4f(1.0,0.0,0.0,1.0);
  if any(mapped.low.xy!=vec2f(0.0)) || any(mapped.high.xy!=vec2f(0.0)) {
    if any(tangent.known.xyz==vec3u(0u)) { return false; }
    tangent_cone=cell_normal_box_cone(tangent.low.xyz,tangent.high.xyz);
  }
  if min(mapped_cone.w,tangent_cone.w)<0.0 { return false; }
  if acos(clamp(normal_cone.w,-1.0,1.0))+acos(clamp(mapped_cone.w,-1.0,1.0))+acos(clamp(tangent_cone.w,-1.0,1.0))>0.05235987756 { return false; }
  if plane==19u {
    let base_normal=cell_candidate_field(tile,leaves,6u);
    if any(base_normal.known.xyz==vec3u(0u)) || cell_normal_box_cone(base_normal.low.xyz,base_normal.high.xyz).w<0.9986295348 { return false; }
    let base_roughness=cell_candidate_field(tile,leaves,3u);
    if base_roughness.known.x==0u || base_roughness.low.x<0.35 { return false; }
  }
  if plane>=17u {
    let roughness=cell_candidate_field(tile,leaves,select(3u,11u,plane>=19u));
    if roughness.known.x==0u || roughness.low.x<0.35 { return false; }
    if any(view.known.xyz==vec3u(0u)) || cell_normal_box_cone(view.low.xyz,view.high.xyz).w<0.9986295348 { return false; }
  }
  if plane==15u {
    let coat=cell_candidate_field(tile,leaves,10u);
    if coat.known.x==0u { return false; }
    if coat.high.x>0.0 && (any(view.known.xyz==vec3u(0u)) || cell_normal_box_cone(view.low.xyz,view.high.xyz).w<0.9986295348) { return false; }
  }
  if plane==17u {
    let coat=cell_candidate_field(tile,leaves,10u);
    if coat.known.x==0u { return false; }
    if coat.high.x>0.0 {
      let coat_roughness=cell_candidate_field(tile,leaves,11u);
      if coat_roughness.known.x==0u || coat_roughness.low.x<0.35 { return false; }
    }
  }
  if plane==15u || plane==17u || plane==19u {
    return cell_direct_group_safe(mask,lanes,origin,cell_rect_from_mask(mask,origin),world.low.xyz,world.high.xyz,scale);
  }
  return true;` : "return false;"}
}
`;
}
