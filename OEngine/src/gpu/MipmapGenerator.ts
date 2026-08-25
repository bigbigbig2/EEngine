/**
 * MipmapGenerator：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import { TextureFilterType } from "../texture/TextureFilterType.js";
import {
  createNativeTexture,
  createNativeTextureView
} from "./GPUTextureDescriptors.js";
import {
  MIPMAP_FILTER_WGSL_BY_ID,
  MIPMAP_FULLSCREEN_VERTEX_WGSL,
  MIPMAP_PARAMS_BYTES
} from "../shaders/mipmap_filters.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import {
  submitGpuCommands,
  writeGpuBuffer
} from "./GpuQueueEvidence.js";
import type { CachedRenderPipelineDescriptor, CachedShaderModuleDescriptor } from "./GPUDescriptorCaches.js";

export type MipmapFilterConfig = {
  filter: number;
  base_filter: number;
  support: number;
  skip_distance: number;
};

export const MIPMAP_FILTER_CONFIGS: Readonly<Record<number, MipmapFilterConfig>> = {
  [TextureFilterType.Linear]: {
    filter: 0,
    base_filter: 0,
    support: 1,
    skip_distance: 0
  },
  [TextureFilterType.LinearNormal]: {
    filter: 1,
    base_filter: 0,
    support: 1,
    skip_distance: 0
  },
  [TextureFilterType.Mitchell]: {
    filter: 2,
    base_filter: 3,
    support: 2,
    skip_distance: 2
  },
  [TextureFilterType.MagicKernelSharp]: {
    filter: 4,
    base_filter: 4,
    support: 3.5,
    skip_distance: 1
  },
  [TextureFilterType.CatmullRom]: {
    filter: 6,
    base_filter: 0,
    support: 2,
    skip_distance: 2
  },
  [TextureFilterType.Wronski2021]: {
    filter: 7,
    base_filter: 0,
    support: 5,
    skip_distance: 1
  }
};

type ScheduledMipmap = {
  texture: GPUTexture;
  descriptor: GPUTextureDescriptor;
  filter: number;
};

const SRGB_TO_LINEAR_FORMAT: Readonly<Record<string, GPUTextureFormat>> = {
  "rgba8unorm-srgb": "rgba8unorm",
  "bgra8unorm-srgb": "bgra8unorm",
  "bc1-rgba-unorm-srgb": "bc1-rgba-unorm",
  "bc2-rgba-unorm-srgb": "bc2-rgba-unorm",
  "bc3-rgba-unorm-srgb": "bc3-rgba-unorm",
  "bc7-rgba-unorm-srgb": "bc7-rgba-unorm",
  "etc2-rgb8unorm-srgb": "etc2-rgb8unorm",
  "etc2-rgb8a1unorm-srgb": "etc2-rgb8a1unorm",
  "etc2-rgba8unorm-srgb": "etc2-rgba8unorm",
  "astc-4x4-unorm-srgb": "astc-4x4-unorm",
  "astc-5x4-unorm-srgb": "astc-5x4-unorm",
  "astc-5x5-unorm-srgb": "astc-5x5-unorm",
  "astc-6x5-unorm-srgb": "astc-6x5-unorm",
  "astc-6x6-unorm-srgb": "astc-6x6-unorm",
  "astc-8x5-unorm-srgb": "astc-8x5-unorm",
  "astc-8x6-unorm-srgb": "astc-8x6-unorm",
  "astc-8x8-unorm-srgb": "astc-8x8-unorm",
  "astc-10x5-unorm-srgb": "astc-10x5-unorm",
  "astc-10x6-unorm-srgb": "astc-10x6-unorm",
  "astc-10x8-unorm-srgb": "astc-10x8-unorm",
  "astc-10x10-unorm-srgb": "astc-10x10-unorm",
  "astc-12x10-unorm-srgb": "astc-12x10-unorm",
  "astc-12x12-unorm-srgb": "astc-12x12-unorm"
};

export class MipmapGenerator {
  private readonly sampler: GPUSampler;
  private readonly paramsStride: number;
  private readonly paramsBuffer: GPUBuffer;
  private readonly queue: ScheduledMipmap[] = [];
  private readonly shaderModules = new Map<number, CachedShaderModuleDescriptor>();
  private readonly pipelines = new Map<string, CachedRenderPipelineDescriptor>();
  private readonly device: GPUDevice;

  constructor(private readonly graphics: GraphicsContext) {
    const device = graphics.device;
    this.device = device;
    this.sampler = device.createSampler({ minFilter: "linear" });
    this.paramsStride = alignUp(
      MIPMAP_PARAMS_BYTES,
      device.limits.minUniformBufferOffsetAlignment
    );
    this.paramsBuffer = device.createBuffer({
      label: "",
      size: 32 * this.paramsStride,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
    });
  }

  destroy(): void {
    this.paramsBuffer.destroy();
  }

  schedule(
    texture: GPUTexture,
    descriptor: GPUTextureDescriptor,
    filter: number = TextureFilterType.Linear
  ): void {
    this.queue.push({ texture, descriptor, filter });
  }

  update(timeBudgetMs = Number.POSITIVE_INFINITY): void {
    const started = performance.now();
    while (this.queue.length > 0) {
      const scheduled = this.queue.shift()!;
      this.generateMipmap(
        scheduled.texture,
        scheduled.descriptor,
        scheduled.filter
      );
      if (performance.now() - started >= timeBudgetMs) break;
    }
  }

  flush(): void {
    this.update();
  }

  get pending_count(): number {
    return this.queue.length;
  }

  generateMipmap(
    source: GPUTexture,
    descriptor: GPUTextureDescriptor,
    filter: number = TextureFilterType.Linear,
    encoder?: GPUCommandEncoder
  ): GPUTexture {
    const mipLevelCount = source.mipLevelCount;
    if (mipLevelCount <= 1) return source;

    const width = source.width;
    const height = source.height;
    const layers = source.depthOrArrayLayers || 1;
    const ownEncoder = encoder === undefined;
    const commandEncoder = encoder ?? this.device.createCommandEncoder({});
    let inputTexture = source;
    const linearFormat = SRGB_TO_LINEAR_FORMAT[source.format] ?? descriptor.format;

    if (SRGB_TO_LINEAR_FORMAT[source.format] !== undefined) {
      const canUseLinearView =
        descriptor.viewFormats !== undefined &&
        Array.from(descriptor.viewFormats).includes(linearFormat);
      if (!canUseLinearView) {
        const linearTexture = createNativeTexture(this.device, {
          size: {
            width: Math.max(1, width),
            height: Math.max(1, height),
            depthOrArrayLayers: layers
          },
          format: linearFormat,
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.COPY_DST,
          mipLevelCount
        });
        commandEncoder.copyTextureToTexture(
          { texture: inputTexture },
          { texture: linearTexture, mipLevel: 0 },
          { width, height, depthOrArrayLayers: layers }
        );
        inputTexture = linearTexture;
      }
    }

    const params = ownEncoder
      ? this.paramsBuffer
      : this.device.createBuffer({
          label: "",
          size: this.paramsBuffer.size,
          usage: this.paramsBuffer.usage
        });
    this.writeParams(params, width, height);

    const config = MIPMAP_FILTER_CONFIGS[filter];
    if (config === undefined) {
      throw new Error(`Filter ${textureFilterName(filter)} is not supported!`);
    }
    const onePass = config.filter === config.base_filter;
    const basePipeline = this.obtainPipeline(linearFormat, config.base_filter);
    const finalPipeline = onePass
      ? null
      : this.obtainPipeline(linearFormat, config.filter);

    const dimension = descriptor.dimension ?? "2d";
    if (dimension === "3d" || dimension === "1d") {
      throw new Error(
        "Generating mipmaps for non-2d textures is currently unsupported!"
      );
    }

    const inputIsRenderable =
      (inputTexture.usage & GPUTextureUsage.RENDER_ATTACHMENT) !== 0;
    let outputTexture = inputTexture;
    if (!inputIsRenderable) {
      outputTexture = createNativeTexture(this.device, {
        size: {
          width: Math.max(1, width >>> 1),
          height: Math.max(1, height >>> 1),
          depthOrArrayLayers: layers
        },
        format: linearFormat,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.RENDER_ATTACHMENT,
        mipLevelCount: mipLevelCount - 1
      });
    }

    const needsIntermediate = !onePass && config.skip_distance === 0;
    let filteredTexture = outputTexture;
    if (needsIntermediate) {
      filteredTexture = createNativeTexture(this.device, {
        size: {
          width: Math.max(1, width >>> 1),
          height: Math.max(1, height >>> 1),
          depthOrArrayLayers: layers
        },
        format: linearFormat,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.RENDER_ATTACHMENT,
        mipLevelCount: mipLevelCount - 1
      });
    }

    for (let layer = 0; layer < layers; layer++) {
      let previousView = createNativeTextureView(inputTexture, {
        baseMipLevel: 0,
        mipLevelCount: 1,
        dimension: "2d",
        baseArrayLayer: layer,
        arrayLayerCount: 1,
        format: linearFormat
      });
      let targetMip = filteredTexture === inputTexture ? 1 : 0;
      for (let mipLevel = 1; mipLevel < mipLevelCount; mipLevel++) {
        const targetView = createNativeTextureView(filteredTexture, {
          baseMipLevel: targetMip++,
          mipLevelCount: 1,
          dimension: "2d",
          baseArrayLayer: layer,
          arrayLayerCount: 1,
          format: linearFormat
        });
        this.encodeFilterPass(
          commandEncoder,
          basePipeline,
          previousView,
          targetView,
          params,
          mipLevel * this.paramsStride
        );
        previousView = targetView;
      }

      if (onePass) continue;
      const skipDistance = config.skip_distance;
      for (let mipLevel = mipLevelCount - 1; mipLevel > 0; mipLevel--) {
        const sourceMip = Math.max(0, mipLevel - skipDistance);
        let filteredSourceMip = sourceMip;
        if (filteredTexture !== source && sourceMip > 0) {
          filteredSourceMip--;
        }
        const destinationTexture = inputIsRenderable
          ? inputTexture
          : outputTexture;
        const destinationMip = inputIsRenderable
          ? mipLevel
          : mipLevel - 1;
        const sourceView = createNativeTextureView(filteredTexture, {
          baseMipLevel: filteredSourceMip,
          mipLevelCount: 1,
          dimension: "2d",
          baseArrayLayer: layer,
          arrayLayerCount: 1,
          format: linearFormat
        });
        const destinationView = createNativeTextureView(destinationTexture, {
          baseMipLevel: destinationMip,
          mipLevelCount: 1,
          dimension: "2d",
          baseArrayLayer: layer,
          arrayLayerCount: 1,
          format: linearFormat
        });
        this.encodeFilterPass(
          commandEncoder,
          finalPipeline!,
          sourceView,
          destinationView,
          params,
          destinationMip * this.paramsStride
        );
      }
    }

    if (outputTexture !== source) {
      const copySize = {
        width: Math.max(1, width >>> 1),
        height: Math.max(1, height >>> 1),
        depthOrArrayLayers: layers
      };
      const sourceMipOffset = outputTexture.width === source.width ? 0 : 1;
      for (let mipLevel = 1; mipLevel < mipLevelCount; mipLevel++) {
        commandEncoder.copyTextureToTexture(
          {
            texture: outputTexture,
            mipLevel: mipLevel - sourceMipOffset
          },
          { texture: source, mipLevel },
          copySize
        );
        copySize.width = Math.max(1, copySize.width >>> 1);
        copySize.height = Math.max(1, copySize.height >>> 1);
      }
    }

    if (ownEncoder) {
      submitGpuCommands(this.device, "MipmapGenerator/generate", [
        commandEncoder.finish()
      ]);
    } else {
      params.destroy();
    }
    if (source !== inputTexture) inputTexture.destroy();
    if (source !== outputTexture) outputTexture.destroy();
    if (needsIntermediate) filteredTexture.destroy();
    return source;
  }

  private encodeFilterPass(
    encoder: GPUCommandEncoder,
    pipeline: CachedRenderPipelineDescriptor,
    input: GPUTextureView,
    output: GPUTextureView,
    params: GPUBuffer,
    paramsOffset: number
  ): void {
    const pass = encoder.beginRenderPass({
      label: "",
      colorAttachments: [
        {
          view: output,
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    const group = this.graphics.bind_groups.obtain({
      layout: MIPMAP_BIND_GROUP_LAYOUT,
      entries: [
        this.sampler,
        input,
        { buffer: params, offset: paramsOffset, size: MIPMAP_PARAMS_BYTES }
      ]
    });
    pass.setPipeline(this.graphics.render_pipelines.obtain(pipeline));
    pass.setBindGroup(0, group);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  private writeParams(buffer: GPUBuffer, width: number, height: number): void {
    const bytes = new ArrayBuffer(32 * this.paramsStride);
    const words = new Uint32Array(bytes);
    for (let mipLevel = 0; mipLevel < 32; mipLevel++) {
      const wordOffset = (mipLevel * this.paramsStride) >>> 2;
      const mipWidth = Math.max(width >>> mipLevel, 1);
      const mipHeight = Math.max(height >>> mipLevel, 1);
      words[wordOffset] = mipWidth;
      words[wordOffset + 1] = mipHeight;
      if (mipWidth === 1 && mipHeight === 1) break;
    }
    writeGpuBuffer(
      this.device.queue,
      "MipmapGenerator/parameters",
      buffer,
      0,
      bytes,
      0
    );
  }

  private obtainPipeline(
    format: GPUTextureFormat,
    filter: number
  ): CachedRenderPipelineDescriptor {
    const key = `${format}:${filter}`;
    let pipeline = this.pipelines.get(key);
    if (pipeline !== undefined) return pipeline;
    const fragment = this.obtainShaderModule(filter);
    pipeline = {
      label: "",
      layout: { label: "", bindGroupLayouts: [MIPMAP_BIND_GROUP_LAYOUT] },
      vertex: {
        module: this.obtainVertexModule(),
        entryPoint: "main"
      },
      fragment: {
        module: fragment,
        entryPoint: "main",
        targets: [{ format }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" }
    };
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  private obtainShaderModule(filter: number): CachedShaderModuleDescriptor {
    let module = this.shaderModules.get(filter);
    if (module !== undefined) return module;
    const code = MIPMAP_FILTER_WGSL_BY_ID[filter];
    if (code === undefined) {
      throw new Error(`Unsupported filter: ${filter}(${textureFilterName(filter)})`);
    }
    module = { label: "", code };
    this.shaderModules.set(filter, module);
    return module;
  }

  private obtainVertexModule(): CachedShaderModuleDescriptor {
    return { label: "", code: MIPMAP_FULLSCREEN_VERTEX_WGSL };
  }
}

const MIPMAP_BIND_GROUP_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} }
  ]
};

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function textureFilterName(filter: number): string {
  for (const [name, value] of Object.entries(TextureFilterType)) {
    if (value === filter) return name;
  }
  return String(filter);
}
