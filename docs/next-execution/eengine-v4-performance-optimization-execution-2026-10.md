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
    - tools/gpu-oracle/registry.mjs
---

# EEngine V4 性能优化执行计划

唯一设计见[性能设计](../next-design/eengine-v4-performance-optimization-2026-10.md)。本文件拥有单元状态与实施出口；workstream仅导航。**当前只完成源码/既有数据/来源研究与文档，未实现下列候选，未运行新GPU/CPU测试。** 不把规划写成实现事实，不自行同时启动多个单元。

## 1. 状态、实施入口与停止边界

| 单元 | 状态 | 完整出口 |
|---|---|---|
| P0 源码、已有证据与设计 | complete（文档出口） | `f495f04b`源码/报告、成本边界、来源与失败分析；不等于新代码gate通过 |
| P1 VSM Sampling/Projection V2 | not-started | query/PCF/full-key资格→选Q或S一个候选→producer/产品/全部consumer/生命周期原子切换→numeric与净成本验收；也允许有证据拒绝所有候选 |
| P2 Native Temporal V2 | not-started | 同算法执行删除→native-resolution算法设计/非生产验证→唯一policy owner原子切换；质量失败时只保留已证实的同算法成果 |
| P3 IBL hardware-friendly publication | not-started | 合法源尺寸/format/预算证明→physical+authored producer→Native binding/DFG/coat→退休与完整numeric/成本 |
| P4 4GB资源预算与容量策略 | not-started | 全owner账本/峰值→独立capacity配置→moving working-set与驻留验证；growable pool另按完整生命周期闭合 |
| P5 动态VSM局部失效 | conditional / not-started | 突发因果→old/new caster delta→稳定depth域/局部dirty→全部consumer与压力出口 |
| P6 PCF算法与后续upscaler/residency研究 | conditional / not-started | 只有前述数据支持且质量合同明确才制定实现；无自动扩展 |
| P7 性能模块验收 | not-started | 目标硬件1080p同质量/coverage、动态/压力/热状态、CPU与资源峰值，列出剩余gap与VSM R4未闭合项 |

**下一实施入口为P1，先补齐拆分所必需的最窄证据，再实现一个完整候选。** P1失败就停止并报告，用户继续后转P2；不临时换一堆PCF小技巧。P1成功亦立即停在P2入口，不自动进入Temporal。P3/P4可在单元边界按实际数据调整顺序；任何调整先重读源码/当前结果，不把本表当无限自动任务。

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

### 3.2 最小资格实验（建议，尚未运行）

| 假设 | 只变哪个变量 | 指标 / 支持 / 否定 |
|---|---|---|
| query是足够大的重复成本 | 新compile-time slice保留full material/Sun，执行同query并保活production所需的返回字段，不执行PCF；再与F/G对照 | Native/selected span、最小anchor的ALU/liveness变化单列；不为保活unused entry字段制造巨大anchor。query差很小且Qpublication估算更大则否定Q；差分不是可加pass成本 |
| PCF/live-state是主要惩罚 | 保持query与正常bias，单独计时真实16PCF局部shader与fused slice；不在正式生产换tap | 独立PCF不能代表fused增量；若分离仍很贵，不能用“少寄存器”承诺S。register/occupancy无计数则标待验证 |
| tile可共享完整query | instrumented统计从实际Native position/lightXY得到的完整selected clip/worldpage/mip/epochs，以及fine/coarse结果和有效lane数；不得以receiver的depth反投影keys替代 | 每组distinct key/result histogram、重复率、invalid/partial；word重复不能替代。高entropy否定local aggregation，不因此否定整个Q/S |
| raster突发与source/caster失效相关 | 不改算法，只增加诊断关联记录，正式timing关闭GPU统计 | per-frame reason/revisions/depth-domain/dirty/pairs/commit拒绝与raster同帧对应；没有对应关系则不能写已定位因果 |

以上共用§2固定view/功能/热条件。diag改变输出会影响下游Temporal，Native定位窗口与全帧性能窗口分开报告。保存每次失败、不以anchor改变后的Total GPU当正式After。

### 3.3 实现选择与Cutover

资格结果先写清query量级、full-key entropy、所需产品字节与峰值、HDR/normal支持域、新增pass/初始化/consumer绑定，以及Q/S分别有哪些工作可真实删除。按设计§3.3选择最有净收益依据的一项；硬件register/occupancy计数不可用时不能把P1无限卡在取数，也不能把原因推断写成硬件事实。没有可用候选则拒绝出口，不强行实现。

**Q资格**：证明fine-cell到coarse结果的所有f32边界；冻结原query oracle→完整u32identity→全写域16Bdescriptor→post-commit pageTable/contentVersion FrameGraph依赖→Native/debug/continuation全部读新product。管理页表有真实allocator/debugconsumer就保留；生产采样中被替代的query删除，不留Legacy/New fallback。异常/dirty/missing保持旧neutral与diagnostic原因，overflow未完成页不得标valid。

