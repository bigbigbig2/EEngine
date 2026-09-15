# ADR-0016-A — Nyx 源码移植 × EEngine Native Geometry Cooker 与 Runtime Geometry Page ABI

- **状态**：Design Freeze Candidate / 待实现
- **父 ADR**：`ADR-0016 — Nyx × WebGPU 2026 虚拟化资源加载与 GPU 驱动终极架构提案`
- **日期**：2026-09-15
- **目标引擎**：EEngine / OEngine WebGPU Advanced Renderer
- **设计目标**：极致加载性能、极致运行时性能、GPU-Driven、Virtualized Geometry、Demand-Driven Streaming
- **明确排除**：Cesium / 3D Tiles；Legacy Renderer；低端兼容渲染路径；生产运行时直接解析大型 GLB；一 Mesh 一文件的运行时资源组织
- **源码审计基线**：
  - EEngine：`bigbigbig2/EEngine@cec226e6feb825ce4d682f97b1d966c8e71d0c6a`
  - Nyx：`moonlovelj/Nyx@bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b`
- **WebGPU 规范基线**：W3C WebGPU Candidate Recommendation Draft，2026-08-20

---

## 0. 决策摘要

ADR-0016-A 决定把 EEngine 的几何资产体系从当前的“**完整 GeometryAssetPackage + section-based 大块上传**”重构为“**Nyx 风格的 Renderable LOD Group + 固定大小 Geometry Page + 常驻 Hierarchy Metadata + 独立压缩 Page Blob**”，并由一个 **Native C++ Asset Cooker** 负责生产运行时最终格式。

最终生产链路为：

```text
Authoring Source
GLB / glTF / FBX / USD ...
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│                 oengine-asset-cooker                      │
│                        C++                                │
│                                                           │
│ Import → Canonicalize → Dedup → Meshlet → LOD Group      │
│ → Nyx-style Refinement Graph → BVH8 Hierarchy            │
│ → Compact Vertex Pack → Geometry Page Pack → LZ4         │
│ → Hash / Validate → Scene + Geometry Pack                 │
└───────────────────────────────────────────────────────────┘
        │
        ├──────────────► scene.oescene
        │
        └──────────────► geometry-xxxxx.oegpack
                              │
                              ├─ resident metadata
                              ├─ hierarchy nodes
                              ├─ group directory
                              ├─ page directory
                              ├─ bootstrap/root page list
                              └─ independently compressed 256 KiB pages
```

生产 Runtime **不再把 GLB 当作 Runtime Asset Format**：

```text
禁止：
1 GB GLB
  → fetch whole file
  → arrayBuffer
  → parse
  → ImageBitmap / accessor conversion
  → SourceGeometry
  → runtime cook
  → upload

目标：
scene.oescene
  → geometry metadata range
  → root/bootstrap pages
  → FIRST MEANINGFUL FRAME
  → GPU feedback
  → demand pages
```

本 ADR 同时做出一个重要结构决策：**不把 EEngine 当前 `GeometryClusterRecord + Bvh8Nodes` 原样带入新 ABI**。Nyx 已经证明可以用紧凑的 `HierarchyNode` 作为 GPU traversal 的核心常驻结构，并让 leaf 指向可流送 `Group`。因此 V3 采用：

```text
Always Resident
    GeometryAssetRecord
    GeometryHierarchyNodeV3[]
    GeometryGroupDirectoryV3[]
    GeometryPageDirectoryV3[]

Streamed
    GeometryPage[PageID]
       └─ GroupPayload
            ├─ GroupHeader
            ├─ MeshletHeader[]
            ├─ local triangle indices
            └─ page-local packed vertices
```

**LOD refinement 的 DAG 关系沿用 Nyx 的核心方法：由 coarse meshlet 的 `RefineGroupId` 指向更细粒度 Group，而不是要求所有 refinement 数据常驻。**

---

# 1. ADR-0016-A 在整个 ADR-0016 中的位置

四篇子 ADR 的职责边界固定为：

```text
ADR-0016
  │
  ▼
ADR-0016-A  ← 当前文档
Native Cooker + Runtime Geometry Asset/Page ABI
  │
  ├─────────────────────┐
  ▼                     ▼
ADR-0016-B              ADR-0016-D
Geometry Streaming      Texture Asset / Streaming
Residency / Feedback
  │
  ▼
ADR-0016-C
WebGPU GPU-Driven Execution
Nyx DispatchMesh → Compute + Indirect + Vertex Pulling
```

A 是后续 B/C 的“数据合同”。B 不允许自己定义另一套 Page，C 不允许自己定义另一套 Meshlet/Hierarchy ABI。

因此实际重构顺序总体上可以按：

```text
A → B → C → D
```

但实现阶段建议使用 **B/C 垂直切片**：先实现最小 B（root page residency）→ 最小 C（读取 resident group 并渲染）→ 再补全 B demand streaming → 再补全 C 完整 DAG traversal。原因是 Streaming 的 ABI 只有被真正 GPU 渲染消费以后才能证明设计正确。

换言之：**ADR 的设计顺序是严格 A→B→C→D；代码提交可以在 B/C 之间短周期交替，但不能绕过 A。**

---

# 2. 源码审计范围

本设计不是从概念图凭空设计，而是以两个仓库当前实现为基线。

## 2.1 EEngine 关键源码

| Ref | 文件 | 本 ADR 关注点 |
|---|---|---|
| E1 | `OEngine/src/assets/RuntimeAssetPackage.ts` | 当前 Runtime Asset Envelope、section directory、SHA-256、whole-buffer open/write |
| E2 | `OEngine/src/assets/RuntimeAssetManifestV2.ts` | chunk byte range、variant、feature/limit contract、checksum |
| E3 | `OEngine/src/assets/RuntimeAssetResidency.ts` | `unrequested/requested/resident/retiring` 状态与 budget seam |
| E4 | `OEngine/src/assets/GeometryAssetPackage.ts` | 当前 Geometry V2 sections、Meshlet/Cluster/BVH8 ABI |
| E5 | `OEngine/src/assets/GeometryCookRecipe.ts` | deterministic recipe、meshoptimizer pin、64/128 meshlet、BVH8、compact vertex profile |
| E6 | `OEngine/src/geometry/GeometryCooker.ts` | meshoptimizer JS cooker、Renderable hierarchy、BVH8、compact payload、当前 compression=`none` |
| E7 | `OEngine/src/geometry/GeometryHierarchy.ts` | CPU oracle、SSE traversal、queue capacity fallback、multi-instance hierarchy semantics |
| E8 | `OEngine/src/assets/SourceGeometry.ts` | immutable canonical cooker input、全量 copy/validation/bounds scan |
| E9 | `OEngine/src/loaders/gltf/GltfLoader.ts` | raw GLB whole-file fetch/slice/ImageBitmap barrier |
| E10 | `OEngine/src/loaders/load_gltf.ts` | Packed glTF import、mesh instance reuse、primitive merge、SourceGeometry 构建 |
| E11 | `OEngine/tools/cook-packed-gltf-geometries.mjs` | 当前离线工具仍逐 geometry 输出 `.oeg` 文件 |
| E12 | `OEngine/src/assets/codec/AssetWorkerPool.ts` | 已有 priority/memory/cancel Worker 基础设施 |
| E13 | `OEngine/src/assets/codec/TextureCodecPolicy.ts` | 与 D 共享的 capability-driven asset policy 思路 |

## 2.2 Nyx 关键源码

| Ref | 文件 | 本 ADR 关注点 |
|---|---|---|
| N1 | `MiniEngine/Model/MeshletStructs.h` | `HierarchyNode`、`GroupHeader`、`MeshletHeader`、`GroupDataLocation`、Page metadata |
| N2 | `MiniEngine/Model/MeshletBuilder.cpp` | iterative group simplification、attribute seam locks、refine group、LOD BVH build |
| N3 | `MiniEngine/Model/ModelConvert.cpp` | parallel mesh build、group→page packing、256 KiB page、parallel LZ4 compression |
| N4 | `MiniEngine/Model/ModelLoader.h` | `.mini` FileHeader、page/group/hierarchy counts、256 KiB Page / 256 MiB Chunk constants |
| N5 | `MiniEngine/Model/GeometryStreaming.cpp` | PageResidency、PhysicalSlot、root page pinning、async IO、LZ4 decode、address table |
| N6 | `MiniEngine/Model/Shaders/DAGCull.slang` | DAG/BVH traversal、GPU request mask、resident check、GroupDataLocation、RefineGroupIndex |
| N7 | `README.md` | 256 KiB Page、GPU request mask readback、async page load、LZ4、stress-scene architecture |

---

# 3. 两个仓库当前实现的核心差异

## 3.1 EEngine 当前 Geometry V2 的优势

EEngine 当前 `GeometryAssetPackage.ts` 已经比普通 Web GLTF loader 高级很多。它有明确的版本化 ABI：

```text
GeometryDirectory
VertexStreamDescriptors
VertexStreamData
IndexData
MeshletRecords
MeshletVertexIndices
MeshletTriangleIndices
ClusterRecords
ClusterChildren
Bvh8Nodes
MaterialRanges
```

并且已经具备：

