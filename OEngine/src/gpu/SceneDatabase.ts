/**
 * 场景数据库：以 GPU 可读取的紧凑结构保存节点、实例和层级关系。
 */

import { ArrayType, CodeChunk, WGSL_f32, WGSL_mat4x4f, WGSL_u32, WGSL_vec3f, WGSL_vec4f } from "../core/WebGPUTypes.js";
import { StructType } from "../core/WgslStruct.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import { LPV_CAMERA_TYPE } from "../shaders/lpv_indirect_diffuse.js";
import {
  GPUDatabase,
  GPUDatabaseDefinition,
  type GPUTypedTable
} from "./GPUDatabase.js";
import type { GraphicsContext } from "./GraphicsContext.js";

export type MeshTableRow = {
  geometry: number;
  material: number;
  node: number;
  bounding_box: Float32Array | ArrayLike<number>;
  bounding_sphere: Float32Array | ArrayLike<number>;
};

export type TransformTableRow = {
  local_translation: Float32Array | ArrayLike<number>;
  local_rotation: Float32Array | ArrayLike<number>;
  local_scale: Float32Array | ArrayLike<number>;
  global: Float32Array | ArrayLike<number>;
  prev_global: Float32Array | ArrayLike<number>;
  parent: number;
};

export type GpuBufferSlice = {
  buffer: GPUBuffer;
  offset: number;
  size: number;
};

export const SCENE_MESH_TYPE = StructType.from(
  {
    geometry: WGSL_u32,
    material: WGSL_u32,
    node: WGSL_u32,
    bounding_box: ArrayType.from(WGSL_f32, 6),
    bounding_sphere: WGSL_vec4f
  },
  "CascadedSceneShadowmap"
).pack();

export const SCENE_TRANSFORM_TYPE = StructType.from({
  local_translation: WGSL_vec3f,
  local_rotation: WGSL_vec4f,
  local_scale: WGSL_vec3f,
  global: WGSL_mat4x4f,
  prev_global: WGSL_mat4x4f,
  parent: WGSL_u32
}).pack();

export const SCENE_DATABASE_DEFINITION = GPUDatabaseDefinition.from({
  meshes: SCENE_MESH_TYPE,
  transforms: SCENE_TRANSFORM_TYPE
});

export const SCENE_MESH_DESCRIPTOR =
  SCENE_DATABASE_DEFINITION.get("meshes")!;
export const SCENE_TRANSFORM_DESCRIPTOR =
  SCENE_DATABASE_DEFINITION.get("transforms")!;

export const MESH_STRIDE_BYTES = SCENE_MESH_TYPE.size;
export const MESH_STRIDE_U32 = MESH_STRIDE_BYTES / 4;
export const TRANSFORM_STRIDE_BYTES = SCENE_TRANSFORM_TYPE.size;
export const TRANSFORM_STRIDE_F32 = TRANSFORM_STRIDE_BYTES / 4;
export const TRANSFORM_GLOBAL_F32_OFFSET =
  SCENE_TRANSFORM_TYPE.get("global").offset / 4;
export const TRANSFORM_PREV_GLOBAL_F32_OFFSET =
  SCENE_TRANSFORM_TYPE.get("prev_global").offset / 4;
export const TRANSFORM_PARENT_U32_OFFSET =
  SCENE_TRANSFORM_TYPE.get("parent").offset / 4;

const sceneReadChunk = CodeChunk.from(
  `
fn scene_read_mesh(
    database: ptr<storage, array<u32>>,
    i: u32,
) -> ${SCENE_MESH_TYPE.wgsl_ref} {
    return ${SCENE_MESH_DESCRIPTOR.marshalling_method_read}(database, i);
}

fn scene_read_node(
    database: ptr<storage, array<u32>>,
    node_id: u32,
) -> ${SCENE_TRANSFORM_TYPE.wgsl_ref} {
    return ${SCENE_TRANSFORM_DESCRIPTOR.marshalling_method_read}(database, node_id);
}
`,
  [
    SCENE_MESH_DESCRIPTOR.chunk_read,
    SCENE_TRANSFORM_DESCRIPTOR.chunk_read
  ]
);

