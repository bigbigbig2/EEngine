import {
  GPU_COUNTER_FIELDS,
  type GpuCounterFieldName
} from "./GpuFrameCounters.js";

export const BENCHMARK_CAPABILITY_EVIDENCE_SCHEMA_VERSION = 2;

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
      "candidateClusters",
      "selectedClusters",
      "rejectedFrustum",
      "hwClusters",
      "alphaClusters",
      "hwTriangles",
      "shadedPixels",
      "emptyVisibilityPixels",
      "queueOverflowMask"
    ]
  },
  "hzb-culling": {
    status: "supported",
    requiredGpuCounters: ["rejectedHzb"]
  },
  "cone-culling": {
    status: "unsupported",
    requiredGpuCounters: ["rejectedCone"],
    blockerTaskId: "WORK-04",
    reason: "主链尚未实现独立的 Meshlet normal-cone/backface culling stage"
  },
  "material-expand": {
    status: "supported",
    requiredGpuCounters: ["activeMaterials"]
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
    status: "unsupported",
    requiredGpuCounters: [
      "visitedBvhNodes",
      "candidateClusters",
      "selectedClusters",
      "rejectedFrustum",
      "rejectedCone",
      "rejectedHzb",
      "queueOverflowMask"
    ],
    blockerTaskId: "WORK-04",
    reason: "主链尚未实现 BVH8/Hierarchy wavefront 与 SSE LOD traversal"
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
  candidateInstances: supported("VisibilityPass/scene-frustum-list reducer"),
  visibleInstances: supported("VisibilityPass/scene-frustum-list reducer"),
  visitedBvhNodes: unsupported(
    "WORK-04",
    "主链没有 BVH8/Hierarchy traversal producer"
  ),
  candidateClusters: supported("VisibilityPass/meshlet-list reducer"),
  selectedClusters: supported("VisibilityPass/raster-work-list reducer"),
  rejectedFrustum: supported("VisibilityPass/scene-frustum-list reducer"),
  rejectedCone: unsupported(
    "WORK-04",
    "主链尚未实现独立的 Meshlet normal-cone/backface culling stage"
  ),
  rejectedHzb: supported("MeshletDrawList/HZB depth-query reject branches"),
  swClusters: unsupported(
    "VIS-05",
    "主链没有 Compute software raster cluster queue producer"
  ),
  hwClusters: supported("VisibilityPass/hardware-raster-list reducer"),
  alphaClusters: supported("VisibilityPass/alpha-raster-list reducer"),
  swTriangles: unsupported(
    "VIS-05",
    "主链没有 Compute software raster triangle producer"
  ),
  hwTriangles: supported("VisibilityPass/hardware-raster-list reducer"),
  shadedPixels: supported("VisibilityCounterPass/final-visibility reducer"),
  emptyVisibilityPixels: supported("VisibilityCounterPass/final-visibility reducer"),
  activeMaterials: supported("MaterialExpandPass/encoded-draw counter"),
  activeLights: supported("Renderer/active-light-list reducer"),
  queueOverflowMask: supported("Renderer/registered-GPU-list overflow reducers")
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
