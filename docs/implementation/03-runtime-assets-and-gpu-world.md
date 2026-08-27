# 03 · R2 Compact Data Foundation 执行设计

## 状态

设计已于 2026-08-27 冻结，运行时代码尚未开始。执行顺序唯一为 `R2-A → R2-B → R2-C → R2-D`；当前待执行入口是 `R2-A-01`。

## R2 通俗解释

R0 解决“看得见真实性能”，R1 解决“每帧固定管理成本”，R2 解决的是“引擎喂给 GPU 的数据是否适合大批量处理”。

当前 OEngine 已能让 GPU 生成可见 Meshlet 数并由一次 `drawIndirect()` 消费，但资产与场景进入这条链之前仍有明显的 CPU/对象模型负担：

- glTF 和程序化几何会在 runtime 构造 `Geometry`、`MeshletGeometryBase` 和 Meshlet；
- `GPUSceneContext.build()` 遍历 `Scene.instances`，为每个 `Mesh/Node3D` 重新组装表；
- `MeshletGpuTable` 同时负责 JS 对象去重、Meshlet/BLAS 分配、CPU metadata 查询和 GPU Buffer 上传；
- 当前 transform record 同时保存 local TRS、global、previous global 和 parent，不是大量 mostly-static instance 的最小主路径；
- resident bytes、首次 bulk upload、少量 patch 和 Buffer grow 尚未形成一套可证明的契约。

因此 R2 不是“直接优化 LOD Shader”，也不是“完整重写场景系统”。它先把资产和实例变成连续、紧凑、可验证的 GPU 数据：资产离线 Cook 一次，runtime 只验证、驻留和批量上传；大量实例不要求一实例一 JS 对象。R3 再在这套稳定数据上执行 hierarchy/SSE/cull/compact。

## G2 与 G3 的边界

```text
R2：Source → Cooked Package → Resident Geometry → Packed Instances
                                      ↓
                         现有 flat Hardware consumer 可正确渲染

R3：Instance → BVH8 / Cluster traversal → SSE LOD → compact queue
                                                    ↓
                                      同一个 Hardware consumer
```

G2 证明“数据基础、owner、上传与旧消费者接线完成”；不宣称 GPU hierarchy traversal 已完成。Hierarchy/error/BVH8 必须在 R2 被 Cook、序列化、验证并上传，是因为 R3 不能一边实现 traversal、一边继续改输入 ABI。

## 范围冻结

R2 必须完成：

- versioned `RuntimeAssetPackage` kernel 与 Geometry sections；
- `SourceGeometry → CookedGeometry` 的确定性 Cooker；
- Geometry、Cluster、Instance 三张必需 GPU record table；
- vertex/index/meshlet/hierarchy/BVH8 等连续 payload buffers；
- opaque stable handle、bulk residency、Packed Instance Set 和显式 transform/material patch；
- resident/upload/grow/patch 证据；
- A/C 真实页面先通过现有 flat Hardware consumer 消费新数据；
- 删除 package 主路径上的 runtime Meshlet 生成和重复 GPU owner。

R2 明确不做：

- GPU hierarchy/SSE traversal、work queue 和新的 indirect 策略；这些属于 R3；
- Material/Texture/Light 全面重写；R2 只保存和解析 `MaterialHandle` 引用，现有 material owner 继续服务旧 Hardware consumer；
- 完整 ECS、高频 add/remove/reparent、World Partition、geometry streaming、texture streaming；
- 每资产或 Packed Instance 专用 Renderer；
- 未经 profile 先建设 staging ring、通用 suballocator 或 streaming state machine。

Buffer grow/replace/destroy 的 in-flight 安全是基础正确性，仍属于 R2；完整动态世界产品能力不属于 R2。

## 当前实现审计与迁移决定

