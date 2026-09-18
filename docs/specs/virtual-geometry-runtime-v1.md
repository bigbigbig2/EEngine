# Virtual Geometry Runtime V1

Status: draft

Owners: geometry admission/residency owner、`GpuAssetStore`、GPU hierarchy/work owner

## Version/Compatibility

本规范消费 [Geometry Product V1](./geometry-product-v1.md)，不直接依赖 GLB、WASM Worker、OEGPACK 文件或 cache。V1 只支持 `oengine-vg-v1-v3-decoded`，因此 decoded page 固定 256 KiB，并复用 OEGPACK V3-compatible hierarchy/Group/Meshlet consumer。

本文件冻结状态机、queue 和 publication 语义。GPU-visible layout 中已明确的记录必须按下文实现，包括下述 Product table 与 asset reference；它们需要 TypeScript mirror、WGSL oracle 和 version gate。V1 不改变 VisibilityKey、material identity 或 Sparse Shading ABI。

## Nyx Runtime 移植边界

Residency、GPU traversal 和 Visibility consumer 的算法来源是用户提供的本地 Nyx 只读快照，具体源文件与 producer hash 见 [Geometry Product V1 的 Nyx provenance](./geometry-product-v1.md#nyx-provenance-与移植合同)。Runtime 必须逐项移植：`GeometryStreaming.cpp`（`acb3aa4786eb6367e92b99e9e295c83e0aade516d59578f23ff38496f838a072`）和 `.h`（`4bee73ffc0c29ad7670bb7c5ac1567a281b3f33271adfc534d834dc88897c264`）的初始化、root pin、request mask、延迟 readback、page I/O、publish/revoke/evict；`DAGCull.slang`（`6534dd8794248d693acd07488653a625df3b4fac11117f96537a43857dcfee7e`）的 `ProcessNodeBatch`、`ProcessMeshletBatch`、`computeMain`；以及 `VBufferMesh.slang`（`9f374a2437d5ab939ae4d98289c150097bdab17305191ff97abf3fd1d13c621d`）的 `BuildVertexOutput`、`meshMain`、`pixelMain`。

WebGPU 适配只允许改变 DX12/Slang 的资源绑定、mesh shader/DispatchMesh 表达、I/O API、GPU address 表达和 fence/lifecycle API。request mask、wavefront/bounded reservation、SSE/HZB、resident ancestor fallback、refinement request、page-independent validation 和 local primitive identity 不得被 CPU visible-list、整包常驻、单层 frustum、普通 per-object draw 或无状态上传替代。没有 source function map 和 CPU/WASM/WGSL differential oracle 的实现不得提升为 candidate。

## Contract

### Owner 边界

| Owner | 拥有 | 不拥有 |
| --- | --- | --- |
| Product Provider | immutable descriptor、decoded page 生产、source/cook/cache 生命周期 | GPU object、physical slot、frame publication |
| Admission | descriptor validation、budget reservation、product generation、replace transaction | 文件格式、最终可见 work |
| Residency | page state、physical heap、upload、mapping、eviction、feedback scheduler | Cooker 算法、scene object graph |
| GPU hierarchy/work | desired Group、fallback、demand、bounded raster work | 网络、Worker、CPU 最终可见列表 |
| `GpuAssetStore`/`GpuRenderWorld` | asset/instance/material 与 active product generation 的原子引用 | Loader/Worker 临时 buffer |

### Product admission 状态

revision 的 CPU 状态机固定为：

```text
offered
  -> validating
  -> reserving
  -> filling-activation-cut
  -> ready-to-activate
  -> active
  -> retiring
  -> retired
```

任何激活前状态都可进入 `failed` 或 `cancelled`。`active` revision 的后台 page failure 不使整个 revision 失效，只保持 ancestor fallback 并记录失败；descriptor/profile corruption、activation page failure或依赖不完整则禁止激活。

Admission 为每次 offer 分配非零 `productGeneration: u32`。同一 `(ProductID, revision)` 的重复 offer 只允许在 descriptor 完全相同且复用同一 source transaction 时合并；否则拒绝。generation wrap 前必须清空相关异步任务和 GPU reference，不能静默复用仍可见的 generation。

激活事务必须原子发布：

```text
validated descriptor + complete resident activation cut + dependencies
  -> encode product metadata/page-table publication
  -> submit with scene/GPU revision
  -> future frozen FrameContext sees new productGeneration
  -> old generation mappings become non-discoverable
  -> wait submission safety boundary
  -> release old slots/metadata/source
```

不得在一个冻结 `FrameContext` 内混用不同 product generation。新事务失败或取消时回滚其 reservation，旧 active revision 不变。

`ready-to-activate` 只表示候选 descriptor、activation cut 和 Scene mapper 已准备，不能被 frame/admission consumer 当作 active。Renderer 必须将候选 metadata、Scene/instance、material/texture 与 sparse-shading closure 一起预检；只有对应命令提交成功后才 `commit()` Product active bit 和 generation。mapping、staging、submit 或取消失败必须释放候选 reservation，旧 Scene、旧 generation 和旧 sparse-shading closure 保持可消费；异步 replacement 错误不得吞掉。

### 逻辑 page 状态

每个 `(productGeneration, PageID)` 具有以下单向主状态：

```text
absent -> queued -> producing-or-reading -> verified -> upload-queued
       -> submitted -> resident -> retiring -> absent
```

`queued` 到 `submitted` 可因 cancel/failure 回到 `absent` 或进入带 retry deadline 的 `failed`。只有 page 长度、descriptor hash、payload bounds 和 product generation 全部有效后才进入 `verified`。`resident` 只能由已提交的 upload 和同批 mapping publication 建立；CPU 拷贝完成不代表 resident。

迟到 page、旧 source session、旧 product generation、已 resident page 和已取消 revision 必须在占用 upload credit 前丢弃。重复 demand 合并到同一 page operation，并提升优先级而不是复制工作。

### Physical heap 与地址表

为保持 WebGPU 2026 Desktop 的 `maxStorageBuffersPerShaderStage >= 10` 基线，所有只读 Product metadata 与可更新 Page location 共用一个 `GeometryProductMetadataHeapV1` storage buffer，而不是每张逻辑表占一个 binding。Heap 以 64-byte little-endian header 开始；所有 word offset 从 heap byte 0 计，且对应 section 起点按 16 byte 对齐：

| Byte | 类型 | 字段 |
| ---: | --- | --- |
| 0 | `u32` | ABI version = 1 |
| 4 | `u32` | product count |
| 8 | `u32` | product capacity |
| 12 | `u32` | total words |
| 16..47 | `u32[8]` | product table、asset reference、asset record、root id、hierarchy、Group directory、Page location、VertexFormat 的 word offsets |
| 48..63 | `u32[4]` | reserved = 0 |

Canonical 单 Product admission 也使用该 heap；后续全局 registry 只改变各逻辑表的 begin/count 和 heap capacity，不改变 shader ABI。动态 Page mapping 仅更新 Page location section 的 16-byte record；Product 激活仅更新对应 64-byte Product record 的 active bit。任何 offset、count 或 stride 组合越过 `totalWords` 均 fail closed。

单 Product owner 如取得非零 `ProductTableSlot`，其表必须包含从 slot 0 到该 slot 的稀疏记录，`productCount = productCapacity = ProductTableSlot + 1`；未使用记录全零且 inactive。资产引用只能指向该 slot 的记录，不能以本地 slot 0 偷换。每个 section 的索引/数量必须落在本 section 的下一 offset 之前，不能仅以 heap 总长为界而别名后续 section。

GPU-visible `GeometryProductTableRecordV1` 是 64-byte little-endian record。所有 begin/count 指向按 descriptor 原始 stride 拼接的全局只读表；单 Product owner 也必须写 begin=0 的同一 record，不能发明私有 shader layout。

| Byte | 类型 | 字段 |
| ---: | --- | --- |
| 0 | `u32` | product generation；0 为 invalid |
| 4 | `u32` | flags；bit 0 = active，bits 1..31 = 0 |
| 8..15 | `u32[2]` | asset begin/count |
| 16..23 | `u32[2]` | root-node-id begin/count |
| 24..31 | `u32[2]` | hierarchy begin/count |
| 32..39 | `u32[2]` | Group directory begin/count |
| 40..47 | `u32[2]` | Page location begin/count |
| 48..55 | `u32[2]` | VertexFormat begin/count |
| 56..63 | `u32[2]` | reserved = 0 |

`GeometryProductAssetReferenceV1` 是 16-byte little-endian record，由 Scene/GPU asset publication 在与 instance `geometry_record_index` 相同的稳定 slot 发布：

| Byte | 类型 | 字段 |
| ---: | --- | --- |
| 0 | `u32` | product table slot |
| 4 | `u32` | expected product generation |
| 8 | `u32` | Product-local AssetRecord index |
| 12 | `u32` | flags；V1 必须为 0 |

Shader 必须验证 Product table slot 范围、active bit、两处 generation 相等、AssetRecord index 小于 product asset count，再访问 descriptor table。失败必须 fail closed 并计入 invalid generation/location；不能退回同 slot 的 V2 `GpuGeometryRecord`。迁移期间 instance flag 显式区分两种 geometry owner，禁止依赖表内容猜测。

- decoded slot 固定 256 KiB；默认 bank 为 128 MiB、512 slots。
- V1 同一 GPUDevice 共享一个固定的 4 x 128 MiB bank/slot pool（总计 512 MiB）；每个 Product revision 复用这四个绑定，不得重复创建 bank 或追加未绑定 bank。slot 只有在 revoke 已提交且 queue completion 证明旧 work 不再引用后才归还。metadata heap 不进入 Page bank 预算，但必须由独立有界 overhead ledger 记账并报告。GPU 与 CPU mirror 均拒绝 `bankIndex >= 4` 或 `slotIndex >= 512`。
- bank 数与总 slot 数来自设备 limit、全局 resident budget 和显式配置，不得依赖未协商能力。
- slot 在 `submitted`/`resident`/`retiring` 状态有唯一 owner；禁止同帧重分配。
- activation pages 在 revision active 期间 pinned；pinned 总量服从 admission budget。

GPU-visible `GeometryPageLocationV1` 是 16-byte little-endian record：

| Byte | 类型 | 字段 |
| ---: | --- | --- |
| 0 | `u32` | bank index；non-resident 为 `0xffffffff` |
| 4 | `u32` | slot index；non-resident 为 `0xffffffff` |
| 8 | `u32` | product generation；non-resident 为 0 |
| 12 | `u32` | flags |

flags bit 0 为 resident，bit 1 为 pinned；bits 2..31 必须为 0。`byteOffset = slotIndex << 18`。Shader 必须先验证 resident bit 和预期 product generation，再读取 page；失败视为 non-resident。地址表容量至少等于 descriptor page count，越界 PageID fail closed 并计数。

映射撤销必须先将 record 写为 non-resident，并确保未来 frame 不再产生旧 work；slot 只有在引用旧 mapping 的所有提交完成后才能复用。不得在帧循环中 await `queue.onSubmittedWorkDone()`；retire owner 使用提交序号/fence 批次异步回收。

Eviction 候选不能只按 `lastUsed` 排序，至少必须排除 pinned/bootstrap，满足最小驻留时间，并结合近期 demand/visible 频率、ancestor/fallback importance、预测保护、refetch cost、memory pressure 与 retiring bytes。策略必须有 hysteresis/cooldown，并记录平均 Page lifetime、reload、eviction 后短期 rerequest 和 thrash bytes。

### Demand queue ABI

GPU hierarchy traversal 是 producer，CPU residency scheduler 是延迟 consumer。Queue header 为 16-byte little-endian：

| Byte | 类型 | 字段 |
| ---: | --- | --- |
| 0 | `atomic<u32>` | attempted count |
| 4 | `u32` | capacity |
| 8 | `atomic<u32>` | overflow；0/1 |
| 12 | `u32` | frame revision low 32 bit |

每个 `GeometryPageDemandV1` 为 16 B：

| Byte | 类型 | 字段 |
| ---: | --- | --- |
| 0 | `u32` | product table slot |
| 4 | `u32` | product generation |
| 8 | `u32` | PageID |
| 12 | `u32` | packed priority/flags |

`priority/flags` bits 0..15 是 unsigned priority（值越大越紧急），bit 16 表示 current-view missing，bit 17 表示 shadow demand，bit 18 表示 predictive prefetch，bits 19..31 必须为 0。有效数量是 `min(attempted, capacity)`；reservation 超容量时设置 overflow，并继续绘制 resident fallback，不得部分写一条 record。

实现可以在 GPU 侧使用 product-local bitset 去重，但 queue ABI 和 overflow 语义不变。bitset 必须按 frame/generation 清理，不能让旧 revision 抑制新 demand。CPU 读取后再次按完整 key 去重，并丢弃不存在、已 resident、旧 generation 和 cancelled product。

readback 使用至少双缓冲的延迟 ring，不在生成该 feedback 的帧等待 `mapAsync()`。每帧 readback 总量默认不超过 [VALIDATION](../VALIDATION.md) 的 256 KiB；overflow 触发统计、保守 fallback 和下一轮优先级/容量调整，不触发 CPU 可见列表重建。

### Scheduler 与联合背压

调度优先级至少按以下顺序组合，而不是只看 FIFO：

1. 当前可见 missing page；
2. 新 revision activation cut；
3. 即将可见/相机预测 refinement；
4. shadow-only demand；
5. 后台 prefetch/cache fill。

实际 score 还应包含 request age、SSE benefit、预计 source/cook/decode/upload bytes、retry penalty 和 asset fairness。饥饿避免必须有界；单一资产不得长期占满全部 Worker、in-flight bytes 或 upload budget。

必须同时限制：active CookSession、Worker/WASM thread、source in-flight bytes、WASM memory、transferable output bytes、verified waiting bytes、upload bytes/frame、pending page operations、resident bytes、pinned bytes和 retire bytes。任何一层 credit 耗尽时，上游停止发新工作；不能只限制 Worker 数而让 page queue/WASM heap 无界增长。

descriptor 尚未 offer 时，Web Provider 以 source-local priority 工作；descriptor offer 后，稳定 PageID demand 可以提升其 cook unit。两类 priority 在 Provider 内汇合，但 CPU scheduler 不向 GPU 暴露尚不存在的 PageID。

### Web source priority and catalog handshake

Web source priority 是 descriptor 生成前的调度信号。它结合 bounds、依赖、
camera hint 和 age 选择 catalog asset/shard；在 Product descriptor 存在之前，
不得从 GPU Page demand 伪造该优先级。Worker 必须在启动 Cook 前 flush
`SceneCatalogReady`，让主线程有机会注入初始 camera priority。未选中的 source
range 不能成为首个 active bootstrap revision 的等待条件。

### I/O、Worker 与 upload

- HTTP OEGPACK source 使用精确 `206 Content-Range`、identity content encoding 和精确长度；GLB source 的 Range fallback 由 Provider 处理。
- decode、hash、cook 和大 JSON parse 在有界 Worker 中执行。主/render thread 只做轻量协调、validation、GPU ownership 和 command encoding。
- Worker 返回 exclusive `ArrayBuffer`；GPU object 不可 transfer。Worker crash/WASM OOM 失效整个 source session generation，已 active 的旧 revision继续工作。
- 默认 upload 路径使用 `GPUQueue.writeBuffer`，offset/size 保持 4-byte aligned；单页或批量 staging 只有 benchmark 证明更好时采用。
- upload 按帧聚合且不为每页独立 submit。默认上限为 8 MiB/frame；超限只能依据同条件 evidence 修改。
- 不在 render loop await upload、mapping 或 queue completion。publication 使用未来 frame revision；retirement 单独异步推进。

### Fallback、失败与 retry

desired Group 的 page 不 resident 时，traversal 必须沿合法 hierarchy 找到同 product generation 的 resident ancestor/bootstrap Group；找不到则 fail closed，不能访问 invalid location。fallback 本身仍受 raster work queue capacity 约束。

range、cook、decode、hash 或 upload validation 失败不得发布 page。retry 以 error class、最大次数、deadline 和 backoff 有界；确定性 corruption/unsupported profile 不重试。失败必须保留 `lastError`、attempt count 与受影响 key 的诊断，但不得把 source URL 写入 GPU record。

Demand overflow、upload budget exhaustion 或短暂 source failure只降低 refinement，不应破坏已 active cut。activation cut 永久失败则拒绝该 revision；replacement 失败时保留旧 active revision。

### Device loss、取消与 feature-off

device loss 立即使全部 bank、location、product generation 的 GPU publication 和 pending upload 失效。恢复必须请求新 adapter/device、重建 heap/table/pipeline/bind group，从仍有效的 Product Provider 重新准入 activation cut；旧 device 的任何 GPU object 和 completion 不得进入新 generation。

scene/asset replace、AbortSignal、Provider release 和 feature toggle 都要取消 queued/producing operation并丢弃迟到结果。已经 submit 的资源进入 retire，不可立即复用。feature-off 时不得创建 heap、demand queue、readback ring、Worker session 或额外 submit。

### 必需证据与 counters

至少暴露以下每帧/累计 counters：offered/admitted/active/failed revision，requested/deduplicated/stale/failed/resident/evicted page，demand attempted/valid/overflow，fallback Group，invalid location/generation，source/cook/decode/upload bytes 与 latency，in-flight/peak bytes，pinned/resident/retiring bytes，retry/cancel/late result，device recovery；Product bank capacity、shared slot usage、metadata overhead、双 revision peak、平均 Page lifetime、reload、短期 rerequest 与 thrash bytes 也必须可观测。

Counter readback 必须有界且可以关闭；关闭诊断不能改变 correctness。所有 queue/table 记录其 ABI version、capacity、producer、consumer 和 overflow count。

## Validation

- CPU mirror/WGSL oracle 覆盖 `GeometryPageLocationV1`、Demand header/record、reserved bits、bounds 与 generation check。
- 状态机覆盖 duplicate/out-of-order page、stale generation、cancel/replace、activation rollback、generation ABA、slot retire race、aborted submit 和 recovery。
- 压力用例覆盖 demand queue overflow、pinned admission failure、Worker/output/upload backpressure、8 MiB upload 和 256 KiB readback上限。
- source/corruption matrix覆盖 Web live provider 与 OEGPACK adapter，并证明 source 差异未进入 GPU consumer。
- MILESTONE 在 ADR-0014 宿主中证明 `GPU desired LOD -> delayed demand readback -> async source/cook -> upload/publication -> GPU consumer`，缺页全过程由 ancestor/bootstrap 输出合法像素。
- feature-off 证明无 heap、queue、readback、Worker、Pass 和独立 submit；性能结论使用固定 adapter、分辨率/DPR、画质、workload、warm-up 与 capability fingerprint。
