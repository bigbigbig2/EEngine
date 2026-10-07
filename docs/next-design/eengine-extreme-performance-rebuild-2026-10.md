---
id: eengine-extreme-performance-rebuild-2026-10
state: history
supersededBy: ./eengine-v4-native-shading-2026-10.md
---

> 2026-10-07 V4 authority 切换：本文保留当时的提案、决定或实施记录，仅供历史追溯。正文的“current / 当前 / 必须 / 已完成”均属原快照，不再定义未来生产架构；其中性能结果、失败和未验证声明不改写。唯一当前依据见 [V4 authority](./eengine-v4-native-shading-2026-10.md)，文档切换不表示代码已切换。

# EEngine 现有渲染器性能重构设计

修订：**SURFACE-2026-10-07-R4**。本次修订以 `d16cc1d6` 为源码审查入口，重整范围与决策，不宣称源码已实现本文或性能已通过。

本文回答“保留什么、改变什么、为什么可能减少成本”。[执行计划](../next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md)维护当前状态、缺陷和下一切换单元；[workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml)只作导航；[来源账本](../porting/next-renderer.md)维护固定来源与采用边界。旧设计及实验见[历史记录](#10-来源与历史导航)，不再混入当前任务。

## 0. 目标与边界

首要运行目标是 **GTX 1650 Ti、1080p 复杂场景**，保持既有合法材质、效果、过滤、精度与完整覆盖，追求可解释的低 GPU 成本和现代 AAA 画质。本轮是现有生产渲染器的性能重构，不是从零重建所有系统，也不是新增效果总计划。

目标有两部分：减少可合法省掉的求值份数，以及降低仍需执行的每份工作的代价。命令有界、模板排序、窄存储和减少分配分别解决不同问题，不自动证明 Appearance 样本减少或整帧更快。输入确实独立的高频区域允许完整全率；不承诺任意合法图都能次线性求值。

推进轴保留 **A0 → A1 → B1 → B2 → C → D → E → F**。这些是切换责任，不是重做八套系统：A0/A1建立测量与执行基础，B1/B2闭合 Surface 计算，C扩展经证明有收益的复用，D/E修当前几何和光照缺陷，F验证跨系统集成并修其实际失败。源码已满足某项责任时保留并核对，不重复建设。

新 SSSR、Hybrid GI、VT、透明/介质及其他 planned providers 保留在各自 workstream。此处只约束它们将来消费的真实产品；不因名字出现在路线图中就新增永久全屏资源、要求本轮重写，或把全 Next 功能完成作为局部编码前置门禁。

## 1. 问题与决策依据

| 成本来源 | 应改变的对象 | 不能据此推出 |
|---|---|---|
| 管理链按场景/请求复杂度反复展开 | 有限执行族、实际工作队列、编译后的资源事件 | 有限命令必然便宜 |
| 同一更新级贵子图反复按像素执行 | 完整依赖频率、GPU更新值、匹配版本读取 | 普通空间纹理都能移到uniform |
| 所有候选目标先承担缓存管理，实际省掉工作很少 | 实际closure、复用域、准入与完整直接执行 | 高命中率或昂贵指令权重必然有收益 |
| lookup前完成过多Geometry、consumer补算或分阶段重算 | 最小address、剩余需求union、唯一产品owner | 换key编码或缩stride解决计算边界 |
| 保留无消费者的宽产品、复制历史、漏记退休资源 | consumer存活分析、直接写真实产品、完整物理预算 | 容量下降等于帧时下降 |

必须用实际资产和场景说明主要成本。若目标场景主要是cheap sample或精确输入彼此不同，uniform/cache机制成功只能证明其适用范围；收益路线应转向必要工作的执行成本和已有几何/光照缺陷，不能增加夹具运算或省掉依赖制造共享。

不预设未经批准的 FPS/毫秒目标。先报告同质量 Surface 与整帧成本；短采、无温度/clock控制或不同覆盖率的结果不能相减为正式历史收益。当前事实只在执行计划记录。

## 2. 保留与替换范围

| 对象 | 保留 | 本轮允许/要求改变的范围 |
|---|---|---|
| FrameGraph / FrameProgram | 版本、依赖、裁剪、晚绑定、单主encoder/submit | 实际consumer接线、资源事件、缓存recipe及异常/退休正确性 |
| Appearance | 原IR数学、有限普通家族、完整General、合法Product过滤 | 频率与需求分流、实际有收益的closure复用、存活与执行税 |
| Geometry | source/resident数学、FrameGeometry arena与共享帧属性owner | lookup所需地址与remaining需求；D中具名LOD/HZB/caster缺陷 |
| Lighting / Shadow | 原BRDF、光照产品、有效provider和已有阴影owner | 每signal实际工作、E中影响范围/overflow/页生产缺陷 |
| Temporal / Post | TemporalFacts、FSR3、曝光、Atmosphere LUT及后处理数学 | 新产品失效/角色/abort接线；F中实际失败，不另建通用history系统 |
| 旧协调链 | 已有数学与仍有consumer的GPU产品 | 替换后删除旧batch/tree/proof/宽Store协调器及无reader依赖，不建adapter |

D/E/F的责任详见§8。系统存在不代表目标缺陷已修复；发现过缺陷也不代表现在仍存在。每项以当前producer→consumer核实，不能照抄历史stub或阶段标签。

## 3. 全部切换单元共同遵守的合同

### 3.1 三条架构不变量

| 不变量 | 可核对的要求 |
|---|---|
| A 命令数与场景复杂度解耦 | native draw/dispatch/copy/clear由有限family、资源profile和必要同步决定；像素/实例/graph/request增长改变GPU数据与workgroups，不复制全链 |
| B 管理不压倒实际计算 | 非空代表workload中管理成本不超过被管理计算；新增复用计入全部维护后有端到端净收益。空/便宜工作单列绝对管理税，不添加无用计算抬分母 |
| C 可选复用可关闭 | 同数学、覆盖和consumer的完整direct正确且同量级；OFF真实移除可选lookup/维护/分配。合法constant/uniform频率提取仍保留 |

局部范围通过不等于全部Surface或整帧通过。出现成本反例时保留失败，不用“架构完成后再优化”掩盖已知失衡。

### 3.2 数学、身份和写域

保留完整f32语义、原C/X/Y与过滤、UV0–2、嵌套查询、normal/coat/IOR/specular、finite guard及numeric residual。Coverage保留原alpha数学并同步参数/route。未经认可不引入量化、额外mip bias、低分辨率材质、隐式half或不同加法分组。

Winner/CandidateKey、ValueWitness、SharingCertificate与CacheIdentity各有职责。hash只定位，完整描述/真实输入决定相等；同material、template或domain不是值相等。generation/device/publication namespace、content/residency/LOD/instance与view依赖按真实owner失效，不以无关camera epoch清静态值。

最终发布边界保证互斥coverage、完整full-rate exception、唯一writer和有效版本；热consumer不重复检查已保证的不变量，也不重新执行完整Geometry/材质/PBR。禁止恢复retired renderer、增加功能独立submit或本帧GPU→CPU→GPU工作控制。

### 3.3 来源与采用

完整算法实施前核读可复查GitHub完整实现，再查论文和详细说明，固定revision、许可证、源入口、关键分支/输入输出/失效与本地阶段映射。没有兼容完整donor时说明检索范围和具名本地方案，不宣称移植完成。数学、GPU消费与生命周期证据齐备才提升采用；文档修订不能替代证据。

## 4. Appearance：完整直接执行是基础

### 4.1 发布产品与有限执行族

ProgramTemplate保存完整拓扑、输入/输出语义、类型/点域和结构相等描述；MaterialSnapshot保存参数、runtime inputs、routes及资源版本；ExecutionPlan/ExportPlan保存频率、需求闭包、liveness、Geometry needs、sinks和consumer存活。数值变化不为每graph创建PSO，容量/布局变化按事务更新计划。

保留Publication-only、Unlit、完整Standard PBR与完整General。普通家族按完整结构/操作顺序/采样语义匹配，不按材质名、当前零值或节点上限裁图。不匹配的合法图仍完整General，不能退成默认材质。

### 4.2 频率、WorkPlan与实际工作份数

| 类别 | 生产数量 | 读取与恢复 |
|---|---|---|
| publication/material/frame更新值 | 按完整依赖的dirty域；允许完整查询输入/CXY均uniform的资源查询 | 匹配版本引用/broadcast；失效由原GPU更新producer重算 |
| 便宜逐样本值 | 实际必要样本 | 原accessor/cheap计算，绕开重缓存协议 |
| 原语义Product或经准入的贵域值 | 原Product读取，或实际unique miss/dirty | 保持原过滤；命中读取，不重跑对应heavy |
| 必须独立的贵逐样本值 | 完整独立输入及原footprint要求的样本 | fixed/General完整direct；单列必要计算与实现税 |

WorkPlan对每closure/共享子图声明完整依赖、频率、计算域、consumer、值表示、失效、成本候选和fallback。covered targets、actual heavy evaluations、value reads分开。domain intern只减描述，排序只重排工作；两者都不证明少算。

频率取全部算术与资源坐标祖先的并集。sample输出内部的uniform子图也可提取；保持GPU操作顺序的sin/pow等仍在GPU求值，不用JS double替代。texture内容不当常量，未知/空间/view/nonlocal依赖保持完整逐样本执行。任意DAG逐texel bake一般不满足`f(filter(T)) = filter(f(T))`，不能作为精确降级。

### 4.3 Typed Tape、共享节点与临时存活

语义宽度与C/X/Y点域分别编码：scalar C为1 word，RGB C为3，UV CXY为6，RGBA CXY为12。只有真实coordinate ancestors/邻点consumer请求CXY；完整同输入查询和normal-moment decode共用一次，不能按field名称重复求值。

General基线为f32 word SoA，`TemporaryBytes = aligned(4 × Q × maximumLiveWords)`。Q是全dispatch并发contexts上界，每个global context独占其slice；不能让不同workgroup重用未完成地址。普通家族和更新阶段分别核实际临时宽度，互斥阶段才可alias。private数组不等于寄存器驻留，不为slot阈值拒绝合法图。

last use同时包含内部consumer和外部sink；tuple sink等完整组件，嵌套坐标/shared CXY使用前不得释放。原始TS normal、切线与guard输入可局部存活；只有实际Lighting/Reconstruct/history等读者需要的产品持久化。constant值不分配逐像素plane。

### 4.4 程序一致工作与更新事务

保留dense template index的count→有界prefix→scatter→run/packet→indirect组织，以及完整indexed fallback；单template/已一致工作不默认排序。packet保留原target、snapshot、need mask、版本和tail，GPU组织不按每program复制host命令。mixed fallback不得依赖各lane同步执行同长度tape或跨组自旋。

参数/帧/资源dirty→同frame encoder GPU update→合法dispatch发布→匹配版本consumer；submit后承认提交状态，abort保留重试。immutable结构/内容变化按原发布合同重建。Surface、Coverage、TemporalFacts及其直接读者随producer迁移，不能只更新pixel evaluator。

## 5. Geometry：先地址，再完成剩余需求

Geometry保持唯一语义与owner；frame/resident/source是同一读取协议的输入，不是多个恢复几何的consumer。

```text
原Visibility / published values / WorkPlan
    → 必要address输入 → 完整value lookup或direct决策
    → remaining Appearance ∪ dirty Lighting ∪ guides ∪ numeric guard
    → 同一Geometry record增量完成 → Appearance / closed fields与guides
    → Lighting → immutable signals → Reconstruction
```

lookup前只生成真实key依赖：纯publication不需Geometry，实例域读取权威handle，UV/footprint域才请求相关projection。禁止先decode全部position/normal/tangent/UV/color再声称命中省掉它们。key本身必需的重工作必须计成本，不能少读依赖。

一个field hit只消除自己的miss需求，其他consumer仍可请求该record。以required/produced mask避免重复生产；布局和跨dispatch输入随producer同切，invocation-private值不能被下一dispatch假定仍存在。

共享frame attributes由既有arena-backed owner提供，保留对象/世界空间、normal matrix、镜像tangent、facing、近裁剪/零负W/退化与透视数学。prepared容量不足只发布完整准备的meshlet，其余由同一owner精确resident完成。primitive setup产品属于热点确定后的候选，不恢复旧Winner dictionary或第二owner。

## 6. 可选复用：先明确收益条件

### 6.1 全成本模型与准入

核算单位是 **closure × 实际工作域 × 执行profile × 有限重复窗口**，不是单个field权重或命中率。

```text
net_gain = direct完整producer→consumer成本 − reuse完整producer→consumer成本
         = 真实消失的计算
           − address/key/probe
           − request/nomination/arguments
           − 值读取/scatter/publish/reset/retire
           − 分阶段重复、continuation与consumer新增成本
```

shared ancestors、其他guide/Lighting仍需要的Geometry和查询不计收益。miss/key scope含overflow direct时不能整体归为管理。N目标、H命中、R请求、U唯一miss、X直接恢复、K/V宽度、Store槽与字节分别记录；不要求`H+U+X=N`来替代逐目标覆盖证明。

实施前固定真实候选、相等条件、address/remaining需求、重复/失效窗口、容量和可证伪收益假设。编译权重只排候选，不能自动生产准入。新方案的实测证据在完整实现后的集中检查建立，不要求未实现方案先出具GPU通过结果。

publication根据事先核定的有限profile选择策略；不建per-tile成本预测器或本帧readback反馈。便宜/未准入类别在key前direct，零准入时移除相应命令和分配。cold税计入声明的W窗口，检查`sum(T_on[1..W]) < sum(T_off[1..W])`；无限预热、抬高夹具运算量或让其他类别抵消失败不能证明准入。

### 6.2 精确材质缓存的生产合同

保留具名本地 **Exact Closure Cache Publication** 的完整相等和分阶段发布合同：

1. 最小address→完整key/lookup→消费有效hit或形成真实miss，必须先于material miss组织。
2. key/witness/value/continuation的容量、writer和生命周期明确。进入可选协议前处理可判断的域容量不足；不能把“所有像素先probe再因长期耗尽quota回direct”作为正常有收益路径。
3. request先经dispatch发布为不可变输入；nomination仅原子登记request index并比较完整已发布key，不读同dispatch未发布多word payload、不等待其他workgroup。
4. 唯一miss与拒绝项运行原closure，其他字段保留完整residual。field key不能冒充全部residual输入，consumer不能另decodeGeometry。
5. 有效值发布到原consumer；旧slot在最后reader之后才可覆盖，generation不回绕。提交/abort/namespace与fence retirement在同owner完成。

hash只定位，完整原CXY/footprint/动态输入/资源版本判等；key不容纳或不划算时direct。static值不含无关camera epoch，view-dependent值保留真实view依赖。缓存边界允许内部昂贵子图，但必须同时定义全部consumer和实际执行切断，不把“允许内部边界”当成已实现。

**未决范围：** 首个实际有收益closure、重复窗口、缓存工作域大小、请求预留/补充方式、Store工作集与替换策略的成本profile。当前协议是候选执行基础，不是这些选择已经定案。固定stride、扩Store或换身份编码不代替此决策；没有普通合法有收益成功，C不能靠永久direct/miss完成。

### 6.3 信号历史独立核算

history复用的是Lighting产品，不能抵扣已执行的Appearance。净收益为省掉的Lighting减去重投影/validity、previous owner读取、当前写入、recipe发布与退休的全部新增成本。

保留六RGB f32＋显式state的原signal buffers双角色方案：Lighting直接写当前槽，Reconstruct消费同一产品，提交后成为下一帧读槽；只保留必要owner recipe，不再展开或全屏复制六信号。abort不推进读角色，resize/device replacement按fence退休；OFF移除完整history槽和维护。

各signal按真实provider、TemporalFacts、normal/depth/identity、view/content与transport/residual条件拒绝。全部有效时不重做被省掉的材质读取/BRDF/rate准备；部分有效只补实际所需原分支。静止画面结果不能外推动态场景，不为提高命中省去真实view/scene失效。

### 6.4 空间率与材质计算率分开

六signal独立声明sample locations、footprint、rate、validity与原语义。具名本地 **Signal Footprint Admission** 在实际guides及provider事实可用后决定共享；material ID/Winner相同不证明normal、view、light/shadow或过滤等价。

保留普通合法diffuse/irradiance共享和局部拒绝，细几何、高频normal、低roughness/specular/coat、接缝、新显露与provider变化仅提高相关signal率。当前充分条件以完整依赖相等为基础；若扩展近似采样，先固定独立误差/重建/接缝/失效合同并取得质量范围认可。不能以多层temporal平滑隐藏漏工作。

Appearance cache、history、spatial分别验证，再验证combined；组合更快不能掩盖单项成本失败。

## 7. GPU产品、命令与物理生命周期

| 产品 | producer → 全部直接consumer | 保留责任 |
|---|---|---|
| Coverage/depth/motion/identity | 原Visibility/Geometry/TemporalFacts → Surface、Temporal、重建 | 必需事实全率、版本完整，不随复用丢覆盖 |
| UV/CXY/color与原始TS/guard输入 | 唯一Geometry＋Appearance → 当前局部查询/guide/guard sinks | 完整数学，默认无全屏冷输入副本 |
| closed Geometry、fields、guides或uniform refs | 正式Surface producer → Lighting、率与Reconstruct | 只留实际consumer；不省view fallback/finite输入后补算 |
| Ddirect/Denv/Sdirect/Senv/CoatDirect/CoatEnv | Lighting → Reconstruction、合法history | RGB f32、独立validity/owner/version，transport与radiance不混用 |

Reconstruct只读immutable结果及output-pixel因子：emissive/unlit→direct transport或colored residual→按原AO/occlusion与1/π合成Denv→原顺序加入四个specular/coat项→既有颜色空间/pre-exposure。AO作用域和加法分组不变，guard在权威producer发布。

完整输出目的地独立于可选cache/overlay。覆盖分区为sample-covered、indexed-full-rate、background，最终写域互斥且并集完整；空间重建不得原地互读未发布写入。零/tiny/满可选容量走原direct；mandatory容量非法在prepare前事务失败，保留上一合法状态，不能将未写payload当有效值。

物理预算包括metadata、settings、临时、closed products、cache、两个不同history槽、pending/retired overlap及alignment。一个物理资源只记一次，但不能漏记另一个槽；allocation、实际读写、峰值与帧时分开。现有Surface **768 MiB** 合同不提高，不等于全renderer预算或性能目标。

Product Surface协商profile保持 **9+7=16 storage bindings**；arena-backed frame属性不增加第17个binding。各buffer大小、u32算术、binding alignment、texture/group/workgroup limits在创建前检查；同whole buffer的冲突read-only/storage usage不能以range不交叠豁免。可选subgroup/f16等不成为未经协商的正确性条件。

FrameGraph编译resolved refs、acquire/release及RAW/WAW/WAR；execute只处理自身事件，不逐node扫registry。晚绑定解析当前物理角色，cached graph不pin退休对象。逻辑last use与真正destroy分开，跨提交资源等待completion fence；submit失败与abort都不能发布成功版本。

## 8. D/E/F：具体缺陷与集成责任

| 单元 | 保留系统 | 具名改动责任 | 退出范围 |
|---|---|---|---|
| D Geometry缺陷修复 | hierarchy/SSE、HZB、frame/resident数学与owner | 核真实树深和完整工作；区分普通camera motion/cut与保守恢复；camera可见和shadow caster需求分开；共享属性不足有完整fallback | 当前合法深树/遮挡/运动/LOD/page/屏外caster的真实覆盖与工作量；不重做整套Geometry |
| E Lighting/Shadow工作生成 | 原BRDF、provider、cluster和VSM资源 | 已确认的逐cluster全灯扫描改为有来源的影响范围工作；overflow覆盖全部光；sampling constants、页完成/commit、light-space caster等缺producer逐项补齐 | 非零有效light/shadow、溢出完整、dirty页和容量恢复及全成本；不把整个Lighting改名重建 |
| F Temporal/Post集成 | TemporalFacts、FSR3、曝光、Atmosphere LUT与原post | 统一事实和事件；保持各history自己的validity/read-write角色；修真实cut/resize/abort/device/radiometry失败 | 连续帧和原合成数值/寿命回归；不新增通用history coordinator或重写FSR/后处理 |

D/E条目开始前用源码核实：已满足的项验证后关闭；有缺陷的项明确producer/consumer与独立预期；只有热点假设的项先记录未知。pageConstants、local shadow stub等历史描述不得直接当当前事实。

必要consumer随当前producer前移，不能把影响Surface正确性的接线等到D/E/F。阶段顺序不允许承接已知必需缺陷进入正式验收，也不要求没有缺陷的系统再改一次。新增光照/时域算法另立其完整来源、质量和实施范围。

## 9. 验证与文档责任

开发单位是完整producer→GPU产品→全部直接consumer切换，连同binding/reset/capacity/失效/retire和direct恢复。实施中只做必要编译与最小调试，完整链后集中typecheck、build、新鲜build:test及本范围真实GPU/CPU检查；失败定位后重跑原例和受影响回归，不逐patch性能选型。

证据分三类：完整数学/真实消费；实际工作量/唯一写域/物理结构；同质量全成本。mock/regex/组件数值不证明生产全链，counter下降、容量合法、零API error和测试数量都不替代净收益。独立预期、原失败、源码/build身份与未测范围必须保留；规则细节在执行计划§1.4统一维护。

完整span、pass sum、CPU encode、queue completion分开；missing timestamp、copy/clear/gap与未分类pass不记0。新增pass必须进入报告或显式unknown，不能用漏项Surface小计判断收益。融合scope若含管理和direct求值，不仅凭label计算管理/求值比例。

所有主要架构和计划中的providers完成后才做正式browser matrix、连续画质、resize/cut/device loss、固定历史checkout及目标硬件P50/P95/evidence/claims；`verify --full`属于该范围。局部重构不因未来provider未完成而停工，也不能据此提前提升整体验收。

设计母稿只维护本合同与未决设计，不复制阶段状态/测试计数。执行计划维护当前事实和结果，workstream维护currentSlice导航；来源账本只维护来源/采用。旧章节编号、失败和实验放历史，不再追加多套SD/S/阶段状态轴。

## 10. 来源与历史导航

沿用[固定来源与迁移账本](../porting/next-renderer.md)：SF01工作组织、SF03插值、SF04资源事件、SF07材质/过滤、SF09 portable scan、SF10/11 Typed Tape/相干任务及SF06域任务/历史角色。完整revision/许可证/源函数映射只维护在那里；本修订不选新donor或提升采用。PMC的离散UV/压缩值/64-bit CAS收益不转授本地精确缓存。

历史仅追溯：[R3设计快照](../archive/eengine-extreme-performance-rebuild-r3-design-2026-10-07.md)、[R3执行与原始失败/实验记录](../archive/eengine-extreme-performance-rebuild-r3-execution-2026-10-07.md)。两者保留 `d16cc1d6` 原文；旧§6.9→本文§4.2，旧§8→§5，旧§9/10→§6，旧§12/13→§7，旧§15/16→§8，旧§18→§9。历史编号不继续作为实施任务。

可证伪入口：若lookup仍先做完整Geometry、命中重跑heavy、未准入工作仍走重协议、Reconstruct补算PBR、全miss无完整恢复、命令随graph复制、binding超限或峰值漏历史/退休，相关合同未满足。源码和真实消费证据决定实施状态，本文存在不证明已完成。
