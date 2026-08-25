# M13 · Post — 设计意图

> 母本：设计 v2 高级效果列表；Shade v3 §11–14；docs/source/comparison-three-vs-shade.md §8–9

## 1. 母本中的身份

```txt
TAA / SSR / GI / Shadow / Bloom / PostProcess
属于工程等式的一部分，不是「有空再挂的插件」
```

## 2. 集成而非堆叠

```txt
docs/source/comparison-three-vs-shade.md：three 后处理常 EffectComposer 堆 pass
Shade：TAA/GTAO/SSR/Bloom/Exposure 共享 history 与 G-buffer 类信息
TAA intrusive：管线需 jitter / motion / history / disocclusion
```

## 3. 与浏览器外壳

```txt
history 在标签页恢复、device lost 后不可盲目沿用（局限 + Shade）
分档：半分辨率 SSR 等（局限 §8–9）
```

## 4. 能力集合（名称级，来自母本/Shade）

```txt
TAA（核心胶水）
SSR（含 resolve/denoise 难度）
Bloom / Tonemap / Auto exposure / RCAS 等
GTAO 等与 GI 协同
GI 采样呈现侧与 M12/探针系统接口
```

落地可分期；**目标列表不在此删减**。
