# OEngine Visibility-to-Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏 OEngine GPU-first 主链路的前提下，把 `VisibilityKey → Surface` 从像素队列重排迁移为有界 MaterialClassDepth / class-discard backend，并以可选的 TriangleSetup candidate cache 降低大三角形逐像素属性重建成本。

**Architecture:** `VisibilityFeature` 只生产正式的 `ExactRasterFrame` 与 `VisibilityFrame`；`SurfaceFeature` 通过 `MaterialResolveBackend` 消费这些 FrameProduct。迁移严格按 M0-M7 推进，每个阶段先写失败测试，再做最小实现，并且只有满足 RFC 中对应的正确性、生命周期、内存和 P50/P95 Gate 才能删除旧路径或进入下一阶段。

**Tech Stack:** TypeScript 5.8、WebGPU、WGSL、FrameGraph、Node test runner、Vite、Rendering Lab、Chrome WebGPU timestamps/counters。

**Spec:** [OEngine_Visibility_to_Surface_WebGPU_RFC.md](./OEngine_Visibility_to_Surface_WebGPU_RFC.md)

## Global Constraints

- WebGPU baseline 不依赖 64-bit atomic、multi-draw-indirect、mesh/task shader、buffer device address、bindless 或 subgroup。
- 新 GPU 队列必须声明 ABI、容量、overflow、producer、consumer、计数器和 fail-visible 行为。
- GPU producer 必须直接连接 GPU consumer；CPU 不得回读并遍历可见列表来驱动最终绘制。
- `Renderer` 只编排正式 FrameProduct；不得继续把 `PackedVisibilityDebugSource` 当生产合同。
- feature-off 时不得保留 Pass、资源分配、history、counter copy、readback 或独立 submit。
- 正式性能证据固定为 1920×1080、DPR 1、固定 seed、120 warm-up + 480 measured、timestamp cadence 8、counter cadence 11，并至少执行三个独立 run。
- 所有代码阶段采用 red-green-refactor；提交前运行命中测试，里程碑关闭前运行 `npm run build`、完整 `npm test` 和浏览器命中场景。
- 任何 Gate 未通过时保留可验证 fallback 并停止依赖该 Gate 的删除，不通过文档措辞把失败改写为完成。

---

## File Structure

- `OEngine/src/render/pipeline/FrameProducts.ts`：跨 feature 的不可变 FrameProduct 接口与校验构造器。
- `OEngine/src/render/VisibilityWorkSet.ts`：按 device/scene/resourceEpoch/capacity 缓存的大型可复用 GPU 资源；不持有 counter sink。
- `OEngine/src/render/VisibilityBindingSet.ts`：按帧绑定 runtime counter 与 late-bound 状态的轻量 binding owner。
- `OEngine/src/gpu/GpuExactRasterAbi.ts`：32 B `ExactRasterRecord` 和 TriangleSetup record 的唯一 CPU/WGSL ABI 定义。
- `OEngine/src/render/MaterialResolveBackend.ts`：legacy、class-depth 与 class-discard 的内部 backend 合同。
- `OEngine/src/render/passes/PackedMaterialClassDepthPass.ts`：从 VisibilityKey 产生 MaterialClassDepth。
- `OEngine/src/shaders/packed_material_class_depth.ts`：class depth / class-discard 共享 WGSL。
- `OEngine/src/render/passes/PackedMaterialResolvePass.ts`：固定 7 个 class pipeline 的 Surface producer。
- `OEngine/src/shaders/packed_material_resolve.ts`：直接按 `frag_coord` 读取 VisibilityKey，消费 ExactRaster/TriangleSetup。
- `OEngine/src/debug/GpuFrameCounters.ts`：surface/class/setup 的 cadence-controlled 计数合同。
- `OEngine/src/debug/profiling/ResourceAccounting.ts`：exact、class-depth、setup 的 owner/category/lifetime 记账。
- `examples/rendering-lab/benchmark-suite.ts` 与 `benchmark-report.ts`：固定 workload、A/B metadata、percentile 与 Gate 结果。

---

### Task 1 / M0: Measurement Harness

**Files:**

- Modify: `OEngine/src/debug/profiling/PerformanceCapture.ts`
- Modify: `OEngine/src/debug/BenchmarkEvidenceGate.ts`
- Modify: `examples/rendering-lab/benchmark-suite.ts`
- Modify: `examples/rendering-lab/benchmark-report.ts`
- Modify: `examples/rendering-lab/fixture.ts`
- Test: `OEngine/tests/performance-capture.test.mjs`
- Test: `OEngine/tests/benchmark-evidence-gate.test.mjs`

**Interfaces:**

- Produces: `SurfacePhaseTiming = { classifyMs, classDepthMs, resolveMs, lightingMs }`，字段缺样本时为 `null`，不得用 CPU 时间代替 GPU 时间。
- Produces: workload ids `cube-far-effects-off`、`cube-near-effects-off`、`projection-normalized`、`microtriangle-stress`、`heavy-overdraw-large-occluder`、`material-mosaic-7`、`near-plane-motion`。

- [x] **Step 1: 写 evidence gate 失败测试**

