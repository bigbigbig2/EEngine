# 07 · Roadmap — 落地顺序

> **目标身份**以设计 v2 为准（不删 Layer 3 能力）。  
> **阶段划分**以设计 v2 §23 为主轴，与 `docs/source/modules-phases-verification.md` 对照。  
> **架构动机**见 `docs/source/comparison-three-vs-shade.md`；**外壳**见 `docs/source/webgpu-browser-limits.md`。

## 本区文件

| 文件 | 内容 |
|------|------|
| [stages.md](./stages.md) | 设计 v2 Phase 0–11 设计意图 |
| [phase-0-3-closed-loop.md](./phase-0-3-closed-loop.md) | **Phase 0–3 最小闭环**（模式 A 串讲与验收清单） |
| [execution-plan-by-module.md](./execution-plan-by-module.md) | **按模块分阶段执行计划**（S\* 子阶段 + 门闸 + 迭代片） |
| [stage-groups.md](./stage-groups.md) | 大阶段分组（与 verification 三级火箭对照） |
| [phase-module-matrix.md](./phase-module-matrix.md) | 阶段 × 模块 |
| [verification-intent.md](./verification-intent.md) | 验收在设计层的含义（非填表实现） |
| [risks-and-degrade.md](./risks-and-degrade.md) | 风险与降级（设计 v2 §24 + verification） |
| [phase-data-pass-map.md](./phase-data-pass-map.md) | 阶段 × 数据表 × Pass |

## 铁律

```txt
1. 路线图 = 建设顺序，≠ 改产品公式
2. 未达阶段门槛 ≠ 取消后续能力
3. docs/source/comparison-three-vs-shade.md：小场景可不走满 Layer 3；默认配置可关，能力仍保留
4. verification 草案若与设计 v2 能力全集冲突 → 以设计 v2 为准
```

## 读法

```txt
设计 v2 §23 原文（根目录）
  → stages.md（分册）
  → phase-0-3-closed-loop.md（先串通里程碑 A / 模式 A）
  → execution-plan-by-module.md（动手：每模块多阶段 + 迭代片）
  → stage-groups.md（如何讲里程碑）
  → phase-module-matrix.md（谁在哪阶段主责）
  → verification-intent.md（如何证明「阶段完成」）
```
