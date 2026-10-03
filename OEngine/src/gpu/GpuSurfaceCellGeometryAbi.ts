/** Transient primitive setup inside SurfaceGeometry ownership. No persistent
 * pixel geometry cache or independent Winner coordinator. One admitted winner
 * owns one setup; capacity misses use the same decoder's invocation-local math.
 * Setup stores source attributes, not evaluated material/PBR or pixel records. */
export const SURFACE_CELL_GEOMETRY_SETUP_BYTES = 512;
export const SURFACE_CELL_GEOMETRY_DICTIONARY_BYTES = 8;
export const SURFACE_CELL_GEOMETRY_SETUP_CAPACITY = 24576;
export const SURFACE_CELL_GEOMETRY_DICTIONARY_CAPACITY = 65536;
export const SURFACE_CELL_GEOMETRY_PROBE_LIMIT = 8;
export const SURFACE_CELL_GEOMETRY_SETTINGS_BYTES = 80;
export function planSurfaceCellGeometryCapacity(targetCapacity: number, addressBudgetBytes: number,
  limits: Pick<GPUSupportedLimits, "maxBufferSize" | "maxStorageBufferBindingSize">): Readonly<{
    setupCapacity: number; dictionaryCapacity: number; setupBytes: number; dictionaryBytes: number; reservedBytes: number;
  }> {
  if (!Number.isSafeInteger(targetCapacity)||targetCapacity<1||!Number.isSafeInteger(addressBudgetBytes)||addressBudgetBytes<1)
    throw new RangeError("Invalid Surface cell address capacity");
  const bindingLimit=Math.min(Number(limits.maxBufferSize),Number(limits.maxStorageBufferBindingSize));
  // Reserve the frame address and cheap fact products (48+16 B/target), plus
  // control/alignment. Setup's fixed pool does not silently exceed a small R.
  const pixelBytes=targetCapacity*64,controlBytes=512;
  const dictionaryFor=(capacity:number)=>2**Math.ceil(Math.log2(Math.max(16,Math.min(SURFACE_CELL_GEOMETRY_DICTIONARY_CAPACITY,capacity*4))));
  const cost=(capacity:number)=>pixelBytes+controlBytes+capacity*SURFACE_CELL_GEOMETRY_SETUP_BYTES+dictionaryFor(capacity)*SURFACE_CELL_GEOMETRY_DICTIONARY_BYTES;
  let low=0,high=Math.min(SURFACE_CELL_GEOMETRY_SETUP_CAPACITY,targetCapacity,Math.floor(bindingLimit/SURFACE_CELL_GEOMETRY_SETUP_BYTES));
  while(low<high){const middle=Math.ceil((low+high)/2);
    if(cost(middle)<=addressBudgetBytes && dictionaryFor(middle)*SURFACE_CELL_GEOMETRY_DICTIONARY_BYTES+middle*SURFACE_CELL_GEOMETRY_SETUP_BYTES<=bindingLimit)low=middle;else high=middle-1;}
  if(low<1)throw new RangeError("Surface cell address profile cannot fit one setup and complete target addresses");
  return Object.freeze({setupCapacity:low,dictionaryCapacity:dictionaryFor(low),setupBytes:low*SURFACE_CELL_GEOMETRY_SETUP_BYTES,
    dictionaryBytes:dictionaryFor(low)*SURFACE_CELL_GEOMETRY_DICTIONARY_BYTES,reservedBytes:cost(low)});
}
export const SURFACE_CELL_GEOMETRY_WGSL = /* wgsl */ `
struct CellGeometrySetup {
 identity:vec4u,
 source:vec4u,
 continuity:array<vec4u,4>,
 coefficients:WinnerCoefficients,
 corners:array<vec4f,18>,
 world_plane:vec4f,
 variation:vec4f,
 source_address:vec4u,
 reserved:array<vec4u,2>,
}
struct CellGeometryDictionary {key:atomic<u32>,slot:u32,}
struct CellGeometryDictionaryRead {key:u32,slot:u32,}
`;
export function surfaceCellGeometryArenaWgsl(dictionaryCapacity:number,write:boolean):string {
 if(!Number.isSafeInteger(dictionaryCapacity)||dictionaryCapacity<16||(dictionaryCapacity&(dictionaryCapacity-1))!==0)
  throw new RangeError("Invalid cell geometry dictionary layout");
 return `struct CellGeometryArena${write?"":"Read"} {
 dictionary:array<CellGeometryDictionary${write?"":"Read"},${dictionaryCapacity}>,
 setups:array<CellGeometrySetup>,
}`;
}
