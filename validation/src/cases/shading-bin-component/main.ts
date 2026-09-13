import {
  GPU_SHADING_BIN_COUNT,
  GPU_SHADING_BIN_COUNTERS_OFFSET,
  GPU_SHADING_BIN_COUNTER_STRIDE,
  GPU_SHADING_BIN_FRAME_FLAG,
  GPU_SHADING_BIN_INDIRECT_BYTES,
  GPU_SHADING_BIN_INDIRECT_STRIDE,
  GPU_SHADING_BIN_INVALID_ID,
  GPU_SHADING_BIN_LAYOUTS_OFFSET,
  GPU_SHADING_BIN_LAYOUT_STRIDE,
  GPU_SHADING_BIN_RECORDS_OFFSET,
  GPU_SHADING_BIN_SETTINGS_DYNAMIC_STRIDE,
  classifyGpuShadingBinsReference,
  packGpuShadingBinSettings,
  preflightGpuShadingBinSizing,
  unpackGpuShadingBinControl,
  unpackGpuShadingBinCounter,
  unpackGpuShadingBinIndirectArgs,
  unpackGpuShadingBinLayout,
  type GpuShadingBinControlCpu,
  type GpuShadingBinCounterCpu,
  type GpuShadingBinIndirectArgsCpu,
  type GpuShadingBinLayoutCpu,
  type GpuShadingBinReferenceResult,
  type GpuShadingBinSettingsCpu,
  type GpuShadingBinSizing
} from "../../../../OEngine/src/gpu/GpuShadingBinAbi.js";
import {
  UnsupportedGpuPerformanceBaselineError,
  captureGpuSparseShadingCapabilityRecord,
  createGpuSparseShadingCapabilityPlan
} from "../../../../OEngine/src/gpu/GpuSparseShadingCapability.js";
import { ShadingBinPass } from "../../../../OEngine/src/render/passes/ShadingBinPass.js";
import { GPU_SHADING_BIN_DIAGNOSTIC_FAULT } from "../../../../OEngine/src/shaders/shading_bin_classify.js";
import { createValidationController } from "../../host/protocol.ts";
import {
  attachGpuErrorCollection,
  snapshotAdapterInfo,
  snapshotGpuFeatures,
  snapshotGpuLimits,
  withGpuErrorScopes
} from "../../host/webgpu.ts";

const WIDTH = 65;
const HEIGHT = 67;
const ACTIVE_BINS = Object.freeze([0, 3, 17, 35, 63]);
const GENERATION = 13;
const LAYOUT_REVISION = 4;
const RECTANGULAR_DISPATCH_LIMIT = 16;
const ZERO_ARGS = Object.freeze({ workgroupCountX: 0, workgroupCountY: 1, workgroupCountZ: 1 });

const canvas = document.querySelector<HTMLCanvasElement>("#output");
const status = document.querySelector<HTMLElement>("#status");
let device: GPUDevice | undefined;
let errorCollection: ReturnType<typeof attachGpuErrorCollection> | undefined;
let lostIntentionally = false;
const buffers = new Set<GPUBuffer>();
const textures = new Set<GPUTexture>();
const passes = new Set<ShadingBinPass>();

const controller = createValidationController({
  caseId: "shading-bin-component",
  workloadId: "shading-bin-component-v1"
}, async () => {
  for (const pass of passes) pass.destroy();
  passes.clear();
  for (const buffer of buffers) buffer.destroy();
  buffers.clear();
  for (const texture of textures) texture.destroy();
  textures.clear();
  errorCollection?.remove();
  lostIntentionally = true;
  device?.destroy();
  const lost = errorCollection === undefined
    ? null
    : await Promise.race([
        errorCollection.lost,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))
      ]);
  if (status) status.textContent = "disposed";
  return {
    buffers: buffers.size,
    textures: textures.size,
    passes: passes.size,
    devices: 0,
    rafPending: 0,
    listeners: 0,
    intentionalDeviceDestroy: lostIntentionally,
    deviceLost: lost === null ? null : { reason: lost.reason, message: lost.message }
  };
});

