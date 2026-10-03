# Surface V3 第一版优化进度记录

日期：2026-10-03。当前 HEAD：`ec2b3fec`。本记录只描述真实源码、提交和验证状态，不把组件 oracle 或设计文档当作生产链完成证据。

## 已完成阶段

| 阶段 | 状态 | 提交/证据 | 结论 |
|---|---|---|---|
| Phase 0：基线、容量和删除边界 | 已完成 | `3c0113d8` | GTX 1650 Ti/1080p、Dungeon 指纹、412 MiB/512 MiB policy、来源和旧产品清单已冻结 |
| Phase 1：连续域、LOD lineage、局部纹理 variation | 已完成 | `5057c8dd`；Phase 1 发布记录 | Native/WASM、普通 Geometry metadata、Product lineage、32 MiB variation pool 和实际纹理摘要发布已检查 |
| Phase 2：连续域 classifier、跨 VisibilityKey、多率 SurfaceWork、Geometry setup | 进行中 | 检查点提交 `ec2b3fec`；本机记录见 `.local/validation/surface-optimization-v1/phase2-checkpoint.md` | 检查点已提交，但组件产物和生产主链尚未通过，不能视为 Phase 2 完成 |
| Phase 3：FieldStore 与 demand Geometry | 预备实现 | 未提交 `GpuSurfaceFieldStore*` | owner、ABI、预算和 GPU lookup/publish 诊断存在，尚未替换 `SurfaceMaterialCachePass` |
| Phase 4：SignalStore、紧凑 packet、稀疏 history | 预备实现 | 未提交 `GpuSurfaceSignalStore*` | owner、ABI 和预算存在，尚未替换 `SurfaceLightingWorkPass` |
| Phase 5：reconstruct/batch | 未开始 | 无 | 仍使用旧 dense history/reconstruct 生产路径 |
| Phase 6：真实 provider/lifecycle | 未开始 | 无 | 不能把现有历史生命周期接线算作本轮目标完成 |
| Phase 7：整链验收 | 未开始 | 无 | 没有正式 browser matrix、画质对照或四版本性能比较 |

因此当前真正完成的是 **2 个阶段：Phase 0 和 Phase 1**。

## Phase 2 当前事实

已经完成的组件工作包括：

- `GpuSurfaceCellPlanAbi`、`SurfaceCellReference` 和多率 field/signal plan；8 组 synthetic GPU plan case 通过，包含跨 winner、交错域、fine unique、tail/empty tile。
- `SurfaceCellGeometrySetup` 和普通 Geometry GPU fixture；64 covered pixels、2 winners、2 setups、1024 B setup 写入通过。
- Appearance bound、cell address、texture variation 和 FieldStore GPU diagnostic 通过；当前 `build:test` 通过，32 项相关 contract/oracle checks 通过。
- `SurfaceCellClassifierPass` 已尝试接入 `SurfaceWorkRuntime`，并新增 production facts、material constants、lighting facts、cell plan 和 compact representative work 的 FrameGraph 边界。

这些结果还不能证明 Phase 2 完成，原因是：

- `SurfaceWorkRuntime.ts` 仍保留旧 `CLASSIFY_WGSL` 源码和旧 `GpuSurfaceWorkAbi` 分区；旧 classifier 尚未从生产依赖中删除。
- production fact/classifier 的真实 Chromium 检查最新失败为 `unresolved value 'field'`；此前单体和严格 stage pipeline 还出现过 Dawn external-instance/长时间无终态。
- 当前 production classifier 没有通过真实 producer → consumer → compact → GeometryRecord 的完整 GPU fixture；synthetic facts 不能替代它。
- Product profile、overflow direct path、tail batch、真实 field/signal coverage 和跨 meshlet production case 尚未完成。

本阶段不能用 cheap/skip-bound 的诊断 variant 作为完成证据；那类 variant 只用于定位 Chromium 编译问题，不能进入生产路径或提升采用状态。

## 下一步顺序

1. 修复 production facts 的 stage 生成：每个 stage 必须保留完整几何、seam、variation、normal/view/roughness、direct-light/shadow 和 coat 判据；解决 `field` unresolved 与 strict pipeline/dispatch 失败，不回退到 cheap classifier。
2. 重新运行真实 Chromium production-cell fixture，覆盖 ordinary/Product、跨 key/meshlet、UV seam、normal 高频、direct shadow 风险、tail/overflow；只有 API error、device loss、覆盖和输出断言全部通过，Phase 2 才能收口。
3. 从 `SurfaceWorkRuntime` 删除旧 `CLASSIFY_WGSL`、winner equality 和 pixel-task 分区，让新 plans/compact representative work 成为唯一生产输出；检查 GeometryRecord 仍只有一个 producer，然后提交一个中文 Phase 2 commit。
4. Phase 2 提交后再把 FieldStore lookup/admit/publish 接入 `SurfaceMaterialCachePass`，删除 dense keys/values/fields；完成检查后提交 Phase 3。
5. 接着接入 SignalStore 和独立 signal rate，删除 dense packet/history owner，完成检查后提交 Phase 4。
6. 最后推进 reconstruct、固定 batches、providers/lifecycle，全部接线完成后才执行 Phase 7 的整链浏览器、画质和性能报告。

当前先停在讨论和进度记录阶段；不继续修改生产实现，等待下一步指令。
