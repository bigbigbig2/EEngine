import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GPU_SHADING_BIN_FRAME_FLAG,
  GPU_SHADING_BIN_INDIRECT_BYTES,
  GPU_SHADING_BIN_INVALID_ID,
  classifyGpuShadingBinsReference,
  createGpuShadingBinLayouts,
  finalizeGpuShadingBinsReference,
  preflightGpuShadingBinSizing
} from "../.test-dist/gpu/GpuShadingBinAbi.js";
import {
  SHADING_BIN_CLASSIFIER_BINDING_CONTRACT,
  SHADING_BIN_CLASSIFIER_DISPATCH_COVERAGE,
  SHADING_BIN_FINALIZER_BINDING_CONTRACT,
  ShadingBinPass,
  classifierBindGroupLayoutDescriptor,
  finalizerBindGroupLayoutDescriptor,
  shadingBinResourceDescriptorOracle
} from "../.test-dist/render/passes/ShadingBinPass.js";
import {
  GPU_SHADING_BIN_DIAGNOSTIC_FAULT,
  SHADING_BIN_CLASSIFIER_DIAGNOSTICS_WGSL,
  SHADING_BIN_CLASSIFIER_WGSL
} from "../.test-dist/shaders/shading_bin_classify.js";

const limits = Object.freeze({
  maxTextureDimension2D: 32768,
  maxBufferSize: 8 * 1024 * 1024 * 1024,
  maxStorageBufferBindingSize: 8 * 1024 * 1024 * 1024,
  maxComputeWorkgroupsPerDimension: 65535
});

function expectedRecords(width, height, pixels, activeBins) {
  const expected = Array.from({ length: 64 }, () => new Set());
  const active = new Set(activeBins);
  const microtilesX = Math.ceil(width / 8);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bin = pixels[y * width + x];
      if (!active.has(bin)) continue;
      expected[bin].add(Math.floor(y / 8) * microtilesX + Math.floor(x / 8));
    }
  }
  return expected.map((set) => [...set].sort((a, b) => a - b));
}

function randomImage(width, height, seed) {
  let state = seed >>> 0;
  const pixels = new Uint8Array(width * height);
  for (let index = 0; index < pixels.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const selector = state & 15;
    pixels[index] = selector < 7 ? 0 : selector < 11 ? 17 : selector < 14 ? 63 : 0xff;
  }
  return pixels;
}

test("random partial macro/microtile images match an independent record-set oracle", () => {
  const cases = [
    [1, 1, 0x0013c0de],
    [7, 9, 0x0013c0df],
    [17, 31, 0x0013c0e0],
    [65, 67, 0x0013c0e1],
    [127, 73, 0x0013c0e2]
  ];
  for (const [width, height, seed] of cases) {
    const pixels = randomImage(width, height, seed);
    const result = classifyGpuShadingBinsReference({
      width,
      height,
      binIds: pixels,
      activeBinIds: [0, 17, 63],
      generation: 9,
      layoutRevision: 7,
      maxDispatchDimension: 65535
    });
    const expected = expectedRecords(width, height, pixels, [0, 17, 63]);
    for (const bin of [0, 17, 63]) {
      assert.deepEqual([...result.recordsByBin[bin]].sort((a, b) => a - b), expected[bin]);
      assert.equal(result.counters[bin].attemptedCount, expected[bin].length);
      assert.equal(result.counters[bin].writtenCount, expected[bin].length);
      assert.equal(result.counters[bin].overflowCount, 0);
      assert.equal(result.indirectArgs[bin].workgroupCountX, expected[bin].length);
      assert.equal(result.indirectArgs[bin].workgroupCountY, 1);
      assert.equal(result.indirectArgs[bin].workgroupCountZ, 1);
    }
    assert.equal(result.control.frameFlags, 0);
    assert.ok(result.counters.every(({ attemptedCount, writtenCount, overflowCount }) =>
      attemptedCount === writtenCount + overflowCount
    ));
    assert.equal(result.control.generatedMaskLo & ~result.settings.allowedMaskLo, 0);
    assert.equal(result.control.generatedMaskHi & ~result.settings.allowedMaskHi, 0);
  }
});

