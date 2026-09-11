# OEngine Asset Codec & GPU-Native Texture Pipeline V3 — Design Specification

> **Status:** proposed for integration into ADR-0007  
> **Date:** 2026-09-11  
> **Repository:** `bigbigbig2/EEngine`  
> **Primary scope:** ADR-0007 Texture Cooker / Texture Residency production closure  
> **Secondary scope:** reusable Worker/WASM asset-codec infrastructure for future Draco / Meshopt / ZSTD paths  
> **Product target:** WebGPU 2026 Desktop, one Renderer architecture, GPU-native runtime assets, no algorithm-heavy codec reimplementation in OEngine  
> **Validation:** existing DEV / MILESTONE / PERF policy; no parallel test framework

---

# 1. Executive Decision

OEngine 的 Texture/Asset Codec 路线冻结为：

```text
Open-source codec algorithms
+
Web-engine-proven Worker/WASM integration patterns
+
OEngine-owned RuntimeAssetPackage / Residency / GPU ownership
```

总体数据流：

```text
                     OEngine Asset Input
                            │
            ┌───────────────┴────────────────┐
            │                                │
            ▼                                ▼
    GPU-native cooked data            KTX2 / Basis / heavy codec
    BC / ASTC / ETC2                         │
            │                                ▼
            │                       AssetCodecService
            │                                │
            │                         AssetWorkerPool
            │                                │
            │                          WASM upstream
            │                                │
            └───────────────┬────────────────┘
                            ▼
                  EncodedTextureVariant
                            │
                            ▼
                  RuntimeAssetPackage V2
                            │
                            ▼
                    TextureResidency
                            │
                            ▼
                    Stable TextureHandle
                            │
                            ▼
                     GpuMaterialStore
                            │
                            ▼
                           GPU
```

核心原则：

1. **OEngine 不再实现正式 BC/ASTC/ETC/Basis/Draco 等算法密集 codec。**
2. **Worker 是性能设施，不是兼容设施。** 重 CPU codec 任务离开主线程，并允许有限并行。
3. **WASM 是正式 codec 执行后端。** 直接使用成熟 upstream codec binary/module；不将其重写成 TypeScript。
4. **已经是 GPU-native 的 runtime asset 永远优先 direct upload。** 不为了“使用 Worker/WASM”而额外转码。
5. **KTX2/Basis Worker/WASM 是第二条正式 fast path。** 它负责高吞吐转码，但不是所有纹理都必须经过它。
6. **OEngine 自己拥有 policy、package、identity、residency、binding、GPU publication。**
7. **Three.js / Babylon.js 是 Web integration reference，不是 OEngine runtime owner。**
8. **底层 codec 版本直接固定到原始 upstream。** 不从 Three.js/Babylon.js 复制一个失去 provenance 的 `.wasm`。

---

# 2. Current Repository Reality

本设计不是从零造子系统，而是收敛当前 ADR-0007 已存在的资产路径。

## 2.1 已有 Runtime Asset 基础

当前资产目录：

```text
OEngine/src/assets/
├─ RuntimeAssetManifestV2.ts
├─ RuntimeAssetPackage.ts
├─ RuntimeAssetResidency.ts
├─ TextureAssetPackage.ts
├─ GeometryAssetPackage.ts
├─ GeometryCookRecipe.ts
└─ SourceGeometry.ts
```

现有 `RuntimeAssetManifestV2` 已经提供：

```text
asset identity
schema/version
source provenance
variant table
requiredFeatures / requiredLimits
chunk table
alignment/range/checksum
```

因此本设计**不引入第二套 KTX runtime manifest**，也不以 KTX2 替换 `.oasset/.opack`。

## 2.2 当前 TextureAssetPackage 的问题

当前 `OEngine/src/assets/TextureAssetPackage.ts` 同时承担：

```text
Texture semantic
+
mip construction
+
alpha handling
+
BC block encoding
+
variant construction
+
RuntimeAssetPackage serialization
+
GPU upload helper
```

其中存在 OEngine 自研：

```text
buildOfflineMips(...)
downsample(...)
preserveAlphaCoverage(...)
encodeBlockCompressed(...)
```

当前 desktop policy 主要为：

