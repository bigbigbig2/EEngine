# OEngine 架构

## 当前实现

公开入口由 `OEngine/src/index.ts` 控制。生产依赖大体沿 `core → runtime assets/loaders → gpu → framegraph/render → public interface` 流动；内部 Pass、GPU 表和 Shader ABI 默认不公开。

`OEngine/src/render/Renderer.ts` 是公开生命周期与顶层组合 shell；唯一主管线 recipe 位于 `OEngine/src/render/pipeline/MainRenderPipeline.ts`。它拥有 FramePlan、主 FrameGraph、Feature/Service 装配、compiled graph cache 与 graph evidence。每次 encode 使用冻结的 `FrameContext`，不会把完整公开入口或 GraphicsContext 作为 Pass service locator。

WebGPU/WGSL 的目标能力线、feature/limit/API 探测和 specialization 规则由 [WEBGPU.md](./WEBGPU.md) 单独定义。当前 device creation 强制请求 `core-features-and-limits`、`indirect-first-instance`、`float32-blendable` 与 `texture-formats-tier1`，在 adapter 支持时启用 `timestamp-query`、`subgroups`、`primitive-index` 和一族纹理压缩能力；初始化会冻结 adapter/device features、关键 limits、WGSL language features、Immediate Data/Transient Attachment API probe、TextureBindingSet slot/sampler/set/dispatch policy 与已选纹理 specialization。Visibility fragment 在 feature 已启用时以 `@builtin(primitive_index)` 恢复 meshlet-local triangle，缺失时由 vertex `vertex_index / 3` 的 flat varying 保持同一 VisibilityKey 语义。`shader-f16`、Immediate Data 和 Transient Attachments 仍没有生产 consumer，不能只因 record 已记录就写成已启用能力。

## 依赖方向

```text
Source asset
  → validated Runtime Asset package
  → GpuAssetStore / GpuScene / GpuRenderWorld
  → FramePlan + FrameGraph
  → Visibility / Surface / Lighting / Transparency / Temporal / Post
  → present and asynchronous evidence
```

CPU 负责资产导入、显式 patch、帧配置和命令编排；最终可见工作必须由 GPU 队列直接供 GPU consumer 使用，不能回读后由 CPU 重建 draw list。

## 模块与 Owner

