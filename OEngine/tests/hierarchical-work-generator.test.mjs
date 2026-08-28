import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.GPUBufferUsage ??= {
  MAP_READ: 1 << 0,
  COPY_SRC: 1 << 2,
  COPY_DST: 1 << 3,
  UNIFORM: 1 << 6,
  STORAGE: 1 << 7,
  INDIRECT: 1 << 8
};
globalThis.GPUShaderStage ??= {
  VERTEX: 1,
  FRAGMENT: 2,
  COMPUTE: 4
};

const {
  computeIndexedPackedHierarchyWorkCapacity,
  computePackedHierarchyWorkCapacity
} = await import("../.test-dist/geometry/GeometryHierarchy.js");
const {
  computeHierarchicalDispatchGrid,
  computeHierarchicalWorkgroupGrid,
  HierarchicalWorkGenerator,
  packHierarchyViewUniform
} = await import("../.test-dist/render/HierarchicalWorkGenerator.js");
const {
  HIERARCHICAL_VIEW_OFFSETS,
  HIERARCHICAL_VIEW_UNIFORM_SIZE,
  HIERARCHICAL_WORK_GENERATION_WGSL
} = await import("../.test-dist/shaders/hierarchical_work_generation.js");
const {
  PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL
} = await import("../.test-dist/shaders/packed_visibility.js");

test("R3-B preparation computes exact combined breadth and legal-cut capacities", () => {
  const shallow = createHierarchyAsset([
    node(0, 2, 0, 1),
    node(0, 0, 1, 1),
    node(0, 0, 1, 1)
  ], [1, 2]);
  const deep = createHierarchyAsset([
    node(0, 1, 0, 1),
    node(1, 2, 1, 1),
    node(0, 0, 2, 1),
    node(0, 0, 2, 1)
  ], [1, 2, 3]);
  const capacity = computePackedHierarchyWorkCapacity([
    { asset: shallow },
    { asset: shallow },
    { asset: deep }
  ]);
  assert.deepEqual(capacity, {
    rootTraversalCapacity: 3,
    traversalWorkCapacity: 5,
    visibleClusterCapacity: 6,
    rasterWorkCapacity: 6,
    maxHierarchyDepth: 2
  });
  assert.deepEqual(
    computeIndexedPackedHierarchyWorkCapacity(
      [shallow, deep],
      new Uint32Array([0, 0, 1])
    ),
    capacity
  );

  const singleLevel = createHierarchyAsset([], []);
  singleLevel.meshlets = Array.from({ length: 3 }, () => ({}));
  assert.deepEqual(
    computeIndexedPackedHierarchyWorkCapacity(
      [shallow, singleLevel],
      new Uint32Array([0, 1, 1])
    ),
    {
      rootTraversalCapacity: 3,
      traversalWorkCapacity: 3,
      visibleClusterCapacity: 4,
      rasterWorkCapacity: 8,
      maxHierarchyDepth: 1
    }
  );
});

test("R3-B view packer freezes Perspective/Orthographic values and disabled far plane", () => {
  const perspective = perspectiveView();
  const bytes = packHierarchyViewUniform(perspective, 24, 7, 3, 4);
  const view = new DataView(bytes.buffer);
  assert.equal(bytes.byteLength, HIERARCHICAL_VIEW_UNIFORM_SIZE);
  assert.equal(view.getFloat32(HIERARCHICAL_VIEW_OFFSETS.cameraPosition + 8, true), 0);
  assert.equal(view.getFloat32(HIERARCHICAL_VIEW_OFFSETS.sse, true), 24);
  assert.ok(Math.abs(
    view.getFloat32(HIERARCHICAL_VIEW_OFFSETS.sse + 8, true) -
    1 / Math.tan(perspective.verticalFovRadians * 0.5)
  ) < 1e-6);
  assert.equal(view.getFloat32(HIERARCHICAL_VIEW_OFFSETS.orthographic + 4, true), 0);
  assert.deepEqual([
    view.getUint32(HIERARCHICAL_VIEW_OFFSETS.scene, true),
    view.getUint32(HIERARCHICAL_VIEW_OFFSETS.scene + 4, true),
    view.getUint32(HIERARCHICAL_VIEW_OFFSETS.scene + 8, true)
  ], [7, 3, 4]);
  assert.equal(
    view.getUint32(HIERARCHICAL_VIEW_OFFSETS.limits, true),
    65535
  );

  const orthographic = packHierarchyViewUniform({
    ...perspective,
    kind: "orthographic",
    verticalWorldSize: 20
  }, 12, 1, 1, 2);
  const orthographicView = new DataView(orthographic.buffer);
  assert.equal(
    orthographicView.getFloat32(HIERARCHICAL_VIEW_OFFSETS.orthographic, true),
    20
  );
  assert.equal(
    orthographicView.getFloat32(HIERARCHICAL_VIEW_OFFSETS.orthographic + 4, true),
    1
  );
});

