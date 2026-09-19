# OEngine 当前状态

Audit correction (2026-09-18, `64f346d`): the accepted browser cases below
prove successful Product publication, GPU demand, replacement, eviction and
device-loss paths, not failure-atomic replacement or large-scene visible-first
loading. Current `swapProductScene` releases the old Scene before the new one
is staged and does not restore it on failure; the Web progressive cooker
canonicalizes all catalog primitives before its first Product offer; the
page-global ledger now reserves source/WASM/output in the client lifecycle,
but source/canonical/WASM committed-peak accounting remains conservative and
needs measured multi-session evidence. The per-Product 128 MiB bank allocation
also needs a global capacity ledger and measured memory evidence. These open
defects and the seven larger delivery stages are tracked in
[0016 remaining-work plan](./implementation/0016-remaining-work-plan.md).
Earlier “atomic” and “per-domain parallel” wording on this page describes
intended or successful-path behavior, not closed gates; S4 source/WASM
reservation is covered by the checkpoint below.

Implementation update (2026-09-18): the Runtime-first Web route now runs a real
GLB end to end. `run:glb-web-product` drives the Dungeon (798 mesh / 25
material) through the pinned Emscripten Worker cooker, the shared Product
admission and `MainRenderPipeline`, and is accepted on the current revision with
a 256x256 linear-HDR coverage assertion (5610/65536 lit pixels), so a black
frame can no longer pass. The route offers a complete coarse bootstrap revision
first, cooks a richer revision in the background and swaps it atomically
(release -> re-stage -> retire), coalesces GLB accessor ranges, parallelizes the
per-domain cook, and enforces a page-global session/source/WASM/output budget
ledger. A residency defect that appended a page bank after publication, and
therefore dropped every refinement page in it, is fixed by sizing the bank heap
from the whole Product page table. `tests/nyx-differential-corpus.test.mjs` adds
the ADR-0016 differential, invariant and negative corpus, including Native
Offline <-> Web Runtime equivalence on one deterministic GLB.

S5 replacement/eviction update (2026-09-18): `run:virtual-product-replacement`
accepts a browser proof that the background richer CookSession revision replaces
the bootstrap atomically (replacements 1, generation 1 -> 2, revision 0 -> 1,
5600+ lit pixels through the swap), that the active revision refines residency
under real GPU demand (382 -> 383 pages), and that demand-loaded pages retire
across a submission boundary (4 candidates, 379 resident pages, evictedPages 4,
17400 lit pixels afterwards, no GPU error).

S5 device-loss update (2026-09-18): `run:virtual-product-device-loss` now closes the
last S5 leg on the current revision (accepted). An intentional `GPUDevice.destroy()`
on a steady-state Dungeon Product is followed by `Renderer.recoverAfterDeviceLoss()`,
which negotiates a second adapter/device (`adapters 2`, different device), refuses
submissions from the lost Renderer, and rebuilds the complete scene from the
retained Product source: 256x256 linear-HDR coverage is 5640 lit pixels before
the loss and 5610 after recovery, with `selectedClusters 474`, `visibleInstances 798`
and zero GPU errors. Three real defects had to be fixed:

1. `GpuRenderWorld.recoveryScenes()` returned Virtual Product scenes as packed
   scenes with zero geometry packages, aborting recovery before the dedicated
   product restore loop ran.
2. `WebCookCoordinator.requestPages` dropped every `activationPageIds` request,
   so the activation cut could not be re-read once `abandonForDeviceLoss`
   released the GPU banks. It now re-serves those pages as soon as the cut has
   finished streaming, and the product provider discards a waiter-less duplicate
   copy instead of holding output credit that later demand or recovery reads
   need.
3. `restoreDeviceRecovery` rebuilt Product residency without calling
   `activatePublication()`, so the restored Product table record stayed inactive
   and the GPU traversal produced `candidateClusters 0` - a fully black frame
despite a complete residency.

These questions are also pinned headlessly by
`tests/web-cook-activation-reserve.test.mjs`: a re-read of a streamed activation
page is emitted exactly once with credit conserved, a non-requested page is
never re-emitted, a consumed page is re-readable without buffering anything, a
requested page is still served while another revision occupies the whole
buffering window, and an unsolicited duplicate of a consumed page is discarded.

