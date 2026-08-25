/**
 * material_bucket_wgsl：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

import {
  BUCKET_ALPHA_BITS,
  BUCKET_DRAW_MODE_BITS,
  BUCKET_DRAW_MODE_SHIFT,
  BUCKET_SIDE_BITS,
  BUCKET_SIDE_SHIFT
} from "../material/materialBucketId.js";

export function rasterizationMaterialBucketWgsl(): string {
  return /* wgsl */ `
fn rasterization_material_bucket(alpha_mode: u32, draw_mode: u32, side: u32) -> u32 {
  return ((alpha_mode & ${BUCKET_ALPHA_BITS}u) << 0u)
    | ((draw_mode & ${BUCKET_DRAW_MODE_BITS}u) << ${BUCKET_DRAW_MODE_SHIFT}u)
    | ((side & ${BUCKET_SIDE_BITS}u) << ${BUCKET_SIDE_SHIFT}u);
}
`;
}
