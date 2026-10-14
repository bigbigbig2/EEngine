---
id: eengine-feature-expansion-roadmap-2026-10
state: current
verifies:
  files:
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/index.ts
    - OEngine/src/render/RendererConfig.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program/FrameProgram.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/render/surface/SurfaceV4.ts
    - OEngine/src/render/ao
    - OEngine/src/shaders/xegtao_main.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/assets/TextureProduct.ts
    - OEngine/src/assets/PcMaterialTextures.ts
    - OEngine/src/assets/AssetLoadBatch.ts
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/gpu/NativeMaterialBindings.ts
    - OEngine/src/gpu/NativeMaterialPhysicalBanks.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/GeometryPageStreamingRuntime.ts
    - OEngine/src/render/features/VisibilityFeature.ts
    - OEngine/src/render/ShadowGeometryWork.ts
    - OEngine/src/render/lighting/LocalLightWorkGenerator.ts
    - OEngine/src/render/vsm
    - OEngine/src/render/environment/PhysicalEnvironmentRuntime.ts
    - OEngine/src/gpu/GpuAuthoredEnvironment.ts
    - OEngine/src/gpu/GPUSceneEnvironmentContext.ts
    - OEngine/src/shaders/ssr_trace.ts
    - OEngine/src/shaders/ssr_resolve.ts
    - OEngine/src/shaders/ssr_denoise.ts
    - OEngine/src/material/CanonicalMaterial.ts
    - OEngine/src/render/MomentOitReference.ts
    - OEngine/src/gpu/GPUVolumetrics.ts
    - OEngine/src/render/temporal/NativeTemporalSeed.ts
    - OEngine/src/render/temporal/NativeTemporalV2.ts
    - OEngine/src/render/passes/fsr3/Fsr3UpscalerRuntime.ts
    - OEngine/src/render/DynamicResolutionScaling.ts
    - OEngine/src/render/FrameCoordinator.ts
    - OEngine/src/debug/RenderDebugView.ts
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/resource-budget.ts
    - tools/gpu-oracle/registry.mjs
---

# EEngine 功能扩展总体路线

## 1. 本轮决策与范围

2026-10-14，用户明确将近期重心改为**先完善功能效果，再对完整组合集中优化性能**，并要求从实际代码重新分析、调整文档方向。本路线以生产源码 `2caf5fe2` 为输入；它是粗计划，不是 AO、VT、GI 等算法的详细设计，也不表示这些功能已实施。

当前模块设计以本文为准，详细单元状态仅在[执行计划](../next-execution/eengine-feature-expansion-execution-2026-10.md)维护；[workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml)只负责导航。沿用 [V4 母稿](eengine-v4-native-shading-2026-10.md)的单一 Renderer、Native 材质、真实 owner 与 GPU 数据流不变量。已完成/暂停的旧计划转为 history，原实施、失败和来源保留，旧阶段指令不继续生效。V5 已切换的实现保留，剩余正式验收延期；V5 Phase6 通过不再是开发新效果的前置。

目标仍包括 GPU-Driven、WebGPU Native、AAA 画面方向与 GTX1650Ti 4GB/1080p 约束。新增效果允许增加必要的 GPU 工作和内存；本轮不要求每个新效果相对“关闭该效果”更快，也不预先承诺全效果1080p原生60FPS。正确性、能力协商、容量、资源生命周期和必要成本边界仍随模块闭合，最终质量/性能资格集中取得。

本轮不改生产 TS/WGSL，不重写已完成底座，不提前固定所有未来算法、页尺寸、history 格式或性能阈值，不新建通用 SurfaceRecord、全局 effect history/cache 系统或万能虚拟资源管理器。

## 2. 从代码获得的设计输入

下表是本次代码核对快照，含生产调用和直接消费者，供路线决策；它不是持续进度表。文件存在、public export、旧注释、debug 枚举和历史测试都不能单独证明功能已接入。