test("R3-C dispatch grid crosses the WebGPU single-dimension limit without truncation", () => {
  assert.deepEqual(computeHierarchicalDispatchGrid(64 * 4, 4), { x: 4, y: 1 });
  assert.deepEqual(computeHierarchicalDispatchGrid(64 * 5, 4), { x: 4, y: 2 });
  assert.deepEqual(
    computeHierarchicalDispatchGrid(64 * 160_000, 65_535),
    { x: 65_535, y: 3 }
  );
  assert.throws(
    () => computeHierarchicalDispatchGrid(64 * 17, 4),
    /2D limit/
  );
});

test("R3-D Cluster expansion validates one selected Cluster per workgroup", () => {
  assert.deepEqual(computeHierarchicalWorkgroupGrid(160_000, 65_535), {
    x: 65_535,
    y: 3
  });
  assert.throws(
    () => computeHierarchicalWorkgroupGrid(17, 4),
    /adapter 2D limit/
  );
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /visible_count % raster_work_view\.limits\.x/);
});

test("R3-B owner allocates only root/ping-pong/selected resources and encodes GPU rounds", () => {
  const gpu = createFakeGpu();
  const generator = new HierarchicalWorkGenerator(gpu.device);
  const scene = createSceneDescriptor(gpu, {
    instanceCount: 3,
    maxHierarchyDepth: 2,
    traversalWorkCapacity: 5,
    visibleClusterCapacity: 6
  });
  const prepared = generator.prepare(scene, {
    sseThreshold: 24,
    countersEnabled: false
  });
  const evidence = generator.evidence(prepared);
  assert.deepEqual({
    rootCapacity: evidence.rootCapacity,
    traversalCapacity: evidence.traversalCapacity,
    visibleClusterCapacity: evidence.visibleClusterCapacity,
    rasterWorkCapacity: evidence.rasterWorkCapacity,
    drawIndirectBytes: evidence.drawIndirectBytes,
    encodedRoundCount: evidence.encodedRoundCount,
    privateSubmitCount: evidence.privateSubmitCount,
    coneResources: evidence.coneResources,
    hzbResources: evidence.hzbResources,
    softwareRasterResources: evidence.softwareRasterResources
  }, {
    rootCapacity: 3,
    traversalCapacity: 5,
    visibleClusterCapacity: 6,
    rasterWorkCapacity: 6,
    drawIndirectBytes: 16,
    encodedRoundCount: 3,
    privateSubmitCount: 0,
    coneResources: 0,
    hzbResources: 0,
    softwareRasterResources: 0
  });
  assert.equal(gpu.buffers.length, 12);
  assert.equal(
    gpu.buffers.filter((buffer) => /cone|hzb|software/i.test(buffer.label)).length,
    0
  );
  assert.equal(
    gpu.layouts.filter((layout) => /previous HZB/i.test(layout.label)).length,
    0,
    "feature-off must not allocate the previous-HZB bind group layout"
  );
  assert.ok(gpu.buffers.filter((buffer) => /dispatch/.test(buffer.label)).every(
    (buffer) => (buffer.usage & GPUBufferUsage.INDIRECT) !== 0 && buffer.size === 12
  ));
  const instanceLayout = gpu.layouts.find(
    (layout) => layout.label === "R3-B Hierarchy/instance-cull group0"
  );
  const traversalLayout = gpu.layouts.find(
    (layout) => layout.label === "R3-B Hierarchy/traversal group1"
  );
  assert.equal(instanceLayout.entries[3].buffer.minBindingSize, 40);
  assert.equal(traversalLayout.entries[5].buffer.minBindingSize, 40);
  assert.equal(traversalLayout.entries[6].buffer.minBindingSize, 40);
  assert.equal(traversalLayout.entries[7].buffer.minBindingSize, 48);
  assert.equal(
    traversalLayout.entries.filter((entry) => entry.buffer.type !== "uniform").length,
    8,
    "R3-C must stay within the default WebGPU storage-buffer limit"
  );
  const expansionLayout = gpu.layouts.find(
    (layout) => layout.label === "R3-C Hierarchy/RasterWork expansion group2"
  );
  assert.equal(expansionLayout.entries[3].buffer.minBindingSize, 40);
  const dispatchPreparationLayout = gpu.layouts.find(
    (layout) => layout.label === "R3-C Hierarchy/RasterWork dispatch preparation group2"
  );
  assert.deepEqual(
    dispatchPreparationLayout.entries.map((entry) => entry.binding),
    [0, 2, 5]
  );
  const drawIndirect = gpu.buffers.find((buffer) => /drawIndirect/.test(buffer.label));
  assert.equal(drawIndirect.size, 16);
  assert.ok((drawIndirect.usage & GPUBufferUsage.INDIRECT) !== 0);

  const encoder = new FakeEncoder();
  const generated = generator.encode(encoder, prepared, perspectiveView());
  assert.equal(generated.encodedRoundCount, 3);
  assert.equal(encoder.directDispatches.length, 2);
  assert.deepEqual(encoder.directDispatches, [[1, 1, 1], [1, 1, 1]]);
  assert.equal(encoder.indirectDispatches.length, 4);
  assert.ok(encoder.indirectDispatches.every((dispatch) => dispatch.offset === 0));
  assert.equal(encoder.copies.length, 6, "root + 3 rounds + selected + RasterWork evidence");
  assert.ok(
    encoder.clears
      .filter((clear) => /dispatch/.test(clear.buffer.label))
      .every((clear) => clear.offset === 0 && clear.size === 12),
    "2D indirect dispatch records must reset all three u32 lanes"
  );
  assert.equal(gpu.queue.submitCount, 0, "work generator must not own submit");
  assert.equal(gpu.queue.writeCount, 1, "only the current view uniform is uploaded");

  generator.release(prepared);
  assert.ok(gpu.buffers.every((buffer) => buffer.destroyCount === 1));
  assert.throws(
    () => generator.encode(new FakeEncoder(), prepared, perspectiveView()),
    /stale/
  );
  generator.destroy();
});

