/** One Geometry product: 128-byte hot headers plus an append-only cold pool.
 * Cold C/X/Y values stay f32 and use the exact semantic union. Physically equal
 * position/normal/tangent aliases share payload, while their semantic bits stay
 * independent in the header. Only the Geometry owner writes either segment. */
export const SURFACE_GEOMETRY_INPUT_COUNT = 14;
export const SURFACE_GEOMETRY_PHYSICAL_INPUTS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 6, 4, 5, 9, 10]);
export const SURFACE_GEOMETRY_RECORD_VECTORS = 8;
export const SURFACE_GEOMETRY_RECORD_HOT_BYTES = 128;
export const SURFACE_GEOMETRY_RECORD_COLD_MAX_BYTES = 11 * 3 * 16;
export const SURFACE_GEOMETRY_RECORD_BYTES =
  SURFACE_GEOMETRY_RECORD_HOT_BYTES + SURFACE_GEOMETRY_RECORD_COLD_MAX_BYTES;
/** Lighting consumes only the hot record. Cold bits 1..14 are exclusively the
 * actual missing Appearance closures, with no duplicated neighbor payload. */
export const SURFACE_GEOMETRY_HOT_DEMAND_BIT = 1 << 15;
export const SURFACE_GEOMETRY_RECORD_WGSL = /* wgsl */ `
struct SurfaceGeometryRecord {
  position: vec4f,
  normal: vec4f,
  tangent: vec4f,
  view: vec4f,
  geometric: vec4f,
  identity: vec4u,
  metrics: vec4f,
  cold: vec4u,
}
const SURFACE_GEOMETRY_PHYSICAL: array<u32,14> = array<u32,14>(${SURFACE_GEOMETRY_PHYSICAL_INPUTS.map((value) => `${value}u`).join(",")});
`;

export function surfaceGeometryReadWgsl(buffer: string): string {
  return /* wgsl */ `
fn geometry_product_vec4(at: u32) -> vec4f {
  return bitcast<vec4f>(vec4u(${buffer}[at],${buffer}[at+1u],${buffer}[at+2u],${buffer}[at+3u]));
}
fn geometry_product_hot(leaf: u32) -> SurfaceGeometryRecord {
  let at = leaf * 32u;
  return SurfaceGeometryRecord(geometry_product_vec4(at),geometry_product_vec4(at+4u),geometry_product_vec4(at+8u),
    geometry_product_vec4(at+12u),geometry_product_vec4(at+16u),
    vec4u(${buffer}[at+20u],${buffer}[at+21u],${buffer}[at+22u],${buffer}[at+23u]),
    geometry_product_vec4(at+24u),vec4u(${buffer}[at+28u],${buffer}[at+29u],${buffer}[at+30u],${buffer}[at+31u]));
}
fn geometry_product_input(leaf: u32, kind: u32, point: u32) -> vec4f {
  let header = leaf * 32u + 28u;
  let physical = SURFACE_GEOMETRY_PHYSICAL[kind-1u];
  let mask = ${buffer}[header+1u];
  let rank = countOneBits(mask & ((1u<<physical)-1u));
  return geometry_product_vec4(${buffer}[header] + rank * 12u + point * 4u);
}
`;
}
