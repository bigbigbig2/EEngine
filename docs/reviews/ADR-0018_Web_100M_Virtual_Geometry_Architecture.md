# ADR-0018：Web Authored Large Virtual Geometry — Bounded Product Work 与后续 100M Scale

**状态**：Proposed  
**日期**：2026-09-21  
**适用项目**：EEngine  
**目标基线**：ADR-0016 / ADR-0017 之后的大规模虚拟几何阶段  
**当前正式目标**：Web 端稳定加载 `large.glb`（477,591,060 bytes、4,871,612 triangles、1,920 primitives、最大 primitive 1,364,306 triangles），完成 runtime cook、渐进发布、Multi-Product、GPU consumer、streaming 和 disposal。100M 保留为后续 scale gate。

> 2026-09-22 目标重置：本文早期章节中的 100M/250M/500M/1B 设计仍是长期
> scalability architecture，但不再是当前验收顺序或完成定义。当前权威验收顺序以
> 第 38、41、49 节的 authored K0/K1/K2 与 deferred S1 为准。

---

# 1. 决策摘要

EEngine 下一阶段不再以重写 `Geometry Product`、`VirtualGeometryResidency`、`Page Demand`、`Ancestor Fallback` 为主。

ADR-0016 / ADR-0017 已经解决了大部分：

> “GPU Runtime 如何把逻辑几何与物理驻留解耦。”

ADR-0018 当前要解决的是：

> “浏览器如何把真实 4.87M triangle authored 场景拆成确定、较小、可调度且可观察的 Cook quantum，而不是把原生离线 Cooker 作为一个不可抢占同步块搬进 Worker。”

当前禁止继续沿用的大模型路径是：

```text
large.glb
  ↓
Full Canonical ArrayBuffer
  ↓
Full Product Cook
  ↓
Full retainedGroups
  ↓
Single Giant Product
  ↓
GPU Streaming
```

ADR-0018 的目标路径：

```text
authored large GLB / glTF
      ↓
Metadata-only Catalog
      ↓
Spatial Cook Planning
      ↓
Bounded Source Window
      ↓
Bounded Canonical Shard
      ↓
Nyx-derived Cook
      ↓
Cook-and-Spill
      ↓
Incremental Product Shard Publication
      ↓
Multi-Product Runtime
      ↓
Bounded GPU Working Set
```

当前必须做到：

```text
Authored Scene:
4,871,612 triangles / 1,920 primitives

                 ↓ decouple

CPU live source window      bounded
WASM working memory         bounded
Product work quantum        bounded
Product task phase          observable
Session spill               separately budgeted
Product metadata            shardable
GPU geometry residency      bounded
Per-frame hierarchy work    bounded
Per-frame meshlet work      bounded
Per-frame raster work       bounded
```

---

# 2. 产品目标

## 2.1 主产品路径不变

主路径仍然必须是：

```ts
const asset = load_gltf("city.glb");
await renderer.uploadWebCookedScene(scene, asset);
```

而不是强制：

```text
Native Offline Cooker
→ OEGPACK
→ 部署
→ load_oegpack()
```

Offline Cooker / OEGPACK 继续作为第二路线：

- 预 Cook；
- CDN；
- 大型生产资产；
- 首次加载优化；
- benchmark / deterministic artifact。

它不是默认主路线。

---

# 3. 规模目标

阶段目标：

```text
Stage K0  large.glb complete cook and catalog coverage
Stage K1  large.glb runtime smoke and producer debt closure
Stage K2  large.glb formal PERF
Stage S1  100M source triangles (deferred scale gate)
Stage S2  250M / 500M / 1B logical diagnostics
```

100M 及以上不删除，只从当前 P0 验收降为 authored 目标通过后的扩展性证明。其中
1B 可以包含高实例化场景，但架构必须证明：

```text
logical geometry scale
!=
live working-set scale
```

---

# 4. 与 Nyx 的关系

ADR-0018 继续坚持：

> 几何算法优先迁移 Nyx，而不是重新发明一套完全不同的 Virtual Geometry 算法。

继续保持 Nyx 对齐的算法链：

```text
Meshlet
  ↓
Meshlet Group
  ↓
attribute / seam lock
  ↓
meshopt_simplifyWithAttributes
  ↓
coarse/refine relation
  ↓
LOD hierarchy
  ↓
BVH8
  ↓
fixed-size page
  ↓
root / fallback resident cut
  ↓
GPU hierarchy traversal
  ↓
SSE / Frustum / HZB
  ↓
demand
  ↓
streaming residency
```

继续重点参考：

```text
Nyx/MiniEngine/Model/MeshletBuilder.cpp
Nyx/MiniEngine/Model/ModelConvert.cpp
Nyx/MiniEngine/Model/GeometryStreaming.cpp
Nyx/MiniEngine/Model/MeshletStructs.h
Nyx/MiniEngine/Model/Shaders/DAGCull.slang
Nyx/MiniEngine/Model/Shaders/VBufferMesh.slang
```

但以下能力不能机械复制：

```text
DX12 bindless
Mesh Shader
native filesystem
native mmap
native IO threads
8 GiB geometry chunk pool
```

Web 侧替代为：

```text
bounded WebGPU storage banks
compute + indirect raster
Dedicated Worker / pthread Worker
HTTP Range / Blob.slice / OPFS
browser-local persistent Product cache
adapter-tier physical residency profile
```

---

# 5. 当前明确保留、不重写的部分

## 5.1 Geometry Product ABI

继续保留：

- ProductID；
- Revision；
- ProductGeneration；
- Asset Records；
- Root IDs；
- Hierarchy Nodes；
- Group Directory；
- Page Records；
- Activation / Bootstrap Pages；
- Vertex Format Records。

关键原则：

```text
Logical Product ABI
never contains physical GPU address
```

