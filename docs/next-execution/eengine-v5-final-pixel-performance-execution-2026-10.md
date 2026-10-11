---
id: eengine-v5-final-pixel-performance-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-v5-final-pixel-performance-2026-10.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/surface
    - OEngine/src/render/vsm
    - OEngine/src/render/temporal
    - OEngine/src/render/passes/fsr3
    - OEngine/src/render/TemporalFabric.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/shaders/native_temporal_seed.ts
    - OEngine/src/shaders/native_surface_lighting.ts
    - OEngine/src/shaders/lighting_brdf.ts
    - OEngine/tests/oracle/final-pixel-sun-response-gpu.mjs
    - OEngine/src/render/lighting/FinalPixelLightingPublication.ts
    - OEngine/src/shaders/native_resolved_position.ts
    - OEngine/tests/oracle/final-pixel-shadow-quality-gpu.mjs
    - OEngine/tests/contract/final-pixel-shadow-cutover.test.mjs
    - OEngine/src/shaders/native_temporal.ts
    - OEngine/src/shaders/vsm_sampling.ts
    - OEngine/src/gpu/GpuNativeMaterialPublication.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/GpuInstanceAbi.ts
    - OEngine/src/gpu/FinalPixelAbi.ts
    - OEngine/src/render/environment/FinalPixelSolarPublication.ts
    - OEngine/src/render/temporal/NativeTemporalSeed.ts
    - OEngine/src/shaders/native_temporal_seed.ts
    - OEngine/src/shaders/atmosphere/runtime.ts
    - OEngine/tests/oracle/final-pixel-phase1-gpu.mjs
    - OEngine/tests/oracle/final-pixel-solar-gpu.mjs
    - OEngine/tests/contract/final-pixel-phase1.test.mjs
    - OEngine/src/framegraph/FrameGraph.ts
    - OEngine/tests/oracle/native-temporal-v2-gpu.mjs
    - tools/gpu-oracle/registry.mjs
    - validation/tools/run-dungeon-performance.mjs
    - docs/VALIDATION.md
---

# EEngine V5 Final Pixel Execution Authority

唯一目标是[V5 Design](../next-design/eengine-v5-final-pixel-performance-2026-10.md)。本文件管理迁移单元、合同、验证、cutover与退休；候选实验进入`docs/performance/`，不追加到目标设计。source baseline `49fcaa300fafcbbe3db142df403baa3487f89956`；authority先提交为 `e2ebed8`，Phase1非生产完整闭包提交为 `9f305c4`。本次用户授权审核当前Phase、必要返工并执行下一完整Phase。Phase2结构、数值、接线与生命周期无需进一步返工；未资格融合成本按原§5.1在Phase5/6联合收口。本轮执行Phase3生产Native Temporal Seed cutover，出口与限制见§6.1。编译、prototype或组件数值通过不能称整Renderer性能/动态画质验收。

## 1. Phase 顺序、依赖与状态

| Phase | 大架构单元 / 必须删除的工作 | 依赖 / 当前状态 |
|---|---|---|
| 0 | Source truth、目标图、数据/质量/成本合同冻结 | 用户已授权实施；文档提交e2ebed8 |
| 1 | Final Pixel publication / Native Seed非生产完整闭包，替代重复恢复链，合法binding与唯一写域 | 非生产闭包完成；§4.2绑定修正已验证，§4.3记录出口及未获生产资格项 |
| 2 | Shadow Physical Execution cutover：full I Shadow Resolve / mask / 重复continuation退休 | 1；结构/数值/接线/生命周期闭包完成；候选净性能未资格，联合成本收口在5/6，见§5.1 |
| 3 | Temporal Seed cutover：Native→全部Temporal consumers；Facts恢复pass / 旧Aux退休 | 1、2；结构/必要数值/接线/生命周期/输入子质量闭包完成；净性能未资格，联合成本在5/6收口，见§6.1 |
| 4 | Native Temporal V2完整图：native scatter / Prepare / SPD / source histories退休 | 3；未开始 |
| 5 | Final Pixel全feature/domain集成、最后旧owner与多余常驻/生命周期税退休 | 2–4；未开始 |
| 6 | 集中quality / production ABBA / P50/P95/P99 / 4GB simultaneous peak验收 | 5；未开始 |
| 7 | 只有剩余gap需要：Receiver Demand V2，删除pixel projection扫描 | 6诊断；deferred，不自动实施 |

先证明Native能合法绑定和写全域，避免Shadow切完才发现Seed超限；Shadow是Native前置，可独立完整删除；Seed对native/upscale均有真实consumer，先闭合共同输入再替换1:1算法；最后检查domain切换只保一套active histories。Phase1是完整替代链的非生产构建，不是一个helper实验。阶段内可断链；每稳定边界每服务域只有一套production图，不建legacy adapter/A/B bridge。

每Phase闭合后停在下一单元边界，继续范围依后续授权。状态仅本文件维护，workstream不复制状态表。本轮明确STOP。

