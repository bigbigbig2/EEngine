# OEngine Visibility-to-Surface Implementation Plan

> **For contributors:** This document is a staged implementation guide. The validation notes are recommendations for choosing useful evidence, not a requirement to run a large test matrix after every edit.

**Goal:** 在不破坏 OEngine GPU-first 主链路的前提下，把 `VisibilityKey → Surface` 从像素队列重排迁移为有界 MaterialClassDepth / class-discard backend，并以可选的 TriangleSetup candidate cache 降低大三角形逐像素属性重建成本。

**Architecture:** `VisibilityFeature` 只生产正式的 `ExactRasterFrame` 与 `VisibilityFrame`；`SurfaceFeature` 通过 `MaterialResolveBackend` 消费这些 FrameProduct。迁移按 M0-M7 分阶段推进；每个阶段优先做与改动风险匹配的验证，再决定是否删除旧路径或进入下一阶段。

**Tech Stack:** TypeScript 5.8、WebGPU、WGSL、FrameGraph、Node test runner、Vite、Rendering Lab、Chrome WebGPU timestamps/counters。

**Spec:** [OEngine_Visibility_to_Surface_WebGPU_RFC.md](./OEngine_Visibility_to_Surface_WebGPU_RFC.md)

> **收尾说明（2026-09-09）：** 本文保留阶段实施记录和历史验证命令。未勾选的 red-green 步骤不再作为普通开发阻塞条件；当前实现状态以 RFC 收尾结论和 `docs/STATUS.md` 为准。缺少 GPU/browser artifact 时仍必须标记为未验证。

## Global Constraints

- WebGPU baseline 不依赖 64-bit atomic、multi-draw-indirect、mesh/task shader、buffer device address、bindless 或 subgroup。
- 新 GPU 队列必须声明 ABI、容量、overflow、producer、consumer、计数器和 fail-visible 行为。
- GPU producer 必须直接连接 GPU consumer；CPU 不得回读并遍历可见列表来驱动最终绘制。
- `Renderer` 只编排正式 FrameProduct；不得继续把 `PackedVisibilityDebugSource` 当生产合同。
- feature-off 时不得保留 Pass、资源分配、history、counter copy、readback 或独立 submit。
- 如需性能比较，优先固定分辨率、DPR、seed 和 GPU workload，并记录采样方式；采样帧数、session 数量和 cadence 可按问题范围调整。
- 代码修改应运行命中的类型检查、构建或测试；完整 suite 和浏览器场景属于里程碑或高风险改动的建议验证，不要求每次小改动都执行。
- 未验证的能力继续标记为未验证；保留 fallback 和真实状态说明，但不把验证清单当作开发流程阻断器。

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

- [x] **Step 2: 运行针对性检查并记录缺少 run/phase 数据时的提示**

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

Run（需要比较时）：Rendering Lab profile，legacy 与 class-depth/class-discard 选择合适数量的对照 run。

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

- [x] **Step 1: 写 source-shape/FrameGraph 失败测试**

```js
for (const forbidden of ["count", "prefix", "scatter", "ShadeWork"]) {
  assert.equal(surfacePassNames.some((name) => name.includes(forbidden)), false);
}
assert.equal(resourceSnapshot.resources.some((r) => r.label.includes("ShadeWork")), false);
```

- [x] **Step 2: 确认旧路径仍使测试失败**

Run: `node --test tests/visible-pixel-classification.test.mjs tests/source-geometry.test.mjs tests/resource-accounting.test.mjs`

Expected: FAIL，列出仍存在的 pass/resource/source。

- [x] **Step 3: 删除 classifier、scan、scatter、ShadeWork 与迁移 flag**

同步删除 imports、pipeline cache、buffer allocation、counter copy、readback 和 profiler label。不得留下无消费者资源或 dead compatibility shim。

- [x] **Step 4: 验证 feature-off 与普通帧零成本**

Run: `node --test tests/visible-pixel-classification.test.mjs tests/source-geometry.test.mjs tests/resource-accounting.test.mjs tests/framegraph-profiler-evidence.test.mjs`

Expected: PASS；FrameGraph、resource snapshot 和 readback coverage 均无旧路径实体。

- [x] **Step 5: 提交 M4**

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

- [x] **Step 1: 写 ABI、数学 oracle、near-plane 与 overflow 失败测试**

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

- [x] **Step 2: 运行测试确认 32 B exact record / 40 B setup ABI**

Run: `node --test tests/gpu-exact-raster-abi.test.mjs tests/triangle-filter-reference.test.mjs tests/packed-material-resolve.test.mjs`

Expected: FAIL，指出 ABI stride 或 setup consumer 缺失。

- [x] **Step 3: 实现 bounded candidate producer 与 Surface fast path**

Reservation 必须有确定容量；queue full、near crossing、degenerate 或 invalid handle 全部走现有逐像素公式。velocity 关闭只允许删除 previous-frame/motion 计算，不得声称消除当前 position 读取，因为 face/geometric normal 仍需要 position。

