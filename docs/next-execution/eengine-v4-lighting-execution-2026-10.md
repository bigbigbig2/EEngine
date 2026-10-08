---
id: eengine-v4-lighting-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-v4-lighting-2026-10.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/gpu/LightDatabase.ts
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
    - OEngine/tests/oracle/native-surface-production-gpu.mjs
    - OEngine/tests/oracle/geometry-shadow-view-gpu.mjs
    - validation/cases/geometry-scale-acceptance
    - validation/cases/renderer-cpu-host
    - tools/gpu-oracle/registry.mjs
    - tools/docs-verify.mjs
---

# M3 Lighting V4 执行计划

M3 的唯一设计依据是 [Lighting Design](../next-design/eengine-v4-lighting-2026-10.md)，全局不变量继续遵守 [V4 母稿](../next-design/eengine-v4-native-shading-2026-10.md)。本文件唯一维护 M3 详细状态；[workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml)只导航模块。M1/M2/CPU 结果保留在[原执行记录](./eengine-v4-native-shading-execution-2026-10.md)，不复制或重开。

## 1. 当前状态与停止点

2026-10-08，`git fetch origin` 后 HEAD/origin/master=`ae140163886b71bf9a153033ba2e1460dc612ab9`，起始工作区干净。M3 source audit、两份模块authority、pinned source map与执行边界完成；**M3 production implementation 未开始，M3未验收**。详细源码事实、成本估算、方案选择与ABI均在Design，不把历史计时冒称本轮baseline。

| 阶段 | 状态 | 单元与退出结果 |
| --- | --- | --- |
| L3.0 Baseline & Lighting Contract | **next** | 当前生产GPU成本、独立数值/支持域、profile和DIRECT crossover输入 |
| L3.1 Complete Local Light Work Construction | not-started | 非生产完整generator/product/consumer闭包；不是逐步production迁移 |
| L3.2 Atomic Lighting Cutover & Purge | not-started | 同单元切所有production consumers并立即删除旧管理链 |
| L3.3 Production Lighting Acceptance | not-started | 同条件完整正确性/生命周期/成本；关闭M3后STOP |

本轮到 **L3.0 next** 即停。没有新runtime/shader/probe/benchmark，也没有新的GPU性能或adoption声明。

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

预计新增路径为 `render/lighting/LocalLightWorkGenerator.ts`、`gpu/GpuLocalLightWorkAbi.ts`、`shaders/local_light_work.ts`，由实际本地风格确定，**本轮未创建**。用既有GPU oracle harness隔离generator→真实native consumer，不预填成功列表/HDR。复用LightDatabase、Geometry/Material providers和math，不import旧cluster owner。shader/math提取不能靠字符串marker从legacy fullscreen runtime偷偷保旧产品。

必须验证count/scatter使用同predicate、all-admitted segment始终完整、unbounded/finite互斥、zero/multiple同类型灯不重复或丢失；source slot24bit超界拒绝，scan重复prefix和多层边界/dispatch limits完整。Finalize只可从SPARSE降级DIRECT，所有WG atomic OR flags，不允许其他WG恢复SPARSE覆盖失败；提交后Surface只读immutable final版本。

集中验证一次：engine typecheck/build、新鲜build:test，ABI/CPU independent oracle、shader compilation，真实GPU0/1/4/8/32/mixed、empty/one/full/forced index overflow/region budget/count mismatch/stale输入；HDR独立点样本+完整finite域/coverage。匹配新DIRECT/SPARSE交替计量Surface+generator总成本，确认非零threshold、6MiB/18MiB峰值与最坏fallback；无净收益机制删除或禁用，不加cache/history。

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