## 2. 跨Phase冻结合同

**Architecture → Candidate implementations**。Phase内可换branch/tile/shared-private/static tap/point去重/short live scope、detector/filter权重；质量门不变。单candidate失败不改为另一个production架构。新增/删除仍符合Design的products/owner/domain。

成本入场：先完整Cost Card（DELETE/ADD、bytes/ALU/samples、random/sequential、atomics/barriers、dispatch/layout、working set、ideal/expected/worst、0/50/100%兑现与break-even）。只有预期DELETE>ADD、理想有正收益且确实能删除目标工作才进入unit；未测live-state不能写0。新增上界已确定超过可删收益上限，才构成fundamental cost证据。

**Phase依赖区分结构闭包和性能资格。** 每unit必需完成真实成本检查并保留失败，不把未测或负收益写成通过；但有限候选ABBA未得break-even不是后续独立工作删除的阻断门。producer/全部consumer、旧依赖退休、能力、数值、unit必要质量和生命周期闭包是下一cutover的硬前置；最终整图动态quality、联合成本调优和正式净性能资格分别在Phase5/6收口。不是将必需正确性或成本观测后移。若已有源码证明fundamental cost/capability不可能，仍按§2暂停；所有architecture falsification条件不变，负收益不豁免最终预算。

不允许改变Phase Architecture的普通触发：helper慢、shared候选失败、小quality失败、一次Dungeon热机长帧、旧representation test红。只有Design§11三类证据允许修订：fundamental correctness/capability impossible；完整源码闭包推翻cost model；核心架构完整/重复工作已删/全部consumer闭合/quality和lifecycle通过/旧链退休后，同条件production正式benchmark仍无break-even。缺任何条件只能写**Candidate X rejected**。architecture修订同时更新两authority并给用户审核，不静默改方向。

Geometry Frontend、receiver算法第一阶段冻结；local-light lookup/VSM descriptor物理共用binding属于Final Pixel publication，不改light culling/coverage算法。Surface不拥有effect history。唯一frame encoder/submit、无本帧GPU→CPU→GPU work control。

### 2.1 Publication / history事务

| 时点 | 必须行为 |
|---|---|
| prepare | 固定domain/extent/generation/camera/jitter/P、read/write roles；新资源只是candidate；cached graph late bind，不提前替active |
| encode | seed/background/invalid完整写域；读最后成功提交history，写current；无同pass非法读写，无本帧待写history读取 |
| successful submit | color/depth/state/identity和previous camera/jitter/P同一事务推进；Scene publication按原提交边界；frame_count/delta只记录真实submit |
| pre-submit abort / retry / defer | 不推进role/generation/jitter/camera/P；未提交candidate回滚/释放；retry仍用最后成功提交previous facts |
| policy / resize / cut | 整组candidate reset与全域写；普通motion不global reset；native↔upscale成功submit切policy，失败恢复旧index/validity |
| retirement | 所有direct consumers最后completion fence后释放旧域/publication/bindings；queue有序复用、3inflight；不能先销毁后等待 |
| device loss / destroy | 新device epoch重建，histories invalid；candidate/active/retiring全释放，幂等；受控epoch不冒称真实driver fault |

### 2.2 质量oracle / ROI / 失败门

Reference为**本次HEAD真实生产S3+T3**，只放test-only fixture；AMD SDK是另外的source/numeric参考。隔离oracle可双图独立histories，不加production selector。

复用`native-temporal-v2-gpu.mjs`的独立8×8 subpixel积分golden/16序列。normalized HDR error = `sqrt(sum((actual/P−golden)^2)/max(sum(golden^2),1e-20))`；same-phase比较f与f−8，保留warmup。新图不得超过旧production+2^-10比较底线；uniform/exposure error<.003，其他numeric原容差不变。不能把已拒pmndrs候选或c6旧图冒称当前HEAD reference。

完整动态1080p fixture：每case256成功提交frame、dt=1/60，前64静止warmup，64–191运动/变化，192–255停止/收敛。合成golden逐frame积分；真实Dungeon冻结camera并成对比较current生产/关键ROI人工判读。scene/golden/camera fingerprint在实现前保存，不After挑ROI。48frame/16warmup的小oracle不替代1080p矩阵。

| Family | 固定刺激 / 必须ROI |
|---|---|
| static / thin / Siemens / MASK | 8phase jitter；1px/亚像素正交/斜线、高频coverage；全interior（除2px外边）+线tight bbox扩2px+MASK边界 |
| slow / fast / reverse / stop | screen motion .25px/frame、8px/frame，frame128反向；pan/dolly分别测试；前后景反向独立motion；object前后bbox并集扩16px、disocclusion mask扩2px |
| material / geometry replacement | frame96单owner替换、128同slot新generation复用、160恢复；changed-owner mask扩2px、未变化ROI单列 |
| light / moving shadow | frame96 light×4 step，128–160 ramp；Sun/遮挡物连续运动；transition边界扩4px与静止背景 |
| HDR / normal / coat / specular | scene-linear .5/128/8192 uniform、4096孤立点/plateau、掠射normal/coat；高亮/反射边bbox扩8px；远角ROI x1850..1918,y1050..1078 |
| exposure / validity | frame96 P×4、128 P/4保持scene radiance；invalid motion/sky、cut/partial/offscreen reproject；全域与affected ROI |

