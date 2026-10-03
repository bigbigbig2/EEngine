import { APPEARANCE_SURFACE_READ_WGSL } from "./GpuAppearanceCacheAbi.js";

/** Optimization-v1 work plans. A plan describes a span/grid/masked partition;
 * it never expands full-rate coverage into 64 wide pixel tasks. Local ABI. */
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
export function surfaceCellWorkspaceLayout(tiles: number): Readonly<{ counters: number; plans: number; maps: number; facts: number; bytes: number; tiles: number }> {
  if(!Number.isSafeInteger(tiles)||tiles<1)throw new RangeError("Invalid Surface workspace tile capacity");
  const plans=SURFACE_CELL_CONTROL_HEADER_WORDS*4,maps=plans+tiles*SURFACE_CELL_TILE_PLAN_BYTES;
  const facts=Math.ceil((maps+tiles*SURFACE_CELL_TILE_MAP_BYTES)/16)*16;
  return Object.freeze({counters:0,plans,maps,facts,bytes:facts+tiles*64*SURFACE_CELL_CHEAP_FACT_BYTES,tiles});
}
export function surfaceCellWorkspaceWgsl(tiles:number):string {
  surfaceCellWorkspaceLayout(tiles);
  return `struct SurfaceCellWorkspace {
 counters:array<atomic<u32>,${SURFACE_CELL_CONTROL_HEADER_WORDS}>,
 plans:array<u32,${tiles*SURFACE_CELL_TILE_PLAN_BYTES/4}>,
 maps:array<u32,${tiles*SURFACE_CELL_TILE_MAP_BYTES/4}>,
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
export const SURFACE_CELL_PLAN_WGSL = /* wgsl */ `
const SURFACE_CELL_PLAN_EMPTY:u32=0u;
const SURFACE_CELL_PLAN_PUBLICATION:u32=1u;
const SURFACE_CELL_PLAN_FINE:u32=2u;
const SURFACE_CELL_PLAN_GRID:u32=3u;
const SURFACE_CELL_PLAN_MASKED:u32=4u;
const SURFACE_CELL_PLANE_COUNT:u32=${SURFACE_CELL_PLANE_COUNT}u;
struct SurfaceCellPlanePlan {
 mode_rate:u32,
 result_base:u32,
 map_word_offset:u32,
 group_count:u32,
 coverage_lo:u32,
 coverage_hi:u32,
}
fn surface_cell_map_entry(words:ptr<storage,array<u32>,read>,offset:u32,entry:u32)->u32 {
 let bit=entry*6u;let at=offset+(bit>>5u);let shift=bit&31u;
 var result=(*words)[at]>>shift;
 if shift>26u {result|=(*words)[at+1u]<<(32u-shift);}
 return result&63u;
}
fn surface_cell_grid_index(lane:u32,rate:u32)->u32 {
 let sx=rate&3u;let sy=(rate>>2u)&3u;
 return ((lane/8u)>>sy)*(8u>>sx)+((lane%8u)>>sx);
}
fn surface_cell_group(plan:SurfaceCellPlanePlan,words:ptr<storage,array<u32>,read>,lane:u32)->u32 {
 let mode=plan.mode_rate&255u;
 if mode==SURFACE_CELL_PLAN_MASKED {return surface_cell_map_entry(words,plan.map_word_offset,lane);}
 if mode==SURFACE_CELL_PLAN_GRID {return surface_cell_grid_index(lane,(plan.mode_rate>>8u)&15u);}
 return lane;
}
fn surface_cell_mask_member(mask:vec2u,lane:u32)->bool {
 if lane<32u {return (mask.x&(1u<<lane))!=0u;}
 return (mask.y&(1u<<(lane-32u)))!=0u;
}
fn surface_cell_representative(plan:SurfaceCellPlanePlan,words:ptr<storage,array<u32>,read>,group:u32)->u32 {
 let coverage=vec2u(plan.coverage_lo,plan.coverage_hi);
 let mode=plan.mode_rate&255u;
 if mode==SURFACE_CELL_PLAN_MASKED {return surface_cell_map_entry(words,plan.map_word_offset+12u,group);}
 if mode==SURFACE_CELL_PLAN_FINE {return select(0xffffffffu,group,surface_cell_mask_member(coverage,group));}
 if mode==SURFACE_CELL_PLAN_GRID {
  let rate=(plan.mode_rate>>8u)&15u;let sx=rate&3u;let sy=(rate>>2u)&3u;
  let columns=8u>>sx;let origin=vec2u((group%columns)<<sx,(group/columns)<<sy);
  for(var y=0u;y<(1u<<sy);y++){for(var x=0u;x<(1u<<sx);x++){
   let lane=(origin.y+y)*8u+origin.x+x;if surface_cell_mask_member(coverage,lane){return lane;}
  }}
 }
 return 0xffffffffu;
}
`;

/** Shared read-only consumer. Plans/maps remain batch-local until lighting and
 * reconstruction finish. sample_map maps representative pixels to union records. */
export function surfaceCellReadWgsl(batchTiles: string): string {
  return /* wgsl */ `
fn surface_plan_word(tile:u32,plane:u32,word:u32)->u32 {
  return cell_plan_words[${SURFACE_CELL_CONTROL_HEADER_WORDS}u + tile * ${SURFACE_CELL_TILE_PLAN_BYTES / 4}u + 16u + plane * 6u + word];
}
fn surface_plan_map(offset:u32,lane:u32)->u32 {
  let base=${SURFACE_CELL_CONTROL_HEADER_WORDS}u + ${batchTiles} * ${SURFACE_CELL_TILE_PLAN_BYTES / 4}u;
  let bit=lane*6u;
  let at=base+offset+(bit>>5u);
  let shift=bit&31u;
  var value=cell_plan_words[at]>>shift;
  if shift>26u { value |= cell_plan_words[at+1u]<<(32u-shift); }
  return value&63u;
}
fn surface_plan_record(pixel:vec2u,plane:u32,tiles_x:u32,first_tile:u32)->u32 {
  let tile=(pixel.y/8u)*tiles_x+pixel.x/8u-first_tile;
  let lane=(pixel.y%8u)*8u+pixel.x%8u;
  let mode_rate=surface_plan_word(tile,plane,0u);
  let mode=mode_rate&255u;
  let coverage=surface_plan_word(tile,plane,4u+lane/32u);
  if (coverage&(1u<<(lane&31u)))==0u || mode==0u || mode==1u { return 0xffffffffu; }
  var representative=lane;
  if mode==4u {
    let offset=surface_plan_word(tile,plane,2u);
    representative=surface_plan_map(offset+12u,surface_plan_map(offset,lane));
  } else if mode==3u {
    let rate=(mode_rate>>8u)&15u;
    let width=1u<<(rate&3u);
    let height=1u<<(rate>>2u);
    let origin=vec2u((lane%8u)/width*width,(lane/8u)/height*height);
    representative=0xffffffffu;
    for(var y=0u;y<height;y++) { for(var x=0u;x<width;x++) {
      let candidate=(origin.y+y)*8u+origin.x+x;
      if (surface_plan_word(tile,plane,4u+candidate/32u)&(1u<<(candidate&31u)))!=0u {
        representative=min(representative,candidate);
      }
    }}
  }
  let coordinate=(pixel/8u)*8u+vec2u(representative%8u,representative/8u);
  return textureLoad(sample_map,vec2i(coordinate),0).x;
}
`;
}

/** Independent Constant/Default/Zero/Transient references. Publication entry
 * identity is a cheap fact, so all-constant and E-only surfaces need no record. */
export function surfaceCellFieldReadWgsl(batchTiles: string, firstTile: string,
  tilesX: string, paletteOffset: string, fieldBuffer = "fields"): string {
  const unpack = APPEARANCE_SURFACE_READ_WGSL
    .replace("@group(0) @binding(2) var<storage, read> fields: array<vec2u>;", "")
    .replace("fn surface_field(", "fn surface_transient_field(")
    .replaceAll("fields[", `${fieldBuffer}[`);
  return /* wgsl */ `
${unpack}
struct SurfaceFieldRef { kind:u32, index:u32, }
fn surface_plan_fact(pixel:vec2u)->vec4u {
  let tile=(pixel.y/8u)*${tilesX}+pixel.x/8u-${firstTile};
  let lane=(pixel.y%8u)*8u+pixel.x%8u;
  let base=(${SURFACE_CELL_CONTROL_HEADER_WORDS}u+${batchTiles}*${(SURFACE_CELL_TILE_PLAN_BYTES + SURFACE_CELL_TILE_MAP_BYTES) / 4}u+3u)&~3u;
  let at=base+(tile*64u+lane)*4u;
  return vec4u(cell_plan_words[at],cell_plan_words[at+1u],cell_plan_words[at+2u],cell_plan_words[at+3u]);
}
fn surface_default_field(field:u32)->vec4f {
  if field==6u || field==12u { return vec4f(0.0,0.0,1.0,0.0); }
  if field==1u || field==3u || field==4u || field==8u || field==9u || field==11u || field>=13u { return vec4f(1.0); }
  if field==7u { return vec4f(1.5,0.0,0.0,0.0); }
  return vec4f(0.0);
}
fn surface_field_ref(pixel:vec2u,field:u32)->SurfaceFieldRef {
  let fact=surface_plan_fact(pixel);
  if fact.x==0xffffffffu || fact.z==0xffffffffu { return SurfaceFieldRef(3u,0u); }
  let palette=${paletteOffset}+fact.z*64u;
  if (appearance_metadata[palette]&(1u<<field))!=0u { return SurfaceFieldRef(1u,palette+4u+field*4u); }
  let record=surface_plan_record(pixel,field,${tilesX},${firstTile});
  if record!=0xffffffffu { return SurfaceFieldRef(4u,record); }
  return SurfaceFieldRef(select(2u,3u,field==0u || field==2u || field==5u || field==10u),0u);
}
fn surface_field_at(pixel:vec2u,field:u32)->vec4f {
  let reference=surface_field_ref(pixel,field);
  if reference.kind==1u {
    return bitcast<vec4f>(vec4u(appearance_metadata[reference.index],appearance_metadata[reference.index+1u],appearance_metadata[reference.index+2u],appearance_metadata[reference.index+3u]));
  }
  if reference.kind==2u { return surface_default_field(field); }
  if reference.kind==3u { return vec4f(0.0); }
  return surface_transient_field(reference.index,field);
}
`;
}
