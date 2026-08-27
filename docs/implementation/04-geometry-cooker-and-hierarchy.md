# 04 · R2 Geometry Cooker 与层次数据契约

## 本文所有权

本文只拥有 Geometry Cooker 的输入、算法不变量、geometry package sections 和验证规则。通用 package header、GPU residency、Packed Instances、执行顺序和 G2 Gate 由 [03-runtime-assets-and-gpu-world](./03-runtime-assets-and-gpu-world.md) 拥有。

R2 在这里“生成并冻结层次数据”，R3 才“每帧在 GPU 上遍历层次数据”。如果 Cooker 没有可绘制父级、可信 geometric error 和保守 BVH8，R3 无法靠 Shader 补救。

## 当前代码事实

| 当前入口 | 可复用部分 | 不能直接冻结为 v1 的部分 |
|---|---|---|
| `geometry/meshoptimizer.ts` | 已有 meshoptimizer WASM seam | 上游版本、参数、determinism 和许可证 ledger 尚未随 package 固定 |
| `geometry/niMeshlets.ts` | Meshlet build/read、部分 bounds/压缩逻辑 | 当前上限为 128 vertices/128 triangles，40B header 与旧地址布局混合，且 runtime 可执行 build |
| `geometry/BoxGeometry.ts` | 程序化 source geometry | 构造函数直接 `niFromGeometry()`，会建立第二条 runtime Cook 路径 |
| `loaders/gltf/gltfGeometry.ts` | glTF accessor 解码、属性规范化和 primitive cache | 输出 `MeshletGeometryBase` 并在 Loader 阶段调用 `niFromGeometry()` |
| `gpu/GeometryBlasPool.ts` | completion-safe grow 的局部经验 | 旧 Dynamic BVH、32B node、geometry object map 和重复上传不是目标 ABI |

第一步不是在这些类旁边再建一套新类，而是先把 glTF/程序化输入提取为设备无关 `SourceGeometry`，再让旧页面和新 package 在迁移期共享这一个输入 seam。

## 开源复用决定点

具体算法实现开始前必须从 [references/README](../references/README.md) 和 [OPEN-SOURCE-REUSE](../references/OPEN-SOURCE-REUSE.md) 路由，并在 `docs/references/porting/` 创建 ledger。没有固定 commit/tag、源码路径和许可证前，不复制或翻译表达性代码。

| 能力 | 首选来源 | 采用目标 | 必须保留的不变量 |
|---|---|---|---|
| vertex remap/cache/fetch、Meshlet build、bounds/cone、simplify | meshoptimizer | 直接依赖或可追溯局部移植 | 输入索引/stride、max vertices/triangles、cone 语义、simplify error |
| renderable hierarchy、error propagation、BVH8、validator | Bevy Meshlet | 以固定版本源码和测试做局部移植/CPU reference | 父级可绘制、error 单调、reachability、保守 bounds |
| WebGPU 数据布局和 CPU/GPU 对照 | Scthe/nanite-webgpu | 只迁移已验证且许可证兼容的局部实现 | `u32` index、固定 capacity、overflow 与统计 |
| GPU Scene/record 简洁性 | AnKi/Niagara | 概念与 ABI 对照 | 不带入 MDI、mesh shader、device address 假设 |

上游实现仍必须通过 OEngine 黄金资产、恶意输入、A/B/C 和 WebGPU consumer 验证；“来自成熟项目”不能替代本地 Gate。

## 目录与依赖

目标目录允许按实现语言微调，但依赖方向必须保持：

```text
OEngine/src/assets/
├─ SourceGeometry.ts             importer / procedural 共用输入
├─ RuntimeAssetPackage.ts        通用 reader + validated views
├─ RuntimeAssetSchema.ts         package kernel schema
└─ geometry/
   ├─ GeometryAssetSchema.ts     geometry sections / logical records
   └─ GeometryAssetValidator.ts  runtime-safe validation

OEngine/tools/cooker/
├─ cli.ts
├─ GeometryCooker.ts             单一深 interface
├─ GeometryCookRecipe.ts
├─ GeometryPackageWriter.ts
└─ geometry/                     内部算法，不成为 runtime public API
```

- `src/assets` 不导入 `GPUDevice`、Renderer、Scene 或 Loader；
- `tools/cooker` 可以导入设备无关 math/meshoptimizer，但不导入 `src/gpu`；
- glTF importer 只负责解码/规范化为 `SourceGeometry`；
- browser 中的程序化 geometry 可以调用同一 in-memory Cooker，但不能创建不同 GPU ABI；
- Cooker CLI 是同一 `GeometryCooker.cook()` 的 shell，不复制算法。

