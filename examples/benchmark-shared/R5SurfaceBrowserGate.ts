import {
  GPU_SURFACE_ABI_SCHEMA,
  GPU_SURFACE_ABI_VERSION,
  GPU_SURFACE_BYTES_PER_PIXEL,
  GPU_SURFACE_DEFINED_FLAGS_MASK,
  GPU_SURFACE_FLAGS_BITS,
  GPU_SURFACE_MATERIAL_SLOT_BITS,
  GPU_SURFACE_RESERVED_FLAGS_MASK,
  GPU_SURFACE_VELOCITY_CONVENTION
} from "../../OEngine/src/gpu/GpuSurfaceAbi.ts";
import type {
  BenchmarkEvidenceReport,
  BenchmarkResult,
  BenchmarkSceneManifest
} from "../../OEngine/src/index.ts";
import type {
  R4BGateArtifact,
  R4BMaterialEvidence
} from "./R4BBrowserGate.ts";

export const R5_00_GATE_SCHEMA_VERSION = 1;

export const R5_00_CAPTURE_VIEWS = [
  "final-color",
  "material-id",
  "velocity",
  "history-validity",
  "reactive"
] as const;

export interface R500GateArtifact {
  schemaVersion: number;
  taskId: "R5-00";
  caseId: BenchmarkSceneManifest["id"];
  profile: "full" | "smoke";
  passed: boolean;
  issues: string[];
  contract: {
    producer: "classified-specialized-standard-pbr-material-resolve-v1";
    consumer: "oengine-surface-v1";
    hardwareVisibilityOnly: true;
    newR5EffectPasses: 0;
  };
  surfaceAbi: {
    name: typeof GPU_SURFACE_ABI_SCHEMA.name;
    version: typeof GPU_SURFACE_ABI_VERSION;
    formats: typeof GPU_SURFACE_ABI_SCHEMA.formats;
    bytesPerPixel: typeof GPU_SURFACE_BYTES_PER_PIXEL;
    materialSlotBits: typeof GPU_SURFACE_MATERIAL_SLOT_BITS;
    flagsBits: typeof GPU_SURFACE_FLAGS_BITS;
    definedFlagsMask: typeof GPU_SURFACE_DEFINED_FLAGS_MASK;
    reservedFlagsMask: typeof GPU_SURFACE_RESERVED_FLAGS_MASK;
    velocity: typeof GPU_SURFACE_VELOCITY_CONVENTION;
  };
  screenshots: typeof R5_00_CAPTURE_VIEWS;
  materialEvidence: R4BMaterialEvidence | null;
  evidence: BenchmarkEvidenceReport;
  counterIssues: string[];
  result: BenchmarkResult;
}

export function createR500GateArtifact(
  manifest: BenchmarkSceneManifest,
  r4Artifact: R4BGateArtifact
): R500GateArtifact {
  const issues = validateR500Gate(manifest, r4Artifact);
  return {
    schemaVersion: R5_00_GATE_SCHEMA_VERSION,
    taskId: "R5-00",
    caseId: manifest.id,
    profile: r4Artifact.profile,
    passed: issues.length === 0,
    issues,
    contract: {
      producer: "classified-specialized-standard-pbr-material-resolve-v1",
      consumer: "oengine-surface-v1",
      hardwareVisibilityOnly: true,
      newR5EffectPasses: 0
    },
    surfaceAbi: {
      name: GPU_SURFACE_ABI_SCHEMA.name,
      version: GPU_SURFACE_ABI_VERSION,
      formats: GPU_SURFACE_ABI_SCHEMA.formats,
      bytesPerPixel: GPU_SURFACE_BYTES_PER_PIXEL,
      materialSlotBits: GPU_SURFACE_MATERIAL_SLOT_BITS,
      flagsBits: GPU_SURFACE_FLAGS_BITS,
      definedFlagsMask: GPU_SURFACE_DEFINED_FLAGS_MASK,
      reservedFlagsMask: GPU_SURFACE_RESERVED_FLAGS_MASK,
      velocity: GPU_SURFACE_VELOCITY_CONVENTION
    },
    screenshots: R5_00_CAPTURE_VIEWS,
    materialEvidence: r4Artifact.materialEvidence,
    evidence: r4Artifact.evidence,
    counterIssues: r4Artifact.counterIssues,
    result: r4Artifact.result
  };
}

function validateR500Gate(
  manifest: BenchmarkSceneManifest,
  r4Artifact: R4BGateArtifact
): string[] {
  const issues = r4Artifact.issues.map((issue) => `R4-B dependency: ${issue}`);
  const featureSet = r4Artifact.result.environment.run.featureSet;

  if (!r4Artifact.passed) issues.push("R4-B producer/consumer Gate did not pass");
  if (!featureSet.includes("hardware-visibility")) {
    issues.push("hardware-visibility feature evidence is missing");
  }
  if (!featureSet.includes("single-material-resolve")) {
    issues.push("single-material-resolve Surface producer evidence is missing");
  }
  if (featureSet.includes("software-visibility")) {
    issues.push("R5 base must not include software-visibility");
  }
  if (featureSet.includes("hybrid-visibility")) {
    issues.push("R5 base must not include hybrid-visibility");
  }
  if (!sameFeatureSet(manifest.featureSet, featureSet)) {
    issues.push("runtime feature set differs from the frozen manifest");
  }
  if (GPU_SURFACE_BYTES_PER_PIXEL !== 26) {
    issues.push("Surface ABI v1 must remain 26 bytes/pixel");
  }
  if (GPU_SURFACE_ABI_VERSION !== 1) {
    issues.push("R5-00 browser Gate only accepts Surface ABI v1");
  }
  if (
    GPU_SURFACE_MATERIAL_SLOT_BITS !== 16 ||
    GPU_SURFACE_FLAGS_BITS !== 16 ||
    GPU_SURFACE_DEFINED_FLAGS_MASK !== 0x00ff ||
    GPU_SURFACE_RESERVED_FLAGS_MASK !== 0xff00
  ) {
    issues.push("Surface metadata no longer matches the frozen v1 bit layout");
  }
  return [...new Set(issues)];
}

function sameFeatureSet(
  expected: readonly string[],
  actual: readonly string[]
): boolean {
  if (expected.length !== actual.length) return false;
  const actualSet = new Set(actual);
  return expected.every((feature) => actualSet.has(feature));
}