const sceneReadWriteChunk = CodeChunk.from(
  `
fn scene_read_mesh_rw(
    database: ptr<storage, array<u32>, read_write>,
    i: u32,
) -> ${SCENE_MESH_TYPE.wgsl_ref} {
    return ${SCENE_MESH_DESCRIPTOR.marshalling_method_read_rw}(database, i);
}

fn scene_read_node_rw(
    database: ptr<storage, array<u32>, read_write>,
    node_id: u32,
) -> ${SCENE_TRANSFORM_TYPE.wgsl_ref} {
    return ${SCENE_TRANSFORM_DESCRIPTOR.marshalling_method_read_rw}(database, node_id);
}

fn scene_write_mesh(
    database: ptr<storage, array<u32>, read_write>,
    i: u32,
    value: ${SCENE_MESH_TYPE.wgsl_ref},
) {
    ${SCENE_MESH_DESCRIPTOR.marshalling_method_write}(database, i, value);
}

fn scene_write_node(
    database: ptr<storage, array<u32>, read_write>,
    node_id: u32,
    value: ${SCENE_TRANSFORM_TYPE.wgsl_ref},
) {
    ${SCENE_TRANSFORM_DESCRIPTOR.marshalling_method_write}(database, node_id, value);
}

fn scene_write_node_local_translation(database: ptr<storage, array<u32>, read_write>, node_id: u32, value: vec3<f32>) {
    ${SCENE_TRANSFORM_DESCRIPTOR.marshalling_method_write_field("local_translation")}(database, node_id, value);
}

fn scene_write_node_local_rotation(database: ptr<storage, array<u32>, read_write>, node_id: u32, value: vec4<f32>) {
    ${SCENE_TRANSFORM_DESCRIPTOR.marshalling_method_write_field("local_rotation")}(database, node_id, value);
}

fn scene_write_node_local_scale(database: ptr<storage, array<u32>, read_write>, node_id: u32, value: vec3<f32>) {
    ${SCENE_TRANSFORM_DESCRIPTOR.marshalling_method_write_field("local_scale")}(database, node_id, value);
}

fn scene_write_node_global(database: ptr<storage, array<u32>, read_write>, node_id: u32, value: mat4x4<f32>) {
    ${SCENE_TRANSFORM_DESCRIPTOR.marshalling_method_write_field("global")}(database, node_id, value);
}

fn scene_write_node_prev_global(database: ptr<storage, array<u32>, read_write>, node_id: u32, value: mat4x4<f32>) {
    ${SCENE_TRANSFORM_DESCRIPTOR.marshalling_method_write_field("prev_global")}(database, node_id, value);
}

fn scene_write_mesh_bounding_box(database: ptr<storage, array<u32>, read_write>, mesh_id: u32, value: array<f32, 6>) {
    ${SCENE_MESH_DESCRIPTOR.marshalling_method_write_field("bounding_box")}(database, mesh_id, value);
}

fn scene_write_mesh_bounding_sphere(database: ptr<storage, array<u32>, read_write>, mesh_id: u32, value: vec4<f32>) {
    ${SCENE_MESH_DESCRIPTOR.marshalling_method_write_field("bounding_sphere")}(database, mesh_id, value);
}
`,
  [
    SCENE_MESH_DESCRIPTOR.chunk_read_rw,
    SCENE_TRANSFORM_DESCRIPTOR.chunk_read_rw,
    SCENE_MESH_DESCRIPTOR.chunk_write,
    SCENE_TRANSFORM_DESCRIPTOR.chunk_write,
    SCENE_TRANSFORM_DESCRIPTOR.wgsl_gen_write_field_code(
      "local_translation"
    ),
    SCENE_TRANSFORM_DESCRIPTOR.wgsl_gen_write_field_code(
      "local_rotation"
    ),
    SCENE_TRANSFORM_DESCRIPTOR.wgsl_gen_write_field_code(
      "local_scale"
    ),
    SCENE_TRANSFORM_DESCRIPTOR.wgsl_gen_write_field_code("global"),
    SCENE_TRANSFORM_DESCRIPTOR.wgsl_gen_write_field_code(
      "prev_global"
    ),
    SCENE_MESH_DESCRIPTOR.wgsl_gen_write_field_code("bounding_box"),
    SCENE_MESH_DESCRIPTOR.wgsl_gen_write_field_code(
      "bounding_sphere"
    )
  ]
);

