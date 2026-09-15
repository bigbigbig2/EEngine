# ADR-0016-B — Nyx Geometry Streaming × EEngine WebGPU Virtual Geometry Residency / Feedback

> **Status**: Design Freeze Candidate  
> **Date**: 2026-09-15  
> **Parent ADR**: ADR-0016 — Nyx × WebGPU 2026 虚拟化资源加载与 GPU 驱动终极架构  
> **Depends on**: ADR-0016-A — Native Geometry Cooker 与 Runtime Geometry Page ABI  
> **Blocks**: ADR-0016-C — Nyx `DispatchMesh` → WebGPU Compute + Indirect + Vertex Pulling  
> **Next sibling**: ADR-0016-D — Texture Cook / Mip Streaming / Virtual Texture  
> **Primary target**: EEngine Advanced WebGPU Renderer / GPU-driven path  
> **Compatibility policy**: 不设计 Legacy Renderer / WebGL / raw-GLB Runtime fallback；Production 仅面向新的 Virtual Geometry Runtime。

---

# 0. 决策摘要

ADR-0016-A 已冻结 Production Geometry 的核心前提：

```text
Authoring glTF/GLB
      ↓
Native C++ Cooker
      ↓
.oegpack
      ├─ resident metadata
      └─ independent 256 KiB decoded Geometry Pages
```

ADR-0016-B 决定这些 Page 在浏览器 Runtime 中如何真正成为一个**虚拟化几何内存系统**。

最终决定如下：

1. **移植 Nyx 的 Geometry Streaming 算法思想与关键状态语义，但不照抄 DX12 资源模型。**
2. `Geometry Page = 256 KiB` 保持 ADR-0016-A 的 V3 ABI，不在 B 中改变。
3. Nyx 的 `Group request mask` 改成 EEngine 的 **Page Demand Bitset**；Page 才是 IO / decode / upload / eviction 的最小单位。
4. **Demand bit 不只代表 miss**。GPU 对“本帧真正被需要的 Page”都置位，包括已经 resident 的 Page，用于 CPU 更新 `lastDemandFrame`，否则无法做安全且不抖动的 eviction。
5. 不直接复制 Nyx 的 `GroupDataLocation[group] -> ChunkIndex + ByteOffset`。EEngine V3 改为更适合 Page virtualization 的：

```text
GroupDirectory[GroupID]
    ├─ pageId
    └─ offsetInDecodedPage

PagePhysicalLocation[RuntimePageIndex]
    └─ packedPhysicalSlot / INVALID
```

Group 的最终物理地址由 shader 计算：

```text
RuntimePageIndex = asset.pageBase + group.pageId
physicalSlot     = PagePhysicalLocation[RuntimePageIndex]
bankIndex        = physicalSlot >> 9
slotInBank       = physicalSlot & 511
pageBase         = slotInBank << 18
groupByteOffset  = pageBase + group.offsetInDecodedPage
```

6. `PagePhysicalLocation` 只需 **1 × u32 / Page**；`0xffffffff` 表示 non-resident。相比按 Group 维护动态物理地址表，它更小、更新更少，而且与 Page residency 粒度完全一致。
7. GPU Heap 使用 ADR-A 的 **128 MiB-class Geometry Banks**；每 Bank 512 个 256 KiB Slot。Bank 数量属于 Renderer execution profile，由 ADR-C 根据 WebGPU storage-binding 预算最终确定，不写入磁盘 ABI。
8. Root/Bootstrap Pages 必须**全部加载并 Pin**；不能复制 Nyx “预算不够就只 pin 一部分 root” 的行为。若 Root Working Set 超出配置的 resident budget，场景 admission 直接失败。
9. Streaming 全链路：

```text
GPU Demand
  ↓ asynchronous readback
CPU Scheduler
  ↓
OPFS compressed cache / HTTP Range
  ↓
Worker Decode
  ↓
Decoded Page Queue
  ↓ frame-budgeted upload
Geometry Page Heap
  ↓ publish physical slot
PagePhysicalLocation GPU table
```

10. 网络采用 `.oegpack` **HTTP Range**；Production host 必须支持 Range。服务器若对页面范围请求退化成整个大文件下载，视为部署配置错误，不做 whole-pack fallback。
11. Persistent Cache 使用 OPFS，缓存**压缩 Page**，不是解压后的 256 KiB Page；OPFS I/O 放 Dedicated Worker。
12. Runtime decode 不在 Main Thread。复用 EEngine `AssetWorkerPool` 的 bounded-worker / memory-admission / cancellation 思路，Geometry V3 使用专门的 Page Decoder Pool。
13. Eviction 不只做 naive LRU；采用 `lastDemandFrame + coarse importance + resident age + reload/thrash penalty + pinning` 的 value-aware policy，并有高/低水位 hysteresis。
14. WebGPU 没有 DX12 fence 暴露给应用。Page Slot 不能“写 invalid 后立即复用”，必须增加 **GPU Submission Serial Tracker**，使用 `GPUQueue.onSubmittedWorkDone()` 异步推进 completed serial，确保旧 GPU work 不再访问旧 Slot 后才释放。
15. **禁止 Frame Path 同步等待 GPU readback / `onSubmittedWorkDone()`。**所有 completion 都是异步状态推进。
16. Page upload 与 location publication 必须遵循：

```text
page bytes upload
    ↓ queue order
PagePhysicalLocation = physicalSlot
    ↓
subsequent culling/raster may observe resident
```

Eviction 反向执行：

```text
PagePhysicalLocation = INVALID
    ↓
future submissions cannot discover page
    ↓
wait previous submission serial complete
    ↓
free physical slot
```

17. Streaming failure **fail closed**：fetch/decode/hash 失败的 Page 保持 non-resident。绝不复制 Nyx 当前 I/O 失败后零填充 Page 并继续提交的行为。
18. ADR-B 只冻结 Streaming / Residency / Feedback 合同；真正 DAG Cull、HZB、Visible Meshlet、Indirect Raster 在 ADR-C 实现。但 ADR-C 必须按照 B 定义的 Page Demand 和 PagePhysicalLocation ABI 消费资源。

一句话总结：

> **Nyx 给 EEngine 提供 Virtual Geometry Streaming 的骨架；EEngine B 将其重写成“Page-first、Web-native、budgeted、non-blocking、submission-safe”的 WebGPU Residency System。**

---

# 1. ADR-0016-B 在总路线中的位置

```text
ADR-0016
Virtualized Asset Architecture
        │
        ▼
ADR-0016-A
Native Cooker + Geometry Page ABI
        │
        ▼
ADR-0016-B   ← 本文
Streaming / Residency / Feedback / IO / Cache
        │
        ▼
ADR-0016-C
DAG Cull / HZB / Visible Meshlet / Indirect Raster
        │
        ▼
ADR-0016-D
Texture Streaming / Native Compression / VT
```

A 回答的是：

> “磁盘里的 Virtual Geometry 长什么样？”

B 回答：

> “这些 Virtual Pages 怎样进入 / 离开 GPU，并由 GPU 需求驱动？”

C 回答：

> “GPU 怎样遍历 DAG 并真正渲染 resident meshlets？”

因此 B **不能依赖完整 C 才能验证**。实现 B 时必须提供一个 Test Demand Generator / Debug Compute Kernel，能人为对 PageID 发 demand，先验证：

```text
Range fetch
→ decode
→ upload
→ publish
→ readback demand
→ evict
→ retire
```

整个闭环。

---

# 2. 源码基线与审计范围

本文不是从抽象概念直接设计，而是以两个仓库的当前实现做逐模块映射。

## 2.1 EEngine 基线

审计 commit：

```text
bigbigbig2/EEngine
cec226e6feb825ce4d682f97b1d966c8e71d0c6a
feat(renderer): expand glTF material and large-scene support
```

重点源码：

```text
OEngine/src/assets/RuntimeAssetResidency.ts
OEngine/src/assets/RuntimeAssetManifestV2.ts
OEngine/src/assets/RuntimeAssetPackage.ts
OEngine/src/assets/GeometryAssetPackage.ts
OEngine/src/geometry/GeometryCooker.ts
OEngine/src/geometry/GeometryHierarchy.ts
OEngine/src/gpu/GpuAssetStore.ts
OEngine/src/gpu/MeshletGpuPool.ts
OEngine/src/gpu/GpuSceneResidencyManifest.ts
OEngine/src/assets/codec/AssetWorkerPool.ts
OEngine/src/loaders/load_gltf.ts
```

## 2.2 Nyx 基线

审计 commit：

```text
moonlovelj/Nyx
bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b
Integrate Slang runtime shader compilation and reflection
```

重点源码：

```text
MiniEngine/Model/MeshletStructs.h
MiniEngine/Model/Model.h
MiniEngine/Model/ModelLoader.h
MiniEngine/Model/ModelConvert.cpp
MiniEngine/Model/MeshletBuilder.cpp
MiniEngine/Model/GeometryStreaming.h
MiniEngine/Model/GeometryStreaming.cpp
MiniEngine/Model/Shaders/DAGCull.slang
```

---

# 3. 两个仓库当前 Residency 模型对比

| 维度 | EEngine 当前 | Nyx 当前 | ADR-B 决策 |
|---|---|---|---|
| Residency unit | 完整 Geometry Package / chunk | 256 KiB Page | 256 KiB Page |
| GPU heap | append/bulk 多全局 buffer | 256 MiB Chunk × slots | 128 MiB-class Bank × 256 KiB slots |
| physical address | whole asset offsets | Group → Chunk + ByteOffset | Page → packed physical slot；Group 地址派生 |
| feedback | 无 geometry page demand loop | GPU Group request bit mask | GPU Page demand bitset |
| request semantics | CPU cold load | visible Group 都置位 | demanded Page 都置位，resident/miss 都记录 |
| readback | 非 page-streaming | 3 readback buffers + fences | non-blocking 4-slot readback ring |
| IO | whole/pre-cooked asset fetch | Windows file IO thread | HTTP Range + OPFS + Worker |
| decode | package/worker codec infrastructure | LZ4 on IO thread | bounded Worker Page Decode Pool |
| root | whole package resident | root page pinning | all bootstrap pages required + pinned |
| eviction | release asset / later reclaim | LastUsedFrame + free slots | value-aware LRU + hysteresis + GPU-safe retirement |
| device loss | RuntimeAssetResidency reset seam | DX12-specific rebuild | V3 virtual state preserved，physical state rebuilt |
| failure | validated packages | I/O failure path可零页继续 | fail closed，不发布坏页 |

---

# 4. EEngine 当前实现：哪些应该保留

