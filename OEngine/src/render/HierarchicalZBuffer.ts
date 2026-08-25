/**
 * HierarchicalZBuffer：负责渲染管线编排、视图状态或渲染目标管理。
 */

import {
  HZB_FROM_DEPTH_CLIP_WGSL,
  HZB_FROM_DEPTH_WGSL,
  HZB_REDUCE_MIP_WGSL
} from "../shaders/hzb_reduce.js";
import type { GraphicsContext } from "../gpu/GraphicsContext.js";
import { writeGpuBuffer } from "../gpu/GpuQueueEvidence.js";
import type {
  CachedRenderPipelineDescriptor
} from "../gpu/GPUDescriptorCaches.js";
import { GPUTextureContext } from "../gpu/GPUTextureContext.js";
import { gd, id } from "../gpu/GPUTextureDescriptors.js";

export const HZB_FORMAT: GPUTextureFormat = "rg16float";

export const HZB_RES_UBO_BYTES = 8;

const HZB_FROM_DEPTH_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: HZB_RES_UBO_BYTES }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "depth", viewDimension: "2d" }
    }
  ]
};

const HZB_REDUCE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: HZB_RES_UBO_BYTES }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "unfilterable-float", viewDimension: "2d" }
    }
  ]
};

const HZB_CLIP_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: 16 }
    },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: HZB_RES_UBO_BYTES }
    },
    {
      binding: 2,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: "depth", viewDimension: "2d" }
    }
  ]
};

