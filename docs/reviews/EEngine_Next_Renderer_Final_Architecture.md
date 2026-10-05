---
id: reviews/eengine_next_renderer_final_architecture
state: history
---
对，这次重新看完**最新提交的文档 + 真实源码 + 与上一版的 diff** 后，我认为方向应该更加明确：

> **仍然直接砍掉当前 Renderer 的 ownership，单路径重建。**
>
> 但是这次我们能更准确地区分：
>
> **哪些是“当前 Renderer 架构”，应该删；哪些是“底层已经验证正确的技术资产”，应该直接抽出来进入新 Renderer。**

而且最新提交让我对之前那版 Direct Rebuild 有几处重要修正。不是改回渐进迁移，而是让“直接砍掉重来”更干净。

------

# 一、先说我重新审完最新版本后的总判断

最新提交虽然增加了不少 Next 设计相关东西，但**生产 Renderer 本质上还没有切换架构**。

当前真实 production path 仍然是：

```
Renderer
    │
    └── extends MainRenderPipeline
                   │
                   ├ Scene Publication
                   ├ Geometry Residency
                   ├ Visibility
                   ├ Sparse Shading
                   ├ CSM
                   ├ GTAO
                   ├ SSGI
                   ├ SSR
                   ├ GI
                   ├ Temporal
                   ├ NSS
                   ├ Bloom
                   ├ Exposure
                   ├ Debug
                   └ Presentation
```

而且：

```
MainRenderPipeline.ts
≈ 5927 lines
```

它依然是整个 Renderer 的超级 composition root。

所以现在其实是一个**非常适合直接砍掉的时间点**。

再继续沿当前：

```
拆一点 MainRenderPipeline
→ OptionalFrameFeatures
→ 再拆一点 owner
→ 保持 behavior
→ 慢慢抽 Product
```

走下去，我反而觉得不划算。

------

# 二、最新提交里有几项“过渡性工作”，我现在建议停止继续投资

最新新增了：

```
BoundedGpuWorkProtocol.ts
OptionalFrameFeatures.ts

Opaque Surface Product Plan
TemporalHistoryRegistry 改进
Sparse Shading Program Cache 生命周期改进

ADR-0019
render-product-work-history-v1
next-renderer.md
workstream
source ledger
```

这里面不是全部都要删。

但要非常清楚：

> **“最近刚写的”不代表“属于最终架构”。**

------

# 三、最新代码里的东西，我现在分成三类

## 第一类：直接保留技术资产

这些已经和最终架构基本同方向。

### GPU Scene / Geometry

```
GpuRenderWorld
Geometry Product
Virtual Geometry
Geometry Page Residency
Geometry Streaming
GPU Hierarchy
```

保留。

------

### GPU Visibility 主链

```
HierarchicalWorkGenerator
MeshletWorkCandidate
MeshletBucketRaster
PackedVisibilityPass
VisibilityKey ABI
HZB
Current-HZB Late Recheck
```

保留。

这是现在 EEngine 最成熟、最正确的部分之一。

------

### FrameGraph Core

保留：

```
FrameGraph
CompiledFrameGraph
Transient resource lifetime
Pass dependency
Pass pruning
Resource ownership
```

但以后不再让它承担 Renderer 策略。

------

### 当前 explicit gradient 数学

这个是重新读代码后必须修正我前面一个说法的地方：

**你现在实际上已经实现了 Compute Material 的 perspective-correct analytic gradients。**

当前 `sparse_shading_resolve.ts` 已经有：

```
bary.weights
bary.ddx
bary.ddy

uv_dx
uv_dy

textureSampleGrad 类显式采样
```

也就是说：

> “Compute Shading derivatives”不是一个从零建设项了。

Next 应该：

**把这套数学抽出来成为新的 Surface Reconstruction 基础能力。**

不要重写丢掉。

------

# 四、第二类：思想值得保留，但代码 ownership 要重写

这个是最新提交真正有价值的地方。

## `BoundedGpuWorkProtocol`

这个文件现在只有 83 行左右，本质是：

```
producer
consumer
element ABI
capacity
counter semantics
overflow
indirect execution
buffer limit
```

的 CPU-side preflight。

