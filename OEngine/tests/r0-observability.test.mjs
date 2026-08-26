import test from "node:test";
import assert from "node:assert/strict";

import {
  BENCHMARK_RESULT_SCHEMA_VERSION,
  captureWebGpuLimits,
  createEnvironmentManifest
} from "../.test-dist/debug/EnvironmentManifest.js";
import { FrameProfiler } from "../.test-dist/debug/FrameProfiler.js";
import {
  BenchmarkHarness,
  serializeBenchmarkResult
} from "../.test-dist/debug/BenchmarkHarness.js";
import { BenchmarkRunController } from "../.test-dist/debug/BenchmarkRunController.js";
import { GPU_COUNTER_FIELDS } from "../.test-dist/debug/GpuFrameCounters.js";

globalThis.GPUBufferUsage ??= {
  COPY_DST: 1,
  COPY_SRC: 2,
  MAP_READ: 4,
  STORAGE: 8
};
globalThis.GPUMapMode ??= { READ: 1 };

test("environment manifest canonicalizes comparable WebGPU run metadata", () => {
  const manifest = createEnvironmentManifest({
    capturedAt: "2026-08-25T12:00:00.000Z",
    engine: {
      commit: "abc123",
      dirty: true,
      dirtyReasons: [" M OEngine/src/debug/FrameProfiler.ts"]
    },
    platform: {
      os: "Windows 11",
      browser: "Chromium 140",
      userAgent: "test-agent"
    },
    adapter: {
      vendor: "0x10de",
      architecture: "ada",
      device: "test-gpu",
      description: "Discrete GPU",
      driver: null
    },
    webgpu: {
      features: ["timestamp-query", "float32-blendable", "timestamp-query"],
      limits: { maxBufferSize: 1024, maxTextureDimension2D: 8192 },
      powerPreference: "high-performance"
    },
    frame: {
      canvasWidth: 1920,
      canvasHeight: 1080,
      internalWidth: 1280,
      internalHeight: 720,
      dpr: 1.5
    },
    run: {
      baselineRole: "minimum-a",
      featureSet: ["ibl", "visibility", "ibl"],
      warmupFrames: 120,
      sampleFrames: 600,
      gpuSampleInterval: 60,
      gpuCounterSampleInterval: 60,
      readbackRingSlots: 3
    }
  });

  assert.equal(manifest.schemaVersion, BENCHMARK_RESULT_SCHEMA_VERSION);
  assert.deepEqual(manifest.webgpu.features, [
    "float32-blendable",
    "timestamp-query"
  ]);
  assert.deepEqual(manifest.run.featureSet, ["ibl", "visibility"]);
  assert.equal(manifest.webgpu.timestampQueryAvailable, true);
  assert.deepEqual(manifest.engine.dirtyReasons, [
    " M OEngine/src/debug/FrameProfiler.ts"
  ]);
  assert.equal(manifest.adapter.driver, null);
  assert.equal(manifest.run.baselineRole, "minimum-a");
  assert.equal(manifest.run.gpuCounterSampleInterval, 60);
  assert.equal(manifest.frame.internalWidth, 1280);
  assert.throws(
    () => createEnvironmentManifest({ ...manifest, frame: { ...manifest.frame, dpr: 0 } }),
    /dpr/
  );
});

test("WebGPU limit capture reads prototype-backed limits explicitly", () => {
  const prototype = {
    maxBufferSize: 4096,
    maxTextureDimension2D: 8192,
    maxStorageBuffersPerShaderStage: 10
  };
  const limits = Object.create(prototype);
  assert.deepEqual(captureWebGpuLimits(limits), {
    maxBufferSize: 4096,
    maxStorageBuffersPerShaderStage: 10,
    maxTextureDimension2D: 8192
  });
});