```text
base-color / emissive → BC3 sRGB
normal                → BC5
alpha mask            → BC4
ORM                   → BC1
```

这适合作为 ADR-0007 的结构验证实现，但不应继续成为正式 production codec。

## 2.3 当前 TextureResidency 的生产路径仍是 RGBA-centric

当前：

```text
OEngine/src/gpu/TextureResidency.ts
```

仍定义：

```ts
formatClass: "rgba8"
```

并使用 5 个固定 Texture Bank bindings。

普通生产链路：

```text
GpuRenderWorld.stage()
    ↓
graphics.texture_residency.stage(source.materials, command)
    ↓
graphics.material_store.stage(...)
```

而 `TextureResidency.stage()` 仍包含：

```text
resize/copy
runtime mip generation
```

因此真正的 ADR-0007 Texture closure 不是“TextureAssetPackage 可以生成 BC”，而是：

```text
GPU-native encoded variant
    ↓
normal GpuRenderWorld production registration
    ↓
TextureResidency
    ↓
GpuMaterialStore
    ↓
Surface / Visibility / Transparency consumer
```

并确保 ordinary cooked texture：

```text
runtime mip generation = 0
runtime recompression   = 0
RGBA expansion          = 0
```

---

# 3. Worker/WASM 在 OEngine 中的性能角色

```text
Web Worker
→ 主线程不执行长时间 codec 工作
→ 多 asset 有限并行
→ 减少 loader/import 对 frame/UI 的阻塞

WASM
→ 运行成熟 C/C++ codec
→ 避免手写 TypeScript 算法
→ 利用成熟 SIMD/编译器优化
→ 统一 codec provenance

GPU compressed format
→ 降低 VRAM
→ 降低纹理 fetch 带宽
→ 降低 upload bytes
```

这三者应该组合，但不能混淆。

## 3.1 Direct GPU-Native Path

如果 `.oasset/.opack` 已经包含目标 GPU block：

```text
BC7 / BC5 / BC4 / BC6H
ASTC
ETC2 / EAC
```

运行时：

```text
fetch package
→ select variant
→ GPUTexture create
→ block upload
→ publish residency
```

此路径：

```text
Worker: 不需要
WASM: 不需要
```

任何额外 transcode 都是负优化。

## 3.2 Worker/WASM Codec Path

如果输入为：

```text
KTX2 + UASTC
KTX2 + ETC1S
Draco
ZSTD
future compressed source
```

运行时：

```text
ArrayBuffer
→ transfer ownership to Worker
→ WASM codec
→ transfer result ownership back
→ Runtime/GPU owner publication
```

这是正式 production fast path，而不是 debug fallback。

---

# 4. Upstream Reference Policy

本轮优先级：

```text
1. Three.js / Babylon.js
   学 Worker/WASM integration、format decision、browser lifecycle

2. 原始算法 upstream
   Basis Universal / Draco / meshoptimizer / ZSTD

3. Web 引擎没有解决或质量/性能证据不足
   才增加专门 native tool：
   astcenc / Compressonator / DirectXTex 等
```

## 4.1 Three.js 应借鉴的部分

参考：

```text
examples/jsm/loaders/KTX2Loader.js
examples/jsm/loaders/DRACOLoader.js
examples/jsm/utils/WorkerPool.js
```

采用：

```text
fixed bounded Worker pool
task queue
Transferable ArrayBuffer
WASM initialization per worker
feature-driven transcode target
task result cache
explicit dispose
```

不移植：

```text
THREE.CompressedTexture
Three Loader hierarchy
Three Renderer ownership
Three material/texture abstractions
```

## 4.2 Babylon.js 应借鉴的部分

参考：

```text
packages/dev/core/src/Misc/khronosTextureContainer2.ts
packages/tools/ktx2Decoder/
packages/dev/core/src/Meshes/Compression/
```

采用：

```text
AutoReleaseWorkerPool
hardwareConcurrency-aware bounded worker count
caller supplied WorkerPool
codec module/binary container
transcode decision tree
WASM memory manager
speed-vs-format policy
codec-specific worker initialization
```

不移植 Babylon 的 `InternalTexture` / Engine object graph / Scene ownership。

## 4.3 Codec provenance

Three/Babylon 只是 integration reference。

