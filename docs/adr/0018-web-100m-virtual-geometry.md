# ADR-0018: Web 100M+ Virtual Geometry 可扩展生产与分片运行时

Status: proposed

## Context

ADR-0016 与 ADR-0017 已经建立 Geometry Product、page 级物理驻留、GPU demand、ancestor fallback、增量发布和 revision 间原子替换，但当前 Web Runtime Cooker 仍可能同时持有完整 canonical 输入和用于未来 page materialization 的全部 `retainedGroups`。单个超大 primitive 也仍可能成为不可拆分的 cook unit。逻辑场景扩大到 100M+ source triangles 后，CPU、WASM 和 Product 元数据峰值因此仍会随总场景规模增长，GPU 端已有的 bounded residency 无法单独解决 producer 峰值。

本决策的研究依据与完整备选分析保留在 [Web 100M+ Virtual Geometry Architecture 研究稿](../reviews/ADR-0018_Web_100M_Virtual_Geometry_Architecture.md)。该研究稿不是实现状态或 ABI 权威；本 ADR 只提炼长期架构取舍，精确布局仍须进入 `docs/specs/`，实施状态由 `project/workstreams/active/web-100m-virtual-geometry.yaml` 管理。

主产品路径继续是浏览器直接加载 GLB/glTF 并进行 runtime cook。Offline Cooker 与 OEGPACK 是预处理、CDN 和确定性 artifact 路线，不成为使用 100M+ geometry 的前置条件。Nyx 的 meshlet、group、attribute/seam lock、simplification、hierarchy、BVH、fixed page 和 fallback 不变量继续作为算法基线；DX12 bindless、mesh shader、native mmap 和固定超大 chunk pool 不直接移植到 WebGPU。

## Decision

100M+ 主路径采用“metadata catalog → spatial planning → bounded source/canonical window → Nyx-derived shard cook → cook-and-spill → incremental ProductShard publication → multi-Product runtime → bounded GPU working set”。逻辑 geometry 规模不得决定 live payload working set。

### Bounded producer

- Scene Catalog 只读取 scene graph、primitive/accessor 元数据、bounds、material 与 source byte ranges，不 materialize 全量 geometry payload。
- source、canonical、WASM cook、serialized group、spill encode 和 decoded page 各有独立 owner budget；每个 owner 必须暴露 current、peak、limit 和 owner count。
- primitive 不是最终 Product unit。超过预算的 primitive 按确定性空间规则切为 triangle-owned shards；边界 vertex 可以复制，但不得存在跨 shard 可变 vertex ownership。
- shard 保留 Nyx 的 material、attribute、seam、simplification 和 hierarchy 不变量。sharding 只改变生产粒度，不改变算法语义。

### Cook-and-spill

- shard 生成的 immutable page artifact 在完成 pack/checksum 后写入 spill store，并立即释放 source window、canonical buffer、meshopt temporary、serialized group payload、page scratch 与 compression scratch。
- runtime cook 首选 OPFS spill；memory backend 用于小模型、测试和 fallback，Blob/File 与 HTTP/CDN provider 使用同一 Product/Page consumer contract。
- page artifact 的版本、Product/shard identity、Product-local PageID、codec、decoded identity、payload checksum 和压缩 payload 必须由后续 spec 精确规定。
- completed shard payload 不得仅为了未来 `readPage()` 长期保留在 WASM 中。

### Multi-Product runtime

- 一个 Scene 可以同时引用多个独立 ProductShard。instance geometry identity 为 `(ProductTableSlot, ProductGeneration, AssetRecordIndex)`。
- PageID 保持 Product-local；page identity 为 `(ProductTableSlot, ProductGeneration, PageID)`，不得把所有 Product 拼成全局 PageID 空间。
- ProductShard 支持独立 publish、activate、replace、evict、dormant、release 和 stale-generation rejection。现有 activation cut、ancestor fallback 与 revision 原子切换语义不放宽。
- GPU Product Table、metadata ranges、page-location table和 generation 的精确 ABI 在实现前单独评审并进入 spec/contract。

### Scheduling and WebGPU execution

