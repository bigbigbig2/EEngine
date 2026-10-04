import { SURFACE_FIELD_REQUEST_WGSL } from "./surface_field_request.js";
import { SURFACE_REFERENCE_WGSL } from "../gpu/GpuSurfaceReferenceAbi.js";
import { SURFACE_FIELD_STORE_ENTRY_WORDS, SURFACE_FIELD_STORE_IDENTITY_WORDS, SURFACE_FIELD_STORE_KEY_WORDS,
  SURFACE_FIELD_STORE_BOUNDS_WORD, SURFACE_FIELD_STORE_DOMAIN_WORD, SURFACE_FIELD_STORE_GRADIENT_WORD,
  SURFACE_FIELD_STORE_FLAGS_WORD, SURFACE_FIELD_STORE_GENERATION_WORD, SURFACE_FIELD_STORE_STATE_WORD,
  SURFACE_FIELD_STORE_TOUCHED_WORD } from "../gpu/GpuSurfaceFieldStoreAbi.js";
import { SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS, SURFACE_CELL_FIELD_CERTIFICATE_WORDS } from "../gpu/GpuSurfaceCellPlanAbi.js";
import { APPEARANCE_FIELD_WIDTHS } from "../gpu/GpuAppearanceFieldAbi.js";

/** Published value and certificate are independent results. A certificate hit
 * fills leaf bounds before the hierarchy; a value hit publishes a FieldRef.
 * No current-dispatch Store writer exists here, so pinning cannot race eviction. */
