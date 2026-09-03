# OEngine 详细实施手册

本目录只拥有执行任务、迁移边界、交付物和 Gate；产品范围由 [DIRECTION](../DIRECTION.md) 与 [TARGETS](../TARGETS.md) 决定，长期决策由 ADR 拥有，当前事实只写入 [CURRENT-STATE](../CURRENT-STATE.md)。完成阶段的历史证据不得反向扩张当前产品范围。

## 执行链

```text
R0 Observe                         complete
→ R1 Runtime/FrameGraph/HZB        complete
→ R2 Compact Data + Cooker          complete
→ R3 Hierarchy + HW Consumer        complete
→ R4-A Visibility Contract            complete
→ R4-B Single Material Resolve        complete for Packed production
→ Packed Asset → Surface direct reconstruction   designed / two-step migration
→ R5 Lighting + CSM + Temporal/Upscaling   current mainline
↘ R4-C Optional SW/Hybrid performance track
```

R4 core（A/B）已经关闭。R4-C 只在 profile 证明 HW raster 是主要瓶颈且 Hybrid 有收益时重新打开；R5 correctness/quality 不等待 R4-C，HW-only 必须始终保持完整正确性与 fallback。

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
| [08-lighting-temporal-post](./08-lighting-temporal-post.md) | R5 架构、FX-01..12 与 G5-L/S/T/P 子 Gate | R5 |
| [R5-BENCHMARK-MATRIX](./R5-BENCHMARK-MATRIX.md) | B-shading 与 C-light/shadow/transparent/temporal/resolution 扩展轴 | R5 |
| [R5-BROWSER-GATES](./R5-BROWSER-GATES.md) | 每阶段 production browser、自动截图/数值/sequence Gate 与 artifact 清单 | R5 |
| [09-migration-and-deletion](./09-migration-and-deletion.md) | 旧链保留、重写和删除 | 全阶段 |
| [10-verification-matrix](./10-verification-matrix.md) | 正确性、性能、内存和回归 Gate | 全阶段 |
| [11-render-pipeline-reconstruction](./11-render-pipeline-reconstruction.md) | R5 Shading/Screen-space/Temporal/Post 的 contract-first 重构与综合证据基线 | R5-Q00..Q06，G5-T/G5-P 前置 |
| [12-packed-asset-to-surface-reconstruction](./12-packed-asset-to-surface-reconstruction.md) | 从 Packed glTF 到 Surface 的单链直接重构：资产聚合、事务驻留、精确 RasterWork/Key、材质分类和紧凑 Surface | 两步直接迁移，设计完成、代码未实施 |
| [13-product-render-pipeline-redesign](./13-product-render-pipeline-redesign.md) | 本次确认的产品级目标架构、效果组合、开源移植和硬切换重构策略 | 新渲染管线总设计，实施前置 |
| [14-p0-source-mapping-and-deletion](./14-p0-source-mapping-and-deletion.md) | P0 真实源码映射、目标 Feature owner、删除候选和 P1 入口 Gate | P0，实施前置 |
| [15-p1-frame-infrastructure](./15-p1-frame-infrastructure.md) | Render Feature 注册表、FrameGraph 资源生命周期摘要和主帧证据接线 | P1，已实现 |
| [16-p2-scene-contract-and-config](./16-p2-scene-contract-and-config.md) | GPU Scene/Frame Contract、初始化配置归一化和 WebGPU 能力 fail-fast | P2，已实现基础合同 |

## 当前唯一入口

R0/G0、R1/G1 与 R2/G2 已关闭。R2 Compact Data Foundation 的交付顺序为：

1. `R2-A Package Kernel`：已完成；冻结 SourceGeometry、版本化 package kernel、reader/writer/validator 和黄金资产；
2. `R2-B Cooked Geometry`：已完成；以可追溯开源实现生成 Meshlet、renderable hierarchy、geometric error、BVH8 与未压缩 streams/material package；
3. `R2-C Residency + Compact Tables`：已完成；Geometry/Cluster/Meshlet GPU ABI、stable handle、bulk residency、生命周期和内存证据已落地，flat 黄金资产通过 live 浏览器 GPU readback、Hardware `drawIndirect` 画面和 WebGPU validation 门禁；
4. `R2-D Packed Scene Vertical`：Instance record、GpuScene owner、Packed/普通 Scene source、bulk/patch/stable-frame 已完成；A/B/C 与真实 Damaged Helmet glTF 已进入 Cooker → Package → Packed Geometry/Instance → production Hardware Visibility/Material/Velocity 主链；
5. package/Packed 主路径不创建等量 `Mesh/Node3D`，旧 `MeshletGpuTable` 改为 legacy Scene consumer 才惰性创建，因此新主路径不存在重复 Geometry/Instance owner。旧 Scene consumer 的全局删除随 R3 工作生成迁移完成，不能反向把它当作 G2 数据 Gate blocker。

