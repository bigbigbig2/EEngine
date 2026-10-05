import { APPEARANCE_FIELD_WIDTHS } from "./GpuAppearanceFieldAbi.js";
import {
  SURFACE_CELL_ADDRESS_WORDS,
  SURFACE_CELL_UV_WITNESS_WORDS,
  SURFACE_CELL_SIGNAL_WITNESS_WORDS,
  SURFACE_CELL_DEMAND_WORDS,
  SURFACE_STORE_REFERENCE_WORDS,
} from "./GpuSurfaceReferenceAbi.js";
import { SURFACE_PROOF_RECORD_BYTES } from "./GpuSurfaceProofAbi.js";

/** Batch work templates: publication, implicit fine, uniform rate or mixed
 * sources. Maps are a reserved append pool used ONLY by non-formula Mixed
 * associations. Proof/value payloads remain cold scratch owned by their stages. */
export const SURFACE_CELL_TILE_EDGE = 8;
export const SURFACE_CELL_FIELD_COUNT = 15;
export const SURFACE_CELL_SIGNAL_COUNT = 6;
export const SURFACE_CELL_PLANE_COUNT = SURFACE_CELL_FIELD_COUNT + SURFACE_CELL_SIGNAL_COUNT;
export const SURFACE_CELL_TILE_HEADER_BYTES = 64;
// Field coverage is independent: an absent coat/output in one material must not
// become a representative for a neighbouring material that needs the plane.
export const SURFACE_CELL_PLANE_BYTES = 24;
export const SURFACE_CELL_TILE_PLAN_BYTES =
  SURFACE_CELL_TILE_HEADER_BYTES + SURFACE_CELL_PLANE_COUNT * SURFACE_CELL_PLANE_BYTES;
export const SURFACE_CELL_MAP_WORDS = 12;
export const SURFACE_CELL_MAP_BYTES = 48;
export const SURFACE_CELL_MASKED_PLANE_BYTES = SURFACE_CELL_MAP_BYTES * 2;
export const SURFACE_CELL_TILE_MAP_BYTES = SURFACE_CELL_PLANE_COUNT * SURFACE_CELL_MASKED_PLANE_BYTES;
export const SURFACE_CELL_CONTROL_HEADER_WORDS = 128;
export const SURFACE_CELL_CHEAP_FACT_BYTES = 16;
/** One typed proof result slot is wide enough for the largest geometry or field
 * certificate. Slots are shared by all families and admitted at C <= R/2. */
export const SURFACE_CELL_PROOF_RESULT_WORDS = 52;
export const SURFACE_CELL_GEOMETRY_CERTIFICATE_WORDS = 32;
export const SURFACE_CELL_FIELD_CERTIFICATE_WORDS = 52;
export const SURFACE_CELL_CERTIFICATE_BYTES_PER_TARGET =
  (SURFACE_CELL_PROOF_RESULT_WORDS / 2 +
    SURFACE_CELL_FIELD_COUNT +
    5 +
    1 +
    SURFACE_CELL_ADDRESS_WORDS +
    SURFACE_CELL_DEMAND_WORDS +
    SURFACE_STORE_REFERENCE_WORDS * SURFACE_CELL_PLANE_COUNT +
    2) *
  4;