export const SCENE_DATABASE_READ_CHUNK = sceneReadChunk;
export const SCENE_DATABASE_READ_WRITE_CHUNK = sceneReadWriteChunk;
export const SCENE_DATABASE_READ_WGSL = sceneReadChunk.compile().text;
export const SCENE_DATABASE_READ_WRITE_WGSL =
  sceneReadWriteChunk.compile().text;

export const SCENE_MESH_FRUSTUM_FILTER_WORKGROUP_SIZE = 128;
const sceneMeshFrustumIteratorPrefix =
  SCENE_MESH_DESCRIPTOR.page_iterator_symbol_prefix(
    SCENE_MESH_FRUSTUM_FILTER_WORKGROUP_SIZE
  );
function sceneMeshFrustumFilterChunk(
  cameraDeclaration: string,
  cameraType: string,
  outputGroup: number,
  outputBinding: number
): CodeChunk {
  return CodeChunk.from(
    `
${cameraDeclaration}
struct SceneMeshFilterOutput {
  count: atomic<u32>,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<u32>,
}

struct SceneMeshFilterAabb {
  min: vec3<f32>,
  max: vec3<f32>,
}

fn sphere_intersects_frustum(
  sphere: vec4<f32>,
  frustum: array<vec4<f32>, 6>,
) -> bool {
  var result = true;
  for (var plane_index = 0; plane_index < 6; plane_index++) {
    let plane = frustum[plane_index];
    let distance = dot(plane.xyz, sphere.xyz) + plane.w;
    result &= distance > -sphere.w;
  }
  return result;
}

fn array_to_filter_aabb(source: array<f32, 6>) -> SceneMeshFilterAabb {
  return SceneMeshFilterAabb(
    vec3<f32>(source[0], source[1], source[2]),
    vec3<f32>(source[3], source[4], source[5]),
  );
}

fn filter_aabb_below_plane(aabb: SceneMeshFilterAabb, plane: vec4<f32>) -> bool {
  let normal = plane.xyz;
  let far = select(aabb.min, aabb.max, normal > vec3(0.0));
  return dot(far, normal) < -plane.w;
}

fn filter_aabb_intersects_frustum(
  aabb: SceneMeshFilterAabb,
  frustum: array<vec4<f32>, 6>,
) -> bool {
  for (var plane_index = 0; plane_index < 6; plane_index++) {
    if (filter_aabb_below_plane(aabb, frustum[plane_index])) {
      return false;
    }
  }
  return true;
}

@group(0) @binding(0) var<uniform> camera: ${cameraType};
@group(0) @binding(1) var<storage, read> scene_database: array<u32>;
@group(${outputGroup}) @binding(${outputBinding}) var<storage, read_write> output: SceneMeshFilterOutput;

var<workgroup> wg_visible_count: atomic<u32>;
var<workgroup> wg_global_offset: u32;

@compute @workgroup_size(${SCENE_MESH_FRUSTUM_FILTER_WORKGROUP_SIZE})
fn main(
  @builtin(workgroup_id) workgroup_id: vec3<u32>,
  @builtin(local_invocation_index) local_id: u32,
) {
  if !${sceneMeshFrustumIteratorPrefix}_setup(
    &scene_database,
    workgroup_id.x,
    local_id,
  ) {
    return;
  }

  let slot_in_page = ${sceneMeshFrustumIteratorPrefix}_slot_in_page(local_id);
  var local_visible_index = ~0u;
  if slot_in_page < ${sceneMeshFrustumIteratorPrefix}_ELEMENTS_PER_PAGE
    && ${sceneMeshFrustumIteratorPrefix}_is_occupied(slot_in_page) {
    let mesh = ${sceneMeshFrustumIteratorPrefix}_read(
      &scene_database,
      slot_in_page,
    );
    if sphere_intersects_frustum(mesh.bounding_sphere, camera.frustum) {
      let bounds = array_to_filter_aabb(mesh.bounding_box);
      if filter_aabb_intersects_frustum(bounds, camera.frustum) {
        local_visible_index = atomicAdd(&wg_visible_count, 1u);
      }
    }
  }

  workgroupBarrier();
  if local_id == 0u {
    let visible_count = atomicLoad(&wg_visible_count);
    if visible_count > 0u {
      wg_global_offset = atomicAdd(&output.count, visible_count);
    }
  }
  workgroupBarrier();

  if local_visible_index == ~0u {
    return;
  }
  let mesh_row = ${sceneMeshFrustumIteratorPrefix}_slot_to_index(slot_in_page);
  let output_index = wg_global_offset + local_visible_index;
  if output_index < arrayLength(&output.elements) {
    output.elements[output_index] = mesh_row;
  }
}
`,
    [
      SCENE_MESH_DESCRIPTOR.chunk_iterate(
        SCENE_MESH_FRUSTUM_FILTER_WORKGROUP_SIZE
      )
    ]
  );
}

