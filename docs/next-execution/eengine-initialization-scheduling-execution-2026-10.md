---
id: eengine-initialization-scheduling-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-initialization-scheduling-2026-10.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - docs/porting/next-renderer.md
    - OEngine/src/assets
    - OEngine/src/gpu/GeometryPageScheduler.ts
    - OEngine/src/gpu/GeometryPageStreamingRuntime.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/render/SceneRefinement.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - examples/integrated/bistro-texture-compression/cooked-scene.ts
    - OEngine/src/render/ShadowGeometryWork.ts
    - OEngine/src/render/vsm
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - examples/integrated/bistro-texture-compression
    - OEngine/tests/contract
    - OEngine/tests/oracle
---

# 初始化调度执行计划

> 后续方向更新（2026-10-17）：本文保留本模块已实现合同与原验证结果；正文中的“下一模块/Local Probes边界”仅指当时停止点。当前模块由workstream导航至[Surface Cache GI设计](../next-design/eengine-surface-cache-gi-2026-10.md)与[执行](../next-execution/eengine-surface-cache-gi-execution-2026-10.md)，不再据旧停止点启动传统GI路线。

唯一细设计为[初始化调度设计](../next-design/eengine-initialization-scheduling-2026-10.md)。源码起点`30292e0e`；设计轮于`f7a6c4cf`收口，2026-10-15用户先授权INIT-1，随后授权完成复审修正并提交，再实施INIT-2并复核。随后授权提交INIT-2并实施、复核INIT-3。研究、诊断脚本或文档检查本身不算实施结果。

INIT-1开工前置（本轮实际第一步）：现有诊断机制已存在但无生产者——`addGpuListCounterPass`/`GpuListCounterAccumulator`零调用者，`VsmResources.diagnostics()`已给出dirty页/配对/atlas的计数偏移，而`BenchmarkCapabilityEvidence`有6条`PackedCsmShadowPass/*`声明指向已从production删除的旧pass。故先在INIT-1内把这些观测接成真实的VSM工作量计数并撤销失效claim，再决定发布批次预算。

## 1. 三个完整单元

| 单元 | 状态 | 闭合边界 |
|---|---|---|
| INIT-1 几何帧事务与VSM更新闭包 | 已实现并完成相关正确性验证；性能结果有限，不宣称消除初始化长尾 | 事务发布/退休、变化union、公平完整页、空间时间合批、requested/selected双域及真实Bistro观察闭合；首屏和Worker仍由后续单元处理 |
| INIT-2 Worker批量资产准备 | 已实施并复核；相关验证通过，既有Native Cooker golden失败单列保留 | 复用pool建立Cooked几何/texture任务，Range批量、验证receipt/transfer、输入与ready背压、可靠独立压力与生命周期；bootstrap与持续流送共用同机制 |
| INIT-3 并行首屏、渐进纹理与真实收敛 | 已实施并复核；调度/生命周期闭合，启动性能限制及独立基线失败见下文 | 目录去重、并行必要PSO/资源、首屏critical集合、事务mip区间与预算、view epoch阶段和Bistro真实验证/文档复核；删除旧入口，停回Local Probes边界 |

不按文件、每个shader或每条测试拆阶段。用户授权实施后按顺序连续闭合本轮明确范围；阶段内允许暂时不编译，稳定边界唯一生产ownership。不创建A/B renderer、旧发布adapter或测试专用fallback。现有SSR/AO代码与质量合同保留。

### INIT-1：先删除GPU放大