test("frame profiler exposes CPU, submit, readback, upload and delayed GPU evidence", () => {
  let now = 0;
  const profiler = new FrameProfiler({
    enabled: true,
    gpuSampleInterval: 2,
    gpuCounterSampleInterval: 2,
    gpuTimestampAvailable: true,
    historyCapacity: 4,
    now: () => now
  });
  const observed = [];
  const unsubscribe = profiler.subscribe((frame) => observed.push(frame));

  profiler.beginFrame(8);
  const finishGraphics = profiler.beginCpuSection("graphics-update");
  now = 2.5;
  finishGraphics();
  profiler.recordSubmit("GraphicsContext.update");
  profiler.recordSubmit("Renderer/Main");
  profiler.recordReadback("collection-limits", 6144);
  profiler.recordUpload("staging-copy", 256);
  profiler.recordGraphBuild();
  profiler.recordGraphCompile();
  profiler.recordGraphExecute();
  profiler.recordCounter("legacy.instances.candidate", 160000);
  profiler.addCounter("legacy.instances.rejected", 2);
  profiler.addCounter("legacy.instances.rejected", 3);
  now = 5;

  const initial = profiler.endFrame();
  assert.ok(initial);
  assert.equal(initial.frameIndex, 8);
  assert.equal(initial.cpuMs.frame, 5);
  assert.equal(initial.cpuMs["graphics-update"], 2.5);
  assert.deepEqual(initial.submits, {
    count: 2,
    labels: { "GraphicsContext.update": 1, "Renderer/Main": 1 }
  });
  assert.deepEqual(initial.readbacks, {
    count: 1,
    bytes: 6144,
    labels: { "collection-limits": 1 }
  });
  assert.deepEqual(initial.uploads, {
    writes: 1,
    bytes: 256,
    labels: { "staging-copy": 256 }
  });
  assert.deepEqual(initial.graph, { builds: 1, compiles: 1, executes: 1 });
  assert.deepEqual(initial.counters, {
    "legacy.instances.candidate": 160000,
    "legacy.instances.rejected": 5
  });
  assert.deepEqual(initial.gpu, {
    available: true,
    sampled: true,
    pending: true,
    segments: []
  });
  assert.deepEqual(initial.gpuCounters, {
    available: false,
    sampled: false,
    pending: false,
    dropped: false,
    schemaVersion: 1,
    values: {}
  });

  profiler.recordGpuTimings(8, [
    { label: "visibility", type: "render", duration_ms: 1.25 },
    { label: "hzb", type: "compute", duration_ms: 0.5 }
  ]);
  const completed = profiler.getFrame(8);
  assert.ok(completed);
  assert.equal(completed.gpu.pending, false);
  assert.deepEqual(completed.gpu.segments, [
    {
      label: "visibility",
      type: "render",
      phase: "hardware-raster",
      durationMs: 1.25
    },
    { label: "hzb", type: "compute", phase: "hzb", durationMs: 0.5 }
  ]);
  unsubscribe();
  assert.equal(observed.length, 2);
  assert.equal(observed[0].gpu.pending, true);
  assert.equal(observed[1].gpu.pending, false);
});

test("disabled profiler device attachment allocates no GPU counter resources", () => {
  const device = new FakeGpuDevice();
  const profiler = new FrameProfiler({ enabled: false });

  profiler.attachGpuDevice(device);
  profiler.beginFrame(0);

  assert.equal(device.buffers.length, 0);
  assert.equal(profiler.gpuCounterBuffer, null);
  assert.equal(profiler.history.length, 0);
  profiler.destroy();
});

test("non-sampled frames encode no GPU counter work", () => {
  const device = new FakeGpuDevice();
  const profiler = new FrameProfiler({
    enabled: true,
    gpuCounterSampleInterval: 2
  });
  profiler.attachGpuDevice(device);
  const command = new FakeCommandContext();

  profiler.beginFrame(1);
  profiler.encodeGpuCounterClear(command);
  profiler.copyGpuCounter(
    command,
    "visibleInstances",
    new FakeGpuBuffer(Uint32Array.BYTES_PER_ELEMENT)
  );
  profiler.encodeGpuCounterReadback(command);
  const frame = profiler.endFrame();

  assert.equal(device.buffers.length, 0);
  assert.equal(frame.gpuCounters.sampled, false);
  assert.equal(frame.gpuCounters.pending, false);
  assert.deepEqual(frame.gpuCounters.values, {});
  profiler.destroy();
});

