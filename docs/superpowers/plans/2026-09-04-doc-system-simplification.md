# OEngine Internal Documentation Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 95-file historical documentation tree with 15 current internal documents whose facts match production code, while preserving active architectural decisions and license/provenance records.

**Architecture:** Six root documents own product scope, architecture, frame contracts, current status, and validation. Three consolidated ADRs own long-lived decisions, and four domain ledgers own active upstream/license records. Git is the only archive; historical stage documents are deleted after valid content and live references migrate.

**Tech Stack:** Markdown, TypeScript/WGSL source inspection, Node.js `node:test`, PowerShell, Git.

**Spec:** `docs/superpowers/specs/2026-09-04-doc-system-simplification-design.md`

## Global Constraints

- Final `docs/` contains exactly the 15 Markdown files listed below and no archive.
- Serve internal developers and Agents only; do not add external tutorials or API guides.
- Git history is the only archive for stages, old metrics, removed examples, and rejected research.
- Do not modify runtime behavior, GPU/WGSL ABI, or rendering algorithms.
- Derive current claims from current TypeScript/WGSL/tests, not historical stage prose.
- Preserve active upstream URL, revision, source path, license, invariants, WebGPU differences, fallback/lifecycle, and validation.
- Do not restore `three.js/`, `webgpufundamentals/`, removed examples/runners, or `performance-targets.json`.
- Keep Packed/legacy debt, Renderer composition debt, product-performance gaps, and four unknown shader owners explicit.
- Use `apply_patch` for authored edits. Verify every bulk deletion target resolves under `D:\code\EEngine\docs`.
- Preserve unrelated changes; stop on unexpected worktree modifications.

## Final File Map

```text
docs/README.md
docs/PRODUCT.md
docs/ARCHITECTURE.md
docs/PIPELINE.md
docs/STATUS.md
docs/VALIDATION.md
docs/adr/README.md
docs/adr/0001-gpu-first-scope.md
docs/adr/0002-runtime-assets-and-gpu-driven.md
docs/adr/0003-unified-render-pipeline.md
docs/porting/README.md
docs/porting/geometry.md
docs/porting/visibility.md
docs/porting/shading.md
docs/porting/platform.md
```

---

### Task 1: Establish the documentation contract and six core documents

**Files:**
- Create: `OEngine/tests/documentation-system.test.mjs`
- Modify: `docs/README.md`
- Create: `docs/PRODUCT.md`
- Modify: `docs/ARCHITECTURE.md`
- Create: `docs/PIPELINE.md`
- Create: `docs/STATUS.md`
- Create: `docs/VALIDATION.md`
- Read: `OEngine/src/render/Renderer.ts`
- Read: `OEngine/src/render/pipeline/FrameProducts.ts`
- Read: `OEngine/src/render/pipeline/FramePlan.ts`
- Read: `OEngine/src/framegraph/FrameGraph.ts`
- Read: `OEngine/src/render/features/*.ts`
- Read: `OEngine/src/gpu/GpuAssetStore.ts`
- Read: `OEngine/src/gpu/GpuScene.ts`
- Read: `OEngine/src/gpu/GpuPackedSceneRegistry.ts`

**Interfaces:**
- Consumes: approved spec and current production owners.
- Produces: six root documents with stable headings used by all later routing.

- [ ] **Step 1: Write failing core-document tests**

Create `OEngine/tests/documentation-system.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docsRoot = path.join(repoRoot, "docs");
const CORE_DOCS = Object.freeze({
  "README.md": ["# OEngine 内部文档", "权威"],
  "PRODUCT.md": ["# OEngine 产品边界", "非目标", "16.667 ms"],
  "ARCHITECTURE.md": ["# OEngine 架构", "当前实现", "目标差距"],
  "PIPELINE.md": ["# OEngine 帧管线", "VisibilityKey", "SurfaceFrame"],
  "STATUS.md": ["# OEngine 当前状态", "Legacy", "下一步"],
  "VALIDATION.md": ["# OEngine 验证合同", "Rendering Lab", "feature-off"]
});

function readDoc(relativePath) {
  const absolute = path.join(docsRoot, relativePath);
  assert.equal(existsSync(absolute), true, `${relativePath} must exist`);
  return readFileSync(absolute, "utf8");
}

test("internal documentation has six single-purpose core documents", () => {
  for (const [relativePath, markers] of Object.entries(CORE_DOCS)) {
    const source = readDoc(relativePath);
    for (const marker of markers) assert.match(source, new RegExp(marker));
  }
});

test("current status keeps production debt explicit", () => {
  const status = readDoc("STATUS.md");
  assert.match(status, /MaterialExpandPass/);
  assert.match(status, /VelocityPass/);
  assert.match(status, /TransparentOitPass/);
  assert.match(status, /Renderer\.ts/);
  assert.match(status, /3853|大型 composition root/);
  assert.match(status, /unknown[^\n]*4|4[^\n]*unknown/i);
  assert.doesNotMatch(status, /^## .*?(?:R[0-5]|P[0-9]|Q0[0-9]|FX-|Stage [0-9])/m);
});
```

