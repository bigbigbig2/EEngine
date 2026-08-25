# M10 · Visibility — 设计意图

> 母本：设计 v2 §9；Shade v3 §6；docs/source/comparison-three-vs-shade.md §4 overdraw

## 1. 在母本等式中的位置

设计 v2 工程等式明确包含：

```txt
Shade-like … visibility buffer / deferred material resolve
```

本模块对应 **visibility buffer 半边**：只回答「看见了谁」。

## 2. 意图

```txt
轻量 raster：写 mesh/triangle 等 ID + depth
不为最终被挡住的像素跑贵材质
为 material resolve、HZB、后续 SSR 等提供可见性与深度基础
```

## 3. 代价（母本承认）

```txt
带宽
结构与调试复杂度
WebGPU 无 bindless 时后续取样更难（与 M11/纹理策略耦合）
```

## 4. 与 Baseline（M09）关系

```txt
M09：正确性与 table-driven 底座（阶梯）
M10：母本 Layer 3 的中枢方向
不是用 M09 永久替换 M10 目标
```
