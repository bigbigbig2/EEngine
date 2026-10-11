---
id: eengine-v4-performance-optimization-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-v4-performance-optimization-2026-10.md
    - docs/performance
    - docs/porting/next-renderer.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/shaders
    - OEngine/src/render/environment
    - OEngine/src/render/vsm
    - OEngine/src/render/surface
    - OEngine/src/render/program
    - OEngine/src/render/passes/fsr3
    - OEngine/src/render/temporal
    - OEngine/src/render/TemporalFabric.ts
    - OEngine/src/gpu
    - OEngine/tests/contract
    - OEngine/tests/unit
    - OEngine/tests/oracle
    - validation/tools/run-dungeon-performance.mjs
    - validation/tools/dungeon-gpu-audit.mjs
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression
    - examples/tests/dungeon-resource-budget.test.mjs
    - tools/gpu-oracle/registry.mjs
---

# EEngine V4 性能优化执行计划

唯一设计见[性能设计](../next-design/eengine-v4-performance-optimization-2026-10.md)。本文件拥有单元状态与实施出口；workstream仅导航。**P1已关闭Q-exact局部出口；P2已关闭T1，T2实验拒绝采用，T3延期，Native Temporal V2整体未完成。** 不把局部工作删除写成稳定帧时改善或60FPS，不自行同时启动多个单元。

## 1. 状态、实施入口与停止边界

2026-10-11 用户改为启动 **Shadow Projection 独立产品单元 S2**，Temporal T3 非生产探索已暂停并保留在 `.local`，未切生产。本次范围/Cost Card/质量门见设计§3.0，优先于旧 S-after-material 候选约束。S2 实验已关闭为 rejected：真实接线/numeric/lifecycle通过，净性能未证明，生产恢复原 Q-exact。**生产剥离目标未完成**，不把这个拒绝出口或旧 P1 状态改名为成功实现。

Previous Gate：HEAD `9ca9ae1f`，原工作树仅 `.vscode/`。fresh build:test 后 Geometry canonical replay/Orbit/publication CPU 9/9；Temporal/Facts/Fabric 15/15。真实 GPU publication passed、receiver aggregation passed、P5 local invalidation 5184 assertions passed。403 为 oracle host 静态资源 console 记录，原件保留，GPU结果不吞错误。未发现需要独立 closure 的前阶段生产遗漏。

当前 HEAD K stats（仅诊断，不能计时）：2,073,600 receivers /32,400 tiles，sum fine keys=38,954，sum resolved keys=38,954，26,705 tiles 单 key，全部 status=FINE；98.1214% fine-key重复。selected clip每tile一个。第一次 physical-slot 统计的 status enum 判断错误，输出0不是没有atlas工作；已修为 FINE=0/COARSE=1，补采见下，不把旧0当事实。fallback/运动仍由独立oracle覆盖，不能用这个静态snapshot证明。

候选 K 重采已保存：sum fine/resolved/physical-slot keys均38,942，selected clips32,400，26,709 tiles单key，global pages326，duplicate98.1220%；每tile实际winner keys共57,526，leader匹配1,680,257/2,073,600=81.0309%。此候选3-plane diagnostic不是现生产2-plane K；未接线的winner统计返回null，不把它记为0。coarse/运动entropy未以此静态全FINE snapshot证明。

| 单元 | 状态 | 完整出口 |
|---|---|---|
| P0 源码、已有证据与设计 | complete（文档出口） | `f495f04b`源码/报告、成本边界、来源与失败分析；不等于新代码gate通过 |
| P1 VSM Sampling/Projection V2 | complete（Q-exact局部出口，热状态限制见§3.6） | post-commit compact publication→Native/debug/continuation唯一consumer；numeric通过，局部净P50改善，全帧/P95不承诺 |
| S2 独立 Shadow Projection（本次新授权） | rejected（实验关闭；生产剥离未完成） | packed exact visibility、fine broadcast、真实完整接线/正确性已实验；两轮Total未支持收益，恢复唯一Q-exact生产，见§3.7 |
| P2 Native Temporal V2 | in-progress（T1 complete；T2 rejected；T3 deferred） | T1/T2结果见§4.2/4.4；新算法尚未实施，整体未完成 |
| P3 IBL hardware-friendly publication | complete（exact radiance addressing + filtered DFG） | hardware radiance候选精度失败，改为原四点权重/有界寻址；完整生产接线、原支持域、numeric/lifecycle与限定成本见§5.3 |
| P4 4GB资源预算与容量策略 | complete（Dungeon显式容量单元） | 全显式API审计/同时峰值、512MiB默认、当前payload/碎片、运动与释放验证见§6.1；全局预算强制/growable/variable-page未实施 |
| P5 动态VSM局部失效 | complete（本单元出口，见§6.2） | 完整old/new caster、asset publication stamps、稳定depth域、局部dirty→原生产consumer；更新突发收益/热状态与压力边界保留 |
| P6 PCF算法与后续upscaler/residency研究 | conditional / not-started | 只有前述数据支持且质量合同明确才制定实现；无自动扩展 |
| P7 性能模块验收 | not-started | 目标硬件1080p同质量/coverage、动态/压力/热状态、CPU与资源峰值，列出剩余gap与VSM R4未闭合项 |

**P1/T1复核通过；本次关闭T2实验并拒绝生产采用，随后按用户任务继续P3；T3保持延期。** 不把T1/T2称为完整Native Temporal V2。P3/P4可在单元边界按实际数据调整顺序；任何调整先重读源码/当前结果，不把本表当无限自动任务。

P1内部只有两步：先完成下述资格记录，再冻结**一个**Q或S实施目标及Cost Card。资格诊断作为该单元的设施，不扩展成新的性能框架；候选After失败后不在同一单元连续换第二套shader。停止点是“采纳一个净收益候选”或“拒绝并恢复稳定生产状态”，不是不断增加variants/跑完整baseline。实施记录只追加到本计划的对应单元，不新建重复progress文档。

原交互pacing、Geometry canonical decode、numeric operations、Native slicing、receiver word aggregation的提交与报告作为已完成基础；实现前只跑受影响最小checks，不重新做完整Before套件。VSM旧模块R4仍未验收；本性能模块不冒充补齐全模块质量。新高级effects全部延期至P7后用户重新决策。

## 2. 共用实施与测量合同

开发时只做typecheck、shader compile、必要小oracle/生命周期checks；完成producer→产品→全部consumer后architecture review，再集中fresh build:test与GPU验证。GPU任务串行，不在每patch跑Dungeon。唯一生产路径，不加test-only fallback、独立frame submit、本帧GPU→CPU→GPU visible/work控制。

Before使用既有10-10总报告与10-11后续报告，不重跑完整baseline。一个闭合单元后，运行限定scenarios的After组；需要热状态配对时可用冻结reference做小型局部实验，不能把旧整套baseline再跑一遍或永久留生产双路径。

固定条件：position `(0.303839,6.044173,-2.558241)`，target `(-4.412154,0.935180,-6.220996)`，FOV60；1920×1080/DPR1/internal=output/renderScale1；Dungeon自身真实coverage≥80%，优先约90.7%；VSM high4096²/6clips/4×4/radius.75、FSR/jitter/HZB/cone ON，GTAO/Bloom OFF，原材质/Sun，authored local lights0。camera audit、invalid winner key、shadedPixels2,073,600与MeshletWork605作为原view对应证据；变动需解释，不把这些值放宽来获取通过。

使用`performanceCapture=1`明确max-throughput，不用interactive RAF cadence与旧吞吐混比。至少保留三轮独立稳定窗口，既有runner为240提交帧/每4帧timestamp一次=60 GPU samples；提交数/丢样数/完整GPU样本数逐轮记录。固定热状态方法、prewarm和采样范围在结果中写明；不能冷After比热Before算收益。无锁频能力时记录频率/温度/thermal flags与OSdedicated/shared/Chrome内存，结果按证据强度报告区间。

runner默认`fullQuality`+至少60成功帧warmup**不是geometry/VSM settled保证**。保留逐帧resident/pinned、upload、main/shadow feedback completeness、source revision、dirty、invalidation reason、caster pairs、commit failure；将transition与steady作为有标签的独立分布，并报告全部原窗口，不能删除突发改成漂亮steady成绩。已有full-1的37/60高raster样本必须保留。

Timing采集：Total command span、同帧互斥category mean、各pass P50/P95、selected subcomponent、submission间隔/吞吐、queue completion。统计运行单独采full-key/atomic计数，计时关闭instrumentation。Presented FPS无法读取则unavailable。CPU记录同步render、主线程TaskDuration/longtask、GC/heap、admission defers，不能用同步render代替总CPU。Memory记录API容量/有效payload/物理slot驻留/池live与peak/OS计数，不混成同一个“VRAM”。

raw、build/source fingerprint、配置、timestamps、传感器、失败与screenshots保存在`.local/validation/<unit>-<date>/`，不提交原始数据。报告可引用artifact路径，但没有artifact的机器不能把链接当新验证。0计数须核查producer已接线。main/shadow readback droppedSlots已有升高，必须记录并解释completeness与eviction保护；不能在本阶段自动改Geometry，正确性失败则停下分类。

## 3. P1：VSM consumer资格与完整切换

### 3.1 开始前的最小门

1. `git status`/HEAD/diff；读最新`native_surface/native_surface_lighting/vsm_sampling`、`SurfaceV4`、`GpuNativeMaterialPublication`、`FrameProgram/Lowering`、VSM allocation/raster/contentVersion直接消费者。`node tools/vibe.mjs context <path>`读取owner authority；导航不是正确性证明。
2. 保留receiver聚合、原boxPCF、完整page身份；确认新增diagnostic selector现在不存在，不能假称已有query-only结果。
3. 最小correctness只覆盖改动链：既有Native/VSM contracts及receiver/R2/R3相关CPU checks。仅源码审查不能声称过去GPU oracle在本HEAD新鲜通过。

### 3.2 最小资格实验与边界（实际运行范围见§3.5–3.6）

| 假设 | 只变哪个变量 | 指标 / 支持 / 否定 |
|---|---|---|
| query是足够大的重复成本 | 新compile-time slice保留full material/Sun，执行同query并保活production所需的返回字段，不执行PCF；再与F/G对照 | Native/selected span、最小anchor的ALU/liveness变化单列；不为保活unused entry字段制造巨大anchor。query差很小且Qpublication估算更大则否定Q；差分不是可加pass成本 |
| PCF/live-state是主要惩罚 | 保持query与正常bias，单独计时真实16PCF局部shader与fused slice；不在正式生产换tap | 独立PCF不能代表fused增量；若分离仍很贵，不能用“少寄存器”承诺S。register/occupancy无计数则标待验证 |
| tile可共享完整query | instrumented统计从实际Native position/lightXY得到的完整selected clip/worldpage/mip/epochs，以及fine/coarse结果和有效lane数；不得以receiver的depth反投影keys替代 | 每组distinct key/result histogram、重复率、invalid/partial；word重复不能替代。高entropy否定local aggregation，不因此否定整个Q/S |
| raster突发与source/caster失效相关 | 不改算法，只增加诊断关联记录，正式timing关闭GPU统计 | per-frame reason/revisions/depth-domain/dirty/pairs/commit拒绝与raster同帧对应；没有对应关系则不能写已定位因果 |

以上共用§2固定view/功能/热条件。diag改变输出会影响下游Temporal，Native定位窗口与全帧性能窗口分开报告。保存每次失败、不以anchor改变后的Total GPU当正式After。

### 3.3 实现选择与Cutover

