# ADR-0016：EEngine Virtualized Asset & Geometry Architecture
## Nyx × EEngine × WebGPU 2026：面向极致加载与运行性能的最终设计提案

- **状态**：Proposed / Final Design Draft
- **日期**：2026-09-15
- **目标引擎**：EEngine
- **EEngine 基线提交**：`cec226e6feb825ce4d682f97b1d966c8e71d0c6a`
- **Nyx 研究基线**：`bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b`
- **核心方向**：Nyx 算法体系移植 + EEngine 现有 GPU-driven / Visibility Buffer 架构融合 + WebGPU 2026 新特性 + Native C++ Cooker + Demand-driven Streaming + GPU Residency

---

# 0. 结论先行

本 ADR 的最终决策不是“优化 glTF Loader”，也不是“给现有 GLB 加 Worker”。

EEngine 的生产级资源与几何系统将升级为：

> **Virtualized Asset System + Virtualized Geometry + Streaming Residency + GPU Feedback**

其中：

1. **Nyx 作为主要几何虚拟化算法/工程移植来源**，直接吸收其 Meshlet Hierarchy、连续 LOD、DAG/BVH、Root Page Pinning、Geometry Page、GPU Request Mask、Residency/Address Table、异步 Page Streaming 等核心思想和实现。
2. **EEngine 不复制 Nyx 的 DX12/Mesh Shader 后端**，而是在 WebGPU 上重新实现执行后端：
   - Compute DAG traversal / culling
   - GPU visible-meshlet compaction
   - 单个或极少数 `drawIndirect()`
   - `instance_index` 驱动 Meshlet 实例
   - `primitive_index` 直接作为 Meshlet 内 Triangle ID
   - Storage Buffer Vertex Pulling
   - Visibility Buffer + Deferred/Compute Resolve
3. **生产 Runtime 不再加载原始 GLB/glTF**。glTF/GLB 仅作为 Authoring/Import Source。
4. **生产资源全部经过 Native C++ Cooker 离线烘焙**，输出 EEngine 专用、可 Range Streaming、可直接 GPU Residency 的资源包。
5. **不设计低端兼容路径，不保留 Legacy Renderer fallback，不以 Cesium/3D Tiles 为架构依据。**
6. **WebGPU 2026 高性能 Feature Contract 是引擎设计前提，而不是可选附加项。**
7. **纹理生产路径直接输出 GPU-native BC 格式**，不把 Basis/KTX2 Runtime Transcode 作为默认生产路径；现有 KTX2/WASM codec 保留为工具链能力，而非最终热路径。
8. 最终优化指标不再是“整个模型 load() 多久”，而是：
   - Time To First Meaningful Frame
   - Time To Interactive
   - Bootstrap Bytes
   - Page Miss / Thrash
   - Streaming CPU/GPU cost
   - Main-thread long task
   - GPU residency efficiency
   - Full-quality convergence time

这套系统的目标，本质上是：

> **把 Nanite/Nyx 的 Virtual Geometry、现代游戏引擎的 Cooked Asset/Streaming、WebGPU 2026 的 primitive-index/subgroups 等能力，重新组合成适合 EEngine 的 WebGPU 原生架构。**

---

# 1. 为什么必须重构资源体系，而不是继续修补 GLB Loader

当前 EEngine 已经具备相当先进的 Runtime 基础：

- Runtime Asset Package / Manifest V2
- Chunk metadata
- Content Hash / Recipe Hash
- Geometry Cooker
- Meshlet / LOD Hierarchy / BVH8
- TextureAssetPackage
- BC/ASTC/ETC2 Codec Policy
- KTX2/Basis Worker Transcode
- AssetWorkerPool
- Residency Budget
- Stable GPU handles
- GPU-driven renderer / Visibility Buffer

但入口仍然存在典型“Authoring Asset 直接进入 Runtime”的问题。

当前 `GltfLoader` 的 GLB 路径需要：

```text
fetch GLB
    ↓
arrayBuffer() 整体读取
    ↓
GLB chunk slice
    ↓
JSON parse
    ↓
ImageBitmap decode
    ↓
Promise.all(images)
    ↓
SourceGeometry normalize/copy
    ↓
Geometry cook/fetch
    ↓
GPU residency
    ↓
FIRST FRAME
```

对 Bistro 这类接近 1 GB 的资源，这个模型本身就是错误的。

终极系统应该变成：

```text
small bootstrap manifest
        ↓
root/coarse geometry pages
        +
texture mip tails
        ↓
FIRST MEANINGFUL FRAME
        ↓
GPU feedback
        ↓
visible page streaming
        ↓
progressive quality convergence
```

因此本 ADR 的第一原则是：

> **Runtime 不再“加载模型文件”；Runtime 只管理虚拟资源页的需求、传输和驻留。**

---

# 2. 明确不做什么

本方案刻意排除以下方向：

- 不做 WebGL fallback。
- 不为不支持高性能 WebGPU Feature Contract 的设备维护第二套 renderer。
- 不把原始 GLB 作为生产 Runtime Asset。
- 不把 Draco/KTX2/Basis Runtime 解码兼容性作为核心目标。
- 不使用 Cesium 3D Tiles 作为场景分页格式或架构基础。
- 不设计“一个对象一个文件”的大量碎片请求模型。
- 不以“全部资源加载完成后再显示”为启动语义。
- 不允许资产 Streaming 在主线程执行重 CPU 工作。
- 不把 256 KB、128 triangles 等常量视作不可修改的真理；这些是 benchmark-driven 参数。

---

# 3. 研究基线与可移植性判断

## 3.1 Nyx 中直接移植的算法层

Nyx 当前核心能力包括：

- Nanite-style Meshlet Hierarchy
- DAG/BVH traversal
- Continuous LOD
- Two-pass Frustum + HZB Culling
- Visibility Buffer
- Dynamic Geometry Streaming
- Residency / Address Table
- GPU Streaming Request Mask
- Root Page Pinning
- Async page IO
- LZ4-compressed geometry pages
- Offline `.gltf/.glb -> .mini` build

这些部分绝大多数与 DX12 API 无关，属于：

> **数据结构 + 算法 + Streaming 状态机 + Cooker 逻辑**

因此直接作为 EEngine 移植主线。

## 3.2 Nyx 中不能原样照抄的 API 层

Nyx 使用：

```text
DX12
Mesh Shader
DispatchMesh
Bindless descriptor model
Native file IO
Native threads
```

WebGPU 没有原生 Mesh Shader/DispatchMesh，也没有 DX12 式 Descriptor Heap 和 DirectStorage。

因此仅替换执行层：

```text
Nyx                         EEngine WebGPU
------------------------------------------------------
DispatchMesh          ->    Compute + Indirect Draw
Mesh Shader           ->    Vertex Pulling / optional SW raster
Descriptor Heap       ->    fixed GPU tables + heap banks
Native IO thread      ->    Dedicated Worker + fetch Range + OPFS
LZ4 C++ runtime       ->    WASM Worker / later GPU decode experiment
Readback buffer ring  ->    WebGPU mapAsync readback ring
```

