# 12 · Packed Asset 到 Surface 主链直接重构

> 状态：**已批准；两个步骤的生产代码迁移完成，浏览器与性能 Gate 待实机执行**
> 冻结日期：2026-09-03  
> 适用范围：`Packed glTF → Geometry Cooker → Runtime Package → GpuAssetStore → Packed Instance Tables → Hierarchy/SSE/Cone/HZB → GPU Work Generation → RasterWork → drawIndirect → VisibilityKey/Reverse-Z → Material Resolve → Surface`  
> 明确终点：`Surface`；本文不决定 Forward、Deferred、Lighting、IBL、AO、SSR、Temporal 或 Post 架构。

2026-09-03 第一步代码迁移证据：24 B exact `RasterWork`、direct `VisibilityKey`、OPAQUE/MASK 双队列、The Forge 23.8 triangle filter、position-only OPAQUE Visibility、SceneResidencyManifest、geometry 字典单事务 resident/release、glTF 同 mesh true instancing/兼容 primitive merge，以及 debug/counter/示例调用方已进入同一生产 ABI。旧 `GpuMaterialVisibilityTable` 已删除，稳定 MaterialRecord 与 TextureRef 分别由 `GpuMaterialStore`、`TextureResidency` 持有；高分辨率 RGBA8 bank 按事务实际尺寸与 layer 数分配，不再无条件创建 `16 × 4096²`。非浏览器全量测试通过。由于调用方明确要求不启动浏览器，WebGPU diagnostics 与 paired 性能/显存 Gate 尚未执行；KTX2/Basis 压缩产品和跨 node spatial static merge 仍是资产生产增强项，不作为本次未经实机 Gate 的已完成能力宣称。可机读停止预算保存在 `OEngine/benchmarks/packed-asset-to-surface-targets.json`。

2026-09-03 第二步代码迁移证据：MaterialRecord ABI 直接携带有界 `MaterialKernelClass`，GeometryRecord 直接携带 normal/tangent/color/UV canonical descriptor；生产 shader 已删除 `find_stream`。`VisiblePixelClassifier` 以 workgroup 计数、递归 exclusive prefix scan、scatter 生成一像素一记录的有界 `ShadeWorkQueue`，再由固定 7 个 class 的 `drawIndirect` 专用 kernel 写 Surface，材质数量不再改变 draw 数或 shader 热分支集合。Velocity 只在 Temporal/AO/SSR/MotionBlur 存在消费者时创建并通过 pipeline override 编译进 shader，feature-off Surface 从 26 B/pixel 降到 22 B/pixel。counter schema v12 增加 7 类像素与 ShadeWork overflow 证据；旧 fullscreen Resolve 证据合同已迁移为 bounded kernel contract。Node/build/example 验证结果见提交记录；按调用方要求未启动浏览器，因此 WGSL runtime diagnostics、Dungeon/dense paired timestamp、显存与截图 Gate 仍待实机执行，不把目标预算写成已达成事实。

相关权威：

- 产品范围与平台：[TARGETS](../TARGETS.md)、[DIRECTION](../DIRECTION.md)；
- 当前架构与事实：[ARCHITECTURE](../ARCHITECTURE.md)、[CURRENT-STATE](../CURRENT-STATE.md)；
- 固定测量规则：[PERFORMANCE](../PERFORMANCE.md)；
- 当前 Visibility 长期合同：[ADR-0010](../wiki/adr/0010-r4-unified-visibility-contract.md)；
- 开源采用纪律：[OPEN-SOURCE-REUSE](../references/OPEN-SOURCE-REUSE.md)、[porting ledgers](../references/porting/README.md)。

## 1. 决策

现有主链不增加第二条生产路径，也不添加 `V2`、`next`、`legacy/new` 等产品命名。实施时直接迁移现有接口、ABI、owner、调用方、测试和示例，迁移完成的同一工作包删除被替代实现；Git 历史和迁移前 artifact 是唯一回退依据。

以下名称继续代表唯一生产合同：

- `RuntimeAssetPackage`；
- `GpuAssetStore`；
- `RasterWork`；
- `VisibilityKey`；
- `PackedMaterialResolvePass`；
- `SurfaceFrame` / `GpuSurfaceAbi`。

内部格式版本必须递增并被 reader/validator 强校验，但不得把版本号写进类型名、文件名、Pass label、UI 或并行 runtime owner。旧 package 在所有仓库内调用方迁移后直接拒绝，不保留生产兼容 reader。

目标主链只有一条：

