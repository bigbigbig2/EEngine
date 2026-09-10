import assert from "node:assert/strict";
import test from "node:test";

installWebGpuConstants();

const [
  { buildBoxSourceGeometry },
  { createSourceGeometry },
  { createGeometryCookRecipe },
  { cookGeometryAssetPackage },
  {
    decodeGeometryColor,
    decodeGeometryNormal,
    decodeGeometryPosition,
    decodeGeometryTangent,
    decodeGeometryUv,
    GEOMETRY_VERTEX_PROFILE,
    GEOMETRY_VERTEX_STREAM_FLAGS
  },
  { RuntimeAssetResidencyState },
  { GpuAssetStore },
  { GpuScene },
  {
    packGpuInstanceRecord,
    readGpuInstanceAffineMatrix,
    GPU_INSTANCE_DYNAMIC_RECORD_STRIDE,
    GPU_INSTANCE_FLAGS,
    GPU_INSTANCE_RECORD_OFFSETS,
    GPU_INSTANCE_RECORD_STRIDE,
    GPU_INSTANCE_STATIC_RECORD_STRIDE
  }
] = await Promise.all([
  import("../.test-dist/geometry/BoxGeometry.js"),
  import("../.test-dist/assets/SourceGeometry.js"),
  import("../.test-dist/assets/GeometryCookRecipe.js"),
  import("../.test-dist/geometry/GeometryCooker.js"),
  import("../.test-dist/assets/GeometryAssetPackage.js"),
  import("../.test-dist/assets/RuntimeAssetResidency.js"),
  import("../.test-dist/gpu/GpuAssetStore.js"),
  import("../.test-dist/gpu/GpuScene.js"),
  import("../.test-dist/gpu/GpuInstanceAbi.js")
]);

test("Instance V2 CPU pack oracle preserves affine current/previous state and motion validity", () => {
  const current = translatedMatrices([[2, 3, 4]]);
  const previous = translatedMatrices([[1, 3, 4]]);
  const bytes = packGpuInstanceRecord({
    geometryRecordIndex: 7,
    materialHandle: 9,
    flags: GPU_INSTANCE_FLAGS.Active,
    debugId: 11,
    boundsSphere: [0, 0, 0, 1],
    boundsMin: [-1, -1, -1],
    boundsMax: [1, 1, 1],
    currentObjectToWorld: current,
    previousObjectToWorld: previous
  });
  const decodedCurrent = new Float32Array(16);
  const decodedMotion = new Float32Array(16);
  readGpuInstanceAffineMatrix(decodedCurrent, bytes, GPU_INSTANCE_RECORD_OFFSETS.current_affine);
  readGpuInstanceAffineMatrix(decodedMotion, bytes, GPU_INSTANCE_RECORD_OFFSETS.previous_from_current_affine);
  assert.deepEqual([...decodedCurrent], [...current]);
  assert.equal(decodedMotion[12], -1);
  assert.equal(decodedMotion[13], 0);
  assert.equal(decodedMotion[14], 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(GPU_INSTANCE_RECORD_OFFSETS.dynamic_revision, true), 0);
  assert.equal(view.getUint32(GPU_INSTANCE_RECORD_OFFSETS.motion_flags, true), 0);

  const singular = current.slice();
  singular[0] = 0;
  const invalid = packGpuInstanceRecord({
    geometryRecordIndex: 7,
    materialHandle: 9,
    flags: GPU_INSTANCE_FLAGS.Active,
    debugId: 11,
    boundsSphere: [0, 0, 0, 1],
    boundsMin: [-1, -1, -1],
    boundsMax: [1, 1, 1],
    currentObjectToWorld: singular,
    previousObjectToWorld: previous
  });
  assert.notEqual(
    new DataView(invalid.buffer, invalid.byteOffset, invalid.byteLength)
      .getUint32(GPU_INSTANCE_RECORD_OFFSETS.motion_flags, true) & GPU_INSTANCE_FLAGS.MotionInvalid,
    0
  );
});

