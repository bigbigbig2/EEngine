import { GPU_INSTANCE_RECORD_WGSL } from "../gpu/GpuInstanceAbi.js";
import { GPU_FRAME_INSTANCE_WGSL } from "../gpu/GpuFrameInstanceAbi.js";
import { GPU_MESHLET_RASTER_WORK_WGSL } from "../gpu/GpuMeshletRasterWorkAbi.js";
import { GPU_VISIBILITY_KEY_WGSL } from "../gpu/GpuVisibilityKeyAbi.js";
import { WINNER_INTERPOLATION_WGSL } from "./winner_interpolation.js";
import { surfaceGeometryDecodeWgsl } from "./surface_geometry_reader.js";
import { SURFACE_CELL_GEOMETRY_WGSL, surfaceCellGeometryArenaWgsl } from "../gpu/GpuSurfaceCellGeometryAbi.js";
import { SURFACE_CELL_TILE_PLAN_BYTES } from "../gpu/GpuSurfaceCellPlanAbi.js";

/** Geometry-owned setup math, shared between admitted build and bounded direct
 * address misses. No second GeometryRecord writer; no per-pixel material probe.
 * Per-corner world normals remain unnormalized until interpolation, preserving
 * the existing inverse-transpose consumer math under nonuniform scale. */
export function surfaceCellGeometryMathWgsl(product: boolean, includeDecoder = true): string {
  if (!includeDecoder) {
    return `${GPU_INSTANCE_RECORD_WGSL}\n${GPU_FRAME_INSTANCE_WGSL}\n${GPU_MESHLET_RASTER_WORK_WGSL}\n${GPU_VISIBILITY_KEY_WGSL}\n${WINNER_INTERPOLATION_WGSL}\n${SURFACE_CELL_GEOMETRY_WGSL}`;
  }
  return /* wgsl */ `
${GPU_INSTANCE_RECORD_WGSL}
${GPU_FRAME_INSTANCE_WGSL}
${GPU_MESHLET_RASTER_WORK_WGSL}
${GPU_VISIBILITY_KEY_WGSL}
${WINNER_INTERPOLATION_WGSL}
${SURFACE_CELL_GEOMETRY_WGSL}
${surfaceGeometryDecodeWgsl(product, "source_heap")}
fn cell_setup_normal(v:vec3f,fallback:vec3f)->vec3f {let l=dot(v,v);if l>1e-20{return v*inverseSqrt(l);}return fallback;}
fn cell_build_geometry_setup(key:u32)->CellGeometrySetup {
 var result:CellGeometrySetup;result.source.x=key;
 let decoded=oengine_visibility_key_resolve(key,meshlet_work.header.generation,meshlet_work.header.written_count);
 if decoded.valid==0u{return result;}
 let work=meshlet_work.elements[decoded.meshlet_work_slot];let instance=frame_instances[work.instance_slot];
 let count=surface_source_load(work);if decoded.local_primitive>=count.y{return result;}
 result.identity=vec4u(work.instance_slot,instance.source.instance_set_generation,work.geometry_slot,0u);
 result.source=vec4u(key,work.material_slot_or_range,oengine_instance_geometry_generation(instance.source),instance.source.dynamic_revision);
 result.source_address=vec4u(decoded.meshlet_work_slot,decoded.local_primitive,work.meshlet_slot,instance.source.flags);
 result.continuity=surface_source_continuity(decoded.local_primitive,count.y);
 let transform=oengine_instance_current_object_to_world(instance.source);
 let normals=mat3x3f(instance.normal_x.xyz,instance.normal_y,instance.normal_z.xyz)*sign(instance.normal_x.w);
 var clips:array<vec4f,3>;
 for(var corner=0u;corner<3u;corner++){
  let vertex=surface_source_triangle_corner(decoded.local_primitive,corner);let at=corner*6u;
  let position=surface_source_vertex_position(vertex);clips[corner]=instance.object_to_clip*vec4f(position,1.0);
  let normal=surface_source_vertex_normal(vertex);let tangent=surface_source_vertex_tangent(vertex);
  result.corners[at]=vec4f(normals*normal.xyz,normal.w);
  result.corners[at+1u]=vec4f((transform*vec4f(tangent.xyz,0.0)).xyz,tangent.w*sign(instance.normal_x.w));
  result.corners[at+2u]=vec4f(surface_source_vertex_uv(vertex,0u),surface_source_vertex_uv(vertex,1u));
  result.corners[at+3u]=surface_source_vertex_color(vertex);
  result.corners[at+4u]=vec4f(surface_source_vertex_uv(vertex,2u),0.0,0.0);
  result.corners[at+5u]=transform*vec4f(position,1.0);
 }
 result.coefficients=winner_build_coefficients(clips[0],clips[1],clips[2]);
 let a=result.corners[5u].xyz;let b=result.corners[11u].xyz;let c=result.corners[17u].xyz;
 let raw=cross(b-a,c-a);let normal=cell_setup_normal(raw,vec3f(0.0,0.0,1.0));
 result.world_plane=vec4f(normal,-dot(normal,a));
 // Side is an exact current geometric facing fact. Shading-normal flip and
 // mapped-normal uncertainty are separately constrained by signal predicates.
 let clip_a=clips[0];let clip_b=clips[1];let clip_c=clips[2];
 let ha=vec3f(clip_a.xy,clip_a.w);let hb=vec3f(clip_b.xy,clip_b.w);let hc=vec3f(clip_c.xy,clip_c.w);
 result.identity.w=select(0u,1u,dot(ha,cross(hb,hc))*sign(instance.normal_x.w)<0.0);
 result.variation=bitcast<vec4f>(result.continuity[2u]);
 // Winner coefficients alone decide raster interpolation validity. A singular
 // normal transform uses the geometric fallback at the sole value producer;
 // it must not erase a visible triangle's position/UV/color coverage.
 return result;
}
`;
}

