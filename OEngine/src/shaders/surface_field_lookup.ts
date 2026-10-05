import { WINNER_INTERPOLATION_WGSL } from "./winner_interpolation.js";
import { APPEARANCE_FIELD_BOUND_WGSL } from "./appearance_field_bounds.js";
import { SURFACE_CELL_ADDRESS_MATH_WGSL } from "./surface_cell_address_math.js";
import { SURFACE_CELL_GEOMETRY_WGSL, surfaceCellGeometryArenaWgsl } from "../gpu/GpuSurfaceCellGeometryAbi.js";
import { SURFACE_CELL_ADDRESS_WORDS } from "../gpu/GpuSurfaceReferenceAbi.js";
import { surfaceProofAdmissionWgsl } from "../gpu/GpuSurfaceProofAbi.js";
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
export function surfaceFieldLookupWgsl(referenceCapacity: number): string {
  return /* wgsl */ `
struct FieldRequestSettings {
  identities:u32, constants:u32, leaves:u32, store_entries:u32,
  epoch:u32, view_revision:u32, store_enabled:u32, diagnostics:u32,
  width:u32,height:u32,reserved0:u32,reserved1:u32,
}
@group(0) @binding(0) var<uniform> field_request_settings:FieldRequestSettings;
@group(0) @binding(1) var<storage,read_write> field_request_workspace:SurfaceCellWorkspace;
@group(0) @binding(2) var<storage,read> field_request_metadata:array<u32>;
@group(0) @binding(3) var<storage,read> field_request_versions:array<u32>;
@group(0) @binding(4) var<storage,read_write> field_lookup_store:array<atomic<u32>>;
@group(0) @binding(5) var<storage,read_write> field_support_args:array<u32>;
${WINNER_INTERPOLATION_WGSL}
${APPEARANCE_FIELD_BOUND_WGSL}
${SURFACE_CELL_ADDRESS_MATH_WGSL}
${SURFACE_CELL_GEOMETRY_WGSL}
${surfaceCellGeometryArenaWgsl(referenceCapacity,false)}
@group(0) @binding(6) var<storage,read> field_support_geometry:CellGeometryArenaRead;
${SURFACE_REFERENCE_WGSL}
${SURFACE_FIELD_REQUEST_WGSL}
${surfaceProofAdmissionWgsl("field_request_workspace")}
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
  if countOneBits(uv_mask)!=1u { return false; }
  let uv=firstTrailingBit(uv_mask);
  let address=leaf*${SURFACE_CELL_ADDRESS_WORDS}u;
  let setup=field_support_geometry.setups[field_request_workspace.facts[leaf].y];
  let pixel=field_request_workspace.addresses[address+13u];
  let origin=vec2u((pixel%field_request_settings.width)&~1u,(pixel/field_request_settings.width)&~1u);
  let low_pixel=vec2f(origin)+vec2f(0.5);
  let high_pixel=min(vec2f(origin+vec2u(1u))+vec2f(0.5),vec2f(f32(field_request_settings.width)-0.5,f32(field_request_settings.height)-0.5));
  let attribute_index=select(2u,4u,uv==2u);
  let channel=select(0u,2u,uv==1u);
  for(var axis=0u;axis<2u;axis++) {
    let values=vec3f(setup.corners[attribute_index][channel+axis],setup.corners[attribute_index+6u][channel+axis],setup.corners[attribute_index+12u][channel+axis]);
    let support=cell_scalar_footprint(setup.coefficients,values,low_pixel,high_pixel,vec2f(f32(field_request_settings.width),f32(field_request_settings.height)));
    if !ab_valid(support.value) || !ab_valid(support.dx) || !ab_valid(support.dy) { return false; }
    let low=bitcast<f32>(atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_DOMAIN_WORD}u+axis]));
    let high=bitcast<f32>(atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_DOMAIN_WORD}u+2u+axis]));
    if !(support.value.low>=low && support.value.high<=high) { return false; }
    for(var step=0u;step<2u;step++) {
      var gradient=support.dx;
      if step==1u { gradient=support.dy; }
      let component=step*2u+axis;
      let lower=bitcast<f32>(atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_GRADIENT_WORD}u+component]));
      let upper=bitcast<f32>(atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_GRADIENT_WORD}u+4u+component]));
      if !(gradient.low>=lower && gradient.high<=upper) { return false; }
    }
  }
  return true;
}
fn field_lookup_point_support(base:u32,leaf:u32,field:u32)->bool {
  let uv=field_request_uv(leaf,field);
  if uv==0xffffffffu { return false; }
  let at=leaf*18u+uv*6u;
  for(var axis=0u;axis<2u;axis++) {
    let center=bitcast<f32>(field_request_workspace.uv_witnesses[at+axis]);
    let low=bitcast<f32>(atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_DOMAIN_WORD}u+axis]));
    let high=bitcast<f32>(atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_DOMAIN_WORD}u+2u+axis]));
    if !(center>=low && center<=high) { return false; }
    for(var step=0u;step<2u;step++) {
      let gradient=bitcast<f32>(field_request_workspace.uv_witnesses[at+2u+step*2u+axis]);
      let lower=bitcast<f32>(atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_GRADIENT_WORD}u+step*2u+axis]));
      let upper=bitcast<f32>(atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_GRADIENT_WORD}u+4u+step*2u+axis]));
      if !(gradient>=lower && gradient<=upper) { return false; }
    }
  }
  return true;
}
fn field_lookup_write_bounds(leaf:u32,field:u32,proof:u32,low:vec4u,high:vec4u)->u32 {
  let at=proof*${SURFACE_CELL_FIELD_CERTIFICATE_WORDS}u+FIELD_LOOKUP_CERTIFICATE_OFFSETS[field];
  let width=FIELD_LOOKUP_WIDTHS[field];
  for(var channel=0u;channel<width;channel++) {
    field_request_workspace.proof_results[at+channel]=low[channel];
    field_request_workspace.proof_results[at+width+channel]=high[channel];
  }
  field_request_workspace.screen_field_proofs[leaf*15u+field]=proof+1u;
  if field_request_settings.diagnostics!=0u { atomicAdd(&field_request_workspace.counters[89u],width*8u); }
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
  var store_fields=0u;
  var unresolved_values=0u;
  var unresolved_certificates=0u;
  var known=0u;
  var hits=0u;
  var certificate_hits=0u;
  for(var field=0u;field<15u;field++) {
    let reference=(leaf*15u+field)*2u;
    field_request_workspace.pending_support[leaf*15u+field] = 0xffffffffu;
    let absent=field_request_metadata[field_request_descriptor(leaf,field)+1u]==0xffffffffu;
    if (constants&(1u<<field))!=0u || absent {
      continue;
    }
    unresolved_values|=1u<<field;
    unresolved_certificates|=1u<<field;
    if field_request_settings.diagnostics!=0u { atomicAdd(&field_request_workspace.counters[92u],1u); }
    if field_request_settings.store_enabled==0u || !field_request_cacheable(leaf,field) { continue; }
    if field_request_settings.diagnostics!=0u { atomicAdd(&field_request_workspace.counters[91u],1u); }
    let cache_set=field_request_hash(leaf,field)%(field_request_settings.store_entries/4u);
    var value_entry=0xffffffffu;
    var support_entry=0xffffffffu;
    for(var way=0u;way<4u;way++) {
      if field_request_settings.diagnostics!=0u { atomicAdd(&field_request_workspace.counters[93u],1u); }
      let entry=cache_set*4u+way;
      let base=entry*${SURFACE_FIELD_STORE_ENTRY_WORDS}u;
      if atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_STATE_WORD}u])!=2u { continue; }
      if !field_lookup_equal(base,leaf,field,${SURFACE_FIELD_STORE_IDENTITY_WORDS}u) { continue; }
      let flags=atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_FLAGS_WORD}u]);
      if value_entry==0xffffffffu && (flags&1u)!=0u &&
        field_lookup_equal(base,leaf,field,${SURFACE_FIELD_STORE_KEY_WORDS}u) {
        value_entry=entry;
      }
      if support_entry==0xffffffffu && (flags&2u)!=0u { support_entry=entry; }
    }
    // Detailed domain validation is deferred to a real compact queue. The
    // candidate is pinned now; PendingValidation is never a readable value ref.
    if support_entry != 0xffffffffu {
      let proof = surface_proof_admit(leaf, 0u, field, support_entry);
      if proof != 0xffffffffu {
        field_request_workspace.pending_support[leaf*15u+field] = proof;
        field_request_workspace.proof_requests[proof][5u] = atomicLoad(&field_lookup_store[support_entry*${SURFACE_FIELD_STORE_ENTRY_WORDS}u+${SURFACE_FIELD_STORE_FLAGS_WORD}u]);
        atomicMax(&field_lookup_store[support_entry*${SURFACE_FIELD_STORE_ENTRY_WORDS}u+${SURFACE_FIELD_STORE_TOUCHED_WORD}u],field_request_settings.epoch);
      }
    }
    if value_entry!=0xffffffffu {
      let base=value_entry*${SURFACE_FIELD_STORE_ENTRY_WORDS}u;
      atomicMax(&field_lookup_store[base+${SURFACE_FIELD_STORE_TOUCHED_WORD}u],field_request_settings.epoch);
      field_request_workspace.field_references[reference]=value_entry;
      field_request_workspace.field_references[reference+1u]=atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_GENERATION_WORD}u]);
      store_fields|=1u<<field;
      if field_request_settings.diagnostics!=0u { atomicAdd(&field_request_workspace.counters[90u],8u); }
      unresolved_values&=~(1u<<field);
      hits++;
    }
  }
  field_request_workspace.field_known_masks[leaf]=known;
  atomicStore(&field_request_workspace.field_store_masks[leaf],store_fields);
  field_request_workspace.demands[leaf*4u]=unresolved_values;
  field_request_workspace.demands[leaf*4u+1u]=unresolved_certificates;
  if field_request_settings.diagnostics!=0u {
    atomicAdd(&field_request_workspace.counters[113u],hits);
    atomicAdd(&field_request_workspace.counters[114u],certificate_hits);
    atomicAdd(&field_request_workspace.counters[115u],countOneBits(unresolved_values));
    atomicAdd(&field_request_workspace.counters[116u],countOneBits(unresolved_certificates));
  }
}
@compute @workgroup_size(1)
fn finalize_field_support() {
  let count = atomicLoad(&field_request_workspace.counters[120u]);
  atomicStore(&field_request_workspace.counters[121u], count);
  field_support_args[0u] = (count + 63u) / 64u;
  field_support_args[1u] = 1u;
  field_support_args[2u] = 1u;
  field_support_args[3u] = count;
}
@compute @workgroup_size(64)
fn validate_field_support(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= atomicLoad(&field_request_workspace.counters[121u]) { return; }
  let request = field_request_workspace.proof_requests[id.x];
  let leaf = request[0u];
  let field = request[2u];
  let base = request[3u] * ${SURFACE_FIELD_STORE_ENTRY_WORDS}u;
  field_request_workspace.proof_requests[id.x][4u] = 0u;
  let flags = atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_FLAGS_WORD}u]);
  let certificate=field_lookup_support(base,leaf,field);
  let value=(flags&(4u|16u))!=0u && field_lookup_point_support(base,leaf,field);
  field_request_workspace.proof_requests[id.x][6u]=select(0u,1u,certificate)|select(0u,2u,value);
  if certificate || value { field_request_workspace.proof_requests[id.x][4u]=select(4u,3u,(flags&4u)!=0u); }
}
@compute @workgroup_size(64)
fn commit_field_support(@builtin(global_invocation_id) id: vec3u) {
  let leaf = id.x;
  if leaf >= field_request_settings.leaves { return; }
  let fact = field_request_workspace.facts[leaf];
  if fact.x == 0xffffffffu || fact.z == 0xffffffffu { return; }
  var known = field_request_workspace.field_known_masks[leaf];
  var values = field_request_workspace.demands[leaf*4u];
  var certificates = field_request_workspace.demands[leaf*4u+1u];
  for (var field=0u;field<15u;field++) {
    if (certificates & (1u<<field)) == 0u { continue; }
    let reference = (leaf*15u+field)*2u;
    // Exact-point hit refs retain their generation. They may still have an
    // independently queued domain certificate; locate that fixed leaf/field
    // relation from the queue only via the saved pending slot below.
    let pending = field_request_workspace.pending_support[leaf*15u+field];
    if pending == 0xffffffffu { continue; }
    let request = field_request_workspace.proof_requests[pending];
    if request[4u] != 3u && request[4u] != 4u { continue; }
    let base = request[3u]*${SURFACE_FIELD_STORE_ENTRY_WORDS}u;
    var low: vec4u;
    var high: vec4u;
    for (var channel=0u;channel<4u;channel++) {
      low[channel]=atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_BOUNDS_WORD}u+channel]);
      high[channel]=atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_BOUNDS_WORD}u+4u+channel]);
    }
    if (request[6u]&1u)!=0u {
      known |= field_lookup_write_bounds(leaf,field,pending,low,high);
      certificates &= ~(1u<<field);
      if field_request_settings.diagnostics != 0u {
        atomicAdd(&field_request_workspace.counters[114u],1u);
        atomicSub(&field_request_workspace.counters[116u],1u);
      }
    }
    if (request[6u]&2u)!=0u {
      field_request_workspace.field_references[reference] = request[3u];
      field_request_workspace.field_references[reference+1u] = atomicLoad(&field_lookup_store[base+${SURFACE_FIELD_STORE_GENERATION_WORD}u]);
      atomicOr(&field_request_workspace.field_store_masks[leaf],1u<<field);
      if field_request_settings.diagnostics!=0u { atomicAdd(&field_request_workspace.counters[90u],8u); }
      if field_request_settings.diagnostics!=0u && (values&(1u<<field))!=0u {
        atomicAdd(&field_request_workspace.counters[113u],1u);
        atomicSub(&field_request_workspace.counters[115u],1u);
        if request[4u]==4u { atomicAdd(&field_request_workspace.counters[124u],1u); }
      }
      values &= ~(1u<<field);
    }
  }
  field_request_workspace.field_known_masks[leaf] = known;
  field_request_workspace.demands[leaf*4u] = values;
  field_request_workspace.demands[leaf*4u+1u] = certificates;
}
`;

}

export const SURFACE_FIELD_LOOKUP_WGSL = surfaceFieldLookupWgsl(64);