## `SourceGeometry` 契约

`SourceGeometry` 是 Cooker 唯一几何输入，不是长期 runtime asset：

```ts
interface SourceGeometry {
  readonly topology: "triangle-list";
  readonly indices: Uint32Array;
  readonly attributes: ReadonlyMap<VertexSemantic, SourceVertexStream>;
  readonly materialRanges: readonly SourceMaterialRange[];
  readonly sourceBounds?: SourceBounds;
  readonly sourceId: string;
}
```

进入 Cooker 前必须满足：

- index 已展开为 triangle list，且每个 index 在 vertex count 内；
- position 必须存在且为有限数；normal/tangent/UV/skin 等缺失与生成策略写入 recipe；
- material ranges 不重叠，完整覆盖可绘制 triangle；alpha mode、double-sided、shadow flags 不跨不兼容边界；
- glTF sparse/normalized/interleaved accessor 已在 importer 层正确解码；
- source object 不包含 GPU Buffer、bind group 或 Renderer handle。

## `GeometryCookRecipe` 与确定性

Recipe 至少冻结：

- tool/schema version 与上游算法版本；
- Meshlet max vertices/triangles、cone weight；
- simplify target ratios/error thresholds、hierarchy fanout/depth limit；
- BVH branching/quantization 参数；
- vertex stream format、quantization range 和缺失属性策略；
- degenerate/non-manifold 处理与 warning/error threshold；
- deterministic seed、浮点模式或任何会影响 bytes 的平台条件。

content hash 覆盖规范化后的 source、recipe 和影响结果的工具版本。相同三者必须生成 byte-identical required sections；debug name/timestamp 等非确定内容只能进入不参与 hash 的 optional debug section。

R2-A 的 v1 recipe 采用 hierarchy target fanout 8、simplify ratio 0.5/absolute error/failure ratio 0.60；BVH 和 vertex bounds 暂不量化，optional attribute 保留缺失状态，degenerate/non-manifold 从第一个命中项开始 warning 或按 policy reject；浮点条件固定为 IEEE-754 round-to-nearest 且禁用 fast-math。R2-B 若以证据改变任一值，必须升级 recipe key 并重建黄金 hash，不能静默改变同一 v1 identity。

## Geometry package sections

通用 section directory 格式见 03。Geometry v1 使用以下 section type，不把 Meshlet、Cluster、BVH 或未来 streaming page 混为一种记录：

```text
GeometryDirectory
VertexStreamDescriptors
VertexStreamData
IndexData
MeshletRecords
MeshletVertexIndices
MeshletTriangleIndices
ClusterRecords
ClusterChildren
Bvh8Nodes
MaterialRanges
OptionalDebugNames
```

每个 section 由通用 directory 声明 byte offset/length、element stride/count、alignment、flags/compression 和 checksum。Reader 先验证通用 directory，再由 Geometry validator 验证跨 section 引用。

R2-B-01 已冻结可独立 reopen 的最小 Geometry slice：

| Section | Type | Stride | R2-B-01 语义 |
|---|---:|---:|---|
| `GeometryDirectory` | `0x1000` | 192 B | required，恰好 1 条；little-endian，尾部 8 B reserved 必须为 0 |
| `MeshletRecords` | `0x2000` | 112 B | required；连续引用 vertex/local-triangle payload |
| `MeshletVertexIndices` | `0x2001` | 4 B | required；`u32` SourceGeometry vertex index |
| `MeshletTriangleIndices` | `0x2002` | 1 B | required；每 triangle 3 个 Meshlet-local `u8` index |

`GeometryDirectory` 保存 schema/flags、source counts、未来 section ranges、实际 Meshlet limits、object-space AABB/sphere、source SHA-256 与 recipe SHA-256。R2-B-01 对尚未存在的 stream/material ranges 写 0，对 hierarchy/BVH root 写 `0xffffffff` 且 count 写 0，并用 `SingleLevel | NoHierarchy | NoBvh | Uncompressed` 明确能力边界。`MeshletRecord` 保存 payload offset/count、material range ordinal/material ID、alpha/double-sided/cone flags、AABB、sphere 与 cone；reserved bytes 必须为 0。完整 stream/material cross-reference 在 R2-B-04 冻结前不得伪造。

