import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  LINEAR_CLAMP_SAMPLER_DESCRIPTOR,
  SHADOW_COMPARISON_SAMPLER_DESCRIPTOR
} from "../../gpu/GPUSamplerCache.js";
import { OPAQUE_LIGHTING_WGSL } from "../../shaders/opaque_lighting.js";
import { HDR_COLOR_FORMAT } from "../RenderTargets.js";
import { resolveTextureView } from "./MaterialExpandPass.js";

const SURFACE_GROUP: GPUBindGroupLayoutDescriptor = { entries: [
  { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
  { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
  { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
  { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
  { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
  { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } }
] };
const LIGHT_GROUP: GPUBindGroupLayoutDescriptor = { entries: [
  { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
  { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
  { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
  { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
  { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
  { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
  { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } }
] };
const VIEW_GROUP: GPUBindGroupLayoutDescriptor = { entries: [
  { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
] };
const IBL_GROUP: GPUBindGroupLayoutDescriptor = { entries: [
  { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
  { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
  { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } }
] };
const PIPELINE: CachedRenderPipelineDescriptor = {
  label: "R5 OpaqueLighting/direct+shadow+IBL+emissive+background",
  layout: { bindGroupLayouts: [SURFACE_GROUP, LIGHT_GROUP, VIEW_GROUP, IBL_GROUP] },
  vertex: { module: { code: OPAQUE_LIGHTING_WGSL }, entryPoint: "vs_main" },
  fragment: {
    module: { code: OPAQUE_LIGHTING_WGSL }, entryPoint: "fs_main",
    targets: [{ format: HDR_COLOR_FORMAT }]
  },
  primitive: { topology: "triangle-list", cullMode: "none" }
};

export interface OpaqueLightingInputs {
  readonly gPbr: ResourceId; readonly gNormal: ResourceId;
  readonly gAlbedo: ResourceId; readonly gEmissive: ResourceId;
  readonly gMetadata: ResourceId; readonly bentNormal: ResourceId;
  readonly depth: ResourceId; readonly lightDatabase: ResourceId;
  readonly environment: ResourceId; readonly diffuseIrradiance: ResourceId;
  readonly splitSum: ResourceId; readonly clusterParameters: ResourceId;
  readonly clusterLookup: ResourceId; readonly clusterData: ResourceId;
  readonly activeLightList: ResourceId; readonly shadowAtlas: ResourceId;
  readonly camera: ResourceId; readonly view: ResourceId;
}

export class OpaqueLightingPass {
  lastRan = false;
  constructor(private readonly graphics: GraphicsContext) {}
  addToGraph(graph: FrameGraph, width: number, height: number, inputs: OpaqueLightingInputs): ResourceId {
    let hdr = -1;
    const builder = graph.add("R5 OpaqueLighting", inputs, (data, resources, context) => {
      const encoder = context.gpu_encoder;
      if (!encoder) throw new Error("OpaqueLightingPass: no GPU command encoder");
      const bindings: readonly (readonly GPUBindingResource[])[] = [[
        texture(resources.get(data.depth)), texture(resources.get(data.gPbr)),
        texture(resources.get(data.gNormal)), texture(resources.get(data.gAlbedo)),
        texture(resources.get(data.gEmissive)),
        this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
        texture(resources.get(data.gMetadata))
      ], [
        { buffer: buffer(resources.get(data.lightDatabase)) }, texture(resources.get(data.environment)),
        { buffer: buffer(resources.get(data.clusterParameters)) },
        { buffer: buffer(resources.get(data.clusterLookup)) },
        { buffer: buffer(resources.get(data.clusterData)) }, texture(resources.get(data.shadowAtlas)),
        this.graphics.samplers.obtain(SHADOW_COMPARISON_SAMPLER_DESCRIPTOR),
        { buffer: buffer(resources.get(data.activeLightList)) }
      ], [
        { buffer: buffer(resources.get(data.view)) }, { buffer: buffer(resources.get(data.camera)) }
      ], [
        texture(resources.get(data.diffuseIrradiance)), texture(resources.get(data.splitSum)),
        this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR), texture(resources.get(data.bentNormal))
      ]];
      const pass = encoder.beginRenderPass({ label: "R5 OpaqueLighting", colorAttachments: [{
        view: texture(resources.get(hdr)), clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store"
      }] });
      const pipeline = this.graphics.render_pipelines.obtain(PIPELINE);
      pass.setPipeline(pipeline);
      this.graphics.setPipelineBindings(pass, PIPELINE, bindings);
      pass.draw(3);
      pass.end();
      this.lastRan = true;
    });
    hdr = builder.create("hdr_color / opaque lighting", {
      kind: "transient_texture", label: "hdr_color / opaque lighting",
      width: Math.max(1, width | 0), height: Math.max(1, height | 0),
      format: HDR_COLOR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
    });
    for (const resource of Object.values(inputs)) builder.read(resource);
    return hdr;
  }
  destroy(): void {}
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}
function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) return value as GPUBuffer;
  throw new Error("OpaqueLightingPass: expected GPUBuffer");
}
