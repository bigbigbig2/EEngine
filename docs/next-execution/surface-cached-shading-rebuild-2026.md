# Surface 缓存与稀疏照明重构执行计划

日期：2026-10-01。目标：[最终设计](../next-design/surface-cached-shading-final-2026.md)的全部要求。起点：`09b220f9348700c53035d283bc4f03bc5d19764b` 的旧 Surface 生产链。用户允许分阶段提交；阶段完成不能代替整个重构完成。

## 1. 执行规则

- 每阶段交付最终主链需要的完整模块，不能把简单全率材质优化、空类或只通过源码字符串检查当成替代算法完成。
- 新生产消费者接入时同时切断相应旧消费者，不建立 A/B 生产开关。基础数据模块可先接入发布，尚未替换的旧生产消费明确标记为过渡事实，不报告性能目标已完成。
- 保留准确 glTF/Standard/Coated、采样、色域与 BRDF 数学；变更执行模型与变更算法行为分别登记。
- 复杂算法先完成来源 profile 与逐阶段映射。没有完整 donor 的部分使用具名本地算法，不冒称完整上游移植。
- 每大模块收口运行 typecheck、build、必要数值/容量/生命周期测试。真实编译失败必须修复。用户要求的最终专项 browser/画质/性能对比属于本目标，不能以其他 provider 尚未完成为由无限推迟；未来 GI/SSSR provider 的独立实现范围也不能被隐含声明已完成。
- 提交只包含对应阶段的连贯改动、中文动机/范围/实际验证。之前未提交的性能工具单独收口；用户新增 `neighbourhood_city_modular_lowpoly.glb` 不混入提交。

## 2. 阶段与切换

| 阶段 | 完整交付 | 删除/接通边界 | 完成证据与当前状态 |
| --- | --- | --- | --- |
| S0 设计与来源 | 明确输出字段、算法 profile、owner、全部要求追踪、验证范围；设定 active workstream | 新设计替代旧 Surface 目标，旧实现事实留在历史执行记录 | 本文件与来源映射已提交`182fd51`；算法模块开工前继续补完整profile |
| S1 材质编译与 Appearance 产品 | 有类型 IR；常量折叠、输出/通道活性、等价采样、静态/动态/几何/视向依赖；固定材质 lowering；静态数据/烘焙产品与动态程序 | 材质发布消费真正编译产物；旧十角色循环在新 consumer 切入时删除 | 独立数值对照、变更/快照、过滤非等价负例、真实 GPU 编译消费；未完成 |
| S2 几何共享与稳定地址 | residency 属性准备；同帧 transform/shape 数据；winner-demand primitive coefficients；source domain/LOD mapping | raster 与 Surface 共用新几何数据；替换 workgroup 大 Setup；Loader 无长期 GPU owner | Native/WASM/Product、透视/近裁剪/非均匀变换/接缝/LOD 数值与真实 GPU 消费；未完成 |
| S3 新 Surface 主链与 Appearance 缓存 | 有界需求去重、页表/更新/淘汰、跨帧版本；简单源页与动态缺失统一消费；精简程序与必要字段 | 删除 Probe/旧 SampleWork/SampleResult/Resolve 调度生产依赖；完整全率覆盖是新主链合法模式 | 零工作、容量、缺页/失效、覆盖互斥、multi-UV/normal/ORM/coat；未完成 |
| S4 独立稀疏照明 | diffuse/specular/coat 分信号需求、cluster-local primary packets、当前变化强制刷新、正确灯表/阴影/环境/能量耦合 | 取消全屏完整 lighting 默认执行；删除旧 closure lighting | 光源/视向/阴影/cluster 边界、显露、精确参考与真实减量；未完成 |
| S5 历史与重建 | 各信号历史身份/年龄/footprint、曝光、空间重建、高频合成、Temporal/FSR3 reactive；间接 provider 的需求/历史消费 | 新 HDR 唯一 producer；无默认大 closure GBuffer；独立 provider 缺失如实记录 | 连续 motion/cut/显露视频、noise、SSR 法线需求、HDR/曝光 oracle；未完成 |
| S6 生命周期与逐条返工 | scene/product/device epoch、resize/cut/residency；旧 owner 删除；复核最终设计每条要求、清理陈旧测试/合同 | 唯一生产依赖图闭合；接口稳定后写正式 ABI/合同 | requirement audit、typecheck/build、真实 consumer/lifecycle；未完成 |
| S7 测试与性能验收 | 独立本地 Chrome 宿主、两 coverage 组、材质/场景/变化矩阵、独立旧 revision 对照、全部成本/P50/P95/画质 | 清除未证实的完成声明；未达目标继续返工 | Surface 至少下降50%、GPU pass合计至少下降30%，P50/P95均检查；未完成 |