### `GeometryDirectory`

每个 geometry entry 至少包含：

- object-space sphere/AABB；
- vertex stream descriptor range、index range；
- Meshlet、Cluster、BVH8 的 root/range；
- material range；
- position decode metadata 与 geometry flags；
- 无 hierarchy/no simplification 的显式 flag，而不是伪造 error。

### Vertex / index payload

- position、normal/tangent、UV、color、joint/weight 各自声明格式和 decode 参数；
- 压缩前后误差按 semantic 单独报告；
- position quantization 解码后的 bounds 必须保守，不能造成 frustum/HZB 漏绘；
- B 场景的 normal/tangent/UV 与 velocity 所需数据不得为省带宽被静默移除；
- R2-B 可以先冻结正确的未压缩 format，再用同条件 decode/bandwidth benchmark 决定压缩，不允许压缩阻塞基础闭环。

## Meshlet 契约

v1 默认 recipe：

- 最多 64 unique vertices；
- 最多 128 triangles，因此 `localTriangle` 可由后续 VisibilityKey 的 7 bits 表达；
- triangle indices 使用 Meshlet-local vertex index；
- record 包含 object-space conservative sphere/AABB、normal cone、material slot、vertex/triangle ranges 和 flags；
- 不兼容的 alpha mode、double-sided 或 material group 不跨同一可绘制 range；
- 空 Meshlet、越界 local/global index 是 hard error；退化 triangle 按 recipe threshold warning 或拒绝。

64/128 是 v1 默认值，不是假定为所有 GPU 的永久最优值。R2-B 必须保留 32/64、64/64、64/128 等离线 variant benchmark 结果；一旦写入 package，实际 limits 必须由 schema/recipe 可验证。当前 `niMeshlets.ts` 的 128-vertex layout 不能直接冒充 v1。

## Renderable Cluster hierarchy

Cluster node 与 Meshlet 不同：Cluster 是 LOD/traversal 选择单位，Meshlet 是最终 raster 工作单位。

每个 runtime Cluster 逻辑上包含：

| 字段 | 不变量 |
|---|---|
| bounds / normal cone | 保守包含该 node 表示的可绘制几何 |
| `geometricError` | object-space、有限、非负；父级不小于任一子级 |
| `childBegin/childCount` | 连续 child index range；叶为 0；无 cycle/multi-parent/orphan |
| `meshletBegin/meshletCount` | 选择该层时真正可 raster 的简化表示 |
| material/group flags | alpha、double-sided、shadow 等分类所需固定 bits |

首版 runtime 契约是严格父子树。Cooker 内部可以使用 DAG 或临时 group，但序列化前必须展开为无多父歧义的 tree。

父级必须有可绘制简化表示，才能在 traversal capacity/深度异常时保守 fallback 到父级。同一实例、同一 hierarchy 分支、同一帧只能选择父或子，不能同时选择；CPU reference 必须检测洞、重复覆盖和 unreachable node。

## Geometric error 与 CPU selector

- error 使用与 position stream 相同单位的 object-space 最大偏差；
- 非均匀 instance scale 用最大轴 scale 得到保守 world error；
- projected error / SSE 的 camera 公式只在 CPU reference 和 R3 共用 helper 中定义，Cooker 不写死 viewport；
- root/leaf error 和不可简化 sentinel 在 schema 中有明确值；
- simplify library 返回值需要 sampled/reference 验证，不能直接视为真值；
- parent error 通过 bottom-up propagation 保证单调；若无法证明，则资产标记 single-level，不伪造 hierarchy。

CPU selector 输入 geometry root、instance transform、camera、viewport 和 SSE threshold，输出 selected Cluster/Meshlet IDs 及 visited/rejected counters。R2 用它验证 package；R3 用它作为 GPU traversal oracle。

## BVH8 契约

BVH8 只加速空间拒绝，不等于 LOD tree。逻辑字段：

- 相对 parent bounds 量化的 8 个 child bounds；
- 8 个 child refs/type bits；
- valid mask/child count；
- leaf 指向连续 Cluster traversal range，不指向裸 Buffer 地址。

validator 必须证明 decode 后的 child bounds 保守包含原始 bounds。line/flat/point-like、极大/极小范围、空 child、深树和量化边界需要 property tests。若量化方案不保守，R2-B 暂时使用未量化 bounds；不能接受漏绘。

