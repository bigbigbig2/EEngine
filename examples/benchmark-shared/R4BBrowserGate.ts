import type {
  BenchmarkEvidenceReport,
  BenchmarkResult,
  BenchmarkSceneManifest,
  FrameProfilerDiagnostics
} from "../../OEngine/src/index.ts";

export const R4_B_GATE_SCHEMA_VERSION = 1;
export const R4_B_SURFACE_BYTES_PER_PIXEL = 26;
export const R4_B_RETIRED_MATERIAL_CHAIN_BYTES_PER_PIXEL = 34;
export const R4_B_MAX_REACTIVE_SURFACE_PIXELS = Object.freeze({
  A: 1,
  B: 0,
  C: 0
} as const);

export const R4_B_CAPTURE_VIEWS = [
  "final-color",
  "visibility-key",
  "depth",
  "material-id",
  "base-color",
  "shading-normal",
  "roughness",
  "metallic",
  "occlusion",
  "emissive",
  "velocity",
  "history-validity",
  "reactive"
] as const;

export interface R4BMaterialEvidence {
  schemaVersion: number;
  abiVersion: number;
  materialCapacity: number;
  textureCapacity: number;
  residentMaterialSlotCount: number;
  retiringMaterialSlotCount: number;
  freeMaterialSlotCount: number;
  residentTextureCount: number;
  retiringTextureCount: number;
  freeTextureLayerCount: number;
  textureFallbackCount: number;
  samplerFallbackCount: number;
  allocatedBytes: number;
  residentTextureBytes: number;
  textureSize: number;
  mipLevelCount: number;
  privateSubmitCount: number;
  takeoverTask: null;
}

export interface R4BGateArtifact {
  schemaVersion: number;
  taskId: "R4-B";
  caseId: BenchmarkSceneManifest["id"];
  profile: "full" | "smoke";
  passed: boolean;
  issues: string[];
  contract: {
    producer: "hardware-packed-r4-visibility-key-v1";
    consumer: "single-standard-pbr-material-resolve-v1";
    fullscreenDrawsPerFrame: 1;
    currentFrameVisibilityCountReadback: false;
    perMaterialBindGroups: false;
    packedVelocityPass: false;
  };
  attachments: {
    retiredMaterialChainBytesPerPixel: number;
    singleResolveBytesPerPixel: number;
    savedBytesPerPixel: number;
  };
  screenshots: typeof R4_B_CAPTURE_VIEWS;
  materialEvidence: R4BMaterialEvidence | null;
  evidence: BenchmarkEvidenceReport;
  counterIssues: string[];
  result: BenchmarkResult;
}

export interface R4BMaterialSweepReport {
  passed: boolean;
  issues: string[];
  cases: Array<{
    caseId: string;
    activeMaterials: number;
    fullscreenDraws: number;
  }>;
}

export function createR4BGateArtifact(
  manifest: BenchmarkSceneManifest,
  profile: "full" | "smoke",
  result: BenchmarkResult,
  evidence: BenchmarkEvidenceReport,
  counterIssues: readonly string[],
  materialEvidence: R4BMaterialEvidence | null
): R4BGateArtifact {
  const issues = validateR4BGate(
    manifest,
    profile,
    result,
    evidence,
    counterIssues,
    materialEvidence
  );
  return {
    schemaVersion: R4_B_GATE_SCHEMA_VERSION,
    taskId: "R4-B",
    caseId: manifest.id,
    profile,
    passed: issues.length === 0,
    issues,
    contract: {
      producer: "hardware-packed-r4-visibility-key-v1",
      consumer: "single-standard-pbr-material-resolve-v1",
      fullscreenDrawsPerFrame: 1,
      currentFrameVisibilityCountReadback: false,
      perMaterialBindGroups: false,
      packedVelocityPass: false
    },
    attachments: {
      retiredMaterialChainBytesPerPixel: R4_B_RETIRED_MATERIAL_CHAIN_BYTES_PER_PIXEL,
      singleResolveBytesPerPixel: R4_B_SURFACE_BYTES_PER_PIXEL,
      savedBytesPerPixel:
        R4_B_RETIRED_MATERIAL_CHAIN_BYTES_PER_PIXEL - R4_B_SURFACE_BYTES_PER_PIXEL
    },
    screenshots: R4_B_CAPTURE_VIEWS,
    materialEvidence,
    evidence,
    counterIssues: [...counterIssues],
    result
  };
}

export function validateR4BMaterialSweep(
  artifacts: readonly R4BGateArtifact[]
): R4BMaterialSweepReport {
  const cases = artifacts.map((artifact) => ({
    caseId: artifact.caseId,
    activeMaterials:
      artifact.result.summary.counters["packed.material.activeMaterials"]?.p50 ?? -1,
    fullscreenDraws:
      artifact.result.summary.counters["packed.material.fullscreenDraws"]?.p50 ?? -1
  }));
  const issues: string[] = [];
  if (cases.length < 2) issues.push("material sweep requires at least two cases");
  if (new Set(cases.map((entry) => entry.activeMaterials)).size < 2) {
    issues.push("material sweep did not vary active material count");
  }
  for (const entry of cases) {
    if (entry.fullscreenDraws !== 1) {
      issues.push(`${entry.caseId}: fullscreen Resolve draw count is not one`);
    }
  }
  return { passed: issues.length === 0, issues, cases };
}

