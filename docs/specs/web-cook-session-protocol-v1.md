# Web CookSession Protocol V1

Status: draft

Owners: `OEngine/src/assets/web-cook/protocol/`、Web Runtime Cooker、Web Cook Worker host/pool、validation host

## Version/Compatibility

`protocolVersion = 1`；实现常量与 TS 类型镜像位于 `OEngine/src/assets/web-cook/protocol/CookSessionProtocol.ts`。

每条命令与事件都携带 `protocolVersion`、`sessionId` 和 `sessionGeneration`。三者任一对不上的消息必须计为 `droppedLateMessages` 并拒绝，不得 best-effort 处理：迟到的 generation 一旦被接受，就会让已失效的 CookSession 重新影响 Product admission。

同一 major version 内可以新增命令或事件，但不得改变既有命令/事件的字段语义或 credit 记账规则；语义变化必须递增 `protocolVersion` 并让旧 consumer 显式失败。本 spec 与 `docs/specs/web-geometry-cooker-abi-v1.md` 是两个不同边界：后者只跨 `Dedicated Worker TypeScript <-> WASM`，本 spec 只跨 `main thread <-> Dedicated Worker`。任一 ABI 的变更不得顺带改变另一个。

单页字节数固定为 `WEB_COOK_PAGE_BYTES = 262144`。所有 output credit 都以整页 block 为单位记账，不接受部分页或非整块字节。

## Contract

### 状态机

```text
created --CreateSession--> open --CancelScope--> cancelled
                              |
                              +--DisposeSession--> disposed
                              +--fail()----------> failed
```

- `CreateSession` 只能在 `created` 接受，成功后进入 `open`。
- `OpenSource` 只能在 `open` 接受。
- 工作类命令（`CommitCatalogPriorities`、`SetSourcePriority`、`RequestPages`）要求 `open` **且** source 已打开；未打开时拒绝。
- `CancelScope` 只在 `open` 生效并置为 `cancelled`。
- `DisposeSession` 置为 `disposed` 并清空事件队列。
- 内部失败置为 `failed` 并清空事件队列。
- 非 `open` 状态下 `emit()` 一律计为 `droppedLateMessages` 并返回 false，不抛错：会话结束后的迟到产出是正常竞态，不是编程错误。

### 命令

`Progress(stage="cook-complete")` 关闭 descriptor revision 枚举，但不关闭 page
event pump；settled 后仍能执行 `RequestPages`。已发送的 activation page 在整个
activation cut 完成前也允许复读，不能静默丢弃已经消费后的重复请求。

声明 `requiredIndependentProducts` 的 producer 将每个 Product/shard 视为必需覆盖。
任何 activation、remainder spill 或 task failure 都必须发送 terminal failure，不能仅
因为 primitive 集合已覆盖而退化成 recoverable refinement；成功终态要求全部任务完成。

`DisposeSession` 的 graceful consumer 等待 Worker 释放 artifact 后发出的
`Progress(stage="session-disposed", timings={spillCurrentBytes, spillOwnerCount,
spillReleases, spillWrites})`，然后终止 Worker。这是 host 在 session event queue
关闭后的确认，不重新打开 queue。未确认、清理失败或超时不能声明 disposal 成功；
立即 `dispose()` 仍为强制终止。该确认是 V1 的新增 progress stage。

| 命令 | 关键字段 | 约束 |
| --- | --- | --- |
| `CreateSession` | `runtimeProfile`、`recipe`、`budgets`、可选 `bootstrap` | 仅 `created`；`budgets` 全部为正安全整数；`bootstrap.unitCount`/`maxSourceBytes` 若存在必须为正安全整数 |
| `OpenSource` | `source` | 仅 `open` |
| `CommitCatalogPriorities` | — | 声明 main thread 已发完该 catalog 的 `SetSourcePriority`，Worker 可以开始 cook |
| `SetSourcePriority` | `assetKey`、`score`、`cameraHintRevision` | `score` 必须 finite；`cameraHintRevision` 为非负整数 |
| `RequestPages` | `productId`、`revision`、`pageIds`、`priority` | `productId` 为 32 B；`revision` 为非负整数；任一 `pageId` 不得为 `0xffffffff` |
| `GrantOutputCredits` | `blockCount`、`bytes` | `bytes === blockCount * 262144`；授权后累计额度不得超过 `budgets.maxQueuedEvents` 与 `budgets.maxOutputBytes` |
| `ReturnOutputCredits` | `blockCount`、`bytes` | 不得超过当前 outstanding ownership |
| `CancelScope` | `scope` | — |
| `DisposeSession` | — | — |

