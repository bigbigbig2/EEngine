# OEngine 当前状态

S6 consumer cutover（2026-09-19）已完成：默认 `load_gltf()`、普通 Scene、Offline selection、examples/validation consumer、主视图/阴影/Visibility 和 device-loss recovery 均走 Product Runtime；当前 revision 的 replacement 与 device-loss Chrome case 已通过。`GeometryAssetPackage`、`GeometryCooker`、`GpuAssetStore` 等仍被内部 shader/oracle/ABI/test 引用的代码保留为内部验证资产，公开 entry 已移除 V2 production symbols。S6/S7 已提交到干净 revision `20c4757`，本轮 `virtual-product-observer` 等 artifact 的 `provenance.dirty` 为 false，可按 ADR-0014 记为 accepted；更早在 dirty 工作树上取得的 artifact 仍只作 `diagnostic-only`。

Historical audit correction (2026-09-18, `64f346d`): the accepted browser
cases at that revision proved successful Product publication, GPU demand,
replacement, eviction and device-loss paths, but not failure-atomic
replacement or large-scene visible-first loading. The S6 revision supersedes
that snapshot: replacement failures are now covered by the current browser
case, the default public entry and unified consumer are cut over, while
large-scene visible-first loading and measured source/canonical/WASM peaks
remain S7 work. The seven delivery stages and their evidence are tracked in
[0016 remaining-work plan](./implementation/0016-remaining-work-plan.md).
Earlier “atomic” and “per-domain parallel” wording below should be read against
the dated revision that introduced it; current S6 evidence is recorded above.

Implementation update (2026-09-18): the Runtime-first Web route now runs a real
GLB end to end. `run:glb-web-product` drives the Dungeon (798 mesh / 25
material) through the pinned Emscripten Worker cooker, the shared Product
admission and `MainRenderPipeline`, and is accepted on the current revision with
a 256x256 linear-HDR coverage assertion (5610/65536 lit pixels), so a black
frame can no longer pass. The route offers a complete coarse bootstrap revision
first, freezes the richer revision's descriptor ahead of its payload, streams
that revision's activation cut, then produces the remaining pages on GPU demand
inside the same revision; the revision still swaps atomically
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

S5 incremental-publication update (2026-09-19): `run:glb-incremental-publication`
adds the ADR-0017 case. It loads the Rendering Lab Dungeon
(`examples/assets/three/rendering-lab/dungeon_warkarma.glb`) and asserts the
increment contract directly instead of inferring it from a swap: the bootstrap
activation cut must be fully resident before any demand arrives and must cover
fewer pages than the model owns, and the richer revision's pages must keep
arriving through the GPU demand path (`scheduler.requested >= 1`) with
`residentPages` strictly increasing. The scene must stay drawable during demand
(256x256 linear-HDR coverage floor) and
`WebCookClientEvidence.recoverableFailures` must stay 0, which is the criterion
for "a payload-stage failure does not disturb already published pages".
Cook credits are raised to `initialOutputPageCredits 256` /
`maxBufferedPages 256` / `maxOutputBytes 256 MiB` in this case so the known
step-3 credit ceiling cannot bottleneck the measurement.

Building that case surfaced four product defects that the existing cases had been
masking, all fixed on this revision: (1) image-source availability was keyed off
the cook session state instead of the handle's own lifetime, so the replacement
revision's material mapping was rejected after the cook had legitimately reached
`complete`; (2) `WebCookClient.revisions()` treated a consumer-side throw as a
fatal session error, amplifying (1) into a whole-session failure; (3) the
replacement window decoded and residentiated every authored texture twice,
pushing the 2048px texture bank to 33 layers over its 32-layer policy ceiling,
now shared per image index for the scene lifetime; (4) `PageReady` transfers its
payload ArrayBuffer while the plan-backed page source was using the same buffer
as its cache, so a re-demand of an already produced page returned 0 bytes, now
fixed by handing out `slice(0)` copies. Defects (1) and (2) never fire on
`glb-web-product` because its 32-page credit window stops before the replacement
mapping, and (4) never fires on the monolithic path because its payload is fully
materialised up front.

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

更新时间：2026-09-19。本页是可变进度、开放风险和下一步的唯一汇总；历史结果由 Git 与 evidence artifact 保存。

## 生产基线

- 唯一 `Renderer -> MainRenderPipeline -> FrameGraph` 主管线承载 GPU Scene、hardware visibility、Sparse Shading Bin、lighting/effects、temporal 和 final output。
- `GpuAssetStore`、`GpuScene`、`GpuRenderWorld` 分离 Runtime Asset 与 GPU ownership，并使用显式 patch 和 revision publication。
- GPU hierarchy/work -> indirect raster -> VisibilityKey -> active-bin sparse shading 已是生产结构；旧 material class/tile backend 已删除。
- TextureAssetPackage V2、KTX2/libktx preparation、GPU-native variants、`TextureResidency` 与有界 `TextureBindingSet` 是当前纹理生产路径。
- 独立 `validation/` 宿主管理真实浏览器验证；现有 artifact 只证明其记录的 revision 和 workload。

