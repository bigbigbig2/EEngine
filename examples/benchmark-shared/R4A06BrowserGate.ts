import type {
  BenchmarkEvidenceReport,
  BenchmarkResult,
  BenchmarkSceneManifest,
  FrameProfilerDiagnostics,
  RenderDebugViewName
} from "../../OEngine/src/index.ts";

export const R4_A_06_GATE_SCHEMA_VERSION = 1;

export const R4_A_06_CAPTURE_VIEWS = [
  "oracle",
  "visibility-key",
  "depth"
] as const;

export type R4A06CaptureView = (typeof R4_A_06_CAPTURE_VIEWS)[number];

export interface R4A06CaptureState {
  view: R4A06CaptureView;
  renderDebugView: RenderDebugViewName;
  frameOrdinal: number;
  canvasWidth: number;
  canvasHeight: number;
  diagnostics: FrameProfilerDiagnostics;
}

export interface R4A06GateArtifact {
  schemaVersion: number;
  taskId: "R4-A-06";
  caseId: BenchmarkSceneManifest["id"];
  profile: "full" | "smoke";
  passed: boolean;
  issues: string[];
  pairing: {
    oracle: "existing-material-resolve-final-color";
    producer: "hardware-packed-r4-visibility-key-v1";
    sameRenderer: true;
    sameSceneState: true;
    currentFrameVisibilityCountReadback: false;
  };
  screenshots: readonly R4A06CaptureView[];
  fragmentStatistics: {
    submittedFragments: {
      status: "unsupported";
      gateBlocking: false;
      reason: string;
    };
    usefulFragments: {
      status: "supported";
      counter: "shadedPixels";
    };
  };
  evidence: BenchmarkEvidenceReport;
  counterIssues: string[];
  result: BenchmarkResult;
}

export function createR4A06GateArtifact(
  manifest: BenchmarkSceneManifest,
  profile: "full" | "smoke",
  result: BenchmarkResult,
  evidence: BenchmarkEvidenceReport,
  counterIssues: readonly string[]
): R4A06GateArtifact {
  const issues = validateR4A06Gate(
    manifest,
    profile,
    result,
    evidence,
    counterIssues
  );
  return {
    schemaVersion: R4_A_06_GATE_SCHEMA_VERSION,
    taskId: "R4-A-06",
    caseId: manifest.id,
    profile,
    passed: issues.length === 0,
    issues,
    pairing: {
      oracle: "existing-material-resolve-final-color",
      producer: "hardware-packed-r4-visibility-key-v1",
      sameRenderer: true,
      sameSceneState: true,
      currentFrameVisibilityCountReadback: false
    },
    screenshots: R4_A_06_CAPTURE_VIEWS,
    fragmentStatistics: {
      submittedFragments: {
        status: "unsupported",
        gateBlocking: false,
        reason: "WebGPU baseline exposes no negotiated pipeline-statistics producer"
      },
      usefulFragments: {
        status: "supported",
        counter: "shadedPixels"
      }
    },
    evidence,
    counterIssues: [...counterIssues],
    result
  };
}

