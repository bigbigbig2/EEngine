# OEngine 协作约束

OEngine 是面向桌面 WebGPU、中大型高几何密度场景的 GPU-first 渲染引擎。当前重点是 GPU-ready 资产、Packed Instances、层次工作生成、Hardware-first Visibility、单次材质解析以及统一光照和时域管线；不以完整 Gameplay/ECS 或 three.js 兼容为目标。

## 工作流

1. 修改前运行 `node tools/vibe.mjs context <path>`，按输出阅读 domain、contract、ADR/spec 和命中的 case。
2. 修改后运行 `node tools/vibe.mjs verify --changed`；需要查看声明和证据时运行 `node tools/vibe.mjs status`、`node tools/vibe.mjs evidence`。
3. 机器事实只编辑 `project/`、`checks/`、case-local `case.yaml`、docs frontmatter/source ledger 和 workstream；`validation/registry.generated.json`、`validation/evidence/` 与 `docs/status.generated.md` 是生成物。

## 不可违反的不变量

- GPU producer 必须由 GPU consumer 闭环消费；CPU 可读回仅用于诊断或异步调度反馈。
- 每条 GPU 队列都声明元素 ABI、容量、溢出行为、生产者、消费者和计数器。
- Runtime Asset、Product、GPU 资源表和 Loader 临时对象分离，Loader 不拥有长期 GPU 资源。
- Renderer 是 composition root；不得全量扫描对象构建最终可见列表，也不得扩张完整 Gameplay 生命周期。
- 所有渲染功能使用一条统一主管线；关闭 feature 时不保留无消费者 Pass、资源、readback 或 submit。
- WebGPU capability/limit/feature 先协商再创建资源；Draft 能力、64 位原子、mesh/task shader、BDA 和 multi-draw 不得默认启用。
- ABI、二进制、shader layout、状态机和 owner 边界进入 `docs/specs/` 或 `docs/contracts/`，并有对应 contract/oracle 验证。
- Nyx 迁移必须保留源函数/entry point、决策条件、数据依赖、不变量、差异、fallback 和验证映射；未完成对照不得宣称完成。
- Browser validation 只在独立 `validation/` 宿主运行；examples/Storybook 不产生 Runtime Validated、Performance 或 Pipeline 完成声明。
- Claim 状态只由当前 revision 的 evidence 推导；clean revision、完整 gate 或正式 PERF 证据不足时，声明等级不得升级。

## 目录所有权

- `project/domains/` 路由文件和 primary owner；`project/claims/` 声明；`checks/` 检查；`project/workstreams/active/` 活跃切片。
- `docs/domains/` 当前事实，`docs/contracts/` 精确跨 owner 合同，`docs/adr/` 长期取舍，`docs/specs/` ABI/格式，`docs/sources/` 外部来源账本。
- `OEngine/tests/unit|contract|oracle|guard/` 按证明性质分类；`validation/cases/<id>/` 是自动 case，`validation/labs/<id>/` 是显式观察实验；共享生命周期由 `validation/harness/` 拥有。

详细约束进入近目录 `AGENTS.md`、manifest、contract、spec 和 `docs/VALIDATION.md`。改动不得把生成物、历史日志或未提升的研究资料当作设计权威。
