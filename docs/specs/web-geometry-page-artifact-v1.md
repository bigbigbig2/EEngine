# Web Geometry Page Artifact / Spill Store V1

Status: draft

Owners: Web Runtime Cooker、Geometry Product provider、OPFS page owner

## Version/Compatibility

schemaVersion 固定为 1；artifact envelope version 固定为
`WEB_GEOMETRY_PAGE_ARTIFACT_VERSION_V1 = 1`。未知版本、错误 header、非零
reserved/padding、错误 Product/Page key 或不匹配 checksum 必须拒绝；本合同只
覆盖 decoded 262 KiB page artifact，不把当前 session spill 文件升级为跨 session
persistent cache。

## Scope

本规范定义 ADR-0018 Phase D 的 producer-side page artifact 边界。它位于
WASM payload stage 与 Geometry Product `readPage()` 之间，不改变
`GeometryProductDescriptorV1` 的逻辑 ABI、PageID 作用域或 256 KiB decoded
page 布局。artifact 是 immutable decoded page 的存储副本；GPU object、物理
地址、Product admission 和 residency 不属于 spill store。

## Artifact identity

每个 artifact 的 key 是：

```text
(ProductID[32], revision, PageID, optional sessionGeneration)
```

`ProductID + revision + PageID` 必须完全匹配 descriptor。`sessionGeneration`
是 Worker/session 的所有权护栏；提供时，迟到的旧 generation 不能命中或覆写新
generation。PageID 仍然是 Product-local，不能在 spill store 中变成全局 ID。
同一 source/recipe 的不同 ordinary window 或 spatial shard 必须先由
`geometry-product-v1` 的稳定 `productScopeHash` 得到不同 ProductID；spill store
不得依赖清目录、随机 generation 或碰撞后的 checksum 错误来补偿 Product scope
缺失。

artifact 必须携带：

```text
decodedHash128       page record 的 Group-rollup identity
decodedPageHash128   SHA-256(decoded bytes)[0..16]
payloadChecksum      完整 SHA-256(decoded bytes)
bytes                exactly 262144 decoded bytes
```

store 对输入 payload 重新计算两个 checksum。已存在的相同 key 只有在
`decodedHash128` 和完整 checksum 都一致时才是幂等写入；任何不同内容、不同
generation 或不同 identity 的碰撞都失败关闭。

## Contract

`WebGeometryPageSpillStoreV1` 提供：

```ts
put(input): Promise<artifact>
read(key): Promise<artifact | null>
release(key): Promise<void>
dispose(): Promise<void>
evidence(): SpillEvidence
```

- `put` 在完整 checksum 通过后才提交；不能发布半页、零填充页或未验证页。
- `read` 每次返回独立 `ArrayBuffer`，调用方可以 transfer 而不影响 store。
- `release` 只释放本 store owner 的 key；未知 key 是幂等的。
- `dispose` 释放该 owner 的全部 artifacts。取消、失败、retry 和 revision
  replacement 必须在当前 generation 的 publication transaction 之外清理。
- `currentBytes`、`peakBytes`、`limitBytes` 和 `ownerCount` 必须按 encoded
  artifact storage 记账；`writes`、`reads`、`releases` 和 `failures` 是诊断
  计数，不得被当成 GPU residency 证据。
- `maxDecodedProductBytes` 只限制一个 Product 的 decoded payload；完整 CookSession
  使用独立 `maxSessionSpillBytes`。二者不得互相推导或共用一个 limit field。
- authored-large K0 的初始 `maxSessionSpillBytes` 为 1 GiB，必须记录真实 peak 后再
  调整默认值；该数字不是跨资产 ABI 常量。

## Backends

### Memory

Memory backend 是 bounded fallback，适用于小模型、测试和不支持 OPFS 的页面。
它保存 immutable copies，按 `maxBytes` fail closed，不得因为 memory fallback
而取消 page identity/checksum 校验。

### OPFS

OPFS backend 使用 namespace-scoped 文件名和自校验 envelope。envelope 包含
magic/version、完整 Product/page key、generation、payload length、两个 16-byte
identity 字段、完整 SHA-256 和 decoded payload。File System Access API 没有可依赖
的跨浏览器 rename，因此写入完成后仍必须在读取时验证 header、总长度、key 和
checksum；截断文件视为失败，不能被当成 page hit。

OPFS 是 page artifact 的推荐 runtime backend；它不表示已经实现跨 session 的
persistent cache。持久化 cache 需要另一个带 eviction、quota 和 cache-key
合同的决定，不能把当前 session spill 文件直接升级为该能力。

## Cook lifecycle

plan-backed WASM revision 的首次 `readPage()` 执行：

```text
read spill
  ├─ hit  -> validate key/identity/checksum -> return copy
  └─ miss -> produce PageID -> checksum -> put atomically -> return copy
```

只有 `put` 成功后，producer 才能把 page 视为已完成；写入失败可以 retry，不能
发布 `PageReady`。revision `release()` 会停止新的 page work，并释放该 revision
拥有的 spill keys；迟到的 page 结果不能重新写回已 release 的 generation。旧的
active Product 不因新 revision 的失败、取消或 retry 被替换。

Cooker 若带有 `AbortSignal`，spill read/produce/put 的边界都必须检查该 signal。
取消发生在 `put` 之后、page publication 之前时，artifact 只能被回收，不能进入
`PageReady`；取消发生在 `put` 之前时，后续 retry 可以重新生成同一 key。

completed page artifact 不得只为了未来 `readPage()` 继续保留在 WASM payload
cache 中。WASM plan 是 descriptor owner；spill store 是 page payload owner；两者
都不能把 GPU 或 provider 的长期对象藏在对方边界内。

Product revision publication 不要求先执行全量 `spillAllPages()`。descriptor 与可读的
activation cut 可以先进入既有 revision/activation transaction；generator 恢复后再按
budget spill remaining pages。任何已宣布 `PageReady` 的 page 仍必须先完成本合同的
checksum 和 authoritative `put`，不得把 activation-first 解释为允许半页或不可读页。

## Validation

contract/oracle 必须覆盖：

- 相同 key + 相同 payload 的幂等写入，以及 mixed-generation/mixed-checksum 拒绝；
- Memory 与 OPFS backend 的 exact page re-read，transfer 后原始 caller buffer
  可 detached 而不破坏下一次读取；
- `maxBytes`、current/peak/owner count 和 release/dispose 记账；
- descriptor identity 与 `decodedHash128` 不一致时拒绝；
- cancellation、failure、retry 和 release 不产生 partial/mixed-generation
  `PageReady`；
- plan-backed Product 的 first-read cook、second-read spill hit 和 stable
  payload checksum。

这些测试只能证明 producer/storage contract。`large.glb` browser K0/K1/K2、
OPFS quota 行为与 TTFMF 证据须在独立 `validation/` host 中取得。
