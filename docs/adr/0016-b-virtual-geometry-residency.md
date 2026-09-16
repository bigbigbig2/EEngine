# ADR-0016-B: Geometry Product Admission 与 Virtual Geometry Residency

Status: accepted

## Context

Web Runtime Cooker 产生的 live product 与 OEGPACK 解码页具有不同的来源和到达方式，但它们都必须经过同一准入、物理页管理和发布状态机。若 Runtime 直接依赖文件 offset、Worker message 或 Cooker 内部对象，就会把 producer 差异扩散到 GPU owner，并使 revision 替换、取消和 device loss 无法统一。

## Decision

在 producer 与 renderer 之间建立生产者无关的 Geometry Product admission。Producer 只提供不可变 descriptor、按 `ProductID + revision + PageID` 寻址的 decoded page，以及 revision 可激活条件；GPU owner 验证合同后才为其建立 resident generation。

Runtime 使用固定 slot bank 管理首版 256 KiB decoded geometry page。GPU 可见地址表达 bank/slot、generation 和 flags；逻辑页经过 requested、producing/reading、verified、uploading、resident、retiring/failed 状态。只有 descriptor/page 校验、GPU upload 和地址表写入全部编码后，才能在未来冻结 frame revision 中原子发布。

每个 product revision 声明有界 activation cut。bootstrap 或替换 revision 只有在该 cut 完整 resident、依赖的材质/decode profile 可用且预算准入成功后激活。旧 active revision 在新 revision 激活失败时继续工作；成功切换后先撤销旧映射，再经过 submitted-work 安全边界回收 slot。

GPU traversal 产生有界、去重且带 frame/product generation 的 page demand。CPU 读取延迟 feedback 只安排 source/cook/decode/upload，不重建最终可见 Meshlet 列表。缺页时必须使用 resident ancestor/bootstrap fallback 或 fail closed。

source adapter 允许 HTTP/memory GLB live cook、OEGPACK Range、可选 cache 等实现，但不得改变共同状态机。Worker/IO/upload 服从联合 byte credit、并发、队列、每帧 upload/readback 和 pinned budget；OPFS 失败不影响 correctness。

Residency 的算法语义按 Nyx `GeometryStreaming::Initialize/PinRootPages/Update/SyncMemoryAndAddressTable/EnqueueAsyncLoad/OnPageIOComplete/ImmediateEvict` 逐项移植。WebGPU 只能改变 I/O API、readback ring、bank/slot 地址和提交安全边界；不得把 Nyx 的 request mask、root/bootstrap pin、失败不发布、revoke-before-reuse、ancestor fallback 或 generation 语义简化成整包常驻或无状态上传。

## Consequences

需要为 product、revision、page、slot、feedback 和异步任务定义 generation，丢弃过期结果并阻止 ABA。bootstrap pin 不是无限常驻特权，admission 必须在开始前证明全局 pinned budget 可容纳完整 activation cut。

Web live source 可以在内部优先 Cook 尚无 PageID 的区域；只有 descriptor 冻结后，GPU demand 才能按稳定 PageID 接管优先级。WASM/Worker 只交付 CPU buffer，现有 render/GPU owner 独占 `GPUDevice`、heap 与 publication。

精确合同由 [Geometry Product V1](../specs/geometry-product-v1.md) 和 [Virtual Geometry Runtime V1](../specs/virtual-geometry-runtime-v1.md) 管理。

## Verification

验证两类 producer 的 conformance、descriptor/page corruption、重复和过期 request、capacity/overflow、pinned/admission budget、backpressure、upload/readback 上限、取消、source failure、replacement、eviction race、aborted submit、device loss/recovery 与 feature-off。MILESTONE 必须证明 `GPU desired LOD -> demand -> producer/source -> resident publication -> 同一 GPU consumer` 闭环。
