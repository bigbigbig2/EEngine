import test from "node:test";
import assert from "node:assert/strict";

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUBufferUsage ??= {
  COPY_SRC: 1 << 2,
  COPY_DST: 1 << 3,
  UNIFORM: 1 << 6,
  STORAGE: 1 << 7,
  INDIRECT: 1 << 8
};

const {
  isClusterConeBackfacingReference,
  isProjectedAabbOccludedReference,
  projectAabbToPreviousHzbReference
} = await import("../.test-dist/render/HierarchyOcclusionReference.js");
const {
  packHierarchyViewUniform
} = await import("../.test-dist/render/HierarchicalWorkGenerator.js");
const {
  HIERARCHICAL_HZB_WORK_GENERATION_WGSL,
  HIERARCHICAL_WORK_GENERATION_WGSL,
  HIERARCHICAL_VIEW_OFFSETS
} = await import("../.test-dist/shaders/hierarchical_work_generation.js");

const identity = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
];

test("R3-D meshoptimizer cone oracle rejects uniform front orientation and fails open otherwise", () => {
  const cone = { apex: [0, 0, 1], axis: [0, 0, 1], cutoff: 0.5, valid: true };
  assert.equal(isClusterConeBackfacingReference(cone, identity, [0, 0, 0]), true);
  assert.equal(isClusterConeBackfacingReference(cone, identity, [0, 0, 2]), false);
  const mirrored = [...identity];
  mirrored[0] = -1;
  assert.equal(isClusterConeBackfacingReference(cone, mirrored, [0, 0, 0]), false);
  const nonUniform = [...identity];
  nonUniform[0] = 2;
  assert.equal(isClusterConeBackfacingReference(cone, nonUniform, [0, 0, 0]), false);
  assert.equal(isClusterConeBackfacingReference({ ...cone, valid: false }, identity, [0, 0, 0]), false);
});

test("R3-D previous-HZB AABB oracle selects a conservative mip and reverse-Z comparison", () => {
  const projected = projectAabbToPreviousHzbReference(
    [-0.25, -0.25, 0.2], [0.25, 0.25, 0.3],
    identity, identity, identity, 8, 8, 4
  );
  assert.ok(projected);
  assert.equal(projected.mip, 1);
  const level = { width: 4, height: 4, minMax: new Float32Array(4 * 4 * 2) };
  for (let index = 0; index < 16; index++) {
    level.minMax[index * 2] = 0.8;
    level.minMax[index * 2 + 1] = 0.9;
  }
  assert.equal(isProjectedAabbOccludedReference(projected, level), true);
  level.minMax.fill(0.1);
  assert.equal(isProjectedAabbOccludedReference(projected, level), false);
  const crossing = [...identity];
  crossing[15] = 0;
  assert.equal(projectAabbToPreviousHzbReference(
    [-1, -1, -1], [1, 1, 1], identity, identity, crossing, 8, 8, 4
  ), null);
  assert.equal(projectAabbToPreviousHzbReference(
    [-1, -1, -1], [1, 1, 1], identity, identity, identity, 8, 8, 4, false
  ), null);
  const overflowing = [...identity];
  overflowing[0] = Number.MAX_VALUE;
  assert.equal(projectAabbToPreviousHzbReference(
    [-2, -1, -1], [2, 1, 1], overflowing, identity, identity, 8, 8, 4
  ), null);

  const current = [...identity];
  current[12] = 0.5;
  const previousFromCurrent = [...identity];
  previousFromCurrent[12] = -0.5;
  assert.deepEqual(
    projectAabbToPreviousHzbReference(
      [-0.25, -0.25, 0.2], [0.25, 0.25, 0.3],
      current, previousFromCurrent, identity, 8, 8, 4
    ),
    projected
  );
});

test("R3-D shader variants and uniform flags keep invalid history feature-off", () => {
  assert.doesNotMatch(HIERARCHICAL_WORK_GENERATION_WGSL, /texture_2d/);
  assert.match(HIERARCHICAL_HZB_WORK_GENERATION_WGSL, /traversal_previous_hzb: texture_2d<f32>/);
  assert.match(HIERARCHICAL_HZB_WORK_GENERATION_WGSL, /candidate_nearest \+ 1e-6 < occluder_farthest/);
  assert.match(HIERARCHICAL_HZB_WORK_GENERATION_WGSL, /any\(clip != clip\)/);
  assert.match(HIERARCHICAL_HZB_WORK_GENERATION_WGSL, /any\(ndc != ndc\)/);
  const view = {
    kind: "perspective",
    cameraPosition: [0, 0, 0],
    viewportHeight: 720,
    verticalFovRadians: Math.PI / 3,
    nearPlane: 0.1,
    frustumPlanes: Array.from({ length: 6 }, () => [0, 0, 0, 1]),
  };
  const off = new DataView(packHierarchyViewUniform(view, 4, 0, 1, 1, true).buffer);
  assert.equal(off.getUint32(HIERARCHICAL_VIEW_OFFSETS.hzb + 12, true), 4);
  const on = new DataView(packHierarchyViewUniform(view, 4, 0, 1, 1, true, 65535, {
    coneEnabled: true,
    previousHzb: {
      view: {}, width: 8, height: 8, mipLevelCount: 4,
      worldToClipMatrix: identity
    }
  }).buffer);
  assert.equal(on.getUint32(HIERARCHICAL_VIEW_OFFSETS.hzb + 12, true), 7);
});

test("R3-D RasterWork expansion reserves once per Cluster workgroup", () => {
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /var<workgroup> raster_work_group_base: u32/);
  assert.match(
    HIERARCHICAL_WORK_GENERATION_WGSL,
    /if lane == 0u \{[\s\S]*raster_work_group_base = oengine_try_reserve_work_group/
  );
  assert.match(HIERARCHICAL_WORK_GENERATION_WGSL, /workgroupBarrier\(\)/);
  assert.match(
    HIERARCHICAL_HZB_WORK_GENERATION_WGSL,
    /previous_from_current \* current_world/
  );
  assert.match(
    HIERARCHICAL_WORK_GENERATION_WGSL,
    /for \(var local_meshlet = lane;[\s\S]*local_meshlet \+= 64u\)/
  );
  assert.match(
    HIERARCHICAL_WORK_GENERATION_WGSL,
    /atomicAdd\([\s\S]*R3_COUNTER_HW_CLUSTERS[\s\S]*cluster\.meshlet_count/
  );
  assert.doesNotMatch(HIERARCHICAL_WORK_GENERATION_WGSL, /r3_write_work_counters/);
  assert.match(
    HIERARCHICAL_WORK_GENERATION_WGSL,
    /R3_COUNTER_VISITED_HIERARCHY_NODES\], visited\)[\s\S]*R3_COUNTER_CANDIDATE_CLUSTERS\], visited\)/
  );
});
