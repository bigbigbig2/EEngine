# 学习与分析 Backlog

## 推荐顺序

### A. 建立共同心智模型

- [ ] A01：公共场景模型与 renderer interface
- [ ] A02：首帧初始化与设备/画布生命周期
- [ ] A03：完整单帧控制流与数据流
- [ ] A04：静态 mesh 从创建到首次显示
- [ ] A05：transform 更新如何到达 GPU

### B. 找到两条路线的分叉点

- [ ] B01：render list 与 GPU work generation
- [ ] B02：CPU frustum culling 与 GPU instance/meshlet culling
- [ ] B03：传统 material draw 与 visibility/material resolve
- [ ] B04：对象/geometry 粒度与 meshlet 粒度
- [ ] B05：直接 draw、instancing、indirect draw 的调度纪律

### C. 数据与资源架构

- [ ] C01：GPU scene 表、索引和稳定 ID
- [ ] C02：buffer/texture allocator 与生命周期
- [ ] C03：dirty tracking、增量上传和删除回收
- [ ] C04：pipeline/bind group/material cache
- [ ] C05：FrameGraph 资源别名、复用和同步

### D. 渲染能力

- [ ] D01：PBR 材质表达和 shader 生成/组织
- [ ] D02：光照收集、cluster 和 shadow
- [ ] D03：透明、排序与 OIT
- [ ] D04：TAA、SSR、motion vector 和历史资源
- [ ] D05：曝光、bloom、tonemap 和动态分辨率

### E. 工程属性

- [ ] E01：扩展一个自定义 pass 的成本
- [ ] E02：新增材质模型的影响面
- [ ] E03：错误处理、device lost 与恢复
- [ ] E04：调试、统计、GPU capture 和 framegraph 可视化
- [ ] E05：测试策略与可复现 benchmark

## 第一批建议专题

优先完成以下三篇，它们能最快建立稳定的架构坐标系：

1. `single-frame-control-flow.md`：谁编排一帧。
2. `visibility-and-work-generation.md`：谁决定画什么。
3. `scene-data-and-gpu-residency.md`：数据在哪里、谁拥有、如何同步。

之后再进入材质、光照和高级效果，否则容易陷入大量 shader 细节而看不见整体架构。

