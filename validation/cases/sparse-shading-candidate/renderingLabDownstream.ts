import { GPU_HDR_FORMAT } from "../../../../OEngine/src/gpu/GpuHdrAbi.js";
import { THREE_SSR_REVISION } from "../../../../OEngine/src/shaders/ssr_common.js";
import type { GPUTextureContext } from "../../../../OEngine/src/gpu/GPUTextureContext.js";
import type { GraphicsContext } from "../../../../OEngine/src/gpu/GraphicsContext.js";
import { FrameGraph, type PassResources } from "../../../../OEngine/src/framegraph/FrameGraph.js";
import type { ResourceId } from "../../../../OEngine/src/framegraph/ResourceHandle.js";
import { resolveGpuEncoder } from "../../../../OEngine/src/framegraph/FrameGraph.js";
import { HierarchicalZBuffer } from "../../../../OEngine/src/render/HierarchicalZBuffer.js";
import { GIService } from "../../../../OEngine/src/render/features/GIService.js";
import { ReflectionService } from "../../../../OEngine/src/render/features/ReflectionService.js";
import { ScreenSpaceDiffuseService } from "../../../../OEngine/src/render/features/ScreenSpaceDiffuseService.js";
import { TemporalFeature } from "../../../../OEngine/src/render/features/TemporalFeature.js";
import { OcclusionConfidencePass } from "../../../../OEngine/src/render/passes/OcclusionConfidencePass.js";
import {
  OPAQUE_COLOR_PYRAMID_MAX_MIPS,
  SHARED_COLOR_PYRAMID_ABI_VERSION,
  SharedColorPyramidPass
} from "../../../../OEngine/src/render/passes/SharedColorPyramidPass.js";
import {
  preExposedOpaqueHdrBaselineFrame,
  textureDomain,
  type PreExposureContract
} from "../../../../OEngine/src/render/pipeline/FrameProducts.js";
import type {
  SparseShadingCandidateDownstreamComposition,
  SparseShadingCandidateDownstreamStage,
  SparseShadingCandidateFrame
} from "../../../../OEngine/src/render/pipeline/SparseShadingCandidatePipeline.js";

export interface RenderingLabDownstreamResources {
  readonly camera: ResourceId;
  readonly previousCamera: ResourceId;
  readonly previousDepth: ResourceId;
  readonly view: ResourceId;
  readonly counters: ResourceId;
  readonly stbn: ResourceId;
  readonly blueNoise: ResourceId;
  readonly environmentDiffuse: ResourceId;
  readonly environmentSpecular: ResourceId;
  readonly splitSum: ResourceId;
  readonly fallbackDiffuse: ResourceId;
  readonly brick4: ResourceId;
  readonly lpvMeshBvh: ResourceId;
  readonly lpvMetadata: ResourceId;
  readonly lpvTetrahedra: ResourceId;
  readonly lpvProbes: ResourceId;
  readonly lpvDepthAtlas: ResourceId;
  readonly presentation: ResourceId;
  readonly post: (
    graph: FrameGraph,
    hdr: ResourceId,
    presentation: ResourceId
  ) => ResourceId;
}

interface GraphState {
  readonly frameIndex: number;
  readonly historyValid: boolean;
  common?: Readonly<{
    hzb: ResourceId;
    confidence: ResourceId;
    classification: ResourceId;
  }>;
  baselineSpecular?: ResourceId;
}

const PRE_EXPOSURE: PreExposureContract = Object.freeze({
  multiplier: 2,
  generation: 1,
  colorSpace: "working-linear"
});

/**
 * Validation-only composition owner for the ADR-0013 RenderingLabFixed gate.
 * Every algorithm is the production pass/service; this class only supplies a
 * deterministic fixed workload and submission-aware history indices.
 */
export class RenderingLabDownstream {
  private readonly hzb: HierarchicalZBuffer;
  private readonly occlusion: OcclusionConfidencePass;
  private readonly temporal: TemporalFeature;
  private readonly gi: GIService;
  private readonly ssgi: ScreenSpaceDiffuseService;
  private readonly reflection: ReflectionService;
  private readonly colorPyramid: SharedColorPyramidPass;
  private readonly states = new WeakMap<FrameGraph, GraphState>();
  private submittedFrames = 0;
  private abortedFrames = 0;

