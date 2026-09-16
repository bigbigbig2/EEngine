# ADR-0016 研究母稿：Nyx × OEngine × WebGPU 2026 虚拟化资产与 GPU-driven 架构

- **文档状态**：Research Proposal Final / Non-authoritative
- **更新时间**：2026-09-16
- **OEngine 审查基线**：`81446a78ff8219259c2763622c29d348face16e9`
- **Nyx 本地来源**：`D:\Nyx-main`
- **Nyx 声明身份**：`moonlovelj/Nyx@bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b`
- **目标**：为后续 implementation 讨论提供经过当前代码、现有 ADR/spec 和本地 Nyx 源码校准的最终研究架构输入

> 本文位于 `docs/others/`，是研究母稿，不是生效中的 ADR、ABI 或实施进度。长期决策以 `docs/adr/` 为准，精确合同以 `docs/specs/` 为准，当前实现事实以 `docs/ARCHITECTURE.md`、`docs/PIPELINE.md` 和 `docs/STATUS.md` 为准，活跃交付切片以 `docs/implementation/` 为准。

---

## 0. 结论先行

OEngine 的主产品体验继续是：

```text
load("scene.glb")
  -> Web Worker + WASM Runtime Cooker
  -> page-oriented Cook Stream
  + bounded asynchronous residency
  + GPU demand feedback
  + resident ancestor fallback
  + existing GPU-driven Visibility consumer
```

关键变化不是把 GLB 排除出 Runtime，而是避免：

```text
完整 fetch GLB
  -> 完整 JS object graph
  -> 主线程 TypeScript cook
  -> 等完整 package/file 生成
  -> 才开始 GPU publication
```

Web Runtime Cooker 是默认产品路线：它为浏览器优化，使用 WASM、Web Worker、有界内存和渐进任务调度，直接产生可被 Runtime 消费的 geometry products。Native/C++ Offline Cooker 是第二路线：它可以使用不同实现编排、参数 profile 和更高离线预算成本来生成 OEGPACK，但几何/层次/streaming 核心算法仍必须按第 18 节从 Nyx 完整移植。两者不要求共用 C++ 源码，也不要求对同一 source 产生字节相同的 Group/Page；真正统一的是 `Virtual Geometry Runtime ABI -> Geometry Residency -> Renderer`。

核心方向成立，但必须遵守以下边界：

1. Nyx 是几何构建、Group refinement、层次遍历和动态页驻留的重要移植来源，不是 OEngine 的运行时依赖，也不是应被整体照搬的后端。
2. Web 主路线是 `GLB/glTF source -> Web Runtime Cooker -> GeometryProductSource`；预处理路线是 `Native Offline Cooker -> OEGPACK -> OegPackProductSource`。两条路线从 Geometry Product admission 开始共享同一 residency 和 Renderer。
3. 不冻结“一个 Core、两个 shell”。Web Cooker 可以偏向快速 bootstrap、增量 hierarchy 和后台 refinement；Offline Cooker 可以使用更重的 simplification、全局 page packing 和压缩。只要二者分别通过同一 Runtime ABI conformance 即可。
4. OEGPACK V3.0 继续固定自己的 256 KiB decoded page、Page payload、Group/Hierarchy 和 raw/LZ4 文件合同；但它是 Offline 产物合同，不是 Web Runtime Cooker 内部算法或中间格式。
5. Group 是 LOD/DAG 和合法 cut 的逻辑单位；Page 是 cook 输出、传输、校验和物理驻留单位；Physical Slot 是 GPU 内存复用单位。三者不得混合。
6. 虚拟几何必须接入现有 `GpuAssetStore -> GpuRenderWorld -> hierarchy/work -> MeshletBucketRaster -> VisibilityKey` 主管线，不建立独立的 “Nyx Renderer”。
7. “边 Cook 边渲染”不允许修改已发布 Group/Page 的含义。快速 bootstrap 必须是可独立绘制的 immutable product revision，或者属于提前冻结 identity 的 append-only graph；后续质量升级通过新 revision 原子替换。
8. WASM Cooker 不得无界地产生 JS 对象或 Page；CookSession、Worker pool、product sink、GPU upload 和 cache sink 必须形成端到端 backpressure。
9. GPU demand 只允许 CPU 做有界、延迟的 I/O/cook 调度；最终可见 meshlet 和 indirect work 必须保持 GPU producer → GPU consumer 闭环。
10. 渐进纹理下载不等于可控的 GPU 显存释放。网络渐进和真实物理 mip residency 是两个不同能力，必须分开声明和验证。
11. `primitive-index`、`shader-f16`、压缩纹理族和其他现代能力按真实 consumer 与 adapter 协商；不能仅因目标是 WebGPU 2026 就全部设为硬要求。
12. Bootstrap、metadata、WASM memory、Worker in-flight bytes、GPU heap、feedback、upload 和永久 pin 集合都必须有容量、预算、溢出和失败语义。
13. OPFS、GPU decode、Virtual Texturing、software microtriangle raster 等能力保持可选或 Deferred，不进入基础闭环。
14. 本文不再给出多年线性 Stage 计划。后续 implementation 应按可运行的 producer → consumer 垂直切片讨论。

---

## 1. 文档治理与决策状态

本研究母稿汇总愿景、当前事实、Nyx 源码结论和待讨论问题，但不重复承担已经拆分出去的权威职责。

| 范围 | 当前状态 | 权威位置 |
| --- | --- | --- |
| 虚拟化资产总方向 | accepted | `docs/adr/0016-virtualized-assets.md` |
| OEGPACK V3 与 Offline geometry cooker | accepted | `docs/adr/0016-a-geometry-pack-and-cooker.md` |
| Geometry Product admission/residency | accepted | `docs/adr/0016-b-virtual-geometry-residency.md` |
| Virtual Geometry production consumer/cutover | accepted | `docs/adr/0016-c-v3-geometry-consumption.md` |
| Progressive texture delivery/physical residency | accepted | `docs/adr/0016-d-progressive-texture-residency.md` |
| OEGPACK V3.0 binary ABI | candidate | `docs/specs/oegpack-v3.md` |
| Geometry Product V1 | draft | `docs/specs/geometry-product-v1.md` |
| Virtual Geometry Runtime V1 | draft | `docs/specs/virtual-geometry-runtime-v1.md` |
| 当前交付切片 | active | `docs/implementation/0016-virtualized-assets.md` |

因此，本文中的类型草图、预算和流程图只表达架构意图。任何被两个 owner、线程、文件或 GPU producer/consumer 共同读取的字段，都必须先进入 spec 才能实现。

“Web WASM Runtime Cooker 为主、Native/OEGPACK 预处理为第二路线”的方向现已通过 ADR-0016 及子 ADR 正式接受；Producer-neutral Product、Runtime state machine 与交付切片分别以 spec/implementation 为权威。本稿继续保留推理、背景和设计空间，不覆盖这些已拆出的合同。

---

## 2. 当前 OEngine 基线

### 2.1 已存在的基础

当前代码已经具备：

- native C++ geometry cooker；
- OEGPACK V3 writer、TypeScript parser 和 range source；
- 固定 256 KiB page 与 128 MiB geometry bank 候选 ABI；
- bootstrap page 校验和上传 proof；
- GPU hierarchy/work generation、bucketed indirect raster 和 VisibilityKey；
- Runtime Asset 与 GPU owner 分离；
- TextureAssetPackage V2、GPU-native texture variant、TextureResidency 和 TextureBindingSet；
- submission-aware 资源发布/retire 的现有工程模式；
- capability、counter、benchmark 与浏览器 validation 的治理框架。
- `AssetWorkerPool` 的 bounded worker 数、优先级、in-flight estimated bytes、queue capacity、Transferable 和 cancellation seam。

### 2.2 尚未完成的闭环

当前不能宣称 Virtual Geometry Runtime 已完成，因为：

- 生产 `GpuAssetStore` 仍消费完整 `GeometryAssetPackage`；
- OEGPACK V3 bootstrap 尚未进入生产 hierarchy/work/raster consumer；
- GPU 尚未产生可供异步调度器消费的生产级 page demand；
- 缺页时的 resident ancestor cut 尚未进入当前 Visibility 路径；
- 尚无 production page table generation、eviction、replace、cancel 和 device-loss 闭环；
- 主视图、阴影和普通 Scene adapter 尚未全部切换到 V3。
- 当前 C++ target 是读取文件路径并完整写出 pack 的 executable；这适合 Offline Cooker，但不能直接充当 Web Runtime Cooker。
- 当前 GLB URL 路径使用 `response.arrayBuffer()` 读取完整文件，尚无 metadata-first/range-aware GLB source。
- 当前 C++ importer 使用 `cgltf_parse_file/cgltf_load_buffers`，writer 会构造完整 pack byte vector 后落盘。这是 Native 线的现状，不再被当作 Web 线必须先重构的共享核心。

### 2.3 当前实现中的扩展边界

- `OegPackV3.open()` 当前读取并校验整个 metadata prefix，再解析为 JS 对象；大规模 metadata 的首帧预算尚未闭合。
- `GeometryBootstrapResidencyV3` 当前是 bootstrap proof，不包含 demand scheduler、eviction 或 feedback。
- `RuntimeAssetResidencyState` 提供有界状态 seam，但不是 virtual geometry scheduler。
- `TextureResidency` 当前创建不可变完整 mip chain；晚上传 mip 可以减少下载和上传，不能据此声明已释放相应显存。
- 当前 Worker codec 基础可复用，但一项 Worker task 只返回一次结果；流式 Cooker 需要 session/message channel、持续事件、pause/resume/backpressure 和 worker crash 后的 session 失效语义。

---

## 3. 本地 Nyx 源码结论

本次只使用用户提供的 `D:\Nyx-main`，不从 GitHub 获取 Nyx 源码。该目录不包含 `.git` 元数据，因此 `moonlovelj/Nyx@bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b` 只能作为该目录携带的声明身份，不能当作本地可验证 commit；实际移植基线由核验日期和下方关键文件 SHA-256 固定。若未来拿到可验证 Git checkout，必须重新核对 hash，任何不一致都要重新审查。

主要审查文件：

```text
D:\Nyx-main\MiniEngine\Model\MeshletBuilder.cpp
D:\Nyx-main\MiniEngine\Model\ModelConvert.cpp
D:\Nyx-main\MiniEngine\Model\MeshletStructs.h
D:\Nyx-main\MiniEngine\Model\GeometryStreaming.cpp
D:\Nyx-main\MiniEngine\Model\GeometryStreaming.h
D:\Nyx-main\MiniEngine\Model\Shaders\DAGCull.slang
D:\Nyx-main\MiniEngine\Model\Shaders\VBufferMesh.slang
```

### 3.1 应保留的 Nyx 不变量

Nyx 为 OEngine 提供了以下经过完整工程组织的骨架：

- meshlet build、grouping、iterative simplification 和 propagated error；
- coarse meshlet 通过 `RefineGroupIndex` 指向 finer Group；
- Group/DAG 与 BVH traversal；
- 256 KiB 独立 geometry page；
- page-local Group payload；
- root/coarse page pinning；
- `GroupDataLocation` 式逻辑地址到物理位置解析；
- GPU request mask、三重 readback 和异步 I/O；
- raw/LZ4 独立页；
- residency 与 renderer consumer 分离；
- Visibility Buffer 先写 identity、后解析属性的总体方向。

### 3.2 必须适配 WebGPU/OEngine 的部分

Nyx 使用 DX12 Mesh Shader、bindless descriptor heap、显式 fence、native 文件线程和 256 MiB chunk。OEngine 不能原样复制：

| Nyx | OEngine 适配方向 |
| --- | --- |
| `DispatchMesh` | 现有 compute work generation + bucketed `drawIndirect` + vertex pulling |
| Mesh Shader 输出 | Hardware-first vertex/fragment raster，必要时按 meshlet capacity 分桶 |
| bindless chunk descriptor | 有界 geometry bank 与显式 binding/layout budget |
| `GroupDataLocation[group]` 动态全表 | static Group directory + dynamic PagePhysicalLocation |
| native file I/O | `RangeReadablePackV3` + HTTP Range/其他 source adapter + Worker |
| DX12 fence timeline | OEngine command/submission completion 与 generation/retire 合同 |
| 256 MiB chunk | 受 `maxStorageBufferBindingSize`、`maxBufferSize` 和 binding 数共同约束的 bank |

