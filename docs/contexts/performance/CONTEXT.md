# Performance Context

## 调查顺序

1. 固定硬件、浏览器、分辨率、DPR、画质和场景。
2. 区分 CPU frame、GPU frame 和首帧编译。
3. 记录 submit/readback/upload。
4. 记录候选与可见工作量。
5. 分段 cull、traversal、raster、resolve、lighting、post。
6. 记录 resident/transient memory、固定 384-vertex waste 和 texture/upload 带宽。
7. 再形成瓶颈假设并做单变量实验。

## R3 必报口径

- flat candidate Meshlets 与 hierarchy visited nodes/selected clusters/RasterWork 同时报告；减少 candidate 不等于总 GPU 时间改善。
- 记录 encoded/effective/empty traversal rounds、每轮 input/output、queue attempted/written/peak/overflow/fallback。
- paired flat/hierarchy 必须使用相同 Scene、相机、分辨率、DPR、画质和 Hardware consumer，并同时报告 traversal 新增成本与 raster 减量。
- paired counter 按 implementation 解读：flat 的 `candidateClusters/selectedClusters/hwClusters` 都是 Meshlet work；hierarchy 分别是 visited hierarchy nodes、VisibleCluster records 与 RasterWork Meshlets。`hwTriangles` 始终以 `hwClusters × 128` 表示固定上限提交量，禁止拿 VisibleCluster 数代算。
- 高密度胜例和简单低密度回退都进入结果；没有 paired artifact 前不宣称 hierarchy 更快。
- work queue 的 resident/transient bytes 和 `maxCutMeshlets` 保底容量随 Instance/Geometry 轴输出扩展曲线。
- R3-C clean/full paired 已证明：A 减少 90.1% RasterWork 但 Visibility P50 回退 14.1%；B 减少 80.4% 且 P50 改善 69.6%；C 两路均为 127 RasterWork，hierarchy 多约 0.262 ms 固定成本。因此 R3-D 首先 profile/优化 `workgroup_size(1)` 的 InstanceCull、round 0 和 VisibleCluster expansion，不用减少的 work count 代替总时间 Gate。

## R1 已冻结口径

- steady main frame 只有 `Renderer/main-0` 一次 submit；one-shot/tool/recovery 必须单独分类。
- warm graph 使用 `build=0/compile=0/execute=1/cacheHit=1`；cold miss 由 cache 测试覆盖。
- `hzb.computeBuilds`、`hzb.computePasses`、`hzb.dispatches` 与 `hzb.outputPixels` 是本帧主视图和实际更新阴影视图的总量，不是只统计 primary view。
- 每个 HZB build 的结构上界是一个 Compute Pass 和 `mipCount` 个 dispatch；总 build 数可以随实际更新的 view 数增长。
- R1 没有同条件 clean/full before bundle，因此只关闭结构 Gate，不声明性能提升百分比；R2 第一项性能修改前必须先采集可配对基线。

## 禁止结论

- “GPU-driven 所以一定更快”。
- “功能更多所以慢是正常的”。
- “只缺 LOD”或“只缺软光栅”，但没有分段证据。
- 用不同 DPR、画质、材质和实例布局直接比较 FPS。

固定契约见 `docs/PERFORMANCE.md`。
