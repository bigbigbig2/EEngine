import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const width = Number(process.argv[2] ?? 1920);
const height = Number(process.argv[3] ?? 1080);
const baseUrl = process.env.OENGINE_RENDERING_LAB_BASE_URL ?? "http://127.0.0.1:5173";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputDir = path.join(repoRoot, "temp");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: process.env.OENGINE_HEADLESS !== "false",
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

try {
  await page.goto(`${baseUrl}/rendering-lab/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector("#showcase")?.dataset.state === "ready",
    null,
    { timeout: 120_000 }
  );
  const reports = await page.evaluate(async () => {
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
    return { visible, hidden, counterCoverage };
  });
  const result = { reports, errors };
  await writeFile(path.join(outputDir, `rendering-lab-profiles-${width}x${height}.json`), `${JSON.stringify(result, null, 2)}\n`);
  const summarize = (report) => report.cases.map((entry) => ({
    id: entry.case.id,
    cpuP50: entry.summary.cpuMs.frame?.p50 ?? null,
    gpuP50: entry.summary.gpuPhaseMs.frame?.p50 ?? null,
    sampledCounterFrames: entry.frames.filter((frame) => frame.gpuCounters.sampled).length,
    completedCounterFrames: entry.frames.filter((frame) => frame.gpuCounters.sampled && !frame.gpuCounters.pending && !frame.gpuCounters.dropped).length,
    droppedCounterFrames: entry.frames.filter((frame) => frame.gpuCounters.dropped).length
  }));
  console.log(JSON.stringify({
    errors,
    visible: { measurement: reports.visible.measurement, cases: summarize(reports.visible) },
    hidden: { measurement: reports.hidden.measurement, cases: summarize(reports.hidden) },
    counterCoverage: { measurement: reports.counterCoverage.measurement, cases: summarize(reports.counterCoverage) }
  }, null, 2));
} finally {
  await browser.close();
}
