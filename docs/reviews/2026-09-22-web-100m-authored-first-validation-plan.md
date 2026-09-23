# ADR-0018 Authored-Large Acceptance Plan (2026-09-22)

> 本文记录当时的实施顺序与早期故障。当前执行目标只有用户的 `large.glb`；
> 最新任务和验收状态以活跃 workstream、当前 revision 的 evidence 为准。

## Decision

ADR-0018 的当前正式目标改为真实 authored 场景：

```text
large.glb
477,591,060 bytes (about 455 MiB)
4,871,612 triangles
1,920 primitives
maximum primitive = 1,364,306 triangles
```

该规模必须能在普通 Chrome 中稳定完成 load → runtime cook → progressive publish →
multi-Product render → streaming → dispose。

## Diagnosis

GPU Virtual Geometry、Multi-Product、Residency 和统一渲染管线不推翻。当前 stopped
run 长期停在 `units=3`，最可能暴露 CPU/WASM producer 的结构缺口：

1. sharding 只看 source/canonical bytes，未限制 triangle/vertex/domain cook work；
2. ordinary 64 MiB window 也可能成为包含许多 domains 的同步串行任务；
3. `_oengine_web_geometry_cook_plan()` 执行期间 worker event loop 不可处理取消消息；
4. `units` 是 catalog primitive coverage，不是 Product/shard/phase progress；
5. session spill budget 从 per-Product decoded budget 推导，完整场景可能耗尽；
6. coverage-first bootstrap 未考虑 estimated cook cost，重 primitive 可能过早执行。

因此不能继续通过增大 watchdog、改成 portable-pool 或反复打局部补丁来解释问题。
首先必须把同步 Product 变成有界 work quantum。

## Frozen implementation target

### Product Work Planner

Spatial shard 与 ordinary batching 共用：

```text
maxCanonicalBytes      = 32 MiB
maxTrianglesPerProduct = 128 Ki
maxVerticesPerProduct  = 512 Ki
maxDomainsPerProduct   = 64
```

单 primitive 超过任一限制就切；ordinary window 添加下一 domain 会超过任一限制就
flush。详细合同见 `docs/specs/web-geometry-product-work-budget-v1.md`。

### Product Task Trace

每个 task 必须显示 Product/primitive/shard identity、triangles、vertices、domains、
canonical bytes、当前 phase、phase elapsed，以及 canonicalize/WASM/spill/publish
耗时、page count 和 spill bytes。`units` 只能保留为 coverage counter。详细合同见
`docs/specs/web-geometry-product-task-trace-v1.md`。

### Spill and publication

`maxDecodedProductBytes` 与 `maxSessionSpillBytes` 分开。authored 首轮 session budget
为 1 GiB，并记录真实 peak。Product 应先 publish activation/descriptor，再继续 spill
非 activation pages；取消、release、checksum 和 generation 语义不能放宽。

## Validation ladder

| Gate | Scope | Required result |
| --- | --- | --- |
| K0 | authored cook | 全 1,920 primitive coverage、实际 Product count、task trace、first Product/total cook、owner/spill peak、settled、dispose |
| K1 | authored runtime smoke | production renderer、first frame、movement、page demand、fallback、camera cut、无 GPU error、dispose |
| K2 | authored formal PERF | 1080p、120 warmup、480 samples、3 runs、timestamp、CPU/GPU P50/P95 |

K0 的正确断言是：

```text
union(every Product.sceneAssetIndices) == all 1,920 catalog primitive indices
```

必须删除 `minimumExpectedProducts: 1920`。1920 primitives 可以合理合并为几十到约
一百个 Product；强制 1920 Products 会放大当前 full scene republish 的 O(N²) 债务。

K0 workload 与 `web-authored-large-cook-k0` executable case 已登记。validation page
必须断言 coverage、task trace、spill accounting、settled 和 disposal，避免
placeholder 假通过。

## Work order

```text
test contract and catalog coverage
  -> Product task/phase evidence
  -> four-dimensional Product Work Planner
  -> separate 1 GiB session spill budget
  -> authored cook K0
  -> activation-first publication
  -> authored runtime smoke
  -> authored formal PERF
  -> profile material, publication, cook tail, memory and frame time
  -> decide whether session-local Product scheduling is justified
```

Session-local parallelism 由 K2 profile 决定；增加 worker 前先确认 Product 长尾、
内存峰值和首次有效画面的瓶颈。

## Historical status

- A–J 已完成的 GPU/runtime 架构和 contract/oracle 保留。
- 现有 stopped run 只是调试 trace，不是 K0 pass。
- K0 work-budget、trace、coverage 和独立 session spill 已实现并通过 engine suites；
  `web-authored-large-cook-k0` 首次运行在 bounded `product-31` 的 spill 阶段失败。
  该 Product 只有 110,742 triangles、182,089 vertices、3 domains 和 14,439,552
  canonical bytes，canonicalize/WASM 分别约 225/491 ms，因此本次不是大同步任务长尾。
  失败是 ordinary window provisional ProductID 碰撞后读到 decoded hash 不同的 OPFS
  page；随后 producer 被记为 recoverable `cook-complete`，但 full-catalog settled 无法达到。
  该运行仅为 diagnostic，不得升级 Runtime Validated 或 Performance 声明。
- `web-authored-large-perf` 已成为当前 L4 promotion case，共享页面已经消费 catalog
  coverage、32 MiB canonical、128K triangle 和 task trace 合同；但 K0/K1 尚未产生
  browser evidence，因此仍不得运行正式采样或解释为完成。
这些故障和当时的待办已由后续实现处理，不能代表当前完成状态。当前只运行
`large.glb` 的 K0/K1/K2；以活跃 workstream 和当前 clean revision evidence 判断通过。
