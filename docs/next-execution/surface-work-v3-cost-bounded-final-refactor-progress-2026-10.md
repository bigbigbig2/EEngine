# Surface V3 有界前端重构执行记录

日期：2026-10-04（Asia/Hong_Kong）。目标见[最终设计](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)，顺序见[执行计划](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)。

## 当前状态

**准备完成；新重构生产代码未开始。** 不把前一轮五步修复或本次文档切换算成新Phase完成。

| 阶段 | 状态 |
|---|---|
| 准备：保存当前代码与文档入口 | 已完成 |
| Phase 0：新协议消费矩阵/物理清单 | 身份已固定；完整矩阵和物理清单待实施时补齐 |
| Phase 1：publication/工作表示 | 未开始 |
| Phase 2：geometry/setup/容量 | 未开始 |
| Phase 3：Field候选/验证/proof | 未开始 |
| Phase 4：固定Field/Signal层级 | 未开始 |
| Phase 5：worker/发布/重建 | 未开始 |
| Phase 6：reset/调度/lifetime | 未开始 |
| Phase 7：集中验证/性能比较 | 未开始 |

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

开始实际重构时补齐并核对Phase0消费矩阵/真实buffer账，再按计划Phase1–6逐阶段实施、检查并通过后推进。不得跳过source/support/overflow/写域合同。

现有约800ms问题尚未修复；setup实际fallback量、probe流量、proof成本等仍缺完整counter。目标profile和32-batch示例不是实测性能保证。高program数B×P开销、近似误差累积、memo/cold gather收益及retired overlap在最终验收前保持待证状态。

## 2026-10-04 执行节奏修订

用户明确要求收紧阶段检查，避免整链结束后集中暴露大量问题。已统一更新设计、执行计划、AGENTS、文档入口和workstream：阶段内部可临时断链，阶段结束须编译与必要语义/GPU接线检查通过；跨阶段依赖前移真实consumer，不用旧链/占位实现。执行计划§1列出每阶段检查范围及失败处理。该文档修改未开始重构，也未把未运行检查记为通过。
