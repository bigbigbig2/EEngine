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
    requiredGpuCounters: []
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
  )
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
