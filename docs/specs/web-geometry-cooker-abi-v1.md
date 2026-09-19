# Web Geometry Cooker ABI V1

Status: draft

Owners: `oengine-web-geometry-cooker`、Dedicated Worker glue、Web CookSession

## Version/Compatibility

ABI major 2；未知 version、非 canonical section offset、非零 reserved/padding 或未知 flag 必须拒绝，不做 best-effort 解码。major 1 的 consumer 必须显式拒绝 major 2 的模块，major 2 的 consumer 必须显式拒绝 major 1 的模块：两阶段的 handle 语义与 identity 定义都改变了，静默接受会让 consumer 把 descriptor-stage handle 当作已完整物化的 Product。

## Contract

本 ABI 只跨 `Dedicated Worker TypeScript <-> browser-first WASM` 边界。它把一个或多个已经按 glTF 语义 canonicalize 的 material domain 交给 Nyx geometry builder，并返回 `Geometry Product V1` 的 `oengine-vg-v1-v3-decoded` tables/pages。它不接受路径或 URL，不读取虚拟文件系统，不生成 OEGPACK，不创建 GPU object，也不拥有 Runtime publication。

cook 分两个可分离阶段。descriptor 阶段只冻结完整 ID graph（page count、每 PageID identity、page-to-Group 映射、activation cut），不产生任何 page payload；payload 阶段按 PageID 推进并把已就绪的页拷出。两阶段必须共用同一份装箱与 identity 推导实现，因此对同一输入，单体式入口与两阶段入口必须在 descriptor section 和逐页 payload 上 byte-identical。所有整数和 f32 都是 little-endian。所有 offset 从输入 buffer 起点计算；section 按下述顺序紧密排列并 16-byte 对齐；padding 必须为零。计数、offset 和总长度是 u32，任何乘加溢出均拒绝。

### Canonical input header

Header 固定 128 bytes：

| Byte | Type | Field |
| ---: | --- | --- |
| 0..7 | `u8[8]` | `OEWGCAN\0` |
| 8 | `u32` | ABI version = 2 |
| 12 | `u32` | header bytes = 128 |
| 16 | `u32` | total bytes，含末尾 16-byte padding |
| 20 | `u32` | domain count，必须非零 |
| 24 | `u32` | total vertex count |
| 28 | `u32` | total index count，必须是 3 的倍数 |
| 32 | `u32` | domain table offset，必须为 128 |
| 36 | `u32` | vertex table offset |
| 40 | `u32` | index table offset |
| 44 | `u32` | vertex stride = 72 |
| 48 | `u32` | domain stride = 32 |
| 52 | `u32` | flags = 0 |
| 56..127 | `u8[72]` | reserved = 0 |

每个 32-byte domain record：

| Byte | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | material ID；`0xffffffff` 表示无 source material |
| 4 | `u32` | V3 meshlet material flags；OPAQUE/MASK/BLEND 必须且只能选一项 |
| 8 | `u16` | V3 attribute mask；POSITION 必需 |
| 10 | `u16` | flags；bit 0 = generate normals，bits 1..15 = 0 |
| 12 | `u32` | vertex begin |
| 16 | `u32` | vertex count，至少 3 |
| 20 | `u32` | index begin |
| 24 | `u32` | index count，非零且为 3 的倍数 |
| 28 | `u32` | reserved = 0 |

Domain 必须按表顺序完整 partition vertex/index tables，不允许 alias、gap 或未归属记录。`generate normals` 与 NORMAL attribute bit 必须互斥；设置时 WASM 使用与 Native importer 相同的面积加权三角形累积和 normalize 规则，然后把 NORMAL 加入 canonical identity。

每个 72-byte vertex 是 18 个 f32：`position[3]`、`normal[3]`、`tangent[4]`、`uv0[2]`、`uv1[2]`、`color[4]`。所有值必须 finite。缺失 optional attribute 使用 canonical defaults，但只有 attribute mask 声明的字段进入 source identity/简化 attribute lock。Index 是 domain-local u32 且必须小于该 domain vertex count。