每frame/每ROI记录HDR normalized RMSE、peak绝对误差、thin信号积分能量、disocclusion拖尾能量、静止8phase残差、light/exposure响应曲线与返回旧误差包络的settling帧数。整体平均不能覆盖ROI失败。除既有half比较底线外，thin-energy/拖尾/peak/settling均不得差于reference；可用同format quantization oracle确定单项表示误差，不新增任意百分比容差。display ROI另作人工检查，不能用tone-map/8bit掩盖HDR failure。

Shadow保持point multiplicity/count、gutter/clear/负reference/fine/coarse/lifetime numeric；receiver arithmetic变化用analytic plane/perspective/mirror/degenerate/isolated winner/deep-depth与moving-shadow/normal-map质量合同评价。失败分类fixture/source/ABI/算法/lifecycle/能力/成本，保存原件、修根因、重跑受影响项；不吞异常、跳断言、缩scene、放宽门。

## 3. Phase 0 — Architecture freeze + final contracts

本次范围：HEAD/status/最近提交/workstream；current物理图与逐阶段流量；Shadow/Native重复、Facts实际loads；比较A/B/C选B；Seed、identity保留证明、pull图、FSR域、成本预算/质量/证伪/迁移合同。

DELETE：旧P1/P2/T1/T2/T3作为下一阶段主路线的约束力；S3“独立owner必须独立pass”假设；source parity作为Native目标；候选日志作为目标正文。

ADD：Expensive Surface Facts Once、Logical Ownership/Physical Execution分离、完整unit合同、V5两份authority与导航。production GPU工作删除/新增均0，不报告新性能收益。

出口：文档/link/path/byte算术审查、docs验证、diff检查、无production修改；用户审核后Phase1。历史测量保留各自device/source/window，不重跑旧baseline；起始`.vscode/`保留。

## 4. Phase 1 — Final Pixel ownership / Native Seed非生产完整闭包

**第一实施Phase**。完整构建Native geometry once→Sun+Seed和Temporal consumer合同；Phase2/3才分别原子接生产。非生产prototype不挂第二runtime renderer。

入口：`native_surface` generator/布局、`SurfaceV4` prepare/encode、`NativeExecutionBins`非着色写域、`GpuNativeMaterialPublication/Scene` directory、local-light lookup/VSM publication及direct consumers、`TemporalFabric`/history roles、`FrameProgramLowering`有限集成seam。

DELETE（替代实现）：独立Shadow receiver恢复、Facts重建调用、opaqueReactive→Facts中转、重复Surface的Sun continuation；当时production直到对应cutover仍完整保留，非生产删除不称生产完成。

ADD：Seed16/response4/identity16B writer、previous-depth预测/sky/unlit位置、directory32B/slot、VSM+lookup当帧物理container/offset/count/version、完整Temporal事务、test-only reference。非UniversalRecord，不导出effect OS。

一个完整单元连续完成：

1. 三产品/encoding ABI单一事实源；directory Native/bins/visibility/raster消费者同步；完整bounds/overflow预校验，不截身份。
2. 四group全count：Product+compact lit15+Bm storage基线，descriptor不另占binding；四storage outputs；atlas替mask/constants替mode；sampled/sampler完整。目录producer直接写最终区间，不偷偷增加capacity级copy。
3. single-bin所有early return写seed；compact classify只写未分配lane，Native写分配lane所有completion结果；partial lane同步正确。保持bins工作算法/容量，不用HDRclear掩盖seed未写。
4. previous camera/affine、预计previousview/currentview z、jitter UV符号、deformed-invalid/sky rotation；FrameInstance.source与旧Scene facts时点相同；signature原语义完整迁移，不加新lossy hash。
5. prototype→全部三个产品→真实consumer闭合，reset/capacity/destroy/abort/retry/fence；没有consumer的prototype产品不进production。consumer清单在unit出口记，不另建progress文档。

Cost gate：替代图无Shadow/Facts昂贵恢复，Seed写36B高于旧32B、unlit位置/绑定税真实记录；禁止全域init+再全域覆盖成为目标。所有受支持material/resource profiles合法绑定，不偷留continuation。能力根本不满足给device limit/布局/支持域反例，停cutover并正式amendment。

开发：typecheck、生成WGSLcompile、小motion/depth/identity/PCF/partial oracle、必要事务。闭合：architecture review→fresh build:test→实际prototype GPU producer/consumer与3inflight lifecycle。**不每helper跑Dungeon，不用prototype帧时否定B/V2**。出口停Phase2。

### 4.1 非生产闭包与cutover seam

