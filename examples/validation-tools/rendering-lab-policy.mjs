import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  validateIndependentBenchmarkRunGroup
} from "../../OEngine/.test-dist/debug/BenchmarkEvidenceGate.js";
import {
  evaluateSurfaceAbiV2RunGroupNeed,
  evaluateTileBackendRunGroupNeed,
  evaluateTriangleSetupDefaultNeed
} from "../../OEngine/.test-dist/debug/VisibilitySurfaceMigrationGates.js";
import {
  captureGitBuildProvenance,
  compareGitBuildProvenance
} from "../build-provenance.mjs";
import { resolveRenderingLabWorkload } from "../rendering-lab/benchmark-workloads.ts";
import { hasBrowserErrors } from "./browser-errors.mjs";
import { formalFailureReasons } from "./formal-result.mjs";

const READY_TIMEOUT_MS = 120_000;
const VALID_BACKENDS = new Set(["auto", "class-depth", "class-discard"]);

export async function runRenderingLabPolicy({ mode, runner, baseUrl, repositoryRoot, args = [] }) {
  if (!runner.browserIdentity.realChrome) {
    return { status: "inconclusive", reason: "Rendering Lab policies require local Google Chrome" };
  }
  if (mode === "profiles") return runProfiles({ runner, baseUrl, repositoryRoot, args });
  if (mode === "workload") return runWorkloadSmoke({ runner, baseUrl });
  if (mode === "oracle") return runVisibilityKeyOracle({ runner, baseUrl });
  if (mode === "formal") return runFormal({ runner, baseUrl, repositoryRoot, args });
  throw new Error(`Unknown Rendering Lab policy '${mode}'`);
}

