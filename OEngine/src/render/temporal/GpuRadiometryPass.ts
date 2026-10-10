import { GpuBindGroupCache } from "../../gpu/GpuBindGroupResourceCache.js";
import type { FrameGraph } from "../../framegraph/FrameGraph.js";
import type { ResourceId } from "../../framegraph/ResourceHandle.js";
import type { ShadeGPUCommandContext } from "../../framegraph/ShadeGPUCommandContext.js";
import { resolveTextureView } from "../RenderTargetViews.js";

import {
  EXPOSURE_BIN_COUNT,
  EXPOSURE_STATE_BYTES,
  EXPOSURE_SETTINGS_BYTES,
  resolveExposureSettings,
  type ExposureSettings,
  type ExposureDiagnostics,
} from "./ExposureSettings.js";

const BIN_COUNT = EXPOSURE_BIN_COUNT;
const HISTOGRAM_BYTES = BIN_COUNT * 4;

export interface RadiometryProducts {
  readonly previousExposure: ResourceId;
  readonly adaptedExposure: ResourceId;
}

// Cost: same subsampled histogram + one reduce dispatch, same atomics and 4 KiB
// histogram. Reduce adds a sequential 1023-bin CDF, +3 KiB workgroup scratch,
// and 96 bytes/frame of settings. No new image, pipeline, submit or readback.
// Percentile idea: Timberdoodle 1987cf3b8ddda42585d2470bb5806efbc96c6cae,
// autoexposure.glsl (Apache-2.0). This weighted CDF/highlight policy is local.
const WGSL = /* wgsl */ `
const BIN_COUNT: u32 = 1024u;
struct Histogram {
  bins: array<atomic<u32>, 1024>,
}
struct Exposure {
  value: f32,
  luminance: f32,
  metered_luminance: f32,
  adapted_log: f32,
  target_log: f32,
  highlight_luminance: f32,
  selected_samples: f32,
  valid_samples: f32,
}
struct Settings {
  width: u32,
  height: u32,
  dt: f32,
  history_valid: u32,
  min_log: f32,
  max_log: f32,
  low_percentile: f32,
  high_percentile: f32,
  key: f32,
  speed_up: f32,
  speed_down: f32,
  highlight_percentile: f32,
  highlight_headroom: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: Histogram;
@group(0) @binding(2) var<uniform> settings: Settings;
@group(0) @binding(3) var<storage, read> pre_exposure: array<f32>;
var<workgroup> local_bins: array<atomic<u32>, 1024>;

@compute @workgroup_size(16, 16)
fn histogram_main(@builtin(global_invocation_id) id: vec3u,
                  @builtin(local_invocation_index) lane: u32) {
  for (var part = 0u; part < 4u; part++) {
    atomicStore(&local_bins[lane + part * 256u], 0u);
  }
  workgroupBarrier();
  let source = id.xy * 2u;
  if (source.x < settings.width && source.y < settings.height) {
    let color = max(textureLoad(scene, vec2i(source), 0).rgb, vec3f(0.0));
    let value = dot(color, vec3f(0.2627, 0.6780, 0.0593)) / max(pre_exposure[0], 1e-20);
    var bin = 0u;
    if (value > 0.0) {
      let unit = clamp((log2(value) - settings.min_log) /
        (settings.max_log - settings.min_log), 0.0, 1.0);
      bin = 1u + min(1022u, u32(unit * 1023.0));
    }
    atomicAdd(&local_bins[bin], 1u);
  }
  workgroupBarrier();
  for (var part = 0u; part < 4u; part++) {
    let bin = lane + part * 256u;
    atomicAdd(&histogram.bins[bin], atomicLoad(&local_bins[bin]));
  }
}

@group(1) @binding(0) var<storage, read_write> reduce_histogram: Histogram;
@group(1) @binding(1) var<storage, read> previous: Exposure;
@group(1) @binding(2) var<storage, read_write> next: Exposure;
@group(1) @binding(3) var<uniform> reduce_settings: Settings;
var<workgroup> counts: array<u32, 1024>;
var<workgroup> totals: array<u32, 256>;

@compute @workgroup_size(256)
fn reduce_main(@builtin(local_invocation_index) lane: u32) {
  var total = 0u;
  for (var part = 0u; part < 4u; part++) {
    let bin = lane + part * 256u;
    let count = atomicLoad(&reduce_histogram.bins[bin]);
    counts[bin] = count;
    if (bin != 0u) {
      total += count;
    }
  }
  totals[lane] = total;
  workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride /= 2u) {
    if (lane < stride) {
      totals[lane] += totals[lane + stride];
    }
    workgroupBarrier();
  }
  if (lane == 0u) {
    let usable = f32(totals[0]);
    var metered_log = previous.adapted_log;
    var target_log = previous.adapted_log;
    var highlight_log = reduce_settings.min_log;
    var selected = 0.0;
    if (usable > 0.0) {
      let low = usable * reduce_settings.low_percentile;
      let high = usable * reduce_settings.high_percentile;
      let highlight_rank = usable * reduce_settings.highlight_percentile;
      var cumulative = 0.0;
      var weighted = 0.0;
      var found_highlight = false;
      for (var bin = 1u; bin < BIN_COUNT; bin++) {
        let end = cumulative + f32(counts[bin]);
        let amount = max(0.0, min(end, high) - max(cumulative, low));
        let log_value = reduce_settings.min_log + (f32(bin) - 0.5) / 1023.0 *
          (reduce_settings.max_log - reduce_settings.min_log);
        weighted += amount * log_value;
        selected += amount;
        if (!found_highlight && counts[bin] > 0u && end >= highlight_rank) {
          highlight_log = log_value;
          found_highlight = true;
        }
        cumulative = end;
      }
      metered_log = weighted / max(selected, 1e-6);
      target_log = max(metered_log, highlight_log - reduce_settings.highlight_headroom);
    }
    let speed = select(reduce_settings.speed_down, reduce_settings.speed_up,
      target_log > previous.adapted_log);
    let weight = 1.0 - exp(-reduce_settings.dt * speed);
    var adapted_log = mix(previous.adapted_log, target_log, weight);
    // First valid meter initializes immediately; history reset is exposure-owned.
    if (usable > 0.0 && reduce_settings.history_valid == 0u) {
      adapted_log = target_log;
    }
    next.adapted_log = adapted_log;
    next.luminance = exp2(adapted_log);
    next.value = reduce_settings.key / next.luminance;
    next.metered_luminance = exp2(metered_log);
    next.target_log = target_log;
    next.highlight_luminance = select(0.0, exp2(highlight_log), usable > 0.0);
    next.selected_samples = selected;
    next.valid_samples = usable;
  }
  workgroupBarrier();
  for (var part = 0u; part < 4u; part++) {
    atomicStore(&reduce_histogram.bins[lane + part * 256u], 0u);
  }
}
`;

