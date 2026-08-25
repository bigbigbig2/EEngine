/**
 * LightProbeDepthUpdatePass：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedComputePipelineDescriptor, CachedRenderPipelineDescriptor } from "./GPUDescriptorCaches.js";
import type { LightProbeGBufferOutputs } from "./LightProbeGBufferPass.js";
import {
  createNativeTexture,
  createNativeTextureView
} from "./GPUTextureDescriptors.js";
import {
  PROBE_DEPTH_ATLAS_COPY_WGSL,
  PROBE_DEPTH_COPY_WORKGROUP_SIZE,
  PROBE_DEPTH_MOMENTS_WGSL,
  PROBE_DEPTH_SETTINGS_BYTES,
  PROBE_DEPTH_TARGET_FORMAT
} from "../shaders/probe_depth_moments.js";

export type LightProbeDepthUpdateSettings = {
  probe_resolution: number;
  probe_update_count: number;
  probe_index_offset: number;
  probe_count: number;
  atlas_patches_per_row: number;
};

export type LightProbeDepthUpdateBindings = {
  probes: GPUBuffer;
  depthAtlas: GPUTexture;
};

export class LightProbeDepthUpdatePass {
  private readonly momentsPipeline: CachedRenderPipelineDescriptor;
  private readonly copyPipeline: CachedComputePipelineDescriptor;
  private readonly device: GPUDevice;

  constructor(graphics: GraphicsContext) {
    this.device = graphics.device;
    this.momentsPipeline = this.createMomentsPipeline();
    this.copyPipeline = this.createCopyPipeline();
  }

  encode(
    command: ShadeGPUCommandContext,
    settings: LightProbeDepthUpdateSettings,
    gbuffer: LightProbeGBufferOutputs,
    bindings: LightProbeDepthUpdateBindings
  ): void {
    const settingsBuffer = this.createSettingsBuffer(settings);
    const transient = this.createTransient(gbuffer.width, gbuffer.height);
    command.onFinished.addOne(() => {
      settingsBuffer.destroy();
      transient.destroy();
    });

    this.encodeMoments(
      command,
      settingsBuffer,
      gbuffer,
      bindings,
      transient
    );
    this.encodeAtlasCopy(
      command,
      settingsBuffer,
      bindings.depthAtlas,
      transient,
      gbuffer.width,
      gbuffer.height
    );
  }

  private createMomentsPipeline(): CachedRenderPipelineDescriptor {
    const module = { label: "LightProbeAtlas/dM-module", code: PROBE_DEPTH_MOMENTS_WGSL };
    const layout: GPUBindGroupLayoutDescriptor = {
      label: "LightProbeAtlas/dM-group0-layout",
      entries: [
        bufferEntry(0, "uniform", GPUShaderStage.FRAGMENT),
        textureEntry(1, "unfilterable-float", GPUShaderStage.FRAGMENT),
        textureEntry(2, "unfilterable-float", GPUShaderStage.FRAGMENT),
        textureEntry(3, "unfilterable-float", GPUShaderStage.FRAGMENT),
        bufferEntry(4, "read-only-storage", GPUShaderStage.FRAGMENT)
      ]
    };
    return {
      label: "LightProbeAtlas/dM",
      layout: {
        label: "LightProbeAtlas/dM-pipeline-layout",
        bindGroupLayouts: [layout]
      },
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format: PROBE_DEPTH_TARGET_FORMAT }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" }
    };
  }

  private createCopyPipeline(): CachedComputePipelineDescriptor {
    const layout: GPUBindGroupLayoutDescriptor = {
      label: "LightProbeAtlas/fM-group0-layout",
      entries: [
        bufferEntry(0, "uniform", GPUShaderStage.COMPUTE),
        textureEntry(1, "unfilterable-float", GPUShaderStage.COMPUTE),
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "write-only",
            format: PROBE_DEPTH_TARGET_FORMAT,
            viewDimension: "2d"
          }
        }
      ]
    };
    return {
      label: "LightProbeAtlas/fM",
      layout: {
        label: "LightProbeAtlas/fM-pipeline-layout",
        bindGroupLayouts: [layout]
      },
      compute: {
        module: { label: "LightProbeAtlas/fM-module", code: PROBE_DEPTH_ATLAS_COPY_WGSL },
        entryPoint: "main"
      }
    };
  }

  private encodeMoments(
    command: ShadeGPUCommandContext,
    settingsBuffer: GPUBuffer,
    gbuffer: LightProbeGBufferOutputs,
    bindings: LightProbeDepthUpdateBindings,
    transient: GPUTexture
  ): void {
    const pass = command.constructRenderPass({
      label: "LightProbeAtlas/dM",
      pipeline: this.momentsPipeline,
      bindings: [[
        { buffer: settingsBuffer },
        createNativeTextureView(gbuffer.position),
        createNativeTextureView(gbuffer.pbr),
        createNativeTextureView(bindings.depthAtlas),
        { buffer: bindings.probes }
      ]],
      colorAttachments: [
        {
          view: createNativeTextureView(transient),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 0]
        }
      ]
    });
    pass.draw(3);
    pass.end();
  }

  private encodeAtlasCopy(
    command: ShadeGPUCommandContext,
    settingsBuffer: GPUBuffer,
    depthAtlas: GPUTexture,
    transient: GPUTexture,
    width: number,
    height: number
  ): void {
    const pass = command.constructComputePass({
      label: "LightProbeAtlas/fM",
      pipeline: this.copyPipeline,
      bindings: [[
        { buffer: settingsBuffer },
        createNativeTextureView(transient),
        createNativeTextureView(depthAtlas)
      ]]
    });
    pass.dispatchWorkgroups(
      Math.ceil(width / PROBE_DEPTH_COPY_WORKGROUP_SIZE),
      Math.ceil(height / PROBE_DEPTH_COPY_WORKGROUP_SIZE),
      1
    );
    pass.end();
  }

  private createTransient(width: number, height: number): GPUTexture {
    return createNativeTexture(this.device, {
      label: "LightProbeAtlas/dM-depth-moments",
      size: [width, height, 1],
      dimension: "2d",
      format: PROBE_DEPTH_TARGET_FORMAT,
      mipLevelCount: 1,
      sampleCount: 1,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
  }

  private createSettingsBuffer(settings: LightProbeDepthUpdateSettings): GPUBuffer {
    const values = new Uint32Array([
      settings.probe_resolution,
      settings.probe_update_count,
      settings.probe_index_offset,
      settings.probe_count,
      settings.atlas_patches_per_row
    ]);
    const buffer = this.device.createBuffer({
      label: "LightProbeAtlas/dM-fM-settings",
      size: PROBE_DEPTH_SETTINGS_BYTES,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true
    });
    new Uint32Array(buffer.getMappedRange()).set(values);
    buffer.unmap();
    return buffer;
  }
}

function textureEntry(
  binding: number,
  sampleType: GPUTextureSampleType,
  visibility: GPUShaderStageFlags
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility,
    texture: { sampleType, viewDimension: "2d" }
  };
}

function bufferEntry(
  binding: number,
  type: GPUBufferBindingType,
  visibility: GPUShaderStageFlags
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility,
    buffer: { type }
  };
}
