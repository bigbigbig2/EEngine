# OEGPACK Scene Manifest V3（`scene.oescene`）

Status: candidate
Owners: Native Offline Cooker（`tools/oengine-asset-core`）负责写入；Runtime Offline 路线（`load_oegpack_product` + `createOegPackSceneSource`）负责读取。

## 目的与所有权

Native Offline Cooker 在写出一个或多个 `.oegpack` 的同时写出一份 `scene.oescene`。它把「这次 cook 覆盖了哪些 pack / 哪些 asset / 这些 asset 在场景里怎么摆放」冻成一个纯索引清单，供 Runtime 在 Geometry Product admission **之前** 构造 `VirtualGeometrySceneSource`。

所有权边界：

- 生产者：Native Offline Cooker（`tools/oengine-asset-core`）。
- 消费者：Runtime Offline 路线（`load_oegpack_product` + `createOegPackSceneSource`）。
- 本文件不携带 GPU 状态、物理地址、文件 offset、Page payload、Group/Meshlet 内容或材质 PBR 字段。Page Directory 只存在于 `.oegpack` 的 binary metadata 中。

## Contract

UTF-8 JSON，`schema` 字段固定为 `oengine-scene-v3`。未知字段、缺失字段、非法取值一律拒绝（严格解析，不做静默修正）。

```json
{
  "schema": "oengine-scene-v3",
  "packs": [
    { "packId": "<64 hex>", "uri": "geometry-<20 hex>.oegpack" }
  ],
  "assets": [
    { "assetId": "<64 hex>", "pack": 0, "assetRecordIndex": 0 }
  ],
  "instances": [
    { "asset": 0, "materialBindingTable": 0, "flags": 0, "transform": [16 numbers] }
  ]
}
```

### `packs[]`

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `packId` | `string` | 64 位小写 hex，等于该 pack 的 `packContentHash`，也等于 Runtime 侧该 Product 的 `ProductID` |
| `uri` | `string` | 非空，相对于 manifest URL 的 pack 文件名 |

### `assets[]`

按 cooked asset 顺序排列，索引即 `instances[].asset` 的取值域。

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `assetId` | `string` | 64 位小写 hex，等于 cooker 的 `GeometryAssetID` |
| `pack` | `u32` | 小于 `packs.length` |
| `assetRecordIndex` | `u32` | 该 asset 在 `pack` 内的 asset record 下标，同时是该 Product 的 asset 索引 |

### `instances[]`

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `asset` | `u32` | 小于 `assets.length` |
| `materialBindingTable` | `u32` | 本版本只定义 `0`；其他值必须被消费者显式拒绝 |
| `flags` | `u32` | 透传为 Runtime instance flags，当前 cooker 写 `0` |
| `transform` | `number[16]` | 列主序 4×4 世界矩阵，全部为有限数 |

`transform` 与 glTF / Runtime instance record 使用同一列主序约定，因此不需要在 Runtime 侧做转置或行列互换。

## 与 Geometry Product 的映射

1. Runtime 用 `packId` 定位本次要发布的 Product；一个 Scene 一次只发布一个 Product，因为 `Renderer` 的 `VirtualGeometrySceneSource` 每个 Scene 只接受一个 residency。manifest 中指向其他 pack 的 instance 必须报错，不得跨 pack 拼接 asset/Group/Page。
2. `instances[].asset` → `assets[].assetRecordIndex` → 该 Product 的 asset 索引；`geometryProfiles` 由该 asset 的 OEGPACK vertex format `attributeMask` 推导。
3. `activationPageIds` 与 bootstrap cut 不写在 manifest 里，它们来自 `.oegpack` metadata 与 Product descriptor。
4. Offline 与 Web 产物不要求字节一致，也不要求相同的 ProductID/PageID 划分；两者只在 Geometry Product admission 之后共享同一条 residency/renderer 路径。

## Version/Compatibility

- `schema: oengine-scene-v3`。任何字段语义变化、字段增删或索引含义变化都必须提升 schema 版本；V3 不得被暗中重解释。
- 消费者必须先校验 `schema` 再解析其余字段；不认识的版本必须报错，不得退化为“尽力解析”。
- 确定性：同一输入、同一 recipe、同一 producer version 必须产生 byte-identical manifest；`packs[].uri` 由输出目录中的实际文件名决定。

## Validation

- `tests/oegpack-offline-product.test.mjs`：用真实 Native cooker 产物作为 golden，覆盖严格解析、负例矩阵（未知字段、缺字段、非法 hex、越界索引、非有限 transform、超范围 flags、错误 schema）、Product 身份/activation cut 校验、HTTP Range 与 memory 两种 source selection、source failure 显式报错，以及 manifest → `VirtualGeometrySceneSource` 映射与跨 pack 拒绝。
- `tests/oegpack-v3.test.mjs`：cooker determinism 与 corruption matrix。
- ADR-0014 宿主 `virtual-product-offline` case：真实浏览器里两条 source selection 的 GPU topology/覆盖率平价、source failure、Product 替换、GPU demand 与 Shadow/Visibility 消费。
