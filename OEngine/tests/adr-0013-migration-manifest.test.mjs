import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testsDirectory, "..");
const manifest = JSON.parse(
  readFileSync(resolve(testsDirectory, "fixtures/adr-0013-migration-manifest.json"), "utf8")
);

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

test("ADR-0013 Step 7 preserves the migration inventory and records physical deletion", () => {
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.adr, "ADR-0013");
  assert.equal(manifest.phase, "step-7-cutover");
  assert.match(manifest.inventoryCommit, /^[0-9a-f]{7,40}$/u);
  assertUnique(manifest.migrations.map(({ id }) => id), "migration ids");

  const requiredMigrations = [
    "identity-abi",
    "scene-publication-summary",
    "visibility-output",
    "classifier-and-queue",
    "material-resolve",
    "direct-lighting",
    "frame-products",
    "diagnostics-and-profiler",
    "pipeline-composition",
    "legacy-tests-and-docs"
  ];
  assert.deepEqual(manifest.migrations.map(({ id }) => id), requiredMigrations);

  const retiredPaths = new Set(manifest.cutoverDeletion.retiredPaths);
  assertUnique([...retiredPaths], "retired paths");
  for (const retiredPath of retiredPaths) {
    assert.equal(existsSync(resolve(packageRoot, retiredPath)), false, `${retiredPath} must be deleted`);
  }

  for (const migration of manifest.migrations) {
    assert.ok(migration.currentPaths.length > 0, `${migration.id} must name current paths`);
    assert.ok(migration.replacementOwners.length > 0, `${migration.id} must name replacement owners`);
    assert.ok(migration.verificationOwners.length > 0, `${migration.id} must name verification owners`);
    assert.ok(migration.implementedAtStep >= 1 && migration.implementedAtStep <= 5);
    assert.equal(migration.retireAtStep, 7);
    for (const currentPath of migration.currentPaths) {
      if (retiredPaths.has(currentPath)) {
        assert.equal(existsSync(resolve(packageRoot, currentPath)), false);
      } else {
        assert.ok(existsSync(resolve(packageRoot, currentPath)), `${migration.id}: missing ${currentPath}`);
      }
    }
  }
});

test("ADR-0013 Step 7 retired symbols have zero source-tree matches", () => {
  const sourceRoot = resolve(packageRoot, "src");
  const source = sourceFiles(sourceRoot)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  for (const pattern of manifest.cutoverDeletion.retiredSourcePatterns) {
    assert.doesNotMatch(source, new RegExp(pattern, "u"), `retired source pattern remains: ${pattern}`);
  }
});

test("ADR-0013 source decisions are exact and contain no unresolved candidates", () => {
  assertUnique(manifest.sources.map(({ id }) => id), "source ids");
  const allowedDecisions = new Set([
    "traceable-local-port",
    "algorithm-invariant-reference",
    "reference-only",
    "reject-adoption"
  ]);
  for (const source of manifest.sources) {
    assert.ok(source.revision.length > 0, `${source.id} needs a revision`);
    assert.ok(source.paths.length > 0, `${source.id} needs a path`);
    assert.ok(source.license.length > 0, `${source.id} needs a license`);
    assert.ok(allowedDecisions.has(source.adoption), `${source.id} has unresolved adoption`);
  }
  const rejected = manifest.sources.find(({ id }) => id === "kooch-wgsl");
  assert.equal(rejected.license, "All Rights Reserved");
  assert.equal(rejected.adoption, "reject-adoption");
});

