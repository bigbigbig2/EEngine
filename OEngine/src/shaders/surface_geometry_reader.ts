import {
  GPU_GEOMETRY_RECORD_SCHEMA,
  GPU_MESHLET_RECORD_SCHEMA,
  type GpuRecordSchema
} from "../gpu/GpuGeometryAbi.js";
import { frameGeometrySourceWgsl, FRAME_ATTRIBUTE_OCT_DECODE_WGSL } from "./geometry_source_decode.js";
import { GPU_FRAME_ATTRIBUTE_VECTORS } from "../gpu/GpuFrameGeometryAttributesAbi.js";

/** Shared final direct source decoder. The normal path reads the frame arena;
 * only a capacity miss uses source data. No old worker or setup is retained.
 * Metadata is the arena's immutable asset prefix; payload offsets are from the
 * actual GpuAssetStore publication, not inferred from frame work identities. */
export function surfaceGeometryDecodeWgsl(product: boolean, heap: string, perInvocation = true): string {
  let ordinary = frameGeometrySourceWgsl(false, true)
    .replace(/^@group\(0\) @binding\([3-7]\).*\n/gm, "")
    .replaceAll("vertex_payload[", "vertex_payload[settings.source_payload.x + ")
    .replaceAll(
      "meshlet_vertices[source_meshlet.vertex_offset + vertex]",
      "vertex_payload[settings.source.z + source_meshlet.vertex_offset + vertex]"
    )
    .replaceAll("meshlet_triangles[byte >> 2u]", "vertex_payload[settings.source.w + (byte >> 2u)]");
  ordinary = ordinary.replaceAll(
    "settings.source_payload.x + byte >> 2u",
    "settings.source_payload.x + (byte >> 2u)"
  );
  ordinary = replaceFunction(
    ordinary,
    "frame_vertex_load_source",
    /* wgsl */ `
fn frame_vertex_load_source(work: OEngineMeshletRasterWork) -> vec2u {
  source_geometry = surface_read_geometry(settings.source.x + work.geometry_slot * ${GPU_GEOMETRY_RECORD_SCHEMA.stride / 4}u);
  source_meshlet = surface_read_meshlet(settings.source.y + work.meshlet_slot * ${GPU_MESHLET_RECORD_SCHEMA.stride / 4}u);
  source_geometry.position_byte_offset += settings.source_payload.x * 4u;
  return vec2u(source_meshlet.vertex_count, source_meshlet.triangle_count);
}`
  );
  // Ordinary attributes were decoded by their actual residency producer. Both
  // the frame producer and direct miss consumer read this one immutable result.
  ordinary += /* wgsl */ `
fn frame_resident_attribute(vertex:u32,field:u32)->vec4f {
  let index=vertex_payload[settings.source.z+source_meshlet.vertex_offset+vertex];
  let at=settings.source_payload.x+source_geometry.resident_attribute_word_offset+(index*${GPU_FRAME_ATTRIBUTE_VECTORS}u+field)*4u;
  return bitcast<vec4f>(vec4u(vertex_payload[at],vertex_payload[at+1u],vertex_payload[at+2u],vertex_payload[at+3u]));
}`;
  for (const [name, type, expression] of [
    ["position", "vec3f", "frame_resident_attribute(vertex,5u).xyz"],
    ["normal", "vec4f", "frame_resident_attribute(vertex,0u)"],
    ["tangent", "vec4f", "frame_resident_attribute(vertex,1u)"],
    ["color", "vec4f", "frame_resident_attribute(vertex,3u)"]
  ])
    ordinary = replaceFunction(
      ordinary,
      `frame_vertex_${name}`,
      `fn frame_vertex_${name}(vertex:u32)->${type} { return ${expression}; }`
    );
  ordinary = replaceFunction(
    ordinary,
    "frame_vertex_uv",
    /* wgsl */ `
fn frame_vertex_uv(vertex:u32,uvSet:u32)->vec2f {
  if uvSet==2u { return frame_resident_attribute(vertex,4u).xy; }
  let uv=frame_resident_attribute(vertex,2u);
  return select(uv.xy,uv.zw,uvSet==1u);
}`
  );
  let productSource = product
    ? frameGeometrySourceWgsl(true, true)
        .replace(/^@group\(0\) @binding\((8|9|10|11|12)\).*\n/gm, "")
        .replaceAll("frame_vertex", "product_frame_vertex")
        .replaceAll("frame_source", "product_frame_source")
        .replaceAll("frame_attribute_byte", "product_frame_attribute_byte")
        .replaceAll("frame_triangle_corner", "product_frame_triangle_corner")
        .replace(/\bsource_/g, "product_source_")
    : "";
  // Include oct decode once even when both ordinary and Product are live.
  productSource = productSource.replaceAll("product_frame_oct_decode", "frame_oct_decode");
  const selectCall = (name: string, args: string, type: string): string => /* wgsl */ `
fn surface_source_${name}(${args}) -> ${type} {
  ${
    product
      ? `if surface_source_product { return product_frame_${name}(${args
          .split(",")
          .map((arg) => arg.split(":")[0]!.trim())
          .join(",")}); }`
      : ""
  }
  return frame_${name}(${args
    .split(",")
    .map((arg) => arg.split(":")[0]!.trim())
    .join(",")});
}`;
  const source = /* wgsl */ `
${FRAME_ATTRIBUTE_OCT_DECODE_WGSL}
${ordinary}
${productSource}
${readRecord("surface_read_geometry", GPU_GEOMETRY_RECORD_SCHEMA, heap)}
${readRecord("surface_read_meshlet", GPU_MESHLET_RECORD_SCHEMA, heap)}
var<private> surface_source_product: bool;
var<private> surface_direct_source: bool;
${selectCall("vertex_position", "vertex: u32", "vec3f")}
${selectCall("vertex_normal", "vertex: u32", "vec4f")}
${selectCall("vertex_tangent", "vertex: u32", "vec4f")}
${selectCall("vertex_uv", "vertex: u32, uvSet: u32", "vec2f")}
${selectCall("vertex_color", "vertex: u32", "vec4f")}
${selectCall("triangle_corner", "triangle: u32, corner: u32", "u32")}
fn surface_source_load(work: OEngineMeshletRasterWork) -> vec2u {
  surface_source_product=oengine_instance_virtual_geometry(frame_instances[work.instance_slot].source);
  ${product ? "if surface_source_product { return product_frame_vertex_load_source(work); }" : ""}
  return frame_vertex_load_source(work);
}
`;
  return perInvocation ? source : source.replaceAll("var<private>", "var<workgroup>");
}

