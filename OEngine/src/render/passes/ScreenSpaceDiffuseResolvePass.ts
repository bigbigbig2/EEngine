import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  GPU_SHADING_SURFACE_LITE_PROFILE,
  type GpuShadingSurfaceLiteProfile,
  gpuShadingSurfaceNormalPipelineConstants
} from "../../gpu/GpuComputeMaterialAbi.js";
import { LINEAR_CLAMP_SAMPLER_DESCRIPTOR } from "../../gpu/GPUSamplerCache.js";
import {
  SCREEN_SPACE_DIFFUSE_RESOLVE_FORMAT,
  SCREEN_SPACE_DIFFUSE_RESOLVE_WGSL
} from "../../shaders/screen_space_diffuse_resolve.js";
import { resolveDepthAttachmentView, resolveTextureView } from "../RenderTargetViews.js";

export interface ScreenSpaceDiffuseResolveInputs {
  readonly hdr: ResourceId;
  readonly depth: ResourceId;
  readonly normal: ResourceId;
  readonly bentNormal: ResourceId;
  readonly albedoAo: ResourceId;
  readonly material: ResourceId;
  readonly metadata: ResourceId;
  readonly camera: ResourceId;
  readonly splitSum: ResourceId;
  readonly longRangeDiffuse: ResourceId;
  readonly baselineSpecular: ResourceId;
  readonly screenVisibility: ResourceId;
  readonly incidentGi: ResourceId;
  readonly reflectionCorrectionExpected: boolean;
}

export class ScreenSpaceDiffuseResolvePass {
  private readonly descriptors: Readonly<{ final: CachedRenderPipelineDescriptor; preSsr: CachedRenderPipelineDescriptor }>;
  lastRan = false;

  constructor(
    private readonly graphics: GraphicsContext,
    profile: GpuShadingSurfaceLiteProfile = GPU_SHADING_SURFACE_LITE_PROFILE
  ) {
    const label = "ADR-0009 screen-space diffuse energy resolve";
    const create = (entryPoint: "fs_main" | "fs_main_ssr"): CachedRenderPipelineDescriptor => ({
      label,
      layout: { label: `${label}/layout`, bindGroupLayouts: [surfaceLayout(), lightingLayout()] },
      vertex: { module: { label, code: SCREEN_SPACE_DIFFUSE_RESOLVE_WGSL }, entryPoint: "vs_main" },
      fragment: {
        module: { label, code: SCREEN_SPACE_DIFFUSE_RESOLVE_WGSL }, entryPoint,
        constants: gpuShadingSurfaceNormalPipelineConstants(profile.normalEncoding),
        targets: [{
          format: SCREEN_SPACE_DIFFUSE_RESOLVE_FORMAT,
          blend: {
            color: { operation: "add", srcFactor: "one", dstFactor: "one" },
            alpha: { operation: "add", srcFactor: "zero", dstFactor: "one" }
          }
        }]
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth32float", depthWriteEnabled: false, depthCompare: "not-equal" }
    });
    this.descriptors = { final: create("fs_main"), preSsr: create("fs_main_ssr") };
  }

  addToGraph(graph: FrameGraph, inputs: ScreenSpaceDiffuseResolveInputs): ResourceId {
    let hdr = -1;
    const builder = graph.add("ScreenSpaceDiffuseResolve", inputs, (data, resources, context) => {
      const descriptor = data.reflectionCorrectionExpected
        ? this.descriptors.preSsr
        : this.descriptors.final;
      const encoder = context.gpu_encoder;
      if (encoder === undefined) throw new Error("ScreenSpaceDiffuseResolve requires a GPU encoder");
      const pass = encoder.beginRenderPass({
        label: descriptor.label,
        colorAttachments: [{ view: texture(resources.get(hdr)), loadOp: "load", storeOp: "store" }],
        depthStencilAttachment: { view: resolveDepthAttachmentView(resources.get(data.depth)), depthReadOnly: true }
      });
      pass.setPipeline(this.graphics.render_pipelines.obtain(descriptor));
      this.graphics.setPipelineBindings(pass, descriptor, [[
        texture(resources.get(data.normal)), texture(resources.get(data.bentNormal)),
        texture(resources.get(data.albedoAo)), texture(resources.get(data.material)),
        texture(resources.get(data.depth)), texture(resources.get(data.metadata))
      ], [
        { buffer: buffer(resources.get(data.camera)) },
        this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
        texture(resources.get(data.splitSum)), texture(resources.get(data.longRangeDiffuse)),
        texture(resources.get(data.baselineSpecular)), texture(resources.get(data.screenVisibility)),
        texture(resources.get(data.incidentGi))
      ]]);
      pass.draw(3); pass.end(); this.lastRan = true;
    });
    hdr = builder.write(inputs.hdr);
    for (const [name, resource] of Object.entries(inputs)) {
      if (name !== "hdr" && typeof resource === "number") builder.read(resource);
    }
    return hdr;
  }

  destroy(): void {}
}

function surfaceLayout(): GPUBindGroupLayoutDescriptor {
  const visibility = GPUShaderStage.FRAGMENT;
  return { label: "ScreenSpaceDiffuseResolve/surface", entries: [
    { binding: 0, visibility, texture: { sampleType: "uint" } },
    { binding: 1, visibility, texture: { sampleType: "uint" } },
    { binding: 2, visibility, texture: { sampleType: "float" } },
    { binding: 3, visibility, texture: { sampleType: "uint" } },
    { binding: 4, visibility, texture: { sampleType: "depth" } },
    { binding: 5, visibility, texture: { sampleType: "uint" } }
  ] };
}
function lightingLayout(): GPUBindGroupLayoutDescriptor {
  const visibility = GPUShaderStage.FRAGMENT;
  return { label: "ScreenSpaceDiffuseResolve/lighting", entries: [
    { binding: 0, visibility, buffer: { type: "uniform" } },
    { binding: 1, visibility, sampler: { type: "filtering" } },
    { binding: 2, visibility, texture: { sampleType: "float" } },
    { binding: 3, visibility, texture: { sampleType: "float" } },
    { binding: 4, visibility, texture: { sampleType: "float" } },
    { binding: 5, visibility, texture: { sampleType: "unfilterable-float" } },
    { binding: 6, visibility, texture: { sampleType: "float" } }
  ] };
}
function texture(value: unknown): GPUTextureView { return resolveTextureView(value as GPUTexture | GPUTextureView); }
function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) return value as GPUBuffer;
  throw new Error("ScreenSpaceDiffuseResolve expected GPUBuffer");
}