实际 codec 必须固定原始 upstream revision，并记录：

```text
source upstream
revision
build flags
license
binary hash
local validation
```

到 `docs/porting/`。

---

# 5. New Runtime Boundary: AssetCodecService

新增：

```text
OEngine/src/assets/codec/
├─ AssetCodecTypes.ts
├─ AssetWorkerPool.ts
├─ AssetCodecService.ts
├─ AssetCodecPlanner.ts
├─ TextureCodecPolicy.ts
├─ Ktx2BasisCodec.ts
├─ ReferenceTextureCodec.ts
└─ workers/
   └─ asset-codec-worker.ts
```

第一轮只生产使用 Texture/KTX2。

Draco/Meshopt 先共享 protocol seam，不要求在 ADR-0007 Texture closure 中同步接入。

`AssetCodecService` 负责：

```text
task planning
priority
worker scheduling
codec memory budget
codec initialization
cancellation
evidence
```

它不负责：

```text
GPUTexture ownership
TextureHandle allocation
TextureResidency mutation
GpuMaterialStore
FrameGraph
```

GPU publication 继续在 Main Thread 的现有 GPU owner 中完成。

---

# 6. Worker Pool Contract

默认：

```text
workerCount =
clamp(
    floor(navigator.hardwareConcurrency * 0.5),
    1,
    4
)
```

同时存在：

```text
maxWorkers
maxInFlightEstimatedBytes
maxQueuedTasks
```

第一版建议：

```text
maxWorkers = min(floor(hardwareConcurrency / 2), 4)
maxInFlightEstimatedBytes = 256 MiB
```

优先级：

```text
0 critical-visible
1 visible-soon
2 background
```

同优先级 FIFO。

启动 task 必须同时满足：

```text
idle worker
+
memory reservation
```

Worker 空闲但 memory budget 不足时，task 保留在队列。

---

# 7. Transfer Semantics

第一阶段只使用：

```text
Transferable ArrayBuffer
```

输入：

```text
main
→ postMessage(request, [inputBuffer])
→ worker owns input
```

输出：

```text
worker
→ postMessage(result, resultBuffers)
→ main owns result
```

不把 `SharedArrayBuffer` 作为第一阶段依赖。

只有 profiler 证明 WASM memory 到 transferable output 的 copy 是显著瓶颈后，才允许证据驱动地引入 shared memory。

---

# 8. Asset Codec Task Protocol

逻辑合同：

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
  readonly semantic: TextureSemanticV2;
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
```

Task protocol 不包含 GPU object。

---

# 9. Texture Codec Planning

增加 `TextureCodecPolicy`，输入：

```text
source encoding
TextureSemantic
WebGPU capability record
quality profile
available package variants
```

输出：

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

选择逻辑禁止隐藏在 worker 代码中。

---

# 10. WebGPU 2026 Compression Policy

主产品能力线继续以 `docs/WEBGPU.md` 为权威。

Runtime：

```text
BC available
→ BC preferred

else ASTC/ETC2 available
→ semantic-specific ASTC/EAC/ETC2

else
→ explicit uncompressed variant or reject configured tier
```

Desktop BC 默认：

```text
BaseColor RGB/RGBA     → BC7 sRGB
Emissive LDR           → BC7 sRGB
Normal XY              → BC5 UNORM
AO / scalar mask       → BC4 UNORM
ORM                    → BC7 linear first
Standalone alpha mask  → BC4
HDR environment        → BC6H UFLOAT
```

如果 alpha 与 BaseColor 共存：

```text
BaseColor+Alpha → BC7 sRGB
```

非 BC 设备：

```text
BaseColor / Emissive  → ASTC sRGB
Normal                → EAC RG11 or proven ASTC linear
Scalar                → EAC R11
ORM                   → ASTC linear
RGBA                  → ASTC RGBA / ETC2 RGBA
```

ASTC：

```text
High     → 4×4 / 5×5
Balanced → 6×6
Memory   → 8×8 only when corpus passes
```

HDR 非 BC path 不假设 ASTC HDR；第一版使用现有 WebGPU format policy 选择未压缩 HDR 格式。

---

# 11. Encoded Texture Variant Contract

本设计版本叫 V3，**不代表必须把现有 RuntimeAssetPackage/TextureAsset schema 升到 3**。若现有 V2 binary contract 可以无歧义表达新 metadata，就保持 schema V2，只提升 Cooker/implementation revision。

`TextureAssetPackage` 改为接受统一 encoded variant：

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
```