- 观测接入：GpuFrameCounters 升级至 Schema 30（848B），新增 `vsmDirtyPagesDirty`（208）、`vsmDirtyPagesSelected`（209）、`vsmDirtyPagesInvalidated`（210）、`vsmDirtyPagesPending`（211）四个计数器，通过 `copyGpuCounter` 零 dispatch 直拷；清理 BenchmarkCapabilityEvidence 中 6 条失效 CSM claim；彻底移除 RendererCore 中未写入却作为调度器输入的死字段 `_streamingGpuFrameTimeMs`。
- 几何帧事务发布：激活 GeometryPageScheduler 沉睡的 `submitted` 状态；VirtualGeometryResidency 设立 `#stagedPages` 隐藏槽（`stagePage` 阶段仅写 Bank payload、不公开位置表）；`preparePublication` 经 ShadeGPUCommandContext `uploadRegions` 一次性打包编码 16B 位置表拷贝，并计算同帧候选版本与候选影响区；只有在包含拷贝的 Command 在 `onFinished` 提交成功时才推进持久 CPU 状态（`resident`、`contentRevision`），`onAborted` 干净回滚候选状态。原提交的退休仍直接撤映射，已在复审中改为同一帧事务，见下文。
- 驻留变化影响收紧：`GeometryRefineInfluenceV1` 按细 group 建立反向边聚合粗父几何 AABB 并设置溢出降级；VirtualGeometryResidency 在入驻/退休时生成候选影响区；`vsm_depth_bounds` 消费 binding 7 `influences`，纯驻留版本变动使用紧凑 AABB 投影收紧 damage，无法证明时安全回退整实例并计数；无变化帧保持 0 GPU 派发。
- 有界选择：`vsm_allocate_pages` 中的 `publish_dirty` 为64-lane有界选择器，消费 `identity.w` 的 `dirtyPageBudget`（默认64页，可配置1..2048）。未选差额写入 `overflowCounters[7]`；选中槽设 `inFlight`（bit2），预算延期不置allocation overflow。原文“历史requested”不成立：requested每帧清理重建。复审后顺序为最老dirty页保底一个名额，再coarse、当前requested fine、后台dirty；未完成requested/selected-dirty层级双域。
- 原提交报告：tsc、build:test、109个CPU tests及4个GPU oracles通过。这些检查没有覆盖同资产多页影响union、退休帧abort/失败fence、一页预算和长期公平性，不能证明本单元完整完成；原报告的数字保留为历史实施记录，不作为复审后新源码的证据。

#### 2026-10-15复审与修正

复审对象为`76e14f7e`（实施授权/观测前置）和`419d7a28`（INIT-1实现）。总体owner方向正确，但原“已完成”结论撤回。本轮经用户授权直接修正已确认的问题，没有启动INIT-2/INIT-3。

- **发布/退休唯一事务owner**：`beginRetirePage`/multi-runtime `evictPage`只登记请求；residency在普通帧编码non-resident位置和对应候选版本/damage，只有该帧提交后才撤CPU映射。该帧fence成功后释放slot；失败保留retiring及错误，不吞失败授权复用。删除公开的独立commit/retire完成入口。候选在编码copy前安装abort钩子；Renderer在try/abort保护内prepare。撤销已编码隐藏槽或销毁residency时先abort其所属普通帧，再释放槽，不能释放后仍允许提交。
- **变化范围完整性**：在publication时从当前反向refine索引重新求影响，避免fine先stage、coarse后stage造成过时范围；同资产多页及未消费的跨批次变化做union，任何full-asset fallback支配紧范围。共享group向全部引用asset发布影响。VSM先snapshot、提交后ack，中止不丢damage；无变化记录时也清零旧receipt，避免旧紧范围缩小新失效。
- **公平性与不必要工作**：meta末word命名`dirty_since`，在clean→dirty记录frame serial，重复失效不刷新，完整页commit才清零。选择器保底最老页，再服务coarse/current/background。纯residency只更新snapshot/damage，跳过无关的全caster深度归约/发布；普通transform/scene/caster变化保留完整归约。
- **观测语义**：completion统计改名`stagedPages`，`geometry.streaming.pagesPublished`来自本帧实际编码的地址数量。所有Product和直接staging共享publication页数上界，退休请求不依赖是否有新上传。

修正成本：不新增GPU buffer或dispatch；`dirty_since`复用32B meta内既有word。最老页选择增加一次resident-slot扫描和64-lane归约，0/50/100% dirty均付出有界扫描（high profile900 slots），用于避免无限等待，未宣称净提速。CPU保留每个驻留/隐藏页的group范围和bounds，并按asset数量合并未消费damage；共享group的多owner索引仅在实际共享时存在。纯驻留帧删除depth partial写入与publish-depth dispatch，但instance snapshot/damage扫描仍存在。

本轮修正后验证：`OEngine` production `npm run build`（含tsc/Vite/declaration）与新鲜`npm run build:test`通过；6个相关CPU测试文件59/59通过。串行真实硬件GPU运行`vsm-local-invalidation`（5193 assertions，含同asset多页union、fallback支配和abort保留）、`vsm-v4-r1`、`vsm-v4-r2`（完整域reference另设全页预算，并额外验证1页预算/最老页/未选页保dirty/最终收敛）、`geometry-budgeted-residency`（72帧压力与main/shadow coarse覆盖/设备丢失）、`geometry-shadow-view`均通过，无GPU validation错误。运行宿主为NVIDIA Turing硬件adapter；该次R2未启用timestamp-query，不能引用空的timing样本为成本证据。完整JSON保留在本地忽略目录`.local/init-1-review/`，不晋级正式claim。构建仍有既有codec vendor的`node:module`浏览器externalization提示。