```text
Packed glTF
→ Scene Normalize
→ Static Merge / True Instancing
→ Geometry + Material + Texture Cooker
→ Canonical Geometry + Exact Meshlet/Hierarchy + Compressed Texture Product
→ RuntimeAssetPackage + SceneResidencyManifest
→ Transactional GpuAssetStore / GpuMaterialStore / TextureResidency
→ Packed Instance Tables
→ Hierarchy/SSE/Cone/Previous-HZB
→ SelectedCluster
→ Exact Triangle Filter + Compact
→ RasterWork（一个 record 精确对应一个 triangle）
→ exact drawIndirect
→ VisibilityKey（值等于 RasterWork slot）+ Reverse-Z
→ visible-pixel MaterialKernel classification
→ bounded specialized Material Resolve
→ compact Surface
```

这不是“低几何走一条、高几何走另一条”的路由设计。低多边形 Dungeon 是固定成本 Gate，高几何场景是吞吐 Gate；二者经过完全相同的生产链。

## 2. 为什么要直接推翻当前局部实现

### 2.1 当前实测不是 Hierarchy 问题

固定条件为 `1921×913`、AO/SSR/Temporal 关闭。用户采集的生产数据为：

| 阶段 | P50 | P95 | P99 |
|---|---:|---:|---:|
| Hierarchy / Work Generation | 0.20 ms | 1.11 ms | 2.49 ms |
| Hardware Raster | 3.34 ms | 4.33 ms | 5.64 ms |
| Material Resolve / Surface | 15.66 ms | 17.96 ms | 18.22 ms |
| Lighting & IBL | 4.98 ms | 6.16 ms | 6.88 ms |

本文只处理前三项并止于 Surface。当前主瓶颈是 Material Resolve，其次是固定上限提交的 Hardware Raster；Hierarchy P50 不是优先重写对象。

### 2.2 资产粒度从入口开始污染下游

当前 `load_gltf_packed()` 对每个 glTF node/primitive 创建独立 `SourceGeometry` 和 Instance。Dungeon 证据为：

- 814 instances；
- 806 geometry packages；
- 72,233 source triangles；
- 5,837 meshlets；
- 2,636 clusters；
- 7,958 upload calls。

平均每个 geometry 只有约 `89.6` triangles，平均每个 meshlet 只有约 `12.4` triangles。源格式 primitive 边界被错误保留成 runtime residency 和工作生成边界，导致 tiny package、tiny meshlet、过多 allocation/upload/record lookup。

### 2.3 当前 RasterWork 不是精确工作量

当前 `RasterWork` 是 12 B：

```text
visibleClusterSlot
meshletRecordIndex
rasterFlags
```

Hardware consumer 对每个 record 固定提交最多 384 vertices，即 128 triangles。当前面板中的 `109,312 triangles` 实际是 `854 × 128` 的提交上限，不是模型真实可见三角形。相对 72,233 个全场 source triangles，这个数字已经证明固定填充和统计语义不能继续作为产品合同。

### 2.4 当前 VisibilityKey 延长了热路径回查

当前 32-bit Key 编码 `25-bit rasterWorkSlot + 7-bit localTriangle`，Material Resolve 需要：

```text
VisibilityKey
→ RasterWork
→ VisibleCluster
→ Meshlet
→ Instance / Geometry / Material
→ generic stream descriptors
→ vertex attributes
```

这套编码解决了旧 Meshlet work 的唯一定位，但它也把旧工作粒度固化进每个可见像素。直接重构后，Key 自身就是精确 triangle work slot，不再携带 `localTriangle`。

### 2.5 当前 Material Resolve 是通用解释器

当前单次 fullscreen Resolve 虽然消除了“每材质一次全屏扫描”，但每个可见像素仍执行通用 stream 查找、格式分支、三顶点读取、UV 选择/变换、解析梯度、TBN、多个可选纹理分支、velocity 和六个 MRT 写出。33 个材质不代表低成本；约 175 万可见像素会重复支付这套解释开销。

### 2.6 当前纹理驻留是固定未压缩数组

`GpuMaterialVisibilityTable` 当前固定拥有：

- `64 × 256² × RGBA8 + mip` 标准数组；
- 惰性 `16 × 4096² × RGBA8 + mip` 高分辨率数组；
- 以 render/copy 把来源纹理统一转换进数组。

25 张 4K RGBA8 完整 mip 的理论像素数据已约 533 MiB，固定 layer slack、来源 GPUTexture、转换中间态和其它资源会继续放大 `allocated 1.4 GiB / resident logical 542.3 MiB`。这不是仅调 texture array layer 数量可以产品化解决的问题。

### 2.7 当前 Surface 固定写出 26 B/pixel

当前 `GpuSurfaceAbi` 固定写：PBR 2 B、normal 8 B、albedo/AO 4 B、emissive 4 B、velocity 4 B、metadata 4 B，共 26 B/pixel，不含 depth。`1921×913` 每帧约写 43.5 MiB Surface；即使 Temporal、emissive 或 metadata 没有消费者也仍然存在。

## 3. 不变量与非目标

### 3.1 必须保留

