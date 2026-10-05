import assert from "node:assert/strict";
import { VirtualGeometryMeshletWorkCandidate } from "../../.test-dist/render/MeshletWorkCandidate.js";
import { packGpuInstanceRecord } from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { GPU_COUNTER_BYTE_SIZE } from "../../.test-dist/debug/GpuFrameCounters.js";
import {
  GEOMETRY_PRODUCT_GPU_ABI_VERSION_V1,
  encodeGeometryProductGpuLocationV1
} from "../../.test-dist/gpu/GeometryProductGpuAbiV1.js";

/** Focused oracle for the production owner; caller supplies an actual GPUDevice. */
export async function runVirtualGeometryHandoffGpuOracle(device) {
  const buffers = [];
  function buffer(bytes, usage = GPUBufferUsage.STORAGE) {
    const data = typeof bytes === "number" ? null : bytes;
    const value = device.createBuffer({
      size: data?.byteLength ?? bytes,
      usage: usage | GPUBufferUsage.COPY_DST
    });
    if (data) device.queue.writeBuffer(value, 0, data);
    buffers.push(value);
    return value;
  }
  const heap = new Uint32Array(124);
  // Deliberately nonzero Product group base (3) AND asset-local group base (2).
  // Payload refine ID=3 resolves to global group 6, not assetBegin+3=8.
  heap.set([GEOMETRY_PRODUCT_GPU_ABI_VERSION_V1, 1, 1, 124, 16, 32, 36, 68, 72, 84, 112, 120]);
  heap.set([1, 1, 0, 1, 0, 1, 0, 1, 3, 4, 0, 2, 0, 1], 16);
  heap.set([0, 1, 0, 0], 32);
  heap.set([0, 1, 0, 1, 5, 2], 36 + 18);
  heap.set([0, 0, 8192, 0], 84 + 5 * 4);
  heap.set([1, 0, 8192, 0], 84 + 6 * 4);
  // ABI v2 separates geometry and resident positions in the packed slot word.
  // Inputs use the production codec; draw counts and compacted IDs below remain
  // independently specified, including rejection of the original stale ABI.
  for (let slot = 0; slot < 2; slot++) {
    heap.set(
      new Uint32Array(
        encodeGeometryProductGpuLocationV1({
          bankIndex: 0,
          slotIndex: slot,
          residentBankIndex: 0,
          residentSlotIndex: slot,
          productGeneration: 1,
          flags: slot === 0 ? 3 : 1,
          byteOffset: slot * 262144
        }).buffer
      ),
      112 + slot * 4
    );
  }
  heap.set([16 | (3 << 16), 12 << 8, 1 << 16, 0], 120);
  const metadata = buffer(heap);
  const bankBytes = new ArrayBuffer(2 * 262144),
    words = new Uint32Array(bankBytes),
    floats = new Float32Array(bankBytes);
  words[12] = 64;
  words[15] = 8192;
  floats[262144 / 4 + 3] = 1;
  floats[262144 / 4 + 10] = 1;
  const bank = buffer(bankBytes);
  const banks = [bank, buffer(4), buffer(4), buffer(4)];
  const visible = new Uint32Array(14);
  visible[0] = 1;
  visible[1] = 1;
  visible[5] = 1;
  visible[10] = 5;
  const visibleClusters = buffer(visible);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const instances = buffer(
    packGpuInstanceRecord({
      geometryRecordIndex: 0,
      geometryGeneration: 1,
      materialHandle: 0,
      flags: 1,
      debugId: 0,
      boundsSphere: [0, 0, 0, 1],
      boundsMin: [-1, -1, -1],
      boundsMax: [1, 1, 1],
      currentObjectToWorld: identity,
      previousObjectToWorld: identity
    })
  );
  const viewBytes = new Float32Array(64);
  viewBytes[2] = 10;
  viewBytes.set([2, 100, 1, 0.1], 28);
  const viewUniform = buffer(viewBytes, GPUBufferUsage.UNIFORM);
  const counterBuffer = buffer(GPU_COUNTER_BYTE_SIZE);
  const owner = new VirtualGeometryMeshletWorkCandidate(device);
  const copyModule = device.createShaderModule({
    code: `
    @group(0) @binding(0) var<storage,read> source: array<u32>;
    @group(0) @binding(1) var<storage,read_write> destination: array<u32>;
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
      if(id.x<arrayLength(&source)){destination[id.x]=source[id.x];}
    }`
  });
  const copy = device.createComputePipeline({
    layout: "auto",
    compute: { module: copyModule, entryPoint: "main" }
  });
  function capture(encoder, source) {
    const mirror = buffer(source.size, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const read = device.createBuffer({
      size: source.size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    buffers.push(read);
    const pass = encoder.beginComputePass();
    pass.setPipeline(copy);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: copy.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: source } },
          { binding: 1, resource: { buffer: mirror } }
        ]
      })
    );
    pass.dispatchWorkgroups(Math.ceil(source.size / 256));
    pass.end();
    encoder.copyBufferToBuffer(mirror, 0, read, 0, source.size);
    return read;
  }
  const cases = [];
  try {
    for (const count of [1, 63, 64, 65, 128]) {
      for (const mode of [
        "leaf",
        "missing",
        "near",
        "far",
        "equal",
        "mixed",
        "overflow",
        "invalid",
        "old-abi"
      ]) {
        heap[0] =
          mode === "old-abi" ? GEOMETRY_PRODUCT_GPU_ABI_VERSION_V1 - 1 : GEOMETRY_PRODUCT_GPU_ABI_VERSION_V1;
        words[11] = count;
        for (let m = 0; m < count; m++) {
          const at = 16 + m * 12;
          words[at] = 3 | (1 << 16);
          words[at + 3] = mode === "leaf" || (mode === "mixed" && m % 2 === 0) ? 0xffffffff : 3;
        }
        if (mode === "invalid") words[16 + (count - 1) * 12] = 3 | (129 << 16);
        heap[116] = mode === "missing" ? 0xffffffff : 0;
        viewBytes[2] = mode === "far" ? 100 : 10;
        viewBytes[28] = mode === "equal" ? 1 : 2;
        viewBytes[32] = 100;
        viewBytes[33] = mode === "equal" ? 1 : 0;
        device.queue.writeBuffer(metadata, 0, heap);
        device.queue.writeBuffer(bank, 0, bankBytes);
        device.queue.writeBuffer(viewUniform, 0, viewBytes);
        // Overflow must retain enough survivors to exercise bounded reservation.
        if (mode === "overflow") {
          for (let m = 0; m < count; m++) words[16 + m * 12 + 3] = 0xffffffff;
          device.queue.writeBuffer(bank, 0, bankBytes);
        }
        const capacity = mode === "overflow" ? Math.max(1, count - 1) : 128;
        const prepared = owner.prepare({
          virtualGeometry: { metadata, banks, productGeneration: 1 },
          visibleClusters,
          viewUniform,
          visibleClusterCapacity: 1,
          capacity,
          counterBuffer,
          countersEnabled: false,
          scene: { instances }
        });
        // Rebind also exercises the production sampled/unsampled counter seam.
        owner.rebind(prepared, { counterBuffer, countersEnabled: true });
        const encoder = device.createCommandEncoder();
        owner.encode({ gpu_encoder: encoder }, prepared);
        const queueRead = capture(encoder, prepared.queue),
          drawRead = capture(encoder, prepared.drawIndirect);
        device.queue.submit([encoder.finish()]);
        await Promise.all([queueRead.mapAsync(GPUMapMode.READ), drawRead.mapAsync(GPUMapMode.READ)]);
        const queue = new Uint32Array(queueRead.getMappedRange().slice(0));
        const draw = new Uint32Array(drawRead.getMappedRange().slice(0));
        queueRead.unmap();
        drawRead.unmap();
        const overflow = mode === "overflow" && count > capacity;
        const expected =
          mode === "near" || mode === "invalid" || mode === "old-abi" || overflow
            ? 0
            : mode === "mixed"
              ? Math.ceil(count / 2)
              : count;
        assert.equal(draw[1], expected, `${count}/${mode}: draw count`);
        assert.equal(queue[4], overflow ? count : 0, `${count}/${mode}: overflow`);
        assert.equal(queue[6], mode === "invalid" || mode === "old-abi" ? 1 : 0, `${count}/${mode}: invalid`);
        if (expected) {
          const ids = Array.from({ length: expected }, (_, i) => queue[8 + i * 6 + 2] & 127);
          assert.deepEqual(
            ids,
            Array.from({ length: expected }, (_, i) => (mode === "mixed" ? i * 2 : i)),
            `${count}/${mode}: exact compacted IDs`
          );
        }
        owner.release(prepared);
        cases.push(`${count}/${mode}`);
      }
    }
    return { passed: cases.length, cases };
  } finally {
    owner.destroy();
    for (const b of buffers) b.destroy();
  }
}
