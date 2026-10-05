---
id: adr/0018-web-100m-virtual-geometry
state: current
verifies:
  - project/workstreams/active
---
# ADR-0018: Web `large.glb` Virtual Geometry 生产与分片运行时

Status: proposed

## Context

ADR-0016 与 ADR-0017 已建立 Geometry Product、page 级物理驻留、GPU demand、
ancestor fallback、增量发布和 revision 原子替换。当前目标是让浏览器稳定处理
用户提供的真实 authored 场景：

```text
large.glb
477,591,060 bytes (about 455 MiB)
4,871,612 triangles
1,920 primitives
maximum primitive = 1,364,306 triangles
```

现有 GPU Virtual Geometry、Multi-Product、Residency 和统一渲染管线继续保留；
验收重点是 CPU/WASM producer 的任务粒度、同步调度、spill budget 和可观测性。

研究依据与完整备选分析保留在
[ADR-0018 架构研究稿](../reviews/ADR-0018_Web_100M_Virtual_Geometry_Architecture.md)。
精确合同位于 `docs/specs/`，实施状态由
`project/workstreams/active/web-100m-virtual-geometry.yaml` 管理。

主产品路径继续是浏览器直接加载 GLB/glTF 并 runtime cook。Offline Cooker 与
OEGPACK 是预处理、CDN 和确定性 artifact 路线，不成为 authored 目标的前置条件。
Nyx 的 meshlet、group、attribute/seam lock、simplification、hierarchy、BVH、fixed
page 和 fallback 不变量继续作为算法基线。

## Decision

当前正式目标采用：

```text
metadata catalog
  -> Product work planning
  -> bounded source/canonical window
  -> Nyx-derived shard cook
  -> activation-first Product publication
  -> cook-and-spill
  -> multi-Product runtime
  -> bounded GPU working set
```

ADR-0018 的当前完成声明只针对上述 `large.glb` 及其生产、渲染、性能和释放证据。
100M 仍是最终人工验证目标，待用户提供代表性模型后再单独冻结来源和验收条件；
当前不生成、不挂载、不运行合成 100M 模型。

### Partition quality and physical budgets

- Product budget 是可测量、可调整的 workload policy。128 Ki triangles 只是 authored
  起始值；调整时同时比较 cook 长尾、首个 activation、Product/root/metadata 数量、
  边界顶点重复及驻留成本。跨 shard 的 seam、保守 bounds、LOD error 和 fallback
  连续性必须通过 contract/oracle 与代表性视角验证，不能以更小 Product 自动推导更优。
- 所有 GPU allocation/capacity 必须从计划和实际 negotiated device limits 推导。
  OPFS session limit 是应用上限，不是浏览器授予的容量；使用 storage estimate 记录
  quota/usage，写入仍处理 quota failure，并验证取消、释放、旧 generation 与部分失败。
  CPU/source/canonical/WASM、spill 与 GPU 预算分别记账；并发任务共享总预算。

### Product work policy

- Product 同时受 canonical bytes、triangle count、unique vertex count 和 domain
  count 约束，禁止继续只按内存窗口定义任务大小。
- authored V1 初始预算为 32 MiB canonical、128 Ki triangles、512 Ki vertices、
  64 domains。它们是 workload policy，不是 Product ABI。
- 单 primitive 超过任一限制就必须 spatial shard，即使实际 indexed canonical bytes
  小于 byte limit。
- ordinary primitive batching 使用同一 work planner；达到任一限制就 flush。
- 具体规则由
  [Product Work Budget V1](../specs/web-geometry-product-work-budget-v1.md) 冻结。

### Product task observability and cancellation

- `units` 仅表示 catalog primitive coverage，不得替代 Product/shard progress。
- 每个 Product 暴露 primitive/shard identity、triangles、vertices、domains、canonical
  bytes，以及 `canonicalize`、`wasm-plan`、`spill`、`publish` 阶段和耗时。
- 同步 WASM 当前不可抢占；watchdog 只能检测并归因，不能把 cancel request 写成
  cook 已终止。真正有界的取消延迟依赖先把 Product work quantum 缩小。
- 结构化事件见
  [Product Task Trace V1](../specs/web-geometry-product-task-trace-v1.md)。

### Spill and publication

- `maxDecodedProductBytes` 是单 Product budget；`maxSessionSpillBytes` 是完整 session
  的 spill budget，二者必须分离。
