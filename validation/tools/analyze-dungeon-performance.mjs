import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const dir = resolve(process.argv[2] ?? ".local/validation/dungeon-performance-near-final-2026-10-10");
const suite = JSON.parse(await readFile(resolve(dir, "suite.json"), "utf8"));
function stats(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const p = (q) => v[Math.max(0, Math.ceil(v.length * q) - 1)],
    mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    n: v.length,
    min: v[0],
    mean,
    p50: p(0.5),
    p90: p(0.9),
    p95: p(0.95),
    p99: p(0.99),
    max: v.at(-1),
    sd: Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length),
    over16_67Percent: (v.filter((x) => x > 1000 / 60).length / v.length) * 100,
    over33_33Percent: (v.filter((x) => x > 1000 / 30).length / v.length) * 100,
    over50Percent: (v.filter((x) => x > 50).length / v.length) * 100
  };
}
const sum = (r) => Object.values(r).reduce((s, v) => s + (v ?? 0), 0);
const result = {
  schema: "dungeon-performance-analysis-v1",
  profileFile: process.argv[3] ?? "cpu.cpuprofile",
  chrome: suite.chromeVersion,
  options: suite.options,
  captures: [],
  errors: suite.errors,
  loading: {
    phases: suite.load.report.phases,
    firstUsefulMs: suite.load.report.load.firstUsefulMs,
    fullQualityMs: suite.load.report.load.fullQualityMs,
    longTasks: stats(suite.load.longTasks.map((t) => t.duration)),
    longTaskSumMs: suite.load.longTasks.reduce((s, t) => s + t.duration, 0)
  }
};
for (const item of suite.captures) {
  const c = JSON.parse(await readFile(resolve(dir, item.file), "utf8"));
  const frames = c.raw.frames.filter((f) => f.frameIndex >= c.targetStart && f.frameIndex < c.targetEnd),
    gpu = frames.filter((f) => f.gpu.sampled && !f.gpu.pending && !f.counters["gpu.timing.truncated"]),
    full = gpu.filter((f) => f.gpu.mode === "full");
  const submitted = c.raw.callbacks.filter(
    (v) => v.submitted && v.frameIndex >= c.targetStart && v.frameIndex < c.targetEnd
  );
  const intervals = submitted.slice(1).map((v, i) => v.atMs - submitted[i].atMs);
  function aggregate(rows, fn) {
    const map = {};
    for (const r of rows) {
      const v = fn(r);
      for (const [k, value] of Object.entries(v)) (map[k] ??= []).push(value);
    }
    return Object.fromEntries(
      Object.entries(map)
        .map(([k, v]) => [k, stats(v)])
        .sort((a, b) => b[1].mean - a[1].mean)
    );
  }
  const passes = aggregate(full, (f) => {
    const v = {};
    for (const s of f.gpu.segments)
      if (s.scope === "pass" || s.scope == null) v[s.label] = (v[s.label] ?? 0) + s.durationMs;
    return v;
  });
  const stages = aggregate(full, (f) => f.gpu.cost?.stageMs ?? {}),
    cpu = aggregate(frames, (f) => f.cpuMs),
    commands = aggregate(frames, (f) => f.counters);
  const sensors = suite.sensors.filter((s) => s.at >= c.start && s.at <= c.end && !s.error);
  const os = suite.osSamples.filter((s) => s.at >= c.start && s.at <= c.end && !s.error);
  const m = (x) => Object.fromEntries(x.metrics.map((v) => [v.name, v.value])),
    before = m(c.before),
    after = m(c.after),
    metricDelta = {};
  for (const k of [
    "TaskDuration",
    "ScriptDuration",
    "LayoutDuration",
    "RecalcStyleDuration",
    "JSHeapUsedSize",
    "JSHeapTotalSize"
  ])
    metricDelta[k] = after[k] - before[k];
  const elapsed = (c.end - c.start) / 1000;
  const resources =
      c.gpuResources?.resources
        .filter((r) => !r.destroyed)
        .map((r) =>
          r.bytes === null && r.format === "rgba32uint"
            ? {
                ...r,
                bytes: Array.from(
                  { length: r.mipLevelCount },
                  (_, m) =>
                    Math.max(1, r.width >> m) *
                    Math.max(1, r.height >> m) *
                    r.depthOrArrayLayers *
                    r.sampleCount *
                    16
                ).reduce((a, b) => a + b, 0),
                reconstructedFormatBytes: true
              }
            : r
        ) ?? [],
    allocationGroups = {};
  const correctedBytes = resources.filter((r) => r.reconstructedFormatBytes).reduce((n, r) => n + r.bytes, 0);
  for (const r of resources) {
    const label = r.label || "(unlabelled)",
      group = label.split("/")[0];
    const v = (allocationGroups[group] ??= { bytes: 0, count: 0, labels: {} });
    v.bytes += r.bytes ?? 0;
    v.count++;
    v.labels[label] = (v.labels[label] ?? 0) + (r.bytes ?? 0);
  }
  const apiCalls = c.gpuResources?.calls.filter((v) => v.at >= c.pageStart && v.at <= c.pageEnd) ?? [];
  const gpuCounterValues = aggregate(
    frames.filter((f) => f.gpuCounters.sampled && !f.gpuCounters.pending),
    (f) => f.gpuCounters.values
  );
  const capture = {
    name: c.name,
    mode: c.mode,
    frameRange: [c.targetStart, c.targetEnd],
    cpuHost: stats(submitted.map((v) => v.cpuMs)),
    submissionInterval: stats(intervals),
    submissionFPS: intervals.length ? (intervals.length * 1000) / sum(intervals) : null,
    gpu: stats(gpu.map((f) => f.gpu.cost?.commandSpanMs)),
    gpuFull: stats(full.map((f) => f.gpu.cost?.commandSpanMs)),
    passSum: stats(full.map((f) => f.gpu.cost?.passSumMs)),
    outsidePass: stats(full.map((f) => f.gpu.cost?.outsidePassMs)),
    completion: stats(
      c.report.stable.submission.completionSamples
        .filter((s) => s.frameIndex >= c.targetStart && s.frameIndex < c.targetEnd)
        .map((s) => s.elapsedMs)
    ),
    stages,
    passes,
    cpu,
    commands,
    gpuCounterValues,
    cpuProcess: {
      elapsedSec: elapsed,
      metricDelta,
      mainThreadTaskCorePercent: (metricDelta.TaskDuration / elapsed) * 100,
      mainThreadScriptCorePercent: (metricDelta.ScriptDuration / elapsed) * 100
    },
    coverage: c.coverage,
    vsmHeaders: c.vsmHeaders,
    sensors: {
      n: sensors.length,
      temperatureC: stats(sensors.map((s) => s.temperatureC)),
      graphicsMHz: stats(sensors.map((s) => s.graphicsMHz)),
      gpuUtil: stats(sensors.map((s) => s.gpuUtilPercent)),
      powerW: stats(sensors.map((s) => s.powerW)),
      deviceMemoryMiB: stats(sensors.map((s) => s.memoryUsedMiB)),
      thermalActivePercent: sensors.length
        ? (sensors.filter((s) => s.swThermal === "Active" || s.hwThermal === "Active").length /
            sensors.length) *
          100
        : null
    },
    memory: {
      engineMiB: c.report.memory.allocatedBytes / 1048576,
      geometryMiB: c.report.geometry.totalBytes / 1048576,
      independentGpuMiB: (c.gpuResources?.bytes + correctedBytes) / 1048576,
      independentPeakLowerBoundMiB: c.gpuResources?.peakBytes / 1048576,
      formatCorrectionMiB: correctedBytes / 1048576,
      unknownFormats: resources.filter((r) => r.bytes === null).map((r) => r.format),
      geometryPages: c.report.geometryPages,
      jsHeap: c.after.heap,
      os: os.map((s) => ({
        at: s.at,
        workingSetMiB: s.processes.reduce((n, p) => n + p.WorkingSet64, 0) / 1048576,
        privateCommitMiB: s.processes.reduce((n, p) => n + p.PrivateMemorySize64, 0) / 1048576,
        dedicatedMiB: s.gpuProcessMemory.reduce((n, p) => n + p.DedicatedUsage, 0) / 1048576,
        sharedMiB: s.gpuProcessMemory.reduce((n, p) => n + p.SharedUsage, 0) / 1048576
      }))
    },
    allocationGroups: Object.fromEntries(
      Object.entries(allocationGroups).sort((a, b) => b[1].bytes - a[1].bytes)
    ),
    steadyApiCalls: {
      counts: apiCalls.reduce((r, c) => ((r[c.method] = (r[c.method] ?? 0) + 1), r), {}),
      hostMs: sum(apiCalls.map((c) => c.hostMs)),
      labels: [...new Set(apiCalls.map((c) => c.label))]
    },
    longTasks: c.longTasks.filter((t) => t.startTime >= c.pageStart && t.startTime <= c.pageEnd),
    state: c.report.renderState,
    graph: c.raw.graph?.resources,
    streaming: c.report.streaming,
    spikes: full
      .slice()
      .sort((a, b) => b.gpu.cost.commandSpanMs - a.gpu.cost.commandSpanMs)
      .slice(0, 5)
      .map((f) => ({
        frame: f.frameIndex,
        span: f.gpu.cost.commandSpanMs,
        passSum: f.gpu.cost.passSumMs,
        outside: f.gpu.cost.outsidePassMs,
        top: f.gpu.segments
          .filter((s) => s.scope === "pass")
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, 5)
      }))
  };
  const processRows = suite.processSamples.filter((s) => s.at >= c.start && s.at <= c.end);
  if (processRows.length >= 2) {
    const first = processRows[0],
      last = processRows.at(-1),
      base = new Map(first.processInfo.map((p) => [p.id, p])),
      seconds = (last.at - first.at) / 1000,
      byType = {};
    for (const p of last.processInfo) {
      const b = base.get(p.id);
      if (!b) continue;
      byType[p.type] = (byType[p.type] ?? 0) + ((p.cpuTime - b.cpuTime) / seconds) * 100;
    }
    capture.cpuProcess.osCorePercentByType = byType;
    capture.cpuProcess.osSampleElapsedSec = seconds;
  }
  result.captures.push(capture);
}
try {
  const profile = JSON.parse(await readFile(resolve(dir, process.argv[3] ?? "cpu.cpuprofile"), "utf8"));
  const require = createRequire(resolve(import.meta.dirname, "../../examples/package.json"));
  const { TraceMap, originalPositionFor } = require("@jridgewell/trace-mapping");
  const assetsDir = resolve(
    import.meta.dirname,
    "../../examples/demos/14-integrated/dungeon-warkarma-texture-compression/dist/assets"
  );
  const maps = new Map(),
    nodes = new Map(profile.nodes.map((n) => [n.id, n])),
    self = {},
    parents = new Map();
  for (const n of profile.nodes) for (const child of n.children ?? []) parents.set(child, n.id);
  async function label(n) {
    const cf = n.callFrame;
    if (!cf.url) return cf.functionName || "(native)";
    const name = cf.url.split("/").at(-1);
    if (name?.endsWith(".js")) {
      if (!maps.has(name)) {
        let raw;
        try {
          raw = await readFile(resolve(dir, "maps", name + ".map"), "utf8");
        } catch {
          try {
            raw = await readFile(resolve(assetsDir, name + ".map"), "utf8");
          } catch {}
        }
        maps.set(name, raw ? new TraceMap(JSON.parse(raw)) : null);
      }
      const map = maps.get(name);
      if (map) {
        const p = originalPositionFor(map, { line: cf.lineNumber + 1, column: cf.columnNumber });
        if (p.source) return `${p.source}:${p.line} ${p.name ?? cf.functionName}`;
      }
    }
    return `${cf.url}:${cf.lineNumber + 1} ${cf.functionName}`;
  }
  const labels = new Map();
  for (const n of profile.nodes) labels.set(n.id, await label(n));
  const inclusive = {};
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i],
      ms = profile.timeDeltas[i] / 1000;
    self[labels.get(id)] = (self[labels.get(id)] ?? 0) + ms;
    let cursor = id;
    const seen = new Set();
    while (cursor) {
      const l = labels.get(cursor);
      if (!seen.has(l)) {
        inclusive[l] = (inclusive[l] ?? 0) + ms;
        seen.add(l);
      }
      cursor = parents.get(cursor);
    }
  }
  result.cpuProfile = {
    durationMs: (profile.endTime - profile.startTime) / 1000,
    samples: profile.samples.length,
    self: Object.entries(self).sort((a, b) => b[1] - a[1]),
    inclusive: Object.entries(inclusive).sort((a, b) => b[1] - a[1])
  };
} catch (e) {
  result.cpuProfileError = String(e);
}
await writeFile(
  resolve(dir, process.argv[3] ? "loading-analysis.json" : "analysis.json"),
  JSON.stringify(result, null, 2)
);
console.log(
  JSON.stringify(
    result.captures.map((c) => ({
      name: c.name,
      coverage: c.coverage?.ratio,
      cpu: c.cpuHost?.p50,
      interval: c.submissionInterval?.p50,
      p95: c.submissionInterval?.p95,
      fps: c.submissionFPS,
      gpu: c.gpu?.p50,
      gpu95: c.gpu?.p95,
      temp: c.sensors.temperatureC?.p50,
      clock: c.sensors.graphicsMHz?.p50,
      VRAM: c.memory.os.at(-1)?.dedicatedMiB,
      allocated: c.memory.independentGpuMiB
    })),
    null,
    2
  )
);
