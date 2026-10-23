---
id: eengine-vsm-quality-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-vsm-quality-2026-10.md
    - docs/porting/next-renderer.md
    - OEngine/src/gpu/GpuVsmProjectionAbi.ts
    - OEngine/src/gpu/FinalPixelAbi.ts
    - OEngine/src/shaders/scgi_lighting_gather.ts
    - OEngine/src/render/surface/SurfaceV4.ts
    - OEngine/src/render/vsm
    - OEngine/src/render/ShadowGeometryWork.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/shaders/native_visibility.ts
    - OEngine/src/shaders/vsm_caster_records.ts
    - OEngine/src/shaders/vsm_sampling.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/render/temporal/NativeTemporalV2.ts
    - OEngine/tests/oracle/vsm-quality-contract-gpu.mjs
---

# Directional VSM：三步重构执行

唯一目标依据：[当前设计](../next-design/eengine-vsm-quality-2026-10.md)。
2026-10-23 用户先要求重写设计/执行，随后明确授权**实施步骤1并提交代码**；不自动实施步骤2/3。
旧 Q1-Q4 顺序被下列三步取代；旧代码保留到新闭包原子切换，不回滚、不恢复旧生产桥。
不使用子 agent；GPU 检查串行；不自动跨入其他 renderer 模块。

## 执行总表

| 步骤 | 当前状态 | 一个完整交付边界 |
|---|---|---|
| 1. 页面与质量合同重构 | completed；本步出口通过 | source distance 选级、4096虚拟clip/资源profile、完整需求与本地容量分配、相邻fallback/过渡、紧凑页面ABI及全部consumer |
| 2. 几何、光栅与更新原子切换 | planned；无新 raster 实施 | selected dirty→LOD/refinement→共享source准备→triangle拒绝/紧致bin→真页裁剪→完整commit；精确失效/增量发布/旧owner删除 |
| 3. 两档过滤、集成与调优交接 | planned；disk4仍为当前默认 | stable PCF、完整PCSS及Temporal消费；集中正确性/接线/容量/粗成本检查；用户手动调参入口与诊断 |

设计不替代实现结果；source adopted、实际性能提升、整Renderer画质均不因设计被勾选。

## 步骤 1：一次闭合页面、需求、资源和采样选级

实施范围：

- 对照 Timberdoodle pin 的 `clip_info_from_uvs` active distance 分支与mark/free/allocate/roll源码，提取一份共享投影/选级语义。
  需求、采样、support、过渡、world-page身份一起迁移；不保留 first-containing 作为第二生产选择器。
- 默认采用64texels/page、64pages/clip、gutter4、最多16clips；消除六层硬编码。
  保持旧有效 finest world texel与最远覆盖的初始化转换，明确donor实际最低选level1；不能相同extent直接减分辨率。
  从新旧实际selector算world-texel分布并据此给默认selection bias；缩小base extent可能被distance选级抵消，不能当作质量无损证明。
  资源档2048/4096/8192对应16/64/256MiB depth；8192必须显式预算，不自动因显卡limit开启。
- 原始需求完整保留，接上真实footprint/两端；复用旧Q1本地2:1/log2/page-key admission，不再新造排序。
  free/unvisited队列适配32位字段的写者/dispatch阶段边界；不能拆64位原子后仍假装并发一致性天然不变。
- 新ABI只保留fine与真实emergency coarse；管理mip1..4及其scan/descriptor成本同时删除。
  邻近fine逐级回退、ready相邻fine过渡、coarse仅兜底；所有Surface/Native/debug/FrameGraph/resource消费者一起切换。
- reset、empty、roll、projection epoch、abort/retry、device loss、资源替换与旧代fence退休在同一资源闭包完成。
  更新所有实际资源上界；需求增长不得靠漏请求抵消。

本步不扩大成过滤实现：新PCSS最大footprint的需求入口/配置边界先准备完整，步骤3实际启用消费者。

出口：只有一套生产page ABI与selector，raw/admitted/ready原因可观察；当前atlas raster可消费新ABI直至步骤2切换。
必要验证：集中typecheck/相关shader compile；复用或迁移**一个**小型GPU合同fixture覆盖选级两端、滚动、超容量和abort。
不重新跑旧七套oracle、不跑Bistro全场景、不做性能调参。若发现真实错误，局部修复并只重跑受影响检查。

## 步骤 2：连续完成整个昂贵执行闭包，再一次切换

