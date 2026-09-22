# ADR-0018 当前实现审计与重构计划（2026-09-22）

## 1. 结论

本评审所判断的核心问题成立：`large.glb` 的规模本身不是不可接受的目标，真正需要控制的是 Web Runtime Cooker 的同步工作粒度、发布顺序、调度边界和可观测性。

但评审基于 `c2f0d2c1`，当前 HEAD `3c0fada7` 已经实现了其中大部分 P0 Producer 基础设施：

- Product 同时受 source bytes、canonical bytes、triangle、vertex、domain 五个上限约束；
- authored workload 使用 32 MiB canonical、128 Ki triangles、512 Ki vertices、64 domains；
- oversized primitive 即使 canonical bytes 很小，也会触发 spatial sharding；
- ordinary primitive batching 与 spatial shard 共用 Work Budget；
- `units` 已明确表示 catalog primitive coverage；
- K0 使用 `sceneAssetIndices` 并集验证 1,920 primitive coverage，不要求 1,920 Products；
- `maxDecodedProductBytes` 与 `maxSessionSpillBytes` 已分开，authored K0 配置 1 GiB session spill；
- Product Task Trace 已覆盖 canonicalize、wasm-plan、spill、publish 和 terminal event；
- 当前普通 Product 的 scope hash 已加入 canonical hash 与 scene mapping，修复了诊断运行中 ordinary Product OPFS key 碰撞的直接原因；
- incomplete catalog coverage 现在会使 session 失败，不再进入成功的 `cook-complete`；
- `web-authored-large-cook-k0` 已注册并具有 coverage、trace、spill、settled 和 disposal 断言。

当前实现还没有达到评审的最终结构。主要缺口是：

1. K0 名义上是 cook gate，实际仍创建 Renderer、上传 Multi-Product Scene 并等待 first frame，和 K1 runtime smoke 的职责重叠。
2. 每个 Product 仍在 publication 前执行 `spillAllPages()`，descriptor/activation-first 没有真正落地。
3. `portable-pool` 仍按 session 固定到一个 Worker，单个 large.glb 无法利用多个 Worker。
4. 每追加一个 Product 都重新 merge 全部 scene source、释放旧 RenderWorld、重建并 submit，累计工作具有 O(N²) 趋势。
5. authored case 仍由调用者硬编码 `productSlotCapacity: 2048` 和 128 MiB metadata，没有从 Product plan 与 WebGPU limits 推导。
6. bootstrap 排序仍是 priority → spatial coverage → catalog order，没有加入 estimated cook cost。
7. WASM plan 仍是不可抢占的同步调用。当前 dedicated Worker 可以被 `terminate()` 强制停止，但无法产生完整的协作式 cancelled receipt；pool 模式下也没有只终止单个 Product task 的所有权边界。
8. Product identity 的当前修复覆盖 ordinary windows，但 scope 仍主要依赖 canonical content 与 `sceneAssetIndices`。同一 primitive 内两个内容完全相同的 spatial shards 理论上仍可能得到相同 scope；identity 应显式包含 shard identity/partition identity。
9. Task Trace 只有 TS 层四个阶段，尚无 meshlet/group/simplify/LOD/hierarchy/page-plan 的 C++ 子阶段 timing。
10. 当前最新修复只有 L1 证明；authored-large K0 尚未在 HEAD 上重新产生可接受的浏览器证据。

因此当前状态应表述为：**评审提出的 bounded Product quantum 已完成，K0 correctness 修复已进入代码并通过 L1，activation-first、增量 GPU publication、session-local scheduling 和正式浏览器证据尚未完成。**

## 2. 评审要求与当前实现对照