- WebGPU baseline，不默认依赖 64-bit atomic、multi-draw-indirect、mesh/task shader、buffer device address 或 subgroup；
- GPU producer → GPU consumer 闭环；工作数量不回读 CPU 决定 draw；
- one steady main submit；工具、cold load 和 recovery 单列；
- reverse-Z、alpha MASK coverage、double-sided/mirrored、UV0/UV1/UV2、texture transform、normal/ORM/emissive、motion 的现有正确语义；
- hierarchy/SSE 在 Meshlet/triangle 展开前减量；
- previous-HZB 对首帧、resize、camera cut、投影异常 fail-open；
- feature-off 不创建无消费者资源、Pass、readback 或 submit；
- Loader 临时对象不拥有长期 GPU 资源；Runtime package 与 GPU record table 分离。

### 3.2 明确不做

- 不讨论或改造 Surface 之后的光照路径；
- 不以 Forward/Deferred 切换解释本链性能；
- 不添加低模/高模双路径；
- 不用 CPU draw loop、CPU visible list 或 per-material draw 作为 fallback；
- 不恢复每材质 fullscreen Resolve；
- 不把旧 package、旧 RasterWork、旧 Key codec 或旧 Surface 并行保留到阶段结束后；
- 不以“移植了思路”代替上游完整不变量、测试和边界处理。

## 4. 目标资产合同

### 4.1 Scene Normalize

源 glTF 解析完成后先生成设备无关的 `PackedSceneSource`，但 primitive 不再直接等于 Runtime Geometry。Normalize 必须完成：

1. 验证 accessor、index、attribute、material、texture、node transform 和 bounds；
2. 把坐标系、winding、normal/tangent convention、color space 归一到 OEngine 合同；
3. 以 source mesh + primitive + material + transform 建立 provenance，错误可回指 glTF 对象；
4. 分离 static、true-instance、skinned/animated unsupported 类；当前主线仍只接 static/mostly-static；
5. 输出 merge/instance 决策所需的 spatial cell、material compatibility、attribute mask 和 transform 分类。

### 4.2 Static Merge 与 True Instancing

规则按场景语义决定，不按 glTF primitive 数决定：

- 完全共享 canonical geometry 的重复节点保留 true instancing；
- 不再独立运动、材质兼容、位于同一 spatial cell 的 tiny static primitives 合并；
- MASK 与 OPAQUE 不互相合并；BLEND 不进入本文主 Visibility queue；
- double-sided、winding/mirror、UV set requirement、normal/tangent requirement 不兼容时不得合并；
- cell 尺寸由 hierarchy/culling benchmark 选择，禁止把整场合成一个不可裁剪 geometry；
- 合并后保留 source range/provenance，debug view 能从 runtime triangle 回到 glTF primitive。

必须报告：source primitive、canonical geometry、static merge group、true instance、triangles/geometry、meshlets/geometry、材料范围和 bounds inflation。

### 4.3 Geometry Cooker 顺序

固定处理顺序：

```text
classify
→ spatial/material compatible merge
→ vertex/index deduplication
→ vertex-cache optimization
→ overdraw optimization
→ vertex-fetch optimization
→ LOD generation
→ meshlet generation
→ meshlet bounds/cone
→ renderable hierarchy + geometric error
→ package validation
```

tiny geometry 不再为“结构完整”强制生成低占用 Meshlet/BVH：

- 能以一个合法 leaf 表达时输出 fused leaf；
- 当前没有生产 consumer 的 BVH8 section 不再默认生成和驻留；
- 未来接入 BVH8 前必须先证明 parent/descendant cut 互斥语义，并给出同条件收益。

Canonical Geometry 热路径不再运行 `find_stream()`。Cooker 输出固定语义的 `GeometryShadingRecord`，至少包含：

```text
position/index direct range
normal direct range + encoding
tangent direct range + encoding
UV0/UV1/UV2 direct range + encoding
meshlet triangle/vertex direct range
material range / attribute presence mask
bounds / hierarchy root / geometric error
```

允许极少数经过 benchmark 的 canonical encoding class，不允许恢复源格式任意 stride/format 解释器。精确字节布局在第一步由 TS/WGSL 单一 schema 冻结。

### 4.4 Material 与 Texture Cooker

材质产品必须在离线阶段完成：

- glTF Standard PBR 语义归一；
- texture semantic、color space、UV set、transform、sampler 和 fallback 冻结；
- Material 被分类到有界 `MaterialKernelClass`；
- texture 转为 KTX2，并按目标 adapter profile 生成 BC / ETC2 / ASTC 可用 payload；
- mip chain、normal map convention、alpha coverage preservation 和 color-space metadata 在 package validator 中验证。

禁止把 4K 资产统一缩为 256²，也禁止继续用一个固定 4K RGBA8 array 承载所有高分辨率纹理。

### 4.5 RuntimeAssetPackage 与 SceneResidencyManifest