- authored K0 初始 session spill budget 为 1 GiB，并记录真实 current/peak/limit。
- Product descriptor/activation 应先 publish；非 activation page 可在 generator 恢复后
  spill。不得因 `spillAllPages()` 阻止首个可见 Product 发布。
- page identity、checksum、generation、release 和 stale result 规则保持不变。

### Multi-Product runtime

- 一个 Scene 可引用多个独立 ProductShard，instance identity 为
  `(ProductTableSlot, ProductGeneration, AssetRecordIndex)`。
- PageID 保持 Product-local；ProductShard 支持独立 publish、replace、evict、release
  和 stale-generation rejection。
- 增量 Scene publication 应只处理新增 Product，并保持既有 Product 的稳定身份；
  性能结论由 `large.glb` 的 K1/K2 浏览器证据确认。

### Scheduling

- visible-first 排序必须综合 visibility benefit 与 estimated cook cost，避免 coverage
  最大的重 primitive 过早独占 worker。
- `portable-single` 是 authored K0 的 compatibility/bounded-latency profile，不是最终
  性能 profile。
- 当前 `portable-pool` 只做 session-to-worker pinning，不能作为 session 内 Product
  并行的完成证据。只有 work quantum 有界、K0 通过后，才实现 session-local Product
  scheduler；先取得 K2 profile，再决定是否从 2 workers 开始评估。

## Validation ladder

### K0 — Authored cook

`web-authored-large-cook-k0` 只证明完整 cook、全 primitive coverage、任务
阶段证据、owner/spill budget、settled 和 disposal。它不要求 timestamp、120-frame
warmup、480 samples 或 3 runs。

K0 的验收条件是：

```text
union(all Product.sceneAssetIndices) covers all 1,920 catalog primitives
```

而不是：

```text
Product count >= 1,920
```

Product/shard count 只记录真实值。K0 的 workload 与 executable case 已登记，
页面必须强制上述断言，禁止可误通过的 placeholder。

### K1 — Authored runtime smoke and producer closure

K0 后验证 Multi-Product renderer、first frame、camera movement、page demand 和 fallback，
并关闭 activation-first publication、planner scratch/cleanup、自动 capacity、真实
IO/decode/upload telemetry 等债务。

### K2 — Authored formal PERF

`web-authored-large-perf` 是当前 `virtual-assets.performance` 的 L4 promotion case。
它在 K0/K1 通过后，冻结 clean revision、Chrome、adapter、display、camera、feature、
workload identity，执行 warmup、多 run、CPU/GPU P50/P95 与 camera-cut 测量。共享
页面按 authored workload 验证 coverage 与 work budget。正式 promotion 仍要求
当前 clean revision 的完整 preflight 和浏览器记录。

完整验收字段和晋级边界见
[Authored Large Gate V1](../specs/web-geometry-authored-large-gate-v1.md) 与
[Formal PERF Freeze V1](../specs/web-geometry-formal-perf-freeze-v1.md)。

## Consequences

当前工程焦点是 `large.glb` 的有界 Cook quantum、首次有效画面、完整渲染与
K2 性能长尾。额外的大规模数据集不进入本工作流。

代价是 producer 需要新的 work planner、task trace、session spill accounting 和
activation-first lifecycle。任何 sharding、spill、并行或 scheduler 改造仍必须保留 Nyx
的 meshlet invariants、Group ownership、refine relation、LOD error monotonicity、
conservative bounds、hierarchy reachability、material boundaries、page independence 与
determinism。

在 ADR 仍为 `proposed` 时，它不能证明任何能力完成。只有 workstream task、对应
contract/oracle、独立 browser case 和当前 revision evidence 可以提升完成状态。

## Verification

实现前的机器合同必须冻结 source identity、work budgets、task phases、catalog coverage
语义和 promotion routing。实现后依次要求：

1. planner contract/oracle 证明 spatial 与 ordinary batching 同时遵守四维 budget；
2. task-trace contract 证明每个 Product 有 identity、phase、timing 和 terminal state；
3. spill contract 证明 per-Product 与 per-session budget 分离且 cleanup 正确；
4. authored K0 证明全 1,920 primitive coverage、settled、bounded owner peaks 和 disposal；
5. runtime smoke 证明生产 GPU consumer、page demand 和 camera movement；
6. authored formal PERF 形成当前目标的 L4 evidence；

真实浏览器 evidence 只能来自独立 `validation/` 宿主。文档更新、旧日志、停止的运行、
`units=3` 或 Product 数量猜测都不能单独提升 authored 目标。
