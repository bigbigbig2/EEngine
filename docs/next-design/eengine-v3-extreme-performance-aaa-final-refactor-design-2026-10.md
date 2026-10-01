# EEngine 第三版：极致 GPU 性能与 AAA 画质最终重构设计

日期：2026-10-01  
设计基线：master / e7296be9cebbc3bcc1b6b738d682c928548d72d5（历史切断基线）
当前源码核对：master / 11d906ab（2026-10-02）
目标：基于当前第三版真实源码，完成一次破坏式 Surface 重构，解决 2026-09-25 报告中可见像素级几何、材质、直接光照和 IBL 的增长瓶颈，同时保留现代 AAA 的 PBR、normal、ORM、specular、clearcoat、IBL、VSM、AO、temporal 和 FSR3 质量。

本文不把设计文档中“计划实现”的内容当成已经完成，而是把当前代码、当前缺口和最终推进方案分开说明。

实现核对（2026-10-02）：当前生产代码已切换到 `SurfaceWorkRuntime` 唯一路径，FrameGraph 顺序为 cache lookup → GeometryRecord（当前仍按 record range 求值）→ hit-mask-gated miss field evaluation → diffuse/specular/coat/IBL packets → packet reconstruct。该接线不提升本文后续 AAA 数学、完整材质 publication kernel、cluster/VSM/AO/IBL provider、signal history 和性能验收状态；这些仍以源码和 Phase 7 证据为准。

## 1. 最终判断

当前第三版是最终性能上限最高的方向，但当前提交还没有兑现这个上限。

截至历史切断基线，代码已经具备以下 GPU-first 底座；Surface owner 的当前状态以本文件的实现核对和执行计划为准：

- 旧 Renderer 和旧 Surface 生产链已经切断；
- GPU Scene、Meshlet hierarchy、VisibilityKey、HZB 和间接 raster 保留；
- 普通场景和 Product 场景统一进入 GpuRenderWorld；
- 材质图可以编译成 Appearance program；
- TextureResidency、GpuMaterialStore、AppearanceStaticResidency 和 AppearanceProgramRegistry 已经有独立 owner；
- FrameGeometryArena、FrameGeometryVertices 和 WinnerPrimitiveInterpolation 已经建立共享几何资源合同；
- 历史基线曾由 AppearanceCachePass 和 SparseLightingPass 承载 Surface 工作；这两个 owner 已从当前生产 import graph 中移除，不能再视为当前入口；
- Direct light、IBL、AO、VSM、Temporal、FSR3、Bloom 和 Present 已经进入同一条 production submit。

当前实现仍有三个决定性瓶颈：

1. classify 尚未实现 implicit/uniform/mixed 的完整覆盖和真实 work compaction；
2. miss evaluator 和 cache key 尚未接入完整 publication 程序及 sampler/UV/footprint/variation 语义；
3. lighting provider、signal history 和 Product/形变几何对应仍不完整，无法形成最终 AAA 的可复用 packet 成本。

历史基线的实际成本接近：

~~~text
O(P) Appearance demand
+ O(P) Appearance geometry inputs
+ O(P) 材质程序求值
+ O(P) SparseLighting prepare_surface
+ O(P) lighting classify
+ O(L) lighting packet evaluate
+ O(P) reconstruct
~~~

P 是有效可见像素数量，L 是被压缩后的照明 packet 数量。

最终版必须变成：

~~~text
O(P) Visibility / depth / motion / identity facts
+ O(G) 一次共享几何记录
+ O(M_miss) 材质缓存缺失项
+ O(D_s + I_s + C_s) 分信号稀疏光照
+ O(P) 廉价重建与输出
~~~

G 是真正需要几何恢复的 Surface work 数量，M_miss 是材质 cache miss 数量，D_s、I_s、C_s 分别是 diffuse、specular/IBL、coat 的 signal work 数量。

## 2. 当前源码链路分析

### 2.1 RendererCore、FrameCoordinator 和 FrameGraph

RendererCore 当前由 FrameCoordinator 拥有唯一 command context 和唯一 submit。FrameCoordinator 最多允许两个 in-flight frame，通过 GPU completion 做背压，不通过 CPU readback 控制 GPU work。这个边界应该保留。

当前 prepare job 使用 executionMode = none，因此旧 ShadingBinId 路径不是默认 production 路径。历史基线主链由 FrameProgram 和 FrameProgramLowering 建立；当前 Surface 接线见 2.7：

~~~text
GPU Scene / Meshlet hierarchy
→ Packed Visibility
→ HZB / VisibilityKey / Depth / MeshletWork
→ Appearance cache / fields
→ Temporal facts
→ Sparse lighting
→ Physical sky / Aerial
→ FSR3 / Radiometry / Bloom / Present
~~~

FrameGraph、资源 owner、唯一 submit 和 Graph cache 是正确的系统级底座，不应为了 Surface 重构而推翻。

### 2.2 PackedVisibilityPass

