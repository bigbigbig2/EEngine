# EEngine Next 协作规则

目标是极致 GPU 性能与现代 AAA 画质，首要运行目标为 GTX 1650 Ti、1080p 复杂场景。当前处于单生产路径的破坏式重建，方向由 [极致性能重建设计](docs/next-design/eengine-extreme-performance-rebuild-2026-10.md) 统一：它取代此前的 V3 原文、有界前端设计与优化 V1 设计（均已归档至 `docs/archive/`，只供追溯）。执行顺序见 [重建执行计划](docs/next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md)，当前模块见 [workstream](project/workstreams/active/eengine-next-clean-rebuild.yaml)。源码是当前实现事实；文档采纳不证明实现、性能、claim 或来源 adoption 已完成。

## 开发节奏

1. 用 `node tools/vibe.mjs context <path>` 查询 owner 和文档入口；这是导航命令，不是许可或验证门禁。代码改动前了解相应源码与设计边界即可。
2. 在 currentSlice 内持续编码，直接切换唯一生产路径。旧实现从生产依赖中删除，必要时直接删源文件；Git 历史用于回溯。不建立旧/新 A/B 运行桥梁。
3. 开发中可按调试需要运行 typecheck、build 或单个 targeted test；不要求每批修改执行 `verify --module`、browser、evidence、claim promotion、clean revision、benchmark、workstream exit check 或文档同步。
4. 大模块的原理和生产链连通后，集中运行一次 typecheck、build 与该模块必要的 targeted tests；可显式使用 `node tools/vibe.mjs verify --module --test <OEngine/tests/...test.mjs>`。修明显问题，更新 currentSlice，然后进入下一个模块。未运行的测试必须如实陈述。
5. Next Renderer 的主要架构与计划中的 providers 全部完成后，才做 browser matrix、resize/camera cut/device loss、场景和材质组合、画质对照、GPU P50/P95、正式 evidence 与 claims。`verify --full` 属于这个阶段。

### 重建执行覆盖规则

本次重建按**切换单元**推进，每个单元实现与集中检查通过后进入下一个。完整顺序与退出条件见[重建执行计划](docs/next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md)。

单元：**A0** 测量口径与基线 → **A1** FrameGraph 执行器 → **B1** 域实体竖切（可行性门）→ **B2** 域/率全面替换 → **C** 材质分类与信号复用 → **D** Geometry 完整工作域 → **E** Lighting/Shadow 极端路径 → **F** Temporal/Post 收口。

阶段内部允许短暂编译失败/无图/consumer 未接通，但单元结束必须修复编译错误并验证本单元真实 producer→consumer。跨单元必要接线前移，不用旧链、adapter、占位效果或空 consumer 通过检查；替换 producer 与直接 consumer 作为同一切换单元，仅保留一条生产路径。

**三条架构不变量每个单元都要过**（见设计母稿 §3.1）：命令数与场景复杂度解耦、管理成本不超过实际计算成本、复用层关掉后仍正确且同量级。

只复用最终架构需要的数学、资源 owner 和 GPU 产品，删除旧协调器及无消费者依赖，不为旧测试修改新架构。Winner/Sharing/Cache identity 分开；cache lookup 在 material miss compact 前，命中字段不重跑其 geometry/material heavy work，其他 dirty consumer 仍可请求唯一 record；Appearance/Lighting 只消费唯一 GeometryRecord；reconstruct 不重新执行完整几何、材质或 PBR。最终 bounded full-rate exception、身份失效和写域互斥集中在权威生产/发布边界保证，热 consumer 不重复检查已保证的不变量。具体删除顺序与范围见[重建执行计划](docs/next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md)。此覆盖规则优先于近目录和历史计划中的逐阶段检查要求。

**阶段状态不在本文件维护。** 本文件此前记录"Phase4 HEAD 0c8caf30，另有未提交 Phase5 实现，当前未收口"——HEAD 早已是 Phase 7 提交，这条文字一直是错的，而它正是 agent 读到的第一条状态。当前阶段只有一个权威来源：[workstream 的 currentSlice](project/workstreams/active/eengine-next-clean-rebuild.yaml) 与[进度文档](./docs/next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md)。任何入口文件都不得复制阶段状态。

**仍然有效的长期约束**（与阶段无关，不随阶段推进失效）：

- 重构前基线 14c17078。Phase 0–4 的接线与历史检查保留，但 lazy witness、dense certificate/ref 和预算映射尚未全部落实；不声称"前置缺口全部补齐"。
- 每阶段检查规则适用于全部 Surface 阶段。Phase 5.5 另要求实际工作量/存储与设计约束相符，不能只凭小链出图或不超预算通过。
- 布局变化所需的直接 consumer/reset/binding 随 producer 前移，不等后续阶段返工。
- 不承接已知基础缺陷进入最终验收阶段。
- CandidateKey、ValueWitness、SharingCertificate 分开；不以所有未知材质永久 fine、裁剪 key、截断证明或漏工作换性能。