它证明了一个正确思想：

> MeshletWork 和 ShadingWork 可以共享控制协议，但不应该共享一个万能物理 Queue ABI。

这非常对。

但是它还远远不是：

```
GPU Work Runtime
```

所以：

```
BoundedGpuWorkProtocol
```

不要围绕当前接口继续膨胀。

直接把**思想移植**到新的：

```
Work Runtime
```

里面。

------

# 五、`TemporalHistoryRegistry` 也是类似

最新提交已经改进了：

```
begin / commit / abort
ping-pong
dimensions
lighting identity
representation revision
preExposure generation
preExposure multiplier
feature-specific invalidation
```

这些生命周期管理是有价值的。

所以不要从零丢掉。

但当前 Registry 仍然明显带着：

```
整个 Frame Feature topology
```

的历史。

而真正 Next Temporal Fabric 需要：

```
stable surface identity
local invalidation
geometry/material revision
lighting dependency
shadow dependency
representation dependency
exposure dependency
motion/disocclusion
```

所以我的建议是：

> **抽走 TemporalHistoryRegistry 的 lifecycle 机制，重新建设 Temporal Fabric。**
>
> 不保留它现在的 public contract。

------

# 六、Program Cache 与 Revision-local Binding 的分离应该保留

最新 Sparse Shading 代码已经开始把：

```
device-lifetime compiled program
```

和：

```
scene/publication revision-local binding
```

分开。

这是一个非常正确的改动。

这个原则应该直接进入 Next：

```
Program Identity
=
Shader
Layout
Capability
Kernel Specialization
```

而不是：

```
Scene Revision
Texture Generation
Instance Revision
```

后者只进入 binding/publication。

这个值得保留。

------

# 七、第三类：我建议直接删除，不继续演进

这里比较重要。

------

## 1. `MainRenderPipeline`

直接删除 ownership。

不是继续拆。

------

## 2. `MainFrameFeatureTopology`

现在仍然是：

```
shadows
ssr
gtao
ssgi
temporal
bloom
auto exposure
motion blur
sharpen
...
```

然后生成：

```
enabledFeatureBits
```

这正是我们要摆脱的：

> Algorithm / Effect-first Renderer。

Next 不应该再围绕这个结构继续演进。

直接删除。

------

# 八、`OptionalFrameFeatures` 我建议删除

这个是最新提交刚加的。

但它本质做的是：

```
把 AO
SSGI
Reflection
Post
Pyramid
Debug
```

从 MainRenderPipeline 的字段里包进一个 object。

这属于：

> **整理旧架构**

而不是：

> **建立 Next 架构。**

既然你已经明确：

> 直接砍掉重来。

那这个类没有必要继续投资。

------

# 九、当前 `FramePlan` 也不是我们要的 Render Product Compiler

当前 FramePlan 大致还是：

```
scene-update
optional LPV
main-view-graph
```

这种 frame stage scheduling。

这和我们真正需要的：

```
Consumer Demand
→ Semantic Products
→ Provider Selection
→ Representation Plan
→ Execution Domain
→ FrameGraph Lowering
```

不是同一个东西。

所以：

> 当前 `FramePlan.ts` 不要继续往 Product Compiler 上补。

直接重新设计。

------

# 十、`OpaqueShadingDemand / compileOpaqueSurfaceProductPlan` 也应该重写

这个是最新提交里一个不错的 proof。

现在已经可以表达：

```
Normal
→ materialized / absent

Diffuse
→ materialized / absent

Velocity
→ materialized / absent

Environment IBL
→ fused / deferred / absent
```

这个思想是对的。

但它目前仍然被这些东西绑死：

```
GTAO
SSGI
SSR
Brick4
Probe Volume
debugView
GpuOpaqueShadingDemand
GPU_SHADING_OUTPUT_DEPENDENCY
当前 Surface attachment layout
```

所以如果继续在这里扩：

```
recompute
cache
coarse
history
provider
...
```

最后只是把新的 Product Compiler 塞回旧 effect topology。

我的判断：

> **这个文件的经验保留，代码不保留。**

新的 Product Compiler 从新的 Semantic Product schema 开始。

------

