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
  Velocity: "velocity",
  HistoryValidity: "history-validity"
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
    "对 meshId 与 triangleId 组合做稳定哈希着色"
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
    "unsupported",
    "当前 VisibilityKey 没有可直接显示的稳定 material ID attachment"
  ),
  descriptor(
    RenderDebugView.Velocity,
    "Velocity",
    "supported",
    "方向映射为色相，屏幕空间速度映射为亮度"
  ),
  descriptor(
    RenderDebugView.HistoryValidity,
    "History validity",
    "unsupported",
    "TAA history validity 尚未输出为逐像素资源"
  )
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