try {
  controller.transition("negotiating");
  if (!window.isSecureContext || !navigator.gpu) {
    controller.unsupported("WebGPU secure context is unavailable");
  } else {
    const adapter = await navigator.gpu.requestAdapter({ featureLevel: "core", powerPreference: "high-performance" });
    if (!adapter) {
      controller.unsupported("No WebGPU core adapter is available");
    } else {
      const adapterLimits = snapshotGpuLimits(adapter.limits);
      const adapterInfo = adapter.info as GPUAdapterInfo & {
        readonly subgroupMinSize?: number;
        readonly subgroupMaxSize?: number;
      };
      const adapterEvidence = {
        info: snapshotAdapterInfo(adapter.info),
        features: snapshotGpuFeatures(adapter.features),
        limits: adapterLimits
      };
      controller.addEvidence("adapter", adapterEvidence);
      let capabilityPlan;
      try {
        capabilityPlan = createGpuSparseShadingCapabilityPlan({
          features: adapter.features,
          limits: adapterLimits,
          info: {
            subgroupMinSize: adapterInfo.subgroupMinSize,
            subgroupMaxSize: adapterInfo.subgroupMaxSize
          }
        });
      } catch (error) {
        if (error instanceof UnsupportedGpuPerformanceBaselineError) {
          controller.unsupported(error.message);
          capabilityPlan = undefined;
        } else {
          throw error;
        }
      }
      if (capabilityPlan !== undefined) {
        if (capabilityPlan.requiredFeatures.includes("subgroup-size-control" as GPUFeatureName)) {
          throw new Error("ADR-0013 forbids subgroup-size-control in the request closure");
        }
        controller.addEvidence("requestedDevice", {
          features: capabilityPlan.requiredFeatures,
          limits: capabilityPlan.requiredLimits,
          subgroupSizeControlRequested: false
        });
        device = await adapter.requestDevice({
          label: "OEngine ADR-0013 ShadingBin Component",
          requiredFeatures: capabilityPlan.requiredFeatures,
          requiredLimits: capabilityPlan.requiredLimits
        });
        errorCollection = attachGpuErrorCollection(device, controller, () => lostIntentionally);
        const deviceFeatures = snapshotGpuFeatures(device.features);
        const deviceLimits = snapshotGpuLimits(device.limits);
        if (deviceFeatures.includes("subgroup-size-control")) {
          throw new Error("Device unexpectedly enabled forbidden subgroup-size-control");
        }

        const texture = trackTexture(device.createTexture({
          label: "ADR-0013 L3 deterministic ShadingBinId",
          size: [WIDTH, HEIGHT, 1],
          format: "r8uint",
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
        }));
        const capability = captureGpuSparseShadingCapabilityRecord(capabilityPlan, {
          features: device.features,
          limits: deviceLimits,
          textureFormatFeatures: ["copy-dst", "texture-binding", "render-attachment"],
          formatProfile: "r8uint:uint-sampled+render-attachment+copy-dst"
        });
        controller.addEvidence("device", { features: deviceFeatures, limits: deviceLimits });
        controller.addEvidence("capability", capability);

        const sizing = preflightGpuShadingBinSizing(WIDTH, HEIGHT, ACTIVE_BINS, LAYOUT_REVISION, {
          maxTextureDimension2D: requireLimit(deviceLimits, "maxTextureDimension2D"),
          maxBufferSize: requireLimit(deviceLimits, "maxBufferSize"),
          maxStorageBufferBindingSize: requireLimit(deviceLimits, "maxStorageBufferBindingSize"),
          maxComputeWorkgroupsPerDimension: requireLimit(deviceLimits, "maxComputeWorkgroupsPerDimension")
        });
        const binIds = createDeterministicBinIds();
        uploadR8UintTexture(device, texture, binIds);
        const productionReference = classifyGpuShadingBinsReference({
          width: WIDTH,
          height: HEIGHT,
          binIds,
          activeBinIds: ACTIVE_BINS,
          generation: GENERATION,
          layoutRevision: LAYOUT_REVISION,
          maxDispatchDimension: requireLimit(deviceLimits, "maxComputeWorkgroupsPerDimension")
        });
        const rectangularReference = classifyGpuShadingBinsReference({
          width: WIDTH,
          height: HEIGHT,
          binIds,
          activeBinIds: ACTIVE_BINS,
          generation: GENERATION,
          layoutRevision: LAYOUT_REVISION,
          maxDispatchDimension: RECTANGULAR_DISPATCH_LIMIT
        });
        const overflowReference = classifyGpuShadingBinsReference({
          width: WIDTH,
          height: HEIGHT,
          binIds,
          activeBinIds: ACTIVE_BINS,
          generation: GENERATION,
          layoutRevision: LAYOUT_REVISION,
          maxDispatchDimension: requireLimit(deviceLimits, "maxComputeWorkgroupsPerDimension"),
          capacityOverrides: { 0: 0 }
        });

        controller.transition("ready");
        const creation = await withGpuErrorScopes(device, "ADR-0013 L3 pass and extraction creation", async () => {
          const production = await ShadingBinPass.create(device!, sizing, false);
          const diagnostics = await ShadingBinPass.create(device!, sizing, true);
          passes.add(production);
          passes.add(diagnostics);
          const extractor = await createExtractor(device!, sizing);
          return { production, diagnostics, extractor };
        });
        controller.addEvidence("shaderCompilation", {
          production: "passed",
          diagnostics: "passed",
          extraction: creation.value.extractor.compilation
        });

        controller.transition("warming");
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        controller.transition("sampling");
        const scenarioEvidence = [];
        scenarioEvidence.push(await executeScenario({
          name: "production-native-limit",
          pass: creation.value.production,
          sizing,
          texture,
          settings: productionReference.settings,
          extractor: creation.value.extractor,
          expected: productionReference,
          compareRecords: true
        }));
        scenarioEvidence.push(await executeScenario({
          name: "production-rectangular-tail-16",
          pass: creation.value.production,
          sizing,
          texture,
          settings: rectangularReference.settings,
          extractor: creation.value.extractor,
          expected: rectangularReference,
          compareRecords: true
        }));

        const diagnostics = [
          diagnosticExpectation("invalid-bin", GPU_SHADING_BIN_DIAGNOSTIC_FAULT.InvalidBin, GPU_SHADING_BIN_FRAME_FLAG.InvalidBin, productionReference),
          diagnosticExpectation("inactive-bin", GPU_SHADING_BIN_DIAGNOSTIC_FAULT.InactiveBin, GPU_SHADING_BIN_FRAME_FLAG.InactiveBin, productionReference),
          diagnosticExpectation("layout-revision", GPU_SHADING_BIN_DIAGNOSTIC_FAULT.LayoutRevisionMismatch, GPU_SHADING_BIN_FRAME_FLAG.LayoutRevisionMismatch, productionReference),
          diagnosticExpectation("counter-invariant", GPU_SHADING_BIN_DIAGNOSTIC_FAULT.CounterInvariant, GPU_SHADING_BIN_FRAME_FLAG.CounterInvariantFailure, productionReference),
          {
            name: "reservation-overflow",
            fault: [GPU_SHADING_BIN_DIAGNOSTIC_FAULT.ReservationOverflow, 0, 0, 0] as const,
            expected: overflowReference
          },
          diagnosticExpectation("dispatch-overflow", GPU_SHADING_BIN_DIAGNOSTIC_FAULT.DispatchOverflow, GPU_SHADING_BIN_FRAME_FLAG.CounterInvariantFailure, productionReference)
        ];
        for (const diagnostic of diagnostics) {
          scenarioEvidence.push(await executeScenario({
            name: `diagnostic-${diagnostic.name}`,
            pass: creation.value.diagnostics,
            sizing,
            texture,
            settings: productionReference.settings,
            extractor: creation.value.extractor,
            expected: diagnostic.expected,
            fault: diagnostic.fault,
            compareRecords: false
          }));
        }
        controller.addEvidence("submit", {
          main: 1,
          additional: scenarioEvidence.slice(1).map((scenario) => scenario.name),
          total: scenarioEvidence.length
        });
        controller.transition("draining");

        const oneRecordArgs = rectangularReference.indirectArgs[63];
        assertDeepEqual(oneRecordArgs, { workgroupCountX: 1, workgroupCountY: 1, workgroupCountZ: 1 }, "one-record indirect args");
        if (!rectangularReference.indirectArgs.some((args) => args.workgroupCountY > 1)) {
          throw new Error("Rectangular-tail scenario did not produce a two-dimensional dispatch");
        }
        for (let binId = 0; binId < GPU_SHADING_BIN_COUNT; binId++) {
          if (!ACTIVE_BINS.includes(binId)) assertDeepEqual(rectangularReference.indirectArgs[binId], ZERO_ARGS, `inactive bin ${binId} zero args`);
        }
        controller.addEvidence("readback", {
          schemaVersion: 1,
          extent: [WIDTH, HEIGHT],
          activeBins: ACTIVE_BINS,
          inputFnv1a32: fnv1a32(binIds),
          sizing: {
            microtilesX: sizing.microtilesX,
            microtilesY: sizing.microtilesY,
            microtileCount: sizing.microtileCount,
            heapBytes: sizing.heapBytes,
            indirectBytes: sizing.indirectBytes
          },
          invariants: {
            macro: [64, 64],
            microtile: [8, 8],
            classifierWorkgroup: [16, 16],
            counterStride: GPU_SHADING_BIN_COUNTER_STRIDE,
            layoutStride: GPU_SHADING_BIN_LAYOUT_STRIDE,
            recordStride: 4,
            indirectStride: GPU_SHADING_BIN_INDIRECT_STRIDE,
            allFaultsFailClosed: true,
            rectangularTailObserved: true,
            zeroAndOneWorkObserved: true
          },
          scenarios: scenarioEvidence
        });
        if (canvas) {
          const context = canvas.getContext("2d");
          if (context) {
            context.fillStyle = "#167c5a";
            context.fillRect(0, 0, canvas.width, canvas.height);
          }
        }
        if (status) status.textContent = `passed: ${scenarioEvidence.length} GPU scenarios`;
        controller.pass();
      }
    }
  }
} catch (error) {
  controller.fail(error instanceof Error ? error.message : String(error));
}

