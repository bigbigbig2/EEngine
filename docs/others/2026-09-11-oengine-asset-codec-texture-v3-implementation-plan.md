# OEngine Asset Codec & GPU-Native Texture Pipeline V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OEngine's production self-authored texture codec path with an open-source Worker/WASM asset-codec layer, then make GPU-native compressed textures flow through the normal `GpuRenderWorld → TextureResidency → GpuMaterialStore` production path with zero runtime mip generation for cooked assets.

**Architecture:** Add a small `AssetCodecService` and bounded `AssetWorkerPool` under `OEngine/src/assets/codec/`, using Three.js/Babylon.js as Web integration references and direct codec upstream binaries as algorithm authority. Keep GPU ownership on the main thread, refactor `TextureAssetPackage.ts` into an encoded-variant/package layer, then evolve `TextureResidency.ts` from RGBA-only banks to format-aware bounded `TextureBindingSet`s.

**Tech Stack:** TypeScript 5.8, Web Workers, WebAssembly, WebGPU 2026, Basis Universal/KTX2 upstream codec assets, existing `RuntimeAssetManifestV2`, existing `RuntimeAssetResidency`, existing validation tools and Rendering Lab.

**Spec:** `docs/superpowers/specs/2026-09-11-oengine-asset-codec-texture-v3-design.md`

## Global Constraints

- Production OEngine code MUST NOT implement BC/ASTC/ETC/Basis compression algorithms.
- Three.js/Babylon.js are integration references; codec binaries/modules come from pinned original upstream revisions.
- GPU-ready compressed texture data bypasses Worker/WASM and uploads directly.
- Heavy KTX2/Basis ingest uses Worker + WASM and Transferable `ArrayBuffer`.
- Workers never own `GPUDevice`, `GPUTexture`, `TextureResidency`, or `GpuMaterialStore`.
- Ordinary cooked textures must reach `runtimeMipGenerationCount = 0`.
- Runtime GPU identity remains `TextureHandle` slot+generation; physical placement remains derived residency state.
- Worker concurrency is bounded by worker count AND estimated in-flight codec memory.
- SharedArrayBuffer is not part of the first implementation.
- No Virtual Texturing, bindless abstraction, or second Renderer architecture in this plan.
- Follow existing DEV / MILESTONE / PERF validation policy.
- Do not run `npm ci` unless dependency/lockfile changes or formal clean reproduction requires it.

---

# File Structure Locked by This Plan

## New source files

```text
OEngine/src/assets/codec/
├─ AssetCodecTypes.ts
├─ AssetWorkerPool.ts
├─ AssetCodecService.ts
├─ AssetCodecPlanner.ts
├─ TextureCodecPolicy.ts
├─ Ktx2BasisCodec.ts
├─ ReferenceTextureCodec.ts
├─ vendor/
│  └─ basis/
│     ├─ basis_transcoder.js
│     ├─ basis_transcoder.wasm
│     └─ LICENSE
└─ workers/
   └─ asset-codec-worker.ts
```

Responsibilities:

```text
AssetCodecTypes.ts
→ worker-safe task/result/evidence types

AssetWorkerPool.ts
→ worker lifecycle, priority queue, memory budget, transferable dispatch

AssetCodecService.ts
→ public CPU-heavy codec orchestration API

AssetCodecPlanner.ts
→ maps source/capability/semantic to execution plan

TextureCodecPolicy.ts
→ GPU target format policy

Ktx2BasisCodec.ts
→ main-thread Basis/KTX2 adapter

ReferenceTextureCodec.ts
→ test/reference-only encoder and deterministic tiny fixture helper

workers/asset-codec-worker.ts
→ worker runtime, upstream WASM init, codec task execution
```

## Existing files expected to change

```text
OEngine/src/assets/TextureAssetPackage.ts
OEngine/src/assets/RuntimeAssetManifestV2.ts     only if encoded metadata needs a new stable field
OEngine/src/gpu/TextureResidency.ts
OEngine/src/gpu/GpuTextureRefAbi.ts
OEngine/src/gpu/TextureHandleAbi.ts
OEngine/src/gpu/GpuPackedMaterialBindings.ts
OEngine/src/gpu/GpuMaterialStore.ts
OEngine/src/gpu/GpuRenderWorld.ts
OEngine/src/gpu/GraphicsContext.ts
OEngine/src/index.ts                             only if codec configuration is public
OEngine/tests/runtime-asset-v2.test.mjs
OEngine/tests/packed-render-world-contract.test.mjs
OEngine/tests/documentation-system.test.mjs
examples/validation-tools/cases.mjs             only if compressed scenario is absent
docs/adr/0007-*.md
docs/ARCHITECTURE.md
docs/STATUS.md
docs/porting/platform.md
```

## New test file

```text
OEngine/tests/asset-codec-service.test.mjs
```

