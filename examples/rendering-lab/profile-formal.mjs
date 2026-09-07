import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { validateIndependentBenchmarkRunGroup } from "../../OEngine/.test-dist/debug/BenchmarkEvidenceGate.js";
import {
  captureGitBuildProvenance,
  compareGitBuildProvenance
} from "../build-provenance.mjs";
import { resolveRenderingLabWorkload } from "./benchmark-workloads.ts";

const workloadId = process.argv[2] ?? "cube-near-effects-off";
resolveRenderingLabWorkload(workloadId);
const smoke = process.env.OENGINE_BENCHMARK_SMOKE === "true";
const width = Number(process.env.OENGINE_BENCHMARK_WIDTH ?? 1920);
const height = Number(process.env.OENGINE_BENCHMARK_HEIGHT ?? 1080);
const baseUrl = process.env.OENGINE_RENDERING_LAB_BASE_URL ?? "http://127.0.0.1:5173";
const runGroupId = randomUUID();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runnerProvenance = captureGitBuildProvenance(repoRoot);
const outputDir = path.join(repoRoot, "temp", "visibility-to-surface", runGroupId);
await mkdir(outputDir, { recursive: true });

const runs = [];
const browserErrors = [];
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
    await page.goto(`${baseUrl}/rendering-lab/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector("#showcase")?.dataset.state === "ready",
      null,
      { timeout: 120_000 }
    );
    const report = await page.evaluate(async ({ workloadId, runGroupId, runOrdinal, smoke }) => {
      const fixture = window.__OENGINE_RENDERING_LAB_FIXTURE__;
      if (!fixture) throw new Error("Rendering Lab fixture bridge missing");
      return fixture.runBenchmark({
        smoke,
        workloadId,
        runGroupId,
        runOrdinal,
        inspectorVisible: false
      });
    }, { workloadId, runGroupId, runOrdinal, smoke });
    await page.screenshot({
      path: path.join(outputDir, `run-${runOrdinal}.png`),
      fullPage: true
    });
    runs.push(report);
  } finally {
    await browser.close();
  }
}

const runGroupEvidence = validateIndependentBenchmarkRunGroup(
  runs.map((report) => report.measurement)
);
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
  runGroupId,
  smoke,
  width,
  height,
  runGroupEvidence,
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
  runGroupEvidence,
  provenanceErrors,
  gateErrors
}, null, 2));
