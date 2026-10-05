---
id: next-execution/surface-work-v3-cost-bounded-final-refactor-phase2-implementation-2026-10
state: history
verifies:
  - OEngine/src
---
# Surface V3 Phase 2：Geometry 前置实施与收口更正

**2026-10-05 复审补注**

本页保留Phase2及此前更正记录；本次复审发现lazy witness等前置要求仍未完整落实，不能再概括为全部补齐。Geometry cold已按mask append，但地址/证书/ref与预算映射由必需Phase5.5继续迁移。具体范围与门槛见[阶段复审与准备](surface-work-v3-cost-bounded-refactor-review-and-readiness-2026-10.md)，不把后续检查回写为旧提交已经通过。


日期：2026-10-04。入口：[执行计划 §5](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)、[设计 §7、§13](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)。

## 原判定的不足与当前事实

原提交 2ae78f33 预留 local/memo 容量，但 local reservation 仍依赖有界 dictionary；满表能留下无效引用。排序和 prefix 缺少读后写同步，传播产物没有成为真实 SetupRef。memo 没有实际 shader admission/consumer。720B record 整块写未切 hot/cold。新增测试中的源码正则及沿用 Phase 1 的小链不能证明满表、竞态和 memo 正确性，且 Phase 1 metadata 断言曾被删除。因此原“Phase 2 已完成”的判定不足，不能把后移 memo 称作前移接线。

Phase 3 开始时按实际源码补齐这些前置，并恢复、扩展检查；修复与当前验证见 [Phase 3 实施记录](surface-work-v3-cost-bounded-final-refactor-phase3-implementation-2026-10.md)。原提交仍保留在 Git 历史，以下为更正后的实现事实。

## 唯一生产链

SurfaceGeometry owner：uniform winner 直接分组；mixed 固定 64-key compare/exchange、run leader 与 inclusive prefix，比较/前缀先读、barrier、写、barrier。一次 atomic reservation 预留全部 local run，最坏 R；每 leaf 的显式 SetupRef 不依赖哈希接纳。facts 的 primitive 等价类直接使用它，删除前序 member 搜索。消费者仅取 setup，不包含完整 source decoder。

frame memo 独立有界：四次 probe 查询已提交前批 payload，miss 完整 local build；publish/commit 分派边界保证后批可读。满表只放弃缓存 admission，每帧首批 reset；没有空对象导入或无用分配。

唯一 GeometryRecord 使用 128B hot 加按需 append cold。14 个 kind 保留实际 C/X/Y；同源的 7/10、5/11、6/12 共用物理槽但语义 mask 独立。最坏 cold=528B、总容量=656B/target；只写实际 union。Appearance 的 cold reader 与 Lighting 的 hot reader 同时切换。

## 当前物理合同

| 产品 | 实际合同 |
|---|---|
| local setup | 512B/slot，完整 tile range 必须被 target capacity 覆盖 |
| explicit refs | 每 target 8B，setup segment 起点按 16B 对齐；不再是 hash dictionary |
| memo | 528B/entry，独立 power-of-two cap，满表不影响输出 |
| record | hot 128B + cold 最坏 11×3×16B；单 buffer、唯一 producer |
| retirement | planner 计入双 scratch/输出；owner 实际 active+retired 字节配额，GPU fence 完成后才释放 |

布局/资源创建前检查 buffer/storage/binding limits。R=65536 和最终性能仍是目标，不把当前 planner 或小链推广为完整生命周期与质量验收。

## 已运行的更正后验证

- typecheck/build/build:test 通过；Phase 3 的 45 项 targeted checks 通过，源码正则不再作为算法完成证明。
- 真实 Geometry GPU：64 distinct winner 的全部 local refs；warm memo 51 hits/13 decodes；强制满 memo 64 decodes/64 rejected admissions；uniform/mixed partial 全部通过。
- 真实 record producer→reader：3 records、14 kinds×C/X/Y，含非线性 normal/tangent、邻点翻面，最大误差 9.56e-8。
- 26 modules 的真实完整 production 小链及 Showcase timing/detailed 通过；删除 primitive 前序搜索后重跑受影响项。

上述检查在 Phase 3 本轮完成，不回写为 2ae78f33 当时已经通过。跨浏览器、所有 deformation/provider 组合、连续质量、正式历史性能比较仍属 Phase 7，尚未运行。
