# OEngine 架构

## 当前实现

公开入口由 `OEngine/src/index.ts` 控制。生产依赖大体沿 `core → runtime assets/loaders → gpu → framegraph/render → public interface` 流动；内部 Pass、GPU 表和 Shader ABI 默认不公开。

`OEngine/src/render/Renderer.ts` 是公开生命周期与顶层组合 shell；唯一主管线 recipe 位于 `OEngine/src/render/pipeline/MainRenderPipeline.ts`。它拥有 FramePlan、主 FrameGraph、Feature/Service 装配、compiled graph cache 与 graph evidence。每次 encode 使用冻结的 `FrameContext`，不会把完整公开入口或 GraphicsContext 作为 Pass service locator。

WebGPU/WGSL 的目标能力线、feature/limit/API 探测和 specialization 规则由 [WEBGPU.md](./WEBGPU.md) 单独定义。当前 device creation 强制请求 `core-features-and-limits`、`indirect-first-instance`、`float32-blendable` 与 `texture-formats-tier1`，在 adapter 支持时启用 `timestamp-query`、`subgroups` 和一族纹理压缩能力；初始化会冻结 adapter/device features、关键 limits、WGSL language features、Immediate Data/Transient Attachment API probe 与已选纹理 specialization。`primitive-index`、`shader-f16`、Immediate Data 和 Transient Attachments 仍没有生产 consumer，不能只因 record 已记录就写成已启用能力。

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
| Runtime Asset | `src/assets/RuntimeAssetManifestV2.ts`、`GeometryAssetPackage.ts`、`TextureAssetPackage.ts`、loaders | package/variant 验证、recipe、稳定记录与离线 mip/物理纹理变体 |
| GPU 资产 | `src/gpu/GpuAssetStore.ts`、`TextureResidency.ts` | geometry residency；纹理 immutable size-class segment、stable logical descriptor 与原子派生 routing |
| 场景实例 | `src/gpu/GpuScene.ts` | instance 数据和显式 patch |
| GPU Render World | `src/gpu/GpuRenderWorld.ts` | Packed source 与普通 Scene adapter 的统一 runtime 生命周期 |
| 场景环境 | `src/gpu/GPUSceneEnvironmentContext.ts` | Packed/普通 Scene 共享的 light、environment、light-probe 与 volumetric 数据 |
| GPU 工作 | `src/gpu/GpuWorkGenerationAbi.ts` 及 work-generation owners | 队列 ABI、容量、overflow、indirect args |
| 可见像素身份 | `src/gpu/GpuVisibilityKeyAbi.ts`、Visibility owners | key ABI、sentinel、reverse-Z、diagnostics |
| Surface ABI | `src/gpu/GpuSurfaceAbi.ts` | attachment 格式、编码和版本 |
| Surface 组合 | `src/render/features/SurfaceFeature.ts` | backend 选择、Surface/velocity 产品生命周期 |
| 帧资源 | `src/framegraph/FrameGraph.ts` | 资源、依赖、pruning 和执行 |
| 跨图调度 | `src/render/pipeline/FramePlan.ts` | scene/LPV/shadow/main-view 顺序 |
| 帧输入 | `src/render/pipeline/FrameContext.ts` | camera/view、分辨率域、feature topology、history validity、scene bindings、instrumentation 与 capture 请求 |
| 跨 Pass 产品 | `src/render/pipeline/FrameProducts.ts` | Surface、lighting、AO、reflection、temporal 合同 |
| 阴影功能 | `src/render/features/ShadowFeature.ts`、`ShadowFeatureManager.ts` | Scene-scoped atlas、cascade/cache、统一 Render World work generation/raster 与 retire |
| 功能组合 | `src/render/features/*.ts` | Feature/Service 生命周期与 feature-off |
| 实时证据 UI | `src/addons/inspector` | 有界历史、view-model、实时面板 |
| 主管线 | `src/render/pipeline/MainRenderPipeline.ts` | 唯一 Feature 顺序、FrameGraph recipe/cache/evidence 和单帧 encode |
| 公开总装 | `src/render/Renderer.ts` | 公开 API、设备/画布生命周期入口和顶层组合 |
| WebGPU capability | `src/render/pipeline/MainRenderPipeline.ts`、`src/gpu/GraphicsContext.ts` | adapter/device feature、limit、WGSL/API 探测，冻结 capability record 与 specialization key |

## 生命周期与资源所有权

Runtime Asset 是设备无关事实；GPU owner 由设备和 Renderer 生命周期控制。资源释放必须经过提交边界，不能让 Loader、Scene 临时对象或 FrameGraph 外部引用隐式延长 GPU 对象寿命。持久 history、shadow atlas、LPV 和 asset residency 与 transient frame attachment 分开统计。

Performance Inspector 只消费 Renderer/GPU owner 产生的 `ProfileFrame` 证据。它不成为渲染 owner，也不从 DOM 或推测值重建指标；详细合同位于 `OEngine/src/addons/inspector/README.md`。

## 公开接口

`src/index.ts` 是唯一公开 interface。新增内部 Feature、Pass、Shader、Profiler codec 或 ABI 不应自动导出；只有稳定且被外部调用方需要的能力才进入入口。

`Renderer.uploadScene(scene, geometryAssets)` 建立普通 Scene adapter，`geometryAssets` 明确绑定 CPU geometry identity 与已 Cook package；缺失绑定、空 Scene、非 Standard material、`SkinnedMesh` 或设备容量失败都会在发布 runtime 前抛错。`Renderer.resyncScene()` 是 add/remove/geometry 结构变化的显式冷路径，会先释放旧 registration 再重新驻留；稳定帧只走 `SceneChangeSet` patch。`releaseScene()` 释放任一种 adapter registration；这些异步工具命令不属于 main-frame submit。

## 当前帧输入边界

Packed source 通过 `uploadPackedScene()`、普通 Application Scene 通过 `uploadScene()` 汇入同一个 `GpuRenderWorld`。普通 Scene adapter 只接受调用方显式提供的已 Cook `GeometryAssetPackage`，首次同步生成 bulk structure-of-arrays source；后续 transform/material assignment 从 `SceneChangeSet` 生成确定性 `GpuScene.patch()`。add/remove/geometry 结构变化必须由 `resyncScene()` 明确 full-resync；未注册 Scene 在 `render()` 前失败。

两种输入都由 GPU hierarchy/work generation 直接供 indirect Visibility consumer，输出统一 `VisibilityKey`、必有 metadata 的 Surface、可选 velocity、shadow work 与透明 reactive 数据。旧对象场景 GPU runtime、双 ID visibility attachment、fullscreen material expand、独立 velocity 和旧 OIT/Shadow raster 实现已经删除；不存在隐藏 fallback。完整动画/蒙皮仍属产品 Deferred；`SkinnedMesh` 会显式报 unsupported。AO、SSR 与 GI 由 Service 组合；Shadow atlas、cascade/cache、work generation、raster 和 retire 归 `src/render/features/ShadowFeature.ts` 单一所有。

## 目标差距

- Packed Render World 的固定收敛顺序、owner 删除条件和逐步验证见 [ADR-0006](./adr/0006-packed-render-world-convergence.md)。
- 以真实多资产 Packed Instances、hierarchy/SSE 和固定目标设备证明 GPU 闭环。
- 用同条件 GPU timestamp、counter、memory 和 feature-off 证据证明统一主管线。
