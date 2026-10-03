/** Sparse signal history ABI. TemporalFacts remains the authoritative full-rate
 * motion/identity producer; this key identifies one signal result and its
 * complete validity domain. Hashes select bounded sets and never prove equality. */
export const SURFACE_SIGNAL_STORE_BUDGET_BYTES = 64 * 1024 * 1024;
export const SURFACE_SIGNAL_STORE_KEY_WORDS = 10;
export const SURFACE_SIGNAL_STORE_PAYLOAD_WORDS = 4;
export const SURFACE_SIGNAL_STORE_ENTRY_WORDS = 20;
export const SURFACE_SIGNAL_STORE_REQUEST_WORDS = SURFACE_SIGNAL_STORE_ENTRY_WORDS;
export const SURFACE_SIGNAL_STORE_WAYS = 4;
export const SURFACE_SIGNAL_STORE_ENTRY_BYTES = SURFACE_SIGNAL_STORE_ENTRY_WORDS * 4;
export const SURFACE_SIGNAL_STORE_PAYLOAD_WORD = SURFACE_SIGNAL_STORE_KEY_WORDS;
export const SURFACE_SIGNAL_STORE_FLAGS_WORD = SURFACE_SIGNAL_STORE_PAYLOAD_WORD + SURFACE_SIGNAL_STORE_PAYLOAD_WORDS;
export const SURFACE_SIGNAL_STORE_GENERATION_WORD = SURFACE_SIGNAL_STORE_FLAGS_WORD + 1;
export const SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD = SURFACE_SIGNAL_STORE_GENERATION_WORD + 1;
export const SURFACE_SIGNAL_STORE_TOUCHED_GENERATION_WORD = SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD + 1;

// Compatibility name retained for the capacity contract; the physical entry now
// includes both the default packet and the bounded 16-byte precision spill slot.
export const SURFACE_SIGNAL_STORE_SPILL_WORDS = SURFACE_SIGNAL_STORE_ENTRY_WORDS;
export const SURFACE_SIGNAL_STORE_PRIMARY_WORDS = 8;
export const SURFACE_SIGNAL_STORE_KIND = Object.freeze({
  directDiffuse: 0,
  environmentDiffuse: 1,
  directSpecular: 2,
  environmentSpecular: 3,
  directCoat: 4,
  environmentCoat: 5
});
export const SURFACE_SIGNAL_STORE_FLAG = Object.freeze({
  valid: 1,
  owner: 2,
  spill: 4,
  pinned: 8,
  temporal: 16
});

export interface SurfaceSignalStoreKey {
  readonly surfaceDomain: number;
  readonly cell: number;
  readonly signal: number;
  readonly geometryGeneration: number;
  readonly materialGeneration: number;
  readonly lightRevision: number;
  readonly environmentRevision: number;
  readonly shadowRevision: number;
  readonly aoRevision: number;
  readonly footprint: number;
}

export function encodeSurfaceSignalStoreKey(key: SurfaceSignalStoreKey): Uint32Array<ArrayBuffer> {
  return Uint32Array.from(Object.values(key).map((value, index) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`Signal key word ${index} is invalid`);
    }
    return value >>> 0;
  }));
}

export function planSurfaceSignalStoreCapacity(
  limits: Pick<GPUSupportedLimits, "maxBufferSize" | "maxStorageBufferBindingSize">,
  budgetBytes = SURFACE_SIGNAL_STORE_BUDGET_BYTES
) {
  const binding = Math.floor(Math.min(Number(limits.maxBufferSize), Number(limits.maxStorageBufferBindingSize)) / 256) * 256;
  const bytes = Math.floor(budgetBytes / (SURFACE_SIGNAL_STORE_ENTRY_BYTES * SURFACE_SIGNAL_STORE_WAYS)) *
    SURFACE_SIGNAL_STORE_ENTRY_BYTES * SURFACE_SIGNAL_STORE_WAYS;
  if (bytes < SURFACE_SIGNAL_STORE_ENTRY_BYTES * SURFACE_SIGNAL_STORE_WAYS) {
    throw new RangeError("SignalStore cannot fit one four-way set");
  }
  const segmentLimit = Math.floor(binding / SURFACE_SIGNAL_STORE_ENTRY_BYTES) * SURFACE_SIGNAL_STORE_ENTRY_BYTES;
  if (segmentLimit < SURFACE_SIGNAL_STORE_ENTRY_BYTES) {
    throw new RangeError("SignalStore binding cannot fit one entry");
  }
  const segments: number[] = [];
  for (let remaining = bytes; remaining > 0;) {
    const part = Math.min(remaining, segmentLimit);
    segments.push(part);
    remaining -= part;
  }
  return Object.freeze({
    bytes,
    entries: bytes / SURFACE_SIGNAL_STORE_ENTRY_BYTES,
    sets: bytes / (SURFACE_SIGNAL_STORE_ENTRY_BYTES * SURFACE_SIGNAL_STORE_WAYS),
    segmentBytes: Object.freeze(segments)
  });
}

