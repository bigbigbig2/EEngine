# 03 · R2 Compact Runtime Asset 与 GPU Scene

## 阶段目标

为中大型 mostly-static 场景建立设备无关 Runtime Asset、紧凑 GPU tables、Packed Instance Set、bulk upload 和少量字段 patch。大量实例的 CPU/GPU 成本由批量数据和最终可见工作量决定，不由 JS 对象数量决定。

本阶段不是完整 World/ECS/Residency 平台。它只提供 R3 hierarchy/work generation 所需的深 module 和稳定 ABI。

## 非目标

- 不在 Loader 中长期持有 GPU Buffer/Texture。
- 不要求一实例一 `Node3D/Mesh`。
- 不建设高频 add/remove/reparent、完整 Gameplay Change Set 或通用 ECS。
- 不实现 geometry streaming/page fault、World Partition 或超大世界坐标。
- 不要求完整 asset unload/reload 和 device-lost 自动重建成为 G2 Gate。
- 不为 Packed Instance Set 复制独立渲染管线。

Buffer grow/replace/destroy、staging 和 table reuse 仍必须遵守 GPU in-flight 安全；这是底层正确性，不是动态世界产品能力。

## 当前代码入口

| 领域 | 当前入口 | 处理 |
|---|---|---|
| Scene/GPU Scene | `SceneChangeSet.ts`、`GPUSceneChangeSynchronizer.ts`、`GPUSceneContext.ts`、`SceneDatabase.ts` | 提取 bulk/patch 能力；不冻结历史对象模型 |
| Geometry tables | `MeshletGpuTable.ts`、`MeshletGpuPool.ts`、`GeometryBlasPool.ts` | 迁移数据与 owner；现有地址/布局可推翻 |
| Material/texture | `GPUMaterialContext.ts`、`GPUResidentMaterialContext.ts`、`GPUTextureManager.ts` | 收口为 Material/Texture table 与有界 handle |
| Loader | `loaders/gltf/*`、`load_gltf.ts`、`shadeFormat.ts` | 只产 Source/Runtime Asset，不决定热路径布局 |
| Scene objects | `Node3D.ts`、`Mesh.ts`、`Scene.ts` | 可作为小场景 adapter，不承载 Packed Instances |

## 目标所有权

```text
Source glTF
  → Importer transient model
  → versioned RuntimeAssetPackage       device independent
  → RuntimeAssetHandle
  → GPU Asset Tables                    device dependent

Instance source / Packed Instance Set
  → bulk Instance records
  → optional transform/material patches
  → GPU Scene tables
```

- Runtime Asset Package 拥有设备无关 sections、version、counts、strides、hash 和 validation result。
- GPU table owner 拥有 Buffer、capacity、resident range、grow/replace 和 bytes counters。
- GPU Scene owner 拥有 Instance/Packed Instance records、current/previous transform 和 patch queue。
- Renderer 只消费 GPU handles/tables，不遍历源 Scene 构建最终可见列表。

## Runtime Asset Package v1

Package 至少包含：

```text
header: magic, version, flags, section directory, content hash
geometry metadata
vertex/index/attribute streams
meshlet headers + local triangle/vertex data
cluster hierarchy + geometric error + BVH8
material references
optional texture metadata
```

Geometry 具体字段由 [04-geometry-cooker-and-hierarchy](./04-geometry-cooker-and-hierarchy.md) 冻结。Streaming page 不进入 v1 正确性 ABI；未来扩展必须新增 section/version，不能把 hierarchy node 偷当 page record。

## GPU table 逻辑 ABI

共享 schema 必须生成或验证 TS byte offset/stride 与 WGSL struct。首批表：

