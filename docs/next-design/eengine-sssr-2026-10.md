---
id: eengine-sssr-2026-10
state: current
verifies:
  files:
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/render/RendererConfig.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program
    - OEngine/src/render/surface/SurfaceV4.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/GpuNativeMaterialPublication.ts
    - OEngine/src/gpu/NativeMaterialBindings.ts
    - OEngine/src/render/HierarchicalZBuffer.ts
    - OEngine/src/render/temporal
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/shaders/native_surface_lighting.ts
    - OEngine/src/shaders/working_color.ts
    - OEngine/src/debug/RenderDebugView.ts
    - OEngine/src/render/passes/RenderDebugViewPass.ts
    - OEngine/src/shaders/render_debug_view.ts
    - docs/porting/next-renderer.md
---

# SSSR：Native 材质的屏幕反射与完整反射去噪

## 1. 决定与范围

以 `1d1a67fc` 为源码起点，2026-10-15 完成细设计。唯一实施与结果入口为[执行计划](../next-execution/eengine-sssr-execution-2026-10.md)，总体方向见[功能粗路线](eengine-feature-expansion-roadmap-2026-10.md)。本文规定目标，**尚未实现**；不把来源阅读或旧 shader 的存在算作生产能力。

选择 FidelityFX SDK v1.1.4 中 **SSSR 1.5 + Reflections Denoiser 1.3 的 FP32 profile**，完整移植分类、蓝噪声、GGX VNDF、层次追踪、命中验证、环境补缺及三阶段反射去噪。采用当前内部渲染分辨率，分别处理 base specular 与 clearcoat；两者保留独立法线、粗糙度、响应和历史。支持当前 opaque/MASK winner、ordinary/Product geometry、Native/FSR/关闭颜色AA，不增加第二套材质求值。

本模块不含 Local Reflection Probes、透明反射、硬件RT、SSGI、递归反射或通用 ScreenTraceProvider。屏幕缺信息由现有 global specular environment 补齐；没有环境资源时沿现有黑色环境合同。SSR 不承诺反射不可见物体、所有动态遮挡或多次反弹。

## 2. 代码事实与方案裁决

| 当前源码事实 | 决定 |
|---|---|
| `native_surface.native_environment` 已含 DFG-weighted base specular、coat Fresnel 与底层衰减，最终 HDR 已含 IBL | 发布实际已算出的响应与所选 IBL baseline，按同 lobe 替换；不直接相加 incident radiance |
| native lighting 在 linear Rec709，HDR 写为 linear Rec2020×GPU pre-exposure | trace/denoise 使用预曝光 Rec709；材质响应乘法完成后再转工作色域 |
| 最宽 lit Product+compact Surface 为15个storage buffer、4个storage texture；材质资源组没有额外storage buffer | 反射专用32B/像素SSBO占第16个buffer；不增加第5张Surface storage texture，不扩全局GBuffer |
| 裁剪HZB是半尺寸起步的RG16F reverse-Z min/max，含保守half量化 | SSR拥有全尺寸起步的R32F nearest-depth层级；不改变几何HZB或AO私有weighted depth |
| 所选SDK `Intersect` 只读取当前input color的mip0 | 不创建颜色金字塔，不复活`SharedColorPyramidPass` |
| Native Seed 已有运动、深度、identity和response；Native/FSR各有颜色历史 | 消费稳定公开Seed语义；反射radiance/statistics/几何历史独立归SSR，不借颜色AA历史 |
| `GpuNativeMaterialScene` 异步准备descriptor、lease和binding快照，submit后原子发布 | 新输出布局须进入完整物理profile；图、Surface和全部材质route同帧选择，准备未齐则defer |
| 旧SSR shader基于retired GBuffer/THREE来源；SSR debug目前无真实输入 | 新链原子接入并删除旧SSR专用路径；共享且仍在用的fullscreen/helper先迁到中立文件 |

比较过：固定多张GBuffer会增加无关输出且不解决响应；另开一次材质/BRDF求值会重复几何、导数、纹理工作；额外array storage texture会把Surface写输出从4推到5。本方案选择有真实consumer的一个packed buffer，保留fused Surface。代价是32P写入/读取及buffer binding容量约束，见§8；不同时保留另一种生产sidecar后端。

## 3. 设置、需求与物理profile

新增 `render/reflections` 模块，公开 `ScreenSpaceReflectionsSettings`、默认值与原子解析；`RendererConfig.screenSpaceReflections` 为初始partial，运行期为只读快照与 `setScreenSpaceReflectionsSettings(patch)`。Renderer只组合owner，UI不拥有第二状态。

