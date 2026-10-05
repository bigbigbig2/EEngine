/** Batch-local logical references. Plans address selected domains, never dense
 * full-frame refs. A Store ref names an immutable slot generation; the publisher
 * pins it for the submitted epoch before any later admission can reuse it. */
export const SURFACE_REFERENCE_WORDS = 3;
export const SURFACE_STORE_REFERENCE_WORDS = 2;
export const SURFACE_REFERENCE_KIND = Object.freeze({
  invalid: 0,
  publication: 1,
  default: 2,
  zero: 3,
  transient: 4,
  store: 5,
});
export const SURFACE_CELL_ADDRESS_WORDS = 24;
export const SURFACE_CELL_UV_WITNESS_WORDS = 18;
export const SURFACE_CELL_SIGNAL_WITNESS_WORDS = 12;
export const SURFACE_CELL_DEMAND_WORDS = 4;
export const SURFACE_CELL_ADDRESS = Object.freeze({
  instance: 0,
  instanceGeneration: 1,
  geometry: 2,
  geometryGeneration: 3,
  material: 4,
  sourceMeshlet: 5,
  sourcePrimitive: 6,
  lod: 7,
  side: 8,
  uv0Chart: 9,
  uv1Chart: 10,
  uv2Chart: 11,
  geometryRevision: 12,
  pixel: 13,
  setup: 14,
  validUvMask: 15,
  valid: 16,
  instanceFlags: 17,
  directSemantic: 18,
  signalWitnessMask: 19,
  normalFlip: 20,
});
export const SURFACE_REFERENCE_WGSL = /* wgsl */ `
const SURFACE_REFERENCE_INVALID:u32=0u;
const SURFACE_REFERENCE_PUBLICATION:u32=1u;
const SURFACE_REFERENCE_DEFAULT:u32=2u;
const SURFACE_REFERENCE_ZERO:u32=3u;
const SURFACE_REFERENCE_TRANSIENT:u32=4u;
const SURFACE_REFERENCE_STORE:u32=5u;
const SURFACE_REFERENCE_WORDS:u32=${SURFACE_REFERENCE_WORDS}u;
const SURFACE_CELL_ADDRESS_WORDS:u32=${SURFACE_CELL_ADDRESS_WORDS}u;
const SURFACE_CELL_DEMAND_WORDS:u32=${SURFACE_CELL_DEMAND_WORDS}u;
struct SurfaceReference { kind:u32, index:u32, generation:u32, }
`;
