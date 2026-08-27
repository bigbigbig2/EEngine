import { GpuCounterAtomicAdder } from "../../debug/GpuCounterAtomicAdder.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import {
  MATERIAL_EXPAND_GROUP0,
  MATERIAL_EXPAND_GROUP1,
  type GPUMaterialContext
} from "../../gpu/GPUMaterialContext.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import type { PackedSceneRuntime } from "../../gpu/GpuPackedSceneRegistry.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import type { CachedRenderPipelineDescriptor } from "../../gpu/GPUDescriptorCaches.js";
import { ShadeTransparencyMode } from "../../material/enums.js";
import { PACKED_MATERIAL_EXPAND_WGSL } from "../../shaders/packed_material_expand.js";
import {
  GBUF_ALBEDO_FORMAT,
  GBUF_EMISSIVE_FORMAT,
  GBUF_NORMAL_FORMAT,
  GBUF_PBR_FORMAT
} from "../RenderTargets.js";
import { resolveTextureView } from "./MaterialExpandPass.js";

const PACKED_GROUP2: GPUBindGroupLayoutDescriptor = {
  label: "Packed Material Expand/geometry group2",
  entries: Array.from({ length: 7 }, (_, binding) => ({
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    buffer: { type: "read-only-storage" as GPUBufferBindingType }
  }))
};

const PACKED_PIPELINE: CachedRenderPipelineDescriptor = {
  label: "Packed Material Expand",
  layout: {
    label: "Packed Material Expand/layout",
    bindGroupLayouts: [MATERIAL_EXPAND_GROUP0, MATERIAL_EXPAND_GROUP1, PACKED_GROUP2]
  },
  vertex: {
    module: { label: "Packed Material Expand", code: PACKED_MATERIAL_EXPAND_WGSL },
    entryPoint: "packed_material_vs"
  },
  fragment: {
    module: { label: "Packed Material Expand", code: PACKED_MATERIAL_EXPAND_WGSL },
    entryPoint: "packed_material_fs",
    targets: [
      { format: GBUF_PBR_FORMAT },
      { format: GBUF_NORMAL_FORMAT },
      { format: GBUF_ALBEDO_FORMAT },
      { format: GBUF_EMISSIVE_FORMAT }
    ]
  },
  primitive: { topology: "triangle-list", cullMode: "none" }
};

export interface PackedMaterialExpandJob {
  readonly runtime: PackedSceneRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly width: number;
  readonly height: number;
}

export interface PackedMaterialExpandInputs {
  readonly triangleId: ResourceId;
  readonly instanceId: ResourceId;
  readonly view: ResourceId;
  readonly camera: ResourceId;
  readonly counters?: ResourceId;
}

export interface PackedMaterialExpandOutputs {
  readonly gPbr: ResourceId;
  readonly gNormal: ResourceId;
  readonly gAlbedo: ResourceId;
  readonly gEmissive: ResourceId;
  readonly counters: ResourceId | null;
}

/** Existing Standard PBR material loop with Packed Instance/Geometry decoding. */
export class PackedMaterialExpandPass {
  private readonly counterAdder = new GpuCounterAtomicAdder();
  lastDrawCount = 0;

  constructor(private readonly graphics: GraphicsContext) {}

  addToGraph(
    graph: FrameGraph,
    job: PackedMaterialExpandJob,
    inputs: PackedMaterialExpandInputs
  ): PackedMaterialExpandOutputs {
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    const output = {
      gPbr: -1,
      gNormal: -1,
      gAlbedo: -1,
      gEmissive: -1,
      counters: null as ResourceId | null
    };
    const builder = graph.add(
      "Packed Material Expand",
      job,
      (data, resources, context) => {
        const command = requireCommand(context.encoder);
        const pipeline = this.graphics.render_pipelines.obtain(PACKED_PIPELINE);
        const group1 = this.graphics.bind_groups.obtain({
          layout: MATERIAL_EXPAND_GROUP1,
          entries: [
            resolveTextureView(resources.get(inputs.triangleId)),
            resolveTextureView(resources.get(inputs.instanceId)),
            { buffer: requireBuffer(resources.get(inputs.view), "view") },
            { buffer: requireBuffer(resources.get(inputs.camera), "camera") }
          ]
        });
        const group2 = this.graphics.bind_groups.obtain({
          layout: PACKED_GROUP2,
          entries: [
            { buffer: data.scene.instances },
            { buffer: data.assets.geometryRecords },
            { buffer: data.assets.meshletRecords },
            { buffer: data.assets.meshletVertexIndices },
            { buffer: data.assets.meshletTriangleIndices },
            { buffer: data.assets.vertexStreamDescriptors },
            { buffer: data.assets.vertexStreamData }
          ]
        });
        const pass = command.beginRenderPass({
          label: "Packed Material Expand/gbuffer",
          colorAttachments: [
            colorAttachment(resolveTextureView(resources.get(output.gPbr))),
            colorAttachment(resolveTextureView(resources.get(output.gNormal))),
            colorAttachment(resolveTextureView(resources.get(output.gAlbedo))),
            colorAttachment(resolveTextureView(resources.get(output.gEmissive)))
          ]
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(1, group1);
        pass.setBindGroup(2, group2);
        const materials = this.collectMaterials(data.runtime);
        for (const material of materials) {
          pass.setBindGroup(0, material.obtainMaterialExpandBindGroup(pipeline));
          pass.draw(3, 1, 0, 0);
        }
        pass.end();
        this.lastDrawCount = materials.length;
        if (inputs.counters !== undefined) {
          this.counterAdder.encode(
            command,
            requireBuffer(resources.get(inputs.counters), "GPU counters"),
            "activeMaterials",
            materials.length
          );
        }
      }
    );
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    output.gPbr = builder.create("packed g-buffer / PBR", texture(width, height, GBUF_PBR_FORMAT, usage));
    output.gNormal = builder.create("packed g-buffer / Normal", texture(width, height, GBUF_NORMAL_FORMAT, usage));
    output.gAlbedo = builder.create("packed g-buffer / Albedo", texture(width, height, GBUF_ALBEDO_FORMAT, usage));
    output.gEmissive = builder.create("packed g-buffer / Emissive", texture(width, height, GBUF_EMISSIVE_FORMAT, usage));
    builder.read(inputs.triangleId);
    builder.read(inputs.instanceId);
    builder.read(inputs.view);
    builder.read(inputs.camera);
    if (inputs.counters !== undefined) {
      builder.read(inputs.counters);
      output.counters = builder.write(inputs.counters);
    }
    builder.make_side_effect();
    return output;
  }

  private collectMaterials(runtime: PackedSceneRuntime): GPUMaterialContext[] {
    const result: GPUMaterialContext[] = [];
    for (const source of runtime.materials) {
      if (source.transparency_mode === ShadeTransparencyMode.Transparent) continue;
      const context = this.graphics.materials.contexts.get(source);
      if (context !== undefined && context.is_built) result.push(context);
    }
    return result;
  }
}

function colorAttachment(view: GPUTextureView): GPURenderPassColorAttachment {
  return { view, loadOp: "clear", storeOp: "store" };
}

function texture(
  width: number,
  height: number,
  format: GPUTextureFormat,
  usage: GPUTextureUsageFlags
) {
  return { kind: "transient_texture" as const, label: format, width, height, format, usage };
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("PackedMaterialExpandPass requires ShadeGPUCommandContext");
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error(`PackedMaterialExpandPass expected ${label} GPUBuffer`);
}
