# Geometry Product V1

Status: draft

Owners: Web Runtime Cooker、Offline/OEGPACK adapter、geometry admission owner

## Version/Compatibility

本规范定义 Producer 与 Geometry Runtime 之间的逻辑合同，不规定 Cooker 的源码、算法、线程模型、缓存容器或文件布局。V1 仅接受 runtime profile `oengine-vg-v1-v3-decoded`；新增 page、vertex 或 hierarchy 布局必须使用新的 profile id，并在 consumer 存在后更新本规范。

V1 profile 复用 [OEGPACK V3](./oegpack-v3.md) 的 decoded Group/Meshlet payload、AssetRecord、HierarchyNode、GroupDirectory 和 VertexFormat 布局，但不包含 OEGPACK header、compressed offset、codec、CRC 或文件 hash。OEGPACK 只是该 profile 的一个 source adapter。

本 spec 冻结字段、作用域、状态和校验语义。跨 Worker 的二进制 descriptor transport 使用下述 `GeometryProductDescriptorBinaryV1`；任何 producer 必须生成 canonical offsets，Runtime 必须拒绝 alias、越界、非零 reserved 和 trailing bytes。WASM mirror 与 golden oracle 仍是 candidate gate。

V1 同时冻结 page identity 的推导语义与两阶段 cook 的对外可分离推进语义，使 descriptor 可以先于 page payload 冻结。Producer 可以选择只实现单体式 cook 并通过 `replaces` 发布完整 revision，但一旦声明支持同 revision 内按 demand 补页，就必须满足本 spec 的两阶段 ABI 与 identity 确定性要求。

## Nyx Provenance 与移植合同

V1 的几何生产算法必须以用户提供的本地 Nyx 只读快照为来源，而不是另行设计一个“类似 Nanite”的简化算法。当前可核验基线是快照日期 2026-09-16 及以下文件 SHA-256；目录没有 `.git` metadata，`moonlovelj/Nyx@bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b` 仅是声明身份，不是本地已验证 commit：

| Nyx source | SHA-256 | V1 required mapping |
| --- | --- | --- |
| `MiniEngine/Model/MeshletBuilder.cpp` | `b749346382b0f9a1574f0c0566a2860bff2acfbc6521df6f153a42653c81e84a` | meshlet、position remap、Group、LOD simplification、refine/error、BVH/page production |
| `MiniEngine/Model/ModelConvert.cpp` | `8bdf016e0f36e70f0c1aa46d679ab0e1b4f57ea30e0748a6549675620cc8a059` | glTF scene/material/mesh ownership and cook assembly |
| `MiniEngine/Model/MeshletStructs.h` | `1edfaa25d2e12067b98d93599142b110e2509be96471fa09a00b029484ef9b23` | Group/Meshlet/Hierarchy semantic fields and invariants |

V1 生产者必须逐项保留 Nyx 的 position-remap topology、material-domain boundary、same-LOD grouping、seam/attribute protection locks、attribute-aware simplification 与显式 fallback flag、coarse `refineGroup`、parent/error monotonicity、conservative bounds、per-LOD/top BVH、page-local payload、bootstrap/legal cut 和 fixed-page independence。允许将 C++ 翻译为 WASM 或改变内存/任务编排；不允许以均匀 LOD、独立自研 decimator、扁平 BVH、只生成 LOD0 或删除任一上述阶段来满足本 spec。

每个 producer 的实现记录必须包含 Nyx function map、保留不变量、OEngine/WASM 差异、license/notice、differential corpus 和 negative corpus。Web 与 Offline 输出可以有不同 ProductID/PageID/参数/字节，但必须分别证明相同 Nyx 算法不变量和本 spec conformance。

## Contract

### 角色与方向

```text
WebCookProductProvider ─┐
                       ├─ revision offer + decoded page reader
OegPackProductProvider ─┘
                                  │
                                  ▼
                     GeometryProductAdmission
                                  │
                                  ▼
                    VirtualGeometryResidency
```

Provider 可以推迟 `readPage()` 的完成，或在其内部通过 I/O、decode、cache 或 live cook 产生 page；它不得分配 GPU object、发布 physical address 或决定 renderer frame revision。Admission/Residency 不得读取 provider 私有对象、文件 offset 或 WASM heap view。

### 标量、ID 与作用域

