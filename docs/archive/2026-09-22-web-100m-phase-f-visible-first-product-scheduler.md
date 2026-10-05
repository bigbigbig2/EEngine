---
id: archive/2026-09-22-web-100m-phase-f-visible-first-product-scheduler
state: history
---
# ADR-0018 Phase F Visible-First Product Scheduler 审评（2026-09-22）

本记录把 Phase F 落为 coordinator 实现、unit contract/oracle 和冻结 spec；它不
把本地测试升级为 100M browser RuntimeValidated、Performance Evaluated 或 ADR
Complete。Phase H 之后的 adaptive residency 和正式 PERF
仍未完成。

## 结果

`WebCookCoordinator` 现在把首个 activation cut 与完整 progressive producer
解耦：

- `SceneCatalogReady` 后按 current-view source priority、空间 coverage 和稳定
  catalog tie-break 选择 bootstrap units；priority 迟到会计入
  `lateSourcePriorities`；
- `cookBootstrap()` 只等待首个 revision 的 descriptor、activation pages 和
  `PageReady`，在 TTFMF 边界返回；richer revision 在后台继续生产；
- `waitForCookCompletion()` 和 `totalCookMs` 单独表示 producer settle，不能把
  首帧时间误报为全场景 cook 完成；
- richer refinement 失败发布 `RecoverableFailure`，记录 failure code，保留已
  发布 bootstrap；首个 activation failure 仍是 fatal；
- cancel/dispose 会 abort 并拒绝后台迟到的 revision/page publication；
- source-window、bootstrap/refinement bytes、heartbeat 和 activation credit/read
  timings 继续保持 bounded evidence。

权威合同为
[`web-geometry-visible-first-product-scheduler-v1.md`](../specs/web-geometry-visible-first-product-scheduler-v1.md)。

## ADR-0018 对照

| ADR-0018 Phase F 要求 | 实现与证据 | 结论 |
| --- | --- | --- |
| visible/near shard first | `priorityFor()` 读取 current-view source priority；无 priority 时按 POSITION bounds extent × instance count 选 coverage | 满足 implementation/contract |
| 100M 不等待全部 cook 即可 render | `cookBootstrap()` 在首个 activation cut 完成后返回；producer refinement 在后台继续 | 满足 coordinator contract |
| TTFMF 与 total cook 分开测量 | `firstMeaningfulFrameMs`、`totalCookMs`、`waitForCookCompletion()` 和 `cook-complete` progress | 满足 measurement contract |
| current-view need + spatial relevance | `SetSourcePriority`/catalog handshake + `defaultBootstrapSelection()` 双级排序；迟到 priority 可观察 | 满足 scheduler contract |
| 拒绝 FIFO-only | 默认 selector 不以 catalog order 单独排序；catalog order 只做相同 score/coverage 的 deterministic tie-break，测试覆盖 priority displaces FIFO candidate | 满足 default policy；任意自定义 selector 仍由调用方负责其 priority 输入 |

## 失败与生命周期审评

首个 revision 的 descriptor、activation page、hash 或 output credit 错误会拒绝
session，避免把不完整 Product 宣称可见。richer revision 的 producer/page failure
只发 `RecoverableFailure`，不回滚 bootstrap；后台 producer 在 cancel/dispose 之后
不能重新进入 live revision 表或事件队列。`WebCookProductProvider` 仍负责 page
buffer ownership，coordinator 不拥有 GPU object。

## 验证

已覆盖：

```text
OEngine/tests/unit/web-cook-visible-first.test.mjs  (9/9)
OEngine/tests/unit/web-cook-coordinator.test.mjs    (7/7)
OEngine/tests/contract/web-cook-visible-first-scheduler.test.mjs (2/2)
```

覆盖首 cut 早返、total completion wait、TTFMF/total timing 分离、heartbeat、
refinement failure 保留 bootstrap、cancel late publication、priority/spatial
ranking、activation re-read、pending demand 和 replacement。

这些是 Node/contract 证据，不是独立浏览器画面或正式性能证据。仍开放的 gate：

- clean 100M browser host 上的真实 visible Product consumer 与 TTFMF；
- 100M source/canonical/WASM/JS/GPU working-set 和正式 PERF；
- Zorah bounded `EXT_meshopt_compression` decode；
- Phase H–J residency/scheduler（Phase G GPU demand compaction 已落地为 candidate spec）；
- 250M/500M/1B logical-scale workload evidence。
