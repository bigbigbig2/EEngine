---
id: eengine-v4-native-shading-execution-2026-10
state: current
verifies:
  files:
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - docs/next-design/eengine-v4-native-shading-2026-10.md
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program/FrameProgram.ts
    - OEngine/src/render/program/FrameProgramBindings.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/gpu/GpuRenderWorld.ts
    - OEngine/src/gpu/GpuAppearancePublication.ts
    - OEngine/src/gpu/AppearanceProgramRegistry.ts
    - OEngine/src/material/AppearanceGraphCompiler.ts
    - OEngine/src/material/ExactAppearanceDag.ts
    - OEngine/src/shaders/appearance_program.ts
    - OEngine/src/render/CoverageRasterBindings.ts
    - OEngine/src/render/passes/PackedVisibilityPass.ts
    - OEngine/src/render/FrameGeometryArena.ts
    - OEngine/src/render/passes/LightClusterPass.ts
    - OEngine/src/render/vsm/VsmAtlasRasterPass.ts
    - OEngine/src/render/surface/SurfaceWorkRuntime.ts
    - OEngine/src/render/surface/SurfaceFrameResources.ts
    - OEngine/src/gpu/GpuSurfaceWorkAbi.ts
    - OEngine/src/render/temporal/TemporalFactsPass.ts
    - OEngine/src/render/passes/fsr3/Fsr3UpscalerRuntime.ts
    - OEngine/src/framegraph/FrameGraph.ts
    - OEngine/src/framegraph/ShadeGPUCommandContext.ts
    - OEngine/tests
    - tools/docs-verify.mjs
    - tools/project-navigation.mjs
---

# EEngine V4 执行计划：先完成 Surface Native Opaque

唯一架构依据为[V4 母稿](../next-design/eengine-v4-native-shading-2026-10.md)。本文是唯一 **current renderer execution authority**；[workstream.currentSlice](../../project/workstreams/active/eengine-next-clean-rebuild.yaml)导航到当前大模块。旧 R3/R4 执行记录保留为 history，不继续推进 Surface C，也不把旧 A0→F 阶段映射成 V4 已完成单元。

本次仅完成文档 authority 切换/工程规划；源码审查起点为 fetch 后的 `b69a0a60b13930212fdc98f988443186fad024e4`。无 V4 production 实现、native probe、GPU calibration、画质/性能新结果。每次实施重新核对源码与工作区，不将该 SHA 当永久最新。

## 1. 如何继续与如何关闭单元

### 1.1 Agent 入口与停止边界

收到“继续当前 V4 workstream”后：

1. 读 `eengine-next-clean-rebuild` 的 authority、currentSlice，再读本文单元表，选择第一个未完成单元。context 也可能显示既有资产专项 workstream；它们不是第二套 renderer authority，也不能据此自动启动 V4 的后续模块。currentSlice仅记录大模块；本文是详细单元状态的唯一位置，不另建progress/status/roadmap文档。
2. 核对HEAD/工作区；用 `node tools/vibe.mjs context <path>`导航，读该单元producer、产品、全部直接consumers及近目录规则。该命令不是编码许可或验证门禁。
3. 固定切换范围、存活语义、source map、资源/容量/失败行为和Cost Card；连续完成该单元的producer→产品→consumer，binding/reset/abort/retire一同接齐。复杂算法开工前补全固定donor源码、论文/技术文与本地映射，不因计划存在而宣称完成来源核读。
4. 链闭合后先 architecture review，再集中验证；保存原失败、根因分类、修复及受影响回归。通过源码/接线、正确性与实际成本检查后关闭单元，缺项就保持未完成。
5. 在本文对应单元“实施记录”更新源码身份、实际交付、验证范围/结果、未运行项与未关闭问题；仅在大模块/入口变化时同步currentSlice。停在下一个单元边界，后续“继续”才启动下一单元。
6. **M1 Surface V4完成后暂停。** 依据那时真实代码重新设计下一大模块，经用户选择后才启动；不能按粗粒度表自动一路实现到VT/ReSTIR/GI。

阶段内允许暂时编译失败/无图，单元末必须修复真实编译失败并闭合所声明的实际产品。S4.0/1是隔离probe与backend交付，production仍只有旧路线；S4.2切换唯一opaque生产入口后旧Surface不得被调用，S4.5清除剩余死文件/资源/测试依赖。保留Git历史即可，不建OldSurfaceAdapter、LegacyBridge、CompatSurface、FallbackVM或双路A/B production。