- `GEOMETRY_DIRECTORY_RECORD_STRIDE = 192`
- `GEOMETRY_MESHLET_RECORD_STRIDE = 112`
- `GEOMETRY_CLUSTER_RECORD_STRIDE = 128`
- `GEOMETRY_BVH8_NODE_STRIDE = 352`
- source hash / recipe hash
- material/alpha/double-sided 元数据
- compact/static-PBR vertex profile
- meshlet bounds/cone
- renderable hierarchy
- BVH8
- deterministic recipe

这意味着 **EEngine 不需要从 0 构建 Cooker 语义**。

当前 `GeometryCookRecipe.ts` 还明确固定了：

```text
meshlet default        = 64 vertices / 128 triangles
simplification target  = 0.5
hierarchy fanout       = 8
BVH branching          = 8
position               = unorm16x3-aabb
position quantization  = 16 bit
```

并 pin 住 meshoptimizer commit，使输出可复现。

这些都是新 Native Cooker 应继承的资产工程能力。

---

## 3.2 EEngine 当前 Geometry V2 的根本限制

### 限制 A：Package 是“完整资产”，不是“可缺页资产”

`RuntimeAssetPackage.ts` 的 API 是：

```text
openRuntimeAssetPackage(bytes: ArrayBuffer)
writeRuntimeAssetPackage(...) -> ArrayBuffer
```

它的基本假设是**完整 package 已在内存中**。

`RuntimeAssetManifestV2` 虽然已经有：

```text
chunk.byteOffset
chunk.compressedBytes
chunk.decodedBytes
chunk.expectedResidentBytes
```

但现有 `openRuntimeAssetPackageV2(bytes)` 仍然读取并验证整个 ArrayBuffer，而不是一个只读取 metadata + 任意 page range 的 streaming reader。

因此 V2 的“chunk byte range”是一个很好的设计胚胎，却还没有真正变成网络/磁盘随机访问协议。

### 限制 B：Geometry Cooker 输出 section，当前 section compression 仍为 `none`

当前 `GeometryCooker.ts` 最终把每个 section 写成：

```text
compression: "none"
```

这与网络运行时大场景的需求不匹配。

### 限制 C：全局 vertex/index payload 破坏真正 Virtual Geometry 的独立 page 性

当前 Geometry V2 同时保存：

```text
全局 VertexStreamData
全局 IndexData
MeshletVertexIndices
MeshletTriangleIndices
```

这种结构适合“整个 geometry asset 已 resident”的 GPU-driven renderer。

但真正 demand-driven geometry streaming 要求：

> 一个 page 到达 GPU 后，应能独立完成该 page 中 meshlet 的 raster，而不能再依赖一个必须完整常驻的全局 source vertex buffer。

因此 V3 必须改变 vertex ownership。

### 限制 D：Cluster + BVH8 metadata 对极大规模场景偏重

当前单个：

```text
ClusterRecord = 128 B
BVH8Node      = 352 B
```

而 Nyx 的 hierarchy node 只围绕 culling 必需字段组织：sphere/AABB/error + 一个 packed control word。

当 geometry metadata 达到几十万/数百万节点时，Metadata bandwidth 本身就是 GPU culling 成本的一部分。

### 限制 E：当前离线工具是一 geometry 一 `.oeg`

`cook-packed-gltf-geometries.mjs` 当前按：

```text
geometry-00000.oeg
geometry-00001.oeg
...
manifest.json
```

输出。

对于 Bistro 这种上千 geometry 的场景，这会把资源系统推向大量请求、逐对象 open/validate、无法按视图聚合 Range 的方向。

V3 不继续这条路线。

---

# 4. Nyx 源码中要“真正移植”的东西

## 4.1 Nyx 不是单纯 Meshlet Renderer

Nyx 的 geometry subsystem 是完整的：

```text
source mesh
    ↓
meshlets
    ↓
meshlet groups
    ↓
iterative simplify
    ↓
coarser meshlets
    ↓
RefineGroup relation
    ↓
per-LOD spatial hierarchy
    ↓
top-level hierarchy
    ↓
group serialization
    ↓
fixed-size page packing
    ↓
page LZ4
    ↓
GPU feedback streaming
```

这就是 EEngine ADR-0016 要移植的主要算法骨架。

---

## 4.2 Nyx 的关键 Disk/GPU 分层

Nyx 把 metadata 与 heavy geometry 分开：

```text
Always Resident Metadata
├─ HierarchyNode[]
├─ GroupMetadata[]
├─ PageMetadata[]
└─ PageCompressionInfo[]

Streamed Geometry
└─ Page
    └─ Group Blob
        ├─ GroupHeader
        ├─ MeshletHeader[]
        ├─ local triangle indices
        └─ page-local vertices
```

这和 EEngine V3 的目标完全一致。

---

## 4.3 Nyx `HierarchyNode` 为什么值得替换 EEngine 当前 Cluster+BVH 双结构

Nyx 的 `HierarchyNode` 包含：

```text
BoundSphere
BBoxMin
BBoxMax
MaxParrentError
packed node data
```

Internal node：

```text
ChildStartIndex
ChildCount <= 8
```

Leaf：

```text
GroupIndex
MeshletCount
```

GPU `DAGCull.slang` 直接遍历它：

```text
HierarchyNode
   ↓
visibility / HZB
   ↓
LOD Test(MaxParentError)
   ↓
Internal ? enqueue children
   :
   Group leaf
```

它已经把：

```text
空间层级 + LOD error + group locator
```

统一成 GPU culling 的最小工作集。

因此 V3 不继续保留“一个大型 GeometryClusterRecord 再额外配一套 352B BVH8 Node”的默认布局。

---

## 4.4 Nyx 的 RefineGroup 是必须保留的核心语义

Nyx coarse meshlet 中存在：

```text
RefineGroupIndex
```

`DAGCull.slang` 中，一个 coarse meshlet 可见以后会检查：

```text
refine group resident ?
   │
   ├─ NO  → coarse meshlet 可以继续画
   │
   └─ YES → 读取 refine group 的 error/bounds
             判断 finer representation 是否应取代 coarse meshlet
```

这提供了非常重要的性质：

> **缺页不会导致 geometry hole。**

高级 LOD 未 resident 时，resident ancestor/coarse meshlet 仍然是合法表示。

这比传统：

```text
LOD0 file / LOD1 file / LOD2 file
```

更适合真正 virtualized geometry。

EEngine V3 将保留该关系，但会重新定义成稳定、WebGPU-friendly 的显式 u32 ABI，而不直接复制 C++ bitfield 内存布局。

---

## 4.5 Nyx 256 KiB Page 的价值

Nyx 当前：

```text
Page  = 256 KiB
Chunk = 256 MiB
```

每个 Group 不跨 Page，Page 独立 LZ4 压缩。

Runtime 可以：

```text
PageID
 → fileOffset/compressedSize
 → async IO
 → LZ4 decode exactly 256 KiB
 → upload one fixed physical slot
```

这个固定大小“解压后 Page”非常适合 EEngine WebGPU 的 GPU buffer pool。

但 **Nyx 的 256 MiB GPU Chunk 不原样移植**，原因见第 15 节。

---

# 5. 最终融合原则

本 ADR 采用如下组合，而不是照抄任一仓库：

| 领域 | 保留/采用 |
|---|---|
| Source canonicalization | EEngine 当前 `SourceGeometry` 语义，迁入 C++ |
| glTF mesh instance reuse | EEngine `buildPackedGltfSource` 语义 |
| Meshlet 生成 | EEngine + Nyx 都依赖 meshoptimizer，Native 使用 C++ meshoptimizer |
| LOD Group iterative simplify | 以 Nyx 实现为主要移植源 |
| Attribute seam protection | 移植 Nyx position-remap / attribute-difference lock 思路 |
| Refinement relation | 采用 Nyx `RefineGroupIndex` |
| Hierarchy | Nyx-style compact 8-way hierarchy；废弃 V3 默认 Cluster+BVH 双份 metadata |
| Vertex compression | 保留 EEngine compact profile 思路，并改成 page-local/meshlet-local decode domain |
| Page size | 256 KiB decoded fixed page |
| Page compression | Nyx-style independent page compression，V3 初始实现 LZ4/raw |
| Runtime manifest concepts | 保留 EEngine hash/version/recipe/feature contract 思想，但升级为 range-readable binary V3 |
| Residency state | 保留 EEngine request/resident/retiring 状态思想，具体 Streaming 放到 B |
| Runtime raw GLB | 移出 production hot path |
| Offline implementation | C++ Native Cooker 为唯一生产权威实现 |

---

# 6. 不可妥协的设计原则

### 6.1 Authoring Format ≠ Runtime Format

GLB/glTF 是输入，不是生产 Runtime 协议。

### 6.2 Metadata 必须能在不读取 geometry pages 的情况下完成初始化

Runtime 读取 metadata 后必须已经知道：

```text
资产 bounds
Hierarchy roots
所有 hierarchy nodes
Group → Page 映射
Page → 文件 byte range 映射
Root/bootstrap pages
Codec
Hashes
```

### 6.3 任意 Streamable Page 必须独立解码

禁止：

```text
Page 102 解压依赖 Page 101 的字典/前缀状态
```

### 6.4 任意 resident Group 必须可独立 raster