- [ ] **Step 2: Confirm the test fails for missing new documents**

```powershell
Set-Location D:\code\EEngine\OEngine
node --test --test-name-pattern "six single-purpose|production debt" tests/documentation-system.test.mjs
```

Expected: FAIL because four new core files are absent and retained files lack the new markers.

- [ ] **Step 3: Rebuild the six core documents from current source**

Use these exact responsibilities and headings:

```markdown
# OEngine 内部文档
## 阅读顺序
## 权威关系
## 决策与来源
## 历史查询

# OEngine 产品边界
## 定位
## 目标平台与工作负载
## 核心能力
## 产品目标
## 非目标
## Deferred

# OEngine 架构
## 当前实现
## 依赖方向
## 模块与 Owner
## 生命周期与资源所有权
## 公开接口
## 当前双路径
## 目标差距

# OEngine 帧管线
## 当前主帧
## GPU Work Contract
## Visibility Contract
## Frame Products
## Lighting、Transparency 与 Temporal
## FrameGraph 与提交
## Feature-off
## 尚未统一的路径

# OEngine 当前状态
## 已验证基础
## 当前生产 Owner
## Legacy 与迁移债务
## 正确性与画质风险
## 性能与内存风险
## 来源与发布风险
## 下一步

# OEngine 验证合同
## 本地构建与测试
## Rendering Lab
## WebGPU 正确性
## 性能比较
## 显存与 I/O
## Feature-off
## 完成语义
## 提交前清单
```

Required content:

- `README.md` only routes authority and says Git owns deleted history.
- `PRODUCT.md` freezes desktop WebGPU, discrete-GPU performance profile, mostly-static/high-geometry workload, Hardware-first Visibility, Packed Instances and one pipeline. Mark `1920×1080 / DPR 1 / 60 FPS / 16.667 ms GPU` as not demonstrated.
- `ARCHITECTURE.md` maps real owner classes. Verify every class with `rg`. Record the approximately 3853-line Renderer, `packedResolveOut ?? obtainLegacyMaterialExpand()`, legacy Velocity/OIT and current AO/SSR/GI pass ownership.
- `PIPELINE.md` copies field names from `FrameProducts.ts` and ABI modules. Do not describe Software/Hybrid raster as a current producer without a source owner.
- `STATUS.md` names four unknown shaders and real legacy consumers, contains at most five next actions, and contains no historical stage matrix.
- `VALIDATION.md` includes exact commands below, numeric/readback/diagnostic evidence, optional screenshots, same-condition comparisons, one main submit, feature-off, resident 512 MiB, transient 256 MiB, history 128 MiB, shadow atlas 128 MiB, upload 8 MiB/frame and readback 256 KiB/frame.

```powershell
Set-Location OEngine
npm ci
npm test
Set-Location ..\examples
yarn install
yarn build
yarn build:storybook
```

- [ ] **Step 4: Run the core-document tests**

```powershell
Set-Location D:\code\EEngine\OEngine
node --test tests/documentation-system.test.mjs
```

Expected: PASS for the two initial tests. Historical documents remain until Task 5.

- [ ] **Step 5: Commit the core documents**

```powershell
Set-Location D:\code\EEngine
git add -- docs/README.md docs/PRODUCT.md docs/ARCHITECTURE.md docs/PIPELINE.md docs/STATUS.md docs/VALIDATION.md OEngine/tests/documentation-system.test.mjs
git commit -m "文档：建立精简后的六个权威入口"
```

---

### Task 2: Consolidate active architecture decisions

