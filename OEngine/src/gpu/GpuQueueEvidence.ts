import type { FrameProfiler } from "../debug/FrameProfiler.js";

const profilerByDevice = new WeakMap<GPUDevice, FrameProfiler>();
const profilerByQueue = new WeakMap<GPUQueue, FrameProfiler>();

export type GpuSubmitOwnerKind =
  | "render-frame"
  | "one-shot"
  | "tool"
  | "debug-readback"
  | "recovery";

const GPU_SUBMIT_OWNER_BY_LABEL = new Map<string, GpuSubmitOwnerKind>([
  ["Renderer/main-0", "render-frame"],
  ["GraphicsContext/one-shot-maintenance", "one-shot"],
  ["GPUResidentMaterialContext/one-shot-update", "one-shot"],
  ["LPV/generate-locations", "tool"],
  ["LPV/dering", "tool"],
  ["LPV/bake", "tool"],
  ["GPUCameraState/copy", "tool"],
  ["GPUDatabase/read", "debug-readback"],
  ["GPUCollectionLimits/read", "debug-readback"],
  ["LightProbeVolume/read", "debug-readback"],
  ["GPUIndexedRecordTable/read", "debug-readback"],
  ["SceneSdf/read", "debug-readback"],
  ["GPUTextureContext/resize-copy", "recovery"],
  ["MeshletGpuPool/compact", "tool"],
  ["MipmapGenerator/generate", "one-shot"],
  ["Renderer/PackedScene/resident", "tool"],
  ["Renderer/PackedScene/instantiate", "tool"],
  ["Renderer/PackedScene/release-instances", "tool"],
  ["Renderer/PackedScene/release-asset", "tool"],
  ["Renderer/View/release", "tool"]
]);

export function classifyGpuSubmitLabel(
  label: string
): GpuSubmitOwnerKind | undefined {
  return GPU_SUBMIT_OWNER_BY_LABEL.get(label);
}

export function registerGpuQueueProfiler(
  device: GPUDevice,
  profiler: FrameProfiler
): void {
  profilerByDevice.set(device, profiler);
  profilerByQueue.set(device.queue, profiler);
}

export function unregisterGpuQueueProfiler(
  device: GPUDevice,
  profiler: FrameProfiler
): void {
  if (profilerByDevice.get(device) === profiler) profilerByDevice.delete(device);
  if (profilerByQueue.get(device.queue) === profiler) {
    profilerByQueue.delete(device.queue);
  }
}

/** The single evidence-aware submission seam for OEngine-owned command buffers. */
export function submitGpuCommands(
  device: GPUDevice,
  label: string,
  commandBuffers: readonly GPUCommandBuffer[]
): void {
  const ownerKind = classifyGpuSubmitLabel(label);
  if (ownerKind === undefined) {
    throw new Error(`Unclassified GPU submit owner label '${label}'`);
  }
  const profiler = profilerByDevice.get(device);
  profiler?.recordSubmit(label);
  if (profiler === undefined) {
    device.queue.submit(commandBuffers);
    return;
  }
  profiler.measure("queue-submit", () => device.queue.submit(commandBuffers));
}

export function recordGpuReadback(
  device: GPUDevice,
  label: string,
  bytes: number
): void {
  profilerByDevice.get(device)?.recordReadback(label, bytes);
}

export function recordGpuQueueUpload(
  queue: GPUQueue,
  label: string,
  bytes: number
): void {
  profilerByQueue.get(queue)?.recordUpload(label, bytes);
}

export function writeGpuBuffer(
  queue: GPUQueue,
  label: string,
  ...args: Parameters<GPUQueue["writeBuffer"]>
): void {
  const source = args[2];
  const byteOffset = Number(args[3] ?? 0);
  const bytes = Number(args[4] ?? Math.max(0, source.byteLength - byteOffset));
  recordGpuQueueUpload(queue, label, bytes);
  queue.writeBuffer(...args);
}

export function writeGpuTexture(
  queue: GPUQueue,
  label: string,
  ...args: Parameters<GPUQueue["writeTexture"]>
): void {
  const source = args[1];
  const layout = args[2];
  recordGpuQueueUpload(
    queue,
    label,
    Math.max(0, source.byteLength - Number(layout.offset ?? 0))
  );
  queue.writeTexture(...args);
}
