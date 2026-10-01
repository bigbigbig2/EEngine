# 面向极致性能的 Surface 最终架构：稳定材质地址、稀疏照明与时域重建

日期：2026-10-01。状态：用户已选定的重构目标，正在实施；尚未获得实现、性能或画质验收。执行方式已按用户要求改为先删除旧路径、连续实现最终主链、全部实现后统一验证。不以开发工作量、旧 Surface 布局、旧测试或中间可运行状态为约束。直接重建顺序与最终要求核对见 [执行计划](../next-execution/surface-cached-shading-rebuild-2026.md)。

本文给出一套最终生产架构，不是先优化旧链、再逐步增加缓存的执行计划。实施时直接替换旧 Surface 主链，只有一条 production renderer。整体 GPU Scene、Visibility、资源 owner、FrameGraph 与唯一 submit 边界保留；旧 Surface 文档的具体 Probe、sample result 和执行组织由本方案重新决策。本文不自动改变当前源码事实、currentSlice 或来源采用状态。

## 1. 决策

最终主链采用：

**一次几何准备 + 稳定材质地址 + 资产阶段材质编译 + GPU 可见需求驱动材质缓存 + 分信号稀疏照明 + 时域重建。**

每帧全分辨率的是可见性、深度、必要的表面地址/运动，以及对轮廓和高频信号的处理。完整材质图、完整 PBR 光照和高成本间接照明不再默认与全部可见像素一一对应。

关键取舍：

- 静态、与视向/光照无关的材质计算尽量移到资产处理或资源发布阶段。简单 glTF 纹理已经是这样的数据，不为它再计算、再存一份等价闭包。
- 动态或昂贵的可缓存材质字段采用稳定对象/材质空间地址，只更新当前需要且缺失/失效的内容。
- 直接照明、间接漫反射、镜面信号分别组织工作。直接照明允许稀疏求值和屏幕时域复用，取消“全部 lighting 必须全率”的主架构假设。
- 高频法线和镜面保留必要分辨率，但不连带强制低频材质字段、漫反射与其他光照全率。
- 稀疏求值属于有画质误差约束的渲染算法。逐位数值等价不是本性能模式的承诺；材质模型、能量语义、接缝、遮挡与时域稳定性不能任意丢弃。

“所有内容都经过同一个大 Atlas”“所有内容都走同一个大 PBR shader”“所有阶段都融合”均不采用。最终架构在不同域使用适合的数据和执行组织，控制协议共用，缓存物理表示与信号历史分别拥有。

### 1.1 直接重建的实施约束

本次首先移除旧 Surface 生产调度及其依赖，再从最终数据流连续实现 geometry/address → Appearance demand/update → 独立 lighting → history/reconstruction → HDR/Temporal/Presentation。可以跨 owner 同时修改 producer、consumer、资源和 ABI，不要求每个组件先通过测试或先借旧链出图。工作树暂时无法编译、没有完整画面或功能缺失是实施中的真实状态，不构造临时消费者、兼容层和占位结果掩盖它。

