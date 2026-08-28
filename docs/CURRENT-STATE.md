# OEngine 当前实现事实

本文只描述当前 `OEngine/src` 和尚未关闭的执行状态。历史基线和 artifact 等级见 [BASELINE-ARTIFACTS](./BASELINE-ARTIFACTS.md)，执行流水见 [implementation](./implementation/README.md)。当前存在不代表长期接受。

## 已接入主帧

- WebGPU Device/Canvas、资源缓存、统一 FrameCoordinator 和一个 steady main submit。
- Compiled FrameGraph topology cache、feature pruning、late-bound frame resources。
- CPU Scene/Node/Mesh/Light/Animation 基础对象，以及部分 scene/database 增量同步。
- GPU Scene、Geometry/Material/Texture 数据库和 allocator。
- Packed Cluster hierarchy/SSE/Cone/previous-HZB work generation、VisibleCluster/RasterWork、GPU indirect args 与 Hardware consumer；Packed flat 链已删除，legacy Scene 仍有独立 Meshlet/bucket/scan/expand consumer。
- Hardware Visibility Buffer、reverse-Z、alpha-tested 路径和 same-frame second chance。
- Compute HZB：`rg16float` min/max pyramid、per-view previous/current ping-pong 和显式 commit/abort。
- 当前 Hardware consumer 是 GPU list count → `vertexCount=384`/`instanceCount=count` → single `drawIndirect`；CPU 不读取 count 决定该 draw。
- Material Expand、Clustered Lighting、IBL、CSM、SSAO、SSR、OIT、TAA、Bloom、Exposure、Tonemap 等旧效果路径。
- 一条主管线和单一 `render_debug_view`；关闭/unsupported debug view 不添加额外工作。

## 可观测性