export const SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS = Object.freeze(
  APPEARANCE_FIELD_WIDTHS.map((_width, field) =>
    APPEARANCE_FIELD_WIDTHS.slice(0, field).reduce((sum, width) => sum + width * 2, 0),
  ),
);
export function surfaceCellWorkspaceLayout(tiles: number): Readonly<{
  counters: number;
  plans: number;
  maps: number;
  proofResults: number;
  geometryProofs: number;
  screenProofSlots: number;
  screenFieldProofs: number;
  persistentFieldProofs: number;
  fieldKnownMasks: number;
  persistentFieldMasks: number;
  primitives: number;
  addresses: number;
  uvWitnesses: number;
  signalWitnesses: number;
  fieldReferences: number;
  signalReferences: number;
  fieldStoreMasks: number;
  signalStoreMasks: number;
  demands: number;
  facts: number;
  proofs: number;
  pendingSupport: number;
  proofTileCounts: number;
  proofDispatch: number;
  proofTiles: number;
  bytes: number;
  tiles: number;
}> {
  if (!Number.isSafeInteger(tiles) || tiles < 1)
    throw new RangeError("Invalid Surface workspace tile capacity");
  const plans = SURFACE_CELL_CONTROL_HEADER_WORDS * 4,
    maps = plans + tiles * SURFACE_CELL_TILE_PLAN_BYTES;
  const proofResults = maps + tiles * SURFACE_CELL_TILE_MAP_BYTES;
  const geometryProofs = proofResults + tiles * 32 * SURFACE_CELL_PROOF_RESULT_WORDS * 4;
  const screenProofSlots = geometryProofs + tiles * 64 * 4;
  const screenFieldProofs = screenProofSlots + tiles * 64 * 4;
  const persistentFieldProofs = screenFieldProofs + tiles * 64 * SURFACE_CELL_FIELD_COUNT * 4;
  const fieldKnownMasks = persistentFieldProofs + tiles * 64 * 4;
  const persistentFieldMasks = fieldKnownMasks + tiles * 64 * 4;
  const primitives = persistentFieldMasks + tiles * 64 * 4;
  const addresses = primitives + tiles * 64 * 4;
  const uvWitnesses = addresses + tiles * 64 * SURFACE_CELL_ADDRESS_WORDS * 4;
  const signalWitnesses = uvWitnesses + tiles * 64 * SURFACE_CELL_UV_WITNESS_WORDS * 4;
  const fieldReferences = signalWitnesses + tiles * 64 * SURFACE_CELL_SIGNAL_WITNESS_WORDS * 4;
  const signalReferences =
    fieldReferences + tiles * 64 * SURFACE_CELL_FIELD_COUNT * SURFACE_STORE_REFERENCE_WORDS * 4;
  const fieldStoreMasks =
    signalReferences + tiles * 64 * SURFACE_CELL_SIGNAL_COUNT * SURFACE_STORE_REFERENCE_WORDS * 4;
  const signalStoreMasks = fieldStoreMasks + tiles * 64 * 4;
  const demands = signalStoreMasks + tiles * 64 * 4;
  const facts = Math.ceil((demands + tiles * 64 * SURFACE_CELL_DEMAND_WORDS * 4) / 16) * 16;
  const proofs = facts + tiles * 64 * SURFACE_CELL_CHEAP_FACT_BYTES;
  const pendingSupport = proofs + tiles * 32 * SURFACE_PROOF_RECORD_BYTES;
  const proofTileCounts = pendingSupport + tiles * 64 * 15 * 4;
  const proofDispatch = proofTileCounts + 7 * 4;
  const proofTiles = proofDispatch + 7 * 4 * 4;
  return Object.freeze({
    counters: 0,
    plans,
    maps,
    proofResults,
    geometryProofs,
    screenProofSlots,
    screenFieldProofs,
    persistentFieldProofs,
    fieldKnownMasks,
    persistentFieldMasks,
    primitives,
    addresses,
    uvWitnesses,
    signalWitnesses,
    fieldReferences,
    signalReferences,
    fieldStoreMasks,
    signalStoreMasks,
    demands,
    facts,
    proofs,
    pendingSupport,
    proofTileCounts,
    proofDispatch,
    proofTiles,
    bytes: Math.ceil((proofTiles + 7 * tiles * 4) / 16) * 16,
    tiles,
  });
}
export function surfaceCellWorkspaceWgsl(tiles: number): string {
  surfaceCellWorkspaceLayout(tiles);
  return `const SURFACE_PROOF_CAPACITY: u32 = ${tiles * 32}u;
struct SurfaceCellWorkspace {
 counters:array<atomic<u32>,${SURFACE_CELL_CONTROL_HEADER_WORDS}>,
 plans:array<u32,${(tiles * SURFACE_CELL_TILE_PLAN_BYTES) / 4}>,
 maps:array<u32,${(tiles * SURFACE_CELL_TILE_MAP_BYTES) / 4}>,
  proof_results:array<u32,${tiles * 32 * SURFACE_CELL_PROOF_RESULT_WORDS}>,
  geometry_proofs:array<u32,${tiles * 64}>,
  screen_proof_slots:array<u32,${tiles * 64}>,
  screen_field_proofs:array<u32,${tiles * 64 * SURFACE_CELL_FIELD_COUNT}>,
  persistent_field_proofs:array<u32,${tiles * 64}>,
  field_known_masks:array<u32,${tiles * 64}>,
  persistent_field_masks:array<u32,${tiles * 64}>,
 primitives:array<u32,${tiles * 64}>,
 addresses:array<u32,${tiles * 64 * SURFACE_CELL_ADDRESS_WORDS}>,
 uv_witnesses:array<u32,${tiles * 64 * SURFACE_CELL_UV_WITNESS_WORDS}>,
 signal_witnesses:array<u32,${tiles * 64 * SURFACE_CELL_SIGNAL_WITNESS_WORDS}>,
 field_references:array<u32,${tiles * 64 * SURFACE_CELL_FIELD_COUNT * SURFACE_STORE_REFERENCE_WORDS}>,
 signal_references:array<u32,${tiles * 64 * SURFACE_CELL_SIGNAL_COUNT * SURFACE_STORE_REFERENCE_WORDS}>,
 field_store_masks:array<atomic<u32>,${tiles * 64}>,
 signal_store_masks:array<atomic<u32>,${tiles * 64}>,
 demands:array<u32,${tiles * 64 * SURFACE_CELL_DEMAND_WORDS}>,
 facts:array<vec4u,${tiles * 64}>,
 proof_requests:array<array<u32,8>,${tiles * 32}>,
 pending_support:array<u32,${tiles * 64 * 15}>,
 proof_tile_counts:array<atomic<u32>,7>,
 proof_dispatch:array<u32,28>,
 proof_tiles:array<u32,${tiles * 7}>,
}`;
}
/** Payload validity is published by masks/counts. Reset only shared state
 * that can accumulate or name an optional result before the next batch. */
