import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUBufferUsage ??= {
  MAP_READ: 1 << 0,
  MAP_WRITE: 1 << 1,
  COPY_SRC: 1 << 2,
  COPY_DST: 1 << 3,
  INDEX: 1 << 4,
  VERTEX: 1 << 5,
  UNIFORM: 1 << 6,
  STORAGE: 1 << 7,
  INDIRECT: 1 << 8,
  QUERY_RESOLVE: 1 << 9
};

const {
  GPU_CLUSTER_RECORD_SCHEMA,
  GPU_CLUSTER_RECORD_STRIDE,
  GPU_GEOMETRY_RECORD_SCHEMA,
  GPU_GEOMETRY_RECORD_STRIDE,
  GPU_GEOMETRY_RECORD_WGSL,
  GPU_MESHLET_RECORD_SCHEMA,
  GPU_MESHLET_RECORD_STRIDE,
  packGpuClusterRecords,
  packGpuGeometryRecord,
  packGpuMeshletRecords
} = await import("../.test-dist/gpu/GpuGeometryAbi.js");
const { GpuAssetStore } = await import(
  "../.test-dist/gpu/GpuAssetStore.js"
);
const { ResourceAccounting } = await import(
  "../.test-dist/debug/profiling/ResourceAccounting.js"
);
const {
  GEOMETRY_MATERIAL_RANGE_STRIDE,
  GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE
} = await import("../.test-dist/assets/GeometryAssetPackage.js");
const { createGeometryCookRecipe } = await import(
  "../.test-dist/assets/GeometryCookRecipe.js"
);
const { buildBoxSourceGeometry } = await import(
  "../.test-dist/geometry/BoxGeometry.js"
);
const { cookGeometryAssetPackage } = await import(
  "../.test-dist/geometry/GeometryCooker.js"
);

test("GpuAssetStore accounts and releases buffers at its ownership boundary", () => {
  const gpu = createFakeGpu();
  const accounting = new ResourceAccounting();
  const store = new GpuAssetStore(gpu.device, accounting);
  const live = accounting.snapshot();
  assert.ok(live.totalBytes > 0);
  assert.ok(live.owners.GpuAssetStore.buffer > 0);
  assert.equal(live.categories.resident.bytes, live.totalBytes);

  store.destroy();
  const released = accounting.snapshot();
  assert.equal(released.totalBytes, 0);
  assert.equal(released.createdCount, released.destroyedCount);
});

