/**
 * taa：定义对应渲染阶段使用的 WGSL 着色器代码。
 */

export {
  TAA_LEGACY_FRAGMENT_SHA256,
  TAA_LEGACY_FRAGMENT_WGSL as TAA_WGSL,
  TEMPORAL_POST_VERTEX_SHA256 as TAA_LEGACY_VERTEX_SHA256,
  TEMPORAL_POST_VERTEX_WGSL as TAA_VERTEX_WGSL
} from "./temporal_post_legacy.generated.js";

export const TAA_FORMAT = "rgba16float" as const;