export const SURFACE_SIGNAL_STORE_WGSL = /* wgsl */ `
const SURFACE_SIGNAL_STORE_KEY_WORDS:u32 = ${SURFACE_SIGNAL_STORE_KEY_WORDS}u;
const SURFACE_SIGNAL_STORE_ENTRY_WORDS:u32 = ${SURFACE_SIGNAL_STORE_ENTRY_WORDS}u;
const SURFACE_SIGNAL_STORE_REQUEST_WORDS:u32 = ${SURFACE_SIGNAL_STORE_REQUEST_WORDS}u;
const SURFACE_SIGNAL_STORE_WAYS:u32 = ${SURFACE_SIGNAL_STORE_WAYS}u;
const SURFACE_SIGNAL_STORE_FLAGS_WORD:u32 = ${SURFACE_SIGNAL_STORE_FLAGS_WORD}u;
const SURFACE_SIGNAL_STORE_GENERATION_WORD:u32 = ${SURFACE_SIGNAL_STORE_GENERATION_WORD}u;
const SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD:u32 = ${SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD}u;
const SURFACE_SIGNAL_STORE_TOUCHED_GENERATION_WORD:u32 = ${SURFACE_SIGNAL_STORE_TOUCHED_GENERATION_WORD}u;
const SURFACE_SIGNAL_STORE_EMPTY:u32 = 0xffffffffu;
const SURFACE_SIGNAL_STORE_VALID:u32 = ${SURFACE_SIGNAL_STORE_FLAG.valid}u;

fn surface_signal_hash(key:ptr<storage,array<u32>,read>, at:u32)->u32 {
  var hash = 2166136261u;
  for (var word = 0u; word < SURFACE_SIGNAL_STORE_KEY_WORDS; word++) {
    hash = (hash ^ (*key)[at + word]) * 16777619u;
  }
  return hash;
}

fn surface_signal_equal(store:ptr<storage,array<u32>,read>, entry:u32,
  key:ptr<storage,array<u32>,read>, at:u32)->bool {
  let base = entry * SURFACE_SIGNAL_STORE_ENTRY_WORDS;
  for (var word = 0u; word < SURFACE_SIGNAL_STORE_KEY_WORDS; word++) {
    if ((*store)[base + word] != (*key)[at + word]) {
      return false;
    }
  }
  return true;
}
`;

