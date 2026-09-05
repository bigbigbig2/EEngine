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
  type PipelineCacheObserver,
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
import { GpuMaterialStore } from "./GpuMaterialStore.js";
import { TextureResidency } from "./TextureResidency.js";
import { GPU_MATERIAL_VISIBILITY_RECORD_STRIDE } from "./GpuMaterialVisibilityAbi.js";
import {
  ResourceAccounting,
  type ResourceAccountingSnapshot
} from "../debug/profiling/ResourceAccounting.js";

export interface GraphicsMemoryEvidence {
  readonly schemaVersion: 1;
  readonly allocatedBytes: number;
  readonly residentLogicalBytes: number;
  readonly transientPoolBytes: number;
  readonly retiringBytes: number;
  readonly reclaimableBytes: number;
  readonly fragmentationBytes: number;
  readonly owners: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly limitations: readonly string[];
}

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
  readonly resource_accounting = new ResourceAccounting();
  private assetStoreValue: GpuAssetStore | undefined;
  private gpuSceneValue: GpuScene | undefined;
  private packedScenesValue: GpuPackedSceneRegistry | undefined;
  private materialStoreValue: GpuMaterialStore | undefined;
  private textureResidencyValue: TextureResidency | undefined;
  private timerIncrementValue = 0;
  private destroyed = false;

  constructor(device: GPUDevice, profiler = new FrameProfiler()) {
    this.device = device;
    this.profiler = profiler;
    this.profiler.configure({
      gpuTimestampAvailable: device.features.has("timestamp-query")
    });
    this.profiler.attachResourceAccounting(this.resource_accounting);
    this.profiler.attachGpuDevice(device);
    registerGpuQueueProfiler(device, profiler);
    this.collectionLimitsValue = new GPUCollectionLimits(device);
    this.buffer_allocator_main = new GPUBufferAllocator(device, this.resource_accounting);
    this.buffer_allocator_native = new GPUNativeBufferAllocator(device);
    this.buffer_allocator_staging = new GPUStagingBufferAllocator(device, this.resource_accounting);
    this.allocator_textures = new GPUTextureAllocator(device, this.resource_accounting);
    this.shader_modules = new ShaderModuleCache(device);
    this.pipeline_layouts = new PipelineLayoutCache(device);
    this.bind_groups = new BindGroupCache(device, this.pipeline_layouts);
    const pipelineObserver: PipelineCacheObserver = {
      onPipelineCacheHit: (kind) => profiler.addCounter(`pipeline.${kind}.cacheHits`, 1),
      onPipelineCacheMiss: (kind) => profiler.addCounter(`pipeline.${kind}.cacheMisses`, 1),
      onPipelineCreated: (kind, hostCallMs) => {
        profiler.addCounter(`pipeline.${kind}.createCount`, 1);
        profiler.addCounter(`pipeline.${kind}.hostCallMs`, hostCallMs);
      },
      onPipelineFirstUse: (kind) => profiler.addCounter(`pipeline.${kind}.firstUseCount`, 1)
    };
    this.render_pipelines = new RenderPipelineCache(
      device,
      this.pipeline_layouts,
      this.shader_modules,
      pipelineObserver
    );
    this.compute_pipelines = new ComputePipelineCache(
      device,
      this.pipeline_layouts,
      this.shader_modules,
      pipelineObserver
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
    const accounting = this.resource_accounting.created({
      kind: "buffer",
      owner: descriptor.label?.split("/", 1)[0] || "graphics",
      bytes: descriptor.size,
      label: descriptor.label
    });
    return GPUBufferWrapper.from(descriptor, buffer, () => {
      this.resource_accounting.destroyed(accounting);
    });
  }

  profilingResourceSnapshot(): ResourceAccountingSnapshot {
    return this.resource_accounting.snapshot();
  }

  get materials_resident(): GPUResidentMaterialContext {
    if (this.residentMaterials === undefined) {
      this.residentMaterials = new GPUResidentMaterialContext(this.device, this);
    }
    return this.residentMaterials;
  }

  /** Lazily creates the R2 package residency owner; legacy-only pages pay zero cost. */
  get assets(): GpuAssetStore {
    this.assetStoreValue ??= new GpuAssetStore(this.device, this.resource_accounting);
    return this.assetStoreValue;
  }

  /** Lazily creates the R2 compact Instance table; legacy-only pages pay zero cost. */
  get gpu_scene(): GpuScene {
    this.gpuSceneValue ??= new GpuScene(this.device, this.assets, this.resource_accounting);
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

  /** Lazily creates the stable Packed MaterialRecord owner. */
  get material_store(): GpuMaterialStore {
    this.materialStoreValue ??= new GpuMaterialStore(this.device);
    return this.materialStoreValue;
  }

  get material_store_if_created(): GpuMaterialStore | undefined {
    return this.materialStoreValue;
  }

  /** Lazily creates the independent Packed texture residency owner. */
  get texture_residency(): TextureResidency {
    this.textureResidencyValue ??= new TextureResidency(this);
    return this.textureResidencyValue;
  }

  get texture_residency_if_created(): TextureResidency | undefined {
    return this.textureResidencyValue;
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
        if (!command.isAborted && !this.destroyed) {
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
      (this.materialStoreValue?.evidence().allocatedBytes ?? 0) +
      (this.textureResidencyValue?.evidence().allocatedBytes ?? 0) +
      this.buffer_allocator_main.gpu_memory_usage +
      this.buffer_allocator_staging.gpu_memory_usage +
      this.allocator_textures.gpu_memory_usage +
      this.textures.gpu_memory_usage
    );
  }

  /** Internal observability seam used by renderer evidence; it owns no resources. */
  memoryEvidence(): GraphicsMemoryEvidence {
    const assets = this.assetStoreValue?.evidence();
    const scene = this.gpuSceneValue?.evidence();
    const materials = this.materialStoreValue?.evidence();
    const textureResidency = this.textureResidencyValue?.evidence();
    const buffers = this.buffer_allocator_main.evidence();
    const textures = this.allocator_textures.evidence();
    const baseLayerBytes = textureResidency === undefined
      ? 0
      : textureArrayLayerBytes(textureResidency.textureSize, textureResidency.mipLevelCount);
    const highLayerBytes = textureResidency === undefined
      ? 0
      : textureArrayLayerBytes(
          textureResidency.highResolutionTextureSize,
          textureResidency.highResolutionMipLevelCount
        );
    const residentMaterialBytes = materials === undefined
      ? 0
      : materials.residentMaterialSlotCount * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE +
        ((textureResidency?.residentTextureCount ?? 0) -
          (textureResidency?.residentHighResolutionTextureCount ?? 0)) * baseLayerBytes +
        (textureResidency?.residentHighResolutionTextureCount ?? 0) * highLayerBytes;
    const retiringMaterialBytes = materials === undefined
      ? 0
      : materials.retiringMaterialSlotCount * GPU_MATERIAL_VISIBILITY_RECORD_STRIDE +
        ((textureResidency?.retiringTextureCount ?? 0) -
          (textureResidency?.retiringHighResolutionTextureCount ?? 0)) * baseLayerBytes +
        (textureResidency?.retiringHighResolutionTextureCount ?? 0) * highLayerBytes;
    const longLivedAllocatedBytes =
      (assets?.allocatedBytes ?? 0) +
      (scene?.allocatedBytes ?? 0) +
      (materials?.allocatedBytes ?? 0) +
      (textureResidency?.allocatedBytes ?? 0);
    const residentLogicalBytes =
      (assets?.residentBytes ?? 0) +
      (scene?.residentBytes ?? 0) +
      residentMaterialBytes;
    const retiringBytes =
      (assets?.retiringBytes ?? 0) +
      (scene?.retiringBytes ?? 0) +
      retiringMaterialBytes;
    const reclaimableBytes =
      (assets?.reclaimableBytes ?? 0) +
      (scene?.reclaimableBytes ?? 0) +
      buffers.cachedBytes +
      textures.cachedBytes;
    const transientPoolBytes = buffers.allocatedBytes + textures.allocatedBytes;
    const fragmentationBytes = Math.max(
      0,
      longLivedAllocatedBytes - residentLogicalBytes - retiringBytes
    );
    return Object.freeze({
      schemaVersion: 1,
      allocatedBytes: this.gpu_memory_usage,
      residentLogicalBytes,
      transientPoolBytes,
      retiringBytes,
      reclaimableBytes,
      fragmentationBytes,
      owners: Object.freeze({
        assets: Object.freeze({
          allocatedBytes: assets?.allocatedBytes ?? 0,
          residentBytes: assets?.residentBytes ?? 0,
          retiringBytes: assets?.retiringBytes ?? 0,
          reclaimableBytes: assets?.reclaimableBytes ?? 0
        }),
        scene: Object.freeze({
          allocatedBytes: scene?.allocatedBytes ?? 0,
          residentBytes: scene?.residentBytes ?? 0,
          retiringBytes: scene?.retiringBytes ?? 0,
          reclaimableBytes: scene?.reclaimableBytes ?? 0
        }),
        materials: Object.freeze({
          allocatedBytes: materials?.allocatedBytes ?? 0,
          residentLogicalBytes: residentMaterialBytes,
          retiringBytes: retiringMaterialBytes,
          residentTextures: textureResidency?.residentTextureCount ?? 0,
          residentHighResolutionTextures: textureResidency?.residentHighResolutionTextureCount ?? 0,
          retiringHighResolutionTextures: textureResidency?.retiringHighResolutionTextureCount ?? 0
        }),
        transientBuffers: Object.freeze({ ...buffers }),
        transientTextures: Object.freeze({ ...textures })
      }),
      limitations: Object.freeze([
        "fragmentationBytes covers capacity slack in asset, scene and material tables",
        "transientPoolBytes reports shared allocator allocation after graph execution",
        "non-table persistent textures are included in allocatedBytes but not residentLogicalBytes"
      ])
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    unregisterGpuQueueProfiler(this.device, this.profiler);
    this.packedScenesValue?.destroy();
    this.packedScenesValue = undefined;
    this.materialStoreValue?.destroy();
    this.materialStoreValue = undefined;
    this.textureResidencyValue?.destroy();
    this.textureResidencyValue = undefined;
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
    this.allocator_textures.destroy();
    this.collectionLimitsValue.destroy();
    this.profiler.detachGpuDevice(this.device);
  }
}

function textureArrayLayerBytes(size: number, mipLevelCount: number): number {
  let pixels = 0;
  for (let level = 0; level < Math.max(1, mipLevelCount); level++) {
    const extent = Math.max(1, size >> level);
    pixels += extent * extent;
  }
  return pixels * 4;
}