## 4.1 `RuntimeAssetResidencyState` 的状态语义是对的

当前 EEngine 已经明确把 residency seam 定义为：

```text
unrequested
requested
resident
retiring
```

同时提供：

```text
request()
commit()
abort()
retire()
completeRetire()
resetAfterDeviceLoss()
```

更重要的是源码自己明确写了：

> 这个类只负责 bounded chunk/page seam；刻意不包含 priority queue、feedback loop、IO scheduler、GPU ownership。

这个职责划分非常正确。

### ADR-B 决策

**保留这个状态机语义，但不把当前类直接扩成百万 Page 级 Geometry runtime。**

原因：当前实现以：

```text
Map<string, MutableRange>
chunk string id
object reservation
```

为核心，适合普通 Runtime Asset package；但当场景出现几十万/百万 Virtual Pages 时，字符串、Map Entry、JS 对象的内存与 GC 成本不符合 EEngine “极致压榨”目标。

Geometry V3 新增专用：

```text
VirtualGeometryResidencyTable
```

使用**dense RuntimePageIndex + typed-array SoA**。

`RuntimeAssetResidencyState` 继续用于小型普通资产；其语义作为 V3 residency 的 correctness reference。

---

# 5. EEngine 当前 `GpuAssetStore` 为什么不能直接改成 Page Heap

`GpuAssetStore` 当前源码明确定位为：

```text
Unique owner for validated Geometry package residency
allocator is deliberately append/bulk first
```

它的 `residentMany()` 做的是：

```text
validate entire packages
reserve complete set
append into many global GPU buffers
publish transaction atomically
```

其 release 语义则是：

```text
stable record invalidated
payload bytes remain reclaimable
until future compaction policy
```

这对于现在的完整 Geometry Package 非常合理；但它和 Virtual Page Heap 的目标相反。

Page Heap 要求：

```text
fixed-size slot
constant-time allocate/free
no fragmentation
no global grow-copy
no whole-asset transaction barrier
fine-grained eviction
```

### ADR-B 决策

新增：

```text
GeometryPageHeap
```

**不把 GpuAssetStore 演化成 GeometryPageHeap。**

原因不是“代码不能复用”，而是 ownership / allocator invariant 根本不同。

可以复用：

- GPU accounting 风格；
- evidence 统计风格；
- transactional publication 思路；
- device-loss cleanup 模式。

不复用：

- append-only cursor；
- whole-package resident transaction；
- buffer grow / whole-buffer replacement；
- release 后延迟到全局 compaction 才回收的模型。

---

# 6. `MeshletGpuPool` 也不作为 Virtual Geometry Page Heap

EEngine 当前 `MeshletGpuPool` 是 variable-range allocator：

```text
MeshletRangeAllocator
allocate arbitrary words/records
free
compact()
grow()
rebuild whole buffer
patch moved addresses
```

这个设计非常适合一般 Meshlet batch 管理；但 Virtual Geometry Page 已经天然固定为 256 KiB。

如果继续使用 variable-size range：

```text
Page → arbitrary range
      ↓
fragmentation
      ↓
compact
      ↓
physical address moves
      ↓
patch
```

会把 Page virtualization 的最大优势丢掉。

### ADR-B 决策

Virtual Geometry Heap：

```text
1 Page = 1 Physical Slot
```

永不在 Bank 内 compact。

要释放就：

```text
slot occupied → retiring → free
```

没有碎片问题。

---

# 7. Nyx 当前 Streaming System：真正应该移植的核心

Nyx `GeometryStreaming.cpp` 已经是完整 virtual geometry residency 骨架：

```text
PageResidency
PhysicalSlot free pool
GeometryChunksGPU
GroupDataLocation GPU table
RequestMask GPU
Readback ring
async IO queue
LZ4 decode
PinRootPages
LastUsedFrame
eviction
```

尤其是：

```cpp
struct PageResidency {
    uint32_t ChunkIndex;
    uint32_t SlotIndex;
    uint64_t LastUsedFrame;
    bool IsPinned;
    bool IsLoading;
};
```

这说明 Nyx 的核心 virtual memory unit 已经是 Page，而不是 Mesh。

ADR-B 不重造这个思想，只把它重新映射到 WebGPU/Web 平台。

---

# 8. Nyx `DAGCull.slang` 暴露出的一个重要事实

Nyx 在处理可见 Group leaf 时会先：

```text
InterlockedOr(requestMask[groupID])
```

然后才读取：

```text
GroupDataLocation[groupID]
```

判断 Group 是否 resident。

也就是说：

> **Request bit 不是纯 page fault bit，而是 usage/demand signal。**

这非常重要。

若 EEngine 只在 non-resident 时置位：

```text
resident page
→ 永远没有 demand feedback
→ CPU 不知道它持续被使用
→ LastUsedFrame 不更新
→ eviction 可能错误驱逐屏幕正在使用的 Page
```

所以 ADR-B 明确禁止：

```text
if (!resident) request(page)
```

作为唯一 feedback。

正确语义：

```text
if (page is demanded by traversal)
    demand(page) = 1

if (!resident)
    additionally treat as page fault
```

---

# 9. 为什么 EEngine 要从 Group Request Mask 升级为 Page Demand Mask

Nyx 请求 mask 按 Group 编号：

```text
1 bit / Group
```

CPU 再通过：

```text
GroupMetadata.PageIndex
```

把 group demand 汇聚成 Page load。

EEngine ADR-A 已经明确：

```text
Page = IO/decode/upload/residency unit
Group cannot cross Page
```

因此直接按 Page feedback 更合理：

```text
1 bit / RuntimePageIndex
```

优点：

1. bitset 更小；
2. CPU 不需要把每个 Group request 再映射到 Page；
3. request dedupe 天然完成；
4. resident recency 和 eviction 也是 Page 粒度；
5. IO scheduler 不需要 Group→Page 聚合阶段。

例如：

```text
100,000 pages → 12.5 KiB bitset
1,000,000 pages → 125 KiB bitset
```

即使每帧 readback，数据量也远小于几何本身。

---

# 10. Runtime ID：Disk ID 与 Scene-runtime ID 分离

Cooked `.oegpack` 中：

```text
pageId   = pack-local
GroupID  = pack/asset-local
```

Runtime 需要一个全局 dense page address space 供 GPU bitset 使用。

因此 Scene 初始化时为每个 active pack 分配：

```text
PackRuntimeBase {
    hierarchyBase
    groupBase
    pageBase
}
```

定义：

```text
RuntimePageIndex = pack.pageBase + localPageId
RuntimeGroupIndex = pack.groupBase + localGroupId
```

**Cooked bytes 不被修改。**

Shader / Runtime Asset record 只保存 base；使用时做 u32 加法。

这样：

- Page Demand Bitset 是全场景一个 dense bitset；
- CPU ResidencyTable 是一个 dense typed-array table；
- 多 `.oegpack` 仍然可以统一调度。

---

# 11. B 对 ADR-A §44 的最终细化：不用动态 `GroupDataLocation`，改用 `PagePhysicalLocation`

ADR-A 在职责边界中预留了：

```text
GroupDataLocation / PageResidencyTable
```

B 在对照 Nyx 与 WebGPU hot-path 后，正式选择 **PagePhysicalLocation**。

原因是：C 为了产生 Page Demand，本来就必须读取：

```text
GroupDirectoryV3
→ pageId + offsetInDecodedPage
```

如果再维护：

```text
GroupDataLocation[groupId]
```

则 GPU hot path 是：

```text
GroupDirectory[group]
GroupDataLocation[group]
```

而 Page-first 设计可以变成：

```text
GroupDirectory[group]
PagePhysicalLocation[page]
```

两者都是 2 次 metadata lookup；但第二种：

- dynamic table 从 Group 数量缩小到 Page 数量；
- Page publish 只更新 1 个 record；
- Page evict 只 invalid 1 个 record；
- location table cache footprint 更小；
- 与 residency unit 一致。

因此：

> **Nyx `GroupDataLocation` 的语义保留，但 EEngine 把动态 address translation 提升到 Page level。**

---

# 12. `PagePhysicalLocationGPU` ABI

ADR-A 固定：

```text
Page = 256 KiB = 1 << 18
Bank = 128 MiB = 512 Pages = 1 << 9 Pages
```

因此 physical location 可以压成单个 `u32`：

```text
bits 0..8   = slotInBank   (0..511)
bits 9..31  = bankIndex
0xffffffff  = INVALID / non-resident
```

实际上 CPU 也可把它视为一个全局 `physicalSlotIndex`：

```text
physicalSlotIndex = bankIndex * 512 + slotInBank
```

GPU：

```wgsl
let packed = pagePhysicalLocation[runtimePageIndex];
let resident = packed != 0xffffffffu;
let bankIndex = packed >> 9u;
let slotInBank = packed & 511u;
let pageByteOffset = slotInBank << 18u;
```

## 12.1 内存规模

```text
4 B / Page
```

即：

```text
1,000,000 pages → 3.81 MiB
```

对于代表约 256 GiB decoded virtual geometry 的地址空间，这个 metadata 成本非常低。

---

# 13. `GeometryPageHeap` 物理模型

```text
GeometryPageHeap
│
├─ Bank 0 (128 MiB)
│   ├─ Slot 0 (256 KiB)
│   ├─ Slot 1
│   └─ ... Slot 511
│
├─ Bank 1
│   └─ 512 slots
│
└─ Bank N
```

核心数据：

```text
bankBuffers[]
freePhysicalSlots[]
slotOwnerPage[]
slotState[]
slotRetireSerial[]
```

### 13.1 O(1) allocation

Free list 保存：

```text
physicalSlotIndex : u32
```

allocate：

```text
pop()
```

free：

```text
push()
```

无 buddy allocator，无 fragmentation，无 compaction。

### 13.2 Bank 懒分配

不要启动时直接分配最大显存预算。

Pipeline layout 的可访问 Bank 数量由 ADR-C 的 execution profile 固定；B 对尚未真正分配的 Bank 可以绑定最小 dummy storage buffer，直到第一次需要该 Bank 时创建真实 128 MiB GPUBuffer 并重建对应 bind group。

这样：

```text
shader-visible bank slot count fixed
physical VRAM allocation lazy
```

---

# 14. WebGPU 2026 对 Geometry Bank 的真实约束

截至 2026-08-20 W3C WebGPU Candidate Recommendation Draft：

```text
maxStorageBufferBindingSize default = 128 MiB
maxBufferSize default               = 256 MiB
maxStorageBuffersPerShaderStage     = 8
```

