---
id: eengine-extreme-performance-rebuild-execution-2026-10
state: current
verifies:
  files:
    - OEngine/src/render/surface/SurfaceWorkRuntime.ts
    - OEngine/src/shaders/surface_work_geometry.ts
    - OEngine/src/shaders/surface_work_reconstruct.ts
    - OEngine/src/gpu/GpuAppearancePublication.ts
    - OEngine/src/gpu/GpuSurfaceWorkAbi.ts
    - OEngine/src/material/ExactAppearanceDag.ts
    - OEngine/src/shaders/appearance_exact_dag.ts
    - OEngine/src/render/FrameGeometryArena.ts
    - OEngine/src/render/FrameGeometryVertices.ts
    - OEngine/src/framegraph/FrameGraph.ts
    - OEngine/src/framegraph/GPUFrameTiming.ts
    - OEngine/src/gpu/SurfaceDiagnosticsAbi.ts
    - OEngine/src/debug/GpuTimingCost.ts
    - OEngine/tests/unit/framegraph-executor.test.mjs
    - OEngine/tests/unit/gpu-frame-timing.test.mjs
    - OEngine/tests/contract/frame-program.test.mjs
    - OEngine/tests/oracle/surface-work-gpu.mjs
    - OEngine/tests/oracle/surface-coverage-value-gpu.mjs
    - OEngine/package.json
---

# EEngine 极致性能重建执行计划：架构切换与集中验证

修订：**SURFACE-2026-10-07-R3**。依据：[设计母稿](../next-design/eengine-extreme-performance-rebuild-2026-10.md)、[固定来源与迁移账本](../porting/next-renderer.md)、[根 AGENTS](../../AGENTS.md)。当前实现、检查与开放责任只维护于§6.11，历史结果留在附录H。

阅读顺序：§1开发节奏 → §2阶段关系 → §6/§7当前B1/B2交付 → §6.11当前源码与缺口。附录H保留A0/A1、R1/R2快照和原始实验/失败，均只供追溯，不能继续按其中旧任务执行。SD是设计责任，S是GPU语义数据流，B1-xx/B2-xx是单元内任务；执行阶段只有 **A0 → A1 → B1 → B2 → C → D → E → F**。

## 1. 范围、开发节奏与切换责任

### 1.1 单生产路径与架构推进

首要目标为GTX1650Ti、1080p复杂场景，保持完整原功能/过滤/精度与单Renderer/FrameProgram/FrameGraph/frame submit。每次切换包含真实producer、产品、全部直接consumer、binding/reset/capacity、失效与退休；无旧/新renderer桥、adapter、空consumer或GPU→CPU→GPU本帧work控制。

当前直接执行基础有复用价值，不全部推倒重写。保留数学、资产/资源owner、有限家族/完整General、Typed Tape/频率分离、程序一致work、arena与窄输出；删除已退休协调链的依赖，不为旧测试恢复旧owner。R3增加实际Appearance工作域/值引用/需求生成，避免把“全部昂贵材质逐像素算完以后再sparse Lighting”当最终架构。

### 1.2 一个切换单元的推进方式

1. 开始时读owner/source与母稿相应SD，列本单元完整producer→产品→consumer、删除边界、正常/失败行为；固定一次实施范围。
2. 持续完成该范围的生产接线。调试按需要用typecheck/build或最小targeted；允许单元内部短暂未连通，不每patch跑GPU成本、browser、全仓验证或同步状态。
3. 连通后集中运行一次typecheck、production build、新鲜build:test与必要targeted/真实GPU检查。核数学、工作量/容量、写域与生命周期，记录三条不变量在本单元范围的结果。
4. 定位并修生产/fixture/环境失败，重跑原用例及受影响回归；不重复无变化的整套矩阵。范围通过后更新currentSlice进入下一单元。
5. 核心Surface架构B1/B2/C连通后统一做Surface细节优化；Geometry/Lighting/Temporal各单元完成后再做其整体成本优化。所有主要架构与planned providers齐备后进入§13正式验收。

**禁止“试一个微小表示→跑全链→根据毫秒换另一个表示”成为阶段主路线。** 核心WorkPlan、实际需求与consumer尚未闭合时，不以Q/window/private数组、sampler路由、primitive math等收益作为阶段推进条件。编译失败、独立数值错误、漏consumer、越界、已知无界管理或必须省掉的工作仍执行，必须在当前单元修复；不能用“整体完成后再测”拖到最终阶段。

### 1.3 三条不变量与四种状态

| 不变量 | 本单元核对 |
|---|---|
| A 命令与场景复杂度解耦 | native dispatch/draw/copy/clear与有限profile；workgroups和GPU数据可随需求增长，不复制管理全链 |
| B 管理不压倒计算 | scope配对管理/求值/辅助；常量/便宜closure报绝对管理税；复用计入lookup/维护后看净收益 |
| C 关闭可选复用仍正确且同量级 | 同数学/覆盖/worker和完整direct recipe；OFF真实省掉可选维护，不关闭合法constant/uniform频率提取 |

记录“架构已接通 / 本单元检查通过 / 性能待优化或未通过 / 正式验收完成”各自证据，不将它们混成一个完成标签。单元完成仍需实现、正确性/接线、结构/成本责任与本范围不变量都闭合。数值帧时预算未批准，不自行设FPS目标；它也不应迫使完整任意图全屏dense计算先达到普通PBR毫秒才允许建设必需的工作域。

### 1.4 测试可信度失败修复与阶段完成规则（2026-10-05 补齐）

1. 单元收口对照设计任务、真实producer/产品/全部consumer、正常/边界/失败、独立预期、结构/成本与本次结果。必需缺项保持未完成，不改名为后续可选优化。
2. 测当前生产入口/生成WGSL/真实GPU链，证明目标分支执行。mock只验协议/生命周期；源码正则、旧shader、小fixture或预填正确结果不证明生产算法。Lighting有非零provider，复用有普通合法成功和局部拒绝。
3. 数值/覆盖与成本分开：完整身份/失效、独立closure、pin/generation、唯一writer/互斥写域；真实eval/query/refs/bytes/allocation/编码/计时。减少容量或counter不等于减少工作或帧时。
4. 保存原始失败→最小复现/独立预期→生产、旧ABI、fixture、环境或未完成runner分类→局部修复→原用例与关联回归。无法定位则未通过，变绿不等于找到根因。
5. 禁止删/跳必要断言、吞异常、放宽容差、关feature/缩最终场景、永久fine/miss或测试专用fallback。旧机制测试按§12迁有效语义，不为mock乱接owner，不在热consumer补重复guard，不恢复旧链/第二submit。
6. 预期变更有设计/固定来源/独立数学依据；功能、质量、误差或阶段必需范围改变先获用户认可。受控故障只在fixture，不进入production。
7. 最后源码变化后新鲜build:test及受影响验证，不拼不同快照；GPU作业串行。超时/部分报告/skip/无timestamp单列，零API error不代替结果断言。

这些是集中收口责任，不是每patch门禁。`verify --full`、正式evidence/claims不进入开发主循环。

### 1.5 性能失败如何影响设计

先将成本分为必要独立计算、未避免的重复计算、执行表示税和管理/维护税。完整direct reference用于区分必要工作与实现税，不进生产，也不自动代表完整场景理论下限。缺register/spill证据就标未知。测试失败不自动发起架构重设计；明确根因违反合同才改变相应边界，记录范围及consumer影响。

阶段结构/工作量检查不能等到F：若heavy evaluations仍无条件等于covered targets、复用命中却重跑heavy、或管理依复杂度展开，本单元架构没有完成。单元完整之后的毫秒差才用于scratch/route/packet等细节优化；同类性能候选连续失败则停止该微调方向，作一次整体架构/成本审查。

## 2. A0–F 的关系与交付

| 单元 | 架构交付 | 退出后关系 |
|---|---|---|
| A0 | 当前成本/工作量/物理内存的可信测量口径 | 只建设开发必需范围 |
| A1 | FrameGraph lifetime events/稳定物理身份/有界execute | 不建立万能scheduler |
| B1 | WorkPlan最小完整竖切：更新级贵工作、cheap direct、完整sample-dependent、真实consumer与fallback | 首次证明减少Appearance重计算，不只跑便宜closure或优化dense evaluator |
| B2 | 全部当前closure进入工作域/值读取合同，Geometry需求union、六signal与完整覆盖接齐 | 核心Surface计算架构闭环 |
| C | 在B1/B2接口上扩展有收益的精确cache/空间与跨帧复用、signal history | Surface整体成本/细节优化在完整链上进行 |
| D | 完整Geometry工作域/保守遮挡/真实树深/独立caster | 按工作域与消费需求优化几何 |
| E | 完整Lighting/Shadow影响范围、overflow/容量/dirty页 | 优化实际light/receiver/caster关联 |
| F | Temporal/Post/radiometry与生命周期统一 | planned providers齐备后正式整体验收 |

核心工作域、值引用、更新事务和需求生成在B1/B2，不全部后移C。C中的cache是条件加速，不能补救无条件逐像素执行或慢的General表示；也不能为满足cache OFF测试去掉合法频率提取。必要跨单元consumer随producer前移，完整后续算法仍由对应单元实现。

## 3. 生产边界与来源

| owner/当前源码入口 | 生产合同与直接consumer |
|---|---|
| `material/ExactAppearanceDag.ts`、`AppearanceExecutionProfile.ts`、`gpu/GpuAppearanceDagAbi.ts` | template/snapshot/export/WorkPlan→发布/更新与Surface需求；完整IR/查询/频率/成本分类 |
| `gpu/GpuAppearancePublication.ts` | 匹配版本uniform/Product/程序资源→Geometry/Appearance/其他field读者；dirty、submit/abort、内容/驻留失效 |
| `render/surface/SurfaceWorkRuntime.ts`、`shaders/surface_work.ts`及coherence生成器 | coverage/address/value resolve→实际miss/dirty work→有限worker→immutable结果→Lighting/Reconstruct |
| `render/FrameGeometryArena.ts`、`FrameGeometryVertices.ts`、`shaders/surface_work_geometry.ts` | source/frame/resident与唯一按需Geometry→Appearance、Lighting和具名guides；共用arena，不加Product第17个binding |
| `shaders/surface_work_rate.ts`、`surface_work_lighting.ts`、`surface_work_reconstruct.ts` | 六路独立signal需求/率/显式状态→原HDR合成；重建不跑完整材质/PBR |
| `render/surface/SurfaceFrameResources.ts`、FrameGraph/FrameProgram | capacity、binding/reset、active/retired与单encoder生命周期 |

旧batch/tree/proof/Winner/setup/宽Store owner仅在历史附录出现，不能称当前实现入口。SD01–SD11对应母稿；S0–S9在每单元明确产品与全部consumer，逻辑阶段不强制一pass一buffer一class。

沿用来源账本中的SF03数学、SF07有限家族、SF10编译/typed work、SF11程序组织、SF06域值参考及SF09 portable scan。本修订不提升采用、不选新完整算法、不宣称通用材质bake等价。新的资源查询频率/WorkPlan/需求合并是具名本地设计；实施完整算法前固定具体donor函数/分支/许可并更新映射，缺完整donor则记录检索范围与本地输入输出/失效/降级。不能把复杂编译算法拆成胶水豁免来源核对。

## 4. A0 — 最小测量

当前owner为GPUFrameTiming/FrameProfiler/SurfaceDiagnostics及ResourceAccounting。按同帧记录frame span、pass sum、CPU encode、未覆盖gap、管理/求值/重建；queries/readback仅异步诊断，不控制本帧work。covered targets、heavy evaluations、query数、value reads、unique miss/dirty、commands、live/retired均有单位和producer，缺接线标unavailable。

架构出口是口径可靠、资源有界、无本帧readback控制；不是全renderer性能通过。Surface新增工作域时只补对应counter，不重建全仓监控。A0原实施证据见附录H.1。

## 5. A1 — FrameGraph 执行与生命周期

compile产生resolved references及acquire/release事件，execute不逐node全扫registry；保留版本/依赖/culling/late binding和合法alias。物理owner分配/account一次，cached graph不pin退休对象，submit/abort/fence/resize/device replacement按实际角色发布与释放。

集中检查编译排程/事件缩放、同物理多版本、cached resize、失败/abort、pending retirement与真实GPU资源寿命；mock仅证明协议。必要范围通过即进入Surface，不等待未来效果框架。

### 5.1 A0/A1 记录入口

既有A0/A1实现与原快照结果保留于附录H.1，不因R3文档更新重新标为未实现或重新跑基线。后续直接consumer变更只核受影响部分；旧stride、旧Surface阶段计数不能当当前ABI。当前阶段唯一入口为workstream currentSlice及§6.11。

## 6. B1 — Appearance 工作域最小完整竖切

### 6.1 单元目标与退出边界

在现有直接执行基础上一次实现 **分类/完整依赖→更新或值解析→真正miss/dirty→唯一Geometry需求→执行→原consumer**。至少覆盖便宜直读、一个可证明更新域一致的贵查询closure、必须逐sample的完整General、已规定语义的Product读取。不是要求任意图可以少算，不以sparse Lighting计数证明Appearance减工作。

### 6.2 单元内实施任务

| 任务 | 范围与产物 | 原子切换consumer |
|---|---|---|
| B1-01 | 扩展现有execution plan为WorkPlan：依赖/频率/成本/计算域/值表示/失效/直接降级；template与数值/资源身份分开 | publication、更新producer、work builder |
| B1-02 | 更新级贵子图producer：完整坐标/CXY footprint/sampler/route/资源版本一致才提升；GPU数学与原查询顺序不变 | matching-version value refs与fixed/General读者；texture/content/page变化、abort/reset同迁 |
| B1-03 | S2/S3轻量address/value resolve在miss compact之前；cheap direct绕重协议、更新级值不分配P份heavy结果 | S4实际需求；Product遵守原filter语义，未证明等价不bake任意DAG |
| B1-04 | 独立field miss、dirtyLighting、guides/guard合并；同完整输入子图/查询共用唯一work，必要Geometry仅生成一次 | Geometry→fixed/General→闭合值/guide；不因hit漏其他dirty consumer |
| B1-05 | consumer按WorkPlan读取uniform/Product/直接indexed/选定域值；完整sample map/边界/失败目的地与binding/容量/生命周期 | Lighting/Reconstruct及当前其他实际读者；无占位consumer、重复材质或第二owner |
| B1-06 | 链连通后集中对照SD01–11：独立数值、实际heavy/reads/覆盖、命令/峰值与完整fallback | 记录本单元范围和未关闭责任，停止逐候选微调 |

对应母稿：B1-01→SD01/04/11；B1-02→SD03/04/09/11；B1-03→SD06/09/11；B1-04→SD03/05/06/11；B1-05→SD07/08/09/11；B1-06→SD10及本单元全部责任。六行是同一切换单元的接线任务，不是六轮独立GPU benchmark或提交要求。编译、真实producer/consumer、数学、容量与本范围三不变量未闭合，不能标B1完成。

### 6.3 实际减少工作与完整覆盖

