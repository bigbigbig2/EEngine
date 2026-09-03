/**
 * P5 GI Service：收拢静态/动态间接光 Provider 与 IBL fallback 的 composition。
 *
 * Diffuse fallback 链：`Lightmap → Probe Volume → IBL → 无间接光`（§7.1）。
 * - 静态 GI Provider（Lightmap）由 Brick4 系列 pass 消费 GPU-ready Lightmap；
 * - 动态 GI Provider（Probe Volume）由 LpvIndirectDiffusePass 消费 Probe Volume；
 * - IBL baseline 由 OpaqueLightingPipeline 提供 IBL diffuse/specular 基线。
 *
 * 三个 Provider 通过同一 IndirectComposite 合成，不复制 Surface 解释；Renderer
 * 只预导入资源并传入，具体的 Provider 组合与 fallback 决策收敛在 GIService。
 */

import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { GraphicsContext } from "../../gpu/GraphicsContext.js";
import {
  OpaqueLightingPipeline,
  type OpaqueIblInputs,
  type OpaqueLightingFrame
} from "../pipeline/OpaqueLightingPipeline.js";
import type { IndirectCompositeInputs } from "../passes/IndirectCompositePass.js";
import {
  Brick4DiffusePass,
  Brick4FusedIndirectPass,
  Brick4SpecularPass,
  type Brick4BaseInputs,
  type Brick4IndirectJob
} from "../passes/Brick4IndirectPass.js";
import {
  LpvIndirectDiffusePass,
  type LpvIndirectDiffuseJob
} from "../passes/LpvIndirectDiffusePass.js";

/** 静态 GI Provider（Lightmap）的合成输入：Renderer 预导入后传入。 */
export interface LightmapIndirectInputs {
  readonly hdr: ResourceId;
  readonly depth: ResourceId;
  readonly normal: ResourceId;
  readonly bentNormal: ResourceId;
  readonly albedoAo: ResourceId;
  readonly pbr: ResourceId;
  readonly splitSum: ResourceId;
  readonly stbn: ResourceId;
  readonly view: ResourceId;
  readonly camera: ResourceId;
  readonly lightMap: ResourceId;
  readonly ambientVisibility?: ResourceId;
  readonly metadata?: ResourceId;
  readonly extent: { readonly width: number; readonly height: number };
  /** true 时走 Brick4 fused 路径（直接累加 hdr），否则 diffuse/specular 分离后合成。 */
  readonly fused: boolean;
}

/** 动态 GI Provider（Probe Volume）的合成输入：Renderer 预导入后传入。 */
export interface ProbeVolumeIndirectInputs {
  readonly hdr: ResourceId;
  readonly depth: ResourceId;
  readonly normal: ResourceId;
  readonly bentNormal: ResourceId;
  readonly albedoAo: ResourceId;
  readonly pbr: ResourceId;
  readonly splitSum: ResourceId;
  readonly environment: ResourceId;
  readonly camera: ResourceId;
  readonly ambientVisibility?: ResourceId;
  readonly metadata?: ResourceId;
  readonly atlasRadiance: ResourceId;
  readonly atlasDepth: ResourceId;
  readonly meshBvh: ResourceId;
  readonly metadataBuffer: ResourceId;
  readonly tetrahedra: ResourceId;
  readonly probes: ResourceId;
  readonly extent: { readonly width: number; readonly height: number };
  /** 持有 late-bound camera/sampler/尺寸的 job（由 Renderer 通过 bind() 构造）。 */
  readonly job: LpvIndirectDiffuseJob;
}

export interface ProbeVolumeIndirectOutput {
  readonly hdr: ResourceId;
  readonly indirectSpecular: ResourceId;
}

export interface LightmapIndirectOutput {
  readonly hdr: ResourceId;
  /** Brick4 非 fused 路径的 specular 基线，供 SSSR delta correction 消费；fused 路径无独立基线，为 null。 */
  readonly indirectSpecular: ResourceId | null;
}

export class GIService {
  readonly implementation: OpaqueLightingPipeline;
  private readonly graphics: GraphicsContext;
  private brick4Diffuse: Brick4DiffusePass | null;
  private brick4Specular: Brick4SpecularPass | null;
  private brick4Fused: Brick4FusedIndirectPass | null;
  private lpvDiffuse: LpvIndirectDiffusePass | null;

  constructor(graphics: GraphicsContext) {
    this.graphics = graphics;
    this.implementation = new OpaqueLightingPipeline(graphics);
    this.brick4Diffuse = new Brick4DiffusePass(graphics);
    this.brick4Specular = new Brick4SpecularPass(graphics);
    this.brick4Fused = new Brick4FusedIndirectPass(graphics);
    this.lpvDiffuse = null;
  }

  addIblBaseline(
    graph: FrameGraph,
    extent: { readonly width: number; readonly height: number },
    inputs: OpaqueIblInputs
  ): OpaqueLightingFrame {
    return this.implementation.addIblBaseline(graph, extent, inputs);
  }

