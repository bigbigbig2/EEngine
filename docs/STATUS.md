# OEngine 当前状态

Implementation update (2026-09-17): virtual geometry now has a bounded GPU
demand copy in the existing Packed Visibility submission, scheduler-coupled
revoke/retire eviction with pinned and age-aware selection, and explicit
device-loss recovery that rebuilds active Product residency from retained CPU
source data. These are DEV-validated owner seams; they do not constitute the
S7 main/shadow Scene cutover or browser Runtime Validation.

Product Scene publication update (2026-09-17): Product-backed instances now
publish directly through the unified `GpuScene`/`GpuRenderWorld` owner and are
consumed by the existing `MainRenderPipeline` and `PackedVisibilityPass`.
Product raster covers direct VisibilityKey and sparse ShadingBin MRT variants.
Packed CSM now consumes the same Product hierarchy, generation and resident
banks through a Product MeshletWork depth consumer. This remains DEV-validated
only; complete renderer device-loss recovery and ADR-0014 browser evidence
remain open.

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
| Geometry Product V1 | in progress | 已落地 producer-neutral TS descriptor/page/provider mirror、严格 table/tree/bootstrap/activation validator、OEGPACK -> Product adapter，以及 Product-aware hierarchy/work/raster 接线；Product 现已进入统一 main/shadow consumer（VisibilityKey、Sparse Shading、Packed CSM depth）；真实 Chrome GPU metadata/page/group/meshlet oracle 已通过，最终像素闭环仍待真实浏览器验证 | 完成 Product raster/shadow 的真实浏览器闭环与 demand evidence，随后再补 transport/golden 后冻结候选 spec |
| Web Runtime Cooker 主路线 | in progress | 已加入严格 206/有预算 200 fallback 的 GLB Range source、按 accessor 精确 Range 的 compact scene catalog/cook units、带 source/WASM/output budget、取消与 whole-page credit lease 的 `WebCookCoordinator`、generation-filtered Dedicated Worker transport、CPU/WASM-only `WebCookWorkerHost`、异步 Emscripten module queueing 的 `WebCookWorkerEntry`、live Product provider，以及 container-neutral decoded Product assembly；S2b 已交付完整有界 GLB primitive canonicalization（interleaved/normalized/index/material/defaults）、Nyx Web Runtime Cooker adapter、Product content-manifest identity 与 page hash 校验、canonicalizer/credit pause/adapter tests。browser-first target 仍无真实 Emscripten artifact 与同一生产像素路径 | 完成真实 Emscripten build 与 Worker bootstrap Product -> 同一生产像素路径；不得把 native ABI oracle、Node fake module 或 TypeScript tests 视为 S2 Runtime 完成 |
| 0016-A Offline/OEGPACK | implemented, validation open | native cooker、OEGPACK V3 parser、range source、页校验和 bootstrap residency proof 已存在 | 实现 OEGPACK Product adapter并通过共同 production consumer；之后才能冻结候选 spec |
| 0016-B admission/residency | in progress | 已抽出 Product-aware `VirtualGeometryResidency`，带 product generation、activation/page upload、16 B location table、pinned/retiring evidence；已冻结 `GeometryPageDemandV1` 与 Product GPU location TS/WGSL mirror，并加入严格 hash-verified scheduler、8 MiB upload sink、至少双槽的延迟 readback ownership ring；S1 Product hierarchy/work/raster producer、统一 main/shadow consumer 与保留 identity 的 device-loss residency 重建已接线，但完整 demand 闭环仍未完成 | 完成 activation cut、GPU demand -> delayed readback -> provider -> upload -> generation publication 的有界闭环 |
| 0016-C renderer cutover | in progress | Product 已迁移到统一 main/shadow hierarchy/work/raster 与 GPU identity，并可在 device-loss 后按原 generation/table slot 重建 publication；普通 Scene adapter/V2 owner 仍保留 | 完成 Product recovery checkpoint 的真实浏览器验证、删除旧 V2 owner/path，并用 ADR-0014 浏览器证据验证统一 consumer |
| 0016-D texture modes | accepted, not implemented | 当前纹理按完整离线 mip/variant resident；没有渐进传输，也未证明真实物理 mip residency | 先交付 Mode A mip tail/高 mip 渐进传输；有 allocation 证据后再决定 Mode B/VT |

详细交付切片见 [implementation/0016-virtualized-assets.md](./implementation/0016-virtualized-assets.md)。

## 开放 Gate

- 1920x1080、DPR 1、完整目标画质下 16.667 ms GPU 尚无当前 revision 的正式目标设备基线。
- resident、transient、history、shadow、upload 和 readback 预算仍需同条件真实浏览器证据。
- Sparse shading 的剩余 lifecycle、production-entry 和正式 PERF case 尚未全部关闭；不得把静态结构等同 Runtime Validated 或 Performance Improved。
- Geometry Product 与 Virtual Geometry Runtime 仍是 draft；Product validator/adapter 与 Product-aware bootstrap heap 已有 DEV 实现，但 V3 geometry 尚无生产 GPU consumer，因此 OEGPACK ABI 仍是 candidate。
- S1 浏览器 case 当前为 `diagnostic-only`：真实 Chrome 已证明 Product metadata/page/Group/Meshlet GPU 解码；VisibilityKey/HDR shaded-pixel readback 暂缓到 Product raster fixture 与 Sparse Shading plumbing 完成后再跑，不作为 Slice 完成证据。
- Web Cooker 的 pthread/SAB 与多 Worker specialization 尚无同 workload 证据；cross-origin isolation 不是 correctness 前提，默认执行 profile 暂未冻结。
- `shader-f16`、Immediate Data 与 Transient Attachment 没有生产 consumer；`primitive-index` 等 specialization 只按真实 capability 启用。
- 普通 Scene adapter 不支持 `SkinnedMesh`；完整动画/蒙皮仍 deferred。

## 下一步

1. 按 0016 S1 先完成 `OEGPACK -> Geometry Product -> production Visibility`，以最短路径冻结共同 consumer 边界；这不改变 Web Runtime-first 的产品优先级。
2. 完成 S2/S3 的 `GLB Range -> Worker/WASM bootstrap/richer Product` 与联合背压，再接 S4 GPU demand/residency 闭环。
3. 补齐 replacement/eviction/device-loss 后迁移 main、shadow、普通 Scene adapter；删除前完成 source、compiled graph/shader 与 browser counter 三层审计。
4. 纹理先验证 Mode A 渐进传输；只有真实 allocation 证据支持时再实施 Mode B 或另立 Virtual Texturing ADR。