test("Canonical Geometry V2 is deterministic, compact, and numerically faithful", async () => {
  const source = staticPbrBox();
  const compactRecipe = createGeometryCookRecipe();
  const fallbackRecipe = createGeometryCookRecipe({
    vertexProfile: "explicit-float32-fallback-v2"
  });
  const compact = await cookGeometryAssetPackage(source, compactRecipe);
  const repeat = await cookGeometryAssetPackage(source, compactRecipe);
  const fallback = await cookGeometryAssetPackage(source, fallbackRecipe);

  assert.deepEqual(new Uint8Array(compact.bytes), new Uint8Array(repeat.bytes));
  assert.equal(compact.asset.package.manifest.formatVersion, 2);
  assert.equal(compact.asset.runtime.manifest.schemaVersion, 2);
  assert.equal(compact.asset.runtime.manifest.variants[0].profile, "static-pbr-compact-v2");
  assert.equal(compact.asset.directory.vertexProfileId, GEOMETRY_VERTEX_PROFILE.StaticPbrCompactV2);
  assert.equal(compact.asset.validate().valid, true);
  assert.ok(compact.evidence.vertexDataBytes < fallback.evidence.vertexDataBytes);
  assert.ok(compact.evidence.packageBytes < fallback.evidence.packageBytes);

  const descriptors = Object.fromEntries(
    compact.asset.vertexStreamDescriptors.map((stream) => [stream.semantic, stream])
  );
  assert.equal(descriptors.position.flags, GEOMETRY_VERTEX_STREAM_FLAGS.PositionAabbUnorm16);
  assert.equal(descriptors.normal.flags, GEOMETRY_VERTEX_STREAM_FLAGS.NormalOctSnorm16);
  assert.equal(descriptors.tangent.flags, GEOMETRY_VERTEX_STREAM_FLAGS.TangentSnorm16);
  assert.equal(descriptors.uv0.flags, GEOMETRY_VERTEX_STREAM_FLAGS.UvFloat16);
  assert.equal(descriptors.color.flags, GEOMETRY_VERTEX_STREAM_FLAGS.ColorUnorm8);

  const positions = source.attributes.get("position").data;
  const normals = source.attributes.get("normal").data;
  const uvs = source.attributes.get("uv0").data;
  const extent = [
    source.bounds.box[3] - source.bounds.box[0],
    source.bounds.box[4] - source.bounds.box[1],
    source.bounds.box[5] - source.bounds.box[2]
  ];
  for (let vertex = 0; vertex < source.vertexCount; vertex++) {
    const position = decodeGeometryPosition(compact.asset, vertex);
    for (let component = 0; component < 3; component++) {
      assert.ok(Math.abs(position[component] - positions[vertex * 3 + component]) <=
        extent[component] / 65535 / 2 + 1e-6);
    }
    const normal = decodeGeometryNormal(compact.asset, vertex);
    const dot = normal[0] * normals[vertex * 3] + normal[1] * normals[vertex * 3 + 1] +
      normal[2] * normals[vertex * 3 + 2];
    assert.ok(Math.acos(Math.min(1, Math.max(-1, dot))) <= 0.001);
    const uv = decodeGeometryUv(compact.asset, "uv0", vertex);
    assert.ok(Math.abs(uv[0] - uvs[vertex * 2]) <= 0.0005);
    assert.ok(Math.abs(uv[1] - uvs[vertex * 2 + 1]) <= 0.0005);
    const tangent = decodeGeometryTangent(compact.asset, vertex);
    assert.ok(Math.abs(tangent[0] - 1) <= 1 / 32767);
    assert.deepEqual([...tangent.slice(1)], [0, 0, 1]);
    const color = decodeGeometryColor(compact.asset, vertex);
    assert.ok(Math.abs(color[0] - 1) <= 1 / 255);
    assert.ok(Math.abs(color[1] - 128 / 255) <= 1 / 255);
    assert.ok(Math.abs(color[2]) <= 1 / 255);
    assert.ok(Math.abs(color[3] - 1) <= 1 / 255);
  }
  assert.deepEqual(
    compact.asset.materialRanges.map(({ firstTriangle, triangleCount, materialId }) =>
      [firstTriangle, triangleCount, materialId]),
    source.materialRanges.map(({ firstTriangle, triangleCount, materialId }) =>
      [firstTriangle, triangleCount, materialId])
  );
});