test("CPU fault matrix fails closed and never publishes partial indirect work", () => {
  const width = 17;
  const height = 17;
  const pixels = new Uint8Array(width * height).fill(3);
  pixels[0] = 64;
  const invalid = classifyGpuShadingBinsReference({
    width,
    height,
    binIds: pixels,
    activeBinIds: [3],
    generation: 1,
    layoutRevision: 2,
    maxDispatchDimension: 65535
  });
  assert.ok((invalid.control.frameFlags & GPU_SHADING_BIN_FRAME_FLAG.InvalidBin) !== 0);
  assert.ok(invalid.indirectArgs.every(({ workgroupCountX, workgroupCountY, workgroupCountZ }) =>
    workgroupCountX === 0 && workgroupCountY === 1 && workgroupCountZ === 1
  ));

  const inactivePixels = new Uint8Array(width * height).fill(GPU_SHADING_BIN_INVALID_ID);
  inactivePixels[0] = 4;
  const inactive = classifyGpuShadingBinsReference({
    width,
    height,
    binIds: inactivePixels,
    activeBinIds: [3],
    generation: 1,
    layoutRevision: 2,
    maxDispatchDimension: 65535
  });
  assert.ok((inactive.control.frameFlags & GPU_SHADING_BIN_FRAME_FLAG.InactiveBin) !== 0);

  const overflow = classifyGpuShadingBinsReference({
    width,
    height,
    binIds: new Uint8Array(width * height).fill(3),
    activeBinIds: [3],
    generation: 1,
    layoutRevision: 2,
    maxDispatchDimension: 65535,
    capacityOverrides: { 3: 0 }
  });
  assert.ok((overflow.control.frameFlags & GPU_SHADING_BIN_FRAME_FLAG.ReservationOverflow) !== 0);
  assert.equal(overflow.recordsByBin[3].length, 0);
  assert.equal(overflow.counters[3].writtenCount, 0);
  assert.equal(
    overflow.counters[3].attemptedCount,
    overflow.counters[3].overflowCount
  );

  const layouts = createGpuShadingBinLayouts(16, 16, [3], 2, undefined, { 3: 1 });
  const counters = Array.from({ length: 64 }, (_, bin) => ({
    attemptedCount: bin === 3 ? 1 : 0,
    writtenCount: bin === 3 ? 1 : 0,
    overflowCount: 0,
    flags: 0
  }));
  const revision = finalizeGpuShadingBinsReference({
    settings: {
      width: 16,
      height: 16,
      microtilesX: 2,
      generation: 1,
      allowedMaskLo: 1 << 3,
      allowedMaskHi: 0,
      maxDispatchDimension: 65535,
      layoutRevision: 2
    },
    layouts,
    counters
  });
  assert.ok((revision.control.frameFlags & GPU_SHADING_BIN_FRAME_FLAG.LayoutRevisionMismatch) !== 0);
  assert.ok(revision.indirectArgs.every(({ workgroupCountX }) => workgroupCountX === 0));

  const invariantCounters = counters.map((counter, bin) => bin === 3
    ? { ...counter, attemptedCount: 2, writtenCount: 1, overflowCount: 0 }
    : counter);
  const invariant = finalizeGpuShadingBinsReference({
    settings: {
      width: 16,
      height: 16,
      microtilesX: 2,
      generation: 1,
      allowedMaskLo: 1 << 3,
      allowedMaskHi: 0,
      maxDispatchDimension: 65535,
      layoutRevision: 2
    },
    layouts: createGpuShadingBinLayouts(16, 16, [3], 2),
    counters: invariantCounters
  });
  assert.ok((invariant.control.frameFlags & GPU_SHADING_BIN_FRAME_FLAG.CounterInvariantFailure) !== 0);
  assert.ok(invariant.indirectArgs.every(({ workgroupCountX }) => workgroupCountX === 0));

  const dispatchOverflow = finalizeGpuShadingBinsReference({
    settings: {
      width: 16,
      height: 16,
      microtilesX: 2,
      generation: 1,
      allowedMaskLo: 1 << 3,
      allowedMaskHi: 0,
      maxDispatchDimension: 1,
      layoutRevision: 2
    },
    layouts: createGpuShadingBinLayouts(16, 16, [3], 2),
    counters: counters.map((counter, bin) => bin === 3
      ? { attemptedCount: 4, writtenCount: 4, overflowCount: 0, flags: 0 }
      : counter)
  });
  assert.ok(
    (dispatchOverflow.control.frameFlags & GPU_SHADING_BIN_FRAME_FLAG.CounterInvariantFailure) !== 0
  );
  assert.ok(dispatchOverflow.indirectArgs.every(({ workgroupCountX }) => workgroupCountX === 0));
});