在普通合法更新域fixture中，增加covered pixels只增加必要值读取/覆盖，不增加同一贵uniform查询求值；更新资源/参数后该域重新计算，稳定帧不重跑，abort不提交成功版本。同一图中仍sample-dependent的子图保持逐点原CXY，不能用常量图证明复杂图全部省略。

同时记录实际目标场景各类closure的覆盖/依赖/查询量。uniform成功不外推为Showcase所有heavy已减少；精确输入都不同的贵closure保留完整全率并单列。若主要工作仍必须全率，后续讨论明确执行表示或经认可的域采样质量决策，不用人工常量fixture宣称阶段最终性能成功。

unknown或不一致依赖进入同一完整直接worker；cold/newly-visible/residency变化不丢工作。完整Generic在fallback下所有原合法算术/UV0–2/嵌套query/moment/normal/coat/guard语义保留；direct reference贵说明必要成本，参考便宜而worker贵说明实现税，不能用相同HDR自动证明帧时可行。

### 6.4 集中检查范围

链连通后一次运行必要compiler/publication/资源合同、当前DAG数值GPU与真实Surface消费。独立预期核query输入/原CXY、版本/失效、结果/覆盖、唯一writer；真实counter核covered/heavy/value reads分开。binding16、frame/resident full/partial/zero、mandatory不足回滚、submit/abort/fence接线同核。小fixture数值与1080p结构/内存范围分别记录。

成本只作一次单元完整profile记录：相同质量的更新级/cheap/sample-dependent与cold/warm/OFF范围，列必要查询/计算、附加管理和整个consumer链。结构不符先修架构，不马上换scratch候选。无需每任务跑完整Showcase/browser/benchmark矩阵。

### 6.5 性能与架构出口

出口证明：普通贵更新级work真实不再默认逐pixel；全部sample-dependent原语义有完整入口；命令有界、管理不支配本范围计算、optional OFF正常；峰值含metadata、settings、temporary、retained、active/retired。若贵值生产仍P次或consumer补算，架构未完成。General执行代价仍须说明并进入整体优化记录，不能承诺任意全屏复杂图达到未批准FPS。

### 6.11 当前源码与开放责任（2026-10-07 B1集中核对）

当前生产源码事实以Git/source为准。B1的最小工作域链已接通并集中核对：`ExactAppearanceDag`的完整资源坐标依赖→`GpuAppearancePublication`更新producer/匹配uniform refs→fixed/General→原Lighting/Reconstruct。WorkPlan声明每个Surface字段的完整祖先、频率、查询、输入、估计操作权重、值表示、失效和完整direct降级；估计权重不是GPU计时或cache admission。template、numeric/resource snapshot和domain recipe保持分离。alpha仍由原Coverage生产，Surface不调度其独占祖先。

资源查询只有完整坐标与原CXY均uniform才进入GPU更新，原resident/Product过滤、normal/moment数学不变。每资源`currentRevision`来自TextureResidency的真实提交；immutable内容/route/asset变化沿用重新出版。参数/帧更新、abort重试、绑定、metadata/scratch容量和retire随producer同迁。更新输出直接进入palette/boundary，sample mask与Geometry闭包在work消费前排除已满足依赖，其他Lighting/guides需求仍由唯一Geometry owner生成。该切换没有新Store/coordinator、额外frame submit或质量近似。

**B1核对结果与边界：** typecheck、build、新鲜build:test和90项CPU合同通过；同最终源码的Surface GPU有73组链用例及66组Geometry边界检查，无API错误。材质级查询覆盖17×5→33×17仍只有一次实际查询，sample查询为0、真实uniform读取随覆盖增长；参数变更/abort重试/稳定帧/实际资源revision变化对应1→2→2→3次。frame-dependent查询按帧重算；空间查询保留原CXY。真实非恒定cooked Product字段经General、Lighting与重建，在复用OFF及optional容量0下对独立CPU产品过滤结果通过。完整DAG算术/嵌套坐标仍由独立GPU组件核对，不能用它代替Surface覆盖。字段值、非零provider、HDR、AO/guard等原断言未放宽。

本轮原始失败保留在`.local/r3/`：新增夹具曾错误使用不存在的`appearance_inputs.delete`、缺alpha与读错palette entry；旧packed-world夹具缺当前device/compute API且调用退休`program()`；Product线性fixture的粗mip真实超出其声明预算，改为合法较小幅度输入并收紧数值断言，没有改生产容差或质量预算。这些是夹具/接口问题，不能追认为生产性能修复。测试产物为本地诊断，不提升正式claims。

**当前Showcase实际范围：** 同源码25个材质、300个已声明Surface字段，其中200个update、100个cheap-sample；每个材质一个空间纹理查询，uniform resource query为0。1080p本次固定视图可见681,012像素（32.84%），实际sample texture query为681,012次、uniform scalar read为4,767,084次，4个帧均覆盖通过；这说明共享查询没有按ORM字段重复，但主要纹理查询仍是pixel-rate。不能声称B1已降低该场景的主要纹理工作。publication GPU占40,476B，Appearance lane scratch占344,064B，Surface transient占362,391,280B；active/retired生命周期另由owner合同核对，不把字节减少当帧时收益。

同一短采、相同视图/画质的timing模式4帧：Surface P50 13.83ms、GPU command span P50 24.71ms；paired管理2.62ms、Geometry/Appearance加Lighting计算8.65ms、重建等辅助2.23ms。没有温度/clock控制，覆盖与§6.12历史80.4%不同，禁止历史收益比较或最终验收外推。1080p独立链cost夹具保留cold/warm及reuse OFF/ON；warm管理不支配计算、OFF链正确且同量级，General仍明显昂贵。本轮记录成本而不设未授权FPS门槛。

| 责任 | 已有依据 | R3继续交付 |
|---|---|---|
| 更新/依赖 | B1更新域查询与fixed/General读者已接通；资源/参数/帧/abort见上述检查 | B2全面closure、直接读者与失效组合核对；C扩展其他确有收益的复用 |
| 工作组织 | WorkPlan驱动uniform字段mask/refs；有限profile/模板packet、indexed fallback | B2全字段/共享子图及实际需求union，删除无reader的CPU遗留 |
| Geometry/fields | 唯一局部completion、thin/guides、Product16 binding；uniform hit不重跑其heavy依赖 | B2全部guides/guard与镜像nonuniform真实Surface组合核对 |
| signal/reconstruct | 六种独立RGB/state/recipe、AO/颜色/曝光原数学 | B2完整读取合同与各signal合法成功/局部拒绝，不能以Lighting coarse证明Appearance sparse |
| 生命周期 | B1新value/update产品进入原abort/retire/容量事务 | B2组合边界；历史D3D12 OOM根因仍开放，绿色复跑不追认修复 |
| 成本 | B1普通更新域真实减贵查询；当前Showcase主要空间查询仍逐pixel | B2先全面合同，C后整体定位；数值预算未定，B2未收口，不追最终FPS |

阶段前快照已在master提交`be4d47c6`；B1源码另作连贯提交。主分支继续，不建工作分支。正式browser matrix、device replacement、长期画质与同条件历史比较留最终验收；B1不宣称这些已通过。此前source差异、原始失败与覆盖限制统一在附录H。

#### B2 当前接线与收口限制（2026-10-07）

B1已在master提交`c8c5d412`。其后B2新增的接线与集中检查如下。**B2的正确性退出仍未通过；2026-10-07用户明确要求记录缺陷、暂缓修复、提交当前代码并进入C。** 本次提交保留接线快照与未关闭缺陷，不是B2验收完成提交。当前推进单元改为C，具体例外范围见本节末的用户决策；不能把已通过用例或用户允许推进写成缺陷已修复。

| 任务/SD | 当前真实producer→产品→consumer与检查 | 收口判断 |
|---|---|---|
| B2-01/02；SD01–06/11 | 全已声明Surface字段/共享祖先进入WorkPlan；query权重按共享查询去重、normal Product属于原Product域；uniform refs/palette在sample工作前分流，剩余字段direct indexed；其他Lighting/guide仍请求唯一Geometry。无消费者CPU proof/profile、directory、fieldWords版本副本已删除 | 分类/读取接线已核；Coverage保留母稿§6.6的完整原fragment evaluator，同步参数/路由，不要求新增alpha uniform folding。下述真实GPU消费已补，不再把“没有alpha折叠”作为架构缺口 |
| B2-03/04；SD07–09 | existing metadata增加每entry两u32（scene generation/value revision）；GPU更新边界比较实际uniform值，numeric/resource dirty推进版本，耗尽到sticky 0拒绝history；没有新增binding17到Surface。normal/coat moment的实际Product过滤、局部TS→world guides、六RGB/state与原guard保留；optional OFF/0、完整目的地与原容量合同通过 | 当前范围通过；不能以版本hash作cache完整身份，也不声称C的cache/pin/generation已完成 |
| B2-05；SD08/09/11 | S0 publication前移到TemporalFacts之前，其temporary仍由原Surface scratch owner保留；TemporalFacts新增独立readonly binding17（该pass共8 storage，Surface Product仍16），读取实际value version→原mask/identity→Reconstruct/FSR。真实GPU检查稳定帧正常接受，参数/资源/abort/extent变化正确拒绝，版本0不回绕 | 当前新链通过；mandatory退出仍受下述原始数值失败限制 |
| B2-05/06；SD04/09/10 | TextureResidency暴露提交后的minimum mip；Appearance更新Surface/Coverage route的真实revision与mip clamp，abort保留route重传和alpha caster失效；只在dirty时上传，S0导入其全部有限published sets，不依赖当前active sample set。初始版本合同仍验证，旧无reader副本不恢复 | owner/路由与真实消费检查通过：当前TextureResidency上传/提交→Surface更新查询值，以及原Coverage alpha/discard→Visibility输出。不是下述数值失败的根因修复 |

B2接线检查快照指纹`a6ac895112d698d41e57cd5e39ee429f64fd6ab6929b1065a290a065c4088086`的新鲜build:test、typecheck、build、107项CPU用例、Surface119组及Geometry66组、DAG64组通过。57组Surface用例包含真实TemporalFacts历史写入/读取，没有预填正确identity或mask；非恒定普通Product、base/coat moment与镜像nonuniform实例进入真实Surface消费者。参数abort/retry/stable组合对fixed/General/frame-query各交替6轮，放在纹理red变成常量之前，保持对旧值错误的数值敏感性。GPU作业串行；后续源码变动必须刷新相应验证，不拼接不同源码结果。

**必需未关闭项 B2-NUM-001：** `.local/r3/b2-chain-debug4.json`记录General参数更新/abort重试后的真实数值失败：roughness实际`0.2757329643`，独立预期`0.2333125621`。debug5在同production指纹`41affd5cfb18b0b61b0699c2f0a937435fe78b844514bdfb49d8d0c26ca167c8`上通过；当时只改了诊断与后续测试，没有定位生产根因。后续更敏感组合与最终源码通过，仍不能追认为该失败已修复。按§1.4/根AGENTS“无法定位则如实未通过”，此责任保持未关闭，B2不得因绿色复跑收口。原始失败保留；恢复修复时追踪完整参数上传→dirty→GPU更新值→General读取→提交/abort边界，先判定生产错误还是夹具/runner错误，不试微性能候选。当前暂缓决定见下文。

本次补齐驻留消费证据：`surface-coverage-value-gpu.mjs`使用实际资产包writer/open、TextureResidency、publication、Coverage资源绑定与生产`rasterCoverageFragmentWgsl`；夹具只提供平面顶点。256纹理的mip 6尾部alpha为160/255，promotion后原mip 0–5含255/64的两半；16×16平面原梯度选择mip 4，独立覆盖预期为0→128，参数减半变0，cutoff改为0.1变256。8组提交结果、promotion/route/参数中止重试、稳定帧caster dirty恢复均检查。另在同command执行真正Surface更新查询，值从160/255变1，证明mip route确实被采样而非只改CPU字段。没有预填Visibility、没有新alpha算法；这不是完整meshlet选择/VSM调度矩阵。原4行夹具的纵向梯度实际上选择mip 6，初始预期错误；改成16行使预期LOD成立，未修改过滤或容差。缺原shader组合所需材质ABI声明的夹具编译失败也已修正，原始结果保留。

**必需未关闭项 B2-NUM-002：** `.local/r3/b2-coverage-debug2.json`在当前同production指纹上，固定资源更新路径的参数重试后稳定帧又出现Lighting/HDR错误，(0,0)通道0实际`0.99951171875`，独立预期`1.4979037235540191`；无GPU API错误。不能先假定它和旧General错误同根，也不能把两者直接归为driver问题。后续边界捕获运行通过仍不说明修复。当前oracle失败时记录实际GPU metadata的参数/dirty/uniform/palette、Geometry/字段/六signals/HDR样本及计数，利用已有readback，不增加生产GPU同步或诊断分支。最初诊断catch作用域错误已修正并保留原失败；禁止靠新诊断掩盖原数值错误。此项未关闭，推进例外见下文。

本次已刷新build:test与84项受影响CPU用例；最终`b2-transaction-capture.json`的Surface179组、Geometry66组及驻留/双消费8组通过，无GPU API错误，整次runner约18.6秒。fixed/General/frame三类参数abort/retry/stable各交替16轮（此前6轮），117组包含真实Temporal历史；这是间歇数值问题的有界回归，不是反复跑绿的收口门槛。GPU串行。typecheck/build与DAG64组沿用上段同production指纹的结果，本轮未重复；全浏览器/正式性能与历史claims未运行。绿色结果和原始失败分别记录，不声称本单元全部退出条件通过。

其他原始失败已分类：少申请`texture-formats-tier1`是oracle设备profile缺项（生产原已要求，输出格式未改）；Temporal零motion夹具的camera正/逆矩阵原不一致，已补完整互逆输入；FrameProgram用例新增S0执行顺序按真实图依赖更新。它们分别有独立依据，不与General旧值失败混为一次修复。用户已要求后续不开子agent，后续复审由同一执行者直接完成。

#### 2026-10-07 用户批准的暂缓与C启动

用户原指令：“那先标记吧记录着先，等后面我有空在修，提交代码，开始C吧按照文档”。据此仅将 **B2-NUM-001、B2-NUM-002** 标为`deferred-by-user / 未修复 / 根因未定位`，允许当前接线快照提交并推进C。用户决定覆盖本轮这两项必须先修再进入下一单元的顺序要求，不覆盖算法、质量、容量、完整fallback和唯一写域合同，也不把B2改成验收通过。

两条原始失败和后续结果均保留，现有断言继续执行；不skip、放宽容差或通过cache遮蔽失败。C遇到新缺陷仍按正常失败规则处理；已有两项复现时单独报告，不因其暂缓恢复无限测试循环。正式整体验收及性能/画质claim之前必须关闭这两项。当前源码/build、oracle和host的本地回放快照保存在`.local/r3/b2-unclosed-source.zip`，源码差异在`b2-unclosed.patch`；这些只保留当前快照，不补称已找回最初General失败时的全部输入。

### 6.12 已有成本证据如何使用

