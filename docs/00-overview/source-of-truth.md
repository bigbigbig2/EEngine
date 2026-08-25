# 本地文档权威顺序（Source of Truth）

本工程产品名：**OEngine**。  
对外 Layer 3 用语：**GPU 常驻 / 数据驱动**（GPU-resident / GPU-driven）；不以第三方 demo 名（如 Shade-like）为产品 slogan。  
设计 **服从 `docs/source/` 母本原文的方向**，分册是展开，不是另一套产品。

## 1. 权威文档清单

| 优先级 | 文件（现路径） | 角色 |
|--------|----------------|------|
| **P0 产品母本** | [source/design-v2-full.md](../source/design-v2-full.md) | **工程要做成什么** |
| **P1 门面与切换** | [source/product-direction-webgpu-renderer-like.md](../source/product-direction-webgpu-renderer-like.md) | **像 WebGPURenderer 的用法、有限切换、TSL 边界** |
| **P1 架构判断** | [source/comparison-three-vs-shade.md](../source/comparison-three-vs-shade.md) | **为何不能只换 API** |
| **P1 运行环境** | [source/webgpu-browser-limits.md](../source/webgpu-browser-limits.md) | **浏览器 ≠ 原生引擎** |
| **P1 渲染上限** | [source/shade-reference-v3.md](../source/shade-reference-v3.md) | **Shade-like 管线长什么样** |
| **P2 基础课** | [source/webgpu-fundamentals.md](../source/webgpu-fundamentals.md) | **WebGPU 心智** |
| **辅助** | [source/modules-phases-verification.md](../source/modules-phases-verification.md) | 模块/阶段/验收整理；**不得反向改写母本目标** |

旧根目录文件名对照见 [source/README.md](../source/README.md)。

`docs/00–09` 是对上述母本的 **结构化展开与分册**，不是新方向。

## 2. 冲突时怎么裁定

```txt
1. 产品「做三层什么」        → design-v2-full.md
2. 「门面 / 与官方切换 / TSL」→ product-direction-webgpu-renderer-like.md
3. 「three 内核 vs 新架构」  → design-v2 §2 + comparison-three-vs-shade.md
4. 「浏览器里能不能当原生」  → webgpu-browser-limits.md（不能）
5. 「渲染管线上限长什么样」  → shade-reference-v3.md + design-v2 Layer 3
6. 「WebGPU 基本概念」      → webgpu-fundamentals.md
7. 分册与母本冲突          → 改分册，不改母本方向
8. verification 与设计 v2  → 以 design-v2-full 为准
```

## 3. 母本一句话（禁止在分册里改写目标）

### design-v2-full

```txt
Three.js Lite
  = three.js 生态输入层
  + Babylon Lite 风格轻量 runtime
  + Shade-like GPU scene / visibility buffer / deferred material resolve
  + 高级效果：TAA / SSR / GI / Shadow / Bloom / PostProcess
```

### product-direction-webgpu-renderer-like

```txt
门面像 WebGPURenderer；内核自研 GPU 常驻 / 数据驱动。
与官方有限切换 = 公共 API + 场景白名单，不是 100% drop-in。
TSL 完整兼容非目标；参数子集可以。
```

### comparison-three-vs-shade

```txt
WebGPURenderer：更现代的 backend，仍是 three CPU-driven scene/render-list。
Shade：从数据结构与管线重写。
换 API ≠ 换架构。
```

### webgpu-browser-limits

```txt
可以把管线做得很像现代游戏引擎，
但不能把浏览器标签页变成原生游戏进程。
```

### shade-reference-v3

```txt
目标是 GPU-resident renderer：场景数据常驻 GPU；
剔除、间接绘制、meshlet、可见性等尽量在 GPU。
```

### webgpu-fundamentals

```txt
WebGPU：更显式、更像现代图形 API；compute 一等公民。
```

## 4. 分册 ↔ 母本映射

| docs 区域 | 主要对应母本 |
|-----------|----------------|
| `00-overview` | design-v2 §0–§1 |
| `01-architecture` | design-v2 §2–§3；comparison；shade-reference §0–§4 |
| `02-modules` | design-v2 各技术章所有权；shade 子系统 |
| `03-data` | design-v2 §6 |
| `04-pipelines` | design-v2 §5；shade-reference 主循环 |
| `05-compatibility` | design-v2 §2.2、§4 |
| `06-constraints` | webgpu-browser-limits；design-v2 风险 |
| `07-roadmap` | design-v2 §23–§26；modules-phases-verification |
| `08-references` | 导读与索引 |
| `09-decisions` | ADR |
| `source/` | 母本原文本体 |

## 5. 写法约定

```txt
写：架构意图、职责、数据流、能力范围、取舍
不写（除非实现冻结轮）：WGSL 定稿、最终 stride、函数签名
不压：不把 Layer 3 从工程目标里删掉（ADR-0003）
```
