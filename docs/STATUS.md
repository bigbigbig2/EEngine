# OEngine 当前状态

更新时间：2026-09-09。本文件只记录当前能力、开放风险和下一步；实施过程与旧结果从 Git 查询。

## 当前基线

- WebGPU Renderer、FrameGraph、FramePlan、Feature/Service 组合和公开入口已经存在。
- GPU-ready geometry package、`GpuAssetStore`、`GpuScene` 与 Packed registry 已形成资源边界。
- Packed frame 已脱离完整 `GPUSceneContext`：共享场景环境与 legacy geometry runtime 分离，frame geometry binding 为互斥 Packed/legacy 输入。
- Packed hierarchy/work generation、Hardware Visibility、直接 `VisibilityKey`、MaterialClassDepth/class-discard 选择和统一 Surface ABI 已有生产 owner。
- 旧 Pixel Queue、ShadeWork 和可见像素 scan/scatter 生产链已退出生产路径。
- direct lighting、CSM、GI、AO、SSR、MBOIT、Temporal 与 HDR post 接入同一 Renderer 主流程。
- Performance Inspector 是共享的实时 Profiler/Timeline；Rendering Lab 是综合质量与性能 fixture。
- Browser Validation 已统一为 Registry + Source Domain Selector + 单一 ChromeRunner；Smoke、Visibility、Surface、Lifecycle 承担日常真实 WebGPU 验证，Rendering Lab 保留综合与 formal benchmark。

这些结构事实不等于 1080p/60 FPS、完整画质、内存上限或 feature-off Gate 已通过。

## 当前生产 Owner

- 总装：公开 `Renderer.ts` shell、唯一 `render/pipeline/MainRenderPipeline.ts` recipe owner 与 `render/features/*`。
- GPU 资产/场景：`GpuAssetStore`、`GpuScene`、`GpuPackedSceneRegistry`。
- 工作/可见性：`GpuWorkGenerationAbi`、`GpuVisibilityKeyAbi`、Packed visibility owners。
- Surface：`GpuSurfaceAbi`、`SurfaceFeature`、MaterialClassDepth probe/pass 和 Material Resolve。
- 效果：Lighting Feature，Render-owned Shadow Feature，AO/Reflection/GI Service，Transparency/Temporal/Post Feature。
- 证据：`FrameProfiler`、GPU counters、resource accounting、shader source audit 和 Rendering Lab diagnostics。

## 开放 Gate 与风险

### Visibility 与 Surface

- MaterialClassDepth 已能在真实 WebGPU adapter 上运行；完整的 attachment parity、历史 legacy 对照和发布级性能 Gate 尚未关闭。
- TriangleSetup candidate cache 保持显式 opt-in；正确性、near-plane、off/on GPU 时间和内存组合证据不足以改变默认值。
- Surface ABI 只有一套生产合同；完整 consumer coverage、attachment/readback parity 和 transient peak 证据仍需补齐。
- Tile backend 没有生产实现。第二 GPU vendor 和同条件性能证据不足时保持 `insufficient-evidence`。

### Legacy 与生命周期

- 普通 Scene 仍有 Material Expand、独立 Velocity 和 legacy OIT 最终 consumer。
- Packed 与普通 Scene 的 Surface metadata、velocity、transparency 生命周期尚未完全统一。
- Shadow 的 device loss、resize、scene replace、feature toggle 与 camera cut 已有浏览器证据；其他 Feature 和提交失败后的 history/resource invalidation 仍需继续补齐。

### 性能、内存与来源

- 1920×1080、DPR 1、完整目标画质下 16.667 ms GPU 尚未在目标设备形成可复现发布基线。
- resident、transient、history、shadow、upload/readback 预算仍需目标 adapter 的同条件证据。
- one-main-submit 和 feature-off 接近零成本需要逐帧证据，不能只凭静态结构判断。
- Shader source audit 仍有 4 个 `unknown` owner；实际数量和名单以生成的 `OEngine/benchmarks/shader-source-audit.json` 为准。

## 下一步

架构优化按 [ADR-0006](./adr/0006-packed-render-world-convergence.md) 的垂直顺序执行；本页只保留当前最近工作：