### 3.3 不得复制的 Nyx 当前行为

本地源码同时暴露了需要修正的实现边界：

1. Nyx 的 GPU request mask 按 Group 置位，CPU readback 后扫描整张 bitset，再把 Group 映射到 Page。OEngine 应避免每帧 CPU 全量扫描，使用 first-setter/touched-word 机制生成有界 compact demand。
2. Nyx root pinning 有固定上限，预算不足时会只 pin 部分 root。OEngine 的 bootstrap 必须形成完整合法 cut；无法全部 admission 时应显式拒绝该资产/场景，而不是留下不可绘制洞。
3. Nyx I/O 失败路径仍把零填充 page 推入 completed queue。OEngine 必须 fail closed：读取、解压、CRC/hash 或 payload validation 失败时保持 non-resident。
4. Nyx `GroupDataLocation` 只有 `ChunkIndex + ByteOffset`，没有 generation。OEngine 必须防止 stale feedback、scene replace、page reuse 和 ABA。
5. Nyx eviction 会撤销映射并立即把 slot 放回 free pool。OEngine 必须先 revoke publication，再等待旧 submission 不可能继续读取后才允许物理复用。
6. Nyx 上传 ready page 时重写完整 Group location table。OEngine 应将静态 Group → Page/offset 与动态 Page → PhysicalLocation 分离，避免 residency 变化触发大表重写。
7. Nyx 的同步 root upload 和显式 `Finish(true)` 不能进入 OEngine frame hot path。

结论是：移植 Nyx 的算法与状态语义，拒绝复制其 DX12 资源模型和未经 OEngine 生命周期验证的具体实现。

---

## 4. 总体架构

```text
PUBLIC WEB ENTRY

load("scene.glb")
  -> GlbSource / metadata-first Range reader
  -> WebCookCoordinator
  -> Dedicated Worker(s)
  -> Web Runtime Cooker compiled to WASM
  -> progressive Web cook events
       SceneMetadataReady
       BootstrapProductReady
       ProductDescriptorReady
       ProductPageReady
       ProductRevisionReady
       AssetComplete / Error
  -> WebCookProductAdapter
  -> GeometryProductSource / Admission
  -> bounded GPU upload + atomic publication
  -> first meaningful frame through existing MainRenderPipeline

SECONDARY PRECOOKED ENTRY

source asset
  -> independent Native/C++ Offline Cooker
  -> OEGPACK / scene catalog
  -> CDN/HTTP/OPFS
  -> OegPackProductSource
  -> same GeometryProductSource / Admission

STEADY STATE

GPU hierarchy/LOD selection
  -> desired Group
  -> resolve static Group directory
  -> resolve dynamic PagePhysicalLocation
  -> resident: emit existing raster work
  -> missing: emit resident ancestor work + bounded demand
  -> delayed CPU scheduler
  -> range read/decode/verify/upload
  -> generation publication
  -> later frames consume higher-detail page
```

Web 首次加载时，Geometry Product 可以直接携带 Runtime ABI 所需的 decoded Page，不必先 LZ4 压缩成完整 OEGPACK 再立即解压。可选 cache sink 写入独立 Web cook cache；Native Offline Cooker 则生成可分发 OEGPACK。两者可以得到不同 hierarchy、Group 划分和 Page 内容，但必须映射到相同版本化 Runtime ABI。

### 4.1 唯一主管线

虚拟化资产只替换以下输入和解析边界：

```text
resident geometry source
hierarchy/group address source
page demand/fallback source
```

它不复制以下系统：

```text
GpuScene
GpuRenderWorld
VisibilityKey
MeshletBucketRaster
Sparse Shading
Lighting/Temporal/Post
FrameGraph
Evidence pipeline
```

如果某个 Cooker 只生成新 Buffer，但最终仍由 CPU 遍历原几何列表，或由独立 renderer 显示，则不算接入生产主管线。

### 4.2 Owner 边界

为了避免再次形成 Asset/Renderer 混合 God Object，职责按以下边界拆分：

| Owner | 负责 | 不负责 |
| --- | --- | --- |
| Source provider | GLB header/JSON/BIN ranges，或 OEGPACK header/metadata/page ranges | GPU allocation、最终可见列表 |
| WebCookCoordinator | Web CookSession 生命周期、source work 优先级、Worker/backpressure/cancel | GPU resource ownership、最终 shader-visible publication |
| Web Runtime Cooker | 浏览器定制 import/canonicalize、快速 bootstrap、渐进 hierarchy/Group/Page 构建 | GPU object、最终 publication、OEGPACK 写出 |
| Native Offline Cooker | 离线高质量 simplification、全局 packing/压缩、OEGPACK 确定性写出 | Web Worker 调度、强制决定 Web Cook 算法 |
| Product source/adapter | 将 Web cook event、OEGPACK 和 optional cache 映射为同一 Geometry Product Runtime ABI | 修改已发布 Group/Page 语义、混用不同 product revision |
| Streaming scheduler | 已 Cook Page demand 去重、Range/cache 计划、并发/backpressure/cancel | GPU resource ownership、shader-visible publication |
| Decode/cook worker pool | online cook、预处理 Page decode、hash 和 CPU-side validation | 长期持有 GPU resource、直接决定 resident |
| Geometry residency owner | slot/bank、upload、PagePhysicalLocation、generation、retire | LOD 选择、材质和最终渲染编排 |
| GPU hierarchy/work owner | desired Group、ancestor fallback、demand 和 bounded raster work | 网络、文件、Worker 调度 |
| Existing raster/Visibility consumer | 消费 work 和 resident geometry，输出稳定 Visibility identity | 自建第二套 Scene、材质或 shading ABI |
| Evidence owner | CPU/GPU counter、timestamp、debug view、browser artifact | 用日志替代正确性或性能门禁 |

跨 owner 传递的对象必须是显式 id、不可变 metadata、generation 和提交 token；不得传递 Loader 临时对象或隐式延长 GPU 资源生命周期。

### 4.3 两个独立 Producer，一个 Runtime 合同

架构不规定 Web 和 Native Cooker 共用内部模型、任务图、序列化代码或源码；但不允许各自另造或删减 Nyx 的几何/层次/streaming 算法。两边只通过 Geometry Product 合同与 Runtime 对接：

```text
Web Runtime Cooker                 Native Offline Cooker
  -> WebCookProductAdapter           -> OEGPACK writer
  -> LiveCookProductSource           -> OegPackProductSource
                 \                   /
                  -> GeometryProductSource
                  -> GeometryProductAdmission
                  -> GeometryResidency
                  -> GPU hierarchy/work/Visibility
```

最小共同产物概念包括：

```text
GeometryProductDescriptor
  -> product identity/revision, runtime profile, bounds
  -> hierarchy + Group directory
  -> Page directory and bootstrap cut
  -> material-domain and vertex/decode declarations

GeometryPageProduct
  -> product identity/revision + pageId
  -> decoded payload or declared decode input
  -> size/layout/hash/flags

GeometryProductPublication
  -> pages required for a complete legal cut
  -> scene/asset/device generation and replacement intent
```

Runtime 合同只要求可消费性、保守误差、合法 cut、容量和生命周期正确，不要求两个 Producer 的 GroupID、PageID、hash 或字节相同。ID 只在 `productIdentity + productRevision` 作用域内有效；file offset、HTTP URL、OPFS record 和 GPU slot 均不参与逻辑几何语义。

### 4.4 Progressive publication 与 immutable revision

“流式生产者”不等于向 GPU 发布半个可变 DAG。Web Cooker 可以使用任意内部 CookEvent，但 Product adapter 只能对 Runtime 发布以下稳定语义：

```text
SceneMetadataReady
  -> 可建立节点、实例、材质占位与 source bounds

BootstrapProductReady(productRevision = 0)
  -> 一个独立、完整、可绘制的 coarse Geometry Product
  -> 允许尽快产生首帧，但不假装它已是最终 DAG
  -> 语义上等价于一组已验证 Descriptor + Page + Publication，不是无合同特例

ProductDescriptorReady(productRevision = N)
  -> 该 revision 的 Hierarchy/Group/Page identity 已冻结

ProductPageReady(productRevision, pageId, payload, hash, flags)
  -> 只能填充已冻结的 Page，不改写已发布逻辑记录

ProductRevisionReady(productRevision, requiredPageIds, generation)
  -> 完整合法 cut 已齐备，可原子激活或替换上一 revision

AssetComplete
  -> 当前目标质量已完成；不是首帧前提
```

在同一 published revision 内，Group/Page identity 必须 immutable。后台 refinement 只有两种合法做法：提前冻结全部 identity 后 append Page payload，或构建新 product revision 并在完整 cut resident 后原子替换。若一个巨大 primitive 必须完成全局 hierarchy 才能冻结 identity，则更早出图只能依赖独立 bootstrap product 或确定性 spatial shard，不能将未完成 DAG 暴露给 Renderer。

### 4.5 两类并行，不能混淆

Web 端有两种合法执行 specialization：

1. **pthread WASM**：一个 Dedicated Worker 承载共享 WASM instance/SharedArrayBuffer，由 C++ 内部线程池并行。吞吐潜力最好，但要求 cross-origin isolation、COOP/COEP、明确的共享内存上限与部署控制。
2. **多 Worker + 单线程 WASM instance**：按独立 asset/domain/cook shard 把 Transferable 输入分发到多个 Worker。部署范围更宽，但会复制 WASM runtime/memory，且不能把一个全局可变 DAG 粗暴拆给多个实例。

它们共享同一个 CookSession/CookEvent 逻辑合同，不是两套 Renderer。是否把 pthread 路线设为产品要求，应由部署条件、内存峰值和固定 workload 证据决定。

这里的 CookSession/CookEvent 只是 Web Cooker 内部合同，不要求 Native Offline Cooker 采用。pthread/shared WebAssembly.Memory 路线需要 `crossOriginIsolated === true`，通常由 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: require-corp` 或经验证的 `credentialless` 部署建立；所有跨域 GLB、纹理和 Worker/WASM 资源也必须满足对应 CORS/CORP 策略。不能只在本地打开 pthread，却不定义真实部署头与第三方资产策略。

线程预算必须是全局的，不能让每个 CookSession 都创建一套“核数级” pthread pool，也不能在多 Worker 路线中再为每个 Worker 开内部线程池。WebCookCoordinator 必须统一限制 active session、Worker、WASM thread、在途 source bytes 和 decoded output bytes，否则“多线程加速”会变成 oversubscription、内存峰值和 GC/allocator 抖动。

---

## 5. 逻辑与物理资源分层

### 5.1 Geometry Group

Group 表达 LOD/DAG 语义：

```text
bounds
conservative error
refinement relation
pageId
offsetInPage
payloadBytes
meshlet range/count
flags
```

Group 决定合法 LOD cut。缺失 desired Group 时，fallback 必须沿 Group refinement 关系选择 resident ancestor/bootstrap 表示。

### 5.2 Geometry Page

Page 表达传输和校验语义：

```text
product-local pageId
runtime page/layout profile
optional source byte range
encoded/decoded size
codec
checksum/hash
contained Group range
flags
```

Page 不保存 `parentPageId`、LOD 层次、Group bounds 或 Group error。同一个 Page 可以包含具有不同 refinement 关系的多个 Group。

### 5.3 Physical Slot

Physical Slot 表达某个 decoded Page 当前所在的 GPU 存储位置：

```text
bankId
slotId or byteOffset
generation
resident/pinned/retiring flags
```

静态 Group directory 与动态 PagePhysicalLocation 分离后，GPU 地址解析为：

```text
GroupId
  -> GroupDirectory[GroupId] = pageId + offsetInPage
  -> PagePhysicalLocation[pageId] = bank + slot + generation + flags
  -> final GPU byte address
