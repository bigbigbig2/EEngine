import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const docsRoot = path.join(repoRoot, "docs");

function files(directory, suffix) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(absolute, suffix);
    return entry.isFile() && entry.name.endsWith(suffix) ? [absolute] : [];
  });
}

test("documentation tree uses the contract-driven layers", () => {
  const directories = readdirSync(docsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const required of ["adr", "contracts", "domains", "porting", "sources", "specs"]) {
    assert.ok(directories.includes(required), `missing required documentation layer: ${required}`);
  }
  for (const retired of ["CONTEXT-MAP.md", "docs/ARCHITECTURE.md", "docs/PIPELINE.md", "docs/STATUS.md", "docs/implementation", "docs/others"]) {
    assert.equal(existsSync(path.join(repoRoot, retired)), false, retired);
  }
});

test("machine project manifests and generated registry are healthy", () => {
  const output = execFileSync(process.execPath, ["tools/vibe.mjs", "doctor"], { cwd: repoRoot, encoding: "utf8" });
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.counts.domains >= 6);
  assert.ok(result.counts.claims >= 10);
  assert.ok(result.counts.cases > 0);
  assert.equal(existsSync(path.join(repoRoot, "validation/registry.generated.json")), true);
});

test("context defaults to a compact actionable summary with explicit expansions", () => {
  const input = "OEngine/src/assets/web-cook/CanonicalWindowPlanner.ts";
  const output = execFileSync(process.execPath, ["tools/vibe.mjs", "context", input], { cwd: repoRoot, encoding: "utf8" });
  const compact = JSON.parse(output);
  assert.ok(output.split(/\r?\n/u).length < 140, "default context should remain a compact route summary");
  assert.equal(compact.owner.primary, "virtual-assets");
  assert.ok(compact.contracts.length > 0);
  assert.ok(compact.decisions.includes("ADR-0020"));
  assert.ok(compact.sources.includes("next-renderer-reference"));
  assert.equal(compact.workstreams.find((item) => item.id === "web-100m-virtual-geometry")?.state, "paused");
  assert.ok(compact.checks.length > 0);
  assert.ok(compact.engineTests.testFiles > 0);
  assert.equal("claims" in compact, false);
  assert.equal("cases" in compact, false);

  const expanded = JSON.parse(execFileSync(process.execPath, ["tools/vibe.mjs", "context", input, "--claims", "--cases"], { cwd: repoRoot, encoding: "utf8" }));
  assert.ok(expanded.claims.length > 0);
  assert.ok(expanded.cases.length > 0);

  const all = JSON.parse(execFileSync(process.execPath, ["tools/vibe.mjs", "context", input, "--all"], { cwd: repoRoot, encoding: "utf8" }));
  assert.ok(all.sources.some((item) => item.id === "next-renderer-reference" && item.upstream));
  assert.ok(all.workstreams.some((item) => item.id === "nyx-convergence" && item.tasks));
});

test("Next renderer routes expose their primary owner and active cut", async () => {
  const { loadModel, routeDomains } = await import("../../../tools/vibe-lib.mjs");
  const model = await loadModel();
  const rebuild = model.workstreams.find(item => item.id === "eengine-next-clean-rebuild");
  const current = rebuild.tasks.find(task => task.id === rebuild.currentSlice.id);
  assert.ok(current, "current slice must name a declared task");
  for (const dependency of current.dependsOn) {
    assert.equal(rebuild.tasks.find(task => task.id === dependency)?.state, "done",
      `current slice requires completed ${dependency}`);
  }
  const expected = new Map([
    ["OEngine/src/render/Renderer.ts", "frame-runtime"],
    ["OEngine/src/render/runtime/RendererCore.ts", "frame-runtime"],
    ["OEngine/src/render/scene/SceneRuntime.ts", "virtual-assets"],
    ["OEngine/src/render/virtual/VirtualResourceRuntime.ts", "virtual-assets"],
    ["OEngine/src/render/visibility/VisibilityRuntime.ts", "visibility"],
    ["OEngine/src/render/surface/SurfaceRuntime.ts", "shading"],
    ...["HierarchicalWorkGenerator", "HierarchicalZBuffer", "CurrentHzbLateRecheck", "MeshletWorkCandidate", "MeshletBucketRaster", "VisibilityBindingSet", "VisibilityWorkSet"]
      .map((name) => [`OEngine/src/render/${name}.ts`, "visibility"])
  ]);
  for (const [input, owner] of expected) {
    const route = routeDomains(model, [input]);
    assert.equal(route.primary?.id, owner, input);
    assert.equal(route.ambiguous, false, input);
  }

  for (const input of ["OEngine/src/render/Renderer.ts", "OEngine/src/render/surface/SurfaceRuntime.ts"]) {
    const context = JSON.parse(execFileSync(process.execPath, ["tools/vibe.mjs", "context", input], { cwd: repoRoot, encoding: "utf8" }));
    assert.ok(context.decisions.includes("ADR-0020"), input);
    assert.ok(context.sources.includes("next-renderer-reference"), input);
    assert.equal(context.workstreams.find((item) => item.id === "eengine-next-clean-rebuild")?.currentSlice.id, current.id, input);
  }
});