`core` feature level 包含 `core-features-and-limits`，使 vertex/fragment storage buffer stage limits 与 core storage-buffer limits 对齐。

因此 Nyx 的：

```text
256 MiB Geometry Chunk + descriptor heap dynamic indexing
```

不能原样搬到标准 WebGPU。

### ADR-B 决策

- Bank bytes 仍按 A 的 128 MiB canonical class；
- Bank count 不写入 disk ABI；
- ADR-C 根据实际 bind-slot budget 选择首个 Advanced profile（建议优先验证 2～4 banks）；
- 若未来 WebGPU 提供更强 buffer binding / resource array 能力，只替换 execution binding，不改变 PageID / Page Directory / residency state。

**不要为了追求“总 resident 越大越好”提前牺牲 shader binding 结构。**

Streaming 的本意就是在有限 physical set 上维持最有价值的 pages。

---

# 15. CPU `VirtualGeometryResidencyTable`：必须用 SoA，不做一百万个 JS Object

推荐结构：

```ts
class VirtualGeometryResidencyTable {
  state: Uint8Array;
  flags: Uint8Array;
  retryCount: Uint16Array;

  physicalSlot: Uint32Array;
  lastDemandFrame: Uint32Array;
  residentSinceFrame: Uint32Array;
  consecutiveDemandSamples: Uint16Array;

  requestGeneration: Uint32Array;
  retireSerial: Uint32Array;
}
```

约定：

```text
physicalSlot = 0xffffffff → no physical allocation
```

Flags：

```text
ROOT
PINNED
CACHE_HIT_PENDING
FAILED_RECENTLY
PREDICTED
```

这里的 typed arrays 只保存 hot state。

大对象如：

```text
AbortController
Promise
RangeBatch reference
Worker task token
```

只为**当前 in-flight pages**放在 sparse Map 中。

因此：

```text
百万 Page ≠ 百万个 JS object
```

---

# 16. Page Runtime 状态机

内部状态比通用 `RuntimeAssetResidencyState` 更细：

```text
COLD
  │ demand
  ▼
QUEUED
  │ scheduler admits
  ▼
FETCHING
  │ bytes available
  ▼
COMPRESSED_READY
  │ worker admits
  ▼
DECODING
  │ success
  ▼
DECODED_READY
  │ upload budget
  ▼
UPLOAD_QUEUED
  │ queue writes
  ▼
RESIDENT
  │ eviction selected
  ▼
RETIRE_PENDING
  │ GPU prior work complete
  ▼
COLD
```

异常分支：

```text
FETCH / DECODE / HASH FAILURE
      ↓
FAILED_COOLDOWN
      ↓ bounded retry / future demand
      ↓
COLD or QUEUED
```

Root Page 若最终 retry exhausted：

```text
Scene Bootstrap Fatal Error
```

Fine Page failure：

```text
remain non-resident
render resident ancestor
```

---

# 17. 外部四态语义仍与 EEngine 一致

虽然内部有很多 stage，对外 residency contract 仍映射成：

```text
COLD                     → unrequested
QUEUED..UPLOAD_QUEUED    → requested
RESIDENT                 → resident
RETIRE_PENDING           → retiring
```

这样保留 EEngine 现有的 transaction / evidence 语义，而不把普通 RuntimeAsset 系统与 Virtual Geometry 强耦合。

---

# 18. Scene Bootstrap：不是“先加载所有 Geometry”

正确的启动流程：

```text
1. Load scene.oescene
2. Range-fetch .oegpack header + resident metadata
3. Build runtime base tables
4. Allocate PagePhysicalLocation + Demand buffers
5. Resolve BootstrapPageIDs
6. Admission check pinned bytes
7. Fetch / decode root pages
8. Upload all root pages
9. Publish root PagePhysicalLocations
10. FIRST MEANINGFUL FRAME
11. Start demand-driven refinement
```

这里的关键 barrier 只有：

```text
all required root pages resident
```

不是：

```text
all geometry pages resident
```

---

# 19. Root Page Pinning：比 Nyx 更严格

Nyx 当前源码会：

- 统计包含 root group 的 pages；
- 排序；
- 使用 `kMaxPinnedRootPages` 与当前 free slots 截断；
- 可能只 pin root pages 的一个子集。

对于 EEngine Cooker 已经离线证明的：

> “全部 Bootstrap Pages 构成无洞合法 coarse cut”

B 必须保持这个 invariant。

所以：

```text
requiredRootPages * 256 KiB > rootResidencyBudget
```

时：

```text
FAIL scene admission
```

而不是：

```text
pin 一部分，赌剩下的不会看到
```

这属于**正确性约束**，不是性能偏好。

---

# 20. Root Page 的物理布局策略

A 已要求 Cooker 尽量把 Root Pages 放在 pack 的前部和相邻范围。

B 利用这一点：

```text
Bootstrap Page IDs
    ↓ sort by pack offset
Range Batch Merge
    ↓
少量 HTTP 206
    ↓
parallel decode
```

First Meaningful Frame 的关键指标改成：

```text
bootstrap metadata bytes
bootstrap compressed geometry bytes
bootstrap decode ms
bootstrap upload bytes
TTFMF
```

而不是完整 `.oegpack` 大小。

---

# 21. GPU Demand Feedback 基础 ABI

创建：

```text
GeometryPageDemandBitsetGPU
```

WGSL 概念：

```wgsl
@group(...) @binding(...)
var<storage, read_write> pageDemand : array<atomic<u32>>;
```

对 `RuntimePageIndex`：

```wgsl
let word = pageId >> 5u;
let bit  = 1u << (pageId & 31u);
let old  = atomicOr(&pageDemand[word], bit);
```

**先 demand，再 residency check。**

后续：

```wgsl
let physicalSlot = pagePhysicalLocation[pageId];
let resident = physicalSlot != 0xffffffffu;
```

这复刻 Nyx “需求与物理 residency 解耦”的关键语义，但把反馈粒度提升到了 Page。

---

# 22. 为什么不用“只 readback Missing Page Queue”

只读 missing queue 看起来数据更少，但失去了 resident page 的 usage recency。

如果 CPU 不知道：

```text
Page 42 resident 且连续 300 帧可见
```

它可能只看到：

```text
Page 42 没 fault
```

这无法区分：

```text
正在频繁使用
```

和：

```text
早就不再使用
```

因此：

> **Demand Bitset 是 correctness source。**

Missing/Fault Queue 只能是优先级优化器，不可替代 Demand Bitset。

---

# 23. 可选的 `PageFaultQueue`：加速高优先级 miss 调度

在 authoritative Demand Bitset 旁边，允许增加：

```text
PageFaultQueueGPU
```

record：

```text
pageId       u32
priorityHint u32
```

只有第一个成功把 demand bit 从 0→1 且 page non-resident 的 invocation 才 append：

```text
old = atomicOr(bit)
if ((old & bit) == 0 && !resident)
    append fault
```

这样同一帧同一 Page 只需一个 fault record。

若 FaultQueue overflow：

```text
不影响 correctness
```

因为 Demand Bitset 仍然完整。

V3.0 实施顺序：

```text
先 Bitset
profiling 后再加 FaultQueue
```

但 ABI 在 B 中预留。

---

# 24. Feedback Readback Ring：不允许 GPU stall

Nyx 使用 3 个 readback buffer + fence。

WebGPU 使用：

```text
GPU copy → MAP_READ staging buffer → mapAsync()
```

B 选择 **4-slot ring**：

```text
Frame N     copy demand → RB[0]
Frame N+1   copy demand → RB[1]
Frame N+2   copy demand → RB[2]
Frame N+3   copy demand → RB[3]
```

旧 slot 的 `mapAsync()` ready 后：

```text
scan bits
update residency scheduler
unmap
```

### 24.1 为什么 4 而不是 3

Nyx 的 3 个 buffer 建立在显式 fence / native engine timeline 上。

浏览器 GPU scheduling + Promise settlement 有更大 jitter。

4 个 slot 的额外内存极小，却降低了 readback ring 因某个 promise 延迟而占满的概率。

### 24.2 Ring 满了怎么办

**绝不 await。**

如果 slot 仍 mapped / pending：

```text
skip this feedback capture
```

保留上一次 demand + eviction grace。

宁可少一个 feedback sample，也不能让 frame path stall。

---

# 25. Demand Bitset 每帧清零

每帧 visibility/demand 之前：

```text
GPUCommandEncoder.clearBuffer(demandBuffer)
```

然后：

```text
Cull / Demand
→ copyBufferToBuffer(demand → current readback slot)
```

这两个操作都在 GPU timeline 上，避免 Main Thread 创建整块 zero Uint32Array 并上传。

---

# 26. Readback latency 与 eviction grace 的关系

假设 feedback latency 为：

```text
2~4 frames
```

那么：

```text
evictionGraceFrames > maximum expected feedback latency
```

是 correctness/performance 必需条件。

第一版推荐测试区间：

```text
8 / 16 / 30 frames
```

但这个数不是磁盘 ABI，也不在 ADR 中冻结最终常量。

Camera teleport / fast fly-through benchmark 决定最终 preset。

---

# 27. Scheduler 总体结构

```text
GeometryStreamingScheduler
│
├─ ingestDemandSnapshot()
├─ touchResidentPages()
├─ enqueueFaults()
├─ updatePriorities()
├─ cancelStaleWork()
├─ admitNetwork()
├─ admitDecode()
├─ admitUpload()
└─ planEviction()
```

Scheduler 运行在 Main/Render JS thread 的**轻量控制面**。

Heavy work：

```text
network body
cache I/O
decode/hash
```

都不做大规模 Main Thread CPU processing。

---

# 28. Priority Class

冻结五级逻辑：

```text
P0 BOOTSTRAP_ROOT
P1 VISIBLE_COARSE_MISS
P2 VISIBLE_REFINEMENT
P3 PREDICTED_NEAR_FUTURE
P4 IDLE_QUALITY_FILL
```

同级内部 score 考虑：

```text
coarse importance
consecutive demand samples
page age
screen-error / priority hint（ADR-C 提供）
projected coverage hint（ADR-C 提供）
reload/thrash penalty
range locality
starvation age
```

### 禁止

```text
priority = camera distance only
```

原因：大物体远距离仍可能覆盖大量像素；近处被完全遮挡的 Page 也不应该高优先级。

最终视觉优先级必须由 C 的 visibility / projected-error 反馈参与。

---

# 29. Demand 去重

Page 是 dense ID，因此调度去重不需要 `Set<string>`。

状态机本身就是 dedupe：