```js
test("surface migration requires independent GPU-timestamp runs", () => {
  const result = evaluateBenchmarkEvidence({
    runs: twoOtherwiseValidRuns,
    requiredIndependentRuns: 3,
    requiredGpuPhases: ["surface.resolve", "lighting"]
  });
  assert.equal(result.cleanEligible, false);
  assert.match(result.reasons.join("\n"), /3 independent runs/);
});
```

- [x] **Step 2: 运行测试并确认因缺少三次独立 run/phase 合同而失败**

Run: `node --test tests/performance-capture.test.mjs tests/benchmark-evidence-gate.test.mjs`

Expected: FAIL，且失败点指向新增字段或 Gate，而不是语法错误。

- [x] **Step 3: 实现最小 timing 与 workload metadata**

```ts
export interface SurfacePhaseTiming {
  readonly classifyMs: number | null;
  readonly classDepthMs: number | null;
  readonly resolveMs: number | null;
  readonly lightingMs: number | null;
}
```

FrameGraph timing label 固定使用 `surface.classify`、`surface.classDepth`、`surface.resolve`、`lighting`；报告必须保留 adapter、浏览器、分辨率、DPR、seed、warm-up、measured、cadence 与 run id。

- [x] **Step 4: 加入 Rendering Lab 固定场景并运行命中测试**

Run: `node --test tests/performance-capture.test.mjs tests/benchmark-evidence-gate.test.mjs tests/pipeline-profile-evidence.test.mjs`

Expected: PASS；旧渲染路径输出不变。

- [x] **Step 5: 运行 smoke，保存 baseline 而不宣称 release Gate**

Run: `node examples/rendering-lab/profile-smoke.mjs`

Expected: 30 warm-up + 60 measured；报告包含四个 GPU phase、样本覆盖、workload id 和 adapter 信息。

- [x] **Step 6: 提交 M0**

```bash
git add OEngine/src/debug OEngine/tests examples/rendering-lab
git commit -m "perf: establish visibility surface migration baseline"
```

---

### Task 2 / M1: Formal Frame Products and Resource Lifetime

**Files:**

- Create: `OEngine/src/render/VisibilityWorkSet.ts`
- Create: `OEngine/src/render/VisibilityBindingSet.ts`
- Modify: `OEngine/src/render/pipeline/FrameProducts.ts`
- Modify: `OEngine/src/gpu/GpuScene.ts`
- Modify: `OEngine/src/render/passes/PackedVisibilityPass.ts`
- Modify: `OEngine/src/render/features/VisibilityFeature.ts`
- Modify: `OEngine/src/render/Renderer.ts`
- Test: `OEngine/tests/r4-visibility-lifecycle.test.mjs`
- Test: `OEngine/tests/gpu-scene.test.mjs`
- Test: `OEngine/tests/r5-surface-contract.test.mjs`

**Interfaces:**

- Produces: `GpuScene.resourceEpoch` 只在 GPU resource identity/size 改变时递增；`contentRevision` 在合法内容 patch 时递增。
- Produces: `ExactRasterFrame`、`VisibilityFrame`、`MaterialClassificationFrame`；产品只保存 `ResourceId` 和尺寸/容量，不保存 JS snapshot 的 `activeKernelMask`。
- Produces: `VisibilityWorkSetKey = { device, sceneId, resourceEpoch, classCapacity }`；counter sink 只进入 `VisibilityBindingSet`。

- [ ] **Step 1: 写 lifecycle 与 FrameProduct 失败测试**

```js
test("content patch reuses work resources while resource growth replaces them", () => {
  const first = feature.prepare(scene, countersA);
  scene.patchMaterial(existingHandle, patch);
  const patched = feature.prepare(scene, countersB);
  assert.equal(patched.workSet, first.workSet);
  assert.notEqual(patched.bindings, first.bindings);
  scene.reserveInstances(scene.capacity + 1);
  assert.notEqual(feature.prepare(scene, countersB).workSet, first.workSet);
});
```

- [ ] **Step 2: 运行测试确认当前 debug source/cache key 行为失败**

Run: `node --test tests/r4-visibility-lifecycle.test.mjs tests/gpu-scene.test.mjs tests/r5-surface-contract.test.mjs`

Expected: FAIL，证明当前没有正式 product 或内容 patch 错误触发大资源重建。

- [ ] **Step 3: 加入产品与校验构造器**

```ts
export interface ExactRasterFrame {
  readonly records: ResourceId;
  readonly indirect: ResourceId;
  readonly classCapacity: number;
}
export interface VisibilityFrame {
  readonly key: ResourceId;
  readonly depth: ResourceId;
  readonly exact: ExactRasterFrame;
  readonly domain: TextureDomain<"internal-full">;
}
export interface MaterialClassificationFrame {
  readonly visibility: VisibilityFrame;
  readonly counters: ResourceId | null;
}
```

- [ ] **Step 4: 拆分 epoch、WorkSet 与 binding，并迁移 Renderer 消费者**

