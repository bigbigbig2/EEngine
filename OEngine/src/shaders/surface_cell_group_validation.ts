/** One certified geometry/material traversal per candidate cell. The caller
 * supplies a bounded field/signal range; no quality predicate is bypassed. */
export const SURFACE_CELL_CLASSIFY_STAGES = Object.freeze([
  { first: 0, count: 3, fields: [0, 1, 2] },
  { first: 3, count: 3, fields: [3, 4, 5] },
  { first: 6, count: 3, fields: [6, 7, 8] },
  { first: 9, count: 3, fields: [9, 10, 11] },
  { first: 12, count: 3, fields: [12, 13, 14] },
  { first: 15, count: 2, fields: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13] },
  { first: 17, count: 2, fields: [0, 2, 3, 6, 7, 8, 9, 10, 13] },
  { first: 19, count: 2, fields: [10, 11, 12, 14] }
] as const);

export function surfaceCellGroupValidationWgsl(planeStart: number, planeCount: number): string {
  const signals = planeStart + planeCount > 15;
  const prepare = signals ? `
  if plane >= 15u {
    dependencies = cell_material_signal_dependencies(plane,entry) | (1u << mapped_field);
    if plane >= 17u { dependencies |= 1u << roughness_field; }
  }` : "";
  const geometry = signals ? `
    normal=cell_merge_bound(normal,cell_world_normal_box());
    tangent=cell_merge_bound(tangent,cell_world_tangent_box());
    view=cell_merge_bound(view,cell_view_box());` : "";
  const signalChecks = signals ? `
  let mapped=cell_group_fields[mapped_field];
  if any(normal.known.xyz==vec3u(0u)) || any(mapped.known.xyz==vec3u(0u)) { return false; }
  let nc=cell_normal_box_cone(normal.low.xyz,normal.high.xyz);
  let mc=cell_normal_box_cone(mapped.low.xyz,mapped.high.xyz);
  var tc=vec4f(1.0,0.0,0.0,1.0);
  if any(mapped.low.xy!=vec2f(0.0)) || any(mapped.high.xy!=vec2f(0.0)) {
    if any(tangent.known.xyz==vec3u(0u)) { return false; }
    tc=cell_normal_box_cone(tangent.low.xyz,tangent.high.xyz);
  }
  if min(nc.w,min(tc.w,mc.w))<0.0 { return false; }
  if acos(clamp(nc.w,-1.0,1.0))+acos(clamp(tc.w,-1.0,1.0))+acos(clamp(mc.w,-1.0,1.0))>0.05235987756 { return false; }
  for (var field=0u; field<15u; field++) {
    if (dependencies & (1u << field))==0u || field==6u || field==12u { continue; }
    if !cell_field_budget(field,cell_group_fields[field]) { return false; }
  }
  if plane>=17u {
    let roughness=cell_group_fields[roughness_field];
    if roughness.known.x==0u || roughness.low.x<0.35 { return false; }
    if any(view.known.xyz==vec3u(0u)) || cell_normal_box_cone(view.low.xyz,view.high.xyz).w<0.9986295348 { return false; }
  }
  if plane==15u {
    let coat=cell_group_fields[10u];
    if coat.known.x==0u { return false; }
    if coat.high.x>0.0 && (any(view.known.xyz==vec3u(0u)) || cell_normal_box_cone(view.low.xyz,view.high.xyz).w<0.9986295348) { return false; }
  }
  if plane==15u || plane==17u || plane==19u {
    return cell_direct_group_safe(mask,lanes,origin,rect,world.low.xyz,world.high.xyz,scale);
  }
  return true;` : "return false;";
  return /* wgsl */ `
// Candidate-local bounds; disjoint quads evaluate concurrently.
var<private> cell_group_fields:array<AppearanceBound4,15>;
fn surface_cell_group_valid_stage(plane:u32,mask:vec2u,lanes:ptr<workgroup,array<SurfaceCellLane,64>>,origin:vec2u)->bool {
  let first = cell_first(mask);
  if first == 0xffffffffu { return false; }
  let rect = cell_rect_from_mask(mask,origin);
  let root = (*lanes)[first];
  let root_plane = cell_lane_geometry[root.source].plane;
  let entry = cell_material_entry(cell_lane_geometry[root.source].source.y);
  let mapped_field = select(6u,12u,plane >= 19u);
  let roughness_field = select(3u,11u,plane >= 19u);
  var dependencies = 1u << plane;
  ${prepare}
  let empty = AppearanceBound4(vec4f(1e30),vec4f(-1e30),vec4u(1u));
  for (var field=0u; field<15u; field++) { cell_group_fields[field]=empty; }
  var world=empty;
  var normal=empty;
  var tangent=empty;
  var view=empty;
  var scale=1e30;
  for (var member=0u; member<64u; member++) {
    if !cell_member(mask,member) { continue; }
    var seen=false;
    for (var previous=0u; previous<member; previous++) {
      if cell_member(mask,previous) && (*lanes)[previous].winner==(*lanes)[member].winner {
        seen=true;
        break;
      }
    }
    if seen { continue; }
    let context=cell_bound_context((*lanes)[member],rect);
    world=cell_merge_bound(world,cell_attribute_box(5u));
    var dx2=0.0;
    var dy2=0.0;
    for (var channel=0u; channel<3u; channel++) {
      let position=cell_scalar_attribute(5u,channel);
      if !ab_valid(position.value) || !ab_valid(position.dx) || !ab_valid(position.dy) { return false; }
      dx2+=cell_max_magnitude(position.dx)*cell_max_magnitude(position.dx);
      dy2+=cell_max_magnitude(position.dy)*cell_max_magnitude(position.dy);
    }
    let pixel_scale=max(sqrt(dx2),sqrt(dy2));
    scale=min(scale,pixel_scale);
    let plane_values=vec3f(
      dot(root_plane,cell_bound_setup.corners[5u]),
      dot(root_plane,cell_bound_setup.corners[11u]),
      dot(root_plane,cell_bound_setup.corners[17u]));
    let distance=cell_scalar_footprint(cell_bound_setup.coefficients,plane_values,rect.xy,rect.zw,vec2f(f32(cell_settings.width),f32(cell_settings.height))).value;
    if !ab_valid(distance) || max(abs(distance.low),abs(distance.high))>pixel_scale*0.5 { return false; }
    ${geometry}
    // Reject a glossy/unknown lobe before evaluating its other material
    // dependencies. The same roughness bound is retained for the final test.
    ${signals ? `if plane>=17u {
      let roughness=cell_evaluate_bound(roughness_field,context);
      cell_group_fields[roughness_field]=cell_merge_bound(cell_group_fields[roughness_field],roughness);
      if roughness.known.x==0u || roughness.low.x<0.35 || !cell_field_budget(roughness_field,cell_group_fields[roughness_field]) { return false; }
    }` : ""}
    for (var field=0u; field<15u; field++) {
      if (dependencies & (1u << field))==0u { continue; }
      ${signals ? "if plane>=17u && field==roughness_field { continue; }" : ""}
      let descriptor=cell_field_descriptor(context.y,field);
      if (cell_bound_setup.continuity[1u].w & descriptor.y)!=0u { return false; }
      cell_group_fields[field]=cell_merge_bound(cell_group_fields[field],cell_evaluate_bound(field,context));
      // Union bounds can only widen; a failed budget cannot recover when
      // another primitive is added. Stop this candidate immediately.
      if !cell_field_budget(field,cell_group_fields[field]) { return false; }
    }
  }
  if plane < 15u { return cell_field_budget(plane,cell_group_fields[plane]); }
  ${signalChecks}
}
`;
}
