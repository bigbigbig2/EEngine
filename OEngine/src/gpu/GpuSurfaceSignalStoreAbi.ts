/** Sparse signal history ABI. TemporalFacts remains the authoritative full-rate
 * motion/identity producer; this key only identifies a signal result and its
 * validity domain. Hashes select bounded sets and never prove equality. */
export const SURFACE_SIGNAL_STORE_BUDGET_BYTES=64*1024*1024;
export const SURFACE_SIGNAL_STORE_KEY_WORDS=10;
export const SURFACE_SIGNAL_STORE_PRIMARY_WORDS=8; // 16-bit packet + metadata
export const SURFACE_SIGNAL_STORE_SPILL_WORDS=16; // key, packet/spill value and management metadata
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
export const SURFACE_SIGNAL_STORE_COMPUTE_WGSL=/* wgsl */ `
${SURFACE_SIGNAL_STORE_WGSL}
struct SurfaceSignalStoreSettings { request_count:u32, entry_count:u32, generation:u32, reserved:u32 }
@group(0) @binding(0) var<uniform> surface_signal_store_settings:SurfaceSignalStoreSettings;
@group(0) @binding(1) var<storage,read> surface_signal_store_requests:array<u32>;
@group(0) @binding(2) var<storage,read_write> surface_signal_store_entries:array<atomic<u32>>;
@group(0) @binding(3) var<storage,read_write> surface_signal_store_results:array<u32>;
@group(0) @binding(4) var<storage,read_write> surface_signal_store_counters:array<atomic<u32>>;
const SURFACE_SIGNAL_STORE_EMPTY:u32=0xffffffffu;
fn signal_entry(set_index:u32,way:u32)->u32{return set_index*${SURFACE_SIGNAL_STORE_WAYS}u+way;}
fn signal_probe(request:u32)->u32{
 let hash=surface_signal_hash(&surface_signal_store_requests,request*16u);
 let set_index=hash%(surface_signal_store_settings.entry_count/${SURFACE_SIGNAL_STORE_WAYS}u);
 for(var way=0u;way<${SURFACE_SIGNAL_STORE_WAYS}u;way++){
  let entry=signal_entry(set_index,way);let at=entry*${SURFACE_SIGNAL_STORE_SPILL_WORDS}u;
  var equal=true;for(var word=0u;word<${SURFACE_SIGNAL_STORE_KEY_WORDS}u;word++){if atomicLoad(&surface_signal_store_entries[at+word])!=surface_signal_store_requests[request*16u+word]{equal=false;break;}}
  if(equal && (atomicLoad(&surface_signal_store_entries[at+12u])&${1}u)!=0u){return entry;}
 }
 return SURFACE_SIGNAL_STORE_EMPTY;
}
@compute @workgroup_size(64) fn surface_signal_store_reset(@builtin(global_invocation_id) id:vec3u){
 let entry=id.x;if(entry>=surface_signal_store_settings.entry_count){return;}let at=entry*${SURFACE_SIGNAL_STORE_SPILL_WORDS}u;
 for(var word=0u;word<${SURFACE_SIGNAL_STORE_SPILL_WORDS}u;word++){atomicStore(&surface_signal_store_entries[at+word],select(0u,SURFACE_SIGNAL_STORE_EMPTY,word==0u));}
}
@compute @workgroup_size(64) fn surface_signal_store_lookup(@builtin(global_invocation_id) id:vec3u){
 let request=id.x;if(request>=surface_signal_store_settings.request_count){return;}atomicAdd(&surface_signal_store_counters[0],1u);
 let hit=signal_probe(request);let result=request*6u;
 if(hit==SURFACE_SIGNAL_STORE_EMPTY){surface_signal_store_results[result]=SURFACE_SIGNAL_STORE_EMPTY;atomicAdd(&surface_signal_store_counters[2],1u);return;}
 surface_signal_store_results[result]=hit;surface_signal_store_results[result+1u]=atomicLoad(&surface_signal_store_entries[hit*${SURFACE_SIGNAL_STORE_SPILL_WORDS}u+10u]);surface_signal_store_results[result+2u]=atomicLoad(&surface_signal_store_entries[hit*${SURFACE_SIGNAL_STORE_SPILL_WORDS}u+11u]);surface_signal_store_results[result+3u]=atomicLoad(&surface_signal_store_entries[hit*${SURFACE_SIGNAL_STORE_SPILL_WORDS}u+12u]);surface_signal_store_results[result+4u]=atomicLoad(&surface_signal_store_entries[hit*${SURFACE_SIGNAL_STORE_SPILL_WORDS}u+13u]);surface_signal_store_results[result+5u]=atomicLoad(&surface_signal_store_entries[hit*${SURFACE_SIGNAL_STORE_SPILL_WORDS}u+14u]);atomicAdd(&surface_signal_store_counters[1],1u);
}
@compute @workgroup_size(64) fn surface_signal_store_publish(@builtin(global_invocation_id) id:vec3u){
 let request=id.x;if(request>=surface_signal_store_settings.request_count){return;}if(surface_signal_store_requests[request*16u]==SURFACE_SIGNAL_STORE_EMPTY){return;}let hash=surface_signal_hash(&surface_signal_store_requests,request*16u);let set_index=hash%(surface_signal_store_settings.entry_count/${SURFACE_SIGNAL_STORE_WAYS}u);
 for(var way=0u;way<${SURFACE_SIGNAL_STORE_WAYS}u;way++){let entry=signal_entry(set_index,way);let at=entry*${SURFACE_SIGNAL_STORE_SPILL_WORDS}u;let old=atomicCompareExchangeWeak(&surface_signal_store_entries[at],SURFACE_SIGNAL_STORE_EMPTY,surface_signal_store_requests[request*16u]);
  if(old.exchanged||old.old_value==surface_signal_store_requests[request*16u]){for(var word=1u;word<${SURFACE_SIGNAL_STORE_KEY_WORDS}u;word++){atomicStore(&surface_signal_store_entries[at+word],surface_signal_store_requests[request*16u+word]);}atomicStore(&surface_signal_store_entries[at+10u],surface_signal_store_requests[request*16u+10u]);atomicStore(&surface_signal_store_entries[at+11u],surface_signal_store_requests[request*16u+11u]);atomicStore(&surface_signal_store_entries[at+12u],${1}u);atomicStore(&surface_signal_store_entries[at+13u],surface_signal_store_settings.generation);atomicStore(&surface_signal_store_entries[at+14u],0u);atomicStore(&surface_signal_store_entries[at+15u],0u);atomicAdd(&surface_signal_store_counters[3],1u);return;}
 }
 atomicAdd(&surface_signal_store_counters[4],1u);
}
`;