| 评审目标 | 当前实现 | 判定 | 代码证据 |
| --- | --- | --- | --- |
| Cook 同时受内存和工作量限制 | `ProductWorkBudgetV1` 同时检查 source/canonical/triangles/vertices/domains | 符合 | `CanonicalWindowPlanner.ts` |
| 128K triangle 触发 spatial shard | `requiresSpatialSharding()` 调用统一 budget；authored case 配置 131,072 | 符合 | `NyxWebRuntimeCooker.ts`、K0 workload |
| ordinary batching 使用同一 budget | candidate 触及任一上限就 flush | 符合 | `planCanonicalWindows()` |
| 1920 primitive coverage，不要求 1920 Product | K0 receipt 对 completed task 的 `sceneAssetIndices` 求并集 | 符合 | `assertProductTaskReceipt()` |
| Product Task Trace | 四阶段、task identity、work size、spill 和 terminal metrics 已贯通协议 | 基本符合 | `ProductTaskTrace.ts`、Coordinator、Client |
| 独立 session spill budget | authored K0 为 1 GiB，worker 独立接收配置 | 符合 | WorkerFactory/Entry、K0 workload |
| ordinary Product identity 不碰撞 | canonical hash + mapping 进入 Product scope，并有 oracle | 已修复，待浏览器复验 | `resolveProductScopeHash()` |
| spatial shard identity 完全无碰撞 | scope 未显式绑定 `shardId`/partition identity | 部分符合 | `resolveProductScopeHash()` |
| required Product 失败后 session 必须失败 | incomplete coverage 进入 `fail(..., true)` | 已修复，待浏览器复验 | `WebCookCoordinator.completeCook()` |
| descriptor/activation-first | 当前 `spillAllPages()` 后才 `yield revision` | 不符合 | `NyxWebRuntimeCooker.planIndependentProducts()` |
| K0/K1/K2 分层 | workload 已分层，但 K0 页面仍运行 Renderer 和 first frame | 不符合 | `web-100m-formal-perf/main.ts` |
| session 内 Product 并行 | pool 把完整 session pin 到一个 Worker | 不符合 | `WebCookWorkerPool.ts` |
| portable-single 可有界取消 | 消息不能打断 WASM；client 最终 terminate 整个 Worker | 部分符合 | WorkerTransport、Client |
| bootstrap benefit/cost | 仍按 priority 与 coverage 排序 | 不符合 | `defaultBootstrapSelection()` |
| 增量 Multi-Product publication | 每个新 Product merge 全量 parts 并替换整个 Scene publication | 不符合 | `MainRenderPipeline.uploadWebCookedMultiProductScene()` |
| 自动 Product capacity | authored page 硬编码 2,048 slots/128 MiB metadata | 不符合 | formal case `SOURCES.authored-large` |
| C++ cook 子阶段 timing | 只有聚合的 `wasmPlanMs` | 未实现 | Product Task Trace V1 |
| K0 当前 revision browser receipt | 当前 workstream 仍记录 failed diagnostic | 未完成 | active workstream/open gates |

## 3. 需要纠正的评审表述

### 3.1 已不再成立的 P0 判断

“当前只按 64 MiB 判断是否切 shard”“普通 window 只按 bytes 填满”“仍要求 minimumExpectedProducts=1920”“session spill 固定从 per-Product budget 推导”等判断只适用于 `c2f0d2c1`。当前 HEAD 已完成对应修改，不应重复重写这些模块。

下一步应该保留 `ProductWorkBudgetV1` 作为唯一规划入口，避免再增加第二套 planner 或另一组不一致的阈值。

### 3.2 取消语义需要更精确地描述

同步 `_oengine_web_geometry_cook_plan()` 确实无法响应 Worker 内的 `CancelScope` 消息。但当前 `WebCookClient.cancel()` 随后调用 `transport.close(true)`，对于 dedicated Worker 会直接 `terminate()`，所以“完全无法终止”已经不准确。

准确结论是：可以用 Worker termination 强制停止；不能在 WASM 内协作式退出；强制停止时无法保证当前 Product 发出 cancelled terminal trace；当前 pool 以 session 为故障域，无法只撤销一个 Product task 后继续 session。

### 3.3 Product identity 修复不能只依赖内容 hash

当前 scope hash 已解决已观察到的 ordinary Product collision，但 Product identity 还应绑定规划位置：

```text
partition kind
partition contract/version
ordered catalog sceneAssetIndices
ordinary window ordinal，或 spatial shardId/shard ordinal
canonical content hash
```

内容 hash 用于稳定性和完整性，partition identity 用于区分同一 primitive 中内容相同但所有权不同的两个 shard。

### 3.4 K0 必须真正成为 Producer gate

