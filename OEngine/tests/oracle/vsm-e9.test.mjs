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
  vsmPageGenerationMatches,
  vsmPageTableEntryByteOffset,
  vsmPageTableEntryIndex,
} from "../../.test-dist/render/vsm/VsmPageState.js";
import { VsmResources } from "../../.test-dist/render/vsm/VsmResources.js";
import {
  vsmReceiverDispatch,
  buildVsmDirectionalFrameConstants,
  packVsmSamplingConstants
} from "../../.test-dist/render/vsm/VsmReceiverDemandPass.js";
import { vsmCasterDispatch } from "../../.test-dist/render/vsm/VsmCasterRecordPass.js";
import { VSM_ALLOCATE_PAGES_WGSL } from "../../.test-dist/shaders/vsm_allocate_pages.js";
import { VSM_ATLAS_PAGE_CLEAR_WGSL } from "../../.test-dist/shaders/vsm_atlas_raster.js";
import { VSM_CASTER_RECORDS_WGSL } from "../../.test-dist/shaders/vsm_caster_records.js";
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

/** Sequential reference for the GPU allocator's page/meta invariants. */
function referenceAllocate(slotCount, frames) {
  const slots = Array.from({ length: slotCount }, () => null);
  const pages = new Map();
  const outcomes = [];
  for (const frame of frames) {
    for (const request of frame.pages) {
      let slot = pages.get(request);
      if (slot !== undefined) {
        const meta = slots[slot];
        assert.equal(meta.page, request);
        if (meta.generation !== frame.generation) meta.dirty = true;
        meta.generation = frame.generation;
        meta.lastVisited = frame.generation;
        outcomes.push({ page: request, slot, dirty: meta.dirty });
        continue;
      }
      slot = slots.findIndex((meta) => meta === null);
      if (slot < 0) {
        const candidates = slots
          .map((meta, index) => ({ meta, index }))
          .filter(({ meta }) => !meta.dirty && !meta.inFlight && meta.lastVisited !== frame.generation)
          .sort((a, b) => a.meta.lastVisited - b.meta.lastVisited);
        slot = candidates[0]?.index ?? -1;
      }
      if (slot < 0) {
        outcomes.push({ page: request, slot: null, dirty: true });
        continue;
      }
      if (slots[slot] !== null) pages.delete(slots[slot].page);
      slots[slot] = {
        page: request,
        generation: frame.generation,
        lastVisited: frame.generation,
        dirty: true,
        inFlight: false,
      };
      pages.set(request, slot);
      outcomes.push({ page: request, slot, dirty: true });
    }
    if (frame.commit)
      for (const meta of slots)
        if (meta && meta.generation === frame.generation) {
          meta.dirty = false;
        }
    for (const [page, slot] of pages) assert.equal(slots[slot].page, page);
    assert.equal(new Set(pages.values()).size, pages.size);
  }
  return { outcomes, pages, slots };
}

test("VSM page table has disjoint mip planes and full 32-byte entries", () => {
  const pages = 128;
  const perLevel = vsmEntriesPerClipLevel(pages);
  assert.equal(VSM_MIP_LEVELS, 6);
  assert.equal(VSM_PAGE_ENTRY_WORDS, 8);
  assert.equal(perLevel, 21840);
  const seen = new Set();
  for (let level = 0; level < 6; level++) {
    for (let mip = 0; mip < VSM_MIP_LEVELS; mip++) {
      const axis = pages >> mip;
      for (let y = 0; y < axis; y++)
        for (let x = 0; x < axis; x++) {
          const index = vsmPageTableEntryIndex(level, mip, x, y, pages);
          assert.ok(!seen.has(index), `alias at level ${level}, mip ${mip}, ${x},${y}`);
          seen.add(index);
        }
    }
  }
  assert.equal(seen.size, 6 * perLevel);
  assert.equal(vsmPageTableEntryByteOffset(1, 0, 0, 0, pages), perLevel * 32);
  assert.notEqual(vsmPageTableEntryIndex(0, 0, 1, 1, pages), vsmPageTableEntryIndex(0, 1, 1, 1, pages));
  assert.throws(() => vsmPageTableEntryIndex(0, 1, 64, 0, pages), /outside/);
});

test("VSM profile preflight covers page table, locks and disabled fallback", () => {
  const highDevice = device();
  const high = negotiateVsmCapabilities(highDevice);
  assert.equal(high.profile, "vsm-directional-high");
  assert.equal(high.pageTableBytes, high.virtualEntryCount * 32);
  const resources = VsmResources.create(highDevice, high);
  const table = new VsmPageTable(resources);
  assert.equal(table.virtualEntryCount, high.virtualEntryCount);
  assert.equal(resources.pageTable.size, high.pageTableBytes);
  assert.ok(resources.pageLocks.size >= high.virtualEntryCount * 4);
  assert.equal(table.entryByteOffset(0, 1, 0, 0), 128 * 128 * 32);
  resources.destroy();

  const bounded = negotiateVsmCapabilities(device({ maxTextureDimension2D: 2048 }));
  assert.equal(bounded.profile, "vsm-directional-bounded");
  assert.equal(bounded.pageTableBytes, bounded.virtualEntryCount * 32);
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
  assert.match(VSM_SAMPLING_WGSL, /entry\.mip != effective_mip/u);
  assert.match(VSM_SAMPLING_WGSL, /if \(current && \(entry\.flags & 2u\) == 0u\)/u);
  assert.match(VSM_SAMPLING_WGSL, /return 1\.0;/u);
  assert.match(VSM_PAGE_TABLE_WGSL, /vsm_page_entry_coordinates/u);
});