先在新owner内部完成producer/product/direct-consumer，不逐个给旧consumer加adapter。
本步允许开发中的暂时断链，不允许稳定边界出现两套生产raster owner。

实施范围：

- 从实际selected dirty页面建立gutter-aware hierarchy，fine/coarse尺度独立；Geometry在refine前查它。
  donor shadow texel LOD与off-camera caster/streaming一起连通；移除coarse requested宽域驱动SSE0深遍历。
- ordinary/Product共享source meshlet唯一顶点准备，实际active coverage属性按依赖读取。
  保留索引复用、镜像、双面、原三角输入与梯度；不再按每页pair解码object→world/light。
- 移植donor meshlet/triangle dirty/backface拒绝，输出triangle/page工作。source阶段判定native material bin，
  仅为完整页容量与紧凑bin做必要计数/前缀，删旧meshlet-pair count/write后再classify的一整条重复执行。
- 接Sundial四clip planes到gutter-expanded slot；Renderer创建device时可选申请clip-distances。
  外部device未启用/设备无feature，使用等价四边polygon clipping，保留lineage、原始coverage插值与导数。
  不用顶点clamp、不靠fragment discard、不拒绝巨型三角形来避免光栅成本。
- 新流由GPU indirect批量执行，draw随有限native program/bin和source chunk增长，不随材质实例/页面线性CPU编码。
  容量失败整页不commit；单页过大按固定capacity-derived source chunks在同一frame累积，不能永久饥饿。
- 精确coverage/source/influence失效：MASK lowered alpha dependency、old/new bounds、删除、streaming promote/evict、太阳/深度域epoch。
  替换广泛全图view依赖，保留真实alpha资源/数值变动检测。descriptor只从mutation维护，三帧scratch首次写域完整。
- 集中切换 `FrameProgramLowering`、VSM资源/commit、Native raster与采样产品；删除旧显式/隐式pair raster、
  `cached=false`的旧VSM专属解码分支、页外discard、没有consumer的管理/临时产品和兼容测试表示。

成本出口：列出新scratch实际分项（基础≤32MiB、高容量≤64MiB）、峰值/fence、dispatch/atomics/barriers、
source vertices、triangles、P/C输出、raw/selected/committed页面与延期原因。无dirty时重阶段indirect=0。
不能把新增triangle/page records的成本漏掉，也不宣称所有小场景均更快。

必要验证：结束后一次architecture review、集中compile，以及**一个**小型真实GPU输入→输出检查：
两种裁剪feature、opaque/MASK、gutter边、镜像、大三角、整页overflow/chunk/abort。
用同一fixture的少量边界输入，不新建一组benchmark工程；已有未受影响的filter结果不重跑。
本步不比较两套生产后端、不跑全套历史测试，也不为旧测试保留旧owner。

## 步骤 3：两档过滤和最终交接，一次集中检查

实施范围：

- `stable-pcf`移植固定Bevy pin的Castano Gaussian全部偏移/权重/归一化，作为默认。
  raw四深度重建每个bilinear tap，保持actual-texel receiver-plane correction、reverse-Z零空语义与gutter。
- `soft-pcss`移植同pin directional blocker/search/blur/Jimenez完整链，含`utils`常量与`shadows`调用坐标。
  depth转换、无blocker、近接触、最大search/filter支持域、跨虚拟页、缺页与需求一致性一起完成；不只提取spiral/Vogel点。
  Temporal开启接已有HDR Temporal motion/响应/失效，关闭走源静态采样分支并明确噪声，不引入专用shadow history。
- 退休disk4/gather2x2产品配置与无consumer噪声资源；保留point诊断。不保留旧配置兼容桥。
- 完成正常开发/演示入口的调参：默认stable/soft切换、光源size、LOD/clip bias、深度bias、过渡、page/work预算。
  初始化资源设置与运行时设置分开，重建/epoch/历史失效可解释；界面不允许输入超出真实footprint/capacity范围。
- 给用户页状态/实际texel/clip/过渡/fallback可视图；raw/admitted/ready/overflow/延期原因、工作量和Geometry/setup/raster/filter时间。
  无timestamp feature时报告不可用，不用CPU wall time冒充GPU分项。

最终集中检查只覆盖本次重构的必要范围：

1. 一次新鲜typecheck、build:test和production shader编译；修复真实失败，退休ABI测试删除/迁移，不恢复旧生产者。
2. 少量独立语义检查集中覆盖选择/过滤/裁剪与完整页发布。源移植的数值/语义证据复用上述fixture和最终consumer，不额外造长期oracle平台。
3. 实际完整Renderer抽查静止、相机移动、太阳变化、MASK编辑、Geometry streaming；包括空页、超容量、abort/retry、resize/device重建。
   不把尚未执行项目冒称通过，不为“留给手调”放过已发现错影/漏工作。