Do not create more codec unit-test files unless an independent contract justifies a separate reviewer gate.

---

### Task 1: Freeze Upstream Provenance and ADR-0007 Production Codec Rule

**Files:**
- Modify: `docs/porting/platform.md`
- Modify: `docs/adr/0007-*.md`
- Modify: `OEngine/tests/documentation-system.test.mjs`

**Interfaces:**
- Consumes: existing porting ledger format.
- Produces: authoritative upstream/provenance rules used by every later task.

- [ ] **Step 1: Add failing documentation assertions**

Extend `documentation-system.test.mjs` so it requires stable markers for:

```text
Three.js KTX2Loader / WorkerPool integration reference
Babylon.js KTX2 / worker integration reference
Basis Universal codec upstream
```

Also assert ADR-0007 contains:

```text
Production texture compression/transcoding must not depend on an OEngine-authored block codec.
```

- [ ] **Step 2: Verify failure**

```powershell
Set-Location OEngine
npm run build:test
node --test tests/documentation-system.test.mjs
```

Expected: FAIL because markers are not yet present.

- [ ] **Step 3: Add provenance records**

Record exact upstream repository, exact revision, reference source files, license, adoption state, retained invariants, OEngine differences, and local validation.

Role split:

```text
Three.js
Adoption: specification/reference reimplementation
Purpose: WorkerPool, KTX2Loader Worker/WASM/Transferable integration

Babylon.js
Adoption: specification/reference reimplementation
Purpose: worker lifecycle, configurable pool, transcode decision tree

Basis Universal
Adoption: direct pinned codec dependency/binary
Purpose: KTX2/Basis transcode algorithm
```

- [ ] **Step 4: Update ADR-0007 texture migration steps**

Use:

```text
Step 2A Asset Codec Backend Contract
Step 2B Worker/WASM KTX2/Basis Production Path
Step 2C GPU-native Texture Variant Policy
Step 2D Remove OEngine-authored Production Codec
Step 3  Multi-format Texture Residency + TextureBindingSet
```

- [ ] **Step 5: Re-run documentation test**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/porting/platform.md docs/adr OEngine/tests/documentation-system.test.mjs
git commit -m "docs(asset): freeze codec provenance and ADR-0007 rules"
```

---

### Task 2: Add Worker-Safe Asset Codec Contracts

**Files:**
- Create: `OEngine/src/assets/codec/AssetCodecTypes.ts`
- Create: `OEngine/tests/asset-codec-service.test.mjs`

**Interfaces:**
- Produces:

```ts
export type AssetCodecTaskKind =
  | "ktx2-transcode"
  | "draco-decode"
  | "meshopt-decode"
  | "zstd-decode";

export type AssetCodecPriority = 0 | 1 | 2;

export interface AssetCodecTaskBase {
  readonly taskId: number;
  readonly kind: AssetCodecTaskKind;
  readonly priority: AssetCodecPriority;
  readonly estimatedPeakBytes: number;
}

export interface Ktx2TranscodeTask extends AssetCodecTaskBase {
  readonly kind: "ktx2-transcode";
  readonly input: ArrayBuffer;
  readonly semantic: import("../TextureAssetPackage.js").TextureSemanticV2;
  readonly targetFormat: GPUTextureFormat;
}

export interface AssetCodecEvidence {
  readonly queueWaitMs: number;
  readonly workerMs: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly estimatedPeakBytes: number;
  readonly codecId: string;
  readonly codecRevision: string;
}

export interface AssetCodecTaskResult {
  readonly taskId: number;
  readonly ok: true;
  readonly output: readonly ArrayBuffer[];
  readonly evidence: AssetCodecEvidence;
}

export interface AssetCodecErrorResult {
  readonly taskId: number;
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}
```

- [ ] **Step 1: Write failing contract tests**

Use this valid request:

```ts
{
  taskId: 1,
  kind: "ktx2-transcode",
  priority: 0,
  estimatedPeakBytes: 16 * 1024 * 1024,
  semantic: "base-color-srgb",
  targetFormat: "bc7-rgba-unorm-srgb",
  input: new ArrayBuffer(1024)
}
```

Assert validator rejects:
- taskId < 0,
- invalid priority,
- estimated peak <= 0 for non-empty work,
- unsupported kind,
- target format outside codec policy.

- [ ] **Step 2: Verify failure**

```powershell
npm run build:test
node --test tests/asset-codec-service.test.mjs
```

- [ ] **Step 3: Implement types and `validateAssetCodecTask()`**

No GPU object types in request/result protocol except scalar `GPUTextureFormat`.

- [ ] **Step 4: Re-run test**

Expected: PASS.

- [ ] **Step 5: Typecheck**

```powershell
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add OEngine/src/assets/codec/AssetCodecTypes.ts OEngine/tests/asset-codec-service.test.mjs
git commit -m "feat(asset): add worker-safe codec contracts"
```

---

### Task 3: Implement Bounded AssetWorkerPool

**Files:**
- Create: `OEngine/src/assets/codec/AssetWorkerPool.ts`
- Modify: `OEngine/tests/asset-codec-service.test.mjs`

**Interfaces:**

```ts
export interface AssetWorkerPoolOptions {
  readonly maxWorkers: number;
  readonly maxInFlightEstimatedBytes: number;
  readonly createWorker: () => Worker;
}

