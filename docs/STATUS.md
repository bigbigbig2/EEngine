# OEngine 当前状态

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

更新时间：2026-09-17。本页是可变进度、开放风险和下一步的唯一汇总；历史结果由 Git 与 evidence artifact 保存。

## 生产基线

- 唯一 `Renderer -> MainRenderPipeline -> FrameGraph` 主管线承载 GPU Scene、hardware visibility、Sparse Shading Bin、lighting/effects、temporal 和 final output。
- `GpuAssetStore`、`GpuScene`、`GpuRenderWorld` 分离 Runtime Asset 与 GPU ownership，并使用显式 patch 和 revision publication。
- GPU hierarchy/work -> indirect raster -> VisibilityKey -> active-bin sparse shading 已是生产结构；旧 material class/tile backend 已删除。
- TextureAssetPackage V2、KTX2/libktx preparation、GPU-native variants、`TextureResidency` 与有界 `TextureBindingSet` 是当前纹理生产路径。
- 独立 `validation/` 宿主管理真实浏览器验证；现有 artifact 只证明其记录的 revision 和 workload。

## 虚拟化资产迁移

| 部分 | 状态 | 当前事实 | 下一出口 |
| --- | --- | --- | --- |
| Geometry Product V1 | in progress | 已落地 producer-neutral TS descriptor/page/provider mirror、严格 table/tree/bootstrap/activation validator、OEGPACK -> Product adapter，以及 Product-aware hierarchy/work/raster 接线；Product 现已进入统一 main/shadow consumer（VisibilityKey、Sparse Shading、Packed CSM depth），主视图与 CSM 均具备 UV0/UV1 与 TextureBindingSet alpha-mask 采样；`virtual-product-production` 已在当前 revision 的 Chrome 上以 HZB enabled 通过 Product -> admission/residency -> GPU hierarchy/work/raster -> VisibilityKey -> sparse shading 的真实 HDR readback（`evidenceStatus: accepted`），真实 GLB 与 demand 像素闭环仍待验证 | 完成 Product raster/shadow 的真实 GLB 与 demand 证据，随后再补 transport/golden 后冻结候选 spec |
| Web Runtime Cooker 主路线 | in progress | 已加入严格 206/有预算 200 fallback 的 GLB Range source、按 accessor 精确 Range 的 compact scene catalog/cook units、带 source/WASM/output budget、取消与 whole-page credit lease 的 `WebCookCoordinator`、generation-filtered Dedicated Worker transport、CPU/WASM-only `WebCookWorkerHost`、异步 Emscripten module queueing 的 `WebCookWorkerEntry`、live Product provider，以及 container-neutral decoded Product assembly；S2b 已交付完整有界 GLB primitive canonicalization（interleaved/normalized/index/material/defaults）、Nyx Web Runtime Cooker adapter、Product content-manifest identity 与 page hash 校验、canonicalizer/credit pause/adapter tests。真实 Emscripten module/wasm artifact 已入库并经 `createDefaultWebCookWorker`/`WebCookWorkerEntrypoint` 接入 Dedicated Worker，`WebCookClient`/`WebCookRuntimeAsset`/`load_gltf_web_product` 提供运行时 facade，`RequestPages` 已路由到 Worker；仍缺 portable-pool/isolated-pthreads、真实 GLB 浏览器像素证据与 demand 端到端证据 | 完成真实 GLB Worker bootstrap Product -> 同一生产像素路径与 demand 证据；不得把 native ABI oracle、Node fake module 或 TypeScript tests 视为 S2 Runtime 完成 |
| 0016-A Offline/OEGPACK | implemented, validation open | native cooker、OEGPACK V3 parser、range source、页校验和 bootstrap residency proof 已存在；OEGPACK Product adapter 已通过共同 production consumer 接线 | 用 ADR-0014 浏览器证据验证并冻结候选 spec |
| 0016-B admission/residency | in progress | 已抽出 Product-aware `VirtualGeometryResidency`，带 product generation、activation/page upload、16 B location table、pinned/retiring evidence；已冻结 `GeometryPageDemandV1` 与 Product GPU location TS/WGSL mirror，并加入严格 hash-verified scheduler、8 MiB upload sink、主视图与 CSM 分离的延迟 readback ownership ring；S1 Product hierarchy/work/raster producer、统一 main/shadow consumer、shadow demand flag、统一 frame completion 自动 poll/upload 与保留 identity 的 device-loss residency 重建已接线；浏览器 demand/residency 证据仍未完成 | 用 ADR-0014 真实浏览器证据验证 activation cut、GPU demand -> delayed readback -> provider -> upload -> generation publication 闭环 |
| 0016-C renderer cutover | in progress | Product 已迁移到统一 main/shadow hierarchy/work/raster 与 GPU identity，并可在 device-loss 后按原 generation/table slot 重建 publication；普通 Scene adapter/V2 owner 仍保留 | 完成 Product recovery checkpoint 的真实浏览器验证、删除旧 V2 owner/path，并用 ADR-0014 浏览器证据验证统一 consumer |
| 0016-D texture modes | Mode A implemented, diagnostic validation passed | TextureResidency allocates the complete logical chain, uploads a cooked mip tail first, clamps sampling to the available range, and promotes higher mips through a stable logical handle; the independent Chrome component case read back the expected tail and promoted colors, and this does not claim physical VRAM savings | Obtain production-path browser evidence for progressive publication; only after allocation evidence decide whether Mode B/Virtual Texturing merits a separate ADR |