R3/G3 已在 clean commit `aff3ab8` 关闭：`InstanceCull + root` 融合、root/traversal/selected workgroup-local compaction、sampled diagnostics 与 depth-zero fused-leaf 已落地；full A/B/C 均 clean/gate eligible/zero diagnostics，A P95 不再回退历史 flat、B 继续改善、C 真实命中 fused-leaf 并消除固定成本。R3 v1 不直接遍历当前独立 BVH8；原因、长期决策和来源分别见 [ADR-0009](../wiki/adr/0009-r3-cluster-hierarchy-work-generation.md) 与 [R3-01 porting ledger](../references/porting/R3-01-hierarchical-work-generation.md)。当前唯一执行入口转为 R4-A Visibility contract。

R4 已完成执行前设计冻结，长期边界见 [ADR-0010](../wiki/adr/0010-r4-unified-visibility-contract.md)，研究来源见 [R4 algorithm guide](../references/R4-ALGORITHM-GUIDE.md)。`R4-A-01..06` 已关闭 G4-A；A/B Hardware Raster 回退仍作为独立 phase 风险保留。`R4-B-01..06/09` 已集成，条件任务 `R4-B-07/08` 因无资产/profile 证据而跳过，Packed `R4-B-10` 已删除 per-material fullscreen、旧 auxiliary MRT 与 Packed Velocity。2026-08-28 的 clean/full B/C Gate 证明 active material `1 → 3` 时 Resolve draw 恒为 1、Surface 为 26 B/pixel、fallback/invalid/overflow/WebGPU diagnostics 为 0；C P50 相对旧 3-draw 链改善约 11.9%，B 因加入完整纹理与 velocity 回退，已如实登记。普通 `Scene` legacy MaterialExpand/Velocity 仍有公开 consumer，但只惰性创建且 Packed 帧零成本，类级删除归 `FX-12`。R4 core（G4-A/G4-B）已经关闭；`R4-C-01..09` 改为 optional performance track，不属于当前主线 Gate。R5 当前执行顺序为 `R5-00 → FX-01..03 → G5-L → FX-04..05 → G5-S → FX-06A → FX-07..08 → R5-Q00..Q04 → R5-Q05/FX-06B → G5-T → R5-Q06 → FX-09..12/G5-P`；旧 `VIS/MAT` 编号只保留历史含义，不再生成新提交或 artifact。

R5-00、FX-01 Surface、FX-02 Clustered Direct、FX-03 IBL Alignment、G5-L、FX-04 Packed CSM Shadow、FX-05 Packed MBOIT Transparency、G5-S、FX-06A Temporal Foundation、FX-07 AO 与 FX-08 SSR 已关闭。FX-06A 由 commit `c52ef48` 冻结 shared history/invalidation、reactive/disocclusion、jitter/internal-output resolution 和 delayed DRS feedback；FX-07 clean-scope commit `548f18d` 关闭 AO；FX-08 clean commit `62158e9` 保留并 revalidate 当前 authored SSR，接入 shared history、FX-03 miss fallback、hit/miss/history debug 与 feature-off 零 owner/Pass/history/timestamp，并删除重复 final composite。证据分别见 `temp/r5/fx-06/c52ef486917913ca7951b568a8db519980a40e73-dirty-c500aa424fc6/`、`temp/r5/fx-07/548f18d0fbf5dc60c00cee4b7b057646a0fd6ba7-dirty-7caa62fbab90/` 与 `temp/r5/fx-08/62158e9f20c081d12a832f01ae057678346e3796/`。根 `performance-targets.json` 已冻结目标机器与产品/回归预算且明确产品目标尚未达成。

2026-09-01 Cyberpunk City 综合示例暴露出 focused Gate 未覆盖的产品级画质、性能与显存问题。当前执行入口调整为 [R5-Q Quality / Pipeline Architecture Closure](./11-render-pipeline-reconstruction.md)：先完成 `R5-Q00` before artifact，再依次建立 Render Contract、重建 Composition、升级 GTAO/SSR，并以 `R5-Q05/FX-06B` 完成 Temporal，最后关闭 FrameGraph/FramePlan。历史 FX-07/08 Gate 仍作为局部合同证据保留，但不能关闭 G5-T/G5-P；R5-Q 不建立第二条主管线，也不撤销 R2–R4 已接受契约。

