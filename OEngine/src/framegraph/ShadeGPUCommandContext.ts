/**
 * GPU 命令上下文：封装命令编码器、渲染/计算通道和调试计时，作为帧图执行层的统一入口。
 */

import { ChangeSignal } from "../core/Signal.js";
import { arrayRemoveFirst } from "../core/arrayUtils.js";
import type { WebGPUType } from "../core/WebGPUTypes.js";
import { writeWgslToBuffer } from "../core/WgslBufferIO.js";
import type { GPUBufferPoolDescriptor } from "../gpu/GPUBufferAllocator.js";
import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import type {
  CachedComputePipelineDescriptor,
  CachedRenderPipelineDescriptor
} from "../gpu/GPUDescriptorCaches.js";
import {
  FrameGraph,
  FrameGraphContext,
  FrameGraphResourceManager
} from "./FrameGraph.js";
import { GPUTimer, type GPUTimerResult } from "./GPUTimer.js";

type ConstructComputePassOptions = {
  pipeline: CachedComputePipelineDescriptor;
  label?: string;
  bindings?: GPUBindingResource[][];
};

type ConstructRenderPassOptions = {
  label?: string;
  pipeline: CachedRenderPipelineDescriptor;
  bindings?: GPUBindingResource[][];
  colorAttachments: GPURenderPassColorAttachment[];
  depthStencilAttachment?: GPURenderPassDepthStencilAttachment;
};

let openContextCount = 0;
let nextContextId = 0;
let openContextWarningCount = 0;
const openContexts: ShadeGPUCommandContext[] = [];
const transientBufferDescriptor: GPUBufferPoolDescriptor = {
  size: 0,
  usage: 0
};

export class ShadeGPUCommandContext {
  readonly #id = nextContextId++;
  #encoder: GPUCommandEncoder | undefined;
  #timedEncoderFacade: GPUCommandEncoder | undefined;
  #graphics!: GraphicsContext;
  #transientBuffers: GPUBuffer[] = [];
  #stagingBuffers: GPUBuffer[] = [];
  #gpuTimer: GPUTimer | undefined;
  #debugTimersCallback: (results: GPUTimerResult[]) => void = () => {};
  #finished = false;

  readonly onFinished = new ChangeSignal<this>();
  readonly onBeforeFinish = new ChangeSignal<this>();

  constructor() {}

  get id(): number {
    return this.#id;
  }

  get isGPUCommandContext(): boolean {
    return true;
  }

  get gpu_encoder(): GPUCommandEncoder {
    const encoder = this.#encoder!;
    if (this.#gpuTimer === undefined) return encoder;
    if (this.#timedEncoderFacade !== undefined) return this.#timedEncoderFacade;

    const context = this;
    const boundMethods = new Map<PropertyKey, Function>();
    this.#timedEncoderFacade = new Proxy(encoder, {
      get(target, property): unknown {
        if (property === "beginComputePass") {
          return (descriptor?: GPUComputePassDescriptor) =>
            context.beginComputePass(descriptor);
        }
        if (property === "beginRenderPass") {
          return (descriptor: GPURenderPassDescriptor) =>
            context.beginRenderPass(descriptor);
        }
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        let bound = boundMethods.get(property);
        if (bound === undefined) {
          const created = value.bind(target) as Function;
          boundMethods.set(property, created);
          bound = created;
        }
        return bound;
      },
      set(target, property, value): boolean {
        return Reflect.set(target, property, value, target);
      }
    }) as GPUCommandEncoder;
    return this.#timedEncoderFacade;
  }

  get device(): GPUDevice {
    return this.#graphics.device!;
  }

  get textures() {
    return this.#graphics.textures;
  }

