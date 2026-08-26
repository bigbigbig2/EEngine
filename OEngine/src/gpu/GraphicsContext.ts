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
  readonly geometries: MeshletGpuTable;
  readonly materials: GPUMaterialRegistry;
  readonly samplers: GPUSamplerCache;
  readonly profiler: FrameProfiler;
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
    this.geometries = new MeshletGpuTable(this);
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

  async initialize(): Promise<void> {
    await STATIC_GRAPHICS_ENGINE_ASSETS.init();
  }

  update(): void {
    const command = ShadeGPUCommandContext.create(this, "GraphicsContext.update");
    this.geometries.update(command, "GraphicsContext");
    this.textures.update();
    this.materials.update(command);
    this.bind_groups.update();
    this.increment_time();
    this.allocator_textures.update();
    void this.collectionLimitsValue.update(command, this.buffer_allocator_main);
    command.finish();
    this.buffer_allocator_main.update();
  }

  get gpu_memory_usage(): number {
    return (
      this.geometries.gpu_memory_usage +
      this.buffer_allocator_main.gpu_memory_usage +
      this.buffer_allocator_staging.gpu_memory_usage +
      this.allocator_textures.gpu_memory_usage +
      this.textures.gpu_memory_usage
    );
  }

  destroy(): void {
    unregisterGpuQueueProfiler(this.device, this.profiler);
    this.residentMaterials?.destroy();
    this.buffer_allocator_main.destroy();
    this.buffer_allocator_native.destroy();
    this.buffer_allocator_staging.destroy();
    this.collectionLimitsValue.destroy();
    this.profiler.detachGpuDevice(this.device);
  }
}