test("GPU counter readback failure settles pending frame evidence", async (t) => {
  t.mock.method(console, "error", () => {});
  const device = new FakeGpuDevice();
  const profiler = new FrameProfiler({
    enabled: true,
    gpuCounterSampleInterval: 1
  });
  const observed = [];
  profiler.subscribe((frame) => observed.push(frame));
  profiler.attachGpuDevice(device);
  const command = new FakeCommandContext();

  profiler.beginFrame(0);
  profiler.encodeGpuCounterClear(command);
  profiler.encodeGpuCounterReadback(command);
  const initial = profiler.endFrame();
  assert.equal(initial.gpuCounters.pending, true);
  device.buffers[1].mapError = new Error("counter map failed");

  command.finish();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(profiler.getFrame(0).gpuCounters.pending, false);
  assert.equal(profiler.diagnostics.failedGpuCounterSamples, 1);
  assert.equal(observed.at(-1).gpuCounters.pending, false);
  profiler.destroy();
});

test("benchmark harness drops warmup frames and reports reproducible percentiles", () => {
  const environment = createEnvironmentManifest({
    capturedAt: "2026-08-25T12:00:00.000Z",
    engine: { commit: "abc123", dirty: false, dirtyReasons: [] },
    platform: { os: "test", browser: "test", userAgent: "test" },
    adapter: null,
    webgpu: {
      features: [],
      limits: {},
      powerPreference: "unknown"
    },
    frame: {
      canvasWidth: 1,
      canvasHeight: 1,
      internalWidth: 1,
      internalHeight: 1,
      dpr: 1
    },
    run: {
      baselineRole: "minimum-a",
      featureSet: [],
      warmupFrames: 1,
      sampleFrames: 3,
      gpuSampleInterval: 60,
      gpuCounterSampleInterval: 60,
      readbackRingSlots: 3
    }
  });
  const harness = new BenchmarkHarness(environment, {
    id: "A",
    name: "Compute Rasterizer alignment",
    sceneAssetHashes: ["sha256:test"],
    seed: 42,
    cameraPathHash: "sha256:camera"
  });

  for (const [frameIndex, frameMs] of [10, 1, 2, 3].entries()) {
    harness.recordFrame({
      frameIndex,
      cpuMs: { frame: frameMs },
      submits: { count: 1, labels: { main: 1 } },
      readbacks: { count: 0, bytes: 0, labels: {} },
      uploads: { writes: 0, bytes: 0, labels: {} },
      graph: { builds: 1, compiles: 1, executes: 1 },
      counters: {},
      gpu: {
        available: false,
        sampled: false,
        pending: false,
        segments: []
      },
      gpuCounters: emptyGpuCounters()
    });
  }

  harness.recordFrame({
    frameIndex: 1,
    cpuMs: { frame: 1 },
    submits: { count: 1, labels: { main: 1 } },
    readbacks: { count: 1, bytes: 16, labels: { "gpu-timestamps": 1 } },
    uploads: { writes: 0, bytes: 0, labels: {} },
    graph: { builds: 1, compiles: 1, executes: 1 },
    counters: {},
    gpu: {
      available: true,
      sampled: true,
      pending: false,
      segments: [
        { label: "visibility", type: "render", durationMs: 0.75 },
        { label: "Visibility/ID+Depth/second", type: "render", durationMs: 0.25 }
      ]
    },
    gpuCounters: emptyGpuCounters()
  });

  const result = harness.complete({
    validationErrorCount: 0,
    uncapturedErrorCount: 0,
    deviceLostCount: 0,
    uncapturedErrors: [],
    deviceLostReasons: [],
    droppedGpuCounterSamples: 0,
    failedGpuCounterSamples: 0
  });
  assert.equal(result.frames.length, 3);
  assert.deepEqual(result.frames.map((frame) => frame.cpuMs.frame), [1, 2, 3]);
  assert.deepEqual(result.summary.cpuMs.frame, {
    count: 3,
    mean: 2,
    min: 1,
    max: 3,
    p50: 2,
    p95: 2.9,
    p99: 2.98
  });
  assert.equal(result.summary.submits.mean, 1);
  assert.equal(result.summary.gpuMs.visibility.mean, 0.75);
  assert.equal(result.summary.gpuMs["Visibility/ID+Depth/second"].mean, 0.25);
  assert.deepEqual(result.summary.gpuPhaseMs["hardware-raster"], {
    count: 1,
    mean: 1,
    min: 1,
    max: 1,
    p50: 1,
    p95: 1,
    p99: 1
  });
  assert.equal(result.diagnostics.validationErrorCount, 0);
  assert.deepEqual(JSON.parse(serializeBenchmarkResult(result)), result);
});

