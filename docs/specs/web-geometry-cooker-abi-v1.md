# Web Geometry Cooker ABI V1

Status: draft

Owners: `oengine-web-geometry-cooker`、Dedicated Worker glue、Web CookSession

## Version/Compatibility

ABI major 1；未知 version、非 canonical section offset、非零 reserved/padding 或未知 flag 必须拒绝，不做 best-effort 解码。

## Contract

本 ABI 只跨 `Dedicated Worker TypeScript <-> browser-first WASM` 边界。它把一个或多个已经按 glTF 语义 canonicalize 的 material domain 交给 Nyx geometry builder，并返回 `Geometry Product V1` 的 `oengine-vg-v1-v3-decoded` tables/pages。它不接受路径或 URL，不读取虚拟文件系统，不生成 OEGPACK，不创建 GPU object，也不拥有 Runtime publication。

所有整数和 f32 都是 little-endian。所有 offset 从输入 buffer 起点计算；section 按下述顺序紧密排列并 16-byte 对齐；padding 必须为零。计数、offset 和总长度是 u32，任何乘加溢出均拒绝。

### Canonical input header

Header 固定 128 bytes：

| Byte | Type | Field |
| ---: | --- | --- |
| 0..7 | `u8[8]` | `OEWGCAN\0` |
| 8 | `u32` | ABI version = 1 |
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

Recipe 固定 96 bytes，magic 为 `OEWGRCP\0`，version = 1，bytes = 96。其余字段按顺序为：

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

Section 10 is producer-owned identity evidence. It is calculated before the opaque handle is returned, so the browser adapter can derive `ProductID` without copying the complete page set out of WASM. The manifest is domain-separated and ordered; it is not a replacement for per-page validation when a page is later copied. Unknown glTF attribute semantics are rejected before canonical input assembly; they are never silently dropped.

Page record 布局严格复用 `Geometry Product V1`：decoded SHA-256 前 16 bytes、first Group、Group count、flags = 0、reserved = 0。WASM output budget 至少容纳一页；decoded pages 超过传入 budget，或 bootstrap Group payload bytes 超过 recipe bootstrap budget 时整体失败，不 offer descriptor。后者与 Native writer 的 recipe 语义一致；Product admission 仍需另按完整 pinned page bytes 预留 GPU budget。

## Nyx function map

| Nyx source | Web implementation | Retained behavior |
| --- | --- | --- |
| `MeshletBuilder::Build/BuildLOD0Meshlets/BuildMeshletsFromIndices` | `GeometryCooker.cpp::BuildMeshlets/CookDomain` compiled to WASM | meshoptimizer clusterizer、local/global index、winding、bounds、128 triangle limit |
| `GeneratePositionRemap/GroupMeshlets/BuildVertexLocksByGroups` | `GeometryCooker.cpp::CookDomain/BuildSeamLocks` | position remap、LOD partition、seam/attribute protect lock、material-domain boundary |
| `SimplifyGroup` | `GeometryCooker.cpp::SimplifyGroup` | attribute-aware simplification、permissive/sloppy flags、failure ratio、error scale |
| `SerializeGroup/BuildStreamingData/BuildHierarchy/ValidateBuild` | `GeometryCooker.cpp` + `DecodedGeometryProduct.cpp` | refine relation、parent error、per-LOD BVH8/top BVH、coarse-first、page-local Group、complete bootstrap cut |

该表只覆盖 S2 producer。`GeometryStreaming`、`DAGCull` 和 `VBufferMesh` 的 request/fallback/GPU consumer 映射仍由 Virtual Geometry Runtime 切片交付，不能由本 ABI 的存在推断完成。

## Failure and lifecycle

- canonical corruption、非 finite 数据、非法 material/attribute flags、越界 index、recipe mismatch、预算不足或 Nyx validation failure：返回失败，不产生 handle/page/descriptor。
- Worker cancel/crash/OOM：销毁或遗弃整个 session generation 的 handle；已 active 的旧 Product 不受影响。
- section copy 要求 destination exact-sized；unknown section/index 和 released handle fail closed。
- Product handle 不跨 Worker，不进入 GPU owner；GPU admission 只接收复制并经过 Product validator 的 descriptor/page。

## Validation

- Native ABI oracle 与 TypeScript encoder 使用同一 cube canonical/recipe bytes SHA-256，并验证两次 cook 的所有 tables/pages byte-identical。
- Negative oracle 覆盖 total length、normal declaration、non-finite vertex、index range、reserved/padding、recipe 和 output budget。
- Native OEGPACK writer 必须消费同一个 `DecodedGeometryProductV1`，其既有 reopen/corruption/determinism tests 防止抽取时改变 Offline container。
- S2 退出仍要求真实 Emscripten build、Dedicated Worker session、GLB Range canonicalizer、exclusive transfer、Product admission 与浏览器像素证据；native ABI oracle 不替代这些 Gate。
