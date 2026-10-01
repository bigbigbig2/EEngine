# Next Renderer 的检查时机

这是开发节奏说明，不是逐批许可规则。当前工程处于破坏式重建，先让功能原理和唯一生产链真正连通。

**当前 Surface 的用户指定覆盖规则（2026-10-01）**：缓存、稀疏照明和重建整体实现完成后才统一跑验证。开发中不跑 typecheck/build、targeted tests、组件 GPU oracle、browser、benchmark 或 verify；不要求 S1/S2 或某个 owner 先闭合、测试通过才能继续。直接删除旧 Surface 路径，允许中间缺图和未编译，禁止为了验证接回旧 consumer。后续用户明确要求的诊断按该次指令执行。最终编译失败、数学/覆盖/生命周期错误和性能不达标均在新主链修复。范围、顺序和验收项目见 [Surface 执行计划](next-execution/surface-cached-shading-rebuild-2026.md)。下面的通用检查时点适用于其他模块，不覆盖本条。

| 时点 | 做什么 | 结果如何使用 |
| --- | --- | --- |
| 日常编码 | `vibe context <path>` 导航；按需要 typecheck、build 或一个 targeted test | 调试信息，不改变能否继续开发 |
| 大模块完成 | 集中运行 typecheck、build、该模块必要的 targeted tests；修明显问题、更新 workstream | 确认该模块的代码闭合，然后继续下一模块；不要求 formal evidence |
| 整体 Next Renderer 完成 | browser matrix、resize、camera cut、device loss、不同场景/材质、feature interactions、画质对照、GPU 性能 P50/P95、formal evidence 与 claims | 形成正式系统验收与声明 |

`node tools/vibe.mjs verify --module` 只能由人或 Agent 在大模块连通后主动调用：它运行引擎 typecheck、build，并仅在显式传入 `--test OEngine/tests/...test.mjs` 时运行该 targeted test。它不加载 claim/case/evidence/registry，不生成正式报告，不检查 clean revision，也不运行浏览器。`verify --module --plan` 只显示命令。旧 `verify --changed` 已退役；`verify --full` 只在最终集成或发布前明确调用。`context` 也不加载验收模型。浏览器未运行、证据缺失、claim 未 accepted、文档暂时滞后或未来模块未完成，均不使普通开发失败。

不要为过渡阶段拼接只验证自己构造结果的伪闭环，也不要为通过旧测试保留 retired production 代码。模块级 targeted test 只覆盖当前确有实现的关键数学、ABI 或边界；真实编译失败需要修复。

最终验收仍必须诚实：正式浏览器记录只来自独立 `validation/` 宿主；诊断 case 不再自动触发仓库 preflight，且不能升级 claim；`case --run --accept` 才要求 `verify --full` 与 clean revision。正式性能比较需固定 workload、设备、浏览器、分辨率、画质和采样窗口，并报告 GPU P50/P95 与 CPU 提交成本。具体 artifact、registry 与 claim 规则保留在 [validation case](contracts/validation-case.md)、[claims/evidence](contracts/claims-and-evidence.md) 和 [browser host](contracts/browser-harness.md) 合同中，只有进入最终验收时才使用。