interface Extractor {
  readonly pipeline: GPUComputePipeline;
  readonly compilation: readonly Readonly<Record<string, unknown>>[];
}

interface ActualResult {
  readonly bytes: Uint8Array;
  readonly control: Readonly<GpuShadingBinControlCpu>;
  readonly counters: readonly Readonly<GpuShadingBinCounterCpu>[];
  readonly layouts: readonly Readonly<GpuShadingBinLayoutCpu>[];
  readonly recordsByBin: readonly (readonly number[])[];
  readonly indirectArgs: readonly Readonly<GpuShadingBinIndirectArgsCpu>[];
}

async function createExtractor(targetDevice: GPUDevice, sizing: Readonly<GpuShadingBinSizing>): Promise<Extractor> {
  const heapWords = sizing.heapBytes / 4;
  const argsWords = GPU_SHADING_BIN_INDIRECT_BYTES / 4;
  const module = targetDevice.createShaderModule({
    label: "ADR-0013 validation-only heap extraction",
    code: `
@group(0) @binding(0) var<storage, read> heap: array<u32>;
@group(0) @binding(1) var<storage, read> args: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(64)
fn extract(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if index < ${heapWords}u { output[index] = heap[index]; }
  if index < ${argsWords}u { output[${heapWords}u + index] = args[index]; }
}`
  });
  const info = await module.getCompilationInfo();
  const compilation = info.messages.map((message) => ({
    type: message.type,
    message: message.message,
    lineNum: message.lineNum,
    linePos: message.linePos
  }));
  if (info.messages.some((message) => message.type === "error")) throw new Error("Validation extraction shader compilation failed");
  const pipeline = await targetDevice.createComputePipelineAsync({
    label: "ADR-0013 validation-only heap extraction",
    layout: "auto",
    compute: { module, entryPoint: "extract" }
  });
  return { pipeline, compilation };
}