| 当前实现 | 真实 owner / writer / consumer | R2 决定 |
|---|---|---|
| `gltfGeometry.ts`、`niMeshlets.ts`、`BoxGeometry.ts` | Loader/runtime 构造 Meshlet 与旧二进制布局 | 提取 `SourceGeometry`；Meshlet/hierarchy 生成迁入 Cooker；程序化几何走 in-memory Cooker |
| `MeshletGpuTable` | JS geometry map、geometry metadata、Meshlet pool、BLAS owner 和 CPU 查询混合 | 由 `GpuAssetStore` 取代长期 owner；只在迁移期作为旧 consumer adapter |
| `MeshletGpuPool` | allocation、grow、GPU copy、地址 rebasing | 不冻结当前 address ABI；可复用已验证的局部 allocator，但不向新 interface 泄漏 offset |
| `GeometryBlasPool` | 旧 BVH bytes、geometry-index 映射和 staging upload | 不冻结 32B node 或 metadata 布局；由 package BVH8 payload 与唯一 residency owner 取代 |
| `GPUDatabase` / `SceneDatabase` | page/occupancy/schema/WGSL/upload 与 mesh/transform 数据混合 | 不作为 Packed 主路径；普通对象 adapter 最终也写入新 `GpuScene` |
| `GPUSceneContext` | 遍历 Scene、维护 CPU ID mapping、驱动 geometry/material/TLAS/table build | 保留帧级协调职责；停止拥有最终 Instance 数据布局，不再为 Packed source 创建 JS Mesh 列表 |
| `SceneChangeSet` / `GPUSceneChangeSynchronizer` | 面向 Node/Mesh 的对象增量 | 只保留普通对象 adapter；Packed patch 使用 range/batch seam，不扩张此 Change Set |
| `GPUIndexedRecordTable` | sparse indexed patch 通过额外 Compute Pass 写入 | 不直接成为 R2 bulk-first 主路径；仅在 A/B benchmark 证明优于合并 `writeBuffer` 时复用 |

`GPUDatabase` 和旧 GPU Scene 可以在迁移期间存在，但同一份 Geometry/Instance 数据不得出现两个长期权威 owner。每个 R2 包结束时必须更新删除清单。

## 目标数据流与依赖方向

```text
glTF / procedural source
          ↓
    SourceGeometry                  device independent
          ↓
    GeometryCooker                  Node/browser in-memory tool
          ↓
 RuntimeAssetPackage bytes          versioned, validated, deterministic
          ↓
     GpuAssetStore                  device-dependent residency owner
          ↓ AssetHandle
 Packed source / Scene adapter
          ↓
        GpuScene                     compact Instance records + patch
          ↓ bindings
 existing flat work generation → existing single drawIndirect consumer
```

依赖只能向下：Importer 不导入 WebGPU；Cooker 不导入 Renderer/GPU owner；Package reader 不创建 GPU 资源；Renderer 不读取 glTF、`Node3D` 或 package section directory。

## 四个深模块

下面是 R2 需要冻结的最小 seam。名字可以在实现时微调，但不得重新拆成大量只转发调用的 manager。

### `RuntimeAssetPackage`

```ts
interface RuntimeAssetPackage {
  readonly manifest: RuntimeAssetManifest;
  geometry(id: GeometryAssetId): GeometryAssetView;
  validate(): ValidationReport;
}

function openRuntimeAssetPackage(bytes: ArrayBuffer): RuntimeAssetPackage;
```

它在内部隐藏 header、section directory、version/schema hash、checksum、range/alignment 验证和 typed views。`GeometryAssetView` 只提供验证后的只读 section view，不把 Loader 临时对象变成 package 状态。

### `GeometryCooker`

```ts
interface GeometryCooker {
  cook(source: SourceGeometry, recipe: GeometryCookRecipe): CookResult;
}
```

一次调用隐藏 topology normalization、meshoptimizer、Meshlet、renderable hierarchy、geometric error、BVH8、压缩、writer 和 validator。相同输入 hash、工具版本与 recipe 必须 byte-identical；允许变化的 debug section 必须单独标记且不进入 content hash。

### `GpuAssetStore`

```ts
interface GpuAssetStore {
  resident(pkg: RuntimeAssetPackage, command: ShadeGPUCommandContext): AssetHandle;
  release(handle: AssetHandle, command: ShadeGPUCommandContext): void;
  bindings(): GpuAssetBindings;
  evidence(): AssetResidencyEvidence;
}
```

它是 Geometry/Cluster records 与连续 payload buffers 的唯一 owner，隐藏 capacity、grow、copy、resident ranges 和 retirement。Renderer 只拿 bindings 与 GPU record index，不拿裸 Buffer offset。

### `GpuScene`

```ts
interface GpuScene {
  instantiate(
    asset: AssetHandle,
    source: InstanceSource,
    command: ShadeGPUCommandContext
  ): InstanceSetHandle;
  patch(
    set: InstanceSetHandle,
    batch: InstancePatchBatch,
    command: ShadeGPUCommandContext
  ): PatchEvidence;
  bindings(): GpuSceneBindings;
  evidence(): GpuSceneEvidence;
}
```