test("directional clipmap, shadow view and sampling share camera-relative light coordinates", () => {
  const gpu = device(),
    resources = VsmResources.create(gpu, negotiateVsmCapabilities(gpu));
  try {
    for (const center of [
      [0, 0, 8],
      [1234.25, -567.5, 810.75]
    ]) {
      const frame = buildVsmDirectionalFrameConstants([0, 2, 3], center, 2048, resources, 71);
      const matrix = frame.lightView;
      const lightCenter = [0, 1, 2].map(
        (axis) =>
          matrix[axis] * center[0] +
          matrix[4 + axis] * center[1] +
          matrix[8 + axis] * center[2] +
          matrix[12 + axis]
      );
      assert.ok(lightCenter.every((value) => Math.abs(value) < 1e-9));
      for (const [x, y, extent] of frame.clipOriginExtent) {
        const pageWorld = extent / resources.capabilities.virtualPagesPerAxis;
        assert.ok(x <= -extent / 2 && x > -extent / 2 - pageWorld - 1e-9);
        assert.ok(y <= -extent / 2 && y > -extent / 2 - pageWorld - 1e-9);
      }
      const view = shadowGeometryView(frame);
      // Camera center must lie inside every light prism plane even far from origin.
      assert.ok(
        view.frustumPlanes.every(([x, y, z, w]) => x * center[0] + y * center[1] + z * center[2] + w >= 0)
      );
      const packed = packVsmSamplingConstants({ resources, width: 1920, height: 1080, ...frame });
      const uints = new Uint32Array(packed),
        floats = new Float32Array(packed);
      assert.equal(uints[45], 71, "sampling uses the current publication generation");
      const depthPerTexel =
        1 / (resources.capabilities.virtualPagesPerAxis * resources.capabilities.pageSize * 8);
      assert.deepEqual(
        [...floats.slice(48, 51)],
        [0.5, 2, 1.5].map((value) => Math.fround(value * depthPerTexel))
      );
    }
    assert.throws(() => shadowGeometryView({ lightView: [NaN], clipOriginExtent: [[0, 0, 1, 1]] }), /finite/);
    assert.throws(
      () => shadowGeometryView({ lightView: Array(16).fill(0), clipOriginExtent: [[0, 0, 0, 1]] }),
      /invalid/
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

test("allocation and raster keep overflow dirty and clear only newly written slots", () => {
  assert.match(VSM_ALLOCATE_PAGES_WGSL, /if \(observed >= constants\.control\.z\)/u);
  assert.match(VSM_ALLOCATE_PAGES_WGSL, /atomicAdd\(&allocation\.overflow, 1u\)/u);
  assert.match(VSM_ALLOCATE_PAGES_WGSL, /slot_meta\.last_visited == generation/u);
  assert.match(VSM_ALLOCATE_PAGES_WGSL, /VSM_PAGE_DIRTY \| VSM_PAGE_IN_FLIGHT/u);
  assert.match(VSM_CASTER_RECORDS_WGSL, /page_overlaps_sphere\(center, radius, page, entry\.mip\)/u);
  assert.match(VSM_CASTER_RECORDS_WGSL, /raster_indirect\[2\] = OEngineDrawIndirectArgs\(6u/u);
  assert.match(VSM_ATLAS_PAGE_CLEAR_WGSL, /\(record\.flags & 2u\) == 0u/u);
  assert.match(VSM_ATLAS_PAGE_CLEAR_WGSL, /record\.slot >= constants\.control\.w/u);
});

test("allocation CPU oracle prefers free slots, reuses pages and fails open on protected overflow", () => {
  const result = referenceAllocate(2, [
    { generation: 1, pages: [4, 5], commit: true },
    { generation: 2, pages: [4, 6, 7], commit: false },
  ]);
  assert.deepEqual(result.outcomes, [
    { page: 4, slot: 0, dirty: true },
    { page: 5, slot: 1, dirty: true },
    { page: 4, slot: 0, dirty: true },
    { page: 6, slot: 1, dirty: true },
    { page: 7, slot: null, dirty: true },
  ]);
  assert.equal(result.pages.has(5), false);
  assert.equal(result.pages.get(4), 0);
  assert.equal(result.pages.get(6), 1);
  assert.match(VSM_ALLOCATE_PAGES_WGSL, /meta_table\.entries\[slot\]\.virtual_page == virtual_page/u);
  assert.match(VSM_ALLOCATE_PAGES_WGSL, /meta_table\.entries\[candidate\]\.flags = 0u/u);
});

test("VSM device epoch and invalidation facts stay monotonic and bounded", () => {
  const generation = new VsmGeneration();
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
  const first = generation.begin(input);
  assert.equal(first.reason, "initial");
  assert.equal(first.fullInvalidate, true);
  assert.equal(generation.begin(input).reason, "none");
  const resized = generation.begin({ ...input, width: 19 });
  assert.equal(resized.reason, "resize");
  assert.equal(resized.generation, first.generation);
  assert.equal(resized.temporalInvalidate, true);
  const quantum = generation.begin({ ...input, width: 19, clipOriginExtent: [[1, 0, 32, 1]] });
  assert.equal(quantum.reason, "page-quantum");
  assert.equal(quantum.generation, first.generation + 1);
  const epoch = generation.begin({ ...input, width: 19, deviceEpoch: 2, clipOriginExtent: [[1, 0, 32, 1]] });
  assert.equal(epoch.reason, "device-epoch");
  assert.equal(epoch.fullInvalidate, true);
  assert.equal(epoch.generation, quantum.generation + 1);
  assert.throws(() => generation.begin({ ...input, deviceEpoch: -1 }), /uint32/);
});
