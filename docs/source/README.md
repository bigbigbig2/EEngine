# source · 母本原文（权威）

> 本目录存放 **OEngine** 产品与架构的**原始长文**。  
> `docs/00–09` 是对它们的**分册展开**；冲突时 **改分册，不改母本方向**。

### 对外用语 vs 本目录

| 对外（README / PR / 产品） | 本目录（研究归档） |
|---------------------------|-------------------|
| **OEngine** | 文中可能仍写历史工程名（Three.js Lite 等） |
| **GPU 常驻 / 数据驱动**（GPU-resident / GPU-driven） | 可能出现第三方 demo 名，仅作**上限形态参照** |
| 不以第三方品牌为 slogan | 文件名如 `shade-reference-v3.md` **历史保留**，不等于产品名 |

## 文件清单（统一英文名）

| 文件 | 原根目录名 | 角色 | 优先级 |
|------|------------|------|--------|
| [design-v2-full.md](./design-v2-full.md) | `threejs_lite_shade_like_webgpu_full_design_v2.md` | **产品与完整设计**（三层等式、表、管线、Phase 0–11） | **P0** |
| [product-direction-webgpu-renderer-like.md](./product-direction-webgpu-renderer-like.md) | （2026-07 讨论收敛） | **门面策略**：WebGPURenderer 形 API、有限切换、TSL 边界 | **P1** |
| [comparison-three-vs-shade.md](./comparison-three-vs-shade.md) | `对比.md` | 为何不能只换 API：three / WebGPURenderer / GPU 驱动架构 | P1 |
| [webgpu-browser-limits.md](./webgpu-browser-limits.md) | `webgpu局限性.md` | 浏览器标签页外壳：内存、生命周期、DPR、预期 | P1 |
| [shade-reference-v3.md](./shade-reference-v3.md) | `shade_webgpu_threejs_full_thread_v3.md` | Layer 3 **研究参照**（VB / meshlet / TAA / GI…） | P1 |
| [webgpu-fundamentals.md](./webgpu-fundamentals.md) | `系统学习.md` | WebGPU 心智（相对 WebGL） | P2 |
| [modules-phases-verification.md](./modules-phases-verification.md) | `threejs_lite_modules_phases_verification.md` | 模块/阶段/验收整理；**不得反向改写 P0 目标** | 辅助 |

## 建议阅读顺序

```txt
1. webgpu-fundamentals.md          （基础词汇）
2. comparison-three-vs-shade.md  （架构判断）
3. webgpu-browser-limits.md      （外壳约束）
4. shade-reference-v3.md         （渲染上限长什么样）
5. design-v2-full.md             （本工程要做什么）
6. product-direction-webgpu-renderer-like.md（门面 / 可切换 / TSL 边界）
7. modules-phases-verification.md（模块/阶段对照，服从 5）
```

然后进入分册：

```txt
docs/00-overview → 01-architecture → 07-roadmap/execution-plan-by-module.md
```

## 是否合并？

**不合并这些原文。** 原因：

| 若合并… | 问题 |
|---------|------|
| 合成一份「超级母本」 | 单文件过大、职责混、难 diff、难引用章节 |
| 把「研究参照长文」并进设计 v2 | 上限参照 ≠ 产品承诺清单 |
| 把 verification 并进路线图 | 整理稿会反向污染产品目标（ADR 已防） |

分册（00–09）已经做了「结构化提炼」；母本保持**可追溯原文**。

## 与 docs/ 其它目录

| 目录 | 性质 |
|------|------|
| `source/` | 权威原文（少改，只纠错） |
| `00–09` | 工程分册（可迭代、可 ADR） |
| `research/` | 调研笔记入口（可空） |
| `_templates/` | 写新 ADR / 模块说明用 |

## 历史路径

根目录旧文件名已迁移至此。旧链接请改用本表「文件」列。