export function surfaceCellWorkspaceResetRanges(tiles: number): readonly (readonly [number, number])[] {
  const layout = surfaceCellWorkspaceLayout(tiles);
  return Object.freeze([
    Object.freeze([0, SURFACE_CELL_CONTROL_HEADER_WORDS * 4] as const),
    Object.freeze([layout.geometryProofs, layout.primitives - layout.geometryProofs] as const),
    Object.freeze([layout.fieldStoreMasks, layout.demands - layout.fieldStoreMasks] as const),
    Object.freeze([layout.proofTileCounts, 7 * 4] as const),
  ]);
}
export const SURFACE_CELL_PLAN_MODE = Object.freeze({
  empty: 0,
  publication: 1,
  fine: 2,
  grid: 3,
  masked: 4,
});
export const SURFACE_CELL_SIGNAL = Object.freeze({
  directDiffuse: 15,
  environmentDiffuse: 16,
  directSpecular: 17,
  environmentSpecular: 18,
  directCoat: 19,
  environmentCoat: 20,
});
/** rate axis exponents; 1x1/2x1/1x2/2x2/4x4/8x8. */
export const SURFACE_CELL_RATE = Object.freeze({
  fine: 0,
  horizontal: 1,
  vertical: 4,
  quad: 5,
  four: 10,
  eight: 15,
});