export const SCENE_MESH_FRUSTUM_FILTER_CHUNK = sceneMeshFrustumFilterChunk(
  LPV_CAMERA_TYPE.wgsl_declaration,
  LPV_CAMERA_TYPE.wgsl_ref,
  1,
  0
);
export const SCENE_MESH_FRUSTUM_FILTER_WGSL =
  SCENE_MESH_FRUSTUM_FILTER_CHUNK.compile().text;

export const SHADOW_SCENE_MESH_FRUSTUM_FILTER_CHUNK =
  sceneMeshFrustumFilterChunk(
    `struct SceneMeshFilterCamera {
  frustum: array<vec4<f32>, 6>,
}`,
    "SceneMeshFilterCamera",
    0,
    2
  );
export const SHADOW_SCENE_MESH_FRUSTUM_FILTER_WGSL =
  SHADOW_SCENE_MESH_FRUSTUM_FILTER_CHUNK.compile().text;

export const SCENE_MESH_SPHERE_FILTER_WORKGROUP_SIZE = 128;
const sceneMeshSphereIteratorPrefix =
  SCENE_MESH_DESCRIPTOR.page_iterator_symbol_prefix(
    SCENE_MESH_SPHERE_FILTER_WORKGROUP_SIZE
  );
export const SCENE_MESH_SPHERE_FILTER_CHUNK = CodeChunk.from(
  `
struct SceneMeshSphereFilterOutput {
  count: atomic<u32>,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  elements: array<u32>,
}

fn sphere_intersects_sphere(a: vec4<f32>, b: vec4<f32>) -> bool {
  let center_distance = length(a.xyz - b.xyz);
  let radius_sum = a.w + b.w;
  return center_distance < radius_sum;
}

@group(0) @binding(0) var<uniform> sphere: vec4<f32>;
@group(0) @binding(1) var<storage, read> scene_database: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: SceneMeshSphereFilterOutput;

var<workgroup> wg_visible_count: atomic<u32>;
var<workgroup> wg_global_offset: u32;

@compute @workgroup_size(${SCENE_MESH_SPHERE_FILTER_WORKGROUP_SIZE})
fn main(
  @builtin(workgroup_id) workgroup_id: vec3<u32>,
  @builtin(local_invocation_index) local_id: u32,
) {
  if !${sceneMeshSphereIteratorPrefix}_setup(
    &scene_database,
    workgroup_id.x,
    local_id,
  ) {
    return;
  }

  let slot_in_page = ${sceneMeshSphereIteratorPrefix}_slot_in_page(local_id);
  var local_visible_index = ~0u;
  if slot_in_page < ${sceneMeshSphereIteratorPrefix}_ELEMENTS_PER_PAGE
    && ${sceneMeshSphereIteratorPrefix}_is_occupied(slot_in_page) {
    let mesh = ${sceneMeshSphereIteratorPrefix}_read(
      &scene_database,
      slot_in_page,
    );
    if sphere_intersects_sphere(mesh.bounding_sphere, sphere) {
      local_visible_index = atomicAdd(&wg_visible_count, 1u);
    }
  }

  workgroupBarrier();
  if local_id == 0u {
    let visible_count = atomicLoad(&wg_visible_count);
    if visible_count > 0u {
      wg_global_offset = atomicAdd(&output.count, visible_count);
    }
  }
  workgroupBarrier();

  if local_visible_index == ~0u {
    return;
  }
  let mesh_row = ${sceneMeshSphereIteratorPrefix}_slot_to_index(slot_in_page);
  let output_index = wg_global_offset + local_visible_index;
  if output_index < arrayLength(&output.elements) {
    output.elements[output_index] = mesh_row;
  }
}
`,
  [
    SCENE_MESH_DESCRIPTOR.chunk_iterate(
      SCENE_MESH_SPHERE_FILTER_WORKGROUP_SIZE
    )
  ]
);
export const SCENE_MESH_SPHERE_FILTER_WGSL =
  SCENE_MESH_SPHERE_FILTER_CHUNK.compile().text;

