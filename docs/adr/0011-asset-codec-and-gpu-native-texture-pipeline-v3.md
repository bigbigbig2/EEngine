# ADR-0011 · Asset Codec 与 GPU-Native Texture Pipeline V3

> **Status:** accepted
> **Date:** 2026-09-11
> **Scope:** production texture codec authority、KTX2/Basis Worker/WASM、Encoded Texture Variant、multi-format residency 与 TextureBindingSet
> **Depends on:** ADR-0007 Runtime Asset/Residency V2；ADR-0009 Material Classification
> **Design sources:** `docs/others/2026-09-11-oengine-asset-codec-texture-v3-*.md`

## Context

ADR-0007 已冻结 Runtime Package V2、Texture Package V2、stable texture handle、format-aware residency、完整离线 mip 与 GPU-compressed production path。当前实现已经形成：

```text
TextureAssetPackageV2
  → device capability variant selection
  → GpuRenderWorld.stage()
  → TextureResidency
  → Material / Visibility MASK / Transparency
```

当前 WebGPU 2026 Desktop 路径能够选择 BC1/3/4/5，直接上传全部 Cooked mip，且 Cooked texture 不执行 runtime mip generation。它已经解决“压缩数据能否进入普通 Renderer production path”的结构问题。

剩余问题位于更上游：`TextureAssetPackage.ts` 仍同时承担 semantic mip construction、alpha coverage 和简化 block encoding。该实现适合作为确定性测试 oracle，不应成为正式内容生产的算法权威。同时，KTX2/Basis 等重型 source/transport encoding 尚无受控 Worker/WASM ingest，当前单一 TextureBindingSet 的 physical segment coverage 也不足以表达更广泛的 format、尺寸和内容批次。

这不是 ADR-0007 的局部代码重构。它引入外部 codec binary、Worker 调度与 CPU transient memory owner，改变 Texture Package producer 边界，并把多个 TextureBindingSet 接入 ADR-0009 的 `KernelClassId × TextureBindingSetId` 分类。因此以本 ADR 单独承载长期决定；ADR-0007 的 package、handle、residency transaction 决定继续有效。

完整设计输入与原始逐 Task 计划保存在：

- [`../others/2026-09-11-oengine-asset-codec-texture-v3-design.md`](../others/2026-09-11-oengine-asset-codec-texture-v3-design.md)
- [`../others/2026-09-11-oengine-asset-codec-texture-v3-implementation-plan.md`](../others/2026-09-11-oengine-asset-codec-texture-v3-implementation-plan.md)

两份输入不覆盖本 ADR 和当前源码事实；本 ADR 末尾逐节记录其去向，避免迁移时静默删减。

## Decision

### 1. Codec authority 与采用状态

OEngine 冻结三层边界：

```text
original upstream codec/tool → algorithm authority
OEngine AssetCodec/Cooker adapter → policy、task、normalization、provenance
RuntimeAssetPackage/TextureResidency → identity、package、GPU ownership、publication
```

生产 texture compression/transcoding 不得依赖 OEngine 自研 BC/ASTC/ETC/Basis block codec。外部实现必须在 `docs/porting/platform.md` 固定 upstream repository、revision、source/binary path、build flags、license、binary hash、保留不变量、OEngine/WebGPU 差异和本地验证。

Three.js 与 Babylon.js 只作为 Worker pool、Transferable、KTX2 target selection 和 lifecycle 的 Web integration reference；不复制其 Renderer、Texture、Loader hierarchy 或 GPU ownership。实际 codec module/binary 来自固定的 Basis Universal/KTX-Software upstream artifact 或由固定 upstream source reproducibly build。

当前简化 mip/block encoder 迁移为 test/reference-only owner。Production source graph 不得 import 它；codec 不可用时 production preparation 明确失败，只有显式 development policy 可以选择 uncompressed variant。

### 2. 两条正式 texture preparation path

#### Direct GPU-native path

当 Runtime Asset 已包含与 device capability 相容的 BC/ASTC/ETC2 physical blocks 时：

```text
package variant → validate → residency reserve → direct block upload
  → command completion → stable handle/routing publication
```

此路径不创建 Worker、不初始化 WASM、不执行 runtime transcode、resize 或 mip generation，始终优先于 Worker path。

#### KTX2/Basis Worker/WASM path