禁止：

```text
Group page 已 resident
但还需要一个未 resident 的 global vertex buffer
```

### 6.5 Root representation 永远可用

只要资产进入“可渲染”状态，至少存在一个 coarse resident cut。

### 6.6 Runtime 不做资产结构性 Cook

Runtime 允许：

```text
range fetch
LZ4 decode
hash/cache
GPU upload
page-table update
```

Runtime 不允许：

```text
重新建 meshlet
重新 simplify
重新建 hierarchy
重新 merge mesh
重新算完整 LOD
```

### 6.7 ABI 优先于实现语言

Native C++ Cooker、WASM 工具版和 WebGPU Runtime 都围绕相同二进制 ABI。

---

# 7. 术语

| 术语 | 定义 |
|---|---|
| Asset | 一份可实例化的逻辑 geometry |
| Meshlet | 小型三角形集合，使用 page-local vertex data |
| Group | 同一 LOD 上的一组 meshlets，是 streaming/renderable 的核心逻辑单位 |
| RefineGroup | coarse meshlet 对应的 finer group |
| HierarchyNode | 常驻 GPU 的 BVH/LOD traversal node |
| Logical Page | Cooker 输出的 256 KiB 解码后页 |
| Physical Slot | GPU Geometry Bank 中的一个 256 KiB 槽 |
| Pack | 一个可 Range Fetch 的 `.oegpack` 文件 |
| Bootstrap Page | First Meaningful Frame 前要求 resident 的 coarse/root page |
| AssetID | geometry 内容+recipe 的稳定内容 ID |
| PackID | pack 元数据和 page identity 的内容 ID |

---

# 8. Production 文件体系

V3 生产格式只要求：

```text
scene.oescene
geometry-<hash>-000.oegpack
geometry-<hash>-001.oegpack
...
```

Texture 在 ADR-0016-D 中定义：

```text
texture-*.oetpack
```

不再生产：

```text
geometry-00000.oeg
geometry-00001.oeg
...
```

作为最终 Runtime 组织。

---

# 9. `scene.oescene` 的职责边界

A 只冻结 geometry 所需字段，Material/Texture 完整字段由 D 扩展。

Scene Manifest 至少保存：

```text
SceneHeader
PackReference[]
GeometryAssetReference[]
InstanceRecord[]
RootNodeIndex[]
BootstrapPageReference[]
```

逻辑关系：

```text
InstanceRecord
  ├─ transform
  ├─ GeometryAssetID
  ├─ material binding table id
  └─ flags

GeometryAssetReference
  ├─ GeometryAssetID
  ├─ PackID
  └─ AssetRecordIndex
```

### 9.1 不把每个 Page 写进 JSON

Page 数量可能非常大。

因此：

```text
scene.oescene
```

只保存 Pack/Asset 级索引；具体 Page Directory 是 `.oegpack` 的 binary resident metadata。

---

# 10. `.oegpack` 的总体布局

推荐物理布局：

```text
0
┌─────────────────────────────────────────┐
│ OegPackHeaderV3                         │ fixed 256 B
├─────────────────────────────────────────┤
│ AssetDirectory[]                        │ resident
├─────────────────────────────────────────┤
│ RootNodeIndex[]                         │ resident
├─────────────────────────────────────────┤
│ HierarchyNodeV3[]                       │ resident
├─────────────────────────────────────────┤
│ GroupDirectoryV3[]                      │ resident
├─────────────────────────────────────────┤
│ PageDirectoryV3[]                       │ resident CPU
├─────────────────────────────────────────┤
│ BootstrapPageId[]                       │ resident CPU
├─────────────────────────────────────────┤
│ VertexFormatRecord[]                    │ resident CPU/GPU
├─────────────────────────────────────────┤
│ optional debug/string tables            │ dev build only
├──────────── metadataEnd ─────────────────┤
│ Compressed Page 0                       │ Range-fetchable
├─────────────────────────────────────────┤
│ Compressed Page 1                       │
├─────────────────────────────────────────┤
│ ...                                     │
└─────────────────────────────────────────┘
```

所有 page payload 按 **compressed byte offset** 独立寻址。

Metadata 强制放在文件前部，目的是：

```text
1 request / 1 small Range
→ 完成整个 geometry streaming 系统初始化
```

---

# 11. `OegPackHeaderV3`

建议冻结为 256 bytes，little-endian。

```cpp
struct OegPackHeaderV3 {
    char     magic[8];              // "OEGPACK\0"
    uint32_t formatMajor;           // 3
    uint32_t formatMinor;           // 0
    uint32_t endianMarker;          // 0x01020304
    uint32_t headerBytes;           // 256

    uint32_t pageShift;             // 18 => 256 KiB
    uint32_t pageBytes;             // 262144
    uint32_t flags;
    uint32_t defaultCodec;

    uint32_t assetCount;
    uint32_t rootNodeIndexCount;
    uint32_t hierarchyNodeCount;
    uint32_t groupCount;
    uint32_t pageCount;
    uint32_t vertexFormatCount;
    uint32_t bootstrapPageCount;
    uint32_t reserved0;

    uint64_t assetDirectoryOffset;
    uint64_t rootNodeIndexOffset;
    uint64_t hierarchyOffset;
    uint64_t groupDirectoryOffset;
    uint64_t pageDirectoryOffset;
    uint64_t vertexFormatOffset;
    uint64_t bootstrapPageOffset;
    uint64_t pageBlobOffset;
    uint64_t fileBytes;

    uint8_t  recipeHash[32];
    uint8_t  packContentHash[32];

    uint8_t  reserved[...];
};
```

### 11.1 为什么 Header 固定 256 B

不是因为 WebGPU 要求，而是为了：

- cache line / storage alignment 友好；
- 未来增加 section offset 不破坏初始读取流程；
- Header 可一次 Range 读取；
- 避免可变 header 解析复杂度。

### 11.2 `pageShift = 18` 在 V3 固定

V3 的 canonical production profile：

```text
1 << 18 = 262144 B = 256 KiB
```

Header 仍写出字段是为了验证，而不是允许任意 page size。

若未来改变 page size，应升级 ABI minor/major，而不是每个包随意选择。

---

# 12. `GeometryAssetRecordV3`

一个 `.oegpack` 可以容纳很多唯一 geometry asset，避免“一 mesh 一文件”。

推荐 128 B：

```cpp
struct GeometryAssetRecordV3 {
    uint8_t  assetId[32];

    float    boundsSphere[4];
    float    boundsMin[3];
    float    boundsMax[3];

    uint32_t rootNodeBegin;
    uint32_t rootNodeCount;

    uint32_t hierarchyBegin;
    uint32_t hierarchyCount;

    uint32_t groupBegin;
    uint32_t groupCount;

    uint32_t bootstrapPageBegin;
    uint32_t bootstrapPageCount;

    uint32_t sourceTriangleCount;
    uint32_t leafMeshletCount;
    uint32_t totalMeshletCount;
    uint32_t flags;

    uint32_t reserved[...];
};
```

### 12.1 支持多个 Root

一个 glTF mesh 可能有多个 material-compatible primitive。

V3 不要求把不同 material/alpha pipeline 强行混进同一个 Group DAG。

因此：

```text
Asset
├─ Root 0: opaque material domain
├─ Root 1: alpha-mask domain
└─ Root 2: other primitive domain
```

Scene Instance 仍然只引用一个 AssetID。

---

# 13. `GeometryHierarchyNodeV3`：替换当前 Cluster + BVH 双份核心 metadata

目标 record：**48 B**。

```text
offset  size   field
0       16     boundsSphere : float4
16      12     bboxMin      : float3
28      12     bboxMax      : float3
40       4     maxParentError : float
44       4     packedNodeData : u32
-------------------------------
48 B
```

WebGPU shader 不使用 WGSL native struct padding直接解释它，而是从 `array<u32>` / raw storage words 解码，确保 C++、TypeScript、WGSL 完全相同的物理 ABI。

## 13.1 Internal Node packed layout

```text
bit 0        = 0 (internal)
bits 1..27   = ChildStartIndex
bits 28..31  = ChildCount (1..8)
```

这基本沿用 Nyx 的已验证布局。

## 13.2 Group Leaf packed layout

```text
bit 0        = 1 (group leaf)
bits 1..24   = GroupIndex local-to-pack/asset mapping
bits 25..31  = MeshletCountMinusOne
```

第一版建议保持 Nyx 的 24-bit group index + 7-bit meshlet count 语义，因为：

```text
2^24 groups = 16,777,216 groups / pack
```

已经远高于单个 Web 场景实际可同时有效 residency 的数量。

如未来突破该规模，优先做 pack sharding，而不是让 GPU node record 变胖。

## 13.3 为什么不继续 352 B BVH8Node

V3 的目标不是“保留当前所有结构，再加 Page”。

GPU hierarchy hot-path 的每个 node 越大：

```text
cache traffic ↑
L2 pressure ↑
traversal bandwidth ↑
```

Nyx 已证明 8-way traversal 可以用一个紧凑 node 表达。

因此 V3 将 EEngine 当前 `ClusterRecords + ClusterChildren + Bvh8Nodes` 的默认 Runtime 表达收敛成一个 compact hierarchy。