当前 K0 虽然关闭 timestamp 和正式采样，仍执行 `Renderer.initialize`、`uploadWebCookedMultiProductScene`、first render 和 `queue.onSubmittedWorkDone`。这会让 Product cook、GPU admission、Scene publication、first frame 和 GPU error 混在一个 gate 中。K0 应只证明 Browser Worker/WASM/OPFS Producer；生产 Renderer 行为放入 K1。

## 4. 五阶段重构计划

### 阶段一：关闭纯 Producer K0 的 correctness 闭环

#### 目标

在不创建 Renderer 和 GPU 资源的情况下，让 `large.glb` 完成 catalog → bounded Product tasks → activation payload → full spill → settled → dispose，并生成可定位的完整 receipt。

#### 代码改动

1. 在 `WasmGeometryProductIdentifyInputV1` 增加显式、版本化的 partition scope，例如：

   ```ts
   type GeometryProductPartitionScopeV2 = {
     kind: "ordinary-window" | "spatial-shard";
     partitionVersion: string;
     sceneAssetIndices: readonly number[];
     ordinal: number;
     shardId?: string;
   };
   ```

   `resolveProductScopeHash()` 应对 partition scope 和 canonical window hashes 一起编码。ordinary window 使用稳定 window ordinal；spatial 使用 `WEB_SPATIAL_SHARD_PARTITION_VERSION + shardId + shardOrdinal`。同时升级 producer identity/version，防止旧 provisional key 被误认为新 identity。

2. 增加 identity oracle：

   - 同一 ordinary partition 重跑得到相同 ProductID；
   - 不同 ordinary partitions 得到不同 ProductID；
   - 同一 primitive 的两个 canonical 内容完全相同的 spatial shards 仍得到不同 ProductID；
   - ProductID、revision、sessionGeneration、pageId 组合不会命中别的 Product page；
   - 旧 OPFS artifact decoded hash 不匹配时失败且不污染 active generation。

3. 保留当前 incomplete coverage fail-closed 逻辑，补一个 session terminal contract：

   - `complete` 只能在 coverage 等于 catalog size、所有 Product terminal 为 completed、producer settled 时出现；
   - 任一 required Product failed/cancelled 时 session terminal 必须为 failed/cancelled；
   - 已发布前缀可以保持可读，但不得发送成功的 `cook-complete`；
   - `RecoverableFailure` 只允许发生在完整可用 coverage 之后的可选 refinement。

4. 为 K0 新建独立页面入口，不再复用 formal PERF 主页面。页面直接消费 `WebCookRuntimeAsset.revisions()`：

   - 对每个 revision 校验 descriptor、ProductID 唯一性、sceneAssetIndices 和 activation page；
   - drain 全部 revision，等待 provider settled；
   - 从 task trace 计算 Product count、coverage、最慢 task、最慢 WASM、spill peak；
   - 不创建 `Renderer`、`Scene`、`GPUDevice` 或 `GeometryProductMultiRuntimeV1`；
   - case 定位为 Browser Worker/WASM/OPFS contract，K1 才承担 WebGPU smoke。

5. 修正 workload/task trace 描述。当前 workload 的 `taskTrace.phases` 包含 `catalog`，而 Product Task Trace V1 的 phase union 不包含 catalog。Catalog 应作为 session event 单独记录，Product phases 保持 canonicalize/wasm-plan/spill/publish。

#### K0 receipt 必须包含

```text
source identity/bytes
catalog primitive count = 1920
Product count（仅记录）
ProductID uniqueness
union(sceneAssetIndices) = [0..1919]
每个 task 的 start + phase pairs + one terminal
first Product/activation time
total cook time
slowest Product 与 slowest WASM plan
source/canonical/WASM/spill current/peak/limit
page count、spill reads/writes/releases
settled=true
disposed=true
```

#### 退出条件

- identity 与 terminal 的 L1 tests 通过；
- `web-authored-large-cook-k0` 在 clean revision 上通过一次；
- 没有 Renderer/GPU 依赖；
- workstream 删除 Product key collision 和 recoverable cook-complete 两个 open gate；
- K0 结果只作为 diagnostic/runtime cook evidence，不升级正式 PERF。

### 阶段二：实现 activation-first Product publication

#### 目标

将当前顺序：