test("resource and binding descriptor oracle separates heap from the exact indirect buffer", () => {
  const sizing = preflightGpuShadingBinSizing(1920, 1080, [0, 17, 63], 4, limits);
  const descriptors = shadingBinResourceDescriptorOracle(sizing);
  assert.deepEqual(descriptors.heap.usage, ["storage", "copy-dst"]);
  assert.doesNotMatch(descriptors.heap.usage.join(" "), /indirect/u);
  assert.equal(descriptors.heap.size, sizing.heapBytes);
  assert.deepEqual(descriptors.indirectArgs.usage, ["storage", "indirect", "copy-dst"]);
  assert.equal(descriptors.indirectArgs.size, GPU_SHADING_BIN_INDIRECT_BYTES);
  assert.equal(descriptors.indirectArgs.size, 768);
  assert.deepEqual(SHADING_BIN_CLASSIFIER_BINDING_CONTRACT, [
    { binding: 0, resource: "r8uint-texture" },
    { binding: 1, resource: "read-write-storage-buffer" },
    { binding: 2, resource: "dynamic-uniform-buffer", minBindingSize: 32 }
  ]);
  assert.deepEqual(SHADING_BIN_FINALIZER_BINDING_CONTRACT, [
    { binding: 1, resource: "read-write-storage-buffer" },
    { binding: 2, resource: "dynamic-uniform-buffer", minBindingSize: 32 },
    { binding: 3, resource: "read-write-storage-buffer" }
  ]);
  assert.deepEqual(SHADING_BIN_CLASSIFIER_DISPATCH_COVERAGE, {
    workgroupWidth: 16,
    workgroupHeight: 16,
    pixelsPerWorkgroupX: 64,
    pixelsPerWorkgroupY: 64
  });
});

test("native BGL variants keep diagnostics fault injection physically absent from production", () => {
  const previous = globalThis.GPUShaderStage;
  globalThis.GPUShaderStage = { COMPUTE: 4 };
  try {
    const classifier = classifierBindGroupLayoutDescriptor(false);
    const finalizer = finalizerBindGroupLayoutDescriptor(false);
    assert.deepEqual(classifier.entries.map(({ binding }) => binding), [0, 1, 2]);
    assert.deepEqual(finalizer.entries.map(({ binding }) => binding), [1, 2, 3]);
    assert.equal(classifier.entries[0].texture.sampleType, "uint");
    assert.equal(classifier.entries[2].buffer.hasDynamicOffset, true);
    assert.deepEqual(classifierBindGroupLayoutDescriptor(true).entries.map(({ binding }) => binding), [0, 1, 2, 4]);
    assert.deepEqual(finalizerBindGroupLayoutDescriptor(true).entries.map(({ binding }) => binding), [1, 2, 3, 4]);
  } finally {
    globalThis.GPUShaderStage = previous;
  }
  assert.doesNotMatch(SHADING_BIN_CLASSIFIER_WGSL, /shading_bin_faults|@binding\(4\)/u);
  assert.match(SHADING_BIN_CLASSIFIER_DIAGNOSTICS_WGSL, /shading_bin_faults|@binding\(4\)/u);
  assert.deepEqual(GPU_SHADING_BIN_DIAGNOSTIC_FAULT, {
    InvalidBin: 1,
    InactiveBin: 2,
    LayoutRevisionMismatch: 4,
    CounterInvariant: 8,
    ReservationOverflow: 16,
    DispatchOverflow: 32
  });
});

