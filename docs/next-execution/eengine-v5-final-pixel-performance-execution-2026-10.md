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
    - OEngine/src/shaders/native_surface_aux.ts
    - OEngine/src/shaders/native_surface_lighting.ts
    - OEngine/src/shaders/native_temporal.ts
    - OEngine/src/shaders/vsm_sampling.ts
    - OEngine/src/gpu/GpuNativeMaterialPublication.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/GpuInstanceAbi.ts
    - OEngine/src/framegraph/FrameGraph.ts
    - OEngine/tests/oracle/native-temporal-v2-gpu.mjs
    - tools/gpu-oracle/registry.mjs
    - validation/tools/run-dungeon-performance.mjs
    - docs/VALIDATION.md
---

# EEngine V5 Final Pixel Execution Authority

唯一目标是[V5 Design](../next-design/eengine-v5-final-pixel-performance-2026-10.md)。本文件管理迁移单元、合同、验证、cutover与退休；候选实验进入`docs/performance/`，不追加到目标设计。source baseline `49fcaa300fafcbbe3db142df403baa3487f89956`。**本次只交付设计/计划与workstream导航；实施尚未开始，等待用户审核后另行授权。** 不自动编码、提交或启动GPU benchmark。

## 1. Phase 顺序、依赖与状态

| Phase | 大架构单元 / 必须删除的工作 | 依赖 / 当前状态 |
|---|---|---|
| 0 | Source truth、目标图、数据/质量/成本合同冻结 | 本次文档交付；等待审核，无新GPU验证 |
| 1 | Final Pixel publication / Native Seed非生产完整闭包，替代重复恢复链，合法binding与唯一写域 | 0审核；未开始 |
| 2 | Shadow Physical Execution cutover：full I Shadow Resolve / mask / 重复continuation退休 | 1；未开始 |
| 3 | Temporal Seed cutover：Native→全部Temporal consumers；Facts恢复pass / 旧Aux退休 | 1、2；未开始 |
| 4 | Native Temporal V2完整图：native scatter / Prepare / SPD / source histories退休 | 3；未开始 |
| 5 | Final Pixel全feature/domain集成、最后旧owner与多余常驻/生命周期税退休 | 2–4；未开始 |
| 6 | 集中quality / production ABBA / P50/P95/P99 / 4GB simultaneous peak验收 | 5；未开始 |
| 7 | 只有剩余gap需要：Receiver Demand V2，删除pixel projection扫描 | 6诊断；deferred，不自动实施 |

先证明Native能合法绑定和写全域，避免Shadow切完才发现Seed超限；Shadow是Native前置，可独立完整删除；Seed对native/upscale均有真实consumer，先闭合共同输入再替换1:1算法；最后检查domain切换只保一套active histories。Phase1是完整替代链的非生产构建，不是一个helper实验。阶段内可断链；每稳定边界每服务域只有一套production图，不建legacy adapter/A/B bridge。

每Phase闭合后停在下一单元边界，继续范围依后续授权。状态仅本文件维护，workstream不复制状态表。本轮明确STOP。

## 2. 跨Phase冻结合同

**Architecture → Candidate implementations**。Phase内可换branch/tile/shared-private/static tap/point去重/short live scope、detector/filter权重；质量门不变。单candidate失败不改为另一个production架构。新增/删除仍符合Design的products/owner/domain。

成本入场：先完整Cost Card（DELETE/ADD、bytes/ALU/samples、random/sequential、atomics/barriers、dispatch/layout、working set、ideal/expected/worst、0/50/100%兑现与break-even）。只有预期DELETE>ADD、理想有正收益且确实能删除目标工作才进入unit；未测live-state不能写0。新增上界已确定超过可删收益上限，才构成fundamental cost证据。

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

## 5. Phase 2 — Shadow Physical Execution cutover

目标：唯一production Native Sun直接消费post-content-commit VSM合同、geometry once，ordinary/Product/compact/unlit中立/resource profiles/debug全闭合。

