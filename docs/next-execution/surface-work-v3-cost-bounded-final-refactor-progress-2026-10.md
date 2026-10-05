# Surface V3 有界前端重构执行记录

日期：2026-10-05（Asia/Hong_Kong）。目标见[最终设计](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)，顺序见[执行计划](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)。

## 当前状态

**2026-10-05当前状态：Phase5提交d5783b95、Phase5.5提交7d267d37；Phase6实现与集中检查完成，待中文提交，Phase7正式验收未开始。** 原复审0c8caf30+dirty身份属于历史起点，不是当前HEAD。逐项缺口、责任和门槛见[复审与准备](surface-work-v3-cost-bounded-refactor-review-and-readiness-2026-10.md)。不把短诊断当作正式性能验收。

| 阶段 | 状态 |
|---|---|
| 准备：保存当前代码与文档入口 | 已完成 |
| Phase 0：新协议消费矩阵/物理清单 | 已完成；静态检查通过，见独立Phase 0清单 |
| Phase 1：publication/工作表示 | 既有接线与历史检查保留；dense Workspace/ref迁移尚欠，交5.5补齐。原语义/WGSL/GPU小链和短smoke范围见 [Phase 1记录](surface-work-v3-cost-bounded-final-refactor-phase1-implementation-2026-10.md) |
| Phase 2：geometry/setup/容量 | setup/local/memo与hot/cold真实接线已有检查；lazy witness/预算映射尚欠，交5.5补齐。见 [Phase 2记录](surface-work-v3-cost-bounded-final-refactor-phase2-implementation-2026-10.md) |
| Phase 3：Field候选/验证/proof | candidate/支持域/受理已有检查；dense证书结果尚欠，交5.5补齐。历史45 targeted checks/GPU/smoke范围见 [Phase 3记录](surface-work-v3-cost-bounded-final-refactor-phase3-implementation-2026-10.md) |
| Phase 4：固定Field/Signal层级 | 已完成；52 targeted tests、固定树/parent/provider/source真实GPU组件、两个Store生产链与Showcase短smoke通过；见 [Phase 4记录](surface-work-v3-cost-bounded-final-refactor-phase4-implementation-2026-10.md) |
| Phase 5：worker/发布/重建 | 本次实现/集中检查通过；F08/F09、IOR/coat validity和canonical包含性修复；73 targeted、37 demand/Store/support GPU、20 Lighting+4 provider、27-module六帧与1080p smoke通过；身份/限制见Phase5记录 |
| Phase 5.5：前端物理表示/成本补齐 | 已提交7d267d37；lazy witness、typed结果、formula ref、真实planner、proof/cache满、毒值、parent/tree、reconstruct和1080p timing/detailed已通过；正式性能/质量仍未验收 |
| Phase 6：reset/调度/lifetime | 实现与集中检查完成，待中文提交；87 targeted/build、8帧32poison GPU、10项真实Renderer生命周期及最终无drift/无drop 1080p smoke通过；详见Phase6矩阵 |
| Phase 7：集中验证/性能比较 | 未开始 |

表内历史实现/检查范围不代表此次复审发现的物理表示要求已经实现；这些要求由5.5明确补齐，旧阶段报告不会被回写成当时已经验证。Phase4 Ddirect未factorize原属Phase5，Geometry cold实际append已接通，不能误报为两者都漏接。

2026-10-05本次代码续作覆盖上方复审起点状态：Phase5已按矩阵核对当前producer/consumer并通过集中检查，提交`d5783b95`；Phase5.5实现与集中检查现在同一源码身份通过，待中文提交。详细物理账、GPU矩阵、毒值、proof/cache满、repair迁移和1080p报告见[Phase5.5记录](surface-work-v3-cost-bounded-final-refactor-phase55-implementation-2026-10.md)。短smoke timing GPU pass sum/span/Surface/CPU P50=280.374016/305.376832/269.948416/50.505ms，detailed Surface=275.41536ms；coverage=pass、errors/timestamp/sourceDrift/drop=0。不是Phase7收益或画质验收。固定剩余顺序5.5→6→7。

## 2026-10-05：复审决定与开工准备

本轮Phase6续作覆盖历史复审起点：当前HEAD7d267d37+dirty，选择性reset、stable BG/view/PSO/ordered uniform、setup scratch owner、合法background/reconstruct合并、resize fence/实际retired预算、namespace abort/retry和fresh device恢复完成。最终timing CPU/GPU pass sum/span/Surface P50=32.160/269.392512/276.222976/258.584928ms；detailed Surface270.899904ms，snapshot32.344896ms单列，coverage/API/timestamp/drop/sourceDrift通过。只作为阶段诊断，完整跨浏览器/连续质量/共同能力历史比较留Phase7，未宣称达成总目标。细节与原始失败映射见[Phase6记录](surface-work-v3-cost-bounded-final-refactor-phase6-implementation-2026-10.md)。