EEngine 当前 `GeometryHierarchy.ts` 的 SSE、capacity fallback 和 validation 语义继续保留为 CPU oracle，但物理记录切换到 V3。

---

# 14. `GeometryGroupDirectoryV3`

Group heavy data 不常驻，但 CPU/GPU 要知道 Group 在哪个 logical page。

采用紧凑 16 B：

```cpp
struct GeometryGroupDirectoryV3 {
    uint32_t pageId;
    uint32_t offsetInDecodedPage;
    uint32_t payloadBytes;
    uint32_t flags;
};
```

其中：

```text
pageId                 logical PageID
offsetInDecodedPage    [0, 262144)
payloadBytes           complete GroupPayload bytes
flags                   root/bootstrap/material-domain/debug bits
```

### 14.1 Group 不跨 Page

强制 invariant：

```text
offset + payloadBytes <= 256 KiB
```

如果一个 Group 超过 Page：

> Cooker 必须在 build 阶段拆成多个同 LOD sibling Group。

Runtime 不允许 multi-page Group。

---

# 15. `GeometryPageDirectoryV3`

Page Directory 主要由 CPU streaming scheduler 使用。

推荐 64 B：

```cpp
struct GeometryPageDirectoryV3 {
    uint64_t compressedFileOffset;
    uint32_t compressedBytes;
    uint32_t decodedBytes;          // must == 262144

    uint32_t firstGroup;
    uint32_t groupCount;
    uint32_t codec;
    uint32_t flags;

    uint8_t  decodedContentHash128[16];
    uint32_t compressedChecksum;
    uint32_t reserved0;

    uint64_t reserved1;
};
```

### 15.1 Codec enum

V3 初始运行时只实现：

```text
0 = Raw256K
1 = LZ4Block
```

预留：

```text
2 = MeshoptPage
3 = GPUDecodeExperimental
```

“预留”不意味着现在要写兼容路径；它只避免未来修改 Page Directory ABI。

### 15.2 Cooker 自动选择 Raw 或 LZ4

如果某页 LZ4 后收益太小，Cooker 可以标记 Raw：

```text
compressedBytes >= decodedBytes - threshold
→ Raw256K
```

这是**同一 V3 Page 系统的编码策略**，不是 Legacy fallback。

---

# 16. WebGPU Physical Geometry Bank 的约束

2026 WebGPU full-mode 默认最低保证：

```text
maxStorageBufferBindingSize = 128 MiB
maxBufferSize               = 256 MiB
minStorageBufferOffsetAlignment = 256 B
```

因此不原样复制 Nyx 的：

```text
256 MiB Geometry Chunk
```

作为一个 storage-buffer binding。

EEngine V3 采用：

```text
Physical Geometry Bank = 128 MiB
Geometry Page           = 256 KiB
Slots per Bank          = 512
```

数学关系非常干净：

```text
128 MiB / 256 KiB = 512
```

Runtime B 中可以表示：

```text
PhysicalPageAddress
├─ bankIndex
└─ slotIndex 0..511
```

Group 真实 byte address：

```text
bankBase
+ slotIndex * 262144
+ group.offsetInDecodedPage
```

### 16.1 Disk Pack 与 GPU Bank 完全分离

不要混淆：

```text
.oegpack 可以 2 GB、10 GB
```

和：

```text
单个 WebGPU storage binding <= selected device limit
```

Pack 是 IO container，Bank 是 GPU physical residency resource。

---

# 17. Decoded Geometry Page 的 GPU 内存布局

V3 Page **解压后固定 262144 B**。

Page 本身不放独立 PageHeader，避免每个 physical slot 浪费 GPU bytes。

结构：

```text
Page start
│
├─ GroupPayload A  (16-byte aligned)
│   ├─ GroupHeaderV3
│   ├─ MeshletHeaderV3[]
│   ├─ Triangle Local Index Stream
│   └─ Packed Vertex Stream
│
├─ GroupPayload B
│   └─ ...
│
├─ ...
│
└─ zero padding to 256 KiB
```

Page metadata 已经存在 `PageDirectory`，GPU 不需要重复 header。

---

# 18. `GroupHeaderV3`

建议固定 64 B：

```text
offset  size
0       16    BoundSphere float4
16      12    BBoxMin float3
28      12    BBoxMax float3
40       4    ParentError float
44       2    MeshletCount u16
46       1    LodLevel u8
47       1    VertexFormatId u8
48       4    MeshletHeaderOffset
52       4    TriangleDataOffset
56       4    VertexDataOffset
60       4    PayloadBytes
-----------------------------
64 B
```

### 18.1 `ParentError`

沿用 Nyx 语义，不简单保存“本层误差”，而是保存保证 LOD cut 单调性的 propagated error。

### 18.2 `VertexFormatId`

避免每个 meshlet 重复完整 vertex stream descriptor。

Pack 常驻一个小型：

```text
VertexFormatRecord[]
```

Group 只用 8-bit FormatID。

---

# 19. `MeshletHeaderV3`

建议 48 B：

```text
offset  size
0        2   vertexCount
2        2   triangleCount
4        4   vertexByteOffset      // relative to Group start
8        4   triangleByteOffset    // relative to Group start
12       4   refineGroupId         // 0xffffffff = no finer group
16       4   materialId
20       4   flags
24      12   bboxMin
36      12   bboxMax
-------------------------------
48 B
```

`flags` 包含：

```text
opaque / mask / blend classification
front-face/two-sided
cone valid (若后续增加 compact cone table)
shadow policy bits
reserved
```

### 19.1 为什么不把 global vertex index 放进 MeshletHeader

因为 V3 Page 是自包含 Virtual Geometry Page。

Meshlet vertex stream 是 page-local packed bytes。

### 19.2 `refineGroupId` 是核心，不是 debug 字段

ADR-0016-B/C 将用它完成：

```text
coarse visible meshlet
  ↓
refine group resident?
  ↓
refine error test
  ↓
coarse stays / finer replaces
```

---

# 20. Triangle Index 与 Vertex Ownership

这是 V2 → V3 最大的物理布局变化之一。

## 20.1 Nyx 做法

每个 Meshlet Group Blob 内直接复制该 meshlet 使用的 vertex bytes，并保存 local triangle indices。

优点：

```text
page arrives
→ everything needed for raster is here
```

## 20.2 EEngine V2 做法

当前存在全局 packed vertex stream，再由 meshlet vertex indices 间接索引。

优点是减少 vertex duplication，但缺点是：

```text
只流送一个 meshlet page
≠
该 meshlet 可独立 raster
```

## 20.3 V3 决策

采用 Nyx 的 ownership 原则：

> **Meshlet raster vertices 存在 Group/Page 内。**

Triangle stream 使用 local indices。

V3 约束 meshlet vertex count `<= 128`，所以 triangle local indices 可以使用 `u8`。

该设计允许：

```text
page → GPU physical slot
```

之后直接 Vertex Pulling，不需要重建任何 index/vertex buffer。

---

# 21. Vertex Format V3

不直接复制 Nyx 的 DXGI specific layout，也不原样保留 EEngine 当前 source-AABB position decoding。

## 21.1 Position：meshlet-local 16-bit quantization

当前 EEngine compact profile：

```text
unorm16x3 relative to source bounds
```

对超大 asset 来说，asset AABB 越大，16-bit position precision 越差。

V3 因为每个 meshlet vertex 已经独立，所以直接：

```text
position_u16 = quantize(position, meshletBBox)
```

MeshletHeader 已保存 bbox，因此 shader 可：

```text
position = bboxMin + unorm16 * (bboxMax - bboxMin)
```

优势：

- 巨型世界/建筑仍保持高局部精度；
- 不需要全局 position decode table；
- Group/Page 完全自描述。

## 21.2 Normal / Tangent / UV

继续继承 EEngine compact profile 的原则：

```text
normal   → oct/snorm compact
tangent  → compact tangent representation
uv0      → float16x2
uv1      → float16x2
color    → unorm8 when present
```

UV1 必须作为正式支持项，不能因为“多数 mesh 不用”而删除；Bistro / AO/lightmap 类资产需要它。

## 21.3 `VertexFormatRecordV3`

每个 pack 允许少量固定格式：

```cpp
struct VertexFormatRecordV3 {
    uint16_t strideBytes;
    uint16_t attributeMask;
    uint8_t  positionOffset;
    uint8_t  normalOffset;
    uint8_t  tangentOffset;
    uint8_t  uv0Offset;
    uint8_t  uv1Offset;
    uint8_t  colorOffset;
    uint8_t  reserved[...];
};
```

不要让 shader 解析任意 glTF vertex descriptor。

Cooker 把 authoring layout 归一成少量 Runtime profile。

---

# 22. Meshlet 大小策略

EEngine 当前 recipe 默认：

```text
64 vertices
128 triangles
```

Nyx 当前 README/实现 profile：

```text
128 vertices
128 triangles
```

本 ADR **不因为 Nyx 使用 128 就机械改成 128**。

V3 ABI 支持：

```text
vertexCount <= 128
triangleCount <= 128
```

Cook Recipe 初始默认仍采用：

```text
64 / 128
```

并在实施 benchmark 中强制对比：

