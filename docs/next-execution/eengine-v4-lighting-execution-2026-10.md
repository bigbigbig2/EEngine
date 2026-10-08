---
id: eengine-v4-lighting-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-v4-lighting-2026-10.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/gpu/LightDatabase.ts
    - OEngine/src/gpu/GpuLocalLightWorkAbi.ts
    - OEngine/src/render/lighting/LocalLightWorkGenerator.ts
    - OEngine/src/shaders/local_light_work.ts
    - OEngine/src/shaders/native_local_lighting.ts
    - OEngine/src/shaders/lighting_brdf.ts
    - OEngine/tests/contract/local-light-work.test.mjs
    - OEngine/tests/oracle/local-light-work-gpu.mjs
    - OEngine/tests/oracle/local-light-native-gpu.mjs
    - OEngine/tests/oracle/native-surface-integration-gpu.mjs
    - OEngine/src/render/passes/LightClusterPass.ts
    - OEngine/src/shaders/light_cluster.ts
    - OEngine/src/shaders/lighting_direct.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/render/surface/SurfaceV4.ts
    - OEngine/src/render/program
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/pipeline/FrameProducts.ts
    - OEngine/src/render/vsm
    - OEngine/src/debug/GpuFrameCounters.ts
    - OEngine/tests/oracle/native-surface-acceptance-gpu.mjs
    - OEngine/tests/oracle/lighting-boundaries-gpu.mjs
    - OEngine/tests/oracle/lighting-inspection-gpu.mjs
    - OEngine/tests/contract/lighting-boundaries.test.mjs
    - OEngine/tests/oracle/native-surface-production-gpu.mjs
    - OEngine/tests/oracle/geometry-shadow-view-gpu.mjs
    - validation/cases/geometry-scale-acceptance
    - validation/cases/renderer-cpu-host
    - tools/gpu-oracle/registry.mjs
    - tools/gpu-oracle/page/json-safe.mjs
    - tools/tests/gpu-oracle-json-safe.test.mjs
    - tools/docs-verify.mjs
---

# M3 Lighting V4 执行计划

M3 的唯一设计依据是 [Lighting Design](../next-design/eengine-v4-lighting-2026-10.md)，全局不变量继续遵守 [V4 母稿](../next-design/eengine-v4-native-shading-2026-10.md)。本文件唯一维护 M3 详细状态；[workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml)只导航模块。M1/M2/CPU 结果保留在[原执行记录](./eengine-v4-native-shading-execution-2026-10.md)，不复制或重开。

## 1. 当前状态与停止点

2026-10-08，`git fetch origin` 后 HEAD/origin/master=`ae140163886b71bf9a153033ba2e1460dc612ab9`，起始工作区干净。M3 source audit、两份模块authority、pinned source map与执行边界完成；**M3 production implementation 未开始，M3未验收**。详细源码事实、成本估算、方案选择与ABI均在Design，不把历史计时冒称本轮baseline。

| 阶段 | 状态 | 单元与退出结果 |
| --- | --- | --- |
| L3.0 Baseline & Lighting Contract | **closed** | 30 cases/3,600帧baseline、必要数值修复与8个GPU入口通过；见§8 |
| L3.1 Complete Local Light Work Construction | **closed** | 非生产generator/product/native consumer、材质/provider/lifecycle与同数学成本闭包完成；production仍旧Lighting，见§9 |
| L3.2 Atomic Lighting Cutover & Purge | **next / not-started** | 同单元切所有production consumers并立即删除旧管理链 |
| L3.3 Production Lighting Acceptance | not-started | 同条件完整正确性/生命周期/成本；关闭M3后STOP |

设计提交 `811e7f1e` 后用户授权开始 L3.0；本轮在该单元闭合后 STOP，不开始 L3.1。原设计轮没有 production implementation 或 GPU 性能声明。

## 2. 实施纪律

分阶段开发，不分阶段迁移生产。L3.0/L3.1生产仍100%旧Lighting owner；L3.2稳定出口100%新LocalLightWork，Global Sun/Directionals/VSM/IBL/AO保持真实owner。NONE/DIRECT/SPARSE是同一新subsystem内有限执行模式，不是old/new runtime flag。不能借旧filtered lists/CAS/private256实现新链，不能把新list喂旧cluster owner。

