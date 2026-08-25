# OEngine — 文档中心

> 产品名：**OEngine**  
> 对外架构用语：**GPU 常驻 / 数据驱动**（GPU-resident / GPU-driven）  
> 不再使用 **Shade-like** 等第三方 demo 名作为产品 slogan（母本归档中可作研究参照，见下）

根 README（开源入口）：[English](../README.md) · [简体中文](../README.zh-CN.md)

## 怎么读（三条入口）

| 你想… | 打开 |
|-------|------|
| **母本原文（权威）** | [source/README.md](./source/README.md) |
| **工程分册（设计展开）** | 下方 00–09 |
| **开始写代码** | [07-roadmap/execution-plan-by-module.md](./07-roadmap/execution-plan-by-module.md) |

---

## 0. 对外用语约定

| 场景 | 用词 |
|------|------|
| 产品 / README / Issue / PR 标题 | **OEngine** |
| Layer 3 架构（中文） | **GPU 常驻 / 数据驱动** |
| Layer 3 架构（英文） | **GPU-resident / GPU-driven** |
| 能力描述 | GPU scene 表 · 可见性缓冲 · resolve · 高级效果路线 |
| 避免当产品 slogan | `Shade-like`、第三方 demo 品牌名 |

`docs/source/` 里文件名与正文可能仍出现历史研究称呼——**仅作上限形态参照，不是产品承诺清单，也不是对外品牌**。

中英策略：根目录双 README；本 `docs/` 树以**中文优先**（设计深度）。

---

## 1. 母本原文 · `source/`

| 文件 | 定什么 |
|------|--------|
| [design-v2-full.md](./source/design-v2-full.md) | 产品与完整设计（**P0**） |
| [product-direction-webgpu-renderer-like.md](./source/product-direction-webgpu-renderer-like.md) | 门面像 WebGPURenderer、有限切换、TSL 边界 |
| [comparison-three-vs-shade.md](./source/comparison-three-vs-shade.md) | 架构差：换 API ≠ 换架构 |
| [webgpu-browser-limits.md](./source/webgpu-browser-limits.md) | 浏览器沙盒外壳 |
| [shade-reference-v3.md](./source/shade-reference-v3.md) | Layer 3 **研究参照**（VB / meshlet / 效果上限形态） |
| [webgpu-fundamentals.md](./source/webgpu-fundamentals.md) | WebGPU 基础心智 |
| [modules-phases-verification.md](./source/modules-phases-verification.md) | 模块/阶段/验收整理稿 |

裁定规则：[00-overview/source-of-truth.md](./00-overview/source-of-truth.md)

---

## 2. 工程分册 · `00–09`

| 区 | 内容 | 状态 |
|----|------|------|
| [00-overview](./00-overview/) | 目标、非目标、原则、术语、权威顺序 | ✅ |
| [01-architecture](./01-architecture/) | 三层、数据流、Lite runtime、GPU 常驻定位 | ✅ |
| [02-modules](./02-modules/) | M00–M15 模块设计 | ✅ |
| [03-data](./03-data/) | id / 表 / 字段 / dirty / GBuffer / bind group | ✅ |
| [04-pipelines](./04-pipelines/) | 帧结构、模式阶梯、pass 契约 | ✅ |
| [05-compatibility](./05-compatibility/) | three 兼容白名单 | ✅ |
| [06-constraints](./06-constraints/) | 浏览器与平台约束 | ✅ |
| [07-roadmap](./07-roadmap/) | Phase、闭环、**按模块执行计划** | ✅ |
| [08-references](./08-references/) | 导读与外链索引 | ✅ |
| [09-decisions](./09-decisions/) | ADR | ✅ |
| [source](./source/) | **母本原文** | ✅ |
| [research](./research/) | 调研笔记；含 three.js / reconstructed 源码对比研究 | 进行中 |
| [_templates](./_templates/) | ADR / 模块 README 模板 | ✅ |

---

## 3. 工程公式（一句话）

```txt
OEngine
  = three 输入 + Lite runtime
  + GPU 常驻 / 数据驱动核（GPU scene / VB / resolve）
  + TAA / SSR / GI / Shadow / Bloom / Post（能力路线）
  （全部在浏览器沙盒内）
```

---

## 4. 推荐路径

### 设计闭环

```txt
source/design-v2-full.md（可先扫目录）
  → 00-overview/goal.md
  → 01-architecture/layers.md
  → 07-roadmap/phase-0-3-closed-loop.md
  → 03-data/mother-doc-field-map.md
  → 04-pipelines/pass-contracts.md
```

### 开始实现（当前代码在 G1）

```txt
07-roadmap/execution-plan-by-module.md
  → examples/baseline（G1 已通）
  → 下一闸 G2/G3（表纪律 + GPU frustum）
```

### 数据面

```txt
03-data/ids.md → records-fields.md → mother-doc-field-map.md
  → store-model.md / dirty-model.md
```

---

## 5. 文档与代码的关系

```txt
source/     权威「做什么、为何」
00–09       工程化分册（模块边界、表语义、阶段）
packages/   实现（以分册 + 执行计划为准）
examples/   门闸演示（minimal=G0, baseline=G1）
README*     开源入口（英 / 中）
```

**冲突裁定：** 产品目标以 `source/design-v2-full.md` 为准；分册与代码冲突则改分册/代码，不静默砍 Layer 3 目标（见 ADR-0003）。

---

## 6. 仍待实现层补齐（非文档目录问题）

```txt
- stride / bind group 号冻结
- Phase 4+ 闭环串讲（可选，做到再写）
- 更多示例与验收场景资产
- 包作用域 @three-lite/* → @oengine/*（可选迁移）
```