实现规则：content patch 只更新 `contentRevision`；buffer replacement/capacity/device change 更新 `resourceEpoch`；`Renderer` 不再从 `debugResolve` 获取 exact buffer。Debug view 可继续有只读 debug adapter，但不得成为 Surface producer 依赖。

- [ ] **Step 5: 运行阶段测试和 build**

Run: `node --test tests/r4-visibility-lifecycle.test.mjs tests/gpu-scene.test.mjs tests/r5-surface-contract.test.mjs tests/framegraph-compiled.test.mjs`

Run: `npm run build`

Expected: PASS；旧/new product shader 输出 bit-identical；counter cadence 切换不增加 WorkSet 数或 resident work-cache bytes。

- [ ] **Step 6: 提交 M1**

```bash
git add OEngine/src/render OEngine/src/gpu/GpuScene.ts OEngine/tests
git commit -m "refactor: formalize visibility frame products"
```

---

### Task 3 / M2: VisibilityKey v3 and Kernel Class Ownership

**Files:**

- Modify: `OEngine/src/gpu/GpuVisibilityKeyAbi.ts`
- Modify: `OEngine/src/gpu/GpuInstanceAbi.ts`
- Modify: `OEngine/src/gpu/GpuPackedSceneRegistry.ts`
- Modify: `OEngine/src/shaders/packed_visibility.ts`
- Modify: every shader returned by `rg -l "visibility_key|VisibilityKey" OEngine/src/shaders OEngine/src/render`
- Test: `OEngine/tests/gpu-visibility-key-abi.test.mjs`
- Test: `OEngine/tests/gpu-packed-scene-registry.test.mjs`
- Test: `OEngine/tests/material-visibility-shader-abi.test.mjs`
- Test: `OEngine/tests/shader-source-audit.test.mjs`
- Create: `examples/rendering-lab/visibility-key-oracle.html`
- Create: `examples/rendering-lab/visibility-key-oracle.ts`
- Create: `examples/rendering-lab/visibility-key-oracle.mjs`
- Modify: `examples/package.json`
- Modify: `examples/vite.config.ts`

**Interfaces:**

- Produces: 29-bit `rasterWorkSlot` + 3-bit `kernelClass`，`EMPTY=0xffffffff`，`INVALID=0xfffffffe`。
- Produces: `tryEncodeVisibilityKey(slot, kernelClass): { key: number; valid: boolean }`；越界永远返回 invalid，禁止 mask 截断别名。
- Produces: `materialKernelClass(material): 0 | 1 | 2 | 3 | 4 | 5 | 6` 作为 stage、patch 与 shader flags 的唯一分类函数。

- [x] **Step 1: 写 CPU/WGSL vector 与 overflow 失败测试**

```js
assert.deepEqual(tryEncodeVisibilityKey(0x1fffffff, 6), {
  key: (6 * 0x20000000 + 0x1fffffff) >>> 0,
  valid: true
});
assert.deepEqual(tryEncodeVisibilityKey(0x20000000, 0), {
  key: GPU_VISIBILITY_KEY_INVALID,
  valid: false
});
assert.notEqual(tryEncodeVisibilityKey(0x20000000, 0).key, 0);
```

- [x] **Step 2: 运行测试确认 v2 ABI 失败**

Run: `node --test tests/gpu-visibility-key-abi.test.mjs tests/gpu-packed-scene-registry.test.mjs tests/material-visibility-shader-abi.test.mjs`

Expected: FAIL，当前版本为 2 且没有 kernel class。

- [x] **Step 3: 实现集中式 v3 encode/decode 和 instance flag**

```ts
export const GPU_VISIBILITY_KEY_SLOT_BITS = 29;
export const GPU_VISIBILITY_KEY_SLOT_MASK = 0x1fffffff;
export const GPU_VISIBILITY_KEY_CLASS_SHIFT = 29;
export function tryEncodeVisibilityKey(slot: number, kernelClass: number) {
  const valid = Number.isInteger(slot) && slot >= 0 && slot <= GPU_VISIBILITY_KEY_SLOT_MASK &&
    Number.isInteger(kernelClass) && kernelClass >= 0 && kernelClass <= 6;
  return Object.freeze({
    key: valid ? (((kernelClass << 29) | slot) >>> 0) : GPU_VISIBILITY_KEY_INVALID,
    valid
  });
}
```

WGSL 必须使用 range guard；不得写 `slot & SLOT_MASK` 作为 encode。所有 consumer 用 helper 取低 29 bit 和 class，不得散落 magic shift/mask。

- [x] **Step 4: stage/material patch 共用分类并测试 abort rollback**

Run: `node --test tests/gpu-visibility-key-abi.test.mjs tests/gpu-packed-scene-registry.test.mjs tests/material-visibility-shader-abi.test.mjs tests/shader-source-audit.test.mjs`

Expected: PASS；非法 encode counter 在正式 workload 为 0；patch abort 后 flags/class count 恢复。

GPU oracle: `cd examples && npm run test:visibility-key-oracle`。该 oracle 在真实 WebGPU compute pipeline 中执行同一份 WGSL encode/decode，并与 seeded CPU vectors readback 对比。