type Pair = readonly [GPUBuffer, GPUBuffer];
type RadiometryResourceBinder = (
  name: string,
  resolve: (runtime: GpuRadiometryPass) => GPUBuffer,
) => ResourceId;

export class GpuRadiometryPass {
  private readonly bindGroups = new GpuBindGroupCache();
  private readonly layout0: GPUBindGroupLayout;
  private readonly layout1: GPUBindGroupLayout;
  private readonly histogramPipeline: GPUComputePipeline;
  private readonly reducePipeline: GPUComputePipeline;
  private readonly buffers: Pair;
  private prepared = false;
  private readIndex: 0 | 1 = 0;
  private writeIndex: 0 | 1 = 1;
  private historyValid = false;
  private deltaTime = 1 / 60;
  private resetPending = true;
  private destroyed = false;
  readonly settings: Readonly<ExposureSettings>;
  private readonly initialState: Float32Array<ArrayBuffer>;

  constructor(
    private readonly device: GPUDevice,
    private readonly autoExposure = true,
    private readonly fixedExposure = 1,
    settings: Partial<ExposureSettings> = {},
  ) {
    if (!Number.isFinite(fixedExposure) || fixedExposure < 1e-6 || fixedExposure > 64) {
      throw new RangeError("GPU radiometry fixed exposure must be in [1e-6, 64]");
    }
    if (
      device.limits.maxStorageBuffersPerShaderStage < 3 ||
      device.limits.maxComputeInvocationsPerWorkgroup < 256 ||
      device.limits.maxComputeWorkgroupSizeX < 256 ||
      device.limits.maxComputeWorkgroupSizeY < 16 ||
      device.limits.maxComputeWorkgroupStorageSize < 5120
    ) {
      throw new RangeError("GPU radiometry exceeds compute/storage limits");
    }
    this.settings = resolveExposureSettings(settings);
    const luminance = this.settings.keyValue / fixedExposure;
    this.initialState = new Float32Array([
      fixedExposure,
      luminance,
      luminance,
      Math.log2(luminance),
      Math.log2(luminance),
      0,
      0,
      0,
    ]);
    this.layout0 = device.createBindGroupLayout({
      label: "Radiometry/histogram layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      ],
    });
    this.layout1 = device.createBindGroupLayout({
      label: "Radiometry/reduce layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });
    const module = device.createShaderModule({ label: "Radiometry GPU P/E", code: WGSL });
    this.histogramPipeline = device.createComputePipeline({
      label: "Radiometry/histogram pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout0] }),
      compute: { module, entryPoint: "histogram_main" },
    });
    this.reducePipeline = device.createComputePipeline({
      label: "Radiometry/reduce pipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [device.createBindGroupLayout({ entries: [] }), this.layout1],
      }),
      compute: { module, entryPoint: "reduce_main" },
    });
    this.buffers = [0, 1].map((index) => {
      // Both exposure and adapted scene luminance survive in the device epoch.
      const buffer = device.createBuffer({
        label: `Radiometry/P-E/${index}`,
        size: EXPOSURE_STATE_BYTES,
        usage:
          GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true,
      });
      new Float32Array(buffer.getMappedRange()).set(this.initialState);
      buffer.unmap();
      return buffer;
    }) as unknown as Pair;
  }