export interface AssetWorkerTask<TRequest, TResult> {
  readonly request: TRequest;
  readonly transfer: readonly Transferable[];
  readonly estimatedPeakBytes: number;
  readonly priority: AssetCodecPriority;
}

export class AssetWorkerPool {
  submit<TRequest, TResult>(task: AssetWorkerTask<TRequest, TResult>): Promise<TResult>;
  dispose(): void;
}
```

- [ ] **Step 1: Add failing scheduler tests with fake Workers**

Verify:
1. priority 0 beats queued priority 1,
2. same priority is FIFO,
3. `maxWorkers=2` never runs 3 tasks,
4. `maxInFlightEstimatedBytes=100` prevents two estimated-60 tasks overlapping,
5. success releases memory reservation,
6. worker error releases memory reservation,
7. `dispose()` rejects queued work and terminates workers,
8. transfer list reaches `postMessage()` unchanged.

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement three FIFO queues and memory admission**

Required state:

```ts
private activeWorkers = 0;
private inFlightEstimatedBytes = 0;
private disposed = false;
```

No `SharedArrayBuffer`.

- [ ] **Step 4: Re-run tests and typecheck**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add OEngine/src/assets/codec/AssetWorkerPool.ts OEngine/tests/asset-codec-service.test.mjs
git commit -m "feat(asset): add bounded codec worker pool"
```

---

### Task 4: Add AssetCodecService Lifecycle and Evidence

**Files:**
- Create: `OEngine/src/assets/codec/AssetCodecService.ts`
- Modify: `OEngine/src/gpu/GraphicsContext.ts`
- Modify: `OEngine/tests/asset-codec-service.test.mjs`

**Interfaces:**

```ts
export interface AssetCodecServiceOptions {
  readonly maxWorkers?: number;
  readonly maxInFlightEstimatedBytes?: number;
  readonly createWorker: () => Worker;
}

export interface AssetCodecServiceEvidence {
  readonly tasksQueued: number;
  readonly tasksCompleted: number;
  readonly tasksFailed: number;
  readonly tasksCancelled: number;
  readonly peakActiveWorkers: number;
  readonly peakInFlightEstimatedBytes: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
}

export class AssetCodecService {
  submit(task: Ktx2TranscodeTask): Promise<AssetCodecTaskResult>;
  evidence(): AssetCodecServiceEvidence;
  destroy(): void;
}
```

- [ ] **Step 1: Add failing lifecycle tests**

Verify:
- default workers = `clamp(floor(hardwareConcurrency * 0.5), 1, 4)`,
- explicit option overrides count,
- no Worker constructed before first task,
- evidence changes once per task,
- destroy is idempotent.

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement lazy service lifecycle**

`GraphicsContext` owns:

```ts
readonly asset_codecs: AssetCodecService | null;
```

`GpuRenderWorld` must not instantiate codec services.

- [ ] **Step 4: Run tests/typecheck**

- [ ] **Step 5: Commit**

```bash
git add OEngine/src/assets/codec/AssetCodecService.ts OEngine/src/gpu/GraphicsContext.ts OEngine/tests/asset-codec-service.test.mjs
git commit -m "feat(asset): own runtime codec service in graphics context"
```

---

### Task 5: Add Texture Codec Policy and Planner

**Files:**
- Create: `OEngine/src/assets/codec/TextureCodecPolicy.ts`
- Create: `OEngine/src/assets/codec/AssetCodecPlanner.ts`
- Modify: `OEngine/tests/asset-codec-service.test.mjs`

**Interfaces:**

```ts
export type TextureDecodePlan =
  | {
      readonly mode: "direct";
      readonly variantId: string;
      readonly targetFormat: GPUTextureFormat;
    }
  | {
      readonly mode: "worker-transcode";
      readonly variantId: string;
      readonly sourceEncoding: "ktx2-uastc" | "ktx2-etc1s";
      readonly targetFormat: GPUTextureFormat;
    }
  | {
      readonly mode: "uncompressed";
      readonly variantId: string;
      readonly targetFormat: "rgba8unorm" | "rgba8unorm-srgb";
    };
```

- [ ] **Step 1: Add failing policy tests**

