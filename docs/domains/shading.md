---
id: shading
kind: domain
owner: shading
state: current
verifies:
  files:
    - OEngine/src/render/surface/SurfaceV4.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/shaders/native_material.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/render/gi
    - OEngine/src/render/FrameInstanceTransforms.ts
    - OEngine/src/shaders/scgi_anchor.ts
    - OEngine/src/shaders/scgi_query_scene.ts
    - OEngine/src/shaders/scgi_estimator.ts
    - OEngine/src/shaders/scgi_native.ts
    - OEngine/src/shaders/scgi_gather.ts
    - OEngine/src/shaders/scgi_gather_source.ts
    - OEngine/src/shaders/scgi_lighting_gather.ts
    - OEngine/src/render/environment/PhysicalEnvironmentRuntime.ts
    - OEngine/src/shaders/native_environment_brdf.ts
    - OEngine/src/shaders/native_environment_sample.ts
    - OEngine/src/render/environment/PhysicalSkyIblResources.ts
    - OEngine/src/gpu/GpuAuthoredEnvironment.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/shaders/vsm_sampling.ts
    - OEngine/src/gpu/GpuVsmFilterAbi.ts
    - OEngine/src/render/vsm/VsmSettings.ts
    - OEngine/src/render/vsm/VsmFilterNoise.ts
    - OEngine/src/render/ao
    - OEngine/src/render/reflections
    - OEngine/src/render/gi
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/RendererConfig.ts
    - OEngine/src/shaders/xegtao_denoise.ts
    - OEngine/src/render/program/FrameProgram.ts
    - OEngine/src/material/CanonicalMaterial.ts
    - OEngine/src/material/NativeMaterialMutation.ts
    - OEngine/src/debug/RenderDebugView.ts
    - OEngine/src/gpu/GPUSceneEnvironmentContext.ts
---

# Shading

## 当前源码接线

核对日期：2026-10-15，底座复查基线`2caf5fe2`，后续AO/SSSR增量以本文直接消费者段及模块执行记录为准。Surface 和 LocalLightWork 使用唯一生产入口；Lighting阶段结果与原验收范围只读 [M3 执行计划](../next-execution/eengine-v4-lighting-execution-2026-10.md)。未来功能方向从workstream读取，本页不把目标能力写成生产事实。

[GpuNativeMaterialScene](../../OEngine/src/gpu/GpuNativeMaterialScene.ts) 从 scene material slots、GraphCompiler、TextureResidency 和 cooked Products 建立 immutable native publication。参数及 dynamic inputs 是实例数据；完整物理资源集合决定 BindingSet，Program 由 shader/layout 结构决定。async PSO 未就绪时延迟整 tick；成功提交才切 active，abort 保留 candidate 供 retry，旧 publication 按实际 fence 退休。

每个 authored material source 只保留一份当前 CPU code/binding snapshot。复用依据是 immutable compiled graph/Product、物理 bank view、set generation、texture route、mip 与 live publication 的精确身份和值；资源改变重新建立绑定，Scene resync/device loss 仍由原 owner 处理。材质字段/分量和RuntimeInputs变更事件、TextureResidency publication通知标记dirty；`canPrepareFrame()`稳定路径只检查已选snapshot的ready，dirty时才重新构造/验证数值与物理资源快照，保留candidate/active/abort/retry语义。Canonical编译缓存按scalar/UV/texture/sampler/content等实际依赖精确比较，不以32位hash等于内容相等。该CPU快照不拥有GPU资源或shading结果。

[SurfaceV4](../../OEngine/src/render/surface/SurfaceV4.ts) 消费 r32 Visibility、MeshletWork、FrameGeometryArena/vertex sources、frame instances、native publication 与真实 LocalLightWork/VSM/IBL/AO/environment providers。Dense one-route 无 pixel queue；multi-route 在 GPU 构造 compact pixel bins 并 indirect native dispatch。winner geometry、C/X/Y、material、BRDF、lighting 默认在同一 shader 内求值，直接写 pre-exposed working-color HDR 和 demanded reactive。

[LocalLightWorkGenerator](../../OEngine/src/render/lighting/LocalLightWorkGenerator.ts) 借用 Scene-owned LightDatabase staged-or-active publication 和最终 raw winner/depth，产生 128B parameters/header、8B cluster ranges 与 typed complete/compact IDs。零 local lights 使用 NONE；非零生产默认 SPARSE，预算溢出以完整 DIRECT 同数学求值，自动非零 DIRECT 阈值仍禁用。Renderer 拥有 device-local async pipelines 与 fenced frame allocations，Surface 只读 finalized 产品；cache 图逐帧绑定参数/资源/command，不捕获旧 Scene，Lighting 不再要求 HZB。Sun、VSM、IBL、AO 保持独立 provider。