- [ ] **Step 5: 运行一个旧路径浏览器 parity smoke（runtime smoke 已完成；缺少 v2 screenshot baseline）**

Run: `node examples/rendering-lab/profile-smoke.mjs`

Expected: 截图与 v2 baseline bit-identical，invalid/overflow 为 0。

- [ ] **Step 6: 提交 M2（等待用户确认提交）**

```bash
git add OEngine/src/gpu OEngine/src/render OEngine/src/shaders OEngine/tests
git commit -m "feat: encode material kernel class in visibility key"
```

---

### Task 4 / M3: ClassDepth and Class-Discard Surface Backends

**Files:**

- Create: `OEngine/src/render/MaterialResolveBackend.ts`
- Create: `OEngine/src/render/passes/PackedMaterialClassDepthPass.ts`
- Create: `OEngine/src/shaders/packed_material_class_depth.ts`
- Modify: `OEngine/src/render/passes/PackedMaterialResolvePass.ts`
- Modify: `OEngine/src/shaders/packed_material_resolve.ts`
- Modify: `OEngine/src/render/features/SurfaceFeature.ts`
- Modify: `OEngine/src/render/Renderer.ts`
- Test: `OEngine/tests/visible-pixel-classification.test.mjs`
- Test: `OEngine/tests/packed-material-class-depth.test.mjs`
- Test: `OEngine/tests/packed-material-resolve.test.mjs`
- Test: `OEngine/tests/framegraph-compiled.test.mjs`

**Interfaces:**

- Consumes: M2 `VisibilityFrame` 与 late-bound `activeKernelMask` runtime state。
- Produces: internal `MaterialResolveBackend = "legacy-pixel-queue" | "class-depth" | "class-discard"`，仅用于迁移 A/B，不从 `OEngine/src/index.ts` 导出。
- Produces: `MaterialClassDepthFrame = { depth: ResourceId, format: "depth32float" }`；Surface backend 固定注册 7 个 pipeline。

- [x] **Step 1: 写 class-depth 与 cached-graph late-binding 失败测试**

```js
test("cached graph reads the current active kernel mask", () => {
  runtime.activeKernelMask = 0b0000001;
  executeCachedGraph();
  assert.equal(pass.lastKernelDrawCount, 1);
  runtime.activeKernelMask = 0b1000000;
  executeCachedGraph();
  assert.equal(pass.lastKernelDrawCount, 1);
  assert.equal(pass.lastKernelClasses[0], 6);
});
```

再加入 EMPTY discard、7 类深度值、depth32/depth16 parity、same-pass attachment sampling 禁止项和 class-discard fallback 测试。

- [x] **Step 2: 运行测试确认 backend/pass 尚不存在**

Run: `node --test tests/packed-material-class-depth.test.mjs tests/packed-material-resolve.test.mjs tests/framegraph-compiled.test.mjs`

Expected: FAIL，缺少 pass/backend 与 late-bound 行为。

- [x] **Step 3: 实现 class-depth producer 与 7 个 bounded draws**

ClassDepth pass 与 Surface pass 必须是不同 render pass；不得在同一 pass 采样正在作为 attachment 写入的 texture。第一版始终编码 7 个 draw 以先验证正确性；active-mask skipping 只能在 cached graph 测试通过后启用。

- [x] **Step 4: 实现 correctness fallback**

`class-depth` 使用 `depthCompare: "equal"`；adapter/image parity 不成立时选择 `class-discard`：Surface pipeline 使用 `depthCompare: "always"`，fragment 读取 VisibilityKey 后按 class discard。fallback 必须记录 diagnostics，不得形成第三条长期产品管线。

- [ ] **Step 5: 运行测试、build 与三次正式 A/B**

Run: `node --test tests/packed-material-class-depth.test.mjs tests/packed-material-resolve.test.mjs tests/framegraph-compiled.test.mjs tests/resource-accounting.test.mjs`

Run: `npm run build`

Run: Rendering Lab formal profile，legacy 与 class-depth/class-discard 各三个独立 run。

Expected: attachment bit-identical；`cube-near` Surface P50 改善至少 15%、P95 至少 10%；microtriangle total GPU P50/P95 回归均不超过 5%。未达标则记录证据并停止 Task 5 的删除。

- [ ] **Step 6: 提交 M3**

```bash
git add OEngine/src/render OEngine/src/shaders OEngine/tests examples/rendering-lab
git commit -m "feat: add bounded material depth surface backend"
```

---

### Task 5 / M4: Remove Legacy Pixel Queue

**Files:**

- Delete: `OEngine/src/render/VisiblePixelClassifier.ts`
- Delete: `OEngine/src/shaders/visible_pixel_classification.ts`
- Modify: `OEngine/src/render/passes/PackedMaterialResolvePass.ts`
- Modify: `OEngine/src/render/features/SurfaceFeature.ts`
- Modify: `OEngine/src/render/Renderer.ts`
- Modify: `OEngine/src/debug/profiling/ResourceAccounting.ts`
- Test: `OEngine/tests/visible-pixel-classification.test.mjs`
- Test: `OEngine/tests/source-geometry.test.mjs`
- Test: `OEngine/tests/resource-accounting.test.mjs`

