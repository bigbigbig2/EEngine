/** Independent field identity/value/certificate ABI. The complete identity
 * prefix contains publication-version proofs, canonical domain and footprint
 * class. The point suffix is an exact input witness. Certified entries may cover
 * another point only after the value AND certificate support tests succeed. */
export const SURFACE_FIELD_STORE_ABI_VERSION = 3;
export const SURFACE_FIELD_STORE_IDENTITY_WORDS = 20;
export const SURFACE_FIELD_STORE_KEY_WORDS = 32;
export const SURFACE_FIELD_STORE_VALUE_WORDS = 4;
export const SURFACE_FIELD_STORE_ENTRY_WORDS = 64;
export const SURFACE_FIELD_STORE_REQUEST_WORDS = SURFACE_FIELD_STORE_ENTRY_WORDS;
export const SURFACE_FIELD_STORE_ENTRY_BYTES = SURFACE_FIELD_STORE_ENTRY_WORDS * 4;
export const SURFACE_FIELD_STORE_WAYS = 4;
export const SURFACE_FIELD_STORE_EMPTY = 0xffffffff;
export const SURFACE_FIELD_STORE_BUDGET_BYTES = 128 * 1024 * 1024;
export const SURFACE_FIELD_STORE_MAX_PROBE = SURFACE_FIELD_STORE_WAYS;
export const SURFACE_FIELD_STORE_VALUE_WORD = 32;
export const SURFACE_FIELD_STORE_BOUNDS_WORD = 36;
export const SURFACE_FIELD_STORE_DOMAIN_WORD = 44;
export const SURFACE_FIELD_STORE_GRADIENT_WORD = 48;
export const SURFACE_FIELD_STORE_FLAGS_WORD = 56;
export const SURFACE_FIELD_STORE_GENERATION_WORD = 57;
export const SURFACE_FIELD_STORE_STATE_WORD = 58;
export const SURFACE_FIELD_STORE_TOUCHED_WORD = 59;
export const SURFACE_FIELD_STORE_STATE = Object.freeze({ empty: 0, reserved: 1, published: 2 });
export const SURFACE_FIELD_STORE_FLAGS = Object.freeze({ value: 1, certificate: 2, certifiedValue: 4, negativeCertificate: 8, boundedValue: 16 });

export interface SurfaceFieldStoreKey {
  readonly producer: number;
  readonly version: number;
  readonly dependencyEpoch: number;
  readonly material: number;
  readonly instance: number;
  readonly instanceGeneration: number;
  readonly geometry: number;
  readonly geometryGeneration: number;
  readonly sourceMeshlet: number;
  readonly sourcePrimitive: number;
  readonly lod: number;
  readonly chart: number;
  readonly side: number;
  readonly scope: number;
  readonly cellX: number;
  readonly cellY: number;
  readonly gradientX: number;
  readonly gradientY: number;
  readonly geometryRevision: number;
  readonly viewRevision: number;
  readonly pointWitness: readonly number[];
}
export interface SurfaceFieldStoreCapacity {
  readonly bytes: number;
  readonly entries: number;
  readonly sets: number;
  readonly segmentBytes: readonly number[];
}
function uint(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) { throw new RangeError("Field identity must be uint32"); }
  return value >>> 0;
}
export function encodeSurfaceFieldStoreKey(key: SurfaceFieldStoreKey): Uint32Array<ArrayBuffer> {
  if (key.pointWitness.length > SURFACE_FIELD_STORE_KEY_WORDS-SURFACE_FIELD_STORE_IDENTITY_WORDS) {
    throw new RangeError("Field point witness exceeds the negotiated key");
  }
  const words=new Uint32Array(SURFACE_FIELD_STORE_KEY_WORDS);
  words.set([key.producer,key.version,key.dependencyEpoch,key.material,key.instance,key.instanceGeneration,key.geometry,
    key.geometryGeneration,key.sourceMeshlet,key.sourcePrimitive,key.lod,key.chart,key.side,key.scope,key.cellX,key.cellY,
    key.gradientX,key.gradientY,key.geometryRevision,key.viewRevision].map(uint));
  words.set(key.pointWitness.map(uint),SURFACE_FIELD_STORE_IDENTITY_WORDS);
  return words;
}
export function planSurfaceFieldStoreCapacity(limits: Pick<GPUSupportedLimits,"maxBufferSize"|"maxStorageBufferBindingSize">,
  budgetBytes=SURFACE_FIELD_STORE_BUDGET_BYTES): SurfaceFieldStoreCapacity {
  const setBytes=SURFACE_FIELD_STORE_ENTRY_BYTES*SURFACE_FIELD_STORE_WAYS;
  const binding=Math.floor(Math.min(Number(limits.maxBufferSize),Number(limits.maxStorageBufferBindingSize))/setBytes)*setBytes;
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes<setBytes || binding<setBytes) {
    throw new RangeError("FieldStore cannot fit one complete four-way set");
  }
  const bytes=Math.floor(budgetBytes/setBytes)*setBytes;
  const segments: number[]=[];
  for(let remaining=bytes;remaining>0;) { const part=Math.min(remaining,binding);segments.push(part);remaining-=part; }
  return Object.freeze({bytes,entries:bytes/SURFACE_FIELD_STORE_ENTRY_BYTES,sets:bytes/setBytes,segmentBytes:Object.freeze(segments)});
}

