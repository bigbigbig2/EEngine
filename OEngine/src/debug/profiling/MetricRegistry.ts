import {
  freezeMetricDescriptor,
  type MetricDescriptor,
  type MetricSample
} from "./Metric.js";
export { summarizeMetricCoverage, summarizeProfileSeries } from "./ProfileStatistics.js";

export type MetricDescriptorInput = MetricDescriptor;

export const CPU_SECTION_METRIC_IDS: Readonly<Record<string, string>> = Object.freeze({
  "graph-build": "cpu.graphBuildMs",
  "graph-compile": "cpu.graphCompileMs",
  "graph-execute": "cpu.graphExecuteMs",
  "graphics-update": "cpu.graphicsUpdateMs",
  "queue-submit": "cpu.queueSubmitMs",
  "world-and-view-update": "cpu.worldAndViewUpdateMs"
});

export const DEFAULT_METRIC_DESCRIPTORS: readonly MetricDescriptor[] = Object.freeze([
  descriptor("frame.rafIntervalMs", "RAF interval", "frame", "ms", "browser-observer", "measured", "low", "frame", "last", "Browser RAF callback interval."),
  descriptor("cpu.frameMs", "CPU frame", "cpu", "ms", "cpu-clock", "measured", "low", "frame", "last", "OEngine render call wall time."),
  ...Object.entries(CPU_SECTION_METRIC_IDS).map(([section, id]) =>
    descriptor(id, `CPU ${section}`, "cpu", "ms", "cpu-clock", "measured", "low", "frame", "sum", `Wall time accumulated for the '${section}' CPU section.`)
  ),
  descriptor("gpu.passSumMs", "GPU Pass Sum", "gpu", "ms", "gpu-timestamp", "measured", "instrumented", "frame", "sum", "Sum of instrumented GPU pass durations; not complete GPU frame time."),
  descriptor("io.uploadBytes", "Upload bytes", "io", "bytes", "engine-accounting", "counted", "low", "frame", "sum", "Bytes submitted through tracked upload paths."),
  descriptor("io.readbackBytes", "Readback bytes", "io", "bytes", "engine-accounting", "counted", "low", "frame", "sum", "Bytes copied into tracked readback paths."),
  descriptor("queue.submitCount", "Queue submits", "queue", "count", "engine-accounting", "counted", "low", "frame", "sum", "Command queue submit calls observed by OEngine."),
  descriptor("framegraph.buildCount", "FrameGraph builds", "framegraph", "count", "engine-accounting", "counted", "low", "frame", "sum", "FrameGraph build operations."),
  descriptor("framegraph.compileCount", "FrameGraph compiles", "framegraph", "count", "engine-accounting", "counted", "low", "frame", "sum", "FrameGraph compile operations."),
  descriptor("framegraph.executeCount", "FrameGraph executes", "framegraph", "count", "engine-accounting", "counted", "low", "frame", "sum", "Executable FrameGraph runs."),
  descriptor("framegraph.cache.hitCount", "FrameGraph cache hits", "framegraph", "count", "engine-accounting", "counted", "low", "frame", "sum", "FrameGraph cache hits."),
  descriptor("framegraph.cache.missCount", "FrameGraph cache misses", "framegraph", "count", "engine-accounting", "counted", "low", "frame", "sum", "FrameGraph cache misses."),
  ...pipelineDescriptors("render"),
  ...pipelineDescriptors("compute"),
  descriptor("memory.resident.accountedBytes", "Resident accounted bytes", "memory", "bytes", "engine-accounting", "estimated", "low", "resource-lifetime", "last", "OEngine-owned resident bytes; not physical VRAM."),
  descriptor("profiler.readbackBytes", "Profiler readback bytes", "profiler", "bytes", "engine-accounting", "counted", "instrumented", "frame", "sum", "Bytes used by profiler readback operations."),
  descriptor("profiler.overheadMs", "Profiler overhead", "profiler", "ms", "cpu-clock", "measured", "instrumented", "frame", "last", "CPU time attributable to profiling instrumentation.")
]);

