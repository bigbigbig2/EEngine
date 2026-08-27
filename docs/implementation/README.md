# OEngine 详细实施手册

本目录只拥有执行任务、迁移边界、交付物和 Gate；产品范围由 [DIRECTION](../DIRECTION.md) 与 [TARGETS](../TARGETS.md) 决定，长期决策由 ADR 拥有，当前事实只写入 [CURRENT-STATE](../CURRENT-STATE.md)。完成阶段的历史证据不得反向扩张当前产品范围。

## 执行链

```text
R0 Observe                         complete
→ R1 Runtime/FrameGraph/HZB        complete
→ R2 Compact Data + Cooker
→ R3 Hierarchy + HW Consumer
→ R4-A Visibility Contract
→ R4-B Single Material Resolve
→ R4-C Optional SW/Hybrid
→ R5 Lighting + CSM + Temporal/Upscaling
```

这是一条主管线。R4-C 是性能优化，不是 R4-B 的前置依赖；HW-only 必须始终保持完整正确性与 fallback。

## 文档地图

| 文档 | 工程问题 | 路线 |
|---|---|---|
| [00-execution-governance](./00-execution-governance.md) | 任务、ABI、移植、证据和删除如何治理 | 全阶段 |
| [01-baseline-and-observability](./01-baseline-and-observability.md) | 当前一帧慢在哪里、证据是否真实 | R0，完成 |
| [02-runtime-submit-and-framegraph](./02-runtime-submit-and-framegraph.md) | submit、compiled graph、Compute HZB、history | R1，完成 |
| [03-runtime-assets-and-gpu-world](./03-runtime-assets-and-gpu-world.md) | Compact asset/tables、Packed Instances、bulk/patch upload | R2 |
| [04-geometry-cooker-and-hierarchy](./04-geometry-cooker-and-hierarchy.md) | Meshlet、Cluster hierarchy、误差和 BVH8 | R2 |
| [05-hierarchical-work-generation](./05-hierarchical-work-generation.md) | hierarchy → compact queue → existing HW indirect consumer | R3 |
| [06-hybrid-visibility](./06-hybrid-visibility.md) | R4-A HW contract 与 R4-C SW/Hybrid 优化 | R4-A/R4-C |
| [07-material-resolve](./07-material-resolve.md) | 删除每材质全屏扫描，单次 Standard PBR Resolve | R4-B |
| [08-lighting-temporal-post](./08-lighting-temporal-post.md) | 动态灯光、CSM、透明、Temporal/Upscaling/Post | R5 |
| [09-migration-and-deletion](./09-migration-and-deletion.md) | 旧链保留、重写和删除 | 全阶段 |
| [10-verification-matrix](./10-verification-matrix.md) | 正确性、性能、内存和回归 Gate | 全阶段 |

## 当前唯一入口

R0/G0、R1/G1 与 R2-A/B 已关闭。当前唯一执行入口是 R2-C Residency +
Compact Tables，并沿同一 R2 Compact Data Foundation 顺序继续：

1. `R2-A Package Kernel`：已完成；冻结 SourceGeometry、版本化 package kernel、reader/writer/validator 和黄金资产；
2. `R2-B Cooked Geometry`：已完成；以可追溯开源实现生成 Meshlet、renderable hierarchy、geometric error、BVH8 与未压缩 streams/material package；
3. `R2-C Residency + Compact Tables`：冻结 Geometry/Cluster GPU records、stable handle、bulk residency 与内存证据；
4. `R2-D Packed Scene Vertical`：冻结 Instance record/Packed Instances/patch，并让现有 Hardware consumer 真实消费新数据；
5. 删除 package 主路径上的 runtime Meshlet build、重复 Geometry residency 与重复 Instance owner。

R2 只新增 Geometry、Cluster、Instance 三张必需 record table；Material 使用现有 registry 的 validated handle reference，Texture/Light 全面重构不进入 G2。R2 会生成、验证并驻留 hierarchy 数据，但 GPU hierarchy/SSE traversal 属于 R3。

不得重新打开 G0/G1，也不得在 R2 中提前加入 SW Raster 或用旧 Material Expand 的兼容层掩盖数据迁移。

## Gate

| Gate | 退出证据 |
|---|---|
| G0 Observe | Schema/counter/unsupported、A/B/C artifact 可解释；完成 |
| G1 Runtime | one-submit、compiled graph、Compute HZB、feature-off/in-flight 与 clean/full after 证据；完成 |
| G2 Data | versioned package、Cooked hierarchy data、Geometry/Cluster/Instance tables、Packed Instances、bulk/patch upload、resident bytes、现有 Hardware consumer 接线 |
| G3 Work | hierarchy/SSE 在展开前减量，compact queue 被 single indirect HW consumer 直接消费 |
| G4-A Visibility | HW key/depth/lookup/alpha/overflow 正确 |
| G4-B Resolve | single PBR resolve、velocity、材质扩展曲线通过，旧 Material Expand 删除 |
| G4-C Hybrid | SW/HW 对照正确，Hybrid 只在有收益 workload 启用 |
| G5 Quality | dynamic lights、CSM、Temporal/Upscaling、Transparency/Decal 和 feature-off 可解释 |

## 完成规则

任务只有在适用内容全部满足时才完成：

1. 真实 GPU producer/consumer 接通；
2. ABI、capacity、owner、overflow/fallback 和必要的 in-flight 安全成立；
3. CPU/reference/GPU/browser 正确性证据匹配风险；
4. 性能任务有相同条件的前后数据；
5. 外部算法有 source/commit/license/adaptation/benchmark 记录；
6. 被替代旧实现已删除或有明确截止任务；
7. 只更新唯一状态 owner，其他文档使用链接。

## 历史任务 ID 映射

R0 artifact 与已关闭文档中的 blocker ID 是历史证据，不回写修改。进入 R2 后按以下映射解释：

| 历史 ID | 当前执行 owner |
|---|---|
| `WORLD-02..06` | `R2-A` / `R2-C` |
| `WORLD-07`（Packed Instances） | `R2-D` |
| `WORLD-09..10` | `R2-D` consumer 迁移与删除 |
| `COOK-01..03` | `R2-A` |
| `COOK-04..10` | `R2-B`，GPU residency/删除部分由 `R2-C/D` 关闭 |

新任务和提交使用 `R2-A-xx`～`R2-D-xx`；历史 JSON 中的 `WORLD/COOK` blocker 保持原值，避免伪造证据来源。

## 当前明确排除

- 超大世界坐标、完整 World Partition、虚拟几何 streaming。
- 地形、植被、角色、粒子、云、海洋、大气专用系统。
- 完整 ECS、Gameplay 和高频动态对象生命周期。
- 未经 profile 的 Compute Raster 全量替换。
- MDI、mesh shader、64 位原子作为 WebGPU baseline。
- Core/Quality/Experimental 三档真实管线。