const HZB_FROM_DEPTH_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "",
  layout: { label: "", bindGroupLayouts: [HZB_FROM_DEPTH_GROUP] },
  vertex: {
    module: { label: "", code: HZB_FROM_DEPTH_WGSL },
    entryPoint: "vs_main"
  },
  fragment: {
    module: { label: "", code: HZB_FROM_DEPTH_WGSL },
    entryPoint: "fs_main",
    targets: [{ format: HZB_FORMAT }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" }
};

const HZB_REDUCE_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "",
  layout: { label: "", bindGroupLayouts: [HZB_REDUCE_GROUP] },
  vertex: {
    module: { label: "", code: HZB_REDUCE_MIP_WGSL },
    entryPoint: "vs_main"
  },
  fragment: {
    module: { label: "", code: HZB_REDUCE_MIP_WGSL },
    entryPoint: "fs_main",
    targets: [{ format: HZB_FORMAT }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" }
};

const HZB_CLIP_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "",
  layout: { label: "", bindGroupLayouts: [HZB_CLIP_GROUP] },
  vertex: {
    module: { label: "", code: HZB_FROM_DEPTH_CLIP_WGSL },
    entryPoint: "vs_main"
  },
  fragment: {
    module: { label: "", code: HZB_FROM_DEPTH_CLIP_WGSL },
    entryPoint: "fs_main",
    targets: [{ format: HZB_FORMAT }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" }
};

export function hzbMipLevelCount(width: number, height: number): number {
  const n = Math.max(width, height);
  if (n <= 0) return 0;
  return Math.floor(Math.log2(n)) + 1;
}

export class HierarchicalZBuffer {
  private readonly device: GPUDevice;
  private readonly graphics: GraphicsContext;
  private readonly texture: GPUTextureContext;
  private mipViews: GPUTextureView[] = [];
  private viewportW = 1;
  private viewportH = 1;
  private hzbW = 0;
  private hzbH = 0;
  private mipCount = 0;

  private resBuffer: GPUBuffer | null = null;
  private resStride = 256;

  private pipelineFromDepth: GPURenderPipeline | null = null;
  private pipelineClip: GPURenderPipeline | null = null;
  private pipelineReduce: GPURenderPipeline | null = null;
  private readonly clipData = new Float32Array(4);
  private readonly clipBuffer: GPUBuffer;

  lastBuilt = false;
  lastMipCount = 0;

  constructor(graphics: GraphicsContext) {
    const device = graphics.device;
    if (device === null) {
      throw new Error("HierarchicalZBuffer: GraphicsContext has no device");
    }
    this.graphics = graphics;
    this.device = device;
    this.texture = graphics.textures.contextFromDescriptor(id.from({
      label: "",
      format: HZB_FORMAT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT,
      mipLevelCount: 1,
      size: [1, 1, 1]
    }));
    this.clipBuffer = device.createBuffer({
      label: "",
      size: this.clipData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  getTexture(): GPUTextureContext {
    return this.texture;
  }

  get width(): number {
    return this.hzbW;
  }

  get height(): number {
    return this.hzbH;
  }

  get mipLevelCount(): number {
    return this.mipCount;
  }

  setViewportSize(width: number, height: number): void {
    this.viewportW = Math.max(1, width | 0);
    this.viewportH = Math.max(1, height | 0);
    const hw = Math.max(this.viewportW >>> 1, 1);
    const hh = Math.max(this.viewportH >>> 1, 1);
    this.ensureTexture(hw, hh);
  }

  private ensureTexture(w: number, h: number): void {
    const mips = hzbMipLevelCount(w, h);
    if (
      this.hzbW === w &&
      this.hzbH === h &&
      this.mipCount === mips
    ) {
      return;
    }
    this.hzbW = w;
    this.hzbH = h;
    this.mipCount = mips;
    this.texture.descriptor.mipLevelCount = mips;
    this.texture.resize(w, h);
    this.mipViews = [];

    this.resStride = Math.max(
      HZB_RES_UBO_BYTES,
      this.device.limits.minUniformBufferOffsetAlignment
    );
    const resBytes = (mips + 1) * this.resStride;
    this.resBuffer?.destroy();
    this.resBuffer = this.device.createBuffer({
      label: "",
      size: resBytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true
    });

    const u32 = new Uint32Array(this.resBuffer.getMappedRange());
    let cw = w;
    let ch = h;
    const strideU32 = this.resStride >>> 2;
    for (let i = 0; i < mips; i++) {
      const base = i * strideU32;
      u32[base] = cw >>> 0;
      u32[base + 1] = ch >>> 0;
      cw = Math.max(1, cw >>> 1);
      ch = Math.max(1, ch >>> 1);
    }
    this.resBuffer.unmap();
  }

  private ensurePipelines(): void {
    if (this.pipelineFromDepth && this.pipelineClip && this.pipelineReduce) return;
    this.pipelineFromDepth = this.graphics.render_pipelines.obtain(
      HZB_FROM_DEPTH_PIPELINE
    );
    this.pipelineClip = this.graphics.render_pipelines.obtain(
      HZB_CLIP_PIPELINE
    );
    this.pipelineReduce = this.graphics.render_pipelines.obtain(
      HZB_REDUCE_PIPELINE
    );
  }

  build(
    encoder: GPUCommandEncoder,
    sourceDepth: GPUTextureContext,
    viewport?: readonly [number, number, number, number]
  ): void {
    this.lastBuilt = false;
    if (this.mipCount < 1 || !this.resBuffer) {
      this.setViewportSize(sourceDepth.width, sourceDepth.height);
    }
    if (!this.resBuffer || this.mipCount < 1) return;

    this.ensurePipelines();
    if (!this.pipelineFromDepth || !this.pipelineClip || !this.pipelineReduce) return;

    const useClip = viewport !== undefined && (
      (viewport[0] !== 0 && viewport[1] !== 0) ||
      this.viewportW !== sourceDepth.width ||
      this.viewportH !== sourceDepth.height
    );

    {
      const sourceView = sourceDepth.obtainView(gd.from({
        dimension: "2d",
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 1
      }));
      let bg: GPUBindGroup;
      let pipeline: GPURenderPipeline;
      if (useClip) {
        this.clipData[0] = viewport![0];
        this.clipData[1] = viewport![1];
        this.clipData[2] = this.viewportW;
        this.clipData[3] = this.viewportH;
        writeGpuBuffer(
          this.device.queue,
          "HierarchicalZBuffer/clip",
          this.clipBuffer,
          0,
          this.clipData
        );
        bg = this.graphics.bind_groups.obtain({
          layout: HZB_CLIP_GROUP,
          entries: [
            { buffer: this.clipBuffer },
            {
              buffer: this.resBuffer,
              offset: 0,
              size: HZB_RES_UBO_BYTES
            },
            sourceView
          ]
        });
        pipeline = this.pipelineClip;
      } else {
        bg = this.graphics.bind_groups.obtain({
          layout: HZB_FROM_DEPTH_GROUP,
          entries: [
            {
              buffer: this.resBuffer,
              offset: 0,
              size: HZB_RES_UBO_BYTES
            },
            sourceView
          ]
        });
        pipeline = this.pipelineFromDepth;
      }
      const pass = encoder.beginRenderPass({
        label: "HZB/build_mip0",
        colorAttachments: [
          {
            view: this.obtainMipView(0),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 1, g: 0, b: 0, a: 0 }
          }
        ]
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    }

    for (let m = 1; m < this.mipCount; m++) {
      const bg = this.graphics.bind_groups.obtain({
        layout: HZB_REDUCE_GROUP,
        entries: [
          {
            buffer: this.resBuffer,
            offset: m * this.resStride,
            size: HZB_RES_UBO_BYTES
          },
          this.obtainMipView(m - 1)
        ]
      });
      const pass = encoder.beginRenderPass({
        label: `HZB/build_mip${m}`,
        colorAttachments: [
          {
            view: this.obtainMipView(m),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 1, g: 0, b: 0, a: 0 }
          }
        ]
      });
      pass.setPipeline(this.pipelineReduce);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    }

    this.lastBuilt = true;
    this.lastMipCount = this.mipCount;
  }

  obtainFullView(): GPUTextureView | null {
    if (this.mipCount < 1) return null;
    return this.texture.obtainView(gd.from({
      dimension: "2d",
      baseMipLevel: 0,
      mipLevelCount: this.mipCount,
      baseArrayLayer: 0,
      arrayLayerCount: 1
    }));
  }

  private obtainMipView(mip: number): GPUTextureView {
    let view = this.mipViews[mip];
    if (view === undefined) {
      view = this.texture.obtainView(gd.from({
        baseMipLevel: mip,
        mipLevelCount: 1,
        dimension: "2d",
        baseArrayLayer: 0,
        arrayLayerCount: 1
      }));
      this.mipViews[mip] = view;
    }
    return view;
  }

  destroy(): void {
    this.texture.destroy();
    this.mipViews = [];
    this.resBuffer?.destroy();
    this.resBuffer = null;
    this.clipBuffer.destroy();
    this.hzbW = 0;
    this.hzbH = 0;
    this.mipCount = 0;
    this.pipelineFromDepth = null;
    this.pipelineClip = null;
    this.pipelineReduce = null;
  }
}