失败保留与分类：压力oracle首次运行因旧手写command没有`gpuDone`而失败，换真实`ShadeGPUCommandContext`后又因非登记submit label被拒，改用正式frame label后通过；未给production添加测试fallback。新增CPU断言首次失败因fixture同时回退了已提交instanceRevision，把它误标成纯residency；保持instanceRevision后核对，并保留transform必须rebuildDepthRange的反向断言。小GPU fixture不证明Bistro启动时间改善。

**复审时未闭合项及本轮处理：**

1. 发布默认50ms机会、100ms到期优先服务，cut/current missing可提前；最大32页是硬上限，按同Product/asset的保守bounds重叠聚合，damage单位和三角形估计限制软额度，至少进展一个不可分页。直接stage和scheduler共用页数/时间上限，abort不推进发布时钟。当前damage单位是CPU保守启发式，不冒充实际投影页数；每8帧在有准备任务时用普通submit拷40B allocation/pair摘要，延迟校准后续额度，慢增快减。没有timestamp时不声称毫秒硬预算。CPU空间聚合尚不做跨Product世界实例投影，因此不会消除所有重复damage。
2. `ShadowTileDomain`在同一帧建立每clip requested/selected两个32×32保守环绕bit网格（共1792B，另176B uniform）。一轮64-lane构建dispatch，用atomicOr合并含gutter的页域；hierarchy同一次遍历仅拒绝不相交requested节点，保留所有缺页/usage反馈，只把selected相交group送入raster queue。backlog selected也并入requested，不能遗漏完整caster。环绕只允许假阳性，方向光不沿Z剪裁；完整coarse/SSE0仍要求6085页。新增一storage绑定、root/traversal专用pipeline各一，创建前核limits，资源跟随shadow prepared owner退休。clean帧测试现明确要求0重绘但仍有需求/usage。
3. 完整Bistro（1920×1080、原模型/默认相机、同AO/SSSR默认关闭、VSM开启、1536MiB几何槽、最终6085页）串行对照：独立`419d7a28`原提交约17.64s首屏、89.996s采样确认全页；新源码首次约35.02s首屏、110.709s确认全页，热编译复跑14.01s首屏、84.977s确认全页，另一次约72.705s确认全页。5s采样有上取整，编译缓存/温度差异未做ABBA控制，不能据此宣称稳定净提速；首次回退保留。最后发布时刻分别108.255/82.264/71.268s，所有页无失败/evict/reload，暖帧约56.7FPS。启动长尾仍存在，不能宣称已解决。

成本复核：Bistro全页后强制VSM失效并设置1页预算，在完整timestamp模式保留120个样本，页raster P50约0.0061ms/P95约2.724ms/最大5.868ms，VSM pass合计最大6.096ms。这是已采页的最大值，不是全900槽穷举最坏界；默认64页仍可积累明显单帧成本，软预算不承诺严格2ms。当前样本无需立即引入跨帧私有页分段。Bistro几何bank+metadata约1664MiB，纹理约1010MiB，其他注册GPU owner约1162MiB（其中纹理已包含，不能再重复相加）；仍有未注册/驱动分配，非4GB真机证明。有效payload约242MiB，256KiB单槽填充率问题保留。截图已目视核对场景及VSM显示；小GPU fixture核对遮挡/alpha/abort/coarse，未把截图当像素等价oracle。

本轮补充验证：production build与新鲜build:test通过；相关CPU测试包含空间合批、超时重页进展、50ms机会、clean-shadow仍发反馈。真实GPU `geometry-budgeted-residency`、`geometry-shadow-view`、`vsm-v4-r2`通过；最终受影响集与文档检查结果随提交记录。首个shadow oracle失败来自旧fixture把clean帧也当有重绘；修改语义断言为clean=0，同时新增独立usage断言，没有放宽画面/完整caster断言。原WGSL sphere类型接线错误已修复并重新真实编译。完整JSON/截图及同条件原提交副本保留本地`.local/init-1-review/`，不提升正式claim。

### INIT-2：让准备跑满可用CPU/IO，结果不淹没GPU

- 将OEGPACK CRC/LZ4/布局和resident numeric验证归到CPU可复用kernel，复用`AssetWorkerPool`，建立version/session/task epoch、descriptor注册和worker重建协议；texture沿完整container+Product校验，内部receiver重建realm品牌。不能让普通`verified:true`冒充proof，不能取消hash。
- `GeometryPageScheduler`按priority选择后调用batch reader，coalesce相同Product邻近Range；编码/解码/结果全部credit预留，worker和HTTP并发独立；修正floor导致稳定单并发和伪throughput/GPU压力。保留公平、aging、generation完整身份与有界网络重试。
- bootstrap和持续流送统一batch preparation；ready→hidden stage→INIT-1 candidate，GPU work不由worker完成消息直接决定。trim prefix仅在验证完整页后内部消费，外部256KiB Product合同保留；若首版仍传完整页明确记成本，不伪称zero-copy prefix已完成。
- Worker crash/取消/epoch替换/descriptor重注册、detached buffer、late结果、scene release和device replay全闭合；1个worker是同路径capacity profile，不添加同步Cooked主线程后端。