  constructor(
    private readonly graphics: GraphicsContext,
    private readonly width: number,
    private readonly height: number
  ) {
    this.hzb = new HierarchicalZBuffer(graphics);
    this.hzb.setViewportSize(width, height);
    this.occlusion = new OcclusionConfidencePass(graphics);
    this.temporal = new TemporalFeature(graphics);
    this.temporal.ensureColorHistory(width, height);
    this.gi = new GIService(graphics);
    this.ssgi = new ScreenSpaceDiffuseService(graphics, true, 1);
    this.reflection = new ReflectionService(graphics, true, 1);
    this.colorPyramid = new SharedColorPyramidPass(graphics);
  }

  beginFrame(graph: FrameGraph, frameIndex: number): void {
    if (this.states.has(graph)) throw new Error("RenderingLab downstream graph was begun twice");
    this.hzb.resetFrameStatistics();
    this.hzb.beginFrame(frameIndex, { camera: 1, renderScale: 1, feature: 1 });
    // Resize the physical histories before capturing their native textures in
    // graph imports; addToGraph must not invalidate an already imported view.
    this.ssgi.resize(this.width, this.height);
    this.reflection.resize(this.width, this.height);
    this.ssgi.resetFrameEvidence();
    this.reflection.resetFrameEvidence();
    this.temporal.resetFrameEvidence();
    this.colorPyramid.resetFrameEvidence();
    this.states.set(graph, {
      frameIndex,
      historyValid: this.submittedFrames > 0
    });
  }

  compose(
    stage: SparseShadingCandidateDownstreamStage,
    graph: FrameGraph,
    frame: Readonly<SparseShadingCandidateFrame>,
    resources: Readonly<RenderingLabDownstreamResources>
  ): Readonly<SparseShadingCandidateDownstreamComposition> {
    const state = this.requireState(graph);
    if (stage === "ssgi") return this.composeSsgi(graph, frame, resources, state);
    if (stage === "ssr") return this.composeSsr(graph, frame, resources, state);
    if (stage === "temporal") return this.composeTemporal(graph, frame, resources, state);
    if (stage === "post") {
      const hdr = required(frame.hdr, "post HDR");
      return Object.freeze({
        hdr,
        finalOutput: resources.post(graph, hdr, resources.presentation)
      });
    }
    throw new Error(`RenderingLabFixed does not enable downstream stage '${stage}'`);
  }

  commitSubmittedFrame(graph: FrameGraph): void {
    const state = this.requireState(graph);
    if (!this.hzb.commitHistory(state.frameIndex)) {
      throw new Error("RenderingLab HZB history did not commit after submitted work");
    }
    this.states.delete(graph);
    this.submittedFrames++;
  }

  abortFrame(graph: FrameGraph): void {
    this.requireState(graph);
    this.states.delete(graph);
    this.hzb.invalidate("explicit");
    this.abortedFrames++;
  }

