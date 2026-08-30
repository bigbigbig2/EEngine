# R5 Quality Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 R4 Packed GPU-driven core 上完成可验证的 Lighting、Shadow、Transparency、Temporal/Upscaling 与 Post 主管线，并删除相应 legacy consumer。

**Architecture:** 保留现有 `FX-01..12` 编号，新增 `R5-00` 合同冻结，并以 `G5-L → G5-S → G5-T → G5-P` 四个子 Gate 控制风险。已有算法优先 revalidate/迁移；Shadow/Transparency 的 work producer 迁到 Packed hierarchy，Temporal 先闭合 source-of-truth 和 reactive/history contract。

**Tech Stack:** TypeScript, WGSL, WebGPU, OEngine FrameGraph, Node test runner, Vite examples, GPU timestamp/counter evidence.

**Spec:** `docs/implementation/08-lighting-temporal-post.md`

## Global Constraints

- R4-C Software/Hybrid Raster 是 optional performance track，不是 R5 前置依赖。
- HW-only Visibility + Single Material Resolve 是 R5 correctness baseline。
- 一个 steady main submit；禁止 feature 私有 submit/readback 控制当前帧。
- Feature off 后对应 pass/resource/history/counter/readback 必须消失。
- Queue 必须区分 attempted/written/capacity/overflow；consumer 只读 written。
- 性能结论必须同机、同浏览器、同 GPU、同 resolution/profile。
- 所有外部算法按 `docs/references/OPEN-SOURCE-REUSE.md` 登记 source/commit/license/adaptation。
- 每个 FX 合入前执行 `docs/implementation/R5-TEST-MANUAL.md` 的对应章节。

---

### Task 1: R5-00 Contract / Baseline Freeze

**Files:**
- Modify: `docs/implementation/08-lighting-temporal-post.md`
- Modify: `docs/implementation/README.md`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/TARGETS.md`
- Modify: `docs/implementation/10-verification-matrix.md`
- Modify: `examples/benchmark-shared/manifests/benchmark-a.json`
- Modify: `examples/benchmark-shared/manifests/benchmark-b.json`
- Modify: `examples/benchmark-shared/manifests/benchmark-c.json`
- Test: `OEngine/tests/benchmark-scene-manifest.test.mjs`
- Test: `OEngine/tests/benchmark-evidence-gate.test.mjs`

**Interfaces:**
- Consumes: R4 `VisibilityKey/Depth/Surface/Velocity/SurfaceFlags`.
- Produces: R5 Surface/color/temporal contract and hardware-only base benchmark role.

Scope boundary: R5-00 owns ABI/version/packing、现有 producer/consumer 迁移与 A/B/C artifact；FX-01 只能验证 GPU 数值、background 与 debug，不得重新定义同一 ABI。

- [ ] **Step 1: Make manifest governance test fail**

Extend `benchmark-scene-manifest.test.mjs` so R5 base A/B/C rejects `software-visibility` in `featureSet` while R4-C variants may use it under distinct IDs.

```js
for (const manifest of manifests) {
  assert.equal(
    manifest.featureSet.includes("software-visibility"),
    false,
    `${manifest.id} R5 base must remain HW-only`
  );
}
```

- [ ] **Step 2: Run the focused test**

```bat
cd OEngine
npm run build:test
node --test tests/benchmark-scene-manifest.test.mjs
```

Expected before manifest edit: FAIL on A/B/C.

- [ ] **Step 3: Update base manifests and docs**

Remove optional SW feature from base A/B/C; document R4-C as a separate variant/profile.

- [ ] **Step 4: Run governance verification**

```bat
npm test
npm run audit:shaders
cd ..\examples
npm run build
```

Expected: PASS / exit code 0.

- [ ] **Step 5: Capture R5-00 A/B/C baseline**

Follow `R5-TEST-MANUAL.md#r5-00--contract--baseline-freeze`. Expected: HW-only, one submit, zero invalid/overflow/diagnostics, warm graph stable.

- [ ] **Step 6: Commit**

```bash
git add docs examples/benchmark-shared/manifests OEngine/tests
git commit -m "文档（R5-00）：冻结质量阶段合同与基线"
```

---

### Task 2: FX-01 Surface Debug + Background

**Files:**
- Modify: `OEngine/src/render/passes/PackedMaterialResolvePass.ts`
- Modify: `OEngine/src/render/passes/RenderDebugViewPass.ts`
- Modify: `OEngine/src/shaders/render_debug_view.ts`
- Test/Create: `OEngine/tests/r5-surface-contract.test.mjs`
- Example/Create or extend: one R5 surface micro page under `examples/`

