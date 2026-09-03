# P0 · 源码映射与删除清单

> 状态：**P0 盘点设计，尚未执行删除**
> 所属设计：[产品级渲染管线重构](./13-product-render-pipeline-redesign.md)
> 对应决策：[ADR-0012](../wiki/adr/0012-product-render-pipeline-redesign.md)

本文是 P0 的执行入口。它只冻结目标归属和删除候选，不提前宣称实现完成，也不在 P0 修改渲染代码。

## 1. P0 结果

P0 必须完成：

1. 目标 Feature 与现有源码 owner 的映射；
2. 每个旧 Pass、shader、资源表和调试入口的处理结论；
3. 与现有 ADR/实施文档的冲突和替代关系；
4. P1 开始前必须删除或重写的明确候选；
5. 需要通过源码引用搜索确认的未知项。

处理状态仅使用：

```text
保留      继续作为目标主链基础
迁移      原位改造并归属新 Feature
重写      保留产品职责，替换算法/组合/资源合同
删除      无目标 consumer，直接移除
待确认    需要源码引用或运行证据后决定
```

## 2. 目标模块 owner

| 目标模块 | 目标职责 | 现有主要入口 | P0 结论 |
|---|---|---|---|
| FrameCoordinator | 一帧状态、View、Graph、统一提交 | `render/Renderer.ts`, `render/FrameCoordinator.ts` | 重写编排 owner |
| FrameGraph | 依赖、资源生命周期、Pass 剔除、计时 | `framegraph/*` | 保留并扩展 Feature contract |
| ViewContext | 主视图和辅助视图状态隔离 | `render/ViewContext.ts`, `ViewManager.ts` | 迁移为统一 View owner |
| GPU Scene | 静态驻留、动态 Patch、实例和灯光数据 | `gpu/GpuScene.ts`, `GpuPackedSceneRegistry.ts`, `GpuAssetStore.ts` | 保留，清理重复 owner |
| Visibility Feature | GPU cull/LOD/work、Hardware Visibility | `render/passes/PackedVisibilityPass.ts`, `VisibilityPass.ts`, `HierarchicalWorkGenerator.ts` | 迁移；Hardware-first |
| Surface Feature | VisibilityKey 到 PBR Surface 的唯一解析 | `PackedMaterialResolvePass.ts`, `VisiblePixelClassifier.ts` | 重写并删除旧 Expand |
| Lighting Feature | HDR 直接光照和组合 | `pipeline/OpaqueLightingPipeline.ts`, `LightingPass.ts` | 重写组合边界 |
| Clustered Lighting | GPU Cluster/Froxel 灯光列表 | `LightClusterPass.ts`, `ClusteredLightingReference.ts` | 迁移为 Service |
| Shadow Service | CSM、Point/Spot Atlas、软阴影、Contact | `PackedCsmShadowPass.ts`, `ShadowRasterPass.ts`, `gpu/Shadow*` | 重写为统一 Service |
| GI Service | Lightmap、Probe Volume、IBL diffuse fallback | `Brick4IndirectPass.ts`, `LpvIndirectDiffusePass.ts`, `gpu/LightProbe*` | 重写 Provider 组合 |
| Reflection Service | Local Probe、SSSR correction、IBL fallback | `ScreenSpaceReflectionsPass.ts`, `IblSpecularPass.ts`, `SpecularCorrectionPass.ts` | 重写顺序和历史边界 |
| AO Service | GTAO 与独立 AO 通道 | `ScreenSpaceAmbientOcclusionPass.ts`, `shaders/ssao.ts` | 重写并拆分 Material AO |
| Transparency Feature | Alpha Blend / OIT | `PackedTransparentOitPass.ts`, `TransparentOitPass.ts` | 迁移，隔离 Opaque |
| Temporal Feature | TAAU、DRS、History、Reactive | `TemporalAntiAliasingPass.ts`, `TemporalClassificationPass.ts`, `DynamicResolutionScaling.ts`, `TemporalHistoryRegistry.ts` | 重写为独立子系统 |
| Post Feature | Exposure、Bloom、Color、Tone Mapping、Present | `AutomaticExposurePass.ts`, `BloomPass.ts`, `TonemapPass.ts`, `SharpenPass.ts` | 迁移并统一颜色域 |
| Observability | Debug View、timestamp、counter、artifact | `RenderDebugViewPass.ts`, `GPUPerformanceTimer.ts`, `GPUStatisticsHistory.ts` | 保留并扩展 Feature 维度 |

## 3. 现有源码处理矩阵

### 3.1 主编排与 FrameGraph

