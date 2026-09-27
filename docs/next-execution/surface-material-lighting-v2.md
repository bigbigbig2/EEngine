# Module B 执行：Surface / Material / Lighting v2

> 实施记录（2026-09-27）：B0–B8 已接入单生产路径；集中 typecheck、build 和选定 targeted tests 通过。下文的旧类队列文件名是迁移前定位记录，当前实现入口见 [Shading](../domains/shading.md)。浏览器矩阵、画质/性能、正式 evidence 与 claims 留待 Next Renderer 最终验收。

> 状态：2026-09-27 待实施的执行顺序。设计依据为[Module B 设计](../next-design/surface-material-lighting-v2.md)，整体顺序见[架构层计划](./eengine-next-architecture-layer-plan-2026.md)，候选移植见[Next 来源账本](../porting/next-renderer.md)。本文是连续编码的工程路线，不是逐批许可清单；步骤可在同一大模块内连续推进。只有 Module B 主链原理连通后才集中 typecheck/build/必要 targeted tests，正式 browser/evidence/claims/性能矩阵留在整条 Next Renderer 完成后。

## 0. 本模块完成的准确含义

生产 Renderer 的唯一非空主链应为：`GPU Scene → VisibilityKey/depth → Dense Standard/Unlit + GPU exception work → 固定 Binned Standard/Coated lanes → 有明确能量归属的 HDR/motion → Sky/Aerial/FSR3/Present`。Standard PBR 包括正确纹理梯度和 glTF specular/IOR 语义；clearcoat 的参数、直接光与环境光是完整第二 closure；环境镜面有真实 radiance/prefilter/DFG producer 和 Surface consumer。Exception overflow 在 GPU 内以互斥的全屏条件 fallback 覆盖。旧 64 类全员 classify/scatter 与按 active class 构图/建 pipeline 从生产依赖删除。

`FrameProgram` 决定固定可用 lane、layout/profile 和 Graph 边；本帧 Visible hit 与 exception 数由 GPU 决定。相机运动、材质 generation、纹理内容和 work count 不改变 topology key。场景发布或能力 profile 若真的改变资源布局，允许有限重编译。正常/异常/resize/device recovery 仍由 FrameCoordinator 唯一提交帧，没有当前帧 GPU→CPU→GPU 决策。

本模块**不以**XeGTAO、VSM、SSSR、GI、VT、Hair/Transmission 完成为前提；它要给这些模块一个真实可消费且不会重复计能的合同。Module C 再做按需字段物化和 XeGTAO。已有 `docs/domains/shading.md` 的频率路径文字落后于 `FrameProgramLowering.ts` 当前 `adaptive:false`；开发以源码为准，当前事实文档可在本模块收口时集中同步。

## 1. 动手前的源码路径和 owner 图

先运行 `node tools/vibe.mjs context OEngine/src/render/surface/SurfaceMaterialPass.ts` 和 `context OEngine/src/gpu/TextureResidency.ts` 取得导航；它们不是验证门禁。逐段阅读下表的真实 producer/consumer，记录本次实际更改位置，不以旧 claim 推断运行行为。