```

这保留 Nyx `GroupDataLocation` 的含义，同时避免 page residency 变化时重写 page 内所有 Group 的动态地址。

### 5.4 稳定 ID 与 GPU 热表

虚拟几何不应把 Loader 生成的 JS 对象图带入 GPU 热路径。逻辑数据至少需要收敛为以下稳定表关系：

```text
InstanceTable
  -> stable Asset/Hierarchy root + transform/material override

HierarchyNodeTable
  -> bounds/error + child/Group range

GroupDirectory
  -> stable GroupID + refinement relation + PageID + offset

PagePhysicalLocation
  -> dynamic bank/slot/generation/resident flags

VisibleWorkTable
  -> bounded per-frame instance/Group/meshlet work identity

MaterialTable / TextureHandleTable
  -> stable logical material/texture identity; physical binding is indirect
```

`AssetID`、`ProductID/Revision`、`InstanceID`、`GroupID`、`PageID`、`MaterialID` 和 `TextureHandle` 必须有明确的作用域和 generation。具体字段、stride 与 bit packing 不在本母稿冻结；它们一旦被 CPU、WASM、文件或 WGSL 共享，必须进入 `docs/specs/` 并用 producer/TypeScript/WGSL oracle 共同验证。

---

## 6. OEGPACK V3 是 Offline 基线，不是两个 Cooker 的共享实现

OEGPACK V3 继续是 Native Offline Cooker 的预处理文件、golden corpus 和 corruption/determinism 规范载体。Web Runtime Cooker 既不必生成完整 `.oegpack`，也不必采用 Native Cooker 的内部 DAG 构建顺序、packing 算法或序列化代码。需要拆清三个层次：

```text
Virtual Geometry Runtime ABI
  -> Renderer/Residency 可消费的 Product/Group/Page/publication 语义

OEGPACK V3 decoded profile
  -> 当前 256 KiB Page、vertex/Group payload 和 bootstrap 布局

OEGPACK V3 file container
  -> header/table offsets/compressed ranges/raw or LZ4/file hash
```

`OegPackProductSource` 将后两层适配到 Runtime ABI。WebCookProductAdapter 直接生成 Runtime ABI product；第一个实现应选择 V3-compatible decoded profile 以复用已有 GPU consumer，但这是有意的输出合同，不是共享 Cooker 源码的结果。若未来 Web Cooker 确实需要不同 page/layout profile，必须新增显式版本和有证据的 decode/vertex-pulling specialization，不能改写 OEGPACK V3，也不得分叉 Geometry Residency、hierarchy/work、Visibility 或主渲染管线。

该边界现已拆为 `geometry-product-v1.md` 与 `virtual-geometry-runtime-v1.md`：前者定义 Producer-neutral descriptor/page/provider，后者只消费 Product 并管理 admission、residency、feedback 与 publication。Web Cooker 不得在这两个合同之外私自发明无版本 Page ABI。

当前 V3.0 的架构基线是：

- little-endian；
- 256 B header；
- 固定 256 KiB decoded page；
- 128 MiB geometry bank 候选配置，每 bank 512 slots；
- 128 B asset record；
- 48 B hierarchy node；
- 16 B Group directory；
- 64 B Page directory；
- 64 B Group header；
- 48 B Meshlet header；
- codec 0 raw、codec 1 LZ4 block；
- Group 必须完整位于一个 Page；
- `refineGroupId` 保持 Group-level 语义；
- metadata prefix hash、compressed page CRC 和 decoded hash；
- bootstrap page 集合必须覆盖合法初始 cut。

以下内容不得在 V3 实施中被当作自由参数：

- 64/128/512 KiB decoded page；
- Page 内 SoA 替换当前 payload；
- page-AABB position quantization 替换当前量化合同；
- meshopt encoded stream 或双重 meshopt+LZ4；
- 新 Page directory 字段；
- 可变 bank addressing 语义。

这些都可以作为 V4 或显式 layout/codec profile 的实验，但必须有独立 golden pack、parser/writer、真实 consumer 和同条件 benchmark。

### 6.1 Pack、Page 与网络请求的关系

Pack 可以很大，但不能退化为“一资产一个大请求”或“一 Page 一个永久 HTTP 文件”。推荐组织仍然是少量大 pack + 独立 Page byte range：

```text
scene/catalog
  -> geometry pack 0..N
      -> metadata prefix
      -> independently addressable compressed Page blobs
  -> texture container/pack 0..N
```

需要同时保持：

- Page 独立寻址；
- Page 独立压缩和校验；
- Page 独立 decode/upload/evict；
- Pack 支持 Range 合并与连续读取；
- bootstrap/coarse/refinement 的物理排列有利于常见共同请求；
- shard 上限使 metadata、单次失败域和 CDN cache 粒度保持有界。

Pack shard 不能只按文件大小切分。至少要考虑 asset 边界、bootstrap working set、空间/LOD locality、Page 数量、metadata bytes 和典型 Range 合并概率。

### 6.2 V3 payload 与未来布局实验

Visibility raster 主要读取 position 和 triangle micro-index，shading 才需要 normal/tangent/UV/material attribute，因此 SoA 或 split-stream 在理论上可能降低 Visibility 带宽。但当前 V3 已有固定 page-local payload 和 decode shader，不能在生产 cutover 中顺手改布局。

V4/layout profile 实验应至少比较：

```text
current V3 interleaved payload
split position/index + shading attributes
fully separated SoA blocks
```

并同时测量：

- Visibility 读取字节；
- sparse shading 属性读取字节；
- vertex pulling cache behavior；
- Page padding/waste；
- decode throughput；
- shader branch/binding 增量；
- total frame time，而不只是单 Pass 带宽。

同样，codec 实验必须分别比较 raw、LZ4、meshopt stream 和 meshopt+LZ4 的 compressed bytes、CPU/WASM decode、upload bytes、GPU-ready 程度和端到端 TTFMF。双重编码不能被预设为更快。

### 6.3 Scene Catalog 与 Pack Metadata

场景启动仍需要一个比 Page payload 更小的 catalog/manifest 层，但它只负责组合与准入，不重复 OEGPACK 内部目录。概念职责包括：

```text
scene/content identity
cooker/recipe identity
pack identity and source locator
required capability/variant declarations
asset/instance/material dependencies
bootstrap working-set summary
expected metadata/pinned/resident bytes
```

精确字段在需要跨 Loader、Scene 和 scheduler 使用时另写 spec。Catalog 不得内嵌全部 Group/Page object graph，也不能成为长期 GPU 资源 owner。

### 6.4 Live Product 与完整文件的差异

在线 Cook 产生的 live Product/Page 可以直接携带：

```text
asset/shard identity
product identity/revision
logical pageId
declared runtime profile + decoded payload
decoded content hash
contained Group range/flags
cook generation
```

它没有最终 `compressedFileOffset`，也不需要为了立刻上传而先生成 LZ4。OEGPACK 的 file offsets、raw/LZ4 选择、Page directory 和 metadata prefix hash 只属于 Offline Cooker/writer，不反向约束 Web CookSession。

因此不能把一个尚未 finalized 的增量缓存文件冒充合法 OEGPACK V3。Web cache 默认使用独立、带 journal/version 的 content-addressed Product/Page cache。只有未来显式实现了 OEGPACK exporter 并通过完整 writer validation 时，才可在后台 finalize 为 OEGPACK；这不是 Web 主路线的必要步骤。

Runtime identity 基于 source identity、producer kind/version、recipe/profile、runtime ABI 和 cooked content，不基于临时 file offset。

---

## 7. Bootstrap 与 Metadata Admission

### 7.1 Bootstrap 必须完整可绘制

Bootstrap 不是“尽量多 pin 一些 root”，而是满足：

```text
所有 active asset 都有完整、合法、无洞的初始 Group cut
所有该 cut 依赖的 decoded pages 都已 resident 并 pinned
所有地址表和 generation 已原子发布
```

如果预算不足，必须执行以下一种显式行为：

- 拒绝 asset/scene admission；
- 延迟该 asset 进入 active scene；
- 使用事先 cook 的更小 bootstrap 表示；
- 使用显式 placeholder asset。

不得复制 Nyx “预算不足时只 pin 一部分 root”的行为。

### 7.2 全局预算

至少需要以下独立预算：

```text
active catalog bytes
metadata prefix bytes
parsed metadata CPU bytes/object count
bootstrap geometry decoded bytes
bootstrap texture tail bytes
pinned GPU bytes
in-flight compressed bytes
in-flight decoded bytes
upload bytes per frame
readback bytes per frame
```

预算必须跨所有 active packs/asset 计算，不能只对单个文件成立。

### 7.3 大规模 metadata

V3 reader 当前一次读取完整 metadata prefix。短期可以通过 pack sharding、page/group 数上限和 admission budget 保持有界。只有真实 workload 证明 metadata prefix 成为首帧瓶颈时，再设计新版本的二级索引：

```text
Pack Catalog
  -> Bootstrap Index
  -> Refinement Metadata Pages
  -> Geometry Pages
```

二级 metadata 不能静默加入 V3.0。

### 7.4 在线 Cook 的首帧边界

在线 Cooker 只能在以下条件满足后发布某个 asset/shard 的 product revision：

```text
该 revision 的稳定 hierarchy/Group identity 已冻结
完整 bootstrap cut 已 Cook
bootstrap Pages 已通过 sink admission
所需 material/最低纹理表示可用
GPU upload/publication 已完成编码
```

GLB 中多个独立 mesh/primitive 可以按 camera/source bounds 排序并逐 asset 发布；但一个超大的单 primitive 仍可能要求读取并处理它的全部 position/index 数据才能生成 conservative hierarchy 和 root cut。WASM 多线程不会消除这个数据依赖。

因此预处理路线仍然对极大单 mesh、极低 TTFMF、弱 CPU 或不允许 cross-origin isolation 的部署有价值。若在线路线要进一步降低单大 mesh 的首帧，必须新增确定性 spatial cook shard 或独立 bootstrap product，而不能只增加 Worker 数。

---

## 8. Virtual Geometry Residency

### 8.1 逻辑状态

每个逻辑 Page 至少具有：

```text
Unrequested
Requested
Resident
Retiring
```

实现可以有内部 I/O、decode、verified、uploading 状态，但跨 owner 的可见语义必须保持简单且由 spec 定义。

### 8.2 GPU demand

GPU traversal 遇到 non-resident desired Page 时必须同时做到：

1. 保持合法 resident ancestor/bootstrap Group 可绘制；
2. 对 desired Page 产生去重 demand；
3. 不等待 CPU 或 readback；
4. demand overflow 时仍保持正确 fallback；
5. 不把 CPU 重新引入最终可见列表生成。

GPU feedback 不能只定义一个无界 bitset。正式队列合同必须写明：

```text
element ABI
pack/global page identity
pack/scene generation
frame epoch
reason/priority hint
capacity
count
overflow behavior
producer
consumer
counter/telemetry
```

推荐保留 atomic bit 去重，但由第一次置位者追加 compact queue，或额外维护 touched-word queue。CPU 只读取有界 compact 结果，不每帧扫描全体 Page/Group bitset。

在线 Cook 需要区分两个反馈平面：

```text
Source Cook Priority
  -> asset/shard 还没有稳定 Group/Page identity
  -> 根据 scene node、accessor bounds、camera、依赖和 request age 排序 Worker cook

GPU Residency Demand
  -> ProductDescriptorReady 之后 Page identity 已存在
  -> GPU traversal 请求尚未 resident 的具体 Page
```

在 Page identity 尚未生成前，GPU 不可能请求该 Page。Source Cook Priority 可以参考 camera 和粗 scene bounds，但不能伪装成 GPU page feedback。ProductDescriptorReady 后，两者才能通过稳定 product revision/page identity 汇合。

### 8.3 Scheduler

CPU scheduler 只负责有界异步工作：

```text
consume delayed demand
  -> reject stale generation
  -> deduplicate/coalesce
  -> prioritize bootstrap/visible/prefetch
  -> enforce compressed/decoded/upload budgets
  -> range read
  -> decode + verify
  -> batch upload
  -> publish generation
