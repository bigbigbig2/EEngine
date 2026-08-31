import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

globalThis.GPUShaderStage ??= { COMPUTE: 4, VERTEX: 1, FRAGMENT: 2 };
globalThis.GPUBufferUsage ??= {
  STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, INDIRECT: 8, UNIFORM: 16
};
globalThis.GPUTextureUsage ??= {
  RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4
};

const {
  SHADOW_ATLAS_MAX_SIZE,
  computePracticalCascadeSplits,
  snapShadowBoundsToTexelGrid
} = await import("../.test-dist/gpu/ShadowContext.js");
const {
  PACKED_CSM_COUNTER_OFFSETS,
  createPackedShadowHierarchyView
} = await import("../.test-dist/render/passes/PackedCsmShadowPass.js");
const {
  PACKED_CSM_COUNTER_WGSL,
  PACKED_CSM_SHADOW_WGSL
} = await import("../.test-dist/shaders/packed_csm_shadow.js");
const {
  GPU_COUNTER_FIELDS,
  GPU_COUNTER_SCHEMA_VERSION
} = await import("../.test-dist/debug/GpuFrameCounters.js");

test("FX-04 practical CSM splits are monotonic, finite and end at the camera far plane", () => {
  const splits = [...computePracticalCascadeSplits(0.1, 1000, 3, 0.5)];
  assert.equal(splits.length, 3);
  assert.ok(splits[0] > 0 && splits[0] < splits[1]);
  assert.ok(splits[1] < splits[2]);
  assert.equal(splits[2], 1);
  assert.throws(() => computePracticalCascadeSplits(0, 100, 3), /0 < near < far/);
  assert.throws(() => computePracticalCascadeSplits(1, 100, 3, 2), /\[0, 1\]/);
});

test("FX-04 texel snapping keeps a cascade projection stable for sub-texel motion", () => {
  const a = { x0: -9.7, x1: 10.3, y0: -9.7, y1: 10.3, width: 20, height: 20 };
  const b = { x0: -9.69, x1: 10.31, y0: -9.69, y1: 10.31, width: 20, height: 20 };
  snapShadowBoundsToTexelGrid(a, 200, 200);
  snapShadowBoundsToTexelGrid(b, 200, 200);
  assert.equal(a.x0, b.x0);
  assert.equal(a.x1, b.x1);
  assert.equal(a.y0, b.y0);
  assert.equal(a.y1, b.y1);
  assert.throws(
    () => snapShadowBoundsToTexelGrid({ ...a, width: 0 }, 200, 200),
    /positive bounds/
  );
});

test("FX-04 Packed CSM consumes SecondaryRasterWork with one indirect draw and alpha caster semantics", async () => {
  const source = await readFile(
    new URL("../src/render/passes/PackedCsmShadowPass.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /pass\.drawIndirect\(generated\.drawIndirect, 0\)/);
  assert.match(source, /requiredInstanceFlags: GPU_INSTANCE_FLAGS\.CastsShadow/);
  assert.match(source, /countersEnabled: false/);
  assert.match(PACKED_CSM_SHADOW_WGSL, /OENGINE_MATERIAL_ALPHA_MASK/);
  assert.match(PACKED_CSM_SHADOW_WGSL, /OENGINE_MATERIAL_ALPHA_BLEND \{ discard/);
  assert.match(PACKED_CSM_SHADOW_WGSL, /alpha < record\.alpha_cutoff \{ discard/);
  assert.doesNotMatch(source, /for \(const material/);
});

test("FX-04 sampled queue evidence owns real per-cascade, alpha, atlas and overflow fields", () => {
  assert.equal(GPU_COUNTER_SCHEMA_VERSION, 9);
  const names = new Set(GPU_COUNTER_FIELDS.map((field) => field.name));
  for (const name of [
    "shadowCascade0RasterWork", "shadowCascade1RasterWork",
    "shadowCascade2RasterWork", "shadowAtlasPixelsUpdated",
    "shadowAlphaRasterWork", "shadowQueueOverflowMask"
  ]) assert.ok(names.has(name), name);
  assert.deepEqual(Object.values(PACKED_CSM_COUNTER_OFFSETS), [232, 236, 240, 244, 248, 252]);
  assert.match(PACKED_CSM_COUNTER_WGSL, /work\.header\.overflow/);
  assert.match(PACKED_CSM_COUNTER_WGSL, /min\(work\.header\.written, work\.header\.capacity\)/);
});

test("FX-04 shadow atlas stays under the frozen cap and is lazy when feature-off", async () => {
  assert.equal(SHADOW_ATLAS_MAX_SIZE, 4096);
  assert.ok(SHADOW_ATLAS_MAX_SIZE * SHADOW_ATLAS_MAX_SIZE * 4 <= 134_217_728);
  const source = await readFile(new URL("../src/gpu/ShadowContext.ts", import.meta.url), "utf8");
  const constructor = source.slice(source.indexOf("constructor(graphics"), source.indexOf("get texture"));
  assert.doesNotMatch(constructor, /new GPUTextureContext|new ShadowRasterPass|new PackedCsmShadowPass/);
  assert.match(source, /setEnabled\(enabled: boolean, command: ShadeGPUCommandContext\)/);
  assert.match(source, /command\.destroyAfterGpuDone/);
  assert.match(source, /view\.packed_camera_state = undefined/);
  assert.match(source, /for \(const owner of viewOwners\) owner\.destroy\(\)/);
});

test("FX-04 porting ledger freezes exact licensed sources and WebGPU differences", async () => {
  const ledger = await readFile(
    new URL("../../docs/references/porting/R5-02-packed-csm-shadow.md", import.meta.url),
    "utf8"
  );
  assert.match(ledger, /DirectX-SDK-Samples/);
  assert.match(ledger, /07e3eaa10e7dd026ec9d95fe326db2d5c4227e1b/);
  assert.match(ledger, /CascadedShadowsManager\.cpp/);
  assert.match(ledger, /three\.js[\s\S]*7cda7e710d884827fc73ff1a3aa63270846513d7/);
  assert.match(ledger, /license: MIT/g);
  assert.match(ledger, /不依赖 MDI、mesh shader、64-bit atomic/);
  assert.match(ledger, /Packed point\/spot shadow 保持未支持/);
});

test("FX-04 orthographic hierarchy view preserves cascade frustum and scale", () => {
  const camera = {
    frustum: Float32Array.from({ length: 24 }, (_, index) => index + 1),
    transform: { matrix: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1]) },
    top: 7,
    bottom: -3
  };
  const view = createPackedShadowHierarchyView(camera, 1440);
  assert.equal(view.kind, "orthographic");
  assert.deepEqual(view.cameraPosition, [4, 5, 6]);
  assert.equal(view.viewportHeight, 1440);
  assert.equal(view.verticalWorldSize, 10);
  assert.deepEqual(view.frustumPlanes[0], [1, 2, 3, 4]);
});