已有Showcase短诊断主要走fixed家族：1080p、约80.4% coverage、VSM关闭、8帧、温度/clock未控制；Surface约33.23ms、GPU command span约46.79ms、fixed融合Geometry/Appearance约19.86ms、Lighting约4.06ms、重建约4.26ms，管理约4.59ms。分项P50不相加；融合pass不全是材质VM，off仅关闭Surface counters而非所有profiling。该快照在后续清理/accessor前，原记录及内存账见附录H.3。

完整General夹具曾约90ms Surface、约72ms Geometry/Appearance，隔离直接参考约41/19ms；reference还有资源路由专门化且非固定clock，不把差额全归VM。Product手工过滤昂贵的组件结果不解释没有Appearance Product payload的Showcase；Geometry Product与Appearance Product分开。

private scratch、resident sampler与Prepared Triangle Math候选未取得充分全范围净收益，生产未采用；Triangle短采约0.4–0.6ms差且有回退，已撤回临时ABI/生产接线。channel冗余读取的小改动不改变逐pixel工作模型。原实验仅是问题证据，不是继续按候选列表推进的任务。本轮不拼这些不同快照成R3性能通过，不把容量下降算作帧时收益。

## 7. B2 — 全部当前 Surface 的工作域与消费闭环

| 任务 | 全面替换范围 | 必需结果 |
|---|---|---|
| B2-01 | 全当前closure/共享子图进入WorkPlan；更新级/cheap/贵稳定/贵sample类别 | 分类有完整依赖与正常支持，未知合法图直接完整执行，不全塞cache |
| B2-02 | ValueRef/SampleMap读取合同、actual miss/dirty与需求union | covered targets与heavy evaluations分开；不同field不同域/率，原destination完整 |
| B2-03 | 各optional容量0/tiny/满独立恢复；mandatory输出与binding/峰值先合法 | 发布前promotion/唯一writer/互斥coverage，失败回滚/重试；无截work或伪counter |
| B2-04 | retained Geometry/fields/guides与六RGB显式状态 | 按真实consumer保留，normal/IOR/coat guard不丢；constant/update值不做逐pixel昂贵复制 |
| B2-05 | Lighting/Reconstruct/TemporalFacts/当前history全部读取/reset/binding版本迁移 | 原六路加法分组、output-pixel AO、colorSpace/preExposure、normal/view fallback；无完整材质/PBR补算 |
| B2-06 | 删除无reader的旧协调/临时/上传/测试形状，集中核全链SD和失败组合 | 普通减少Appearance work与局部full-rate共存，三不变量及实际结构/成本账闭合 |

对应母稿：B2-01/02→SD01–06/11；B2-03→SD09；B2-04→SD03/07/08；B2-05→SD06–09/11；B2-06→SD10及全部责任。B1必要机制不再在B2重新设计解释器；B2扩展接口和覆盖。近裁剪/零负W/退化/facing、普通/Product、full/partial/zero frame准备、参数/内容/LOD/驻留失效与camera/cut/abort需当前生产链证据。Lighting各signal的共享有其独立依赖，不将material或Winner相等当全部合法证明。

B2链连通后集中编译、必要targeted/真实GPU，核全覆盖、独立数值、合法共享/局部拒绝、实际需求缩放、native命令与物理峰值。实现/正确性/结构失败先修；不依赖几十分钟全套测试做每patch导航。完整Surface毫秒优化与C机制扩展都使用这条生产链，不恢复第二路径。

## 8. C — 在既有边界上扩展有收益的复用

B1/B2已定义并接通分类、值读取、更新事务和真实需求。C按实际昂贵可重复closure扩展完整cache identity、lookup/miss、unique writer、pin/generation/retire及signal history；不另建默认宽Store，不把cache加到便宜值上，也不掩盖全miss时无界管理或General执行税。

精确cache完整比较closure/domain/实际坐标/footprint/资源/内容/动态版本；hash只定位。同domain或同material不代表值可共用。命中字段不重跑其heavy Geometry/Appearance，其他dirty consumer仍可请求唯一record。cold/冲突/容量满/弱CAS/invalid history走同一完整direct recipe。无关camera运动不失效静态值；view-dependent值按真实依赖失效。

C集中检查真实普通hit/局部拒绝、碰撞/容量/abort/新显露/失效、唯一writer与无stale消费，按同输入OFF/ON记录lookup/admission/publish/维护与省掉的heavy。完整Surface架构通过后，再一次性定位主要成本并优化相应表示；不建立每轮基于微测的重设计循环。

母稿对应范围为§6.9（已有WorkPlan）、§8（唯一Geometry/address需求）、§9（signal合法性）、§10（cache/history及具体切换边界），不是“母稿§8就是C”。以下是C内部同一切换单元的接线责任，不增加执行阶段：

| 责任 | 一起接通的producer/产品/consumer | 单元出口必须证明 |
|---|---|---|
| 选定closure及完整identity | WorkPlan→候选与全相等描述→按真实依赖的key producer；uniform/Product/direct原入口保留 | 不把估计权重当admission收益；不同UV/footprint/参数/资源/normal/view输入可独立拒绝；无关camera不清静态值 |
| resolve/nomination与实际miss | 唯一Geometry最小address→完整key lookup→pin hit refs或miss；已发布key→有界request-index nomination/actual args | lookup在material miss组织前；同key唯一writer，失败/容量0/tiny/满不漏任何原目的地；不跨组读取未发布payload |
| 生产值与全部读者 | Geometry需求union→fixed/General实际miss/direct→结果发布→Lighting/Reconstruct/value accessor；同owner维护generation/retire | hit不重跑其heavy，其他dirty仍生成唯一Geometry；Product16 bindings、完整guard/六信号、abort与OFF全部正确 |
| 独立signal history与成本 | 当前provider/Temporal版本→各signal history的实际reader/writer→Lighting/合成 | 真实合法history及局部拒绝；完整原RGB/radiometry；集中报告管理/省掉heavy/整链成本，不作最终性能承诺 |

#### C启动快照记录（2026-10-07，后续状态以§8.1为准）

前置快照`cfa7b3c4`已提交master，B2-NUM-001/002按§6.11用户决定暂缓。已核对现有WorkPlan、Geometry局部completion、publication metadata、六signal/provider版本与Temporal生命周期。精确Appearance closure cache 的 lookup、unique miss、generation/retire 与 direct fallback 已接入当前生产链；本切片又接通了六路 signal 的独立屏幕历史读写、Temporal Facts 重投影/身份拒绝、版本失效及 submit/abort 生命周期。新增真实 GPU oracle 已证明稳定帧逐字 radiance 等价、warm history 的 direct-light work 下降，以及材料局部 identity reject/reuse；这仍不把局部结果升级为 C 阶段完成，完整普通 hit/局部拒绝、全成本矩阵与 B2-NUM-001/002 的阶段收口责任仍未关闭。

启动清理删除无production/export/test class消费者的`GpuSurfaceFieldStore.ts`、`GpuSurfaceSignalStore.ts`；原ABI身份/容量数学及其oracle保留，只供数值/协议追溯，不是新缓存owner或C消费证据。两旧class原已不在生产链，删除不声称节省当前帧GPU字节或时间。后续直接在现有Surface/publication/Geometry/Temporal边界实现母稿§10.4，不恢复旧dependency/proof/cell/witness协调器。此次清理的typecheck、build、新鲜build:test、保留身份/容量数学5项及文档校验通过；未重复GPU矩阵，因没有生产GPU消费者/数学改变。完整C GPU正确性/成本检查待上述生产链接通，不标C完成。

#### C跨dispatch修复快照（2026-10-07，后续状态以§8.1为准）

1080p Generic reuse首次暴露HDR `0x7fff`，随后小尺寸完整GPU链确认guide中的NaN。根因是request完成Geometry后，其invocation-private tangent/normal/coat及残余字段输入不能跨dispatch存在；overflow虽写retained fields，后续guide仍读取了另一invocation的局部状态。修复保留单一Geometry producer：request阶段在局部Geometry存活期间完成residual字段；hit及overflow当场完成guide/guard；只有已分配的bounded miss request保存12个f32 words（tangent/sign、normal TS/validity、coat TS/validity）供resolve消费。nomination拒绝只直接求值其cached field，不用该field的key冒充全部residual输入。没有禁用多varying admission、增加全屏Geometry副本、改变材质数学或恢复第二decode。旧source-key保存/重建尝试已删除。

集中检查：typecheck、production build、新鲜build:test、closure身份/容量8个CPU合同、完整`surface-work`、扩展`surface-closure-cache`与1080p `surface-work-cost`通过。cache GPU新增Generic residual与昂贵normal TS的OFF/cold/warm逐字HDR对照、tiny overflow及单次Geometry setup断言；保留已有uniform/resource失效、局部hit/reject、abort/resize/generation和唯一writer检查。成本oracle的旧“ON只增加4个rate dispatch”断言迁移为实际有限family cache命令数，并继续核OFF不分配cache内存。测试诊断冻结对应publication引用，避免failure snapshot因后续owner恢复而掩盖原错误。此结果不关闭已明确暂缓的B2-NUM-001/002。

**C仍active，不能进入D。** 成本检查通过表示数值/重复输出/覆盖及固定命令断言通过，不表示净收益已通过。当前硬件诊断的重复帧pass时间和约为baseline OFF/ON 24.5/32.2ms、Standard 49.7/59.1ms、Generic 102.0/130.8ms；仅各两帧，不是P50/P95或正式收益。Generic的key scope含overflow direct计算，不能将整个scope解释为lookup管理税。

本次集中检查发现下一C切换单元必须一起解决的history owner缺口：`prepareSignalHistories`在reuse OFF也分配两份六层rgba32float，history writer仍运行（1080p约5.7ms）；history实际约379.7MiB未计入Surface scratch的440.3MiB及其live/retired预算，总量约820MiB超过当前768MiB合同。下一单元为history完整物理布局/容量、有效信号与coarse owner读取、OFF移除、bind/retire及全部Lighting/history consumers同切；随后核六路独立失效和净成本。不得通过少报内存、降精度、永久禁用history或提高预算解决。

### 8.1 C当前冻结记录与证据边界（2026-10-07，用户停止微调循环后）

用户要求先确定成本模型和完整切换方案，再集中实现、验证。本轮只读源码、复核已保存报告、更新方案，不修改生产代码/测试，不启动build或GPU benchmark，不提交。当前C仍active，D未启动；§6.11的B2-NUM-001/002暂缓决定不变。

上一轮偏离§1.2：净收益失败后继续调整route identity、record stride、容量、rate/history局部执行与UV memo，再逐次测成本。以下区分已有接线、旧快照证据与未完成责任；不能将历史通过拼成当前源码通过。

| 当前工作树事实 | 本轮核对入口 | 仍缺的责任 |
|---|---|---|
| history已替换为两组原signal buffers及owner recipes，Lighting直接写当前角色，提交推进角色；OFF和active/retired预算有接线 | `SurfaceWorkRuntime::prepareSignalHistories/consume/commit`、`SurfaceFrameResources`、`GpuSurfaceWorkAbi`、`surface_work_lighting` | 最终源码的六signal/owner/失败及独立净成本集中检查；不能沿用前文纹理writer作为下一实现任务 |
| cache仍是每候选目标key/probe，再以每bin quota分配request；request进入前完成整个domain Geometry；nomination/publish等阶段仍存在 | `surface_work::surface_closure_request`、`SurfaceWorkRuntime::consume`、`appearance_closure_cache` | 前置成本准入、完整域请求控制、最小address与remaining需求同切；净收益未通过 |
| 编译准入为exclusiveOperationCost与keyWords加权筛选 | `AppearanceClosurePlan`、`GpuAppearanceDagAbi::pack`候选选择 | 完整成本profile与真实重复消费条件；现权重只证明候选，没有生产准入依据 |
| 最后一次UV局部memo改动仍在工作树 | `surface_work_geometry::geometry_input/geometry_complete` | 尚未验证；作为冻结尾部记录，不计入已完成结果，也不据此继续优化 |

已保存的`surface-closure-cache-cost`报告`.local/c-repair/cache-cost-production.json`，source SHA256 `1ee444f0f49051631c1417a49d70de5b37b7cf4a6c6115885020da31accb3b82`：

| 相同1080p closure-cache夹具，详细计数关闭 | Surface GPU pass sum | 证据解释 |
|---|---:|---|
| direct两帧 | 27.540 / 27.382 ms | 同数学直接计算；不是正式P50/P95或frame span |
| cache首个计时帧 | 60.932 ms | 先前已运行diagnostic cold；不能称严格空Store冷启动 |
| cache再8帧预热后的重复帧 | 59.475 ms | 明确负收益；不能用扩大Store或命中提升宣布完成 |

同报告最后的**独立详细诊断帧**：2,072,520目标，1,184,706 hits、1,486 unique、880,134 rejects、7,680 requests，sample queries 881,620。计时帧未运行这些详细计数，不将诊断帧counter冒充计时帧实测。可观察到heavy/query减少，仍不能证明附加管理可偿还。关闭诊断的生产native命令计数direct/cache为40/68；active物理字节438,085,360/521,415,664（约417.8/497.3 MiB），key 7 words、Store 1,048,576 slots。命令有界和内存不超768 MiB只证明部分结构条件，不能替代不变量B。

报告的`status: passed`仅代表其正确性/覆盖/固定命令断言通过，**没有净收益退出断言**。未运行完整最终源码验证；早期203个GPU用例、32个CPU合同属于不同源码快照。此前`surface-fused.json`仍保存reuse OFF的B2-NUM-002相似数值失败，根因未关闭，不能只凭相似签名认定同根因。

当前没有被全成本证据支持的Appearance生产准入类别。原Generic共享queries不提供该field的exclusive收益；24次sin等合成夹具用于协议/数学敏感性，成本结果不支持准入。不得增加sin/纹理次数、改预期或用无限预热来制造有收益类别。实际合法资产/closure清单与重复窗口仍是实施输入缺口，必须在开始新缓存实现前补齐；文档不能虚构此项已完成。此处要求先有真实候选和成本假设，不要求新方案尚未实现时就出具其GPU收益；实测准入在完整切换后的集中检查形成。

本轮源码冻结清单为`.local/c-repair/c-plan-source-freeze.json`（26个已有修改/新增源码、测试和runner文件的SHA256）。它只证明本轮未继续改代码，不是clean revision、build identity或验证通过。

### 8.2 固定的C实施合同

成本定义与选定方案统一见母稿§10.5，不再另写一套权重准入。目标是保留精确数学和既有有限执行器，按实际有收益工作域进入可选协议，关闭后仍完整direct。history、Appearance cache、spatial三者分开核算，组合结果不能掩盖单项失败。

实施前必须产出closure清单，每项具备：真实资产/入口、完整依赖/CXY、被删除及仍被consumer需求的指令/查询、address与remaining Geometry masks、key/value实际宽度、实际消费分布/失效窗口、最坏requests/Store/retired字节、direct恢复和对应独立预期。尚未证明净收益的条目只标candidate，不自动启用；非准入合法图完整执行，不能永久fine/miss宣称C结束。

本轮从实际源码先确定以下分类，不虚构尚未取得的正收益证据：