async function executeScenario(input: {
  readonly name: string;
  readonly pass: ShadingBinPass;
  readonly sizing: Readonly<GpuShadingBinSizing>;
  readonly texture: GPUTexture;
  readonly settings: Readonly<GpuShadingBinSettingsCpu>;
  readonly extractor: Extractor;
  readonly expected: Readonly<GpuShadingBinReferenceResult>;
  readonly fault?: readonly [number, number, number, number];
  readonly compareRecords: boolean;
}): Promise<Readonly<Record<string, unknown>>> {
  const targetDevice = device!;
  const settings = trackBuffer(targetDevice.createBuffer({
    label: `${input.name} settings`,
    size: GPU_SHADING_BIN_SETTINGS_DYNAMIC_STRIDE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  }));
  targetDevice.queue.writeBuffer(settings, 0, packGpuShadingBinSettings(input.settings));
  let faultBuffer: GPUBuffer | undefined;
  if (input.fault !== undefined) {
    faultBuffer = trackBuffer(targetDevice.createBuffer({
      label: `${input.name} diagnostic fault`,
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    }));
    targetDevice.queue.writeBuffer(faultBuffer, 0, new Uint32Array(input.fault));
  }
  const bindings = await input.pass.createFrameBindings({
    shadingBinId: input.texture.createView(),
    settings,
    settingsDynamicOffset: 0,
    generation: GENERATION,
    layoutRevision: LAYOUT_REVISION,
    ...(faultBuffer === undefined ? {} : { diagnosticFaults: faultBuffer })
  });
  const evidenceBytes = input.sizing.heapBytes + GPU_SHADING_BIN_INDIRECT_BYTES;
  const evidence = trackBuffer(targetDevice.createBuffer({
    label: `${input.name} extraction output`,
    size: evidenceBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  }));
  const readback = trackBuffer(targetDevice.createBuffer({
    label: `${input.name} readback`,
    size: evidenceBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  }));
  const extractionGroup = targetDevice.createBindGroup({
    label: `${input.name} extraction bindings`,
    layout: input.extractor.pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: input.pass.heap } },
      { binding: 1, resource: { buffer: input.pass.indirectArgs } },
      { binding: 2, resource: { buffer: evidence } }
    ]
  });
  await withGpuErrorScopes(targetDevice, `${input.name} execution`, async () => {
    const encoder = targetDevice.createCommandEncoder({ label: `${input.name} encoder` });
    input.pass.encode(encoder as never, bindings);
    const extraction = encoder.beginComputePass({ label: `${input.name} extraction` });
    extraction.setPipeline(input.extractor.pipeline);
    extraction.setBindGroup(0, extractionGroup);
    extraction.dispatchWorkgroups(Math.ceil(Math.max(input.sizing.heapBytes / 4, GPU_SHADING_BIN_INDIRECT_BYTES / 4) / 64));
    extraction.end();
    encoder.copyBufferToBuffer(evidence, 0, readback, 0, evidenceBytes);
    targetDevice.queue.submit([encoder.finish()]);
    await targetDevice.queue.onSubmittedWorkDone();
  });
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  const actual = decodeActual(bytes, input.sizing);
  assertDeepEqual(actual.control, input.expected.control, `${input.name} control`);
  assertDeepEqual(actual.counters, input.expected.counters, `${input.name} counters`);
  assertDeepEqual(actual.indirectArgs, input.expected.indirectArgs, `${input.name} indirect args`);
  if (input.compareRecords) {
    assertDeepEqual(actual.layouts, input.expected.layouts, `${input.name} layouts`);
    assertDeepEqual(actual.recordsByBin, input.expected.recordsByBin.map((records) => [...records].sort(numberOrder)), `${input.name} record sets`);
  } else {
    assertAllArgsZero(actual.indirectArgs, input.name);
  }
  const activeCounters = ACTIVE_BINS.map((binId) => ({ binId, ...actual.counters[binId] }));
  const activeArgs = ACTIVE_BINS.map((binId) => ({ binId, ...actual.indirectArgs[binId] }));
  const recordSets = input.compareRecords
    ? ACTIVE_BINS.map((binId) => ({ binId, records: actual.recordsByBin[binId] }))
    : undefined;
  destroyTracked(settings);
  if (faultBuffer !== undefined) destroyTracked(faultBuffer);
  destroyTracked(evidence);
  destroyTracked(readback);
  return Object.freeze({
    name: input.name,
    passed: true,
    byteLength: bytes.byteLength,
    outputFnv1a32: fnv1a32(bytes),
    control: actual.control,
    activeCounters,
    activeArgs,
    ...(recordSets === undefined ? {} : { recordSets })
  });
}

