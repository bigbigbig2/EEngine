# Web Geometry Visible-First Product Scheduler V1

Status: frozen

Owners: `WebCookCoordinator`、Web Runtime Cooker、Web Cook Worker host、Product provider

## Version/Compatibility

schemaVersion 固定为 1；本规范冻结 scheduler 的 priority 输入、bootstrap
selection、publication boundary 和 evidence 字段。新增字段可以在同一 major
version 中向后兼容；改变 TTFMF/total-cook 语义、PageReady ownership 或取消边界
必须递增版本并同步 protocol、consumer 与测试。

## Scope

本规范冻结 ADR-0018 Phase F 的 producer-side visible-first 调度边界。它位于
metadata-only GLB catalog 与 Multi-Product/Product admission 之间，负责决定首个
Product cut、公布 activation cut 的时间边界，以及 richer refinement 的后台完成
语义。本规范不把本地 Node/fake-device contract evidence 升级为 100M browser
RuntimeValidated、Performance Evaluated 或 ADR Complete。

## Scheduling policy

### Inputs

调度器在 `SceneCatalogReady` 后接收每个 catalog primitive 的以下输入：

- **current-view need**：调用方通过 `SetSourcePriority(assetKey, score,
  cameraHintRevision)` 提供的当前视图/相机 hint；分数越高表示越紧急。当前可见
  missing、near-visible、camera-cut recovery 等状态必须编码在这个分数中，而不是
  等首个 Product 发布后才补救。
- **spatial relevance**：catalog primitive 的 POSITION bounds extent 乘以实例数。
  bounds 缺失或非法时按未知覆盖处理，不能伪造为零面积。
- **deterministic tie break**：同一分数和空间相关性使用稳定的 catalog primitive
  order；这只是确定性 tie-break，不是独立的 FIFO 调度策略。

概念排序为：

```text
current-view need (priority score) DESC
spatial relevance (bounds extent × instance count) DESC
catalog primitive order ASC
```

实现可以把 distance、projected area、frustum、predictive velocity、shadow
relevance、recent demand、activation importance 和 age 合并到 priority score，
但首个 cut 不能只按 catalog/FIFO 顺序。默认选择器不提供 FIFO-only 模式；显式
`bootstrapUnitCount` 只限制 cut 大小，输入 units 仍先按 priority/spatial 规则
排序。

### Catalog handshake

`SceneCatalogReady` 必须在任何 BIN/WASM cook work 之前发出。主线程可以发送多个
`SetSourcePriority`，然后发送 `CommitCatalogPriorities`；Worker 也保留有界超时，
防止没有 priority caller 无限等待。priority 在 bootstrap selection 之后到达时，
不得悄悄改变首个 cut，必须增加 `lateSourcePriorities` evidence。

## Bootstrap selection and budgets

- 自动选择最多 `DEFAULT_BOOTSTRAP_UNIT_LIMIT`（当前为 24）个 primitive，并受
  `bootstrapMaxSourceBytes`（未配置时的自动 16 MiB cap）约束。
- `bootstrapSourceBytes` 是首个 cut 的 live source-window estimate；
  `refinementSourceBytes` 是完整 unit set 的 estimate。两者不能用 GLB 总字节数
  代替，也不能绕过 `maxWasmBytes`/bounded live-source admission。
- 选中的 units 形成一个稳定的 `bootstrapAssetIndices` 映射；未选中的远端/后台
  shard 不能成为首个 activation cut 的等待条件。
- 多 unit visible-first producer 必须提供 `cookProgressive`；没有 replacement
  identity 的单体 producer 不得把多个 units 假装成 FIFO 的多个 Product。

## Publication boundaries

渐进式 cook 有两条独立的完成边界：

1. **TTFMF / first meaningful frame**：首个 revision descriptor 已发布，且该
   revision 的全部 `activationPageIds` 已完成 page read、credit 校验和
   `PageReady` 流式发布。`cookBootstrap()` 在此边界返回；GPU admission 可以开始
   生成正确的 coarse world。
2. **total cook completion**：`cookProgressive()` producer promise settled，
   richer revision 已发布，或 refinement 已通过 `RecoverableFailure` 结束。只有
   此时 coordinator 才从 `cooking` 进入 `complete`，并记录 `totalCookMs`。

`firstRevisionMs` 是首个 descriptor offer 的时间；`firstMeaningfulFrameMs` 是
   activation cut 完成的时间，二者都从 cook start 计时。`totalCookMs` 从同一
   cook start 计时，因此 TTFMF 与 total completion 不可由一个 milestone 代替。
   `Progress.timings` 和 `WebCookCoordinator.evidence()` 都保留这些字段。

## Contract

实现必须遵守本页的 scheduling policy、bootstrap budgets、publication boundaries
以及 refinement/lifecycle 规则。`SceneCatalogReady`、`RevisionOffered`、
`PageReady`、`Progress` 和 `RecoverableFailure` 继续使用 Web CookSession Protocol
V1 的 header、credit 和 Transferable ownership；本规范只冻结 Phase F 的时序和
priority 语义，不复制 Product descriptor 或 GPU residency ABI。

## Refinement, failure, and lifecycle

- `cookBootstrap()` 返回后 coordinator 仍为 `cooking`，后台 producer 继续运行；
  `waitForCookCompletion()` 提供测试/diagnostic 对 total completion 的显式等待边界。
- richer revision 的 page/read/producer failure 发送 `RecoverableFailure`，记录
  `recoverableFailures`，保持已发布 bootstrap revision 和其 activation pages 可用；
  不得调用 fatal session rollback。
- 首个 activation cut 的 descriptor、page、hash 或 credit failure 是 fatal，不能
  宣称 TTFMF；该 session 进入 failed/cancelled 并释放 live revisions。
- `cancel()`/`dispose()` 会 abort producer、唤醒 credit waiters、释放 live revisions；
  后台 producer 迟到的 descriptor/page 必须被拒绝，不能在 cancelled/disposed
  session 中重新 publication。
- 不会因为 `complete` 后的 cancel 释放仍由 renderer 使用的 revision；显式
  `dispose()` 才释放 coordinator 拥有的 source/revision。

## Evidence contract

最小 evidence 字段为：

```text
bootstrapUnits
bootstrapSourceBytes
refinementSourceBytes
lateSourcePriorities
firstRevisionMs
firstMeaningfulFrameMs
totalCookMs
recoverableFailures
state
```

这些字段只证明 coordinator 的本地 contract/oracle 行为。100M GLB 的真实
TTFMF、CPU/GPU working-set、browser adapter、camera path、workload hash 和正式
PERF 必须在独立 `validation/` host、clean revision 上采集，不能由 unit/Node
测试替代。

## Validation

`OEngine/tests/unit/web-cook-visible-first.test.mjs` 覆盖：

- priority 提升能替换 coverage cut 中的 FIFO 候选；
- 首个 activation cut 返回早于 richer refinement 和 total completion；
- TTFMF 与 total cook timings 分离；
- richer failure 保留 bootstrap 并发送 `RecoverableFailure`；
- cancel/dispose 拒绝后台迟到 revision；
- progress heartbeat 不虚报尚未生产的 units。

`OEngine/tests/unit/web-cook-coordinator.test.mjs` 覆盖 activation re-read、pending
page demand、revision replacement 和 completion wait。真实浏览器 visible-first
画面与 100M formal PERF 仍是后续 validation gate。
