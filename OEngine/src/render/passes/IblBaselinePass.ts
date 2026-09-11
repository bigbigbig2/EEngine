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
  IBL_BASELINE_FORMAT,
  IBL_BASELINE_NO_AO_WGSL,
  IBL_BASELINE_WITH_AO_WGSL,
  LPV_BASELINE_NO_AO_WGSL,
  LPV_BASELINE_WITH_AO_WGSL
} from "../../shaders/ibl_baseline.js";
import {
  resolveDepthAttachmentView,
  resolveTextureView
} from "../RenderTargetViews.js";

const SURFACE_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "ADR-0009 IBL baseline/surface",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } }
  ]
};

const IBL_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "ADR-0009 IBL baseline/environment",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
    { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } }
  ]
};

function descriptor(
  ao: boolean,
  baselineSpecular: boolean,
  componentOutputs: boolean,
  diffuseSource: "octahedral" | "screen",
  surfaceProfile: GpuShadingSurfaceLiteProfile
): CachedRenderPipelineDescriptor {
  const label = `ADR-0009 ${diffuseSource} baseline${ao ? "/ao" : ""}${
    baselineSpecular ? "/ssr-output" : ""
  }${componentOutputs ? "/ssgi-components" : ""}`;
  const code = diffuseSource === "screen"
    ? (ao ? LPV_BASELINE_WITH_AO_WGSL : LPV_BASELINE_NO_AO_WGSL)
    : (ao ? IBL_BASELINE_WITH_AO_WGSL : IBL_BASELINE_NO_AO_WGSL);
  return {
    label,
    layout: { label: `${label}/layout`, bindGroupLayouts: [SURFACE_GROUP, IBL_GROUP] },
    vertex: {
      module: { label, code },
      entryPoint: "vs_main"
    },
    fragment: {
      module: { label, code },
      entryPoint: componentOutputs
        ? "fs_main_with_components"
        : baselineSpecular ? "fs_main_with_baseline" : "fs_main",
      constants: gpuShadingSurfaceNormalPipelineConstants(surfaceProfile.normalEncoding),
      targets: [
        {
          format: IBL_BASELINE_FORMAT,
          blend: {
            color: { operation: "add", srcFactor: "one", dstFactor: "one" },
            alpha: { operation: "add", srcFactor: "zero", dstFactor: "one" }
          }
        },
        ...(baselineSpecular || componentOutputs ? [{ format: IBL_BASELINE_FORMAT }] : []),
        ...(componentOutputs ? [{ format: IBL_BASELINE_FORMAT }] : [])
      ]
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: {
      format: "depth32float",
      depthWriteEnabled: false,
      depthCompare: "not-equal"
    }
  };
}

export interface IblBaselineInputs {
  readonly hdr: ResourceId;
  readonly depth: ResourceId;
  readonly normal: ResourceId;
  readonly bentNormal: ResourceId;
  readonly albedoAo: ResourceId;
  readonly material: ResourceId;
  readonly metadata: ResourceId;
  readonly camera: ResourceId;
  readonly splitSum: ResourceId;
  readonly environment: ResourceId;
  readonly diffuseIrradiance: ResourceId;
  readonly fallbackDiffuseIrradiance: ResourceId;
  readonly ambientVisibility?: ResourceId;
}

export interface IblBaselineOutputs {
  readonly hdr: ResourceId;
  readonly baselineSpecular: ResourceId | null;
  readonly resolvedDiffuse: ResourceId | null;
}

/**
 * Fused IBL baseline owner. Diffuse, BRDF energy compensation, specular
 * occlusion and HDR composition happen in one pass. The second MRT exists iff
 * an SSR correction consumer requests the replaceable baseline contribution.
 */
export class IblBaselinePass {
  private readonly descriptors: Readonly<Record<string, CachedRenderPipelineDescriptor>>;
  lastBaselineSpecularMaterialized = false;

  constructor(
    private readonly graphics: GraphicsContext,
    surfaceProfile: GpuShadingSurfaceLiteProfile = GPU_SHADING_SURFACE_LITE_PROFILE
  ) {
    this.descriptors = Object.freeze(Object.fromEntries(
      ["octahedral", "screen"].flatMap((source) =>
        [false, true].flatMap((ao) => [false, true].flatMap((baseline) => [false, true].map((components) => [
          `${source}/${Number(ao)}/${Number(baseline)}/${Number(components)}`,
          descriptor(
            ao,
            baseline,
            components,
            source as "octahedral" | "screen",
            surfaceProfile
          )
        ])))
      )
    ));
  }

  addToGraph(
    graph: FrameGraph,
    extent: Readonly<{ width: number; height: number }>,
    inputs: IblBaselineInputs,
    options: Readonly<{
      baselineSpecular: boolean;
      componentOutputs?: boolean;
      diffuseSource?: "octahedral" | "screen";
    }>
  ): IblBaselineOutputs {
    const ao = inputs.ambientVisibility !== undefined;
    const diffuseSource = options.diffuseSource ?? "octahedral";
    const pipeline = this.descriptors[
      `${diffuseSource}/${Number(ao)}/${Number(options.baselineSpecular)}/${Number(options.componentOutputs === true)}`
    ]!;
    let hdr = -1;
    let baselineSpecular: ResourceId | null = null;
    let resolvedDiffuse: ResourceId | null = null;
    const builder = graph.add(
      options.componentOutputs === true
        ? `${diffuseSource} baseline fused/SSGI component output`
        : options.baselineSpecular
        ? `${diffuseSource} baseline fused/SSR replacement output`
        : `${diffuseSource} baseline fused/no SSR output`,
      inputs,
      (data, resources, context) => {
        const encoder = context.gpu_encoder;
        if (encoder === undefined) throw new Error("IblBaselinePass requires GPU encoder");
        const colorAttachments: GPURenderPassColorAttachment[] = [{
          view: texture(resources.get(hdr)),
          loadOp: "load",
          storeOp: "store"
        }];
        if (baselineSpecular !== null) {
          colorAttachments.push({
            view: texture(resources.get(baselineSpecular)),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store"
          });
        }
        if (resolvedDiffuse !== null) {
          colorAttachments.push({
            view: texture(resources.get(resolvedDiffuse)),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store"
          });
        }
        const pass = encoder.beginRenderPass({
          label: pipeline.label,
          colorAttachments,
          depthStencilAttachment: {
            view: resolveDepthAttachmentView(resources.get(data.depth)),
            depthReadOnly: true
          }
        });
        pass.setPipeline(this.graphics.render_pipelines.obtain(pipeline));
        this.graphics.setPipelineBindings(pass, pipeline, [
          [
            texture(resources.get(data.normal)),
            texture(resources.get(data.bentNormal)),
            texture(resources.get(data.albedoAo)),
            texture(resources.get(data.material)),
            texture(resources.get(data.depth)),
            texture(resources.get(data.metadata))
          ],
          [
            { buffer: buffer(resources.get(data.camera)) },
            this.graphics.samplers.obtain(LINEAR_CLAMP_SAMPLER_DESCRIPTOR),
            texture(resources.get(data.splitSum)),
            texture(resources.get(data.environment)),
            texture(resources.get(data.diffuseIrradiance)),
            texture(resources.get(data.ambientVisibility ?? data.albedoAo)),
            texture(resources.get(data.fallbackDiffuseIrradiance))
          ]
        ]);
        pass.draw(3);
        pass.end();
        this.lastBaselineSpecularMaterialized = baselineSpecular !== null;
      }
    );
    hdr = builder.write(inputs.hdr);
    if (options.baselineSpecular || options.componentOutputs === true) {
      baselineSpecular = builder.create("pre-exposed-baseline-specular", {
        kind: "transient_texture",
        label: options.componentOutputs === true
          ? "ADR-0009 SSGI component baseline specular"
          : "ADR-0009 SSR-only baseline specular",
        width: Math.max(1, extent.width | 0),
        height: Math.max(1, extent.height | 0),
        format: IBL_BASELINE_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      });
    }
    if (options.componentOutputs === true) {
      resolvedDiffuse = builder.create("pre-SSGI resolved long-range diffuse", {
        kind: "transient_texture",
        label: "ADR-0009 SSGI-only resolved long-range diffuse",
        width: Math.max(1, extent.width | 0),
        height: Math.max(1, extent.height | 0),
        format: IBL_BASELINE_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      });
    }
    for (const [name, resource] of Object.entries(inputs)) {
      if (name !== "hdr" && resource !== undefined) builder.read(resource);
    }
    return Object.freeze({ hdr, baselineSpecular, resolvedDiffuse });
  }

  destroy(): void {}
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}

function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error("IblBaselinePass expected GPUBuffer");
}