- R0 Result Schema v3、CPU/submit/readback/upload、可选 GPU timestamp、256-byte GPU counter ABI 和异步 readback ring 已接入。
- feature-to-counter 矩阵区分真实 `0`、required/supported 缺失和 `unsupported + blockerTaskId`。
- 已有真实 producer 覆盖 Visibility 像素、instance/frustum、visited hierarchy node、selected Cluster、Cone/HZB reject、HW RasterWork、active material/light 和 queue overflow。
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
- R2 provenance 清算已补齐 Packed glTF 的 Khronos 规范台账与 multi-primitive/material/nested-transform fixture；Packed Material 的 glTF 8/16 位 normalized 与 OEngine 32 位扩展 CPU/WGSL 边界也已冻结。Packed flat Visibility 已由 R3-D 删除；每材质 fullscreen 仍由 R4-B 替换。
- 生产 Packed Visibility 现执行 InstanceCull → Cluster hierarchy/Frustum/SSE/Cone/previous-HZB → VisibleCluster → RasterWork → GPU 写完整 16 B indirect record → Hardware `drawIndirect()`，数量不经 CPU readback。Material 每 semantic 只扫描一次 descriptor，使用解析 perspective UV gradient 并修正重复 viewport、镜像/非均匀 normal-tangent；Velocity 已删除每可见像素 `mat4_inverse`。稳定帧不重复 residency/instantiate。
- package 主路径不创建等量 `Mesh/Node3D`，也不创建 legacy `MeshletGpuTable`；旧 Geometry owner 改为 legacy Scene consumer 请求时惰性创建。普通对象、旧 Loader、shadow/transparent 等尚未迁移 consumer 仍保留旧路径，后续按 R3/R4/R5 迁移删除，不能解释为 Packed 主路径双 owner。
- R3-A 已完成 CPU/ABI 冻结：multi-instance world-space selector 覆盖完整 Instance transform、透视/正交、Frustum、near-plane、parent/child 与容量 fallback；Work ABI 为 Traversal 8 B、VisibleCluster 16 B、Raster 8 B、Queue header 32 B，并冻结完整 12 B dispatch/16 B draw indirect records。`maxCutMeshlets` 已与固定随机树全部合法 cut 穷举对照。
- R3-B 的历史 GPU selected-set producer已由 R3-D 收口为 fused InstanceCull + root Cluster → 可选 ping/pong traversal → VisibleCluster；旧 RootTraversalQueue 已删除。owner 管理 traversal/selected/raster/dispatch、sampled evidence 与 view 资源，不创建私有 submit。R2 BVH8 仍因缺少 parent/descendant cut 语义而不进入 R3 v1 热路径。
- `examples/r3-hierarchical-work-generation` 的 live WebGPU 结果为 `passed=true`：Perspective 68、Orthographic 16、empty 0、capacity parent fallback 3 个 selected Cluster，GPU/CPU set 全部一致；pressure 首轮真实计数为 `attempted=6/written=0/overflow=1/fallback=3/capacity=1`，Shader/validation/uncaptured/console errors 均为空。
- R3-C 已完成 GPU producer → GPU Hardware consumer 垂直闭环：VisibleCluster 展开为 RasterWork，GPU 写满 `[384, written, 0, 0]` 的 16 B record，生产 `PackedVisibilityPass` 直接消费；线性 workgroup 超过 65,535 时映射为二维 indirect dispatch。`NoHierarchy` tiny Geometry 以 runtime-only virtual leaf Cluster 归一化到同一 ABI，不改 R2 Package。
- R3-C clean/full flat/hierarchy paired A/B/C 基于 clean commit `0b77ce8`：A 减少 90.1% RasterWork 但 Visibility P50 回退 14.1%；B 减少 80.4% 且 P50 改善 69.6%；C 工作量相同但 hierarchy 多约 0.262 ms 固定成本。六组均无 overflow/WebGPU diagnostics，不能由此宣称 hierarchy 普遍更快。InstanceCull、round 0 和 expansion 是热点，但并非三个 `workgroup_size(1)` 阶段。
- R3-D 代码/功能结构已完成：expansion 改为每 selected Cluster 一个 64-lane workgroup且一次预约；Cone 使用 meshoptimizer 公式并对 mirrored/non-uniform/shear fail-open；previous HZB 使用上一帧 camera 与 Instance motion 变换做 Niagara reverse-Z 保守投影，MotionInvalid/无效 history fail-open；Work Queue ABI v2 输出真实 `visitedBvhNodes/rejectedCone/rejectedHzb`；Packed flat shader/mode/owner 全部删除。
- R3-D 自动证据已扩展为 OEngine `npm test` 162/162 与 examples build；live GPU/CPU oracle 页面为 `passed=true`，Perspective、Perspective + empty previous HZB、Orthographic、empty、capacity pressure、depth-zero fused-leaf 六组的 VisibleCluster、RasterWork 和完整 16 B indirect record 全部一致，Shader/validation/uncaptured diagnostics 为空。
- R3-D clean/full A/B/C after 已在 clean commit `1f3a2d7` 上由浏览器采集：NVIDIA Turing、Chrome 150、1280×720、DPR 1、60 warm-up + 180 sample。三组均 `dirty=false`、`gateEligible=true`、`counterIssues=0`、`queueOverflowMask=0`，WebGPU validation/uncaptured/device-lost/timestamp/counter diagnostics 全为 0；`capabilityComplete=false` 只来自诚实的 `VIS-05` Software Visibility blocker。
- commit `1f3a2d7` 的历史 after 曾证明 64-lane expansion 局部优化成立，但当时仍被 A P95 124.95 ms 和 C P95 0.495 ms 阻塞；真实 `rejectedCone=16`、`rejectedHzb=40` 也证明两条 reject 分支已在生产 Renderer 执行。该历史 blocker 已由下一条 `aff3ab8` 结果关闭，不能再解释为当前状态。
- `R3-D-08/09` 与 G3 performance 已关闭。clean commit `aff3ab8` 的 A/B/C full 全部 `dirty=false`、`gateEligible=true`、zero counter issue/overflow/WebGPU diagnostics；Visibility P50/P95/P99 分别为 A `16.777/17.511/18.234 ms`、B `11.534/11.665/11.758 ms`、C `0/0.066/0.066 ms`。A/B 运行 wavefront + fused-root，C 真实命中 fused-leaf；RasterWork 保持 `273,750 / ≈281,191 / 127`，没有以漏绘换性能。
- sampled contention counter 已保存 root/traversal reservation、dispatch update 与 CAS retry。A 的 CAS retry P50 仍为 18,428，但 Producer P50/P95 只有 `6.291/7.120 ms`，因此登记为更大 workload 的后续 profile 风险，不继续阻塞 G3。
- 当前 `MeshletDrawList` 有多阶段 bucket/scan/expand 固定成本，固定 384 vertices/meshlet 的无效提交尚未量化。
- `R4-A-01` 工作项已验收，治理状态为 `Implemented`：`GpuVisibilityKeyAbi.ts` 以共享 TS 常量生成 WGSL codec，冻结 frame-local `VisibilityKey v1 = rasterWorkSlot + localTriangle`、`0xFFFFFFFF` empty、完整 reserved slot、最大 RasterWork capacity、adapter buffer limit 与显式 producer failure；CPU reference 已通过 multi-Meshlet fixture 证明 `RasterWork → VisibleCluster/Meshlet` 唯一回查，未修改 R3 Package ABI。
- `R4-A-02` 已验收，治理状态为 `Integrated`：生产 Packed Hardware shader 在原有单次 `drawIndirect` 中写 `VisibilityKey v1 + reverse-Z depth`；Key 是 FrameGraph transient `r32uint` attachment，Packed feature-off 不创建资源，resize 进入 descriptor/graph signature，RasterWork capacity 在 producer 前按 key/adapter limit 显式拒绝。旧 triangle/instance MRT 暂供 Material/Velocity 使用，列为 R4-B 删除对象。
- sampled `VisibilityCounterPass` 已切换为 legacy/key 双 contract，新增 `invalidVisibilityKeys`，useful fragments 复用 `shadedPixels`；submitted fragments 因 WebGPU baseline 没有 pipeline-statistics producer，诚实登记为 `unsupported / R4-A-06`。`examples/r4-hardware-opaque-producer` 的 live Chrome 结果为 `passed=true`、`6820` valid、`69980` empty、invalid/unresolved/depth mismatch 全为 `0`、depth `0.025`，Shader/validation/uncaptured diagnostics 为空；Benchmark A production Renderer smoke 的 3 个 sampled frame 也全部导出 `invalidVisibilityKeys=0` 且 runtime diagnostics 为零，但 smoke 不作为 R4-A paired Gate artifact。
- `R4-A-03` 已验收，治理状态为 `Integrated`：64 B `MaterialVisibilityRecord v1` 与 4,096 material/256 alpha-tile 临时 owner 已接入 Packed Scene staging；Geometry GPU ABI 升为 v2/160 B 并加入 UV0/UV1 fast path，Package ABI 不变。生产 Hardware fragment 从 GPU record 完成 opaque/mask/blend、factor/texture、glTF UV transform、cutoff、double-sided/mirrored 与 invalid texture/sampler fallback，仍只使用原单次 `RasterWork → drawIndirect → VisibilityKey/depth`，没有 CPU 最终可见循环。Chrome 8-slot fixture 像素为 `2892/2177/0/0/2913/2849/2850/1440`，invalid key/depth mismatch 与 WGSL/validation/uncaptured/device-lost diagnostics 全为 `0`。
- ADR-0010 的 Hardware debug Resolve、完整 lifecycle/overflow 与 paired A/B/C Gate 尚未完成；因此 G4-A 仍未完成。R4-A 临时 Material Visibility owner 是 `R4-B-02` 接管/删除对象，不是第二套长期材质真相来源。
- 当前没有 Compute Software Raster；Hardware 是唯一真实 triangle raster path。
- Material Expand 仍按活跃材质执行全屏三角形，成本可能接近 `materials × pixels`。
- R2-C/D 的 owner、flat work、属性重建和 motion 数学已有独立 porting ledger；本轮只证明 reference/property/source audit 与构建正确，Material/Velocity 的 GPU 时间收益仍需同条件浏览器 artifact，不能由结构优化直接推断。
- Lighting/CSM/Transparency/Temporal/Post 虽有代码路径，尚未基于新的 Visibility/Surface ABI 逐项重新验收。
- Geometry 与 Instance residency 的 record/payload/upload/grow/patch 内存证据已接入；texture、全帧 transient 与统一显存/上传预算仍未完成。
- Shader oracle/generated owner 尚未完全收口，部分 reconstructed/Shade 历史命名仍存在。

## 当前下一步

1. 执行 `R4-A-04` Hardware debug Resolve：从 VisibilityKey 单次回查 RasterWork/VisibleCluster/Meshlet/Instance/Material，并保存 fail-visible heatmap 与真实 glTF alpha fixture。
2. 完成 `R4-A-05..06` 的 overflow/lifecycle 和 paired 浏览器 Gate 后，才能进入 R4-B single Material Resolve；R4-C SW/Hybrid 继续作为后续 profile optimization。
3. A/B 的 `COOK-11`、`VIS-05` 和 B 环境/画质输入仍是产品基线 blocker；G3 完成不等于 A/B capabilityComplete，也不等于引擎最终完成。

## 本地参考状态

- `three.js/` 是本地上游参考，不是 OEngine runtime dependency。
- 根工作树的 `three.js` gitlink 修改属于用户现有状态；普通 OEngine 任务不得覆盖。
- `webgpufundamentals/` 是学习资料，不是架构权威。