test("R2-C TS packers and generated WGSL share one explicit aligned ABI", () => {
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.stride, 240);
  assert.equal(GPU_CLUSTER_RECORD_SCHEMA.stride, 128);
  assert.equal(GPU_MESHLET_RECORD_SCHEMA.stride, 112);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.position_byte_offset, 116);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.uv0_byte_offset, 132);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.uv1_byte_offset, 144);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.uv2_byte_offset, 156);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.normal_descriptor, 168);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.tangent_descriptor, 172);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.color_descriptor, 176);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.normal_byte_offset, 180);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.normal_stride, 184);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.normal_format, 188);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.normal_normalized, 192);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.tangent_byte_offset, 196);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.tangent_stride, 200);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.tangent_format, 204);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.tangent_normalized, 208);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.color_byte_offset, 212);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.color_stride, 216);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.color_format, 220);
  assert.equal(GPU_GEOMETRY_RECORD_SCHEMA.offsets.color_normalized, 224);
  assert.equal(GPU_CLUSTER_RECORD_SCHEMA.offsets.bounds_min, 48);
  assert.equal(GPU_MESHLET_RECORD_SCHEMA.offsets.bounds_sphere, 64);
  assert.match(GPU_GEOMETRY_RECORD_WGSL, /bounds_sphere: vec4f/);
  assert.match(GPU_GEOMETRY_RECORD_WGSL, /position_format: u32/);
  assert.match(GPU_GEOMETRY_RECORD_WGSL, /uv1_format: u32/);
  assert.match(GPU_GEOMETRY_RECORD_WGSL, /uv2_format: u32/);

  const geometry = packGpuGeometryRecord({
    boundsSphere: [1, 2, 3, 4],
    boundsMin: [-1, -2, -3],
    boundsMax: [5, 6, 7],
    vertexCount: 8,
    indexBegin: 9,
    indexCount: 10,
    meshletBegin: 11,
    meshletCount: 12,
    clusterBegin: 13,
    clusterRoot: 14,
    clusterCount: 15,
    bvhBegin: 16,
    bvhRoot: 17,
    bvhCount: 18,
    materialRangeBegin: 19,
    materialRangeCount: 20,
    streamDescriptorBegin: 21,
    streamDescriptorCount: 22,
    vertexDataByteBegin: 24,
    vertexDataByteLength: 28,
    positionByteOffset: 32,
    positionStride: 12,
    positionFormat: 1,
    flags: 7,
    uv0ByteOffset: 40,
    uv0Stride: 8,
    uv0Format: 1,
    uv1ByteOffset: 80,
    uv1Stride: 4,
    uv1Format: 3,
    uv2ByteOffset: 96,
    uv2Stride: 8,
    uv2Format: 1,
    normalDescriptor: 101,
    tangentDescriptor: 102,
    colorDescriptor: 103,
    normalByteOffset: 104,
    normalStride: 12,
    normalFormat: 7,
    normalNormalized: 0,
    tangentByteOffset: 120,
    tangentStride: 16,
    tangentFormat: 7,
    tangentNormalized: 0,
    colorByteOffset: 136,
    colorStride: 12,
    colorFormat: 2,
    colorNormalized: 1
  });
  assert.equal(geometry.byteLength, GPU_GEOMETRY_RECORD_STRIDE);
  const geometryView = new DataView(geometry.buffer);
  assert.equal(geometryView.getFloat32(0, true), 1);
  assert.equal(geometryView.getFloat32(32, true), 5);
  assert.equal(geometryView.getUint32(116, true), 32);
  assert.equal(geometryView.getUint32(128, true), 7);
  assert.equal(geometryView.getUint32(132, true), 40);
  assert.equal(geometryView.getUint32(152, true), 3);
  assert.equal(geometryView.getUint32(156, true), 96);
  assert.equal(geometryView.getUint32(164, true), 1);
  assert.equal(geometryView.getUint32(168, true), 101);
  assert.equal(geometryView.getUint32(172, true), 102);
  assert.equal(geometryView.getUint32(176, true), 103);
  assert.equal(geometryView.getUint32(180, true), 104);
  assert.equal(geometryView.getUint32(184, true), 12);
  assert.equal(geometryView.getUint32(188, true), 7);
  assert.equal(geometryView.getUint32(192, true), 0);
  assert.equal(geometryView.getUint32(196, true), 120);
  assert.equal(geometryView.getUint32(200, true), 16);
  assert.equal(geometryView.getUint32(204, true), 7);
  assert.equal(geometryView.getUint32(208, true), 0);
  assert.equal(geometryView.getUint32(212, true), 136);
  assert.equal(geometryView.getUint32(216, true), 12);
  assert.equal(geometryView.getUint32(220, true), 2);
  assert.equal(geometryView.getUint32(224, true), 1);

  const cluster = packGpuClusterRecords([{
    childBegin: 1,
    childCount: 2,
    meshletBegin: 3,
    meshletCount: 4,
    parent: 5,
    depth: 6,
    materialId: 7,
    flags: 8,
    geometricError: 9,
    boundsMin: [10, 11, 12],
    boundsMax: [13, 14, 15],
    boundsSphere: [16, 17, 18, 19],
    coneApex: [20, 21, 22, 0],
    coneAxisCutoff: [23, 24, 25, 0.5]
  }]);
  assert.equal(cluster.byteLength, GPU_CLUSTER_RECORD_STRIDE);
  assert.equal(new DataView(cluster.buffer).getFloat32(48, true), 10);

  const meshlet = packGpuMeshletRecords([{
    vertexOffset: 1,
    vertexCount: 2,
    triangleByteOffset: 3,
    triangleCount: 4,
    materialRangeIndex: 5,
    materialId: 6,
    flags: 7,
    boundsMin: [8, 9, 10],
    boundsMax: [11, 12, 13],
    boundsSphere: [14, 15, 16, 17],
    coneApex: [18, 19, 20, 0],
    coneAxisCutoff: [21, 22, 23, 0.25]
  }]);
  assert.equal(meshlet.byteLength, GPU_MESHLET_RECORD_STRIDE);
  assert.equal(new DataView(meshlet.buffer).getFloat32(64, true), 14);
});

