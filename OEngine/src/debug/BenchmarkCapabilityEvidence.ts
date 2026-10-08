import { GPU_COUNTER_FIELDS, type GpuCounterFieldName } from "./GpuFrameCounters.js";

export const BENCHMARK_CAPABILITY_EVIDENCE_SCHEMA_VERSION = 3;

export type CapabilityEvidenceStatus = "supported" | "unsupported";

export interface SupportedCounterEvidence {
  status: "supported";
  /** Stable runtime GPU producer identity; never a planned or synthetic producer. */
  producer: string;
  requiredInSampledFrames: true;
}

export interface UnsupportedCounterEvidence {
  status: "unsupported";
  blockerTaskId: string;
  reason: string;
}

export type CounterEvidenceDeclaration = SupportedCounterEvidence | UnsupportedCounterEvidence;

export interface SupportedFeatureSetEvidence {
  status: "supported";
  requiredGpuCounters: GpuCounterFieldName[];
}

export interface UnsupportedFeatureSetEvidence {
  status: "unsupported";
  requiredGpuCounters: GpuCounterFieldName[];
  blockerTaskId: string;
  reason: string;
}

export type FeatureSetEvidenceDeclaration = SupportedFeatureSetEvidence | UnsupportedFeatureSetEvidence;

export interface BenchmarkCapabilityEvidence {
  schemaVersion: number;
  /** Exact declarations for environment.run.featureSet, not a list of requested future features. */
  featureSets: Record<string, FeatureSetEvidenceDeclaration>;
  /** Complete declaration of every field in the fixed GPU counter ABI. */
  gpuCounters: Record<GpuCounterFieldName, CounterEvidenceDeclaration>;
}

/**
 * Frozen R0 feature-to-evidence contract.
 *
 * A supported feature may still reference an unsupported counter. That means
 * the runtime algorithm exists, but its evidence producer is a tracked R0
 * blocker. An unsupported feature is a later-stage product capability and is
 * not required to emit its future counters yet.
 */
export const BENCHMARK_FEATURE_SET_EVIDENCE = {
  "graphics-update-observability-smoke": {
    status: "supported",
    requiredGpuCounters: []
  },
  "hardware-visibility": {
    status: "supported",
    requiredGpuCounters: [
      "candidateInstances",
      "visibleInstances",
      "visitedBvhNodes",
      "candidateClusters",
      "selectedClusters",
      "rejectedFrustum",
      "geometryMeshletWorksProduced",
      "geometryRasterTriangles",
      "shadedPixels",
      "emptyVisibilityPixels",
      "invalidVisibilityKeys",
      "queueOverflowMask"
    ]
  },
  "hzb-culling": {
    status: "supported",
    requiredGpuCounters: ["rejectedHzb"]
  },
  "cone-culling": {
    status: "supported",
    requiredGpuCounters: ["rejectedCone"]
  },
  "single-material-resolve": {
    status: "supported",
    requiredGpuCounters: [
      "activeMaterials",
      "invalidVisibilityKeys",
      "gradientFallbackPixels",
      "reactiveSurfacePixels",
      "normalTexturePixels",
      "ormTexturePixels",
      "emissiveTexturePixels",
      "unlitSurfacePixels",
      "queueOverflowMask"
    ]
  },
  "triangle-setup-candidate-cache": {
    status: "unsupported",
    requiredGpuCounters: [],
    blockerTaskId: "SURFACE-REBUILD-03",
    reason:
      "旧 triangle setup cache producer 已从唯一 Surface 生产路径移除；新的 Appearance/geometry 主链尚未提供等价证据 producer"
  },
  "clustered-lighting": {
    status: "supported",
    requiredGpuCounters: ["localLightAdmitted", "localLightFlags", "localLightIndicesWritten"]
  },
  ibl: {
    status: "supported",
    requiredGpuCounters: [
      "iblSampledPixels",
      "iblMip0",
      "iblMip1",
      "iblMip2",
      "iblMip3",
      "iblMip4",
      "iblMip5",
      "iblMip6",
      "iblMip7",
      "iblMip8"
    ]
  },
  "packed-csm-shadow": {
    status: "supported",
    requiredGpuCounters: [
      "shadowCascade0RasterWork",
      "shadowCascade1RasterWork",
      "shadowCascade2RasterWork",
      "shadowAtlasPixelsUpdated",
      "shadowAlphaRasterWork",
      "shadowQueueOverflowMask"
    ]
  },
  "packed-mboit-transparency": {
    status: "supported",
    requiredGpuCounters: [
      "transparentRasterWork",
      "transparentTriangles",
      "transparentReactivePixels",
      "transparentMomentFiniteFailures",
      "transparentQueueOverflowMask"
    ]
  },
  temporal: {
    status: "supported",
    requiredGpuCounters: [
      "temporalReactivePixels",
      "temporalDisoccludedPixels",
      "temporalHistoryRejectedPixels"
    ]
  },
  gtao: {
    status: "supported",
    requiredGpuCounters: ["aoEvaluatedPixels", "aoHistoryAcceptedPixels", "aoHistoryRejectedPixels"]
  },
  ssr: {
    status: "supported",
    requiredGpuCounters: ["ssrTracePixels", "ssrHitPixels", "ssrTraceSteps", "ssrMaxTraceSteps"]
  },
  bloom: {
    status: "supported",
    requiredGpuCounters: []
  },
  "automatic-exposure": {
    status: "supported",
    requiredGpuCounters: []
  },
  "motion-blur": {
    status: "supported",
    requiredGpuCounters: []
  },
  sharpening: {
    status: "supported",
    requiredGpuCounters: []
  },
  "packed-instances": {
    status: "supported",
    requiredGpuCounters: ["candidateInstances", "visibleInstances", "rejectedFrustum", "queueOverflowMask"]
  },
  "hierarchy-sse-lod": {
    status: "supported",
    requiredGpuCounters: [
      "candidateInstances",
      "visibleInstances",
      "candidateClusters",
      "selectedClusters",
      "rejectedFrustum",
      "geometryMeshletWorksProduced",
      "geometryRasterTriangles",
      "rootStageQueueReservations",
      "traversalQueueReservations",
      "workGenerationDispatchUpdates",
      "workGenerationCasRetries",
      "queueOverflowMask"
    ]
  },
  "software-visibility": {
    status: "unsupported",
    requiredGpuCounters: ["swClusters", "swTriangles", "shadedPixels", "emptyVisibilityPixels"],
    blockerTaskId: "VIS-05",
    reason: "Compute software raster 尚未接入 GPU work queue 和统一 Visibility 主链"
  }
} as const satisfies Record<string, FeatureSetEvidenceDeclaration>;