**Files:**
- Modify: `OEngine/tests/documentation-system.test.mjs`
- Create: `docs/adr/README.md`
- Create: `docs/adr/0001-gpu-first-scope.md`
- Create: `docs/adr/0002-runtime-assets-and-gpu-driven.md`
- Create: `docs/adr/0003-unified-render-pipeline.md`
- Read: `docs/wiki/adr/0001-gpu-first-webgpu-engine.md` through `0012-product-render-pipeline-redesign.md`

**Interfaces:**
- Consumes: long-lived decisions from twelve existing ADRs.
- Produces: three non-overlapping accepted ADRs.

- [ ] **Step 1: Add a failing ADR contract**

```js
const ADR_DOCS = Object.freeze({
  "adr/README.md": ["# OEngine ADR", "0001", "0002", "0003"],
  "adr/0001-gpu-first-scope.md": ["Status: accepted", "Hardware-first", "WebGPU"],
  "adr/0002-runtime-assets-and-gpu-driven.md": ["Status: accepted", "Runtime Asset", "GPU producer"],
  "adr/0003-unified-render-pipeline.md": ["Status: accepted", "Material Resolve", "FrameGraph"]
});
test("three consolidated ADRs own active long-lived decisions", () => {
  for (const [relativePath, markers] of Object.entries(ADR_DOCS)) {
    const source = readDoc(relativePath);
    for (const marker of markers) assert.match(source, new RegExp(marker));
  }
});
```

- [ ] **Step 2: Confirm the ADR test fails**

```powershell
node --test --test-name-pattern "consolidated ADRs" tests/documentation-system.test.mjs
```

Expected: FAIL because `docs/adr/` is absent.

- [ ] **Step 3: Create the index and three ADRs**

Every ADR uses:

```markdown
# ADR-NNNN · Title
Status: accepted
## Context
## Decision
## Consequences
## Verification
```

`0001` owns platform/scope/Hardware-first; `0002` owns Runtime Asset/GPU tables/Packed Instances/hierarchy/SSE/GPU producer-to-indirect-consumer/VisibilityKey; `0003` owns Single Material Resolve/unified lighting-temporal-post/FrameGraph/one-submit/pruning/evidence. Resolve Software/Hybrid in favor of current Hardware-first: future adapter, not current correctness prerequisite. Do not copy superseded chronology.

- [ ] **Step 4: Verify and commit ADRs**

```powershell
node --test tests/documentation-system.test.mjs
Set-Location D:\code\EEngine
git add -- docs/adr OEngine/tests/documentation-system.test.mjs
git commit -m "文档：合并当前有效架构决策"
```

Expected: tests PASS; commit contains only the new ADRs and contract extension.

---

### Task 3: Consolidate active upstream and license provenance

**Files:**
- Modify: `OEngine/tests/documentation-system.test.mjs`
- Create: `docs/porting/README.md`
- Create: `docs/porting/geometry.md`
- Create: `docs/porting/visibility.md`
- Create: `docs/porting/shading.md`
- Create: `docs/porting/platform.md`
- Modify: `OEngine/tests/packed-csm-shadow.test.mjs`
- Modify: `OEngine/tests/r5-fx06-temporal.test.mjs`
- Modify: `OEngine/tests/r5-fx07-ambient-occlusion.test.mjs`
- Modify: `OEngine/tests/r5-fx08-screen-space-reflections.test.mjs`
- Read: all `docs/references/porting/*.md`
- Read: `OEngine/benchmarks/shader-source-audit.json`

**Interfaces:**
- Consumes: active porting records and current shader owner audit.
- Produces: four ledgers with stable record IDs; provenance tests consume `docs/porting/shading.md`.

- [ ] **Step 1: Add a failing porting contract**

```js
const PORTING_DOCS = Object.freeze({
  "porting/README.md": ["# OEngine 移植与来源", "采用状态", "许可证"],
  "porting/geometry.md": ["# Geometry", "meshoptimizer", "license"],
  "porting/visibility.md": ["# Visibility", "VisibilityKey", "license"],
  "porting/shading.md": ["# Shading", "CSM", "Temporal", "XeGTAO", "FidelityFX SSSR"],
  "porting/platform.md": ["# Platform", "WebGPU", "FrameGraph", "license"]
});
const REQUIRED_PROVENANCE_FIELDS = Object.freeze([
  "Local owner/source:", "Upstream:", "Revision:", "Upstream source:",
  "License:", "Adoption:", "Retained invariants:",
  "OEngine/WebGPU differences:", "Fallback/lifecycle:", "Local validation:"
]);
test("active upstream provenance is grouped into four domain ledgers", () => {
  for (const [relativePath, markers] of Object.entries(PORTING_DOCS)) {
    const source = readDoc(relativePath);
    for (const marker of markers) assert.match(source, new RegExp(marker, "i"));
    if (relativePath === "porting/README.md") continue;
    for (const field of REQUIRED_PROVENANCE_FIELDS) assert.match(source, new RegExp(field, "i"));
  }
});
```