  evidence(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      algorithms: Object.freeze({
        ssgi: this.ssgi.implementation.algorithm,
        ssgiRevision: this.ssgi.implementation.upstreamRevision,
        ssr: "three-ssr-r186-oengine-wgsl",
        ssrRevision: THREE_SSR_REVISION
      }),
      passes: Object.freeze({
        hzbBuilds: this.hzb.lastBuildCount,
        hzbDispatches: this.hzb.lastDispatchCount,
        ssgiTrace: this.ssgi.lastTracePasses,
        ssgiSpatial: this.ssgi.lastSpatialPasses,
        ssgiTemporal: this.ssgi.lastTemporalPasses,
        ssgiResolve: this.ssgi.lastResolvePasses,
        ssrTrace: this.reflection.lastTracePasses,
        ssrResolve: this.reflection.lastResolvePasses,
        ssrSpatial: this.reflection.lastSpatialPasses,
        ssrTemporal: this.reflection.lastTemporalPasses,
        ssrCorrection: this.reflection.lastCorrectionRan,
        taa: this.temporal.taa()?.lastRan ?? false,
        colorPyramid: this.colorPyramid.evidence()
      }),
      histories: Object.freeze({
        valid: this.submittedFrames > 0,
        submittedFrames: this.submittedFrames,
        abortedFrames: this.abortedFrames,
        hzbValid: this.hzb.historyValid,
        ssgiTextures: this.ssgi.historyTextureCount,
        ssrTextures: this.reflection.historyTextureCount,
        temporalColorTextures: this.temporal.colorHistoryCount()
      })
    });
  }

  destroy(): void {
    this.colorPyramid.destroy();
    this.reflection.destroy();
    this.ssgi.destroy();
    this.gi.destroy();
    this.temporal.destroy();
    this.occlusion.destroy();
    this.hzb.destroy();
  }

  private composeSsgi(
    graph: FrameGraph,
    frame: Readonly<SparseShadingCandidateFrame>,
    resources: Readonly<RenderingLabDownstreamResources>,
    state: GraphState
  ): Readonly<SparseShadingCandidateDownstreamComposition> {
    const common = this.ensureCommon(graph, frame, resources, state);
    const normal = required(frame.normal, "SSGI normal");
    const albedoAo = required(frame.albedoAo, "SSGI albedo/AO");
    const material = required(frame.material, "SSGI material");
    const depth = required(frame.depth, "SSGI depth");
    const hdr = required(frame.hdr, "SSGI direct HDR");
    const lighting = this.gi.resolveOpaqueLighting(graph, {
      hdr,
      depth,
      normal,
      bentNormal: normal,
      albedoAo,
      pbr: material,
      camera: resources.camera,
      splitSum: resources.splitSum,
      metadata: material,
      extent: { width: this.width, height: this.height },
      reflectionCorrectionExpected: true,
      screenSpaceDiffuseCorrectionExpected: true,
      fallbackDiffuseIrradiance: resources.fallbackDiffuse,
      providerJob: {
        width: this.width,
        height: this.height,
        countersEnabled: true,
        brickRegistered: false,
        brickResident: false,
        brickGeneration: 0,
        brickExpectedGeneration: 0,
        probeRegistered: false,
        probeResident: false,
        probeGeneration: 0,
        probeExpectedGeneration: 0,
        iblResident: true
      },
      providerInputs: {
        view: resources.view,
        counters: resources.counters,
        stbn: resources.stbn,
        environmentDiffuse: resources.environmentDiffuse,
        environmentSpecular: resources.environmentSpecular,
        brick4: resources.brick4,
        lpvMeshBvh: resources.lpvMeshBvh,
        lpvMetadata: resources.lpvMetadata,
        lpvTetrahedra: resources.lpvTetrahedra,
        lpvProbes: resources.lpvProbes,
        lpvDepthAtlas: resources.lpvDepthAtlas
      }
    });
    if (lighting.resolvedDiffuse === null || lighting.baselineSpecular === null) {
      throw new Error("RenderingLab GI did not materialize SSGI/SSR components");
    }
    state.baselineSpecular = lighting.baselineSpecular;
    const inputIndex = (state.frameIndex & 1) as 0 | 1;
    const outputIndex = (1 - inputIndex) as 0 | 1;
    const ssgi = this.ssgi.addToGraph(graph, {
      samplers: this.graphics.samplers,
      frameIndex: state.frameIndex,
      historyValid: state.historyValid,
      width: this.width,
      height: this.height,
      radiusWorldUnits: 2.5,
      screenSpaceRadius: 0.2,
      samplingDomain: "world",
      thicknessWorldUnits: 0.35,
      aoIntensity: 1,
      giIntensity: 1,
      sliceCount: 3,
      stepCount: 8,
      spatialStep: 2,
      temporalBlend: 0.9,
      backfaceLighting: 0.15,
      historyGeneration: 1,
      preExposure: PRE_EXPOSURE,
      historyPreExposureScale: 1
    }, {
      depth,
      hzb: common.hzb,
      normal,
      radianceSource: lighting.hdr,
      velocity: required(frame.velocity, "SSGI velocity"),
      occlusionConfidence: common.confidence,
      surfaceValidity: common.classification,
      camera: resources.camera
    }, {
      aoInput: this.ssgi.historyTexture(inputIndex, "ao"),
      aoOutput: this.ssgi.historyTexture(outputIndex, "ao"),
      giInput: this.ssgi.historyTexture(inputIndex, "gi"),
      giOutput: this.ssgi.historyTexture(outputIndex, "gi")
    });
    const resolved = this.gi.resolveScreenSpaceDiffuse(graph, {
      hdr: lighting.hdr,
      depth,
      normal,
      bentNormal: ssgi.frame.bentNormal,
      albedoAo,
      material,
      metadata: material,
      camera: resources.camera,
      splitSum: resources.splitSum,
      longRangeDiffuse: lighting.resolvedDiffuse,
      baselineSpecular: lighting.baselineSpecular,
      screenVisibility: ssgi.frame.screenAmbientVisibility,
      incidentGi: ssgi.frame.incidentDiffuseGi,
      reflectionCorrectionExpected: true
    });
    return Object.freeze({ hdr: resolved });
  }

  private composeSsr(
    graph: FrameGraph,
    frame: Readonly<SparseShadingCandidateFrame>,
    resources: Readonly<RenderingLabDownstreamResources>,
    state: GraphState
  ): Readonly<SparseShadingCandidateDownstreamComposition> {
    const common = this.ensureCommon(graph, frame, resources, state);
    const hdr = required(frame.hdr, "SSR HDR");
    const depth = required(frame.depth, "SSR depth");
    const normal = required(frame.normal, "SSR normal");
    const material = required(frame.material, "SSR material");
    const baselineSpecular = state.baselineSpecular;
    if (baselineSpecular === undefined) {
      throw new Error("RenderingLab SSR requires the SSGI-stage baseline specular product");
    }
    const baseline = preExposedOpaqueHdrBaselineFrame({
      hdr,
      baselineSpecular,
      stage: "post-screen-space-diffuse-pre-ssr",
      reflectionCorrectionExpected: true,
      preExposure: PRE_EXPOSURE,
      domain: textureDomain("internal-full", this.width, this.height, 1)
    });
    const pyramid = this.colorPyramid.addOpaqueToGraph(graph, baseline, depth, {
      width: this.width,
      height: this.height,
      mipLevelCount: OPAQUE_COLOR_PYRAMID_MAX_MIPS,
      sourceGeneration: SHARED_COLOR_PYRAMID_ABI_VERSION,
      preExposure: PRE_EXPOSURE,
      samplers: this.graphics.samplers
    });
    const inputIndex = (state.frameIndex & 1) as 0 | 1;
    const outputIndex = (1 - inputIndex) as 0 | 1;
    const ssr = this.reflection.addToGraph(graph, {
      width: this.width,
      height: this.height,
      frameIndex: state.frameIndex,
      historyValid: state.historyValid,
      historyInputIndex: inputIndex,
      historyOutputIndex: outputIndex,
      samplers: this.graphics.samplers,
      maxDistance: 20,
      edgeFade: 0.08,
      maxSteps: 64,
      baseThickness: 0.08,
      distanceThicknessScale: 0.02,
      maxRoughness: 0.8,
      mirrorBias: 0.08,
      temporalStrength: 0.9,
      historyPreExposureScale: 1
    }, {
      depth,
      hzb: common.hzb,
      opaqueColorPyramid: pyramid,
      pbr: material,
      normal,
      velocity: required(frame.velocity, "SSR velocity"),
      occlusionConfidence: common.confidence,
      surfaceValidity: common.classification,
      albedoAo: required(frame.albedoAo, "SSR albedo/AO"),
      blueNoise: resources.blueNoise,
      currentCamera: resources.camera
    }, {
      input: this.reflection.historyTexture(inputIndex),
      output: this.reflection.historyTexture(outputIndex)
    });
    return Object.freeze({
      hdr: this.reflection.addCorrection(graph, {
        hdr,
        depth,
        baselineSpecular,
        resolvedSpecular: ssr.denoised,
        metadata: material
      })
    });
  }

  private composeTemporal(
    graph: FrameGraph,
    frame: Readonly<SparseShadingCandidateFrame>,
    resources: Readonly<RenderingLabDownstreamResources>,
    state: GraphState
  ): Readonly<SparseShadingCandidateDownstreamComposition> {
    const common = this.ensureCommon(graph, frame, resources, state);
    const inputIndex = (state.frameIndex & 1) as 0 | 1;
    const outputIndex = (1 - inputIndex) as 0 | 1;
    const historyInput = graph.import_resource(
      "RenderingLab/temporal history input",
      { kind: "imported", label: "RenderingLab temporal history input" },
      this.temporal.colorHistory(inputIndex)
    );
    const historyOutput = graph.import_resource(
      "RenderingLab/temporal history output",
      { kind: "imported", label: "RenderingLab temporal history output" },
      this.temporal.colorHistory(outputIndex)
    );
    const hdr = this.temporal.addTaaToGraph(graph, {
      historyValidity: state.historyValid ? 1 : 0,
      internalResolution: [this.width, this.height],
      outputResolution: [this.width, this.height],
      samplers: this.graphics.samplers,
      historyStrength: 0.92,
      varianceGamma: 1.5,
      minimumHistoryWeight: 0.05,
      maximumHistoryWeight: 0.95,
      historyLockStep: 0.08,
      reactiveThreshold: 0.1,
      disocclusionThreshold: 0.2,
      motionFadePixels: 32,
      historyPreExposureScale: 1
    }, {
      output: historyOutput,
      currentColor: required(frame.hdr, "TAA current color"),
      historyColor: historyInput,
      velocity: required(frame.velocity, "TAA velocity"),
      disocclusionConfidence: common.confidence,
      classification: common.classification,
      depth: required(frame.depth, "TAA depth")
    });
    const depthHistory = graph.add(
      "RenderingLab submitted depth/camera history copy",
      resources,
      (data, passResources, context) => {
        const encoder = resolveGpuEncoder(context);
        if (encoder === undefined) throw new Error("RenderingLab history copy requires GPU encoder");
        encoder.copyTextureToTexture(
          { texture: nativeTexture(passResources.get(required(frame.depth, "history depth"))) },
          { texture: nativeTexture(passResources.get(data.previousDepth)) },
          [this.width, this.height, 1]
        );
        encoder.copyBufferToBuffer(
          buffer(passResources.get(data.camera)),
          0,
          buffer(passResources.get(data.previousCamera)),
          0,
          buffer(passResources.get(data.camera)).size
        );
      }
    );
    depthHistory.read(required(frame.depth, "history depth"));
    depthHistory.read(resources.camera);
    depthHistory.write(resources.previousDepth);
    depthHistory.write(resources.previousCamera);
    return Object.freeze({ hdr });
  }

  private ensureCommon(
    graph: FrameGraph,
    frame: Readonly<SparseShadingCandidateFrame>,
    resources: Readonly<RenderingLabDownstreamResources>,
    state: GraphState
  ): GraphState["common"] & {} {
    if (state.common !== undefined) return state.common;
    const depth = required(frame.depth, "downstream depth");
    const velocity = required(frame.velocity, "downstream velocity");
    const material = required(frame.material, "downstream metadata");
    let hzbResource = graph.import_resource(
      "RenderingLab/current HZB",
      { kind: "imported", label: "RenderingLab current HZB" },
      this.hzb.getCurrentTexture()
    );
    const hzb = graph.add(
      "RenderingLab production HZB build",
      {},
      (_data, passResources, context) => {
        const encoder = resolveGpuEncoder(context);
        if (encoder === undefined) throw new Error("RenderingLab HZB requires GPU encoder");
        this.hzb.build(encoder, textureContext(passResources, depth));
      }
    );
    hzb.read(depth);
    hzbResource = hzb.write(hzbResource);
    const confidence = this.occlusion.addToGraph(graph, {
      width: this.width,
      height: this.height
    }, {
      currentDepth: depth,
      previousDepth: resources.previousDepth,
      velocity,
      currentCamera: resources.camera,
      previousCamera: resources.previousCamera
    }).occlusionConfidence;
    const classification = this.temporal.addClassificationToGraph(graph, {
      phase: "final",
      width: this.width,
      height: this.height,
      outputWidth: this.width,
      outputHeight: this.height,
      reconstructionOwner: "taa",
      metadataAvailable: true,
      transparencyAvailable: false,
      historyValid: state.historyValid,
      reactiveThreshold: 0.1,
      disocclusionThreshold: 0.2
    }, {
      surfaceMetadata: material,
      transparentReactive: confidence,
      disocclusionConfidence: confidence,
      depth,
      velocity
    }).classification;
    state.common = Object.freeze({ hzb: hzbResource, confidence, classification });
    return state.common;
  }

  private requireState(graph: FrameGraph): GraphState {
    const state = this.states.get(graph);
    if (state === undefined) throw new Error("RenderingLab downstream graph was not begun");
    return state;
  }
}

function required(value: ResourceId | null, label: string): ResourceId {
  if (value === null) throw new Error(`RenderingLab candidate omitted ${label}`);
  return value;
}

function textureContext(resources: PassResources, id: ResourceId): GPUTextureContext {
  const value = resources.get(id);
  if (value && typeof value === "object" && "isGPUTextureContext" in value) {
    return value as GPUTextureContext;
  }
  throw new Error("RenderingLab HZB source is not a graph texture context");
}

function nativeTexture(value: unknown): GPUTexture {
  if (value && typeof value === "object" && "isGPUTextureContext" in value) {
    return (value as GPUTextureContext).gpu_texture;
  }
  return value as GPUTexture;
}

function buffer(value: unknown): GPUBuffer {
  if (value && typeof value === "object" && "size" in value && "usage" in value) {
    return value as GPUBuffer;
  }
  throw new Error("RenderingLab history resource is not a GPUBuffer");
}

export const RENDERING_LAB_HDR_FORMAT = GPU_HDR_FORMAT;