- visible/near/bootstrap shard 优先于后台 shard，100M 场景无需等待全量 cook 即可产生 first meaningful frame；禁止退回简单 FIFO。
- GPU page demand 使用 Product-local request mask 或等价 GPU 去重结构，经 GPU compaction 形成有界 Top-N priority records，再进行延迟 CPU readback。CPU readback只用于异步调度反馈。
- IO concurrency、in-flight bytes 与 upload bytes/frame 根据 camera cut、IO/Worker throughput、GPU pressure 和 frame time 动态调整。
- physical residency 依据协商后的 WebGPU limits 和实测 evidence 选择 Portable、Balanced 或 HighEnd profile；不得根据物理 VRAM 假设浏览器可分配额度，也不得改变 Product ABI。
- WebGPU 继续使用 compute work generation 与 indirect raster。current-HZB late recheck、raster bucket 和 selective primitive culling 是有证据后采用的优化，不是 100M producer 正确性的前置条件。

### Delivery order

实施严格按 active workstream 的依赖推进：先建立 100M workload、observability 和精确 failure owner，再完成 canonical windowing、giant primitive sharding、cook-and-spill、multi-Product runtime 与 visible-first scheduler；之后才处理 demand compaction、adaptive residency、current-HZB、dynamic scheduler、正式 PERF、raster bucket 和 250M/500M/1B 扩展验证。

## Consequences

主线程、Worker、WASM 与 GPU 的 live payload 可以由预算约束，而不是由场景总 triangle 数约束；visible ProductShard 可以先发布，首个有意义帧不再等待整个场景 cook 完。OPFS 或远端 page provider 也能复用统一 consumer，使 runtime cook 与 offline cook 在实现上分离、在 Product/Page contract 上收敛。

代价是 producer 从一次性调用变成跨 Catalog、Planner、Worker、Spill Store、Product Table 和 Page Scheduler 的分布式状态机。shard identity、边界 correctness、失败原子性、取消、重试、跨会话缓存、budget accounting 和 stale generation 都必须显式建模；元数据本身虽然可以随总场景增长，但任何 total-scene-scale allocation 都必须证明它是有界记录的 metadata，而不是 payload。

本决策不重写 Geometry Product 的基本语义，不允许 CPU 构建最终可见列表，不引入 Gameplay/ECS 生命周期，也不默认启用 mesh/task shader、64 位原子、BDA 或 multi-draw。100M 是第一个正式目标；250M、500M 和 1B logical 在 100M PERF 冻结后用于验证 working-set 解耦，不用于提前扩大实现面。

在 ADR 仍为 `proposed` 时，它不能覆盖现有 accepted 决策或证明任何能力完成。只有 workstream task、对应 contract/oracle、独立 browser case 和当前 revision evidence 可以提升完成状态。

## Verification

Phase A 必须首先产生可复现的 100M workload，并把失败定位到 Catalog、range read、canonical input、WASM、meshlet/simplification、retained groups、descriptor、admission、GPU metadata 或 residency 的精确 owner，同时记录 owner peak；只有 `OOM` 结论不算证据。

实现必须用 contract/oracle 固定以下性质：bounded source/canonical/cook 峰值；single giant primitive 的多 shard 输出；bounds、seam、material、hierarchy、page independence 与 determinism；spill 后 exact page re-read 和 stable identity/hash；至少 64 个 ProductShard 的独立 load/replace/evict/release；stale generation rejection；activation cut 与 ancestor fallback；demand 去重、容量、溢出和有界 readback；不同 Worker/profile 下的相同 Product 结果。

真实浏览器验证只能在独立 `validation/` 宿主运行。正式 100M evidence 必须冻结 revision、browser、adapter、resolution、DPR、camera path、feature set 与 workload hash，并采集 TTFMF、CPU/GPU P50/P95、source/canonical/WASM/JS/GPU peaks、page demand/churn、overflow 和 camera-cut recovery。10M 用于开发回归，100M 是 ADR 完成的最低正式门槛，250M 验证扩展性，500M 与 1B logical 在前述门槛通过后作为诊断/扩展证据。

Nyx differential 始终是硬门禁。任何 sharding、spill、并行或 scheduler 改造都必须保持 meshlet invariants、Group ownership、refine relation、LOD error monotonicity、conservative bounds、hierarchy reachability、material boundaries、page independence 与 determinism；缺少源函数/entry point、条件、数据依赖、差异、fallback 和验证映射时不得宣称迁移完成。