---

## 5.2 VirtualGeometryResidency

继续保留：

```text
Logical PageID
  ↓
Physical Slot
  ↓
(bankIndex, slotIndex)
```

支持：

```text
upload
resident
demand
retire
evict
reuse
```

不推翻。

---

## 5.3 Ancestor Fallback

继续保留：

```text
fine page missing
      ↓
resident ancestor
      ↓
render coarse geometry
      ↓
emit page demand
```

Camera movement / camera cut 时必须优先保证：

```text
no hole
no black geometry
no synchronous wait
```

---

## 5.4 256 KiB Page

继续保留当前：

```text
Page = 256 KiB
```

它与 Nyx 对齐，而且现阶段没有证据证明需要重做 Page Size。

---

# 6. 当前真正阻止 authored large 的瓶颈

当前长尾已经收敛到 CPU/WASM producer，而不是 GPU Virtual Geometry。根因优先级
调整为：

1. sharding 和 ordinary window 只受 byte budget 约束，没有 Cook Complexity Bound；
2. 64 MiB window 可包含很多 domains，并在 `portable-single` 中同步串行 cook；
3. `_oengine_web_geometry_cook_plan()` 是不可抢占同步块，watchdog 能检测但不能及时
   处理 CancelScope；
4. `units` 是已覆盖 catalog primitive 数，不是 Product/shard 进度；
5. session spill budget 误用 per-Product decoded budget 推导，无法覆盖完整 authored
   scene；
6. coverage-first bootstrap 未除以 estimated cook cost，可能过早选择最大 work item。

因此 P0 从“继续扩大规模”改为四维 Product Work Planner、Product Task Trace、catalog
coverage contract、独立 session spill budget 和 authored cook K0。

## P0-1：Full Canonical Input

当前仍存在：

```text
Primitive / Domains
  ↓
canonicalizeDomains()
  ↓
encodeWebCanonicalGeometryV1()
  ↓
single ArrayBuffer
  ↓
WASM
```

结果：

```text
Canonical Memory ∝ Total Geometry Size
```

100M triangle 时这是长期 scale gate 的第一道硬墙；对当前 authored 目标，首要问题是
单 Product 的同步 work quantum 没有被 triangle/domain work 限制。

---

## P0-2：retainedGroups 全量常驻

ADR-0017 已经做到：

```text
Descriptor first
Page payload later
```

但是 Web C++ plan 阶段仍然长期保留：

```cpp
std::vector<SerializedGroupV3> retainedGroups;
```

因此当前实际上只是：

```text
Page Buffer Virtualization
```

还不是：

```text
Cook Working Set Virtualization
```

---

## P0-3：Single Giant Product

当前大场景很容易形成：

```text
100M triangles
      ↓
one huge Product
```

问题：

- metadata 生命周期过大；
- replacement 粒度过粗；
- streaming priority 粒度过粗；
- reclaim 粒度过粗；
- world partition 无法独立管理；
- Worker / WASM owner 容易绑定整个场景。

---

## P0-4：Giant Primitive 没有空间分片

如果：

```text
primitive 0 = 100M triangles
```

仅仅按 primitive priority 不能解决问题。

必须支持：

```text
Primitive
  ↓
Spatial Split
  ↓
Virtual Geometry Shards
```

---

## P1-1：GPU Demand Queue Camera Cut 压力

当前：

```text
256 KiB readback
16 B / demand record
≈ 16K records
```

极端 camera cut 可能瞬间缺失数万 Page。

需要 GPU 侧先去重、聚合、压缩，再回读。

---

## P1-2：Previous-HZB-only 的工作放大

Nyx 可做：

```text
Previous HZB
→ first visibility
→ current depth
→ Current HZB
→ second visibility
```

EEngine 后续需要 WebGPU 特化版 late occlusion。

---

## P1-3：固定 384 vertex indirect raster

当前 Virtual Geometry meshlet 最多 128 triangle：

```text
128 × 3 = 384 vertices
```

固定 route 对小 meshlet 存在 vertex invocation 浪费。

---

# 7. ADR-0018 总体架构

```text
                        GLB / glTF / Blob / URL
                                  │
                                  ▼
                     ┌─────────────────────────┐
                     │ Scene Catalog Scanner   │
                     │ metadata / ranges only  │
                     └────────────┬────────────┘
                                  │
                                  ▼
                     ┌─────────────────────────┐
                     │ Spatial Cook Planner    │
                     │ primitive / shard plan  │
                     └────────────┬────────────┘
                                  │
                           bounded ranges
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
                 ▼                                 ▼
       Dedicated Worker A                 Dedicated Worker B
       C++ / WASM Cooker                  C++ / WASM Cooker
                 │                                 │
                 └──────────────┬──────────────────┘
                                │
                                ▼
                     Bounded Canonical Shard
                                │
                                ▼
                     Nyx Geometry Algorithms
               Meshlet / Group / Simplify / BVH
                                │
                                ▼
                     Product Shard Descriptor
                                │
                                ▼
                      Cook-and-Spill Store
                 ┌──────────┬──────────┬──────────┐
                 │          │          │          │
               Memory     OPFS      Blob Cache   HTTP/CDN
                 │          │          │
                 └──────────┴────┬─────┴──────────┘
                                 │
                                 ▼
                  Multi-Product Runtime Table
                                 │
                                 ▼
                   VirtualGeometryResidency
                                 │
                                 ▼
                Adapter-tier Physical Page Heap
                                 │
                                 ▼
                  GPU Hierarchy / HZB / SSE
                                 │
                  resident ──────┴──── missing
                     │                  │
                     ▼                  ▼
                Meshlet Work       Page Demand
                                      │
                                      ▼
                         GPU Demand Compaction
                                      │
                                      ▼
                         Delayed CPU Readback
                                      │
                                      ▼
                              Page Scheduler
                                      │
                                      ▼
                          Product/Page Provider
                                      │
                                      ▼
                               GPU Upload
```

