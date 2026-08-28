import test from "node:test";
import assert from "node:assert/strict";

import {
  GPU_FRAME_PHASES,
  classifyGpuFramePhase
} from "../.test-dist/debug/GpuFramePhase.js";

test("GPU phase classifier covers current main-frame labels without hiding unknowns", () => {
  const cases = new Map([
    ["VisibilityPass/tb-eb-paged-frustum-filter", "instance-cull"],
    ["MeshletDrawList/$g-expand", "hierarchy-and-cluster-cull"],
    ["Visibility/ID+Depth/bucket-8", "hardware-raster"],
    ["R4-A-03 Packed VisibilityKey/depth alpha drawIndirect", "hardware-raster"],
    ["HZB/build_mip4", "hzb"],
    ["HZB/compute-pyramid", "hzb"],
    ["Material Expand/gbuffer", "material-resolve"],
    ["LightCluster/yh", "light-cluster"],
    ["IBL indirect diffuse uw", "lighting-and-ibl"],
    ["Direct lighting Ch", "lighting-and-ibl"],
    ["Transparent OIT", "transparency"],
    ["TAA resolve", "temporal"],
    ["Tonemap $h", "post"],
    ["VisibilityCounter/final pixels", "observability"],
    ["future pass with no registered owner", "unclassified"]
  ]);
  for (const [label, expected] of cases) {
    assert.equal(classifyGpuFramePhase(label), expected, label);
  }
  assert.equal(new Set(GPU_FRAME_PHASES).size, GPU_FRAME_PHASES.length);
  assert.ok(GPU_FRAME_PHASES.includes("unclassified"));
});

test("GPU phase classifier freezes all 40 labels from the RTX 2060 SUPER smoke", () => {
  const groups = new Map([
    ["instance-cull", [
      "VisibilityPass/tb-eb-paged-frustum-filter",
      "MeshletDrawList/instance_cull_dual_hb",
      "MeshletDrawList/instance_cull_hg_maybe"
    ]],
    ["hierarchy-and-cluster-cull", [
      "MeshletDrawList/$g-expand",
      "MeshletDrawList/ep-counts",
      "MeshletDrawList/fill_dispatch_eg",
      "MeshletDrawList/fill_draw_indirect_args",
      "MeshletDrawList/hzb_cull_dual_yb",
      "MeshletDrawList/hzb_cull_ob",
      "MeshletDrawList/jb_scatter",
      "MeshletDrawList/ka_ga",
      "MeshletDrawList/ka_ja",
      "MeshletDrawList/ka_ra",
      "MeshletDrawList/meshlet_ub_b8",
      "MeshletDrawList/og-prefix",
      "MeshletDrawList/qb_count",
      "MeshletDrawList/qb_ga",
      "MeshletDrawList/rp-dispatch",
      "MeshletDrawList/Yg-commit"
    ]],
    ["hardware-raster", [
      "Visibility/ID+Depth/bucket-8",
      "Visibility/ID+Depth/second-bucket-8"
    ]],
    ["hzb", Array.from({ length: 10 }, (_, mip) => `HZB/build_mip${mip}`)],
    ["material-resolve", ["Material Expand/depth", "Material Expand/gbuffer"]],
    ["light-cluster", ["LightCluster/yh"]],
    ["lighting-and-ibl", [
      "Direct lighting Ch",
      "Environment background Ku",
      "IBL indirect diffuse uw",
      "IBL indirect specular hw",
      "Indirect composite TB"
    ]],
    ["post", ["Tonemap $h"]]
  ]);
  const labels = [];
  for (const [expected, group] of groups) {
    for (const label of group) {
      labels.push(label);
      assert.equal(classifyGpuFramePhase(label), expected, label);
      assert.equal(
        classifyGpuFramePhase(`Renderer/main-0/${label}`),
        expected,
        `qualified ${label}`
      );
    }
  }
  assert.equal(labels.length, 40);
  assert.equal(new Set(labels).size, labels.length);
});

test("GPU phase classifier attributes auxiliary command contexts", () => {
  const cases = new Map([
    ["GraphicsContext.update/resource preparation", "upload"],
    ["GPUSceneContext/database-build/table write", "upload"],
    ["GPUSceneContext/database-incremental-update/table write", "upload"],
    ["GPUResidentMaterialContext/texture-write/blit", "upload"],
    ["GPULightCollection/build/table write", "upload"],
    ["volumetrics update/table write", "upload"],
    ["GPUSceneContext/animation-flush/skinning", "animation"]
  ]);
  for (const [label, expected] of cases) {
    assert.equal(classifyGpuFramePhase(label), expected, label);
  }
});