2026-09-03 的 production Dungeon 分段证据进一步确认：`Hierarchy / Work Generation P50 0.20 ms`、`Hardware Raster P50 3.34 ms`、`Material Resolve / Surface P50 15.66 ms`，同时存在 806 tiny packages、7,958 uploads、固定 384-vertex RasterWork、通用逐像素 stream 解释和约 1.4 GiB allocated memory。新的执行设计见 [Packed Asset 到 Surface 主链直接重构](./12-packed-asset-to-surface-reconstruction.md)。它只处理 `Packed glTF → Surface`，不决定 Surface 之后的 Forward/Deferred/Lighting；实施时沿用现有产品名称直接迁移并删除旧 ABI，不建立 `V2` 或第二条生产路径。执行只分两步：第一步完成资产到 VisibilityKey，第二步完成 Material Resolve 到 Surface、删除旧链并验收。

R3 集中为四个可运行包：

1. `R3-A Reference + ABI`：已完成；multi-instance CPU oracle、queue schema、max-cut capacity 和整组 children fallback 已由定向测试冻结；
2. `R3-B Hierarchy Producer`：已完成；InstanceCull → root → ping/pong Cluster traversal 已在真实 WebGPU 上只启用 Frustum + SSE，并与 multi-instance CPU oracle selected set 对齐；
3. `R3-C Hardware Vertical`：已完成；VisibleCluster 在 GPU 上展开为 RasterWork，写满 16 B `drawIndirect` record，并由生产 Packed Hardware consumer 直接消费；clean/full flat/hierarchy paired A/B/C 已登记，其中 B 是明确胜例，A 的 producer 阶段回退，C 显示低密度固定成本；
4. `R3-D Enhancement + Deletion`：已完成；RasterWork expansion 使用每 Cluster 64-lane workgroup，Cone/previous HZB、真实 counter 与 feature-off 已接入，Packed flat producer/owner 已删除。`R3-D-08/09` 又融合 InstanceCull/root、压缩 workgroup 全局预约、把 diagnostics 改为 sampled/opt-in，并为 depth-zero 小场景加入同 ABI fused-leaf；commit `aff3ab8` 的 clean/full A/B/C 已关闭 G3 performance。

R2 只新增 Geometry、Cluster、Instance 三张必需 record table；Material 使用现有 registry 的 validated handle reference，Texture/Light 全面重构不进入 G2。R2 会生成、验证并驻留 hierarchy 数据，但 GPU hierarchy/SSE traversal 属于 R3。

不得重新打开 G0/G1，也不得在 R2 中提前加入 SW Raster 或用旧 Material Expand 的兼容层掩盖数据迁移。

## Gate

| Gate | 退出证据 |
|---|---|
| G0 Observe | Schema/counter/unsupported、A/B/C artifact 可解释；完成 |
| G1 Runtime | one-submit、compiled graph、Compute HZB、feature-off/in-flight 与 clean/full after 证据；完成 |
| G2 Data | versioned package、Cooked hierarchy data、Geometry/Cluster/Instance tables、Packed Instances、bulk/patch upload、resident bytes、现有 Hardware consumer 接线 |
| G3 Work | hierarchy/SSE 在展开前减量，compact queue 被 single indirect HW consumer 直接消费 |
| G4-A Visibility | HW key/depth/lookup/alpha/overflow 正确；完成 |
| G4-B Resolve | single PBR resolve、velocity、材质扩展曲线通过，Packed 旧链删除；完成 |
| G4-C Hybrid | optional；仅在重新打开 R4-C 时要求 SW/HW 对照正确且 Hybrid 对目标 workload 有收益 |
| G5-L Lighting | Surface ABI、direct lighting、cluster overflow、IBL/B-shading oracle |
| G5-S Secondary Raster | Packed CSM、Packed MBOIT Transparency、alpha/overflow/lifecycle |
| G5-T Temporal | Temporal/DRS/Upscale、AO/SSR sequence、reactive/history/resize/cut |
| G5-P Product Closure | Post、feature-off、legacy 删除、shader ownership、clean/full performance/cross-device |

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
| `COOK-11` | three.js 预制 LOD/Meshlet 配方的精确 benchmark 资产接入；不反向否定 R3 已消费 OEngine Cooker hierarchy |

新任务和提交使用 `R2-A-xx`～`R2-D-xx`；历史 JSON 中的 `WORLD/COOK` blocker 保持原值，避免伪造证据来源。

## 当前明确排除

- 超大世界坐标、完整 World Partition、虚拟几何 streaming。
- 地形、植被、角色、粒子、云、海洋、大气专用系统。
- 完整 ECS、Gameplay 和高频动态对象生命周期。
- 未经 profile 的 Compute Raster 全量替换。
- MDI、mesh shader、64 位原子作为 WebGPU baseline。
- Core/Quality/Experimental 三档真实管线。
