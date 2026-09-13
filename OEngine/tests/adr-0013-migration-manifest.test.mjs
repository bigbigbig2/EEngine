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
  assert.equal(manifest.schemaVersion, 2);
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

test("ADR-0013 formal baseline names the current designated blocking device", () => {
  assert.equal(manifest.formalBaseline.status, "open");
  assert.match(manifest.formalBaseline.blocker, /ADR-0014/u);
  assert.deepEqual(manifest.formalBaseline.fixedConditions.outputExtent, [1920, 1080]);
  assert.equal(manifest.formalBaseline.fixedConditions.devicePixelRatio, 1);
  assert.equal(manifest.formalBaseline.fixedConditions.requiredAdapterPolicy, "current-designated-device");
  assert.equal(manifest.formalBaseline.fixedConditions.designatedAdapter, "NVIDIA GeForce RTX 2060 SUPER");
  assert.equal("adapters" in manifest.formalBaseline.fixedConditions, false);
  assert.ok(manifest.formalBaseline.fixedConditions.requiredFingerprint.length >= 10);
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
