# GPU-Driven / Large-Scale Rendering 历史研究报告

> 状态：deferred 历史研究，不属于当前路线权威；当前参考入口见 `docs/references/README.md`。
>
> 本文档用于为 OEngine 的 Runtime Asset、GPU Render World、层次几何、GPU 工作生成、Visibility、Material Resolve、Streaming、Lighting 和 Temporal/Post 寻找可验证的外部参考。外部项目只提供证据、算法和工程对照；任何移植都必须经过许可证、ABI、WebGPU 能力和本地 benchmark 验证。
>
> 文中的 `VIS-*`、`MAT-*`、`WORK-*` 是历史研究映射，不是当前任务 ID。当前状态见 `docs/implementation/STATUS.md`，长期可见性决策见 ADR-0010/0011。

## 1. 研究结论

没有一个公开项目完整等价于 OEngine 的目标。目标架构实际上组合了多个技术谱系：

~~~text
Nanite                  → virtualized geometry / hierarchy / streaming
GPU-driven pipelines    → GPU scene / culling / indirect work generation
meshoptimizer / Bevy    → meshlet cooker / bounds / hierarchy validation
The Forge TVB           → visibility buffer / triangle filtering / material resolve
Scthe nanite-webgpu     → WebGPU software/hardware visibility
Falcor / ReSTIR         → advanced lighting / GI / temporal research
RenderGraph projects    → pass topology / resource lifetime / feature pruning
~~~

结论：

1. 生产级总体方向应以 Nanite、GPU-driven pipeline 和 Unity GPU Resident Drawer 为参照，但这些项目不能直接复制 runtime。
2. 最值得迁移的开源算法是 meshoptimizer 的 Meshlet/Cooker 能力，以及 Visibility Buffer、HZB、GPU work generation 的公开实现。
3. WebGPU 最接近的直接参考是 Scthe/nanite-webgpu，但它主要验证 R3/R4 算法，不是完整的大世界引擎。
4. OEngine 当前最需要补充的外部证据不是更多 SW raster demo，而是 WebGPU baseline 下的 command consumption、geometry/texture streaming 和 3A 光照闭环。

## 2. 成熟度分级

| 等级 | 定义 | 可用于什么 |
|---|---|---|
| S · 生产级 | 已进入商业引擎或大规模产品，核心思想经过真实项目验证 | 总体架构、能力边界、质量目标、失败模式 |
| A · 工程化开源/官方框架 | 代码完整、长期维护或拥有跨项目验证，但不一定是商业游戏产品 | 模块实现、数据布局、调度、工具链、实验复现 |
| B · 高相关实验项目 | 与 OEngine 目标高度相近，但平台、规模、生命周期或效果不完整 | 具体 shader、队列、可见性、hierarchy 原型 |
| C · 论文/样例验证 | 重点验证单个算法或理论，不提供完整 runtime | 算法选择、数值契约、性能假设和 reference test |

成熟度不等于性能一定更好。任何项目都必须记录硬件、分辨率、资产、材质、GPU API、队列方式和 benchmark 条件。

## 3. 参考项目总表

| 项目 | 级别 | 主要参考方向 | 对 OEngine 的映射 | 直接迁移性 |
|---|---|---|---|---|
| Unreal Nanite | S | cluster hierarchy、LOD、virtualized geometry、streaming、foliage assembly | COOK、WORLD、WORK、未来 streaming | 只迁移设计和公开资料 |
| Unity GPU Resident Drawer | S | GPU resident scene、instance batching、动态更新、fallback | WORLD-04/05/07/09 | API 不迁移，模型可参考 |
| GPU-Driven Rendering Pipelines | C/SIGGRAPH | GPU culling、cluster、indirect、shadow、virtual texturing | WORLD、WORK、FX-04 | 算法和数据流参考 |
| AnKi | A | GPU Scene、micro-patch、HZB、cone culling、MDI | WORLD、WORK、VIS | Vulkan 代码不能直接用于 WebGPU |
| The Forge TVB | A | Visibility Buffer、triangle filtering、Forward+、OIT | VIS、MAT、FX | 算法可迁移，API 不迁移 |
| meshoptimizer | A | Meshlet、vertex reuse、bounds、cone data | COOK-04/07/08 | 很适合 Cooker 集成 |
| NVIDIA Falcor | A | Render Graph、PBR、RT、ReSTIR、Path Tracing | FX、验证工具 | 适合研究，不是 runtime 基础 |
| Bevy Meshlet | B/A | Meshlet cooker、BVH、LOD error、attribute resolve | COOK、WORK、MAT | Rust/Vulkan/Metal 假设需改造 |
| Scthe/nanite-webgpu | B | WebGPU/WGSL、SW/HW raster、HZB、统计 | R3、R4、VIS | 最接近平台，不能当完整引擎 |
| Niagara | B/A | GPU scene、GPU culling、meshlet、MDI、mesh shading | WORLD、WORK | Vulkan/mesh shader 依赖 |
| Granite | B/A | RenderGraph、visibility bitmask、mesh rendering | R1、R3、VIS | Vulkan 数据流参考 |
| Renderling | B | wgpu/rust-gpu、GPU scene、PBR、Web | WORLD、R5 | alpha，适合观察生态路径 |
| SpartanEngine | B | bindless、RT、ReSTIR、PBR、editor/runtime | FX、资源系统 | 长期个人 R&D，不是生产证明 |
| MaskedOcclusionCulling | C/A | conservative raster、HZB、software depth | R1-C、WORK-06、VIS-02 | 很适合 CPU reference |

## 4. 生产级总体参考

### 4.1 Unreal Nanite

资料：

- [Nanite Virtualized Geometry](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine)
- [Nanite Assemblies](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-assemblies)

核心参考：offline geometry hierarchy、cluster/instance bounds、geometric error、LOD selection、fine-grained geometry streaming、GPU visibility traversal、coarse fallback、page residency 和 foliage assembly。

