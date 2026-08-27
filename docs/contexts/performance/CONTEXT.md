# Performance Context

## 调查顺序

1. 固定硬件、浏览器、分辨率、DPR、画质和场景。
2. 区分 CPU frame、GPU frame 和首帧编译。
3. 记录 submit/readback/upload。
4. 记录候选与可见工作量。
5. 分段 cull、traversal、raster、resolve、lighting、post。
6. 记录 resident/transient memory、固定 384-vertex waste 和 texture/upload 带宽。
7. 再形成瓶颈假设并做单变量实验。

## 禁止结论

- “GPU-driven 所以一定更快”。
- “功能更多所以慢是正常的”。
- “只缺 LOD”或“只缺软光栅”，但没有分段证据。
- 用不同 DPR、画质、材质和实例布局直接比较 FPS。

固定契约见 `docs/PERFORMANCE.md`。
