# M08 · Culling — 设计意图

> 母本：设计 v2 §7；Shade v3 §7；docs/source/comparison-three-vs-shade.md §6 occlusion

## 1. 问题

```txt
仅 frustum：在锥内但被墙挡住的仍可能大成本提交
大场景 / 室内 / 城市：occlusion 是核心收益之一（对比 + Shade）
```

## 2. 能力方向（母本）

```txt
GPU frustum culling
conservative occlusion（depth pyramid / HZB）
progressive：instance → meshlet → …
visible / maybe / culled 分层，降低错误剔除闪烁
```

## 3. 与「小场景」

docs/source/comparison-three-vs-shade.md：开阔少遮挡时 occlusion 收益下降甚至不值——设置上可关，架构上要可存在。

## 4. 输出

```txt
compact visible lists（供绘制 / VB）
stats：total / visible / occluded（可测，P9）
```
