# 03 · R2 Runtime Asset 与 GPU Render World

## 阶段目标

建立设备无关资产、设备相关 residency、Application World 和 GPU Render World 之间的清晰 seam。大量实例的 CPU/GPU 成本由变化量和可见工作量决定，不再由 JS 对象总数或 Loader 临时对象决定。

## 非目标

- 不在 Loader 中长期持有 GPU buffer/texture。
- 不让 World handle 等于 GPU table slot、buffer offset 或 JS object identity。
- 不在本阶段实现 geometry streaming/page fault。
- 不为了 Packed Instance Set 复制一套独立渲染管线。

## 当前代码入口

| 领域 | 当前入口 | 迁移态度 |
|---|---|---|
| World 变化 | `OEngine/src/scene/SceneChangeSet.ts` | 保留 revision/incremental 思路，扩展结构与生命周期语义 |
| Scene 同步 | `OEngine/src/gpu/GPUSceneChangeSynchronizer.ts` | 重构为统一 extract/apply seam，删除内部自提交 flush |
| GPU Scene | `OEngine/src/gpu/GPUSceneContext.ts`、`SceneDatabase.ts` | 作为迁移来源，不冻结现有 record ABI |
| Geometry residency | `OEngine/src/gpu/MeshletGpuTable.ts`、`MeshletGpuPool.ts`、`GeometryBlasPool.ts` | 迁移到 ResidentGeometry owner；现有地址与表布局可推翻 |
| Material/texture | `GPUMaterialContext.ts`、`GPUResidentMaterialContext.ts`、`GPUTextureManager.ts` | 提取 stable handle/residency，后续由 MaterialTable 消费 |
| Loader | `OEngine/src/loaders/gltf/*`、`load_gltf.ts`、`shadeFormat.ts` | Loader 只产 Source/Runtime Asset，不直接决定热路径布局 |
| 独立对象 | `OEngine/src/scene/Node3D.ts`、`Mesh.ts`、`Scene.ts` | 继续支持，但不用于表示海量重复实例 |

## 目标所有权

```text
Source glTF/USD
  → Importer transient model
  → versioned RuntimeAssetPackage          device independent
  → AssetRegistry / RuntimeAssetHandle
  → ResidencyManager(GPUDevice)
  → ResidentGeometry/Material/Texture      device dependent
  → GPU Render World tables

Application World
  → RenderChangeSet
  → GPU Render World dirty ranges
  → FrameUploadBatch
```

每个资源只有一个销毁 owner。World 引用 Runtime Asset handle；GPU table 引用 resident handle；Loader 对象在导入结束后可释放。

## Stable handle v1

首版候选统一为 32 位 generational handle，实际冻结由 `WORLD-02` 的 limits 测试确认：

```text
bits  0..19  slot index       1,048,576 slots/table
bits 20..31  generation       4,096 reuse generations
0xFFFFFFFF   invalid
```

约束：

- CPU 分配器验证 generation；GPU shader 只消费已经 extract 验证的 slot/generation 映射。
- GPU record 中若只存 slot，必须有 resident epoch 或 generation table 防止 use-after-free。
- 释放后至少跨过所有 in-flight frame 才能复用 slot。
- generation wrap 时该 slot 停止复用或触发整表 epoch 重建，禁止静默重新有效。
- 不同 handle type 在 TypeScript 使用 branded type，在 WGSL 通过字段名与验证区分。

如果目标场景证明 20/12 分配不合适，变更必须在下游 ABI 冻结前完成，并记录 ADR/Context；不得在 shader 中各自切位。

## GPU table 逻辑 ABI

表内最终字节布局由共享 schema 生成并断言。首版逻辑字段如下；`WORLD-03` 必须给出实际 stride 和对齐。

### InstanceRecord

| 字段 | 语义 |
|---|---|
| current transform | 当前 object → world，紧凑 3×4 或经验证的等价格式 |
| previous transform | velocity/history 使用的上一帧变换 |
| world bounds | sphere；非均匀缩放时必须保守 |
| geometry handle | ResidentGeometry stable handle/slot |
| material override | invalid 表示使用 cluster material |
| object ID | debug/picking 稳定身份，不等于 slot |
| flags | visibility、shadow、alpha、motion 等固定 feature bits |

### GeometryRecord

| 字段 | 语义 |
|---|---|
| hierarchy root/range | BVH8/Cluster hierarchy 根与合法范围 |
| cluster/meshlet range | resident table 范围 |
| vertex/index streams | buffer binding 内的 word/element offset，不是裸 device address |
| material range | asset material slot 映射 |
| object bounds | instance cull 与量化 decode |
| asset ABI revision | debug validation，不由 shader 动态迁移旧格式 |

### ClusterRecord

由 [04-geometry-cooker-and-hierarchy.md](./04-geometry-cooker-and-hierarchy.md) 冻结 bounds、normal cone、geometric error、children、meshlet range 和 material slot。GPU World 只拥有 resident range 与生命周期。

### MaterialRecord / LightRecord

MaterialRecord 由 [07-material-resolve.md](./07-material-resolve.md) 冻结 PBR 与 texture reference；LightRecord 至少统一 type、transform/range、radiance、flags 和 shadow handle。场景对象只通过 Change Set 更新对应字段。

## RenderChangeSet

### 变化类别

```text
create/remove instance
reparent/update transform
update bounds
change geometry/material/flags
create/update/remove packed instance range
resident asset became available/evicted/invalid
create/update/remove light
camera/view changes（不进入 InstanceTable）
```

结构变化与字段变化分离。Change Set 按 revision 可被多个 consumer 读取；history 有容量上限，落后 consumer 超过保留窗口时明确返回 `fullResyncRequired`。

### Producer/consumer

