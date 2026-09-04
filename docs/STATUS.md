# OEngine 当前状态

更新时间：2026-09-05。本文件是唯一可变状态页；完成过程从 Git 查询。

## Performance Inspector 状态

`docs/PERFORMANCE-INSPECTOR.md` 的 Task 1–5 已完成核心数据层实现，当前提交包含：

- Task 1：typed `MetricDescriptor`/`MetricSample`、注册表、默认指标目录、nearest-rank 统计和 coverage 统计。
- Task 2：immutable `ProfileFrame`/`ProfileSpan`、有界 `ProfileHistory`、按 `frameIndex` 的异步 patch 和状态校验。
- Task 3：`FrameProfiler` 接入历史帧、CPU/GPU span、Live/Record/Deep Capture 基础 cadence、GPU timestamp/counter 异步回填及不可用状态。
- Task 4：`GraphicsContext` Buffer 账本、Pipeline cache/host-call 观测和 FrameGraph active/culled 证据。
- Task 5：Capture schema 校验、深冻结、JSON 序列化/导入和 CPU/GPU 分轨 Trace 导出。

Task 3–5 仍有明确未完成项：完整 typed metric 调用迁移与 epoch/warm-up；所有 GPU owner 的资源生命周期接入、压缩纹理估算、first-use pipeline 证据和 FrameGraph 临时资源峰值；Capture golden fixture、未知字段/未来 schema 兼容矩阵和派生统计一致性验证。Inspector UI（Task 6–9）尚未开始。

资源账本当前只对 `GraphicsContext.createBuffer()` 的真实 Buffer 生命周期提供运行时接入；不能据此声称覆盖全部 WebGPU resident/transient/history/atlas/upload/readback 资源或物理 VRAM。

验证：`npm run build` 通过；性能监视器定向测试 26/26 通过。全量 `npm test` 的唯一失败来自既有 FX-04/FX-06 porting ledger 文档断言，与本次性能监视器实现无关。

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

1. 完成 Performance Inspector Task 3–5 的剩余契约：typed metric 全量迁移、epoch/warm-up、Capture golden fixtures 和派生统计校验。
2. 将资源账本接入 `GpuAssetStore`、`GpuScene`、Packed registry 及 transient/history/atlas/upload/readback owner，并补齐压缩纹理与 first-use pipeline 证据。
3. 建立 Inspector addon（Task 6–8），再接入 Rendering Lab 完成固定 workload 的 off/Live/Record/Deep Capture A/B（Task 9）。
4. 用 Rendering Lab 固定真实 Packed 多资产 workload，获得 GPU/counter/memory 基线。
5. 移除普通 Scene 的 Material Expand 与独立 Velocity 最终 consumer。
6. 统一 Packed/legacy transparency 的产品和生命周期边界后删除旧 OIT。
7. 为四个 unknown Shader 确认 authored owner 或可追溯生成源。