export type BenchmarkFeatureSetName = keyof typeof BENCHMARK_FEATURE_SET_EVIDENCE;

/** Frozen producer truth for Result Schema v3. */
export const BENCHMARK_GPU_COUNTER_EVIDENCE = {
  candidateInstances: supported("VisibilityPass or HierarchicalWorkGenerator/instance reducer"),
  visibleInstances: supported("VisibilityPass or HierarchicalWorkGenerator/root reducer"),
  visitedBvhNodes: supported("HierarchicalWorkGenerator/consumed traversal queue reducer"),
  candidateClusters: supported("HierarchicalWorkGenerator/consumed traversal queue reducer"),
  selectedClusters: supported("HierarchicalWorkGenerator/VisibleCluster reducer"),
  rejectedFrustum: supported("HierarchicalWorkGenerator/instance frustum reducer"),
  rejectedCone: supported("HierarchicalWorkGenerator/Cluster cone reject branch"),
  rejectedHzb: supported("HierarchicalWorkGenerator/previous-HZB reject branch"),
  swClusters: unsupported("VIS-05", "主链没有 Compute software raster cluster queue producer"),
  swTriangles: unsupported("VIS-05", "主链没有 Compute software raster triangle producer"),
  shadedPixels: supported("VisibilityCounterPass/final-visibility reducer"),
  emptyVisibilityPixels: supported("VisibilityCounterPass/final-visibility reducer"),
  invalidVisibilityKeys: supported("VisibilityCounterPass/direct VisibilityKey reserved-key reducer"),
  activeMaterials: supported("Material Resolve/active MaterialRecord counter"),
  queueOverflowMask: supported("Renderer/registered-GPU-list overflow reducers"),
  rootStageQueueReservations: supported("HierarchicalWorkGenerator/fused-root workgroup reservation reducer"),
  traversalQueueReservations: supported("HierarchicalWorkGenerator/post-root workgroup reservation reducer"),
  workGenerationDispatchUpdates: supported(
    "HierarchicalWorkGenerator/workgroup dispatch publication reducer"
  ),
  workGenerationCasRetries: supported("HierarchicalWorkGenerator/bounded reservation CAS retry reducer"),
  gradientFallbackPixels: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  reactiveSurfacePixels: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  normalTexturePixels: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  ormTexturePixels: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  emissiveTexturePixels: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  unlitSurfacePixels: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  localLightAbi: supported("LocalLightWork/finalized header sampled copy"),
  localLightMode: supported("LocalLightWork/finalized header sampled copy"),
  localLightFlags: supported("LocalLightWork/finalized header sampled copy"),
  localLightEpoch: supported("LocalLightWork/finalized header sampled copy"),
  localLightFrame: supported("LocalLightWork/finalized header sampled copy"),
  localLightPublication: supported("LocalLightWork/finalized header sampled copy"),
  localLightAdmitted: supported("LocalLightWork/finalized header sampled copy"),
  localLightAllOffset: supported("LocalLightWork/finalized header sampled copy"),
  localLightGlobalCount: supported("LocalLightWork/finalized header sampled copy"),
  localLightGlobalOffset: supported("LocalLightWork/finalized header sampled copy"),
  localLightClusters: supported("LocalLightWork/finalized header sampled copy"),
  localLightIndexCapacity: supported("LocalLightWork/finalized header sampled copy"),
  localLightIndicesOffset: supported("LocalLightWork/finalized header sampled copy"),
  localLightIndicesWritten: supported("LocalLightWork/finalized header sampled copy"),
  localLightRegionTasks: supported("LocalLightWork/finalized header sampled copy"),
  localLightTaskBudget: supported("LocalLightWork/finalized header sampled copy"),
  iblSampledPixels: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  iblMip0: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  iblMip1: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  iblMip2: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  iblMip3: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  iblMip4: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  iblMip5: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  iblMip6: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  iblMip7: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  iblMip8: unsupported("V4-S3", "Retired Surface reducer; no native counter producer"),
  shadowCascade0RasterWork: supported("PackedCsmShadowPass/cascade-0 queue reducer"),
  shadowCascade1RasterWork: supported("PackedCsmShadowPass/cascade-1 queue reducer"),
  shadowCascade2RasterWork: supported("PackedCsmShadowPass/cascade-2 queue reducer"),
  shadowAtlasPixelsUpdated: supported("PackedCsmShadowPass/atlas update reducer"),
  shadowAlphaRasterWork: supported("PackedCsmShadowPass/alpha flag reducer"),
  shadowQueueOverflowMask: supported("PackedCsmShadowPass/per-cascade overflow reducer"),
  transparentRasterWork: unsupported(
    "L3.2",
    "Unreachable legacy transparent owner retired; no production counter producer"
  ),
  transparentTriangles: unsupported(
    "L3.2",
    "Unreachable legacy transparent owner retired; no production counter producer"
  ),
  transparentReactivePixels: unsupported(
    "L3.2",
    "Unreachable legacy transparent owner retired; no production counter producer"
  ),
  transparentMomentFiniteFailures: unsupported(
    "L3.2",
    "Unreachable legacy transparent owner retired; no production counter producer"
  ),
  transparentQueueOverflowMask: unsupported(
    "L3.2",
    "Unreachable legacy transparent owner retired; no production counter producer"
  ),
  temporalReactivePixels: supported("TemporalClassificationPass/reactive reducer"),
  temporalDisoccludedPixels: supported("TemporalClassificationPass/disocclusion reducer"),
  temporalHistoryRejectedPixels: supported("TemporalClassificationPass/history rejection reducer"),
  aoEvaluatedPixels: supported("GtaoPass/Q00 sampled temporal evidence reducer"),
  aoHistoryAcceptedPixels: supported("GtaoPass/Q00 sampled temporal evidence reducer"),
  aoHistoryRejectedPixels: supported("GtaoPass/Q00 sampled temporal evidence reducer"),
  ssrTracePixels: supported("Three-derived ScreenSpaceReflectionsPass/HZB trace evidence reducer"),
  ssrHitPixels: supported("Three-derived ScreenSpaceReflectionsPass/HZB trace evidence reducer"),
  ssrTraceSteps: supported("Three-derived ScreenSpaceReflectionsPass/HZB trace evidence reducer"),
  ssrMaxTraceSteps: supported("Three-derived ScreenSpaceReflectionsPass/HZB trace evidence reducer"),
  ssrRoughnessRejectedPixels: supported(
    "Three-derived ScreenSpaceReflectionsPass/HZB trace evidence reducer"
  ),
  ssrDistanceRejectedPixels: supported("Three-derived ScreenSpaceReflectionsPass/HZB trace evidence reducer"),
  ssrHighRoughnessTracePixels: supported(
    "Three-derived ScreenSpaceReflectionsPass/HZB trace evidence reducer"
  ),
  ssrDistanceLimitExceededPixels: supported(
    "Three-derived ScreenSpaceReflectionsPass/HZB trace evidence reducer"
  ),
  ssrValidationRejectedPixels: supported(
    "Three-derived ScreenSpaceReflectionsPass/HZB trace evidence reducer"
  ),
  ssgiEvaluatedPixels: supported("Three-derived SsgiPass/trace evidence reducer"),
  ssgiTraceSamples: supported("Three-derived SsgiPass/trace evidence reducer"),
  ssgiHistoryAcceptedPixels: supported("Three-derived SsgiPass/temporal evidence reducer"),
  ssgiHistoryRejectedPixels: supported("Three-derived SsgiPass/temporal evidence reducer"),
  geometryNodesTested: supported("HierarchicalWorkGenerator hierarchy test reducer"),
  geometryClustersAccepted: supported("HierarchicalWorkGenerator accepted-cluster reducer"),
  geometryMeshletsSelected: supported("HierarchicalWorkGenerator selected-meshlet reducer"),
  geometryMeshletWorksProduced: supported("ADR-0008 MeshletRasterWork producer reducer"),
  geometryCandidateTriangles: supported("MeshletWorkCandidate triangle-count reducer"),
  geometryRiskyTriangles: supported("ADR-0008 selective-risk classifier reducer"),
  geometryExactSurvivedTriangles: supported("selective-risk route conservative survivor reducer"),
  geometryRasterTriangles: supported("hardware visibility submitted-triangle reducer"),
  geometryPaddedVertices: supported("ADR-0008 bucket raster padding reducer"),
  geometryVisiblePixels: supported("VisibilityCounterPass valid-key reducer"),
  geometryQueueBytes: supported("geometry queue producer byte reducer"),
  meshletQueueAttempted: supported("MeshletWorkCandidate attempted-count publisher"),
  meshletQueueWritten: supported("MeshletWorkCandidate written-count publisher"),
  meshletQueueConsumed: supported("MeshletWorkCandidate GPU validator/raster consumer publisher"),
  meshletQueueOverflow: supported("MeshletWorkCandidate correctness-critical overflow publisher"),
  meshletQueueInvalid: supported("MeshletWorkCandidate GPU identity/generation validator"),
  meshletBucketNonEmpty: supported("MeshletWork GPU bucket histogram/prefix publisher"),
  meshletBucketDraws: supported("MeshletWork fixed bounded GPU drawIndirect publisher"),
  meshletSubgroupReservations: supported("MeshletWork subgroup ballot/prefix compaction specialization"),
  meshletPortableReservations: supported("MeshletWork portable workgroup shared-memory prefix fallback"),
  meshletIndirectInstances: supported("MeshletWork GPU-generated bucket drawIndirect records"),
  meshletRasterTriangles: supported("MeshletWork bucket drawIndirect triangle reducer"),
  longRangeBrick4Receivers: supported("LongRangeDiffuseProviderPass/receiver provider-selection reducer"),
  longRangeProbeReceivers: supported("LongRangeDiffuseProviderPass/receiver provider-selection reducer"),
  longRangeIblReceivers: supported("LongRangeDiffuseProviderPass/receiver provider-selection reducer"),
  longRangeBlackReceivers: supported("LongRangeDiffuseProviderPass/receiver provider-selection reducer"),
  longRangeInvalidGeneration: supported("LongRangeDiffuseProviderPass/generation-validity reducer"),
  longRangeNonresidentFallbacks: supported("LongRangeDiffuseProviderPass/residency-fallback reducer"),
  longRangeProviderUnassigned: supported("LongRangeDiffuseProviderPass/provider-identity validator"),
  longRangeProviderDuplicates: supported("LongRangeDiffuseProviderPass/provider-identity validator")
} as const satisfies Record<GpuCounterFieldName, CounterEvidenceDeclaration>;