- `InstanceRecord`：geometry/material handle、current/previous transform、bounds、flags、stable debug ID。
- `GeometryRecord`：stream ranges、meshlet/hierarchy root/ranges、bounds、decode metadata。
- `ClusterRecord`：bounds/cone、error、children/renderable ranges、material range。
- `MaterialRecord`：由 R4-B 冻结 PBR feature bits 和 texture handle。
- `TextureRecord`：bank/layer/sampler/mip metadata 与 resident bytes；不要求 streaming state machine。
- `LightRecord`：type、transform/range、radiance、flags、shadow handle。

所有索引和范围必须可验证；裸 GPUBuffer 地址不得进入 public interface。

## Packed Instance Set

Packed Instance Set 是大量重复实例的主要 interface：

```text
create(geometry, material, capacity)
upload/transforms(range)
patchTransforms(range)
patchMaterial(range)
getGpuRange()
```

具体 interface 可以继续收窄，但不能要求为每个实例分配 JS Scene object。独立小量对象通过 adapter 写入相同 InstanceTable，不获得第二条渲染路径。

## Upload 与内存契约

- 首次/批量载入按连续 range 上传，记录 bytes、calls 和 table grow。
- 稳定帧无变化时 GPU Scene upload 必须接近零。
- transform/material patch 按 dirty span 或合并 range 上传，不全表复制。
- 记录 geometry/material/texture/instance resident bytes 和 grow peak。
- table raw count 不能超过 consumer capacity；grow 失败明确报错，不静默截断。

## 执行任务

### WORLD-01 · 盘点现有 record 与 owner

输出 CPU/GPU struct、owner、writer/reader、grow、upload、bytes 和删除候选，不保护 reconstructed ABI。

### WORLD-02 · 冻结 Runtime Asset header/section/version

建立黄金资产、hash、version reject 和 section range validator。

### WORLD-03 · 建立共享 TS/WGSL table schema

冻结五张核心表的字段、offset、stride、alignment、capacity 与 debug validator。

### WORLD-04 · 建立 GPU Asset Table owner

统一 Geometry/Cluster/Material/Texture/Light Buffer 的 create/grow/upload/destroy 和 resident bytes。

### WORLD-05 · 建立 bulk GPU Scene upload

从普通实例或 Packed Instance source 生成连续 InstanceRecord，不逐对象编码 draw。

### WORLD-06 · 建立 transform/material patch

支持少量 dirty ranges、current/previous transform 和 upload counters；不扩张完整通用 Change Set。

### WORLD-07 · 实现 Packed Instance Set

覆盖大批量创建、range upload/patch、shared geometry/material 与相同主链消费。

### WORLD-08 · 内存与上传证据

Profiler 输出 resident/transient/table bytes、upload calls/bytes、grow 次数和稳定帧零更新。

### WORLD-09 · 迁移真实主帧

A/B/C 从公开 OEngine interface 建立新 package/tables/instances，Renderer 不再依赖 Loader 临时对象或 JS 对象列表构建可见工作。

### WORLD-10 · 删除旧 owner 与重复表

删除被替代数据库、adapter、兼容字段和无 consumer Shader；保留项必须有唯一 owner 和截止任务。

## 验收

### 正确性

- package version/hash/section/range 和 TS/WGSL offset/stride 有自动测试；
- Packed 与普通实例在相同 transform/material 下产生相同 GPU record 和画面；
- previous transform 在 patch 后正确，稳定帧不会被重复覆盖；
- table grow/replace 不导致提交前销毁或 use-after-free；
- invalid handle/range 明确报错或使用已定义 fallback。

### 性能与内存

- 1k/10k/100k/目标规模 Packed Instances 的 CPU build/upload 曲线；
- 稳定静态帧 upload 接近零，CPU 不逐实例生成绘制工作；
- resident bytes 与 record stride 可由 counts 复算；
- 相比独立 JS object adapter，Packed path 的 CPU/内存优势可量化。

## 阶段退出

Runtime Asset Package、五张 GPU Asset Table、Instance/Packed Instance bulk path、transform/material patch 和内存/上传证据已接通真实 A/C 页面；旧重复 owner 删除。完整动态生命周期、streaming 和超大世界能力不属于 G2。
