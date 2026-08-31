import {
  GPU_COUNTER_FIELDS,
  type GpuCounterFieldName
} from "./GpuFrameCounters.js";

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

export type CounterEvidenceDeclaration =
  | SupportedCounterEvidence
  | UnsupportedCounterEvidence;

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

export type FeatureSetEvidenceDeclaration =
  | SupportedFeatureSetEvidence
  | UnsupportedFeatureSetEvidence;

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
      "hwClusters",
      "alphaClusters",
      "hwTriangles",
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
  "material-expand": {
    status: "supported",
    requiredGpuCounters: ["activeMaterials"]
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
  "clustered-lighting": {
    status: "supported",
    requiredGpuCounters: ["activeLights", "queueOverflowMask"]
  },
  ibl: {
    status: "supported",
    requiredGpuCounters: [
      "iblSampledPixels", "iblMip0", "iblMip1", "iblMip2", "iblMip3",
      "iblMip4", "iblMip5", "iblMip6", "iblMip7", "iblMip8"
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
  "packed-instances": {
    status: "supported",
    requiredGpuCounters: [
      "candidateInstances",
      "visibleInstances",
      "rejectedFrustum",
      "queueOverflowMask"
    ]
  },
  "hierarchy-sse-lod": {
    status: "supported",
    requiredGpuCounters: [
      "candidateInstances",
      "visibleInstances",
      "candidateClusters",
      "selectedClusters",
      "rejectedFrustum",
      "hwClusters",
      "hwTriangles",
      "rootStageQueueReservations",
      "traversalQueueReservations",
      "workGenerationDispatchUpdates",
      "workGenerationCasRetries",
      "queueOverflowMask"
    ]
  },
  "software-visibility": {
    status: "unsupported",
    requiredGpuCounters: [
      "swClusters",
      "swTriangles",
      "shadedPixels",
      "emptyVisibilityPixels"
    ],
    blockerTaskId: "VIS-05",
    reason: "Compute software raster 尚未接入 GPU work queue 和统一 Visibility 主链"
  }
} as const satisfies Record<string, FeatureSetEvidenceDeclaration>;

export type BenchmarkFeatureSetName = keyof typeof BENCHMARK_FEATURE_SET_EVIDENCE;

/** Frozen producer truth for Result Schema v3. */
export const BENCHMARK_GPU_COUNTER_EVIDENCE = {
  candidateInstances: supported(
    "VisibilityPass or HierarchicalWorkGenerator/instance reducer"
  ),
  visibleInstances: supported(
    "VisibilityPass or HierarchicalWorkGenerator/root reducer"
  ),
  visitedBvhNodes: supported(
    "HierarchicalWorkGenerator/consumed traversal queue reducer"
  ),
  candidateClusters: supported(
    "MeshletDrawList legacy reducer or HierarchicalWorkGenerator/consumed traversal queue reducer"
  ),
  selectedClusters: supported(
    "HierarchicalWorkGenerator/VisibleCluster reducer"
  ),
  rejectedFrustum: supported(
    "VisibilityPass or HierarchicalWorkGenerator/instance frustum reducer"
  ),
  rejectedCone: supported("HierarchicalWorkGenerator/Cluster cone reject branch"),
  rejectedHzb: supported(
    "MeshletDrawList or HierarchicalWorkGenerator/previous-HZB reject branch"
  ),
  swClusters: unsupported(
    "VIS-05",
    "主链没有 Compute software raster cluster queue producer"
  ),
  hwClusters: supported(
    "Packed Hardware Visibility RasterWork reducer"
  ),
  alphaClusters: supported(
    "VisibilityPass legacy alpha list or Packed RasterWork material reducer"
  ),
  swTriangles: unsupported(
    "VIS-05",
    "主链没有 Compute software raster triangle producer"
  ),
  hwTriangles: supported("Packed Hardware Visibility fixed-384 submission reducer"),
  shadedPixels: supported("VisibilityCounterPass/final-visibility reducer"),
  emptyVisibilityPixels: supported("VisibilityCounterPass/final-visibility reducer"),
  invalidVisibilityKeys: supported(
    "VisibilityCounterPass/VisibilityKey v1 reserved-slot reducer"
  ),
  activeMaterials: supported("Material Resolve/active MaterialRecord counter"),
  activeLights: supported("Renderer/active-light-list reducer"),
  queueOverflowMask: supported("Renderer/registered-GPU-list overflow reducers"),
  rootStageQueueReservations: supported(
    "HierarchicalWorkGenerator/fused-root workgroup reservation reducer"
  ),
  traversalQueueReservations: supported(
    "HierarchicalWorkGenerator/post-root workgroup reservation reducer"
  ),
  workGenerationDispatchUpdates: supported(
    "HierarchicalWorkGenerator/workgroup dispatch publication reducer"
  ),
  workGenerationCasRetries: supported(
    "HierarchicalWorkGenerator/bounded reservation CAS retry reducer"
  ),
  gradientFallbackPixels: supported(
    "PackedSurfaceCounterPass/Surface flags reducer"
  ),
  reactiveSurfacePixels: supported(
    "PackedSurfaceCounterPass/Surface flags reducer"
  ),
  normalTexturePixels: supported(
    "PackedSurfaceCounterPass/Surface material-feature reducer"
  ),
  ormTexturePixels: supported(
    "PackedSurfaceCounterPass/Surface material-feature reducer"
  ),
  emissiveTexturePixels: supported(
    "PackedSurfaceCounterPass/Surface material-feature reducer"
  ),
  unlitSurfacePixels: supported(
    "PackedSurfaceCounterPass/Surface material-feature reducer"
  ),
  candidateLightsAttempted: supported("LightClusterPass/FX-02 bounded-list reducer"),
  candidateLightsWritten: supported("LightClusterPass/FX-02 bounded-list reducer"),
  activeLightsAttempted: supported("LightClusterPass/FX-02 bounded-list reducer"),
  clusterTestedLights: supported("LightClusterPass/FX-02 cluster statistics reducer"),
  clusterLightIndicesAttempted: supported("LightClusterPass/FX-02 cluster-data reducer"),
  clusterLightIndicesWritten: supported("LightClusterPass/FX-02 cluster-data reducer"),
  clusterOverflowClusters: supported("LightClusterPass/FX-02 cluster statistics reducer"),
  clusterFallbackLights: supported("LightClusterPass/FX-02 cluster statistics reducer"),
  clusterLightReferences: supported("LightClusterPass/FX-02 cluster statistics reducer"),
  clusterMaxLights: supported("LightClusterPass/FX-02 cluster statistics reducer"),
  clusterHistogram0: supported("LightClusterPass/FX-02 cluster histogram reducer"),
  clusterHistogram1: supported("LightClusterPass/FX-02 cluster histogram reducer"),
  clusterHistogram4: supported("LightClusterPass/FX-02 cluster histogram reducer"),
  clusterHistogram8: supported("LightClusterPass/FX-02 cluster histogram reducer"),
  clusterHistogram16: supported("LightClusterPass/FX-02 cluster histogram reducer"),
  clusterHistogram32: supported("LightClusterPass/FX-02 cluster histogram reducer"),
  clusterHistogram64: supported("LightClusterPass/FX-02 cluster histogram reducer"),
  clusterHistogram128: supported("LightClusterPass/FX-02 cluster histogram reducer"),
  clusterHistogram256: supported("LightClusterPass/FX-02 cluster histogram reducer"),
  iblSampledPixels: supported("PackedSurfaceCounterPass/FX-03 IBL mip reducer"),
  iblMip0: supported("PackedSurfaceCounterPass/FX-03 IBL mip histogram"),
  iblMip1: supported("PackedSurfaceCounterPass/FX-03 IBL mip histogram"),
  iblMip2: supported("PackedSurfaceCounterPass/FX-03 IBL mip histogram"),
  iblMip3: supported("PackedSurfaceCounterPass/FX-03 IBL mip histogram"),
  iblMip4: supported("PackedSurfaceCounterPass/FX-03 IBL mip histogram"),
  iblMip5: supported("PackedSurfaceCounterPass/FX-03 IBL mip histogram"),
  iblMip6: supported("PackedSurfaceCounterPass/FX-03 IBL mip histogram"),
  iblMip7: supported("PackedSurfaceCounterPass/FX-03 IBL mip histogram"),
  iblMip8: supported("PackedSurfaceCounterPass/FX-03 IBL mip histogram overflow bin"),
  shadowCascade0RasterWork: supported("PackedCsmShadowPass/cascade-0 queue reducer"),
  shadowCascade1RasterWork: supported("PackedCsmShadowPass/cascade-1 queue reducer"),
  shadowCascade2RasterWork: supported("PackedCsmShadowPass/cascade-2 queue reducer"),
  shadowAtlasPixelsUpdated: supported("PackedCsmShadowPass/atlas update reducer"),
  shadowAlphaRasterWork: supported("PackedCsmShadowPass/alpha flag reducer"),
  shadowQueueOverflowMask: supported("PackedCsmShadowPass/per-cascade overflow reducer")
} as const satisfies Record<GpuCounterFieldName, CounterEvidenceDeclaration>;

export function createBenchmarkCapabilityEvidence(
  featureSet: Iterable<string>
): BenchmarkCapabilityEvidence {
  const featureSets: Record<string, FeatureSetEvidenceDeclaration> = {};
  for (const name of [...new Set(featureSet)].sort((a, b) => a.localeCompare(b))) {
    const declaration = BENCHMARK_FEATURE_SET_EVIDENCE[
      name as BenchmarkFeatureSetName
    ];
    if (declaration === undefined) {
      throw new RangeError(
        `Unknown benchmark feature set '${name}'; register its evidence contract before sampling`
      );
    }
    featureSets[name] = cloneDeclaration(declaration);
  }

  const gpuCounters = {} as Record<
    GpuCounterFieldName,
    CounterEvidenceDeclaration
  >;
  for (const field of GPU_COUNTER_FIELDS) {
    gpuCounters[field.name] = cloneDeclaration(
      BENCHMARK_GPU_COUNTER_EVIDENCE[field.name]
    );
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

function unsupported(
  blockerTaskId: string,
  reason: string
): UnsupportedCounterEvidence {
  return { status: "unsupported", blockerTaskId, reason };
}

function cloneDeclaration<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
