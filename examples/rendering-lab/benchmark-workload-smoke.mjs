import { chromium } from "playwright";

const baseUrl = process.env.OENGINE_RENDERING_LAB_BASE_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]
});

try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl}/rendering-lab/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector("#showcase")?.dataset.state === "ready",
    null,
    { timeout: 120_000 }
  );
  const evidence = await page.evaluate(async () => {
    const fixture = window.__OENGINE_RENDERING_LAB_FIXTURE__;
    if (!fixture) throw new Error("Rendering Lab fixture bridge missing");
    const report = await fixture.runBenchmark({
      smoke: true,
      workloadId: "cube-near-effects-off",
      inspectorVisible: false
    });
    return {
      workloadId: report.workload.id,
      caseIds: report.cases.map((entry) => entry.case.id),
      frameWorkloadIds: [...new Set(report.cases.flatMap((entry) =>
        entry.frames.map((frame) => frame.metadata?.workload?.id)
      ))]
    };
  });
  if (evidence.workloadId !== "cube-near-effects-off") {
    throw new Error(`Expected cube-near workload, got ${String(evidence.workloadId)}`);
  }
  if (JSON.stringify(evidence.caseIds) !== JSON.stringify(["base"])) {
    throw new Error(`Expected only base case, got ${JSON.stringify(evidence.caseIds)}`);
  }
  if (JSON.stringify(evidence.frameWorkloadIds) !== JSON.stringify(["cube-near-effects-off"])) {
    throw new Error(`Frame workload metadata mismatch: ${JSON.stringify(evidence.frameWorkloadIds)}`);
  }
} finally {
  await browser.close();
}
