/** Compute HZB owner：持有 per-view ping-pong history、编码金字塔并输出真实工作量证据。 */

import {
  HZB_FROM_DEPTH_COMPUTE_WGSL,
  HZB_REDUCE_COMPUTE_WGSL,
  HZB_WORKGROUP_SIZE
} from "../shaders/hzb_reduce.js";
import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "../gpu/GPUDescriptorCaches.js";
import { GPUTextureContext } from "../gpu/GPUTextureContext.js";
import { gd, id } from "../gpu/GPUTextureDescriptors.js";
import { writeGpuBuffer } from "../gpu/GpuQueueEvidence.js";
import { HzbHistoryState, type HzbHistoryRevision } from "./HzbHistory.js";
import { hzbMipLevelCount } from "./HzbReference.js";

export { hzbMipLevelCount } from "./HzbReference.js";

export const HZB_FORMAT: GPUTextureFormat = "rg16float";
export const HZB_FORMAT_REVISION = 2;
export const HZB_COMPUTE_PASSES_PER_BUILD = 1;
const SOURCE_REGION_BYTES = 16;

const FROM_DEPTH_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "HZB/from-depth-group",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "depth", viewDimension: "2d" } },
    {
      binding: 1,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format: HZB_FORMAT, viewDimension: "2d" }
    },
    {
      binding: 2,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "uniform", minBindingSize: SOURCE_REGION_BYTES }
    }
  ]
};

const REDUCE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "HZB/reduce-group",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format: HZB_FORMAT, viewDimension: "2d" }
    }
  ]
};

const FROM_DEPTH_PIPELINE: CachedComputePipelineDescriptor = {
  label: "HZB/from-depth-compute",
  layout: { label: "HZB/from-depth-layout", bindGroupLayouts: [FROM_DEPTH_GROUP] },
  compute: {
    module: { label: "HZB/from-depth-module", code: HZB_FROM_DEPTH_COMPUTE_WGSL },
    entryPoint: "main"
  }
};

const REDUCE_PIPELINE: CachedComputePipelineDescriptor = {
  label: "HZB/reduce-compute",
  layout: { label: "HZB/reduce-layout", bindGroupLayouts: [REDUCE_GROUP] },
  compute: {
    module: { label: "HZB/reduce-module", code: HZB_REDUCE_COMPUTE_WGSL },
    entryPoint: "main"
  }
};

export type HzbFrameRevision = Partial<
  Pick<HzbHistoryRevision, "camera" | "renderScale" | "feature" | "format">
>;

export class HierarchicalZBuffer {
  private readonly device: GPUDevice;
  private readonly graphics: GraphicsContext;
  private readonly textures: readonly [GPUTextureContext, GPUTextureContext];
  private readonly mipViews: [GPUTextureView[], GPUTextureView[]] = [[], []];
  private readonly history = new HzbHistoryState();
  private viewportW = 1;
  private viewportH = 1;
  private hzbW = 0;
  private hzbH = 0;
  private mipCount = 0;
  private readonly sourceRegionData = new Uint32Array(4);
  private readonly uploadedSourceRegion = [-1, -1, -1, -1];
  private readonly sourceRegionBuffer: GPUBuffer;
  private pipelineFromDepth: GPUComputePipeline | null = null;
  private pipelineReduce: GPUComputePipeline | null = null;

  lastBuilt = false;
  lastMipCount = 0;
  lastBuildCount = 0;
  lastComputePassCount = 0;
  lastDispatchCount = 0;
  lastOutputPixels = 0;