S6 Offline parity update (2026-09-18): `run:virtual-product-offline` now proves the
offline second route on the current revision (accepted). `load_oegpack_product`
opens a pre-cooked `.oegpack` from either an HTTP Range source or an in-memory
source, and `Renderer.uploadOegPackScene` publishes it through the same
`Geometry Product admission -> VirtualGeometryResidency -> streaming -> Visibility`
path as the Web route; the fork between producers is now only the provider and
the scene mapper. `Renderer.uploadProductScene` is the single shared facade, the
Web entry is a thin adapter over it, and the generic
`buildVirtualGeometrySceneSourceV1` builder is shared by both mappers.

Evidence on the committed OEGPACK fixtures: range and memory selection produce
the same Product identity, the same activation cut and the same GPU topology
counters, and both shade 64105 lit pixels in the 256x256 linear-HDR probe; a
missing pack fails explicitly with "server did not honor byte range (404)" and
publishes nothing; a replacement from pack A to pack B switches Product identity
with continuous output (64105 -> 64102 lit pixels); GPU demand refines residency
1 -> 5 pages (`requested 21`, `deduplicated 9`, `failed 0`, `retries 0`) and the
close camera keeps 65536/65536 lit pixels. The Offline bootstrap cut now
traverses the shared residency owner, so the OEGPACK-specific
`GeometryBootstrapResidencyV3` adapter is deleted.

A new `docs/specs/oegpack-scene-manifest-v3.md` freezes the `scene.oescene`
contract that the Native cooker writes and the runtime reads, and
`tests/oegpack-offline-product.test.mjs` pins strict manifest parsing with a
negative corpus, memory/HTTP-Range selection, explicit source failure, the
manifest-to-scene mapping and cross-pack rejection.

Implementation update (2026-09-17): virtual geometry now has a bounded GPU
demand copy in the existing Packed Visibility submission, scheduler-coupled
revoke/retire eviction with pinned and age-aware selection, automatic delayed
poll/upload from the unified frame completion boundary, and explicit
device-loss recovery that rebuilds active Product residency from retained CPU
source data. These are DEV-validated owner seams; they do not constitute the
S7 main/shadow Scene cutover or browser Runtime Validation.
Streaming runtime destruction now unregisters its Product generation before
discarding readback resources, cancelling pending page reads even when the
caller supplied an external scheduler; late results therefore cannot cross a
device-loss or scene-release boundary.

Product Scene publication update (2026-09-17): Product-backed instances now
publish directly through the unified `GpuScene`/`GpuRenderWorld` owner and are
consumed by the existing `MainRenderPipeline` and `PackedVisibilityPass`.
Product raster covers direct VisibilityKey and sparse ShadingBin MRT variants,
including UV0/UV1 pulling and TextureBindingSet-routed alpha-mask sampling.
Packed CSM now consumes the same Product hierarchy, generation and resident
banks through a Product MeshletWork depth consumer with the same UV0/UV1 and
TextureBindingSet alpha-mask sampling semantics. This remains DEV-validated only;
Product hierarchy page-demand records now carry an explicit shadow flag, and CSM
demand uses a separate delayed ring into the shared scheduler. ADR-0014 browser
evidence remains open.

更新时间：2026-09-18。本页是可变进度、开放风险和下一步的唯一汇总；历史结果由 Git 与 evidence artifact 保存。

## 生产基线

- 唯一 `Renderer -> MainRenderPipeline -> FrameGraph` 主管线承载 GPU Scene、hardware visibility、Sparse Shading Bin、lighting/effects、temporal 和 final output。
- `GpuAssetStore`、`GpuScene`、`GpuRenderWorld` 分离 Runtime Asset 与 GPU ownership，并使用显式 patch 和 revision publication。
- GPU hierarchy/work -> indirect raster -> VisibilityKey -> active-bin sparse shading 已是生产结构；旧 material class/tile backend 已删除。
- TextureAssetPackage V2、KTX2/libktx preparation、GPU-native variants、`TextureResidency` 与有界 `TextureBindingSet` 是当前纹理生产路径。
- 独立 `validation/` 宿主管理真实浏览器验证；现有 artifact 只证明其记录的 revision 和 workload。

## 虚拟化资产迁移