4. 同场景/分辨率/有效world-texel/覆盖/材质/驻留质量下做一次粗粒度前后成本归因。
   基础PCF与软PCSS分开报告，区分新增能力成本与工作消除；不能靠减少ready细页、缩场景或关MASK获得提速。

这不是大规模P50/P95资格项目、每patch回归或自动参数搜索。无法恢复同条件旧树时明确只有新路径分项，不编造前后百分比。
完整跨设备/长时性能资格保留最终Renderer集成；本轮新实现的正确性、实际接线、资源上界和异常生命周期不得延期。
交付后由用户自行探索场景参数和画面；实现者只修真实结构/正确性问题，不擅自反复跑长benchmark并重定架构。

## 原子退休与范围

当前dirty worktree保留，不把旧Q1实现撤销当作“重构已完成”。步骤1迁移页面owner，步骤2迁移几何raster owner，
步骤3迁移filter owner；每一步内部所有直接消费者一次切换，稳定边界只有一套ownership。
保留既有Geometry/Material/Temporal模块，不启动native wgpu backend、local-light shadows、双depth池或软件VSM。
如真的无法保留某段donor语义，列出函数/缺失能力/画质或成本差异后先与用户讨论，不能临时缩成近似算法继续勾选。

## 步骤1实施记录（2026-10-23）

### 单一生产切换

- `GpuVsmProjectionAbi`成为clip数组/offset/size事实源：16 clip容量、432B projection、304B residency；
  receiver、allocator/scan、caster、raster、window/caster invalidation、descriptor、Native/debug（含关闭阴影的neutral binding）、ShadowTileDomain、SCGI remap全部同步。
- 64texels/page、64pages/clip、gutter4，只有mip0/5两个physical plane；每clip4112条管理记录。
  旧mip1..4索引/scan/write域删除，不建旧ABI adapter。coarse 4×4 ring，live最多3×3。
- `vsm_select_clip`移植donor active distance分支；`vsm_transition_weight`使用同一distance边界。
  所有有效`(0,1]` receiver逐像素参与；first-containing XY selector退出生产。
  fine缺页先逐层检查更粗fine（不越级跳mip5），普通过渡只在选定级与下一ready fine，coarse永不混入过渡。
- `boundedFilterFootprintRadiusTexels`给未来有限足迹入口：不能小于当前核、最多一页半径；
  当前point/gather/disk4均完整落在4texel gutter，不虚增邻页；将来超gutter时最多3×3页/端点完整展开。
  hash128项溢出直接发布bit+score而非漏请求；每page每receiver权重最多3，viewport预检维持u32分数上界。
  此接口不是已实现跨页PCSS，超出该有限界的soft配置需在步骤3协商，不能暗中clamp源核。
- 旧Q1 raw/admitted分离与2:1/log2/page-key策略保留；coarse分区、free优先/unvisited次之、冷页顺序、
  unique writer与touch→collect→allocate dispatch边界保持；不仿造拆开的64位原子。
- `vsmResourceBudget`初始化默认64MiB/10层，可显式16MiB或256MiB、10..16层；8192不会由device limit自动开启。
  默认3046fine/90coarse，16层2992fine/144coarse；下限档默认694fine，16层640fine。
  9层仅匹配旧名义最远全宽，默认第10层补足旧forward偏心及snap边缘；避免默认16层扩大128倍线性coarse域。
- SCGI remap不再只有一个fine加六个coarse：容量按最多32个完整keyed descriptor/receiver协商，
  保留所有fine回退与coarse链。它仅在受限Native窗口remap使用；一般Native仍直接读compact descriptor产品。
  这处正确性补齐有明确额外窗口成本，未冒称优化。

### 本步Cost Card与质量边界

| 项 | 旧高档 | 新默认10层 / 最大16层 |
|---|---:|---:|
| depth atlas | 64MiB | 64MiB；显式高档256MiB |
| 管理记录 / bytes | 131328 / 6303744 | 41120 / 1973760；65792 / 3158016 |
| compact descriptor bytes | 1579008 | 657920 / 1052672 |
| raw或admitted bitset bytes | 16416 | 5140 / 8224 |
| priority bytes（已有Q1） | 525312 | 164480 / 263168 |
| slot meta bytes | 28800 | 100352；显式8192为408608 |
| 固定pair-page count scratch | 14400 | 204304（按支持的最大12769槽预建） |
| tile域 header+rows | 1792 | 4608（按16层布局） |
| SCGI remap keyed references | 140B/receiver | 最大640B/receiver，窗口规划同时缩限；无全屏新增常驻表 |

