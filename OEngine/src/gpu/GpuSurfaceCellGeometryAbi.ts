/** Bounded primitive setup owned by SurfaceGeometry. Every production batch
 * reserves enough local setup slots for its complete target range; the memo is
 * accounted separately and never steals mandatory local capacity. Setup stores
 * source attributes, not evaluated material/PBR or pixel records. */
export const SURFACE_CELL_GEOMETRY_SETUP_BYTES = 512;
export const SURFACE_CELL_GEOMETRY_SETUP_ALIGNMENT = 256;
export const SURFACE_CELL_GEOMETRY_REFERENCE_BYTES = 8;
export const SURFACE_CELL_GEOMETRY_MEMO_ENTRY_BYTES = SURFACE_CELL_GEOMETRY_SETUP_BYTES + 16;
export const SURFACE_CELL_GEOMETRY_MEMO_PROBE_LIMIT = 4;
export const SURFACE_CELL_GEOMETRY_SETUP_CAPACITY = 65536;
export const SURFACE_CELL_GEOMETRY_REFERENCE_CAPACITY = 65536;
export const SURFACE_CELL_GEOMETRY_SETTINGS_BYTES = 80;
export function planSurfaceCellGeometryCapacity(targetCapacity: number, addressBudgetBytes: number,
  limits: Pick<GPUSupportedLimits, "maxBufferSize" | "maxStorageBufferBindingSize">): Readonly<{
    setupCapacity: number; referenceCapacity: number; setupBytes: number; referenceBytes: number;
    memoCapacity: number; memoBytes: number; reservedBytes: number; totalReservedBytes: number;
  }> {
  if (!Number.isSafeInteger(targetCapacity)||targetCapacity<1||!Number.isSafeInteger(addressBudgetBytes)||addressBudgetBytes<1)
    throw new RangeError("Invalid Surface cell address capacity");
  const bindingLimit=Math.min(Number(limits.maxBufferSize),Number(limits.maxStorageBufferBindingSize));
  // Reserve the frame address and cheap fact products (48+16 B/target), plus
  // control/alignment. Setup's fixed pool does not silently exceed a small R.
  const pixelBytes=targetCapacity*64,controlBytes=512;
  const referencesFor=(_capacity:number)=>targetCapacity;
  const referenceBytes = Math.ceil(targetCapacity * SURFACE_CELL_GEOMETRY_REFERENCE_BYTES / 16) * 16;
  const memoFor=(capacity:number)=>2**Math.floor(Math.log2(Math.max(16,Math.min(capacity,SURFACE_CELL_GEOMETRY_REFERENCE_CAPACITY / 2))));
  const mandatoryCost=(capacity:number)=>pixelBytes+controlBytes+capacity*SURFACE_CELL_GEOMETRY_SETUP_BYTES+
    referenceBytes;
  let low=0,high=Math.min(SURFACE_CELL_GEOMETRY_SETUP_CAPACITY,targetCapacity,Math.floor(bindingLimit/SURFACE_CELL_GEOMETRY_SETUP_BYTES));
  while(low<high){const middle=Math.ceil((low+high)/2);
    if(mandatoryCost(middle)<=addressBudgetBytes && referenceBytes+
      middle*SURFACE_CELL_GEOMETRY_SETUP_BYTES<=bindingLimit)low=middle;else high=middle-1;}
  if(low<1)throw new RangeError("Surface cell address profile cannot fit one setup and complete target addresses");
  return Object.freeze({setupCapacity:low,referenceCapacity:referencesFor(low),setupBytes:low*SURFACE_CELL_GEOMETRY_SETUP_BYTES,
    referenceBytes,
    memoCapacity:memoFor(low),memoBytes:memoFor(low)*SURFACE_CELL_GEOMETRY_MEMO_ENTRY_BYTES,
    reservedBytes:mandatoryCost(low),totalReservedBytes:mandatoryCost(low)+memoFor(low)*SURFACE_CELL_GEOMETRY_MEMO_ENTRY_BYTES});
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
struct CellGeometryReference {key:u32,slot:u32,}
struct CellGeometryReferenceRead {key:u32,slot:u32,}
`;
export function surfaceCellGeometryArenaWgsl(referenceCapacity:number,write:boolean):string {
 if(!Number.isSafeInteger(referenceCapacity)||referenceCapacity<1)
  throw new RangeError("Invalid cell geometry dictionary layout");
 return `struct CellGeometryArena${write?"":"Read"} {
 references:array<CellGeometryReference${write?"":"Read"},${referenceCapacity}>,
 setups:array<CellGeometrySetup>,
}`;
}