`RuntimeAssetPackage` 继续是唯一 package 名称。Schema 直接升级并包含：

- canonical geometry sections；
- meshlet/hierarchy sections；
- material product sections；
- compressed texture product sections；
- bulk upload chunk directory；
- content hash、source provenance、bounds 和 validator report。

新增 `SceneResidencyManifest` 只描述一次场景事务，不拥有 GPU 资源：

```ts
interface SceneResidencyManifest {
  readonly packages: readonly RuntimeAssetPackageRef[];
  readonly geometryPlacements: readonly GeometryPlacement[];
  readonly materials: readonly MaterialProductRef[];
  readonly textures: readonly TextureProductRef[];
  readonly instances: PackedInstanceSource;
  readonly totals: SceneResidencyTotals;
}
```

Manifest 必须在任何 GPU mutation 前证明所有引用、容量、hash、format profile、最大 queue cut 和显存预算合法。旧 package 不在生产 runtime 转换；repository fixtures 只有在明确标注 historical/oracle 且不进入 Renderer 时可以保留。

## 5. 目标 Residency 合同

### 5.1 Owner 分离

长期 owner 明确分为：

| Owner | 拥有 | 不拥有 |
|---|---|---|
| `GpuAssetStore` | Geometry/Cluster/Meshlet/Canonical stream tables 与 payload | Material/Texture、frame-local work |
| `GpuMaterialStore` | MaterialRecord、MaterialKernelClass、stable material handle | 来源材质对象、texture allocation |
| `TextureResidency` | 压缩 texture bank、stable TextureRef、format/size class、retirement | Material semantics、Loader texture |
| `GpuScene` | Packed Instance table、stable InstanceSet、bulk/patch/previous transform | Geometry payload、frame-local visibility |
| `GpuPackedSceneRegistry` | Scene 与上述 handle/manifest 的关联 | 资源分配器和 frame-local queue |

`GpuMaterialVisibilityTable` 的 material 与 texture 职责在第一步被上述两个 owner 接管后删除，不保留 adapter。

### 5.2 Transactional upload

当前 `Renderer.uploadPackedScene()` 每个 geometry 创建 command、submit 并 `await submitted`，然后另起一次 instance submit。目标事务为：

```text
validate whole manifest
→ reserve all stable handles/ranges/banks
→ plan all buffer growth and texture placement
→ build bounded staging chunks
→ encode old-buffer copy + bulk upload + table publication
→ one command finish / one cold-load submit
→ await completion
→ atomically publish Scene runtime
```

发布顺序必须保证 handle valid/generation 字段最后可见。失败时：

- submit 前：回滚全部 reservation，销毁未提交 staging/replacement；
- submit 后 GPU error/device lost：Scene 不发布，已提交资源进入 completion-safe retire；
- 不允许 805 个 package 成功、第 806 个失败后留下可渲染半场景；
- 不允许 Renderer stable frame 扫描 source package 补状态。

Upload arena 采用有界 chunk，不能假设整个场景能映射进单个 staging buffer。必须报告：transaction 数、command/submit、buffer copy、texture copy、upload calls、source/upload/padding bytes、largest chunk、rollback、retiring bytes。

### 5.3 Compressed texture banks

`TextureResidency` 按以下 key 建 bank：

```text
semantic × color-space × GPU format × size-class × mip policy
```

要求：

- Manifest 先计算精确 layer 需求；不使用固定 `16-layer 4K` 产品容量；
- KTX2 block 可直接上传到兼容压缩 GPU texture，不先创建 RGBA8 source GPUTexture 再 render-copy；
- adapter 不支持首选压缩格式时选择 manifest 内兼容 payload，或在 load 前明确拒绝；
- fallback texture 占固定 slot，invalid TextureRef fail-visible/factor-only；
- eviction/streaming 不进入首个实施 Gate，但 owner/lifetime 不得阻止后续加入；
- resident logical、allocated、bank slack、source staging、retiring 分项统计。

## 6. 目标 GPU Work 与 Visibility 合同

### 6.1 Hierarchy 保留，tiny case 融合

`HierarchicalWorkGenerator` 继续拥有 root/ping-pong/selected/frame-local queue 与 previous-HZB view。保留当前 Frustum + SSE + Cone + previous-HZB 正确性，不在没有证据时重写 P50 0.20 ms 的阶段。

改动只有：

- Scene Normalize 后的 canonical geometry 降低 root/package 数；
- fused leaf 覆盖 tiny geometry，避免空转 hierarchy rounds；
- `SelectedCluster` 输出进入精确 triangle filter，而不是直接展开为每 Meshlet 一个固定 384-vertex record；
- Cone 当前 `rejected=0` 必须用方向、double-sided、mirrored/non-uniform 分类 view 审计；在证明无效前不删除，在证明错误后先修正确性。

### 6.2 RasterWork 直接改为精确 triangle record