### 1.2 实施和验证节奏

| 时点 | 应做的验证 | 不做的循环 |
|---|---|---|
| 连续开发 | 必要typecheck、WGSL compile、极小targeted CPU/oracle；定位基础错误 | 每函数修改跑全suite/browser/perf、按每次数字改变架构 |
| 单元完整闭合 | architecture review→集中typecheck/build、新鲜build:test、相关CPU语义/生命周期、真实GPU producer→consumer/oracle与该单元Cost Card实测；GPU作业串行 | 为过旧ABI测试恢复owner，拼不同源码快照的绿色结果 |
| M1退出 | Surface范围场景/材质/route、resize/cut/abort/recovery、需求/格式、质量、工作量/VRAM/完整scope计时和CPU encode矩阵 | 以出图/预算未超/零API错误代替数值或成本 |
| 全Renderer/providers最终集成 | 全browser/设备/效果矩阵、长时quality、同条件P50/P95/整帧预算、正式evidence/claims | 本轮文档或单元组件结果提前晋级整体验收 |

单元GPU检查用于验证刚闭合的算法/链和成本，不是每patch benchmark。完整browser/performance矩阵在该范围闭合后集中执行；正式跨旧版speedup和整个Renderer验收留最终集成。数字慢先解释necessary work、spill/locality/limits/图边界，必要工作超预算时明确调整quality、lighting budget、render scale或算法；不隐藏shortcut。主提案普通6–9ms、复杂9–15ms、多灯11–18ms是planning targets，不能硬编码为测试门槛。

<a id="validation-failure-contract"></a>

### 1.3 测试可信度与失败修复

失败先保存原始输入/输出/source/build身份，再分类：implementation bug、architecture bug、old test tied to retired ABI、fixture bug、lifecycle bug、numerical bug、environment/tooling。最小复现与独立预期核对后修根因，复跑原例和相关回归；无法解释则保持未通过，不把偶然绿色复跑追认修复。

调用当前生产入口或实际generated WGSL，证明目标branch执行、非零有效Lighting/VSM/IBL provider、真实HDR/Aux消费。mock只验局部协议，源码regex/预填正确值/归档shader不证明算法；结构guard可证明旧依赖删除，但不能替代GPU correctness。程序容量/route tails/overflow不得靠漏像素通过；每visible pixel唯一opaqueHDR writer，background单独完整写域。

旧Tape opcode/slot packing、six-signal store、cache generation/nomination、旧Surface field/recipe ABI退休时删或迁移形状测试。material numeric、C/X/Y/texture LOD、normal、HDR/pre-exposure、coverage、update/abort/retry、device loss、motion、unique writer、fence退休等有效语义必须映射新owner并有独立预期。禁止吞异常、skip必需断言、永久fine/miss、关feature/缩最终场景、放宽容差或production测试fallback。预期变更说明数学/来源/新合同；实际quality/功能范围变化须按用户授权处理，不由测试颜色裁决架构。

最终源码变动刷新受影响build/checks；timeout、不完整runner、不可用timestamps、skip/未运行单列。correctness、成本、范围三个结论分别记录。生命周期只测本单元涉及的真实事务/资源，不推迟已知新owner缺陷到最终验收。

### 1.4 防止架构漂移

以下六种反应不允许：测试失败就加兼容path/fallback/adapter；性能慢就立即加cache/proof/reuse/history；dispatch多就立即造megakernel/VM；跨pass consumer出现就扩Universal SurfaceRecord；新算法需要history就交Surface统一管理；单元尚未闭合就持续benchmark并逐次改架构。

先证明问题和成本，再做有界决策；没有真实consumer不声明output、不创建resource。原owner替换随直接consumers前移，退休owner删除，不为历史测试恢复生产链。

## 2. 粗粒度后续模块（不是自动执行路线）

