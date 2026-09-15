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
| 0016-A cooker/package | implemented, validation open | native cooker、OEGPACK V3.0 parser、range source、页校验、bootstrap residency 与 targeted tests 已存在 | 让真实 V3 bootstrap geometry 到达生产 Visibility consumer，并冻结候选 spec |
| 0016-B runtime residency | not implemented | 没有生产 page heap、feedback scheduler、异步 publish/evict 闭环 | 完成 demand -> range/decode/upload -> generation publish 的有界闭环 |
| 0016-C renderer cutover | not implemented | 生产 renderer 仍消费既有 geometry package/hierarchy | 在同一主管线接入 V3、resident ancestor fallback，最后删除被替换的 V2 geometry path |
| 0016-D texture streaming | proposed | 当前纹理按完整离线 mip/variant resident；无渐进高 mip residency | 先交付 mip tail + partial high-mip residency；VT 另行决策 |

详细交付切片见 [implementation/0016-virtualized-assets.md](./implementation/0016-virtualized-assets.md)。

## 开放 Gate

- 1920x1080、DPR 1、完整目标画质下 16.667 ms GPU 尚无当前 revision 的正式目标设备基线。
- resident、transient、history、shadow、upload 和 readback 预算仍需同条件真实浏览器证据。
- Sparse shading 的剩余 lifecycle、production-entry 和正式 PERF case 尚未全部关闭；不得把静态结构等同 Runtime Validated 或 Performance Improved。
- V3 geometry 尚无生产 GPU consumer，因此 OEGPACK ABI 仍是 candidate，不因 cooker/parser 测试通过自动冻结。
- `shader-f16`、Immediate Data 与 Transient Attachment 没有生产 consumer；`primitive-index` 等 specialization 只按真实 capability 启用。
- 普通 Scene adapter 不支持 `SkinnedMesh`；完整动画/蒙皮仍 deferred。

## 下一步

1. 按 0016 实施文档先完成 V3 bootstrap 到现有 Visibility 的最小真实 consumer，再建立 page demand/residency 闭环。
2. 补齐 ADR-0013/0014 命中的 lifecycle、production-entry 和正式 PERF evidence，不恢复旧 backend。
3. 在 V3 geometry consumer 稳定后再 cut over 并删除被替换路径；删除前完成 source、compiled graph/shader 与 browser counter 三类审计。
4. 纹理先验证渐进 mip residency 的真实收益，再决定是否需要新 container 或 Virtual Texturing ADR。
