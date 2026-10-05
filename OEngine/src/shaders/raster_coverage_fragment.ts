import type { AppearancePublishedCoverage } from "../gpu/GpuAppearancePublication.js";
import { GPU_FRAME_ATTRIBUTE_VECTORS } from "../gpu/GpuFrameGeometryAttributesAbi.js";

export const COVERAGE_VERTEX_VARYINGS = /* wgsl */ `
  @location(10) local_normal: vec4f,
  @location(11) local_tangent: vec4f,
  @location(12) vertex_color: vec4f,
  @location(13) local_position: vec3f,`;

export function coverageVertexAttributesWgsl(product: boolean): string {
  return /* wgsl */ `
@group(0) @binding(29) var<storage,read> raster_frame_attributes: array<vec4f>;
fn raster_shared_attribute(meshlet: vec4u, vertex: u32, field: u32) -> vec4f {
  return raster_frame_attributes[(meshlet.x+vertex)*${GPU_FRAME_ATTRIBUTE_VECTORS}u+field];
}
${
  product
    ? ""
    : `fn raster_resident_attribute(geometry: GpuGeometryRecord, vertex: u32, field: u32) -> vec4f {
  let at=geometry.resident_attribute_word_offset+(vertex*${GPU_FRAME_ATTRIBUTE_VECTORS}u+field)*4u;
  return bitcast<vec4f>(vec4u(meshlet_vertex_data[at],meshlet_vertex_data[at+1u],meshlet_vertex_data[at+2u],meshlet_vertex_data[at+3u]));
}`
}
`;
}
export function coverageVertexAssignment(product: boolean): string {
  const attributes = ["local_normal", "local_tangent", "vertex_color", "local_position"] as const;
  const fields = [0, 1, 3, 5];
  return attributes
    .map((attribute, index) => {
      const field = fields[index]!,
        suffix = attribute === "local_position" ? ".xyz" : "";
      return `  if valid {
    if cached_geometry { output.${attribute}=raster_shared_attribute(shared_meshlet,local_vertex,${field}u)${suffix}; }
    else { output.${attribute}=${product ? `product_raster_attribute(resident_address,local_vertex,${field}u)` : `raster_resident_attribute(geometry,source_vertex,${field}u)`}${suffix}; }
  }`;
    })
    .join("\n");
}

/** Alpha evaluation precedes discard: derivative production is uniform across
 * each raster quad, and all texture reads use explicit gradients afterwards. */
export function rasterCoverageFragmentWgsl(
  product: boolean,
  primitiveIndex: boolean,
  bins: boolean,
  coverage?: AppearancePublishedCoverage,
): string {
  const name = product ? "product" : "meshlet";
  return /* wgsl */ `
${coverage?.kernel.descriptor.source ?? ""}
struct RasterVisibilityOutput {
  @location(0) visibility_key: u32,
${bins ? "  @location(1) shading_bin_id: u32," : ""}
}
@fragment
fn write_visibility(
  ${primitiveIndex ? "@builtin(primitive_index)" : "@location(2) @interpolate(flat)"} triangle: u32,
  @location(8) @interpolate(flat) work_slot: u32${
    coverage
      ? `,
  @location(0) @interpolate(flat) instance_slot: u32,
  @location(7) @interpolate(flat) material_slot: u32,
  @location(3) uv0: vec2f, @location(4) uv1: vec2f, @location(5) uv2: vec2f,
  @location(10) normal: vec4f, @location(11) tangent: vec4f,
  @location(12) color: vec4f, @location(13) position: vec3f`
      : ""
  }${bins ? ",\n  @location(9) @interpolate(flat) shading_bin_id: u32" : ""}
) -> RasterVisibilityOutput {
${
  coverage
    ? `  let alpha=appearance_fragment_alpha(material_slot,${name}_instances[instance_slot],${name}_camera,uv0,uv1,uv2,color,normal,tangent,position);
  if alpha<appearance_fragment_cutoff() { discard; }`
    : ""
}
  let key=oengine_visibility_key_try_encode(work_slot,triangle).key;
  return RasterVisibilityOutput(key${bins ? ",shading_bin_id" : ""});
}
`;
}