### Recipe input

Recipe 固定 96 bytes，magic 为 `OEWGRCP\0`，version = 2，bytes = 96。其余字段按顺序为：

```text
16 meshletMaxVertices u32
20 meshletMinTriangles u32
24 meshletMaxTriangles u32
28 groupTargetMeshlets u32
32 coneWeight f32
36 clusterSplitFactor f32
40 simplifyTargetRatio f32
44 simplifyFailureRatio f32
48 simplifySloppyFailureRatio f32
52 flags u32: bit0 simplifyPermissive, bit1 sloppyFallback
56 sloppyErrorFactor f32
60 minimumLodReduction f32
64 lodErrorMergeFactor f32
68 hierarchyFanout u32 = 8
72 pageShift u32 = 18
76 rawCodecThresholdBytes u32
80 bootstrapGeometryBudgetBytes u64
88 deterministicSeed u32
92 reserved u32 = 0
```

字符串型算法身份固定为 `GeometryCookRecipeV3` 的 Nyx/V3 constants；WASM 用 production-authoritative `ValidateRecipe()` 和 `CanonicalRecipeJson()`，返回其 SHA-256。Web/Native 若使用相同 recipe profile，recipe hash 必须相同；Product/Page 字节不因此要求跨 producer 相同。

### Result ownership and sections

`oengine_web_geometry_cook()` 返回 opaque handle。失败返回 0，诊断只能通过 bounded last-error copy 读取。Handle 在 `destroy` 前拥有 WASM 内的 immutable Product；Worker 必须在 session generation 仍有效且拥有 output credit 时，才把一个 page 拷入独占 256 KiB `ArrayBuffer` 并 transfer。普通 WASM memory 或 pthread `SharedArrayBuffer` 不得冒充 transferable ownership。

Section ID：

| ID | Bytes | Product mapping |
| ---: | --- | --- |
| 1 | `128 * assetCount` | `assetRecords` |
| 2 | `4 * rootCount` | `rootNodeIds` |
| 3 | `48 * nodeCount` | `hierarchyNodes` |
| 4 | `16 * groupCount` | `groupDirectory` |
| 5 | `32 * pageCount` | `pageRecords` |
| 6 | `4 * bootstrapCount` | `bootstrapPageIds`；第一版 activation cut 与其相同 |
| 7 | `16 * formatCount` | `vertexFormats` |
| 8 | 32 | canonical recipe SHA-256 |
| 9 | 256 KiB | decoded page；`index` 是 Product-local PageID |
| 10 | 32 | cooked content manifest SHA-256；固定纳入每张 Product table 的 SHA-256 与每页完整 decoded SHA-256 |

`assetCount` 等于 canonical input 的 domain count：Web profile 把每个 canonical material domain 映射为一个独立 Product asset，asset index == domain index == catalog primitive index。这样同一 GLB 的不同 mesh/primitive 可以由 instance geometry index 独立寻址，且不会把不同 material domain 合并进一个 asset。Offline cooker 保持自己的 mesh-level asset 粒度；Web 与 Offline 不要求共享 asset 边界、ID 或字节。

Section 10 is producer-owned identity evidence. It is calculated before the opaque handle is returned, so the browser adapter can derive `ProductID` without copying the complete page set out of WASM. The manifest is domain-separated and ordered; it is not a replacement for per-page validation when a page is later copied. Unknown glTF attribute semantics are rejected before canonical input assembly; they are never silently dropped.

Page record 布局严格复用 `Geometry Product V1`：page identity 前 16 bytes（由该页 Group payload 按升序上卷得到，见 `docs/specs/geometry-product-v1.md`）、first Group、Group count、flags = 0、reserved = 0。identity 必须能在 payload 存在之前算出来，因此它不依赖 padding 或字节偏移；整页 SHA-256 只用于传输/存储完整性校验，随页交付而不是写进 descriptor。WASM output budget 至少容纳一页；decoded pages 超过传入 budget，或 bootstrap Group payload bytes 超过 recipe bootstrap budget 时整体失败，不 offer descriptor。后者与 Native writer 的 recipe 语义一致；Product admission 仍需另按完整 pinned page bytes 预留 GPU budget。