| 路径 | 处理 | 原因 |
|---|---|---|
| `OEngine/src/render/Renderer.ts` | 重写为薄 orchestrator，删除手工效果组合 | 当前集中持有过多 Graph、资源、效果顺序和提交逻辑 |
| `OEngine/src/render/MainFrameFeatureTopology.ts` | 迁移为目标 Feature 注册和依赖入口 | 作为新拓扑 owner 候选，不再让 Renderer 直接拼所有 Pass |
| `OEngine/src/render/pipeline/FramePlan.ts` | 迁移为 FrameContext/Products 合同 | 避免每个效果定义自己的 frame 产品 |
| `OEngine/src/render/pipeline/FrameProducts.ts` | 保留并扩展资源域和跨 Feature 产品 | 统一 Surface、HDR、History、Debug 产品 |
| `OEngine/src/render/pipeline/OpaqueLightingPipeline.ts` | 重写为 Lighting Feature 内部实现 | 当前 Indirect/Lighting 组合需要按统一 HDR 合同重排 |
| `OEngine/src/framegraph/*` | 保留核心，删除重复资源/提交封装 | FrameGraph 是唯一执行编排层 |

### 3.2 GPU Scene 与 Visibility

| 路径 | 处理 | 原因 |
|---|---|---|
| `gpu/GpuScene.ts`、`GPUSceneManager.ts`、`GPUSceneContext.ts` | 保留并统一 owner | GPU Scene 是长期渲染数据真相 |
| `gpu/GpuPackedSceneRegistry.ts`、`GpuAssetStore.ts` | 保留并确认 Runtime/GPU 分离 | 继续作为 Packed 资产和资源表入口 |
| `render/HierarchicalWorkGenerator.ts` | 保留目标算法，归属 Visibility Feature | GPU producer 必须直接连接 Hardware consumer |
| `render/passes/PackedVisibilityPass.ts` | 迁移并重命名归属，不建立 V2 | 保留 Hardware-first Visibility ABI |
| `render/passes/VisibilityPass.ts` | 待引用确认后迁移或删除 | 可能是 legacy Scene consumer，不能凭类名判断 |
| `render/HierarchicalZBuffer.ts`、`HzbHistory.ts` | 迁移为 Visibility/HZB 子模块 | HZB 只由真实消费者保留 |
| `render/passes/VisibilityCounterPass.ts`、`PackedSurfaceCounterPass.ts` | 保留并统一统计接口 | 作为 GPU-driven 和 Surface Gate 证据 |
| `render/passes/RenderDebugViewPass.ts` | 保留并扩展 | Debug 视图是完成条件，不是临时工具 |

### 3.3 Surface 与材质

| 路径 | 处理 | 原因 |
|---|---|---|
| `render/passes/PackedMaterialResolvePass.ts` | 重写为唯一 Surface Feature | 统一 VisibilityKey、Material、Texture、Velocity 和 Surface 输出 |
| `render/VisiblePixelClassifier.ts` | 迁移为 Resolve 内部分类阶段 | 不允许恢复每材质全屏扫描 |
| `render/passes/MaterialExpandPass.ts` | 删除 | 与 Single Material Resolve 和硬切换策略冲突 |
| `shaders/material_expand.ts`、`material_sr.ts` | 已删除（P9 硬切换） | 无 runtime owner 的旧 Material Expand / Surface Resolve 分支 |
| `shaders/material_expand_oracle.ts` | 保留 | 由 `GPUMaterialContext.ts` 消费，为当前 Material Expand 运行源，删除并入后续 authored 迁移 |
| `shaders/mesh_instance_cull.ts`、`meshlet_expand_counts.ts`、`meshlet_expand.ts` | 已删除（P9 硬切换） | 无 runtime owner 的旧 Visibility work-generation 分支；`mesh_instance_cull_dual.ts` 仍在运行 |
| `shaders/packed_material_resolve.ts` | 重写并保留为 Surface 生产 shader | 以目标 Surface ABI 为准 |
| `gpu/GpuSurfaceAbi.ts`、`GpuMaterial*`、`GpuVisibilityKeyAbi.ts` | 保留并按 ADR-0011 校准 | ABI 是 P3 前置合同，不在 P0 改数值 |

### 3.4 Lighting、Shadow、GI、Reflection、AO

