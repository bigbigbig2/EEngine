# OEngine 当前状态

更新时间：2026-09-16。本页是可变进度、开放风险和下一步的唯一汇总；历史结果由 Git 与 evidence artifact 保存。

## 生产基线

- 唯一 `Renderer -> MainRenderPipeline -> FrameGraph` 主管线承载 GPU Scene、hardware visibility、Sparse Shading Bin、lighting/effects、temporal 和 final output。
- `GpuAssetStore`、`GpuScene`、`GpuRenderWorld` 分离 Runtime Asset 与 GPU ownership，并使用显式 patch 和 revision publication。
- GPU hierarchy/work -> indirect raster -> VisibilityKey -> active-bin sparse shading 已是生产结构；旧 material class/tile backend 已删除。
- TextureAssetPackage V2、KTX2/libktx preparation、GPU-native variants、`TextureResidency` 与有界 `TextureBindingSet` 是当前纹理生产路径。
- 独立 `validation/` 宿主管理真实浏览器验证；现有 artifact 只证明其记录的 revision 和 workload。

## 虚拟化资产迁移

| 部分 | 状态 | 当前事实 | 下一出口 |
| --- | --- | --- | --- |
| Geometry Product V1 | specified, not implemented | Producer-neutral descriptor/page/provider 合同已进入 draft spec；代码中仍没有共同 validator/admission | 先让 OEGPACK adapter 经共同 Product 边界到达生产 Visibility |
| Web Runtime Cooker 主路线 | not implemented | 当前 GLB loader 仍会完整 `arrayBuffer()`；没有 browser-first WASM CookSession、streaming Range source 或渐进 Product | 完成 GLB Range -> Worker/WASM bootstrap Product -> 同一生产像素路径 |
| 0016-A Offline/OEGPACK | implemented, validation open | native cooker、OEGPACK V3 parser、range source、页校验和 bootstrap residency proof 已存在 | 实现 OEGPACK Product adapter并通过共同 production consumer；之后才能冻结候选 spec |
| 0016-B admission/residency | not implemented | 没有生产 product admission、page heap、feedback scheduler、异步 publish/evict 闭环 | 完成 activation cut、demand -> provider -> upload -> generation publication 的有界闭环 |
| 0016-C renderer cutover | not implemented | 生产 renderer 仍消费既有 V2 geometry package/hierarchy | 接入 Product generation、resident ancestor fallback，迁移 main/shadow/Scene adapter 后删除 V2 path |
| 0016-D texture modes | accepted, not implemented | 当前纹理按完整离线 mip/variant resident；没有渐进传输，也未证明真实物理 mip residency | 先交付 Mode A mip tail/高 mip 渐进传输；有 allocation 证据后再决定 Mode B/VT |

详细交付切片见 [implementation/0016-virtualized-assets.md](./implementation/0016-virtualized-assets.md)。

## 开放 Gate

- 1920x1080、DPR 1、完整目标画质下 16.667 ms GPU 尚无当前 revision 的正式目标设备基线。
- resident、transient、history、shadow、upload 和 readback 预算仍需同条件真实浏览器证据。
- Sparse shading 的剩余 lifecycle、production-entry 和正式 PERF case 尚未全部关闭；不得把静态结构等同 Runtime Validated 或 Performance Improved。
- Geometry Product 与 Virtual Geometry Runtime 均是 draft 且无实现；V3 geometry 尚无生产 GPU consumer，因此 OEGPACK ABI 仍是 candidate。
- Web Cooker 的 pthread/SAB 与多 Worker specialization 尚无同 workload 证据；cross-origin isolation 不是 correctness 前提，默认执行 profile 暂未冻结。
- `shader-f16`、Immediate Data 与 Transient Attachment 没有生产 consumer；`primitive-index` 等 specialization 只按真实 capability 启用。
- 普通 Scene adapter 不支持 `SkinnedMesh`；完整动画/蒙皮仍 deferred。

## 下一步

1. 按 0016 S1 先完成 `OEGPACK -> Geometry Product -> production Visibility`，以最短路径冻结共同 consumer 边界；这不改变 Web Runtime-first 的产品优先级。
2. 完成 S2/S3 的 `GLB Range -> Worker/WASM bootstrap/richer Product` 与联合背压，再接 S4 GPU demand/residency 闭环。
3. 补齐 replacement/eviction/device-loss 后迁移 main、shadow、普通 Scene adapter；删除前完成 source、compiled graph/shader 与 browser counter 三层审计。
4. 纹理先验证 Mode A 渐进传输；只有真实 allocation 证据支持时再实施 Mode B 或另立 Virtual Texturing ADR。
