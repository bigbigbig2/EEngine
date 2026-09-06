import test from "node:test";
import assert from "node:assert/strict";

test("visibility-to-surface workloads have deterministic execution contracts", async () => {
  const module = await import("./benchmark-workloads.ts").catch(() => null);
  assert.ok(module, "benchmark-workloads.ts must exist");

  assert.deepEqual(module.RENDERING_LAB_WORKLOAD_IDS, [
    "comprehensive-full",
    "cube-far-effects-off",
    "cube-near-effects-off",
    "projection-normalized",
    "microtriangle-stress",
    "heavy-overdraw-large-occluder",
    "material-mosaic-7",
    "near-plane-motion"
  ]);
  assert.deepEqual(module.resolveRenderingLabWorkload().id, "comprehensive-full");
  assert.deepEqual(
    module.resolveRenderingLabWorkload("cube-near-effects-off"),
    {
      id: "cube-near-effects-off",
      caseIds: ["base"],
      camera: {
        kind: "pose",
        position: [5.2, -0.05, 1.35],
        target: [5.2, -0.4, -0.8]
      },
      sseThreshold: 4,
      animateScene: false
    }
  );
  assert.equal(
    module.resolveRenderingLabWorkload("microtriangle-stress").sseThreshold,
    0.25
  );
  assert.equal(
    module.resolveRenderingLabWorkload("projection-normalized").camera.kind,
    "projection-normalized"
  );
  assert.throws(
    () => module.resolveRenderingLabWorkload("invented-workload"),
    /Unknown Rendering Lab workload/
  );
});