**文档合同**：`docs/**` 每份文档必须以 frontmatter 声明 `state`（`generated` / `current` / `history`），由 `node tools/docs-verify.mjs` 强制。`current` 必须声明 `verifies.files`（可证伪条件）；`history` 不得被入口点当作当前依据引用。改动 `docs/` 后必须运行该命令。禁止把阶段状态或源码事实抄进入口文件——这类复制是本仓库文档漂移的主要来源。

### Surface 阶段测试与失败修复规则（2026-10-05 补齐）

详细执行合同为[当前执行计划§1.4](./docs/next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md#14-测试可信度失败修复与阶段完成规则2026-10-05-补齐)，适用于后续全部Surface阶段（含5.5）。不能只以测试数量、出图或预算未超限判断阶段完成。

1. 阶段实施前列设计任务、复审缺口和不变量；收口时逐项核对真实producer→产品→全部consumer、正常/边界/失败用例、独立预期、结构/成本检查和本次结果。必需项遗漏、未测或无consumer，阶段就未完成；不把遗漏改名为可选优化或悄悄后移。
2. 测试调用当前生产入口/生成WGSL/真实GPU链，数值与覆盖预期有独立依据；mock、源码正则、归档shader、小fixture和预填正确结果不证明生产算法完成。先证明被测分支确实执行，Lighting有非零有效provider，cache/coarse有普通合法成功与局部拒绝用例，不能永久fine/miss过关。
3. 正确性与成本分开检查：完整身份/失效、独立closure、发布前后、pin/generation、同key唯一Store writer、完整互斥写域，以及实际witness/proof/ref/hot-cold产量与allocation/编码/计时覆盖。声称删除或按需的工作必须真实消失或随相应需求增长，不能只缩counter。容量减少不等于帧时收益。
4. 失败按“保存原始失败→最小复现/核对预期→分类定位→局部修复→原用例和关联回归”处理。先区分生产错误、旧ABI测试、fixture/harness、环境和未完成runner；无法定位则如实未通过，不能因为改到绿就认定根因。
5. 禁止为过关删/跳过必需断言、吞异常、放宽容差、关feature/缩小最终场景、永久fine/residual或加测试专用production fallback。旧测试只按退休合同迁移，仍有效的语义断言必须保留并映射到新入口；不为mock缺API乱接生产资源/owner，不在热consumer补重复decode/guard，不恢复旧链或第二submit。
6. 测试预期修改必须给出设计/来源/独立数学依据；功能、质量、误差预算或阶段范围确需改变时先取得用户认可。回归需能区分原缺陷与正确行为，缺少旧版复现时记录原因并用独立参考/fixture受控故障检查敏感性，不在生产加故障开关。
7. 收口再审当前diff与设计覆盖，使用新鲜build:test；最终源码变动后重跑受影响验证，不能拼接不同快照的通过结果。超时/不完整报告、skip/不可用timestamp单列，零API错误不代替结果断言；GPU作业串行。阶段必须同时通过实现核对、正确性/接线与结构/成本检查，正式历史收益仍留Phase7。

上述是阶段收口责任，不要求每patch全测或clean revision/evidence/claim门禁。文档用于导航与架构约束，不是编码许可系统。快速变化的 current facts 可以在大模块完成后集中同步。活跃 Next workstream 只维护 currentSlice、goal、nextModules、architectureRules 和 deferredValidation。正式验收细节见 [VALIDATION](docs/VALIDATION.md)；开发时不会因文档、claim、evidence 或未来阶段缺口停工。

## 真正阻塞开发的红线

- 不得恢复 retired legacy renderer/effect owner，且只有一条 production renderer path。
- 不得引入本帧 GPU→CPU→GPU visible/work control，也不得为功能添加独立 frame submit。
- 完整算法或效果实施前，先查 GitHub 上可核验的完整开源实现，再查论文与足以复现决策条件、阶段和数据流的详细技术文章；不限源语言。选择来源时固定 revision、许可证和具体源文件/入口，写入 `docs/porting/next-renderer.md`，建立源函数/阶段到本地产物/阶段的逐项映射，保留关键分支、输入输出、不变量和降级条件。WebGPU API 可调整绑定与调度，不得把完整算法缩成同名近似效果；缺少完整 donor 时记录检索范围、缺口及具名本地方案，不宣称上游移植完成。来源核对、WGSL/CPU oracle 与新主链真实 GPU 消费证据齐备后，才提升采用状态。简单确定性工具、ABI 编解码及绑定/生命周期胶水标注为本地集成，不强制外部调研；复杂算法不得拆小后据此豁免。
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
