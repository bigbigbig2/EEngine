---
id: eengine-v5-final-pixel-performance-execution-2026-10
state: history
supersededBy: eengine-feature-expansion-execution-2026-10.md
verifies:
  files:
    - docs/next-design/eengine-v5-final-pixel-performance-2026-10.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/render/program/FrameProgram.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/environment/PhysicalSkyIblResources.ts
    - OEngine/tests/contract/physical-sky-cache.test.mjs
    - OEngine/tests/oracle/physical-sky-motion-gpu.mjs
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/frame-pacing.ts
    - examples/tests/dungeon-frame-pacing.test.mjs
    - validation/tools/run-dungeon-camera-motion.mjs
    - OEngine/src/render/surface
    - OEngine/src/render/vsm
    - OEngine/src/gpu/GpuVsmFilterAbi.ts
    - OEngine/src/shaders/vsm_sampling.ts
    - OEngine/tests/contract/vsm-filter-publication.test.mjs
    - OEngine/tests/oracle/vsm-filter-gpu.mjs
    - OEngine/tests/oracle/vsm-filter-cost-gpu.mjs
    - OEngine/tests/oracle/vsm-bias-gpu.mjs
    - OEngine/src/render/temporal
    - OEngine/src/render/passes/fsr3
    - OEngine/src/render/TemporalFabric.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/shaders/native_temporal_seed.ts
    - OEngine/src/shaders/native_surface_lighting.ts
    - OEngine/src/shaders/lighting_brdf.ts
    - OEngine/tests/oracle/final-pixel-sun-response-gpu.mjs
    - OEngine/src/render/lighting/FinalPixelLightingPublication.ts
    - OEngine/src/render/lighting/LocalLightWorkGenerator.ts
    - OEngine/tests/contract/local-light-work.test.mjs
    - OEngine/tests/contract/frame-program.test.mjs
    - OEngine/tests/oracle/native-surface-production-gpu.mjs
    - OEngine/tests/oracle/native-surface-integration-gpu.mjs
    - OEngine/tests/oracle/native-surface-acceptance-gpu.mjs
    - OEngine/src/shaders/native_resolved_position.ts
    - OEngine/tests/oracle/final-pixel-shadow-quality-gpu.mjs
    - OEngine/tests/contract/final-pixel-shadow-cutover.test.mjs
    - OEngine/src/shaders/native_temporal_amd.ts
    - OEngine/src/render/temporal/NativeTemporalV2.ts
    - OEngine/tests/contract/native-temporal-pull.test.mjs
    - OEngine/tests/oracle/final-pixel-temporal-pull-gpu.mjs
    - OEngine/tests/oracle/final-pixel-temporal-pull-semantics-gpu.mjs
    - OEngine/tests/oracle/reference/phase4
    - OEngine/tests/oracle/fixtures/native-temporal-observation
    - OEngine/tests/oracle/native-temporal-observation-gpu.mjs
    - OEngine/tests/oracle/native-temporal-observation-measure-gpu.mjs
    - OEngine/tests/oracle/native-temporal-observation-boundary-gpu.mjs
    - OEngine/tests/oracle/native-temporal-observation-replay-gpu.mjs
    - OEngine/tests/oracle/native-temporal-observation-cost-gpu.mjs
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
    - OEngine/src/assets/AssetLoadBatch.ts
    - OEngine/src/assets/OegPackV3.ts
    - OEngine/src/assets/geometry-product
    - OEngine/src/assets/web-cook/WebCookCoordinator.ts
    - OEngine/src/gpu/GeometryPageScheduler.ts
    - OEngine/src/gpu/GeometryProductResidentAttributes.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/src/material/CanonicalMaterial.ts
    - OEngine/src/shaders/geometry_source_decode.ts
    - OEngine/src/shaders/surface_geometry_completion.ts
    - OEngine/src/shaders/vsm_receiver_demand.ts
    - OEngine/src/shaders/vsm_caster_records.ts
    - OEngine/tests/unit/asset-load-batch.test.mjs
    - OEngine/tests/unit/cooked-cold-start-fastpath.test.mjs
    - OEngine/tests/unit/geometry-page-scheduler.test.mjs
    - OEngine/tests/unit/direction-a-pipeline-squeeze.test.mjs
    - OEngine/tests/contract/geometry-product-workload.test.mjs
    - OEngine/tests/contract/geometry-product-budgeted-lifecycle.test.mjs
    - OEngine/tests/contract/virtual-geometry-product.test.mjs
    - OEngine/tests/contract/material-closure-v2.test.mjs
    - OEngine/tests/oracle/vsm-receiver-exact-gpu.mjs
    - OEngine/tests/oracle/vsm-caster-cost-gpu.mjs
    - OEngine/tests/oracle/vsm-v4-r2-gpu.mjs
    - OEngine/tests/oracle/vsm-v4-r3-gpu.mjs
    - OEngine/tests/oracle/native-temporal-identity-gpu.mjs
    - OEngine/tests/oracle/product-attribute-decode-gpu.mjs
    - OEngine/tests/oracle/surface-workgroup-cost-gpu.mjs
    - OEngine/tests/oracle/fixtures/surface-eight-slot-cache.mjs
    - examples/demos/14-integrated/bistro-texture-compression/cooked-scene.ts
    - validation/tools/run-dungeon-performance.mjs
    - validation/tools/dungeon-gpu-audit.mjs
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/main.ts
    - docs/VALIDATION.md
---

# EEngine V5 Final Pixel Execution Authority

> 历史记录（2026-10-14 收口）：保留原设计、实施结果、未关闭失败与测量条件；本文不再是当前模块 authority，也不继续原施工顺序。当前路线与模块入口只读 [workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml)。下文状态与指令均按各自记录日期理解。

