/**
 * index：负责帧图资源管理、依赖编排或 GPU 命令执行。
 */

export {
  FrameGraph,
  FrameGraphContext,
  PassBuilder,
  PassResources,
  FrameGraphResourceManager,
  resolveGpuEncoder
} from "./FrameGraph.js";
export type {
  FrameGraphExecuteContext,
  FrameGraphCommandEncoder,
  FrameGraphGraphicsResources,
  PassExecuteFn
} from "./FrameGraph.js";
export { ShadeGPUCommandContext } from "./ShadeGPUCommandContext.js";
export { GPUTimer } from "./GPUTimer.js";
export type {
  GPUTimerPassType,
  GPUTimerResult,
  GPUTimerTimestampWrites
} from "./GPUTimer.js";
export {
  ReusableResourceManager,
  ReusableResourceContext,
  stableResourceDescriptorKey
} from "./ReusableResourceManager.js";
export type { ReusableResourceOwner } from "./ReusableResourceManager.js";
export type { ResourceId, ResourceDescriptor, ResourceEntry, ResourceNode } from "./ResourceHandle.js";
export {
  MAIN_FRAME_GRAPH_NAME,
  LPV_FRAME_GRAPH_NAME,
  MAIN_COMMAND_LABEL,
  OBSERVED_PASS_OR_RESOURCE_NAMES,
  SUBMIT_SEQUENCE
} from "./FrameGraphNotes.js";