**Interfaces:**
- Consumes: R5-00 已冻结的 packed Surface/Depth/Velocity/Metadata ABI.
- Produces: GPU numeric/debug/background evidence consumed by all later R5 tasks；不重新拥有 ABI format/packing.

- [ ] **Step 1: Add failing decode/semantic tests**

Test empty, metallic/roughness, normal unit length, emissive/unlit, velocity invalid and reactive exact bits.

- [ ] **Step 2: Run focused tests and observe failure**

```bat
npm run build:test
node --test tests/r5-surface-contract.test.mjs
```

- [ ] **Step 3: Implement only missing debug/semantic wiring**

Do not change Surface format/packing/velocity ABI inside FX-01. A proven mismatch returns to an explicit R5-00 ABI version change.

- [ ] **Step 4: Run surface browser fixture**

Expected outputs are defined in `R5-TEST-MANUAL.md#fx-01--surface-debug--background--g5-l-前置`.

- [ ] **Step 5: Commit**

```bash
git commit -am "实现（R5-FX01）：冻结 Surface debug 与背景合同"
```

---

### Task 3: FX-02 Clustered Direct Lighting

**Files:**
- Modify: `OEngine/src/render/passes/LightClusterPass.ts`
- Modify: `OEngine/src/shaders/light_cluster.ts`
- Modify: `OEngine/src/debug/GpuFrameCounters.ts`
- Modify: `OEngine/src/debug/BenchmarkCapabilityEvidence.ts`
- Test/Create: `OEngine/tests/r5-light-cluster.test.mjs`
- Example/Create or extend: C-light sweep

**Interfaces:**
- Consumes: Surface ABI, HZB, LightDatabase.
- Produces: bounded LightList/Cluster metadata and direct HDR.

- [ ] **Step 1: Add CPU tests for attempted/written semantics**

Create a reference structure whose consumer count is always `written`, not attempted.

```js
assert.equal(queue.attempted, 5);
assert.equal(queue.written, 4);
assert.equal(queue.capacity, 4);
assert.equal(queue.overflow, true);
```

- [ ] **Step 2: Add pressure test for >128 lights in one cluster**

Expected: overflow bit + conservative fallback; never silent omission.

- [ ] **Step 3: Run focused tests; verify current implementation fails**

- [ ] **Step 4: Implement bounded queue header and per-cluster overflow**

Preserve existing LightDatabase until profile proves a table rewrite is needed.

- [ ] **Step 5: Run C-light sweep**

0/1/16/64/256/1024, spread + overlap. Save counters and P50/P95/P99.

- [ ] **Step 6: Close lighting shader source ownership**

Replace or generate `lighting_ch_oracle.ts` from a recorded source before G5-L.

- [ ] **Step 7: Commit**

```bash
git commit -am "实现（R5-FX02）：收口 clustered lighting 容量与 direct lighting"
```

---

### Task 4: FX-03 IBL Alignment and G5-L

**Files:**
- Modify: existing IBL/environment passes only as required by oracle.
- Create: B-shading-oracle example/fixture.
- Create: `docs/references/porting/R5-01-surface-lighting.md`
- Test: numeric IBL tests.

**Interfaces:**
- Consumes: Surface ABI, environment.
- Produces: verified direct+IBL opaque HDR.

- [ ] **Step 1: Build fixed B-shading-oracle**
- [ ] **Step 2: Freeze linear HDR reference environment/hash**
- [ ] **Step 3: Add roughness/metallic/environment orientation tests**
- [ ] **Step 4: Capture linear HDR before tonemap**
- [ ] **Step 5: Run G5-L full checklist**
- [ ] **Step 6: Commit G5-L closure evidence**

---

### Task 5: FX-04 Packed CSM Shadow

**Files:**
- Modify: `OEngine/src/gpu/ShadowContext.ts`
- Modify: shadow raster/work passes.
- Modify: hierarchy work generator only through a per-view adapter, not a second algorithm.
- Test/Create: `OEngine/tests/r5-shadow-csm.test.mjs`
- Create: `docs/references/porting/R5-02-csm-shadow.md`

**Interfaces:**
- Consumes: Packed Scene + hierarchy selector + Material Visibility alpha.
- Produces: shadow atlas sampled by Lighting.

