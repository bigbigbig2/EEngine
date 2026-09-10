# OEngine 当前状态

更新时间：2026-09-10。本文件只记录当前能力、开放风险和下一步；实施过程与旧结果从 Git 查询。

## 当前基线

- WebGPU Renderer、FrameGraph、FramePlan、Feature/Service 组合和公开入口已经存在。
- GPU-ready geometry package、`GpuAssetStore`、`GpuScene` 与 `GpuRenderWorld` 已形成资源边界。
- Packed source 与普通 Scene adapter 已汇入同一 GPU Render World；未注册 Scene 直接失败。
- Packed hierarchy/work generation、Hardware Visibility、直接 `VisibilityKey`、MaterialClassDepth/class-discard 选择和统一 Surface ABI 已有生产 owner。
- 旧 Pixel Queue、ShadeWork 和可见像素 scan/scatter 生产链已退出生产路径。
- direct lighting、CSM、GI、AO、SSR、MBOIT、Temporal 与 HDR post 接入同一 Renderer 主流程。
- Performance Inspector 是共享的实时 Profiler/Timeline；Rendering Lab 是综合质量与性能 fixture。
- Browser Validation 已统一为 Registry + Source Domain Selector + 单一 ChromeRunner；Smoke、Visibility、Surface、Lifecycle 承担日常真实 WebGPU 验证，Rendering Lab 保留综合与 formal benchmark。公共证据强度统一为 DEV/MILESTONE/PERF，30+60 的 `profile:rendering-lab:dev` 只承担短 A/B 与编排检查。
- WebGPU 目标能力线已升级为 [WebGPU 2026 Desktop](./WEBGPU.md)。当前代码只已强制 `indirect-first-instance`、`float32-blendable`、`texture-formats-tier1`，并机会性启用 `timestamp-query`、`subgroups`；其余 2026 specialization 尚未落地。

这些结构事实不等于 1080p/60 FPS、完整画质、内存上限或 feature-off Gate 已通过。

## 当前生产 Owner

- 总装：公开 `Renderer.ts` shell、唯一 `render/pipeline/MainRenderPipeline.ts` recipe owner 与 `render/features/*`。
- GPU 资产/场景：`GpuAssetStore`、`GpuScene`、`GpuRenderWorld`。
- 工作/可见性：`GpuWorkGenerationAbi`、`GpuVisibilityKeyAbi`、统一 visibility owners。
- Surface：`GpuSurfaceAbi`、`SurfaceFeature`、MaterialClassDepth probe/pass 和 Material Resolve。
- 效果：Lighting Feature，Render-owned Shadow Feature，AO/Reflection/GI Service，Transparency/Temporal/Post Feature。
- 证据：`FrameProfiler`、GPU counters、resource accounting、shader source audit 和 Rendering Lab diagnostics。

## 开放 Gate 与风险

### Visibility 与 Surface

- MaterialClassDepth 已能在真实 WebGPU adapter 上运行；完整的 attachment parity、历史 legacy 对照和发布级性能 Gate 尚未关闭。
- TriangleSetup candidate cache 保持显式 opt-in；正确性、near-plane、off/on GPU 时间和内存组合证据不足以改变默认值。
- Surface ABI 只有一套生产合同；完整 consumer coverage、attachment/readback parity 和 transient peak 证据仍需补齐。
- Tile backend 没有生产实现。第二 GPU vendor 和同条件性能证据不足时保持 `insufficient-evidence`。

### 生命周期

- 旧对象场景 GPU runtime、双 ID visibility attachment、Material Expand、独立 Velocity、旧 OIT/Shadow/LPV update 路径及其无消费者 shader 已静态删除；生产图没有兼容分支。
- 普通 Scene 的当前产品 adapter 不支持 `SkinnedMesh`；完整蒙皮/动画仍为 Deferred，并显式报 unsupported。
- Shadow 的 device loss、resize、scene replace、feature toggle 与 camera cut 已有浏览器证据；其他 Feature 和提交失败后的 history/resource invalidation 仍需继续补齐。

### 性能、内存与来源

- 1920×1080、DPR 1、完整目标画质下 16.667 ms GPU 尚未在目标设备形成可复现发布基线。
- resident、transient、history、shadow、upload/readback 预算仍需目标 adapter 的同条件证据。
- one-main-submit 和 feature-off 接近零成本需要逐帧证据，不能只凭静态结构判断。
- Shader source audit 当前只有有生产 owner 的 authored shader；实际数量和名单以生成的 `OEngine/benchmarks/shader-source-audit.json` 为准。
- capability record 尚未覆盖 `core-features-and-limits`、WGSL language features、Immediate Data/Transient Attachment API probe 和最终 specialization；lockfile 中的 `@webgpu/types` 0.1.71 还没有 2026-09 规范中的 `texture-compression-unaligned` 名称。

## 下一步

1. [ADR-0010](./adr/0010-webgpu-2026-capability-contract.md)：实现 WebGPU 2026 capability record、probe 与 specialization foundation。
2. [ADR-0007](./adr/0007-gpu-native-runtime-assets-and-residency-v2.md)：当前等待 ADR-0010 runtime capability foundation；Next 是 Step 0 Memory / Asset Truth。
3. [ADR-0008](./adr/0008-gpu-driven-geometry-and-visibility-v2.md)：等待 ADR-0007 compact geometry 与 instance contracts。
4. [ADR-0009](./adr/0009-compute-shading-and-advanced-frame-pipeline-v2.md)：等待 ADR-0008 VisibilityKey V2；SSAO/SSR upstream porting 可以提前研究，但 production cutover 后置。