| 路径 | 处理 | 原因 |
|---|---|---|
| `render/passes/LightClusterPass.ts` | 迁移为 Clustered Lighting Service | GPU 灯光列表统一入口 |
| `render/passes/LightingPass.ts` | 重写 | 直接光照必须消费统一 Surface、Cluster 和 Shadow |
| `render/passes/PackedCsmShadowPass.ts`、`ShadowRasterPass.ts` | 重写为 Shadow Service backend | 统一 CSM、Atlas、Contact 和软阴影 |
| `gpu/ShadowContext.ts`、`ShadowAtlas.ts` | 保留并收拢 owner | 阴影资源跨视图/跨帧管理 |
| `render/passes/Brick4IndirectPass.ts`、`LpvIndirectDiffusePass.ts` | 重写为 GI Providers | 统一 Lightmap/Probe/IBL fallback，不保留旧复合顺序 |
| `gpu/LightProbe*`、`GPULightProbeVolume.ts` | 保留并改为 GI Service owner | 离线基础数据与运行时局部更新分离 |
| `render/passes/IblDiffusePass.ts`、`IblSpecularPass.ts` | 迁移为 GI/Reflection Provider | 不在 Renderer 中直接拼 IBL |
| `render/passes/IndirectCompositePass.ts` | 删除或拆入 Lighting Composition | 禁止最终颜色阶段的重复硬乘/覆盖 |
| `render/passes/ScreenSpaceReflectionsPass.ts` | 重写为 Reflection Provider | 读取完整 Scene Radiance，输出 hit/confidence 和 correction |
| `render/passes/SpecularCorrectionPass.ts` | 合并进 Reflection Service | 统一 Probe/SSSR/IBL 组合，不重复 final composite |
| `render/passes/ScreenSpaceAmbientOcclusionPass.ts` | 重写为 AO Service | Material AO、Diffuse、Specular、Bent Normal 独立 |
| `shaders/ssao.ts`、`ssr_*`、`ibl_*`、`lighting_*` | 按新 Service owner 完整迁移/重写 | 每个 shader 必须有真实 consumer 和 reference ledger |

### 3.5 Transparency、Temporal、Post

| 路径 | 处理 | 原因 |
|---|---|---|
| `render/passes/PackedTransparentOitPass.ts`、`TransparentOitPass.ts` | 迁移为 Transparency Feature | 独立 Forward/OIT，复用统一光照服务 |
| `shaders/transparent_oit.ts`、`packed_transparent_oit.ts` | 迁移并统一 Reactive/Velocity 输出 | 透明不能污染 Opaque History |
| `render/passes/TemporalAntiAliasingPass.ts` | 重写为 Temporal Reconstruction | 默认 TAAU，内部隔离多类历史 |
| `render/passes/TemporalClassificationPass.ts` | 迁移为 Temporal 输入分类 | Reactive、Disocclusion、History Reset 的唯一入口 |
| `render/TemporalHistoryRegistry.ts`、`TemporalResolveContract.ts` | 保留并扩展 | History 所有权归 Temporal Service |
| `render/DynamicResolutionScaling.ts` | 迁移为初始化配置驱动的 DRS | 删除运行时自动 Governor 语义 |
| `shaders/taa.ts`、`temporal_post_legacy.generated.ts` | 重写/删除 legacy | 不允许旧 Temporal composite 残留 |
| `render/passes/AutomaticExposurePass.ts`、`BloomPass.ts`、`TonemapPass.ts` | 迁移为 Post Feature | 统一线性 HDR 和最终输出颜色域 |
| `render/passes/MotionBlurPass.ts` | 保留可选扩展，默认关闭 | 不让 Motion Blur 承担 TAA 修复职责 |
| `shaders/tonemap_*`、`bloom.ts`、`automatic_exposure.ts` | 迁移并统一颜色域 | 删除中间 LDR/gamma 重复转换 |

### 3.6 辅助、扩展和非当前产品路径

| 路径 | 处理 | 原因 |
|---|---|---|
| `render/passes/EnvironmentBackgroundPass.ts` | 迁移到 Lighting/Post 的 Environment Feature | 背景必须参与完整 Scene Radiance 和最终 HDR 输出 |
| `render/passes/OcclusionConfidencePass.ts` | 迁移为 AO/SSR/Temporal 共享输入 Feature | 置信度是历史和 fallback 的输入，不能由某个效果私有持有 |
| `render/passes/VelocityPass.ts` | 迁移到 Surface/Temporal 输入 | 运动矢量属于 Surface Contract，不应在后段重复生成 |
| `render/passes/VisibilityCounterPass.ts`、`PackedSurfaceCounterPass.ts` | 保留并归属 Observability | 作为 GPU-driven/Surface Gate 证据，不参与产品颜色 |
| `render/passes/RenderDebugViewPass.ts` | 保留并改为统一 Debug Feature | Debug View 必须观察真实 Graph 产品，不改变生产输出 |
| `render/passes/MotionBlurPass.ts` | 保留为可选 Post 扩展，默认关闭 | 当前不属于 TAA 修复路径 |
| `render/passes/SharpenPass.ts` | 保留为可选 Post 扩展，默认不强制 | 不与 Temporal、DRS 形成隐式依赖 |
| `render/passes/NeuralSuperSamplingPass.ts` | 移出当前默认主链，待后续 Temporal Provider 决定 | 本轮默认是 TAAU + DRS，不提前集成神经超分 |
| `render/passes/PathTracer.ts` | 移出当前产品主链，保留为独立研究/验证入口或删除 | 路径追踪不是当前标准 WebGPU baseline，不得隐式参与 Renderer |

