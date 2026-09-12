import type { FrameProfileSnapshot } from "../../debug/FrameProfiler.js";
import type { Renderer } from "../../render/Renderer.js";

export type RendererInfoAvailability =
  | "available"
  | "pending"
  | "unsupported"
  | "dropped"
  | "failed";

export interface RendererInfoValue {
  readonly display: string;
  readonly availability: RendererInfoAvailability;
}

export interface RendererInfoRow {
  readonly id: string;
  readonly label: string;
  readonly value: RendererInfoValue;
}

export type RendererInfoSectionId =
  | "overview"
  | "frame"
  | "pipeline"
  | "scene"
  | "lighting"
  | "resources"
  | "temporal"
  | "gpu"
  | "diagnostics";

export interface RendererInfoSection {
  readonly id: RendererInfoSectionId;
  readonly title: string;
  readonly rows: readonly RendererInfoRow[];
}

export interface RendererInfoSnapshot {
  readonly sampledFrame: number;
  readonly sections: readonly RendererInfoSection[];
}

const SECTION_TITLES: Readonly<Record<RendererInfoSectionId, string>> = Object.freeze({
  overview: "Overview",
  frame: "Frame",
  pipeline: "Pipeline",
  scene: "Scene & Geometry",
  lighting: "Lighting",
  resources: "Resources",
  temporal: "Temporal",
  gpu: "GPU",
  diagnostics: "Diagnostics"
});

export class RendererInfoModel {
  private latestCpu: FrameProfileSnapshot | undefined;
  private latestGpu: FrameProfileSnapshot | undefined;

  constructor(private readonly renderer: Renderer) {}

  consume(snapshot: FrameProfileSnapshot): void {
    if (this.latestCpu === undefined || snapshot.frameIndex >= this.latestCpu.frameIndex) {
      this.latestCpu = snapshot;
    }
    if (snapshot.gpu.sampled && !snapshot.gpu.pending &&
        (this.latestGpu === undefined || snapshot.frameIndex >= this.latestGpu.frameIndex)) {
      this.latestGpu = snapshot;
    }
  }