| 边与 owner | 当前入口 | B 要改变的职责 |
| --- | --- | --- |
| scene/material authoring → GPU publication，materials-textures | `loaders/gltf/gltfMaterials.ts`、`material/StandardShadeMaterial.ts`、`gpu/GpuMaterialStore.ts`、`gpu/GpuShadingMaterialAbi.ts`、`gpu/GpuShadingProgramAbi.ts` | 保留 authored 扩展语义，发布 canonical closure/family/flags/参数；把物理 texture set 从 authored program ID 中剥离 |
| texture asset → physical sampling，materials-textures | `gpu/TextureHandleAbi.ts`、`GpuTextureRefAbi.ts`、`TextureResidency.ts`、`TextureBindingSetPolicy.ts`、`gpu/GpuShadingMaterialAbi.ts` route | 逻辑 handle 不变；publication 预解析物理 bank/layer/set/mip 与 generation；有限 layout/profile 和合法 fallback |
| GPU work/Visibility → Surface，visibility/shading | `render/program/FrameProgramLowering.ts`、`render/surface/ShadingWorkPass.ts`、`ShadingWorkAbi.ts`、`SurfaceMaterialPass.ts`、`shaders/surface_material_program.ts` | 删除全员 classify/scatter/64 class producer；一个 Dense 求值兼 exception producer，固定 Binned indirect consumer 和 GPU overflow fallback |
| geometry/texture reconstruction，shading | `shaders/surface_material_kernel.ts`、`gpu/GpuSurfaceProgramSpecialization.ts`、`render/surface/SurfaceProducts.ts`、`SurfaceKernelBindingPlan.ts` | 保留 The Forge 已对照透视/梯度和本地身份守卫；拆分 closure、物理采样、能量函数的复用边界 |
| local/physical environment lighting，shading/environment | `render/passes/LightClusterPass.ts`、`shaders/lighting_direct.ts`、`render/environment/**`、`FrameProgramLowering.ts` | 保留 GPU cluster；独立 direct/sun/sky diffuse/env specular，给未来 VSM/AO/SSSR/GI 唯一归属 |
| Graph/提交，frame-runtime | `render/program/FrameProgram.ts`、`FrameProgramBindings.ts`、`FrameProgramLowering.ts`、`pipeline/RendererCore.ts`、`FrameCoordinator.ts` | 固定 lane topology 与 late binding；不让 Renderer 回收每材质分支，也不增加 submit/readback |

开始编码前将 selected profile 与上游固定版本写到来源账本：R02 The Forge `cd504689…`；R03 Filament `41f996de…`；R22 Khronos glTF Sample Renderer `cc27919c…`；R23 Wicked Engine `0c97cfcd…`。R04 MaterialX、R20 Intel CPS、R01 GPUPrefixSums 保持候选，除非实际选择其完整范围。源函数/阶段、输入输出、关键分支、不变量、WebGPU 差异、缺失行为已在账本和设计文档列出；实施遇到上游第三方片段应继续追许可证/notice。**先完成可核验的 donor 映射，再移植复杂算法；普通 ABI/绑定胶水标本地集成即可。** 不要求日常每次修改同步账本或制造 evidence。

## 2. 总切换顺序

```text
B0 来源与现状定界
 → B1 Canonical Material/Closure 语义与发布
 → B2 Physical Sampling Profile 与 capability preflight
 → B3 Standard PBR、直接光和环境间接光
 → B4 Dense Surface 与异常生产
 → B5 有限 Binned/indirect/overflow 覆盖
 → B6 Coated 完整 closure 与 glTF clearcoat
 → B7 保守空间频率和单链切断
 → B8 大模块集中检查、文档/currentSlice 收口
```

B1–B6 可以在同一工作分支连续编码；新组件可先离线准备，但在切换前不得给 Renderer 加旧/新 A/B 运行开关。切换时保证所有当前合法 opaque/Masked Standard 材质都有新主链 consumer，再一次性让 Frame Program 指向新 Surface owner，删除旧全员队列和旧 class 图。若中途真实代码无法编译，修复即可继续；不因某一小步未跑 browser、缺 evidence 或 future provider 未到而停工。

## 3. B0：来源和生产事实定界

