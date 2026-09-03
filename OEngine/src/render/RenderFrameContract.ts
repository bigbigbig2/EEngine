/**
 * 单帧 CPU→Render Feature 合同。只包含稳定的标量和标识，不暴露 GPU 对象；
 * View、FrameGraph 和 Feature 以同一份快照解释尺寸、jitter、历史和拓扑。
 */
export interface RenderFrameContract {
  readonly frameIndex: number;
  readonly cameraId: number;
  readonly sceneId: number;
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly jitter: readonly [number, number];
  readonly enabledFeatureBits: number;
  readonly historyFormatRevision: number;
}

export function createRenderFrameContract(
  input: RenderFrameContract
): RenderFrameContract {
  for (const [name, value] of Object.entries(input)) {
    if (name === "jitter") continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Render frame contract '${name}' must be a non-negative integer`);
    }
  }
  if (input.internalWidth <= 0 || input.internalHeight <= 0 ||
      input.outputWidth <= 0 || input.outputHeight <= 0) {
    throw new RangeError("Render frame contract dimensions must be positive");
  }
  if (!Number.isFinite(input.jitter[0]) || !Number.isFinite(input.jitter[1])) {
    throw new RangeError("Render frame contract jitter must be finite");
  }
  return Object.freeze({
    ...input,
    jitter: Object.freeze([input.jitter[0], input.jitter[1]]) as readonly [number, number]
  });
}