#### INIT-2实施记录（2026-10-15）

- **CPU准备唯一入口**：`CookedAssetPreparation`复用`AssetWorkerPool`，默认`max(1,min(4,hardwareConcurrency-2))`个Dedicated Module Worker。HTTP OEGPACK revision source的bootstrap和运行流送都调用同一batch reader；Worker执行Range、原CRC/LZ4/布局、可选decoded SHA和原resident numeric kernel。kernel从gpu迁到`assets/geometry-product/GeometryProductResidentAttributes`，主线程只消费receipt中的payload extent、bounds和refine边，不重复逐顶点扫描。memory/custom provider继续使用原snapshot/digest及同一numeric数学。Worker不可创建明确失败，没有同步Cooked后端。
- **receipt与会话**：version1、UUID session、单会话epoch1和单调task id一起核对；新source/replacement使用新session，descriptor只在每个实际Worker首次执行该会话时注册，取消/崩溃重建后重注册。内部receipt必须来自实际pool结果，检查task/session/epoch、返回页顺序、完整身份、字节域、integrity策略和group域后重建本realm品牌。纹理Worker完整执行原container/section/Product校验，receiver只重复小metadata/身份/结构接线，不再hash大payload。transfer list按唯一backing buffer去重，发送方失去ownership；普通`verified:true`无效。
- **读取与背压**：scheduler先按Product公平性、priority与age选至多16页，只在同一current/shadow/predictive urgency域内合批，然后由source按offset合并。gap沿用64KiB，Worker span核定8MiB；默认4个批读取，HTTP admission独立默认4、可配置1..8，HEAD也占IO名额。Worker任务fetch期间仍占一个Worker，因此1个Worker profile不承诺同时4个GET。读前原子预留整批返回域，避免两批各持部分ready而互等；全局临时256MiB、编码32MiB、ready64MiB共同约束，不能把三者相加当新总额。几何按`2×encoded + 3×decoded`保守预留，返回后保留`2×decoded`（完整页加metadata余量），消费/丢弃/关闭source才释放；实际decoded ready因此至多约32MiB。texture输入上限128MiB，预留输入+digest峰值，HEAD/GET长度与identity encoding一致，响应流越界直接停止。
- **压力与可靠性**：删除Renderer用GPU上传bytes/RAF推算IO及RAF delta压所有预算的接线；稳定无压力恢复4并发，取整改ceil。显式IO压力只影响准备，延迟GPU/编码压力只影响上传，快减/每样本最多0.02恢复/0.05死区；跨阶段通过真实ready信用背压。实际encoded bytes、每任务IO elapsed、Worker busy、IO/Worker/信用高水位保留为独立观测，累计并行IO时间不冒充wall time。瞬态失败单列`lastRetryError`，成功重试不毒化terminal `lastError`；确定性CRC、布局、nonfinite、身份等损坏不走网络重试。late generation/session不发布。
- **释放与replay**：每个revision source独占Worker会话，释放其中一个不关闭同asset其他source；provider/asset释放关闭剩余会话。会话关闭abort活跃任务、终止相关Worker并丢弃descriptor注册，回收未消费ready；重建Worker再注册。residency bootstrap逐页消费后清理旧批引用，失败清理剩余ready。runtime loss取消旧读取和mapping；checkpoint保留CPU source，replacement device沿同一Worker入口重新读取，CPU验证不依赖GPU device epoch。没有新增frame submit或GPU→CPU→GPU工作控制。
- **直接consumer**：Bistro和Dungeon都改用共享Cooked texture准备入口，已知MASK albedo/coverage先排队；仍读取全部manifest条目并等待完整Product，未实施identity目录去重、并行首屏PSO或渐进mip区间。当时INIT-3尚未启动；后续结果见INIT-3实施记录。

Cost Card：不新增GPU buffer、binding、shader、dispatch或submit；删除主线程页CRC/LZ4/数值扫描和完整texture payload SHA工作，转到有界Worker。增加每Worker/session descriptor clone、小receipt/metadata核对、texture HEAD及transfer。v1明确仍传完整256KiB页：Bistro6085页约1521MiB累计decoded transport，对应有效payload约242MiB，尚未实现独占prefix slab；transfer避免额外结构化克隆大拷贝，不等于GPU上传零拷贝。几何ready metadata用保守余量计入总信用；descriptor副本、JS/浏览器网络实现开销和不可变texture replay payload另列，不把逻辑256MiB信用声称为浏览器RSS上界或约1GiB texture存储总上界。低需求0/50/100%时本地pool惰性执行，不因空队列派GPU工作；饱和最坏由各信用与普通帧publication/slot上限背压，至少保留一页进展。未用无限延期发布换FPS。