| 已有入口 | 可以确定的计算边界 | 下一步处置 |
|---|---|---|
| `StandardAppearanceGraph::lowerStandardAppearanceGraph` | 源纹理、factor、vertexColor、normal/ORM及coat；ORM同query有多输出consumer | 作为便宜/共享及质量负例保留direct；不能按texture角色计成独立可删除query |
| `AppearanceMaterialDefinition::resolveAppearanceMaterialProducts` | 完整identity匹配的既有cooked Product与stale source恢复 | 保留原产品/过滤/更新入口；不重复加通用cache |
| `surface-work-gpu`原Generic图 | retainedQueries同时用于baseColor与后续coatNormal坐标，单field hit不消除这些共享query | 保留完整Generic与共享依赖负例；不能用metallic候选声称删除整图成本 |
| 同oracle的24次sin＋texture closure | 少量key、真实hit、局部失效与完整输出已可验证，但全成本负收益 | 保留回归与准入拒绝负例；不增加运算来伪造正例 |
| 实际复杂独立closure/可替换内部子图 | 必须从合法资产取完整依赖及全部consumer；内部边界允许，但需要真实执行切断 | 尚未选定。先完成清单/实际重复窗口/可证伪成本假设，再执行C-1至C-5，集中验证是否成立 |

当前保留方案为母稿§10.5.3的有界域准入及精确request发布；没有新增缓存算法donor，也不把ABI微调当新切换。实施前补齐上段的实际closure与工作域信息后，在**一个完整C切换单元**内按以下依赖顺序持续接线：

| 顺序 | owner与改动范围 | 完成时必须接通的实际产品/consumer |
|---|---|---|
| C-1 固定候选与准入 | `ExactAppearanceDag`/`AppearanceClosurePlan`/`GpuAppearanceDagAbi`/`GpuAppearancePublication`；区分候选权重、完整相等与核定成本profile | WorkPlan→执行域策略/address需求/remaining需求/direct recipe→真实Surface worker；未准入类别不产生cache命令/分配 |
| C-2 发布工作域及完整预留 | 既有Surface工作描述/args producer、`SurfaceWorkRuntime`、完整容量计划；按现有有限bank/family组织 | 可选域预留失败在key前直接计算；已准入域具备完整最坏请求空间；全部原输出仍有唯一写域，不再用像素先lookup后quota竞争作常态恢复 |
| C-3 Geometry与所有Appearance读者同切 | `surface_work_geometry`与`surface_work`的request/miss/resolve/direct；唯一Geometry owner按实际需求增量完成 | address→lookup→remaining union；hit不重跑被缓存heavy；dirty Lighting/guide仍完整；跨dispatch输入不依赖invocation-private残留 |
| C-4 完整缓存事务 | `appearance_closure_cache`、runtime graph、publication及fenced resources | 不可变request→同key唯一writer→actual miss/direct→正式fields→最后reader后的publish；失效、namespace/generation、abort重试、退休同切 |
| C-5 保留history并核全部直接消费者 | 现有双角色signal buffers、Lighting/rate、Reconstruct、history bindings、capacity/accounting | 六RGB/state/owner/read-write角色一致；history OFF真实移除；无全屏复制writer；partial/full拒绝保留原radiometry，峰值完整 |

不为以上中间步骤运行全链性能测试；允许必要typecheck/build和最小数值/编译调试。producer、产品、全部直接consumer、reset/binding/失效与fallback接齐才进入§8.3。不恢复旧链/adapter/第二submit，不添加本帧readback成本预测器或测试专用fallback。

### 8.3 一次集中验证与退出判据

先固定同一源码/build、真实场景/closure、策略、extent、camera/provider输入与有限重复窗口；GPU作业串行。所有源码改动后只使用新鲜build:test，保留原失败与独立预期。集中一次typecheck、production build、必要CPU合同与真实GPU正确性/接线/结构/成本检查。

| 责任 | 集中矩阵及断言 |
|---|---|
| 数学/消费 | fixed/General、shared ancestors、多varying、cached normal/coat、C/X/Y与真实过滤；direct/OFF/cold/warm逐目标输出及独立closure参考；证明确实执行hit/miss/局部拒绝；重建不执行完整Geometry/材质/PBR |
| 完整失败 | 空/奇数extent、不同key相同hash、弱CAS、零/tiny/满容量、局部拒绝、参数/uniform/route/residency/geometry/view变化、新显露、abort重试、generation/resize overlap；原目标不漏、不重复最终写入、同key唯一Store writer、无stale引用 |
| 真实工作量 | covered targets、key reads/probes、R/U/X、实际heavy/CXY/query、continuation与scatter words分别报告；hit后被声明删除的工作真实消失，仍需Geometry不计收益；optional OFF无cache/history额外命令/分配/维护 |
| 命令/内存 | 有限family/profile命令上界；实际clear/copy范围；active/pending/retired全部物理buffer；alias不重复记账，各物理槽不漏；16 storage与协商limit合法；768 MiB合同不改变 |
| 全成本 | 同数学direct、cache-only、history-only、spatial-only和combined；cheap/复杂共享/声明贵重复/动态高熵/full miss；cold与固定W窗口、局部拒绝/大量新显露独立报告；详细诊断和生产计时分开，timestamp不可用单列 |

本单元收益判据不是任意2ms/60FPS目标：**被准入的普通合法类别**在声明窗口内管理总成本小于实际省掉计算，配对完整Surface成本有正净收益，且正确性/覆盖不变。重复窗口记录总体成本及cold税；有限样本不足以区分计时波动则保持“未证实”，不放宽断言。便宜或已被结果否定的类别必须证明在key前direct，其税不能由其他类别收益抵消。

history独立证明六signal合法成功/局部拒绝及净成本；cache独立证明普通有收益成功；combined再检查交互及预算。无法分别证明不能只以combined更快完成C。正式连续画质、browser matrix、历史比较及最终GPU P50/P95仍在§13；本单元的配对重复窗口不是正式claim。

集中检查后按母稿§18.2分类：生产错误按原失败→最小复现→局部修复→关联回归；成本失败回到closure/重复窗口/执行域审查，先改方案再实施完整单元。禁止再以identity/stride/容量/局部计算的小候选循环替代此过程。必需责任未关闭仍为C active，不进入D。

## 9. D — Geometry 完整工作域

真实hierarchy深度/容量/调度、SSE/LOD/page miss与保守previous/current HZB；camera cut和常规运动分开。camera-visible与light caster域分开，屏外caster/deform/LOD/page变化真实消费。既有FrameGeometry/源数学/资源owner复用；decode/setup按真正consumer需求，不能恢复第二Geometry authority。

在本单元完整producer→Surface/caster链连通后，集中核coverage/保守拒绝/深树/空与多runtime/容量边界，再看实际tested/accepted/decode/存储。完整算法先核固定donor/阶段映射；未来Virtual Geometry接口不代表其算法已完成。

## 10. E — Lighting/Shadow 完整极端路径

LightCluster按真实light bounds建立影响范围及完整overflow；不能每cluster无差别扫全灯或静默丢灯。VSM pageConstants、receiver/caster、generation/tight bounds/dirty commit真实生产；屏外caster、移动灯/page不足可恢复；未实现的局部shadow不能返回1.0宣称支持。

完成producer/provider→六signal→合成链后集中核非零light/shadow、独立逐灯数值、caster/page覆盖与压力/容量，再优化light/receiver/caster关联。SSGI/ReSTIR仍由planned providers各自完整实现，不提前建万能框架。

## 11. F — Temporal/Post 与当前结构收口

TemporalFacts生产一次，motion/jitter/depth/identity/exposure事件明确；signal history、denoiser/reservoir与FSR拥有独立validity/read-write roles。SurfaceRadiometry保持原颜色与preExposure，原FSR3完整算法和1:1/upscale profile保留；不靠clamp/多层平滑藏漏work。

连续帧、新显露、rate/内容变化、cut/resize/abort/device replacement按生产链集中核数值和寿命；未来Atmosphere/高级Temporal/AI Upscaling消费既有明确产品，不为未出现的consumer永久分配全屏数据。已知基础缺陷不承接到正式验收。

## 12. 检查入口、旧测试迁移与防漂移

```powershell
# 根目录：源码owner导航，不是许可门禁
node tools/vibe.mjs context OEngine/src/render/surface

# 完整切换单元接通后：按受影响范围集中运行
npm --prefix OEngine run typecheck
npm --prefix OEngine run build
npm --prefix OEngine run build:test

# 必要GPU入口按实际单元选择，作业逐条串行
node tools/gpu-oracle.mjs --list
node tools/gpu-oracle.mjs surface-work --json
node tools/gpu-oracle.mjs appearance-exact-dag --json

# 文档改动合同，不证明源码/性能
node tools/docs-verify.mjs
```

不是每个任务必跑整块；新R3用例在真实入口连通后迁入当前oracle，未注册/未运行如实未完成。旧batch/tree/proof/窗口/vec4尺寸形状断言退休；保留完整IR/CXY、身份/失效/覆盖、唯一writer、guard/颜色、容量/生命周期语义并映射到当前入口。mock/source guard只证明各自范围，不为它们改变生产owner。

每次单元收口只维护§6.11/workstream与该单元结果，母稿保持目标，不复制测试数量或源码状态到入口文件。记录SD→producer/产品/consumer→独立预期→结构/成本→source/build→未关闭责任。修改正确性/质量/功能必需范围取得用户认可；接口/offset细节在合同内定案不另开文件或许可流程。source ledger只登记来源/采用，不再维护阶段进度。

## 13. 完整架构后的优化与正式验收

### 13.1 Surface 整体优化

B1/B2/C核心链完成后，先一次完整成本分布与实际工作量归因，再选主要热点的执行表示或算法。优化阶段可针对已知热点使用同输入直接参考/有界候选；正确性和所有直接consumer保留，主要收益需计producer/读写/管理/退休，而不是只看某个shader。不要让采样顺序、driver冷启动、不同clock或部分计时反向决定架构。

### 13.2 最终质量与全成本

A0–F主要架构与workstream计划providers全部完成、已知基础缺陷修复后，才做browser matrix、持续画质、正式P50/P95/evidence/claims与`verify --full`。包含低高coverage/near-far/静动/新显露、cheap/贵稳定/动态/完整General、高频normal/coat/窄高光、seam/LOD/deform/residency、非零lighting/shadow、native/upscale及生命周期。

production无profiling、coarse、stage与full税分开；frame span/pass sum/CPU encode/queue completion不可互换，逐帧归集后求分位数，不相加分项P50。固定历史checkout与当前revision保持相同功能/质量/相机/分辨率/环境；clock/温度未控就降低结论强度。先报告同质量全链成本，由用户决定数值预算；不把相对速度、容量合法或无API error当极致性能已达成。

### 13.3 本轮交付边界

本轮只重构两份母稿与必要导航。R3架构新增目标未实施；上一轮源码/测试工作区保持原样，没有新commit。A0/A1既有事实不重新验收，B1/B2仍开放。下面历史附录保存原证据及当时结论，不构成R3当前执行次序。

## 附录 H. 历史快照与实验原文（仅追溯）

以下原文的“当前、本轮、下一步、未实施”等只指原记录日期/source，章节数字为旧稿编号，不是R3状态。旧6.11/6.12内相互引用也指这份历史原文；现在状态只看正文§6.11。所有失败/source身份和限制保留，不因R3文档重构宣称修复或通过。

<details>
<summary>H.1 A0/A1 原实施证据（展开追溯）</summary>

### H.1.1 原5.1 A0/A1 实施核对（2026-10-06）

起点为 `41ceca80`，本次工作树修改；设计核对范围为母稿 §3.1、§13、§18 和本文 §4/§5。完成测量与执行生命周期单元，**没有实施 B1/B2/C，也不宣称当前 Surface 全帧满足 A/B/C**。本节是本次集中记录，未新增独立进度或验收文档。

| 任务 | 已落实的生产行为 | 独立检查与边界 |
|---|---|---|
| A0-01 | `GPUFrameTimingRing` 持久拥有 query/resolve/readback；production 不写 query，coarse 测一个命令 span，stage 最多 32 个连续语义区间，full 逐 pass 且最多 120 个采样帧/8,192 intervals。主 encoder 内写 marker/resolve/copy，不增加 submit | timer 微测四模式均得到 8 次依赖计算的正确读回；查询 0/2/6/22，marker 0/2/6/6，读回 0/16/48/176 B。marker 是计时额外工作；span 含 marker tax，但不含尾部 query resolve/readback copy，不称完整 queue completion |
| A0-02 | diagnostics schema 7 带逐 counter availability bitmap 与 producer/unit/window；Geometry/Material/Lighting descriptions 不冒充 samples/completion，未接通字段省略。Geometry hot stride 为 **128 B / 4 = 32 u32 words**；真实 diffuse/specular/coat IBL 与 packet writes 分别计数 | 当前 snapshot WGSL 实际执行后核对 visible lane、description、stride、unknown coverage。Lighting→packet→HDR 20 个 case 保留独立数值预期，环境三分支实际计数 1/2/1。旧排队量不能证明 evaluator 完成，完整 Surface coverage 因缺少 completion producer 仍为 unknown |
| A0-03 | `FrameProfiler` 发布同帧 command span、pass subtotal、stage、管理/求值/辅助、未分类与 pass 外差值；后者包含 copy/clear/gaps/marker，不是单独 copy/clear GPU 时间。CPU encode 单列；原生命令 facade 计实际 clear/copy 范围，多 context tax 累计 | 原 showcase 报告 consumer 同迁，span/stage 不重复加到 pass sum；没有 phase 的样本不填 0。截断/失败仅保留部分事实，不发布完整成本结论；先逐帧求和再取分布 |
| A0-04 | ledger 支持物理 identity 去重、live/retired/physical peak；Surface scratch 与池化资源退休计入真实 fence，query 容量和 resolve/readback buffer bytes 分列 | query set 的 native 显存大小不可观测，明确为 null，不估成 imports 总量。GPU component 中非重叠 transient scopes 只创建一个物理 buffer；pending owner destroy 及 resize 账闭合 |
| A1-01 | compile 生成每 scope 的 resolved resource slots、acquireBefore/releaseAfter，execute 处理自身事件；异常只清理实际 acquired set，删除逐 node registry 扫描；dump 首末引用也在 compile 汇总 | 固定 commands 加 4,096 个冷资源、固定 resources 加 commands 的生产 execute 结构回归；读取 registry.last 与重新 getResourceEntry 会令该测试失败。mock 只证明 CPU 调度；另有真实 GPU producer→buffer→copy/readback |
| A1-02 | 同物理导入共享 entry，但保留逻辑 node/version；late binding identity 带 layout owner，等名不同 owner 不合并；compile 建 RAW/WAW/WAR，旧 reader 必须先于覆盖写入 | 同物理不同版本、交叠 alias/依赖环、显式依赖与裁剪、不同 binding owner、未声明物理资源均核对。shader dispatch 的 usage scopes 保持原 API 边界，本单元没有自动 pass 合并 |
| A1-03 | 拓扑缓存晚绑定当前 imports，dead imports 不执行 resolver，执行后清除 bound GPU 对象；eviction 清理资源和 closure 引用，device replacement 要求重建 | 已有环境/history role 测试、真实 scratch 4→8→4 缓存 recipe 检查；返回旧 extent 使用新物理资源，不 pin 首次已退休 allocation |
| A1-04 | 主 command 的已提交 completion fence 与 abort 分开；pool 在逻辑 last use 后可于同 encoder 内复用，跨 command 归还等待 fence。native fallback 必须提供显式 completion，真正 destroy 不早于提交/完成 | real GPU 同一 buffer 重用前清 4 B，两个 readback 都为 1；native fallback 提交前存活。throw+cleanup 双失败保留原始 cause，pending completion、连续 prepare/commit、resize/destroy 与 device replacement 有 targeted 覆盖 |

