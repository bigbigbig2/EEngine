import { surfaceGeometryCompletionWgsl } from "./surface_geometry_completion.js";
import { PACKED_CAMERA_TYPE } from "./packed_camera.js";

/** Sole Geometry producer. Source/corner completion is invocation-private and
 * is immediately consumed by Appearance in this kernel. Lighting gets only
 * the 48-byte center product; no full-screen C/X/Y or source recovery exists. */
export function surfaceWorkGeometryWgsl(product: boolean, fixed = false): string {
  const productBindings = product
    ? /* wgsl */ `
@group(0) @binding(4) var<storage, read> product_heap: array<u32>;
@group(0) @binding(5) var<storage, read> product_bank_0: array<u32>;
@group(0) @binding(6) var<storage, read> product_bank_1: array<u32>;
@group(0) @binding(7) var<storage, read> product_bank_2: array<u32>;
@group(0) @binding(8) var<storage, read> product_bank_3: array<u32>;
`
    : "";
  const fixedInputs = fixed
    ? /* wgsl */ `
struct GeometryCoordinates {
  center: vec2f,
  x: vec2f,
  y: vec2f,
}
var<private> geometry_uv0: GeometryCoordinates;
var<private> geometry_uv1: GeometryCoordinates;
var<private> geometry_uv2: GeometryCoordinates;
var<private> geometry_color: vec4f;
fn geometry_input(kind: u32, point: u32) -> vec4f {
  if kind == 4u { return geometry_color; }
  var uv: GeometryCoordinates;
  switch kind {
    case 1u: { uv = geometry_uv0; }
    case 2u: { uv = geometry_uv1; }
    case 3u: { uv = geometry_uv2; }
    default: { return vec4f(0.0); }
  }
  var value = uv.center;
  if point == 1u { value = uv.x; }
  if point == 2u { value = uv.y; }
  return vec4f(value, 0.0, 0.0);
}
`
    : "";
  const fixedPreparation = fixed
    ? /* wgsl */ `
  if (center_needs & (1u << 1u)) != 0u {
    geometry_uv0.center = geometry_attribute(geometry_completion.uv, geometry_weights).xy;
    if (neighbor_needs & (1u << 1u)) != 0u {
      geometry_uv0.x = geometry_attribute(geometry_completion.uv, geometry_weights_x).xy;
      geometry_uv0.y = geometry_attribute(geometry_completion.uv, geometry_weights_y).xy;
    }
  }
  if (center_needs & (1u << 2u)) != 0u {
    geometry_uv1.center = geometry_attribute(geometry_completion.uv, geometry_weights).zw;
    if (neighbor_needs & (1u << 2u)) != 0u {
      geometry_uv1.x = geometry_attribute(geometry_completion.uv, geometry_weights_x).zw;
      geometry_uv1.y = geometry_attribute(geometry_completion.uv, geometry_weights_y).zw;
    }
  }
  if (center_needs & (1u << 3u)) != 0u {
    geometry_uv2.center = geometry_attribute(geometry_completion.uv2, geometry_weights).xy;
    if (neighbor_needs & (1u << 3u)) != 0u {
      geometry_uv2.x = geometry_attribute(geometry_completion.uv2, geometry_weights_x).xy;
      geometry_uv2.y = geometry_attribute(geometry_completion.uv2, geometry_weights_y).xy;
    }
  }
  if (center_needs & (1u << 4u)) != 0u {
    geometry_color = geometry_attribute(geometry_completion.color, geometry_weights);
  }
`
    : "";
  return /* wgsl */ `
${PACKED_CAMERA_TYPE.wgsl_declaration}
${surfaceGeometryCompletionWgsl(product, true)}
@group(0) @binding(0) var<storage, read> meshlet_work: OEngineMeshletWorkQueueRead;
@group(0) @binding(1) var<storage, read> source_heap: array<u32>;
@group(0) @binding(2) var<storage, read> vertex_payload: array<u32>;
@group(0) @binding(3) var<storage, read> frame_instances: array<OEngineFrameInstanceRecord>;
${productBindings}
@group(0) @binding(9) var<uniform> camera: CommandEncoder;
struct GeometryPoint {
  position: vec4f,
  normal: vec4f,
  tangent: vec4f,
  direction: vec4f,
}
var<private> geometry_completion: GeometryCompletion;
var<private> geometry_needs: u32;
var<private> geometry_weights: vec3f;
var<private> geometry_weights_x: vec3f;
var<private> geometry_weights_y: vec3f;
var<private> geometry_center: GeometryPoint;
${fixedInputs}
fn geometry_attribute(corners: GeometryCorners, weights: vec3f) -> vec4f {
  return corners.p0 * weights.x + corners.p1 * weights.y + corners.p2 * weights.z;
}
fn geometry_normal(value: vec3f, fallback: vec3f) -> vec3f {
  let length2 = dot(value, value);
  if length2 > 1e-20 && all(value == value) {
    return value * inverseSqrt(length2);
  }
  return fallback;
}
fn geometry_point(weights: vec3f, needs: u32) -> GeometryPoint {
  var result: GeometryPoint;
  let normal_needs = (1u << 5u) | (1u << 6u) | (1u << 8u) | (1u << 11u) | (1u << 12u) | (1u << 14u);
  let position_needs = (1u << 7u) | (1u << 8u) | (1u << 10u) | (1u << 13u);
  let sided = (geometry_completion.flags & 16u) != 0u;
  if (needs & position_needs) != 0u || (sided && (needs & normal_needs) != 0u) {
    result.position = geometry_attribute(geometry_completion.position, weights);
  }
  if (needs & normal_needs) != 0u {
    let geometric = geometry_normal(geometry_completion.world_plane.xyz, vec3f(0.0, 0.0, 1.0));
    let raw_normal = geometry_attribute(geometry_completion.normal, weights);
    var normal = geometry_normal(raw_normal.xyz, geometric);
    var facing = raw_normal.xyz;
    if dot(facing, facing) <= 1e-20 { facing = geometric; }
    let flip = sided && dot(facing, camera.transform[3u].xyz - result.position.xyz) < 0.0;
    if flip { normal = -normal; }
    result.normal = vec4f(normal, raw_normal.w);
    if (needs & ((1u << 6u) | (1u << 12u))) != 0u {
      let raw_tangent = geometry_attribute(geometry_completion.tangent, weights);
      // Orthogonalization precedes the original facing flip.
      let unflipped = select(normal, -normal, flip);
      var tangent = geometry_normal(raw_tangent.xyz - unflipped * dot(unflipped, raw_tangent.xyz),
        geometry_normal(cross(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), abs(unflipped.z) > 0.99), unflipped), vec3f(1.0, 0.0, 0.0)));
      if flip { tangent = -tangent; }
      result.tangent = vec4f(tangent, raw_tangent.w);
    }
    if (needs & (1u << 8u)) != 0u {
      result.direction = vec4f(geometry_normal(camera.transform[3u].xyz - result.position.xyz, normal), 0.0);
    }
  }
  return result;
}
${
  fixed
    ? ""
    : /* wgsl */ `
fn geometry_input(kind: u32, point: u32) -> vec4f {
  var weights = geometry_weights;
  if point == 1u { weights = geometry_weights_x; }
  if point == 2u { weights = geometry_weights_y; }
  switch kind {
    case 1u, 2u: {
      let value = geometry_attribute(geometry_completion.uv, weights);
      return vec4f(select(value.xy, value.zw, kind == 2u), 0.0, 0.0);
    }
    case 3u: { return geometry_attribute(geometry_completion.uv2, weights); }
    case 4u: { return geometry_attribute(geometry_completion.color, weights); }
    case 9u: { return vec4f(camera.transform[3u].xyz, 1.0); }
    default: {}
  }
  var record = geometry_center;
  if point != 0u { record = geometry_point(weights, 1u << kind); }
  switch kind {
    case 5u, 11u: { return record.normal; }
    case 6u, 12u: { return record.tangent; }
    case 7u, 10u: { return record.position; }
    case 8u: { return record.direction; }
    case 13u: { return camera.view_matrix * vec4f(record.position.xyz, 1.0); }
    case 14u: { return vec4f((camera.view_matrix * vec4f(record.normal.xyz, 0.0)).xyz, record.normal.w); }
    default: { return vec4f(0.0); }
  }
}
`
}
fn geometry_prepare_needs(needs: u32, lit: bool) {
  let center_needs = needs | select(0u, (1u << 5u) | (1u << 6u) | (1u << 7u), lit);
  geometry_needs = center_needs;
  if (center_needs & ((1u << 6u) | (1u << 8u) | (1u << 12u))) != 0u {
    geometry_needs |= 1u << 5u;
  }
}
fn geometry_complete(pixel: vec2u, neighbor_needs: u32, needs: u32, lit: bool) -> bool {
  let center_needs = needs | select(0u, (1u << 5u) | (1u << 6u) | (1u << 7u), lit);
  let interpolation = winner_interpolate(geometry_completion.coefficients,
    vec2f(pixel) + vec2f(0.5), vec2f(f32(settings.width), f32(settings.height)));
  if (interpolation.flags & WINNER_VALUE_VALID) == 0u { return false; }
  geometry_weights = interpolation.weights;
  geometry_weights_x = interpolation.weights + interpolation.dx;
  geometry_weights_y = interpolation.weights + interpolation.dy;
  geometry_center = geometry_point(geometry_weights, center_needs);
${fixedPreparation}
  if lit {
    if settings.diagnostics != 0u { atomicAdd(&work_control[243u], 1u); }
    surface_work_store4(dag_leaf, 0u, vec4f(geometry_center.position.xyz,
      -(camera.view_matrix * vec4f(geometry_center.position.xyz, 1.0)).z));
    surface_work_store4(dag_leaf, 4u, vec4f(geometry_center.normal.xyz, 0.0));
    let bits = bitcast<vec3u>(geometry_normal(geometry_completion.world_plane.xyz, vec3f(0.0, 0.0, 1.0)));
    work_heap[dag_leaf * settings.source_payload.y + 8u] = bits.x;
    work_heap[dag_leaf * settings.source_payload.y + 9u] = bits.y;
    work_heap[dag_leaf * settings.source_payload.y + 10u] = bits.z;
  }
  return true;
}
fn geometry_produce(key: u32, pixel: vec2u, neighbor_needs: u32, needs: u32, lit: bool) -> bool {
  geometry_prepare_needs(needs, lit);
  geometry_completion = geometry_build_completion(key);
  return geometry_complete(pixel, neighbor_needs, needs, lit);
}
`;
}