test("domain frontmatter keeps identity and leaves relationships to manifests", () => {
  for (const file of files(path.join(docsRoot, "domains"), ".md")) {
    if (path.basename(file) === "README.md") continue;
    const frontmatter = readFileSync(file, "utf8").split("---", 3)[1];
    assert.match(frontmatter, /\nid:\s*[^\n]+/u);
    assert.match(frontmatter, /\nkind:\s*domain/u);
    assert.match(frontmatter, /\nowner:\s*[^\n]+/u);
    assert.doesNotMatch(frontmatter, /\n(?:contracts|claims):/u);
  }
});

test("every existing changed path has one primary domain owner", async () => {
  // 这条断言直接测路由函数，不 spawn 整个 CLI：
  // 一是 CLI 的退出码会随工作树的验证等级变化（L2/L3 改动退出 2），把路由
  // 正确性混同于「证据是否跑过」；二是套件被 verify 调用后再回调 verify 会递归。
  const { loadModel, getChangedPaths, routeDomains, isIgnoredPath } = await import("../../../tools/vibe-lib.mjs");
  const model = await loadModel();
  for (const relative of getChangedPaths()) {
    if (isIgnoredPath(relative)) continue;
    if (!existsSync(path.join(repoRoot, relative))) continue;
    const route = routeDomains(model, [relative]);
    assert.ok(route.primary, `${relative} has no primary domain owner`);
    assert.equal(route.ambiguous, false, `${relative} has an ambiguous primary domain owner`);
  }
});

test("each domain has a human page routed back to its machine owner", async () => {
  const { loadModel, routeDomains } = await import("../../../tools/vibe-lib.mjs");
  const model = await loadModel();
  for (const domain of model.domains) {
    const document = `docs/domains/${domain.id}.md`;
    assert.equal(existsSync(path.join(repoRoot, document)), true, domain.id);
    assert.equal(routeDomains(model, [document]).primary?.id, domain.id, document);
  }
});

test("ADRs, specs, and porting ledgers retain their governance shape", () => {
  for (const file of files(path.join(docsRoot, "adr"), ".md")) {
    if (path.basename(file) === "README.md") continue;
    const text = readFileSync(file, "utf8");
    assert.match(text, /^Status: (?:proposed|accepted|superseded|rejected)\b/m, file);
    for (const heading of ["Context", "Decision", "Consequences", "Verification"]) assert.match(text, new RegExp(`^## ${heading}$`, "m"), file);
  }
  for (const file of files(path.join(docsRoot, "specs"), ".md")) {
    if (path.basename(file) === "README.md") continue;
    const text = readFileSync(file, "utf8");
    assert.match(text, /^Status: (?:draft|candidate|frozen|retired)\b/m, file);
    assert.match(text, /^Owners: .+/m, file);
    for (const heading of ["Version/Compatibility", "Contract", "Validation"]) assert.match(text, new RegExp(`^## ${heading}$`, "m"), file);
  }
  for (const name of ["geometry.md", "visibility.md", "shading.md", "platform.md"]) {
    const text = readFileSync(path.join(docsRoot, "porting", name), "utf8");
    for (const field of ["Local owner/source:", "Upstream:", "Revision:", "Upstream source:", "License:", "Adoption:", "Retained invariants:", "OEngine/WebGPU differences:", "Fallback/lifecycle:", "Local validation:"]) assert.match(text, new RegExp(field, "i"), name);
  }
});

test("authoritative docs do not contain machine-local paths or retired status routes", () => {
  for (const file of files(docsRoot, ".md")) {
    const relative = path.relative(repoRoot, file).replaceAll("\\", "/");
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /[A-Z]:[\\/]/u, relative);
    assert.doesNotMatch(text, /docs\/(?:ARCHITECTURE|PIPELINE|STATUS)\.md/u, relative);
  }
});
