# Module B 设计：Surface / Material / Lighting v2

> 实施说明（2026-09-27）：B0–B8 已接入唯一生产路径；下文“当前源码”表格是设计时的基线，不再表示现状。当前生产数据流见 [Shading](../domains/shading.md)。正式 GPU 画质/性能与上游 adoption 尚未验收。

> 状态：2026-09-27 设计目标，尚未实施。对应[执行文档](../next-execution/surface-material-lighting-v2.md)、[整体架构](./eengine-next-overall-architecture-final-2026.md) §3、[架构层计划](../next-execution/eengine-next-architecture-layer-plan-2026.md) §4、[来源账本](../porting/next-renderer.md)。以下“当前”来自本次源码核对；目标行为不能当作已实现或已通过画质/性能验证。

## 1. 问题、目标和边界

Module A 已把唯一生产 Renderer 降低到 Frame Program → FrameGraph，但 Surface 仍是过渡形态：每帧全屏 classify/finalize/scatter，按 16 个 shading program × 4 个 texture binding set 得到最多 64 个 class，按活跃 class 排 pass、生成 shader/layout/pipeline，并在执行时创建 bind group。它能正确把 Visibility hit 送到 material consumer，却让简单像素也承担全屏分类和 record 往返，让材质语义、物理纹理集合与执行成本绑在同一个 class ID 上。继续叠加 clearcoat、VSM、AO、SSSR、GI 会同时扩大 shader 变体、Graph topology 和错误计能风险。

本模块的目标是：以同一 Visibility Fact 为输入，让大多数 Standard PBR 像素在 Dense lane 直接求值，让真正需要不同 closure 或物理纹理 profile 的像素进入有界 GPU Binned lane；完整接通 Standard PBR、正确的 glTF specular/IOR 语义和一个 clearcoat 第二 closure；给直接光、环境漫反射、环境镜面、发光划分唯一能量所有权。保持单 Renderer、单 frame submit、GPU 决定本帧 work 数。**极致性能是减少无用全屏访问、队列流量、热路径 pipeline/bind group 和 shader 发散后的实际 GPU 成本，不是追求某一种 pass 数字。**

本模块不实现 Module C 的按需 Surface sidecar/XeGTAO、Module D 的完整 Temporal/Radiometry、VSM 页系统、SSSR/GI、VT、Hair/Transmission/Transparency 的 composition path。会为这些模块定义能量和材质语义接点，不创建无消费者的 Pass、字段或伪 provider。B 完成后再集中 typecheck/build/必要 targeted tests；正式浏览器矩阵、画质对照和 GPU P50/P95 留给整条 Next Renderer 集成。

### 1.1 完成后的生产数据流

```text
glTF / Standard Material ──→ canonical authoring facts
                         └─→ Closure Compile ──→ bounded Material Publication
                              family / flags       params / texture route / generation
                                     │                         │
GPU Scene ─→ VisibilityKey + depth ──┴─────────────────────────┤
                                     │                         │
                         Dense Surface + Lighting              │
                         ├─ hot-profile Standard / Unlit → HDR + motion
                         └─ exception records → GPU counters/indirect
                                                 │
                                 finite profile × closure Binned dispatch
                                                 ├─ Standard other profile
                                                 └─ Coated / costly closure
                                     │
                 Emissive + Direct + Indirect Diffuse + Env Specular
                                     │
                    scene-linear/pre-exposed Surface HDR → Sky/Aerial/FSR3
```

此图的 Dense、Binned 是同帧工作调度；full/coarse 是另一个采样轴；Standard/Coated 是 closure 执行轴。`Frame Program` 固定可用物理 lane 与 producer/consumer 边；GPU 按当前 Visibility 决定实际 record、indirect count 和溢出。`Surface Material` 可在寄存器内融合本模块的光照，同时保留将来 Module C 按字段 materialize 的逻辑边界。

## 2. 当前事实与必须处理的耦合