# 十一、`FrameProducts.ts` 也是“保留思想，重写 schema”

当前已经有很好的东西：

```
VisibilityFrame
MeshletWorkFrame
ShadingBinFrame
DirectLightingFrame
TemporalReconstructionFrame
...
```

但是后半部分又出现大量当前 effect-stack 强绑定：

```
ScreenSpaceDiffuseGtaoFrame
ScreenSpaceDiffuseSsgiFrame
LongRangeDiffuseProvider
ReflectionCorrectionFrame
...
```

这说明：

> Semantic Product 思想已经正确出现，但 schema 仍然被当前算法污染。

Next 应该重新做。

------

# 十二、当前这些 Feature / Service，我建议全部判定为 Legacy

包括：

```
AOService
ScreenSpaceDiffuseService
ReflectionService
GIService
ShadowFeatureManager
TemporalFeature
```

以及它们下面的：

```
GtaoPass
SsgiPass
ScreenSpaceReflectionsPass
SpecularCorrectionPass
PackedCsmShadowPass
TemporalAntiAliasingPass
TemporalClassificationPass
NeuralSuperSamplingPass
LongRangeDiffuseProviderPass
OpaqueLightingResolvePass
ScreenSpaceDiffuseResolvePass
```

不要继续改造成 Next Provider。

直接：

> **删除，然后从选定 upstream 按新 Contract 重建。**

------

# 十三、所以我现在认为：前一版 Direct Rebuild 还不够激进

前一版是：

```
新 owner 成熟
↓
替换旧 owner
↓
删除
```

这仍然有一点“保持生产 Renderer 连续完整”的味道。

既然你现在再次明确：

> **直接砍。**

我会进一步改成：

# **Feature Completeness Can Temporarily Regress**

也就是说：

第一刀之后：

```
没有 AO
没有 SSR
没有 SSGI
没有 TAA
没有 Shadow
没有 Bloom
```

都没关系。

只要新的核心主链：

```
Scene
→ Visibility
→ New Surface
→ Basic Lighting
→ Present
```

是干净的。

然后一个个把正式算法迁回来。

这比：

```
旧 GTAO 挂着
↓
新 Product Compiler 适配旧 GTAO
↓
以后再 XeGTAO
```

干净得多。

------

# 十四、我现在建议第一刀甚至直接改 `Renderer.ts`

当前：

```
export class Renderer extends MainRenderPipeline
```

这个继承结构应该直接消失。

新的：

```
Renderer
    │
    ├ RendererRuntime
    ├ SceneRuntime
    ├ VisibilityRuntime
    ├ SurfaceRuntime
    ├ LightTransport
    ├ EnvironmentRuntime
    └ TemporalRuntime
```

Renderer 只是：

```
device lifecycle
resize
frame entry
submit
recovery
```

它不再继承一个 6000 行 pipeline。

------

# 十五、最新文档里也有几项需要直接推翻

这次不只是代码。

------

## ADR-0003

现在规定：

```
Renderer shell
MainRenderPipeline = sole recipe owner
```

这个跟新架构直接冲突。

应该标记：

```
Status: superseded
```

不是继续解释。

------

# 十六、ADR-0013 也必须 supersede

它现在明确写：

> 完整材质只求值一次。

以及项目当前 shading fact 甚至是：

> one complete evaluation per opaque hit

这和：

```
Adaptive Shading Frequency
2×2
4×4
Temporal Reuse
```

是结构冲突。

以后一个 opaque hit：

可能根本没有独立完整 material evaluation。

所以：

```
ADR-0013
```

的：

```
exactly-once per opaque hit
```

不能继续作为 production claim。

要正式 supersede。

------

# 十七、ADR-0015 部分保留思想，但也需要 supersede/rewrite

它的核心：

```
Visibility-native
Demand-driven Surface
不固定生产完整 GBuffer
```

是正确的。

但是它仍然绑定：

```
Sparse Shading owner
```

以及目前的 current production semantics。

新架构应该把它吸收到新的总 ADR 中。

------

# 十八、ADR-0019 本身也应该重写，而不是继续 patch

最新 ADR-0019 目前还写：

```
CSM 保留对照和必要 fallback
```

同时又写：