新增主要是distance length/log2、bounded footprint计算、更多physical slot扫描/dirty候选；
删除中间mip域与部分descriptor/scan流量。当前请求footprint在gutter内时无邻页atomic；未来大核额外页参与现有hash，
最坏hash满则直接atomic，保持完整性而非固定成本不变。未新增private submit或GPU→CPU→GPU控制。
9→10→16层的metadata、coarse、实际Geometry域成本由配置明确承担。

旧750fine×128²与新16层2992fine×64²的总core texel几乎相同，不能把slot数约4倍说成同画质容量约4倍。
本步增加的是同world-texel下更小的驻留/更新颗粒能力及可解释分配（不同实际选级下不保证world page更小），**不是保证所有距离更清晰**。
新旧实际distance/XY精度表、bias1选择与最远覆盖换算在设计第4节；普通XY轴样例中部可能比旧精度粗4～8倍。
步骤2消除光栅/Geometry工作，步骤3更换过滤；它们不会凭空增加虚拟texel。
本步尚不声明整Renderer画质或FPS净收益。

### 集中出口与遗留归属

- 已完成一次architecture review，核对新ABI全部直接消费者、capacity、dispatch writer与发布边界。
- `npm --prefix OEngine run typecheck`、`npm --prefix OEngine run build:test`通过。
- 仅运行一个合并的`vsm-quality-contract`真实GPU fixture（出口新增边界/修复neutral binding后重跑同一项，未运行旧七套）：
  NVIDIA Turing、Chrome155.0.8059.86、基线8 storage bindings；最终结果`passed`，无device lost或GPU validation errors。
  报告`.local/validation/vsm-step1-contract-exit.json`。覆盖production receiver小正reverse-depth/empty/64texel bounded footprint及独立CPU bit+score；
  16层3292fine请求竞争2992fine容量、2048真实bounded资源144coarse、8组admission输入；
  abort/retry、roll保留/离开identity、全65792 descriptor poison→完整写域/拒绝原因；
  reverse-owner/Native completion/Geometry失败拒绝commit及成功retry、重复commit不增version；
  11个距离过渡输入、fine逐层优先/coarse仅兜底；changed caster/raster/invalidation/tile/Native/SCGI shader编译与disabled neutral ABI。
- 直接受改动影响的三个既有CPU文件完成ABI迁移并集中运行：`vsm-settings.test.mjs`、`vsm-e9.test.mjs`、
  `vsm-v4-r1.test.mjs`，17/17通过，含显式预算/preflight、页别名、设置、projection epoch/abort、设备代语义；不按文件名跑整类测试。
- `node tools/docs-verify.mjs`通过（0 findings、86 historical warnings、211 documents）；旧文档仅迁移退役fixture的frontmatter验证入口。
- 合并fixture的退休范围：
  该fixture整合旧receiver-exact、sampling-publication、vsm-v4-r2所需的当前owner语义；
  旧128页/六层/冻结XY采样表示及其重复时序循环已删除，而不是保留失败脚本或恢复旧生产桥。
  hash micro-fixture保留；当前filter数值fixture只迁移projection offset，不重跑未改动核。
- 完整Renderer接线/画面、长时/跨设备、太阳/MASK/streaming组合与粗GPU成本归因归步骤3，未执行不写通过。
  无新source geometry/triangle clipping/新PCF/PCSS实现；后两步保持planned。

## 保留的旧 Q1 记录（历史事实，不是新步骤 1 已完成）

以下原始结果保留；它们验证的是旧ABI/旧selector/本地admission，不证明新distance profile、64页布局、
新triangle raster或PCSS已经完成。附录内旧“Q2-Q4”归属已由上面三步取代；不因文档重写重跑旧结果。

### 旧 Q1 实施快照

Replaced the epsilon receiver cutoff, added adjacent support and weighted page
aggregation, immutable raw demand plus deterministic admitted demand, connected
all residency and ShadowGeometry consumers, and removed coarse transition mixing.
Diagnostics expose raw/admitted fine counts and the fixed fine capacity.