| 源码事实（2026-09-27） | 设计含义 |
| --- | --- |
| `FrameProgramLowering.ts` 给 `ShadingWorkPass` 传 `adaptive: false`，当前生产是 full-rate；`ShadingWorkPass.ts` 仍执行全屏 classify、finalize、scatter | 不把 `docs/domains/shading.md` 里旧频率计划描述当作当前事实；先替换全员队列，再恢复合法粗频 |
| `ShadingWorkAbi.ts` 的 record 为 8 B，容量按 `width × height`，固定 64 类；`SurfaceMaterialPass.ts` 按每个活跃 class 注册 compute pass | 4K 全可见时仅 record 写+读上界约 126 MiB；活跃 class 改变会扩大 Graph/CPU 成本，此数是静态带宽估算，不是 GPU 实测 |
| `RendererCore.ts` 用 `binRefCounts[64]` 得到 active classes；`FrameProgram.ts` 的 key 含 active classes 与 texture bank masks | scene publication 可改变 topology/pipeline；新 key 仅包含实际 layout/capability/可用 lane，不包含每个 authored material/bin ID |
| `TextureResidency.ts` 有最多 4 个 set、每组 9 个 bank；普通 resident 纹理优先 set 0，cooked package 按 segment colocate；`TextureBindingSetPolicy.ts` 按每 stage 至少 16 个 sampled textures 核算 | 一个 Dense shader 可绑定一个物理 sampling profile，不可能在低 limit 设备同时绑定四组 9-bank；set 0 是初始热 profile 候选，不保证所有场景都如此 |
| `TextureHandleAbi.ts` 是逻辑 slot+generation；`GpuTextureRefAbi.ts` 编码物理 bank/layer；`GpuShadingMaterialAbi.ts` 同时发布 program ID、set ID、generation、physical texture route | 长期“稳定逻辑 handle”不能误写成当前 GPU record 已完全与物理布局解耦；CPU authoring ID 稳定，GPU 热记录可以在 publication 时预解析物理 ref 以省每样本间接访存 |
| `surface_material_program.ts` 当前以 `lightingWgsl(false, false)`生成生产 lit shader；`surface_material_kernel.ts::sparse_direct` 在一个返回值里合并 direct、physical sun、sky diffuse，另有尚未启用的 environment IBL 分支 | B 必须拆能量语义并补真实环境镜面 fallback；不能把没有生产 consumer 的 IBL 代码当成已接入 |
| `LightClusterPass.ts` 已有 GPU 点/聚光灯筛选、簇表及 overflow fallback；`lighting_direct.ts` 消费 32×32 tile、24 depth slice | 保留并调整它的输入/消费合同，先不造第二套 clustered lighting；局部光极端密度仍须评估 fallback 成本 |
| `gltfMaterials.ts` 将 `KHR_materials_specular` 转成 metallic-roughness 近似，transmission 改为 transparent；authoring object 保存 IOR，但 GPU Standard record 未表达完整扩展 closure | 新规范化材质应保存已支持扩展的原始语义；不支持的 composition domain 明示路由/失败，不能用同名近似宣称已完整 port |

当前模块 A 的 Frame Program、Visibility Fact、资源 late binding、FrameGraph、FrameCoordinator 是迁移宿主。设计可以改 Surface/Material/Lighting 的现有 ABI 与 owner，但不回退到旧 Sparse resolver、旧 EnvironmentBackgroundPass/CSM，也不创建并行 Renderer。

## 3. 上游来源、移植边界与源阶段映射

