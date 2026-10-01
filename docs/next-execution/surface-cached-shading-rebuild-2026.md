# Surface 最终主链直接重建执行计划

日期：2026-10-01。执行方式：按用户要求先删除旧路径，连续完成最终架构，全部实现后统一验证。目标：[Surface 最终设计](../next-design/surface-cached-shading-final-2026.md)的全部要求。旧性能基准固定为 `09b220f9348700c53035d283bc4f03bc5d19764b`，只在最终独立 checkout/宿主比较。

本版替代此前“先完成 S1/S2 组件与验证、保留旧 Surface 消费、逐阶段切入”的推进方式。用户允许分批提交；提交次数、组件数和测试数不作为完成度。本文更新的是接下来怎么实施，旧代码尚未因本次文档修订被删除。

## 1. 用户指定的推进规则

1. **先删旧链。** 开工即撤下旧 Surface 调度、Graph 接线、Probe、sample Work/Result/Resolve、generic worker、大 Setup cache 与无条件全屏 closure-lighting。不是等新消费者接好、测试通过或浏览器出图后再删。
2. **直接写最终架构。** geometry/address、编译材质、Appearance 缓存、独立稀疏照明、历史与重建、HDR/Temporal/Presentation 作为一个连续重构整体；可同时跨 owner 改生产者、消费者、资源和 ABI。不先交付一个全率新外壳再渐进加算法。
3. **允许中间不完整。** 工作树可以暂时未编译、无完整画面或缺效果。不为这个状态接回旧链，不建兼容 adapter、临时 consumer、占位 shader、空 provider 或新旧开关，不为旧测试恢复旧输入和产物。
4. **开发中不跑验证。** 不运行 typecheck/build、targeted tests、组件 GPU oracle、browser、benchmark 或 verify。不以小模块闭合、测试通过、证据、clean revision、claim 或文档逐批同步为继续实现条件。后续用户明确要求的诊断按该次指令执行。
5. **完整实现后统一跑。** 新主链全部代码、必要分支、实际 provider 消费与生命周期接线完成后，统一执行编译、数值、完整覆盖/互斥、生命周期、浏览器、连续画质和性能验收；失败在新链修复，不回到旧链。真实编译失败必须修复，不能将未编译状态当成最终交付。
6. **复用数学，不复用旧执行模型。** 准确材质采样、BRDF、插值、灯光/VSM/环境/曝光数学及最终需要的产品可以直接迁入新 owner；不得把整支旧 worker 或旧 Pass 包装成 fallback。
7. **只实现最终必要机制。** 不做为过渡兼容服务的泛化层、双份权威状态、逐 pixel 静态校验和吞错降级。limits 在创建前协商，稳定输入在 cook/发布/任务边界保证。容量预约、动态身份/失效、有效内容发布、写域互斥及同帧完整覆盖属于最终算法，直接实现。
8. **来源与事实保持准确。** 已审读可复用来源不重复调查；新的复杂算法仍先核读完整源码、固定 revision/许可证/阶段并写来源映射。数值/GPU 消费和采用状态统一在最终验证确认。未实现、未运行、未达标分别陈述，不用组件通过替代生产完成。

这些规则覆盖本范围内根/近目录 AGENTS、总架构计划、VALIDATION 和旧模块文档的逐阶段检查时点；其他独立 Next 模块的范围不因此改变。单 production renderer、唯一 frame submit、无本帧 GPU→CPU→GPU work control 的架构边界继续成立。

## 2. 直接重建顺序

剩余工作只按下面三个大步骤推进。前两步连续编码，可以跨 owner 交叉修改，不再将几何、材质、缓存、照明、重建和生命周期拆成独立推进步骤；各算法的详细要求仍由最终设计和 R01–R24 定义。步骤之间不要求出图、编译、测试、提交或生成证据；前两步始终处于同一个 `surface-cached-shading-direct-rebuild` currentSlice，第三步才进入统一验收。

### 2.1 第一步：删除旧链并完成几何与 Appearance 数据体系