1. 沿 `RendererCore.render → FrameProgramCache → lowerFrameProgram → ShadingWorkPass → SurfaceMaterialPass → Sky/Aerial → FSR3` 走一遍非空/空场景，列出当前真实 Graph 资源与光照输入；核对 `adaptive:false`、64 类、active class 对 key 的影响。不要从已过时的 current docs 推断频率开关生效。
2. 从 `GpuMaterialStore` 追 `TextureResidency` 的 handle → physical ref → texture route → bank view；记录普通 resident set 0 与 cooked package 分组的实际条件。列出每种已支持材质的 base/normal/ORM/emissive/occlusion、alpha、UV/sampler/mip 与 generation 守卫。
3. 对 The Forge 的 bary/derivative、Filament Standard/clearcoat/direct/IBL、Khronos specular/IOR/clearcoat、Wicked tile analyze/resolve/shade 做函数级核对。选定完整 profile，特别区分 Filament `surface_light_indirect.fs` 中与本模块无关的 SSR/AO/refraction 分支，不能借选子集丢掉 Standard/coat 必需分支。
4. 检查 Filament `CubemapIBL.cpp::roughnessFilter/DFG` 的输入 cubemap、采样/pdf、roughness/mip、边界/归一化；对照当前 PhysicalSky 辐亮度和环境 LUT。若 sky prefilter 必须补其它上游文件/第三方代码，先固定来源再编码。写明这是候选移植，不把旧未接通的 IBL 字符串当成生产事实。

本步产物是可编码的源→本地阶段清单、目前资源预算和待删旧职责。它不需要独立测试回合；只在遇到无法保留复杂算法核心分支时重新选择具名 profile，而不是悄悄用同名近似算法。

## 4. B1：Material canonical facts 与 Closure Compile

**修改入口**：`StandardShadeMaterial.ts`、`gltfMaterials.ts`、`GpuShadingProgramAbi.ts`、`GpuShadingMaterialAbi.ts`、`GpuMaterialStore.ts`；新增的 canonical/compile 文件放 materials-textures/shading 明确 owner 下，不再让 loader 持久拥有 GPU 对象。

1. 把 **representation、coverage/composition、closure** 明确拆开。Opaque/Masked 的 Standard 与 Coated 可进入本模块；Transparent/Transmission 保留独立 composition domain，不把 `transmission_factor>0` 当作 opaque coat，也不假装此模块已实现折射。对暂无生产 consumer 的材质特性，在发布前显式拒绝或交给已具名独立 provider，不能默默转换成同名近似。
2. glTF `KHR_materials_specular` 与 `KHR_materials_ior` 保留原始 dielectric/specular 参数和纹理 role，按 Khronos `material_info.glsl/pbr.frag` 的 defaults、通道与能量规则降低；停止将 specular 扩展仅转成 metallic-roughness 近似后丢信息。glTF clearcoat 的 factor/roughness/normal 三类输入及各自 UV/sampler/transform 一并进入 canonical facts。Standard base、metallic、roughness、normal、emissive、occlusion 既有语义保持。
3. Compiler 在材质/场景发布时做有类型 DAG/参数检查、常量折叠、无用输入删除、采样等价去重。输出 `family`（至少 Unlit/Standard/Coated）、feature mask、参数、纹理角色和 coverage 信息；**不按每种纹理组合生成 pipeline**。MaterialX 只供图算法参考，B 不需要把它的 runtime/editor 带入产品。
4. GPU Material record/version 改为稳定逻辑 family/flags/参数与 generation；物理 profile/route 另存 publication 结果。VisibilityKey 或 meshlet work 能在 GPU 找到当前 material slot，且 generation 错误 fail-visible。旧 `programId + (setId<<4)` 的 bin identity 仅在迁移期内部供定位，不保留为新主链的 shader class。

**完成观察点**：两份 authored 材质只有纹理组合不同、closure/物理 layout 相同，不导致新 shader family 增长；specular/IOR 与 clearcoat 输入不会被 loader 丢弃；没有第二个 Renderer 入口。这里不要求每个材质组合都新建测试。

## 5. B2：TextureHandle、物理 profile 与设备预算

**修改入口**：`TextureResidency.ts`、`TextureHandleAbi.ts`、`GpuTextureRefAbi.ts`、`TextureBindingSetPolicy.ts`、`GpuShadingMaterialAbi.ts`、`SurfaceKernelBindingPlan.ts`、`WebGpuCapabilityRecord.ts`、`RendererCore` device 初始化。

