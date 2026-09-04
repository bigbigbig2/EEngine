# OEngine 当前状态

更新时间：2026-09-04。本文件是唯一可变状态页；完成过程从 Git 查询。

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

1. 按 [PERFORMANCE-INSPECTOR.md](./PERFORMANCE-INSPECTOR.md) 建立有类型的 profiler 核心、捕获格式和性能 Inspector。
2. 用 Rendering Lab 固定真实 Packed 多资产 workload，获得 GPU/counter/memory 基线。
3. 移除普通 Scene 的 Material Expand 与独立 Velocity 最终 consumer。
4. 统一 Packed/legacy transparency 的产品和生命周期边界后删除旧 OIT。
5. 拆分 Renderer composition，保持一条主管线和单提交合同。
6. 为四个 unknown Shader 确认 authored owner 或可追溯生成源。
