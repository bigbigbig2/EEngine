import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { validateIndependentBenchmarkRunGroup } from "../../OEngine/.test-dist/debug/BenchmarkEvidenceGate.js";
import {
  evaluateSurfaceAbiV2RunGroupNeed,
  evaluateTileBackendRunGroupNeed,
  evaluateTriangleSetupDefaultNeed
} from "../../OEngine/.test-dist/debug/VisibilitySurfaceMigrationGates.js";
import {
  captureGitBuildProvenance,
  compareGitBuildProvenance
} from "../build-provenance.mjs";
import { resolveRenderingLabWorkload } from "./benchmark-workloads.ts";

const workloadId = process.argv[2] ?? "cube-near-effects-off";
resolveRenderingLabWorkload(workloadId);
const smoke = process.env.OENGINE_BENCHMARK_SMOKE === "true";
const awaitGpuEachFrame = process.env.OENGINE_BENCHMARK_AWAIT_GPU === "true";
const width = Number(process.env.OENGINE_BENCHMARK_WIDTH ?? 1920);
const height = Number(process.env.OENGINE_BENCHMARK_HEIGHT ?? 1080);
const baseUrl = process.env.OENGINE_RENDERING_LAB_BASE_URL ?? "http://127.0.0.1:5173";
const surfaceAbiProfile = process.env.OENGINE_SURFACE_ABI_PROFILE ?? "v1";
if (surfaceAbiProfile !== "v1" && surfaceAbiProfile !== "v2-candidate") {
  throw new Error(`Unsupported OENGINE_SURFACE_ABI_PROFILE: ${surfaceAbiProfile}`);
}
const materialResolveBackend = process.env.OENGINE_MATERIAL_RESOLVE_BACKEND ?? "auto";
if (!["auto", "class-depth", "class-discard"].includes(materialResolveBackend)) {
  throw new Error(`Unsupported OENGINE_MATERIAL_RESOLVE_BACKEND: ${materialResolveBackend}`);
}
const triangleSetupEnabled = parseBooleanEnvironment(
  "OENGINE_TRIANGLE_SETUP_ENABLED",
  false
);
const triangleSetupThresholdPixels = Number(
  process.env.OENGINE_TRIANGLE_SETUP_THRESHOLD_PIXELS ?? 32
);
if (!Number.isFinite(triangleSetupThresholdPixels) || triangleSetupThresholdPixels < 0) {
  throw new Error("OENGINE_TRIANGLE_SETUP_THRESHOLD_PIXELS must be a non-negative number");
}
const runGroupId = randomUUID();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runnerProvenance = captureGitBuildProvenance(repoRoot);
const outputDir = path.join(repoRoot, "temp", "visibility-to-surface", runGroupId);
await mkdir(outputDir, { recursive: true });

const runs = [];
const browserErrors = [];
// Warm the selected backend once so first-use shader/frame-graph compilation
// cannot change the first measured session's visibility result. This run is
// deliberately excluded from the formal three-session artifact.
{
  const browser = await chromium.launch({
    channel: "chrome",
    headless: process.env.OENGINE_HEADLESS !== "false",
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]
  });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`preflight console: ${message.text()}`);
    });
    page.on("pageerror", (error) => browserErrors.push(`preflight pageerror: ${error.message}`));
    const preflightUrl = new URL("/rendering-lab/", baseUrl);
    preflightUrl.searchParams.set("surfaceAbiProfile", surfaceAbiProfile);
    if (materialResolveBackend !== "auto") preflightUrl.searchParams.set("materialResolveBackend", materialResolveBackend);
    await page.goto(preflightUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector("#showcase")?.dataset.state === "ready",
      null,
      { timeout: 120_000 }
    );
    await page.waitForTimeout(1500);
    const fixture = await page.evaluateHandle(() => window.__OENGINE_RENDERING_LAB_FIXTURE__);
    await page.evaluate(async ({ fixture, workloadId, triangleSetupEnabled, triangleSetupThresholdPixels, awaitGpuEachFrame }) => {
      if (!fixture) throw new Error("Rendering Lab fixture bridge missing during preflight");
      await fixture.runBenchmark({
        smoke: true,
        workloadId,
        runGroupId: `preflight-${crypto.randomUUID()}`,
        runOrdinal: -1,
        inspectorVisible: false,
        readbackRingSlots: 64,
        triangleSetupEnabled,
        triangleSetupThresholdPixels,
        awaitGpuEachFrame
      });
    }, { fixture, workloadId, triangleSetupEnabled, triangleSetupThresholdPixels, awaitGpuEachFrame });
    await fixture.dispose().catch(() => {});
  } finally {
    await browser.close();
  }
}
for (let runOrdinal = 0; runOrdinal < 3; runOrdinal++) {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: process.env.OENGINE_HEADLESS !== "false",
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]
  });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`run ${runOrdinal} console: ${message.text()}`);
    });
    page.on("pageerror", (error) => browserErrors.push(`run ${runOrdinal} pageerror: ${error.message}`));
    const renderingLabUrl = new URL("/rendering-lab/", baseUrl);
    renderingLabUrl.searchParams.set("surfaceAbiProfile", surfaceAbiProfile);
    if (materialResolveBackend !== "auto") {
      renderingLabUrl.searchParams.set("materialResolveBackend", materialResolveBackend);
    }
    await page.goto(renderingLabUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector("#showcase")?.dataset.state === "ready",
      null,
      { timeout: 120_000 }
    );
    // Let the ready page finish its startup render/pipeline warm-up before the
    // benchmark controller starts its measured epoch. This is outside the
    // formal 120+480 cadence and prevents first-session initialization from
    // contaminating visibility parity.
    await page.waitForTimeout(1500);
    const report = await page.evaluate(async ({
      workloadId,
      runGroupId,
      runOrdinal,
      smoke,
      triangleSetupEnabled,
      triangleSetupThresholdPixels
      ,awaitGpuEachFrame
    }) => {
      const fixture = window.__OENGINE_RENDERING_LAB_FIXTURE__;
      if (!fixture) throw new Error("Rendering Lab fixture bridge missing");
      return fixture.runBenchmark({
        smoke,
        workloadId,
        runGroupId,
        runOrdinal,
        inspectorVisible: false,
        // Formal cadence is non-blocking; keep enough staging slots to avoid
        // turning a slow adapter into artificial dropped-counter evidence.
        readbackRingSlots: 64,
        triangleSetupEnabled,
        triangleSetupThresholdPixels,
        awaitGpuEachFrame
      });
    }, {
      workloadId,
      runGroupId,
      runOrdinal,
      smoke,
      triangleSetupEnabled,
      triangleSetupThresholdPixels,
      awaitGpuEachFrame
    });
    await page.screenshot({
      path: path.join(outputDir, `run-${runOrdinal}.png`),
      fullPage: true
    });
    const canvasPath = path.join(outputDir, `canvas-${runOrdinal}.png`);
    await page.locator("#gpu-canvas").screenshot({ path: canvasPath });
    const canvasSha256 = createHash("sha256")
      .update(await readFile(canvasPath))
      .digest("hex");
    report.canvasSha256 = canvasSha256;
    runs.push(report);
  } finally {
    await browser.close();
  }
}