```text
64/64
64/128
96/128
128/128
```

比较：

```text
meshlet metadata bytes
vertex duplication bytes
cull cost
visible meshlet count
indirect/vertex pulling cost
page fill rate
LOD simplification quality
```

这个参数属于 **Cook Profile**，不是运行时兼容路径。

---

# 23. Nyx LOD Group Builder 的移植规范

Native Cooker 的 LOD builder 以 Nyx `MeshletBuilder.cpp` 为主要算法蓝本。

## 23.1 LOD0

```text
source triangles
 → meshoptimizer buildMeshlets
 → compute bounds
 → LOD0 meshlets
```

## 23.2 Group Meshlets

按：

```text
共享顶点
空间邻近
material/pipeline compatibility
```

形成 Group。

Group 内不允许混合：

```text
opaque 与 transparent
single-sided 与 two-sided
不兼容 vertex format
不兼容 material pipeline domain
```

## 23.3 Vertex Seam Protection

Nyx 会建立 position-only remap，然后当相同位置的 vertex attributes 不同（normal/tangent/UV seam）时标记 protect。

该机制必须移植，防止 simplification 穿过：

```text
hard normal seam
UV seam
material boundary
```

导致明显破坏。

## 23.4 Group Simplification

初始 target：

```text
targetRatio ≈ 0.5
```

但最终值进入 `GeometryCookRecipeV3`，可基于 benchmark 调整。

优先使用 attribute-aware `meshopt_simplifyWithAttributes`。

## 23.5 Fallback Simplification

Nyx 对 normal simplify 失败可以尝试 sloppy simplification。

V3 可以保留这个算法，但必须：

```text
flags |= SimplificationFallback
```

并进入 Cook Evidence，不允许静默发生。

## 23.6 Error Propagation

从 Nyx 继承：

```text
coarseParentError = max(
    currentSimplificationError,
    finerParentError * mergeFactor
)
```

要求：

```text
coarser error >= finer error
```

Cook validation 必须检查 monotonicity。

---

# 24. Refinement Graph

Group 的 LOD 关系不是简单数组：

```text
LOD2 Group
  Meshlet A → RefineGroup 17
  Meshlet B → RefineGroup 19
  Meshlet C → none
```

也就是一个 coarse Group 中不同 meshlet 可以拥有不同 finer source Group。

这样可以实现局部细化，而不是：

```text
整个 object 一起切换 LOD
```

这是必须保留的 Nanite/Nyx-like 特性。

---

# 25. Hierarchy 构建

V3 按 Nyx 方法：

```text
每个 LOD level 的 Group Leaf
      ↓
build 8-way spatial hierarchy
      ↓
得到该 LOD Root

所有 LOD Roots
      ↓
Top-level hierarchy
```

最后 flatten 成：

```text
[top-level]
[coarsest LOD hierarchy without duplicate root]
[...]
[finest LOD hierarchy]
```

所有 child ranges 必须连续，使 GPU：

```text
childStart + lane
```

即可遍历，无 pointer chasing。

---

# 26. Group Serialization

Group 序列化顺序：

```text
GroupHeaderV3
MeshletHeaderV3[meshletCount]
TriangleData
VertexData
```

所有 section 至少 16-byte alignment。

MeshletHeader 内所有 offset 都是：

```text
relative to Group start
```

GroupDirectory 的 offset 是：

```text
relative to decoded Page start
```

这样 GPU 最终地址只需要：

```text
Bank + PageSlot + GroupOffset + MeshletOffset
```

不需要 64-bit pointer。

---

# 27. Page Packing Algorithm

不能只做“Group 按生成顺序塞满 Page”。

Page placement 会直接决定 runtime streaming 效率。

V3 的 packing priority：

```text
Tier 0: bootstrap / root coarse groups
Tier 1: next-coarse groups
Tier 2+: finer groups
```

同一个 tier 内：

```text
asset locality
→ hierarchy locality
→ material domain
→ deterministic stable group id
```

然后进行 deterministic first-fit / bounded best-fit packing。

## 27.1 Root Page 与 Fine Page 必须尽量分开

不要为了 page fill rate 把：

```text
root group + very fine group
```

塞在同一页。

否则 root pinned 会把永远不需要的 fine data 一起长期占 VRAM。

优先：

```text
lifetime locality > page utilization
```

## 27.2 Page Fill 目标

Cook Evidence 记录：

```text
pageCount
meanFillRatio
p50FillRatio
p95FillRatio
wastedPaddingBytes
rootPageBytes
```

不设一个未经 benchmark 的绝对 fill acceptance，但持续低于约 70% 应被标记为需要重新调 Group packing。

---

# 28. Bootstrap / Root Page Contract

每个 Asset 提供：

```text
bootstrapPageBegin
bootstrapPageCount
```

这些 page 必须足以渲染一个合法 coarse representation。

Scene Cooker 再汇总多个资产：

```text
SceneBootstrapSet
```

First Meaningful Frame 的几何条件定义为：

```text
所有可见/初始必要实例的 coarse root representation resident
```

而不是：

```text
所有 geometry fully loaded
```

## 28.1 Bootstrap Budget

建议 Scene Cooker 有显式预算，例如：

```text
bootstrapGeometryBudgetBytes
```

如果 root representation 超预算：

Cooker 应尝试：

```text
更强 coarse simplification
更合理 grouping
```

若仍失败，production build 报错，而不是让 Runtime 在启动时无上限加载。

---

# 29. Page Compression

V3 第一阶段选择：

```text
GPU-ready decoded page
       ↓
LZ4 block compression per page
```

原因：

- Nyx 已有完整工程证明；
- decode 快；
- 独立 page；
- output size 固定 256 KiB；
- Worker 易并行；
- decoded bytes 可以直接进入 GPU slot；
- 不需要再重建 vertex/index layout。

## 29.1 为什么 V3.0 不强制 Meshopt codec

meshoptimizer 的 codec 很有价值，但若 runtime 先 decode 到另一份 GPU-ready page，就增加 decode 路径复杂度。

V3.0 的首要目标是：

> **先把 Virtual Geometry + demand streaming 正确跑通，并保证 decoded page 零结构转换即可上传。**

后续 benchmark 如果网络明显成为瓶颈，再在同一 Page ABI 上增加：

```text
MeshoptPage / GPU decode
```

而不改 Hierarchy/Group/Page contracts。

---

# 30. Hash / Identity 体系

EEngine 当前已经重视 sourceHash、recipeHash、contentHash，这一点必须强化而不是删除。

V3 定义：

```text
SourceHash  = SHA-256(canonical source geometry/material-domain input)
RecipeHash  = SHA-256(canonical cook recipe)
AssetID     = SHA-256("OEG3" || SourceHash || RecipeHash)
```

Page：

```text
PageContentHash128 = first 128 bits of SHA-256(decoded 256 KiB page)
```

Pack：

```text
PackID = SHA-256(
    canonical resident metadata
    + ordered PageContentHash128
    + codec/size records
)
```

### 30.1 为什么 Page hash 以 decoded content 为准

这样：

```text
同一 logical page
LZ4 level 改变
```

不会改变 logical content identity。

对持久缓存/调试更合理。

---

# 31. Runtime V3 不再用“大 JSON manifest 枚举所有 Page”

EEngine `RuntimeAssetManifestV2` 的 canonical JSON 对小/中资产非常清晰。

但 virtual geometry 最坏情况可能是：

```text
100k / 1M pages
```

把每页：

```text
id
semantic
compression
byteOffset
size
checksum
```

写成 JSON 会产生不必要 metadata 膨胀和解析成本。

因此 V3：

```text
Top-level semantic manifest → small
Page Directory             → binary fixed records
```

这是对 EEngine V2 思路的升级，不是否定其版本/hash/variant设计。

---

# 32. Runtime Asset V2 → V3 的兼容策略

本项目已经明确：**不做生产兼容路径。**

因此：

```text
GeometryAssetPackage V2
      ↓
source recook
      ↓
OEGPACK V3
```

而不是：

```text
Runtime 检测 V2
if V2 → legacy loader
if V3 → new streaming loader
```

Advanced Renderer 的 V3 路径遇到 V2 package：

```text
hard error: recook required
```

测试期间可以保留 V2 reader 做 golden comparison，但不进入 production bundle。

---

# 33. Native C++ Cooker 选择

生产权威 Cooker：

```text
oengine-asset-cooker.exe
```

C++20/23。

推荐初始依赖：

```text
cgltf
meshoptimizer
lz4
SHA-256 implementation
```

## 33.1 为什么第一版优先 cgltf

Nyx 已经使用 cgltf 并验证其大场景接入；它结构简单、C API、适合直接访问 buffer/view/accessor。

不是说 fastgltf 不好，而是现在优先降低移植变量。

如果 profiler 证明 glTF parse 是离线构建瓶颈，再单独比较 fastgltf。

---

# 34. `oengine-asset-core` 目录建议