export const SURFACE_FIELD_STORE_WGSL = /* wgsl */ `
const SURFACE_FIELD_STORE_EMPTY:u32=0xffffffffu;
const SURFACE_FIELD_STORE_IDENTITY_WORDS:u32=${SURFACE_FIELD_STORE_IDENTITY_WORDS}u;
const SURFACE_FIELD_STORE_KEY_WORDS:u32=${SURFACE_FIELD_STORE_KEY_WORDS}u;
const SURFACE_FIELD_STORE_ENTRY_WORDS:u32=${SURFACE_FIELD_STORE_ENTRY_WORDS}u;
const SURFACE_FIELD_STORE_WAYS:u32=${SURFACE_FIELD_STORE_WAYS}u;
const SURFACE_FIELD_STORE_VALUE_WORD:u32=${SURFACE_FIELD_STORE_VALUE_WORD}u;
const SURFACE_FIELD_STORE_BOUNDS_WORD:u32=${SURFACE_FIELD_STORE_BOUNDS_WORD}u;
const SURFACE_FIELD_STORE_DOMAIN_WORD:u32=${SURFACE_FIELD_STORE_DOMAIN_WORD}u;
const SURFACE_FIELD_STORE_GRADIENT_WORD:u32=${SURFACE_FIELD_STORE_GRADIENT_WORD}u;
const SURFACE_FIELD_STORE_FLAGS_WORD:u32=${SURFACE_FIELD_STORE_FLAGS_WORD}u;
const SURFACE_FIELD_STORE_GENERATION_WORD:u32=${SURFACE_FIELD_STORE_GENERATION_WORD}u;
const SURFACE_FIELD_STORE_STATE_WORD:u32=${SURFACE_FIELD_STORE_STATE_WORD}u;
const SURFACE_FIELD_STORE_TOUCHED_WORD:u32=${SURFACE_FIELD_STORE_TOUCHED_WORD}u;
const SURFACE_FIELD_STORE_PUBLISHED:u32=2u;
const SURFACE_FIELD_VALUE_VALID:u32=${SURFACE_FIELD_STORE_FLAGS.value}u;
const SURFACE_FIELD_CERTIFICATE_VALID:u32=${SURFACE_FIELD_STORE_FLAGS.certificate}u;
const SURFACE_FIELD_CERTIFIED_VALUE:u32=${SURFACE_FIELD_STORE_FLAGS.certifiedValue}u;
const SURFACE_FIELD_NEGATIVE_CERTIFICATE:u32=${SURFACE_FIELD_STORE_FLAGS.negativeCertificate}u;
fn surface_field_store_hash(key:ptr<storage,array<u32>,read>,at:u32)->u32 {
  var hash=2166136261u;
  let index = array<u32,8>(0u,1u,2u,4u,5u,11u,14u,15u);
  for (var word=0u;word<8u;word++) { hash=(hash^(*key)[at+index[word]])*16777619u; }
  return hash;
}
fn surface_field_store_equal(store:ptr<storage,array<u32>,read>,entry:u32,key:ptr<storage,array<u32>,read>,at:u32)->bool {
  let base=entry*SURFACE_FIELD_STORE_ENTRY_WORDS;
  for(var word=0u;word<SURFACE_FIELD_STORE_KEY_WORDS;word++) { if (*store)[base+word]!=(*key)[at+word] { return false; } }
  return true;
}
fn surface_field_store_equal_atomic(store:ptr<storage,array<atomic<u32>>,read_write>,entry:u32,key:ptr<storage,array<u32>,read>,at:u32)->bool {
  let base=entry*SURFACE_FIELD_STORE_ENTRY_WORDS;
  for(var word=0u;word<SURFACE_FIELD_STORE_KEY_WORDS;word++) { if atomicLoad(&(*store)[base+word])!=(*key)[at+word] { return false; } }
  return true;
}
fn surface_field_store_entry(cache_set:u32,way:u32)->u32 { return cache_set*SURFACE_FIELD_STORE_WAYS+way; }
`;

