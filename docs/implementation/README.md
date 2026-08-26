# OEngine 详细实施手册

本目录把 [ROADMAP.md](../ROADMAP.md) 的 R0–R5 转换为可以直接领取、实现和验收的工程包。方向、架构和长期决策仍由上层文档与 ADR 决定；本目录只拥有执行顺序、交付物、迁移边界和验证门槛。

## 最终交付链

```text
R0 真实性与观测
  ↓
R1 单帧提交、FrameGraph、HZB 固定成本
  ↓
R2 Runtime Asset、GPU Render World、Cooker
  ↓
R3 层次遍历、SSE LOD、紧凑工作生成
  ↓
R4 SW/HW Hybrid Visibility
  ↓
R5 单次 Material Resolve、Lighting、Temporal/Post
```

这不是六套可并存的渲染管线。迁移期间可以短暂保留对照开关，但阶段退出时必须删除已被替代的旧主链。最终始终只有 [统一主管线](../RENDER-PIPELINE.md)，功能按依赖启停，关闭后接近零成本。

## 文档地图

| 文档 | 工程问题 | 对应路线 |
|---|---|---|
| [00-execution-governance.md](./00-execution-governance.md) | 如何拆任务、冻结 ABI、提交证据和删除旧链 | 全阶段 |
| [01-baseline-and-observability.md](./01-baseline-and-observability.md) | 如何先知道当前一帧慢在哪里 | R0 |
| [02-runtime-submit-and-framegraph.md](./02-runtime-submit-and-framegraph.md) | 如何消除多 submit、重复 compile 和逐 mip Render Pass | R1 |
| [03-runtime-assets-and-gpu-world.md](./03-runtime-assets-and-gpu-world.md) | Runtime Asset、stable handle、Change Set、Packed Instance Set | R2 |
| [04-geometry-cooker-and-hierarchy.md](./04-geometry-cooker-and-hierarchy.md) | Cooker、Meshlet、Cluster hierarchy、误差和 BVH8 | R2 |
| [05-hierarchical-work-generation.md](./05-hierarchical-work-generation.md) | Instance → hierarchy → selected cluster → raster queue | R3 |
| [06-hybrid-visibility.md](./06-hybrid-visibility.md) | 两阶段软件微光栅、硬件光栅和统一 VisibilityKey | R4 |
| [07-material-resolve.md](./07-material-resolve.md) | 删除每材质全屏扫描，建立单次 Standard PBR Resolve | R5 |
| [08-lighting-temporal-post.md](./08-lighting-temporal-post.md) | 在同一主管线逐项恢复光照、透明、时域和后处理 | R5 |
| [09-migration-and-deletion.md](./09-migration-and-deletion.md) | 哪些现有模块保留、重写、断开和删除 | 全阶段 |
| [10-verification-matrix.md](./10-verification-matrix.md) | 正确性、性能、跨设备与回归如何判定 | 全阶段 |

## 执行单位

实施任务使用文档内稳定 ID，例如 `OBS-03`、`R1-A04`、`VIS-07`。一个实现任务只有在以下适用内容同时存在时才可标为完成：

1. 真实主帧 producer 与 GPU consumer 已接通；
2. ABI、容量、owner、生命周期和 overflow 已实现；
3. 正确性验证通过；
4. 固定 benchmark 有变更前后证据；
5. 被替代的旧代码已经删除，或有带截止任务 ID 的短期迁移记录；
6. `CURRENT-STATE`、领域 Context、ADR 和本文档按影响更新。

“适用”由任务自己的交付物决定，不允许循环依赖制造永远无法完成的状态。例如 `OBS-01～07` 建设采集系统，其完成证据是 schema/ABI 测试、真实主帧接入和 smoke；clean/full A/B/C run bundle 在后续性能阶段开始修改前按命中场景刷新。后续阶段的算法、画质和性能目标不得倒灌成 R0 观测任务的完成条件。

## 阶段门禁

| Gate | 可以开始的条件 | 退出证据 |
|---|---|---|
| G0 · Observe | 当前工程可构建运行 | A/B/C 对照契约已冻结；当前能力有真实 GPU 证据，未实现能力有 `unsupported + blockerTaskId`，无缺字段/零值歧义 |
| G1 · Runtime | G0 可解释固定成本 | 稳定帧一个主要 submit、图缓存、Compute HZB、feature off 零旁路成本 |
| G2 · Data | Runtime Asset/Resident seam 已写入测试 | versioned package、稳定 handle、增量 Change Set、Packed Instance Set 可运行 |
| G3 · Hierarchy | Cooker 能产出并校验 hierarchy/BVH8 | GPU 在 Meshlet 展开前完成 SSE 选择，队列无静默 overflow |
| G4 · Visibility | VisibleCluster ABI 和队列已冻结 | HW/SW/Hybrid 可对照，深度/ID 正确，Hybrid 有目标场景收益 |
| G5 · Shading | 统一 VisibilityKey 稳定 | 单次 PBR Resolve 和效果依赖图通过 B/C 画质与性能门禁 |

阶段允许重叠的只有不依赖未冻结 ABI 的调查、测试夹具和离线工具；不得一边改变上游 ABI，一边把下游大规模实现建立在猜测上。

G0 的“证据完整”不等于 R2–R5 产品能力已经存在。G0 允许 artifact 机器结构合格但 `capabilityComplete=false`，前提是所有 blocker 可追溯且没有假 counter；A/B 的真实功能与性能通过仍在对应后续 Gate 判定。

当前 R0/G0 已完成；R1 的 `R1-A` one-submit 与 `R1-B` Compiled FrameGraph/feature pruning 也已通过自动门禁和 Frame Smoke/A/B/C 浏览器功能验收。下一步执行 [R1-C Compute HZB 与 history contract](./02-runtime-submit-and-framegraph.md#r1-c--compute-hzb-与-history-contract)，随后由 `R1-D` 统一完成生命周期、删除和 clean/full paired gate。不得把后续算法、正式性能采样或可选观测增强重新加入 G0 blocker。

## 明确排除

- 不建立 Core/Quality/Experimental 三档真实管线。
- 不增加 three.js API、Scene、Material、TSL 或 Loader 兼容层。
- 不把 64 位原子、multi-draw-indirect、mesh/task shader、buffer device address 当作 WebGPU baseline。
- 不在全驻留 hierarchy 正确且可测前实现 geometry streaming。
- 不用“已有 Pass/Shader/类”代替真实主帧接入与性能证据。

## 从哪里开始

第一次执行先完成 [00-execution-governance.md](./00-execution-governance.md) 的任务卡模板，然后严格从 [01-baseline-and-observability.md](./01-baseline-and-observability.md) 开始。没有 R0 数据时，不允许把当前性能差归因为“只是 LOD”“只是软光栅”或任何单一模块。
