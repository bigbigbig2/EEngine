/** Stable Surface V3 FieldStore ABI. A key is a complete identity witness;
 * its hash only selects a bounded set. Values are field-specific and never
 * interpreted as a complete material closure. */
export const SURFACE_FIELD_STORE_ABI_VERSION = 1;
export const SURFACE_FIELD_STORE_KEY_WORDS = 12;
export const SURFACE_FIELD_STORE_VALUE_WORDS = 4;
export const SURFACE_FIELD_STORE_ENTRY_WORDS = 24;
export const SURFACE_FIELD_STORE_ENTRY_BYTES = SURFACE_FIELD_STORE_ENTRY_WORDS * 4;
export const SURFACE_FIELD_STORE_WAYS = 4;
export const SURFACE_FIELD_STORE_EMPTY = 0xffffffff;
export const SURFACE_FIELD_STORE_BUDGET_BYTES = 128 * 1024 * 1024;
export const SURFACE_FIELD_STORE_MAX_PROBE = 4;

export const SURFACE_FIELD_STORE_FLAGS = Object.freeze({
  valid: 1, owner: 2, exact: 4, bounded: 8, spilled: 16, pinned: 32
});

export interface SurfaceFieldStoreKey {
  readonly programGeneration: number;
  readonly fieldVersion: number;
  readonly chartDomain: number;
  readonly cellLevel: number;
  readonly cellX: number;
  readonly cellY: number;
  readonly samplerClass: number;
  readonly textureGeneration: number;
  readonly geometryDomain: number;
  readonly side: number;
  readonly footprintId: number;
  readonly reserved: number;
}
export interface SurfaceFieldStoreCapacity {
  readonly bytes: number;
  readonly entries: number;
  readonly sets: number;
  readonly segmentBytes: readonly number[];
}
const u32=(value:number,name:string):number=>{if(!Number.isSafeInteger(value)||value<0||value>0xffffffff)throw new RangeError(`${name} must be u32`);return value>>>0;};
export function encodeSurfaceFieldStoreKey(key:SurfaceFieldStoreKey):Uint32Array<ArrayBuffer>{
 return Uint32Array.from([u32(key.programGeneration,"programGeneration"),u32(key.fieldVersion,"fieldVersion"),u32(key.chartDomain,"chartDomain"),u32(key.cellLevel,"cellLevel"),u32(key.cellX,"cellX"),u32(key.cellY,"cellY"),u32(key.samplerClass,"samplerClass"),u32(key.textureGeneration,"textureGeneration"),u32(key.geometryDomain,"geometryDomain"),u32(key.side,"side"),u32(key.footprintId,"footprintId"),u32(key.reserved,"reserved")]);
}
export function planSurfaceFieldStoreCapacity(limits:Pick<GPUSupportedLimits,"maxBufferSize"|"maxStorageBufferBindingSize">,budgetBytes=SURFACE_FIELD_STORE_BUDGET_BYTES):SurfaceFieldStoreCapacity{
 const binding=Math.floor(Math.min(Number(limits.maxBufferSize),Number(limits.maxStorageBufferBindingSize))/256)*256;
 if(!Number.isSafeInteger(budgetBytes)||budgetBytes<SURFACE_FIELD_STORE_ENTRY_BYTES*SURFACE_FIELD_STORE_WAYS)throw new RangeError("Invalid FieldStore budget");
 const bytes=Math.floor(budgetBytes/(SURFACE_FIELD_STORE_ENTRY_BYTES*SURFACE_FIELD_STORE_WAYS))*SURFACE_FIELD_STORE_ENTRY_BYTES*SURFACE_FIELD_STORE_WAYS;
 const entries=Math.floor(bytes/SURFACE_FIELD_STORE_ENTRY_BYTES);const sets=Math.floor(entries/SURFACE_FIELD_STORE_WAYS);
 if(sets<1)throw new RangeError("FieldStore cannot fit one bounded set");
 const segmentBytes:number[]=[];let remaining=bytes;const segmentLimit=Math.floor(binding/SURFACE_FIELD_STORE_ENTRY_BYTES)*SURFACE_FIELD_STORE_ENTRY_BYTES;if(segmentLimit<SURFACE_FIELD_STORE_ENTRY_BYTES)throw new RangeError("FieldStore binding cannot fit one entry");while(remaining){const part=Math.min(remaining,segmentLimit);segmentBytes.push(part);remaining-=part;}
 return Object.freeze({bytes,entries:sets*SURFACE_FIELD_STORE_WAYS,sets,segmentBytes:Object.freeze(segmentBytes)});
}