1. 保留 asset/material 的逻辑 slot+generation。`TextureResidency` 在 publication 事务内解析当前 resident bank/layer/set、最大可用 mip、sampler 和格式；GPU 热记录可直接缓存 physical ref，避免每像素二次 table 访问，但每个 texture route 有 generation/revision，promotion/eviction/replacement 原子更新。
2. 形成少量命名物理 profile：`ResidentHot`（初始可绑定 set 0 的 9-bank 形状）、`ResidentOther`（相同 shader/layout，不同 set view）、实验性的 `Wide`、将来的 `VT`。**set ID 是实际 bind group 参数，不是 authored closure ID**。空 bank 使用已存在合法 fallback view；不能从未驻留 segment 随意采错别的 set。
3. 对 Dense Standard、Binned Standard、Coated、Masked coverage、Sky IBL 各自核算 sampled textures、samplers、storage buffers/textures、bind groups、workgroup storage；按 `device.limits` 检查，需高 limit 则在 `requestDevice` 前协商。当前请求 16 个 storage buffer 但 sampled texture 仍按设备默认限制，不能假设 Wide 已可用。布局/profile 不满足时在资源创建前明确失败或选另一个完整合法 profile。
4. 让场景侧 bind group 随 publication/generation 可复用；瞬态输出/queue/depth 的绑定在本帧 late bind。预热固定 family×layout×capability pipeline。避免旧 `textureBankMask` 每变一次就创建新的 WGSL/layout；若 bank 分支专化确有净收益，限定到少数预定义 profile 并记录代价。

**失败/回收**：preflight 失败保持上一完整 publication；旧纹理/bind group 在 GPU 完成后退役；device loss 后从 CPU authoritative asset/material 重建，无跨 device 缓存。Wide 与 VT 不因尚未完成而阻塞 ResidentHot/ResidentOther 主链。

## 6. B3：Standard PBR 与 Lighting 能量迁移

**修改入口**：`surface_material_kernel.ts`、`surface_material_program.ts`、`lighting_direct.ts`、`LightClusterPass.ts`、PhysicalSky/Environment owner、`SurfaceProducts.ts`、`FrameProgramLowering.ts`。重用现有 The Forge 对照的插值/显式梯度与普通/VG attribute decode；对近裁剪、无效梯度、UV transform、TBN、逆转置 normal 的守卫不能删。

1. 将 Standard closure 的 base/metallic/perceptual roughness/F0/F90/normal/emissive/material AO 计算与 lighting evaluation 分成逻辑函数；按 Filament 的指定 Standard BRDF 分支逐项核对 GGX、Smith、Fresnel、diffuse、energy compensation、roughness 和 dielectric/metal 混合。不得将 `KHR_materials_specular` 继续当无关的近似 MR 值。
2. `LightClusterPass` 保留当前点/聚光筛选与 active-list overflow fallback。Surface direct consumer 按 Filament `surface_light_directional.fs`/`surface_light_punctual.fs` 的选定入射和衰减阶段，对每光源计算 BRDF 与当前 visibility=1；源内 shadow/micro-shadow 分支属后续 provider，不宣称 B 已 port。PhysicalSun 单独作为 direct，Sky irradiance 单独作为 indirect diffuse。`emissive` 从 `shade_standard_material_direct` 的合计结果拆出来，避免以后 direct shadow/AO 错乘发光。
3. 为环境镜面建立真实 Sky/Environment radiance → roughness prefilter/mips + DFG → Surface 采样。按 Filament `CubemapIBL.cpp::roughnessFilter/DFG` 与 `surface_light_indirect.fs` 对照采样、分布、mip、Fresnel/能量项；WebGPU compute 和本地物理布局可改，数值与关键分支不可换成固定反射色。动态 sky generation 只在有变化时调度；新整套 mip 未就绪前保持上一**已完成** generation 或显式缺失，不让不同 generation 的 DFG/辐亮度混用。生成与帧渲染共用现有提交 owner。
4. 将 `L_emissive`、`L_directDiffuse/Specular`、`L_indirectDiffuse`、`L_indirectSpecular` 标成内部语义项，再在 HDR 写出边界统一乘本帧 pre-exposure。Sky LUT 是否包含太阳直射必须核对，不能既作 sky diffuse 又把相同太阳能量在 PhysicalSun 直接项加一次。无 AO/GI/SSSR 时只有明确 environment 来源；不分配它们的假输入。
5. 给后续模块固定调用关系：VSM 返回特定 light/receiver visibility；XeGTAO 调间接 visibility；GI 声明 total 或 delta indirect；SSSR/World/Env 归一个 specular integrator。B 不为这些 provider 写空 pass。