```text
canonicalize -> WASM plan -> spill all pages -> publish descriptor/activation
```

改为：

```text
canonicalize -> WASM plan -> publish descriptor
-> materialize/spill activation pages -> Product activated
-> spill remaining pages -> release WASM payload owner
```

#### 代码改动

1. 从 `planIndependentProducts()` 删除 publication 前的 `revision.spillAllPages()`。

2. 保留 `WasmPlanPageSource.copyPage()` 的 inflight 去重和 spill read-through。Coordinator 收到 revision 后先发布 descriptor，再请求 activation page；这些 page 在 request 时 materialize、写入 spill、调用 `releasePage(pageId)`。

3. `onRevision(revision)` 返回表示 activation cut 已经完整发布。随后 Producer 再执行 `spillRemainingPages()`。Task phase 顺序改为：

   ```text
   canonicalize -> wasm-plan -> publish-activation -> spill-remainder -> completed
   ```

   若不修改 Phase V1 枚举，可保留 `publish`/`spill` 名称，但合同必须固定新顺序，receipt 不能继续假设 spill 在 publish 前。

4. spill remainder 先保持串行，避免在尚未测出真实 IO/内存峰值前引入并行。`copyPage()` 与 `spillRemainingPages()` 可能并发命中同一 page 时必须共用 `#inflight`。

5. 明确失败语义：

   - activation page 失败：该 Product 未激活，required coverage 失败；
   - activation 成功、remainder spill 失败：已发布 Product 可保留，但 session 不得 settled；
   - cancel/release：等待中的 OPFS put 不得在旧 generation 下重新获得 ownership；
   - 全部 page 已在 spill 后才允许释放 plan handle。

6. 不要在这个阶段引入多 Worker。先用 portable-single 证明 first activation time 和 Product cadence 获得改善，且 spill peak、checksum、generation、release 语义不退化。

#### 退出条件

- first revision 在 full spill 完成前可被 consumer 激活；
- activation pages 可 byte-exact 复读；
- remainder spill 失败不会产生成功 settled；
- cancel/release 后 spill current bytes 回到预期值；
- K0 的 first activation 和 total cook 分别记录，二者不再被一个 `spillAllPages` 阶段捆绑。

### 阶段三：把 Multi-Product Scene publication 改为增量路径

#### 目标

消除当前每个 Product 都执行 `merge(parts)`、release 旧 RenderWorld、stage 全 Scene、submit 的累计 O(N²) 路径。

#### 当前问题

`uploadWebCookedMultiProductScene()` 每收到一个 Product 都执行：

```text
parts.push
mergeVirtualGeometryProductSceneSourcesV1(parts)
replaceMultiProductScenePublication
release previous RenderWorld/assets/features
stage all current instances/assets
submit and wait
```

即使 Product 数只有 50–100，这仍会造成重复 CPU copy、GPU upload、pipeline publication 和 submit wait。

#### 代码改动

1. 引入 `MultiProductScenePublication` owner，持有 Product Table bindings、append-only asset/instance ranges、已发布 slots/generations、current instance count、GPU metadata capacity、pending append batch 和 submission retirement tokens。

2. 给 `GpuRenderWorld` 增加增量接口，只上传新 Product 的 asset/instance delta，并原子更新 active count/header。已有 instance、Product table slot 和 geometry residency 不重新编码。

3. 将 Scene source 从“每次构建一个新的完整 immutable array”改成 chunked immutable publication：历史 chunk 不变，新 Product 只追加一个 chunk；调试/恢复需要连续快照时再按需 materialize。

4. 每帧或每个固定时间窗批量提交多个已激活 Product，而不是每个 Product 单独 `command.finish()` + `await submitted`。batch 必须有上限：Product 数、metadata bytes 和最长等待时间任一达到阈值就 flush。

5. 自动推导 capacity：

   - planner/catalog 阶段输出 exact 或 conservative Product count estimate；
   - slot capacity 取 `nextPowerOfTwo(estimate + replacement headroom)`；
   - metadata bytes 从 assets/instances/hierarchy records 的 ABI stride 计算；
   - 与 negotiated `maxStorageBufferBindingSize`、`maxBufferSize` 和 runtime residency profile 比较；
   - 超限显式 unsupported/overflow，不依赖 authored case 传 `2048` 和 `128 MiB` magic numbers；
   - 若必须 grow，按几何级数重建一次并在 submission retirement 后释放旧 buffer，不能每 Product grow。