每阶段开工重新fetch/status/HEAD/build identity/context，读直接consumer与近目录AGENTS；本设计已完成大的架构/来源研究，后续不另造roadmap/workstream/authority。改复杂bounds/scan/cull须回到pinned来源的相应完整hot path，简单glue直接实现。存活数学/质量/曝光/lifetime不能因表示退休删断言。遵守原[失败分类合同](./eengine-v4-native-shading-execution-2026-10.md#validation-failure-contract)：保留失败，区分production、lifecycle、runner、fixture、environment、GPU numeric、performance、unrelated。

开发期间按需typecheck/shader compile/targeted CPU或GPU oracle；完整单元连通后architecture review，再集中build/test/必需真实GPU。GPU串行；不每helper跑大型场景。L3.2内部允许compile failure/暂时无renderer，不为常绿保adapter、old ABI、fallback renderer。正确性DIRECT fallback只能调用新完整admitted IDs与同数学，不能偷偷切旧owner。

## 3. L3.0 — Baseline & Lighting Contract

### 3.1 开工入口与责任

优先现有 `node tools/vibe.mjs context OEngine/src/render/passes/LightClusterPass.ts`、LightDatabase/SurfaceV4/FrameProgramLowering context。阅读Design审查表和当前源变化，核对publication、HZB、Sun/VSM flags、consumer binding limits，不再做一次泛Lighting架构研究。

现有入口：

- `node tools/gpu-oracle.mjs native-surface-acceptance`：实际Renderer 1080p、4/8/32 Point、normal/ORM/coat/custom/Unlit、多Programs；当前性能输入来自它，但原全矩阵不是每patch门禁。
- `node tools/gpu-oracle.mjs native-surface-production`：真实publication/update/abort/retry/resident/Scene生命周期；`geometry-shadow-view`验证真实directional/VSM接线，不重开Geometry。
- 现有validation runner和large authored入口可复用；**现有大场景few-local-lights只证明低灯基线**，压力灯在同Scene/production入口显式添加，不另建benchmark系统。

本阶段一次集中采当前旧路径baseline。最小稳定窗口30 warmup+至少120 timestamp有效提交帧，CPU同步render和async GPU等待分开，低灯与多灯组交替避免热状态偏差。保存原raw samples、source/build哈希、Chrome/adapter/driver、feature/profile、resolution/scale、camera、light参数/distribution/coverage与timestamp截断标记。不必重跑与Lighting无关的全browser matrix。

### 3.2 具体交付

1. 复用oracle的真实Point生产链，补必要Spot/mixed/local radius分布glue。固定1080p/scale1/材质纹理/Geometry/曝光/VSM/AO/FSR；0/1/4/8/16/32小灯矩阵，64/128/256/1024按生产灯数据进一步测local sparse/high overlap，capacity边界以独立oracle完成。不能把全屏灯缩成小范围然后宣称同条件优化。
2. 记录visible/candidate/active、C/Ca/Q/E或源码可推导估计，assign tests、overflow、每pass/Local total/Surface/frame GPU P50/P95/max/count，CPU encode/DB更新/diagnostics，reserved/logical/live/in-flight/retiring peak。Ca/Q/E现生产无counter时标UNKNOWN/ESTIMATE，不能读现有零字段当事实。
3. 独立CPU light数学和极小GPU边界oracle：finite distance+radius、distance=0、near crossing、巨大Spot distance、equal penumbra edges、灯心、32px边界、log slice/near/far/jitter、offscreen源影响visible Surface、alpha/background/normal/coat。原cluster列表只能作counterfactual，不是正确性oracle。原始失败保留；证明必要数值根因后在其真实owner最小修复并rerun，禁止改质量/容差。
4. 核定 shadow capability：Physical Sun+现有directional VSM supported；Point/Spot及独立Directional shadow未实现，已发布有效flag却无provider的request必须显式unsupported。casts_shadow默认true/shadow_id=-1不能误判为实际shadow publication。发现真实consumer要求新能力先记录scope缺口，不顺手建设local VSM。
5. 冻结Design §5 TS/WGSL ABI、6MiB initial profile/峰值、16,380 admission、GPU overflow DIRECT与No-current-frame-readback合同；核对真实Surface全部stage storage/sampled limits。L3.0可留极小非生产reference probe校准DIRECT incident test与occupancy/scan floor，不创建第二Renderer或生产mode。
6. Cost Card计算理想/expected/worst、0/50/100%收益、DIRECT非零threshold的校准输入。L3.1两种新模式同数学复核以后才启用threshold；没有可信crossover默认0，不机械选16。

### 3.3 退出条件

baseline真实输入/身份/原始artifact完整，数字明确实测或估算；支持域/数值语义有独立预期与原缺陷分类；同一推荐架构的ideal case有盈利依据、capacity/fallback/limits冻结。历史30ms根因仍可INFERENCE，不要求hardware counter才能构建；不能把未测low-light threshold写为通过。集中CPU/GPU必要合同通过，未修必需numeric/lifecycle失败保持L3.0未完成。

## 4. L3.1 — Complete Local Light Work Construction

本阶段只能非生产构建，RendererCore/FrameProgramLowering继续旧Lighting。包只表示开发顺序，不另建状态文件：

| package | 完整交付 |
| --- | --- |
| ABI / publication | 新LocalLightWork统一TS/WGSL layout、128Bheader、typed IDs、context/capacity；保持LightDatabase/Scene publication ownership |
| Bounds / task scheduling | finite/unbounded/offscreen/near-crossing保守bounds、64-region任务prefix、portable多层scan/2D indirect、saturating预算 |
| Occupancy / compact lists | 最终winner/depth mask→count→prefix→scatter→finalize；distributed atomics，无private256/globalCAS；forced溢出完整DIRECT |
| Native consumer / providers | NONE/DIRECT/SPARSE→同direct incident/BRDF；Global Sun/VSM/IBL/AO/HDR/continuation/Unlit与真实资源limits；consumer不能管理LightWork |
| Lifecycle / isolated integration | 初始化完整域、绑定identity、abort/retry、resize/rebind/last-use fence、release/loss取消readback；集中same-workload成本 |

构建路径为 `render/lighting/LocalLightWorkGenerator.ts`、`gpu/GpuLocalLightWorkAbi.ts`、`shaders/local_light_work.ts`，独立consumer为 `shaders/native_local_lighting.ts`。用既有GPU oracle harness隔离generator→真实native consumer，不预填成功列表/HDR。复用LightDatabase、Geometry/Material providers和math，不import旧cluster owner。纯BRDF提取到 `lighting_brdf.ts`，不靠字符串marker从legacy fullscreen runtime保留旧产品；实施结果见§9。

必须验证count/scatter使用同predicate、all-admitted segment始终完整、unbounded/finite互斥、zero/multiple同类型灯不重复或丢失；source slot24bit超界拒绝，scan重复prefix和多层边界/dispatch limits完整。Finalize只可从SPARSE降级DIRECT，所有WG atomic OR flags，不允许其他WG恢复SPARSE覆盖失败；提交后Surface只读immutable final版本。

集中验证一次：engine typecheck/build、新鲜build:test，ABI/CPU independent oracle、shader compilation，真实GPU0/1/4/8/32/mixed、empty/one/full/forced index overflow/region budget/count mismatch/stale输入；HDR独立点样本+完整finite域/coverage。匹配新DIRECT/SPARSE交替计量Surface+generator总成本，校准threshold或按否证合同保留0/禁用、核验6MiB/18MiB峰值与最坏fallback；无净收益机制删除或禁用，不加cache/history。

退出必须是**production-equivalent functional closure**：全部现行nativePrograms/多Bindings/normal-ORM/coat/Unlit/custom、alpha winner、Sun/VSM/IBL/AO/preExposure、Temporal所需输出与publication更新成立；不是“只写完一个scan”“只支持4Point”即可cutover。直接shadow能力限制明确且被测试。production仍只有旧owner。

## 5. L3.2 — Atomic Lighting Cutover & Immediate Purge

连续完成以下责任，然后集中验证：

1. Renderer `_lightCluster`/lazy composition替换为新generator；device init/preflight/recovery/destroy/profile/resources闭合。保持Scene-owned LightDatabase，不能让Surface释放它。
2. FrameProgram stage/product/input contracts、request/cache topology、FrameProducts、SceneFrameBindings与Lowering全部原子接新产品。以raw winner/depth为occupancy输入，移除仅Lighting强制buildHzb需求，Geometry HZB继续存在；每帧revision/view参数从late bindings取得，不捕获旧scene/light snapshot。
3. Surface的primary/physical-sun continuation、neutral entries、material pipeline generation、group1 bindings和所有可达direct consumers同步迁新ABI。没有每材质实例额外Lighting PSO，无old/new shader selector；只保同subsystem有限modes。
4. 迁移diagnostics/timing/counters：Local total分bounds/occupancy/count/scan/scatter；Surface fused direct没有独立timestamp时UNKNOWN，不能双加；VSM/AO/IBL/CPU独立。计数schema旧indices不静默复用，schema变更更新consumer，重型统计仍sampled。
5. **立即 dependency review/purge**：LightClusterPass owner、light_cluster旧producer kernels、旧metadata/data allocator/CAS/private arrays/prefix payload copy、old graph nodes/imports/neutral布局/exports/settings/diagnostics、旧表示tests/contracts。对 `lighting_direct.ts` 拆纯math与新consumer；真实numeric reference保留。packed_transparent_oit等无productioncaller的wrapper和exports核实全库consumer后删除/迁移，不用透明未来需求保住旧runtime，也不擅自删实际公开能力。

Purge出口是**不可达且已删除**，不只addToGraph不调用：搜imports/exports、owner construction、prepare/allocate/encode/commit/abort/invalidate/destroy、FrameGraph资源/PSO/counter/settings/tests/contracts，确认没有旧architecture残留或TODO remove later。旧symbols在history记录可保；数学helper/LightDatabase/shadow table按真实consumer保留，不按名称机械删。

最后统一typecheck/build/fresh build:test/针对FrameProgram、lighting、native Surface/lifetime的CPU测试；真实 `native-surface-production`、支持profile shader oracle、`geometry-shadow-view`、新LightWork oracle。验证一个production submit、stable frame cache hit、mode/Scene/count边界、abort→retry、encoded abort、resize/camera cut、release与受控loss/recovery。缺项保持L3.2 incomplete，不先进入L3.3。

## 6. L3.3 — Production Lighting Acceptance

旧owner删除且L3.2退出后再验收。复用现有production Renderer和oracle/validation infrastructure，必要时新增**一个**轻量Lighting case/workload登记，不建设新的benchmark framework；诊断artifact不能冒充正式claim晋升。

### 6.1 Correctness / workload

| 类别 | 必需覆盖 |
| --- | --- |
| Local lights | 0/1/4/8/16/32，64/128/256/1024；Point/Spot/mixed、局部小灯/大灯/high overlap、finite/unbounded、offscreen源照visible、near-plane/camera inside范围、硬/软cone边缘 |
| Winner/material | 1080p scale1、high/low coverage、normal/ORM/coat/custom/Unlit、多Program/BindingSet、alpha空洞/背景、真实材质纹理及independent HDR reference |
| Global/providers | 无local但有Sun/多authored Directional、VSM有效遮挡/缺页/dirty→commit/content version、IBL非零、AO质量不变；unsupported local/multi-directional shadow明确拒绝 |
| Dynamic/lifecycle | transform/color/intensity/radius/distance/angle更新、add/remove/reorder、stable frame、Scene swap、mode threshold/capacity tier、motion/cut/resize、publication atomicity、encoded abort→retry、device loss/replay、fenced teardown归零 |
| Capacity | admitted边界与拒绝、task/index forced overflow、count/scatter mismatch/stale epoch、2D dispatch、zero/padding、多层scan；overflow完整fallback不能静默少灯 |

大场景使用当前本地400多MB authored large asset、保持现有66Products/1920primitives/约4.87M source triangles/完整catalog与纹理材质/所有shards，main+shadow+HDR+Temporal真实链；显式加预定Point/Spot分布并记录身份，和baseline同配置。此处是Lighting场景覆盖，不重开M2。Zorah/actual100M源不可用记not-run，不伪造、不要求这台4GB设备硬上100M。100k position-only Unlit Geometry stress不能代表Lighting性能。

### 6.2 成本与报告

同adapter/browser/driver/thermal条件、source/build/camera/quality/light配置、30预热+120有效提交帧，交替轮次；保存raw samples/每pass分布、total逐帧相加后再P50/P95/max/count。受GPU backpressure延期tick不能算零CPU样本；计时外GPU fence/readback/inspection/JSON单列。Normal与full instrumentation只在必要代表case做差分，不能重开CPU优化。

必需记录：

- Local work total及bounds/task-scan/occupancy/count/cluster-scan/scatter/finalize、0-light与低灯DIRECT成本，C/Ca/Na/Q/E/list长度/actualmode/overflow率、GPU dispatch/PSO。
- Native Surface、Global/VSM/AO/IBL producer、Geometry、FSR、frame GPU分列；fused BRDF/local direct不能独立timestamp则UNKNOWN或明确isolated同数学差分，不能凭减法断言硬件counter。
- CPU `renderer.render`、LightDatabase publication、generator encode、diagnostic observation；原CPU report STILL BOTTLENECK保持OPEN，不借此次GPU设计宣称解决。
- DB/products/scratch/global providers分别的logical/reserved/live/in-flight/retiring/resize peak，release后真实fence完成归零；driver隐藏量UNKNOWN。
- 对旧baseline的same-workload producer+Surface+frame P50/P95；DIRECT/SPARSE internal Cost Card和crossover、high overlap最坏fallback。不能用少灯/少纹理/缩尺寸/弱VSM/AO换提速。

接受标准：完整正确性/coverage/HDR/lifecycle/limits/无unexpectedGPU/browser errors；normal热点下LightWork管理成本显著下降且combined useful work/帧时无不可解释回退，zero/low lights不付巨大grid/private-array税；高重叠性能边界明确、有完整输出且无经常性隐形overflow。数字目标不是放宽正确性的阈值；核心收益未成立或必需runner结果缺失，M3保持未完成。极端admitted-capacity满屏性能可记录OPEN，不能冒称60fps/任意灯数可扩展。

browser case必须有result/events/screenshot、source/build/workload identity、freshness/errors/complete/dispose gates。页面“passed”但runner中断不算通过。真实failure原件保存后分类最小修复→targeted/oracle→最终完整affected case rerun，不增加buffer到无限、不恢复旧Renderer。

### 6.3 关闭与 STOP

全部必需项完成后在本文件写L3.3 closed/M3 closed、source/build/workload/artifact、最终correctness/lifecycle/memory/P50/P95、baseline对比与未运行项；currentSlice只写module complete。跨GPU/browser、hardware DRAM/register/spill counters、local-shadow新能力、CPU host剩余瓶颈、VT/GI/ReSTIR分别OPEN，不伪装完成。

**关闭M3即STOP。** 不自动进入VT、VSM重构、GI/ReSTIR、Temporal或下一轮CPU工作。下一模块由真实瓶颈和用户授权重新决定。

## 7. 本轮设计交付记录

源码审查覆盖Scene publication/LightDatabase→current cluster→native Surface/global sun→directional VSM、IBL/AO/HDR，以及FrameProgram/FrameGraph ownership、LightDatabase符号消费者和diagnostics；成熟来源仅reference，见[Source Map](../porting/next-renderer.md#m3-lighting-source-map)。采取KEEP基础设施、局部owner重写、非生产闭包后原子切换，未新增production实现。

本轮轻量验证：`node tools/docs-verify.mjs` **0 findings / 66 既有 historical warnings**；documentation/validation tests **18/18通过**；`node tools/vibe.mjs doctor`、`registry --check`、LightCluster/SurfaceV4/VsmResources context到唯一M3 design/execution的路由、`git diff --check`通过。registry字节未变，没有为设计创建新case或改production路径。

engine build、fresh build:test、Node engine全套、GPU oracle、browser/performance **本轮未运行**，原因是只修改设计/执行/导航，新的baseline是L3.0责任。不存在本轮GPU通过或M3 implementation完成声明。

## 8. L3.0 Baseline 实施记录

开工重新 fetch 后 HEAD/origin/master=`811e7f1ef33d4bad270561cf53f7b03dbfc87bd9`，工作区干净。L3.0 用户授权后的代码尚未切换生产 Lighting：Renderer/FrameProgram 继续唯一旧 LightCluster，未创建 LocalLightWorkGenerator 或新的 production mode。

### 8.1 原始失败与最小修复

- `.local/l3-0-boundaries-original.json`、`l3-0-boundaries-original-cull.json` 保留原 source/build identity、实际 GPU 值与独立预期：硬 cone 等边缘返回0而预期1；Point/Spot 灯心 direction/radius 非有限；Point/Spot radius 外壳与 non-positive cutoff 的真实 cull helper 返回不相交，却有非零支持域。归类为 **production numeric/support-domain bug**，不是新 architecture benchmark。
- LightDatabase incident 保明确有限灯心极限，等 cone edges 用显式 step。旧 cull 使用 outward f32 `distance+radius`，unbounded 保守通过；巨大合法 Spot cutoff 不进入不可靠的平方/cone/HZB 投影，near-plane 非有限投影保守通过。没有减少灯数/材质/纹理、没有改 shade quality/BRDF/容差，旧工作组织不变。
- LightDatabase publication 对已指定有效 shadow ID 的 authored Point/Spot/Directional，在 revision/table mutation 前明确报 unsupported；默认 casts_shadow=true/ID=-1 仍为合法 unshadowed 光源。当前 source 全库没有其他给 authored ID 赋有效值的 producer，Physical Sun 的真实 VSM 保留。
- 初次基线跨帧 subtract-zero 在零灯时差0.00305（原件 `l3-0-baseline-original.json`）；属于 **oracle 的帧间 provider/jitter counterfactual 不成立**。改成只在 untimed inspection 中运行实际 native Surface shader 的同帧 zero-local counterfactual：同一 winner、camera、material、Sun/VSM/IBL/AO，仅 local 列表为空。CPU incident/BRDF reference 仍独立，预算仍为 `.002+abs(reference)*.003`，不把旧 cluster 列表当真值。reference 不接管 Renderer/FrameProgram、不进入稳定窗口，不是第二 production Renderer。
- 另外保存 `original-paired` / `original-valid-harness` 的 reactive/cache 接线错误与 `baseline-old` 的 Node3D API 错误，均为 **新增 oracle glue bug**。最终通过结果不能把这些原失败删除或追认通过。
- 报告器原8层上限把 `cases/records/raw/segments` 的逐帧对象截成 `[depth-limit]`：`baseline-original-ready` / `baseline-final` 虽status=passed，**不满足原始计时完整性出口**。最小 runner 修复为独立可测的16层有界projection，保cycle/array/typed-array保护并纳入host identity；最终完整matrix必须重跑，不能用旧摘要追认raw。`low-coverage-final` 的跨灯精确coverage比较落在不同jitter相位，归类oracle问题；只在计时窗口之外按真实Temporal owner的period对齐检查帧，保120帧正常jitter与原精确断言，最终记录phase。

### 8.2 计量合同与冻结边界

入口复用既有 GPU-oracle CLI、M1 native acceptance fixture、真实 Renderer/Profiler：`lighting-baseline`、`lighting-low-coverage`、`lighting-support`、`lighting-boundaries`。不是新 benchmark framework。每个 performance case 30 warmup+120有效 timestamp提交帧，原始 segments（含 ticks）、CPU/counters/graph、完整灯参数、provider evidence、memory、source/build/Chrome/adapter identity 保存；CPU render 截止同步调用返回，GPU fence/inspection/JSON在计时外。low/high组交替，但不宣称固定温度/clock。

主 matrix 沿用64实例/64材质、M1 authored256px normal/ORM完整mips、1080p/scale1、Sun/VSM/IBL/XeGTAO high/Temporal/FSR的既有 production 场景；Point 0/1/4/8/16/32，Point/Spot overlap64/128/256/1024，Spot1/8/32，mixed sparse64/128/256/1024、overlap4/16，以及mixed coat/custom8。不是400MB large authored asset；后者完整 Lighting acceptance 仍在 L3.3。low coverage 只把同一Scene的camera z6改为12，保全部64实例/材质/纹理/分辨率/quality，不作为降低主 matrix 的替代。

真实旧 cluster header/metadata通过 **untimed read-only compute** 观察，取 active、written/attempted indices、capacity、global overflow、fallback/nonempty clusters。现 FrameProgram **没有把 counters 传给 LightClusterPass**，FX-02未接入；`gpuCounters` 中的零 cluster字段不是事实。Na（HZB前 candidates）、Ca（实际occupied depth froxels）、Q、真实 fallback 被省略的 E 标 **UNKNOWN/ESTIMATE**；`nonemptyLightClusters` 不冒称 occupied Surface Ca。

profile冻结：Surface全shader storage≤16、sampled≤16，保finite Sun continuation，不增加 texture binding；new ABI沿Design §5，128B header/typed low24 slot+high8 type/8B ranges，Point+Spot admission16380、Directional32。I=1048576、6MiB/frame、最多2 in-flight+1 replacement=18MiB预算；GPU task预算≤8I，region/index overflow完整DIRECT，invalid/mismatch必须验收失败，不静默丢灯、不同帧readback控制。非零 DIRECT threshold **0/禁用**；L3.1新DIRECT/SPARSE同数学总成本测定后才开启。

旧 descriptor reserved=13,611,792B（12.98MiB），不是全写bytes；主 matrix `memoryEvidence` 包含 diagnostic reference 的tracked scratch，原件同时记 `diagnosticReferenceBytes`，不能把它算新 production allocation。logical written由实际header得出，pool live/cached/pending/retiring按原件分列；LightDatabase page/全renderer/providers另账。driver-hidden footprint及旧Lighting独立in-flight/resize peak **UNKNOWN**，不以 pooled总数强行分摊。

### 8.3 最终验证与结果

**L3.0 = closed；L3.1 = next，未开始。** 新LocalLightWork尚未实现，生产仍唯一旧LightCluster owner；本轮只修复独立oracle证明的数值/支持域与unsupported shadow publication问题。

身份：Git起点 `811e7f1ef33d4bad270561cf53f7b03dbfc87bd9` + 本轮源码修改，engine source content SHA256=`926da308f6ffe9422a8dd00f957fe4f0be75ac213b9f6e8eeda26af1c6c216c8`，fresh build:test output SHA256=`b0fdec05eac215a484a0dcdd94eda6a6c97e306aa039cec42c4f800382f500af`。baseline/low/support共用oracle SHA256=`2b4daa2b58ce35bcd7d28524eb28ad9d5c5f3cf1d695c5410d39b26042dca34d`，host identity=`c1a9af5e5c5e`。artifact各自也保存入口hash、manifest、加载路径及browser信息，不能把起点Git SHA当作修复后content identity。

实际硬件NVIDIA GTX1650Ti/Turing/4GB，driver581.42，Chrome154.0.8037.98，1080p/renderScale1/full timing。运行中采样约90–91°C，graphics clock观察到300/450/1350MHz，memory6000MHz；`.local/l3-0-thermal-complete-running.csv`保原件。**热状态没有受控，不能用原始→修复后数字宣称提速**；P95长尾的具体硬件原因UNKNOWN，spill/CAS contention仅INFERENCE。

以下均为 **MEASURED ms**，每行30 warmup+120有效提交/timestamp样本；主matrix24行=2,880帧，低coverage6行=720帧，共3,600帧。Local为实际LightCluster pass时长逐帧之和；Surface是实际native opaque+background pass，包含fused material/direct/global/IBL，不能当独立local BRDF计时。Local+Surface先逐帧相加再取分位数，Frame为command span、不含harness的外部GPU fence等待；所有分量的max/count、每pass、raw ticks、CPU owners在原件，不相加P50/P95。

高coverage，camera z6，V=1,957,668（94.4091%）：

| Case / N | Local P50/P95/max | Surface P50/P95 | Local+Surface P50/P95 | Frame P50/P95 | CPU P50/P95 |
| --- | --- | --- | --- | --- | --- |
| point-overlap-low-a/0 | 0.000/0.000/0.000 | 10.398/65.063 | 10.398/65.063 | 30.783/162.369 | 3.30/5.00 |
| point-overlap-low-a/1 | 47.036/60.175/174.585 | 8.305/11.155 | 55.522/69.617 | 72.638/98.446 | 3.90/7.00 |
| point-overlap-low-a/4 | 46.049/71.112/176.981 | 9.633/81.322 | 56.498/139.590 | 74.265/242.549 | 3.20/4.60 |
| mixed-sparse-high-a/64 | 11.358/13.128/14.114 | 33.184/35.767 | 44.613/47.238 | 74.195/77.118 | 3.20/4.10 |
| mixed-sparse-high-a/128 | 10.031/11.956/13.051 | 52.050/55.902 | 62.379/65.421 | 94.870/98.144 | 3.80/6.30 |
| point-overlap-low-b/8 | 46.054/72.541/180.632 | 12.291/44.763 | 58.498/163.135 | 78.852/255.979 | 2.90/4.20 |
| point-overlap-low-b/16 | 44.300/166.184/178.937 | 14.454/121.528 | 60.110/240.629 | 77.801/315.290 | 3.10/4.40 |
| point-overlap-low-b/32 | 47.225/56.241/185.900 | 22.634/26.411 | 69.933/78.151 | 94.973/104.330 | 3.30/5.00 |
| mixed-sparse-high-b/256 | 9.838/36.149/48.025 | 83.774/216.867 | 93.612/262.807 | 138.488/321.446 | 3.20/4.60 |
| mixed-sparse-high-b/1024 | 22.568/25.014/26.700 | 456.189/462.047 | 478.761/484.720 | 507.325/513.747 | 3.20/4.50 |
| spot-overlap-low/1 | 53.338/61.886/146.774 | 9.882/12.063 | 63.408/71.672 | 84.081/95.631 | 3.60/5.60 |
| spot-overlap-low/8 | 53.670/61.223/64.688 | 14.110/16.424 | 68.183/74.947 | 90.497/96.607 | 3.10/4.90 |
| spot-overlap-low/32 | 47.995/56.188/59.959 | 31.200/34.060 | 79.575/84.934 | 110.424/117.150 | 3.10/5.10 |
| point-overlap-high/64 | 47.349/117.068/167.323 | 38.074/123.525 | 86.926/192.367 | 122.331/248.451 | 3.10/4.20 |
| point-overlap-high/128 | 42.847/159.527/172.025 | 65.084/278.614 | 106.781/437.407 | 144.157/504.151 | 3.20/5.10 |
| point-overlap-high/256 | 2.706/4.788/13.793 | 186.398/298.864 | 189.180/300.746 | 224.918/368.491 | 3.10/4.00 |
| point-overlap-high/1024 | 9.319/12.108/44.634 | 752.745/1047.590 | 763.079/1059.974 | 799.112/1086.310 | 3.20/5.00 |
| mixed-overlap-low/4 | 53.425/64.946/184.378 | 10.877/13.988 | 64.135/77.273 | 84.625/106.518 | 3.30/5.50 |
| mixed-overlap-low/16 | 49.967/59.629/177.974 | 18.713/21.195 | 69.199/77.261 | 91.983/100.688 | 3.00/4.40 |
| spot-overlap-high/64 | 44.734/151.644/162.823 | 54.137/215.900 | 99.135/375.136 | 133.470/448.588 | 3.20/4.40 |
| spot-overlap-high/128 | 39.858/99.551/157.435 | 102.972/185.756 | 142.726/225.592 | 176.951/312.556 | 3.10/4.10 |
| spot-overlap-high/256 | 10.128/45.545/49.029 | 241.973/478.807 | 254.083/511.349 | 293.651/573.227 | 3.20/4.40 |
| spot-overlap-high/1024 | 34.080/45.517/170.847 | 873.980/1045.299 | 905.936/1079.309 | 938.190/1117.919 | 3.30/4.90 |
| coat-custom/8 | 15.427/16.988/18.377 | 15.534/18.321 | 30.449/33.647 | 57.644/61.149 | 2.80/3.80 |

低coverage，同一Scene/camera z12，V=485,040（23.3912%）：

| Case / N | Local P50/P95/max | Surface P50/P95 | Local+Surface P50/P95 | Frame P50/P95 | CPU P50/P95 |
| --- | --- | --- | --- | --- | --- |
| point-low-coverage/0 | 0.000/0.000/0.000 | 2.623/16.377 | 2.623/16.377 | 15.524/93.002 | 3.80/5.80 |
| point-low-coverage/1 | 41.663/144.945/178.116 | 2.106/12.637 | 43.724/150.324 | 54.446/218.577 | 2.90/4.10 |
| point-low-coverage/4 | 45.092/55.456/134.638 | 2.636/4.148 | 47.734/58.502 | 58.818/71.660 | 2.90/3.70 |
| point-low-coverage/8 | 46.311/52.780/55.734 | 3.097/4.814 | 49.412/55.841 | 60.653/66.925 | 2.70/3.50 |
| point-low-coverage/16 | 43.986/50.034/57.647 | 3.785/5.233 | 48.137/53.714 | 59.038/64.829 | 2.90/3.90 |
| point-low-coverage/32 | 43.776/141.127/177.068 | 4.698/12.612 | 48.655/151.017 | 59.624/176.849 | 2.90/4.30 |

结论与观察：

- Point4的list P50/P95=.0172/.0522ms、HZB filter=.0159/.0505ms、assign=**46.0226/71.0082ms**；Local total=46.049/71.112ms。少灯GPU成本仍集中于全域assign，CPU render=3.2/4.6ms。低coverage的Point4 Local仍45.092/55.456ms，不随V同比下降；不是关闭材质/纹理/providers的结果。
- 旧lookup仍C=48,960。Point4：active=4，E_written=65,280，nonempty light clusters=16,320，fallback=0；Point128 E_written=2,088,960。Point256/1024全部16,320个nonempty light clusters进入per-type overflow fallback，written=0却没有丢灯；Spot256/1024为18,360个fallback。mixed sparse1024有5,088/5,160 nonempty clusters fallback、written=5,236、evaluated references=5,215,348。**assign变小不是总成本优化**：Point1024 Surface752.745/1047.590ms，Spot1024为873.980/1045.299ms。
- Na/HZB前候选、occupied froxel Ca、Q及fallback本可写入的真实E无独立生产counter，保UNKNOWN；写出的E和fallback由实际header/lookup观察，不用profiler零字段代替。单plane在2040个tile内的Ca≈2040只能ESTIMATE；`nonemptyLightClusters`不是Ca。旧intersection loop工作上界C*Na，提前per-type overflow会停止测试，因此不把上界冒称实际测试次数。
- 全HDR域finite、64实例与材质保留；每个ordinary case64个独立HDR delta样本，最大绝对delta error约.004375发生在1024灯，仍通过原 `.002+abs(reference)*.003` 相对/绝对合同。复杂coat/custom有finite域、完整coverage、参数edit和实际providers验证，不伪称该组有独立BRDF标量reference。6个生产support case与20项真实WGSL边界全部通过，32px/depth两端/硬软cone/灯心/finite radius/unbounded/near/offscreen有独立预期。background/alpha/normal/ORM/coat/Unlit/custom与Sun continuation由既有production/profile oracle补足。
- 全2,880主matrix计时帧graph builds=0、compiles=0、cacheMisses=0、cacheHits=2,880，每帧一个production submit；没有新runtime selector。CPU render各组P50=2.8–3.9ms/P95=3.8–7.0ms。Point4内部scene-prepare=.1/.1、view-prepare=.2/.4、graph-execute=1.7/2.8、submit=.1/.2、profiler frame=2.2/3.5ms；这些owner分位数不相加。LightCluster独立CPU callback及dirty DB publication delta未单独计时，记UNKNOWN（分别包含于graph/scene范围），稳定帧source version不变时DB build跳过；memory/cluster evidence和JSON在计时外。这不是authored large CPU瓶颈的解决声明。
- 当前旧Lighting descriptor reserved=13,611,792B；Point4仅lookup+data已发布payload约1,044,528B（16C+32+4N+4E），不是DRAM bytes。fixture whole-renderer tracked allocated=474,438,740–474,538,836B，Point4 transient buffer pool27,223,928B cached/active0/pending0、texture pool365,305,584B cached/active0/pending0，retiring0；共享pool不能全归Lighting。字段`diagnosticReferenceBytes`只含reference Surface tracked scratch（208B），额外raw-device reference HDR/reactive/lookup/data descriptor共25,732,112B未归入Renderer accounting，untimed readback另有短暂峰值；不能把它们归作生产分配。driver hidden、旧Lighting独立in-flight/resize peak仍UNKNOWN，新6/18MiB仍预算、未实测。

完整最终artifact（本地`.local/`，ignored实验输出，不用于claim晋升）：

| 文件 | SHA256 |
| --- | --- |
| l3-0-baseline-complete.json | `97718ef7bbe14e6cf7a9608f3aa0e037e4accbb212862acf567f63968b175cc5` |
| l3-0-low-coverage-final-complete.json | `1f66a9a3b4028fbf405d6575174d2d38216a32a93b0de35bd7b667f64b574465` |
| l3-0-support-complete.json | `8ffde711a77496b3344bb9543b6821da37ba40fa90dcc9d1fb83b990a0932532` |
| l3-0-boundaries-complete.json | `869c9e9362a4002fa57dd9c31f71a45f041c4da2f558a054040de16baacdcd8a` |
| l3-0-native-production.json | `b19f1e48255ed19dcd6d6be779a6fc1e8713bd225609368a0dcba29875114c7b` |
| l3-0-shadow-view.json | `d6ed81696db7e600a1b246b86f383b52dac8830e5a6697bd8fba5a49ba8d6c1c` |
| l3-0-surface-profile.json | `62edf1caedb9fa5ab5b8bc569137b490ba1ef97eb84cebea37132a778192ccb6` |
| l3-0-product-lifecycle.json | `e538edf519a7709285095b44078ccb5a6cde2443bca94affc35bb3f6f5d77d64` |

8个入口全部passed，freshness identity匹配，GPU/scoped/page errors与failed requests为空，没有timeout；baseline约139MB，逐帧segments对象/startTick/endTick与完整灯positions已检查，不再截断。low检查帧均真实period16/phase0。普通packed production oracle仅证明其既有范围，`recoveredSceneRelease=false`表示未覆盖；另跑Product production oracle，`controlledDeviceRecovery=true/recoveredSceneRelease=true`，确认恢复后releaseScene、重复release及fenced teardown，不能凭普通oracle扩大声明。VSM真实off-camera caster/alpha/abort-retry、Surface negotiated Product资源profile/normal-ORM/coat/custom/FSR均通过。favicon403是既有host基础设施console项，非GPU/page/request failure，保原console，不过滤伪装。

集中验证：engine `npm run build`、fresh `npm run build:test`通过；lighting/native-Surface/doc/JSON投影targeted Node tests **17/17通过**。收尾docs-verify **0 findings/66既有historical warnings**；doctor、registry check/context routing、diff check均通过。8份最终artifact另检查同source identity、无depth-limit、完整ticks及错误gate。没有运行全Node套、完整authored large browser matrix、跨GPU/browser或硬件counter；它们不是L3.0替代声明，authored large Lighting acceptance属于L3.3。新DIRECT/SPARSE成本与非零threshold未测，read/write有效吞吐校准未做，保UNKNOWN并由L3.1同数学probe实测；不制造理论带宽硬件证据。

出口判断：必要数值/支持域与生命周期缺陷已闭合，baseline身份/raw完整，ABI/capacity/overflow/resource profile冻结；Cost Card的理想稀疏case具备少于旧测试量的依据，但实际净收益仍可由L3.1否证。**M3仍active，只关闭L3.0。STOP于L3.1开工边界。**

### 8.4 L3.1 开工 Cost Card 与否证合同

以下均为 **ESTIMATE/设计预算**，不是新 generator 实测。1080p 的 P=2,073,600、T=2,040、C=48,960；新 footprint 上界 `16C+48N+4I+4T+4KiB+256B`，N=16,380/I=1,048,576 时约5.51MiB，6MiB ceiling留对齐/scan层/indirect余量。相比旧12.98MiB descriptor reservation，预算缩小不自动等于 GPU 提速；LightDatabase、Sun/VSM/IBL/AO另账。最大2 in-flight+1 replacement仍18MiB，实际fence/resize峰值须L3.1测。

| 收益条件 | 被省成本与新增税 | 决定 |
| --- | --- | --- |
| 0%：全域 high overlap，f=1 | count/scatter约2CN tests，反而是旧CN上界的2倍；再付occupancy、scan、distributed atomics | 不能当正常优化收益；task/index overflow进入完整DIRECT，记录其Surface最坏成本，不藏fallback |
| 50%：f=.25 | 双遍约.5CN，节省.5CN tests，仍需扣固定管理税与list流量 | 只有节省超过固定税才成立，不由测试通过证明 |
| 接近100%：finite bounds为空/非常稀疏 | 近乎省旧CN，bounds/task初始化仍有成本；证明空域后NONE跳过occupancy及后续indirect | 非空SPARSE仍有至少约8P=16.59MB winner/depth读取与scan成本，不把空场景当普遍净收益 |

主要新增流量：occupancy约8P，counts/cursors clear约8C，最终ranges约8C，scan若三轮读写约24(C+N)，admitted IDs约4N写，scatter约4E写，consumer每次list约4B读；源灯records/Geometry/BRDF/texture/VSM useful work保持。原子约2E分布在cluster，occupancy/workgroup scan有局部barriers；常见约11个compute dispatch，portable分层scan在大extent增加level，不假设跨WG同dispatch同步。顺序/随机访问、bounds/log/exp、task binary search、register/private spill的硬件实际开销仍UNKNOWN。

理想净赢的必要条件为 `2f<1`，充分条件还要扣occupancy/scan/atomics/list/dispatch。DIRECT比较 `V*N*incident_test + accepted*BRDF` 与SPARSE的同数学总成本，阈值必须使用low/high coverage、finite/unbounded、Point/Spot/mixed全覆盖校准。**当前threshold=0/禁用**；L3.0旧cluster的4灯成本只能证明旧管理昂贵，不能证明新DIRECT16灯一定更快。没有DRAM/ALU/spill硬件counter，不用估计流量除理论带宽冒称真实性能。

L3.1集中隔离验证时首先用同一冻结fixture测新两mode的producer+Surface逐帧总量，保相同材质/曝光/全局provider；最佳稀疏case都不赢就否证并局部修订推荐方案，不加cache/history/proof救成本。profile预算、finite支持域、overflow完整输出与shader resource limits不可因成本失败缩小正确性范围。sources仍仅reference，没有本轮来源adoption或新Lighting性能改善声明。

## 9. L3.1 实施记录（2026-10-08）

开工fetch后HEAD/origin/master=`a184c975aeabe19e8cde67cf0a0159cb40d6405f`，工作区干净。构建仅在非生产环境；RendererCore、FrameProgramOwners/Lowering继续唯一旧LightClusterPass。新frame产品没有喂旧cluster owner，隔离harness借同一个真实command/submit与实际winner/material/global providers验证新consumer，不创建第二个Renderer。

### 9.1 实际闭包与来源

`LightDatabase staged/active typed slots → LocalLightWorkGenerator → parameters/lookup/data → native_local_lighting → SurfaceV4 HDR/Aux → Temporal/FSR`。bounds保守覆盖finite emitter radius、near crossing/offscreen，unbounded或极大支持域走互斥global tail；winner/depth occupancy、64-region任务、多层portable scan、同sphere predicate count/scatter、finalize与2D indirect形成完整闭包。没有旧filtered list、private256、global CAS、subgroup要求或readback控制。

ABI按Design §5：128B parameters、128B header、8B ranges、typed low24/high8 IDs，零payload物理data至少132B；N≤16380/I=1048576。region/index溢出保持完整all-admitted DIRECT；mismatch/invalid flags不能算成功。consumer核验ABI/epoch/frame/publication/count以及真实shading_view的frame/extent，错误context毒化HDR数值；rgba16float可把哨兵夹成65504，因此验证以独立HDR数值拒绝为准，不承诺一定生成Infinity。

Generator owns PSO与有界frame allocations，借DB/winner/depth。FrameGraph只声明宏依赖；Surface只读final产品。真实fence前不复用submitted allocation，最多2 encoded/submitted +1 prepared replacement；不同extent、mode、N、capacity有明确allocation identity。旧frame encode/abort不得影响复用后的frame；encoded abort→retry重写header并清scratch/lookup/indirect。device loss取消owner，旧epoch拒绝，新device完整重建；owner没有自己的diagnostic readback。

Local：既有DB publication、native graph compiler、winner reconstruction、纯incident/BRDF、Sun/VSM/IBL/AO、Surface与FrameGraph。Reference：实际重读 [M3 Source Map](../porting/next-renderer.md#m3-lighting-source-map2026-10-08reference-only) 中Bevy `fd98063564218bd210308675602a3e9643014c31`（MIT OR Apache-2.0）的cluster_z_slice、cluster_raster、cluster_allocate、cluster.wesl sphere bounds与clustered_forward消费路径。Adopt：light-centric conservative bounds、同predicate双遍与compact ranges的组织思想。Adapt：portable WGSL、显式typed DB slots、opaque winner occupancy、无subgroup、多层并行scan与完整DIRECT溢出。Reject：容量不足丢项后延迟resize、串行global scan、mesh shader/bindless假设。Original：本地ABI/epoch与publication合同、64-region任务、fenced allocation pool、Surface资源profile和独立oracle；不是逐行移植或production source adoption声明。

### 9.2 验证范围与失败处理

针对ABI、owner和现行lighting/Surface合同的Node tests为28/28。独立GPU sphere coverage包含0/1/4/8/32/257、empty winner、near/far及far外有限灯支持、5500跨真实DB pages、重复prefix/多层scan、forced 2D、两类完整overflow、mismatch/invalid/stale、DB staged abort→retry与teardown=0。native GPU入口10组场景包含DIRECT/SPARSE、forced overflow、8 custom Programs及6组支持域；64实例、独立HDR点样本与完整finite域保原合同，最大delta error约0.000193071，frame/extent故意污染均被原numeric gate拒绝。

隔离integration使用4Programs、8ExecutionBins、2BindingSets，保normal/ORM/coat/Unlit/custom/alpha、Product完整16-storage profile、2个Sun continuations、真实VSM/IBL/AO、preExposure 1.25→2.5、motion/Temporal/FSR、负determinant/nonuniform scale、publication update与resize abort→retry。两次独立device受控destroy，每epoch已计账owners从1649621B归零，旧native program与旧LocalLightWork prepare拒绝；这是controlled device destruction，不冒称driver故障或正式production Lighting recovery。

原失败保留在`.local/`：harness command捕获错误、零runtime array不足132B、writable indirect与indirect usage同scope冲突、FrameGraph root/written版本误接成cycle、full capture在120帧自动降coarse，以及fault测试误以为rgba16float一定存Infinity。分别修最小真实GPU布局/绑定或测试接线，未减少覆盖、放宽容差或加生产fallback。旧production `native-surface-production`回归通过，纯BRDF提取没有改数值；其`recoveredSceneRelease=false`仍不扩大为Product release证据。

上述功能结果不代替L3.2 production cutover或L3.3验收。

### 9.3 最终 Cost Card 与决策

最终同一source/build下，1080p/renderScale1，64实例/64材质、完整normal/ORM、同一camera/曝光/Sun/VSM/IBL/XeGTAO/Temporal/FSR；mixed Point/Spot，high coverage约94.4%，low coverage约23.4%仅改变camera距离。13组各60预热+240有效计时帧，DIRECT/SPARSE逐帧交替，每mode30预热+120有效样本，共3120个计时帧。计时段保一个production submit；readback/inspection与report在计时外。full profiler每120帧续开capture，缺scope/truncated/multi-submit仍失败，不把coarse样本计零。

以下均为 **MEASURED ms**；Total是每帧新generator pass之和+新native Surface pass之和，再取分位数，包含background/fused material/global providers，不冒称纯local BRDF时间。旧cluster/Surface仍编码，**排除于新Total但会影响cache/thermal**；整帧不是未来切换后的production成本。

| 分布 / N | DIRECT Total P50/P95/max | SPARSE Total P50/P95/max | SPARSE generator P50/P95 |
| --- | --- | --- | --- |
| sparse / 0（两者实际NONE） | 11.688/63.936/71.193 | 11.543/40.710/69.599 | 0/0 |
| sparse / 1 | 11.039/67.347/87.924 | 11.257/68.622/158.278 | .496/1.685 |
| sparse / 4 | 19.175/67.044/81.242 | 17.393/26.729/77.658 | .558/1.060 |
| sparse / 8 | 20.199/23.250/24.904 | 15.877/18.395/20.765 | .582/.968 |
| sparse / 32 | 38.760/114.694/202.228 | 21.396/80.568/133.064 | .795/2.432 |
| sparse / 64 | 44.039/124.004/210.018 | 21.945/70.662/97.022 | 1.170/3.467 |
| overlap / 1 | 7.976/20.017/65.882 | 8.952/11.028/37.678 | .829/1.074 |
| overlap / 4 | 8.891/12.112/78.037 | 11.600/30.587/88.319 | 2.196/3.366 |
| overlap / 8 | 12.323/20.860/113.351 | 17.442/30.229/111.648 | 3.597/5.040 |
| overlap / 32 | 41.550/86.909/197.158 | 57.585/63.971/226.071 | 20.019/22.831 |
| low coverage / 1 | 4.903/19.567/23.812 | 5.364/9.036/35.194 | .527/1.474 |
| low coverage / 4 | 4.336/5.281/20.763 | 4.297/5.359/20.222 | .491/.555 |
| low coverage / 8 | 4.831/5.607/7.152 | 4.481/5.620/6.553 | .503/.543 |

理想稀疏32/64灯有新Total净收益，推荐light-centric方案没有被最佳case否证。high overlap双遍仍付明显负收益管理税；只记录限制，不用生产切换声明或缓存掩盖。少灯/coverage/P95没有一致crossover，Point-only/Spot-only/unbounded全条件阈值也未校准，**非零DIRECT自动threshold继续0/禁用**，不机械选4/8/16，不建立在线学习器；显式DIRECT与完整overflow fallback均已实现。L3.3仍需检验真实production分布与该性能缺口，本轮不为数字继续改算法。

4GB profile descriptor保留I=1048576/6MiB frame/18MiB peak。真实1080p/64灯SPARSE reserve=4990808B，交替模式owner池峰值9981940B；NONE产品总328B、data132B；不存在C级旧metadata dummy。最大admission的descriptor arithmetic/CPU owner test为5774520B/frame、三份17323560B，**不是16380灯真实GPU性能实测**。所有GPU owner teardown均0；logical indices/regions/global IDs、每pass/max/count/raw ticks在artifact，reserved不冒称DRAM流量或driver-hidden VRAM。DIRECT仍保O(N) scratch、GPU fallback仍执行固定尾段，实际12/14dispatch与流量估算沿Design；无隐性巨型allocator或history。

设备为NVIDIA GTX1650Ti/Turing、Chrome154.0.8037.98，采样时观察温度89–91°C、graphics clock约645–735MHz（不是完整受控热轨迹）；跨轮绝对值不同，长尾原因 **UNKNOWN**，spill/atomics只能INFERENCE。只证明本fixture内交替模式和功能闭包，不宣称旧→新production提速、L3.3验收、DRAM/ALU/register counter或大场景完成。

### 9.4 身份、artifact 与关闭

Git起点为上述`a184c975`+本轮修改；最终engine source content SHA256=`4396e9d8fea7a7a589c1370a580e3a20adf10e5db37d42b5aa718bc3dad541ac`，fresh build:test output SHA256=`deea7d561161d8596e8a595ef990d0225cbf6fead38b98c5beab08b2383a43d2`。下列6份最终artifact共用该identity，各自保存entry hash/manifest/browser/raw数据；旧失败与中间成功仍保留，不能把它们追认为最终通过。`.local/`为ignored实验原件，不做claim晋升。

| Artifact | SHA256 |
| --- | --- |
| `.local/l3-1-work-final-closure.json` | `7b8e0012553ff5b890ccb07fbecb38989fc6bd1962dd870b4959dc95037db468` |
| `.local/l3-1-native-final-closure.json` | `1136d7e907650b9ef31c9c24a5de386749478e4c475cd5b195fd8b12e685d433` |
| `.local/l3-1-integration-final-closure.json` | `2f0a04bbe9f14968cbfbfa813186cbb1ce1b1b77dee265d26ee06e7a51261d48` |
| `.local/l3-1-epochs-final-closure.json` | `681ea10372100b87545d612246642230fabc36cd1e669c17bf1f7d0e18cfbe6e` |
| `.local/l3-1-production-regression.json` | `e0c9db8e73e656a6e76e065f8d73837dc7e61e7ec50fa9c745b2c3016f64f3cd` |
| `.local/l3-1-cost-final-closure.json` | `cc833afe0292a451d8aba53b0b26a95fb50c82ecd0427379f7ddfc58cfed6b61` |

6入口全部passed，无GPU/scoped/page errors、failed requests、device loss或runner timeout；controlled device destruction单列于epoch summary。engine typecheck/build与fresh build:test通过，targeted CPU28/28、documentation/JSON projection9/9；docs-verify 0 findings/66既有historical warnings，doctor/registry/context/diff检查通过。按`.prettierrc.json`的Prettier与新owner style guard通过；旧`tools/format.mjs --check`忽略项目trailingComma配置而报告5文件差异，未为此改工具或源码。没有跑全Node、跨GPU/browser、400MB authored Lighting acceptance或硬件counter；这些不冒称完成。

**L3.1 = closed；L3.2 = next / not-started；M3仍active。STOP。** 生产仍100%旧Lighting。下一单元必须原子切全部production consumer并立即purge旧cluster owner/ABI；本轮的compile-time隔离注入不是长期old/new selector，不能保留成生产bridge。