export function packSurfaceCellSixBit(values: ArrayLike<number>): Uint32Array<ArrayBuffer> {
  if (values.length !== 64) throw new RangeError("A Surface cell map contains exactly 64 entries");
  const words = new Uint32Array(SURFACE_CELL_MAP_WORDS);
  for (let i = 0; i < 64; i++) {
    const value = values[i]!;
    if (!Number.isInteger(value) || value < 0 || value > 63)
      throw new RangeError("Surface cell map entry exceeds six bits");
    const bit = i * 6,
      index = bit >>> 5,
      shift = bit & 31;
    words[index]! |= value << shift;
    if (shift > 26) words[index + 1]! |= value >>> (32 - shift);
  }
  return words;
}
export function surfaceCellSixBit(words: ArrayLike<number>, entry: number, wordOffset = 0): number {
  if (
    !Number.isInteger(entry) ||
    entry < 0 ||
    entry >= 64 ||
    !Number.isInteger(wordOffset) ||
    wordOffset < 0 ||
    wordOffset + SURFACE_CELL_MAP_WORDS > words.length
  )
    throw new RangeError("Invalid Surface packed cell map address");
  const bit = entry * 6,
    at = wordOffset + (bit >>> 5),
    shift = bit & 31;
  const low = words[at]! >>> shift;
  return (low | (shift > 26 ? words[at + 1]! << (32 - shift) : 0)) & 63;
}
export function surfaceCellSelectionWgsl(workspace: string, metadata: string, constants: string): string {
  return /* wgsl */ `
fn reference_plan_word(leaf:u32,plane:u32,word:u32)->u32 {
  return ${workspace}.plans[(leaf/64u)*${SURFACE_CELL_TILE_PLAN_BYTES / 4}u+16u+plane*6u+word];
}
fn reference_plan_map(leaf:u32,plane:u32,entry:u32)->u32 {
  let base=reference_plan_word(leaf,plane,2u);
  let bit=entry*6u;
  let at=base+(bit>>5u);
  let shift=bit&31u;
  var value=${workspace}.maps[at]>>shift;
  if shift>26u { value|=${workspace}.maps[at+1u]<<(32u-shift); }
  return value&63u;
}
fn reference_plan_leaf(leaf:u32,plane:u32)->u32 {
  let lane=leaf%64u;
  let mode_rate=reference_plan_word(leaf,plane,0u);
  let mode=mode_rate&255u;
  let coverage=reference_plan_word(leaf,plane,4u+lane/32u);
  if mode==0u || (coverage&(1u<<(lane&31u)))==0u { return 0xffffffffu; }
  if mode==1u || mode==2u { return leaf; }
  if mode==3u {
    let rate=(mode_rate>>8u)&15u;
    let width=1u<<(rate&3u);
    let height=1u<<((rate>>2u)&3u);
    let origin=vec2u((lane%8u)/width*width,(lane/8u)/height*height);
    let mask=vec2u(reference_plan_word(leaf,plane,4u),reference_plan_word(leaf,plane,5u));
    // Select from real partial coverage, independent of storage map payload.
    let row_mask=((1u<<width)-1u)<<origin.x;
    for(var y=0u;y<height;y++) {
      let row=origin.y+y;
      let covered=(mask[row/4u]>>((row&3u)*8u))&row_mask;
      if covered!=0u { return (leaf/64u)*64u+row*8u+firstTrailingBit(covered); }
    }
    return 0xffffffffu;
  }
  let group=reference_plan_map(leaf,plane,lane);
  let anchor=reference_plan_map(leaf,plane,64u+group);
  return (leaf/64u)*64u+anchor;
}
fn reference_field(leaf:u32,field:u32)->SurfaceReference {
  let entry=${workspace}.facts[leaf].z;
  let palette=${constants}+entry*64u;
  if (${metadata}[palette]&(1u<<field))!=0u {
    let present=(${metadata}[palette+3u]&(1u<<field))!=0u;
    return SurfaceReference(select(SURFACE_REFERENCE_DEFAULT,SURFACE_REFERENCE_PUBLICATION,present),entry,${metadata}[palette+2u]);
  }
  let source=reference_plan_leaf(leaf,field);
  if source==0xffffffffu { return SurfaceReference(SURFACE_REFERENCE_DEFAULT,${workspace}.facts[leaf].z,0u); }
  if (atomicLoad(&${workspace}.field_store_masks[source])&(1u<<field))==0u {
    return SurfaceReference(SURFACE_REFERENCE_TRANSIENT,source*15u+field,0u);
  }
  let at=(source*15u+field)*2u;
  return SurfaceReference(SURFACE_REFERENCE_STORE,${workspace}.field_references[at],${workspace}.field_references[at+1u]);
}
`;
}

/** Independent Constant/Default/Zero/Transient references. Publication entry
 * identity is a cheap fact, so all-constant and E-only surfaces need no record. */
