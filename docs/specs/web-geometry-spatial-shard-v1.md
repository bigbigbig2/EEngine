# Web Geometry Spatial Shard V1

Status: draft

Owners: `SpatialShardPlanner`、`NyxWebRuntimeCooker`、Web CookSession

## Version/Compatibility

本合同实现 ADR-0018 Phase C。它位于 glTF metadata catalog 与 Nyx canonical/WASM cook 之间，只处理单个超过 source 或 canonical window budget 的 TRIANGLES primitive。它不改变 Geometry Product V1、256 KiB Page、Nyx meshlet/group/hierarchy 算法，也不提前实现 Phase D cook-and-spill 或 Phase E multi-Product Table。

schemaVersion 固定为 1；partition version 固定为 `morton-radix-prefix-v1`。未知 schema/partition version 必须拒绝，不做 best-effort decode。

## Contract

### Partition identity

算法版本固定为 `morton-radix-prefix-v1`：

```text
triangle centroid
→ accessor bounds 归一化到 10 bit/axis
→ 30-bit Morton code
→ 最高 bucketBits 位的稳定 counting-radix prefix
→ source triangle ordinal 作为同 prefix 的稳定 tie-break
→ 受 canonical budget 限制的连续 Morton-order shard
```

默认 `bucketBits = 12`。默认目标范围是 256K–2M source triangles/shard，但 canonical budget 用最坏情况 `3 unique vertices/triangle` 计算更小的硬上限。一个 bucket 超过上限时按稳定 Morton-order rank 切开，不得放大 budget。

`shardId` 是以下字段的 SHA-256：domain tag、partition version、source identity hash、mesh/primitive、bucket bits、目标 triangle 数、shard ordinal、Morton-order offset/count、material。相同 source identity 与 partition 配置产生相同 shard identity；recipe 仍通过 Geometry Product 的 recipe hash 进入 ProductID。空间 budget/partition 变化必须进入 plan producer version，不能让不同 Product descriptor 共用 ProductID。

### Ownership and bounds

- Shard 拥有 triangle，不拥有跨 shard 可变 vertex。
- 全部 shard 的半开 Morton-order interval 必须无缝覆盖 `[0, primitive.triangleCount)`；triangle 不得丢失或重复。
- shard 内按 source vertex index 去重；跨 shard 的 boundary vertex 允许复制，且复制其全部 canonical attribute 值。
- material domain、alpha、double-sided、normal generation 和 attribute mask 从 source primitive 原样进入每个 shard。
- shard bounds 是其触及的 Morton bucket 内全部 triangle vertex AABB 的并集。切开同一 bucket 时可保守包含同 bucket 的相邻 triangle，但不得漏包本 shard vertex。
- 每个 canonical shard 是独立 Nyx material domain，独立进入现有 `BuildMeshlets/CookDomain → BuildSeamLocks → SimplifyGroup → BuildNyxHierarchy → AssembleDecodedGeometryProductV1`。因此 hierarchy、Group、page independence 和 simplification seam 规则仍由同一 Nyx-derived producer验证。

### Bounded reads and canonical memory

Planner 不分配 `triangleCount` 规模的 Morton key/sort array。常驻 planning metadata 是 `2^bucketBits` 的 histogram、prefix 和 bucket bounds。index/position 按 source window 扫描；离散 vertex fetch 被切成不超过 `maxSourceWindowBytes` 的 accessor ranges。

Materialization 一次只拥有一个 shard 的 selected indices、source-vertex remap、canonical vertices/indices 和一个 source range。encoded canonical input 必须不超过 `maxCanonicalWindowBytes`，WASM builder append 返回后立即释放。

V1 为避免在 Phase C 引入 Phase D spill owner，对每个 shard 重新扫描 source primitive 并按 histogram rank 选择 triangle。这保证 payload working set 有界，代价是 giant primitive 的 source scan 次数随 shard count 增长。Phase D 可以增加临时 OPFS counting-sort scratch，但不得改变 triangle ownership、shard identity 或 Product bytes。

### Scene mapping

一个 catalog primitive 可以映射到同一 Product 内多个 asset domain：

```text
sceneAssetIndices = [catalog primitive 7, 7, 7, ...]
```

重复映射是 spatial shard 的必要语义。Scene mapper 为每个 shard asset 生成同一组 node transform/material instances；它仍是一个 Product。跨 Product 的独立 generation、release、eviction 和 Product Table slot 属于 Phase E。

### Failure and fallback

- 非 TRIANGLES、非有限位置、越界 index、反向/非法 budget、identity 长度错误整体 fail closed。
- giant primitive 的 sparse accessor 在 V1 显式拒绝并要求 offline fallback；不得静默 materialize full accessor。
- 缺少 POSITION bounds 时允许一次额外有界 position pass 求 bounds。
- `EXT_meshopt_compression` 的 bounded decode 仍是独立开放门禁；本合同不能把压缩 output buffer 当作直接 source range。
- cancel/failure 不得 offer 部分 Product revision；reader signal 在每个 range 边界继续生效。

## Validation

- `spatial-shard-planner.test.mjs`：100M histogram exact ownership、bounded shard size、deterministic identity、bounds、attributes、materials、seam duplication。
- `web-geometry-spatial-shard.test.mjs`：一个 catalog primitive 到多个 Product asset/instance 的 mapping。
- `nyx-web-runtime-cooker.test.mjs`：oversized primitive 进入 incremental builder，稳定 ProductID，且不回到 full-primitive canonical input。
- Nyx C++/WASM oracle 继续验证每个 appended canonical domain 的 meshlet、Group、hierarchy、page 与 determinism 不变量。