```text
state != COLD
→ 不重复创建 fetch/decode/upload task
```

新的 demand 只更新：

```text
lastDemandFrame
consecutiveDemandSamples
priority
```

---

# 30. Async task generation：防止“过期请求晚到后错误发布”

每 Page 保存：

```text
requestGeneration : u32
```

开始一轮 load：

```text
gen++
task = { pageId, gen }
```

任何 async completion：

```text
if completion.gen != table.requestGeneration[pageId]
    discard
```

用于解决：

```text
camera moved
→ task cancelled
→ old fetch still finishes
→ 不允许旧结果重新把 page 发布为 resident
```

AbortController 负责尽可能停止网络；Generation 负责 correctness。

---

# 31. Streaming 必须有多维 Budget，不是一个 `maxBytes`

至少定义：

```text
maxNetworkInFlightCompressedBytes
maxNetworkRequests
maxDecodeInFlightEstimatedBytes
maxDecodedReadyBytes
maxUploadsPerFrame
maxUploadBytesPerFrame
maxResidentGeometryBytes
maxPinnedGeometryBytes
maxOpfsCacheBytes
```

这是从现有 EEngine `AssetWorkerPool` 借鉴并扩展的正确方向：

> **不仅限制任务数量，还限制 estimated peak memory。**

大资源系统最常见的问题不是线程不够，而是：

```text
同时解 100 个任务
→ CPU peak memory 爆炸
```

---

# 32. Network / Decode / Upload 是三个独立 backpressure stage

错误设计：

```text
fetch 越快越好
→ decode queue 无限堆积
→ decoded 256 KiB pages 堆满内存
```

正确：

```text
Network admission
    ↓ only if compressed-ready budget allows
Decode admission
    ↓ only if decoded-ready + upload pressure allows
Upload admission
    ↓ only if frame budget allows
```

例如：

```text
network 500 MB/s
WASM decode 3 GB/s
GPU upload budget 16 MB/frame
```

若 upload 才是瓶颈，network 必须主动降速，不能让中间队列无限增长。

---

# 33. HTTP Range Source Contract

Production `.oegpack` URL 必须是 immutable/content-hashed URL，并满足 Range 请求。

Page Directory 已给：

```text
compressedFileOffset
compressedBytes
codec
hash/checksum
```

Request：

```http
Range: bytes=start-end
```

要求：

- exact byte range；
- 对 Range 请求返回正确 `206 Partial Content`；
- `Content-Range` 必须匹配；
- 内容 hash/checksum 必须验证；
- 同一 pack session 不允许悄悄切换到不同版本。

如果 CDN 对 256 KiB 页面请求返回：

```text
HTTP 200 + entire 10 GB pack
```

Production Runtime 应报部署错误。

**不做 whole-pack fallback。**

---

# 34. Range Batch Coalescing

单个 Page 一个 HTTP request 也不是终极方案。

Scheduler 对同一 pack 的 queued pages：

```text
sort by compressedFileOffset
```

然后合并邻近 ranges：

```text
Page 100 ─┐
Page 101  ├─ RangeBatch
Page 103 ─┘  （若 gap 足够小）
```

Batch 参数：

```text
maxMergeGapBytes
maxRangeBatchBytes
maxPagesPerBatch
```

属于 benchmark tuning，不进 disk ABI。

### 34.1 重要：不要 `ArrayBuffer.slice()` 出每个 Page

Range response 得到一个 ArrayBuffer 后：

```text
RangeBatchBuffer
+ PageSpan[]
```

整体 Transfer 给 Worker。

Worker 根据 subrange descriptor 解码多个 Page。

这样避免：

```text
merged range
→ N 次 slice/copy
→ 再 Transfer
```

---

# 35. OPFS Persistent Compressed Page Cache

Web 平台没有 native mmap/DirectStorage，但 OPFS 提供一个非常适合 Streaming Cache 的本地层。

架构：

```text
HTTP Range
   ↓
compressed Page
   ├────────→ decode → GPU
   └────────→ write-behind OPFS cache
```

下次：

```text
Page demand
   ↓
OPFS hit?
  yes → decode
  no  → network
```

### 35.1 缓存压缩 Page，不缓存 decoded Page

原因：

- decoded 固定 256 KiB；
- compressed 一般更小；
- decoded CPU pages 不需要跨会话常驻；
- decode 已在 Worker 并可并行；
- 磁盘 cache 容量利用率更高。

### 35.2 Cache Key

至少绑定：

```text
packContentHash
pageId
codec
compressedChecksum / page content identity
```

不能只用 URL + byte offset，因为 deploy 后同一路径可能变化。

最佳生产部署仍是 content-hashed pack URL。

### 35.3 OPFS I/O Thread

`FileSystemSyncAccessHandle` 放 Dedicated Worker。

不要在 Main Thread 做大块 cache read/write。

Cache write 是 write-behind：

> cache 慢不能阻塞 page upload。

---

# 36. Worker Decode Pool

EEngine 已有 `AssetWorkerPool`：

```text
maxWorkers
maxInFlightEstimatedBytes
maxQueuedTasks
3 priorities
AbortSignal
Transferable ownership
worker failure limits
```

这些设计直接保留。

Geometry Streaming 新增：

```text
GeometryPageDecodePool
```

任务：

```ts
{
  rangeBatchBuffer,
  pageSpans,
  expectedDecodedBytes,
  codec,
  checksum/hash metadata,
  requestGeneration
}
```

返回：

```text
DecodedPage[]
```

每个 Page 恰好：

```text
262144 bytes
```

---

# 37. Decode 内存：Page Slab Pool

禁止每个 Page 永远：

```ts
new Uint8Array(256 * 1024)
```

并交给 GC 自己处理。

建立：

```text
DecodedPageSlabPool
```

固定 256 KiB slab。

生命周期：

```text
acquire slab
→ worker decode
→ upload
→ release slab
```

第一阶段可以基于 transferable `ArrayBuffer` pool。

极限阶段可以验证：

```text
SharedArrayBuffer slab arena
```

配合 cross-origin isolation / WASM threads；是否最终采用以 Chrome/Firefox/Safari 实测为准，不把 SAB 本身写入 disk/runtime ABI。

---

# 38. Main Thread 的职责必须保持“控制面”

允许：

```text
scan demand bitset
update typed-array state
priority heap operations
construct small upload/address update lists
encode GPU commands
```

禁止：

```text
LZ4 decode
meshopt decode
hash whole large buffer
parse huge GLB
copy merged ranges into per-page buffers
large geometry transform
```

目标是让 Streaming Main-thread cost 与 source asset 总大小解耦。

---

# 39. GPU Upload Path

V3.0 baseline：

```text
Decoded Page slab
      ↓
GPUQueue.writeBuffer(bankBuffer, slotOffset, pageBytes)
```

每 Page 固定 256 KiB，很适合 bounded batching。

上传预算按帧控制：

```text
maxUploadBytesPerFrame
maxUploadsPerFrame
```

### 39.1 为什么先不强制 custom staging ring

浏览器 WebGPU 内部 `writeBuffer` 已包含实现层 staging/copy。

如果我们自己额外实现：

```text
MAP_WRITE staging ring → unmap → copyBufferToBuffer
```

不保证一定更快，反而增加 map 生命周期与 JS 状态管理。

因此：

> **先把 `writeBuffer` 作为测量 baseline。**

如果 benchmark 证明显式 staging ring 在目标浏览器/平台稳定更快，再在不改变 Page ABI 的前提下替换 Upload Backend。

这不是兼容路径，而是同一 Runtime 的可测量 backend optimization。

---

# 40. Page Publication：必须先上传，再 publish location

一页从 decoded 到 resident 的 commit：

```text
1. allocate PhysicalSlot
2. queue.writeBuffer(GeometryBank, slotOffset, 256 KiB)
3. queue.writeBuffer(PagePhysicalLocation[pageId], physicalSlot)
4. mark CPU state = RESIDENT at publication boundary
5. next GPU traversal may use it
```

WebGPU queue operations具有顺序关系；只要 Page payload 写入排在 location publish 之前，后续 GPU work 不会先看到一个“指向未上传数据”的 location。

### 40.1 不逐 Group patch

这是 B 相比 Nyx 的重要优化：

Nyx page ready 后需要为 Page 内所有 Group 更新：

```text
GroupDataLocation[group]
```

EEngine 只更新：

```text
PagePhysicalLocation[page]
```

**1 record/page。**

---

# 41. Publish 发生在 Frame Boundary

不允许任意 Promise completion 直接在 frame 中途修改 GPU residency table。

Worker/network completion 只进入：

```text
DecodedReadyQueue
```

每帧统一：

```text
beginFrameStreamingCommit()
```

执行：

```text
retirement completion
address invalidation
page uploads
page publish
```

然后才开始本帧 Culling / Rendering command encoding。

这样每一帧看到的是一个明确的 residency snapshot。

---

# 42. Eviction：不能“直接 free slot”

Nyx 在 native DX12 有显式 fence / frame timeline。

WebGPU application 没有暴露可直接比较的原生 fence value。

危险实现：

```text
CPU invalid page
→ immediately reuse same slot for another page
```

此时上一个已经提交、但仍在 GPU 执行的 frame 可能还在读取旧 Slot。

结果：

```text
old draw reads new page bytes
→ random geometry corruption
```

这是 ADR-B 必须解决的核心 correctness 问题。

---

# 43. `GpuSubmissionTracker`

新增：

```ts
class GpuSubmissionTracker {
  latestSubmittedSerial: u32
  completedSerial: u32
}
```

每次 EEngine renderer 统一 submit：

```text
serial++
queue.submit(...)
```

异步注册：

```text
queue.onSubmittedWorkDone()
  .then(() => completedSerial = max(completedSerial, capturedSerial))
```

### 43.1 不能每 Page 调一次 `onSubmittedWorkDone()`

只按 submission / 有 retirement 的帧做 coarse tracking。

Page retirement 只记录 serial 数字。

### 43.2 Frame Path 不 await

禁止：

```ts
await queue.onSubmittedWorkDone()
```

出现在稳态 render loop。

Promise completion 只异步更新 `completedSerial`。

---

# 44. GPU-safe Eviction 顺序

当 Page P 被选中 eviction：

```text
oldSlot = physicalSlot[P]
lastPossibleUserSerial = latestSubmittedSerial
```

先：

```text
PagePhysicalLocation[P] = INVALID
```

未来 submission 从此无法发现 P。

CPU：

```text
state[P] = RETIRE_PENDING
retireSerial[P] = lastPossibleUserSerial
```

**slot 仍不进入 free pool。**

