import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { summarizeTests } from "../test-reporter.mjs";

test("real Node failure cannot be hidden by a test printing fake pass statistics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eengine-reporter-"));
  t.after(async () => {
    assert.ok(resolve(root).includes("eengine-reporter-"));
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, "fixture.test.mjs");
  const reporter = new URL("../test-reporter.mjs", import.meta.url).href;
  const env = { ...process.env };
  // A nested Node test child must run as a new runner, not inherit child-v8 mode.
  delete env.NODE_TEST_CONTEXT;
  await writeFile(
    path,
    'import test from "node:test";import assert from "node:assert/strict";test("wrong",()=>{console.log("100 passed, 0 failed");assert.equal(1,2);});',
  );
  const result = spawnSync(process.execPath, ["--test", "--test-reporter", reporter, path], {
    encoding: "utf8",
    windowsHide: true,
    env,
  });
  assert.ok(
    result.stdout.trim(),
    result.stderr || result.error?.message || "runner produced no machine output",
  );
  const events = result.stdout.trim().split("\n").map(JSON.parse);
  const summary = events.findLast((item) => item.type === "summary");
  assert.notEqual(result.status, 0);
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.counts.passed, 0);
  assert.equal(summarizeTests(result.stdout, result.status).status, "failed");
  await writeFile(path, 'import test from "node:test";test("skip",{skip:"missing prerequisite"},()=>{});');
  const skipped = spawnSync(process.execPath, ["--test", "--test-reporter", reporter, path], {
    encoding: "utf8",
    windowsHide: true,
    env,
  });
  const skip = skipped.stdout
    .trim()
    .split("\n")
    .map(JSON.parse)
    .findLast((item) => item.type === "summary");
  assert.equal(skip.counts.skipped, 1);
  assert.equal(skip.counts.passed, 0);
  assert.equal(summarizeTests(skipped.stdout, skipped.status).status, "not-run");
  assert.equal(summarizeTests(skipped.stdout, skipped.status).notRun[0].reason, "missing prerequisite");
  assert.equal(summarizeTests("partial report", 0).status, "failed");
});

test("production CLI rejects unknown flags and plan does not claim unrun browser cases", () => {
  const cli = fileURLToPath(new URL("../vibe.mjs", import.meta.url));
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", windowsHide: true });
  assert.notEqual(run("verify", "--full", "--unknown").status, 0);
  const plan = run("verify", "--full", "--plan");
  assert.equal(plan.status, 0);
  const report = JSON.parse(plan.stdout);
  assert.equal(report.browserCases.status, "not-run");
  assert.equal(report.rendererAcceptance, "not evaluated");
  const normal = JSON.parse(run("context", "tools/docs-verify.mjs").stdout);
  const expanded = JSON.parse(run("context", "tools/docs-verify.mjs", "--all").stdout);
  assert.deepEqual(normal.owner, expanded.owner);
  assert.deepEqual(normal.nextArchitecture, expanded.nextArchitecture);
});
