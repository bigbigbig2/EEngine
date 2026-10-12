---
id: final-pixel-source-diagnosis-2026-10-12
state: history
---

# Final Pixel 源码与整帧性能诊断（2026-10-12）

后续已授权实验见[Native Temporal观测返工报告](2026-10-12-native-temporal-observation-rework.md)与[执行authority §7.2](../next-execution/eengine-v5-final-pixel-performance-execution-2026-10.md#72-用户授权的完整-native-11-物理返工2026-10-12)。本文件保留原诊断快照，不以新实验覆盖原未资格结论。

这是 HEAD 1c41fb77e3f0fc3b82b242a148516d92b3dc38d3 的只读诊断快照，不是新的设计、执行状态或性能资格声明。目标为 GTX 1650 Ti 4GB、1920×1080、renderScale=1、同等或更好质量、Whole GPU P50≤16.67ms，同时控制 P95/P99。本轮没有改 production renderer/shader，没有提交、子 agent、GPU benchmark 或新的性能 qualification。

## 1. 一页结论

**当前没有可靠的整帧净收益。结构删除是真的，优化资格没有成立；现有数据也不能把最终 HEAD 判成确证回退。** 四轮有限 ABBA 的 After 是 Phase 5 当时 dirty build，并非最终 HEAD。每轮只有 60 个完整 target GPU 样本，88–91°C、thermal Active、频率明显漂移。不能选 B2≈A2 的 P50 宣称成功，也不能用 A1→B1 的回退量宣称已经正式证伪整个架构。

最严重的三个问题：

| 优先级 | 问题 | 已证明 | 尚未证明 |
|---|---|---|---|
| 1 | 1:1 Temporal 仍是昂贵完整重建 profile，其观测前段存在具体重复消费 | B2 Temporal P50=7.519ms；同帧 Measure+Exposure+Pyramid+Analyze 和的 P50=4.311ms。Analyze 在 N 像素上求 4 个 low_change，每点读 3 层，合计 12N filtered layer samples；旧半分辨率 producer 只有 0.75N | 去掉这种放大能省多少毫秒；Measure 的 16KiB/归约是否限制 occupancy；整个 AMD profile 能否满足目标预算 |
| 2 | Native 是最大测得桶，但 fusion 把旧工作和新税集中在同一个执行域 | B2 Native P50=11.034ms；PCF、Sun、Seed 没消失。旧 S3 大部分是深度邻域恢复，不是第二套完整材质求值；Facts 也没有三角形完整重建/材质图 | register spill/occupancy 是根因；material/PCF/Seed 各自准确时间；fused 相对有限拆分的净劣势 |
| 3 | 成本模型与测量没有形成整帧收益闭包 | store/clear 下限仅 69→68.8125 B/pixel；活跃 identity+color profile 70→78 B/pixel。Geometry frontend 未变。ABBA 非最终构建、热漂移、interval=4 与八相 jitter 可能混叠 | 热混杂解释了全部差异；API 容量下降等于 DRAM 减少或满足 4GB 驻留；组件 oracle 正收益能外推真实 Dungeon |

**唯一优先返工建议：Native Temporal 1:1 的完整物理执行单元，重点重做 Measure→Exposure→Shading Pyramid→低分辨率 shading-change 产品→Analyze 的 producer/product/consumer 组织，并闭合 Resolve/RCAS、角色提交和退休。** 保持 AMD 参考质量 profile、own-pixel Seed、批准的 3×3 前景颜色 receiver、完整身份/generation 与 pull 语义，不研发新 Temporal 算法。最明确的入场依据是低分辨率量被全分辨率重复计算；不是“再少几个 pass”。建议只值得一次有停止条件的完整候选，不值得无限重构。

整帧限制必须先承认：B2 P50 距 16.67ms 差 **8.872ms**。逐帧扣除全部 Temporal 后，剩余 P50仍 **17.768ms**、P95=19.798ms、P99=20.062ms。把全部 Temporal 变免费都不足以在该窗口达标；不能把本建议包装成一次返工就获得稳定 60FPS。Native/Sun 的后续判断取决于隔离证据，本报告不自动进入另一个模块。

## 2. Source Truth 与当前实际 execution graph

### 2.1 重新确认的事实与审查范围

开始与结束检查 git status：开始仅用户未跟踪的 .vscode/；HEAD 为 1c41fb77。本轮仅新增本报告与忽略目录中的诊断输出，未触碰 .vscode/。生产源码逐文件 SHA256 快照用于结束复核。

近期相关提交按新→旧：1c41fb77 Phase5 接线/退休/集成；acecfab2 Phase4 AMD profile 单路径切换；1ad294b0 更换完整参考 profile；e26b922b 观测与共同提交返工；814cdbaf 隔离 V2；015548a7 Seed/Facts 退休；c71c6d31 Sun 私有域返工；8db2c82b Shadow physical fusion；9f305c41 非生产闭包；49fcaa30 旧 T3 native reconstruction。提交意图不能证明成本。

workstream.authority 是 [V5 Design](../next-design/eengine-v5-final-pixel-performance-2026-10.md) 与 [V5 Execution](../next-execution/eengine-v5-final-pixel-performance-execution-2026-10.md)，currentSlice 为 final-pixel-performance-v5。Phase2/3 净性能未资格，Phase4 组件/动态质量闭合但整帧未资格，Phase5 必要正确性与退休结构关闭，Phase6 未开始。全局 V4 不变量继续约束 GPU ownership、唯一 submit、generation/overflow；不恢复 retired VM/cache/effect owners。

已阅读根及 render/shaders/gpu/framegraph/material/scene 相关近目录约束；使用 vibe context 查 owner。深入阅读当前 FrameProgram/Lowering/RendererCore、全部 Surface 核心实现、Native Material/lighting/Seed/position/geometry/BRDF、VSM producer→atlas→publication→sampling、Temporal/FSR、FrameGraph、实例/帧几何 ABI、材质 publication、资源账本与 profiler。旧 49fc 基线另读真实 import 链，而非只看 diff。

完整生成的 WGSL 已离线展开、保存并检查：ordinary/Product × dense/compact × coated/unlit 八个合法结构 profile，以及 V2 五个 shader 的完整字符串（包括生成的 9 个 current taps）；RCAS 与 FSR 的完整 source 也检查。**这些 Surface 是 canonical 无 texture 的结构展开，不是 ABBA Dungeon 每个实际 material permutation 的 runtime capture；raw 只存 shader hash，缺失实际全部编译模块、机器码和硬件计数。** 因而本报告能审查完整生成 hot path，但不能冒称已审计 Dungeon 全部 textured 机器代码/寄存器。该缺项属于最小后续实验，不能用 generator 长度代替 occupancy。

诊断附件在 [.local 输出目录](../../.local/final-pixel-source-diagnosis-20261012/)：recompute.mjs、recomputed.json、measurement-audit.json、A1/B1/B2/A2-actual-graph.json、generated-manifest.json、完整 WGSL、donor-verify.json、production-source-snapshot.json。这些是本机可复算附件，不是新的 source authority。

### 2.2 正常 lit / Physical Sun / Native AA 图

I=内部渲染域，O=输出域，N=I 宽×高。默认性能 profile I=O=1920×1080，N=2,073,600；8×8 域为240×135=32,400组，无图像边缘空 lane。

~~~mermaid
flowchart TD
  P[GPU scene与publication准备] --> G[主view hierarchy / MeshletWork / frame instances与vertices]
  G --> V[Visibility raster + previous HZB prediction]
  V --> H[HZB / current recovery / recovered raster / final HZB]
  H --> D[VSM receiver demand / ordered allocation]
  D --> C[独立shadow Geometry / caster pairs / compiled raster]
  C --> Q[complete page commit / content version / sampling descriptors]
  Q --> L[Solar LUT GPU copy + final lighting publication]
  H --> AO[可选GTAO]
  H --> LL[local-light work]
  L --> S[Native bins / HDR initialize / winner shading]
  AO --> S
  LL --> S
  S --> HDR[HDR + own-pixel Seed / response / identity]
  HDR --> E[Sky / Aerial]
  E --> M[Measure]
  M --> X[Exposure]
  X --> SP[Shading Pyramid]
  SP --> A[Analyze]
  A --> R[Resolve]
  R --> RC[RCAS]
  RC --> B[可选Bloom / Radiometry]
  B --> O[Present]
~~~

owner 不等于 GPU pass：Surface 一个 graph node 内实际有 bins 2 compute、HDR init 1 render、winner 1 compute；winner pass 内按 Program/BindingSet bins 逐次 indirect dispatch。VSM 一些 graph node 仅 upload/copy，allocation 一个 node 内有十个 compute passes。V2 六个独立 dispatch；两个 HZB graph node 各编码 compute pyramid（内部多 dispatch）。同一个 command/submit，不能把节点数当物理 pass 数。

### 2.3 物理阶段合同与成本入口

| 阶段 / 分辨率 | 实际执行组织 | 输入→输出→直接 consumers | 格式/访问/同步与有效 lane |
|---|---|---|---|
| 主 Geometry / gpu-work | hierarchy root + 四轮，MeshletWork；instance 4阶段，vertices 3阶段；随后 prediction/recovery | Scene/assets→work/frame transforms/vertices→Visibility、Surface、VSM receiver | instance select/build64lane，begin/finalize1lane；atomicExchange 去重+atomicAdd work append。vertices 合作构建，完整容量+generation；当前帧不读回控制 |
| Visibility / I | partitions begin/count/prefix/scatter + winner render；recovery再次 partitions/raster；两次HZB | work、coverage→R32Uint VisibilityKey + Depth32Float→Surface/VSM/AO/HZB/Sky/Aerial/local work | 独立 MASK dependency graph 在 raster 采样精确coverage。光栅 lane/tile效率和 overdraw 无硬件计数；不能宣称27draw只工作27次/像素 |
| VSM receiver / I | 8×8 screen tiles + clip级补需求，**同一 compute pass 两 dispatch** | depth/key/work→requested bitset→scan/allocation | 深度反投影、WG 聚合与 atomicOr demand；没有 material graph；无Sun时整个owner图不进入 |
| VSM allocation / gpu-work | count/prefix/scatter requests、touch、collect slots、count/prefix/scatter misses、allocate、publish dirty：10 passes | full page domain→完整 demand / misses / allocation→shadow work与commit | 64lane，prefix单组、小count尾lane；requested bitset ceil(entries/32)；原子/跨dispatch发布，不能把dirty0等同于整链0成本 |
| Shadow Geometry / gpu-work | 第二view hierarchy/instances，bounds、pair prepare/compact/finalize、partitions；1 atlas render | allocation+scene→complete caster pairs→Depth32Float atlas | high4096²=64MiB，128page+4border，30²=900slots；6clips。dirty pages控制draw工作，但仍有domain/dispatch tax；generation/projection namespace/content 完整 |
| VSM publication / page domain | complete content commit、version1lane、descriptor publication64lane | tables+atlas完成态→16B fine/coarse sampling descriptors→Native PCF | 顺序buffer写；后置发布避免partial content；本帧没有GPU→CPU→GPU反馈 |
| Solar / 256×64 LUT | GPU texture→buffer copy 128KiB；final lighting CPU/GPU常量发布，无fullscreen shader | physical transmittance→buffer→Native Sun | 单frame pool、最多3容器；manual半浮点解包+四点bilinear。该copy在Whole里但不在独立timestamp pass桶 |
| LocalLightWork / tiles+depth slices | zero authored lights **无dispatch**；非零 sparse多阶段+递归scan，overflow DIRECT完整退路 | key/depth/lightDB→lookup/list→Native | 32×32 screen tile ×24 depth slices；随机灯访问。Dungeon authored lights=0，不能归咎“昂贵大量local lights” |
| Native bins / I tiles | bins>1：classify+finalize 2dispatch；bins≤1：dense/empty无需queue | key/work/instance/directory→12B tile+mask records/bin→winner | classify64lane，shared约2060B，uniform路径与mixed CAS/hash，最多64不同bin/tile，不丢像素；queue容量(12×32400+32)×bin数；mixed时每bin有效mask lane占比未知 |
| Native winner / I | 1 compute pass，K bins分别dispatch；compact64lane、dense8×8 | geometry/directory/material/IBL/AO/VSM/Solar→HDR8B、Seed16B、response4B、identity16B | 每有效winner一次 resolved+attributes；PCF默认16point taps；多种随机input；没有全局SurfaceRecord、shader barrier或scatter。空mask lane早return，按tile/bin重复启动不是重复完整求值 |
| HDR init / I、Sky、Aerial | init1render；Sky1render；Aerial1compute8×8 | Surface HDR/rawdepth/atmosphere→final HDR→Temporal | Sky只背景有效但是full target raster；Aerial再次由depth恢复位置、LUT采样、写新的RGBA16F；效应自己的恢复仍在 |
| Native V2 / I=O | Measure、Exposure、Pyramid、Analyze、Resolve、RCAS=6dispatch | Seed/finalHDR+history→new history/sharpen HDR→Present | 详细绑定、共享/采样见§5；所有history和Seed camera/identity同submit推进 |
| Radiometry / O | fixed exposure0GPU dispatch；auto histogram+reduce2dispatch | reconstructed color→adapted exposure→Present/下一frame | 与V2内部exposure不同owner/用途；fixed5不删除Temporal内部Exposure |
| Bloom / O | OFF0；ON extract+4down+4up+composite=10dispatch | reconstructed HDR→filtered HDR→Present | RGBA16F半域起，8×8，extract16point、down9/13filtered、up9filtered+high；output域成本不能漏入预算 |
| Present / O | 1 renderpass | HDR/exposure/display LUT→BGRA8Unorm canvas | 每pixel HDR与3D LUT采样、tone/display变换；AA bypass低scale时最近邻resize，不等于true upscale |

VSM tables 是12words/entry的48B page table，高profile按6clip和6mip完整分配；sampling descriptors 为4个u32、16B/entry，不能与48B page table混算。high profile count=6×(128²+8²)=98,688，输出1,579,008B，64lane共1,542组；每帧完整发布，末组无空lane。Geometry residency bank536,870,912B、metadata134,217,728B在ABBA中未变；这些是容量，不是每帧全读。所有变长gpu-work组数由完整GPU count/indirect决定，raw没记录逐组有效lane，表中没有伪造利用率。

### 2.4 七类条件图的区别

| 条件 | 实际进入 / 消失的GPU工作 | 必须计入的保留税 / 未测范围 |
|---|---|---|
| Native 1:1 AA | Seed+六dispatch V2；color/depth/luma/confidence/frameInfo histories | 同域全N，当前AA运行路径无条件编码RCAS（sharpness=.2），不是独立开关事实。本轮raw只有此主profile |
| True upscale（任一轴I≠O且AA开） | Seed→upscale classification→FSR ratio→Prepare Inputs/scatter→Luma Pyramid→Shading Pyramid→half Shading Change→Prepare Reactivity→Luma Instability→O Accumulate→RCAS | 原生native scatter已删；**true upscale scatter仍合法生产**。FSR各尺度多dispatch，不是这些owner各一个pass；见下表。不得用1:1成本替代 |
| AA bypass | 不执行V2/FSR颜色链、无颜色history writer | 当前Renderer仍prepare 52N Seed allocation、Native写Seed/response/identity，attach surface-writer；不是完全免Temporal输入税。debug classifier仅按需求出现 |
| All-unlit | Native选择baseColor，跳lit material/Local/IBL/Sun/VSM；成功submit退休lighting pools | Geometry/Visibility/Seed/颜色AA仍在；物理环境开时背景Sky/Aerial按frame需求继续。混合lit/unlit时lit路线触发共同VSM/providers，不按unlit覆盖率线性删除whole成本 |
| Physical Sun OFF | final HEAD不创建该epoch VSM resources/passes、shadow Geometry/Solar，lit仍走authored/local/IBL | 无IBL使用共享1×1零辐射8B provider；“全部physical环境关闭”与“Sun照度0但owner仍enabled”不同。原ABBA未覆盖最终条件修正 |
| AO/Bloom OFF/ON | AO off0；scalar-high on通常normal+prefilter+reduce+main+denoise=5dispatch（2storage limit适配更多）；pack无consumer被cull。Bloom on10 | AO I域，Bloom O域；18depth taps/high pixel与后处理完整流量。主ABBA两者off，不能给on的性能结论 |
| ordinary/Product/multiProduct | 相同owner/queue图；Product绑定metadata+四banks；multiProduct用完整统一来源snapshot | ordinary可读frame arena；Product有resident/frame/source分支。bin按uniqueProgram/ExecutionBin增长，不按材质实例数；Product material field采样另增加实际bindings/samples，不等于额外fullscreen pass |

True upscale 的实际dispatch合同（源码可推导，未测本轮GPU）：ratio1；classification按需求1；Prepare1、8×8、9depth search与最多4atomic scatter+reconstructed4N clear；Luma source/reduce均8×8 workgroup（64lane、1KiB shared；source每lane先归约2×2，覆盖16×16输入域）+逐级reduce（按extent、每轮≤4mips，有必要mip5量化）+frameInfo1；Shading source+逐级reduce到2/4/8；half ShadingChange1；Reactivity1（4storage limit）或分3；Instability1；Accumulate1于O；RCAS1于O。不能照搬donor“一次SPD”称本地一次dispatch，也不能固定报一个与尺寸/limits无关的total。固定Geometry/Sun部分与上图相同。

## 3. Before→After 真实工作迁移

比较B=Phase5 measured dirty build与A=49fc完整旧执行。最后HEAD功能接线另列，不偷换baseline。

| 工作 | 删除 | 搬迁 | 新增 / 仍重复 / 未确认 |
|---|---|---|---|
| Shadow Resolve S3 | full-I pass、packed1B/px shadow visibility写与Native读、resolve→Native边 | PCF taps、receiver/bias、Solar/Sun→Native | S3大部分由depth邻域3点世界位置/crossnormal恢复；fallback才完整几何。Native新增plane-ray，并仍做winner attrs插值；fine descriptor广播不再保留 |
| Temporal Facts | full-I pass、rawdepth inverse-camera链、Native reactive staging读、previous-identity比较所在旧pass | motion/identity/hash→Native Seed；previous identity/hard replacement→Analyze | Native旧4+Facts28写→Seed36写，+4N。Facts生产源native_surface_aux只用work/instance/versions/depth；metadata/payload虽绑定但不读；不能称删第三次完整Surface/材质恢复 |
| 1:1 Prepare/scatter | Prepare dispatch、reconstructed depth4N buffer/clear、最多4atomic scatter、dilated motion/depth/farthest产品、全局scatter→consumer边 | luma/exposure、foreground selection、confidence/lock/luma/rectification→V2 | Measure仍做9Seed depth search；half metric保留；+rawprevious-depth8N双槽、4point pull、receiver4N与三consumer索引读 |
| Luma/Shading SPD链 | Native 旧source/reduce多pass、中间尺度/global products | exposure归约→Measure/Exposure；signed difference→Pyramid | Pyramid已修复早期16倍source sorting；Analyze仍四low点×三层重复，别把两种放大混为一谈 |
| 旧 T3 Resolve/classification | old owners/classes production退休 | AMD confidence、四帧luma、thin lock、16point fractional历史、9tap当前统计、tone blend留V2 | 这些重建数学旧49fc已有，不是“V2首次新增完整AMD才变慢”。当前pipeline/身份/depth输入变化对成本比例未知 |
| IBL/local/material | 没有删除正常lit material/IBL | 保留Native | oct diffuse4、specular8/coat另8、DFG、normal、graph仍在；texture-gradient有C/X/Y需求的graph仍多点求值 |
| Geometry frontend | 没删；关键源码hash相同、27draw相同 | 无 | 场景/频率变化使时间变化，不是本次Geometry优化。shadow Geometry与receiver都还存在 |
| Phase5 resource retirement | empty/all-unlit/disabledSun旧allocation、history candidate账盲区 | 最后consumer fence完整退休 | 正常Dungeon lit/Sun/AA持续有consumer，不减少这些活跃shader工作；主要是容量与退出合同收益 |
| final HEAD条件修复 | OFF Sun epoch无VSM；无环境中立IBL | 正确按需求编排 | 晚于ABBA；没有final exact-build whole数据。主ABBA Sun ON，不应分摊这些OFF收益 |

**现有cost model被推翻的具体部分**：把“第二/第三 geometry recovery删除”按完整geometry+attributes+material求值估价，缺乏旧production支持；把删除scatter推断为大幅总带宽下降不成立。不是所有原DELETE都虚假：dispatch、4Nclear、atomic和shadow mask确实删除，但ADD也真实。

## 4. 已有测量的可信度与raw复核

### 4.1 构建身份与样本

全部raw入口存在：[A1](../../.local/phase5-cost-v2-A1/full.json)、[B1](../../.local/phase5-cost-v2-B1/full.json)、[B2](../../.local/phase5-cost-v2-B2/full.json)、[A2](../../.local/phase5-cost-v2-A2/full.json)。summary存在，但本报告从full.json重新计算，不引用summary当raw。

A revision=49fcaa300fafcbbe3db142df403baa3487f89956；B revision=acecfab2495a4b5c6d5420efc9f1d2083abe6bb0 + Phase5 dirty changes。A对内部source/build fingerprint相同，B对内部也相同。最终HEAD与B的FrameProgram.ts、FrameProgramLowering.ts、RendererCore.ts、SurfaceV4.ts不同；B的Native/Temporal shader hashes仍匹配final source。不能把“shader相同”提升成“整个构建精确相同”。

关键hash：A bundle index-CAcZ-HlS.js=d0c0f60bee1118c3e6abced857780653670ee9d51667d72cfdb062308bb7f9a4；B bundle index-DDgDykeY.js=d9126f1f0ed1342c4426ad209b7225a6a1b25d0bf75aee6598c8245501ee9d28。A native_surface=e03c49d3…aa511；B=5f216ca2…ca7d15；B native_temporal_amd=502114f4…6f48c。完整raw SHA/逐文件fingerprint见附件与原run目录。

以[targetStart,targetEnd)筛选、GPU sampled且含span，四轮都是240target frames中的60完整timestamp samples，interval4。样本frame范围A1 504–740，B1 428–664，B2/A2 448–684。分位数使用排序位置(n−1)p线性插值，复现给定P50/P95/P99；example/profiler的nearest-rank口径不同，不能混用。

| Run | Whole P50 / P95 / P99 ms | receiver→Native envelope P50 | Native / VSM / Temporal P50 |
|---|---:|---:|---:|
| A1 | 18.958 / 42.098 / 57.389 | 9.959 | 4.931 / 3.883 / 4.774 |
| B1 | 22.324 / 58.104 / 122.662 | 12.306 | 9.762 / 1.344 / 6.659 |
| B2 | 25.542 / 27.724 / 27.880 | 13.946 | 11.034 / 1.494 / 7.519 |
| A2 | 25.654 / 28.377 / 28.460 | 13.467 | 6.806 / 5.162 / 6.473 |

VSM桶含旧S3，After PCF在Native桶。envelope是同frame从receiver demand开头到Native结束的连续span，含shadow Geometry、bin与间隙；不是纯VSM+Native互斥和。几何 broad桶P50=2.429/2.566/2.820/3.281含主view与shadowview，和envelope重叠，不能再相加。

### 4.2 同frame先加互斥工作，再求分位数

| 每frame构造的量，随后求P50 ms | A1 | B1 | B2 | A2 |
|---|---:|---:|---:|---:|
| Native + S3 + Facts | 8.310 | 9.762 | 11.034 | 11.184 |
| Native + 全VSM + Facts（不含shadow Geometry） | 9.565 | 11.138 | 12.641 | 12.875 |
| Whole − Temporal（零成本反事实） | 13.992 | 15.636 | 17.768 | 18.906 |
| Whole − Native（零成本反事实） | 14.022 | 12.455 | 14.181 | 18.567 |

后两行只是数学上扣已测桶，不是实际关功能所得可用图，不保证删除后其他pass/cache/频率不变。没有相加各阶段P95/跨帧拼中位数。A2→B2 Native桶+4.228ms，旧S3 3.446ms + Facts .844ms与此接近；合并成本11.184→11.034。这支持“巨大的Native上涨相当部分是归属搬迁”，不支持“fusion毫无额外税”，也不支持可靠whole净收益。

B2一个接近Whole中位数的实际frame608：primary frontend2.712、全部VSM1.501、shadow Geometry/partitions等未列pass差额.591、bins.547、Native10.609、环境.809、Temporal8.134、Present.393、span-gap.261，总25.557ms。此处每项来自**同一frame互斥pass**，和P50=25.542的差仅是选取实际frame；Temporal中Resolve3.620ms，不能用另一个frame的2.868中位数替换它。

### 4.3 target与runner stable必须分开

runner先等待fullQuality，再累计60个submitted warm-up，并要求visible/nonpaused；它的stable数组还有自己的收集/截断边界。stable GPU n=49/44/54/54，不是每轮60个target；stable nearest-rank Whole P50/P95分别19.200/44.481、22.449/90.218、25.305/27.793、25.277/28.377。B1 stable P95比完整target显著更差，不能挑一个子窗口隐藏尾帧。代码：example main.ts:144–150、302–316、787–795；profiler统计与本报告线性插值定义独立。

### 4.4 query范围、遗漏与测量扰动

60×4 frames逐一检查：所有pass tick区间在Whole span内；**queried pass彼此无重叠，outsideSpan=0，truncated=0**。span/stage是嵌套/覆盖范围，不可与pass求和。A有84compute+6render=90queried passes，B73+6=79；dispatch108→97，draw27→27，一submit。每轮额外26个Profiler timestamp marker compute passes直接走encoder，未计入上述commands.computePass，因此真实有marker的物理pass数至少A116/B105。marker相同并不证明扰动完全抵消。

Whole−所有queried pass和的P50=.366/.249/.262/.408ms。这包含pass间gap、copy/clear/marker等，不能归为DRAM或“driver纯开销”。query resolve与readback copy在span关闭后执行；Whole不是包含所有后续GPU队列作业的总时间，也不包含queue.writeBuffer在encoder之外的GPU上传、呈现/vsync、CPU/OS调度。标称Whole应读作**有测量扰动的主command span**。

readback仅timestamp1648B→1472B，gpuCounters.sampled=false/values为空；没有normal帧counter dispatch/readback。Native/VSM代码仍含运行时diagnostic_mode/debug分支；这些uniform取正常值时诊断写不执行，但没有机器码证明分支/绑定被完全编译消除。allocation audit/API patch和profile本身有CPU/GPU成本，不可称绝对零扰动生产时钟。正常debugView none、costSlice G；cost slices A/B/C的DCE anchor不是生产数学成本，不可相减得精确material毫秒。Solar每帧128KiB texture→buffer copy直接encoder，不在commands.copyBytes；45→41 buffer copies、112680→112524B只是已计buffer操作。

采样风险：四轮全部frameIndex mod8仅0与4，各30样本。八相jitter若与提交frame同相，将只看2/8相；raw未记录每sample committed jitter/abort角色，尚不能断言完整相位映射。这是需要排除的采样alias，不是证明regression的原因。最小重测用interval1或与8互素的间隔并记录实际jitter/roles；不要仅增加同相60→600个样本。

### 4.5 热状态与工作量

| Run | 全run温度°C / MHz | full scenario capture内稀疏传感器 | 该capture VRAM MiB |
|---|---|---|---:|
| A1 | 90–91 / 1065–1305 | n4，90–91°C，1095–1305MHz | 2287–2298 |
| B1 | 88–91 / 930–1350 | n5，89–91°C，930–1140MHz | 2182–2188 |
| B2 | 90–91 / 885–1350 | n4，90°C，885–945MHz | 2188–2189 |
| A2 | 90–91 / 795–1350 | n4，90°C，795–825MHz | 2287–2294 |

GPU GTX1650Ti、driver581.42，thermal Active。传感器约1500ms一次，不足以绑定每个122ms尾帧；不能用clock简单归一化消掉缓存/功率/带宽/热持续状态。A1→A2同build漂移35%，足以否定用顺序A/B作净收益估计，但不是“没有性能问题”的证据。

设置匹配：1080p/DPR1/scale1、SSE4、HZB/cone on、AA/sharpen on、GTAO/Bloom off、high atlas4096/6clip/4tap半径.75、physical environment/aerial on、lighting全开、authored lights0、fixed exposure5、非HDR display，固定camera匹配。snapshot coverage≈.906729/.906884/.906729/.907025、invalid0；geometry payload30,377,856B、bank536,870,912B、unused216,006,656B/slack290,486,400B相同，texture demand437/438、dirty0、streaming无error，texture版本不同但末尾无近期变化。**这些末尾snapshot与payload匹配不等于逐frame工作完全一致**：缺active tile/bin masks、PCF page mixture、full frame residency/dirty/upload、历史fractional命中比例时间序列。staticcamera仍有jitter/history相位；phase尾声dirty0不证明整个target零dirty。

结论：timestamp足以定位当前大成本域与确认结构删除，不能给最终HEAD的正式净收益、P95/P99资格或因果比例。需要短、同条件、同工作、exact-build的辨别实验；本轮不跑正式长窗口。

## 5. Native 与 Native Temporal V2 深入成本分析

### 5.1 旧 S3 + Native + Facts，不是“三次完整 Surface”

旧49fc真实链：VsmShadowResolvePass导入vsm_shadow_resolve；Surface导入native_surface；NativeTemporalFactsPass导入 **native_surface_aux.ts::NATIVE_TEMPORAL_FACTS_WGSL**。旧目录另有 temporal_facts.ts/RG16 版本，不能把它当ABBA生产执行。

S3的8×8组使用约288B shared和两个barrier，lane0可广播fine descriptor。shadow_receiver优先通过 frame geometry 有效项确认，再用center和同winner X/Y邻点的三次depth inverse-VP求世界位置与crossnormal；数值/边缘/单pixel或cache不满足时才fallback geometry_complete。此前S3报告给98.74706% depth fastpath、1.25294% fallback，是该历史snapshot，不是本ABBA逐帧计数。其删除最多节省这些depth读/反投影/normal与fallback，不是普遍删除三角形全属性/normal-map/material graph。

旧Native已经每winner恢复三角形、插值attrs、求material/local/IBL/Sun；从S3的quarter-width R32Uint取一字，拆4个visibility byte中的一个。mask存储1B/px；shader每lane逻辑读4Bword，cache共享比例未知。S3本身仍执行相同point PCF；删除S3不是删除PCF。存在旧受限profile的additive continuation机制，但本ABBA每frame只记录一个Native winner pass，不能把未执行的第二Native pass计入这次DELETE收益。

旧Facts写RG32Float motion8+RGBA8 mask4+RGBA32Uint identity16=28B/px，读work、instance、native version和rawdepth/current/previous camera，作previous identity/hard检测。普通production并不调用完整geometry helper或material graph；asset_metadata/vertex_payload虽在layout/graph中声明，hot函数未访问。省的是重复key/work/instance/version、camera反投影、reactive staging/identity比较所在边界；不省完整material求值。上一代通用 temporal_facts 的来源绑定较重，与49fc native_surface_aux不能混称。

这直接限制原成本模型的理想DELETE上限。原Phase5报告“第三geometry/instance/material recovery”若理解为第三次完整Surface，则源码不支持；若只指身份/实例字段恢复，应改写成具体工作。

### 5.2 当前一次恢复，仍有新position/Seed与原属性成本

证据入口：[native_surface](../../OEngine/src/shaders/native_surface.ts):640–688、[geometry completion](../../OEngine/src/shaders/surface_geometry_completion.ts)、[resolved position](../../OEngine/src/shaders/native_resolved_position.ts):4–28。

实际顺序：key/work/directory/instance有效性→geometry_complete_resolved→plane-ray position→winner_interpolate有效性→seed_surface→geometry_complete_attributes→native inputs/material→local+environment+prepare_direct_physical→late PCF→Sun irradiance/apply→HDR。**一次resolved completion，不存在Seed再独立完整恢复geometry。** Product frame arena命中可省source header/payload路径，但仍读取triangle/indices/三角clip/localpos/affine/plane/coeff；fallback/resident路径成本按工作量变化。

plane-ray用inverse_view_projection乘vec4、一项矩阵列、两个plane dot、scalar除法、homogeneous xyz/w；这是新增的精确共享primary position。随后winner_interpolate仍为属性/导数执行，native_geometry_input的normal/tangent/双面方向、C/X/Y input与material sampled-coordinate分支仍存在。普通属性position插值可能被多个输入helper消费；编译器能否CSE/DCE、剩多少指令，需要实际permutation/机器码，不能把每个函数声明算成每pixel执行一次。极少singular ray/plane fallback再用已resolved corners的插值，不重新读geometry。

Seed保存自己的motion/current depth/expected previous-view depth/identity，在material之前写出；unlit也因此需要真实位置。previous-from-current是 **已发布affine三行**：[GpuInstanceAbi](../../OEngine/src/gpu/GpuInstanceAbi.ts) helper与[GpuScene](../../OEngine/src/gpu/GpuScene.ts):689。CPU在publication处处理inverse，WGSL构造/乘已发布matrix，**没有每像素求逆矩阵**。Seed的previous-world/previous-view/projection、depth与身份字段hash是新增Native ALU/读与live状态；old Facts做了部分相似运动计算，消除的是重复current depth反投影，不是消除motion算法。

### 5.3 PCF、descriptor 与 Solar：移动工作之外的真实ADD

默认high pcfTapCount=4是每轴4，形成 **16 point taps**，不是四个总tap。settings.filterRadiusTexels=.75；[CPU constants packing](../../OEngine/src/render/vsm/VsmReceiverDemandPass.ts):93乘2，shader filter_params.w=1.5。压缩分支先要求w≤1，此主profile不会进入单gather/四load的重复texel压缩；不是只看16个逻辑比较就推断16次物理load。边界/缺页可能走coarse fallback和descriptor/atlas不同读取；raw没统计16tap实际早退/压缩/level比例，不能给cache命中率。

旧S3以screen tile shared广播fine descriptor、uniform barrier；当前compact Native直接每pixel查descriptor/选择fallback。compact lanes可在mask/key处提前return，同一个workgroup并非完整共同receiver，不能随意加workgroupBarrier恢复旧广播。每pixel descriptor访问重复但邻近地址可能cache；“随机访存占了多少ms”未知。保完整fine/coarse/generation/projection/content，不允许靠忽略缺页或截断预算换收益。

Late Sun把material scopes先结束，已有代码刻意减小跨PCF liveness。DirectPhysicalResponse含diffuse/specular各3f32、四个标量及bool，逻辑约44B；local/environment两个vec3合24B，共约68B逻辑private carry，再加resolved receiver/flags/其余compiler保活内容。**这些不是物理register数，也不能证明spill或低occupancy。** 没有Nsight/驱动编译统计/硬件计数时，只能将大绑定域、coated/material private arrays、early return与texture latency重叠列为风险。

prepare_direct_physical在PCF前执行，完全shadowed也已算direct BRDF response；exact-zero visibility只跳后续irradiance/apply。旧独立S3可以更早提供visibility，编译/执行范围不同，这是应隔离的新增税。Sun采样从硬件texture filtering转为128KiB buffer publication、四texel×两u32、half unpack、f32手动bilinear与同一atmosphere数学；减少storage binding的目的不等于采样成本更低。copy正常Sun帧持续执行，不是只在LUT变动时；source reuse收益必须与新增copy/ALU同计。

### 5.4 Material、IBL、bindings 与 execution coherence

无纹理canonical完整WGSL绑定计数：

| profile | storage buffers | sampled textures | storage textures | uniform buffers |
|---|---:|---:|---:|---:|
| lit ordinary dense / compact | 9 / 10 | 6 | 4 | 8 |
| lit Product dense / compact | 14 / 15 | 6 | 4 | 8 |
| unlit ordinary dense / compact | 6 / 7 | 1 | 4 | 3 |
| unlit Product dense / compact | 11 / 12 | 1 | 4 | 3 |

四bind groups；material physical banks和Product fields再增加M/P sampled bindings及samplers，具体数量取完整publication descriptor。这里统计声明的binding footprint，compiler对未用resource的处理不是硬件live工作集证明。preflight先协商完整limits，不能把超限资源静默删掉。raw没有每bin Dungeon descriptor、materials占屏和bank/coat比例，所以15+M等风险不能转换成已测occupancy。

每lit pixel保留：diffuse oct4point、specular两LOD×4point=8、DFG硬件filtered1、AO scalar读取、local灯循环（Dungeon0）；coat非零另8specular点及coat BRDF/normal。**主要IBL手动oct采样旧Native已有**，不能全算fusion新增；Solar buffer half bilinear是不同新增变化。normal-map需要explicit derivative输入；Material Graph编译为直线native GPU code，C/X/Y只扩sample coordinate依赖，复杂坐标graph可能引起3点源sample。MASK alpha在coverage独立graph，Surface radiance graph裁剪alpha；不能指控所有MASK完整alpha/material双算。

compact按tile/bin保证Program/BindingSet一致，但每bin的64lane只mask中的lane有效；material边缘/高entropy可能在一个screen tile启动很多groups，每组少量lane，texture访问和geometry地址更散。它省per-instance命令但不保证满wave。classify shared hash/atomics/full-I key扫描和finalize仍约.545ms B2桶；具体bin/有效lane数raw未显式逐bin记录，本报告不从total dispatch猜物料数。跨phase的GPU bins mode/容量/entropy采样是必要实验，Geometry frontend本轮不重构。

### 5.5 Native增加：事实、归属与待证假设分开

1. **事实**：Native measured桶A1 4.931→B1 9.762、A2 6.806→B2 11.034；当前shader有新增position/Seed/manualSolar/perpixel descriptor，旧S3/Facts确实不再dispatch。实际combined Native+S3+Facts表见§4。
2. **归属**：PCF/Sun/motion/identity工作从旧桶进入Native，A2/B2的4.228ms涨幅与被移出桶4.290ms接近；不能将native桶涨幅全部称新增浪费。VSM桶下降也不能全称PCF优化。
3. **未证**：full fusion register spill、material+PCF occupancy冲突、fine lookup缓存放大、Solar buffer更慢、plane-ray/Seed比删旧恢复更贵。源码支持机制风险，无同条件隔离GPU证据支持准确比例。要以保持消费者与数值的诊断候选验证，不能用A/B/C DCE anchors简单相减。

### 5.6 V2各阶段完整产品、读写与算法成本

主1:1 default six dispatch，所有N域写包括sky。以下bytes为format逻辑，不是DRAM事务；每次filtered可能展开四texel、命中cache，不按“sample×stride”冒称实测外存。

| 阶段 | 1080p组织 / sampled-storage绑定 | 主要读取/样本 | 输出/共享/边界 | B2 pass P50 ms（不能相加） |
|---|---|---|---|---:|
| Measure | 30×17=510组，256lane，每lane循环16 source pixels；2sampled、4storage textures、1storage buffer | 每source HDR8；有效pixel nearest search9×Seed16（只用w，实际texture事务未知）；half box读Seed四点；luma/log/weights计算 | rawluma2N history、receiver4N、halfmetric.5N、log tiles2040B、weights96B。shared16KiB；6轮2×2树，每轮2次barrier，加初始barrier共13次动态barrier。1088pad边缘8行仍夹取luma，无receiver输出 | 1.540 |
| Exposure | 1组256lane，输入tiles+prior info，2sampled/1storage | 合作加载510tile到逻辑64×64log树、previous exposure/adaptation、exp/log | info16B；16KiB shared、11动态barrier，后半归约多数lane闲置。全设备依赖必须dispatch边界 | .015 |
| Shading Pyramid | 32400组8×8；6sampled、2read storage、3storage textures | receiver4+Seed16+response4；current/previous各5luma=10R16点（有效历史路径）；exposure ratio；two5element sorts与minimum signed difference | RG16 mips960×540、480×270、240×135，合1.3125N；shared672B，3barrier，64→16→4→1有效lane。每source一次difference，已无旧重复source排序 | .848 |
| Analyze | 32400组8×8；11sampled/4storage | receiver+Seed+response；current/previous identity、4邻current identity；最多4point old rawdepth；9response max；motion divergence再读receiver/Seed；confidencefiltered；**12layerfiltered** | analysisRGBA8 4N、current rawdepthR32 4N、confidenceR8 1N、sharpen exposure4B。无shared/barrier；全N own-depth写而非q覆盖 | 1.893 |
| Resolve | 32400组8×8；10sampled、2read storage、2storage textures+weights uniform | 9HDR current/Gaussian+重建、9raw luma thin检测、receiver/Seed/response与motion half边界重复；16RGBA16 fractionalhistory（integer exact1point）、lumaHistory/analysis/box/exposure | colorRGBA16 8N、四帧lumaRGBA16 8N，alpha锁；local statistics、variance/clamp、elliptic rectification、tone blend。无shared/barrier | 2.868 |
| RCAS | O域8×8 | RGB5tap+exposure | sharpenHDR8N，alpha1，无history推进。它复用算法不等于复用historyowner | .289 |

Measure最多logical9N×16=144N Seed字节读描述，邻pixel复用可显著cache；实际内存transaction未知。foreground selection不允许删：FindDepthExtents顺序与strict nearest选择已获用户批准，颜色receiver q只供应motion/expected old z，当前颜色输出仍锚p。rawdepthhistory写Seed(p).w；identity q在q自身raw投影验证，颜色history p按q.motion投影；不能加q−p位置补偿、扩大旧depth资格，不能恢复Geometry/scatter/fullPrepare。

Exposure.015ms不是主目标；在global radiometry fixed exposure5时仍保AMD内部曝光/锁变化公式，donor host明确该用途。Measure1.540ms远超planning .30ms front budget不是“曝光太贵”；包含每pixelsearch/log与16KiB合作结构。late reduction lane少是源码事实，occupancy/吞吐限制仍是假设。

receiver index一次写、Pyramid/Analyze/Resolve至少三次读（divergence加读），固定12–16B/px logical索引流量；它避免各consumer重复9tap选择，具有真实消费者。继续融合不应重新引入多次receiver search。三个consumer重复decode index、Seed/response fetch、output_motion/half quantization，数学可复用；是否值得发布额外产品必须算存取/pass，不能默认重算便宜或storage便宜。

### 5.7 具体重复工作：已修复的sorting，与仍存在的low_change

当前 [native_temporal_amd](../../OEngine/src/shaders/native_temporal_amd.ts):322–377每source执行一次10luma读/两组排序，再合作生成2/4/8尺度。这解决Phase4早期Analyze halo重复source sorting，**不能继续把那个旧16×sorting错误当当前瓶颈**。

但:463–486的shading_change在每full pixel求四个low_change，每low_change三层textureSampleLevel，加max(abs(pair.x×pair.y))和R8 tie量化。总12N filtered层查询和4N量化；原半分辨率ShadingChange producer只在N/4点各三层，.75N查询，然后全N对R8 filtered读取。因此层查询数学执行数当前为旧的16倍，**不是16倍总时间或16倍DRAM**。层texture总2.60MiB可能cache，compiler也可能优化edge/coincidentbase；没有证明这占Analyze全部1.893ms。

WebGPU有R8Unorm storage支持的当前合格capability。重新物化约.25N R8产品会加pass/dependency，却删重复12N→.75N尺度查询与R8量化。其必需quality条件是保持floor半域、ceil mip实际域、jitter/UV clamp、R8 midpoint下舍边界、硬件filtered数值和奇数extent；不要用manual f32 bilinear改confidence。该建议的完整Cost Card在§9。

### 5.8 成熟profile必要数学，与物理适配税

参考核查：AMD FidelityFX SDK1.1.4 revision **c6efa6bf7f2027b3ec94f28578bb5965eabb9e55**，MIT。本地tools/fsr3-port/upstream十个hot headers与固定GitHubraw SHA256逐一相同；host fsr3upscaler.cpp也相同。LICENSE字节hash不同，差异仅CRLF/LF，规范化完整文本相同，MIT notice保留。没构建运行donor，不能提升实际质量/adoption。

| donor函数/执行 | 本地映射 | 算法必要信息 / 平台区别 |
|---|---|---|
| prepare_inputs::FindDepthExtents、DilateMotionVector | Measure nearest_color_receiver、index与consumer history_motion | 前景motion质量合同保留；自身Seed不改；donor depth scatter与dilatedtextures在native删除 |
| luma_pyramid::SpdLoadSourceImage/SpdStore + host reset [-1,1,0,0] | Measure rawluma/log/halfmetric + Exposure | log-average/adaptation/half boundary保留；没有global SPD atomic尾组，变两dispatch/大shared |
| shading_change_pyramid::ComputeMinimumDifference/SpdLoadSourceImage | Pyramid source_difference + two sort_set +2/4/8合作归约 | signed排序/尺度保留；不要求搬SPD框架/wave；当前source once |
| shading_change::ShadingChange + prepare_reactivity::ComputeShadingChange | Analyze low_change/shading_change | 必要低域量与filtered消费保留；**把R8产品inline掉引起重复计算是本地物理选择，不是AMD要求** |
| ComputeDisocclusions / UpdateAccumulation / motion divergence | Analyze expectedprevious-viewz pull、完整confidence | Ksep单侧深度/soft响应保留；rawhistory替代sameframe scatter是本地Adapt，需要动态质量/lifecycle证据，不是donor bitexact |
| sample::Lanczos2、FetchBicubicSamples；reproject::ReprojectHistoryColor | Resolve16point fractionalkernel+integer exact特化 | 默认reference history sin核、4×4与center-range clamp；某donor fp16/LUT/wave/permutation是平台选择，不能无依据替换kernel |
| upsample::ComputeUpsampledColorAndWeight、RectificationBox | Resolve9current/Gaussian、frame96B weights | 1:1静态tap/权重已适配；source有pairedfp16 console路径，本地未获得那种指令执行方式，不默认成本相同 |
| prepare_reactivity::thin feature、luma_instability::ComputeLumaInstabilityFactor、accumulate::RectifyHistory/UpdateLockStatus/Accumulate | Resolve thin9luma、四帧luma、elliptic history、lock、toneblend；RCAS | 仍是完整profile，不能用简单singlehistory TAA成本目标要求这些免费；旧T3已保大部分核心 |

成熟来源回答了质量算法应保哪些信息，未证明其全profile在1650Ti/WebGPU/1:1的成本可达预算。源码能区分：9/16tap、四帧history、clamp属于保留算法；16KiB合作/float量化/copy、consumer重算属于physical Adapt；准确hardware-bound归因仍未知。现有raw没有ALU/texture/shared/DRAM stall计数、integer/fractional分布、有效lane；目前不能回答“百分之多少是算法、多少是WebGPU”。

旧Phase2 native T3 oracle局部正收益是对旧完整FSR chain，在合成输入与少数序列成立；Phase4 Donut、自主模型、shared候选失败各有fixture/quality/候选含义，不否定所有pull架构。已移出生产的算法不在当前热图；禁止重新讨论它们好像生产仍执行。旧V4 receiver aggregation局部pass快、whole未资格，PCF dedup bitexact却失败，也说明局部sample计数不是finalpixel因果证据。

## 6. Memory：capacity、traffic、驻留分开

### 6.1 活跃persistent histories独立重算

N=2,073,600，下表只含identity与color profile histories，排除Seed scratch、HDR/RCAS、FrameGraphtransient、Geometry/VSM/IBL、上传/诊断/driver。

| 双槽产品 | 旧49fc B/pixel | V2 B/pixel | 1080p |
|---|---:|---:|---|
| identity RGBA32Uint pair | 32 | 32 | 63.281MiB，保持完整字段与generation change semantics |
| color RGBA16Float pair | 16 | 16 | 31.641MiB |
| raw luma R16 pair | 4 | 4 | 7.910MiB |
| four-frame luma RGBA16 pair | 16 | 16 | 31.641MiB |
| confidence R8 pair | 2 | 2 | 3.955MiB |
| raw positive-depth R32 pair | 0 | 8 | **新增15.820MiB** |
| frameInfo RGBA32 pair | 32B/frame | 32B/frame | 极小常量 |
| 合计 | **70N+32B** | **78N+32B** | 138.428→154.248MiB |

V2runtime histories46N+32、permanent164B（frame48、weights96、RCAS16、exposure4），allocated=46N+196=95,385,796B。Seed owner identity32N+scratchSeed16N+response4N=52N=107,827,200B（102.832MiB）；其中persistent仅32N，不能把52全叫history。旧Facts identity32N+32；旧FSR1:1 runtime38N+32+permanent177=78,797,009B，resetcandidate overlap另计。

### 6.2 store/clear逻辑下限复核

旧：Native reactive4 + Facts(8motion+4mask+16identity)=28 + Prepare(motion4+depth4+farthest2+luma2)=12 + reconstructedclear4 + classification4/confidence1 + Resolvecolor8/lumahistory8 = **69 B/px**。

新：Native Seed16/response4/identity16=36 + Measure luma2/halfbox.5/receiver4=6.5 + Pyramid1.3125 + Analyze analysis4/rawdepth4/confidence1=9 + Resolvecolor8/lumahistory8=16 = **68.8125 B/px**，另tiles/info/weights微量。减少.1875N=388,800B≈.371MiB/frame。共同HDR/RCAS、旧SPD额外store、old halfmetric等未纳入这个约定的主全域下限；不是完整traffic审计。奇数size用实际ceil尺度，不套.5与1.3125整除公式。

recompute确认oldFacts RG32而非其他RG16源，因此69没有该格式错误；更早文档M1的RG16不能覆盖49fc。rawclearBytes8,335,168→40,768，下降8,294,400=4N，与scatterbufferclear删除吻合。**clear真的删了，主store下限却几乎没变**，因为新增Seed/receiver/depth histories/analysis stores抵消。最多4atomic RMW的真实外存成本还取决于contention/缓存，不包含在69公式里。

完整reads远超过store下限：Measure9Seed、Pyramid10luma、Analyze身份/previous depth/12filtered层、Resolve9HDR+16history+9luma+其它filters；texture缓存可复用，不能把逻辑字节除峰值GB/s得到已证明时间，也不能把69和68.8几乎相等解释为DRAM成本必然相等。带宽与ALU、同步、lane组织需要不同观察。

### 6.3 API peak变化来自什么

APIpeak **1,437,586,709→1,290,497,621B**，减少147,089,088B=**140.275MiB**；各owner在各自整机peak时刻的同时容量可复算。A2/B2 live API=1,358,822,645→1,282,084,773B，仅减少76,737,872B≈73.183MiB；peak-live差78,764,064→8,412,848B。两个peak时刻不对应同一frame角色，不能将owner独立峰值加成时刻峰值。

| peak时刻owner | Before B | After B | 含义 |
|---|---:|---:|---|
| Facts | 66,355,232 | 0 | 32N identity+32退休，已改Seed owner |
| FSR old Native graph | 157,593,664 | 0 | 两个38N+32 sets的重叠，不等于稳定活跃history |
| NativeTemporalV2 | 0 | 95,385,796 | 新runtime histories+permanent |
| Seed | 0 | 107,827,200 | identity pair+20N scratch |
| GPUTextureAllocator | 242,115,280 | 123,642,480 | **减少118,472,800B**，pooled frame products与pending/cache寿命变化 |
| GPUBufferAllocator | 19,747,016 | 0 | 该peak时刻不同池，不能推断全frame无buffer |
| FinalPixelFrameResources | 0 | 3,420,208 | peak两组实际fencedcontainer，最多三组 |
| DiagnosticReadback | 0 | 8,412,848 | 单次capture/coverage读回的peak，不是正常history |
| GPUTimer | 0 | 32,768 | queryresolve物理buffer账 |
| VSM | 80,049,156 | 80,049,076 | −80B，atlas主要仍在 |
| SurfaceV4 | 783,676 | 784,788 | +1112B，活跃bin/准备storage |
| Staging / LocalLightWork | 282,912 / 656 | 282,700 / 640 | −212/−16B |

其余owner相同，包括Geometry banks536,870,912B、metadata134,217,728B、TextureResidency139,810,800B。该表精确解释总delta，不能只指着history列宣称省140MiB。

FrameGraph在同一encoder中按lastuse复用兼容transient，sharedpool pending必须等实际fence后借出，cached约3秒expiry；capacity不等于active流量。三inflight允许三套frame scratch/pool allocation并存，不是三个persistent history pairs；history双角色由orderedqueue保护。resize/replacement candidate、retiring上一域到fence时可能额外double，不得提前撤账。upload/staging峰值、API query/PNG读回另列；审计resource的alive是JS WeakRef活性，alive=true且destroyed=true完全合法，**只看alive不能当泄漏**。

### 6.4 Phase5 retirement与4GB合同

正常Dungeon持续lit/scene/Sun/AA，Seed、lighting pools、VSM和Temporal都有consumer，empty/all-unlit retirement不会删主hotpass；因此不能期待idle release提高该场景帧率。它减少空场景/功能退出/旧域重叠与错误常驻，是实际容量和生命周期修复。Sun OFF的最终条件接线可删除64MiB atlas加tables和shadow图，但本ABBA Sun ON；不对正常启用帧分摊禁用收益。

NVML约2.19GiB After vs2.29GiB Before是device/process/OS观测的一部分，与API1.29GB不是同范围。driver tiledcompression、临时shader资源、Chrome/canvas、其它进程/OS驻留、paging均不等于APIformatbytes。缺少长窗口复杂动态、三inflight/resize/mip churn、device loss/replacement同时峰与OS eviction证据，**4GB驻留合同未资格**。容量降低不证明bandwidth降低或P50改善。

### 6.5 身份不作为本次缩减项目

RGBA32Uint并非“128bit无碰撞exactID”：目前有exact slot/外部generation与几何/材质change signatures，后者本来是change detector，有collision风险。正确性合同要求不丢现有完整identity/generation或把它换单lossy hash。该诊断不改其布局。

若未来另立缩减单元，必须证明pixel所属incarnation→owner snapshot在所有有效history/inflight窗口可查；slot回收/replacement不覆盖previous lookup；exact lifetime token不可复用直到所有histories和fences失效；耗尽/scene重置有明确处理；current/previous transforms、material revision与identity同时submit，abort保旧角色、retry不误推进，device loss清整个epoch。仅owner current/previous revision不能补回pixel丢失的历史owner归属。没有该证明不把8B identity节省计为收益，且不因signature原有碰撞而放宽质量合同。

## 7. 根因清单：事实、置信度、反证与最小辨别实验

置信度针对每行陈述，不能把源码机制的高置信度自动提升为毫秒归因。

| ID / 分类 | 源码位置与证据 | 测量支持 / 置信度 | 反证或限制 | 最小辨别实验（本轮未运行） |
|---|---|---|---|---|
| R1 cost model失配 | old49fc vsm_shadow_resolve::shadow_receiver、native_surface_aux::native_facts_previous_clip/main；current native_surface:640–688 | 删除完整pass是真的；删除“第三完整Surface”不成立，高。A2/B2合并Native+S3+Facts几乎相同只是描述事实 | S3fallback多的动态场景可能更有DELETE收益；本raw无逐framefastpath占比 | 固定同一Visibility/work/geometry，用完整old S3+Native+Facts闭包与current Native消费相同inputs；记录fallback/有效pixel，同数值和envelope |
| R2 实现/physical candidate税 | [native_temporal_amd](../../OEngine/src/shaders/native_temporal_amd.ts):463–486 inline low_change | 12N vs .75N层filtered查询高；B2Analyze1.893ms，仅能给整个桶上界 | 尺度cache/coincidentqueries/编译CSE可使重复成本低；不是16×shader时间 | test-only完整half-R8 producer→Analyze候选，保实际R8 filtered与奇数/jitter边界，先数值/质量，后短paired同scene同温整链计时 |
| R3 physical organization风险 | native_temporal_amd:153–218、233–260；[NativeTemporalV2](../../OEngine/src/render/temporal/NativeTemporalV2.ts) layouts/dispatch | Measure1.540ms、frontsum4.311ms；16KiB/13barriers源码高，shared/occupancy因果中低 | 9Seedsearch/log/half量化也可能主导；Exposure只有.015ms反证“全局exposure是大瓶颈” | 相同算法输出和round边界的完整Measure/Exposure执行组织候选；记录shared/register/实际lane，保持全N和64tile数学，不仅measure synthetic常量HDR |
| R4 保留算法profile成本 | native_temporal_amd Resolve、AMD sample/reproject/upsample/accumulate；old native_temporal同类核 | 16fractional/9current/9thin/fourluma/rectification源码高；Resolve B2 P50 2.868ms，算法成本存在高 | fraction/lock/disocclusion分布未知；整数特化已做，不能再宣称整帧都16tap | 捕获真实Dungeon HDR/Seed/history/frameinfo/weights，按8jitter相位记录fractional/initial分布，回放同profile完整GPU链；不用降tap作候选 |
| R5 Native执行域风险 | native_surface:643–688、native_surface_lighting:45–59、[FinalPixelAbi](../../OEngine/src/gpu/FinalPixelAbi.ts)、VSM exact point sampling | 原PCF/motion移入Native高；perpixel lookup/manualSolar/latecarry新增高；占多少Native时间未知，occupancy低 | priorSun scope返工已减live；cache良好/编译优化可消税；A2合并桶不呈显著增加 | 捕获实际每bin完整WGSL/descriptor/像素mask；保持相同完整产品的Sun/Seed/IBL bounded诊断；Nsight可行则register/spill/texture/shared计数，无计数只作时间假设 |
| R6 测量资格缺陷 | [GPUFrameTiming](../../OEngine/src/framegraph/GPUFrameTiming.ts):141–181/231–241、FrameProfiler:711；example main:787 | target60、26markers、mod8仅0/4、thermalActive、dirtyAfter均raw高 | 没证明alias/thermal解释全部回退；timestamp完整无overlap反证“全数据坏了” | finalHEAD freshfingerprint，interval1或coprime8、actualjitter/roles、全target与stable分别报告、same workload/thermal/power合格的短paired观察 |
| R7 容量收益被当运行成本 | [NativeTemporalV2](../../OEngine/src/render/temporal/NativeTemporalV2.ts):333–374、NativeTemporalSeed allocations、[GPUTextureAllocator](../../OEngine/src/gpu/GPUTextureAllocator.ts)、ResourceAccounting | histories+8N、store仅−.1875N、APIpeak−140.27MiB高 | API峰值确实改善；若oldpaging才可有FPS收益，本raw没paging证据 | 按frame记录active/candidate/retiring/pendingpool/upload/OSdedicatedshared；可先离线对应peak时刻，无需先跑长驻留benchmark |
| R8 整帧残留预算 | frameprogram lowering主/shadow Geometry、Aerial、bins；关键geometryhash A=B | 主Geometry/Visibility/HZB未变，B2前段P50 2.258ms；扣全Temporal后WholeP50 17.768ms，高 | 零成本反事实非实际可执行图；冷/非thermal条件可能不同；主/影Geometry混桶容易重复计 | exactsameframe互斥sum与whole预算，保持固定Geometry功能与scene，不以缩场景或关Sun/AO冒称同等whole |

这些没有发现一个已证明造成Whole回退的production数值/生命周期错误；发现了**具体成本模型错估、候选执行税和测量缺项**。个别实现重算不是数值bug，不应以“correctness过了”忽略。B1 P99≈122.7ms是真实有限窗口尾成本，sensor太稀且多pass同时延迟；没有证据指向某个特定shader或VRAM eviction。

## 8. 架构判断与 A/B/C 比较

### 8.1 三种完整结构

| 结构 | 真实工作 / 主要税 | 当前证据结论 |
|---|---|---|
| A 当前fused Sun+Seed+V2 | Native一次completion/material，完整PCF/IBL/motion；输出44B含HDR；V2前段/Resolve完整；52NSeed+46Nruntime | **性能候选应返工，不能继续当已成功方案。** correctness与单路径ownership有价值；net未资格。没有fused必快定理 |
| B 旧49fc全链 | S3 depthfastpath/fallback+PCF+1Bmask→Native→Facts28→ratio/Prepare/clear/scatter/LumaSPD/ShadingSPD/ShadingChange/T3classify/Resolve/RCAS | 正式对照必须用完整图，而非只用旧Native4.93ms。raw A1/A2整帧漂移大；B不是已测稳定60FPS“优胜基线”，也不恢复旧owner |
| C 有限Native/Sun lighting packet（仅分析） | native物料/local/IBL/Seed生产有限packet，单Sun/PCF消费者写finalHDR；shadow管理保持 | 有物理解释但代价高，无register/时间证据支持优先；不用局部失败否定所有拆分，也不为保护fusion拒绝分析 |

应该保留的结构：GPU唯一frame submit、完整容量/overflow/generation、Geometry frontend、compile-native material、coverage与radiance图分离、logical VSM owner与complete publication、own-pixel Seed + foreground color receiver、rawprevious-depthpull、同submit history/camera/identity共同推进及fence retirement、真upscale单独必要图。这些保留不宣称性能成功。

不应无条件保护的physical decisions：所有lit material/Sun/PCF/Seed必须同一private执行域；low_change不物化；16KiB Measure必须沿source式64×64组织；为了pass少而承受反复采样。这些应由完整Cost Card与quality/cost证据裁决。V2完整AMD质量profile保持为输入合同；若在目标GPU完整物理适配后仍不赚钱，必须向用户修订目标profile/authority，不擅自减footprint。

### 8.2 有限packet的明确Cost Card（不推荐本轮实现）

考虑单一Physical Sun消费者所需的有限packet，使用5×vec4f=**80B/pixel** storage buffer：position.xyz+exactflags bitcast lane（16）；geometric biasnormal.xyz+valid lane（16）；local RGB含emissive（16）；environment RGB（16）；unshadowed Physical Sun RGB（16）。不存normalmap/material字段、通用roughness/closure、identity/history/proof；Seed仍由Native原writer发布。packet不是Universal SurfaceRecord/GBuffer，不用于其它effects。

producer：当前Native geometry/material/local/IBL，提前算Solar与unshadowedSun；consumer：一个full-I 8×8 PCF/Sun合成pass，(local+visibility×Sun)+environment后按原位置做色域/曝光、写RGBA16F HDR；background/invalid所有packet项完整写。一个producer/一个consumer，增加一依赖与一个pass，不按material实例生成pass，不重建geometry。position/bias/flags用f32/u32完整值，颜色不先降f16。

DELETE：PCF跨material/IBL私有域的live overlap；Native输入侧descriptor/atlas绑定可搬至consumer；producer原HDR8N store替换。**不删除PCF taps、VSMreceiver重建、material/IBL/Seed或其history，也不保证减寄存器spill。**

ADD：packet80Nwrite+80Nread=**新增160N=331,776,000B=316.406MiB/frame**逻辑顺序产品交通。consumer的finalHDR8N store替代原NativeHDR8N store，二者相抵，不能再从packet税扣8N。单packet容量158.203MiB，三inflight最坏474.609MiB（实际frame reuse/fence另算）；必须在创建前协商buffer/binding尺寸，不能漏pixel适配限额。consumer多1storageinput、HDRstorageoutput、VSM/Solar等有限binding/private receiver，1dispatch，noatomics/sharedbarrier，但有GPU dependency。producer提前Sun计算失去exactshadow0 skip，**shadowed区域额外Solar/BRDF税**；数学线性重排/finite guard/舍入变化必须独立oracle与动态质量验证，不能宣称天然bitexact。

理想：有效释放material↔PCF重叠造成的stall/spill/低利用率；上限未知且严格小于把Native11.034ms全部删除的虚构上限，因为主体工作仍在。预计ms=未知（没有hardware counters或完整候选）；最坏新带宽+pass+shadowed extraALU没有任何occupancy收益，4GB余量更差。以D=实际删private overlap stall时间、A=packet/pass/extraSun税：0/50/100%兑现净变化分别 **−A、0.5D−A、D−A**；break-even D>A且同质量/不退尾。观测反证：实际Shader无spill/高occupancy，或matched完整packet图不降whole/envelope，即拒绝该packet；不因此宣布fusion整个理论无解。若该物理拆分获证需要修改V5“fused正常路径”的authority；本轮不改authority。

更小“只visibility packet”的1/4B方案要求第二producer独立恢复receiver，重新引入完整oldS3式成本；不是零税版本。要比较就比较两套完整producer/consumer成本，不能同时假设zero recovery、zeropackettraffic和zeroprivatecarry。raw未支持采用它。

### 8.3 分类裁决与authority

- **实现错误**：需要实际数值、coverage、binding/生命周期失败。本轮没有找到证明Whole退化的此类错误；AA bypass仍写Seed是需求/实现性能税，应单列而非擅自删除合同。
- **fixture/测量错误或缺陷**：dirtyB非final、stable与target混用、nestedqueries相加、jitteralias、thermal漂移；不能洗掉真实大成本。
- **性能candidate不合格**：Phase2/3/4/5没有net资格，V2当前物理候选值得重做；shared/Donut等历史失败只裁对应候选。
- **cost model被源码事实推翻**：三次完整恢复、history缩减、大store收益的解释不成立；应修订DELETE范围与expected未知。
- **完整架构被正式证伪**：还缺final exact-build、同条件samework、完整质量/lifecycle、足够窗口的whole/envelope和有界替代候选；现在不能声称已正式证伪“Native fusion + pull”。但“不曾证伪”不是继续无限投入的理由。

若接受本报告返工建议，authority需修订V2物理图/lowchange产品允许、Measure/Pyramid/Analyze完整预算与source-basedCostCard，撤回任何隐含net成功解释；不更改Phase状态作既成优化、不另造重复status文。V5预算15.50ms+1.17headroom是规划，不是实测；Temporal规划Measure/Exposure.30+Pyramid/Analyze.40+Resolve.85+Sharpen.25=1.80ms，对比真实7.519ms，**预算没有被当前source/cost证据支持**。Native7.45ms规划也未达该窗口11.034ms。需要从whole重新分配，不能让每个模块各许愿而总量超16.67。

## 9. 唯一推荐的下一完整返工单元

### 9.1 单元边界、依赖与质量合同

**Native Temporal 1:1 observation/product/consumer 的完整物理执行返工**：从Native已提交Seed/finalHDR输入开始，包含Measure、Exposure、Shading Pyramid、low-domain change、Analyze、Resolve/RCAS消费者、所有history角色/容量/绑定/reset/abort/retry/retirement。优先把参考低域观测只生产一次，再让full-I consumers读必要产品；重审Measure合作方式，保同一算法和格式边界。不是对textureLoad/helper/bindgroup逐项补丁，也不是让Surface重新成为Temporalhistory owner。

具体第一个可审查物理图候选是保持Measure/Exposure/sourcePyramid数学，发布独立半域R8Unorm shading-change，然后Analyze读取一次filteredchange；完整接通Resolve consumer。它增加pass却减少实质计算，因此不以“少pass”为目标。Measure执行重排必须基于同reference数学/现working set独立计账，通过完整单元候选验证；本报告不预先许诺一个未经cost验证的megakernel，也不为.015ms Exposure上全设备同步技巧。

依赖：Seed own motion/depth/identity不变；3×3 receiver order/strict nearest不变；物理Solar/Sun与Geometryfrontend固定；Temporal内部曝光、exposureframeInfo reset、R16/RG16/R8舍入、Lanczos/Gaussian核、thin lock、四帧luma/rectification/tone blend/RCAS参数均保持。outputp与receiverq各自投影不变；rawdepth全N/sky0，hardreplacement与完整identity不变；copy/history roles只在成功submit推进，abort保旧角色、resize候选/旧epoch到fence，device loss归零。trueupscale不借Native候选fallback；AA bypass消输入税若未来要做另需需求批准，不混进本单元性能收益。

### 9.2 可核算 Cost Card

设half domain H=floor(W/2)×floor(H/2)，本1080p H=N/4=518,400。

| 维度 | DELETE | ADD / 必须保留 |
|---|---|---|
| 算法重复执行 | fullN×4低点×3尺度=12N层filteredcalls与4N lowpoint量化/max算术 | 在H每点3尺度=.75N calls，H量化；Analyze N次R8filteredread。**净少11.25N=23,328,000层filteredcalls/frame**，不表示23M DRAM misses |
| 产品字节 | 不删除现有receiver/Pyramid/Seed/analysis/depth/color histories | 新R8半域 Hbytes=518,400B=.494MiB容量与store/frame；硬件bilinear每fullpixel一个R8查询，最多4scalartexels/footprint，缓存另计 |
| 输入traffic模型 | 原12N filtered RG16层查询 | 新.75N filtered RG16层+N filtered R8查询。以每call只计一个format值是48N→3N+N；以4texel上界是192N→12N+4N；两种都是logical描述，不是实测DRAM；还加.25Nstore |
| ALU | 删除重复low_change jitter/clamp/max/byte量化 | halfproducer同数学一次，Analyze sampler/clamp；准确GPUinstruction/吞吐未知 |
| bindings/工作集 | Analyze不再直接需要3尺度纹理，最多少3sampled再加1sampled，private lowpoint函数退域 | 新producer3sampled+1storage+frameuniform，8×8，无新增shared/private大数组；绑定/limits与formats创建前协商 |
| passes/barriers | 不承诺删必需global Exposure边；不删Pyramid source排序 | +1dispatch、Pyramid→lowchange→Analyzedependency；不增加atomics/clear/devicewidecounter。quarter域半率时尾组按实际extent |
| lifetime | 不删活跃78Nprofile、只退无consumer的原bindings/products | Htransient，3inflight最多约1.483MiB新physical重叠，可能alias但不预先计免费；candidate/retiring仍全账 |
| 质量 | 不删foreground/depth/identity/historytap | donor UV、floor half vs ceil mip、R8 tie、硬件filter、曝光/jitter/oddsize完整独立数值及真实动态质量 |

理想收益上限：仅low_change重算部分不可能超过已测Analyze1.893ms，因为其它identity/depth/reactivity/confidence也必须保留；**1.893是不可达到的归零上界，不是预测**。整个观测前段的零成本counterfactual上界4.311ms，也有大量必要工作。预计净ms区间 **未知**，可取负；需要测新增pass/Hstorage/sampling与减少的real执行。最坏是layercache已充分命中/编译器复用使DELETE时间≈0，ADD仍存在导致回退；退成两个生产paths不允许。

以D=当前12N冗余lowdomain消费中可删除的实际时间（包括重复ALU/texturework）、A=halfproducer+.25Nwrite+N R8filtered+pass/dependency的时间，保留所有其它工作：

| 删除成本兑现 | 仍付ADD | 净节省时间 | 从旧12N layer query看候选总量 |
|---|---|---|---|
| 0% | A | −A | 12.75N（无效候选，立即拒绝） |
| 50% | A | .5D−A | 6.75N |
| 100% | A | D−A | .75N；另N R8query |

break-even是**D>A**，并且整链/whole matched对照降成本、质量与尾部不退；sample数量减少不是结论。Measure再组织的D/A另算shared/barriers、9Seedsearch、log math和新增products，不能把它的上限与lowchange1.893ms直接相加当forecast。保留算法profile如果无法达到整体预算，本单元不是无限迭代许可。

### 9.3 从整帧预算出发

现有完整target P50 gaps：A1+2.288、B1+5.654、B2+8.872、A2+8.984ms；这些是各热条件描述，不是finalHEAD正式缺口估计。B2 P95还比16.67高11.054ms，P99比16.67高11.210ms；若使用authority P99≤20ms边界，则gap7.880ms。不能把P50规划解决等同尾延迟资格。

B2去掉**全部**Temporal仍17.768ms，所以本次rework即使成功，仍要重新定位Native/Sun等余量；只能停在本完整单元边界给用户决策。若只把Analyze全部免费，wholeP50仍23.457ms；Measure/Pyramid/Analyze优化不是60FPS承诺。不能通过关闭Sun/缩renderScale/修改Geometry/SSE、减material/taps/禁用receiver、减少最终场景证明同质量达标。

继续投入依据：R2有明确source重复量、真实大Analyze/front桶和小H产品税，具有可核算、可反证路径；比当前未证occupancy的80Bpacket更可控。要投资的是验证这一次有界完整候选，而非先确信会省若干毫秒。

### 9.4 最小验证与停止条件

下一轮建议的最小辨别实验（**本轮仅提出，没有运行**）：

1. **先补exact-build观测身份**：固定finalHEAD构建与bundle/source/fullshaderfingerprints，short target全窗口、interval1或coprime8并记录actualcommitted jitter/role、frame工作量；冷/热条件分组、固定power/风扇/后台，热状态不合格则不做因果差值。保全raw长尾与目标scene/quality。stage/full扰动与normal生产运行跨度分开，不能频率归一化代替同条件。
2. **冻结真实输入离线回放完整单元**：捕获Dungeon HDR、Seed/response/identity、previous color/depth/luma/confidence/frameInfo、exposure/weights，覆盖8相、fractionalmotion、遮挡/薄叶/材质变化；比较当前完整V2与test-only候选graph，不仅analytic constanttexture。capture读回只用于离线fixture，不进入sameframe生产控制。
3. **producer→全部consumer oracle与lifecycle**：R8tie/filter、odd/tiny/4096限额、receiver轮廓/dolly/rotating/rigid/sky、MASK/normal/HDR、reset/cut、same-slotgeneration/materialreplacement、submit/abort/retry/resize/device-loss/三inflight/唯一writer。沿当前独立质量门与旧失败，不放宽容差；candidate只有完整quality后才能短GPU成本判断。
4. **短serial GPU matched成对成本**：先分析/比较整个Measure→RCAS和whole、互斥envelope，不单独统计lowproducer胜负。至少覆盖全部8jitterphase与工作量同条件；不以本轮60samples作为正式qualification，不先跑长bench自动推进Phase6。若有可用hardware counters，记录texture/ALU/shared/register/spill来区别R2/R3/R4，否则诚实保未知。

停止/改方向：数学/quality/lifecycle必需失败→候选不切生产，保存原失败；完整quality通过但matched整链或whole无正净收益/尾部回退→拒绝该物理候选，不在hotpath补cache/history/proof。若lowchange真实DELETE已兑现且Measure适配税受控，Temporal仍主要被必要16tap/9tap/fourluma profile支配、预算无法接近，则停止该方向，向用户提出算法profile/目标authority是否重订；本轮不自创新Temporal。若native完整binding/机器码+同条件隔离证实fusion造成private stall/spill，才把下一单元转为完整Native Sun/Seed物理结构；没有这证据不自动上packet。任何正式qualification必须是最终生产exact-build、全Renderer动态质量与足够窗口的P50/P95/P99/驻留，不拿synthetic收益晋级。

## 10. 验证状态、结论边界与最终回答

### 10.1 本轮已核验

- git HEAD/workspace/近期提交/authority，开始无未提交production变更；结束537个生产.ts/.wgsl逐文件SHA256复核，无修改、新增或删除。
- 当前实际import链与完整代表WGSL展开；old49fc S3/native/Facts/T3真正执行源、owner→physicalpass区别、当前旧S3/Facts/native scatter/T3生产退休，trueupscale必要scatter仍在。
- 四轮raw60完整target、分位数复算、互斥sameframesum、passcontainment/无overlap/无truncation、stable窗口不同、querymarker/readback税、热与settings/residency snapshot、finalHEAD fingerprint差异。
- 活跃history70→78、store69→68.8125、clear4N删除、APIpeak各owner变化、capacity/traffic/driver驻留范围分开。
- AMD固定十hotheaders+host revision核对与MITlicense文本，主要函数映射/平台Adapt；未将来源核对提升adoption。
- 已有test-dist source/outputhash freshness可核验，不需要为本报告重新build生产。新报告及链接已检查；docs-verify：0 findings、66 historical warnings、186 documents；git diff --check通过。raw复算脚本重跑通过。本轮git status仅用户原有.vscode/与新报告，HEAD保持1c41fb77。

### 10.2 未验证 / 缺失

最终HEAD exact-build whole同条件GPU成本；每bin实际Dungeon完整WGSL/机器码/descriptor与材质占屏；register/spill/occupancy、DRAM/cache/stalls/有效lane；每framejitterroles、PCF压缩/fallback/dirty/receiver重建计数；动态全Renderer长窗口/P95/P99/4GB驻留资格；新候选数值/质量/生命周期/真实GPU成本。原Phase4/5correctness记录有其范围，本轮没有重新运行GPU质量，不当作新的证明。未重新typecheck/shadercompile/build，因为没有production改动且本轮目标是分析，不伪称它们通过。

### 10.3 现有证据不能推出

不能推出优化成功或finalHEAD已正式回退；不能推出所有差异只是温度、没有性能问题；不能推出fusion必快/必慢、完整pull/AMD架构被正式证伪；不能推出Native上涨全是新增工作或VSM下降全是节省；不能推出140MiB是persistent节省/idle带来DungeonFPS/4GB已达；不能推出scatter删除使总traffic大幅少；不能推出R2采样16×等于16×shader慢或省1.9ms；不能推出synthetic局部正收益可满足16.67ms。

### 10.4 为什么投入大，却没有拿到可靠整帧收益

**重构删除了边界和部分恢复，但没有删除最昂贵的每像素数学；有些预期删除量被旧源码高估，有些只是从旧桶搬进Native，有些被Seed输出、previous-depth/receiver产品、manualSolar/descriptor和Temporal执行重复抵消。** Material/IBL/PCF、9/16tap完整Temporalprofile、Geometry/Sky/Aerial仍在；history更多、主store近乎不变。Phase5释放主要改善无consumer与候选/退休容量，正常lit Dungeon不退出这些owner，不能转换成正常帧shader收益。

同时，重构按正确性/结构阶段推进了production，但净性能资格始终未闭合；dirtyAfter、60samephase样本与严重thermal漂移使最后联合ABBA不能回答finalHEAD同条件净差。测量限制只阻止净收益/因果比例声明，**不抹掉25ms整帧、11ms Native、7.5ms Temporal的实际成本观察**。“更干净/少pass/可扩展”不能填16.67ms的预算缺口。

**继续的依据是一个可证明实际重复量、有完整DELETE/ADD、能被短matched实验推翻的Temporal物理单元候选。** 如果质量合同保住而完整候选仍不降whole/尾部，或收益上限不足且必要profile成本支配，应停止该方向、重订authority/目标或在新证据指向Native执行域后改方向；不能以“尚未正式证伪”继续无条件投入。

本轮到此 **STOP**。等待用户决定是否批准上述唯一完整返工单元或先执行最小辨别实验；不修改生产、不自动实现、不提交、不进入Phase6。
