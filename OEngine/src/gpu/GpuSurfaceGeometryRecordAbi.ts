/** Sole Surface geometry value product. Semantic inputs use center/X/Y neighbor
 * values, preserving the compiled graph's finite difference convention. */
export const SURFACE_GEOMETRY_INPUT_COUNT = 14;
export const SURFACE_GEOMETRY_RECORD_VECTORS = 45;
export const SURFACE_GEOMETRY_RECORD_BYTES = SURFACE_GEOMETRY_RECORD_VECTORS * 16;
export const SURFACE_GEOMETRY_RECORD_WGSL = /* wgsl */ `
struct SurfaceGeometryRecord {
  inputs: array<vec4f, 42>,
  geometric: vec4f,
  identity: vec4u,
  metrics: vec4f,
}
`;