- 所有 count、local id、revision 和 generation 是非负 u32；`0xffffffff` 是 invalid local id，不得作为合法索引。
- `ProductID` 是 32-byte opaque identity。Provider 必须保证同一 ID 的含义稳定；Runtime 不从 URL、文件名或局部 PageID 推导 ProductID。
- 完整 revision key 是 `(ProductID, revision)`。AssetID、HierarchyNodeID、GroupID、PageID、VertexFormatID 只在该 key 内有效。
- `productGeneration` 由 Runtime admission 分配，与 producer 的 `revision` 不同；它用于丢弃旧异步结果、feedback 和冻结 frame 中的错误别名。
- `recipeHash` 是 32-byte SHA-256。source 使用 `sourceIdentityKind + sourceIdentityHash[32]`，参与 cache/conformance，但不替代 ProductID。
- `sourceIdentityKind` 为 `content-sha256`、`strong-http-validator` 或 `session`。Range 主路线不得为了得到 `content-sha256` 预先下载完整 GLB；有强 ETag/长度/最终 URL 时可规范化后 hash 为 `strong-http-validator`，否则使用当前 session 的随机 identity 并禁止跨 session 持久 cache。
- 不同 producer 对同一 GLB 产生的局部 ID、hash、hierarchy 或 page bytes 无需相同，且不得混用。

### Producer identity

每个 descriptor 必须携带：

| 字段 | 合同 |
| --- | --- |
| `producerKind` | `web-runtime` 或 `offline-native`；cache 命中保留原 producer kind |
| `producerId` | 稳定、非空 ASCII 标识 |
| `producerVersion` | 算法/构建变化会影响输出时必须变化 |
| `recipeHash` | canonical producer recipe 的 SHA-256 |
| `sourceIdentityKind` | `content-sha256`、`strong-http-validator` 或 `session` |
| `sourceIdentityHash` | 对应 identity 的 32-byte hash；`session` 值只在本次加载稳定 |
| `runtimeProfile` | V1 固定为 `oengine-vg-v1-v3-decoded` |

同一 producer identity、source identity、recipe hash、runtime profile、ProductID 和 revision 必须得到 byte-identical descriptor、PageID 顺序、activation cut 与 decoded page hash。无法保证确定性的并行算法必须改变 producer version 或 identity，不能复用同一 cache key。`session` identity 不承诺跨加载复用 ProductID 或持久 cache，但同一 CookSession 的多个 revision 必须保持其 ProductID 语义稳定。

### Revision descriptor

`GeometryProductDescriptorV1` 至少包含：

```text
schemaVersion = 1
productId: bytes[32]
revision: u32
replaces: optional(ProductID + revision)
producerKind / producerId / producerVersion
sourceIdentityKind: enum
sourceIdentityHash: bytes[32]
recipeHash: bytes[32]
runtimeProfile = "oengine-vg-v1-v3-decoded"
decodedPageBytes = 262144
assetRecords: byte array, stride 128
rootNodeIds: u32 array
hierarchyNodes: byte array, stride 48
groupDirectory: byte array, stride 16
pageRecords: GeometryProductPageRecordV1 array, stride 32
bootstrapPageIds: u32 array
vertexFormats: byte array, stride 16
activationPageIds: sorted unique u32 array
```

`GeometryProductPageRecordV1` 的 32-byte little-endian layout 为：

| Byte | 类型 | 字段 |
| ---: | --- | --- |
| 0 | `u8[16]` | decoded page SHA-256 前 128 bit |
| 16 | `u32` | first GroupID |
| 20 | `u32` | group count |
| 24 | `u32` | flags；V1 必须为 0 |
| 28 | `u32` | reserved；必须为 0 |

`GeometryProductPageRecordV1` 的 page identity 由该页承载的 Group payload 按 GroupID 升序的确定性上卷得出，而不是由整页 bytes 单独决定。上卷输入为每个 Group 的 payload 摘要与其在页内的 offset/length，上卷算法必须是可复现的固定算法并冻结在 producer version 中。整页 `bytes` 的稳定摘要仍必须可被 Runtime 校验，用于检测传输或存储损坏；它不参与 identity 推导。