---

# 8. 核心设计一：Metadata-only Scene Catalog

Catalog 阶段禁止读取完整 geometry payload。

只读取：

- scene graph；
- node transform；
- mesh/primitive metadata；
- material metadata；
- accessor type/count；
- bufferView byte ranges；
- source triangle count；
- primitive bounds；
- texture references；
- extension capability flags。

建议：

```ts
interface LargeGeometryCatalogEntry {
  assetKey: string;

  meshIndex: number;
  primitiveIndex: number;

  triangleCount: number;
  vertexCount: number;

  bounds: Aabb;

  positionRange: ByteRange;
  normalRange?: ByteRange;
  tangentRange?: ByteRange;
  uv0Range?: ByteRange;
  uv1Range?: ByteRange;
  indexRange: ByteRange;

  materialIndex: number;
}
```

Catalog 必须能够在不 materialize 全量 geometry 的情况下完成。

---

# 9. 核心设计二：Source Window

新增明确的 source-window budget：

```ts
interface SourceWindowBudget {
  maxSourceWindowBytes: number;
  maxCanonicalWindowBytes: number;
  maxCookWorkingBytes: number;
}
```

authored V1 初始目标：

```text
source window       64 MiB
canonical window    32 MiB
decoded Product     128 MiB per Product
session spill       1 GiB initial limit
```

这些是 workload policy，不应硬编码成 Geometry Product ABI。byte budget 也不能单独
决定 Product 是否足够小。

关键 invariant：

```text
peak live source bytes
must not scale linearly with total scene bytes
```

## 9.1 Product Work Planner

`CanonicalWindowPlanner` 与 `SpatialShardPlanner` 必须共享一组 work constraints：

```text
maxCanonicalBytes      = 32 MiB
maxTrianglesPerProduct = 128 Ki
maxVerticesPerProduct  = 512 Ki
maxDomainsPerProduct   = 64
```

单 primitive 超过任一上限就 spatial shard；ordinary batching 加入下一个 domain 会
超过任一上限就 flush。禁止出现“1.36M triangles 因 canonical < 64 MiB 而不切”，也
禁止把多个小 primitive 塞成一个同步 cook 长尾。

权威合同是 `docs/specs/web-geometry-product-work-budget-v1.md`。

---

# 10. 核心设计三：Spatial Sharding

## 10.1 Primitive 不能再等于最终 Product Unit

需要：

```text
Primitive
   ↓
SpatialShardPlan[]
```

建议：

```ts
interface GeometrySpatialShardPlan {
  shardId: bigint;
  sourcePrimitive: number;

  bounds: Aabb;

  estimatedSourceBytes: number;
  estimatedCanonicalBytes: number;
  estimatedCookBytes: number;

  triangleCount: number;
  neighbors: readonly bigint[];
}
```

---

## 10.2 V1 算法

优先采用：

```text
triangle centroid
→ Morton code
→ radix sort
→ bounded spatial groups
```

优点：

- deterministic；
- 易并行；
- locality 好；
- 易做 bounded shard；
- 相比 index-range split 更适合超大单 primitive。

第一版目标：

```text
256K – 2M source triangles / shard
```

最终由内存预算而不是固定 triangle 数决定。

---

## 10.3 V2 算法

进一步迁移到：

```text
LBVH / BVH-based partition
```

以：

```text
bounds
material
seam
canonical bytes
cook bytes
```

共同决定 shard。

---

# 11. Spatial Split 的 seam / attribute 规则

必须保留 Nyx simplification 的 attribute / seam correctness。

切 shard 时考虑：

- position boundary；
- normal seam；
- UV seam；
- tangent seam；
- material boundary；
- simplification lock；
- deterministic ownership。

推荐：

```text
Shard owns triangles.
Boundary vertices may duplicate.
```

禁止：

```text
cross-shard mutable vertex ownership
```

否则 Product 的独立生命周期会非常复杂。

---

# 12. 核心设计四：Multi-Product Runtime

最终 Scene：

```text
Scene
  │
  ├ ProductShard 0
  ├ ProductShard 1
  ├ ProductShard 2
  ├ ProductShard 3
  └ ...
```

Instance geometry identity 变成：

```text
(ProductTableSlot,
 ProductGeneration,
 AssetRecordIndex)
```

而不是只靠一个 Scene-local Product。

---

# 13. Product Table

新增 GPU Product Table：

```wgsl
struct GeometryProductTableEntry {
    generation: u32,
    hierarchy_base: u32,
    group_base: u32,
    page_table_base: u32,

    asset_base: u32,
    vertex_format_base: u32,
    flags: u32,
    reserved: u32,
};
```

实际布局需后续做 ABI 评审，但语义应保持：

```text
Product Table Entry
→ descriptor metadata ranges
→ page-location table
→ generation
```

---

# 14. PageID 必须继续 Product-local

禁止：

```text
GlobalPageID = concatenate(all products)
```

继续保持：

```text
(ProductTableSlot,
 ProductGeneration,
 PageID)
```

这对：

- replacement；
- stale generation；
- release；
- distributed Product；
- page cache key；

都更正确。

---

# 15. 核心设计五：Cook-and-Spill

这是 ADR-0018 最重要的改造。

当前：

```text
Cook
 ↓
SerializedGroupV3[]
 ↓
全部保留在 WASM
 ↓
page demand
 ↓
materialize page
```

目标：

```text
Cook bounded shard
 ↓
Freeze descriptor + activation cut
 ↓
Publish Product revision
 ↓
activate through existing onRevision lifecycle
 ↓
Pack / Compress / Spill remaining immutable pages
 ↓
release each completed Group/page payload
 ↓
next shard
```