`RasterWork` 名称不变，逻辑 ABI 直接改为：

```ts
interface RasterWorkCpu {
  readonly instanceRecordIndex: number;
  readonly geometryRecordIndex: number;
  readonly meshletRecordIndex: number;
  readonly localTriangleIndex: number;
  readonly materialHandle: number;
  readonly rasterFlags: number;
}
```

首个候选布局为 24 B / record；第一步必须用 adapter storage limit 和 workload capacity 冻结最终布局，不得把字段隐式塞进未经验证的 bit range。

Producer 是 `SelectedCluster → exact triangle filter/compact` Compute；Consumer 是 `PackedVisibilityPass` Hardware `drawIndirect`。处理过程必须完整保留所选上游 triangle filtering 实现的：

- index/bounds validation；
- clip/frustum/guard-band conservative classification；
- backface 与 mirrored/double-sided 语义；
- degenerate triangle 处理；
- OPAQUE/MASK 分类；
- all-or-nothing capacity 与 overflow fallback；
- CPU reference / upstream test vectors。

不是只写一个“把 Meshlet for-loop 展开到 triangle array”的简化版本。

### 6.3 Queue family

| Queue | Producer | Consumer | Capacity | Overflow |
|---|---|---|---|---|
| `SelectedCluster` | hierarchy/SSE/cone/HZB | exact triangle filter | manifest `maxSelectedClusterCut` | 保留当前 renderable parent fallback |
| OPAQUE `RasterWork` | exact filter/compact | position-only Hardware Visibility | manifest exact triangle upper bound 与 adapter limit 较小值 | prepare 失败或整组保守 fallback；不截断 |
| MASK `RasterWork` | exact filter/compact | alpha-tested Hardware Visibility | manifest exact MASK triangle upper bound | prepare 失败或整组保守 fallback；不漏绘 |
| `ShadeWorkQueue` | visible-pixel class scatter | specialized Material Resolve | internal pixel count | 一像素一合法 class；越界视为 corruption 并 fail-visible |

每条 queue 都保留 32 B header 或由共享 schema定义的等价 header，并必须提供：`attempted`、`written`、`peak`、`capacity`、`overflow`、`fallback`。Counter 只在采样帧追加 reducer/readback，不影响生产决策。

### 6.4 exact drawIndirect

Opaque/Mask 各自的 indirect args 由 GPU producer 写出：

```text
vertexCount   = writtenTriangleCount × 3
instanceCount = 1
firstVertex   = 0
firstInstance = 0
```

Hardware vertex shader 使用：

```text
rasterWorkSlot = vertex_index / 3
corner         = vertex_index % 3
```

它只读取 position/index 和 Instance transform。OPAQUE fragment 不绑定 material texture；MASK fragment 只读取 cutoff 所需的 base-color alpha、UV 与 sampler。完整 PBR 属性只在 Material Resolve 读取。

WebGPU 没有 multi-draw-indirect，因此 OPAQUE/MASK 是固定两个有语义的 draw 上界，不按材质数增长。某类不存在时 indirect `vertexCount=0`，不增加 CPU draw list；是否仍编码零 draw 由 fixed graph benchmark 决定并记录。

### 6.5 VisibilityKey 直接改为 RasterWork slot

`VisibilityKey` 仍为 `r32uint`，语义直接改为：

```text
0xFFFFFFFF = empty
0xFFFFFFFE = invalid/fail-visible（若 validator 需要）
0 .. maxValid = exact RasterWork slot
```

删除 `localTriangleBits`、`rasterWorkSlotBits`、pack/unpack 与 `RasterWork → VisibleCluster → Meshlet` 回查。新的 lookup 是：

```text
VisibilityKey
→ RasterWork[slot]
→ GeometryShadingRecord / InstanceRecord / MaterialRecord
```

Key capacity 由 `u32 sentinel`、RasterWork buffer byte length、`maxBufferSize` 与 `maxStorageBufferBindingSize` 共同决定。prepare 阶段失败必须发生在分配/编码 producer 之前。Reverse-Z depth contract 保持不变。

## 7. 目标 Material Resolve 合同

### 7.1 MaterialKernelClass 是有界功能类，不是材质数

Cooker 只允许有限且可审查的 Standard PBR class，例如：

```text
BaseFactor
BaseTexture
BaseOrm
BaseOrmNormal
BaseOrmNormalEmissive
Unlit
GenericStandardPbrFallback
```

精确 class 集合由目标资产统计和上游 PBR reference 在第二步冻结。材质实例仍来自 `MaterialRecord`，class 只决定 shader kernel；33、300 或 3,000 个同类材质不会增加 pipeline/draw 数。

`GenericStandardPbrFallback` 必须覆盖 OEngine 声明支持的 Standard PBR 组合并有明确性能 counter，不能成为“任何失败都静默走慢路径”的永久垃圾桶。超出产品材质范围的扩展在 package validate 时明确拒绝或路由到另一个已批准工作包。