当前 native IBL 使用共享 `native_environment_brdf.ts`：physical/authored 的 DFG 均为 Fc/total visibility，消费系数 `mix(Fc,Total,F0)`；texel-centred NoV/roughness 做 clamp-to-edge 双线性。Clearcoat 以 Schlick NoV Fresnel 衰减 base lobes 并添加 coat，仍为既有 single-scatter profile。环境 diffuse 乘现有 AO/material occlusion，specular 尚无完整场景 sky visibility/GI。PhysicalEnvironment 的分项诊断参数被 native/Sky/Aerial 共同消费；它不改变 IBL cache identity，Unlit 保留自身颜色。

2026-10-11 P3：`native_environment_sample.ts` 的 diffuse/specular/coat radiance保持四点f32权重和原roughness整数mip blend，利用neighbor∈[-1,N]的范围删除通用oct wrap的division/modulo，seam/corner/NPOT不变。DFG使用两个IBL owner稳定linear/clamp sampler，Native group1 binding7为float、binding15为filtering sampler；FrameProgram逐帧绑定当前authored或physical owner。环境GGX128/diffuse256、texture尺寸/mips/格式/预算与publication commit/abort/fence不变，无新增GPU pass/texture/history。radiance硬件bilinear候选因HDR精度失败已拒绝，成本与缺项只读[性能执行§5](../next-execution/eengine-v4-performance-optimization-execution-2026-10.md#5-p3ibl完整publication优化)。

旧 LightClusterPass、cluster-centric kernels、16B metadata/CAS/private256、legacy lighting_direct 和不可达的 PackedTransparentOitPass/wrapper 已删除；透明并非当前 production producer。GpuFrameCounters schema29 封存旧 local-light 槽位，追加 finalized header 的按需采样复制，不能把这些字段解释为 BRDF evaluations 或真实 DRAM traffic。

生产 Native 使用完整 Final Pixel profile，单 invocation 共用 primary position 完成 Sun 与 Temporal Seed；不保留 Sun continuation/第二 HDR。完整资源 profile 在创建前按协商 limits 校验；超限明确拒绝，不恢复旧路径。FrameGraph 管宏依赖及借给 Surface 的最终 HDR；Surface 只拥有执行 scratch，不 submit。

## 直接消费者与边界

2026-10-14 AO参数化：RendererConfig.ambientOcclusion提供七项初值，Renderer的ambientOcclusionSettings/setAmbientOcclusionSettings提供不可变快照/原子patch；旧xe_gtao_enabled已删除。FrameProgram按off/scalar-medium/scalar-high与0..3去噪遍数选择有限图，半径/世界尺度/power/strength从逐帧bindings晚绑定，不改变材质Program身份。三个稳定owner保留同一Hilbert LUT，完整preparation→Main→denoise仍发布最终scalar供Native binding11乘入diffuse IBL与material occlusion；没有consumer的packed副本继续裁掉。strength只在末遍完整恢复/量化后混合，不影响直接光/镜面IBL，不重复乘材质occlusion；0遍仍有一次final恢复。默认High/1遍、1m/每单位1m、power2.2与noise0保持。独立AmbientOcclusion debug读取实际有效scalar，背景/off/unlit为白，区别于材质Occlusion；空Scene仍走clear-present。AO法线来自深度，没有专属时序积累、bent normal或完整specular occlusion。结果与验证限制见[AO执行](../next-execution/eengine-ao-functionality-execution-2026-10.md#5-ao-1-实施与核对2026-10-14)。

2026-10-15 SSSR：Native publication按有效需求选择off/sssr-base-coat有限物理profile。Surface在完整winner域发布32B receiver，复用原IBL/DFG/coat计算的真实两套normal/α、响应W和baseline B；背景无效，unlit不作为receiver。SssrRuntime独立管理私有R32F depth、完整SSSR追踪及Reproject→Prefilter→Resolve、base/coat两套history和共享scratch；现有authored/physical specular texture提供屏外补缺。FrameProgram在Sky/Aerial前发布corrected opaque，以同lobe/颜色域的baseline replacement避免重复IBL，随后沿原颜色链显示；不创建opaque color pyramid或第二套材质求值。四个SSR debug读取真实阶段和所选lobe，旧SSR shader/null输入已删除。设置、验证及资源边界只读[SSSR执行§5](../next-execution/eengine-sssr-execution-2026-10.md#5-ssr-2-生产接入与逐项复核2026-10-15)。

当前FrameProgram仍没有GI、局部镜面probe、透明合成或局部体积光阶段，indirect diffuse/specular通用debug输入仍为null。GPUSceneEnvironmentContext的probe/Brick4/volumetrics惰性数据及MomentOitReference不能证明这些效果已接入。非零transmission仍被CanonicalMaterial明确拒绝，不能仅取消拒绝而宣称折射/透射可用。

2026-10-17 SCGI基础设施：`render/gi/ScgiRuntime.ts`提供每view独立双world bank、私有scratch/query batch、按binding limit分片的双screen history及submitted/abort/poison/fence退休事务；当前`ScgiAbi.ts`为64B identity、304B patch、112B field、128B anchor与64B continuation。`ScgiCapacity.ts`计算完整arena、有限AS shards、lighting-directory全量/窗口及Native/query descriptor inventory；`ScgiPublication.ts`复用FrameGraph晚绑定slot并验证compound field合同。世界域query cut/页租约与本地query publication消费GpuScene/GeometryProduct；`ScgiAnchors.encodeSceneAnchors`借用同command共享frame records、lineage、Native材质和Product bindings，编码及提交前校验当前publication，anchor产生rank0需求，new-patch seed只消费previous committed world-only field及原guide/scale，初始化A0/A2而不增加真实query样本。query侧已有共享affine、GPU compact分段TLAS、submitted静态BLAS复用、GPU dirty/refit/restructure/rebuild、同提交完整coverage continuation与Native diffuse/emissive projection；VT查询反馈独立通道，沿原atlas/IO/frame publication产生mapping generation，batch独立报告bytes/dispatch/descriptor。非Product或未支持形变为unknown，单面背向diffuse为不可信，不能当天空。ScgiEstimator现已消费真实query/native hit、LightDatabase全灯与PhysicalEnvironment，输出固定分母RGB L1 raw cohort、失败分类/序列与rank1需求；pool保持no-hit、重连接验证完整实例身份，多跳只读previous committed A0。ScgiFilter现已消费完整raw cohort，写A0/relative moments、独立A1/A2与GPU缩放归一half world-only field，真实anchor seed可消费。ScgiInvalidation在GPU比较同source snapshot的old/new bounds/identity/material/affine，overflow全dirty；filter按revision/age降confidence并由原cache轮转更新。lookup访问经原子归并后写candidate lastAccess。FrameProgram/RendererCore已接入生产基础GI，Native最终融合与目录stripe接线由SCGI-8完成。单元状态和验证限制只读[SCGI执行](../next-execution/eengine-surface-cache-gi-execution-2026-10.md)。

2026-10-13：Native 的 VSM 默认为4点旋转Vogel、1.5 shadow texel半径；可选择稳定raw gather 2×2或单点，零半径圆盘在CPU折叠成单点。每个receiver只调用一次含fine/coarse回退的页查询，所有tap复用结果；无效页及反向深度空零继续返回中性可见度。已有base/coat BRDF响应都为零时在查询前退出；Bias使用已有几何平面按实际读取texel中心修正，Depth/Angular默认1/1，重复Normal/Slope与per-axis配置、旧16点核、死`ShadowContract`已删除。深度/坐标保持f32，没有稀疏两点猜测、专用shadow history或新增GPU pass。成本与画质边界只读[V5执行§8.3](../next-execution/eengine-v5-final-pixel-performance-execution-2026-10.md#83-vsm采样与bias优化2026-10-13)。

NativeVisibilityPass 和 VSM native alpha caster 消费同一 native material publication。Native 在一次 winner/geometry 恢复后直接写 Seed rgba32float（xy motion、zw previous/current view depth）、response rgba8unorm、完整 identity rgba32uint。NativeTemporalSeed 拥有 identity pair 与成功提交事务，cached graph late bind 当前角色；classification 不读 Visibility/Depth/Geometry/Instances，产生 upscale/debug mask。Native V2直接消费Seed/response/完整identity，按AMD参考仅为颜色历史选择前景receiver；不改变Seed本身的逐pixel事实。classifier仅为true upscale和Temporal debug产生mask；AA-off由完整Native writer证明identity提交，不执行无人消费的classifier。FSR只拥有true upscale；旧Facts/Aux及旧NativeTemporalPasses已删除。background、Sky/Aerial、Radiometry/Post/Present 保持各自 owner。

旧 SurfaceWorkRuntime、GPU Tape/ExactDag interpreter、Closure Cache、coherence、field/signal heap、global Signal History 和 generic opaque Reconstruct 已从本工作树删除；不保留 adapter 或第二条生产路径。资产 cook、Graph 数学/CPU oracle、Geometry、providers、FrameGraph 与 Registry 生命周期继续由真实 owner 持有。历史 B2 数值失败没有被追认为修复；存活语义由 native update/publication/abort-retry/HDR 测试承担。

2026-10-17 SCGI生产切换：`ScgiRenderer`组合真实query/cache/anchor/estimator/filter；公开`surfaceCacheGi`设置、preset与debug沿FrameProgram进入Surface前宏stage。GI私有112B half field/history分片经有序copy/halo供Native消费；96B lighting ranges保留全部local/VSM/solar/noise引用，单次window×bin partition，必要时GPU gather七个keyed VSM descriptor，无新增Native绑定。Native在真实shaded normal评价SH，以confidence混合environment×AO，材质occlusion仅一次，GI lighting response进入原Temporal；SSSR继续消费被GI照亮的Surface。默认关闭，启用后无旧GI选择器。旧probe/atlas/long-range/screen-diffuse与无consumer的旧BLAS/TLAS已删除，DynamicBvh cooker保留。缺页/非Product/不支持的形变保持unknown；不会把不完整AS当天空。近场residual未实施，完整画质与性能资格仍归后续单元。

2026-10-17 SCGI近场接线：可选`ScgiGather`在同一SCGI owner下复用query scene、Native材质bin/几何与VT反馈，Surface后产生RGBA32F diffuse-only源、tile probe signed SH与下一代32B/H residual。Surface前按previous residual配对的world guide/identity重投影，Native通过112B lighting ranges与原目录读取，先合world+signed residual再非负处理。world seed/field/cache与screen残差独立；旧文的96B ranges及“residual未实施”是SCGI-8时点事实，现由该实现替代。专用场景与调试入口为`tools/scgi-lab.mjs`，测试覆盖与画质/成本限制只读执行§7.15；不宣称完整AAA资格。

2026-10-18 SCGI query执行切换：`ScgiQueryArena`按有限storage范围聚合多Product BLAS与48B精确求交payload，以完整GpuScene实例构建scene TLAS；`ScgiQueryRouteWork`空间筛选实际ray，`scgi_query_scene`在invocation内完整遍历并内联Native MASK，最终material按Native Program bin求值。`ScgiGather` probe消费96B geometry closest，不运行diffuse graph；estimator与两类shadow共享同一query scene。旧per-asset实例TLAS、wavefront/quantum/tail控制和64B/ray continuation已删除；packed静态arena可跨刚体publication共享，candidate/fence/abort协议仍由原query publication持有。默认1080p实验屋已接通；R2 estimator批处理、R3 request-first Native源与SCGI-10仍未完成，不能将R1解读为GI质量或整Renderer性能资格。实际成本、诊断与限制只读执行§8.4。

2026-10-18 SCGI estimator批处理：`ScgiEstimator`以GPU selected前缀组织patch×sample窗口，`scgi_estimator`用独占radiance、工作组prefix shadow队列、固定directional/sample顺序两级reduce产生原raw cohort；Native hit/完整MASK仍走R1 query。全局point/spot灯按稳定page/slot生成CDF，固定no-hit池、PDF/Jacobian、previous A0和abort/serial语义保留。示例batch1024不改变U128/hemi8/connect2/16方向；B7/64多patch及不同pool/shadow窗口真实GPU检查通过，默认1080p接通。R3 source仍全半屏准备；实际成本和验证边界见执行§8.5，不据R2关闭宣称整体实时或AAA画质合格。

2026-10-18 SCGI Gather请求驱动切换：pre-Surface的geometry-only query经完整身份/双plane验证后，以GPU bitset产生exact anchor/sourcePixel请求。Native复用当前真实graph/VT/derivatives结果，只写请求的48B preparation；world-only SH独立于residual/IBL，invalid world仍保留emission/direct。`FinalPixelAbi` ranges当前128B，lighting binding2为read_write；world112B+residual32B+request8B+preparation48B组成200B/window half-pixel。full/stripe/remap在每窗口Native后drain到GI紧凑队列，再覆盖窗口，旧全H source材质分类/重求值已删除。Unlit可发布emission，无lighting owner时使用disabled ranges。post仅对真实缺失的非零visibility贡献compact软件shadow，太阳只复用实际合法fine/coarse VSM及有效receiver depth；source填充后保留原固定N/PDF/Gram/signed residual数学和下一帧消费。FrameProgram显式发布requests与preparation，GI仍拥有source/history；4 storage textures/16 sampled/16 SSBO最满route保持。实际资源增加、局部GPU验证、1080p成本及画质限制只读执行§8.6；前面96/112B与全H准备描述为各自历史时点，当前以本段为准。下一单元为SCGI-10。

## 仍需验证

当前单机完整authored场景、streamed多Product、Lighting矩阵和受控恢复/释放的实际覆盖读执行记录；跨浏览器/GPU、完整AAA画质、超出本轮窗口的长序列/极值峰值与正式evidence/claims仍未完成。小场景闭包或预算有界不能证明这些结果，非Surface基线失败继续留在对应执行计划。

未来接口见[V4 母稿](../next-design/eengine-v4-native-shading-2026-10.md)，来源与 adoption 边界见[porting ledger](../porting/next-renderer.md)。算法 history/cache 属于算法 owner，Surface 不恢复通用记录或 reuse 操作系统。
