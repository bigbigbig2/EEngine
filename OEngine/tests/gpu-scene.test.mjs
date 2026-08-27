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
  GPU_INSTANCE_FLAGS,
  GPU_INSTANCE_RECORD_OFFSETS,
  GPU_INSTANCE_RECORD_SCHEMA,
  GPU_INSTANCE_RECORD_STRIDE,
  GPU_INSTANCE_RECORD_WGSL,
  packGpuInstanceRecord
} = await import("../.test-dist/gpu/GpuInstanceAbi.js");
const { GpuScene } = await import("../.test-dist/gpu/GpuScene.js");
const { createInstanceSourceFromScene } = await import(
  "../.test-dist/gpu/GpuSceneAdapter.js"
);
const { BoxGeometry } = await import("../.test-dist/geometry/BoxGeometry.js");
const { StandardShadeMaterial } = await import(
  "../.test-dist/material/StandardShadeMaterial.js"
);
const { Mesh } = await import("../.test-dist/scene/Mesh.js");
const { Scene } = await import("../.test-dist/scene/Scene.js");

test("R2-D Instance TS packer and WGSL share the frozen 192-byte ABI", () => {
  assert.equal(GPU_INSTANCE_RECORD_SCHEMA.abiVersion, 2);
  assert.equal(GPU_INSTANCE_RECORD_SCHEMA.stride, 192);
  assert.equal(GPU_INSTANCE_RECORD_OFFSETS.current_object_to_world, 64);
  assert.equal(GPU_INSTANCE_RECORD_OFFSETS.previous_from_current, 128);
  assert.match(GPU_INSTANCE_RECORD_WGSL, /current_object_to_world: mat4x4f/);
  assert.match(GPU_INSTANCE_RECORD_WGSL, /previous_from_current: mat4x4f/);

  const current = identity(3, 4, 5);
  const previous = identity(1, 2, 3);
  const bytes = packGpuInstanceRecord({
    geometryRecordIndex: 9,
    materialHandle: 10,
    flags: GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.CastsShadow,
    debugId: 11,
    boundsSphere: [1, 2, 3, 4],
    boundsMin: [-1, -2, -3],
    boundsMax: [5, 6, 7],
    currentObjectToWorld: current,
    previousObjectToWorld: previous
  });
  const view = new DataView(bytes.buffer);
  assert.equal(bytes.byteLength, GPU_INSTANCE_RECORD_STRIDE);
  assert.equal(view.getUint32(0, true), 9);
  assert.equal(view.getUint32(4, true), 10);
  assert.equal(view.getFloat32(16, true), 1);
  assert.equal(view.getFloat32(64 + 12 * 4, true), 3);
  assert.equal(view.getFloat32(128 + 12 * 4, true), -2);
  assert.equal(view.getFloat32(128 + 13 * 4, true), -2);
});

test("R2-D bulk path accepts 1k/10k/100k without per-instance objects or private submits", async () => {
  const gpu = createFakeGpu();
  const geometryHandle = Object.freeze({});
  const scene = new GpuScene(gpu.device, {
    recordIndex(handle) {
      assert.equal(handle, geometryHandle);
      return 7;
    }
  });

  for (const count of [1_000, 10_000, 100_000]) {
    const source = makeSource(count, geometryHandle);
    assert.equal(source.geometryHandles.length, 1);
    const command = new FakeSceneCommand(gpu.device);
    scene.instantiate(source, command);
    command.finish();
  }

  const evidence = scene.evidence();
  assert.equal(evidence.instanceSetCount, 3);
  assert.equal(evidence.activeInstanceCount, 111_000);
  assert.equal(evidence.bulkInstanceCount, 111_000);
  assert.equal(evidence.logicalBytes, 111_000 * GPU_INSTANCE_RECORD_STRIDE);
  assert.equal(evidence.cpuShadowBytes, 111_000 * (GPU_INSTANCE_RECORD_STRIDE + 4));
  assert.ok(evidence.committedGrowCount > 0);
  assert.equal(evidence.committedGrowCount, evidence.attemptedGrowCount);
  assert.equal(evidence.privateSubmitCount, 0);
  assert.equal(gpu.queue.submitCount, 0);
  assert.ok(evidence.allocatedBytes >= evidence.residentBytes);

  gpu.resolveCompletion();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(scene.evidence().retiringBytes, 0);
  scene.destroy();
});