Cases:
- BC + base color → BC7 sRGB,
- BC + normal → BC5,
- BC + scalar → BC4,
- BC + HDR → BC6H UFLOAT,
- no BC + ASTC + base color → configured ASTC sRGB target,
- no BC + ETC2/EAC + normal → EAC RG target,
- direct compatible variant beats worker transcode,
- worker transcode beats uncompressed fallback,
- uncompressed only when explicitly present/allowed.

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement pure policy**

No access to `navigator` or renderer globals. Inputs are capability record + asset metadata.

A requested target is selectable only when both are true:

```text
WebGPU device capability permits the GPU format
+
the pinned Basis/KTX2 transcoder declares/supports that exact target
```

If Basis cannot produce the semantic-preferred target (for example a particular BC/EAC/HDR target), select the next policy-approved target instead of adding an OEngine-authored conversion algorithm.

- [ ] **Step 4: Re-run tests**

- [ ] **Step 5: Commit**

```bash
git add OEngine/src/assets/codec/TextureCodecPolicy.ts OEngine/src/assets/codec/AssetCodecPlanner.ts OEngine/tests/asset-codec-service.test.mjs
git commit -m "feat(texture): add WebGPU compression decode policy"
```

---

### Task 6: Integrate Pinned Basis/KTX2 WASM Worker Backend

**Files:**
- Create: `OEngine/src/assets/codec/Ktx2BasisCodec.ts`
- Create: `OEngine/src/assets/codec/workers/asset-codec-worker.ts`
- Modify: `docs/porting/platform.md`
- Modify: `OEngine/tests/asset-codec-service.test.mjs`

**Interfaces:**
- Consumes `Ktx2TranscodeTask`.
- Produces mip block payloads + codec evidence, never GPU objects.

- [ ] **Step 1: Pin exact Basis Universal upstream revision**

Record in porting ledger:
- revision/tag,
- binary/source artifact,
- build flags,
- license,
- binary hash.

Use upstream Basis assets, not opaque copies from Three.js/Babylon.js.

- [ ] **Step 2: Add a tiny deterministic UASTC KTX2 fixture**

Use 4×4 or 8×8 source with known color pattern.

- [ ] **Step 3: Add failing integration test**

Request BC7 output.

Assert:
- result is successful,
- output block bytes match BC7 block-size expectations,
- codec id/revision populated,
- input appears in transfer list.

- [ ] **Step 4: Implement Worker init protocol**

```ts
{ type: "init", codecId, codecRevision, wasmBinary }
{ type: "task", task }
{ type: "dispose" }
```

Initialize once per worker.

- [ ] **Step 5: Implement `Ktx2BasisCodec` adapter**

Responsibilities:
- prepare task,
- transfer input,
- normalize mip/result metadata,
- return evidence.

No GPU resource creation.

- [ ] **Step 6: Run codec tests/typecheck**

- [ ] **Step 7: Commit**

```bash
git add OEngine/src/assets/codec OEngine/tests docs/porting/platform.md
git commit -m "feat(texture): add Basis KTX2 Worker WASM transcoder"
```

---

### Task 7: Refactor TextureAssetPackage into Encoded-Variant Packaging

**Files:**
- Modify: `OEngine/src/assets/TextureAssetPackage.ts`
- Create: `OEngine/src/assets/codec/ReferenceTextureCodec.ts`
- Modify: `OEngine/tests/runtime-asset-v2.test.mjs`
- Modify: `OEngine/tests/documentation-system.test.mjs`

**Interfaces:**

```ts
export interface EncodedTextureMipV2 {
  readonly level: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly physicalWidth: number;
  readonly physicalHeight: number;
  readonly payload: Uint8Array;
}

export interface EncodedTextureVariantV2 {
  readonly profile: string;
  readonly semantic: TextureSemanticV2;
  readonly format: GPUTextureFormat;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly bytesPerBlock: number;
  readonly codecId: string;
  readonly codecRevision: string;
  readonly mips: readonly EncodedTextureMipV2[];
}

export async function writeEncodedTextureAssetPackageV2(
  source: TextureCookSourceV2,
  variants: readonly EncodedTextureVariantV2[]
): Promise<ArrayBuffer>;
```

- [ ] **Step 1: Add failing package tests**

Verify:
- BC7 encoded variant serializes/opens/selects with no encoder call,
- codec provenance round-trips,
- physical/logical extents round-trip,
- invalid block byte length rejected,
- complete mip chain required for cooked variant.

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Move current self-authored helpers**

Move current simple:
- block encoder,
- deterministic tiny mip helper,

to `ReferenceTextureCodec.ts`.

Add module comment:

```text
Test/reference only. Production source files must not import this module.
```

- [ ] **Step 4: Refactor production package writer**

`TextureAssetPackage.ts` validates and serializes encoded variants only.

It no longer computes BC endpoints, mip filters, or alpha scaling.

- [ ] **Step 5: Add source-graph assertion**

`documentation-system.test.mjs` scans production asset/gpu imports and fails if `ReferenceTextureCodec` is imported outside tests/reference code.

