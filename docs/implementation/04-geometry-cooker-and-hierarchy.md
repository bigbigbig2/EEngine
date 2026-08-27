# 04 · R2 Geometry Cooker 与层次结构

## 阶段目标

离线把源几何转换为可版本化、可验证、GPU-ready 的 Meshlet、Cluster hierarchy、geometric error 和 BVH8，使 R3 能在展开大量 Meshlet 之前进行 GPU SSE LOD 与空间裁剪。

## 非目标

- 不在运行时逐帧做网格简化。
- 不把 Meshlet、Cluster Group、BVH node 和 streaming page 混成一种记录。
- 不在本阶段实现 geometry page streaming。
- 不要求层次结构依赖原生 mesh shader、64 位地址或 subgroup。

## 当前代码入口

| 当前入口 | 可用证据 | 需要替换/补齐 |
|---|---|---|
| `OEngine/src/geometry/meshoptimizer.ts` | meshopt 相关能力 | 明确版本、确定性和 cooker 调用 |
| `OEngine/src/geometry/niMeshlets.ts` | 现有 Meshlet 生成/读取 | 当前 reconstructed 格式不是目标 package ABI |
| `OEngine/src/geometry/MeshletTypes.ts` | header/element 常量 | 改为 schema 驱动并加入 layout validation |
| `OEngine/src/geometry/BoxGeometry.ts::MeshletGeometryBase` | Runtime 几何容器 | Loader 临时类不再拥有最终 resident 布局 |
| `OEngine/src/loaders/gltf/gltfGeometry.ts` | glTF primitive 解码入口 | 拆分 Source Geometry 与 Cooked Geometry |
| `OEngine/src/gpu/GeometryBlasPool.ts` | 现有 BLAS/BVH 思路 | 不冻结现有 node/submit/owner |

## Cooker 目标目录

建议把可在 Node 环境运行的离线逻辑与浏览器 runtime 分开：

```text
OEngine/tools/cooker/
├─ cli.ts
├─ GeometryCooker.ts
├─ MeshletBuilder.ts
├─ ClusterHierarchyBuilder.ts
├─ Bvh8Builder.ts
├─ GeometryPackageWriter.ts
└─ GeometryValidator.ts

OEngine/src/assets/
├─ RuntimeAssetPackage.ts
├─ GeometryAssetSchema.ts
└─ GeometryAssetReader.ts
```

Cooker 可以复用 `src/geometry` 中设备无关算法，但不得导入 WebGPU device 或 runtime GPU owner。

## Runtime geometry package v1

### 文件头

```text
magic                    8 bytes
formatVersion            u32
schemaHash               u32
endianness                u32 fixed marker
flags                     u32
sourceContentHash         128/256-bit
sectionCount              u32
totalByteLength           u64 in file format only
```

文件可以使用 u64 长度；GPU ABI 仍只使用 WebGPU 可表达的 buffer-relative `u32` offset/range。Reader 必须验证每个 section 的 offset、alignment、length、checksum 和交叉引用。

### Sections

```text
GeometryMeta
VertexStreams
MeshletHeaders
MeshletVertexIndices
MeshletTriangleIndices
ClusterRecords
ClusterChildren
Bvh8Nodes
MaterialRanges
OptionalDebugNames
```

每个 section 声明 element stride、count、compression、alignment 和 checksum。未知必需 section 拒绝加载；未知 optional section 可以跳过。

## 几何逻辑 ABI

### Meshlet

v1 硬约束：

- 最多 64 unique vertices；
- 最多 128 triangles，因此 `localTriangle` 可放入 VisibilityKey 的 7 bits；
- triangle indices 以局部 vertex index 存储；
- 每个 Meshlet 有 object-space sphere/AABB、normal cone、material slot、vertex/triangle range；
- alpha mode 不跨不可兼容 material range；
- 空 Meshlet、越界 index 和退化比例超过阈值由 validator 报告。

### Renderable Cluster / Cluster Group

首版 hierarchy 使用严格父子树作为 runtime traversal 契约；Cooker 内部可以用 DAG 优化，但序列化前必须展开为无多父歧义的 runtime tree。每个 renderable node 包含：

| 字段 | 语义 |
|---|---|
| bounds / normal cone | 该节点表示几何的保守包围 |
| geometricError | 相对源几何的 object-space 最大误差，上层不小于下层 |
| childBegin / childCount | 连续子节点，叶节点为 0 |
| meshletBegin / meshletCount | 选中该层时实际可 raster 的 Meshlet 范围 |
| material/group flags | alpha、double-sided、shadow 等分类所需固定 bits |

父节点必须有可绘制的简化表示，才能在 traversal capacity 紧张时安全选择父级 fallback。父子覆盖同一表面语义；同一实例同一分支一帧只能选择父或其子，不能同时选择导致重叠。

### Geometric error

- 使用 object-space、非负、单调误差；单位与 position stream 一致。
- 非均匀 scale 的实例使用最大轴缩放得到保守 world error。
- root error、leaf error 和无简化资产的 sentinel 明确写入 schema。
- Cooker 输出 sampled/reference 验证，不能只相信简化库返回值。

### BVH8

BVH8 用于快速拒绝空间上不可见的 hierarchy 范围，不等于 LOD tree。逻辑字段：8 个量化 child bounds、8 个 child refs/type bits、child count/valid mask。量化相对父 bounds 解码，validator 必须证明 decoded bounds 保守包含原 bounds。

WebGPU buffer 中只保存 `u32` word offset/index；不保存 pointer/device address。实际 stride 在 `COOK-05` 通过 bandwidth、alignment 和 shader decode benchmark 冻结。