export function createBenchmarkCapabilityEvidence(featureSet: Iterable<string>): BenchmarkCapabilityEvidence {
  const featureSets: Record<string, FeatureSetEvidenceDeclaration> = {};
  for (const name of [...new Set(featureSet)].sort((a, b) => a.localeCompare(b))) {
    const declaration = BENCHMARK_FEATURE_SET_EVIDENCE[name as BenchmarkFeatureSetName];
    if (declaration === undefined) {
      throw new RangeError(
        `Unknown benchmark feature set '${name}'; register its evidence contract before sampling`
      );
    }
    featureSets[name] = cloneDeclaration(declaration);
  }

  const gpuCounters = {} as Record<GpuCounterFieldName, CounterEvidenceDeclaration>;
  for (const field of GPU_COUNTER_FIELDS) {
    gpuCounters[field.name] = cloneDeclaration(BENCHMARK_GPU_COUNTER_EVIDENCE[field.name]);
  }
  return {
    schemaVersion: BENCHMARK_CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    featureSets,
    gpuCounters
  };
}

function supported(producer: string): SupportedCounterEvidence {
  return { status: "supported", producer, requiredInSampledFrames: true };
}

function unsupported(blockerTaskId: string, reason: string): UnsupportedCounterEvidence {
  return { status: "unsupported", blockerTaskId, reason };
}

function cloneDeclaration<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
