import { surfaceCellWorkspaceWgsl, SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS } from "../gpu/GpuSurfaceCellPlanAbi.js";
import { surfaceDemandArenaWgsl } from "../gpu/GpuSurfaceDemandAbi.js";
import { SURFACE_REFERENCE_WGSL } from "../gpu/GpuSurfaceReferenceAbi.js";
import { SURFACE_FIELD_REQUEST_WGSL } from "./surface_field_request.js";
import { SURFACE_SIGNAL_REQUEST_WGSL } from "./surface_signal_request.js";
import { APPEARANCE_FIELD_WIDTHS } from "../gpu/GpuAppearanceFieldAbi.js";
/** Local publication glue. Full-key dedup precedes this owner; admission never
 * folds another producer into a live slot. RESERVED writers and epoch-pinned
 * hits cannot be evicted. Commit and ref consumption are separate dispatches. */
export function surfaceStorePublishWgsl(targets: number, programs: number, signal: boolean): string {
    const prefix = signal ? "signal" : "field";
    const getter = (signal ? SURFACE_SIGNAL_REQUEST_WGSL : SURFACE_REFERENCE_WGSL + SURFACE_FIELD_REQUEST_WGSL)
        .replaceAll(`${prefix}_request_settings`, "publish_settings")
        .replaceAll(`${prefix}_request_workspace`, "publish_workspace")
        .replaceAll(`${prefix}_request_metadata`, "publish_metadata")
        .replaceAll(`${prefix}_request_versions`, "publish_versions")
        .replaceAll("signal_request_sun", "publish_sun")
        .replaceAll("signal_request_shadow", "publish_shadow");
    const stride = signal ? 88 : 120, key = signal ? 72 : 88, value = key, flags = signal ? 76 : 112, generation = signal ? 77 : 113, state = signal ? 80 : 114, touched = signal ? 79 : 115;
    const count = signal ? 4 : 3, requestCount = signal ? 2 : 1;
    const word = signal ? "signal_request_word(item.x,item.y,word,fields)" : "field_request_word(item.x,item.y,word)";
    const hash = signal ? "signal_request_hash(item.x,item.y,fields)" : "field_request_hash(item.x,item.y)";
    const cacheable = signal ? "signal_request_cacheable(item.x,fields,item.y)" : "field_request_cacheable(item.x,item.y)";
    const certificates = signal ? "atomicStore(&publish_store[base+78u],1u);" : /* wgsl */ `
  let primitive=publish_workspace.primitives[item.x];
  let lane=item.x%64u;
  let origin=item.x-lane;
  let x=(lane%8u)&~1u;let y=(lane/8u)&~1u;
  var leaf=item.x;
  for(var member=0u;member<4u;member++) {
    let candidate=origin+(y+member/2u)*8u+x+member%2u;
    if publish_workspace.primitives[candidate]==primitive { leaf=candidate;break; }
  }
  let offset=PUBLISH_CERTIFICATE_OFFSETS[item.y];
  let width=PUBLISH_FIELD_WIDTHS[item.y];
  let mask=(1u<<width)-1u;
  let certificate=leaf*52u;
  let known=(publish_workspace.persistent_certificates[certificate+50u]>>(offset/2u))&mask;
  let descriptor=field_request_descriptor(item.x,item.y);
  let supported=(publish_metadata[descriptor+3u]&1u)!=0u && countOneBits(publish_metadata[descriptor+6u])<=1u;
  var constant=true;
  for(var channel=0u;channel<4u;channel++) {
    var low=0u;var high=0u;
    if channel<width {
      low=publish_workspace.persistent_certificates[certificate+offset+channel];
      high=publish_workspace.persistent_certificates[certificate+offset+width+channel];
      constant=constant && low==high && low==bitcast<u32>(payload[channel]);
    }
    atomicStore(&publish_store[base+92u+channel],low);
    atomicStore(&publish_store[base+96u+channel],high);
  }
  for(var axis=0u;axis<4u;axis++) { atomicStore(&publish_store[base+100u+axis],field_request_domain(item.x,item.y,axis)); }
  for(var axis=0u;axis<8u;axis++) { atomicStore(&publish_store[base+104u+axis],field_request_gradient(item.x,item.y,axis)); }
  if supported && known==mask { published_flags|=2u;if constant { published_flags|=4u; } }
`;
    return /* wgsl */ `
${surfaceCellWorkspaceWgsl(targets / 64)}
${surfaceDemandArenaWgsl(targets, programs)}
struct PublishSettings {
 identities:u32,constants:u32,leaves:u32,store_entries:u32,
 epoch:u32,view_revision:u32,environment_revision:u32,light_revision:u32,
 shadow_revision:u32,sun_revision:u32,shadow_enabled:u32,sun_enabled:u32,
 store_enabled:u32,diagnostics:u32,reserved0:u32,reserved1:u32,
}
@group(0) @binding(0) var<uniform> publish_settings:PublishSettings;
@group(0) @binding(1) var<storage,read_write> publish_workspace:SurfaceCellWorkspace;
@group(0) @binding(2) var<storage,read> publish_metadata:array<u32>;
@group(0) @binding(3) var<storage,read> publish_versions:array<u32>;
@group(0) @binding(4) var<storage,read_write> publish_arena:SurfaceDemandArena;
@group(0) @binding(5) var<storage,read_write> publish_store:array<atomic<u32>>;
@group(0) @binding(6) var<storage,read> publish_values:array<vec4f>;
@group(0) @binding(7) var<uniform> publish_sun:array<vec4u,3>;
@group(0) @binding(8) var<storage,read> publish_shadow:array<u32>;
${getter}
const PUBLISH_CERTIFICATE_OFFSETS:array<u32,15>=array<u32,15>(${SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS.map(n => `${n}u`).join(",")});
const PUBLISH_FIELD_WIDTHS:array<u32,15>=array<u32,15>(${APPEARANCE_FIELD_WIDTHS.map(n => `${n}u`).join(",")});
@compute @workgroup_size(64)
fn admit_surface_values(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=atomicLoad(&publish_arena.control[${count}u]) { return; }
  let request=publish_arena.unique_${prefix}s[id.x];
  let item=publish_arena.${prefix}_requests[request];
  ${signal ? "let fields=signal_request_fields(item.x,item.y);" : ""}
  if publish_settings.store_enabled==0u || !(${cacheable}) { return; }
  let payload=publish_values[request];
  if any(payload!=payload) || any(abs(payload)>vec4f(3.402823466e38)) { return; }
  let cache_set=${hash}%(publish_settings.store_entries/4u);
  for(var way=0u;way<4u;way++) {
    let entry=cache_set*4u+way;
    let base=entry*${stride}u;
    let old=atomicLoad(&publish_store[base+${state}u]);
    if old==1u || (old==2u && atomicLoad(&publish_store[base+${touched}u])>=publish_settings.epoch) { continue; }
    let generation=atomicLoad(&publish_store[base+${generation}u]);
    if generation>=0xfffffffeu { continue; }
    var owns=false;
    for(var attempt=0u;attempt<4u;attempt++) {
      let claim=atomicCompareExchangeWeak(&publish_store[base+${state}u],old,1u);
      if claim.exchanged { owns=true;break; }
      if claim.old_value!=old { break; }
    }
    if !owns { continue; }
    for(var word=0u;word<${key}u;word++) { atomicStore(&publish_store[base+word],${word}); }
    for(var channel=0u;channel<4u;channel++) { atomicStore(&publish_store[base+${value}u+channel],bitcast<u32>(payload[channel])); }
    var published_flags=${signal ? 3 : 1}u;
    ${certificates}
    atomicStore(&publish_store[base+${flags}u],published_flags);
    atomicStore(&publish_store[base+${generation}u],generation+1u);
    atomicStore(&publish_store[base+${touched}u],publish_settings.epoch);
    publish_arena.${prefix}_results[request]=entry;
    return;
  }
}
@compute @workgroup_size(64)
fn commit_surface_values(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=atomicLoad(&publish_arena.control[${count}u]) { return; }
  let request=publish_arena.unique_${prefix}s[id.x];
  let entry=publish_arena.${prefix}_results[request];
  if entry!=0xffffffffu { atomicStore(&publish_store[entry*${stride}u+${state}u],2u); }
}
@compute @workgroup_size(64)
fn publish_surface_references(@builtin(global_invocation_id) id:vec3u) {
  if id.x>=atomicLoad(&publish_arena.control[${requestCount}u]) { return; }
  let item=publish_arena.${prefix}_requests[id.x];
  let producer=publish_arena.${prefix}_aliases[id.x];
  let entry=publish_arena.${prefix}_results[producer];
  if entry==0xffffffffu { return; }
  let reference=(item.x*${signal ? 6 : 15}u+item.y)*3u;
  publish_workspace.${prefix}_references[reference]=SURFACE_REFERENCE_STORE;
  publish_workspace.${prefix}_references[reference+1u]=entry;
  publish_workspace.${prefix}_references[reference+2u]=atomicLoad(&publish_store[entry*${stride}u+${generation}u]);
}
`;
}