test("R3-B pressure capacity is bounded and WGSL keeps the frozen producer invariants", () => {
  const gpu = createFakeGpu();
  const generator = new HierarchicalWorkGenerator(gpu.device);
  const scene = createSceneDescriptor(gpu, {
    instanceCount: 2,
    maxHierarchyDepth: 1,
    traversalWorkCapacity: 8,
    visibleClusterCapacity: 4
  });
  const prepared = generator.prepare(scene, {
    sseThreshold: 1,
    countersEnabled: false,
    traversalWorkCapacity: 1
  });
  assert.equal(generator.evidence(prepared).traversalCapacity, 1);
  assert.throws(
    () => generator.prepare(scene, {
      sseThreshold: 1,
      countersEnabled: false,
      traversalWorkCapacity: 9
    }),
    /exceeds the proven scene capacity/
  );
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /r3_instance_cull/);
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /r3_traverse_clusters/);
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /r3_expand_raster_work/);
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /vertex_count = 384u/);
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /first_instance = 0u/);
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /@builtin\(num_workgroups\)/);
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /workgroup_count_y: atomic<u32>/);
  assert.match(
    HIERARCHICAL_WORK_GENERATION_WGSL,
    /R3_COUNTER_SELECTED_CLUSTERS\],\s*selected_cluster_count/s
  );
  assert.match(
    HIERARCHICAL_WORK_GENERATION_WGSL,
    /R3_COUNTER_HW_CLUSTERS\], raster_count/
  );
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /oengine_try_reserve_work_group/);
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /atomicMax\(&\(\*args\)\.workgroup_count_x/);
  assert.doesNotMatch(HIERARCHICAL_WORK_GENERATION_WGSL, /texture_2d|texture_storage/);
  generator.destroy();
});

