/**
 * 统一透明度 Feature owner。
 *
 * 该 owner 负责统一有界 MBOIT 的生命周期，保持 GPU producer → GPU
 * consumer、独立合成和 reactive 输出契约。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import { PackedTransparentOitPass, type PackedTransparentOitInputs, type PackedTransparentOitJob } from "../passes/PackedTransparentOitPass.js";

/** 透明度统一 owner；未启用路径不会创建任何 GPU pass。 */
export class TransparencyFeature {
  private _packed: PackedTransparentOitPass | null = null;

  constructor(private readonly _graphics: GraphicsContext) {}

  /** 延迟创建 Packed MBOIT owner，避免 feature-off 时分配资源。 */
  obtainPacked(): PackedTransparentOitPass {
    return this._packed ??= new PackedTransparentOitPass(this._graphics);
  }

  /** 返回当前 Packed owner；不会隐式创建。 */
  packed(): PackedTransparentOitPass | null {
    return this._packed;
  }

  /** 释放 Packed 场景 residency 对应的 GPU 工作队列。 */
  releasePacked(runtime: GpuRenderWorldRuntime, command: ShadeGPUCommandContext): void {
    this._packed?.release(runtime, command);
  }

  /** 在提交边界后淘汰 Packed owner。 */
  retirePacked(command: ShadeGPUCommandContext): void {
    const previous = this._packed;
    if (previous === null) return;
    this._packed = null;
    previous.retire(command);
  }

  /** 销毁透明度 GPU 资源。 */
  destroy(): void {
    this._packed?.destroy();
    this._packed = null;
  }

  /** Packed MBOIT 的统一 FrameGraph 接口，保持 reactive/counters 输出。 */
  addPackedToGraph(
    graph: FrameGraph,
    job: PackedTransparentOitJob,
    inputs: PackedTransparentOitInputs
  ): { hdr: ResourceId; reactive: ResourceId; counters: ResourceId | null } {
    return this.obtainPacked().addToGraph(graph, job, inputs);
  }

  get rasterStateBinLimit(): number | null {
    return this._packed?.rasterStateBinLimit ?? null;
  }
  get drawCount(): number {
    return this._packed?.lastDrawCount ?? 0;
  }
  get momentPasses(): number {
    return this._packed?.lastMomentPasses ?? 0;
  }
  get forwardPasses(): number {
    return this._packed?.lastForwardPasses ?? 0;
  }
  get compositePasses(): number {
    return this._packed?.lastCompositePasses ?? 0;
  }
  get transientBytesPerPixel(): number | null {
    return this._packed?.transientBytesPerPixel ?? null;
  }
  get motionContract(): "reactive-all-velocity-invalid-v1" | null {
    return this._packed?.motionContract ?? null;
  }
}