- [ ] **Step 2: Confirm the porting test fails**

```powershell
node --test --test-name-pattern "active upstream provenance" tests/documentation-system.test.mjs
```

Expected: FAIL because `docs/porting/` is absent.

- [ ] **Step 3: Create four complete domain ledgers**

Every retained record uses this schema:

```markdown
## RECORD-ID · Name
- Local owner/source:
- Upstream:
- Revision:
- Upstream source:
- License:
- Adoption:
- Retained invariants:
- OEngine/WebGPU differences:
- Fallback/lifecycle:
- Local validation:
```

Source routing:

- Geometry: camera controls, Bevy/meshoptimizer Meshlet, package Cooker, hierarchy/SSE parts of R3.
- Visibility: GPU residency/work generation/HZB, Packed Visibility, direct VisibilityKey, material classification.
- Shading: material reconstruction/velocity, Surface ABI, PBR/IBL, clustered lighting, CSM, MBOIT, Temporal, GTAO, SSR, Color Grading, GI, retained Rendering Lab asset.
- Platform: active WebGPU capability/resource/cache/readback/FrameGraph references.

Do not migrate deferred-only candidates or records whose local consumer was deleted. Preserve these exact tested revisions:

```text
07e3eaa10e7dd026ec9d95fe326db2d5c4227e1b
7cda7e710d884827fc73ff1a3aa63270846513d7
4795aa0007d464371abe60b7b28a1cf893a4e349
1680d1edd5c034f88ebbbb793d8b88f8842cf804
0d177ce06bfa642f64d8af4de1197ad1bcb862d4
```

- [ ] **Step 4: Migrate provenance tests to the consolidated ledger**

In the four listed tests, replace only the URL with:

```js
new URL("../../docs/porting/shading.md", import.meta.url)
```

Retain current assertions for revisions, source paths, licenses, adoption decisions and unsupported boundaries.

- [ ] **Step 5: Verify and commit provenance**

```powershell
Set-Location D:\code\EEngine\OEngine
node --test tests/documentation-system.test.mjs tests/packed-csm-shadow.test.mjs tests/r5-fx06-temporal.test.mjs tests/r5-fx07-ambient-occlusion.test.mjs tests/r5-fx08-screen-space-reflections.test.mjs
Set-Location D:\code\EEngine
git add -- docs/porting OEngine/tests/documentation-system.test.mjs OEngine/tests/packed-csm-shadow.test.mjs OEngine/tests/r5-fx06-temporal.test.mjs OEngine/tests/r5-fx07-ambient-occlusion.test.mjs OEngine/tests/r5-fx08-screen-space-reflections.test.mjs
git commit -m "文档：按领域合并运行代码来源记录"
```

Expected: all focused tests PASS and only porting/test files are committed.

---

### Task 4: Migrate live repository routing and prose-coupled tests

**Files:**
- Modify: `OEngine/tests/documentation-system.test.mjs`
- Modify: `AGENTS.md`
- Modify: `CONTEXT-MAP.md`
- Modify: `OEngine/AGENTS.md`
- Modify: matching `OEngine/src/**/AGENTS.md` files that reference old docs
- Modify: `OEngine/src/geometry/GeometryHierarchy.ts`
- Modify: `OEngine/src/gpu/GpuWorkGenerationAbi.ts`
- Modify: `OEngine/src/shaders/color_grading.ts`
- Modify: `OEngine/tests/p6-transparency-feature.test.mjs`
- Modify: `OEngine/benchmarks/README.md`
- Modify: `examples/README.md` only if it differs from current `examples/package.json`

**Interfaces:**
- Consumes: final paths created by Tasks 1–3.
- Produces: all live guidance, source comments and tests point only to final docs or actual source contracts.

- [ ] **Step 1: Add a failing live-reference test**

Add to `documentation-system.test.mjs`:

```js
const ROUTED_FILES = [
  "AGENTS.md",
  "CONTEXT-MAP.md",
  "OEngine/AGENTS.md",
  "OEngine/src/core/AGENTS.md",
  "OEngine/src/framegraph/AGENTS.md",
  "OEngine/src/geometry/AGENTS.md",
  "OEngine/src/gpu/AGENTS.md",
  "OEngine/src/loaders/AGENTS.md",
  "OEngine/src/material/AGENTS.md",
  "OEngine/src/render/AGENTS.md",
  "OEngine/src/scene/AGENTS.md",
  "OEngine/src/shaders/AGENTS.md",
  "OEngine/benchmarks/README.md",
  "OEngine/src/geometry/GeometryHierarchy.ts",
  "OEngine/src/gpu/GpuWorkGenerationAbi.ts",
  "OEngine/src/shaders/color_grading.ts",
  "OEngine/tests/packed-csm-shadow.test.mjs",
  "OEngine/tests/r5-fx06-temporal.test.mjs",
  "OEngine/tests/r5-fx07-ambient-occlusion.test.mjs",
  "OEngine/tests/r5-fx08-screen-space-reflections.test.mjs",
  "OEngine/tests/p6-transparency-feature.test.mjs"
];
test("live repository routes avoid the removed documentation system", () => {
  const forbidden = [
    /docs[\\/]contexts[\\/]/,
    /docs[\\/]implementation[\\/]/,
    /docs[\\/]references[\\/]/,
    /docs[\\/]wiki[\\/]/,
    /docs[\\/](?:CONTEXT|CURRENT-STATE|DIRECTION|TARGETS|RENDER-PIPELINE|ROADMAP|PERFORMANCE|BASELINE-ARTIFACTS|SHADER-SOURCES)\.md/,
    /performance-targets\.json/,
    /`three\.js[\\/]/,
    /`webgpufundamentals[\\/]/,
    /examples[\\/](?:benchmark-[abc]|r[0-9]-|integrated-showcase|scripts)[\\/]/
  ];
  for (const relativePath of ROUTED_FILES) {
    const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, relativePath);
  }
});

const EXPECTED_DOC_ROUTES = Object.freeze({
  "OEngine/src/geometry/GeometryHierarchy.ts": "docs/porting/geometry.md",
  "OEngine/src/gpu/GpuWorkGenerationAbi.ts": "docs/porting/visibility.md",
  "OEngine/src/shaders/color_grading.ts": "docs/porting/shading.md",
  "OEngine/tests/packed-csm-shadow.test.mjs": "../../docs/porting/shading.md",
  "OEngine/tests/r5-fx06-temporal.test.mjs": "../../docs/porting/shading.md",
  "OEngine/tests/r5-fx07-ambient-occlusion.test.mjs": "../../docs/porting/shading.md",
  "OEngine/tests/r5-fx08-screen-space-reflections.test.mjs": "../../docs/porting/shading.md"
});
test("live source and test documentation routes exist", () => {
  for (const [relativePath, route] of Object.entries(EXPECTED_DOC_ROUTES)) {
    const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
    assert.equal(source.includes(route), true, `${relativePath} must route to ${route}`);
    const absolute = route.startsWith("docs/")
      ? path.join(repoRoot, route)
      : path.resolve(path.dirname(path.join(repoRoot, relativePath)), route);
    assert.equal(existsSync(absolute), true, `${route} must exist`);
  }
});
```

- [ ] **Step 2: Confirm the live-reference test fails**

```powershell
Set-Location D:\code\EEngine\OEngine
node --test --test-name-pattern "live repository routes|documentation routes exist" tests/documentation-system.test.mjs
```

Expected: FAIL on current AGENTS, router, source comments, or benchmark README.

- [ ] **Step 3: Rewrite collaboration and routing links**

`AGENTS.md` start sequence becomes:

```text
1. Read CONTEXT-MAP.md.
2. Read PRODUCT.md, ARCHITECTURE.md or PIPELINE.md only when crossing that boundary.
3. Read the closest AGENTS.md before modifying OEngine code.
4. Read docs/adr for architecture changes, VALIDATION.md for performance/verification, and docs/porting before external-algorithm work.
```

Keep GPU-first, producer/consumer, ABI, lifecycle and feature-off rules. Remove assumptions that local third-party trees exist. Rewrite `CONTEXT-MAP.md` as a compact table mapping asset, GPU scene, geometry, visibility, shading, platform, performance and status tasks to current source roots plus one final authority document.

