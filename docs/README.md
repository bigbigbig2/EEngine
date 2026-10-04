# EEngine Next 文档入口

当前方向以第三版原文为架构边界，2026-10-04 已准备有界 Surface 前端重构。文档说明目标、执行和源码事实，不是逐批编码许可；准备完成不等于生产代码已重构。

## 从这里开始

1. [第三版最终重构设计](next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)：用户指定原文，后续 Surface/Appearance/Lighting 的唯一目标依据。
2. [最终性能重构设计](next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)、[当前执行计划](next-execution/surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)与[进度/基线](next-execution/surface-work-v3-cost-bounded-final-refactor-progress-2026-10.md)：有界前端、Phase 0–7、源码切换与最终验收。重构前代码为14c17078，Phase 0–2已完成，当前待Phase 3。
3. [整体架构](next-design/eengine-next-overall-architecture-final-2026.md)与[架构层计划](next-execution/eengine-next-architecture-layer-plan-2026.md)：保留系统边界与后续 SSSR/GI/VT/Transparency 方向；Surface 部分服从第三版原文。
4. [当前 workstream](../project/workstreams/active/eengine-next-clean-rebuild.yaml)：当前切片和待完成目标。
5. [方向一致性核对](reviews/surface-work-runtime-v3-direction-alignment-2026-10-02.md)：原文条目到活动入口的映射及本次检查范围。
6. `node tools/vibe.mjs context <path>`：只查询 owner/current docs/Next 入口，不检查编码许可或 claims。

## 文档分层和优先级

| 位置 | 作用 |
| --- | --- |
| 第三版设计原文 | Surface 最终目标；保留原文日期 2026-10-01 和基线 e7296be9，采纳日期为 2026-10-02 |
| next-design/ | 总体目标与有界前端性能实施细化；旧优化页仅记录历史方案 |
| next-execution/ | 当前有界前端执行计划与进度；原V3/优化V1/五步计划标注历史入口 |
| domains/ | 源码现状与缺口；不能用目标代替实现事实 |
| contracts/、specs/ | 稳定跨 owner 协议和 ABI；retired 文档不供新消费者使用 |
| porting/、sources/ | 固定来源、许可、阶段映射和真实 adoption 状态 |
| adr/ | 长期决策和替代关系；[ADR-0021](adr/0021-surface-work-runtime-v3.md) 调整 Surface 目标 |
| reviews/、performance/ | 日期化检查与历史诊断；不是当前设计或性能证明 |

原文与执行摘要冲突时以原文为架构目标；性能物理策略以当前最终设计细化，执行时点以当前计划和根AGENTS为准。源码描述现状，不因文档采纳自动完成。保留的旧优化/五步页只供追溯，不设并行路线。Frame Program、AO、Temporal、VSM保留算法和来源，其历史Surface接口不约束新消费者。

## 开发与验收

当前Surface按每阶段实现、集中检查、通过后推进：Phase0静态基线/消费/容量核对；Phase1–6的typecheck/build、必要语义测试、WGSL及真实GPU组件/接线检查在各阶段完成。只允许阶段内部短暂断链，跨阶段必要consumer前移，不用旧链/占位效果通过检查。已有可运行整链时补短smoke/成本诊断；Phase7负责完整跨场景/浏览器、连续画质和同条件性能正式验收，不再首次发现基础编译/覆盖问题。

本次准备只作源码差异/采样身份、链接、YAML和导航静态核对，并保存代码基线，不运行renderer验证。run06的约801.7ms是已有diagnostic、accepted=false，不是性能通过。其他模块按[VALIDATION](VALIDATION.md)通用节奏；正式evidence/claims留最终验收。