实际替代链：原GPU visibility/coverage与bins→local直接写lookup区间→VSM post-content descriptor直接写descriptor区间→Solar原始LUT发布→Native staged winner/position一次恢复→Seed写→原VSM point-PCF→attributes/material/local/IBL/Sun→HDR；Seed classifier读Seed/response/current及previous identity，产旧Temporal mask语义。classifier不绑定Visibility/Depth/Scene/geometry。非生产测试引用独立S3 reference；RendererCore/FrameProgramLowering均未选择新profile，无第二runtime renderer或selector。

Native32B directory携带原signature/valueRevision，raster专用directory仍16B；目标publication不分配无consumer的separate versions。`finalPixel`选择完整Sun+Seed四输出；`fusedSun`是Phase2原子cutover seam，只选择同一Sun实现并保留旧16B directory/opaqueReactive语义，两输出且无Seed资源。Phase3才一次切到32B directory/Temporal owner/全部Seed消费者，删Facts与separateversions；这两个是迁移阶段配置，不能作为长期双production路径。

写域：dense Native写所有合法extent像素；compact classifier只写未分配像素，Native负责所有已分配像素包括completion failure；empty-domain专用sky/invalid writer。测试先poison三输出，不能靠clear掩盖遗漏。Seed16B、response4B、identity16B；identitypair32B、scratch20B，owner共52B/pixel（1080p102.83MiB），classifier另4B transient mask（7.91MiB）。current/previous camera/jitter/P和identity角色只在成功submit一起推进；abort/defer/domain/resize回滚，旧资源按最后consumer fence退休，三inflight复用由队列顺序保证，deviceepoch重建无历史沿用。

DELETE（prototype替代链）：Shadow receiver二次position/normal恢复及mask、Facts昂贵geometry-dependent恢复、Sun continuation的再次geometry/material和HDR中转；local私有lookup与独立descriptor consumer binding、separateversions目标副本。ADD：Native motion/predicted-depth/identity与unlit position、36B Native产品写、4B classifier写、lookup/descriptor范围uniform≤16B与padding≤240B、Solar128KiB/frame、staged Native live-state。旧producer写opaque4+Facts28=32B；目标Native36+classifier4=40B，临时增加8B/pixel写（1080p15.82MiB），不得只报告Seed额外4B；最终native Analyze将吸收classifier。完整Cost Card继承Design§5/§6/§8，编译成功不证明DELETE>ADD已实测。

### 4.2 Binding contract amendment

原Solar sampled候选C0的反例：Product+compact、Bm=1、16 storage/16 sampled device、M=10材质布局。旧S3 primary16 sampled/continuation14合法且真实GPU编译；原融合候选17，不能保留continuation、缩材质域或抬oracle device limit。**C0 rejected，B architecture不被否定。** 用户“继续”后在Phase1内采用C1 provider-buffer candidate，质量/支持域不变。

C1合同：container布局descriptor16B/item→Solar256×64×8B→aligned local lookup8B/item；四u32范围uniform仍16B，Solaroffset由descriptor区间末端精确推导。Solar源texture原有COPY_SRC，写版本之后在同encoder copy固定131072B；只改变Sun direct consumer transport，sourceAtmosphere/IBL/Sky消费者不改。总storage仍15+Bm，总sampled6+M+P，输出4storage；无Sun texture/sampler binding，增加VSM nonfiltering sampler。GPU必须实测16/16/4和16/19/4、真实M10/M13纹理读取+Bm1+Product+compact，旧reference合法continuation只在test内。

Cost Card补项：ADD128KiB frame-container片段与128KiB copy、一次图级copy边、four-half-texel bufferloads/unpack/linear clamp ALU；无atomics、shared、WGbarrier、compute dispatch或额外submit。原LUT128KiB仍在PhysicalEnvironment，共256KiB provider working set，替代原filtered four-texel逻辑32B读取的访存类型；expected短scope降低live-set，worstbuffer/ALU/occupancy税覆盖删除收益。不能由最少pass声称收益。Solar CPUoracle误差≤2^-20，旧filtered-provider比较沿用.003，不改全Renderer动态quality门。旧receiver depth-world和新bary-world在恰好page边界的f32差异单列，不豁免Phase2 quality子矩阵。

### 4.3 Phase1出口与剩余边界

2026-10-11 architecture review按原单元合同核对：完整Native profile无第二geometry-resolve、旧Shadow product或目标continuation；local/VSM/Solar实际生产者→最终container→Native、Native三产品→classifier→inspect全部闭合；目录/rasterABI、完整writer域、preflight/capacity、submit/abort/defer/resize/domain/三inflight/fence及两真实deviceepoch通过。生产FrameProgram/RendererCore未切换，新owner仅由test-only graph构建；没有legacy bridge或第二production选择器。

Engine build/typecheck、fresh build:test、受影响41项Node、16/16/4与16/19/4 device完整GPU闭包、Solar独立numeric、controlled epoch及原VSM/native profile/bins/local GPU回归通过。原失败、设备、source/outputSHA、范围及raw入口集中在[Phase1报告](../performance/2026-10-11-final-pixel-phase1-closure.md)。全量Node额外检查有未修复范围外失败及未退出worker，**不宣称全套通过**；未修改Geometry Frontend或删除断言。

