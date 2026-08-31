import assert from "node:assert/strict";
import test from "node:test";

import {
  GPU_SECONDARY_RASTER_ABI_VERSION,
  GPU_SECONDARY_RASTER_FLAGS,
  GPU_SECONDARY_RASTER_SCHEMA,
  secondaryRasterQueueByteLength
} from "../.test-dist/gpu/GpuSecondaryRasterAbi.js";
import { GPU_INSTANCE_FLAGS } from "../.test-dist/gpu/GpuInstanceAbi.js";
import {
  HIERARCHICAL_VIEW_OFFSETS,
  HIERARCHICAL_VIEW_UNIFORM_SIZE
} from "../.test-dist/shaders/hierarchical_work_generation.js";
globalThis.GPUShaderStage ??= { COMPUTE: 4, VERTEX: 1, FRAGMENT: 2 };
globalThis.GPUBufferUsage ??= {
  STORAGE: 1,
  COPY_SRC: 2,
  COPY_DST: 4,
  INDIRECT: 8,
  UNIFORM: 16
};
const { packHierarchyViewUniform } = await import(
  "../.test-dist/render/HierarchicalWorkGenerator.js"
);

const view = {
  kind: "orthographic",
  cameraPosition: [0, 0, 10],
  viewportHeight: 1024,
  verticalWorldSize: 20,
  frustumPlanes: [
    [1, 0, 0, 10], [-1, 0, 0, 10], [0, 1, 0, 10],
    [0, -1, 0, 10], [0, 0, 1, 10], [0, 0, -1, 10]
  ]
};

test("FX-04 SecondaryRasterWork v1 freezes queue, locator, flags and full indirect ownership", () => {
  assert.equal(GPU_SECONDARY_RASTER_ABI_VERSION, 1);
  assert.equal(GPU_SECONDARY_RASTER_SCHEMA.queueHeader.stride, 32);
  assert.deepEqual(GPU_SECONDARY_RASTER_SCHEMA.visibleCluster.offsets, {
    instance_record_index: 0,
    geometry_record_index: 4,
    cluster_record_index: 8,
    material_handle: 12,
    raster_flags: 16
  });
  assert.deepEqual(GPU_SECONDARY_RASTER_SCHEMA.rasterWork.offsets, {
    visible_cluster_slot: 0,
    meshlet_record_index: 4,
    raster_flags: 8
  });
  assert.equal(GPU_SECONDARY_RASTER_SCHEMA.drawIndirectBytes, 16);
  assert.equal(new Set(Object.values(GPU_SECONDARY_RASTER_FLAGS)).size, 4);
  assert.equal(secondaryRasterQueueByteLength(4), 32 + 4 * 12);
  assert.throws(() => secondaryRasterQueueByteLength(0), /positive u32/);
});

test("FX-04 hierarchy uniform filters secondary views by real CastsShadow instance flags", () => {
  const bytes = packHierarchyViewUniform(
    view, 1, 1, 4, 2, false, 65535,
    { requiredInstanceFlags: GPU_INSTANCE_FLAGS.CastsShadow }
  );
  assert.equal(bytes.byteLength, HIERARCHICAL_VIEW_UNIFORM_SIZE);
  const data = new DataView(bytes.buffer);
  assert.equal(
    data.getUint32(HIERARCHICAL_VIEW_OFFSETS.scene + 12, true),
    GPU_INSTANCE_FLAGS.CastsShadow
  );
});