Find and update local instructions with:

```powershell
rg -n "docs/|implementation|references|contexts|wiki|three\.js|webgpufundamentals" AGENTS.md CONTEXT-MAP.md OEngine -g "AGENTS.md"
```

- [ ] **Step 4: Migrate source comments without changing executable code**

Use these exact destinations:

```text
OEngine/src/geometry/GeometryHierarchy.ts -> docs/porting/geometry.md
OEngine/src/gpu/GpuWorkGenerationAbi.ts  -> docs/porting/visibility.md
OEngine/src/shaders/color_grading.ts      -> docs/porting/shading.md
```

- [ ] **Step 5: Replace the transparency prose test with a source contract**

Replace the test reading `13-product-render-pipeline-redesign.md` with:

```js
test("transparency feature keeps the current bounded OIT scope", async () => {
  const feature = await readFile(
    new URL("../src/render/features/TransparencyFeature.ts", import.meta.url),
    "utf8"
  );
  assert.match(feature, /PackedTransparentOitPass/);
  assert.match(feature, /TransparentOitPass/);
  assert.doesNotMatch(feature, /TransmissionPass|RefractionPass|TransparentDynamicGi/);
});
```

- [ ] **Step 6: Rewrite benchmark/example guidance around current tooling**

Keep only commands and schemas that exist under `OEngine/tools`, `OEngine/benchmarks`, current tests and Rendering Lab. Remove old A/B/C pages, deleted runners, stale shader counts and temp artifact paths. Link policy to `docs/VALIDATION.md`, current risks to `docs/STATUS.md`, and provenance to `docs/porting/README.md`. Verify `examples/README.md` commands against `examples/package.json`; do not change it if already exact.

- [ ] **Step 7: Verify and commit routing migration**

```powershell
Set-Location D:\code\EEngine\OEngine
node --test tests/documentation-system.test.mjs tests/p6-transparency-feature.test.mjs tests/shader-source-audit.test.mjs
Set-Location D:\code\EEngine
git add -- AGENTS.md CONTEXT-MAP.md OEngine/AGENTS.md OEngine/src/geometry/GeometryHierarchy.ts OEngine/src/gpu/GpuWorkGenerationAbi.ts OEngine/src/shaders/color_grading.ts OEngine/tests/documentation-system.test.mjs OEngine/tests/p6-transparency-feature.test.mjs OEngine/benchmarks/README.md examples/README.md
git add -- OEngine/src/core/AGENTS.md OEngine/src/framegraph/AGENTS.md OEngine/src/geometry/AGENTS.md OEngine/src/gpu/AGENTS.md OEngine/src/loaders/AGENTS.md OEngine/src/material/AGENTS.md OEngine/src/render/AGENTS.md OEngine/src/scene/AGENTS.md OEngine/src/shaders/AGENTS.md
git diff --cached --name-status
git commit -m "文档：迁移仓库路由与源码引用"
```

Expected: focused tests PASS. Remove any unrelated staged path before commit.

---

### Task 5: Delete historical documentation

**Files:**
- Modify: `OEngine/tests/documentation-system.test.mjs`
- Delete: `docs/CONTEXT.md`, `CURRENT-STATE.md`, `DIRECTION.md`, `TARGETS.md`, `RENDER-PIPELINE.md`, `ROADMAP.md`, `PERFORMANCE.md`, `BASELINE-ARTIFACTS.md`, `SHADER-SOURCES.md`
- Delete: `docs/contexts/`, `docs/implementation/`, `docs/references/`, `docs/wiki/`

**Interfaces:**
- Consumes: migrated content and references from Tasks 1–4.
- Produces: final docs plus temporary `docs/superpowers` execution material.

- [ ] **Step 1: Add failing final-allowlist and link tests**

Add `readdirSync` to the `node:fs` import, then add:

```js
const FINAL_DOCS = Object.freeze([
  "ARCHITECTURE.md", "PIPELINE.md", "PRODUCT.md", "README.md", "STATUS.md", "VALIDATION.md",
  "adr/0001-gpu-first-scope.md", "adr/0002-runtime-assets-and-gpu-driven.md",
  "adr/0003-unified-render-pipeline.md", "adr/README.md",
  "porting/geometry.md", "porting/platform.md", "porting/README.md",
  "porting/shading.md", "porting/visibility.md"
].sort());

function markdownFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (relative === "superpowers") return [];
      return markdownFiles(absolute, relative);
    }
    return entry.isFile() && entry.name.endsWith(".md") ? [relative] : [];
  });
}

test("docs tree matches the final internal allowlist", () => {
  assert.deepEqual(markdownFiles(docsRoot).sort(), FINAL_DOCS);
});

test("all final relative Markdown links resolve", () => {
  for (const relativePath of FINAL_DOCS) {
    const source = readDoc(relativePath);
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      const absolute = path.resolve(path.dirname(path.join(docsRoot, relativePath)), target);
      assert.equal(existsSync(absolute), true, `${relativePath} -> ${target}`);
    }
  }
});

test("final documentation avoids retired local routes", () => {
  const forbidden = [
    /docs[\\/]contexts[\\/]/,
    /docs[\\/]implementation[\\/]/,
    /docs[\\/]references[\\/]/,
    /docs[\\/]wiki[\\/]/,
    /docs[\\/](?:CONTEXT|CURRENT-STATE|DIRECTION|TARGETS|RENDER-PIPELINE|ROADMAP|PERFORMANCE|BASELINE-ARTIFACTS|SHADER-SOURCES)\.md/,
    /performance-targets\.json/,
    /`three\.js[\\/]/,
    /`webgpufundamentals[\\/]/,
    /examples[\\/](?:benchmark-[abc]|r[0-9]-|integrated-showcase|scripts)[\\/]/
  ];
  for (const relativePath of FINAL_DOCS) {
    const source = readDoc(relativePath);
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, relativePath);
  }
});
```

- [ ] **Step 2: Confirm allowlist failure is caused by legacy docs**

```powershell
Set-Location D:\code\EEngine\OEngine
node --test --test-name-pattern "final internal allowlist|relative Markdown links" tests/documentation-system.test.mjs
```

Expected: allowlist FAIL listing old files; link test PASS.

- [ ] **Step 3: Verify every deletion target stays inside docs**

```powershell
Set-Location D:\code\EEngine
$docsRoot = (Resolve-Path 'docs').Path
$targets = @(
  'docs/CONTEXT.md', 'docs/CURRENT-STATE.md', 'docs/DIRECTION.md',
  'docs/TARGETS.md', 'docs/RENDER-PIPELINE.md', 'docs/ROADMAP.md',
  'docs/PERFORMANCE.md', 'docs/BASELINE-ARTIFACTS.md', 'docs/SHADER-SOURCES.md',
  'docs/contexts', 'docs/implementation', 'docs/references', 'docs/wiki'
)
foreach ($target in $targets) {
  $resolved = (Resolve-Path -LiteralPath $target).Path
  if (-not $resolved.StartsWith($docsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Deletion target escaped docs: $resolved"
  }
  Write-Output $resolved
}
```