**失败与修复记录。** 完整 1080p showcase 揭示旧 producer 返回的新版本未传给 direct consumer：dependency owner、radiometry→constants→Surface 以及跨 batch workspace；本次直接修正句柄传递，不关闭版本检查。facts/proof/classify/witness 的真实 Product bindings 补齐声明。Lighting fixture readback 原来读取旧 arena，迁到实际 Lighting 输出版本，数值预期/质量断言不变。原始失败与后续结果保存于 `.local/a0-a1/`。独立复审的多页部分 map failure、截断报告、同帧多 context tax 都有失败→修复→通过记录；多页必须全部 settle/unmap 后归还 slot。旧 batch 在 clear/复用 frame index 后不得填新帧；无 timestamp、ring 饱和、abort、完整 full 窗口结束均不会阻塞 render 或填假零。

**本次验证命令与证据范围：**

- `OEngine` 的 `npm run typecheck`、`npm run build`、新鲜 `npm run build:test`；examples 的 `tsc --noEmit -p examples/tsconfig.surface-performance.json`。
- 12 个 A0/A1 相关 unit/contract 文件共 53 个 targeted tests；`node --import ./examples/tests/source-resolver.mjs --test examples/tests/showcase-benchmark.test.mjs examples/tests/performance-metrics.test.mjs` 共 12 个报告聚合测试。源码 resolver 是 Node TS 测试集成，不进入 production。library benchmark 与 evidence gate 同样拒绝将截断的部分事实作为完整分项百分位。
- GPU 串行：`node tools/gpu-oracle.mjs frame-timing --json`、`framegraph-lifecycle --json`；`node validation/labs/surface-optimization-v1/run-production-cell-browser.mjs phase5-lighting .local/a0-a1/lighting-counter-final 12`。真实 NVIDIA/Turing、Chrome 154.0.8037.93；零 GPU API error 与输出断言同时核对。fixture favicon 404 不是 GPU 算法验证。
- 原 production showcase：`node validation/tools/run-surface-performance.mjs --frames 3 --warmup 2 --batches 1 --width 1920 --height 1080 --modes timing --coverage low --no-counters --no-sensors --headless --out .local/a0-a1/surface-final --port 4187`。该项刷新当前成本事实，不是正式性能收益验收；完整功能 profile、低 coverage、静止相机，未运行正式 high/near/far/移动/材质/失效矩阵。

基线完整逐帧记录、配置、fixture/source fingerprints 与截图在 `.local/a0-a1/surface-final/`：3/3 完整帧、32.84% coverage，Surface pass P50 **327.287 ms**、command span P50 **346.030 ms**，GPU API/readback error 为 0。同一帧 102 的管理/求值/辅助分别为 **310.378/12.976/3.473 ms**；不能用多个分项 P50 拼出比例。每帧 489 次 clear、297,241,108 B clear 范围、965 次 buffer copy、324,420 B copy 范围、4,798 queries、1 frame submit；copy 字节不是物理总线实测流量，tail profiler copy 单列。短基线后仅补 library 报告消费者的截断拒绝回归，未改变本次测量的 Renderer/WGSL。仅 3 帧、没有控制频率/温度/供电，不能外推稳定 P95/FPS 或与旧历史测量相减。更早的修复后短采样在 `surface-baseline-repro6/` 独立保存，不拼接统计。

**A/B/C 的本单元结论。** A0 的 production/coarse/stage 调度及 query/slot 预算有界，full 是显式诊断开销；A1 的 CPU execute 随实际 scopes/references/events 增长，冷资源不再乘每节点扫描。关闭计时仍得到相同 component 数值输出，非重叠 lifetime 复用保持正确。管理不等于全部 GPU 计算、可关闭复用的整帧质量与净收益仍属于 B1/B2/C，当前同帧数据清楚显示 Surface 管理成本严重高于求值。未运行 browser matrix、正式画质/历史收益、device-loss 全链恢复、`verify --full` 与 claim promotion；这是后期验收范围，不从 component 通过中推导。

</details>

<details>
<summary>H.2 R1 诊断与失败（展开追溯）</summary>

<a id="64-实施与复审核对2026-10-06"></a>

### H.2.1 原6.4 实施与复审核对（2026-10-06）

复审 revision 为 `3088bad6`。**B1 只有组件原型和部分执行器接线，未过出口；B2 六项全部未实施。** 此结论取代此前本节“B1 已实施两半”的覆盖表述，不修改母稿的任务、画质或范围。

| 任务 | 实际状态 | 源码与证据边界 |
|---|---|---|
| B1-01 指定廉价 closure 的原子切换 | 未完成 | 尚无具名 closure 的完整输出/identity/rate/all-consumer 清单与绕过旧 proof/lookup 的生产路径。常量 palette 沿用旧分类器发布，不能说常量已完成新域竖切。 |
| B1-02 域实体与实际 coverage/sample work | 目录原型，未接生产 | `GpuSurfaceDomainAbi.ts` 仅被两个测试文件引用；`GpuAppearancePublication`/`SurfaceWorkRuntime` 不发布/读取它。GPU case 是测试构造目录与 tile references 的 reader，不是 Visibility→domain→evaluator→Lighting/reconstruct。 |
| B1-03 需求/handle/binding/reset/容量同切 | 未完成 | 新 DAG 仍在 `consumeBatch` 内执行，依赖旧 `SurfaceCellClassifierPass`、Field/Signal lookup、wide Geometry 与 proof/witness。旧链存在说明目标 closure 尚未绕过它，不直接据此推断 exact value 被求值两遍。 |
| B1-04 完整有限家族可行性 | 部分 | Appearance evaluator 的 per-program dispatch 已换为固定 residency-set 循环，DAG 有完整算术/坐标节点、union masks 与 lane scratch。旧 per-program bound/constant WGSL、program queues 与 CPU batching 仍保留；完整 Surface 命令拓扑尚未有限化。 |
| B1-04 数值原型 | 组件通过 | 原 42 组为全部算术与三 UV 嵌套坐标，sampler 是解析回调；不证明真实 resident bank、sampler wrap/LOD、非恒定 product、coat、多 graph/set 与最终布局。复审新增常量 normal-product/无效 moment/大常量地址，合计 48 组；仍是组件范围。 |
| B1-05 full producer→all consumers/容量与失效 | 未完成 | lane Q=1/7/64 能遍历 129 个 work，只证明局部 scratch 调度。没有 new-domain production 的 UV seam/primitive/partial tile/version、zero/tiny optional capacity、abort/resize 与 exclusive writers 全闭环。旧全链 fixture 超时仍是未通过，不能用其他组件通过补齐。 |

**需要返工的边界。** 保留 scalar IR、数学、完整 union/liveness 与有限 evaluator；重做域模型和真实接线。当前目录的 `closure` 由测试字符串 hash 提供，缺完整描述 interning/版本及 Winner/Sharing/Cache identity 的生产映射；`sampleMask` 同时进入身份，又以位数代表求值工作。测试把“15 个 field bits × tile references”叫 frame samples，不能证明高频 64 pixels/tile 的实际采样、坐标、信号率或写域。应让 published domain 身份、coverage refs、实际 sample recipe 三种产品独立，从真实生产入口生成并消费；无需保留当前原型 ABI 为目标合同。

完整 family 的性能可行性也未证明：当前所有非 publication 工作默认走 storage-scratch interpreter，固定 Q workers 对每个 residency set 遍历整个 material queue；未形成实际 family bins/间接工作，也没有 cheap-vs-generic 同帧成本与 register/spill 测量。`GpuAppearanceDagAbi` 将 cooked payload 打包为两个 buffer，同时 `AppearanceStaticResidency` 仍分配相同产品的 textures；这些有旧消费者的资源不能直接删除，但必须纳入物理峰值并在迁移时收敛到长期 owner，而非把额外 payload 视为免费。产品手工 filtering 与原 `textureSampleGrad` 的独立 GPU 对照尚缺。

B2 必需的薄 Geometry/必要 guides、25-channel 窄字段、独立 signal rate、有界 overlay＋完整 indexed exact recipe、全部 direct consumers/reset/capacity 和旧协调链删除都未发生。下一步先完成一个合法 closure 的 B1 真实竖切及上述可行性验证，再切 B2；不以 `surface-domain` reader 的计数通过进入 B2。

### H.2.2 原6.5 本次验证耗时诊断与局部修复（2026-10-06）

- **CPU 测试进程不退出的确定原因**：`web-cook-visible-first.test.mjs` 的旧 Product fixture 未置当前 Float32x3 标记（format byte 10）。测试数十毫秒内抛 `Product requires Float32x3 positions`，两个 heartbeat case 的 `setInterval` 未在失败时清理，导致整个 Node suite 等待。已迁移同类 fixture 的描述标记，并用 `t.after` 保障 coordinator/timer 失败清理；事件 draining 由唯一 collector 执行，避免丢 page credit。原文件首次修复 10/10，约 1.19 s；复审另发现“saturated queue”原 case 每 20 ms 排空全部事件，根本未达到饱和。已让唯一 consumer 暂停、阻塞 richer revision、真实积满 4 个 Progress slots 并跨过额外 heartbeat 后断言会话仍正确；补断言在旧 fixture 上先失败，再修正。最终该文件 10/10 约 2.21 s（含真实 1.5 s 饱和等待）；恢复旧错误输入的受控负例仍失败 2/2，但约 0.14 s 正常退出。没有 forceExit、skip 或删断言。
- **GPU 编译等待的确定分项**：新增 `appearance-surface-compile` 测量实际生产 descriptor，而非 analytic sampler 内核；本机 NVIDIA/Turing、Chrome 154 中约 26 KB source，最终 module/info/pipeline 合计 0.75 s。`surface-proof-compile` 用当前 generator 隔离一个旧 field certificate（family 1、128 targets、一个普通 material），约 134 KB source，info 0.099 s、pipeline 31.108 s。完整旧 fixture 在约 0.72 s 内发起 50 次同步 pipeline 创建，随后等待 24 个 module info 超过 60 s；这是排队的 driver 编译阶段，不是本次已经测到的 GPU readback 卡死。不能从一个 profile 推导每个旧 shader 都耗时相同。
- **runner 可观测性修正**：记录每个 pipeline/API 编码、module info、execute/submit/GPU completion-readback 的阶段与时间；host 使用绝对 deadline，progress/capability/source 读取不再让每轮等待无限延长。超时保存最后 snapshot、原始 logs 和分项，仍返回失败。旧 `publication-cutover-repro3` timeout 报告保存的是旧 stage，但 logs 后续出现了 `Executing production frame 0`，因此该历史报告不足以独断死锁位置。
- **确定的 DAG ABI 错误**：constant-product 原先把 constant slot+1 与 neighbor flags 放进同一 16-bit channel/control word。大 slot 会截地址并误启邻点写，破坏 lane 隔离。已改为具名 constant-product opcode、完整 u32 auxiliary address、独立 width/neighbor bits，并按实际 width 读常量。回归先失败后修复，真实 GPU 使用 65536 起始地址、有效/无效 normal moment 和 Q=1/7/64 检查完整输出。
- **domain reader 的测试竞态**：同一 dispatch 的 lane 0 reset 累加 counter 与其他 workgroup atomicAdd 没有全局同步。已把累加 counter reset 放在 dispatch 前上传；domain count/tile count 仍由 shader 读取实际目录/setting，不以预填正确计数替代检查。此修复不提升目录的生产采用状态。

原始失败、编译分项及复跑保存在 `.local/b1-b2-review/`（本地诊断，不是正式 evidence）。最终 targeted 七文件 51/51（包括上述 Web Cook 文件）、generic GPU 48 组和 directory GPU 三个 reader case 通过；两个 compile oracle 只证明选定 shader 编译与耗时。关联 Web Cook 六文件 35 例中 24 通过、11 失败：10 例 Nyx fake WASM 仍返回 ABI 2（生产要求 3），1 例 provider 的旧 resident group payload 不合法；这些失败约 0.6 s 返回，已与进程挂住区分，尚未修复全部旧 payload/ABI。没有声称全仓 suite 或 B1/B2 通过。

### H.2.3 原6.6 2026-10-06 性能失败后的重新执行边界

**历史执行路线，已由R2取代。** 下列R1–R5只解释当时诊断次序；现在以§6.8–6.11重新组织，不继续逐项补丁式展开。

本轮工作树已经接通新 coverage→域目录/有限bins→Geometry/Appearance→signal rate→Lighting→Reconstruct，并删除旧全批协调器；这不是阶段完成。1080p地牢、约80.4% coverage、6个完成GPU帧的短程诊断中，关详细计数的 timing 模式 Geometry＋Appearance common P50约83.30ms，Surface约96.47ms。报告位于 `.local/b1-b2-review/showcase-timing1/0-high-timing.json`，属于本机诊断，不是正式历史收益。已确定慢融合kernel；opcode/private indexing、Geometry setup和memory各自占比尚未拆分证明，不把 spill 写成已证根因。

以下R1–R5引用当时母稿的固定公式/Geometry/consumer/性能章节，是历史路线，已由§6.8的R2任务替代；不能继续按现母稿同号章节执行旧步骤：

| 顺序 | 任务 | 必须检查 |
|---|---|---|
| R1 | 完整结构匹配→固定 Surface 输出公式；未匹配保留 Exact Generic | 原操作顺序、共享sample、3UV、产品/moment、参数zero→nonzero；真实输出对独立reference，不按slot数分类 |
| R2 | center/neighbor逐语义需求，局部Geometry私有存活期 | 同一Winner数学、源属性需求真实消失、Lighting/view fallback语义不丢；融合/分离的完整输入输出成本 |
| R3 | 一般/复杂材质1080p真实生产链 | timing/detailed分别测；coarse/no-reuse完整；命令随实例数量不增长；Generic/Q最坏成本 |
| R4 | B2窄字段、guides、signal写域和retirement收口 | consumer表、allocated/written/read/retired、tiny/zero overlay、partial extent、version/abort/resize |
| R5 | 退休旧链测试与fixture，映射仍有效语义到新入口 | 不恢复旧owner、不删正确性断言；最终新鲜build:test、targeted GPU串行、docs verify、设计逐项核对 |

R1–R3未通过不能进入新的B2实现扩张。现有B2接线保留在唯一工作树路径中作为待验证实现；不恢复旧链做A/B，不将剩余缺口后移为C优化。阶段仍是B1未过性能可行性门，B2未收口。

### H.2.4 原6.7 本轮固定公式与 Geometry 表示诊断（2026-10-06，未收口）