资格结果先写清query量级、full-key entropy、所需产品字节与峰值、HDR/normal支持域、新增pass/初始化/consumer绑定，以及Q/S分别有哪些工作可真实删除。按设计§3.3选择最有净收益依据的一项；硬件register/occupancy计数不可用时不能把P1无限卡在取数，也不能把原因推断写成硬件事实。没有可用候选则拒绝出口，不强行实现。

**Q资格**：若预选coarse，须证明fine-cell到coarse结果的所有f32边界；Q-exact改为独立fine/coarse plane并保留原pixel寻址，不依赖该假设。冻结原query oracle→完整u32identity→全写域16Bdescriptor→post-commit pageTable/contentVersion FrameGraph依赖→Native/debug/continuation全部读新product。管理页表有真实allocator/debugconsumer就保留；生产采样中被替代的管理entry校验删除，不留Legacy/New fallback。异常/dirty/missing保持旧neutral与diagnostic原因，overflow未完成页不得标valid。

**S条件资格**：确认所有现有Sun BRDF在线性有限域的因式分离，保留`re_direct_physical`的non-finite contribution拒绝语义，bias coefficient由mapped normal求出、resolved mip的depth_per_texel由resolve算，定案最小actual product。native一次material求值发布baseRGB/unshadowedSun/精确receiver facts→screen resolve16boxPCF与Sun合成→finalHDR交所有Aerial/Temporal/radiometry/debug/presentconsumer。unshadowed溢出但原shadowed有限等case不能被“线性证明”排除；若要改为系数产品/延迟finiteguard，先更新Cost Card与oracle，不能偷换支持域。保守48B/pixel布局及40B紧凑layout先做能力与4GB峰值预算；32B或half压缩必须先有numeric证明，不凭容量压力删字段。无VSM/nonreceive/unlit/background完整写域，普通/Product/coat/reactive/MASK含义保持。

S写域必须从当前`SurfaceV4.encode`的全域copy/clear与稀疏winner writes迁移，明确背景copy/clear、每个receiver product初始化值、invalid/unlit/non-receiver标记和resolve分支；不能沿用Native早退后假设全域已写。最终valid/receive字段及读取winner/instance的成本入账，不能把40B数值载荷估算直接声明为闭合ABI。若初始化需新pass或额外copy，修改Cost Card，不隐去开销。

S如果只是把同16PCF移到别pass而新增大带宽，且无净收益依据，则拒绝，不因Native桶变小保留。所有候选最终仅一种生产execution scheme；reference shader/旧producer只在oracle冻结，不永久常规A/B。额外GPUproduct由VSM/Surface各自实际owner管理，Renderer不变成新资源操作系统。

### 3.4 Correctness、性能与出口

oracle覆盖：fine/coarse/outside/missing/stale/dirty、fullslot/generation/projectionEpoch/namespace、负世界坐标/f32页边界、window滚动、empty ready、allocation≠contentready、overflow/partition failure、gutter/slot clamp/zero depth/负reference/bias/taps。S另比material numeric、normal map/grazing、coat、unshadowedSun、HDR/pre-exposure/color conversion、reactive/motion、diagnostic_mode与背景。nativeposition与depth重建不得默认为逐值相同。

生命周期：prepare→encode→abort/retry→submitcommit→completionretire；sun/camera/scene/casterpublication、geometryeviction、resize、device-loss/destroy。newproduct全写或有严格versionclear，不读上一frame未完成内容；in-flight不能被复用销毁。context限额采样纹理/storage buffers/storage textures/samplers完整协商，旧resource-limited continuation需重新证明。

串行After按§2三轮；同时报告Native+Qpublication或Native+Sresolve+初始化+全部consumer同帧合计、Total GPU/尾帧、CPU与APIpeak。单pass下降不足以验收；温度/驻留不可比不算精确比例。净收益不成立→撤回productioncandidate、保留diagnostic与拒绝结果，P1可完成为“证伪出口”。候选numeric/支持域失败不能追认为修复；撤回后受影响的稳定生产正确性与接线检查通过，可记录为rejected出口。稳定生产仍有必需correctness/lifecycle失败时P1 incomplete，不进入P2。

### 3.5 P1实施记录（2026-10-11，资格与候选冻结）

【实测事实】`46a5d9f3`生产采样reference上的F/Q0/G资格组，各三轮240提交帧、固定窗口60 timestamp样本，1080p/DPR1/原近景/1536MiB/high4×4/FSR ON。Native P50分别为F `6.140/6.676/7.221`、Q0 `6.940/6.816/7.956`、G `10.204/10.918/10.315` ms。Q0保留production query、UV/reference/mapped-normal bias并加最小anchor，不执行PCF；F→Q0约`.801/.140/.735`ms，非纯query硬件计数、非严格可加成本。三组都有raster/尾帧突发，全部原值保留；热降频Active，不能凭不同轮次算精确比例。原件在`.local/validation/p1-vsm-2026-10-11/{no-query,query-only,full-reference}`。

【实测事实】K从实际Native重建position记录完整world/selected/resolved query：2,073,600 receivers，32,400 screen8×8组，组内distinct fine/result求和38,942，全局326；duplicate ratio98.122%，26,709组仅一个key。该快照全fine/target fine，不证明整个窗口或运动没有fallback；K增加32B/pixel统计产品和全域初始化，**不用于timing**。初次K因Surface profile校验漏接新增binding失败，原失败保存在`full-keys`；修复完整descriptor校验后`full-keys-retry`成功，未跳断言。

**冻结唯一实施候选Q-exact（本地自主实现）**：post-content-commit→每clip fine/coarse独立compact descriptor→Native/debug/continuation查询。与§3.3目标Q的区别是保留精确每pixel coarse world计算和原fallback顺序，不用fine cell中心预选最终coarse。原因：当前legal projection extent不必为2的幂，WGSL f32 division/subnormal边界没有足够跨驱动证明；用同一`vsm_world_page/window`函数寻址可消除这一支持域风险。生产只读compact状态，不读管理页表，不建立第二query实现。完整generation/epoch/namespace/world/mip/flags在producer验证，无身份压缩；allocator/caster管理表保留真实consumer。S本轮不实施：资格没有证明分离PCF的收益足以覆盖48B产品/finiteguard迁移与新增带宽。full-key重复支持后续研究，不在本候选同时加入workgroup聚合。

冻结Cost Card：删除每pixel48B entry结构的字段读取与完整flags/identity验证，以及旧多mip-plane索引计算；**不删除clip选择、coarse搜索、PCF16samples或任何receiver**。新增每clip`128²+8²`个16B descriptor，共98,688条/1,579,008B（1.506MiB）；全写域一个64-lane dispatch，约98,688次管理entry验证/读，fine与coarse分面；Native读16B compact记录。实际DRAM并不等于逻辑结构大小。无新增atomics/barriers/history，PCF原ALU/纹理loads不变。FrameGraph瞬态池负责容量/在途/abort/resize/retirement；新增pipeline/binding冷准备与一个pass，常态无逐pixelCPU分配。最优：大量重复身份校验可删且产品驻缓存；通常：未知；最差：原query已cache好，publication和compact额外流量净亏。break-even为Native节省大于publication+依赖/容量税；0%节省必亏，50%/100%仅代入被测差分，不当收益预测，`.14–.80ms`本身含anchor与热条件变化，不能承诺。至少三轮After同时比较Native+publication同帧合计、Total及尾帧；净收益不足则撤回这一个候选并停在拒绝出口。

### 3.6 P1出口：Q-exact采用与实际验证

【源码事实】`VsmAtlasRasterPass.addToGraph`在完整dirty-page/contentVersion提交之后调用`VsmSamplingPublicationPass`，读取同帧sampling constants、写后pageTable、contentVersion；64-lane dispatch完整覆盖fine/coarse plane，包括outside/missing/dirty/stale。`FrameProgramLowering`把瞬态产品的写后ResourceId交给Surface binding1:9，Native普通/Product、debug、资源受限Sun continuation都通过同一个`vsm_lookup`消费16B记录。allocator/caster继续消费48B管理entry。无第二production sampler、独立submit、CPU反馈控制、history或持久descriptor缓存。瞬态池负责在途回收；owner销毁/设备丢失清除有限bind-group引用，下一帧全写避免abort/retry读旧产品。neutral constants保持depth-valid=0，16B neutral binding不产生假ready。

【实测事实】原件根`.local/validation/p1-vsm-2026-10-11/`。下表只取每轮`targetStart≤frameIndex<targetEnd`的240提交帧/60完整timestamp样本，不使用runner轮询延长后的console窗口；没有剔除异常。最终统一采用`(n−1)*p`线性插值分位数（`final-quantiles.json`），因此与§3.5资格摘要的旧rank估计有微小差异。所有成本单位ms，净成本是**每帧Native+publication先求和再取分位数**。

| 组/轮 | Native P50/P95 | publication P50 | Native+publication P50/P95 | Total command span P50/P95 |
|---|---:|---:|---:|---:|
| 冻结reference full-1 | 10.197 / 24.617 | — | 10.197 / 24.617 | 33.562 / 57.581 |
| 冻结reference full-2 | 10.905 / 17.478 | — | 10.905 / 17.478 | 23.125 / 37.247 |
| 冻结reference full-3 | 10.309 / 23.941 | — | 10.309 / 23.941 | 22.100 / 46.607 |
| After full-1 | 9.116 / 12.464 | .049 | 9.165 / 12.520 | 32.750 / 43.063 |
| After full-2 | 9.777 / 12.076 | .050 | 9.827 / 12.130 | 21.288 / 25.532 |
| After full-3 | 10.095 / 16.779 | .050 | 10.144 / 16.846 | 21.783 / 34.541 |
| 窄配对reference full-1 | 10.086 / 13.056 | — | 10.086 / 13.056 | 22.443 / 49.447 |
| 窄配对reference full-2 | 10.033 / 35.020 | — | 10.033 / 35.020 | 21.512 / 87.098 |
| 窄配对candidate full-1 | 9.295 / 19.311 | .049 | 9.344 / 19.394 | 22.667 / 51.004 |
| 窄配对candidate full-2 | 9.401 / 24.148 | .049 | 9.449 / 24.245 | 20.723 / 47.942 |

【判断与限制】采用Q-exact：三轮After和额外两轮窄配对均观察到覆盖新增publication税后的局部P50下降，publication约.05ms，删除工作与成本方向一致。**不是无锁频的精确因果百分比，也不是稳定全帧/P95提升证明**。GTX1650Ti、driver581.42，计时窗口88–91°C、SW thermal slowdown全部Active，频率300–1350MHz；配对reference多数活跃读数1080–1245，candidate第二轮975–1140，采样较疏不能逐帧锁频配对。窄配对第一轮净mean从10.423增至10.725、净P95从13.056增至19.394、Total P50也略变慢；不能隐藏。原After第一轮34/60样本raster>1ms（reference29/60），后两轮0/60，但仍有其它尾帧。局部数据支持保留低税候选，不支持“Q已解决VSM总体开销/所有卡顿”。S未实施；没有独立fused-PCF硬件计数、寄存器/spill/occupancy证据，不推断CSE或寄存器改善已经发生。

【覆盖/CPU/内存事实】固定原近景1080p/high4×4/FSR、geometry1536MiB不变，After实际Dungeon覆盖90.657–90.694%；counter窗口全域shadedPixels2,073,600、MeshletWork605、invalidVisibilityKeys=0。三个After窗口resident1207/pinned381、evict/reload/failed=0，streaming error为空；main/shadow ring累计丢slot12→22→35（counter末47），scheduler demandOverflow/malformed=0；ring丢样不是request overflow，原completeness/eviction保护仍在，不把丢样清零来验收。末帧VSM demand326/allocated440、allocation failure各错误位0、dirty0，末帧无dirty不能证明整个窗口settled。同步render CPU固定窗口P50/P95为2.715/4.805、2.465/4.025、2.535/5.705ms（旧rank统计），不宣称CPU提速，不能代替TaskDuration。产品1.506MiB/在途实例是新增working set，计入共享瞬态池；不能称零显存税。OS一次full-2 Chrome GPU进程dedicated约2579.74MiB、shared两个adapter合计154.75MiB，不等于descriptor容量或全系统显存；完整OS/heap/资源原件保留。新增一dispatch，每帧无逐pixelCPU对象，不减少PCF samples、receiver或材质工作。