6. 保留 device-loss recovery：CPU 侧 chunk publication 是恢复源，不能把 GPU buffer 重新变成长寿命资产 owner。

#### 观测指标

```text
sceneAppendProducts
sceneAppendBatches
sceneAppendCpuMs
sceneAppendUploadBytes
scenePublicationSubmits
sceneCapacity/current/peak
fullRebuildCount
retiredPublicationBytes
```

#### 退出条件

- 第 N 个 Product 不再复制或重新上传前 N-1 个 Product 的 instance/asset 数据；
- steady append 不释放并重建完整 RenderWorld；
- Product count 从 50 增到 100 时 publication CPU/upload 工作接近线性增长；
- capacity 来自 plan + negotiated limits；
- K1 runtime smoke 覆盖 replacement、camera cut、device loss/dispose 和 feature-off。

### 阶段四：实现 session-local Product scheduler 与可控取消

#### 目标

在 bounded Product quantum 已成立后，让一个 CookSession 的不同 Product tasks 可以由 2 个起步的 Cooker Workers 并行处理，同时保持确定性 publication、内存上限和失败原子性。

#### 结构

```text
Session Coordinator
  ├─ catalog / priority / ProductWorkPlanner
  ├─ bounded Product task queue
  ├─ source/WASM/spill memory token ledger
  ├─ deterministic publication reorder buffer
  └─ terminal/coverage owner
          │
          ├─ Cooker Worker 0: one Product task
          └─ Cooker Worker 1: one Product task
```

#### 代码改动

1. 不再把完整 session pin 到一个 Worker。将 Worker 协议分成 session coordinator 命令和 serializable Product task 命令。Product task 至少携带 session/generation、taskId/productOrdinal、source identity/ranges、partition identity、recipe、work budget、spill owner token、priority 和 cancel generation。

2. Coordinator 保留 catalog、coverage、publication order 和 terminal 状态。Cooker Worker 只拥有当前 Product 的 canonical/WASM temporaries，不拥有长期 Product、Renderer 或 GPU 状态。

3. 先固定 `maxActiveProductTasks=2`。调度前同时领取 source、canonical、WASM、spill-inflight tokens；任一预算不足就等待，不能靠并发度乘出超限峰值。完成、失败和 terminate 都必须在 finally 归还 token。

4. 保持确定性：tasks 可以乱序完成，但 publication 根据稳定 priority/product ordinal 进入 bounded reorder buffer。visible-first task 可以优先发布，但最终顺序和理由必须写入 receipt。

5. 为不可抢占 WASM 建立明确故障域：

   - `CancelScope` 在 task 间协作处理；
   - watchdog 超时可 terminate 只承载该 Product 的 Worker；
   - coordinator 记录 `cancelled/worker-terminated` terminal event，归还预算并决定 retry/fail；
   - replacement Worker 使用新 task attempt/generation，旧完成消息被丢弃；
   - 不得因为一个 task 超时而 terminate 整个 WorkerPool 或让已完成 Products 失效。

6. `auto` profile 在 session-local scheduler 完成前不应把 `portable-pool` 描述为单 session 性能路径。完成后再按 capability 选择：low core/low memory 使用 portable-single；普通非隔离页面使用默认 2 tasks 的 portable pool；cross-origin isolated 页面在 pthread 与 Product pool 间按实测选择。concurrency 上限还要受 memory tokens 限制。

7. 把 bootstrap 排序升级为 visibility benefit 与 estimated cost 的组合。第一版使用稳定、可解释的 score：

   ```text
   benefit = cameraPriority + normalizedCoverage + instanceReuseBenefit
   cost = triangleWeight + canonicalByteWeight + domainWeight + spatialShardPenalty
   rank = benefit / max(cost, epsilon)
   ```

   保留 starvation age，避免小 Product 永久压住必要的大 Product。排序输入与最终选择必须进入 evidence。