算法本身不需要推倒重做。

---

# 4. WebGPU 2026 High-Performance Feature Contract

EEngine Advanced Renderer 定义一个明确的高性能设备契约。

## 4.1 必需 Feature

建议生产目标至少要求：

```text
subgroups
primitive-index
indirect-first-instance
shader-f16
texture-compression-bc
```

开发/性能验证环境要求：

```text
timestamp-query
```

可利用但不作为核心正确性依赖：

```text
subgroup-size-control
texture-formats-tier1 / tier2
```

### 重要原因

`primitive-index` 对本架构非常关键。

WebGPU 2026 中 Fragment Shader 可以直接获得当前 primitive 的索引，而且索引在每个 instance 内重新从 0 开始。

这使得：

> **一个 Meshlet = 一个 draw instance**

成为非常自然的替代 Mesh Shader 的 WebGPU 方案。

## 4.2 Required Limits

建议 EEngine HighPerf-2026 profile 明确检查而不是默默降级：

```text
maxComputeInvocationsPerWorkgroup >= 256
maxStorageBufferBindingSize       >= 128 MiB
maxBufferSize                     >= 256 MiB
maxStorageBuffersPerShaderStage   >= engine-defined requirement
maxStorageBuffersInVertexStage    >= engine-defined requirement
maxStorageBuffersInFragmentStage  >= engine-defined requirement
```

如果 Adapter 不满足 HighPerf contract：

```text
初始化失败 + 明确提示 unsupported target
```

而不是启用第二套低性能架构。

---

# 5. 总体架构

```text
                           AUTHORING / BUILD

 FBX / GLB / glTF / OBJ / USD / Images
                  │
                  ▼
╔══════════════════════════════════════════════════════════╗
║                oengine-asset-core (C++)                 ║
║                                                          ║
║  Import / Canonicalize                                  ║
║  Content Dedup                                          ║
║  Mesh Optimization                                      ║
║  Meshlet Build                                          ║
║  Meshlet Group + Simplification                         ║
║  DAG/BVH                                                ║
║  Error Metric / Conservative Bounds                     ║
║  Geometry Page Packing                                  ║
║  Meshopt Encode + Page Compression                      ║
║  Texture Semantic Analysis                              ║
║  BC7 / BC5 / BC4 Encoding                               ║
║  Mip / Tile Generation                                  ║
║  Material Table                                         ║
║  Dependency Graph                                       ║
║  Bootstrap Set                                          ║
║  Content Hash / Cook Recipe                             ║
╚══════════════════════════════════════════════════════════╝
                  │
                  ▼

 .oescene               .oegpack                 .oetpack
 bootstrap/index        geometry pages           texture pages/mips

======================================================================

                              RUNTIME

                          Load .oescene
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
        Root Geometry Pages              Texture Mip Tails
                │                             │
                └──────────────┬──────────────┘
                               ▼
                    FIRST MEANINGFUL FRAME
                               │
                               ▼
                       GPU DAG Traversal
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
      Resident            Missing Page          Texture Need
          │                    │                    │
          ▼                    ▼                    ▼
 Visible Meshlets      GPU Request Mask       Texture Feedback
          │                    │                    │
          │                    └─────────┬──────────┘
          │                              ▼
          │                    Streaming Scheduler
          │                              │
          │             ┌────────────────┼────────────────┐
          │             ▼                ▼                ▼
          │           HTTP Range        OPFS            Memory Cache
          │             │                │                │
          │             └────────────────┼────────────────┘
          │                              ▼
          │                         Worker Pool
          │                              │
          │                      Decode / Validate
          │                              │
          │                              ▼
          │                       Upload Staging
          │                              │
          └──────────────────────────────┼───────────────┐
                                         ▼               │
                                  GPU Residency           │
                                         │               │
                                         ▼               │
                              Address Table Publish       │
                                         │               │
                                         └───────────────┘
```

---

# 6. 生产资源格式：从 RuntimeAssetManifest V2 演进到 Stream Manifest V3

EEngine 当前 `RuntimeAssetManifestV2` 已经有非常好的基础字段：

- assetId
- cookerVersion
- recipeHash
- sourceProvenance
- dependencies
- requiredFeatures
- requiredLimits
- chunks
- byteOffset
- compressedBytes
- decodedBytes
- expectedResidentBytes
- checksum

这部分不推翻。

真正需要改变的是：

> 当前接口仍以“完整 ArrayBuffer 打开整个 package”为主要语义；Streaming 需要“小索引 + 外部大 pack + 独立 page byte range”。

建议新增：

```ts
interface SceneStreamManifestV3 {
  schemaVersion: 3;
  sceneId: string;
  cookerVersion: string;
  recipeHash: string;

  requiredFeatures: string[];
  requiredLimits: LimitRequirement[];

  geometryPacks: PackRecord[];
  texturePacks: PackRecord[];

  geometryPages: GeometryPageRecord[];
  texturePages: TexturePageRecord[];

  bootstrapGeometryPages: number[];
  bootstrapTexturePages: number[];

  hierarchyRootIds: number[];
  materialTableRange: ByteRange;
  sceneTableRange: ByteRange;
}
```

## 6.1 GeometryPageRecord

```ts
interface GeometryPageRecord {
  pageId: number;
  packId: number;

  compressedOffset: bigint;
  compressedBytes: number;
  decodedBytes: number;

  codec: "meshopt" | "meshopt+lz4" | "raw";

  parentPageId: number;
  lodLevel: number;
  flags: number; // ROOT / PINNED / ...

  bounds: QuantizedBounds;
  maxError: number;

  checksum: string;
}
```

## 6.2 Pack 原则

不要：

```text
1296 mesh -> 1296 .oeg files
```

而是：

```text
scene.geometry.0.oegpack
scene.geometry.1.oegpack
scene.texture.bc.oetpack
```

Pack 可以很大，但 Page 必须可以独立 Range 获取。

关键：

```text
Page 独立寻址
Page 独立校验
Page 独立解压
Page 独立上传
Page 独立 Evict
```

---

# 7. Native C++ Cooker：最终生产入口

## 7.1 工具结构

```text
oengine-asset-core/
│
├── import/
├── geometry/
│   ├── meshlet_builder
│   ├── lod_group_builder
│   ├── dag_builder
│   ├── bvh_builder
│   ├── geometry_quantizer
│   ├── geometry_page_builder
│   └── geometry_codec
│
├── texture/
│   ├── semantic_classifier
│   ├── deduper
│   ├── mip_generator
│   ├── bc_encoder
│   └── texture_page_builder
│
├── scene/
├── material/
├── pack/
├── hash/
└── cli/
```

生产路径：

```text
source asset
    ↓
oengine-cook native executable
    ↓
EEngine runtime packages
```

C++ 的价值不是仅仅“比 TS 快”，而是：

- 大数据集更低 GC 压力
- 更直接的内存控制
- 更容易使用 meshoptimizer native
- SIMD
- 并行 task system
- 更适合批量 texture encoding
- 更适合数十 GB 离线 Cook
- 同一算法可编译 WASM 用于开发工具