### 两阶段入口

除单体式 `oengine_web_geometry_cook()` 外，ABI 提供三个入口，必须在头文件与 TypeScript 镜像中同步存在：

- `oengine_web_geometry_cook_plan()`：descriptor 阶段。冻结完整 ID graph 并返回 handle；handle 支持全部只读查询（section size、page count、descriptor sections）。section 9（PAGE_BYTES）在 descriptor 阶段不得返回 payload——查询它会报告该页尚未产出，而不是返回半页数据。
- `oengine_web_geometry_cook_produce_page()`：payload 阶段。推进一个 PageID；必须容忍乱序、重复与交错调用。重复产出同一 PageID 必须返回 byte-identical payload。
- `oengine_web_geometry_cook_page_status()`：只报告就绪状态，不产生任何东西。

两个入口共用一个状态码集合：`READY = 1`（payload 已产出并拷出）、`PENDING = 2`（descriptor 已声明该 PageID 但 payload 尚未产出）、`UNDECLARED = 3`（descriptor 从未声明该 PageID）。`UNDECLARED` 必须被拒绝且不得扩张 ID graph——不能因为 consumer 请求了一个未知 PageID 就改变 page count 或任何 descriptor section。`PENDING` 与 `UNDECLARED` 都不得写 destination buffer。

content manifest（section 10）覆盖每页完整 decoded SHA-256，因此它在 descriptor 阶段物理上不可能存在。单体式入口在返回前完成全部 payload，故其 manifest 有效；两阶段 handle 在 payload 全部产出前不得把 manifest 当作已就绪证据使用。

## Nyx function map

| Nyx source | Web implementation | Retained behavior |
| --- | --- | --- |
| `MeshletBuilder::Build/BuildLOD0Meshlets/BuildMeshletsFromIndices` | `GeometryCooker.cpp::BuildMeshlets/CookDomain` compiled to WASM | meshoptimizer clusterizer、local/global index、winding、bounds、128 triangle limit |
| `GeneratePositionRemap/GroupMeshlets/BuildVertexLocksByGroups` | `GeometryCooker.cpp::CookDomain/BuildSeamLocks` | position remap、LOD partition、seam/attribute protect lock、material-domain boundary |
| `SimplifyGroup` | `GeometryCooker.cpp::SimplifyGroup` | attribute-aware simplification、permissive/sloppy flags、failure ratio、error scale |
| `SerializeGroup/BuildStreamingData/BuildHierarchy/ValidateBuild` | `GeometryCooker.cpp` + `DecodedGeometryProduct.cpp` | refine relation、parent error、per-LOD BVH8/top BVH、coarse-first、page-local Group、complete bootstrap cut |

该表只覆盖 S2 producer。`GeometryStreaming`、`DAGCull` 和 `VBufferMesh` 的 request/fallback/GPU consumer 映射仍由 Virtual Geometry Runtime 切片交付，不能由本 ABI 的存在推断完成。

## Visible-first source scheduling

`SceneCatalogReady` 必须在 JSON/catalog 校验完成后、任何选中 BIN range
canonicalize 之前发出。catalog primitive entry 携带稳定的 `assetKey`、catalog
index、保守 POSITION bounds 和 source ranges。`SetSourcePriority(assetKey,
score, cameraHintRevision)` 只影响 source unit 的排序；它不是 GPU Page
demand，也不能引用尚未 offer 的 descriptor。

首个 revision 由有界的 selected unit/shard 集合生成。Range 合并和
canonicalize 完成一个 unit 后必须释放该 unit 的 source reader，再获取下一个
unit。非 progressive producer 只能明确发布 bootstrap-only cut；多 unit Web
主路线必须实现 `cookProgressive`，不能在没有 `replaces`/Scene mapping 合同
时发布互相独立的局部 Product。Nyx 的 meshlet、Group、seam/attribute-lock、
simplify/refine/error、hierarchy 和 Page 阶段保持不变，变化只限于 Worker、
range 与 WASM 的任务编排。

