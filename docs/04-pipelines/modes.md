# 渲染模式阶梯（设计层）

> 扩展 `frame-overview.md`；顺序服务建设，目标服务设计 v2 等式

## 模式 A — Table-driven + Frustum

```txt
对应 Phase：2–3（及 P1 着色）
特征：
  GPU tables 真源
  GPU frustum
  绘制可为 forward/baseline
证明：
  已离开 three render-list 主路径
尚未要求：
  VB / HZB / 完整 TAA
```

## 模式 B — Depth / Deferred 加深

```txt
对应 Phase：6–7 部分能力可前移组合
特征：
  G-buffer 或 depth prepass 思维
  HZB occlusion
证明：
  overdraw/遮挡账本开始按现代 renderer 算
```

## 模式 C — Visibility Buffer 中枢

```txt
对应 Phase：4–6
特征：
  meshlet + VB + material resolve
证明：
  工程等式中 visibility buffer 条款落地
```

## 模式 D — Temporal + 高级栈

```txt
对应 Phase：8–10
特征：
  TAA 胶水
  SSR / Shadow / GI 集成
  分档与半分辨率（局限文档）
证明：
  非 EffectComposer 外挂堆叠叙事
```

## 模式 E — 动态扩展

```txt
对应 Phase：11
特征：
  动画 / skinning / 动态 bounds
  与 Shade GPU animation 方向对齐
```

## 模式切换原则

```txt
1. 高模式应能退回低模式（设置/降级）
2. 退回 ≠ 删除高模式代码目标
3. docs/source/comparison-three-vs-shade.md：小场景默认可停在 A/B
4. archviz/大场景才强调 C/D
```
