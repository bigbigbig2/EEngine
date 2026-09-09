# OEngine 架构

## 当前实现

公开入口由 `OEngine/src/index.ts` 控制。生产依赖大体沿 `core → runtime assets/loaders → gpu → framegraph/render → public interface` 流动；内部 Pass、GPU 表和 Shader ABI 默认不公开。

`OEngine/src/render/Renderer.ts` 仍是大型 composition root，拥有设备初始化、FramePlan、主 FrameGraph、Feature/Service 装配、采样证据和生命周期收尾。这是当前主要架构债务，不是继续吸收算法实现的理由。

## 依赖方向

```text
Source asset
  → validated Runtime Asset package
  → GpuAssetStore / GpuScene / GpuPackedSceneRegistry
  → FramePlan + FrameGraph
  → Visibility / Surface / Lighting / Transparency / Temporal / Post
  → present and asynchronous evidence
```

CPU 负责资产导入、显式 patch、帧配置和命令编排；最终可见工作必须由 GPU 队列直接供 GPU consumer 使用，不能回读后由 CPU 重建 draw list。

## 模块与 Owner

| 边界 | 当前 owner | 责任 |
| --- | --- | --- |
| Runtime Asset | `src/assets/GeometryAssetPackage.ts`、loaders | 验证、recipe、稳定记录 |
| GPU 资产 | `src/gpu/GpuAssetStore.ts` | geometry/material/texture residency |
| 场景实例 | `src/gpu/GpuScene.ts` | instance 数据和显式 patch |
| Packed 场景 | `src/gpu/GpuPackedSceneRegistry.ts` | Packed runtime 生命周期 |
| 场景环境 | `src/gpu/GPUSceneEnvironmentContext.ts` | Packed/普通 Scene 共享的 light、environment、light-probe 与 volumetric 数据 |
| Legacy geometry | `src/gpu/GPUSceneContext.ts` | 仅普通 Scene consumer 使用的 SceneDatabase、TLAS、animation 与 skinning 临时 owner |
| GPU 工作 | `src/gpu/GpuWorkGenerationAbi.ts` 及 work-generation owners | 队列 ABI、容量、overflow、indirect args |
| 可见像素身份 | `src/gpu/GpuVisibilityKeyAbi.ts`、Visibility owners | key ABI、sentinel、reverse-Z、diagnostics |
| Surface ABI | `src/gpu/GpuSurfaceAbi.ts` | attachment 格式、编码和版本 |
| Surface 组合 | `src/render/features/SurfaceFeature.ts` | backend 选择、Surface/velocity 产品生命周期 |
| 帧资源 | `src/framegraph/FrameGraph.ts` | 资源、依赖、pruning 和执行 |
| 跨图调度 | `src/render/pipeline/FramePlan.ts` | scene/LPV/shadow/main-view 顺序 |
| 跨 Pass 产品 | `src/render/pipeline/FrameProducts.ts` | Surface、lighting、AO、reflection、temporal 合同 |
| 阴影功能 | `src/render/features/ShadowFeature.ts`、`ShadowFeatureManager.ts` | Scene-scoped atlas、cascade/cache、Packed/legacy caster adapter、work generation、raster 与 retire |
| 功能组合 | `src/render/features/*.ts` | Feature/Service 生命周期与 feature-off |
| 实时证据 UI | `src/addons/inspector` | 有界历史、view-model、实时面板 |
| 总装 | `src/render/Renderer.ts` | 单帧 composition 和提交 |

## 生命周期与资源所有权

Runtime Asset 是设备无关事实；GPU owner 由设备和 Renderer 生命周期控制。资源释放必须经过提交边界，不能让 Loader、Scene 临时对象或 FrameGraph 外部引用隐式延长 GPU 对象寿命。持久 history、shadow atlas、LPV 和 asset residency 与 transient frame attachment 分开统计。

Performance Inspector 只消费 Renderer/GPU owner 产生的 `ProfileFrame` 证据。它不成为渲染 owner，也不从 DOM 或推测值重建指标；详细合同位于 `OEngine/src/addons/inspector/README.md`。

## 公开接口

`src/index.ts` 是唯一公开 interface。新增内部 Feature、Pass、Shader、Profiler codec 或 ABI 不应自动导出；只有稳定且被外部调用方需要的能力才进入入口。

## 当前帧输入边界

Renderer 在取得场景环境后、创建 geometry owner 前先查询 Packed registry。帧绑定只发布一种互斥 geometry source：Packed runtime，或普通 Scene 的 legacy `GPUSceneContext`。Packed 帧只执行共享 light/environment 同步和 `GpuPackedSceneRegistry` 的显式 patch，不创建或更新 legacy SceneDatabase、geometry table、skinning 或 MeshletDrawList；`GPUViewContext` 只依赖 camera/view/HZB 与共享场景环境。

Packed 路径已经输出 `VisibilityKey`、统一 Surface 和 velocity。普通 Scene 仍保留 legacy Material Expand、独立 Velocity 和旧 OIT consumer；Renderer 仍存在显式 Packed/legacy geometry 选路。AO、SSR 与 GI 已由 Service 组合；Shadow atlas、cascade/cache、work generation、raster 和 retire 已归 `src/render/features/ShadowFeature.ts` 单一所有。`GPULightCollection` 只拥有稳定 light database 与 environment 纹理，不再 import 或构造 Render Pass、`GPUViewContext` 或 `GPUCameraState`。

## 目标差距

- Packed Render World 的固定收敛顺序、owner 删除条件和逐步验证见 [ADR-0006](./adr/0006-packed-render-world-convergence.md)。
- 把 Renderer 缩成 composition shell，资源和路径选择下沉到稳定 Feature/Service。
- 移除普通 Scene 的最终 legacy consumer，使统一 Surface/Velocity/Transparency 成为唯一生产合同。
- 以真实多资产 Packed Instances、hierarchy/SSE 和固定目标设备证明 GPU 闭环。
- 关闭仍为 unknown 的 oracle/generated Shader ownership 风险。
- 用同条件 GPU timestamp、counter、memory 和 feature-off 证据证明统一主管线。