**观察点**：一个 Standard textured hit 从 Visibility 经过 GPU attribute/texture、cluster/Sun、sky diffuse、environment specular 到 scene-linear HDR，且有真实 texture producer/binding；无可用 env prefilter 时状态显式，不以旧字符串分支证明完成。未连通前不要为了测试补空 IBL 资源。

## 7. B4：Dense 热路径与 GPU 异常生产

**修改入口**：`ShadingWorkPass.ts`/`ShadingWorkAbi.ts`、`SurfaceMaterialPass.ts`、`surface_material_program.ts`、`FrameProgramLowering.ts`；可直接替换旧 owner 文件，不保留 `SurfaceV1/SurfaceV2` 双运行桥梁。

1. 以 `VisibilityKey` 为唯一命中事实。一个全屏 Dense compute 读取 material slot/closure/physical profile：无效背景不写、hot Standard/Unlit 直接计算完整 HDR/motion、其他命中写异常 record。当前 full-rate baseline 先保证每个可见 opaque/Masked sample 恰有一个 writer。
2. 初始 hot profile 用 publication 能确定的 set 0，**不**按本帧 camera/visibility readback 切换。每个 workgroup 对各异常 lane 做局部 compact，记录 attempted、bounded written、overflow；必要时用 subgroup 变体加速，需有无 subgroup 的共享内存等价路径。Material/texture generation mismatch 保留 fail-visible 行为，不能把无效命中静默当背景。
3. Dense shader 内包含常用纹理 Standard（base/normal/ORM/emissive），不把“有贴图”直接等同“必须 binned”。若 shader 过宽使 register/occupancy 下降，可依据同场景局部 GPU 结果把特定昂贵 feature 移到有限 Binned family；不能重新生成每材质 PSO。未持有需要的物理纹理 set 时只登记异常，绝不采 set 0 的错误层。
4. 先使 Dense 写完整当前 radiance/motion，再让异常消费者写互斥位置。Graph read/write 边必须串联输出；HDR/motion 背景 clear 与 Sky/Aerial 后处理保持当前有效域。只在 B 切换时启用新的 Dense 生产者，不给生产用户保留旧版开关。

**性能观察点**：Dense 命中率、异常 record/像素比、workgroup atomics、shader register 压力、热路径 JS 对象数。目标是消掉简单像素的 `classify → scatter → queue read`，但不先宣布更快。

## 8. B5：有限 Binned、indirect 与保守溢出