`InstanceSource` 可由连续 typed arrays 或普通 Scene adapter 提供。两者必须写入同一 Instance table；`GpuScene` 不要求为 Packed source 创建 `Mesh/Node3D`。调用者不再执行 `create → upload → getGpuRange` 的易错顺序，`instantiate` 一次建立并上传有效 set。

`bindings()` 是 Renderer 内部 seam，不从 `OEngine/src/index.ts` 暴露 GPU Buffer；公开 interface 只导出 package/asset/instance source 与 opaque handle。

## Package 所有权

通用 package kernel 只拥有：

- magic、format version、schema hash、endianness、flags、content hash；
- section directory：type、flags、offset、length、element stride/count、alignment、checksum；
- section bounds、overlap、整数溢出、required/optional 语义；
- asset directory 与 Geometry/Material reference 的逻辑 ID。

Geometry section 的字段、Meshlet/hierarchy/BVH8 不变量由 [04-geometry-cooker-and-hierarchy](./04-geometry-cooker-and-hierarchy.md) 唯一拥有。R2 v1 不包含 streaming page 状态；未来只能新增 optional section 或 format version，不能把 Cluster/BVH record 偷换成 page record。

## R2 最小 GPU ABI

R2 只冻结三张 record table。Material/Texture/Light 继续使用现有 owner，避免把阶段扩大成整套渲染数据重写。

| Record | 必需逻辑字段 | R2 consumer |
|---|---|---|
| `GeometryRecord` | bounds、vertex/index/meshlet payload ranges、cluster root/range、BVH8 root/range、decode metadata | flat adapter、R3 traversal、后续 material resolve |
| `ClusterRecord` | conservative bounds/cone、geometric error、child range、renderable Meshlet range、material/group flags | R2 CPU validator；R3 GPU traversal |
| `InstanceRecord` | geometry record index、material handle、current/previous object-to-world、object bounds/scale、flags、stable debug ID | 现有 flat work adapter、R3 instance cull、后续 resolve |

vertex/index/meshlet vertex/triangle/hierarchy child/BVH8 数据是连续 payload buffers，不伪装成独立生命周期 table。所有 GPU 引用使用 `u32` record index 或 word/element range；WebGPU Buffer 不保存 pointer/device address。

每个 schema 必须由同一声明生成或校验：

- TS pack/unpack；
- WGSL struct/read helper；
- byte offset、aligned size、stride；
- zero/fallback record；
- count/range/capacity validator。

具体 stride 在 R2-C 通过 schema test 和 upload/bandwidth benchmark 冻结，不能把当前 reconstructed layout 直接升级为 v1。

## Handle 与失效语义

- public handle 是 opaque branded value，至少包含 store identity、slot 和 generation；调用者不能用它计算 Buffer offset；
- GPU record 内只保存当前 residency epoch 有效的 `u32` slot/index，0 保留给明确 fallback/null record；
- table grow 不改变 handle；release 后 generation 增加，旧 CPU handle 必须失败；
- R2 不要求高频 slot reuse，但一旦实现 reuse 就必须验证 generation，不能让 stale handle 静默指向新资产；
- package 内的 `GeometryAssetId` 是设备无关逻辑 ID，不等于 `AssetHandle` 或 GPU table slot；
- `InstanceSetHandle` 标识连续或分段 instance allocation，range 只通过 debug/evidence API 暴露，不成为 Renderer public contract。

## Bulk upload、patch 与生命周期

### Bulk residency

- Reader 完成全包验证后，`GpuAssetStore.resident()` 才分配目标 range；失败不留下半驻留 handle；
- 首版连续 CPU bytes 默认用 `GPUQueue.writeBuffer` 上传，并满足 Buffer offset、data offset、size 的 4-byte 对齐；
- 首次上传记录 source bytes、uploaded bytes、write calls、padding、table grow 和 peak bytes；
- 只有相同条件 benchmark 证明大包 staging/copy 更优时，才引入 staging path；不提前建设 ring。
- 发生 grow 时必须遵守 queue 顺序：先在主 command 中 copy old → new，再在同一 command 中用一次性 upload buffer 覆盖与 old range 重叠的新数据；只落在 old size 之外的追加 range 才可直接 `writeBuffer`。禁止先 `writeBuffer` 旧 range、再被后续 old → new copy 覆盖。

