# EEngine Next 文档入口

当前是破坏式重建。文档负责说明目标架构、实施顺序与已实现事实；不负责逐批批准编码。

## 从这里开始

1. [整体架构设计](next-design/eengine-next-overall-architecture-final-2026.md)：目标系统、长期边界、性能和质量原则。保留完整设计深度。
2. [架构层执行计划](next-execution/eengine-next-architecture-layer-plan-2026.md)：第一层切断、Frame Program、Surface v2、Fuse/按需物化字段与 XeGTAO、Temporal、VSM 等实施顺序和模块完成点。
3. [当前 workstream](../project/workstreams/active/eengine-next-clean-rebuild.yaml)：唯一活跃模块与紧随其后的模块。
4. `node tools/vibe.mjs context <path>`：查询路径 owner、对应 current docs 和上述 Next 入口。该命令只导航，不检查 claim/evidence/browser 状态。

当前模块 A 的独立文档：[Frame Program 设计](next-design/frame-program-module-a.md)与[Frame Program 执行步骤](next-execution/frame-program-module-a.md)。两份文档描述目标和待实施步骤，当前源码事实仍以 `docs/domains/` 与代码为准。

## 文档分层

| 位置 | 作用 | 更新时点 |
| --- | --- | --- |
| `next-design/` | 整体目标和进入开发的模块设计 | 决策变化时 |
| `next-execution/` | 顺序、直接切断、文件/owner、依赖和完成点 | 模块计划或顺序变化时 |
| `domains/` | 当前源码事实，不自动代表最终设计 | 大模块完成后集中同步 |
| `contracts/`、`specs/` | 已稳定的跨 owner 协议、ABI、格式 | 对应边界稳定后 |
| `porting/`、`sources/` | 上游来源、许可、源与本地阶段映射 | 选择 donor 或完成移植时 |
| `adr/` | 长期历史决策及被取代的理由 | 真正改变决策时 |
| `reviews/`、`performance/` | 日期化观察与诊断，供追溯 | 需要记录时 |

旧阶段概要已从活动文档树删除，可在 Git 历史查阅。ADR 和 review 只提供历史与源码线索。若与整体 final 设计及当前执行计划冲突，以后两者为当前目标；若与运行代码冲突，代码描述“现状”，文档描述“目标”，不能把任一方伪称为已完成。

## 开发与验收

开发者在 currentSlice 内持续实现。typecheck、build、targeted test 可用于调试；在大型模块完整连入生产路径后集中检查一次。不要为每批改动运行 `verify --module`、浏览器矩阵、formal evidence、claim promotion 或性能基准。系统验收留到主要架构和 planned providers 完成之后，详见 [验证时机](VALIDATION.md)。

独立的 `project/claims/`、`checks/` 与 `validation/` 是最终验收基础设施；它们不参与日常 `context` 和是否允许继续编码的判断。删除旧 production 路径不要求维护运行中的旧链作桥梁。变更历史由 Git 保存。
