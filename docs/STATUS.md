# OEngine 当前状态

更新时间：2026-09-08。本文件是唯一可变状态页；完成过程从 Git 查询。

## Performance Inspector 状态

`docs/PERFORMANCE-INSPECTOR.md` 的 Task 1–5 已完成核心数据层实现，Inspector v2 已收敛为实时 Profiler + 内存 Timeline，当前提交包含：

- Task 1：typed `MetricDescriptor`/`MetricSample`、注册表、默认指标目录、nearest-rank 统计和 coverage 统计。
- Task 2：immutable `ProfileFrame`/`ProfileSpan`、有界 `ProfileHistory`、按 `frameIndex` 的异步 patch 和状态校验。
- Task 3：`FrameProfiler` 已收敛注册指标、CPU/GPU span、Live/Record/Deep Capture cadence、epoch/warm-up、GPU timestamp/counter 异步回填和状态化 sample；未知 metric ID 会直接拒绝。
- Task 4：资源账本已接入 GPU Asset、Scene、Packed Scene、Texture Residency、transient Buffer/Texture pool、temporal history、shadow/LPV atlas、upload staging 和 profiler readback 的创建/销毁边界，并按 resident/transient/history/atlas/upload/readback/profiler 分类；Pipeline 已记录 cache、host-call 和 first-use，FrameGraph 已记录 active/pruned 与逻辑瞬态峰值。
- Task 5：Capture v1 已提供 canonical schema、golden fixture、严格导入校验、未知字段规范化、递归深冻结、稳定序列化和导入后统计一致性；Trace 保持 CPU/GPU 独立时钟域，duration-only GPU 数据不伪造 slice 起点，并支持带独立 golden 验证的流式/分块序列化。

Task 3–5 的核心数据契约已收尾；Task 6 的 Inspector addon shell、view-model 和 package subpath 已实现；Task 7 的 Performance/Timeline 图表、预算分类、范围统计和双时钟轨道已实现；Task 8 的 Work、FrameGraph、Memory、Diagnostics 领域面板已实现；Task 9 已将 Rendering Lab 接入共享 Inspector 并移除旧统计面板。Phase 1–4 的实时 Inspector 基线已完成：右上角整数 FPS toggle、底部 dock、Monitor/Record/High detail、Follow latest、Pin frame、独立有界 Timeline 录制窗口和 Playwright story smoke。Inspector 公共路径不再暴露 Capture/Trace 编解码器；内部 codec 仅供 benchmark/test 使用。真实 adapter 上的固定 workload/1080p 性能证据仍待采集，当前不能宣称性能目标已经达标。

资源数值统一表示 OEngine owner 在实际创建/销毁边界登记的 accounted/estimated bytes，不是物理 VRAM、驱动分配或硬件利用率；history/atlas 与 resident/transient 分账，禁止重复计数。

验证：`npm run build`、`npm run build:test`、`npm run audit:shaders` 通过；Inspector 命中测试和 Storybook typecheck 通过；当前全量测试 439/439 通过。

## 已验证基础

- WebGPU Renderer、FrameGraph、FramePlan、Feature/Service 组合和公开入口已经存在。
- GPU-ready geometry package、`GpuAssetStore`、`GpuScene` 与 Packed registry 已形成资源边界。
- Packed hierarchy/work generation、Hardware Visibility、直接 VisibilityKey、分类 Material Resolve 和 Surface 产品已有生产 owner。
- direct lighting、CSM、GI、AO、SSR、MBOIT、Temporal 与 HDR post 已接入同一 Renderer 主流程。
- Rendering Lab 是工作树唯一保留的浏览器 fixture。

这些结构事实不等于 1080p/60 FPS、完整画质、内存上限或 feature-off Gate 已通过。

## Visibility→Surface RFC 状态（2026-09-08）

- M0–M4：生产路径已迁移到 MaterialClassDepth + fullscreen Surface Resolve；旧 Pixel Queue/ ShadeWork 生产链已移除。初始化会执行 7 类 `depth32float/equal` GPU probe，失败时在创建 Surface owner 前切换到 `class-discard`，选择来源与原因进入 migration evidence。正式多 run correctness/performance Gate 仍未宣称通过。
- M5：32 B ExactRaster + 有界 40 B TriangleSetup sidecar、逐像素 fallback 和 sampled evidence counters 已实现。candidate cache 默认关闭；关闭时没有 setup allocation、FrameGraph resource 或 clear。已修复 feature-off dummy binding 的 WebGPU storage alias、最小绑定大小和 indirect/storage usage 冲突；`triangle-setup-candidate-cache` 已加入 benchmark capability contract。clean formal `heavy-overdraw-large-occluder` 三次 run 的 visible hit ratio 均为 1.0，fallback/overflow/diagnostics 均为 0，work-cache peak 为 5,788,240 B，因此达到 candidate default 的 hit-ratio 子门槛；RFC 要求的 off/on correctness、near-plane、GPU P50/P95 和 memory Gate 仍未关闭，生产默认继续 off。
- M6：Surface ABI v1 保持不变。已冻结 benchmark-only `rgba8uint` normal candidate（velocity-on 预计 22 B/pixel）及 CPU oracle，并完成 Packed Resolve、Lighting、AO、SSR、GI/IBL/LPV/Brick4、Opaque Resolve 与 Render Debug 的原子 profile seam；candidate 只允许 Packed Scene，legacy MaterialExpand 会明确拒绝。`VisibilitySurfaceMigrationGates` 支持带唯一 run/session 身份的三次 parity、attachment bytes、conversion pass 和 resident/transient peak 联合判定。Rendering Lab report 会从 runtime evidence 记录真实 active ABI/profile。当前没有正式候选证据，因此生产默认仍为 v1。
- M7：Tile backend 尚未创建。identity-bearing gate 现在要求至少两个 vendor、每 vendor 足够的独立 session/run，并且 ClassDepth 相对已验证 tile prototype/model 的 P50 或 P95 差距达到 10% 才允许进入实现；`TileBackendCostModel.ts` 已提供 evidence-only 的 16/32/64 tile mask/overflow/work model，Rendering Lab 可显式采样它，但不替代真实跨 vendor timing。当前证据不足，保持 `insufficient-evidence`，不把缺失实现误写成完成。报告输出 `migrationGates.tileBackend`。