没有production性能/quality资格：页边界receiver arithmetic差异未获完整动态shadow质量资格；1080p动态矩阵、productionGPU、DungeonABBA、P50/P95/P99、4GB simultaneous peak与register/spill/occupancy仍由Phase2/6核验。Phase1完成只表示非生产替代链、绑定可行性与生命周期闭包，不表示Phase2/3或TemporalV2已完成，也不构成Architecture falsification。出口停Phase2，后续需用户授权该完整单元。

## 5. Phase 2 — Shadow Physical Execution cutover

目标：唯一production Native Sun直接消费post-content-commit VSM合同、geometry once，ordinary/Product/compact/unlit中立/resource profiles/debug全闭合。

DELETE：`VsmShadowResolvePass` owner/full I dispatch、`vsm_shadow_resolve` hotpath、packedShadowVisibility/decoder、lowering全Shadow读域、mask store/read、288Bshared/2barriers；`additiveSun`第二geometry/material、HDRcopy/第二HDR/continuation publication。representation tests迁移，numeric/lifecycle仍保留。

ADD：Native scope VSM query/原pointPCF/bias/scalar visibility；physical lookup/descriptor最终写版本依赖，按需debugconsumer。debug shadowview真要visibility时由Native只在debug有需求时写诊断输出，常规无ShadowVisibility/fullscreenresolve。

原子边界：raster→commit→publication→全部Native routes→Sun/HDR→下游同时切，构造完整pipeline/publication再切，旧mask消费者立即删。初始candidate directdescriptor query+短live scope+原PCF；compression只用原资格域；后续代码组织是unit内candidate，不改fusion。

Cost检查：删除receiver恢复/产品，ADD per-pixeldescriptor重复lookup和Nativeworking set；PCF共同项不算删除。source证明无continuation/第二geometry，全部layout合法。闭合后fresh build:test、sampling/receiver/alpha/off-camera/local-invalidation/实际Native GPU、Shadow quality子矩阵、所有组合/abort/retry/epoch；再一次有限同条件DungeonABBA，统计**whole span与first receiver→last Native envelope**，Native/allVSM sum仅辅助。未获break-even必须保留为未资格candidate，不自动留S3/改C，也不无限循环局部scope→Dungeon阻止Phase3/4工作删除。依§2结构闭包进入下一cutover，联合成本在Phase5集中调整、Phase6正式资格。完整证伪门满足才提architecture amendment。报告进performance，本执行文只记出口/链接。

### 5.1 当前实施出口与返工判定

Phase1无需返工或推迟：四输出Seed完整闭包已证明16/16最低binding和事务，仍是Phase3入口。Phase2不能直接照搬prototype位置候选：1080p独立plane/page checker揭示重心position的f32页误判，原失败保留；改为同一次resolved triangle plane与jittered camera齐次求交。一个matrix-vector、两个dot、clip-Z求解及投影除法；不读Depth/邻居、不重建winner/instance/geometry；奇异/非有限结果复用该triangle原重心数学。原attributes/有限一像素梯度数学保持，先前early候选将其推迟到PCF后，本次late候选先结束材质scope；非生产完整profile的Seed仍在同一Native invocation有效性检查后写。

生产已完成logical VSM→descriptor/atlas/constants→Native Sun的唯一cutover；独立lighting scratch owner提供descriptor/Solar/local lookup各自直接写区间，三fence上限、abort/resize/deviceepoch与显存记账；Solar固定128KiB同encodercopy，无容量级descriptor/lookup拷贝。普通/Product/compact/unlit/中立、maximum material profile、真实Renderer事务已运行。旧pass/shader/mask/decoder、Sun continuation及第二HDR立即删除；冻结S3只在test-only reference中，无production selector。NativeTemporalFacts、旧Aux/versions/16B directory未提前迁移。

语义与接线验证、原失败与成本数据见[Phase2报告](../performance/2026-10-12-final-pixel-phase2-cutover.md)。2026-10-12重新审查当前Phase后，完成late-PCF候选的单Native闭包返工：attributes/material/local/IBL先结束，只携带私有Sun response与receiver facts；不加pass/product/binding、不重载geometry，原radiance/coat/combined finite guard及加法分组保持。冻结旧BRDF独立GPU对照、最低16/16/4完整Seed、production profiles/Renderer事务和1080p Shadow子矩阵通过；完整有限ABBA仍未得稳定whole span与VSM→Native净收益。原失败与本次Cost Card/验证/ABBA见[返工报告](../performance/2026-10-12-final-pixel-phase2-live-scope-rework.md)。