S1–S5 的编号是实现依赖顺序，不是降低最终功能范围。静态烘焙、动态缓存、几何共享、稀疏照明、历史验证和重建均是必做项。允许同一模块内连续修改多个 owner；不为机械文件拆分制造阶段完成声明。

### S1 进行中：编译基础，2026-10-01

`AppearanceGraph`与`AppearanceGraphCompiler`已实现typed DAG、Kahn排序、f32常量折叠、保序CSE、逐输出/通道活性、完整采样快照与依赖域。`StandardAppearanceGraph`已lower当前Standard/Coated/glTF字段，材质发布保留编译产物，独立数值oracle与材质合同回归通过。旧GPU消费者、feature mask与纹理route仍按旧合同；本轮没有将编译数据存在CPU上误报为真实GPU消费。**S1仍未完成**：静态烘焙产品、动态程序、有限profile lowering及GPU消费仍待实现；R04/R05/R06/R07均未提升为完成。没有本轮浏览器/性能结论。

编译基础已提交`23d0110`。随后实现了`selectAppearanceProductProgram`，可从真实IR提取可复用字段，去除无关target输入；`appearance_program`生成展开的WGSL、独立参数值和输出slot，不引入GPU字节码或角色循环。`AppearanceMipCooker`实现来源账本的`ReevaluatedMipAppearanceCooker` profile：独立字段、常量零mip存储、逐mip源footprint重新求值、bilinear/trilinear的空间与fractional LOD探针、显式误差/字节/探针预算拒绝。它是cook的scene-linear f32中间产物，尚未接通资产打包、GPU驻留或生产消费；不宣称覆盖normal variance/roughness全部过滤合同。

组件GPU诊断在GTX 1650 Ti、D3D12 driver `32.0.15.8142`、Dawn Node `webgpu@0.6.1`上执行5组256-lane kernel、32,000个值，真实1×1纹理读取与sRGB RGB/linear alpha通过；最大绝对误差`0.000312716`，uncaptured/validation errors及device loss为零。Dawn native仍打印其他adapter初始化失败及pipeline cache blob HRESULT诊断，不能当成无错误浏览器环境或性能结论。宿主见`validation/labs/surface-appearance/`；未测footprint/各向异性、cache seam/LOD、Chrome整帧。**有限程序族与异步PSO准入、动态图发布/产品依赖版本、烘焙打包驻留、正常法线过滤和RenderWorld→新Surface真正消费仍未完成，S1保持active**。

随后完成了资源发布基础：材质具名参数与字面常量分开CSE，避免数值偶然相等改变shader拓扑；产品root保留精确parameter/dynamic-input/source-sample依赖。`AppearanceProgramRegistry`对拓扑/资源profile设置128个program、4个并发编译和每source 512KiB默认上限，进入Scene提交前异步创建显式layout/PSO，无热帧同步创建或独立submit；取消、失败重试、device loss和无引用program淘汰均有生命周期测试。`GpuAppearancePublication`以实际大小发布常量、采样route和目录，保留每材质输出/参数语义及source residency slot/revision；RenderWorld不再丢弃编译产品，Renderer四条upload/append/swap入口等待准备。abort释放candidate，已提交release在GPU完成后退休；device loss由唯一registry通知并撤销resident消费。逐字段版本更新/动态参数输入及静态Appearance资产打包驻留仍未完成。

`appearance_resident_kernel`以发布时确定的每sample bank/sampler资源profile展开，直接消费TextureResidency已解码的scene-linear bank与独立linear alpha，不再次sRGB解码；task携带各材质constant/route/input/output偏移，同topology可混合材质实例，不要求逐材质dispatch。原“每sample全bank×全sampler分支”原型在D3D12出现长时间编译，运行中断且未取得通过结果，已被直接资源profile取代；不是保留的生产A/B。新组件宿主5组/14,592值通过，覆盖Coated两实例共享真实PSO、multi-UV、九个bank、2×2源纹理/仿射UV、alpha和语义fallback，最大绝对误差`5.96046448e-8`；不证明anisotropy、cache/LOD seam、动态footprint或Chrome整帧。更新后的原始numeric宿主32,000值亦通过，Dawn native adapter/cache blob诊断仍存在。build（含typecheck）、build:test通过；材质/发布/RenderWorld/图/cooker六组79项targeted tests通过。**新Surface帧consumer仍未切入，R04–R07不提升完成，S1保持active，无性能或画质达标声明。**

