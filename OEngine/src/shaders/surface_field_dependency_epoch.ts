import { SURFACE_FIELD_IDENTITY_WORDS, SURFACE_FIELD_DEPENDENCY_HEADER_WORDS,
  SURFACE_FIELD_DEPENDENCY_ENTRY_WORDS, SURFACE_FIELD_DEPENDENCY_WAYS,
  SURFACE_FIELD_MAX_TEXTURE_DEPENDENCIES } from "../gpu/GpuSurfaceFieldIdentityAbi.js";

/** Exact per-field publication proof. Hash chooses a four-way set only. Snapshot
 * writers publish in a subsequent dispatch; output is an immutable version ID,
 * not a pointer into a possibly retired snapshot. No global wait or CPU feedback. */
export const SURFACE_FIELD_DEPENDENCY_EPOCH_WGSL = /* wgsl */ `
struct FieldDependencySettings {
  fields:u32, identities:u32, dependencies:u32, epoch:u32,
  sets:u32, store_enabled:u32, reserved0:u32, reserved1:u32,
}
@group(0) @binding(0) var<uniform> dependency_settings:FieldDependencySettings;
@group(0) @binding(1) var<storage,read_write> dependency_metadata:array<u32>;
@group(0) @binding(2) var<storage,read> dependency_versions:array<u32>;
@group(0) @binding(3) var<storage,read_write> dependency_cache:array<atomic<u32>>;
@group(0) @binding(4) var<storage,read_write> dependency_owners:array<u32>;
const FIELD_DEPENDENCY_UNKNOWN:u32=0xffffffffu;
fn field_dependency_at(field:u32)->u32 { return dependency_settings.identities+field*${SURFACE_FIELD_IDENTITY_WORDS}u; }
fn field_dependency_current(at:u32,index:u32)->u32 {
  let slot=dependency_metadata[dependency_settings.dependencies+dependency_metadata[at+4u]+index];
  if slot==0u || slot>=arrayLength(&dependency_versions) { return FIELD_DEPENDENCY_UNKNOWN; }
  let version=dependency_versions[slot];
  return select(version,FIELD_DEPENDENCY_UNKNOWN,version==0u || version==FIELD_DEPENDENCY_UNKNOWN);
}
fn field_dependency_allocate()->u32 {
  for(var attempt=0u;attempt<4u;attempt++) {
    let current=atomicLoad(&dependency_cache[0u]);
    if current>=0xfffffffeu { return FIELD_DEPENDENCY_UNKNOWN; }
    let claim=atomicCompareExchangeWeak(&dependency_cache[0u],current,current+1u);
    if claim.exchanged { return current+1u; }
  }
  return FIELD_DEPENDENCY_UNKNOWN;
}
fn field_dependency_snapshot(at:u32,count:u32)->u32 {
  let identity=dependency_metadata[at];
  let cache_set=(identity*2654435761u)%dependency_settings.sets;
  for(var way=0u;way<${SURFACE_FIELD_DEPENDENCY_WAYS}u;way++) {
    let entry=cache_set*${SURFACE_FIELD_DEPENDENCY_WAYS}u+way;
    let base=${SURFACE_FIELD_DEPENDENCY_HEADER_WORDS}u+entry*${SURFACE_FIELD_DEPENDENCY_ENTRY_WORDS}u;
    if atomicLoad(&dependency_cache[base])!=2u || atomicLoad(&dependency_cache[base+1u])!=identity || atomicLoad(&dependency_cache[base+2u])!=count { continue; }
    let version=atomicLoad(&dependency_cache[base+3u]);
    var equal=true;
    for(var index=0u;index<count;index++) {
      if atomicLoad(&dependency_cache[base+5u+index])!=field_dependency_current(at,index) { equal=false; break; }
    }
    if equal && atomicLoad(&dependency_cache[base])==2u && atomicLoad(&dependency_cache[base+3u])==version {
      atomicMax(&dependency_cache[base+4u],dependency_settings.epoch);
      return version;
    }
  }
  return FIELD_DEPENDENCY_UNKNOWN;
}
@compute @workgroup_size(64)
fn lookup_field_dependency_versions(@builtin(global_invocation_id) id:vec3u) {
  let field=id.x;
  if field>=dependency_settings.fields { return; }
  let at=field_dependency_at(field);
  dependency_owners[field]=FIELD_DEPENDENCY_UNKNOWN;
  let count=dependency_metadata[at+5u];
  dependency_metadata[at+7u]=select(FIELD_DEPENDENCY_UNKNOWN,0u,count==0u);
  if count==0u || dependency_settings.store_enabled==0u || count>${SURFACE_FIELD_MAX_TEXTURE_DEPENDENCIES}u { return; }
  for(var index=0u;index<count;index++) { if field_dependency_current(at,index)==FIELD_DEPENDENCY_UNKNOWN { return; } }
  let hit=field_dependency_snapshot(at,count);
  if hit!=FIELD_DEPENDENCY_UNKNOWN { dependency_metadata[at+7u]=hit; }
}
@compute @workgroup_size(64)
fn reserve_field_dependency_versions(@builtin(global_invocation_id) id:vec3u) {
  let field=id.x;
  if field>=dependency_settings.fields || dependency_settings.store_enabled==0u { return; }
  let at=field_dependency_at(field);
  let count=dependency_metadata[at+5u];
  if count==0u || count>${SURFACE_FIELD_MAX_TEXTURE_DEPENDENCIES}u || dependency_metadata[at+7u]!=FIELD_DEPENDENCY_UNKNOWN { return; }
  for(var index=0u;index<count;index++) { if field_dependency_current(at,index)==FIELD_DEPENDENCY_UNKNOWN { return; } }
  let identity=dependency_metadata[at];
  let cache_set=(identity*2654435761u)%dependency_settings.sets;
  for(var way=0u;way<${SURFACE_FIELD_DEPENDENCY_WAYS}u;way++) {
    let entry=cache_set*${SURFACE_FIELD_DEPENDENCY_WAYS}u+way;
    let base=${SURFACE_FIELD_DEPENDENCY_HEADER_WORDS}u+entry*${SURFACE_FIELD_DEPENDENCY_ENTRY_WORDS}u;
    let state=atomicLoad(&dependency_cache[base]);
    if state==1u || (state==2u && atomicLoad(&dependency_cache[base+4u])>=dependency_settings.epoch) { continue; }
    var owns=false;
    for(var attempt=0u;attempt<4u;attempt++) {
      let claim=atomicCompareExchangeWeak(&dependency_cache[base],state,1u);
      if claim.exchanged { owns=true; break; }
      if claim.old_value!=state { break; }
    }
    if !owns { continue; }
    let version=field_dependency_allocate();
    if version==FIELD_DEPENDENCY_UNKNOWN { atomicStore(&dependency_cache[base],0u); return; }
    atomicStore(&dependency_cache[base+1u],identity);
    atomicStore(&dependency_cache[base+2u],count);
    atomicStore(&dependency_cache[base+3u],version);
    atomicStore(&dependency_cache[base+4u],dependency_settings.epoch);
    for(var index=0u;index<count;index++) { atomicStore(&dependency_cache[base+5u+index],field_dependency_current(at,index)); }
    dependency_metadata[at+7u]=version;
    dependency_owners[field]=entry;
    return;
  }
}
@compute @workgroup_size(64)
fn commit_field_dependency_versions(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=dependency_settings.fields { return; }
  let entry=dependency_owners[id.x];
  if entry==FIELD_DEPENDENCY_UNKNOWN { return; }
  atomicStore(&dependency_cache[${SURFACE_FIELD_DEPENDENCY_HEADER_WORDS}u+entry*${SURFACE_FIELD_DEPENDENCY_ENTRY_WORDS}u],2u);
}
@compute @workgroup_size(64)
fn resolve_field_dependency_versions(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=dependency_settings.fields || dependency_settings.store_enabled==0u { return; }
  let at=field_dependency_at(id.x);
  let count=dependency_metadata[at+5u];
  if count==0u || count>${SURFACE_FIELD_MAX_TEXTURE_DEPENDENCIES}u { return; }
  // Immutable publication aliases may have reserved several snapshots in the
  // cold dispatch. Resolve after all payloads are published, choosing the same
  // exact version proof for every alias without reading RESERVED payloads.
  dependency_metadata[at+7u]=field_dependency_snapshot(at,count);
}
`;
