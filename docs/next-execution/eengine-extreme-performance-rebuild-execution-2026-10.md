---
id: eengine-extreme-performance-rebuild-execution-2026-10
state: current
verifies:
  files:
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/material/ExactAppearanceDag.ts
    - OEngine/src/material/AppearanceClosurePlan.ts
    - OEngine/src/gpu/GpuAppearanceDagAbi.ts
    - OEngine/src/gpu/GpuAppearancePublication.ts
    - OEngine/src/gpu/GpuSurfaceWorkAbi.ts
    - OEngine/src/render/surface/SurfaceWorkRuntime.ts
    - OEngine/src/render/surface/SurfaceFrameResources.ts
    - OEngine/src/shaders/surface_work.ts
    - OEngine/src/shaders/surface_work_geometry.ts
    - OEngine/src/shaders/surface_work_lighting.ts
    - OEngine/src/shaders/surface_work_reconstruct.ts
    - OEngine/src/debug/SurfacePhaseTiming.ts
    - OEngine/src/debug/GpuTimingCost.ts
    - OEngine/src/framegraph/FrameGraph.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/tests/oracle/surface-work-gpu.mjs
    - OEngine/tests/oracle/surface-coverage-value-gpu.mjs
    - OEngine/tests/unit/surface-v3-timing.test.mjs
    - tools/gpu-oracle/registry.mjs
    - OEngine/package.json
---

# EEngine 现有渲染器性能重构执行计划

修订：**SURFACE-2026-10-07-R4**。依据：[设计母稿](../next-design/eengine-extreme-performance-rebuild-2026-10.md)、[来源账本](../porting/next-renderer.md)、[根AGENTS](../../AGENTS.md)。源码审查快照为 **`d16cc1d6`**；本次只重构文档与必要导航，不修改生产源码，不将文档通过当实现通过。

阅读顺序：§2当前事实 → §3当前C任务 → §1开发/失败规则 → §4–6后续具名责任 → §7检查入口。历史实验移至[归档](../archive/eengine-extreme-performance-rebuild-r3-execution-2026-10-07.md)，不再排列在当前执行路线中。

## 1. 开发与收口合同

### 1.1 切换单元

单元包含producer、GPU产品、全部直接consumer、binding/reset/capacity、失效、提交/中止、退休和完整direct恢复。保持一条production renderer、FrameGraph和主frame submit；不恢复retired owner/adapter，不加本帧GPU→CPU→GPU控制或功能独立submit。必要consumer随producer前移，不等后续阶段返工。

### 1.2 实施节奏

1. 读当前source/owner和母稿边界，列实际问题、保留项、切换范围、独立预期及三条不变量。
2. 固定范围持续接通完整生产链；调试按需要typecheck/build/最小targeted，不每patch跑GPU成本或全仓门禁。
3. 链连通后集中一次typecheck、production build、新鲜build:test、必要CPU合同与真实GPU正确性/接线/结构/成本检查，GPU作业串行。
4. 修已定位的编译/数值/覆盖/生命周期错误，重跑原例和受影响回归；未关闭必需项保持未完成。
5. 同质量全成本失败先审closure/工作域/重复窗口及执行税，再决定完整方案；不反复换identity/stride/容量/局部ALU来导航架构。核心链闭合后的热点优化也须有明确假设与有界范围。

### 1.3 完成状态与不变量

“架构接通”“本范围正确性/结构通过”“净收益通过”“正式整体验收”分别记录。A0/A1组件通过不外推整帧；B1更新域成功不外推空间纹理；C命中不等于收益。A/B/C三不变量统一见母稿§3.1，每单元按真实范围核命令、全部管理成本和OFF完整direct。

<a id="14-测试可信度失败修复与阶段完成规则2026-10-05-补齐"></a>

### 1.4 测试可信度、失败修复与阶段完成规则（2026-10-05 补齐）

