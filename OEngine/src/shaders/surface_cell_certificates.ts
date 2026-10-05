import { surfaceProofAdmissionWgsl } from "../gpu/GpuSurfaceProofAbi.js";
import { SURFACE_FIELD_IDENTITY_WORDS, SURFACE_FIELD_EXECUTION_PROFILE_WORD } from "../gpu/GpuSurfaceFieldIdentityAbi.js";
import { APPEARANCE_FIELD_WIDTHS } from "../gpu/GpuAppearanceFieldAbi.js";
import { SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS, SURFACE_CELL_FIELD_CERTIFICATE_WORDS,
  SURFACE_CELL_GEOMETRY_CERTIFICATE_WORDS, SURFACE_CELL_PROOF_RESULT_WORDS, SURFACE_CELL_TILE_PLAN_BYTES } from "../gpu/GpuSurfaceCellPlanAbi.js";
import { SURFACE_CELL_ADDRESS_WORDS } from "../gpu/GpuSurfaceReferenceAbi.js";

/** Reuse is proved at the admitted certificate boundary, from the complete
 * Geometry-owned analytic quad support, never from unwritten address bounds. */
export const SURFACE_CELL_CANONICAL_SUPPORT_WGSL = /* wgsl */ `
fn cell_persistent_certificate_covers(leaf: u32, uv: u32, rect: vec4f) -> bool {
  let address = leaf * ${SURFACE_CELL_ADDRESS_WORDS}u;
  if (cell_workspace.addresses[address + 15u] & (1u << uv)) == 0u ||
    (cell_workspace.addresses[address + 16u] & 7u) != 7u { return false; }
  let setup = geometry_arena.setups[cell_workspace.facts[leaf].y];
  let attribute_index = select(2u, 4u, uv == 2u);
  let channel = select(0u, 2u, uv == 1u);
  for (var axis = 0u; axis < 2u; axis++) {
    let values = vec3f(setup.corners[attribute_index][channel + axis],
      setup.corners[attribute_index + 6u][channel + axis], setup.corners[attribute_index + 12u][channel + axis]);
    let support = cell_scalar_footprint(setup.coefficients, values, rect.xy, rect.zw,
      vec2f(f32(cell_settings.width), f32(cell_settings.height)));
    let center = bitcast<f32>(cell_workspace.uv_witnesses[leaf * 18u + uv * 6u + axis]);
    let gradient = bitcast<vec2f>(vec2u(cell_workspace.uv_witnesses[leaf * 18u + 2u + uv * 6u + axis],
      cell_workspace.uv_witnesses[leaf * 18u + 4u + uv * 6u + axis]));
    if !cell_parameter_support_covers(support, center, gradient) { return false; }
  }
  return true;
}
`;

/** Local Continuity-Domain Signal Sampling certificate integration. Scratch is
 * one immutable leaf certificate per primitive/quad (<=64 per tile), shared by
 * all planes and hierarchy levels. No node x domain x plane certificate table.
 * A coarse anchor is an existing covered fine-sample location; material sampling
 * retains its original GeometryRecord gradients. The leaf interval includes the
 * complete analytic/filter support, not just the four sampled values. */