`TextureAssetPackage.ts` 以后只负责：

```text
validate encoded variant
serialize metadata/chunks
open
select variant
upload metadata handoff
```

不再知道 BC endpoint、ASTC mode、ETC selector 或 mip filtering 算法。

---

# 11.1 Compressed Extent / `texture-compression-unaligned`

`EncodedTextureMipV2` 同时保存 logical 与 physical extent，专门避免把 WebGPU block alignment 规则泄漏成材质/UV 语义。

```text
feature available
→ logical extent 可直接对应 compressed texture extent（按规范/浏览器实测）

feature unavailable
→ Cooker/codec output 对 physical block extent 做 padding
→ Texture descriptor 保留 logical extent / uv scale
```

`texture-compression-unaligned` 只通过 `docs/WEBGPU.md` 的 capability record 使用；在目标浏览器/types 未稳定暴露时不作为 ADR-0007 hard requirement。

---

# 12. KTX2/Basis Path

KTX2 是 source/intermediate codec container，不替换 OEngine RuntimeAssetPackage。

Build/Cook：

```text
source image
→ upstream Basis/KTX tool
→ UASTC / ETC1S KTX2
→ upstream transcode/encode
→ EncodedTextureVariantV2
→ RuntimeAssetPackage V2
```

Runtime Heavy Ingest：

```text
KTX2
→ AssetCodecService
→ Worker
→ Basis WASM
→ GPU block payload
→ normalized encoded result
→ TextureResidency
```

---

# 13. Offline Cooker Strategy

第一阶段不直接把 OEngine 绑定到 Compressonator/astcenc。

优先使用：

```text
Basis Universal / KTX2 upstream toolchain
```

这样可以：

```text
降低移植复杂度
共享 Runtime/Worker codec provenance
先闭环 production path
```

只有质量/编码吞吐证据证明 BC7/ASTC/HDR encode 不足，才增加 build-only：

```text
astcenc
Compressonator
```

它们只能成为 `EncodedTextureVariantV2` producer，不能进入 Runtime GPU ownership。

---

# 14. Mip Generation Policy

正式 production mip generation 不再依赖 OEngine 手写 `downsample()`。

优先使用：

```text
Basis/KTX upstream mip pipeline
```

语义：

```text
sRGB color → linear filter → sRGB
normal     → vector-aware filter + renormalize
linear ORM → linear filter
```

Alpha MASK coverage 是特殊 case。

如果 Web 引擎/Basis/KTX upstream 不能满足 coverage invariant，则采用成熟开源算法的 traceable port/build tool（例如 DirectXTex 对应算法），而不是重新设计私有算法。

旧 `preserveAlphaCoverage()` 可以保留为测试 oracle，不能是 production authority。

---

# 15. Texture Residency V3

当前 `formatClass: "rgba8"` 必须扩展为**精确 physical `GPUTextureFormat`**，而不是只记录宽泛的 `"astc"` / `"bc"` family。不同 ASTC block size、sRGB/linear、BC7 linear/sRGB 不能共享同一 physical array bank。

推荐 descriptor 同时保存：

```ts
readonly format: GPUTextureFormat;
readonly formatClass: GPUTextureFormat; // Phase 1: exact physical format is the class key
```

以后如果 profiler 证明需要额外 grouping，可新增独立 family 字段，但不能弱化 physical format identity。

逻辑：

```text
TextureHandle
    ↓
TextureResidencyDescriptor
    ↓
TextureBindingSetId
+ local binding slot
+ array layer
+ format/size metadata
```

物理资源：

```text
FormatClass × SizeClass × Segment
```

例如：

```text
BC7_SRGB × 1024 × segment0
BC5      × 1024 × segment0
BC4      × 512  × segment0
ASTC6x6  × 1024 × segment0
```

---

# 16. TextureBindingSet

WebGPU 2026 当前不把通用 bindless/sized binding arrays 作为 OEngine production baseline，因此不能把无限 `format × size × segment` 全塞进一个 bind group。