【full-key诊断】最终K快照（`full-keys-identity-retry/full.json`）2,073,600 receivers、32,400 screen8×8组，组内distinct fine/result总计38,943，全局324，重复率98.12196%，所有fine。histogram `64/1/1:26709,64/2/2:5049,64/3/3:443,64/4/4:191,64/5/5:6,64/6/6:1,64/7/7:1`。完整共用generation255/epoch255/namespace1与selected/full signed-world/mip/result一起保存，来自真实Native reconstruction，不是receiver反投影。支持查询具有局部复用的假设，**不是warp/bin组共享的收益证明**；这里是screen统计域。K每pixel32B、两层全清，计时污染，未进入正式After；默认G没有K资源、分支或atomics。旧K快照不含共用identity、第一次新增identity读取错用padding偏移的记录保留，以上只引用修正后原件。

【正确性与失败分类】fresh `build:test`、typecheck、引擎build、Dungeon诊断build通过；受影响41个CPU contract/unit/oracle通过，包含容量拒绝、post-commit依赖、K两层清域、resize abort/fence及device loss。真实GPU `vsm-sampling-publication`四组各18,508查询共74,032次，冻结原WGSL的状态/fallback/有效slot/mip/4×4 visibility逐位一致，覆盖完整高u32身份、signed f32 nextafter/subnormal、非2幂extent、滚动window、missing/dirty/stale/poison、gutter/零深度/负reference；R2/R3、Native integration与真实Renderer geometry-shadow-view通过。后者含off-camera caster、alpha、receiver/caster运动、HDR、故障abort/retry。Native integration初次失败是fixture仍把48B管理表绑定到新16Bconsumer，迁移fixture producer并修coarse plane容量后重跑通过，未放宽PBR容差（max error约.000256）。K初次缺binding15 profile校验、device-loss测试fixture错误均已分类修正，原失败保存；不冒充最初通过。默认场景Before/After截图人工检查无明显变化，numeric优先；未完成VSM R4全模块质量、全设备controlled loss重建、跨驱动f32全域证明、逐帧invalidation reason/caster-pair因果、锁频ABBA。P1不代替这些验收。

【来源与停止】重新核对Blender固定revision的`tilemap_finalize_main`，只参考management→sampling publication的架构；Q-exact为本地原创WGSL，无GPL代码复制或移植/adoption声明，具体映射见porting。完成一次唯一生产切换后停止；P2/IBL/allocator/loader未实施，新高级effect仍延期。

### 3.7 S2出口：独立 Projection 完整实验，未采纳生产

【源码事实】开始时与本次最终源码中 Physical Sun 仍使用 mapped shading normal 的 embedded query/PCF；普通 authored directional 的 `hasShadow` 在 LightDatabase producer 已拒绝，不能把其不可达分支当作第二个合法阴影namespace。本次曾完整切入临时生产源码：Visibility winner +精确3-corner position/normal→post-commit descriptors/atlas→8×8 Resolve→packed visibility→Native Sun；FrameGraph依赖、neutral/off、full写域、settings/gen/mode copies、pool/resize/abort/retry、device loss/释放一起闭合。最终因性能门未过，已恢复当前HEAD原生产owner/bindings/数学，不保留runtime双路径或测试专用fallback。全部候选源与cutover diff保存在 `.local/shadow-v2-prototype/`；精确Resolve/packing复现只留test-only fixtures，不能称新production consumer。

质量/成本在After前冻结于设计§3.0。4×4/原radius/gutter/fine-coarse/reverse-Z保持，唯一有意候选质量语义为geometry-interpolated shadow bias；BRDF仍mapped normal，不把两种bias逐bit等同。mask用core r32uint四横像素/texel，低5bit count、高2bit taps-axis−1，默认k/16精确；+1.98MiB单产品、一个pass/dispatch、288B shared/2 barriers、144+16B owner buffers，0 history/atomics/独立submit。Native删除embedded sampling后仍新增Resolve重建及mask读写。fine leader broadcast可删除重复descriptor reads，**未删除16PCF depth taps**；硬件cache/寄存器计数并未直接观测。

【实测事实】Previous Gate见§1。临时生产fresh build:test/typecheck；相关CPU contract/replay 30/30、diagnostic contracts 12/12。GPU exact product 600,168断言，128×64/97×43/9×7/1×1、1..4 tap axes、background/tail/no-receive/unlit/transparent/高位stale generation/invalid depth、poison full write、abort/retry和destroy拒绝；analytic +Z/grazing Sun/nonzero bias与原per-pixel sampler解码逐bit一致。完整query oracle 18,508 points×4modes×两对照，六种状态、f32 clip/window/gutter/负reference与原 frozen query/PCF一致。候选真实 `native-surface-perspective`、ordinary Renderer、Product Renderer/recovery、off-camera caster/MASK/shadow abort/retry通过，未放宽material/HDR/LOD/motion/exposure容差。测试标签 `oracle/direct instance patch/restore` 不属于已登记submit owner导致原Product oracle失败；改为已存在maintenance标签后通过，只改test不改生产submit seam。reserved WGSL `active`、旧test provider缺COPY_SRC、一次stale-build失败均保留，分别局部修正后重跑；403静态资源console记录不冒充GPU validation error。

受控Dungeon max-throughput：GTX1650Ti4GB/581.42、1920×1080、DPR1/renderScale1、固定原近景、VSM high/6clips/4096/4×4/radius0.75、FSR ON、GTAO/Bloom OFF、原材质/Sun。旧生产来自独立worktree `9ca9ae1f`，仅复制相同测量runner；非新production A/B开关。静态几何settled后重新开启full capture，每轮严格240CPU frames/60完整full GPU samples。以下都是窗口自身分位，Native+Resolve先逐帧相加后取分位，**不加桶P50/P95，也不加CPU/GPU**。CPU frame仅profiler的同步render范围，不包括全部异步CPU/interaction/GC：

| 窗口 | Total P50/P95 ms | Native P50/P95 | Resolve P50/P95 | 同帧Native+Resolve P50/P95 | Temporal+Facts P50/P95 | VSM management/raster P50/P95 | CPU frame P50/P95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Embedded A1 | 21.862/67.235 | 8.860/19.068 | — | 8.860/19.068 | 6.760/25.269 | 1.401/2.823 | 2.575/5.230 |
| Resolve B1 | 26.587/53.539 | 6.764/12.691 | 4.215/8.587 | 11.078/21.278 | 8.152/15.278 | 1.728/3.383 | 3.015/5.860 |
| Embedded A2 | 22.248/103.940 | 8.939/45.308 | — | 8.939/45.308 | 6.868/41.571 | 1.431/3.815 | 2.360/3.940 |
| Resolve B2 | 29.951/32.815 | 7.820/9.202 | 4.754/5.681 | 12.651/14.335 | 9.135/10.008 | 1.931/2.589 | 2.445/3.805 |

A1/B1/A2/B2 sensor窗口均89–91°C附近且SW thermal Active；graphics MHz范围分别300–1170、735–1050、390–1035、300–720，采样中位825/780/945/705。不能用稀疏1秒sensor对逐帧normalize，不能以P95较低宣称收益，亦不能把精确退步百分比归因本方案。全部最大值135.808/140.374/133.168/134.230ms保留。**证据不足以通过净收益门**，不是已证明该架构在全部硬件/算法下必然更慢。早期非settled两轮Native+Resolve P50约9.053/9.361ms同样不能当纯稳态同热收益。额外triangle broadcast（464B shared/3 barriers）numeric通过而该轮Resolve4.706ms，未采用，不因为81.03%leader匹配就写收益。

上述四轮model coverage90.664–90.703%、invalid0；resident1207/pinned381、pending/inflight/verified/retiring0、evict/reload/failure/overflow/malformed0、streaming error null。main/shadow反馈drop另留原counter，不混同packet overflow。API live旧1,358,822,565B→候选1,362,969,813B，+4,147,248B，与两在途mask容量一致量级；peak旧1,437,586,629/1,437,619,397→候选1,441,733,877/1,441,766,645B。均在既定envelope内、释放后API bytes0/unknown为空；**不是Windows专用显存/RAM或payload指标**。候选headed full→motion→no-vsm无console/GPU/streaming error，关闭VSM不再调Resolve且使用neutral mask；该功能关闭窗口只检查功能边界，不计同质量收益。截图保存，独立shadedPixels计数/完整动态VSM R4/normal-map极端斜面长期画质组未另完整验收，不伪称通过。

原件：`.local/validation/shadow-v2-2026-10-11/{embedded-settled-1,resolve-published-1,embedded-settled-2,resolve-published-2}/`，每轮raw frames、sensors、fingerprint、API inventory、截图和errors保存。初版 `resolve-settled-1` 因settled等待消耗120采样预算，窗口32 full+28 coarse；归类测量失败，runner现重新configure并严格拒绝mixed window，原件不删。最终旧生产恢复后的fresh build:test/候选oracle复现与docs verify结果在提交正文说明，不再重跑整套baseline。

【判断/待验证】本次主要把PCF成本搬到新桶，fine descriptor coherence不是PCF省采样证明，geometry重复/写读/同步税尚未被净抵消。用户以极致性能为优先，保留稳定生产路径；没有收到允许牺牲净性能只为切架构的不同偏好。后续需另冻结能真正删除主工作且通过画质门的方案，不能自动开history、hardware/少tap PCF、半分辨率或Temporal。本次止于明确拒绝，不把生产剥离或60FPS状态标complete。

## 4. P2：Native Temporal V2完整单元

先重读`Fsr3UpscalerRuntime`全部history/prepare/commit/abort/resize与`OEngine/src/render/TemporalFabric.ts`实际owner，`NativeTemporalFacts`、radiometry/frame facts、FrameProgram及所有输出consumer。不要凭名称新增新的Fabric框架。

分成三个相继的完整子单元，每个出口停止，不把十几个patch不断跑Dungeon：

| 子单元 | 删除/新增 | 验证与拒绝 |
|---|---|---|
| T1 同算法产品闭包 | 删除upscaled_output重复store/texture/binding；RCAS读`builder.write(currentHistory)`返回版本 | historyRGB、lock alpha、RCASoutputalpha1逐值；Graph不误读prior版本；abort/defer不推进index。失败不放宽容差 |
| T2 同算法tile执行 | 1:1current neighborhood10×10 f32 shared、uniform barrier，保留current/historyfilter/math | edge/partial extent、jitter flip、initial/resolved、history16tap、HDR/曝光/锁逐值；通常GPU收益未知，增加shared/register税更慢则撤回 |
| T3 Native Temporal算法/图替换 | 当前所有必需Facts→analysis/scatter→depthresolve/classification→resolve/quality所需sharpen；删除不再有consumer的旧Native-AA SPD/history等 | 按下述动态质量与生命周期完整验收后才切生产；upscale域保留真实支持路径，不保留测试专用FSRReferencePath |

T1/T2是确定工作删除与风险受控入口，**不能宣称它们已经达到T3大重构目标**。T3非生产期间完整构建，临时oracle对照当前FSR与新候选，质量/成本支持后一次切换所有生产Native-AA consumers并删除旧依赖。Native/upscale policy按物理resolution/能力选择，同frame不可混合两个history；切policy在prepare事务申请新generation/history，有明确定义reset，不每帧来回thrash。

