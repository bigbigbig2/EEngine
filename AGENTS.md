# OEngine 协作约束

OEngine 是面向桌面 WebGPU、中大型高几何密度场景的 GPU-first 渲染引擎。Next 目标是 GPU-ready 资产、Packed Instances、层次 GPU Work、Hardware-first Visibility、Visibility-driven Surface、按需求和频率着色、统一 Light Transport 与 Temporal Reconstruction；当前生产链的实现事实仍由 `docs/domains/` 和当前 claim 描述。不以完整 Gameplay/ECS 或 three.js 兼容为目标。

## 工作流

1. 修改前运行 `node tools/vibe.mjs context <path>`，按精简输出阅读 owner、contract、入口和建议检查；只有需要展开时才加 `--claims`、`--cases` 或 `--all`。
2. 在 currentSlice 内连续编码。typecheck、build、targeted test 可按调试需要主动运行；大模块完成时集中运行一次 typecheck、build 和该模块必要的 targeted tests，并更新 currentSlice。`verify --changed` 仅是主动使用的模块检查，`verify --full` 留到最终集成。
3. 机器事实只编辑 `project/`、`checks/`、case-local `case.yaml`、docs frontmatter/source ledger 和 workstream；`validation/registry.generated.json`、`validation/evidence/` 与 `docs/status.generated.md` 是生成物。检查的执行体在 `tools/check-runners.mjs`：声明式 YAML 只描述断言，新增检查必须绑定已注册的 `runner`。
4. 文档用于导航和架构约束。快速变化的实现可在大模块完成后同步；活跃 workstream 只维护 currentSlice、goal、nextModules、architectureRules 和 deferredValidation。

## 实现阶段与收口阶段

当前处于高速破坏式重建时，Coding Agent 在 currentSlice 内连续实现，不要求每个修改批次运行 `verify --changed`、浏览器、evidence、claim promotion、clean revision、benchmark、workstream exit check 或文档同步。日常只用 `node tools/vibe.mjs context <path>` 导航，必要时主动运行 typecheck、build 或 targeted test。

只有大型功能模块完成时才集中检查一次：typecheck、build、该模块 targeted tests，并更新 currentSlice。整个 Next Renderer 的主要架构和 planned providers 完成后，再集中做 browser matrix、lifecycle、质量和性能验证。

开发阶段真正可阻塞实现的只有：恢复 retired legacy owner、建立双 production path、引入 current-frame GPU 到 CPU 到 GPU work control、增加独立 submit、对 pinned 算法写近似实现冒充完整 port，以及真实编译失败。文档/evidence/claim/future phase 缺口不得阻止继续编码。

`node tools/vibe.mjs verify --changed` 是可选的模块检查，不是日常默认门禁；browser 未运行、evidence 缺失或 claim 未 accepted 不会使普通开发失败。`verify --full` 只在最终集成或发布前执行。正式 evidence 和 claim 仍须真实验证，不能从开发检查结果推断。

## 提交约定

- Commit message 一律使用中文。标题写清改动的对象与意图，正文说明动机、影响范围和验证状态；不写「更新」「修复」「优化」这类无信息量的单句。
- 一个提交只承载一个连贯意图。跨 owner 或彼此独立的改动拆成多个提交，便于回溯与二分定位。
- 正文必须区分「已运行且通过」与「未运行」的验证，并写明未运行的原因；未运行的门禁不得写成已通过。

## 不可违反的不变量

- GPU producer 必须由 GPU consumer 闭环消费；CPU 可读回仅用于诊断或异步调度反馈。
- 每条 GPU 队列都声明元素 ABI、容量、溢出行为、生产者、消费者和计数器。
- Runtime Asset、Product、GPU 资源表和 Loader 临时对象分离，Loader 不拥有长期 GPU 资源。
- Renderer 是 composition root；不得全量扫描对象构建最终可见列表，也不得扩张完整 Gameplay 生命周期。
- 所有渲染功能使用一条统一主管线；关闭 feature 时不保留无消费者 Pass、资源、readback 或 submit。
- WebGPU capability/limit/feature 先协商再创建资源；Draft 能力、64 位原子、mesh/task shader、BDA 和 multi-draw 不得默认启用。
- ABI、二进制、shader layout、状态机和 owner 边界进入 `docs/specs/` 或 `docs/contracts/`，并有对应 contract/oracle 验证。
- 复杂算法和渲染效果实施前先查 GitHub 完整开源实现及可核验的论文、详细技术文章；优先迁移固定 revision 的完整源码，跨语言可移植。移植须逐项对照源入口、决策条件、数据依赖、阶段、不变量、WebGPU 差异与验证，不能以自写简化版、少阶段版本或同名近似效果冒充完成。确无完整可移植来源时，先在 `docs/porting/` 记录检索范围、缺口和具名本地方案。简单确定性工具、ABI 编解码、WebGPU 绑定和生命周期接线不强制外部调研，但要按本地代码验证并不得冒称上游算法；不能以拆小任务为由豁免一个复杂算法。
- Nyx 迁移必须保留源函数/entry point、决策条件、数据依赖、不变量、差异、fallback 和验证映射；未完成对照不得宣称完成。
- Browser validation 只在独立 `validation/` 宿主运行；examples/Storybook 不产生 Runtime Validated、Performance 或 Pipeline 完成声明。
- Claim 状态只由当前 revision 的 evidence 推导；clean revision、完整 gate 或正式 PERF 证据不足时，声明等级不得升级。

## 目录所有权

- `project/domains/` 路由文件和 primary owner；`project/claims/` 声明；`checks/` 检查；`project/workstreams/active/` 活跃切片。
- `docs/domains/` 当前事实，`docs/contracts/` 精确跨 owner 合同，`docs/adr/` 长期取舍，`docs/specs/` ABI/格式，`docs/sources/` 外部来源账本。
- `OEngine/tests/unit|contract|oracle|guard/` 按证明性质分类；`validation/cases/<id>/` 是自动 case，`validation/labs/<id>/` 是显式观察实验；共享生命周期由 `validation/harness/` 拥有。

详细约束进入近目录 `AGENTS.md`、manifest、contract、spec 和 `docs/VALIDATION.md`。改动不得把生成物、历史日志或未提升的研究资料当作设计权威。
