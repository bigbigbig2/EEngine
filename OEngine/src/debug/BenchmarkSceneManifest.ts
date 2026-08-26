import type { BenchmarkCaseManifest } from "./BenchmarkHarness.js";
import type { BenchmarkBaselineRole } from "./EnvironmentManifest.js";

export const BENCHMARK_SCENE_MANIFEST_SCHEMA_VERSION = 1;

export type BenchmarkAssetRuntimeStatus = "consumed" | "declared-unsupported";

export interface BenchmarkAssetManifest {
  id: string;
  kind: "geometry" | "material" | "texture" | "environment" | "recipe";
  source: string;
  sha256: string;
  usage: string;
  runtimeStatus: BenchmarkAssetRuntimeStatus;
  blockerTaskId?: string;
  reason?: string;
}

export interface BenchmarkCameraKeyframe {
  frame: number;
  position: [number, number, number];
  target: [number, number, number];
}

export interface BenchmarkSceneManifest {
  schemaVersion: number;
  id: "A" | "B" | "C";
  name: string;
  baselineRole: Extract<
    BenchmarkBaselineRole,
    "minimum-a" | "minimum-b" | "engine-generality-c"
  >;
  rendererPath: "oengine-unified";
  reference: {
    implementation: string;
    source: string;
    revision: string;
  };
  seed: number;
  featureSet: string[];
  frame: {
    width: number;
    height: number;
    dpr: number;
  };
  run: {
    warmupFrames: number;
    sampleFrames: number;
    gpuSampleInterval: number;
    gpuCounterSampleInterval: number;
    readbackRingSlots: number;
  };
  counts: {
    instances: number;
    geometries: number;
    materials: number;
    localLights: number;
  };
  camera: {
    id: string;
    frameCount: number;
    sha256: string;
    keyframes: BenchmarkCameraKeyframe[];
  };
  assets: BenchmarkAssetManifest[];
  currentLimitations: string[];
}