**S条件资格**：确认所有现有Sun BRDF在线性有限域的因式分离，保留`re_direct_physical`的non-finite contribution拒绝语义，bias coefficient由mapped normal求出、resolved mip的depth_per_texel由resolve算，定案最小actual product。native一次material求值发布baseRGB/unshadowedSun/精确receiver facts→screen resolve16boxPCF与Sun合成→finalHDR交所有Aerial/Temporal/radiometry/debug/presentconsumer。unshadowed溢出但原shadowed有限等case不能被“线性证明”排除；若要改为系数产品/延迟finiteguard，先更新Cost Card与oracle，不能偷换支持域。保守48B/pixel布局及40B紧凑layout先做能力与4GB峰值预算；32B或half压缩必须先有numeric证明，不凭容量压力删字段。无VSM/nonreceive/unlit/background完整写域，普通/Product/coat/reactive/MASK含义保持。

S写域必须从当前`SurfaceV4.encode`的全域copy/clear与稀疏winner writes迁移，明确背景copy/clear、每个receiver product初始化值、invalid/unlit/non-receiver标记和resolve分支；不能沿用Native早退后假设全域已写。最终valid/receive字段及读取winner/instance的成本入账，不能把40B数值载荷估算直接声明为闭合ABI。若初始化需新pass或额外copy，修改Cost Card，不隐去开销。

S如果只是把同16PCF移到别pass而新增大带宽，且无净收益依据，则拒绝，不因Native桶变小保留。所有候选最终仅一种生产execution scheme；reference shader/旧producer只在oracle冻结，不永久常规A/B。额外GPUproduct由VSM/Surface各自实际owner管理，Renderer不变成新资源操作系统。

### 3.4 Correctness、性能与出口

oracle覆盖：fine/coarse/outside/missing/stale/dirty、fullslot/generation/projectionEpoch/namespace、负世界坐标/f32页边界、window滚动、empty ready、allocation≠contentready、overflow/partition failure、gutter/slot clamp/zero depth/负reference/bias/taps。S另比material numeric、normal map/grazing、coat、unshadowedSun、HDR/pre-exposure/color conversion、reactive/motion、diagnostic_mode与背景。nativeposition与depth重建不得默认为逐值相同。

生命周期：prepare→encode→abort/retry→submitcommit→completionretire；sun/camera/scene/casterpublication、geometryeviction、resize、device-loss/destroy。newproduct全写或有严格versionclear，不读上一frame未完成内容；in-flight不能被复用销毁。context限额采样纹理/storage buffers/storage textures/samplers完整协商，旧resource-limited continuation需重新证明。

串行After按§2三轮；同时报告Native+Qpublication或Native+Sresolve+初始化+全部consumer同帧合计、Total GPU/尾帧、CPU与APIpeak。单pass下降不足以验收；温度/驻留不可比不算精确比例。净收益不成立→撤回productioncandidate、保留diagnostic与拒绝结果，P1可完成为“证伪出口”。候选numeric/支持域失败不能追认为修复；撤回后受影响的稳定生产正确性与接线检查通过，可记录为rejected出口。稳定生产仍有必需correctness/lifecycle失败时P1 incomplete，不进入P2。

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

## 5. P3：IBL完整publication优化

实现前先完成layout/support域证明：physical128²/8mip与authored1…device合法square/NPOT、四种当前sourceformat、当前累计256MiB与outgoing/scratch峰值。compactpaddedatlas优先，N+2超limit或峰值挤出旧合法input时不能静默下采样/拒绝；定案同mipstorage的interiorhardware+seam精确算法或拒绝候选。这里只做必要有限layout，不造通用textureframework。

然后一次闭合：`PhysicalSkyIblResources.record/commit/abort/destroy`与`GpuAuthoredEnvironment.record/onAborted/onFinished`→linear16floatfiltered产品/gutter/DFG→`PhysicalEnvironmentRuntime`existingencoder/publication→`nativeSurfaceBindingGroups`与全部litNativeprofiles/DFG/coat→accounting/scratch/gpuDone退休。sourceprefilter数学不变，resize本身不重烘焙；环境更新tax要在cameraprobe跨量化边界/Sun编辑时测，不只测永不更新的静态图。

oracle：octaxes/seams/corners/signedzero，texel/halfcenter，1×1/NPOT/mips末级，roughnessLOD边界与mipblend，DFG边缘/Fc-totalvisibility，coat/AO/linearHDR/pre-exposure。硬件filterrounding不等于bit-exact，既有容差不因性能放宽。realphysical/authorednative、abort/retry/generationatomicity/device-loss/destroy与limits不足profile都覆盖。

性能变量仅IBL采样representation；固定灯/材质/相机与VSM/Temporal。记录Native/IBL差分、环境publicationburst、CPU冷pipeline/steadyallocation、GPUlive/peak。若Native未净省或新capacity排除了合法输入，拒绝；不要同时改GGX samples、DFG模型或默认LOD。通过后独立提交与停止。

