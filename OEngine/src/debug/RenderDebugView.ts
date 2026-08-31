/**
 * 统一的渲染调试视图选择。
 *
 * `none` 是完全关闭状态；只有 status 为 `supported` 的非 none 视图才会
 * 向主 FrameGraph 添加 Pass 和瞬态输出。其余条目先登记缺失的数据契约，
 * 避免用占位颜色冒充已经具备可观测能力。
 */
export const RenderDebugView = {
  None: "none",
  VisibilityKey: "visibility-key",
  Depth: "depth",
  HzbMip: "hzb-mip",
  RejectedFrustum: "rejected-frustum",
  RejectedCone: "rejected-cone",
  RejectedHzb: "rejected-hzb",
  LodClusterLevel: "lod-cluster-level",
  RasterClassification: "raster-classification",
  MaterialId: "material-id",
  BaseColor: "base-color",
  ShadingNormal: "shading-normal",
  Roughness: "roughness",
  Metallic: "metallic",
  Occlusion: "occlusion",
  AmbientOcclusionRaw: "ambient-occlusion-raw",
  AmbientOcclusionDenoised: "ambient-occlusion-denoised",
  AmbientOcclusionTemporal: "ambient-occlusion-temporal",
  Emissive: "emissive",
  Velocity: "velocity",
  HistoryValidity: "history-validity",
  Reactive: "reactive",
  IndirectDiffuse: "indirect-diffuse",
  IndirectSpecular: "indirect-specular",
  LinearHdr: "linear-hdr"
} as const;

export type RenderDebugView =
  (typeof RenderDebugView)[keyof typeof RenderDebugView];

export type RenderDebugViewStatus = {
  view: RenderDebugView;
  label: string;
  status: "disabled" | "supported" | "unsupported";
  reason: string;
};

export const RENDER_DEBUG_VIEW_OPTIONS: readonly RenderDebugViewStatus[] = [
  descriptor(RenderDebugView.None, "关闭", "disabled", "不添加调试 Pass 或资源"),
  descriptor(
    RenderDebugView.VisibilityKey,
    "Visibility Key",
    "supported",
    "Packed 路径回查 RasterWork/Cluster/Meshlet/Instance/Material；legacy 路径哈希 mesh/triangle ID"
  ),
  descriptor(
    RenderDebugView.Depth,
    "反向 Z Depth",
    "supported",
    "显示 depth32float mip 0；近处为亮色，背景为黑色"
  ),
  descriptor(
    RenderDebugView.HzbMip,
    "HZB mip",
    "unsupported",
    "HZB 尚未提供稳定的 mip 选择与显示输入契约"
  ),
  descriptor(
    RenderDebugView.RejectedFrustum,
    "Frustum reject",
    "unsupported",
    "当前只统计拒绝数量，没有逐实例或逐 Cluster 原因缓冲"
  ),
  descriptor(
    RenderDebugView.RejectedCone,
    "Cone reject",
    "unsupported",
    "当前没有可靠且互斥的 cone reject producer"
  ),
  descriptor(
    RenderDebugView.RejectedHzb,
    "HZB reject",
    "unsupported",
    "当前没有逐实例或逐 Cluster 的 HZB reject 原因缓冲"
  ),
  descriptor(
    RenderDebugView.LodClusterLevel,
    "LOD / Cluster level",
    "unsupported",
    "当前主链没有层次 LOD level 输出"
  ),
  descriptor(
    RenderDebugView.RasterClassification,
    "SW / HW classification",
    "unsupported",
    "当前只有硬件光栅，尚无统一分类输出"
  ),
  descriptor(
    RenderDebugView.MaterialId,
    "Material ID",
    "supported",
    "显示 Surface ABI v1 metadata 低 16 位 resident MaterialRecord slot"
  ),
  descriptor(RenderDebugView.BaseColor, "Base color", "supported", "显示线性 base color Surface 通道"),
  descriptor(RenderDebugView.ShadingNormal, "Shading normal", "supported", "显示解码后的切线空间法线结果"),
  descriptor(RenderDebugView.Roughness, "Roughness", "supported", "显示 perceptual roughness"),
  descriptor(RenderDebugView.Metallic, "Metallic", "supported", "显示 metallic"),
  descriptor(RenderDebugView.Occlusion, "Occlusion", "supported", "显示材质 AO"),
  descriptor(RenderDebugView.AmbientOcclusionRaw, "AO raw", "supported", "显示 FX-07 原始 GTAO visibility"),
  descriptor(RenderDebugView.AmbientOcclusionDenoised, "AO denoised", "supported", "显示 FX-07 空间滤波 visibility"),
  descriptor(RenderDebugView.AmbientOcclusionTemporal, "AO temporal", "supported", "显示 FX-07 最终 temporal visibility；temporal 关闭时等于 denoised"),
  descriptor(RenderDebugView.Emissive, "Emissive", "supported", "显示解码后的 emissive"),
  descriptor(
    RenderDebugView.Velocity,
    "Velocity",
    "supported",
    "方向映射为色相，屏幕空间速度映射为亮度"
  ),
  descriptor(
    RenderDebugView.HistoryValidity,
    "History validity",
    "supported",
    "显示 Surface ABI v1 motion-valid 与 reactive 状态"
  ),
  descriptor(RenderDebugView.Reactive, "Reactive", "supported", "显示必须拒绝时域历史的像素"),
  descriptor(RenderDebugView.IndirectDiffuse, "Diffuse IBL", "supported", "显示 FX-03 cosine-convolved diffuse irradiance 输出"),
  descriptor(RenderDebugView.IndirectSpecular, "Specular IBL", "supported", "显示 FX-03 GGX prefiltered specular radiance 输出"),
  descriptor(RenderDebugView.LinearHdr, "Linear HDR", "supported", "显示 tonemap/exposure 前 working-linear scene color")
] as const;

const STATUS_BY_VIEW = new Map(
  RENDER_DEBUG_VIEW_OPTIONS.map((entry) => [entry.view, entry])
);

export function getRenderDebugViewStatus(
  view: RenderDebugView
): RenderDebugViewStatus {
  const status = STATUS_BY_VIEW.get(view);
  if (status === undefined) {
    throw new Error(`Unknown render debug view '${String(view)}'`);
  }
  return { ...status };
}

export function isRenderableRenderDebugView(view: RenderDebugView): boolean {
  return getRenderDebugViewStatus(view).status === "supported";
}

function descriptor(
  view: RenderDebugView,
  label: string,
  status: RenderDebugViewStatus["status"],
  reason: string
): RenderDebugViewStatus {
  return { view, label, status, reason };
}