| 模块 | 目标 / 依赖 | 主要producer→产品→consumer与排序理由 |
|---|---|---|
| M1 Surface V4 | native material/backend/publication、唯一native opaque、两种work组织、demandedAux与旧Surface退休 | Visibility/publication/providers→nativeHDR/Aux→既有Temporal/effects；先消除核心执行税 |
| M2 Geometry / VG alignment | 依M1实际winner/requirements；校准LOD/SSE/HZB/meshlets/streaming边界 | Scene/VG→resident/prepared geometry+MeshletWork→Visibility/Surface/VSM；在真实gather需求清楚后调整 |
| M3 Virtual Resources / VT | 依M1sample接口/M2streaming事实 | resourceowner→page table/atlas/feedback→native sampler；避免在M1假定bindless/完整VT |
| M4 Lighting / VSM | 依M1 native consumer；M2caster/geometry、M3资源边界可并入实际依赖 | lightcluster/VSM/IBL→lighting providers→HDR；已有实现先保留消费，再设计极端规模/质量 |
| M5 GI / Reflection / ReSTIR | 依前述geometry、lighting与真实demandedAux | effectowners→indirect/reflection/reservoir/composition→HDR；先有输入/能量边界，才选择完整算法 |
| M6 Temporal / Upscaling / Presentation | 依前述真实radiometry/motion/reactive及effecthistory | HDR/facts/exposure→Temporal/FSR/DRS/可选AI→Post/Present；M1先保证现有consumer正确，不等待本模块 |
| M7 Transparency / Media / final integration | 依opaque、lighting、Temporal真实边界 | transparent/media work→HDR/reactive/motion→reconstruction/presentation；完整排序/交互后全Renderer验收 |

只M1有详细单元；M2–M7顺序可因实际资源/consumer依赖调整。表格不宣称原Geometry/VSM/FSR等尚未实现，也不替代那些模块未来的完整算法设计。

## 3. M1 Surface V4 当前单元

| 单元 | 完整切换责任 | 状态 / 实施记录 |
|---|---|---|
| S4.0 | Cost + native viability（隔离probe） | **next / 未开始**：当前应从这里开始；尚无calibration/native实测 |
| S4.1 | Native material backend + publication | 未开始；依S4.0结论 |
| S4.2 | One-route native opaque production cutover | 未开始；依S4.1完整backend/publication |
| S4.3 | Multi-route CompactPixelBins | 未开始；依S4.2正确/成本核对 |
| S4.4 | Minimal SurfaceAux + Temporal direct consumers | 未开始；依S4.2最小输出与S4.3完整writer域 |
| S4.5 | Old Surface retirement + M1验收 | 未开始；依新链及全部direct consumers闭合 |

当前为Surface V4 active大模块，单元状态只在本表及对应实施记录更新。未关闭S4.0时不能直接建binning；任何延期的必需项必须具名记录，不能改称optional过关。

### 3.1 S4.0 — Cost + Native viability

**问题与范围。** 在没有VM/ClosureCache/signalstore/binning的情况下，native opaque必要work本身是否匹配物理模型？只建小型离线/isolated architecture probe，不进入Renderer owner选择、不接第二production、不建立通用bench runtime。production源码只在后来实施必要helper拆分时改变，本次规划不实施。

**读取与复用。** `PackedVisibilityPass/GpuVisibilityKeyAbi`和真实FrameGeometryArena产品；`surface_geometry_completion`/bary/gradient/normal数学；`StandardAppearanceGraph/AppearanceGraphCompiler/appearance_program`；`lighting_direct`、`surface_work_lighting_math`、`environment_brdf`、`environment_ibl`及cluster/VSM helpers中的BRDF/Lighting数学；`SurfacePhaseTiming/GpuTimingCost`。先剥离旧wrapper依赖，不能把旧heap/packet/Tape作为probe输入中介，不能整体复用含旧field/signal读写的Lighting生成器。未能跑真实winner/资源profile时标明输入限制，不能靠预填closure证明production可行。

**交付闭包。** 固定相同graph/geometry/textures/灯/阴影质量，至少geometry reconstruction、Standard PBR、normal/ORM、4/8clustered lights、IBL、有效VSMquery、pre-exposed HDR，另有Unlit/coat/custom的编译可行性样例。compare native fused与明确24B等compact split，实际数值相同；probe生成native代码，不需要先完成S4.1全部publication生命周期。

calibration只覆盖顺序read/write/read-write、random gather、atomicAdd/CAS（unique/sharded/contended）、texturefilter/LOD/locality、ALU/sin/pow/sqrt、shared/barrier、dispatch/pass overhead；subgroup有能力才测。输出sink/独立checksum防DCE，报告bytes/实际operation、effective范围、timestamps资格、warmup/热态、随机working set、校准/混合kernel差距。复用现有timing/readback设施，异步读回不参与本帧visible/work control。

