/** Shared view ABI and complementary SSE decision for hierarchy and meshlet handoff. */
export const HIERARCHY_LOD_ANCHOR_BYTES = 32;
export const HIERARCHY_LOD_WGSL = /* wgsl */ `
struct OEngineHierarchyView {
  camera_position: vec4f,
  frustum_planes: array<vec4f, 6>,
  // threshold, viewport height, perspective projection scale Y, near plane
  sse: vec4f,
  // orthographic vertical world size; remaining lanes are reserved
  orthographic: vec4f,
  // instance begin, instance count, encoded hierarchy rounds, required instance flags
  scene: vec4u,
  // maxComputeWorkgroupsPerDimension; remaining lanes are reserved
  limits: vec4u,
  world_to_clip: mat4x4f,
  // previous HZB width, height, mip count, feature flags
  hzb: vec4u,
};
struct OEngineWorldSphere {
  center: vec3f,
  radius: f32,
};
struct OEngineLodAnchor {
  // xyz frozen camera position; w maximum allowed camera displacement.
  camera: vec4f,
  revision: vec4u,
};
fn hierarchy_conservative_scale(transform: mat4x4f) -> f32 {
  let x_axis = transform[0].xyz;
  let y_axis = transform[1].xyz;
  let z_axis = transform[2].xyz;
  let x_length = length(x_axis);
  let y_length = length(y_axis);
  let z_length = length(z_axis);
  let safe_x = max(x_length, 1e-20);
  let safe_y = max(y_length, 1e-20);
  let safe_z = max(z_length, 1e-20);
  let shear = max(
    abs(dot(x_axis, y_axis) / (safe_x * safe_y)),
    max(
      abs(dot(x_axis, z_axis) / (safe_x * safe_z)),
      abs(dot(y_axis, z_axis) / (safe_y * safe_z))
    )
  );
  if shear <= 1e-5 {
    return max(x_length, max(y_length, z_length));
  }
  // Frobenius norm conservatively bounds the largest singular value.
  return sqrt(
    dot(x_axis, x_axis) + dot(y_axis, y_axis) + dot(z_axis, z_axis)
  );
}

fn hierarchy_transform_sphere(
  local: vec4f,
  transform: mat4x4f
) -> OEngineWorldSphere {
  return OEngineWorldSphere(
    (transform * vec4f(local.xyz, 1.0)).xyz,
    local.w * hierarchy_conservative_scale(transform)
  );
}

fn hierarchy_sphere_in_frustum(
  sphere: OEngineWorldSphere,
  view: ptr<uniform, OEngineHierarchyView>
) -> bool {
  for (var plane_index = 0u; plane_index < 6u; plane_index++) {
    let plane = (*view).frustum_planes[plane_index];
    let normal_length = length(plane.xyz);
    // A zero-normal plane with non-negative W is an explicit disabled plane,
    // used by infinite-far Perspective views.
    if normal_length > 0.0 &&
      dot(sphere.center, plane.xyz) + plane.w < -sphere.radius * normal_length {
      return false;
    }
  }
  return true;
}

fn hierarchy_projected_error_pixels(
  object_error: f32,
  sphere: OEngineWorldSphere,
  conservative_scale: f32,
  view: ptr<uniform, OEngineHierarchyView>
) -> f32 {
  return hierarchy_projected_error_at_position(object_error, sphere, conservative_scale,
    (*view).camera_position.xyz, view);
}

fn hierarchy_projected_error_at_position(
  object_error: f32,
  sphere: OEngineWorldSphere,
  conservative_scale: f32,
  camera_position: vec3f,
  view: ptr<uniform, OEngineHierarchyView>
) -> f32 {
  let world_error = object_error * conservative_scale;
  if (*view).orthographic.y > 0.5 {
    return world_error / (*view).orthographic.x * (*view).sse.y;
  }
  let nearest_distance = max(
    distance(sphere.center, camera_position) - sphere.radius,
    (*view).sse.w
  );
  return world_error / nearest_distance * (*view).sse.z *
    0.5 * (*view).sse.y;
}

// Main perspective view only. The frozen denominator subtracts the entire
// allowed displacement, bounding SSE for every cluster, including loose spheres.
// Hierarchy traversal and coarse meshlet handoff MUST share this decision.
fn hierarchy_lod_stability_fraction(view: ptr<uniform, OEngineHierarchyView>) -> f32 {
  return select(0.0, 0.05, (*view).orthographic.y < 0.5 && (*view).scene.w == 0u);
}
fn hierarchy_projected_error_at_anchor(
  object_error: f32,
  sphere: OEngineWorldSphere,
  conservative_scale: f32,
  anchor: OEngineLodAnchor,
  view: ptr<uniform, OEngineHierarchyView>
) -> f32 {
  if ((*view).orthographic.y > 0.5) {
    return object_error * conservative_scale / (*view).orthographic.x * (*view).sse.y;
  }
  let nearest_distance = max(
    distance(sphere.center, anchor.camera.xyz) - sphere.radius - anchor.camera.w,
    (*view).sse.w
  );
  return object_error * conservative_scale / nearest_distance * (*view).sse.z * 0.5 * (*view).sse.y;
}

// One unique root invocation writes each current anchor before culling.
fn hierarchy_update_lod_anchor(
  previous: OEngineLodAnchor,
  instance: OEngineInstanceRecord,
  sphere: OEngineWorldSphere,
  view: ptr<uniform, OEngineHierarchyView>
) -> OEngineLodAnchor {
  var signature = 2166136261u;
  let sse_words = bitcast<vec4u>((*view).sse);
  for (var lane = 0u; lane < 4u; lane++) {
    signature = (signature ^ sse_words[lane]) * 16777619u;
  }
  signature = (signature ^ instance.instance_set_generation) * 16777619u;
  signature = (signature ^ oengine_instance_geometry_generation(instance)) * 16777619u;
  signature = (signature ^ instance.dynamic_revision) * 16777619u;
  signature = (signature ^ bitcast<u32>((*view).orthographic.x)) * 16777619u;
  signature = (signature ^ bitcast<u32>((*view).orthographic.y)) * 16777619u;
  signature = (signature ^ (*view).scene.w) * 16777619u;
  signature |= 1u;
  let fraction = hierarchy_lod_stability_fraction(view);
  if (fraction == 0.0 || previous.revision.x != signature ||
      distance(previous.camera.xyz, (*view).camera_position.xyz) > previous.camera.w) {
    let deadband = fraction * max(
      distance((*view).camera_position.xyz, sphere.center) - sphere.radius,
      (*view).sse.w
    );
    return OEngineLodAnchor(vec4f((*view).camera_position.xyz, deadband), vec4u(signature, 0u, 0u, 0u));
  }
  return previous;
}

`;