export const SURFACE_FIELD_STORE_WGSL=/* wgsl */ `
const SURFACE_FIELD_STORE_EMPTY:u32=${SURFACE_FIELD_STORE_EMPTY}u;
const SURFACE_FIELD_STORE_KEY_WORDS:u32=${SURFACE_FIELD_STORE_KEY_WORDS}u;
const SURFACE_FIELD_STORE_ENTRY_WORDS:u32=${SURFACE_FIELD_STORE_ENTRY_WORDS}u;
const SURFACE_FIELD_STORE_WAYS:u32=${SURFACE_FIELD_STORE_WAYS}u;
fn surface_field_store_hash(key:ptr<storage,array<u32>,read>,at:u32)->u32{var h=2166136261u;for(var i=0u;i<SURFACE_FIELD_STORE_KEY_WORDS;i++){h=(h^(*key)[at+i])*16777619u;}return h;}
fn surface_field_store_equal(store:ptr<storage,array<u32>,read>,entry:u32,key:ptr<storage,array<u32>,read>,keyAt:u32)->bool{let at=entry*SURFACE_FIELD_STORE_ENTRY_WORDS;for(var i=0u;i<SURFACE_FIELD_STORE_KEY_WORDS;i++){if (*store)[at+i]!=(*key)[keyAt+i]{return false;}}return true;}
fn surface_field_store_equal_atomic(store:ptr<storage,array<atomic<u32>>,read_write>,entry:u32,key:ptr<storage,array<u32>,read>,keyAt:u32)->bool{let at=entry*SURFACE_FIELD_STORE_ENTRY_WORDS;for(var i=0u;i<SURFACE_FIELD_STORE_KEY_WORDS;i++){if atomicLoad(&(*store)[at+i])!=(*key)[keyAt+i]{return false;}}return true;}
fn surface_field_store_entry(setIndex:u32,way:u32)->u32{return (setIndex*SURFACE_FIELD_STORE_WAYS+way);}
`;
export const SURFACE_FIELD_STORE_COMPUTE_WGSL=/* wgsl */ `
${SURFACE_FIELD_STORE_WGSL}
struct SurfaceFieldStoreSettings {request_count:u32,entry_count:u32,generation:u32,segment_base:u32,}
@group(0) @binding(0) var<uniform> surface_field_store_settings:SurfaceFieldStoreSettings;
@group(0) @binding(1) var<storage,read> surface_field_store_requests:array<u32>;
@group(0) @binding(2) var<storage,read_write> surface_field_store_entries:array<atomic<u32>>;
@group(0) @binding(3) var<storage,read_write> surface_field_store_results:array<u32>;
@group(0) @binding(4) var<storage,read_write> surface_field_store_counters:array<atomic<u32>>;
fn surface_field_store_probe(request:u32)->u32 {
 let hash=surface_field_store_hash(&surface_field_store_requests,request*16u);
 let setIndex=hash%(surface_field_store_settings.entry_count/SURFACE_FIELD_STORE_WAYS);
 for(var way=0u;way<SURFACE_FIELD_STORE_WAYS;way++){let entry=surface_field_store_entry(setIndex,way);let at=entry*SURFACE_FIELD_STORE_ENTRY_WORDS;
  if surface_field_store_equal_atomic(&surface_field_store_entries,entry,&surface_field_store_requests,request*16u){return entry;}
  if atomicLoad(&surface_field_store_entries[at])==SURFACE_FIELD_STORE_EMPTY{return 0xffffffffu;}
 }
 return 0xffffffffu;
}
@compute @workgroup_size(64) fn surface_field_store_lookup(@builtin(global_invocation_id) id:vec3u){
 let request=id.x;if request>=surface_field_store_settings.request_count{return;}
 atomicAdd(&surface_field_store_counters[0],1u);let hit=surface_field_store_probe(request);
 if hit==0xffffffffu{surface_field_store_results[request*2u]=0xffffffffu;atomicAdd(&surface_field_store_counters[2],1u);}else{surface_field_store_results[request*2u]=hit;surface_field_store_results[request*2u+1u]=1u;atomicAdd(&surface_field_store_counters[1],1u);}
}
@compute @workgroup_size(64) fn surface_field_store_publish(@builtin(global_invocation_id) id:vec3u){
 let request=id.x;if request>=surface_field_store_settings.request_count{return;}
 let hash=surface_field_store_hash(&surface_field_store_requests,request*16u);let setIndex=hash%(surface_field_store_settings.entry_count/SURFACE_FIELD_STORE_WAYS);
 for(var way=0u;way<SURFACE_FIELD_STORE_WAYS;way++){let entry=surface_field_store_entry(setIndex,way);let at=entry*SURFACE_FIELD_STORE_ENTRY_WORDS;
  let old=atomicCompareExchangeWeak(&surface_field_store_entries[at],SURFACE_FIELD_STORE_EMPTY,surface_field_store_requests[request*16u]);
  if old.exchanged||old.old_value==surface_field_store_requests[request*16u]{
   for(var word=1u;word<SURFACE_FIELD_STORE_KEY_WORDS;word++){atomicStore(&surface_field_store_entries[at+word],surface_field_store_requests[request*16u+word]);}
   for(var value=0u;value<4u;value++){atomicStore(&surface_field_store_entries[at+16u+value],surface_field_store_requests[request*16u+12u+value]);}
   atomicStore(&surface_field_store_entries[at+15u],surface_field_store_settings.generation);atomicOr(&surface_field_store_entries[at+14u],1u);atomicAdd(&surface_field_store_counters[3],1u);return;
  }
 }
 atomicAdd(&surface_field_store_counters[4],1u);
}
`;
