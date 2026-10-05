import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// 项目 OS 的 check runner 是门禁的实际执行体。它们此前是 vibe.mjs 里的 if 链，
// 没有任何测试；一旦某个 runner 退化为恒返回 passed，门禁会在全绿中静默失效。
// 这里用构造 context 的方式固定每个 runner 的通过与失败行为。
const { CHECK_RUNNER_IDS, planEngineTests, runCheckImplementation } = await import(
  "../../../tools/check-runners.mjs"
);
const { loadModel } = await import("../../../tools/vibe-lib.mjs");

const emptyContext = {
  repoRoot: process.cwd(),
  model: { domains: [], claims: [], checks: [], cases: [] },
  changedOnly: true,
  changedPaths: [],
  uncovered: [],
  routingAmbiguities: [],
};

function run(id, runner, config, patch = {}) {
  return runCheckImplementation(
    { id, runner, level: "L0", description: "test", config },
    { ...emptyContext, ...patch },
  );
}

test("every declared check binds to a registered runner", async () => {
  const model = await loadModel();
  assert.ok(model.checks.length >= 11);
  for (const check of model.checks) {
    assert.ok(CHECK_RUNNER_IDS.includes(check.runner), `${check.id} -> ${check.runner}`);
  }
});

test("an unknown runner fails instead of passing silently", () => {
  const result = run("mystery", "not-a-registered-runner");
  assert.equal(result.status, "failed");
  assert.match(result.details[0], /no runner implementation is registered/u);
});

test("changed-coverage and changed-ownership react to uncovered paths", () => {
  assert.equal(run("changed-coverage", "changed-coverage").status, "passed");
  assert.equal(
    run("changed-coverage", "changed-coverage", undefined, { uncovered: ["a.ts"] }).status,
    "failed",
  );
  assert.equal(run("guard-ownership", "changed-ownership").status, "passed");
  assert.equal(
    run("guard-ownership", "changed-ownership", undefined, { routingAmbiguities: [{ path: "a.ts" }] }).status,
    "failed",
  );
});

test("retired-paths rejects a returning retired entry point", () => {
  const config = { retiredPaths: ["OEngine/package.json"] };
  assert.equal(run("guard-legacy", "retired-paths", config).status, "failed");
  assert.equal(run("guard-legacy", "retired-paths", { retiredPaths: ["no/such/path"] }).status, "passed");
});

/**
 * 上一条用例只证明 runner 会工作，它喂的是合成路径。它无法发现
 * `checks/guards/legacy.yaml` 真实清单里的错误条目，而正是这种漂移让
 * `verify --full` 长期为红：`BloomPass.ts` 被重新加入生产后，清单没有同步移除。
 * 这里直接加载随仓库发布的真实配置，使清单本身成为被测试对象。
 */
test("the shipped retired-path list matches the real tree", async () => {
  const { fileURLToPath } = await import("node:url");
  // Resolve from this test file, not process.cwd(): the suite is run both from
  // the repository root and from OEngine/, and a cwd-relative path silently
  // checked a different (or missing) file in one of those cases.
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const model = await loadModel();
  const check = model.checks.find((entry) => entry.id === "guard-legacy");
  assert.ok(check, "guard-legacy must be declared in checks/guards/legacy.yaml");

  const result = run("guard-legacy", "retired-paths", check.config);
  const existing = (result.details ?? []).filter(
    (entry) => typeof entry === "string" && entry.includes("still exists"),
  );
  assert.deepEqual(
    existing,
    [],
    `retired-path entries that still exist on disk: ${existing.join(", ")}. ` +
      "Either the path was legitimately restored to production (remove it from the list) " +
      "or a retired owner is back (delete the file).",
  );
  assert.equal(result.status, "passed");
  assert.ok(existsSync(resolve(repoRoot, "checks/guards/legacy.yaml")));
});

