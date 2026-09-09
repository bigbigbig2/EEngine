# OEngine 当前状态

更新时间：2026-09-09。本文件只记录当前能力、开放风险和下一步；实施过程与旧结果从 Git 查询。

## 当前基线

- WebGPU Renderer、FrameGraph、FramePlan、Feature/Service 组合和公开入口已经存在。
- GPU-ready geometry package、`GpuAssetStore`、`GpuScene` 与 Packed registry 已形成资源边界。
- Packed hierarchy/work generation、Hardware Visibility、直接 `VisibilityKey`、MaterialClassDepth/class-discard 选择和统一 Surface ABI 已有生产 owner。
- 旧 Pixel Queue、ShadeWork 和可见像素 scan/scatter 生产链已退出生产路径。
- direct lighting、CSM、GI、AO、SSR、MBOIT、Temporal 与 HDR post 接入同一 Renderer 主流程。
- Performance Inspector 是共享的实时 Profiler/Timeline；Rendering Lab 是综合质量与性能 fixture。
- Browser Validation 已统一为 Registry + Source Domain Selector + 单一 ChromeRunner；Smoke、Visibility、Surface、Lifecycle 承担日常真实 WebGPU 验证，Rendering Lab 保留综合与 formal benchmark。

这些结构事实不等于 1080p/60 FPS、完整画质、内存上限或 feature-off Gate 已通过。

## 当前生产 Owner

- 总装：`Renderer.ts` 与 `render/features/*`。
- GPU 资产/场景：`GpuAssetStore`、`GpuScene`、`GpuPackedSceneRegistry`。
- 工作/可见性：`GpuWorkGenerationAbi`、`GpuVisibilityKeyAbi`、Packed visibility owners。
- Surface：`GpuSurfaceAbi`、`SurfaceFeature`、MaterialClassDepth probe/pass 和 Material Resolve。
- 效果：Lighting Feature，AO/Reflection/GI Service，Transparency/Temporal/Post Feature。
- 证据：`FrameProfiler`、GPU counters、resource accounting、shader source audit 和 Rendering Lab diagnostics。

## 开放 Gate 与风险

### Visibility 与 Surface

- MaterialClassDepth 已能在真实 WebGPU adapter 上运行；完整的 attachment parity、历史 legacy 对照和发布级性能 Gate 尚未关闭。
- TriangleSetup candidate cache 保持显式 opt-in；正确性、near-plane、off/on GPU 时间和内存组合证据不足以改变默认值。
- Surface ABI 只有一套生产合同；完整 consumer coverage、attachment/readback parity 和 transient peak 证据仍需补齐。
- Tile backend 没有生产实现。第二 GPU vendor 和同条件性能证据不足时保持 `insufficient-evidence`。

### Legacy 与生命周期

- `Renderer.ts` 仍是大型 composition root。
- 普通 Scene 仍有 Material Expand、独立 Velocity 和 legacy OIT 最终 consumer。
- Packed 与普通 Scene 的 Surface metadata、velocity、transparency 生命周期尚未完全统一。
- device loss、resize、feature toggle、camera cut 和提交失败后的 history/resource invalidation 仍需浏览器证据。

### 性能、内存与来源

- 1920×1080、DPR 1、完整目标画质下 16.667 ms GPU 尚未在目标设备形成可复现发布基线。
- resident、transient、history、shadow、upload/readback 预算仍需目标 adapter 的同条件证据。
- one-main-submit 和 feature-off 接近零成本需要逐帧证据，不能只凭静态结构判断。
- Shader source audit 仍有 4 个 `unknown` owner；实际数量和名单以生成的 `OEngine/benchmarks/shader-source-audit.json` 为准。

## 下一步

架构优化按 [ADR-0006](./adr/0006-packed-render-world-convergence.md) 的垂直顺序执行；本页只保留当前最近工作：

Step 0 门禁已经建立。Step 1 已消除 Packed material 双 owner：`GpuPackedSceneRegistry` 只按 Texture Residency → Material Store → Instance 顺序提交，`GraphicsContext` 与 `GPUSceneContext` 仅在普通 Scene consumer 首次请求时创建 legacy material registry。Packed Visibility、Surface、CSM、Transparency、debug 和 material patch 使用 Packed material bindings；浏览器 owner evidence 确认 legacy material metadata、默认纹理、depth/expand pipeline 与 per-material context 均未创建。普通 Scene 的 legacy getter 和 consumer 合同继续保留。

1. 执行 Step 2：为 Texture Residency 的有界 size-class 与稳定引用可迁移方案补齐来源、ABI、内存和同条件性能比较，再选择并实现加载顺序无关的方案。
2. 在 clean commit、固定 adapter 和固定 workload 上继续补齐 class-depth/class-discard、TriangleSetup off/on、near-plane 和统一 Surface parity。
3. 保持 Tile backend 为 evidence-only，并为 shader audit 中的 unknown 项确认 authored owner 或可追溯生成源。