**结构/数值/接线/生命周期闭包完成，候选净性能仍未资格；这两个状态不能混用。** 返工原执行gate：不再把有限候选净性能资格设为Phase3前置；继续局部调优延期到Phase5的Sun+Seed+Temporal完整图联合收口，Phase6正式验收预算与净收益。这响应本次用户对返工/延期的授权，纠正局部候选性能阻止完整重构的问题，不修改B/V2 architecture、质量域、性能预算或证伪条件。热态/clock不归一化成成功。完整动态HDR矩阵、formal长窗口、hardware spill与4GB simultaneous peak仍未完成，不宣称质量总验收、稳定收益或60FPS。Phase3尚未开始，下一unit是§6的原子Seed cutover；本轮停在该边界。

## 6. Phase 3 — Temporal Seed cutover / retire NativeTemporalFacts

目标：geometry-dependent facts在Native生成，当前native T3/true upscale都消费Seed；不提前改Temporal算法。

DELETE：`NativeTemporalFactsPass` full I resolve/重复key-instance-version-camera读取、depth→world→previousclip、motionRG32、opaqueReactive staging/clear、实际不读的asset/payload bindings/graph边、separateversions最后consumer、旧Facts identity生命周期owner。

ADD：Phase1 Native writer接生产；Temporal service接管**同format同语义identitypair**；轻量Seed classifier读previousidentity/response生成旧算法合法mask，无Visibility/Instances/Geometry；FSR Prepare直接loadSeed.xy并保持负scale/jitter转换；Seed.zw给Phase4。native classifier在Phase4融入Analyze，upscale classifier是真consumer，不是legacy bridge。

不能把删Facts写成删除28B全部traffic：identity16/reactive4/previouscompare仍存在；新Seed多8B。廉价classifier暂仍一个full I dispatch，明确ADD；收益是删昂贵恢复和中转/owner读取，最终V2再删除这条独立边。

原子边界：Surface→classification→全部native/upscaleinputs、Renderer prepare/commit/abort、graphlatebind/debug同时切；旧Facts立即删除，不留空wrapper。directory32B/versions字段所有consumer同步后退separatebuffer。

闭合：motion/currentidentity/mask同数学按原numeric；baryworld与depthworld f32差异用analytic/winner门，预计previousdepth/dolly/rigid/deformedinvalid独立；fresh build:test、真实Native→FSR/nativeinputs、role/policy/abort/3inflight/epoch/release、完整Phase子质量与一次有限ABBA。Native新增Seed/live-set成本真实记录，禁止patch benchmark。停Phase4。

### 6.1 Phase3生产出口与成本限制

2026-10-12，从HEAD `c71c6d3110c3a09a5a5d1eb983cb7c57ff6f4aec`原子切换：Renderer唯一完整Final Pixel profile，Native已有winner/position/instance/material事实直接写Seed16B、response4B与完整identity16B。`NativeTemporalSeed`接管同格式identity pair与实际command的成功提交/abort/camera/jitter/fence/epoch事务；cached graph late bind当前产品及角色。Native directory32B内含signature/valueRevision，raster保持16B，旧separate versions buffer退休。FSR/native T3/debug直接消费Seed.xy/classified mask；`NativeTemporalFactsPass`、`NativeSurfaceAux`与`native_surface_aux`生产文件及旧graph inputs均删除，无fallback/第二renderer。CPU数学oracle迁到`NativeTemporalMath`，冻结旧reference只在tests。

返工完成的是cached graph角色捕获、GPU packed camera inverse镜像/late binding、资源accounting与fixture真实clip producer。质量fixture每帧复用真实FrameGeometryVertices生产clip，未修改Geometry Frontend算法；无效primary position/clip association候选已撤销。当前T3算法未改，仍有Prepare/scatter/SPD/source histories；Phase4才整体退休它们。

Engine typecheck/build、fresh build:test、受影响31项Node、九项串行实际GPU（minimum/Seed epoch/bins/integration/resource profile/production/multi-Product/device epoch/Seed quality）通过。四组1080p×256frame的规定.25/8px motion、reverse/stop/dolly/material/exposure子矩阵：完整identity、reactive/hard replacement和独立byte/validity语义通过；motion最大差.000286102px。冻结c71 Facts、真实Native Seed和独立解析平面motion分别进入同一T3算法；每frame相对独立motion参考的normalized HDR error不差于旧超过既有2^-10底线，case峰值包络相同或更低。早期输出parity失败、错误旧clip fixture和layout失败全保留；parity诊断不冒充quality判定。独立motion参考不是8×8积分AA golden，不替代Phase4–6完整ROI/thin/拖尾/settling/Dungeon动态质量合同。详情及raw入口只读[Phase3报告](../performance/2026-10-12-final-pixel-phase3-seed-cutover.md)。

成本：同时产品48→56B/pixel，1080p净+15.82MiB；Native+classifier store/clear净增`8−4α B/pixel`，α=1为7.91MiB/frame；directory/versions合计净+8B/slot。classifier仍一full-I dispatch，数量没减少；删除的是Facts额外恢复/随机读取/staging，不虚报删28B输出、history容量或compiler未读的metadata。四storage outputs、额外camera/previous affine/depth/hash及live-state必须计ADD。当前AA off仍生成分类以闭合既有identity提交，按需域税在Phase5审查。