| 字段 | 默认 | 合同 |
|---|---:|---|
| enabled | false | boolean；保持现有默认画面与关闭成本 |
| strength | 1 | [0,1]；最终修正比例，0按关闭处理 |
| quality | balanced | balanced/high：分别1/4 samples-per-quad；不降低内部尺寸或删去噪阶段 |
| maxRoughness | sqrt(0.2) | (0,1]，公开perceptual单位；内部比较α=r²，阈值严格小于 |
| thicknessMeters | 0.015 | 正有限米数，转换为world units；沿源hit-validation距离语义 |
| metersPerWorldUnit | 1 | 正有限值；不改几何、相机或材质单位 |
| temporalStability | 0.7 | [0,1]，源history clipping控制，不解释为简单历史lerp系数 |

派生平方、除法和shader常量也须可表示为合法非零/有限f32；非法patch全部拒绝并保留旧快照。极小阈值可能自然没有合格receiver，不能偷偷改材质现有0.04粗糙度下限。固定profile为最多128次traversal、mostDetailedMip0、variance-guided开启/threshold0、minTraversalOccupancy0。最后一项取消wave占用率提前退出，保留有界完整追踪；不是降低画质的近似。variance>0能将稀疏像素提升为全rate，balanced不保证四分之一射线。

有效需求为 enabled、strength>0、非空且有lit surface consumer；关闭/all-unlit/empty不造反射产品。物理输出profile仅 `off | sssr-base-coat`，进入Native descriptor、完整layout规划及lease key；所有dense/compact、ordinary/Product、lit/unlit route同时准备。混合场景的unlit winner仍是合法反射命中物体，须写几何法线但不成为reflective receiver；不能仅从lit dispatch写一个不完整屏幕buffer。

仅有效启停改变FrameProgram结构；quality与其他数值逐帧晚绑定，不进入材质ProgramKey或形成无界PSO变体。物理输出变化不能伪造材质内容revision、相机cut或改变coverage身份。prepared/candidate快照在defer/abort时不提前提交，图不能读到半切换的布局。数值变更在cache命中图中也生效。

## 4. 产品、颜色与能量

### 4.1 Native 唯一writer

新增semantic `reflection-surface`，仅有效SSR声明。一个32B/像素storage buffer，按完整viewport线性寻址，每项8个u32；用 `pack2x16float` 存四个vec4，不要求shader-f16：

| 8B区块 | 内容 |
|---|---|
| 0 | base world shading normal.xyz、canonical αbase |
| 1 | coat world shading normal.xyz、canonical αcoat |
| 2 | Wbase.rgb（Rec709）、Wcoat scalar |
| 3 | Bselected.rgb（预曝光Rec2020）、有效surface/base/coat三bit mask，half可精确表示 |

α统一为从Native有效r²转half再解码的值，分类、trace、denoise、baseline选择共用此值；normal读取后按源需要归一化。不用oct坐标的线性插值替代xyz插值。当前源的classify用float roughness而后续读R8 extracted roughness，在r≈0.04处可能跨mirror阈值；本地明确改为同一half α，保精度并消除跨阶段分歧，不宣称逐bit等价。

`Wbase=(1-Fcoat)*environment_dfg_single_scatter(dfg,F0)`；`Wcoat=Fcoat`。`Bselected`来自本次Native实际计算的被选择lobe贡献之和，不重新采样环境、不从HDR猜baseline。无贡献/超阈值lobe的W和B为0，继续保留其原IBL。Physical Sun diagnostic mode须与原environment开关一致，不能关闭IBL却仍减baseline。

有效winner每像素唯一写完整record；unlit用既有resolved world plane得到face normal，receiver flags/W/B为0但保valid-surface bit。一次buffer clear先初始化完整域，background/无效/失败early-return保留0，只有真正属于本route且完成求值的winner覆盖；不匹配route的return不得清掉其他route的record。dense/binned同合同，不能依赖旧帧或新分配的零。此clear是已知有界成本；不为off配置保留资源。MASK直接使用现有exact coverage winner，不修改alpha纹理/visibility/VSM。

### 4.2 无环辐射版本与修正

令M为既有Rec709→Rec2020线性矩阵，P为当前GPU radiometry multiplier，H为现有Surface HDR。追踪只读 **SSR之前、不含Sky/Aerial的当前opaque H**；hit callback以M的数学逆变回预曝光Rec709，环境callback按世界反射方向采现有环境mip0并乘同一个P。无需颜色金字塔或上一帧最终HDR，不能读取正在修正的当前结果。