/** Reset -> sorted tile runs -> guaranteed local build -> consume.
 * One explicit reference per covered leaf; no hash admission on the mandatory
 * path. Baseline f32/storage atomics and 64 invocations, no global spin. */
export function surfaceCellGeometrySetupWgsl(product: boolean,referenceCapacity = 65536): string {
  return /* wgsl */ `
struct CellGeometrySettings {
 width:u32,height:u32,tiles_x:u32,first_tile:u32,
 tile_count:u32,reference_capacity:u32,setup_capacity:u32,generation:u32,
 frame_at:u32,directory_at:u32,reserved0:u32,reserved1:u32,
 source:vec4u,source_payload:vec4u,
}
@group(0) @binding(0) var<uniform> settings:CellGeometrySettings;
@group(0) @binding(1) var<storage,read> meshlet_work:OEngineMeshletWorkQueueRead;
@group(0) @binding(2) var<storage,read> source_heap:array<u32>;
@group(0) @binding(3) var<storage,read> vertex_payload:array<u32>;
@group(0) @binding(4) var<storage,read> frame_instances:array<OEngineFrameInstanceRecord>;
${product ? `@group(0) @binding(5) var<storage,read> product_heap:array<u32>;
${Array.from({length:4},(_,i)=>`@group(0) @binding(${i+6}) var<storage,read> product_bank_${i}:array<u32>;`).join("\n")}` : ""}
@group(1) @binding(0) var<storage,read_write> geometry_arena:CellGeometryArena;
@group(1) @binding(2) var<storage,read_write> setup_counts:array<atomic<u32>>;
@group(1) @binding(3) var setup_visibility:texture_2d<u32>;
@group(1) @binding(4) var<storage,read_write> setup_indirect:array<u32>;
@group(1) @binding(5) var<storage,read> setup_workspace:array<u32>;
struct CellGeometryMemoEntry {
  state: atomic<u32>, key: u32, generation: u32, reserved: u32,
  setup: CellGeometrySetup,
}
@group(1) @binding(6) var<storage,read_write> setup_memo:array<CellGeometryMemoEntry>;
${surfaceCellGeometryMathWgsl(product)}
${surfaceCellGeometryArenaWgsl(referenceCapacity,true)}
fn cell_setup_hash(key:u32)->u32 {var v=key;v^=v>>16u;v*=0x7feb352du;v^=v>>15u;v*=0x846ca68bu;return v^(v>>16u);}
@compute @workgroup_size(64) fn reset_cell_geometry(@builtin(global_invocation_id) id:vec3u){
 if id.x<settings.reference_capacity{geometry_arena.references[id.x].key=0xffffffffu;geometry_arena.references[id.x].slot=0xffffffffu;}
 if id.x<8u{atomicStore(&setup_counts[id.x],0u);}
 if settings.first_tile == 0u && id.x < settings.reserved0 {
   atomicStore(&setup_memo[id.x].state, 0u);
 }
}
var<workgroup> request_keys: array<vec2u, 64>;
var<workgroup> request_runs: array<u32, 64>;
var<workgroup> request_base: u32;
var<workgroup> request_mixed: atomic<u32>;
var<workgroup> request_uniform: u32;
@compute @workgroup_size(64)
fn request_cell_geometry(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  if group.x >= settings.tile_count { return; }
  let at = 128u + group.x * ${SURFACE_CELL_TILE_PLAN_BYTES / 4}u;
  let pixel = vec2u(setup_workspace[at] + lane % 8u, setup_workspace[at + 1u] + lane / 8u);
  var key = 0xffffffffu;
  if pixel.x < settings.width && pixel.y < settings.height {
    key = textureLoad(setup_visibility, vec2i(pixel), 0).x;
  }
  request_keys[lane] = vec2u(key, lane);
  if lane == 0u { atomicStore(&request_mixed,0u); }
  workgroupBarrier();
  let coverage_low = setup_workspace[at+2u];
  let first = select(firstTrailingBit(coverage_low),32u+firstTrailingBit(setup_workspace[at+3u]),coverage_low==0u);
  let root = request_keys[first].x;
  if key != 0xffffffffu && key != root { atomicOr(&request_mixed,1u); }
  workgroupBarrier();
  if lane == 0u { request_uniform=atomicLoad(&request_mixed); }
  let mixed = workgroupUniformLoad(&request_uniform);
  if mixed == 0u {
    if lane == 0u { request_base=atomicAdd(&setup_counts[0],1u); }
    workgroupBarrier();
    let leaf=group.x*64u+lane;
    geometry_arena.references[leaf].key=key;
    geometry_arena.references[leaf].slot=select(0xffffffffu,request_base,key!=0xffffffffu);
    if lane == first { geometry_arena.setups[request_base].source.x=root; }
    return;
  }
  // Every comparison reads the previous network step before any lane writes.
  // Equal winners use the original lane as an exact deterministic tie break.
  for (var level = 2u; level <= 64u; level <<= 1u) {
    for (var distance = level >> 1u; distance > 0u; distance >>= 1u) {
      let left = request_keys[lane];
      let right = request_keys[lane ^ distance];
      let greater = left.x > right.x || (left.x == right.x && left.y > right.y);
      let take_minimum = ((lane & level) == 0u) == ((lane & distance) == 0u);
      let next = select(left, right, greater == take_minimum);
      workgroupBarrier();
      request_keys[lane] = next;
      workgroupBarrier();
    }
  }
  let sorted = request_keys[lane];
  var leader = sorted.x != 0xffffffffu;
  if lane > 0u { leader = leader && request_keys[lane - 1u].x != sorted.x; }
  request_runs[lane] = select(0u, 1u, leader);
  workgroupBarrier();
  // Inclusive run prefix. Snapshot reads before writes at every step.
  for (var distance = 1u; distance < 64u; distance <<= 1u) {
    var next = request_runs[lane];
    if lane >= distance { next += request_runs[lane - distance]; }
    workgroupBarrier();
    request_runs[lane] = next;
    workgroupBarrier();
  }
  if lane == 0u { request_base = atomicAdd(&setup_counts[0], request_runs[63u]); }
  workgroupBarrier();
  // Sum of tile run counts cannot exceed R. Local slots never compete for
  // hash admission, and the explicit per-leaf reference survives permutation.
  let slot = select(0xffffffffu, request_base + request_runs[lane] - 1u, sorted.x != 0xffffffffu);
  let leaf = group.x * 64u + sorted.y;
  geometry_arena.references[leaf].key=sorted.x;
  geometry_arena.references[leaf].slot = slot;
  if leader { geometry_arena.setups[slot].source.x = sorted.x; }
}
@compute @workgroup_size(64)
fn build_cell_geometry(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= atomicLoad(&setup_counts[0]) { return; }
  let key = geometry_arena.setups[id.x].source.x;
  let start = cell_setup_hash(key) & (settings.reserved0 - 1u);
  var result: CellGeometrySetup;
  var hit = false;
  // Only entries committed by an earlier batch are read. Memo admission has
  // no authority over the guaranteed local reference or output coverage.
  for (var probe = 0u; probe < 4u; probe++) {
    let entry = (start + probe) & (settings.reserved0 - 1u);
    if atomicLoad(&setup_memo[entry].state) == 2u &&
      setup_memo[entry].generation == settings.generation && setup_memo[entry].key == key {
      result = setup_memo[entry].setup;
      hit = true;
      break;
    }
  }
  if hit { atomicAdd(&setup_counts[5], 1u); }
  else {
    result = cell_build_geometry_setup(key);
    atomicAdd(&setup_counts[6], 1u);
  }
  result.reserved[0u].x = 0xffffffffu;
  result.reserved[0u].y = select(0u, 1u, hit);
  geometry_arena.setups[id.x] = result;
  if result.coefficients.row0.w != 0.0 { atomicAdd(&setup_counts[1], 1u); }
  else { atomicAdd(&setup_counts[4], 1u); }
}
@compute @workgroup_size(64)
fn publish_cell_geometry_memo(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= atomicLoad(&setup_counts[0]) { return; }
  let result = geometry_arena.setups[id.x];
  if result.reserved[0u].y != 0u { return; }
  let start = cell_setup_hash(result.source.x) & (settings.reserved0 - 1u);
  for (var probe = 0u; probe < 4u; probe++) {
    let entry = (start + probe) & (settings.reserved0 - 1u);
    let claim = atomicCompareExchangeWeak(&setup_memo[entry].state, 0u, 1u);
    if !claim.exchanged { continue; }
    setup_memo[entry].key = result.source.x;
    setup_memo[entry].generation = settings.generation;
    setup_memo[entry].setup = result;
    geometry_arena.setups[id.x].reserved[0u].x = entry;
    return;
  }
  atomicAdd(&setup_counts[7], 1u);
}
@compute @workgroup_size(64)
fn commit_cell_geometry_memo(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= settings.setup_capacity || id.x >= atomicLoad(&setup_counts[0]) { return; }
  let entry = geometry_arena.setups[id.x].reserved[0u].x;
  if entry != 0xffffffffu { atomicStore(&setup_memo[entry].state, 2u); }
}
@compute @workgroup_size(1) fn finalize_cell_geometry(){
 let count=min(atomicLoad(&setup_counts[0]),settings.setup_capacity);
 setup_indirect[0]=(count+63u)/64u;setup_indirect[1]=1u;setup_indirect[2]=1u;setup_indirect[3]=count;
}
`.replaceAll("geometry_setups[","geometry_arena.setups[");
}