唯一路径已改为完整结构匹配的固定公式；不匹配的 graph 保留完整 Generic。固定 Geometry/Appearance 分离，逐语义保存必要 UV 的 C/X/Y 和 color；Geometry 使用已发布的帧顶点 world 产品，Coverage 的对象属性 consumer 同迁 stride。quad 内 setup 共享原型虽然减少实际 setup 次数，却使 Geometry 从约9ms增到约11.8ms，已撤掉该表示，没有留下运行选择桥梁。

同一1080p地牢、原功能、约80.40% coverage的串行短诊断，timing/detailed各8帧完整完成，Surface pass sum P50/P95分别24.183/26.411ms、26.477/26.804ms，timing GPU frame span 35.59/40.44ms。此前83ms融合 worker 已被替换，但这些短样本不证明正常性能、正式历史收益或B1出口。buffer 创建/销毁轨迹的 requested 峰值约1276MiB；计入纹理逻辑 payload 后约2231MiB。后者不含driver allocation padding、swapchain及其他进程，不能当物理显存峰值。之前两个case在第二帧附近出现D3D12 OutOfMemory/device lost，随后同源码串行复跑成功；尚不能以复跑成功认定根因已修复，原始失败保留。

新增1080p全域压力诊断分别执行常量/普通Standard/完整Generic、reuse OFF/ON，逐像素alpha覆盖、非零provider和重复输出均断言；字段数值closure仍由小GPU用例逐字段独立验证，成本case不冒充完整数值oracle。完整Generic包含12个保留到嵌套coordinate后续读取的sample，真实C/X/Y及live ranges未裁剪。原AoS lane临时值的Generic worker约372ms；改为slot×Q+lane后约69–71ms。48组算术/三UV/嵌套采样/moment/高常量地址GPU组件通过，CPU相关19例通过。该结果仍需完整直接成本参考与本次最终快照关联回归，不以相对加速关闭R3。固定引用28-bit payload的越界回归先失败，现改为整个graph进入完整Generic，未裁u32地址。

隔离直线参考前两次在120秒超时，日志最终停在pipeline compilation；其完整bank/sampler switch在各直线sample callsite展开是编译规模问题的定位依据，不直接当GPU执行成本。第三次明确专门化fixture实际的单bank/linear-repeat资源profile后完成，与生产HDR逐位一致；见`surface-work-native3.json`。该短run中生产Generic约74ms，native参考末次约45.40ms，冷启动/时钟差异未控制，不能相减宣称29ms纯解释税。随后16-slot workgroup窗口的压力worker约66.90–67.14ms，64组组件（含Q=65跨group）通过；见`surface-work-cost-window1.json`/`generic-window-green.json`。当时完整场景和完整Surface数值链尚未对最终窗口快照复跑，OOM根因仍未确定；B1/B2没有完成或提交。

这些结果属于R2前工作树诊断，不证明Typed Tape、完整uniform子图提取、程序一致packet、arena-backed融合或RGB信号已经实现。用户暂停了继续局部修补并认可R2设计；本次只更新文档，不沿用旧快照测试结果作为R2通过。

本地原始诊断位于`.local/b1-b2-review/`，包括`showcase-frameinputs1`失败、`showcase-frameinputs-repeat1`资源轨迹和短计时、`surface-work-cost1.json`/`surface-work-cost-soa1.json`、`generic-soa-red.json`/`generic-soa-green.json`及`fixed-reference-red.txt`。这些文件是诊断，不是正式evidence。

</details>

<details>
<summary>H.3 R2 实施与成本快照（展开追溯）</summary>

### H.3.1 原6.11 R2 实施与集中核对记录（2026-10-06）

用户后续指令已恢复 B1/B2 实施。本节实施/测试快照基于 `3088bad6` 加继承及本轮改动；用户要求将当前阶段快照提交到 `master`，提交身份以 Git 记录为准。**生产切换与以下检查不等于 B1/B2 已完成：R2-05 成本出口未关闭，不能进入 C。** 用户选择“先报告同质量全链成本，再决定数值预算”；不自行补 FPS 门槛，也不将没有预算解释为自动通过。

#### 实现、产品与直接 consumer

| 设计/任务 | 当前 producer → 产品 → consumer | 本轮实现与核对范围 |
|---|---|---|
| SD01/02；R2-01 | `AppearanceGraphCompiler`/`FixedSurfaceFormulas`/`ExactAppearanceDag` → 结构模板、实例 snapshot、export → `GpuAppearancePublication`/Surface evaluator | 完整结构匹配有限 Unlit/PBR 家族；不匹配走完整 General。模板完整结构字符串比较，参数值/texture handles 单独发布；Coverage 保留 alpha 路径，Surface 只移除它没有读者的 alpha ancestors。 |
| SD03/04；R2-02 | DAG → publication/material/frame/sample tapes → GPU update 与 General worker → closed fields/guides | 实际语义宽度、C/CXY、f32 word SoA、query 多输出、normal moment 单 decode、多 sink 最后读者。不可变 nonlinear 子图只 publication 执行；材质与 camera 更新分开，commit 清 dirty，abort 保留重试。10,000 节点闭包改为迭代遍历，释放事件避免二次方扫描。 |
| SD05；R2-03 | Coverage 原 work → 有限 partition/dense template count → portable Blelloch prefix/scatter/padded runs → 同 worker | 单模板分区不排序；optional 0/tiny 完整 indexed fallback，保留原 destination/mask。真实 GPU 回读验证 multiset、histogram、prefix、tail 和无效 padding，不以 counter 少了代替完整 work。 |
| SD06/07/09；R2-04 | `FrameGeometryArena` v3/`FrameGeometryVertices` → prepared/resident 统一源 → raster/Coverage/Surface → 局部 Geometry/Appearance → Lighting/Reconstruct | Ordinary/Product full/partial/zero prepared 已接齐；Product Surface source9+data7=16 storage bindings。没有全屏 UV/color staging；hot12 words、closed fields 与必要 guides 保留。旧 Winner dictionary/coefficient/work/control owner 删除，插值数学保留。 |
| SD08；B2-01–05 | Coverage/Geometry facts → 六 kind 独立 recipe → Lighting 六 RGB f32+state → Reconstruct/HDR | 按信号独立精确相等 admission；direct 的位置相关 provider 必须拒绝不安全共享。保留原六路加法分组、output-pixel AO、Rec709→2020/preExposure 与非有限 guard。复用 OFF 不编码四个 rate bank dispatch。 |
| SD09/10；B2-05/06 | frame/publication owners → 预协商资源与 active/retired 状态 → 单 FrameGraph/submit | 旧 batch/tree/proof/witness/UV 依赖从生产路径删除。无读者 publication fields/directory/lookup/identity GPU 副本删除，Coverage 所需 constants/routes/runtimeInputs 保留。普通几何 continuity 载荷删除，TemporalFacts 实际消费的 primitive mapping/offset 保留，meshlet stride 仍为128B。 |

#### V01–V12 覆盖核对，未测不能算完成

| 责任 | 新主链/独立组件证据 | 未关闭范围 |
|---|---|---|
| V01 | CPU 完整模板/snapshot 依赖测试；GPU 数值编辑、稳定帧省略、abort 重试；1/25/257模板 native 命令核对 | 不凭模板比较测试声明所有 publication 生命周期失败组合已覆盖。 |
| V02 | 当前生成 General tape：算术 opcode GPU oracle；Surface nested nonlinear/UV0–2/12 query/晚共享读者真实输出 | 完整 General 的性能出口失败，功能证据不能代替它。 |
| V03 | typed widths/CXY/query/sink CPU 独立预期与真实 GPU Q=1/7/64；10k 节点完整编译 | 大图编译成功不等于大图 GPU 帧时可行。 |
| V04 | GPU material/frame update、zero→nonzero、abort 后重试、稳定帧不更新 | publication/material/frame 频率证据限当前输入语义，不声称未来 provider/time 接口已实现。 |
| V05 | 当前 immutable bank sampler 对硬件过滤：RGB/pair/scalar各70查询；Surface raw/moment、normal/late query | 不提升为完整第三方 sampler adoption。 |
| V06 | 1/25/257模板、空/unlit、N=1及Q边界；独立 multiset、原地址、padding 与 native 命令 | 更大最终场景矩阵留最终验收，不把这里的尾部结果外推全部规模。 |
| V07 | optional=0/tiny 实际走 indexed，完整 HDR 和写域；mandatory checked capacity targeted tests | 没有把原工作截断来过容量检查。 |
| V08 | Ordinary/Product prepared full/partial/zero、实际16绑定；projectively equivalent negative-W case；§6.12补66个当前frame producer→arena→Geometry边界组合 | 新probe核数学/属性与prepared/resident实际分支，不代替真实raster裁剪覆盖图、镜像/nonuniform变换全主链组合；V08不能记全通过。 |
| V09 | 非零 light/IBL、coat/specular/IOR、unlit/背景/unsafe guard、AO scope；六路 GPU/独立 BRDF/HDR | 完整生产 provider/材质场景矩阵未跑，不冒充最终画质验收。 |
| V10 | 当前资源/transaction targeted tests、GPU FrameGraph transient/resize lifetime；snapshot abort；§6.12补当前Visibility跨owner绑定失败→回滚→重试→fence退休 | 所有 Surface prepare/retire/mandatory不足失败交叉组合尚未覆盖；历史 D3D12 OOM 根因未关闭。 |
| V11 | 同输出 General/native 诊断、1080p Showcase 全链/管理/分配记录，见下 | 尚无同条件完整统计成本对照；General 诊断已显示显著成本差距，不能通过可行性门。 |
| V12 | 六路独立 state/率；合法共享与局部拒绝；OFF/ON 完整 HDR；coherence 0/tiny exact | 尚缺 B2 全场景成本及每个信号高频/边界失败组合的完整核对；不能用一个 coarse 成功代替六路全部责任。 |

#### 新鲜构建、测试与失败记录

最终源码快照 `buildIdentity.sourceSha256 = 131896e212291a4037ff9575c24ee231bc438bf322761e1ba43ba63b7b991533`：typecheck、`build:test`、production `build` 通过；集中 CPU targeted suite **134/134**。真实 GPU 串行：`surface-work` **56 case报告**、`appearance-exact-dag`、`appearance-product-sampling`、`framegraph-lifecycle` 全部 passed。后者有专门构造不完整 producer 的负用例，必须得到 coverage fail，不能将它误记为生产完整覆盖失败或拿它证明 Surface 正确。

本地原始记录：`.local/r2/module-reviewed-final.txt`、`build-reviewed-final.txt`、`surface-reviewed-final.json`、`tape-reviewed-final.json`、`sampling-reviewed-final.json`、`lifecycle-reviewed-final.json`。这些是当前机器调试记录，未提交/未提升为正式 evidence；JSON passed 和 scope 已核对，不只看进程退出码。没有运行全量 `npm test`、完整 browser/device-loss/画质矩阵或正式 claims，遵循根 AGENTS 的阶段节奏。

用户要求提交阶段快照后的补充检查：typecheck 通过；将此前工作区遗留的 Web Cook fixture/harness 改动和 `gpu-frame-timing` 纳入 CPU 检查，192 项中180通过、12失败，约3.8秒。失败为10项 Nyx Web Runtime Cooker、1项 Web Product provider admission、1项 diagnostic stride 用例；已观察到 cooker ABI version mismatch、resident group layout invalid，以及旧fixture填写16 words而当前hot为12 words导致coverage fail。除已明确的stride fixture差异，其余未逐项完成根因定位，不声称全部只是测试问题。原文保留 `.local/r2/precommit-tests.txt`；本次提交为带已知缺口的阶段快照，不是全测试通过或B1/B2完成提交，未改生产算法或放宽断言消除这些失败。

旧 `surface-batch-consumption`、cell/tree/旧 geometry/phase6-reset/optimization-capacity/bound-specialization/demand/winner-owner 等机制断言随 owner 退休；覆盖/身份/容量/数值语义分别迁到当前 Surface GPU、arena/vertices/resources、appearance typed/field identity/transaction 检查。旧 lab 不作为新主链证据，不恢复旧 owner 让历史 import 变绿。C 的 Store key/pin/generation 数学测试仍保留，它们不证明当前生产 cache 已采用。

失败原文保留 `.local/r2/`：scatter stride/tail 的生产错误与10k图递归溢出已定位并关联回归；angular WGSL关键字/usage和fixture alias是 harness 错误。尖锐 GGX 对 CPU double 角度差敏感，独立 oracle 改用 GPU builtin 提供六个角度量，再由 CPU 独立 BRDF 合成，未放宽原容差或使用生产 BRDF 预填结果。reuse OFF 真实省掉 rate dispatch 后，成本 topology 断言按模式精确差4修正。continuity 生产上传断言先红3808B/预期3040B，再删除无读者载荷转绿；没有删除仍被 TemporalFacts 读取的 primitive identity。

#### 同质量成本及可行性结论

成本记录在最后 continuity 清理之前的源码 `410c83656d2d71977e058c37cf1921a372a13a6b9806bb0a3b58f7efa6d6f745`，独立列出，不与最终源码测试拼成同快照性能通过。该清理移除无读者数据/函数，仍不能据此宣称最终性能已测。

1080p 完整 General fixture（sampler/normal/CXY/coat，全输出相同 HDR）：`.local/r2/native-final2.json`。warm General 复用 OFF：Surface **90.052ms**，Geometry/Appearance **71.820ms**；复用 ON：Surface **94.060–95.757ms**。同表达式 isolated native reference：Surface **41.172ms**，Geometry/Appearance **19.054ms**。cold 单列200.350/177.387ms。此为少量重复、未控制频率的诊断，不是正式P50/P95，也不能把全部差额精确归因于“VM税”。native仅oracle参考，无第二生产路径。General 表示仍有严重成本问题，复用在这个 fixture 没有净收益。

真实 Showcase：GTX1650Ti、1920×1080、high约80.40%coverage，每模式8warmup+8采样，Chrome154.0.8037.93；`.local/r2/showcase-final/suite.json`。三个模式均完成，单submit，无API/deviceLost报告。固定家族为主要 Appearance，不能用此结果替代完整General成本。

| counters模式 | Surface P50/P95 ms | GPU command span P50/P95 ms |
|---|---|---|
| off | 33.620 / 34.210 | 47.383 / 48.103 |
| timing | 33.227 / 33.686 | 46.793 / 47.710 |
| detailed | 34.013 / 36.241 | 47.251 / 51.577 |

timing 的 GPU pass sum为46.072/47.055ms；它不同于 command span。逐帧配对后 Surface management4.588/5.046ms、evaluation23.986/24.314ms、auxiliary4.522/4.915ms；不能把各自P50相加当总P50。主要 pass 中位：fixed Appearance19.857ms、Lighting4.063ms、Reconstruct4.260ms、rate2.949ms。off仅关闭Surface counters，GPU timestamps仍开启，不是完整profiling-OFF税测量；8帧属于短诊断，不是历史收益验收。

