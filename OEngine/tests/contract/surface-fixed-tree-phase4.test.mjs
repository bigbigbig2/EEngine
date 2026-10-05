import test from "node:test";
import assert from "node:assert/strict";
import { referenceSurfaceCellPlans } from "../../.test-dist/render/surface/SurfaceCellReference.js";
import {
  SURFACE_CELL_PLAN_MODE as MODE,
  SURFACE_CELL_SIGNAL as SIGNAL,
  SURFACE_CELL_PLANE_COUNT as COUNT,
  surfaceCellSixBit,
} from "../../.test-dist/gpu/GpuSurfaceCellPlanAbi.js";
import {
  SURFACE_CELL_TREE_NODES,
  SURFACE_CELL_TREE_LEVELS,
  SURFACE_CELL_TREE_WORKGROUP_BYTES,
} from "../../.test-dist/gpu/GpuSurfaceCellTreeAbi.js";
import { createSurfaceCellPipelineLayout } from "../../.test-dist/render/surface/SurfaceCellPipelineLayout.js";

function tile() {
  return Array.from({ length: 64 }, (_, i) => ({
    covered: true,
    winner: i + 1,
    geometryIdentity: [1, 2, 3, 4],
    planeIdentity: Array.from({ length: COUNT }, () => [17, 19]),
    worldPosition: [i % 8, Math.floor(i / 8), 0],
    plane: [0, 0, 1, 0],
    worldUnitsPerPixel: 1,
    normal: [0, 0, 1],
    normalCone: 0,
    view: [0, 0, 1],
    roughnessLow: 0.8,
    coatRoughnessLow: 0.8,
    enabledMask: (1 << COUNT) - 1,
    publicationMask: 0,
    unknownMask: 0,
    directSafe: true,
    clusterIdentity: [1, 7],
    bounds: Array.from({ length: 15 }, (_, field) => ({
      low: field === 6 || field === 12 ? [0, 0, 1] : [0.25],
      high: field === 6 || field === 12 ? [0, 0, 1] : [0.25],
    })),
  }));
}

test("fixed rectangles reject checkerboard domains without recovering nonadjacent member subsets", () => {
  const input = tile();
  input.forEach((lane, i) => (lane.planeIdentity[0] = [17, i % 2]));
  const plans = referenceSurfaceCellPlans(input);
  assert.equal(plans[0].mode, MODE.fine);
  assert.equal(plans[1].groups.length, 4);
});

test("safe child intervals never authorize a parent that exceeds the complete field budget", () => {
  const input = tile();
  input.forEach((lane, i) => {
    const value = Math.floor((i % 8) / 2) % 2 ? 0.29 : 0.25;
    lane.bounds[0] = { low: [value], high: [value] };
  });
  const plan = referenceSurfaceCellPlans(input)[0];
  assert.equal(plan.groups.length, 16);
  assert.ok(plan.groups.every((group) => group.length === 4));
});

test("parent anchor plane is judged for fields as well as lighting without erasing safe children", () => {
  const input = tile();
  input.forEach((lane, i) => {
    const height = Math.floor((i % 8) / 2) % 2 ? 2 : 0;
    lane.worldPosition[2] = height;
    lane.plane[3] = -height;
  });
  const plans = referenceSurfaceCellPlans(input);
  assert.equal(plans[0].groups.length, 16);
  assert.equal(plans[SIGNAL.environmentDiffuse].groups.length, 16);
});

test("different exact cluster identities refine direct alone even if the light payloads could match", () => {
  const input = tile();
  input.forEach((lane, i) => (lane.clusterIdentity = [i % 2, 7]));
  const plans = referenceSurfaceCellPlans(input);
  assert.equal(plans[SIGNAL.directDiffuse].mode, MODE.fine);
  assert.equal(plans[SIGNAL.directSpecular].mode, MODE.fine);
  assert.equal(plans[SIGNAL.environmentDiffuse].groups.length, 1);
  assert.equal(plans[0].groups.length, 4);
});

test("complete point values retain fine references while unrelated misses still merge", () => {
  const input = tile();
  input.forEach((lane) => {
    lane.valueHitMask = (1 << 0) | (1 << SIGNAL.environmentDiffuse);
  });
  const plans = referenceSurfaceCellPlans(input);
  assert.equal(plans[0].mode, MODE.fine);
  assert.equal(plans[SIGNAL.environmentDiffuse].mode, MODE.fine);
  assert.equal(plans[1].groups.length, 4);
});

test("partial and mixed coverage always selects a real covered anchor and partitions each write domain once", () => {
  const input = tile();
  input.forEach((lane, i) => {
    lane.covered = i !== 0 && i !== 17 && i % 8 !== 7;
    lane.planeIdentity[0] = [17, i % 8 < 3 ? 1 : 2];
  });
  const plan = referenceSurfaceCellPlans(input)[0],
    visited = new Set();
  assert.equal(plan.mode, MODE.masked);
  for (const group of plan.groups)
    for (const member of group) {
      assert.equal(input[member].covered, true);
      assert.equal(visited.has(member), false);
      visited.add(member);
      const slot = surfaceCellSixBit(plan.ownerMap, member);
      const anchor = surfaceCellSixBit(plan.representativeMap, slot);
      assert.equal(input[anchor].covered, true);
      assert.ok(group.includes(anchor));
    }
  assert.equal(visited.size, input.filter((lane) => lane.covered).length);
});

test("actual portable tree scratch is negotiated before any bind group layout is created", () => {
  assert.equal(SURFACE_CELL_TREE_NODES, 21);
  assert.deepEqual(
    SURFACE_CELL_TREE_LEVELS.map((level) => level.count),
    [16, 4, 1],
  );
  assert.ok(SURFACE_CELL_TREE_WORKGROUP_BYTES <= 16384);
  assert.throws(
    () =>
      createSurfaceCellPipelineLayout(
        {
          limits: {
            maxComputeWorkgroupStorageSize: SURFACE_CELL_TREE_WORKGROUP_BYTES - 1,
            maxStorageBuffersPerShaderStage: 16,
          },
          createBindGroupLayout() {
            throw new Error("allocation before negotiation");
          },
        },
        false,
      ),
    /workgroup bytes/,
  );
});