function validateR4BGate(
  manifest: BenchmarkSceneManifest,
  profile: "full" | "smoke",
  result: BenchmarkResult,
  evidence: BenchmarkEvidenceReport,
  counterIssues: readonly string[],
  materialEvidence: R4BMaterialEvidence | null
): string[] {
  const issues: string[] = [];
  const environment = result.environment;
  const expectedPixels = environment.frame.internalWidth * environment.frame.internalHeight;
  const expectedMaterials = manifest.counts.materials;

  if (profile !== "full") issues.push("profile must be full");
  if (environment.engine.dirty) issues.push("engine provenance must be clean");
  if (!evidence.gateEligible) issues.push("benchmark evidence is not gate eligible");
  if (counterIssues.length > 0) issues.push(...counterIssues);
  if (!environment.run.featureSet.includes("single-material-resolve")) {
    issues.push("single-material-resolve feature evidence is missing");
  }
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
  if (result.summary.gpuPhaseMs["material-resolve"] === undefined) {
    issues.push("material-resolve GPU phase is missing");
  }
  if (!Object.keys(result.summary.gpuMs).some((label) =>
    /R4-B Single Material Resolve/.test(label)
  )) {
    issues.push("R4-B Single Material Resolve timestamp label is missing");
  }

  if (materialEvidence === null) {
    issues.push("Material/Texture residency evidence is missing");
  } else {
    if (materialEvidence.schemaVersion !== 4) {
      issues.push("Material/Texture residency evidence schema must be v4");
    }
    if (materialEvidence.residentMaterialSlotCount !== expectedMaterials) {
      issues.push("resident MaterialRecord slot count differs from the manifest");
    }
    if (materialEvidence.retiringMaterialSlotCount !== 0) {
      issues.push("MaterialRecord slots are still retiring after the benchmark");
    }
    if (
      materialEvidence.residentMaterialSlotCount +
      materialEvidence.retiringMaterialSlotCount +
      materialEvidence.freeMaterialSlotCount !== materialEvidence.materialCapacity
    ) {
      issues.push("MaterialRecord resident/retiring/free accounting is inconsistent");
    }
    if (materialEvidence.retiringTextureCount !== 0) {
      issues.push("texture layers are still retiring after the benchmark");
    }
    if (
      materialEvidence.residentTextureCount +
      materialEvidence.retiringTextureCount +
      materialEvidence.freeTextureLayerCount !== materialEvidence.textureCapacity - 1
    ) {
      issues.push("texture resident/retiring/free accounting must reserve fallback layer zero");
    }
    if (materialEvidence.textureFallbackCount !== 0) {
      issues.push("texture residency fallback was observed");
    }
    if (materialEvidence.samplerFallbackCount !== 0) {
      issues.push("sampler fallback was observed");
    }
    if (materialEvidence.privateSubmitCount !== 0) {
      issues.push("Material/Texture owner created a private submit");
    }
    if (materialEvidence.residentTextureBytes <= 0 || materialEvidence.allocatedBytes <= 0) {
      issues.push("Material/Texture resident byte evidence is invalid");
    }
    if (manifest.id === "B" && materialEvidence.residentTextureCount < 4) {
      issues.push("B did not stage the required Standard PBR texture set");
    }
  }

  let sampledCounters = 0;
  for (const frame of result.frames) {
    if (frame.counters["packed.material.fullscreenDraws"] !== 1) {
      issues.push(`frame ${frame.frameIndex}: Material Resolve must use one fullscreen draw`);
    }
    if (frame.counters["packed.material.activeMaterials"] !== expectedMaterials) {
      issues.push(`frame ${frame.frameIndex}: active MaterialRecord count mismatch`);
    }
    if (frame.counters["packed.material.surfaceBytesPerPixel"] !== R4_B_SURFACE_BYTES_PER_PIXEL) {
      issues.push(`frame ${frame.frameIndex}: Surface bytes/pixel mismatch`);
    }
    if (
      frame.counters["packed.material.surfaceAttachmentBytes"] !==
      expectedPixels * R4_B_SURFACE_BYTES_PER_PIXEL
    ) {
      issues.push(`frame ${frame.frameIndex}: Surface attachment byte count mismatch`);
    }
    if (!frame.gpuCounters.sampled || frame.gpuCounters.dropped) continue;
    sampledCounters++;
    const counters = frame.gpuCounters.values;
    if (counters.activeMaterials !== expectedMaterials) {
      issues.push(`frame ${frame.frameIndex}: sampled active MaterialRecord count mismatch`);
    }
    if (counters.invalidVisibilityKeys !== 0) {
      issues.push(`frame ${frame.frameIndex}: invalid VisibilityKey detected`);
    }
    if (counters.queueOverflowMask !== 0) {
      issues.push(`frame ${frame.frameIndex}: queue overflow detected`);
    }
    if (counters.gradientFallbackPixels !== 0) {
      issues.push(`frame ${frame.frameIndex}: analytic-gradient fallback detected`);
    }
    const reactiveLimit = R4_B_MAX_REACTIVE_SURFACE_PIXELS[manifest.id];
    const reactivePixels = counters.reactiveSurfacePixels;
    if (reactivePixels === undefined) {
      issues.push(`frame ${frame.frameIndex}: reactive Surface counter is missing`);
    } else if (reactivePixels > reactiveLimit) {
      issues.push(
        `frame ${frame.frameIndex}: reactive Surface pixels ${reactivePixels} exceed ${reactiveLimit}`
      );
    }
    if (manifest.id === "B") {
      for (const field of [
        "normalTexturePixels",
        "ormTexturePixels",
        "emissiveTexturePixels"
      ] as const) {
        if ((counters[field] ?? 0) <= 0) {
          issues.push(`frame ${frame.frameIndex}: B emitted no ${field}`);
        }
      }
    }
  }
  if (sampledCounters === 0) issues.push("no completed GPU counter samples");
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