| 边界 | 当前 owner | 责任 |
| --- | --- | --- |
| Runtime Asset | `src/assets/RuntimeAssetManifestV2.ts`、`RuntimeAssetResidency.ts`、`GeometryAssetPackage.ts`、`TextureAssetPackage.ts`、`Brick4LightMapPackage.ts`、`src/assets/codec/*`、loaders | package/variant 验证、稳定 chunk identity、Encoded Texture Variant、Brick4 monolithic tree/probe generation、惰性有界 Worker/WASM preparation、budget/request state 与 logical/physical resident range |
| GPU 资产 | `src/gpu/GpuAssetStore.ts`、`TextureResidency.ts` | compact geometry residency；纹理 exact-format immutable segment、有界 multi `TextureBindingSet`、uncooked RGBA8 development segment、stable logical descriptor 与原子派生 routing |
| 场景实例 | `src/gpu/GpuScene.ts` | 64 B static + 112 B dynamic instance ABI，static/transform/material/visibility/lifecycle 显式窄 patch 与 CPU shadow accounting |
| GPU Render World | `src/gpu/GpuRenderWorld.ts` | Packed source 与普通 Scene adapter 的统一 runtime 生命周期 |
| 场景环境 | `src/gpu/GPUSceneEnvironmentContext.ts` | Packed/普通 Scene 共享的 light、environment、light-probe 与 volumetric 数据 |
| GPU 工作 | `src/gpu/GpuWorkGenerationAbi.ts` 及 work-generation owners | 队列 ABI、容量、overflow、indirect args |
| 可见像素身份 | `src/gpu/GpuVisibilityKeyAbi.ts`、Visibility owners | key ABI、sentinel、reverse-Z、diagnostics |
| SurfaceLite/HDR ABI | `src/gpu/GpuComputeMaterialAbi.ts`、`GpuHdrAbi.ts` | compact working-set、conditional velocity、normal/flags 编码、HDR/history 格式与 bytes/pixel |
| Surface 组合 | `src/render/features/SurfaceFeature.ts` | backend 选择、Surface/velocity 产品生命周期 |
| 帧资源 | `src/framegraph/FrameGraph.ts` | 资源、依赖、pruning 和执行 |
| 跨图调度 | `src/render/pipeline/FramePlan.ts` | scene/LPV/shadow/main-view 顺序 |
| 帧输入 | `src/render/pipeline/FrameContext.ts` | camera/view、分辨率域、feature topology、history validity、scene bindings、instrumentation 与 capture 请求 |
| 跨 Pass 产品 | `src/render/pipeline/FrameProducts.ts` | Surface、lighting、AO、reflection、temporal、`OpaqueColorPyramid` 与 `FinalColorPyramid` 的 typed contract |
| 共享帧派生 | `src/render/passes/SharedColorPyramidPass.ts` | 按 consumer 生成语义隔离的 opaque/final HDR pyramid；SSR、Bloom、Exposure 不再各建等价 reduction |
| Persistent history | `src/render/TemporalHistoryRegistry.ts` | 六种 history 的 semantic/domain/format/count/generation、提交感知 ping-pong、pre-exposure 与统一失效原因；物理资源仍归 effect owner |
| Temporal/DRS | `src/render/features/TemporalFeature.ts`、`DynamicResolutionScaling.ts`、`passes/TemporalAntiAliasingPass.ts` | internal→output reconstruction、reactive/disocclusion、output history confidence 与 fixed/adaptive delayed-GPU-timing policy；配置只来自 RenderSettings |
| Screen-space diffuse | `src/render/features/AOService.ts`、`ScreenSpaceDiffuseService.ts`、`src/render/passes/GtaoPass.ts`、`SsgiPass.ts`、`ScreenSpaceDiffuseResolvePass.ts` | 单值 `off/gtao/ssgi` exclusive owner；Three.js r186-derived GTAO 或 SSGI、同 trace AO/bent、共享 history registry、pre-SSGI source 与能量边界 resolve |
| Long-range GI | `src/render/features/GIService.ts`、`src/render/passes/LongRangeDiffuseProviderPass.ts` | 单个逐 receiver producer，以早返回执行 Brick4 → Probe Volume → IBL → black；输出唯一 provider identity、diffuse irradiance 与 baseline specular radiance，不预计算三套 fullscreen candidate |
| 阴影功能 | `src/render/features/ShadowFeature.ts`、`ShadowFeatureManager.ts` | Scene-scoped atlas、cascade/cache、统一 Render World work generation/raster 与 retire |
| 功能组合 | `src/render/features/*.ts` | Feature/Service 生命周期与 feature-off |
| 实时证据 UI | `src/addons/inspector` | 有界历史、view-model、实时面板 |
| 主管线 | `src/render/pipeline/MainRenderPipeline.ts` | 唯一 Feature 顺序、FrameGraph recipe/cache/evidence 和单帧 encode |
| 公开总装 | `src/render/Renderer.ts` | 公开 API、设备/画布生命周期入口和顶层组合 |
| WebGPU capability | `src/render/pipeline/MainRenderPipeline.ts`、`src/gpu/GraphicsContext.ts` | adapter/device feature、limit、WGSL/API 探测，冻结 capability record 与 specialization key |

## 生命周期与资源所有权

Runtime Asset 是设备无关事实；GPU owner 由设备和 Renderer 生命周期控制。资源释放必须经过提交边界，不能让 Loader、Scene 临时对象或 FrameGraph 外部引用隐式延长 GPU 对象寿命。持久 history、shadow atlas、LPV 和 asset residency 与 transient frame attachment 分开统计。颜色 pyramid 是当帧 transient 产品：`OpaqueColorPyramid` 与 `FinalColorPyramid` source stage 不同，禁止为了复用内存改写成同一 logical product；只有 descriptor/lifetime 兼容且不破坏语义时，FrameGraph 才可在底层复用 allocation。

