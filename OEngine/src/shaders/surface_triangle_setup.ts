/** Frame-local, demand-driven workgroup cache. Exact visibility identity is only
 * used within this dispatch and its immutable meshlet/publication snapshot. */
export const SURFACE_TRIANGLE_SETUP_WGSL = /* wgsl */ `
struct SurfaceTriangleSetup {
  ref0:SparseVertexRef, ref1:SparseVertexRef, ref2:SparseVertexRef,
  model:mat4x4f, p0:vec4f, p1:vec4f, p2:vec4f,
  c0:vec4f, c1:vec4f, c2:vec4f, valid:bool,
}
var<workgroup> surface_setup_leaders:array<atomic<u32>,16>;
var<workgroup> surface_setup_keys:array<u32,16>;
var<workgroup> surface_setups:array<SurfaceTriangleSetup,16>;
var<private> surface_sample_key:u32;
fn surface_setup_hash(key:u32)->u32 { let mixed=key^(key>>16u); return ((mixed^(mixed>>8u))*2654435761u)&15u; }
fn surface_setup_direct(item:OEngineMeshletRasterWork,primitive:u32)->SurfaceTriangleSetup {
  var setup:SurfaceTriangleSetup;
  if item.instance_slot>=arrayLength(&instance_records) { return setup; }
  surface_identity_failed=false;
  let geometry_base=sparse_geometry_base(item.geometry_slot);
  let meshlet_base=sparse_meshlet_base(item.meshlet_slot);
  let vertices=sparse_meshlet_vertices_for_work(item,meshlet_base,primitive);
  setup.ref0=sparse_vertex_ref_for_work(item,geometry_base,vertices.x);
  setup.ref1=sparse_vertex_ref_for_work(item,geometry_base,vertices.y);
  setup.ref2=sparse_vertex_ref_for_work(item,geometry_base,vertices.z);
  setup.model=sparse_affine(surface_instance_record(item.instance_slot));
  let l0=vec4f(sparse_position_ref(setup.ref0),1.0);
  let l1=vec4f(sparse_position_ref(setup.ref1),1.0);
  let l2=vec4f(sparse_position_ref(setup.ref2),1.0);
  setup.p0=setup.model*l0;
  setup.p1=setup.model*l1;
  setup.p2=setup.model*l2;
  let object_to_clip=surface_object_to_clip(item.instance_slot);
  setup.c0=object_to_clip*l0;
  setup.c1=object_to_clip*l1;
  setup.c2=object_to_clip*l2;
  setup.valid=!surface_identity_failed;
  sample_add(SAMPLE_COUNTER_setupBuilds,1u);
  return setup;
}
fn surface_setup_prepare(key:u32,thread:u32) {
  if thread<16u { atomicStore(&surface_setup_leaders[thread],0xffffffffu); surface_setup_keys[thread]=OENGINE_VISIBILITY_KEY_EMPTY; }
  workgroupBarrier();
  if oengine_visibility_key_is_valid(key) { atomicMin(&surface_setup_leaders[surface_setup_hash(key)],thread); }
  workgroupBarrier();
  if oengine_visibility_key_is_valid(key) {
    let hash=surface_setup_hash(key);
    if atomicLoad(&surface_setup_leaders[hash])==thread {
      let slot=oengine_visibility_key_meshlet_work_slot(key);
      if slot<min(meshlet_work.header.written_count,arrayLength(&meshlet_work.elements)) && meshlet_work.header.generation!=0u {
        let setup=surface_setup_direct(meshlet_work.elements[slot],oengine_visibility_key_local_primitive(key));
        let face=cross(setup.p1.xyz-setup.p0.xyz,setup.p2.xyz-setup.p0.xyz);
        if setup.valid && min(setup.c0.w,min(setup.c1.w,setup.c2.w))>1e-6 &&
          min(setup.c0.z,min(setup.c1.z,setup.c2.z))>=0.0 && dot(face,face)>1e-16 {
          surface_setups[hash]=setup; surface_setup_keys[hash]=key;
        }
      }
    }
  }
  workgroupBarrier();
}
fn surface_setup_for_work(item:OEngineMeshletRasterWork,primitive:u32)->SurfaceTriangleSetup {
  let hash=surface_setup_hash(surface_sample_key);
  if surface_setup_keys[hash]==surface_sample_key && oengine_visibility_key_is_valid(surface_sample_key) {
    let setup=surface_setups[hash];
    if !setup.valid { surface_identity_failed=true; }
    sample_add(SAMPLE_COUNTER_setupHits,1u);
    return setup;
  }
  sample_add(SAMPLE_COUNTER_setupMisses,1u);
  return surface_setup_direct(item,primitive);
}
`;

/** Names retained for the canonical material math, with only triangle invariants shared. */
export const SURFACE_TRIANGLE_SETUP_LOCAL_WGSL = /* wgsl */ `
  let setup=surface_setup_for_work(work,primitive);
  let instance=surface_instance_record(work.instance_slot);
  let ref0=setup.ref0; let ref1=setup.ref1; let ref2=setup.ref2; let model=setup.model;
  let p0=setup.p0; let p1=setup.p1; let p2=setup.p2;
  let c0=setup.c0; let c1=setup.c1; let c2=setup.c2;
`;