  snapshot(): RendererInfoSnapshot {
    const renderer = this.renderer;
    const frame = this.latestCpu ?? renderer.profiler.latest;
    if (frame !== undefined) this.consume(frame);
    const settings = renderer.render_settings;
    const temporal = renderer.temporalEvidence();
    const graph = renderer.mainFrameGraphEvidence();
    const owners = renderer.gpuOwnerCreationEvidence();
    const memory = renderer.memoryEvidence();
    const resources = renderer.graphics.profilingResourceSnapshot();
    const diagnostics = renderer.profiler.diagnostics;
    const gpuFrame = this.latestGpu;

    const rafMs = metric(frame, "frame.rafIntervalMs");
    const cpuMs = frame?.cpuMs.frame;
    const gpuMs = gpuFrame?.gpu.available
      ? gpuFrame.gpu.segments.reduce((sum, segment) => sum + segment.durationMs, 0)
      : undefined;
    const gpuAvailability: RendererInfoAvailability = !renderer.profiler.gpuTimestampAvailable
      ? "unsupported"
      : frame?.gpu.pending ? "pending"
      : gpuFrame === undefined ? "pending"
      : gpuFrame.gpu.available ? "available" : "failed";
    const livePasses = graph?.dump.passes.filter((pass) => !pass.culled) ?? [];
    const renderWorld = owners.renderWorld.sceneRegistryCreated
      ? renderer.gpuRenderWorldEvidence()
      : undefined;
    const gpuScene = owners.renderWorld.instanceTableCreated
      ? renderer.gpuSceneEvidence()
      : undefined;
    const assets = owners.renderWorld.assetStoreCreated
      ? renderer.geometryAssetResidencyEvidence()
      : undefined;
    const adapter = renderer.adapter_info;

    return Object.freeze({
      sampledFrame: frame?.frameIndex ?? renderer.frame_count,
      sections: Object.freeze([
        section("overview", [
          row("fps", "FPS", rafMs === undefined ? pending() : available(rafMs > 0 ? (1000 / rafMs).toFixed(1) : "—")),
          row("cpu", "CPU frame", measured(cpuMs, formatMs)),
          row("gpu", "GPU pass sum", gpuMs === undefined ? state(gpuAvailability) : value(gpuMs, gpuAvailability, formatMs)),
          row("resolution", "Output", available(`${temporal.outputWidth} × ${temporal.outputHeight}`)),
          row("internal", "Internal", available(`${temporal.internalWidth} × ${temporal.internalHeight} (${formatPercent(temporal.internalScale)})`)),
          row("profile", "Quality", available(settings.qualityProfile))
        ]),
        section("frame", [
          row("index", "Frame", available(String(frame?.frameIndex ?? renderer.frame_count))),
          row("submits", "Submits", measured(frame?.submits.count, formatInteger)),
          row("draws", "Draw calls", measured(metric(frame, "gpu.commands.draw"), formatInteger)),
          row("dispatches", "Dispatches", measured(metric(frame, "gpu.commands.dispatch"), formatInteger)),
          row("uploads", "Upload bytes", measured(frame?.uploads.bytes, formatBytes)),
          row("readbacks", "Readback bytes", measured(frame?.readbacks.bytes, formatBytes))
        ]),
        section("pipeline", [
          row("pass-count", "Active passes", graph === null ? pending() : available(String(livePasses.length))),
          row("passes", "Pass order", graph === null ? pending() : available(livePasses.map((pass) => pass.name).join(" → ") || "None")),
          row("output", "Output", graph === null ? pending() : available(`${graph.outputMode.toUpperCase()} / ${graph.outputFormat}`)),
          row("transients", "Live transients", graph === null ? pending() : available(String(graph.resources.liveTransient)))
        ]),
        section("scene", [
          row("scenes", "Packed scenes", measured(renderWorld?.sceneCount, formatInteger, "unsupported")),
          row("instances", "Instances", measured(renderWorld?.instanceCount, formatInteger, "unsupported")),
          row("active-instances", "Active instances", measured(gpuScene?.activeInstanceCount, formatInteger, "unsupported")),
          row("assets", "Resident geometry", measured(assets?.residentAssetCount, formatInteger, "unsupported")),
          row("geometry-bytes", "Geometry bytes", measured(assets?.residentBytes, formatBytes, "unsupported"))
        ]),
        section("lighting", [
          row("local-lights", "Local lights", measured(metric(frame, "lighting.localLightCount"), formatInteger)),
          row("clusters", "Light clusters", measured(metric(frame, "lighting.clusterCount"), formatInteger)),
          row("diffuse", "Screen diffuse", available(settings.features.screenSpaceDiffuseMode)),
          row("shadows", "Shadows", available(settings.features.shadows ? "Enabled" : "Disabled"))
        ]),
        section("resources", [
          row("tracked", "Tracked GPU resources", available(formatBytes(resources.totalBytes))),
          row("peak", "Tracked peak", available(formatBytes(resources.peakBytes))),
          row("allocated", "Allocator bytes", available(formatBytes(memory.allocatedBytes))),
          row("resident", "Resident logical", available(formatBytes(memory.residentLogicalBytes))),
          row("history", "History", available(formatBytes(memory.historyBytes))),
          row("transient", "Transient pool", available(formatBytes(memory.transientPoolBytes)))
        ]),
        section("temporal", [
          row("owner", "Reconstruction", available(temporal.reconstructionOwner)),
          row("history", "History", available(temporal.historyValid ? "Valid" : "Invalid")),
          row("generation", "Generation", available(String(temporal.historyGeneration))),
          row("invalidations", "Invalidations", available(String(temporal.historyInvalidations))),
          row("drs", "Dynamic resolution", available(temporal.drsMode)),
          row("drs-decision", "Last DRS decision", available(temporal.drsLastDecision))
        ]),
        section("gpu", [
          row("adapter", "Adapter", adapter === null ? unsupported() : available(adapter.description || adapter.device || "Unnamed adapter")),
          row("vendor", "Vendor", adapter === null ? unsupported() : available(adapter.vendor || "Unknown")),
          row("architecture", "Architecture", adapter === null ? unsupported() : available(adapter.architecture || "Unknown")),
          row("features", "WebGPU features", available(String(renderer.capabilities.features.length))),
          row("timestamps", "Timestamp query", available(renderer.profiler.gpuTimestampAvailable ? "Supported" : "Unsupported"))
        ]),
        section("diagnostics", [
          row("validation", "Validation errors", available(String(diagnostics.validationErrorCount))),
          row("uncaptured", "Uncaptured errors", available(String(diagnostics.uncapturedErrorCount))),
          row("device-lost", "Device lost", available(String(diagnostics.deviceLostCount))),
          row("timestamp-failed", "Failed timestamp batches", available(String(diagnostics.failedGpuTimestampBatches))),
          row("counter-dropped", "Dropped counter samples", value(diagnostics.droppedGpuCounterSamples, diagnostics.droppedGpuCounterSamples > 0 ? "dropped" : "available", formatInteger)),
          row("counter-failed", "Failed counter samples", value(diagnostics.failedGpuCounterSamples, diagnostics.failedGpuCounterSamples > 0 ? "failed" : "available", formatInteger))
        ])
      ])
    });
  }
}

function section(id: RendererInfoSectionId, rows: RendererInfoRow[]): RendererInfoSection {
  return Object.freeze({ id, title: SECTION_TITLES[id], rows: Object.freeze(rows) });
}

function row(id: string, label: string, value: RendererInfoValue): RendererInfoRow {
  return Object.freeze({ id, label, value });
}

function metric(snapshot: FrameProfileSnapshot | undefined, id: string): number | undefined {
  return snapshot?.counters[id];
}

function available(display: string): RendererInfoValue {
  return Object.freeze({ display, availability: "available" });
}

function pending(): RendererInfoValue {
  return state("pending");
}

function unsupported(): RendererInfoValue {
  return state("unsupported");
}

function state(availability: RendererInfoAvailability): RendererInfoValue {
  const labels: Record<RendererInfoAvailability, string> = {
    available: "Available",
    pending: "Pending",
    unsupported: "Unsupported",
    dropped: "Dropped",
    failed: "Failed"
  };
  return Object.freeze({ display: labels[availability], availability });
}

function measured(
  input: number | undefined,
  formatter: (value: number) => string,
  missing: RendererInfoAvailability = "pending"
): RendererInfoValue {
  return input === undefined ? state(missing) : available(formatter(input));
}

function value(
  input: number,
  availability: RendererInfoAvailability,
  formatter: (value: number) => string
): RendererInfoValue {
  return Object.freeze({ display: formatter(input), availability });
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