### 7.2 Visible-pixel classification

一次 internal-resolution Key scan 只处理非 empty pixel：

```text
count MaterialKernelClass
→ exclusive prefix scan
→ scatter pixel index into one bounded ShadeWorkQueue
→ write per-class indirect args
```

`ShadeWorkQueue` 总 capacity 等于 internal pixel count，不是“每个 class 分配一整屏”。每个 entry 至少包含 `linearPixelIndex`；class range 来自 prefix table。Count/scan/scatter 必须移植成熟并行 scan/compaction 的完整边界测试，不接受单 workgroup、CPU scan、每像素全局 atomic append 或固定每类全屏分区的简化实现。

Feature-off 含义：如果 class specialization 被显式关闭用于单变量诊断，生产仍只能使用同一 Key/Surface contract，诊断开关不进入公开 API，并在第二步结束前删除。

### 7.3 Specialized Resolve execution

为兼容 WebGPU storage texture format 限制，首选实现是一个 RenderPass 内固定上限的 point-list `drawIndirect`：

- 每个 ShadeWork entry 产生一个像素中心 point；
- 每个 MaterialKernelClass 至多一次 indirect draw；
- class pipeline 只绑定它实际需要的 canonical streams/textures；
- fragment 使用 `@builtin(position)` 定位输出像素；
- 多 MRT 继续使用 render attachment，不把不支持 storage write 的格式硬改成 Compute；
- perspective barycentric、解析纹理梯度、normal/tangent frame 和 motion 数学沿用现有已验证实现，按 class 剪除无用分支。

第二步必须把 point rasterization coverage、pixel center、viewport flip、边缘像素、空 class、全屏 class 和多 class 顺序加入 GPU oracle。若目标浏览器 point-list 证据不稳定，允许采用同 ABI 的三顶点 micro-triangle instance consumer，但必须用同条件数据证明，不能另建第二条产品路径。

### 7.4 Direct geometry lookup

Resolve 不再扫描 `VertexStreamDescriptor`。每个 class 通过 `GeometryShadingRecord` 直接定位 canonical offsets，并只解码所需属性：

- BaseFactor 不读 UV/texture/normal/tangent；
- BaseTexture 只读位置重建所需索引和 UV；
- Normal class 才读 normal/tangent/normal texture；
- Emissive class 才读 emissive texture；
- velocity 只有存在真实 consumer 时读取 previous transform 并写 attachment。

三个 triangle vertex 的 index/attribute 仍需读取，这是 visibility-buffer shading 的固有成本；目标是删除动态 stream search、无关格式分支、无关 texture sample 和无消费者 MRT，而不是伪称可以不重建几何。

## 8. 目标 Surface 合同

`SurfaceFrame` 名称不变，并继续是 immutable frame product。本文只定义 Resolve 输出，Surface 之后的消费者迁移属于命中模块自己的任务。

核心输出必须始终存在：

- base color + material AO；
- shading normal + geometric normal 或经过 A/B 证明的等价紧凑编码；
- metallic + perceptual roughness；
- depth 继续由 Visibility owner 提供。

条件输出只有在 graph 有真实消费者时创建：

- emissive；
- velocity + reactive；
- material identity / debug metadata。

`GpuSurfaceAbi` 的格式不在本文凭经验拍定。第二步必须比较至少：

1. 当前 26 B/pixel；
2. core attachments 合并/紧凑编码；
3. optional attachment 按 consumer topology 创建。

比较同时验证数值误差、normal angular error、roughness/metallic precision、HDR emissive range、velocity subpixel error、总 attachment bytes、Resolve GPU ms 和后续最近 consumer 是否需要额外 unpack。不得以 Surface 写带宽下降换取不可解释的画质回退。

## 9. 开源采用与禁止简化

第一步开始时在 `docs/references/porting/` 建立逐项 ledger。候选方向如下，最终采用状态以固定 commit/tag、许可证和源码审计为准：

| 能力 | 优先候选 | 期望采用状态 | 必须保留 |
|---|---|---|---|
| glTF validate/normalize | Khronos glTF Validator、glTF-Transform | 直接依赖或可追溯工具集成 | accessor/material/extension/transform validation 与 fixtures |
| cache/overdraw/fetch、meshlet、simplify | meshoptimizer / gltfpack | 直接依赖 | upstream algorithms、error/bounds、tests、license notice |
| KTX2/Basis texture product | Khronos KTX-Software、Basis Universal | 直接依赖 | mip/color-space/alpha/normal/transcode tests |
| exact triangle filtering/compaction | The Forge Visibility Buffer triangle filtering 与其它经过生产验证的候选 | 可追溯局部移植 | full classification、scan/compact、overflow、test scenes |
| visibility/material reconstruction | The Forge TVB、Filament、glTF Sample Viewer | 局部移植语义与测试 | barycentric/gradient/PBR/texture transform/numeric edge cases |
| scan/prefix/scatter | 经过目标 WebGPU 能力审计的成熟 GPU scan 实现 | 直接依赖或局部移植 | arbitrary length、multi-workgroup、zero/full/overflow tests |
| residency/lifetime | AnKi、O3DE、Bevy/Cesium 可验证 owner 设计 | 移植不变量，WebGPU owner 独立实现 | transaction、generation handle、retire/device-lost |