KTX2 UASTC/ETC1S 是正式的第二条 runtime ingest path：

```text
KTX2 ArrayBuffer
  → TextureCodecPolicy / AssetCodecPlanner
  → AssetCodecService / bounded AssetWorkerPool
  → pinned Basis/KTX WASM
  → EncodedTextureVariant
  → 与 direct path 相同的 TextureResidency transaction
```

Worker path 不形成第二套 Runtime Package、TextureResidency、Material 或 Renderer。Draco、Meshopt decode、ZSTD 和未来 codec 只共享 task/protocol seam，不是本 ADR completion 条件。

### 3. AssetCodecService owner

`AssetCodecService` 是 Renderer composition 中的惰性 CPU service。当前实现由 `GraphicsContext` 持有和销毁，以复用 Renderer 生命周期、capability record 与统一 evidence；它不拥有或接收 `GPUDevice`、`GPUTexture`、TextureHandle、TextureResidency、GpuMaterialStore 或 FrameGraph。

该所有权不意味着 codec authoritative data 依赖 GPU device。Device loss 后 Runtime Asset/KTX2 input 仍是重建事实；旧 service/worker 可以销毁并重建，不得依赖 Worker 私有缓存恢复 GPU resource。`GpuRenderWorld`、material owner 和 render pass 不 import Basis/KTX worker implementation，只消费已准备的 Runtime Asset/encoded result。

### 4. Worker pool 与 transfer contract

第一版只使用 Dedicated Worker 与 Transferable `ArrayBuffer`，不依赖 `SharedArrayBuffer`、cross-origin isolation 或 Worker-owned WebGPU。

```text
maxWorkers = clamp(floor(hardwareConcurrency × 0.5), 1, 4)
maxInFlightEstimatedBytes = explicit bounded policy
maxQueuedTasks = explicit bounded policy
```

启动任务必须同时获得 idle worker 与 CPU transient memory reservation。同优先级 FIFO，优先级固定为 critical-visible、visible-soon、background。输入 ownership 经 transfer list 交给 Worker；输出 mip buffers 经 transfer list 返回 GPU owner thread。协议不得把 GPU object、DOM object 或 Loader temporary object 传入 Worker。

每个任务拥有稳定 task id、kind、priority、estimated peak bytes、codec/semantic/target metadata 和 cancellation signal。取消 queued task 立即释放 reservation；取消 running task 必须忽略并释放迟到结果，必要时终止并替换 Worker。Worker error、message error、WASM init failure 和 malformed result 都只失败对应 task、释放 reservation，且不得发布 partial GPU handle。

Worker respawn 是有界恢复：同一 worker 连续失败达到 policy limit 后停止 respawn，并让后续请求明确失败，避免无限 crash loop。

### 5. Worker-safe codec protocol

逻辑 task family 保留 `ktx2-transcode`、`draco-decode`、`meshopt-decode`、`zstd-decode`；第一轮只允许 `ktx2-transcode` 进入 production。Request/result 必须可 structured-clone；除 scalar format string 外不含 WebGPU type/object。初始化协议区分 init、task、cancel、dispose，WASM 每个 Worker 初始化一次。

Result 至少携带 task id、codec id/revision/binary hash、source encoding、selected exact `GPUTextureFormat`、per-mip logical/physical extents、per-mip transferable payload、input/output/estimated peak bytes 和 queue wait/worker/wall time。

### 6. Texture codec planning

`TextureCodecPolicy` 是无全局状态的纯决策。输入为 source encoding、TextureSemantic、冻结的 WebGPU capability record、质量 profile、package variants 和 pinned transcoder target matrix；Worker 内部不得隐藏 target selection。

选择顺序：

1. 已存在且 capability 相容的 direct physical variant；
2. pinned transcoder 实际支持的 worker-transcode target；
3. package 明确声明且 policy 允许的 uncompressed variant；
4. 创建 Worker/GPU resource 前明确失败。

选择压缩 target 同时要求 device 已启用对应 compression feature、asset/codec 实际提供 exact target、尺寸/mip/copy 规则可满足。Desktop 候选是 BaseColor/alpha/emissive → BC7 sRGB、Normal XY → BC5、scalar/mask → BC4、ORM → evidence-selected BC family、HDR → proven BC6H。非 BC 设备可选择 semantic-compatible ASTC/ETC2/EAC；ASTC block size 是 exact format identity。具体格式必须由 corpus quality、codec support 和目标 adapter evidence 决定。