**集中退出。** shader compile、CPU/math oracle＋真实 GPU outputs；同图像/质量native vs split；1080p highcoverage总native成本、effective bandwidth/random gather/texture/ALU以及outputs/scratch/command范围。计时不把unclassified scope遗漏或passsum冒充frame span。无真实目标GPU/时间能力则保留未完成数据门，记录可用结果，不能伪造阈值通过。若native本体严重偏离模型，先分析重建重复/采样/寄存器/lowerings/limits并修模型，必要时修改fused/split边界；**不进入binning以掩盖问题**。旧27/59ms夹具不是该退出证据。

### 3.2 S4.1 — Native Material Backend + Publication

**完整责任。** `AppearanceGraph→typed IR→CSE/DCE→dependency/frequency→C/X/Y/explicit Grad→native WGSL→explicit profile/pipeline→ProgramRegistry→Material Instance publication`。至少Standard PBR、Unlit、Clearcoat和一个真正custom graph（非线性坐标或嵌套query，有参数与texture）走同一native backend；不把custom留旧VM，不仅编译固定PBR。

**Source closure。** REWRITE `AppearanceGraphCompiler`必要接口、`appearance_program`、`GpuAppearancePublication`native产品及`GpuRenderWorld::prepareAppearance`；从`ExactAppearanceDag::compileAppearanceExecutionPlan/compileExactAppearanceDag`提取依赖/frequency/neighbor/liveness分析，native backend不得importTapeGPU编码。KEEP registry async lease/preflight/device epoch；去除cache-specific field witness。KEEP TextureResidency/StaticProduct资源与更新事务。publication形状在本单元稳定，coverage/native/Temporal读者采用一份实例snapshot/route/version语义，不创建通用field-cache metadata。

**Production接线边界。** 本单元新backend在隔离 compiler/GPU consumer中闭合；旧production仍可存在于其唯一旧路径中。不发布新旧两份长期生产metadata，不在Runtime增加选择桥。若修改public publication接口会影响旧production，则把实际破坏式切换留S4.2：本单元完成独立native产物及oracle，不强迫旧VM消费native。完整新publication切换包含下单元coverage/Temporal/VSM消费者，提前准备其读接口和测试，不能留下adapter。

**必须明确。** ProgramKey不含实例值/texture layer，实例引用Program＋route/parameter；typed IR合法graph全部native。numeric/资源edit标记真实依赖，便宜更新CPU/inline、GPU math/resource uniform生成native update kernel，同一 encoder在消费前发布。committed CPU/GPU快照只在成功submit后推进；abort保留旧快照并可retry，未ready pipeline/cancel/device loss不使半publication可消费，资源在 fence 后退休。compile错误明确失败；pending asset可延迟发布，不降成default material/VM。layout/liveness/footprint完整，compile budget与resident pipeline capacity分开说明。

**集中退出。** 独立 CPU oracle与生成native WGSL GPU numeric，PBR/Unlit/coat/custom、全部既有合法op/width/broadcast/shared texture/DCE；C/X/Y非线性/嵌套UV、SampleGrad/LOD、transform/sampler/decode/minimum resident mip、normal moment/cooked Product；parameter/resource/frame update、stable frame、abort→retry、publication atomicity、async failure/cancel/lease/device epoch。GPU transcendental用合理独立误差依据，不要求JS double逐bit等价。fixture/mock不替代generated WGSL运行。采样/更新次数与新增uniform bytes按Cost Card核，不能按输出field重复计节省。

### 3.3 S4.2 — One-Route Native Opaque Production Cutover

**完整生产链。** `Visibility+Depth→one native route→winner geometry→native material→clustered direct/VSM/IBL→HDR+minimum Temporal outputs→Sky/Aerial→FSR→Radiometry/Bloom/Present`。本单元切换RendererCore、FrameProgram/Bindings/Lowering、GpuRenderWorld publication与native pass，唯一production opaque入口从此不调用旧SurfaceWork。准备/提交/中止/resize/recovery与资源计账同时连通。

**One-route含义。** 是一个Program/Pipeline＋一个compatible BindingSet，允许许多实例/不同参数/texture layer；不是“Standard PBR-only”，可用S4.1的四种program分别测单route。只在已声明one-route场景范围关闭此单元；多program或多bindingSet的真实完整支持属于S4.3。超scope在publication/admission显式拒绝/报告，不能只shade其中一个route、把所有graph冒充PBR、保留旧生产fallback或永久收缩M1最终场景。若产品要求切换时即支持所有现有多route场景，则S4.2与S4.3作为同一production closure连续实施，集中验收两部分；不恢复旧桥。M1不能在S4.2停称完成。

