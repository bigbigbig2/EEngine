/**
 * 统一透明度 Feature owner。
 *
 * 该 owner 只负责生命周期与路径选择，具体的 Packed MBOIT/legacy OIT
 * 算法仍由各自 pass 实现。这样可以让 Renderer 只依赖一个透明度边界，
 * 同时保持 GPU producer -> GPU consumer、独立合成和 reactive 输出契约。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { PackedSceneRuntime } from "../../gpu/GpuPackedSceneRegistry.js";
import type { Scene } from "../../scene/Scene.js";
import { PackedTransparentOitPass, type PackedTransparentOitInputs, type PackedTransparentOitJob } from "../passes/PackedTransparentOitPass.js";
import { TransparentOitPass, type TransparentOitInputs, type TransparentOitJob } from "../passes/TransparentOitPass.js";

/** 透明度统一 owner；未启用路径不会创建任何 GPU pass。 */
export class TransparencyFeature {
  private _packed: PackedTransparentOitPass | null = null;
  private _legacy: TransparentOitPass | null = null;

  constructor(private readonly _graphics: GraphicsContext) {}

  /** 延迟创建 Packed MBOIT owner，避免 feature-off 时分配资源。 */
  obtainPacked(): PackedTransparentOitPass {
    return this._packed ??= new PackedTransparentOitPass(this._graphics);
  }

  /** 返回当前 Packed owner；不会隐式创建。 */
  packed(): PackedTransparentOitPass | null {
    return this._packed;
  }

  /** 延迟创建 legacy OIT owner；不会与 Packed 路径共享中间资源。 */
  obtainLegacy(): TransparentOitPass {
    return this._legacy ??= new TransparentOitPass(this._graphics);
  }

  /** 返回当前 legacy owner；不会隐式创建。 */
  legacy(): TransparentOitPass | null {
    return this._legacy;
  }

  /** 释放 Packed 场景 residency 对应的 GPU 工作队列。 */
  releasePacked(runtime: PackedSceneRuntime, command: ShadeGPUCommandContext): void {
    this._packed?.release(runtime, command);
  }

  /** 在提交边界后淘汰 Packed owner。 */
  retirePacked(command: ShadeGPUCommandContext): void {
    const previous = this._packed;
    if (previous === null) return;
    this._packed = null;
    previous.retire(command);
  }

  /** 销毁两条透明度路径及其 GPU 资源。 */
  destroy(): void {
    this._packed?.destroy();
    this._packed = null;
    this._legacy?.destroy();
    this._legacy = null;
  }

  /** Packed MBOIT 的统一 FrameGraph 接口，保持 reactive/counters 输出。 */
  addPackedToGraph(
    graph: FrameGraph,
    job: PackedTransparentOitJob,
    inputs: PackedTransparentOitInputs
  ): { hdr: ResourceId; reactive: ResourceId; counters: ResourceId | null } {
    return this.obtainPacked().addToGraph(graph, job, inputs);
  }

  /** legacy OIT 的统一 FrameGraph 接口。 */
  addLegacyToGraph(
    graph: FrameGraph,
    job: TransparentOitJob,
    inputs: TransparentOitInputs
  ): ResourceId {
    return this.obtainLegacy().addToGraph(graph, job, inputs);
  }

  hasLegacyTransparentMaterials(scene: Scene): boolean {
    return this.obtainLegacy().hasTransparentMaterials(scene);
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