`Intersect` 内部先按validation confidence混合 environment 与hit radiance，再由完整denoiser输出每lobe的Q；Q在算法内是预曝光Rec709 incident radiance。源RGBA的A是 **world ray length，不是confidence**；本地将此值分离到一张shared R32F当前ray-length纹理，避免world units/大场景距离溢出half，辐射纹理A不再承载长度或confidence。最终新产品 `opaque-reflected-radiance`：

```text
S = M(Wbase * Qbase + Wcoat * Qcoat)
CorrectedOpaque = H + strength * (S - Bselected)
```

RGB乘法在Rec709完成；不能把W直接逐通道乘Rec2020颜色。不能再次乘hit confidence、DFG、coat attenuation或screen AO。AO继续只作用于当前diffuse IBL。非选中lobe不参与减法。strength0使用原H且不执行链；strength1替换所选镜面间接项，direct/diffuse/emissive仍来自H。FP16 baseline量化和减法有误差，核对实际格式的误差界，不能加无依据的HDR clamp掩盖双计或负能量。

物理radiance/history/reproject/average纹理均以 **预曝光Rec2020 RGBA16F** 存储，load/sample callback在线性过滤后转回Rec709 F32，store转回Rec2020；上式Q指已decode的算法值。这样不把原本可表示的工作域HDR先倒转色域后塞进Rec709 half造成溢出。所有源radiance统计、距离权重、AABB clip仍在Rec709 F32执行，不能直接换成另一套色域权重。workgroup radiance/统计使用F32，替代源FP32分支内仍存在的pack-half shared arrays，避免weighted8×8累加越过half范围；这是提升中间精度的适配，不删步骤。源存储量化与此实现不逐bit相同，验证对齐明确的存储色域/精度边界。

源算法miss采的是沿随机反射方向的环境mip0，经过时空滤波，和现有prefiltered IBL不是逐帧逐bit相同；因此不承诺“所有miss必与关闭SSR完全同图”。这是所选stochastic环境补缺的限制，不能伪造confidence0绕过整个源流程。后续probe模块再修改明确的radiance来源，不由本轮预建。

主链为 `Surface H/sidecar → SSSR → corrected opaque → Sky → Aerial → Native/FSR/bypass → exposure/bloom/display`。新增 `reflection-depth` 与 `indirect-specular` 只给真实consumer；SSR内部两lobe资源由一个owner管理，FrameGraph仍声明完整宏依赖、读写版本和寿命，不建EffectsManager。

## 5. 保留完整源算法，适配执行方式