2026-10-14用户方向调整：当前转入[功能扩展总计划](eengine-feature-expansion-execution-2026-10.md)，先完善功能效果，再集中优化完整组合。本文件保留V5实施和原始结果；Phase6正式qualification与条件Phase7延期，未关闭/未通过，不作为AO/VT等新功能的统一启动前置。当前模块入口由workstream.authority决定，以下旧停止点不撤销用户新授权。

唯一目标是[V5 Design](../next-design/eengine-v5-final-pixel-performance-2026-10.md)。本文件管理迁移单元、合同、验证、cutover与退休；候选实验进入`docs/performance/`，不追加到目标设计。source baseline `49fcaa300fafcbbe3db142df403baa3487f89956`；authority先提交为 `e2ebed8`，Phase1非生产完整闭包提交为 `9f305c4`。Phase4已原子切换production并关闭单元出口，见§7.1。本次用户明确授权“进入 Phase 5，继续完整集成”，从HEAD `acecfab2495a4b5c6d5420efc9f1d2083abe6bb0`实施。Phase5产品、需求、生命周期与必要正确性集成关闭，联合成本实际检查仍未获净性能资格，见§8.1；本轮停在Phase6边界。Phase2/3/4未资格成本不得在集成后换名为通过，编译或组件质量通过不能称整Renderer/60FPS验收。

## 1. Phase 顺序、依赖与状态

| Phase | 大架构单元 / 必须删除的工作 | 依赖 / 当前状态 |
|---|---|---|
| 0 | Source truth、目标图、数据/质量/成本合同冻结 | 用户已授权实施；文档提交e2ebed8 |
| 1 | Final Pixel publication / Native Seed非生产完整闭包，替代重复恢复链，合法binding与唯一写域 | 非生产闭包完成；§4.2绑定修正已验证，§4.3记录出口及未获生产资格项 |
| 2 | Shadow Physical Execution cutover：full I Shadow Resolve / mask / 重复continuation退休 | 1；结构/数值/接线/生命周期闭包完成；候选净性能未资格，联合成本收口在5/6，见§5.1 |
| 3 | Temporal Seed cutover：Native→全部Temporal consumers；Facts恢复pass / 旧Aux退休 | 1、2；结构/必要数值/接线/生命周期/输入子质量闭包完成；净性能未资格，联合成本在5/6收口，见§6.1 |
| 4 | Native Temporal V2完整图：native scatter / Prepare / SPD / 旧owner退休 | 3；原出口及追加Native观测物理返工均关闭；后者已切生产并通过有限whole成本，见§7.1/§7.3；正式整Renderer资格在6 |
| 5 | Final Pixel全feature/domain集成、最后旧owner与多余常驻/生命周期税退休 | 2–4；结构/必要正确性/生命周期集成关闭；联合成本已测但净性能未资格，见§8.1 |
| 6 | 集中quality / production ABBA / P50/P95/P99 / 4GB simultaneous peak验收 | 用户转向功能扩展后延期；未开始/未取得资格 |
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

复用`native-temporal-v2-gpu.mjs`的独立8×8 subpixel积分golden/16序列。normalized HDR error = `sqrt(sum((actual/P−golden)^2)/max(sum(golden^2),1e-20))`；same-phase比较f与f−8，保留warmup。按用户2026-10-12授权，序列及各ROI HDR/display RMSE采用`reference + max(2^-10, .01 × reference)`；逐frame ROI RMSE采用`reference + max(2^-10, .03 × reference)`。统一1%/3%工程容差允许不同算法的微小指标差异，不证明不可见；不按场景/candidate特调。same-phase/energy保留floor-only门，原floor-only失败同时输出`strictGateFailures`诊断，raw附带`qualityPolicy`。uniform/exposure error<.003，其他numeric原容差不变。不能把已拒pmndrs候选或c6旧图冒称当前HEAD reference。

完整动态1080p fixture：每case256成功提交frame、dt=1/60，前64静止warmup，64–191运动/变化，192–255停止/收敛。合成golden逐frame积分；真实Dungeon冻结camera并成对比较current生产/关键ROI人工判读。scene/golden/camera fingerprint在实现前保存，不After挑ROI。48frame/16warmup的小oracle不替代1080p矩阵。

| Family | 固定刺激 / 必须ROI |
|---|---|
| static / thin / Siemens / MASK | 8phase jitter；1px/亚像素正交/斜线、高频coverage；全interior（除2px外边）+线tight bbox扩2px+MASK边界 |
| slow / fast / reverse / stop | screen motion .25px/frame、8px/frame，frame128反向；pan/dolly分别测试；前后景反向独立motion；object前后bbox并集扩16px、disocclusion mask扩2px |
| material / geometry replacement | frame96单owner替换、128同slot新generation复用、160恢复；changed-owner mask扩2px、未变化ROI单列 |
| light / moving shadow | frame96 light×4 step，128–160 ramp；Sun/遮挡物连续运动；transition边界扩4px与静止背景 |
| HDR / normal / coat / specular | scene-linear .5/128/8192 uniform、4096孤立点/plateau、掠射normal/coat；高亮/反射边bbox扩8px；远角ROI x1850..1918,y1050..1078 |
| exposure / validity | frame96 P×4、128 P/4保持scene radiance；invalid motion/sky、cut/partial/offscreen reproject；全域与affected ROI |

每frame/每ROI记录HDR normalized RMSE、peak绝对误差、thin信号积分能量、disocclusion拖尾能量、静止8phase残差、light/exposure响应曲线与返回旧误差包络的settling帧数。整体平均不能覆盖ROI失败。RMSE仅使用上述统一容差，thin-energy/拖尾/peak/settling保持原独立门；可用同format quantization oracle确定单项表示误差，不能继续放宽到candidate过关。display ROI另作人工检查，不能用tone-map/8bit掩盖HDR failure。已有small oracle的`energyError`是ROI总积分误差，不能冒称独立的拖尾/峰值/settling检测已经实现；缺项在完整矩阵中补齐。

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

