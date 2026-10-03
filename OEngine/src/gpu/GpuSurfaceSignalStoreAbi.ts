/** Sparse signal history ABI. TemporalFacts remains the authoritative full-rate
 * motion/identity producer; this key only identifies a signal result and its
 * validity domain. Hashes select bounded sets and never prove equality. */
export const SURFACE_SIGNAL_STORE_BUDGET_BYTES=64*1024*1024;
export const SURFACE_SIGNAL_STORE_KEY_WORDS=10;
export const SURFACE_SIGNAL_STORE_PRIMARY_WORDS=8; // 16-bit packet + metadata
export const SURFACE_SIGNAL_STORE_SPILL_WORDS=12; // rgba32/precision spill + metadata
export const SURFACE_SIGNAL_STORE_WAYS=4;
export const SURFACE_SIGNAL_STORE_ENTRY_BYTES=SURFACE_SIGNAL_STORE_SPILL_WORDS*4;
export const SURFACE_SIGNAL_STORE_KIND=Object.freeze({directDiffuse:0,environmentDiffuse:1,directSpecular:2,environmentSpecular:3,directCoat:4,environmentCoat:5});
export const SURFACE_SIGNAL_STORE_FLAG=Object.freeze({valid:1,owner:2,spill:4,pinned:8,temporal:16});
export interface SurfaceSignalStoreKey {readonly surfaceDomain:number;readonly cell:number;readonly signal:number;readonly geometryGeneration:number;readonly materialGeneration:number;readonly lightRevision:number;readonly environmentRevision:number;readonly shadowRevision:number;readonly aoRevision:number;readonly footprint:number;}
export function encodeSurfaceSignalStoreKey(key:SurfaceSignalStoreKey):Uint32Array<ArrayBuffer>{return Uint32Array.from(Object.values(key).map((v,i)=>{if(!Number.isSafeInteger(v)||v<0||v>0xffffffff)throw new RangeError(`Signal key word ${i} is invalid`);return v>>>0;}));}
export function planSurfaceSignalStoreCapacity(limits:Pick<GPUSupportedLimits,"maxBufferSize"|"maxStorageBufferBindingSize">,budgetBytes=SURFACE_SIGNAL_STORE_BUDGET_BYTES){
 const binding=Math.floor(Math.min(Number(limits.maxBufferSize),Number(limits.maxStorageBufferBindingSize))/256)*256;
 const bytes=Math.floor(budgetBytes/(SURFACE_SIGNAL_STORE_ENTRY_BYTES*SURFACE_SIGNAL_STORE_WAYS))*SURFACE_SIGNAL_STORE_ENTRY_BYTES*SURFACE_SIGNAL_STORE_WAYS;
 if(bytes< SURFACE_SIGNAL_STORE_ENTRY_BYTES*SURFACE_SIGNAL_STORE_WAYS)throw new RangeError("SignalStore cannot fit one four-way set");
 const segmentLimit=Math.floor(binding/SURFACE_SIGNAL_STORE_ENTRY_BYTES)*SURFACE_SIGNAL_STORE_ENTRY_BYTES;if(segmentLimit<SURFACE_SIGNAL_STORE_ENTRY_BYTES)throw new RangeError("SignalStore binding cannot fit one entry");
 const segments:number[]=[];for(let remaining=bytes;remaining;){const part=Math.min(remaining,segmentLimit);segments.push(part);remaining-=part;}
 return Object.freeze({bytes,entries:bytes/SURFACE_SIGNAL_STORE_ENTRY_BYTES,sets:bytes/(SURFACE_SIGNAL_STORE_ENTRY_BYTES*SURFACE_SIGNAL_STORE_WAYS),segmentBytes:Object.freeze(segments)});
}
export const SURFACE_SIGNAL_STORE_WGSL=/* wgsl */ `
const SURFACE_SIGNAL_STORE_KEY_WORDS:u32=${SURFACE_SIGNAL_STORE_KEY_WORDS}u;
const SURFACE_SIGNAL_STORE_ENTRY_WORDS:u32=${SURFACE_SIGNAL_STORE_SPILL_WORDS}u;
const SURFACE_SIGNAL_STORE_WAYS:u32=${SURFACE_SIGNAL_STORE_WAYS}u;
fn surface_signal_hash(key:ptr<storage,array<u32>,read>,at:u32)->u32{var h=2166136261u;for(var i=0u;i<SURFACE_SIGNAL_STORE_KEY_WORDS;i++){h=(h^(*key)[at+i])*16777619u;}return h;}
fn surface_signal_equal(store:ptr<storage,array<u32>,read>,entry:u32,key:ptr<storage,array<u32>,read>,at:u32)->bool{let base=entry*SURFACE_SIGNAL_STORE_ENTRY_WORDS;for(var i=0u;i<SURFACE_SIGNAL_STORE_KEY_WORDS;i++){if (*store)[base+i]!=(*key)[at+i]{return false;}}return true;}
`;