## 虚拟化资产迁移

| 部分 | 状态 | 当前事实 | 下一出口 |
| --- | --- | --- | --- |
| Geometry Product V1 | in progress | 已落地 producer-neutral TS descriptor/page/provider mirror、严格 table/tree/bootstrap/activation validator、OEGPACK -> Product adapter，以及 Product-aware hierarchy/work/raster 接线；Product 现已进入统一 main/shadow consumer（VisibilityKey、Sparse Shading、Packed CSM depth），主视图与 CSM 均具备 UV0/UV1 与 TextureBindingSet alpha-mask 采样；`virtual-product-production` 与真实 GLB 的 `glb-web-product`（Dungeon，798 mesh/25 material）均已在当前 revision 的 Chrome 上 `accepted`；`glb-web-product` 已改为 256x256 HDR 覆盖率断言，并有 Native Offline <-> Web 结构化 differential 与不变量/负例 corpus；GPU 几何页已改为 Device 级共享 `GeometryProductSlotPool`（4 × 128 MiB bank、256 KiB 页、2048 slot），不再按 Product 预分配 | 完成 demand/residency 与 lifecycle 的浏览器 MILESTONE，随后再补 transport/golden 后冻结候选 spec |
| Web Runtime Cooker 主路线 | in progress | 已加入严格 206/有预算 200 fallback 的 GLB Range source、按 accessor 精确 Range 的 compact scene catalog/cook units、source/WASM/output budget、取消与 whole-page credit lease、generation-filtered Dedicated Worker transport、CPU/WASM-only Worker host、异步 Emscripten module queueing、live Product provider、Range coalescing、progressive bootstrap + richer revision 与 per-domain cook；bootstrap 仍走单体式 `cookCanonical`（首帧必须完整 resident），richer revision 走两阶段 `planCanonical`，即 descriptor 先冻结、activation cut 先产出、其余 page 按 GPU demand 在同 revision 内增量产出。`portable-pool` 已实现固定 session ownership、crash generation invalidation 和 replacement Worker；`WebCookClient` 已把 source/WASM/output reservation 接入真实生命周期；`isolated-pthreads` 具备显式 cross-origin isolation/SAB capability gate，fallback 可观测；真实 Dungeon GLB 仍在 Chrome `accepted` | 尚需浏览器多 Worker 压力、pthread artifact 部署 smoke、source/canonical/WASM committed-peak 细粒度计数与后续 consumer cutover；不得把 Node fake module 或 TypeScript tests 视为 Runtime 完成 |
| 0016-A Offline/OEGPACK | implemented, S6 parity accepted | native cooker、OEGPACK V3 parser、range/memory source、页校验与 bootstrap cut 已存在；OEGPACK Product adapter 已通过共同 production consumer 接线；`load_oegpack_product` + `Renderer.uploadOegPackScene` 与 Web 路线共用同一 admission/residency/Visibility 路径，`virtual-product-offline` 已在 Chrome accepted（range/memory 平价 64105 lit pixels、source failure 显式报错、A→B 替换连续、demand 1→5 页）；`scene.oescene` 合同已入 spec，OEGPACK 专用 bootstrap residency adapter 已删除 | 补 transport/golden 后冻结候选 spec，并做 S7 consumer cutover |
| 0016-B admission/residency | in progress | 已抽出 Product-aware `VirtualGeometryResidency`，带 product generation、activation/page upload、16 B location table、pinned/retiring evidence；已冻结 `GeometryPageDemandV1` 与 Product GPU location TS/WGSL mirror，并加入严格 hash-verified scheduler、8 MiB upload sink、主视图与 CSM 分离的延迟 readback ownership ring；S1 Product hierarchy/work/raster producer、统一 main/shadow consumer、shadow demand flag、统一 frame completion 自动 poll/upload、保留 identity 的 device-loss residency 重建与 Product revision 原子替换已接线；page 何时被产生现在是可调度维度（ADR-0017 两阶段 producer），但 admission/residency/eviction/demand 回读/预算这套消费侧分层未变；bank heap 改为 Device 级共享 `GeometryProductSlotPool`（`VirtualGeometryResidency` 通过 `retain()` 共享 4 × 128 MiB bank，替代按 Product 预分配，修复 demand 上传新建未绑定 bank 导致的黑屏），并新增 Native↔Web differential / invariant / negative corpus；`glb-web-product` 已在 Chrome 里跑通 GPU demand 证据：实际相机靠近触发 desired page 缺失，GPU demand → delayed readback ring → scheduler（requested 2121、deduplicated 80）→ provider → upload → residency residentPages 374→375，且 ancestor fallback 保持画面（demand coverage 17394 lit pixels、0 GPU error）；`virtual-product-replacement` 已 accepted：richer revision 原子替换（generation 1→2、revision 0→1、换版后 5600+ lit pixels）+ demand 细化（382→383）+ 跨提交边界 evict（4 候选→379、evictedPages 4、17400 lit pixels）；`virtual-product-device-loss` 已 accepted：intentional device loss → 新 adapter/device → 从保留 Product source 重建全部场景（5640 → 5610 lit pixels、selectedClusters 474、visibleInstances 798、0 GPU error）；`glb-incremental-publication`：activation cut 完整性、demand 驱动增量产出与 payload 阶段失败隔离均已在真实 Chrome 上 passed，待 clean revision 复采以取得 accepted 级证据；该 case 同时暴露并修复了贴图可用性判据、消费者错误归属、替换期贴图重复驻留、plan-backed page buffer 被 transfer detach 四个缺陷 | 补 transport/golden 后冻结候选 spec |
| 0016-C renderer cutover | implemented, S6 diagnostic complete | Product 已迁移到统一 main/shadow hierarchy/work/raster 与 GPU identity，并可在 device-loss 后按原 generation/table slot 重建 publication；默认 `load_gltf()`、普通 Scene、Offline selection 和 examples/validation consumer 均已切换，公开 V2 production symbols 已删除 | 在 clean commit 上重跑 ADR-0014 milestone；完成仍有内部消费者的旧 oracle source/compiled/browser 三层审计后再删除 |
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
- ADR-0016 §18.4 的 “Native Nyx 参考输出” 已由 `9ae29ed` 补齐：`tools/build-nyx-reference-harness.mjs` 在只读临时目录独立编译原版 `MeshletBuilder.cpp`（当前 revision 实测输出 46 meshlets / 4030 triangles、deterministic、空输入拒绝、seam 与 sloppy simplification fallback 均已覆盖），`build-nyx-model-convert-reference-harness.mjs` 抽取并运行原版 `WalkGraph`/`ParallelCompileMeshes`/`BuildModel`，`build-nyx-shader-reference-harness.mjs` 用 Nyx 自带 Slang 2026.10 把原版 `DAGCull.slang`/`VBufferMesh.slang` 编译到 SPIR-V 并做 entry-point/reflection 检查；`npm run audit:nyx-function-map` 返回 `externalAlgorithmComplete: true`。保留的平台边界：不运行原版 DX12 MiniEngine 整体工程，`SaveModel` 的 Windows 文件映射只做原版分支 source-audit，不比较 DX12/WebGPU 字节布局。
- `shader-f16`、Immediate Data 与 Transient Attachment 没有生产 consumer；`primitive-index` 等 specialization 只按真实 capability 启用。
- 普通 Scene adapter 不支持 `SkinnedMesh`；完整动画/蒙皮仍 deferred。