export function surfaceGeometrySourceReaderWgsl(product: boolean, heap: string): string {
  return /* wgsl */ `
${surfaceGeometryDecodeWgsl(product, heap)}
var<private> surface_source_attributes: array<vec4f,${GPU_FRAME_ATTRIBUTE_VECTORS * 3}>;
fn surface_source_coefficients(work: OEngineMeshletRasterWork, primitive: u32) -> WinnerCoefficients {
  surface_direct_source = true;
  let count=surface_source_load(work);
  if primitive >= count.y { return winner_empty_coefficients(); }
  let transform=frame_instances[work.instance_slot].object_to_clip;
  var clips: array<vec4f,3>;
  for(var corner=0u;corner<3u;corner++) {
    let vertex=surface_source_triangle_corner(primitive,corner);
    let position=surface_source_vertex_position(vertex);
    clips[corner]=transform*vec4f(position,1.0);
    let base=corner*${GPU_FRAME_ATTRIBUTE_VECTORS}u;
    surface_source_attributes[base]=surface_source_vertex_normal(vertex);
    surface_source_attributes[base+1u]=surface_source_vertex_tangent(vertex);
    surface_source_attributes[base+2u]=vec4f(surface_source_vertex_uv(vertex,0u),surface_source_vertex_uv(vertex,1u));
    surface_source_attributes[base+3u]=surface_source_vertex_color(vertex);
    surface_source_attributes[base+4u]=vec4f(surface_source_vertex_uv(vertex,2u),0.0,0.0);
    surface_source_attributes[base+5u]=vec4f(position,1.0);
  }
  return winner_build_coefficients(clips[0],clips[1],clips[2]);
}
fn surface_source_attribute(ids: vec3u, weights: vec3f, layer: u32) -> vec4f {
  return surface_source_attributes[ids.x*${GPU_FRAME_ATTRIBUTE_VECTORS}u+layer]*weights.x+
    surface_source_attributes[ids.y*${GPU_FRAME_ATTRIBUTE_VECTORS}u+layer]*weights.y+surface_source_attributes[ids.z*${GPU_FRAME_ATTRIBUTE_VECTORS}u+layer]*weights.z;
}
`;
}

function readRecord(name: string, schema: GpuRecordSchema, heap: string): string {
  const values = schema.fields.map(({ name: field, kind, byteOffset }) => {
    const word = byteOffset / 4;
    if (!Number.isInteger(word)) throw new Error(`Geometry source record '${field}' has no ABI offset`);
    const value = `${heap}[at+${word}u]`;
    return kind === "u32"
      ? value
      : kind === "f32"
        ? `bitcast<f32>(${value})`
        : `bitcast<vec4f>(vec4u(${Array.from({ length: 4 }, (_, i) => `${heap}[at+${word + i}u]`).join(",")}))`;
  });
  return `fn ${name}(at:u32)->${schema.name} { return ${schema.name}(${values.join(",")}); }`;
}
function replaceFunction(source: string, name: string, replacement: string): string {
  const start = source.indexOf(`fn ${name}(`),
    open = source.indexOf("{", start);
  if (start < 0 || open < 0) throw new Error(`Shared geometry decoder '${name}' is missing`);
  let depth = 1,
    end = open + 1;
  for (; end < source.length && depth !== 0; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") depth--;
  }
  if (depth !== 0) throw new Error(`Shared geometry decoder '${name}' is incomplete`);
  return source.slice(0, start) + replacement + source.slice(end);
}