```
现有 sparse/direct shading 基础保留
新旧迁移与 fallback...
```

这个已经跟你现在确认的：

> **直接砍旧单路径重建**

不一致。

我的建议甚至不是继续修改 ADR-0019。

而是：

```
ADR-0019 → superseded
```

新增：

# `ADR-0020 — EEngine Next Clean-Cut Renderer Architecture`

直接把 clean-cut 规则写死。

------

# 十九、当前 workstream 也必须废掉

现在：

```
currentSlice:
  composition-and-program-lifetime
```

而任务甚至明确写：

> Split main-pipeline responsibilities and preserve behavior

这和我们现在的决定完全相反。

所以不应该继续这个 task。

直接关闭：

```
composition-and-program-lifetime
status: abandoned / superseded
```

新 workstream：

```
eengine-next-clean-rebuild
```

第一步就是：

```
Cut MainRenderPipeline
```

------

# 二十、`render-product-work-history-v1` 也不值得继续冻结

它现在是：

```
status: proposed
```

这是好事。

说明我们现在可以直接停掉。

因为它的 consumer 明确还是：

```
MainRenderPipeline.ts
FrameProducts.ts
TemporalHistoryRegistry.ts
```

而我们要砍掉这些 ownership。

它里面有很多好原则，可以抽进新的 Contract。

但不要把这个 contract 升为 frozen。

------

# 二十一、重新设计后，我还是保留六个一级模块

这个我重新看源码后依然认为是合理的。

但我稍微调整一下命名和职责。

```
EEngine Renderer
│
├ 1. Renderer Core
│
├ 2. Scene & Virtual Resources
│
├ 3. Visibility & Surface
│
├ 4. Light Transport
│
├ 5. Environment & Media
│
└ 6. Temporal & Presentation
```

比之前更干净。

------

# 二十二、Module 1：Renderer Core

它包含：

```
Frame Entry
Render Demand
Product Planning
Provider Registry
GPU Work Runtime
Budget
Telemetry
FrameGraph Lowering
Submit / Recovery
```

这里有一个我根据最新 review 特别要修正的地方：

## Render Product Compiler 不应该变成每帧万能优化器

应该明确有 **三种决策时间尺度**：

```
Asset / Material Compile Time
        │
        ▼
Material capabilities
Kernel family
Texture sampling equivalence
Frequency metadata


Publication / Config Time
        │
        ▼
Provider selection
Product topology
Physical representation candidates
Pipeline/Layout
History topology


Per-frame GPU Time
        │
        ▼
Occupancy
Actual work counts
Shading frequency
Ray work
Page demand
Probe updates
History validity
```

一句话：

> **CPU 编译“可能性”，GPU 决定“这一帧到底做多少”。**

这比我上一版设计里的“Product Compiler 可以根据 cost 每帧决定 everything”更严谨。

------

# 二十三、Product Planner 也不要做成通用 NP-hard optimizer

应该是：

```
Product
↓
finite valid plans
↓
bounded heuristic / policy selection
```

例如 Normal 不是：

```
无限可能 optimizer
```

而是：

```
Plan A: reconstruct
Plan B: materialize
Plan C: reuse existing surface product
```

然后根据明确成本/consumer 选择。

------

# 二十四、Product Contract 需要比以前更严格

最新代码和 review 让我觉得这里要加进正式设计。

每个 Product 至少描述：

```
Semantic
Coordinate / Spatial Domain
Resolution / Footprint
Filtering Semantics
Precision
Physical / Radiometric Units
Color Space
Pre-exposure
Temporal Identity
Failure / Missing Behavior
```

例如：

```
Normal
```

还必须分：

```
Geometric Normal
Shading Normal
```

不能因为名字都叫 Normal 就互换。

------

# 二十五、Module 2：Scene & Virtual Resources

这里当前代码已经很好。

保留：

```
GpuRenderWorld
Geometry Product
Virtual Geometry
Residency
Streaming
```

然后新增共享：

```
Virtual Resource Control Plane
```

最终：

```
Geometry
Texture
Shadow
Radiance
```

共享：

```
Logical Identity
Demand
Priority
Budget
Residency State
Retirement
Telemetry
```