初轮完整Bistro观察（暖编译/缓存，1920×1080、原场景/默认相机、VSM开启、AO/SSSR原默认关闭、1536MiB几何槽）：首屏约13.36s，最后几何发布约41.50s，5s采样于46.38s确认6085页，暖帧约59.7FPS；INIT-1暖缓存记录14.01s首屏、82.26s最后发布（另一次71.27s）。本次4个真实浏览器Worker，累计857个资产GET（405个texture，452个geometry span），临时信用峰值约160.3MiB、encoded约10.2MiB、ready信用64MiB，最终信用/活跃Worker/queue均归零；无GPU validation、uncaptured或device loss错误，无evict/reload。并行任务IO累计约8.67s、busy约6.82s，不能相加当启动wall time。流送时仍有约5–12FPS窗口；全程RAF最大间隔约1.9s、主线程longtask最大409ms，不能宣称已消除所有卡顿。缓存/温度未做ABBA，首次观察和最终复核分开保留，非正式稳定净提速claim。

验证与失败分类：相关Worker/生命周期/调度检查在本地`.local/init-2-review/`保留。真实isolated Worker执行原production entry（Node仅适配浏览器事件名），覆盖相邻Range合并、urgency gap不混批、CRC/布局/position numeric和texture hash损坏、唯一buffer transfer后detach、本地品牌拒绝伪造、取消/崩溃后的重建重注册、ready消费/关闭释放、Worker不可创建显式失败及source跨device checkpoint/replay；浏览器Bistro另外验证真实Dedicated Module Worker与新生产GPU消费。首次扩大CPU检查错误工作目录导致Native Cooker路径不存在，改用OEngine目录后消除。进一步运行`oegpack-v3`发现一个原生整pack golden不一致：当前/重新编译Cooker都生成`ffabb8ee…`，旧断言为`9b37730e…`；失败发生于TS open前，Native源和该golden断言本轮未改，线程1/4产物一致检查先通过。额外提取独立`419d7a28`基线的原fixture/golden，用重新编译且本轮未改源的Cooker复现相同不一致，保留`baseline-golden.json`。本轮保留断言和失败，不把旧golden更新为“INIT-2修复”，不宣称全套通过。

最终复核：engine production build（含tsc/Vite/declaration）、新鲜build:test、Bistro与Dungeon targeted typecheck通过；10个相关CPU文件78/78通过，包含错误session epoch拒绝及恢复后不残留terminal error。串行真实NVIDIA Turing GPU `geometry-budgeted-residency`、`geometry-shadow-view`、`vsm-v4-r2`通过。扩大Native suite为83/84通过，唯一golden失败与上文相同。没有放宽容差、关闭必要断言或添加production测试fallback。docs-verify为0 findings、81条既有historical warnings。

最终源码完整Bistro复跑：13.20s首屏，40.43s最后几何发布，41.29s采样确认6085页，短暖帧约60.0FPS；另次复核17.41s首屏/46.51s最后发布，说明首屏缓存/编译差异仍明显。最终实际pool观测452个geometry span、405个texture GET、4个Worker和4个IO名额峰值，临时信用约213.6MiB、encoded约10.2MiB、ready信用64MiB，完成后全部used/queue为0；scene release后session为0，geometry/texture GPU owner账归零。相机平移25世界单位后恢复，均保持6085页，无失败/evict/reload/GPU validation错误；截图目视核对正常场景/阴影，但不是pixel oracle。全程最大RAF间隔约1.62s、主线程longtask最大416ms，仍不能宣称无卡顿。

观测失败保留：中间一次探针从无Vite时间戳的URL另import了CPU owner，误读出一个新空pool；该次启动/画面/geometry结果保留，但空pool数字不作资源证据。最终探针从实际`cooked-scene`已绑定的import读取owner，正确验证上述峰值和release。逻辑信用不包含浏览器/驱动RSS；未提供GTX1650Ti，仍无4GB真机证明。现有demo的`fullGeometrySettled`/`Full texture mips ready`不是本轮新view-settled证明，真实收敛UI和首屏critical/并行PSO/纹理区间promotion留INIT-3。单元到此停止。

### INIT-3：把首屏关键路径和“完成”定义接对