等：

```text
completedSerial >= retireSerial[P]
```

再：

```text
slotOwner[oldSlot] = INVALID
freePool.push(oldSlot)
physicalSlot[P] = INVALID
state[P] = COLD
```

这相当于 WebGPU 版 deferred destruction / deferred reuse。

---

# 45. Serial wrap

`u32 submission serial` 足够，但比较必须使用 wrap-safe unsigned distance。

Invariant：

```text
outstanding GPU submissions << 2^31
```

这是显然成立的。

也可以在 JS 中用 safe integer Number 保存 serial；GPU 不需要看到 serial。

实现时优先简单、安全的 Number monotonic counter，只有持久运行到极端值才需要 rollover handling。

---

# 46. Eviction Candidate Policy

禁止只做：

```text
min(lastUsedFrame)
```

最终 score 至少考虑：

```text
ageFrames
pinned/root
coarseCoverageImportance
residentDuration
recentReloadCount
consecutiveDemand
predictedNeed
pageCompressedCost
```

概念：

```text
victimScore =
    + oldAge
    + lowCoarseImportance
    + lowRecentDemand
    - reloadPenalty
    - ancestorProtection
```

分数公式属于 benchmark tuning，不进 ABI。

---

# 47. Root 与 Coarse LOD 的保护级别

```text
Root Page          → hard pinned，永不正常 eviction
Coarse non-root    → very high retention weight
Fine Page          → normal eviction candidate
Very fine / costly → first victim under pressure
```

这样在 VRAM pressure 下视觉表现是：

```text
先降低细节
```

而不是：

```text
随机丢整块几何
```

---

# 48. High / Low Watermark Hysteresis

若每次只在 `freeSlots == 0` 时 evict 1 Page：

```text
load 1
free 1
load 1
free 1
```

会产生严重 churn。

所以定义：

```text
freeSlotLowWatermark
freeSlotTargetWatermark
```

当 free slots 低于 low：

```text
evict until target
```

一次制造一段 breathing room。

同样地，网络 / decode queue 都使用 hysteresis，而不是刚触发阈值就来回启停。

---

# 49. Thrash Detection

记录：

```text
page evicted at frame X
same page demanded again within N frames
```

计为：

```text
reRequest / thrash
```

连续 thrash：

- 增加该 Page retention weight；
- 增大 global eviction grace；
- 降低 speculative/predicted stream；
- 提示 resident budget 可能过低。

Telemetry 必须直接暴露：

```text
pageThrashCount
thrashBytes
reRequestLatency
```

否则“显存看起来没超，但画面飞行时不断抖动”的问题非常难查。

---

# 50. Resident Cut / Refinement 正确性

A 已保证：

```text
all root pages resident
→ valid renderable coarse cut
```

C 的 traversal 在想 refine 时：

```text
coarse meshlet.refineGroupId
       ↓
GroupDirectory[refineGroup]
       ↓
PagePhysicalLocation[refinePage]
```

如果 refine Page non-resident：

```text
demand refine Page
keep coarse representation
```

如果 resident：

```text
apply LOD error test
possibly replace coarse with fine
```

因此 missing Page 的正常结果不是 hole，而是：

```text
quality fallback to nearest resident ancestor
```

这和 Nyx 的 `RefineGroupIndex` 语义一致。

---

# 51. 不需要为了 eviction 做复杂“全 DAG 可达性证明”

因为 Root Set hard pinned。

即使所有非-root pages 都被驱逐：

```text
root cut remains legal
```

所以 eviction correctness 可以保持简单：

```text
never evict pinned root
```

其他 Page 的 eviction 只影响 refinement quality，不影响“是否有可渲染 representation”。

这正是 Cooker 阶段离线保证 Root Contract 的价值。

---

# 52. Frame-time Adaptive Streaming Budget

“加载最快”不等于“运行最快”。

EEngine 的目标是：

> 在不破坏当前 frame latency 的前提下，尽快提高 resident quality。

每帧 Streaming Controller 输入：

```text
CPU frame time
GPU frame time / timestamps（若启用）
current upload backlog
free slots
visible page misses
```

输出：

```text
uploadBytesThisFrame
maxNewDecodes
maxNewNetworkBatches
```

例如 GPU frame 接近预算时：

```text
upload budget ↓
speculative fetch ↓
P1 visible fault 仍保留
```

Bootstrap 阶段则是另一模式：

```text
no interactive frame yet
→ maximize root throughput within memory cap
```

---

# 53. 不让 Scheduler 本身变成大 CPU 开销

百万 Page 下不能每帧：

```text
sort(all pages)
```

设计：

- Demand scan只访问 bitset 中 set bits；
- resident candidate 使用 age buckets / lazy heap；
- queued fault 只对 active working set 排序；
- background quality fill 分批维护；
- typed-array table O(1) direct index。

Eviction 可以用：

```text
approximate LRU buckets
```

而不是每帧完整 resident list sort。

---

# 54. Page Demand Bitset 扫描

扫描算法：

```text
for each u32 word
  while word != 0
    bit = ctz(word)
    pageId = wordIndex * 32 + bit
    processDemand(pageId)
    word &= word - 1
```

只对 set bits 做完整逻辑。

若 JS `Math.clz32`/bit tricks 足够快，直接 JS 扫描；若 profiling 证明占用明显，再放 Worker 或使用 FaultQueue 辅助。

不要一开始为了 125 KiB bitset引入复杂 GPU compaction pass。

---

# 55. IO Failure：明确拒绝 Nyx 当前零填充行为

当前 Nyx `GeometryStreaming.cpp` 的 I/O worker：

```text
ReadPageFromFile success → OnPageIOComplete(pageData)
ReadPageFromFile failure → 仍 OnPageIOComplete(zero-initialized pageData)
```

Root pin path也会在读取失败时把 page 置零继续上传。

这对 demo 容错可能方便，但对于 EEngine Production Virtual Geometry 是危险的：

```text
address table declares resident
但 bytes 不是合法 Group/Meshlet payload
```

可能产生：

```text
bad counts
bad offsets
out-of-bounds logical decode
corrupt geometry
```

### ADR-B 决策

失败 page：

```text
NEVER publish physical location
NEVER mark RESIDENT
```

流程：

```text
fail
→ release decoded slab / network buffer
→ state FAILED_COOLDOWN
→ retry policy
```

Root failure达到 retry limit：直接 scene bootstrap error。

---

# 56. Integrity Validation

每 Page 至少验证：

```text
compressed length
codec decode result == 262144 bytes
decoded content hash / checksum contract
requestGeneration
pack identity
```

可根据 A 的 `decodedContentHash128` + compressed checksum 做两层：

```text
cheap compressed checksum
+ decoded content identity
```

Production CDN content-hashed pack 下，可根据性能测试决定是否每次都做强 SHA；但**至少必须能检测错误和 cache corruption**。

Cache hit 的数据不能因为“来自本地”就跳过 identity validation。

---

# 57. OPFS Cache Corruption 处理

```text
OPFS page read
→ checksum fail
→ delete cache entry
→ network refetch
```

不要把 cache corruption 当场景致命错误。

网络 fetch 后再次失败才走 Page failure/retry policy。

---

# 58. Cancellation

允许取消：

```text
QUEUED
FETCHING
COMPRESSED_READY
DECODING
```

通常不取消：

```text
UPLOAD_QUEUED
```

因为已经接近 publication，取消收益小且状态复杂。

取消依据：

- Page 长时间不再 demanded；
- priority 被 camera teleport 后完全淘汰；
- memory pressure；
- scene unload。

Root task不可因 camera change 取消。

---

# 59. Camera Teleport 模式

这是 Streaming System 必须单独设计的压力场景。

Teleport 后：

```text
old fine demand → stale
new region → massive visible misses
```

Scheduler：

1. Root pages保持；
2. stale P3/P4 网络请求快速 cancel；
3. stale decoded-ready pages若未 upload可丢弃；
4. P1 new-visible 立即抢占；
5. eviction grace对刚刚旧区域的 fine pages可临时缩短；
6. coarse pages仍高 retention。

不能让旧视角的 500 个 fine fetch 堵住新视角。

---

# 60. Range Fetch 并发不是越高越好

HTTP/2/3 + CDN 下，过多 256 KiB Range 并发可能：

- 增加 header/connection scheduling；
- 增加 JS Promise 数；
- 破坏 range locality；
- 让 decode ready queue 爆满。

所以 `maxNetworkRequests` 是动态 budget。

推荐初始 benchmark sweep：

```text
2 / 4 / 8 / 16
```

而不是写死 32/64。

---

# 61. Device Loss

EEngine V3 把：

```text
Virtual identity
```

和：

```text
Physical residency
```

分离后，device loss恢复很自然。

保留：

```text
scene manifest
oegpack metadata
page directory
OPFS cache
page demand history（可选）
```

销毁/重建：

```text
GeometryPageHeap
PagePhysicalLocation GPU buffer
Demand GPU buffer
Readback ring
physical slot ownership
```

恢复：

```text
new GPUDevice
→ allocate metadata bindings
→ all page locations INVALID
→ load/publish pinned root pages
→ render coarse
→ resume demand streaming
```

不需要：

```text
reload GLB
rerun geometry cooker
```

---

# 62. Scene unload

卸载一个 pack/asset 时：

1. 禁止生成新 demand；
2. cancel queued/fetch/decode tasks；
3. invalidate all its PagePhysicalLocation entries；
4. resident pages进入 RETIRE_PENDING；
5. GPU submission safe 后回收 slots；
6. 回收 runtime page/group/hierarchy range；
7. cache不需要删除。

Dense runtime index ranges第一版可以采用 scene epoch 一次性分配，不做运行中频繁 hole reuse；动态场景 hot-load 以后再增加 range allocator。

---

# 63. GPU Bank Binding 与 ADR-C 的边界

B 冻结：

```text
physicalSlot → bankIndex + slotInBank
```

但不冻结：

```text
一个 render pass 同时绑定几个 Geometry Banks
```

原因是它取决于 C 的 pipeline 资源预算：

```text
visible-work buffer
instance data
material data
page location
geometry bank bindings
...
```

WebGPU core 默认只有 8 storage-buffer slots / shader stage，因此 C 必须把整个 shader binding layout 一起算。

B 的规则只有：

> **任何被 publish 为 resident 的 Page 必须位于 ADR-C 当前 execution profile 能访问的 bank set 内。**

第一实现建议从固定 2～4 bank profile benchmark，不盲目追求极大 physical heap。

---

# 64. 为什么不引入“Bank Compaction”