Publication does not wait for `spillAllPages()`. Activation pages remain available
through the Product provider contract; after the generator resumes, remaining pages
spill in bounded order. Failure/cancellation must retain generation and atomicity
rules and may not publish an unreadable activation cut.

关键 invariant：

```text
completed shard payload
must not stay in WASM solely for future page read
```

---

# 16. Spill Store 抽象

建议：

```ts
interface GeometryCookSpillStore {
  putDescriptor(...): Promise<void>;

  putPage(
    productKey: ProductKey,
    pageId: number,
    bytes: ArrayBuffer
  ): Promise<void>;

  readPage(
    productKey: ProductKey,
    pageId: number
  ): Promise<ArrayBuffer>;

  releaseProduct(productKey: ProductKey): Promise<void>;
}
```

---

# 17. Spill Backend

## Backend A：Memory

用于：

- 小模型；
- test；
- benchmark；
- fallback。

---

## Backend B：OPFS

大模型 runtime cook 主推荐。

```text
Worker
 ↓
OPFS
 ↓
immutable compressed page artifacts
```

优势：

- 不占主线程 JS Heap；
- 大量 Page 可以落盘；
- content hash 可复用；
- 第二次加载可跳过大量 Cooker work。

---

## Backend C：Blob / File

用于本地用户拖入大型 GLB。

---

## Backend D：HTTP / CDN

服务器已有 Product 时：

```text
HTTP Range
→ page provider
```

完全跳过 runtime cook。

---

# 18. Page Artifact

推荐长期存储为：

```text
Page Artifact
  ├ version
  ├ ProductID / shard identity
  ├ PageID
  ├ codec
  ├ decoded identity hash
  ├ payload checksum
  └ compressed payload
```

优先：

```text
LZ4 / raw
```

继续参考 Nyx 的 page block 策略。

目标不是最大压缩率，而是：

```text
fast random page decode
```

---

# 19. 新 Runtime Cook Pipeline

```text
Catalog Ready
    │
    ▼
Camera / Scene Bounds
    │
    ▼
Priority Planner
    │
    ▼
Select visible/bootstrap shard
    │
    ▼
Fetch bounded ranges
    │
    ▼
Canonicalize shard
    │
    ▼
WASM Cook shard
    │
    ▼
Meshlet / Group / Simplify / BVH
    │
    ▼
Pack pages
    │
    ▼
Spill immutable artifacts
    │
    ▼
Release temporary memory
    │
    ▼
Publish ProductShard
    │
    ▼
Render
```

后台：

```text
next high-priority shard
next high-priority shard
...
```

---

# 20. Visible-First 重新定义

旧模型：

```text
bootstrap Product
  ↓
full Product revision
```

100M+ 新模型：

```text
visible Product Shards first
```

例如城市：

```text
camera
  ↓
near visible blocks
  ↓
first Product shards
  ↓
render immediately

background:
adjacent blocks
far blocks
hidden blocks
```

这比一个巨大 revision 0 / revision 1 更适合大场景。

---

# 21. Product Shard 生命周期

```text
Unseen
  ↓
Catalogued
  ↓
Queued
  ↓
Cooking
  ↓
Spilled
  ↓
DescriptorReady
  ↓
Published
  ↓
Active
  ↓
Dormant
  ↓
Released
```

Page 生命周期继续独立：

```text
Absent
 ↓
Demanded
 ↓
Reading
 ↓
Decoded
 ↓
UploadQueued
 ↓
Resident
 ↓
Retiring
 ↓
Absent
```

---

# 22. Shard Priority Scheduler

统一考虑：

```text
camera distance
projected screen area
frustum
predicted camera velocity
current view missing
shadow relevance
recent demand
activation importance
age
```

概念上：

```text
Priority =
    CurrentViewMissing * W0
  + ProjectedArea      * W1
  + DistanceScore      * W2
  + Predictive         * W3
  + Shadow             * W4
  + Age                * W5
```

不要求按这个精确线性公式实现，但禁止退回 FIFO。

---

# 23. GPU Physical Residency Profile

当前：

```text
4 × 128 MiB
= 512 MiB
```

保留为 Portable Profile。

新增：

```text
Portable
Balanced
HighEnd
```

示例目标：

```text
Portable   ≈ 512 MiB
Balanced   ≈ 768 MiB – 1 GiB
HighEnd    ≈ 1 – 2 GiB target
```

实际值必须依据：

```text
adapter.limits.maxBufferSize
adapter.limits.maxStorageBufferBindingSize
adapter.limits.maxStorageBuffersPerShaderStage
runtime evidence
```

动态选择。

不能根据物理显卡 VRAM 直接假设浏览器允许分配。

---

# 24. Hot / Warm / Cold 三层 Geometry Cache

目标：

```text
Hot
GPU physical pages
~512 MiB – adapter tier

Warm
OPFS / decoded CPU cache
数百 MiB – 数 GiB

Cold
GLB / HTTP / CDN
任意规模
```

这样才能把：

```text
100M / 500M logical geometry
```

和：

```text
GPU resident bytes
```

彻底解耦。

---

# 25. GPU Demand 系统重构

当前：

```text
missing page
→ 16 B demand record
→ readback
```

新方案：

```text
Hierarchy detects missing page
        ↓
Product-local GPU request bitset/hash
        ↓
priority accumulator
        ↓
GPU compact
        ↓
Top-N demand records
        ↓
bounded readback
```

---

# 26. Nyx Request Mask 的迁移方式

Nyx：

```text
1 bit / group
atomicOr
```

EEngine 推荐：

```text
Product-local 1 bit / PageID
```

再进行：

```text
bitset
 ↓
GPU compact
 ↓
priority GeometryPageDemandV1 records
```

