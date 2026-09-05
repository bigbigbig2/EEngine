# OEngine 当前状态

更新时间：2026-09-05。本文件是唯一可变状态页；完成过程从 Git 查询。

## Performance Inspector 状态

`docs/PERFORMANCE-INSPECTOR.md` 的 Task 1–5 已完成核心数据层实现，当前提交包含：

- Task 1：typed `MetricDescriptor`/`MetricSample`、注册表、默认指标目录、nearest-rank 统计和 coverage 统计。
- Task 2：immutable `ProfileFrame`/`ProfileSpan`、有界 `ProfileHistory`、按 `frameIndex` 的异步 patch 和状态校验。
- Task 3：`FrameProfiler` 已收敛注册指标、CPU/GPU span、Live/Record/Deep Capture cadence、epoch/warm-up、GPU timestamp/counter 异步回填和状态化 sample；未知 metric ID 会直接拒绝。
- Task 4：资源账本已接入 GPU Asset、Scene、Packed Scene、Texture Residency、transient Buffer/Texture pool、temporal history、shadow/LPV atlas、upload staging 和 profiler readback 的创建/销毁边界，并按 resident/transient/history/atlas/upload/readback/profiler 分类；Pipeline 已记录 cache、host-call 和 first-use，FrameGraph 已记录 active/pruned 与逻辑瞬态峰值。
- Task 5：Capture v1 已提供 canonical schema、golden fixture、严格导入校验、未知字段规范化、递归深冻结、稳定序列化和导入后统计一致性；Trace 保持 CPU/GPU 独立时钟域，duration-only GPU 数据不伪造 slice 起点，并支持带独立 golden 验证的流式/分块序列化。

Task 3–5 的核心数据契约已收尾；Task 6 的 Inspector addon shell、view-model 和 package subpath 已实现；Task 7 的 Overview/Timeline 图表、预算分类、范围统计和双时钟轨道已实现；Task 8 的 GPU-driven、FrameGraph、Resources、Diagnostics 领域面板已实现。真实 adapter 上的 off/Live/Record/Deep Capture A/B 和 1080p 性能证据属于 Task 9，当前不能宣称已经达标。

资源数值统一表示 OEngine owner 在实际创建/销毁边界登记的 accounted/estimated bytes，不是物理 VRAM、驱动分配或硬件利用率；history/atlas 与 resident/transient 分账，禁止重复计数。

验证：`npm run build`、`npm run build:test`、`npm run audit:shaders` 通过；Task 1–5 命中测试 74/74 通过；当前全量测试 408/408 通过。

## 已验证基础

- WebGPU Renderer、FrameGraph、FramePlan、Feature/Service 组合和公开入口已经存在。
- GPU-ready geometry package、`GpuAssetStore`、`GpuScene` 与 Packed registry 已形成资源边界。
- Packed hierarchy/work generation、Hardware Visibility、直接 VisibilityKey、分类 Material Resolve 和 Surface 产品已有生产 owner。
- direct lighting、CSM、GI、AO、SSR、MBOIT、Temporal 与 HDR post 已接入同一 Renderer 主流程。
- Rendering Lab 是工作树唯一保留的浏览器 fixture。

这些结构事实不等于 1080p/60 FPS、完整画质、内存上限或 feature-off Gate 已通过。

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

Shader audit 当前记录 69 个 Shader：65 个 `authored-live`、4 个 `unknown`。风险项为 `material_depth_oracle.ts`、`material_expand_oracle.ts`、`oracle_visibility_work_generation.ts` 和 `probe_legacy.generated.ts`；它们仍有 runtime consumer，不能当作死文件删除，也不能把 generator/oracle 当设计权威。

## 下一步

1. 建立 Inspector addon（Task 6–8），再接入 Rendering Lab 完成固定 workload 的 off/Live/Record/Deep Capture A/B（Task 9）。
2. 用 Rendering Lab 固定真实 Packed 多资产 workload，获得 GPU/counter/memory 基线。
3. 移除普通 Scene 的 Material Expand 与独立 Velocity 最终 consumer。
4. 统一 Packed/legacy transparency 的产品和生命周期边界后删除旧 OIT。
5. 为四个 unknown Shader 确认 authored owner 或可追溯生成源。
