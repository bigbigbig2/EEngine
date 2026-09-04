# OEngine 推进路线

本文件只描述阶段依赖、目标和下一跳，不拥有当前完成状态。当前源码事实与阶段状态分别见 [CURRENT-STATE](./CURRENT-STATE.md) 和 [implementation/STATUS](./implementation/STATUS.md)；可执行任务入口见 [implementation/README](./implementation/README.md)。

## 当前路线

```text
R0/R1 真实性与运行时固定成本
  → R2 Compact Data Foundation
  → R3 Hierarchical Work Generation
  → R4 Visibility / Surface Contract
  → R5 Lighting / Temporal / Post
  → G5-P Product Closure
```

各阶段的“是否完成”只在 `implementation/STATUS.md` 维护。下面只保留每个阶段的责任边界，避免路线、状态和证据重复维护。

## R0–R1 · 真实性与运行时基础

历史范围：R0 观测、R1 提交/FrameGraph/HZB；当前事实见 [STATUS](./implementation/STATUS.md)。

责任边界：真实 CPU/GPU 分段、submit/readback/upload 计数、能力证据、单主提交、compiled FrameGraph、Compute HZB、feature pruning 和资源生命周期。它们解决固定成本与观测真实性，不代表最终画质或整帧性能。

## R2 · Compact Data Foundation

历史范围：Runtime Asset、Geometry Cooker、GPU Scene 和 residency；当前事实见 [STATUS](./implementation/STATUS.md)。

责任边界：版本化 Runtime Asset Package、Geometry/Cluster/Instance GPU 表、Cooker hierarchy、mostly-static GPU Scene、Packed Instances、bulk/patch 上传和 residency 证据。当前不建设完整 ECS、高频对象生命周期、超大世界或 geometry streaming。

## R3 · Hierarchical Work Generation

历史范围：Hierarchy/SSE/work generation；当前事实见 [STATUS](./implementation/STATUS.md)。

责任边界：Instance → Cluster hierarchy traversal、SSE LOD、frustum/cone/previous-HZB culling、GPU work queue、RasterWork 和 indirect Hardware consumer。GPU producer 必须直接被 GPU consumer 消费；CPU 不生成最终可见列表。R3 的历史证据和采用记录见 [R3 porting ledger](./references/porting/R3-01-hierarchical-work-generation.md)。

## R4 · Visibility / Surface Contract

历史范围：VisibilityKey、Hardware Visibility 和 Single Material Resolve；当前事实见 [STATUS](./implementation/STATUS.md)。

责任边界：统一 `VisibilityKey`、reverse-Z depth、alpha-tested、容量/fallback、`RasterWork → Surface` lookup 和单次 Standard PBR Material Resolve。Compute Software Raster/Hybrid 是可选研究 adapter，不是当前主路径前置条件。普通 Scene 的 legacy consumer 是否可删除，以当前引用和后续 FX-12 为准。

## R5 · Lighting / Temporal / Post（当前主线）

当前执行设计：[11-render-pipeline-reconstruction](./implementation/11-render-pipeline-reconstruction.md)

状态矩阵：[implementation/STATUS](./implementation/STATUS.md)

浏览器证据规则：[R5-BROWSER-GATES](./implementation/R5-BROWSER-GATES.md)

性能矩阵：[R5-BENCHMARK-MATRIX](./implementation/R5-BENCHMARK-MATRIX.md)

目标设计快照：[13-product-render-pipeline-redesign](./implementation/13-product-render-pipeline-redesign.md)

当前执行顺序：

```text
R5-Q00 Evidence Freeze
  → Q01 Render Contract
  → Q02 Composition
  → Q03 GTAO
  → Q04 SSR
  → Q05 / FX-06B Final Temporal-TAAU
  → Q06 FramePlan / FrameGraph
  → FX-09 Post
  → FX-10/11 Selective Extension and Fusion
  → FX-12 Legacy Deletion
  → G5-P Product Closure
```

R5 的目标是把现有局部算法收敛为一条统一主管线：Surface → clustered direct/shadow → GI/IBL/AO/SSR → transparency → temporal/upscale → HDR post。Feature owner 的存在、focused Gate 或局部 shader 修正都不能单独关闭 G5-P。完整状态、真实 owner、旧路径和未关闭 Gate 只看 [STATUS](./implementation/STATUS.md)。

## Deferred

以下内容保留研究资料和未来接入 seam，但不进入当前 Gate：

- 完整 World Partition、超大世界坐标和 geometry/virtual texture streaming；
- Virtual Geometry、Virtual Shadow Map、ReSTIR/Lumen-like GI、硬件光追；
- 地形、植被、角色、粒子、云、海洋和大气专用 Renderer；
- 完整 Gameplay/ECS/Editor 生命周期；
- Decal，除非先定义 receiver/material ABI 和独立 Gate。

重新提升 Deferred 项目前，必须新增或更新 ADR、目标 workload 和性能/正确性 Gate。

## 历史文档规则

`implementation/00–10`、旧 P0–P9 分册和早期 R5 总设计已从工作树删除；历史提交与 artifact 通过 Git 追溯。它们不再作为当前 R5 执行入口，也不能覆盖 `CURRENT-STATE`、`STATUS` 或 `11-render-pipeline-reconstruction`。