这样同时保留：

Nyx 优点：

```text
天然去重
低写入成本
```

以及当前 EEngine 优点：

```text
ProductGeneration
priority
shadow
predictive
```

---

# 27. Dynamic Page Scheduler

当前偏保守：

```text
maxConcurrentReads = 2
maxInFlightBytes    = 4 MiB
```

100M+ 场景应改为自适应：

```text
network throughput
OPFS throughput
Worker throughput
GPU upload pressure
frame time pressure
camera cut state
```

共同决定：

```text
concurrent reads
in-flight bytes
upload bytes/frame
```

Camera cut 时允许临时 burst。

稳定视角时降低 streaming pressure。

---

# 28. Current-HZB Late Occlusion

不机械复制 Nyx 两遍完整 DAG traversal。

建议：

```text
Pass A
Previous-HZB hierarchy traversal
        ↓
Candidate Meshlet/Group
        ↓
Depth / Visibility
        ↓
Build Current HZB
        ↓
Late Candidate Recheck
        ↓
Final visibility work
```

重点：

```text
只 recheck uncertain / expensive candidates
```

适合 WebGPU。

---

# 29. WebGPU Mesh Shader 替代策略

WebGPU 当前无法直接获得 DX12 Mesh Shader 的执行模型。

所以目标不是 1:1 模拟 Mesh Shader。

优化：

```text
compute work generation
+
indirect raster
```

---

# 30. Meshlet Raster Bucket

当前 Virtual Product route：

```text
max 128 triangles
→ 384 vertices indirect draw
```

建议：

```text
Bucket 0 <= 32 triangles  → 96 vertices
Bucket 1 <= 64 triangles  → 192 vertices
Bucket 2 <= 96 triangles  → 288 vertices
Bucket 3 <= 128 triangles → 384 vertices
```

目标：

```text
减少无效 vertex shader invocation
```

这是 WebGPU 对 Nyx Mesh Shader 差距最现实的一项补偿。

---

# 31. Selective Primitive Culling

不要所有 meshlet 都做昂贵 triangle compute culling。

只对：

```text
large projected meshlet
high overdraw risk
uncertain HZB
large projected triangles
```

执行额外 primitive filtering。

这样避免 compute cost 本身超过收益。

---

# 32. Worker 架构

保留三个 profile：

## portable-single

```text
1 Dedicated Worker
1 single-thread WASM
```

## portable-pool

```text
N Dedicated Workers
single-thread WASM each
```

## isolated-pthreads

当：

```text
crossOriginIsolated
SharedArrayBuffer
```

可用时：

```text
Dedicated Worker
+
WASM pthread pool
```

---

# 33. 两级并行

100M+ 采用：

```text
Level 1
Shard parallelism

Level 2
Within shard
Nyx meshlet/group/simplify parallelism
```

新增：

```text
CookConcurrencyGovernor
```

避免：

```text
8 Workers × 8 pthreads = 64 execution threads
```

这种失控 oversubscription。

---

# 34. Budget 系统重构

将当前粗粒度 budget 拆成 owner budget：

```text
SourceWindowBudget
CanonicalBudget
WasmCookBudget
SerializedGroupBudget
SpillEncodeBudget
ProductMetadataBudget
CpuDecodedPageBudget
GpuResidencyBudget
TextureBudget
```

任何 owner 必须能回答：

```text
current bytes
peak bytes
limit bytes
owner count
```

---

# 35. 强制内存生命周期

每个 Shard：

```text
Fetch source range
     ↓
Canonicalize
     ↓
Cook
     ↓
Freeze descriptor / activation pages
     ↓
Publish Product revision
     ↓
Pack / Compress / Spill remaining pages
     ↓
Release:
  source buffer
  canonical buffer
  meshopt temporary arrays
  serialized group payloads
  temporary page buffers
  compression scratch
```

没有 evidence 证明 release 完成，不允许标记阶段完成。

---

# 36. 新 Observability

每个 Product/Shard 记录：

```text
sourceWindowBytes
canonicalBytes
productOrdinal
primitiveIdentity
spatialShardOrdinal / shardCount
triangleCount
vertexCount
domainCount
wasmCookPeakBytes
serializedGroupPeakBytes
spillPendingBytes
pageCacheBytes
descriptorBytes

catalogMs
rangeReadMs
canonicalizeMs
wasmPlanMs
meshletBuildMs
simplifyMs
hierarchyMs
pagePackMs
spillMs
publishMs

meshletCount
groupCount
pageCount
```

并持续暴露当前 `phase` 与 `phaseElapsedMs`。`units` 仅是 catalog primitive coverage，
不能替代 Product/shard/task phase evidence。

全局记录：

```text
activeProductShards
activeCookShards
GPU resident pages
GPU retiring pages
page demand attempted
page demand compacted
page demand overflow
camera-cut recovery time
TTFMF
```

---

# 37. 100M 的首要性能指标

## 37.1 TTFMF

```text
Time To First Meaningful Frame
```

优先目标：

```text
尽快看到正确 coarse world
```

不是等待 100M 全部 cook 完。

---

## 37.2 Working Set Stability

要求：

```text
Source Peak
Canonical Peak
WASM Peak
JS Heap Peak
GPU Geometry Peak
```

不能和总 triangle 数近似线性增长。

---

## 37.3 Camera Cut Recovery

测：

```text
camera cut
 ↓
ancestor fallback frame
 ↓
first page request
 ↓
first fine page resident
 ↓
50% target detail
 ↓
90% target detail
```

---

# 38. 正式 Workload

## K0 — Authored Large Cook Gate

使用真实 authored multi-primitive GLB 先验证生产链：

```text
Catalog
→ bounded source/canonical window
→ Product-per-shard cook-and-spill
→ Multi-Product GPU publication
→ page streaming / Current-HZB / scheduler
→ disposal
```