但不共享 physical cache。

这个判断不变。

------

# 二十六、Module 3：Visibility & Surface

这里是第一大正式重写点。

但因为重新看代码，我会改变实施方式：

## 不再从零重写 Surface 数学

直接提取现有：

```
Visibility decode
Triangle reconstruction
Perspective barycentrics
Analytic ddx/ddy
UV transforms
Explicit texture gradients
Material texture bank access
```

进入新 Surface Runtime。

------

# 二十七、然后砍掉现有 `SurfaceFeature`

当前 SurfaceFeature 同时拥有：

```
classification
shading bin
output allocation
resolve
lighting
IBL
surface outputs
```

ownership 太重。

新结构变成：

```
Visibility
    ↓
Surface Reconstruction
    ↓
Material Evaluation Runtime
    ↓
Shading Frequency Planner
    ↓
Lighting Evaluation
```

而不是一个 600 多行 Feature owner 包全部。

------

# 二十八、Adaptive Shading 的设计也需要比上一版更严谨

不能：

```
roughness > 0.8
→ 4×4 shading
```

这么简单。

因为当前代码明确：

```
effective roughness
=
roughness factor
×
ORM texture roughness
```

所以：

```
factor = 1
```

并不意味着：

```
pixel roughness = 1
```

------

# 二十九、新 Frequency Classification 应分三层信息

## Coverage / Identity Frequency

来自：

```
Depth
Silhouette
Disocclusion
Motion
Surface continuity
```

------

## Material Appearance Frequency

来自：

```
Texture metadata
Normal-map frequency
Albedo variation
Roughness range
Emissive
Alpha / special material
```

------

## Lighting Frequency

来自：

```
Shadow discontinuity
Specular lobe
Local light gradients
Reflection variance
GI variance
```

然后综合决定：

```
Full
2×2
4×4
Reuse
```

------

# 三十、不要先完整执行 Material 再决定要不要降频

这也是很重要的新调整。

如果：

```
先 full-res texture sample
先完整 normal map
先完整 roughness
```

然后：

```
发现可以 coarse
```

那省不了多少。

所以应该：

```
Material Compile / Publication
↓
生成 Conservative Frequency Metadata
```

加上：

```
cheap geometric / temporal classifier
```

先决定 candidate。

真正 expensive material evaluation 后置。

------

# 三十一、ADR-0013 exactly-once 应该改成新的语义

未来不再是：

```
One Full Material Evaluation
Per Opaque Hit
```

而是：

> **Every visible sample receives a valid reconstructed shading result.**

结果可以来自：

```
Full evaluation
Coarse evaluation
Spatial reconstruction
Temporal reuse
```

这是根本改变。

------

# 三十二、Module 4：Light Transport 也要直接砍旧

当前这些：

```
AOService
ReflectionService
ScreenSpaceDiffuseService
GIService
ShadowFeatureManager
```

全删。

不做 adapter。

------

# 三十三、Shadow：还是直接 VSM，不保留 CSM fallback

最新文档重新把：

```
CSM fallback
```

加回来了。

根据你刚刚重新确认：

> 直接砍。

我建议再次去掉。

实现 VSM 过程中如果 shadow 还没完成：

```
Physical Sun
→ 暂时无 shadow
```

都可以。

不要为了 feature completeness 把 CSM 留进新 architecture。

Git 里有完整旧 CSM。

------

# 三十四、但最新 review 对 VSM 有一个非常重要的提醒要保留

不能：

```
Main Camera Visible Meshlets
→ 直接拿去 VSM
```

因为：

> Screen-off caster 仍然可能给 screen-visible receiver 投影。

因此 VSM 应该复用：

```
GPU Scene
Hierarchy
VG
Meshlet generation
```

但必须从：

```
Light-space / page receiver demand
```

产生独立 caster work。

这是正确边界。

------

# 三十五、VSM 迁移源仍然是 Timberdoodle

最新已经固定：

```
Ipotrick/Timberdoodle
1987cf3...
```

重点迁：

```
mark required pages
allocate
invalidate
free wrapped
dirty hierarchy
sampling
```

但：

```
DispatchMesh
BDA
Daxa pointer model
```

