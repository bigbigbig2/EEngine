/**
 * P4 Lighting Feature：统一编排 GPU 灯光分簇、直接光照和 HDR 背景。
 *
 * 具体算法由已验证的 pass 实现持有；Feature 只负责输入合同、生产者/消费者
 * 顺序和输出产品，避免 Renderer 继续拥有光照算法细节。
 */

import type { PerspectiveCamera } from "../../camera/PerspectiveCamera.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
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
import {
  LightingPass,
  type LightingInputs
} from "../passes/LightingPass.js";

export interface LightingFeatureJob {
  readonly camera: PerspectiveCamera;
  readonly lights: GPULightCollection;
  readonly width: number;
  readonly height: number;
  readonly surfaceMetadataAvailable: boolean;
}

export interface LightingFeatureInputs {
  readonly gPbr: ResourceId;
  readonly gNormal: ResourceId;
  readonly gAlbedo: ResourceId;
  readonly gEmissive: ResourceId;
  readonly gMetadata: ResourceId;
  readonly depth: ResourceId;
  readonly lightDatabase: ResourceId;
  readonly environment: ResourceId;
  readonly hzb: ResourceId;
  readonly camera: ResourceId;
  readonly view: ResourceId;
  readonly shadowAtlas: ResourceId;
  readonly counters?: ResourceId;
}

export interface LightingFeatureOutputs {
  readonly hdr: ResourceId;
  readonly clusters: LightClusterOutputs;
}

/**
 * P4 直接光照的唯一 Feature owner。
 *
 * GPU producer 链为 Light Buffer → candidate/active light list → cluster data，
 * GPU consumer 为 LightingPass 的逐像素 cluster 遍历；CPU 不生成灯光列表。
 */
export class LightingFeature {
  private readonly clusters: LightClusterPass;
  private readonly direct: LightingPass;
  private readonly background: EnvironmentBackgroundPass;

  constructor(graphics: GraphicsContext) {
    this.clusters = new LightClusterPass(graphics);
    this.direct = new LightingPass(graphics);
    this.direct.init();
    this.background = new EnvironmentBackgroundPass(graphics);
  }

  get lastClusterCount(): number {
    return this.clusters.lastClusterCount;
  }

  get lastLocalLightCount(): number {
    return this.clusters.lastLocalLightCount;
  }

  get lastDirectLightingRan(): boolean {
    return this.direct.lastRan;
  }

  get lastBackgroundRan(): boolean {
    return this.background.lastRan;
  }

  addToGraph(
    graph: FrameGraph,
    job: LightingFeatureJob,
    inputs: LightingFeatureInputs
  ): LightingFeatureOutputs {
    const clusters = this.clusters.addToGraph(
      graph,
      {
        camera: job.camera,
        lights: job.lights,
        width: job.width,
        height: job.height
      },
      {
        camera: inputs.camera,
        lightDatabase: inputs.lightDatabase,
        hzb: inputs.hzb,
        counters: inputs.counters
      }
    );
    const lightingInputs: LightingInputs = {
      gPbr: inputs.gPbr,
      gNormal: inputs.gNormal,
      gAlbedo: inputs.gAlbedo,
      gEmissive: inputs.gEmissive,
      gMetadata: inputs.gMetadata,
      depth: inputs.depth,
      lightDatabase: inputs.lightDatabase,
      environment: inputs.environment,
      clusterParameters: clusters.parameters,
      clusterLookup: clusters.lookup,
      clusterData: clusters.data,
      activeLightList: clusters.activeLightList,
      shadowAtlas: inputs.shadowAtlas,
      camera: inputs.camera,
      view: inputs.view
    };
    const direct = this.direct.addToGraph(
      graph,
      {
        width: job.width,
        height: job.height,
        surfaceMetadataAvailable: job.surfaceMetadataAvailable
      },
      lightingInputs
    );
    return Object.freeze({ hdr: direct.hdr, clusters });
  }

  addEnvironmentBackground(
    graph: FrameGraph,
    inputs: EnvironmentBackgroundInputs
  ): { readonly hdr: ResourceId } {
    return this.background.addToGraph(graph, inputs);
  }

  destroy(): void {
    this.background.destroy();
    this.direct.destroy();
  }
}