对 OEngine 的直接启发：Geometry Hierarchy 不等于 Streaming Page Table，两者要分开建模；hierarchy 的 coarse parent 必须始终可以作为 fallback；residency 失败时不能让 visibility key 指向失效资源；大量重复对象应使用共享 geometry/assembly，而不是复制完整 asset。

Nanite runtime 是闭源且深度依赖 Unreal 的资产管线、平台能力和材质系统。它适合作为能力模型和失败模式参考，不应被当作 WebGPU 实现规格。

### 4.2 Unity GPU Resident Drawer

资料：[GPU Resident Drawer](https://docs.unity.cn/Packages/com.unity.render-pipelines.high-definition@17.0/manual/gpu-resident-drawer.html)

主要参考 GPU resident object data、GPU instancing、BatchRendererGroup、dynamic object update、unsupported object fallback 和 runtime enable/disable behavior。

它更接近 OEngine 的 Packed Instance Set 和 GPU Render World，而不是 Nanite。应重点对照 Application World 到 GPU record 的增量更新、大量相同 geometry/material 的紧凑实例布局，以及不支持对象的显式 fallback。

## 5. GPU Scene 与工作生成

### 5.1 GPU-Driven Rendering Pipelines

资料：[Advances in Real-Time Rendering 2015](https://advances.realtimerendering.com/s2015/)

主要研究对象：GPU instance/cluster culling、mesh cluster、depth/occlusion culling、indirect draw、shadow work、virtual texturing 和大量对象的批量提交。

它对 OEngine 最重要的启发是：GPU-driven 的重点不是把 culling shader 放到 GPU，而是让 GPU 生成的结果能被下游真正消费，并且避免 CPU 重新读回可见列表。

### 5.2 AnKi

资料：

- [AnKi GPU-driven rendering overview](https://anki3d.org/gpu-driven-rendering-in-anki-a-high-level-overview/)
- [AnKi source repository](https://github.com/godlikepanos/anki-3d-engine)

重点阅读 GPU scene records、micro-patching、instance/meshlet culling、HZB occlusion、cone culling、indirect argument generation、multi-draw batching 和 shadow/probe work scheduling。

AnKi 特别适合评审 OEngine 的 WORK-08。它展示了一个关键现实：

~~~text
GPU queue generation != GPU command consumption
~~~

在 Vulkan/DX12 中可以使用 MDI、DGC 或 ExecuteIndirect；WebGPU baseline 没有这些完整能力。因此 OEngine 必须另行冻结 WebGPU baseline hardware consumer、mega-draw/vertex pulling、fixed indirect slots、compute visibility/raster consumer 和 optional enhanced multi-draw path。

### 5.3 Niagara

资料：[Niagara source repository](https://github.com/zeux/niagara)

Niagara 适合观察一个 GPU-driven renderer 从 GPU scene、object culling、cone culling 演进到 meshlet/mesh shading 和 indirect submission 的过程。它不是生产引擎，且很多能力依赖 Vulkan/mesh shader，因此只迁移数据流和调度思路。

## 6. Geometry Cooker、Meshlet 与层次结构

### 6.1 meshoptimizer

资料：

- [meshoptimizer](https://github.com/zeux/meshoptimizer)
- [Meshlet API documentation](https://meshoptimizer.org/)

建议研究 meshopt_buildMeshlets、meshopt_buildMeshletsFlex、meshopt_optimizeVertexFetch、meshopt_computeMeshletBounds、meshopt_computeClusterBounds，以及 vertex/index remap and reuse。

适合直接评估为 Geometry Cooker 依赖，但必须记录上游 commit/tag、meshlet max vertices/triangles、bounds/cone 语义、OEngine stream 差异、quantization 差异、license notice 和本地 validator。

不要把 64 vertices/126 triangles 当成跨 GPU 固定答案。meshlet 大小、cluster group 大小、顶点压缩格式和 traversal wave 需要用 A/B/C 以及 adapter profile 验证。

### 6.2 Bevy Meshlet Renderer

资料：

- [Bevy Meshlet source](https://github.com/bevyengine/bevy/tree/main/crates/bevy_pbr/src/meshlet)
- [Meshlet construction source](https://github.com/bevyengine/bevy/blob/main/crates/bevy_pbr/src/meshlet/from_mesh.rs)

重点参考 meshlet 分组、hierarchy parent/child、geometric error、BVH 构建、reachability/orphan validator、quantized vertex 和 visibility buffer 后续属性恢复。

Bevy 的重要负面证据是：meshlet renderer 可能增加基础开销和内存，并且需要较强的原子/平台能力。它适合做 OEngine 的 CPU reference 和 cooker validator，不应直接证明 hierarchy 一定比 flat meshlet 快。

### 6.3 Vulcanite

资料：[Vulcanite](https://github.com/bdwhst/Vulcanite)

可用于对照 cluster merge、LOD simplification、hierarchy build、geometric error 和 cluster group layout。这类项目通常不完整覆盖 runtime streaming、device lost、材质 residency 和多 view shadow，不能代替 WORLD-06/09。

## 7. Visibility Buffer、Hybrid Raster 与 Material Resolve

### 7.1 Visibility Buffer

论文：[The Visibility Buffer: A Cache-Friendly Approach to Deferred Shading](https://jcgt.org/published/0002/02/04/)

Visibility Buffer 的核心思想是：光栅阶段主要输出 triangle/instance visibility，后续根据 visibility key、深度和 barycentric 重建 triangle attributes、instance transform、normal/tangent/UV、material ID、texture references 和 velocity。

它直接支撑 OEngine 的：

~~~text
VisibilityKey
→ VisibleCluster lookup
→ barycentric reconstruction
→ single Material Resolve
→ Surface/Velocity
~~~

需要重点验证 triangle key 位宽、depth/ID 带宽、perspective-correct barycentric、analytic texture gradients、alpha-tested visibility、LOD transition/velocity 和随机 lookup cache 行为。

### 7.2 The Forge Triangle Visibility Buffer

资料：

- [The Forge](https://github.com/ConfettiFX/The-Forge)
- [Triangle Visibility Buffer sample](https://github.com/ConfettiFX/The-Forge/tree/master/Examples_3/Visibility_Buffer)

适合研究 visibility buffer 1.0、triangle filtering、Forward+ light list、OIT、visibility buffer 2.0 的 compute filtering，以及从 triangle ID 到材质/属性的统一恢复。

The Forge 的价值在于它不只是论文，而是跨平台 renderer 中的可运行实现。它可帮助判断 OEngine 应采用传统 indirect hardware visibility、compute triangle visibility，还是两者按 profile 混合。

### 7.3 Scthe/nanite-webgpu

资料：[nanite-webgpu](https://github.com/Scthe/nanite-webgpu)

这是最接近 OEngine WebGPU 目标的外部项目，适合研究 WebGPU/WGSL hierarchy traversal、software/hardware raster、HZB、micro triangle classification、32-bit atomic、visibility statistics 和 browser adapter 行为。

它的限制也要记录：主要是 demo/research renderer；资产、材质和 residency 不等价于通用游戏引擎；固定队列和单场景布局不能直接成为产品 ABI；软件光栅收益高度依赖 triangle size、bbox、atomic contention 和 GPU profile。

### 7.4 软件遮挡和保守光栅

资料：[Intel MaskedOcclusionCulling](https://github.com/GameTechDev/MaskedOcclusionCulling)

它主要是 CPU/SIMD 实现，但非常适合验证 conservative coverage、top-left/shared edge、depth precision、tile mask、HZB、front-to-back 顺序以及漏绘和误遮挡边界。应作为 VIS-02 CPU reference，而不是直接作为 WebGPU shader 移植。

## 8. RenderGraph、GPU World 与 WebGPU 生态

### 8.1 Granite

资料：[Granite](https://github.com/Themaister/Granite)

重点参考 RenderGraph/resource lifetime、per-view visibility bitmask、persistent GPU state、mesh rendering 和 Vulkan feature profile。Granite 适合帮助 OEngine 评审 R1 FrameGraph 和多 view visibility，但不能把 Vulkan 的 bindless、MDI 和 descriptor 行为直接假设为 WebGPU baseline。

### 8.2 Renderling

资料：[Renderling](https://github.com/schell/renderling)

Renderling 适合观察 wgpu/rust-gpu 生态中的 GPU scene、PBR、forward+、Web/backend 适配和 shader ownership。它属于 alpha/实验项目，适合平台和架构观察，不适合作为性能或产品成熟度证明。

### 8.3 NVIDIA Falcor

资料：[Falcor](https://github.com/NVIDIAGameWorks/Falcor)

Falcor 更适合作为独立算法验证平台：RenderGraph、PBR、ray tracing、path tracing、ReSTIR、denoising 和 temporal effects。它可以用于为 OEngine 的 FX-10 选择 GI/RT 算法，但不应让 Falcor 的 DX12/Vulkan 资源模型反向决定 WebGPU baseline ABI。

## 9. Lighting、GI 与 3A 画质参考

### 9.1 ReSTIR GI

论文：[ReSTIR GI: Path Resampling for Real-Time Path Tracing](https://research.nvidia.com/publication/2021-06_restir-gi-path-resampling-real-time-path-tracing)

它适合作为高质量 GI 的研究入口，但不能直接作为当前 R5 的基础依赖。落地前需要明确 ray query/RT capability、reservoir buffer、temporal invalidation、disocclusion、denoising 和 fallback 到 probes/IBL/SSR 的策略。

### 9.2 3A 画质系统的外部参考范围

OEngine 如果要达到类似 3A 的效果，参考范围至少应扩展到：

~~~text
Nanite / virtual geometry
virtual shadow maps or equivalent
Lumen/DDGI/ReSTIR-like GI
SSR + reflection fallback
volumetric fog/cloud
OIT/translucency
skin/hair/foliage/terrain
TAAU/upscaling/dynamic resolution
HDR/exposure/color management
~~~

单次 Material Resolve、clustered lighting、IBL、TAA、Bloom 和 Tonemap 只能形成高质量 PBR 基础，不足以单独证明 3A 级画质。

## 10. 对 OEngine 的实现映射

### R2 · Runtime Asset / GPU Render World

~~~text
Nanite             → runtime geometry package / streaming model
Unity Resident     → packed instance / dynamic update / fallback
AnKi               → GPU scene record / micro-patch
meshoptimizer      → cooker output / bounds / cone
Bevy               → hierarchy validator / CPU reference
~~~

必须新增或冻结 Runtime Asset package header/section/version、stable generational handle、resident handle 与 world handle 分离、table grow 和 deferred reuse、previous transform、device epoch、geometry/texture page residency、coarse fallback 和 in-flight frame lifetime。

### R3 · Hierarchical Work Generation

~~~text
AnKi               → GPU scene / culling / indirect batching
Niagara            → GPU work generation / meshlet scheduling
Bevy               → hierarchy traversal / LOD error
Nanite             → hierarchical visibility / streaming interaction
~~~

必须单独冻结 WebGPU baseline HardwareRaster consumer、actual draw/dispatch count、mega-draw vs fixed indirect slots、visibility key production、shadow view reuse 和 queue capacity/parent fallback。

### R4 · Hybrid Visibility

~~~text
Scthe              → WebGPU/WGSL SW/HW raster prototype
The Forge TVB2     → compute triangle filtering
MaskedOcclusion    → conservative coverage/depth reference
LucidRaster        → optional exact OIT/software raster research
~~~

默认策略：HW-only 是正确性 baseline，SW 是微三角形 profile optimization，Hybrid 只有 benchmark 证明后启用。

### R5 · Material / Lighting / Temporal

~~~text
Visibility Buffer paper → key/barycentric/attribute resolve
The Forge TVB          → 可运行 visibility/material implementation
Falcor                 → RenderGraph/GI/RT/temporal research
ReSTIR GI              → 高质量间接光
Nanite/Unity docs      → shadow/streaming/large-scene quality boundary
~~~

## 11. 许可证与移植规则

任何代码移植前必须建立以下记录：

~~~text
upstream repository URL
commit/tag
source file and test/example
license
copied/ported scope
retained invariants
OEngine/WebGPU adaptation
precision/semantic differences
local regression test
~~~

许可证必须以具体 commit/tag 和仓库文件为准，不能只根据搜索结果或项目简介判断。无明确许可证的项目只能做概念对照，不复制代码或翻译实现。

## 12. 建议新增的验证矩阵

### Cooker / Geometry

- meshlet max vertices/triangles；
- parent/child coverage；
- hierarchy cycle/orphan；
- quantized bounds conservative；
- geometric error monotonicity；
- CPU/GPU traversal selected set；
- compressed stream decode；
- page residency fallback。

### GPU Work Generation

- instance count、node count、selected cluster count scaling；
- queue attempted/written/peak/overflow；
- parent fallback 无漏绘；
- actual dispatch/draw count；
- no CPU visible-list readback；
- main/shadow multi-view cost；
- fixed rounds 空工作成本。

### Visibility / Resolve

- HW/SW/Hybrid key/depth 对照；
- shared edge/top-left；
- near clip/viewport edge；
- reverse-Z；
- tie-breaking；
- barycentric/UV gradient；
- alpha test；
- velocity/LOD transition；
- MSAA unsupported/fallback。

### Large World / Streaming

- geometry page miss；
- texture page miss；
- coarse fallback；
- load/unload/reload；
- device lost rebuild；
- in-flight eviction；
- memory budget pressure；
- camera teleport；
- multiple view/shadow residency。

### Quality / Effects

- direct/IBL/shadow；
- GI/probe fallback；
- reflection miss；
- OIT overflow；
- volumetric history；
- TAA disocclusion；
- dynamic resolution；
- HDR/exposure/tonemap；
- feature-off graph/resource zero-cost。

## 13. 推荐研究顺序

~~~text
1. AnKi + Vulkan MDI/DGC
   先解决 R3 的真实 command consumption

2. meshoptimizer + Bevy
   冻结 Cooker、Meshlet、BVH8、误差和 validator

3. Nanite public material
   设计长期 geometry/texture streaming 和 coarse fallback

4. Visibility Buffer + The Forge TVB
   实现 R5 single Material Resolve

5. Scthe nanite-webgpu
   验证 WebGPU SW/HW/Hybrid 与 32-bit atomic 边界

6. Falcor + ReSTIR
   验证 GI、RT、temporal 和 denoising

7. MaskedOcclusionCulling
   收紧 conservative raster/HZB CPU reference
~~~

## 14. 对当前 GPU-DRIVEN.md 的补充建议

当前 GPU-DRIVEN.md 已经覆盖 three.js、Scthe、Bevy、renderling、Niagara、PlayCanvas 和 Babylon，但建议继续拆出：

~~~text
production architecture
open-source engine
WebGPU direct reference
geometry cooker
GPU command consumption
visibility/material resolve
streaming/residency
lighting/GI/temporal
algorithm paper
validation artifact
~~~

每个项目卡片至少要有 maturity、license、backend/API、asset format、hierarchy format、GPU scene layout、culling stages、command consumption model、visibility representation、material resolve model、streaming model、fallback behavior、known limitations、benchmark evidence 和 candidate OEngine task IDs。

## 15. 最终判断

OEngine 的参考路线应当是：

~~~text
Nanite
  + AnKi/Niagara GPU scene and work generation
  + meshoptimizer/Bevy cooker and hierarchy validation
  + The Forge Visibility Buffer and material resolve
  + Scthe WebGPU hybrid raster
  + Falcor/ReSTIR lighting research
~~~

其中最关键的不是 R4 软件光栅，而是：

1. R2 是否真正做到变化量驱动的 GPU Render World；
2. R3 是否解决 WebGPU 下 GPU work 的实际消费；
3. geometry/texture 是否拥有 streaming 和 coarse fallback；
4. R5 是否从基础 PBR 扩展到 GI、阴影、透明、体积和时域画质；
5. 所有结论是否由 C 场景、P95/P99、跨 adapter 和生命周期测试证明。

达到这些条件后，OEngine 有机会成为面向 WebGPU 的高性能大场景 GPU-driven renderer。仅完成 Meshlet、HZB、SW raster 或 single Material Resolve 中的某一项，不能声称已经达到 Nanite 或 3A 引擎级别。

## 16. 具体算法迁移卡片

本节不是项目简介，而是实现前的源码定位和迁移清单。每张卡片都要求先阅读上游源码、测试和许可证，再决定是直接依赖、局部移植还是独立重写。

### ALG-01 Meshlet 构建与局部索引

首选参考：

- [meshoptimizer repository](https://github.com/zeux/meshoptimizer)
- [meshoptimizer source](https://github.com/zeux/meshoptimizer/tree/master/src)
- [gltfpack source](https://github.com/zeux/meshoptimizer/blob/master/tools/gltfpack.cpp)
- [Bevy meshlet construction](https://github.com/bevyengine/bevy/blob/main/crates/bevy_pbr/src/meshlet/from_mesh.rs)

算法输入：

~~~text
indexed position/normal/tangent/UV/color streams
triangle index buffer
vertex cache objective
max_vertices
max_triangles
optional spatial/LOD grouping
~~~

算法输出：

~~~text
meshlet vertex remap
local triangle indices
meshlet vertex/triangle ranges
meshlet bounds
normal cone / backface data
vertex fetch optimized streams
~~~

迁移步骤：

1. 用上游 builder 生成固定黄金资产，不接 runtime。
2. 将输出转换为 OEngine Runtime Geometry Package 的 section。
3. 用 CPU validator 检查 local index、range、triangle count、bounds 和 source triangle coverage。
4. 在 WGSL 中只实现 decode/read，不在 shader 中重新推断 asset layout。
5. 对 32、64、126、128 等 meshlet 配置做 triangle size、vertex reuse、GPU bandwidth 和 traversal cost sweep。

必须保持的不变量：

- local triangle 一定能回查唯一 geometry/meshlet；
- meshlet bounds 是保守的；
- cone culling 只能 reject 确定背向的 cluster；
- source triangle 不丢失、不重复，除非 cooker 明确记录 seam split；
- position、normal、tangent、UV 的量化误差分别统计。

OEngine 映射：COOK-04、COOK-07、COOK-08、VIS-01、MAT-04。

性能陷阱：meshlet 过小会放大 queue、draw、lookup 和 bounds 成本；meshlet 过大则降低 culling 粒度。不能只用 triangle 数或“越小越 GPU-driven”作为选择依据。

### ALG-02 Cluster Group、LOD hierarchy 与几何误差

首选参考：

- [Nanite public documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine)
- [Bevy meshlet hierarchy code](https://github.com/bevyengine/bevy/tree/main/crates/bevy_pbr/src/meshlet)
- [Vulcanite](https://github.com/bdwhst/Vulcanite)
- [Nanite-like RenderingEngine](https://github.com/Vovan675/RenderingEngine)

建议数据结构：

~~~text
ClusterRecord
  bounds sphere/AABB
  normal cone
  geometric error
  parent index
  child range/count
  renderable meshlet range
  material range
  residency page/range
~~~

算法迁移顺序：

1. 先实现 bottom-up group merge 和可达性检查。
2. 再实现 parent proxy geometry 或已生成的 coarser renderable cluster。
3. 计算 object-space geometric error，并将误差传播到 parent/child。
4. 用 CPU reference 在 perspective、orthographic、near-plane 和 non-uniform scale 下验证 SSE。
5. 最后才把层次结构序列化到 Runtime Asset Package。

关键公式：

~~~text
worldError = objectError × maxScale(instanceTransform)
pixelError ≈ worldError × projectionScaleY × viewportHeight
             / max(viewDepth, nearClamp)
~~~

不能混淆：

- hierarchy parent 不是 streaming page；
- renderable cluster 不是 meshlet；
- object ID 不是 GPU table slot；
- LOD selection 不是 HZB occlusion；
- page eviction 不能删除唯一 coarse fallback。

OEngine 映射：COOK-05、COOK-06、WORK-01、WORK-04、WORK-06。

### ALG-03 BVH8 / hierarchy GPU traversal

首选参考：

- [Bevy meshlet implementation](https://github.com/bevyengine/bevy/tree/main/crates/bevy_pbr/src/meshlet)
- [AnKi GPU-driven overview](https://anki3d.org/gpu-driven-rendering-in-anki-a-high-level-overview/)
- [Niagara](https://github.com/zeux/niagara)

推荐 wavefront ABI：

~~~text
TraversalWork: instanceSlot, nodeIndex
SelectedCluster: instanceSlot, geometrySlot, clusterIndex, materialSlot
RasterWork: visibleClusterSlot, meshletIndex
IndirectArgs: dispatch/draw arguments written by GPU
~~~

实现顺序：instance frustum cull、root queue、BVH8 child decode、conservative frustum、cone culling、SSE descend/select、previous-HZB occlusion、selected cluster compact、HW/Alpha/SW classify。

WebGPU 关键问题：WebGPU 没有默认的 mesh/task shader、MDI、DGC 或 64-bit atomic。固定 ping-pong rounds 可以作为 baseline，但必须测量空 round、queue bandwidth 和多 view 成本。更重要的是，GPU 生成的 RasterWork 必须有实际 consumer。

必须新增的架构决策：

~~~text
WebGPU baseline hardware consumer
  A. one vertex-pulling mega draw
  B. fixed indirect slots
  C. compute visibility/raster consumer
  D. optional enhanced multi-draw path
~~~

没有这个决策，WORK-08 只能算“GPU 生成了命令数据”，不能算完整 GPU-driven。

OEngine 映射：WORLD-07、WORK-03、WORK-04、WORK-05、WORK-08、VIS-05。

### ALG-04 HZB 构建与 conservative occlusion

首选参考：

- [Hierarchical Z-Buffer Visibility](https://dl.acm.org/doi/10.1145/166117.166147)
- [three.js compute rasterizer IBL](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_compute_rasterizer_ibl.html)
- [MaskedOcclusionCulling](https://github.com/GameTechDev/MaskedOcclusionCulling)
- [nanite-webgpu sources](https://github.com/Scthe/nanite-webgpu/tree/master/src)

迁移拆分：

~~~text
CPU reference reduction
→ single-view GPU mip build
→ previous/current ping-pong
→ object bounds query
→ hierarchy node query
→ same-frame late visibility
~~~

必须验证 reverse-Z reduction 方向、odd width/height、mip subresource hazard、depth/storage texture 支持、bounds expansion、near-plane/camera-inside bounds、resize、camera cut、render scale、feature toggle，以及 no false occlusion。误剔除必须 fail-open。

性能策略：先实现每 build 一个 Compute Pass、多 mip dispatch；只有 profiling 证明 dispatch/全局内存成为瓶颈时，才研究 subgroup、SPD 或更紧凑的 reduction。

OEngine 映射：R1-C、WORK-06、VIS-02、VIS-09、FX-07、FX-08。

### ALG-05 GPU work queue、compact 与间接消费

首选参考：

- [GPU-Driven Rendering Pipelines](https://advances.realtimerendering.com/s2015/)
- [AnKi source](https://github.com/godlikepanos/anki-3d-engine)
- [Vulkan multi-draw indirect sample](https://docs.vulkan.org/samples/latest/samples/performance/multi_draw_indirect/README.html)
- [The Forge](https://github.com/ConfettiFX/The-Forge)

append queue 与 prefix/scan 的选择：

~~~text
append/atomic reservation
  优点：实现简单、无稳定顺序要求时便宜
  风险：atomic contention、顺序不稳定、容量处理复杂

prefix scan/scatter
  优点：稳定 compact、可预测布局、适合批量输出
  风险：多次读写、临时 buffer、空工作成本
~~~

迁移规则：

- queue element、header、stride、capacity、overflow bit 必须由 schema 生成；
- raw count 不得直接传给 consumer，必须先 clamp；
- overflow 不能静默丢项；
- parent fallback、HW fallback 或 explicit frame error 必须在 ABI 中定义；
- 任何 GPU 计数都要区分 attempted、written、peak 和 recoverable overflow；
- benchmark 必须报告真实 dispatch/draw/compute invocation 数。

最关键的 WebGPU 适配：如果没有 multi-draw indirect，不能假设一个 indirect buffer 自动执行 N 个 draw。要选择 mega draw/vertex pulling、固定 command slots 或 compute visibility。

OEngine 映射：WORK-02、WORK-05、WORK-08、VIS-05、FX-02、FX-04、FX-05。

### ALG-06 VisibilityKey、Visibility Buffer 与属性重建

首选参考：

- [The Visibility Buffer paper](https://jcgt.org/published/0002/02/04/)
- [The Forge Visibility Buffer](https://github.com/ConfettiFX/The-Forge/tree/master/Examples_3/Visibility_Buffer)
- [Bevy Meshlet](https://github.com/bevyengine/bevy/tree/main/crates/bevy_pbr/src/meshlet)

数据流：

~~~text
pixel
→ VisibilityKey
→ visible cluster / meshlet / local triangle
→ geometry stream lookup
→ barycentric reconstruction
→ MaterialTable lookup
→ texture pool sampling
→ Surface + Velocity
~~~

必须冻结 frame-local key 与 stable object ID 的区别、local triangle 位宽、multi-meshlet cluster 回查、empty/invalid sentinel、depth tie-break、perspective-correct barycentric、derivative/LOD、alpha-tested discard 和 SW/HW 一致性。

性能陷阱：visibility buffer 降低 GBuffer 生成成本，但 resolve 可能产生随机 geometry/material/texture lookup。必须报告 cache miss、texture pool fallback、bandwidth 和 resolve GPU time，而不是只看 draw 数。

OEngine 映射：VIS-01、VIS-07、MAT-03、MAT-04、MAT-05、MAT-06。

### ALG-07 WebGPU 软件微光栅

首选参考：

- [nanite-webgpu raster sources](https://github.com/Scthe/nanite-webgpu/tree/master/src/passes)
- [The Forge TVB2](https://github.com/ConfettiFX/The-Forge)
- [MaskedOcclusionCulling](https://github.com/GameTechDev/MaskedOcclusionCulling)
- [LucidRaster](https://arxiv.org/abs/2405.13364)

推荐 baseline：

~~~text
Stage 1: conservative depth atomic
Stage 2: same coverage/depth + deterministic key tie
Stage 3: fullscreen transfer to final visibility/depth
Stage 4: hardware raster load/greater merge
~~~

必须共享：clip、top-left edge、pixel center、reverse-Z、depth quantization 和 degenerate handling 必须由同一套 WGSL helper 产生，不能让 depth stage 和 key stage 各自实现。

必须回退 HW 的情况：alpha/复杂 clip、near-plane 大三角形、超大 bbox、unsupported primitive、SW queue overflow、atomic contention 热点和 MSAA。

OEngine 映射：VIS-02 至 VIS-10。

决策原则：R4 是 profile optimization，不是引擎正确性前提；如果 HW-only 在目标 adapter 更快，默认关闭 SW 仍然是成功结果。

### ALG-08 Standard PBR、材质表与纹理采样

首选参考：

- [Filament](https://github.com/google/filament)
- [Filament materials documentation](https://google.github.io/filament/Materials.html)
- [Khronos glTF Sample Viewer](https://github.com/KhronosGroup/glTF-Sample-Viewer)
- [The Forge](https://github.com/ConfettiFX/The-Forge)
- [glTF material specification](https://github.com/KhronosGroup/glTF/tree/main/specification/2.0)

可迁移内容：metallic-roughness 语义、normal/tangent convention、sRGB/linear conversion、occlusion/emissive、clearcoat/transmission/IOR feature boundary、image-based lighting、BRDF LUT、environment prefilter、material validation 和 fallback。

OEngine 迁移方案：

1. 先用 glTF Sample Viewer/Filament 建立 CPU/HDR reference。
2. 冻结 MaterialRecord 的字段、16-byte alignment 和 feature bits。
3. 纹理引用统一为 poolClass/bank/layer/samplerClass/uvTransform。
4. 先实现 bounded texture-array banks，不为每个材质创建 bind group。
5. 再加入 page residency、mip policy、fallback texture 和 streaming。

性能陷阱：Material Resolve 从全屏材质数扫描变成单次像素扫描后，随机纹理访问会成为新瓶颈。MaterialTable stride、texture bank 分支、mip/gradient 和 surface attachment 带宽必须单独 benchmark。

OEngine 映射：MAT-01 至 MAT-10、FX-02、FX-03、FX-05。

### ALG-09 Texture/Geometry streaming 与 residency

首选参考：

- [Nanite Virtualized Geometry](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine)
- [Nanite Assemblies](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-assemblies)
- [KTX-Software](https://github.com/KhronosGroup/KTX-Software)
- [Basis Universal](https://github.com/BinomialLLC/basis_universal)
- [KTX 2.0 specification](https://github.com/KhronosGroup/KTX-Specification)
- [3D Tiles specification](https://github.com/CesiumGS/3d-tiles)

建议分成三个系统：

~~~text
Asset package
  设备无关 sections、page records、checksums、dependencies

Residency manager
  GPU page allocation、upload、LRU/priority、in-flight protection

Visibility fallback
  resident test、coarse parent、fallback texture、error counter
~~~

页面状态：

~~~text
unloaded → requested → uploading → resident → evict-pending → evicted
                         ↘ failed → fallback/error
~~~

必须验证 camera teleport、asset unload/reload、page miss、upload budget、memory pressure、shadow/main view 共同 residency、in-flight frame 不提前释放、device lost 后重新 resident，以及 coarse fallback 无洞、无 invalid key。

3D Tiles 不是游戏引擎渲染方案，但可以参考其 tile hierarchy、content availability、geometric error 和大场景 streaming 契约。

OEngine 映射：WORLD-06、WORLD-09、COOK-09、未来 STREAM-01 至 STREAM-10。

### ALG-10 基础数学、材质和资产库

这些库不一定直接进入最终 runtime，但应优先作为 reference 或可选依赖评估：

| 领域 | 项目 | 推荐用途 |
|---|---|---|
| JS/TS 矩阵 | [gl-matrix](https://github.com/toji/gl-matrix) | vec/mat/quaternion 基础实现和测试对照 |
| WebGPU/TS 矩阵 | [wgpu-matrix](https://github.com/greggman/wgpu-matrix) | WebGPU uniform、projection、camera math |
| 切线空间 | [MikkTSpace](https://github.com/mmikk/MikkTSpace) | glTF tangent generation、normal map 对齐 |
| glTF 变换 | [glTF-Transform](https://github.com/donmccurdy/glTF-Transform) | prune、dedup、meshopt、Draco、KTX2 处理 |
| glTF validator | [Khronos glTF Validator](https://github.com/KhronosGroup/glTF-Validator) | 输入资产规范和错误诊断 |
| glTF viewer | [Khronos glTF Sample Viewer](https://github.com/KhronosGroup/glTF-Sample-Viewer) | PBR/IBL/材质数值和截图 reference |
| 纹理压缩 | [KTX-Software](https://github.com/KhronosGroup/KTX-Software) | KTX2、BasisU、GPU compressed texture pipeline |
| 几何压缩 | [Draco](https://github.com/google/draco) | 非 Meshlet 资产的传输/存储压缩对照 |
| 动画 | [ozz-animation](https://github.com/guillaumeblanc/ozz-animation) | offline animation compression、runtime sampling |
| ECS | [EnTT](https://github.com/skypjack/entt) | Application World 数据导向组织参考 |
| PBR 引擎 | [Filament](https://github.com/google/filament) | Standard PBR、IBL、材质 feature 语义 |

选择规则：OEngine 是 TypeScript/WebGPU，因此 C++/Rust 库优先作为 cooker、WASM/native tool 或 reference；不要因为库成熟就把 native ABI、线程模型或 allocator 强行引入浏览器 runtime。

## 17. 不以 R1-R5 为唯一路线的替代执行方向

R1-R5 是当前文档组织方式，不是不可改变的实现顺序。结合外部项目后，更推荐采用以下能力轨道：

### Track A · Reference and ABI Foundation

~~~text
source asset validation
runtime package schema
shared TS/WGSL schema generator
CPU math/reference raster
benchmark artifact and license ledger
~~~

### Track B · Hardware-first GPU-driven baseline

~~~text
GPU Render World
Packed Instance Set
GPU instance cull
hierarchy/SSE LOD
hardware visibility
single material resolve
direct lighting/IBL/shadow
~~~

这条轨道优先形成一个完整、稳定、可测的产品主链，不等待软件光栅。

### Track C · Residency and Large World

~~~text
geometry pages
texture pages
coarse fallback
async upload
budget/priority/eviction
device lost/recovery
main/shadow multi-view residency
~~~

这条轨道是开放世界规模的真正门槛，应该从 R2 的非目标中拆出来成为独立高优先级能力。

### Track D · Visibility Optimization

~~~text
visibility buffer
compute triangle filtering
software micro-raster
hybrid thresholds
OIT/complex visibility
~~~

只有 Track B 已经可测，Track D 才能判断 SW/HW 的真实收益。

### Track E · Image Quality

~~~text
Standard PBR
IBL
shadow quality
GI/probes/ReSTIR
SSR/reflection
transparency/OIT
volumetric
TAAU/upscaling
skin/hair/foliage/terrain
~~~

### 推荐顺序

~~~text
Track A
  → Track B
  → Track C 与 B 的 residency integration
  → Track E 的基础 PBR/IBL/shadow
  → Track D 的 profile optimization
  → Track E 的 GI/volumetric/特殊材质
~~~

这个顺序比把 R4 软件光栅当作 R5 之前的硬依赖更稳健，也更符合生产引擎的风险控制。

## 18. 参考项目的实际迁移记录模板

每次准备复制或移植外部实现时，在相关任务或 references/porting 下创建记录：

~~~text
Reference ID:
Upstream project:
Repository URL:
Commit/tag:
Source file/path:
Test/example path:
License:
Maturity class:
Algorithm scope:
Input/output ABI:
Retained invariants:
OEngine adaptation:
WebGPU capability differences:
Precision differences:
Performance hypothesis:
Benchmark case:
Fallback:
Local test/regression:
Decision: adopt / port / reimplement / reject
Reason:
~~~

如果上游代码不兼容、没有许可证、依赖不可用能力或 benchmark 不满足 OEngine 目标，必须记录 reject，而不是无记录地重新实现。

## 19. Source-level 阅读索引

下面的路径是实现前建议直接打开的源码入口。路径可能随上游分支调整，移植记录必须锁定具体 commit/tag 后再使用。

### Asset / Geometry

| 上游 | 优先阅读 | OEngine 目标 |
|---|---|---|
| meshoptimizer | src/meshoptimizer.cpp、tools/gltfpack.cpp、demo/gltf/ | Meshlet、vertex fetch、bounds、压缩和 glTF cooker |
| Bevy | crates/bevy_pbr/src/meshlet/from_mesh.rs、crates/bevy_pbr/src/meshlet/ | hierarchy、BVH、LOD error、validator |
| glTF-Transform | packages/functions/src、packages/core/src、packages/extensions/src | prune、dedup、meshopt、Draco、KTX2 pipeline |
| Draco | src/draco/compression、src/draco/mesh | 几何压缩和传输体积对照 |
| KTX-Software | lib、tools、interface | KTX2、BasisU、mipmap、GPU compressed texture |
| MikkTSpace | mikktspace.c、mikktspace.h | tangent generation 和 normal map 兼容 |
| glTF Validator | packages/gltf-validator、schema | 输入资产错误诊断和 fixture 过滤 |

### GPU-driven / Visibility

| 上游 | 优先阅读 | OEngine 目标 |
|---|---|---|
| Scthe/nanite-webgpu | src/passes、src/sys_web、WGSL raster/cull modules | WebGPU hierarchy、SW/HW、HZB、统计 |
| AnKi | AnKi/Renderer、AnKi/Scene、AnKi/Gr | GPU scene、culling、MDI、resource owner |
| Niagara | src、shaders、samples | GPU work generation、meshlet、indirect |
| The Forge | Examples_3/Visibility_Buffer、Common_3/Renderer | TVB、triangle filtering、Forward+、OIT |
| Granite | renderer、application、assets、render graph modules | persistent visibility、RenderGraph、mesh path |
| MaskedOcclusionCulling | MaskedOcclusionCulling.cpp、MaskedOcclusionCulling.h、tests | conservative raster、HZB、CPU reference |
| Renderling | renderling/src、renderling/shaders | wgpu/rust-gpu 的 GPU scene 与 shader ownership |

### Material / Lighting

| 上游 | 优先阅读 | OEngine 目标 |
|---|---|---|
| Filament | filament/src、libs/filamat、shaders/src、docs/Materials.md | Standard PBR、IBL、BRDF、材质编译 |
| glTF Sample Viewer | src、renderer、extensions | glTF PBR/IBL 视觉和数值 reference |
| Falcor | Source/Falcor/Rendering、Source/Falcor/Utils、Media | RenderGraph、PBR、RT、GI、denoising |
| ReSTIR GI | paper、supplemental code、Falcor implementation | reservoir、temporal GI、disocclusion |
| The Forge | Visibility Buffer shading and light cluster modules | single resolve、Forward+、OIT |

### Runtime / Math / Animation

| 上游 | 优先阅读 | OEngine 目标 |
|---|---|---|
| gl-matrix | src/gl-matrix、src/mat4、src/quat、src/vec3 | TS 数学 reference 和 property tests |
| wgpu-matrix | src、docs、tests | WebGPU projection、camera、uniform layout |
| ozz-animation | src/animation/runtime、src/animation/offline | animation compression、sampling、SoA 数据组织 |
| EnTT | src/entt/entity、src/entt/meta、src/entt/signal | Application World/ECS 设计参考 |

### 直接可参考的关键符号

~~~text
meshopt_buildMeshlets
meshopt_computeMeshletBounds
meshopt_optimizeVertexFetch
GPU scene record / micro-patch
HZB reduction / occlusion query
Visibility Buffer triangle ID resolve
MikkTSpace tangent generation
Filament material model and BRDF
KTX2/BasisU transcode and mip selection
glTF validator diagnostics
animation offline/runtime sampling
~~~

这些符号只是定位入口，不代表 OEngine 必须采用相同名称或 ABI。移植时必须将上游结果转换成 OEngine 自己的 schema、owner、capacity、lifetime 和 benchmark 记录。

## 20. 推荐新增的 OEngine 任务组

如果后续不想被 R1-R5 的顺序限制，可以增加以下任务组：

| 任务组 | 目标 | 主要参考 |
|---|---|---|
| REF-01 | 上游源码、许可证、commit 和测试登记 | 全部参考项目 |
| ABI-01 | TS/WGSL schema generator、offset、stride、version | Bevy、AnKi、The Forge |
| COOK-11 | meshoptimizer/Draco/KTX2/MikkTSpace cooker 集成 | meshoptimizer、KTX、Draco、Mikk |
| WORLD-11 | GPU resident instance/geometry/material page manager | Nanite、AnKi、Unity |
| WORK-11 | WebGPU hardware work consumer 决策和原型 | AnKi、The Forge、Vulkan MDI |
| VIS-11 | Visibility Buffer key/depth/resolve reference | JCGT、The Forge、Bevy |
| RES-01 | geometry/texture streaming、coarse fallback、eviction | Nanite、KTX、3D Tiles |
| MAT-11 | Filament/glTF PBR parity 和 material feature cost | Filament、glTF Sample Viewer |
| FX-13 | GI/RT/ReSTIR/Falcor algorithm prototype | Falcor、ReSTIR |
| VERIFY-01 | 上游对照、CPU reference、GPU micro、C 场景 gate | MOC、Scthe、The Forge |

这些任务组可以和 R1-R5 交叉，但每个交叉点必须有唯一 owner 和明确 ABI，不允许平行产生两套最终 runtime。
