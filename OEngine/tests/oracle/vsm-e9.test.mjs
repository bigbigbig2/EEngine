import assert from "node:assert/strict";
import test from "node:test";
import { negotiateVsmCapabilities } from "../../.test-dist/render/vsm/VsmCapabilities.js";
import { VsmGeneration } from "../../.test-dist/render/vsm/VsmGeneration.js";
import { VsmPageTable } from "../../.test-dist/render/vsm/VsmPageTable.js";
import {
  VSM_MIP_LEVELS,
  VSM_PAGE_ENTRY_WORDS,
  VSM_PAGE_FLAGS,
  vsmEntriesPerClipLevel,
  vsmWorldPageEntryIndex,
  vsmPageGenerationMatches,
  vsmPageTableEntryByteOffset,
  vsmPageTableEntryIndex,
} from "../../.test-dist/render/vsm/VsmPageState.js";
import { VsmResources } from "../../.test-dist/render/vsm/VsmResources.js";
import {
  vsmReceiverDispatch,
  buildVsmDirectionalFrameConstants,
  packVsmSamplingConstants,
} from "../../.test-dist/render/vsm/VsmReceiverDemandPass.js";
import { vsmCasterDispatch } from "../../.test-dist/render/vsm/VsmCasterRecordPass.js";
import { VSM_PAGE_TABLE_WGSL } from "../../.test-dist/shaders/vsm_page_table.js";
import { VSM_RECEIVER_DEMAND_WGSL } from "../../.test-dist/shaders/vsm_receiver_demand.js";
import { VSM_SAMPLING_WGSL } from "../../.test-dist/shaders/vsm_sampling.js";

globalThis.GPUBufferUsage = { STORAGE: 1, COPY_DST: 2, INDIRECT: 4, UNIFORM: 8 };
globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 };
globalThis.GPUShaderStage = { COMPUTE: 4, VERTEX: 1, FRAGMENT: 2 };
const { shadowGeometryView } = await import("../../.test-dist/render/ShadowGeometryWork.js");

function device(overrides = {}) {
  const allocations = [];
  const limits = {
    maxTextureDimension2D: 4096,
    maxStorageBufferBindingSize: 32 * 1024 * 1024,
    maxBufferSize: 128 * 1024 * 1024,
    maxStorageBuffersPerShaderStage: 8,
    maxComputeWorkgroupsPerDimension: 65535,
    maxComputeWorkgroupSizeX: 256,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupStorageSize: 16384,
    ...overrides,
  };
  return {
    limits,
    allocations,
    createBuffer({ size, usage }) {
      const bytes = new ArrayBuffer(size);
      const buffer = { size, usage, getMappedRange: () => bytes, unmap() {}, destroy() {} };
      allocations.push(buffer);
      return buffer;
    },
    createTexture({ size }) {
      return { width: size.width, height: size.height, createView: () => ({}), destroy() {} };
    },
  };
}

test("VSM page table has disjoint mip planes and full 48-byte world entries", () => {
  const pages = 128;
  const perLevel = vsmEntriesPerClipLevel(pages);
  assert.equal(VSM_MIP_LEVELS, 6);
  assert.equal(VSM_PAGE_ENTRY_WORDS, 12);
  assert.equal(perLevel, 21888);
  const seen = new Set();
  for (let level = 0; level < 6; level++) {
    for (let mip = 0; mip < VSM_MIP_LEVELS; mip++) {
      const axis = mip === 5 ? 8 : pages >> mip;
      for (let y = 0; y < axis; y++)
        for (let x = 0; x < axis; x++) {
          const index = vsmPageTableEntryIndex(level, mip, x, y, pages);
          assert.ok(!seen.has(index), `alias at level ${level}, mip ${mip}, ${x},${y}`);
          seen.add(index);
        }
    }
  }
  assert.equal(seen.size, 6 * perLevel);
  assert.equal(vsmPageTableEntryByteOffset(1, 0, 0, 0, pages), perLevel * 48);
  assert.notEqual(vsmPageTableEntryIndex(0, 0, 1, 1, pages), vsmPageTableEntryIndex(0, 1, 1, 1, pages));
  assert.throws(() => vsmPageTableEntryIndex(0, 1, 64, 0, pages), /outside/);
});