export const SURFACE_CELL_CERTIFICATE_WGSL = /* wgsl */ `
${surfaceProofAdmissionWgsl("cell_workspace")}
const CELL_CERTIFICATE_ACTIVE_FIELDS:u32=32767u;
const CELL_CERTIFICATE_QUEUE:u32=0u;
const CELL_CERTIFICATE_GEOMETRY_WORDS:u32=${SURFACE_CELL_GEOMETRY_CERTIFICATE_WORDS}u;
const CELL_CERTIFICATE_FIELD_WORDS:u32=${SURFACE_CELL_FIELD_CERTIFICATE_WORDS}u;
const CELL_CERTIFICATE_RESULT_WORDS:u32=${SURFACE_CELL_PROOF_RESULT_WORDS}u;
const CELL_CERTIFICATE_FIELD_OFFSET:array<u32,15>=array<u32,15>(${SURFACE_CELL_FIELD_CERTIFICATE_OFFSETS.map(n=>`${n}u`).join(",")});
const CELL_CERTIFICATE_FIELD_WIDTH:array<u32,15>=array<u32,15>(${APPEARANCE_FIELD_WIDTHS.map(n=>`${n}u`).join(",")});
var<workgroup> cell_proof_tile_flags:array<atomic<u32>,7>;
@compute @workgroup_size(64)
fn prepare_cell_proof_tiles(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
  if group.x>=cell_settings.tile_count { return; }
  cell_local_tile=group.x;
  if lane<7u { atomicStore(&cell_proof_tile_flags[lane],0u); }
  workgroupBarrier();
  let leaf=group.x*64u+lane;
  let published=cell_workspace.facts[leaf];
  if published.x!=0xffffffffu && cell_leaf_certificate(group.x,lane)==lane {
    let pixel_index=cell_workspace.addresses[leaf*${SURFACE_CELL_ADDRESS_WORDS}u+13u];
    let fact=surface_cell_load(vec2u(pixel_index%cell_settings.width,pixel_index/cell_settings.width),published.x);
    if (fact.enabled&~fact.publication)!=0u { atomicStore(&cell_proof_tile_flags[0u],1u); }
    let unresolved=cell_workspace.demands[leaf*4u+1u];
    let families=array<u32,3>(35u,924u,31808u);
    for(var field=0u;field<15u;field++) {
      if (unresolved&(1u<<field))==0u { continue; }
      let identity=settings.appearance2.z+(published.z*15u+field)*${SURFACE_FIELD_IDENTITY_WORDS}u;
      let profile=appearance_metadata[identity+${SURFACE_FIELD_EXECUTION_PROFILE_WORD}u];
      if (appearance_metadata[profile+15u]&4u)==0u || appearance_metadata[profile+8u]>64u ||
        appearance_metadata[profile+10u]>4u { continue; }
      for(var family=0u;family<3u;family++) {
        if (families[family]&(1u<<field))==0u { continue; }
        atomicStore(&cell_proof_tile_flags[2u+family*2u],1u);
        if (appearance_metadata[identity+3u]&1u)!=0u && countOneBits(appearance_metadata[identity+6u])==1u {
          atomicStore(&cell_proof_tile_flags[1u+family*2u],1u);
        }
      }
    }
  }
  workgroupBarrier();
  if lane<7u && atomicLoad(&cell_proof_tile_flags[lane])!=0u {
    let slot=atomicAdd(&cell_workspace.proof_tile_counts[lane],1u);
    cell_workspace.proof_tiles[lane*(cell_settings.batch_target_capacity/64u)+slot]=group.x;
  }
}
@compute @workgroup_size(1)
fn finalize_cell_proof_tiles() {
  for(var family=0u;family<7u;family++) {
    let count=atomicLoad(&cell_workspace.proof_tile_counts[family]);
    cell_workspace.proof_dispatch[family*4u]=count;
    cell_workspace.proof_dispatch[family*4u+1u]=1u;
    cell_workspace.proof_dispatch[family*4u+2u]=1u;
    cell_workspace.proof_dispatch[family*4u+3u]=count;
  }
}

fn cell_admit_field_proof(leaf: u32, field: u32, kind: u32)->u32 {
  let entry = cell_workspace.facts[leaf].z;
  let identity = settings.appearance2.z + (entry*15u+field)*${SURFACE_FIELD_IDENTITY_WORDS}u;
  let profile = appearance_metadata[identity+${SURFACE_FIELD_EXECUTION_PROFILE_WORD}u];
  if (appearance_metadata[profile+15u]&4u)==0u ||
    appearance_metadata[profile+8u]>64u || appearance_metadata[profile+10u]>4u { return 0xffffffffu; }
  // One typed Field candidate per leaf/context, shared by compile families.
  var tag=0u;
  if kind==2u { tag=cell_workspace.persistent_field_proofs[leaf]; }
  else { tag=cell_workspace.screen_proof_slots[leaf]; }
  var proof=tag-1u;
  if tag==0u {
    proof=surface_proof_admit(leaf,kind,0u,0xffffffffu);
    if proof==0xffffffffu { return proof; }
    cell_workspace.proof_requests[proof][4u]=0u;
    if kind==2u {
      cell_workspace.proof_results[proof*CELL_CERTIFICATE_RESULT_WORDS+50u]=0u;
      if cell_settings.reserved!=0u { atomicAdd(&cell_workspace.counters[89u],4u); }
    }
    if kind==2u { cell_workspace.persistent_field_proofs[leaf]=proof+1u; }
    else { cell_workspace.screen_proof_slots[leaf]=proof+1u; }
  }
  let members=appearance_metadata[profile+13u]&CELL_CERTIFICATE_ACTIVE_FIELDS;
  let admitted=cell_workspace.proof_requests[proof][2u];
  if (admitted&(1u<<field))!=0u { return proof; }
  let nodes=appearance_metadata[profile+8u]*countOneBits(members);
  let queries=appearance_metadata[profile+10u];
  if cell_workspace.proof_requests[proof][6u]+nodes>64u || cell_workspace.proof_requests[proof][7u]+queries>4u { return 0xffffffffu; }
  cell_workspace.proof_requests[proof][6u]+=nodes;
  cell_workspace.proof_requests[proof][7u]+=queries;
  cell_workspace.proof_requests[proof][2u]|=members;
  return proof;
}
fn cell_begin_field_proof() {
  cell_proof_queries = 0u;
  cell_proof_exhausted = false;
}
fn cell_finish_field_proof(proof: u32, field: u32, value: AppearanceBound4) -> AppearanceBound4 {
  var result = value;
  if cell_proof_exhausted {
    result.known = vec4u(0u);
    atomicAdd(&cell_workspace.counters[123u],1u);
  }
  let width=CELL_CERTIFICATE_FIELD_WIDTH[field];
  var known=true;
  for(var channel=0u;channel<width;channel++) { known=known && result.known[channel]!=0u; }
  if known { cell_workspace.proof_requests[proof][5u]|=1u<<field; }
  cell_workspace.proof_requests[proof][4u]=select(0u,4u,cell_workspace.proof_requests[proof][5u]==cell_workspace.proof_requests[proof][2u]);
  return result;
}
fn cell_leaf_certificate(tile:u32,lane:u32)->u32 {
  let primitive=cell_workspace.primitives[tile*64u+lane];
  let x=(lane%8u)&~1u;
  let y=(lane/8u)&~1u;
  for(var row=0u;row<2u;row++) {
    for(var column=0u;column<2u;column++) {
      let member=(y+row)*8u+x+column;
      if cell_workspace.primitives[tile*64u+member]==primitive { return member; }
    }
  }
  return lane;
}
fn cell_certificate_box(tile:u32,leaf:u32,component:u32)->AppearanceBound4 {
  let tag=cell_workspace.geometry_proofs[tile*64u+leaf];
  if tag==0u { return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u)); }
  let at=(tag-1u)*CELL_CERTIFICATE_RESULT_WORDS;
  let base=at+component*6u;
  let known=select(0u,1u,(cell_workspace.proof_results[at+31u]&(1u<<component))!=0u);
  if known==0u { return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u)); }
  let low=bitcast<vec3f>(vec3u(cell_workspace.proof_results[base],cell_workspace.proof_results[base+1u],cell_workspace.proof_results[base+2u]));
  let high=bitcast<vec3f>(vec3u(cell_workspace.proof_results[base+3u],cell_workspace.proof_results[base+4u],cell_workspace.proof_results[base+5u]));
  return AppearanceBound4(vec4f(low,0.0),vec4f(high,0.0),vec4u(known,known,known,1u));
}
fn cell_certificate_field(tile:u32,leaf:u32,field:u32)->AppearanceBound4 {
  let leaf_index=tile*64u+leaf;
  let publication=cell_certificate_publication(leaf_index,field);
  if all(publication.known!=vec4u(0u)) { return publication; }
  let tag=cell_workspace.screen_field_proofs[leaf_index*15u+field];
  if tag==0u { return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u)); }
  let at=(tag-1u)*CELL_CERTIFICATE_RESULT_WORDS;
  let offset=CELL_CERTIFICATE_FIELD_OFFSET[field];
  let width=CELL_CERTIFICATE_FIELD_WIDTH[field];
  let known=cell_workspace.field_known_masks[leaf_index]>>(offset/2u);
  var value=AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(1u));
  for(var channel=0u;channel<width;channel++) {
    value.known[channel]=(known>>channel)&1u;
    if value.known[channel]==0u { continue; }
    value.low[channel]=bitcast<f32>(cell_workspace.proof_results[at+offset+channel]);
    value.high[channel]=bitcast<f32>(cell_workspace.proof_results[at+offset+width+channel]);
  }
  return value;
}
fn cell_write_certificate_box(at:u32,component:u32,value:AppearanceBound4)->u32 {
  let base=at+component*6u;
  for(var channel=0u;channel<3u;channel++) {
    cell_workspace.proof_results[base+channel]=bitcast<u32>(value.low[channel]);
    cell_workspace.proof_results[base+3u+channel]=bitcast<u32>(value.high[channel]);
  }
  return select(0u,1u<<component,all(value.known.xyz!=vec3u(0u)));
}
var<workgroup> cell_certificate_diagnostics:array<vec4u,64>;
var<workgroup> cell_texture_certificate_diagnostics:array<vec2u,64>;
var<workgroup> cell_parameter_certificate_diagnostics:array<u32,64>;
var<private> cell_parameter_uv:u32=0xffffffffu;
fn cell_certificate_parameter_context(fact:SurfaceCellLane,rect:vec4f,leaf:u32,field:u32)->vec4u {
  let entry=cell_workspace.facts[leaf].z;
  let descriptor=settings.appearance2.z+(entry*15u+field)*${SURFACE_FIELD_IDENTITY_WORDS}u;
  let flags=appearance_metadata[descriptor+3u];
  let uv_mask=appearance_metadata[descriptor+6u];
  if (flags&1u)==0u || countOneBits(uv_mask)!=1u {
    return vec4u(0xffffffffu);
  }
  let uv=firstTrailingBit(uv_mask);
  let address=leaf*${SURFACE_CELL_ADDRESS_WORDS}u;
  if (cell_workspace.addresses[address+15u]&uv_mask)!=uv_mask ||
    (cell_workspace.addresses[address+16u]&7u)!=7u { return vec4u(0xffffffffu); }
  if cell_parameter_enabled && cell_parameter_uv==uv {
    return vec4u(cell_bound_slot,cell_directory(entry).x,entry,fact.winner);
  }
  let context=cell_bound_context(fact,rect);
  let attribute_index=select(2u,4u,uv==2u);
  let channel=select(0u,2u,uv==1u);
  var corners:array<vec4f,3>;
  for(var corner=0u;corner<3u;corner++) {
    let value=cell_bound_setup.corners[corner*6u+attribute_index];
    corners[corner]=vec4f(value[channel],value[channel+1u],0.0,1.0);
  }
  cell_parameter_coefficients=winner_build_coefficients(corners[0u],corners[1u],corners[2u]);
  if cell_parameter_coefficients.row0.w==0.0 { return vec4u(0xffffffffu); }
  var low:vec2f;
  for(var axis=0u;axis<2u;axis++) {
    let value=bitcast<f32>(cell_workspace.uv_witnesses[leaf*18u+uv*6u+axis]);
    if value!=value || abs(value)>16777216.0 { return vec4u(0xffffffffu); }
    low[axis]=floor(value*32.0)/32.0;
    let gradient=bitcast<vec2f>(vec2u(cell_workspace.uv_witnesses[leaf*18u+2u+uv*6u+axis],
      cell_workspace.uv_witnesses[leaf*18u+4u+uv*6u+axis]));
    let envelope=cell_parameter_gradient_envelope(gradient);
    if !ab_valid(envelope) { return vec4u(0xffffffffu); }
    cell_parameter_gradient_low[axis]=envelope.low;
    cell_parameter_gradient_low[axis+2u]=envelope.low;
    cell_parameter_gradient_high[axis]=envelope.high;
    cell_parameter_gradient_high[axis+2u]=envelope.high;
  }
  cell_parameter_domain=vec4f(low,low+vec2f(1.0/32.0));
  cell_parameter_enabled=true;
  cell_parameter_uv=uv;
  cell_bound_attribute_valid=0u;
  return context;
}
fn cell_finish_certificate_diagnostics(lane:u32,geometry_count:u32,field_count:u32,parameter_count:u32) {
  cell_certificate_diagnostics[lane]=vec4u(geometry_count,field_count,cell_texture_nodes,cell_context_count);
  cell_texture_certificate_diagnostics[lane]=vec2u(cell_texture_query_count,cell_texture_reuse_count);
  cell_parameter_certificate_diagnostics[lane]=parameter_count;
  workgroupBarrier();
  if lane==0u && cell_settings.reserved!=0u {
    var sum=vec4u(0u);
    var texture_sum=vec2u(0u);
    var parameter_sum=0u;
    for(var member=0u;member<64u;member++) { sum+=cell_certificate_diagnostics[member]; texture_sum+=cell_texture_certificate_diagnostics[member];parameter_sum+=cell_parameter_certificate_diagnostics[member]; }
    atomicAdd(&cell_workspace.counters[108u],sum.x);
    atomicAdd(&cell_workspace.counters[109u],sum.y);
    atomicAdd(&cell_workspace.counters[106u],sum.z);
    atomicAdd(&cell_workspace.counters[110u],sum.w);
    atomicAdd(&cell_workspace.counters[111u],texture_sum.x);
    atomicAdd(&cell_workspace.counters[112u],texture_sum.y);
    atomicAdd(&cell_workspace.counters[119u],parameter_sum);
  }
}
@compute @workgroup_size(64)
fn publish_cell_geometry_certificates(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
  // Indirect arguments contain exactly this queue's published group count.
  let tile=cell_workspace.proof_tiles[CELL_CERTIFICATE_QUEUE*(cell_settings.batch_target_capacity/64u)+group.x];cell_local_tile=tile;
  let absolute=cell_workspace.plans[tile*${SURFACE_CELL_TILE_PLAN_BYTES/4}u+4u];
  let origin=vec2u((absolute%cell_settings.tiles_x)*8u,(absolute/cell_settings.tiles_x)*8u);
  let pixel=origin+vec2u(lane%8u,lane/8u);
  let published=cell_workspace.facts[tile*64u+lane];
  var count=0u;
  if published.x!=0xffffffffu && cell_leaf_certificate(tile,lane)==lane {
    let enabled_fact=surface_cell_load(pixel,published.x);
    var proof=0xffffffffu;
    if (enabled_fact.enabled&~enabled_fact.publication)!=0u {
      proof=surface_proof_admit(tile*64u+lane,1u,0xffffffffu,0xffffffffu);
    }
    if proof != 0xffffffffu {
    let fact=enabled_fact;
    let rect=cell_rect_from_mask(cell_region(lane,2u,2u),origin);
    let context=cell_bound_context(fact,rect);
    let at=proof*CELL_CERTIFICATE_RESULT_WORDS;
    cell_workspace.geometry_proofs[tile*64u+lane]=proof+1u;
    var known=cell_write_certificate_box(at,0u,cell_attribute_box(5u));
    known|=cell_write_certificate_box(at,1u,cell_world_normal_box());
    known|=cell_write_certificate_box(at,2u,cell_world_tangent_box());
    known|=cell_write_certificate_box(at,3u,cell_view_box());
    var dx2=0.0;
    var dy2=0.0;
    var valid=true;
    for(var channel=0u;channel<3u;channel++) {
      let position=cell_scalar_attribute(5u,channel);
      valid=valid && ab_valid(position.value) && ab_valid(position.dx) && ab_valid(position.dy);
      dx2+=cell_max_magnitude(position.dx)*cell_max_magnitude(position.dx);
      dy2+=cell_max_magnitude(position.dy)*cell_max_magnitude(position.dy);
    }
    let plane=cell_lane_geometry[fact.source].plane;
    let values=vec3f(dot(plane,cell_bound_setup.corners[5u]),dot(plane,cell_bound_setup.corners[11u]),dot(plane,cell_bound_setup.corners[17u]));
    let residual=cell_scalar_footprint(cell_bound_setup.coefficients,values,rect.xy,rect.zw,vec2f(f32(cell_settings.width),f32(cell_settings.height))).value;
    cell_workspace.proof_results[at+24u]=bitcast<u32>(residual.low);
    cell_workspace.proof_results[at+25u]=bitcast<u32>(residual.high);
    for(var channel=0u;channel<4u;channel++) { cell_workspace.proof_results[at+26u+channel]=bitcast<u32>(plane[channel]); }
    cell_workspace.proof_results[at+30u]=bitcast<u32>(max(sqrt(dx2),sqrt(dy2)));
    cell_workspace.proof_results[at+31u]=known|select(0u,16u,valid && ab_valid(residual));
    if cell_settings.reserved!=0u { atomicAdd(&cell_workspace.counters[89u],128u); }
    cell_workspace.proof_requests[proof][4u] = select(0u,4u,known==15u && valid && ab_valid(residual));
    count=1u;
    }
  }
  cell_finish_certificate_diagnostics(lane,count,0u,0u);
}
@compute @workgroup_size(64)
fn publish_cell_parameter_certificates(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
  let tile=cell_workspace.proof_tiles[CELL_CERTIFICATE_QUEUE*(cell_settings.batch_target_capacity/64u)+group.x];cell_local_tile=tile;
  let absolute=cell_workspace.plans[tile*${SURFACE_CELL_TILE_PLAN_BYTES/4}u+4u];
  let origin=vec2u((absolute%cell_settings.tiles_x)*8u,(absolute/cell_settings.tiles_x)*8u);
  let pixel=origin+vec2u(lane%8u,lane/8u);
  let published=cell_workspace.facts[tile*64u+lane];
  var count=0u;
  if published.x!=0xffffffffu && cell_leaf_certificate(tile,lane)==lane {
    let fact=surface_cell_load(pixel,published.x);
    let rect=cell_rect_from_mask(cell_region(lane,2u,2u),origin);
    let leaf=tile*64u+lane;
    let unresolved=cell_workspace.demands[leaf*4u+1u]&CELL_CERTIFICATE_ACTIVE_FIELDS;
    var persistent_fields=cell_workspace.persistent_field_masks[leaf];
    // Select one context per actual UV family before evaluating any closure.
    for(var uv=0u;uv<3u;uv++) {
      var fields=0u;
      for(var field=0u;field<15u;field++) {
        if (unresolved&(1u<<field))==0u { continue; }
        let identity=settings.appearance2.z+(published.z*15u+field)*${SURFACE_FIELD_IDENTITY_WORDS}u;
        if appearance_metadata[identity+6u]==(1u<<uv) && (appearance_metadata[identity+3u]&1u)!=0u { fields|=1u<<field; }
      }
      if fields==0u { continue; }
      var slots: array<u32,15>;
      var admitted_fields=0u;
      for (var field=0u;field<15u;field++) {
        slots[field]=0xffffffffu;
        if (fields&(1u<<field))==0u { continue; }
        let proof=cell_admit_field_proof(leaf,field,2u);
        if proof!=0xffffffffu {
          slots[field]=proof;
          admitted_fields|=1u<<field;
          cell_workspace.proof_requests[proof][4u]=0u;
        }
      }
      fields=admitted_fields;
      if fields==0u { continue; }
      let parameter=cell_certificate_parameter_context(fact,rect,leaf,firstTrailingBit(fields));
      if parameter.x==0xffffffffu { continue; }
      for(var field=0u;field<15u;field++) {
        if (fields&(1u<<field))==0u { continue; }
        let proof = slots[field];
        let at=proof*CELL_CERTIFICATE_RESULT_WORDS;
        var persistent_known=cell_workspace.proof_results[at+50u];
        cell_begin_field_proof();
        var value=cell_finish_field_proof(proof,field,cell_evaluate_bound(field,parameter));
        let descriptor=cell_field_descriptor(parameter.y,field);
        if (cell_bound_setup.continuity[1u].w&descriptor.y)!=0u { value.known=vec4u(0u); }
        let offset=CELL_CERTIFICATE_FIELD_OFFSET[field];
        let width=CELL_CERTIFICATE_FIELD_WIDTH[field];
        for(var channel=0u;channel<width;channel++) {
          cell_workspace.proof_results[at+offset+channel]=bitcast<u32>(value.low[channel]);
          cell_workspace.proof_results[at+offset+width+channel]=bitcast<u32>(value.high[channel]);
          persistent_known|=(value.known[channel]&1u)<<(offset/2u+channel);
        }
        persistent_fields|=1u<<field;
        cell_workspace.proof_results[at+50u]=persistent_known;
        if cell_settings.reserved!=0u { atomicAdd(&cell_workspace.counters[89u],(width*2u+1u)*4u); }
      }
    }
    cell_workspace.persistent_field_masks[leaf]=persistent_fields;
    count=select(0u,1u,unresolved!=0u);
  }
  cell_finish_certificate_diagnostics(lane,0u,0u,count);
}
${SURFACE_CELL_CANONICAL_SUPPORT_WGSL}
@compute @workgroup_size(64)
fn publish_cell_field_certificates(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32) {
  let tile=cell_workspace.proof_tiles[CELL_CERTIFICATE_QUEUE*(cell_settings.batch_target_capacity/64u)+group.x];cell_local_tile=tile;
  let leaf=tile*64u+lane;
  let absolute=cell_workspace.plans[tile*${SURFACE_CELL_TILE_PLAN_BYTES/4}u+4u];
  let origin=vec2u((absolute%cell_settings.tiles_x)*8u,(absolute/cell_settings.tiles_x)*8u);
  let published=cell_workspace.facts[leaf];
  var count=0u;
  if published.x!=0xffffffffu && cell_leaf_certificate(tile,lane)==lane {
    let unresolved=cell_workspace.demands[leaf*4u+1u]&CELL_CERTIFICATE_ACTIVE_FIELDS;
    var known=cell_workspace.field_known_masks[leaf];
    var context=vec4u(0xffffffffu);
    let rect=cell_rect_from_mask(cell_region(lane,2u,2u),origin);
    var tested_uv=0u;
    var covered_uv=0u;
    for(var field=0u;field<15u;field++) {
      if (unresolved&(1u<<field))==0u { continue; }
      let offset=CELL_CERTIFICATE_FIELD_OFFSET[field];
      let width=CELL_CERTIFICATE_FIELD_WIDTH[field];
      let identity=settings.appearance2.z+(published.z*15u+field)*${SURFACE_FIELD_IDENTITY_WORDS}u;
      let uv_mask=appearance_metadata[identity+6u];
      let persistent=(cell_workspace.persistent_field_masks[leaf]&(1u<<field))!=0u && countOneBits(uv_mask)==1u;
      if persistent && (tested_uv&uv_mask)==0u {
        tested_uv|=uv_mask;
        if cell_persistent_certificate_covers(leaf,firstTrailingBit(uv_mask),rect) { covered_uv|=uv_mask; }
      }
      if persistent && (covered_uv&uv_mask)!=0u {
        let tag=cell_workspace.persistent_field_proofs[leaf];
        cell_workspace.screen_field_proofs[leaf*15u+field]=tag;
        known|=cell_workspace.proof_results[(tag-1u)*CELL_CERTIFICATE_RESULT_WORDS+50u]&(((1u<<width)-1u)<<(offset/2u));
        continue;
      }
      let proof = cell_admit_field_proof(leaf,field,3u);
      if proof == 0xffffffffu { continue; }
      let at=proof*CELL_CERTIFICATE_RESULT_WORDS;
      cell_workspace.screen_field_proofs[leaf*15u+field]=proof+1u;
      if context.x==0xffffffffu {
        let fact=surface_cell_load(origin+vec2u(lane%8u,lane/8u),published.x);
        context=cell_bound_context(fact,rect);
      }
      cell_begin_field_proof();
      var value=cell_finish_field_proof(proof,field,cell_evaluate_bound(field,context));
      let descriptor=cell_field_descriptor(context.y,field);
      if (cell_bound_setup.continuity[1u].w&descriptor.y)!=0u { value.known=vec4u(0u); }
      for(var channel=0u;channel<width;channel++) {
        cell_workspace.proof_results[at+offset+channel]=bitcast<u32>(value.low[channel]);
        cell_workspace.proof_results[at+offset+width+channel]=bitcast<u32>(value.high[channel]);
        known|=(value.known[channel]&1u)<<(offset/2u+channel);
      }
      if cell_settings.reserved!=0u { atomicAdd(&cell_workspace.counters[89u],width*8u); }
    }
    cell_workspace.field_known_masks[leaf]=known;
    count=select(0u,1u,unresolved!=0u);
  }
  cell_finish_certificate_diagnostics(lane,0u,count,0u);
}
`;

/** Independent numerical fixtures exercise the exact production reader and
 * parent merge without constructing a second geometry/material producer. */
export const SURFACE_CELL_CERTIFICATE_READ_WGSL =
  SURFACE_CELL_CERTIFICATE_WGSL.slice(SURFACE_CELL_CERTIFICATE_WGSL.indexOf("const CELL_CERTIFICATE_ACTIVE_FIELDS"),
    SURFACE_CELL_CERTIFICATE_WGSL.indexOf("var<workgroup> cell_proof_tile_flags")) +
  SURFACE_CELL_CERTIFICATE_WGSL.slice(SURFACE_CELL_CERTIFICATE_WGSL.indexOf("fn cell_leaf_certificate"),
    SURFACE_CELL_CERTIFICATE_WGSL.indexOf("fn cell_write_certificate_box"));
