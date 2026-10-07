import assert from "node:assert/strict";
import { deepProductFixture } from "../helpers/geometry-product-fixture.mjs";
import { geometryProductSceneWorkload } from "../../.test-dist/assets/geometry-product/GeometryProductWorkload.js";
import { GeometryProductMultiRuntimeV1 } from "../../.test-dist/gpu/GeometryProductMultiRuntime.js";
import { HierarchicalWorkGenerator } from "../../.test-dist/render/HierarchicalWorkGenerator.js";
import { VirtualGeometryMeshletWorkCandidate } from "../../.test-dist/render/MeshletWorkCandidate.js";
import {
  GPU_INSTANCE_ABI_VERSION,
  GPU_INSTANCE_FLAGS,
  packGpuInstanceRecord,
} from "../../.test-dist/gpu/GpuInstanceAbi.js";
import { GPU_GEOMETRY_ABI_VERSION } from "../../.test-dist/gpu/GpuGeometryAbi.js";
import { GPU_COUNTER_BYTE_SIZE } from "../../.test-dist/debug/GpuFrameCounters.js";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const view = {
  kind: "perspective",
  cameraPosition: [0, 0, 4],
  viewportHeight: 720,
  verticalFovRadians: Math.PI / 3,
  nearPlane: 0.1,
  frustumPlanes: Array.from({ length: 6 }, () => [0, 0, 0, 1]),
};

/** Production Product publication → hierarchy → MeshletWork, with independent
 * complete-set assertions and intentional failure/abort controls. */
