# 当前实现事实

本文描述当前 `OEngine/src`，不代表长期接受。

## 已存在并接入

- WebGPU Device/Canvas 初始化和资源缓存。
- CPU Scene/Node/Mesh/Light/Animation 基础对象。
- Scene Change Set 与部分 transform/bounds 增量同步。
- GPU Scene、Geometry/Material/Texture 数据库和 allocator。
- Meshlet 数据、实例/Meshlet 剔除、Prefix Scan、Indirect Draw。
- Hardware Visibility Buffer、reverse-Z、previous HZB 和 same-frame second chance。
- Material Expand、Clustered Lighting、IBL、Shadow、SSAO、SSR、OIT、TAA、Bloom、Exposure、Tonemap 等代码路径。
- R0 Result Schema v3、CPU/submit/readback/upload 观测、可选 GPU timestamp、256-byte GPU counter ABI、至少三槽异步 readback ring、diagnostics、percentile 汇总和统一 `BenchmarkRunController` 已接入；根目录已有 observability、真实主帧 smoke 与 A/B/C 三个统一主管线页面。Schema v3 额外冻结 feature-to-counter 能力证据矩阵：真实 producer 标为 `supported`，未实现/未接线项必须保存 `unsupported + blockerTaskId + reason`。
- 最终 Visibility Buffer 已有首个真实 GPU counter producer：采样帧通过 8×8 工作组归约统计非空/空 mesh-id 像素，异步归档 `shadedPixels` 与 `emptyVisibilityPixels`；两者之和必须等于内部渲染像素数。非采样帧不添加该 Pass，也不编码 counter clear/copy/readback。
- LightCluster 的 frustum-visible 与 HZB-filtered 两级 64 KiB list 均已接入 overflow 检查；filtered list 另外产生 `activeLights`，表示实际可容纳并送入 cluster assign 的 Point/Spot light 数量，DirectionalLight 不计入。任一级 raw count 超过 16,383 时设置 `queueOverflowMask` bit 3。
- Visibility 采样帧会从真实 count-prefixed GPU list 累加 `candidateInstances`、`visibleInstances`、scene-filter `rejectedFrustum`、cluster/HW 工作量，并在 scene-mesh/meshlet raw count 超过实际 Buffer capacity 时设置 `queueOverflowMask`。无 overflow 时 `candidateInstances = visibleInstances + rejectedFrustum`；当前 HW/alpha 每个 Meshlet 固定提交 384 vertices，所以 `hwTriangles = (hwClusters + alphaClusters) × 128`。
- Visibility 的 initial、dual 与 second-chance HZB Compute Shader 在采样 variant 中直接累加 `rejectedHzb`；只统计真实 depth-query reject event，不包含 frustum/offscreen reject。非采样 variant 没有 counter bind group 或额外 atomic。能力矩阵把 `hzb-culling` 与 `hardware-visibility` 独立登记；当前没有独立 cone culling，`cone-culling/rejectedCone` 明确由 `WORK-04` 阻塞。
- Material Expand 采样帧已接入 `activeMaterials`，表示实际编码了全屏 Material Expand draw 的已构建非透明去重材质数；它不是最终可见材质数，每增加 1 对应当前旧路径多一次全屏 GBuffer 扫描。
- Shader source-of-truth 审计已覆盖 66 个文件，并生成确定性的逐文件 artifact：55 个 `authored-live`、5 个静态无 pipeline owner 的删除候选、6 个仍在运行但 generator/所有权未闭环的 oracle/generated 文件。详见 `SHADER-SOURCES.md`。
- HZB legacy 观测会分别记录同帧 build 数、最终 mip 数与累计 mip pass 数。
- R0 已有单一 `render_debug_view` 控制面。`visibility-key`、reverse-Z `depth` 和 `velocity` 是真实全屏视图，统一在时域/后处理之后覆盖最终 HDR 输入；其余已规划视图会返回 `unsupported` 及原因。关闭和 unsupported 状态不添加 Debug Pass、瞬态纹理或 readback，旧 velocity 独立开关和 Pass 已删除。
- GPU timestamp 同时保存原始 Pass label 与稳定逻辑 phase；benchmark 会先对同一帧内同 phase 的 Pass 求和，再生成 `gpuPhaseMs` 分位数。采样登记一帧内所有 OEngine `ShadeGPUCommandContext`，以 context label 限定原始 Pass label，并按注册顺序合并异步结果；这覆盖 `GraphicsContext.update`、scene database update 与 animation context 内实际存在的 compute/render Pass。纯 copy/write 和跨 submit wall-clock 不属于 WebGPU Pass timestamp 覆盖范围，继续由 CPU timeline、字节与 submit 归属说明，不是 R0 未完成项。无法证明 owner 的 label 保留为 `unclassified`，R0 观测开销单列为 `observability`。
- Result 已有机器 gate validator，能拒绝旧 Schema、dirty commit、非 A/B/C role、占位 hash、伪造/缺失能力声明、required counter 缺失、unsupported counter 冒充零值、缺失 diagnostics、pending/dropped/failed GPU evidence、未归类 timestamp 和不匹配的 GPU/phase/counter summary。报告把 `gateEligible`（artifact 结构可信）与 `capabilityComplete/blockedCapabilities`（启用能力是否完整）分开。timestamp batch 的异步 map 失败会收尾该帧并累计 `failedGpuTimestampBatches`，不会把 benchmark 永久留在 pending。`temp/` 中 RTX 2060 SUPER 的两份旧 Schema 1 smoke 已登记为 exploratory：它们暴露了 81 Box 主链 3 submit 与持续 readback，但不是 A/B/C 基线。

