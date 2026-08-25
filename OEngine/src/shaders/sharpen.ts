/**
 * sharpen：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

export {
  SHARPEN_LEGACY_FRAGMENT_WGSL as SHARPEN_WGSL,
  TEMPORAL_POST_VERTEX_WGSL as SHARPEN_VERTEX_WGSL
} from "./temporal_post_legacy.generated.js";

export const SHARPEN_FORMAT = "rgba16float" as const;
