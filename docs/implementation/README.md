# OEngine 详细实施手册

本目录只拥有执行任务、迁移边界、交付物和 Gate；产品范围由 [DIRECTION](../DIRECTION.md) 与 [TARGETS](../TARGETS.md) 决定，长期决策由 ADR 拥有，当前事实只写入 [CURRENT-STATE](../CURRENT-STATE.md)。完成阶段的历史证据不得反向扩张当前产品范围。

## 执行链

```text
R0 Observe                         complete
→ R1 Runtime/FrameGraph/HZB        closing
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
| [02-runtime-submit-and-framegraph](./02-runtime-submit-and-framegraph.md) | submit、compiled graph、Compute HZB、history | R1，收口中 |
| [03-runtime-assets-and-gpu-world](./03-runtime-assets-and-gpu-world.md) | Compact asset/tables、Packed Instances、bulk/patch upload | R2 |
| [04-geometry-cooker-and-hierarchy](./04-geometry-cooker-and-hierarchy.md) | Meshlet、Cluster hierarchy、误差和 BVH8 | R2 |
| [05-hierarchical-work-generation](./05-hierarchical-work-generation.md) | hierarchy → compact queue → existing HW indirect consumer | R3 |
| [06-hybrid-visibility](./06-hybrid-visibility.md) | R4-A HW contract 与 R4-C SW/Hybrid 优化 | R4-A/R4-C |
| [07-material-resolve](./07-material-resolve.md) | 删除每材质全屏扫描，单次 Standard PBR Resolve | R4-B |
| [08-lighting-temporal-post](./08-lighting-temporal-post.md) | 动态灯光、CSM、透明、Temporal/Upscaling/Post | R5 |
| [09-migration-and-deletion](./09-migration-and-deletion.md) | 旧链保留、重写和删除 | 全阶段 |
| [10-verification-matrix](./10-verification-matrix.md) | 正确性、性能、内存和回归 Gate | 全阶段 |

## 当前唯一入口

R0、R1-A、R1-B 已关闭。R1-C 代码与独立 GPU prototype 已通过，下一执行包是将 R1-C 主页面证据与 R1-D 一次性收口：

1. 重启服务并刷新 commit/dirty provenance；
2. 采集 Frame Smoke/A/B/C 命中页面和 HZB phase/counter；
3. 验证 feature-off、resize/camera-cut 与 in-flight resource；
4. 登记 paired 结论并关闭 G1；
5. 直接开始 R2 Compact Data Foundation。

不得重新打开 G0，也不得在 R1 中提前加入 Cooker、Hierarchy、SW Raster 或 Material Resolve。

## Gate

| Gate | 退出证据 |
|---|---|
| G0 Observe | Schema/counter/unsupported、A/B/C artifact 可解释；完成 |
| G1 Runtime | one-submit、compiled graph、Compute HZB、feature-off/in-flight/paired 证据 |
| G2 Data | versioned package、compact tables、Packed Instances、bulk/patch upload、resident bytes |
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

## 当前明确排除

- 超大世界坐标、完整 World Partition、虚拟几何 streaming。
- 地形、植被、角色、粒子、云、海洋、大气专用系统。
- 完整 ECS、Gameplay 和高频动态对象生命周期。
- 未经 profile 的 Compute Raster 全量替换。
- MDI、mesh shader、64 位原子作为 WebGPU baseline。
- Core/Quality/Experimental 三档真实管线。