| 能力 | 实际调用与产品 | 对后续的影响 |
|---|---|---|
| 主帧 | `RendererCore` 创建 owners，`FrameProgram` 选择有限产品，`FrameProgramLowering` 连到缓存 FrameGraph，`FrameCoordinator` 提交 | 扩展现有主图与真实 owner；不另造 feature scheduler。`RenderFeatureRegistry` 类没有进入这条生产选择链 |
| Geometry/VG | `VisibilityFeature.prepare` 准备主视图及独立 `ShadowGeometryWork`；Product 分页驻留、HZB、MeshletWork、Visibility/Depth 进入 Native | 保留工作身份、紧凑 Page 和独立 shadow 来源；新效果按需消费深度/HZB，不重写 VG |
| 纹理资产 | `TextureProduct` metadata3 每个 plane/mip 指向 chunk，`PcMaterialTextures` 冷准备 BC7/BC4/exact R8 | 已有压缩和资产身份基础；没有 tile directory，不能把现有整 mip 包直接称为 VT Page Product |
| 纹理驻留 | `TextureResidency.stage` 按完整尺寸、完整 mip 链创建 array segments；tail-first 上传、`promote` 改 minMip，最后一个 layer 释放后回收 segment | 渐进上传不减少该 texture 已分配容量。缺少按 tile 的 GPU page table、反馈、页读取和淘汰链 |
| 材质采样 | `NativeMaterialBindings` 生成有限 bank selector 与显式梯度采样，Main/MASK/VSM 使用对应 native publication；`NativeMaterialPhysicalBanks` 只规划完整资源并集 | VT 必须进入真实材质采样与 coverage consumers，保留 sampler、UV/C/X/Y、decode、最小驻留精度与 publication 语义 |
| AO | `FrameProgramLowering` 调用 preparation→main→denoise，Native 读取 scalarTexture；packed AO 没有实际 consumer 时可被 graph 裁掉 | 已有完整 scalar XeGTAO 链。当前主图固定 radiusMeters=1、metersPerWorldUnit=1、noiseIndex=0，只选择 scalar-high |
| AO 质量边界 | 深度生成的私有法线、五级加权深度、Main medium/high 源码、0..3 denoise 参数已存在；Native 只把 AO/material occlusion 乘入 diffuse IBL | 先补设置、调校与观测入口；AO 私有深度法线不等于材质法线。无 AO 专属时序积累、bent normal 或完整镜面遮蔽产品 |
| Lighting/VSM | LocalLightWork 的 NONE/SPARSE 与完整 DIRECT overflow；方向光 VSM 的需求、分配、caster、atlas、ready 产品进入 Native Sun | 保留当前直接光与阴影。点/聚光照明数据不表示对应阴影完成；新增阴影能力另定模块 |
| 环境/曝光 | PhysicalEnvironment 的 LUT/Sky/Aerial/IBL，以及 authored IBL、GpuRadiometry/Bloom/Present 已有真实 consumers | 保留现有 HDR/预曝光基础；Aerial 不等于局部参与介质/体积灯光 |
| SSR | 当前 `FrameProduct`/stage 没有 SSR；lowering 给 SSR debug 输入 null。旧 trace/resolve/denoise 依赖旧 packed PBR/normal、color pyramid 和旧 history 输入 | 旧文件只能逐项核对后复用数学；必须设计当前 Native 数据出口和正确的 IBL composition，不能直接恢复旧 effect owner |
| GI/探针/体积 | `GPUSceneEnvironmentContext` 可惰性创建 probe/Brick4/volumetrics 数据，但当前 Native/FrameProgram 没有相应 GI/介质消费链 | 有数据接口不等于有画面能力；未来选择实际辐射来源、更新方式和独立 effect history |
| 透明/透射 | CPU/GPU 有 transparent 分类；当前主图没有透明合成阶段；`CanonicalMaterial` 对 transmission>0 明确拒绝，MomentOitReference 只有参考计算 | 普通 BLEND、折射/透射、水面和 OIT 是需分别定范围的功能，不能以分类或参考函数当作完成 |
| Temporal/DRS | Native 1:1→V2，true upscale→FSR3，bypass 明确；Seed/identity/颜色 history 按成功提交推进。DRS 类没有接入 Renderer 控制链 | 保留两个各有实际分辨率域的重建 owner；新增效果管理自身 history。固定 renderScale 不算自适应 DRS |

核对入口：[主图](../../OEngine/src/render/program/FrameProgramLowering.ts)、[AO](../../OEngine/src/render/ao/XeGtaoPreparationPass.ts)、[纹理驻留](../../OEngine/src/gpu/TextureResidency.ts)、[采样生成](../../OEngine/src/gpu/NativeMaterialBindings.ts)、[场景可选数据](../../OEngine/src/gpu/GPUSceneEnvironmentContext.ts)。现有 domain 页记录生产事实；本路线不从历史设计快照推断当前调用。

## 3. 粗粒度推进顺序