每个 ledger 必填：repository URL、commit/tag、source path、test/example path、license/notice、采用代码范围、未采用范围、输入输出 ABI、保留不变量、OEngine/WebGPU 差异、fallback、性能假设和本地 regression。

以下情况一律不算完成：

- 只看 README 或博客后自行写一个同名算法；
- 只复制 happy path shader，删掉上游 culling/overflow/numeric handling；
- 把 Vulkan 的 MDI、BDA、subgroup 或 64-bit atomic 假设藏进 WebGPU 代码；
- 为“先跑起来”保留长期 CPU readback/loop；
- 没有上游测试向量、许可证和同条件 benchmark 就宣称已移植。

## 10. 两步实施

### 第一步 · 资产到 VisibilityKey 直接迁移

一次完成以下范围：

```text
Packed glTF
→ Scene Normalize / Static Merge / True Instancing
→ Geometry + Material + Texture Cooker
→ RuntimeAssetPackage + SceneResidencyManifest
→ Transactional GpuAssetStore / GpuMaterialStore / TextureResidency
→ Packed Instance Tables
→ Hierarchy/SSE/Cone/Previous-HZB
→ SelectedCluster
→ exact triangle filter/compact
→ RasterWork
→ exact drawIndirect
→ VisibilityKey + Reverse-Z
```

开始时同步完成 before evidence、ADR-0010 替代决策、上游 commit/license/source/test ledger、所有 queue ABI/capacity/overflow 冻结，不再拆成独立阶段。

主要改动入口：

- `OEngine/src/loaders/load_gltf.ts`；
- `OEngine/src/geometry/GeometryCooker.ts`；
- `OEngine/src/assets/RuntimeAssetPackage.ts`、`GeometryAssetPackage.ts`；
- `OEngine/src/gpu/GpuAssetStore.ts`、`GpuScene.ts`、`GpuPackedSceneRegistry.ts`；
- `OEngine/src/gpu/GpuWorkGenerationAbi.ts`、`GpuVisibilityKeyAbi.ts`；
- `OEngine/src/render/HierarchicalWorkGenerator.ts`、`PackedVisibilityPass.ts`；
- 对应 WGSL、debug、counter、oracle、fixtures 和示例调用方。

本步内直接删除：per-primitive production package builder、逐 geometry command/await、固定 4K RGBA8 texture owner、12 B Meshlet RasterWork、固定 384-vertex submit、Key localTriangle bit packing、旧 debug lookup 和所有只服务这些 ABI 的 adapter。不得推送一个同时保留旧/新 runtime 路径的中间状态。

本步退出条件：Dungeon source primitive 不再等于 package 数；场景以单一事务驻留；4K 压缩纹理保真；GPU 生成并消费精确 OPAQUE/MASK triangle work；Key 直接定位 RasterWork slot；package、rollback、alpha、mirrored/double-sided、overflow、lifecycle 和 WebGPU diagnostics 全部通过。

### 第二步 · Material Resolve 到 Surface 重构与整体收口

一次完成以下范围：

```text
VisibilityKey
→ visible-pixel MaterialKernel classification
→ count / prefix scan / scatter
→ bounded ShadeWorkQueue + indirect args
→ specialized canonical Material Resolve
→ compact/conditional Surface
→ examples/debug/counters migration
→ old chain deletion
→ paired performance and memory Gate
```

主要改动入口：

- `OEngine/src/render/passes/PackedMaterialResolvePass.ts`；
- `OEngine/src/shaders/packed_material_resolve.ts`；
- `OEngine/src/gpu/GpuSurfaceAbi.ts`；
- `Renderer.ts` 的 Surface resource declaration；
- Surface 直接消费者、debug/counter、Rendering Lab pipeline mode 和 benchmark harness。

本步内直接删除：generic `find_stream` 热循环、无界材质 feature branch、旧 fullscreen Resolve、固定无消费者 MRT、旧 Surface attachment、永久诊断 flag、旧 fixtures/generated shader/oracle，以及第一步迁移后仍残留的旧生产调用点。不得用 wrapper 保留旧 shader。