发布基础已提交`c34a5b6`。接着为静态字段实现了half-precision实际产品：`AppearanceMipCooker`先以ties-to-even量化，再对最终可过滤数据执行原空间/fractional-LOD质量探针；有限half溢出和预算失败拒绝，不在打包时静默量化尚未验证的f32。`AppearanceAssetPackage`使用现有RuntimeAsset V2容器保存独立r16/rg16/rgba16字段mip、源identity/dependencies、坐标域与过滤误差合同；常量仍为精确f32位模式（包含HDR和signed zero），不占纹理页。`AppearanceAssetUpload`向调用者拥有的texture-array layer事务编码全部mip的buffer→texture copy，预查format/extent/layer/limits与padded上传预算，成功提交才commit，部分编码异常直接abort。Frame command提供单一pooled upload buffer，无额外buffer中转或submit；实际pool capacity单独观测，staging allocator不再漏计active/pending allocation。

本模块十组98项targeted tests及build/build:test通过，包含binary16全部65,536 encodings、half中点、包往返/完整性/typed ABI负例、量化预算负例、零纹理常量、NPOT/row padding、capability/容量、提交与abort。GTX 1650 Ti/D3D12真实组件验证三种half纹理、12个mip copy、256 lanes/3,328值：GPU过滤对packed CPU参考最大误差`0.000162751`，对这个fixture源表达式最大误差`0.018849826`，在其**显式0.025预算**内；该数值仅为诊断fixture预算，不是AAA画质或所有资产的通用默认。API errors/device loss零，Dawn原生诊断仍在。**该上传helper不拥有长期纹理，不是完整Appearance residency/cache owner；烘焙产品尚未绑定材质程序并进入新Surface主链，normal-variance/roughness、字段失效更新及S2–S7仍未完成。**没有Chrome、整帧、视频或性能通过声明。

联合法线过滤基础随后完成：固定审读The Forge `GenerateVMFLayer/GenerateVMFFilteredMipmaps/ProcessTextures`全部链、Filament roughness工具/BOX mip与Karis/Toksvig原始资料，选择具名本地`CoupledVmfAppearanceFilter`。将perceptual roughness平方为GGX alpha，以联合r-form保留法线与roughness依赖；独立base/coat矩，NPOT/1×N面积mip保留所有源texel，shader在最终过滤之后解码。近零矩返回方向无效与最大roughness，低roughness half矩丢失或inverse拟合超过明确预算均拒绝；包schema v2保留配对与误差合同。参考double逆coth与可复用scratch纳入峰值预算，不在GPU热consumer添加每像素验证。

本模块11组108项targeted tests与build/build:test（含typecheck）通过。D3D12真实half矩上传/过滤/解码诊断256 lanes/2,048值通过，API validation/uncaptured errors及device loss零。初始沿用平滑颜色fixture的0.0003滤波容差失败：实测硬件滤波对packed CPU trilinear最大`0.003502712`；失败保留在忽略诊断目录。最后明确采用**此fixture独立**的矩0.005、角度0.01 rad、roughness 0.025预算，直接核查最终GPU输出：decode数值误差`1.1920929e-7`，方向误差`0.004642322`rad，roughness误差`0.010636690`。CPU cook探针没有包含硬件插值精度，不能将上述预算设成生产通用默认或宣称AAA画质。Dawn native adapter/cache诊断仍存在。**这只完成过滤组件；静态资产重连、长期residency/new Surface消费、动态字段版本及S2–S7仍未完成，S1与R10均保持未完成。**

## 3. 设计要求到证明的追踪

所有条目初始为未完成。对应证据必须指出生产 producer、consumer 和测试覆盖范围；文件存在或 manifest 声称 completed 都不能替代证明。

