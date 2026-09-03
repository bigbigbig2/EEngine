/**
 * 统一 HDR Post Feature owner。
 *
 * 该 owner 收拢 AutomaticExposure / Bloom / Sharpen / Tonemap / MotionBlur
 * 五个后处理 pass 的构造、销毁与 FrameGraph 接入，使 Renderer 只依赖一个
 * Post 边界。Feature-off 时不创建对应 pass，不保留无消费者的 Post 资源。
 *
 * 颜色域顺序固定为 Exposure → Bloom → Color Grading → Tone Mapping，
 * 全程线性 HDR；Motion Blur 保持可选扩展、默认关闭，不承担 TAA 修复职责。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { AutomaticExposurePass } from "../passes/AutomaticExposurePass.js";
import { BloomPass, type BloomJob } from "../passes/BloomPass.js";
import { SharpenPass } from "../passes/SharpenPass.js";
import { TonemapPass } from "../passes/TonemapPass.js";
import { MotionBlurPass } from "../passes/MotionBlurPass.js";

/** AutomaticExposure 的可调参数快照，用于 owner 创建/配置时同步。 */
export type PostExposureSettings = {
  exposureCompensation: number;
  exposureSpeedUp: number;
  exposureSpeedDown: number;
};

export class PostFeature {
  private _automaticExposure: AutomaticExposurePass | null = null;
  private _bloom: BloomPass | null = null;
  private _sharpen: SharpenPass | null = null;
  private _motionBlur: MotionBlurPass | null = null;
  private _tonemap: TonemapPass | null = null;

  constructor(private readonly _graphics: GraphicsContext) {}

  /** 延迟创建 AutomaticExposure owner；feature-off 时不分配 GPU 资源。 */
  obtainAutomaticExposure(): AutomaticExposurePass {
    return this._automaticExposure ??= new AutomaticExposurePass(
      this._graphics.device
    );
  }

  automaticExposure(): AutomaticExposurePass | null {
    return this._automaticExposure;
  }

  obtainBloom(): BloomPass {
    return this._bloom ??= new BloomPass(this._graphics);
  }

  bloom(): BloomPass | null {
    return this._bloom;
  }

  obtainSharpen(): SharpenPass {
    return this._sharpen ??= new SharpenPass(this._graphics);
  }

  sharpen(): SharpenPass | null {
    return this._sharpen;
  }

  obtainMotionBlur(): MotionBlurPass {
    return this._motionBlur ??= new MotionBlurPass(this._graphics);
  }

  motionBlur(): MotionBlurPass | null {
    return this._motionBlur;
  }

  /** 创建或更新 Tonemap owner；只在 canvas format 变更时重建 pipeline。 */
  obtainTonemap(format: GPUTextureFormat): TonemapPass {
    if (this._tonemap === null) {
      this._tonemap = new TonemapPass(this._graphics.device, format);
      this._tonemap.init();
    }
    this._tonemap.setCanvasFormat(format);
    return this._tonemap;
  }

  tonemap(): TonemapPass | null {
    return this._tonemap;
  }

  /** 同步 AutomaticExposure 参数；owner 不存在时无副作用。 */
  syncExposure(settings: PostExposureSettings): void {
    if (this._automaticExposure === null) return;
    this._automaticExposure.exposure_compensation =
      settings.exposureCompensation;
    this._automaticExposure.adaptation_speed_up = settings.exposureSpeedUp;
    this._automaticExposure.adaptation_speed_down = settings.exposureSpeedDown;
  }

  /** 同步 Tonemap 的动态范围状态；owner 不存在时无副作用。 */
  updateTonemap(
    format: GPUTextureFormat,
    hdrEnabled: boolean,
    peakNits: number
  ): void {
    if (this._tonemap === null) return;
    this._tonemap.hdrEnabled = hdrEnabled;
    this._tonemap.peakNits = peakNits;
    this._tonemap.setCanvasFormat(format);
  }

  get automaticExposureHistoryBytes(): number {
    return this._automaticExposure?.historyBytes ?? 0;
  }

  retireAutomaticExposure(): void {
    const previous = this._automaticExposure;
    if (previous === null) return;
    this._automaticExposure = null;
    this.retireAfterSubmittedWork(previous);
  }

  retireBloom(): void {
    const previous = this._bloom;
    if (previous === null) return;
    this._bloom = null;
    this.retireAfterSubmittedWork(previous);
  }

  retireSharpen(): void {
    const previous = this._sharpen;
    if (previous === null) return;
    this._sharpen = null;
    this.retireAfterSubmittedWork(previous);
  }

  retireMotionBlur(): void {
    const previous = this._motionBlur;
    if (previous === null) return;
    this._motionBlur = null;
    this.retireAfterSubmittedWork(previous);
  }

  /** 统一 FrameGraph 接入：Exposure → Bloom → Color Grading → Tone Mapping。 */
  addBloomToGraph(
    graph: FrameGraph,
    input: ResourceId,
    job: BloomJob
  ): { composited: ResourceId; downsampled: ResourceId } {
    return this.obtainBloom().addToGraph(graph, input, job);
  }

  addSharpenToGraph(
    graph: FrameGraph,
    input: ResourceId,
    width: number,
    height: number,
    job: { readonly sharpness: number }
  ): ResourceId {
    return this.obtainSharpen().addToGraph(graph, input, width, height, job);
  }

  /** 销毁所有 Post pass 及其 GPU 资源，包括 Tonemap（修复历史上的泄漏）。 */
  destroy(): void {
    this._automaticExposure?.destroy();
    this._automaticExposure = null;
    this._bloom?.destroy();
    this._bloom = null;
    this._sharpen?.destroy();
    this._sharpen = null;
    this._motionBlur?.destroy();
    this._motionBlur = null;
    this._tonemap?.destroy();
    this._tonemap = null;
  }

  private retireAfterSubmittedWork(resource: { destroy(): void }): void {
    void this._graphics.device.queue.onSubmittedWorkDone().then(
      () => resource.destroy(),
      () => resource.destroy()
    );
  }
}
