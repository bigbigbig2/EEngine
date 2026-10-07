import { GPU_FRAME_VERTEX_WORLD_FIELDS as W } from "../gpu/GpuFrameGeometryAttributesAbi.js";
import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { WINNER_INTERPOLATION_WGSL } from "./winner_interpolation.js";
import { SURFACE_FRAME_GEOMETRY_WGSL } from "./surface_frame_geometry.js";
import { surfaceGeometryDecodeWgsl } from "./surface_geometry_reader.js";
/** Named corners avoid dynamically indexed invocation-private arrays. Only
 * requested attributes are loaded; setup and input math stay Geometry-owned.
 * Isolated math probes may omit diagnostics; production defaults are unchanged. */
export function surfaceGeometryCompletionWgsl(
  product: boolean,
  frameAttributes = false,
  diagnostics = true
): string {
  return /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${WINNER_INTERPOLATION_WGSL}
${surfaceGeometryDecodeWgsl(product, "source_heap")}
${frameAttributes ? SURFACE_FRAME_GEOMETRY_WGSL : ""}
struct GeometryCorners {
  p0: vec4f,
  p1: vec4f,
  p2: vec4f,
}
struct GeometryCompletion {
  flags: u32,
  coefficients: WinnerCoefficients,
  normal: GeometryCorners,
  tangent: GeometryCorners,
  uv: GeometryCorners,
  color: GeometryCorners,
  uv2: GeometryCorners,
  position: GeometryCorners,
  world_plane: vec4f,
}
fn geometry_build_completion(key: u32) -> GeometryCompletion {
  ${diagnostics ? "if settings.diagnostics != 0u { atomicAdd(&work_control[244u], 1u); }" : ""}
  var result: GeometryCompletion;
  let decoded = oengine_visibility_key_resolve(key, meshlet_work.header.generation, meshlet_work.header.written_count);
  if decoded.valid == 0u { return result; }
  let work = meshlet_work.elements[decoded.meshlet_work_slot];
  let instance = frame_instances[work.instance_slot];
  ${
    frameAttributes
      ? /* wgsl */ `
  let cached = surface_frame_geometry(decoded.meshlet_work_slot, decoded.local_primitive);
  if !cached.valid {
    let count = surface_source_load(work);
    if decoded.local_primitive >= count.y { return result; }
  }
  `
      : /* wgsl */ `
  let count = surface_source_load(work);
  if decoded.local_primitive >= count.y { return result; }
  `
  }
  result.flags = instance.source.flags;
  let transform = oengine_instance_current_object_to_world(instance.source);
  let normals = mat3x3f(instance.normal_x.xyz, instance.normal_y, instance.normal_z.xyz) * sign(instance.normal_x.w);
  var vertex_0: u32;
  var clip_0: vec4f;
  ${
    frameAttributes
      ? /* wgsl */ `
  if cached.valid {
    vertex_0 = surface_frame_corner(cached, decoded.local_primitive, 0u);
    clip_0 = surface_frame_clip(cached, vertex_0);
    result.position.p0 = surface_frame_attribute(cached, vertex_0, ${W.position}u);
  } else {`
      : ""
  }
    vertex_0 = surface_source_triangle_corner(decoded.local_primitive, 0u);
    let position_0 = surface_source_vertex_position(vertex_0);
    clip_0 = instance.object_to_clip * vec4f(position_0, 1.0);
    result.position.p0 = transform * vec4f(position_0, 1.0);
  ${frameAttributes ? "}" : ""}
  var vertex_1: u32;
  var clip_1: vec4f;
  ${
    frameAttributes
      ? /* wgsl */ `
  if cached.valid {
    vertex_1 = surface_frame_corner(cached, decoded.local_primitive, 1u);
    clip_1 = surface_frame_clip(cached, vertex_1);
    result.position.p1 = surface_frame_attribute(cached, vertex_1, ${W.position}u);
  } else {`
      : ""
  }
    vertex_1 = surface_source_triangle_corner(decoded.local_primitive, 1u);
    let position_1 = surface_source_vertex_position(vertex_1);
    clip_1 = instance.object_to_clip * vec4f(position_1, 1.0);
    result.position.p1 = transform * vec4f(position_1, 1.0);
  ${frameAttributes ? "}" : ""}
  var vertex_2: u32;
  var clip_2: vec4f;
  ${
    frameAttributes
      ? /* wgsl */ `
  if cached.valid {
    vertex_2 = surface_frame_corner(cached, decoded.local_primitive, 2u);
    clip_2 = surface_frame_clip(cached, vertex_2);
    result.position.p2 = surface_frame_attribute(cached, vertex_2, ${W.position}u);
  } else {`
      : ""
  }
    vertex_2 = surface_source_triangle_corner(decoded.local_primitive, 2u);
    let position_2 = surface_source_vertex_position(vertex_2);
    clip_2 = instance.object_to_clip * vec4f(position_2, 1.0);
    result.position.p2 = transform * vec4f(position_2, 1.0);
  ${frameAttributes ? "}" : ""}
  result.coefficients = winner_build_coefficients(clip_0, clip_1, clip_2);
  let raw = cross(result.position.p1.xyz - result.position.p0.xyz, result.position.p2.xyz - result.position.p0.xyz);
  let length2 = dot(raw, raw);
  var normal = vec3f(0.0, 0.0, 1.0);
  if length2 > 1e-20 { normal = raw * inverseSqrt(length2); }
  result.world_plane = vec4f(normal, -dot(normal, result.position.p0.xyz));
  {
  if (geometry_needs & ((1u << 5u) | (1u << 11u) | (1u << 14u))) != 0u {
    ${
      frameAttributes
        ? /* wgsl */ `
    if cached.valid { result.normal.p0 = surface_frame_attribute(cached, vertex_0, ${W.normal}u); }
    else {`
        : ""
    }
      let normal = surface_source_vertex_normal(vertex_0);
      result.normal.p0 = vec4f(normals * normal.xyz, normal.w);
    ${frameAttributes ? "}" : ""}
  }
  if (geometry_needs & ((1u << 6u) | (1u << 12u))) != 0u {
    ${
      frameAttributes
        ? /* wgsl */ `
    if cached.valid { result.tangent.p0 = surface_frame_attribute(cached, vertex_0, ${W.tangent}u); }
    else {`
        : ""
    }
      let tangent = surface_source_vertex_tangent(vertex_0);
      result.tangent.p0 = vec4f((transform * vec4f(tangent.xyz, 0.0)).xyz, tangent.w * sign(instance.normal_x.w));
    ${frameAttributes ? "}" : ""}
  }
  var uv0 = vec2f(0.0);
  var uv1 = vec2f(0.0);
  if (geometry_needs & (1u << 1u)) != 0u {
    ${frameAttributes ? `if cached.valid { uv0 = surface_frame_attribute(cached, vertex_0, 2u).xy; } else {` : ""}
      uv0 = surface_source_vertex_uv(vertex_0, 0u);
    ${frameAttributes ? "}" : ""}
  }
  if (geometry_needs & (1u << 2u)) != 0u {
    ${frameAttributes ? `if cached.valid { uv1 = surface_frame_attribute(cached, vertex_0, 2u).zw; } else {` : ""}
      uv1 = surface_source_vertex_uv(vertex_0, 1u);
    ${frameAttributes ? "}" : ""}
  }
  result.uv.p0 = vec4f(uv0, uv1);
  if (geometry_needs & (1u << 3u)) != 0u {
    ${frameAttributes ? `if cached.valid { result.uv2.p0 = surface_frame_attribute(cached, vertex_0, 4u); } else {` : ""}
      result.uv2.p0 = vec4f(surface_source_vertex_uv(vertex_0, 2u), 0.0, 0.0);
    ${frameAttributes ? "}" : ""}
  }
  if (geometry_needs & (1u << 4u)) != 0u {
    ${frameAttributes ? `if cached.valid { result.color.p0 = surface_frame_attribute(cached, vertex_0, 3u); } else {` : ""}
      result.color.p0 = surface_source_vertex_color(vertex_0);
    ${frameAttributes ? "}" : ""}
  }
  }
  {
  if (geometry_needs & ((1u << 5u) | (1u << 11u) | (1u << 14u))) != 0u {
    ${
      frameAttributes
        ? /* wgsl */ `
    if cached.valid { result.normal.p1 = surface_frame_attribute(cached, vertex_1, ${W.normal}u); }
    else {`
        : ""
    }
      let normal = surface_source_vertex_normal(vertex_1);
      result.normal.p1 = vec4f(normals * normal.xyz, normal.w);
    ${frameAttributes ? "}" : ""}
  }
  if (geometry_needs & ((1u << 6u) | (1u << 12u))) != 0u {
    ${
      frameAttributes
        ? /* wgsl */ `
    if cached.valid { result.tangent.p1 = surface_frame_attribute(cached, vertex_1, ${W.tangent}u); }
    else {`
        : ""
    }
      let tangent = surface_source_vertex_tangent(vertex_1);
      result.tangent.p1 = vec4f((transform * vec4f(tangent.xyz, 0.0)).xyz, tangent.w * sign(instance.normal_x.w));
    ${frameAttributes ? "}" : ""}
  }
  var uv0 = vec2f(0.0);
  var uv1 = vec2f(0.0);
  if (geometry_needs & (1u << 1u)) != 0u {
    ${frameAttributes ? `if cached.valid { uv0 = surface_frame_attribute(cached, vertex_1, 2u).xy; } else {` : ""}
      uv0 = surface_source_vertex_uv(vertex_1, 0u);
    ${frameAttributes ? "}" : ""}
  }
  if (geometry_needs & (1u << 2u)) != 0u {
    ${frameAttributes ? `if cached.valid { uv1 = surface_frame_attribute(cached, vertex_1, 2u).zw; } else {` : ""}
      uv1 = surface_source_vertex_uv(vertex_1, 1u);
    ${frameAttributes ? "}" : ""}
  }
  result.uv.p1 = vec4f(uv0, uv1);
  if (geometry_needs & (1u << 3u)) != 0u {
    ${frameAttributes ? `if cached.valid { result.uv2.p1 = surface_frame_attribute(cached, vertex_1, 4u); } else {` : ""}
      result.uv2.p1 = vec4f(surface_source_vertex_uv(vertex_1, 2u), 0.0, 0.0);
    ${frameAttributes ? "}" : ""}
  }
  if (geometry_needs & (1u << 4u)) != 0u {
    ${frameAttributes ? `if cached.valid { result.color.p1 = surface_frame_attribute(cached, vertex_1, 3u); } else {` : ""}
      result.color.p1 = surface_source_vertex_color(vertex_1);
    ${frameAttributes ? "}" : ""}
  }
  }
  {
  if (geometry_needs & ((1u << 5u) | (1u << 11u) | (1u << 14u))) != 0u {
    ${
      frameAttributes
        ? /* wgsl */ `
    if cached.valid { result.normal.p2 = surface_frame_attribute(cached, vertex_2, ${W.normal}u); }
    else {`
        : ""
    }
      let normal = surface_source_vertex_normal(vertex_2);
      result.normal.p2 = vec4f(normals * normal.xyz, normal.w);
    ${frameAttributes ? "}" : ""}
  }
  if (geometry_needs & ((1u << 6u) | (1u << 12u))) != 0u {
    ${
      frameAttributes
        ? /* wgsl */ `
    if cached.valid { result.tangent.p2 = surface_frame_attribute(cached, vertex_2, ${W.tangent}u); }
    else {`
        : ""
    }
      let tangent = surface_source_vertex_tangent(vertex_2);
      result.tangent.p2 = vec4f((transform * vec4f(tangent.xyz, 0.0)).xyz, tangent.w * sign(instance.normal_x.w));
    ${frameAttributes ? "}" : ""}
  }
  var uv0 = vec2f(0.0);
  var uv1 = vec2f(0.0);
  if (geometry_needs & (1u << 1u)) != 0u {
    ${frameAttributes ? `if cached.valid { uv0 = surface_frame_attribute(cached, vertex_2, 2u).xy; } else {` : ""}
      uv0 = surface_source_vertex_uv(vertex_2, 0u);
    ${frameAttributes ? "}" : ""}
  }
  if (geometry_needs & (1u << 2u)) != 0u {
    ${frameAttributes ? `if cached.valid { uv1 = surface_frame_attribute(cached, vertex_2, 2u).zw; } else {` : ""}
      uv1 = surface_source_vertex_uv(vertex_2, 1u);
    ${frameAttributes ? "}" : ""}
  }
  result.uv.p2 = vec4f(uv0, uv1);
  if (geometry_needs & (1u << 3u)) != 0u {
    ${frameAttributes ? `if cached.valid { result.uv2.p2 = surface_frame_attribute(cached, vertex_2, 4u); } else {` : ""}
      result.uv2.p2 = vec4f(surface_source_vertex_uv(vertex_2, 2u), 0.0, 0.0);
    ${frameAttributes ? "}" : ""}
  }
  if (geometry_needs & (1u << 4u)) != 0u {
    ${frameAttributes ? `if cached.valid { result.color.p2 = surface_frame_attribute(cached, vertex_2, 3u); } else {` : ""}
      result.color.p2 = surface_source_vertex_color(vertex_2);
    ${frameAttributes ? "}" : ""}
  }
  }
  return result;
}
`;
}