**Interfaces:**

- Consumes: M3 Gate 的三次正式 A/B 通过证据。
- Produces: 单一 Surface backend；保留 `class-discard` 作为 adapter correctness fallback，删除 `legacy-pixel-queue`。

- [ ] **Step 1: 写 source-shape/FrameGraph 失败测试**

```js
for (const forbidden of ["count", "prefix", "scatter", "ShadeWork"]) {
  assert.equal(surfacePassNames.some((name) => name.includes(forbidden)), false);
}
assert.equal(resourceSnapshot.resources.some((r) => r.label.includes("ShadeWork")), false);
```

- [ ] **Step 2: 确认旧路径仍使测试失败**

Run: `node --test tests/visible-pixel-classification.test.mjs tests/source-geometry.test.mjs tests/resource-accounting.test.mjs`

Expected: FAIL，列出仍存在的 pass/resource/source。

- [ ] **Step 3: 删除 classifier、scan、scatter、ShadeWork 与迁移 flag**

同步删除 imports、pipeline cache、buffer allocation、counter copy、readback 和 profiler label。不得留下无消费者资源或 dead compatibility shim。

- [ ] **Step 4: 验证 feature-off 与普通帧零成本**

Run: `node --test tests/visible-pixel-classification.test.mjs tests/source-geometry.test.mjs tests/resource-accounting.test.mjs tests/framegraph-profiler-evidence.test.mjs`

Expected: PASS；FrameGraph、resource snapshot 和 readback coverage 均无旧路径实体。

- [ ] **Step 5: 提交 M4**

```bash
git add -A OEngine/src/render OEngine/src/shaders OEngine/src/debug OEngine/tests
git commit -m "refactor: remove visible pixel queue backend"
```

---

### Task 6 / M5: Adaptive TriangleSetup Candidate Cache

**Files:**

- Create: `OEngine/src/gpu/GpuExactRasterAbi.ts`
- Modify: `OEngine/src/render/ExactTriangleFilter.ts`
- Modify: `OEngine/src/shaders/exact_triangle_filter.ts`
- Modify: `OEngine/src/shaders/packed_material_resolve.ts`
- Modify: `OEngine/src/debug/GpuFrameCounters.ts`
- Modify: `OEngine/src/debug/profiling/ResourceAccounting.ts`
- Test: `OEngine/tests/gpu-exact-raster-abi.test.mjs`
- Test: `OEngine/tests/triangle-filter-reference.test.mjs`
- Test: `OEngine/tests/packed-material-resolve.test.mjs`
- Test: `OEngine/tests/resource-accounting.test.mjs`

**Interfaces:**

- Produces: 32 B `ExactRasterRecord`，包含原 RasterWork 字段和 `setupHandle/setupFlags`。
- Produces: 固定 8 MiB `TriangleSetupCandidateQueue`，默认 coverage threshold 为 32 pixels。
- Produces: `setupAttempted`、`setupWritten`、`setupVisiblePixelHits`、`setupVisiblePixelFallbacks`、`setupOverflow`，只在 profiler cadence 开启需要的 reduction/readback。

- [ ] **Step 1: 写 ABI、数学 oracle、near-plane 与 overflow 失败测试**

```js
test("queue overflow cannot change the reconstructed surface", () => {
  const fallback = reconstructPixel({ setupCapacity: 0, triangle, pixel });
  const cached = reconstructPixel({ setupCapacity: 1, triangle, pixel });
  assertSurfaceClose(cached, fallback, {
    scalar: 1 / 255,
    normalDegrees: 0.5,
    velocityPixels: 0.05
  });
});
```

随机三角形 oracle 必须覆盖 perspective barycentric derivatives、mirrored、double-sided、degenerate、near crossing 和 camera motion。

- [ ] **Step 2: 运行测试确认 24 B record/无 setup 路径失败**

Run: `node --test tests/gpu-exact-raster-abi.test.mjs tests/triangle-filter-reference.test.mjs tests/packed-material-resolve.test.mjs`

Expected: FAIL，指出 ABI stride 或 setup consumer 缺失。

- [ ] **Step 3: 实现 bounded candidate producer 与 Surface fast path**

Reservation 必须有确定容量；queue full、near crossing、degenerate 或 invalid handle 全部走现有逐像素公式。velocity 关闭只允许删除 previous-frame/motion 计算，不得声称消除当前 position 读取，因为 face/geometric normal 仍需要 position。

- [ ] **Step 4: 接入生命周期与 sampled diagnostics**

8 MiB cache 记为 persistent work-cache；ExactRaster 从 24 B 增至 32 B 的双 class delta 记为 `16 × classCapacity`；销毁、device loss、scene release 后归零。普通稳定帧不得新增 fragment atomic 或 counter readback。

- [ ] **Step 5: 运行正确性与 heavy-overdraw Gate**

Run: `node --test tests/gpu-exact-raster-abi.test.mjs tests/triangle-filter-reference.test.mjs tests/packed-material-resolve.test.mjs tests/resource-accounting.test.mjs tests/r4-visibility-lifecycle.test.mjs`