### 7. EncodedTextureVariant boundary

Texture Package writer 改为消费已编码 variant，而不是内部计算 codec。Variant 必须含 profile、semantic、exact format、block dimensions/bytes、codec identity/binary hash，以及按 level 排序的完整 mip chain；每个 mip 保存 logical/physical extent 与 payload。

若 RuntimeAssetPackage/TextureAssetPackage V2 能无歧义表达这些字段，则保持 schema V2，只提升 cooker revision；否则通过新的显式 schema version 迁移。Package layer 只负责 validation、deterministic serialization/open、chunk/checksum、capability selection 和 upload handoff，不知道 BC endpoint、ASTC mode、ETC selector 或 mip filter 实现。

Cooked variant 必须包含 mip 0 到 1×1 的完整 logical chain；每层 payload byte length 必须与 exact format/block extent 一致，provenance 和 logical/physical extent 必须 round-trip。

### 8. Offline mip 与 alpha policy

Production mip generation 使用 pinned upstream cooker/codec pipeline。Semantic invariants：sRGB 在 linear domain filtering、normal vector-aware filter 后 renormalize、ORM linear per channel、alpha MASK 保持 coverage、HDR 不发生无声明 clipping。

如果选定 upstream 不能满足 alpha coverage，则采用另一个许可证兼容、可追溯且有 corpus oracle 的成熟 implementation/build tool。当前 self-authored downsample/coverage 只保留为数值 oracle，不成为 production authority。

### 9. Compressed extent 与 upload

Encoded mip 同时保存 logical 和 physical extent。使用 `texture-compression-unaligned` 前必须完成类型升级、feature negotiation、CTS/浏览器 validation；当前不作为 hard requirement。缺失时，Cooker/codec 必须生成 WebGPU copy rules 可表达的 block-aligned payload 或选择另一声明 variant，Material UV 只消费 logical extent/scale。

GPU upload 创建 `TEXTURE_BINDING | COPY_DST` texture并完整填充声明 mip。Copy 使用 exact block layout；需要 `bytesPerRow` 的多行 buffer copy 遵守 256-byte alignment。Upload 失败在 publication 前销毁/退役 provisional resource。

### 10. TextureResidency 与 TextureBindingSet

ADR-0007 的 stable handle、descriptor generation、reserve/commit/abort 和 logical/physical accounting 保持不变。Physical class 使用 exact `GPUTextureFormat × extent class × immutable segment`，不同 sRGB、ASTC block size 或 BC format 不能误共享 array texture。

当前单一 binding set 与 4 个 package segment slot 是已实现起点，不是 V3 最终容量模型。V3 增加有界多个 TextureBindingSet；每个 set 有 stable id/generation、fixed layout、bounded sampled array slots/sampler classes 与 slot→segment mapping。

同一 material 的全部 texture semantic 必须由一个 set 覆盖。相同 physical segment可以出现在多个 bind group 中，但不得复制 physical residency。Preflight 在 handle publication 前完成；无法 colocate 时只能创建 policy 允许的新 set、选择已声明 fallback、在 GPU completion 边界 repack/evict，或明确失败。禁止 silent dual-set sampling。

初始化根据实际 device limits 与保留的 shadow/environment/frame-product bindings 冻结 slots/set、sampler count、max resident sets 和 max shading dispatch classes，并写入 capability fingerprint。

### 11. ADR-0009 integration

多个 TextureBindingSet 不生成第二 Renderer 或 CPU visible-material loop。Material routing 增加 bounded `TextureBindingSetId`；ADR-0009 的 GPU classification 生成：

```text
ShadingDispatchClassId = KernelClassId × TextureBindingSetId
```

每个 GPU consumer dispatch/draw 绑定对应 set。CPU 只能按固定有界 class 编排 indirect consumer，不能 readback 当前可见材质再重建列表。Visibility MASK、Shadow MASK、Material Resolve 与 Transparency 消费同一 texture routing generation。

### 12. Lifecycle 与 publication