test("Runtime residency has atomic budgets, explicit ranges, retirement, and device-loss reset", async () => {
  const cooked = await cookGeometryAssetPackage(staticPbrBox(), createGeometryCookRecipe());
  const { manifest } = cooked.asset.runtime;
  const variant = manifest.variants[0];
  const reservations = [];
  const releases = [];
  const state = new RuntimeAssetResidencyState(manifest, variant, {
    reserve(request) { reservations.push(request); return true; },
    release(request) { releases.push(request); }
  });
  const ids = variant.chunkIds;
  const uploadBytes = ids.reduce((sum, id) =>
    sum + manifest.chunks.find((chunk) => chunk.id === id).compressedBytes, 0);
  const residentBytes = ids.reduce((sum, id) =>
    sum + manifest.chunks.find((chunk) => chunk.id === id).expectedResidentBytes, 0);

  assert.throws(() => state.request(ids, {
    maxUploadBytes: uploadBytes - 1,
    maxResidentBytes: residentBytes
  }), /budget/);
  assert.ok(state.snapshot().every(({ state: requestState }) => requestState === "unrequested"));

  const aborted = state.request(ids, { maxUploadBytes: uploadBytes, maxResidentBytes: residentBytes });
  state.abort(aborted);
  assert.ok(state.snapshot().every(({ state: requestState }) => requestState === "unrequested"));

  const committed = state.request(ids, { maxUploadBytes: uploadBytes, maxResidentBytes: residentBytes });
  const physical = Object.fromEntries(ids.map((id, index) => [id, {
    byteOffset: index * 4096,
    byteLength: manifest.chunks.find((chunk) => chunk.id === id).expectedResidentBytes
  }]));
  state.commit(committed, physical);
  assert.equal(state.evidence().residentChunkCount, ids.length);
  assert.equal(state.range(ids[0]).assetId, manifest.assetId);
  assert.equal(state.range(ids[0]).residentResourceId, null);
  assert.equal(state.range(ids[0]).residentByteOffset, 0);

  state.retire([ids[0]]);
  state.completeRetire([ids[0]]);
  assert.equal(state.range(ids[0]).state, "unrequested");
  state.resetAfterDeviceLoss();
  assert.ok(state.snapshot().every(({ state: requestState }) => requestState === "unrequested"));
  assert.equal(state.evidence().deviceLossResetCount, 1);
  assert.equal(reservations.length, 2);
  assert.equal(releases.length, 3);
});

test("GpuAssetStore publishes physical chunk ranges behind an unchanged opaque handle", async () => {
  const cooked = await cookGeometryAssetPackage(staticPbrBox(), createGeometryCookRecipe());
  const device = fakeDevice();
  const store = new GpuAssetStore(device);
  const command = new SceneCommand(device, []);
  const handle = store.resident(cooked.asset, command);
  assert.ok(store.residencyRanges(handle).every(({ state, residentResourceId }) =>
    state === "requested" && residentResourceId === null));
  command.finish();
  const ranges = store.residencyRanges(handle);
  assert.ok(ranges.every(({ state }) => state === "resident"));
  assert.ok(ranges.every(({ residentResourceId }) =>
    typeof residentResourceId === "string" && residentResourceId.length > 0));
  assert.equal(store.recordIndex(handle), 1);

  const release = new SceneCommand(device, []);
  store.release(handle, release);
  release.finish();
  assert.throws(() => store.residencyRanges(handle), /stale|resident/);
  store.destroy();
});

test("Instance V2 narrows stable, small, large, static, material, and visibility patches", () => {
  const writes = [];
  const device = fakeDevice();
  const scene = new GpuScene(device, { recordIndex: () => 7 });
  const source = {
    count: 4,
    geometryHandles: [{}],
    geometryIndices: new Uint32Array(4),
    materialHandles: new Uint32Array([2, 2, 2, 2]),
    currentTransforms: identityMatrices(4),
    boundsSpheres: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])
  };
  const create = new SceneCommand(device, writes);
  const handle = scene.instantiate(source, create);
  create.finish();
  assert.equal(scene.evidence().recordStride, 176);
  assert.equal(scene.evidence().staticRecordStride, GPU_INSTANCE_STATIC_RECORD_STRIDE);
  assert.equal(scene.evidence().dynamicRecordStride, GPU_INSTANCE_DYNAMIC_RECORD_STRIDE);
  assert.equal(scene.evidence().cpuShadowBytes, 4 * (GPU_INSTANCE_RECORD_STRIDE + 4));

  const stable = scene.patch(handle, { frameId: 1 }, new SceneCommand(device, writes));
  assert.equal(stable.uploadedBytes, 0);

  const smallCommand = new SceneCommand(device, writes);
  const small = scene.patch(handle, {
    frameId: 2,
    transforms: { indices: new Uint32Array([1]), transforms: translatedMatrices([[2, 3, 4]]) }
  }, smallCommand);
  assert.equal(small.uploadedBytes, GPU_INSTANCE_DYNAMIC_RECORD_STRIDE);
  smallCommand.finish();

  const largeCommand = new SceneCommand(device, writes);
  const large = scene.patch(handle, {
    frameId: 3,
    transforms: { indices: new Uint32Array([0, 1, 2, 3]), transforms: translatedMatrices([[1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]]) }
  }, largeCommand);
  assert.equal(large.uploadedBytes, 4 * GPU_INSTANCE_DYNAMIC_RECORD_STRIDE);
  largeCommand.finish();

  const classified = GPU_INSTANCE_FLAGS.AlphaTested | GPU_INSTANCE_FLAGS.DoubleSided;
  const fieldsCommand = new SceneCommand(device, writes);
  const fields = scene.patch(handle, {
    frameId: 4,
    staticInstances: {
      indices: new Uint32Array([0]),
      boundsSpheres: new Float32Array([1, 2, 3, 4]),
      debugIds: new Uint32Array([99])
    },
    materials: {
      indices: new Uint32Array([0]),
      materialHandles: new Uint32Array([9]),
      flags: new Uint32Array([classified])
    },
    visibility: {
      indices: new Uint32Array([0]),
      flags: new Uint32Array([GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.CastsShadow])
    }
  }, fieldsCommand);
  assert.equal(fields.staticCount, 1);
  assert.equal(fields.materialCount, 1);
  assert.equal(fields.visibilityCount, 1);
  assert.equal(fields.uploadedBytes, 20 + 8 + 4);
  fieldsCommand.finish();
  assert.equal(scene.evidence().staticPatchBytes, 20);
  assert.equal(scene.evidence().materialPatchBytes, 8);
  assert.equal(scene.evidence().visibilityPatchBytes, 4);
  assert.deepEqual(scene.profilePatchByteDeltas(), {
    staticPatchBytes: 20,
    transformPatchBytes: 5 * GPU_INSTANCE_DYNAMIC_RECORD_STRIDE,
    materialPatchBytes: 8,
    visibilityPatchBytes: 4
  });
  assert.deepEqual(scene.profilePatchByteDeltas(), {
    staticPatchBytes: 0,
    transformPatchBytes: 0,
    materialPatchBytes: 0,
    visibilityPatchBytes: 0
  });

  const abortedCommand = new SceneCommand(device, writes);
  scene.patch(handle, {
    frameId: 5,
    transforms: { indices: new Uint32Array([0]), transforms: translatedMatrices([[99, 0, 0]]) }
  }, abortedCommand);
  abortedCommand.abort();
  assert.equal(scene.evidence().abortedMutationCount, 1);

  const release = new SceneCommand(device, writes);
  scene.release(handle, release);
  release.finish();
  assert.throws(() => scene.range(handle), /stale|resident/);
  scene.destroy();
});

