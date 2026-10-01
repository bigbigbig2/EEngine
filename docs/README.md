# EEngine Next 文档入口

当前方向已于 2026-10-02 按用户指定第三版设计统一。文档说明目标、执行和源码事实，不是逐批编码许可。

## 从这里开始

1. [第三版最终重构设计](next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)：用户指定原文，后续 Surface/Appearance/Lighting 的唯一目标依据。
2. [SurfaceWork Runtime V3 执行计划](next-execution/surface-work-runtime-v3-rebuild-2026.md)：Phase 0–7、owner、删除边界、数据流和最终验收。
3. [整体架构](next-design/eengine-next-overall-architecture-final-2026.md)与[架构层计划](next-execution/eengine-next-architecture-layer-plan-2026.md)：保留系统边界与后续 SSSR/GI/VT/Transparency 方向；Surface 部分服从第三版原文。
4. [当前 workstream](../project/workstreams/active/eengine-next-clean-rebuild.yaml)：当前切片和待完成目标。
5. [方向一致性核对](reviews/surface-work-runtime-v3-direction-alignment-2026-10-02.md)：原文条目到活动入口的映射及本次检查范围。
6. `node tools/vibe.mjs context <path>`：只查询 owner/current docs/Next 入口，不检查编码许可或 claims。

## 文档分层和优先级

| 位置 | 作用 |
| --- | --- |
| 第三版设计原文 | Surface 最终目标；保留原文日期 2026-10-01 和基线 e7296be9，采纳日期为 2026-10-02 |
| next-design/ | 整体和其他 owner 的目标；与原文冲突的 Surface 内容已替换 |
| next-execution/ | 活动执行顺序；旧 Surface v2/Signal-Rate/缓存执行文档已删除 |
| domains/ | 源码现状与缺口；不能用目标代替实现事实 |
| contracts/、specs/ | 稳定跨 owner 协议和 ABI；retired 文档不供新消费者使用 |
| porting/、sources/ | 固定来源、许可、阶段映射和真实 adoption 状态 |
| adr/ | 长期决策和替代关系；[ADR-0021](adr/0021-surface-work-runtime-v3.md) 调整 Surface 目标 |
| reviews/、performance/ | 日期化检查与历史诊断；不是当前设计或性能证明 |

原文与执行摘要冲突时以原文为目标；源码描述现状，不因为采纳原文而自动完成。旧 Surface 方案不在工作树另设 archive，用 Git 历史追溯。Frame Program、AO、Temporal、VSM 原模块资料保留算法和来源，但其中旧 Surface 接口/检查顺序已标明历史边界。

## 开发与验收

当前 Surface 是连续破坏式重构整体：先切断旧模型，允许中间未编译/缺图，完整实现及真实接线后统一编译、数值、覆盖、生命周期、浏览器、连续画质和四版本同条件性能检查。开发中不运行编译/tests/browser/benchmark/verify，也不按组件设门槛；用户明确诊断另按指令执行。

本次方向整理只做原文一致性、链接、YAML 和源码现状核对，不运行 renderer 验证。其他模块按 [VALIDATION](VALIDATION.md) 的通用节奏；formal evidence/claims 留到相应最终验收，文档更新不提升采用或通过状态。