```

需要显式定义：

- 最大 pending/in-flight 数量；
- per-source 并发；
- Range 合并上限；
- cancel/replace；
- retry/backoff；
- corruption 与 permanent failure；
- starvation 防护；
- camera jump/prefetch 降权；
- frame upload/readback 上限。

#### 8.3.1 优先级层次

Scheduler 优先级不能只用 distance，也不能把昂贵的最终 priority 计算全部塞进 GPU。建议按语义分层，再在层内综合排序：

```text
P0  bootstrap、完整合法 cut 所需依赖、恢复/device-loss critical
P1  当前可见且 desired Group 缺失的 Page
P2  当前视锥附近、高 projected error、即将替换 ancestor 的 Page
P3  camera velocity/angular velocity 推导的预测请求
P4  background quality convergence、cache warming
```

层内可以考虑：

```text
projected error
screen coverage
request age
dependency readiness
source/cache locality
estimated compressed/decoded/upload bytes
recent cancellation/thrash penalty
```

真实 GPU miss 始终高于纯预测请求；预测请求必须可取消，且不能挤占 bootstrap 或当前可见缺页的预算。

#### 8.3.2 内部状态机与取消

跨 owner 的四态保持稳定，scheduler 内部可以细分为：

```text
Absent
  -> Queued
  -> Fetching | CacheRead
  -> CompressedReady
  -> Decoding
  -> Verified
  -> ReadyToUpload
  -> UploadEncoded
  -> PublishEncoded
  -> Resident
  -> RetirePending
  -> Absent
```

每个异步任务至少关联：

```text
source/product/page identity
scene/product/device generation
priority class
estimated and admitted bytes
AbortSignal/cancellation token
source request identity
```

取消不等于一定中断底层网络或 decode；如果工作无法及时取消，完成结果必须在 generation/admission 复核后选择丢弃、仅进入内容缓存或重新排队，不能直接污染热 residency。

#### 8.3.3 自适应预算

Streaming 的目标是“不破坏当前帧预算地尽快收敛”，不是让后台任务持续跑满。预算控制器可读取：

```text
GPU frame/phase time
main/render-thread CPU frame time and long tasks
upload/copy time
worker queue depth and CPU time
compressed/decoded in-flight bytes
resident/pinned/retiring pressure
request latency and miss rate
recent overflow/thrash
```

并调整：

```text
new request issue count
active cook Worker/thread count
foreground/background cook time or byte slice
HTTP Range bytes/concurrency
decode bytes/concurrency
upload bytes/copies per frame
prefetch horizon
background refinement share
```

具体控制算法和默认数值属于 implementation/benchmark；架构只要求预算有上下限、迟滞和可观测 counter，不能因单帧抖动频繁开关。

### 8.4 Source adapter

Runtime 的正确性依赖抽象 source/sink，而不是某个具体文件：

```text
GeometryProductSource
  ├─ LiveCookProductSource（Web 主路线）
  │    -> GLB metadata/BIN range -> WASM CookSession -> Product events
  ├─ OegPackProductSource（预处理第二路线）
  │    -> pack metadata/compressed Page range -> Product adapter
  ├─ Memory/File source
  ├─ optional OPFS cache/source
  └─ future application-provided source
```

HTTP 路径必须校验 status、`Content-Range`、identity encoding 和精确字节范围。Request coalescing 属于 scheduler，不改变 Page 的独立身份和校验。

GLB URL 主路线应先读取固定 header 和 JSON chunk header/payload，建立 node/mesh/accessor/bufferView/material 索引，再按 cook unit 获取 BIN ranges。若 server 不支持 Range，允许退化为一次完整下载，但必须记录 `rangeUnsupported/fullSourceBytes`，不能悄悄把它宣称为流式加载。

GLB 的 bufferView 可以重叠或被多个 accessor/image 复用，source planner 必须去重并遵守 byteOffset/byteLength/stride/sparse accessor 语义。Accessor `min/max` 和 node transform 可以帮助建立粗 bounds/优先级，但不能替代对真实顶点、索引和 conservative bounds 的验证。

OPFS 只能作为可选缓存/来源适配器；缓存 miss、不可用或被清理不能破坏正确性，也不能成为首帧硬依赖。

若启用持久缓存，key 至少包含 source/content identity、producer kind/version、recipe/runtime profile、product revision、pageId 和校验身份；缓存必须 size-bounded、可整体失效，并在命中后继续满足当前 validation contract。LRU/segmented LRU 只是候选策略，不能让缓存策略与 GPU residency 生命周期互相拥有。

### 8.5 Range 规划与 Cook-time Locality

不能简单地为每个 256 KiB Page 发一个 HTTP 请求。Range planner 应在不破坏优先级和取消语义的前提下合并邻近 Page：

```text
requested pages 17, 18, 19, 22
  -> one range covering 17..19
  -> one range covering 22
```

合并决策至少受以下条件约束：

- 最大合并字节；
- 最大 gap/无用字节；
- priority class；
- pack/source identity；
- cancellation domain；
- cache hit/miss；
- deadline/age；
- source 对 Range/并发的真实表现。

预烘焙 Cooker 的 Page 排列要与此配合，优先考虑 bootstrap/coarse 连续性、parent/refinement 共请求概率、空间 locality 和材质依赖 locality。Range 上限和 gap 阈值必须 benchmark，不能把 512 KiB、1 MiB 或 4 MiB 写成永久常量。

GLB 主路线的 Range planner 则合并当前高优先级 cook unit 所需的 position/index/attribute/image bufferView ranges；它不能为了减少请求数重新退化为无条件下载整个 BIN chunk。一个 bufferView Range 完成后可以被多个 cook task 引用，但其 CPU memory lifetime 必须纳入 budget。

合并 Range 返回后，每个 Page 仍独立校验、decode 和 publication；合并只是传输优化，不改变 Page identity。

### 8.6 Worker 与 Decode 所有权

推荐逻辑拓扑是：

```text
main/render thread
  -> small scheduler coordination
  -> GPU ownership/command encoding/publication

dedicated workers
  -> GLB metadata/range import
  -> WASM geometry/texture cook
  -> OEGPACK/cache I/O
  -> LZ4/raw decode for precooked pages
  -> hash/checksum/payload validation
  -> texture preparation where applicable
```

主线程不得承担大 JSON parse、bulk hash、LZ4/meshopt decode、geometry cook、图片 bulk decode 或大 typed-array clone。Worker 输出应通过 Transferable ArrayBuffer 或其他有明确 ownership 的 block 交给 GPU owner。

不得宣称这条路径天然 zero-copy：普通 WebAssembly linear memory 中的某段 Page 不能单独 transfer 出去，pthread WASM 使用的 SharedArrayBuffer 也不发生 ownership transfer。可移植的默认实现应使用有界 output block pool：Worker 把完成的 runtime Page（首个 V3-compatible profile 中为 256 KiB）从 WASM heap 拷贝到独占 ArrayBuffer，再 transfer 给 GPU owner，消费后归还 block credit。共享内存 ring、Renderer-in-Worker 或其他少一次拷贝的变体只能作为 benchmark 驱动的 specialization，并且仍然要计入 `queue.writeBuffer`/上传阶段的实际拷贝和同步成本。

SharedArrayBuffer/pthread WASM 可以作为 cross-origin-isolated 部署的高吞吐 specialization，但不是 correctness 前提；必须有清晰的共享内存 ownership、固定/可控 memory growth、取消和 worker failure 语义。非隔离部署使用多个独立单线程 WASM Worker + Transferable，仍产生相同 CookEvent。

WebGPU object 不跨 Cooker Worker 边界。默认由现有 render/GPU owner 接收 Transferable Page block 并编码 upload；如果未来把整个 Renderer 移入 Dedicated Worker，则通过 OffscreenCanvas 建立独立生命周期，不能只把 `GPUDevice`/`GPUBuffer` 当消息传递。

在线 Geometry Cooker 与 OEGPACK decoder 都必须输出当前 Renderer 所支持的某个明确 runtime profile。第一版可共同使用 V3-compatible decoded Page，但不要求两个 Cooker 产生相同 Page 内容。GPU decode 只有在 compressed upload、compute dispatch、额外 buffer、同步与总帧成本的证据优于 CPU/WASM 后才另立实现；它不改变 product/page identity 或 residency state machine。

CookSession 必须可因 sink backpressure 暂停发出新 Page，或至少停止调度新的 cook unit。不能让 WASM heap、Worker output queue 和主线程待上传数组同时无界增长。

---

## 9. Publication、Eviction 与生命周期

### 9.1 原子发布

Page 只有在以下步骤全部成功后才能变为 resident：

```text
range read
  -> compressed checksum
  -> decode
  -> decoded hash/payload validation
  -> reserve physical slot
  -> encode upload
  -> encode PagePhysicalLocation publication
  -> submit in defined order
  -> later frame becomes consumable
```

Page copy 与地址表 publication 应在同一 submission 中按序编码，或使用具有等价可证明顺序的机制。渲染循环不能 `await mapAsync()` 或 `await queue.onSubmittedWorkDone()`。

读取、decode、hash 或 validation 失败时保持 non-resident，并记录失败；不得发布零填充页。

#### 9.1.1 Upload batching

Upload 不能默认选择“每 Page 一次 `queue.writeBuffer()`”，也不能未经证据断言 staging ring 一定更快。至少需要比较两条正确实现：

```text
A. 合并后的少量 queue.writeBuffer
B. mapped/upload staging blocks + copyBufferToBuffer batch
```

两者都必须满足：

- `writeBuffer` offset/size 的 4-byte 对齐；
- staging buffer 使用合法的 mapping/usage 组合；
- 单帧 bytes/copy 数量有上限；
- decoded block ownership 清晰；
- upload 和 PagePhysicalLocation publication 的命令顺序明确；
- submission abort 时 reservation/publication 可以回滚；
- 不在 render loop 等待 mapping 或提交完成。

评估指标包括 main-thread encode time、额外 CPU copy、Worker transfer、command 数、GPU copy time、峰值 staging bytes、Page latency 和稳定帧时间。

#### 9.1.2 依赖一致性

Page resident 不一定代表 asset 已可绘制。正式 publication 还要检查当前 consumer 所需依赖，例如：

```text
static Group/Page metadata
vertex format/decode profile
material identity
minimum alpha-mask texture representation
required geometry bank binding
```

这些依赖要么在 asset/bootstrap admission 时已发布，要么作为同一 revision 的原子 publication 一部分。禁止 geometry 已进入可见 work、但 MASK 最低纹理或 decode profile 尚未可用的半状态。

#### 9.1.3 Product revision 替换

快速 bootstrap product、Web 后台高质量 product 与 Offline OEGPACK product 之间不得按 Page 拼接。替换流程必须是：

```text
admit new ProductDescriptor under a new product generation
  -> validate and resident its complete activation/bootstrap cut
  -> publish scene asset root + product generation atomically
  -> later frames consume only the new revision
  -> retire old revision after submitted-work safety boundary
```

新 revision 构建失败、取消或超预算时，已 active 的旧 revision 继续渲染。替换不得使 Group/Page identity 跨 revision 偶然别名，也不得在同一冻结 FrameContext 中混用旧 hierarchy 和新 PagePhysicalLocation。

### 9.2 安全驱逐

Eviction 顺序必须是：

```text
select non-pinned candidate
  -> revoke PagePhysicalLocation / bump generation
  -> submit revocation
  -> wait until old submitted work cannot reference the slot
  -> return physical slot to free pool
