import { GpuCounterAtomicAdder } from "../../debug/GpuCounterAtomicAdder.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL,
  GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL_WITHOUT_VELOCITY
} from "../../gpu/GpuComputeMaterialAbi.js";
import {
  type ComputeMaterialEvaluationFrame,
  type MaterialTileClassificationFrame,
  shadingSurfaceLiteFrame,
  type ShadingSurfaceLiteFrame,
  type VisibilityFrame
} from "../pipeline/FrameProducts.js";
import type { VelocityCameraMatrices } from "../VelocityMatrices.js";
import { ComputeMaterialResolvePass } from "./ComputeMaterialResolvePass.js";
import { MaterialTileClassificationPass } from "./MaterialTileClassificationPass.js";

export interface PackedMaterialResolveJob {
  readonly runtime: GpuRenderWorldRuntime;
  readonly assets: GpuAssetBindings;
  readonly scene: GpuSceneBindings;
  readonly width: number;
  readonly height: number;
  readonly currentCamera: VelocityCameraMatrices;
  readonly previousCamera: VelocityCameraMatrices;
}

export interface PackedMaterialResolveOutputs {
  readonly velocity: ResourceId | null;
  readonly evaluation: ComputeMaterialEvaluationFrame;
  readonly shading: ShadingSurfaceLiteFrame;
  readonly tileClassification: MaterialTileClassificationFrame;
  readonly counters: ResourceId | null;
}

/**
 * Visibility-driven material owner.
 *
 * The historical class-depth/fullscreen material shaders are no longer
 * executed. ComputeMaterialResolvePass evaluates the material exactly once
 * and publishes the compact SurfaceLite working set directly; no conversion
 * pass or duplicate legacy attachment set exists.
 */
export class PackedMaterialResolvePass {
  private readonly counterAdder = new GpuCounterAtomicAdder();
  private readonly classifier: MaterialTileClassificationPass;
  private readonly compute: ComputeMaterialResolvePass;
  lastActiveMaterialCount = 0;
  private currentSurfaceBytesPerPixel = 0;

  constructor(private readonly graphics: GraphicsContext) {
    this.classifier = new MaterialTileClassificationPass(graphics);
    this.compute = new ComputeMaterialResolvePass(graphics);
  }

  get surfaceBytesPerPixel(): number {
    return this.currentSurfaceBytesPerPixel;
  }

  addToGraph(
    graph: FrameGraph,
    job: PackedMaterialResolveJob,
    inputs: Readonly<{
      visibility: VisibilityFrame;
      view: ResourceId;
      counters?: ResourceId;
    }>,
    options: Readonly<{ velocity: boolean }> = { velocity: true }
  ): PackedMaterialResolveOutputs {
    const width = Math.max(1, job.width | 0);
    const height = Math.max(1, job.height | 0);
    const classified = this.classifier.addToGraph(
      graph,
      {
        width,
        height,
        materials: job.runtime.materialResources.materialRecords
      },
      { visibility: inputs.visibility, counters: inputs.counters }
    );
    const compute = this.compute.addToGraph(
      graph,
      job,
      {
        visibility: inputs.visibility,
        classification: classified,
        view: inputs.view
      },
      options
    );
    let counters: ResourceId | null = inputs.counters ?? null;
    if (inputs.counters !== undefined) {
      const inputCounters = inputs.counters;
      let outputCounters = -1;
      const builder = graph.add(
        "Compute material/publish ownership counters",
        Object.freeze({ activeMaterials: job.runtime.opaqueMaterialCount }),
        (data, resources, context) => {
          const command = requireCommand(context.encoder);
          const target = requireBuffer(resources.get(outputCounters), "GPU counters");
          this.counterAdder.encode(command, target, "activeMaterials", data.activeMaterials);
          this.lastActiveMaterialCount = data.activeMaterials;
        }
      );
      builder.read(inputCounters);
      outputCounters = builder.write(inputCounters);
      counters = outputCounters;
    } else {
      this.lastActiveMaterialCount = job.runtime.opaqueMaterialCount;
    }

    this.currentSurfaceBytesPerPixel = options.velocity
      ? GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL
      : GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL_WITHOUT_VELOCITY;

    return Object.freeze({
      velocity: compute.evaluation.velocity,
      evaluation: compute.evaluation,
      shading: shadingSurfaceLiteFrame({
        normal: compute.evaluation.normal,
        roughnessFlags: compute.evaluation.material,
        metallicSpecular: compute.evaluation.material,
        normalSpace: "world",
        domain: compute.evaluation.domain
      }),
      tileClassification: materialTileWithCounters(
        compute.classification,
        counters
      ),
      counters
    });
  }

  destroy(): void {
    this.compute.destroy();
    this.classifier.destroy();
  }
}

function materialTileWithCounters(
  frame: MaterialTileClassificationFrame,
  counters: ResourceId | null
): MaterialTileClassificationFrame {
  return Object.freeze({ ...frame, counters });
}

function requireCommand(value: unknown): ShadeGPUCommandContext {
  if (value && typeof value === "object" && "isGPUCommandContext" in value) {
    return value as ShadeGPUCommandContext;
  }
  throw new Error("PackedMaterialResolvePass requires ShadeGPUCommandContext");
}

function requireBuffer(value: unknown, label: string): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error(`PackedMaterialResolvePass expected ${label} GPUBuffer`);
}
