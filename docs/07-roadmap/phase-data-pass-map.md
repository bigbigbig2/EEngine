# 阶段 → 数据表 → Pass 映射

> 把设计 v2 Phase、03-data、04-pipelines 接到一张表上

| Phase | 关键数据就绪 | 关键 Pass 就绪 | 模式 |
|-------|--------------|----------------|------|
| 0 | 无场景表 | Begin/Fullscreen/Present | 壳 |
| 1 | CPU World 初值；可先简 upload | BaselineDraw | 链路 |
| 2 | Instance/Transform/Mesh/Material/Bounds/Tex 元数据 | UploadDirty 为主路径 | A 准备 |
| 3 | VisibleInstance + Counters | CullInstances | A |
| 4 | Meshlet + VisibleMeshlet | Expand/Cull Meshlets | 向 C |
| 5 | Visibility + Depth 纹理 | RasterVisibility | C |
| 6 | GBuffer 成员 | MaterialResolve + DeferredLighting | C |
| 7 | DepthPyramid；Maybe 列表 | Pyramid + ResolveMaybe | B/C |
| 8 | prev Transform + history 色/深 | TAA | D |
| 9 | shadow maps；SSR 缓冲 | Shadow + SSR | D |
| 10 | probe/GI 体积数据 | GI | D |
| 11 | 动态 bounds/skin 数据 | 动画更新 passes | E |

## 使用方式

```txt
做 Phase N 设计评审时：
  1. 看本表「数据是否定义」
  2. 看 pass-contracts 是否闭环
  3. 看 records-fields 字段是否够用
  4. 对照 mother-doc-field-map（母本 §6 与阶段就绪）
  5. 不够 → 先扩 03-data，再写实现
```

Phase 0–3 整段串讲：[phase-0-3-closed-loop.md](./phase-0-3-closed-loop.md) · 字段对照：[../03-data/mother-doc-field-map.md](../03-data/mother-doc-field-map.md)