T3先定数学合同：jitter与motion符号、reverse-depth/单位、prevUV、hardreplacement/完整identity、disocclusion、reactive/transparency/locks、historycolor domain、hostpre-exposure与conditioning、所有history字段真正consumer。不要预先承诺2–3dispatch；same-frame scattered previous depth的全域完成必须在读取前有dispatch依赖。ping-pongclear首次/resize/abort/in-flight严格清域；选择它只是省clear编码/工作机会，不免除实际下一buffer写。

当前Facts motion为jittered current-minus-previous UV，FSR prepare使用`motionVectorScale=[-1,-1]`并取消jitter，再以`uv + preparedMotion`重投影。V2必须从这一真实转换定符号，不能同时照搬pmndrs的`uv - motion`和现有prepare。identity沿用四个u32实际字段及signature算法；不同instance/winner主要由depth/shading判定，当前local hard replacement是同instance的资源变化/同material slot版本变化，不能把任意winner变化升级为全域硬reset。new Facts字段/解释不得未经合同修改。

T3质量门在实现前列入对应单元记录：固定camera/motion/曝光序列、warmup与采样帧范围、linear-HDR和display-space ROI、静止残留/闪烁、运动拖尾/拒绝率、细线保留和收敛/光照step响应的计算方法及可接受标准。沿用既有numeric oracle的容差；新算法无法用逐值相等评价的部分，依据reference与当前质量合同确定标准并冻结，不能在看到After失败后改阈值。至少覆盖后述每个序列，不仅给一张最终截图或平均RMSE。标准缺失/质量退化未关闭则T3保持非生产，不以benchmark更快替代验收。

最小实验逐个变量：替换shading-change detector、history filter、rectification/locks、sharpener分别在局部oracle标识，不能全部同时变后归因。pmndrs mean-ratio/besttap/8frameblockmemory属于算法选项，不作为默认必要组合。sharedtile只复用相同支持域，不越workgroup读写未完成中间。

质量序列至少包含：静止收敛→slow/fast orbit→pan→dolly in/out→停止；foreground/background反向motion与disocclusion；细线/Siemens/高频alpha-MASK/normal/specular；material/geometry hardreplacement、moving caster/Sun/光强step+ramp；host exposure/pre-exposure step；HDR孤立极亮点与plateau/coat/反射边缘。除截图外采linear HDR/halfoutput逐值、temporal拒绝/confidence/history、ROI误差与时间响应；不可用ACES/sRGB8bit掩盖firefly。算法变化用明确质量合同判断，不靠放宽旧numeric tolerances制造通过。

正确性还覆盖pause/step/admissiondefer、resize/renderScale切换、pre-submitabort/retry、in-flightretirement、device loss、destroy，frame_count/timeDelta仍按真实submission。性能After独立同质量1080p/window，多轮记录Temporal同帧净成本、Total、Native、CPU与新增memory；T3若未取得同质量证据不切换，可提交T1/T2且明确V2尚未完成。

### 4.1 T1实施前冻结：同算法产品闭包

【源码事实】`f6f7189f`的Accumulate向history与临时upscaled各写一次同样的RGB、同样的RGBA16F转换；前者alpha为lock，后者alpha为1。唯一直接消费者RCAS只读取RGB，写出的最终alpha始终为1。T1在所有scale删除第二产品，返回`builder.write(currentHistory)`的写版本供RCAS读；不改FSR数学、history16tap、3×3current采样、曝光、抖动、锁和锐化。

Cost Card（先于Dungeon After冻结）：删除一RGBA16F顺序store/pixel、一个output-full临时texture及一storage binding；1080p为16,588,800B/帧（15.82MiB逻辑写流量），RGB ALU/loads/samples不变。新增GPU ALU、load/store、atomic/barrier、dispatch/pass、workgroup memory、history均为0；RCAS原有五tap读取改为同帧history物理纹理。CPU不再声明/获取该临时产品和binding，未测量逐帧分配时间。persistent working set不变；逻辑瞬态产品删除不等于OS显存减15.82MiB，物理池别名与在途帧决定实际收益。理想情况消除对应写带宽及分配压力；通常受ALU/history采样主导，时间收益未知；最差可能因不同物理纹理地址/驱动调度导致局部时间噪声或退化。0/50/100%写流量转为净外存减少分别为0/8,294,400/16,588,800B，不是帧时百分比。break-even为删除store/资源处理的实际成本大于任何新增物理访问/调度影响；不能把整个Accumulate时间当可获得收益。没有额外submit或CPU反馈控制。

验证：冻结旧Accumulate WGSL只作为测试fixture，实际新pass→写后history→实际RCAS与旧双产品逐位比较；CPU graph检查禁止读写前版本，history commit/abort/resize/fence用既有owner检查。最小GPU组覆盖1:1及上采样、partial extent、jitter两轴flip、initial/resolved、motion越界、reactive/disocclusion、HDR与曝光变化、lock alpha和最终alpha1；真实Native integration随后检查整体接线。性能只在单元闭合后用既定三轮240帧、counter独立窗口；Before取P1已保存After，不重跑完整baseline。T2/T3不在本次出口实现。

### 4.2 T1出口：产品删除成立，稳定帧时改善未证实

【Previous Task Gate】重新核对`f6f7189f`的P1实际diff、post-content-commit publication及全部Native/debug/Sun consumers、原GPU/After记录，fresh build:test后28个受影响checks通过；新鲜sampling GPU oracle的74,032个query/PCF逐位一致。没有发现需要补交的生产遗漏。P1的热状态、尾帧、完整VSM R4与跨驱动缺项仍如§3.6，不从局部通过扩大验收。

【源码/接线事实】Accumulate删除binding11、第二textureStore、`FSR3/upscaled color`临时texture及双产品接口；唯一返回写后history，runtime直接交RCAS，binding10也解析写版本。RCAS数学不变，只读RGB，最终alpha1；history的lock alpha不变。cached graph仍晚绑定Fsr3 owner的read/write槽；prepare不换槽，成功submit后commit，abort/resize/fence/device loss仍由原owner管理。Native Facts、identity、reactivity、SPD、history filter、RCAS五tap、所有输出consumer保留；dispatch/pass数量不减少，无新增submit、atomics或production双路径。冻结旧shader只在oracle fixture中。

【实测口径】原件`.local/validation/p2-t1-2026-10-11/`；Before是`.local/validation/p1-vsm-2026-10-11/after/`，不是重新跑Baseline。After使用明确performanceCapture throughput、G生产shader，无K/receiver instrumentation；固定原近景、1920×1080/DPR1/scale1、高质量VSM4×4、FSR ON、GTAO/Bloom OFF、geometry1536MiB。每轮严格取`[targetStart,targetEnd)`的240 CPU帧/60完整GPU样本，线性分位数；不使用UI滚动窗口代替目标窗口。Temporal为每帧两段temporal stage（Facts与FSR）之和再求分位数，Accumulate+RCAS同理，不相加各pass的P50/P95。

| 窗口 | Accumulate P50/P95 ms | RCAS P50 ms | Accumulate+RCAS P50/P95 ms | Temporal P50/P95 ms | Total span P50/P95 ms |
|---|---:|---:|---:|---:|---:|
| Before full-1 | 1.995 / 2.683 | .224 | 2.222 / 2.973 | 5.516 / 7.636 | 32.750 / 43.063 |
| Before full-2 | 2.156 / 2.821 | .238 | 2.395 / 3.118 | 6.057 / 7.121 | 21.288 / 25.532 |
| Before full-3 | 2.235 / 3.470 | .246 | 2.482 / 3.777 | 6.216 / 9.047 | 21.783 / 34.541 |
| After full-1 | 2.083 / 2.849 | .229 | 2.318 / 3.153 | 5.692 / 7.728 | 34.240 / 38.903 |
| After full-2 | 2.203 / 3.393 | .242 | 2.446 / 3.744 | 6.172 / 9.156 | 21.792 / 33.831 |
| After full-3 | 2.095 / 4.154 | .233 | 2.328 / 4.539 | 5.944 / 10.295 | 20.977 / 54.362 |

【判断】确定删掉无consumer的重复写出与资源，**未取得稳定GPU帧时改善证据**。前两轮局部P50更慢，第三轮局部P50下降而P95与mean退化（Accumulate+RCAS mean 2.700→3.131ms）；全帧第三轮P95也恶化，全部保留。Before/After driver581.42、89–91°C、SW thermal slowdown全Active，clock分别300–1350与300–1215MHz，采样稀疏无锁频，不能作精确因果比例或认定尾帧退化由T1造成。Native未改，After P50为9.414/10.049/9.691ms，也有跨轮波动。没有寄存器/occupancy/外存写事务硬件计数；不宣称所有15.82MiB都转化为DRAM流量或速度收益。

【CPU/内存】同步render CPU固定240帧Before P50/P95 2.715/4.810、2.467/4.027、2.535/5.710ms，After 2.420/4.100、2.363/4.117、2.230/3.381ms。CDP TaskDuration两次采样差Before3546/1722/1646ms、After3160/1511/1551ms，对应page墙钟窗口Before8.100/6.095/6.093s、After8.109/6.077/7.085s，包含其它CPU及窗口overshoot，不是240帧同步render时间，不宣称全部CPU成本提速。软件shared transient texture pool三轮均275,292,880→242,115,280B，少33,177,600B/31.64MiB（本次两份在途产品）；审计全API live同量下降，persistent FSR仍78,797,009B。单产品逻辑删除15.82MiB，池/OS收益只引用本次观察，不泛化到所有in-flight/alias场景。Chrome GPU进程full-2专用显存Before2579.74MiB、After两次2541.13/2555.08MiB；不同采样时点和shared/system开销，不当作精确allocator因果。整个Renderer旧软件owner账仍漏项，用API容量、payload、OS驻留不同口径分别记录。

【场景/错误】After三轮实际Dungeon coverage90.657–90.708%，counter shadedPixels2,073,600、meshlet605、invalidVisibilityKeys0；resident1207/pinned381、evicted/reload/failed0，streaming error为空。main/shadow readback ring丢slot保留（counter末各32），scheduler demandOverflow/malformed0，不把丢样称为无overflow；旧completeness/eviction保护未改。VSM末帧demand323/allocated437，各allocation失败位0；dirty0只描述末帧。runner errors空；`accepted:false`是诊断报告未获全模块正式验收，不当作成功验收。Before/After full-2截图人工检查无明显变化，numeric为主要证据。Submitted FPS是report滚动吞吐，32.839/40.870/37.823；Presented不可得，不与固定GPU窗口混算。

【正确性与限制】typecheck、引擎build、fresh build:test、Dungeon诊断build通过；15个Temporal/FSR contract检查通过，含写版本真实依赖、原槽不读、history角色/resize abort/retry与completion fence。新`fsr3-accumulate-products`真实生产pass→history→RCAS在16组比较90,376个32bit读回word逐位一致（1:1、2×、非整数ratio、NPOT/partial、HDR、exposure、jitter、motion/rejection、initial/resolved、reactivity、lock与opacity）。这是冻结本地旧数学的产品等价验证，不是新的独立FSR算法证明。Native integration实际FSR chain、history retention/motion/曝光/resize abort-retry通过；`native-surface-device-epoch`两个独立device epoch销毁/重建通过，不等于模拟driver fault/整个Renderer recovery。初次oracle失败为fixture R16F输入误声明storage usage；第二次为fixture对FrameGraph而非compiled graph调用destroy，修复后重跑通过，未改生产数学或放宽断言，原失败保存。

