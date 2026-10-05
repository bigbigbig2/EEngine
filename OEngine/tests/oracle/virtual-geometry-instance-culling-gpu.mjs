import assert from "node:assert/strict";
import { buildVirtualGeometrySceneSourceV1 } from "../../.test-dist/assets/geometry-product/VirtualGeometrySceneSourceV1.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";
import { HierarchicalWorkGenerator } from "../../.test-dist/render/HierarchicalWorkGenerator.js";
import {
  GPU_INSTANCE_ABI_VERSION,
  GPU_INSTANCE_FLAGS,
  packGpuInstanceRecord
} from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { GPU_GEOMETRY_ABI_VERSION } from "../../.test-dist/gpu/GpuGeometryAbi.js";
import { GPU_COUNTER_BYTE_SIZE } from "../../.test-dist/debug/GpuFrameCounters.js";
import {
  GEOMETRY_PRODUCT_GPU_ABI_VERSION_V1,
  encodeGeometryProductGpuLocationV1
} from "../../.test-dist/gpu/GeometryProductGpuAbiV1.js";

/** Runs the production root + hierarchy kernels; no browser or render loop. */
export async function runVirtualGeometryInstanceCullingGpuOracle(device) {
  const buffers = [];
  const buffer = (data, usage = GPUBufferUsage.STORAGE) => {
    const value = device.createBuffer({
      size: typeof data === "number" ? data : data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST
    });
    if (typeof data !== "number") device.queue.writeBuffer(value, 0, data);
    buffers.push(value);
    return value;
  };
  // One resident terminal Group, addressed through the real Product heap ABI.
  const heap = new Uint32Array(96),
    f = new Float32Array(heap.buffer);
  heap.set([GEOMETRY_PRODUCT_GPU_ABI_VERSION_V1, 1, 1, 96, 16, 32, 36, 68, 72, 84, 88, 92]);
  heap.set([1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], 16);
  heap.set([0, 1, 0, 0], 32);
  heap.set([0, 1, 0, 1, 0, 1], 36 + 18);
  f[36 + 11] = 1;
  f.set([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5], 36 + 12);
  f.set([0, 0, 0, 1, -0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 3.4028234663852886e38], 72);
  heap[83] = 1;
  heap.set([0, 0, 256, 0], 84);
  heap.set(
    new Uint32Array(
      encodeGeometryProductGpuLocationV1({
        bankIndex: 0,
        slotIndex: 0,
        residentBankIndex: 0,
        residentSlotIndex: 0,
        productGeneration: 1,
        flags: 3,
        byteOffset: 0
      }).buffer
    ),
    88
  );
  heap.set([16 | (3 << 16), 12 << 8, 1 << 16, 0], 92);
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, -20, 1]);
  const source = buildVirtualGeometrySceneSourceV1(
    new Uint8Array(heap.buffer, 36 * 4, 128),
    [{}],
    [{ assetIndex: 0, materialIndex: 0, transform: matrix }],
    [{}],
    { scale: 0.1 }
  ).source;
  const transform = source.currentTransforms;
  const record = (boundsSphere) =>
    packGpuInstanceRecord({
      geometryRecordIndex: 0,
      geometryGeneration: 1,
      materialHandle: 0,
      flags: GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.VirtualGeometry,
      debugId: 0,
      boundsSphere,
      boundsMin: source.boundsMin,
      boundsMax: source.boundsMax,
      currentObjectToWorld: transform,
      previousObjectToWorld: transform
    });
  const instances = buffer(record(source.boundsSpheres));
  const placeholder = buffer(256),
    metadata = buffer(heap);
  const counters = buffer(GPU_COUNTER_BYTE_SIZE, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const owner = new HierarchicalWorkGenerator(device);
  const prepared = owner.prepare(
    {
      assets: {
        abiVersion: GPU_GEOMETRY_ABI_VERSION,
        geometryRecords: placeholder,
        clusterRecords: placeholder,
        clusterChildren: placeholder
      },
      scene: { abiVersion: GPU_INSTANCE_ABI_VERSION, instances, highWaterCount: 1 },
      instanceBegin: 0,
      instanceCount: 1,
      maxHierarchyDepth: 1,
      traversalWorkCapacity: 1,
      visibleClusterCapacity: 1,
      rasterWorkCapacity: 1,
      counterBuffer: counters,
      virtualGeometry: {
        metadata,
        metadataByteLength: heap.byteLength,
        productTableSlot: 0,
        productGeneration: 1,
        pageCount: 1,
        banks: [placeholder]
      }
    },
    { sseThreshold: 4, countersEnabled: true, diagnosticsEnabled: true, rasterExpansionEnabled: false }
  );
  const evidence = prepared.generated.evidence;
  const read = buffer(evidence.size, GPUBufferUsage.MAP_READ);
  const camera = new PerspectiveCamera();
  camera.near = 0.01;
  camera.aspect = 16 / 9;
  const center = { x: 10, y: 0, z: -2 };
  let passed = 0,
    oldFalseRejections = 0;
  try {
    for (const distance of [0.02, 0.2, 2, 20]) {
      for (const [yaw, pitch] of [
        [0, 0],
        [1.4, 0],
        [-1.4, 0],
        [0, 1.55],
        [0, -1.55]
      ]) {
        camera.transform.position.set(
          center.x + distance * Math.sin(yaw) * Math.cos(pitch),
          center.y + distance * Math.sin(pitch),
          center.z + distance * Math.cos(yaw) * Math.cos(pitch)
        );
        camera.transform.lookAt(center);
        camera.update();
        const view = {
          kind: "perspective",
          cameraPosition: [...camera.transform.matrix.slice(12, 15)],
          viewportHeight: 720,
          verticalFovRadians: camera.fov,
          nearPlane: camera.near,
          frustumPlanes: Array.from({ length: 6 }, (_, i) => [...camera.frustum.slice(i * 4, i * 4 + 4)])
        };
        for (const emulateOldBounds of [true, false]) {
          // Negative control: the old mapper publishes fitted world bounds,
          // then the real root kernel transforms them again.
          device.queue.writeBuffer(
            instances,
            0,
            record(emulateOldBounds ? [10, 0, -2, 0.1] : source.boundsSpheres)
          );
          const encoder = device.createCommandEncoder();
          owner.encode(encoder, prepared, view, { previousHzb: null, coneEnabled: false });
          encoder.copyBufferToBuffer(evidence, 0, read, 0, evidence.size);
          device.queue.submit([encoder.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          const words = new Uint32Array(read.getMappedRange().slice(0));
          read.unmap();
          const selected = words[prepared.generated.evidenceLayout.selectedHeaderIndex * 8];
          if (emulateOldBounds) {
            oldFalseRejections += Number(selected === 0);
          } else {
            assert.equal(
              selected,
              1,
              `visible Group lost at distance=${distance}, yaw=${yaw}, pitch=${pitch}; evidence=${[...words]}`
            );
            assert.equal(
              words[prepared.generated.evidenceLayout.selectedHeaderIndex * 8 + 3],
              0,
              "no visible queue overflow"
            );
            passed++;
          }
        }
      }
    }
    assert.ok(oldFalseRejections > 0, "negative control must reproduce the old double-transform rejection");
    return { passed, oldFalseRejections };
  } finally {
    owner.release(prepared);
    owner.destroy();
    for (const value of buffers) value.destroy();
  }
}