function decodeActual(bytes: Uint8Array, sizing: Readonly<GpuShadingBinSizing>): ActualResult {
  const control = unpackGpuShadingBinControl(bytes);
  const counters = Array.from({ length: GPU_SHADING_BIN_COUNT }, (_, binId) =>
    unpackGpuShadingBinCounter(bytes, GPU_SHADING_BIN_COUNTERS_OFFSET + binId * GPU_SHADING_BIN_COUNTER_STRIDE));
  const layouts = Array.from({ length: GPU_SHADING_BIN_COUNT }, (_, binId) =>
    unpackGpuShadingBinLayout(bytes, GPU_SHADING_BIN_LAYOUTS_OFFSET + binId * GPU_SHADING_BIN_LAYOUT_STRIDE));
  const indirectArgs = Array.from({ length: GPU_SHADING_BIN_COUNT }, (_, binId) =>
    unpackGpuShadingBinIndirectArgs(bytes, sizing.heapBytes + binId * GPU_SHADING_BIN_INDIRECT_STRIDE));
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, sizing.heapBytes / 4);
  const recordsByBin = layouts.map((layout, binId) => {
    const records = Array.from(words.subarray(
      GPU_SHADING_BIN_RECORDS_OFFSET / 4 + layout.recordBase,
      GPU_SHADING_BIN_RECORDS_OFFSET / 4 + layout.recordBase + counters[binId]!.writtenCount
    )).sort(numberOrder);
    if (new Set(records).size !== records.length) throw new Error(`GPU bin ${binId} contains duplicate microtile records`);
    return Object.freeze(records);
  });
  return { bytes, control, counters, layouts, recordsByBin, indirectArgs };
}