## 7.2 WASM 的定位

WASM 不是生产 Runtime 的默认 Cooker。

它用于：

```text
Editor / Dev import
用户拖入源模型
浏览器内调试 cooker
Cooker algorithm parity test
```

Native 与 WASM 必须共享：

```text
同一 recipe
同一 page ABI
同一 hierarchy ABI
同一 hash 规则
```

---

# 8. Geometry Cooker：Nyx 移植核心

Geometry Cook 流程定为：

```text
Source Primitive
      ↓
Canonicalize
      ↓
Content Dedup
      ↓
Vertex Cache / Fetch Optimization
      ↓
Attribute Quantization
      ↓
Build Meshlets
      ↓
Group Meshlets
      ↓
Simplify Group
      ↓
Regroup simplified clusters
      ↓
Repeat until root
      ↓
Continuous LOD DAG
      ↓
BVH8 / traversal metadata
      ↓
Page Packing
      ↓
Meshopt Encode
      ↓
Optional LZ4 outer compression
```

## 8.1 Meshlet 参数

不盲目复制 Nyx 的 `128 verts / 128 triangles`。

EEngine 当前和 WebGPU 执行模式不同，应 benchmark：

```text
64 verts / 128 tris
64 verts / 124 tris
96 verts / 128 tris
128 verts / 128 tris
```

重点测：

- meshlet occupancy
- Vertex Pulling bandwidth
- culling efficiency
- indirect instance count
- subgroup efficiency
- page packing waste
- raster under-fill cost

## 8.2 Continuous LOD

每个 group 存：

```text
bounds
error
children
parent / parent range
pageId
```

运行时根据屏幕误差：

```text
screenError ~= objectSpaceError * projectionScale / distance
```

选择恰好满足阈值的 LOD cut。

必须保证：

```text
当前被渲染的一组 cluster
在任意时刻都构成合法、不重叠的 LOD cut
```

## 8.3 Conservative Error

LOD Error 必须是 conservative 的。

禁止为了减少 metadata 而引入可能低估误差的近似。

原因：

```text
低估 Error -> 错误地选择过低 LOD -> 可见 popping / silhouette error
```

---

# 9. Geometry Page 设计

## 9.1 初始 Page Size

沿用 Nyx 经过实战验证的起点：

```text
Decoded Geometry Page = 256 KiB
```

但 ADR 明确规定：

> 256 KiB 是初始 profile，不是永恒 ABI。

Benchmark 需要比较：

```text
64 KiB
128 KiB
256 KiB
512 KiB
```

权衡：

```text
Page 越小：
+ 请求精细
+ 少加载无用数据
- metadata 增大
- Range request 更碎
- decode/upload 调度压力大

Page 越大：
+ sequential throughput 高
+ request 数量少
- over-fetch 增大
- residency 粒度粗
```

## 9.2 Page 内数据布局

建议 SoA Block：

```text
GeometryPage
│
├── Header
├── Meshlet Descriptors
├── Quantized Positions
├── Meshlet Vertex References
├── Meshlet Triangle Micro-indices
├── Normals/Tangents
├── UV0
├── UV1
├── Optional Vertex Color
└── Local metadata
```

原因：

Visibility Raster 只需要：

```text
position + triangles
```

Shading Resolve 才读取：

```text
normal/tangent/uv/material attributes
```

SoA 可显著降低 Visibility pass 无意义 attribute bandwidth。

## 9.3 Geometry Quantization

建议继续延续 EEngine 现有 compact profile，并进一步统一为 GPU-native layout：

```text
Position : unorm16x3 relative to mesh/page AABB
Normal   : octahedral snorm16x2
Tangent  : octahedral + sign bit
UV       : f16x2 or quantized unorm16x2 + scale/bias
Color    : unorm8x4
Indices  : meshlet-local u8 / packed u32
```

位置解码：

```text
position = pageMin + quantized * pageExtent
```

避免 Runtime requantization。

---

# 10. Geometry Compression 决策

生产格式不直接使用原始 Float32 vertex buffers。

建议两层编码：

```text
Quantized GPU Layout
      ↓
meshoptimizer geometry/meshlet encoding
      ↓
可选 LZ4 page supercompression
```

选择逻辑在 Cooker 离线决定：

```text
if LZ4 gain < threshold:
    store meshopt only
else:
    store meshopt + LZ4
```

理由：

- meshoptimizer 保留 GPU-friendly ordering
- meshlet codec 支持独立 meshlet 编码
- native decoder 吞吐很高
- 浏览器 WASM decoder 也有很高吞吐
- meshoptimizer 还提供 GPU meshlet decoder 示例，可作为后续 GPU decode R&D

不要把 Draco 作为 Runtime 主 codec。

---

# 11. Root Page Pinning：必须原样吸收 Nyx 的关键机制

每个独立虚拟几何对象必须有可永久渲染的 coarse representation。

```text
root geometry pages
       ↓
startup load
       ↓
PINNED
       ↓
never evicted during scene lifetime
```

这样任何高 LOD page 缺失时，都可以退回最近 resident ancestor。

关键不变量：

```text
Missing high LOD != missing geometry
```

而是：

```text
Missing high LOD -> render resident ancestor + request desired page
```

这直接解决 Streaming latency 导致的洞/闪烁问题。

---

# 12. WebGPU 版 Geometry Virtual Addressing

Nyx 的：

```text
GroupID -> ChunkIndex + ByteOffset
```

在 EEngine 中升级为：

```text
Logical Group / Page ID
          ↓
GeometryPageTable
          ↓
PhysicalHeapBank + Slot
          ↓
Physical GPU byte offset
```

推荐 GPU entry：

```wgsl
struct GpuPageAddress {
    physicalPage : u32,
    generation   : u32,
};
```

`physicalPage` 可以进一步拆成：

```text
bankIndex
slotIndex
resident flag
```

CPU 维护完整状态，GPU 表只保留 Shader 真正需要的信息。

---

# 13. WebGPU Geometry Heap：不要原样复制 Nyx 256 MB GPU Chunk

Nyx 使用 256 MB GPU Chunk。

WebGPU 2026 的默认保证中：

```text
maxStorageBufferBindingSize = 128 MiB
maxBufferSize               = 256 MiB
```

因此 EEngine 不应该把 Nyx 的 256 MB chunk 常量直接照搬到 Shader 绑定模型。

建议使用：

```text
Geometry Heap Bank 0 : 128 MiB
Geometry Heap Bank 1 : 128 MiB
Geometry Heap Bank 2 : 128 MiB
Geometry Heap Bank 3 : 128 MiB
```

形成：

```text
512 MiB decoded geometry residency budget
```

具体 Bank 数量由 HighPerf Required Limits 决定。

每个 128 MiB Bank、256 KiB Page 时：

```text
512 physical page slots / bank
```

4 Bank：

```text
2048 resident geometry pages
```

实际内存目标必须通过 benchmark 重新调整。

---

# 14. WebGPU 版 DispatchMesh 替代：核心设计

这是 Nyx -> EEngine 最重要的 API 层改写。