1. 将 `profile × closure family` 映射为**固定上界**的 GPU lane table。第一个物理预算以四个 resident profile、Standard/Coated 两 family 的最多 8 个异常 slot 为目标；多个 slot 可在一个 Graph compute pass 中顺序 `setPipeline/setBindGroup/dispatchWorkgroupsIndirect`，避免每 slot 一个 graph pass 或 submit。实际 slot、queue 字节和资源总数必须服从设备 limit；不能因为预算示例就吞掉一个合法材质。
2. 定义 record 与 counter 的版本、清零、reservation、capacity、generation、indirect offset、workgroups X/Y 算法。Producer 写 records/counters，finalize 写每 lane 间接参数，Binned shader 只消费本 lane；任何同帧 CPU 读回只用于之后诊断，不用于本帧调度。若一组 Profile 的 masked/Coated 需要不同 bindings，预定义有限布局并在设备/场景发布阶段预热。
3. 实现 **lane 原子级失败语义**：该 lane 任一次 reserve 溢出，finalize 将它的 Binned indirect count 设零，并启用同 lane 的 full-screen conditional fallback indirect。fallback 重新检查所有当前可见像素是否属于该 family/profile 后完整求值；已写的部分 record 一律不消费。Dense、成功 Binned、overflow fallback 的写域互斥；不能靠 Present 的错误色把缺像素掩盖过去。
4. fallback 需要本 lane 的全部资源绑定且不依赖溢出的队列 payload；Graph 顺序必须是 Dense → finalize → Binned 或 fallback → Sky/Aerial/FSR3。capacity 很小时可以频繁 fallback、画质仍完整；性能退化可通过提高预算、改善 profile locality 处理。禁止独立 submit、mapAsync 或 CPU 等 GPU counter 再执行补帧。
5. 移走旧 64-class 的 per-class indirect args、按活跃类建 Graph pass/pipeline 的逻辑，保留只有真正被新主链消费的诊断 counter。若旧 `SurfacePresentPass` 仅为粗频代表点重建服务，待 B7 决定其最终角色，不保留隐藏第二条 resolve。

**最小正确性核对**：空/全 Dense/全 Binned/混合像素/队列容量刚好满与再多一个/同帧 generation 失配，确认每可见像素唯一合法结果、indirect 未越界、fallback 互斥。这里可用单个 targeted oracle 调试；不是每完成一条就跑浏览器轮回。

## 9. B6：完整 Coated closure 与第二 family 的压力验证

**上游闭环**：Khronos `material_info.glsl::getClearCoatInfo` 的 clearcoat normal+roughness/factor 纹理语义 → Filament `surface_shading_lit.fs::getClearCoatPixelParams` → `surface_brdf.fs` 的 coat D/V/F → `surface_shading_model_standard.fs::clearCoatLobe/surfaceShading` → `surface_light_indirect.fs::evaluateClearCoatIBL`。直接光和环境光两条都要有真实 GPU consumer，基础层 attenuation/F0 修正不可遗漏。

1. 从 glTF authored factor/texture/UV/sampler/normal scale 到 canonical Coated record 逐字段核对。Coated 选独立有限 family，避免 Standard Dense 因其第二 lobe/额外贴图把最常见像素寄存器压力拉高；同一材质若 coat factor 恒零，可在发布时降成真正等价的 Standard。纹理缺省与常数值依 glTF 规范，不靠随机 fallback。
2. Coated Binned shader 使用与 Standard 相同的 The Forge 属性/梯度、physical texture route 和 local light cluster，但自己的 PixelParams、direct/IBL 两层能量。Direction/Sun/point/spot 都经过同一 coat BRDF；environment prefilter 与 DFG 复用正确 roughness 和第二 lobe 权重。
3. 用一个无 coat、一个 coat=0、一个 coat>0、一个不同 coat normal/roughness 的小矩阵核对上游数值趋势和生产 GPU 消费。若 B 的纹理/灯光布局无法容纳它，调整有限 physical layout/执行 lane，而不是删 coat normal 或 IBL 后宣称已移植。

第二 family 必须证实 authoring ID、texture set、closure family 是独立维度。Coated 不应带来每个素材一条 pipeline；只有 family/profile/capability 产生有限变体。若发现 Filament 与 Khronos 的某一 clearcoat 约定确实不同，明确选用的 profile 与转换，不能在某一分支暗中混用。

## 10. B7：频率恢复与单主链切断