```

不得先复用 slot 再等待旧工作结束。Bootstrap page 在 active scene 生命周期内 pinned，但 pinned 总量本身受 admission budget 约束。

驱逐选择不能只有纯 LRU。至少要考虑：

```text
pinned/bootstrap exclusion
minimum residency age
recent visible/request frequency
ancestor/fallback importance
predicted near-future use
compressed cache availability/refetch cost
memory pressure
retiring bytes and available slots
```

策略可以使用 segmented LRU/2Q-like 队列或等价实现，但必须有 hysteresis/cooldown，防止 Page 刚上传就因相机抖动被驱逐。需要记录平均 Page lifetime、重复加载、eviction 后短期重请求和 thrash bytes。

### 9.3 Generation

Generation 至少解决：

- stale GPU demand；
- scene/pack replace；
- page ID reuse；
- physical slot reuse；
- decode completion after cancellation；
- device loss/recreate；
- readback ring 中的旧 frame 请求。

Generation mismatch 必须表现为 non-resident/fail closed，而不是访问新 owner 的物理数据。

### 9.4 Device loss

Device loss 后：

- 所有 GPU physical locations 失效；
- CPU compressed cache 可以按内容身份保留；
- decoded/in-flight/upload 任务按 device generation 取消或丢弃；
- bootstrap 重新 admission 与 publication；
- Renderer 在新 device 上重建唯一主管线；
- 不复用旧 GPU handle 或 submission token。

---

## 10. GPU Traversal、Raster 与 Visibility

### 10.1 生产数据流

```text
GpuScene instances
  -> hierarchy traversal
  -> frustum/HZB/SSE decision
  -> desired Group
  -> residency resolve
      resident desired Group -> emit desired work
      missing desired Group  -> emit resident ancestor work + demand
  -> bounded work queues
  -> existing MeshletBucketRaster
  -> existing VisibilityKey + depth
  -> existing sparse shading/lighting pipeline
```

Main view、shadow 和其他 geometry consumer 必须共享同一 resident identity 与生命周期语义；不能主视图使用 V3、阴影仍永久使用完整 V2 geometry。

### 10.2 不承诺绝对 2～4 draw

当前 raster 需要考虑：

- meshlet triangle capacity；
- vertex decode profile；
- single/double-sided；
- opaque/MASK route；
- TextureBindingSet 或未来 alpha-only binding；
- geometry bank/layout specialization。

`primitive-index` 只提供 primitive identity，不会自动消除这些分桶和绑定约束。因此 KPI 应是：

```text
bounded fixed draw/indirect slot count
useful vertex/triangle invocation ratio
bucket occupancy
empty draw cost
binding/pipeline switch cost
```

若要把 draw 数继续压到 2～4，需要先证明 alpha-test 数据访问、bank addressing 和 capacity padding 的替代方案，而不是把目标数字写成架构事实。

### 10.3 Visibility identity

V3 必须继续产生当前稳定 Visibility identity：

```text
visible work / instance / local primitive
```

具体 bit packing 由现有 Visibility ABI 管理。虚拟几何不能自行创建另一套 VBuffer 编码；pageId、slotId 和 generation 也不应直接泄漏成跨帧材质 identity。

### 10.4 Bounded work 与 overflow

Virtual geometry 会新增或扩展 hierarchy task、desired Group、page demand 和 raster bucket 工作，但每个队列都必须分别定义：

```text
element ABI
capacity
reservation/append rule
overflow behavior
producer
consumer
counter and high-water mark
frame/revision identity
```

关键正确性原则：

- hierarchy child reservation 失败时不能丢掉整块几何，应保留可绘制 parent/ancestor；
- demand overflow 只降低质量收敛速度，不得制造空洞；
- raster work overflow 必须 fail closed 或回退到已定义的 parent work，不能写出无效 VisibilityKey；
- counter reset、queue publication 和 indirect args 构建必须在同一帧图依赖中有确定顺序；
- CPU 可以读取延迟统计，但不能通过扫描队列重建本帧最终可见列表。

### 10.5 Two-Pass HZB 的位置

Nyx 的 two-pass 思路可以作为现有 HZB/Visibility 的 specialization，而不是 Virtual Geometry 自建第二条管线：

```text
Pass A
  -> previous-frame HZB cull
  -> render stable/known visible work
  -> produce current depth

HZB rebuild
  -> build current-frame hierarchy

Pass B（仅有真实 consumer 时）
  -> process newly revealed/uncertain work
  -> append/raster late visibility
```

Pass B 关闭时不得保留资源、dispatch、readback 或额外 submit。进入生产前必须证明：

- 快速平移、旋转和 teleport 下减少的错误遮挡/漏可见；
- Pass B 新增 hierarchy、raster 和 HZB 成本；
- work duplication；
- demand 重复率；
- 与 resident ancestor fallback 的交互；
- camera cut 时的 fail-open 行为。

若收益不足以覆盖成本，单 pass fail-open HZB 仍是合法实现；“Nyx 使用 two-pass”本身不是采用证据。

---

## 11. WebGPU 2026 Capability Contract

唯一能力口径是 `docs/WEBGPU.md`。本文不再定义一套独立的 “HighPerf-2026 Renderer”。

| 能力 | 本架构策略 |
| --- | --- |
| `core-features-and-limits` | 产品能力线必需 |
| `subgroups` | 现有 opaque Sparse Shading Bin 必需；新 geometry consumer 仅在确有实现时声明 |
| `primitive-index` | Visibility 优先 specialization；缺失时保持等价 primitive identity mapping |
| `indirect-first-instance` | 只有实际 work-slot mapping 使用时才请求；否则使用等价 mapping |
| `shader-f16` | 仅在精度审计和性能证据通过的局部路径启用 |
| BC/ETC2/ASTC | 从 adapter 支持且资产提供的 variant 中选择，不固定 BC-only |
| `timestamp-query` | 正式性能证据优先需要，不是渲染正确性前提 |
| subgroup size control | 只有固定宽度算法有证据时启用 |

以下能力不进入基础依赖：

```text
multi-draw-indirect
mesh/task shader
buffer device address
通用 bindless/resource table
64-bit atomics
仍处于 Draft 的扩展
```

Geometry bank 的数量和大小必须从实际 bind-group layout 与 device limits 反推，不能先固定“四个 128 MiB bank”再假设一定可绑定。最终设计至少要列出逐 binding 预算，并与现有 shading/raster layout 一起验证。

---

## 12. 独立 Cooker 实现与 Geometry Product 身份

### 12.1 统一输出合同，不强制统一源码

目标是允许两个面向不同 workload 的生产者：

```text
Web Runtime Cooker
  -> browser-first WASM/Worker implementation
  -> low-latency bootstrap and progressive products

Native Offline Cooker
  -> native batch implementation
  -> high-quality global analysis, packing and OEGPACK

both
  -> Virtual Geometry Runtime ABI conformance
  -> one Geometry Residency
  -> one GPU-driven Renderer
```

共用 meshoptimizer、数学函数、量化器或部分 Nyx 移植代码是可选的工程复用，不是架构不变量。不得为了 Native/WASM 源码共享而牺牲 Web 首屏延迟、Worker 调度、内存上限或渐进 publication。

### 12.2 Web Runtime Cooker 主路线

Web 路线保留 `load(urlOrBlob)` 体验：

```text
load GLB/glTF
  -> parse metadata in Worker
  -> schedule visible/important source asset or shard
  -> dedicated WASM Runtime CookSession
  -> produce standalone bootstrap product
  -> render through normal residency/Visibility
  -> build/fill richer product revisions in background
  -> optional Web Product/Page cache
```

WASM 不是 Editor-only fallback，而是 Web 生产 Runtime 的主要 Cooker 执行体。所有重 CPU 工作在 Worker 内完成；主/render thread 只保留小型协调、GPU ownership、command encoding 和 atomic publication。它不需要产生 OEGPACK，也不需要等待最终全局最优 hierarchy 才给出第一个可绘制 product。

### 12.3 Native Offline Cooker 第二路线

Native Offline Cooker 可以保持当前 batch/file-oriented 架构，并独立优化：

- 更重的 simplification 和更高质量 LOD；
- 跨 asset/shard 的全局 Page 排列和 bootstrap locality；
- 更高内存预算和长时间压缩；
- CDN/部署前预处理和 Range Streaming；
- 极大单 mesh、低端 CPU 或无 cross-origin isolation 部署；
- CI/golden/determinism/corruption corpus 和可复现 PERF 输入。

它不再是使用 OEngine 的前置条件，也不对 Web Cooker 的线程模型、中间表或算法选择拥有控制权。

### 12.4 实现组织可以不同，Nyx 算法不变量不能不同

| 维度 | Web Runtime Cooker | Native Offline Cooker |
| --- | --- | --- |
| 主目标 | TTFMF、可取消、可限流、边 Cook 边渲染 | 总质量、体积、全局 locality、发布确定性 |
| Bootstrap | 优先快速构建独立 coarse product | 可用全局分析构建更小/更优 bootstrap cut |
| Hierarchy | 可以分 shard、分 revision 渐进构建 | 可以全局构建后一次冻结 |
| Page packing | 在 V3-compatible decoded profile 下按 Nyx page-local/独立页不变量输出，偏向低延迟和有界 working set | 在同一 Nyx page-local/独立页不变量下偏向压缩率、Range locality 和长期驻留效率 |
| 调度 | camera/source priority，dynamic CPU budget | 批处理吞吐，可用更多 CPU/RAM |
| 持久化 | 可选 Web cache，不强制完整 pack | OEGPACK 是主产物 |

上表的不同只表示任务调度、预算、参数和序列化时机不同，不表示可以替换算法。两者都必须从第 18 节列出的 Nyx 源函数/Shader entry point 完整移植，并分别接受同一组不变量与 conformance corpus；如果某个 WebGPU 限制要求变化，必须记录为平台适配，不得变成自行重写的简化算法。

### 12.5 Runtime ABI conformance

Producer-neutral Runtime ABI 至少要冻结：

```text
runtime profile/version
product identity/revision/generation scope
Hierarchy/Group record semantics and alignment
Page size/layout/decode profile and validation
vertex pulling format and material-domain routing
conservative bounds/error and legal refinement relation
complete bootstrap cut and required Page set
capacity/overflow/rejection rules
publication/replacement/retire semantics
```

一个 Cooker 通过 conformance 的标准是：它的 product 能被同一 Geometry Residency、GPU hierarchy/work 和 Visibility consumer 正确消费。不要求 Web 与 Offline 输出具有相同 Group 数、Page 顺序、simplification 结果或 content hash。应分别使用 Runtime ABI oracle、合法 cut corpus、bounds/error oracle、payload validation 和真实 Renderer consumer 证明兼容性。

### 12.6 Product Identity 与 Dedup

Source hash 不能单独决定 cooked product identity。至少需要：

```text
source content identity
producer kind: web-runtime | native-offline
producer implementation/toolchain version
cook recipe and quality profile
semantic/material/alpha interpretation
vertex/texture format profile
runtime ABI and page/layout profile
cooked product content identity
```

GroupID 和 PageID 不是跨 Cooker 的 source-global identity；它们只在 product identity/revision 中有意义。同一 GLB 的 Web product 与 Offline product 不得按 pageId 直接混用。当 cache/CDN 提供更高质量 Offline product 时，Runtime 应将它作为新 product revision 完整 admission，并在 bootstrap cut resident 后原子替换旧 product。

纹理 dedup 同样不能忽略 color space、normal-map 语义、alpha cutoff/coverage、mip recipe 和物理格式。可共享 source blob identity，但物理 payload dedup 必须基于 cooked payload 与解释语义。

### 12.7 Geometry 正确性不变量

Web 和 Offline 可以使用不同线程/任务编排和输出时机，但都必须完整移植并保留：

- accessor/range、topology 和 attribute interpretation 经验证；
- material、alpha 和 double-sided domain 不被错误合并；
- position-remap topology 与 attribute seam protection；
- coarse Group 的 refinement 关系指向合法 finer Group；
- parent/refinement error 单调且 conservative；
- culling bounds 覆盖被替代的 finer geometry；
- 任意选择结果构成无裂缝、无重叠的合法 cut；
- Group 不跨当前 runtime profile 的 Page；
- bootstrap cut 完整覆盖 asset；
- simplification fallback 必须带 flag、放大 error 并计数，不能隐式冒充高质量结果。

Nyx 的 `meshlet -> Group -> simplify/regroup -> hierarchy -> Page` 是两个 Cooker 都必须逐项移植的算法流程；允许 Web/Offline 在调度、内存 owner、压缩时机和参数 profile 上不同，不允许用“参考流程”名义删除其中任何阶段。

### 12.8 Meshlet、Group 与量化参数

Nyx 的 128 vertices/128 triangles 和当前 OEngine raster bucket 只是已知基线，不是所有 producer 必须共享的 recipe 常量。参数或算法变更必须同时评估：

```text
meshlet occupancy
Group simplification quality
hierarchy depth and traversal work
indirect/raster bucket distribution
vertex pulling bandwidth
tail/degenerate invocation waste
Page packing waste
TTFMF, convergence time and total frame cost
```

位置、normal/tangent、UV 和 color 的量化必须由所声明 runtime profile 和 decode oracle 约束。任何更紧凑格式都要扩张 conservative bounds、验证数值误差，并保证 product adapter、TypeScript/GPU mirror 和 WGSL consumer 一致。

### 12.9 每个 Producer 自身的确定性

确定性是 producer-profile-local 合同，不是 Native/Web 相互字节 parity：

```text
source content
+ producer kind/version/toolchain
+ recipe/quality profile
+ runtime ABI/layout profile
  -> stable product identity and cache key
