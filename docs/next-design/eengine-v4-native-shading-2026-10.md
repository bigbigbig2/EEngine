---
id: eengine-v4-native-shading-2026-10
state: current
verifies:
  files:
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program/FrameProgram.ts
    - OEngine/src/render/program/FrameProgramBindings.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/material/AppearanceGraphCompiler.ts
    - OEngine/src/shaders/native_material.ts
    - OEngine/src/gpu/AppearanceProgramRegistry.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/GpuNativeMaterialPublication.ts
    - OEngine/src/gpu/NativeMaterialBindings.ts
    - OEngine/src/gpu/NativeMaterialProducts.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/render/surface/SurfaceV4.ts
    - OEngine/src/render/temporal/NativeTemporalSeed.ts
    - OEngine/src/gpu/GpuRenderWorld.ts
    - OEngine/src/gpu/GraphicsContext.ts
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/gpu/GpuVisibilityKeyAbi.ts
    - OEngine/src/render/passes/PackedVisibilityPass.ts
    - OEngine/src/render/FrameGeometryArena.ts
    - OEngine/src/render/surface/NativeExecutionBins.ts
    - OEngine/src/render/surface/NativeVisibilityPass.ts
    - OEngine/src/render/surface/NativeRasterWorkPartitions.ts
    - OEngine/src/render/vsm/VsmAtlasRasterPass.ts
    - OEngine/src/render/passes/fsr3/Fsr3UpscalerRuntime.ts
    - OEngine/src/framegraph/FrameGraph.ts
    - OEngine/src/framegraph/ShadeGPUCommandContext.ts
    - OEngine/src/gpu/GeometryProductMultiRuntime.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/src/gpu/GeometryProductResidencyProfile.ts
    - OEngine/src/gpu/GeometryProductGpuAbiV1.ts
    - OEngine/src/gpu/GeometryPageStreamingRuntime.ts
    - OEngine/src/assets/geometry-product/VirtualGeometrySceneSourceV1.ts
    - OEngine/src/render/HierarchicalWorkGenerator.ts
    - OEngine/src/render/MeshletWorkCandidate.ts
    - OEngine/src/shaders/frame_geometry_vertices.ts
    - OEngine/src/shaders/surface_geometry_completion.ts
    - OEngine/tools/oengine-asset-core/src/geometry/GeometryCooker.cpp
---

# EEngine V4：Native Shading 全局架构不变量

本文只定义跨模块持续有效的架构约束。总体粗路线由 [workstream.roadmap](../../project/workstreams/active/eengine-next-clean-rebuild.yaml) 导航，当前模块唯一设计/执行由其中的 authority/currentSlice 导航；真实实现以源码和直接消费者为准，已实现事实见 [domains](../domains/README.md)。本文不维护施工顺序、模块状态或待实现算法。

2026-10-14 起按用户方向先完善功能效果，再集中优化完整组合。V5 已落地实现继续使用，未完成的性能资格保留责任；不以旧性能计划先通过作为 AO、VT 等新功能的统一前置。长期目标仍为 GPU-Driven、WebGPU Native、AAA 画面与可持续扩展，GTX 1650 Ti 4GB / 1080p 是首要约束之一。

## 1. 唯一生产路径与职责

```text
Scene / asset publication / native programs
  → Geometry / VG residency + view and shadow work
  → Visibility winner + Depth + recoverable geometry sources
  → native material / direct lighting / VSM / IBL / AO
  → pre-exposed HDR + products demanded by real consumers
  → effect composition / Sky / Aerial
  → Temporal / Upscaling / Radiometry / Post / Presentation
```

这是职责顺序，不是固定 pass 数量，也不表示未来效果已接入。正常正确路径为 full-rate native opaque shading；产品仅因真实跨 pass consumer、能力限制或明确成本理由而物化，默认 fused opaque，不建立通用 SurfaceRecord。

| Owner | 长期职责与边界 |
|---|---|
| Geometry / VG | LOD/SSE/HZB、完整工作生成、源数据恢复、几何页驻留、独立 shadow 工作；不由 Surface cache 补偿过度几何工作 |
| Visibility | Depth 与 opaque winner，包含 alpha-tested coverage、完整 slot/generation/lifetime context；后续不能再擦除已抢走后方 winner 的错误 coverage |
| Material compiler / registry / publication | 图语义与 native code；异步 PSO/lease/device epoch；实例参数、资源路由和原子发布分别拥有明确责任 |
| Native shading / bins | 真实输入绑定、执行及 HDR/必要产品的完整写域；bins 只拥有自己的瞬态 count/index/indirect 数据 |
| Effect owners | AO、VT、VSM、Reflection、GI、ReSTIR、Temporal 等分别拥有实际算法、资源、cache/history 和生命周期；Surface 不集中接管 |
| Renderer / FrameProgram / FrameGraph | Renderer 是 composition root；FrameProgram 表达有限产品和阶段；FrameGraph 管宏依赖、寿命与编码，不管 shader 内部微调度 |

每帧沿现有提交 owner 提交；不为效果增加独立 frame submit，不引入本帧 GPU→CPU→GPU visible/work control。GPU 反馈可以延迟消费，不能伪装为同帧 CPU 工作决策。

## 2. Native 材质与 GPU 工作组织

Material Graph 经验证的 typed IR、CSE/DCE、依赖分析生成 native GPU code；Standard、Unlit、Clearcoat 与合法 custom graph 不回退 General VM。保留 UV/transform、normal、decode、sampler、minimum resident mip 及 coverage 语义。