Retired prior-frame in-flight slot pinning: old submitted commands precede the
new allocation on the same queue, and current work is not published yet. An old
failed selection cannot override current admission. The quality oracle preloads
both clean and failed dirty/in-flight low-benefit residents and proves immediate
higher-benefit replacement.

Sampling transition uses the very same paired endpoint helper as receiver demand,
not an independently assumed clip+1. Compact descriptor lookup is verified against
a separate full management-table lookup with only its search policy adapted to
Q1. The retired S3 broadcast query is not a second production owner or a mandatory
compatibility oracle for the deliberately replaced policy.

### 旧 Q1 实际验证（不重跑、不提升新设计状态）

- `npm run typecheck`, `npm run build:test` in OEngine pass. Final source/build
  identity is present in each corresponding GPU JSON; no clean-revision claim.
- Hardware GPU: NVIDIA/Turing, non-fallback, Chrome 155.0.8059.86. Requested device
  uses the portable eight-storage-buffer baseline; no subgroups or mesh features.
- `vsm-quality-contract`: actual production FrameGraph/allocator abort/retry,
  immutable raw demand, CPU log2-tier ordering, replacement and stable admission;
  actual high and bounded resource layouts, including 2048 atlas/four-clip/125-fine
  bounded allocation. Eight independent empty/under/exact/over capacity ranking
  cases; eleven real depth-atlas fine/fine transition samples, adjacent fallback
  before coarse and emergency-coarse-only fallback.
- `vsm-receiver-exact`: 64 independently projected receivers, depth .00005,
  rotated nested-window interior and both fine endpoints; exact full request bits.
- `vsm-receiver-aggregation`: 138 disjoint workgroups, 565248 exact bitset words
  and 7582 exact scored keys, including a 128-distinct-key colliding full table;
  128/1/0 probe limits each repeated three times, primary-invalid support,
  partial/empty groups and reset. Forced probe variants are test-only; production
  uses 128 and retains direct bit+score fallback.
- `vsm-sampling-publication`: full management identity vs compact lookup, rolling
  windows, signed f32 nextafter/subnormal boundaries, poison/full write and all
  six query statuses. Does not claim old PCF arithmetic or retired broadcast
  preservation; filter mathematics remains owned by its independent oracle.
- `vsm-v4-r2`: production receiver requests 20480 fine/support pages from 32768
  pixels, explicitly admits 750 and retains initial/rolling coarse coverage
  96/150. Empty complete publication, duplicate-commit prevention, failure never
  ready, reverse owner, abort/retry, oldest dirty fairness, convergence and cold
  reclaim pass under the new admission owner. Timestamp feature was not enabled,
  so this run is semantic/lifecycle evidence, not performance evidence.
- `performance-diagnostics`: production diagnostic specialization vs independent
  CPU sets, partial/empty groups and reset passes. Publication count now means
  page-key bit publications; primary-page/word statistics remain primary-only.
- `vsm-filter`: 388 configurations/595968 CPU-GPU comparisons across 64 phases
  pass, retaining actual texel-plane comparison, reverse-Z empty/negative/equal
  references, all gutters, thin pole and non-power-of-two gather semantics.
- Targeted receiver pipeline unit tests and the VSM aggregation contract pass.
  The broader pre-existing Native diagnostic test also ran and fails at its
  expected inline winner-generation predicate; current Native uses
  `native_recover_winner`. This is unrelated to Q1 and was not weakened or fixed
  by changing Native. Do not report that whole contract file as passing.

Artifacts are in `.local/validation/vsm-quality-q1-*.json` (local, not committed).
The seven final serial runs use the `vsm-quality-q1-closed-` prefix and source
identity `e5ef093a32b7c57139214560a2a06788a2b372b044b327fd564fee4614b826e7`.
Subsequent removal of two unrelated formatter-only hunks in FrameProgramLowering
does not change the VSM program; compile checks are repeated for the final tree.
Original failures are retained: the first receiver run had harness unsafe port
2049 (no shader failure); two residency fixture migrations exposed reused frame
serials and the old assumption that all admitted fine pages are in clip0. Fixing
the independent fixture to monotonic phases/all fine clips preserves the actual
lifecycle assertions. No assertion tolerances or production fallback were added.
One formatter invocation encountered a transient Windows file-open error; retry
on the named file succeeded.

No complete Renderer visual, streaming/MASK/solar-motion integration or same-scene
P50/P95 qualification yet. Q1 adds bounded necessary ranking/request work; it is
not declared a net optimization. Those obligations belong to Q2-Q4 integration,
not evidence that current images have already reached the desired quality.