- [ ] **Step 6: Run tests/typecheck**

- [ ] **Step 7: Commit**

```bash
git add OEngine/src/assets OEngine/tests
git commit -m "refactor(texture): remove production self-authored codec"
```

---

### Task 8: Make Texture Residency Format-Aware

**Files:**
- Modify: `OEngine/src/gpu/TextureResidency.ts`
- Modify: `OEngine/src/gpu/TextureHandleAbi.ts`
- Modify: `OEngine/src/gpu/GpuTextureRefAbi.ts`
- Modify: `OEngine/tests/packed-render-world-contract.test.mjs`

**Interfaces:**

Replace the RGBA-only physical classification:

```ts
formatClass: "rgba8";
```

with exact physical-format identity:

```ts
export interface TextureResidencyDescriptor {
  readonly slot: number;
  readonly generation: number;
  readonly format: GPUTextureFormat;
  readonly formatClass: GPUTextureFormat;
  readonly sizeClass: number;
  readonly segment: number;
  // existing logical size / layer / mip metadata stays explicit
}
```

Phase 1 deliberately uses exact `GPUTextureFormat` as the class key. `astc-4x4-unorm-srgb` and `astc-6x6-unorm-srgb`, or `bc7-rgba-unorm` and `bc7-rgba-unorm-srgb`, are different physical classes.

`TextureHandle` remains slot+generation only.

- [ ] **Step 1: Add failing descriptor/accounting tests**

Verify:
- handle identity independent from physical format,
- stale generation rejection unchanged,
- block-compressed memory accounting uses block dimensions/bytes,
- abort does not publish new descriptor.

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement format-aware descriptors**

No material binding changes yet.

- [ ] **Step 4: Remove RGBA8-only byte assumptions**

Compute bytes from block metadata.

- [ ] **Step 5: Run tests/typecheck**

- [ ] **Step 6: Commit**

```bash
git add OEngine/src/gpu/TextureResidency.ts OEngine/src/gpu/TextureHandleAbi.ts OEngine/src/gpu/GpuTextureRefAbi.ts OEngine/tests/packed-render-world-contract.test.mjs
git commit -m "refactor(texture): make residency format aware"
```

---

### Task 9: Introduce Bounded TextureBindingSet

**Files:**
- Modify: `OEngine/src/gpu/TextureResidency.ts`
- Modify: `OEngine/src/gpu/GpuPackedMaterialBindings.ts`
- Modify: `OEngine/src/gpu/GpuMaterialStore.ts`
- Modify: `OEngine/tests/packed-render-world-contract.test.mjs`

**Interfaces:**

```ts
export interface TextureBindingSet {
  readonly id: number;
  readonly textureViews: readonly GPUTextureView[];
  readonly bankDescriptors: readonly {
    readonly bindingSlot: number;
    readonly formatClass: GPUTextureFormat;
    readonly sizeClass: number;
    readonly segment: number;
  }[];
}

export interface TextureResidencyStage {
  readonly bindingSets: readonly TextureBindingSet[];
  readonly materialBindingSetIds: ReadonlyMap<StandardShadeMaterial, number>;
  readonly textureRefs: ReadonlyMap<ShadeTexture, number>;
  readonly textureRoutingRefs: ReadonlyMap<ShadeTexture, number>;
}
```

- [ ] **Step 1: Add failing preflight tests**

Cases:
- one material fits one set,
- a material requiring two sets fails before publication,
- different materials may use different sets,
- aborted stage publishes neither handles nor set assignment,
- retired set resources wait for GPU completion.

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement bounded set planner**

Use actual device sampled-texture/binding limits.

Do not introduce bindless/sized binding arrays.

- [ ] **Step 4: Extend GpuMaterialStore contract**

Encode/associate `TextureBindingSetId` with material runtime data.

If current resolve path cannot consume multiple sets in one draw, group resolve work by set while keeping stable texture/material identity.

- [ ] **Step 5: Run tests/typecheck**

- [ ] **Step 6: Commit**

```bash
git add OEngine/src/gpu OEngine/tests/packed-render-world-contract.test.mjs
git commit -m "feat(texture): add bounded texture binding sets"
```

---

### Task 10: Add Direct GPU-Native Texture Upload Path

**Files:**
- Modify: `OEngine/src/gpu/TextureResidency.ts`
- Modify: `OEngine/src/assets/TextureAssetPackage.ts`
- Modify: `OEngine/tests/runtime-asset-v2.test.mjs`
- Modify: `OEngine/tests/packed-render-world-contract.test.mjs`

**Interfaces:**
- Consumes selected `EncodedTextureVariantV2`.
- Publishes ordinary stable texture handle without resize/recompress/mip generation.

- [ ] **Step 1: Add failing direct-path test**

Use `ReferenceTextureCodec` only inside test setup.