目标：I=O唯一 **Measure → Exposure → Shading Pyramid → Analyze → Resolve →当前sharpen**，完整参考profile先在隔离图验证，再原子切全部1:1 consumer。复杂算法按用户要求优先参考移植，不继续研发自主Temporal估计器。

DELETE：native旧Prepare Inputs dispatch、reconstructed-depth buffer/clear/up-to4atomicMax、dilated motion-depth/full farthest纹理、global Luma/Shading SPD/change产品链、旧T3 classification/resolve owner及native scatter→read边；当前autonomous gain/innovation/mass shader。nearest search按用户授权移到既有Measure，不再计删除。true upscale保必要参考图，RCAS/radiometry共同项不算删除。

ADD：AMD SDK1.1.4 pin `c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`完整重建/历史响应profile的Native物理适配：Measure raw luma与half box metric、log tile及96B weights；单组Exposure；Analyze previous-depth pull/local尺度差异/reactivity/source confidence；Resolve Lanczos/Gaussian/16point history/thin lock/四帧luma/rectification/tone blend。必要luma/confidence/exposure由新owner持有，不能为删除旧owner删算法信息。永久histories含identity78B/pixel，旧70，增加8B；store/clear下限69→68.8125B/pixel，不称大降容量或已测收益。

完整producer/consumer：Native Seed事实只做一次，final Sky/Aerial HDR→Measure→Exposure→Shading Pyramid→Analyze→Resolve→RCAS；Analyze无Geometry/Visibility绑定，raw depth全域写自己的Seed(p).w。用户已授权颜色历史按AMD参考选前景receiver，Measure写R32Uint4B索引给Shading Pyramid/Analyze/Resolve；后者读所选Seed(q)的motion/expected previous-view z/资格，保RG16 motion量化，Seed生产者和raw identity/depth不改。不把depth支持率当颜色面积。current/previous color/depth/raw luma/四帧luma/confidence/frameInfo与Seed identity/camera在同一实际command成功submit后一起推进。Sharpen读写后color版本，不另造同色output；alpha最终1。新增receiver4B使store下限为68.8125对旧69B/pixel（含receiver4B、三个尺度1.3125B），不能继续引用63.5或必删search承诺。

创建前协商texture-formats-tier1、实际sampled/storage数量、16KiB shared、256lane/extent；格式量化与硬件filtered采样按参考保持。只有active域分配对应owner histories，native↔upscale整组事务/cached graph late binding/fence退休；不能双production path或legacy bridge。四核心阶段及小Exposure依据数据依赖，不硬压两pass。完整源码映射与平台适配见porting。

Cost gate：compiled候选无reconstructed/clear/atomic/global SPD，统计完整local差异重算、shared/occupancy、weights/exposure边和history新增；不能只按store下限宣称DELETE>ADD。先完整数学/语义和不变small质量，再1080p×256动态；全部通过才atomic cutover。开发不跑Dungeon局部性能gate。

出口：architecture review→fresh build:test→独立golden+HEAD reference完整1080p质量→actual ordinary/Product/motion/policy/cut/resize/abort/epoch/3inflight/release→原子退休旧native图→一次完整Phase成本ABBA。Phase4关闭不代表16.67ms最终验收，下一边界Phase5。

### 7.1 Phase4关闭边界（2026-10-12）

从HEAD `1ad294b0d62a76e5ea438973b31fa4c07bef1e19`完成本单元。**Phase4结构、必要数值/unit质量、真实接线与生命周期出口关闭；停在Phase5边界。** 用户已批准完整成熟参考profile及“允许按参考修订颜色历史合同”。Phase2/3保持；自主innovation/gain/mass和Donut仅保留历史失败，不是production fallback。

Production按实际两轴尺寸与AA选择唯一writer：1:1为NativeTemporalV2，true upscale为原FSR，AA-off为radiance bypass。Native完整图：final Sky/Aerial HDR + Seed → Measure → Exposure → Shading Pyramid → Analyze → Resolve → RCAS。旧NativeTemporalPasses/native_temporal、native Prepare/scatter/clear/global SPD/T3已删除；旧T3只在test-only reference。必要raw luma/四帧luma/confidence/exposure由新owner持有。

Measure一次3×3已有Seed选择前景receiver并写4B索引，三个直接consumer共享；raw Seed/identity/depth仍是pixel自身事实。Shading Pyramid每source一次差异/排序，合作归约2/4/8产品共1.3125B/pixel、672B shared，删除Analyze16倍重算和10880B shared。Analyze不绑定Visibility/Geometry/Instances；previous-depth pull无scatter/clear。未压identity；persistent78对旧70B/pixel、store/clear下限68.8125对69，不能称history大减。算法与成本合同见Design§8/9，来源映射见porting。

Native全histories与Seed identity/camera/jitter同command成功submit推进；prepare checkpoint使abort恢复上次revision/roles/validity。inactive backend仅replacement提交后按last-use fence退休。AA-off由真实Surface完整writer证明identity，不执行无consumer classifier；必要debug才分类，classifier/V2共享一个previous identity导入。空场景failed submit不提前释放历史，成功submit退休。ChangeSignal的observer异常不传播，故Renderer直接调用Seed/V2完整性检查；不依赖被吞的observer错误。

集中验证通过：production build/typecheck/declarations、fresh build:test、39项targeted Node；最终串行actual Native writer、完整Resolve八场景19136lane差分（最大relative=0）、receiver/raw depth/previous-view z/Ksep、cached共同提交/abort/3inflight/fence；17个小动态序列；ordinary与Product真实Renderer的最终图、native↔upscale↔bypass、按需debug、empty失败/成功、cut/resize/abort/retry/defer/controlled epoch。全部失败、raw/build identity与范围只在[Phase4报告](../performance/2026-10-12-final-pixel-phase4-pull-candidates.md)维护。