当前固定正式资产为 `large.glb`（477,591,060 bytes、4,871,612 triangles、1,041
nodes、1,920 primitives、最大 primitive 1,364,306 triangles）。K0 不做正式帧率
采样，只要求完整 cook、全 catalog coverage、task trace、owner/spill peak、settled 和
disposal。

K0 断言：

```text
union(every Product.sceneAssetIndices).size == 1,920
```

`ProductCount >= 1,920` 是错误条件，必须删除；实际 Product/shard count 单独记录。

## K1 — Authored Large Runtime Smoke

验证 production Multi-Product renderer、first frame、camera movement、page demand、
fallback 和 disposal，一次即可。K1 同时关闭 activation-first publication、自动
capacity 和真实 IO/decode/upload telemetry。

## K2 — Authored Large Formal PERF

只有 K0/K1 稳定后才执行 1080p、120 warmup、480 samples、3 independent runs、GPU
timestamp 和 P50/P95。它是当前 `virtual-assets.performance` 的正式 promotion gate。

## S1 — 100M Deferred Scale Gate

100M single-giant workload 保留为 `virtual-assets.scale-performance` 的后续目标，不再
作为 ADR-0018 当前完成的最低门槛，也不得在 authored K0 之前运行。

## S2 — 250M / 500M / 1B logical

只在 S1 后用于 working-set scalability 诊断。

---

# 39. Stress Generator 重构

当前约 8.4M 上限远远不够。

新增：

```bash
node tools/generate-vg-stress.mjs \
  --triangles 100000000 \
  --layout city
```

模式至少包括：

```text
single-giant-primitive
many-primitives
city-grid
dense-indoor
high-occlusion
camera-cut
high-instancing
```

其中最重要的是：

```text
single-giant-primitive
```

因为它能直接揭示是否仍然依赖 primitive 粒度。

---

# 40. Nyx Differential 继续作为硬门禁

任何 Sharding / Spill 改造不能破坏：

```text
Meshlet invariants
Group ownership
Refine relation
LOD error monotonicity
Bounds conservativeness
Hierarchy reachability
Material boundaries
Page independence
Determinism
```

新增 shard 后也必须验证：

```text
boundary seam correctness
independent shard determinism
stable Product/Page identity
```

---

# 41. 重新排序后的执行顺序

这是本 ADR 最重要的部分。

---

## Phase A — 100M Baseline & Failure Attribution

**Priority：P0 / 必须第一个做**

先生成 100M workload。

禁止先凭猜测大改。

记录当前系统到底死在：

```text
Catalog
Range Read
Canonical ArrayBuffer
WASM memory
Meshlet build
Simplification
retainedGroups
Descriptor
Admission
GPU metadata
GPU residency
```

### Exit Criteria

必须得到：

```text
100M failure owner + exact peak evidence
```

不能只记录：

```text
OOM
```

---

## Phase B — Canonical Windowing

**Priority：P0**

目标：

```text
remove Full Product canonical ArrayBuffer
```

实现：

```text
Catalog
→ bounded source range
→ bounded canonical shard
```

### Exit Criteria

100M：

```text
canonical peak <= configured budget
```

并且：

```text
100M > 250M 时
canonical peak 不同比例增长
```

---

## Phase C — Giant Primitive Spatial Sharding

**Priority：P0**

实现：

```text
Morton/BVH based triangle spatial partition
```

必须支持：

```text
1 primitive = 100M triangles
```

### Exit Criteria

```text
shard count > 1
max shard size bounded
bounds valid
seam valid
deterministic
```

---

## Phase D — Cook-and-Spill

**Priority：P0**

这是最关键的内存改造。

移除：

```text
full Product retainedGroups lifetime
```

改为：

```text
Cook shard
→ page
→ compress
→ spill
→ release
```

优先 OPFS。

### Exit Criteria

100M：

```text
WASM peak bounded
serialized group peak bounded
page re-read exact
hash stable
```

---

## Phase E — Multi-Product Runtime

**Priority：P0**

实现：

```text
ProductTable
multi Product Scene
per-instance Product identity
```

### Exit Criteria

同时 active：

```text
>= 64 Product shards
```

支持：

```text
independent load
independent replacement
independent eviction
independent release
stale-generation rejection
```

---

## Phase F — Visible-First Product Scheduler

**Priority：P0**

实现：

```text
visible/near shard first
```

做到：

```text
100M GLB
不需要全部 cook 完
即可开始 render
```

### Exit Criteria

```text
TTFMF << total cook completion time
```

---

## Phase G — GPU Demand Dedup / Compaction

**Priority：P1**

实现：

```text
Nyx-style Product-local request mask
+
priority record compaction
```

### Exit Criteria

Camera Cut：

```text
duplicate requests sharply reduced
readback bounded
overflow rare
```

---

## Phase H — Adaptive GPU Residency Profile

**Priority：P1**

实现：

```text
Portable
Balanced
HighEnd
```

同一个 Product ABI 可运行在：

```text
512 MiB
768 MiB
1 GiB+
```

无需重新 Cook。

---

## Phase I — Current-HZB Late Recheck

**Priority：P1**

目标：

```text
reduce false-positive visibility work
```

### Exit Criteria

Dense occlusion workload：

```text
selected meshlets ↓
raster vertices ↓
GPU visibility cost ↓
image parity unchanged
```

---

## Phase J — Dynamic Page Scheduler

**Priority：P1**

根据：

```text
camera state
IO throughput
GPU pressure
frame time
```

动态调节：

```text
read concurrency
in-flight bytes
upload budget
```

---

## Phase K0 — Authored Large Production Gate

**Priority：P0 / 当前机器的第一道浏览器门禁**

先运行固定 authored large cook case，记录：

