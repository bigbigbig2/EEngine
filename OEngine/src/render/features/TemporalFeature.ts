/**
 * 统一时域 Feature owner。
 *
 * 该 owner 收拢 TAA/TAAU、Temporal Classification、颜色 history、jitter
 * 和 DRS 的生命周期；AO/SSR history 仍由各自 Service 维护，避免跨产品
 * 复用错误的历史纹理。所有实际 GPU 工作继续由现有 pass 写入 FrameGraph。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { GPUTextureContext } from "../../gpu/GPUTextureContext.js";
import { id } from "../../gpu/GPUTextureDescriptors.js";
import { DynamicResolutionScaling } from "../DynamicResolutionScaling.js";
import {
  TemporalJitterController,
  recommendedTaaJitterSequenceSize
} from "../TemporalJitterController.js";
import {
  TemporalAntiAliasingPass,
  type TemporalAntiAliasingInputs,
  type TemporalAntiAliasingJob
} from "../passes/TemporalAntiAliasingPass.js";
import {
  TemporalClassificationPass,
  type TemporalClassificationInputs,
  type TemporalClassificationJob,
  type TemporalClassificationOutputs
} from "../passes/TemporalClassificationPass.js";

export class TemporalFeature {
  readonly jitter = new TemporalJitterController();
  readonly dynamicResolution = new DynamicResolutionScaling();

  private _graphics: GraphicsContext | null;
  private _taa: TemporalAntiAliasingPass | null = null;
  private _classification: TemporalClassificationPass | null = null;
  private _colorHistory: [GPUTextureContext, GPUTextureContext] | null = null;

  constructor(graphics: GraphicsContext | null = null) {
    this._graphics = graphics;
  }

  attachGraphics(graphics: GraphicsContext): void {
    this._graphics = graphics;
  }

  obtainTaa(): TemporalAntiAliasingPass {
    return this._taa ??= new TemporalAntiAliasingPass(this.requireGraphics());
  }

  taa(): TemporalAntiAliasingPass | null {
    return this._taa;
  }

  obtainClassification(): TemporalClassificationPass {
    return this._classification ??= new TemporalClassificationPass(
      this.requireGraphics()
    );
  }

  classification(): TemporalClassificationPass | null {
    return this._classification;
  }

  addClassificationToGraph(
    graph: FrameGraph,
    job: TemporalClassificationJob,
    inputs: TemporalClassificationInputs
  ): TemporalClassificationOutputs {
    return this.obtainClassification().addToGraph(graph, job, inputs);
  }

  addTaaToGraph(
    graph: FrameGraph,
    job: TemporalAntiAliasingJob,
    inputs: TemporalAntiAliasingInputs
  ): ResourceId {
    return this.obtainTaa().addToGraph(graph, job, inputs);
  }

  resetFrameEvidence(): void {
    this._taa?.resetFrameEvidence();
  }

  ensureColorHistory(width: number, height: number): void {
    if (this._colorHistory !== null) return;
    const historyDescriptor = id.from({
      label: "Renderer/temporal-color-history",
      size: [Math.max(1, width), Math.max(1, height)],
      format: "rgba16float",
      mipLevelCount: 1,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC
    });
    const graphics = this.requireGraphics();
    this._colorHistory = [
      graphics.textures.contextFromDescriptor(new id().copy(historyDescriptor)),
      graphics.textures.contextFromDescriptor(new id().copy(historyDescriptor))
    ];
    this.jitter.reset_history = true;
  }

  colorHistory(index: 0 | 1): GPUTextureContext {
    if (this._colorHistory === null) {
      throw new Error("TemporalFeature color history is not initialized");
    }
    return this._colorHistory[index];
  }

  colorHistoryCount(): number {
    return this._colorHistory?.length ?? 0;
  }

  colorHistoryBytes(): number {
    return this._colorHistory?.reduce(
      (sum, texture) => sum + texture.gpu_memory_usage,
      0
    ) ?? 0;
  }

  resizeColorHistory(width: number, height: number): void {
    this._colorHistory?.forEach((history) => history.resize(width, height));
  }

  retireTaa(): void {
    const previous = this._taa;
    if (previous === null) return;
    this._taa = null;
    this.retireAfterSubmittedWork(previous);
  }

  retireClassification(): void {
    const previous = this._classification;
    if (previous === null) return;
    this._classification = null;
    this.retireAfterSubmittedWork(previous);
  }

  retireColorHistory(): void {
    const previous = this._colorHistory;
    if (previous === null) return;
    this._colorHistory = null;
    previous.forEach((history) => this.retireAfterSubmittedWork(history));
    this.jitter.reset_history = true;
  }

  destroy(): void {
    this._taa?.destroy();
    this._classification?.destroy();
    this._colorHistory?.forEach((history) => history.destroy());
    this._taa = null;
    this._classification = null;
    this._colorHistory = null;
  }

  configureJitterSequence(
    renderWidth: number,
    renderHeight: number,
    outputWidth: number,
    outputHeight: number
  ): void {
    this.jitter.jitter_sequence_size = recommendedTaaJitterSequenceSize(
      renderWidth,
      renderHeight,
      outputWidth,
      outputHeight
    );
  }

  private requireGraphics(): GraphicsContext {
    if (this._graphics === null) {
      throw new Error("TemporalFeature requires an initialized GraphicsContext");
    }
    return this._graphics;
  }

  private retireAfterSubmittedWork(resource: { destroy(): void }): void {
    void this.requireGraphics().device.queue.onSubmittedWorkDone().then(
      () => resource.destroy(),
      () => resource.destroy()
    );
  }
}