export async function runGeometryProductScaleGpuOracle(device) {
  const multi = new GeometryProductMultiRuntimeV1(device);
  const hierarchy = new HierarchicalWorkGenerator(device);
  const candidate = new VirtualGeometryMeshletWorkCandidate(device);
  const buffers = [];
  const buffer = (
    size,
    usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  ) => {
    const result = device.createBuffer({ size, usage });
    buffers.push(result);
    return result;
  };
  const placeholder = buffer(256);
  const counters = buffer(GPU_COUNTER_BYTE_SIZE);
  const drawMirror = buffer(16);
  const drawCopy = device.createComputePipeline({
    layout: "auto",
    compute: {
      entryPoint: "main",
      module: device.createShaderModule({
        code: `
      @group(0) @binding(0) var<storage, read> source: array<u32>;
      @group(0) @binding(1) var<storage, read_write> destination: array<u32>;
      @compute @workgroup_size(1) fn main() {
        for (var index = 0u; index < 4u; index++) { destination[index] = source[index]; }
      }
    `,
      }),
    },
  });
  const results = [];
  const productDepths = [0, 7, 40];
  try {
    const handles = [];
    for (const [index, depth] of productDepths.entries()) {
      const { descriptor, page } = deepProductFixture(depth);
      descriptor.productId.fill(index + 1);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", page));
      descriptor.pageRecords.set(hash.subarray(0, 16));
      handles.push(
        await multi.load({
          descriptor,
          async readPage(pageId) {
            return {
              productId: descriptor.productId,
              revision: 0,
              pageId,
              decodedHash128: hash.subarray(0, 16),
              decodedPageHash128: hash.subarray(0, 16),
              bytes: page.slice().buffer,
            };
          },
          release() {},
        }),
      );
    }
    for (const [name, population, fault] of [
      ["terminal-depth0", [[0, 1]], null],
      ["deep40-many-instances", [[2, 65]], null],
      [
        "multi-product",
        [
          [0, 3],
          [1, 2],
          [2, 1],
        ],
        null,
      ],
      ["root-overflow", [[0, 65]], "traversal"],
      ["internal-overflow", [[1, 1]], "traversal"],
      ["selected-overflow", [[1, 2]], "selected"],
      ["work-overflow", [[1, 2]], "work"],
      ["stale-generation", [[0, 2]], "generation"],
      ["discard-then-retry", [[1, 3]], "abort"],
    ]) {
      const records = [];
      const expected = [];
      let maxDepth = 0,
        traversal = 0,
        visible = 0,
        meshlets = 0;
      let instance = 0;
      for (const [product, count] of population) {
        const handle = handles[product];
        const bounds = geometryProductSceneWorkload(
          handle.descriptor,
          Array.from({ length: count }, () => ({ assetIndex: 0 })),
        );
        maxDepth = Math.max(maxDepth, bounds.hierarchyMaxDepth);
        traversal += bounds.hierarchyTraversalCapacity;
        visible += bounds.hierarchyVisibleClusterCapacity;
        meshlets += bounds.hierarchyRasterWorkCapacity;
        const groupBegin = handles
          .slice(0, product)
          .reduce((sum, item) => sum + item.descriptor.groupDirectory.byteLength / 16, 0);
        for (let local = 0; local < count; local++, instance++) {
          const matrix = [...identity];
          if (local % 2 === 1) {
            matrix[0] = -2;
            matrix[5] = 0.5;
          }
          records.push(
            packGpuInstanceRecord({
              geometryRecordIndex: handle.assetReferenceBegin,
              geometryGeneration:
                fault === "generation" && local === count - 1
                  ? handle.productGeneration + 100
                  : handle.productGeneration,
              productTableSlot: handle.productTableSlot,
              materialHandle: 0,
              flags: GPU_INSTANCE_FLAGS.Active | GPU_INSTANCE_FLAGS.VirtualGeometry,
              debugId: instance,
              boundsSphere: [0, 0, 0, 1],
              boundsMin: [-1, -1, -1],
              boundsMax: [1, 1, 1],
              currentObjectToWorld: matrix,
              previousObjectToWorld: matrix,
            }),
          );
          // The independent comb fixture has depth + 1 terminal groups.
          // Do not derive expected coverage from the capacity under test.
          for (let group = 0; group < productDepths[product] + 1; group++) {
            expected.push(`${instance}/${handle.assetReferenceBegin}/${(groupBegin + group) << 7}`);
          }
        }
      }
      const instanceBytes = new Uint8Array(records.length * 176);
      records.forEach((record, index) => instanceBytes.set(new Uint8Array(record), index * 176));
      const instances = buffer(instanceBytes.byteLength);
      device.queue.writeBuffer(instances, 0, instanceBytes);
      const scene = { abiVersion: GPU_INSTANCE_ABI_VERSION, instances, highWaterCount: records.length };
      const h = hierarchy.prepare(
        {
          assets: {
            abiVersion: GPU_GEOMETRY_ABI_VERSION,
            geometryRecords: placeholder,
            clusterRecords: placeholder,
            clusterChildren: placeholder,
          },
          scene,
          instanceBegin: 0,
          instanceCount: records.length,
          maxHierarchyDepth: maxDepth,
          traversalWorkCapacity: traversal,
          visibleClusterCapacity: fault === "selected" ? 1 : visible,
          rasterWorkCapacity: meshlets,
          counterBuffer: counters,
          virtualGeometry: multi.bindings(),
        },
        {
          sseThreshold: 1,
          countersEnabled: true,
          diagnosticsEnabled: true,
          rasterExpansionEnabled: false,
          traversalWorkCapacity: fault === "traversal" ? 1 : traversal,
        },
      );
      const w = candidate.prepare({
        virtualGeometry: multi.bindings(),
        visibleClusters: h.generated.visibleClusters,
        viewUniform: h.generated.viewUniform,
        visibleClusterCapacity: h.generated.visibleClusterCapacity,
        capacity: fault === "work" ? 1 : meshlets,
        counterBuffer: counters,
        countersEnabled: true,
        scene,
      });
      try {
        if (fault === "abort") {
          const discarded = device.createCommandEncoder();
          hierarchy.encode(discarded, h, view, { coneEnabled: false });
          candidate.encode({ gpu_encoder: discarded }, w);
          discarded.finish(); // deliberately never submitted
        }
        const encoder = device.createCommandEncoder();
        hierarchy.encode(encoder, h, view, { coneEnabled: false });
        candidate.encode({ gpu_encoder: encoder }, w);
        const read = buffer(w.queue.size + 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
        encoder.copyBufferToBuffer(w.queue, 0, read, 0, w.queue.size);
        // Draw args are production STORAGE|INDIRECT, not COPY_SRC. Snapshot
        // through a read-only oracle dispatch instead of changing their usage.
        const copy = encoder.beginComputePass({ label: "Oracle draw snapshot" });
        copy.setPipeline(drawCopy);
        copy.setBindGroup(
          0,
          device.createBindGroup({
            layout: drawCopy.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: w.drawIndirect } },
              { binding: 1, resource: { buffer: drawMirror } },
            ],
          }),
        );
        copy.dispatchWorkgroups(1);
        copy.end();
        encoder.copyBufferToBuffer(drawMirror, 0, read, w.queue.size, 16);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const words = new Uint32Array(read.getMappedRange().slice(0));
        read.unmap();
        const failed = fault !== null && fault !== "abort";
        const count = failed ? 0 : expected.length;
        assert.equal(words[1], count, `${name}: complete MeshletWork count`);
        assert.equal(words[w.queue.size / 4 + 1], count, `${name}: same indirect count`);
        if (failed) {
          assert.ok(words[4] + words[6] > 0, `${name}: failure is observable`);
        } else {
          assert.equal(words[4] + words[6], 0, `${name}: no hidden overflow/invalid`);
          const actual = Array.from({ length: count }, (_, index) => {
            const at = 8 + index * 6;
            return `${words[at]}/${words[at + 1]}/${words[at + 2]}`;
          });
          assert.deepEqual(actual.sort(), expected.sort(), `${name}: every instance/group exactly once`);
        }
        results.push({
          name,
          maxDepth,
          traversal,
          visible,
          meshlets,
          written: count,
          rounds: h.generated.encodedRoundCount,
          queueBytes: w.queue.size,
          hierarchyBytes: hierarchy.evidence(h).transientBytes,
        });
      } finally {
        candidate.release(w);
        hierarchy.release(h);
      }
    }
    return { passed: results.length, results };
  } finally {
    await device.queue.onSubmittedWorkDone();
    candidate.destroy();
    hierarchy.destroy();
    multi.destroy();
    for (const item of buffers) item.destroy();
  }
}