8. C++ 子阶段 timing 放在此阶段补充。`CookGeometryAssetV3` 返回 meshlet build、group partition、simplify、LOD、hierarchy、serialize、page plan timing。只有真实 profile 指向某个子阶段后，才优化 Nyx 算法本身。

#### 退出条件

- 一个 session 可同时看到两个不同 Product tasks 在不同 Workers 运行；
- peak source/canonical/WASM/spill 仍不超过 ledger；
- 一个 Worker 卡死只终止该 task/attempt；
- publication/coverage/identity 在并发完成顺序变化时仍确定；
- 2 workers 相比 portable-single 改善 total cook 或 Product cadence，且内存峰值在预算内；
- 只有 2-worker 数据证明有收益后才评估 4 workers。

### 阶段五：按 K1、K2、S1 完成产品证明

#### K1：authored runtime smoke

K1 才创建 Renderer，并验证 first Product activation、incremental GPU admission/publication、first meaningful frame、camera movement、GPU page demand、ancestor fallback、camera cut recovery、full catalog settled、release/dispose 和零未处理 GPU/browser error。

K1 必须记录 Product cadence、scene append CPU/upload/submits、Product capacity、source/decode/cook/upload throughput 和所有 owner peak。若增量 publication 尚未完成，不得用 K0 的 first frame 表示 K1 已通过。

#### K2：authored formal PERF

只有 K0/K1 在同一候选 revision 上通过后才运行：

```text
1920x1080
120 warmup frames
480 sample frames
3 independent runs
timestamp-query required
fixed adapter/browser/display/camera/features/workload
CPU frame/build/submit P50/P95
GPU frame/phase P50/P95
TTFMF、total cook、Product cadence
memory owner peaks、page demand/churn/overflow
camera-cut recovery
```

不得用 CPU 时间替代缺失的 GPU timestamp，不得把 dirty run 或 K0 diagnostic 晋升为 PerformanceEvaluated。

#### S1：deferred 100M

100M single-giant 只在 authored K2 接受后运行。它验证规模扩展和 scratch/partition working set，不得反向阻塞当前 4.87M authored 目标。250M/500M/1B 继续保留为更后的 scale evidence。

#### 最终退出条件

- K0 证明 bounded Producer、coverage、identity、spill 和 terminal；
- K1 证明 production renderer consumer 与 lifecycle；
- K2 证明固定条件下的真实性能；
- 每一级只声明自己实际证明的 assurance；
- active workstream 中 K0/K1/K2 的 task 和 open gates 与 evidence 同步关闭。

## 5. 建议修改顺序与文件范围

| 顺序 | 主要文件 | 产物 |
| --- | --- | --- |
| 1 | `WasmGeometryProductV1.ts`、`NyxWebRuntimeCooker.ts`、identity/oracle tests | partition-scoped ProductID V2 与 collision proof |
| 2 | `WebCookCoordinator.ts`、独立 K0 case/main、K0 workload | 纯 Producer K0 与严格 terminal receipt |
| 3 | `NyxWebRuntimeCooker.ts`、`WasmPlanPageSource`、spill contract/tests | activation-first 与 remainder spill |
| 4 | `MainRenderPipeline.ts`、`GpuRenderWorld.ts`、`GeometryProductMultiRuntime.ts` | append-only/chunked GPU publication 与自动 capacity |
| 5 | Worker protocol/host/pool/factory、budget ledger | session-local 2-worker scheduler 与 task-level termination |
| 6 | K1 case/workload，然后 K2 formal case | runtime 和 formal PERF evidence |

每个代码切片仍遵循仓库工作流：修改前对目标路径运行 `node tools/vibe.mjs context <path>`，修改后运行 `node tools/vibe.mjs verify --changed`。浏览器 K0/K1/K2 必须由独立 validation host 产生 evidence。

## 6. 本次审计验证范围

本次在 HEAD `3c0fada7a994f70dbdf619ce6107957ba39adc95` 上执行完整 L1 gate：

```text
node tools/vibe.mjs verify
```

结果：

```text
499 passed
0 failed
model/registry/evidence/guards passed
```

本次没有运行 authored-large 浏览器 K0、K1 或正式 PERF，因此不能把 ordinary Product identity、terminal fix 或整个 ADR-0018 标记为 RuntimeValidated/PerformanceEvaluated。