| ID / 最终设计 | 必须证明 | 主要阶段 |
| --- | --- | --- |
| R01 / §1、§3 | 可靠全率 Visibility 与独立 material/lighting rates；同 FrameGraph/唯一 submit，无本帧 CPU 控制工作 | S2–S5 |
| R02 / §4 | 静态驻留属性与同帧 transform 真正共用，显存/带宽/被遮挡准备成本可见 | S2 |
| R03 / §4 | 可见 primitive 紧凑系数一次生产；透视、近裁剪、退化、非均匀变换正确 | S2 |
| R04 / §5 | 编译 IR 有输入/输出和通道依赖；常量/死输入去除、采样合并；保留全部当前材质语义 | S1 |
| R05 / §5 | 常量/源页、昂贵静态烘焙、动态缺失三种实际产品，不能只实现简单 glTF | S1、S3 |
| R06 / §5 | 多 UV/顶点/动态图正确，非线性过滤合同和不能烘焙的负例 | S1–S3 |
| R07 / §5 | 有限程序族/资源 profile，无运行时十角色通用循环；进入渲染前异步 PSO | S1、S3 |
| R08 / §6 | 稳定 source Surface 地址、各 LOD 映射、镜像/接缝/拓扑新 identity；不把 work index 当历史 key | S2、S3 |
| R09 / §6 | GPU demand 去重/有界分配/失效/淘汰/更新；camera与显露不错误清静态缓存 | S3、S6 |
| R10 / §6 | 字段与过滤独立；tangent-space normal和variance/roughness耦合；ORM/normal/coat没有整材质禁用规则 | S1、S3–S5 |
| R11 / §7 | direct diffuse与specular/coat按独立率执行，2×1/1×2/2×2真正在consumer减量 | S4 |
| R12 / §7 | 当前显露/光源/阴影/材质/视向变化强制刷新；bounded age与轮换校验 | S4、S5 |
| R13 / §7 | 连续primary执行、正确cluster灯集合与遮挡边界，不借代表灯表漏光 | S4 |
| R14 / §7 | diffuse、specular、coat能量/视向耦合保留；独立间接需求及真实可用provider消费 | S4、S5 |
| R15 / §8 | identity/变化/footprint验证、同域重建、低可信当前刷新、镜面漫反射分开 | S5 |
| R16 / §8 | FSR3不掩盖稀疏着色缺陷；显露/reactive传递；未预曝光缓存与色域一次转换 | S5 |
| R17 / §8 | 紧凑信号格式、真实消费者字段，无默认128-byte results或全屏完整closure | S3、S5 |
| R18 / §9 | owner唯一、bounded commit/消费、溢出同帧完整覆盖且无非法页、无跨组自旋 | S2–S6 |
| R19 / §9 | diagnostics编译裁剪，控制原子保留；发布检查不在每pixel重复 | S3–S6 |
| R20 / §9 | resize/cut/scene/product/device loss按域失效，不误清Appearance；capability创建前协商 | S6 |
| R21 / §10 | 所列旧文件/owner生产依赖全部删除，新HDR producer唯一 | S3–S6 |
| R22 / §11 | 固定来源/许可证/完整阶段映射；局部适配与本地算法不冒称完整移植 | 各阶段 |
| R23 / §12 | 25–35%及80–90%真实coverage，静止/运动/显露/灯光/材质/LOD/residency组合 | S7 |
| R24 / §12 | 净Surface与整帧P50/P95门槛；全成本、冷启动、缓存miss和所有慢帧；质量视频与负例 | S7 |

R14 不允许把尚未实现的 GI/SSSR 写成已完成。最终接受时必须逐项确认本次实际 provider 边界：已经存在的直接光、物理环境、AO、VSM 全部纳入；计划中 provider 需要的新需求/字段/历史消费不能靠空接口冒充。若目标实现需要它们的新算法，就继续实施和验证，不缩小本目标。

## 4. 已知证据与未完成事项

- 旧实现的本地诊断资料保存在 `.local/validation/`；它们包括热降频和中断运行，不能作为本重构的正式性能证据。
- 工作树中已有 performance lab、runner/analyzer 和 Showcase capture 工具。收口时修正 README、温控条件比较、失败/取消/冷启动处理；异步预热诊断不是生产同步编译故障修复。
- 原 Dungeon 是必须覆盖的真实内容；额外使用能分别暴露复杂材质、静态烘焙、动态参数、低roughness高光、双面/coat和接缝的受控资产。
- geometry既有画质与VSM完整遮挡缺口不因新缓存自动消失，出现相关失败时按真实owner修复。

## 5. 阶段记录

### S0：2026-10-01

已建立最终要求追踪与一次性切换范围，重新检查当前HEAD/worktree和owners。补查MaterialX固定源码作为图编译/静态烘焙参考；已有Wicked/The Forge/OSS来源继续按最终profile审读。当前尚未移植完整缓存、稀疏照明或时域算法。

本阶段不改生产代码，不运行build/browser/perf。设计结构检查不能证明运行时算法。后续状态按实际提交和测试结果更新。