该定义使 page identity 可以在 payload 产生之前计算，从而支持 descriptor 先于 payload 冻结。同一 Producer 对同一输入必须在单体式与两阶段两种执行路径下得到相同 identity。identity 算法变化必须视为 producer version 与 runtime profile 变化，不得在同一 profile 内静默切换。

#### Descriptor binary transport

`GeometryProductDescriptorBinaryV1` 使用 little-endian、256-byte header，magic 为 ASCII `OEGP`（字节 `4f 45 47 50`）。所有 section 起点按 16 byte 对齐，section 之间的 padding 必须为 0；`totalBytes` 必须等于最后一个 section 对齐后的长度，不允许 trailing bytes。固定表 stride 沿用本 spec：Asset 128、root `u32` 4、Hierarchy 48、Group 16、Page 32、VertexFormat 16、activation/bootstrap PageID 4。字符串是非空 UTF-8 bytes、不带 NUL；`producerId` 解码后仍须满足 printable ASCII。

| Byte | 类型 | 字段 |
| ---: | --- | --- |
| 0 | `u32` | magic = `0x5047454f` |
| 4 | `u32` | transport version = 1 |
| 8 | `u32` | header bytes = 256 |
| 12 | `u32` | total bytes |
| 16 | `u32` | runtime profile；V1 = 1 |
| 20 | `u32` | producer kind；web-runtime = 1，offline-native = 2 |
| 24 | `u32` | source identity kind；content-sha256 = 1，strong-http-validator = 2，session = 3 |
| 28 | `u32` | flags；bit 0 = has replacement，bits 1..31 = 0 |
| 32 | `u32` | revision |
| 36 | `u32` | decoded page bytes = 262144 |
| 40..68 | `u32[8]` | asset/root/hierarchy/group/page/bootstrap/vertex-format/activation counts |
| 72..76 | `u32[2]` | producerId / producerVersion byte lengths |
| 80..116 | `u32[10]` | 对应八张表、producerId、producerVersion 的 byte offsets |
| 120 | `u32` | replaces revision；无 replacement 时为 0 |
| 124 | `u32` | reserved = 0 |
| 128..159 | `u8[32]` | ProductID |
| 160..191 | `u8[32]` | source identity hash |
| 192..223 | `u8[32]` | recipe hash |
| 224..255 | `u8[32]` | replaces ProductID；无 replacement 时必须全 0 |

Canonical section 顺序固定为 `assetRecords -> rootNodeIds -> hierarchyNodes -> groupDirectory -> pageRecords -> bootstrapPageIds -> vertexFormats -> activationPageIds -> producerId -> producerVersion`；每段结束向 16 byte 对齐。count 乘 stride、offset 加 byte length 和最终总长度均须以防溢出的方式验证。Transport decode 后仍必须运行完整 `GeometryProductDescriptorV1` validator；binary validation 不能替代跨表/tree/activation 校验。

descriptor 中的 V3-compatible table 必须通过 OEGPACK V3 的范围、树、Group、payload 和 vertex-format 不变量。Page record 的 Group range 必须连续、互不重叠并与 GroupDirectory 中的 PageID 一致。所有 PageID 都必须有且仅有一个 page record。AssetRecord 的 bootstrap range 引用 `bootstrapPageIds`；该表保留 per-asset range/order，元素必须合法且对应 asset 的可绘制 cut。

`activationPageIds` 定义该 revision 可被 Runtime 激活所需的最小完整 cut：

- 必须非空、升序、无重复且指向合法 PageID；
- 必须包含 `bootstrapPageIds` 的全部唯一 PageID，并覆盖每个 AssetRecord 声明的 bootstrap range；
- 仅凭 descriptor、activation pages 及已准入的材质/decode profile 就能生成合法可绘制 fallback；
- 不得依赖未列出的 page 才能遍历到可绘制 Group；
- admission 必须在请求这些 page 前证明其 pinned、CPU in-flight 与 transaction peak budget 可容纳。

快速首帧应以一个完整 bootstrap revision（通常 revision 0）表达，而不是发布半个可变 descriptor。更高质量 revision 可以用 `replaces` 指向当前 active revision，但替换资格由 Runtime 决定。

### Revision offer 与 page reader

Provider 的公共行为等价于以下 TypeScript 语义接口；具体代码名可不同，但不得改变语义：