## Cooker 顺序

```text
Import primitive
→ normalize topology/attributes/material splits
→ validate finite values and indices
→ vertex remap/cache/overdraw optimization
→ build leaf Meshlets
→ build simplified parent representations
→ calculate monotonic geometric error
→ build runtime hierarchy
→ build BVH8 over traversal ranges
→ quantize/compress streams
→ serialize versioned sections
→ full package validation
→ optional CPU reference render/traversal
```

输入顺序、工具版本和参数相同必须得到 byte-identical package，或者在文档中列出唯一允许变化的 debug section。

## Producer/consumer 与生命周期

- Producer：离线 GeometryCooker。
- CPU consumer：RuntimeAsset reader/validator、GPU Asset Table uploader。
- GPU consumers：Instance cull、BVH8 traversal、SSE LOD、Cluster cull、SW/HW raster、Material Resolve。
- Owner：RuntimeAssetRegistry 拥有 package bytes/decoded metadata；ResidentGeometry owner 拥有 GPU ranges。
- 生命周期：package 设备无关；GPU ranges 绑定当前 device，grow/replace/destroy 遵守 in-flight completion。

## Capacity 与错误处理

- 所有 count/offset 在写入 `u32` GPU ABI 前检查乘法、加法和对齐溢出。
- 单资产超过配置 cluster/meshlet/vertex 上限时 Cooker 失败并报告 section 与实际值，不截断。
- hierarchy depth 超过 shader traversal 上限时重新平衡或拒绝；不让 runtime 栈越界。
- material/texture 引用缺失可以使用显式 fallback material，但记录 package warning；几何索引越界是 hard error。
- package version/schema hash 不匹配时拒绝 resident，不做猜测性迁移。

## 执行任务

### COOK-01 · 固定输入和黄金资产

选择小三角形、cube、多 material、alpha-tested、非流形/退化、Teapot A、IBL B 和高密度 C 资产。保存源 hash、导入参数和期望统计。

### COOK-02 · 拆分 Source Geometry 与 Runtime Geometry

让 glTF/USD Loader 产设备无关规范化输入；浏览器直接加载 cooked package 时不重复 meshlet/hierarchy 生成。

### COOK-03 · 冻结 package header/section schema

实现 reader/writer、endianness、checksum、schema hash、未知 section、截断/恶意长度测试。格式版本从 1 开始。

### COOK-04 · 生成和验证 Meshlet

统一 64 vertices/128 triangles 上限、material split、bounds 和 cone。与现有 `niMeshlets` 输出对照后，决定复用算法还是删除旧格式。

### COOK-05 · 生成 renderable hierarchy 与 error

父级必须可绘制、error 单调、父子覆盖互斥。建立 CPU traversal/reference 选择器，输出每层 cluster/triangle/error 统计。

### COOK-06 · 生成 BVH8

实现 build、quantize、decode 和 conservative bounds 测试。对 line、flat、huge/small bounds、空 child 和深树做 property tests。

### COOK-07 · 压缩 vertex/index streams

记录 decode 成本、字节数和精度误差。position、normal/tangent、UV、skin 数据分别定义格式；不能为省带宽破坏 B 场景 PBR/velocity。

### COOK-08 · 建立完整 validator

检查 section、range、tree cycle/multi-parent、orphan、error monotonicity、bounds containment、Meshlet limits、material references 和 BVH conservative decode。

### COOK-09 · 接入 GPU Asset Tables

package 上传到 R2 Geometry/Cluster tables；记录 resident bytes、upload bytes、range 和 handle。Runtime 不重新生成 hierarchy。Texture/geometry streaming state machine 不属于本任务。

### COOK-10 · 删除旧 runtime 生成与格式

真实场景全部走 package 后，删除只服务旧 `MeshletGeometryBase`/`niMeshlets` 二进制布局的 runtime 热路径与 adapter。若保留程序化 BoxGeometry，必须通过同一 in-memory cooker/schema，不创建第二种 GPU ABI。

## 验收

### 正确性

- 黄金资产可 byte-identical 重建，package corruption 被 reader 拒绝。
- CPU reference 在不同 SSE 阈值下不漏面、不重复父子、误差单调。
- BVH8 decode 后 bounds 始终保守；GPU/CPU traversal 在小场景选中相同集合。
- Material/alpha/双面边界在 Meshlet 与 Cluster 层不被错误合并。

### 性能与规模

- 报告源字节、package 字节、resident 字节、Cook 时间、Meshlet/Cluster/BVH node 数和层深。
- A/B/C 报告各 SSE 下展开前后的候选量。
- runtime load 不执行 mesh simplify/hierarchy build；warm load 只做验证、分配和上传。
- shader decode 与未压缩 baseline 对照，任何回退说明节省的带宽是否值得。

## 回退与失败条件

- hierarchy 父级不可绘制或出现洞：停止 GPU traversal，修正 cooker，不在 runtime 补洞。
- geometric error 无法验证：该资产只能作为单层 Meshlet 资产，明确标记，不伪造 LOD。
- BVH8 量化不保守：临时使用未量化 bounds 进行验证，不能接受漏绘。
- package 频繁变化：冻结最小 v1 sections，实验数据放 optional section，不让每个实验破坏 reader。

## 阶段退出

A/B/C 与黄金资产能稳定产出并加载 v1 package；Meshlet、renderable hierarchy、error 和 BVH8 通过 CPU/GPU 小场景验证；旧 runtime 热路径删除。更新 asset/geometry/gpu-world Context、`CURRENT-STATE`，然后开始 R3 GPU traversal。