本阶段已运行 `OEngine/npm test`（439/439）、Shader audit（70/70）、`examples/npm run build`、VisibilityKey GPU oracle（6213/6213），并在 NVIDIA/Turing Chrome WebGPU 上验证 Rendering Lab workload smoke 的自动 probe、显式 `class-depth` 与显式 `class-discard` 路径。另已在 clean commits `e2e9328`/`8acd6ac` 上完成 `cube-near-effects-off` off 基线和 `heavy-overdraw-large-occluder` TriangleSetup on 三次正式 profile，provenance、browser errors、validation/uncaptured/deviceLost 均为 0；M5 的 correctness/performance/memory 组合 Gate、M2–M7 其余正式证据矩阵仍未完成。

## 当前生产 Owner

- 总装：`Renderer.ts` 与 `render/features/*`。
- GPU 资产/场景：`GpuAssetStore`、`GpuScene`、`GpuPackedSceneRegistry`。
- 工作/可见性：`GpuWorkGenerationAbi`、Packed visibility owners。
- Surface 与效果：`FrameProducts`、Surface/Lighting Feature，AO/Reflection/GI Service，Transparency/Temporal/Post Feature。
- 证据：`FrameProfiler`、GPU counters、shader source audit 和 Rendering Lab diagnostics。

## Legacy 与迁移债务

- `Renderer.ts` 仍有 3853 行，是大型 composition root。
- `packedResolveOut ?? obtainLegacyMaterialExpand()` 证明材质解析仍有双路径。
- `MaterialExpandPass`、`VelocityPass`、`TransparentOitPass` 仍有实际 legacy consumer。
- Packed 与普通 Scene 的 Surface metadata、velocity、transparency 生命周期尚未统一。

## 正确性与画质风险

- 需要在多资产、多材质、alpha、动态灯光和 camera cut 下验证 key、history 与 fallback。
- AO、SSR、GI 和 transparency 的组合必须保持独立语义，不能互相覆盖基线光照。
- device loss、resize、feature toggle 和提交失败后的 history/resource invalidation 仍需浏览器证据。

## 性能与内存风险

- 1920×1080、DPR 1、完整目标画质下 16.667 ms GPU 尚未证明。
- legacy fullscreen material/velocity 路径可能保留与可见像素无关的固定成本。
- resident、transient、history、shadow、upload/readback 预算需要在真实 adapter 上采集。
- one-main-submit 和 feature-off 接近零成本需要按帧证据，而非静态结构判断。

## 来源与发布风险

Shader audit 当前记录 70 个 Shader：66 个 `authored-live`、4 个 `unknown`。风险项为 `material_depth_oracle.ts`、`material_expand_oracle.ts`、`oracle_visibility_work_generation.ts` 和 `probe_legacy.generated.ts`；它们仍有 runtime consumer，不能当作死文件删除，也不能把 generator/oracle 当设计权威。

## 下一步

1. 在 clean commit 上按执行文档分别运行 `class-depth` / `class-discard` 与 TriangleSetup off/on 的三次正式 profile；历史 legacy 基线从 clean `68750c2` 采集，不在当前源码恢复旧 backend。
2. 已完成 `heavy-overdraw-large-occluder` 的 M5 opt-in 三次 run；下一步补齐同一 adapter 的 `near-plane-motion` 三次 run，并将 off/on 的 attachment parity、GPU P50/P95、P99、fallback 和 memory peak 汇总后再决定是否把 cache 改为默认。
3. 运行 v1/v2-candidate 完整 composition A/B，并补齐两个 GPU vendor 的 M7 timing evidence；Gate 不触发则继续不创建 tile runtime。
4. 继续补齐逐帧 FrameGraph/resource evidence，并记录 device loss、resize、feature toggle 后的浏览器证据。
5. 移除普通 Scene 的 Material Expand 与独立 Velocity 最终 consumer。
6. 统一 Packed/legacy transparency 的产品和生命周期边界后删除旧 OIT。
7. 为四个 unknown Shader 确认 authored owner 或可追溯生成源。