- manifest按期望Product identity合并读取和校验，alias正确保留sampler/UV和各材质绑定。geometry metadata/root、unique textures、必要结构PSO、环境准备并行；PSO拆真实结构与资源绑定，不用占位layout制造重复compile。
- `TextureResidency`建立区间promotion、物理分块copy和mip完整性、staging/fence预算及原子resident-minMip/Native采样发布。只上传新mip，不重传tail；首帧保完整coverage依赖，不再全材质无预算提升。full容器/replay内存与fullGPU分配明确不变，不偷塞partial Product或VT。
- 建立first-completed/纹理full/geometry target/VSM有效和view-settled epoch，替换空settled，capacity-limited不算完成；普通相机运动/cut、sun/scene变化重新refining。Bistro显示真实数据，GPU等待/CPU编码/IO/ready/publish/VSM分开统计。
- 删除旧逐页stream调用、completion直接发布、asset-version全实例流送damage、首帧无预算promote、伪压力与空settled的生产依赖；外部provider信任验证与已完成effects不退役。必要时同步其他直接Cooked consumer，不能只修demo特例。
- 集中验证后按设计逐段对：依赖→读取/worker→receipt→隐藏槽→帧发布→coarse handoff→damage→dirty页完整commit→Surface/MASK→mip/replay→收敛；只更新已发生的domain事实和粗模块结论。

#### INIT-3实施记录（2026-10-15）

- **唯一Cooked入口与并行首屏**：Bistro/Dungeon原两份loader删除，合并到shared/cooked-scene。CookedTextureCatalog以期望SHA256 identity合并读取与完整验证，URI alias独立保留sampler和材质UV；同URI冲突拒绝。几何metadata读取与unique textures同时启动，root admission与真实Texture银行/Material association/Native程序准备重叠；必要PSO基于最终图和物理layout，不编占位程序。同一未提交scene transaction提前准备材质，最终publication消费一次；失败/取消/late资产/device loss/shutdown中止候选，仍由现有scene upload submit发布。PhysicalEnvironment已有资源/Pipeline准备保留；真正LUT/IBL GPU计算使用首个普通frame的真实相机，不用占位相机预计算后重做。仍读完整容器、保留hash和replay，没有partial Product、mip HTTP或VT。
- **事务mip与容量**：TextureResidency删除queue.writeTexture路径，初始tail及完整MASK alpha依赖都用mapped-at-creation COPY_SRC staging，在scene command内copy。首屏critical不是只看albedo：独立lower alpha图的全部texture依赖均full。初始staging最多256MiB且受maxBufferSize限制；refinement每普通帧4MiB、最多128 regions、单块256KiB，活跃staging总16MiB，fair round-robin避免大mip饥饿。只传尚未驻留区间，物理row cursor可跨帧，某mip所有plane/block成功submit后才降低minMip/发布revision；abort保留旧clamp和cursor，retry重做未提交块。buffer在abort或所属GPU fence后销毁。复用一个已coarse的texture作为新场景coverage时，scene事务补足余下完整依赖，失败不提前修改旧场景采样。full GPU allocation和CPU replay payload不因分块而变少。
- **Native/VSM直接消费者**：纯shading mip变化原会令Native snapshot把所有binding/value差异当coverage变化，本轮首轮完整场景暴露重复VSM失效后返工。现在独立比较alpha图程序/资源、常量/输入和cutoff；移除MASK也失效，color/normal/ORM的无关promotion不再全域失效。Native Program结构key不随minMip变化。完整Bistro从准备后到全部精化始终3个Native Programs，queued/compiling归零后不再新增。Surface、Main MASK、VSM使用同一真实publication，没有第二套material或fallback。
- **真实完成定义**：SceneRefinement只观察，不选择GPU工作。first-completed直接来自实际command.gpuDone，与delayed readback处理分开；首次完成帧不会因连续quality publication被丢弃。view/light/content epoch变化或geometry/texture/Native quality publication要求fresh完整Main/Shadow反馈、pending/staged=0、full纹理及有效VSM，再跨后续完整观察确认。refining时原publication摘要40B扩至72B，每8帧追加32B失败状态；settled停止额外摘要，移动/太阳变化后恢复，既有需求/usage反馈不停止。capacity-limited明确返回limited，release/loss/终端失败拒绝等待；没有streaming观察源的低层scene不创建永远等待的observer。demo分别显示texture full和view-settled，稳定采样以真实settled开始，不再用空Promise/provider complete冒充完成。