### Patch

- Packed transform/material patch 接受显式 indices/ranges；CPU 先排序、去重并合并连续 spans；
- current transform 写入 previous，再写入新 current；同一 instance 同一 frame 多次 patch 的 previous 仍代表上一帧；
- 小而连续的 spans 使用 `writeBuffer`；稀疏 Compute scatter 只有在 1k/10k/100k patch-density benchmark 证明收益后启用；
- stable frame 无 patch 时不得分配 upload buffer、编码 Compute Pass、readback 或 submit。
- 直接 `writeBuffer` patch 一经入队就是已提交的 scene data change，不伪装成可由 command abort 回滚；需要事务性的 grow/relocation patch 必须走同一 command 内 copy path。

### Grow / retirement

- grow 在调用方主 command 中编码 old → new copy，不创建私有 submit；
- 当前帧切换到新 binding 后，旧 Buffer 通过 R1 completion-safe retirement 销毁；abort 必须恢复 owner 状态并销毁未提交的新 Buffer；
- 不在帧路径 `await queue.onSubmittedWorkDone()`；
- capacity 乘法、byte range 和 32-bit GPU index 溢出在分配前报错，不静默截断。

## 四个纵向执行包

R2 严格按 A → B → C → D 执行。每个包都必须交付可运行纵切，不能只创建类型、manager 或未被消费的 Buffer。

### R2-A · Package Kernel

目标：先证明“一份 bytes 能被可靠地产生、拒绝损坏并稳定读取”。

实施：

1. 登记 meshoptimizer 与 hierarchy 候选上游的 repo、commit/tag、源码路径、测试和许可证；创建对应 porting ledger。
2. 冻结 `SourceGeometry`、`GeometryCookRecipe`、通用 header/section directory 与 content hash 规则。
3. 实现 package writer、reader、validator；建立 tiny triangle、cube、多 material、alpha-tested、退化/恶意输入黄金资产。
4. 建立 deterministic rebuild、unknown optional/required section、截断、overlap、alignment、checksum、整数溢出测试。
5. 程序化 `BoxGeometry` 可先通过 in-memory SourceGeometry 进入 package，不再定义第二套目标格式。

退出证据：黄金 package byte-identical；所有 corruption case 被明确接受/拒绝；Reader/Cooker 不依赖 WebGPU；porting ledger 完整。

### R2-B · Cooked Geometry

目标：让 package 真正包含 R3 所需的 GPU-ready 几何，而非只包一层旧 runtime bytes。

实施：

1. 规范化 topology/attributes/material split，固定 meshoptimizer 输入不变量。
2. 生成并验证 Meshlet、bounds/cone 和连续 payload。
3. 生成有可绘制父级的 Cluster hierarchy、单调 geometric error 和 CPU reference selector。
4. 生成 BVH8、量化/decode 与 conservative bounds validator。
5. 定义 Geometry/Cluster logical records、压缩 stream recipe 与完整交叉引用 validator。
6. 对黄金资产输出 source/package bytes、Cook time、Meshlet/Cluster/BVH 数、层深和误差统计。

退出证据：见 04 文档；runtime package load 不执行 Meshlet、simplify、hierarchy 或 BVH build。

### R2-C · Residency + Compact Tables

目标：让一个 package 通过一个 owner 安全、可计量地进入 GPU。

实施：

1. 冻结 `AssetHandle` 与 `GeometryRecord`/`ClusterRecord` TS/WGSL schema；建立 0 号 fallback。
2. 实现 `GpuAssetStore.resident/release/bindings/evidence`，连续上传 geometry records 与 payload。
3. 实现 capacity/grow/copy/abort/completion-safe retirement，禁止 Buffer offset 泄漏到 public interface。
4. 把旧 flat Meshlet consumer 接到新 geometry binding adapter，先画出一个黄金资产。
5. 输出 logical/allocated/resident/peak bytes、upload calls/bytes/padding、grow 和 rejected package counters。

退出证据：黄金资产由新 store + 现有 Hardware consumer 渲染正确；bytes 可由 count × stride + payload 重算；grow/abort/release 无 use-after-free 或私有 submit。

### R2-D · Packed Scene Vertical

目标：让 A/C 的真实大量实例不再依赖一实例一 `Mesh/Node3D`，并关闭旧重复 owner。