【出口】保留同算法冗余产品删除及已量到的瞬态容量收益，帧时收益标为未知。未运行完整旧baseline、锁频ABBA、driver硬件计数、T3动态画质矩阵及全部Renderer recovery/交互browser矩阵；本单元没有改变simulation/admission/temporal reset策略。按§4子单元出口停止，T2需要独立tile数值/成本验证；T3数学/质量合同及新图仍未实施，**P2整体未完成**。来源核对与实际映射见porting，非新FSR算法adoption。

### 4.3 T2实施前冻结：native current-color tile

【资格/范围】T1新鲜15项CPU checks与产品GPU oracle通过，原profile与提交一致。本次用户授权继续P2并随后P3，覆盖原每子单元停止规则；仍分单元提交、GPU串行、一个变量测量。WickedEngine固定revision的`temporalaaCS.hlsl::main`只参考halo→uniform barrier→邻域执行方式，不复制packed half/Gather、depth/motion算法。当前FSR在1:1的flip后支持域始终[-1,0,1]，因此8×8输出只需要10×10 current-color tile；真正upscale继续同owner的通用kernel，不是旧/新bridge。

Cost Card：每完整组current逻辑textureLoad 576→100，prepared-color f32曝光/YCoCg亦由576→100次，history16tap、initial逐pixel tonemap与所有滤波/权重顺序不变。1080p最多减少15,422,400次逻辑texel读取/帧（RGBA16F按8B计约117.66MiB逻辑流量，cache下实际DRAM删除未知）。新增100×vec4f=1600B workgroup storage、100次shared写、576次shared读/组、一次uniform workgroupBarrier及index/halo ALU；没有global产品/history/atomics/pass/submit增加。所有partial组inactive lane仍初始化全部100cells，再barrier，再按原extent return。当前RGB预处理保持f32，不共享motion-dependent history。新增一个冷pipeline，生产按真实render/output域选择；upscale没有shared声明/税。best为current loads/ALU主导时盈利；通常纹理cache与history/权重占比限制收益；worst shared/register/occupancy税超过删除工作则撤回。0/50/100%逻辑读取节省转为DRAM节省是0/58.83/117.66MiB敏感性，不是时间提升比例。break-even为current读取与预处理节省大于shared/barrier/occupancy代价。Before使用T1已保存三轮，Accumulate约2.08–2.20ms只作全pass理论上界。

最小验证：冻结旧产品oracle加入多tile/NPOT/partial的1:1与原upscale组，逐bit比较history RGB/lock与RCAS；检查所有halo写先于uniform barrier，原math/identity/lifecycle不变。单元闭合后才做限定Dungeon三轮After；无净收益证据不能仅凭576→100宣称更快。T3另需质量合同，不把T2冒称新算法。

### 4.4 T2出口：数值一致，但净成本不支持采用

【实测事实】原件`.local/validation/p2-t2-2026-10-11/`。T1 gate新鲜build:test、15项contract、90,376 words GPU产品对照通过。T2候选fresh build:test/typecheck/engine及Dungeon诊断build、15项checks、24组209,440 words产品对照逐位通过；Native integration actualFSRChain与resizeAbortRetry通过。partial/multiple tile/NPOT、jitter flip、HDR/曝光、16tap history与lock alpha没有改变。

三轮限定After仍取固定240帧/60完整GPU样本、同帧阶段和再求线性分位数（ms）：

| 轮次 | T1 Accumulate P50/P95 | tile Accumulate P50/P95 | tile Accumulate+RCAS P50/P95 | tile Temporal P50/P95 | tile Total P50/P95 |
|---|---:|---:|---:|---:|---:|
| full-1 | 2.083/2.849 | 1.949/2.946 | 2.167/3.227 | 5.485/7.559 | 32.291/44.313 |
| full-2 | 2.203/3.393 | 2.072/4.191 | 2.304/4.619 | 5.875/10.514 | 20.419/31.190 |
| full-3 | 2.095/4.154 | 2.101/5.214 | 2.333/5.742 | 5.993/13.754 | 20.625/40.084 |

【拒绝依据】前两轮P50下降、第三轮不降，所有Accumulate P95变差；未锁频且Native同步波动，不作因果比例。增加最小1080p同输入ABBA GPU执行对照，每次12 reference+12 candidate、4次untimed warmup，保留所有原始timestamp：两次generic/tile P50为1.77464/1.794624、1.792/1.814528ms；第二次mean也由1.792037增至1.855072ms。合成prepared inputs不替代Dungeon或硬件计数，但没有支持shared净盈利；**拒绝生产T2**，撤回generator/dual pipeline/domain inputs，生产仍为T1单Accumulate。同算法576→100逻辑loads未证明DRAM/时间收益。测试专用candidate snapshot仅用于复现拒绝，不是production fallback；扩大后的产品oracle保留，撤回后fresh build:test与产品GPU复验通过。

【条件/CPU/容量】fixed camera/1080p/high4×4/FSR/geometry1536MiB，coverage90.664–90.708%，resident1207/pinned381、evict/reload/failed0、streaming error空。热窗口89–91°C、SW thermal Active、稀疏graphics读数465–1350MHz；不从短oracle推断锁频收益。同步render CPU P50/P95为3.315/5.325、2.328/3.825、2.288/3.532ms，首轮更慢保留；CDP TaskDuration3417/1515/1409ms，墙钟7.104/6.066/6.072s，不是同步CPU全成本。transient texture仍242,115,280B，无容量节省；readback丢样与overflow/completeness原状态不清零。

【出口/未运行】按候选拒绝规则闭合T2实验；T1成立，**完整Native Temporal V2仍未完成**。T3未冻结/实施新算法及动态画质矩阵，不强切生产。用户本轮明确后续P3，可在同算法退守边界继续IBL单元；未运行完整旧baseline、锁频硬件计数、全Renderer loss恢复、T3画质验收。原失败/outlier保留。

## 5. P3：IBL完整publication优化

### 5.1 实施前冻结：同 mip 产品的 interior filtering

【源码事实/选择】physical为128²/8mips、diffuse32²、DFG64²，authored为合法square/NPOT与四种source format，先转换成linear rgba16float再过滤。原累计峰值检查为`allocatedBytes + raw + 2*mipChain + diffuse + DFG <= 256MiB`，含pending/outgoing/scratch；没有多余峰值额度的合法输入。padded atlas的N+2会超过原maxDimension边界且增加转换峰值，因此选择设计§5.1允许的同mip storage方案：interior完整2×2 footprint用hardware bilinear，seam/corner继续原wrap与f32权重。显式两个integer LOD sample后按原blend混合，避免NPOT时隐式trilinear改变支持域。DFG用同sampler linear/clamp；不改producer GGX128/diffuse256/DFG物理模型。

【容量/生命周期】每个texture size/mip/format、budget表达式与GPU texture live/peak完全不变；无需gutter、conversion、scratch或新增pass。owner各持有一个cold sampler，pending/active仍选同一组texture views；原commit/abort/gpuDone退休不改。材质sampler由三种wrap×(nearest1/linear1/linear8)最多9个、Product最多1个，加Sun1+IBL1最多12，低于WebGPU core最低16；sampled texture数不增加，原有限Sun continuation保留。sampler不可用新增纹理支持域缩水换取。

Cost Card：interior diffuse/spec两mip/DFG由4+8+4 logical loads变为1+2+1 filtered fetch，AO不变，coat由8→2；底层仍可读取同样texels，不宣称DRAM四倍下降。删除interior wrap整数除余/parity与手工权重/mix，新增每mip footprint判定/分支和一个filtering sampler binding；seam保留原四loads/权重，可能增加branch/liveness税。working set新增sampler对象但0B texture/buffer/history，无atomics/barriers/dispatch/frame submit，也无环境发布conversion税。best为大mip interior且pixel多；通常取决于seam比例、texture unit与compiler，未知；worst粗mip/小尺寸或divergence占主导更慢。0/50/100% interior比例的理想manual-load删除为0/6/12 calls每普通pixel（实际texels不减少）；break-even为省ALU/显式指令大于分支/filtering/寄存器代价。IBL D→E差分仅给定位上限，不能等同实际收益。

【验证冻结】原prefilter不变，冻结本地旧manual函数仅oracle使用。先比较axes/seams/corners/signedzero、texelcenter/half、1×1/NPOT/mip末级、roughness边界、HDR孤立亮点/plateau、DFG与coat。沿用Native数值合同`max(.001, abs(expected)*.002)`及既有DFG独立oracle，不因硬件filter误差放宽；不合格则拒绝候选。actual physical/authored producer→Native、abort/retry/outgoing fence/device epoch与budget边界随后检查。成本包括static Native与环境更新事务，后者本方案没有新增GPU发布工作；GPU串行，Before使用T1生产After，不使用已拒绝T2的After。

### 5.2 数值拒绝与精确候选定案（成本测量之前）

【实测事实】interior hardware候选在`3/bright-point`、roughness0失败：原f32为628.418518、硬件632，误差3.581482超过原相对.002合同。NPOT是当前合法输入，HDR亮点不能删，因此拒绝radiance硬件bilinear，不放宽容差。原失败`filtering-gpu.json`保留；一次stale build harness拒绝也保留并新鲜build重跑。

【替代/数学依据】Native radiance仍用原四load及相同f32权重顺序。oct_encode有效direction给uv∈[0,1]，bilinear整数neighbor只在[-1,N]；原general wrap可替换为负边+N/正边−N，单轴越界XOR决定反射。N=1原负边crossing计算不同但所有地址都是0，输出相同。删除所有这些neighbor的integer division/modulo，增加比较/select/subtract，没有新增分支或缓存；各NPOT mip、corner、粗mip使用同一helper。泛用source prefilter仍保留原general wrap，不能把有界证明套到任意坐标。

修订Cost Card：radiance samples/loads/bytes保持diffuse4+specular8（coat再8），只删除每neighbor的vector余数×2与division、abs/crossing；替换为有界比较/select/加减，random footprint和原weights/mip blend保持。DFG四load/手工mix→一linear fetch，底层texels未必减少；新增cold sampler/binding，texture/buffer/shared/history0B、pass/dispatch/atomic/barrier0、environment publication GPU税0。best为整数寻址主导，通常受纹理/BRDF限制，worst compiler原已简化或采样管线税抵消；净收益仍须测。0/50/100%地址ALU转化为时间收益不能由源码推导，整个IBL差分只能作上限。

初步GPU oracle15组10,950 queries覆盖1/3/7/32/128、smooth/2048亮点/plateau、seams/axis/NPOT/mips/roughness/HDR与DFG，通过原容差。随后对radiance收紧为逐bit等价（同数学应完全相同）；DFG继续独立积分与原容差验收。完整producer/consumer切换不采用已拒绝的radiance硬件路径，也不留per-frame诊断分支。

### 5.3 P3出口：精确 radiance 寻址采用，DFG独立过滤

【Previous Task Gate】T1复核成立；T2数值通过但两次ABBA不支持净收益，生产撤回并独立提交拒绝记录。P2算法T3仍延期，不能将此次P3称为完整Temporal V2。用户明确要求后续P3，按设计允许的同算法退守边界调整顺序，不同时改Temporal/VSM/资源预算。

【实际生产路径】`PhysicalSkyIblResources.sampler`与`GpuAuthoredEnvironment.sampler`在cold创建；原record→pending views→同frame convolution→Native→commit/abort→gpuDone退休全部保留。FrameProgram按真实authored/physical owner给group1 binding15，DFG7为float、radiance5/6仍unfilterable。所有lit dense/compact/product/reactive/fused profiles和coat使用同一有界radiance helper；unlit与有限Sun continuation不消费IBL/sampler。无第二renderer、每帧debug branch、atlas/new texture/new buffer/new pass/new submit。原cube/oct方向、GGX128/diffuse256、mips、roughness quadratic LOD、DFG Fc/totalvisibility、single scatter、AO/HDR/pre-exposure不改。