```text
tools/oengine-asset-core/
│
├─ include/oengine_asset/
│   ├─ OegPackFormat.h
│   ├─ GeometryAbi.h
│   ├─ GeometryCookRecipe.h
│   └─ Hash.h
│
├─ src/
│   ├─ import/
│   │   ├─ GltfImporter.cpp
│   │   └─ CanonicalGeometry.cpp
│   │
│   ├─ geometry/
│   │   ├─ MeshletBuilder.cpp
│   │   ├─ LODGroupBuilder.cpp
│   │   ├─ HierarchyBuilder.cpp
│   │   ├─ VertexPacker.cpp
│   │   ├─ GroupSerializer.cpp
│   │   └─ PagePacker.cpp
│   │
│   ├─ package/
│   │   ├─ OegPackWriter.cpp
│   │   ├─ SceneManifestWriter.cpp
│   │   └─ PackValidator.cpp
│   │
│   └─ codec/
│       └─ Lz4PageCodec.cpp
│
├─ cli/
│   └─ main.cpp
│
├─ wasm/
│   └─ bindings.cpp
│
└─ tests/
```

Native CLI 和未来 WASM Tooling 都调用同一个 core。

---

# 35. C++ Cooker 的执行阶段

```text
Stage 0  Read/import source
Stage 1  Canonicalize primitives/material domains
Stage 2  Content-hash geometry dedup
Stage 3  Compact source attributes
Stage 4  Build LOD0 meshlets
Stage 5  Build groups
Stage 6  Iterative simplify + RefineGroup DAG
Stage 7  Build per-LOD hierarchy + top hierarchy
Stage 8  Serialize page-local group payloads
Stage 9  Pack 256 KiB pages
Stage 10 Parallel LZ4
Stage 11 Build resident metadata
Stage 12 Hash/validate
Stage 13 Write .oegpack + .oescene
```

---

# 36. Cooker 并行化

Nyx `ModelConvert.cpp` 已经对 unique meshes 使用 OpenMP 并行构建，并对 pages 并行 LZ4。

EEngine Native Cooker 应进一步任务化：

```text
GeometryAsset A ─┬─ meshlet/LOD task
GeometryAsset B ─┤
GeometryAsset C ─┤
...               │
                  ▼
          deterministic commit
                  │
                  ▼
Page 0 ───────────┬─ LZ4
Page 1 ───────────┤
Page 2 ───────────┤
                  ▼
             Pack writer
```

注意：

> 并行 build 不允许让线程完成顺序改变最终 Group/Page ID。

先以 stable source key 排序，再并行计算，最后 deterministic commit。

---

# 37. Cooker 内存策略

当前 EEngine JS 路径中的 `SourceGeometry` 为 immutable identity 会复制 typed arrays；大型 GLB 下这会造成额外内存峰值。

Native Cooker 不需要复制这个实现细节。

原则：

```text
Memory map / streamed source when possible
immutable view/span for canonical input
per-task scratch arenas
bounded parallelism by estimated bytes
release intermediate buffers immediately
```

对大场景避免：

```text
GLB bytes
+ copied BIN
+ copied SourceGeometry
+ meshlet buffers
+ final package
```

同时长期存在。

---

# 38. glTF Primitive 合并与 Instance 语义

EEngine 当前 `buildPackedGltfSource()` 有两个正确行为，必须保留：

### 38.1 同一个 glTF mesh 被多个 node 引用时，作为实例共享 geometry

禁止因为 node 数量复制 geometry package。

### 38.2 只在同一 mesh 内、material/layout compatible 时 merge primitive

不要做全场景 world-space flatten merge。

原因：

```text
scene structure
instancing
visibility
streaming locality
transform reuse
```

都会被全局 merge 破坏。

Native Cooker 在此基础上再增加：

```text
跨 mesh 的 canonical geometry content hash dedup
```

如果两个 mesh 字节/语义真正一致，则映射到同一 AssetID。

---

# 39. Material Domain 对 Geometry Cook 的影响

虽然完整 Texture/Material asset 在 D 设计，但 A 必须把会改变 geometry pipeline 的 material bits 烘焙进 geometry：

```text
alphaMode
alphaCutoff domain
single/two-sided
castsShadow classification
vertex attribute requirements
```

目的：

- meshlet/group 不混 incompatible PSO；
- cone culling 对 two-sided 正确关闭；
- C 中可以按 pipeline domain bucket visible meshlets。

---

# 40. Scene Bootstrap 的物理布局优化

`.oegpack` page blob 建议按照：

```text
bootstrap pages first
coarse pages next
fine pages last
```

这不是 correctness requirement，而是 cold-start optimization。

好处：

- 初始 Range 更集中；
- CDN/HTTP range coalescing 更容易；
- 顺序磁盘 cache locality 更好；
- Debug dump 更清晰。

Page Directory 仍是唯一真实地址来源，不能依赖“PageID == 文件顺序”作为 ABI correctness。

---

# 41. Pack Sharding

不要让：

```text
1296 geometry = 1296 files
```

但也不建议所有世界永远一个 50 GB 文件。

Cooker 支持 target pack shard bytes，例如：

```text
128–512 MiB compressed per .oegpack shard
```

具体默认值在 benchmark 后冻结。

Sharding 优先维持：

```text
asset complete locality
bootstrap locality
content stability
```

大 Asset 可以跨 pack shard，但一个 Logical Page 永远只属于一个 pack。

---

# 42. HTTP/CDN Contract

为了 Range Streaming：

服务器必须支持：

```text
Accept-Ranges: bytes
```

`.oegpack` 应使用 content-hashed immutable URL：

```text
geometry-<PackID>.oegpack
```

生产部署不应再对 `.oegpack` 整体施加会改变 byte representation 的透明 gzip/brotli Content-Encoding；否则 Cooker 的物理 byte offsets 不再是简单的 payload offsets。

压缩由 Page Codec 自己负责。

---

# 43. ABI 与 WGSL 的规则

### 43.1 Disk offset 用 u64

Pack 可以超过 4 GiB。

### 43.2 GPU-visible ID 用 u32

WebGPU shader 只需要：

```text
asset index
group id
page id
bank id
slot id
byte offset
```

全部使用 u32。

### 43.3 不把 C++ bitfield struct 原始 memcpy 当跨语言 ABI

虽然 Nyx 这样做在同编译器/DX12 工程里可行，EEngine V3 必须定义：

```text
exact byte offsets
explicit little-endian pack functions
static_assert sizes
TypeScript decoder tests
WGSL decode tests
```

### 43.4 所有 GPU page 内 offset 以 byte 计数且 4-byte aligned

Group start 强制 16-byte aligned。

---

# 44. Runtime Metadata Residency

A 决定哪些一定常驻：

```text
AssetRecord
RootNodeIndex
HierarchyNode
GroupDirectory
VertexFormatRecord
```

`PageDirectory` 可只在 CPU 内存常驻，GPU 不需要全部看到。

B 会创建真正 GPU runtime 的：

```text
GroupDataLocation / PageResidencyTable
```

它与 Disk GroupDirectory 是两套不同概念：

```text
Disk logical mapping:
Group → PageID + PageOffset

Runtime physical mapping:
Group → BankIndex + PhysicalByteOffset / INVALID
```

不要把物理地址写进 cooked package。

---

# 45. Root Page Pinning Contract

A 只负责标记：

```text
bootstrap/root pages
```

B 负责实际 pin。

但 ABI invariant 是：

> 如果所有 bootstrap pages resident，则每个资产必须存在一个无洞的合法 renderable cut。

Cooker Validation 必须能离线证明这一点。

---

# 46. Cooker Validation

Production build 结束必须执行完整 validation。

至少检查：

```text
Hierarchy child ranges valid
GroupID valid
Group payload within one page
Meshlet header offsets valid
Meshlet local indices < vertexCount
Meshlet counts within profile limits
RefineGroupId valid or INVALID
Refinement LOD strictly finer
ParentError monotonic
All root groups reachable
All leaf/fine groups reachable
Bootstrap pages form valid coarse cut
Page decoded size exactly 256 KiB
Compressed ranges non-overlapping
Asset/pack hashes deterministic
All bounds finite
No NaN/Inf in runtime metadata
```

继承 Nyx `ValidateBuild()` 的思路，并比它进一步验证 binary package。

---

# 47. Deterministic Cook

同样 input + recipe：

```text
Cook A
Cook B
```

必须：

```text
byte-for-byte identical .oegpack
```

因此禁止：

```text
unordered_map iteration order → output IDs
thread completion order → page IDs
non-deterministic simplifier seed
filesystem traversal order → asset order
```

EEngine 当前 `GeometryCookRecipe` 的 deterministic seed / pinned meshoptimizer commit 思想继续保留。

---

# 48. Recipe V3

建议把当前 recipe 扩展为：

```text
GeometryCookRecipeV3
├─ meshoptimizerCommit
├─ hierarchyAlgorithmVersion
├─ meshletMaxVertices
├─ meshletMaxTriangles
├─ coneWeight
├─ groupTargetMeshlets
├─ simplifyTargetRatio
├─ simplifyFailureRatio
├─ simplifyPermissive
├─ sloppyFallback
├─ lodErrorMergeFactor
├─ hierarchyFanout = 8
├─ pageShift = 18
├─ pageCodecPolicy = lz4-or-raw
├─ vertexProfileVersion
├─ positionQuantization = meshlet-aabb-u16
├─ bootstrapBudgetPolicy
├─ deterministicSeed
└─ floatMode
```