const runGroupEvidence = validateIndependentBenchmarkRunGroup(
  runs.map((report) => report.measurement)
);
const triangleSetupCaseId = workloadId === "comprehensive-full" ? "full" : "base";
const triangleSetupGate = evaluateTriangleSetupDefaultNeed(
  runs.map((report) => triangleSetupRunEvidence(report, triangleSetupCaseId))
);
const migrationGates = {
  surfaceAbiV2: evaluateSurfaceAbiV2RunGroupNeed(
    runs.flatMap((report) => surfaceAbiRunEvidence(report))
  ),
  tileBackend: evaluateTileBackendRunGroupNeed(
    runs.flatMap((report) => tileBackendRunEvidence(report))
  )
};
const provenanceErrors = runs.flatMap((report, runOrdinal) =>
  compareGitBuildProvenance(runnerProvenance, report.environment.engine)
    .map((code) => `run ${runOrdinal}: ${code}`)
);
const gateErrors = runs.flatMap((report, runOrdinal) =>
  Object.entries(report.evidence).flatMap(([caseId, evidence]) =>
    evidence.errors.map((issue) => `run ${runOrdinal}/${caseId}: ${issue.code}`)
  )
);
const artifact = {
  schemaVersion: 1,
  workloadId,
  surfaceAbiProfile,
  materialResolveBackend,
  triangleSetupEnabled,
  triangleSetupThresholdPixels,
  runGroupId,
  smoke,
  width,
  height,
  runGroupEvidence,
  triangleSetupCaseId,
  triangleSetupGate,
  migrationGates,
  provenanceErrors,
  browserErrors,
  gateErrors,
  runs
};
await writeFile(
  path.join(outputDir, "report.json"),
  `${JSON.stringify(artifact, null, 2)}\n`
);

if (!runGroupEvidence.gateEligible) {
  throw new Error(`Independent run group failed: ${JSON.stringify(runGroupEvidence.errors)}`);
}
if (browserErrors.length > 0) {
  throw new Error(`Browser errors: ${browserErrors.join(" | ")}`);
}
if (provenanceErrors.length > 0) {
  throw new Error(`Stale build provenance: ${provenanceErrors.join(" | ")}`);
}
console.log(JSON.stringify({
  outputDir,
  workloadId,
  smoke,
  materialResolveBackend,
  triangleSetupEnabled,
  triangleSetupThresholdPixels,
  runGroupEvidence,
  triangleSetupGate,
  migrationGates,
  provenanceErrors,
  gateErrors
}, null, 2));

function triangleSetupRunEvidence(report, caseId) {
  const triangleSetup = report?.domainEvidence?.triangleSetup?.cases?.[caseId];
  return {
    runId: report?.measurement?.runId,
    runGroupId: report?.measurement?.runGroupId,
    setupVisiblePixelHits: triangleSetup?.setupVisiblePixelHits ?? 0,
    setupVisiblePixelFallbacks: triangleSetup?.setupVisiblePixelFallbacks ?? 0,
    setupAttempted: triangleSetup?.setupAttempted ?? 0,
    setupWritten: triangleSetup?.setupWritten ?? 0,
    setupOverflow: triangleSetup?.setupOverflow ?? 0
  };
}

function surfaceAbiRunEvidence(report) {
  const runs = report?.domainEvidence?.surfaceAbiRuns;
  return Array.isArray(runs) ? runs : [];
}

function tileBackendRunEvidence(report) {
  const runs = report?.domainEvidence?.tileBackendRuns;
  return Array.isArray(runs) ? runs : [];
}

function parseBooleanEnvironment(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be 'true' or 'false'`);
}