test("benchmark run controller owns cadence and waits for delayed GPU evidence", async () => {
  let now = 0;
  const profiler = new FrameProfiler({
    enabled: true,
    gpuSampleInterval: 2,
    gpuCounterSampleInterval: 2,
    gpuTimestampAvailable: true,
    now: () => now
  });
  const environment = createEnvironmentManifest({
    capturedAt: "2026-08-26T00:00:00.000Z",
    engine: { commit: "controller-test", dirty: false, dirtyReasons: [] },
    platform: { os: "test", browser: "test", userAgent: "test" },
    adapter: null,
    webgpu: {
      features: ["timestamp-query"],
      limits: {},
      powerPreference: "unknown"
    },
    frame: {
      canvasWidth: 1,
      canvasHeight: 1,
      internalWidth: 1,
      internalHeight: 1,
      dpr: 1
    },
    run: {
      baselineRole: "frame-smoke",
      featureSet: [],
      warmupFrames: 1,
      sampleFrames: 2,
      gpuSampleInterval: 2,
      gpuCounterSampleInterval: 2,
      readbackRingSlots: 3
    }
  });
  const progress = [];
  const controller = new BenchmarkRunController(profiler, environment, {
    id: "controller",
    name: "Controller cadence",
    sceneAssetHashes: [],
    seed: 0,
    cameraPathHash: "static"
  });

  const result = await controller.run({
    scheduleFrame: async () => {},
    frame: (ordinal) => {
      const frameIndex = ordinal + 1;
      profiler.beginFrame(frameIndex);
      now += frameIndex;
      profiler.recordSubmit("main");
      profiler.endFrame();
    },
    settle: async () => {
      await Promise.resolve();
      profiler.recordGpuTimings(2, [
        { label: "visibility", type: "render", duration_ms: 0.75 }
      ]);
    },
    gpuWaitTimeoutMs: 100,
    onProgress: (snapshot) => progress.push(snapshot)
  });

  assert.equal(result.frames.length, 2);
  assert.deepEqual(result.frames.map((frame) => frame.frameIndex), [2, 3]);
  assert.equal(result.frames[0].gpu.pending, false);
  assert.equal(result.summary.gpuMs.visibility.mean, 0.75);
  assert.equal(result.diagnostics.validationErrorCount, 0);
  assert.equal(progress.at(-1).measuredFrames, 2);
  assert.equal(progress.at(-1).pendingGpuFrames, 0);
  assert.equal(controller.state, "completed");
});