## 14.1 不采用“一 Meshlet 一个 drawIndirect”

WebGPU 没有标准 MultiDrawIndirect 能让 GPU 自己发任意数量 Draw。

如果 CPU 每帧 encode 数千次 `drawIndirect()`，会破坏 GPU-driven 的意义。

## 14.2 采用“一 Raster Class 一个 Instanced Indirect Draw”

核心方式：

```text
Compute culling
      ↓
VisibleMeshletList[]
      ↓
IndirectArgs.instanceCount = visibleMeshletCount
      ↓
ONE drawIndirect()
```

Draw：

```text
vertexCount   = MAX_TRIANGLES_PER_MESHLET * 3
instanceCount = visibleMeshletCount
```

Vertex Shader：

```text
instance_index -> VisibleMeshletList[instance_index]
vertex_index   -> meshlet-local triangle corner
```

每个 instance 就是一个 Meshlet。

不足 `MAX_TRIANGLES` 的尾部 vertex invocations：

```text
输出 clipped position / degenerate primitive
```

Cooker 应最大化 Meshlet occupancy，降低这部分浪费。

## 14.3 primitive-index 的关键价值

Fragment Shader：

```wgsl
@builtin(primitive_index) primitiveId : u32
```

由于 primitive index 每个 instance 重新从 0 开始：

```text
primitiveId == meshlet-local triangle index
```

因此 Visibility Buffer 不需要额外传递 Triangle ID。

只需要 Vertex Shader flat 输出：

```text
visibleMeshletRecordIndex
```

Fragment：

```text
Visibility = visibleMeshletRecordIndex + primitive_index
```

---

# 15. Visibility Buffer 编码建议

推荐尽量压到单个 `R32Uint`：

```text
[ visibleRecord : 24 bits ][ primitiveId : 8 bits ]
```

因为 Meshlet Triangle 数量 <= 255。

这样单像素：

```text
4 bytes Visibility
+ Depth
```

而不是使用传统大 GBuffer 在几何阶段输出：

```text
normal
baseColor
roughness
metallic
uv
...
```

Resolve 阶段：

```text
Visibility ID
      ↓
VisibleMeshletRecord
      ↓
Instance
Group/Page Address
Material
      ↓
Pull triangle attributes
      ↓
PBR shade
```

如果当前 EEngine 的 Visibility ABI 已经有更优编码，则以现有 ABI 为基础扩展，不强制重写。

---

# 16. Raster Class：只做极少数 Draw

不要按 Material 分 Draw。

Material 在 Visibility Resolve 读取。

Raster 只按真正会改变 Raster State 的类型分组：

```text
Opaque + Backface Cull
Opaque + Double Sided
Alpha Mask + Backface Cull
Alpha Mask + Double Sided
```

理想情况下：

```text
2~4 个 indirect raster calls / major view
```

而不是：

```text
数千 Mesh / Material draw calls
```

透明 Blend Geometry 不进入第一版 Virtual Geometry 主路径，单独维护透明渲染系统。

---

# 17. GPU Culling / LOD Pipeline

推荐完整 GPU pipeline：

```text
1. Instance Cull
2. Hierarchy/DAG Traversal
3. Frustum Cull
4. Previous-frame HZB Cull
5. Projected Error LOD Select
6. Residency Check
7. Missing -> Streaming Request
8. Missing desired LOD -> select resident ancestor
9. Visible Meshlet Append
10. Bucket by Raster Class
11. Build indirect args
12. Hardware Raster
13. Build current HZB
14. Optional late/second-pass visibility
```

## 17.1 Subgroups

2026 WebGPU 的 `subgroups` 应用于：

- ballot
- local compaction
- prefix allocation
- visible meshlet append
- request mask aggregation
- hierarchy traversal work distribution

目标：

```text
减少 global atomics
减少 workgroup shared-memory traffic
减少空 lane
```

## 17.2 subgroup-size-control

如果目标 Adapter 支持，可针对实际 GPU benchmark 固定：

```text
32
或
64
```

但算法正确性不依赖固定 subgroup size。

---

# 18. GPU Streaming Request Feedback

Nyx 的 Request Mask 思路保留。

GPU：

```text
if desiredPage is non-resident:
    atomicOr(requestMask[word], bit)
```

CPU/Worker 不需要每帧同步等待。

建议使用 3~4 个 Readback Ring：

```text
Frame N     GPU writes mask A
Frame N+1   GPU writes mask B
Frame N+2   map/read mask A
```

绝对禁止：

```text
每帧 await GPU readback
```

这会形成 CPU/GPU synchronization point。

## 18.1 Request Priority

GPU 只负责：

```text
告诉 CPU “哪些 Page 被需要”
```

CPU/Streaming Worker 根据 Page metadata + 当前 Camera 重新计算优先级：

```text
Priority =
  visibility urgency
  + projected error
  + distance
  + request age
  + prediction
  + dependency readiness
```

避免为每个 Page 在 GPU 维护昂贵的 32-bit priority buffer。

---

# 19. Streaming Scheduler

Current `RuntimeAssetResidencyState` 已经很好地限定了自己的责任：

```text
request/resident/retiring + budget seam
```

它不应该膨胀成巨型 God Object。

新增独立：

```text
StreamingScheduler
```

负责：

```text
GPU feedback
request dedup
priority
IO batching
cache lookup
worker dispatch
upload budget
retirement
cancellation
```

## 19.1 优先级层次

建议：

```text
P0  Bootstrap / Root / camera-critical
P1  Visible missing pages
P2  Near-visible / high projected error
P3  Predicted camera path preload
P4  Background quality refinement
```

## 19.2 状态机

```text
Absent
  ↓
Queued
  ↓
Fetching / CacheRead
  ↓
CompressedReady
  ↓
Decoding
  ↓
ReadyToUpload
  ↓
Uploading
  ↓
Resident
  ↓
RetirePending
  ↓
Absent
```

每次 Request 携带：

```text
pageId
generation
priority
AbortSignal
estimatedBytes
```

防止旧请求在 Camera 已改变后继续污染 residency。

---

# 20. HTTP Range Streaming

运行时禁止：

```text
fetch entire 1GB pack
```

只请求：

```http
Range: bytes=start-end
```

## 20.1 Request Coalescing

不能简单做到：

```text
每 256 KiB Page 一个 HTTP 请求
```

Scheduler 应把临近 Page 合并：

```text
requested pages:
17,18,19,22

=> range 17~19
=> range 22
```

可基于：

```text
max coalesced bytes
max gap bytes
priority equality
```

进行合并。

建议 benchmark：

```text
512 KiB
1 MiB
2 MiB
4 MiB
```

作为 Range 聚合上限。

## 20.2 Cook-time 排列

Pack 内 Page 不是随机排序。

优先：

```text
bootstrap/root pages
coarse LOD
parent/child locality
spatial locality
high probability co-request groups
```

这样 Range coalescing 才有效。

---

# 21. OPFS Persistent Cache

高性能 Web 部署要求 Dedicated IO Worker 使用 OPFS。

结构：