【完整支持域】原physical128²/8、authored合法square/NPOT、四种format、device limits及累计256MiB表达式原样保留，所有GPU texture descriptor/allocations及scratch/outgoing重叠原样；capacity新增0B。新增sampler计入shader资源footprint，生产material有限sampler上界10，加Sun与IBL为12≤core16；未提高能力要求。sampler无destroy API，physical随owner/device回收，authored复用原device-local sampler cache；没有新的退休产品。源prefilter general wrap仍由原owner保留，Native只调用有界地址helper，非永久新旧实现选择。

【正确性】fresh build:test、engine typecheck/build、Dungeon诊断build与20项受影响contracts通过。`ibl-filtering`最终15组42,705 queries，radiance三RGB共128,115 words逐bit一致；新增actual DFG producer的密集掠射/首texel/subtexel坐标，DFG沿用`max(.001, abs(expected)*.002)`，最大绝对误差约.000350。既有31项Schlick/Smith独立积分DFG oracle原断言通过。Native integration含normal/ORM/coat、motion/reactive/actualFSR chain与resize abort/retry通过；双device epoch销毁/重建通过。`ibl-publication`actual authored四format/NPOT、pre-submit abort/retry、same-source去重、scratch/outgoing fence及预算拒绝、actual physical完整LUT/sky/filter/DFG、probe25单位跨界与Sun更新通过，无私有生产submit。最初publication test使用浏览器assert shim不支持throws，修test捕获后重跑通过，原失败保留，不改生产断言或算法。

真实`native-authored-ibl-production`两轮通过，第二轮明确检查恢复后actual Native bindings5/6/7/15分别等于新authored owner views/sampler；真实Renderer lit winner含normal/coat，scene swap、resize、abort/retry、admission burst、controlled device loss/recover及destroy通过。此生产oraclelit部分检查有限/正HDR，精确过滤数学由上述独立冻结shader对照与DFG积分承担；不冒称完整动态IBL画质验收。

【测量口径】原件`.local/validation/p3-ibl-2026-10-11/`。Before为T1已保存After，非拒绝T2候选结果、未重新跑完整baseline。默认G生产Native、无需求统计atomics，performanceCapture max-throughput、原fixed camera、1920×1080/DPR1/scale1、VSM high4×4/radius.75、FSR ON、GTAO/Bloom OFF、geometry1536MiB。每轮严格240 CPU frames/60 GPU samples；Temporal为同帧Facts+FSR之和再求线性分位数，各pass分位数不相加（ms）：

| 窗口 | Native P50/P95 | Temporal P50/P95 | Total command span P50/P95 |
|---|---:|---:|---:|
| T1 Before full-1 | 9.414/13.650 | 5.692/7.728 | 34.240/38.903 |
| T1 Before full-2 | 10.049/16.614 | 6.172/9.156 | 21.792/33.831 |
| T1 Before full-3 | 9.691/25.075 | 5.944/10.295 | 20.977/54.362 |
| P3 After full-1 | 7.836/9.325 | 5.977/6.508 | 30.253/40.977 |
| P3 After full-2 | 8.228/20.819 | 6.165/15.059 | 19.364/48.853 |
| P3 After full-3 | 8.513/9.352 | 6.342/7.057 | 20.144/21.714 |

【判断】采用精确有界寻址+DFG过滤：三轮局部P50方向一致下降约1.18–1.82ms，新增常规税小、GPU产品容量不变、数值/生命周期通过。**这是本次热状态下观察差，不是锁频因果收益或稳定全帧改善保证**；没有拆分DFG/address各自贡献，不能把整个下降归给硬件DFG。第二轮Native/Temporal/Total P95均更差保留；Native mean 11.678→10.818ms但Total mean24.647→24.885ms，不能从Native P50推断整窗口平均必然盈利。GTX1650Ti/581.42，After窗口89–91°C、SW thermal Active、graphics675–1245MHz，Before300–1215MHz，稀疏读数无逐帧锁频。仍缺register/spill/occupancy/cache/DRAM及锁频ABBA；不宣称删掉的地址ALU完全变成收益。

【CPU/内存/覆盖】After同步render CPU P50/P95为2.795/4.775、2.367/3.562、2.350/3.715ms，Before2.420/4.100、2.363/4.117、2.230/3.381ms，不宣称CPU提速。CDP TaskDuration3504/1578/1611ms、墙钟7.091/6.084/6.078s，含其它CPU与overshoot。三轮API live2,432,355,229B、peak2,511,119,293–2,511,152,061B，transient textures242,115,280B，与T1容量一致；这些不是OS驻留/物理峰值证明。coverage90.664–90.708%、shadedPixels2,073,600、meshlet605、invalid keys0，resident1207/pinned381、evict/reload/failed0、streaming error空。counter末main/shadow readback丢slot各51保留，scheduler demandOverflow/malformed0，原completeness/eviction保护未改；VSM末demand324/allocated438、错误位0/dirty0仅描述末帧，不证明窗口全settled。Before/After截图人工检查无明显变化，numeric为主要证据。

【环境更新成本与限制】本方案没有gutter/conversion、额外texture/dispatch或改变prefilter循环，**源码上新增GPU publication work为0**；真实probe/Sun重烘焙事务与fence已运行，未取得锁频动态publication P50/P95/编辑频率break-even或独立cold编译成本数据。没有把原先就存在的sky预过滤突发当作已优化。未运行完整baseline、所有设备/driver支持域GPU实证、全部动态IBL quality矩阵与P7综合验收；全系统驻留/thermal调优未做。P3单元关闭后停止，不进入P4或新高级effect，P2-T3和60FPS目标仍未完成。

实现前先完成layout/support域证明：physical128²/8mip与authored1…device合法square/NPOT、四种当前sourceformat、当前累计256MiB与outgoing/scratch峰值。compactpaddedatlas优先，N+2超limit或峰值挤出旧合法input时不能静默下采样/拒绝；定案同mipstorage的interiorhardware+seam精确算法或拒绝候选。这里只做必要有限layout，不造通用textureframework。

然后一次闭合：`PhysicalSkyIblResources.record/commit/abort/destroy`与`GpuAuthoredEnvironment.record/onAborted/onFinished`→linear16floatfiltered产品/gutter/DFG→`PhysicalEnvironmentRuntime`existingencoder/publication→`nativeSurfaceBindingGroups`与全部litNativeprofiles/DFG/coat→accounting/scratch/gpuDone退休。sourceprefilter数学不变，resize本身不重烘焙；环境更新tax要在cameraprobe跨量化边界/Sun编辑时测，不只测永不更新的静态图。

oracle：octaxes/seams/corners/signedzero，texel/halfcenter，1×1/NPOT/mips末级，roughnessLOD边界与mipblend，DFG边缘/Fc-totalvisibility，coat/AO/linearHDR/pre-exposure。硬件filterrounding不等于bit-exact，既有容差不因性能放宽。realphysical/authorednative、abort/retry/generationatomicity/device-loss/destroy与limits不足profile都覆盖。

性能变量仅IBL采样representation；固定灯/材质/相机与VSM/Temporal。记录Native/IBL差分、环境publicationburst、CPU冷pipeline/steadyallocation、GPUlive/peak。若Native未净省或新capacity排除了合法输入，拒绝；不要同时改GGX samples、DFG模型或默认LOD。通过后独立提交与停止。

## 6. P4/P5/P6条件架构单元

### 6.1 P4出口：显式4GB应用预算与容量审计

【Previous Task Gate】从`941345ad`实际diff重读P3全部production consumers；radiance仍为精确四loads/f32权重，只有DFG硬件过滤，有界oct地址成立，无已拒绝hardware radiance生产分支。fresh build:test、20项contracts、真实`ibl-filtering`与`ibl-publication`复验通过，无需P3补交。P2仍是T1完成、T2拒绝、T3延期，不追认为完整Temporal V2。

【源码事实/完整路径】Dungeon `resource-budget.ts`→main/raw/cooked加载→现有`selectGeometryProductResidencyProfileV1`→`GeometryProductSlotPool`四个128MiB等大bank/2048slots→原GPU page directory/main+shadow消费者。唯一渲染容量变量为geometry1536→512MiB，metadata128MiB、page256KiB、所有纹理/效果/分辨率不改；device-limit协商先于创建，budget不足继续完整pressure/eviction机制，不丢demand或身份。应用显式`target-4gb`划分4096MiB设备目标与2048MiB API诊断envelope（512+128+1408）；这是配置与审计目标，**不是全Renderer自动预算分配器、全局强制限额或OS驻留保证**。未指定query使用默认；128…2048MiB override标custom，非法输入报错。raw已接线/typecheck，真实重场景本轮为cooked。

`VirtualGeometryResidency`在page发布时记录authored payload+directory+expanded attributes字节，resident→retiring保留至consumer fence，completeRetire/reload/destroy同步更新；不把累计uploadedBytes当当前payload。`GeometryProductMultiRuntime.evidence`按allocator free records计算metadata占用，pending/retiring尚未free仍记账。`GeometryProductGpuBudget.totalPeakBytes`记录bank+metadata同时峰值，不相加独立峰值。streaming evidence暴露已缓存source revision与main/shadow completeness/安全frame，采样不触发revision getter。未修改canonical demand decode、调度/IO或影子保护。

`dungeon-gpu-audit.mjs`仅诊断模式记录每个buffer/texture创建/销毁、live、同时peak与`ownersAtPeak`；补owner label使最终真实运行无unlabelled bucket，sum与总额一致。未知format失败，未destroy但WeakRef已收集容量单列。包括geometry/metadata/readback、TextureResidency、VSM、Facts/FSR、atmosphere、frame geometry、RenderTargets、transient pools、staging/在途重叠；**不包括canvas、pipeline/driver内部与OS驻留**。生产`GraphicsContext`账本仍partial，UI准确标名；不引入每帧生产拦截器。

Cost Card：删除1,073,741,824B bank nominal capacity与cold创建责任；不减少resident payload、shader loads/samples/ALU/atomics/barriers、dispatch/pass/submit。新增每published page一个numeric→payload计数的小CPU Map与evidence读取，metadata区间/feedback统计为观察路径；create/destroy拦截、owner peak、500ms运动snapshots仅diagnostic。无新GPU buffer/texture/history/copy。best为working set≤512MiB且OS容量压力实际降低；当前全部pages适配、容量节省确定，时间收益未知；worst超working set增加evict/reload/IO/upload/VSM full invalidation与P95。0/50/100%时间收益不能从1GiB容量差换算；break-even为减少的驻留/压力成本大于新增reload/publication税，缺硬件paging因果计数。growable/variable-page另验证migration overlap与原子publication。

【容量实测】Before使用保存的P3 After，不重跑旧baseline。原件`.local/validation/p4-budget-2026-10-11/`：fixed为`after/`、最终labels/feedback为`movement-wired/`、释放复验为`release-closed-retry/`。fixed近景/high4×4/FSR ON、1920×1080/DPR1/scale1、GTAO/Bloom OFF、max-throughput；各240 CPU frames/60完整GPU samples，严格`targetStart≤frameIndex<targetEnd`。