Assert:
- physical format is compressed,
- `runtimeMipGenerationCount` delta is 0,
- `resizeDispatchCount` delta is 0,
- `transcodeBytes` is 0,
- stable handle resolves after commit,
- abort publishes no descriptor.

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement direct block upload**

Create texture using encoded GPU format and full mip count.

Respect compressed texture row/block alignment.

Never decode to RGBA.

- [ ] **Step 4: Keep legacy uncooked path explicitly classified**

Legacy `ShadeTexture` can remain during migration, but its evidence must remain distinguishable from cooked compressed path.

- [ ] **Step 5: Run tests**

- [ ] **Step 6: Commit**

```bash
git add OEngine/src/gpu/TextureResidency.ts OEngine/src/assets/TextureAssetPackage.ts OEngine/tests
git commit -m "feat(texture): upload GPU-native compressed assets directly"
```

---

### Task 11: Normalize Worker/WASM Transcode Output into the Same Residency Path

**Files:**
- Modify: `OEngine/src/assets/codec/Ktx2BasisCodec.ts`
- Modify: `OEngine/src/gpu/TextureResidency.ts`
- Modify: `OEngine/tests/asset-codec-service.test.mjs`
- Modify: `OEngine/tests/packed-render-world-contract.test.mjs`

**Interfaces:**
- Worker output becomes the same encoded-variant shape consumed by Task 10.

- [ ] **Step 1: Add failing end-to-end CPU/GPU-owner contract test**

Flow:

```text
UASTC KTX2
→ AssetCodecService
→ Worker/WASM
→ normalized BC7 encoded result
→ TextureResidency reserve/upload/commit
```

Assert:
- `transcodeBytes > 0`,
- target physical format is BC7,
- runtime mip delta = 0,
- codec revision evidence present,
- handle publishes only after command finish.

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement result adapter**

Do not create `WasmTextureResidency`.

Direct and Worker output call the same compressed upload helper.

- [ ] **Step 4: Add abort case**

Worker finishes, GPU stage aborts.

Assert:
- no published handle,
- GPU allocation destroyed/retired,
- codec memory reservation already released.

- [ ] **Step 5: Re-run tests**

- [ ] **Step 6: Commit**

```bash
git add OEngine/src/assets/codec OEngine/src/gpu/TextureResidency.ts OEngine/tests
git commit -m "feat(texture): connect Worker WASM transcode to residency"
```

---

### Task 12: Cut Normal GpuRenderWorld Registration to Compressed Residency

**Files:**
- Modify: `OEngine/src/gpu/GpuRenderWorld.ts`
- Modify: `OEngine/src/gpu/GpuMaterialStore.ts`
- Modify: `OEngine/src/gpu/GpuPackedMaterialBindings.ts`
- Modify: `OEngine/tests/packed-render-world-contract.test.mjs`

**Interfaces:**
- Owner order remains:
  1. texture residency,
  2. material store,
  3. GPU scene.
- `GpuRenderWorld.ts` cannot import Basis/Worker implementation.

- [ ] **Step 1: Add failing normal-production test**

Create material dictionary backed by encoded TextureAsset variants.

Call standard `GpuRenderWorld.stage()`.

Assert:
- compressed variant selected,
- material receives texture routing and binding-set identity,
- `materialResources` valid,
- no private submit,
- no runtime mip generation.

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Add minimal source-to-runtime texture association**

If `ShadeTexture` currently only identifies source image, add association in import/residency layer.

Do not add codec-specific fields to `StandardShadeMaterial`.

- [ ] **Step 4: Verify ordinary and packed scene convergence**

Both paths must use same texture/material ownership.

- [ ] **Step 5: Run targeted tests**

```powershell
npm run build:test
node --test tests/packed-render-world-contract.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add OEngine/src/gpu OEngine/tests/packed-render-world-contract.test.mjs
git commit -m "refactor(texture): cut render world to compressed residency"
```

---

### Task 13: Add or Extend Browser Case `surface.texture-compressed`

**Files:**
- Modify: `examples/validation-tools/cases.mjs`
- Modify: existing Surface validation source that owns texture cases
- Modify: `docs/VALIDATION.md` only if changed-domain routing needs a stable new name

**Interfaces:**
- Must exercise normal Renderer path, not isolated upload helper only.

- [ ] **Step 1: Register/extend one compressed scenario**

Representative content:
- BC7 BaseColor,
- BC5 normal,
- at least two mips,
- ordinary material path.

- [ ] **Step 2: Assert direct path**

Require:
- physical compressed formats,
- finite expected material result,
- `runtimeMipGenerationCount = 0`,
- `transcodeBytes = 0`,
- zero browser/GPU validation errors.

- [ ] **Step 3: Run DEV case**

```powershell
Set-Location examples
npm run verify -- surface.texture-compressed
```

