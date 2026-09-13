import type {
  FrameGraph,
  FrameGraphEncoderWork,
  FrameGraphContext,
  PassResources
} from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import {
  GPU_SHADING_BIN_INDIRECT_BYTES,
  type GpuShadingBinSizing
} from "../../gpu/GpuShadingBinAbi.js";
import type {
  GpuShadingPublicationSnapshot
} from "../../gpu/GpuShadingPublicationPlan.js";
import {
  GPU_SHADING_OUTPUT_DEPENDENCY
} from "../../gpu/GpuSparseShadingPipelineContract.js";

export const SPARSE_SHADING_CANDIDATE_SCHEMA_VERSION = 1;

export type SparseShadingCandidateStage =
  | "visibility"
  | "light-cluster"
  | "shadow"
  | "bin-clear-classify"
  | "bin-finalize"
  | "output-clear"
  | "bin-resolve"
  | "gtao"
  | "ssgi"
  | "ssr"
  | "temporal"
  | "post"
  | "diagnostics-finalize"
  | "diagnostics-copy"
  | "capture";

export type SparseShadingCandidateHistoryStage = "gtao" | "ssgi" | "ssr" | "temporal";

export interface SparseShadingCandidateFeatureInput {
  readonly screenSpaceDiffuseMode: "off" | "gtao" | "ssgi";
  readonly ssr: boolean;
  readonly temporal: boolean;
  readonly shadows: boolean;
  readonly post: boolean;
  readonly diagnostics: boolean;
}

export interface SparseShadingCandidatePlan {
  readonly schemaVersion: 1;
  readonly publicationRevision: number;
  readonly width: number;
  readonly height: number;
  readonly hasOpaque: boolean;
  readonly hasOpaqueLit: boolean;
  readonly hasAnyLitConsumer: boolean;
  readonly hasAnyShadowConsumer: boolean;
  readonly activeBinIds: readonly number[];
  readonly outputDependencyMask: number;
  readonly passes: readonly SparseShadingCandidateStage[];
  readonly resources: readonly string[];
  readonly histories: readonly string[];
  readonly timestampPhases: readonly string[];
  readonly counters: readonly string[];
  readonly memory: Readonly<{
    /** Logical texel bytes; driver allocation and alignment are recorded by live accounting. */
    visibilityKeyBytes: number;
    shadingBinIdBytes: number;
    depthBytes: number;
    heapBytes: number;
    indirectBytes: number;
    settingsBytes: number;
    outputBytes: number;
    diagnosticsBytes: number;
    totalBytes: number;
  }>;
}

export interface SparseShadingCandidateExternalResources {
  readonly meshletWork: ResourceId;
  readonly sceneGeometry: readonly ResourceId[];
  readonly materials: readonly ResourceId[];
  readonly lighting: readonly ResourceId[];
  readonly shadows: readonly ResourceId[];
  /** Required when the candidate post stage is enabled. */
  readonly presentation?: ResourceId;
  /** Validation-only asynchronous capture boundary; never a shading diagnostic. */
  readonly captureReadback?: ResourceId;
  /** Validation-only GPU-written oracle/counter scratch copied into captureReadback. */
  readonly captureScratch?: readonly ResourceId[];
  /** Exact validation capture command shape; omitted for a single-dispatch capture. */
  readonly captureEncoderWork?: Readonly<Partial<FrameGraphEncoderWork>>;
  /** Revision-owned resources from ShadingBinPass; imported only when opaque work exists. */
  readonly binResources?: Readonly<{
    readonly heap: unknown;
    readonly indirectArgs: unknown;
    readonly settings: unknown;
  }>;
  /** Imported ping-pong resources. Disabled histories must not be imported. */
  readonly histories?: Readonly<Partial<Record<
    SparseShadingCandidateHistoryStage,
    Readonly<{ input: ResourceId; output: ResourceId }>
  >>>;
}

