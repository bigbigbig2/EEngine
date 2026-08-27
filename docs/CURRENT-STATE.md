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

- R2-A/B 设备无关数据基础已完成；R2-C core 也已落地：validated Geometry package 可进入惰性 `GpuAssetStore`，并重排为显式对齐的 Geometry 144 B、Cluster 128 B、Meshlet 112 B GPU records 与连续 payload buffers。
- R2-C 已有 opaque generation handle、0 号 fallback、bulk upload、grow/copy/abort/completion-safe retirement、release/stale-handle 语义，以及 logical/resident/allocated/peak/retiring/reclaimable 和 upload/grow/reject counters。`GraphicsContext.assets` 惰性创建，legacy-only 页面不承担额外 store Buffer。
- `examples/r2-gpu-residency` 已形成 package → resident tables → Compute 写 indirect args → Hardware `drawIndirect()` 的 flat 黄金资产闭环。2026-08-27 人工浏览器证据为 `passed=true`、GPU roundtrip `6/6` 一致、211,600 个非背景像素、`validationError=null`、无 uncaptured error/shader diagnostic、abort/release handle 均失效且 `privateSubmitCount=0`；R2-C 已关闭。
- R2-D compact Instance 基础已落地：`InstanceRecord` v2 保持 192 B，包含 Geometry record index、material handle、flags/debug ID、object bounds、current object-to-world 与 CPU 预计算 `previous_from_current`；奇异变换设置 `MotionInvalid`，Packed Velocity 输出零。TS packer、offset 和 WGSL struct 共用同一冻结 schema。
- 惰性 `GpuScene` 是新 Instance table 唯一 owner，提供 opaque generation `InstanceSetHandle`、1k/10k/100k bulk、grow/abort/release、显式 transform/material patch、同帧 previous 保持、dirty span 合并和 logical/resident/allocated/CPU shadow/upload/patch/grow 证据；稳定空 batch 不编码 copy/pass/submit，`privateSubmitCount=0`。
- `createInstanceSourceFromScene()` 已让普通 `Scene/Mesh` 一次性写入同一个 `InstanceSource`，Packed source 只使用 typed arrays + 少量 geometry handle，不构造等量 JS 对象。`Renderer` 已公开 instantiate/patch/release/evidence seam，GPU Buffer/range 保持内部。
- `examples/r2-packed-scene` 已形成 Geometry package + Instance table → Compute compact active indices/完整 indirect args → Hardware `drawIndirect()` 的真实双 binding consumer。G2 关闭时 v1 浏览器证据为 `passed=true`、1k/10k/100k bulk、四档 patch、41,733 非背景像素且 diagnostics 为空；页面现已随 v2 改为验证 `previous_from_current`，本轮完成 production build 和 Node reference，尚未重采浏览器 artifact。
- R2-D/G2 已关闭：`load_gltf_packed()` 直接输出 SourceGeometry、材质 dictionary、transform/bounds/flags typed arrays；A/B 的 Teapot/Damaged Helmet 和 C 的三份程序化几何均经过 Cooker/package，由 `Renderer.uploadPackedScene()` 进入生产 Packed Visibility、Material Expand 与 Velocity。
- R2 provenance 清算已补齐 Packed glTF 的 Khronos 规范台账与 multi-primitive/material/nested-transform fixture；Packed Material 的 glTF 8/16 位 normalized 与 OEngine 32 位扩展 CPU/WGSL 边界也已冻结。flat Visibility 与每材质 fullscreen 仍分别由 R3/R4-B 替换。
- Packed Visibility 执行 Instance frustum cull → flat Meshlet compact → GPU 写完整 16 B indirect record → Hardware `drawIndirect()`；共享 Geometry 的 capacity 按实例精确累加，storage/u32 limit 在 owner 变更前拒绝。Material 每 semantic 只扫描一次 descriptor，使用解析 perspective UV gradient 并修正重复 viewport、镜像/非均匀 normal-tangent；Velocity 已删除每可见像素 `mat4_inverse`。稳定帧不重复 residency/instantiate，也不由 CPU readback 决定 draw。
- package 主路径不创建等量 `Mesh/Node3D`，也不创建 legacy `MeshletGpuTable`；旧 Geometry owner 改为 legacy Scene consumer 请求时惰性创建。普通对象、旧 Loader、shadow/transparent 等尚未迁移 consumer 仍保留旧路径，后续按 R3/R4/R5 迁移删除，不能解释为 Packed 主路径双 owner。
- 没有 GPU Cluster hierarchy traversal 或 SSE LOD；现有路径仍先展开大量 flat Meshlet 工作。R2 BVH8 已正确生成/驻留，但它独立索引所有 LOD Cluster、没有 parent/descendant 互斥 cut 语义，按 ADR-0009 不进入 R3 v1 热路径。
- 当前 `MeshletDrawList` 有多阶段 bucket/scan/expand 固定成本，固定 384 vertices/meshlet 的无效提交尚未量化。
- 没有正式冻结的 frame-local VisibilityKey/VisibleCluster lookup 契约。
- 当前没有 Compute Software Raster；Hardware 是唯一真实 triangle raster path。
- Material Expand 仍按活跃材质执行全屏三角形，成本可能接近 `materials × pixels`。
- R2-C/D 的 owner、flat work、属性重建和 motion 数学已有独立 porting ledger；本轮只证明 reference/property/source audit 与构建正确，Material/Velocity 的 GPU 时间收益仍需同条件浏览器 artifact，不能由结构优化直接推断。
- Lighting/CSM/Transparency/Temporal/Post 虽有代码路径，尚未基于新的 Visibility/Surface ABI 逐项重新验收。
- Geometry 与 Instance residency 的 record/payload/upload/grow/patch 内存证据已接入；texture、全帧 transient 与统一显存/上传预算仍未完成。
- Shader oracle/generated owner 尚未完全收口，部分 reconstructed/Shade 历史命名仍存在。

## 当前下一步

1. R2/G2 已完成。当前唯一代码任务是 R3：先完成 multi-instance CPU oracle、queue ABI/max-cut capacity，再读取 R2 已驻留的 Instance/Geometry/Cluster hierarchy 数据执行 GPU root→children/SSE/cull/compact，并直接喂给现有 Hardware consumer。当前 BVH8 暂不参与首版运行 traversal。
2. R3 关闭后依次推进 R4-A Visibility contract、R4-B single Material Resolve、R4-C 可选 SW/Hybrid；Packed alpha-tested Visibility、Packed shadow consumer 与画质管线按各自 Gate 验收，不倒灌回 R2。

## 本地参考状态

- `three.js/` 是本地上游参考，不是 OEngine runtime dependency。
- 根工作树的 `three.js` gitlink 修改属于用户现有状态；普通 OEngine 任务不得覆盖。
- `webgpufundamentals/` 是学习资料，不是架构权威。