按 create/destroy 事件计算，timing active buffer峰值1125.244MiB，buffer+未计驱动对齐的logical texture峰值2080.607MiB。采样窗口±1秒内 nvidia-smi 为87–88°C、graphics1350MHz、memory6000MHz、整机GPU显存3014–3089MiB/4096MiB；短窗口和温度未经控制，结论有限。arena删除无读者 region 释放的是该arena内空间，attributes可能复用容量，不宣称固定128MiB arena已缩小。新 capture 不OOM不能追认历史 `showcase-frameinputs1` 的 `CreateCommittedResource` OOM根因已定位；该原失败仍保留，需最小复现与 live/retired 分配归因。

不变量A在已测模板/实例规模的 native命令范围有证据；B在该Showcase短采集中management低于evaluation，但廉价/General全范围还不能统一通过；C在Surface独立结果OFF/ON正确且同量级，净收益不等于正确性。**R2-05/B1未完成；B2接口已切换和部分验证，V08/V10/V11/V12剩余责任使B2也未完成。** 下一步先关闭列明的边界/生命周期用例，并对General与固定家族的实际query/内存/执行成本作有界表示决策；不继续无边界window/private-array调参，也不把问题推入C的cache来掩盖。

</details>

<details>
<summary>H.4 R2 表示实验与边界检查（展开追溯）</summary>

### H.4.1 原6.12 B1 成本归因与表示定案（2026-10-06 后续授权）

用户已授权按建议继续：先成本归因与直接求值表示，随后B2收口、C及D/E/F；当前主分支持续实施，不新增切换单元。已有§6.11的验证范围和缺口保留，不能用本节组件诊断外推全链通过。

本轮两个假设：H1，Product buffer上的half解包/手工过滤可能是普通家族热点的重要成本；H2，fixed查询结果的storage scratch写回/读取可能有可避免开销。先按原始Product texels/mips/domain比较生产采样函数与独立硬件过滤，随后选择固定公式局部消费表示。General完整执行表示在普通路径归因后定案，不调整效果、精度、采样footprint或命令类别。

H1诊断入口 `node tools/gpu-oracle.mjs appearance-product-sampling-cost --json`。使用当前生产sampler/packer，scalar、pair、RGB格式及跨bank；256×128、完整9 mips，1920×1080输出、每item四查询。2次warmup、6次配对计时并交替顺序，全部输出分量核对独立硬件结果；误差依据原texel梯度/硬件fraction精度界与四次加法，非生产预填。此是cache-friendly单Product的过滤/解码组件成本，包含结果写出，不能当场景带宽、GPU占用或整条Surface收益。硬件路径仅oracle参考，当前生产不建立双路径。