function pipelineDescriptors(kind: "render" | "compute"): readonly MetricDescriptor[] {
  const label = kind === "render" ? "Render" : "Compute";
  return [
    descriptor(`pipeline.${kind}.cacheHits`, `${label} pipeline cache hits`, "pipeline", "count", "engine-accounting", "counted", "low", "frame", "sum", `Cached ${kind} pipeline obtains.`),
    descriptor(`pipeline.${kind}.cacheMisses`, `${label} pipeline cache misses`, "pipeline", "count", "engine-accounting", "counted", "low", "frame", "sum", `Uncached ${kind} pipeline obtains.`),
    descriptor(`pipeline.${kind}.createCount`, `${label} pipeline creates`, "pipeline", "count", "engine-accounting", "counted", "low", "frame", "sum", `Synchronous WebGPU ${kind} pipeline creation calls.`),
    descriptor(`pipeline.${kind}.firstUseCount`, `${label} pipeline first uses`, "pipeline", "count", "engine-accounting", "counted", "low", "frame", "sum", `First obtain of a ${kind} pipeline cache key.`),
    descriptor(`pipeline.${kind}.hostCallMs`, `${label} pipeline host call`, "pipeline", "ms", "cpu-clock", "measured", "low", "frame", "sum", `Host time inside create${label}Pipeline; native compilation may be lazy and is not proven complete.`)
  ];
}

export class MetricRegistry {
  private readonly descriptors = new Map<string, MetricDescriptor>();

  constructor(initial: readonly MetricDescriptor[] = []) {
    for (const descriptor of initial) this.register(descriptor);
  }

  register(input: MetricDescriptorInput): MetricDescriptor {
    validateDescriptor(input);
    const existing = this.descriptors.get(input.id);
    if (existing !== undefined) {
      if (!sameDescriptor(existing, input)) {
        throw new Error(`Metric descriptor conflict for '${input.id}'`);
      }
      return existing;
    }
    const descriptor = freezeMetricDescriptor(input);
    this.descriptors.set(descriptor.id, descriptor);
    return descriptor;
  }

  get(id: string): MetricDescriptor | undefined {
    return this.descriptors.get(id);
  }

  has(id: string): boolean {
    return this.descriptors.has(id);
  }

  values(): readonly MetricDescriptor[] {
    return Object.freeze([...this.descriptors.values()].sort((a, b) => a.id.localeCompare(b.id)));
  }

  require(id: string): MetricDescriptor {
    const descriptor = this.get(id);
    if (descriptor === undefined) throw new Error(`Unknown metric '${id}'`);
    return descriptor;
  }
}

function descriptor(
  id: string,
  label: string,
  group: string,
  unit: MetricDescriptor["unit"],
  source: MetricDescriptor["source"],
  measurement: MetricDescriptor["measurement"],
  cost: MetricDescriptor["cost"],
  scope: MetricDescriptor["scope"],
  aggregation: MetricDescriptor["aggregation"],
  description: string
): MetricDescriptor {
  return Object.freeze({ id, label, group, unit, source, measurement, cost, scope, aggregation, description });
}

function validateDescriptor(descriptor: MetricDescriptor): void {
  for (const [name, value] of Object.entries(descriptor)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`Metric ${name} must be a non-empty string`);
    }
  }
  if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*$/.test(descriptor.id)) {
    throw new TypeError(`Metric id '${descriptor.id}' is not stable`);
  }
  assertOneOf(descriptor.unit, ["ms", "bytes", "count", "ratio", "pixels", "triangles"], "unit");
  assertOneOf(descriptor.source, ["cpu-clock", "gpu-timestamp", "gpu-counter", "engine-accounting", "browser-observer"], "source");
  assertOneOf(descriptor.measurement, ["measured", "counted", "derived", "estimated"], "measurement");
  assertOneOf(descriptor.cost, ["none", "low", "instrumented"], "cost");
  assertOneOf(descriptor.scope, ["frame", "pass", "resource-lifetime", "capture"], "scope");
  assertOneOf(descriptor.aggregation, ["last", "sum", "max", "min", "mean", "percentile"], "aggregation");
}

function assertOneOf<T extends string>(value: string, allowed: readonly T[], name: string): asserts value is T {
  if (!allowed.includes(value as T)) throw new TypeError(`Metric ${name} '${value}' is invalid`);
}

function sameDescriptor(a: MetricDescriptor, b: MetricDescriptor): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type { MetricDescriptor, MetricSample };