function diagnosticExpectation(
  name: string,
  diagnosticFlag: number,
  frameFlag: number,
  base: Readonly<GpuShadingBinReferenceResult>
): Readonly<{ name: string; fault: readonly [number, number, number, number]; expected: Readonly<GpuShadingBinReferenceResult> }> {
  return Object.freeze({
    name,
    fault: Object.freeze([diagnosticFlag, 0, 0, 0] as const),
    expected: Object.freeze({
      ...base,
      control: Object.freeze({ ...base.control, frameFlags: frameFlag, errorCount: 1 }),
      indirectArgs: Object.freeze(Array.from({ length: GPU_SHADING_BIN_COUNT }, () => ZERO_ARGS))
    })
  });
}

function createDeterministicBinIds(): Uint8Array {
  const ids = new Uint8Array(WIDTH * HEIGHT);
  const regular = [0, 3, 17, 35];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const index = y * WIDTH + x;
      if (x >= 64 && y >= 64) ids[index] = 63;
      else if ((x * 11 + y * 7) % 29 === 0) ids[index] = GPU_SHADING_BIN_INVALID_ID;
      else ids[index] = regular[(Math.floor(x / 8) + Math.floor(y / 8) * 3 + (x & 1)) % regular.length]!;
    }
  }
  return ids;
}

function uploadR8UintTexture(targetDevice: GPUDevice, texture: GPUTexture, ids: Uint8Array): void {
  const bytesPerRow = 256;
  const upload = new Uint8Array(bytesPerRow * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) upload.set(ids.subarray(y * WIDTH, (y + 1) * WIDTH), y * bytesPerRow);
  targetDevice.queue.writeTexture(
    { texture },
    upload,
    { bytesPerRow, rowsPerImage: HEIGHT },
    { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 }
  );
}

function requireLimit(limits: Readonly<Record<string, number>>, name: string): number {
  const value = limits[name];
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) throw new Error(`Required device limit ${name} is unavailable`);
  return value;
}

function assertAllArgsZero(args: readonly Readonly<GpuShadingBinIndirectArgsCpu>[], label: string): void {
  for (let binId = 0; binId < args.length; binId++) assertDeepEqual(args[binId], ZERO_ARGS, `${label} fail-closed bin ${binId}`);
}

function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) throw new Error(`${label} mismatch: expected ${expectedJson}, actual ${actualJson}`);
}

function fnv1a32(bytes: ArrayLike<number>): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index++) {
    hash ^= bytes[index]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function numberOrder(left: number, right: number): number {
  return left - right;
}

function trackBuffer(buffer: GPUBuffer): GPUBuffer {
  buffers.add(buffer);
  return buffer;
}

function destroyTracked(buffer: GPUBuffer): void {
  buffer.destroy();
  buffers.delete(buffer);
}

function trackTexture(texture: GPUTexture): GPUTexture {
  textures.add(texture);
  return texture;
}