**不得遗漏的消费者。** 新publication的alpha/cutoff/sourceGrad/product必须供`CoverageRasterBindings`、`MeshletBucketRaster`、`RasterWorkPartitions`及`VsmAtlasRasterPass`；主Visibility/阴影coverage语义一致。TemporalFacts现在读取旧material lookup/value versions及纹理版本，改为新instance publication，保motion/validity/change/identity语义；FSR真实读取HDR/depth/facts motion、新reactive/mask、current/prior preExposure。minimum Temporal products在这里已闭合，不能等S4.4才给FSR输入。

**Writer与Lighting。** Visibility当前r32 winner＋queue generation/partition完整保留，prepared/resident Geometry同数学/requirements；opaque仅winner写，背景明确初始化/HDR producer，Sky/Aerial后写新Graph version。alpha在winner形成前拒绝；不后擦winner。保正确 two-sided/tangent/nonuniform transform/near clip/LOD/source fallback；cluster empty/overflow、VSM有效query及missing policy、IBL/DFG/coat/sun/scalar AO组合、guard/preExposure都按现有有效语义接通。Unlit不做无需求Lighting采样；有限空binding合法与无消费者巨量资源不同。

**集中退出。** production normal/ORM/coat/custom各one-route、空/全背景/薄三角/屏边tail/alpha/强IBL/4或8灯/VSM非零输出；CPU/reference image/numeric和HDR/FSR最终consumer。motion/jitter/exposure/camera cut、parameter retry、graph late bindings/fence、resource scope按新链核。测真实 high-coverage PBR：全部 Surface GPU time、bytes/live+retired/working set、Geometry gather、texture、Lighting和寄存器/spill风险（无WebGPU register counter时用同质量kernel实验和可用backend profiler，标明推断）。慢先定位必要工作，不加cache/proof/VRS。老runtime文件可以临时dead，旧scratch/history不得再分配/encode。

### 3.4 S4.3 — Multi-Route Execution Bins

**首版仅两种。** one-route dense bypass；multi-route `CompactPixelBins`。发布期建立instance→Program/bindingroute→ExecutionBin表，GPU读Visibility/winner mapping分类；tile-local aggregation→sharded histogram→small prefix→局部rank/scatter pixel index→native indirect dispatch。KEEP publication/program cache/TextureResidency，REWRITE legacy coherence/bin contract consumer；DELETE旧bank/family/template/cache队列protocol。类型/文件名可采用`NativeShadingPass`/`ShadingBins`，不造新V4 Runtime mini-OS。

**容量与完成域。** 每有效winner恰好进入一个bin；u32 pixel index容量按P，count/index/args之间依赖由pass/Graph保证，没有cross-workgroup barrier/spin wait。bin/shard表、shared memory、整数乘积、2D flattening/indirect dimension限额preflight，capacity overflow有显式完整行为，不能wrap/truncate/lost writer。尾lane、empty bin、全背景、巨大实例数/资源route变更以及abort/resize后旧counter不能污染。CPU按publication已知bin编码，GPU count无需readback；命令可随unique Program/binding profile增长。

**矩阵和退出。** 至少1/2/8/32/128 unique programs；单program多BindingSets另测，10000instances/32programs与128真实uniquegraphs分开。记录B execution bins、active/encoded bins、binding sets、tile entropy/U分布、queues/working set、global/shared atomics/barriers、空dispatch、pipeline changes、CPU encode、管理全部 scopes GPU ms、random/texture/cluster locality。128program可能超过128pipeline entry的旧registry budget（还包含updates/coverage），先协商完整容量；不能用128instance伪装或绕过真实compile lifecycle。

correctness对照独立winner/Program分派，全部pixel HDR唯一writer/coverage完整；cost比较同质量native分派与dense baseline，管理要明显小于其支持的useful shading并能解释全部成本。少route尤其1route不付histogram/queue税。高熵/多BindingSet组织成本过高时先重新评审bins locality/资源布局/CPU scope，未获可行结论就不关闭；不造cache/VM。SortedTileRoutes/ProgramPage/NativeSwitch自动selector不在本单元；以后只有Cost Card+data证明才提出有界替代。