test("R2-D patch keeps previous/current semantics, deduplicates and proves 0/1/10/100 percent density", () => {
  const gpu = createFakeGpu();
  const geometryHandle = Object.freeze({});
  const scene = new GpuScene(gpu.device, { recordIndex: () => 3 });
  const create = new FakeSceneCommand(gpu.device);
  const handle = scene.instantiate(makeSource(1_000, geometryHandle), create);
  create.finish();
  const range = scene.range(handle);
  assert.equal(range.start, 1);

  const beforeNoop = scene.evidence();
  const noopCommand = new FakeSceneCommand(gpu.device);
  const noop = scene.patch(handle, { frameId: 1 }, noopCommand);
  assert.equal(noop.uploadedBytes, 0);
  assert.equal(noopCommand.operations.length, 0);
  assert.equal(scene.evidence().uploadCalls, beforeNoop.uploadCalls);
  assert.equal(scene.evidence().stableNoopCount, beforeNoop.stableNoopCount + 1);

  const densityCases = [10, 100, 1_000];
  for (let caseIndex = 0; caseIndex < densityCases.length; caseIndex++) {
    const count = densityCases[caseIndex];
    const indices = new Uint32Array(count);
    const transforms = new Float32Array(count * 16);
    for (let index = 0; index < count; index++) {
      indices[index] = index;
      transforms.set(identity(100 + caseIndex, index, 0), index * 16);
    }
    const command = new FakeSceneCommand(gpu.device);
    const result = scene.patch(handle, {
      frameId: caseIndex + 2,
      transforms: { indices, transforms }
    }, command);
    command.finish();
    assert.equal(result.density, count / 1_000);
    assert.ok(result.dirtySpanCount >= 1);
  }

  const duplicate = new FakeSceneCommand(gpu.device);
  scene.patch(handle, {
    frameId: 10,
    transforms: {
      indices: new Uint32Array([4, 4]),
      transforms: concatMatrices(identity(20, 0, 0), identity(30, 0, 0))
    },
    materials: {
      indices: new Uint32Array([4, 4]),
      materialHandles: new Uint32Array([8, 9])
    }
  }, duplicate);
  duplicate.finish();

  const buffer = scene.bindings().instances;
  const base = (range.start + 4) * GPU_INSTANCE_RECORD_STRIDE;
  let view = new DataView(buffer.data);
  assert.equal(view.getUint32(base + GPU_INSTANCE_RECORD_OFFSETS.material_handle, true), 9);
  assert.equal(view.getFloat32(base + GPU_INSTANCE_RECORD_OFFSETS.current_object_to_world + 12 * 4, true), 30);
  assert.equal(view.getFloat32(base + GPU_INSTANCE_RECORD_OFFSETS.previous_from_current + 12 * 4, true), 72);

  const sameFrame = new FakeSceneCommand(gpu.device);
  scene.patch(handle, {
    frameId: 10,
    transforms: {
      indices: new Uint32Array([4]),
      transforms: identity(40, 0, 0)
    }
  }, sameFrame);
  sameFrame.finish();
  view = new DataView(scene.bindings().instances.data);
  assert.equal(view.getFloat32(base + GPU_INSTANCE_RECORD_OFFSETS.current_object_to_world + 12 * 4, true), 40);
  assert.equal(
    view.getFloat32(base + GPU_INSTANCE_RECORD_OFFSETS.previous_from_current + 12 * 4, true),
    62,
    "a second patch in one frame must still map the new transform to the prior-frame transform"
  );

  const nextFrame = new FakeSceneCommand(gpu.device);
  scene.patch(handle, {
    frameId: 11,
    transforms: {
      indices: new Uint32Array([4]),
      transforms: identity(50, 0, 0)
    }
  }, nextFrame);
  nextFrame.finish();
  view = new DataView(scene.bindings().instances.data);
  assert.equal(view.getFloat32(base + GPU_INSTANCE_RECORD_OFFSETS.current_object_to_world + 12 * 4, true), 50);
  assert.equal(view.getFloat32(base + GPU_INSTANCE_RECORD_OFFSETS.previous_from_current + 12 * 4, true), -10);

  const singular = identity(55, 0, 0);
  singular[0] = 0;
  const singularPatch = new FakeSceneCommand(gpu.device);
  scene.patch(handle, {
    frameId: 12,
    transforms: { indices: new Uint32Array([4]), transforms: singular }
  }, singularPatch);
  singularPatch.finish();
  view = new DataView(scene.bindings().instances.data);
  assert.notEqual(
    view.getUint32(base + GPU_INSTANCE_RECORD_OFFSETS.flags, true) & GPU_INSTANCE_FLAGS.MotionInvalid,
    0
  );
  assert.equal(view.getFloat32(base + GPU_INSTANCE_RECORD_OFFSETS.previous_from_current, true), 1);
  assert.equal(view.getFloat32(base + GPU_INSTANCE_RECORD_OFFSETS.previous_from_current + 12 * 4, true), 0);

  const recoverSameFrame = new FakeSceneCommand(gpu.device);
  scene.patch(handle, {
    frameId: 12,
    transforms: { indices: new Uint32Array([4]), transforms: identity(60, 0, 0) }
  }, recoverSameFrame);
  recoverSameFrame.finish();
  view = new DataView(scene.bindings().instances.data);
  assert.notEqual(
    view.getUint32(base + GPU_INSTANCE_RECORD_OFFSETS.flags, true) & GPU_INSTANCE_FLAGS.MotionInvalid,
    0,
    "motion remains disabled when the prior-frame transform was lost earlier in the same frame"
  );

  const recoverNextFrame = new FakeSceneCommand(gpu.device);
  scene.patch(handle, {
    frameId: 13,
    transforms: { indices: new Uint32Array([4]), transforms: identity(70, 0, 0) }
  }, recoverNextFrame);
  recoverNextFrame.finish();
  view = new DataView(scene.bindings().instances.data);
  assert.equal(
    view.getUint32(base + GPU_INSTANCE_RECORD_OFFSETS.flags, true) & GPU_INSTANCE_FLAGS.MotionInvalid,
    0
  );
  assert.equal(view.getFloat32(base + GPU_INSTANCE_RECORD_OFFSETS.previous_from_current + 12 * 4, true), -10);
  assert.equal(scene.evidence().privateSubmitCount, 0);
  scene.destroy();
});