固定源码、license、函数映射见[来源R06](../porting/next-renderer.md#r06--fidelityfx-sssr--reflections-denoiser首选反射链)。不混入旧独立SSSR或retired THREE实现。选择FP32算术与F32 workgroup，保留纹理half格式并按§4声明存储色域；不把中间精度提升伪称源bit-exact。

| 阶段 | 必须保留的工作 / WebGPU落点 |
|---|---|
| Depth hierarchy | 从最终Depth复制全尺寸R32F mip0，reverse-Z取max nearest，lastMip=min(6,floor(log2(max(W,H))))，所有读取（包括源validation的mip1）按实际级数限定。逐mip dispatch替代SPD跨组同步；按真实mip尺寸保守覆盖NPOT末行列，traversal网格也用实际尺寸。不能沿用 `size*2^-m` 的fractional mip假设或用half culling HZB顶替 |
| Classify | 8×8逻辑tile/64lane；roughness、有效receiver、mirror全rate、1/4基础样本与variance提升、quad X/Y/diagonal copy flags、ray/tile两类列表。以完整64lane共享内存prefix/quad坐标读取适配wave，不假设subgroup32/64或lane xor等于屏幕quad；OOB lane仍参加barrier但不写像素 |
| Blue noise | 固定源1spp Sobol与scrambling表、128²RG8蓝噪声、golden-ratio帧相位；两lobe共享每成功帧的一次生成，不换成hash noise，ranking表在该选定代码中未消费则不上传 |
| Prepare indirect | GPU计数生成trace及denoiser args，不CPU回读；ray records为pixelLinearIndex+copyFlags共8B，tile为32bit线性tile index，避免源15/14bit像素坐标截断 |
| Intersect | 完整GGX VNDF局部基、stretch/sample/unstretch，perspective投影方向、coarse/fine hierarchical advance与self offset；有效步数/边界终止、两像素self rejection、背景、背面、view-space厚度、screen-edge fade、confidence²、mip0 hit color、环境混合和quad复制。命中背面检测读取hit的base shading normal，unlit读取face normal，不随当前receiver的coat lobe换hitnormal |
| Reproject | surface motion与ray-length virtual-hit/parallax两种候选、normal/roughness选择、9×9 Gaussian局部统计、disocclusion、3×3搜索及逐tap合格的2×2双线性修复、sample count/variance更新、8×8亮度加权平均；不能只用Seed motion替掉virtual-hit分支 |
| Prefilter | 中心+源15个Halton邻域，normal/depth/radiance/variance全部权重，mirror的源条件跳过；不改成简单3×3 blur |
| Resolve temporal | 完整9×9统计、tile average引导、AABB history clip、低sample count恢复、当前outlier clip、样本数驱动混合、normalized variance和dark分支；不能用一次mix历史代替 |

classify的实际tile计数包含glossy mirror，不能根据“镜面不denoise”的注释删掉整tile；只按各源阶段自己的mirror条件处理。超阈值的non-glossy环境分支由Native原有prefiltered IBL承接，不再在SSR重复采一份；这是明确的本地合成适配，不能把全SDK所有分支宣称为逐bit照搬。

源 `valid_hit=(iteration<=budget)` 不足以区分所有退出原因，本地明确只有达到精细有效surface才能命中；超步数、退屏、无效方向走环境，不夹边界假造hit。零confidence的无效hit输出finite ray-length0并使用surface history候选，不能把退屏的无效投影长度送入virtual-hit；有效hit保留真实world length。最后用full-res Depth验证，NPOT层级/终止行为是有独立预期的正确性适配。

VNDF理论核对 [Heitz 2018](https://jcgt.org/published/0007/04/01/paper.pdf)，实现仍以固定SDK函数为准，不自行换成普通NDF或固定镜面方向。64lane portable scan有同步开销，但不损失必要步骤；subgroup加速留给后续实测优化，不引入两套现在就要维护的kernel。

## 6. 历史、完整写域与事务

SSR owner保存两lobe各自的radiance双槽RGBA16F、variance+samplecount双槽RG16F、average双槽RGBA16F/8×8tile；几何历史为两层RGBA16F normal+α与一张R32F depth。复用公开previous Seed identity，不复制全局closure history。shared scratch只在两lobe **严格顺序** 工作时重用，base全部完成再coat；Graph要有真实依赖，不能凭pass插入顺序赌资源不重叠。

每lobe调度：Classify完整初始化当前trace radiance、ray length、next statistics及当前tile-average（4个storage texture）；Reproject读取旧history后，旧radiance槽以render clear清零，再作为Prefilter输出；Resolve写trace槽为最终Q并写next statistics。这样既沿源复用radiance双槽，又不让inactive tile的旧值污染9×9 halo。shared reproject RGB、reproject statistics及prefilter variance有独立资源；不能把一次pass的sampled输入同时绑成storage输出。奇数边界的halo按源clamp规则加载、所有valid输出唯一写；未执行tile以已清的中性值存在。

两lobe历史读取都完成后，用一个snapshot dispatch把当前normal+α及Depth写入几何历史；无有效receiver的lobe写invalid α=-1。history callback逐tap检查invalid，不能先把-1与有效α插值再当roughness用；不完整候选进入源per-tap repair，不让inactive历史参与平均。当前与历史用各自的inverse projection，source motion按EEngine `previous_uv-current_uv`、Y向下映射；当前/上一帧实际jittered矩阵成对保存，不再额外叠jitter。R32F depth的bilinear callback手动四tap，不要求float32-filterable。

Seed的previous-valid/response与完整identity tuple用于surface候选的失效检查；virtual-hit仍执行源normal/depth/roughness与局部radiance检查，不把它当真实reflected-object motion，也不盲目用virtual UV处receiver identity相等来替掉源选择。快速移动亮物体/动态遮挡是必须实际观察的局限；若出现持续旧反射，修本模块可靠性，不能用“颜色AA会修”关闭。

P来自`GpuRadiometryPass`的GPU current/prior multiplier，不能使用当前CPU `PreExposureContract.multiplier=1`冒充真实曝光。历史RGB按Pcurrent/Pprevious缩放，ray length不缩放。源brightness-weight helper的固定luma floor、variance分母floor、dark阈值、ClipAABB epsilon与radiance-distance权重须逐项按场景线性语义换算：对brightness度量使用Li/P，在线性radiance域的epsilon/阈值按P缩放；统计均值/标准差与信号一起缩放。normalized variance不盲乘P²。保留源Rec709 profile的luma系数，不把Rec2020 luma偷换进去。FP32计算与实际存储边界按§4；有限HDR域沿当前工作域rgba16float合同。曝光跳变使旧history重标后无法在该域表示时，仅拒绝该无效历史并按源新样本分支重建，不能生成Inf后靠黑色guard伪装有效。异常不能用吞掉NaN或永久黑色来算验证通过。

CPU只在成功frame submit后提交SSR帧序号、noise phase、history角色、设置签名和前帧矩阵；defer/abort不推进，未提交的clear/snapshot随encoder丢弃。前后帧GPU排在同一队列顺序上，不增加frame submit。buffer/texture/PSO lease保持到最后consumer fence；resize/recovery先有完整candidate，预算允许才创建。cached graph只保稳定device期owner，当前workset/views从帧bindings获取，不捕获已退休history；关闭/empty/all-unlit成功切换后退休旧资源，不能因cached graph还保留无consumer全尺寸history。

启停、质量/阈值/厚度/尺度/stability、尺寸域变化与真实cut重置SSR累计和必要颜色历史；仅strength正值间变化保SSR累计、只reset颜色。保geometry/HZB/VSM/曝光身份；普通运动不全清。off中的无关编辑不反复reset；defer/abort保pending变更，recovery checkpoint保存desired设置及内存配置。

## 7. 容量与能力边界

容量按P=W×H、T=ceil(W/8)×ceil(H/8)精确规划：每lobe最多P条ray、T个denoiser tile，两lobe顺序共用8P ray buffer与4T tile buffer。每tile一次全局ray-range reservation、一次必要tile append，所有有效ray有空间；不截前缀、不丢tail换预算。linear index与字节乘法先在CPU安全整数范围核验，GPU派发生成用有界u32。trace与denoiser indirect支持二维group flatten，避免大尺寸时单轴超过maxComputeWorkgroupsPerDimension。

创建资源/发布profile前核对实际完整descriptor的storage buffers/textures、sampled textures、workgroup storage、纹理尺寸、maxBufferSize、maxStorageBufferBindingSize和dispatch。当前Renderer已请求adapter的buffer-size/storage-texture上限，并至少16个storage buffers；本方案不新增subgroups、shader-f16、float32-filterable强依赖。外部device按实际device.limits核对。绑定规则依据[WebGPU规范](https://www.w3.org/TR/webgpu/)，不能用adapter上限冒充未申请的device能力。

单receiver buffer为32P：1080p=66,355,200B；4K=265,420,800B，已超过128MiB binding，但可放进256MiB。能力不足时明确拒绝该尺寸/profile，不能默默裁像素、降尺寸或换另一renderer。受支持的新GPU仍可在实际limit与预算内放大；本模块不承诺所有device跑4K。

沿现有`frameGeometry`配置风格新增不可变 `RendererConfig.screenSpaceReflectionsMemory { maxBytes?, ownerMaxBytes? }`：默认384MiB/active view、768MiB/owner，包含所有view/candidate/fence-retired反射资源与全局noise一次；独立于运行期七项画面设置。分配前以真实descriptor+alignment求和；尺寸变化不能无限积攒旧代。active超限明确报容量错误；仅因旧代未退休不足则defer并在其fence完成后重试，不启动额外submit或CPU visible-work回读。提升预算也不能越过device限额，这两个数不是整Renderer 4GB资格。

## 8. Cost Card：达到新反射能力的必要ADD

P为内部像素数，T为8×8tile数；以下是同时支持两lobe的逻辑资源，不含已有Surface HDR/Seed/Depth/IBL，也不当作driver物理驻留。

| 新资源 | 字节 / 生命周期 |
|---|---:|
| 当前Native receiver buffer | 32P，当前帧 |
| previous normal+α两层 / depth | 16P+4P，跨帧 |
| 两lobe radiance双槽 | 32P，跨帧/阶段复用 |
| 两lobe variance+samplecount双槽 | 16P，跨帧 |
| 两lobe average双槽 | 32T，跨帧；RGBA16F替代源R11G11B10存储 |
| shared reproject RGB/statistics、prefilter variance / ray length | 8P+4P+2P+4P，同帧顺序scratch |
| R32F depth mip0..6 | 所有长宽比≤8P；普通1080p约(16/3)P，按实际mip尺寸求和 |
| shared ray/tile列表 | 8P+4T，计数/args另计小量常数 |
| corrected opaque HDR | 8P，同帧 |
| Sobol/scrambling/动态蓝噪声 | 786,432+32,768B，device期/有效帧 |

不计alignment合计≤142P+36T+819,200B；为极窄viewport保留正确mip上界，预留常量/对齐的规划上界 **143P+40T+1MiB**，1080p约285.02MiB。实现必须用真实descriptor核对该上界，不从pool账本猜独占显存；confidence debug另加4P，仍须通过同一预算。退休代和并存其他owner另计。这个ADD在功能优先阶段可接受为明确代价，尚无GTX1650Ti实际帧时/4GB同时峰值结论。

每有效帧公共depth最多7 dispatch、noise1、geometry snapshot1、composite1；每lobe classify/args/intersect/reproject/prefilter/resolve共6 dispatch，另一次radiance render clear；计数reset用encoder clearBuffer，背景receiver clear与全域初始化明确计入。两lobe上界22 compute dispatch+2个render clear（不含既有Surface/调试），同一frame encoder。空ray/tile由GPU args令昂贵间接work为0；CPU不读活跃数。理想无receiver但功能有效仍有O(P)分类/产品成本，关闭则没有这些工作。

追踪上界两lobe共2P ray×128 hierarchy iterations；每步深度random load，hit color/normal、环境插值另计。去噪每个active tile有16×16halo协作加载、9×9统计、15邻域filter与多次history sampling；ALU、random texture access和shared barriers是实际必要税。Rec2020存储callback增3×3颜色矩阵ALU，线性过滤后只做一次转换，不能在9×9 inner loop反复转色域。F32 shared按vec4 radiance、vec4 normal、vec2 depth/variance规划，prefilter约10KiB、其余≤约4KiB，核实静态总量后须低于实际device的workgroup storage limit；精度适配相对源pack-half增加shared工作集，不能当作免费。Native新增≤32P sequential store与baseline/response pack，另有32P逻辑buffer clear，不重复material samples/BRDF；不能只报一次sidecar写入而漏初始化。最坏variance提升让balanced接近high，不填写虚构expected毫秒；在真实目标场景记录active ray/tile、资源和粗成本。

稀疏分类作为源profile保留：若需求射线比例q，理想trace节省(1-q)R，付出固定分类/scan/queue/copy工作C，break-even为(1-q)R>C；0/50/100%节省分别为-C、0.5R-C、R-C。100%这里指相对全rate省去全部可省trace，不代表省去必要denoise/Surface工作。不能据balanced名称或dispatch减少宣称性能收益；不要为实现初期另造cache或megakernel。

## 9. 所有权、切换与最小验证

建议文件owner：`render/reflections`保存settings、容量规划、资源/历史及阶段编码；`shaders/sssr_*`保留可审计源阶段；GPU ABI共享writer/reader常量。`GpuNativeMaterialScene`与`SurfaceV4`负责实际物理输出布局和发布，FrameProgram/Lowering表达真实消费，RendererCore负责组合与checkpoint，debug读取正式产品。细文件名可随实现依赖组织，不新增独立pipeline框架。

先完成非生产完整算法闭包，再以一个单元原子接上全部Native/FrameProgram消费者。新生产链稳定后删除无人消费的旧`ssr_trace/resolve/denoise/stochastic_sample`；`ssr_common`中仍被motion blur、shared color pyramid、debug引用的fullscreen与math先分离到中立helper，优先沿用已有`fullscreen_triangle`，保留存活消费者，不能连带删除或复活旧owner。四个SSR debug重接真实trace hit-confidence、prefilter、最终temporal、reprojection接受度；说明base/coat选择和阶段含义，不沿用“temporal前另有最终spatial”的旧描述。prefilter/temporal读取现有正式产品，confidence/接受度仅在对应debug下额外分配所选lobe的4P float诊断buffer，分别由实际trace复制或reproject阶段写，计入内存预算；不把ray-length alpha当confidence。关闭时明确无有效SSR输入，不强制打开反射。

执行只分两单元，验证详见执行计划：小型独立GPU算法fixture + 一个真实Renderer模块fixture、有限CPU合同与一次集中build。必须覆盖数学、能量、曝光、奇数边界、生产全route、异步发布和事务；不跑全仓oracle/全场景矩阵、长窗口FPS/ABBA或完整上游D3D工程。数值容差由half/格式/坐标换算给出，不能为了“轻测试”删算法、漏consumer或弱化有效断言。模块关闭后更新domain事实并停在Local Probes边界。