test("VSM profile preflight covers complete demand, coarse reserve and device limits", () => {
  const highDevice = device();
  const high = negotiateVsmCapabilities(highDevice);
  assert.equal(high.profile, "vsm-directional-high");
  assert.equal(high.pageTableBytes, high.virtualEntryCount * 48);
  const resources = VsmResources.create(highDevice, high);
  const table = new VsmPageTable(resources);
  assert.equal(table.virtualEntryCount, high.virtualEntryCount);
  assert.equal(resources.pageTable.size, high.pageTableBytes);
  assert.equal(high.virtualEntryCount, 131328);
  assert.equal(high.demandCapacity, high.virtualEntryCount);
  assert.equal(resources.demand.size, 131328 * 16 + 16);
  assert.equal(resources.requestedPages.size, 16416);
  assert.equal(high.coarseReservedSlots, 150);
  assert.equal(resources.pageLocks, undefined);
  assert.equal(resources.slotLocks, undefined);
  assert.equal(table.entryByteOffset(0, 1, 0, 0), 128 * 128 * 48);
  resources.destroy();

  const bounded = negotiateVsmCapabilities(device({ maxTextureDimension2D: 2048 }));
  assert.equal(bounded.profile, "vsm-directional-bounded");
  assert.equal(bounded.pageTableBytes, bounded.virtualEntryCount * 48);
  assert.equal(bounded.virtualEntryCount, 87552);
  assert.equal(bounded.coarseReservedSlots, 100);
  for (const overrides of [
    { maxComputeWorkgroupSizeX: 32 },
    { maxComputeInvocationsPerWorkgroup: 32 },
    { maxComputeWorkgroupStorageSize: 512 },
    { maxComputeWorkgroupsPerDimension: 1000 },
  ]) {
    assert.equal(negotiateVsmCapabilities(device(overrides)).profile, "shadow-disabled");
  }
  assert.equal(
    negotiateVsmCapabilities(
      device({
        maxTextureDimension2D: 2048,
        maxStorageBufferBindingSize: bounded.pageTableBytes - 1,
      }),
    ).profile,
    "shadow-disabled",
  );
  assert.equal(
    negotiateVsmCapabilities(
      device({
        maxStorageBuffersPerShaderStage: 6,
      }),
    ).profile,
    "shadow-disabled",
  );
  assert.equal(
    negotiateVsmCapabilities(
      device({
        maxStorageBuffersPerShaderStage: 7,
      }),
    ).profile,
    "shadow-disabled",
  );
});

test("receiver dispatch covers odd extents and sampling fails open for invalid pages", () => {
  assert.deepEqual(vsmReceiverDispatch(17, 9), [3, 2]);
  assert.deepEqual(vsmReceiverDispatch(1, 1), [1, 1]);
  assert.throws(() => vsmReceiverDispatch(0, 9), /extent/);
  assert.match(
    VSM_RECEIVER_DEMAND_WGSL,
    /id\.x >= constants\.dimensions\.x \|\| id\.y >= constants\.dimensions\.y/u,
  );
  const current = { flags: VSM_PAGE_FLAGS.allocated | VSM_PAGE_FLAGS.generationValid, generation: 7 };
  assert.equal(vsmPageGenerationMatches(current, 7), true);
  assert.equal(vsmPageGenerationMatches(current, 8), false);
  assert.equal(vsmPageGenerationMatches({ ...current, flags: 0 }, 7), false);
  assert.match(VSM_SAMPLING_WGSL, /entry\.mip != mip/u);
  assert.match(VSM_SAMPLING_WGSL, /VSM_QUERY_DIRTY/u);
  assert.match(VSM_SAMPLING_WGSL, /return 1\.0;/u);
  assert.match(VSM_PAGE_TABLE_WGSL, /vsm_page_entry_coordinates/u);
});