Run: Rendering Lab `near-plane-motion` 与 `heavy-overdraw-large-occluder` 各三个正式 run。

Expected: metadata/emissive bit-identical；albedo/PBR P99 ≤1/255；normal P99 ≤0.5°；velocity P99 ≤0.05 internal pixel；无 NaN/Inf；三个 run 的 visible-pixel setup hit ratio 均 ≥90%。否则默认关闭 candidate cache，并评估 coverage bucket/sidecar/visibility-after producer。

- [ ] **Step 6: 提交 M5**

```bash
git add OEngine/src/gpu/GpuExactRasterAbi.ts OEngine/src/render OEngine/src/shaders OEngine/src/debug OEngine/tests examples/rendering-lab
git commit -m "perf: cache bounded exact triangle setup"
```

---

### Task 7 / M6: Surface ABI v2 Isolated A/B

**Files:**

- Modify: `OEngine/src/gpu/GpuSurfaceAbi.ts`
- Modify: `OEngine/src/render/passes/PackedMaterialResolvePass.ts`
- Modify: `OEngine/src/shaders/packed_material_resolve.ts`
- Modify: Surface consumers found by `rg -l "SurfaceFrame|surface\." OEngine/src/render OEngine/src/shaders`
- Modify: `OEngine/src/debug/profiling/ResourceAccounting.ts`
- Test: `OEngine/tests/r5-surface-contract.test.mjs`
- Test: `OEngine/tests/packed-material-resolve.test.mjs`
- Test: `OEngine/tests/resource-accounting.test.mjs`

**Interfaces:**

- Consumes: M5 已稳定的 class Surface producer；不得同时改变 TriangleSetup 算法。
- Produces: versioned `GPU_SURFACE_ABI_VERSION = 2` 与唯一 encode/decode helpers；所有 consumers 同一提交迁移。

- [ ] **Step 1: 写 attachment layout 与 consumer compatibility 失败测试**

```js
assert.equal(GPU_SURFACE_ABI_VERSION, 2);
assert.deepEqual(surfaceAttachmentFormats(), expectedV2Formats);
assert.equal(allSurfaceConsumersDeclareVersion(2), true);
```

- [ ] **Step 2: 运行命中测试确认仍为 v1**

Run: `node --test tests/r5-surface-contract.test.mjs tests/packed-material-resolve.test.mjs tests/resource-accounting.test.mjs`

Expected: FAIL，且只涉及 ABI/layout，不涉及 M5 算法。

- [ ] **Step 3: 实现最小 v2 layout 并迁移所有消费者**

格式选择必须由同机 A/B 证明；若没有节省 attachment bytes 或增加转换 pass，则保持 v1 并把 M6 记录为 `rejected-by-evidence`。

- [ ] **Step 4: 跑数值、内存和正式性能 A/B**

Run: 命中 tests、`npm run build`、三个 Rendering Lab formal runs。

Expected: 与 M5 相同正确性阈值；新路径 resident/transient 峰值不高于旧路径；必须同时报告全局 512/256/128/128 MiB 和 upload/readback budget 状态，已有超预算不能写成通过。

- [ ] **Step 5: 提交接受或拒绝证据**

```bash
git add OEngine/src/gpu/GpuSurfaceAbi.ts OEngine/src/render OEngine/src/shaders OEngine/src/debug OEngine/tests examples/rendering-lab docs
git commit -m "perf: validate surface abi v2"
```

---

### Task 8 / M7: Evidence-Conditional Tile Backend and Final Gate

**Files:**

- Modify only if gate triggers: `OEngine/src/render/MaterialResolveBackend.ts`
- Create only if gate triggers: `OEngine/src/render/passes/PackedMaterialTilePass.ts`
- Create only if gate triggers: `OEngine/src/shaders/packed_material_tile.ts`
- Modify: `examples/rendering-lab/benchmark-report.ts`
- Modify: `docs/OEngine_Visibility_to_Surface_WebGPU_RFC.md`
- Modify: `docs/STATUS.md`
- Test: `OEngine/tests/packed-material-tile.test.mjs` only if gate triggers
- Test: `OEngine/tests/benchmark-evidence-gate.test.mjs`

**Interfaces:**

- Entry Gate: 至少两个 GPU vendor 上，M3 `MaterialClassDepth + Resolve` 的 P50 或 P95 比已验证 tile prototype/模型高 10% 以上。
- Produces: Gate 未触发时明确状态 `not-needed-by-evidence`；Gate 触发时才产生固定容量 tile queue ABI 与 backend。

- [ ] **Step 1: 写 M7 判定失败测试**

```js
assert.equal(evaluateTileBackendNeed(oneVendorEvidence).status, "insufficient-evidence");
assert.equal(evaluateTileBackendNeed(twoVendorUnderThreshold).status, "not-needed-by-evidence");
assert.equal(evaluateTileBackendNeed(twoVendorOverTenPercent).status, "required");
```

- [ ] **Step 2: 运行测试并实现纯证据判定器**

Run: `node --test tests/benchmark-evidence-gate.test.mjs`