完整1920×1080矩阵通过：六类各256帧、每类8ROI，共1536帧，failures=[]；HDR/display逐frame与aggregate、peak、phase、energy、trailing/settling保持既定门。原tight失败保留，根因为格式/采样边界；恢复参考hardware RG16 filtering、删真实UNORM store前重复round并保被删R8边界，没有继续放宽门。synthetic矩阵不覆盖实际材质normal/coat求值，writer/Renderer另查；settling null不证明绝对收敛。后续CPU事务/绑定变化及纯格式整理不改shader数学，由最终实际Renderer/writer验证覆盖。

一次最终整Temporal合成1080p ABBA，16warmup、12样本/path/scenario：fractional Before/Native P50 **11.257248/9.655264ms**，stationary **10.007360/8.681472ms**，含pass间隙，观察到unit break-even。adapter仅报告NVIDIA/Turing硬件，不能推断精确型号/锁频。此结果不资格Dungeon whole-frame/P95/P99、GTX1650Ti16.67ms或Phase2/3联合回归；最终全feature/manual动态显示、simultaneous peak与整Renderer净性能按Phase5/6收口。不能忽略原Phase2/3负成本，也不能把局部收益称大模块完成。

### 7.2 用户授权的完整 Native 1:1 物理返工（2026-10-12）

本节保留首次非生产候选实验与当时停止决定；用户要求继续后，生产切换和当前单元最新出口见§7.3。不得将本节旧“未切生产”状态覆盖最新出口。

用户依据[源码诊断](../performance/2026-10-12-final-pixel-source-diagnosis.md)授权逐项执行。当前仅返工本单元，不自动进入 Native/Sun、Geometry 或 Phase6 正式长窗口。生产仍为§7.1图，替换 owner/WGSL 先在 test-only 完整闭包验证；没有 runtime candidate selector。

范围：Measure→Exposure→Shading Pyramid→半域 R8 shading-change→Analyze→Resolve/RCAS，包含全部绑定、写域、能力、缓存图、提交/abort/retry/reset/resize/device loss/fence retirement。Seed own-pixel motion/depth/identity、3×3严格前景 receiver、完整 AMD 重建/历史响应与 true upscale/bypass 合同保持。

Cost Card：R8物化删除12N filtered尺度查询与4N重复量化；增加.75N尺度查询、N次R8 filtered消费、.25N transient store/capacity（1080p 518,400B）、一dispatch/dependency，无history/atomic/clear。单独候选已通过既有动态质量，但短合成与同真实输入整链收益很小，短整帧未证可靠收益，不切生产。原失败与构建指纹保留。

Measure物理候选：以32×32 tile、128lane代替64×64/256lane；34×34 halo只缓存本dispatch的Seed.w，完整保持邻域顺序/严格nearest和half box。原1080p logical Seed depth loads约20,718,004（search+box）→2,358,240，不等于DRAM减少；log/luma/weights数学与完整覆盖保留。shared由16,384→8,720B，五轮2×2与halo/初始barrier共12次；private reduction最多2值。dispatch数不增，组510→2040，空边界lane、更多组及shared读取是ADD；log tiles2040→8160B。Exposure同一既有dispatch先按原顺序合并四个32tile，再在原64tile位置做mip5 half边界和全局树，增加至多四倍tile loads，保16KiB shared/既有依赖。无subgroup、全设备counter或新算法。

理想上限小于当前Measure完整桶（还有必要log/nearest数学）；预计ms未知，最坏shared/调度/Exposure新税抵消全部DELETE。以D=删除的实际读取/执行税、A=halo共享访问/组调度/Exposure合并与R8产品税，0/50/100%兑现为−A/.5D−A/D−A，break-even D>A且完整Temporal/whole和尾部不退。独立原Measure/Exposure数值差分、原质量门、真实同输入整链与短matched Dungeon可推翻候选；失败不恢复scatter/Prepare、不放宽门。完整单位出口未关闭，不提升净收益、60FPS或4GB资格。

本次继续完成该**非生产候选的正确性与有限成本实验**；生产返工出口仍未关闭。v2修复Exposure的WGSL显式类型转换并保持原加法顺序；12组尺寸含4096×4096的Measure/Exposure产品352,882,000字节完全一致，独立R8边界、小动态17序列、1080p六类1536帧矩阵与11项候选生命周期通过，未放宽门。冻结真实Dungeon输入完整链短回放与合成ABBA观察到局部下降，但真实Renderer四轮各96完整样本仍热混杂（89–91°C、thermal Active、300–1230MHz采样漂移），whole/尾部未获可靠matched净收益。保留test-only完整候选，**不切生产、不判架构证伪、不进入Phase6或Native/Sun返工**；后续必须先得到可比成本窗口。实际GPU产品、失败、source/build/完整shader与成本范围见[返工实验报告](../performance/2026-10-12-native-temporal-observation-rework.md)。实测资源池同时保留两份新增R8与log tiles，API容量增量1,049,040B，不能只报单逻辑产品518,400B或把API容量当DRAM/4GB资格。

### 7.3 Native观测物理返工生产出口（2026-10-12）

**本完整物理单元已关闭并切production；有限同条件whole/Temporal break-even成立，正式整Renderer/60FPS/4GB资格仍未获得。** 用户要求继续后，改善观测条件并完成实际切换；不以首次热混杂为停止所有后续工作的理由。保留原失败/负成本，不跨入Native/Sun、Geometry或Phase6正式长窗口。

生产唯一图为Measure32×32/128lane+34×34 Seed depth halo→Exposure原序合并64域/half边界→Shading Pyramid→floor-half R8 Shading Change→Analyze→Resolve/RCAS。所有消费者、cached bindings、complete-writer proof与abort/retry/reset/resize/epoch/fence同单元切换；删旧64tile Measure组织及Analyze内联low-change四邻域/三尺度查询。没有runtime候选开关、scatter/clear、额外history/submit；before与候选快照仅留test-only。新R8由FrameGraph transient pool管理，Analyze唯一consumer；geometry/identity/raw-depth/AMD完整profile保持。