详细交付切片见 [implementation/0016-virtualized-assets.md](./implementation/0016-virtualized-assets.md)。

## 开放 Gate

- 1920x1080、DPR 1、完整目标画质下 16.667 ms GPU 尚无当前 revision 的正式目标设备基线。
- resident、transient、history、shadow、upload 和 readback 预算仍需同条件真实浏览器证据。
- Sparse shading 的剩余 lifecycle、production-entry 和正式 PERF case 尚未全部关闭；不得把静态结构等同 Runtime Validated 或 Performance Improved。
- ADR-0013 的历史 baseline 冻结、Step 6 formal A/B、删除前后比较与相对收益门禁已以 `closed / requirement-removed` 关闭；当前 revision 的绝对 PERF 验收仍独立开放。
- Geometry Product 与 Virtual Geometry Runtime 仍是 draft；Product validator/adapter 与 Product-aware bootstrap heap 已有 DEV 实现，V3 geometry 已接入统一 Visibility/Sparse/CSM consumer，但尚无 ADR-0014 真实浏览器像素证据，因此 OEGPACK ABI 仍是 candidate。
- S1 的 `virtual-product-production` 已在当前 revision 通过 Chrome HDR readback（`evidenceStatus: accepted`）；`virtual-geometry-component` 仍是 diagnostic-only 的 WGSL ABI 解码。两者都不替代真实 GLB/demand 证据，也不作为 S2/S3/S4 完成证据。
- Web Cooker 的 pthread/SAB 与多 Worker specialization 尚无同 workload 证据；cross-origin isolation 不是 correctness 前提，默认执行 profile 暂未冻结。
- `shader-f16`、Immediate Data 与 Transient Attachment 没有生产 consumer；`primitive-index` 等 specialization 只按真实 capability 启用。
- 普通 Scene adapter 不支持 `SkinnedMesh`；完整动画/蒙皮仍 deferred。

## 下一步

1. 按 0016 S1 先完成 `OEGPACK -> Geometry Product -> production Visibility`，以最短路径冻结共同 consumer 边界；这不改变 Web Runtime-first 的产品优先级。
2. 完成 S2/S3 的 `GLB Range -> Worker/WASM bootstrap/richer Product` 与联合背压，再接 S4 GPU demand/residency 闭环。
3. 补齐 replacement/eviction/device-loss 后迁移 main、shadow、普通 Scene adapter；删除前完成 source、compiled graph/shader 与 browser counter 三层审计。
4. 纹理先验证 Mode A 渐进传输；只有真实 allocation 证据支持时再实施 Mode B 或另立 Virtual Texturing ADR。

## 2026-09-17 Product S1 checkpoint

The unified Product production case now passes in Chrome with HZB enabled: a
validated one-page Product reaches GPU hierarchy/work, Product MeshletWork,
hardware raster, VisibilityKey, and sparse shading. The case remains
diagnostic-only because its source is an in-browser legal Product fixture and
the worktree is not a clean milestone revision. Product consumers use four
fixed page-bank bindings and therefore require an explicit
`maxStorageBuffersPerShaderStage >= 14` capability request before admission;
the current unified sparse shader retains three ordinary geometry buffers while
the Product specialization is compiled, in addition to Product metadata and
four fixed page-bank bindings.

## Mode A texture update

TextureResidency now allocates the complete logical texture once, uploads a
cooked mip tail first, and exposes generation-safe `promote()` for higher mip
uploads. The descriptor publishes `residentMipRange` only after the owning GPU
command is submitted, while evidence records actual progressive upload bytes and
promotion counts. Alpha-mask packages keep the full chain for the current mip0
coverage consumer. The independent Chrome component case now verifies tail and
promoted sampling with GPU readback; production-path publication evidence remains
open.
