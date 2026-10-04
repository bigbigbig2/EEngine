import { APPEARANCE_FIELD_WIDTHS } from "./GpuAppearanceFieldAbi.js";
import { SURFACE_CELL_ADDRESS_WORDS, SURFACE_CELL_DEMAND_WORDS, SURFACE_REFERENCE_WORDS } from "./GpuSurfaceReferenceAbi.js";

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
export const SURFACE_CELL_TILE_PLAN_BYTES = SURFACE_CELL_TILE_HEADER_BYTES + SURFACE_CELL_PLANE_COUNT * SURFACE_CELL_PLANE_BYTES;
export const SURFACE_CELL_MAP_WORDS = 12;
export const SURFACE_CELL_MAP_BYTES = 48;
export const SURFACE_CELL_MASKED_PLANE_BYTES = SURFACE_CELL_MAP_BYTES * 2;
export const SURFACE_CELL_TILE_MAP_BYTES = SURFACE_CELL_PLANE_COUNT * SURFACE_CELL_MASKED_PLANE_BYTES;
export const SURFACE_CELL_CONTROL_HEADER_WORDS = 128;
export const SURFACE_CELL_CHEAP_FACT_BYTES = 16;
export const SURFACE_CELL_GEOMETRY_CERTIFICATE_WORDS = 32;
export const SURFACE_CELL_FIELD_CERTIFICATE_WORDS = 52;
export const SURFACE_CELL_CERTIFICATE_BYTES_PER_TARGET = (SURFACE_CELL_GEOMETRY_CERTIFICATE_WORDS + SURFACE_CELL_FIELD_CERTIFICATE_WORDS * 2 + 1 +
  SURFACE_CELL_ADDRESS_WORDS + SURFACE_CELL_DEMAND_WORDS + SURFACE_REFERENCE_WORDS * SURFACE_CELL_PLANE_COUNT) * 4;
export const SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS = Object.freeze(APPEARANCE_FIELD_WIDTHS.map((_width, field) =>
  APPEARANCE_FIELD_WIDTHS.slice(0,field).reduce((sum,width) => sum + width * 2,0)));
export function surfaceCellWorkspaceLayout(tiles: number): Readonly<{ counters: number; plans: number; maps: number;
  geometryCertificates: number; fieldCertificates: number; persistentCertificates: number; primitives: number; addresses: number; fieldReferences: number;
  signalReferences: number; demands: number; facts: number; bytes: number; tiles: number }> {
  if(!Number.isSafeInteger(tiles)||tiles<1)throw new RangeError("Invalid Surface workspace tile capacity");
  const plans=SURFACE_CELL_CONTROL_HEADER_WORDS*4,maps=plans+tiles*SURFACE_CELL_TILE_PLAN_BYTES;
  const geometryCertificates=maps+tiles*SURFACE_CELL_TILE_MAP_BYTES;
  const fieldCertificates=geometryCertificates+tiles*64*SURFACE_CELL_GEOMETRY_CERTIFICATE_WORDS*4;
  const persistentCertificates=fieldCertificates+tiles*64*SURFACE_CELL_FIELD_CERTIFICATE_WORDS*4;
  const primitives=persistentCertificates+tiles*64*SURFACE_CELL_FIELD_CERTIFICATE_WORDS*4;
  const addresses=primitives+tiles*64*4;
  const fieldReferences=addresses+tiles*64*SURFACE_CELL_ADDRESS_WORDS*4;
  const signalReferences=fieldReferences+tiles*64*SURFACE_CELL_FIELD_COUNT*SURFACE_REFERENCE_WORDS*4;
  const demands=signalReferences+tiles*64*SURFACE_CELL_SIGNAL_COUNT*SURFACE_REFERENCE_WORDS*4;
  const facts=Math.ceil((demands+tiles*64*SURFACE_CELL_DEMAND_WORDS*4)/16)*16;
  return Object.freeze({counters:0,plans,maps,geometryCertificates,fieldCertificates,persistentCertificates,primitives,addresses,fieldReferences,signalReferences,demands,facts,
    bytes:facts+tiles*64*SURFACE_CELL_CHEAP_FACT_BYTES,tiles});
}
export function surfaceCellWorkspaceWgsl(tiles:number):string {
  surfaceCellWorkspaceLayout(tiles);
  return `struct SurfaceCellWorkspace {
 counters:array<atomic<u32>,${SURFACE_CELL_CONTROL_HEADER_WORDS}>,
 plans:array<u32,${tiles*SURFACE_CELL_TILE_PLAN_BYTES/4}>,
 maps:array<u32,${tiles*SURFACE_CELL_TILE_MAP_BYTES/4}>,
 geometry_certificates:array<u32,${tiles*64*SURFACE_CELL_GEOMETRY_CERTIFICATE_WORDS}>,
 field_certificates:array<u32,${tiles*64*SURFACE_CELL_FIELD_CERTIFICATE_WORDS}>,
 persistent_certificates:array<u32,${tiles*64*SURFACE_CELL_FIELD_CERTIFICATE_WORDS}>,
 primitives:array<u32,${tiles*64}>,
 addresses:array<u32,${tiles*64*SURFACE_CELL_ADDRESS_WORDS}>,
 field_references:array<u32,${tiles*64*SURFACE_CELL_FIELD_COUNT*SURFACE_REFERENCE_WORDS}>,
 signal_references:array<u32,${tiles*64*SURFACE_CELL_SIGNAL_COUNT*SURFACE_REFERENCE_WORDS}>,
 demands:array<u32,${tiles*64*SURFACE_CELL_DEMAND_WORDS}>,
 facts:array<vec4u>,
}`;
}
export const SURFACE_CELL_PLAN_MODE = Object.freeze({ empty: 0, publication: 1, fine: 2, grid: 3, masked: 4 });
export const SURFACE_CELL_SIGNAL = Object.freeze({ directDiffuse: 15, environmentDiffuse: 16,
  directSpecular: 17, environmentSpecular: 18, directCoat: 19, environmentCoat: 20 });
