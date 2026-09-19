# ADR-0017: Geometry Product 增量发布与页身份解耦

Status: proposed

## Context

当前 Web Runtime Cooker 与 Offline Cooker 都是单体式 cook：一次调用读入完整 canonical 输入，算完全部 Group、完成全局 page 装箱，再一次性交出 descriptor 与全部 page payload。`AssembleDecodedGeometryProductV1` 的结构决定了这一点：page 采用全局 best-fit 装箱，PageID 由装箱后 stable sort 的位置确定，`decodedHash128` 又是对整页 bytes 求 SHA-256。

结果是两条强耦合：第一，descriptor 必须等全部 asset cook 完才能冻结，任何 page 都无法在 descriptor 之前被地址化；第二，page hash 依赖整页 payload，使“先冻结 ID graph、再补 payload”在同 revision 内无法成立。因此 producer 只能退回到“bootstrap revision + 完整 revision 原子替换”，即 ADR-0016-C 的路线。该路线在语义上是正确的，但它把全部精化工作压缩成一次不可中断的 cook：可见的只有首帧 cut 与最终结果之间的长空档，中间没有任何 page 可以提前上线。

ADR-0016 已把 page 级 residency、GPU demand 回读、eviction 与预算控制建设完成。真正缺失的不是消费侧机制，而是 producer 侧的发布粒度：descriptor 无法先于 payload 冻结，page 无法独立于全局装箱被地址化和校验。本 ADR 决定解除这两处耦合，使一个 revision 内的 page 可以按 demand 增量产生。

## Decision

Geometry Product 改为增量发布：descriptor 先于 payload 冻结，page 按 demand 独立产生并在同 revision 内补齐。

引入显式两阶段 cook。descriptor 阶段只确定 ID graph：AssetRecord、HierarchyNode、GroupDirectory、PageID 分配、page 到 Group 的映射、activation cut 与 page identity。payload 阶段按 PageID 产生字节。两阶段之间 descriptor 不可变，payload 阶段不得改变任何 identity。

解除 page hash 对整页 payload 的依赖。page identity 改为由构成该页的 Group payload 摘要按确定性顺序上卷得出，使 hash 可在 payload 阶段之前计算并写入 descriptor。整页 bytes 仍可作为传输与上传的校验对象，但不再是 identity 的来源。装箱算法必须保持确定性：相同输入必须得到相同 PageID、相同 Group 归属与相同 identity。

修订 Geometry Cooker ABI，使 descriptor 与 page 可分离取得。descriptor 阶段结束后必须能独立查询 page 数量、page identity 与 page 到 Group 的映射；payload 阶段必须支持按 PageID 单独推进，且允许多次推进、乱序推进与重复推进。ABI 必须显式表达“descriptor 已冻结但 payload 未产出”这一状态，消费侧据此区分“页不存在”与“页存在但尚未产出”。

消费侧合同保持既有分层不变。`readPage()` 仍可推迟完成，仍须返回与 descriptor identity 一致的字节；admission、residency、eviction、demand 回读与预算模型不变，只把“page 何时被产生”作为新的可调度维度。activation cut 仍是激活前的完整 resident 要求，不因增量发布而放宽。

Nyx 算法移植边界不放宽。两阶段拆分只允许改变“何时计算、何时交付”，不允许改变 meshlet 构建、LOD 简化、Group 划分、page-local payload 与 fixed-page independence 的任何语义。descriptor 阶段不得为了提前冻结而省略或近似任何 Nyx 阶段。

## Consequences

首帧之后 page 可以持续上线，精化不再是不可中断区间。producer 可以按 GPU demand、camera 与优先级安排 payload 阶段，使 cook 成本与可见性对齐，并降低全量精化的内存峰值。

代价是 descriptor 阶段的实现复杂度上升：它必须在不生成 payload 的前提下确定 page 装箱、PageID 分配与 identity，而当前装箱是 payload 驱动的。identity 上卷的引入使 page hash 语义发生变化，需要同步 descriptor 校验、residency hash 校验、缓存 key 与 OEGPACK 适配。

ABI 版本必须递增，旧 consumer 必须被显式拒绝而不能静默降级到单体式 cook。已经冻结的 descriptor 与 page identity 必须保持跨会话可复现；两阶段引入的任何并行度都不得破坏确定性。

本决策不改变 ADR-0016-C 的原子切换语义：revision 内增量发布与 revision 间原子替换是互补的两层。多 Product 并发、超大 primitive 的空间分片与跨 Product 内存压力不在本决策范围内。

精确合同由 [Geometry Product V1](../specs/geometry-product-v1.md) 管理。

## Verification

必须证明 descriptor 阶段可在不产生 payload 的情况下冻结完整 ID graph，且其 PageID、Group 归属与 activation cut 与单体式 cook 结果一致。必须证明 identity 上卷与整页校验语义等价，并用 golden bytes 固定 descriptor 与 page identity。

必须覆盖按 PageID 的乱序、重复、并发与取消推进，descriptor 冻结后请求不存在 PageID 的拒绝，以及 payload 阶段失败时已产出 page 不被污染。必须在真实浏览器证明同一 revision 的 page 可以逐批上线并被 GPU demand 正确消费，且 activation cut 完整前不激活。

必须证明增量发布下的 descriptor、PageID 与 identity 在相同输入上可重复，且 producer 在不同 Worker/线程数下得到相同结果。Nyx 算法不变量与既有 differential corpus 必须继续通过，拆分不得改变任何 geometry 输出。
