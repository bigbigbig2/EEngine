# Surface V3 有界前端重构执行记录

日期：2026-10-04（Asia/Hong_Kong）。目标见[最终设计](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)，顺序见[执行计划](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)。

## 当前状态

**Phase 0、Phase 1、Phase 2 已完成并通过各自检查；当前停在 Phase 2，未进入 Phase 3。** 不把短诊断当作正式性能验收。

| 阶段 | 状态 |
|---|---|
| 准备：保存当前代码与文档入口 | 已完成 |
| Phase 0：新协议消费矩阵/物理清单 | 已完成；静态检查通过，见独立Phase 0清单 |
| Phase 1：publication/工作表示 | 已完成；代码、语义测试、WGSL/GPU 小链与 Showcase 短 smoke 通过；实现记录见 [Phase 1记录](surface-work-v3-cost-bounded-final-refactor-phase1-implementation-2026-10.md) |
| Phase 2：geometry/setup/容量 | 已完成；固定 64-key setup、local/memo 分离、唯一 GeometryRecord 接线、语义测试与真实 GPU 小链通过；实现记录见 [Phase 2记录](surface-work-v3-cost-bounded-final-refactor-phase2-implementation-2026-10.md) |
| Phase 3：Field候选/验证/proof | 未开始 |
| Phase 4：固定Field/Signal层级 | 未开始 |
| Phase 5：worker/发布/重建 | 未开始 |
| Phase 6：reset/调度/lifetime | 未开始 |
| Phase 7：集中验证/性能比较 | 未开始 |

## Phase 1：Publication 与 Surface 工作产品完成

日期：2026-10-04。代码 revision 仍在本次工作树（提交见本轮 commit）；详细范围、实际 layout、未完成后继和验证口径见 [Phase 1实施记录](surface-work-v3-cost-bounded-final-refactor-phase1-implementation-2026-10.md)。

代码完成：DAG-derived execution/cost/domain/signal/proof profiles 与完整 interning token；GPU publication profile metadata；单次 coverage/ActiveTileList、absolute tile/active indirect；ImplicitFine/Uniform/Mixed 模板；constant/default/zero 公式 ref；直接 consumer 及背景写域切换。

检查完成：typecheck/build/build:test；39 项 targeted semantic/oracle tests；真实生成 WGSL 25 modules compilation；production classifier→demand→Geometry→Appearance→Lighting→Store→reconstruct GPU 小链覆盖 constant/empty/mixed/full masks；串行 Showcase 3-frame timing + 1-frame detailed smoke。错误与 device loss 为 0，coverage=pass，sourceDrift=false。

性能只写短诊断：GPU pass sum P50 480.126624ms、Surface P50 469.271904ms，3 samples，不作历史收益或正式目标结论。Phase 2–6、跨浏览器/生命周期/正式性能与 claims 仍未完成。

## Phase 2：Geometry owner 与 bounded setup 完成

日期：2026-10-04。固定 64-key bitonic/run leader、完整 local setup capacity、独立 bounded memo、SetupRef-only consumer、Geometry input union/hot depth 及实际 allocation 账已接入。真实 phase2-geometry GPU 小链通过；详细范围与限制见 [Phase 2实施记录](surface-work-v3-cost-bounded-final-refactor-phase2-implementation-2026-10.md)。

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

Phase0消费矩阵/真实buffer账已补齐并核对，下一步按计划Phase1–6逐阶段实施、检查并通过后推进。不得跳过source/support/overflow/写域合同。

现有约800ms问题尚未修复；setup实际fallback量、probe流量、proof成本等仍缺完整counter。目标profile和32-batch示例不是实测性能保证。高program数B×P开销、近似误差累积、memo/cold gather收益及retired overlap在最终验收前保持待证状态。

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