- [ ] **Step 1: Add cascade split/bounds tests**
- [ ] **Step 2: Add per-cascade queue capacity tests**
- [ ] **Step 3: Replace Packed caster `MeshletDrawList` producer with hierarchy RasterWork**
- [ ] **Step 4: Add alpha-tested caster**
- [ ] **Step 5: Run sub-texel/cascade-boundary sequence**
- [ ] **Step 6: Run C-shadow GPU phase capture**
- [ ] **Step 7: Commit**

---

### Task 6: FX-05 Packed MBOIT Transparency and G5-S

**Files:**
- Modify: `OEngine/src/render/passes/TransparentOitPass.ts`
- Modify: transparent WGSL.
- Add bounded `TransparentRasterWork` producer using Packed hierarchy/material slots.
- Test/Create: `OEngine/tests/r5-transparency-mboit.test.mjs`
- Create: `docs/references/porting/R5-03-transparency.md`

**Interfaces:**
- Consumes: Packed geometry/material/texture tables, opaque depth, Lighting inputs.
- Produces: transparent HDR composite + reactive/motion semantics.

- [ ] **Step 1: Add order-invariance overlapping-quad test**
- [ ] **Step 2: Add sorted-alpha CPU quality reference**
- [ ] **Step 3: Add transparent queue capacity/overflow test**
- [ ] **Step 4: Remove per-material draw scaling from Packed transparency**
- [ ] **Step 5: Run C-transparent 1/8/64 material sweep**
- [ ] **Step 6: Close G5-S and commit**

---

### Task 7: FX-06 Temporal / DRS / Upscaling

**Files:**
- Modify: `OEngine/src/render/passes/TemporalAntiAliasingPass.ts`
- Modify: temporal shader ownership.
- Modify: DynamicResolution integration.
- Modify: FrameGraph history inputs/revisions as required.
- Test/Create: `OEngine/tests/r5-temporal-contract.test.mjs`
- Create: `docs/references/porting/R5-04-temporal-upscale.md`

**Interfaces:**
- Consumes: HDR, Depth, Velocity, Reactive, history revision, internal/output resolution.
- Produces: stable reconstructed output/history.

- [ ] **Step 1: Close temporal generated-source provenance**
- [ ] **Step 2: Add reprojection/cut/resize/scale tests**
- [ ] **Step 3: Wire reactive/disocclusion inputs**
- [ ] **Step 4: Connect delayed GPU frame timing to DRS without synchronous readback**
- [ ] **Step 5: Run C-temporal/C-resolution sequence**
- [ ] **Step 6: Commit**

---

### Task 8: FX-07 AO + FX-08 SSR and G5-T

**Files:**
- Modify existing SSAO/SSR passes only after baseline failure is demonstrated.
- Optional replacement ledgers: `R5-05-ao.md`, `R5-06-ssr.md`.
- Tests: AO numeric fixture; SSR hit/miss/roughness fixture.

- [ ] **Step 1: Revalidate current SSAO**
- [ ] **Step 2: Revalidate current SSR**
- [ ] **Step 3: Replace only if quality/performance Gate fails**
- [ ] **Step 4: Run temporal sequence for AO/SSR**
- [ ] **Step 5: Close G5-T and commit**

---

### Task 9: FX-09 Post / FX-10 Optional / FX-11 Fusion

**Files:**
- Modify existing exposure/bloom/tonemap/motion/sharpen passes as contract tests require.
- Optional effects remain isolated feature nodes.
- Fusion only after timestamp/bandwidth evidence.

- [ ] **Step 1: Freeze HDR/exposure/output order**
- [ ] **Step 2: Test exposure/bloom/SDR/HDR/motion-invalid**
- [ ] **Step 3: Verify optional effects off have zero graph cost**
- [ ] **Step 4: Run only evidence-driven fusion experiments**
- [ ] **Step 5: Commit**

---

### Task 10: FX-12 Legacy Deletion and G5-P

**Files:**
- Delete/modify legacy consumers only after their Packed replacement is live.
- Update `docs/SHADER-SOURCES.md`.
- Regenerate `OEngine/benchmarks/shader-source-audit.json`.

- [ ] **Step 1: Locate remaining consumers with `git grep`**
- [ ] **Step 2: Delete only proven dead realtime paths**
- [ ] **Step 3: Run full Node/build/shader audit**
- [ ] **Step 4: Run clean/full A/B/C + all R5 axes**
- [ ] **Step 5: Fill target-machine absolute values in performance targets**
- [ ] **Step 6: Close G5-P / R5 and commit**

```bash
git commit -am "文档（R5）：关闭质量集成与性能 Gate"
```
