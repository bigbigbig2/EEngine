# Performance Context

## 调查顺序

1. 固定硬件、浏览器、分辨率、DPR、画质和场景。
2. 区分 CPU frame、GPU frame 和首帧编译。
3. 记录 submit/readback/upload。
4. 记录候选与可见工作量。
5. 分段 cull、traversal、raster、resolve、lighting、post。
6. 记录 resident/transient memory、固定 384-vertex waste 和 texture/upload 带宽。
7. 再形成瓶颈假设并做单变量实验。

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