```text
Product count
1,920 catalog primitive coverage
first Product / total cook
Product task identity and phase timing
source/canonical/WASM/JS/GPU owner peaks
session spill current/peak/limit
page demand/churn/overflow
GPU errors
complete disposal
```

K0 不要求 timestamp/warmup/多 run。没有完整 receipt 只能算调试日志。Product count
必须记录，但不能要求等于 primitive count。

---

## Phase K1 — Authored Runtime Smoke and Production Debt

**Priority：P1 / 扩大 workload 前的解释性门禁**

K1 关闭或量化当前代码已经暴露的规模债务：

```text
planner scratch / ordered materialization
giant-primitive rescan cost and cleanup
activation-first publication before full spill
incremental GpuRenderWorld publication
automatic Product slot + metadata capacity
source-read / decode / upload telemetry
session-local Product scheduler only after bounded work quantum
```

如果这些成本仍存在，必须在正式结果中单独计量，不能把它们混写成 WASM 或 GPU
性能结论。

---

## Phase K2 — Authored Large Formal PERF Freeze

**Priority：P1**

冻结：

```text
commit
browser
adapter
resolution
DPR
camera path
feature set
workload hash
```

采集：

```text
TTFMF
CPU P50/P95
GPU P50/P95
Source peak
WASM peak
JS peak
GPU geometry peak
page demand
page churn
camera-cut recovery
```

K2 使用 `web-authored-large-perf`，是当前正式性能声明的 promotion gate。

---

## Phase S1 — Deferred 100M Formal Scale Gate

K2 通过后才运行 `web-100m-formal-perf`。它保持 clean revision/browser/adapter/display/
camera/workload freeze，只能提升 `virtual-assets.scale-performance`。

---

## Phase L — Raster Bucket Optimization

**Priority：P2**

实现：

```text
32 / 64 / 96 / 128 triangle buckets
```

对比固定 384 route。

---

## Phase M — 250M / 500M / 1B Validation

**Priority：P2**

到这个阶段不再做大架构重写。

主要调：

```text
cache policy
thrash policy
scheduler
residency pressure
camera prediction
```

---

# 42. 最终优先级表

```text
P0-1  Authored test contract: catalog coverage, not Product count
P0-2  Product Task / Phase Trace
P0-3  128K triangle / 32 MiB / 512K vertex / 64-domain Work Planner
P0-4  Ordinary batching uses the same Work Planner
P0-5  1 GiB session spill budget separated from per-Product budget
P0-6  K0 Authored Large Cook Gate

P1-1  Activation-first publication before full spill
P1-2  K1 Authored runtime smoke and production debt
P1-3  Session-local Product scheduling, starting with 2 workers
P1-4  K2 Authored formal PERF
P1-5  S1 Deferred 100M formal scale gate

P2-1  32/64/96/128 Raster Buckets
P2-2  Selective Primitive Culling
P2-3  OPFS Persistent Product Cache
P2-4  Distributed CDN Product Cache
P2-5  250M / 500M / 1B Validation
```

---

# 43. 明确不要现在优先做的事情

不要优先：

```text
重写 Geometry Product ABI
重写 VirtualGeometryResidency
修改 256 KiB Page
重新实现 meshlet 算法
重新实现 simplify 算法
重新实现 BVH8
把 Offline Cooker 改为主路线
做 Virtual Texture
做 Skinned Virtual Geometry
继续堆更多高级后处理
```

这些都会偏离 100M 主目标。

---

# 44. Offline Cooker 同步改造

Offline 不是主路线，但它也必须解决超大资产峰值。

当前不应该继续：

```text
all decoded pages
+
all encoded pages
+
whole output file buffer
```

新 Writer：

```text
Cook
 ↓
Page
 ↓
Compress
 ↓
Stream Write
 ↓
Release
```

可以参考 Nyx：

```text
parallel conversion
+
temporary artifacts
+
final streamed package assembly
```

再次明确：

> Web Runtime Cooker 与 Native Offline Cooker 不需要共用实现代码。

只需要共同满足：

```text
Geometry Product / Page Contract
```

---

# 45. 100M 目标内存模型

第一版希望做到：

```text
Source GLB
2–10+ GiB

Main-thread geometry-related JS
尽量 < 200 MiB

Worker source windows
32–128 MiB

WASM live target
< 512 MiB
最好约 256 MiB 级

OPFS page cache
数 GiB 可接受

GPU geometry
512 MiB – adapter-selected profile
```

这些不是现在就宣称的保证值，而是 ADR-0018 benchmark 要验证和冻结的目标。

---

# 46. 极致性能硬规则

## Rule 1

```text
任何长期 resident CPU buffer
不能默认 ∝ total triangles
```

## Rule 2

```text
任何 main-thread operation
不能扫描全部 100M triangles
```

## Rule 3

```text
任何 Page miss
不能同步等待 GPU / CPU readback
```

## Rule 4

```text
任何 Worker session
不能长期拥有整场景 decoded geometry
```

## Rule 5

```text
任何 camera cut
先 fallback，再 refine
```

## Rule 6

```text
Logical Product identity
不能依赖 physical GPU slot
```

## Rule 7

```text
Any total-scene-scale allocation
must be explicitly justified as metadata,
not payload.
```

---

# 47. “超越 Nyx”应该如何定义

EEngine 很难在以下方面直接超过 Nyx：

```text
DX12 Mesh Shader raw efficiency
native IO freedom
DX12 bindless resource model
```

因此“超越 Nyx”不应该只看单项 GPU draw cost。

EEngine 可以在这些方向形成优势：

---

## 47.1 Runtime GLB Cook

Nyx 更偏：

```text
offline convert
```

EEngine 目标：

```text
load GLB
→ browser runtime cook
→ visible first
→ progressively refine
```