function staticPbrBox() {
  const box = buildBoxSourceGeometry(2, 4, 6);
  const attributes = [...box.attributes.values()].map((stream) => ({
    semantic: stream.semantic,
    componentCount: stream.componentCount,
    normalized: stream.normalized,
    data: stream.data
  }));
  const tangents = new Float32Array(box.vertexCount * 4);
  const colors = new Uint8Array(box.vertexCount * 4);
  for (let vertex = 0; vertex < box.vertexCount; vertex++) {
    tangents.set([1, 0, 0, 1], vertex * 4);
    colors.set([255, 128, 0, 255], vertex * 4);
  }
  attributes.push({ semantic: "tangent", componentCount: 4, data: tangents });
  attributes.push({ semantic: "color", componentCount: 4, normalized: true, data: colors });
  return createSourceGeometry({
    sourceId: "fixture://static-pbr-box-v2",
    indices: box.indices,
    attributes,
    materialRanges: box.materialRanges
  });
}

function identityMatrices(count) {
  const result = new Float32Array(count * 16);
  for (let index = 0; index < count; index++) {
    const offset = index * 16;
    result[offset] = result[offset + 5] = result[offset + 10] = result[offset + 15] = 1;
  }
  return result;
}

function translatedMatrices(translations) {
  const result = identityMatrices(translations.length);
  for (let index = 0; index < translations.length; index++) {
    result[index * 16 + 12] = translations[index][0];
    result[index * 16 + 13] = translations[index][1];
    result[index * 16 + 14] = translations[index][2];
  }
  return result;
}

class Signal {
  listeners = [];
  addOne(listener) { this.listeners.push(listener); }
  dispatch(...args) {
    const listeners = this.listeners.splice(0);
    for (const listener of listeners) listener(...args);
  }
}

class SceneCommand {
  onFinished = new Signal();
  onAborted = new Signal();
  closed = false;
  constructor(device, writes) { this.device = device; this.writes = writes; }
  writeBuffer(buffer, bufferOffset, data, dataOffset, size) {
    this.writes.push({ buffer, bufferOffset, data, dataOffset, size });
  }
  copyBufferToBuffer() {}
  finish() { this.closed = true; this.onFinished.dispatch(); }
  abort() { this.closed = true; this.onAborted.dispatch(); }
}

function fakeDevice() {
  return {
    limits: { maxBufferSize: 1 << 24, maxStorageBufferBindingSize: 1 << 24 },
    queue: { onSubmittedWorkDone: () => Promise.resolve() },
    createBuffer(descriptor) {
      const storage = new ArrayBuffer(descriptor.size);
      return {
        size: descriptor.size,
        destroyed: false,
        getMappedRange: () => storage,
        unmap() {},
        destroy() { this.destroyed = true; }
      };
    }
  };
}

function installWebGpuConstants() {
  globalThis.GPUBufferUsage ??= Object.freeze({ COPY_SRC: 4, COPY_DST: 8, STORAGE: 128 });
}