```text
/opfs/eengine-cache/
    packHash/
        index
        page-cache.bin
```

Cache key：

```text
packHash + pageId + codecVersion
```

推荐：

```text
Dedicated Worker
    ↓
FileSystemSyncAccessHandle
    ↓
random read/write
```

OPFS 只作为 Persistent Cache，不作为 canonical source。

Source of truth 仍是：

```text
immutable CDN pack
```

## 21.1 Cache Policy

采用：

```text
content addressed
size bounded
LRU/segmented LRU
pack-version invalidation
```

缓存已经校验过的 Page 时保存 hash/version metadata，避免每次启动重复昂贵验证。

---

# 22. Worker / WASM 架构

EEngine 当前 `AssetWorkerPool` 已具备：

- maxWorkers
- priority queue
- max in-flight estimated bytes
- transfer list
- cancellation
- worker failure tracking

不重写这部分理念。

升级为：

```text
StreamingWorkerPool
├── IO Worker
├── Geometry Decode Workers
├── Texture Decode/Pack Workers
└── Hash/Validation workers
```

## 22.1 Main Thread 的唯一职责

Main/Render thread 只做：

```text
GPU resource ownership
command encoding
queue submission
small scheduler coordination
stable handle publication
```

禁止：

```text
large JSON parse
PNG/JPEG decode
large typed-array clone
geometry simplification
meshlet build
large hash
LZ4/meshopt bulk decode
```

## 22.2 SharedArrayBuffer

极限部署可以要求 cross-origin isolation：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

用于：

```text
Shared WebAssembly.Memory
threaded WASM
shared task queues
```

但 Runtime page output 最终仍建议以 Transferable ArrayBuffer 或可直接 upload 的 staging block 交给 Render thread，避免复杂共享 ownership。

---

# 23. Geometry Decode：CPU/WASM 与 GPU Compute 的最终关系

不要一开始就假定 GPU decode 一定更快。

本架构把 codec 与 residency ABI 解耦：

```text
Compressed Page
      ↓
PageDecoder interface
      ↓
Decoded canonical GPU page
      ↓
Residency
```

第一生产实现：

```text
WASM SIMD / native-derived decoder
```

原因：

- 技术成熟
- Debug 简单
- meshoptimizer decoder 极快
- GPU 不需要为解压增加额外同步/dispatch

但保留高级路径：

```text
Compressed bytes -> GPU upload -> Compute decode -> Geometry Heap
```

GPU decode 只有在 benchmark 证明：

```text
CPU decode + transfer > GPU decode overhead
```

时成为默认。

必须以 timestamp-query + CPU wall time 证据决定，不能凭直觉。

---

# 24. Texture：生产路径完全重构

当前 EEngine 已有正确的 semantic codec policy：

```text
baseColor/emissive -> BC7 sRGB
normal             -> BC5
occlusion/mask     -> BC4
ORM                -> BC7/BC3
```

最终生产路径直接离线输出 GPU-native block-compressed 数据。

## 24.1 不再默认 Runtime Basis Transcode

生产目标：

```text
Cooker
  ↓
BC7 / BC5 / BC4
  ↓
.oetpack
  ↓
Range fetch
  ↓
GPU upload
```

而不是：

```text
Basis
  ↓
WASM transcode
  ↓
BC
  ↓
GPU
```

KTX2/Basis 保留用于：

- Editor import
- asset pipeline 中间格式
- 非生产工具

不是主热路径。

---

# 25. Texture Content Dedup

Dedup 必须发生在 Offline Cooker。

```text
Decode/source hash
      ↓
identical content detection
      ↓
canonical TextureAssetId
      ↓
all materials remap to same physical texture
```

不能依赖 Runtime ImageBitmap object identity。

对于 Bistro 这类大量重复图片的场景，这是最直接的：

```text
network bytes reduction
CPU decode reduction
GPU upload reduction
GPU memory reduction
```

四重收益。

---

# 26. Texture Streaming：两种性能资产类型，而不是兼容路径

这是内容类型 specialization，不是硬件 fallback。

## 26.1 Streamed Mip Texture

适合：

```text
常规 1K/2K/4K PBR texture
```

离线保存：

```text
Mip Tail
Mip 256
Mip 512
Mip 1024
Mip 2048
...
```

启动只加载 Mip Tail。

## 26.2 Virtual Tiled Texture

适合：

```text
超大 texture
独特 mega texture
高分辨率 terrain/scan/material atlas
```

结构：

```text
Virtual Texture Address
        ↓
Page Table
        ↓
Physical BC Tile Atlas
```

只有当场景资产确实需要时，Cooker 才选择 Virtual Tile 类型。

不会因为“终极”而把所有 2K texture 强行放进软件 VT，从而支付不必要的 indirection 成本。

---

# 27. Texture Mip Tail Pinning

与 Geometry Root Page 相同，Texture 也必须有始终可采样的最低质量表示。

```text
Mip Tail
   ↓
bootstrap load
   ↓
PINNED
```

因此：

```text
高 mip 不 resident
!=
黑贴图/未定义采样
```

而是：

```text
采样较低 mip + 请求高 mip
```

Alpha Mask Texture 的 Mip Tail 属于 geometry publication dependency：

```text
alpha mask minimum mip 未 resident
=> 相关 alpha-tested geometry page 不发布为 renderable
```

避免 streaming 期间错误遮挡。

---

# 28. Material 与 Texture Handle

Material 不保存物理 GPU Texture 的临时对象引用。

Material 保存：

```text
TextureHandleID
```

TextureHandleTable：

```text
logical texture
    ↓
resident physical allocation
resident min mip / tile table
format class
sampler class
```

Streaming 只更新：

```text
Handle Table / Page Table
```

Material 本身不重建。

---

# 29. First Meaningful Frame：必须成为一等目标

生产 Scene Cook 时明确生成：

```text
Bootstrap Set
```

至少包含：

- Scene transform/instance metadata
- Material metadata
- Hierarchy roots
- Root Geometry Pages
- Texture Mip Tails
- Environment/bootstrap lighting asset

启动语义：

```text
Bootstrap ready
    ↓
FIRST FRAME
```

而不是：

```text
Entire scene ready
    ↓
FIRST FRAME
```

建议 Bistro 第一阶段目标：

> 第一可用画面前网络数据量控制在原始资源的很小比例，并通过 benchmark 把 Bootstrap 尽量压缩至几十 MB 以内，而不是接近 1 GB。

具体预算以画质/网络测试决定，不在 ADR 中伪造固定绝对值。

---

# 30. Residency Eviction

不能使用简单纯 LRU。

推荐：

```text
Pinned root set
+
segmented LRU / 2Q-like policy
+
frame hysteresis
+
minimum residency age
+
request frequency
```

Page score 示例：

```text
EvictionScore =
    age
  - recentVisibilityWeight
  - parentImportance
  - predictedUseWeight
  + memoryPressure
```

禁止：

```text
本帧刚加载 -> 下帧就因为 Camera 抖动被驱逐
```

加入：

```text
cooldown / hysteresis window
```

减少 page thrashing。

---

