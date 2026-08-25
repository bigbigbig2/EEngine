/**
 * LightProbeRadianceAccumulatePass：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";
import type { LightProbeGBufferOutputs } from "./LightProbeGBufferPass.js";
import { createNativeTextureView } from "./GPUTextureDescriptors.js";
import {
  PROBE_RADIANCE_ACCUMULATE_SETTINGS_BYTES,
  PROBE_RADIANCE_ACCUMULATE_WGSL,
  PROBE_RADIANCE_ACCUMULATE_WORKGROUP_SIZE
} from "../shaders/probe_radiance_accumulate.js";

export type LightProbeRadianceAccumulateSettings = {
  probe_index_offset: number;
  probe_update_count: number;
  probe_resolution: number;
  atlas_resolution: readonly [number, number];
  probe_count: number;
  random_seed: number;
};

export type LightProbeRadianceAccumulateBindings = {
  probes: GPUBuffer;
  lights: GPUBuffer;
  indirect: GPUTexture;
  sceneDatabase: GPUBuffer;
  tlas: GPUBuffer;
  blasAddresses: GPUBuffer;
  blasNodes: GPUBuffer;
  geometries: GPUBuffer;
  meshletHeaders: GPUBuffer;
  meshletData: GPUBuffer;
  atlasRadiance: GPUTexture;
};

export class LightProbeRadianceAccumulatePass {
  private readonly pipeline: CachedComputePipelineDescriptor;
  private readonly device: GPUDevice;

  constructor(graphics: GraphicsContext) {
    this.device = graphics.device;
    const layouts: GPUBindGroupLayoutDescriptor[] = [
      {
        label: "LightProbeAtlas/eM-group0-layout",
        entries: [
          bufferEntry(0, "uniform"),
          bufferEntry(1, "read-only-storage"),
          bufferEntry(2, "read-only-storage")
        ]
      },
      {
        label: "LightProbeAtlas/eM-group1-layout",
        entries: [
          textureEntry(0, "float"),
          textureEntry(1, "uint"),
          textureEntry(2, "unfilterable-float"),
          textureEntry(3, "unfilterable-float"),
          textureEntry(4, "unfilterable-float"),
          textureEntry(5, "uint")
        ]
      },
      {
        label: "LightProbeAtlas/eM-group2-layout",
        entries: Array.from({ length: 7 }, (_, binding) =>
          bufferEntry(binding, "read-only-storage")
        )
      },
      {
        label: "LightProbeAtlas/eM-group3-layout",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: {
              access: "read-write",
              format: "r32uint",
              viewDimension: "2d"
            }
          }
        ]
      }
    ];
    this.pipeline = {
      label: "LightProbeAtlas/eM",
      layout: {
        label: "LightProbeAtlas/eM-pipeline-layout",
        bindGroupLayouts: layouts
      },
      compute: {
        module: { label: "LightProbeAtlas/eM-module", code: PROBE_RADIANCE_ACCUMULATE_WGSL },
        entryPoint: "main"
      }
    };
  }

  encode(
    command: ShadeGPUCommandContext,
    settings: LightProbeRadianceAccumulateSettings,
    gbuffer: LightProbeGBufferOutputs,
    bindings: LightProbeRadianceAccumulateBindings
  ): void {
    const settingsBuffer = this.createSettingsBuffer(settings);
    command.onFinished.addOne(() => settingsBuffer.destroy());
    const pass = command.constructComputePass({
      label: "LightProbeAtlas/eM",
      pipeline: this.pipeline,
      bindings: [
        [{ buffer: settingsBuffer }, { buffer: bindings.probes }, { buffer: bindings.lights }],
        [
          createNativeTextureView(gbuffer.albedo),
          createNativeTextureView(gbuffer.emissive),
          createNativeTextureView(gbuffer.normals),
          createNativeTextureView(gbuffer.pbr),
          createNativeTextureView(gbuffer.position),
          createNativeTextureView(bindings.indirect)
        ],
        [
          { buffer: bindings.sceneDatabase },
          { buffer: bindings.tlas },
          { buffer: bindings.blasAddresses },
          { buffer: bindings.blasNodes },
          { buffer: bindings.geometries },
          { buffer: bindings.meshletHeaders },
          { buffer: bindings.meshletData }
        ],
        [createNativeTextureView(bindings.atlasRadiance)]
      ]
    });
    pass.dispatchWorkgroups(
      Math.ceil(gbuffer.width / PROBE_RADIANCE_ACCUMULATE_WORKGROUP_SIZE),
      Math.ceil(gbuffer.height / PROBE_RADIANCE_ACCUMULATE_WORKGROUP_SIZE),
      1
    );
    pass.end();
  }

  private createSettingsBuffer(
    settings: LightProbeRadianceAccumulateSettings
  ): GPUBuffer {
    const values = new Uint32Array([
      settings.probe_index_offset,
      settings.probe_update_count,
      settings.probe_resolution,
      0,
      settings.atlas_resolution[0],
      settings.atlas_resolution[1],
      settings.probe_count,
      settings.random_seed
    ]);
    const buffer = this.device.createBuffer({
      label: "LightProbeAtlas/eM-settings",
      size: PROBE_RADIANCE_ACCUMULATE_SETTINGS_BYTES,
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