## 6. P4/P5/P6条件架构单元

**P4预算**：先全owneraccounting，确认geometrybanks/metadata/page-slot/texturearrays/VSM/history/transient/accountedexternal，区分effectivepayload与allocation。唯一变量为geometrynominalcapacity，先参考既有1536/512实验，不新Before全套；After保留fixedview并增加相同场景受控movement，记录working-set、pin、evict/reload/IO/upload、readbackdrops/completeness、VSMsourceinvalidations、P95/OSmemory。capacity导致质量/overflow/lifetime失败不得隐藏。growablebank单独定layout/copy/newpublication/oldfence退役/峰值，不能假设4bank地址自然可扩。variablepage推迟。

**P5动态VSM**：先关联高raster与publicationreason，只有因果支持才实现old/new完整boundsdelta与局部dirty。depthdomain稳定与contentepoch分开；全caster源包括离屏/非residentbounds。transform/shear/nonuniform/negative、MASKcoverage、remove/replace/castflag、geometryretire/lateupload、Sun/device/scene/resize/abort必须进入损伤/安全fullinvalidate。验证requested/dirty/ready/overflow、fine/coarse、allcasters与gutter一致。一个变量是失效范围，PCF/receiver/residency同时不动；静态和运动分开报告。不能只比末帧raster。

**P6算法研究**：comparisonPCF必须先写box↔Gaussian/权重/反深度/gutter数学与quality合同，再做oracle/真实不同运动；未经接受不默认换核或taps。TemporalV2成功后才考虑upscale域算法；pmndrs是reference不是可直接拼入引擎的librarysubmit。persistentfree/evictqueue只在management实测占主导才设计，必须保留全identity/ABA/overflow/coarseprotection/retire，不按dispatch数自动启动。

## 7. 实际命令、验证与提交纪律

下列是**未来实施命令**，本次文档任务不执行typecheck/build/GPUbenchmark。CPUtargeted由实际改动选择现有contract/unit文件，不要求每单元重跑全部Renderer。

```powershell
node tools/vibe.mjs context OEngine/src/shaders/native_surface.ts
npm --prefix OEngine run typecheck
npm --prefix OEngine run build:test
node tools/gpu-oracle.mjs sky-ibl-dfg --headed --json
node tools/gpu-oracle.mjs vsm-v4-r2 --headed --json
node tools/gpu-oracle.mjs vsm-v4-r3 --headed --json
node tools/gpu-oracle.mjs native-surface-integration --headed --json
```

按单元选择并串行运行，不把所有oracle同时启动。newshader/newproduct需要真实GPU wiring，测试编译旧stub失败先分类修fixture，不能放宽assertion或删除必需语义。新query-onlyselector/T3oracle尚未实现，必须注册真实selector再调用，不在计划伪造可运行命令。

受控After runner现有入口（完整单元完成后才使用）：

```powershell
node validation/tools/run-dungeon-performance.mjs --out .local/validation/performance-unit-after --frames 240 --scenarios full-1,full-2,full-3,counters --headed --geometryMiB 1536 --gpu-sample-interval 4
```

这是保留当前高质量/geometrycapacity的限定测量组，不是默认完整suite。原件目录每次唯一，失败不覆盖。runnerload/settled与thermal口径按§2补足；`--native-slice`仅支持当前A…G/B0，`--vsm-demand-diagnostics`仅用于统计窗口而非timing。若改capacity，单独P4实验明确参数，不能混入P1/P2“收益”。

实施提交前：architecture review→必要typecheck/build/freshbuild:test/targetednumeric+lifecycleGPU→限定DungeonAfter→`git diff`/`git status`/`git diff --check`；docs改动执行`node tools/docs-verify.mjs`。中文commit正文写动机、完整数据流、真实删除/新增工作与CostCard、Before/After/热状态/失败/未运行项；不提交.local/screenshot/profiling或无关改动。**一个完整单元一个连贯提交，提交后立即停止。**

## 8. 模块验收与当前文档交付边界

P7必须同时回答：GTX1650Ti4GB/1080p高质量/≥80%覆盖是否达到稳定GPUbudget；动态/压力P95、交互cadence与提交吞吐是否可接受；正确性/lifecycle/overflow与全owner峰值是否闭合。目标16.67ms是预算目标，不是通过几个oracle即可声明的事实。新效果没有无条件“空闲预算”，每个后续effect仍需独立CostCard。

未达到目标时保留真实分布/剩余gap，重新排名最多一个下个单元；不能恢复advanced-effects开发或改scale/taps包装性能成功。硬件计数/热状态/OSresidency缺项如实列出；其它GPU型号结果不转写为目标平台已通过。

当前文档交付：已审查源码/已有报告与固定上游reference，设计了VSM Q/S、Temporal V2、IBL与budget/局部失效的完整边界；所有新实现与建议实验未运行。仅文档/导航验证在本次完成后记录，不伪称生产性能已提高。