```

在同一 producer profile 内，已声明的确定输入必须产生稳定 product revision、Group/Page ordering、bootstrap 选择和 payload hash。若并行算法不能保证 byte-identical，必须把非确定因素纳入 producer version/identity，不能让相同 cache key 对应不同 payload。

### 12.10 当前代码的正确定位

当前 `OEngine/tools/oengine-asset-core` 保持 Native Offline Cooker 身份是合理的：

```text
ImportGltfCanonical(path)
  -> cgltf_parse_file / cgltf_load_buffers
  -> CookGeometryAssetV3
  -> AssemblePack
  -> WriteFile + reopen validate
```

未来 Web Runtime Cooker 可以复用其中经证明适合 WASM 的函数，也可以建立独立的 browser-first C++/WASM 移植；Native 与 Web 不要求共享源码，但两边都必须以第 18 节的函数级映射完成 Nyx 算法移植。必须新建的不是“共享 Core 外壳”，而是：

```text
Web GLB/Range Source
Web Runtime CookSession + Worker scheduler
WebCookProductAdapter
GeometryProductSource / Admission contract
Product/Page cache adapter
```

尤其不能通过 Emscripten 虚拟文件系统塞入完整 GLB、调用现有 Native CLI、等它写完整 OEGPACK，再把文件读回 JS。那只是把离线 batch 流程搬进浏览器，仍然有双倍内存、全量等待和无效压缩/解压。

---

## 13. 纹理：渐进传输与真实显存驻留分离

### 13.1 当前事实

当前 `TextureResidency` 创建完整 `mipLevelCount` 的 `GPUTexture`，并建立不可变 view/bind group。由此得到：

- 延迟下载/解码/上传高 mip 可以降低网络、CPU 和 upload 峰值；
- 不能仅用 `residentMinMip` 声明未上传 mip 的显存已被引擎释放；
- promotion/eviction 如果更换物理纹理，需要稳定逻辑 handle、generation 和 submission-safe bind publication。

### 13.2 模式 A：网络渐进

```text
create full logical texture allocation
  -> upload mip tail
  -> clamp sampling to available mip
  -> progressively upload higher detail
```

该模式首先优化 TTFMF、下载和上传，不承诺真实 VRAM residency savings。它可以作为较低风险的第一条垂直闭环。

### 13.3 模式 B：真实物理 mip residency

需要新的物理资源模型，例如：

```text
TextureHandle
  -> TextureResidencyTable
  -> bindingSet + physicalTier/atlasRegion + layer + generation
  -> immutable GPUTextureView / bind group
```

可选实现包括 mip-tier texture arrays 或 compressed physical atlas。它们会改变绑定、promotion、eviction、sampling completeness 和 memory accounting，必须单独写 spec，并用真实显存/预算证据证明收益。

### 13.4 不提前决定 `.oetpack`

只有现有 texture container 无法表达所需 partial range、校验、identity 或压缩布局时，才引入新 `.oetpack`。Geometry Page 与 Texture Mip 不强行共享 heap、反馈队列或 eviction policy。

Virtual Texturing/tiled physical atlas 不属于基础渐进纹理决策；若 workload 证明需要，应另立 ADR。

### 13.5 Mip tail 与可采样下限

每个进入 active material 的纹理必须始终拥有可采样的最低质量表示：

```text
resident mip tail
或显式 semantic placeholder
```

缺少高分辨率 mip 应表现为较低清晰度，不得产生未定义采样、黑贴图或访问未初始化内容。LOD clamp、view 范围、sampler 行为和 promotion publication 必须形成完整合同。

Alpha MASK 纹理更严格：如果 raster 需要 alpha coverage，最低可用 alpha 表示属于 geometry renderability dependency。在它尚未发布时，相关 geometry 不能被错误地当作完整 opaque，也不能进入读取无效 alpha 的 MASK path。具体选择可以是 pinned alpha mip tail、独立 alpha-only representation 或明确 placeholder policy。

### 13.6 Stable handle 与绑定发布

Material 保存稳定的逻辑 TextureHandle/route，而不是 GPUTexture/GPUTextureView 临时对象。物理 tier promotion 或 eviction 时：

```text
prepare new physical texture/view/binding
  -> upload and validate required mips
  -> publish new handle generation/route
  -> future frozen frame revision consumes it
  -> retire old view/bind group after submitted-work boundary
```

不能原地修改不可变 `GPUTextureView` descriptor，也不能让同一冻结帧同时看到新旧半状态。真实物理 residency 如果改变 `TextureBindingSet`，还必须计算材质重新分桶、bind group rebuild 和 shader branch 成本。

### 13.7 Codec 与 variant

Cooker 可以为 baseColor、normal、occlusion/ORM、emissive 等语义选择不同 GPU-native 格式，但 runtime 必须按 `docs/WEBGPU.md` 从实际启用的 BC/ETC2/ASTC 或显式 uncompressed variant 中选择。不能把 BC7/BC5/BC4 写成所有目标 adapter 的唯一生产答案。

KTX2/Basis 可以继续作为 authoring、工具链中间格式或特定 deployment variant；是否 runtime transcode 由下载字节、Worker 时间、峰值内存、上传时间和 CDN variant 成本共同决定，不以“终极架构”名义预先禁止。

Compressed texture upload 还必须满足 block footprint、mip 尺寸和 copy alignment；使用 buffer-to-texture copy 时 `bytesPerRow` 遵守 256-byte 对齐。`texture-compression-unaligned` 只有在 API/类型、adapter feature 和真实资产 consumer 都就绪时才能进入对应 specialization。

### 13.8 Texture demand 与 geometry 分离

Geometry Page 和 Texture Mip 的优先级可以相互提供 dependency hint，但它们拥有不同的：

```text
element ABI
physical allocation
sampling completeness
upload alignment
eviction cost
binding publication
evidence counters
```

第一版不强行共享 GPU feedback queue、physical heap 或 eviction policy。只有共同调度确实减少 CPU/IO 成本且不模糊生命周期时，才在 scheduler 层合并协调。

---

## 14. First Meaningful Frame 与性能目标

“首帧”必须定义为可观察的产品结果，而不是完成某个 Promise：

```text
场景已通过 admission
bootstrap geometry 构成合法 cut
必要材质/占位纹理或 mip tail 可采样
现有 MainRenderPipeline 产生正确 Visibility 与最终像素
没有同步 readback 或全资产等待
```

需要记录的指标包括：

### 14.1 指标集合

#### Loading

- catalog/metadata bytes 与时间；
- bootstrap compressed/decoded/upload bytes；
- Time To First Meaningful Frame；
- Time To Interactive；
- full-quality convergence time；
- main-thread long task。

#### Residency

- resident/pinned/retiring bytes；
- request、dedup、stale、retry、failure 数；
- queue capacity/high-water/overflow；
- page miss、ancestor fallback、thrash；
- readback/upload bytes per frame；
- wasted page bytes 和 useful resident ratio。

#### GPU

- hierarchy/culling/demand/raster/shading GPU time；
- visible Group/meshlet/triangle 数；
- bucket occupancy 和 useful invocation ratio；
- indirect slot 使用率；
- HZB pass A/B 收益；
- memory/binding specialization fingerprint。

所有预算数字在真实 workload 证明前都只是 benchmark hypothesis，不能写成已经达到的性能结论。

### 14.2 Scene startup 顺序

推荐的逻辑启动顺序是：

```text
load(GLB URL/Blob) 或 load(pre-cooked scene)
  -> source header/metadata
  -> capability、Worker/WASM memory 与 GPU budget admission
  -> scene nodes/material placeholders/source bounds
  -> visible-first asset/shard CookSession
  -> BootstrapProductReady 或 ProductDescriptorReady + complete legal-cut Pages
  -> material table + semantic placeholders/texture mip tails
  -> atomic scene revision publication
  -> first meaningful frame
  -> background cook + demand-driven residency refinement
```

Web GLB 路线按 scene/camera/source bounds 对 asset/shard 排序，避免按 import 顺序盲目 Cook。预烘焙路线则让 catalog、bootstrap、coarse geometry 和 mip tail 形成少量连续 Range，并把高概率共同请求的 refinement Page 放在邻近区域。Hash 顺序或 asset import 顺序都不能自动视为最优启动顺序。

### 14.3 固定 workload 矩阵

架构至少需要覆盖：

```text
small correctness scene
Bistro-class multi-material scene
Jinx/character-like dense asset
Nyx Zorah-class extreme geometry stress（仅在许可和宿主条件满足时）
```

每个 workload 应测：

```text
cold network/cache
warm HTTP cache
optional warm OPFS
stationary camera
steady flythrough
rapid rotation
teleport/camera cut
memory pressure
scene replace/cancel
device loss/recovery
corrupt/truncated Page
```

对照至少包括：

```text
current full-arrayBuffer GLB path
Web multi-Worker single-thread WASM CookSession
Web pthread/SAB WASM CookSession（部署允许时）
pre-cooked OEGPACK Range source
warm Web cache/OPFS source
任何 GPU decode/真实 texture tier 实验
```

不同对照必须固定 source bytes、adapter、CPU、总 Worker/thread 预算、cross-origin isolation 状态、分辨率/DPR、camera path、warm-up 和 capability fingerprint。同一 Web Cooker 的线程 specialization 对照应固定 recipe；Web 与 Offline 算法对照则必须同时报告各自 quality profile、几何误差、bootstrap 覆盖和最终画质，不得把不同质量的结果当作等价吞吐数据。需要分别报告 source download、cook、cache、upload 和 GPU frame 成本，不能只比较“load Promise 完成时间”。

### 14.4 初始预算是假设，不是承诺

可用于 implementation 起步的假设包括：

```text
main-thread streaming coordination 保持亚毫秒级
所有 GPU feedback 使用延迟异步 readback ring
decode/hash 不进入主线程
upload/readback/in-flight bytes 逐帧有界
GPU 紧张时优先降低后台质量收敛速度
```

但具体的 0.25 ms、0.5 ms、8 MiB/frame、256 KiB readback 等值只能由目标 adapter/workload 固定后进入 implementation 配置或 spec 上限，不能由母稿宣布为普适事实。

### 14.5 Bistro-class 目标行为

对于接近 1 GiB 的 authoring GLB，runtime 不再把“整个文件加载完成”作为进度单位，而是观察：

```text
bootstrap compressed/decoded/upload bytes
当前 camera 所需 geometry Pages
当前屏幕所需 texture detail
ancestor fallback ratio
quality convergence and residency pressure
```

首次画面应来自完整 coarse scene 和最低可用纹理表示；靠近建筑时由 projected error 触发 refinement，转向时取消/降权旧预测请求。目标是让首帧与当前可见 working set 相关，而不是与 authoring 文件总大小线性相关。

---

## 15. GLB/glTF 是 Web 主入口

产品 API 继续允许用户直接：

```text
load("scene.glb")
load(fileOrBlob)
```

但其内部语义从“加载完整 authoring object graph”改为“创建 source-backed CookSession”：

```text
GLB/glTF metadata
  -> Scene/Material/SourceAsset index
  -> visible-first Worker/WASM cook
  -> immutable Geometry Product revision/page events
  -> existing GPU Scene/Visibility pipeline
