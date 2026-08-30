# OEngine 推进路线

路线服务于桌面 WebGPU 的中大型高密度场景，不是完整 AAA 功能清单，也不是六套渲染管线。长期目标见 [DIRECTION](./DIRECTION.md)，目标 workload 见 [TARGETS](./TARGETS.md)，执行细节见 [implementation](./implementation/README.md)。

## 状态入口

本文件只拥有阶段依赖、目标和退出条件，不重复维护任务状态。当前代码事实见 [CURRENT-STATE](./CURRENT-STATE.md)，唯一当前执行入口见 [implementation/README](./implementation/README.md)，任务级状态见对应 implementation package。

## R0 · 真实性与观测（完成）

实施包：[01-baseline-and-observability](./implementation/01-baseline-and-observability.md)

产出真实 CPU/GPU 分段、submit/readback/upload、工作量计数、capability evidence、debug view 和 A/B/C artifact。未实现能力必须为 `unsupported + blockerTaskId`，不得以假零值通过 Gate。

## R1 · Runtime 固定成本（完成）

实施包：[02-runtime-submit-and-framegraph](./implementation/02-runtime-submit-and-framegraph.md)

- 单一 main submit owner。
- Compiled FrameGraph/cache/feature pruning。
- Compute HZB 与显式 per-view history。
- feature-off、in-flight resource 和 clean/full after benchmark 收口。

退出已通过：warm steady frame 一个 main submit、零无条件 readback、graph build/compile 为零、HZB 无逐 mip Render Pass、关闭功能无旁路成本，clean artifact provenance 准确。因缺少同条件 clean/full before，本阶段不声明性能提升百分比。

## R2 · Compact Data Foundation

实施包：[03-runtime-assets-and-gpu-world](./implementation/03-runtime-assets-and-gpu-world.md)、[04-geometry-cooker-and-hierarchy](./implementation/04-geometry-cooker-and-hierarchy.md)

- versioned Runtime Asset Package 与 TS/WGSL ABI validator。
- meshoptimizer 优先的 Meshlet/Cooker、Cluster hierarchy、BVH8 和 geometric error。
- Compact GPU Geometry/Cluster/Instance records 与连续 geometry payload；Material 只接现有 registry handle。
- Mostly-static GPU Scene、Packed Instance Set、bulk upload 和 transform/material patch。
- resident/transient bytes 与 upload counters。

当前不建设完整 ECS、高频 add/remove/reparent、超大世界坐标或 geometry streaming。

退出：多资产和大量 Packed Instances 不依赖一实例一 JS 对象；GPU 表 ABI、容量、owner、上传和内存证据稳定；新数据已由现有 flat Hardware consumer 真实消费。GPU hierarchy/SSE traversal 仍由 R3 完成。

## R3 · Hierarchical Work Generation + Hardware Consumer（Completed）

实施包：[05-hierarchical-work-generation](./implementation/05-hierarchical-work-generation.md)

- Instance → Cluster hierarchy root/children traversal；当前 R2 BVH8 不直接进入 R3 v1 热路径。
- 在 Meshlet 大规模展开前完成 SSE LOD。
- 先完成 CPU/GPU `frustum + SSE` selected-set 对齐，再加入 cone/previous-HZB culling。
- 现有 single `drawIndirect` hardware consumer 正式接通 hierarchy 输出。
- children all-or-nothing reservation、parent fallback 与 max-cut RasterWork capacity。
- main/CSM view 分别记录 queue、round、indirect count、submitted triangle、固定 384-vertex waste、overflow 和 fallback。

R3/G3 已关闭：GPU producer → indirect consumer 闭环成立，CPU 不遍历最终可见列表；Cone/previous HZB、counter/fallback/feature-off 已接入；Packed flat producer/owner 已删除。`R3-D-08/09` 又完成 fused InstanceCull/root、workgroup-local compaction、sampled diagnostics 与 depth-zero fused-leaf。clean commit `aff3ab8` 的 A/B/C full 全部 gate eligible/zero diagnostics，A P95 不再回退、B 继续改善、C 消除低密度固定成本。下一入口是 R4-A。

## R4 · Unified Visibility、Material Resolve 与 Hybrid 优化（核心完成）

R4-A Hardware Visibility 与 R4-B Single Material Resolve 已关闭核心里程碑。Software/Hybrid 不再作为 R4 core 或 R5 的前置依赖。

