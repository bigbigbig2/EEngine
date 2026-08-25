/**
 * LightProbeIndirectPass：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "./GPUDescriptorCaches.js";
import type { LightProbeGBufferOutputs } from "./LightProbeGBufferPass.js";
import {
  createNativeTexture,
  createNativeTextureView
} from "./GPUTextureDescriptors.js";
import {
  PROBE_INDIRECT_SETTINGS_BYTES,
  PROBE_INDIRECT_TARGET_FORMAT,
  PROBE_INDIRECT_WGSL
} from "../shaders/probe_indirect.js";

export type LightProbeIndirectSettings = {
  probe_resolution: number;
  output_resolution_width: number;
  probe_index_offset: number;
  probe_update_count: number;
  probe_count: number;
};

export type LightProbeIndirectBindings = {
  splitSumSampler: GPUSampler;
  splitSum: GPUTextureView;
  atlasRadiance: GPUTextureView;
  atlasDepth: GPUTextureView;
  meshBvh: GPUBuffer;
  metadata: GPUBuffer;
  tetrahedra: GPUBuffer;
  probes: GPUBuffer;
};

export class LightProbeIndirectPass {
  private readonly pipeline: CachedRenderPipelineDescriptor;
  private readonly device: GPUDevice;

  constructor(graphics: GraphicsContext) {
    this.device = graphics.device;
    const module = { label: "LightProbeAtlas/aM-module", code: PROBE_INDIRECT_WGSL };
    const layouts: GPUBindGroupLayoutDescriptor[] = [
      {
        label: "LightProbeAtlas/aM-group0-layout",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" }
          },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: { type: "filtering" }
          },
          {
            binding: 2,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: "float", viewDimension: "2d" }
          }
        ]
      },
      {
        label: "LightProbeAtlas/aM-group1-layout",
        entries: [
          textureEntry(0, "float"),
          textureEntry(1, "unfilterable-float"),
          textureEntry(2, "float"),
          textureEntry(3, "float"),
          textureEntry(4, "uint"),
          textureEntry(5, "float")
        ]
      },
      {
        label: "LightProbeAtlas/aM-group2-layout",
        entries: [
          bufferEntry(0, "read-only-storage"),
          bufferEntry(1, "uniform"),
          bufferEntry(2, "read-only-storage"),
          bufferEntry(3, "read-only-storage")
        ]
      }
    ];
    this.pipeline = {
      label: "LightProbeAtlas/aM",
      layout: {
        label: "LightProbeAtlas/aM-pipeline-layout",
        bindGroupLayouts: layouts
      },
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format: PROBE_INDIRECT_TARGET_FORMAT }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" }
    };
  }

  createOutput(width: number, height: number): GPUTexture {
    return createNativeTexture(this.device, {
      label: "LightProbeAtlas/aM-indirect",
      size: [width, height, 1],
      dimension: "2d",
      format: PROBE_INDIRECT_TARGET_FORMAT,
      mipLevelCount: 1,
      sampleCount: 1,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
  }

  encode(
    command: ShadeGPUCommandContext,
    settings: LightProbeIndirectSettings,
    gbuffer: LightProbeGBufferOutputs,
    bindings: LightProbeIndirectBindings,
    output: GPUTexture
  ): void {
    const settingsBuffer = this.createSettingsBuffer(settings);
    command.onFinished.addOne(() => settingsBuffer.destroy());
    const pass = command.constructRenderPass({
      label: "LightProbeAtlas/aM",
      pipeline: this.pipeline,
      bindings: [
        [{ buffer: settingsBuffer }, bindings.splitSumSampler, bindings.splitSum],
        [
          createNativeTextureView(gbuffer.position),
          createNativeTextureView(gbuffer.normals),
          createNativeTextureView(gbuffer.albedo),
          createNativeTextureView(gbuffer.pbr),
          bindings.atlasRadiance,
          bindings.atlasDepth
        ],
        [
          { buffer: bindings.meshBvh },
          { buffer: bindings.metadata },
          { buffer: bindings.tetrahedra },
          { buffer: bindings.probes }
        ]
      ],
      colorAttachments: [
        {
          view: createNativeTextureView(output),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 0]
        }
      ]
    });
    pass.draw(3);
    pass.end();
  }

  private createSettingsBuffer(settings: LightProbeIndirectSettings): GPUBuffer {
    const values = new Uint32Array([
      settings.probe_resolution,
      settings.output_resolution_width,
      settings.probe_index_offset,
      settings.probe_update_count,
      settings.probe_count
    ]);
    const buffer = this.device.createBuffer({
      label: "LightProbeAtlas/aM-settings",
      size: PROBE_INDIRECT_SETTINGS_BYTES,
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
  sampleType: GPUTextureSampleType
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    texture: { sampleType, viewDimension: "2d" }
  };
}

function bufferEntry(
  binding: number,
  type: GPUBufferBindingType
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    buffer: { type }
  };
}