```

### 15.1 不把整个 GLB 变成一个 Worker task

当前 `GltfLoader.loadFromUrl()` 对 `.glb` 调用 `response.arrayBuffer()`，随后把完整 BIN chunk 和全部 buffer/image Promise 放进 `GltfDocument`。新路线不能只是把这段代码包进一个 Worker。

合理的 source pipeline 是：

1. 读取 GLB header 与 JSON chunk；
2. 验证 scene/accessor/bufferView/material/image 索引；
3. 建立 source asset/cook shard 和粗 bounds；
4. 按 camera/依赖/预算请求所需 BIN ranges；
5. 将一个有界 cook unit 的 ownership 转移给 Worker/WASM；
6. 通过持续 CookEvent 发布稳定结果；
7. 释放不再需要的 source ranges，或进入有界 source cache。

如果 URL server 不支持 Range、用户传入本地 Blob、source 使用 data URI，SourceProvider 可以使用完整本地字节，但仍要按 bounded cook unit 调度，不能建立无界 JS object graph。

### 15.2 Pre-cooked 是第二输入路线

预处理不是另一套 Renderer，但它可以是另一套几何生产算法。它通过 Product adapter 跳过 Web source cook：

```text
Web Runtime Cook route:
GLB -> WASM CookSession -> LiveCookProductSource

Pre-cooked route:
GLB -> independent Native Cooker -> OEGPACK -> OegPackProductSource

Both:
GeometryProductAdmission -> GeometryResidency -> one Renderer
```

从 Geometry Product admission、GPU publication、Group traversal、demand、fallback、Visibility 到 shading 完全共享。应用可以显式选择 source，也可以由部署 manifest/缓存命中决定，但不能长期维护 Web geometry renderer 与 OEGPACK renderer 两套生产路径。

### 15.3 在线 Cook 的缓存语义

第一次 Web Cook 可以把 immutable Product/Page 写入可选 content cache。第二次加载若 source validator、producer kind/version、recipe/runtime profile、product revision 和 Page hash 全部匹配，可以跳过对应 cook unit。Native OEGPACK 与 Web cook cache 不因 source 相同就相互命中。

纯 URL/ETag/Last-Modified 只能作为 provisional source key；它不是强内容身份。没有稳定 validator 时，要么读取并 hash 相关 source ranges，要么放弃跨会话强复用。缓存错误最多导致重 Cook，不能导致错误资产被发布。

### 15.4 迁移边界

删除当前完整 GLB → V2 geometry 路径的顺序调整为：

```text
Web GLB CookSession emits first complete BootstrapProduct revision
  -> bootstrap produces real Visibility pixels
  -> source cook backpressure/cancel/worker failure works
  -> richer ProductDescriptor/Page events never mutate published identities
  -> product revision replacement is atomic and submission-safe
  -> GPU demand + resident ancestor fallback works
  -> Native OEGPACK maps through the same GeometryProductAdmission
  -> main/shadow/ordinary Scene consumers use the shared Runtime ABI path
  -> source/compiled graph/browser evidence proves V2 path unused
  -> delete replaced V2 geometry cook/runtime path
```

GLB Loader 临时对象、WASM heap view、Worker message 和 source range 都不得成为长期 GPU resource owner。

---

## 16. Feature-off、失败与降级原则

虚拟化能力关闭或未创建 consumer 时：

- 不分配 demand/readback/page table/streaming heap；
- 不创建无消费者 Pass；
- 不进行后台 source read/decode；
- 不产生独立 submit；
- 不保留每帧统计扫描。

运行时失败遵循：

| 情况 | 行为 |
| --- | --- |
| GLB HTTP Range 不可用 | 记录 fallback，按 source budget 完整下载或显式拒绝超预算 source |
| WASM/Worker 初始化失败 | 当前 CookSession 失败；若存在已验证 pre-cooked source 可重路由，否则显式报错 |
| Worker crash / WASM OOM | 失效 session generation，丢弃未发布的 product revision 和 reservation；已 active 的完整旧 revision 可继续渲染 |
| Cook sink backpressure | 暂停新 cook unit/Page emission，不阻塞 render frame |
| source/cook corruption | 当前 asset/shard/product revision 保持 unpublished；旧 active revision 和其他独立 asset 可继续 |
| Web/Offline product 身份或 profile 不匹配 | 拒绝 admission，不按相同 pageId/hash 混合两个 producer 的输出 |
| desired Page 缺失 | 绘制合法 resident ancestor/bootstrap，产生 bounded demand |
| demand overflow | 保持 fallback，记录 overflow，后续帧重试/降级调度 |
| page corruption/decode failure | 保持 non-resident，记录失败，不发布零页 |
| bootstrap 超预算 | admission 失败、延迟 asset 或显式 placeholder |
| stale generation | 丢弃请求/完成结果，视为 non-resident |
| upload budget 用尽 | 延迟 publication，不阻塞 frame |
| device loss | 使 GPU publication 失效并从 bootstrap 重建 |
| OPFS 不可用 | 回到其他 range source，不改变正确性 |
| cache identity 不可信或不匹配 | cache miss 并重新 Cook/读取 canonical source |

---

## 17. Deferred 与独立课题

以下能力不能借 ADR-0016 自动进入生产基线：

- GPU geometry decompression；
- software/hybrid microtriangle raster；
- Virtual Texturing；
- GPU texture feedback map；
- OPFS 作为 correctness 依赖；
- predictive/ML streaming；
- 可变 geometry page size；
- meshopt stream + LZ4 双重编码；
- 通用 bindless 或 sized binding arrays；
- multi-draw-indirect、mesh/task shader、buffer device address。

它们只有在当前 Hardware-first 路径出现可测量瓶颈，且独立 ADR/spec/benchmark 证明收益后才能进入。

---

## 18. Nyx 到 OEngine 的可追溯映射

### 18.1 移植来源、快照与硬性规则

本节是本提案对 Nyx 复用的唯一明确说明。Nyx 使用用户提供的本地只读快照 `D:\Nyx-main`；该目录当前不是可读取 Git history 的仓库，因此不虚构 upstream commit。来源身份由快照路径、核验日期（2026-09-16）和源文件 SHA-256 固定：

| Nyx 源文件 | SHA-256（lowercase） | OEngine 移植目标 |
| --- | --- | --- |
| `MiniEngine/Model/MeshletBuilder.cpp` | `b749346382b0f9a1574f0c0566a2860bff2acfbc6521df6f153a42653c81e84a` | Web/Offline geometry product builder；meshlet、Group、LOD、简化、hierarchy/page 生产 |
| `MiniEngine/Model/ModelConvert.cpp` | `8bdf016e0f36e70f0c1aa46d679ab0e1b4f57ea30e0748a6549675620cc8a059` | glTF 场景图、mesh/material 归属、并行 mesh build、metadata 组装 |
| `MiniEngine/Model/MeshletStructs.h` | `1edfaa25d2e12067b98d93599142b110e2509be96471fa09a00b029484ef9b23` | Group/Meshlet/Hierarchy 语义与字段不变量；不直接把 DX12 struct 当 WebGPU ABI |
| `MiniEngine/Model/GeometryStreaming.cpp` | `acb3aa4786eb6367e92b99e9e295c83e0aade516d59578f23ff38496f838a072` | root pin、page request mask、异步 I/O、三缓冲 readback、address-table/eviction 生命周期 |
| `MiniEngine/Model/GeometryStreaming.h` | `4bee73ffc0c29ad7670bb7c5ac1567a281b3f33271adfc534d834dc88897c264` | streaming owner/public seam |
| `MiniEngine/Model/Shaders/DAGCull.slang` | `6534dd8794248d693acd07488653a625df3b4fac11117f96537a43857dcfee7e` | DAG/BVH traversal、SSE、resident check、refinement、request mask、bounded work 生产 |
| `MiniEngine/Model/Shaders/VBufferMesh.slang` | `9f374a2437d5ab939ae4d98289c150097bdab17305191ff97abf3fd1d13c621d` | meshlet vertex pulling、local primitive identity、Visibility buffer 输出 |

Nyx 仓库自身的 README 明确记录了其技术边界：DirectX 12、Slang、mesh shader、`DispatchMesh`、两遍 frustum/HZB、256 KiB page、256 MiB chunk、LZ4 page 和 GPU request mask。其许可证声明为 Nyx/MiniEngine MIT；bundled meshoptimizer、cgltf、LZ4、Slang、DXC 等第三方许可证仍分别以 `D:\Nyx-main\MiniEngine\ThirdParty` 和 notice 文件为准。OEngine 不复制 Nyx runtime、DX12 root signature、Slang reflection 或 `.mini` 文件格式。

以下是硬性移植规则：

1. **算法必须移植，不得自行发明等价简化版。** Meshlet 构建、Group 划分、属性保护锁、简化接受/拒绝、refine 关系、误差传播、BVH/DAG 构建、SSE、resident ancestor fallback、request 生成、page 独立性和 meshlet-local primitive identity，必须以表中 Nyx 函数/Shader 为源逐项移植。只保留“有 meshlet、有 LOD、有 streaming”的概念不算移植。
2. **允许改的是平台和边界，不是算法不变量。** 允许把 C++/Slang 翻译为 WASM C++、TypeScript 胶水、WGSL，把 DX12 resource/bindless/mesh shader 映射到 WebGPU 已验证的 buffer、indirect draw、bounded queue 和现有 raster consumer；允许把 Nyx 文件 I/O 接到 HTTP Range/GLB source、把 DX12 fence 接到提交序号/retire queue、把 64-bit GPU 地址改成 bank/slot/generation。
3. **禁止以性能或“WebGPU 不支持”为理由偷换算法。** 禁止用简单均匀 LOD、单层 BVH、CPU 全量可见列表、按对象逐 draw、整包常驻、随机/first-fit page packing、只 pin root 不做 request/fallback、删除 attribute lock、删除 error propagation、删除 coarse-to-fine refinement 或直接改成普通 triangle renderer 作为正式实现。若 WebGPU 能力不足，必须保留 Nyx 不变量并新增明确的 OEngine 适配层、fallback 或独立 capability gate。
4. **每个移植项必须有 traceability record。** 记录 Nyx 文件、函数/entry point、输入输出、保留不变量、OEngine 文件、WebGPU 差异、fallback、许可证和 CPU/WASM/WGSL oracle。没有来源和不变量记录的代码不得进入生产路径。
5. **算法实现可以分别存在于 Web Runtime Cooker 与 Native Offline Cooker，但不能各自重新发明。** 两个 Producer 可以按不同预算组织任务和序列化，但只要实现 Nyx 覆盖范围，就必须分别对照同一源函数/不变量完成移植；允许输出不同 ProductID/PageID 和不同字节，不允许省略算法阶段而把“质量差异”伪装成 producer 差异。

### 18.2 逐文件、逐阶段移植矩阵

| Nyx 源与函数/入口 | 必须保留的算法行为 | OEngine 适配方式 | 明确不允许 |
| --- | --- | --- | --- |
| `MeshletBuilder::Build`、`BuildLOD0Meshlets`、`BuildMeshletsFromIndices` | 三角形输入、meshlet 顶点/三角形上限、local/global index、winding、bounds | 输出 `Geometry Product V1` 的 V3-compatible Group/Meshlet payload | 只按固定三角数切片而跳过 Nyx clusterizer 语义 |
| `GeneratePositionRemap`、`GroupMeshlets`、`BuildVertexLocksByGroups` | position remap、同 LOD 分组、跨 Group seam lock、attribute protect lock | WASM/Native 各自移植，保留 material-domain 边界 | 删除 seam/attribute lock 以换取更快简化 |
| `SimplifyGroup` | local vertex/index 重建、`simplifyWithAttributes`、显式 permissive/sloppy fallback、failure ratio、error scale | 输出 Group error、fallback flag 和 conformance counter | 用任意独立 decimator 或无记录的简化替代 |
| `SerializeGroup`、`BuildStreamingData` | GroupHeader/MeshletHeader 语义、refineGroup 关系、每 LOD BVH、top BVH、coarse-first、page-local payload | 写入 OEngine little-endian V3-compatible decoded profile | 只生成扁平 meshlet 列表或把未冻结 DAG 暴露给 Runtime |
| `BuildHierarchy`、`ValidateBuild` | bottom-up hierarchy、child order、可达性、LOD/error 单调性、bounds 包含关系 | TypeScript/WASM/Native 共用 oracle 语义；ABI 另行编码 | 只检查数组不越界，不做 Nyx 几何/LOD 不变量验证 |
| `ModelConvert::WalkGraph`、`ParallelCompileMeshes`、`BuildModel`、`SaveModel` | scene graph transform、material/mesh domain、并行构建结果合并、metadata 组装 | Web Runtime Cooker 做 Range-aware canonicalization；Offline 保留 batch writer | 把整个 GLB 当一个无界 Worker task，或跳过 scene/material 归属 |
| `GeometryStreaming::Initialize`、`PinRootPages` | hierarchy/page request mask 初始化、root/bootstrap pin、容量检查 | Product admission + fixed slot bank + activation cut | 无预算地 pin root，或用整包预加载冒充 residency |
| `GeometryStreaming::Update`、三缓冲 readback | 延迟 request mask 消费、异步 I/O 调度、清零下一轮 request | WebGPU rotating readback ring；不得在当前帧 await map | 同帧 readback、CPU 重建最终可见列表 |
| `ReadPageFromFile`、`EnqueueAsyncLoad`、`OnPageIOComplete` | page 独立读取、失败不发布、解压/校验后再上传、请求去重 | OEGPACK Range adapter 或 Web Cook Provider；Transferable page block | 返回零页、忽略 checksum/hash、失败页继续 resident |
| `SyncMemoryAndAddressTable`、`ImmediateEvict` | revoke -> retire -> 安全复用、address table 一致性、eviction 预算 | bank/slot/generation、提交序号 retire queue、原子 Product revision | 先复用 slot 再等 GPU、无 generation 防 ABA |
| `DAGCull::ProcessNodeBatch`、`ProcessMeshletBatch`、`computeMain` | wavefront/batch traversal、frustum/HZB、SSE、resident check、coarse fallback、refinement request、bounded reservation | WGSL + `GpuWorkGenerationAbi`/Demand ABI；GPU producer 直接给 indirect consumer | CPU LOD 遍历、无限 queue、只做 frustum 不做 HZB/误差/refinement |
| `VBufferMesh::BuildVertexOutput`、`meshMain`、`pixelMain` | page-local vertex pulling、meshlet local triangle、primitive identity、Visibility buffer 语义 | 适配现有 `MeshletBucketRaster`/VisibilityKey，不复制 mesh shader backend | 退回普通 per-object draw 或丢失 local primitive identity |

### 18.3 移植顺序与“完整”定义

移植顺序必须遵循 Nyx 的数据依赖，而不是先写一个“看起来能跑”的简化版本：

```text
Nyx structs/invariants
  -> LOD0 meshlet + bounds
  -> position remap + Group + seam/attribute locks
  -> attribute-aware SimplifyGroup + error/refine propagation
  -> per-LOD BVH + top BVH/DAG + ValidateBuild
  -> Group/page serialization and bootstrap cut
  -> streaming request mask + delayed readback + page IO/decode
  -> address table publication + ancestor fallback + eviction
  -> DAG traversal/work generation
  -> meshlet raster + local primitive Visibility identity