  get done(): Promise<void> {
    if (this.#finished) return Promise.resolve();
    return new Promise((resolve) => {
      this.onFinished.addOne(resolve);
      if (this.#finished) resolve();
    });
  }

  static create(
    graphics: GraphicsContext,
    label = ""
  ): ShadeGPUCommandContext {
    const context = new ShadeGPUCommandContext();
    context.#graphics = graphics;
    context.#encoder = graphics.device!.createCommandEncoder({ label });
    openContextCount++;
    openContexts.push(context);
    if (openContextCount > 1024 && openContextWarningCount < 20) {
      console.warn("Too many open GPU contexts");
      openContextWarningCount++;
    }
    return context;
  }

  enable_debug_timers(
    callback: (results: GPUTimerResult[]) => void
  ): void {
    if (this.#gpuTimer !== undefined) return;
    this.#gpuTimer = new GPUTimer(this.device);
    this.#debugTimersCallback = callback;
  }

  createFrameGraphContext(): FrameGraphContext {
    return new FrameGraphContext({
      encoder: this,
      device: this.device,
      graphics: this.#graphics,
      resource_manager: new FrameGraphResourceManager(this.device)
    });
  }

  encodeGraph(graph: FrameGraph): void {
    const context = this.createFrameGraphContext();
    graph.compile();
    graph.execute(context);
  }

  clearBuffer(buffer: GPUBuffer, offset = 0, size?: number): void {
    this.#encoder!.clearBuffer(buffer, offset, size);
  }

  clearTexture(): void {
    throw new Error(
      "Documentation hint only, use texture_fill_rectangle instead"
    );
  }

  copyBufferToBuffer(
    source: GPUBuffer,
    sourceOffset: number,
    destination: GPUBuffer,
    destinationOffset: number,
    size?: number
  ): void {
    this.#encoder!.copyBufferToBuffer(
      source,
      sourceOffset,
      destination,
      destinationOffset,
      size
    );
  }

  copyTextureToTexture(
    source: GPUImageCopyTexture,
    destination: GPUImageCopyTexture,
    copySize: GPUExtent3DStrict
  ): void {
    this.#encoder!.copyTextureToTexture(source, destination, copySize);
  }

  beginComputePass(
    descriptor?: GPUComputePassDescriptor
  ): GPUComputePassEncoder {
    let resolved = descriptor;
    if (
      this.#gpuTimer !== undefined &&
      this.device.features.has("timestamp-query")
    ) {
      resolved!.timestampWrites = this.#gpuTimer.getComputeWrites(
        descriptor!.label
      );
    }
    return this.#encoder!.beginComputePass(resolved);
  }

  constructComputePass({
    pipeline,
    label,
    bindings = []
  }: ConstructComputePassOptions): GPUComputePassEncoder {
    const descriptor: GPUComputePassDescriptor = { label };
    if (label === undefined) descriptor.label = pipeline.label;
    const pass = this.beginComputePass(descriptor);
    const nativePipeline = this.#graphics.compute_pipelines.obtain(pipeline);
    pass.setPipeline(nativePipeline);
    this.#graphics.setPipelineBindings(pass, pipeline, bindings);
    return pass;
  }

  pushDebugGroup(label: string): void {
    void label;
  }

  popDebugGroup(): void {}

  insertDebugMarker(label: string): void {
    this.#encoder!.insertDebugMarker(label);
  }

  constructRenderPass({
    label,
    pipeline,
    bindings,
    colorAttachments,
    depthStencilAttachment
  }: ConstructRenderPassOptions): GPURenderPassEncoder {
    const descriptor: GPURenderPassDescriptor = {
      label,
      colorAttachments,
      depthStencilAttachment
    };
    if (label === undefined) descriptor.label = pipeline.label;
    const nativePipeline = this.#graphics.render_pipelines.obtain(pipeline);
    const pass = this.beginRenderPass(descriptor);
    pass.setPipeline(nativePipeline);
    this.#graphics.setPipelineBindings(pass, pipeline, bindings!);
    return pass;
  }

  beginRenderPass(
    descriptor: GPURenderPassDescriptor
  ): GPURenderPassEncoder {
    if (
      this.#gpuTimer !== undefined &&
      this.device.features.has("timestamp-query")
    ) {
      descriptor.timestampWrites = this.#gpuTimer.getRenderWrites(
        descriptor.label
      );
    }
    return this.#encoder!.beginRenderPass(descriptor);
  }