| 指标 | P3 Before | P4 After |
|---|---:|---:|
| banks / metadata | 1536 / 128MiB | 512 / 128MiB |
| explicit API live | 2,432,355,229B | 1,358,613,405B |
| 同时API peak（含重叠） | 2,511,119,293–2,511,152,061B | 1,437,410,237B |
| resident / pinned | 1207 / 381 | 1207 / 381 |
| occupied physical slots | 1224，306MiB | 1224，306MiB |
| 当前有效payload | 旧字段未记；无evict时upload28.97MiB | 30,377,856B，28.97MiB |
| resident内部空洞 / unused banks | 旧字段未记 | 290,486,400B / 216,006,656B（277.03 / 206MiB） |

最终labels/反馈运行live1,358,682,269B；与fixed的小额差来自运行中pool保留量，不是新配置。2GiB envelope同时峰值余量约677.18MiB。owner既有TextureResidency133.33MiB、VSM76.14MiB、Facts63.28MiB、FSR当前75.15MiB、Atmosphere16.16MiB、transient textures230.90MiB；FSR在peak有新旧重叠约150.29MiB，不能相加各owner独立peak。metadata仅361,084B record bytes（asset116208/root3228/hierarchy196032/group26272/page19312/format32，另header64/table4096），128MiB本轮刻意保留；后续协商有空间，本轮未重设比例/allocator。

【成本实测，ms】Native列为`native-surface`stage（含bins），Temporal为同帧两个temporal stages之和再求分位数；VSM列仅shadow stages，**不含融合Native的PCF**。各列分位数不能相加。

| 窗口 | Total P50/P95 | Native P50/P95 | Temporal P50/P95 | VSM stages P50/P95 | 同步render CPU P50/P95 |
|---|---:|---:|---:|---:|---:|
| P3 Before full-1 | 30.253/40.977 | 7.836/9.325 | 5.977/6.508 | 本表不重取 | 2.795/4.775 |
| P4 After full-1 | 31.213/50.112 | 7.892/15.133 | 5.838/8.875 | 16.556/27.799 | 2.580/4.191 |
| P3 Before full-2 | 19.364/48.853 | 8.228/20.819 | 6.165/15.059 | 本表不重取 | 2.367/3.562 |
| P4 After full-2 | 19.637/28.928 | 8.292/12.450 | 6.195/8.769 | 1.847/2.734 | 2.440/4.720 |
| P3 Before full-3 | 20.144/21.714 | 8.513/9.352 | 6.342/7.057 | 本表不重取 | 2.350/3.715 |
| P4 After full-3 | 19.788/41.914 | 8.555/17.513 | 6.147/13.218 | 1.879/3.747 | 2.215/3.549 |

首轮32/60 samples caster raster>2ms，后二轮均≤.021ms；`fullQuality`+60warmup不是settled，首轮不删。Total mean30.167/20.647/23.597ms，第三轮max93.908ms/P95退步保留。CDP TaskDuration3319/1685/1396ms、墙钟8.101/6.075/6.082s含overshoot/其它CPU，不能当同步render或与GPU相加。GTX1650Ti/581.42窗口88–91°C、稀疏读数SW thermal全部Active、graphics300–1350MHz，P3为89–91°C/675–1245MHz；未锁频，**不宣称GPU/CPU净提速或60FPS**。

各fixed窗口仅1个Windows进程采样：Chrome集合dedicated约1516.69–1524.69MiB、shared158.90MiB、working set约1729.89–1794.05MiB；P3对应dedicated2540.56–2548.71MiB、shared158.72–158.84MiB、working set约1720.81–1889.03MiB。API/Windows容量下降方向相符，稀疏/独立热状态不证明逐资源驻留、paging消失或RAM净省。

【运动/正确性】两次受控sinusoidal orbit（±.06rad，原近景，非camera cut）各480目标frames，最终wired33次500ms snapshots。frame123–250仍加载：resident704→1192/source101→228；265达到全部1207pages（Dungeon1188+playground19），pending/IO0，payload30,377,856B/source233，此后直到743不再变化，evict/reload/failed0。静态Product集合已全驻留，移动不产生新未resident页；只支持本场景，不泛化未来场景。coverage起90.673%、末90.404%，fixed90.688–90.703%，shaded2,073,600/meshlet605/invalid0，Before/After截图无明显变化。main/shadow末complete true、安全frame699；fixed droppedSlots累计11/32/44，wired运动末17/17，原incomplete shadow保护不改；packet overflow/malformed0、stream error空。运动开GPU counters、完整timing仅37samples，**不是无统计税性能窗口**。

加载期间source变化仍按`VsmGeneration.prepare`触发caster-publication invalidation，不归因容量thrash。新增generation读回最初缺COPY_SRC给出无效零值；修权限regex时一次误改MAP_READ staging而失败，原件保留。最终只匹配VSM owner且检查所有copy source权限，通过末header`[242,1,0,0,1,0,242,291]`。短release复验仍加载，reason0只描述末frame；未采逐帧reason直方图，不声称整个运动无其它VSM失效。settled source恒定/无evict-reload支持“本容量未新增geometry source churn”，P5动态因果另研究。

【生命周期/验证】审计发现release后8820B资源未显式销毁（mip参数8192、volumetric metadata4、manager当前camera624）；补`GraphicsContext→GPUTextureManager/MipmapGenerator`、`GPUVolumetrics`、`Renderer→GPUCameraStateManager`销毁，共享import去重，RenderTargets借用context不误销毁。最终真实Dungeon短counter/释放复验API bytes=0、unknownFormats=[]、undestroyedCollectedBytes=0、geometry/TextureResidency teardown均0；不证明Windows瞬间归零。新增owner mock覆盖共享/借用/清pending，真实`native-authored-ibl-production`复验含Renderer loss/recover/abort/resize/destroy通过。

engine build/typecheck、Dungeon typecheck/diagnostic build、fresh build:test通过；此前43项相关contracts/units、最终22项budget/payload/lifecycle/canonical replay/staging/owner测试通过。真实`geometry-budgeted-residency`将过期fixture迁移到当前meshletRecords/ShadowMeshletBounds allocation/command编码合同后通过，原main/shadow缺页、pressure/eviction/coarse coverage、abort/retry/loss/fenced retirement断言保留，原3次fixture失败不删。P3 gate GPU与最终Renderer恢复GPU通过。未运行完整旧baseline、raw重场景、更大/编辑场景驻留压力、锁频/逐资源OS residency、P5/P7；未实现全局budget enforcement、growable、variable-page、metadata收缩。本P4容量单元关闭后停止。

### 6.2 P5：完整 caster 损伤与稳定深度域

【源码事实】旧`VsmGeneration.prepare`将source/caster revision与scene classification revision同时作为projection全失效；每个几何上传/撤回可撤销所有页并重建深度。P4加载窗口高raster与source churn一致，但末帧header不能证明逐帧因果；本轮先补frame-local CPU reason/source/caster facts取得限定窗口关联，不重复完整baseline。

【实施前冻结、粒度闭合】VSM owner保存上一次成功GPU提交的完整instance facts及Product slot对应的完整u32 generation、asset reference/stamp。仅内容变化帧扫描全部authored instance（不取visible list），生成紧凑old/new light-space AABB损伤；affine支持shear/负缩放。几何upload/retire通过冷构造page→asset CSR保守损伤所有相关asset的完整实例bounds，不推断仅当前resident/可见meshlet，也不把整个Dungeon Product无条件损伤。共享page更新全部相关asset，重复upload/fence完成不重复推进stamp。未知MASK coverage/value/texture publication、view-dependent coverage保守损伤所有MASK caster；材料替换、active/cast flag及bounds/transform变化由快照比较覆盖。scene/runtime替换、device、Sun、clip extent与显式reset仍全失效。旧快照在同一frame command中更新，abort不执行，不建立CPU visible/work控制。

Depth归约继续使用全部caster。内容变化时若新padded范围仍被旧域包含则保持编码不动；越界时只扩不缩、GPU撤销所有缓存内容ready后重绘，保留世界格点/projection identity，不冒称可复用旧depth。content version由现有post-raster commit推进，与投影身份分开；dirty未请求页保持不可采样，后续请求按原allocation重绘。所有clip/mip含coarse以原caster pairing同样gutter作AABB交测试，无receiver/PCF/质量改变。容量不足/非法bounds损伤不能截断，GPU整内容失效并保留失败fact，原caster failure链仍拒绝无效绘制。

Cost Card：删除每次小内容变化的全页撤销、slot重新分配与无关页caster/raster；不删除receiver、16次PCF samples或全部caster源。变更帧读取176N B当前记录（原bounds已有）、新增192N B快照及source随机索引，写192N B快照、至多48N B damage；source CPU→GPU上传16P+4A B（P为slot header跨度，A为active asset数，scratch增长后可保留更大容量），原16ceil(N/64) B归约partial保留。新增AABB affine/identity比较ALU、一次damage atomic ticket/changed caster、每dirty slot一统计atomic；保留原64-lane归约barriers，slot交测试不新增workgroup barrier。新增一次仅变更帧slot-domain compute，已有两阶段bounds扩展，最坏O(residentSlots×changedCasters)，无新texture/samples/独立submit。GPU工作集192N+48N+16ceil(N/64)+16P+4A B及16B header/96+256B constants；CPU持久CSR为4(Q+1)+4R+4A B，Q为源page数，R为去重page/asset关联数，冷构造临时array/Set随后可GC；只有变化帧构造source header、uniform与bind groups。稳定帧无新增delta GPU dispatch，仅观察已有revision；直接GPU Scene提交也触发扫描，render内patch提交后版本可引起下一帧一次noop扫描，不隐藏这个税。best局部少量损伤；通常依asset bounds重叠与更新频率，未知MASK可能无空间收益；worst全域变化增加快照/交测试税；域扩大直接全内容dirty，不逐page循环damage。0/50/100%是可避免无关raster的敏感性变量，非预测；break-even为省下的allocation/pair/raster超过delta/depth/dirty税。旧raster实测突发只作局部上界。

来源仅architecture reference：Blender `aed2b5972fc25ca8448ceaf8d98957e0065deb2a`，GPL-2.0-or-later，`eevee_shadow.cc::sync_object/end_sync`与`eevee_shadow_tag_update.bsl.hh::tag_update_vert/frag/tag_propagate`的past/current bounds tagging。自主WGSL完整instance快照、Product stamps、slot交测试及稳定域扩展；不复制GPL源码，不移植resource id截位、mesh/bindless、私有submit或上游overflow漏shadow行为。

【P4 Gate】复读`6eb77e8d`实际diff、预算/生命周期生产链及已保存After；fresh build:test、20项预算/释放/canonical replay检查通过。512MiB Dungeon banks与128MiB metadata、payload/固定slot碎片、API同时峰值及释放数据与提交一致，没有发现需独立closure commit的缺项；这仍不是全局自适应allocator。

【实测因果窗口】原报告为总Before，本轮仅在旧失效逻辑上加4个CPU frame facts（reason/full/source/caster），固定近景1080p/DPR1/scale1/high4×4/FSR ON/GTAO Bloom OFF/performanceCapture，240 CPU frames、60 timestamp样本。31 source变化帧均reason32/full=1/caster=0，raster P50/P95 `15.715904/23.715616`ms；29 steady帧raster P50 `.008736`ms，所有raster>2ms均与source全失效同帧。Total `31.284576/45.561342`、Native `7.771872/10.632392`、Temporal `5.765968/7.325656`、VSM同帧先求和stage `16.436928/25.024109`ms。支持流送publication与全重绘的因果机制，不把末header当整窗。

