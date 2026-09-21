# ADR-0018 Phase E Multi-Product Runtime 审评（2026-09-22）

本记录将 Phase E 落为实现、contract 和 oracle 完成；不把本地 fake-device
证据升级为 100M 浏览器 Runtime Validated、正式 PERF 或 ADR Complete。下一阶段
仍需把统一 Product Table 接入独立 validation host 的 production renderer。

## 结果

新增 `GeometryProductMultiRuntimeV1`，以一个 scene-level 64-byte Product Table
管理独立 shard，同时保留每个 shard 的 source、descriptor、metadata heap 和
`VirtualGeometryResidency`。当前实现覆盖：

- 默认 64 个 Product slot，独立 load 与 slot/generation 分配；
- 同 slot replacement：新 activation cut 完成后才切换，旧 generation 显式 retire；
- active/dormant/wake、page eviction、独立 release 和 safe slot reuse；
- `(ProductTableSlot, ProductGeneration, PageID)` stale demand/completion 拒绝；
- Product-local `(ProductTableSlot, ProductGeneration, AssetRecordIndex)` instance
  identity；
- GPU Product Table generation/ACTIVE record 写入，以及 negotiated storage limit
  和 metadata budget 检查。

`GpuInstanceAbi` V8 复用原 dynamic record 的 padding lane，在 byte 168 写入
`ProductTableSlot`，stride 仍为 176 bytes。普通 geometry 写 0，不改变现有单
Product 路径的调用形状。

## ADR-0018 对照

| ADR-0018 Phase E 要求 | 实现与证据 | 结论 |
| --- | --- | --- |
| `ProductTable`、multi Product Scene、per-instance Product identity | `GeometryProductMultiRuntimeV1`、`web-geometry-multi-product-runtime-v1.md`、GpuInstanceAbi V8 | 满足实现/ABI |
| 同时 active `>= 64` Product shards | contract test 顺序加载 64 个独立 descriptor，验证 64 个 slot/generation 唯一且 `peakActive=64` | 满足 contract/oracle |
| independent load | 每个 slot 自己创建 residency activation cut；失败只清理自己的 entry | 满足 |
| independent replacement | 新 generation 完成后发布；旧 entry 留在 retiring map，`retire()` 后释放 | 满足 |
| independent eviction | Product-local page location 先撤销，completion boundary 后释放 shared slot；pinned page 拒绝 eviction | 满足 |
| independent dormancy/release | dormant 只清 ACTIVE record；release 等 boundary 后 destroy residency，slot 等全部 retiring generation 结束才复用 | 满足 |
| stale-generation rejection | demand、completion、instance identity 都检查 current slot + generation；测试覆盖 replacement、release、slot reuse ABA | 满足 |
| GPU Product Table ABI 有 authoritative spec | `docs/specs/web-geometry-multi-product-runtime-v1.md` 冻结 64-byte record、flags、reserved、identity 和生命周期 | 满足 |
| instance identity ABI 有 contract/oracle | byte 0/44/168、176-byte stride、WGSL helper 和 pack oracle 已锁定 | 满足 |

## Owner 边界

`GeometryProductMultiRuntimeV1` 只拥有 scene-level admission/publication state；
`VirtualGeometryResidency` 继续拥有 Product-local metadata、page locations、
shared physical slots 和 source release；`GpuScene` 只拥有 instance GPU buffer。
Loader/Provider 不获得长期 GPU object，CPU identity 查询不构建可见列表。

## 未关闭门槛

当前 renderer 的 hierarchy/visibility/shading pipeline 仍通过一个
`GeometryProductGpuBindingsV1` 绑定一组 Product metadata/banks。Phase E 新增的
scene-level table 已有独立 ABI 和本地 lifecycle evidence，但尚未把多个 Product
的 metadata ranges 统一绑定进 production renderer，也没有独立 browser host 的
64-shard 画面、TTFMF、100M memory 或 PERF 证据。因此：

- 不声明 `RuntimeValidated`、`Performance Evaluated` 或 `ADR Complete`；
- Zorah 的 bounded `EXT_meshopt_compression` decode 仍是开放 gate；
- visible-first publication、GPU demand compaction、adaptive residency 和正式
  100M PERF 继续由 Phase F–K 处理。

## 验证

已运行：

```text
npm run typecheck       (OEngine)
npm run build:test      (OEngine)
node --test tests/contract/geometry-product-multi-runtime.test.mjs
```

测试结果：2/2 通过。提交前还需运行仓库级 `node tools/vibe.mjs verify --changed`，
并在 clean revision 上执行完整 engine suites；这些 gate 不改变本记录的证据等级。