test("benchmark run controller waits for delayed GPU counter evidence", async () => {
  let now = 0;
  const device = new FakeGpuDevice();
  const profiler = new FrameProfiler({
    enabled: true,
    gpuSampleInterval: 100,
    gpuCounterSampleInterval: 2,
    gpuTimestampAvailable: false,
    now: () => now
  });
  profiler.attachGpuDevice(device);
  const environment = createEnvironmentManifest({
    capturedAt: "2026-08-26T00:00:00.000Z",
    engine: { commit: "counter-wait-test", dirty: false, dirtyReasons: [] },
    platform: { os: "test", browser: "test", userAgent: "test" },
    adapter: null,
    webgpu: { features: [], limits: {}, powerPreference: "unknown" },
    frame: {
      canvasWidth: 1,
      canvasHeight: 1,
      internalWidth: 1,
      internalHeight: 1,
      dpr: 1
    },
    run: {
      baselineRole: "observability-smoke",
      featureSet: [],
      warmupFrames: 0,
      sampleFrames: 1,
      gpuSampleInterval: 100,
      gpuCounterSampleInterval: 2,
      readbackRingSlots: 3
    }
  });
  const controller = new BenchmarkRunController(profiler, environment, {
    id: "counter-wait",
    name: "Counter wait",
    sceneAssetHashes: [],
    seed: 0,
    cameraPathHash: "static"
  });
  const command = new FakeCommandContext();

  const result = await controller.run({
    scheduleFrame: async () => {},
    frame: () => {
      profiler.beginFrame(2);
      now = 1;
      profiler.encodeGpuCounterClear(command);
      profiler.registerGpuCounterFields([
        "shadedPixels",
        "emptyVisibilityPixels"
      ]);
      profiler.encodeGpuCounterReadback(command);
      profiler.endFrame();
    },
    settle: () => {
      setTimeout(() => profiler.recordGpuCounters(2, gpuCounterValues(23)), 0);
    },
    gpuWaitTimeoutMs: 100
  });

  assert.equal(result.frames[0].gpuCounters.pending, false);
  assert.deepEqual(result.frames[0].gpuCounters.values, {
    shadedPixels: 23,
    emptyVisibilityPixels: 23
  });
  assert.equal(result.summary.gpuCounters.shadedPixels.mean, 23);
  assert.equal(result.summary.gpuCounters.emptyVisibilityPixels.mean, 23);
  assert.equal(result.diagnostics.droppedGpuCounterSamples, 0);
  assert.equal(controller.progress.pendingGpuFrames, 0);
  profiler.destroy();
});

function emptyGpuCounters() {
  return {
    available: false,
    sampled: false,
    pending: false,
    dropped: false,
    schemaVersion: 1,
    values: {}
  };
}

function gpuCounterValues(value) {
  return Object.fromEntries(GPU_COUNTER_FIELDS.map((field) => [field.name, value]));
}

class FakeGpuDevice {
  buffers = [];
  lost = new Promise(() => {});

  createBuffer(descriptor) {
    const buffer = new FakeGpuBuffer(descriptor.size);
    this.buffers.push(buffer);
    return buffer;
  }

  addEventListener() {}

  removeEventListener() {}
}

class FakeGpuBuffer {
  mapState = "unmapped";
  destroyed = false;
  mapError = null;

  constructor(size) {
    this.size = size;
    this.bytes = new Uint8Array(size);
  }

  async mapAsync() {
    if (this.mapError !== null) throw this.mapError;
    this.mapState = "mapped";
  }

  getMappedRange(offset = 0, size = this.size - offset) {
    return this.bytes.buffer.slice(offset, offset + size);
  }

  unmap() {
    this.mapState = "unmapped";
  }

  destroy() {
    this.destroyed = true;
    this.mapState = "unmapped";
  }
}

class FakeCommandContext {
  finishedCallbacks = [];
  onFinished = {
    addOne: (callback) => this.finishedCallbacks.push(callback)
  };
  gpu_encoder = {
    clearBuffer: (buffer, offset, size) => {
      buffer.bytes.fill(0, offset, offset + size);
    },
    copyBufferToBuffer: (source, sourceOffset, destination, destinationOffset, size) => {
      destination.bytes.set(
        source.bytes.subarray(sourceOffset, sourceOffset + size),
        destinationOffset
      );
    }
  };

  recordReadback() {}

  finish() {
    for (const callback of this.finishedCallbacks.splice(0)) callback();
  }
}