DELETE：`VsmShadowResolvePass` owner/full I dispatch、`vsm_shadow_resolve` hotpath、packedShadowVisibility/decoder、lowering全Shadow读域、mask store/read、288Bshared/2barriers；`additiveSun`第二geometry/material、HDRcopy/第二HDR/continuation publication。representation tests迁移，numeric/lifecycle仍保留。

ADD：Native scope VSM query/原pointPCF/bias/scalar visibility；physical lookup/descriptor最终写版本依赖，按需debugconsumer。debug shadowview真要visibility时由Native只在debug有需求时写诊断输出，常规无ShadowVisibility/fullscreenresolve。

原子边界：raster→commit→publication→全部Native routes→Sun/HDR→下游同时切，构造完整pipeline/publication再切，旧mask消费者立即删。初始candidate directdescriptor query+短live scope+原PCF；compression只用原资格域；后续代码组织是unit内candidate，不改fusion。

Cost gate：删除receiver恢复/产品，ADD per-pixeldescriptor重复lookup和Nativeworking set；PCF共同项不算删除。source证明无continuation/第二geometry，全部layout合法。闭合后fresh build:test、sampling/receiver/alpha/off-camera/local-invalidation/实际Native GPU、Shadow quality子矩阵、所有组合/abort/retry/epoch；再一次有限同条件DungeonABBA，统计**Native+VSM全部工作与whole span**。单candidate慢先调本unit；不能自动留S3/改C。完整证伪门满足才提amendment。报告进performance，本执行文只记出口/链接。

## 6. Phase 3 — Temporal Seed cutover / retire NativeTemporalFacts

目标：geometry-dependent facts在Native生成，当前native T3/true upscale都消费Seed；不提前改Temporal算法。

DELETE：`NativeTemporalFactsPass` full I resolve/重复key-instance-version-camera读取、depth→world→previousclip、motionRG32、opaqueReactive staging/clear、实际不读的asset/payload bindings/graph边、separateversions最后consumer、旧Facts identity生命周期owner。

ADD：Phase1 Native writer接生产；Temporal service接管**同format同语义identitypair**；轻量Seed classifier读previousidentity/response生成旧算法合法mask，无Visibility/Instances/Geometry；FSR Prepare直接loadSeed.xy并保持负scale/jitter转换；Seed.zw给Phase4。native classifier在Phase4融入Analyze，upscale classifier是真consumer，不是legacy bridge。

不能把删Facts写成删除28B全部traffic：identity16/reactive4/previouscompare仍存在；新Seed多8B。廉价classifier暂仍一个full I dispatch，明确ADD；收益是删昂贵恢复和中转/owner读取，最终V2再删除这条独立边。

原子边界：Surface→classification→全部native/upscaleinputs、Renderer prepare/commit/abort、graphlatebind/debug同时切；旧Facts立即删除，不留空wrapper。directory32B/versions字段所有consumer同步后退separatebuffer。

闭合：motion/currentidentity/mask同数学按原numeric；baryworld与depthworld f32差异用analytic/winner门，预计previousdepth/dolly/rigid/deformedinvalid独立；fresh build:test、真实Native→FSR/nativeinputs、role/policy/abort/3inflight/epoch/release、完整Phase子质量与一次有限ABBA。Native新增Seed/live-set成本真实记录，禁止patch benchmark。停Phase4。

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

docs运行`node tools/docs-verify.mjs`与`git diff --check`；raw/source/build/失败不覆盖；中文commit一个完整单元一意图，写DELETE/ADD、实测/未运行。domains/adoption/claims只有实际切换与证据后更新，本次不改实现事实文档。

## 12. 本次交付边界

已交付architecture与可执行合同；V5 runtime实施、WGSLcompile、build:test、GPUoracle、动态quality、Dungeon与register/spill/cache/DRAM检查均**本次未运行**。历史数据不当V5After；docs/diff验证在回复报告。

可以直接开工表示：sourcebaseline、真正重复、唯一目标、产品/bytes/bindings/writer域、全部consumercutover/lifecycle、DELETE/ADD、quality门/节奏/证伪明确；不承诺未生成shader已更快/画质已过。下一行动仅用户审核后Phase1，本次STOP。