export const SURFACE_FIELD_STORE_COMPUTE_WGSL = /* wgsl */ `
${SURFACE_FIELD_STORE_WGSL}
struct SurfaceFieldStoreSettings { request_count:u32, entry_count:u32, generation:u32, epoch:u32, }
@group(0) @binding(0) var<uniform> surface_field_store_settings:SurfaceFieldStoreSettings;
@group(0) @binding(1) var<storage,read> surface_field_store_requests:array<u32>;
@group(0) @binding(2) var<storage,read_write> surface_field_store_entries:array<atomic<u32>>;
@group(0) @binding(3) var<storage,read_write> surface_field_store_results:array<u32>;
@group(0) @binding(4) var<storage,read_write> surface_field_store_counters:array<atomic<u32>>;
fn field_store_support(base:u32,request:u32)->bool {
  let at=request*SURFACE_FIELD_STORE_ENTRY_WORDS;
  for(var axis=0u;axis<2u;axis++) {
    let low=bitcast<f32>(atomicLoad(&surface_field_store_entries[base+SURFACE_FIELD_STORE_DOMAIN_WORD+axis]));
    let high=bitcast<f32>(atomicLoad(&surface_field_store_entries[base+SURFACE_FIELD_STORE_DOMAIN_WORD+2u+axis]));
    let requested_low=bitcast<f32>(surface_field_store_requests[at+SURFACE_FIELD_STORE_DOMAIN_WORD+axis]);
    let requested_high=bitcast<f32>(surface_field_store_requests[at+SURFACE_FIELD_STORE_DOMAIN_WORD+2u+axis]);
    if !(requested_low>=low && requested_high<=high) { return false; }
  }
  for(var component=0u;component<4u;component++) {
    let low=bitcast<f32>(atomicLoad(&surface_field_store_entries[base+SURFACE_FIELD_STORE_GRADIENT_WORD+component]));
    let high=bitcast<f32>(atomicLoad(&surface_field_store_entries[base+SURFACE_FIELD_STORE_GRADIENT_WORD+4u+component]));
    let requested_low=bitcast<f32>(surface_field_store_requests[at+SURFACE_FIELD_STORE_GRADIENT_WORD+component]);
    let requested_high=bitcast<f32>(surface_field_store_requests[at+SURFACE_FIELD_STORE_GRADIENT_WORD+4u+component]);
    if !(requested_low>=low && requested_high<=high) { return false; }
  }
  return true;
}
fn field_store_probe(request:u32)->u32 {
  let request_at=request*SURFACE_FIELD_STORE_ENTRY_WORDS;
  let hash=surface_field_store_hash(&surface_field_store_requests,request_at);
  let cache_set=hash%(surface_field_store_settings.entry_count/SURFACE_FIELD_STORE_WAYS);
  for(var way=0u;way<SURFACE_FIELD_STORE_WAYS;way++) {
    let entry=surface_field_store_entry(cache_set,way);
    let base=entry*SURFACE_FIELD_STORE_ENTRY_WORDS;
    if atomicLoad(&surface_field_store_entries[base+SURFACE_FIELD_STORE_STATE_WORD])!=SURFACE_FIELD_STORE_PUBLISHED { continue; }
    var identity=true;
    for(var word=0u;word<SURFACE_FIELD_STORE_IDENTITY_WORDS;word++) {
      if atomicLoad(&surface_field_store_entries[base+word])!=surface_field_store_requests[request_at+word] { identity=false; break; }
    }
    if !identity { continue; }
    let flags=atomicLoad(&surface_field_store_entries[base+SURFACE_FIELD_STORE_FLAGS_WORD]);
    let exact=surface_field_store_equal_atomic(&surface_field_store_entries,entry,&surface_field_store_requests,request_at);
    if (flags&SURFACE_FIELD_VALUE_VALID)!=0u && (exact || ((flags&SURFACE_FIELD_CERTIFIED_VALUE)!=0u && field_store_support(base,request))) {
      return entry;
    }
  }
  return SURFACE_FIELD_STORE_EMPTY;
}
@compute @workgroup_size(64)
fn surface_field_store_lookup(@builtin(global_invocation_id) id:vec3u) {
  let request=id.x;
  if request>=surface_field_store_settings.request_count { return; }
  let result=request*4u;
  surface_field_store_results[result]=SURFACE_FIELD_STORE_EMPTY;
  surface_field_store_results[result+1u]=0u;
  surface_field_store_results[result+2u]=0u;
  surface_field_store_results[result+3u]=0u;
  atomicAdd(&surface_field_store_counters[0u],1u);
  let hit=field_store_probe(request);
  if hit==SURFACE_FIELD_STORE_EMPTY { atomicAdd(&surface_field_store_counters[2u],1u);return; }
  let base=hit*SURFACE_FIELD_STORE_ENTRY_WORDS;
  atomicMax(&surface_field_store_entries[base+SURFACE_FIELD_STORE_TOUCHED_WORD],surface_field_store_settings.epoch);
  let flags=atomicLoad(&surface_field_store_entries[base+SURFACE_FIELD_STORE_FLAGS_WORD]);
  surface_field_store_results[result]=hit;
  surface_field_store_results[result+1u]=atomicLoad(&surface_field_store_entries[base+SURFACE_FIELD_STORE_GENERATION_WORD]);
  surface_field_store_results[result+2u]=flags;
  surface_field_store_results[result+3u]=select(0u,flags&(SURFACE_FIELD_CERTIFICATE_VALID|SURFACE_FIELD_NEGATIVE_CERTIFICATE),field_store_support(base,request));
  atomicAdd(&surface_field_store_counters[1u],1u);
}
@compute @workgroup_size(64)
fn surface_field_store_reset(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=surface_field_store_settings.entry_count { return; }
  let base=id.x*SURFACE_FIELD_STORE_ENTRY_WORDS;
  for(var word=0u;word<SURFACE_FIELD_STORE_ENTRY_WORDS;word++) { atomicStore(&surface_field_store_entries[base+word],0u); }
}
@compute @workgroup_size(64)
fn surface_field_store_publish(@builtin(global_invocation_id) id:vec3u) {
  let request=id.x;
  if request>=surface_field_store_settings.request_count { return; }
  let at=request*SURFACE_FIELD_STORE_ENTRY_WORDS;
  surface_field_store_results[request*4u]=SURFACE_FIELD_STORE_EMPTY;
  let valid=surface_field_store_requests[at]!=0u && surface_field_store_requests[at]!=SURFACE_FIELD_STORE_EMPTY &&
    surface_field_store_requests[at+2u]!=SURFACE_FIELD_STORE_EMPTY && (surface_field_store_requests[at+SURFACE_FIELD_STORE_FLAGS_WORD]&SURFACE_FIELD_VALUE_VALID)!=0u;
  if !valid { return; }
  for(var component=0u;component<4u;component++) {
    let value=bitcast<f32>(surface_field_store_requests[at+SURFACE_FIELD_STORE_VALUE_WORD+component]);
    if value!=value || abs(value)>3.402823466e38 { atomicAdd(&surface_field_store_counters[5u],1u);return; }
  }
  let hash=surface_field_store_hash(&surface_field_store_requests,at);
  let cache_set=hash%(surface_field_store_settings.entry_count/SURFACE_FIELD_STORE_WAYS);
  for(var way=0u;way<SURFACE_FIELD_STORE_WAYS;way++) {
    let entry=surface_field_store_entry(cache_set,way);
    let base=entry*SURFACE_FIELD_STORE_ENTRY_WORDS;
    let state=atomicLoad(&surface_field_store_entries[base+SURFACE_FIELD_STORE_STATE_WORD]);
    if state==1u || (state==2u && atomicLoad(&surface_field_store_entries[base+SURFACE_FIELD_STORE_TOUCHED_WORD])>=surface_field_store_settings.epoch) { continue; }
    let generation=atomicLoad(&surface_field_store_entries[base+SURFACE_FIELD_STORE_GENERATION_WORD]);
    if generation>=0xfffffffeu { continue; }
    var owns=false;
    for(var attempt=0u;attempt<4u;attempt++) {
      let claim=atomicCompareExchangeWeak(&surface_field_store_entries[base+SURFACE_FIELD_STORE_STATE_WORD],state,1u);
      if claim.exchanged { owns=true;break; }
      if claim.old_value!=state { break; }
    }
    if !owns { continue; }
    for(var word=0u;word<SURFACE_FIELD_STORE_GENERATION_WORD;word++) { atomicStore(&surface_field_store_entries[base+word],surface_field_store_requests[at+word]); }
    atomicStore(&surface_field_store_entries[base+SURFACE_FIELD_STORE_GENERATION_WORD],generation+1u);
    atomicStore(&surface_field_store_entries[base+SURFACE_FIELD_STORE_TOUCHED_WORD],surface_field_store_settings.epoch);
    surface_field_store_results[request*4u]=entry;
    atomicAdd(&surface_field_store_counters[3u],1u);
    return;
  }
  atomicAdd(&surface_field_store_counters[4u],1u);
}
@compute @workgroup_size(64)
fn surface_field_store_commit(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=surface_field_store_settings.request_count { return; }
  let entry=surface_field_store_results[id.x*4u];
  if entry==SURFACE_FIELD_STORE_EMPTY { return; }
  atomicStore(&surface_field_store_entries[entry*SURFACE_FIELD_STORE_ENTRY_WORDS+SURFACE_FIELD_STORE_STATE_WORD],SURFACE_FIELD_STORE_PUBLISHED);
}
`;