export interface SparseShadingCandidateFrame {
  readonly plan: Readonly<SparseShadingCandidatePlan>;
  readonly visibilityKey: ResourceId | null;
  readonly shadingBinId: ResourceId | null;
  readonly depth: ResourceId | null;
  readonly heap: ResourceId | null;
  readonly indirectArgs: ResourceId | null;
  readonly settings: ResourceId | null;
  readonly hdr: ResourceId | null;
  /** Input color for a downstream stage; null for producer stages. */
  readonly stageInputHdr: ResourceId | null;
  readonly normal: ResourceId | null;
  readonly albedoAo: ResourceId | null;
  readonly material: ResourceId | null;
  readonly velocity: ResourceId | null;
  readonly claims: ResourceId | null;
  readonly diagnostics: ResourceId | null;
  readonly diagnosticsReadback: ResourceId | null;
  readonly captureReadback: ResourceId | null;
  readonly captureScratch: readonly ResourceId[];
  readonly historyInput: ResourceId | null;
  readonly historyOutput: ResourceId | null;
  readonly finalOutput: ResourceId | null;
}

export type SparseShadingCandidateStageExecutor = (
  stage: SparseShadingCandidateStage,
  frame: Readonly<SparseShadingCandidateFrame>,
  resources: PassResources,
  context: FrameGraphContext
) => void;

