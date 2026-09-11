import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import {
  GPU_SURFACE_ABI_V1_PROFILE,
  type GpuSurfaceAbiProfile
} from "../../gpu/GpuSurfaceAbi.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import { COMPUTE_MATERIAL_SURFACE_BRIDGE_WGSL } from "../../shaders/compute_material_surface_bridge.js";
import {
  surfaceFrame,
  type ComputeMaterialEvaluationFrame,
  type SurfaceFrame
} from "../pipeline/FrameProducts.js";
import { resolveTextureView } from "../RenderTargetViews.js";

const INPUT_GROUP: GPUBindGroupLayoutDescriptor = {
  label: "ADR-0009 ComputeMaterial/Surface V1 bridge input",
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } }
  ]
};

function pipeline(
  profile: GpuSurfaceAbiProfile,
  velocity: boolean
): CachedRenderPipelineDescriptor {
  return {
    label: `ADR-0009 ComputeMaterial/Surface V1 bridge/${velocity ? "velocity" : "static"}`,
    layout: {
      label: "ADR-0009 ComputeMaterial/Surface V1 bridge layout",
      bindGroupLayouts: [INPUT_GROUP]
    },
    vertex: {
      module: { label: "ADR-0009 ComputeMaterial/Surface V1 bridge", code: COMPUTE_MATERIAL_SURFACE_BRIDGE_WGSL },
      entryPoint: "bridge_vertex"
    },
    fragment: {
      module: { label: "ADR-0009 ComputeMaterial/Surface V1 bridge", code: COMPUTE_MATERIAL_SURFACE_BRIDGE_WGSL },
      entryPoint: "bridge_fragment",
      targets: [
        { format: profile.formats.pbr },
        { format: profile.formats.normal },
        { format: profile.formats.albedoAo },
        { format: profile.formats.emissive },
        velocity ? { format: profile.formats.velocity } : null,
        { format: profile.formats.metadata }
      ]
    },
    primitive: { topology: "triangle-list", cullMode: "none" }
  };
}

/** Temporary consumer bridge. It only unpacks values; no material evaluation. */
export class ComputeMaterialSurfaceBridgePass {
  private readonly pipelines: readonly CachedRenderPipelineDescriptor[];

  constructor(
    private readonly graphics: GraphicsContext,
    private readonly profile: GpuSurfaceAbiProfile = GPU_SURFACE_ABI_V1_PROFILE
  ) {
    this.pipelines = Object.freeze([
      pipeline(profile, false),
      pipeline(profile, true)
    ]);
  }

  addToGraph(
    graph: FrameGraph,
    evaluation: ComputeMaterialEvaluationFrame,
    depth: ResourceId,
    options: Readonly<{ velocity: boolean }>
  ): SurfaceFrame {
    let pbr = -1;
    let normal = -1;
    let albedoAo = -1;
    let emissive = -1;
    let velocity: ResourceId | null = null;
    let metadata = -1;
    const width = evaluation.domain.width;
    const height = evaluation.domain.height;
    const builder = graph.add(
      "Compute material/Surface V1 format bridge",
      options,
      (_data, resources, context) => {
        const encoder = context.gpu_encoder;
        if (!encoder) throw new Error("ComputeMaterialSurfaceBridgePass: no encoder");
        const descriptor = this.pipelines[options.velocity ? 1 : 0]!;
        const pass = encoder.beginRenderPass({
          label: descriptor.label,
          colorAttachments: [
            attachment(resources, pbr),
            attachment(resources, normal),
            attachment(resources, albedoAo),
            attachment(resources, emissive),
            velocity === null ? null : attachment(resources, velocity),
            attachment(resources, metadata)
          ]
        });
        pass.setPipeline(this.graphics.render_pipelines.obtain(descriptor));
        pass.setBindGroup(0, this.graphics.bind_groups.obtain({
          layout: INPUT_GROUP,
          entries: [
            texture(resources.get(evaluation.normal)),
            texture(resources.get(evaluation.albedoAo)),
            texture(resources.get(evaluation.emissive)),
            texture(resources.get(evaluation.pbrMetadataVelocity))
          ]
        }));
        pass.draw(3);
        pass.end();
      }
    );
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    pbr = builder.create("surface/PBR bridge", descriptor(
      width, height, this.profile.formats.pbr, usage
    ));
    normal = builder.create("surface/normal bridge", descriptor(
      width, height, this.profile.formats.normal, usage
    ));
    albedoAo = builder.create("surface/albedo+AO bridge", descriptor(
      width, height, this.profile.formats.albedoAo, usage
    ));
    emissive = builder.create("surface/emissive bridge", descriptor(
      width, height, this.profile.formats.emissive, usage
    ));
    if (options.velocity) {
      velocity = builder.create("surface/velocity bridge", descriptor(
        width, height, this.profile.formats.velocity, usage
      ));
    }
    metadata = builder.create("surface/metadata bridge", descriptor(
      width, height, this.profile.formats.metadata, usage
    ));
    builder.read(evaluation.normal);
    builder.read(evaluation.albedoAo);
    builder.read(evaluation.emissive);
    builder.read(evaluation.pbrMetadataVelocity);
    builder.read(depth);
    return surfaceFrame({
      abiVersion: this.profile.version,
      depth,
      pbr,
      normal,
      albedoAo,
      emissive,
      velocity,
      metadata,
      domain: evaluation.domain
    }, this.profile.version);
  }

  destroy(): void {}
}

function attachment(
  resources: { get(id: ResourceId): unknown },
  id: ResourceId
): GPURenderPassColorAttachment {
  return {
    view: texture(resources.get(id)),
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
    loadOp: "clear",
    storeOp: "store"
  };
}

function descriptor(
  width: number,
  height: number,
  format: GPUTextureFormat,
  usage: GPUTextureUsageFlags
) {
  return { kind: "transient_texture" as const, label: format, width, height, format, usage };
}

function texture(value: unknown): GPUTextureView {
  return resolveTextureView(value as GPUTexture | GPUTextureView);
}