```

一个阶段只有在其 Nyx 源函数的所有保留不变量都有 oracle、并且下游真实 consumer 已消费其结果后，才能标记完成。`portable-single`、`portable-pool`、`isolated-pthreads` 只是执行 profile，不得成为删除算法阶段的理由。首个 Web bootstrap 可以是 Nyx 算法产生的 coarse、完整 immutable product；如果全局 hierarchy 尚未冻结，则必须使用独立 bootstrap product 或确定性 spatial shard，不能暴露半成品 DAG。

### 18.4 移植验收与反简化门禁

每个 Nyx 移植切片必须同时提交：

- source provenance：本地路径、快照日期、SHA-256、第三方 license/notice；
- function map：Nyx 函数/Shader entry point 到 OEngine 文件、WASM 函数或 WGSL entry point；
- invariant checklist：meshlet limits、seam/attribute locks、simplification flags/error、refine/error monotonicity、bounds、BVH/DAG reachability、page independence、request/fallback、primitive identity；
- differential corpus：相同输入下 Native Nyx 参考输出、OEngine Offline 输出、OEngine Web 输出的结构化对照；允许布局/ID/压缩字节不同，但必须证明几何误差、拓扑、bounds、LOD/refine 和可绘制 cut 满足合同；
- negative corpus：非法 hierarchy、跨页 Group、corrupt page、stale generation、overflow、取消、device loss 和缺页 fallback；
- 运行证据：真实浏览器中从 Product page 到现有 `GpuAssetStore -> GpuRenderWorld -> hierarchy/work -> MeshletBucketRaster -> VisibilityKey` 的 producer-consumer 闭环。

以下任一情况都不得称为“Nyx 已移植”：只引用 README/论文而无函数级来源；只移植 OEGPACK writer 而没有 `DAGCull`/`GeometryStreaming`/`VBufferMesh` 消费逻辑；只保留 LOD0 或 root pin；用 CPU 生成最终 visible list；用新自研 decimator/BVH/streaming 算法替代表中 Nyx 行为；或只通过 TypeScript unit test 而没有真实 GPU consumer。

| Nyx 本地来源 | 保留内容 | OEngine owner/方向 | 不保留内容 |
| --- | --- | --- | --- |
| `MeshletBuilder.cpp` | Group build、simplification、refinement、hierarchy 不变量 | Offline Cooker 的已有移植；Web Cooker 按同一函数级矩阵完整移植，可改写语言/内存 owner 但不可改算法 | C++ 内存布局即 Runtime ABI、强制两端共用源码、用自研简化器替换 Nyx |
| `ModelConvert.cpp` | page packing、coarse/bootstrap-first、独立压缩思想 | Native OEGPACK writer 与 Web Product builder 分别适配 | `.mini` 格式、256 MiB chunk 和“Web 必须写 pack”假设 |
| `MeshletStructs.h` | compact hierarchy、GroupHeader/MeshletHeader 语义 | OEGPACK V3 mirror + Producer-neutral Runtime profile oracle | DX12/Slang struct 直接作为 WebGPU ABI |
| `GeometryStreaming.cpp` | page state、root pin、async I/O、readback ring 骨架 | Virtual Geometry Runtime V1 | partial root pin、full bitset scan、zero-page publish、unsafe slot reuse |
| `DAGCull.slang` | GPU traversal、request、resident check、refinement 思路 | existing hierarchy/work generation | bindless DX12 handle 与 Mesh Shader dispatch |
| `VBufferMesh.slang` | meshlet-local primitive identity、Visibility-first | `MeshletBucketRaster`、VisibilityKey | `DispatchMesh` 和 Nyx VBuffer packing |

---

## 19. Implementation 落地状态与保留 Gate

上述问题现已进入正式文档：

- `geometry-product-v1.md` 冻结 Producer-neutral descriptor/page/provider、ID scope、activation cut、source identity 和 cache key 语义；
- `virtual-geometry-runtime-v1.md` 冻结 admission/page/location/demand ABI、publication、fallback、backpressure、eviction 与 device-loss 语义；
- `0016-virtualized-assets.md` 将交付拆为从共同 bootstrap consumer、Web GLB Runtime Cook、并行 refinement、GPU demand/residency，到 replacement/cutover/texture 的可运行垂直切片。

以下项目有意保留为 evidence gate，而不是在母稿中猜定：

1. `portable-pool` 与 `isolated-pthreads` 谁是默认 Web 执行 profile，等待固定总线程预算的真实 PERF；cross-origin isolation 不是 correctness 前提。
2. 巨大单 primitive 的 spatial shard 算法与边界，先在普通 GLB bootstrap 闭环后以独立切片验证。
3. product metadata 的最终 GPU binding 组合、geometry bank 数和跨 bank 路由，等待首个 production consumer 在真实 device limits 下冻结。
4. GPU 去重可采用 bitset 等内部实现，但 `GeometryPageDemandV1` queue ABI、capacity/overflow 与 ancestor fallback 语义已经进入 spec。
5. OPFS/Product cache 只有在 profile 证明重复 source/cook 是瓶颈后实施；Web live Page 默认不先做 LZ4 往返。
6. Texture Mode B 和 Virtual Texturing 分别等待真实 allocation 瓶颈证据与独立 ADR。

这些 Gate 不阻塞 S1～S5 的主闭环，也不能成为建立第二 renderer、发布可变 DAG 或引入无界 Worker/内存队列的理由。

---

## 20. 参考与权威路由

### OEngine 权威文档

- `docs/adr/0016-virtualized-assets.md`
- `docs/adr/0016-a-geometry-pack-and-cooker.md`
- `docs/adr/0016-b-virtual-geometry-residency.md`
- `docs/adr/0016-c-v3-geometry-consumption.md`
- `docs/adr/0016-d-progressive-texture-residency.md`
- `docs/specs/oegpack-v3.md`
- `docs/specs/virtual-geometry-runtime-v1.md`
- `docs/implementation/0016-virtualized-assets.md`
- `docs/PRODUCT.md`
- `docs/WEBGPU.md`
- `docs/ARCHITECTURE.md`
- `docs/PIPELINE.md`
- `docs/STATUS.md`
- `docs/VALIDATION.md`
- `docs/porting/geometry.md`

### OEngine 当前源码

- `OEngine/src/assets/GeometryAbiV3.ts`
- `OEngine/src/assets/OegPackV3.ts`
- `OEngine/src/assets/RuntimeAssetResidency.ts`
- `OEngine/src/gpu/GeometryBootstrapResidencyV3.ts`
- `OEngine/src/gpu/GpuAssetStore.ts`
- `OEngine/src/gpu/TextureResidency.ts`
- `OEngine/src/render/MeshletBucketRaster.ts`
- `OEngine/src/render/pipeline/MainRenderPipeline.ts`
- `OEngine/tools/oengine-asset-core/`

### Nyx 本地源码

- `D:\Nyx-main\README.md`
- `D:\Nyx-main\THIRD_PARTY_NOTICES.md`
- `D:\Nyx-main\MiniEngine\Model\MeshletBuilder.cpp`
- `D:\Nyx-main\MiniEngine\Model\ModelConvert.cpp`
- `D:\Nyx-main\MiniEngine\Model\MeshletStructs.h`
- `D:\Nyx-main\MiniEngine\Model\GeometryStreaming.cpp`
- `D:\Nyx-main\MiniEngine\Model\Shaders\DAGCull.slang`
- `D:\Nyx-main\MiniEngine\Model\Shaders\VBufferMesh.slang`

---

## 21. 最终架构形态

目标形态不是“WebGPU 版 Nyx clone”，也不是“必须预处理后才能使用的私有格式引擎”，而是：

```text
OEngine existing GPU-driven renderer
  + load(GLB/glTF/Blob) Web product entry
  + independent browser-first Worker/WASM Runtime Cooker as primary route
  + independent Native/C++ Offline Cooker + OEGPACK as secondary route
  + Producer-neutral Virtual Geometry Runtime ABI
  + shared GeometryProductAdmission and Geometry Residency
  + immutable progressive Product revisions
  + Group/DAG legal-cut selection
  + bounded GPU demand feedback
  + asynchronous generation-safe residency
  + resident ancestor fallback
  + evidence-gated progressive texture delivery/residency
```

Nyx 提供几何虚拟化与 streaming 的成熟算法和状态骨架；OEngine 的 Web Runtime Cooker 与 Native Offline Cooker 必须分别对照第 18 节完成可追溯移植，不强制收敛到同一源码或执行编排，但不得自行发明或偷减 Nyx 算法阶段。两条路线在 Producer-neutral Geometry Product 合同处汇合，然后共享 OEngine 的 Runtime Asset ownership、GpuScene、Geometry Residency、VisibilityKey、Sparse Shading、统一 MainRenderPipeline、WebGPU capability negotiation 和浏览器证据体系。

这份母稿的用途，是固定这些边界并暴露 implementation 必须解决的问题，而不是提前把尚未验证的性能目标写成已接受、已实现或已完成的事实。