Expected: PASS.

- [ ] **Step 4: Add worker-transcode mode inside same scenario**

Use KTX2/Basis input.

Assert:
- Worker path used,
- same visible/material contract,
- selected physical format matches policy.

Do not add a second fixture.

- [ ] **Step 5: Re-run**

- [ ] **Step 6: Commit**

```bash
git add examples docs/VALIDATION.md
git commit -m "test(texture): validate compressed production paths in Chrome"
```

---

### Task 14: Eliminate Runtime Mip Generation for Cooked Textures

**Files:**
- Modify: `OEngine/src/gpu/TextureResidency.ts`
- Modify: `OEngine/tests/packed-render-world-contract.test.mjs`

**Interfaces:**
- Cooked texture requires complete mip chain.
- Uncooked/dev path remains explicit until separately retired.

- [ ] **Step 1: Add failing invariants**

Cooked registration:

```text
runtimeMipGenerationCount delta == 0
resizeDispatchCount delta == 0
```

Incomplete cooked mip chain:

```text
registration fails before publish
```

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Separate cooked vs uncooked branches**

Cooked path skips:

```ts
graphics.textures.mipmaps.generateMipmap(...)
```

and skips resize when encoded payload already matches target metadata.

- [ ] **Step 4: Re-run tests/browser case**

- [ ] **Step 5: Commit**

```bash
git add OEngine/src/gpu/TextureResidency.ts OEngine/tests
git commit -m "perf(texture): eliminate runtime mip work for cooked assets"
```

---

### Task 15: Add Codec and Compressed-Residency Evidence

**Files:**
- Modify: existing profiling/evidence owners under `OEngine/src/debug/profiling/`
- Modify: `OEngine/src/assets/codec/AssetCodecService.ts`
- Modify: `OEngine/src/gpu/TextureResidency.ts`
- Modify: Rendering Lab evidence collection

**Interfaces:**

Stable fields:

```text
codec.tasksQueued
codec.tasksCompleted
codec.tasksFailed
codec.peakActiveWorkers
codec.peakInFlightBytes
codec.queueWaitMs
codec.workerMs
codec.inputBytes
codec.outputBytes

texture.directCompressedCount
texture.workerTranscodeCount
texture.uncompressedFallbackCount
texture.runtimeMipGenerationCount
texture.uploadBytes
texture.residentBytes
texture.bindingSetCount
texture.bindingSlotUtilization
```

- [ ] **Step 1: Add failing evidence-schema test**

Verify fields always exist and reset/accumulate under current profiler semantics.

- [ ] **Step 2: Implement evidence plumbing**

No GPU readback solely for CPU codec counters.

- [ ] **Step 3: Run targeted tests**

- [ ] **Step 4: Run short profile**

```powershell
Set-Location examples
npm run profile:rendering-lab:dev
```

Capture direct cooked and Worker-transcode load evidence.

- [ ] **Step 5: Commit**

```bash
git add OEngine/src examples OEngine/tests
git commit -m "perf(asset): expose codec and compressed residency evidence"
```

---

### Task 16: Milestone Validation and Delete Production Self-Codec Use

**Files:**
- Modify: `OEngine/src/assets/TextureAssetPackage.ts`
- Modify: `OEngine/src/assets/codec/ReferenceTextureCodec.ts`
- Modify: `docs/STATUS.md`

**Interfaces:**
- Runtime production graph contains no import of reference codec.

- [ ] **Step 1: Run OEngine milestone test**

```powershell
Set-Location OEngine
npm test
```

Expected: PASS.

- [ ] **Step 2: Run browser cases**

```powershell
Set-Location ../examples
npm run verify -- surface.texture-compressed
npm run verify -- surface.texture-ref-oracle
npm run verify -- lifecycle.device-loss-recreate
```

Expected: PASS.

- [ ] **Step 3: Run short performance smoke**

```powershell
npm run profile:rendering-lab:dev
```

Evidence must show for cooked path:
- runtime mip eliminated,
- lower upload/resident bytes than representative RGBA,
- no new private submit.

- [ ] **Step 4: Remove remaining production imports of self codec**

`ReferenceTextureCodec.ts` remains only for tests/reference.

- [ ] **Step 5: Update STATUS**

Record exact current state and remaining non-blocking items.

- [ ] **Step 6: Commit**

```bash
git add OEngine examples docs/STATUS.md
git commit -m "refactor(texture): close production codec migration"
```

---

### Task 17: Close Abort, Worker Failure, and Device-Loss Semantics

**Files:**
- Modify: `OEngine/src/gpu/TextureResidency.ts`
- Modify: `OEngine/src/assets/codec/AssetCodecService.ts`
- Modify: lifecycle browser validation

**Interfaces:**
- Codec CPU lifecycle independent from GPU residency lifecycle.

- [ ] **Step 1: Add worker-failure test**