时间戳/硬件过滤为本地确定性diagnostic集成，使用[WGSL textureSampleGrad](https://www.w3.org/TR/WGSL/#texturesamplegrad)与WebGPU compute-pass timestampWrites；不宣称新的第三方算法adoption。完整Product新表示实施前仍按根AGENTS固定donor/许可/阶段映射，保持原资产支持、lifecycle和全部consumer。本轮结果及候选决定在本节集中追加，不新增报告文档；每个表示最多两个具名候选，不扩大场景矩阵或窗口/Q调参循环。

**分支归因修正**：现有Showcase allocation原文中，每次 `GpuAppearancePublication/exact-dag-products-0/1` 均为4B占位，无实际Appearance Product payload；Geometry Product驻留不能当作Appearance Product采样已执行的证据。H1组件昂贵的结果成立，但不能解释该Showcase fixed热区，本轮不因它先重建Product atlas。

H1 `.local/r2/sampling-cost3.json` passed，三个格式各核对8,294,400输出分量。软件/硬件P50：RGB16.824/1.649ms、pair6.914/3.611ms、scalar8.312/1.609ms；P95及全部6次样本保留JSON。冷缓存/频率未控制，不把比例外推scene或全部格式。前两次失败分别是扩大fixture后旧probe预算、旧bank容量不足；修正声明容量后保留全部原数学/过滤断言，没有缩小fixture或放宽容差。

H2候选为当前storage sample scratch与15个具名private sample（非动态private数组）。`surface-work-fixed-scratch-reference` 保留当前Geometry、9 banks/6 samplers、全部固定公式/normal decode和Lighting/Reconstruct；全1080p HDR逐word一致。`.local/r2/fixed-scratch1.json` passed：warm baseline Appearance8.212/8.128ms，standard26.701/24.419ms、whole Surface39.685/37.292ms。两次重复、非交替且没有clock控制，仅支持“该fixture有限下降”，不保证register驻留。本轮不采纳此候选进生产，也不继续private/window尺寸循环；当前生产仍用storage表示。

H3另隔离**resident sampler路由**：保留全部9 banks、原UV变换/mip clamp，只在fixture完整不可变sampler均为linear/repeat时比较6 sampler分支与1个已证明sampler类别。入口 `surface-work-resident-sampler-reference`，baseline/standard/完整General，全HDR逐word核对、同native命令；参考只在oracle，不改变生产选择。若有净收益，发布边界可在有限sampler类别内确定完整/单类别程序，不按材质数生成PSO/dispatch；混合或不能证明时保留原完整6类别，不能拒合法sampler。

提交前12项失败的根因已逐项缩小到fixture协议：Nyx mock仍宣告ABI2且domain stride仍按32B读；当前ABI3为48B并含UV weights。provider“有效页”原本全零，没有合法V3 group/meshlet；diagnostic仍填写16 words而当前hot12。迁移真实协议fixture并保留旧ABI拒绝、旧stride失败断言后，相关29项通过，日志 `.local/r2/legacy-fixture-green2.txt`；这些mock/lifecycle断言不证明真实WASM cooker或renderer算法完成，集中收口还会跑完整受影响targeted集合。

H3 `.local/r2/resident-sampler1.json` passed，完整HDR一致；warm standard Appearance26.369/24.570ms、Surface38.951/37.502ms，但General79.182/87.125ms、Surface91.515/100.008ms。顺序/时钟未控，不能认定精确回退根因；此轮不能证明全范围净收益。本轮不采纳单sampler生产class，已撤回临时generator参数，只在oracle保留具名参考；PSO/dispatch/资产支持没有增加或裁剪。

一个确定的accessor冗余已在生产移除：General channel instruction原先读4个scratch components再选1个；现在直接读取原channel地址。没有改变query、normal decode、CXY、数学或其他consumer。`.local/r2/channel-reference1.json` 用其余完全相同的旧四分量读取参考核对全1080p HDR，passed；warm Appearance77.948/80.337ms、Surface90.222/93.087ms（前者为当前生产）。仅两个重复、未控制时钟，结构上消除无用读取，不将这组小幅差额宣称正式性能收益或主要瓶颈已解决。

**表示候选边界**：保留原storage/fixed和完整resident选择；Product硬件表示不先针对未执行的branch展开。源码 `surface_geometry_completion.ts` 在每个sample仍调用 `winner_build_coefficients` 并由三corner计算world plane，prepared frame当前只提供clips/indices/attributes，不提供这些数学结果。母稿§8.4.1的Prepared Triangle Math最多比较现有local build与同一Geometry owner的per-primitive产品；不恢复旧Winner owner，不先进入C/cache掩盖基线。不把“重复数学存在”直接写成全部热点根因；该候选的有界结果如下。

本轮集中结果读取 `.local/r2/cost-targeted-final.txt`、`cost-production-build.txt`、`cost-surface-final.json`、`cost-dag-final.json`、`cost-sampling-final.json`：typecheck、fresh build:test、production build及193项targeted CPU通过；真实Surface56 case、完整DAG64 case和原Product sampler三格式通过，GPU作业串行，source fingerprint `2b13817b1b8c127e2170beb208a39ec56857626fe6e346fd0d64959382513d7c`。这是该accessor/fixture/诊断模块检查，不宣布V08/V10/V11/V12、历史OOM或B1/B2完整通过。没有重跑不受影响的lifecycle/全browser矩阵、Showcase或正式claim；只有General accessor改变，不能将旧Showcase成本升级为当前源码性能已测。

#### Prepared Triangle Math 有界决定与边界检查（同日后续）

本轮实际制作64B/primitive的临时arena产品：已有frame producer内storageBarrier后按primitive生成原homogeneous coefficients/world plane；Surface同binding读取，partial/zero数学容量仍用原local math，无新增dispatch/submit或Winner owner。生产128MiB arena上限内该产品会挤占144B/vertex属性容量，必须计入总成本。原数学复用及产品接线属于本地集成，不提升完整Forge/DAIS adoption。

临时快照 `b5a1da423fbcf1ea1b5c40e9479782ac0b1921bfd3221326c0496fb4b08bf62b` 的 `.local/r2/triangle-gpu2.json` passed，覆盖原Surface链及full/partial数学容量、Product消费；`.local/r2/triangle-cost1.json` passed，16次1080p全HDR逐word一致，已有frame vertices producer每次同encoder执行并计时，先warmup、3次交替配对。固定standard全部计时pass之和中位数：无math40.036ms/有math39.630ms；General90.158/89.539ms。General一个配对回退（88.238→91.320ms）；该夹具arena4928→5440B，属性容量仍20。此是有5个meshlet的大三角诊断，计时sum含诊断读出，不能当GPU span、完整引擎帧时、细几何成本或128MiB生产属性损失的证据；没有控制clock/温度，也没有充分统计样本。

**决定：本轮不采用Prepared Triangle Math。** 仅约0.4–0.6ms中位差且有配对回退，没有证明全范围净收益；因此撤回全部临时生产ABI/producer/consumer改动和新cost注册，不继续增加细几何/Product成本矩阵去扩大该小收益试验。生产仍为arena v3及原local数学。候选diff保存在 `.local/r2/triangle-math-candidate.patch`，GPU报告固定临时source fingerprint，不能拼接为当前源码结果；未来重开须有新的热点/成本依据，不建立第二生产路径。

当前新增 `surface-geometry-boundary-gpu.mjs` 由既有 `surface-work` 调用：真实 `FrameGeometryVertices`→arena→当前生成 `surfaceWorkAppearanceWgsl` 的Geometry completion/point函数，独立double Gaussian elimination核C/X/Y权重及一像素finite difference，独立核位置、plane、UV、normal/tangent facing。Ordinary/Product × full/partial/zero属性容量 × 普通/负W/混合W近裁剪/零W/退化/背面/目录generation失效，加background/invalid/越界work/越界primitive，共66组合。回读prepared标志证明full/zero分支实际执行，partial不假设workgroup reservation顺序；过期目录必走完整resident。同函数结果probe只证明这些数学/属性边界，不冒称已渲染near-clipped raster覆盖图或全PBR材质矩阵。

`.local/r2/boundary-gpu1.json` 原始失败为probe请求UV0却断言UV1：按生产需求位补上UV1请求，未放宽任何预期或生产读取。`boundary-gpu3.json` passed，原56 Surface case与66边界组合、零GPU API错误；current source fingerprint重新回到 `2b13817b1b8c127e2170beb208a39ec56857626fe6e346fd0d64959382513d7c`。Triangle临时结果与此当前快照明确分开。

Visibility生命周期fixture迁到当前producer编译接口/asset payload/arena别名，删除退休dictionary预算；raster只作显式顺序替身，不把node测试当raster算法证明。保留原失败替换/退休语义，并新增受控当前FrameVertices绑定失败：旧workset与accounting保持、失败未退休旧产品、重试成功、旧arena仅fence后销毁。`boundary-lifecycle-tests.txt` 30项通过，约0.31s；覆盖frame arena/vertices、Surface资源/容量、View transaction与跨owner Visibility。不能用这次失败注入解释历史D3D12 OOM，V10历史OOM仍开放。

本轮关闭的是候选准入决定、Geometry边界数学与指定生命周期回归。B1性能可行性门、V08剩余全主链变换/覆盖、V10剩余失败组合/OOM、V12六信号全范围成本仍开放；B1/B2不标完成，不进入C掩盖直接求值成本。后续先归因当前实际执行General的typed tape/scratch/Geometry输入成本，并明确完整支持下的有限实现决定；不得继续无边界参数扫描或把未测收益计入阶段出口。

</details>

<details>
<summary>H.5 R2 原任务与检查责任映射（展开追溯）</summary>

### H.5.1 原6.8 R2 六个实施任务：依赖、原子切换与出口

顺序为 **R2-00 → R2-01 → R2-02 → R2-03 → R2-04 → R2-05**。R2-01/02的编译与发布在同一工作树逐步接线，允许单元内部短暂不编译；R2-04必须同时接齐Geometry/Appearance直接读者，不将绑定、reset或Lighting读取推迟到B2才补。六个任务合起来是B1切换单元，不要求每任务全测、提交或新增一份设计文档。下列入口是修改范围导航；实际接口稳定后再写ABI合同，不将目标接口名称冒充已有实现。

#### R2-00：冻结语义、支持profile、来源及成本口径（SD09/SD10）

1. 从当前生产入口列全合法operation、输入类型/点域、15个material field、guides和所有直接consumer；每个旧输出标记为跨阶段保留或producer-local，并注明局部最后读者。保留独立全输出oracle，不能因生产不导出而失去语义检查。
2. 对照母稿§6、§8.5、§12.4–12.5，冻结普通/完整General、Ordinary/Product、原始纹理/moment产品、UV0–2、normal/coat/specular/IOR、背景与异常guard范围。已有合法graph不能被新增slot阈值或模板白名单拒绝。
3. 核读来源账本R2条目的固定源码、许可及源阶段映射；全量算法没有donor的部分明确为本地Typed Appearance Tape、Uniform Publication、Program-Coherent Packets、Local Surface Completion。来源核读与本地采用验证分开。
4. 记录支持profile的N/M/Q/Lwords、workgroup/dispatch/binding limits、所有mandatory与optional容量、active/retired峰值。逐binding核对Ordinary/Product输入表；Product目标16个storage bindings，不能先融合再发现第17个frame属性绑定。
5. 在性能验收前写明固定场景/相机/材质/灯/分辨率/特性、warm-up/采样/时钟状态、Surface与frame span口径、绝对时间和峰值预算。预算由目标和实际平台共同确定；本文不批准一个未经确认的FPS，也不允许把失败样本换场景、关效果后称过门。预算未声明则性能门未通过。

产物是现有文档中的接口/consumer表与实施记录，不新增空registry。出口：没有无主语义或无consumer必需产品，绑定与容量方案可创建，来源及预算待定项显式记录；此步骤本身不证明GPU可行。

#### R2-01：ProgramTemplate / MaterialSnapshot / ExportPlan（SD01/SD02）

入口：`material/AppearanceGraphCompiler.ts`、`material/ExactAppearanceDag.ts`、`material/FixedSurfaceFormulas.ts`、`gpu/GpuAppearanceDagAbi.ts`、`gpu/GpuAppearancePublication.ts`、`gpu/AppearanceProgramRegistry.ts`。

1. 保留已验证scalar IR作为语义输入，拆出不可变完整结构template、material数值/资源/version snapshot，以及按实际consumer决定的execution/export plan。结构identity不含具体颜色/数值/texture handle；sampler操作语义、输入类型/拓扑等会改变程序行为的条件仍参加完整比较。
2. 哈希只定位候选，完整相等才intern；Winner/Sharing/Cache三种identity保持独立。结构替换、参数修改、纹理/产品驻留变化各更新其准确依赖，不用全局generation代替。
3. 从完整root/坐标/operation结构匹配Publication-only、Unlit、Standard PBR；全部specular/coat/IOR及旧guard语义保留。不能依赖材质名字、当前参数为零或查询次数少来证明家族。
4. 未匹配合法图统一进入同一个完整General VM。PSO及FrameGraph拓扑按有限renderer/resource家族，template成为GPU数据；固定角色sampler循环可以存在，普通家族不能每sample解释完整operation tape，也不能按graph生成场景巨shader。
5. publication prepare生成一致版本产品；commit才推进有效身份，abort保留前一合法snapshot；全部Coverage/Surface/Lighting需要的route读取与binding一起迁移。

出口：不同参数实例共template；参数zero→nonzero、纹理替换、不同拓扑及hash碰撞都保留正确结果/身份；1/25/257个graph不增加逐graph生产dispatch或PSO家族。数字257是结构压力case，不是支持数量上限。

#### R2-02：Typed Tape、word liveness、uniform内部子图与输出sink（SD03/SD04）

入口：R2-01编译/ABI/发布文件及`shaders/appearance_exact_dag.ts`、`shaders/appearance_publication_exact.ts`、`shaders/surface_fixed_formulas.ts`。

1. 从scalar IR降低为唯一GPU执行表示。节点声明operation、语义宽度、C或CXY点域、完整输入/输出、raw/moment query语义、sink与last-use。RGB分量不是三个采样位置；RGB C=3 words、UV CXY=6、RGBA CXY=12，不能每scalar仍分配三vec4。
2. 向量运算/一次query多分量输出仅在完整结构与原舍入顺序可证明时融合；未匹配局部在同一个VM执行原scalar operation，不是第二执行器。保留nested coordinate、late query、所有UV和normal-product有效性。
3. 对完整依赖做uniform/varying分类，提取**图内部**uniform子图，发布GPU update tape与matching-version结果；varying tape从这些结果读。sin/pow/sqrt等执行原GPU操作，不能CPU JS double预算后当等价。参数、资源/驻留、时间/view/实例输入按实际依赖分类；任何varying路径不能被误发布为uniform。
4. 以f32 word连续分配、真实last-use释放，临时寻址为`wordOffset * Q + lane`。输出一旦内部最后读者结束且完整tuple sink写完即可释放；共享CXY、后置采样、normalTS/IOR guard仍需要的值不能提前复用。
5. General/fixed采样/uniform临时分别计算真实宽度，证明生命周期互斥后通过同一临时binding alias。Q控制并发，不截图/指令/纹理查询；完整合法长图不能因为本地scratch策略被截断。
6. oracle分为完整语义输出模式与真实ExportPlan模式，二者均使用生产生成器，独立期望不可来自同一执行器自比。生产不添加test-only fallback或故障开关。

出口：完整操作、tuple sink、uniform更新及abort、liveness与Q=1/7/64尾部等用例数值通过；临时字节能从实际words/Q/align解释，旧scalar三vec4/全图末尾保活和实验16-slot workgroup window从默认执行表示退休。

#### R2-03：GPU程序一致工作与有限调度（SD05/SD09）

入口：`gpu/GpuSurfaceWorkAbi.ts`、`render/surface/SurfaceWorkRuntime.ts`、`SurfaceWorkTypes.ts`、`SurfaceFrameResources.ts`及`shaders/surface_work.ts`；prefix复用已核便携算法，不新增CPU work选择。

1. producer输入为完整原work集合、dense template index、有限resource partition和每条需求mask；输出count→exclusive prefix→scatter→run→packet→indirect args。packet保持同template，lane可带不同snapshot/route/needs；所有payload保留原目的地址，不用重新编号丢失identity。
2. 每个run按Q/workgroup打包并显式处理最后packet有效lane；shader不能让不同template lane在barrier路径上产生不一致控制流。程序一致不意味着同材质参数，也不改变各信号独立需求。
3. bucket数为`M * finiteResourcePartitions`，不是`M * 2^15 dirtyMasks`。count/prefix层数按支持profile最大容量有界；native dispatch/clear/copy/indirect数实测与pixel/tile/instance/graph数量解耦，不能只数FrameGraph nodes。
4. 单template/已经一致的输入直接packet化；普通常量或轻采样不先全屏radix sort。排序/count管理本身计时；SF12的40-dispatch radix链只作后续有净收益证据的候选，不是默认前置税。
5. optional coherence空间不足时，由权威builder在写前选择原完整indexed recipe，同一worker执行；coherent与indexed写域互斥，不截原queue，不依赖每像素exception append。mandatory原work/目的地仍需预先合法。mixed indexed lanes执行不同template时不能进入共享operation窗口/barrier；基线word SoA按唯一global context slice独立执行，packet-only同步优化单独证明uniform控制流。
6. 零work/count、scan padding、u32溢出、重复需求与capacity边界均有明确初始化/去重/发布条件；无全局自旋，无本帧GPU→CPU→GPU控制，无额外submit。

出口：独立集合预期证明每条必需work恰好消费一次、地址和mask完整；single/mixed/long-tail、1/25/257 template与optional=0/tiny均通过。成本同时报告count/prefix/scatter/packets和实际evaluation，不能用解释器耗时下降掩盖更大的全链开销。

#### R2-04：arena-backed共享属性、局部Geometry→Appearance和直接读者（SD06/SD07/SD09）

入口：`render/FrameGeometryArena.ts`、`FrameGeometryVertices.ts`、`gpu/GpuFrameGeometryArenaAbi.ts`、`GpuFrameGeometryAttributesAbi.ts`、`shaders/frame_geometry_vertices.ts`、`raster_coverage_fragment.ts`、`surface_frame_geometry.ts`、`surface_work_geometry.ts`、`surface_geometry_completion.ts`、`surface_work.ts`及`render/program/FrameProgramLowering.ts`；Appearance/Lighting/Reconstruct/reset/binding读取一起迁移。

1. 将prepared frame属性作为现有Geometry arena source读取接口中的region，由同一Geometry owner创建、计账、prepare/commit/retire。目录、stride、generation、capacity一起发布，不再给Product Surface单独新增frame属性storage binding。两owner不能重复销毁或各声称独立占用同buffer。
2. 必需arena头/目录/control容量先满足；prepared vertex region按实际stride与剩余binding limit规划，不机械拼两个最大buffer。只发布完整受理meshlet；partial/zero prepared容量走同一Geometry数学的精确resident fallback。Coverage/raster、Surface与debug/FrameProgram读者都遵循同一个prepared状态，不能有一处仍读旧独立属性buffer。
3. Product输入9 + 执行数据7 = 16，Ordinary输入4 + 执行数据7 = 11，按实际布局逐项复核；fixed采样复用现有临时binding。limits创建前协商；mandatory不足是显式prepare失败，不是optional fallback成功。
4. 唯一Geometry completion在Surface evaluator局部生成private record，直接喂普通家族/General tape，保持全部透视/CXY/near clip/负W/退化/side/facing及原guard。共享frame输入继续复用；Lighting/Temporal所需Geometry字段仍经明确closed产品消费，不重建第二owner。
5. 删除默认全屏UV/color/CXY staging及其`surface_geometry_inputs.ts`接线/资源；小Q scratch不能假装连接两个各自遍历全部work的kernel。不得以恢复UV池、global等待或第二submit兜底；融合不满足binding/register/成本门时返回设计定位。
6. 按母稿§12.4导出真实跨阶段字段。normalTS/IOR等完整数值guard、世界basis及view fallback在producer-local保留至最后读者；normal/color/UV有consumer才持久化，不能只删alpha通道或validity来缩容量。导出布局、全部直接consumer/reset/background/version/late binding/abort/retire原子更新。

出口：真实Geometry→Appearance→非零Lighting→Reconstruct生产闭环；Product完整/partial/zero prepared、Ordinary、强法线/coat/moment、背景/边界/异常guard及resize/abort正确；无默认全屏UV池、无额外binding、无重算几何读者。融合的private寄存器/spill、arena active/retired及fallback实际工作全部计入成本。

#### R2-05：B1集中核对与可行性决策（SD10）

在主链连通后按§12集中typecheck/build及必要targeted，最终源码变化后新鲜build:test、GPU串行。逐项核对§6.10，不用旧snapshot的通过结果拼出R2通过。

独立报告三组结果：**语义/接线**、**结构/容量**、**同质量全链成本**。同时列snapshot/源fingerprint、profile/limits、未测/超时/timestamp不可用及原失败。成本包含uniform publication、工作管理、Geometry、Appearance、Lighting、Reconstruct、reset/copy、峰值资源及private/scratch，而不是只测一段VM。

直接原生参考用于拆解真实query/解码成本，不是另一条production renderer；必须固定相同表达式、sampler/LOD/过滤/输出、warm-up与时钟。不能把不同时钟的74ms减45ms直接归因为29ms解释器税。完整合法graph本身代价过高要报告物理成本，不能以普通PBR表现承诺任意DAG性能。

每个尚未定案物理表示最多两个事先写明假设的候选，每个一轮必要正确性及成本比较后决定；失败分类修复与受影响回归仍需完成。有未解释deviceLost/OOM、漏consumer、未声明预算或成本门失败，B1仍未完成，不转B2、不给“剩余可选优化”的别名。不继续无边界的window/private-array调参循环。

### H.5.2 原6.9 R2目标产品接口与生命周期核对表

下表是目标合同，不表示这些API已落地。任务改名/文件移动时同步此表和母稿SD映射；不用新增适配层维持旧接口。

| 产品 / 权威owner | 输入 → 输出 / 消费者 | 发布、容量与失败边界 | 任务 |
|---|---|---|---|
| ProgramTemplate / Appearance compiler | 完整validated scalar IR → typed code、家族、依赖/type/point域；publication/worker | 完整比较intern；无参数值identity；合法未匹配进入General | R2-01/02 |
| MaterialSnapshot / publication | params、textures/products/samplers、准确versions → matching-version GPU inputs | prepare/commit/abort事务；zero→nonzero不漏依赖；stale不参与有效发布 | R2-01/02 |
| UniformUpdatePlan / publication | 内部uniform依赖与dirty/version → GPU求得的uniform words；varying tape读取 | 不改sin/pow/舍入；更新临时与varying互斥后alias；abort不推进身份 | R2-02 |
| ExportPlan / consumer合同 | 全输出语义＋实际reader needs → complete sinks、local last-use、跨阶段字段 | 生产可窄导出，独立全输出oracle仍完整；guard不能提前释放 | R2-01/02/04 |
| WorkRun/Packet / work builder | N条work、M个dense template、有限partition → runs、valid lanes、原地址/mask、indirect | checked计数；optional=0完整indexed；两mode写域互斥；无CPU控制 | R2-03 |
| EvaluationTemporary / execution owner | 全dispatch并发context上界Q、Lwords、fixed/update liveness → aligned f32 word SoA | `4*Q*Lwords`加对齐/metadata；global context独占slice，多group不能复用地址；降低Q不截图 | R2-02/03 |
| FrameGeometry arena / Geometry owner | resident输入、目录、meshlet准备 → arena frame region / exact fallback | 必需prefix先满足、可选整meshlet受理、partial/zero；全部source readers同迁 | R2-04 |
| LocalGeometryCompletion / 唯一Geometry语义owner | Winner、frame/resident属性、真实union needs → private完成值＋必要closed fields | 原CXY/side/guard；直接Appearance读取；跨阶段Lighting不重做geometry | R2-04 |
| Appearance fields / Surface producer | family/tape、snapshot、完整inputs → f32语义SoA/validity；Lighting/Reconstruct | 唯一写域、按需求保存；normalTS等局部guard保留，容量不漏合法字段 | R2-04、B2-04/05 |
| Six RGB signals / Lighting owner | fields/Geometry/providers、各信号recipe → 六RGB f32＋显式state；Reconstruct/history | 保留六路和原加法/颜色语义；AO在output pixel；率/version独立 | B2-02/04/05 |

### H.5.3 原6.10 必需case与独立预期：不能用测试数量替代

这些是case责任编号，不是已经存在或已通过的selector。生产入口/生成WGSL迁移后复用有效旧case；新fixture只有在触发目标分支并能区分错误行为时才有验收意义。

| Case | 正常 / 边界 / 失败输入 | 独立预期与结构/成本观察 | 任务 |
|---|---|---|---|
| V01 模板与snapshot | 同结构不同值/texture、不同拓扑、hash碰撞、zero→nonzero、abort | 完整结构比较reference；PSO/dispatch不随实例增加；版本只改实际依赖 | R2-01 |
| V02 完整General | nested nonlinear坐标、UV0–2、12 query早RGB/晚coord、所有operations | 原数学/独立reference全输出；未匹配仍完整执行，证明非fixed分支确实运行 | R2-02 |
| V03 类型/点域/sinks | scalar/RGB/UV/RGBA C/CXY、多个root共享值、late query | 独立逐点/逐分量预期；真实word/liveness表和临时bytes、sink后复用安全 | R2-02 |
| V04 uniform内部子图 | varying图中的param-only sin/pow/sqrt、纹理/时间/view依赖、提交失败 | GPU f32数学reference；参数改动更新且未变分支不重算；无stale publication | R2-02 |
| V05 queries/products | raw与moment、多个bank/sampler/wrap/mip、嵌套coords/normal validity | 独立过滤/解码reference；同语义query共享，非同语义不误合并 | R2-02/04 |
| V06 packet完整集合 | single/mixed模板、长尾run、N=0/1/Q±1、1/25/257模板 | 独立work multiset/地址/mask精确一致；有效lane和真正native命令，不是FG node | R2-03 |
| V07 coherence耗尽 | optional=0/tiny、bucket/packet上界、checked u32/padding | 完整indexed预期、分支实际执行、每目的地唯一writer；原queue不截断 | R2-03 |
| V08 arena来源一致 | Ordinary/Product，frame region完整/partial/zero、近裁剪/负W/退化/facing | 原独立插值与resident预期；Coverage/Surface/debug同代目录；Product实绑定≤16 | R2-04 |
| V09 producer→全部consumer | unlit、标准coat/spec/IOR、General、非零lights/IBL、背景与异常guard | 完整HDR与必要guides；原世界basis/view fallback与guard；无重构材质/几何 | R2-04 |
| V10 生命周期/峰值 | prepare失败、abort、resize、版本变化、retire未完成、mandatory不足 | 当前有效snapshot/所有reader绑定正确；live/retired总账、显式unsupported失败 | R2-01/04 |
| V11 同质量成本出口 | 便宜/普通/完整General、native参考、indexed/coherent、复用OFF | 同表达式/质量/条件P50/P95与全链管理占比；声明预算；physical query成本单列 | R2-05 |
| V12 B2 rate/写域/信号 | 合法coarse、局部高频拒绝、各signal不同率、zero/tiny池、coat增删/AO | 独立coverage/误差/六路state及原加法次序；完整精确补做，无coarse/exact双writer | B2-01–06 |

浮点比较依据原operation/filter合同和独立误差分析，不能为通过统一放宽容差；结构断言只证明结构，不代替数值结果。受控故障只在fixture/reference侧验证case敏感性。V01–V11必需项未测/失败则B1未完成；V12及B2相应consumer/成本项未完成则B2未完成。

</details>