WebGPU payload 只保存 `u32` element/word index。实际 stride 由 schema test、bytes 报告和 R3 decode prototype 共同冻结，不能照搬 `GeometryBlasPool` 的 32B node。

## Cooker pipeline

```text
validate SourceGeometry
→ normalize topology / attributes / material splits
→ vertex remap + cache/fetch optimization
→ build leaf Meshlets + conservative bounds/cone
→ build simplified renderable parents
→ validate and propagate monotonic geometric error
→ serialize strict runtime hierarchy
→ build BVH8 over traversal ranges
→ quantize/compress streams where evidence permits
→ write versioned sections
→ reopen bytes and run full validator
→ run CPU selector/reference statistics
```

Writer 不得直接信任内部对象。Cook 完成的定义是“重新从最终 bytes 打开并通过 validator”，不是“内存中的 builder 没抛异常”。

## Validator 分层

### Package kernel validator（R2-A）

检查 magic/version/schema、endianness、section bounds/overlap/alignment/checksum、required/optional、整数加乘溢出和 content hash。

### Geometry structural validator（R2-B）

检查 attribute/index/material ranges、Meshlet limits、Cluster tree cycle/multi-parent/orphan、root reachability、depth/capacity、所有跨 section index/range。

### Geometry semantic validator（R2-B）

检查 finite values、bounds containment、cone、父子覆盖/互斥、error 单调、BVH decode conservative、压缩误差和 single-level fallback。

### Runtime residency validator（R2-C）

检查 package schema 与 runtime 支持匹配、GPU `u32` range 可表达、目标 Buffer 4-byte alignment/capacity、material reference 可解析和 resident bytes 可复算。

任何 hard error 都发生在分配 GPU range 之前。material reference 缺失可绑定显式 fallback 并记录 warning；geometry/index/tree corruption 必须拒绝 resident。

## R2-A / R2-B 任务顺序

### R2-A-01 · 上游与 recipe ledger

锁定 meshoptimizer/Bevy 候选版本、许可证、源码和测试；记录采用状态与 WebGPU/OEngine 差异。完成前不开始表达性算法移植。

状态：完成。见 [meshoptimizer ledger](../references/porting/R2-A-01-meshoptimizer.md) 与 [Bevy Meshlet ledger](../references/porting/R2-A-01-bevy-meshlet.md)。

### R2-A-02 · SourceGeometry seam

从 glTF accessor 解码与 `buildBoxMesh()` 提取同一 `SourceGeometry`；验证 material ranges、finite/index 和 deterministic normalization。旧 `niFromGeometry()` 暂由 adapter 调用，不改变真实页面。

状态：完成。glTF 先生成 owned/validated `SourceGeometry` 再经 legacy adapter 调用 `niFromGeometry()`；`buildBoxSourceGeometry()` 提供同一程序化 seam。

### R2-A-03 · Package kernel + 黄金资产

实现通用 writer/reader/validator 与 tiny/cube/multi-material/alpha/degenerate/corruption fixtures。以 reopen 后的 bytes 作为所有后续任务输入。

状态：完成。Package Kernel v1 见 [ADR-0008](../wiki/adr/0008-runtime-asset-package-kernel-v1.md)；fixtures 由 `source-geometry.test.mjs`、`geometry-cook-recipe.test.mjs` 和 `runtime-asset-package.test.mjs` 拥有。tiny、cube、multi-material、alpha-tested 与 degenerate source 均固定 content/file SHA-256 并 reopen；恶意 source 与 package corruption 明确拒绝。完整 OEngine 测试、examples production build 与 `r2-package-kernel` 浏览器纵切通过；页面确认损坏 payload 被 checksum/content hash 双重拒绝，控制台无 warning/error。

### R2-B-01 · Meshlet vertical slice

从固定 `SourceGeometry` 调用登记的 meshoptimizer 能力，输出新 Meshlet sections；对照上游统计和现有 `niMeshlets` 画面，但不复用旧 header ABI。

状态：完成。新路径直接依赖锁定的 `meshoptimizer@1.0.0`（tag `v1.0`、commit `73583c3`），按 material range 分批调用 `buildMeshlets()`，以 `extractMeshlet()` 去掉上游 aggregate 尾部，并把 `computeMeshletBounds()` 结果保守化后写入 OEngine sections。Cook 完成前必须从最终 bytes 重新打开；runtime open 不调用 meshoptimizer，也不创建 WebGPU/GPU 资源。复用证据见 [R2-B-01 porting ledger](../references/porting/R2-B-01-meshoptimizer-package.md)。