这是当前下一步，覆盖旧链删除以及原 S1/S2/S3 中的数据生产、需求、缓存和实际消费。首先按[最终设计 §10](../next-design/surface-cached-shading-final-2026.md#10-一次性切换与删除范围)直接移除旧 Surface 调度及 `FrameProgramLowering/RendererCore` 接线、Probe、sample ABI/Work/Result/Resolve、generic worker、大 Setup、全屏 closure-lighting，以及关联配置、计数器、shader import 和无消费者资源。旧合同与诊断宿主可失效，不为其维护兼容桥。

随后在同一大步骤内完成最终共享 resident 属性、变换/形变、winner 紧凑插值、稳定 source-domain/LOD/镜像/接缝/拓扑地址；复用已有编译器、静态产品、联合过滤、驻留与字段发布，补齐实时材质输入和 masked/transparent coverage，完整实现 GPU Appearance 需求去重、页表、分配、更新、失效、淘汰与新 Surface 字段消费。常量/简单源页、昂贵静态产品和动态缺失使用最终统一语义，几何和缓存容量 miss 在同一新协议内完整供给，不借旧 worker 求值。

本步交付完整的几何/地址与 Appearance 生产、缓存和消费代码，直接作为第二步输入；不把“旧链删完”或某个组件写完单独当成一次阶段交付。保留最终需要的 GPU Scene、VG/Product/Visibility、FrameGraph、统一 submit 和准确数学，允许此时缺少完整照明和最终画面。

### 2.2 第二步：完成稀疏照明、重建与最终生产接线

这一大步骤完成原 S4/S5 和 S6 的整链实现与清理：直接消费第一步真实表面字段，实现 diffuse/specular/coat 独立采样率、cluster-local primary packets、显露/灯光/阴影/材质/视向强制刷新与有界年龄；同步写入各信号未预曝光历史、身份/footprint 验证、时域/空间重建、高频与能量合成，以及当前帧低可信补算。新 HDR 成为唯一 producer，只物化真实需求字段。

在同一步内完成真实 light list/VSM/环境/AO 和实际 provider 的字段、需求、历史消费，接通 Temporal/FSR3 reactive、曝光与 Presentation；完成 scene/product/device、resize/cut/residency、GPU retirement 全链生命周期，并删除残余旧 owner、资源和合同依赖。跨 owner 同时修改，完整算法与最终接线一起写完；不把照明、重建、输出或生命周期再拆成逐项闭合步骤，也不引入空 provider、临时消费者和第二份 temporal authority。

本步交付整个最终唯一生产链及必要生命周期代码。全率直接求值只承担无法复用、容量 miss、高频或强制刷新区域，使用同一新编译材质/信号程序和最终产品，不恢复旧 Probe→sample→closure→Resolve。实现期明确资源 producer/consumer、容量、发布和写域，稳定 ABI/正式合同与 current facts 在最终接线确定后集中整理。

### 2.3 第三步：统一验证、性能验收与返工

前两步完整目标代码及唯一最终帧图已经写入，旧生产入口和无消费者依赖已删除，才切 currentSlice 到最终验收。第一、第二步都不运行构建或测试，不要求为了第二步开工而先验证第一步。

统一执行 typecheck/build 与真实 CPU/WGSL/有限 PSO 编译，随后集中做核心数值与过滤负例、容量/缺页/失效、完整覆盖/写域互斥、空工作/indirect/所有权及生命周期检查；旧测试和宿主按最终实现更新或删除。再运行本地有界面 Chrome 的 Showcase/受控资产、场景/材质/provider 组合、resize/cut/device loss、连续 motion/disocclusion 画质，以及两组真实覆盖率与独立旧 revision 的全成本性能比较。完整矩阵和门槛见 §4–§5。

编译失败、数值/覆盖/生命周期错误、画质问题和性能未达标全部在新主链返工，重测受影响范围；完成 R01–R24 审计、来源采用状态和必要稳定合同整理。返工属于同一验收大步骤，不再建立旧链对照生产开关或拆回组件推进流程。

最终用户交付必须写清已通过、未运行和未达到的项目。代码写完与验收通过分别记录；性能不达标继续重构，不能用样本计数代替净收益。

## 3. 完整范围与当前事实

S0–S7 保留为需求标签，不再代表“完成一个、验证一个、提交一个、再推进一个”的流程。

| 范围标签 | 最终完整交付 | 当前事实 |
| --- | --- | --- |
| S0 设计与来源 | 最终 owner/dataflow、来源 profile 和完整要求追踪 | 设计入口已建立；具体新增算法仍需来源核读 |
| S1 材质编译与产品 | typed IR、活性/采样/依赖、有限程序、静态/动态产品、实时输入与 coverage 消费 | 动态参数、字段版本、MASK/透明 authored graph 已接入发布；GPU demand 会从 VisibilityKey 解析材质目录并生成有限程序任务，真实几何 UV/顶点属性与 coverage 语义仍待统一验收收口 |
| S2 几何共享与稳定地址 | resident 属性、共享变换/形变、winner coefficients、稳定 source/LOD/seam 地址 | 共享变换、clip/winner、resident 属性 ABI、形变与稳定地址类型已写入；真实属性解码和 Surface 消费仍待收口 |
| S3 Appearance 缓存与新 Surface | GPU demand/dedup/page allocation/update/eviction/versioning，新统一消费与同帧完整覆盖 | GPU demand、容量受限 indirect 任务、有限程序消费和字段数组发布已接入；缓存页的真实字段内容消费、GPU 去重/预约以及几何属性/同帧 miss 覆盖仍需验收返工 |
| S4 独立稀疏照明 | 独立 diffuse/specular/coat 率、cluster-local tasks、强制刷新、灯光/阴影/能量完整语义 | 新 SparseLightingPass 已成为 HDR producer，diffuse 使用 2×2 footprint、specular/coat 保持全率；真实 cluster light/VSM/信号历史与能量完整语义仍未验收 |
| S5 历史与重建 | 分信号历史/曝光/footprint/重建/合成，reactive 与真实 provider demand fields | Temporal Facts、FSR3 reactive、radiometry、bloom 和 presentation 已重新接线；独立照明 history、identity/footprint 重建与真实 provider demand 仍待完成 |
| S6 生命周期与删除 | scene/product/device/resize/cut/residency/GPU退休，全依赖清理与最终审计 | 旧 Surface 生产入口、Probe/sample/Resolve、全屏 closure 和 TriangleSetup 已删除；Appearance/lighting owner 的完整 resize/cut/residency/retirement 审计仍待统一验收 |
| S7 最终验收 | Chrome、画质视频、真实两 coverage 组、独立基准、全成本 P50/P95 | 第三步诊断已运行编译、针对性测试、组件 Chrome 与两 coverage 性能采集；完整架构、画质、生命周期和独立基准尚未通过，继续新链返工 |

第三步已开始诊断与返工，不能把之前两个提交中的“接线”视为算法完整交付。旧 Surface 生产源码和 Renderer/FrameProgram 旧接线已经删除；真实 resident 属性/形变、稳定地址、缓存去重和页内容消费、cluster-local light/shadow、独立信号 history/reconstruction 及完整生命周期仍存在源码缺口。统一验收尚未完成，不提升 R01–R24 或来源采用状态。

2026-10-01 本轮修正异步 PSO 就绪、uniform 对齐、纹理 usage、绑定资源集、字段输出 slot、帧绑定与内存计费，并用静态尺寸分条带保证任务池容量小于可见像素时仍同帧完整供给。计数器记录 attempted/written/overflow。此前只写入 84,650 个任务而漏掉大量可见像素的采集无效，不能作性能收益。

已运行：OEngine typecheck/build/build:test、7 个 targeted 文件共 31 项、示例性能指标 10 项通过；有界面硬件 Chrome 的 Appearance demand 诊断检查 5,569,725 个标量通过，含超过任务池容量、两材质 RGB/alpha/normal、空帧与非法/背景像素清除；几何组件 18 case、9,670 覆盖像素通过。几何容量 miss case 没有有效插值，说明同帧几何供给仍未完成，不能把该组件通过当成 R18 通过。

当前诊断采集位于 `.local/validation/surface-step3-final-diagnostic/suite.json`：Chrome 154.0.8037.92，1280×720，每次预热 60 帧、采集 120 帧，低/高与高/低两批顺序。32.85% coverage：GPU pass 合计 P50/P95 分别 9.306/9.896、10.879/11.534 ms；80.39%：13.304/14.615、13.500/15.073 ms。四次 attempted=written=visible、overflow=0，validation/uncaptured/device loss 均为零。高覆盖下字段发布约 3.54–3.60 ms、program 0 求值约 2.75–2.88 ms，是当前主要成本。仍逐像素求值、写 13 层全屏字段；没有真实缓存复用与完整照明，不能作为最终净收益或同画质比较。完整 browser/lifecycle/连续画质矩阵、独立旧 revision、R01–R24 和正式 evidence/claims 未运行。

后续进度只报告：旧生产依赖实际删除情况、最终主链哪些算法/消费者已写入、哪些真实缺口仍在；统一验证开始后报告实际结果。组件测试数、阶段状态、来源 adopted 或文档数量不换算为总体完成百分比。

### 2026-10-02 返工提交事实

本批源码已写入普通与 Product 的真实 resident 属性及 miss 消费、普通 Geometry schema 3 的 Cook 有向源三角形目录、GPU Appearance demand 分组与缓存字段内容消费、独立 diffuse/specular/coat packets 和未预曝光历史重建、真实 cluster/VSM/IBL/AO 消费，以及 authored IBL 资源事务。MASK 的裁剪 Alpha 程序同时接主光栅与 VSM，工作按有限程序/尺寸/单双面 GPU 分组；动态参数/cutoff 与 view-dependent Coverage 接阴影失效。字段发布保留 base/coat 过滤法线有效位，物理仍六层 rgba16f。细节与来源差异见 [迁移映射](../porting/next-renderer.md)。这些属于代码实现事实，尚未证明算法正确或性能达标。

仍未完成：真实 skin/morph 和 current/previous 形变生产、Product 稳定 source-domain/跨 LOD/seam 对应、完整透明材质与照明生产链、一般 nonlocal/provider GPU 输入、屏外 VSM caster 及无 caster dirty page 发布、全链生命周期收口和最终 fixture 整理。不能据本次提交将第一/第二步或 R01–R24 标为完成。

上面的 Chrome/编译/性能诊断只描述此前树。当前返工树未运行 typecheck、build、targeted tests、数值/GPU oracle、browser 或 benchmark；依据连续重构规则，先补完最终生产代码，再集中验收。本次提交不改变独立旧 revision 基准及两 coverage 性能门槛。

## 4. 最终 R01–R24 审计

以下条目在最终统一验收时逐项确认，不要求每写一个模块就补证据或提升状态。S1–S7 是范围标签，不是实施门禁。最终证据必须指出真实生产 producer、consumer 和覆盖范围；文件存在、组件测试通过或 manifest 标记不能替代整链事实。

| ID / 最终设计 | 最终必须证明 | 范围标签 |
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
| R21 / §10 | 起点直接删除旧文件/owner生产依赖，最终新HDR producer唯一，无兼容桥 | 先删除，最终审计 |
| R22 / §11 | 固定来源/许可证/完整阶段映射；局部适配与本地算法不冒称完整移植 | 各阶段 |
| R23 / §12 | 25–35%及80–90%真实coverage，静止/运动/显露/灯光/材质/LOD/residency组合 | S7 |
| R24 / §12 | 净Surface与整帧P50/P95门槛；全成本、冷启动、缓存miss和所有慢帧；质量视频与负例 | S7 |

R14 不允许把尚未实现的 GI/SSSR 写成已完成。最终接受时必须逐项确认本次实际 provider 边界：已经存在的直接光、物理环境、AO、VSM 全部纳入；计划中 provider 需要的新需求/字段/历史消费不能靠空接口冒充。若目标实现需要它们的新算法，就继续实施和验证，不缩小本目标。

## 5. 最终验收目标与边界

- 固定分辨率、场景/材质/功能/画质目标与设备条件。用实际 GPU visible coverage 校准 **25%–35%** 和 **80%–90%** 两组相机。
- 包含静止、持续移动、绕视角、新显露、光源移动、材质修改、LOD/residency 变化；覆盖 Dungeon、复杂静态/动态材质、normal/ORM/coat、双面、低 roughness/移动高光、UV/LOD 接缝、阴影与灯集合边界。
- 对每组分别要求全成本 **Surface P50/P95 至少下降 50%**，**GPU pass 合计 P50/P95 至少下降 30%**。这仍是必须实测的目标，不是已实现收益；实际时间线/吞吐与 CPU 编码另报。
- 计入 geometry、需求/去重、页表/缓存、任务生成、直接求值、信号历史、重建、HDR 合成、所有慢帧、冷启动与物理显存；不只报告 shader primary 数。
- 连续视频和静帧共同核对 ghosting/flicker、细节/高光、反射法线、接缝、曝光/色域和完整覆盖；局部/整图指标与目视共同判断，不伪造通用质量阈值。
- 已存在直接光、环境、AO、VSM 的真实消费属于本次交付。GI/SSSR 不能由空接口宣称完成；最终方案所需的新需求/字段/历史接口必须有实际消费。若本目标确实需要新增 provider 算法，继续完整实施；不以未来独立模块为由无限推迟本次专项验收，也不静默缩小范围。
- 性能工具和 Showcase capture 已在工作树，最终按新链统一修订；原诊断中的热降频、中断和未完整矩阵不作正式性能基准。用户新增 `neighbourhood_city_modular_lowpoly.glb` 不混入无关提交。
- 中文提交按连贯意图组织，开发期可注明“未运行编译/测试，按用户要求在完整主链实现后统一验证”；不为了提交制造可运行旧桥或伪闭环。稳定合同、current facts 与证据最终集中整理。

## 6. 历史组件记录（保留事实，不作为推进规则）

以下是旧推进方式留下的实现和诊断记录。其“进行中”“本模块测试”“尚未接通”等描述仅对应记录时点，后续记录已覆盖其中一部分；不要求重复验证、恢复旧消费者或逐项补历史闭环。当前实施方式以 §1–§2 为准，当前概况以 §3 为准。

<details>
<summary>展开既有 S1/S2 组件与原 S0 记录</summary>

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

随后完成静态产品重连与驻留组件：`bindAppearanceProducts`替换静态内部root并重新做活性/拓扑排序，移除不再需要的源采样、参数和运算；保留动态target表达式与原source/root provenance。base/coat联合矩分别覆盖具名lobe输出，避免原roughness CSE将过滤结果错误合并；常量精确f32不读纹理。`AppearanceStaticResidency`由GraphicsContext拥有，按不可变asset共享、相同format/extent/mip字段共用array layers，预查设备/物理/累计事务上传预算，abort、GPU完成退休与device loss撤销均有合同测试。它不是S3动态缓存或字段流送算法。

发布内核直接消费产品group 2、显式gradient与坐标域映射；任务目录增加独立`resourceSetIndex`，相同PSO但不同物理资产不能合并dispatch。目录stride的单一事实为`APPEARANCE_DIRECTORY_STRIDE`（32 bytes）。build（含typecheck）、build:test与119项targeted tests通过；组件5组/4,864值通过，包括同PSO两材质、静态子图与动态图重连、保留源fallback、独立base/coat共享array不同layer、HDR零纹理常量及非单位域NPOT；最大误差分别为0、0、0.004868925、0、0.000976563，在各fixture显式预算内。原numeric/resident诊断也复跑通过。Dawn native adapter/cache诊断仍存在。**普通scene材质尚未发布author产品绑定，字段fingerprint/content-version与精确失效尚未完成，新Surface帧consumer仍未切入；S1、R04–R07/R10保持未完成。**没有Chrome、视频画质或性能通过声明。

静态驻留模块已提交`eb71fe4`。随后接通了材质authoring和逐字段发布身份：`AppearanceFieldIdentity`对实际f32 DAG（含signed zero、参数、采样/decode/仿射UV和源content version）建立与无关root/物理instruction序号无关的精确key；包schema v3保留source key与scalar selectors，并在解析时验证content-addressed assetId。各字段有独立content hash，不以整包assetId代替字段版本。cook后重新编译的source可重连内部root，过期字段恢复真实source程序；base/coat按完整normal+roughness pair各自失效。

`AppearanceMaterialDefinition`已接入CanonicalMaterial→GpuMaterialStore→RenderWorld→Appearance publication；固定输出width与live outputs在发布前检查/裁剪，author source纹理参加现有residency路由。字段版本只有commit后推进，abort不推进；GPU目录携带field base/count，16-byte记录含version/output base/width/dependency。真实D3D12组件新增材质stage及republication两组，合计7组/6,912个float值和19个GPU字段记录；baseColor版本1→2而alpha保持1，重连静态子图没有恢复源采样。该两组数值误差0，原normal/NPOT各fixture预算和原生Dawn诊断边界不变。build（含typecheck）、build:test及127项targeted tests通过，静态half资产3,328值和联合法线2,048值GPU诊断复跑通过。

**仍未完成**：当前mutable material编辑仍需要显式resyncScene；尚未接通frame动态输入版本/demand/cache消费者，自定义masked/transparent coverage仍需新Visibility消费者；旧Surface仍持有source-bank输入，不能将IR采样裁剪当成生产显存/带宽收益。S1保持active，R04–R07/R10不提升完成，S2–S7继续全部实施。未运行新主链Chrome整帧、视频画质与两coverage性能验收，原因是新Surface/Lighting尚未切入；未缩小最终范围。

### S2 进行中：共享实例变换生产接通，2026-10-01

`FrameInstanceTransforms` 已接入真实 `PackedVisibilityPass` / `VisibilityWorkSet`：GPU 从实际 MeshletWork 选出唯一 instance，indirect 生产当前 clip matrix 和 normal cofactors；ordinary/Product Raster 与 Surface 同读288 B frame record，替换原instance binding而不增加 storage slot。完整176 B Scene身份/motion保留为snapshot；Temporal/culling/HZB继续读取权威Scene，late HZB按原需求子集复用。需求选择本身也按GPU written count间接启动，不按预留capacity扫满。Scene发布等待异步PSO，资源按原frame encoder编码；累计256 MiB owner budget、limits、物理bytes、allocation rollback、camera rebind、GPU完成退休与device loss已接通。

独立Native/D3D12诊断使用实际owner→实际ordinary hardware raster→实际Surface setup/normal helper，10帧、3,533覆盖像素通过；源176 B snapshot逐byte相等，镜像/非均匀/剪切、camera/instance变化、重复需求、空帧、zero generation、invalid与count clamp通过。generation使用明确u32 lane，`0x7fffffff`位模式保持测试通过，不通过float NaN payload保存identity。clip最大误差5.96046448e-8，法线与独立double Gaussian逆转置solve最大7.17062618e-8，插值2.09740457e-7。奇异实例的需求/snapshot测试通过，本fixture没有覆盖其光栅/法线fallback；不泛化数值覆盖。API errors/device loss零，原生Dawn adapter/cache诊断仍在。

本地**有界面Chrome154.0.8037.92**硬件适配器对10组实际shader/async PSO（含MASK、Product、ordinary/Product Probe/worker/closure）通过，API errors/device loss零；16-storage Product+scalar-AO profile覆盖。原VSM+scalar-AO组合需17 bindings，本轮没有宣称其支持。Native可选完整consumer PSO编译在ordinary Probe处异常退出，原因未定位，不报通过；真实Chrome完整编译另有通过报告。Product generic worker冷编译约38–42秒仍是旧generic consumer的负担。

build（含typecheck）、build:test与61项focused tests通过，来源/本地接线映射见porting账本。**S2/R02/R03/R08仍未完成**：resident属性、共享顶点/形变、winner coefficients主链消费、稳定source domain/LOD mapping继续必做；旧Probe/workgroup Setup/material/closure仍是唯一过渡消费者，S3切换时删除，没有生产A/B。此次仅完成共享实例transform模块，未运行新缓存/稀疏照明Showcase整帧、视频与两coverage性能验收，不宣称性能目标达标。

### S2 进行中：获胜 primitive 的紧凑插值组件，2026-10-01

已实现具名本地 `HomogeneousWinnerInterpolation`：三个共同尺度的齐次余子式行（48 B/primitive），不逐顶点除 W；保留一像素投影差分，将当前值和两个 footprint 轴的有效性分开。`WinnerPrimitiveInterpolation` 消费共享 clip 几何和 Visibility，GPU bounded dictionary 去重、reservation、indirect finalize、一次系数生产；后续 shader 通过实际 dictionary/coefficients 消费结果。容量/冲突失败在同一共享几何上直接算系数，不使用旧 Setup、不等 CPU。弱 CAS 重试有界，空槽重试耗尽不继续 probe，避免同 key 重复插入；dispatch 边界发布，不跨组自旋。观察性原子按 shader profile 编译裁剪；唯一需求 reservation 仍保留。异步 PSO、limits/bytes preflight、稳定帧资源复用、abort/调用者完成后 release/device-loss 与资源账本已接通。

独立 diagnostic 先 GPU 生产一次 clip 变换，真实 hardware raster 和 winner consumer 共读，再对独立 double Gaussian solve 与相邻像素 solve 比较。GTX 1650 Ti / D3D12 driver `32.0.15.8142` / Dawn Node `webgpu@0.6.1`：26 个 case/frame、19,874 个实际覆盖像素，通过透视、near/side clip、零/负 W、镜像非均匀变换、primitive 127、最终 winner-only、连续帧/空帧、dictionary collision/full、coefficient/probe overflow，以及投影邻居奇点、退化、NaN 和 1e-30–1e30 共同尺度。解析权重最大误差 `4.8837144e-7`，梯度 `1.9343742e-7`；hardware basis 最大差 `0.000162065` 在该 fixture 独立 `0.00025` 预算内。初始 hardware `0.00003` 预算失败已保留；未裁剪透视 fixture 的独立 1/256 pixel 顶点量化参考与 hardware 最大差 `1.5136974e-7`，定位了其 subpixel snapping 来源，未靠放宽解析 oracle 掩盖误差。

build（含 typecheck）、build:test 和 6 项 focused tests 通过；API validation/uncaptured errors、device loss 为零。Dawn 仍有其他 adapter 初始化 `0x887A0020` 与 pipeline cached blob `0x8000FFFF` 原生诊断。**这不是 Chrome/整帧/性能通过；S2/R02/R03/R08 仍未完成**：真实 GPU Scene/ordinary/Product residency 的准备与物理字节、Raster/Surface 生产切换、活跃属性/法线切线及 source-domain/LOD mapping 尚未接完。测试中的共享 clip producer 是独立 fixture，不能替代生产 frame geometry owner。S1 的 live dynamics/coverage 与 S3–S7 全部保留；旧 Surface 帧消费者本轮未修改。

### S2 进行中：单binding帧几何资源模块，2026-10-01

`FrameGeometryArena`已实现一份raw Surface输入与多个disjoint producer ranges：immutable metadata prefix保留原word offsets，目录、clip、packed triangles、winner dictionary/coefficients/work/control在同buffer内按negotiated alignment布局。不开late HZB不分配第二目录；开启时独立给定filtered work capacity。顶点/三角形预算不由meshlet capacity×128盲算，whole binding limit、累计256 MiB owner budget和alignment gaps全计。metadata只在成功submit的publication后commit，abort仍可重试，稳定帧不重复copy。winner借用arena storage，只拥有64 B settings/indirect；总成本仍包含完整arena。

真实Native GPU首先复现了**不相交range仍混用Storage(read-only)/Storage(read-write)的usage-scope失败**；binding aliasing并不是唯一规则。已改为producer各arena binding统一storage/read_write、range互斥，输入算法仍只读，无额外输入写/atomics；后续single-binding consumer独立scope只读整arena。`winnerPrimitiveArenaConsumerWgsl`实际读取字典/coefficients，并在容量/冲突miss从相同shared clips计算；没有引入旧Setup桥梁。

build（含typecheck）、build:test及18项focused tests通过。Native/D3D12同26个case/frame、19,874覆盖像素，typed/single-binding输出逐值在2e-6组件容差内，含collision/full/overflow/zero-work与metadata逐u32保留；旧dedicated-storage组件诊断亦通过。安装的**有界面Chrome154.0.8037.92**硬件adapter真实执行arena/winner owner与单binding consumer：6帧、2,717覆盖像素，透视、近裁剪/W=0/负W、两种新建extent和未提交publication重试通过；权重最大误差2.4345836e-7，梯度1.9577069e-7；API errors/device loss零，release后owner accounting零。Native仍有其他adapter/cache blob诊断，未泛称干净浏览器环境。

**S2仍未完成**：当前geometry vertex producer在Native/Chrome仍为fixture；真实resident属性/共享顶点与形变、late HZB原→最终work directory重排、winner系数在新Surface生产主链消费、稳定source/LOD地址继续必做。新布局尚未接入PackedVisibility生产调度；不能把组件GPU通过或避免第17个storage绑定等同于已消除Showcase瓶颈。S1–S7范围、两coverage画质/视频和50%/30%性能门槛均不缩减，当前无最终性能通过声明。

### S2 进行中：真实共享顶点与 late HZB 最终目录，2026-10-01

`FrameGeometryVertices`已接入唯一`PackedVisibilityPass`生产路径：实际GPU MeshletWork → 共享instance transform → 每meshlet-local vertex一次position解码/clip变换与每triangle一次packed corners → ordinary/Product Raster。128 lanes，thread-0一次加载源metadata；32次有界CAS与独立vertex/triangle预算。triangle reservation失败可留下无引用vertex hole，计物理/写入成本，目录零不丢Raster覆盖；源解码仍是相同生产shader的容量miss分支，无旧新模式开关。默认独立容量为1,048,576 vertices/triangles、262,144 dictionary slots、131,072 coefficients，whole arena上限128 MiB及累计owner256 MiB，metadata/目录/alignment全部计；这些是当前显式资源预算，**没有获得Showcase性能选型验收**。

FrameGraph新增arena生产/消费版本；immutable metadata仅成功submit后commit，稳定帧零copy。Product late HZB按同一reservation将source目录重排至filtered slot，共用clips/triangles，不污染LOD/profile/flags；prepare GPU生成实际count二维indirect，filter消费时不再按预留capacity启动。vertex/HZB与Raster有限PSO族在Scene发布前异步准备，draw只取已准备descriptor。GraphicsContext包含arena/vertex/HZB物理bytes；准备失败rollback、旧workset保持、GPU完成退休、device loss合同已测试。

build（含typecheck）、build:test和9组79项targeted tests通过。真实Native与**本地有界面Chrome154.0.8037.92**各18组/9,670覆盖像素，ordinary/Product build后故意改写源position，实际Raster/winner输出保持一致；HZB正确淘汰并重排最终目录，65,537项二维padded网格、独立容量miss、stale目录、empty/zero generation、camera/motion/mirror/shear通过。clip误差5.96046448e-8、独立Gaussian权重1.58964244e-7、footprint2.17837548e-7；API errors/device loss零，各case释放后owner accounting零。Chrome另13族PSO编译通过，含MASK、16-storage Product/scalar-AO旧consumer，未声明17-storage VSM组合支持。

Native保留其他adapter/cache blob诊断；旧FrameInstance+Surface宿主接新bindings后并行GPU活动期间两次异常退出，fresh pending记录定位到shear帧。单独shear与关闭并行Chrome编译后的串行10帧/3,533覆盖像素均通过；snapshot逐byte相等，clip5.96046448e-8、normal7.17062618e-8、barycentric2.09740457e-7，API errors/device loss零。尚未确立并行负载与异常退出的因果，不宣称修复了Native/driver根因，失败日志保留，正式GPU采集串行。

**S1/S2/R02/R03/R08仍不提升完成**：resident属性、形变、稳定source-domain/LOD/seam身份、新Surface真实winnerconsumer继续必做。GPU诊断中容量miss虽然保住Raster覆盖，但winner缺clip目录返回invalid；完整同帧Surface几何供给尚未实现，不能误报完整overflow覆盖。S1动态输入/coverage/source bank释放与S3–S7全部保留；旧Probe/setup/material/closure仍待删除，无新缓存/稀疏lighting性能通过。Showcase整帧、两coverage P50/P95、画质视频未运行，原因是新Surface/Lighting切换尚未完成，不缩小最终目标。

### 原 S0 记录

### S0：2026-10-01

已建立最终要求追踪与一次性切换范围，重新检查当前HEAD/worktree和owners。补查MaterialX固定源码作为图编译/静态烘焙参考；已有Wicked/The Forge/OSS来源继续按最终profile审读。当前尚未移植完整缓存、稀疏照明或时域算法。

本阶段不改生产代码，不运行build/browser/perf。设计结构检查不能证明运行时算法。后续状态按实际提交和测试结果更新。

</details>