1. 收口逐项核真实producer→产品→全部consumer，正常/边界/失败、独立预期、实际工作与成本；必需项无consumer/遗漏/未测不能改名可选或后移过关。
2. 调当前生产入口、生成WGSL或真实GPU链，证明目标分支执行。mock仅验协议；源码regex、归档shader、小fixture或预填正确结果不证明算法完成。Lighting须有效非零provider，cache/coarse须普通合法成功和局部拒绝，不能永久fine/miss。
3. 正确性与成本分开：完整身份/失效、独立closure、发布前后、pin/generation、同key唯一Store writer、互斥完整写域；真实eval/query/ref/witness/proof/hot-cold产量、allocation/编码/计时覆盖按所声明方案核。声称删除的工作必须实际消失，容量减少不等于收益。
4. 保存原始失败→最小复现/核预期→区分生产/旧ABI/fixture-harness/环境/未完成runner→局部修复→原例及关联回归。无法定位仍未通过，绿色复跑不追认修复。
5. 不删/skip必需断言、吞异常、放宽容差、缩小最终场景、关feature、永久fine/residual或添加测试专用production fallback。旧测试仅迁移退休形状，有效数学/语义断言保留；不为mock缺API重建生产owner，不在热consumer加重复decode/guard。
6. 修改预期给出设计/来源/独立数学依据；功能/质量/误差/必需范围变化先取得用户认可。回归须区分缺陷与正确行为；缺旧版复现时记录限制，用独立参考或fixture受控故障验证敏感性，不加生产故障开关。
7. 最终source变动后刷新受影响验证；source/build/oracle身份和未运行项明确，不能拼不同快照。timeout/skip/不可用timestamp单列，零API错误不代替数值/覆盖断言；实现、正确性/接线、结构/成本同时满足才收口。

以上是单元收口责任，不是逐patch的clean revision/evidence/claim许可系统。正式browser/质量/历史收益留整体阶段；真实编译失败和当前必需缺陷仍及时修复。

## 2. 当前事实与开放责任

| 单元 | `d16cc1d6`及既有证据能支持的结论 | 当前限制 |
|---|---|---|
| A0 测量 | 有界计时/异步读回、实际命令和物理live/retired账已建立并核对 | C新pass未完整进入Surface分类小计，见§2.4；不能据旧范围称当前统计全部完整 |
| A1 FrameGraph | compiled resource events、版本依赖、晚绑定/abort/fence已有实现与组件证据 | 不是整个renderer GPU性能验收；新增consumer仍需核接线 |
| B1 工作域竖切 | GPU更新级贵查询→uniform refs→fixed/General→原consumer；真实查询不随覆盖重复 | 当前Showcase主要空间查询仍pixel-rate；最小机制通过不证明主要场景收益 |
| B2 全面接线 | WorkPlan/需求、值版本、驻留、六signal/TemporalFacts与consumer已有接线 | 正确性退出未通过；NUM-001/002按用户决定暂缓，见§2.2 |
| C 可选复用 | 精确cache与独立signal history链存在；双角色原signal buffers/OFF/预算已有接线 | 净收益未通过，最终源码未集中验证；当前active，不进入D |
| D/E/F | 已有Geometry/Lighting/Temporal系统保留 | 本轮单元未推进；具体责任见§4–6，不等于整套功能尚未实现 |

### 2.1 已有交付与证据范围

