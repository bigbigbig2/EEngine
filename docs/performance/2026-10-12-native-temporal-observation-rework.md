---
id: native-temporal-observation-rework-2026-10-12
state: history
---

# Native Temporal 观测物理返工实验（2026-10-12）

本报告延续[源码诊断](2026-10-12-final-pixel-source-diagnosis.md)，记录HEAD `1c41fb77`上的未提交返工。当前单元最新状态只读[执行authority §7.3](../next-execution/eengine-v5-final-pixel-performance-execution-2026-10.md#73-native观测物理返工生产出口2026-10-12)。§1–5保留首次实验快照（当时未改production）；用户要求继续后的实际生产切换与出口见§6。没有提交、子agent、正式Phase6或其他大模块实施。

**Native观测物理单元已切production并关闭出口，有限whole/Temporal成本有正收益；正式整Renderer、60FPS和4GB验收未完成。** 首次热混杂与全部原失败保留，不被后续正收益覆盖。

## 1. 接续时实际完成情况

诊断报告已完成；Phase1–5原结构与必要正确性出口仍成立，Phase2/3/4/5联合净性能未资格，Phase6未开始。工作区已有test-only R8候选、动态quality注入入口、真实输入捕获与短ABBA工具，§7.2已登记返工。第一版R8候选小质量与1080p矩阵通过；真实输入回放完整链P50 8.285376→8.229632ms，收益很小。其四轮96样本Dungeon成本同样未资格，不沿用为v2证据。

接续时第二版Measure/Exposure候选停在编译失败：Exposure以两个u32标量调用`vec2i`，GPU host顶层`status=failed / failureKind=gpu-error`。该次oracle内部summary为passed不能覆盖GPU错误。修为显式`vec2i(vec2u(...))`，同时将四子块合并恢复原`a、下、右、右下`加法顺序。原件`candidate-v2-quality.json`保留。虚拟源码typecheck第一次因测试宿主工作目录错误找不到WebGPU类型，保存`v2-typecheck-harness-failure.log`，修宿主cwd后完整candidate typecheck通过；没有改生产代码来绕过这些错误。

## 2. 完整候选与Cost Card

唯一test-only完整链：Measure→Exposure→Shading Pyramid→half-domain R8 Shading Change→Analyze→Resolve→RCAS。冻结before与候选均有自己的完整owner/角色；只有离线oracle和独立Vite诊断构建选择候选，Renderer没有runtime开关。五个before WGSL export逐字符串核对当前fresh `.test-dist`全部一致。快照SHA256见[fixture manifest](../../OEngine/tests/oracle/fixtures/native-temporal-observation/manifest.json)。参考仍为AMD SDK 1.1.4、MIT、`c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`；本次改变物理执行，未采用新算法或升级来源adoption。

| 项目 | DELETE | ADD / 保留 |
|---|---|---|
| Measure | 原64×64/256lane组织；1080p邻域+box逻辑Seed depth loads约20,718,004 | 32×32/128lane；34×34深度halo每组1156 load，总2,358,240；shared 16,384→8,720B，12个uniform barriers；2040组对原510组。RGB/log、严格nearest顺序、sky与half box不变 |
| Exposure | 原64tile的直接scalar输入组织 | 原dispatch内按原树序合并四32tile，再作原mip5 half边界/全局树；额外tile loads。shared仍16KiB，无跨组barrier/atomic/global counter |
| Shading Change | Analyze每pixel四次low-change，共12N filtered layer queries及4N重复量化 | half-domain .75N尺度查询、.25N R8 store、Analyze N次R8 filtered读取；一个新dispatch/dependency。实际R8 store只一次，无history/clear/atomic |
| 产品/容量 | Analyze三个尺度直接bindings | 三尺度→R8 producer→Analyze，保硬件RG16/R8 filtering；逻辑R8 518,400B；log tiles 2040→8160B。真实Renderer池各保留两份，API live/peak增量**1,049,040B**，不是单份产品大小 |
| 其他链 | 无 | Seed own-pixel、3×3前景receiver、完整identity/generation、raw-depth pull、Resolve16tap/当前9tap、luma response/locks/HDR/RCAS与true upscale/bypass不改 |

内存访问：halo和log/产品写为tile内合作/顺序访问，尺度与R8是filtered访问；不把逻辑load减少当DRAM减少。ALU保留必要log、搜索和全部重建；新增halo寻址/共享读取、曝光四子块求和、调度/更多组是实际税。无新pipeline/history常驻于production。测试候选多一个pipeline，资源只由既有FrameGraph寿命与最后completion管理，未增加frame submit或GPU→CPU→GPU控制。

设D为实际删除的重复读取/执行成本，A为halo/shared/组调度/曝光合并/R8产品及pass税。0/50/100%兑现为−A/.5D−A/D−A；理想与预期可有正收益，最坏A抵消全部D；break-even仍要求D>A且完整Temporal和whole/tail在同条件下不退。实测成本见下节，不将samples倍率或shared大小当ms预测。

## 3. 已实际验证

- candidate虚拟源码完整TypeScript检查通过；实际before/candidate Dungeon Vite构建通过；Dungeon `typecheck:dungeon`与fresh `build:test`通过。
- `native-temporal-observation-measure`：12组尺寸，tiny/odd、31/32/33和63/64/65接缝、1919×1079、1080p、4096窄域及完整4096×4096。raw luma、half box、receiver、96B weights与exposure frameInfo共**352,882,000字节完全一致**。包括sky、深度并列、HDR、reset/valid；不是只比较全图均值。
- `native-temporal-observation-boundary`：独立已固定SDK ShadingChange producer，实际RG16过滤、R8写入；tiny/odd/1080p八相位存储字节比较。1×1使用解析预期值，因为参考floor-half域为空。
- `native-temporal-observation-quality`：17个动态序列通过既有统一门；两个原floor-only逐帧RMSE诊断保留在strictGateFailures，采用此前已授权1%/3%门，没有再次放宽。
- `native-temporal-observation-matrix`：1920×1080六类×256帧×8ROI，1536成功帧，failures=[]，无GPU/scoped errors。HDR/display、energy/phase/peak/trailing/settling仍沿原独立门。合成矩阵不能冒称真实Dungeon完整动态材质/normal/coat验收。
- 当前生产和完整候选分别运行既有11项事务合同，共22项通过：missing writer、joint Seed/V2共同提交、abort/retry、cut、resize、cached late binding、three-inflight、invalid extent/capacity、上传/分配失败回滚、device loss与fence retirement。候选测试复制仅改变构造owner导入，原断言不变，命令与副本保存在`.local/`。
- 同一真实Dungeon冻结HDR、Seed/response/identity、previous color/depth/luma/confidence/lumaHistory/frameInfo、P与weights完整回放；每次恢复同一旧history后再计时。manifest含每输入SHA256，回放核字节数和SHA256，读回只用于离线fixture。
- 四轮实际Renderer固定1920×1080、DPR1、scale1、near .15、high PhysicalSun、AA/RCAS、AO/Bloom OFF、原Geometry/SSE/材质，geometry settled后采样。每轮96完整GPUframes，八相位各12帧，提交后的color/identity角色一致；coverage约90.66–90.70%，invalid=0。保存全部实际runtime WGSL：Before105 modules/80 unique，Candidate106/81，不再只存generator长度/hash。仍无机器码/occupancy/spill/counter证据。

观测工具修复：diagnostic configure会reset统计，原stableFrames>60门导致target前60帧漏记录committed jitter/role。现在performanceCapture完整记录callbacks，普通CPU稳定统计仍保原门；runner拒绝缺submitted observations的窗口。完整shader存储由显式`--shader-capture`启用，CPU捕获/输入GPU copies均不进入普通生产路径。

## 4. 成本观测与取舍

冻结真实输入v2短ABBA各8样本/path：完整Temporal envelope P50 **8.069792→7.536304ms**；Measure pass P50 **1.805648→1.294464ms**。两者各自逐frame算分位，不能把独立stage分位相加推导节省。只有一个真实history状态/一个jitter相位，未资格whole/dynamic性能。合成1080p各12样本/path：fractional完整链8.867712→8.116368ms，stationary7.990656→7.317520ms；覆盖八相位，无收益外推。

实际GTX1650Ti4GB、driver581.42、Chrome154短ABBA，以下均从**targetStart≤frameIndex<targetEnd的96帧raw**复算，不用UI stable小窗口：

| 轮次 | whole P50 / P95 / P99 ms | Temporal envelope P50 ms | Measure P50 ms |
|---|---|---|---|
| A1 Before | 21.099616 / 52.953104 / 105.025603 | 6.333088 | 1.271200 |
| B1 Candidate | 21.450048 / 38.327224 / 125.558910 | 5.688208 | .616544 |
| B2 Candidate | 24.899680 / 73.159992 / 160.850398 | 6.585696 | .697728 |
| A2 Before | 25.684640 / 99.573496 / 145.453914 | 7.654400 | 1.547248 |

温度89–91°C、swThermal Active，target范围传感器记录300–1230MHz漂移；各轮CPU长尾与GPU长尾均保留，不删尖峰、不频率归一化，也不声称thermal解释全部差异。B1比A1 whole更慢，B2比A2更快，不能据此宣布可靠净收益/正式回退。新增R8 producer后Measure局部改善值得保留，但不满足原诊断的matched whole/tail切换条件。

API peak Before1230.777MiB、Candidate1231.777MiB；这是API容量，非DRAM流量/OS稳定4GB资格。runner本次未加`--audit`，不冒称外部API teardown全部为零；已有实际engine texture/geometry teardown记录及候选独立fence合同有各自范围。

**取舍：保留v2 test-only闭包和证据，当前production仍为原六dispatch图。** 本次有限实验结束；生产物理返工出口仍未关闭。必须先解决可比窗口/热状态与长尾观测条件，再判完整候选是否值得切生产；不能无限重复热混杂ABBA、继续加cache/history、跨进Native/Sun或把Phase6称已完成。

## 5. 附件、复现与剩余范围

本机[原始附件](../../.local/native-temporal-observation-20261012/)保留v1、v2原失败及fixed/final结果：`candidate-v2-quality*.json`、`candidate-v2-matrix.json`、`candidate-v2-measure-final.json`、`candidate-v2-boundary*.json`、`candidate-v2-real-replay*.json`、`candidate-v2-synthetic-cost.json`、`V2-A1/B1/B2/A2/{full.json,suite.json,shaders/}`、`v2-dungeon-short-summary.json`与各build provenance。原A1/B1/B2/A2不覆盖；新短测有独立目录。

```powershell
npm --prefix OEngine run build:test
node tools/gpu-oracle.mjs native-temporal-observation-measure --json
node tools/gpu-oracle.mjs native-temporal-observation-boundary --json
node tools/gpu-oracle.mjs native-temporal-observation-quality --json
node tools/gpu-oracle.mjs native-temporal-observation-matrix --json
node tools/gpu-oracle.mjs native-temporal-observation-replay --json
node tools/gpu-oracle.mjs native-temporal-observation-cost --json
```

GPU命令串行，replay需要本机A1-v2真实输入附件；manifest校验失败不能跳过。Vite隔离构建与四轮runner命令在附件中；诊断构建有source/output SHA256并拒绝bundle变化，不能当clean production正式qualification。

仍缺：合格同条件whole/tail成本、production原子切换及新路径全部feature/retirement验证、真实Dungeon动态冻结回放多状态/相位、正式全Renderer动态质量、≥3 ABBA块×每path每块1000样本、4GB/OS驻留、register/spill/occupancy硬件证据。没有自动跨Phase6或其他大模块，也没有用局部正收益替换这些缺项。

最终raw状态与指纹复核：六个GPU oracle顶层passed、无GPU/scoped errors，四轮Renderer completed、errors=[]，保存`v2-evidence-manifest.json`。文档验证0 findings、66 historical warnings、187 documents，`git diff --check`通过；production源码diff为空，未重跑production engine build，候选采用虚拟源码完整typecheck、实际Vite构建和真实GPU编译/执行验证。未提交，用户原`.vscode/`未改。

## 6. 继续实施与生产出口

用户要求继续后，先核测量机制再完成production切换。原periodic runner每次PowerShell/CIM OS内存查询占用约1.7–2.7秒；新增显式`--observer-mode low-tax`，单个常驻nvidia-smi每250ms记录raw温度/频率，OS/CIM只在运行前后采集。`LT-A1` whole raw P50/P95/P99=17.732528/18.193184/18.851574ms，相较原V2-A1长尾改善；但LT-B1/B2/A2仍存在thermal/clock变化，不能证明原长帧全部由observer造成。四轮LT raw和summary全部保留。

还核到GPU timestamp与CPU host时间域不同，当前数据相对host约有3.8秒偏移；不把绝对tick当UTC去关联某个nvidia-smi/CIM区间。GPU duration只在同GPU query域内相减，sensor采用host收集时刻与完整window。其值的确定方式由实现决定，见[WebGPU timestamp规范](https://gpuweb.github.io/gpuweb/#timestamp-query)；没有声称逐frame锁频或时钟校准已经实现。

新增显式`--pre-window-temperature 82`入口：完成原prewarm/geometry settled后暂停固定场景，使用已有continuous sensor等待同一82°C入口，核对暂停前后提交frame与整个Temporal history evidence完全相同，恢复原设置后采完整96帧。不重置history、改画质、锁时钟/功耗/风扇、删首帧或删长帧。Cooled Before/Candidate是独立immutable构建，旧baseline/candidate dist不覆盖；源码与bundle fingerprints仍核验。

| 完整target raw | whole P50 / P95 / P99 ms | Temporal envelope P50 ms | Native P50 ms |
|---|---|---|---|
| CT-A1 Before | 17.684400 / 18.191160 / 18.790605 | 5.375184 | 7.454560 |
| CT-B1 Candidate | 16.845024 / 17.467048 / 17.923573 | 4.626016 | 7.441776 |
| CT-B2 Candidate | 16.910624 / 17.416704 / 18.045152 | 4.638720 | 7.448416 |
| CT-A2 Before | 17.645568 / 18.112072 / 20.056771 | 5.396096 | 7.437568 |

每轮96完整GPU样本，八相位各12帧，无GPU timing truncation。三轮window sensor均1350MHz；A2一次启动sensor为1665MHz，其余1350MHz。温度轨迹Before84–90°C、Candidate85–90°C，soft thermal标签仍变化；未精确控制所有硬件状态。有限whole对两侧Before下降.839376/.734944ms，Temporal下降约.749/.757ms，P95/P99没有观察到退化，Native基本相同。全部尖峰保留，CT-B1 max=21.775648ms，不能把P95/P99改善称无长帧。新dispatch97→98没有删除其他owner的有效工作。

据此通过本候选有限成本入场并原子切production，正式qualification留Phase6。新生产代码只有一个Native owner图，Measure32tile/128lane/34halo、原序Exposure合并、半域R8→Analyze、全部写域/生命周期一致切换；旧64tile Measure和`low_change`/三个尺度四邻域重复消费从production删除。R8、log tiles使用既有FrameGraph transient与completion pool，unique producer标志纳入共同提交证明；缺Pyramid或Shading Change时consumer/提交失败，abort后retry仍用原角色。新Node合同在原生产上失败，保存`missing-producer-before.log`；切换后通过。测试oracle已转为读取fresh `.test-dist`的实际新生产owner/WGSL，before/candidate快照保留test-only，无runtime selector。

项目architecture review核对producer→全部consumer、绑定/limit、barrier、全域写与last-fence retirement后，engine build（含typecheck/declarations）、fresh build:test、Dungeon typecheck、33项targeted Node通过。八个串行实际production GPU oracle全部顶层passed、无GPU/scoped errors：Measure352,882,000字节一致、独立R8存储、Resolve/pull/receiver/共同提交语义、actual Native writer、完整Renderer生命周期/feature/domain、bounded/no-Sun需求、小质量17序列、1080p完整六类×256帧×8ROI矩阵1536帧。矩阵failures=[]，原strictGateFailures诊断和统一门保持。controlled epoch不冒称真实driver fault，synthetic矩阵不冒称真实Dungeon全动态quality。

最终实际`production-dist`无源码替换、`isolatedCandidate=false`，另跑96帧默认Dungeon图：whole raw P50/P95/P99=**16.934352/17.649912/18.728448ms**，Temporal P50=4.638656ms；startup一次1680MHz boost、其余sensor1350MHz，温度82–90°C。API全资源release=0，八相位/角色完整，ShaderChange真实pass/模块存在。人工比较CT-A1/CT-B1静态截图的墙体、细边、阴影与高亮未见明显异常；截图不是同帧HDR差分或完整动态画质资格。

原Cost Card继续适用，额外half R8/log写、更多workgroups与一pass是真实ADD。当前store下限69.0625B/pixel（另加logs/info/weights），高于旧69和返工前68.8125；正常cached GPU graph资源池实际增加1,049,040B，persistent78B/pixel不变。新生产shader六个export剥除注释/空白后与已测候选完全一致，实际production GPU结果另行保存，不拿候选fingerprint替代最终构建。

**当前Temporal观测物理单元出口关闭。** 原V2/LT热混杂不能证明架构证伪，CT有限收益不能证明Phase2–5相对49fc联合净资格。最终P50仍高于16.67，P95也未满足稳定60FPS门，正式≥3块×1000样本、真实Dungeon完整动态质量和OS/4GB驻留未完成；本次停在下一单元边界，未自动进入Native/Sun、Geometry或Phase6正式长窗口。

附件新增：`LT-*`、`CT-*`、`production-dungeon/`、`CT-summary.json`、`production-summary.json`、`production-*.json`、`production-node-tests.log`、`production-build.log`、`production-evidence-manifest.json`、可复算`summarize.mjs`。八个production oracle及九轮新诊断run状态/指纹核对通过；全部新run API teardown=0。production `.test-dist` source SHA256=`4eb238619d6a483ffa58948cfbbc5bb009c7ed809c33ed64c3166d26a8133970`，output=`a3cdac8a9ec5e55e0a1c9d96ee445f8fc9eed25cc9b43000cec12746687cfd00`。

```powershell
# Before使用baseline-cooled-dist；Candidate使用candidate-cooled-dist；新生产使用production-dist。
# 每轮选择新的--out目录，保留全部原raw；GPU作业串行。
node validation/tools/run-dungeon-performance.mjs --dist .local/native-temporal-observation-20261012/production-dist --out .local/native-temporal-observation-20261012/production-dungeon --frames 96 --scenarios full --near --audit --geometry-settled --gpu-sample-interval 1 --observer-mode low-tax --pre-window-temperature 82 --shader-capture
```
