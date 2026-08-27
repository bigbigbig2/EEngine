# OEngine 当前实现事实

本文只描述当前 `OEngine/src` 和尚未关闭的执行状态。历史基线和 artifact 等级见 [BASELINE-ARTIFACTS](./BASELINE-ARTIFACTS.md)，执行流水见 [implementation](./implementation/README.md)。当前存在不代表长期接受。

## 已接入主帧

- WebGPU Device/Canvas、资源缓存、统一 FrameCoordinator 和一个 steady main submit。
- Compiled FrameGraph topology cache、feature pruning、late-bound frame resources。
- CPU Scene/Node/Mesh/Light/Animation 基础对象，以及部分 scene/database 增量同步。
- GPU Scene、Geometry/Material/Texture 数据库和 allocator。
- flat Meshlet 数据、instance/Meshlet cull、bucket/scan/expand、HZB、GPU indirect args。
- Hardware Visibility Buffer、reverse-Z、alpha-tested 路径和 same-frame second chance。
- Compute HZB：`rg16float` min/max pyramid、per-view previous/current ping-pong 和显式 commit/abort。
- 当前 Hardware consumer 是 GPU list count → `vertexCount=384`/`instanceCount=count` → single `drawIndirect`；CPU 不读取 count 决定该 draw。
- Material Expand、Clustered Lighting、IBL、CSM、SSAO、SSR、OIT、TAA、Bloom、Exposure、Tonemap 等旧效果路径。
- 一条主管线和单一 `render_debug_view`；关闭/unsupported debug view 不添加额外工作。

## 可观测性

- R0 Result Schema v3、CPU/submit/readback/upload、可选 GPU timestamp、256-byte GPU counter ABI 和异步 readback ring 已接入。
- feature-to-counter 矩阵区分真实 `0`、required/supported 缺失和 `unsupported + blockerTaskId`。
- 已有真实 producer 覆盖 Visibility 像素、instance/frustum/cluster/HW work、HZB reject、active material/light 和 queue overflow。
- A/B/C 与 Frame Smoke 根目录 examples 共用公开 OEngine interface、`Renderer.render()` 和 benchmark writer。
- R0/G0 已完成，不再接受把后续算法或额外观测工作倒灌为 G0 blocker。

## R1 当前状态

- R1/G1 已于 2026-08-27 关闭；最终 clean 浏览器证据基于 commit `7934db1`。
- `R1-A`：Frame Smoke/A/B/C steady 主帧只有一个 `Renderer/main-0` submit，非采样 readback 为零，每 scene/frame 只 prepare 一次。
- `R1-B`：相同 graph key 的 warm frame `build=0/compile=0/execute=1/cacheHit=1`；可选 feature 不创建 owner、Pass 或 history，关闭后安全退休。
- `R1-C`：旧逐 mip HZB Render Pass 已删除；每 build 一个 Compute Pass、每 mip 一个 dispatch；history owner 明确 previous/current/final。独立真实 GPU prototype 为 `computePasses=1`、`dispatches=3`、`maxError=0`。
- `R1-D`：View 从 lookup 立即移除，持久 owner/history 在 GPU completion 后销毁；FrameGraph 保留 command 内 last-use alias 和同 queue ordered reuse，mapping/readback、显式 fenced 资源与 destroy 才等待 completion。
- 最终 A/B/Frame Smoke 的 HZB 总量均为 `2 builds / 2 Compute Passes / 20 dispatches`；C 为 `12/12/120`，其中主视图 3 次、实际更新的阴影视图 9 次，counter 与 timestamp 标签逐帧一致。
- clean/full after bundle 证明结构 Gate，但 R1 修改前没有同条件 clean/full bundle，因此不伪造 CPU/GPU 性能提升百分比；绝对 after 数据登记在 `PERFORMANCE.md`。

## 关键缺口

- 没有正式离线 Geometry Cooker 和版本化 Runtime Asset Package。
- 没有面向当前目标的 compact GPU table ABI 与完整 Packed Instance Set。
- 没有 GPU Geometry Hierarchy、BVH8 traversal 或 SSE LOD；现有路径仍先展开大量 flat Meshlet 工作。
- 当前 `MeshletDrawList` 有多阶段 bucket/scan/expand 固定成本，固定 384 vertices/meshlet 的无效提交尚未量化。
- 没有正式冻结的 frame-local VisibilityKey/VisibleCluster lookup 契约。
- 当前没有 Compute Software Raster；Hardware 是唯一真实 triangle raster path。
- Material Expand 仍按活跃材质执行全屏三角形，成本可能接近 `materials × pixels`。
- Lighting/CSM/Transparency/Temporal/Post 虽有代码路径，尚未基于新的 Visibility/Surface ABI 逐项重新验收。
- resident/transient memory、geometry/texture/table bytes 和每帧 upload 仍没有完整预算证据。
- Shader oracle/generated owner 尚未完全收口，部分 reconstructed/Shade 历史命名仍存在。

## 当前下一步

1. R2 已冻结为 `R2-A Package Kernel → R2-B Cooked Geometry → R2-C Residency + Compact Tables → R2-D Packed Scene Vertical`；当前从 R2-A 开始，不并行重写 Material/Texture/Light。
2. R3 将 hierarchy 输出接入现有 single indirect Hardware consumer。
3. R4-A 冻结 Hardware Visibility contract，R4-B 提前 Single Material Resolve，R4-C 再决定 SW/Hybrid 收益。

## 本地参考状态

- `three.js/` 是本地上游参考，不是 OEngine runtime dependency。
- 根工作树的 `three.js` gitlink 修改属于用户现有状态；普通 OEngine 任务不得覆盖。
- `webgpufundamentals/` 是学习资料，不是架构权威。