test("R2-D abort restores CPU shadow and release invalidates the generation handle", () => {
  const gpu = createFakeGpu();
  const geometryHandle = Object.freeze({});
  const scene = new GpuScene(gpu.device, { recordIndex: () => 2 });
  const create = new FakeSceneCommand(gpu.device);
  const handle = scene.instantiate(makeSource(4, geometryHandle), create);
  create.finish();
  const before = scene.evidence();

  const abortedPatch = new FakeSceneCommand(gpu.device);
  scene.patch(handle, {
    frameId: 1,
    transforms: {
      indices: new Uint32Array([0]),
      transforms: identity(999, 0, 0)
    }
  }, abortedPatch);
  abortedPatch.abort();
  assert.equal(scene.evidence().patchBatchCount, before.patchBatchCount);
  assert.equal(scene.evidence().abortedMutationCount, before.abortedMutationCount + 1);

  const releaseAbort = new FakeSceneCommand(gpu.device);
  scene.release(handle, releaseAbort);
  releaseAbort.abort();
  assert.equal(scene.range(handle).count, 4);

  const release = new FakeSceneCommand(gpu.device);
  scene.release(handle, release);
  release.finish();
  assert.equal(scene.evidence().activeInstanceCount, 0);
  assert.equal(scene.evidence().releaseCount, 1);
  assert.throws(() => scene.range(handle), /stale|not resident/);
  assert.equal(gpu.queue.submitCount, 0);
  scene.destroy();
});

test("R2-D ordinary Scene adapter writes the same InstanceSource without replacement objects", () => {
  const scene = new Scene();
  const geometry = new BoxGeometry(2, 3, 4);
  const material = new StandardShadeMaterial();
  const first = Mesh.from(geometry, material);
  first.position = [1, 2, 3];
  const second = Mesh.from(geometry, material);
  second.position = [4, 5, 6];
  scene.addChild(first);
  scene.addChild(second);
  const handle = Object.freeze({});
  const source = createInstanceSourceFromScene(scene, {
    geometryHandle: () => handle,
    materialHandle: () => 23
  });
  assert.equal(source.count, 2);
  assert.deepEqual(source.geometryHandles, [handle]);
  assert.deepEqual([...source.geometryIndices], [0, 0]);
  assert.deepEqual([...source.materialHandles], [23, 23]);
  assert.equal(source.currentTransforms[12], 1);
  assert.equal(source.currentTransforms[16 + 12], 4);
  assert.deepEqual([...source.debugIds], [first.id, second.id]);
  assert.equal(scene.instances.instances[0], first);
  assert.equal(scene.instances.instances[1], second);
});

function makeSource(count, geometryHandle) {
  const geometryIndices = new Uint32Array(count);
  const materialHandles = new Uint32Array(count);
  const currentTransforms = new Float32Array(count * 16);
  const boundsSpheres = new Float32Array(count * 4);
  for (let index = 0; index < count; index++) {
    materialHandles[index] = index % 5;
    currentTransforms.set(identity(index, 0, 0), index * 16);
    boundsSpheres.set([0, 0, 0, 1], index * 4);
  }
  return {
    count,
    geometryHandles: [geometryHandle],
    geometryIndices,
    materialHandles,
    currentTransforms,
    boundsSpheres
  };
}

function identity(x = 0, y = 0, z = 0) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1
  ]);
}

function concatMatrices(...matrices) {
  const result = new Float32Array(matrices.length * 16);
  matrices.forEach((matrix, index) => result.set(matrix, index * 16));
  return result;
}

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

class FakeSceneCommand {
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
      maxBufferSize: 1 << 27,
      maxStorageBufferBindingSize: 1 << 27
    },
    createBuffer(descriptor) {
      const buffer = {
        ...descriptor,
        data: new ArrayBuffer(descriptor.size),
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