PackedVisibilityPass 当前负责 GPU hierarchy traversal、普通或 Product MeshletWork、HZB、current-HZB late recheck、FrameInstanceTransforms、FrameGeometryVertices、FrameGeometryArena、MeshletBucketRaster、VisibilityKey、Depth 和 indirect raster。

这部分的成本主要随着节点、cluster、meshlet 和 raster triangle 数增长，不是 9 月 25 日近景 Surface 从约 0.46 ms 增到约 6.1 ms 的主因。

VisibilityKey 是 frame-local winner identity，适合当前帧访问 meshlet 和 primitive，不能直接当作跨帧 cache key。最终设计必须把以下三种身份分开：

- Winner identity：当前帧哪个实例、meshlet、primitive 赢得像素；
- Sharing identity：哪些 Surface 可以共享某个 signal；
- Cache identity：材质 field 与当前输入 footprint 是否仍然相同。

### 2.3 历史基线：AppearanceCachePass 和 GpuAppearancePublication

> 以下段落描述设计基线 `e7296be9` 的旧实现，用来解释本次重构的动机；它不是当前生产事实。当前生产 owner 是 `SurfaceWorkRuntime`，见 2.7 和执行计划。

在该历史基线中，AppearanceCachePass 是一个外层 FrameGraph pass，在回调内部调用 WinnerPrimitiveInterpolation.encode 和 GpuAppearancePublication.encodeDemand，然后创建 full internal 的 Appearance fields。这使 FrameGraph 暂时看不到内部真实的 demand、scatter、geometry、program 和 resolve 边界。

GpuAppearancePublication.encodeDemand 的实际流程是：

~~~text
按 width × height 分 rowsPerStripe
→ 8×8 Appearance GPU demand
→ 每个有效 VisibilityKey 生成 pixel task
→ demand finalize
→ task scatter
→ Appearance real geometry inputs
→ 每个 program 执行 evaluate 或 cache stages
→ 8×8 field publication resolve
~~~

当前源码的关键事实：

- demand shader 使用 8×8 workgroup；
- framePixels 仍然是近似全屏的 pixel-to-task 映射；
- frameTasks、frameInputs、frameOutputs、frameMetadata 以 maxFrameTasks 创建；
- 为避免任务池截断，按静态 extent 分 stripe；
- geometry inputs 在 cache evaluate 之前；
- 有 cache hit 也要先支付 demand、task 和 geometry input；
- 每个 program/stripe 仍可能创建 bind group 和 sampler；
- field resolve 仍然覆盖内部全分辨率。

所以当前 Appearance cache 只是把一部分昂贵字段缓存起来，还没有把命中的 Surface 从前面的 heavy work 中排除。

### 2.4 历史基线：SparseLightingPass

> 以下段落描述设计基线 `e7296be9` 的旧实现，用来解释重复几何恢复和全率工作的来源；当前生产链已删除该 owner。

在该历史基线中，SparseLightingPass 有六个阶段：

~~~text
prepare_surface
reset_packets
classify
finalize_packets
evaluate_packets
reconstruct
~~~

调度为：

- prepare_surface：8×8 全分辨率；
- classify：16×16 tile；
- reset_packets：单 workgroup；
- finalize_packets：单 workgroup；
- evaluate_packets：indirect packet dispatch；
- reconstruct：8×8 全分辨率。

surface_sparse_lighting shader 的 prepare_surface 仍会读取 VisibilityKey、解码 MeshletWork、读取 geometry arena、调用 winner interpolation、恢复 position、normal、tangent、UV、view facts，并读取 Appearance fields。

这说明 WinnerPrimitiveInterpolation 虽然已经是共享 owner，但还没有被收敛成唯一的 SurfaceGeometryRecord producer。Appearance geometry inputs 和 SparseLighting prepare_surface 仍各自掌握一部分几何恢复逻辑。

classify 会检查 temporal history、identity、geometry signature、normal、surface plane、view direction、material fields、AO、light cluster、VSM 和 environment revision，再决定 diffuse、specular、coat 的 packet 和 history reference。

这个分类算法可以保留，但必须建立在统一 GeometryRecord 上，并且 reconstruct 只能做 signal 合成，不能重新执行完整 Surface PBR。

### 2.5 Material、AppearanceGraph 和资源 owner

AppearanceGraphCompiler 已经有比较好的执行元数据基础：

- Surface、Texture、Geometry、Dynamic、View、Nonlocal、Material dependency；
- constant、source-product、per-target 和 dynamic-cache-product；
- product root 和 field identity；
- 静态材质产品和运行时输入。

GpuRenderWorld 也已经把 TextureResidency、GpuMaterialStore、material association、Appearance publication、static residency 和 staged runtime commit 放在一个生命周期中。

最终方案不建立第二套材质系统，而是扩展现有 compiler 输出：

- constant；
- static product；
- stable local cache；
- geometry dependent；
- view dependent；
- signal rate；
- full-rate requirement；
- texture variation requirement；
- 是否可以与 lighting 融合。