| 部分 | 状态 | 当前事实 | 下一出口 |
| --- | --- | --- | --- |
| Geometry Product V1 | in progress | 已落地 producer-neutral TS descriptor/page/provider mirror、严格 table/tree/bootstrap/activation validator、OEGPACK -> Product adapter，以及 Product-aware hierarchy/work/raster 接线；Product 现已进入统一 main/shadow consumer（VisibilityKey、Sparse Shading、Packed CSM depth），主视图与 CSM 均具备 UV0/UV1 与 TextureBindingSet alpha-mask 采样；`virtual-product-production` 与真实 GLB 的 `glb-web-product`（Dungeon，798 mesh/25 material）均已在当前 revision 的 Chrome 上 `accepted`；`glb-web-product` 已改为 256x256 HDR 覆盖率断言，并有 Native Offline <-> Web 结构化 differential 与不变量/负例 corpus；bank heap 已按 Product 总页数预分配 | 完成 demand/residency 与 lifecycle 的浏览器 MILESTONE，随后再补 transport/golden 后冻结候选 spec |
| Web Runtime Cooker 主路线 | in progress | 已加入严格 206/有预算 200 fallback 的 GLB Range source、按 accessor 精确 Range 的 compact scene catalog/cook units、source/WASM/output budget、取消与 whole-page credit lease、generation-filtered Dedicated Worker transport、CPU/WASM-only Worker host、异步 Emscripten module queueing、live Product provider、Range coalescing、progressive bootstrap + richer revision 与 per-domain cook。`portable-pool` 已实现固定 session ownership、crash generation invalidation 和 replacement Worker；`WebCookClient` 已把 source/WASM/output reservation 接入真实生命周期；`isolated-pthreads` 具备显式 cross-origin isolation/SAB capability gate，fallback 可观测；真实 Dungeon GLB 仍在 Chrome `accepted` | 尚需浏览器多 Worker 压力、pthread artifact 部署 smoke、source/canonical/WASM committed-peak 细粒度计数与后续 consumer cutover；不得把 Node fake module 或 TypeScript tests 视为 Runtime 完成 |
| 0016-A Offline/OEGPACK | implemented, S6 parity accepted | native cooker、OEGPACK V3 parser、range/memory source、页校验与 bootstrap cut 已存在；OEGPACK Product adapter 已通过共同 production consumer 接线；`load_oegpack_product` + `Renderer.uploadOegPackScene` 与 Web 路线共用同一 admission/residency/Visibility 路径，`virtual-product-offline` 已在 Chrome accepted（range/memory 平价 64105 lit pixels、source failure 显式报错、A→B 替换连续、demand 1→5 页）；`scene.oescene` 合同已入 spec，OEGPACK 专用 bootstrap residency adapter 已删除 | 补 transport/golden 后冻结候选 spec，并做 S7 consumer cutover |
| 0016-B admission/residency | in progress | 已抽出 Product-aware `VirtualGeometryResidency`，带 product generation、activation/page upload、16 B location table、pinned/retiring evidence；已冻结 `GeometryPageDemandV1` 与 Product GPU location TS/WGSL mirror，并加入严格 hash-verified scheduler、8 MiB upload sink、主视图与 CSM 分离的延迟 readback ownership ring；S1 Product hierarchy/work/raster producer、统一 main/shadow consumer、shadow demand flag、统一 frame completion 自动 poll/upload、保留 identity 的 device-loss residency 重建与 Product revision 原子替换已接线；bank heap 改按 Product 总页数预分配（修复 demand 上传新建未绑定 bank 导致的黑屏），并新增 Native↔Web differential / invariant / negative corpus；`glb-web-product` 已在 Chrome 里跑通 GPU demand 证据：实际相机靠近触发 desired page 缺失，GPU demand → delayed readback ring → scheduler（requested 2121、deduplicated 80）→ provider → upload → residency residentPages 374→375，且 ancestor fallback 保持画面（demand coverage 17394 lit pixels、0 GPU error）；`virtual-product-replacement` 已 accepted：richer revision 原子替换（generation 1→2、revision 0→1、换版后 5600+ lit pixels）+ demand 细化（382→383）+ 跨提交边界 evict（4 候选→379、evictedPages 4、17400 lit pixels）；`virtual-product-device-loss` 已 accepted：intentional device loss → 新 adapter/device → 从保留 Product source 重建全部场景（5640 → 5610 lit pixels、selectedClusters 474、visibleInstances 798、0 GPU error）| 补 transport/golden 后冻结候选 spec |
| 0016-C renderer cutover | in progress | Product 已迁移到统一 main/shadow hierarchy/work/raster 与 GPU identity，并可在 device-loss 后按原 generation/table slot 重建 publication；普通 Scene adapter/V2 owner 仍保留 | 完成 Product recovery checkpoint 的真实浏览器验证、删除旧 V2 owner/path，并用 ADR-0014 浏览器证据验证统一 consumer |
| 0016-D texture modes | Mode A implemented, diagnostic validation passed | TextureResidency allocates the complete logical chain, uploads a cooked mip tail first, clamps sampling to the available range, and promotes higher mips through a stable logical handle; the independent Chrome component case read back the expected tail and promoted colors, and this does not claim physical VRAM savings | Obtain production-path browser evidence for progressive publication; only after allocation evidence decide whether Mode B/Virtual Texturing merits a separate ADR |