全部换成 EEngine：

```
Compute Work Generation
+
Storage Buffer Indirection
+
Hardware Indirect Raster
```

------

# 三十六、AO 依然选 XeGTAO

这个没必要重新发明。

完整移植：

```
Prefilter Depth
GTAO Main
Denoise
```

但不要强行让它复用当前 HZB Texture。

新设计应该是：

```
DepthHierarchy semantic owner
        │
        ├ Main Visibility HZB representation
        ├ SSSR depth representation
        └ XeGTAO depth representation
```

只有真正兼容时才共享物理纹理。

这是最新 review 的一个很重要改进。

------

# 三十七、Reflection 仍然 FidelityFX SSSR

这个选择我仍然认可。

而且直接重构反而更容易。

不需要：

```
old ScreenSpaceReflectionsPass
↓
逐步改成 queue
```

直接删除，然后忠实迁：

```
Classify
↓
Ray List
↓
Indirect Args
↓
Hierarchical Trace
↓
Validation
↓
Reprojection
↓
Prefilter
↓
Temporal Resolve
```

------

# 三十八、GI 的来源我这次建议更新

这里和我们上一版设计有一个比较实质的变化。

前面我比较倾向：

```
Timberdoodle PGI
```

但最新提交已经进一步调研了：

# **Atlas Engine DDGI + Software BVH**

并且确认它不是一个只有 Hardware RT 的 wrapper。

源码确实存在：

```
software HitClosest
```

以及完整：

```
rayGen
rayHit
probeUpdate
probeState
edge copy
distance/radiance
```

所以现在我会把：

> **Atlas DDGI / Software BVH**

提升为 World GI 第一迁移候选。

Speedball 作为 WebGPU 参考。

Timberdoodle 主要负责 VSM。

------

# 三十九、GI 这里还必须把“存储”和“采样来源”分开

以前：

```
Probe / Brick GI
```

这个名字很容易让人以为有 Probe 就有 GI。

不对。

真正是：

```
World Sample Producer
        ↓
Radiance / Distance Samples
        ↓
Probe / Brick Update
        ↓
World Radiance Field
```

所以必须明确：

```
Software BVH
Raster capture
Screen injection
Future ray backend
```

谁在真正生产 world samples。

这个是 Next GI 成不成立的核心。

------

# 四十、Module 5：Environment & Media

这里最新研究反而让路线更确定了。

## Atmosphere

继续：

```
Takram
b012ad06...
```

完整迁移。

不是 Sky Effect。

是：

```
Physical Environment
```

------

# 四十一、Froxel Media 现在也有了更具体的 donor

上一版我们还没找到特别满意的开源实现。

最新 source research 找到了：

# Adria

它已有：

```
LightInjectionCS
ScatteringIntegrationCS
Texture3D history
Fog volume lifecycle
```

MIT。

所以现在：

```
Local Participating Media
```

可以以 Adria 为主迁移候选。

当然不会宣称它等于完整 Frostbite 实现。

------

# 四十二、Module 6：Temporal 这次我建议改选 FSR3 Upscaler

这是和我们上一轮一个明显变化。

上一版我推荐：

```
FSR2 2.2.1
```

因为 standalone repo 非常干净。

最新调查之后，我现在更倾向：

# **FidelityFX SDK v1.1.4 FSR3 Upscaler**

注意：

```
不是 Frame Generation
```

只是：

```
FSR3 Upscaler
```

最新 source ledger 已经固定到了：

```
c6efa6bf...
```

包含：

```
prepare inputs
prepare reactivity
luma pyramid
shading change
shading-change pyramid
reproject
accumulate
upsample
luma instability
RCAS
```

对于 Next 的：

```
Adaptive Shading
Dynamic Resolution
Reactive / Shading Change
```

契约更合适。

所以我现在会：

```
FSR3 Upscaler = primary

FSR2 = independent fallback/reference source
```

但不是运行时 fallback。

只是如果 FSR3 WebGPU 移植遇到根本障碍，我们重新做设计决定。

不把两版内部阶段混搭。

------

# 四十三、整个 Clean Rebuild 现在我会这样切

不再是之前的：

```
M1 preserve behavior
M2 ...
```