  constructor(graphics: GraphicsContext) {
    const device = graphics.device;
    if (device === null) throw new Error("HierarchicalZBuffer: GraphicsContext has no device");
    this.graphics = graphics;
    this.device = device;
    const makeTexture = (index: number): GPUTextureContext =>
      graphics.textures.contextFromDescriptor(id.from({
        label: `HZB/history-${index}`,
        format: HZB_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        mipLevelCount: 1,
        size: [1, 1, 1]
      }));
    this.textures = [makeTexture(0), makeTexture(1)];
    this.sourceRegionBuffer = device.createBuffer({
      label: "HZB/source-region",
      size: SOURCE_REGION_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  get width(): number { return this.hzbW; }
  get height(): number { return this.hzbH; }
  get mipLevelCount(): number { return this.mipCount; }
  get historyValid(): boolean { return this.history.valid; }
  get historyInvalidationCount(): number { return this.history.invalidationCount; }

  getCurrentTexture(): GPUTextureContext {
    return this.textures[this.history.writeTextureIndex];
  }

  getPreviousTexture(): GPUTextureContext {
    return this.textures[this.history.committedTextureIndex];
  }

  setViewportSize(width: number, height: number): void {
    this.viewportW = Math.max(1, width | 0);
    this.viewportH = Math.max(1, height | 0);
    this.ensureTextures(Math.max(this.viewportW >>> 1, 1), Math.max(this.viewportH >>> 1, 1));
  }

  beginFrame(frameIndex: number, revision: HzbFrameRevision = {}): void {
    this.history.beginFrame(frameIndex, {
      width: this.hzbW,
      height: this.hzbH,
      camera: revision.camera ?? 0,
      renderScale: revision.renderScale ?? 0,
      feature: revision.feature ?? 0,
      format: revision.format ?? HZB_FORMAT_REVISION
    });
  }

  commitHistory(frameIndex: number): boolean {
    return this.history.commit(frameIndex);
  }

  invalidate(reason: "camera-cut" | "feature-toggle" | "explicit" = "explicit"): void {
    this.history.invalidate(reason);
  }

  resetFrameStatistics(): void {
    this.lastBuilt = false;
    this.lastMipCount = 0;
    this.lastBuildCount = 0;
    this.lastComputePassCount = 0;
    this.lastDispatchCount = 0;
    this.lastOutputPixels = 0;
  }

  build(
    encoder: GPUCommandEncoder,
    sourceDepth: GPUTextureContext,
    viewport?: readonly [number, number, number, number]
  ): void {
    if (this.mipCount < 1) this.setViewportSize(sourceDepth.width, sourceDepth.height);
    if (this.mipCount < 1) return;
    this.ensurePipelines();
    if (!this.pipelineFromDepth || !this.pipelineReduce) return;

    this.sourceRegionData[0] = Math.max(0, Math.floor(viewport?.[0] ?? 0));
    this.sourceRegionData[1] = Math.max(0, Math.floor(viewport?.[1] ?? 0));
    this.sourceRegionData[2] = this.viewportW;
    this.sourceRegionData[3] = this.viewportH;
    if (this.sourceRegionData.some((value, index) => value !== this.uploadedSourceRegion[index])) {
      writeGpuBuffer(
        this.device.queue,
        "HierarchicalZBuffer/source-region",
        this.sourceRegionBuffer,
        0,
        this.sourceRegionData
      );
      for (let index = 0; index < 4; index++) {
        this.uploadedSourceRegion[index] = this.sourceRegionData[index]!;
      }
    }

    const sourceView = sourceDepth.obtainView(gd.from({
      dimension: "2d",
      baseMipLevel: 0,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 1
    }));
    const writeIndex = this.history.writeTextureIndex;
    const pass = encoder.beginComputePass({ label: "HZB/compute-pyramid" });
    pass.setPipeline(this.pipelineFromDepth);
    pass.setBindGroup(0, this.graphics.bind_groups.obtain({
      layout: FROM_DEPTH_GROUP,
      entries: [sourceView, this.obtainMipView(writeIndex, 0), {
        buffer: this.sourceRegionBuffer,
        offset: 0,
        size: SOURCE_REGION_BYTES
      }]
    }));
    this.dispatchMip(pass, this.hzbW, this.hzbH);

    pass.setPipeline(this.pipelineReduce);
    let width = this.hzbW;
    let height = this.hzbH;
    for (let mip = 1; mip < this.mipCount; mip++) {
      pass.setBindGroup(0, this.graphics.bind_groups.obtain({
        layout: REDUCE_GROUP,
        entries: [this.obtainMipView(writeIndex, mip - 1), this.obtainMipView(writeIndex, mip)]
      }));
      width = Math.max(1, width >> 1);
      height = Math.max(1, height >> 1);
      this.dispatchMip(pass, width, height);
    }
    pass.end();

    this.history.markBuilt();
    this.lastBuilt = true;
    this.lastMipCount = this.mipCount;
    this.lastBuildCount++;
    this.lastComputePassCount++;
    this.lastDispatchCount += this.mipCount;
  }

  obtainPreviousView(): GPUTextureView | null {
    return this.history.valid ? this.obtainFullView(this.history.committedTextureIndex) : null;
  }

  obtainCurrentView(): GPUTextureView | null {
    return this.mipCount > 0 ? this.obtainFullView(this.history.writeTextureIndex) : null;
  }

  obtainFinalView(): GPUTextureView | null {
    return this.history.builtThisFrame ? this.obtainCurrentView() : this.obtainPreviousView();
  }

  private ensureTextures(width: number, height: number): void {
    const mips = hzbMipLevelCount(width, height);
    if (this.hzbW === width && this.hzbH === height && this.mipCount === mips) return;
    this.hzbW = width;
    this.hzbH = height;
    this.mipCount = mips;
    for (let index = 0; index < 2; index++) {
      const texture = this.textures[index as 0 | 1];
      texture.descriptor.mipLevelCount = mips;
      texture.resize(width, height);
      this.mipViews[index as 0 | 1] = [];
    }
  }

  private ensurePipelines(): void {
    this.pipelineFromDepth ??= this.graphics.compute_pipelines.obtain(FROM_DEPTH_PIPELINE);
    this.pipelineReduce ??= this.graphics.compute_pipelines.obtain(REDUCE_PIPELINE);
  }

  private dispatchMip(pass: GPUComputePassEncoder, width: number, height: number): void {
    pass.dispatchWorkgroups(
      Math.ceil(width / HZB_WORKGROUP_SIZE),
      Math.ceil(height / HZB_WORKGROUP_SIZE),
      1
    );
    this.lastOutputPixels += width * height;
  }

  private obtainFullView(textureIndex: 0 | 1): GPUTextureView {
    return this.textures[textureIndex].obtainView(gd.from({
      dimension: "2d",
      baseMipLevel: 0,
      mipLevelCount: this.mipCount,
      baseArrayLayer: 0,
      arrayLayerCount: 1
    }));
  }

  private obtainMipView(textureIndex: 0 | 1, mip: number): GPUTextureView {
    let view = this.mipViews[textureIndex][mip];
    if (view === undefined) {
      view = this.textures[textureIndex].obtainView(gd.from({
        baseMipLevel: mip,
        mipLevelCount: 1,
        dimension: "2d",
        baseArrayLayer: 0,
        arrayLayerCount: 1
      }));
      this.mipViews[textureIndex][mip] = view;
    }
    return view;
  }

  destroy(): void {
    this.textures[0].destroy();
    this.textures[1].destroy();
    this.mipViews[0] = [];
    this.mipViews[1] = [];
    this.sourceRegionBuffer.destroy();
    this.hzbW = 0;
    this.hzbH = 0;
    this.mipCount = 0;
    this.pipelineFromDepth = null;
    this.pipelineReduce = null;
  }
}