固定 16×16 Grid 黄金结果：

| Recipe | Meshlets | Vertex refs | Triangles | Package bytes | Content hash |
|---|---:|---:|---:|---:|---|
| 32/64 | 13 | 393 | 512 | 5056 | `b4571b2f54857249299ee06805fd147fec5573ba2ab705877cd5f556dcabe065` |
| 64/64 | 8 | 375 | 512 | 4416 | `b1cdd425d9422d6364e1a88a5dbc32931b451a4463597d3500633df7491c5d83` |
| 64/128 | 6 | 342 | 512 | 4064 | `cb63d50124f7d2e9f14b173eba6409326c585dac62378095775a2ad9b0aa32ca` |

验证覆盖 byte-identical rebuild、triangle coverage、Meshlet sphere 包含 source vertices、material/alpha/double-sided 分界、limits/连续 ranges、local/global index、reserved bytes、identity、bounds/cone 与 trailing payload。由于 R2-B-01 尚未写入 vertex streams，package reopen 只能验证 bounds 的有限性/顺序；基于真实 vertex position 的完整 bounds containment 会在 R2-B-04 随 streams 一起进入 package validator。根目录 `r2-meshlet-cooker` example 已通过 production build，并由本机 Edge 页面截图确认 `PASS`、512 triangles、13/8/6 Meshlets 与 byte-identical rebuild；应用内 Browser runtime 初始化失败，备用页面验证未采集 console 日志，因此 console 不登记为通过证据。

### R2-B-02 · Renderable hierarchy + error

先支持一个有明确父/叶关系的黄金资产；建立 CPU selector、覆盖互斥、reachability 和 monotonic error tests，再扩展 A/B/C。

状态：当前唯一入口。不得在 hierarchy 可绘制父级、误差语义与 CPU selector 尚未闭环时提前进入 BVH8 或 GPU residency。

### R2-B-03 · BVH8

实现 build/quantize/decode，先过 conservative property tests，再将 root/range 写入 GeometryDirectory。BVH8 不替代 hierarchy。

### R2-B-04 · Streams 与 material boundaries

冻结 v1 vertex/index formats、material ranges 和 decode metadata；正确性版本先行，压缩 variant 用 bytes/误差/decode benchmark 决策。

### R2-B-05 · 完整 validator 与报告

每个黄金资产输出 source/package bytes、Cook time、Meshlet/Cluster/BVH 数、depth、error distribution、warnings 和 hash；损坏任一交叉引用必须被拒绝。

### R2-B-06 · Runtime build 删除准备

browser package load 停止执行 Meshlet/hierarchy/BVH build；程序化 geometry 通过同一 in-memory Cooker。保留旧 `niMeshlets` 的每个 reader/consumer 建立迁移矩阵，交给 R2-C/D 删除。

## R2-B 退出证据

- 相同 source hash + recipe + tool version 产生 byte-identical required sections；
- package corruption、越界、cycle、多父、orphan、非单调 error 和不保守 BVH 均被拒绝；
- CPU selector 在不同 SSE threshold 下不同时选择同一分支父子，不产生空洞；
- A/B/C 与黄金资产都有 Meshlet/Cluster/BVH/depth/error/bytes 报告；
- alpha/double-sided/material boundaries 未被错误合并；
- runtime load 只做 open/validate/resident，不执行 mesh simplify、Meshlet、hierarchy 或 BVH build；
- porting ledger 记录 source/commit/license/invariants/adaptation/tests/benchmark；
- 新 package 尚未被 GPU traversal 使用是 R2 的正常状态，不得因此阻塞 R2-B；真正的 GPU CPU 集合对照属于 R3。

## 失败与回退

- 父级不可绘制或出现洞：停止该资产 hierarchy 输出，修正 Cooker；runtime 不补洞。
- geometric error 无法验证：输出显式 single-level asset，记录 blocker，不伪造 LOD。
- BVH8 量化不保守：使用未量化 bounds 继续验证，不能接受 false negative。
- 压缩破坏 PBR/velocity：保留未压缩 stream；压缩不是 G2 必需条件。
- 上游许可证不明或不兼容：只保留论文/规格层概念，独立实现并记录依据，不复制代码。
- package schema 频繁变化：实验字段进入 optional section；required v1 只因真实 consumer 需求升级。