每个 `TextureBindingSet` 是有限 explicit bindings：

```text
Material
   ↓
TextureBindingSetId
   ↓
TextureRefs inside set
```

一个 material 的全部 production texture 必须在一个可执行 set 中表达。

若不能：

```text
preflight fails before publish
```

不得 silent dual-set。

这与 ADR-0009：

```text
ShadingDispatchClassId
=
KernelClassId × TextureBindingSetId
```

保持兼容。

第一阶段只做：

```text
bounded set count
bounded bindings/set
stable TextureHandle
format-aware bank/segment
transactional publication
```

不做 VT / bindless / sparse page table。

---

# 17. GPU Ownership

Worker 绝不能：

```text
持有 GPUDevice
create GPUTexture
mutate TextureResidency
publish TextureHandle
```

Worker 只返回 codec payload。

Main Thread：

```text
TextureResidency.reserve
→ create GPU resource
→ encode upload
→ command finish
→ publish descriptor/handle
```

保持现有 transaction 语义：

```text
reserve → submit → commit/publish
abort   → rollback
```

---

# 18. GpuRenderWorld Integration

当前 owner 顺序保持：

```text
GpuRenderWorld.stage()
→ texture_residency.stage(...)
→ material_store.stage(...)
→ gpu_scene.instantiate(...)
```

目标：

```text
Scene/Runtime Asset
      ↓
TextureDecodePlan
      ↓
Direct blocks or Worker/WASM result
      ↓
TextureResidency transaction
      ↓
TextureBindingSet(s)
      ↓
GpuMaterialStore
```

`GpuRenderWorld` 不 import Basis/Worker codec implementation。

---

# 19. Evidence

AssetCodecService：

```text
tasksQueued
tasksCompleted
tasksFailed
tasksCancelled
activeWorkers
peakActiveWorkers
queueWaitMs
workerMs
wallMs
inputBytes
outputBytes
transferBytes
estimatedPeakBytes
peakInFlightBytes
codecId
codecRevision
directTextureCount
workerTranscodeTextureCount
uncompressedFallbackCount
```

TextureResidency：

```text
uploadBytes
residentBytes
physicalAllocatedBytes
runtimeMipGenerationCount
transcodeBytes
bindingSetCount
bindingSlotUtilization
```

性能解释分开：

```text
Direct path
→ package/upload/resident/runtime mip/GPU bandwidth

Worker/WASM
→ main-thread blocked time/codec throughput/queue wait/CPU transient memory/time-to-ready

GPU compression
→ VRAM/upload/texture bandwidth
```

---

# 20. Validation

完全复用：

```text
OEngine/tests/
examples/validation-tools/
Rendering Lab
```

DEV：

```text
typecheck
+ targeted unit/oracle
+ nearest Chrome case
```

MILESTONE：

```text
npm test
+ 2–4 browser cases
+ profile:rendering-lab:dev
```

PERF：

```text
clean commit
3 × (120 warmup + 480 measured)
```

优先扩展：

```text
OEngine/tests/runtime-asset-v2.test.mjs
OEngine/tests/packed-render-world-contract.test.mjs
```

只新增：

```text
OEngine/tests/asset-codec-service.test.mjs
```

Browser 最多新增：

```text
surface.texture-compressed
```

---

# 21. Reference/Test Encoder Policy

当前自研：

```text
encodeBlockCompressed(...)
buildOfflineMips(...)
```

迁移为：

```text
ReferenceTextureCodec
TestTextureMipBuilder
```

仅服务：

```text
tiny deterministic fixture
upload oracle
package corruption tests
codec-independent browser test
```

新增 invariant：

> Production cook/runtime source graph must not import the reference/test encoder.

正式 codec 不可用时：

```text
production → fail preparation
dev explicit fallback → uncompressed
```

禁止 silent 使用简易 BC encoder。

---

# 22. Failure & Lifecycle

Codec unavailable：

```text
production fail
dev only explicit RGBA fallback
```

Worker crash：

```text
fail task
release memory reservation
optional worker respawn
never publish partial texture handle
```

WASM init failure：

```text
error includes codec id/revision/binary hash
```

Memory budget exceeded：

```text
queue task
```

Binding-set preflight failure：