# 31. Adaptive Streaming Budget

极致 Streaming 不等于后台线程全速跑满。

真正目标是：

> **在不破坏当前 frame budget 的前提下，最大化质量收敛速度。**

Scheduler 每帧读取：

```text
GPU frame time
streaming compute time
upload time
queue depth
worker pressure
resident memory pressure
```

动态调整：

```text
max upload bytes/frame
max decode bytes/frame
request issue count
prefetch depth
```

例如：

```text
GPU 11 ms / 16.7 ms
=> 可以积极 streaming

GPU 16 ms / 16.7 ms
=> throttle upload/decode GPU work
```

---

# 32. Upload Pipeline

不要每个 Page 产生大量小 `queue.writeBuffer()`。

建议：

```text
Decoded page jobs
       ↓
UploadBatchBuilder
       ↓
large staging region
       ↓
copyBufferToBuffer
       ↓
Geometry Heap slots
```

每帧：

```text
一个或少量 staging buffers
一个 command encoder
批量 copies
```

上传完成后才：

```text
publish page table entry
```

避免 Shader 看到“已标记 resident，但 GPU copy 尚未完成”的半状态。

---

# 33. Page Publication 的原子语义

CPU 状态：

```text
Decoded
  ↓
Upload submitted
  ↓
GPU-visible data valid
  ↓
Address Table publish
  ↓
Resident
```

逻辑上必须保证：

```text
PageTable.resident == true
=> 所有该 page 依赖的数据都已经可安全读取
```

同样，Evict：

```text
remove logical address
      ↓
wait safe frame/fence-equivalent lifetime
      ↓
return physical slot to free pool
```

避免 use-after-recycle。

---

# 34. Generation ID 防止 Stale Request

Camera 快速移动时：

```text
Page A requested
用户转头
Page A 不再需要
但网络回包晚到
```

每个 Request 带：

```text
requestGeneration
```

完成时：

```text
if generation != current desired generation
    discard / cache only
```

防止旧请求把热 Page 从 residency budget 中挤出去。

---

# 35. Two-Pass HZB 移植

建议吸收 Nyx 的两阶段思想：

## Pass A

使用上一帧 HZB：

```text
Cull obvious invisible
Render stable visible set
```

## HZB rebuild

基于当前 depth 生成新 HZB。

## Pass B

处理：

```text
previously uncertain / newly revealed clusters
```

这样 Camera 快速变化时降低 previous-frame HZB 误判。

需要 benchmark Pass B 的收益与额外 compute/raster 成本。

---

# 36. Microtriangle：最终可扩展 Software Raster Lane

`nanite-webgpu` 已证明 WebGPU 中对大量微小三角形做软件 Raster 是可行的，并在其场景中具有很高比例。

EEngine 最终架构预留：

```text
Projected triangle size
        ↓
Classifier
   ┌────┴────┐
   ▼         ▼
HW Raster   SW Raster Compute
```

第一生产版本不强制实现 Software Raster。

原因：

- 当前最重要收益来自 virtual geometry + streaming
- WebGPU 缺少完整 Mesh Shader 生态
- SW raster 对 atomic/depth packing 设计要求高
- 必须 benchmark 才能确定 crossover threshold

但数据 ABI 不应阻止未来加入。

---

# 37. EEngine 现有系统如何复用

## 37.1 RuntimeAssetManifestV2

保留：

- Asset identity
- Recipe identity
- feature/limit validation
- checksums
- expected resident bytes

演进：

```text
whole-package semantics
->
stream-index + external page packs
```

## 37.2 RuntimeAssetResidencyState

保留其 bounded seam：

```text
unrequested/requested/resident/retiring
budget reservation
physical range publication
device loss reset
```

不要把 IO/Scheduler 塞进去。

## 37.3 AssetWorkerPool

直接升级使用：

- priority
- memory admission control
- cancellation
- transfer ownership
- failure telemetry

## 37.4 TextureAssetPackage / Codec Policy

保留 semantic 定义和 GPU compressed format 体系。

但生产 Runtime 默认：

```text
GPU-ready BC package
```

而不是 Browser Basis transcode。

## 37.5 Geometry Cooker

保留当前：

- deterministic recipe
- meshoptimizer
- compact position profile
- hierarchy/BVH 思路
- package evidence

算法实现逐渐迁到 C++ shared core。

---

# 38. 当前 GltfLoader 的最终定位

`GltfLoader` 从：

```text
Runtime production loader
```

降级为：

```text
Tooling / Import / Developer utility
```

生产 bundle 不需要为了：

```text
Draco
EXT_meshopt_compression
KHR_texture_basisu
```

继续堆 Runtime compatibility decoder。

这些 Authoring 格式支持由 Native Cooker 解决。

Production Runtime 只认识：

```text
EEngine Stream Manifest + Pack ABI
```

---

# 39. 推荐 Runtime 模块拆分

```text
OEngine/src/assets/streaming/
│
├── SceneStreamManifest.ts
├── PackIndex.ts
├── PageTypes.ts
│
├── StreamingScheduler.ts
├── StreamingPriority.ts
├── StreamingBudgetController.ts
│
├── RangeRequestPlanner.ts
├── HttpRangeSource.ts
├── OpfsPageCache.ts
│
├── StreamingWorkerPool.ts
├── GeometryPageDecoder.ts
├── TexturePageDecoder.ts
│
├── GeometryResidencyManager.ts
├── TextureResidencyManager.ts
├── GeometryPageTable.ts
│
├── GpuFeedbackReader.ts
├── GpuRequestMask.ts
│
└── StreamingEvidence.ts
```

GPU：

```text
OEngine/src/renderer/virtual-geometry/
│
├── VirtualGeometryPass.ts
├── HierarchyCullPass.ts
├── VisibleMeshletCompaction.ts
├── GeometryRequestPass.ts
├── VirtualGeometryRaster.ts
├── VirtualGeometryResolve.ts
└── shaders/
```

---

# 40. GPU Data Tables

建议统一 GPU Scene ABI：

```text
InstanceTable
HierarchyNodeTable
GroupTable
PageTable
VisibleMeshletTable
MaterialTable
TextureHandleTable
```

尽量全部使用稳定整数 ID：

```text
InstanceID
GroupID
PageID
MaterialID
TextureID
```

避免 Runtime JS 对象引用进入 GPU 热路径。

---

# 41. VisibleMeshletRecord

示意：

```wgsl
struct VisibleMeshletRecord {
    instanceId : u32,
    groupId    : u32,
    meshletId  : u32,
    materialId : u32,
};
```

如果 metadata 可由 `groupId + meshletId` 推导，进一步压缩：

```text
8 bytes / record
甚至 4 bytes packed
```

目标不是 API 优雅，而是：

```text
低 bandwidth
低 storage footprint
高 cache density
```

---

# 42. Page Request 与 Prefetch

仅靠 GPU 缺页反馈会天然有 2~数帧 latency。

必须增加预测。

CPU/Worker 使用：

```text
camera velocity
angular velocity
frustum expansion
recent request history
LOD gradient
```

形成：