  resolveQuerySet(
    querySet: GPUQuerySet,
    firstQuery: number,
    queryCount: number,
    destination: GPUBuffer,
    destinationOffset: number
  ): void {
    this.#encoder!.resolveQuerySet(
      querySet,
      firstQuery,
      queryCount,
      destination,
      destinationOffset
    );
  }

  releaseTransientBuffer(buffer: GPUBuffer): boolean {
    return (
      arrayRemoveFirst(this.#transientBuffers, buffer) &&
      this.#graphics.buffer_allocator_main.release(buffer)
    );
  }

  allocateTransientBuffer(
    usage: GPUBufferUsageFlags = GPUBufferUsage.UNIFORM,
    size: number
  ): GPUBuffer {
    transientBufferDescriptor.size = size;
    transientBufferDescriptor.usage = usage | GPUBufferUsage.COPY_DST;
    const buffer = this.#graphics.buffer_allocator_main.get(
      transientBufferDescriptor,
      this
    );
    this.#transientBuffers.push(buffer);
    return buffer;
  }

  allocateTransientBufferAndLoad(
    data: ArrayBuffer,
    usage: GPUBufferUsageFlags = GPUBufferUsage.UNIFORM,
    offset = 0,
    size = data.byteLength
  ): GPUBuffer {
    const buffer = this.allocateTransientBuffer(usage, size);
    this.writeBuffer(buffer, 0, data, offset, size);
    return buffer;
  }

  allocateTransientValueBuffer<T>(
    type: WebGPUType,
    value: T,
    usage?: GPUBufferUsageFlags
  ): GPUBuffer {
    const buffer = this.allocateTransientBuffer(usage, type.aligned_size);
    this.writeValueBuffer(buffer, 0, type, value);
    return buffer;
  }

  writeValueBuffer<T>(
    buffer: GPUBuffer,
    buffer_offset: number,
    type: WebGPUType,
    value: T
  ): void {
    const size = type.aligned_size;
    const staging = this.#graphics.buffer_allocator_staging.get(size);
    writeWgslToBuffer(value, type, staging.getMappedRange(0, size), 0);
    staging.unmap();
    this.#stagingBuffers.push(staging);
    this.copyBufferToBuffer(staging, 0, buffer, buffer_offset, size);
  }

  writeBuffer(
    buffer: GPUBuffer,
    buffer_offset: number,
    data: ArrayBuffer,
    data_offset: number,
    size: number
  ): void {
    const staging = this.#graphics.buffer_allocator_staging.get(size);
    new Uint8Array(staging.getMappedRange(0, size)).set(
      new Uint8Array(data, data_offset, size)
    );
    staging.unmap();
    this.#stagingBuffers.push(staging);
    this.copyBufferToBuffer(staging, 0, buffer, buffer_offset, size);
  }

  finish(): void {
    if (this.#finished) {
      console.warn("Context already finished");
      return;
    }

    this.onBeforeFinish.send1(this);
    openContextCount--;
    arrayRemoveFirst(openContexts, this);

    const encoder = this.#encoder!;
    const timer = this.#gpuTimer;
    if (timer !== undefined) timer.resolve(encoder);
    this.#finished = true;
    this.#encoder = undefined;
    this.#timedEncoderFacade = undefined;

    const commandBuffer = encoder.finish();
    this.#graphics.device!.queue.submit([commandBuffer]);
    this.#releaseBuffers();

    if (timer !== undefined) {
      const callback = this.#debugTimersCallback;
      void timer
        .download_results()
        .then(() => {
          callback(timer.results_to_console_table());
        })
        .finally(() => {
          timer.destroy();
        });
      this.#gpuTimer = undefined;
    }

    this.onFinished.send1(this);
  }

  #releaseBuffers(): void {
    const transientAllocator = this.#graphics.buffer_allocator_main;
    for (
      let index = this.#transientBuffers.length - 1;
      index >= 0;
      index--
    ) {
      transientAllocator.release(this.#transientBuffers[index]!);
    }
    const stagingAllocator = this.#graphics.buffer_allocator_staging;
    for (const buffer of this.#stagingBuffers) {
      stagingAllocator.release(buffer);
    }
  }
}
