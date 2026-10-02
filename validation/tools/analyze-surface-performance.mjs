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
const conditionsKey = capture => { const { shaderMode, surfaceMode, ...rest } = capture.conditions; return JSON.stringify(rest); };
const sensitivities = [];
for (const capture of suite.captures.filter(c => c.mode === "detailed")) {
  const timing = suite.captures.find(c => c.mode === "timing" && c.batch === capture.batch && c.coverageGroup === capture.coverageGroup && conditionsKey(c) === conditionsKey(capture));
  if (!timing || !timing.complete || !capture.complete) {
    sensitivities.push({ mode: capture.mode, batch: capture.batch, coverageGroup: capture.coverageGroup, usable: false, reason: "No complete same-condition timing capture" });
    continue;
  }
  const left = summarizeCapture(timing.frames), right = summarizeCapture(capture.frames);
  sensitivities.push({ mode: "detailed-over-timing", batch: capture.batch, coverageGroup: capture.coverageGroup, usable: true,
    timingSurfaceP50: left.surfacePassSumMs?.p50 ?? null, detailedSurfaceP50: right.surfacePassSumMs?.p50 ?? null,
    timingFrameP50: left.gpuPassSumMs?.p50 ?? null, detailedFrameP50: right.gpuPassSumMs?.p50 ?? null,
    surfaceOverheadRatio: left.surfacePassSumMs && right.surfacePassSumMs ? right.surfacePassSumMs.p50 / left.surfacePassSumMs.p50 : null,
    interpretation: "Detailed mode overhead; counters are diagnostic until every sampled frame reports pass coverage and an available snapshot" });
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
const lines = ["# Surface V3 性能测量记录", "", `Revision: ${suite.revision}；浏览器: ${suite.browser}；仅诊断，accepted=false。`, "",
  "| Batch / 占用组 / 模式 | 实测占用 | 完成 GPU 帧 | Surface 合计 P50 / P95 ms | Surface span P50 / P95 ms | GPU pass 合计 P50 / P95 ms |", "| --- | ---: | ---: | ---: | ---: | ---: |"];
for (const row of rows) {
  lines.push(`| ${row.batch + 1} / ${row.coverageGroup ?? "unknown"} / ${row.mode}${row.complete ? "" : " (失败)"} | ${row.coverageRange ? row.coverageRange.map(value => (value * 100).toFixed(2)).join("–") + "%" : "未知"} | ${row.summary.completedGpu}/${row.summary.submitted} | ${fmt(row.summary.surfacePassSumMs?.p50)} / ${fmt(row.summary.surfacePassSumMs?.p95)} | ${fmt(row.summary.surfaceSpanMs?.p50)} / ${fmt(row.summary.surfaceSpanMs?.p95)} | ${fmt(row.summary.gpuPassSumMs?.p50)} / ${fmt(row.summary.gpuPassSumMs?.p95)} |`);
}
lines.push("", "耗时差只表示对被移除工作的敏感程度。DCE、寄存器、占用率、输出颜色及温控变化会影响结果，不能相加拆分原 shader，也不能当作完整画质优化收益。", "",
  "完整逐帧结果、同帧 counters、提交数、图结构、相机矩阵、源码 hash 和 GPU 传感器区间见 suite.json/source-fingerprint.json；所有慢帧保留。", "",
  ...(suite.errors.length ? ["运行错误：", ...suite.errors.map(error => `- ${error}`)] : ["运行错误：无。"]));
await writeFile(resolve(dirname(path), "analysis.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