Expected: PASS；没有足够证据时不得创建 runtime tile 文件。

- [ ] **Step 3A: Gate 未触发时关闭 M7**

在 RFC/STATUS 记录两个 vendor 的 run ids、P50/P95、差值和 `not-needed-by-evidence`；运行 `rg "PackedMaterialTile" OEngine/src` 应无生产实现。

- [ ] **Step 3B: 仅 Gate 触发时，先写 bounded tile queue 测试再实现**

队列合同必须包含 tile record ABI、容量、overflow、producer、consumer、计数器和 fail-visible class-discard fallback；实现前新增失败的 `packed-material-tile.test.mjs`，通过后再接入 backend。

- [ ] **Step 4: 运行最终验证矩阵**

Run: `npm test`

Run: `npm run audit:shaders`

Run: Chrome Rendering Lab 全部 formal profiles，每个 backend/关键 workload 三个独立 session，并保存截图、控制台、GPU timestamps、counter coverage、resource snapshot 和报告。

Expected: 所有适用的 M1-M7 Gate 通过；feature-off 无残余；GPU producer→consumer 闭环完整；没有用 source-shape test 代替浏览器证据。

- [ ] **Step 5: 更新最终状态并提交**

```bash
git add OEngine examples docs
git commit -m "docs: record visibility surface migration evidence"
```

---

## Phase Completion Record

每完成一个阶段，在本节追加：commit、命中测试、未运行验证及原因、adapter/browser、正式 run ids、P50/P95/P99、正确性误差、overflow、资源峰值、Gate 结论。没有这些字段的阶段只能标记 `implemented-awaiting-evidence`，不能标记完成。

| Phase | Implementation | Correctness | Browser/GPU evidence | Gate |
| --- | --- | --- | --- | --- |
| M0 | complete (`5615ba0`, `67ffc3d`) | 33/33 targeted tests | Chrome smoke, 30+60 only | closed as measurement harness; release performance gate not claimed |
| M1 | complete (`1dbadc5`) | targeted lifecycle/product tests pass | exercised by M2 Chrome smoke | closed; formal FrameProducts are the production path |
| M2 | complete in working tree | 45/45 targeted; 427/427 non-doc tests; GPU oracle 6213/6213 | Chrome 152 / NVIDIA Turing / 1920×1080 smoke | RFC correctness/capacity gate closed; Step 5 screenshot parity open |
| M3 | implemented-awaiting-evidence (working tree) | targeted shader/FrameProduct tests pass | browser formal A/B not run | pending correctness/performance gate |
| M4 | blocked by M3 Gate | pending | pending | pending |
| M5 | pending | pending | pending | pending |
| M6 | pending | pending | pending | pending |
| M7 | evidence-conditional | pending | pending | pending |

### 2026-09-07 M0 pre-implementation audit

- Unit evidence baseline: `performance-capture.test.mjs`、`benchmark-evidence-gate.test.mjs`、`pipeline-profile-evidence.test.mjs` 共 15 项通过。
- Browser smoke: Chrome 152 headless、NVIDIA Turing、1920×1080、DPR 1、`timestamp-query` available；30 warm-up + 60 measured；console/page error 为 0。
- Existing coverage: FrameGraph 已分别产出 `Exact triangle filter`、`Packed VisibilityKey/depth`、MaterialKernel count/prefix/scatter、`Material Resolve/specialized Surface`、direct lighting 与 opaque lighting timestamp labels。
- Exploratory result: Inspector hidden 时，base/full 的 `material-resolve` P50 分别为 7.524256/6.369408 ms，P95 分别为 8.4280384/35.562928 ms。该 smoke 是串行单次运行且工作区为 dirty，只用于暴露当前成本和离散度，不能作为 release Gate 或优化百分比基线。
- Confirmed M0 gaps: 没有 migration-specific independent run id/group；没有 `cube-near-effects-off`、`projection-normalized`、`microtriangle-stress`、`heavy-overdraw-large-occluder`、`material-mosaic-7`、`near-plane-motion` workload；report 还不能直接给出 classify/classDepth/resolve/lighting 四段的统一 `SurfacePhaseTiming`。
- Artifact: `temp/rendering-lab-profiles-1920x1080.json`（本地临时证据，不进入提交）。Evidence gate 正确拒绝该结果，原因是 `engine-dirty` 与 `dirty-reasons-present`。

### 2026-09-07 M0 closure

- Implementation commits: `5615ba0`、`67ffc3d`。
- Targeted verification: `npm run build:test` 后运行 benchmark/evidence/profiler 命中测试，33/33 通过。
- Browser workload smoke: 本地 Vite + Chrome WebGPU，`benchmark-workload-smoke.mjs` 退出码 0。
- Browser profile smoke: 同一浏览器 session 完成 visible、hidden 与 counter-coverage；页面错误为 0，counter sampled/completed 分别为 6/6、5/5、60/60，dropped 为 0。
- Smoke run ids: visible `868d25af-7a14-41cf-8819-a17c8a639400`；hidden `b2702e02-0b3b-4b9e-95e7-c0241da32c2d`；counter coverage `2aca5b69-83e9-49a5-ad45-b27a59ba3098`。
- Gate conclusion: M0 measurement harness 关闭并允许进入 M1。该证据仍是 30 warm-up + 60 measured 的开发 smoke，不是 120+480、三独立 session 的 release 性能 Gate。

