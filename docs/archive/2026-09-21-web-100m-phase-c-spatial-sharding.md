---
id: archive/2026-09-21-web-100m-phase-c-spatial-sharding
state: history
---
# ADR-0018 Phase C Giant Primitive Spatial Sharding 审评（2026-09-21）

本记录声明 Phase C implementation/contract/oracle complete，不声明 100M 浏览器 Runtime Validated、Performance Evaluated、Phase D 或 ADR Complete。

## 结果

单个 primitive 超过 source/canonical budget 时，`NyxWebRuntimeCooker` 不再直接失败或扩大窗口，而是执行：

```text
bounded index/position scan
→ triangle centroid Morton prefix histogram
→ stable bounded triangle-owned shard plan
→ one shard canonical domain at a time
→ incremental Nyx WASM builder append
→ one Product with multiple shard assets
```

默认 shard 目标遵循原设计 256K–2M triangles，并进一步受最坏情况 canonical byte budget 限制。100M metadata oracle 以 1M 上限得到 100 shards，triangle 总数精确为 100,000,000，最大 shard 为 1,000,000；验证按 triangle/node/primitive/shard 报告，而不是只看文件 MB。

端到端 admission 也已收口：`WebRuntimeCooker.estimateLiveSourceBytes()` 把 Coordinator 的 bootstrap/refinement 估算改为 live source-window 上限。Nyx producer 因此不会因一个 giant primitive 的完整 accessor range 超过 `maxWasmBytes` 而在空间 planner 前被拒绝；没有 bounded-window 能力的普通 producer 仍按完整 range fail closed。`maxSourceBytes` 继续只由 session/global ledger 作为 live-window capacity 记账，catalog total `sourceBytes` 不再被重复当作 allocation。

## 原设计对照

| Phase C 要求 | 实现与证据 | 结论 |
| --- | --- | --- |
| single 100M primitive → 多 bounded shard | 4096-bin Morton prefix histogram；100M / 1M oracle 产生 100 shards；interval 连续覆盖全部 triangle | 满足 contract/oracle |
| 不是 index-range split | triangle centroid → Morton code → stable counting-radix prefix；source ordinal 只作为相同 Morton prefix tie-break | 满足 |
| bounds valid | 每 bucket 累计 triangle vertex AABB；shard union 保守包含全部实际 vertex | 满足 |
| seam / attribute / material valid | triangle ownership；shard 内 source-index remap；boundary vertex 跨 shard复制全部 attributes；每 shard 保留同 material flags | 满足 |
| hierarchy valid | 每 shard 是独立 canonical domain，继续走现有 Nyx `BuildMeshlets/CookDomain`、seam lock、simplify、BVH8/hierarchy、page validation | 满足；未改 Nyx 算法 |
| deterministic shard/Product identity | shard SHA-256 固定 source、primitive、partition、offset/count、material；spatial plan producer version含 partition/budget；双次 cook ProductID相同 | 满足 |
| bounded payload working set | 无 100M Morton key array；planning metadata 固定为 bucket count；source range与单 canonical shard分别受预算约束 | 满足 implementation |
| Coordinator admission 不提前拒绝 giant primitive | bounded live-source estimate contract；普通 producer full-range fail-closed regression；Nyx spatial-capable path regression | 满足 |

## Nyx 对照

Phase C 是 Nyx geometry entry point 之前的 Web source adaptation，不替换 Nyx 函数。source function/entry、条件、数据依赖、不变量、差异、fallback、验证映射如下：

| 项 | 映射 |
| --- | --- |
| source entry | `MeshletBuilder.cpp::Build/BuildLOD0Meshlets/BuildMeshletsFromIndices` 对应本地 `BuildMeshlets/CookDomain` |
| 进入条件 | 一个 spatial shard 已形成有效 triangle list、完整 canonical attributes、单一 material domain |
| 数据依赖 | shard-local vertices/indices/material flags；后续 recipe 与原 Web cooker 相同 |
| 保留不变量 | triangle winding、attribute/seam value、material boundary、meshlet/group limits、refine relation、error propagation、BVH8 reachability、page independence |
| Web 差异 | Nyx importer 输入完整 mesh；Web 在 entry 前按 Morton triangle ownership 拆成多个独立 domain，允许 boundary vertex复制 |
| fallback | sparse giant accessor 和 bounded meshopt decode 未支持时显式 offline/capability failure；不读取 full primitive |
| validation | spatial planner unit/contract + Nyx differential corpus、native ABI oracle、真实 WASM artifact oracle |

## 所有权与阶段边界

- 当前是一个 Product 内的多个 shard asset；Phase E 才引入多个独立 Product/generation/Table slot。
- WASM builder 仍保留 completed serialized Groups，Phase D 才实现 cook-and-spill；本阶段没有误报这部分内存完成。
- V1 通过每 shard 重新扫描 source 避免提前引入 spill owner，working set有界但总 source IO/CPU 随 shard count增加。它是正确性路径，不是正式 100M 性能结论。
- Zorah 的 `EXT_meshopt_compression` bounded decode 仍未完成；其 1.627B source triangles / 3,163 primitives / 最大 primitive 32,054,609 triangles 仍是 authored control，不替代 single-giant 100M gate。

## 验证范围

新增验证覆盖 100M histogram、真实 accessor byte decoding、小型多 shard exact geometry、重复 catalog mapping 和 spatial cooker Product identity。正式 2.800 GB single-giant GLB 浏览器运行、TTFMF、CPU/GPU P50/P95 与 owner memory capture 仍按 ADR-0018 Phase K 在 clean revision 的独立 validation host执行。
