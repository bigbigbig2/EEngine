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

## R3 · Hierarchical Work Generation + Hardware Consumer

实施包：[05-hierarchical-work-generation](./implementation/05-hierarchical-work-generation.md)

- Instance → Cluster hierarchy root/children traversal；当前 R2 BVH8 不直接进入 R3 v1 热路径。
- 在 Meshlet 大规模展开前完成 SSE LOD。
- 先完成 CPU/GPU `frustum + SSE` selected-set 对齐，再加入 cone/previous-HZB culling。
- 现有 single `drawIndirect` hardware consumer 正式接通 hierarchy 输出。
- children all-or-nothing reservation、parent fallback 与 max-cut RasterWork capacity。
- main/CSM view 分别记录 queue、round、indirect count、submitted triangle、固定 384-vertex waste、overflow 和 fallback。

退出：GPU producer → indirect consumer 闭环成立，CPU 不遍历最终可见列表；相比 flat Meshlet 主链，Raster 前工作量和目标场景 GPU 时间有可量化改善；Packed flat producer/owner 已删除。执行按 R3-A Reference/ABI、R3-B Hierarchy producer、R3-C Hardware vertical、R3-D Cone/HZB/deletion 四包收口。

## R4 · Unified Visibility、Material Resolve 与 Hybrid 优化

R4 按固定顺序执行，不把 Software Raster 作为 Material Resolve 的前置依赖。

### R4-A · Hardware Visibility Contract

实施包：[06-hybrid-visibility](./implementation/06-hybrid-visibility.md)

冻结 frame-local VisibilityKey、VisibleCluster lookup、reverse-Z depth、sentinel、alpha-tested、overflow/fallback，并用 Hardware path 建立最小属性重建。

### R4-B · Single Material Resolve

实施包：[07-material-resolve](./implementation/07-material-resolve.md)

一次扫描可见像素完成 Standard PBR surface/velocity 重建，删除每材质全屏 Material Expand。纹理先使用有界 bank/resident handle；streaming 不阻塞 v1。

### R4-C · Compute SW/Hybrid Profile Optimization

实施包：[06-hybrid-visibility](./implementation/06-hybrid-visibility.md)

从 Scthe/The Forge/MOC 等参考移植并验证微三角形 Software Raster、SW/HW classification、统一 merge 和 fallback。只有目标 workload 证明收益时才默认启用。

退出：HW-only 是完整正确基线；Material Resolve 成本不再近似材质数 × 全屏；Hybrid 在目标场景有收益且普通场景不明显退化。

## R5 · Lighting、Shadow、Temporal 与扩展效果

实施包：[08-lighting-temporal-post](./implementation/08-lighting-temporal-post.md)

- 扩展 Clustered Lighting 到大量动态灯光，并冻结 list capacity/overflow。
- 保留 CSM，优化多 Cascade work generation、稳定性和过滤质量。
- IBL 与已有可迁移 GI 先形成基础间接光，不以高级 GI 阻塞阶段。
- Transparency/Decal 接入统一 Depth/Surface/Lighting。
- Velocity、Temporal Reconstruction、Dynamic Resolution、Upscaling 和 Post。
- Texture resident bytes/mip feedback；由显存证据决定是否增加 mip streaming。

退出：目标 workload 的画质、GPU 时间、内存和 feature-off 成本透明；Temporal/Upscaling 在相同输出画质下有可解释收益。

## Deferred

- 完整 World Partition 和开放世界 streaming。
- camera-relative/双精度超大世界坐标。
- Virtual Geometry、Virtual Shadow Map、Virtual Texture 全套系统。
- 地形、植被、角色、粒子、云、海洋和大气专用 Renderer。
- ReSTIR/Lumen-like GI、完整 Gameplay/ECS/Editor。

这些内容保留研究资料和未来接入 seam，但不是当前阶段完成 Gate。
