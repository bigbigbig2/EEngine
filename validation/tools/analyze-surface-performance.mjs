import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { summarizeCapture } from "../../examples/demos/14-integrated/next-renderer-showcase/BenchmarkMetrics.ts";
import { distribution } from "../../examples/demos/14-integrated/shared/PerformanceMetrics.ts";

const path = resolve(process.argv[2] ?? "missing-suite.json");
const suite = JSON.parse(await readFile(path, "utf8"));
if (suite.schema !== "eengine-surface-performance-suite-v1") throw new Error("Unexpected suite schema");
const rows = suite.captures.map(capture => {
  const summary = summarizeCapture(capture.frames);
  const sensors = suite.sensors.samples.filter(sample => sample.queryEndUnixMs >= capture.captureStartUnixMs && sample.queryStartUnixMs <= capture.captureEndUnixMs);
  return { mode: capture.mode, batch: capture.batch, coverageGroup: capture.coverageGroup, coverageRange: capture.measuredCoverageRange, complete: capture.complete, summary,
    sensorWindow: { count: sensors.length, graphicsMHz: distribution(sensors.map(sample => sample.graphicsMHz)),
      temperatureC: distribution(sensors.map(sample => sample.temperatureC)),
      gpuUuids: [...new Set(sensors.map(sample => sample.uuid))] } };
});
const conditionsKey = capture => { const { shaderMode, ...rest } = capture.conditions; return JSON.stringify(rest); };
const sensitivities = [];
for (const capture of suite.captures.filter(c => c.mode !== "production")) {
  const baseline = suite.captures.find(c => c.mode === "production" && c.batch === capture.batch && conditionsKey(c) === conditionsKey(capture));
  if (!baseline || !baseline.complete || !capture.complete) { sensitivities.push({ mode: capture.mode, batch: capture.batch, coverageGroup: capture.coverageGroup, usable: false, reason: "No complete same-condition baseline" }); continue; }
  const worker = frame => frame.gpu.segments.filter(s => s.label.endsWith("Surface/material and lighting samples")).reduce((sum, s) => sum + s.durationMs, 0);
  const left = distribution(baseline.frames.map(worker)), right = distribution(capture.frames.map(worker));
  const visibility = c => summarizeCapture(c.frames).counters.surfaceVisiblePixels;
  const a = visibility(baseline), b = visibility(capture);
  const sameVisibility = a && b ? a.min === a.max && b.min === b.max && a.min === b.min : null;
  sensitivities.push({ mode: capture.mode, batch: capture.batch, coverageGroup: capture.coverageGroup, usable: sameVisibility === true,
    sameVisiblePixelCount: sameVisibility, baselineWorkerMs: left, diagnosticWorkerMs: right,
    workerP50Ratio: left && right ? right.p50 / left.p50 : null,
    interpretation: "Sensitivity only: shader DCE, registers, occupancy and changed downstream color prevent additive cost attribution or quality-equivalent speedup claims" });
}
const analysis = { schema: "eengine-surface-performance-analysis-v1", evidenceRole: "diagnostic", accepted: false,
  rows, sensitivities, suiteErrors: suite.errors, limitations: [
    "gpuPassSumMs measures pass intervals, not queue wall time or FPS",
    "No slow frames removed; percentile sample count is reported",
    "Sensor windows are coarse CPU encode/result-observation associations, not calibrated GPU UTC timestamps",
    "Multiple GPU sensor records are not automatically attributed to the WebGPU adapter",
    "Ablations alter execution and some alter image; only production captures with identical conditions can evaluate an optimization",
    "Same visible-pixel count is a coverage check, not proof of identical VisibilityKey images"
  ] };
await writeFile(resolve(dirname(path), "analysis.json"), JSON.stringify(analysis, null, 2));
const fmt = value => value == null ? "—" : value.toFixed(3);
const lines = ["# Surface 性能定位记录", "", `Revision: ${suite.revision}；浏览器: ${suite.browser}；仅诊断，accepted=false。`, "",
  "| Batch / 占用组 / 实验 | 实测占用 | 完成 GPU 帧 | Worker P50 ms | GPU pass 合计 P50 / P95 ms | GPU 温度 P50 / 时钟 P50 |", "| --- | ---: | ---: | ---: | ---: | ---: |"];
for (const row of rows) {
  const worker = row.summary.passes.find(pass => pass.label.endsWith("Surface/material and lighting samples"));
  lines.push(`| ${row.batch + 1} / ${row.coverageGroup ?? "legacy"} / ${row.mode}${row.complete ? "" : " (失败)"} | ${row.coverageRange ? row.coverageRange.map(value => (value * 100).toFixed(2)).join("–") + "%" : "未知"} | ${row.summary.completedGpu}/${row.summary.submitted} | ${fmt(worker?.p50)} | ${fmt(row.summary.gpuPassSumMs?.p50)} / ${fmt(row.summary.gpuPassSumMs?.p95)} | ${fmt(row.sensorWindow.temperatureC?.p50)} °C / ${fmt(row.sensorWindow.graphicsMHz?.p50)} MHz |`);
}
lines.push("", "耗时差只表示对被移除工作的敏感程度。DCE、寄存器、占用率、输出颜色及温控变化会影响结果，不能相加拆分原 shader，也不能当作完整画质优化收益。", "",
  "完整逐帧结果、同帧 counters、提交数、图结构、相机矩阵、源码 hash 和 GPU 传感器区间见 suite.json/source-fingerprint.json；所有慢帧保留。", "",
  ...(suite.errors.length ? ["运行错误：", ...suite.errors.map(error => `- ${error}`)] : ["运行错误：无。"]));
await writeFile(resolve(dirname(path), "analysis.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
