/**
 * LightProbeGBufferPass：负责 GPU 资源、数据上传或 GPU 驱动渲染基础设施。
 */

import type { ShadeGPUCommandContext } from "../framegraph/ShadeGPUCommandContext.js";
import type { GraphicsContext } from "./GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "./GPUDescriptorCaches.js";
import {
  createNativeTexture,
  createNativeTextureView
} from "./GPUTextureDescriptors.js";
import {
  PROBE_GBUFFER_SETTINGS_BYTES,
  PROBE_GBUFFER_TARGET_FORMATS,
  PROBE_GBUFFER_WGSL
} from "../shaders/probe_gbuffer.js";

export type LightProbeGBufferSettings = {
  probe_index_offset: number;
  probe_update_count: number;
  probe_count: number;
  probe_resolution: number;
  output_resolution_width: number;
  random_seed: number;
};

export type LightProbeGBufferBindings = {
  materials: GPUBuffer;
  materialTextures: GPUTextureView;
  environment: GPUTextureView;
  sceneDatabase: GPUBuffer;
  tlas: GPUBuffer;
  blasAddresses: GPUBuffer;
  blasNodes: GPUBuffer;
  geometries: GPUBuffer;
  meshletHeaders: GPUBuffer;
  meshletData: GPUBuffer;
  probes: GPUBuffer;
};

export type LightProbeGBufferOutputs = {
  albedo: GPUTexture;
  emissive: GPUTexture;
  normals: GPUTexture;
  pbr: GPUTexture;
  position: GPUTexture;
  width: number;
  height: number;
};

export class LightProbeGBufferPass {
  private readonly pipeline: CachedRenderPipelineDescriptor;
  private readonly device: GPUDevice;

  constructor(graphics: GraphicsContext) {
    this.device = graphics.device;
    const module = { label: "LightProbeAtlas/vM-module", code: PROBE_GBUFFER_WGSL };
    this.pipeline = {
      label: "LightProbeAtlas/vM",
      layout: {
        label: "LightProbeAtlas/vM-pipeline-layout",
        bindGroupLayouts: createProbeGBufferLayouts()
      },
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: PROBE_GBUFFER_TARGET_FORMATS.map((format) => ({ format }))
      },
      primitive: { topology: "triangle-list", cullMode: "none" }
    };
  }

  createOutputs(width: number, height: number): LightProbeGBufferOutputs {
    const usage =
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    return {
      albedo: this.createOutput("albedo", width, height, "rgba8unorm", usage),
      emissive: this.createOutput("emissive", width, height, "r32uint", usage),
      normals: this.createOutput("normals", width, height, "rg8unorm", usage),
      pbr: this.createOutput("pbr", width, height, "rgba8unorm", usage),
      position: this.createOutput("position", width, height, "rgba16float", usage),
      width,
      height
    };
  }

  encode(
    command: ShadeGPUCommandContext,
    settings: LightProbeGBufferSettings,
    bindings: LightProbeGBufferBindings,
    outputs: LightProbeGBufferOutputs
  ): void {
    const settingsBuffer = this.createSettingsBuffer(settings);
    command.onFinished.addOne(() => settingsBuffer.destroy());
    const clearValue: GPUColor = [0, 0, 0, 0];
    const pass = command.constructRenderPass({
      label: "LightProbeAtlas/vM",
      pipeline: this.pipeline,
      bindings: [
        [{ buffer: settingsBuffer }],
        [{ buffer: bindings.materials }, bindings.materialTextures, bindings.environment],
        [
          { buffer: bindings.sceneDatabase },
          { buffer: bindings.tlas },
          { buffer: bindings.blasAddresses },
          { buffer: bindings.blasNodes },
          { buffer: bindings.geometries },
          { buffer: bindings.meshletHeaders },
          { buffer: bindings.meshletData }
        ],
        [{ buffer: bindings.probes }]
      ],
      colorAttachments: [
        outputs.albedo,
        outputs.emissive,
        outputs.normals,
        outputs.pbr,
        outputs.position
      ].map((texture) => ({
        view: createNativeTextureView(texture),
        loadOp: "clear" as const,
        storeOp: "store" as const,
        clearValue
      }))
    });
    pass.draw(3);
    pass.end();
  }

  destroyOutputs(outputs: LightProbeGBufferOutputs): void {
    outputs.albedo.destroy();
    outputs.emissive.destroy();
    outputs.normals.destroy();
    outputs.pbr.destroy();
    outputs.position.destroy();
  }

  private createSettingsBuffer(settings: LightProbeGBufferSettings): GPUBuffer {
    const words = new Uint32Array(PROBE_GBUFFER_SETTINGS_BYTES >>> 2);
    words[0] = settings.probe_resolution >>> 0;
    words[1] = settings.output_resolution_width >>> 0;
    words[2] = settings.probe_index_offset >>> 0;
    words[3] = settings.probe_update_count >>> 0;
    words[4] = settings.probe_count >>> 0;
    words[5] = settings.random_seed >>> 0;
    const buffer = this.device.createBuffer({
      label: "LightProbeAtlas/vM-settings",
      size: PROBE_GBUFFER_SETTINGS_BYTES,
      usage: GPUBufferUsage.UNIFORM,
      mappedAtCreation: true
    });
    new Uint32Array(buffer.getMappedRange()).set(words);
    buffer.unmap();
    return buffer;
  }

  private createOutput(
    label: string,
    width: number,
    height: number,
    format: GPUTextureFormat,
    usage: GPUTextureUsageFlags
  ): GPUTexture {
    return createNativeTexture(this.device, {
      label: `LightProbeAtlas/vM-${label}`,
      size: [width, height, 1],
      dimension: "2d",
      format,
      mipLevelCount: 1,
      sampleCount: 1,
      usage
    });
  }
}

function createProbeGBufferLayouts(): GPUBindGroupLayoutDescriptor[] {
  const fragment = GPUShaderStage.FRAGMENT;
  const readOnlyBuffers = (count: number, label: string): GPUBindGroupLayoutDescriptor => ({
    label,
    entries: Array.from({ length: count }, (_, binding) => ({
      binding,
      visibility: fragment,
      buffer: { type: "read-only-storage" as GPUBufferBindingType }
    }))
  });
  return [
    { label: "LightProbeAtlas/vM-group0-layout", entries: [{ binding: 0, visibility: fragment, buffer: { type: "uniform" } }] },
    {
      label: "LightProbeAtlas/vM-group1-layout",
      entries: [
        { binding: 0, visibility: fragment, buffer: { type: "uniform" } },
        { binding: 1, visibility: fragment, texture: { sampleType: "float", viewDimension: "2d-array" } },
        { binding: 2, visibility: fragment, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } }
      ]
    },
    readOnlyBuffers(7, "LightProbeAtlas/vM-group2-layout"),
    readOnlyBuffers(1, "LightProbeAtlas/vM-group3-layout")
  ];
}