export class SceneDatabase extends GPUDatabase {
  private reverseDo = new Uint32Array(0);

  constructor(graphics: GraphicsContext) {
    const device = graphics.device;
    if (device === null) {
      throw new Error("SceneDatabase: GraphicsContext has no device");
    }
    super({
      device,
      definition: SCENE_DATABASE_DEFINITION
    });
  }

  get meshes(): GPUTypedTable<MeshTableRow> {
    return this.get("meshes") as GPUTypedTable<MeshTableRow>;
  }

  get transforms(): GPUTypedTable<TransformTableRow> {
    return this.get("transforms") as GPUTypedTable<TransformTableRow>;
  }

  get meshCount(): number {
    return this.meshes.count;
  }

  get transformCount(): number {
    return this.transforms.count;
  }

  get reverseDoTable(): Uint32Array {
    return this.reverseDo;
  }

  get meshSlice(): GpuBufferSlice {
    return { buffer: this.buffer, offset: 0, size: this.buffer.size };
  }

  get transformSlice(): GpuBufferSlice {
    return { buffer: this.buffer, offset: 0, size: this.buffer.size };
  }

  get transformBuffer(): GPUBuffer {
    return this.buffer;
  }

  clear(): void {
    this.meshes.clear();
    this.transforms.clear();
  }

  resizeReverseMapping(meshCount: number): void {
    const next = new Uint32Array(2 * Math.max(0, meshCount | 0));
    next.set(this.reverseDo.subarray(0, next.length));
    this.reverseDo = next;
  }

  addTransform(row: TransformTableRow): number {
    return this.transforms.add(row);
  }

  setTransform(id: number, row: TransformTableRow): void {
    this.transforms.set(id, row);
  }

  addMesh(
    row: MeshTableRow,
    cpuMeshId: number,
    version: number
  ): number {
    const id = this.meshes.add(row);
    if ((id + 1) * 2 > this.reverseDo.length) {
      throw new RangeError(
        `Scene reverse mapping is not sized for mesh row ${id}`
      );
    }
    this.reverseDo[id * 2] = cpuMeshId >>> 0;
    this.reverseDo[id * 2 + 1] = version >>> 0;
    return id;
  }

  setMesh(
    id: number,
    row: MeshTableRow,
    cpuMeshId: number,
    version: number
  ): void {
    if ((id + 1) * 2 > this.reverseDo.length) {
      throw new RangeError(
        `Scene reverse mapping is not sized for mesh row ${id}`
      );
    }
    this.meshes.set(id, row);
    this.reverseDo[id * 2] = cpuMeshId >>> 0;
    this.reverseDo[id * 2 + 1] = version >>> 0;
  }

  getMeshMaterial(row: number): number {
    return this.meshes.get(row)?.material ?? 0;
  }

  getMeshGeometry(row: number): number | undefined {
    return this.meshes.get(row)?.geometry;
  }

  getMeshNode(row: number): number {
    return this.meshes.get(row)?.node ?? 0;
  }

  getMeshBoundingBox(row: number, out: Float32Array): boolean {
    const value = this.meshes.get(row);
    if (value === undefined) return false;
    for (let i = 0; i < 6; i++) {
      out[i] = value.bounding_box[i] ?? 0;
    }
    return true;
  }

  getTransformGlobal(node: number, out: Float32Array): boolean {
    const value = this.transforms.get(node);
    if (value === undefined) return false;
    for (let i = 0; i < 16; i++) {
      out[i] = value.global[i] ?? 0;
    }
    return true;
  }

  readMeshRow(
    id: number
  ): (MeshTableRow & { cpu_mesh_id: number; version: number }) | null {
    const value = this.meshes.get(id);
    if (value === undefined) return null;
    return {
      ...value,
      cpu_mesh_id: this.reverseDo[id * 2] ?? 0,
      version: this.reverseDo[id * 2 + 1] ?? 0
    };
  }

  override update(command: ShadeGPUCommandContext): void {
    super.update(command);
  }
}
