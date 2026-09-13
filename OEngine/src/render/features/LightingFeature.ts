/**
 * Production lighting orchestration after ADR-0013 cutover.
 *
 * LightClusterPass remains the GPU producer for both fused opaque kernels and
 * transparent forward shading. Direct opaque lighting is no longer a second
 * pass: SurfaceFeature's specialized kernels consume these products directly.
 */
import type { PerspectiveCamera } from "../../camera/PerspectiveCamera.js";
import {
  resolveGpuEncoder,
  type FrameGraph
} from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GPULightCollection } from "../../gpu/LightDatabase.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  EnvironmentBackgroundPass,
  type EnvironmentBackgroundInputs
} from "../passes/EnvironmentBackgroundPass.js";
import {
  LightClusterPass,
  type LightClusterOutputs
} from "../passes/LightClusterPass.js";
import { resolveTextureView } from "../RenderTargetViews.js";

export interface LightingClusterJob {
  readonly camera: PerspectiveCamera;
  readonly lights: GPULightCollection;
  readonly width: number;
  readonly height: number;
}

export interface LightingClusterInputs {
  readonly lightDatabase: ResourceId;
  readonly hzb: ResourceId;
  readonly camera: ResourceId;
  readonly counters?: ResourceId;
}

export class LightingFeature {
  private readonly clusters: LightClusterPass;
  private readonly background: EnvironmentBackgroundPass;

  constructor(graphics: GraphicsContext) {
    this.clusters = new LightClusterPass(graphics);
    this.background = new EnvironmentBackgroundPass(graphics);
  }

  get lastClusterCount(): number { return this.clusters.lastClusterCount; }
  get lastLocalLightCount(): number { return this.clusters.lastLocalLightCount; }
  get lastBackgroundRan(): boolean { return this.background.lastRan; }

  addClustersToGraph(
    graph: FrameGraph,
    job: LightingClusterJob,
    inputs: LightingClusterInputs
  ): LightClusterOutputs {
    return this.clusters.addToGraph(
      graph,
      {
        camera: job.camera,
        lights: job.lights,
        width: job.width,
        height: job.height
      },
      inputs
    );
  }

  /**
   * Transparent/background-only scenes still need one HDR composition target,
   * but must not instantiate any ShadingBin heap, classifier, or resolve pass.
   */
  addEmptyHdrToGraph(graph: FrameGraph, width: number, height: number): ResourceId {
    let hdr: ResourceId = -1;
    const builder = graph.add(
      "Lighting/initialize background-only HDR",
      {},
      (_data, resources, context) => {
        const encoder = resolveGpuEncoder(context);
        if (encoder === undefined) throw new Error("HDR initialization has no GPU encoder");
        const pass = encoder.beginRenderPass({
          label: "Lighting/initialize background-only HDR",
          colorAttachments: [{
            view: resolveTextureView(resources.get(hdr)),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store"
          }]
        });
        pass.end();
      }
    );
    hdr = builder.create("Lighting/background-only-hdr", {
      kind: "transient_texture",
      width,
      height,
      depthOrArrayLayers: 1,
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
      domain: "internal-full"
    });
    builder.declareEncoderWork({ renderPasses: 1 });
    return hdr;
  }

  addEnvironmentBackground(
    graph: FrameGraph,
    inputs: EnvironmentBackgroundInputs
  ): { readonly hdr: ResourceId } {
    return this.background.addToGraph(graph, inputs);
  }

  destroy(): void {
    this.background.destroy();
  }
}

export type { LightClusterOutputs, ResourceId };
