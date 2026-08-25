/**
 * MeshletTypes：负责几何数据、Meshlet 或空间结构处理。
 */

export function encode_meshlet_element(
  meshlet_id: number,
  local_tri: number
): number {
  return (
    (((meshlet_id >>> 0) & 0x00ffffff) << 8) | ((local_tri >>> 0) & 0xff)
  ) >>> 0;
}

export function decode_meshlet_element(packed: number): {
  meshlet_id: number;
  local_tri: number;
} {
  const p = packed >>> 0;
  return {
    meshlet_id: p >>> 8,
    local_tri: p & 0xff
  };
}

export const MESHLET_ELEMENT_WGSL = /* wgsl */ `
// 将 Meshlet 编号和局部三角形编号打包到一个 u32。
fn encode_meshlet_element(meshlet_id: u32, local_tri: u32) -> u32 {
  return ((meshlet_id & 0x00FFFFFFu) << 8u) | (local_tri & 0xFFu);
}

// 从打包值中恢复 Meshlet 编号和局部三角形编号。
fn decode_meshlet_element(packed: u32) -> vec2u {
  return vec2u(packed >> 8u, packed & 0xFFu);
}
`;