function validateR4A06Gate(
  manifest: BenchmarkSceneManifest,
  profile: "full" | "smoke",
  result: BenchmarkResult,
  evidence: BenchmarkEvidenceReport,
  counterIssues: readonly string[]
): string[] {
  const issues: string[] = [];
  const environment = result.environment;
  const expectedPixels = environment.frame.internalWidth * environment.frame.internalHeight;

  if (profile !== "full") issues.push("profile must be full");
  if (environment.engine.dirty) issues.push("engine provenance must be clean");
  if (!evidence.gateEligible) issues.push("benchmark evidence is not gate eligible");
  if (counterIssues.length > 0) issues.push(...counterIssues);
  if (
    environment.frame.canvasWidth !== manifest.frame.width ||
    environment.frame.canvasHeight !== manifest.frame.height ||
    environment.frame.dpr !== manifest.frame.dpr
  ) {
    issues.push("canvas resolution or DPR differs from the frozen manifest");
  }
  if (
    environment.run.warmupFrames !== manifest.run.warmupFrames ||
    environment.run.sampleFrames !== manifest.run.sampleFrames ||
    environment.run.gpuSampleInterval !== manifest.run.gpuSampleInterval ||
    environment.run.gpuCounterSampleInterval !== manifest.run.gpuCounterSampleInterval
  ) {
    issues.push("run cadence differs from the frozen manifest");
  }
  if (result.summary.submits.min !== 1 || result.summary.submits.max !== 1) {
    issues.push("steady frames must use exactly one submit");
  }
  if (result.summary.readbacks.min !== 0) {
    issues.push("non-sampled frames must retain zero readbacks");
  }
  if (result.summary.gpuPhaseMs["hardware-raster"] === undefined) {
    issues.push("hardware-raster GPU phase is missing");
  }
  if (!Object.keys(result.summary.gpuMs).some((label) =>
    /Packed VisibilityKey\/depth .*drawIndirect/.test(label)
  )) {
    issues.push("R4 Hardware Visibility timestamp label is missing");
  }

  let sampledCounters = 0;
  for (const frame of result.frames) {
    if (frame.counters["packed.visibility.drawIndirect"] !== 1) {
      issues.push(`frame ${frame.frameIndex}: Packed Visibility must use one drawIndirect`);
    }
    if (frame.counters["packed.visibility.keyAttachmentBytes"] !== expectedPixels * 4) {
      issues.push(`frame ${frame.frameIndex}: VisibilityKey attachment byte count mismatch`);
    }
    if (!frame.gpuCounters.sampled || frame.gpuCounters.dropped) continue;
    sampledCounters++;
    const counters = frame.gpuCounters.values;
    if (counters.invalidVisibilityKeys !== 0) {
      issues.push(`frame ${frame.frameIndex}: invalid VisibilityKey detected`);
    }
    if (counters.queueOverflowMask !== 0) {
      issues.push(`frame ${frame.frameIndex}: queue overflow detected`);
    }
    if (
      counters.shadedPixels === undefined ||
      counters.emptyVisibilityPixels === undefined ||
      counters.shadedPixels + counters.emptyVisibilityPixels !== expectedPixels
    ) {
      issues.push(`frame ${frame.frameIndex}: Visibility pixel partition mismatch`);
    }
    if (counters.hwClusters === undefined || counters.hwClusters === 0) {
      issues.push(`frame ${frame.frameIndex}: Hardware producer emitted no RasterWork`);
    }
    if (
      counters.hwClusters !== undefined &&
      counters.hwTriangles !== counters.hwClusters * 128
    ) {
      issues.push(`frame ${frame.frameIndex}: fixed Hardware triangle contract mismatch`);
    }
  }
  if (sampledCounters === 0) issues.push("no completed GPU counter samples");
  if (
    manifest.id === "C" &&
    (result.summary.gpuCounters.alphaClusters?.p50 ?? 0) <= 0
  ) {
    issues.push("C alpha-tested RasterWork producer was not observed");
  }
  appendDiagnostics(issues, result.diagnostics);
  return [...new Set(issues)];
}

function appendDiagnostics(
  issues: string[],
  diagnostics: FrameProfilerDiagnostics
): void {
  if (diagnostics.validationErrorCount !== 0) issues.push("WebGPU validation errors present");
  if (diagnostics.uncapturedErrorCount !== 0) issues.push("uncaptured WebGPU errors present");
  if (diagnostics.deviceLostCount !== 0) issues.push("device loss present");
  if (diagnostics.failedGpuTimestampBatches !== 0) issues.push("GPU timestamp failures present");
  if (diagnostics.droppedGpuCounterSamples !== 0) issues.push("dropped GPU counter samples present");
  if (diagnostics.failedGpuCounterSamples !== 0) issues.push("failed GPU counter samples present");
}
