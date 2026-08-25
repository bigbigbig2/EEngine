# 一帧总览（设计意图）

> 依据：设计 v2 §5；Shade v3 §5；docs/source/comparison-three-vs-shade.md 的 GPU 主循环理想型

## 1. 目标帧结构

```txt
CPU：dirty sync + 帧常量 + 提交 FrameGraph
GPU：cull →（meshlet）→ visibility → material → lighting → temporal/post → present
```

## 2. 与传统 three 帧的差异

| | three 传统 | 本工程目标 |
|--|------------|------------|
| 场景 | 每帧 traverse | 表 + 增量 |
| 可见性 | 多为 frustum，弱 occlusion | GPU frustum + HZB 方向 |
| 绘制 | per render item | 可见性结构 + 材质组织 |
| 后处理 | 常外挂堆叠 | 主管线集成（TAA 侵入） |

## 3. 模式演进（仍属同一目标，不是换产品）

母本允许工程分阶段落地，但模式都指向 Layer 3：

```txt
模式 A：table-driven 绘制 + GPU cull（先证明 CPU 路径被替换）
模式 B：depth / deferred + HZB
模式 C：full visibility buffer + material resolve
模式 D：完整 temporal + SSR/GI/shadow 栈
```

**模式 A/B 不是「最终改回 WebGPURenderer」**；它们是同一 Shade-like 目标的构建阶梯。

## 4. Pass 家族（名称级，归属模块见 module-map）

```txt
Upload / BeginFrame
Culling
Meshlet expansion
Visibility raster
Depth pyramid
Maybe resolve
Material resolve / G-buffer
Lighting / Shadows
GTAO 等 AO（路线）
SSR
GI
TAA
Bloom / Exposure / Tonemap / RCAS 等
Present
```

具体开哪些由设置与 tree-shake 模块决定（P6），集合来自设计 v2 + Shade 栈。