默认顺序为 **AO 功能完善 → VT → Reflection → Indirect Lighting → Transparency → Media → 重建/显示策略完善 → 完整组合与性能优化**。这是产品推进顺序：AO 不依赖 VT，SSR 也不以 VT 为数学前置；若真实场景需求要求提前透明等模块，在模块边界调整。每次完成一个连贯模块，依据当时源码再设计下一个，不预先批量冻结后续实现。

### 3.1 AO：把已有算法完善成可用功能

先沿当前 scalar XeGTAO 增加设备无关的设置入口，明确世界尺度、半径、强度/曲线、现有质量与去噪选项，以及开关、AO-only/必要诊断视图。设置要真实进入 frame bindings、图/PSO 选择与 producer constants，不能只有面板变量。当前 finalValuePower 是曲线参数，不能直接改名声称是独立线性强度。

验证不同尺度场景、接触/薄物体/轮廓、相机运动、关闭与重开、resize/abort/retry；保留 Main/MASK/VSM 原语义。现有固定噪声与空间去噪的局限如实展示，不为“看起来更稳定”直接改变 noiseIndex。AO 专属 temporal、bent normal、镜面遮蔽是否进入下一单元，按画面需求和成熟来源另行研究；它们不是开放已有设置的必选前置。

### 3.2 VT：完整虚拟纹理能力

完整链为：CPU 压缩分页产品/页索引→有界页 provider→GPU 物理页与页表→Native 采样/coverage→有界反馈→延迟读取/上传→publication 与 fence 淘汰。先确定 TextureProduct 的继承/版本边界和 CPU 数据所有权，再确定物理 atlas、寻址、驻留与反馈。不得照用256KiB几何页 ABI，或把 GeometryPageScheduler 扩成所有资源的通用控制面；可借鉴其延迟反馈、取消与预算纪律，物理 owner 保持独立。

模块设计必须处理：BC block 对齐与 border、跨页/跨 mip 过滤、显式梯度与采样 footprint、repeat/mirror/clamp、normal/ORM/独立 exact alpha、粗 mip 完整覆盖、请求去重/溢出、上传/读取上限、内存与网络压力。Main Visibility、Native 材质、Shadow MASK、自定义 graph 等真实 consumers 必须同单元闭合。缺 alpha 页不能简单当作不透明而抢走后方 winner。

纹理内容身份、驻留状态与物理地址变化分开；不能每次 tile 上传都重新编译材质或全局清空 Temporal。资源创建/切换、abort/retry、replacement、device loss 重放和退休要完整。细页缺失的合法降级必须属于 VT 算法本身，不能长期缺细节却声称 full-quality。页大小、反馈频率、cache 策略与具体 donor 留到该模块详细设计裁决。

### 3.3 Reflection：接入当前 Native 的完整反射

先定义真实反射输入：Depth/HZB、材质法线/roughness、需要的 BRDF response、可采样辐射、motion/identity。当前 AO 私有法线和 Temporal Seed 不替代这些材质数据；已有 HZB 也要核对格式/深度数学及在新 demand 下是否真正生成。

以实际 consumer 反推有限产品与物理边界，允许必要的 compact Aux/lighting composition，不建立预分配的通用 GBuffer。当前 Native 已含 specular IBL，反射命中/未命中/置信混合必须避免重复添加能量，并覆盖 clearcoat、HDR/预曝光和退屏情况。trace、resolve、去噪、history、composition、debug、开关与退休作为完整模块；旧 shader 的来源/数学逐项复核，不恢复旧运行时 owner。

### 3.4 Indirect Lighting：先选一种能完整工作的方案

从目标场景选择第一种间接光能力，再研究成熟实现和真实生产入口。screen-space、probe/world-space、baked/radiance 数据是待比较方案，不在粗计划里宣称已经选定、实现或可以直接互换。确定可见域/退屏缺失、动态更新、材质响应、与 diffuse IBL 的替换/混合及 history 身份。

已有 probe/Brick4 数据只提供审查起点，不自动恢复旧 provider 链。ReSTIR 单独按目标照明需求判断，其 reservoir、候选、归一化和可见性不是泛用 GI 的默认前置；不为了功能名把所有间接算法一起加入生产。

### 3.5 Transparency / Media：按真实场景补齐表达能力

透明先确定完整 BLEND 的生产范围、工作生成、排序/混合、depth 与 opaque/sky/reflection 的合成顺序、motion/reactive；透射/折射、吸收和水面在明确需求后扩展。MomentOitReference 不构成 OIT 选型。不能把透明塞进 opaque winner，也不能仅取消 transmission 拒绝而没有正确 consumer。