而是：

# Phase 0 — Freeze & Supersede

只做一次。

```
Tag latest current renderer
Freeze latest baseline
Freeze source ledger
```

然后文档上：

```
ADR-0003 → superseded
ADR-0013 → superseded
ADR-0015 → superseded where conflicting
ADR-0019 → superseded

render-product-work-history-v1 → abandoned
current eengine-next workstream → closed/superseded
```

新建：

```
ADR-0020 Clean-Cut EEngine Renderer
```

------

# 四十四、Phase 1 — 直接砍掉当前 Composition

不是边拆边保留。

删除：

```
MainRenderPipeline
MainFrameFeatureTopology
RenderFeatureRegistry（如果无其他必要用途）
OptionalFrameFeatures
current FramePlan
MainRenderPipelineGraphKey
```

改：

```
Renderer extends MainRenderPipeline
```

为真正新的：

```
Renderer
```

------

# 四十五、第一版新的 Renderer 甚至只需要

```
Scene
↓
GPU Scene
↓
Visibility
↓
Debug / Base Color
↓
Present
```

这就够。

没有：

```
SSR
GI
AO
Shadow
TAA
Bloom
```

完全没关系。

这是我现在认为最干净的一刀。

------

# 四十六、Phase 2 — 新 Surface / Material / Shading

直接构建：

```
VisibilityKey
↓
Surface Decode
↓
Material Program
↓
Shading Frequency
↓
Compute Shading
↓
Basic Direct Lighting
```

把现有：

```
analytic gradient
PBR math
texture binding
material packing
```

按需要抽过来。

不是引用旧 SurfaceFeature。

------

# 四十七、然后旧 Surface / Sparse Shading owner 直接删除

包括：

```
SurfaceFeature
SparseShadingResolvePass
Sparse shading candidate transitional owners
OpaqueShadingDemand
旧 FrameProducts Surface contracts
```

保留的数学/ABI已经搬到新 owner。

------

# 四十八、Phase 3 — Environment + Temporal

然后一次性接：

```
Takram Physical Environment
+
FSR3 Upscaler / Temporal Fabric
```

这时候才开始恢复 AAA 基础画面。

------

# 四十九、Phase 4 — Light Transport

按：

```
VSM
XeGTAO
SSSR
Screen GI
Atlas DDGI
```

逐个完整 port。

但是每个都是新 Product/Work/Temporal contract 上的 Provider。

不是旧 Feature 的替换 wrapper。

------

# 五十、Phase 5 — Virtual Resource + Media

再完成：

```
Shadow Page
Texture Page
Radiance Field
Geometry Page
```

统一 control plane。

以及：

```
Adria-derived Froxel Media
```

------

# 五十一、我会把最新提交中的新代码这样处理

| 最新新增/修改                   | 新结论                                   |
| ------------------------------- | ---------------------------------------- |
| `BoundedGpuWorkProtocol`        | **抽思想进新 Work Runtime**              |
| `OpaqueSurfaceProductPlan`      | **删除实现，保留 bounded-plan 思想**     |
| `TemporalHistoryRegistry`       | **抽 lifecycle 逻辑进 Temporal Fabric**  |
| Sparse program cache separation | **保留原则与可复用代码**                 |
| `OptionalFrameFeatures`         | **直接删除**                             |
| 当前 `FramePlan`                | **直接删除**                             |
| `MainFrameFeatureTopology`      | **直接删除**                             |
| `FrameProducts`                 | **重新定义 semantic schema**             |
| `SurfaceFeature`                | **抽数学后删除 owner**                   |
| `SparseShadingResolvePass`      | **抽 gradient/PBR/采样代码后删除 owner** |
| old AO/SSGI/SSR services        | **全部删除**                             |
| CSM                             | **删除，不保留 Next fallback**           |
| old TAA/NSS                     | **删除**                                 |
| old GIService                   | **删除**                                 |

------

# 五十二、这次还有一个重要调整：不要建 `renderer-next/`

因为你明确不兼容旧 Renderer。

所以代码里不需要：

```
render-next/
RendererNext.ts
NextSurfaceRuntime
```

最后留下这些脏名字。

直接把最终目录设计成：