Cost Card：不增加shader ALU、samples、atomics、barriers、全屏pass或frame submit。增加有界staging写入、copy命令及row padding、CPU候选cursor和Native参数publication；Bistro最终逻辑上传1,034,645,106B，物理copy 1,035,655,680B（约0.96MiB padding），其中初始tail/coverage112,078,482B、refinement922,566,624B。无abort的完整运行committed bytes与逻辑payload一致，没有重复tail；初始staging峰值113,037,312B（107.8MiB），refinement在4MiB/帧与16MiB在途界内。纹理完整分配约1002.7MiB、geometry bank+metadata1664MiB仍保留；与约1GiB CPU immutable replay分开记账，非浏览器RSS/驱动峰值。0%重复时identity只有目录映射开销；Bistro405 aliases→202 unique，删除203次完整texture读取/校验；纹理分批不声称减少最终texel工作或自动提速。空refinement队列O(1)退出，0%新增纹理工作不派copy/submit。单页VSM软预算与单256KiB geometry槽限制沿INIT-1保留。

**完整Bistro验证与限制**：原完整模型/默认视角、1920×1080、VSM开启、AO/SSSR默认关闭、1536MiB几何槽，NVIDIA Turing硬件，GPU串行。最终复跑demo first-completed约13.05s、full纹理约45.29s；以navigation performance.now记root完成5.56s、texture Products6.24s、必要PSO11.62s、bootstrap11.64s、最后几何publication53.31s、真实settled53.82s（demo相对起点约53.06s）。另一修正版首屏13.16s、最后publication53.81s、settled54.96s。所有6085页、全部mip、有效VSM最终闭合，无evict/reload或validation/device loss；短暖帧约60FPS，Render CPU P50约1.94ms/P95约2.53ms。相机平移25世界单位→恢复和太阳方向改变→恢复均重新refining并完成新epoch，释放后geometry bank/metadata、texture owner和Worker sessions/credits均为0。截图目视核对完整场景/阴影；不当作pixel oracle。

最终真实pool为452个geometry span、202个texture GET、4个Worker/IO峰值，临时信用峰值229,818,028B（约219.2MiB）、encoded约10.2MiB、ready信用64MiB；IO累计约8.20s、Worker busy累计约7.98s，不相加当wall time。texture读取和PSO都真实重叠，但几何精化仍有约4–12FPS窗口，最大RAF间隔约1.87s、主线程longtask约351ms；另一轮462ms。INIT-2同配置暖跑最后publication约40.43s（另46.51s），本轮约53–54s没有显示总收敛稳定净提速；约880MiB首帧无预算promotion被移除不等于所有卡顿解决。保留原始数据，未做ABBA/冷缓存强制对照，不提升Performance Improved claim。VSM GPU时间分位沿用INIT-1同完整caster链的120样本记录；本轮没有新timestamp分布，工作量/粗成本实际观测不能冒充GPU ms。未提供GTX1650Ti，无4GB真机性能证明。

**集中检查与失败分类**：engine typecheck/production build、新鲜build:test、Bistro和Dungeon targeted typecheck通过；7个相关CPU文件53/53通过，覆盖独立已提交row计数、partial mip abort/retry、alias sampler/UV、真实alpha lowering与cutoff/MASK移除、fresh feedback/limited/取消、唯一submit及几何生命周期。串行真实GPU pc-texture-residency通过76采样（maxError=6.1035e-5，原容差1e-4）、NPOT/BC4/exact alpha/Native真实profile/abort/retry/fenced zero；vsm-v4-r2及geometry-budgeted-residency通过。device loss/replay复用该geometry检查和INIT-2已闭合source协议，本轮不宣称新完整Bistro device-loss压力验收。build仅有既有codec vendor node:module externalization提示。

失败原样保留于本地忽略的.local/init-3-review：首轮完整场景的first-completed过晚和shading导致coverage失效已修正并复跑；旧submission测试fake缺当前owner/onFinished方法，迁移fake后保留原assertion通过。额外native-material umbrella先在已退休versions buffer统计处失败，改用publication.allocatedBytes后走到Product normal独立硬件reference数值断言失败；独立419d7a28源码副本新build:test也复现同断言（仅修该统计接线，production未改），该基线缺陷未修复，不改容差、不宣称全suite通过。第一次太阳探针用了非单位方向，被正确拒绝；保留失败，改探针归一化后完整重复验证通过。一次baseline命令工作目录错误、一次缺Playwright依赖属宿主错误，补正确本地依赖后才采用基线数值复现。