- 保留HEAD/dirty Phase5与各次报告的独立身份。撤回“前置缺口已全部补齐”的笼统状态；历史通过项不转授新工作树。
- Phase5先修hash未建立owner却进入unique writer的路径，并检查重复key/碰撞/probe耗尽下writers/key≤1；补真实Field lookup/support四pass计时分类与生产名称覆盖，不能只测旧标签。
- 当前Showcase报告停在初始化frameCount=2、ready=false，无finishedAt或timing/detailed结果；不认定死锁，也不认定smoke通过。定位后完成受影响检查。
- 当前R25536/399tiles/82batches的直接约束为完整656B record套入16MiB geometryHot配额；更正“setup 32MiB限制”的错误归因。当前Demand约3.76MB、planner reserve467,616,704B仅是dirty实现静态账，不是帧时收益。
- Phase5.5集中迁移witness/typed proof结果/ref/预算，验证实际工作量与物理布局；Phase6不承接这些未完成结构改造。完整fine容量、必要hit前witness和原BRDF/guard不得删减。
- 本次只落实文档、导航与检查门槛，未修生产代码，未运行typecheck/build/tests/GPU/browser/benchmark。静态文档检查与源码未变核对单独记录，不称阶段完成。
- 本次准备静态检查通过：13份修改/新增Markdown的本地文件链接无缺失；workstream YAML解析无错误；vibe context已返回Phase5→5.5顺序；git diff --check通过。OEngine/validation共991份版本控制可见文件的组合SHA256保持8721e41a8be7f07e3f12c5f5fc704d8a0ced4dbd4c2ba9699eac0bab7f9e680a，确认未修改已有代码/测试/fixture。

以下Phase0–4段落是日期化历史记录；其中“下一步/未开始”和当时Surface subtotal仅描述当时记录，当前状态以上表为准。此次发现真实pass分类漏项，历史subtotal不作完整Surface成本的重新背书，原报告保持不变。

### 测试与失败修复规则补齐