每个来源的固定 SHA、许可证、具体文件、检索缺口和预计采用状态见[来源账本 R02/R03/R04/R20/R22/R23](../porting/next-renderer.md)。以下只描述 Module B 确实要搬的算法 profile；参考项目的整套 Renderer、native descriptor、资产系统不在选中范围。论文与详细技术文章用于核对物理含义，不替代可移植源码：Filament [Physically Based Rendering in Filament](https://google.github.io/filament/Filament.md.html)、[glTF 2.0 材质扩展规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)、[Clustered Deferred and Forward Shading](https://www.cse.chalmers.se/~uffe/clustered_shading_preprint.pdf) 是对应辅助资料。

| 上游阶段/函数 | 本地目标阶段/产物 | 必须保留；不得偷换的边界 |
| --- | --- | --- |
| The Forge `CalcFullBary`、`Interpolate2DWithDeriv` | VisibilityKey → 几何属性、UV 与相邻像素梯度 | 透视权重、dx/dy 投影差分、退化/近裁剪保护、UV transform 对梯度只做线性部分；不宣称搬 The Forge 整套 Visibility raster |
| Filament `surface_shading_lit.fs` 的 Standard 参数、`surface_brdf.fs` 的 GGX/Smith/Fresnel/diffuse 分支 | Standard closure evaluation | 粗糙度、F0/F90、金属/介质混合、normal/tangent、能量补偿与纹理语义；选定分支完整搬，不把当前近似函数仅改名 |
| Filament `surface_light_directional.fs`、`surface_light_punctual.fs` 的入射/衰减/筛选、`surface_shading_model_standard.fs::surfaceShading` | Direct diffuse/specular consumer | directional/point/spot 的入射、衰减、BRDF、clearcoat 第二 lobe 和 VSM 未来注入的 visibility 位置；B 是 shadow/AO-disabled profile，源内 shadow/micro-shadow 不宣称已移植；local cluster record/layout 是 EEngine 集成 |
| Filament `surface_shading_lit.fs::getClearCoatPixelParams`、`surface_shading_model_standard.fs::clearCoatLobe/surfaceShading`、`surface_light_indirect.fs::evaluateClearCoatIBL` | Coated closure 的参数、直接光与环境光 | coat factor/roughness/normal、基础层 attenuation/F0 改写、第二镜面 lobe、IBL；只做一个高光叠加不算 clearcoat 完整移植 |
| Filament `surface_light_indirect.fs` 的 DFG、diffuse irradiance、prefiltered radiance、energy/AO 位置；`CubemapIBL.cpp::roughnessFilter/DFG` | Env diffuse、Env specular 和其预过滤 producer | 输入辐亮度、roughness→LOD、DFG 参数、mip/filter、曝光域和 generation；B 不移植 Filament 的 SSR/AO/GI provider，后续按能量合同接入 |
| Khronos glTF Sample Renderer `material_info.glsl`、`pbr.frag` 的 specular/IOR/clearcoat 参数与光照分支 | glTF→canonical material 与参数 ABI 对照 | 扩展默认值、纹理通道、色彩空间、UV/sampler、base 与 coat 的能量关系；不复制其 per-material fragment 宏变体架构 |
| Wicked Engine `visibility_analyzeCS`、`visibility_resolveCS`、`visibility_shadeCS` | Dense/exception 分流与有限 Binned 调度的参考 | uniform/divergent tile、bin 计数、间接消费的工作流；其 bindless、Wave/quad、native resource 索引与 EEngine 异常队列/溢出方案不能冒称整套 port |

MaterialX 的 `ShaderGraph.cpp` 与 WGSL generator 只作为**可选 authoring compiler 参考**；B 不因它而引入每材质动态 WGSL 或完整节点编辑器。Intel DeferredCoarsePixelShading 作为后述 2×2 闭环对照，其四 GBuffer 后判定不等同本地前置 VisibilityKey 判定。GPUPrefixSums WGSL RTS 只在实测密集 compact 优于 workgroup-local append 时采用。三者不得被登记为 B 核心已移植算法。

## 4. Material v2：语义、编译与 GPU 发布

### 4.1 分开三个不应互相替代的轴

1. **Geometry representation**：triangle、Virtual Geometry、将来的 strand/particle/volume；决定属性恢复，不决定 BRDF。
2. **Coverage/composition domain**：opaque、masked、transparent、refractive、stochastic；决定 Visibility/覆盖、排序与合成，不等于 closure family。Opaque/Masked 可走 B 的 Visibility-first 路径；transmission/hair 的完整合成留给后续独立模块。
3. **Surface closure**：Unlit、Standard、Coated，以及未来 anisotropic/skin/hair 等；决定 BSDF、参数、light/IBL 响应与 register/纹理成本。

`StandardShadeMaterial`/glTF loader 先规范化为 typed canonical facts：base、metallic、perceptual roughness、emissive、normal/tangent、occlusion、specular/IOR、coat 及各自 texture role、UV set/transform、sampler、color decode。Compiler 在场景发布而非每帧对 DAG 做类型/循环检查、常量折叠、不可达节点删除、仅在 **handle + UV/transform + sampler + gradient/LOD + color decode 完全相同** 时共享 texture fetch；不能把不同采样语义错误去重。输出是有限的 closure family、feature mask、参数和纹理角色表，不是每个材质一份 shader。

Standard 热 family 可用 feature mask 控制 base/normal/ORM/emissive/occlusion 的可选采样，但不能让每种贴图组合重新成为 PSO。Coated 分离为第二 family，保留其完整第二 lobe，避免把 Standard 热 shader 推到过高 register pressure。具体 family/资源 profile 数量由 layout budget 与真实场景局部成本决定，不能因 16 个旧 program 就固定 16 个新 family。将来 MaterialX 可降低到同一 canonical closure；表达不了的节点在发布前明确失败或路由具名 provider，不默默返回 Standard 近似。

| Canonical 字段组 | 作者/规范输入 → GPU 求值 | B 的精确边界 |
| --- | --- | --- |
| Coverage/base | `alphaMode/alphaCutoff`、base factor、base texture、vertex color | Opaque/Masked coverage 与 Surface 共用 UV、alpha 通道和 cutoff；base 颜色纹理正确解码，factor 在约定线性域相乘 |
| Standard microfacet | metallic、perceptual roughness、normal scale、TBN、ORM 通道 | roughness/metallic 和 normal 的纹理通道、空间、退化回退固定；高频法线保留 full-rate |
| Dielectric specular/IOR | glTF `KHR_materials_specular` factor/color/texture 与 `KHR_materials_ior` | 原始 dielectric F0/F90/IOR 参数不压成 MR 后丢失；依选中 Khronos/Filament profile 转换与光照 |
| Coated | coat factor、roughness、normal 及独立纹理/UV/sampler | 第二 lobe 同时作用于直接光与环境光，并衰减基础层；factor 恒零可按数学等价编译成 Standard |
| Emissive | emissive factor/texture/strength | 单独 radiance 项；不经直接光阴影或 AO；最终预曝光一次 |
| Occlusion | glTF occlusion texture/strength、将来 XeGTAO | 控制适用的间接 visibility，不把 direct 和 emissive 整体乘暗；将来 AO 的合成规则由真实 consumer 核对 |
| Transmission/Sheen/Anisotropy 等 | authored 扩展可能存在 | B 不宣称已实施；保留/显式拒绝或交给后续具名 closure/composition module，不能误着色成 Standard |

`family` 是 BSDF 结构和成本分类，`feature mask` 是同 family 内可选输入，`physical sampling profile` 是 WebGPU 可绑定的资源形状。三个值都不能直接拿 authored material ID 代替。透明、折射、毛发的 representation/coverage/composition 还会改变 Visibility 与合成顺序；即使有相似 BRDF，也不能强行放进 opaque Binned lane。

逻辑 `TextureHandle(slot,generation)` 由资产/Material 长期持有；GPU 发布阶段可将当前 resident handle **预解析**为 bank/layer/set/mip 范围并放进热 Material record，维持 generation/revision 守卫，避免每个像素额外 descriptor lookup。纹理 promotion、eviction、package 重排以事务更新 record/route，旧 GPU 对象按已提交帧退役。未来 VT 可为某个 physical sampling profile 增加 page table lookup，不能改变 authoring 材质含义。此选择不是声称现有 GPU ABI 已做到逻辑/物理分离；B 要实际切开编译语义和物理发布。

### 4.2 Alpha 与几何不变量

Masked 材质的 coverage 使用与 Surface 同一个 alpha source、UV transform、sampler/LOD、cutoff 语义；Visibility 阶段若不能取得同等输入，不得先写一个近似透明判定后在 Surface 静默改结果。Normal map 需要 TBN handedness、非均匀缩放逆转置、退化 tangent 回退和显式梯度；UV 不连续、近裁剪、跨三角形与像素边界保持 full-rate。Motion 来自当前/上一几何与相机，不得由 coarse 代表点复制到运动边界。身份/generation 错误显式 fail-visible，不能把缺纹理/缺几何误当普通黑色。

## 5. Surface 工作组织与 WebGPU 降低

### 5.1 初始物理 lane

选一个 publication-time 的 **hot resident profile** 供 Dense；初始候选是 set 0，因为当前 ordinary resident 纹理优先进入它。Dense 在读取 VisibilityKey 后直接完成 Hot Standard/Unlit 的属性恢复、贴图、BRDF、光照、HDR/motion 写入；无效背景跳过。遇到 Coated、其他物理 profile 或定义的高成本特例，**同一次扫描**仅产生 exception record，不先把所有像素压紧。其它 profile 的 Standard 和 Coated 使用固定上界的 `profile × family` Binned 间接 slot；例如 4 个 resident profile × 2 family 的上界是 8 个 slot，而不是 64 个 material/bin PSO。这个数字是首轮物理预算示例，实施时按设备 limit 核算，不是稳定 ABI。

Dense 的“简单”指**当前能力下可由热 profile 正确采样且适合连续求值**，不是只允许无贴图；常见 Standard normal/ORM 贴图应先作为 Dense 候选。若其大 WGSL/register/divergence 成本超过分类收益，再用事实划入 Binned 或另一有限 Dense specialization。选 hot profile 可以使用稳定 publication 元数据；更精确的可用**上一已完成帧**统计调整，不能本帧 GPU→CPU→GPU 改本帧图。没有 dominant profile 时仍保证正确：Binned 处理更多像素，质量不降，性能决策由后续局部比较驱动。

### 5.2 Queue、同步和溢出

Exception record 至少包含 pixel/sample identity、VisibilityKey 或其可重取位置、lane/profile/family、必要 generation；只保存重建成本低且不会引入第二次大规模随机读的字段，最终 byte layout 在实现前单独核算。每个 workgroup 可在 shared memory 做 lane-local compact 和一次有界预约；`subgroups` 可加速 ballot/prefix，但要按已启用 feature 与实际 subgroup size 生成变体，并有 workgroup 共享内存 fallback。`dispatchWorkgroupsIndirect` 的参数由 GPU finalize 写入。多个固定 lane 的 pipeline/bind group 切换可在少数 Graph compute pass 中顺序编码，不能强制每 lane 一个独立 frame submit。

容量取已协商 `maxStorageBufferBindingSize/maxBufferSize`、分辨率和显存预算的下界；不要求给每个像素永久分配完整 8 B record。若 lane 预约超限，GPU 标志该 lane overflow、使正常 binned indirect 为零，再给该 profile/family 的**条件全屏 fallback**生成间接 dispatch：它按 VisibilityKey/material publication 重查该 lane 的全部像素并完整求值。Dense 只写自己已处理的像素；正常 Binned 与 overflow fallback 在每 lane 互斥；各 lane 写域互斥。即使已写出部分异常 record，overflow lane 也全部弃用，避免半队列画面。fallback 较慢但同帧完整，不允许本帧 readback 补洞、独立 submit 或“错误色代表成功覆盖”。若资源 limit 连 fallback 都无法合法编码，创建资源前明确拒绝该能力 profile，而不是运行中越界。

现有 `ShadingWork` 的 `attempted/written/overflow`、间接参数和 Present 错误色是迁移输入，不直接视为新 queue 正确性证明。新 ABI 必须明确：counter 清零时刻、reservation 上限、dispatch X/Y 限额、record 的 generation、同一像素唯一写者、Graph 的 pass 顺序，以及 resize/device recovery/abort 后的资源失效。极端 local-light cluster overflow 仍按其独立 fallback，不与 Surface queue overflow 混用。

| GPU 阶段 | 读取 → 写出 | 本帧排序/唯一写者条件 |
| --- | --- | --- |
| Dense + exception producer | VisibilityKey、depth、Material/Texture/Geometry publication、cluster/sky → HDR/motion、exception records/counters | Hot Standard/Unlit 当场写 HDR；其它像素只预留 record，不写 HDR；本阶段前队列 counter 已清零 |
| Finalize | 各 lane attempted/written/overflow、容量 → 正常/回退 indirect args | overflow lane 的正常 dispatch 必须为零；未溢出 lane 的 fallback dispatch 为零；总 group 数按 device limit 2D 分解 |
| Binned consumer | 成功 lane records、原始 Visibility/Material 及实际物理 texture profile → 同一 HDR/motion | 重检 record/generation 和 lane；只写该 lane 的异常像素，不读不改 Dense 像素 |
| Conditional fallback | overflow lane 的 Visibility/Material 与正确 texture profile → 同一 HDR/motion | 扫全屏但只写属于该 overflow lane 的像素；忽略该 lane 已部分写出的 records，不同 lane 互斥 |
| Environment/FSR3/Present | 完整 HDR/motion/depth、sky 等 → 后续颜色 | 必须等上述 writer 结束；背景和故障色约定一致，不把未写片元当黑色成功 |

四种阶段可在固定的少数 FrameGraph 节点中编码；表是数据依赖和正确性合同，不要求一行一个 pass。Storage texture 写后下游读取由 Graph 的资源边表达。Producer 与 consumer 的所有动态数量仍留在 GPU，CPU 只绑定资源并提交这一帧。

### 5.3 能力与热路径

标准 WebGPU 的 compute/storage/indirect 是基本面；通用 bindless、mesh/task shader、multi-draw indirect、BDA 不作为生产前提。`maxSampledTexturesPerShaderStage` 从协商后的 **device** 读取；9 个 bank 加上 depth/sky/其它输入必须逐 family 计数。高限额 `Wide Texture Profile` 可让一个 shader 同时看到更多 resident arrays，但需要初始化时请求 limit、layout/WGSL 变体和真实收益比较，不能简单把 4×9 个 bank 塞进低限额 shader。`shader-f16`、subgroups 等仅在全功能语义不变且有收益时启用。

pipeline/layout 在 device/profile 建立或 scene publication 时预热并缓存，key 只包含 family、固定物理 profile、layout、format、capability、source revision；动态 material ID、texture generation、当前 active count 不改变 pipeline 身份。场景侧 bind group 可跨帧复用；瞬态 HDR、queue、depth 对应的少量 bind group 每帧重建可以接受，但数目固定且小，不得再逐 active material class 创建。Frame Program 的 key 不应因 authored 材质数或每帧屏幕覆盖变化而改变。GPU 输出由现有 FrameGraph 资源依赖编码，FrameCoordinator 仍是唯一 submit owner。

## 6. Lighting 的唯一能量合同

Surface closure 先生成未曝光的 scene-linear 响应参数。每种 radiance 只归属一项；进入当前 Surface HDR 时**仅一次**应用本帧 pre-exposure，Sky/Aerial/FSR3 知道同一域。逻辑求和为：

```text
L_preReflection = L_emissive
                + L_directDiffuse + L_directSpecular
                + L_indirectDiffuse
L_finalOpaque   = L_preReflection + L_indirectSpecular
```

`L_direct*` 含方向光/PhysicalSun/点光/聚光灯的 BRDF 响应，**Shadow Visibility 只乘对应光源的直接项**；VSM 未接入时是明确的 visibility=1。PhysicalSky 的大气 irradiance 属间接漫反射，需核对 LUT 是否已含太阳直射，避免和 Sun 再计一次。glTF/material occlusion 与将来 XeGTAO 主要作用于间接可见性，不能最终颜色整图乘 AO，也不能替代 VSM。World GI provider 必须声明输出是完整 indirect radiance 还是不含 Sky 的 bounce delta：前者按有效域替换/混合 Sky，后者才可加到 Sky；两种不能含糊相加。

`L_indirectSpecular` 是一个积分的一个结果。B 的唯一来源先是可用的 environment radiance/DFG fallback；动态物理天空需要 Sky radiance → 预过滤 mip/DFG → Surface consumer 的真实生产链，按 sky generation 双缓冲发布、旧纹理在提交完成后退役，不用每帧从零重建全部 mip。Filament `CubemapIBL.cpp::roughnessFilter/DFG` 是算法候选；WebGPU compute、octahedral/cubemap 物理布局和增量调度是本地适配，必须对照 source 的采样/pdf/mip 不变量。若尚无有效 prefilter，显式记录为环境镜面缺失状态，不能以常数高光冒称 IBL 完成。未来 SSSR 的 screen hit、World hit 与 Environment miss 依 confidence/有效域**选择或混合来源**；反射能量与 BRDF/DFG 权重由一个 integrator 拥有，provider 不得再各自叠加同一高光。Pre-Reflection HDR 可作为反射 source pyramid，避免无界同帧递归。

Clearcoat 对直接光和间接镜面都增加第二 lobe，同时衰减基础层；不能只在 direct 加 coat 高光而让 IBL 仍按裸 Standard。其 roughness/normal、F0、energy compensation 必须按固定 Filament/profile 与 glTF 扩展语义相互核对。将来 XeGTAO、VSM、SSSR、GI 可改变可见性或采样来源，不重写这套材质主链。

## 7. 采样频率与后续模块的边界

B 的初始正确性底线是所有可见 opaque/Masked PBR **full-rate**，尤其 normal map、alpha mask、材质/primitive 边界、运动/disocclusion、镜面高频、局部光与 future VSM/SSSR 依赖。现有前置 2×2/4×4 频率计划只在已证明相同结果的静态 unlit factor 与 publication-certified 1×1 unlit texture 上考虑恢复；不能因为 `adaptive` 名称就扩大到纹理 PBR。若使用 Intel CPS 的 2×2 算法，须搬其四样本 Surface、深度/法线风险判定、full/coarse 消费和全样本 splat；否则继续明确命名为 EEngine pre-material frequency，绝不声称 Intel port。空间频率若省下的 shading 小于分类/重建成本，应允许 full-rate 优先。

Module C 才比较 fused 与 demand-materialized physical layouts，并以 XeGTAO 真 consumer 决定 normal/roughness sidecar。B 只保留语义字段、产生时刻和重算成本接口，不为了将来可能的 AO/SSSR 预造全屏 GBuffer。Module D 才统一 motion/reactive/history/radiometry 生命周期。VSM、SSSR、GI、VT、Transparency/Hair 消费 B 的稳定合同，各有自己的完整算法、work queue 和组合边界。

## 8. 性能模型、选择标准与未决风险

| 候选 | 预期收益 | 必须看到的代价/失败场景 |
| --- | --- | --- |
| 旧 64 class 全员队列 | 各 class 专化，shader 分支少 | 两次全屏扫描、全员 record 写读、每活跃类 pass/绑定、publication 改 graph key |
| 全屏巨型 Dense shader | 无队列 | 4 个纹理 set 不能低限额同时绑定，复杂 closure 的 branch/register/texture 工作拖慢普通像素 |
| 推荐：hot-profile Dense + 有限异常 Binned | 普通像素一次求值，昂贵和异 profile 才 compact；固定 pipeline 上界 | 异常占比高、texture set 均匀分布、tile 材质混合、normal map 带宽或 register pressure 高时可能不赢 |
| 全员 tile binning | 改善相干性 | tile 多材质时重复访存与筛选，仍给所有像素付分析成本；Wicked 的 native bindless 不能直搬 |
| 总是 prefix scan | 降低原子争用 | 多 pass、全屏流量和临时 buffer 可高于 workgroup-local reservation |

局部决策用相同分辨率/场景比较：扫描像素、Dense 命中率、每 profile/family record、溢出率、shader variants、Graph/dispatch 数、CPU 热路径 pipeline/bind group 创建、queue 字节、GPU classify/compact/shade/lighting 时间和输出一致性。选择 hot profile 不看“材质数量”代替可见面积；初始 set 0 是现有 residency 布局推断，真正场景覆盖要靠延迟统计。局部性能实验是调试/选型，不提前要求正式 P50/P95 claim。

以 3840×2160、所有像素可见、现有 8 B record 为上界示例，旧全员 queue 单次写入约 63.3 MiB、随后读取约 63.3 MiB；真实运行还包含两次 Visibility 扫描、class metadata、几何和纹理数据，不能把 126.6 MiB 当测得总带宽。若 Dense 命中 85%，同样 8 B 的异常 record 仅约 9.5 MiB/方向，但 Dense shader 的额外分支、寄存器和采样成本仍可能抵消收益。这是**选择物理方案的成本模型**，不把 85% 假定为真实场景结果。若异常接近全屏，GPU fallback/更大的 compact 预算或不同 hot profile 都需要比较；不通过降低材质画质强行满足这个比例。

最大风险依次是：Dense shader 因 Standard 贴图组合过宽而失去性能；set 0 不再是视觉主导；clearcoat 直接/IBL 两段能量不一致；physical sky specular producer 的更新成本；masked coverage 与 Surface 采样不一致；overflow fallback 写域冲突；旧 active-class topology 和 material ABI 迁移时短暂双主链。执行文档规定单链切断、局部取舍点和最终模块核对。若实际限制推翻某个**物理**方案，可改变 lane/layout；不得把选定上游算法简化为同名近似效果。