本步退出条件：每个非 empty pixel 恰好进入一个有界 class；材质数量不增加全屏扫描；Standard PBR/UV0-2/texture transform/normal/ORM/emissive/velocity oracle 对齐；Surface 按真实 consumer 创建 attachment；resize、render scale、camera cut、replace/release、patch、fallback、device lost、empty/Dungeon/dense 场景通过；`rg` 无旧生产链；clean/full paired artifact 达到预算，或以新 ADR 明确拒绝当前架构而不恢复双路径。

## 11. Gate 与收益预算

### 11.1 固定场景

同一 commit、GPU、浏览器、driver、窗口、DPR、warm-up、采样 cadence 下至少包含：

| Case | 作用 |
|---|---|
| Dungeon 原始 source | 低中几何固定成本、材质/纹理、alpha、merge 证据 |
| Dungeon 禁止 static merge | 单变量证明 merge 收益，不是第二条产品路径 |
| Dungeon 生产 cooked | 产品默认结果 |
| Dense target scene | 高几何 hierarchy/filter/queue/indirect 吞吐 |
| Alpha/UV fixture | MASK、UV0/1/2、transform、共享 UV、4K 画质 |
| Residency pressure | bank capacity、rollback、retire、device lost |

“禁止 static merge”只允许 benchmark tool 生成对照 package，Renderer 仍只消费同一种 package/runtime ABI。

### 11.2 初始局部预算

以下是该机器与 `1921×913` workload 的实施停止线，必须在第一步开始时写入可机读目标并在正式 artifact 中校准：

| 指标 | 当前 P50 | 初始目标 P50 |
|---|---:|---:|
| Hierarchy + exact filter/compact | 0.20 ms（不含 exact filter） | ≤ 1.00 ms |
| Hardware Visibility | 3.34 ms | ≤ 2.00 ms |
| classification + Material Resolve + Surface | 15.66 ms | ≤ 5.00 ms |
| Work Generation → Surface | 19.20 ms | ≤ 8.00 ms |
| allocated scene memory | 约 1.4 GiB | ≤ 450 MiB |

这些目标是决定本架构是否值得保留的 Gate，不是已经达到的结论。若完整正确实现无法满足：

1. 先用 timestamp/counter/bandwidth/occupancy 定位；
2. 只做单变量修正；
3. 仍不满足则新增 ADR 拒绝当前 Visibility architecture；
4. 不以“更高面数会更快”或“WebGPU 本来就慢”绕过 Gate。

### 11.3 必报指标

- Asset：source primitive、canonical geometry、package、merge group、true instance、triangles/geometry、meshlets/geometry；
- Upload：transaction、submit、upload call、copy、source/upload/padding/staging bytes、cold time；
- Residency：logical、allocated、bank slack、fragmentation、retiring、compressed ratio；
- Hierarchy：candidate/visited/selected、frustum/cone/HZB reject、rounds、fallback；
- RasterWork：attempted/written/peak/capacity/overflow、opaque/mask、exact triangles、degenerate/backface/frustum reject；
- Visibility：submitted vertices/triangles、shaded/empty/invalid pixels、key/depth mismatch；
- Material：class pixel count、scan/scatter time、per-class resolve time、texture samples、generic fallback pixels；
- Surface：attachments、bytes/pixel、write bytes、optional resource presence；
- CPU/GPU：RAF、Renderer CPU、GPU pass sum、每段 P50/P95/P99、render/compute pass、draw/dispatch、submit；
- Diagnostics：validation、uncaptured、device-lost、counter drop。

## 12. 迁移与提交纪律

两个实施步骤都必须形成可审核的垂直结果，不得把旧/新路径同时留到下一步：

1. 先更新 schema/reference tests；
2. 同一分支迁移 producer；
3. 同一分支迁移所有 consumers/debug/counters/examples；
4. 同一工作包删除旧 ABI 和 adapter；
5. build/test/example/paired artifact 通过后提交。

允许在一个未提交工作树内短暂同时存在旧/新代码以完成编译迁移，但不增加 runtime switch，不进入公开 API，不作为中间提交推送。大型外部移植按 upstream commit 边界拆提交，并在 commit message 链接 ledger。

提交序列只保留两个主提交组；组内可以按上游许可证或机械迁移拆 commit，但不能形成可运行双路：

```text
Step 1: asset/cooker/package/residency + exact RasterWork/VisibilityKey + old upstream deletion
Step 2: pixel classification/material resolve/Surface + full deletion + paired evidence/document closure
```

## 13. 验证命令与未完成声明

每个代码工作包至少运行：

```powershell
cd OEngine
npm ci
npm run build
```

并运行命中的 unit/schema/GPU tests、一个 production browser example 和 `docs/PERFORMANCE.md` 固定 benchmark。Browser 证据由用户或执行者按当次明确约束采集；如果用户明确要求不启动浏览器，最终说明必须列出未运行项和原因，不能以 typecheck 代替。

本文落地只表示实施设计已建立。两个步骤在代码、删除、正确性、性能和 artifact 全部完成前均不得写成 Completed。