一次有限c71→Phase3 ABBA，每轮60完整GPU样本：Before whole P50 21.400/21.693ms，After 24.510/23.634ms；Native Before9.402/9.678，After10.819/10.513ms，classifier仅比Facts少约.07ms。温度88–91°C、300–1350MHz及长帧全部保留；观察回归不是收益，也不能把短窗热混杂精确量化为稳定净差。**净性能未资格**，Phase5/6联合完整B+Seed+V2成本闭包必须处理，不能忽略。按§2结构闭包与性能资格分离，后续独立scatter/SPD/history删除不因此被阻挡；完整架构证伪条件未满足，不改B/V2方向。本轮STOP于Phase4边界。

## 7. Phase 4 — Native Temporal V2 full graph

目标：I=O唯一Analyze→Resolve→当前sharpen；先test-only隔离完整图/数学/产品/生命周期/质量，再原子切1:1所有consumer。

DELETE：native Prepare Inputs、reconstructeddepthbuffer/clear/up-to4atomicMax、9depthsearch/dilatedmotion/depth/farthest+mip、实际live Luma/ShadingSPD/change、source luma/lumaHistory/accumulation/frameInfo histories、旧T3classification/resolve/96B权重、native scatter→read边。true upscale必要算法保留，共同RCAS/radiometry不删除。

ADD：Analyze8B、depthR32pair8B/pixel、stateRG32pair16B/pixel、pull/local-multiscale统计/confidence/moments、完整policy事务；Seed税已Phase3算，不重复计。persistent含identity为72B/pixel，比旧70多2B，不称大降容量。

完整实现：Analyze读finalSky/AerialHDR/Seed/response/identity/previousdepth-color-state，预计previousz pull、edge/coverage/disocclusion/replacement并全域写analysis/currentdepth；Resolve currentstatistics/clipping、原高质量fractional支持域起步、thin/静止/光照response、P转换与f32moment/有限confidence；Sharpen按当前默认，读**写后color history版本**，不另造同色output，最终alpha与HDR全consumer正确。

只为active域分配对应histories，native↔upscale整组transaction、graphreuselatebind；RG32Float以textureLoad/manual权重，不隐含float32-filterable可选能力。先16序列smallgolden，失败换detector/filter/working-setcandidate，不能恢复native scatter/SPD。共享tile不是硬要求；跨函数9/16项长live数组不默认采用。

Cost gate：实际compilednativegraph没有reconstructedbuffer/clear/atomic/SPD；69→64B/pixel store下限对齐共同项，并完整计算pull/state/statistics新增；不以constant/emptyfixture消掉真HDR/history工作。native仍常驻FSRhistories则未闭合。预期DELETE>ADD和quality通过才productioncutover。

出口：architecture review→fresh build:test→独立golden+当前HEAD reference完整1080p质量→实际ordinary/Product/motion/policy/cut/resize/abort/epoch/3inflight/release→一次完整PhaseDungeonABBA。unit完成不等于16.67验收；旧productionnative图立即退休，无fallback。单candidate失败不会否定V2。

## 8. Phase 5 — Integration / final retirement

目标：所有feature/domain只执行所需工作，清最后常驻/role税；若前Phase已经完全删除，不为凑Phase制造helper，以全集成闭包关闭。

DELETE：最后oldmask/motion/versions/layout/constants/pipelinecache引用、native sourcehistories常驻、无consumer纹理/clear、旧Facts/continuation hooks、fence后残存API资源/常规diagnostic税；不删true upscale必要产品。

ADD：全组合接线、单Temporal事务、精确retirement/accounting/release检查；不加fullscreenpass/history。集成如需大copy/pass，重新算对应unitCostCard，不藏glue。

覆盖VSMon/off/high/bounded、无physicalSun/unlit、中立、AO/Bloomon/off、ordinary/Product/multiProduct/MASK/coat/localLights、native/nonintegerupscale、partial/resize/pause/step/defer/cut、motion/shadow/identitydebug按需求；graphcache/generation/epoch。publicationatomicity与普通motion无错误globalreset。fresh build:test、serialGPU、完整dynamicquality、全部owner simultaneouspeak/release0，现有retiredguard适配，无legacy桥。最后Phase6。

必须联合收口Phase2尚未资格的融合成本：使用已实际写Seed的最终Native和V2 Temporal，重新计算完整DELETE/ADD、private live-state/binding/working set及receiver→Native envelope，不沿用Phase2微窗口为收益证据。此处只允许冻结B/V2内的实现candidate调整；不能以“性能稍后验收”忽略已观察回归。闭包后一次集中有限ABBA、动态quality，Phase6再完成正式长窗口；最终无break-even必须按完整证伪合同处理，不能称模块完成。

## 9. Phase 6 — Performance / quality acceptance