`RevisionOffered.sceneAssetIndices` 与 descriptor 一起传输，并按 descriptor
asset count 校验；它不能编码进 Product 二进制 section。

## Failure and lifecycle

- canonical corruption、非 finite 数据、非法 material/attribute flags、越界 index、recipe mismatch、预算不足或 Nyx validation failure：返回失败，不产生 handle/page/descriptor。
- Worker cancel/crash/OOM：销毁或遗弃整个 session generation 的 handle；已 active 的旧 Product 不受影响。
- section copy 要求 destination exact-sized；unknown section/index 和 released handle fail closed。
- Product handle 不跨 Worker，不进入 GPU owner；GPU admission 只接收复制并经过 Product validator 的 descriptor/page。

## Validation

- Native ABI oracle 与 TypeScript encoder 使用同一 cube canonical/recipe bytes SHA-256，并验证两次 cook 的所有 tables/pages byte-identical。
- Negative oracle 覆盖 total length、normal declaration、non-finite vertex、index range、reserved/padding、recipe 和 output budget。
- 两阶段 oracle 覆盖：descriptor 阶段冻结全部 ID graph、descriptor section 与单体式逐字节一致、plan 的全部 PageID 起始为 `PENDING`、倒序产出、重复产出 byte-identical、`UNDECLARED` 被拒绝且不写 destination、不扩张 page count、补齐后逐页与单体式比对、两次 plan 的 ID graph 一致。
- 已签入的 Emscripten 产物必须真实执行两阶段入口：产物测试从真实 wasm 验证 `abi_version == 2`、descriptor-before-payload、乱序与重复产出、`UNDECLARED` 语义，以及与单体式逐页 byte-identical。
- Native OEGPACK writer 必须消费同一个 `DecodedGeometryProductV1`，其既有 reopen/corruption/determinism tests 防止抽取时改变 Offline container。
- S2 退出仍要求真实 Emscripten build、Dedicated Worker session、GLB Range canonicalizer、exclusive transfer、Product admission 与浏览器像素证据；native ABI oracle 不替代这些 Gate。
## glTF 来源与作者纹理元数据（第三步）

Web source profile 明确支持：GLB、JSON `.gltf`、相对/绝对外部 buffer、data URI、外部 image URI、image bufferView，以及本地 File/Blob（通过受控 object URL）。GLB 与外部 buffer/image 读取必须验证精确 `206 Content-Range`；服务器返回 `200` 时只能在声明长度与 `wholeSourceFallbackBytes` 同时满足时采用。所有读取都接受 `AbortSignal`，source identity、credential/CORS 初始化和 object URL 在取消/释放时失效并释放。

Catalog 只传递 source identity、buffer/image range、URI、mimeType、texture/sampler 和 material slot 元数据，不把 image bytes 或 GPU 对象塞入 Geometry Product 二进制 ABI。`extensionsRequired` 中未登记的扩展必须拒绝；当前 profile 对 Draco、`EXT_meshopt_compression`、skin、morph 给出明确 capability/error，不得静默忽略或回退到 V2。

Accessor canonicalizer 保留 interleaved、normalized、non-indexed 与 sparse base-less/patch 语义；sparse index 越界、重复、range 越界和非有限结果必须失败。作者材质的 base-color、metallic-roughness、normal、occlusion、emissive 槽位保留 UV set/offset/scale/rotation、sampler 与 MASK cutoff。纹理解码在 Product Scene mapper 阶段完成，随后只通过既有 `TextureResidency.stage()`、`TextureBindingSet` 和 `StandardShadeMaterial` 提交；任何 image/decode/sampler 失败都不得发布半纹理 Product。

对于 `MASK`，只要材质声明 base-color texture，最低可采样 mip 必须和 geometry activation 一起进入同一 GPU command transaction；不可用时保留旧 active revision。Texture Mode A 仅表示网络读取、解码和上传的渐进顺序，不表示物理显存已经释放或节省。
