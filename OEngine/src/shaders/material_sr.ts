/**
 * material_sr：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import { SCENE_DATABASE_READ_WGSL } from "../gpu/SceneDatabase.js";

export const MATERIAL_SR_MESH_SENTINEL = 1 << 24;

export const MATERIAL_SR_VERTEX_WGSL = /* wgsl */ `
// 使用全屏三角形覆盖目标纹理。
const POS = array<vec2f, 3>(
  vec2f(-1.0, -1.0),
  vec2f( 3.0, -1.0),
  vec2f(-1.0,  3.0)
);

struct VsOut {
  @builtin(position) pos: vec4f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var out: VsOut;
  let ndc = POS[vi];
  out.pos = vec4f(ndc, 0.0, 1.0);
  return out;
}
`;

export const MATERIAL_SR_FRAGMENT_WGSL = /* wgsl */ `
const MESH_SENTINEL: u32 = ${MATERIAL_SR_MESH_SENTINEL}u;
${SCENE_DATABASE_READ_WGSL}

@group(0) @binding(0) var mesh_texture: texture_2d<u32>;
// Full paged scene_database; scene_read_mesh resolves lookup/page/slot.
@group(1) @binding(0) var<storage, read> mesh_table: array<u32>;

struct FsOut {
  @builtin(frag_depth) depth: f32,
};

// 从场景数据库的网格记录中读取材质编号。
@fragment
fn fs_main(@builtin(position) coord: vec4f) -> FsOut {
  var out: FsOut;
  let mesh_id = textureLoad(mesh_texture, vec2i(coord.xy), 0).r;
  if (mesh_id == MESH_SENTINEL) {
    // 无效网格写入最远深度。
    out.depth = 1.0;
    return out;
  }
  // 将 24 位材质编号归一化后写入深度通道。
  let mat_id = scene_read_mesh(&mesh_table, mesh_id).material;
  out.depth = f32(mat_id) / 16777216.0;
  return out;
}
`;

export const MATERIAL_SR_WGSL = /* wgsl */ `
${MATERIAL_SR_VERTEX_WGSL}
${MATERIAL_SR_FRAGMENT_WGSL}
`;