`runtimeProfile` 取 `portable-single`、`portable-pool` 或 `isolated-pthreads`。profile 只改变 Provider 内部执行方式，不改变本协议的语义、字段或 credit 记账，也不得成为简化 Nyx 算法阶段的借口。

### 事件

| 事件 | 关键字段 | 约束 |
| --- | --- | --- |
| `SceneCatalogReady` | `catalog` | 必须在任何 payload 产出前送达；main thread 依赖它注入 source priority |
| `RevisionOffered` | `descriptor`、可选 `sceneAssetIndices` | descriptor 必须能被 Product binary validator 解码；`sceneAssetIndices` 长度必须等于 descriptor 的 asset 数、元素为非负整数；Phase C spatial shards 允许多个 asset 映射同一个 catalog primitive |
| `PageReady` | `productId`、`revision`、`pageId`、`decodedHash128`、`decodedPageHash128`、`bytes` | 见下方 credit 规则；`productId` 为 32 B、两个 hash 各 16 B、`bytes` 恰为 262144 B |
| `Progress` | `stage`、`units`、`bytes`、`timings` | `timings` 是开放的 `number` 映射；**缺失某个 key 表示未测量，必须与测量为 0 区分**，不得用 0 冒充未测量 |
| `RecoverableFailure` | `scope`、`code`、可选 `retryAfterMs` | 不终止会话；已发布的 revision 必须保持可用 |
| `FatalSessionFailure` | `code`、可选 `diagnostics` | 终止会话；该 generation 的 descriptor/page 不得复用 |

### Progress 阶段与计时

`Progress.stage` 的取值约定：

- `bootstrap-cook`：首个 cut（bootstrap revision）已产出并完成 activation 流式。
- `refinement`：替换 bootstrap 的 richer revision；心跳也在此 stage 下。
- `cook-complete`：progressive producer 已 settled；`timings.totalCookMs` 已可用。
- 细分 `refinement-canonical` / `refinement-plan` 需要 cooker 暴露其内部阶段；当前 cooker 是单个不透明调用，coordinator 无法区分，故不编造。

`Progress.timings` 的约定 key（单位毫秒，**缺失表示未测量**，不得用 0 冒充）：

- `catalogMs`：`open` 到 `SceneCatalogReady`。
- `bootstrapCookMs`：开始 cook 到首个 revision offer。
- `firstMeaningfulFrameMs`：开始 cook 到首个 activation cut 完成并全部
  `PageReady` 发布；这是 visible-first 的 TTFMF contract boundary。
- `activationStreamMs`：activation cut 流式总耗时，恒等于 `activationCreditWaitMs + activationReadMs`。
- `activationCreditWaitMs`：`emitPage` 等待 output credit 的累计时间。
- `activationReadMs`：`emitPage` 读页 + 校验的累计时间。
- `refinementMs`：首个 revision offer 到 richer revision offer。
- `totalCookMs`：开始 cook 到 progressive producer settled；可以大于
  `firstMeaningfulFrameMs`，不能把首个 cut 时间当作总完成时间。
- `elapsedMs` / `totalUnits`：仅心跳携带，供 UI 做存活显示。

区分 `activationCreditWaitMs` 与 `activationReadMs` 是判断首帧「producer-bound 还是 credit-bound」的唯一依据，二者必须各自保留，不得只合并成单个 activation 数字。

### Catalog 优先级握手

`SceneCatalogReady` 在 Worker 开始任何 BIN/WASM 工作前送达 main thread，目的是让首个 cut 能按默认视角的实际可见性排序。Worker 无法证明优先级命令已经跨过边界——计时器只是猜测，而无期限等待会卡住不发优先级的调用方。因此握手必须显式：

