import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("pinned original Nyx Slang entry points compile and reflect independently", () => {
  const result = spawnSync(process.execPath, ["tools/build-nyx-shader-reference-harness.mjs"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 120_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
  assert.equal(report.slangVersion, "2026.10");
  assert.deepEqual(report.dagPasses.map(pass => pass.entry), ["computeMain", "computeMain"]);
  assert.ok(report.dagPasses.every(pass => pass.stage === "compute" && pass.threadGroupSize.join("x") === "64x1x1" && pass.spirvBytes > 0));
  assert.ok(report.vbufferPasses.every(pass => pass.entries.some(entry => entry.name === "meshMain" && entry.stage === "mesh")));
  assert.ok(report.vbufferPasses.every(pass => pass.entries.some(entry => entry.name === "pixelMain" && entry.stage === "fragment")));
  assert.ok(report.vbufferPasses.every(pass => pass.spirvBytes > 0));
});