### 3.5 S4.4 — Minimal SurfaceAux + Temporal Direct Consumers

**从现实consumer倒推。** 清点FrameProgram facts→native writer/TemporalFacts→FSRPrepareInputs/Reactivity/Accumulate、Debug以及当前真实effect。定义有限Base/Temporal/Reflection-GI语义profile与需求recipe；Reflection/GI只有实际consumer才纳入输出闭包，未来接口名称不能触发资源。S4.2已生成最低motion/reactive/validity；这里整理精度/产品ownership、减少重复重建/无需求分配并稳定新接口，不推迟基础FSR正确性。

**KEEP/REWRITE。** KEEPTemporal/FSR独立history/radiometry/cut/abort/fence；REWRITE`TemporalFactsPass`/`temporal_facts`的publication/change接口与FrameProgram fact/Lowering，native Aux writer及直接FSR/debug consumers。Depth/Visibility可重建值与需material eval的normal/roughness/response分开计算成本；如真实consumer使用normal map后normal，不能只用几何normal替代。当前Temporal identity双rgba32uint保留/缩小/重算的选择必须维持有效拒绝语义，history归Temporal；删除signal history不等于删所有Temporal history。

**精度与生命周期。** 按母稿§6给格式/bytes/pixel、space/value/domain、background/invalid、motion方向/单位/jitter、HDR preExposure、normal/roughness mapping、writer与读取阶段、必要version/reset/abort/retire、误差budget和独立image验证。若winner需8B保完整身份；不强制4B。Demand关闭时不仅pass不写，owner图外也不分配无consumer resource；存活consumer必须随producer变化接齐。跨profile资源用途/format协商合法，alias只在兼容不重叠生命周期。

**集中退出。** FSR真实chain/Debug以及任何启用effect读新Aux；motion精度/fast motion/sky/cut/jitter/scale/曝光跳变、normal map/roughness/coat/HDR高光暗部、mask change/retry/resize；逐产品allocation/read-write/domain/physical peak，Base/Temporal真实不同需求。无consumer的Reflection/GI输出应为零分配；新增consumer时在该owner模块补合同，而非在此提前复活GBuffer。接口稳定后才同步实际domains/specs，不把计划写成已实现。

### 3.6 S4.5 — Old Surface Retirement + M1验收

**删除条件。** 新`Visibility→NativeSurface→HDR/Aux→全部direct consumers`、compiler publication/coverage/VSM alpha、multi-route完整域、Temporal/FSR及prepare/commit/abort/recovery全部闭合。S4.2起旧owner已退出调用，本单元一次清理dead源码、types、资源账、exports/tests、timing分类/registry/retired guards；不是继续保留旧生产直到M1末。

**删除清单（实际依赖检索裁定文件范围）。** `SurfaceWorkRuntime`、旧`SurfaceFrameResources`银行/预算/history职责、`GpuSurfaceWorkAbi`bank/field/signal heap、GPU`appearance_exact_dag`/Tape production backend及只供其消费的code/lane ABI、global`AppearanceClosurePlan`/closure cache key/request/nomination/unique-writer/publish/store协议、generic Signal History/rate/六RGB packet store、`surface_work_reconstruct`generic opaque Reconstruct、旧proof/store/reference/types与没有consumer的diagnostics/settings/providers wrapper。`ExactAppearanceDag`分析/math若已提取可删除旧文件；CPU oracle可保设备无关IR eval，不保GPU VM桥。`GpuAppearancePublication/ProgramRegistry`新职责KEEP，asset/cooked Product正确接口KEEP；同名publish为材质事务时不能按关键字误删。

**保留地图。** KEEP Scene/asset/TextureResidency/FrameGeometryArena/Visibility/cluster/VSM/env/FrameGraph/command/FSR真实owner；REUSE MATH ONLY旧Surface geometry completion/BRDF/filter/bary/guard中可复用部分；REWRITE Compiler/native publication/native binding/FrameProgram/Temporal接口；DELETE上述退休协调/表示/缓存/六signal history协议。允许移动helper以解除旧import，禁止compat wrapper/second submit/CPU visible control。