```text
Worker  OpenSource -> open() -> flush(SceneCatalogReady) -> 打开有界窗口
Main    收到 catalog -> 排序 -> SetSourcePriority × N -> CommitCatalogPriorities
Worker  收到 commit  -> 关闭窗口 -> cookBootstrap()
Worker  窗口超时     -> 关闭窗口 -> cookBootstrap()
```

约束：

- cook 只能由 commit 或窗口超时启动，不得依赖固定 `setTimeout` 之类的时序假设。
- 窗口超时必须保留为安全网：不发优先级的调用方不能被无限期拖住；窗口长度是实现可配置值，不是协议字段。
- 迟到到达的优先级不得改变已经算出的首个 cut；实现必须把它计为可观察的计数，而不是静默忽略。
- 本命令是**同一 major version 内的增量**：不识别它的实现回退到窗口超时即可继续工作，因此不递增 `protocolVersion`。若未来改变 `SceneCatalogReady` 的语义或移除窗口，则必须递增。

### Output credit 与 ownership

`PageReady` 只有在持有整页 credit 时才能发出，且发送即消费一个 block：

```text
grant:    credits += blockCount, bytes += blockCount * 262144
emit 前:  要求 creditsBlocks >= 1 && creditsBytes >= 262144
emit 后:  credits -= 1 block; outstanding += 1 block
return:   outstanding -= blockCount; credits += blockCount
```

`emit()` 时 credit 不足必须返回 false 而不是抛错或截断；`returnOutputCredits` 超出 outstanding 必须抛错，因为那意味着消费侧重复归还同一份所有权。

事件队列容量为 `budgets.maxQueuedEvents`，超限抛错。消费侧必须持续 drain：一个停止 drain 的 consumer 应当只损失进度事件，而 `Progress` 心跳必须捕获这一情形并跳过该 tick，不能因此把整个 session 判为失败。

`PageReady` 的 payload `ArrayBuffer` 是独占所有权，经 Transferable 移交；生产者必须持有自己的 master copy，交付时给出独立副本，否则转移会 detach 生产侧缓存并使同一页的重复请求返回 0 字节。

### Owner 边界

- Provider 只生产 CPU descriptor 与 page bytes；GPU object、heap、address table 与 publication 只属于 render/GPU owner。
- 不创建第二 renderer、raster、Visibility、shadow 或 shading backend。
- 帧循环不等待 Worker、`mapAsync()` 或 submitted work；feedback 与 retirement 都延迟推进。
- `crossOriginIsolated`/SharedArrayBuffer 是高吞吐 specialization 的前提，不是正确性前提；不满足时必须显式报告 fallback，不能把 fallback 冒充 pthread。
- OEGPACK、持久 cache 与 live Product 不按 PageID 混拼；替换永远是完整的新 revision/product transaction。

### Evidence

会话必须能报告：`sessionGeneration`、`state`、`queuedEvents`、`outputCreditsBlocks`/`Bytes`、`outstandingOutputBlocks`/`Bytes`、`peakOutputBytes`、`droppedLateMessages`。`peakOutputBytes` 是并发副本峰值的一部分，不得用它推断物理显存占用。

## Validation

- `OEngine/tests/unit/cook-session-protocol.test.mjs` 覆盖 header/version 拒绝、状态机越界、credit 授权与归还边界、超限队列、非法 `RevisionOffered.sceneAssetIndices` 与非法 `PageReady` 身份；Phase C contract 覆盖重复 catalog primitive 的合法 shard 映射。
- `OEngine/tests/unit/web-cook-worker-transport.test.mjs` 覆盖 generation 过滤与迟到消息丢弃。
- `OEngine/tests/unit/web-cook-budget.test.mjs` 覆盖 output/source/WASM 预算与超额拒绝。
- `OEngine/tests/unit/web-cook-activation-reserve.test.mjs` 覆盖 activation page 重读、credit 守恒、无等待重复副本丢弃。
- 新增命令或事件时必须同步更新本 spec、TS 类型镜像与对应 golden/negative 测试；三者不一致时先停止扩散并确定哪一侧错误。
- 真实浏览器行为由 `validation/` 宿主承担；协议层测试不能替代跨 Worker 边界的运行证据。