```ts
interface GeometryProductProviderV1 {
  revisions(signal: AbortSignal): AsyncIterable<GeometryProductRevisionSourceV1>;
}

interface GeometryProductRevisionSourceV1 {
  readonly descriptor: GeometryProductDescriptorV1;
  readPage(pageId: number, signal: AbortSignal): Promise<GeometryPageProductV1>;
  release(): void;
}

interface GeometryPageProductV1 {
  readonly productId: Uint8Array; // 32 B
  readonly revision: number;
  readonly pageId: number;
  readonly decodedHash: Uint8Array; // 16 B
  readonly bytes: ArrayBuffer; // exactly 262144 B, exclusive ownership
}
```

`revisions()` 只能 yield 已冻结 descriptor。live provider 可以先 yield bootstrap revision，再在后台 yield richer revision；一个 revision yield 后任何表、ID、hash 或 activation cut 都不可修改。

`readPage()` 可以触发 Range/decode 或 live cook，但返回值必须与请求 key 和 descriptor hash 一致。成功返回的 `ArrayBuffer` ownership 转移给调用方；Provider 不得随后修改该 buffer。取消、OOM、source corruption、Worker crash 和 unsupported profile 必须 reject，不得返回零填充“成功页”。

Runtime 可以并发、重复或乱序请求；Provider 必须合并或正确处理重复请求，且在 `release()`/Abort 后停止新工作并使迟到结果带旧 session generation 失效。Runtime 不保证请求全部 page。

### Progressive refinement

V1 允许两种方式：

1. descriptor 一次冻结完整 ID graph，随后 page 按 demand 产生；同 revision 内只补 payload，不改变任何 identity 或 hash。
2. Provider 构建新的完整 revision，通过 `replaces` 提议替换；Runtime 在新 activation cut 完整 resident 后原子激活。

禁止在已 offer 的 revision 内重排 Group/Page、修改 hierarchy、改变 page hash、追加未声明 PageID，或把 Web 与 Offline revision 的 page 拼接。新 revision 失败时当前 active revision 保持可用。

方式 1 要求 Producer 的 cook 具备两阶段能力。descriptor 阶段必须在未产生任何 page payload 的前提下冻结全部 identity、page 装箱与 activation cut；payload 阶段按 PageID 增量产生字节。两阶段之间的状态必须可被消费侧观察，使“PageID 已声明但 payload 未产出”与“PageID 不存在”可区分：前者是合法的待产出页，后者必须被拒绝。

descriptor 阶段与 payload 阶段必须满足同一确定性要求：相同输入、相同 producer identity 与 recipe 必须得到相同 PageID 分配、相同 Group 归属、相同 identity 与相同激活 cut，与两阶段是否被拆开执行无关。

未实现两阶段的 Producer 仍可使用方式 2，此时每个 revision 都必须是自洽的完整 revision。

### Web Runtime Cooker 内部边界

CookSession、source cook priority、Worker 消息和 WASM allocator 不属于公共 Product ABI，但映射到 Provider 时必须满足：

- descriptor ready 前只能按 scene/accessor bounds、依赖、camera hint 和 age 调度 source cook，不能伪造 GPU Page demand；
- descriptor ready 后，Runtime 的 `(ProductID, revision, PageID)` demand 可以提升对应 cook unit；
- output block 采用 byte credit；未取得 credit 不得产生新的 256 KiB transferable page；
- 普通 WASM linear memory 不能直接转移，必须复制到独占 `ArrayBuffer`；SharedArrayBuffer/pthread specialization 也不产生 ownership transfer；
- GPU object 不跨 Worker 边界，默认由 render/GPU owner 上传；
- pthread/SAB specialization 要求 `crossOriginIsolated` 和受控共享内存；非隔离多 Worker specialization 必须产生相同 Product 合同。

### 两阶段 Cooker ABI

选择方式 1 的 Producer 必须通过两阶段 ABI 暴露 cook，且该 ABI 必须能表达以下状态与操作：

- descriptor 阶段完成后，必须可在不触发 payload 产生的前提下查询 page 数量、每个 PageID 的 identity、page 到 Group 的映射以及 activation cut；
- payload 阶段必须支持按 PageID 单独推进，且必须容忍乱序推进、重复推进与并发推进；
- 已完成 phase 的 PageID 必须可重复取回，且在同一个 descriptor 生命周期内返回 byte-identical 结果；
- 对 descriptor 未声明的 PageID 的推进请求必须被拒绝，不得按需扩张 ID graph；
- descriptor 阶段与 payload 阶段的失败必须可区分，且任一阶段失败都不得污染已经产出的 page。