export const SURFACE_FIELD_LOOKUP_WGSL = /* wgsl */ `
struct FieldRequestSettings {
  identities:u32, constants:u32, leaves:u32, store_entries:u32,
  epoch:u32, view_revision:u32, store_enabled:u32, diagnostics:u32,
}
@group(0) @binding(0) var<uniform> field_request_settings:FieldRequestSettings;
@group(0) @binding(1) var<storage,read_write> field_request_workspace:SurfaceCellWorkspace;
@group(0) @binding(2) var<storage,read> field_request_metadata:array<u32>;
@group(0) @binding(3) var<storage,read> field_request_versions:array<u32>;
@group(0) @binding(4) var<storage,read_write> field_lookup_store:array<atomic<u32>>;
${SURFACE_REFERENCE_WGSL}
${SURFACE_FIELD_REQUEST_WGSL}
const FIELD_LOOKUP_CERTIFICATE_OFFSETS:array<u32,15>=array<u32,15>(${SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS.map(n=>`${n}u`).join(",")});
const FIELD_LOOKUP_WIDTHS:array<u32,15>=array<u32,15>(${APPEARANCE_FIELD_WIDTHS.map(n=>`${n}u`).join(",")});
fn field_lookup_equal(base:u32,leaf:u32,field:u32,words:u32)->bool {
  for(var word=0u;word<words;word++) {
    if atomicLoad(&field_lookup_store[base+word])!=field_request_word(leaf,field,word) { return false; }
  }
  return true;
}
fn field_lookup_support(base:u32,leaf:u32,field:u32)->bool {
  // A single parameter domain cannot certify a graph using several unrelated
  // charts, world or view inputs. Exact values remain cacheable for those graphs.
  let descriptor=field_request_descriptor(leaf,field);
  let flags=field_request_metadata[descriptor+3u];
  let uv_mask=field_request_metadata[descriptor+6u];
  if (flags&1u)==0u || countOneBits(uv_mask)>1u { return false; }
  for(var axis=0u;axis<2u;axis++) {
    let low=bitcast<f32>(atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_DOMAIN_WORD}u+axis]));
    let high=bitcast<f32>(atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_DOMAIN_WORD}u+2u+axis]));
    let requested_low=bitcast<f32>(field_request_domain(leaf,field,axis));
    let requested_high=bitcast<f32>(field_request_domain(leaf,field,2u+axis));
    if !(requested_low>=low && requested_high<=high) { return false; }
  }
  for(var component=0u;component<4u;component++) {
    let low=bitcast<f32>(atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_GRADIENT_WORD}u+component]));
    let high=bitcast<f32>(atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_GRADIENT_WORD}u+4u+component]));
    let requested_low=bitcast<f32>(field_request_gradient(leaf,field,component));
    let requested_high=bitcast<f32>(field_request_gradient(leaf,field,4u+component));
    if !(requested_low>=low && requested_high<=high) { return false; }
  }
  return true;
}
fn field_lookup_write_bounds(leaf:u32,field:u32,low:vec4u,high:vec4u)->u32 {
  let at=leaf*${SURFACE_CELL_FIELD_CERTIFICATE_WORDS}u+FIELD_LOOKUP_CERTIFICATE_OFFSETS[field];
  let width=FIELD_LOOKUP_WIDTHS[field];
  for(var channel=0u;channel<width;channel++) {
    field_request_workspace.field_certificates[at+channel]=low[channel];
    field_request_workspace.field_certificates[at+width+channel]=high[channel];
  }
  return ((1u<<width)-1u)<<(FIELD_LOOKUP_CERTIFICATE_OFFSETS[field]/2u);
}
@compute @workgroup_size(64)
fn lookup_surface_fields(@builtin(global_invocation_id) id:vec3u) {
  let leaf=id.x;
  if leaf>=field_request_settings.leaves { return; }
  let fact=field_request_workspace.facts[leaf];
  if fact.x==0xffffffffu || fact.z==0xffffffffu { return; }
  let palette=field_request_settings.constants+fact.z*64u;
  let constants=field_request_metadata[palette];
  var unresolved_values=0u;
  var unresolved_certificates=0u;
  var known=0u;
  var hits=0u;
  var certificate_hits=0u;
  for(var field=0u;field<15u;field++) {
    let reference=(leaf*15u+field)*3u;
    let absent=field_request_metadata[field_request_descriptor(leaf,field)+1u]==0xffffffffu;
    if (constants&(1u<<field))!=0u || absent {
      let at=palette+4u+field*4u;
      let value=vec4u(field_request_metadata[at],field_request_metadata[at+1u],field_request_metadata[at+2u],field_request_metadata[at+3u]);
      known|=field_lookup_write_bounds(leaf,field,value,value);
      continue;
    }
    unresolved_values|=1u<<field;
    unresolved_certificates|=1u<<field;
    // A transient index is finalized after classification/dedup; invalid here
    // prevents any consumer from accidentally reading a pre-evaluation record.
    field_request_workspace.field_references[reference]=SURFACE_REFERENCE_INVALID;
    if field_request_settings.store_enabled==0u || !field_request_cacheable(leaf,field) { continue; }
    let cache_set=field_request_hash(leaf,field)%(field_request_settings.store_entries/4u);
    var value_entry=0xffffffffu;
    var certificate_entry=0xffffffffu;
    for(var way=0u;way<4u;way++) {
      let entry=cache_set*4u+way;
      let base=entry*${SURFACE_FIELD_STORE_ENTRY_WORDS}u;
      if atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_STATE_WORD}u])!=2u { continue; }
      if !field_lookup_equal(base,leaf,field,${SURFACE_FIELD_STORE_IDENTITY_WORDS}u) { continue; }
      let flags=atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_FLAGS_WORD}u]);
      let support=field_lookup_support(base,leaf,field);
      if value_entry==0xffffffffu && (flags&1u)!=0u &&
        (field_lookup_equal(base,leaf,field,${SURFACE_FIELD_STORE_KEY_WORDS}u) || ((flags&4u)!=0u && support)) {
        value_entry=entry;
      }
      if certificate_entry==0xffffffffu && (flags&2u)!=0u && support { certificate_entry=entry; }
    }
    if value_entry!=0xffffffffu {
      let base=value_entry*${SURFACE_FIELD_STORE_ENTRY_WORDS}u;
      atomicMax(&field_lookup_store[base+${SURFACE_FIELD_STORE_TOUCHED_WORD}u],field_request_settings.epoch);
      field_request_workspace.field_references[reference]=SURFACE_REFERENCE_STORE;
      field_request_workspace.field_references[reference+1u]=value_entry;
      field_request_workspace.field_references[reference+2u]=atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_GENERATION_WORD}u]);
      unresolved_values&=~(1u<<field);
      hits++;
    }
    if certificate_entry!=0xffffffffu {
      let base=certificate_entry*${SURFACE_FIELD_STORE_ENTRY_WORDS}u;
      atomicMax(&field_lookup_store[base+${SURFACE_FIELD_STORE_TOUCHED_WORD}u],field_request_settings.epoch);
      var low:vec4u;
      var high:vec4u;
      for(var channel=0u;channel<4u;channel++) {
        low[channel]=atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_BOUNDS_WORD}u+channel]);
        high[channel]=atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_BOUNDS_WORD}u+4u+channel]);
      }
      known|=field_lookup_write_bounds(leaf,field,low,high);
      unresolved_certificates&=~(1u<<field);
      certificate_hits++;
    }
  }
  field_request_workspace.field_certificates[leaf*${SURFACE_CELL_FIELD_CERTIFICATE_WORDS}u+50u]=known;
  field_request_workspace.demands[leaf*4u]=unresolved_values;
  field_request_workspace.demands[leaf*4u+1u]=unresolved_certificates;
  if field_request_settings.diagnostics!=0u {
    atomicAdd(&field_request_workspace.counters[113u],hits);
    atomicAdd(&field_request_workspace.counters[114u],certificate_hits);
    atomicAdd(&field_request_workspace.counters[115u],countOneBits(unresolved_values));
    atomicAdd(&field_request_workspace.counters[116u],countOneBits(unresolved_certificates));
  }
}
`;