test("R2-C residency grows transactionally, retires after completion and exposes recomputable bytes", async () => {
  const gpu = createFakeGpu();
  const cooked = await cookGeometryAssetPackage(
    buildBoxSourceGeometry(),
    createGeometryCookRecipe()
  );
  const asset = cooked.asset;
  assert.equal(asset.clusters.length, 0, "fixture must exercise virtual Cluster residency");
  const store = new GpuAssetStore(gpu.device);
  const before = store.evidence();
  assert.equal(before.residentAssetCount, 0);
  assert.equal(before.allocatedBytes, before.fallbackBytes);

  const command = new FakeAssetCommand(gpu.device);
  const handle = store.resident(asset, command);
  assert.equal(store.recordIndex(handle), 1);
  assert.equal(store.evidence().pendingMutation, "resident");
  assert.equal(store.evidence().residentAssetCount, 0);
  assert.equal(gpu.queue.submitCount, 0, "store must not own a private submit");
  const retiredCandidates = gpu.buffers.filter((buffer) => buffer.label.includes("fallback"));

  command.finish();
  const resident = store.evidence();
  assert.equal(resident.pendingMutation, null);
  assert.equal(resident.residentAssetCount, 1);
  assert.ok(resident.committedGrowCount > 0);
  assert.equal(resident.committedGrowCount, resident.attemptedGrowCount);
  assert.ok(resident.retiringBytes > 0);
  assert.ok(retiredCandidates.every((buffer) => buffer.destroyCount === 0));
  assert.equal(resident.privateSubmitCount, 0);
  assert.equal(resident.uploadedBytes, resident.uploadSourceBytes + resident.uploadPaddingBytes);

  const expectedLogical =
    GPU_GEOMETRY_RECORD_STRIDE +
    asset.meshlets.length * GPU_MESHLET_RECORD_STRIDE +
    Math.max(1, asset.clusters.length) * GPU_CLUSTER_RECORD_STRIDE +
    asset.bvh8Nodes.length * 352 +
    asset.vertexStreamDescriptors.length * GEOMETRY_VERTEX_STREAM_DESCRIPTOR_STRIDE +
    asset.materialRanges.length * GEOMETRY_MATERIAL_RANGE_STRIDE +
    asset.vertexStreamData.byteLength +
    asset.indices.byteLength +
    asset.meshletVertexIndices.byteLength +
    asset.meshletTriangleIndices.byteLength +
    asset.clusterChildren.byteLength;
  assert.equal(resident.logicalBytes, expectedLogical);
  assert.equal(resident.residentBytes, resident.fallbackBytes + resident.uploadedBytes);
  assert.ok(resident.allocatedBytes >= resident.residentBytes);
  assert.ok(resident.peakAllocatedBytes >= resident.allocatedBytes + resident.retiringBytes);

  const geometryBuffer = store.bindings().geometryRecords;
  const record = new DataView(geometryBuffer.data);
  const base = store.recordIndex(handle) * GPU_GEOMETRY_RECORD_STRIDE;
  assert.equal(record.getUint32(base + 48, true), asset.directory.vertexCount);
  assert.equal(record.getUint32(base + 64, true), asset.meshlets.length);
  const clusterRoot = record.getUint32(base + 72, true);
  assert.equal(record.getUint32(base + 76, true), 1);
  const clusterRecord = new DataView(store.bindings().clusterRecords.data);
  const clusterBase = clusterRoot * GPU_CLUSTER_RECORD_STRIDE;
  assert.equal(clusterRecord.getUint32(clusterBase + 4, true), 0);
  assert.equal(clusterRecord.getUint32(clusterBase + 8, true), 1);
  assert.equal(clusterRecord.getUint32(clusterBase + 12, true), asset.meshlets.length);
  assert.equal(record.getUint32(base + 116, true) % 4, 0);

  gpu.resolveCompletion();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.evidence().retiringBytes, 0);
  assert.equal(
    store.evidence().destroyedRetiredBufferCount,
    store.evidence().retiredBufferCount
  );
  assert.ok(retiredCandidates.some((buffer) => buffer.destroyCount === 1));

  const abortCommand = new FakeAssetCommand(gpu.device);
  const aborted = store.resident(asset, abortCommand);
  const highWaterBeforeAbort = store.bindings().highWaterCounts.meshletRecords;
  abortCommand.abort();
  assert.equal(store.evidence().residentAssetCount, 1);
  assert.equal(store.evidence().abortedResidencyCount, 1);
  assert.throws(() => store.recordIndex(aborted), /stale|not resident/);
  assert.ok(store.bindings().highWaterCounts.meshletRecords < highWaterBeforeAbort);

  const releaseAbort = new FakeAssetCommand(gpu.device);
  store.release(handle, releaseAbort);
  releaseAbort.abort();
  assert.equal(store.recordIndex(handle), 1);
  assert.equal(store.evidence().residentAssetCount, 1);

  const release = new FakeAssetCommand(gpu.device);
  store.release(handle, release);
  release.finish();
  assert.equal(store.evidence().residentAssetCount, 0);
  assert.equal(store.evidence().releaseCount, 1);
  assert.equal(store.evidence().logicalBytes, 0);
  assert.ok(store.evidence().reclaimableBytes > 0);
  assert.throws(() => store.recordIndex(handle), /stale|not resident/);
  assert.equal(gpu.queue.submitCount, 0);
  store.destroy();
});

