import { SURFACE_SIGNAL_REQUEST_WGSL } from "./surface_signal_request.js";
import { SURFACE_SIGNAL_STORE_ENTRY_WORDS, SURFACE_SIGNAL_STORE_STATE_WORD, SURFACE_SIGNAL_STORE_GENERATION_WORD,
  SURFACE_SIGNAL_STORE_TOUCHED_GENERATION_WORD, SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD } from "../gpu/GpuSurfaceSignalStoreAbi.js";

/** Value-only signal hits do not authorize a stale rate plan. The current
 * classifier still composes Geometry/Field certificates for sharing. Every hit
 * publishes a separate SignalRef and bypasses its subsequent dirty worker. */
export const SURFACE_SIGNAL_LOOKUP_WGSL = /* wgsl */ `
struct SignalRequestSettings {
  identities:u32, constants:u32, leaves:u32, store_entries:u32,
  epoch:u32, view_revision:u32, environment_revision:u32, light_revision:u32,
  shadow_revision:u32, sun_revision:u32, shadow_enabled:u32, sun_enabled:u32,
  store_enabled:u32, diagnostics:u32, reserved0:u32, reserved1:u32,
}
@group(0) @binding(0) var<uniform> signal_request_settings:SignalRequestSettings;
@group(0) @binding(1) var<storage,read_write> signal_request_workspace:SurfaceCellWorkspace;
@group(0) @binding(2) var<storage,read> signal_request_metadata:array<u32>;
@group(0) @binding(3) var<storage,read> signal_request_versions:array<u32>;
@group(0) @binding(4) var<storage,read_write> signal_lookup_store:array<atomic<u32>>;
@group(0) @binding(5) var<uniform> signal_request_sun:array<vec4u,3>;
@group(0) @binding(6) var<storage,read> signal_request_shadow:array<u32>;
${SURFACE_SIGNAL_REQUEST_WGSL}
fn signal_lookup_equal(base:u32,leaf:u32,kind:u32,fields:u32)->bool {
  for(var word=0u;word<SIGNAL_REQUEST_KEY_WORDS;word++) {
    if atomicLoad(&signal_lookup_store[base+word])!=signal_request_word(leaf,kind,word,fields) { return false; }
  }
  return true;
}
fn signal_lookup_touch(base:u32) {
  let epoch=signal_request_settings.epoch;
  let previous=atomicMax(&signal_lookup_store[base+${SURFACE_SIGNAL_STORE_TOUCHED_GENERATION_WORD}u],epoch);
  if previous>=epoch { return; }
  // atomicMax returns the unique prior epoch to one invocation. The publication
  // payload stays immutable; at most one age/confidence writer exists per frame.
  let packed=atomicLoad(&signal_lookup_store[base+${SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD}u]);
  let age=min(packed&0xffffu,0xfffeu)+1u;
  let confidence=packed>>16u;
  let decayed=select(confidence,confidence-1024u,confidence>1024u);
  atomicStore(&signal_lookup_store[base+${SURFACE_SIGNAL_STORE_AGE_CONFIDENCE_WORD}u],(decayed<<16u)|age);
}
@compute @workgroup_size(64)
fn lookup_surface_signals(@builtin(global_invocation_id) id:vec3u) {
  let leaf=id.x;
  if leaf>=signal_request_settings.leaves { return; }
  let enabled=signal_request_enabled(leaf);
  var dirty=0u;
  var hits=0u;
  for(var kind=0u;kind<6u;kind++) {
    let reference=(leaf*6u+kind)*3u;
    if (enabled&(1u<<kind))==0u { continue; }
    signal_request_workspace.signal_references[reference]=SURFACE_REFERENCE_INVALID;
    dirty|=1u<<kind;
    let fields=signal_request_fields(leaf,kind);
    if signal_request_settings.store_enabled==0u || !signal_request_cacheable(leaf,fields,kind) { continue; }
    let cache_set=signal_request_hash(leaf,kind,fields)%(signal_request_settings.store_entries/4u);
    for(var way=0u;way<4u;way++) {
      let entry=cache_set*4u+way;
      let base=entry*${SURFACE_SIGNAL_STORE_ENTRY_WORDS}u;
      if atomicLoad(&signal_lookup_store[base+${SURFACE_SIGNAL_STORE_STATE_WORD}u])!=2u { continue; }
      if !signal_lookup_equal(base,leaf,kind,fields) { continue; }
      signal_lookup_touch(base);
      signal_request_workspace.signal_references[reference]=SURFACE_REFERENCE_STORE;
      signal_request_workspace.signal_references[reference+1u]=entry;
      signal_request_workspace.signal_references[reference+2u]=atomicLoad(&signal_lookup_store[base+${SURFACE_SIGNAL_STORE_GENERATION_WORD}u]);
      dirty&=~(1u<<kind);
      hits++;
      break;
    }
  }
  signal_request_workspace.demands[leaf*4u+2u]=dirty;
  if signal_request_settings.diagnostics!=0u {
    atomicAdd(&signal_request_workspace.counters[117u],hits);
    atomicAdd(&signal_request_workspace.counters[118u],countOneBits(dirty));
  }
}
`;
