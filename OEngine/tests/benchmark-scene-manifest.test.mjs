import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBenchmarkCaseManifest,
  validateBenchmarkSceneManifest
} from "../.test-dist/debug/BenchmarkSceneManifest.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const manifestDirectory = path.join(
  repositoryRoot,
  "examples/benchmark-shared/manifests"
);

test("A/B/C scene manifests freeze unique roles on the unified Renderer path", async () => {
  const manifests = await loadManifests();
  assert.deepEqual(manifests.map((manifest) => manifest.id), ["A", "B", "C"]);
  assert.deepEqual(
    manifests.map((manifest) => manifest.baselineRole),
    ["minimum-a", "minimum-b", "engine-generality-c"]
  );
  assert.deepEqual(
    new Set(manifests.map((manifest) => manifest.rendererPath)),
    new Set(["oengine-unified"])
  );
  for (const manifest of manifests) {
    assert.equal(new Set(manifest.featureSet).size, manifest.featureSet.length);
    assert.equal(manifest.camera.frameCount, 240);
    assert.equal(
      manifest.featureSet.includes("software-visibility"),
      false,
      `${manifest.id} R5 base manifest must describe the actual HW-only feature set`
    );
    assert.equal(
      manifest.featureSet.includes("single-material-resolve"),
      true,
      `${manifest.id} R5 base manifest must declare its Surface producer`
    );
  }
});

test("camera paths and every workspace-owned asset match their SHA-256", async () => {
  for (const manifest of await loadManifests()) {
    assert.equal(
      sha256(Buffer.from(JSON.stringify(manifest.camera.keyframes))),
      manifest.camera.sha256,
      `${manifest.id} camera path`
    );
    for (const asset of manifest.assets) {
      if (!asset.source.startsWith("workspace:")) continue;
      const relativePath = asset.source.slice("workspace:".length);
      const bytes = await readFile(path.join(repositoryRoot, relativePath));
      const canonicalBytes = asset.kind === "recipe"
        ? Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"))
        : bytes;
      assert.equal(sha256(canonicalBytes), asset.sha256, asset.id);
    }
  }
});

test("unsupported assets carry stable blockers and Result v3 receives traceable identity", async () => {
  for (const manifest of await loadManifests()) {
    for (const asset of manifest.assets) {
      if (asset.runtimeStatus === "declared-unsupported") {
        assert.match(asset.blockerTaskId, /^[A-Z]+-[0-9]{2}$/);
        assert.ok(asset.reason.length > 0);
      } else {
        assert.equal(asset.blockerTaskId, undefined);
        assert.equal(asset.reason, undefined);
      }
    }
    const benchmarkCase = createBenchmarkCaseManifest(manifest);
    assert.equal(benchmarkCase.id, manifest.id);
    assert.equal(benchmarkCase.seed, manifest.seed);
    assert.match(benchmarkCase.cameraPathHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(benchmarkCase.sceneAssetHashes.length, manifest.assets.length);
    for (const digest of benchmarkCase.sceneAssetHashes) {
      assert.match(digest, /^sha256:[0-9a-f]{64}$/);
    }
  }
});

test("manifest validator rejects ambiguous zeros, bad roles and unsupported assets without blockers", async () => {
  const [source] = await loadManifests();
  assert.throws(
    () => validateBenchmarkSceneManifest({ ...source, counts: { ...source.counts, instances: 0 } }),
    /counts.instances/
  );
  assert.throws(
    () => validateBenchmarkSceneManifest({ ...source, baselineRole: "minimum-b" }),
    /baselineRole/
  );
  const invalidAsset = structuredClone(source);
  invalidAsset.assets[1].blockerTaskId = undefined;
  assert.throws(() => validateBenchmarkSceneManifest(invalidAsset), /blockerTaskId/);
});

async function loadManifests() {
  const manifests = [];
  for (const id of ["a", "b", "c"]) {
    const text = await readFile(
      path.join(manifestDirectory, `benchmark-${id}.json`),
      "utf8"
    );
    manifests.push(validateBenchmarkSceneManifest(JSON.parse(text)));
  }
  return manifests;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
