# EEngine Next 协作规则

目标是极致 GPU 性能与现代 AAA 画质，首要运行目标为 GTX 1650 Ti、1080p 复杂场景。当前处于单生产路径的破坏式重建。Surface/Appearance/Lighting 严格以用户指定的 [第三版最终重构设计](docs/next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)为唯一目标，原文优先于其他文档和此前聊天候选；具体顺序见 [SurfaceWork V3 执行计划](docs/next-execution/surface-work-runtime-v3-rebuild-2026.md)。保留系统边界见 [整体架构](docs/next-design/eengine-next-overall-architecture-final-2026.md)，后续模块见 [架构层计划](docs/next-execution/eengine-next-architecture-layer-plan-2026.md)，当前模块见 [workstream](project/workstreams/active/eengine-next-clean-rebuild.yaml)。源码是当前实现事实；文档采纳不证明实现、性能、claim 或来源 adoption 已完成。

## 开发节奏

1. 用 `node tools/vibe.mjs context <path>` 查询 owner 和文档入口；这是导航命令，不是许可或验证门禁。代码改动前了解相应源码与设计边界即可。
2. 在 currentSlice 内持续编码，直接切换唯一生产路径。旧实现从生产依赖中删除，必要时直接删源文件；Git 历史用于回溯。不建立旧/新 A/B 运行桥梁。
3. 开发中可按调试需要运行 typecheck、build 或单个 targeted test；不要求每批修改执行 `verify --module`、browser、evidence、claim promotion、clean revision、benchmark、workstream exit check 或文档同步。
4. 大模块的原理和生产链连通后，集中运行一次 typecheck、build 与该模块必要的 targeted tests；可显式使用 `node tools/vibe.mjs verify --module --test <OEngine/tests/...test.mjs>`。修明显问题，更新 currentSlice，然后进入下一个模块。未运行的测试必须如实陈述。
5. Next Renderer 的主要架构与计划中的 providers 全部完成后，才做 browser matrix、resize/camera cut/device loss、场景和材质组合、画质对照、GPU P50/P95、正式 evidence 与 claims。`verify --full` 属于这个阶段。

### 当前 SurfaceWork V3 重构的执行覆盖规则（2026-10-02）

用户明确要求按第三版设计推进 SurfaceWork、唯一 SurfaceGeometryRecord、前置 cache lookup/miss-only 材质、独立 lighting signal packets、TemporalFacts 与廉价 reconstruct，作为一个连续重构整体，覆盖上面第 3–5 条在这个范围内的检查时点。旧 SurfaceMaterialPass/Probe/sample 主链在基线 e7296be9 已删除；先切断仍实际存在且被新目标替代的 pixel-task 调度、独立几何恢复和重 reconstruct，再直接实现最终唯一主链。允许工作树暂时无法编译、无法出图或缺少消费者；不为维持中间可运行状态保留旧实现、适配桥、临时全率旧链或占位效果。真实编译错误最终在新主链内修复，不通过恢复旧链消除。

开发推进期间不运行 typecheck、build、targeted tests、组件 GPU oracle、browser、benchmark 或 verify，不设小模块闭合、测试通过、证据补齐或逐批文档同步门槛。Phase 0 固定基线身份与配置，正式采样在整个目标代码及真实接线完成后的 Phase 7 集中进行：编译、数值、覆盖、生命周期、浏览器、连续画质与旧 baseline/中间版/第三版/最终版四版本同条件性能比较，完整范围按原文 §8–§11；不承诺固定 FPS 或百分比。失败就在新主链返工。后续用户明确要求的诊断按该次指令执行。来源核读仍在复杂算法实施前完成；来源采用状态、实现完成与验收通过分别记录。

只复用最终架构需要的数学、资源 owner 和 GPU 产品，删除旧协调器及无消费者依赖，不为旧测试修改新架构。Winner/Sharing/Cache identity 分开；cache lookup 在 material miss compact 前，hit 不进入 geometry/material heavy worker；Appearance/Lighting 只消费唯一 GeometryRecord；reconstruct 不重新执行完整几何、材质或 PBR。最终 bounded full-rate exception、身份失效和写域互斥集中在权威生产/发布边界保证，热 consumer 不重复检查已保证的不变量。具体删除顺序与最终范围见 [SurfaceWork V3 执行计划](docs/next-execution/surface-work-runtime-v3-rebuild-2026.md)。此覆盖规则也优先于近目录和旧文档中的模块检查要求。

文档用于导航与架构约束，不是编码许可系统。快速变化的 current facts 可以在大模块完成后集中同步。活跃 Next workstream 只维护 currentSlice、goal、nextModules、architectureRules 和 deferredValidation。正式验收细节见 [VALIDATION](docs/VALIDATION.md)；开发时不会因文档、claim、evidence 或未来阶段缺口停工。

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