```text
Predicted Frustum
```

预取即将进入视野的 Page。

原则：

```text
真实 GPU request > predicted request
```

预测请求可随时 Abort。

---

# 43. Scene Startup 排序

Cooker 应生成专门 bootstrap pack order：

```text
1. manifest/index
2. hierarchy roots
3. root geometry
4. low mip texture tails
5. near-root refinement
6. remaining pages
```

这比运行时拿随机 hash 顺序请求 Page 更快。

Bootstrap 应尽量：

```text
少 Range
连续字节
高压缩
低 decode cost
```

---

# 44. Build Cache / Incremental Cook

内容寻址：

```text
SourceContentHash
+
CookRecipeHash
+
TargetProfile
=
CookKey
```

改变一个 Texture 不应导致整个 Scene 所有 Geometry 重 Cook。

Cooker 输出：

```text
geometry asset cache
texture asset cache
material cache
scene manifest cache
```

最后 Pack 阶段做 link。

类似编译器：

```text
Compile assets
     ↓
Link scene package
```

---

# 45. Determinism

同一：

```text
source bytes
recipe
cooker version
```

必须产生：

```text
稳定 Asset IDs
稳定 page ordering
稳定 package hashes
```

意义：

- CDN immutable cache
- OPFS cache reuse
- regression testing
- binary diff
- reproducible benchmarks

当前 EEngine CookRecipe 的 deterministic 思路必须继续保持。

---

# 46. Device Loss

Logical Scene State 与 Physical GPU Residency 必须彻底分离。

Device loss：

```text
physical residency invalid
```

但：

```text
Scene Manifest
Page Cache
OPFS Cache
Logical handles
```

仍然有效。

重建流程：

```text
new GPUDevice
    ↓
recreate heap/table
    ↓
bootstrap pages
    ↓
re-stream hot set
```

现有 `RuntimeAssetResidencyState.resetAfterDeviceLoss()` 的方向正确，应继续作为底层 seam。

---

# 47. Streaming Telemetry / Evidence

所有优化必须可测。

新增统一 `StreamingEvidence`：

```ts
interface StreamingEvidence {
  frame: number;

  requestedPages: number;
  residentPages: number;
  pageMisses: number;
  evictions: number;
  thrashes: number;

  networkBytes: number;
  cacheHitBytes: number;
  decodedBytes: number;
  uploadedBytes: number;

  workerMs: number;
  mainThreadMs: number;
  gpuUploadMs: number;

  geometryResidentBytes: number;
  textureResidentBytes: number;

  firstMeaningfulFrameMs: number;
  fullQualityMs: number;
}
```

---

# 48. 性能 KPI

必须正式加入 Benchmark Dashboard：

## Loading

```text
TTFMF - Time To First Meaningful Frame
TTI   - Time To Interactive
Time To Full Quality
Bootstrap Bytes
Cold Cache Bytes
Warm Cache Bytes
```

## CPU

```text
Main-thread long tasks
Scheduler CPU ms
Worker CPU ms
Decode throughput GB/s
Peak JS heap
Peak Worker/WASM memory
```

## GPU

```text
Cull ms
LOD traversal ms
Visibility raster ms
Resolve/shading ms
Upload ms
Resident geometry bytes
Resident texture bytes
```

## Streaming

```text
Page hit rate
Page miss rate
Request latency
Range coalescing ratio
OPFS hit rate
Eviction count
Thrash rate
Average page lifetime
Unused fetched bytes
```

---

# 49. Benchmark 场景

至少固定：

```text
Small sanity scene
BistroExterior
Jinx
Zorah / extreme stress scene
```

每个场景测：

```text
cold CDN
warm HTTP cache
warm OPFS
stationary camera
high-speed flythrough
teleport camera
memory pressure
```

对照组：

```text
A. 当前 raw GLB path
B. 当前 pre-cooked geometry path
C. 新 V3 streaming + WASM decode
D. GPU decode experiment
```

---

# 50. 第一阶段性能预算建议

这些是工程预算，不是对所有设备承诺：

```text
Main-thread asset work:
    average < 0.5 ms/frame
    p95     < 1.0 ms/frame

Streaming Scheduler:
    < 0.25~0.5 ms/frame target

GPU request readback:
    asynchronous ring only
    zero same-frame waits

GPU upload:
    adaptive frame budget

Page decode:
    Worker only
```

任何超过预算的场景，优先：

```text
降低后台 quality convergence speed
```

而不是破坏 frame time。

---

# 51. Bistro 的目标行为

当前 Bistro 是一个接近 1 GB 的单体 GLB。

最终 Runtime 不再关心：

```text
这个 GLB 有 988 MiB
```

Runtime 只关心：

```text
Bootstrap 有多少 MB
当前相机需要哪些 Geometry Page
当前屏幕需要哪些 Texture Mip/Tile
GPU residency 当前是多少
```

启动：

```text
.oescene
 + root pages
 + mip tails
       ↓
立即出现完整 coarse scene
```

用户靠近建筑：

```text
GPU LOD error ↑
     ↓
request high-detail pages
     ↓
background fetch/decode/upload
     ↓
next frames detail improves
```

用户转头：

```text
旧请求 cancel
新 visible pages priority ↑
```

这才是对 1 GB/10 GB/100 GB 内容规模都可扩展的模型。

---

# 52. Nyx -> EEngine 源码级迁移映射

| Nyx | EEngine 目标 | 处理方式 |
|---|---|---|
| `.gltf/.glb -> .mini` builder | Native C++ `oengine-cook` | 移植算法，换输出 ABI |
| Meshlet build/group | EEngine Geometry Cooker | 直接移植/结合 meshoptimizer |
| Iterative group simplify | Continuous LOD DAG | 直接移植核心逻辑 |
| DAG/BVH | EEngine hierarchy/BVH | 与现有 BVH8 融合 |
| 256 KB Geometry Page | EEngine Geometry Page | 作为初始 benchmark profile |
| Root Page Pinning | Bootstrap pinned roots | 直接移植 |
| Page Residency | GeometryResidencyManager | 直接移植状态思想 |
| GroupDataLocation | GeometryPageTable | 改成 WebGPU physical page address |
| GPU Request Mask | GpuRequestMask | 直接移植思想 |
| Triple Readback | WebGPU readback ring | 直接移植 |
| Async IO thread | IO Dedicated Worker | Web 平台替换 |
| LZ4 Page | meshopt + optional LZ4 | EEngine 增强 |
| 256 MB GPU Chunk | 128 MiB-class heap banks | 适配 WebGPU limits |
| DispatchMesh | instanced `drawIndirect` | WebGPU 核心替换 |
| Mesh Shader | vertex pulling / future SW raster | WebGPU 核心替换 |
| Visibility Buffer | EEngine Visibility Buffer | 深度融合现有 renderer |

---

# 53. 实施阶段

## Stage 0 — Freeze Architecture + Benchmark Harness

完成：

- HighPerf-2026 capability contract
- benchmark scenes
- TTFMF/streaming telemetry
- page size experiment harness

## Stage 1 — Stream Manifest V3

