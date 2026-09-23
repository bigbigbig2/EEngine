# Web Geometry Spatial Shard V1

Status: draft

Owners: `SpatialShardPlanner`、`NyxWebRuntimeCooker`、Web CookSession

## Version/Compatibility

本合同实现 ADR-0018 spatial sharding。它位于 glTF metadata catalog 与 Nyx canonical/WASM cook 之间，处理超过 source、canonical 或 Product work budget 的 TRIANGLES primitive。它不改变 Geometry Product V1、256 KiB Page、Nyx meshlet/group/hierarchy 算法。联合 work budget 由 [Web Geometry Product Work Budget V1](./web-geometry-product-work-budget-v1.md) 定义。

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

默认 `bucketBits = 12`。早期 256K–2M source triangles/shard 仅保留为历史 scale tuning；当前 authored V1 的硬上限是 128 Ki triangles，并同时受 32 MiB canonical、512 Ki vertices 和 64 domains 约束。一个 bucket 超过任一上限时按稳定 Morton-order rank 切开，不得放大 budget。

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

Materialization 进行一次 source scan。若全部 index triples 加起来不超过 RAM scratch cap，则用内存数组；否则必须在 Dedicated Worker 中用 OPFS 临时文件按 Morton rank 存放 triples。每个非空 bucket 只保留受 RAM cap 约束的小写入块，读取时只分配一个 shard 的 index triples。OPFS、Web Locks 不可用、quota 不足、短写或短读均 fail closed，不得回退到 full-primitive JS 数组。临时文件在成功、取消和失败时由 producer 释放；文件存活期间持有同名 Web Lock，Worker 启动时只回收可取得锁的遗留文件，跳过其他活跃 Worker 的 scratch。

`spatialScratchBytes` 报告 bucket buffers、histogram cursor 和一个 shard read buffer 的 RAM 上界；`externalBytes` 报告临时文件逻辑长度。encoded canonical input 必须不超过 `maxCanonicalWindowBytes`，且 shard 必须同时满足 triangle、vertex 和 domain work limits；WASM builder append 返回后立即释放。外存 materialization 不改变 triangle ownership、shard identity 或 Product bytes。

Producer 的 `Progress.timings` 在运行中和失败时报告 `spatialExternalScratchBytes`、`spatialExternalScratchPeakBytes`、`spatialExternalScratchMaterializations`、`spatialExternalScratchReleases`。外存释放成功后 current bytes 为 0，materializations 与 releases 对齐；失败的删除不计作 release。

### Scene mapping

一个 catalog primitive 可以映射到同一 Product 内多个 asset domain：

```text
sceneAssetIndices = [catalog primitive 7, 7, 7, ...]
```

重复映射是 spatial shard 的必要语义。Scene mapper 为每个 shard asset 生成同一组 node transform/material instances；它仍是一个 Product。跨 Product 的独立 generation、release、eviction 和 Product Table slot 属于 Phase E。

### Failure and fallback

- 非 TRIANGLES、非有限位置、越界 index、反向/非法 budget、identity 长度错误整体 fail closed。
- 单 primitive 的任何 work estimate 超过限制时必须进入本 planner；canonical bytes 较小不能绕过 triangle/vertex/domain sharding。
- giant primitive 的 sparse accessor 在 V1 显式拒绝并要求 offline fallback；不得静默 materialize full accessor。
- 缺少 POSITION bounds 时允许一次额外有界 position pass 求 bounds。
- `EXT_meshopt_compression` 的 bounded decode 仍是独立开放门禁；本合同不能把压缩 output buffer 当作直接 source range。
- cancel/failure 不得 offer 部分 Product revision；reader signal 在每个 range 边界继续生效。

## Validation

- `spatial-shard-planner.test.mjs`：authored 1,364,306-triangle primitive 和 deferred 100M histogram exact ownership、四维 bounded shard size、deterministic identity、bounds、attributes、materials、seam duplication。
- `web-geometry-spatial-shard.test.mjs`：一个 catalog primitive 到多个 Product asset/instance 的 mapping。
- `nyx-web-runtime-cooker.test.mjs`：oversized primitive 进入 incremental builder，稳定 ProductID，且不回到 full-primitive canonical input。
- Nyx C++/WASM oracle 继续验证每个 appended canonical domain 的 meshlet、Group、hierarchy、page 与 determinism 不变量。
