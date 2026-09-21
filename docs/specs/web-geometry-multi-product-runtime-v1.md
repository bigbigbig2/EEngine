# Web Geometry Multi-Product Runtime V1

Status: frozen

Owners: `GeometryProductMultiRuntimeV1`、`VirtualGeometryResidency`、`GpuScene`

## Version/Compatibility

schemaVersion 固定为 1；Product Table record stride 固定为 64 bytes；instance
ABI 为 V8、record stride 固定为 176 bytes。未知 flags、reserved、generation 或
record size 必须 fail closed，不得按旧版本 best-effort 解码。

## Scope

本规范冻结 ADR-0018 Phase E 的 Product 生命周期和实例身份边界。它把多个
独立 Product shard 放入一个 scene-level Product Table，并保持每个 Product
自己的 descriptor、source、metadata heap、page locations 和 shared physical
page ownership。Loader、Product source、GPU Product Table 和 residency 不是同一
个 owner。

本 V1 是实现/contract/oracle ABI；它不宣称已有 100M browser
RuntimeValidated、正式 PERF 或 ADR Complete 证据。当前 renderer 的虚拟几何
consumer 仍以一个 `GeometryProductGpuBindingsV1` 为一组 pipeline binding；
多 Product Table 的统一 renderer consumer 属于后续 production integration gate。

## Contract

### Product Table ABI

`GeometryProductMultiRuntimeV1` 默认分配 64 个 slot，也允许更大的整数容量。GPU
buffer 使用 `GEOMETRY_PRODUCT_TABLE_RECORD_STRIDE_V1 = 64` 字节、`STORAGE |
COPY_DST`，容量和 metadata reservation 在资源创建前按 negotiated
`maxBufferSize` 与 `maxStorageBufferBindingSize` 检查。

每个 64-byte record 是 `GeometryProductTableRecordV1` 的 16 个 little-endian
`u32`：

```text
0   productGeneration
4   flags                  bit 0 = ACTIVE；其余 bit 必须为 0
8   assetBegin             12 assetCount
16  rootBegin              20 rootCount
24  hierarchyBegin         28 hierarchyCount
32  groupBegin             36 groupCount
40  pageBegin              44 pageCount
48  vertexFormatBegin      52 vertexFormatCount
56  reserved0              60 reserved1
```

`productGeneration` 不能为 `0` 或 `0xffffffff`；reserved 必须为零。V1 的
scene-level table 记录 Product-local metadata range，当前每个独立 residency
仍拥有自己的 metadata heap，因此 range base 在该 heap 内解释；后续合并 heap
不得改变记录字段或身份规则。

空 slot 以全零 record 发布。ACTIVE 只在 activation cut 完成、所有 bootstrap
page 已 hash 验证并完成 GPU metadata 写入后发布；dormant、release 和 replacement
切换先清除 ACTIVE，再等待 submission boundary 回收资源。

## Identity ABI

### Instance

虚拟几何 instance 的唯一引用是：

```text
(ProductTableSlot, ProductGeneration, AssetRecordIndex)
```

`GpuInstanceAbi` V8 保持 176-byte record stride。字段如下：

```text
byte 0   geometry_record_index   Product-local AssetRecordIndex/reference index
byte 44  geometry_generation     expected ProductGeneration
byte 168 product_table_slot      ProductTableSlot
```

普通 geometry 的 `product_table_slot` 写为 0；virtual geometry 必须写显式
slot。WGSL `oengine_instance_product_table_slot()` 与
`oengine_instance_geometry_generation()` 只读取这两个 ABI 字段，不从 CPU
对象或隐含 Scene-local state 推断 identity。

### Page

Page demand、completion、eviction 和 cache key 使用：

```text
(ProductTableSlot, ProductGeneration, PageID)
```

`PageID` 永远是 Product-local；禁止把所有 Product 拼成 GlobalPageID。Page
completion 只有在 slot 当前仍由相同 generation 拥有、PageID 在 descriptor 范围
内且 page payload/hash/identity 通过 `VirtualGeometryResidency` 校验时才会上传。

## Lifecycle

```text
load -> loading -> active
active -> dormant -> active
active/dormant --replace--> new loading -> new active
old generation -> retiring -> released
active/dormant --release--> retiring -> released
loading --failure/cancel--> failed
```

- **独立 load**：每个 shard 自己创建 activation cut；失败只回滚自己的 slot。
- **replacement**：新 generation 先完成 activation cut，再切换 table record；旧
  generation 保留到显式 `retire()` 的 GPU submission boundary。
- **dormancy**：只撤销 Product record 的 ACTIVE publication，保留 source 与
  resident pages；wake 重新发布同一 generation。
- **eviction**：先删除 Product-local page location，再等待 completion token，
  最后释放 shared physical slot；pinned activation page 不可 eviction。
- **release**：先清 table、撤销 current identity，再等待 boundary、destroy
  residency、释放 source；slot 在同 slot 的 retiring generation 都结束前不能复用。

## Stale rejection

`acceptDemand()`、`completePage()`、`instanceIdentity()` 都通过 current
`(slot, generation)` 查找。下列情况 fail closed，不得消费 physical page slot 或
改写当前 generation：

- slot 不存在、generation 不匹配、Product 不是 active；
- PageID 或 AssetRecordIndex 越界；
- replacement/release 后迟到的旧 demand 或 page completion；
- pageId、ProductID、revision、decoded hash 或 payload size 不匹配。

generation 分配跳过 0/`0xffffffff`，并在 current 与 retiring entries 中避免
冲突，防止 slot reuse 的 ABA 误认。

## Ownership and capability rules

- `GeometryProductRevisionSourceV1` 由 `VirtualGeometryResidency` 在成功 admission
  后拥有；multi-runtime 不把 source 放入长期 GPU table。
- shared page banks 由 `GeometryProductSlotPool` 统一管理；每个 residency 只
  持有自己的 page locations 和 metadata buffer。
- table buffer 创建前检查设备 limit，未使用 Draft WebGPU feature、64-bit atomic、
  mesh/task shader、BDA 或 multi-draw 假设。
- GPU producer/consumer 闭环仍由现有 Product visibility path 负责；CPU identity
  查询只用于 admission、诊断和异步调度反馈。

## Validation

`OEngine/tests/contract/geometry-product-multi-runtime.test.mjs` 必须保持以下
oracle：

- 64 个 shard 同时 active，slot 与 generation 唯一；
- 独立 load、replacement、dormant/wake、page eviction、release 和 slot reuse；
- stale demand、stale page completion、bad page rejection 和 generation ABA 防护；
- 64-byte Product Table record 的 generation/ACTIVE/reserved 语义；
- 176-byte instance record 的显式 ProductTableSlot 三元组和 WGSL helper。

这些测试证明本地 lifecycle/ABI contract。独立 `validation/` host 上的多 Product
renderer consumer、100M TTFMF、RuntimeValidated 和正式 PERF 仍是后续 gate。