ABI 变更必须递增版本号。旧版本 consumer 必须被显式拒绝，不得静默回退到单体式 cook 语义。两阶段 ABI 的实现可以在内部沿用单体式算法并按需取用结果，但对外必须满足上述可分离推进语义，且不得改变本 spec 与 Nyx 移植合同要求的任何几何输出。

### Cache key

可选 Web cache 的最小 key 为：

```text
schemaVersion + sourceIdentityKind + sourceIdentityHash + producerKind + producerId + producerVersion
+ recipeHash + runtimeProfile + ProductID + revision + PageID + decodedHash
```

只有 `content-sha256` 或经验证的 `strong-http-validator` 可以建立跨 session 持久 key；`session` identity 只能使用本次加载的内存 cache。descriptor 与 page 分开 journal；只有 descriptor 和其 activation pages 全部提交后，cache 才能宣称该 revision 可启动。部分 cache、quota failure 或 corruption 必须退回 Provider，不得影响 correctness。Web cache 不是 OEGPACK，除非另有完整 exporter 并通过 OEGPACK writer validation。

## Web source-scene mapping metadata

Web Runtime Cooker 可以在 `GeometryProductRevisionSourceV1` 上附带
`sceneAssetIndices`。这是 Producer 到 Scene mapper 的来源映射元数据，不是
Geometry Product 二进制 section，也不属于 ProductID。第 `i` 项表示 Product
asset record `i` 对应的稳定 GLB catalog primitive。列表必须唯一、索引必须在
catalog 范围内，并且长度必须等于 `assetCount`。

Subset bootstrap 仍然必须是完整且不可变的 Product revision：自身的 asset
table、hierarchy、Group/Page directory、activation pages 和 page hash 都要
独立通过校验。后续完整 revision 通过 `replaces` 原子发布，不能向 active
revision 追加未声明的 asset，也不能原地修改其 Group/Page identity。

## Validation

- 两个独立 test producer 和 OEGPACK adapter 必须通过同一 descriptor/page conformance suite。
- 覆盖非法 ID/range/stride/reserved、树环、跨页 Group、hash 不符、错误 page 长度、activation cut 不完整、重复/乱序 page、取消和迟到结果。
- 同 producer identity 做不同 Worker/thread count 的 descriptor/page byte determinism；Web 与 Offline producer 不做跨 producer byte-equality 要求。
- 真实浏览器证明 bootstrap revision 可独立出像素、richer revision 失败不影响旧 revision、成功替换不混用两代数据。
- 采用方式 1 的 Producer 必须额外证明：descriptor 阶段不产生 payload 即可冻结完整 ID graph；其 PageID、Group 归属与 activation cut 与单体式路径逐字节一致；payload 阶段按 PageID 的乱序、重复、并发与取消推进均正确，且未声明 PageID 的推进被拒绝。
- page identity 上卷必须与整页完整性校验分别测试：篡改页内 Group payload 必须改变 identity 或被完整性校验捕获，篡改页内 padding 不得改变 identity。
- 提升为 candidate 前，补齐 descriptor 的二进制 Worker transport layout、WASM/TypeScript mirror、golden bytes 与版本拒绝测试。
## Web glTF 材质引用边界（第三步）

`sceneAssetIndices` 仍是 Product provider 到 Scene mapper 的只读元数据，不进入 Product 二进制 ABI。Web catalog 允许传递 glTF texture slot、UV transform、sampler、image URI/bufferView、mimeType 与 codec variant；image bytes 由 source owner 有界读取并在 mapper 阶段解码。Geometry Product 不保存 GPU texture handle，也不把未完成 image DAG 拼入 active revision。

作者材质映射必须覆盖 base-color、metallic-roughness、normal、occlusion、emissive 及 `MASK` cutoff，并通过既有 `TextureResidency`/`TextureBindingSet` 完成原子 staging。Draco、`EXT_meshopt_compression`、skin、morph 等未支持 profile 必须拒绝；不能忽略 `extensionsRequired` 或静默回退 V2。Mode A 只表示网络/上传渐进，不作物理显存节省承诺。