test("directional clipmap keeps a world-fixed basis and camera-centered window", () => {
  const gpu = device(),
    resources = VsmResources.create(gpu, negotiateVsmCapabilities(gpu));
  try {
    for (const center of [
      [0, 0, 8],
      [1234.25, -567.5, 810.75],
    ]) {
      const frame = buildVsmDirectionalFrameConstants([0, 2, 3], center, 2048, resources, 71);
      const matrix = frame.lightView;
      const lightCenter = [0, 1, 2].map(
        (axis) =>
          matrix[axis] * center[0] +
          matrix[4 + axis] * center[1] +
          matrix[8 + axis] * center[2] +
          matrix[12 + axis],
      );
      assert.deepEqual(matrix.slice(12), [0, 0, 0, 1]);
      for (const [x, y, extent] of frame.clipOriginExtent) {
        const pageWorld = extent / resources.capabilities.virtualPagesPerAxis;
        assert.ok(x <= lightCenter[0] - extent / 2 && x > lightCenter[0] - extent / 2 - pageWorld - 1e-9);
        assert.ok(y <= lightCenter[1] - extent / 2 && y > lightCenter[1] - extent / 2 - pageWorld - 1e-9);
      }
      const view = shadowGeometryView(frame);
      // Camera center must lie inside every light prism plane even far from origin.
      assert.ok(
        view.frustumPlanes.every(([x, y, z, w]) => x * center[0] + y * center[1] + z * center[2] + w >= 0),
      );
      const packed = packVsmSamplingConstants({ resources, frame, width: 1920, height: 1080, ...frame });
      const uints = new Uint32Array(packed),
        floats = new Float32Array(packed);
      assert.equal(uints[45], 71, "sampling uses the current publication generation");
      assert.deepEqual([...floats.slice(48, 51)], [0.5, 2, 1.5]);
    }
    assert.throws(() => shadowGeometryView({ lightView: [NaN], clipOriginExtent: [[0, 0, 1, 1]] }), /finite/);
    assert.throws(
      () => shadowGeometryView({ lightView: Array(16).fill(0), clipOriginExtent: [[0, 0, 0, 1]] }),
      /invalid/,
    );
  } finally {
    resources.destroy();
  }
});

test("caster capacity dispatch covers the second row without dropping work", () => {
  assert.deepEqual(vsmCasterDispatch(64 * 65535, 65535), [65535, 1]);
  assert.deepEqual(vsmCasterDispatch(64 * 65535 + 1, 65535), [65535, 2]);
  assert.deepEqual(vsmCasterDispatch(129, 2), [2, 2]);
  assert.throws(() => vsmCasterDispatch(257, 2), /dispatch/);
  assert.throws(() => vsmCasterDispatch(0, 65535), /dispatch/);
});

test("rolling fine domain has independent unique addresses for every coarse guard cell", () => {
  for (let offset = -130; offset <= 130; offset++) {
    const minimum = Math.floor(offset / 32);
    const maximum = Math.floor((offset + 127) / 32);
    const cells = new Set();
    for (let y = minimum; y <= maximum; y++) {
      for (let x = minimum; x <= maximum; x++) {
        const address = vsmWorldPageEntryIndex(0, 5, x, y, 128);
        assert.ok(!cells.has(address), "coarse ring aliases rolling guard cells");
        cells.add(address);
      }
    }
    assert.equal(cells.size, offset % 32 === 0 ? 16 : 25);
  }
});

test("VSM device epoch and invalidation facts stay monotonic and bounded", () => {
  const generation = new VsmGeneration();
  const submit = (input) => {
    const candidate = generation.prepare(input);
    generation.commit(candidate);
    return candidate;
  };
  const scene = {};
  const input = {
    deviceEpoch: 1,
    scene,
    sceneRevision: 1,
    casterRevision: 0,
    sunRevision: 0,
    sunDirection: [0, 1, 0],
    cameraCut: false,
    clipOriginExtent: [[0, 0, 32, 1]],
    width: 17,
    height: 9,
  };
  const first = submit(input);
  assert.equal(first.reason, "initial");
  assert.equal(first.fullInvalidate, true);
  assert.equal(submit(input).reason, "none");
  const resized = submit({ ...input, width: 19 });
  assert.equal(resized.reason, "resize");
  assert.equal(resized.generation, first.generation);
  assert.equal(resized.temporalInvalidate, true);
  const quantum = submit({ ...input, width: 19, clipOriginExtent: [[1, 0, 32, 1]] });
  assert.equal(quantum.reason, "page-quantum");
  assert.equal(quantum.generation, first.generation);
  const epoch = submit({ ...input, width: 19, deviceEpoch: 2, clipOriginExtent: [[1, 0, 32, 1]] });
  assert.equal(epoch.reason, "device-epoch");
  assert.equal(epoch.fullInvalidate, true);
  assert.equal(epoch.generation, quantum.generation + 1);
  assert.throws(() => generation.prepare({ ...input, deviceEpoch: -1 }), /uint32/);
});