任何影响最终 bytes 的字段必须进入 RecipeHash。

---

# 49. 当前 EEngine 文件如何演进

## 49.1 `GeometryCookRecipe.ts`

保留语义，升级 V3 mirror type；权威 recipe 实现在 C++，TS 只用于 Runtime metadata/debug/test。

## 49.2 `GeometryCooker.ts`

不再作为 production cooker。

阶段性用途：

```text
reference oracle
unit test
C++ parity comparison
```

Native parity 完成后不进入 production Runtime bundle。

## 49.3 `GeometryAssetPackage.ts`

V2 继续仅用于测试期间读取旧 golden fixture。

新增独立：

```text
OegPackV3.ts
GeometryAbiV3.ts
```

不要在同一个 class 里充斥 `if version==2 / if version==3`。

## 49.4 `RuntimeAssetPackage.ts / ManifestV2`

保留给其它小型资产也可以，但 Virtual Geometry production path 不再依赖“whole ArrayBuffer open”。

新增：

```text
RangeReadablePackV3
```

只读：

```text
header range
metadata range
individual page range
```

## 49.5 `RuntimeAssetResidency.ts`

保留状态机思想。

B 会围绕它抽出更通用的：

```text
VirtualPageResidency
```

但 A 不把 Scheduler、GPU feedback 塞进去。

## 49.6 `SourceGeometry.ts`

保留为 test/reference canonical geometry model。

生产 C++ Cooker 使用等价 native representation，不再经历 JS typed-array copy path。

## 49.7 `load_gltf.ts / GltfLoader.ts`

继续服务：

```text
editor/debug/import tests
```

但 Advanced Production Runtime 不通过它加载 `.oegpack`。

## 49.8 `cook-packed-gltf-geometries.mjs`

被 Native CLI 替代。

最终：

```bash
oengine-asset-cooker scene.glb --out dist/assets/
```

一次输出 scene + pack shards。

---

# 50. Nyx 文件到 EEngine V3 的源码映射

| Nyx | EEngine V3 |
|---|---|
| `MeshletBuilder::BuildLOD0Meshlets` | `GeometryLODBuilder::BuildLeafMeshlets` |
| `GroupMeshlets` | `GeometryLODBuilder::BuildGroups` |
| `BuildVertexLocksByGroups` | `GeometrySimplifier::BuildSeamLocks` |
| `SimplifyGroup` | `GeometrySimplifier::SimplifyGroup` |
| `SerializeGroup` | `GeometryGroupSerializer::Serialize` |
| `MeshletHeader::RefineGroupIndex` | `MeshletHeaderV3.refineGroupId` |
| `BuildStreamingData` | `GeometryHierarchyBuilder::BuildNyxHierarchy` |
| `HierarchyNode` | `GeometryHierarchyNodeV3` |
| `GroupMetadata` | `GeometryGroupDirectoryV3` |
| `PageMetadata` + `PageCompressionInfo` | `GeometryPageDirectoryV3` |
| 256 KiB page packing | 256 KiB V3 decoded page |
| `LZ4_compress_default` per page | `Lz4PageCodec` |
| `.mini` geometry blob | `.oegpack` page blob |
| `GroupDataLocation` | B 的 runtime physical group address table |
| `PinRootPages` | B 的 bootstrap residency/pinning |
| GPU request mask | B/C 的 WebGPU feedback mask |

---

# 51. EEngine 当前能力到 V3 的映射

| EEngine V2 | V3 决策 |
|---|---|
| source/recipe/content hash | 保留并增强 |
| deterministic cook | 保留 |
| meshoptimizer | Native C++ 继续使用 |
| 64/128 meshlet default | 保留为第一 benchmark baseline |
| compact position/normal/UV | 保留思想，position 改 meshlet-local quantization |
| material alpha/two-sided metadata | 保留 |
| renderable parent meshlets | 与 Nyx Group refinement 融合 |
| ClusterRecord 128 B | 不作为 V3 hot metadata |
| BVH8Node 352 B | 用 compact Nyx-style node 替代默认物理布局 |
| whole `.oeg` | 改 `.oegpack` Pages |
| `compression:none` | page LZ4/raw |
| one geometry per file | 多 asset pack |
| RuntimeAssetManifest V2 JSON chunks | binary PageDirectory |
| Worker fallback cook | production 移出；工具版可用同 C++ core→WASM |

---

# 52. WASM 的定位

本 ADR 不需要“兼容路径”，但允许 C++ core 编译成 WASM 用于：

```text
Editor import
用户拖入 GLB
开发时快速 preview cook
浏览器内 benchmark
```

它不是 production Runtime fallback。

Production build 应直接发布已经 cook 完成的 `.oegpack`。

---

# 53. OPFS/持久缓存的接口预留

具体缓存算法属于 B，但 A 的 Page identity 已为它准备：

```text
PackID
PageID
PageContentHash128
codec
compressed range
```

B 可以构建：

```text
(PackID, PageID, PageHash)
 → cached compressed page
```

不需要知道原 GLB。

---

# 54. Bistro 在 V3 中会发生什么

源文件即使接近 1 GB，Production Runtime 也不会：

```text
下载整个 Bistro GLB
```

Cook 阶段先完成：

```text
geometry instance dedup
meshlet/LOD hierarchy
page-local vertex conversion
page compression
geometry pack generation
texture dedup/compression（D）
```

Runtime 初始只需要：

```text
scene.oescene
+ OEG metadata prefix
+ bootstrap geometry pages
+ texture mip-tail（D）
```

因此“源 GLB 大小”从 Runtime 第一帧 KPI 中被移除。

---

# 55. Zorah/Nyx-class Stress Test 的意义

Bistro 用于：

```text
真实 PBR/贴图较多的大型建筑资产
```

但它不足以证明 Virtual Geometry 上限。

后续还要加入 Nyx 类超大几何压力资产，验证：

```text
Hierarchy metadata scaling
Group count scaling
Page count scaling
request mask scaling
physical bank pressure
refinement churn
```

---

# 56. 性能指标

A 阶段就要输出 cook/package evidence：

```text
source bytes
unique geometry bytes
leaf meshlets
parent meshlets
groups
hierarchy nodes
hierarchy bytes
page count
compressed page bytes
decoded page bytes
compression ratio
mean/p50/p95 page fill
bootstrap page count
bootstrap geometry bytes
vertex duplication ratio
cook wall time
peak cooker RAM
```

Runtime KPI 在 B/C 继续：

```text
TTFMF
bytes-before-first-frame
page miss rate
GPU resident bytes
upload MB/frame
streaming CPU ms
streaming GPU ms
page thrash
```

---

# 57. Acceptance Tests

## 57.1 ABI Golden Test

同一个小资产固定输出一份 golden `.oegpack`。

C++ writer、TS parser 必须逐字段一致。

## 57.2 Struct Size Test

C++：

```cpp
static_assert(sizeof(GeometryHierarchyNodeV3) == 48);
static_assert(sizeof(GeometryGroupDirectoryV3) == 16);
static_assert(sizeof(GroupHeaderV3) == 64);
static_assert(sizeof(MeshletHeaderV3) == 48);
```

## 57.3 WGSL Decode Test

GPU compute 读取已知 records，写回 decoded fields，与 CPU expected 比较。

## 57.4 Determinism

同机、不同线程数，多次 cook：

```text
SHA-256(pack A) == SHA-256(pack B)
```

## 57.5 Page Independence

随机只加载某个 Page，验证该 page 所有 Group 可以在没有 global source vertex buffer 的情况下正确 decode/raster。

## 57.6 Bootstrap Cut

只 resident bootstrap pages，所有 asset 必须能够生成完整 coarse scene，不允许 hole。

## 57.7 Corruption

故意破坏：

```text
page offset
compressed size
hash
Group offset
RefineGroup
Hierarchy child range
```

必须在 open/cook validation 阶段明确失败。

---

# 58. 不在 ADR-0016-A 实现的内容

以下内容有意延后：

```text
GPU request mask implementation        → B/C
physical page eviction policy          → B
readback ring                          → B
HTTP range merge scheduler             → B
OPFS eviction/cache scheduler          → B
DispatchMesh replacement               → C
VisibleMeshletList/indirect args        → C
primitive-index visibility encoding    → C
texture native compression             → D
texture mip streaming / SVT            → D
```

A 只把它们所需的数据合同准备好。

---

# 59. ADR-0016-B 的输入合同

B 可以假设 A 已提供：

```text
PageID → compressed range
PageID → decoded hash
GroupID → PageID + offset
BootstrapPageIDs
Page decoded bytes = exactly 256 KiB
Group never crosses Page
Hierarchy metadata independent of Page residency
```

B 的任务因此纯粹变成：

```text
logical page
 → priority
 → fetch/cache/decode
 → physical slot
 → runtime address table
 → retire/evict
```

---

# 60. ADR-0016-C 的输入合同

C 可以假设：

```text
HierarchyNodeV3[] always resident
GroupDataLocationRuntime[] always queryable
resident Group starts at stable physical address
GroupHeaderV3 and MeshletHeaderV3 fixed ABI
meshlet vertices page-local
meshlet triangle indices local-u8
RefineGroupID available
```

因此 C 专注：