test("R2-C rejects invalid packages before changing capacity or allocating a handle", () => {
  const gpu = createFakeGpu();
  const store = new GpuAssetStore(gpu.device);
  const before = store.evidence();
  const command = new FakeAssetCommand(gpu.device);
  assert.throws(
    () => store.resident({ validate: () => ({ valid: false, issues: [] }) }, command),
    /validated Geometry package/
  );
  const after = store.evidence();
  assert.equal(after.rejectedPackageCount, 1);
  assert.equal(after.allocatedBytes, before.allocatedBytes);
  assert.equal(after.residentAssetCount, 0);
  assert.equal(after.pendingMutation, null);
  store.destroy();
});

test("scene geometry residency commits or rolls back as one transaction", async () => {
  const gpu = createFakeGpu();
  const asset = (await cookGeometryAssetPackage(
    buildBoxSourceGeometry(),
    createGeometryCookRecipe()
  )).asset;
  const store = new GpuAssetStore(gpu.device);

  const abort = new FakeAssetCommand(gpu.device);
  const aborted = store.residentMany([asset, asset], abort);
  assert.deepEqual(aborted.map((handle) => store.recordIndex(handle)), [1, 2]);
  assert.equal(store.evidence().residentAssetCount, 0);
  abort.abort();
  assert.equal(store.evidence().residentAssetCount, 0);
  assert.equal(store.evidence().abortedResidencyCount, 2);
  assert.equal(store.evidence().tables.geometryRecords.highWaterCount, 1);

  const commit = new FakeAssetCommand(gpu.device);
  const handles = store.residentMany([asset, asset], commit);
  assert.deepEqual(handles.map((handle) => store.recordIndex(handle)), [1, 2]);
  commit.finish();
  assert.equal(store.evidence().residentAssetCount, 2);
  assert.equal(store.evidence().pendingMutation, null);
  assert.equal(store.evidence().committedResidencyTransactions, 1);
  assert.equal(store.evidence().abortedResidencyTransactions, 1);
  assert.equal(store.evidence().largestTransactionPackageCount, 2);
  assert.ok(store.evidence().largestTransactionSourceBytes > 0);
  assert.equal(gpu.queue.submitCount, 0);

  const abortedRelease = new FakeAssetCommand(gpu.device);
  store.releaseMany(handles, abortedRelease);
  assert.equal(store.evidence().pendingMutation, "release");
  abortedRelease.abort();
  assert.equal(store.evidence().residentAssetCount, 2);
  assert.equal(store.evidence().abortedReleaseTransactions, 1);

  const committedRelease = new FakeAssetCommand(gpu.device);
  store.releaseMany(handles, committedRelease);
  committedRelease.finish();
  assert.equal(store.evidence().residentAssetCount, 0);
  assert.equal(store.evidence().releaseCount, 2);
  assert.equal(store.evidence().committedReleaseTransactions, 1);
  store.destroy();
});