compute shading 使用重建的连续 C/X/Y 与显式梯度或等价显式 LOD；不能对 compact list 相邻 lane 求屏幕导数。嵌套或非线性坐标依赖要完整传播，主可见性与 VSM alpha 消费同一材质语义。

区分实例、unique Program、Pipeline 与 ExecutionBin。参数值、texture layer 和实例数量不直接制造 ProgramKey；图拓扑、采样语义、真实 layout/profile/specialization 才进入相应 key。CPU 编码命令可随已发布 unique execution bins 增长，不能与材质实例数同比增长；GPU 决定实际工作数量，无本帧 readback。

依赖/频率分析不自动证明执行频率优化。昂贵 uniform 子图、额外 binning、低频更新或缓存只有真实 consumer、正确性与 Cost Card 支持才物化，不为减少 shader 数量引入高成本解释器或调度层。

## 3. 产品、画面语义与 WebGPU 能力

Depth、Visibility、HDR 是现有核心产品；跨 pass normal、roughness、response、motion 等由实际 consumer 反推，声明 producer、consumer、完整写域、invalid 编码和生命周期。没有 consumer 不分配、不清零、不写；effect 内临时值优先留在调用内部。

每个有效 opaque winner 只有一个对应 HDR writer，background 有独立完整写域；后续 composition 使用明确的图版本。Reflection/GI 必须指定与 specular/diffuse IBL 的替换或混合关系，ReSTIR 指定替换的直接光分量，不能重复叠加能量。透明与介质有独立排序/积分和合成职责，不冒充 opaque winner。

保留正确的 HDR、pre-exposure、normal/导数/LOD、coverage、motion 和重投影语义。fp16/packed storage 必须依据坐标系、值域、误差和独立画面验证；不截断身份或降低质量以满足预算。未来效果的时序输入随该效果闭合，不能留到最终调优才补。

创建资源前协商实际 adapter/device features、limits、formats、binding 与 dispatch 容量。不要假定桌面 WebGPU profile 等于所有浏览器设备；不照搬 bindless、ExecuteIndirect、mesh shader、固定 wave 宽度或持久轮询。超容量/overflow 必须有完整、可观察的处理，不能 clamp 丢工作。

能力要求确实迫使拆分时，可使用有限 compact deferred 或分阶段 composition；保留全部合法输入、writer 与 HDR 语义，并计入重算、资源读写、PSO/dispatch 成本。不把这种能力适配扩为默认通用 GBuffer，也不恢复旧渲染 owner。

## 4. 生命周期与退休

资源从准备、发布、提交/中止、重试、replacement、device loss 到最后 consumer fence 退休具有明确 owner。Loader 不拥有长期 GPU 资源；CPU 取消不替代 GPU fence，迟到 IO/map 不能写已释放或新 generation 的资源。

替换已有架构时先完整构建新 producer→产品→全部直接 consumers 及绑定/reset/capacity，再在一个架构单元原子切换并删除旧依赖。阶段内允许临时断链，稳定边界只留一套 production ownership；不保留旧/新 runtime selector、桥接 ABI、adapter 或 fallback VM。Git 与历史记录负责追溯。

退休的是表示和 owner，存活的 material numeric、导数/LOD、normal、coverage、HDR、motion、publication atomicity、abort/retry、device loss、唯一 writer 与 fence 语义迁移给新 owner。必需验证和失败分类统一见 [VALIDATION](../VALIDATION.md#validation-failure-contract)。

## 5. 成本与推进纪律

新增效果记录达到画面/能力目标所需的必要 ADD 和上界：新增/删除 bytes、ALU、samples、random/sequential access、atomics/barriers、dispatch/pipeline、working set，以及 ideal/expected/worst。模块连通后检查真实 GPU 接线、画面、资源和必要成本；不要求比关闭该效果更快。

为节省工作引入的优化候选另算 0/50/100% 收益与 break-even；理想条件都不赚钱则拒绝，零收益高税不放进常规 hot path。cache hit、预算有界、测试通过和理论峰值都不是性能改善证据。完整组合的画质、同条件帧时、加载长尾与 4GB 同时峰值在集成阶段集中资格验证，保留此前原失败与缺项。

复杂、高风险或硬件执行敏感的模块优先研究成熟开源的真实 hot path、数据流、完整必要阶段、布局与边界，再决定移植、改写或自主设计。简单 glue/helper 可直接实现，不为参考数量寻找 donor。实际引用记录 revision、license、文件/函数和本地映射；来源核对、独立 oracle、真实 production 消费齐备前不提升 adoption，来源采用也不证明本项目更快。来源记录见 [porting](../porting/next-renderer.md)。

一个完整单元闭合后集中验证并停在下一边界；大模块完成后依据实际代码重新设计下一模块。详细执行与验证步骤以根 [AGENTS](../../AGENTS.md)、[VALIDATION](../VALIDATION.md) 和当前模块执行计划为准，本文不再复制阶段表。

## 6. 历史资料的使用

原 M1/M2 源码快照、方案推演和未校准预算已从本文移到 [V4 原设计记录](../archive/eengine-v4-native-shading-design-record-2026-10.md)，实际实施与原失败保留在 [V4 执行记录](../next-execution/eengine-v4-native-shading-execution-2026-10.md)。这些材料供追溯，不是下一模块施工入口。

已完成或暂停的旧设计/执行标为 history；Texture Compression 保留独立 [设计](eengine-v4-texture-compression-2026-10.md) / [执行记录](../next-execution/eengine-v4-texture-compression-execution-2026-10.md) 作为现行纹理产品与压缩边界依据，它不是并行待执行路线。R3/R4 的 Surface C、General VM、六 signal、全局 closure cache/history/proof/store/reference 不再约束生产架构。