观测工具新增显式low-tax模式：单个常驻250ms nvidia-smi采温度/频率，OS/CIM仅窗口前后；原periodic模式和原raw保留。每窗前固定场景暂停至82°C，断言提交frame与完整history evidence不变，再恢复原设置采96帧，不删恢复后首帧或长帧。三轮窗口sensor全1350MHz，A2首次sensor有1665MHz boost其余1350；温度轨迹重叠84/85–90°C。未锁功耗/风扇/频率，稀疏sensor不当逐frame时钟证明。

短ABBA A1/B1/B2/A2 whole P50=17.684400/16.845024/16.910624/17.645568ms，P95=18.191160/17.467048/17.416704/18.112072ms，P99=18.790605/17.923573/18.045152/20.056771ms；全部raw96帧、八相位各12帧。完整Temporal envelope P50=5.375184/4.626016/4.638720/5.396096ms；Native桶P50维持7.438–7.455ms。两侧有限whole差.839376/.734944ms，P95/P99没有观察到退化；不是Phase2–5相对49fc整模块正式净资格。最终实际production build另测96帧whole P50/P95/P99=16.934352/17.649912/18.728448ms，Temporal P50=4.638656ms，API release=0；不能以本微窗口称稳定60FPS。

集中出口通过：项目architecture review、engine typecheck/build/declarations、fresh build:test、Dungeon typecheck、33 targeted Node（新增missing Shading Pyramid/Shading Change拒绝提交与retry门；原生产失败保存）、actual production Measure/Exposure352,882,000字节一致、独立R8边界、完整Resolve/pull/cached事务、真实Native writer、actual Renderer ordinary/Product/multiProduct/normal/coat/MASK/local lights/环境与AO/Bloom/domain/debug/abort/retry/cut/resize/controlled epoch、bounded feature demand、17小序列、1080p六类×256帧×8ROI矩阵1536帧。八个实际production GPU oracle顶层passed且无GPU/scoped errors；最终构建再验真实Dungeon默认图与teardown。未放宽门、未吞必需失败、未借旧production路径。

