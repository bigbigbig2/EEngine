/**
 * GraphicsContext：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import { GPUResidentMaterialContext } from "./GPUResidentMaterialContext.js";
import { GPUMaterialRegistry } from "./GPUMaterialContext.js";
import { GPUTextureManager } from "./GPUTextureManager.js";
import { GPUSamplerCache } from "./GPUSamplerCache.js";
import { STATIC_GRAPHICS_ENGINE_ASSETS } from "../render/STATIC_GRAPHICS_ENGINE_ASSETS.js";
import {
  GPUBufferAllocator,
  GPUNativeBufferAllocator
} from "./GPUBufferAllocator.js";
import { GPUTextureAllocator } from "./GPUTextureAllocator.js";
import { GPUStagingBufferAllocator } from "./GPUStagingBufferAllocator.js";
import { GPUCollectionLimits } from "./GPUCollectionLimits.js";
import { MeshletGpuTable } from "./MeshletGpuTable.js";
import { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import {
  BindGroupCache,
  ComputePipelineCache,
  PipelineLayoutCache,
  RenderPipelineCache,
  ShaderModuleCache,
  type CachedComputePipelineDescriptor,
  type CachedPipelineLayoutDescriptor,
  type CachedRenderPipelineDescriptor
} from "./GPUDescriptorCaches.js";
import { GPUBufferWrapper } from "./GPUBufferWrapper.js";
import { FrameProfiler } from "../debug/FrameProfiler.js";
import {
  registerGpuQueueProfiler,
  unregisterGpuQueueProfiler
} from "./GpuQueueEvidence.js";
import { GpuAssetStore } from "./GpuAssetStore.js";
import { GpuScene } from "./GpuScene.js";
import { GpuPackedSceneRegistry } from "./GpuPackedSceneRegistry.js";
import { GpuMaterialVisibilityTable } from "./GpuMaterialVisibilityTable.js";

export class GraphicsContext {
  readonly isGraphicsContext = true;
  readonly device: GPUDevice;
  private residentMaterials: GPUResidentMaterialContext | undefined;
  private readonly collectionLimitsValue: GPUCollectionLimits;
  readonly buffer_allocator_main: GPUBufferAllocator;
  readonly buffer_allocator_native: GPUNativeBufferAllocator;
  readonly buffer_allocator_staging: GPUStagingBufferAllocator;
  readonly allocator_textures: GPUTextureAllocator;
  readonly textures: GPUTextureManager;
  readonly shader_modules: ShaderModuleCache;
  readonly pipeline_layouts: PipelineLayoutCache;
  readonly bind_groups: BindGroupCache;
  readonly render_pipelines: RenderPipelineCache;
  readonly compute_pipelines: ComputePipelineCache;
  private geometryTableValue: MeshletGpuTable | undefined;
  readonly materials: GPUMaterialRegistry;
  readonly samplers: GPUSamplerCache;
  readonly profiler: FrameProfiler;
  private assetStoreValue: GpuAssetStore | undefined;
  private gpuSceneValue: GpuScene | undefined;
  private packedScenesValue: GpuPackedSceneRegistry | undefined;
  private materialVisibilityValue: GpuMaterialVisibilityTable | undefined;
  private timerIncrementValue = 0;

  constructor(device: GPUDevice, profiler = new FrameProfiler()) {
    this.device = device;
    this.profiler = profiler;
    this.profiler.configure({
      gpuTimestampAvailable: device.features.has("timestamp-query")
    });
    this.profiler.attachGpuDevice(device);
    registerGpuQueueProfiler(device, profiler);
    this.collectionLimitsValue = new GPUCollectionLimits(device);
    this.buffer_allocator_main = new GPUBufferAllocator(device);
    this.buffer_allocator_native = new GPUNativeBufferAllocator(device);
    this.buffer_allocator_staging = new GPUStagingBufferAllocator(device);
    this.allocator_textures = new GPUTextureAllocator(device);
    this.shader_modules = new ShaderModuleCache(device);
    this.pipeline_layouts = new PipelineLayoutCache(device);
    this.bind_groups = new BindGroupCache(device, this.pipeline_layouts);
    this.render_pipelines = new RenderPipelineCache(
      device,
      this.pipeline_layouts,
      this.shader_modules
    );
    this.compute_pipelines = new ComputePipelineCache(
      device,
      this.pipeline_layouts,
      this.shader_modules
    );
    this.textures = new GPUTextureManager(this);
    this.materials = new GPUMaterialRegistry(
      device,
      this.textures,
      this.render_pipelines,
      this.bind_groups
    );
    this.samplers = new GPUSamplerCache(device);
  }

  get timer_increment(): number {
    return this.timerIncrementValue;
  }

  get collection_limits(): GPUCollectionLimits {
    return this.collectionLimitsValue;
  }

  increment_time(): void {
    this.timerIncrementValue++;
    this.buffer_allocator_main.increment_time();
  }

  setPipelineBindings(
    pass: GPURenderPassEncoder | GPUComputePassEncoder,
    pipeline:
      | CachedRenderPipelineDescriptor
      | CachedComputePipelineDescriptor,
    bindings: readonly (readonly GPUBindingResource[])[]
  ): void {
    const layouts: CachedPipelineLayoutDescriptor["bindGroupLayouts"] =
      pipeline.layout.bindGroupLayouts;
    for (let groupIndex = 0; groupIndex < bindings.length; groupIndex++) {
      const entries = bindings[groupIndex];
      const layout = layouts[groupIndex];
      if (entries === undefined || layout === undefined) continue;
      const group = this.bind_groups.obtain({ layout, entries });
      pass.setBindGroup(groupIndex, group);
    }
  }

  createBuffer(descriptor: GPUBufferDescriptor): GPUBufferWrapper {
    const buffer = this.device.createBuffer(descriptor);
    return GPUBufferWrapper.from(descriptor, buffer);
  }

  get materials_resident(): GPUResidentMaterialContext {
    if (this.residentMaterials === undefined) {
      this.residentMaterials = new GPUResidentMaterialContext(this.device, this);
    }
    return this.residentMaterials;
  }

  /** Lazily creates the R2 package residency owner; legacy-only pages pay zero cost. */
  get assets(): GpuAssetStore {
    this.assetStoreValue ??= new GpuAssetStore(this.device);
    return this.assetStoreValue;
  }

  /** Lazily creates the R2 compact Instance table; legacy-only pages pay zero cost. */
  get gpu_scene(): GpuScene {
    this.gpuSceneValue ??= new GpuScene(this.device, this.assets);
    return this.gpuSceneValue;
  }

  /** Lazily creates the Scene → Packed Geometry/Instance association owner. */
  get packed_scenes(): GpuPackedSceneRegistry {
    this.packedScenesValue ??= new GpuPackedSceneRegistry(this);
    return this.packedScenesValue;
  }

  get packed_scenes_if_created(): GpuPackedSceneRegistry | undefined {
    return this.packedScenesValue;
  }

  /** Lazily creates the bounded R4-A alpha-only material table. */
  get material_visibility(): GpuMaterialVisibilityTable {
    this.materialVisibilityValue ??= new GpuMaterialVisibilityTable(this);
    return this.materialVisibilityValue;
  }

  get material_visibility_if_created(): GpuMaterialVisibilityTable | undefined {
    return this.materialVisibilityValue;
  }

  /** Legacy Geometry owner, created only when an old Scene consumer asks for it. */
  get geometries(): MeshletGpuTable {
    this.geometryTableValue ??= new MeshletGpuTable(this);
    return this.geometryTableValue;
  }

  get geometries_if_created(): MeshletGpuTable | undefined {
    return this.geometryTableValue;
  }

  async initialize(): Promise<void> {
    await STATIC_GRAPHICS_ENGINE_ASSETS.init();
  }

  encodeFrameMaintenance(
    command: ShadeGPUCommandContext,
    sampleCollectionLimits = false
  ): void {
    this.geometryTableValue?.update(command, "GraphicsContext");
    this.textures.update(command);
    this.materials.update(command);
    this.bind_groups.update();
    this.increment_time();
    this.allocator_textures.update();
    if (sampleCollectionLimits) {
      void this.collectionLimitsValue.update(
        command,
        this.buffer_allocator_main
      ).catch((error: unknown) => {
        if (!command.isAborted) {
          console.error("Collection limit readback failed", error);
        }
      });
    }
    this.buffer_allocator_main.update();
  }

  /** Explicit one-shot maintenance for tools that do not own a render frame. */
  update(): void {
    const command = ShadeGPUCommandContext.create(
      this,
      "GraphicsContext/one-shot-maintenance"
    );
    this.encodeFrameMaintenance(command, false);
    command.finish();
  }

  get gpu_memory_usage(): number {
    return (
      (this.geometryTableValue?.gpu_memory_usage ?? 0) +
      (this.assetStoreValue?.evidence().allocatedBytes ?? 0) +
      (this.gpuSceneValue?.evidence().allocatedBytes ?? 0) +
      (this.packedScenesValue?.evidence().flatWorkBytes ?? 0) +
      (this.materialVisibilityValue?.evidence().allocatedBytes ?? 0) +
      this.buffer_allocator_main.gpu_memory_usage +
      this.buffer_allocator_staging.gpu_memory_usage +
      this.allocator_textures.gpu_memory_usage +
      this.textures.gpu_memory_usage
    );
  }

  destroy(): void {
    unregisterGpuQueueProfiler(this.device, this.profiler);
    this.packedScenesValue?.destroy();
    this.packedScenesValue = undefined;
    this.materialVisibilityValue?.destroy();
    this.materialVisibilityValue = undefined;
    this.gpuSceneValue?.destroy();
    this.gpuSceneValue = undefined;
    this.assetStoreValue?.destroy();
    this.assetStoreValue = undefined;
    this.geometryTableValue?.destroy();
    this.geometryTableValue = undefined;
    this.residentMaterials?.destroy();
    this.buffer_allocator_main.destroy();
    this.buffer_allocator_native.destroy();
    this.buffer_allocator_staging.destroy();
    this.collectionLimitsValue.destroy();
    this.profiler.detachGpuDevice(this.device);
  }
}