Codec CPU transaction 与 GPU residency transaction 分离但可追踪。Worker 完成不发布 handle；只有 residency preflight/reserve、upload 与 command completion 后才能原子发布 descriptor/material routing。GPU stage abort 后 encoded result 可以由上层 cache 复用，但 provisional GPU allocation必须回滚。Release/repack/set retirement 等待相关 GPU submission完成。Device loss 使用 Runtime Asset/KTX2 authoritative input 重建，旧 descriptor/set generation 必须拒绝。

### 13. Evidence

Codec owner 至少发布 queued/completed/failed/cancelled、active/peak workers、queue wait、worker/wall time、input/output/transfer bytes、estimated/peak in-flight bytes、codec identity，以及 direct/worker/uncompressed path count。

TextureResidency 至少发布 exact format distribution、direct compressed/worker transcode/uncompressed count、upload/transcode/resident/logical/physical/retiring/transaction bytes、runtime mip/resize/copy、binding set count、slot utilization、preflight failure 与 private submit count。

CPU codec counter 不得为取证增加 GPU readback。Performance 结论分开解释 codec throughput/main-thread blocking、loading time-to-ready、GPU upload/resident bytes 与 steady-state GPU phase。

### 14. Feature-off

没有 KTX2/Basis task 的应用不得创建 Worker、初始化 WASM、分配 codec pool、产生 codec timer 或额外 GPU submit。Direct GPU-native path 的正常帧成本不包含 Worker polling。Service destroy 幂等且清理 queued/running task、Worker、module reference 和 reservations。

### 15. Non-goals

本 ADR 不实现 Virtual Texturing、通用 streaming scheduler、bindless emulation、GPU decompression research codec、Worker-owned GPUDevice、SharedArrayBuffer mandatory path、Draco/Meshopt production integration 或自研 BC7/ASTC/Basis codec。

## Migration

1. 冻结 upstream provenance、codec artifact/build flags/target matrix 和 production-self-codec prohibition。
2. 建立 Worker-safe contract、bounded Worker pool、lazy AssetCodecService 与 pure TextureCodecPolicy。
3. 接入 pinned Basis/KTX2 WASM Worker，用 deterministic fixture 证明 transferable、target format 和 failure handling。
4. 建立 EncodedTextureVariant package writer，将现有 codec/mip helper 移到 test/reference-only owner。
5. 以当前 direct compressed residency 为共同 consumer，接入 Worker result；不得新增 WasmTextureResidency。
6. 从当前单 set 演进为有界 multi-set，并与 ADR-0009 classification 同步落地。
7. 完成 normal Render World、abort、release/reuse、Worker failure、device loss、feature-off 和 evidence Gate。
8. 删除 production self-codec import，运行 MILESTONE；最后在 clean commit 上运行一个综合 final PERF 与独立 codec load evidence。

已经由当前代码完成的 direct BC upload、normal Render World consumer、Cooked zero runtime mip 和基础 evidence 不重新实现，只扩展其 contract/test。

## Verification

- Contract/oracle：task validation、priority/FIFO、worker/memory bound、transfer、cancel/failure/respawn、provenance、encoded mip layout、semantic mip/alpha、variant selection、handle/generation、abort/release/reuse、set preflight。
- Browser：后续宿主必须覆盖 direct 与 Worker 两种 mode，并保持领域断言与 Runner 分离；旧 Surface scenario 已由 ADR-0012 删除，不作为兼容目标。
- Lifecycle：Worker crash/WASM init failure、GPU stage abort、Renderer destroy、device-loss recreate、no-codec feature-off。
- MILESTONE：`npm test` 加命中的少量真实 Browser Case；当前 Browser/PERF 宿主缺失，因此新 revision 的该 Gate 保持 open。
- PERF：clean provenance、固定环境；正式 GPU 结论只使用一个综合 profile。Worker codec 另做 loading/transcode evidence，不复制 Desktop/Portable 或 Renderer 基准。

Completion requires all of:

1. Production source graph 不包含 OEngine-authored block codec/mip authority。
2. Direct BC-family compressed path 和 KTX2/Basis Worker/WASM path 都进入 normal preparation/residency flow。
3. Ordinary Cooked texture 的 runtime mip、runtime recompression、RGBA expansion 和 private submit 为零。
4. Stable handle、generation、abort、release/reuse、device-loss rebuild 正确。
5. Worker Transferable、并发、memory budget、cancel/failure 和 feature-off 可验证。
6. TextureBindingSet capacity、material colocate、preflight、generation 与 ADR-0009 class closure 可验证。
7. Codec provenance、binary hash/build flags 和目标格式 matrix 完整。
8. 当前事实页同步，MILESTONE 与 final PERF Gate 通过，被替换路径删除。