Media 依据实际局部雾、参与介质和体积灯光需求，定义密度、光照/阴影、积分、透射率、history 与 HDR 合成。复用已存在的 Sky/Aerial、灯光与场景数据时明确各自物理意义，避免重复 extinction/scattering；GPUVolumetrics 表的存在不作为效果完成证据。

### 3.6 重建与显示策略、完整组合

当前 Native/FSR 的实际域和事务保留；新效果的 motion/reactivity、pre-exposure、disocclusion 在各自模块同步接入，不能推迟到最后才补正确性。后续专门完善 DRS 的实际反馈控制、配置与 resize/history 生命周期；AI Upscaling、DOF、motion blur 等按真实需求另选，不因旧类或 shader 存在自动列为已完成或必做。

功能组合稳定后集中进行整帧归因、共同资源/绑定压力、上传/驻留/retiring 同时峰值、冷启动和交互长尾、动态画质及4GB/1080p验收，再决定具体性能优化。优化按真实最大成本推进，不从文档预选 receiver、Temporal 或 cache 必须再优化。

## 4. 各模块共享的边界

- 新消费者才产生新产品；说明 producer、全部直接 consumers、格式/域/完整写域、唯一 writer、容量/溢出、提交/中止/重试和退休。输出何处进入最终 HDR 必须可追踪。
- Material Graph 继续编译为 Native GPU code；采样后端可以扩展，不引入通用 shader VM。FrameProgram/FrameGraph 管真实宏依赖，算法微调度留在效果 owner。
- Effect history/cache 归对应效果。TemporalFabric 协调已有提交事务，不吸收 AO/SSR/GI/Media 的全部物理历史。普通相机运动不被新功能随意改成全局 reset。
- 一帧一个生产 submit；延迟 feedback 影响后续帧，不引入本帧 GPU→CPU→GPU 工作控制。Loader 不拥有长期 GPU 页缓存。
- 当前 Renderer 是桌面 BC/tier1/indirect 等协商能力 profile，资源创建前明确 features/limits；不把 WebGPU 名称当所有设备均支持的保证，也不为扩功能偷偷增加第二套 Renderer。
- 应用预算和 owner 容量保持有界；Dungeon 现有4GB应用预算及demo不同 renderScale/geometry 配置是源码事实，不是 OS VRAM 或全效果性能资格。新增必要预算必须公开记录，不能截断身份、漏工作或永久粗糙采样。

## 5. 验证、成本与延期工作

日常开发按需编译/targeted oracle；完整模块连通后集中检查真实 GPU 接线、数学/画质语义、开关/组合与生命周期、资源上界和粗粒度成本。新增效果的 Cost Card 记录必要 ADD、可选 DELETE、主要 bytes/samples/ALU、访问、同步与最坏工作量，明确成本假设；不要求相对未实现功能有净提速。

为节省工作而增加的 cache、压缩、低频执行等优化候选，仍需单独证明质量语义及 break-even。已观察到的错误、失控容量或不可运行性能必须修复，不能以“最后优化”吞掉；正式全 Renderer 长窗口、同条件 P50/P95/P99 与4GB OS驻留集中完成。小 fixture、静态代码审查和预算有界都不提升这些资格。

V5 Phase6/条件Phase7、VSM R4、Minimal GPU Work 未获资格项和 Texture Compression 的开放限制保持未完成，见执行计划的延期表；不自动恢复旧 A–F，不重写旧失败为通过。未来模块必需的相关正确性/组合问题随当前 producer→consumer 单元解决，其余历史资格不成为所有新功能的统一启动门。

## 6. 文档如何服务后续开发

先读目标源码、公开入口与直接 consumers，再用 domain 页辅助理解事实；当前路线/详细模块入口从 workstream 的 authority 获取。本文是当前粗路线，执行文是唯一状态与详细模块设计的链接入口；模块开工时才补对应的设计/执行详案并在导航切换，原路线保留总体方向。

`docs/domains/`只记已实现行为；`next-design/`说明目标/取舍；`next-execution/`维护详细单元状态及延期项；稳定跨 owner 合同再写 contracts/specs；来源仅记录真实研究/移植边界。入口不复制状态，不为每一步新增 progress/status/claim 或组件技能。

本轮只核对本地源码、调用、资源合同和既有测试入口，没有选择新的复杂算法 donor、没有完成新算法源码移植或进行新 GPU/性能实验。各复杂模块在详细设计时按根规则研究完整成熟来源，再确定 Adopt/Adapt/Original 与必要证据。
