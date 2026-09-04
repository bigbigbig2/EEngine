/**
 * P4 Shadow Service：为 GPU Light Collection 提供统一的阴影调度边界。
 *
 * 资源、CSM/Atlas、Contact Shadow 和 GPU-driven shadow raster 的具体实现仍由
 * ShadowContext 持有；本层只暴露统一服务合同，避免 Renderer 直接依赖内部 owner。
 */

import type { Camera } from "../camera/Camera.js";
import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { PackedSceneRuntime } from "./GpuPackedSceneRegistry.js";
import type { GpuAssetBindings } from "./GpuAssetStore.js";
import type { GpuSceneBindings } from "./GpuScene.js";
import type { GPUDatabase } from "./GPUDatabase.js";
import type { GPUSceneContext } from "./GPUSceneContext.js";
import type { MeshletDrawList } from "./MeshletDrawList.js";
import { ShadowContext } from "./ShadowContext.js";
import type { SceneLights } from "../scene/Scene.js";
import type { GraphicsContext } from "./GraphicsContext.js";

export type ShadowServicePackedInput = Readonly<{
  readonly runtime: PackedSceneRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly counterBuffer: GPUBuffer | null;
  readonly sseThreshold: number;
}>;

/** 阴影服务的稳定入口；不改变现有 ShadowContext 的算法和 GPU ABI。 */
export class ShadowService {
  private readonly implementation: ShadowContext;

  constructor(graphics: GraphicsContext, source: SceneLights) {
    this.implementation = new ShadowContext(graphics, source);
  }

  get enabled(): boolean {
    return this.implementation.enabled;
  }

  get texture() {
    return this.implementation.texture;
  }

  get atlas_allocated_bytes(): number {
    return this.implementation.atlas_allocated_bytes;
  }

  get atlas_width(): number {
    return this.implementation.atlas_width;
  }

  get atlas_height(): number {
    return this.implementation.atlas_height;
  }

  get packed_cascade_draw_count(): number {
    return this.implementation.packed_cascade_draw_count;
  }

  get packed_atlas_pixels_updated(): number {
    return this.implementation.packed_atlas_pixels_updated;
  }

  get debug_render_count(): number {
    return this.implementation.debug_render_count;
  }

  get debug_atlas_occupancy(): number {
    return this.implementation.debug_atlas_occupancy;
  }

  get debug_drop_size_scale(): number {
    return this.implementation.debug_drop_size_scale;
  }

  get lastHzbBuildCount(): number {
    return this.implementation.lastHzbBuildCount;
  }

  get lastHzbComputePassCount(): number {
    return this.implementation.lastHzbComputePassCount;
  }

  get lastHzbDispatchCount(): number {
    return this.implementation.lastHzbDispatchCount;
  }

  get lastHzbOutputPixels(): number {
    return this.implementation.lastHzbOutputPixels;
  }

  get directional_cascade_lambda(): number {
    return this.implementation.directional_cascade_lambda;
  }

  set directional_cascade_lambda(value: number) {
    this.implementation.directional_cascade_lambda = value;
  }

  get directional_maximum_distance(): number {
    return this.implementation.directional_maximum_distance;
  }

  set directional_maximum_distance(value: number) {
    this.implementation.directional_maximum_distance = value;
  }

  get directional_texel_guard_band(): number {
    return this.implementation.directional_texel_guard_band;
  }

  set directional_texel_guard_band(value: number) {
    this.implementation.directional_texel_guard_band = value;
  }

  setEnabled(enabled: boolean, command: ShadeGPUCommandContext): void {
    this.implementation.setEnabled(enabled, command);
  }

  process_lights(): boolean {
    return this.implementation.process_lights();
  }

  select_for_draw(camera: Camera, frameIndex: number, resolution: ArrayLike<number>): void {
    this.implementation.select_for_draw(camera, frameIndex, resolution);
  }

  draw(
    command: ShadeGPUCommandContext,
    scene: GPUSceneContext,
    database: GPUDatabase,
    drawList: MeshletDrawList,
    packed: ShadowServicePackedInput | null = null
  ): number {
    return this.implementation.draw(command, scene, database, drawList, packed);
  }

  releasePackedScene(runtime: PackedSceneRuntime, command: ShadeGPUCommandContext): void {
    this.implementation.releasePackedScene(runtime, command);
  }

  destroy(): void {
    this.implementation.destroy();
  }
}