  addBaselineSpecular(
    graph: FrameGraph,
    extent: { readonly width: number; readonly height: number },
    inputs: Pick<OpaqueIblInputs, "bentNormal" | "normal" | "environment" | "pbr" | "depth" | "camera">
  ): ResourceId {
    return this.implementation.addBaselineSpecular(graph, extent, inputs);
  }

  composeIndirect(graph: FrameGraph, inputs: IndirectCompositeInputs): ResourceId {
    return this.implementation.composeIndirect(graph, inputs);
  }

  /** 静态 GI Provider（Lightmap）：Brick4 diffuse/specular（或 fused）→ IndirectComposite。 */
  addLightmapIndirect(graph: FrameGraph, inputs: LightmapIndirectInputs): LightmapIndirectOutput {
    const base: Brick4BaseInputs = {
      depth: inputs.depth,
      stbn: inputs.stbn,
      view: inputs.view,
      camera: inputs.camera,
      lightMap: inputs.lightMap
    };
    if (inputs.fused) {
      const hdr = this.brick4Fused!.addToGraph(graph, {
        ...base,
        hdr: inputs.hdr,
        normal: inputs.normal,
        bentNormal: inputs.bentNormal,
        albedoAo: inputs.albedoAo,
        pbr: inputs.pbr,
        splitSum: inputs.splitSum
      });
      return { hdr, indirectSpecular: null };
    }
    const job: Brick4IndirectJob = {
      width: inputs.extent.width,
      height: inputs.extent.height
    };
    const indirectSpecular = this.brick4Specular!.addToGraph(
      graph,
      job,
      { ...base, normal: inputs.normal, pbr: inputs.pbr }
    );
    const indirectDiffuse = this.brick4Diffuse!.addToGraph(
      graph,
      job,
      { ...base, normal: inputs.bentNormal, albedoAo: inputs.albedoAo }
    );
    const hdr = this.composeIndirect(graph, {
      hdr: inputs.hdr,
      depth: inputs.depth,
      normal: inputs.normal,
      bentNormal: inputs.bentNormal,
      albedoAo: inputs.albedoAo,
      pbr: inputs.pbr,
      splitSum: inputs.splitSum,
      indirectDiffuse,
      indirectSpecular,
      ambientVisibility: inputs.ambientVisibility,
      camera: inputs.camera,
      metadata: inputs.metadata
    });
    return { hdr, indirectSpecular };
  }

  /** 动态 GI Provider（Probe Volume）：LPV diffuse + IBL specular 基线 → IndirectComposite。 */
  addProbeVolumeIndirect(
    graph: FrameGraph,
    inputs: ProbeVolumeIndirectInputs
  ): ProbeVolumeIndirectOutput {
    const baselineSpecularRes = this.addBaselineSpecular(graph, inputs.extent, {
      bentNormal: inputs.bentNormal,
      normal: inputs.normal,
      environment: inputs.environment,
      pbr: inputs.pbr,
      depth: inputs.depth,
      camera: inputs.camera
    });
    this.lpvDiffuse ??= new LpvIndirectDiffusePass(this.graphics);
    const diffuse = this.lpvDiffuse.addToGraph(graph, inputs.job, {
      depth: inputs.depth,
      normal: inputs.normal,
      albedoAo: inputs.albedoAo,
      atlasRadiance: inputs.atlasRadiance,
      atlasDepth: inputs.atlasDepth,
      meshBvh: inputs.meshBvh,
      metadata: inputs.metadataBuffer,
      tetrahedra: inputs.tetrahedra,
      probes: inputs.probes
    });
    const hdr = this.composeIndirect(graph, {
      hdr: inputs.hdr,
      depth: inputs.depth,
      normal: inputs.normal,
      bentNormal: inputs.bentNormal,
      albedoAo: inputs.albedoAo,
      pbr: inputs.pbr,
      splitSum: inputs.splitSum,
      indirectDiffuse: diffuse.indirectDiffuse,
      indirectSpecular: baselineSpecularRes,
      ambientVisibility: inputs.ambientVisibility,
      camera: inputs.camera,
      metadata: inputs.metadata
    });
    return { hdr, indirectSpecular: baselineSpecularRes };
  }

  resetFrameEvidence(): void {
    this.implementation.resetFrameEvidence();
    this.brick4Diffuse!.lastRan = false;
    this.brick4Specular!.lastRan = false;
    this.brick4Fused!.lastRan = false;
    if (this.lpvDiffuse !== null) this.lpvDiffuse.lastRan = false;
  }

  destroy(): void {
    this.implementation.destroy();
    // Brick4 系列 pass 无 destroy()，仅释放引用。
    this.brick4Diffuse = null;
    this.brick4Specular = null;
    this.brick4Fused = null;
    this.lpvDiffuse?.destroy();
    this.lpvDiffuse = null;
  }
}
