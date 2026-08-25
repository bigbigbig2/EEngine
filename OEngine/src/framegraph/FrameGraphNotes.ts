/**
 * FrameGraphNotes：负责帧图资源管理、依赖编排或 GPU 命令执行。
 */

export const MAIN_FRAME_GRAPH_NAME = "Shading";

export const LPV_FRAME_GRAPH_NAME = "LPV";

export const MAIN_COMMAND_LABEL = "Renderer/main-0";

export const OBSERVED_PASS_OR_RESOURCE_NAMES = [
  "figure_out_of_bounds",
  "bvh2_compress",
  "maybe meshes",
  "maybe meshlets",
  "positive meshes",
  "meshlets positive",
  "indirect dispatch command",
  "Material Draw",
  "g-buffer / PBR",
  "g-buffer / Normal",
  "g-buffer / Albedo",
  "compute_toksvig",
  "cluster_lookup",
  "cluster_data",
  "downscale map",
  "upscale map",
  "pass"
] as const;

export const SUBMIT_SEQUENCE = [
  "ShadeGPUCommandContext.encodeGraph(Shading)",
  "view.finish_frame(cmd)",
  "cmd.finish()",
  "frame_count++ / onFrameFinished"
] as const;