### R4-A · Hardware Visibility Contract

实施包：[06-hybrid-visibility](./implementation/06-hybrid-visibility.md)

冻结 frame-local VisibilityKey、VisibleCluster lookup、reverse-Z depth、sentinel、alpha-tested、overflow/fallback，并用 Hardware path 建立最小属性重建。

执行编号为 `R4-A-01..06`。Key v1 编码 `rasterWorkSlot + localTriangle`，经 R3 RasterWork 唯一回查 multi-Meshlet Cluster；R4-A 只提前建立 alpha Visibility 所需 Material 子集。

### R4-B · Single Material Resolve

实施包：[07-material-resolve](./implementation/07-material-resolve.md)

状态：2026-08-28 已关闭 Packed G4-B；普通 Scene legacy 类级删除归 consumer 迁移与 `FX-12`。

一次扫描可见像素完成 Standard PBR surface/velocity 重建，删除每材质全屏 Material Expand。纹理先使用有界 bank/resident handle；streaming 不阻塞 v1。

执行编号为 `R4-B-01..10`。优先迁移 R2-D-08/R2-D-09 已验证的 attribute/gradient/frame/velocity，不重新实现同一数学。

### R4-C · Compute SW/Hybrid Profile Optimization（Optional）

实施包：[06-hybrid-visibility](./implementation/06-hybrid-visibility.md)

R4-C 是独立性能研究轨。只有同设备 profile 证明 Hardware Raster/固定 384-vertex waste 是主要瓶颈，并且 triangle-size/cost sweep 给出可信 crossover 时才重新打开。

执行编号仍保留为 `R4-C-01..09`。它必须复用 R4-A/B 的 VisibilityKey/Depth/Resolve ABI；HW-only 始终是完整正确 fallback。R4-C 未执行不阻塞 R4 core 或 R5 退出。

## R5 · Lighting、Shadow、Temporal 与扩展效果（当前主线）

实施包：[08-lighting-temporal-post](./implementation/08-lighting-temporal-post.md)
浏览器 Gate：[R5-BROWSER-GATES](./implementation/R5-BROWSER-GATES.md)
性能矩阵：[R5-BENCHMARK-MATRIX](./implementation/R5-BENCHMARK-MATRIX.md)
参考索引：[R5-ALGORITHM-GUIDE](./references/R5-ALGORITHM-GUIDE.md)

固定执行结构：

```text
R5-00 Contract/Baseline
→ FX-01..03 → G5-L
→ FX-04..05 → G5-S
→ FX-06A → FX-07..08 → FX-06B → G5-T
→ FX-09..12 → G5-P
→ R5 CLOSED
```

- 扩展 Clustered Lighting 到大量动态灯光，并冻结 attempted/written/capacity/overflow 与 conservative fallback。
- 保留 CSM，优化多 Cascade work generation、稳定性和过滤质量。
- IBL 与已有可迁移 GI 先形成基础间接光，不以高级 GI 阻塞阶段。
- Transparency 接入统一 Depth/Surface/Lighting；Decal 因缺少当前 workload 与 ABI/Gate 明确延期。
- Velocity、Temporal Reconstruction、Dynamic Resolution、Upscaling 和 Post。
- Texture resident bytes/mip feedback；由显存证据决定是否增加 mip streaming。

退出：G5-L/S/T/P 全部通过；目标 workload 的画质、GPU 时间、内存、queue/history lifecycle 和 feature-off 成本透明；Packed Shadow/Transparency 不再依赖 legacy work producer；Temporal/Upscaling 在相同输出画质下有可解释收益；`performance-targets.json` 已在目标机器填入绝对门槛。Optional R4-C/高级 GI 不阻塞 R5。

## Deferred

- 完整 World Partition 和开放世界 streaming。
- camera-relative/双精度超大世界坐标。
- Virtual Geometry、Virtual Shadow Map、Virtual Texture 全套系统。
- 地形、植被、角色、粒子、云、海洋和大气专用 Renderer。
- ReSTIR/Lumen-like GI、完整 Gameplay/ECS/Editor。
- Decal（重新进入范围前必须先定义 projection/receiver ABI、material ownership 与 C-decal Gate）。

这些内容保留研究资料和未来接入 seam，但不是当前阶段完成 Gate。