```text
fail before GPU publication
```

Device loss：

```text
RuntimeAsset authoritative payload/metadata
→ rebuild TextureResidency
```

不得依赖 worker 私有状态。

---

# 23. Documentation Integration

落地同步：

```text
docs/adr/0007-...
docs/ARCHITECTURE.md
docs/STATUS.md
docs/porting/platform.md
```

只有共享验证政策变化才改 `VALIDATION.md`。

ADR-0007 Texture steps 建议：

```text
Step 2A — Asset Codec Backend Contract
Step 2B — Worker/WASM KTX2/Basis Production Path
Step 2C — GPU-native Texture Variant Policy
Step 2D — Remove OEngine-authored Production Codec
Step 3  — Multi-format Texture Residency + TextureBindingSet
```

---

# 24. Completion Criteria

Texture 部分必须同时满足：

```text
1. OEngine production source graph 不包含自研 BC/ASTC/ETC encoder。
2. ordinary cooked texture 不依赖 runtime mip generation。
3. 至少 BC-family GPU-native texture 进入 normal GpuRenderWorld production path。
4. compressed asset 进入 TextureResidency 后保持 stable handle。
5. direct GPU-native input 不经过 Worker/WASM。
6. KTX2/Basis heavy input 通过 Worker + WASM。
7. Worker task 使用 Transferable，不复制大 input buffer。
8. Worker 并发同时受 worker count 与 CPU transient memory budget 限制。
9. codec provenance 完整写入 porting ledger。
10. TextureBindingSet preflight 能在 publish 前拒绝无法表达的 material set。
11. no-texture / feature-off 不创建 codec worker、codec resource 或额外 GPU submit。
12. DEV/MILESTONE 通过并完成 ADR-0007 final PERF。
```

---

# 25. Non-Goals

本轮不做：

```text
Virtual Texturing
GPU decompression research codec
Worker-owned GPUDevice
bindless emulation
通用 streaming scheduler
Draco production integration
Meshopt worker production integration
SharedArrayBuffer mandatory path
自研 BC7/ASTC/Basis codec
```

---

# 26. Phased Migration

```text
Phase A
AssetCodecService / WorkerPool
→ 独立验证 Worker/WASM

Phase B
KTX2/Basis Worker/WASM
→ browser transcode oracle

Phase C
TextureAssetPackage 变成 encoded-variant container
→ self codec 退出 production

Phase D
TextureResidency multi-format + TextureBindingSet
→ compressed blocks normal production

Phase E
GpuRenderWorld / material production cutover
→ runtime mip = 0

Phase F
formal evidence
→ close ADR-0007 texture gap
```

第一刀优先：

```text
AssetCodecTypes
AssetWorkerPool
AssetCodecService
KTX2/Basis worker oracle
```

不要一开始就大改 `TextureResidency.ts`。

---

# 27. Final Architecture

```text
                                  OEngine
┌───────────────────────────────────────────────────────────────────────┐
│ Source / Runtime Assets                                               │
│                                                                       │
│   GPU-native blocks                  Heavy encoded source             │
│ BC/ASTC/ETC2/KTX raw                 KTX2 Basis                       │
│          │                                  │                         │
│          │                                  ▼                         │
│          │                           AssetCodecPlanner                 │
│          │                                  │                         │
│          │                           AssetWorkerPool                   │
│          │                                  │                         │
│          │                            Basis WASM                       │
│          │                                  │                         │
│          └──────────────────┬───────────────┘                         │
│                             ▼                                         │
│                  EncodedTextureVariant                                │
│                             │                                         │
│                  RuntimeAssetPackage V2                               │
│                             │                                         │
│                  TextureResidency V3                                  │
│             Format × Size × Segment                                   │
│                             │                                         │
│                    TextureBindingSet                                  │
│                             │                                         │
│                  Stable TextureHandle                                 │
│                             │                                         │
│                    GpuMaterialStore                                   │
│                             │                                         │
│                        Renderer                                       │
└───────────────────────────────────────────────────────────────────────┘
```

最终边界：

```text
Three.js / Babylon.js
→ Web integration reference

Basis Universal / codec upstream
→ algorithm authority

OEngine
→ runtime policy + GPU architecture authority
```