- Producer：Application World、animation、AssetRegistry/ResidencyManager。
- CPU consumer：GPU Render World owner，将变化合并成 dirty ranges。
- GPU consumer：upload 后的 animation/culling/material/light passes。
- Change Set 本身不由 Renderer 遍历 Scene 推测；Renderer 只请求当前 revision 的 extract result。

## Packed Instance Set

Packed Instance Set 是 World 的一种批量数据源，不是一组隐藏的 `Node3D/Mesh`：

```text
PackedInstanceSet
├─ stable set handle
├─ shared geometry/material defaults
├─ count/capacity
├─ packed current transforms
├─ previous transforms or deterministic previous snapshot
├─ optional per-instance material/flags
└─ dirty span list
```

它和独立对象最终写入同一个 InstanceTable、走同一 hierarchy/visibility/resolve。支持 append、remove-swap 或 free-list 由 API 决定，但 object ID、previous transform 和 dirty span 在移动时必须正确更新。

## Capacity、overflow 与生命周期

| 资源 | Capacity 来源 | Overflow 行为 |
|---|---|---|
| CPU handle table | 配置与运行时增长 | 增长；超过 20-bit 硬上限拒绝创建并报结构化错误 |
| GPU table | device limit、预算、resident count | 在 frame boundary 扩容并复制；旧 buffer 保留至 in-flight 完成 |
| Change history | revision ring 配置 | consumer 落后时 `fullResyncRequired`，不返回不完整增量 |
| Dirty ranges | 当前结构变化量 | 合并为全表 upload 是显式 fallback，并增加 counter |
| Packed set | 创建时 capacity | API 返回 capacity error 或显式 grow；不覆盖相邻记录 |

device lost 后 Runtime Asset 与 Application World 仍有效；所有 resident handle 失效并由 ResidencyManager 重建，GPU table/history 不假设原 buffer 继续存在。

## 执行任务

### WORLD-01 · 列出现有 record 与 owner

从 Scene、GPUScene、Geometry、Material、Texture、Light 路径生成 current map：谁创建、谁保存、谁销毁、何时 submit。发现双 owner 或 Loader 长期 owner 时先记录迁移顺序。

### WORLD-02 · 冻结 handle schema

实现 typed allocator、generation、deferred reuse、invalid sentinel、capacity error 和 device epoch 测试。确认 20/12 位分配满足 A/B/C 与目标 GPU table 数量。

### WORLD-03 · 建立共享 GPU table schema

为 Instance/Geometry/Cluster/Material/Light 生成 TypeScript offsets、WGSL structs 和 layout assertions。每张表记录 stride、usage、capacity、resident bytes 和 owner。

### WORLD-04 · 重构 Change Set/Extract

覆盖 create/remove/reparent/transform/bounds/geometry/material/light/residency。让多个 GPUScene consumer 可以按 revision 读取，历史溢出走 full resync。

### WORLD-05 · 增量 upload

dirty owner 产生合并 range，R1 `FrameUploadBatch` 在主 encoder 前半段消费。记录 ranges、bytes、full-upload fallback 和 unchanged frame 零 upload。

### WORLD-06 · 建立 Runtime Asset/Resident seam

Loader/Cooker 输出设备无关 package；ResidencyManager 验证版本与 features 后上传。相同 Runtime Asset 可在 device lost 后重新 resident；销毁引用计数或显式 lease 必须可测试。

### WORLD-07 · 实现 Packed Instance Set

先支持 shared geometry/material + packed transforms，再增加 per-instance override。A/C benchmark 不创建 160k `Node3D/Mesh`，并记录创建内存、extract 时间和更新跨度。

### WORLD-08 · 迁移真实主帧

Visibility/Lighting 暂时可通过 adapter 读取新表，但不得让 adapter 遍历 JS object 或复制全表。每个 adapter 同时创建删除任务。

### WORLD-09 · 销毁与恢复

覆盖 remove asset、remove scene、view 销毁、table grow、in-flight reuse 和 device lost。增加 use-after-free/generation mismatch debug counter。

### WORLD-10 · 删除旧 owner

删除重复 GPUScene record、Loader GPU owner、内部自提交 flush、仅服务旧地址 ABI 的 mapping。公开 API 变更更新 `src/index.ts` 和迁移说明。

## 验收

### 正确性

- handle stale/reuse、generation wrap 策略、full resync、table grow 和 device lost 有自动测试。
- 独立对象与 Packed Instance Set 渲染结果一致。
- current/previous transform 在新增、移动、删除交换、隐藏再显示后正确。
- asset unload 不造成在途帧 use-after-free；invalid resident 走明确 fallback/error。

### 性能

- unchanged scene 的 extract/upload 与总对象数无关，且上传字节为 0。
- 更新 N 个 transform 的 CPU 与 upload 成本近似随 N/dirty spans 增长。
- A 场景使用 Packed Instance Set 后，JS object 数量不随 160k instances 增长。
- GPU table resident bytes、grow 次数、upload bytes 纳入 R0 schema。

## 回退与失败条件

- adapter 需要每帧全表复制：停止下游接入，调整 table ABI/seam。
- 32-bit handle 容量不够：在冻结前重新分位或分表；不临时用 float/双 u32 混搭。
- Packed set 无法保持 previous transform：先限制可用更新操作并报错，不输出错误 velocity。
- device limit 无法容纳预期 table：降低可配置 capacity或分段绑定，并把能力写入 startup validation。

## 阶段退出

Runtime Asset、resident handle、五张核心表、增量 Change Set 和 Packed Instance Set 已接通真实帧；旧 owner 删除；A/C 证明 CPU 与 upload 不再随静态 JS 对象总量线性工作。更新 asset/world/gpu-world Context、`CURRENT-STATE`，再冻结 hierarchy ABI。