## 下一步

1. 做 S7 Geometry oracle deletion audit：对仍被 shader/ABI/test 引用的 `GeometryAssetPackage`/`GeometryCooker`/`GpuAssetStore` 做 source/compiled/browser 三层调用图审计，确认无真实生产消费者后再删除；不得把内部 oracle 当作公开 fallback。
2. 补 `portable-pool`/多 asset shard assembly 的浏览器压力与 source/WASM committed-peak 细粒度证据，并在 clean commit 上重跑 pthread deployment smoke。
3. 产出 §18.4 的 Native Nyx 参考 harness（独立 MiniEngine Model harness 或抽取 Nyx 算法函数的 native 构建）。
4. S6 Offline production parity 的成功路径已 accepted；继续补同 workload 对照和 source-selection 边界，再在失败事务、Nyx 对照与入口切换门禁通过后执行 S7 V2 删除和三层 legacy 审计。
5. 纹理先验证 Mode A 渐进传输的生产路径证据；只有真实 allocation 证据支持时再实施 Mode B 或另立 Virtual Texturing ADR。

## 2026-09-19 Web Cook S4 checkpoint

`portable-pool` 已实现为真实 Dedicated Worker pool：CookSession generation 固定绑定 Worker，Worker 崩溃或 `messageerror` 只使所属 generation 失效并发布 `FatalSessionFailure`，失效 generation 不复用 descriptor/page，slot 会补建 replacement Worker。`WebCookClient` 已把 page-global ledger 的 source/WASM reservation 接入 session admission、catalog source 生命周期和 fatal/cancel/dispose 清理，output/source/WASM 三类 owner 的峰值、拒绝与等待计数可从 evidence 观察。`isolated-pthreads` 选择现在经过显式 `crossOriginIsolated`/`SharedArrayBuffer` capability gate；不满足时报告 portable fallback，不把 fallback 冒充 pthread。