```text
Nyx DAGCull
→ WGSL compute traversal
→ residency check/request
→ visible meshlet compaction
→ indirect draw / vertex pulling
→ visibility buffer
```

不再碰 asset parser/cooker。

---

# 61. ADR-0016-D 与 A 的共享原则

D 的 texture pack 应与 A 共享：

```text
Content Addressing
PackID
binary Page Directory
independent page/range
bootstrap subset
immutable hashed URL
bounded residency
```

但 Geometry Page 与 Texture Page 不要求相同 page size 或 codec。

---

# 62. 实施阶段

## A0 — Freeze Contracts

输出：

```text
GeometryAbiV3.h
OegPackFormat.h
GeometryCookRecipeV3.h
```

先写 struct + validation tests，不写完整 cooker。

## A1 — C++ Canonical Import

实现：

```text
cgltf import
instance reuse
material domain split
canonical geometry hash
cross-mesh dedup
```

与 EEngine 当前 `buildPackedGltfSource` 小资产输出做语义对照。

## A2 — Native Meshlet + Compact Vertex

移植/复用：

```text
meshoptimizer buildMeshlets
bounds
material flags
compact attributes
meshlet-local position quantization
```

## A3 — Nyx LOD Group Port

重点移植：

```text
GroupMeshlets
attribute seam locks
SimplifyGroup
RefineGroup
error propagation
ValidateBuild
```

## A4 — Compact Hierarchy

实现 Nyx-style：

```text
per-LOD BVH8
Top-level hierarchy
48 B node serialization
```

## A5 — Page Packer

实现：

```text
64 B GroupHeader
48 B MeshletHeader
256 KiB pages
bootstrap-aware ordering
```

## A6 — Page Codec / Pack Writer

实现：

```text
parallel LZ4/raw selection
binary directories
hashing
pack sharding
```

## A7 — TypeScript Runtime Reader

只实现：

```text
fetch header range
fetch metadata range
validate
expose tables
```

不要实现完整 B scheduler。

## A8 — Vertical Bootstrap Proof

临时最小 runtime：

```text
加载 bootstrap pages
上传固定 slots
手工 resolve groups
```

证明 Page 可以被现有 WebGPU pipeline读取。

## A9 — Benchmark / ABI Freeze

比较：

```text
EEngine V2
Nyx source assumptions
EEngine V3
```

在 Bistro + 中型场景 + 超大 geometry scene 上确认后，冻结 `OEGPACK V3.0`。

---

# 63. 不建议在 A 阶段提前做的优化

即使目标是“极致”，以下优化现在先不要耦合进 V3.0：

```text
GPU geometry decompression
software virtual texture
mesh shader emulation micro-optimizations
subgroup-specific page decode
neural compression
runtime LOD rebuild
```

原因不是它们不值得，而是先把：

```text
Virtual Asset ABI
```

冻结后，这些技术都能在不破坏资源体系的情况下继续替换 backend。

---

# 64. 最终架构图

```text
                                  OFFLINE

             GLB / glTF / other authoring source
                          │
                          ▼
               ┌─────────────────────┐
               │  Native C++ Import  │
               └──────────┬──────────┘
                          ▼
               Canonical Geometry Set
                          │
                    content dedup
                          │
                          ▼
               ┌─────────────────────┐
               │ Meshlet Builder     │
               │ meshoptimizer       │
               └──────────┬──────────┘
                          ▼
                      LOD0 Meshlets
                          │
                          ▼
               ┌─────────────────────┐
               │ Nyx Group Builder   │
               │ + seam locks        │
               │ + simplification    │
               │ + RefineGroup DAG   │
               └──────────┬──────────┘
                          ▼
               Renderable LOD Groups
                          │
              ┌───────────┴────────────┐
              ▼                        ▼
       compact hierarchy         Group serializer
              │                        │
              │                        ▼
              │                page-local vertices
              │                local triangle indices
              │                        │
              └───────────┬────────────┘
                          ▼
                     Page Packer
                          │
                    256 KiB pages
                          │
                          ▼
                  parallel LZ4/raw
                          │
                          ▼
              ┌──────────────────────┐
              │     .oegpack V3      │
              │ resident metadata    │
              │ compressed pages     │
              └──────────┬───────────┘
                         │
                         ▼

                                  RUNTIME

                    fetch scene.oescene
                         │
                         ▼
                  fetch pack header
                         │
                         ▼
                fetch metadata range
                         │
       ┌─────────────────┼─────────────────┐
       ▼                 ▼                 ▼
 HierarchyNode      GroupDirectory      PageDirectory
 always resident       logical map          CPU
       │                 │                 │
       └─────────────────┴─────────────────┘
                         │
                         ▼
                   bootstrap PageIDs
                         │
                         ▼
               [ADR-0016-B Residency]
                         │
                         ▼
           128 MiB WebGPU Geometry Banks
              512 x 256 KiB slots/bank
                         │
                         ▼
             runtime GroupDataLocation
                         │
                         ▼
              [ADR-0016-C GPU Driven]
```

---

# 65. 最终决策清单

| 决策 | 结论 |
|---|---|
| GLB 是否 production runtime asset | 否 |
| Native C++ Cooker | 是，production authoritative |
| Nyx 是否只是参考 | 否，LOD Group/Hierarchy/Page 算法是主要移植基线 |
| EEngine V2 是否全部推翻 | 否，保留 deterministic/hash/compact/material 设计思想 |
| V2 package 是否 production fallback | 否 |
| Geometry Page | 固定 decoded 256 KiB |
| Page codec v3.0 | LZ4 / Raw |
| Group 是否跨 Page | 禁止 |
| Page 是否依赖 global vertex buffer | 禁止 |
| Meshlet vertices | page-local |
| Position quantization | meshlet AABB local u16 |
| Refinement | Nyx-style `RefineGroupId` |
| Hierarchy | compact 8-way Nyx-style node |
| 当前 128B Cluster + 352B BVH8 | 不作为 V3 默认 hot ABI |
| GPU physical bank | 128 MiB class，512 pages/bank |
| 一 geometry 一文件 | 否，多 asset `.oegpack` |
| Page Directory | binary fixed record |
| Root pages | Cooked bootstrap set + B pinning |
| Runtime Cooker | production 禁止；WASM 仅 tooling/editor |

---

# 66. 与父 ADR 的关系

ADR-0016 提出的：

```text
Virtualized Asset System
Native Cooker
Geometry Pages
GPU Feedback Streaming
Progressive Residency
```

在本 ADR 中已经从概念收敛成可实现的数据合同。

从这一刻开始，后续 B/C 不应再重新讨论：

```text
Page 到底多大
Group 是否跨页
Vertex 是否全局常驻
Hierarchy leaf 指向什么
RefineGroup 存在哪里
Pack 是否一 mesh 一文件
```

这些问题在 A 冻结。

若后续 benchmark 推翻其中任何一项，必须回到 ADR-0016-A 修订版本，而不是在代码里悄悄产生第二套结构。

---

# 67. References / Source Audit Snapshot

## EEngine @ `cec226e6feb825ce4d682f97b1d966c8e71d0c6a`

- `OEngine/src/assets/RuntimeAssetPackage.ts`
- `OEngine/src/assets/RuntimeAssetManifestV2.ts`
- `OEngine/src/assets/RuntimeAssetResidency.ts`
- `OEngine/src/assets/GeometryAssetPackage.ts`
- `OEngine/src/assets/GeometryCookRecipe.ts`
- `OEngine/src/assets/SourceGeometry.ts`
- `OEngine/src/geometry/GeometryCooker.ts`
- `OEngine/src/geometry/GeometryHierarchy.ts`
- `OEngine/src/loaders/gltf/GltfLoader.ts`
- `OEngine/src/loaders/load_gltf.ts`
- `OEngine/tools/cook-packed-gltf-geometries.mjs`

## Nyx @ `bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b`

- `MiniEngine/Model/MeshletStructs.h`
- `MiniEngine/Model/MeshletBuilder.cpp`
- `MiniEngine/Model/Model.h`
- `MiniEngine/Model/ModelLoader.h`
- `MiniEngine/Model/ModelConvert.cpp`
- `MiniEngine/Model/GeometryStreaming.cpp`
- `MiniEngine/Model/Shaders/DAGCull.slang`
- `README.md`

## WebGPU 2026

设计按 2026-08-20 W3C WebGPU Candidate Recommendation Draft 的 full-mode 基线考虑，尤其是：

```text
maxStorageBufferBindingSize default = 128 MiB
maxBufferSize default               = 256 MiB
minStorageBufferOffsetAlignment     = 256 B
```

这些限制直接决定：EEngine 不照搬 Nyx 256 MiB 单 Storage Chunk，而使用 128 MiB-class Geometry Banks。

---

# 68. 后续

本 ADR 认可后，下一篇：

> **ADR-0016-B — Nyx GeometryStreaming → EEngine WebGPU Virtual Page Residency、GPU Feedback、HTTP/OPFS Streaming Scheduler**

B 必须直接消费本 A 定义的：

```text
GeometryHierarchyNodeV3
GeometryGroupDirectoryV3
GeometryPageDirectoryV3
256 KiB Geometry Page
BootstrapPageSet
```

不另起第二套 Geometry streaming format。