### 2026-09-07 M1 closure

- Implementation commit: `1dbadc5` (`refactor: formalize visibility frame products`)。
- Current verification: M1 FrameProduct、resource identity、rebind、retirement 与 Surface consumer 命中测试包含在 M2 的 427/427 non-doc suite 中并通过。
- Gate conclusion: `ExactRasterFrame` / `VisibilityFrame` 已进入生产链路，camera、counter cadence 和 content patch 不替换 persistent WorkSet；允许进入 M2。

### 2026-09-07 M2 closure

- Implementation: working tree，尚未提交；VisibilityKey ABI v3 为 29-bit exact slot + 3-bit kernel class，`EMPTY=0xffffffff`，`INVALID=0xfffffffe`。
- CPU/WGSL contract: 集中式 guarded encode/decode；slot/class 越界返回 invalid，禁止 encode 时 mask 截断；`GPU_INSTANCE_ABI_VERSION` 提升为 3，OPAQUE/MASK producer 都从 instance flags 读取 kernel class，OPAQUE 未新增 Material Buffer binding。
- Ownership: `materialKernelClass(material)` 同时驱动 material record 与 Packed Scene stage/material patch；instance material-classification mask 覆盖完整 3-bit kernel class。Registry 持有 7 类非 BLEND instance count，late-bound `activeKernelMask` 可供 M3 消费，patch abort 会连同 material index shadow、透明计数和 class count 一起恢复。
- Verification: `npm run build` 与 examples `npm run build` 通过；M2 targeted tests 45/45 通过；排除任务开始前已删除 Inspector 文档对应的 `documentation-system.test.mjs` 后，完整 suite 427/427 通过。原始 `npm test` 的 3 个剩余失败均由这 4 个预存在的文档删除导致。
- CPU/WGSL oracle: Chrome 152 headless、NVIDIA Turing；4159 个 encode vectors + 2054 个 decode vectors，共 6213/6213 readback 一致，mismatch 0；覆盖 seeded random u32、全部合法 class、slot 边界、越界与 `EMPTY`/`INVALID`。
- Browser smoke: Chrome 152 headless、NVIDIA Turing、1920×1080、DPR 1、30 warm-up + 60 measured；console/page errors 0；counter coverage 60/60、dropped 0；`invalidVisibilityKeys=0`、`queueOverflowMask=0`、`shadowQueueOverflowMask=0`、`transparentQueueOverflowMask=0`。Run ids: visible `f1ca2eac-17c2-482e-93e3-ec679208d0e5`，hidden `84f2fbe2-7290-4ad6-bfc9-1b42d527d434`，counter coverage `71d35ed1-a9b1-4c6e-9692-e0ec406e95fd`。
- Not run: v2/v3 screenshot numerical diff，因为仓库没有保留可比较的 v2 screenshot artifact；本 smoke 证明 shader compilation、生产链路与 key/overflow counters，不替代正式 release A/B。
- Gate conclusion: RFC 定义的 M2 key correctness/capacity Gate 已关闭，允许进入 M3；执行计划 Step 5 的 v2/v3 screenshot parity 仍因缺少 v2 artifact 保持打开，不能把当前 runtime smoke 表述成 image parity。M3 性能 Gate 尚未开始。

### 2026-09-07 M3 implementation checkpoint

- Implementation: working tree。新增内部 `MaterialResolveBackend`（legacy pixel queue / class-depth / class-discard）、独立 `PackedMaterialClassDepthPass` 和 `depth32float` `MaterialClassificationFrame`；RendererConfig 可选择迁移期 backend，默认仍为 legacy，避免在 Gate 前改变发布基线。
- ClassDepth producer：独立 render pass 清空并写入 visibility-derived class depth（7 个严格区分的值）；Surface resolve 在 class-depth/class-discard 下改用 fullscreen triangle，class-depth 使用 `depthCompare=equal`，class-discard 使用 `depthCompare=always` + key class discard。`activeKernelMask` 在 execute callback late-bound，仅用于减少实际 draw 数。
- Verification: `npm run build`、`npm run build:test`；M3 专项 `packed-material-class-depth.test.mjs` 3/3，通过现有 Material/FrameGraph/P3 targeted tests。Shader source audit 已更新为 70 个 authored/live 条目。
- Not run: Rendering Lab 三次独立 legacy/class-depth/class-discard 正式 A/B、截图 bit parity、真实 adapter depth-equal 性能与 feature-off 浏览器证据；当前环境没有可复用的 M3 release profile，不能宣称 RFC 的 15%/10% 性能 Gate 或 M3 完成。
- Gate conclusion: M3 代码路径已接通，状态为 `implemented-awaiting-evidence`；M4 继续 blocked，Pixel Queue 与 `VisiblePixelClassifier` 暂不删除。