/** Validates the frozen, repository-owned A/B/C input contract. */
export function validateBenchmarkSceneManifest(
  input: unknown
): BenchmarkSceneManifest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("benchmark scene manifest must be an object");
  }
  const value = input as Partial<BenchmarkSceneManifest>;
  if (value.schemaVersion !== BENCHMARK_SCENE_MANIFEST_SCHEMA_VERSION) {
    throw new RangeError(
      `unsupported benchmark scene manifest schema ${String(value.schemaVersion)}`
    );
  }
  if (value.id !== "A" && value.id !== "B" && value.id !== "C") {
    throw new RangeError("benchmark scene manifest id must be A, B or C");
  }
  assertNonEmpty(value.name, "name");
  const expectedRole = {
    A: "minimum-a",
    B: "minimum-b",
    C: "engine-generality-c"
  } as const;
  if (value.baselineRole !== expectedRole[value.id]) {
    throw new RangeError(
      `baselineRole for ${value.id} must be ${expectedRole[value.id]}`
    );
  }
  if (value.rendererPath !== "oengine-unified") {
    throw new RangeError("rendererPath must be oengine-unified");
  }
  assertObject(value.reference, "reference");
  assertNonEmpty(value.reference.implementation, "reference.implementation");
  assertNonEmpty(value.reference.source, "reference.source");
  assertNonEmpty(value.reference.revision, "reference.revision");
  assertNonNegativeInteger(value.seed, "seed");
  assertUniqueStrings(value.featureSet, "featureSet");
  assertObject(value.frame, "frame");
  assertPositiveInteger(value.frame.width, "frame.width");
  assertPositiveInteger(value.frame.height, "frame.height");
  assertPositiveFinite(value.frame.dpr, "frame.dpr");
  assertObject(value.run, "run");
  assertNonNegativeInteger(value.run.warmupFrames, "run.warmupFrames");
  assertPositiveInteger(value.run.sampleFrames, "run.sampleFrames");
  assertPositiveInteger(value.run.gpuSampleInterval, "run.gpuSampleInterval");
  assertPositiveInteger(
    value.run.gpuCounterSampleInterval,
    "run.gpuCounterSampleInterval"
  );
  assertPositiveInteger(value.run.readbackRingSlots, "run.readbackRingSlots");
  if (value.run.readbackRingSlots < 3) {
    throw new RangeError("run.readbackRingSlots must be at least 3");
  }
  assertObject(value.counts, "counts");
  assertPositiveInteger(value.counts.instances, "counts.instances");
  assertPositiveInteger(value.counts.geometries, "counts.geometries");
  assertPositiveInteger(value.counts.materials, "counts.materials");
  assertNonNegativeInteger(value.counts.localLights, "counts.localLights");
  assertObject(value.camera, "camera");
  assertNonEmpty(value.camera.id, "camera.id");
  assertPositiveInteger(value.camera.frameCount, "camera.frameCount");
  assertSha256(value.camera.sha256, "camera.sha256");
  if (!Array.isArray(value.camera.keyframes) || value.camera.keyframes.length < 2) {
    throw new RangeError("camera.keyframes must contain at least two entries");
  }
  let previousFrame = -1;
  for (const [index, keyframe] of value.camera.keyframes.entries()) {
    assertNonNegativeInteger(keyframe.frame, `camera.keyframes[${index}].frame`);
    if (keyframe.frame <= previousFrame || keyframe.frame >= value.camera.frameCount) {
      throw new RangeError("camera keyframe frames must be increasing and in range");
    }
    previousFrame = keyframe.frame;
    assertVec3(keyframe.position, `camera.keyframes[${index}].position`);
    assertVec3(keyframe.target, `camera.keyframes[${index}].target`);
  }
  if (!Array.isArray(value.assets) || value.assets.length === 0) {
    throw new RangeError("assets must contain at least one entry");
  }
  const assetIds = new Set<string>();
  for (const [index, asset] of value.assets.entries()) {
    assertNonEmpty(asset.id, `assets[${index}].id`);
    if (assetIds.has(asset.id)) throw new RangeError(`duplicate asset id ${asset.id}`);
    assetIds.add(asset.id);
    if (!["geometry", "material", "texture", "environment", "recipe"].includes(asset.kind)) {
      throw new RangeError(`assets[${index}].kind is invalid`);
    }
    assertNonEmpty(asset.source, `assets[${index}].source`);
    assertSha256(asset.sha256, `assets[${index}].sha256`);
    assertNonEmpty(asset.usage, `assets[${index}].usage`);
    if (asset.runtimeStatus === "declared-unsupported") {
      assertTaskId(asset.blockerTaskId, `assets[${index}].blockerTaskId`);
      assertNonEmpty(asset.reason, `assets[${index}].reason`);
    } else if (asset.runtimeStatus !== "consumed") {
      throw new RangeError(`assets[${index}].runtimeStatus is invalid`);
    } else if (asset.blockerTaskId !== undefined || asset.reason !== undefined) {
      throw new RangeError(`consumed asset ${asset.id} cannot carry a blocker`);
    }
  }
  if (!Array.isArray(value.currentLimitations)) {
    throw new TypeError("currentLimitations must be an array");
  }
  for (const [index, limitation] of value.currentLimitations.entries()) {
    assertNonEmpty(limitation, `currentLimitations[${index}]`);
  }
  return value as BenchmarkSceneManifest;
}

/** Maps a frozen scene manifest into Result Schema v3's case identity. */
export function createBenchmarkCaseManifest(
  manifest: BenchmarkSceneManifest
): BenchmarkCaseManifest {
  validateBenchmarkSceneManifest(manifest);
  return {
    id: manifest.id,
    name: manifest.name,
    sceneAssetHashes: manifest.assets.map((asset) => `sha256:${asset.sha256}`),
    seed: manifest.seed,
    cameraPathHash: `sha256:${manifest.camera.sha256}`
  };
}

function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RangeError(`${name} must be a non-empty string`);
  }
}

function assertNonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function assertPositiveFinite(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
}

function assertUniqueStrings(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RangeError(`${name} must contain at least one string`);
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    assertNonEmpty(entry, `${name}[${index}]`);
    if (seen.has(entry)) throw new RangeError(`${name} contains duplicate ${entry}`);
    seen.add(entry);
  }
}

function assertSha256(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RangeError(`${name} must be a lowercase SHA-256 hex digest`);
  }
}

function assertTaskId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Z]+-[0-9]{2}$/.test(value)) {
    throw new RangeError(`${name} must be a stable task id`);
  }
}

function assertVec3(value: unknown, name: string): asserts value is [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((component) => typeof component !== "number" || !Number.isFinite(component))
  ) {
    throw new RangeError(`${name} must contain three finite numbers`);
  }
}
