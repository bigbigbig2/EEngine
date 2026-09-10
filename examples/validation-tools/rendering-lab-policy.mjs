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
  if (mode === "dev") return runDevProfile({ runner, baseUrl, repositoryRoot, args });
  if (mode === "workload") return runWorkloadSmoke({ runner, baseUrl });
  if (mode === "pipeline-matrix") return runPipelineMatrix({ runner, baseUrl, repositoryRoot });
  if (mode === "shadow-feature-off") return runShadowFeatureOff({ runner, baseUrl, repositoryRoot });
  if (mode === "oracle") return runVisibilityKeyOracle({ runner, baseUrl });
  if (mode === "formal") return runFormal({ runner, baseUrl, repositoryRoot, args });
  throw new Error(`Unknown Rendering Lab policy '${mode}'`);
}

const PIPELINE_MATRIX_CASES = Object.freeze([
  "base",
  "full",
  "full-minus-shadow",
  "full-minus-gtao",
  "full-minus-ssr",
  "full-minus-transparency",
  "full-minus-temporal",
  "full-minus-bloom",
  "full-minus-exposure",
  "full-minus-motion-blur",
  "full-minus-sharpen"
]);

async function runPipelineMatrix({ runner, baseUrl, repositoryRoot }) {
  const session = await runner.createPage({ viewport: { width: 1920, height: 1080 } });
  try {
    await openRenderingLab(session.page, baseUrl);
    const report = await session.page.evaluate(async ({ cases }) => {
      const fixture = window.__OENGINE_RENDERING_LAB_FIXTURE__;
      if (!fixture) throw new Error("Rendering Lab fixture bridge missing");
      const result = await fixture.runBenchmark({
        smoke: true,
        workloadId: "comprehensive-full",
        cases,
        inspectorVisible: false,
        gpuCounterSampleInterval: 8,
        readbackRingSlots: 64,
        cpuPassTimings: true,
        awaitGpuEachFrame: true,
        animateScene: true
      });
      await fixture.dispose?.();
      return result;
    }, { cases: PIPELINE_MATRIX_CASES });
    requireCleanBrowser(session.errors);
    assertJsonEqual(report.cases.map((entry) => entry.case.id), PIPELINE_MATRIX_CASES, "pipeline matrix cases");

    const evidence = report.cases.map((entry) => {
      const invalidFrames = entry.frames.filter((frame) =>
        frame.submits.count !== 1 || frame.graph.executes !== 1 ||
        frame.graph.builds !== 0 || frame.graph.compiles !== 0 ||
        frame.graph.cacheHits !== 1 || frame.graph.cacheMisses !== 0
      ).length;
      const overflowMaximums = Object.fromEntries(Object.entries(entry.summary.gpuCounters)
        .filter(([name]) => /overflow/i.test(name))
        .map(([name, summary]) => [name, summary.max]));
      if (invalidFrames !== 0 || Object.values(overflowMaximums).some((value) => value !== 0)) {
        throw new Error(`Pipeline matrix case '${entry.case.id}' failed stable-frame invariants`);
      }
      return {
        caseId: entry.case.id,
        measuredFrames: entry.frames.length,
        mainSubmitP50: entry.summary.submits.p50,
        invalidStableFrames: invalidFrames,
        overflowMaximums
      };
    });
    const outputPath = path.join(repositoryRoot, "temp", "validation", "rendering-lab-pipeline-matrix.json");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify({ report, evidence, errors: session.errors }, null, 2)}\n`);
    return { status: "passed", mode: "pipeline-matrix", outputPath, evidence };
  } finally {
    await session.close();
  }
}

async function runShadowFeatureOff({ runner, baseUrl, repositoryRoot }) {
  const session = await runner.createPage({ viewport: { width: 1920, height: 1080 } });
  try {
    await openRenderingLab(session.page, baseUrl);
    const reports = await session.page.evaluate(async () => {
      const fixture = window.__OENGINE_RENDERING_LAB_FIXTURE__;
      if (!fixture) throw new Error("Rendering Lab fixture bridge missing");
      const common = {
        smoke: true,
        workloadId: "comprehensive-full",
        inspectorVisible: false,
        gpuCounterSampleInterval: 8,
        readbackRingSlots: 64,
        cpuPassTimings: true,
        awaitGpuEachFrame: true,
        animateScene: true
      };
      const full = await fixture.runBenchmark({ ...common, cases: ["full"] });
      const off = await fixture.runBenchmark({ ...common, cases: ["full-minus-shadow"] });
      await fixture.dispose?.();
      return { full, off };
    });
    requireCleanBrowser(session.errors);

    const evidence = {
      workloadId: reports.full.workload.id,
      full: summarizeShadowFeatureCase(reports.full, "full"),
      off: summarizeShadowFeatureCase(reports.off, "full-minus-shadow")
    };
    assertJsonEqual(evidence.workloadId, "comprehensive-full", "shadow comparison workload id");
    assertShadowFeatureComparison(evidence);

    const outputPath = path.join(repositoryRoot, "temp", "validation", "rendering-lab-shadow-feature-off.json");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify({ reports, evidence, errors: session.errors }, null, 2)}\n`);
    return { status: "passed", mode: "shadow-feature-off", outputPath, evidence };
  } finally {
    await session.close();
  }
}