## Stop conditions

出现以下任一情况即停止相应实现并修订本 ADR：Worker/WASM 有不可避免且收益不足的 payload-size 主线程复制；TextureBindingSet 需要第二 Renderer/material architecture 或 CPU visible-material list；两条 path 无法保持相同 stable handle/atomic publication；目标 device limits 无法维持 binding budget；Basis/KTX2 质量或吞吐在代表性 corpus 失败。

质量/吞吐失败时只允许增加一个 evidence-selected build-only backend，例如 ASTC 使用 astcenc，或 BC 使用 Compressonator/DirectXTex 类成熟工具；它只能生产 EncodedTextureVariant，不能进入 GPU ownership。

## Consequences

### Positive

- Codec algorithm、Web integration 与 GPU/runtime ownership 解耦。
- GPU blocks 保持最低 runtime cost，KTX2/Basis 获得受控通用 ingest。
- Texture Package 不再承载自研 production codec。
- Format/segment 与 material set coverage 可扩展而不破坏 stable handle。
- Worker、CPU transient、upload 和 VRAM 成本分别可观测。

### Costs and risks

- 增加 Worker protocol、WASM supply chain、build reproducibility、CSP/URL packaging 和 lifecycle 复杂度。
- Multi-set 增加 bind group、pipeline/class 组合与 GPU classification 状态。
- Upstream build flags 可能未包含 policy target；binary size、初始化和 per-worker memory 需要预算。
- Transferable ownership、取消和 Worker crash 容易造成 detached buffer、悬挂 Promise 或 reservation leak。
- Production self-codec 删除前必须有可复现 replacement，不能留下 preparation 空洞。

## 原稿覆盖映射

| 原设计章节 | 本 ADR 去向 | 状态 |
| --- | --- | --- |
| 1 Executive Decision | Decision 1–3 | 纳入 |
| 2 Current Repository Reality | Context | 按 `7b932aa` 修正 |
| 3 Worker/WASM role | Decision 2、4 | 纳入 |
| 4 Upstream Reference Policy | Decision 1 | 纳入 |
| 5 AssetCodecService | Decision 3 | 纳入 |
| 6 Worker Pool | Decision 4 | 纳入并补失败上限 |
| 7 Transfer Semantics | Decision 4 | 纳入 |
| 8 Task Protocol | Decision 5 | 纳入并补 cancel/result metadata |
| 9 Texture Codec Planning | Decision 6 | 纳入 |
| 10 Compression Policy | Decision 6 | 纳入，格式 evidence-selected |
| 11 Encoded Variant | Decision 7 | 纳入 |
| 11.1 Compressed Extent | Decision 9 | 纳入 |
| 12 KTX2/Basis | Decision 2 | 纳入 |
| 13 Offline Cooker | Decision 1、7、8 | 纳入 |
| 14 Mip Generation | Decision 8 | 纳入 |
| 15 Texture Residency V3 | Decision 10 | 当前部分已实现，保留增量 |
| 16 TextureBindingSet | Decision 10–11 | 纳入 |
| 17 GPU Ownership | Decision 3、12 | 纳入 |
| 18 GpuRenderWorld Integration | Decision 2、11–12 | direct 与 Worker 共用同一 production contract |
| 19 Evidence | Decision 13 | 纳入 |
| 20 Validation | Verification | 纳入并对齐统一政策 |
| 21 Reference/Test Encoder | Decision 1、7–8 | 纳入 |
| 22 Failure & Lifecycle | Decision 4、12 | 纳入并补 cancellation |
| 23 Documentation Integration | Migration | 纳入 |
| 24 Completion Criteria | Verification completion | 完整纳入 |
| 25 Non-Goals | Decision 15 | 完整纳入 |
| 26 Phased Migration | Migration | 按当前实现重排 |
| 27 Final Architecture | Decision 全体 | 纳入 |

原实施计划 Task 1–18 均由 Migration 1–8、Decision 1–15、Verification 与 Completion criteria 保留；实施状态只在 `docs/STATUS.md` 维护。原逐提交命令不成为 ADR 权威，执行时以当前工作树和 `VALIDATION.md` 为准。
