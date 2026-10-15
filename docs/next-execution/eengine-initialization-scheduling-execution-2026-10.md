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
    - OEngine/src/render/ShadowGeometryWork.ts
    - OEngine/src/render/vsm
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - examples/demos/14-integrated/bistro-texture-compression
    - OEngine/tests/contract
    - OEngine/tests/oracle
---

# 初始化调度执行计划

唯一细设计为[初始化调度设计](../next-design/eengine-initialization-scheduling-2026-10.md)。源码起点`30292e0e`；设计轮于`f7a6c4cf`收口，2026-10-15用户先授权INIT-1，随后授权完成复审修正并提交，再实施INIT-2并复核。INIT-3仍未授权，不能把Worker研究、诊断脚本或文档检查当作完成。

INIT-1开工前置（本轮实际第一步）：现有诊断机制已存在但无生产者——`addGpuListCounterPass`/`GpuListCounterAccumulator`零调用者，`VsmResources.diagnostics()`已给出dirty页/配对/atlas的计数偏移，而`BenchmarkCapabilityEvidence`有6条`PackedCsmShadowPass/*`声明指向已从production删除的旧pass。故先在INIT-1内把这些观测接成真实的VSM工作量计数并撤销失效claim，再决定发布批次预算。

## 1. 三个完整单元

| 单元 | 状态 | 闭合边界 |
|---|---|---|
| INIT-1 几何帧事务与VSM更新闭包 | 已实现并完成相关正确性验证；性能结果有限，不宣称消除初始化长尾 | 事务发布/退休、变化union、公平完整页、空间时间合批、requested/selected双域及真实Bistro观察闭合；首屏和Worker仍由后续单元处理 |
| INIT-2 Worker批量资产准备 | 待实施 | 复用pool建立Cooked几何/texture任务，Range批量、验证receipt/transfer、输入与ready背压、可靠独立压力与生命周期；bootstrap与持续流送共用同机制 |
| INIT-3 并行首屏、渐进纹理与真实收敛 | 待实施 | 目录去重、并行必要PSO/资源、首屏critical集合、事务mip区间与预算、view epoch阶段和Bistro真实验证/文档复核；删除旧入口，停回Local Probes边界 |

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

### INIT-3：把首屏关键路径和“完成”定义接对

- manifest按期望Product identity合并读取和校验，alias正确保留sampler/UV和各材质绑定。geometry metadata/root、unique textures、必要结构PSO、环境准备并行；PSO拆真实结构与资源绑定，不用占位layout制造重复compile。
- `TextureResidency`建立区间promotion、物理分块copy和mip完整性、staging/fence预算及原子resident-minMip/Native采样发布。只上传新mip，不重传tail；首帧保完整coverage依赖，不再全材质无预算提升。full容器/replay内存与fullGPU分配明确不变，不偷塞partial Product或VT。
- 建立first-completed/纹理full/geometry target/VSM有效和view-settled epoch，替换空settled，capacity-limited不算完成；普通相机运动/cut、sun/scene变化重新refining。Bistro显示真实数据，GPU等待/CPU编码/IO/ready/publish/VSM分开统计。
- 删除旧逐页stream调用、completion直接发布、asset-version全实例流送damage、首帧无预算promote、伪压力与空settled的生产依赖；外部provider信任验证与已完成effects不退役。必要时同步其他直接Cooked consumer，不能只修demo特例。
- 集中验证后按设计逐段对：依赖→读取/worker→receipt→隐藏槽→帧发布→coarse handoff→damage→dirty页完整commit→Surface/MASK→mip/replay→收敛；只更新已发生的domain事实和粗模块结论。

## 2. 轻量必要验证

开发按需typecheck/小测试；单元末集中执行受影响contract、必要build和GPU。只添加少量语义case，不写逐行镜像测试、源码字符串检查或新重型evidence机制。GPU作业串行，不每patch跑整个Bistro。

| 范围 | 最小可解释覆盖 |
|---|---|
| 发布与生命周期CPU | 一个小Product，两次批次；hidden不出现在已提交resident状态、abort→retry、late generation拒绝；retire等待旧fence；共享页/多父coarse关系与两实例damage，不截断u32身份 |
| Worker/IO CPU+真实worker | 一次邻接Range合并与一个不应合并的优先级gap；几何CRC/结构/numeric损坏，texturehash损坏；transfer后detach与本地品牌，cancel/worker重建后descriptor注册、结果credit释放。复用既有pool/source tests，不建大随机矩阵 |
| VSM小GPU语义fixture | 页到达替换coarse且新group bounds更小；离屏caster；两个细页同batch union；一页budget跨帧保dirty；fine/coarse同时失效不采stale；pair显式溢出仍完整或明确失败；普通transform/MASK变化仍失效。与一次完整无budget结果在最终收敛后核对depth/visibility，不只看计数 |
| Texture/首屏 | 代表性opaque+完整coverage材质；粗到细区间只传一次，abort重试不提前暴露mip；首帧必要PSO未ready保loading，内容更新不重复PSO编译；两alias同payload不同sampler/UV保持。一次release/device恢复路径可复用相关fixture |
| 真实Bistro | 同原模型、视角、尺寸、最终quality，AO/SSSR保持原默认；正常完整启动到真实view-settled后短暖帧，加一次移动/恢复。记录首帧、交互回调间隔/提交帧间隔、需求收敛、IO span/worker busy、GPU VSM分位与资源峰值；UI可信度与画面要核对，不能只测partial roots |
| 必要编译 | 单元末受影响typecheck；production闭合一次engine build、新鲜build:test和相关contracts；demo只跑targeted Bistro typecheck。文档改动跑docs-verify。本轮设计不运行生产build/GPU |

Bistro至少保留一次原配置基线与一次新配置完整运行，条件相同、串行GPU；冷/热缓存标记，不以一个短窗口保证二分钟长尾消失。已有诊断可用于选择case，但错误`vsm_enabled`off窗口不能当证据。未提供GTX1650Ti测试设备就如实没有4GB真机证明；同设备做descriptor上界/峰值检查不冒充4GB性能。

本模块是优化，需要同条件观察启动/持续卡顿是否改善，但不建整Renderer ABBA/正式claim门槛。不得以放大并发后更快读完、但画面卡得更厉害宣称成功；不得以延迟无限发布换稳定FPS；总目标/质量必须最终收敛，容量不足有明确limited结论。最重单页超过软预算、fallback可见变化和CPU/GPU保留内存是必须记录的限制。

## 3. 设计轮检查与停止点

2026-10-15已核读实际Cooked加载、OEGPACK批读取/校验、Product品牌、worker池/取消、residency上传/地址发布、frame事务、shadow全域SSE0、receiver粗覆盖、VSM损坏/失效/光栅和texture完整Product/minMip消费。成熟参考及规范已固定在设计与porting短映射；没有新shader/Worker实现、没有修改production行为。

文档验证结果在完成后追加本节，不把文档通过写成算法或性能完成。下一步只有用户授权实施后才开始INIT-1；不自动跨到Local Probes、VT或页面物理ABI重构。

设计轮已执行：`node --test tools/tests/document-system.test.mjs` 7/7通过，`git diff --check`通过；`vibe context`对geometry streaming返回本轮唯一authority一对，`vibe doctor`无errors/warnings且registry一致。全库及changed `docs-verify`均仍有既有1个finding：Git忽略的`docs/status.generated.md`缺frontmatter，以及81条historical warnings；本轮没有新增finding，未修改生成状态文件来掩盖该结果。仅文档/导航改动，未运行production build、GPU或新性能测试；前述启动与对照数字保留原诊断条件，不当作新方案收益。