```
render/
├ runtime/
├ scene/
├ visibility/
├ surface/
├ lighting/
├ environment/
└ temporal/
```

或者更粗一点：

```
render/
├ runtime/
├ virtual/
├ visibility/
├ lighting/
├ environment/
└ temporal/
```

**它就是 Renderer。**

不是 Renderer Next 和 Legacy Renderer 并存。

------

# 五十三、所以我现在对“直接砍掉重来”的最终态度是

经过最新源码重新审查后，我比上一轮更加支持。

原因不是旧代码差，而是：

### 前半段基础已经成熟

```
GPU Scene
VG
GPU Hierarchy
Visibility
FrameGraph
```

不需要再通过旧 MainRenderPipeline 才能存在。

### 后半段旧 Effect Stack 本来就准备全部替换

```
GTAO → XeGTAO
SSR → SSSR
CSM → VSM
TAA → FSR3 Upscaler
GI → Screen + Atlas DDGI
Environment → Takram
Fog → Adria Froxel
```

那么继续维护旧 owners 的意义很小。

### 最新 M1 过渡代码会增加 sunk cost

如果现在继续：

```
OptionalFrameFeatures
FramePlan
preserve behavior
Main pipeline splitting
```

再过几次提交，旧架构和新抽象缠得更深，砍反而更贵。

------

# 五十四、我现在会把新设计核心重新浓缩成这一张

```
                         EEngine Renderer
                               │
                               ▼
                      Renderer Core
                               │
             ┌─────────────────┼─────────────────┐
             │                 │                 │
             ▼                 ▼                 ▼
       Scene Snapshot      Product Plan      Quality/Budget
             │                 │
             └────────────┬────┘
                          ▼
                    FrameGraph Lowering
                          │
                          ▼
                 GPU Work Runtime
                          │
          ┌───────────────┼────────────────┐
          │               │                │
          ▼               ▼                ▼
     Visibility       Virtual Work      Dense Work
          │
          ▼
 VisibilityKey + Depth
          │
          ▼
  Surface Reconstruction
          │
          ▼
 Material / Frequency Plan
          │
    ┌─────┼──────────┐
    ▼     ▼          ▼
  Full  Coarse     Reuse
    │     │          │
    └─────┴────┬─────┘
               ▼
          Light Transport
      ┌────────┼─────────┐
      ▼        ▼         ▼
    Direct  Indirect  Specular
      │        │         │
     VSM   Screen+DDGI   SSSR
      │        │         │
      └──────┬─┴─────────┘
             ▼
      Physical Environment
       Takram Sun / Sky
             │
             ▼
       Participating Media
             │
             ▼
        Temporal Fabric
             │
             ▼
        FSR3 Upscaler
             │
             ▼
          Presentation
```

然后横向：

```
Virtual Resource Runtime
    ├ Geometry
    ├ Texture
    ├ Shadow
    └ Radiance
```

------

# 五十五、现在最关键的不是再讨论技术名词，而是重新写“删除边界”

我认为下一步应该直接针对**这个最新提交**做一份新的：

# `EEngine Clean-Cut Rebuild Design v2`

而且这次文档不能再从旧 Final Design 改几个字。

应该直接根据这次最新源码审查重写，里面明确四张表：

1. **Keep / Extract / Rewrite / Delete**
2. **旧文件 → 新 owner 映射**
3. **ADR / Contract / Claim supersede 清单**
4. **代码切断顺序**

以及重新采用最新调研结果：

```
GPUPrefixSums
The Forge
Filament
XeGTAO
FidelityFX SSSR
Timberdoodle VSM
Atlas DDGI
Takram Atmosphere
Adria Froxel
FSR3 Upscaler
FidelityFX VRS heuristics
```

这会比我们上一版 Direct Rebuild 设计更准确，因为现在已经结合了**最新提交真实新增的代码、当前 5927 行主管线、现有 contracts，以及最新一次 upstream 调研结果**。

**核心方向不用变：直接砍。**

真正变化的是：

> **这次我们已经知道应该精准砍哪些、应该把哪些底层资产抽出来，以及最新提交中哪些刚写的新东西其实也属于应该一起砍掉的过渡代码。**