## 关键缺口

- 没有主链 GPU Geometry Hierarchy/SSE LOD。
- 没有 Compute Software Raster 或软硬件统一 VisibilityKey。
- 没有正式离线 Asset Cooker 和版本化 Runtime Asset ABI。
- 没有 Packed Instance Set 的完整公开 seam。
- Material Expand 仍按材质全屏绘制。
- HZB、submit、readback 和中间队列存在明显固定成本。
- FrameGraph 尚未覆盖全部资源依赖和旁路系统。
- 资源销毁、device lost、history 失效与动态资产生命周期未闭环。
- 自动化测试已覆盖 R0 观测公共 seam，并重新计算 A/B/C 的 workspace 资产与相机 SHA-256。三份固定 manifest、7 级 Teapot GLB、Damaged Helmet/PBR 输入、C 配方、共享 runner 和三个根目录浏览器入口已完成，全部调用公开 OEngine interface、同一 `Renderer.render()`、`BenchmarkRunController` 和 Schema v3 writer。`?profile=smoke` 会强制 dirty/non-gate，不能冒充完整场景 artifact。
- R0 只剩 `OBS-02` 的一次浏览器实机验收和 `OBS-08`：前者只复测两个既有 smoke 与 A/B/C smoke 页面、控制台、截图和 JSON 导出，不再包含任何代码/文档扩展；后者采集当前实现的 clean Schema v3 cold/warm bundle。Schema v3 已消除歧义：required/supported 字段缺失是错误，真实零必须显式为 `0`，unsupported 必须携带 blocker 且不得出现在 sampled values。
- 当前主链没有 Packed Instances、Hierarchy/SSE LOD、独立 cone culling 或 SW raster；相关 counter/debug view 明确 unsupported 并归后续 `WORLD-07`、`WORK-04`、`VIS-05`。material overflow bit 2、更多逐像素 debug producer、纯 copy/write/跨 submit GPU timestamp 都不是 R0 blocker。
- 用户已完成旧 Schema smoke 数据采集；旧 artifact 仍为 exploratory。Schema v3 的两个 smoke 与现有 A/B/C 页面仍需浏览器实机复测；当前自动浏览器连接未发现可用实例，因此 G0 尚未通过，不能把 build/HTTP 200 冒充渲染验收。
- package 和大量内部符号仍保留 reconstructed/Shade 历史名称。

## 参考代码状态

- `three.js/` 是 gitlink 形式的本地上游参考；根仓库当前没有 `.gitmodules`。
- `three.js/examples/webgpu_compute_rasterizer.html` 有本地注释修改，属于用户现有改动。
- `webgpufundamentals/` 是学习资料。