class FakeSignal {
  listeners = [];
  addOne(listener) {
    this.listeners.push(listener);
  }
  send(...args) {
    const listeners = this.listeners.splice(0);
    for (const listener of listeners) listener(...args);
  }
}

class FakeAssetCommand {
  onFinished = new FakeSignal();
  onAborted = new FakeSignal();
  operations = [];
  closed = false;

  constructor(device) {
    this.device = device;
  }

  copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
    this.operations.push(() => {
      const copy = new Uint8Array(source.data, sourceOffset, size).slice();
      new Uint8Array(destination.data, destinationOffset, size).set(copy);
    });
  }

  writeBuffer(buffer, bufferOffset, data, dataOffset, size) {
    this.operations.push(() => {
      new Uint8Array(buffer.data, bufferOffset, size).set(
        new Uint8Array(data, dataOffset, size)
      );
    });
  }

  finish() {
    assert.equal(this.closed, false);
    this.closed = true;
    for (const operation of this.operations) operation();
    this.onFinished.send(this);
  }

  abort() {
    assert.equal(this.closed, false);
    this.closed = true;
    this.onAborted.send(this, new Error("aborted"));
  }
}

function createFakeGpu() {
  const buffers = [];
  let resolveCompletion;
  let completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const queue = {
    submitCount: 0,
    writeBuffer(buffer, bufferOffset, source, dataOffset = 0, size) {
      const sourceBytes = source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      const byteCount = size ?? sourceBytes.byteLength - dataOffset;
      new Uint8Array(buffer.data, bufferOffset, byteCount).set(
        sourceBytes.subarray(dataOffset, dataOffset + byteCount)
      );
    },
    submit() {
      this.submitCount++;
    },
    onSubmittedWorkDone() {
      return completion;
    }
  };
  const device = {
    queue,
    limits: {
      maxBufferSize: 1 << 26,
      maxStorageBufferBindingSize: 1 << 26
    },
    createBuffer(descriptor) {
      const data = new ArrayBuffer(descriptor.size);
      const buffer = {
        ...descriptor,
        data,
        destroyCount: 0,
        getMappedRange() {
          return this.data;
        },
        unmap() {},
        destroy() {
          this.destroyCount++;
        }
      };
      buffers.push(buffer);
      return buffer;
    }
  };
  return {
    device,
    queue,
    buffers,
    resolveCompletion() {
      resolveCompletion();
      completion = Promise.resolve();
    }
  };
}