完成：

- `.oescene`
- `.oegpack`
- `.oetpack`
- Range-index ABI
- independent checksums
- bootstrap page list

## Stage 2 — Native C++ Geometry Cooker

移植：

- Nyx meshlet grouping
- simplification loop
- DAG/BVH
- root pages
- page builder

对接：

- meshoptimizer
- current CookRecipe semantics

## Stage 3 — Geometry Residency

完成：

- fixed GPU heap banks
- physical free pool
- PageTable
- pin root pages
- safe publication/eviction

## Stage 4 — GPU Feedback Streaming

完成：

- request bitset
- readback ring
- scheduler
- Range fetch
- request cancel
- priority

## Stage 5 — WebGPU Nyx Raster Backend

完成：

- GPU hierarchy traversal
- visible meshlet list
- raster buckets
- indirect args
- instanced vertex pulling
- primitive-index visibility

## Stage 6 — Texture Production Pipeline

完成：

- offline content dedup
- BC7/BC5/BC4 cook
- mip tail
- streaming mips
- stable texture handle

## Stage 7 — OPFS Cache

完成：

- persistent compressed page cache
- content-addressed lookup
- bounded eviction

## Stage 8 — Advanced R&D

Benchmark 驱动：

- GPU geometry decompression
- software microtriangle raster
- virtual tiled texture
- predictive streaming model

---

# 54. 最重要的工程原则

## 原则 1

> **Source Format != Runtime Format**

## 原则 2

> **Runtime Asset != JavaScript Object Graph**

## 原则 3

> **Geometry/Texture 都必须是可独立 Residency 的虚拟资源。**

## 原则 4

> **Missing detail 必须退化到 resident representation，而不是阻塞或消失。**

## 原则 5

> **任何大 CPU 工作不得进入 Main Thread。**

## 原则 6

> **任何 Streaming 都不得通过同步 GPU Readback 阻塞 Frame。**

## 原则 7

> **GPU Address Stable，Physical Residency 可变。**

## 原则 8

> **Cooker 为 Runtime 性能服务，不为源文件“原样保存”服务。**

## 原则 9

> **压缩率不是唯一目标；Decode latency、GPU-ready layout、随机访问粒度同等重要。**

## 原则 10

> **所有“极致优化”都必须通过 Evidence/Benchmark 证明。**

---

# 55. 最终目标形态

当这套架构完成后，EEngine 不再是：

```text
WebGPU renderer + glTF loader
```

而是：

```text
GPU-driven WebGPU renderer
+
Native Asset Compiler
+
Virtual Geometry System
+
Virtualized Texture/Streaming System
+
Demand-driven Residency
+
Persistent Web Asset Cache
```

在几何方向上，整体思想接近：

```text
Nanite theory
    +
Nyx open-source implementation
    +
WebGPU-native execution backend
```

但最终并不是“WebGPU 版 Nyx clone”。

EEngine 会保留自己的优势：

- 现有 Visibility Buffer / shading architecture
- 现有 Runtime Asset ABI 思路
- 现有 deterministic CookRecipe
- 现有 AssetWorkerPool
- 现有 texture codec/residency
- WebGPU 2026 `primitive-index`
- WebGPU subgroups
- Web 环境 Range/OPFS/WASM 的独特 Streaming 能力

最终形成：

> **为 WebGPU 约束重新设计的 Virtualized GPU-Driven Engine Asset Architecture。**

---

# 56. ADR 最终决策摘要

**接受：**

- Nyx 作为 Virtual Geometry 主要算法移植基线。
- Native C++ Cooker 作为生产资产构建工具。
- GLB/glTF 退出 production runtime hot path。
- Geometry Page + root pinning + GPU feedback + residency address table。
- WebGPU Compute 替换 Task/Mesh Shader orchestration。
- 单/少量 instanced indirect draw 替换 DispatchMesh。
- `primitive-index` 作为 Meshlet 内 primitive identity。
- Subgroups 用于 culling/compaction。
- Offline GPU-native BC texture。
- Range Streaming + OPFS persistent cache。
- Adaptive frame-budget streaming。
- 未来 GPU decode / software raster / tiled virtual texture 作为同一 ABI 下的高级优化。

**拒绝：**

- Cesium 3D Tiles 架构。
- Legacy/low-end compatibility renderer。
- Production runtime raw GLB loading。
- “全部加载完成再首帧”。
- 大量 object-per-file HTTP requests。
- main-thread asset cooking/decode。
- 把 runtime Basis transcode 当最终生产主路径。

---

# 57. 参考资料

## EEngine

- Repository: https://github.com/bigbigbig2/EEngine
- Baseline commit: `cec226e6feb825ce4d682f97b1d966c8e71d0c6a`
- `RuntimeAssetManifestV2.ts`
- `RuntimeAssetResidency.ts`
- `AssetWorkerPool.ts`
- `TextureCodecPolicy.ts`
- `GltfLoader.ts`

## Nyx

- https://github.com/moonlovelj/Nyx
- Baseline commit: `bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b`
- `MiniEngine/Model/GeometryStreaming.cpp`

## Nanite / Cluster LOD

- Nanite: A Deep Dive — Brian Karis, SIGGRAPH Advances in Real-Time Rendering 2021
  https://advances.realtimerendering.com/s2021/Karis_Nanite_SIGGRAPH_Advances_2021_final.pdf
- NVIDIA `vk_lod_clusters`
  https://github.com/nvpro-samples/vk_lod_clusters
- `nanite-webgpu`
  https://github.com/Scthe/nanite-webgpu

## Compression

- meshoptimizer
  https://github.com/zeux/meshoptimizer
- Towards Practical Meshlet Compression
  https://arxiv.org/abs/2404.06359

## WebGPU / WGSL

- WebGPU Candidate Recommendation Draft, 20 Aug 2026
  https://www.w3.org/TR/webgpu/
- WGSL
  https://www.w3.org/TR/WGSL/
- Chrome WebGPU 151-152 subgroup size control
  https://developer.chrome.com/blog/new-in-webgpu-151-152

## Texture

- KTX 2.0 Specification
  https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html

## Browser Storage / Threads

- Origin Private File System
  https://web.dev/articles/origin-private-file-system
- SharedArrayBuffer / WebAssembly shared memory
  https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer

---

# 58. 下一份配套设计文档建议

本 ADR 定的是**最终总体架构**。

实现前建议继续拆成四份源码级设计：

1. **ADR-0016-A：Nyx Geometry Cooker → EEngine C++ Cooker 源码迁移设计**
2. **ADR-0016-B：Nyx GeometryStreaming → WebGPU Residency/Feedback 源码迁移设计**
3. **ADR-0016-C：WebGPU Mesh Shader Replacement — Instanced Indirect + primitive-index 设计**
4. **ADR-0016-D：GPU-native Texture Cooking / Mip Streaming / Virtual Texture 设计**

其中优先级最高的是 **B + C**：它们决定 Nyx 的 Virtual Geometry 是否真正与 EEngine 当前 GPU-driven renderer 融合，而不是仅仅做一个新的资源加载器。