test("classifier source is width-agnostic, barrier-uniform and bounded", () => {
  const source = SHADING_BIN_CLASSIFIER_WGSL;
  assert.equal(source.trimStart().startsWith("enable subgroups;"), true);
  assert.match(source, /@workgroup_size\(16, 16, 1\)\s*\nfn classify_shading_bins/u);
  assert.match(source, /var<workgroup> bin_microtiles: array<atomic<u32>, 128>/u);
  assert.match(source, /var<workgroup> bin_record_bases: array<u32, 64>/u);
  assert.equal(128 * Uint32Array.BYTES_PER_ELEMENT + 64 * Uint32Array.BYTES_PER_ELEMENT, 768);
  assert.match(source, /subgroupOr\(local_bins\)/u);
  assert.match(source, /subgroupOr\(lane_tiles\)/u);
  assert.match(source, /subgroupAdd\(local_invalid_count\)/u);
  assert.match(source, /atomicCompareExchangeWeak/u);
  assert.match(source, /if old_written > capacity \{ break; \}\s+if local_count > capacity - old_written/su);
  assert.match(source, /attempted_count, local_count/u);
  assert.match(source, /overflow_count, local_count/u);
  assert.match(source, /for \(var item = lane; item < 4096u; item \+= 256u\)/u);
  assert.match(source, /@workgroup_size\(64, 1, 1\)\s*\nfn finalize_shading_bins/u);
  assert.match(source, /OEngineShadingBinIndirectArgs\(0u, 1u, 1u\)/u);
  assert.doesNotMatch(source, /subgroup_id|subgroup_invocation_id|subgroupBallot|@subgroup_size|diagnostic\(off/u);
  assert.doesNotMatch(
    source,
    /visibility_key|meshlet|material|pixel_claim|\bvalid_count\b|\bshaded_count\b/u
  );

  const classifierBody = source.slice(
    source.indexOf("fn classify_shading_bins"),
    source.indexOf("fn shading_bin_report_finalizer_error")
  );
  assert.doesNotMatch(classifierBody, /\breturn\b/u);
  assert.ok((classifierBody.match(/workgroupBarrier\(\)/gu) ?? []).length >= 3);
  const firstSubgroup = classifierBody.indexOf("subgroupAdd");
  const firstPostSubgroupBarrier = classifierBody.indexOf("workgroupBarrier()", firstSubgroup);
  const reservation = classifierBody.indexOf("atomicCompareExchangeWeak");
  const scatter = classifierBody.indexOf("for (var item = lane");
  assert.ok(firstSubgroup >= 0 && firstPostSubgroupBarrier > firstSubgroup);
  assert.ok(reservation > firstPostSubgroupBarrier && scatter > reservation);
});

test("candidate pass owns labeled checked creation and exactly two ordered compute passes", () => {
  const source = readFileSync(
    new URL("../src/render/passes/ShadingBinPass.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /getCompilationInfo\(\)/u);
  assert.ok((source.match(/pushErrorScope\("validation"\)/gu) ?? []).length >= 2);
  assert.ok((source.match(/popErrorScope\(\)/gu) ?? []).length >= 2);
  assert.match(source, /clearBuffer\(this\.heap, 0, GPU_SHADING_BIN_MUTABLE_BYTES\)/u);
  assert.match(source, /clearBuffer\(this\.indirectArgs, 0, GPU_SHADING_BIN_INDIRECT_BYTES\)/u);
  const classifier = source.indexOf("beginComputePass({ label: SHADING_BIN_CLASSIFIER_LABEL })");
  const finalizer = source.indexOf("beginComputePass({ label: SHADING_BIN_FINALIZER_LABEL })");
  assert.ok(classifier >= 0 && finalizer > classifier);
  assert.doesNotMatch(source, /submit\(|mapAsync|readback|requestAnimationFrame/u);
});

function fakeDevice(shaderMessages = []) {
  const calls = [];
  let nextId = 0;
  const buffers = [];
  const device = {
    limits: { minUniformBufferOffsetAlignment: 256 },
    queue: {
      writeBuffer(...args) { calls.push(["writeBuffer", ...args]); }
    },
    pushErrorScope(scope) { calls.push(["pushErrorScope", scope]); },
    async popErrorScope() { calls.push(["popErrorScope"]); return null; },
    createBuffer(descriptor) {
      const buffer = {
        id: `buffer-${nextId++}`,
        descriptor,
        destroyed: false,
        destroy() { this.destroyed = true; calls.push(["destroy", this.id]); }
      };
      buffers.push(buffer);
      calls.push(["createBuffer", descriptor]);
      return buffer;
    },
    createShaderModule(descriptor) {
      calls.push(["createShaderModule", descriptor]);
      return {
        descriptor,
        async getCompilationInfo() {
          calls.push(["getCompilationInfo", descriptor.label]);
          return { messages: shaderMessages };
        }
      };
    },
    createBindGroupLayout(descriptor) {
      calls.push(["createBindGroupLayout", descriptor]);
      return { descriptor };
    },
    createPipelineLayout(descriptor) {
      calls.push(["createPipelineLayout", descriptor]);
      return { descriptor };
    },
    createComputePipeline(descriptor) {
      calls.push(["createComputePipeline", descriptor]);
      return { descriptor };
    },
    createBindGroup(descriptor) {
      calls.push(["createBindGroup", descriptor]);
      return { descriptor };
    }
  };
  return { device, calls, buffers };
}

test("candidate resource factory and encoder exercise checked WebGPU ownership without a submit", async () => {
  const previousBufferUsage = globalThis.GPUBufferUsage;
  const previousShaderStage = globalThis.GPUShaderStage;
  globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08, INDIRECT: 0x100 };
  globalThis.GPUShaderStage = { COMPUTE: 4 };
  try {
    const sizing = preflightGpuShadingBinSizing(65, 67, [0, 17], 9, limits);
    const fake = fakeDevice();
    const producer = await ShadingBinPass.create(fake.device, sizing);
    const bufferDescriptors = fake.calls
      .filter(([name]) => name === "createBuffer")
      .map(([, descriptor]) => descriptor);
    assert.deepEqual(bufferDescriptors.map(({ label, size, usage }) => [label, size, usage]), [
      ["ADR-0013 ShadingBin heap", sizing.heapBytes, 0x88],
      ["ADR-0013 ShadingBin indirect args", 768, 0x188]
    ]);
    assert.equal(fake.calls.filter(([name]) => name === "getCompilationInfo").length, 1);
    assert.equal(fake.calls.filter(([name]) => name === "createComputePipeline").length, 2);
    assert.equal(fake.calls.filter(([name]) => name === "writeBuffer")[0][2], 1056);

    const shadingBinId = { label: "candidate r8uint view" };
    const settings = { label: "frame ring" };
    const bindings = await producer.createFrameBindings({
      shadingBinId,
      settings,
      settingsDynamicOffset: 256,
      generation: 4,
      layoutRevision: 9
    });
    const reusedBindings = producer.createFrameBindingsForExecution({
      shadingBinId,
      settings,
      settingsDynamicOffset: 256,
      generation: 4,
      layoutRevision: 9
    });
    assert.equal(reusedBindings.classifier, bindings.classifier);
    assert.equal(reusedBindings.finalizer, bindings.finalizer);
    const changedViewBindings = producer.createFrameBindingsForExecution({
      shadingBinId: { label: "replacement r8uint view" },
      settings,
      settingsDynamicOffset: 256,
      generation: 4,
      layoutRevision: 9
    });
    assert.notEqual(changedViewBindings.classifier, bindings.classifier);
    assert.equal(changedViewBindings.finalizer, bindings.finalizer);
    assert.deepEqual(producer.bindingCacheEvidence(), { requests: 6, creations: 3 });
    assert.equal(fake.calls.filter(([name]) => name === "createBindGroup").length, 3);
    const encoded = [];
    const command = {
      clearBuffer(buffer, offset, size) { encoded.push(["clear", buffer.id, offset, size]); },
      beginComputePass(descriptor) {
        const pass = [];
        encoded.push(["pass", descriptor.label, pass]);
        return {
          setPipeline(value) { pass.push(["pipeline", value.descriptor.label]); },
          setBindGroup(index, value, offsets) { pass.push(["group", index, value.descriptor.label, offsets]); },
          dispatchWorkgroups(x, y, z) { pass.push(["dispatch", x, y, z]); },
          end() { pass.push(["end"]); }
        };
      }
    };
    producer.encode(command, bindings);
    assert.deepEqual(encoded.slice(0, 2), [
      ["clear", fake.buffers[0].id, 0, 1056],
      ["clear", fake.buffers[1].id, 0, 768]
    ]);
    assert.equal(encoded[2][1], "ADR-0013 ShadingBin classifier");
    assert.deepEqual(encoded[2][2].find(([name]) => name === "dispatch"), ["dispatch", 2, 2, 1]);
    assert.equal(encoded[3][1], "ADR-0013 ShadingBin finalizer");
    assert.deepEqual(encoded[3][2].find(([name]) => name === "dispatch"), ["dispatch", 1, 1, 1]);
    assert.equal(fake.calls.some(([name]) => name === "submit"), false);
    producer.destroy();
    assert.ok(fake.buffers.every(({ destroyed }) => destroyed));
  } finally {
    globalThis.GPUBufferUsage = previousBufferUsage;
    globalThis.GPUShaderStage = previousShaderStage;
  }
});

test("shader compilation failure destroys provisional heap and args before publication", async () => {
  const previousBufferUsage = globalThis.GPUBufferUsage;
  const previousShaderStage = globalThis.GPUShaderStage;
  globalThis.GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08, INDIRECT: 0x100 };
  globalThis.GPUShaderStage = { COMPUTE: 4 };
  try {
    const sizing = preflightGpuShadingBinSizing(8, 8, [0], 1, limits);
    const fake = fakeDevice([{ type: "error", lineNum: 7, linePos: 3, message: "injected" }]);
    await assert.rejects(() => ShadingBinPass.create(fake.device, sizing), /7:3 injected/u);
    assert.ok(fake.buffers.every(({ destroyed }) => destroyed));
    assert.equal(fake.calls.some(([name]) => name === "createComputePipeline"), false);
  } finally {
    globalThis.GPUBufferUsage = previousBufferUsage;
    globalThis.GPUShaderStage = previousShaderStage;
  }
});