Expected: all paths begin with `D:\code\EEngine\docs\`.

- [ ] **Step 4: Delete only verified historical targets**

```powershell
git rm -- docs/CONTEXT.md docs/CURRENT-STATE.md docs/DIRECTION.md docs/TARGETS.md docs/RENDER-PIPELINE.md docs/ROADMAP.md docs/PERFORMANCE.md docs/BASELINE-ARTIFACTS.md docs/SHADER-SOURCES.md
git rm -r -- docs/contexts docs/implementation docs/references docs/wiki
```

Keep `docs/superpowers` until Task 7.

- [ ] **Step 5: Verify references and commit deletion**

```powershell
Set-Location D:\code\EEngine\OEngine
node --test tests/documentation-system.test.mjs
Set-Location D:\code\EEngine
rg -n 'docs/(contexts|implementation|references|wiki)/|docs/(CONTEXT|CURRENT-STATE|DIRECTION|TARGETS|RENDER-PIPELINE|ROADMAP|PERFORMANCE|BASELINE-ARTIFACTS|SHADER-SOURCES)\.md|performance-targets\.json|`three\.js/|`webgpufundamentals/|examples/(benchmark-[abc]|r[0-9]-|integrated-showcase|scripts/)' AGENTS.md CONTEXT-MAP.md docs OEngine examples -g '*.md' -g '*.ts' -g '*.mjs' -g 'AGENTS.md'
git add -- OEngine/tests/documentation-system.test.mjs
git diff --cached --stat
git commit -m "文档：删除历史阶段与失效参考树"
```

Expected: tests PASS, `rg` has no deleted-local-path matches, staged diff contains only intended docs/test changes.

---

### Task 6: Run full repository verification

**Files:**
- Modify only if a stale documentation reference is exposed: final docs, AGENTS, documentation/provenance tests, three source comments, benchmark/example README.
- Do not modify rendering implementation to make documentation checks pass.

**Interfaces:**
- Consumes: migrated docs tree.
- Produces: green library/tests, deterministic shader audit and green Rendering Lab builds.

- [ ] **Step 1: Verify shader audit**

```powershell
Set-Location D:\code\EEngine\OEngine
npm run audit:shaders
git diff -- benchmarks/shader-source-audit.json
```

Expected: success and no unexpected JSON difference.

- [ ] **Step 2: Run all OEngine tests**

```powershell
npm test
```

Expected: build, declaration build and all Node tests PASS.

- [ ] **Step 3: Build Rendering Lab and Storybook**

```powershell
Set-Location D:\code\EEngine\examples
yarn build
yarn build:storybook
```

Expected: both builds PASS with the retained Rendering Lab story.

- [ ] **Step 4: Verify count and line budgets**

```powershell
Set-Location D:\code\EEngine
$docs = Get-ChildItem docs -Recurse -File -Filter '*.md' | Where-Object { $_.FullName -notmatch '[\\/]superpowers[\\/]' }
$core = Get-ChildItem docs -File -Filter '*.md'
Write-Output "DOCS=$($docs.Count)"
Write-Output "CORE_LINES=$(($core | Get-Content -Encoding UTF8 | Measure-Object -Line).Lines)"
$docs | ForEach-Object {
  [PSCustomObject]@{ Path=$_.FullName; Lines=(Get-Content -Encoding UTF8 -LiteralPath $_.FullName).Count }
} | Sort-Object Lines -Descending | Format-Table -AutoSize
```

Expected: `DOCS=15`, core total 1500–2200 lines, no final file over 500 lines.

- [ ] **Step 5: Inspect and clean only known verification side effects**

```powershell
git status --short
git diff --check
```

Expected: no lockfile, generated site output or unrelated source changes. Inspect before restoring any previously clean tracked file.

- [ ] **Step 6: Commit only scoped verification fallout if needed**

If Steps 1–5 required corrections, stage exact files, inspect `git diff --cached --name-status`, and commit:

```powershell
git commit -m "文档：修正精简后的验证与引用"
```

If no correction was needed, do not create an empty commit.

---

### Task 7: Remove temporary execution material and close the allowlist

**Files:**
- Modify: `OEngine/tests/documentation-system.test.mjs`
- Delete: `docs/superpowers/specs/2026-09-04-doc-system-simplification-design.md`
- Delete: `docs/superpowers/plans/2026-09-04-doc-system-simplification.md`

**Interfaces:**
- Consumes: completed verified migration.
- Produces: exactly 15 Markdown files under `docs/`.

- [ ] **Step 1: Stop excluding `docs/superpowers` from the allowlist**

Delete this transition-only line from `markdownFiles()`:

```js
if (relative === "superpowers") return [];
```

- [ ] **Step 2: Confirm the allowlist fails only on the temporary spec and plan**

```powershell
Set-Location D:\code\EEngine\OEngine
node --test --test-name-pattern "final internal allowlist" tests/documentation-system.test.mjs
```

Expected: FAIL; actual-minus-expected contains only the two temporary documents.

- [ ] **Step 3: Verify and delete the temporary directory**

```powershell
Set-Location D:\code\EEngine
$docsRoot = (Resolve-Path 'docs').Path
$temporary = (Resolve-Path 'docs/superpowers').Path
if (-not $temporary.StartsWith($docsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Temporary target escaped docs: $temporary"
}
git rm -r -- docs/superpowers
```

- [ ] **Step 4: Run final tests and commit**

```powershell
Set-Location D:\code\EEngine\OEngine
node --test tests/documentation-system.test.mjs
npm test
Set-Location D:\code\EEngine
git add -- OEngine/tests/documentation-system.test.mjs
git commit -m "文档：完成内部文档系统瘦身"
```

Expected: documentation and full tests PASS; the final commit removes both temporary documents.

- [ ] **Step 5: Report final evidence**

```powershell
git status --short --branch
git log -7 --oneline
(Get-ChildItem docs -Recurse -File -Filter '*.md').Count
```

Expected: clean worktree, only intended commits ahead of origin, final count `15`.