- [x] **Step 4: 接入生命周期与 sampled diagnostics**

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

### Task 7 / M6: Unified Surface ABI

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
- Produces: 当前唯一的 `GPU_SURFACE_ABI_VERSION` encode/decode helpers；所有 consumers 共享同一 Surface 合同。

- [x] **Step 1: 写 attachment layout 与 consumer compatibility 失败测试**

```js
assert.equal(GPU_SURFACE_ABI_VERSION, 1);
assert.deepEqual(surfaceAttachmentFormats(), expectedFormats);
assert.equal(allSurfaceConsumersDeclareVersion(GPU_SURFACE_ABI_VERSION), true);
```

- [x] **Step 2: 运行命中测试确认仍为 v1**

Run: `node --test tests/r5-surface-contract.test.mjs tests/packed-material-resolve.test.mjs tests/resource-accounting.test.mjs`

Expected: FAIL，且只涉及 ABI/layout，不涉及 M5 算法。

- [x] **Step 3: 收敛为单一 Surface ABI producer/consumer 合同**

Packed Resolve、legacy producer 和主要 lighting consumers 共享同一 ABI；不存在运行时 v1/v2 双路径。格式研究只保留在 schema/oracle 层，不能改变生产 RenderTargets。

- [ ] **Step 4: 跑统一 ABI 的正确性、内存和性能证据**

Run: 命中 tests、`npm run build`、三个 Rendering Lab formal runs。

Expected（方向性）：关注 Surface 正确性、resident/transient 峰值，以及全局 512/256/128/128 MiB 和 upload/readback budget 状态；缺少数据时明确标记未验证。

- [ ] **Step 5: 提交接受或拒绝证据**