详细交付切片见 [implementation/0016-virtualized-assets.md](./implementation/0016-virtualized-assets.md)。

## 开放 Gate

- 1920x1080、DPR 1、完整目标画质下 16.667 ms GPU 尚无当前 revision 的正式目标设备基线。
- resident、transient、history、shadow、upload 和 readback 预算仍需同条件真实浏览器证据。
- Sparse shading 的剩余 lifecycle、production-entry 和正式 PERF case 尚未全部关闭；不得把静态结构等同 Runtime Validated 或 Performance Improved。
- ADR-0013 的历史 baseline 冻结、Step 6 formal A/B、删除前后比较与相对收益门禁已以 `closed / requirement-removed` 关闭；当前 revision 的绝对 PERF 验收仍独立开放。
- Geometry Product 与 Virtual Geometry Runtime 仍是 draft；Product validator/adapter 与 Product-aware bootstrap heap 已有 DEV 实现，V3 geometry 已接入统一 Visibility/Sparse/CSM consumer，且 `virtual-product-production`、真实 GLB 的 `glb-web-product`、`virtual-product-replacement` 与 `virtual-product-device-loss` 均已在 Chrome accepted。仍需补 transport/golden 后再冻结候选 spec，OEGPACK ABI 因此仍是 candidate。
- S1 的 `virtual-product-production` 已在当前 revision 通过 Chrome HDR readback（`evidenceStatus: accepted`）；`virtual-geometry-component` 仍是 diagnostic-only 的 WGSL ABI 解码。两者都不替代真实 GLB/demand 证据，也不作为 S2/S3/S4 完成证据。
- Web Cooker 的 `portable-pool` 已具备 Dedicated Worker ownership、generation failure recovery 和 targeted conformance；pthread 变体已构建并由 `crossOriginIsolated && SharedArrayBuffer` capability gate 选择，validation host 提供 COOP/COEP headers，`glb-web-product-isolated-pthreads` authored-texture deployment smoke 已通过。该 smoke 是当前 dirty 工作树上的 diagnostic-only 证据，不是性能结论；cross-origin isolation 不是 correctness 前提。
- ADR-0016 §18.4 的 “Native Nyx 参考输出” 尚未产出：上游 `MeshletBuilder.cpp` 依赖整个 MiniEngine（`pch.h`/`Renderer.h`/`glTFLoader.h`/DX12/Slang 类型），当前仓库无法构建可运行的 Nyx 参考二进制；该腿暂以函数级映射 + 固定源 hash + 不变量 checklist 代替，Native↔Web 等价性单独验证。
- `shader-f16`、Immediate Data 与 Transient Attachment 没有生产 consumer；`primitive-index` 等 specialization 只按真实 capability 启用。
- 普通 Scene adapter 不支持 `SkinnedMesh`；完整动画/蒙皮仍 deferred。

## 下一步

1. 做 S7 Geometry consumer cutover：迁移 `GpuAssetStore`/`GpuRenderWorld` recovery、asset publication 与 shadow consumer，删除 V2 `GeometryAssetPackage`/upload/consumer 与生产调用，并完成 source/compiled/browser 三层 legacy 审计。
2. 补 `portable-pool`/多 asset shard assembly 的浏览器压力与 source/WASM committed-peak 细粒度证据，并在 clean commit 上重跑 pthread deployment smoke。
3. 产出 §18.4 的 Native Nyx 参考 harness（独立 MiniEngine Model harness 或抽取 Nyx 算法函数的 native 构建）。
4. S6 Offline production parity 的成功路径已 accepted；继续补同 workload 对照和 source-selection 边界，再在失败事务、Nyx 对照与入口切换门禁通过后执行 S7 V2 删除和三层 legacy 审计。
5. 纹理先验证 Mode A 渐进传输的生产路径证据；只有真实 allocation 证据支持时再实施 Mode B 或另立 Virtual Texturing ADR。

## 2026-09-19 Web Cook S4 checkpoint