剩余实施只划分三个大步骤：第一步删除旧链并完成几何与 Appearance 数据体系；第二步完成稀疏照明、重建、最终输出及全链生命周期；第三步统一验证、性能验收与返工。上述 dataflow 节点是算法依赖，不再各自作为推进步骤或交付关卡；详细执行见[执行计划 §2](../next-execution/surface-cached-shading-rebuild-2026.md#2-直接重建顺序)。

既有 S1–S7 只用于标识最终工作范围和 R01–R24 的归属，不是阶段审批或逐阶段闭合协议。编译、数值 oracle、GPU 组件、浏览器、画质与性能测试统一放到整个目标实现及真实生产接线完成后；验收失败继续修改最终主链，不恢复旧执行模型。开发期间不为维持组件诊断宿主兼容而维护旧 ABI、增加绑定或保留旧 worker。

删除旧执行组织时，准确的材质采样、插值、BRDF、光源、阴影和曝光数学可直接抽取到最终 owner。不得把旧完整 shader/Pass 包装成“新链 fallback”。缓存 miss、容量不足和不可信历史通过新专用程序的当前帧直接求值/强制刷新处理；这条完整覆盖路径是最终算法的一部分，使用同一新产品和编译语义。

实现只承担最终 owner、真实资源和必要算法分支。稳定输入在 cook、发布和任务生成边界检查一次；热 consumer 依赖这些不变量，不反复校验静态字段，不吞掉失败并切旧链，不为假想扩展创建抽象层。GPU 动态身份、容量预约、有效内容发布和历史失效仍按算法执行，不能删掉它们后以性能为由接受错误覆盖。

## 2. 当前瓶颈与设计针对性

当前源码事实：

- `surface_sample_worker.ts:21` 使用通用 PBR program 15；分类结果主要是四个 texture binding set，不是实际着色功能对应的专用程序。
- `surface_material_evaluation.ts:144` 的通用内核遍历最多十个材质角色。Dungeon 原始 glTF 的 25 个材质都用相同输入采样 ORM/AO，metallicFactor 均为零，没有 baseColor/normal 纹理。运行时采样路由仍需核实，不能只据原始 glTF 宣称 GPU 已重复相同采样。
- `surface_probe.ts` 对双面和 ORM 的限制，以及 Bitmap variation 未知，使实际 Dungeon 全率。重建架构不能继续把这些类别整体排除。
- `surface_triangle_setup.ts` 的 workgroup cache 保存大结构，含多次 barrier；当前计数不证明它的净收益。
- `SurfaceMaterialPass.ts:280` 无 split 工作仍全屏 dispatch closure lighting。128-byte sample results 和工作池拥有显著固定容量成本。
- 已有诊断捕获存在热降频及未完成矩阵，不能据此断言几何、材质、光照各占多少，也不能预测本方案倍数。

新架构同时改变工作次数、单次执行成本、数据生命周期和重建带宽。只让 materialSamples 变少而照明/几何原样重复，不是目标完成。

## 3. 最终数据流

```text
资产处理 / 资源发布
  ├─ GPU 可直接消费的几何页与属性流
  ├─ 稳定 Surface 地址及各 LOD 的地址映射
  ├─ 编译后的材质程序、输入依赖与静态 Appearance 数据
  └─ 每信号的频率/过滤/变化信息
                         │
                         ▼
GPU Scene + Geometry Residency
                         │
GPU 可见几何选择 → 帧内变换/形变数据 → Hardware Visibility
                         │
              winner / depth / facing / coverage
                         │
                         ▼
可见表面地址与需求生成
  ├─ 按可见 primitive 构造紧凑插值信息
  ├─ motion / identity / 局部变化事实
  ├─ Appearance 页需求、去重与缓存查询
  └─ 每信号的候选率、历史有效性及刷新需求
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
材质字段更新                        照明任务生成
  静态页直接使用                      稀疏 primary / 强制刷新
  简单材质直接查源数据                 按 cluster/BSDF 分组
  仅求值动态缺失内容                   独立 diffuse/specular 率
          │                             │
          └──────────────┬──────────────┘
                         ▼
表面当前帧必要字段 + 稀疏直接照明 / 间接信号
                         │
                         ▼
按信号时域验证、空间重建与高频合成
                         │
        全分辨率不透明 HDR + 真正被消费者需要的字段
                         │
            现有透明/介质/FSR3/显示主链
```

这是依赖图，不要求每个方框对应一个全屏 pass。严格时序是先完成需求/分配，再更新内容，再消费；需要跨 workgroup 的发布在不同 dispatch/pass 间完成，不使用跨组自旋或同资源原地竞争重建。全部工作进入同一 FrameGraph 和 frame command context，不添加功能专用 submit。

## 4. 几何：解码与不变量不再在每个 pixel worker 中重复

几何 residency owner 管理 GPU 可直接使用的 resident attributes。静态页可在 residency fulfillment 时解码到分离属性流，随几何页一起淘汰，不长期复制整个世界的全部数据。Loader 只提供资产输入。若增加展开页，压缩存储、展开显存和驻留带宽共同计入预算。

本帧选中的几何建立 instance/representation-local 变换或形变数据；raster 和下游使用同一份结果。CPU 不读回本帧可见列表。姿态/实例变换相同的数据只生产一次。准备选中但最终被遮挡的内容也有成本，纳入几何统计。

Visibility 之后，只对真实获胜的 primitive 生成 Surface 需要的紧凑透视插值信息。输出包括活跃属性对应的插值系数/梯度，不存每三角形一份完整 model/world/clip 大结构。姿态、camera、representation 和页版本定义其有效期。

屏幕像素读取三角形插值信息，获得稳定材质地址、必要的目标法线/切线与梯度。位置可由 authoritative depth 重建；不需要世界位置的消费者不恢复它。透视、近裁剪、退化、非均匀变换的数学必须完整。

这是一套跨 raster/Surface 的新数据契约，替换现有按 workgroup hash 临时构造的大 Setup cache。其主要收益是减少重复解码和变换；不把几何成本消失或全像素零计算写成设计假设。

## 5. 材质：编译为数据、静态字段和少量动态程序

Material owner 在资源发布前完成图级分析：输入依赖、常量折叠、死通道删除、等价采样合并、静态子图与动态/视向子图分离。运行时不再遍历所有可能材质角色。

输出有三种确定的物理形式，均由同一编译器和材质语义拥有：

| 形式 | 最终处理 |
| --- | --- |
| 常量及简单已有纹理 | 直接使用常量/现有纹理页；不用运行时 Atlas 再缓存同一结果 |
| 昂贵静态、局部且视向无关的子图 | Cook 为 Appearance 页与必要 mip/filter 数据；原源数据可由资产/编辑需求保留，不要求生产双份驻留 |
| 动态、昂贵且可重复消费的子图 | GPU 只更新被需要且内容失效的页/样本 |

离线烘焙必须保持输入语义和既定质量预算；有动态参数、多 UV、顶点属性或非局部依赖的图，不会因为“看起来静态”就错误烘焙。纹理先过滤再算非线性函数，与先算函数再过滤并不天然等价，编译器需给出该子图的过滤合同。

不可缓存的视向项、非局部项进入对应专用程序。最终 BSDF 消费真正需要的字段。程序数量由有限功能族与资源 profile 限制，不按每个材质实例生成不同 pipeline，也不把所有复杂性重新放回一支 generic 内核。所有所需 pipeline 在场景进入渲染前异步创建，禁止在 draw 热路径首次同步编译。

Dungeon 的材质结果应成为：常量 baseColor、恒零 metallic、源 ORM 的 roughness/AO、目标几何法线。满足完整运行时采样签名一致时 ORM/AO 一次采样；dielectric specular 仍存在，metallic 为零不等于没有镜面。它能直接消费编译数据，也能对照明采用稀疏更新，不因自身材质简单而被迫增加 Atlas 开销。

## 6. 稳定 Appearance 地址与缓存

逻辑地址由资产/实例依赖、稳定表面域、局部坐标、材质版本和采样语义组成。物理 Atlas slot、当前 MeshletWork index、屏幕坐标均不是跨帧身份。

Cooker 生成 source-surface domain 和坐标，各输出 LOD 保持或显式映射这些坐标；多 UV、镜像、接缝、属性不连续和拓扑变化有明确边界。不能把 meshlet 当连续 chart，也不能假设 meshlet chart 对多组三角形和 UV 都存在一个仿射变换。

各 LOD 的 Appearance 映射可沿稳定 authored UV/独立 chart 传递；几何法线和位置来自当前真实 representation。失去对应关系的拓扑必须产生新 identity 或重新生成数据，不能默默复用旧结果。

缓存按字段与过滤需求管理：颜色、参数、emissive、tangent-space normal/其过滤信息分开。世界空间法线不作为跨实例材质缓存。ORM、normal-map、Coated 均没有整体禁用缓存的规则；各输入/lobe 独立确定更新和采样率。Normal variance 与 roughness 的耦合不能删除。

GPU 对需求去重，按固定预算分配，仅生成缺失/失效工作。相机变化本身不使静态材质失效；footprint 改变会提出不同 mip/各向异性需求。重新显露的页若仍有效可复用。材质版本、源纹理内容/可采样驻留数据变化、动态图参数和相关形变改变才使依赖字段失效。

物理页表和内容由一个 Appearance cache owner 管理。已存在的 source texture residency 仍由 texture owner 管理，缓存只持有明确依赖和版本，不出现第二份权威纹理发布。

## 7. 照明：取消全像素完整求值这个前提

| 信号 | 最终执行域与策略 |
| --- | --- |
| 直接 diffuse | 屏幕/cluster 内稀疏求值与历史复用；遮挡、光源集合、衰减与当前材质变化决定刷新 |
| 直接 specular / coat lobe | 屏幕域、视向相关；按 lobe footprint 和变化独立选择全率或稀疏，不把 coat 标签当整材质全率开关 |
| 间接 diffuse | 独立世界/表面域 irradiance provider，可跨帧更新；当前缺失 GI provider 不因本文被宣称完成 |
| 间接 specular / reflection | SSSR/世界查询等 provider 的屏幕需求；低 roughness、反射边界和新显露区域提高率 |
| normal / roughness 等消费字段 | 消费者所需精度独立于 lighting rate，SSR 需要的法线不能使用未经验证的粗率结果 |

直接照明初始支持 1×1、2×1、1×2、2×2；4×4 仅用于通过质量约束的低频信号，不作为整体 PBR 的默认率。SurfaceID、深度、材质变化与当前信号变化约束 sharing；历史低 contrast 只是候选和优先级，不能单独证明当前帧新细节安全。

照明历史存每信号的结果和有效性，强制刷新队列覆盖 disocclusion、身份/材质变化、光源影响、阴影变化、镜面不稳定和过期区域。相机移动不是所有信号一律全刷的理由；视向相关的 lobe 必须按当前目标重判。稳定历史不能永久保持不刷新，采用有界年龄及轮换校验。

照明任务保持 cluster 局部性，以有限 BSDF 族执行连续 primary packets；不能把重复 pixel lane 留在整波重 shader 中而称为减量。代表点正确处理自己的 light list，重建不能跨集合/遮挡不连续边界无条件传播。Cluster 边界切分或进一步按目标消费，不能借一个代表的灯表漏掉其他目标的灯。

Diffuse 近似与镜面、coat 的能量耦合需在目标合成处理。含视向相关 diffuse BRDF 的模型不能把照明全部写成单一无视向 RGB irradiance。缓存直接 radiance 时明确其位置、法线、材质、视向与光源依赖；仅有静态材质 identity 不足以使光照历史有效。

对当前便宜的天空 LUT 等项，允许在最终专用合成程序中直接求值。间接 irradiance provider 缓存入射光时，必须表达目标方向需求；不拿一份 RGB 向量宣称可以精确覆盖任意目标法线。

## 8. 重建与每像素最终成本

最终全分辨率处理读取真实 winner/depth、紧凑 Surface 地址、当前必须保留的高频字段，以及各信号有效结果。它不再运行通用十角色材质程序和全部光照循环。

重建先验证 temporal identity/变化/footprint，后做同域空间重建；镜面与漫反射分别进行，拒绝轮廓、接缝、不同表面和不同 lobe 的无条件混合。低可信区域直接消费本帧刷新结果，避免把历史 clamp 当成新表面漏算的替代。

Shading 信号历史与 FSR3 的输出重建分工明确：前者解决稀疏着色，后者解决显示重建；显露/变化/reactive 信息要传递，不能叠加两个无独立误差控制的时域滤波器。辐射缓存使用场景线性、未预曝光值，最终输出统一转换/预曝光；历史不会因曝光改变而被错误重新解释。

只物化有真实消费者的法线、roughness 等字段，不建立默认全屏完整 closure GBuffer。缓存采用字段适配的紧凑格式，identity/页表独立存储；不继承每个 sample 八个 rgba32uint texel 的128-byte默认表示。精度需对应实际信号误差，不能只为缩格式任意丢失 HDR 范围或法线精度。

## 9. 生产执行与 owner

| Owner | 职责 |
| --- | --- |
| Geometry/Product/Cooker | 几何页、Surface 坐标与 LOD 映射；当前表示的有效属性 |
| Geometry residency/frame geometry | 驻留属性准备、帧内变换/形变、可见 primitive 插值信息 |
| Material/texture | 编译、原纹理发布、静态 Appearance 产品和采样合同 |
| Appearance cache | 动态材质页需求、内容有效性、物理页和更新任务 |
| Temporal facts | motion、稳定 identity、显露与局部变化事实；只有一个权威生产者 |
| Lighting providers | 直接/间接/镜面各信号的任务、结果、历史与相关失效 |
| Surface reconstruction | 当前目标字段、各信号重建、能量合成、HDR 和 demanded fields |
| Frame runtime | 有限拓扑、资源生命周期、统一命令编码与唯一 submit；Renderer 仅 composition root |

缓存容量和 sparse work 容量创建前按 limits 确定。Producer 在输出前完成 reservation/commit，consumer 只读已发布内容；溢出不产生非法地址或半写结果。未获得缓存位置的可见区域在同一主链直接求值或使用已验证的较低 mip，不能采样随机页、漏写或等待 CPU 决定本帧补做。

正常 shader 编译掉观察性统计原子；性能控制所需计数保留，不能误删预约计数。Validation 和不变合同检查集中在 cook、发布与任务生成边界，热 consumer 不反复验证已经保证的不变量。动态 residency、影子/历史失效、容量与写域互斥是算法合同，不能以“不防御性编程”为由删除。

缓存跨帧保留，但 scene/product/device epoch 定义归属。Resize 只重建屏幕域资源；camera cut 丢弃屏幕照明历史，不无条件清静态 Appearance；device loss 重建实际 GPU 数据与依赖。设备能力协商在创建前，baseline 不依赖硬件 VRS、Mesh Shader、硬件 RT、通用 bindless 或固定 subgroup 宽度。

## 10. 一次性切换与删除范围

**删除发生在新主链实现的起点，不等待新消费者、阶段测试或浏览器出图。** 以下是代码实施指令，本文修订本身没有删除这些当前源码。

| 当前入口/实现 | 直接处理 | 最终归属 |
| --- | --- | --- |
| `SurfaceMaterialPass.ts` 的旧 `addToGraph`、program 缓存和旧资源创建 | 整段移除，不增加新旧分支；该文件可按最终职责重写或删除 | 新 Surface composition 和有限程序准备 |
| `FrameProgramLowering.ts` 的旧 Surface 参数与产物依赖、`RendererCore.ts` 的旧 Surface 初始化/销毁与绑定 | 同批撤下旧接线，不保留转接旧输入/输出的 adapter | 最终 geometry/Appearance/lighting/reconstruction 产品 |
| `SurfaceProbePass.ts`、`SurfaceProbe.ts`、`surface_probe.ts` | 删除逐像素 ProbeFact、邻居风险和预算调度；移除配置、计数器等残余依赖 | 新需求和分信号率判定 |
| `SurfaceSampleAbi.ts`、`surface_sample_work.ts`、`surface_sample_result.ts`、`surface_sample_resolve.ts` | 删除旧 descriptor/compact/fallback ABI、工作池、128-byte results 和 Resolve | 新有界 demand/task、字段缓存与信号结果 |
| `surface_sample_worker.ts`、旧 generic material program | 删除完整旧 worker 和十角色运行循环；所需准确采样/BRDF数学直接迁入最终编译器/内核 | 有限 Appearance 与 BSDF 程序族 |
| `surface_triangle_setup.ts` 的旧大 workgroup cache | 删除旧 Setup owner/缓存执行组织；所需插值数学直接迁入共享几何 | resident/frame geometry 与 winner coefficients |
| 无条件全屏 closure-lighting 和 ORM/双面/normal-map/Coated 整体 full-rate 分类 | 删除默认执行与旧类别限制，不先调参优化 | 独立 diffuse/specular/coat 工作与重建 |

上述列表覆盖关联配置、计数 ABI、shader import、Graph 节点、无消费者资源、旧合同与测试期待。共享数学文件若有其他有效 owner 消费，只移除旧入口并保留所需数学；不得借共享文件名保留完整旧执行链。旧诊断宿主可以停止工作，最终统一更新或删除，不为维持它们先跑旧链回归。

保留现有 GPU Scene、VG hierarchy/residency、authoritative Visibility/depth、灯光/VSM/环境语义和独立 Temporal owner；按最终数据流直接修改其连接，允许重写受影响的跨 owner 合同。旧新对照只在最终验收使用固定 Git revision 的独立 checkout/宿主，不将旧生产依赖带回当前树，也不增加生产 A/B 开关。新 HDR 唯一 producer 与必要输出接通前允许没有完整画面。

## 11. 来源与本地设计边界

| 来源与固定版本 | 已核读具体入口 | 对应最终架构 | 不可冒称的部分 |
| --- | --- | --- | --- |
| Wicked Engine `df44c3db4c4927492bc9c791eac715d98d7ed091`，MIT | `visibility_analyzeCS.hlsl`、`visibility_resolveCS.hlsl`、`visibility_shadeCS.hlsl`，`wiRenderer.cpp::Visibility_Shade` | uniform/divergent tile、shader-type bins、GPU indirect workers | wave/bindless接口不直接移植；它不提供本地多域缓存全算法 |
| The Forge `cd5046893faba2dc7869243873bf01f02a6f0df9`，Apache-2.0 | VisibilityBuffer2 interpolation utilities；15a 的 `fillStencil.frag.fsl`、`resolveVRS.comp.fsl`、`VisibilityBufferShade.frag.fsl` | 透视插值/梯度、可见身份、软件复用参考 | 原方案的资源/采样接口和 VRS 组织需完整映射，不称同名就是 port |
| WeakKnight OSS `473a59bbcdd30e3366cc567d66a5a97353620d48`，Apache-2.0 | `ObjectSpaceShadingPipeline.cs`、`RenderTaskProcessing.compute`、`ShadelMemoryProcessing.compute`、`RenderTaskPrelude.cginc`、`VirtualRenderTexture.cginc`、论文 | occupancy → 分配 → task/indirect → 虚拟寻址/过滤/历史 | 作者方案含 Unity/RT/ReSTIR GI；本地材质编译、VG LOD identity和照明调度不是直接移植 |
| DOOM GPC 2025，71页技术资料，无完整可复制代码许可 | 第11–24页 SRI/primary/remap/compact；第25页VGPR问题；第52页平台性能；第58/62页未来方向 | 屏幕照明分率、连续执行、独立法线消费的依据 | SurfaceID及进一步分率属于建议；不套用其收益或照搬原地UAV竞争 |
| FastAtlas EG2025作者页、补充说明及 shader 包 | chart/union-find/bounds/packing；Appendix A | Chart 构造/参数化/Atlas packing 技术依据 | 缺完整工程入口/完整许可核对，不能登记完整算法已采用；逐帧packing不能作为稳定跨帧身份 |

固定链接：

- https://github.com/turanszkij/WickedEngine/tree/df44c3db4c4927492bc9c791eac715d98d7ed091
- https://github.com/confettifx/The-Forge/tree/cd5046893faba2dc7869243873bf01f02a6f0df9
- https://github.com/WeakKnight/real-time-seamless-object-space-shading/tree/473a59bbcdd30e3366cc567d66a5a97353620d48
- https://static.graphicsprogrammingconference.com/public/2025/talks/variable-rate-compute-shaders-in-doom-the-dark-ages/Fuller-Hammer-variable-rate-compute-shaders-in-doom-the-dark-ages.pdf
- https://www.cs.ubc.ca/labs/imager/tr/2025/fastatlas/
- https://developer.nvidia.com/blog/texture-space-shading/

完整算法实施前继续按根 AGENTS 核读选定来源的完整依赖、关键分支、过滤/容量/失效条件并写入 `docs/porting/next-renderer.md` 的逐项阶段映射。上述核读范围不是完整移植完成声明。本方案是具名本地组合设计；没有一个已核验 donor 完整覆盖 EEngine 的全部 geometry/material/cache/lighting/WebGPU 合同。

## 12. 最终验收，不用样本计数代替性能

以下项目在整个缓存/稀疏照明/重建目标代码和生产接线完成后集中执行，不作为中间模块的继续实施条件。先修 typecheck/build 与真实 shader 编译失败，再执行数值、完整覆盖/互斥、生命周期、浏览器、连续画质与性能比较；发现失败就在新链返工并重测受影响范围。旧组件通过记录只是历史诊断，不能代替这些最终检查。

两组相机由真实 GPU visible coverage 校准：25%–35%和80%–90%。锁定输出与内部分辨率、场景/材质、功能和测量相机。必须包含静止、持续移动、绕视角、新显露、光源移动、材质修改、LOD/residency变更；不能用静止缓存全命中代表全部收益。

基准为已记录 Git revision 的唯一旧主链，独立宿主运行；正式比较使用一致的最终功能和画质目标。低分辨率+FSR3可以是独立产品档位，但不能暗中改变尺寸来证明本重构收益。

提出的性能验收门槛是：同画质目标下，两组覆盖率的 Surface 总成本 P50/P95分别至少降低50%，完整 GPU pass合计 P50/P95分别至少降低30%。这是激进工程目标，不是已测预测；未达即不得宣称性能目标完成。实际帧间隔/吞吐与CPU编码另报，不把pass耗时合计冒充完整GPU时间线。

对于可降率的静态/缓慢运动区域，昂贵 lighting primary 工作目标为可见像素的25%–40%；高频/显露等必算区域单独记录。Appearance 缓存记录 miss/失效更新量，不强迫简单直接纹理材质得到虚假的低 material invocation 数。对纹理 fetch、几何解码/变换、完整BSDF、shadow query、cache query和实际launch分别计数。

整段计入需求、去重、几何准备、缓存/页表、任务、重求值、历史验证、空间重建、最终合成、内存和冷启动；所有慢帧保留。热降频/系统竞争条件不匹配的批次不得用来归因架构收益。

画质比较包括当前完整语义参考、ORM/AO、双面、normal-map、Coated、锐利/移动高光、阴影/灯表边界、UV接缝、LOD与显露。检查静帧和连续视频的ghosting、flicker、细节丢失与反射法线错误。局部误差指标、整图指标和目视检查共同决定各信号预算，不捏造通用阈值或“绝对无损”。

真实编译、核心WGSL/CPU数值与完整覆盖/互斥oracle、生产GPU producer→consumer都必须通过。没有实际证据前，不能把本提案描述为瓶颈已经解决。