test("public-api-boundary rejects a missing entry and accepts the real one", () => {
  assert.equal(
    run("guard-public-api", "public-api-boundary", { entry: "OEngine/src/index.ts" }).status,
    "passed",
  );
  const missing = run("guard-public-api", "public-api-boundary", { entry: "OEngine/src/does-not-exist.ts" });
  assert.equal(missing.status, "failed");
});

test("generated-source-guard honours its configured patterns", () => {
  const config = { patterns: ["\\.generated\\.(?:ts|js)$"] };
  assert.equal(run("guard-generated-source", "generated-source-guard", config).status, "passed");
  const edited = run("guard-generated-source", "generated-source-guard", config, {
    changedPaths: ["OEngine/src/render/nss_model.generated.ts"],
  });
  assert.equal(edited.status, "failed");
  assert.equal(run("guard-generated-source", "generated-source-guard", { patterns: [] }).status, "failed");
});

test("domain-doc-coverage fails for a domain without a human page", () => {
  const result = run("guard-docs", "domain-doc-coverage", undefined, {
    model: { domains: [{ id: "no-such-domain" }], claims: [], checks: [], cases: [] },
  });
  assert.equal(result.status, "failed");
  assert.match(result.details.join(" "), /no docs\/domains\/no-such-domain\.md/u);
});

test("engine-suites refuses to recurse into itself", () => {
  const config = { cwd: "OEngine", testFiles: "tests/**/*.test.mjs" };
  const previous = process.env.VIBE_ENGINE_SUITE_ACTIVE;
  process.env.VIBE_ENGINE_SUITE_ACTIVE = "1";
  try {
    const result = run("engine-suites", "engine-suites", config);
    assert.equal(result.status, "not-run");
    assert.match(result.details.join(" "), /already running/u);
  } finally {
    if (previous === undefined) delete process.env.VIBE_ENGINE_SUITE_ACTIVE;
    else process.env.VIBE_ENGINE_SUITE_ACTIVE = previous;
  }
});

test("engine-suites stays out of the way when no engine path changed", () => {
  const config = { cwd: "OEngine", testFiles: "tests/**/*.test.mjs" };
  // 递归守卫排在路径守卫之前，所以这条用例必须显式说明自己假设不在套件内部
  // —— 否则它会在被 engine-suites 拉起时拿到另一个 not-run 原因。
  const previous = process.env.VIBE_ENGINE_SUITE_ACTIVE;
  delete process.env.VIBE_ENGINE_SUITE_ACTIVE;
  try {
    const result = run("engine-suites", "engine-suites", config, { changedPaths: ["docs/README.md"] });
    assert.equal(result.status, "not-run");
    assert.match(result.details.join(" "), /no engine test group is affected/u);
  } finally {
    if (previous !== undefined) process.env.VIBE_ENGINE_SUITE_ACTIVE = previous;
  }
});

test("changed engine plans select affected tests and keep heavy native oracles explicit", () => {
  const cooker = planEngineTests(
    { changedOnly: true, changedPaths: ["OEngine/src/assets/web-cook/WebCookCoordinator.ts"] },
    { cwd: "OEngine" },
  );
  assert.equal(cooker.scope, "changed");
  assert.ok(cooker.groups.includes("web-cook"));
  assert.ok(cooker.files.some((path) => path.endsWith("web-cook-coordinator.test.mjs")));
  assert.ok(!cooker.files.some((path) => path.endsWith("nyx-differential-corpus.test.mjs")));

  const native = planEngineTests(
    { changedOnly: true, changedPaths: ["OEngine/tools/build-nyx-reference-harness.mjs"] },
    { cwd: "OEngine" },
  );
  assert.ok(native.groups.includes("native-reference"));
  assert.ok(native.files.some((path) => path.endsWith("nyx-differential-corpus.test.mjs")));
});

test("unmapped engine changes conservatively expand to the full suite", () => {
  const plan = planEngineTests(
    { changedOnly: true, changedPaths: ["OEngine/src/index.ts"] },
    { cwd: "OEngine" },
  );
  assert.equal(plan.scope, "full-fallback");
  assert.ok(plan.files.length > 50);
});