**A0/A1**：原集中核对包括typecheck/build/build:test、53项相关CPU测试、报告聚合12项、真实GPU timer/FrameGraph生命周期与Lighting数值链。execute不再逐node扫registry，物理身份/晚绑定和queue fence得到验证。旧Surface基线存在严重管理成本，但短采与后续条件不同，不计算历史speedup。完整原记录见[归档H.1](../archive/eengine-extreme-performance-rebuild-r3-execution-2026-10-07.md#h11-原51-a0a1-实施核对2026-10-06)。

**B1**：`c8c5d412`交付的最小链有90项CPU、Surface73组/Geometry66组及DAG64组等记录。完整资源坐标/CXY uniform时，覆盖扩大仍只一次查询；参数/资源/帧/abort按实际版本更新，原Product过滤/General读者得到真实消费证据。具体source/build边界见[R3原§6.11](../archive/eengine-extreme-performance-rebuild-r3-execution-2026-10-07.md#611-当前源码与开放责任2026-10-07-b1集中核对)，不外推当前最终快照全部通过。

同快照Showcase为25材质/300字段：200 update、100 cheap-sample，uniform resource query为0，每材质一个空间纹理查询。固定视图681,012可见像素对应681,012次sample查询，主要纹理工作仍逐pixel；32.84% coverage、4帧短采的Surface P50 13.83ms、command span P50 24.71ms没有温度/clock控制，不与其他覆盖/历史相减。原报告`.local/r3/b1-showcase.json`。

**B2**：`cfa7b3c4`保存值版本/消费及暂缓缺陷；`764af47b`完成C来源边界与闲置owner清理；`d16cc1d6`保存C实现和成本方案快照。B2历史集中/最终捕获结果分别保存，后续绿色用例不关闭下面两项原始失败。

<a id="611-当前源码与开放责任2026-10-07-b1集中核对"></a>

### 2.2 未关闭正确性问题与用户例外

| ID | 原始失败与输入范围 | 修复/推进状态 |
|---|---|---|
| B2-NUM-001 | `.local/r3/b2-chain-debug4.json`：General参数更新/abort重试后roughness实际0.2757329643，独立预期0.2333125621；同production指纹后续复跑曾通过 | 根因未定位、未修复、B2未通过。恢复时追参数上传→dirty→GPU更新→General读取→submit/abort，不先归driver |
| B2-NUM-002 | `.local/r3/b2-coverage-debug2.json`：固定资源更新路径参数重试后稳定帧HDR `(0,0)`通道0实际0.99951171875，预期1.4979037235540191，无API错误 | 根因未定位、未修复；不能凭相似签名断言与001同根 |

用户2026-10-07明确要求“先标记记录、暂缓修复、提交代码、开始C”，仅授权这两项在未修复状态推进C，不更改算法、质量、容量/覆盖合同，也不等于B2通过。正式整体验收/claim前必须关闭；原断言继续执行，不skip、不用cache遮蔽。C复现原失败时单独报告，不恢复无限复跑。

原production指纹/失败分类和后续结果全部保留在[R3记录](../archive/eengine-extreme-performance-rebuild-r3-execution-2026-10-07.md#b2-当前接线与收口限制2026-10-07)。本地回放`.local/r3/b2-unclosed-source.zip`及`b2-unclosed.patch`不补称找回了首次失败全部输入。C的`.local/c-repair/surface-fused.json`保存002相似签名，仍未关闭。历史D3D12 OOM未定位记录也保留，不把成功复跑称修复；相关owner寿命在受影响单元核对。

### 2.3 C实现与成本证据

| 当前实现入口 | 已有接线 | 未满足责任 |
|---|---|---|
| `AppearanceClosurePlan`、`GpuAppearanceDagAbi` | 完整key描述、扣除sibling依赖的候选；按exclusive权重/key宽度选择一个输出field | 仅候选权重，缺实际成本profile；内部昂贵子图切断未建立 |
| `surface_work::surface_closure_request`及cache WGSL | key/probe→请求→nomination→unique miss→resolve→publish，direct失败恢复 | lookup前仍完成domain Geometry；每像素先probe再争quota；实际有收益类别未证明 |
| `SurfaceWorkRuntime`、`SurfaceFrameResources`、Lighting | 原signal buffers双角色，owner recipes、提交/abort、OFF、active/retired预算 | 最终源码六signal/失败/净成本集中检查；history在Appearance之后，不能解决已执行材质成本 |
| `surface_work_geometry` | 最后一次UV局部memo仍在提交快照中 | 尚未验证，不继续围绕该尾部微调 |

主要原报告`.local/c-repair/cache-cost-production.json`的production source SHA256为`1ee444f0f49051631c1417a49d70de5b37b7cf4a6c6115885020da31accb3b82`，不是当前完整快照验证：

| 同1080p closure-cache夹具，详细计数关闭 | 全部Surface pass sum | 限制 |
|---|---:|---|
| direct两帧 | 27.540 / 27.382ms | 非正式P50/P95、非frame span |
| cache首个计时帧 | 60.932ms | 前面已有diagnostic cold，不是严格空Store冷启动 |
| 再8帧预热后的cache重复帧 | 59.475ms | 明确负收益，不能称性能通过 |

同报告独立详细诊断帧：2,072,520目标、1,184,706 hits、1,486 unique、880,134 rejects、7,680 requests、881,620 sample queries。不能冒充计时帧同步测得的counter。诊断关闭native命令direct/cache为40/68，active物理字节438,085,360/521,415,664，key 7 words、Store 1,048,576 slots。结构有界/不超768 MiB不替代净收益；key scope含overflow direct，不全称lookup税。

`.local/c-repair/cost-lookup.json`旧快照Generic direct重复帧中Geometry/Appearance 81.19ms、Lighting 8.96ms、Surface总97.13ms。仅说明该夹具主要成本在history之前，不能作为Showcase或当前性能结论。实际Showcase与该合成复杂图分别用于适用性和能力核对。

cost oracle的`status: passed`只有其正确性/覆盖/固定命令断言含义，没有净收益断言。早期203组GPU/32项CPU及typecheck/build结果属于不同source；`d16cc1d6`提交未重跑最终构建/GPU矩阵，不拼历史通过。提交时docs-verify/diff检查通过只证明文档/差异合同。

### 2.4 最新只读审评：计时分类遗漏

用当前`SurfacePhaseTiming::classifySurfaceTimingPhase`重汇总上述已有报告：direct全部/分类Surface均27.382ms；cache全部Surface59.475ms，但分类小计14.647ms，44.827ms留在unclassified。未覆盖label为`Surface/closure key inputs`、`exact closure nomination`、`exact closure arguments`、`unique closure evaluations`、`exact closure publication`。

原始时间未丢，59.475ms负收益结论有效；`GpuTimingCost.surfacePassSumMs`及管理/求值分项尚不能证明C全成本。rate融入Lighting也不能仅凭pass label把其中管理全部算求值。该发现来自当前CPU分类函数与已有报告，没有新GPU运行或最终源码验证。修复责任为下节C-0。

## 3. 当前C：先补设计输入，再完整切换

目标：保持完整direct基础，在真实可重复且有净收益的域上启用精确cache/history。当前实现保持冻结以供审查，不继续身份/stride/容量/局部数学候选循环；§2中的已定位测量接线问题与必需正确性调试不受冻结禁止。

### 3.1 真实工作负载与准入决策

| 已有入口/类别 | 已知边界 | 用途 |
|---|---|---|
| Standard/glTF与当前Showcase | factor、vertexColor、normal/ORM/coat、空间查询；共享ORM不能按输出field重复计收益 | 主要场景成本基线、cheap/shared/direct与质量回归 |
| 已合法绑定的cooked Product | 完整identity与原过滤；stale恢复source | 保留产品入口，不再套通用cache；验证真实非恒定消费 |
| 原Generic夹具 | retainedQueries跨baseColor与coatNormal坐标共享 | 完整General/CXY/存活能力与共享依赖负例 |
| 24次sin＋texture缓存夹具 | 协议hit/miss/失效可测，全成本已负收益 | 保留正确性和准入拒绝反例，不增加运算制造正例 |
| 实际贵独立closure/内部子图 | 资产、consumer、重复窗口尚未选定 | C当前必需设计输入，不写成已完成 |

每个真实候选记录：资产/入口、完整依赖与全部consumer、被删除和仍必需的heavy/query、address/remaining Geometry masks、完整K/V宽度、重复/失效分布及有限W窗口、最坏requests/Store/retired字节、direct恢复、独立数值预期。同时记录便宜/高熵/full-miss的拒绝条件。

在取得这些输入后对照两种执行选择：保留分阶段unique miss的精确协议，或在原求值边界读取hit并按原direct填充缓存。按完整发布/唯一writer/WebGPU能力和全成本选择，不预设后者可直接在单dispatch原子发布多word值。本修订只保留合同，尚未锁定新工作域/预留算法。无可行普通合法类别时如实报告设计假设失败，不把永久direct当C完成，也不擅自降低质量换方案。

### 3.2 固定依赖顺序与完整切换范围

以下是C内部责任，不是新增阶段，也不要求每行单独benchmark/commit。

| 顺序 | 实际问题及owner | 可审查的交付 |
|---|---|---|
| C-0 补齐成本口径 | `SurfacePhaseTiming`/`GpuTimingCost`及报告consumer；§2.4新增label与融合scope | 全部Surface时间可追溯；未知保留，分类不漏总量；含direct的scope不伪称纯管理 |
| C-1 固定真实候选 | `ExactAppearanceDag`/`AppearanceClosurePlan`/`GpuAppearanceDagAbi`/publication；§3.1清单 | 候选、完整相等与实测准入分开；明确shared/residual/内部边界；给出可证伪假设，不先要求尚未实现方案的GPU通过 |
| C-2 确定域与完整容量 | 已有Surface work/args、runtime、容量owner | 明确选定执行组织、域大小/重复窗口/请求和Store工作集、准入与失败边界；可判断的拒绝在key前direct；不能留下“后面再调槽数”作为方案 |
| C-3 同切producer与全部consumer | `surface_work_geometry`/`surface_work`/cache WGSL/runtime/publication | 最小address→lookup→剩余需求union；hit少做声明heavy，其他dirty不漏；immutable请求/唯一writer/原结果读取；跨dispatch值、pin/generation、abort与retire完整 |
| C-4 history与交互收口 | 当前双角色signal owner、Lighting/rate/Reconstruct、capacity/accounting | 六RGB/state/recipe、provider/version与owner一致；OFF真实移除；full/partial/newly-visible/coarse转换和峰值完整；不恢复全屏复制writer |
| C-5 集中检查 | 上述完整链与§7入口 | 同一最终source/build下正确性、结构/成本和三不变量闭合；cache/history/spatial单独通过再测combined |

C-1/C-2未决项由源码/实际工作负载审查解决，不继续换表示试毫秒。C-3/C-4持续编码至真实链闭合后才集中GPU成本；过程中修编译与最小正确性失败。已有B2例外仍只限NUM-001/002，新缺陷不自动获得暂缓。

### 3.3 C出口与停止条件

被准入的普通合法类别在声明W窗口内，全部附加管理小于实际省掉计算，配对完整Surface有正净收益，数学/覆盖不变；cold税和盈亏平衡窗口单列。时间波动无法区分时标未证实，不放宽断言。未准入类别在key前direct，其管理税不能由其他类别抵消。

history独立证明有效非零Lighting工作减少及全成本，cache独立证明真实有收益成功，spatial证明合法共享/局部拒绝与质量，再核combined交互和768 MiB完整峰值。OFF同数学且同量级，零/tiny/满可选容量完整恢复；命令由有限profile决定。没有普通合法收益、漏consumer/目的地、重算hit或必需未测项，C保持active。

成本反例按母稿§1/§6分类为无重复、独占收益不足、key/请求/维护过重、分阶段重复、必要计算或执行税。只有明确改变根因的完整方案才能再实施；不继续同类局部候选直到“某次绿”。正式目标场景历史收益仍按§7.3，局部出口不等于最终FPS。

## 4. D — 几何缺陷清单，不重建整套Geometry

保留`FrameGeometryArena`/`FrameGeometryVertices`、原source/resident completion、hierarchy/SSE与HZB owner。开始时逐项核当前source，已满足项保留并验证；未满足项才建立具体切换。

| 责任 | 核对入口与实际改动 | 独立退出依据 |
|---|---|---|
| D-1 树深/LOD/完整work | hierarchy/view与virtual Geometry工作生成、实际arena/source输入；不照抄历史固定轮数缺陷 | 深树、near/far、page miss、零/多runtime、容量边界不丢可见工作 |
| D-2 普通motion与cut/保守遮挡恢复 | `RendererCore`相机变化/HZB失效、current-HZB late recheck与实际FrameProgram接线；核默认profile | 移动/新显露不误遮挡；稳定/移动tested/accepted/work与成本分开，不靠每帧cut代替正确恢复 |
| D-3 按consumer的共享属性与caster需求 | FrameGeometry输入/完整prepared发布/resident恢复；camera-visible和light-space caster消费者 | full/partial/zero准备、镜像/退化/LOD/deform与屏外caster完整，binding/retired合法 |

D不要求再做一个Geometry owner；primitive setup等局部性能候选只有实际热点和独立数学依据后才选。若D缺陷阻塞当前Surface consumer，其必要修复前移，不能留到整体验收。

## 5. E — 光照工作生成与具名阴影缺口

保留原BRDF、light记录、环境/太阳provider、cluster及VSM资源owner。现有`light_cluster.ts::main`逐cluster遍历`input.written`，overflow有完整active-list fallback，不能误说截为128丢灯；本单元改变实际工作生成和极端成本。

| 责任 | 需要核实/改变的链 | 独立退出依据 |
|---|---|---|
| E-1 影响范围工作 | 光源bounds→count/prefix/fill或固定完整donor的层级方式→原cluster/Lighting消费者；源选择在实施前完成 | 多灯范围覆盖、极端overlap、overflow仍包含全部实际灯；assignment与shade成本分别核，不以color-zero早退过关 |
| E-2 页与sampling产品 | VSM sampling/pageConstants的真实producer、页完成→commit→sampler，light-space caster、generation/dirty/容量fallback | 非零阴影、移动灯/屏外caster、dirty拒绝、完成页发布及coarse/retry完整；历史“缺producer”逐项确认，不当既定已复现 |
| E-3 已启用功能支持 | 当前point/spot/directional实际production入口与资源；历史stub重新核验 | 实际启用功能有完整producer/consumer，未支持功能如实列出；不能返回1.0或关闭已启用阴影冒充完成 |

替换算法保留源关键分支与失败行为，不把现有全部Lighting视为待重写，也不在本单元无条件加入SSGI/ReSTIR。provider接线影响Surface正确性时随producer前移。

## 6. F — 时域/后处理集成与实际失败修复

保留TemporalFacts、FSR3、曝光/颜色、Atmosphere LUT、Sky/Aerial、Bloom/Present。F主要是新产品接入后的整体数值与寿命核对；没有失败或明确热点的系统不改。

| 责任 | 核对范围 | 退出依据 |
|---|---|---|
| F-1 单次frame facts/事件 | motion/jitter/depth/identity/exposure，cut与普通运动、内容/LOD/residency变化 | 当前生产连续帧与新显露接受/拒绝正确，不补填历史identity |
| F-2 独立history角色 | signal、denoiser/现有算法history与FSR各自validity/read-write；submit/abort/resize/device replacement | 合法角色交换、失败不提交、fence退休；不新增通用history coordinator或多重平滑掩盖错误 |
| F-3 radiometry与Post | 原HDR、reactive、AO/颜色/pre-exposure/大气合成顺序、FSR 1:1/upscale profiles | 独立数值与组合回归；不靠clamp改数学，不因后处理名字多就默认重写 |

B2-NUM-001/002及其他必需缺陷在正式验收前关闭。未来算法仅沿用真实产品边界，不为尚无consumer的输出分配资源。本单元通过不等于所有planned providers或整Next已完成。

## 7. 集中验证与正式验收

### 7.1 每个切换单元必须覆盖的证据

| 证据 | 必需范围 |
|---|---|
| 数学/接线 | 当前fixed/General、共享祖先、CXY/嵌套查询、normal/coat/guard、非恒定Product、有效provider、原HDR/曝光/AO；独立预期与真实producer/consumer |
| 边界/失败 | 空/奇数extent、碰撞/weak CAS、每pool零/tiny/满、局部拒绝、参数/内容/route/geometry/LOD/view失效、abort重试、generation、resize/退休；逐目标唯一最终写域、无stale/唯一Store writer |
| 工作/容量 | covered/heavy/query/value read、actual miss/dirty、guides/continuation、真实clear/copy/alloc与active/pending/retired；声称省掉工作真实消失，完整fallback和16 binding/协商limit/768 MiB合法 |
| 全成本 | 同质量direct/cache-only/history-only/spatial-only/combined；cheap/shared/贵重复/高熵/full-miss及有限cold/warm窗口；生产计时与详细计数分开，总量含未分类/维护，unknown不填0 |

当前计时不能证明register/spill、driver stall等未观测根因；必要计算与本地执行税可能并存。旧ABI/形状测试迁移，不恢复旧owner；原数学/覆盖/生命周期断言保留。

### 7.2 当前检查入口

```powershell
# owner导航，不是许可门禁
node tools/vibe.mjs context OEngine/src/render/surface

# 完整单元连通后集中执行，按实际范围选必要targeted
npm --prefix OEngine run typecheck
npm --prefix OEngine run build
npm --prefix OEngine run build:test
node --test OEngine/tests/unit/appearance-work-plan.test.mjs OEngine/tests/unit/appearance-typed-tape.test.mjs OEngine/tests/contract/appearance-closure-plan.test.mjs OEngine/tests/contract/appearance-closure-cache-capacity.test.mjs OEngine/tests/contract/surface-frame-resources.test.mjs

# GPU作业逐条串行，按单元选用，不每patch全跑
node tools/gpu-oracle.mjs --list
node tools/gpu-oracle.mjs appearance-exact-dag --json
node tools/gpu-oracle.mjs surface-work --json
node tools/gpu-oracle.mjs surface-closure-cache --json
node tools/gpu-oracle.mjs surface-closure-cache-cost --json

# 文档改动检查；不证明源码/性能
node tools/docs-verify.mjs
```

测量入口另有`tests/unit/surface-v3-timing.test.mjs`、`gpu-frame-timing.test.mjs`；FrameGraph有`framegraph-executor.test.mjs`及`framegraph-lifecycle` GPU oracle；驻留/alpha双消费见`surface-coverage-values` GPU oracle。先查registry/实际入口，未注册/未运行/不可用如实列出。cost oracle目前无净收益断言，C-5须补独立收益判据，不能只依赖CLI status。

### 7.3 整体验收

全部主要架构及计划中的providers完成后才运行正式browser matrix、连续质量、resize/cut/device loss、材质/场景/光照组合、目标硬件GPU P50/P95与固定历史checkout比较。条件包含相同feature/camera/extent/browser/warmup与温度/clock，frame span/pass sum/CPU encode/queue completion不互换，分项P50不相加。

历史基线角色不得混用：根规则保留`14c17078`为重构前基线；旧诊断常引用`09449d6d`。正式比较前固定其source/场景/功能角色，不拼不同baseline。证据/claims及`verify --full`留此范围。所有未关闭数值/OOM/未测功能逐项报告，不因阶段名或文档修订消失。

## 8. 历史与章节迁移

当前事实集中在§2，当前C实施在§3，后续D/E/F在§4–6。母稿不复制本页状态；workstream只维护currentSlice、goal、nextModules、architectureRules、deferredValidation。

| R3旧入口 | R4当前入口或追溯位置 |
|---|---|
| §5.1 A0/A1记录 | §2.1；完整原证据在归档H.1 |
| §6.11 B1/B2事实与暂缓 | §2.1/2.2；旧锚点保留为导航，不沿用旧任务 |
| §8 C及§8.1–8.3 | §2.3/2.4事实、§3实施、§7集中检查 |
| §9/10/11 D/E/F | §4/5/6具名缺陷与集成责任 |
| 附录H及R1/R2实验 | [R3历史执行快照](../archive/eengine-extreme-performance-rebuild-r3-execution-2026-10-07.md#附录-h-历史快照与实验原文仅追溯)；全部原文/失败/source限制保留 |

<a id="64-实施与复审核对2026-10-06"></a>

旧来源账本指向本页的R1历史锚点现只作[归档H.2追溯](../archive/eengine-extreme-performance-rebuild-r3-execution-2026-10-07.md#64-实施与复审核对2026-10-06)。固定来源仍以[迁移账本](../porting/next-renderer.md)为准，本次没有新算法实施/来源adoption/正式性能claim。
