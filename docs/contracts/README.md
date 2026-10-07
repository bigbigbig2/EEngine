---
id: contracts/readme
state: current
verifies:
  - checks
  - project/domains
---
# Contracts

Contracts describe interfaces shared by real producers and consumers. Rationale remains in ADRs and binary/shader layouts in specs. A frozen label is not implementation or test evidence; validate the current production connection and actual assertions.

- [Project routing](./project-routing.md)
- [Validation case](./validation-case.md)
- [Browser harness](./browser-harness.md)
- [Generated registry](./generated-registry.md)

历史/候选资料：

- [Claims and evidence](./claims-and-evidence.md)：退休 claim 层的历史合同，不定义当前流程。
- [Render Product / GPU Work / History V1](./render-product-work-history-v1.md)：旧合同，供追溯。
- [Render Product / GPU Work / History V2](./render-product-work-history-v2.md)：旧候选目标，已由当前设计母稿替代。

Surface 的目标与退出要求以[V4 Native Shading 架构](../next-design/eengine-v4-native-shading-2026-10.md)和[执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)为准。最终 ABI 随生产 producer/consumer 稳定后收口。