Geometry 默认生产变体是 `static-pbr-compact-v2`；position/normal/tangent/UV/color 的物理编码由 package profile 冻结，Shader 只能经共享 decode ABI 读取。`explicit-float32-fallback-v2` 需要 Cooker 显式选择。普通生产材质纹理由 `ShadeTexture.fromAssetPackageV2()` 携带设备无关 Texture Package：已有 GPU-native variant 直接进入 residency；KTX2 UASTC/ETC1S 先经 `GraphicsContext` 惰性持有的有界 `AssetCodecService` 和固定 Khronos libktx Worker/WASM 转为同一 Encoded Variant/package。两者随后统一经过 `GpuRenderWorld → TextureResidency`，按 exact format、extent 与完整离线 mip 分配 immutable segment，并由最多 4 个 `TextureBindingSet` 为同一 material colocate 全部语义。`KernelClassId × TextureBindingSetId` 的固定有界 consumer 覆盖 Material Resolve、Visibility MASK、Shadow MASK 与 Transparency；运行时 mip generation 只保留给显式未 Cook 的 development 输入。Runtime residency seam 只表达 chunk/request/budget/range 和退役，不拥有 scheduler；逻辑 asset/material handle 不含 GPU buffer offset、texture layer 或 mip/page 地址。

Performance Inspector 只消费 Renderer/GPU owner 产生的 `ProfileFrame` 证据。它不成为渲染 owner，也不从 DOM 或推测值重建指标；详细合同位于 `OEngine/src/addons/inspector/README.md`。

## 公开接口

`src/index.ts` 是唯一公开 interface。新增内部 Feature、Pass、Shader、Profiler codec 或 ABI 不应自动导出；只有稳定且被外部调用方需要的能力才进入入口。

`Renderer.uploadScene(scene, geometryAssets)` 建立普通 Scene adapter，`geometryAssets` 明确绑定 CPU geometry identity 与已 Cook package；缺失绑定、空 Scene、非 Standard material、`SkinnedMesh` 或设备容量失败都会在发布 runtime 前抛错。`Renderer.resyncScene()` 是 add/remove/geometry 结构变化的显式冷路径，会先释放旧 registration 再重新驻留；稳定帧只走 `SceneChangeSet` patch。`releaseScene()` 释放任一种 adapter registration；这些异步工具命令不属于 main-frame submit。

## 当前帧输入边界

Packed source 通过 `uploadPackedScene()`、普通 Application Scene 通过 `uploadScene()` 汇入同一个 `GpuRenderWorld`。普通 Scene adapter 只接受调用方显式提供的已 Cook `GeometryAssetPackage`，首次同步生成 bulk structure-of-arrays source；后续 transform/material assignment 从 `SceneChangeSet` 生成确定性 `GpuScene.patch()`。add/remove/geometry 结构变化必须由 `resyncScene()` 明确 full-resync；未注册 Scene 在 `render()` 前失败。

两种输入都由 GPU hierarchy/work generation 直接供 indirect Visibility consumer，输出统一 `VisibilityKey`、必有 metadata 的 Surface、可选 velocity、shadow work 与透明 reactive 数据。旧对象场景 GPU runtime、双 ID visibility attachment、fullscreen material expand、独立 velocity 和旧 OIT/Shadow raster 实现已经删除；不存在隐藏 fallback。完整动画/蒙皮仍属产品 Deferred；`SkinnedMesh` 会显式报 unsupported。AO、SSR 与 GI 由 Service 组合；`AOService → GtaoPass` 是 `mode=gtao` 的唯一 production screen-space AO owner，以同一 Three.js r186-derived horizon trace 产生 visibility+bent normal，并由 OEngine history/joint resolve 消费，不依赖 three.js runtime 或额外 TRAA owner。Shadow atlas、cascade/cache、work generation、raster 和 retire 归 `src/render/features/ShadowFeature.ts` 单一所有。

## 目标差距

- Packed Render World 的固定收敛顺序、owner 删除条件和逐步验证见 [ADR-0006](./adr/0006-packed-render-world-convergence.md)。
- 以真实多资产 Packed Instances、hierarchy/SSE 和固定目标设备证明 GPU 闭环。
- 用同条件 GPU timestamp、counter、memory 和 feature-off 证据证明统一主管线。