Kill/fail fake worker during task.

Assert:
- task fails,
- memory reservation releases,
- later task can use replacement worker,
- no GPU handle publication occurs.

- [ ] **Step 2: Add device-loss browser assertions**

After recreation:
- compressed asset authoritative data still available,
- GPU resources rebuilt,
- stale handles rejected,
- no Worker private state required.

- [ ] **Step 3: Run targeted tests**

```powershell
Set-Location OEngine
npm run build:test
node --test tests/asset-codec-service.test.mjs tests/packed-render-world-contract.test.mjs

Set-Location ../examples
npm run verify -- lifecycle.device-loss-recreate
```

- [ ] **Step 4: Commit**

```bash
git add OEngine examples
git commit -m "fix(asset): close codec and compressed texture lifecycles"
```

---

### Task 18: ADR-0007 Formal PERF and Documentation Cutover

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/STATUS.md`
- Modify: `docs/adr/0007-*.md`
- Modify: `docs/porting/platform.md`
- Add/update accepted benchmark artifacts under `OEngine/benchmarks/`

**Interfaces:**
- No new runtime architecture in this task; it proves and documents the cutover.

- [ ] **Step 1: Ensure clean working tree**

Formal PERF evidence requires clean provenance.

- [ ] **Step 2: Run formal Rendering Lab**

Use existing policy:

```text
3 independent browser contexts
120 warm-up
480 measured
fixed browser/adapter/resolution/DPR/quality/workload/camera
```

Required groups:
- texture-heavy direct compressed,
- representative normal production scene,
- separate Worker/WASM loading/transcode evidence run.

- [ ] **Step 3: Report metrics by performance domain**

GPU steady state:

```text
frame P50/P95/P99
relevant GPU phases
```

Texture:

```text
package bytes
upload bytes
resident bytes
runtime mip passes
format distribution
```

Codec:

```text
main-thread blocked time
queue wait
worker time
wall time
throughput
peak CPU transient bytes
```

Do not reduce all evidence to one FPS number.

- [ ] **Step 4: Verify completion criteria**

All required:
- production self-authored block codec absent,
- direct BC-family compressed path active,
- Worker/WASM KTX2/Basis path active,
- normal GpuRenderWorld consumer active,
- cooked runtime mip = 0,
- stable handle/abort/device-loss correct,
- binding-set preflight correct,
- porting provenance complete.

- [ ] **Step 5: Synchronize current-truth docs**

`ARCHITECTURE.md` should now document:

```text
AssetCodecService
Worker/WASM codec layer
encoded TextureAsset variants
TextureBindingSet
format-aware TextureResidency
```

`STATUS.md` removes transitional statements no longer true.

ADR-0007 records final evidence and implementation state.

- [ ] **Step 6: Run documentation validation**

```powershell
Set-Location OEngine
npm run build:test
node --test tests/documentation-system.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Final commit**

```bash
git add docs OEngine/benchmarks OEngine/tests
git commit -m "docs(asset): close ADR-0007 texture codec migration"
```

---

# Execution Order Summary

```text
Task 1
Provenance / ADR rules
   ↓
Task 2–5
Contracts + WorkerPool + Service + Policy
   ↓
Task 6
Basis/KTX2 WASM
   ↓
Task 7
TextureAssetPackage stops owning codec algorithms
   ↓
Task 8–9
Format-aware Residency + TextureBindingSet
   ↓
Task 10–12
Direct + Worker paths enter normal GpuRenderWorld production
   ↓
Task 13–17
Browser/lifecycle/evidence/legacy deletion
   ↓
Task 18
Formal PERF + ADR closure
```

# Mandatory Review Checkpoints

```text
Checkpoint A — after Task 6
Worker/WASM path is real and independently measured.

Checkpoint B — after Task 9
TextureBindingSet contract is stable before normal production cutover.

Checkpoint C — after Task 12
Normal GpuRenderWorld consumes compressed residency.

Checkpoint D — after Task 16
Production self-authored codec is gone.

Checkpoint E — after Task 18
ADR-0007 Texture gap formally closed.
```

# Stop Conditions

Stop implementation and revise the design if any is observed:

```text
1. Worker/WASM introduces mandatory main-thread copies comparable to input payload size.

2. TextureBindingSet requires a second Renderer/material architecture.

3. Direct compressed path cannot preserve stable TextureHandle semantics.

4. Target WebGPU 2026 device limits cannot sustain the selected explicit binding-set budget.

5. Basis/KTX2 target quality or throughput fails the representative texture corpus enough to require a specialized build-only encoder.
```

For Stop Condition 5, add exactly one build-only backend behind `EncodedTextureVariantV2`:

```text
ASTC quality/encode issue → astcenc
BC quality/encode issue   → evidence-selected BC encoder such as Compressonator
```

Runtime ownership and package architecture stay unchanged.