`portable-pool` 已实现为真实 Dedicated Worker pool：CookSession generation 固定绑定 Worker，Worker 崩溃或 `messageerror` 只使所属 generation 失效并发布 `FatalSessionFailure`，失效 generation 不复用 descriptor/page，slot 会补建 replacement Worker。`WebCookClient` 已把 page-global ledger 的 source/WASM reservation 接入 session admission、catalog source 生命周期和 fatal/cancel/dispose 清理，output/source/WASM 三类 owner 的峰值、拒绝与等待计数可从 evidence 观察。`isolated-pthreads` 选择现在经过显式 `crossOriginIsolated`/`SharedArrayBuffer` capability gate；不满足时报告 portable fallback，不把 fallback 冒充 pthread。

S4 当前验证为 OEngine typecheck/build:test、Web Cook budget/client/host/pool/multi-session targeted tests（17/17）。4-session pressure 覆盖 active/waiting session、priority admission、cancel/dispose race 与 source/WASM/output peak，发现并修复了等待 lease 在 dispose 竞态下泄漏的问题。portable-pool 与 isolated-pthreads 均有浏览器 smoke；尚未把浏览器多 asset 压力和 source/WASM committed-peak 细粒度计数标记为 Runtime Validated，这些仍是后续 workload/PERF 证据。

## 2026-09-17 Product S1 checkpoint

The unified Product production case and the real-GLB `glb-web-product` case both
pass in Chrome on the current revision with HZB enabled: a validated Product
reaches GPU hierarchy/work, Product MeshletWork, hardware raster, VisibilityKey
and sparse shading. `glb-web-product` additionally asserts 256x256 linear-HDR
coverage (5610/65536 lit pixels) so a black frame fails. Product consumers use
four fixed page-bank bindings and therefore require an explicit
`maxStorageBuffersPerShaderStage >= 14` capability request before admission;
the residency now pre-allocates every bank the Product page table can reach.

## 2026-09-19 Web S2 实现检查点

Web source path 现在具备 catalog-first handshake 和有界 visible-first
bootstrap 调度。`GlbSceneCatalog` 发布稳定 primitive key、保守 bounds 和
catalog index；`WebCookWorkerHost` 在启动 Cook 前 flush 这些 metadata；
`WebCookClient` 可以注入初始 source priority。`NyxWebRuntimeCooker` 仍执行
完整 Nyx canonical 与 WASM cook 阶段，按 unit 的 range 合并只限制 source
reader 的占用。`sceneAssetIndices` 作为 Web-only mapping metadata 校验并传输，
`MainRenderPipeline` 映射 subset revision 时不会把它当成完整 catalog。
DEV typecheck、test build、cooker/coordinator/provider/worker/admission targeted
tests，以及双 primitive visible-first coordinator test 已通过。2026-09-19
真实 Chrome 多 asset visible-first case 已通过：catalog 为 798 个 primitive，
首个 bootstrap Product 先激活，随后 revision 1 通过 `replaces` 原子替换；首帧
与 replacement 后 demand capture 均有有效像素，未观察到 recoverable Cook failure。
浏览器 artifact 仍标记为 dirty diagnostic-only，不能替代干净提交上的正式
milestone 证据。

## Mode A texture update

TextureResidency now allocates the complete logical texture once, uploads a
cooked mip tail first, and exposes generation-safe `promote()` for higher mip
uploads. The descriptor publishes `residentMipRange` only after the owning GPU
command is submitted, while evidence records actual progressive upload bytes and
promotion counts. Alpha-mask packages keep the full chain for the current mip0
coverage consumer. The independent Chrome component case now verifies tail and
promoted sampling with GPU readback; production-path publication evidence remains
open.
## 0016 第三步检查（2026-09-19）

第三步已完成：GLB/`.gltf`、外部 buffer/image、data URI、File/Blob、有界 Range/200 fallback、取消和 source identity；sparse/interleaved/normalized/non-indexed accessor；作者 PBR texture slot、UV transform、sampler、image metadata；以及 Web Product mapper 到 `TextureResidency`/`TextureBindingSet` 的异步原子接线。`extensionsRequired`、Draco、`EXT_meshopt_compression`、skin/morph 等未支持 profile 会明确失败。`glb-web-product-authored-texture` 真实 Chrome case 已在 clean commit 上 accepted：五个 PBR 槽位、`MASK`、TextureResidency resident page、runtime mip 和真实像素均有 artifact；41 个 targeted tests 覆盖 Mode A promotion、失败回滚、代际复用、容量与 feature-off。

第三步现已具备实现与验证证据，但不等同于 ADR Complete：当前 authored case 是单三角形/单 page 的材质生产连接验证，replacement/device-loss 证据来自共享 Product 生命周期门禁；多材质、大场景和正式 PERF 仍未验证。Mode A 仍只表示网络读取和上传渐进，不表示物理显存节省。