实施：

1. 冻结 `InstanceRecord`、`InstanceSource`、`InstancePatchBatch` 和 `InstanceSetHandle`。
2. 实现 `GpuScene.instantiate/patch/bindings/evidence` 与 1k/10k/100k bulk path。
3. 普通 Scene adapter 写入同一 table；Packed source 不构造 JS Scene object 列表。
4. 将现有 flat cull/work/Hardware Visibility consumer 改读新 Instance/Geometry binding；R2 不改变最终 `drawIndirect` 策略。
5. 接通 transform/material patch、previous transform、stable-frame zero upload 与 patch-density benchmark。
6. A/C 从公开 `OEngine/src/index.ts` interface 使用新 package/Packed source；删除 package 主路径的 runtime Meshlet build、旧 geometry residency owner 和重复 scene table。

退出证据：Packed 与普通 adapter 在相同输入下 GPU record/画面一致；大规模曲线、patch 和 stable frame 证据通过；Renderer 不遍历 Packed 源列表构建最终可见工作。

## 迁移期间的唯一真相规则

| 数据 | R2-A/B | R2-C | R2-D 完成后 |
|---|---|---|---|
| package bytes / geometry metadata | `RuntimeAssetPackage` | 同左 | 同左 |
| resident Geometry/Cluster/payload | 旧 owner 仍服务旧页面 | `GpuAssetStore` 成为新路径唯一 owner | 旧 `MeshletGpuTable/GeometryBlasPool` residency 删除或仅剩无生产 consumer 的代码并立即删除 |
| instances | `SceneDatabase` | 迁移 adapter | `GpuScene` 是唯一 GPU Instance owner |
| material | 现有 material registry | 现有 registry + validated handle reference | 保留到 R4-B；R2 不制造第二张 Material table |

迁移 adapter 只能做字段转换，不能长期复制完整 GPU Buffer。任何保留的旧路径必须在同一任务记录删除点；“以后再看”不是退出状态。

## G2 验证矩阵

| 维度 | 必须证明 | 最小证据 |
|---|---|---|
| Package | version/hash/section/range 可靠 | unit/property tests + 黄金 package hash |
| Cooker | 输出确定、hierarchy/error/BVH8 正确 | upstream/CPU reference 对照 + validator report |
| ABI | TS/WGSL offset/stride 一致 | generated/schema tests + GPU roundtrip micro example |
| Residency | owner、capacity、grow、abort、retirement 正确 | lifecycle tests + browser example counters |
| Packed | 不依赖一实例一 JS object | 1k/10k/100k build/upload/CPU memory 曲线 |
| Patch | previous/current 与 dirty spans 正确 | 数值 test + 0%/1%/10%/100% density A/B |
| Stable frame | 不产生无效数据工作 | upload calls/bytes、patch passes、private submit 均为 0 |
| Main path | 新数据被真实消费者使用 | A/C 截图、console、counter 与 GPU timestamp |
| Memory | 数值可复算、无隐藏双份 owner | record/payload/resident/allocated/peak bytes |
| Regression | R1 契约不倒退 | one-submit、feature-off、no unconditional readback |

默认执行中等验证：相关 unit/property tests、`npm run build`、一个微型 WebGPU example 和命中的 A/C 浏览器页面。截图仅用于画面正确性；结构与性能结论必须来自 JSON/counter/timestamp。

## G2 完成定义

只有以下条件全部满足才能关闭 R2：

1. A/B/C 与黄金资产能产生并加载 package v1；
2. Meshlet、renderable hierarchy、geometric error 与 BVH8 已 Cook、验证并驻留；
3. Geometry/Cluster/Instance schema、handle、capacity、overflow/fallback 和 owner 已冻结；
4. A/C 的新 package + Packed path 被现有 Hardware consumer 真实消费；
5. stable frame 零数据上传，bulk/patch/grow/resident bytes 证据完整；
6. package 主路径不再 runtime 生成 Meshlet/hierarchy；旧重复 residency/instance owner 已删除；
7. `CURRENT-STATE`、相关 Context、public interface 与 migration ledger 同步。

G2 不要求 GPU traversal 已经使用 hierarchy。R2 关闭后的唯一下一步是 R3：读取这里冻结的 Instance/Geometry/Cluster/BVH8 数据，在 Meshlet 展开前完成 SSE/cull/compact，并把结果接入同一个 Hardware consumer。