### 3.7 Shader 目录归属

| Shader 类别 | 目标 owner | 处理 |
|---|---|---|
| `visibility_*`、`hierarchical_*`、`meshlet_*`、`exact_triangle_filter.ts` | Visibility Feature | 保留已接受 ABI，完整移植/校准，不另建 V2 |
| `packed_material_resolve.ts`、`visible_pixel_classification.ts`、`material_bucket_wgsl.ts` | Surface Feature | 唯一生产 Surface Resolve 来源 |
| `material_expand.ts`、`material_expand_oracle.ts` | Legacy/Oracle | 生产 consumer 迁移后删除；oracle 只有在无新测试 owner 时才删除 |
| `light_cluster.ts`、`lighting_direct.ts` | Clustered Lighting / Lighting Feature | 统一 HDR 直接光照 |
| `packed_csm_shadow.ts`、`shadow_raster.ts` | Shadow Service | CSM/Atlas/Contact 的 backend |
| `environment_ibl.ts`、`ibl_specular.ts`、`indirect_composite.ts`、`brick4_indirect.ts`、`lpv_*`、`probe_*` | GI/Reflection Service | 按 Provider 归属，删除重复 composite 和 legacy generated owner |
| `ssr_*`、`specular_correction.ts` | Reflection Service | 完整移植/重写 composition、confidence、fallback 和 history |
| `ssao.ts`、`occlusion_confidence.ts` | AO/Temporal 输入 | 拆分 Material AO、Diffuse/Specular Visibility、Bent Normal |
| `taa.ts`、`temporal_classification.ts`、`temporal_post_legacy.generated.ts` | Temporal Feature | legacy temporal consumer 迁移后删除重复路径 |
| `transparent_oit.ts`、`packed_transparent_oit.ts` | Transparency Feature | 保留 OIT ABI，接入 Reactive/Velocity |
| `automatic_exposure.ts`、`bloom.ts`、`tonemap_*`、`sharpen.ts` | Post Feature | 统一线性 HDR 到输出颜色域 |
| `path_tracer.ts`、`ray_query.ts`、`nss.ts` | Future/Research | 不进入当前默认主链，必须有独立 owner 或删除 |

## 4. P0 删除候选清单

以下是明确的候选，不代表 P0 立即删除；实际删除在对应阶段完成并通过引用检查：

- `MaterialExpandPass` 及其真实生产 shader consumer；
- 每材质全屏 Material Expand、旧 auxiliary MRT 和重复 Velocity 链；
- GTAO 写回 `Material AO` 的 composite；
- SSR 读取不完整 Scene Radiance 的旧组合和重复 final composite；
- 旧 TAA/Temporal Post composite、无 owner 的 History 资源；
- Renderer 内手工 Pass 顺序、重复资源创建和独立 submit；
- 旧 Lighting/IBL/Indirect composite consumer；
- 不再被 Feature 引用的 Visibility/HZB、shader、generated owner、调试和配置；
- 只服务 legacy Scene consumer、且无法映射到 GPU Scene 主链的重复 Geometry/Material owner。

P0 不允许删除的基础合同：

- `GpuVisibilityKeyAbi`、`GpuSurfaceAbi`、`GpuWorkGenerationAbi` 等已接受 ABI；
- GPU Scene、Packed Instance、Hierarchy/SSE、Hardware Visibility producer/consumer；
- FrameGraph 的核心资源依赖、compiled cache 和 GPU timer；
- 真实生产路径仍在使用的 Shadow、Probe、Cluster、OIT 和 History 资源。

## 5. 需要在 P0 完成的源码检查

执行 P1 前必须运行并保存结果：