若显存空间由固定 Page slot组成：

```text
Bank 0: used/free/used/free
```

free slot 本身就是有效可分配空间，没有外部碎片。

因此无需：

```text
把 Page A 从 Slot 10 搬 Slot 2
```

这种 move 只制造：

- GPU copy；
- location patch；
- submission hazard；
- cache invalidation。

Virtual memory 的核心价值之一就是**物理位置不要求连续**。

---

# 65. Scheduler 与 `RuntimeAssetManifestV2` 的关系

当前 RuntimeAssetManifest V2 已经有：

```text
byteOffset
compressedBytes
decodedBytes
expectedResidentBytes
checksum
requiredFeatures/limits
```

这些概念继续保留在整个 EEngine Asset System。

但 Geometry V3 的百万 Page directory 不再用 JSON/chunk string 逐条表达。

B 直接消费 A 的 binary：

```text
GeometryPageDirectoryV3[]
```

因此：

```text
RuntimeAssetManifestV2 = 普通资产通用语义
OegPackV3 PageDirectory = 大规模 Virtual Geometry 专用紧凑实现
```

不是二选一，也不是把 V2 Map/string model硬扩到百万 Page。

---

# 66. `GpuSceneResidencyManifest` 的演进

当前 `GpuSceneResidencyManifest` 在 cold-load 前计算：

```text
packageCount
sourceTriangles
meshlets
clusters
packageBytes
max work capacity
```

并验证整个场景 package 引用。

V3 不应继续把：

```text
all geometry package bytes
```

当成 cold-load admission 条件。

新增：

```text
VirtualGeometrySceneManifest
```

重点：

```text
residentMetadataBytes
runtimePageCount
runtimeGroupCount
hierarchyNodeCount
bootstrapPageCount
bootstrapDecodedBytes
bootstrapCompressedBytes
maxPinnedBytes
maxVisibleWorkCapacity
```

Cold-load admission 只需要证明：

```text
resident metadata + root pages + renderer work queues
```

装得下。

Fine Pages 属于 virtual address space，不属于 startup resident set。

---

# 67. `AssetWorkerPool` 的复用边界

保留：

```text
priority queue
maxWorkers
in-flight estimated bytes
AbortSignal
Transferable
failure circuit breaker
```

需要改变：

当前 3 priority classes 不足以直接表达 B 的 5 streaming classes。

两个选择：

```text
A. Geometry scheduler先排序，再把 admitted task 映射到 WorkerPool 3 priority
B. 泛化 WorkerPool priority count
```

建议 A。

理由：真正的高级 priority policy 应该只存在一处：

```text
GeometryStreamingScheduler
```

WorkerPool只负责资源 admission，不再复制一套完整策略。

---

# 68. 模块边界

建议新增：

```text
OEngine/src/assets/streaming/
  VirtualGeometryRuntime.ts
  VirtualGeometryResidencyTable.ts
  GeometryStreamingScheduler.ts
  GeometryPageDirectoryView.ts
  GeometryPageSource.ts
  GeometryRangePlanner.ts
  GeometryPageCache.ts
  GeometryPageDecodePool.ts
  GeometryStreamingEvidence.ts

OEngine/src/gpu/
  GeometryPageHeap.ts
  GeometryPageLocationTable.ts
  GeometryDemandFeedback.ts
  GeometryPageUploadQueue.ts
  GpuSubmissionTracker.ts
```

C++ / WASM shared core：

```text
native/oengine-asset-core/runtime/
  page_decode.h
  page_decode.cpp
  lz4_page_decoder.cpp
  page_integrity.cpp
```

---

# 69. `VirtualGeometryRuntime`

顶层 ownership：

```text
VirtualGeometryRuntime
│
├─ metadata sets
├─ VirtualGeometryResidencyTable
├─ GeometryStreamingScheduler
├─ GeometryPageSource
├─ GeometryPageCache
├─ GeometryPageDecodePool
├─ GeometryPageHeap
├─ GeometryPageLocationTable
├─ GeometryDemandFeedback
├─ GeometryPageUploadQueue
└─ GpuSubmissionTracker
```

只有这个对象负责 geometry virtual memory lifecycle。

Renderer/Culling 只能获得 GPU bindings + stable runtime bases，不直接调用 fetch/decode。

---

# 70. `GeometryPageSource`

接口概念：

```ts
interface GeometryPageSource {
  fetchMetadata(pack): Promise<PackMetadata>;
  fetchRangeBatch(batch, signal): Promise<ArrayBuffer>;
}
```

Production 实现：

```text
HttpRangeGeometryPageSource
```

测试实现：

```text
MemoryGeometryPageSource
```

测试 source 不是 runtime compatibility path，只用于 deterministic unit test。

---

# 71. `GeometryPageCache`

接口：

```text
lookup(pageKey)
store(pageKey, compressedBytes)
evictCacheEntries(targetBytes)
```

实现：

```text
OPFSGeometryPageCache
```

Cache 有独立 budget，不和 GPU residency budget混在一起。

---

# 72. `GeometryPageUploadQueue`

职责：

- 接受 decoded-ready pages；
- 按 priority 排序；
- 在每帧 upload budget 内挑选；
- 向 GeometryPageHeap 请求 slot；
- encode/write 256 KiB payload；
- 批量更新 PagePhysicalLocation；
- 更新 CPU residency state。

它**不负责 fetch/decode**。

---

# 73. Address Table Update Batching

Page location 每条只有 u32。

若本帧发布 pages：

```text
1, 2, 3, 100, 101
```

先按 RuntimePageIndex 排序并合并连续 ranges：

```text
write [1..3]
write [100..101]
```

Eviction invalidation同样 batch。

避免每页一个 `queue.writeBuffer()` call。

---

# 74. Demand Feedback 与 Culling 的精确接口

ADR-C 必须提供：

```text
fn geometryDemandPage(pageId)
fn geometryIsPageResident(pageId) -> bool
fn geometryLoadGroupAddress(groupId) -> { bankIndex, byteOffset }
```

B 提供的概念数据：

```text
AssetRuntimeRecord.pageBase
GroupDirectoryV3.pageId
offsetInDecodedPage
PagePhysicalLocation[]
DemandBitset[]
```

C 不知道：

```text
HTTP URL
LZ4
OPFS
Worker
retry
```

这保证 renderer 与 IO system 完全解耦。

---

# 75. Culling hot-path 地址解析伪代码

```wgsl
fn resolve_group(asset: AssetRuntimeRecord, localGroupId: u32) -> GroupResolve {
    let globalGroupId = asset.groupBase + localGroupId;
    let group = groupDirectory[globalGroupId];
    let page = asset.pageBase + group.pageId;

    mark_page_demand(page);

    let physical = pagePhysicalLocation[page];
    if (physical == INVALID_U32) {
        return GroupResolve(false, 0u, 0u);
    }

    let bank = physical >> 9u;
    let slot = physical & 511u;
    let byteOffset = (slot << 18u) + group.offsetInDecodedPage;
    return GroupResolve(true, bank, byteOffset);
}
```

这就是 B 与 C 之间最重要的 runtime ABI。

---

# 76. 不把 HTTP/Worker 状态暴露给 Shader

Shader 只认识：

```text
resident / non-resident
```

不要编码：

```text
FETCHING
DECODING
FAILED
```

到 GPU table。

这些是 CPU scheduler 的细节。

这样 GPU hot table 永远最小。

---

# 77. Multi-scene / Multi-pack

第一版 Advanced Renderer 建议一个 `VirtualGeometryRuntime` 管理当前 renderer world 的所有 active packs。

所有 pack共享：

```text
PagePhysicalLocation
DemandBitset
GeometryPageHeap
```

每 pack只有 base ranges。

优点：

- 全场景统一显存预算；
- 一个 pack不会把自己预算用满而另一个空闲；
- eviction可以跨 pack选最差 victim；
- readback只有一套。

---

# 78. Streaming Scheduler 的 Pack Locality

Priority 不能只看视觉，也要把 IO locality作为 secondary factor。

如果：

```text
Page A priority 100, offset 1 GB
Page B priority 99,  与 A 相邻
Page C priority 100, offset 8 GB
```

可能选择：

```text
A+B merged range
```

比 A+C 两个 request 更划算。

但 locality 永远不能让低价值 P4 压过 P1 visible fault。

---

# 79. Streaming Budget Controller 模式

定义两个运行模式：

## BOOTSTRAP

目标：最快完成全部 Root Pages。

```text
higher network concurrency
higher decode admission
higher upload burst
no frame-preservation concern before first frame
```

仍然受 peak memory budget控制。

## INTERACTIVE

目标：保护 frame latency。

```text
bounded upload/frame
bounded scheduler CPU
P1/P2 preempt P3/P4
adaptive throttle
```

---

# 80. Bootstrap 不能调用 Nyx 式同步 `Finish(true)` 模式

Nyx Root Pin path最后显式 `Finish(true)` 等 GPU upload结束，这是 native engine 启动阶段可接受的选择。

Web Runtime 可以等待 Bootstrap promise 才开始第一帧，但不要把 GPU wait嵌进日常 render loop。

Bootstrap 可以：

```text
submit root uploads
await one bootstrap completion boundary
```

只发生一次。

Steady-state：

```text
never wait
```

---

# 81. Resource Accounting

`GeometryPageHeap` 接入 EEngine 现有 `ResourceAccounting` 风格：

至少区分：

```text
allocatedBankBytes
residentPageBytes
pinnedPageBytes
retiringPageBytes
freeSlotBytes
```

不能只报告：

```text
GPUBuffer.size total
```

否则看不出 resident efficiency。

---

# 82. Evidence / Telemetry 是一等功能

每帧或 rolling-window 输出：

### Demand

```text
demandedPages
residentDemandHits
pageFaults
consecutiveDemandPages
feedbackDroppedFrames
feedbackReadbackBytes
feedbackLatencyFrames p50/p95/p99
```

### Network

```text
rangeRequests
rangeResponseBytes
usefulCompressedBytes
overfetchBytes
rangeMergeRatio
networkInFlightBytes
cancelledRangeRequests
```

### Cache

```text
cacheHits
cacheMisses
cacheHitBytes
cacheCorruptions
cacheEvictions
```

### Decode

```text
decodePages
decodeInputBytes
decodeOutputBytes
decodeWorkerMs
decodeMBps
decodeInFlightEstimatedBytes
decodedReadyBytes
```

### GPU Residency

```text
residentPages
residentBytes
pinnedPages
pinnedBytes
freeSlots
retiringPages
retiringBytes
pageUploads
uploadBytesPerFrame
locationTableWriteCalls
```