**逐段文档复核**：依赖/读取与Worker→receipt→隐藏几何槽→正式帧发布→coarse handoff→damage union→dirty完整页commit，保留INIT-1/2唯一owner；Surface/MASK→事务mip→replay→fresh收敛接到INIT-3真实consumer。没有本帧GPU→CPU→GPU控制、额外frame submit、完整coverage简化、阴影SSE/分辨率降低、跳hash、漏实例或无限推迟精化。两个旧demo loader、首帧无预算全量promote及空settled均删除。模块实现边界至此闭合；启动低帧率/总收敛与4GB资格仍明确有限，停回Local Probes边界，不自动实施下一模块或Page ABI/VT。最终docs-verify为0 findings、81条既有historical warnings；vibe context仍返回本轮唯一authority，vibe doctor无errors/warnings且registry一致，git diff --check通过。

## 2. 轻量必要验证

开发按需typecheck/小测试；单元末集中执行受影响contract、必要build和GPU。只添加少量语义case，不写逐行镜像测试、源码字符串检查或新重型evidence机制。GPU作业串行，不每patch跑整个Bistro。

| 范围 | 最小可解释覆盖 |
|---|---|
| 发布与生命周期CPU | 一个小Product，两次批次；hidden不出现在已提交resident状态、abort→retry、late generation拒绝；retire等待旧fence；共享页/多父coarse关系与两实例damage，不截断u32身份 |
| Worker/IO CPU+真实worker | 一次邻接Range合并与一个不应合并的优先级gap；几何CRC/结构/numeric损坏，texturehash损坏；transfer后detach与本地品牌，cancel/worker重建后descriptor注册、结果credit释放。复用既有pool/source tests，不建大随机矩阵 |
| VSM小GPU语义fixture | 页到达替换coarse且新group bounds更小；离屏caster；两个细页同batch union；一页budget跨帧保dirty；fine/coarse同时失效不采stale；pair显式溢出仍完整或明确失败；普通transform/MASK变化仍失效。与一次完整无budget结果在最终收敛后核对depth/visibility，不只看计数 |
| Texture/首屏 | 代表性opaque+完整coverage材质；粗到细区间只传一次，abort重试不提前暴露mip；首帧必要PSO未ready保loading，内容更新不重复PSO编译；两alias同payload不同sampler/UV保持。一次release/device恢复路径可复用相关fixture |
| 真实Bistro | 同原模型、视角、尺寸、最终quality，AO/SSSR保持原默认；正常完整启动到真实view-settled后短暖帧，加一次移动/恢复。记录首帧、交互回调间隔/提交帧间隔、需求收敛、IO span/worker busy、GPU VSM分位与资源峰值；UI可信度与画面要核对，不能只测partial roots |
| 必要编译 | 单元末受影响typecheck；production闭合一次engine build、新鲜build:test和相关contracts；demo只跑targeted Bistro typecheck。文档改动跑docs-verify。设计轮未运行生产build/GPU，实施结果见各单元记录 |

Bistro至少保留一次原配置基线与一次新配置完整运行，条件相同、串行GPU；冷/热缓存标记，不以一个短窗口保证二分钟长尾消失。已有诊断可用于选择case，但错误`vsm_enabled`off窗口不能当证据。未提供GTX1650Ti测试设备就如实没有4GB真机证明；同设备做descriptor上界/峰值检查不冒充4GB性能。

本模块是优化，需要同条件观察启动/持续卡顿是否改善，但不建整Renderer ABBA/正式claim门槛。不得以放大并发后更快读完、但画面卡得更厉害宣称成功；不得以延迟无限发布换稳定FPS；总目标/质量必须最终收敛，容量不足有明确limited结论。最重单页超过软预算、fallback可见变化和CPU/GPU保留内存是必须记录的限制。

## 3. 设计轮检查与停止点

2026-10-15已核读实际Cooked加载、OEGPACK批读取/校验、Product品牌、worker池/取消、residency上传/地址发布、frame事务、shadow全域SSE0、receiver粗覆盖、VSM损坏/失效/光栅和texture完整Product/minMip消费。成熟参考及规范已固定在设计与porting短映射；没有新shader/Worker实现、没有修改production行为。

以下保留设计轮当时检查；后续实施结果只读各INIT记录。当前INIT-1～3实现与相关验证已收口，停在Local Probes边界；不自动跨到VT或页面物理ABI重构，不把文档通过当成性能资格。

设计轮已执行：`node --test tools/tests/document-system.test.mjs` 7/7通过，`git diff --check`通过；`vibe context`对geometry streaming返回本轮唯一authority一对，`vibe doctor`无errors/warnings且registry一致。全库及changed `docs-verify`均仍有既有1个finding：Git忽略的`docs/status.generated.md`缺frontmatter，以及81条historical warnings；本轮没有新增finding，未修改生成状态文件来掩盖该结果。仅文档/导航改动，未运行production build、GPU或新性能测试；前述启动与对照数字保留原诊断条件，不当作新方案收益。