export function createSparseShadingCandidatePlan(
  snapshot: Readonly<GpuShadingPublicationSnapshot>,
  features: Readonly<SparseShadingCandidateFeatureInput>
): Readonly<SparseShadingCandidatePlan> {
  if (snapshot.context.outputDependencyMask !== requiredOutputMask(snapshot, features)) {
    throw new Error("Sparse shading snapshot output mask does not match candidate feature consumers");
  }
  const hasOpaqueLit = snapshot.summary.opaqueLitReceiverCount > 0;
  const hasOpaque = hasOpaqueLit || snapshot.summary.opaqueUnlitReceiverCount > 0;
  const hasAnyLitConsumer = hasOpaqueLit || snapshot.summary.transparentLitReceiverCount > 0;
  const hasAnyShadowConsumer = features.shadows &&
    hasAnyLitConsumer;
  if (snapshot.context.shadowSamplingEnabled !== (features.shadows && hasOpaqueLit)) {
    throw new Error("Sparse shading snapshot shadow specialization does not match candidate consumers");
  }
  const activeBinIds = snapshot.pipelines.map((pipeline) => pipeline.binId);
  if (hasOpaque !== (activeBinIds.length > 0)) {
    throw new Error("Active shading summary and pipeline closure disagree about opaque work");
  }
  const passes: SparseShadingCandidateStage[] = [];
  if (hasOpaque) passes.push("visibility");
  if (hasAnyLitConsumer) passes.push("light-cluster");
  if (hasAnyShadowConsumer) passes.push("shadow");
  if (hasOpaque) passes.push("bin-clear-classify", "bin-finalize", "output-clear", "bin-resolve");
  if (hasOpaqueLit && features.screenSpaceDiffuseMode === "gtao") passes.push("gtao");
  if (hasOpaqueLit && features.screenSpaceDiffuseMode === "ssgi") passes.push("ssgi");
  if (hasOpaqueLit && features.ssr) passes.push("ssr");
  if (hasOpaque && features.temporal) passes.push("temporal");
  if (hasOpaque && features.post) passes.push("post");
  if (hasOpaque && features.diagnostics) {
    passes.push("diagnostics-finalize", "diagnostics-copy");
  }

  const outputMask = snapshot.context.outputDependencyMask;
  const resources = hasOpaque ? [
    "visibility-key",
    "shading-bin-id",
    "reverse-z-depth",
    "shading-bin-heap",
    "shading-bin-indirect",
    "shading-bin-settings",
    "opaque-hdr",
    ...((outputMask & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0
      ? ["shading-normal"] : []),
    ...((outputMask & (GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
      GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite)) !== 0
      ? ["albedo-ao", "material-parameters"] : []),
    ...((outputMask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0
      ? ["velocity"] : []),
    ...(features.diagnostics
      ? ["shading-claims", "shading-diagnostics", "shading-diagnostics-readback"]
      : []),
    ...(features.post ? ["presentation"] : [])
  ] : [];
  if (hasAnyLitConsumer) resources.push("light-clusters");
  if (hasAnyShadowConsumer) resources.push("shadow-atlas");

  const histories = hasOpaque ? [
    ...(hasOpaqueLit && features.screenSpaceDiffuseMode !== "off"
      ? [`${features.screenSpaceDiffuseMode}-history`] : []),
    ...(hasOpaqueLit && features.ssr ? ["ssr-history"] : []),
    ...(features.temporal ? ["temporal-color-history"] : [])
  ] : [];
  const outputBytes = hasOpaque
    ? sparseOutputBytes(snapshot.context.width, snapshot.context.height, outputMask)
    : 0;
  const diagnosticsBytes = features.diagnostics && hasOpaque
    ? snapshot.context.width * snapshot.context.height * 4 + 32
    : 0;
  const memory = hasOpaque
    ? memoryRecord(snapshot.sizing, outputBytes, diagnosticsBytes)
    : emptyMemoryRecord();
  return Object.freeze({
    schemaVersion: SPARSE_SHADING_CANDIDATE_SCHEMA_VERSION as 1,
    publicationRevision: snapshot.revision,
    width: snapshot.context.width,
    height: snapshot.context.height,
    hasOpaque,
    hasOpaqueLit,
    hasAnyLitConsumer,
    hasAnyShadowConsumer,
    activeBinIds: Object.freeze(activeBinIds),
    outputDependencyMask: outputMask,
    passes: Object.freeze(passes),
    resources: Object.freeze(resources),
    histories: Object.freeze(histories),
    timestampPhases: Object.freeze(passes.filter((pass) => pass !== "diagnostics-copy")),
    counters: Object.freeze(hasOpaque ? [
      "shading-bin-attempted",
      "shading-bin-written",
      "shading-bin-overflow",
      "shading-bin-frame-errors",
      ...(features.diagnostics ? ["shading-duplicate", "shading-unassigned"] : [])
    ] : []),
    memory
  });
}

/**
 * Builds only the internal candidate recipe. It owns no submit/readback and is
 * intentionally not reachable from the public Renderer until Step 7.
 */
export function addSparseShadingCandidateToGraph(
  graph: FrameGraph,
  snapshot: Readonly<GpuShadingPublicationSnapshot>,
  features: Readonly<SparseShadingCandidateFeatureInput>,
  external: Readonly<SparseShadingCandidateExternalResources>,
  executeStage: SparseShadingCandidateStageExecutor
): Readonly<SparseShadingCandidateFrame> {
  const plan = createSparseShadingCandidatePlan(snapshot, features);
  const mutable: { -readonly [K in keyof SparseShadingCandidateFrame]: SparseShadingCandidateFrame[K] } = {
    plan,
    visibilityKey: null,
    shadingBinId: null,
    depth: null,
    heap: null,
    indirectArgs: null,
    settings: null,
    hdr: null,
    stageInputHdr: null,
    normal: null,
    albedoAo: null,
    material: null,
    velocity: null,
    claims: null,
    diagnostics: null,
    diagnosticsReadback: null,
    captureReadback: null,
    captureScratch: Object.freeze([]),
    historyInput: null,
    historyOutput: null,
    finalOutput: null
  };
  let previousPass: ReturnType<FrameGraph["add"]> | null = null;
  const lightingResources = [...external.lighting];
  const shadowResources = [...external.shadows];

  let lightingPass: ReturnType<FrameGraph["add"]> | null = null;
  const addLightingPass = (): void => {
    if (!plan.hasAnyLitConsumer) return;
    const lightingFrame = Object.freeze(cloneMutableFrame(mutable));
    lightingPass = graph.add("SparseShading/light cluster producer", lightingFrame,
      (data, resources, context) => executeStage("light-cluster", data, resources, context));
    for (let index = 0; index < lightingResources.length; index++) {
      lightingResources[index] = lightingPass.write(lightingResources[index]!);
    }
    lightingPass.make_side_effect();
    lightingPass.declareEncoderWork({ computePasses: 1, dispatches: 1 });
  };

  let shadowPass: ReturnType<FrameGraph["add"]> | null = null;
  const addShadowPass = (): void => {
    if (!plan.hasAnyShadowConsumer) return;
    const shadowFrame = Object.freeze(cloneMutableFrame(mutable));
    shadowPass = graph.add("SparseShading/shadow producer", shadowFrame,
      (data, resources, context) => executeStage("shadow", data, resources, context));
    for (let index = 0; index < shadowResources.length; index++) {
      shadowResources[index] = shadowPass.write(shadowResources[index]!);
    }
    shadowPass.make_side_effect();
    shadowPass.declareEncoderWork({ renderPasses: 1, draws: 1 });
  };

  if (!plan.hasOpaque) {
    addLightingPass();
    addShadowPass();
    return Object.freeze(mutable);
  }

  const visibilityFrame = cloneMutableFrame(mutable);
  const visibility = graph.add("SparseShading/visibility MRT", visibilityFrame,
    (data, resources, context) => executeStage("visibility", data, resources, context));
  visibility.read(external.meshletWork);
  for (const resource of external.sceneGeometry) visibility.read(resource);
  mutable.visibilityKey = visibility.create("sparse-shading/visibility-key", texture(
    plan, "r32uint", GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
  ));
  mutable.shadingBinId = visibility.create("sparse-shading/bin-id", texture(
    plan, "r8uint", GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
  ));
  mutable.depth = visibility.create("sparse-shading/depth", texture(
    plan, "depth32float", GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
  ));
  Object.assign(visibilityFrame, {
    visibilityKey: mutable.visibilityKey,
    shadingBinId: mutable.shadingBinId,
    depth: mutable.depth
  });
  Object.freeze(visibilityFrame);
  visibility.declareEncoderWork({ renderPasses: 1, draws: 1 });
  previousPass = visibility;

  addLightingPass();
  addShadowPass();

  const binResources = external.binResources;
  if (binResources === undefined) {
    throw new Error("Opaque sparse shading requires revision-owned bin resources");
  }
  mutable.heap = graph.import_resource(
    "sparse-shading/heap",
    { kind: "imported", label: "ADR-0013 revision-owned shading-bin heap" },
    binResources.heap
  );
  mutable.indirectArgs = graph.import_resource(
    "sparse-shading/indirect",
    { kind: "imported", label: "ADR-0013 revision-owned indirect arguments" },
    binResources.indirectArgs
  );
  mutable.settings = graph.import_resource(
    "sparse-shading/settings",
    { kind: "imported", label: "ADR-0013 frame settings allocation" },
    binResources.settings
  );

  const classifierFrame = cloneMutableFrame(mutable);
  const classifier = graph.add("SparseShading/clear + classify", classifierFrame,
    (data, resources, context) => executeStage("bin-clear-classify", data, resources, context));
  classifier.dependsOn(visibility);
  classifier.read(mutable.shadingBinId);
  mutable.heap = classifier.write(mutable.heap);
  mutable.indirectArgs = classifier.write(mutable.indirectArgs);
  classifier.read(mutable.settings);
  if (features.diagnostics) {
    mutable.claims = classifier.create("sparse-shading/claims", buffer(
      plan.width * plan.height * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    ));
    mutable.diagnostics = classifier.create("sparse-shading/diagnostics", buffer(
      16,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    ));
  }
  Object.assign(classifierFrame, {
    heap: mutable.heap,
    indirectArgs: mutable.indirectArgs,
    settings: mutable.settings,
    claims: mutable.claims,
    diagnostics: mutable.diagnostics
  });
  Object.freeze(classifierFrame);
  classifier.declareEncoderWork({ computePasses: 1, dispatches: 1 });
  previousPass = classifier;

  const finalizerFrame = cloneMutableFrame(mutable);
  const finalizer = graph.add("SparseShading/finalize indirect", finalizerFrame,
    (data, resources, context) => executeStage("bin-finalize", data, resources, context));
  finalizer.dependsOn(classifier);
  finalizer.read(mutable.heap);
  mutable.indirectArgs = finalizer.write(mutable.indirectArgs);
  if (mutable.diagnostics !== null) {
    mutable.diagnostics = finalizer.write(mutable.diagnostics);
  }
  finalizerFrame.indirectArgs = mutable.indirectArgs;
  finalizerFrame.diagnostics = mutable.diagnostics;
  Object.freeze(finalizerFrame);
  finalizer.declareEncoderWork({ computePasses: 1, dispatches: 1 });
  previousPass = finalizer;

  const outputClearFrame = cloneMutableFrame(mutable);
  const outputClear = graph.add("SparseShading/clear sparse outputs", outputClearFrame,
    (data, resources, context) => executeStage("output-clear", data, resources, context));
  outputClear.dependsOn(finalizer);
  mutable.hdr = outputClear.create("sparse-shading/hdr", texture(
    plan,
    "rgba16float",
    GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.TEXTURE_BINDING |
      (external.captureReadback === undefined ? 0 : GPUTextureUsage.COPY_SRC)
  ));
  if ((plan.outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0) {
    mutable.normal = outputClear.create("sparse-shading/normal", texture(
      plan,
      "rgba16uint",
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    ));
  }
  if ((plan.outputDependencyMask & (GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
      GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite)) !== 0) {
    mutable.albedoAo = outputClear.create("sparse-shading/albedo-ao", texture(
      plan,
      "rgba8unorm",
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    ));
    mutable.material = outputClear.create("sparse-shading/material", texture(
      plan,
      "rg32uint",
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    ));
  }
  if ((plan.outputDependencyMask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0) {
    mutable.velocity = outputClear.create("sparse-shading/velocity", texture(
      plan,
      "rg16float",
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    ));
  }
  Object.assign(outputClearFrame, {
    hdr: mutable.hdr,
    normal: mutable.normal,
    albedoAo: mutable.albedoAo,
    material: mutable.material,
    velocity: mutable.velocity
  });
  Object.freeze(outputClearFrame);
  outputClear.declareEncoderWork({ renderPasses: 1 });
  previousPass = outputClear;

  const resolveFrame = cloneMutableFrame(mutable);
  const resolve = graph.add("SparseShading/active-bin indirect resolve", resolveFrame,
    (data, resources, context) => executeStage("bin-resolve", data, resources, context));
  resolve.dependsOn(outputClear);
  if (lightingPass !== null) resolve.dependsOn(lightingPass);
  if (shadowPass !== null) resolve.dependsOn(shadowPass);
  for (const resource of [
    mutable.visibilityKey, mutable.shadingBinId, mutable.depth,
    external.meshletWork, mutable.heap, mutable.indirectArgs, mutable.settings,
    ...external.sceneGeometry, ...external.materials,
    ...(plan.hasOpaqueLit ? lightingResources : []),
    ...(plan.hasAnyShadowConsumer ? shadowResources : [])
  ]) resolve.read(resource);
  mutable.hdr = resolve.write(mutable.hdr);
  if (mutable.normal !== null) mutable.normal = resolve.write(mutable.normal);
  if (mutable.albedoAo !== null) mutable.albedoAo = resolve.write(mutable.albedoAo);
  if (mutable.material !== null) mutable.material = resolve.write(mutable.material);
  if (mutable.velocity !== null) mutable.velocity = resolve.write(mutable.velocity);
  if (mutable.claims !== null) mutable.claims = resolve.write(mutable.claims);
  if (mutable.diagnostics !== null) mutable.diagnostics = resolve.write(mutable.diagnostics);
  Object.assign(resolveFrame, {
    hdr: mutable.hdr,
    normal: mutable.normal,
    albedoAo: mutable.albedoAo,
    material: mutable.material,
    velocity: mutable.velocity,
    claims: mutable.claims,
    diagnostics: mutable.diagnostics
  });
  Object.freeze(resolveFrame);
  resolve.declareEncoderWork({
    computePasses: plan.activeBinIds.length,
    dispatches: plan.activeBinIds.length
  });
  previousPass = resolve;

  for (const stage of plan.passes) {
    if (!["gtao", "ssgi", "ssr", "temporal", "post"].includes(stage)) continue;
    const downstreamFrame = cloneMutableFrame(mutable);
    const downstream = graph.add(`SparseShading/downstream/${stage}`, downstreamFrame,
      (data, resources, context) => executeStage(stage, data, resources, context));
    downstream.dependsOn(previousPass);
    const inputHdr = mutable.hdr;
    downstream.read(inputHdr);
    if (mutable.normal !== null) downstream.read(mutable.normal);
    if (mutable.albedoAo !== null) downstream.read(mutable.albedoAo);
    if (mutable.material !== null) downstream.read(mutable.material);
    if (stage === "temporal" && mutable.velocity !== null) downstream.read(mutable.velocity);
    const history = historyForStage(plan, external, stage);
    if (history !== null) {
      downstream.read(history.input);
      downstreamFrame.historyInput = history.input;
      downstreamFrame.historyOutput = downstream.write(history.output);
    }
    downstreamFrame.stageInputHdr = inputHdr;
    if (stage === "post") {
      if (external.presentation === undefined) {
        throw new Error("Sparse shading post stage requires a presentation resource");
      }
      mutable.finalOutput = downstream.write(external.presentation);
      downstreamFrame.finalOutput = mutable.finalOutput;
      downstream.declareEncoderWork({ renderPasses: 1, draws: 1 });
    } else {
      mutable.hdr = downstream.write(mutable.hdr);
      mutable.finalOutput = mutable.hdr;
      downstreamFrame.hdr = mutable.hdr;
      downstreamFrame.finalOutput = mutable.hdr;
      downstream.declareEncoderWork({ computePasses: 1, dispatches: 1 });
    }
    Object.freeze(downstreamFrame);
    previousPass = downstream;
  }

  if (features.diagnostics && mutable.claims !== null && mutable.diagnostics !== null) {
    const diagnosticFrame = cloneMutableFrame(mutable);
    const diagnostic = graph.add("SparseShading/diagnostics finalize", diagnosticFrame,
      (data, resources, context) => executeStage("diagnostics-finalize", data, resources, context));
    diagnostic.dependsOn(resolve);
    diagnostic.read(mutable.shadingBinId);
    diagnostic.read(mutable.claims);
    mutable.diagnostics = diagnostic.write(mutable.diagnostics);
    diagnosticFrame.diagnostics = mutable.diagnostics;
    Object.freeze(diagnosticFrame);
    diagnostic.declareEncoderWork({ computePasses: 1, dispatches: 1 });
    const copyFrame = cloneMutableFrame(mutable);
    const copy = graph.add("SparseShading/diagnostics async copy boundary", copyFrame,
      (data, resources, context) => executeStage("diagnostics-copy", data, resources, context));
    copy.dependsOn(diagnostic);
    copy.read(mutable.diagnostics);
    mutable.diagnosticsReadback = copy.create("sparse-shading/diagnostics-readback", buffer(
      16,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    ));
    copyFrame.diagnosticsReadback = mutable.diagnosticsReadback;
    Object.freeze(copyFrame);
    copy.make_side_effect();
    previousPass = copy;
  }
  if (external.captureReadback !== undefined) {
    const captureFrame = cloneMutableFrame(mutable);
    const capture = graph.add("SparseShading/validation capture boundary", captureFrame,
      (data, resources, context) => executeStage("capture", data, resources, context));
    if (previousPass !== null) capture.dependsOn(previousPass);
    for (const resource of [
      mutable.visibilityKey,
      mutable.shadingBinId,
      mutable.heap,
      mutable.indirectArgs,
      mutable.settings,
      mutable.hdr,
      mutable.finalOutput
    ]) {
      if (resource !== null) capture.read(resource);
    }
    mutable.captureReadback = capture.write(external.captureReadback);
    mutable.captureScratch = Object.freeze(
      (external.captureScratch ?? []).map((resource) => capture.write(resource))
    );
    captureFrame.captureReadback = mutable.captureReadback;
    captureFrame.captureScratch = mutable.captureScratch;
    Object.freeze(captureFrame);
    capture.declareEncoderWork(external.captureEncoderWork ?? { computePasses: 1, dispatches: 1 });
    capture.make_side_effect();
    previousPass = capture;
  }
  mutable.finalOutput ??= mutable.hdr;
  if (previousPass !== null) previousPass.make_side_effect();
  return Object.freeze(mutable);
}

function requiredOutputMask(
  snapshot: Readonly<GpuShadingPublicationSnapshot>,
  features: Readonly<SparseShadingCandidateFeatureInput>
): number {
  const lit = snapshot.summary.opaqueLitReceiverCount > 0;
  let mask = 0;
  if (lit && (features.screenSpaceDiffuseMode !== "off" || features.ssr || features.temporal)) {
    mask |= GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite;
  }
  if (lit && features.screenSpaceDiffuseMode === "ssgi") {
    mask |= GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite;
  }
  if ((snapshot.summary.opaqueLitReceiverCount + snapshot.summary.opaqueUnlitReceiverCount) > 0 &&
      features.temporal) {
    mask |= GPU_SHADING_OUTPUT_DEPENDENCY.Velocity;
  }
  return mask;
}

function historyForStage(
  plan: Readonly<SparseShadingCandidatePlan>,
  external: Readonly<SparseShadingCandidateExternalResources>,
  stage: SparseShadingCandidateStage
): Readonly<{ input: ResourceId; output: ResourceId }> | null {
  if (!isHistoryStage(stage)) return null;
  const name = `${stage === "temporal" ? "temporal-color" : stage}-history`;
  if (!plan.histories.includes(name)) return null;
  const history = external.histories?.[stage];
  if (history === undefined) {
    throw new Error(`Sparse shading candidate is missing ${name} resources`);
  }
  return history;
}

function isHistoryStage(stage: SparseShadingCandidateStage): stage is SparseShadingCandidateHistoryStage {
  return stage === "gtao" || stage === "ssgi" || stage === "ssr" || stage === "temporal";
}

function memoryRecord(
  sizing: Readonly<GpuShadingBinSizing>,
  outputBytes: number,
  diagnosticsBytes: number
): SparseShadingCandidatePlan["memory"] {
  const visibilityKeyBytes = sizing.width * sizing.height * 4;
  const shadingBinIdBytes = sizing.width * sizing.height;
  const depthBytes = sizing.width * sizing.height * 4;
  const settingsBytes = 256;
  const totalBytes = visibilityKeyBytes + shadingBinIdBytes + depthBytes + sizing.heapBytes +
    GPU_SHADING_BIN_INDIRECT_BYTES + settingsBytes + outputBytes + diagnosticsBytes;
  return Object.freeze({
    visibilityKeyBytes,
    shadingBinIdBytes,
    depthBytes,
    heapBytes: sizing.heapBytes,
    indirectBytes: GPU_SHADING_BIN_INDIRECT_BYTES,
    settingsBytes,
    outputBytes,
    diagnosticsBytes,
    totalBytes
  });
}

function emptyMemoryRecord(): SparseShadingCandidatePlan["memory"] {
  return Object.freeze({
    visibilityKeyBytes: 0,
    shadingBinIdBytes: 0,
    depthBytes: 0,
    heapBytes: 0,
    indirectBytes: 0,
    settingsBytes: 0,
    outputBytes: 0,
    diagnosticsBytes: 0,
    totalBytes: 0
  });
}

function sparseOutputBytes(width: number, height: number, mask: number): number {
  let bytesPerPixel = 8;
  if ((mask & GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite) !== 0) bytesPerPixel += 8;
  if ((mask & (GPU_SHADING_OUTPUT_DEPENDENCY.ShadingSurfaceLite |
      GPU_SHADING_OUTPUT_DEPENDENCY.DiffuseSurfaceLite)) !== 0) bytesPerPixel += 12;
  if ((mask & GPU_SHADING_OUTPUT_DEPENDENCY.Velocity) !== 0) bytesPerPixel += 4;
  return width * height * bytesPerPixel;
}

function texture(
  plan: Readonly<SparseShadingCandidatePlan>,
  format: GPUTextureFormat,
  usage: GPUTextureUsageFlags
) {
  return {
    kind: "transient_texture" as const,
    width: plan.width,
    height: plan.height,
    depthOrArrayLayers: 1,
    format,
    usage,
    domain: "internal-full" as const
  };
}

function buffer(size: number, usage: GPUBufferUsageFlags) {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new RangeError("Sparse shading candidate buffer size is invalid");
  }
  return { kind: "transient_buffer" as const, size, usage };
}

function cloneMutableFrame(
  source: Readonly<SparseShadingCandidateFrame>
): { -readonly [K in keyof SparseShadingCandidateFrame]: SparseShadingCandidateFrame[K] } {
  return { ...source };
}
