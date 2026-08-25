# 大阶段分组（讲故事用）

> 对照：`docs/source/modules-phases-verification.md` 的 Stage 分组  
> 阶段编号仍以 **设计 v2 Phase 0–11** 为准

## 1. 两组编号如何对齐

| verification 说法 | 大致覆盖设计 v2 | 对外一句话 |
|-------------------|-----------------|------------|
| Stage 0 | Phase 0 | 能跑 WebGPU 壳 |
| Stage A | Phase 1–3（+ 表驱动绘制） | three 输入 + GPU tables + frustum；CPU 主路径被替换 |
| Stage B | Phase 5–7 中 depth/occlusion 与 deferred 相关 | 可见性/延迟加深（含 HZB） |
| Stage C | Phase 4–6、8（meshlet/VB/resolve/TAA） | Shade-like 中枢能力成型 |
| Stage D | Phase 9–11 | SSR/阴影/GI/动画等继续 |

**注意：** verification 里曾出现「先 frustum 完成门、VB 后置」的强调，这是 **风险控制叙事**；设计 v2 把 Meshlet 放在 VB 前（Phase 4→5）。两者都服从母本能力全集，顺序细节以设计 v2 为默认，交叉时用 ADR。

## 2. 里程碑表述（可对内/对外）

### 里程碑 A — 「不是 WebGPURenderer 换皮」

```txt
达成：Phase 2–3 意图满足
可说：场景在 GPU 表上，GPU frustum 产出可见列表
不可说：已是完整 Shade；一定比 three 快
```

**串讲与验收清单：** [phase-0-3-closed-loop.md](./phase-0-3-closed-loop.md)



### 里程碑 B — 「可见性结构成立」

```txt
达成：Phase 5–7 意图满足
可说：VB/HZB/resolve 方向跑通
不可说：浏览器 = 原生引擎；GI 已 AAA 开箱
```

### 里程碑 C — 「现代 frame stack」

```txt
达成：Phase 8–10 意图满足
可说：TAA 集成 + SSR/阴影/GI 方向可用且可分档
必须带：docs/source/webgpu-browser-limits.md 的分档与外壳叙事
```

### 里程碑 D — 「动态扩展」

```txt
达成：Phase 11 意图满足
可说：动画/skinning 进入 GPU-resident 方向
```

## 3. 与docs/source/comparison-three-vs-shade.md 的关系

```txt
里程碑 A 之前：主要解决「架构是不是 three render-list」
里程碑 B+：   才谈 overdraw / occlusion / 大场景上限
全程：        小场景不强制全开 Layer 3
```