**集中退出与停机。** fresh typecheck/build/build:test＋相关semantic GPU oracles、完整M1route/材质/alpha/资源/coverage/unique HDR writer；resize/camera cut/update-abort-retry/device loss/retire、strong IBL/normal map/texture LOD/near/far/static/moving/空scene/原有VG Product输入/missing/cluster overflow/VSM与AO有效consumer；固定条件全部 Surface scopes、unknown解释、CPU encode、bytes与physical steady/resize peak、必要P50/P95短序列并注明热态/采样限制。旧对比用固定独立checkout+等价质量/feature/scene，并不把历史27/59ms不同夹具当speedup。正式全Renderer多browser/长时历史性能claim留M7；若本机不能执行M1必需验证如实未完成，不以文档改名放行。

删除 guard 只证明 production import/allocate/encode 不存在，numeric 仍需新链；有效旧 semantic tests 映射表齐全，B2 旧缺陷按§4记录退休条件。真实 facts 更新 domains/稳定 ABI/source adoption 仅按已验证范围；同步 current 文档的 `verifies.files` 到实际存活 producer/consumer，不能让删除文件留下假依赖。本文写实施结果不新增状态文档。**Surface V4完成后暂停，重新审查下一模块，不自动进入M2。**

## 4. B2旧缺陷与存活语义

<a id="legacy-retiring-path-defects"></a>

| ID | 不改写的历史失败 | V4重新分类 / 新责任 |
|---|---|---|
| B2-NUM-001 | General参数update/abort/retry后roughness实际0.2757329643 vs 0.2333125621；后续复跑通过不关闭原失败 | **legacy retiring-path known defect，unfixed/unresolved**；S4.1native publication参数/dirty/abort/retry/atomicity与stable material numeric oracle |
| B2-NUM-002 | 固定资源update/参数retry稳定HDR(0,0)ch0实际0.99951171875 vs 1.4979037235540191，无APIerror；根因未定位 | **legacy retiring-path known defect，unfixed/unresolved**；S4.1resource publication/retry＋S4.2完整HDR＋S4.4Temporal/曝光稳定帧 |