2026-10-05按用户追加要求，将覆盖矩阵、真实生产入口/独立预期、有效非零workload、正确性与成本分开断言、失败分类/局部修复、禁止弱化断言/测试专用production fallback、最终源码身份复核写入[执行计划§1.4](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md#14-测试可信度失败修复与阶段完成规则2026-10-05-补齐)，同步AGENTS、VALIDATION、workstream、设计和准备清单。VALIDATION中残留的2026-10-02“开发中不测试”规则已删除并注明失效。

此前这些限制分散或缺失，不能声称上次已完整纠正。规则现已落到文档，但当前测试缺口、F08/F09和smoke尚未修复/重跑；阶段状态仍为Phase5实施中。本轮只改文档，不标生产/测试通过，不靠测试规则更新抹除历史不足。

本轮静态检查：14份当前修改/新增Markdown（不含既有porting改动）的本地链接和标题锚点均无缺失；workstream YAML解析通过；六个测试规则入口存在；VALIDATION旧禁测段落已移除；git diff --check通过。OEngine/validation的991份文件组合SHA256与本轮开始相同（8721e41a8be7f07e3f12c5f5fc704d8a0ced4dbd4c2ba9699eac0bab7f9e680a）。未运行代码/GPU检查，因为本轮没有修改生产代码、测试或fixture。

## Phase 1：Publication 与 Surface 工作产品完成

日期：2026-10-04。代码 revision 仍在本次工作树（提交见本轮 commit）；详细范围、实际 layout、未完成后继和验证口径见 [Phase 1实施记录](surface-work-v3-cost-bounded-final-refactor-phase1-implementation-2026-10.md)。

代码完成：DAG-derived execution/cost/domain/signal/proof profiles 与完整 interning token；GPU publication profile metadata；单次 coverage/ActiveTileList、absolute tile/active indirect；ImplicitFine/Uniform/Mixed 模板；constant/default/zero 公式 ref；直接 consumer 及背景写域切换。

检查完成：typecheck/build/build:test；39 项 targeted semantic/oracle tests；真实生成 WGSL 25 modules compilation；production classifier→demand→Geometry→Appearance→Lighting→Store→reconstruct GPU 小链覆盖 constant/empty/mixed/full masks；串行 Showcase 3-frame timing + 1-frame detailed smoke。错误与 device loss 为 0，coverage=pass，sourceDrift=false。

性能只写短诊断：GPU pass sum P50 480.126624ms、Surface P50 469.271904ms，3 samples，不作历史收益或正式目标结论。Phase 2–6、跨浏览器/生命周期/正式性能与 claims 仍未完成。

## Phase 2：Geometry owner 与 bounded setup 完成

日期：2026-10-04。原 2ae78f33 的哈希依赖、同步、memo、hot/cold 与完成证明不足已在本轮实查后补齐；当前真实 local refs/memo/hot-cold 的 GPU 验证通过。不能把本轮修复和检查回写成旧提交已经完成；更正说明见 [Phase 2实施记录](surface-work-v3-cost-bounded-final-refactor-phase2-implementation-2026-10.md)。

## Phase 3：Field 候选、验证与有界证明完成

日期：2026-10-04。完整实现与实际验证见 [Phase 3实施记录](surface-work-v3-cost-bounded-final-refactor-phase3-implementation-2026-10.md)。画像地址/epoch 分域，8-word candidate 与最大 32-word 完整匹配；正式 UV canonical/support/anchor；独立 point/domain/certificate 和 PendingValidation；全部 family 共用 R/2 proof 总账；64 SSA nodes、4 query、32 hierarchy visits、8 punctual risk lights；Unknown/满表仍完成真实 transient/fine 工作，删除 full request scan。补齐 guaranteed local setup、可消费 memo 和唯一 128B hot/按 union cold record。

检查：typecheck/build/build:test、45 targeted tests；Geometry/record/Field/proof 真 GPU 组件；26 module production→HDR 四帧；最终 Showcase timing/detailed complete、coverage=pass、sourceDrift=false、API/GPU/device-loss 错误 0。

最终短诊断（3 samples）：GPU pass sum P50=569.002336ms、Surface=434.887776ms、frame span=645.216480ms；此前同轮成功短诊断约 490/367ms，波动明显。最终性能尚未验收，不能推算为固定收益。画质矩阵、历史同条件比较与正式 claims 尚未运行。Phase 4 未开始。

## Phase 4：固定 Field/Signal 树与来源绑定完成

日期：2026-10-05。实现及验证见 [Phase 4实施记录](surface-work-v3-cost-bounded-final-refactor-phase4-implementation-2026-10.md)。四child固定树、完整DomainKey、parent范围/平面重判、并行source→slot与packed maps；Field来源先于Signal identity，point hit保留fine引用；不同cluster拒绝direct，provider有界共享及cooperative proof总账预留。原pair/member/代表线性搜索已从生产入口删除。

检查：typecheck/build/build:test、13文件52项测试；17个tree/provider、8个parent、10个Field、12个Signal source GPU用例；26 module真实生产链四帧HDR覆盖，warm 16 Field hits/35 Signal hits。Showcase短smoke complete、coverage=pass、sourceDrift=false、GPU/API/device-loss错误0；累计generic counter drop=1，采样detailed的计数/Surface产品完整可用，未称所有计数零。

最终性能与完整质量尚未验收；不以阶段短诊断判断最终目标或V1/V2收益。Phase5未开始。

## 重构前代码身份

- 原HEAD：daaed9c7303a90e1658265e77e5cda02d63921b4。
- 已有dirty代码归档提交：**14c170785505b316c273a8aed0257fe22056b0d3**，标题“Surface V3：固定重构前计时与诊断代码基线”。
- 提交保存15个文件：计时分页、证书生成/selector合并、pipeline cache键、Showcase首帧/采样、测试和diagnostic runners；未新增本设计的渲染算法。
- .local报告与截图未加入Git；其原revision/diff/fingerprints保留。代码commit可复现源码身份，不代表所有本机资产/环境已打包。

## 已有run06诊断摘要（不是本次重新运行）

目录：../../.local/validation/showcase-5173-surface-repair-20261004-run06/。

- 原运行身份：daaed9c7 + 当时dirty；准备时613份源码SHA256均与source-fingerprints.json一致。
- report记录diffSha256：7b90840806da4f16c075a7572791df01fdac7a435ba67316834f82daa3458fa8。
- report记录sourceFingerprintSha256：f37322cf72e450e64bccb8ae78f3ad211007a187e2d007275d7b79f9203eecd9（manifest序列化摘要，不冒充格式化文件字节hash）。
- Dungeon资产SHA256：cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1。
- GTX1650Ti、Chrome154.0.8037.93、1920×1080、overview、AO/FSR3/Bloom开、VSM/jitter关、exposure4。
- timing有效30帧；独立detailed和movement完成；20张截图；report.complete=true、errors=[]、sourceDrift=false、accepted=false。
- GPU pass sum P50=801.730208ms；frame span P50=867.389472ms；Surface P50=790.372640ms；CPU P50=102.405ms。
- 两份classifier约299.8ms、certificate155.5ms、Field/Signal lookup183.7ms；具体口径见设计§2。
- 不证明8.5秒→800ms严格倍数，不证明跨浏览器/连续质量/四版本性能已通过。

## 准备阶段实际操作

1. 核读未提交代码/测试/runner，按用户要求单独提交现有代码基线。
2. 保留最终设计，新增执行计划与本记录。
3. 更新根README/AGENTS、docs入口、活动workstream、owner导航及历史计划指向。
4. 同步当前shading事实，清除已退休SurfaceMaterialCachePass/geometry cache/四路dense history作为“当前入口”的误导。
5. 对文档引用、YAML、diff格式和导航作静态核对；不运行renderer验证。

未运行：typecheck、build、tests、GPU oracle、browser、benchmark、verify。原因：本轮只保存已有代码基线并更新文档，未实施新生产代码；本次未重新运行代码验证。后续重构按用户最新要求每阶段检查，通过后推进，Phase7保留正式整链验收。已有测试文件随基线保存，不声称本次运行通过。

## 下一步与保留风险

下一步按执行计划§8.1先完成Phase5缺陷修复、需求合同与集中检查，再执行必需Phase5.5，之后Phase6/7。不能以已有小链出图、proof受理有界或预算未超限代替物理布局/成本合同检查。不得跳过source/support/overflow/写域合同。

历史约800ms属于重构前诊断；Phase3末短诊断 Surface 约435ms、整帧 pass sum 约569ms；这不是当前Phase4或最终性能验收结论。目标profile和32-batch示例不是实测性能保证。高program数B×P开销、近似误差累积、memo/cold gather收益及retired overlap在最终验收前保持待证状态。

## 2026-10-04 执行节奏修订

用户明确要求收紧阶段检查，避免整链结束后集中暴露大量问题。已统一更新设计、执行计划、AGENTS、文档入口和workstream：阶段内部可临时断链，阶段结束须编译与必要语义/GPU接线检查通过；跨阶段依赖前移真实consumer，不用旧链/占位实现。执行计划§1列出每阶段检查范围及失败处理。该文档修改未开始重构，也未把未运行检查记为通过。

## Phase 0：静态消费与容量核对完成

日期：2026-10-04。开始HEAD=bc2747084f04f758ede7f3240ffff70e52ae21ae，工作树clean，生产基线14c17078。

交付：[Phase 0清单](surface-work-v3-cost-bounded-final-refactor-phase0-inventory-2026-10.md)。记录GPU产品producer/consumer/stride/capacity/initialization/usage/overflow/retire；完整14kind Geometry、15field、6signal矩阵；真实旧layout、最终预算可行例、绑定/共享内存限制、连续域/LOD/Product/形变缺口、源码切换单元及来源。

静态计算本次直接调用现有纯planner，内存加载TS，不写项目build产物：Workspace33741856B、两program Demand22692608B、R23296/90batch；clear范围4.730282GiB。最终512MiB分类合计正确；R65536的ref/map/demand例25.96875MiB，address/proof例28MiB，mandatory结果池可装完整fine。此为容量示例，不是新ABI或GPU性能已验证。

新发现/明确的后继要求：IOR与coat validity当前消费缺口、packet semantic未真实写入；N材质directory不等于P程序数；旧reservedBytes未计retirement重叠；UV2/形变版本非完整能力证据；96B hot不能原样装全部Lighting输入。详见清单，责任阶段已标，不在Phase0改生产算法。

本机冻结：.local/surface-phase0/baseline-identity.json（640份tracked源码/lab指纹与报告字节hash），static-capacity.json、audit-capacity.cjs。run06原613份指纹全部一致，报告/资产身份保留；不改原diagnostic。

来源：在线固定Forge/CPS/OSS与本机源逐字符一致；完整阶段与许可核读，Microsoft固定排序/host/MIT来源复核。论文沿用既有核读，不冒称本次重新读全文；未运行donor/adoption升级。

本阶段检查：纯planner/预算上限静态检查通过；源码身份、consumer/reset/overflow审查完成；文档链接/YAML/diff与vibe导航核对后标Phase0通过。未运行typecheck/build/tests/GPU/browser/benchmark，按执行计划Phase0仅静态范围；Phase1–6所需检查没有预先标通过。

实际命令/结果：node .local/surface-phase0/audit-capacity.cjs（exit0，加载9个纯ABI/planner源码模块，容量断言通过）；Node静态链接/YAML/640文件指纹检查（exit0，missingLinks=[]、yamlErrors=[]、sourceDrift=[]）；31份归档WGSL校验（无hash mismatch）；node tools/vibe.mjs context OEngine/src/render/surface（exit0，当前Phase0完成/待Phase1）；git diff --check（exit0）。原报告613文件与资产/报告字节hash均重新核对。本机详细输出见static-checks.json，不把此静态检查称作typecheck或GPU验证。

下一步：Phase3 Field 候选、验证与受理 proof；本轮按用户范围止于 Phase2。