### Eviction

```text
evictedPages
evictedBytes
reRequestedPages
thrashPages
meanResidentLifetime
```

### User-visible latency

```text
TTFMF
pageFaultToResidentLatency p50/p95/p99
qualityConvergenceTime
```

### Runtime Health

```text
failedPages
retries
staleCompletions
abortedTasks
deviceLossCount
budgetThrottleFrames
```

---

# 83. Debug Overlay

建议直接显示：

```text
Virtual Pages:  8,420
Resident:       1,221 / 2,048 slots
Pinned:            43
Demanded frame:    312
Faults:             18
Fetching:           24
Decoding:            8
Decoded Ready:      11
Retiring:            7
GPU Upload:       3.5 MiB/frame
OPFS hit:          83%
Thrash:            0.7%
```

同时支持颜色 visualizer：

```text
green  = resident fine
blue   = root/coarse
orange = fallback due missing refinement
red    = page fault
purple = newly uploaded
```

这会极大提升 C 联调效率。

---

# 84. Failure & Retry Policy

建议：

```text
attempt 0 → immediate
attempt 1 → short backoff
attempt 2 → larger backoff
attempt 3 → cooldown
```

不要无限每帧 retry。

Root Page：

```text
bounded retries exhausted → fatal bootstrap error
```

Fine Page：

```text
mark failure telemetry
continue rendering ancestor
future meaningful demand可重新尝试
```

HTTP 4xx content/config error与 transient network error区分。

---

# 85. Security / Robustness

Pack metadata来自网络，不能无条件相信。

加载前检查：

```text
pageId range
compressed offset + bytes within file
no overlapping illegal metadata ranges
decodedBytes == 262144
codec known
Group range within page
hash/checksum sizes
```

Worker decoder必须：

```text
bounded output = exactly 256 KiB
```

禁止 codec 根据恶意 header 分配任意大内存。

---

# 86. Web Worker / WASM 的部署要求

Runtime CPU heavy path都在 Worker。

如果启用：

```text
SharedArrayBuffer
WASM threads
shared slab arena
```

Production deployment必须配置 cross-origin isolation（COOP/COEP）。

ADR-B 不让正确性依赖 Worker 内部 WebGPU device；GPU resource ownership仍保留在 renderer/device owner，Workers只做：

```text
cache IO
compressed byte processing
decode
integrity
```

这也与 EEngine 当前 GraphicsContext ownership 更一致。

---

# 87. WebGPU API 的使用原则

B 依赖的标准能力：

```text
GPUBuffer COPY_SRC/COPY_DST/STORAGE/MAP_READ
GPUCommandEncoder.clearBuffer
GPUCommandEncoder.copyBufferToBuffer
GPUQueue.writeBuffer
GPUBuffer.mapAsync
GPUQueue.onSubmittedWorkDone
GPUDevice.lost
```

全部属于标准 WebGPU 资源/timeline能力。

2026 WebGPU spec 对 Promise settlement 有明确 timeline 规则；B 不依赖 promise 之间未保证的隐含顺序，只依赖 queue submission ordering与自己维护的 serial。

---

# 88. 当前 EEngine 文件的演进方案

## `RuntimeAssetResidency.ts`

保留。

不扩展成百万 Page table。

新增 `VirtualGeometryResidencyTable.ts`，复用其四态语义。

## `GpuAssetStore.ts`

不改造成 Page allocator。

Advanced Virtual Geometry path完成后，Geometry V3 不再经由 whole-package `GpuAssetStore.residentMany()`。

## `MeshletGpuPool.ts`

不作为 V3 physical storage。

其 variable allocation / compact / grow 路径与固定 Page Slot冲突。

## `GpuSceneResidencyManifest.ts`

新增 Virtual Geometry 版本，cold-load proof从“全 package resident”改为“metadata + root working set + queues resident”。

## `GeometryHierarchy.ts`

CPU oracle保留。

增加 residency-aware oracle test：

```text
refine desired + child nonresident
→ select coarse + demand child page
```

用它验证 ADR-C GPU traversal。

## `AssetWorkerPool.ts`

复用 worker lifecycle / memory admission；Geometry scheduler在外层控制更细 priority。

---

# 89. Nyx → EEngine 逐模块迁移表

| Nyx | EEngine B | 决策 |
|---|---|---|
| `PageResidency` | `VirtualGeometryResidencyTable` | 保留语义，改 SoA typed arrays |
| `m_PageTableCPU` | dense runtime page table | 直接吸收思想 |
| `PhysicalSlot` | packed physical slot u32 | 更紧凑 |
| `m_FreePool` | `GeometryPageHeap.freeSlots` | 保留固定 slot pool |
| `m_GeometryChunksGPU` | `GeometryPageHeap.bankBuffers` | 256MiB chunk→128MiB-class bank |
| `GroupDataLocationGPU` | `PagePhysicalLocationGPU` | 提升到 Page 粒度 |
| `GroupMetadata.PageIndex` | `GroupDirectoryV3.pageId` | A 已冻结 |
| request mask by Group | demand bitset by Page | WebGPU/Page-first 优化 |
| 3 native readbacks | 4-slot WebGPU mapAsync ring | non-blocking |
| fence values | submission serial tracker | WebGPU timeline adaptation |
| file IO thread | HTTP Range + OPFS worker | Web-native |
| LZ4 in IO thread | bounded decode worker pool | pipeline/backpressure |
| `PinRootPages` | strict BootstrapPin | 必须 pin 全部 required roots |
| partial root pin budget | scene admission failure | correctness强化 |
| zero page on read fail | fail closed | production correctness |
| immediate native free | retire-after-submission-complete | WebGPU safety |
| `LastUsedFrame` | `lastDemandFrame` | 保留且 demand resident pages |
| page upload + group patches | page upload + 1 page-location publish | 更少更新 |

---

# 90. B 与 C 的联合 Vertical Slice

完整 B 实施前先做一个小闭环：

```text
.oegpack with root + 1 fine page
       ↓
load metadata
       ↓
load root page
       ↓
publish root physical slot
       ↓
debug compute sets fine page demand bit
       ↓
readback
       ↓
fetch/decode fine page
       ↓
upload/publish
       ↓
debug shader confirms resident
       ↓
evict fine page
       ↓
submission-safe slot reuse
```

通过后再接真正 ADR-C DAG traversal。

这能在 shader/raster复杂度进入前，把 Streaming correctness单独证明。

---

# 91. 实施阶段

## B0 — Contracts & CPU tables

实现：

```text
RuntimePageIndex ranges
VirtualGeometryResidencyTable
PagePhysicalLocation CPU mirror
GeometryPageHeap slot math
```

无网络、无 GPU feedback。

## B1 — Root Bootstrap

实现：

```text
metadata range read
root range fetch
decode worker
root upload
root pin
PagePhysicalLocation GPU
```

目标：只靠 root pages可启动 coarse scene。

## B2 — Demand Readback

实现：

```text
GPU demand bitset
clear/copy
4-slot mapAsync ring
CPU bit scan
lastDemandFrame
```

使用 debug demand kernel测试。

## B3 — Async Range Streaming

实现：

```text
GeometryRangePlanner
HTTP Range
requestGeneration
cancellation
network budget
```

## B4 — Worker Decode / Backpressure

实现：

```text
RangeBatch transfer
LZ4 page decode
slab pool
memory admission
DecodedReadyQueue
```

## B5 — Frame-budgeted Upload

实现：

```text
upload queue
batched location publish
per-frame budget
```

## B6 — Eviction & Submission Safety

实现：

```text
watermarks
value-aware victims
location invalidation
GpuSubmissionTracker
RETIRE_PENDING
safe slot reuse
```

## B7 — OPFS Cache

实现：

```text
cache worker
compressed page cache
write-behind
cache budget
```

## B8 — Evidence & Stress

实现全部 telemetry、debug overlay、fault injection。

之后进入 ADR-C full integration。

---

# 92. 单元测试矩阵

至少：

```text
Page location pack/unpack
INVALID location
runtime pack/page base mapping
state transition legality
request generation stale completion
root pin all-or-fail
free slot allocate/free
retire serial safety
bitset set/scan
readback ring slot lifecycle
range merge planner
HTTP 206 validation
wrong Content-Range rejection
LZ4 size mismatch
hash mismatch
cache corruption
worker abort
network abort
upload budget
watermark eviction
root never evict
camera teleport cancellation
thrash detector
device loss reset
```

---

# 93. Fault Injection Tests

主动模拟：

```text
5% range request failure
truncated HTTP body
wrong checksum
worker crash
LZ4 corrupt block
mapAsync delayed 10 frames
all readback ring slots busy
GPU upload backlog
OPFS quota failure
cache stale/corrupt page
device loss during upload
device loss during retire
```

目标不是“没异常”，而是：

```text
state machine不死锁
root错误明确失败
fine错误保持coarse
slot不泄漏
不发布坏地址
```

---

# 94. Benchmark 场景

## Bistro

主要验证：

- 从“完整 GLB barrier”转成 root-first；
- metadata/root bytes；
- TTFMF；
- camera fly-through demand；
- resident page count；
- main-thread long tasks。

Bistro并不是 Geometry Streaming 的极限压力，但适合和旧 pipeline做直观 A/B。

## Synthetic Page Stress

生成：

```text
100k / 1M virtual pages
small resident budget
camera demand traces
```

专门测试：

```text
bitset
scheduler
LRU/eviction
readback
CPU metadata scale
```

## Nyx/Zorah-class Stress

用于后续 B+C 联合验证：

```text
huge virtual triangle count
small physical working set
high camera velocity
high refinement churn
```

---

# 95. 核心性能指标

B 完成后必须报告：

```text
TTFMF
bootstrapBytes
metadataBytes
rootCompressedBytes
rootDecodedBytes
rootUploadBytes
```

稳态：

```text
streamingMainThreadMs p50/p95/p99
feedbackLatencyFrames p50/p95/p99
networkUsefulMBps
rangeOverfetchRatio
cacheHitRate
decodeMBps
uploadMBPerFrame
residentGeometryMiB
physicalHeapUtilization
pageFaults/frame
faultToResidentMs p50/p95/p99
pageThrashRate
qualityFallbackCount
```

任何“加载快了”都必须能被这些指标解释。

---

# 96. 性能 Acceptance Criteria

不写无法控制网络的绝对秒数，但冻结这些结构性要求：

1. **First frame 前不得 fetch 全部 `.oegpack`。**
2. First frame 前 Geometry payload仅允许 Bootstrap Page Set。
3. steady frame不得同步等待：