  /** Exposure roles survive color/TAA resets, resizing and camera cuts.
   * A cut uses normal metering/adaptation; only resetExposure requests a reset. */
  prepareFrame(deltaTime = 1 / 60): void {
    if (this.destroyed || this.prepared) {
      throw new Error("GPU radiometry unavailable or already prepared");
    }
    this.prepared = true;
    this.deltaTime = Number.isFinite(deltaTime) ? Math.max(0, Math.min(1, deltaTime)) : 1 / 60;
    if (this.resetPending) {
      this.device.queue.writeBuffer(this.readBuffer(), 0, this.initialState);
    }
  }

  resetExposure(): void {
    if (this.prepared || this.destroyed) {
      throw new Error("Cannot reset exposure during a prepared frame or after destruction");
    }
    this.historyValid = false;
    this.resetPending = true;
  }

  private frameSettings(width: number, height: number): ArrayBuffer {
    const values = new Float32Array(EXPOSURE_SETTINGS_BYTES / 4);
    const words = new Uint32Array(values.buffer);
    words[0] = width;
    words[1] = height;
    values[2] = this.deltaTime;
    words[3] = Number(this.historyValid);
    const s = this.settings;
    values.set(
      [
        s.minLogLuminance,
        s.maxLogLuminance,
        s.lowPercentile,
        s.highPercentile,
        s.keyValue,
        s.speedUp,
        s.speedDown,
        s.highlightPercentile,
        s.highlightHeadroom,
      ],
      4,
    );
    return values.buffer;
  }

