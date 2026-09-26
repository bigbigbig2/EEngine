# EEngine Next 协作规则

目标是高性能 WebGPU Renderer 与现代 3A 画质。当前处于单生产路径的破坏式重建。整体目标见 [架构设计](docs/next-design/eengine-next-overall-architecture-final-2026.md)，实际顺序见 [架构层执行计划](docs/next-execution/eengine-next-architecture-layer-plan-2026.md)，当前模块见 [workstream](project/workstreams/active/eengine-next-clean-rebuild.yaml)。源码是当前实现事实；设计文档是目标，旧 ADR/claim/evidence 不自动证明目标已经实现。

## 开发节奏

1. 用 `node tools/vibe.mjs context <path>` 查询 owner 和文档入口；这是导航命令，不是许可或验证门禁。代码改动前了解相应源码与设计边界即可。
2. 在 currentSlice 内持续编码，直接切换唯一生产路径。旧实现从生产依赖中删除，必要时直接删源文件；Git 历史用于回溯。不建立旧/新 A/B 运行桥梁。
3. 开发中可按调试需要运行 typecheck、build 或单个 targeted test；不要求每批修改执行 `verify --module`、browser、evidence、claim promotion、clean revision、benchmark、workstream exit check 或文档同步。
4. 大模块的原理和生产链连通后，集中运行一次 typecheck、build 与该模块必要的 targeted tests；可显式使用 `node tools/vibe.mjs verify --module --test <OEngine/tests/...test.mjs>`。修明显问题，更新 currentSlice，然后进入下一个模块。未运行的测试必须如实陈述。
5. Next Renderer 的主要架构与计划中的 providers 全部完成后，才做 browser matrix、resize/camera cut/device loss、场景和材质组合、画质对照、GPU P50/P95、正式 evidence 与 claims。`verify --full` 属于这个阶段。

文档用于导航与架构约束，不是编码许可系统。快速变化的 current facts 可以在大模块完成后集中同步。活跃 Next workstream 只维护 currentSlice、goal、nextModules、architectureRules 和 deferredValidation。正式验收细节见 [VALIDATION](docs/VALIDATION.md)；开发时不会因文档、claim、evidence 或未来阶段缺口停工。

## 真正阻塞开发的红线

- 不得恢复 retired legacy renderer/effect owner，且只有一条 production renderer path。
- 不得引入本帧 GPU→CPU→GPU visible/work control，也不得为功能添加独立 frame submit。
- 已固定来源的复杂上游算法不得以少阶段或近似实现冒充完整 port。查完整开源实现、论文和技术资料，固定 revision/许可证，逐项对照源入口、分支、数据依赖、阶段与 WebGPU 差异；确无可移植来源时记录具名本地方案。
- 真实编译失败必须修复。

其他架构设计原则见整体设计。能力与 limit 在创建资源前协商；GPU work 的 producer、consumer、容量和溢出行为必须清楚；Loader 不拥有长期 GPU 资源；Renderer 只作 composition root。具体 ABI 或跨 owner 协议稳定后再写 `docs/specs/`、`docs/contracts/`，无需为中间状态制造文档或伪测试。

## 提交

Commit message 使用中文。标题写明对象与意图，正文写动机、范围和实际验证状态；区分已运行通过与未运行，并说明未运行原因。一个提交承载一个连贯意图。

## 目录

- `docs/next-design/`：目标架构与模块设计；`docs/next-execution/`：人读的执行顺序与切断步骤。
- `project/domains/`：路径 owner；`project/workstreams/active/`：当前模块。
- `docs/domains/`：已实现事实；`docs/contracts/`、`docs/specs/`：稳定合同和 ABI；`docs/porting/`：上游迁移映射。
- `validation/`、`project/claims/`、`checks/`：后期明确调用的验证和声明机制。生成的 registry/evidence/status 不是设计依据。

近目录 `AGENTS.md` 可补充该 owner 的代码约束；任何旧文件中的逐批验证表述均不得覆盖本文件的开发节奏。
