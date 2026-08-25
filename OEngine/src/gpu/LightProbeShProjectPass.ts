/**
 * LightProbeShProjectPass：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedComputePipelineDescriptor } from "./GPUDescriptorCaches.js";
import { createNativeTextureView } from "./GPUTextureDescriptors.js";
import {
  PROBE_SH_PROJECT_SETTINGS_BYTES,
  PROBE_SH_PROJECT_WGSL,
  PROBE_SH_PROJECT_WORKGROUP_SIZE,
  probeShProjectBufferBytes
} from "../shaders/probe_sh_project.js";

export type LightProbeShProjectSettings = {
  probe_index_offset: number;
  probe_update_count: number;
  probe_resolution: number;
  probe_count: number;
  probes_per_row: number;
};

export class LightProbeShProjectPass {
  private readonly pipeline: CachedComputePipelineDescriptor;
  private readonly device: GPUDevice;

  constructor(graphics: GraphicsContext) {
    this.device = graphics.device;
    const layouts: GPUBindGroupLayoutDescriptor[] = [
      {
        label: "LightProbeAtlas/qF-group0-layout",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "uniform" }
          }
        ]
      },
      {
        label: "LightProbeAtlas/qF-group1-layout",
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: "storage" }
          },
          {
            binding: 1,
            visibility: GPUShaderStage.COMPUTE,
            texture: { sampleType: "uint", viewDimension: "2d" }
          }
        ]
      }
    ];
    this.pipeline = {
      label: "LightProbeAtlas/qF",
      layout: {
        label: "LightProbeAtlas/qF-pipeline-layout",
        bindGroupLayouts: layouts
      },
      compute: { module: { label: "LightProbeAtlas/qF-module", code: PROBE_SH_PROJECT_WGSL }, entryPoint: "main" }
    };
  }

  createOutput(probeUpdateCount: number, probeResolution: number): GPUBuffer {
    const size = probeShProjectBufferBytes(
      probeUpdateCount,
      probeResolution
    );
    if (size <= 0) {
      throw new RangeError("qF output requires at least one probe update");
    }
    return this.device.createBuffer({
      label: "sh",
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
  }

  encode(
    command: ShadeGPUCommandContext,
    settings: LightProbeShProjectSettings,
    atlasRadiance: GPUTexture,
    output: GPUBuffer,
    outputWidth: number,
    outputHeight: number
  ): void {
    const settingsBuffer = this.createSettingsBuffer(settings);
    command.onFinished.addOne(() => settingsBuffer.destroy());
    const pass = command.constructComputePass({
      label: "LightProbeAtlas/qF",
      pipeline: this.pipeline,
      bindings: [
        [{ buffer: settingsBuffer }],
        [{ buffer: output }, createNativeTextureView(atlasRadiance)]
      ]
    });
    pass.dispatchWorkgroups(
      Math.ceil(outputWidth / PROBE_SH_PROJECT_WORKGROUP_SIZE),
      Math.ceil(outputHeight / PROBE_SH_PROJECT_WORKGROUP_SIZE),
      1
    );
    pass.end();
  }

  private createSettingsBuffer(settings: LightProbeShProjectSettings): GPUBuffer {
    const values = new Uint32Array([
      settings.probe_index_offset,
      settings.probe_update_count,
      settings.probe_resolution,
      settings.probe_count,
      settings.probes_per_row
    ]);
    const buffer = this.device.createBuffer({
      label: "LightProbeAtlas/qF-settings",
      size: PROBE_SH_PROJECT_SETTINGS_BYTES,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true
    });
    new Uint32Array(buffer.getMappedRange()).set(values);
    buffer.unmap();
    return buffer;
  }
}