### 2.6 示例当前实际配置

next-renderer-showcase 当前默认开启 renderScale 1、HZB、cone、XeGTAO、FSR3、Bloom 和 physical environment，VSM 关闭，temporal jitter 关闭。它已经读取 surfaceMaterialSamples 和 surfaceLightingSamples，但最终验收不能只看这两个数，还要同时观察 geometry records、material hit/miss、IBL evaluations、full-rate exceptions、packet 数和 dispatch 数。

## 3. 中间版和当前第三版的关系

### 3.1 9 月 25 日到 27 日的旧主链优化

代表提交：

- [1e4c3fec：GPU 分类和紧凑 ShadingWork](https://github.com/bigbigbig2/EEngine/commit/1e4c3fec)
- [4c8e0e0e：Product 顶点属性材质重建](https://github.com/bigbigbig2/EEngine/commit/4c8e0e0e)
- [ce42115a：2×2 / 4×4 频率计划](https://github.com/bigbigbig2/EEngine/commit/ce42115a)
- [ff9b7443：低频材质常量证明](https://github.com/bigbigbig2/EEngine/commit/ff9b7443)
- [67dd145e：lit 和 normal 仍 full-rate](https://github.com/bigbigbig2/EEngine/commit/67dd145e)

这些提交提高了正确性和接线完整度，但没有真正移除普通 PBR 的逐像素重工作量。它们解释了为什么在原主链上继续优化后，性能没有出现对应幅度的提升。

### 3.2 9 月 30 日 Signal-Rate 中间版

代表提交：

- [15497ffe：Signal-Rate Surface 设计](https://github.com/bigbigbig2/EEngine/commit/15497ffe)
- [c48b7df3：阶段一](https://github.com/bigbigbig2/EEngine/commit/c48b7df3)
- [52d2bffc：阶段二样本驱动和 tile 回退](https://github.com/bigbigbig2/EEngine/commit/52d2bffc)
- [a3a86101：阶段三分信号采样](https://github.com/bigbigbig2/EEngine/commit/a3a86101)
- [15f12f7b：阶段四清理](https://github.com/bigbigbig2/EEngine/commit/15f12f7b)

这个版本已经实现 tile/sample compaction，成本模型大致为：

~~~text
全屏 Probe / Builder / Resolve
+ 压缩后的重 PBR sample
+ mixed/fallback/full-rate
+ atomic、compact、indirect 和重建
~~~

它是当前第三版的算法前身，但不是最终生产架构。当前第三版已经删除 SurfaceProbe、SurfaceSampleAbi、SurfaceSignalPlan、surface_sample_work、surface_sample_worker 和旧 SurfaceMaterialPass，说明仓库已经主动放弃了中间版的执行模型。

### 3.3 当前第三版

代表提交：

- [182fd51e：缓存 Surface 最终目标](https://github.com/bigbigbig2/EEngine/commit/182fd51e)
- [69e018d8：切断旧生产链](https://github.com/bigbigbig2/EEngine/commit/69e018d8)
- [e241771a：Appearance demand 和字段发布](https://github.com/bigbigbig2/EEngine/commit/e241771a)
- [7b8d9f95：SparseLighting 和 HDR 主链](https://github.com/bigbigbig2/EEngine/commit/7b8d9f95)
- [a0b3a9a6：真实完整可见任务供给](https://github.com/bigbigbig2/EEngine/commit/a0b3a9a6)
- [e7296be9：真实属性、缓存信号和编译覆盖](https://github.com/bigbigbig2/EEngine/commit/e7296be9cebbc3bcc1b6b738d682c928548d72d5)

最终性能上限上，第三版高于中间版，因为它可以把静态材质、稳定字段和可复用输入移出每帧重计算。

当前源码已经进一步切换到 `SurfaceWorkRuntime` 唯一路径：`SurfaceWorkRuntime.ts` 注册 classify、cache lookup、`SurfaceGeometryPass`、miss evaluation、lighting packets 和 `SurfaceReconstructionPass`；`FrameProgramLowering.ts` 没有旧 Surface owner 的生产接线。当前实现仍未完成 implicit/uniform/mixed 覆盖、完整 publication kernel、完整 sampler/UV/footprint key、cluster/VSM/AO/IBL provider 和 signal history，因此不能把结构接线等同于最终性能或 AAA 验收。

当前源码仍有可量化的未完成成本：classify 主要为 8×8 tile 写代表 sample，GeometryRecord 尚未覆盖完整 Product/skin/morph/previous deformation 对应，lighting 仍是基础本地 BRDF，reconstruct 只实现 mask/pre-exposure 的简化合成。下一阶段必须在唯一主链内补齐这些算法，不恢复旧 owner 或兼容桥。

### 2.7 当前生产接线（2026-10-02）

源码入口为 `FrameProgramLowering → SurfaceWorkRuntime.addToGraph`，实际资源顺序为：

~~~text
Visibility / TemporalFacts
→ SurfaceWork classify
→ cache lookup
→ GeometryRecord（当前仍按 record range）
→ hit-mask-gated miss field evaluation
→ diffuse/specular/coat/IBL packets
→ packet reconstruct
→ Sky / Aerial / FSR3 / Radiometry / Bloom / Present
~~~

这是当前唯一生产结构，不代表最终算法已完成。设计中的 implicit/uniform/mixed 覆盖、完整材质 publication、真实 light/cluster/VSM/AO/IBL provider、history reject/age、Product/形变对应和正式性能/画质验收仍是未完成项。

## 4. 最终架构：SurfaceWork Runtime

### 4.1 总体数据流

~~~mermaid
flowchart TD
  A[Geometry Product / Material Publication] --> B[VisibilityKey + Depth]
  B --> C[Pixel Facts + Surface Address]
  C --> D[One Geometry Resolve]
  D --> E[Appearance Cache Lookup]
  E --> F[Material Miss Compaction]
  F --> G[Signal Lighting Packets]
  G --> H[Temporal Reuse]
  H --> I[Cheap Full Resolution Reconstruct]
  I --> J[HDR / Sky / FSR3 / Bloom / Present]
~~~

完整逻辑链：

~~~text
VisibilityKey / Depth / MeshletWork
→ PixelFacts：motion、identity、validity、coverage、reactive
→ SurfaceAddress：material slot、product、primitive、sharing domain
→ SurfaceWorkBuilder
    ├─ implicit tile：不写逐像素 task
    ├─ uniform tile：写一个 tile descriptor
    └─ mixed tile：写有限 sample、mask 和 exception
→ SurfaceGeometryPass
→ SurfaceGeometryRecord
→ Appearance cache hit / miss
→ diffuse / specular / coat / IBL packets
→ temporal history
→ full-resolution cheap resolve
~~~

### 4.2 新的 SurfaceWork ABI

新增 GpuSurfaceWorkAbi.ts，使用固定前缀和分区，不创建一个包含全部材质和全部光照字段的巨型结构。

~~~text
SurfaceWorkHeader
  frame generation
  extent
  tile count
  work count
  material miss count
  geometry record count
  per-signal packet counts
  overflow flags

SurfaceTileDescriptor
  tile origin
  tile size
  profile id
  material rate
  diffuse rate
  specular rate
  coat rate
  mask offset
  sample offset
  geometry record offset

SurfaceSampleRecord
  representative pixel
  winner identity
  sharing identity
  signal mask
  cache field mask
  output mapping

SurfaceExceptionRecord
  pixel or 2×2 cell mask
  reason
  signal group
  full-rate material flag
  full-rate lighting flag

SurfaceCounterBlock
  visible pixels
  implicit / uniform / mixed tiles
  geometry records
  material hits / misses
  diffuse / specular / coat / IBL samples
  full-rate exceptions
  history hits / rejects
  overflow and bytes
~~~

必须满足：

- 纯 full-rate tile 不创建 64 条逐像素 task；
- 纯 uniform tile 不创建完整 pixel-to-sample 映射；
- mixed tile 只写真正需要的 mask 和 sample；
- 不用一个全局 queue 承担所有材质、所有频率和所有 lobe；
- 不通过 CPU readback 决定本帧 dispatch；
- 不依赖固定 subgroup width、bindless 或未协商 feature；
- 所有 capacity 在资源创建前根据 WebGPU limits 协商。

### 4.3 一次几何准备

新增 SurfaceGeometryPass.ts，作为唯一 SurfaceGeometryRecord producer。

输入：

- VisibilityKey；
- MeshletWork；
- FrameGeometryArena；
- FrameGeometryVertices；
- Product metadata 和 resident banks；
- WinnerPrimitiveInterpolation 的 dictionary、coefficients 和 control；
- SurfaceWork sample records。

输出：

~~~text
SurfaceGeometryRecord
  position
  geometric normal
  shading normal basis
  tangent / bitangent sign
  UV0..UVn
  texture derivatives
  view direction
  depth / plane facts
  winner identity
  sharing identity
  geometry signature
~~~

Appearance 和 SparseLighting 都只读取 GeometryRecord，不得再次从 VisibilityKey 找 meshlet、解码三顶点、计算 perspective barycentric、恢复 normal/tangent/UV 或重新判断 primitive identity。

WinnerPrimitiveInterpolation 可以继续保留为底层数学和 arena producer，但结果必须收敛为 GeometryRecord。最终删除 AppearanceGeometryInputs 和 SparseLighting prepare_surface 中的重复几何恢复。

### 4.4 Appearance cache 需要前移

当前 cache stages 位于 task 和 geometry inputs 之后，最终必须变成：

~~~text
SurfaceWork sample
→ 生成 cache key
→ lookup stable field address
  ├─ hit：只写 field address / consume reference
  └─ miss：compact 到 MaterialMissQueue
→ miss 读取 GeometryRecord
→ Appearance evaluate
→ publish cache cell
→ consume fields
~~~

缓存 key 至少包含：

- material slot；
- field identity/version；
- texture residency generation；
- sampler、wrap、filter；
- UV set 和 transform；
- geometry/product domain；
- 过滤 footprint；
- dynamic parameter version；
- 必要时的 variation revision。

Hash 只能做索引，不能证明身份。GPU 必须完整比较 key，避免错误复用。

缓存分三类：

1. constant 和 static product；
2. stable local field cache；
3. dynamic/view/nonlocal signal。

第三类不能为了“缓存率”被强行放入长期材质 cache，而应进入本帧 signal work 或 temporal history。

### 4.5 PBR 分信号执行

最终版不采用“所有 PBR 都粗率”或“normal/ORM 一出现就全材质 full-rate”。

| Signal | 默认执行 | Full-rate 条件 |
|---|---|---|
| Base Color | cache / quad | 高频颜色、接缝、alpha 或 footprint 不可证明 |
| Roughness | cache / quad | 高频变化或镜面能量变化超过预算 |
| AO / ORM | cache / quad | AO 边界、快速变化或高频遮蔽 |
| Geometric Normal | GeometryRecord | 轮廓、折角、退化、镜像和不连续 |
| Normal Map | 2×2 / 1×1 | 高频法线、强镜面、切线接缝 |
| Diffuse light | tile / packet | light、shadow 或 AO boundary |
| Specular / IBL | packet / temporal | view-dependent 高光或低 roughness |
| Clearcoat | 独立 signal | coat normal 或 coat roughness 高频 |
| Emissive | cache / quad | 动态或视向相关 emissive |

Normal full-rate 不代表 BaseColor、Diffuse、AO 和全部 IBL 必须 full-rate。Specular full-rate 也不代表 Diffuse 必须 full-rate。每个 signal 单独记录 rate 和 exception。

### 4.6 Lighting packets

历史 SparseLighting 的逻辑职责改由 `SurfaceLightingWorkPass` 和后续 packet/reconstruct owner 承担：

~~~text
DiffuseLightingWork
SpecularLightingWork
CoatLightingWork
~~~

packet 包含 geometry record、signal mask、cluster/light identity、shadow revision、environment revision、material field address 和 history reference。

Direct light 只在 tile、cluster、normal risk、shadow revision 兼容时共享；不跨 cluster 借用 light list。light boundary 和 shadow boundary 自动 full-rate。

IBL 必须重点重构：

- DFG 只对需要的 specular packet 求值；
- diffuse irradiance 按 tile 或 normal group 复用；
- prefiltered environment 按 roughness bucket 和 reflection direction 组织；
- base、specular、coat 不重复读取同一环境信息；
- environment generation 改变时只使相关 signal/history 失效；
- 不把完整 IBL 继续放在每个可见像素的 PBR kernel 中。

AO 保持独立 producer，作为 scalar lighting signal 输入；AO 变化只拒绝相关 signal，不清空所有材质缓存。

### 4.7 Temporal 和 reconstruct

TemporalFactsPass 是唯一 motion、identity、validity 和 reactive 基础 owner。Surface 不再发布第二套 motion。

rigid opaque 的 motion 由 depth、current world position、previous camera 和 jitter 统一计算。history 有效必须同时满足：

- winner/sharing identity 相同；
- material field version 相同；
- geometry signature 相同；
- texture residency generation 相同；
- environment/light/VSM revision 相同；
- depth、plane、normal、view 误差在预算内；
- 当前 signal 没有 reactive；
- history age 未过期。

reconstruct 只允许：

- 读取 packet result 或 history result；
- 根据 sample mask 选择；
- 合成 diffuse/specular/coat/emissive；
- 应用 AO、energy 和 pre-exposure；
- 写 HDR 和 reactive mask。

它不能重新执行完整 Appearance graph、Geometry Product 解码或全量 BRDF。

## 5. 源码修改清单

### 5.1 保留

保留：

- RendererCore.ts；
- FrameCoordinator.ts；
- FrameGraph.ts；
- FrameProgram.ts；
- FrameProgramLowering.ts；
- PackedVisibilityPass.ts；
- GpuRenderWorld.ts；
- GraphicsContext.ts；
- TextureResidency；
- GpuMaterialStore；
- AppearanceProgramRegistry；
- AppearanceStaticResidency；
- FrameGeometryArena.ts；
- FrameGeometryVertices.ts；
- VirtualGeometryResidency.ts；
- PhysicalSky、AerialPerspective、TemporalFacts、FSR3、Radiometry、Bloom、Present。

保留 owner、资源生命周期和 FrameGraph，不等于保留当前所有 Surface consumer。

### 5.2 删除

完成新链后删除：

- SurfaceMaterialPass.ts；
- SurfaceProbe.ts；
- SurfaceProbePass.ts；
- SurfaceSampleAbi.ts；
- SurfaceSignalPlan.ts；
- surface_sample_work.ts；
- surface_sample_worker.ts；
- 旧 surface_execution.ts；
- 旧 generic full-screen closure producer；
- Appearance 和 SparseLighting 各自独立的几何恢复路径；
- 只服务旧 sample queue 的 fixture、ABI 和 counters。

不保留 old/new 双轨、旧开关、兼容 adapter 或 fallback renderer。不可用数据只进入最终 bounded full-rate exception。

### 5.3 新增

建议新增：

~~~text
OEngine/src/render/surface/SurfaceWorkRuntime.ts
OEngine/src/render/surface/SurfaceGeometryPass.ts
OEngine/src/render/surface/SurfaceMaterialCachePass.ts
OEngine/src/render/surface/SurfaceLightingWorkPass.ts
OEngine/src/render/surface/SurfaceReconstructionPass.ts
OEngine/src/render/surface/GpuSurfaceWorkAbi.ts
OEngine/src/render/surface/SurfaceHistoryAbi.ts

OEngine/src/shaders/surface_work_classify.ts
OEngine/src/shaders/surface_work_compact.ts
OEngine/src/shaders/surface_geometry_resolve.ts
OEngine/src/shaders/surface_material_cache.ts
OEngine/src/shaders/surface_lighting_packets.ts
OEngine/src/shaders/surface_reconstruct.ts
~~~

### 5.4 FrameGraph 接线

`SurfaceWorkRuntime` 已作为唯一 Surface owner 注册到 FrameGraph；最终完成仍必须保持以下可见边界：

- Visibility、Depth、MeshletWork 读取；
- SurfaceWork transient buffers；
- GeometryRecord；
- material cache request/publish；
- lighting packet buffers；
- primary radiance；
- reactive/history；
- final HDR。

否则 FrameGraph 无法正确判断 dead pass、transient alias 和真实并行边界。

## 6. 直接重构推进顺序

遵循当前项目已经确定的开发节奏：先删旧链，连续实现完整模块，不在开发中反复跑广泛测试；完整主链接通后一次性集中验证。

### Phase 0：固定基线

保留以下三个 revision：

1. 9 月 25 日旧 baseline；
2. 中间版 15f12f7b；
3. 当前第三版 e7296be9。

固定分辨率、camera path、环境、AO、VSM、FSR3、Bloom、GPU adapter、热状态、warm-up 和 P50/P95 采集口径。不把温控降频结果直接当代码收益。

### Phase 1：删除旧 Surface 执行模型

删除旧 Pass、Probe、sample queue、generic worker、full-screen closure 和旧几何 producer。同步修改 FrameProgram、FrameProgramLowering、SurfaceProducts、ABI、counters 和无消费者测试 fixture。

允许中间阶段暂时不能编译、不能出完整画面，但不接回旧链、不写空 provider、不增加兼容 adapter。

### Phase 2：统一 SurfaceWork 和 GeometryRecord

实现 GpuSurfaceWorkAbi、tile descriptor、sample record、exception mask、GeometryRecord 和 overflow 语义。

完成条件：

- Appearance 不再解析 VisibilityKey；
- SparseLighting 不再解析 VisibilityKey；
- 同一个 Surface work 只有一次几何恢复；
- geometry、identity、UV、normal、tangent、signature 由一个 producer 发布。

### Phase 3：Appearance 改为 miss-only demand

将 pixel → task → geometry → program 改成 sample → cache lookup → miss compact → GeometryRecord → evaluate → publish。

删除“每个可见像素都必须有 task”的逻辑主模型。stripe 只能作为物理容量调度，不得重新定义逻辑工作单位。

### Phase 4：SparseLighting 分 signal packet

删除 prepare_surface 的重复几何恢复，使用 GeometryRecord。将 diffuse、specular、coat、IBL 分为独立 packet，按 cluster、shadow、environment 和 material revision 组织。

### Phase 5：reconstruct 降为廉价合成

禁止 reconstruct 再执行 Geometry Product 解码、完整材质图、normal/ORM 读取或完整环境 BRDF。它只做结果选择、lobe 合成、AO、energy、pre-exposure 和输出。

### Phase 6：接通环境、VSM、Temporal、FSR3

环境、VSM、AO 或材质 generation 变化时只让受影响 signal 失效。TemporalFacts 保持唯一 motion/identity 基础 producer。

### Phase 7：集中验证和删除残留

新链完整接通后集中执行 typecheck、build、GPU oracle、浏览器画质、生命周期、连续帧和性能矩阵。通过后删除历史生产入口和旧实现残留。

## 7. 容量、内存和调度

资源分为：

1. Long-lived publication：MaterialRecord、TextureResidency、Appearance programs、static products；
2. Frame persistent：FrameGeometryArena、Winner dictionary/coefficient、Surface history、Appearance cache pages；
3. Frame transient：SurfaceWork、GeometryRecord、miss queue、lighting packets、indirect arguments；
4. Output/history：HDR、reactive、temporal identity 和 signal history。

每类资源要有明确 owner、accounting 和 GPU completion retire point。不能只依赖 GraphicsContext 的 aggregate memory。

创建前必须协商 maxStorageBufferBindingSize、maxBufferSize、maxComputeWorkgroupSize、maxComputeInvocationsPerWorkgroup、maxComputeWorkgroupsPerDimension、maxBindingsPerBindGroup、maxBindGroups 和 texture/storage limits。

Overflow 语义：

- 不提交不完整 work；
- 设置 counter 和 diagnostic flag；
- 当前 tile 或 signal 完整回退到 bounded full-rate；
- 不让旧 queue 处理 fallback；
- 不通过第二次 CPU 控制的 submit 修补。

BindGroup 和 sampler 在 publication/profile 阶段缓存，frame 只更新小型 settings、task range 和 indirect buffer。不得为每个材质实例或纹理组合创建独立 PSO。

## 8. 性能验证

### 8.1 GPU counters

最终至少记录：

~~~text
visibilityPixels
surfaceTiles
surfaceImplicitTiles
surfaceUniformTiles
surfaceMixedTiles
surfaceGeometryRecords
surfaceGeometryOverflow
surfaceMaterialHits
surfaceMaterialMisses
surfaceMaterialEvaluations
surfaceDiffusePackets
surfaceSpecularPackets
surfaceCoatPackets
surfaceIblPackets
surfaceFullRateExceptions
surfaceHistoryHits
surfaceHistoryRejects
surfaceIblEvaluations
surfaceDirectLightEvaluations
surfaceAoRejects
surfaceVsmRejects
surfaceWorkOverflow
surfaceBytesWritten
surfaceDispatchCount
~~~

### 8.2 场景矩阵

必须覆盖：

- 远景低覆盖率；
- 近景高覆盖率；
- 静止镜头；
- 相机平移和旋转；
- 高频 normal / ORM；
- 低频材质；
- 多材质 tile；
- 强 IBL；
- Direct light + VSM；
- AO 开关；
- Product LOD 和 page miss；
- 空场景、单 Product 和设备恢复。

每个场景比较旧 baseline、中间版、当前第三版和完成后的最终版。固定分辨率、camera path、GPU adapter、浏览器、热状态、warm-up、P50/P95 和 feature set。没有完成这套比较前，不承诺固定 FPS 或百分比提升。

### 8.3 成功标准

- 近景重 Surface 工作量不再随可见像素线性增长；
- GeometryRecord 数量低于有效像素且没有漏算；
- Appearance miss 数量低于有效像素；
- 静止镜头有稳定 cache hit；
- IBL evaluation 不再等于所有有效像素；
- full-rate exception 可观测且不是整场景默认回退；
- SparseLighting 不再重复解析 VisibilityKey；
- reconstruct 不再运行完整 PBR；
- 无 overflow、device loss 和错误 history；
- 高频 normal、ORM、镜面、clearcoat 和轮廓画质正确。

## 9. AAA 画质不变量

必须保持：

- perspective barycentric、near clip 和退化三角形；
- non-uniform scale normal transform；
- mirror transform、double-sided 和 tangent sign；
- UV set、transform、wrap、filter、LOD 和 explicit gradient；
- sRGB/linear、normal map、ORM channel mapping；
- roughness、clearcoat、energy compensation；
- direct light cluster、VSM、physical sky、authored IBL；
- pre-exposure、jitter、motion、FSR3 reactive；
- temporal identity、disocclusion 和 alpha-mask coverage。

透明、多层覆盖和透明合成属于独立 composition domain，不把它们强行并入 opaque winner。

## 10. 当前第三版必须立即修正的三个问题

### 10.1 Cache lookup 语义仍不完整

当前 lookup 已位于 `SurfaceGeometryPass` 之前，但 classify 仍只写代表 sample，且 key 尚未覆盖完整 sampler/UV/footprint/variation 语义。必须完成真实 implicit/uniform/mixed 覆盖和完整 key 比较，确保命中项不进入 geometry/material heavy worker。

### 10.2 GeometryRecord 的覆盖仍不完整

结构上已合并为一个 `SurfaceGeometryPass`，但 Product 跨 LOD/source/seam、skin/morph 和 previous deformation 对应仍不完整。必须在这个唯一 producer 内补齐这些输入，不能恢复第二套几何恢复入口。

### 10.3 Reconstruct 的历史与合成语义仍不完整

当前 reconstruct 已只读 packet、GeometryRecord、TemporalFacts mask 和 pre-exposure，但 signal history read/reject/age、AO/emissive/energy composition 仍未完成。必须补齐这些结果选择和合成语义，同时保持 reconstruct 不执行完整 PBR。

## 11. 完成定义

- [ ] 旧 SurfaceMaterialPass 和中间版 sample producer 删除；
- [ ] production import graph 不再引用旧 Surface owner；
- [ ] VisibilityKey 只有 Visibility/SurfaceWork 入口解析；
- [ ] GeometryRecord 成为唯一 Surface geometry producer；
- [ ] cache lookup 位于 material miss compact 之前；
- [ ] cache hit 不进入 geometry/material heavy worker；
- [ ] direct、diffuse、specular、coat、IBL 有独立 signal work；
- [ ] normal/ORM/镜面 full-rate 是局部例外；
- [ ] SparseLighting 不重复恢复 geometry；
- [ ] reconstruct 不重新执行完整 PBR；
- [ ] TemporalFacts 是唯一 motion/identity 基础 producer；
- [ ] FrameGraph 能看到真实 SurfaceWork 边界；
- [ ] 所有 queue 和 indirect dispatch 有 bounded overflow 语义；
- [ ] GPU counters 能区分 hit、miss、packet、exception、IBL 和 overflow；
- [ ] 完成旧 baseline、中间版、当前第三版和最终版同条件比较；
- [ ] 近景、高频材质、移动镜头、AO、VSM、IBL 和 Product LOD 完成画质与性能验收。

## 12. 最终结论

当前第三版应该继续推进，不应该回退到 9 月 30 日 Signal-Rate 中间版。

中间版证明了 tile/sample 工作单位是正确方向，但仍然支付全屏 Probe、Builder、Resolve 和大量 per-sample PBR 成本。第三版的稳定材质地址、静态产品、Appearance cache、共享几何 owner 和独立 SparseLighting 具有更高的最终性能上限，也更适合后续扩展 AAA 的 IBL、VSM、Temporal、SSR、SSGI 和高质量材质。

但第三版当前还没有完成性能闭环。真正的突破必须完成：

~~~text
全像素 Appearance task
→ cache miss / sample work

Appearance geometry inputs + SparseLighting prepare_surface
→ 一个 SurfaceGeometryRecord producer

full-rate PBR reconstruct
→ packet result + history 的廉价合成
~~~

完成这三项后，第三版才会从“架构上最有潜力”变成“实际 GPU 时间上最优”。

## 13. 源码入口

- [RendererCore.ts](https://github.com/bigbigbig2/EEngine/blob/e7296be9cebbc3bcc1b6b738d682c928548d72d5/OEngine/src/render/pipeline/RendererCore.ts)
- [FrameProgram.ts](https://github.com/bigbigbig2/EEngine/blob/e7296be9cebbc3bcc1b6b738d682c928548d72d5/OEngine/src/render/program/FrameProgram.ts)
- [FrameProgramLowering.ts](https://github.com/bigbigbig2/EEngine/blob/e7296be9cebbc3bcc1b6b738d682c928548d72d5/OEngine/src/render/program/FrameProgramLowering.ts)
- [PackedVisibilityPass.ts](https://github.com/bigbigbig2/EEngine/blob/e7296be9cebbc3bcc1b6b738d682c928548d72d5/OEngine/src/render/passes/PackedVisibilityPass.ts)
- [AppearanceCachePass.ts](https://github.com/bigbigbig2/EEngine/blob/e7296be9cebbc3bcc1b6b738d682c928548d72d5/OEngine/src/render/surface/AppearanceCachePass.ts)
- [GpuAppearancePublication.ts](https://github.com/bigbigbig2/EEngine/blob/e7296be9cebbc3bcc1b6b738d682c928548d72d5/OEngine/src/gpu/GpuAppearancePublication.ts)
- [SparseLightingPass.ts](https://github.com/bigbigbig2/EEngine/blob/e7296be9cebbc3bcc1b6b738d682c928548d72d5/OEngine/src/render/surface/SparseLightingPass.ts)
- [surface_sparse_lighting.ts](https://github.com/bigbigbig2/EEngine/blob/e7296be9cebbc3bcc1b6b738d682c928548d72d5/OEngine/src/shaders/surface_sparse_lighting.ts)
- [WinnerPrimitiveInterpolation.ts](https://github.com/bigbigbig2/EEngine/blob/e7296be9cebbc3bcc1b6b738d682c928548d72d5/OEngine/src/render/surface/WinnerPrimitiveInterpolation.ts)
- [GpuRenderWorld.ts](https://github.com/bigbigbig2/EEngine/blob/e7296be9cebbc3bcc1b6b738d682c928548d72d5/OEngine/src/gpu/GpuRenderWorld.ts)
- [AppearanceGraphCompiler.ts](https://github.com/bigbigbig2/EEngine/blob/e7296be9cebbc3bcc1b6b738d682c928548d72d5/OEngine/src/material/AppearanceGraphCompiler.ts)
- [next-renderer-showcase](https://github.com/bigbigbig2/EEngine/tree/e7296be9cebbc3bcc1b6b738d682c928548d72d5/examples/demos/14-integrated/next-renderer-showcase)