1. 默认仍以 full-rate 处理 lit/normal/alpha/运动/边界。当前 `shading_frequency.ts` 的 pre-material 2×2/4×4 判定只恢复在它**已经能证明值相同**的静态 opaque unlit factor、发布时证明为 1×1 的 unlit base texture 等窄条件上；相机运动不能改变 Frame Program topology。频率 plan 由 GPU 写，当前帧 Dense/Binned/最终呈现按同一 plan 唯一消费。
2. 若 coarse 节省少于 planner/重建成本，允许该 workload 使用 full-rate。这是性能选择，不能借关掉 planner 来宣称整个 adaptive 体系已达到性能目标。Intel CPS 的四 GBuffer/深度法线判定尚未完整移植，继续在来源账本标本地 pre-material frequency。
3. 在新 Frame Program lowering 接通 Dense+Binned/Coated 后，直接删除旧 `ShadingWork` 全员 class 队列、64-class shader 生成、旧 active-class graph/key 字段、不再消费的资源和对应旧文本断言。修改 `RendererCore` 只保留 publication 与新 Program 参数；不加旧/新 A/B 开关。保留 `VisibilityKey`、FSR3/Present 和旧有真实 GPU consumers 的合法边。
4. 清理 retired effect/renderer owner 的生产引用，检查新文件没有私有 `queue.submit`、没有当前帧 `mapAsync` 决定可见/work、没有第二个 HDR/Material producer。材质/texture/sky 换代与 device loss 走既有事务；新缓存按 device epoch 销毁/重建。

### B7 后的主链检查

| 场景 | 必须出现的行为 |
| --- | --- |
| 空场景 | 同一 Frame Program 的清屏/Present profile，不运行假 Surface/cluster/IBL 更新 |
| 纯 hot Standard | Dense 有真实 GPU writer，exception 与 Binned indirect 为空；每像素 HDR/motion 完整 |
| 多 texture profile、Standard + Coated | GPU producer 生成对应异常，固定 Binned lane 消费；scene publication 不按每材质增长 pipeline |
| 队列 overflow | 该 lane 所有异常像素由同帧 conditional fallback 重算；无半队列漏像素或重复写 |
| 材质或纹理 generation 变化 | 相同 layout 重用 Program/pipeline，绑定新 publication；错误 generation fail-visible，旧资源安全退役 |
| local-light cluster overflow | 原 cluster fallback 仍能提供直接光；与 Surface queue overflow 独立 |
| sky/IBL 尚未完成新 generation | 使用上一整套有效 generation 或显式缺失状态；无一半新、一半旧 LUT 的混合 |
| resize/camera cut/device recovery | 恢复合法尺寸/资源/历史；无 camera-motion 驱动 topology 切换和私有 frame submit |

## 11. B8：一次模块集中检查与后续交接

**只有完成上述生产链后**集中跑一次 engine typecheck、build 和与改动相关的 targeted tests。可选的重点是：Material/glTF canonical 参数与旧近似切断、The Forge 透视/梯度、Filament Standard/coat 数值 oracle、texture profile/generation、GPU queue 边界/overflow、Frame Program topology/late binding/单 submit。复用已有真正检查 producer→consumer 的测试；缺口只补少量关键 oracle 或 contract，不造实现镜像、空 Pass、无意义全流程门禁。发现真实编译或明显功能问题就修。没有运行的检查如实记“未运行”，不阻断下一大模块的编码。

最后对照本执行文档逐项复核：Standard 与 Coated 都从真实 glTF/Material 输入到同一生产 HDR；Dense 与 Binned 都有实际 GPU consumer；physical set 与 authored family 不再同一 ID；queue overflow 可完整覆盖；环境镜面有 producer/consumer；direct/indirect/emissive 归属正确；旧全员分类与 per-active-class pipeline 退出；FrameCoordinator 仍唯一 submit。更新 active workstream 的 currentSlice/nextModules 和必要的 current facts，来源账本只对已完成的实际 profile 晋级，未核对完的维持 `not adopted`。随后进入[Module C 执行](./surface-fields-xegtao.md)（Fuse + demand-materialized Surface fields / XeGTAO）。

**整条 Next Renderer 后期才做**：browser matrix、resize/camera cut/device loss 的系统组合、材质/场景/功能交互、视觉质量对照、GPU benchmark 与 P50/P95、formal evidence、claims。Module B 完成不以它们为许可条件。
