---
id: validation
state: current
verifies:
  - checks
  - validation
---
# Next Renderer 的检查时机与失败修复

这是开发节奏说明，不是逐批许可规则。当前工程处于破坏式重建，先让功能原理和唯一生产链真正连通。

**当前SurfaceWork V3覆盖规则（2026-10-05修订）**：此前2026-10-02“开发中不测试、整链结束才检查”的规则已被用户要求替代，不再生效。总架构/质量以[第三版原文](next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)为准；当前执行唯一入口是[有界前端执行计划](next-execution/surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)。Phase0做静态身份/容量核对；Phase1–6（含必需5.5）每阶段完成typecheck/build、新鲜targeted tests、涉及的WGSL与真实GPU producer→consumer检查，已有整链时补短smoke/成本诊断，通过后推进。Phase7保留正式整合、跨浏览器/完整生命周期/连续画质和同条件历史性能。按需调试，不要求每patch全测。

当前顺序为Phase5先修唯一writer/计时覆盖并完成需求合同→Phase5.5前端物理表示与成本补齐→Phase6调度/reset/lifetime→Phase7。阶段内可以临时断链，结束必须真实闭合，不接旧consumer或占位值来通过。当前事实与历史结果见[执行记录](next-execution/surface-work-v3-cost-bounded-final-refactor-progress-2026-10.md)。

## Surface 测试可信度与修复边界

完整规范见[执行计划§1.4](next-execution/surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md#14-测试可信度失败修复与阶段完成规则2026-10-05-补齐)，覆盖矩阵在各阶段实施记录维护，日常不增加逐patch许可表。

- 对照设计逐项列producer/产品/全部consumer、正常/边界/拒绝用例、独立预期和实际结果；测试全绿不代替实施范围核对。缺必需实现或用例、未运行检查，均不能标阶段完成。
- 真实GPU接线检查调用当前生成shader和生产consumer，先证明有效非零workload/目标分支真的执行；mock或手写模拟链只能证明其局部范围。独立参考不能复制被测输出，普通合法cache/coarse成功和局部失败必须可区分。
- 正确性、结构和成本分别检查：完整身份、独立依赖、发布/生命周期、完整互斥覆盖；以及实际witness/proof/ref/worker写入、真实allocation限制、编码和计时分类。删除/按需/compact的目标要有实际证据，不能只断言预算未超或画面非空。
- 失败先保留日志/身份，再复现、分类、定位和局部修复，重跑原用例及关联回归。旧ABI/fixture错误修测试宿主并保留仍有效语义；生产错误修权威边界；不得为了mock或旧测试反向改架构。
- 禁止靠删/skip断言、吞异常、放宽容差、关feature/缩小最终workload、永久fine/residual、额外owner/submit或测试专用production fallback过关。改变功能、质量、误差预算或阶段范围需用户认可；改测试预期需独立依据和回归敏感性检查。
- 未完成runner/超时/不可用计时不是通过；定位实际停顿/退出边界，不靠只加超时掩盖。历史报告保持身份；最终代码改动后更新build并重跑受影响验证，不能拼接快照。GPU任务串行。

这些要求防止可发现遗漏和未经定位的修复，不承诺测试能穷尽全部问题。阶段检查不提前要求正式evidence/claim/clean revision；已有必需失败不能借正式验收在Phase7就略过。

## 其他模块的通用节奏

| 时点 | 做什么 | 结果如何使用 |
| --- | --- | --- |
| 日常编码 | `vibe context <path>` 导航；按需要 typecheck、build 或一个 targeted test | 调试信息，不改变能否继续开发 |
| 大模块完成 | 集中运行 typecheck、build、该模块必要的 targeted tests；修明显问题、更新 workstream | 确认该模块的代码闭合，然后继续下一模块；不要求 formal evidence |
| 整体 Next Renderer 完成 | browser matrix、resize、camera cut、device loss、不同场景/材质、feature interactions、画质对照、GPU 性能 P50/P95、formal evidence 与 claims | 形成正式系统验收与声明 |

`node tools/vibe.mjs verify --module` 只能由人或 Agent 在大模块连通后主动调用：它运行引擎 typecheck、build，并仅在显式传入 `--test OEngine/tests/...test.mjs` 时运行该 targeted test。它不加载 claim/case/evidence/registry，不生成正式报告，不检查 clean revision，也不运行浏览器。`verify --module --plan` 只显示命令。旧 `verify --changed` 已退役；`verify --full` 只在最终集成或发布前明确调用。`context` 也不加载验收模型。浏览器未运行、证据缺失、claim 未 accepted、文档暂时滞后或未来模块未完成，均不使普通开发失败。

不要为过渡阶段拼接只验证自己构造结果的伪闭环，也不要为通过旧测试保留 retired production 代码。模块级 targeted test 只覆盖当前确有实现的关键数学、ABI 或边界；真实编译失败需要修复。

最终验收仍必须诚实：正式浏览器记录只来自独立 `validation/` 宿主；诊断 case 不再自动触发仓库 preflight，且不能升级 claim；`case --run --accept` 才要求 `verify --full` 与 clean revision。Surface V3按当前执行计划用独立checkout比较 `89f0a94`、`15f12f7b`、`e7296be9`、重构前 `14c17078` 和最终固定revision，共同能力子集与最终完整功能分列。首要workload为GTX1650Ti、1080p复杂场景，并覆盖原文远/近景、静止/运动、高频材质、IBL/AO/VSM、LOD/page miss和生命周期矩阵。固定设备、浏览器、内部/输出尺寸、camera path、feature set、warm-up、热状态/时钟、画质和窗口，报告Surface全成本及整帧P50/P95、必要CPU/内存与原文counters；不承诺固定FPS或百分比。具体artifact、registry与claim规则保留在[validation case](contracts/validation-case.md)、[claims/evidence](contracts/claims-and-evidence.md)和[browser host](contracts/browser-harness.md)合同中，正式接受/声明流程只在最终验收使用，不代替阶段真实GPU检查。
