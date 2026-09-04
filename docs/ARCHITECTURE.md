# OEngine 架构

## 当前实现

公开入口由 `OEngine/src/index.ts` 控制。生产依赖大体沿 `core → runtime assets/loaders → gpu → framegraph/render → public interface` 流动；内部 Pass、GPU 表和 Shader ABI 默认不公开。

`OEngine/src/render/Renderer.ts` 当前为 3853 行的大型 composition root。它拥有设备初始化、FramePlan、主 FrameGraph、Feature/Service 装配、采样证据和生命周期收尾；这是现状，不是目标形态。

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
| Runtime Asset | `src/geometry/GeometryAssetPackage.ts`、loaders | 验证、recipe、稳定记录 |
| GPU 资产 | `src/gpu/GpuAssetStore.ts` | geometry/material/texture residency |
| 场景实例 | `src/gpu/GpuScene.ts` | instance 数据和显式 patch |
| Packed 场景 | `src/gpu/GpuPackedSceneRegistry.ts` | Packed runtime 生命周期 |
| GPU 工作 | `src/gpu/GpuWorkGenerationAbi.ts` 及 work-generation owners | 队列 ABI、容量、overflow、indirect args |
| 帧资源 | `src/framegraph/FrameGraph.ts` | 资源、依赖、pruning 和执行 |
| 跨图调度 | `src/render/pipeline/FramePlan.ts` | scene/LPV/shadow/main-view 顺序 |
| 跨 Pass 产品 | `src/render/pipeline/FrameProducts.ts` | Surface、lighting、AO、reflection、temporal 合同 |
| 功能组合 | `src/render/features/*.ts` | Feature/Service 生命周期与 feature-off |
| 总装 | `src/render/Renderer.ts` | 单帧 composition 和提交 |

## 生命周期与资源所有权

Runtime Asset 是设备无关事实；GPU owner 由设备和 Renderer 生命周期控制。资源释放必须经过提交边界，不能让 Loader、Scene 临时对象或 FrameGraph 外部引用隐式延长 GPU 对象寿命。持久 history、shadow atlas、LPV 和 asset residency 与 transient frame attachment 分开统计。

## 公开接口

`src/index.ts` 是唯一公开 interface。新增内部 Feature、Pass、Shader 或 ABI 不应自动导出；只有稳定且被外部调用方需要的能力才进入入口。

## 当前双路径

Packed 路径已经输出 `VisibilityKey`、Surface 和 velocity，但普通 Scene 仍保留 legacy 路径。`Renderer.ts` 仍通过 `packedResolveOut ?? obtainLegacyMaterialExpand()` 选择材质解析；legacy 场景还使用 `MaterialExpandPass`、`VelocityPass` 和 `TransparentOitPass`。Packed transparency 则由 `PackedTransparentOitPass` 提供。AO、SSR 与 GI 已经由 `AOService`、`ReflectionService`、`GIService` 组合，但底层旧 owner 尚未全部消失。

## 目标差距

- 把 Renderer 缩成 composition shell，资源和路径选择下沉到稳定 Feature/Service。
- 移除最终 legacy consumer，使 Packed Surface/Velocity/Transparency 成为唯一生产路径。
- 以真实多资产 Packed Instances、hierarchy/SSE 和固定目标设备证明 GPU 闭环。
- 关闭四个仍为 unknown 的 oracle/generated shader ownership 风险。
- 用同条件 GPU timestamp、counter、memory 和 feature-off 证据证明统一主管线，而不是继续增加结构名。