```text
mapAsync
onSubmittedWorkDone
network
worker
OPFS
```

4. 所有 decode不在 Main Thread。
5. resident page publish只发生在完整 256 KiB payload可用之后。
6. non-root page missing不产生 geometry hole；必须有 coarse ancestor fallback。
7. root pages在 scene lifetime内不可正常 eviction。
8. physical slot不得在旧 GPU submission完成前复用。
9. Page read/decode/hash failure不得 publish resident location。
10. resident geometry bytes受硬 budget控制；不能因快速 camera motion无限增长。
11. camera teleport后 stale task必须可取消/淘汰。
12. demand feedback丢帧不得导致 renderer stall。

---

# 97. 第一版建议 tuning 参数（不属于 ABI）

这些只作为 benchmark 起点：

```text
pageBytes                    256 KiB  // ABI，已冻结
bankBytes                    128 MiB  // V3 profile
readbackRing                 4
networkConcurrency           sweep 4/8
rangeBatchBytes              sweep 1/2/4 MiB
workerCount                  min(4, hwConcurrency/2) 起测
decodeInFlightBytes          128~256 MiB 起测
uploadBytesPerFrame          4/8/16 MiB sweep
evictionGraceFrames          8/16/30 sweep
```

最后选值必须来自：

```text
Bistro + synthetic + target desktop browser
```

而不是凭感觉冻结。

---

# 98. 明确不做的事

B 不做：

```text
WebGL fallback
raw GLB Runtime load fallback
Draco runtime compatibility path
Cesium / 3D Tiles
256 MiB DX12 Chunk照搬
one-object-one-file geometry
whole pack decompression
main-thread decode
synchronous GPU readback
missing-only feedback
page heap compaction
partial root pinning
zero-filled failed geometry page publication
```

---

# 99. 与 ADR-0016-A 的一致性检查

| ADR-A Contract | ADR-B 实现 |
|---|---|
| Page=256 KiB | fixed physical slot 256 KiB |
| Group不跨Page | group address = page base + local offset |
| Page独立解码 | worker task per page/range batch |
| Root cut合法 | all root pages hard pinned |
| metadata常驻 | hierarchy/group/page metadata先读 |
| logical/physical分离 | RuntimePageIndex + PagePhysicalLocation |
| Range-friendly pack | HTTP Range planner |
| Raw/LZ4 Page codec | Worker decoder |
| Disk pack ≠ GPU bank | `.oegpack` range source + 128MiB banks |
| Runtime不结构性Cook | 只decode/upload/rebase IDs |

无架构冲突。

B 只对 A §44 的 placeholder 做了更明确选择：

```text
GroupDataLocation / PageResidencyTable
```

收敛成：

```text
immutable GroupDirectory
+
dynamic PagePhysicalLocation
```

这是 Page-first 模型更高效的实现。

---

# 100. 与 Nyx 的一致性与有意偏离

## 直接移植

```text
Page as residency unit
fixed physical slots
free pool
root pinning
GPU demand feedback
asynchronous readback
LastUsedFrame semantics
async IO/decode
address translation
LOD ancestor fallback
```

## WebGPU 改写

```text
DX12 descriptor heap → fixed WebGPU Bank profile
native fence → submission serial + onSubmittedWorkDone
file thread → HTTP Range + OPFS Worker
Group request → Page demand
GroupDataLocation → PagePhysicalLocation
```

## 主动强化

```text
partial root pin → all-or-fail
I/O zero page → fail closed
single IO queue → bounded multi-stage backpressure
naive page age → value-aware eviction + hysteresis
whole page location updates by groups → one location record/page
```

---

# 101. 为什么这个方案比“GLB Loader 多线程化”更本质

GLB 多线程优化仍然是在解决：

```text
怎样更快地把全部资产准备好
```

B 解决的是：

```text
为什么要把全部资产准备好？
```

最终：

```text
Virtual Geometry = potentially huge
Physical Geometry = bounded working set
```

场景从 1 GB 扩展到 10 GB、100 GB 时，Runtime 的 GPU resident budget仍然可以保持在：

```text
hundreds of MiB class
```

性能取决于当前视野工作集，而不是源资产总大小。

这才是 Nyx/Nanite-like architecture 对 EEngine 的真正价值。

---

# 102. Final Architecture

```text
                            .oegpack
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
          Resident Metadata            Page Payloads
                 │                           │
                 │                    HTTP Range / OPFS
                 │                           │
                 │                    Range Batch Planner
                 │                           │
                 │                         Worker
                 │                    Decode + Integrity
                 │                           │
                 │                   Decoded Ready Queue
                 │                           │
                 │                    Upload Budgeter
                 │                           │
                 │                           ▼
                 │                 ┌──────────────────┐
                 │                 │ GeometryPageHeap │
                 │                 │ 128MiB Banks     │
                 │                 │ 256KiB Slots     │
                 │                 └────────┬─────────┘
                 │                          │
                 ▼                          ▼
       GeometryHierarchyNode       PagePhysicalLocation
       GeometryGroupDirectory              │
                 │                          │
                 └─────────────┬────────────┘
                               ▼
                      ADR-C GPU Traversal
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
          page is resident            page is missing
                 │                           │
          raster/refine                 keep coarse
                 │                           │
                 └─────────────┬─────────────┘
                               │
                               ▼
                       Page Demand Bitset
                               │
                       async Readback Ring
                               │
                               ▼
                     Streaming Scheduler
                               │
             ┌─────────────────┼─────────────────┐
             ▼                 ▼                 ▼
          touch LRU          load miss       plan eviction
                                                  │
                                                  ▼
                                       PagePhysicalLocation=INVALID
                                                  │
                                        GPU Submission Tracker
                                                  │
                                             safe reuse slot
```

---

# 103. 最终决策

ADR-0016-B 最终冻结如下架构主线：

```text
Nyx Page Streaming semantics
        +
ADR-A 256 KiB Geometry Page ABI
        +
Page-level GPU Demand Feedback
        +
WebGPU fixed-slot Physical Banks
        +
HTTP Range / OPFS / Worker decode
        +
frame-budgeted upload
        +
GPU-safe deferred eviction
        +
coarse resident fallback
```

实现完成后，EEngine Geometry 不再拥有传统意义上的：

```text
loadModel() → model fully loaded
```

而是：

```text
openVirtualGeometry()
    ↓
resident coarse cut
    ↓
continuous demand-driven refinement
```

这是 ADR-0016-C 能够真正实现 Nyx/Nanite-like GPU-driven continuous LOD 的基础。

---

# 104. ADR-C 必须遵守的 B 合同

ADR-C 不允许重新改变这些 B 决策：

```text
PageID is demand/residency unit
Demand includes resident usage
Root pages always pinned
PagePhysicalLocation is authoritative GPU residency marker
Group address derives from GroupDirectory + PagePhysicalLocation
Missing refinement keeps coarse ancestor
No synchronous readback
No unsafe slot reuse
```

C 可以优化：

```text
DAG traversal
work queues
subgroups
HZB
fault priority hints
visible meshlet compaction
indirect raster
bank execution profile
```

但不能重新把 Runtime 拉回：

```text
whole-asset residency
```

---

# 105. Source References

## EEngine

Repository:

```text
https://github.com/bigbigbig2/EEngine
commit cec226e6feb825ce4d682f97b1d966c8e71d0c6a
```

Primary reviewed files:

```text
OEngine/src/assets/RuntimeAssetResidency.ts
OEngine/src/assets/RuntimeAssetManifestV2.ts
OEngine/src/assets/RuntimeAssetPackage.ts
OEngine/src/assets/GeometryAssetPackage.ts
OEngine/src/geometry/GeometryCooker.ts
OEngine/src/geometry/GeometryHierarchy.ts
OEngine/src/gpu/GpuAssetStore.ts
OEngine/src/gpu/MeshletGpuPool.ts
OEngine/src/gpu/GpuSceneResidencyManifest.ts
OEngine/src/assets/codec/AssetWorkerPool.ts
```

## Nyx

Repository:

```text
https://github.com/moonlovelj/Nyx
commit bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b
```

Primary reviewed files:

```text
MiniEngine/Model/MeshletStructs.h
MiniEngine/Model/Model.h
MiniEngine/Model/ModelLoader.h
MiniEngine/Model/ModelConvert.cpp
MiniEngine/Model/MeshletBuilder.cpp
MiniEngine/Model/GeometryStreaming.h
MiniEngine/Model/GeometryStreaming.cpp
MiniEngine/Model/Shaders/DAGCull.slang
```

## WebGPU / Web Platform

```text
W3C WebGPU Candidate Recommendation Draft (2026)
https://www.w3.org/TR/webgpu/

Origin Private File System / FileSystemSyncAccessHandle
https://web.dev/articles/origin-private-file-system
```

---

# 106. Implementation Gate

在正式进入 B 重构代码前，必须满足：

```text
[ ] ADR-0016-A ABI structs 已确定为实现 target
[ ] .oegpack minimal writer/reader 可以产出 root + fine pages
[ ] B 的 PagePhysicalLocation 决策被接受
[ ] 物理 Bank size 与 Page size 不再变化
[ ] Root all-or-fail policy 被接受
[ ] no-sync-wait policy 被接受
```

通过后，建议严格按：

```text
B0 → B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8
```

实施，并在 B1/B2/B6 三个点分别做 benchmark gate。

**不要一次把整个 Streaming System 写完再测试。**

---

# 107. 结论

Nyx 已经证明：

```text
Hierarchy + Groups + Pages + Demand + Residency
```

可以组成真正的 virtualized geometry runtime。

EEngine 当前已经拥有：

```text
GPU-driven renderer foundations
hierarchy oracle
runtime asset validation
bounded worker infrastructure
resource accounting
```

ADR-0016-B 的作用，不是另起炉灶，而是把 Nyx 最有价值的 Streaming 核心接进 EEngine，并针对 WebGPU 的真实约束做一次彻底重构：

```text
Group feedback
     ↓
Page feedback

DX12 Chunk
     ↓
WebGPU Geometry Banks

Group physical table
     ↓
compact Page physical table

file IO thread
     ↓
HTTP Range + OPFS + Worker

native fence
     ↓
submission serial

partial root pin
     ↓
strict valid coarse cut
```

最终目标不是“Bistro 能加载”，而是：

> **无论 virtual geometry 总量多大，EEngine 都只让当前视觉工作集占据有限的网络、CPU、Worker 和 GPU residency budget，并保证每一帧都有合法的 resident coarse-to-fine geometry cut。**
