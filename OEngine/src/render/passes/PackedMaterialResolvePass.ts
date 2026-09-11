import { GpuCounterAtomicAdder } from "../../debug/GpuCounterAtomicAdder.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import type { GpuAssetBindings } from "../../gpu/GpuAssetStore.js";
import type { GpuSceneBindings } from "../../gpu/GpuScene.js";
import type { GpuRenderWorldRuntime } from "../../gpu/GpuRenderWorld.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL
} from "../../gpu/GpuComputeMaterialAbi.js";
import {
  GPU_SURFACE_FORMATS,
  GPU_SURFACE_ABI_V1_PROFILE,
  type GpuSurfaceAbiProfile
} from "../../gpu/GpuSurfaceAbi.js";
import type { MaterialResolveBackend } from "../MaterialResolveBackend.js";
import {
  type MaterialTileClassificationFrame,
  type SurfaceFrame,
  type VisibilityFrame
} from "../pipeline/FrameProducts.js";
import type { VelocityCameraMatrices } from "../VelocityMatrices.js";
import { ComputeMaterialResolvePass } from "./ComputeMaterialResolvePass.js";
import { ComputeMaterialSurfaceBridgePass } from "./ComputeMaterialSurfaceBridgePass.js";
import { MaterialTileClassificationPass } from "./MaterialTileClassificationPass.js";

/** R4-B compatibility name; the bridge attachment stores Surface metadata. */
export const PACKED_SURFACE_FLAGS_FORMAT = GPU_SURFACE_FORMATS.metadata;

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
  readonly gPbr: ResourceId;
  readonly gNormal: ResourceId;
  readonly gAlbedo: ResourceId;
  readonly gEmissive: ResourceId;
  readonly velocity: ResourceId | null;
  readonly surfaceFlags: ResourceId;
  readonly surface: SurfaceFrame;
  readonly tileClassification: MaterialTileClassificationFrame;
  readonly counters: ResourceId | null;
}

/**
 * Visibility-driven material owner.
 *
 * The historical class-depth/fullscreen material shaders are no longer
 * executed. ComputeMaterialResolvePass evaluates the material exactly once;
 * ComputeMaterialSurfaceBridgePass only unpacks the transition product for
 * consumers that have not yet completed the Step 3 SurfaceLite cutover.
 */
export class PackedMaterialResolvePass {
  private readonly counterAdder = new GpuCounterAtomicAdder();
  private readonly classifier: MaterialTileClassificationPass;
  private readonly compute: ComputeMaterialResolvePass;
  private readonly bridge: ComputeMaterialSurfaceBridgePass;
  private readonly profile: GpuSurfaceAbiProfile;
  lastKernelDrawCount = 0;
  lastActiveMaterialCount = 0;
  private currentSurfaceBytesPerPixel = 0;

  constructor(
    private readonly graphics: GraphicsContext,
    profile: GpuSurfaceAbiProfile = GPU_SURFACE_ABI_V1_PROFILE
  ) {
    this.profile = profile;
    this.classifier = new MaterialTileClassificationPass(graphics);
    this.compute = new ComputeMaterialResolvePass(graphics);
    this.bridge = new ComputeMaterialSurfaceBridgePass(graphics, profile);
  }

  get surfaceBytesPerPixel(): number {
    return this.currentSurfaceBytesPerPixel;
  }

  get materialResolveBackend(): MaterialResolveBackend {
    return "tile-compute";
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
    const surface = this.bridge.addToGraph(
      graph,
      compute.evaluation,
      inputs.visibility.depth,
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
          this.counterAdder.encode(command, target, "classDepthPixels", 0);
          this.counterAdder.encode(command, target, "classDraws", 0);
          this.lastActiveMaterialCount = data.activeMaterials;
          this.lastKernelDrawCount = 0;
        }
      );
      builder.read(inputCounters);
      outputCounters = builder.write(inputCounters);
      counters = outputCounters;
    } else {
      this.lastActiveMaterialCount = job.runtime.opaqueMaterialCount;
      this.lastKernelDrawCount = 0;
    }

    this.currentSurfaceBytesPerPixel =
      GPU_COMPUTE_MATERIAL_BYTES_PER_PIXEL +
      (options.velocity
        ? this.profile.bytesPerPixelWithVelocity
        : this.profile.bytesPerPixelWithoutVelocity);

    return Object.freeze({
      gPbr: surface.pbr,
      gNormal: surface.normal,
      gAlbedo: surface.albedoAo,
      gEmissive: surface.emissive,
      velocity: surface.velocity,
      surfaceFlags: surface.metadata,
      surface,
      tileClassification: materialTileWithCounters(
        compute.classification,
        counters
      ),
      counters
    });
  }

  destroy(): void {
    this.bridge.destroy();
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
