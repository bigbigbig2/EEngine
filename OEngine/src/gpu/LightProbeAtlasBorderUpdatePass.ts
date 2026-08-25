/**
 * LightProbeAtlasBorderUpdatePass：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";
import { createNativeTextureView } from "./GPUTextureDescriptors.js";
import {
  PROBE_ATLAS_BORDER_SETTINGS_BYTES,
  PROBE_ATLAS_BORDER_WORKGROUP_SIZE,
  PROBE_ATLAS_DEPTH_FORMAT,
  PROBE_ATLAS_RADIANCE_FORMAT,
  PROBE_DEPTH_BORDER_EXTRACT_WGSL,
  PROBE_DEPTH_BORDER_STORE_WGSL,
  PROBE_RADIANCE_BORDER_COPY_WGSL,
  probeAtlasBorderBufferWords,
  probeAtlasBorderTexelsPerProbe
} from "../shaders/probe_atlas_border.js";

export type LightProbeAtlasBorderUpdateSettings = {
  probe_resolution: number;
  probe_update_count: number;
  probe_index_offset: number;
  probe_count: number;
  atlas_patches_per_row: number;
};

export type LightProbeAtlasBorderUpdateBindings = {
  depthAtlas: GPUTexture;
  radianceAtlas: GPUTexture;
};

export class LightProbeAtlasBorderUpdatePass {
  private readonly depthExtractPipeline: CachedComputePipelineDescriptor;
  private readonly depthStorePipeline: CachedComputePipelineDescriptor;
  private readonly radianceCopyPipeline: CachedComputePipelineDescriptor;
  private readonly device: GPUDevice;

  constructor(graphics: GraphicsContext) {
    this.device = graphics.device;
    this.depthExtractPipeline = this.createDepthExtractPipeline();
    this.depthStorePipeline = this.createDepthStorePipeline();
    this.radianceCopyPipeline = this.createRadianceCopyPipeline();
  }

  encode(
    command: ShadeGPUCommandContext,
    settings: LightProbeAtlasBorderUpdateSettings,
    bindings: LightProbeAtlasBorderUpdateBindings
  ): void {
    if (settings.probe_update_count <= 0) return;

    const settingsBuffer = this.createSettingsBuffer(settings);
    const borderBuffer = this.createBorderBuffer(settings);
    command.onFinished.addOne(() => {
      settingsBuffer.destroy();
      borderBuffer.destroy();
    });

    const borderTexels =
      settings.probe_update_count *
      probeAtlasBorderTexelsPerProbe(settings.probe_resolution);
    const groupCount = Math.ceil(
      borderTexels / PROBE_ATLAS_BORDER_WORKGROUP_SIZE
    );

    this.encodeDepthExtract(
      command,
      settingsBuffer,
      borderBuffer,
      bindings.depthAtlas,
      groupCount
    );
    this.encodeDepthStore(
      command,
      settingsBuffer,
      borderBuffer,
      bindings.depthAtlas,
      groupCount
    );
    this.encodeRadianceCopy(
      command,
      settingsBuffer,
      bindings.radianceAtlas,
      groupCount
    );
  }

  private createDepthExtractPipeline(): CachedComputePipelineDescriptor {
    const layout: GPUBindGroupLayoutDescriptor = {
      label: "LightProbeAtlas/bF-group0-layout",
      entries: [
        bufferEntry(0, "uniform"),
        textureEntry(1, "unfilterable-float"),
        bufferEntry(2, "storage")
      ]
    };
    return createPipeline("LightProbeAtlas/bF", PROBE_DEPTH_BORDER_EXTRACT_WGSL, layout);
  }

  private createDepthStorePipeline(): CachedComputePipelineDescriptor {
    const layout: GPUBindGroupLayoutDescriptor = {
      label: "LightProbeAtlas/BF-group0-layout",
      entries: [
        bufferEntry(0, "uniform"),
        bufferEntry(1, "read-only-storage"),
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "write-only",
            format: PROBE_ATLAS_DEPTH_FORMAT,
            viewDimension: "2d"
          }
        }
      ]
    };
    return createPipeline("LightProbeAtlas/BF", PROBE_DEPTH_BORDER_STORE_WGSL, layout);
  }

  private createRadianceCopyPipeline(): CachedComputePipelineDescriptor {
    const layout: GPUBindGroupLayoutDescriptor = {
      label: "LightProbeAtlas/zF-group0-layout",
      entries: [
        bufferEntry(0, "uniform"),
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "read-write",
            format: PROBE_ATLAS_RADIANCE_FORMAT,
            viewDimension: "2d"
          }
        }
      ]
    };
    return createPipeline("LightProbeAtlas/zF", PROBE_RADIANCE_BORDER_COPY_WGSL, layout);
  }

  private encodeDepthExtract(
    command: ShadeGPUCommandContext,
    settingsBuffer: GPUBuffer,
    borderBuffer: GPUBuffer,
    depthAtlas: GPUTexture,
    groupCount: number
  ): void {
    dispatch(
      command,
      this.depthExtractPipeline,
      [[
        { buffer: settingsBuffer },
        createNativeTextureView(depthAtlas),
        { buffer: borderBuffer }
      ]],
      groupCount,
      "LightProbeAtlas/bF"
    );
  }

  private encodeDepthStore(
    command: ShadeGPUCommandContext,
    settingsBuffer: GPUBuffer,
    borderBuffer: GPUBuffer,
    depthAtlas: GPUTexture,
    groupCount: number
  ): void {
    dispatch(
      command,
      this.depthStorePipeline,
      [[
        { buffer: settingsBuffer },
        { buffer: borderBuffer },
        createNativeTextureView(depthAtlas)
      ]],
      groupCount,
      "LightProbeAtlas/BF"
    );
  }

  private encodeRadianceCopy(
    command: ShadeGPUCommandContext,
    settingsBuffer: GPUBuffer,
    radianceAtlas: GPUTexture,
    groupCount: number
  ): void {
    dispatch(
      command,
      this.radianceCopyPipeline,
      [[{ buffer: settingsBuffer }, createNativeTextureView(radianceAtlas)]],
      groupCount,
      "LightProbeAtlas/zF"
    );
  }

  private createBorderBuffer(
    settings: LightProbeAtlasBorderUpdateSettings
  ): GPUBuffer {
    const words = probeAtlasBorderBufferWords(
      settings.probe_update_count,
      settings.probe_resolution
    );
    return this.device.createBuffer({
      label: "Border Texels",
      size: words * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE
    });
  }

  private createSettingsBuffer(
    settings: LightProbeAtlasBorderUpdateSettings
  ): GPUBuffer {
    const values = new Uint32Array([
      settings.probe_resolution,
      settings.probe_update_count,
      settings.probe_index_offset,
      settings.probe_count,
      settings.atlas_patches_per_row
    ]);
    const buffer = this.device.createBuffer({
      label: "LightProbeAtlas/border-settings",
      size: PROBE_ATLAS_BORDER_SETTINGS_BYTES,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true
    });
    new Uint32Array(buffer.getMappedRange()).set(values);
    buffer.unmap();
    return buffer;
  }
}

function dispatch(
  command: ShadeGPUCommandContext,
  pipeline: CachedComputePipelineDescriptor,
  bindings: GPUBindingResource[][],
  groupCount: number,
  label: string
): void {
  const pass = command.constructComputePass({ label, pipeline, bindings });
  pass.dispatchWorkgroups(groupCount, 1, 1);
  pass.end();
}

function createPipeline(
  label: string,
  code: string,
  layout: GPUBindGroupLayoutDescriptor
): CachedComputePipelineDescriptor {
  return {
    label,
    layout: { label: `${label}-pipeline-layout`, bindGroupLayouts: [layout] },
    compute: { module: { label: `${label}-module`, code }, entryPoint: "main" }
  };
}

function textureEntry(
  binding: number,
  sampleType: GPUTextureSampleType
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.COMPUTE,
    texture: { sampleType, viewDimension: "2d" }
  };
}

function bufferEntry(
  binding: number,
  type: GPUBufferBindingType
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type }
  };
}
