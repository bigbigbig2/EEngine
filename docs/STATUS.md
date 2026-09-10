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

架构优化按 [ADR-0006](./adr/0006-packed-render-world-convergence.md) 的垂直顺序执行；本页只保留当前最近工作：

Step 0 门禁已经建立。Step 1 已消除 Packed material 双 owner：当前 `GpuRenderWorld` 只按 Texture Residency → Material Store → Instance 顺序提交；Packed Visibility、Surface、CSM、Transparency、debug 和 material patch 使用统一 material bindings，浏览器 owner evidence 确认 legacy material metadata、默认纹理、depth/expand pipeline 与 per-material context 均未创建。

Step 2 已完成。Texture Residency 采用五个有界 size-class bank（256/512/1024/2048/4096）和 version/bank/layer 稳定 TextureRef；高分辨率 bank 按需分配，transaction 在 2 GiB hard peak budget、bank capacity 与 device limits 下 preflight，abort 不发布 ref，旧 bank 等 GPU 完成后销毁。Surface、Transparency、MASK Visibility 与 CSM alpha 使用同一 CPU/WGSL decode；CPU/WGSL oracle、120 个全排列、逐层增长、容量/故障注入、真实 Chrome 场景均通过。方案与 clean-commit A/B 证据见 `OEngine/benchmarks/texture-residency-policy.json` 和 `OEngine/benchmarks/texture-residency-step2.json`；目标 workload 保持 25 个纹理与 559240500 resident logical bytes，实测 texture peak/allocation 从 738197376 降到 603979656 bytes，base GPU P50/P95 为 +0.641%/+1.424%。该结果是 smoke A/B，不替代发布级 formal run group。

Step 3 已完成。`GPUSceneEnvironmentContext` 独立拥有 light、environment、light-probe 与 volumetric 数据，`GPUViewContext` 只依赖共享环境与 camera/view/HZB。Step 7 已删除旧 geometry/material/skinning runtime 与 draw-list 实现。

Step 4 已完成。Scene-scoped `ShadowFeature` 是 atlas、cascade selection、camera/content cache、hierarchy work、raster 和 GPU-completion retire 的唯一 owner；`GPULightCollection` 只发布稳定 light/environment 数据，`src/gpu` 对具体 render Pass、`GPUViewContext` 和 `GPUCameraState` 的生产依赖为零。Packed/普通 Scene adapter 共用 `ShadowVisibilityFrame` 和 Render World raster consumer，cascade split/layout 数值一致；alpha-tested caster、overflow counter、cache hit/miss、resize、camera cut、replace、toggle 和 device-loss recreate 均纳入真实 Chrome 门禁。

Step 5 已完成。`Renderer.ts` 缩为公开生命周期与顶层组合 shell；`MainRenderPipeline` 是 Feature 顺序、FrameProducts、FrameGraph recipe、compiled graph cache 与 graph evidence 的唯一 owner，不再由公开入口直接 import 算法 Pass 或 Shadow/AO/SSR/Post owner。每帧实际创建冻结的 `FrameContext`，其合同限定为 camera/view、resolution domain、feature topology、history validity、scene bindings、instrumentation 与 capture 请求；主管线 cache key 显式覆盖 capability、size、feature topology、visibility configuration、instrumentation 和 history format。固定矩阵覆盖 full、base、每个 feature-off、debug、capture、resize、camera cut 与 abort；stable frame 保持一个 main submit、一次 cache hit/execute、零 build/compile/pipeline/bind-group create。相同 NVIDIA Turing、Chrome 152、1920×1080、`comprehensive-full` 的 clean-commit 正式 A/B 每侧执行 3×(120 warm-up + 480 measured)，graph/resource/memory/I/O 完全相同，CPU frame P50/P95 为 -0.362%/-3.399%，GPU frame P50/P95 为 +0.239%/-3.509%；证据见 `OEngine/benchmarks/main-render-pipeline-step5.json`，不外推为跨 vendor 结论。

Step 6 已完成。`GpuRenderWorld` 同时接收 Packed source 与普通 Application Scene adapter，二者共享 `GpuAssetStore`、`GpuScene`、`GpuMaterialStore`、Texture Residency、hierarchy/work generation、VisibilityKey、Surface/velocity、Shadow 和 MBOIT/Temporal consumer。普通 Scene 首次绑定只接受已 Cook package；transform/material assignment 由 `SceneChangeSet` 生成确定性 patch，abort 会重试，add/remove/geometry 通过显式 `resyncScene()` full-resync。未注册 Scene 直接失败，`SkinnedMesh` 显式 unsupported；真实 Chrome 覆盖稳定帧、patch、add/remove resync、shadow parity、alpha-tested、double-sided、transparent 和 reactive/Temporal，并确认一个 main submit、无 legacy owner/scene upload、无 overflow 或 GPU error。

Step 7 已完成并关闭 ADR-0006 的架构迁移：生产代码只保留一个 Render World、VisibilityKey attachment、Surface/velocity producer、MBOIT、directional CSM consumer 和 graph recipe；旧 runtime、Pass、shader/layout/pipeline/counter、双 ID attachment、公开 owner evidence 字段与旧诊断标签均已删除。shader audit 只有 41 个有生产 owner 的 authored shader，无 dead/unknown/oracle source。相同 NVIDIA Turing、Chrome 152、1920×1080、`comprehensive-full` 的 clean-commit 正式 A/B 每侧执行 3×(120 warm-up + 480 measured)，graph dump、43 个可执行 Pass、71 个资源、memory、submit、upload/readback 完全相同；CPU frame P50/P95 为 +0.990%/+2.563%，GPU frame P50/P95 为 -0.526%/+0.418%，未显示本机显著回退。11-case feature topology 矩阵全部保持一次 main submit、零 invalid stable frame 和零 overflow；完整证据见 `OEngine/benchmarks/render-world-convergence-step7.json`。该结果只覆盖单一 adapter，不宣称 1080p/60 已达成；Triangle Setup、Surface ABI 和双 vendor Tile backend 仍为证据不足。

1. 先实现 `WEBGPU.md` 的冻结 capability record、core adapter 校验、WGSL/API probe 和 specialization cache key，再让 ADR-0007/0008/0009 的 2026 能力进入生产路径。
2. 在 clean commit、固定 adapter 和固定 workload 上继续补齐 class-depth/class-discard、TriangleSetup off/on、near-plane 和统一 Surface parity。
3. 保持 Tile backend 为 evidence-only；Instance ABI、public subpath 与 FrameGraph execution state 只由 ADR-0006 Step 8 的证据门槛触发。