Step 0 门禁已经建立。Step 1 已消除 Packed material 双 owner：`GpuPackedSceneRegistry` 只按 Texture Residency → Material Store → Instance 顺序提交，`GraphicsContext` 与 `GPUSceneContext` 仅在普通 Scene consumer 首次请求时创建 legacy material registry。Packed Visibility、Surface、CSM、Transparency、debug 和 material patch 使用 Packed material bindings；浏览器 owner evidence 确认 legacy material metadata、默认纹理、depth/expand pipeline 与 per-material context 均未创建。普通 Scene 的 legacy getter 和 consumer 合同继续保留。

Step 2 已完成。Texture Residency 采用五个有界 size-class bank（256/512/1024/2048/4096）和 version/bank/layer 稳定 TextureRef；高分辨率 bank 按需分配，transaction 在 2 GiB hard peak budget、bank capacity 与 device limits 下 preflight，abort 不发布 ref，旧 bank 等 GPU 完成后销毁。Surface、Transparency、MASK Visibility 与 CSM alpha 使用同一 CPU/WGSL decode；CPU/WGSL oracle、120 个全排列、逐层增长、容量/故障注入、真实 Chrome 场景均通过。方案与 clean-commit A/B 证据见 `OEngine/benchmarks/texture-residency-policy.json` 和 `OEngine/benchmarks/texture-residency-step2.json`；目标 workload 保持 25 个纹理与 559240500 resident logical bytes，实测 texture peak/allocation 从 738197376 降到 603979656 bytes，base GPU P50/P95 为 +0.641%/+1.424%。该结果是 smoke A/B，不替代发布级 formal run group。

Step 3 已完成。`GPUSceneEnvironmentContext` 独立拥有 light、environment、light-probe 与 volumetric 数据；`GPUSceneContext` 缩为普通 Scene 的 legacy geometry runtime。Renderer 在 legacy obtain 前查询 Packed registry，`GPUViewContext` 只依赖共享环境与 camera/view/HZB，frame binding 只发布 Packed 或 legacy 一种 geometry source。Packed stable frame、显式 transform/material patch、replace、release/re-register、Lifecycle、Visibility/HZB/LOD/camera-cut 与普通 Scene 回归均有真实浏览器证据；Packed owner evidence 中 legacy geometry table、SceneDatabase、skinning、MeshletDrawList 和 legacy scene upload 均为零，并保持一个 main submit。

Step 4 已完成。Scene-scoped `ShadowFeature` 是 atlas、cascade selection、camera/content cache、Packed hierarchy work、Packed/legacy raster adapter 和 GPU-completion retire 的唯一 owner；`GPULightCollection` 只发布稳定 light/environment 数据，`src/gpu` 对具体 render Pass、`GPUViewContext` 和 `GPUCameraState` 的生产依赖为零。Packed/legacy fixture 共用 `ShadowVisibilityFrame`，cascade split/layout 数值一致；alpha-tested caster、overflow counter、cache hit/miss、resize、camera cut、replace、toggle 和 device-loss recreate 均纳入真实 Chrome 门禁。Rendering Lab 的 `comprehensive-full` 动态 workload 对照记录一个 main submit、Shadow GPU/CPU phase 与 atlas memory，关闭态无 Shadow owner、atlas、work set、GPU/CPU phase、I/O label 或非零 Shadow counter。该结果是开发 smoke evidence，不是发布级性能基线。

Step 5 已完成。`Renderer.ts` 缩为公开生命周期与顶层组合 shell；`MainRenderPipeline` 是 Feature 顺序、FrameProducts、FrameGraph recipe、compiled graph cache 与 graph evidence 的唯一 owner，不再由公开入口直接 import 算法 Pass 或 Shadow/AO/SSR/Post owner。每帧实际创建冻结的 `FrameContext`，其合同限定为 camera/view、resolution domain、feature topology、history validity、scene bindings、instrumentation 与 capture 请求；主管线 cache key 显式覆盖 capability、size、feature topology、visibility backend、instrumentation 和 history format。工作树 Chrome 矩阵已验证 stable graph cache hit、一个 main submit、feature-off cold owner、Lifecycle、Visibility 与 Surface；clean-commit 同条件正式性能对照仍必须在提交后生成，未把 smoke 数字登记为发布基线。

1. 执行 Step 6：统一 GPU Scene 与 Packed Scene 的生产语义，并在 owner/patch/replace/release 门禁通过后关闭默认 legacy scene adapter。
2. 在 clean commit、固定 adapter 和固定 workload 上继续补齐 class-depth/class-discard、TriangleSetup off/on、near-plane 和统一 Surface parity。
3. 保持 Tile backend 为 evidence-only，并为 shader audit 中的 unknown 项确认 authored owner 或可追溯生成源。