DELETE：无根据的60FPS/稳定收益/局部bucketclaim；本Phase本身不删shader。ADD：可比production数据与验收报告，normalhotpath无计数税。需修代码回对应unitcandidate再新鲜闭包，不临时改架构。

GTX1650Ti4GB，记录actualadapter/driver/browser；1920×1080/DPR1/scale1、固定Dungeonnear/SSE、原high4096/6clip/4×4/radius.75、AA/sharpen、GTAO/BloomOFF、geometry512MiB、max-throughput；quality另含AO/Bloomon，不把关效果当gain。Before本次HEAD生产fixture/build；每Phase保最近稳定reference，但不同条件历史Before不作净差。

先核pending/verified/inFlight/retiring、source/caster revisions、payload/drop/coverage；`fullQuality`不等于settled。预热≥240成功帧并满足settled事实稳定；动态流送独立，不删首轮burst。每ABBA块每path≥1000完整GPUframes、至少3块、GPU串行；降低sampleinterval税就延长窗口，样本仍够。correctness窗口开counters、timing全部统计关闭；不完整采样明确incomplete，不补造/混coarse。

逐frame保存wholecommandspan、互斥stage、Native含PCF+Seed、VSM管理（不再含PCF）、Temporal含Analyze/Resolve/sharpen、CPUrender/admission、overlap/gaps、sensor与source/buildfingerprint。先同frame求和后`(n−1)*p`分位，不加/平均P95。P50/P95/P99/max、bootstrap区间、paired块差与raw长帧全留；thermal/clock/prewarm/CPU-IO混杂记录，不频率归一化代替实测。热状态不重叠的块不能证明精确净益。

通过：Design预算15.50ms+1.17headroom；**whole span P50≤16.67、settledP95≤16.67/P99≤20**、dynamicP95≤20/P99≤25且相对旧同条件不退化；quality≥当前、lifecycle/overflow/workcoverage通过；APIcandidate/active/retiring simultaneouspeak与OS驻留在4GB可稳定。尾帧未过不称稳定60FPS，compile/numeric不代替性能。

若完整架构重复已删、producerconsumer闭合、quality/lifecycle正确、旧pathretired、formalbenchmark仍失败，才形成architecturefalsification报告给用户决定修订；只是shader组织慢继续改candidate。缺adapter/timestamp/质量项明确未完成，不自动降质量。

## 10. Phase 7 — Receiver Demand V2（条件延期）

Phase6剩余gap确指receiverprojection才启动；不顺便重构frontend。visible meshlet/cluster conservative light-space coverage维持requested-pages接口、clip/coarse/exactworldpage/residency/offcamera caster。

DELETE（条件目标）：Npixel depth→world→lightprojection与receiverdispatch，不能删实际page需求。ADD：boundsprojection/保守页bitset、overrequest造成allocate/raster。diagnostic先比较actualpixel与conservative页差集，漏页0、overrequestratio、边界/全clip/运动与tail，再算extraRaster；少页或静态snapshot不够。extraRaster>删除projection则拒candidate，当前aggregation资产保留；完整单元闭合后quality/成本。

## 11. 验证节奏与真实命令入口

开发：source review、按需`npm --prefix OEngine run typecheck`、生成WGSLcompile、小numeric/必要lifecycle；不每patch跑browser/benchmark/evidence/全registry。compile不证明画质/收益。GPU串行，build不得与依赖`.test-dist`的oracle并行覆盖。

完整Phase：architecture review→engine typecheck/build→**fresh** `npm --prefix OEngine run build:test`→受影响Node/实际GPU→dynamicquality→完整unitABBA。GPU用`node tools/gpu-oracle.mjs <name>`，从registry核真实selector；复用samplingpublication、receiver/resolve（退reference）、native-surfaceproduction/product/resourceprofile/deviceepoch、native-temporal-v2、FSRaccumulateproducts语义fixture，实际测新owner，不只跑旧shaderfixture。

性能runner是`validation/tools/run-dungeon-performance.mjs`及analyzer；≥1000样本ABBA/P99/新ROI是后续实现对runner必要扩展，当前默认60样本不冒称已支持新门。新profile/golden只在实施需要时加，本文档任务不造空placeholder。

docs运行`node tools/docs-verify.mjs`与`git diff --check`；raw/source/build/失败不覆盖；中文commit一个完整单元一意图，写DELETE/ADD、实测/未运行。domains/adoption/claims只有实际切换与证据后更新；Phase2只更新已经发生的runtime接线，不晋级性能claim。

## 12. 本次交付边界

Phase2不需要推迟或重做架构；其未资格成本必须在Phase5/6联合收口，不能以局部候选失败阻挡独立重复工作删除。本轮执行Phase3：Native Seed接管生产及全部直接consumer，旧Facts/Aux/separate versions退休；cached graph角色捕获与质量fixture的旧clip producer接线已返工。Phase3必需出口与成本只读§6.1和performance报告；停止在Phase4边界，不自动跨入Native Temporal V2，也不宣称稳定60FPS或整图性能已资格。