【源码切换】`VirtualGeometryResidency` page→asset stamps/withdrawal→streaming source revision；`RendererCore`还消费GPU Scene bindings的完整提交revision，覆盖公开`patchInstances`及直接GPU Scene patch/release，普通render-world patch同帧由caster revision触发。`VsmGeneration`区分projection全失效与content变化；`VsmDepthBoundsPass/vsm_depth_bounds`输出192B snapshot、48B compact old/new damage和稳定depth，`vsm_caster_invalidation`每物理slot唯一writer保留allocation/identity、清ready置dirty；`FrameProgramLowering`将写后contentVersion交allocation，再由原shadow work/pair/native raster/commit/sampling消费。instanceCount变化强制重建快照/全内容dirty；capacity创建前检查，快照增长abort回滚、成功后旧buffer fenced retirement；无production dual path。

【After三轮】优化单元完成后一次限定组，每轮240 CPU/60 GPU samples；阶段数先同帧相加再统计，各pass分位不可相加。三轮均无GPU统计instrumentation：

| 窗口 | Total P50/P95 | Native P50/P95 | Temporal P50/P95 | VSM stages P50/P95 | 同步render CPU P50/P95 |
|---|---|---|---|---|---|
| full-1 | 19.143312/37.793941 | 7.950720/16.153998 | 5.845008/9.501184 | 1.796032/9.378509 | 2.5625/4.06325 |
| full-2 | 19.586736/28.629854 | 8.360480/12.238331 | 6.144640/8.763602 | 1.872240/3.303890 | 2.125/3.401 |
| full-3 | 19.679296/47.993739 | 8.415488/20.202883 | 6.179184/16.197562 | 1.878960/3.092069 | 2.2175/3.351 |

full-1有15/60 source变化帧，fullInvalidate=0，raster P50/P95 `6.432928/12.150419`、mean7.475533、worst22.296544ms；45 steady帧P50 `.01024`ms。变更帧bounds+publish+dirty P50 `.037088`ms（旧bounds+publish `.016288`ms）。full-2/3 source变化0、steady raster `.010368/.010624`ms，无delta dispatch。终点generation/projection均2（旧终点261）；最后变更batch header `[1,0,0,12]`仅说明该批1caster/invalid0/all-dirty0/dirty12slots，**不是末帧或整窗统计**。

热状态Before89–91°C、After88–91°C，thermal slowdown均Active，稀疏graphics分别375–1350/300–1290MHz；source变化样本31→15，加载进度/调度不同，不能把15.72→6.43ms称严格配对速度比例。P4后两轮Total本来约19.64/19.79ms，P5主要改善更新突发，不是稳态Native/Temporal优化。full-3最大Total134.017312/Native59.839776ms完整保留，尾帧和60FPS仍未解决。

CPU cause-window同步render `2.5975/4.091`ms；CDP TaskDuration为2.983226s/7.089s墙钟，After三轮2.265494/6.098、1.382558/6.064、1.336770/6.054s。窗口包括额外host/callback/UI/采样工作及超出240帧的等待；不等于同步render、也不是GC/分配配对profile，不能全部归因P5。GC allocation未独立采样，heap两端不能推出分配次数。

coverage三轮90.664/90.703/90.673%，model pixels独立计数、invalid0；末meshlet605，winner完整域2,073,600（coverage model+other读回，**没有独立保存shadedPixels counter，不能称为该计数实测**）。resident1207/pinned381、slots1224=320,864,256B、payload30,377,856B，无evict/reload/failed、packet overflow/malformed0、streaming error空；counter窗口main/shadow ring dropped slots各累计29，与packet demand overflow不同，原incomplete shadow保护保留。API live1,358,822,565B、同时peak1,437,619,397B；相对P4观测live差209,160B，包括842instance snapshot161,664、damage40,432、source3,260B及constants/池差额，不把整项差额都归因新buffer，更非Windows实驻显存。

【验证与限制】engine build/typecheck、Dungeon typecheck/diagnostic build、fresh build:test、最终28项CPU tests通过（包含独立/共享page→asset stamps、canonical replay、budget/withdrawal/late IO、generation事务、settings与release）。实际生产`vsm-local-invalidation` 5,184 assertions覆盖全部6clip/6mip/coarse、signed world、高位identity、source withdrawal、old/new、shear/负缩放、明确gutter-only邻居、MASK coverage/材质、depth expansion、abort/resize/capacity增长retry。R1八角独立depth、R2 allocation/commit压力、R3真实Geometry bounds/pairs/partition及overflow通过；R3本身不证明MASK raster，真实`native-authored-ibl-production`补直接公开patch→GPU快照验证，并覆盖真实Native/VSM/MASK、scene/abort/resize与受控device recovery，通过。原失败（未注册metric、WGSL保留字、fixture API误用、fresh-build mismatch与格式comma错误）均留原件并修因，不删outlier/不放宽断言。

三轮组先于最终直接GPU Scene revision补齐；补齐不改变Dungeon queued-patch路径和shader数学，仍另做最终源码短固定/运动/释放复验，下述记录只对各自build生效。没有跑完整旧baseline、锁频配对、大型编辑场景/长期source churn压力、真实driver fault、完整VSM R4或P6/T3。资源少量增长换掉全失效仍须未来动态场景复测，不能将单元出口提升为整个VSM验收。

【最终源码复验】补齐direct revision后`--near --audit --movement-audit --scenarios full-1,motion --frames 480 --gpu-sample-interval 4`串行运行，固定窗口保存479/480 CPU records（一个未保存，未补造）、100 full+20 coarse GPU samples；不能冒称120个full timing。100 full samples的Total `19.768032/42.708862`、Native `7.709568/17.667698`、Temporal `6.081200/10.710610`、VSM stages `1.881680/10.986427`ms，21 source变化样本、fullInvalidate0，source raster `6.469888/9.539552`ms；max Total126.97696ms保留。仍支持局部更新方向，无精确配对比例。

受控sinusoidal orbit（±.06rad、普通camera motion）窗口480 CPU records、36 full与444 coarse GPU records，开counter/500ms movement snapshots；仅正确性/动态接线，**不当无诊断税性能数据**。29 snapshots frame829→1440全部resident1207/source271，evict/reload/failed0，末main/shadow complete true、安全frame1396、各累计drop23；fullInvalidate0，最后GPU header仍为最后变更批。固定coverage90.657%，运动末90.242%、invalid0；motion meshlet601来自姿态改变，不要求与固定605相同。Before/After截图无明显变化，GPU/validation/timestamp错误0；shader/oracle数值证据优先。运动源已全驻留，不证明大型持续流送/编辑场景；caster motion由真实Renderer patch及GPU损伤oracle验证，不以camera运动替代caster变化。

最终释放API bytes0、unknownFormats[]、undestroyedCollectedBytes0，新snapshot/damage/source均显式destroy；不证明Windows立即归零。运动live1,358,891,429B、同时peak1,437,652,165B；采样88–91°C、390–1350MHz、software thermal Active。固定/运动CDP TaskDuration分别4.034242s/12.171s、2.913001s/11.241s墙钟，不作CPU优化归因。原件与failures在`.local/validation/p5-vsm-2026-10-11/`（reason-before-retry、after、after-reviewed-motion及各oracle/build日志），不提交原始采样。复验后补新增CPU语句显式braces及`coverageChanged`独立触发rebuild的owner合同（Renderer原路径已同时推进caster revision，所以不改变该测量场景）；没有改变GPU数学/工作域，提交前fresh build:test/CPU事务及受影响GPU oracle再次确认。

### 6.3 后续条件单元

growablebank单独定layout/copy/newpublication/oldfence退役/峰值，不能假设4bank地址自然可扩。variablepage推迟；容量导致质量/overflow/lifetime失败不得隐藏。

P5本地单元已关闭；更大可编辑场景、长期source churn/高重叠与真实driverfault的动态成本/压力仍属后续验收，不凭本场景末帧推广。未启动新VSM allocator/queue或算法。

**P6算法研究**：comparisonPCF必须先写box↔Gaussian/权重/反深度/gutter数学与quality合同，再做oracle/真实不同运动；未经接受不默认换核或taps。TemporalV2成功后才考虑upscale域算法；pmndrs是reference不是可直接拼入引擎的librarysubmit。persistentfree/evictqueue只在management实测占主导才设计，必须保留全identity/ABA/overflow/coarseprotection/retire，不按dispatch数自动启动。

## 7. 实际命令、验证与提交纪律

下列是按单元选择的命令模板，P1实际已运行项见§3.6；不代表后续单元已经验证。CPUtargeted由实际改动选择现有contract/unit文件，不要求每单元重跑全部Renderer。

```powershell
node tools/vibe.mjs context OEngine/src/shaders/native_surface.ts
npm --prefix OEngine run typecheck
npm --prefix OEngine run build:test
node tools/gpu-oracle.mjs sky-ibl-dfg --headed --json
node tools/gpu-oracle.mjs vsm-v4-r2 --headed --json
node tools/gpu-oracle.mjs vsm-v4-r3 --headed --json
node tools/gpu-oracle.mjs native-surface-integration --headed --json
```

按单元选择并串行运行，不把所有oracle同时启动。newshader/newproduct需要真实GPU wiring，测试编译旧stub失败先分类修fixture，不能放宽assertion或删除必需语义。Q0/K已接诊断selector与runner，publication oracle已注册；T3oracle仍未实现，必须注册真实selector再调用，不在计划伪造可运行命令。

受控After runner现有入口（完整单元完成后才使用）：

```powershell
node validation/tools/run-dungeon-performance.mjs --out .local/validation/performance-unit-after --frames 240 --scenarios full-1,full-2,full-3,counters --headed --geometryMiB 1536 --gpu-sample-interval 4
```

这是显式保留旧1536MiB容量的限定测量组；P4默认预算测量省略`--geometryMiB`，受控运动另用`--scenarios motion --movement-audit`。不是默认完整suite；固定近景须带`--near --audit`。原件目录每次唯一，失败不覆盖。runnerload/settled与thermal口径按§2补足；`--native-slice`支持A…G/B0/Q0/K，K和`--vsm-demand-diagnostics`仅用于统计窗口而非timing。若改capacity，单独P4实验明确参数，不能混入P1/P2“收益”。

实施提交前：architecture review→必要typecheck/build/freshbuild:test/targetednumeric+lifecycleGPU→限定DungeonAfter→`git diff`/`git status`/`git diff --check`；docs改动执行`node tools/docs-verify.mjs`。中文commit正文写动机、完整数据流、真实删除/新增工作与CostCard、Before/After/热状态/失败/未运行项；不提交.local/screenshot/profiling或无关改动。**一个完整单元一个连贯提交，提交后立即停止。**

## 8. 模块验收与当前文档交付边界

P7必须同时回答：GTX1650Ti4GB/1080p高质量/≥80%覆盖是否达到稳定GPUbudget；动态/压力P95、交互cadence与提交吞吐是否可接受；正确性/lifecycle/overflow与全owner峰值是否闭合。目标16.67ms是预算目标，不是通过几个oracle即可声明的事实。新效果没有无条件“空闲预算”，每个后续effect仍需独立CostCard。

未达到目标时保留真实分布/剩余gap，重新排名最多一个下个单元；不能恢复advanced-effects开发或改scale/taps包装性能成功。硬件计数/热状态/OSresidency缺项如实列出；其它GPU型号结果不转写为目标平台已通过。

当前出口：P0完成设计，P1完成Q-exact唯一生产切换；P2完成T1，T2实验拒绝生产采用，T3延期；P3完成精确radiance寻址/DFG过滤与§5.3的限定正确性/成本；P4完成§6.1显式Dungeon容量/审计单元，growable/variable-page/全局预算强制延期；P5完成§6.2局部内容失效，P6/P7未实施。本次提交后停止。T1稳定帧时改善未证实，P3/P5热状态/尾帧限制保留，P4只确认容量下降，不宣称完整Native Temporal V2、稳定60FPS或VSM R4验收。