export const SURFACE_SIGNAL_STORE_COMPUTE_WGSL = /* wgsl */ `
${SURFACE_SIGNAL_STORE_WGSL}
struct SurfaceSignalStoreSettings {
  request_count:u32,
  entry_count:u32,
  generation:u32,
  reserved:u32,
}
@group(0) @binding(0) var<uniform> surface_signal_store_settings:SurfaceSignalStoreSettings;
@group(0) @binding(1) var<storage,read> surface_signal_store_requests:array<u32>;
@group(0) @binding(2) var<storage,read_write> surface_signal_store_entries:array<atomic<u32>>;
@group(0) @binding(3) var<storage,read_write> surface_signal_store_results:array<u32>;
@group(0) @binding(4) var<storage,read_write> surface_signal_store_counters:array<atomic<u32>>;

fn signal_entry(set_index:u32, way:u32)->u32 {
  return set_index * SURFACE_SIGNAL_STORE_WAYS + way;
}

fn signal_probe(request:u32)->u32 {
  let request_at = request * SURFACE_SIGNAL_STORE_REQUEST_WORDS;
  let hash = surface_signal_hash(&surface_signal_store_requests, request_at);
  let set_index = hash % (surface_signal_store_settings.entry_count / SURFACE_SIGNAL_STORE_WAYS);
  for (var way = 0u; way < SURFACE_SIGNAL_STORE_WAYS; way++) {
    let entry = signal_entry(set_index, way);
    let at = entry * SURFACE_SIGNAL_STORE_ENTRY_WORDS;
    var equal = true;
    for (var word = 0u; word < SURFACE_SIGNAL_STORE_KEY_WORDS; word++) {
      if (atomicLoad(&surface_signal_store_entries[at + word]) != surface_signal_store_requests[request_at + word]) {
        equal = false;
        break;
      }
    }
    if (equal && (atomicLoad(&surface_signal_store_entries[at + SURFACE_SIGNAL_STORE_FLAGS_WORD]) & SURFACE_SIGNAL_STORE_VALID) != 0u) {
      return entry;
    }
  }
  return SURFACE_SIGNAL_STORE_EMPTY;
}

fn touch_signal_entry(entry:u32) {
  let at = entry * SURFACE_SIGNAL_STORE_ENTRY_WORDS;
  let prior = atomicCompareExchangeWeak(
    &surface_signal_store_entries[at + SURFACE_SIGNAL_STORE_TOUCHED_GENERATION_WORD],
    surface_signal_store_settings.generation,
    surface_signal_store_settings.generation);
  if (prior.exchanged || prior.old_value == surface_signal_store_settings.generation) {
    return;
  }
  let packed = atomicLoad(&surface_signal_store_entries[at + SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD]);
  let age = min(packed & 0xffffu, 0xfffeu) + 1u;
  let confidence = packed >> 16u;
  let decayed = select(confidence, confidence - 1024u, confidence > 1024u);
  atomicStore(&surface_signal_store_entries[at + SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD], (decayed << 16u) | age);
}

@compute @workgroup_size(64)
fn surface_signal_store_reset(@builtin(global_invocation_id) id:vec3u) {
  let entry = id.x;
  if (entry >= surface_signal_store_settings.entry_count) {
    return;
  }
  let at = entry * SURFACE_SIGNAL_STORE_ENTRY_WORDS;
  for (var word = 0u; word < SURFACE_SIGNAL_STORE_ENTRY_WORDS; word++) {
    atomicStore(&surface_signal_store_entries[at + word], select(0u, SURFACE_SIGNAL_STORE_EMPTY, word == 0u));
  }
}

@compute @workgroup_size(64)
fn surface_signal_store_lookup(@builtin(global_invocation_id) id:vec3u) {
  let request = id.x;
  if (request >= surface_signal_store_settings.request_count) {
    return;
  }
  atomicAdd(&surface_signal_store_counters[0], 1u);
  let hit = signal_probe(request);
  let result = request * 8u;
  if (hit == SURFACE_SIGNAL_STORE_EMPTY) {
    surface_signal_store_results[result] = SURFACE_SIGNAL_STORE_EMPTY;
    atomicAdd(&surface_signal_store_counters[2], 1u);
    return;
  }
  touch_signal_entry(hit);
  let at = hit * SURFACE_SIGNAL_STORE_ENTRY_WORDS;
  surface_signal_store_results[result] = hit;
  for (var word = 0u; word < 4u; word++) {
    surface_signal_store_results[result + 1u + word] = atomicLoad(&surface_signal_store_entries[at + 10u + word]);
  }
  surface_signal_store_results[result + 5u] = atomicLoad(&surface_signal_store_entries[at + SURFACE_SIGNAL_STORE_FLAGS_WORD]);
  surface_signal_store_results[result + 6u] = atomicLoad(&surface_signal_store_entries[at + SURFACE_SIGNAL_STORE_GENERATION_WORD]);
  surface_signal_store_results[result + 7u] = atomicLoad(&surface_signal_store_entries[at + SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD]);
  atomicAdd(&surface_signal_store_counters[1], 1u);
}

@compute @workgroup_size(64)
fn surface_signal_store_publish(@builtin(global_invocation_id) id:vec3u) {
  let request = id.x;
  if (request >= surface_signal_store_settings.request_count) {
    return;
  }
  let request_at = request * SURFACE_SIGNAL_STORE_REQUEST_WORDS;
  if (surface_signal_store_requests[request_at] == SURFACE_SIGNAL_STORE_EMPTY) {
    return;
  }
  let hash = surface_signal_hash(&surface_signal_store_requests, request_at);
  let set_index = hash % (surface_signal_store_settings.entry_count / SURFACE_SIGNAL_STORE_WAYS);
  for (var way = 0u; way < SURFACE_SIGNAL_STORE_WAYS; way++) {
    let entry = signal_entry(set_index, way);
    let at = entry * SURFACE_SIGNAL_STORE_ENTRY_WORDS;
    let old = atomicCompareExchangeWeak(
      &surface_signal_store_entries[at], SURFACE_SIGNAL_STORE_EMPTY, surface_signal_store_requests[request_at]);
    if (old.exchanged || old.old_value == surface_signal_store_requests[request_at]) {
      for (var word = 1u; word < SURFACE_SIGNAL_STORE_KEY_WORDS; word++) {
        atomicStore(&surface_signal_store_entries[at + word], surface_signal_store_requests[request_at + word]);
      }
      for (var word = 0u; word < 4u; word++) {
        atomicStore(&surface_signal_store_entries[at + 10u + word], surface_signal_store_requests[request_at + 10u + word]);
      }
      atomicStore(&surface_signal_store_entries[at + SURFACE_SIGNAL_STORE_FLAGS_WORD], surface_signal_store_requests[request_at + SURFACE_SIGNAL_STORE_FLAGS_WORD]);
      atomicStore(&surface_signal_store_entries[at + SURFACE_SIGNAL_STORE_GENERATION_WORD], surface_signal_store_settings.generation);
      atomicStore(&surface_signal_store_entries[at + SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD], 0xffff0000u);
      atomicStore(&surface_signal_store_entries[at + SURFACE_SIGNAL_STORE_TOUCHED_GENERATION_WORD], surface_signal_store_settings.generation);
      atomicStore(&surface_signal_store_entries[at + 18u], 0u);
      atomicStore(&surface_signal_store_entries[at + 19u], 0u);
      atomicAdd(&surface_signal_store_counters[3], 1u);
      return;
    }
  }
  atomicAdd(&surface_signal_store_counters[4], 1u);
}
`;
