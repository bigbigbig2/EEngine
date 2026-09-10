# OEngine 当前状态

更新时间：2026-09-11。本文件只记录当前能力、开放风险和下一步；实施过程与旧结果从 Git 查询。

## 当前基线

- WebGPU Renderer、FrameGraph、FramePlan、Feature/Service 组合和公开入口已经存在。
- GPU-ready geometry package、`GpuAssetStore`、`GpuScene` 与 `GpuRenderWorld` 已形成资源边界。
- Packed source 与普通 Scene adapter 已汇入同一 GPU Render World；未注册 Scene 直接失败。
- Packed hierarchy/work generation、Hardware Visibility、直接 `VisibilityKey`、MaterialClassDepth/class-discard 选择和统一 Surface ABI 已有生产 owner。
- 旧 Pixel Queue、ShadeWork 和可见像素 scan/scatter 生产链已退出生产路径。
- direct lighting、CSM、GI、AO、SSR、MBOIT、Temporal 与 HDR post 接入同一 Renderer 主流程。
- Performance Inspector 是共享的实时 Profiler/Timeline；Rendering Lab 是综合质量与性能 fixture。
- Browser Validation 已统一为 Registry + Source Domain Selector + 单一 ChromeRunner；Smoke、Visibility、Surface、Lifecycle 承担日常真实 WebGPU 验证，Rendering Lab 保留综合与 formal benchmark。公共证据强度统一为 DEV/MILESTONE/PERF，30+60 的 `profile:rendering-lab:dev` 只承担短 A/B 与编排检查。
- WebGPU 目标能力线已升级为 [WebGPU 2026 Desktop](./WEBGPU.md)。当前代码强制 `core-features-and-limits`、`indirect-first-instance`、`float32-blendable`、`texture-formats-tier1`，机会性启用 `timestamp-query`、`subgroups` 和一族纹理压缩能力，并冻结 adapter/device feature、关键 limit、WGSL/API probe 与 texture specialization record。
- Runtime Package V2 已冻结确定性 manifest/dependency/variant/chunk 语义、物理 byte range、feature/limit compatibility 与 checksum；Texture Package V2 已有完整 offline mip、BC1/3/4/5 physical variant、显式 RGBA8 fallback 和真实 Chrome `cook → load → upload → sample` consumer。
- Texture Residency 已改为有界 immutable size-class segment；业务侧 texture handle 使用 version+slot+generation 且只在提交边界发布，GPU MaterialRecord 消费同事务派生的 physical routing，扩容不再复制已有 resident array；绑定 policy 和 logical/physical/retiring/transaction 计数进入 capability/evidence。
- Geometry 默认生产路径已切到 `static-pbr-compact-v2`：position/normal/tangent/UV/color 使用有界紧凑编码，bounds 保守覆盖 quantization error，Runtime Package manifest/profile/hash 与目录互证；float32 generic 只保留显式 fallback。
- Instance ABI 已拆为 64 B static 与 112 B dynamic region，总 stride 为 176 B；static/transform/material/visibility/lifecycle 分流，transform、material 与 visibility 只上传命中 region/field，CPU shadow 与 patch bytes 由 owner/Profiler 计数。
- Runtime Asset 已有无 scheduler 的 chunk/page seam：stable identity、logical/physical resident range、request state、budget hook、原子 commit/abort、retire 与 device-loss reset；Geometry/Texture upload 已接入且不改变 stable asset/material handle。
- ADR-0008 Step 0 已冻结 Geometry truth counter ABI 并接入生产 GPU 阶段：hierarchy nodes、accepted clusters、selected meshlets、MeshletWork、candidate/risky/exact/raster triangles、padding、visible pixels 与 queue payload bytes 可分别观测；切换前正式综合基线保存在 `OEngine/benchmarks/gpu-driven-geometry-v2-baseline.json`。
- ADR-0008 Step 1–5 已冻结 24 B `GpuMeshletRasterWork`、32 B correctness-critical queue header 与 VisibilityKey V2 的 `24-bit work slot + 8-bit local primitive`；GPU projection-risk classifier 将 normal 与 selective-exact meshlet 互斥排入 32+32 个有界 bucket，固定 64 次 `drawIndirect` 写同一 production `r32uint` key/reverse-Z depth。Material Resolve、MaterialClassDepth 与 Visibility debug 只经 MeshletWork 恢复 material/geometry；旧 ExactRasterWork 只写 parity target。queue overflow/invalid 会清零全部 bucket indirect args，禁止呈现部分几何。独立、默认关闭的 `LargeTriangleSetupCache` 以 `workSlot * 128 + localPrimitive` 建立有界可裁剪 cache，overflow 逐像素 fallback；Step 2/3/5 clean PERF 分别保存在 `OEngine/benchmarks/gpu-driven-geometry-v2-step2.json`、`OEngine/benchmarks/gpu-driven-geometry-v2-step3.json` 与 `OEngine/benchmarks/gpu-driven-geometry-v2-step5.json`。

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

- Meshlet bucket Hardware Visibility 在 targeted OPAQUE/double-sided/MASK Case 上为零 semantic mismatch；动态 comprehensive DEV 观测到每帧 0–6 个约 87.4 万覆盖像素的 primitive identity 分歧，当前判断为不同 queue 顺序下的等深覆盖争用。VisibilityKey V2 已切为 normal output，但旧 exact parity seam 仍保留到 selective-risk 路由完成；该非零风险不能用像素比例掩盖。
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
- `primitive-index`、`shader-f16`、Immediate Data 与 Transient Attachment 尚无生产 consumer；lockfile 中的 `@webgpu/types` 0.1.71 还没有 2026-09 规范中的 `texture-compression-unaligned` 名称，因此 BC base dimensions 仍要求 block alignment；已对齐 base 的物理 mip subresource 仍离线保留并上传到 1×1 tail。
- Texture Residency 当前每个 size-class 只有一个有界 segment/binding slot；多 format-class 与多 binding-set coverage 留在 ADR-0007 后续迁移，超出当前 policy 明确 preflight failure。

## 下一步

1. [ADR-0010](./adr/0010-webgpu-2026-capability-contract.md)：为 `primitive-index`、`shader-f16`、Immediate Data 与 Transient Attachment 增加实际 consumer/fallback；没有 consumer 前保持 record-only。
2. [ADR-0007](./adr/0007-gpu-native-runtime-assets-and-residency-v2.md)：Step 1–6 implementation 与 MILESTONE 综合 profile 已落地；在 clean commit 上运行唯一 comprehensive final PERF 后关闭 ADR。
3. [ADR-0008](./adr/0008-gpu-driven-geometry-and-visibility-v2.md)：Step 0–5 已完成；下一步实现 Flat/Shallow/Full local strategy 与 fixed/adaptive GeometryWorkBudget。
4. [ADR-0009](./adr/0009-compute-shading-and-advanced-frame-pipeline-v2.md)：等待 ADR-0008 VisibilityKey V2；SSAO/SSR upstream porting 可以提前研究，但 production cutover 后置。
