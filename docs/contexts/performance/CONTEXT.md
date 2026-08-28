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

- R3-C 历史 flat candidate Meshlets 与当前 hierarchy visited nodes/selected clusters/RasterWork 同时报告；R3-D 已删除 runtime flat 路径，after 数据与 commit `0b77ce8` 保存的 flat/hierarchy bundle 对照。减少 candidate 不等于总 GPU 时间改善。
- 记录 encoded/effective/empty traversal rounds、每轮 input/output、queue attempted/written/peak/overflow/fallback。
- paired before/after 必须使用相同 Scene、相机、分辨率、DPR、画质和 Hardware consumer，并同时报告 traversal 新增成本与 raster 减量。
- paired counter 按 implementation 解读：flat 的 `candidateClusters/selectedClusters/hwClusters` 都是 Meshlet work；hierarchy 分别是 visited hierarchy nodes、VisibleCluster records 与 RasterWork Meshlets。`hwTriangles` 始终以 `hwClusters × 128` 表示固定上限提交量，禁止拿 VisibleCluster 数代算。
- 高密度胜例和简单低密度回退都进入结果；没有 paired artifact 前不宣称 hierarchy 更快。
- work queue 的 resident/transient bytes 和 `maxCutMeshlets` 保底容量随 Instance/Geometry 轴输出扩展曲线。
- R3-C clean/full paired 已证明：A 减少 90.1% RasterWork 但 Visibility P50 回退 14.1%；B 减少 80.4% 且 P50 改善 69.6%；C 两路均为 127 RasterWork，hierarchy 多约 0.262 ms 固定成本。三段热点不是三个 `workgroup_size(1)`：InstanceCull/Traversal 已是 64-lane，旧 expansion 是每 lane 串行展开 Cluster。R3-D 只在证据支持的 seam 上改为每 Cluster 一个 64-lane expansion workgroup；clean/full after 已证明 A/B/C expansion P50 从 38.54/2.49/0.131 ms 降至 6.82/1.31/0.066 ms，但局部 Pass 下降不能替代总时间 Gate。
- clean commit `1f3a2d7` 的 A/B/C after 均为 `gateEligible=true`、zero counter issue/overflow/WebGPU diagnostics。A Visibility P50 相对历史 flat 改善约 10.4%，但 P95 回退约 15.3%；B P50/P95 改善约 65%；C 多约 0.262 ms 固定成本且 P95 从约 0.131 ms 增至 0.495 ms。G3 performance 被 `R3-D-08/09` 阻塞，不再写成“待采集”。
- `R3-D-08/09` 已实现 fused root、workgroup-local queue compaction、sampled diagnostics 和 depth-zero fused-leaf。commit `aff3ab8` 的 clean/full A/B/C 均 gate eligible/zero diagnostics：Visibility P50/P95/P99 为 A `16.777/17.511/18.234 ms`、B `11.534/11.665/11.758 ms`、C `0/0.066/0.066 ms`；A/B 为 wavefront + fused-root，C 真实命中 fused-leaf。G3 performance 已关闭。
- 新增 `rootStageQueueReservations`、`traversalQueueReservations`、`workGenerationDispatchUpdates`、`workGenerationCasRetries`。比较必须同时报告对应 sampled frame、实现类型（wavefront/fused-leaf）和 RasterWork；非采样帧的无 evidence 不能解释为真实零。
- A clean full 的 CAS retry P50/P95 仍为 `18,428/20,672`，但 Producer P50/P95 已降至 `6.291/7.120 ms` 并通过总时间 Gate；它是更大 workload 的后续 profile 风险，不要求为得到零 counter 增加 Prefix Scan 或固定 Pass。

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