test("ADR-0013 exact source revisions are reflected by the porting ledgers", () => {
  const repositoryRoot = resolve(packageRoot, "..");
  const ledgers = [
    readFileSync(resolve(repositoryRoot, "docs/porting/visibility.md"), "utf8"),
    readFileSync(resolve(repositoryRoot, "docs/porting/shading.md"), "utf8")
  ].join("\n");
  for (const source of manifest.sources.filter(({ adoption }) => adoption !== "reference-only")) {
    assert.match(ledgers, new RegExp(source.revision.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(ledgers, /crates\/bevy_pbr\/src\/meshlet\/visibility_buffer_resolve\.wesl/u);
  assert.match(ledgers, /libs\/gltfio\/materials\/base\.mat\.in/u);
  assert.doesNotMatch(ledgers, /cd504689\.\.\.|9d43e691\.\.\.|filament\/src\/materials\/base\.mat\.in/u);
});

test("ADR-0013 requirements have stable category ids and verification layers", () => {
  const expectedCategories = ["CAP", "ID", "VIS", "QUE", "CLS", "SHADE", "OFF", "LIFE", "DIAG", "PERF", "DEL"];
  const ids = manifest.requirements.map(({ id }) => id);
  assertUnique(ids, "requirement ids");
  const actualCategories = [...new Set(ids.map((id) => id.split("-")[0]))];
  assert.deepEqual(actualCategories, expectedCategories);
  for (const requirement of manifest.requirements) {
    assert.match(requirement.id, /^(CAP|ID|VIS|QUE|CLS|SHADE|OFF|LIFE|DIAG|PERF|DEL)-\d{3}$/u);
    assert.ok(requirement.clause.length > 0, `${requirement.id} needs a clause`);
    assert.ok(requirement.layers.length > 0, `${requirement.id} needs a verification layer`);
    for (const layer of requirement.layers) {
      assert.match(layer, /^L[0-6]$/u);
    }
  }
});

test("ADR-0013 historical comparison gates are closed by removal, not deferred", () => {
  assert.deepEqual(manifest.historicalComparison, {
    status: "closed",
    resolution: "requirement-removed",
    removedChecks: ["legacy-baseline-freeze", "step-6-formal-ab", "pre-post-deletion-comparison", "relative-performance-gain"],
    blocksAcceptance: false,
    requiresFollowupEvidence: false
  });
  const repositoryRoot = resolve(packageRoot, "..");
  for (const document of ["docs/adr/0013-sparse-shading-bin-pipeline.md", "docs/VALIDATION.md", "docs/STATUS.md"]) {
    const source = readFileSync(resolve(repositoryRoot, document), "utf8");
    assert.match(source, /closed \/ requirement-removed/u, document);
  }
  const status = readFileSync(resolve(repositoryRoot, "docs/STATUS.md"), "utf8");
  assert.doesNotMatch(status, /formal L5 baseline|L5 formal baseline\/candidate|同条件 L5 baseline\/candidate|clean commit A\/B/u);
  const relatedAdrs = [
    "0006-packed-render-world-convergence.md",
    "0007-gpu-native-runtime-assets-and-residency-v2.md",
    "0008-gpu-driven-geometry-and-visibility-v2.md",
    "0009-compute-shading-and-advanced-frame-pipeline-v2.md"
  ].map((name) => readFileSync(resolve(repositoryRoot, "docs/adr", name), "utf8")).join("\n");
  assert.doesNotMatch(relatedAdrs, /ADR 开始前保存正式 baseline|ADR 开始保存一次正式 baseline|正确性和正式 A\/B|正确性与正式 A\/B|MILESTONE short A\/B|对比迁移前冻结基线/u);
});

test("ADR-0013 current absolute PERF keeps designated-device gates without a historical baseline", () => {
  assert.equal("formalBaseline" in manifest, false);
  const performance = manifest.formalPerformance;
  assert.equal(performance.status, "open");
  assert.match(performance.blocker, /ADR-0014/u);
  assert.equal(performance.comparisonPolicy, "current-revision-only");
  assert.equal(performance.evidenceSchemaId, "adr-0013-perf-evidence-v2");
  assert.deepEqual(performance.fixedConditions.outputExtent, [1920, 1080]);
  assert.equal(performance.fixedConditions.devicePixelRatio, 1);
  assert.equal(performance.fixedConditions.renderScale, 1);
  assert.equal(performance.fixedConditions.requiredAdapterPolicy, "current-designated-device");
  assert.equal(performance.fixedConditions.designatedAdapter, "NVIDIA GeForce RTX 2060 SUPER");
  assert.equal("adapters" in performance.fixedConditions, false);
  assert.ok(performance.fixedConditions.requiredFingerprint.length >= 10);
  for (const id of ["PERF-001", "PERF-003", "PERF-004"]) {
    const requirement = manifest.requirements.find((entry) => entry.id === id);
    assert.match(requirement.clause, /current/u);
    assert.doesNotMatch(requirement.clause, /baseline and candidate|removed lighting deltas|regression/u);
  }
});

test("ADR-0013 internal ABI is not exposed through the public entry point", () => {
  const publicEntry = readFileSync(resolve(packageRoot, "src/index.ts"), "utf8");
  for (const internalName of ["GpuShadingProgramAbi", "GpuShadingBinAbi", "ShadingBinFrame", "SpecializedShadingFrame"]) {
    assert.doesNotMatch(publicEntry, new RegExp(`\\b${internalName}\\b`, "u"));
  }
});

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}
