/** VSM owns pairs; Geometry owns source work and conservative light bounds.
 * Overflow changes execution mode, never publishes a partial explicit queue. */
export const VSM_PAIR_HEADER_BYTES = 32;
export const VSM_PAIR_STRIDE = 16;
export const VSM_PAIR_MODE = Object.freeze({ Explicit: 0, Implicit: 1, Failed: 2 });
export const SHADOW_BOUNDS_HEADER_BYTES = 16;
export const SHADOW_BOUNDS_STRIDE = 32;
export const VSM_PAIR_HEADER_OFFSETS = Object.freeze({
  attempted: 0,
  written: 4,
  failure: 8,
  generation: 12,
  mode: 16,
  sourceCount: 20,
  dirtyCount: 24,
  sourceGeneration: 28,
});
export const VSM_PAIR_OFFSETS = Object.freeze({ workSlot: 0, pageSlot: 4, virtualPage: 8, status: 12 });

export const VSM_PAIR_WGSL = /* wgsl */ `
struct VsmPairHeader {
  attempted: u32,
  written_count: u32,
  failure: u32,
  generation: u32,
  mode: u32,
  source_count: u32,
  dirty_count: u32,
  source_generation: u32,
}
struct VsmPair {
  work_slot: u32,
  page_slot: u32,
  virtual_page: u32,
  status: u32,
}
struct VsmPairQueue {
  header: VsmPairHeader,
  elements: array<VsmPair>,
}
`;

export const SHADOW_BOUNDS_WGSL = /* wgsl */ `
struct ShadowBoundsHeader {
  count: u32,
  invalid: u32,
  capacity: u32,
  generation: u32,
}
struct ShadowMeshletBounds {
  light_xy: vec4f,
  triangle_count: u32,
  valid: u32,
  reserved: vec2u,
}
struct ShadowBoundsQueue {
  header: ShadowBoundsHeader,
  elements: array<ShadowMeshletBounds>,
}
`;

/** Atomic producer and read consumers have exactly the same ABI layout. */
export const VSM_PAIR_WRITE_WGSL = VSM_PAIR_WGSL.replace("attempted: u32", "attempted: atomic<u32>").replace(
  "failure: u32",
  "failure: atomic<u32>",
);
export const SHADOW_BOUNDS_WRITE_WGSL = SHADOW_BOUNDS_WGSL.replace("invalid: u32", "invalid: atomic<u32>");

/** CPU preflight of the complete implicit domain, before resource creation. */
export function vsmImplicitDomain(workCapacity: number, dirtyCapacity: number): number {
  const domain = workCapacity * dirtyCapacity;
  if (
    !Number.isSafeInteger(workCapacity) ||
    workCapacity < 1 ||
    !Number.isSafeInteger(dirtyCapacity) ||
    dirtyCapacity < 1 ||
    !Number.isSafeInteger(domain) ||
    domain > 0xffffffff
  ) {
    throw new RangeError("VSM complete implicit work × dirty-page domain exceeds u32");
  }
  return domain;
}