原输入/指纹/失败保留在[R4 §2.2](./eengine-extreme-performance-rebuild-execution-2026-10.md#22-未关闭正确性问题与用户例外)和[R3归档](../archive/eengine-extreme-performance-rebuild-r3-execution-2026-10-07.md)。旧实现bug不再作为V4强制修复blocker；也不标fixed/passed/resolved。S4.5只有实际删除其旧publication/Tape/Surface producer及生产consumers后，可记录“旧producer已退休，缺陷不适用于新链”；这与找到根因/修复历史实现不同。

对应parameter update、abort/retry、publication atomicity、稳定帧numeric/HDR要求没有退休。新owner必需测试未通过就不关闭相应V4单元；若同类错误在新链复现，登记新实现缺陷并修根因，不能借旧bug分类豁免。`.local`报告不可用时保留路径/数值/来源范围，不能虚构复现成功。

## 5. Source Mapping与测试迁移

下列是implementation入口与owner地图，未来文件名可随实现调整；不会因规划声明自动创建class/ABI。每单元均查全直接consumer，不能仅按此表操作。

| 单元 | 现有producer / 直接consumer | KEEP / REUSE MATH | REWRITE / DELETE责任 |
|---|---|---|---|
| S4.0 | GeometryArena/Visibility→isolated native probe HDR；cluster/VSM/IBL→probe | winner/资源源、geometry/BRDF/filter/采样数学、已有timer | local probe/Cost Card；不接入第二Renderer，不消费旧heap/signals |
| S4.1 | GraphCompiler/ExactDag/appearance_program→Registry/Publication→generated native oracle；RenderWorld资产发布入口 | typed IR/CSE/DCE/samples/deps、registry lease、TextureResidency/Product | native C/X/Y/update backend/instance publication；隔离Tape/cache编码，不留custom VM |
| S4.2 | PackedVisibility/publication/Lighting→native opaque→Sky/Aerial/FSR/Post；publication→CoverageRaster/meshlet/partitions/VSM alpha/TemporalFacts | GPUScene/VG/Visibility/Arena/cluster/VSM/IBL/AO/FrameGraph/FSR | RendererCore/FrameProgram/Bindings/Lowering、新native pass、publication和所有alpha/Temporalmetadata读者；旧runtime停止调用/分配 |
| S4.3 | instance/program route+Visibility→count/offset/index/args→每bin native opaque | Registry/residency/winner | native bins/control/indirect/capacity；旧coherence、bank/family/cache队列退休 |
| S4.4 | nativeAux+TemporalFacts→FSRPrepareInputs/Reactivity/Accumulate/Debug与实际effect | FSR/Temporal独立history、motion/exposure数学 | finite Aux/demand/precision/Temporal publication接口；无consumer产品删分配 |
| S4.5 | 当前SurfaceWork/旧ABI/shaders/tests→已闭合的新consumers | 独立有效数学/资产owner、actual products | DELETE旧runtime/frame heap/Tape/cache/six signals/history/reconstruct/proof/store/reference；更新真实domain/guard/timing |

现有tests仅是迁移入口，不默认其预期可信：`appearance-graph.test.mjs`/`appearance-normal-filter.test.mjs`/`appearance-product-sampling-gpu.mjs`→S4.1nativeoracle；`appearance-publication.test.mjs`→S4.1/2事务；`surface-coverage-value-gpu.mjs`/`surface-geometry-boundary-gpu.mjs`→S4.2winner/数值；`surface-temporal-value-gpu.mjs`/`fsr3-frame-lifetime.test.mjs`/`temporal-fabric.test.mjs`→S4.2/4。`appearance-typed-tape`/`appearance-exact-dag`、`surface-signal-store`/`surface-field-store`、closurecache/Storeprotocol等旧表示断言在对应producer退休时删除；其中CXY/numeric/uniquewriter/abort语义迁移，不能整套直接丢。

FrameGraph/command lifecycle测试保持真实新资源消费，mock缺API不要乱接production owner。`SurfacePhaseTiming/GpuTimingCost`分类应随native/binslabel变化集中改，不恢复老scope来满足旧test；全部management、zero-workdispatch、clear/copy/publication/retirement范围要解释。

## 6. Cost Card与数据决策

每个重要新增机制在实施前附一张简卡到对应单元实施记录/设计决策，source与测量后更新，不另建状态系统：

| Cost Card项 | 必填内容 |
|---|---|
| Workload/语义 | scene/graph/profile、P/V/T、lights、programs/ExecutionBins/BindingSets、entropy/residency、相同quality/reference |
| bytes | 新增/删除read/write bytes/pixel及总bytes；random/sequential分开；过滤texture流量已包含就不重复加 |
| compute | 新增/删除ALU/special ops、texture queries/taps、uniform/perpixel频率、实际删除work与仍必需exclusivework |
| management | global/shared atomics及contention/CASretry、barriers、scan/clear/copy、dispatch/pass/pipeline/CPU encode changes |
| memory | temporary/persistent working set、live/retired/upload/resize peak、每binding/sharedlimits和overflow完整行为 |
| model | effective吞吐来源/校准身份、compute/bandwidth/random/texturefloors、重叠假设、optimistic/expected/pessimistic；无数据明确假设 |
| break-even | ideal100%/50%/0%收益的成本/节省、噪声区间、适用/拒绝条件、失败后完整native correctness |
| measured verdict | closedunit的真实GPU/CPU全成本/quality，unknownscope解释、unavailable项，retain/rewrite/reject原因 |

frequency extraction也要计update/persistent uniform/边界读取成本，不能认为“编译期”就自动零executiontax。cache/VRS/ProgramPage/额外compaction/materialization未来即使提出，100%理想收益都不能明显赚钱则不实现，0%收益有高管理税则不得常规hotpath。可选机制关闭后必须仍有正确完整native，不能再把“OFF”做成巨量旧direct fallback。

开放决策只保留需要真实数据者：fused寄存器/跨pass收益对应compact deferred分界；nativeProgram×BindingSet/coverage pipeline的实际规模与capacity；shards/workgroup/multi-route locality以及将来compactpixel vs tile-route的必要性；winner32-bit外部context是否足够，改变契约才评估8B；Temporal identity/Aux格式精度与实际consumer。初版dense/CompactPixelBins已选定，tile-route不是同时开发的第二策略。后续AAA算法仅接口，不在M1决定reservoir格式、GI/SSR完整pipeline或AI模型。

## 7. 本次文档切换的检查范围

本轮仅运行`node tools/docs-verify.mjs`、文档/导航工具targetedtests、真实context/router解析及`git diff --check`。它们验证frontmatter、依赖、当前入口、YAML/链接和差异，不证明V4已实现或GPU performance。本轮不运行engine typecheck/build、browser、GPU calibration、renderer oracle或benchmark；生产TS/WGSL不修改。实际命令/结果在交付汇报，不复制成README状态。
