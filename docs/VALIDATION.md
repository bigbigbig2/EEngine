# Next Renderer 的检查时机

这是开发节奏说明，不是逐批许可规则。当前工程处于破坏式重建，先让功能原理和唯一生产链真正连通。

**当前 SurfaceWork V3 的用户指定覆盖规则（2026-10-02）**：严格以[第三版原文](next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md) §8–§11 为最终验收依据。Phase 0 先固定基线身份/配置；完整 SurfaceWork、唯一 GeometryRecord、miss-only Appearance、分信号 packets、history/廉价重建和真实接线完成后才在 Phase 7 集中运行编译、数值、覆盖、生命周期、浏览器、连续画质和四版本同条件比较。开发中不跑 typecheck/build、targeted tests、组件 GPU oracle、browser、benchmark 或 verify，不以单个 owner 先闭合为门槛。允许中间缺图/未编译，禁止为验证接回旧 consumer。用户明确诊断另按指令；失败在新主链修复。执行见 [SurfaceWork V3 计划](next-execution/surface-work-runtime-v3-rebuild-2026.md)。本次方向/文档整理可做原文 hash、链接、YAML 和条目一致性检查，不属于 renderer 验证。下面通用时点仅适用于其他模块。

| 时点 | 做什么 | 结果如何使用 |
| --- | --- | --- |
| 日常编码 | `vibe context <path>` 导航；按需要 typecheck、build 或一个 targeted test | 调试信息，不改变能否继续开发 |
| 大模块完成 | 集中运行 typecheck、build、该模块必要的 targeted tests；修明显问题、更新 workstream | 确认该模块的代码闭合，然后继续下一模块；不要求 formal evidence |
| 整体 Next Renderer 完成 | browser matrix、resize、camera cut、device loss、不同场景/材质、feature interactions、画质对照、GPU 性能 P50/P95、formal evidence 与 claims | 形成正式系统验收与声明 |

`node tools/vibe.mjs verify --module` 只能由人或 Agent 在大模块连通后主动调用：它运行引擎 typecheck、build，并仅在显式传入 `--test OEngine/tests/...test.mjs` 时运行该 targeted test。它不加载 claim/case/evidence/registry，不生成正式报告，不检查 clean revision，也不运行浏览器。`verify --module --plan` 只显示命令。旧 `verify --changed` 已退役；`verify --full` 只在最终集成或发布前明确调用。`context` 也不加载验收模型。浏览器未运行、证据缺失、claim 未 accepted、文档暂时滞后或未来模块未完成，均不使普通开发失败。

不要为过渡阶段拼接只验证自己构造结果的伪闭环，也不要为通过旧测试保留 retired production 代码。模块级 targeted test 只覆盖当前确有实现的关键数学、ABI 或边界；真实编译失败需要修复。

最终验收仍必须诚实：正式浏览器记录只来自独立 `validation/` 宿主；诊断 case 不再自动触发仓库 preflight，且不能升级 claim；`case --run --accept` 才要求 `verify --full` 与 clean revision。Surface V3 用独立 checkout 比较 `89f0a94`、`15f12f7b`、`e7296be9` 和最终固定 revision，首要 workload 为 GTX 1650 Ti、1080p 复杂场景，并覆盖原文远/近景、静止/运动、高频材质、IBL/AO/VSM、LOD/page miss 和生命周期矩阵。固定设备、浏览器、内部/输出尺寸、camera path、feature set、warm-up、热状态/时钟、画质和窗口，报告 Surface 全成本及整帧 P50/P95、必要 CPU/内存与原文 counters；不承诺固定 FPS 或百分比。具体 artifact、registry 与 claim 规则保留在 [validation case](contracts/validation-case.md)、[claims/evidence](contracts/claims-and-evidence.md) 和 [browser host](contracts/browser-harness.md) 合同中，只有进入最终验收时才使用。