function summarizeShadowFeatureCase(report, caseId) {
  const result = report.cases.find((entry) => entry.case.id === caseId);
  if (result === undefined) throw new Error(`Rendering Lab report omitted '${caseId}'`);
  const graph = report.domainEvidence?.graph?.dump;
  const executable = new Set(graph?.executablePassOrder ?? []);
  const passNames = (graph?.passes ?? [])
    .filter((entry) => executable.has(entry.id))
    .map((entry) => entry.name);
  const owners = report.domainEvidence?.resourceAccounting?.owners ?? {};
  const shadowOwnerNames = Object.keys(owners).filter((name) => /shadow/i.test(name));
  const frameLabels = result.frames.flatMap((frame) => [
    ...Object.keys(frame.uploads.labels),
    ...Object.keys(frame.readbacks.labels)
  ]);
  const shadowCounterMaximums = Object.fromEntries(Object.entries(result.summary.gpuCounters)
    .filter(([name]) => /shadow|cascade/i.test(name))
    .map(([name, summary]) => [name, summary.max]));
  const shadowGpuPassLabels = Object.keys(result.summary.gpuMs)
    .filter((name) => /shadow|cascade/i.test(name));
  return {
    caseId,
    mainSubmitP50: result.summary.submits.p50,
    gpuShadowPhaseP50: result.summary.gpuPhaseMs.shadow?.p50 ?? null,
    cpuShadowSetupP50: result.summary.cpuMs["shadow-update"]?.p50 ?? null,
    allocatedBytes: report.domainEvidence?.memory?.allocatedBytes ?? null,
    residentBytes: report.domainEvidence?.memory?.residentLogicalBytes ?? null,
    transientPoolBytes: report.domainEvidence?.memory?.transientPoolBytes ?? null,
    historyBytes: report.domainEvidence?.memory?.historyBytes ?? null,
    accountedBytes: report.domainEvidence?.resourceAccounting?.totalBytes ?? null,
    atlasBytes: report.domainEvidence?.resourceAccounting?.categories?.atlas?.bytes ?? 0,
    shadowOwner: report.domainEvidence?.ownerCreation?.shadow ?? null,
    shadowGpuPassLabels,
    shadowPassNames: passNames.filter((name) => /shadow/i.test(name)),
    shadowIoLabels: [...new Set(frameLabels.filter((name) => /shadow/i.test(name)))],
    shadowResourceOwners: shadowOwnerNames,
    shadowCounterMaximums
  };
}

function assertShadowFeatureComparison(evidence) {
  if (evidence.full.mainSubmitP50 !== 1 || evidence.off.mainSubmitP50 !== 1) {
    throw new Error(`Shadow comparison must retain one main submit: ${JSON.stringify(evidence)}`);
  }
  if (!(evidence.full.gpuShadowPhaseP50 > 0) || !(evidence.full.cpuShadowSetupP50 >= 0)) {
    throw new Error(`Enabled shadow metrics are missing: ${JSON.stringify(evidence.full)}`);
  }
  const owner = evidence.off.shadowOwner;
  if (evidence.off.gpuShadowPhaseP50 !== null || evidence.off.cpuShadowSetupP50 !== null ||
      evidence.off.atlasBytes !== 0 || evidence.off.shadowPassNames.length !== 0 ||
      evidence.off.shadowGpuPassLabels.length !== 0 ||
      evidence.off.shadowIoLabels.length !== 0 || evidence.off.shadowResourceOwners.length !== 0 ||
      owner === null || owner.featureCount !== 0 || owner.atlasCount !== 0 ||
      owner.workSetCount !== 0 || owner.workBytes !== 0 ||
      Object.values(evidence.off.shadowCounterMaximums).some((value) => value !== 0)) {
    throw new Error(`Disabled shadow feature retained work or resources: ${JSON.stringify(evidence.off)}`);
  }
}

async function runDevProfile({ runner, baseUrl, repositoryRoot, args }) {
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
    const outputPath = path.join(repositoryRoot, "temp", "validation", `rendering-lab-dev-${width}x${height}.json`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify({ reports, errors: session.errors }, null, 2)}\n`);
    return { status: "passed", mode: "dev", outputPath, reports: summarizeProfiles(reports) };
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