S4 当前验证为 OEngine typecheck/build:test、Web Cook budget/client/host/pool/multi-session targeted tests（17/17）。4-session pressure 覆盖 active/waiting session、priority admission、cancel/dispose race 与 source/WASM/output peak，发现并修复了等待 lease 在 dispose 竞态下泄漏的问题。`glb-web-product-portable-pool` 与 `glb-web-product-isolated-pthreads` 均已在 clean commit 上 browser accepted；浏览器多 asset 压力和 source/WASM committed-peak 细粒度计数仍属于后续 workload/PERF 证据，不作为 S4 correctness/ownership 阻塞项。

## 2026-09-17 Product S1 checkpoint

The unified Product production case and the real-GLB `glb-web-product` case both
pass in Chrome on the current revision with HZB enabled: a validated Product
reaches GPU hierarchy/work, Product MeshletWork, hardware raster, VisibilityKey
and sparse shading. `glb-web-product` additionally asserts 256x256 linear-HDR
coverage (5610/65536 lit pixels) so a black frame fails. Product consumers use
four fixed page-bank bindings and therefore require an explicit
`maxStorageBuffersPerShaderStage >= 16` capability request before admission
(the highest consumer variant consumes fifteen storage bindings, so the code
requests the next aligned device limit); the residency now shares one
device-level `GeometryProductSlotPool` across Products instead of
pre-allocating banks per Product page table.

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
首个 bootstrap Product 先激活，随后 revision 1 先冻结 descriptor、stream
activation cut，其余 page 由 GPU demand 在同 revision 内增量产出；首帧
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

## 2026-09-19 clean revision 证据基线（a6b730a / 1e48456）

本页补充干净 revision 上的同 revision 浏览器证据基线。`validation/src/runner/run-case.mjs` 用 `git status --porcelain` 判定 `provenance.dirty`，任何未提交改动（含文档）都会把 artifact 降级为 `diagnostic-only`；因此此前记录在 dirty 工作树上的数值不能直接当作当前基准。下表数值均为 `dirty: false`、`evidenceStatus: accepted`。

对 `9ae29ed`、`a6b730a`、`1e48456`（后两者仅差文档）三次运行做对比后，数值分为两类。

**跨 revision 可复现，可安全引用：**

| Case | 数值 |
| --- | --- |
| `glb-web-product` | coverage 256×256 litPixels 12023/65536；demandCoverage 31025/65536；residentBefore 374 → residentAfter 375 |
| `virtual-product-observer` | 128×128、5888 lit pixels ×2（bootstrap + cameraCut） |

**随运行时序变化，引用时必须注明是单次观测：**

| Case | 观测范围 |
| --- | --- |
| `glb-web-product` | demand scheduler requested 269 / 355 / 957（取决于帧时序与相机停留时长）；admission offered 2 / activated 1 / rejected 0 |
| `virtual-product-device-loss` | residentPages 417 / 419 / 431；litPixels 12418 → 12418 |
| `virtual-product-production` | activeSceneRevision 1 / activePublicationRevision 2 |
| `virtual-product-replacement` | bootstrap generation 1 / revision 0，随后原子换版 |
| `virtual-product-offline` | range 与 memory 选择同 `productId`、同 activation cut |

`glb-web-product` 与 `virtual-product-device-loss` 的覆盖率门禁是 `litPixels < 64` 才失败（见 `validation/src/cases/glb-web-product/main.ts` 第 377 行），所以更早记录的 5610 / 5640 是当时的**实测值**而不是门禁值。引用任何覆盖率数字都必须写明其 revision。

`OEngine` 侧同一 revision：`npm run typecheck` 通过，`node --test tests/*.test.mjs` 414/414 通过。

## 2026-09-19 S7 用户模型观察器

已新增 `validation/src/cases/virtual-product-observer` production case，并注册为 `virtual-product-observer-v1`。该页面统一承载 Web GLB/glTF 与 Offline OEGPACK 两条 producer，支持 URL、Web File/Blob、runtime profile、Load/Cancel/Replace、camera close/cut、source failure 和显式 device-loss recovery；两条 producer 都通过共享 Product admission/residency 与 Main/Visibility consumer。

页面和 runner artifact 记录 catalog、bootstrap/first meaningful frame、revision/generation、source/WASM/output budget、GPU capability、GPUBuffer/residency、resident/pinned/retiring、demand/fallback/overflow、材质/纹理状态、GPU/console errors 以及有限 HDR numeric readback。Offline File 没有显式 manifest 时会拒绝，不会伪造 pack 来源。当前仅完成用户观察入口和 bounded smoke 设计；正式大场景 TTFMF、跨多 asset source/canonical/WASM/output 峰值、1920x1080 PERF 和 60 FPS/物理显存结论仍为“未验证”。
