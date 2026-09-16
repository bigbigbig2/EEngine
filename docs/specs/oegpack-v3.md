# OEGPACK V3.0

Status: candidate

Owners: `OEngine/tools/oengine-asset-core`、`OEngine/src/assets/GeometryAbiV3.ts`、`OEngine/src/assets/OegPackV3.ts`

## Version/Compatibility

Magic 为 `OEGPACK\0`，major/minor 为 `3/0`，所有整数与 float 使用 little-endian。V3 reader 必须拒绝其他 major/minor、非零 reserved 字段和未知已占用 bit；扩展只能通过新版本或本规范明确保留的字段。

本 ABI 已由 native writer 与 TypeScript reader 共同实现，但在第一个真实生产 Visibility consumer 通过前保持 `candidate`。OEGPACK 是 Native Offline Cooker 的文件容器，不是 Web Runtime Cooker 的中间格式；Runtime 通过 `OegPackProductSource` 将其映射到 [Geometry Product V1](./geometry-product-v1.md)。

OEGPACK writer 的几何结果仍必须遵守 [Geometry Product V1](./geometry-product-v1.md) 的 Nyx provenance 和逐项移植合同。V3 文件布局可以适配 OEngine little-endian ABI，但不能因为已有 writer/parser 就跳过 Nyx 的 MeshletBuilder、hierarchy、streaming 和 consumer 算法来源。

## Contract

### 全局常量

| 项 | 值 |
| --- | --- |
| fixed header | 256 B |
| decoded page | 256 KiB (`pageShift = 18`) |
| geometry bank | 128 MiB，512 slots |
| asset record | 128 B |
| hierarchy node | 48 B |
| group directory | 16 B |
| page directory | 64 B |
| vertex format | 16 B |
| group header | 64 B |
| meshlet header | 48 B |
| invalid id | `0xffffffff` |

磁盘 byte offset 使用 u64；表计数、page/group/node/material id 和页内 offset 使用 u32。运行时转为 JavaScript number 前必须证明不超过安全范围。

### 文件布局

物理顺序固定为：header、asset directory、root-node u32 table、hierarchy、group directory、page directory、bootstrap-page u32 table、vertex-format table、page blob。中间 padding 为零；表起点至少 16-byte aligned，page blob 256-byte aligned。

Header 的关键偏移：表 offset 从 byte 72 开始；`recipeHash[32]` 位于 144；`packContentHash[32]` 位于 176；208..255 为零。`pageBlobOffset` 同时是 metadata 长度，`fileBytes` 覆盖整个 pack。

### Metadata 与 hierarchy

Asset record 保存 256-bit `assetId`、bounds、root/hierarchy/group/bootstrap ranges 和 source/leaf/total counts。所有 range 必须非空、无溢出并位于对应表内。

Hierarchy node 的 `packedNodeData`：bit 0 区分 group leaf；internal node 使用 bits 1..27 的 child start 和 bits 28..31 的 child count；group leaf 使用 bits 1..24 的 group id 和 bits 25..31 的 `meshletCount - 1`。root 表只能引用合法 hierarchy node，树必须无环且可达关系有效。

Group directory 指向单一 page 内的 16-byte-aligned payload；任何 group 都不得跨页。page directory 的 group range 必须与实际引用该 page 的连续 group 集一致。

### Page 与 payload

Codec `0` 是恰好 256 KiB 的 raw page；codec `1` 是解码后恰好 256 KiB 的独立 LZ4 block。codec 2/3 保留，V3 reader 必须拒绝。每页先校验 compressed CRC32，再解码并校验 decoded SHA-256 前 128 bit。

Group payload 顺序为 64 B GroupHeader、连续 MeshletHeader、triangle bytes、vertex bytes。`meshletHeaderOffset` 必须等于 64；各区间单调、不重叠且不超过 group payload。triangle 索引是 page-local u8 meshlet index；vertex byte range按 vertex-format stride 校验。`refineGroupId` 为合法 group 或 invalid id。

Bootstrap page id 必须唯一、合法，并完整覆盖每个 asset 声明的 bootstrap range。bootstrap cut 必须不依赖未 resident 页即可形成合法可绘制表示。

### Geometry Product 映射

`OegPackProductSource` 必须执行以下无歧义映射：

- OEGPACK metadata 中的 AssetRecord、root table、HierarchyNode、GroupDirectory、bootstrap page table 与 VertexFormat 原样进入 `oengine-vg-v1-v3-decoded` descriptor；
- 每个 64 B OEGPACK PageDirectory 解压为一个 32 B Geometry Product page record，只保留 decoded hash、first GroupID、group count，并将 flags/reserved 置零；file offset、compressed bytes、codec 和 CRC 留在 source adapter；
- OEGPACK bootstrap page table 原序映射为 `bootstrapPageIds`，以保留 AssetRecord range；它的去重升序集合映射为 `activationPageIds`，adapter 必须重新验证覆盖关系；
- `readPage(PageID)` 完成精确 Range、CRC、decode、decoded hash 和 payload validation 后，返回恰好 256 KiB 的 exclusive buffer；
- source identity 使用 `content-sha256 + packContentHash`；ProductID 等于 `packContentHash`，revision 为 0，`producerKind = offline-native`，`producerId = oengine-oegpack-v3`，`producerVersion = 3.0-adapter-v1`，recipeHash 取 header 同名字段。不得使用 URL 或 file offset 作为 identity，也不得与 Web product 共享局部 ID 作用域。

该映射不允许 Runtime shader 读取 OEGPACK file directory，也不允许 Offline source 建立单独 residency/renderer path。

### Identity 与完整性

- `recipeHash`：canonical geometry cook recipe JSON 的 SHA-256。
- `packContentHash`：从 byte 0 到 `pageBlobOffset` 的 SHA-256，计算时 header 中该 32-byte 字段为零；不包含 compressed page blob。
- page decoded identity：decoded 256 KiB 的 SHA-256 前 16 B。
- page transport integrity：compressed bytes 的 CRC32。

内容 hash 不是安全签名。HTTP range source 必须收到精确 `206 Content-Range`、identity content encoding 和精确长度；整包 memory source 服从同一 range 合同。

## Validation

- native `static_assert` 与 TypeScript constant/decode mirror 必须保持 stride/offset 一致。
- golden pack 覆盖 raw/LZ4、bootstrap、multi-page、deterministic recook 和 native validator/TS reader 互读。
- corruption matrix 覆盖 magic/version/endian/reserved、table overlap/range、hash/CRC、非法 tree、跨页 group、payload offset、vertex/triangle 越界和 refine edge。
- `OEngine/tests/oegpack-v3.test.mjs` 是当前 DEV oracle；还需增加 OEGPACK -> Geometry Product conformance golden。真实 V3 bootstrap geometry 经统一 admission 到达生产 Visibility 并通过 MILESTONE 后才可冻结本 spec。
