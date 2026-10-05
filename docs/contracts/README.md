---
id: contracts/readme
state: current
verifies:
  - checks
  - project/domains
---
# Contracts

Contracts are the small, exact interfaces shared by owners. Long term rationale remains in ADRs; binary and shader layouts remain in `docs/specs/`; current proof is indexed under `validation/evidence/`.

- [Project routing](./project-routing.md)
- [Claims and evidence](./claims-and-evidence.md)
- [Validation case](./validation-case.md)
- [Browser harness](./browser-harness.md)
- [Generated registry](./generated-registry.md)
- [Render Product / GPU Work / History V1](./render-product-work-history-v1.md) — 已废弃的渐进式 A 批次合同；旧实现事实供提取，不作为新架构目标。
- [Render Product / GPU Work / History V2](./render-product-work-history-v2.md) — 单路径新架构的候选跨 owner 语义，待真实新消费者收敛和验证。
- SurfaceWork V3 的最终 ABI 尚未冻结；目标数据流、阶段顺序和验收以[第三版设计](../next-design/eengine-extreme-performance-rebuild-2026-10.md)和[执行计划](../next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md)为准，不能把 retired V1/V2 合同当作新消费者接口。
