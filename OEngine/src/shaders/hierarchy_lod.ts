/** Shared view ABI and complementary SSE decision for hierarchy and meshlet handoff. */
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
  let world_error = object_error * conservative_scale;
  if (*view).orthographic.y > 0.5 {
    return world_error / (*view).orthographic.x * (*view).sse.y;
  }
  let nearest_distance = max(
    distance(sphere.center, (*view).camera_position.xyz) - sphere.radius,
    (*view).sse.w
  );
  return world_error / nearest_distance * (*view).sse.z *
    0.5 * (*view).sse.y;
}

`;