test("R3-C production Hardware consumer pulls RasterWork and issues the GPU drawIndirect record", () => {
  assert.match(
    PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL,
    /let work = r3_raster_work\.elements\[work_index\]/
  );
  assert.match(
    PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL,
    /r3_visible_clusters\.elements\[work\.visible_cluster_slot\]/
  );
  const passSource = readFileSync(
    new URL("../src/render/passes/PackedVisibilityPass.ts", import.meta.url),
    "utf8"
  );
  assert.match(passSource, /render\.drawIndirect\(generated\.drawIndirect, 0\)/);
  const rendererSource = readFileSync(
    new URL("../src/render/Renderer.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    rendererSource,
    /hardware-packed-r3-hierarchy-cone/
  );
  assert.doesNotMatch(rendererSource, /packed_visibility_mode|r2-flat-reference/);
});

function perspectiveView() {
  return {
    kind: "perspective",
    cameraPosition: [0, 0, 0],
    viewportHeight: 1080,
    verticalFovRadians: Math.PI / 3,
    nearPlane: 0.1,
    frustumPlanes: [
      [1, 0, 0, 10],
      [-1, 0, 0, 10],
      [0, 1, 0, 10],
      [0, -1, 0, 10],
      [0, 0, -1, -0.1],
      [0, 0, 0, 1]
    ]
  };
}

function node(childBegin, childCount, depth, meshletCount) {
  return { childBegin, childCount, depth, meshletCount };
}

function createHierarchyAsset(clusters, children) {
  return {
    directory: { clusterRoot: 0 },
    clusters,
    clusterChildren: new Uint32Array(children),
    meshlets: []
  };
}

function createSceneDescriptor(gpu, values) {
  const instanceBuffer = gpu.createExternalBuffer("instances", 4096);
  const geometryBuffer = gpu.createExternalBuffer("geometries", 4096);
  const clusterBuffer = gpu.createExternalBuffer("clusters", 4096);
  const childrenBuffer = gpu.createExternalBuffer("children", 4096);
  const counterBuffer = gpu.createExternalBuffer("counters", 256);
  return {
    assets: {
      abiVersion: 1,
      epoch: 1,
      geometryRecords: geometryBuffer,
      clusterRecords: clusterBuffer,
      clusterChildren: childrenBuffer,
      highWaterCounts: { clusterRecords: 32 }
    },
    scene: {
      abiVersion: 2,
      epoch: 1,
      instances: instanceBuffer,
      recordStride: 192,
      highWaterCount: values.instanceCount + 1,
      activeCount: values.instanceCount
    },
    instanceBegin: 1,
    rasterWorkCapacity: values.visibleClusterCapacity,
    counterBuffer,
    ...values
  };
}

function createFakeGpu() {
  const buffers = [];
  const layouts = [];
  const queue = {
    submitCount: 0,
    writeCount: 0,
    writeBuffer(buffer, offset, source, dataOffset = 0, size) {
      this.writeCount++;
      const bytes = source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      const count = size ?? bytes.byteLength - dataOffset;
      new Uint8Array(buffer.data, offset, count).set(
        bytes.subarray(dataOffset, dataOffset + count)
      );
    },
    submit() {
      this.submitCount++;
    }
  };
  const device = {
    queue,
    limits: {
      maxBufferSize: 1 << 24,
      maxStorageBufferBindingSize: 1 << 24,
      maxComputeWorkgroupsPerDimension: 65535
    },
    createShaderModule(descriptor) {
      return { descriptor };
    },
    createBindGroupLayout(descriptor) {
      layouts.push(descriptor);
      return { descriptor };
    },
    createPipelineLayout(descriptor) {
      return { descriptor };
    },
    createComputePipeline(descriptor) {
      return { descriptor };
    },
    createBindGroup(descriptor) {
      return { descriptor };
    },
    createBuffer(descriptor) {
      const buffer = makeBuffer(descriptor);
      buffers.push(buffer);
      return buffer;
    }
  };
  return {
    device,
    queue,
    buffers,
    layouts,
    createExternalBuffer(label, size) {
      return makeBuffer({
        label,
        size,
        usage: GPUBufferUsage.STORAGE
      });
    }
  };
}

function makeBuffer(descriptor) {
  return {
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
}

class FakeEncoder {
  clears = [];
  copies = [];
  directDispatches = [];
  indirectDispatches = [];

  clearBuffer(buffer, offset, size) {
    this.clears.push({ buffer, offset, size });
  }

  copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
    this.copies.push({ source, sourceOffset, destination, destinationOffset, size });
  }

  beginComputePass(descriptor) {
    const owner = this;
    return {
      descriptor,
      setPipeline() {},
      setBindGroup() {},
      dispatchWorkgroups(x, y, z) {
        owner.directDispatches.push([x, y, z]);
      },
      dispatchWorkgroupsIndirect(buffer, offset) {
        owner.indirectDispatches.push({ buffer, offset });
      },
      end() {}
    };
  }
}