这是用户体验上的核心差异。

---

## 47.2 Distributed Product Runtime

统一：

```text
GLB
OEGPACK
Blob
HTTP Range
OPFS
runtime-generated Product
```

都进入同一个：

```text
Geometry Product Runtime
```

---

## 47.3 Browser Persistent Cook Cache

第一次：

```text
GLB
→ WASM Cook
→ OPFS Product pages
```

第二次：

```text
cache hit
→ descriptor restore
→ page streaming
→ skip most Cook
```

这可以形成明显的 Web-native 优势。

---

## 47.4 Multi-Product Hot Replacement

继续强化当前：

```text
generation-safe
transactional
submission-safe
```

替换机制。

大世界中可以做到单 shard 独立更新。

---

# 48. 最终架构链路

```text
                       100M+ GLB / glTF
                              │
                              ▼
                     Metadata-only Catalog
                              │
                              ▼
                    Spatial Shard Planner
                              │
             ┌────────────────┼────────────────┐
             │                │                │
         shard A          shard B          shard C
             │                │                │
             ▼                ▼                ▼
       bounded read      bounded read      bounded read
             │                │                │
             ▼                ▼                ▼
      canonical window canonical window canonical window
             │                │                │
             └──────── Worker / WASM Pool ─────┘
                              │
                              ▼
                Nyx-derived Geometry Cooker
                              │
                 Meshlet / Group / LOD / BVH
                              │
                              ▼
                     Product Shard Plan
                              │
                              ▼
                       Cook-and-Spill
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
           OPFS             Memory             CDN
            │
            └─────────────────┬─────────────────┘
                              ▼
                     Multi Product Table
                              │
                              ▼
                   Product Admission Runtime
                              │
                              ▼
                    Virtual Page Residency
                              │
                              ▼
                 Adapter-tier GPU Page Cache
                              │
                              ▼
          Previous HZB + Frustum + SSE + Hierarchy
                              │
                    ┌─────────┴─────────┐
                    │                   │
                 resident            missing
                    │                   │
                    ▼                   ▼
               meshlet work       demand bitset
                    │                   │
                    │              compact priority
                    │                   │
                    │                readback
                    │                   │
                    │               scheduler
                    │                   │
                    │               page source
                    │                   │
                    │                 upload
                    └──────────┬────────┘
                               ▼
                        Visibility Raster
                               │
                               ▼
                         Current HZB
                               │
                               ▼
                      Late Occlusion Recheck
                               │
                               ▼
                         VisibilityKey
                               │
                               ▼
                         Sparse Shading
```

---

# 49. ADR-0018 当前完成定义

只有同时满足以下条件才能称：

> **Web Authored Large Virtual Geometry Architecture Complete**

## Loading

- [ ] public `load_gltf()` 能稳定处理冻结的 `large.glb`；
- [ ] 不要求 offline preprocess；
- [ ] 不需要 full source buffer；
- [ ] 不需要 full canonical buffer；
- [ ] 不需要 full retainedGroups；
- [ ] visible ProductShard 能提前发布。
- [ ] 单 Product 同时满足 bytes/triangles/vertices/domains work budget；
- [ ] 每个 Product/shard 有结构化 task/phase trace。

## Memory

- [ ] JS heap peak bounded；
- [ ] WASM peak bounded；
- [ ] source-window peak bounded；
- [ ] CPU page cache bounded；
- [ ] session spill 与 per-Product decoded budget 分离且 bounded；
- [ ] GPU geometry cache bounded。

## Product

- [ ] Multi-Product Scene；
- [ ] Giant primitive spatial shard；
- [ ] per-product generation；
- [ ] independent replacement；
- [ ] independent release。

## Runtime

- [ ] ancestor fallback；
- [ ] demand dedup；
- [ ] bounded readback；
- [ ] asynchronous upload；
- [ ] eviction；
- [ ] adaptive SSE；
- [ ] camera-cut recovery。

## Evidence

- [ ] K0 authored-large cook receipt：全 1,920 primitive coverage、task trace、spill peak、settled/disposal；
- [ ] K1 authored runtime smoke 与 planner/publication/capacity/telemetry debt closure；
- [ ] K2 authored-large formal PERF；
- [ ] single giant primitive；
- [ ] city；
- [ ] dense occlusion；
- [ ] camera cut；
- [ ] high instancing。

100M、250M、500M 与 1B 是 ADR 当前完成后的 scale evidence，不属于 authored 目标的
完成清单。它们也不能用来掩盖 `large.glb` producer 仍然卡住的事实。

---

# 50. 最终路线结论

ADR-0016 / ADR-0017 已经基本解决：

```text
“虚拟几何 Runtime 是什么”
```

ADR-0018 当前必须解决：

```text
“如何让 Browser 稳定吃下真实 authored large geometry，并把每个 Cook unit 变成
确定、较小、可调度、可观察的 work quantum”
```

下一阶段的中心应该从：

```text
VirtualGeometryResidency
```

转向：

```text
Scalable Producer
+
Spatial Product Sharding
+
Cook-and-Spill
+
Multi-Product Runtime
+
GPU Demand Compression
+
WebGPU-specific Visibility Optimization
```

目标形态：

```text
Nyx Algorithm Core
        +
Web-native Runtime Cook
        +
Multi-Product World Streaming
        +
OPFS Persistent Geometry Cache
        +
Adaptive WebGPU Physical Residency
        +
WebGPU-specific HZB / Indirect Raster Optimization
```

最终 EEngine 不应该只是：

> Nyx 的 Web 翻译版。

而应该变成：

> **以 Nyx 几何算法为基线，先完成真实 4.87M authored scene，再以同一 bounded
> producer/runtime 架构推进 100M+ scale 的 Web-native Virtual Geometry Runtime。**