async function runProfiles({ runner, baseUrl, repositoryRoot, args }) {
  const width = positiveNumber(args[0] ?? 1920, "width");
  const height = positiveNumber(args[1] ?? 1080, "height");
  const session = await runner.createPage({ viewport: { width, height } });
  try {
    await openRenderingLab(session.page, baseUrl);
    const reports = await session.page.evaluate(async () => {
      const fixture = window.__OENGINE_RENDERING_LAB_FIXTURE__;
      if (!fixture) throw new Error("Rendering Lab fixture bridge missing");
      const cases = ["base", "full"];
      const visible = await fixture.runBenchmark({ smoke: true, cases, cameraExperiment: "none", inspectorVisible: true });
      const hidden = await fixture.runBenchmark({ smoke: true, cases, cameraExperiment: "none", inspectorVisible: false });
      const counterCoverage = await fixture.runBenchmark({
        smoke: true,
        cases: ["full"],
        cameraExperiment: "none",
        inspectorVisible: false,
        gpuCounterSampleInterval: 1,
        readbackRingSlots: 64,
        awaitGpuEachFrame: true
      });
      await fixture.dispose?.();
      return { visible, hidden, counterCoverage };
    });
    requireCleanBrowser(session.errors);
    const outputPath = path.join(repositoryRoot, "temp", "validation", `rendering-lab-profiles-${width}x${height}.json`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify({ reports, errors: session.errors }, null, 2)}\n`);
    return { status: "passed", mode: "profiles", outputPath, reports: summarizeProfiles(reports) };
  } finally {
    await session.close();
  }
}

async function runWorkloadSmoke({ runner, baseUrl }) {
  const materialResolveBackend = benchmarkBackend();
  const session = await runner.createPage({ viewport: { width: 1920, height: 1080 } });
  try {
    await openRenderingLab(session.page, baseUrl, materialResolveBackend);
    const evidence = await session.page.evaluate(async ({ materialResolveBackend }) => {
      const fixture = window.__OENGINE_RENDERING_LAB_FIXTURE__;
      if (!fixture) throw new Error("Rendering Lab fixture bridge missing");
      const report = await fixture.runBenchmark({
        smoke: true,
        workloadId: "cube-near-effects-off",
        inspectorVisible: false
      });
      await fixture.dispose?.();
      return {
        workloadId: report.workload.id,
        caseIds: report.cases.map((entry) => entry.case.id),
        frameWorkloadIds: [...new Set(report.cases.flatMap((entry) =>
          entry.frames.map((frame) => frame.metadata?.workload?.id)
        ))],
        materialResolveBackend: report.domainEvidence?.migration?.materialResolveBackend,
        materialResolveBackendSource: report.domainEvidence?.migration?.materialResolveBackendSelection?.source,
        requestedBackend: materialResolveBackend
      };
    }, { materialResolveBackend });
    assertJsonEqual(evidence.workloadId, "cube-near-effects-off", "workload id");
    assertJsonEqual(evidence.caseIds, ["base"], "case ids");
    assertJsonEqual(evidence.frameWorkloadIds, ["cube-near-effects-off"], "frame workload metadata");
    if (materialResolveBackend !== "auto") {
      assertJsonEqual(evidence.materialResolveBackend, materialResolveBackend, "material backend");
      assertJsonEqual(evidence.materialResolveBackendSource, "benchmark-override", "material backend source");
    }
    requireCleanBrowser(session.errors);
    return { status: "passed", mode: "workload", evidence };
  } finally {
    await session.close();
  }
}

async function runVisibilityKeyOracle({ runner, baseUrl }) {
  const session = await runner.createPage();
  try {
    await session.page.goto(new URL("/rendering-lab/visibility-key-oracle.html", `${baseUrl}/`).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
    await session.page.waitForFunction(
      () => document.body.dataset.state === "ready" || document.body.dataset.state === "failed",
      null,
      { timeout: READY_TIMEOUT_MS }
    );
    const outcome = await session.page.evaluate(() => ({
      state: document.body.dataset.state,
      report: window.__OENGINE_VISIBILITY_KEY_ORACLE__,
      error: window.__OENGINE_VISIBILITY_KEY_ORACLE_ERROR__
    }));
    if (outcome.state !== "ready") throw new Error(outcome.error ?? JSON.stringify(outcome.report));
    if (outcome.report?.mismatchCount !== 0) {
      throw new Error(`VisibilityKey oracle mismatch count: ${String(outcome.report?.mismatchCount)}`);
    }
    requireCleanBrowser(session.errors);
    return { status: "passed", mode: "oracle", report: outcome.report };
  } finally {
    await session.close();
  }
}

async function runFormal({ runner, baseUrl, repositoryRoot, args }) {
  const workloadId = args[0] ?? "cube-near-effects-off";
  resolveRenderingLabWorkload(workloadId);
  const smoke = process.env.OENGINE_BENCHMARK_SMOKE === "true";
  const width = positiveNumber(process.env.OENGINE_BENCHMARK_WIDTH ?? 1920, "OENGINE_BENCHMARK_WIDTH");
  const height = positiveNumber(process.env.OENGINE_BENCHMARK_HEIGHT ?? 1080, "OENGINE_BENCHMARK_HEIGHT");
  const materialResolveBackend = benchmarkBackend();
  const triangleSetupEnabled = booleanEnvironment("OENGINE_TRIANGLE_SETUP_ENABLED", false);
  const triangleSetupThresholdPixels = nonNegativeNumber(
    process.env.OENGINE_TRIANGLE_SETUP_THRESHOLD_PIXELS ?? 32,
    "OENGINE_TRIANGLE_SETUP_THRESHOLD_PIXELS"
  );
  const awaitGpuEachFrame = booleanEnvironment("OENGINE_BENCHMARK_AWAIT_GPU", false);
  const runnerProvenance = captureGitBuildProvenance(repositoryRoot);
  if (runnerProvenance.dirty) {
    throw new Error(`Formal benchmark requires a clean worktree: ${runnerProvenance.dirtyReasons.join(" | ")}`);
  }

  const runGroupId = randomUUID();
  const outputDir = path.join(repositoryRoot, "temp", "visibility-to-surface", runGroupId);
  await mkdir(outputDir, { recursive: true });
  const common = {
    smoke,
    workloadId,
    runGroupId,
    inspectorVisible: false,
    readbackRingSlots: 64,
    triangleSetupEnabled,
    triangleSetupThresholdPixels,
    awaitGpuEachFrame
  };

  const preflight = await runBenchmarkSession({
    runner,
    baseUrl,
    viewport: { width, height },
    materialResolveBackend,
    options: { ...common, smoke: true, runGroupId: `preflight-${randomUUID()}`, runOrdinal: 0 }
  });
  requireCleanBrowser(preflight.errors);

  const runs = [];
  const browserErrors = [];
  for (let runOrdinal = 0; runOrdinal < 3; runOrdinal++) {
    const execution = await runBenchmarkSession({
      runner,
      baseUrl,
      viewport: { width, height },
      materialResolveBackend,
      options: { ...common, runOrdinal },
      screenshot: {
        page: path.join(outputDir, `run-${runOrdinal}.png`),
        canvas: path.join(outputDir, `canvas-${runOrdinal}.png`)
      }
    });
    browserErrors.push(...formatBrowserErrors(execution.errors, `run ${runOrdinal}`));
    execution.report.canvasSha256 = createHash("sha256")
      .update(await readFile(path.join(outputDir, `canvas-${runOrdinal}.png`)))
      .digest("hex");
    runs.push(execution.report);
  }

  const runGroupEvidence = validateIndependentBenchmarkRunGroup(runs.map((report) => report.measurement));
  const triangleSetupCaseId = workloadId === "comprehensive-full" ? "full" : "base";
  const triangleSetupGate = evaluateTriangleSetupDefaultNeed(
    runs.map((report) => triangleSetupRunEvidence(report, triangleSetupCaseId))
  );
  const migrationGates = {
    surfaceAbi: evaluateSurfaceAbiV2RunGroupNeed(runs.flatMap(surfaceAbiRunEvidence)),
    tileBackend: evaluateTileBackendRunGroupNeed(runs.flatMap(tileBackendRunEvidence))
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
    materialResolveBackend,
    triangleSetupEnabled,
    triangleSetupThresholdPixels,
    runGroupId,
    smoke,
    cadence: smoke ? { warmupFrames: 30, measuredFrames: 60 } : { warmupFrames: 120, measuredFrames: 480 },
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
  await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  const failures = formalFailureReasons({
    runGroupEvidence,
    browserErrors,
    provenanceErrors,
    gateErrors
  });
  if (failures.length > 0) throw new Error(`Formal benchmark failed — ${failures.join("; ")}`);
  return { status: "passed", mode: "formal", outputDir, ...artifact, runs: undefined };
}

async function runBenchmarkSession({ runner, baseUrl, viewport, materialResolveBackend, options, screenshot }) {
  const session = await runner.createPage({ viewport });
  try {
    await openRenderingLab(session.page, baseUrl, materialResolveBackend);
    await session.page.waitForTimeout(1500);
    const report = await session.page.evaluate(async (benchmarkOptions) => {
      const fixture = window.__OENGINE_RENDERING_LAB_FIXTURE__;
      if (!fixture) throw new Error("Rendering Lab fixture bridge missing");
      return fixture.runBenchmark(benchmarkOptions);
    }, options);
    if (screenshot !== undefined) {
      await session.page.screenshot({ path: screenshot.page, fullPage: true });
      await session.page.locator("#gpu-canvas").screenshot({ path: screenshot.canvas });
    }
    return { report, errors: session.errors };
  } finally {
    await session.page.evaluate(async () => {
      await window.__OENGINE_RENDERING_LAB_FIXTURE__?.dispose?.();
    }).catch(() => undefined);
    await session.close();
  }
}

async function openRenderingLab(page, baseUrl, materialResolveBackend = "auto") {
  const url = new URL("/rendering-lab/", `${baseUrl}/`);
  if (materialResolveBackend !== "auto") url.searchParams.set("materialResolveBackend", materialResolveBackend);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector("#showcase")?.dataset.state === "ready",
    null,
    { timeout: READY_TIMEOUT_MS }
  );
}

function requireCleanBrowser(errors) {
  if (hasBrowserErrors(errors)) throw new Error(`Browser errors: ${formatBrowserErrors(errors).join(" | ")}`);
}

function formatBrowserErrors(errors, prefix = "browser") {
  return [
    ...errors.console.map((message) => `${prefix} console: ${message}`),
    ...errors.page.map((message) => `${prefix} page: ${message}`),
    ...errors.request.map((message) => `${prefix} request: ${JSON.stringify(message)}`)
  ];
}

function summarizeProfiles(reports) {
  const summarize = (report) => report.cases.map((entry) => ({
    id: entry.case.id,
    cpuP50: entry.summary.cpuMs.frame?.p50 ?? null,
    gpuP50: entry.summary.gpuPhaseMs.frame?.p50 ?? null,
    sampledCounterFrames: entry.frames.filter((frame) => frame.gpuCounters.sampled).length,
    completedCounterFrames: entry.frames.filter((frame) => frame.gpuCounters.sampled && !frame.gpuCounters.pending && !frame.gpuCounters.dropped).length,
    droppedCounterFrames: entry.frames.filter((frame) => frame.gpuCounters.dropped).length
  }));
  return {
    visible: summarize(reports.visible),
    hidden: summarize(reports.hidden),
    counterCoverage: summarize(reports.counterCoverage)
  };
}

function triangleSetupRunEvidence(report, caseId) {
  const evidence = report?.domainEvidence?.triangleSetup?.cases?.[caseId];
  return {
    runId: report?.measurement?.runId,
    runGroupId: report?.measurement?.runGroupId,
    setupVisiblePixelHits: evidence?.setupVisiblePixelHits ?? 0,
    setupVisiblePixelFallbacks: evidence?.setupVisiblePixelFallbacks ?? 0,
    setupAttempted: evidence?.setupAttempted ?? 0,
    setupWritten: evidence?.setupWritten ?? 0,
    setupOverflow: evidence?.setupOverflow ?? 0
  };
}

function surfaceAbiRunEvidence(report) {
  return Array.isArray(report?.domainEvidence?.surfaceAbiRuns) ? report.domainEvidence.surfaceAbiRuns : [];
}

function tileBackendRunEvidence(report) {
  return Array.isArray(report?.domainEvidence?.tileBackendRuns) ? report.domainEvidence.tileBackendRuns : [];
}

function benchmarkBackend() {
  const value = process.env.OENGINE_MATERIAL_RESOLVE_BACKEND ?? "auto";
  if (!VALID_BACKENDS.has(value)) throw new Error(`Unsupported OENGINE_MATERIAL_RESOLVE_BACKEND: ${value}`);
  return value;
}

function booleanEnvironment(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be 'true' or 'false'`);
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive number`);
  return number;
}

function nonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return number;
}

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