  /** Explicit one-shot diagnostic. One 32-byte copy/readback; never frame control.
   * Returns the last submitted state; device loss propagates as a rejected promise. */
  async readDiagnostics(): Promise<ExposureDiagnostics> {
    if (this.destroyed) {
      throw new Error("GPU radiometry is destroyed");
    }
    const historyValid = this.historyValid;
    const source = this.readBuffer();
    const staging = this.device.createBuffer({
      label: "Radiometry/one-shot diagnostic",
      size: EXPOSURE_STATE_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = this.device.createCommandEncoder({ label: "Radiometry/one-shot diagnostic" });
      encoder.copyBufferToBuffer(source, 0, staging, 0, EXPOSURE_STATE_BYTES);
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const v = new Float32Array(staging.getMappedRange());
      return Object.freeze({
        autoExposure: this.autoExposure,
        historyValid,
        exposure: v[0]!,
        adaptedLuminance: v[1]!,
        meteredLuminance: v[2]!,
        adaptedLogLuminance: v[3]!,
        targetLogLuminance: v[4]!,
        highlightLuminance: v[5]!,
        selectedSamples: v[6]!,
        validSamples: v[7]!,
      });
    } finally {
      staging.destroy();
    }
  }

  readBuffer(): GPUBuffer {
    return this.buffers[this.readIndex];
  }
  writeBuffer(): GPUBuffer {
    return this.buffers[this.writeIndex];
  }
  importPreviousExposure(graph: FrameGraph, bind: RadiometryResourceBinder): ResourceId {
    void graph;
    return bind("previous-exposure", (runtime) => runtime.readBuffer());
  }
  importPriorExposure(graph: FrameGraph, bind: RadiometryResourceBinder): ResourceId {
    void graph;
    return bind("prior-exposure", (runtime) => runtime.writeBuffer());
  }

  addToGraph(
    graph: FrameGraph,
    input: {
      scene: ResourceId;
      width: number;
      height: number;
      previousExposure?: ResourceId;
      priorExposure?: ResourceId;
    },
    bind: RadiometryResourceBinder,
  ): RadiometryProducts {
    if (!this.prepared) throw new Error("GPU radiometry must be prepared before graph build");
    const previousExposure = input.previousExposure ?? this.importPreviousExposure(graph, bind);
    // Both history slots start at fixedExposure and remain constant without an adaptation writer.
    // Reuse the same exposure for pre-exposure and display, including after history resets.
    if (!this.autoExposure) return { previousExposure, adaptedExposure: previousExposure };
    const priorExposure = input.priorExposure ?? this.importPriorExposure(graph, bind);
    const makeSettings = () => this.frameSettings(input.width, input.height);
    let histogram = -1;
    const meter = graph.add("Radiometry/HDR histogram", input, (data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const constants = command.allocateTransientBufferAndLoad(makeSettings(), GPUBufferUsage.UNIFORM);
      const group = this.bindGroups.create(this.device, {
        layout: this.layout0,
        entries: [
          { binding: 0, resource: resolveTextureView(resources.get(data.scene)) },
          { binding: 1, resource: { buffer: resources.get(histogram) as GPUBuffer } },
          { binding: 2, resource: { buffer: constants } },
          { binding: 3, resource: { buffer: resources.get(previousExposure) as GPUBuffer } },
        ],
      });
      const pass = command.beginComputePass({ label: "Radiometry/HDR histogram" });
      pass.setPipeline(this.histogramPipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(data.width / 32), Math.ceil(data.height / 32));
      pass.end();
    });
    histogram = meter.create("Radiometry/histogram", {
      kind: "transient_buffer",
      size: HISTOGRAM_BYTES,
      usage: GPUBufferUsage.STORAGE,
      ensure_cleared: [0, HISTOGRAM_BYTES],
    });
    meter.read(input.scene);
    meter.read(previousExposure);
    const reduce = graph.add("Radiometry/adapt exposure", {}, (_data, resources, context) => {
      const command = context.encoder as ShadeGPUCommandContext;
      const constants = command.allocateTransientBufferAndLoad(makeSettings(), GPUBufferUsage.UNIFORM);
      const group = this.bindGroups.create(this.device, {
        layout: this.layout1,
        entries: [
          { binding: 0, resource: { buffer: resources.get(histogram) as GPUBuffer } },
          { binding: 1, resource: { buffer: resources.get(previousExposure) as GPUBuffer } },
          { binding: 2, resource: { buffer: resources.get(priorExposure) as GPUBuffer } },
          { binding: 3, resource: { buffer: constants } },
        ],
      });
      const pass = command.beginComputePass({ label: "Radiometry/adapt exposure" });
      pass.setPipeline(this.reducePipeline);
      pass.setBindGroup(1, group);
      pass.dispatchWorkgroups(1);
      pass.end();
    });
    reduce.read(histogram);
    reduce.read(previousExposure);
    const adaptedExposure = reduce.write(priorExposure);
    return { previousExposure, adaptedExposure };
  }

  commit(gpuDone: Promise<void>): void {
    if (!this.prepared) throw new Error("GPU radiometry commit without prepare");
    this.prepared = false;
    void gpuDone;
    if (this.autoExposure) {
      this.readIndex = this.writeIndex;
      this.writeIndex = this.readIndex === 0 ? 1 : 0;
    }
    this.historyValid = true;
    this.resetPending = false;
  }
  abort(): void {
    this.prepared = false;
  }
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.bindGroups.clear();
    for (const buffer of this.buffers) buffer.destroy();
  }
}

export const GPU_RADIOMETRY_WGSL = WGSL;