```text
rg "MaterialExpandPass|MaterialExpand|material_expand" OEngine/src
rg "ScreenSpaceAmbientOcclusion|ssao|GTAO" OEngine/src
rg "ScreenSpaceReflections|ssr_|SSR" OEngine/src
rg "TemporalAntiAliasing|TemporalClassification|taa|TemporalHistory" OEngine/src
rg "IndirectComposite|IblDiffuse|IblSpecular|LightingPass" OEngine/src
rg "VisibilityPass|PackedVisibilityPass|HierarchicalWorkGenerator" OEngine/src
rg "drawIndirect|dispatchWorkgroups|submit\(" OEngine/src/render OEngine/src/framegraph
```

每个结果需要标注：生产 consumer、测试/oracle consumer、调试 consumer、生成来源或 dead code。只被测试或 oracle 使用的实现不能直接当作生产路径删除理由，但必须与产品 owner 分离。

## 6. P0 退出 Gate

- [x] ADR-0012 已登记并明确替代关系；
- [x] 目标 Feature owner 和当前源码入口完成映射；
- [x] Renderer、FrameGraph、GPU Scene、Visibility、Surface、Lighting、Secondary、Temporal、Post 的 owner 唯一；
- [x] 删除候选有源码引用证据和后续阶段归属；
- [ ] 未发现未归属的真实生产 consumer（P1 开始前继续做全仓库引用确认）；
- [x] 未修改渲染实现，不提前宣称 P1 或任意效果已完成；
- [x] P1 的第一批任务可以直接按映射表开始，不需要再讨论是否建立过渡管线。

## 7. 盘点结果（2026-09-03）

已在 `OEngine/src` 上执行模式引用盘点。结果用于确认删除范围，不代表这些路径都属于最终生产 consumer：

| 检查主题 | 命中文件 | 命中行数 | 关键事实 |
|---|---:|---:|---|
| MaterialExpand / material_expand | 31 | 54 | `MaterialExpandPass.ts` 仍被多个 Lighting、IBL、AO、SSR、Temporal、Post 和透明 Pass 引用；必须先迁移公共资源解析 helper，再删除类和 shader |
| AO / GTAO | 6 | 141 | `Renderer.ts`、`MainFrameFeatureTopology.ts`、`RenderSettings.ts` 仍直接持有 SSAO 拓扑与 History；AO Service 需要接管这些 owner |
| SSR | 13 | 262 | `ScreenSpaceReflectionsPass.ts`、`SpecularCorrectionPass.ts`、SSR shaders 和 Renderer 共同持有生产链与 debug 入口 |
| Temporal | 12 | 138 | `TemporalAntiAliasingPass.ts`、`TemporalClassificationPass.ts`、History Registry、DRS 和 Renderer 共同持有时域状态 |
| Lighting / IBL / Indirect | 6 | 51 | `OpaqueLightingPipeline.ts` 仍组合 IBL/Indirect Composite；需要在 P4/P5 拆入 Lighting、GI、Reflection Service |
| Visibility | 10 | 39 | Renderer 同时持有 `VisibilityPass` 和 `PackedVisibilityPass`；P3 必须先确认 legacy Scene consumer，再硬切换删除 |
| draw/dispatch/submit | 43 | 149 | GPU 工作生成、Indirect Draw、光照、阴影、透明、后处理均已存在；P1 需要确认统一 Graph/Submit owner |

关键 Renderer 事实：

- `Renderer.ts` 同时 import/持有 `VisibilityPass`、`PackedVisibilityPass`、`MaterialExpandPass`、`LightClusterPass`、`OpaqueLightingPipeline`、`PackedTransparentOitPass`、SSAO、SSR 和 Temporal Pass；
- `Renderer.ts:1742` 仍存在 `packedResolveOut ?? obtainLegacyMaterialExpand().addToGraph(...)` 的 legacy fallback；
- `Renderer.ts:3215` 仍提供 `obtainLegacyMaterialExpand()`，这是 P3 的明确删除目标；
- `MainFrameFeatureTopology.ts` 仍包含 `ssaoTemporal` 和 `ssaoHalfResolution` 拓扑位，需在 P2/P5 迁移为初始化配置和 AO Service 参数；
- `FrameGraph`、`HierarchicalWorkGenerator`、`ExactTriangleFilter` 已有 GPU dispatch/indirect 基础，P1/P3 应迁移 owner，不应重写已接受的 GPU ABI。

这些结果确认：P0 的主要风险不是缺少 Pass，而是 `Renderer.ts` 的集中编排、MaterialExpand 公共依赖和 legacy/packed 双入口。P1 必须先建立新 owner，P3–P8 再按矩阵删除旧 consumer。