/** rate axis exponents; 1x1/2x1/1x2/2x2/4x4/8x8. */
export const SURFACE_CELL_RATE = Object.freeze({ fine: 0, horizontal: 1, vertical: 4, quad: 5, four: 10, eight: 15 });

export function packSurfaceCellSixBit(values: ArrayLike<number>): Uint32Array<ArrayBuffer> {
  if (values.length !== 64) throw new RangeError("A Surface cell map contains exactly 64 entries");
  const words = new Uint32Array(SURFACE_CELL_MAP_WORDS);
  for (let i = 0; i < 64; i++) {
    const value = values[i]!;
    if (!Number.isInteger(value) || value < 0 || value > 63) throw new RangeError("Surface cell map entry exceeds six bits");
    const bit = i * 6, index = bit >>> 5, shift = bit & 31;
    words[index]! |= value << shift;
    if (shift > 26) words[index + 1]! |= value >>> (32 - shift);
  }
  return words;
}
export function surfaceCellSixBit(words: ArrayLike<number>, entry: number, wordOffset = 0): number {
  if (!Number.isInteger(entry) || entry < 0 || entry >= 64 || !Number.isInteger(wordOffset) || wordOffset < 0 ||
    wordOffset + SURFACE_CELL_MAP_WORDS > words.length) throw new RangeError("Invalid Surface packed cell map address");
  const bit = entry * 6, at = wordOffset + (bit >>> 5), shift = bit & 31;
  const low = words[at]! >>> shift;
  return (low | (shift > 26 ? words[at + 1]! << (32 - shift) : 0)) & 63;
}
export function surfaceCellSelectionWgsl(workspace: string, metadata: string, constants: string): string {
  return /* wgsl */ `
fn reference_plan_word(leaf:u32,plane:u32,word:u32)->u32 {
  return ${workspace}.plans[(leaf/64u)*${SURFACE_CELL_TILE_PLAN_BYTES/4}u+16u+plane*6u+word];
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
  let at=(source*15u+field)*3u;
  return SurfaceReference(${workspace}.field_references[at],${workspace}.field_references[at+1u],${workspace}.field_references[at+2u]);
}
`;
}

/** Independent Constant/Default/Zero/Transient references. Publication entry
 * identity is a cheap fact, so all-constant and E-only surfaces need no record. */