新增逻辑R8 store .25N、log tile store增6120B/frame；相对§7.1 store下限68.8125→69.0625B/pixel（另加logs/info/weights），不能声称总store下降。实测API池容量增量1,049,040B、persistent profile仍78B/pixel，不称DRAM/OS资格。实际数据、指纹、原失败、来源与剩余验收范围只在[返工报告§6](../performance/2026-10-12-native-temporal-observation-rework.md#6-继续实施与生产出口)维护。当前单元关闭后停在Phase6正式验收边界。

## 8. Phase 5 — Integration / final retirement

目标：所有feature/domain只执行所需工作，清最后常驻/role税；若前Phase已经完全删除，不为凑Phase制造helper，以全集成闭包关闭。

DELETE：最后oldmask/motion/versions/layout/constants/pipelinecache引用、native sourcehistories常驻、无consumer纹理/clear、旧Facts/continuation hooks、fence后残存API资源/常规diagnostic税；不删true upscale必要产品。

ADD：全组合接线、单Temporal事务、精确retirement/accounting/release检查；不加fullscreenpass/history。集成如需大copy/pass，重新算对应unitCostCard，不藏glue。

覆盖VSMon/off/high/bounded、无physicalSun/unlit、中立、AO/Bloomon/off、ordinary/Product/multiProduct/MASK/coat/localLights、native/nonintegerupscale、partial/resize/pause/step/defer/cut、motion/shadow/identitydebug按需求；graphcache/generation/epoch。publicationatomicity与普通motion无错误globalreset。fresh build:test、serialGPU、完整dynamicquality、全部owner simultaneouspeak/release0，现有retiredguard适配，无legacy桥。最后Phase6。

必须联合收口Phase2尚未资格的融合成本：使用已实际写Seed的最终Native和V2 Temporal，重新计算完整DELETE/ADD、private live-state/binding/working set及receiver→Native envelope，不沿用Phase2微窗口为收益证据。此处只允许冻结B/V2内的实现candidate调整；不能以“性能稍后验收”忽略已观察回归。闭包后一次集中有限ABBA、动态quality，Phase6再完成正式长窗口；最终无break-even必须按完整证伪合同处理，不能称模块完成。

### 8.1 Phase5集成出口（2026-10-12）

**结构、产品、需求、必要正确性与生命周期集成关闭；联合净性能仍未资格；停在Phase6。** 本轮不改production shader数学、AMD完整profile、foreground receiver合同或Geometry Frontend，不增加fullscreen pass/history/submit，也没有第二Native路径。

DELETE：成功empty replacement后无消费者的Surface execution storage/Seed/color histories/local-light与lighting frame pools；all-unlit后的lighting frame pools；关闭PhysicalEnvironment epoch中的全部VSM allocation/pass owners与无消费者shadow Geometry demand；验证链残留native1:1 FSR生产入口和旧两输出对照Surface；销毁后的frame references。ADD：可复用owner的last-use fence retirement、NativeV2/FSR candidate/active/retiring物理账本与allocation rollback、无环境时按需8B共享零辐射IBL绑定、完整组合验证。提交失败不提前释放，返回场景Seed/camera validity重新建立，VSM active residency不当frame scratch清除。idle回收不冒称正常scene帧率收益。

实际Renderer覆盖ordinary/Product/multiProduct/authored IBL、MASK/normal/ORM/coat/local lights、high/on/off、AO/Bloom、native/noninteger upscale/bypass、按需debug、cut/resize/abort/retry/defer/three-inflight/cache/受控epoch与empty失败/成功/返回。新增无Sun+中立/无Sun+authored IBL真实Renderer及bounded能力投影Renderer，覆盖domain/unlit返回/调用方pause-step，API teardown bytes=0。bounded是在真实GPU上投影2048能力上限运行实际production图，**不是适配器真实协商到低limit的证明**；core WebGPU对低于默认limit请求会钳制，不以伪造request成功声称硬件覆盖。非法partial写域仍由原capacity/extent语义断言拒绝。

Engine typecheck/build/declarations、fresh build:test、64项targeted Node通过；完整1080p六类×256帧×8ROI动态Temporal矩阵1536帧、Shadow/Sun/pull语义、1080p五场景实际Surface acceptance通过，门和算法不变。实际Renderer全API（含诊断读回）归零；simultaneous peak保留真实overlap。受影响oracle已迁到当前Seed/V2或明确冻结的test-only历史reference。原失败、fixture修正、最终build identity、成本与范围只在[Phase5报告](../performance/2026-10-12-final-pixel-phase5-integration.md)。

联合ABBA使用fresh `49fcaa3` Before与Phase5 After、同场景/renderer设置，每轮60完整target GPU样本。A1/B1/B2/A2 whole P50为18.958/22.324/25.542/25.654ms；P95为42.098/58.104/27.724/28.377ms。receiver→Native envelope P50为9.959/12.306/13.946/13.467ms；删除ShadowResolve/Facts已实际验证，但Native与Temporal scene cost仍高，**没有稳定净收益/预算资格**。88–91°C、thermal Active且clock不重叠，不归一化为收益，不以短窗证伪架构。API窗口peak下降140.27MiB不等于persistent history savings；identity+color profile仍78对旧70B/pixel。最终无Sun条件接线/中立provider晚于ABBA；原benchmark fingerprint不冒充最终提交，默认PhysicalSun图与shader数学未变。

Phase6必须完成同条件长窗口≥3 ABBA块/每path每块1000完整samples、tail/thermal、实际authored Dungeon动态质量及4GB/OS驻留验收；若需改shader组织，返回对应unit的完整candidate验证，再集中测量。不能把后续验收当必然收益或隐去此前回归。

### 8.2 用户追加的相机交互尖峰单元（2026-10-12）

用户要求分析并优化两种比例下旋转/平移/缩放的间歇卡顿。局部实施为 PhysicalSkyIblResources 的完整参数/LUT身份、4组不可变输出/LRU/提交/abort/fence退休，以及 Dungeon interactive 对延期 RAF 的完成后重试。首次新探针仍完整生成；不改 FSR/Native Temporal 数学、Geometry Frontend、VSM质量或相机阻尼，不增加在途上限/独立submit。默认比例按另一次明确授权由1改为0.667，面板同步。

**该局部正确性、生命周期及重复生成成本出口关闭；普通交互整体FPS净收益未资格，全部卡顿根因未闭合；正式Phase6仍未开始。** Typecheck/build、fresh build:test、Dungeon build/typecheck、20项Node、3个串行实际GPU通过。完整IBL返回读回3,293,136B一致，命中0生成dispatch，对比旧17dispatch约2.08ms。普通宿主两种比例×静止/旋转/平移/缩放完成，释放后天空纹理0；热状态89–91°C和300–1350MHz混杂且部分GPU span缺项，不用局部工作删除或混杂FPS冒称整体性能改善。原失败、Cost Card、完整8窗口正负数据及附件见[相机交互报告](../performance/2026-10-12-camera-motion-stutter-optimization.md)。停止在该用户追加单元边界，不自动实施VSM/HZB/FSR新算法或跨Phase6。

### 8.3 VSM采样与Bias优化（2026-10-13）

用户明确授权滤波质量取舍后，本局部采样单元完成 production 切换、退休和必要正确性/生命周期/成本检查；整 Renderer / 稳定60FPS资格仍未获得。默认从16点网格/.75半径切为4点旋转Vogel/1.5半径；稳定raw gather及point属于同一采样owner的显式模式。零半径在CPU折叠为point，未创建旧算法桥。

Native先检查prepared BRDF的base/coat零贡献，再查询页和采样；保留无效页中性返回及空反向深度/负reference。现有几何平面给出逐texel中心深度修正，Depth/Angular默认1/1；退掉重复Normal/Slope、per-axis配置/ceiling、4×4循环和死`ShadowContract`。噪声全64相位及rotation table共1,050,624B，在现有lighting binding的不可变tail一次初始化，最多3份fenced allocation，最坏新增约3.01MiB；无额外texture/binding/pass/history/submit。AA-off固定相位，abort/retry/reset/resize/模式切换/设备恢复/退休保持完整。

集中验证：engine typecheck/build/declarations、fresh build:test、Dungeon/Bistro typecheck/build、31 targeted Node；新filter独立595,968点、新bias解析receiver/contact 442,368点、3600 Sun/coat/HDR例、完整query/identity、1080p四类×256动态shadow序列、实际ordinary/Product/无Sun/bounded/最小binding/模式与零半径/AA-off/abort/defer/recovery/release GPU通过，无GPU/scoped errors。普通例程原浏览器失败保存并修复，最终交互与immutable上传/释放检查见实施记录。稀疏两点半影猜测及深度/寻址f16按设计拒绝，没有未接线placeholder。

最终独立核old16/old4/disk/gather/point P50=.937696/.363280/.262896/.159616/.146368ms，全部raw及Cost Card见[实施记录](../performance/2026-10-13-vsm-filter-optimization.md)。有限96-frame ABBA中Native P50 A1/B1/B2/A2=4.207312/3.799760/3.819184/4.229968ms，两侧减少约.41ms；whole=17.171840/16.397280/16.534752/16.475424ms，VSM管理波动约.45ms，whole分差方向不一致。只称局部采样/Native收益，不称完整VSM或整帧改善。原热混杂、失败和全部raw保留；没有geometry-settled/formal三块1000-frame资格。接收平面与滤波源码切换事实、来源边界和仍需验证范围见实施记录。单元结束后仍停在Phase6，未越界重做VSM管理/raster。

### 8.4 用户追加的近期提交优化闭包（2026-10-14）

用户在审评 `bfc7d96f`、`b4ded252`、`b9acf2e6`、`f933660a`、`9557f63d` 后明确授权按设计顺序实施；本单元从 `9557f63d` 开始，依次闭合 VSM 正确性、Temporal 完整身份、紧凑 Page/加载合同与局部成本选择。环境惰性创建、Compute Pass 合并、不可变资源绑定缓存及紧凑 Page 单槽方向保留；没有恢复 CPU 96B 常驻展开、额外 submit、GPU→CPU→GPU 工作控制或第二套生产架构。软光栅候选仍未进入生产调用，不声称其有生产收益。

**生产实现与 owner。** Receiver 删除角点同页/双簇推断，逐有效像素做真实 clip/page 投影，再使用已有 word/mask 聚合写请求。旋转 tile 的四角全部落粗 clip、内部落细 clip 是该推断的反例，补 barrier 不能解决；保守簇算法及其 overrequest/raster 成本未证明前，不恢复此捷径。Caster 保留 `9557f63d` 的 uniform dirty-count 广播；小于64个脏页直接执行原精确相交，64及以上保留现有层次归约，63/64/65/128边界、溢出、失败和 abort/retry 使用同一页/配对语义。

Temporal writer、FrameProgram、Native binding、Seed 双缓冲、分类器及 AMD Analyze 全部使用 `rgba32uint` 的4个完整身份字，退休12/8/6/6位截断及格式猜测；保留 eligible 后才读 prior、高 reactive 时不读邻域的工作删除。身份归 Temporal owner，恢复其真实 accounting/retirement，不以截断实例、材质或 revision 换显存。

Product 准入只扫描实际紧凑 payload：验证层次 work bound、布局、索引、位置 finite-f32 与 UV finite-half，不生成展开数组；每页仍一个256KiB槽。GPU 每次 source/缓存地址恢复同时装载3个 format word，属性函数复用这些字；per-invocation 状态继续 private。未预验证的 source 在异步 digest 前一次性取得自有字节和身份快照，校验/上传消费同一快照；包括 Node Buffer 在内的 Uint8Array 输入使用显式复制。可信 OEGPACK adapter 复制公共 decoded view 后移交所有权，preverified 标记绑定实际 ArrayBuffer。CRC-only 明示 `encoded-crc32` 且没有 decoded digest；SHA 路径保留真实 digest，不能把 Page identity 填充为摘要。WebCook 的 PageReady 仍要求16B真实 digest；结构/三角索引检查不随 SHA 选项跳过。

Canonical cache 使用实际 scalar、UV、texture/sampler/content、不可变 graph 定义的精确快照与 `Object.is` 比较，删除32位 hash 作为相等判据；只在 publication 编译入口使用，不增加逐帧材质扫描。Bistro Texture Product 恢复默认完整容器 hash 校验并复用容器结果；纹理并发16但受256MiB transport 字节 credit 限制，credit 覆盖拼接副本和解析，未知/压缩传输长度保守预留。Geometry open 并发4、首失败取消同批请求并等待所有 worker，清理早/晚完成的 asset；range signal 传到真实 fetch。Bootstrap 每批最多64页，逐批上传后继续；合并读取每 span 解码后释放 encoded block。已完成 Product、浏览器网络缓存、JS GC 和 OS 内存不属于该 transport 逻辑上限。

**Cost Card（相对本单元 HEAD，声明字节不冒称 DRAM）。**

| 机制 | DELETE / ADD 与访问、同步 | ideal / expected / worst、break-even 与选择 |
|---|---|---|
| Receiver 精确请求 | 删92B/WG预测状态、16角点投影、z/簇归约及其 barrier；保留512B/WG word 聚合与一处 barrier；增加原捷径命中时被省略的逐像素投影 | correctness 修复：有效像素0/50/100%分别0/最多32/最多64次投影，不能以少请求证明节省。无保守证明便拒绝角点预测；非数值性能资格 |
| Temporal 完整身份 | 每像素当前 store 4→16B，每次身份 load 4→16B；两张身份 allocation 合计+24B/pixel，1080p +47.46MiB；Seed allocation 28→52B/pixel | 0/50/100%历史可用均保留完整身份，eligible 的 prior load 依需求发生；没有以错误身份匹配换内存的 break-even。实际 allocator/retirement 按52B记账 |
| 紧凑 Page | 无新增96B/vertex数组、无新增dispatch或GPU binding；准入 O(vertices+triangle corners) 读与 finite 检查；GPU 每次 source增加/复用3个format word状态 | 一个物理页固定一个槽；无/部分/全部属性分别只解码 consumer 所需字段。边界校验是准入成本，不称 CPU O(1)；GPU实际属性对照与真实Product消费通过 |
| 八槽 Surface 候选 | 删混合图元 hash/probe/填充及同步；仅留精确单图元广播。声明的4组缓存数组+keys/valid共4864→600B/WG，减少4264B/WG | 无/部分/充分复用用1/4/8px footprint局部ABBA检查；每pixel直接解码在混合tile可能增ALU/随机读，单图元仍广播。八槽未证明稳定净益，退出生产，仅冻结test-only参考 |
| Caster 小列表 | D<64省每batch四处层次同步/归约，但最多 W×D 次页读取与精确相交；大列表沿用层次。无新增pass/submit，原shared声明不因branch消失 | 0/50/100%脏页、63/64/65/128及配对压力检查；阈值对应64lane页设置的完整批，不宣称测得最优阈值或速度。层次收益依空间拒绝率，局部成本未获稳定净资格 |
| 加载与缓存 | 删重复编译/重复digest、全bootstrap encoded块常驻及无限制geometry Promise.all；新增精确快照比较、准入扫描、共享credit/取消/清理 | 材质0/50/100%命中仍需快照比较，miss正常完整编译；break-even为省下编译大于比较，不称整体加载百分比。bootstrap decoded批最多16MiB；span≤16MiB、并发4；transport峰值逻辑边界256MiB，单响应decoded≤128MiB |

**局部成本证据及其限制。** `surface-workgroup-cost-final.json` 为同一实际 Native+Temporal fixture 的256²局部ABBA，cell=4时Native shading的 eight/direct/direct/eight P50=.892928/.856064/.849184/.894304ms；cell=8为1.876800/1.943424/1.961440/2.004992ms，收益方向不稳定。cell=1跨窗口所有GPU阶段明显变化，不能从该热/时钟混杂得出精确净增益。Caster 0/50/100%及边界 ABBA 同样出现公共阶段变慢，保留全部样本，不归一化、不冒称整帧收益。冻结八槽参考只进入测试文件，生产没有候选开关。此单元没有修改算法来源/adoption声明，不把局部物理组织调整称为移植。

**集中验证与失败分类。** Engine typecheck/build/declarations、fresh build:test、Bistro typecheck/build，以及受影响材质、Page、调度/流送、WebCook、Temporal、FrameProgram Node 检查；原失败及各次重跑均保存在 `.local/commit-optimization/`。旧 residentByteOffset=176 断言迁为原始页偏移0；旧“零 coat 删除纹理”断言与现行 live numeric parameter 合同冲突，迁为 CPU 独立求值验证0→.25及保留纹理依赖，不删除语义门。异步 digest 注入测试保留并修复 Buffer.slice alias 失败。R2缺噪声、R3退休texel helper/4页fixture、Temporal oracle重复getMappedRange及stale build分别按fixture/API/构建分类修复，未放宽像素/数值门。原1024/2048/4096 PC encoder完整套件启动后因非本单元codec算法范围而停止，未声称跑完。

串行真实 NVIDIA Turing / Chrome155 GPU 覆盖精确receiver反例、VSM R2/R3真实分配/配对/提交、完整Temporal身份（实例4096、材质65及高位signature）、Native Temporal V2、实际Renderer WASM Product接线与abort/retry/resize/recovery/teardown、budgeted residency与device loss。独立 `product-attribute-decode` 覆盖1024顶点/20480分量、全部32属性mask组合、4bank、35B奇数stride/跨word读取及format恢复，最大绝对误差5.960464477539063e-8。该寻址压力集包括比当前准入更宽的非对齐布局，不冒称这些布局已纳入Product ABI。

最终受影响28个Node文件共175项通过，含全部九个sampler字段及异步校验时修改provider字节/身份的回归。`git diff --check`通过。`node tools/docs-verify.mjs`仍有1个既有finding/81个historical warnings：仅Git忽略且本轮未修改的旧`docs/status.generated.md`缺frontmatter，本轮执行文档没有新增finding，全库文档检查不记通过。

本追加单元实现、受影响正确性/生命周期与有界成本检查完成；未开展正式全Renderer长窗口/最终动态质量矩阵/4GB OS驻留资格，未获得整体加载时间、整帧FPS收益或稳定60FPS结论。仍停在既有Phase6边界。

## 9. Phase 6 — Performance / quality acceptance

本节保留V5原验收合同。重启时须依据届时完整功能与源码重新冻结实际profile/reference；例如§8.3已授权将旧16点/.75改为disk4/1.5，不能将下列历史配置默认为最新生产。正式采集工具已包含P99、geometry-settled与资源审计，长窗口组织、有效样本数和分位数口径仍需对齐；不因旧文字而重复建设已有工具。

DELETE：无根据的60FPS/稳定收益/局部bucketclaim；本Phase本身不删shader。ADD：可比production数据与验收报告，normalhotpath无计数税。需修代码回对应unitcandidate再新鲜闭包，不临时改架构。

GTX1650Ti4GB，记录actualadapter/driver/browser；1920×1080/DPR1/scale1、固定Dungeonnear/SSE、原high4096/6clip/4×4/radius.75、AA/sharpen、GTAO/BloomOFF、geometry512MiB、max-throughput；quality另含AO/Bloomon，不把关效果当gain。Before本次HEAD生产fixture/build；每Phase保最近稳定reference，但不同条件历史Before不作净差。

先核pending/verified/inFlight/retiring、source/caster revisions、payload/drop/coverage；`fullQuality`不等于settled。预热≥240成功帧并满足settled事实稳定；动态流送独立，不删首轮burst。每ABBA块每path≥1000完整GPUframes、至少3块、GPU串行；降低sampleinterval税就延长窗口，样本仍够。correctness窗口开counters、timing全部统计关闭；不完整采样明确incomplete，不补造/混coarse。

逐frame保存wholecommandspan、互斥stage、Native含PCF+Seed、VSM管理（不再含PCF）、Temporal含Measure/Exposure/Analyze/Resolve/sharpen、CPUrender/admission、overlap/gaps、sensor与source/buildfingerprint。先同frame求和后`(n−1)*p`分位，不加/平均P95。P50/P95/P99/max、bootstrap区间、paired块差与raw长帧全留；thermal/clock/prewarm/CPU-IO混杂记录，不频率归一化代替实测。热状态不重叠的块不能证明精确净益。

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

本轮Phase5集成出口已关闭并停止，不跨入Phase6。生产Native维持唯一参考profile与Seed/pull完整图；新增需求删除、retirement/accounting及全部直接consumer闭包见§8.1。联合成本已检查但净性能未资格，正式整Renderer动态质量、长窗口/尾延迟和4GB驻留资格仍未完成。不能把集成关闭、source研究、编译、局部quality或break-even晋升为整Renderer质量/60FPS资格。
