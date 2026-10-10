import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { WINNER_INTERPOLATION_WGSL } from "./winner_interpolation.js";
import { SURFACE_FRAME_GEOMETRY_WGSL } from "./surface_frame_geometry.js";
import { surfaceGeometryDecodeWgsl } from "./surface_geometry_reader.js";

/** Geometry owns reconstruction. The frame cache contains clips and triangle
 * addressing only; shading attributes come from immutable resident geometry,
 * after a winner has been resolved. Named corners avoid private dynamic arrays.
 * geometry_needs is a compile-time consumer dependency mask. */
export function surfaceGeometryCompletionWgsl(
  product: boolean,
  rasterCache = false,
  diagnostics = true,
): string {
  const corners = [0, 1, 2]
    .map(
      (corner) => /* wgsl */ `
  var vertex_${corner}: u32;
  ${rasterCache ? `if cached.valid { vertex_${corner} = surface_frame_corner(cached, decoded.local_primitive, ${corner}u); } else {` : ""}
    vertex_${corner} = surface_source_triangle_corner(decoded.local_primitive, ${corner}u);
  ${rasterCache ? "}" : ""}
  if vertex_${corner} >= count.x { return result; }
  var position_${corner}: vec3f;
  if world_needed ${rasterCache ? "|| !cached.valid" : "|| true"} {
    position_${corner} = surface_source_vertex_position(vertex_${corner});
  }
  if world_needed { result.position.p${corner} = transform * vec4f(position_${corner}, 1.0); }
  var clip_${corner}: vec4f;
  ${rasterCache ? `if cached.valid { clip_${corner} = surface_frame_clip(cached, vertex_${corner}); } else {` : ""}
    clip_${corner} = instance.object_to_clip * vec4f(position_${corner}, 1.0);
  ${rasterCache ? "}" : ""}
  {
    if (geometry_needs & ((1u << 5u) | (1u << 11u) | (1u << 14u))) != 0u {
      let normal = surface_source_vertex_normal(vertex_${corner});
      result.normal.p${corner} = vec4f(normals * normal.xyz, normal.w);
    }
    if (geometry_needs & ((1u << 6u) | (1u << 12u))) != 0u {
      let tangent = surface_source_vertex_tangent(vertex_${corner});
      result.tangent.p${corner} = vec4f((transform * vec4f(tangent.xyz, 0.0)).xyz,
        tangent.w * sign(instance.normal_x.w));
    }
    var uv0 = vec2f(0.0);
    var uv1 = vec2f(0.0);
    if (geometry_needs & (1u << 1u)) != 0u { uv0 = surface_source_vertex_uv(vertex_${corner}, 0u); }
    if (geometry_needs & (1u << 2u)) != 0u { uv1 = surface_source_vertex_uv(vertex_${corner}, 1u); }
    result.uv.p${corner} = vec4f(uv0, uv1);
    if (geometry_needs & (1u << 3u)) != 0u {
      result.uv2.p${corner} = vec4f(surface_source_vertex_uv(vertex_${corner}, 2u), 0.0, 0.0);
    }
    if (geometry_needs & (1u << 4u)) != 0u { result.color.p${corner} = surface_source_vertex_color(vertex_${corner}); }
  }
`,
    )
    .join("\n");
  return /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${WINNER_INTERPOLATION_WGSL}
${surfaceGeometryDecodeWgsl(product, "source_heap")}
${rasterCache ? SURFACE_FRAME_GEOMETRY_WGSL : ""}
struct GeometryCorners { p0: vec4f, p1: vec4f, p2: vec4f, }
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
  return geometry_complete_resolved(decoded, work, instance);
}
fn geometry_complete_resolved(decoded: OEngineVisibilityKeyResolveResult,
  work: OEngineMeshletRasterWork, instance: OEngineFrameInstanceRecord) -> GeometryCompletion {
  var result: GeometryCompletion;
  ${rasterCache ? "let cached = surface_frame_geometry(decoded.meshlet_work_slot, decoded.local_primitive);" : ""}
  var count: vec2u;
  ${
    rasterCache
      ? `if cached.valid {
    surface_source_product = oengine_instance_virtual_geometry(instance.source);
    ${
      product
        ? `if surface_source_product {
      product_source_resident_address = cached.resident_address;
    } else {`
        : ""
    }
      source_geometry.resident_attribute_word_offset = cached.resident_address - settings.source_payload.x;
      source_meshlet.vertex_offset = cached.vertex_indices - settings.source.z;
    ${product ? "}" : ""}
    count = vec2u(cached.vertex_count, cached.triangle_count);
  } else {`
      : ""
  }
    count = surface_source_load(work);
  ${rasterCache ? "}" : ""}
  if decoded.local_primitive >= count.y { return result; }
  result.flags = instance.source.flags;
  let transform = oengine_instance_current_object_to_world(instance.source);
  let normals = mat3x3f(instance.normal_x.xyz, instance.normal_y, instance.normal_z.xyz) * sign(instance.normal_x.w);
  let world_needed = (geometry_needs & ((1u << 5u) | (1u << 6u) | (1u << 7u) | (1u << 8u) |
    (1u << 10u) | (1u << 11u) | (1u << 12u) | (1u << 13u) | (1u << 14u))) != 0u;
  ${corners}
  result.coefficients = winner_build_coefficients(clip_0, clip_1, clip_2);
  if world_needed {
    let raw = cross(result.position.p1.xyz - result.position.p0.xyz, result.position.p2.xyz - result.position.p0.xyz);
    let length2 = dot(raw, raw);
    var normal = vec3f(0.0, 0.0, 1.0);
    if length2 > 1e-20 { normal = raw * inverseSqrt(length2); }
    result.world_plane = vec4f(normal, -dot(normal, result.position.p0.xyz));
  }
  return result;
}
`;
}