```bash
git add OEngine/src/gpu/GpuSurfaceAbi.ts OEngine/src/render OEngine/src/shaders OEngine/src/debug OEngine/tests examples/rendering-lab docs
 git commit -m "docs: record unified surface abi evidence"
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

- [x] **Step 1: 写 M7 判定失败测试**

```js
assert.equal(evaluateTileBackendNeed(oneVendorEvidence).status, "insufficient-evidence");
assert.equal(evaluateTileBackendNeed(twoVendorUnderThreshold).status, "not-needed-by-evidence");
assert.equal(evaluateTileBackendNeed(twoVendorOverTenPercent).status, "required");
```

- [x] **Step 2: 运行测试并实现纯证据判定器**

Run: `node --test tests/benchmark-evidence-gate.test.mjs`

Expected: PASS；没有足够证据时不得创建 runtime tile 文件。

- [ ] **Step 3A: Gate 未触发时关闭 M7**

在 RFC/STATUS 记录两个 vendor 的 run ids、P50/P95、差值和 `not-needed-by-evidence`；运行 `rg "PackedMaterialTile" OEngine/src` 应无生产实现。

- [ ] **Step 3B: 仅 Gate 触发时，先写 bounded tile queue 测试再实现**

队列合同必须包含 tile record ABI、容量、overflow、producer、consumer、计数器和 fail-visible class-discard fallback；实现前新增失败的 `packed-material-tile.test.mjs`，通过后再接入 backend。

- [ ] **Step 4: 运行最终验证矩阵**

按下方“**M7 结束后的统一未完成验证**”逐项执行。这里不再用一次 `npm test` 概括浏览器、正确性、性能和内存 Gate。

Expected: 下方所有适用项均勾选完成；M3/M5/M6/M7 都有 identity-bearing artifact；feature-off 无残余；GPU producer→consumer 闭环完整；没有用 source-shape test、历史 dirty report 或 CPU timing 代替浏览器 GPU 证据。

- [ ] **Step 5: 更新最终状态并提交**

```bash
git add OEngine examples docs
git commit -m "docs: record visibility surface migration evidence"
```

---

## M7 之后的可选验证建议

本节是按风险选择的验证建议，不是必须一次性完成的测试清单，也不要求每次改动都运行完整浏览器矩阵。已有 `temp/visibility-to-surface/` 报告的适用范围仍按记录解释；未执行某项验证时记录原因即可，不把缺失证据写成通过。

### 0. 需要正式证据时的建议前置条件

- 需要可复现比较时，建议记录 clean commit、浏览器/adapter、分辨率、DPR、seed、采样方式以及 run 身份。
- 推荐固定 workload 参数，但 warm-up、measured frames、session 数量和 cadence 可按问题范围调整。
- 报告应区分 browser/provenance/GPU diagnostics；GPU timestamp 不可用时不要用 CPU 时间冒充 GPU 性能。
- 需要 legacy 对照时，优先使用删除 Pixel Queue 前的基线版本和同一 harness；不必为普通开发改动恢复旧生产代码。

### 1. 高风险或发布前的构建、测试与 Shader 审计（可选）

- 如改动影响公共 ABI、FrameGraph 或 shader，可在 `OEngine/` 执行：

```powershell
npm ci
npm test
npm run audit:shaders
```

Expected: build、test build、全部 `tests/*.test.mjs` 与 Shader provenance/source audit 全部通过；不排除 documentation、browser 或 migration tests。

- 如改动影响浏览器渲染，可在 `examples/` 执行：

```powershell
yarn install --frozen-lockfile
yarn build
yarn test:visibility-key-oracle
yarn test:rendering-lab:workload
```

Expected: examples typecheck/Vite build 通过；VisibilityKey GPU oracle 全部向量一致；Rendering Lab workload smoke 无 page error、console error、validation error 或 device loss。

### 2. M2 遗留：VisibilityKey v2/v3 parity

- 需要对照时，可使用相同 Packed scene、相机、分辨率和 seed，比较 VisibilityKey、depth 和 Surface attachment readback。
- 建议覆盖 v3 的 7 个 kernel class、EMPTY/INVALID sentinel、slot 容量边界和越界 encode，并记录 invalid/overflow 计数。
- v2/v3 image/attachment parity 属于补充证据；当前 runtime smoke 或 CPU oracle 只能说明局部行为。

### 3. M3/M4 遗留：ClassDepth、fallback 与 Pixel Queue 删除 Gate

- 如需历史对照，可在 clean `68750c2` benchmark 版本上比较 `legacy-pixel-queue`、`class-depth`、`class-discard`；workload 和 session 数量按问题范围选择：

```text
cube-near-effects-off
microtriangle-stress
material-mosaic-7
near-plane-motion
```

- 可按 attachment 比较 kernel class、MASK、motion 与 near-plane，并记录 bit/数值差异。
- 15%/10% 和 5% 是优化参考；性能差异应结合 workload、GPU phase 和样本量解释。
- 建议确认 adapter/image-parity 失败时能选择 `class-discard` 并记录 fallback diagnostics。
- 建议检查最终 FrameGraph 没有 count/prefix/add/scatter、`ShadeWork`、Pixel Queue Buffer 或无消费者 submit。

### 4. M5 遗留：TriangleSetup 正确性、命中率与默认值 Gate

- 如需评估 TriangleSetup，可对 `off` 与 `threshold=32` 选择以下 workload 做对照：

```text
cube-near-effects-off
microtriangle-stress
heavy-overdraw-large-occluder
near-plane-motion
```

- 观察 near-plane、mirrored、double-sided、degenerate、MASK、velocity on/off 以及 metadata/emissive、PBR、normal、velocity 的数值稳定性；阈值是参考，不是强制门槛。
- 记录 `setupAttempted`、`setupWritten`、`setupVisiblePixelHits`、`setupVisiblePixelFallbacks`、`setupOverflow`、`workCacheBytes` 和 `workCachePeakBytes`（如这些 counters 已启用）。
- 根据 hit ratio、fallback、内存和 GPU timestamp 判断 candidate cache 是否值得默认开启；证据不足时保持关闭即可。
- TriangleSetup 关闭时可抽查没有 setup cache allocation、evidence pass、counter copy 或 readback。

### 5. M6 遗留：统一 Surface ABI 证据

- 运行统一 Surface ABI 的 workload，记录 attachment bytes per pixel、resident/transient peak、预算状态、GPU diagnostics 和 active ABI version。
- 检查 Packed/legacy producer 与主要 lighting consumer 是否都通过同一个 FrameProduct 合同；未覆盖的 consumer 明确记录。
- 数据不足时记录 `insufficient-evidence`，但不为补齐证据创建第二套 ABI、profile 或运行时切换路径。

### 6. M7 最终分支

- 跨 vendor 比较属于后续优化证据；有条件时记录 ClassDepth+Resolve 与 tile prototype/model 的 GPU timing 和 sample coverage。
- 如果没有稳定收益，记录 `not-needed-by-evidence` 并保持没有 tile runtime；不为补齐证据创建无消费者资源。
- 只有数据明确支持 tile backend 时，才追加 tile ABI、capacity、overflow、producer→consumer 和 fallback 验证。

### 7. 生命周期、Feature-off 与最终报告

- 在高风险改动或发布前，抽查 Packed Scene release、resource epoch replacement、Renderer destroy、device loss、resize、TriangleSetup off/on 和 feature-off 状态。
- feature-off 观察重点是没有无消费者 Pass、资源、history、readback、counter copy 或独立 submit。
- 汇总已有 artifact 并更新 Phase Completion Record、`docs/STATUS.md` 与 `docs/porting/visibility.md`；区分已实现、已验证和未验证，不要求补齐整套矩阵后才能继续开发。

---

## Phase Completion Record

每完成一个阶段，在本节追加：commit、命中验证、未运行验证及原因、adapter/browser（如涉及）、关键观测值和当前状态。缺少某项证据时标记为“未验证”或“待观察”，不要把它写成已通过，也不要求为补齐字段而重复运行整套矩阵。

| Phase | Implementation | Correctness | Browser/GPU evidence | Gate |
| --- | --- | --- | --- | --- |
| M0 | complete (`5615ba0`, `67ffc3d`) | 33/33 targeted tests | Chrome smoke, 30+60 only | closed as measurement harness; release performance gate not claimed |
| M1 | complete (`1dbadc5`) | targeted lifecycle/product tests pass | exercised by M2 Chrome smoke | closed; formal FrameProducts are the production path |
| M2 | complete (`68750c2`) | 45/45 targeted; 427/427 non-doc tests; GPU oracle 6213/6213 | Chrome 152 / NVIDIA Turing / 1920×1080 smoke | RFC correctness/capacity gate closed; Step 5 screenshot parity open |
| M3 | implemented-awaiting-evidence (`68750c2`) | targeted shader/FrameProduct tests pass | browser formal A/B not run | pending correctness/performance gate |
| M4 | implementation complete (this change) | 31/31 targeted tests | Rendering Lab WebGPU workload smoke | architecture gate closed; release acceptance still awaits M3 formal evidence |
| M5 | implementation complete; default promotion pending | ABI/producer/consumer path and fallback implemented; clean formal opt-in run reached 3/3 hit-ratio eligibility | `heavy-overdraw-large-occluder` clean three-session artifact has hit ratio 1.0, zero fallback/overflow and zero diagnostics | pending off/on correctness, near-plane, image/perf and memory Gate |
| M6 | unified Surface ABI contract implemented; evidence pending | producer/consumer seam checks | unified-path diagnostics and memory evidence pending | no runtime ABI split |
| M7 | evidence-gate implemented; no tile runtime | gate evaluator targeted test passes | no two-vendor tile comparison yet | insufficient-evidence |

### 2026-09-08 runtime/evidence readiness closure

- `Renderer.initialize()` 现在对 7 个二进制精确 class depth 值执行一次真实 GPU `depth32float + depthCompare="equal"` readback probe。probe 的 backend、来源和原因写入 `visibilitySurfaceMigrationEvidence()`；validation error、readback mismatch 或异常会在创建 Surface owner 前选择 `class-discard` 并输出 diagnostics。该 probe 只关闭 adapter 首次验证闭环，不替代完整场景 image parity。
- `class-discard` 的 Rendering Lab 选择 seam 保持内部，不加入公开 `RendererConfig`。smoke/formal runner 通过 `OENGINE_MATERIAL_RESOLVE_BACKEND=class-depth|class-discard` 生成页面参数；默认 `auto` 使用上述 adapter probe。
- TriangleSetup 默认关闭时 `setupRecords=null`，不再创建 4 B placeholder、不再导入 FrameGraph setup resource，也不再发出 setup `clearBuffer`；binding 10 复用已有、扩容到一个 setup record 大小的 `drawIndirect` dummy，避免与 counter 或 indirect usage alias，但 `setup_capacity=0` 保证 shader 不访问。正式 runner 不再硬编码开启，改由 `OENGINE_TRIANGLE_SETUP_ENABLED=true|false` 与 `OENGINE_TRIANGLE_SETUP_THRESHOLD_PIXELS` 显式控制。
- `classDepthPixels` 复用 cadence-controlled `VisibilityCounterPass` 的 valid VisibilityKey reduction；没有新增 fullscreen pass、readback 或 submit。该 counter 只在 VisibilityKey 合同分支生产。
- 历史验证记录：`OEngine/npm test` 439/439；Shader audit 70/70（66 authored-live、4 unknown）；`examples/npm run build`；VisibilityKey GPU oracle 6213/6213；NVIDIA/Turing Chrome WebGPU 上 workload smoke 的 `auto`、显式 `class-depth`、显式 `class-discard` 路径通过。该记录中的“正式 profile 未运行”仅适用于当时 dirty 工作树；2026-09-08 已在 clean commit 上补充 M5 off/on 正式 profile，见本页的 M5 clean formal evidence checkpoint。
- 尚未关闭：M2 v2/v3 attachment parity；M3 历史 legacy 三组 A/B 与场景 image parity；M5 off/on 三组正确性、命中率、性能和内存 Gate；M6 统一 ABI 的完整 composition/内存证据；M7 两 vendor evidence；device-loss/resize/toggle 生命周期矩阵。

正式 runner 示例（当前脚本可生成多个独立 browser session；数量按需要调整）：

```powershell
Set-Location examples
$env:OENGINE_MATERIAL_RESOLVE_BACKEND = "class-discard"
$env:OENGINE_TRIANGLE_SETUP_ENABLED = "false"
npm run profile:rendering-lab:formal -- cube-near-effects-off

$env:OENGINE_MATERIAL_RESOLVE_BACKEND = "class-depth"
$env:OENGINE_TRIANGLE_SETUP_ENABLED = "true"
$env:OENGINE_TRIANGLE_SETUP_THRESHOLD_PIXELS = "32"
npm run profile:rendering-lab:formal -- heavy-overdraw-large-occluder

npm run profile:rendering-lab:formal -- comprehensive-full
```

### 2026-09-07 M5 producer/consumer checkpoint

- Implementation: working tree。`GpuExactRasterAbi.ts` 冻结 32 B `ExactRasterRecord`（24 B RasterWork 前缀 + setupIndex/exactFlags）和 RFC Appendix B 的 40 B q-center/dqdx/dqdy `TriangleSetupRecord` sidecar；ExactTriangleFilter 的正式 exact queue 已升级为 32 B，并在显式 benchmark-only opt-in 时分配/清零最多 8 MiB setup cache，作为独立 `work-cache` resource category 记账；默认关闭时不创建 setup buffer、不导入对应 FrameGraph resource、不执行 setup clear，并走逐像素 fallback；按可配置 screen-coverage threshold 写 setup；Visibility、Material Resolve、Debug consumers 同步使用 exact stride，setup 无效/near crossing/容量外自动回退现有逐像素公式。
- Correctness: `gpu-exact-raster-abi.test.mjs` 3/3、Material/Visibility/Hierarchy 命中测试 26/26 通过；`npm run typecheck`、`npm run build:test`、`npm run build` 通过；Rendering Lab workload/profile smoke 无 page/console error。
- Observability: GPU counter ABI 增加 `setupAttempted`、`setupWritten`、`setupVisiblePixelHits`、`setupVisiblePixelFallbacks`、`setupOverflow`（schema v13）；producer 与 sampled-only TriangleSetup evidence compute 均已接线。
- Reporting: Rendering Lab benchmark report 现在按 case 汇总上述 setup counters，并输出 `triangleSetup.cases[*].visibleHitRatio`、counter coverage、overflow/写入统计以及 `workCacheBytes/workCachePeakBytes`；`profile-formal.mjs` 通过 `OENGINE_TRIANGLE_SETUP_ENABLED` 与 `OENGINE_TRIANGLE_SETUP_THRESHOLD_PIXELS` 显式选择 M5 off/on。报告同时输出 `surfaceAbi.cases[*]` 的 attachment bytes、resident bytes、classDepth/resolve P50/P95/P99 及样本数，并保存 `resourceAccounting`（含 `work-cache` category）供 M5/M6/M7 evidence 参考。hit ratio 只作为是否默认开启的参考。
- Inspector: GPU-driven 面板增加 TriangleSetup candidate 写入/overflow 与 visible hit ratio 行；默认关闭时显示 unsupported，不创建额外采样或资源。
- Graph identity: packed FrameGraph cache key includes `setup0/setup1`, so switching benchmark opt-in cannot reuse a graph compiled for the fallback-only mode.
- Migration snapshot: `Renderer.visibilitySurfaceMigrationEvidence()` and benchmark `domainEvidence.migration` record VisibilityKey/ExactRaster/Surface ABI versions, active backend, TriangleSetup opt-in state, and explicit M7 `tileBackend.status: insufficient-evidence`; these fields describe implementation state only and do not close performance Gates.
- Observability: `profile-formal.mjs` 的正式 cadence 使用 64 个 readback slots，避免慢 adapter 把 counter 丢弃误报为 workload 失败；unsupported counter blocker IDs 统一为稳定 `VIS-*` 任务号。
- Not run at this historical checkpoint: near-plane image parity、heavy-overdraw 三次正式 run、setup hit ratio 与正式性能 Gate；后续已补齐 clean heavy-overdraw 三次 run，near-plane 和完整性能 Gate 仍未完成。
- Gate conclusion: producer→consumer 与 fallback 闭环已成立；该历史 checkpoint 的 M5 状态为 `implemented-awaiting-evidence`。后续 clean heavy-overdraw run 已取得 hit-ratio `default-eligible` 子结论，但 RFC 的完整默认启用 Gate 仍未关闭。

### 2026-09-08 M6/M7 evidence gates checkpoint

- 新增内部 `VisibilitySurfaceMigrationGates.ts`：M5 只有带唯一 `runGroupId/runId` 的三次独立 run，且 visible setup hit ratio 均达到 90% 才允许 candidate cache 成为默认；否则 `disabled-by-evidence`。M6 只判断统一 Surface ABI 的 producer/consumer、资源峰值和诊断字段是否完整；证据缺失时返回 `insufficient-evidence`，不创建第二套 Surface runtime。M7 仍要求 vendor 摘要和 identity-bearing vendor-run 判定，证据不足时不创建 Tile backend。
- Rendering Lab report 保留 `surfaceAbiRuns` / `tileBackendRuns` 作为可选证据输入，统一写入 `domainEvidence.surfaceAbi` 与 `domainEvidence.migrationGates`；缺失 artifact 时明确报告“统一 Surface ABI 证据不足 / 不创建 Tile runtime”，不会把缺失数据伪装成通过。
- `SurfaceFrame` 现在携带显式 `abiVersion`；Packed Resolve 与 legacy MaterialExpand producer 共享同一版本，FrameProduct validator 和 Lighting consumer 都拒绝未知版本，避免格式变化让旧 consumer 静默读取。
- M6 不新增 Surface profile 或第二条 runtime；`GpuSurfaceAbi.ts` 的现有 schema/oracle 只作为统一 ABI 的格式与编码真相，任何压缩研究都不进入 Renderer/RenderTargets。
- Packed Resolve、legacy MaterialExpand、Direct Lighting、AO、SSR、GI/IBL/LPV/Brick4、Opaque Resolve 和 Render Debug 都继续消费同一 Surface ABI；若某个 consumer 未覆盖，记录为未验证而不是引入兼容分支。
- M7 新增 `TileBackendCostModel.ts` 作为 evidence-only model：固定 tile size、7-bit class mask、bounded capacity/overflow（含 tile-record `overflowRate`）和 class-tile dispatch work 计数；没有创建 `PackedMaterialTilePass`、shader、queue 或额外 submit。
- Rendering Lab 仅在调用方显式提供 `domainEvidence.tileBackendModelInput` 时生成 `domainEvidence.tileBackendModel`；默认报告为 `not-sampled`，不会偷偷把 CPU model 当作跨 vendor 性能证据。
- `profile-formal.mjs` 现在把每组三次 run 的 `migrationGates.surfaceAbi` / `migrationGates.tileBackend` 写入 artifact；统一 ABI 证据不足时明确保存 `insufficient-evidence`，不会把普通运行冒充完成证据。
- Rendering Lab fixture 的 `runBenchmark` 已接受可选 `surfaceAbiRuns`、`tileBackendRuns` 与 `tileBackendModelInput`，并原样写入 report domain evidence；默认调用不传这些字段，因此不会产生额外资源或 runtime backend。
- `profile-formal.mjs` 只采集统一 Surface ABI；脚本 artifact 记录 active ABI version、资源峰值和 diagnostics，不提供 profile 切换或 baseline/candidate 配对。
- `surfaceAbi` report 保存统一 ABI 的 attachment、resident/transient 和阶段 timing；缺字段时保持 `insufficient-evidence`。
- M6/M7 artifact 边界现在对缺字段、错误类型、非法 memory peak、非法 vendor metric 和重复身份统一返回 `insufficient-evidence`，不会因脏 JSON 在 gate evaluator 内抛异常；这仍不会把缺失 evidence 转换成通过。
- 本次变更仅运行 `OEngine/npm run typecheck` 与 `examples/npx tsc --noEmit -p tsconfig.json`；没有运行测试矩阵、浏览器 profile 或正式性能 A/B。
- Targeted verification: `visibility-surface-migration-gates.test.mjs` 2/2 通过；未运行全量 suite。
- Current status: M6 继续使用单一 Surface ABI；Packed producer、FrameProduct 和主要 Surface consumers 的统一合同已存在，但完整 composition/内存证据仍未完成。M7 仍保持 evidence-only model，不创建 Tile runtime。

### 2026-09-08 M5 clean formal evidence checkpoint

- 修复了 feature-off TriangleSetup dummy binding 的三个实际 WebGPU 约束问题：writable storage alias、binding 最小数组元素大小，以及 indirect/storage 同一同步范围冲突。修复保持 `setupRecords=null` 时不分配 setup cache，只复用已有 `drawIndirect` 作为不可达 ABI dummy。
- `BenchmarkCapabilityEvidence` 新增 `triangle-setup-candidate-cache` feature contract，声明 `setupAttempted/setupWritten/setupVisiblePixelHits/setupVisiblePixelFallbacks/setupOverflow` 五个真实 GPU counters；启用 M5 不再因未知 feature set 中止采样。
- 正式命令：`OENGINE_TRIANGLE_SETUP_ENABLED=true`、`OENGINE_TRIANGLE_SETUP_THRESHOLD_PIXELS=32`、`npm run profile:rendering-lab:formal -- heavy-overdraw-large-occluder`。
- Artifact：`temp/visibility-to-surface/3aff174f-1345-468a-bab0-761eba443a65/report.json`；runGroup `3aff174f-1345-468a-bab0-761eba443a65`，三个 session/run 均有唯一身份，`provenanceErrors=[]`、`browserErrors=[]`、`gateErrors=[]`，三次 diagnostics 均为 validation/uncaptured/deviceLost 全 0。
- M5 观测：三次 `visibleHitRatio=1.0`；`setupVisiblePixelFallbacks=0`；`setupOverflow=0`；`workCacheBytes=5,788,240`、`workCachePeakBytes=5,788,240`。`triangleSetupGate` 返回 `default-eligible`，但这只关闭 hit-ratio 子门槛，不关闭 RFC 的 correctness、near-plane、off/on 性能和内存 Gate。
- 已完成对应 off 基线：`temp/visibility-to-surface/b24b94a5-3169-4c10-a58e-dce610e0a7f5/report.json`，同样 3/3、clean provenance、零浏览器/GPU diagnostics；其 `triangleSetupGate` 正确保持 `insufficient-evidence`，因为 setup 未启用。

### 2026-09-08 三步收口进度：M5 near-plane 与 M6 统一 ABI 证据

- Step 1 / M5 near-plane: off artifact `temp/visibility-to-surface/0a5df5e3-1d42-4c7f-9a73-e20f3d308d80/report.json` 与 on artifact `temp/visibility-to-surface/5d231cab-0661-4216-af18-dcfc56126270/report.json` 均为三次独立 session，`provenanceErrors=[]`、`browserErrors=[]`、`gateErrors=[]`，validation/uncaptured/deviceLost 均为 0。on 的 `visibleHitRatio` 为 `0.9986851093` 三次，达到 90% 子门槛；near-plane 的完整图像/数值 parity 仍未由 runner 证明。
- Step 2 / M6 unified ABI: 历史 artifact 只能作为阶段观察，尚未形成统一路径的完整 attachment/readback parity、transient peak 和 consumer coverage 证据，因此 `surfaceAbi` 仍保持 `insufficient-evidence`；不会启动第二套 ABI。
- Step 3 / final synchronization: 旧 artifact 中 NVIDIA/Turing adapter 的 `depth32float + depthCompare=equal` probe 曾因 read-only depth attachment validation 被拒绝；本批已修复描述符，后续必须在 clean commit 上重跑以确认 `class-depth`。旧 artifact 仍不关闭 M3 class-depth 性能 Gate。M7 仍缺第二 GPU vendor，保持 `insufficient-evidence`，不创建 Tile runtime。

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
- Gate conclusion（历史快照）：M3 代码路径已接通，状态为 `implemented-awaiting-evidence`。该记录形成时 M4 尚未收口；当前 Pixel Queue 与 `VisiblePixelClassifier` 已删除，生产路径状态以 RFC 收尾结论和 `docs/STATUS.md` 为准。

### 2026-09-08 三步批次追加：M3 probe 修复与证据边界

- Step 1 / M3 implementation correction: `MaterialClassDepthProbe` 的只读 depth verification pass 已移除 `depthLoadOp`/`depthStoreOp`。WebGPU 规定 `depthReadOnly=true` 时不得提供这两个字段；此前 NVIDIA/Turing 的 fallback 原因就是该 validation error。
- Step 2 / regression coverage: 新增 source-level 回归测试，固定只读 attachment 描述符不再回归；`OEngine/npm test` 当前 440/440 通过。
- Step 3 / formal evidence（历史快照）：当时重新启动 `comprehensive-full` formal runner，但浏览器 fixture 尚未返回 ready/report，故没有生成新的 GPU artifact。该记录中的旧 M5/M6 artifact 仅用于当时的阶段判断，不代表当前统一 ABI 的完整证据；M3 class-depth A/B 也仍未达到发布 Gate。当前实现和未完成项以 RFC 收尾结论和 `docs/STATUS.md` 为准。
- Clean rerun result: `temp/visibility-to-surface/7ccf8b4e-bbfb-45aa-a5cc-78b8c938c11f/report.json` 在提交 `b8df85e` 上完成 3/3 独立 session，`provenanceErrors=[]`、`browserErrors=[]`、`gateErrors=[]`；三次 `materialResolveBackend=class-depth` 且 `source=adapter-probe`。这只关闭 probe validation blocker，不替代 M3 legacy/class-depth/class-discard correctness、性能和截图 parity Gate。
- 2026-09-08 Playwright M3 A/B 发现 correctness blocker：同一 `cube-near-effects-off`、1920x1080、DPR 1、三次独立 Chrome session 下，`class-discard` artifact `temp/visibility-to-surface/cff35f68-d006-4a95-a229-9fe82f52a136/report.json` 的截图显示正常场景，而 `class-depth` artifact `temp/visibility-to-surface/94539da3-80be-456b-8884-af4bc9f16d24/report.json` 的截图接近全黑。两组 `gateErrors=[]` 只说明 GPU/浏览器诊断干净，当前 runner 尚未做逐像素 parity，因此 M3 correctness Gate 明确不通过，后续必须先定位 depth-equal resolve 的实际像素失败。

### 2026-09-08 ClassDepth equality correctness fix

- Root cause: resolve only used vertex `position.z`; in the real Chrome/Dawn FrameGraph path this reconstructed value was not bit-identical to the classification pass's explicit `frag_depth`, so `equal` rejected all Surface fragments. The adapter probe did not cover this path.
- Change: resolve fragment output now adds `@builtin(frag_depth)` and writes the same `(OENGINE_ACTIVE_KERNEL_CLASS + 1) / 8` value as the producer. `class-depth` remains `depthCompare="equal"`; `class-discard` remains the correctness fallback.
- Browser evidence: `temp/visibility-to-surface/2d43f99c-e967-43d6-b753-1fea54b48fe6/` shows the red cube restored under class-depth. It is a dirty 30+60 development smoke and does not close the formal Gate; the earlier `cff35f...`/`94539...` black-screen A/B remains the regression artifact.
- Test evidence: `OEngine/npm test` 440/440. The formal backend A/B is now complete; identity-bearing pixel parity, M3 threshold evaluation and the clean legacy baseline remain open, so M3 stays `implemented-awaiting-evidence`.
- Clean formal rerun: class-depth `temp/visibility-to-surface/2c09e8eb-0a9a-44ab-ac1a-4a258cd7446f/report.json` and class-discard `temp/visibility-to-surface/361d9a01-4563-41c8-bc02-1c660ce80e1e/report.json` each passed 3 independent sessions at 1920x1080/DPR1, 120+480 cadence, with empty provenance/browser/GPU diagnostics. Screenshots from both groups show the restored red cube. Resolve P50s: class-depth 2.370464/2.579264/2.535376 ms; class-discard 2.476624/2.510848/2.462496 ms.
- Status: the black-screen correctness regression is fixed and the clean backend A/B evidence is recorded. M3 is still not release-complete because the harness does not yet produce identity-bearing per-attachment pixel parity against a clean legacy baseline; performance numbers are therefore comparative evidence, not the final 15%/10% Gate result.

### 2026-09-09 comprehensive-full browser evidence

- Command: `OENGINE_RENDERING_LAB_BASE_URL=http://127.0.0.1:5173 npm run profile:rendering-lab:formal -- comprehensive-full`。
- Artifact: `temp/visibility-to-surface/ce60cf64-6ed4-4852-9303-3b6c1880aba6/report.json`，同时保存 `run-0..2.png` 和 `canvas-0..2.png`。commit provenance 为 clean `90ceb6a`；Chrome 152 headless、NVIDIA Turing、1920×1080、DPR 1、120 warm-up + 480 sampled frames，3 个独立 session 均完成。
- Backend: 三次均由真实 adapter probe 选择 `class-depth`，选择原因是 `depth32float` class values 与 fixed-function `equal` comparison 通过；没有回退到 `class-discard`。
- Screenshot check: 三张 canvas 截图均包含非空 Dungeon 场景、Surface resolve、光照/阴影、透明物体和后处理结果；三次 canvas SHA-256 分别为 `0331df647ed0ec3e0d2c9cfced3c686800e78b535ceb6e3da7d96f3808b2d17f`、`11b6ef61aaedd6b69a621d009d9893772860d4ec184f05f5b12031adef97b3b5`、`0ead88b51d18f0f8eb6be2e4acaff62c03b8869d1920193f1b815b87ca7a500e`。动画场景导致帧间 hash 不同，不能把它们当作 bit parity。
- Runtime evidence: `browserErrors=[]`、`provenanceErrors=[]`、`gateErrors=[]`；每次 validation/uncaptured/deviceLost 均为 `0/0/0`，`invalidVisibilityKeys` 与 `queueOverflowMask` 的 P99 均为 0。GPU frame P50/P95/P99 分别为 `11.236/14.965/17.066 ms`、`12.507/14.953/16.045 ms`、`12.861/15.506/16.080 ms`；Surface attachment 为 `53,913,600 B`（26 B/pixel），resident bytes P95 约 `1,553.7 MiB`。
- Gate conclusion: 该 artifact 关闭了当前统一生产路径的浏览器 smoke/capture 验证，并证明 class-depth 在本机真实运行；TriangleSetup 仍关闭，M6 unified Surface ABI 仍为 `insufficient-evidence`，M7 仍缺第二 vendor，未把这次 full workload 误写成 release parity 或性能 Gate 通过。

### 2026-09-07 M4 implementation closure

- Direction: 用户明确要求在不扩散冗余测试的前提下继续完成 M4，因此实现删除继续推进；这不补写、替代或伪造尚缺的 M3 三次正式性能 A/B。
- Implementation: 删除 `VisiblePixelClassifier.ts` 与 `visible_pixel_classification.ts`；删除 ShadeWork capacity、recursive scan/prefix/scatter ABI 与 CPU oracle；Packed Surface 默认且唯一生产路径为 `MaterialClassDepth → bounded fullscreen kernels`，仅保留内部 `class-discard` correctness fallback。公开 `RendererConfig` 不再暴露迁移 backend flag。
- WebGPU correction: Surface kernel 的 class depth 由 vertex position 固定提供，fragment 不再输出 `frag_depth`，避免关闭 early depth testing；Surface depth attachment 标记为 read-only。
- Observability: FrameGraph 不再包含旧 count/prefix/add/scatter Pass 或 ShadeWork resource；历史固定 counter slots 标记为 unsupported/retired，不再注册或生产。新增 class-depth/fullscreen labels 已接入稳定 GPU phase 与 Surface timing 分类。
- Verification: `npm run build`、`npm run build:test`；M4/Material/FrameGraph/resource/profiler targeted tests 31/31 通过；`examples` 本地 Vite 下 `npm run test:rendering-lab:workload` 退出码 0。
- Not run: 全量测试、三次正式 A/B、截图数值 parity 与多 adapter performance Gate，遵循用户“不需要跑太多冗余测试”的要求。工作树中预存的 Inspector 文档删除和 examples oracle 文件不属于本提交。
- Gate conclusion: M4 的源代码、FrameGraph 与资源移除 Gate 已关闭；由于 M3 正式性能/图像证据仍缺失，release acceptance 继续标记待证据，不据此宣称性能达标。
