---
id: archive/eengine_next_final_architecture_decisions_and_execution_blueprint
state: history
---
# EEngine Next Renderer
## 最终架构设计、决策记录与重构执行蓝图

> **文档状态：Final / Accepted Design**
>
> **日期：2026-09-25**
>
> **目标：EEngine Next Renderer**
>
> **执行模式：Clean Cut / Breaking Rebuild**
>
> 当前 Renderer 版本由 Git 历史保留。EEngine Next 不承担旧 Renderer 的运行时兼容职责，不保留双轨路径，不通过长期兼容层渐进切换。

---

# 目录

1. [文档目的与当前状态](#1-文档目的与当前状态)
2. [已经做出的最终决策](#2-已经做出的最终决策)
3. [当前 Renderer 的真实基础与问题](#3-当前-renderer-的真实基础与问题)
4. [EEngine Next 的最终定位](#4-eengine-next-的最终定位)
5. [核心技术哲学](#5-核心技术哲学)
6. [最终顶层架构](#6-最终顶层架构)
7. [一级模块划分](#7-一级模块划分)
8. [模块一：Renderer Runtime & Planning](#8-模块一renderer-runtime--planning)
9. [模块二：Virtualized Scene & Resources](#9-模块二virtualized-scene--resources)
10. [模块三：Visibility & Surface Shading](#10-模块三visibility--surface-shading)
11. [模块四：Light Transport](#11-模块四light-transport)
12. [模块五：Physical Environment & Media](#12-模块五physical-environment--media)
13. [模块六：Temporal Reconstruction & Presentation](#13-模块六temporal-reconstruction--presentation)
14. [GPU Work Runtime](#14-gpu-work-runtime)
15. [Virtual Resource Runtime](#15-virtual-resource-runtime)
16. [Render Product Compiler](#16-render-product-compiler)
17. [Temporal Fabric](#17-temporal-fabric)
18. [FrameGraph 的最终职责](#18-framegraph-的最终职责)
19. [AAA 技术最终选型](#19-aaa-技术最终选型)
20. [开源实现迁移策略与来源](#20-开源实现迁移策略与来源)
21. [WebGPU Native 约束](#21-webgpu-native-约束)
22. [Clean-Cut 删除与保留规则](#22-clean-cut-删除与保留规则)
23. [正式重构执行顺序](#23-正式重构执行顺序)
24. [轻量验证与性能证据策略](#24-轻量验证与性能证据策略)
25. [统一 GPU Telemetry](#25-统一-gpu-telemetry)
26. [文档系统最终组织方式](#26-文档系统最终组织方式)
27. [目前已经完成的前置工作](#27-目前已经完成的前置工作)
28. [目前尚未执行的工作](#28-目前尚未执行的工作)
29. [正式开工后的第一批动作](#29-正式开工后的第一批动作)
30. [最终定义](#30-最终定义)

---

# 1. 文档目的与当前状态

这份文档不是概念讨论稿，也不是未来路线猜想。

它统一记录三类内容：

```text
Architecture Decision
+
Execution Decision
+
Implementation Blueprint
```

即：

- EEngine Next 最终要成为哪种 Renderer；
- 哪些架构已经拍板，不再继续反复讨论；
- 哪些当前实现应该保留其技术资产；
- 哪些当前 ownership / API / 系统应该直接删除重写；
- AAA 技术采用什么默认方案；
- 哪些算法优先迁移现有开源实现；
- 迁移时哪些部分允许适配，哪些部分禁止简化；
- 文档系统如何跟随代码 ownership 切换；
- 当前已经完成了哪些前置工作；
- 正式开始代码重构时从哪里下第一刀。

本文默认：

> 当前稳定版本已经由 Git 保存，因此架构重构不需要为旧 Renderer 保持运行时兼容。

EEngine Next 可以进行：

```text
Renderer API breaking
Scene API breaking
Material API breaking
Light API breaking
Shader ABI breaking
GPU resource layout breaking
目录结构重构
模块 ownership 重构
```

目标是让最终代码足够干净，而不是让新架构长期背负旧架构。

---

# 2. 已经做出的最终决策

以下决策视为 EEngine Next 当前最终设计基线。

---

## 2.1 不再分“三代”

之前曾讨论：

```text
Generation 1
Generation 2
Generation 3
```

这一划分已经取消。

原因：

当前版本会完整保留在 Git 中，后续可以直接做大的 Renderer 重构，没有必要为了渐进升级把目标架构拆成多代并长期兼容中间状态。

现在只有：

```text
Current Renderer
↓
EEngine Next Rebuild
↓
EEngine Next
```

重构过程可以分工程切片，但它们不是三个产品世代。

---

## 2.2 采用 Clean-Cut / Breaking Rebuild

最终决定：

> **不兼容旧 Renderer，直接重构。**

禁止为了兼容创建：

```text
legacyRenderer
useNextRenderer
RendererV2
compatMaterial
deprecatedLightAdapter
oldSSR / newSSR
oldTAA / newTAA
oldShadow / newShadow
```

也禁止长期存在：

```text
if (legacy) ...
else ...
```

当 Next owner 能承担生产职责后：

```text
切 consumer
→ 删除旧 owner
→ 删除旧 shader/resource/config
→ 更新 current-fact 文档
```

旧实现需要查看时，直接看 Git 历史。

---

## 2.3 Public API 不作为兼容约束

Renderer / Scene / Material / Light 高层 API 如果阻碍新架构，可以直接改。

原则：

```text
Clean ownership
>
Preserve old call sites
```

有大量 caller 也不构成保留旧 API 的理由。

如果 API 不再适合 Next：

> 一次性修改 caller。

---

## 2.4 最终只保留一条生产 Renderer Path

EEngine Next 不采用“新旧同时运行”的长期迁移方案。

任何时刻，一个已经完成 cutover 的职责只有一个 production owner。

前后性能比较使用：

```text
Git revision
+
固定 camera
+
固定 resolution
+
固定 scene
+
截图 / GPU timing / workload evidence
```

而不是运行时切换旧 Renderer。

---

## 2.5 顶层只划分六个一级模块

最终一级模块：

```text
1. Renderer Runtime & Planning
2. Virtualized Scene & Resources
3. Visibility & Surface Shading
4. Light Transport
5. Physical Environment & Media
6. Temporal Reconstruction & Presentation
```

不继续向顶层拆成大量：

```text
ShadowSystem
SSRSystem
SSGISystem
GTAOSystem
SkySystem
TAA System
...
```

这些只允许作为算法 Provider 或模块内部实现存在。

---

## 2.6 优先迁移成熟开源算法，而不是重新造轮子

对于成熟图形算法：

```text
Open-source faithful port
>
Reimplement paper from scratch
```

不同语言不构成障碍：

```text
C++
Rust
HLSL
GLSL
TypeScript
WGSL
```

都可以作为源实现。

---

## 2.7 禁止“偷懒式迁移”

已经确定一条正式的 Upstream Porting Fidelity 原则：

如果决定迁移某实现，必须：

```text
Pin upstream revision
↓
记录 source path
↓
记录 license
↓
建立 upstream → local mapping
↓
完整理解算法 stage
↓
逐 stage 迁移
↓
基础 parity / smoke
↓
再做 EEngine-specific optimization
```

禁止：

```text
原实现 6 stage
→ 为了快先写成 2 stage

原实现有 temporal
→ 删除 temporal

原实现有 classifier
→ 换 fullscreen brute force

原实现有 cache invalidation
→ 每帧全部重建

原实现 GPU-driven
→ 改 CPU readback/list

只实现相似效果
→ 仍声称是该算法完整移植
```

---

## 2.8 WebGPU API 适配可以做，但不能改变算法语义

允许：

```text
HLSL / GLSL
→ WGSL

Buffer Device Address
→ Storage Buffer + explicit index

Mesh / Task Shader
→ Compute Work Generation
→ Indirect Hardware Raster

Native Sparse Resource
→ Manual GPU Page Table

Native Descriptor Heap
→ WebGPU Bind Groups / bounded resource table

Native Render Graph
→ EEngine Product Compiler + FrameGraph
```

这些属于 execution/backend translation。

不能借 API 差异为理由删除算法关键阶段。

---

## 2.9 测试不要过重

此次重构优先：

```text
架构正确
+
代码干净
+
算法正确
+
GPU 数据闭环
+
有基本性能证据
```

不建立庞大的测试体系。

每个大模块切片只要求：

1. TypeScript/WGSL build；
2. 一个稳定 visual/debug scene；
3. 少量关键数学或 packing oracle；
4. GPU timestamp；
5. Workload telemetry；
6. 开源迁移 source mapping / license 记录。

正式性能结论仍走项目已有验证流程。

---

# 3. 当前 Renderer 的真实基础与问题

---

## 3.1 当前已经正确的主脊柱

当前 EEngine 已经不是传统 Three.js 风格 Renderer。

其主路径已经具备：

```text
Scene / Product
↓
GpuRenderWorld
↓
Scene Publication
↓
Virtual Geometry
↓
Geometry Page Streaming / Residency
↓
GPU Hierarchy Traversal
↓
Frustum / Cone / HZB Culling
↓
GPU LOD / SSE
↓
Meshlet Work Generation
↓
Indirect Raster
↓
VisibilityKey + Depth
↓
ShadingBin
↓
Sparse Compute Shading
```

这些能力说明：

> EEngine 已经建立了正确的 GPU-driven / visibility-driven 前半段。

因此 Next 不应该为了“重构”而推翻这些核心技术资产。

---

## 3.2 当前应该坚决保留其技术思想的部分

包括：

```text
GpuRenderWorld / retained GPU Scene
Scene Publication
Virtual Geometry
Geometry Page Streaming
Geometry Residency
GPU Hierarchy Traversal
Frustum / Cone / HZB
SSE / GPU LOD
Meshlet Work Generation
Indirect Raster
VisibilityKey
Visibility Buffer
ShadingBin 思路
Sparse GPU execution 思路
FrameGraph primitives
Dynamic Resolution 基础
Texture logical handles
Indirect Work primitives
```

注意：

> “保留技术思想”不代表保留原 API、类名、目录或 ownership。

如果 Next 的模块边界需要，可以直接移动、重命名、重写接口。

---

## 3.3 当前真正的架构断点

当前前半段已经：

```text
Demand / GPU Work / Visibility
```

但后半段仍有明显 Effect Stack 倾向：

```text
SSR
→ Resolve
→ Denoise
→ Temporal

GTAO
→ Spatial
→ Temporal
→ Resolve

SSGI
→ Trace
→ Spatial
→ Temporal
→ Resolve
```

很多高级效果各自拥有：

- 自己的 full-screen work；
- 自己的 history；
- 自己的重建；
- 自己的 pyramid；
- 自己的 temporal validity；
- 自己的 feature ownership。

这与前半段 GPU-driven philosophy 不一致。

---

## 3.4 2026-09-25 rendering-lab-basic 性能诊断

当前诊断最重要的发现：

```text
Full View:
Sparse Shading Resolve ≈ 0.46 ms
Hardware Visibility   ≈ 0.33 ms

Near View:
Sparse Shading Resolve ≈ 6.09–6.16 ms
Hardware Visibility   ≈ 0.85 ms
```

Near View 的 A/B：

```text
仅材质解析 / base color        ≈ 2.56 ms
+ Direct Lighting             ≈ 3.41 ms
+ 完整 PBR + IBL              ≈ 5.83 ms
```

这说明：

> 当前近景扩张的主要成本已经从 Geometry Visibility 转移到了每可见像素的 Surface Reconstruction + Material + Direct Lighting + IBL。

因此：

```text
继续只优化 Geometry
```

不能从架构上解决问题。

---

## 3.5 当前 Sparse Shading 的核心局限

当前 `direct-single-bin` 类路径虽然属于 Sparse Shading 系统，但执行域仍接近：

```text
ceil(width / 8)
×
ceil(height / 8)
```

然后：

```text
VisibilityKey invalid
→ early out
```

远景有效，因为场景覆盖率小。

近景：

```text
almost all pixels valid
```

则：

```text
early out
≈ no longer useful
```

此时每个可见 pixel 都继续支付：

```text
triangle / attribute reconstruction
material decode
texture sample
BRDF
direct lighting
IBL
```

所以 Next 必须增加一个更深层的原则：

> **Visible Pixel ≠ Full Shading Invocation**

---

# 4. EEngine Next 的最终定位

最终定位：

> # **Demand-Driven Virtualized Visibility Renderer**

更完整：

> **Virtualized Scene + Render Product Compiler + GPU Work Runtime + Visibility-Driven Compute Shading + Virtual Resource Runtime + Temporal Fabric**

EEngine Next 不以“拥有多少高级效果”为核心。

真正核心是：

```text
什么结果需要被计算？
↓
哪个 Provider 提供？
↓
以什么表示存在？
↓
需要多少 GPU work？
↓
需要多少 residency？
↓
能不能复用 temporal/cache？
↓
最后怎么 lower 到 WebGPU？
```

---

# 5. 核心技术哲学

---

## 5.1 Visibility is Truth

Opaque Renderer 的核心事实：

```text
VisibilityKey + Depth
```

而不是传统：

```text
Albedo GBuffer
Normal GBuffer
Roughness GBuffer
Metallic GBuffer
Velocity GBuffer
...
```

Surface 数据应该尽可能从 Visibility 重建。

---

## 5.2 Work is Currency

昂贵 GPU 工作必须先成为明确 workload。

例如：

```text
Geometry Demand
→ MeshletWork

Material Demand
→ ShadingWork

Reflection Demand
→ ReflectionRayWork

Shadow Demand
→ ShadowPageWork

GI Demand
→ Probe / Brick Work
```

但不是所有东西都强制 Queue 化。

---

## 5.3 Shading Rate is a Decision

这是根据当前 Near View 性能诊断正式加入的核心原则。

```text
可见
≠
必须 full-rate shading
```

Renderer 必须能决定：

```text
1×1 Full
2×2 Coarse
4×4 Coarse
Temporal / Cache Reuse
```

Geometry coverage、Shading sampling density、Presentation resolution 可以解耦。

---

## 5.4 Residency is Memory

大规模世界资源统一用：

```text
Logical Resource
→ Virtual Address
→ Demand
→ Residency
→ Physical Storage
→ Eviction / Regeneration
```

思考。

VG / VT / VSM / Radiance Cache 共享 control plane，而不是完全独立发展。

---

## 5.5 Temporal is Persistent State

Temporal 不是：

```text
TAA Post Effect
```

而是：

```text
Renderer persistent state infrastructure
```

用于：

- TAAU
- Reflection
- GI
- AO
- Volumetric
- Radiance Cache
- Future Neural

---

## 5.6 Render Products are Semantic

例如：

```text
SurfaceNormal
SurfaceMotion
DirectRadiance
IndirectRadiance
SpecularRadiance
DirectVisibility
AerialScattering
```

首先是逻辑 Product。

物理上可以：

```text
recompute
fuse
materialize
cache
reuse
tile-local
```

---

## 5.7 Providers are Replaceable

例如：

```text
XeGTAO
SSSR
VSM
Screen GI
PGI
Takram Atmosphere
FSR2
```

都是 Provider / backend 实现。

它们不是 Renderer 顶层架构本身。

---

## 5.8 WebGPU Native First

所有设计必须在标准 WebGPU 能力下真实成立。

不能设计一个：

```text
DX12 / Vulkan Renderer
```

然后依靠低效 workaround 模拟到 WebGPU。

---

# 6. 最终顶层架构

```text
┌──────────────────────────────────────────────────────────────┐
│                     EEngine Next Renderer                    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                     Scene Publication                        │
│                            │                                 │
│                            ▼                                 │
│                  Virtualized Scene Runtime                   │
│                            │                                 │
│                            ▼                                 │
│                  Render Product Compiler                     │
│                                                              │
│      Demand → Provider → Representation → Budget → Reuse     │
│                            │                                 │
├────────────────────────────┼─────────────────────────────────┤
│                            │                                 │
│       GPU Work Runtime     │      Virtual Resource Runtime   │
│                            │                                 │
│  Geometry Work             │  Geometry Pages                 │
│  Shading Work              │  Texture Pages                  │
│  Reflection Work           │  Shadow Pages                   │
│  Shadow Work               │  Radiance Bricks / Probes       │
│  GI Work                   │                                 │
│  Media Work                │                                 │
├────────────────────────────┴─────────────────────────────────┤
│                                                              │
│                     Visibility System                        │
│                                                              │
│ Hierarchy → LOD → Cull → Meshlet → Indirect Hardware Raster │
│                            │                                 │
│                  VisibilityKey + Depth                       │
│                            │                                 │
├────────────────────────────▼─────────────────────────────────┤
│                                                              │
│                Visibility & Surface Shading                  │
│                                                              │
│ Surface Reconstruction                                      │
│ Material Compiler                                           │
│ Material Classification                                     │
│ Shading Frequency Classification                            │
│ Dense / Sparse / Coarse / Reuse Compute Shading             │
│                            │                                 │
├────────────────────────────▼─────────────────────────────────┤
│                                                              │
│                     Light Transport                          │
│                                                              │
│ Direct Lighting                                             │
│ Direct Visibility      → Directional VSM                    │
│ Indirect Visibility    → XeGTAO                             │
│ Indirect Radiance      → Screen GI + Probe/Brick + Sky      │
│ Specular Radiance      → SSSR + Environment                 │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│              Physical Environment & Media                    │
│                                                              │
│ Takram-derived Atmosphere                                   │
│ Physical Sun                                                │
│ Sky Irradiance / Sky Radiance                               │
│ Aerial Perspective                                          │
│ Froxel Local Media                                          │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                     Temporal Fabric                          │
│                                                              │
│ Motion / Depth / Identity / Reactive / Disocclusion         │
│ Confidence / Variance / Exposure / History / Resolution     │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│             Temporal Reconstruction & Presentation           │
│                                                              │
│ FSR2-derived TAAU / Reconstruction                           │
│ Dynamic Resolution                                          │
│ Tone / Presentation                                         │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                    FrameGraph Lowering                       │
├──────────────────────────────────────────────────────────────┤
│                          WebGPU                              │
└──────────────────────────────────────────────────────────────┘
```

---

# 7. 一级模块划分

只保留六个 coarse-grained first-level modules。

建议代码职责最终围绕：

```text
render/
├ runtime/
├ virtual/
├ visibility/
├ lighting/
├ environment/
└ temporal/
```

内部再根据需要分文件/目录，但不要把内部实现重新升级成十几个“一级 Renderer System”。

---

# 8. 模块一：Renderer Runtime & Planning

---

## 8.1 职责

它是 Renderer 的控制层：

```text
Render Demand
↓
Product Compiler
↓
Provider Selection
↓
Representation Decision
↓
Execution Domain Decision
↓
Work / Residency / Temporal Plan
↓
FrameGraph Lowering
```

拥有：

- Render Product Compiler
- Provider Registry
- GPU Work Runtime primitives
- frame budget
- telemetry
- Renderer Coordinator
- FrameGraph lowering

---

## 8.2 要替换的当前 ownership

重点替换当前大型 pipeline composition，例如：

```text
MainRenderPipeline
FeatureTopology
大量 feature enable/disable ownership
```

最终不能由一个 God Object 知道：

```text
SSR 有几个 Pass
GTAO 有几个 Pass
VSM 有多少 page
GI 有几个 history
```

Coordinator 只处理语义 Product 和 Provider。

---

## 8.3 实现步骤

### Step 1

直接建立：

```text
RenderProduct
RenderDemand
RenderProvider
ProviderRegistry
RendererCoordinator
```

不为旧 FeatureTopology 做 compatibility wrapper。

### Step 2

从当前 Geometry Work / Sparse Shading 中抽取已经证明可行的：

```text
counter
reservation
capacity
overflow
indirect args
```

建立 GPU Work Runtime。

### Step 3

把具体 graph construction 移到 module/provider lowering。

FrameGraph 只接收已经做好的 logical execution plan。

### Step 4

第一天就接入简单 telemetry：

```text
produced work
executed work
queue peak
overflow
history reuse
shading rate distribution
```

---

## 8.4 完成判定

模块达到初步 cutover 时：

```text
Scene
→ New Renderer Runtime
→ Visibility
→ Debug Output
```

能跑通。

随后删除旧 feature-matrix ownership。

---

# 9. 模块二：Virtualized Scene & Resources

---

## 9.1 职责

统一：

```text
Scene Publication
→ GPU Scene Snapshot
```

并建立 Virtual Resource Control Plane：

```text
Logical Resource
→ Demand
→ Priority
→ Residency
→ Physical Slot
→ Eviction / Update
```

---

## 9.2 当前保留基础

优先抽取/重构：

```text
GpuRenderWorld
Scene Publication
Virtual Geometry
Geometry Page Streaming
Geometry Residency
Texture Logical Handle
```

不保护旧 API。

---

## 9.3 Virtual Resource Control Plane

共享：

```text
Logical Handle
Generation / Revision
Virtual Address
Demand
Priority
Budget
Residency State
Physical Slot lifecycle
Eviction
Retirement
Fence Safety
Pressure
Telemetry
```

---

## 9.4 不做 Universal Physical Cache

各 Data Plane 独立：

```text
Geometry Page
Texture Page
Shadow Page
Radiance Brick
Probe Data
```

原则：

> **One Control Plane, Multiple Data Planes**

---

## 9.5 实现步骤

1. 把现有 GPU Scene / VG 重新放入 Next ownership；
2. 建统一 logical residency contract；
3. Geometry / Texture / Shadow / Radiance 分别接入；
4. 每接入一个 data plane，就删除旧 duplicated residency ownership。

---

# 10. 模块三：Visibility & Surface Shading

这是 Next 最重要、也是第一批真正性能导向的重构。

---

## 10.1 最终主路径

```text
GPU Scene
↓
Hierarchy / Cull / LOD
↓
Meshlet Work
↓
Indirect Hardware Raster
↓
VisibilityKey + Depth
↓
Surface Reconstruction
↓
Material Classification
↓
Shading Frequency
↓
Dense / Sparse / Coarse / Reuse
↓
Compute Material
```

---

## 10.2 Visibility 主脊柱继续保留

包括：

```text
GPU Hierarchy
Frustum
Cone
HZB
SSE / LOD
Meshlet Work
Indirect Raster
VisibilityKey
```

Hardware Raster 仍是 primary path。

不为了追求“更像 Nanite”强制全 compute raster。

---

## 10.3 Shared Surface Reconstruction

禁止：

```text
Material 一套 reconstruction
SSR 一套 reconstruction
GI 一套 reconstruction
AO 一套 reconstruction
Temporal 一套 reconstruction
```

统一提供：

```text
Triangle identity
Indices
Vertex attributes
Barycentric
UV
Normal / Tangent
World position
Motion
Surface identity
Material reference
```

---

## 10.4 Compute Material Gradient

必须正式解决 explicit derivatives。

路径：

```text
Visibility
+
Projected Triangle
+
Screen Position
+
Vertex Attributes
↓
Analytic Attribute Gradient
↓
dUVdx / dUVdy
↓
textureSampleGrad
```

这是 Compute Material 能否成为长期完整 PBR path 的架构能力。

---

## 10.5 Material Compiler

建立：

```text
Material Description
↓
Feature Analysis
↓
Dependency Pruning
↓
Resource Analysis
↓
Texture Sample Dedup
↓
Kernel Family Selection
↓
Soft Feature Encoding
↓
GPU Material Metadata
```

---

## 10.6 Texture Sample Dedup

比较：

```text
Texture Handle
Sampler
UV Set
UV Transform
LOD Policy
```

相同则：

```text
Sample Once
→ Reuse Channels
```

当前诊断里 ORM / AO 重复采样就是典型目标。

---

## 10.7 防止 Material Permutation Explosion

遵守：

```text
Kernel Family
≠
Material Instance
```

Hard specialization 只保留少量真正 execution 不同的家族，例如：

```text
Rough Opaque
General Opaque
Complex Specular
Transmission
Special Surface
```

其他 feature 尽量通过：

```text
flags
material data
compact branch
```

表达。

---

## 10.8 Adaptive Shading Frequency

核心分类输入：

```text
Roughness
Normal Variance
Depth Variance
Material Boundary
Primitive Boundary
Motion
Disocclusion
Lighting Variance
Specular Frequency
Temporal Confidence
Projected Footprint
```

输出：

```text
1×1 Full Rate
2×2 Coarse
4×4 Coarse
Temporal / Cache Reuse
```

---

## 10.9 Full Rate 强制区域

包括：

```text
Silhouette
Depth discontinuity
Material boundary
Mirror / low roughness
High-frequency normal
High motion
Disocclusion
Reactive region
Strong lighting discontinuity
```

---

## 10.10 Coarse 候选区域

例如：

```text
metallic = 0
roughness ≈ 1
low normal variation
large stable wall/floor
stable lighting
low motion
```

这直接对应当前 rendering-lab-basic 暴露出的高粗糙度大面积近景 shading 成本。

---

## 10.11 Dense Fast Path 必须保留

不能因为 Work Runtime 就强制所有 shading：

```text
Classify
→ Atomic
→ Compact
→ Indirect
```

如果：

```text
dense simple material
```

场景里 classification 成本更高，则直接：

```text
Dense Simple Kernel
```

执行。

最终 Shading Planner 必须能选：

```text
Dense
Sparse
Coarse
Reuse
```

---

## 10.12 实现步骤

1. 重建 visibility ownership，但保留正确 GPU-driven algorithm；
2. 建 Shared Surface Reconstruction + gradients；
3. 建 Material Compiler；
4. 建 Shading Frequency classifier；
5. 重写当前 `SparseShadingResolve` 为 Adaptive Shading Runtime；
6. lit opaque 新路径成立后，直接删除旧 shading owner。

---

# 11. 模块四：Light Transport

顶层不再以效果名组织。

最终语义：

```text
Direct Lighting
Direct Light Visibility
Indirect Visibility
Indirect Radiance
Specular Radiance
```

---

## 11.1 Direct Light Visibility

主太阳直接采用：

> **Directional Virtual Shadow Map**

不再把 CSM 作为 Next 的 runtime fallback。

---

## 11.2 Directional VSM 主路径

```text
Main Visibility / Depth
↓
Receiver Analysis
↓
Virtual Shadow Page Demand
↓
Virtual Resource Runtime
↓
Page Residency / Cache
↓
GPU Work Runtime
↓
Virtual Geometry / Meshlet Work
↓
Shadow Page Raster
↓
DirectVisibility Product
```

VSM 必须成为现有 GPU Scene / Virtual Geometry 的另一个消费者。

不要再造独立：

```text
ShadowScene
ShadowCull
ShadowMeshlet
ShadowStreaming
```

---

## 11.3 Indirect Visibility

默认：

> **XeGTAO**

顶层 identity：

```text
IndirectVisibilityProvider
```

不是：

```text
GTAOSystem
```

成熟 GI 接入后，AO 权重可以逐步减弱，避免 double darkening。

---

## 11.4 Specular Radiance

顶层：

```text
SpecularRadiance
```

默认 Screen Provider：

> **FidelityFX SSSR-style**

路径：

```text
Specular Demand
↓
Tile Classification
↓
Ray List
↓
Indirect Trace
↓
Hierarchical Depth Intersection
↓
Hit Validation
↓
Denoise
↓
Temporal
↓
Environment Fallback
```

不再使用传统 Fullscreen SSR owner。

---

## 11.5 Hybrid GI

最终：

```text
Indirect Radiance
├ Near Field
│  └ Screen GI
│
├ World Field
│  └ Probe / Brick Radiance
│
└ Infinite
   └ Physical Sky
```

---

## 11.6 GI Provider Contract

逻辑上输出：

```text
Radiance
Confidence
Validity
Range / Distance Relevance
Temporal Stability
```

再由 composer 融合。

---

## 11.7 实现步骤

1. 建 Light Transport semantic products；
2. 迁移 Directional VSM；
3. 迁移 XeGTAO；
4. 迁移 SSSR；
5. 建 Screen GI；
6. 建 Probe/Brick World Field；
7. 每个 Next owner 成熟后，直接删除旧 CSM/SSR/GTAO/SSGI production ownership。

---

# 12. 模块五：Physical Environment & Media

---

## 12.1 核心决策

默认世界环境不再是：

```text
Main DirectionalLight
+
Standalone HDR Environment
+
Sky Effect
```

而是：

> **Physical Environment Lighting**

---

## 12.2 主迁移源

使用：

> **Takram `three-geospatial` WebGPU non-geospatial atmosphere**

作为主要算法来源。

迁移：

```text
Atmosphere Parameters
Bruneton-style precomputed scattering
Hillaire multiple scattering
Transmittance
Sky Radiance
Sky Irradiance
Physical Sun
Aerial Perspective
Shadow-aware atmospheric transport where adopted
```

---

## 12.3 不迁移 Three.js ownership

不直接搬：

```text
Three.js Node
TSL ownership
React / R3F
Geospatial Scene Graph
AtmosphereLight extends DirectionalLight 的 OO 模型
```

迁移算法，重新落到 EEngine：

```text
Render Product
Provider
FrameGraph
WebGPU resources
```

---

## 12.4 Non-geospatial World

EEngine 使用自己的：

```text
Local World
Y-Up
Meter Units
```

只建立需要的：

```text
World → Atmosphere Local Frame
```

不把：

```text
ECEF
WGS84
Geodetic Scene Graph
```

引入核心 Renderer。

---

## 12.5 Environment Products

对外提供：

```text
SunDirection
SunDirectIrradiance
SkyDiffuseIrradiance
SkyRadiance
AtmosphereTransmittance
AerialScattering
EnvironmentRadianceCache
```

供：

```text
PBR
GI
Reflection
Participating Media
Aerial Transport
```

共同消费。

---

## 12.6 World Sun 与普通 DirectionalLight 分离

默认世界太阳：

```text
PhysicalSun
← PhysicalEnvironment
```

用户仍然可以创建普通：

```text
DirectionalLight
```

用于：

- 人工灯；
- editor；
- stylized scene；
- testing。

但它不再承担默认 physical sun 的职责。

---

## 12.7 IBL 重构

当前性能诊断表明 IBL 是 Near View shading path 中的重要成本来源。

Next 不再：

```text
Every visible pixel
→ same full IBL path
```

而由：

```text
Material Classification
+
Shading Frequency
+
Environment Products
```

联合决定。

例如 rough dielectric 可以进入更低成本路径。

---

## 12.8 Participating Media

Local media 采用：

> **Froxel / VBuffer-style**

统一：

```text
Global/Local Fog
Local Volume
Particle Medium
Future Cloud Participation
```

语义：

```text
Extinction
Scattering
Emission
Phase
```

Planet-scale Atmosphere 与 local Froxel 不强制共用同一物理 3D Grid。

在 radiance / transmittance 层组合。

---

# 13. 模块六：Temporal Reconstruction & Presentation

---

## 13.1 不再以传统 TAA 为中心

最终：

> **Temporal Reconstruction**

而不是：

```text
Final Color
→ TAA Post Effect
```

---

## 13.2 主迁移源

第一版 Reconstruction Backend：

> **FidelityFX FSR2 2.2.1 faithful WGSL port**

选择它的原因：

- 独立完整源码；
- MIT；
- temporal input contract 成熟；
- stage 清晰；
- 很适合定义 EEngine Temporal Fabric。

---

## 13.3 必须保留的 FSR2 核心阶段

```text
Compute Luminance Pyramid
Reconstruct / Dilate
Depth Clip
Create Locks
Reproject / Accumulate
RCAS
```

不写“简化版 FSR2”。

---

## 13.4 Temporal Fabric 输入

统一：

```text
Current Camera
Previous Camera
Jitter
Motion
Depth
Previous Depth
Surface Identity
Disocclusion
Reactive
Confidence
Variance
Exposure
Resolution State
Camera Cut
```

---

## 13.5 不做万能 Temporal Filter

Reflection、GI、Volumetric、Final Reconstruction 可以使用不同 temporal filter。

共享：

```text
History Lifecycle
Reprojection
Validity
Disocclusion
Confidence
```

不共享：

```text
One TemporalResolve Shader
```

---

## 13.6 Dynamic Resolution 联动

最终必须统一：

```text
Dynamic Resolution
+
Adaptive Shading Frequency
+
Temporal Reconstruction
```

允许：

```text
Visibility Resolution
≠
Shading Resolution
≠
Presentation Resolution
```

例如：

```text
Visibility       1920×1080
Base Shading     1600×900
Rough Regions    2×2 / 4×4 sample density
Presentation     1920×1080
```

---

# 14. GPU Work Runtime

这是 EEngine Next 最值得形成自己特色的横向基础设施之一。

---

## 14.1 固定执行哲学

> **Static Kernel Graph + Dynamic GPU WorkStreams**

CPU / FrameGraph 知道：

```text
有哪些 kernel family
```

GPU 决定：

```text
每个 kernel 需要多少 work
```

---

## 14.2 统一什么

```text
Demand
Classification
Reservation
Counter
Capacity
Overflow
Compaction
Priority
Budget
Indirect Args
Telemetry
Producer / Consumer closure
```

---

## 14.3 不统一 Domain Record

保留独立：

```text
MeshletWork
ShadingWork
ReflectionRayWork
ShadowPageWork
GIProbeWork
RadianceBrickWork
TexturePageRequest
```

不要为了 OO 漂亮强行统一成一个泛型物理布局。

---

## 14.4 四种 Execution Domain

### Dense Field

适合：

```text
HZB
Bloom
Tone Mapping
Exposure
Dense GTAO
Atmosphere LUT
Froxel Integration
```

### Sparse WorkStream

适合：

```text
Meshlet
Material Tile
Reflection Ray
Expensive Material
Selective GI
```

### Virtual Page / Brick

适合：

```text
Geometry Page
Texture Page
Shadow Page
Radiance Brick
Probe Update
```

### Temporal / Cache Reuse

适合：

```text
VSM cache
Reflection history
Stable shading
Probe history
Environment cache
```

---

# 15. Virtual Resource Runtime

统一 control plane：

```text
Logical Handle
Revision
Virtual Address
Demand
Priority
Budget
Residency
Physical Slot
Eviction
Retirement
Pressure
Telemetry
```

但：

```text
VG
VT
VSM
Radiance
```

各自保留独立物理 data plane。

---

# 16. Render Product Compiler

这是 EEngine Next 的另一个核心差异点。

它解决：

```text
Renderer 应该计算什么？
```

而 FrameGraph 只解决：

```text
这些计算怎么执行？
```

---

## 16.1 Product 是语义

例如：

```text
SurfaceNormal
SurfaceMotion
DirectVisibility
DirectRadiance
IndirectRadiance
SpecularRadiance
AtmosphereTransmittance
AerialScattering
FinalReconstructedColor
```

---

## 16.2 Product Representation

Compiler 决定：

```text
Fuse
Recompute
Materialize
Tile-local
Cache
Temporal Reuse
```

例如 Normal 不天然等于一张 full-resolution Texture。

---

## 16.3 Debug 也是 Product Consumer

例如：

```text
Meshlet ID Debug
```

只需求：

```text
Visibility
Depth
Meshlet Identity
```

那么 Product dependency closure 自动裁掉：

```text
Material Shading
Light Cluster
IBL
GI
Reflection
unused Surface Outputs
```

不再出现“看起来是 Geometry Debug，但后台完整 Shading 仍在执行”。

---

# 17. Temporal Fabric

它不是 TAA。

它是所有 temporal systems 的基础设施。

统一：

```text
Camera History
Jitter
Motion
Depth History
Surface Identity
Disocclusion
Reactive
Exposure
Confidence
Variance
History Revision
Resolution Change
Camera Cut
```

让：

```text
Reflection
GI
AO
Volumetric
TAAU
Future Neural
```

共享。

---

# 18. FrameGraph 的最终职责

保留其正确能力：

```text
Dependency
Lifetime
Transient Resource
Imported Resource
Pass Culling
Scheduling
Aliasing / Reuse
Binding
Execution Order
```

但是：

```text
FrameGraph
≠
Renderer Architecture
```

最终：

```text
Render Product Compiler
↓
Logical Execution Plan
↓
FrameGraph Lowering
↓
Concrete WebGPU Passes
```

---

# 19. AAA 技术最终选型

| 领域 | EEngine Next 默认方案 |
|---|---|
| Opaque Geometry | Virtual Geometry + GPU Hierarchy |
| Visibility | VisibilityKey + Depth |
| Opaque Shading | Visibility-driven Compute Shading |
| Surface | Deferred Attribute Reconstruction |
| Material | Material Compiler + bounded Kernel Families |
| Shading Rate | Adaptive Software Shading Frequency |
| AA | Temporal Reconstruction |
| Upscaling | FSR2-style TAAU / WGSL backend |
| Main Sun | Takram-derived Physical Sun |
| Atmosphere | Takram WebGPU non-geospatial |
| Shadow | Directional VSM |
| AO | XeGTAO |
| Near GI | Screen-space GI |
| World GI | Probe / Brick Radiance Field |
| Infinite GI | Physical Sky |
| Reflection | FidelityFX SSSR-style |
| Reflection Fallback | Environment / Probe |
| Local Volumetric | Froxel / VBuffer-style |
| Transparency | Forward+ / special forward |
| Temporal State | Renderer-wide Temporal Fabric |
| Virtual Memory | Shared Virtual Resource Control Plane |
| Scheduling | Product Compiler → FrameGraph |
| GPU Dynamic Work | GPU Work Runtime |
| Neural | Backend interface only，非 baseline |

---

# 20. 开源实现迁移策略与来源

当前已经完成一轮 GitHub / 官方开源实现筛选，并形成 source ledger。

以下为当前主来源。

---

## 20.1 Takram Atmosphere WebGPU

Repository:

```text
https://github.com/takram-design-engineering/three-geospatial
```

重点路径：

```text
packages/atmosphere/src/webgpu
packages/atmosphere/src/shaders/bruneton
packages/atmosphere/WEBGPU.md
packages/atmosphere/LICENSE
```

采用：

```text
traceable local port
```

保留：

```text
Bruneton scattering / LUT semantics
Hillaire multiple scattering
direct + indirect sunlight consistency
runtime aerial scattering
shadow-aware atmospheric transport where adopted
```

EEngine adaptation：

```text
remove Three.js Node/TSL/React ownership
geospatial frame → local Y-up world
output semantic environment products
```

License：

Takram atmosphere 目录存在文件级 MIT / BSD-style / Apache-2.0 notice，需要逐文件保持。

---

## 20.2 Timberdoodle

Repository:

```text
https://github.com/Sunset-Flock/Timberdoodle
```

License:

```text
Apache-2.0
```

主要用途：

### VSM

保留：

```text
Virtual / Physical Page Table
GPU manual allocation
Page Cache
Wraparound addressing
Dirty invalidation
HPB / hierarchical culling
```

WebGPU adaptation：

```text
BDA
→ Storage Buffer Indirection

Mesh / Task Shader
→ Compute Work Generation
→ Indirect Hardware Raster
```

### PGI

主要研究：

```text
Sparse Probe Request
Variable Update Rate
Probe Reposition
Hysteresis
Cascades
```

用于 World Radiance Field。

---

## 20.3 FidelityFX SSSR

Repository:

```text
https://github.com/GPUOpen-Effects/FidelityFX-SSSR
```

License:

```text
MIT
```

用途：

```text
SpecularRadiance / ScreenTrace Provider
```

必须保留：

```text
classification
ray workload
hierarchical intersection
denoiser dependency
temporal signal semantics
```

---

## 20.4 XeGTAO

Repository:

```text
https://github.com/GameTechDev/XeGTAO
```

License:

```text
MIT
```

必须保留：

```text
PrefilterDepths
MainPass
Depth-aware Denoise
```

映射为：

```text
IndirectVisibilityProvider
```

---

## 20.5 FidelityFX FSR2

Repository:

```text
https://github.com/GPUOpen-Effects/FidelityFX-FSR2
```

Baseline:

```text
2.2.1 tag / exact commit before port
```

License:

```text
MIT
```

必须保留：

```text
Luminance Pyramid
Reconstruct / Dilate
Depth Clip
Create Locks
Reproject / Accumulate
RCAS
```

用来替换旧 TAA/TAAU ownership。

---

## 20.6 FidelityFX SPD

Repository:

```text
https://github.com/GPUOpen-Effects/FidelityFX-SPD
```

License:

```text
MIT
```

用途：

```text
shared pyramid/downsample primitive
```

可服务：

```text
HZB
Luminance
Reflection
AO
GI
```

不是要求这些消费者共享同一 Texture，而是共享成熟 downsample runtime。

---

## 20.7 FidelityFX Variable Shading

Repository:

```text
https://github.com/GPUOpen-Effects/FidelityFX-VariableShading
```

License:

```text
MIT
```

采用：

```text
image / temporal frequency-based classification heuristics
```

不依赖 native VRS attachment。

输出：

```text
EEngine ShadingFrequencyMap
```

供 compute shading runtime 使用。

---

## 20.8 Google Filament

Repository:

```text
https://github.com/google/filament
```

参考路径：

```text
tools/matc
libs/filamat
filament/src
```

License：

选定文件以 Apache-2.0 为主，迁移前仍需按具体文件确认。

主要参考：

```text
Material feature analysis
Material compilation boundary
Dependency pruning
PBR / IBL BRDF
Material variants
```

不迁移 Filament Renderer ownership。

---

## 20.9 The Forge Visibility Buffer

Repository:

```text
https://github.com/ConfettiFX/The-Forge
```

主要参考：

```text
Visibility-driven attribute reconstruction
GPU-driven filtering
work generation
bandwidth-oriented design
```

不假设：

```text
native bindless
non-WebGPU API capabilities
```

---

## 20.10 Bevy Meshlet / WGSL

Repository:

```text
https://github.com/bevyengine/bevy
```

作为：

```text
secondary WebGPU / WGSL implementation reference
```

用于研究：

```text
visibility-buffer decode
wgpu resource integration
meshlet-related WGSL patterns
```

不直接继承其全部 capability assumptions。

---

## 20.11 WickedEngine

Repository:

```text
https://github.com/turanszkij/WickedEngine
```

MIT。

主要作为：

```text
software-ray / DDGI / Surfel GI secondary reference
```

不是第一批直接代码迁移对象。

---

## 20.12 RTXGI

Repository:

```text
https://github.com/NVIDIA-RTX/RTXGI
```

当前定位：

```text
Research only
```

原因：

- NVIDIA RTX SDK License；
- 主要依赖 DXR/Vulkan RT 类执行假设；
- 不适合作为 EEngine WebGPU primary port source。

因此：

> 不直接迁 RTXGI SDK code。

---

# 21. WebGPU Native 约束

---

## 21.1 EEngine Next Renderer Profile

当前设计固定依赖：

```text
Compute Shader
Storage Buffer
Storage Texture
Atomics
drawIndirect
drawIndexedIndirect
dispatchWorkgroupsIndirect
Subgroups
primitive_index where useful
```

---

## 21.2 Subgroups

当前 regenerated Next design 已经固定：

> **Subgroups 是 EEngine Next renderer profile 的 required capability。**

不为了兼容不支持 subgroup 的旧设备维护第二套完整 Renderer 路径。

---

## 21.3 shader-f16

作为：

```text
precision / storage / ALU optimization
```

使用。

不为 f16/non-f16 创建两个架构。

---

## 21.4 不依赖

当前架构不以以下能力为前提：

```text
Mesh Shader
DX12 Work Graph
Hardware RT Pipeline
Native Unrestricted Bindless Heap
multiDrawIndirectCount
64-bit atomic raster assumptions
```

因此仍坚持：

```text
Static Kernel Graph
+
Dynamic GPU WorkStreams
```

---

# 22. Clean-Cut 删除与保留规则

---

## 22.1 可以提取 / 重写

```text
GpuRenderWorld concepts
Virtual Geometry
Geometry Page Streaming
Hierarchy Traversal
Frustum / Cone / HZB
SSE / LOD
Meshlet Work
VisibilityKey
FrameGraph primitives
Texture logical handles
Indirect work primitives
```

---

## 22.2 不受保护

可以直接删改：

```text
MainRenderPipeline
FeatureTopology
current class names
constructor signatures
resource layout
old Renderer API
old Scene API
old Material API
old Light API
old shader ABI
old file hierarchy
old effect ownership
```

---

## 22.3 旧效果 ownership

Next replacement 成熟后，删除：

```text
old CSM main-sun owner
old SSR system
old GTAO system
old SSGI system
old TAA/TAAU owner
old standalone HDR-world-environment ownership
```

---

## 22.4 什么 fallback 可以保留

只有产品算法本身需要的 fallback。

例如：

```text
SSSR miss
→ Environment fallback
```

可以。

但：

```text
VSM incomplete
→ old CSM
```

属于迁移 fallback。

不保留。

---

# 23. 正式重构执行顺序

这不是“多代演进”，而是一个 Next Rebuild 内的工程切片。

---

## Slice A — Freeze Evidence + Pin Upstream

目标：

只做必要的破坏式重构前证据冻结。

需要：

```text
当前 Git revision/tag
rendering-lab-basic near/far fixed camera
固定 render resolution
基础 screenshot
GPU pass timing
基础 workload telemetry
```

同时为主要 upstream 固定：

```text
repository
exact commit/tag
source path
license
local target
algorithm stages
```

---

## Slice B — Cut Renderer Runtime

直接建立六个 Next module root 和：

```text
RenderProduct
RenderDemand
Provider
ProductCompiler
GpuWorkRuntime
TemporalFabric contract
RendererCoordinator
FrameGraph Lowering
```

然后先跑通：

```text
Scene
→ New Runtime
→ Visibility
→ Debug Output
```

不要求旧完整最终画面继续存在。

一旦新 visibility frame 成立：

> 删除旧 FeatureTopology / Main pipeline ownership。

---

## Slice C — Replace Surface & Shading

建立：

```text
Shared Surface Reconstruction
Explicit Gradients
Material Compiler
Material Classification
Shading Frequency
Dense / Sparse / Coarse / Reuse
Compute Material
```

最终形成新的 lit opaque output。

然后：

> 删除旧 SparseShadingResolve production ownership。

这是最先针对当前 Near View shading bottleneck 的主要切片。

---

## Slice D — Replace Temporal + Physical Environment

同时推进：

```text
FSR2 Temporal Reconstruction
+
Takram Physical Environment
```

完成后删除：

```text
old TAA/TAAU owner
old independent history ownership
default main DirectionalLight world-sun ownership
standalone HDR world-environment ownership
```

---

## Slice E — Replace Light Transport

接入：

```text
Directional VSM
XeGTAO
SSSR
Screen GI
Probe / Brick World GI
```

每个 Next owner 完成时立即删除对应旧系统。

---

## Slice F — Virtual Resource + Media

完成：

```text
Virtual Resource Control Plane
VG/VT/VSM/Radiance data-plane integration
Froxel Local Media
```

---

## Slice G — Final Cleanup

强制搜索清理：

```text
legacy
deprecated
compat
old
fallback
FeatureTopology
dead shader
dead bind group
dead history
dead resource layout
obsolete debug switches
```

确认最终源码只剩一个 Renderer ownership。

---

# 24. 轻量验证与性能证据策略

---

## 24.1 每个大切片的最低要求

```text
1. TypeScript / WGSL Build
2. One stable debug/visual scene
3. Focused correctness oracles
4. GPU timestamp
5. Workload telemetry
6. Upstream source/license mapping
```

---

## 24.2 需要重点 oracle 的区域

包括：

```text
Visibility decoding
Surface gradient reconstruction
Work queue capacity / overflow
VSM virtual/physical page mapping
VSM invalidation
Temporal reprojection
Disocclusion
FSR locks/history
Probe/Brick addressing
Residency retirement
```

---

## 24.3 不建立重型测试体系

不强制：

```text
几十个 integration tests
大量 screenshot snapshots
复杂 GPU farm
庞大 benchmark matrix
```

重构期目标是保证高风险数学和 ownership 正确，而不是让 CI 成为主要工程成本。

---

# 25. 统一 GPU Telemetry

Next 必须从一开始就能回答：

> GPU 到底在做多少工作？

至少建议提供：

```text
Meshlet Work Count
Visible Pixel Count

Full-rate Shading Pixels
2×2 Coarse Regions
4×4 Coarse Regions
Reused Shading Regions

Material Kernel Distribution
Texture Sample / Residency Statistics

Reflection Ray Count

VSM Requested Pages
VSM New Pages
VSM Cached Pages
VSM Invalidated Pages

GI Probe / Brick Updates

Virtual Resource Hit Rate
Eviction / Pressure

History Reuse
History Rejection

Queue Peak
Queue Overflow
```

目标是让未来性能分析从：

```text
Pass = 6 ms
```

升级为：

```text
为什么是 6 ms？
```

---

# 26. 文档系统最终组织方式

此前项目文档已经做过一次去重复整理，因此此次没有再建立新的：

```text
docs/next/
docs/future/
docs/new-renderer/
```

平行文档宇宙。

最终沿用：

```text
docs/domains/
    当前 production code facts

docs/adr/
    已批准长期架构决策

docs/contracts/
    稳定执行规则 / invariants

docs/porting/
    迁移计划和 upstream → local mapping

docs/sources/
    source / revision / license ledger

project/workstreams/active/
    当前正在执行的工程状态

docs/reviews/
    dated diagnosis / audit
```

---

## 26.1 当前 facts 与 Next design 分离

重要规则：

```text
docs/domains
=
当前代码已经是什么
```

而：

```text
ADR / workstream / porting
=
已经批准但可能尚未全部实现的 Next 设计
```

只有当新 owner 真正 production cutover 后：

> 才更新对应 `docs/domains` current fact。

---

## 26.2 Clean-Cut 后文档也不保留 legacy history

当新 owner 接管：

```text
更新 current domain doc
→ 删除旧事实
```

旧历史通过 Git 查看。

不会为了“文档兼容”继续留旧 architecture explanation。

---

# 27. 目前已经完成的前置工作

这里必须区分：

> **已经在本次对话生成的工作区 / 打包工程中完成**
>
> 与
>
> **已经真正写入你的本地 Git 仓库**

目前后者尚不能由当前会话直接确认。

---

## 27.1 已完成：Architecture Selection

已经完成并确定：

```text
EEngine Next
=
Clean-Cut Demand-Driven Virtualized Visibility Renderer
```

以及六模块结构。

---

## 27.2 已完成：Compatibility Decision

已经明确：

```text
No legacy compatibility layer
No dual renderer
No deprecated wrapper
Breaking public APIs allowed
No main-sun CSM runtime fallback
```

这是当前最重要的工程决策之一。

---

## 27.3 已完成：性能问题定位

已经将：

```text
2026-09-25-rendering-lab-basic-gpu-analysis.md
```

作为当前基线诊断依据。

结论已经影响最终架构：

```text
Shading Rate is a Decision
```

正式进入核心原则。

---

## 27.4 已完成：Upstream Research 第一轮筛选

已经确定主要开源迁移来源：

```text
Takram Atmosphere
Timberdoodle VSM / PGI
FidelityFX SSSR
XeGTAO
FidelityFX FSR2
FidelityFX SPD
FidelityFX Variable Shading
Google Filament
The Forge
Bevy
WickedEngine secondary reference
RTXGI research-only
```

---

## 27.5 已完成：Upstream Porting Fidelity Contract

已经形成：

```text
docs/contracts/upstream-porting.md
```

用于约束：

- pin source；
- license；
- faithful stage migration；
- 禁止偷懒简化；
- WebGPU adaptation 边界。

---

## 27.6 已完成：Renderer Clean-Cut Contract

已经形成：

```text
docs/contracts/renderer-cutover.md
```

明确：

```text
single production path
delete on replacement
breaking API allowed
Git evidence instead of runtime old/new switch
```

---

## 27.7 已完成：Architecture ADR

已经生成：

```text
docs/adr/0019-eengine-next-renderer.md
```

用于记录最终 architecture decision。

---

## 27.8 已完成：Porting Plan

已经生成：

```text
docs/porting/eengine-next-renderer.md
```

和详细 Direct Rebuild Design。

---

## 27.9 已完成：Source Ledger

已经生成：

```text
docs/sources/eengine-next-renderer.yaml
```

其中已经记录：

- repository；
- current revision placeholder；
- source path；
- license；
- adoption type；
- retained invariants；
- EEngine adaptation。

---

## 27.10 已完成：Active Workstream

已经生成：

```text
project/workstreams/active/eengine-next-renderer.yaml
```

目前记录状态：

```text
state: active
currentSlice: freeze-and-cut
```

已记录的 completed milestones：

```text
architecture-selection
upstream-research
compatibility-decision
```

---

## 27.11 已完成：Domain Routing 调整

在生成的文档工程包中，相关 domain manifests 已接入：

```text
upstream-porting
renderer-cutover
ADR-0019
Next source / workstream context
```

目的：

让后续 context routing 能同时看到：

```text
Current Facts
+
Accepted Next Decision
+
Porting Rules
+
Clean-Cut Rules
```

但不把尚未实现的 Next 误当 current fact。

---

## 27.12 已完成：文档包和工程包生成

本次前置阶段已经生成过：

```text
EEngine_Next_Direct_Rebuild_Design.md
EEngine_Next_Direct_Rebuild_Docs.zip
EEngine-master_Next-Direct-Rebuild.zip
EEngine_Next_Direct_Rebuild_Changes.txt
```

这些是对上传工程副本的设计/文档落地结果。

需要强调：

> 当前会话不能自动证明这些改动已经提交到你的真实本地 `EEngine` Git 仓库。

正式开工前应由你/执行代理把最终文档应用到实际工作分支，并提交一个 pre-refactor documentation commit。

---

# 28. 目前尚未执行的工作

以下不是架构未决定，而是实际工程执行尚未完成。

---

## 28.1 尚未完成：Exact Upstream Revision Pin

source ledger 中多个来源当前仍是：

```text
pin-before-port
```

正式移植前必须固定 exact commit/tag。

尤其：

```text
Takram
Timberdoodle
SSSR
XeGTAO
SPD
Variable Shading
Filament
```

FSR2 已经确定以：

```text
2.2.1
```

为基线，但仍需记录 exact commit。

---

## 28.2 尚未完成：Current Baseline Freeze

需要真正把：

```text
rendering-lab-basic Near Camera
Far Camera
Render Resolution
Screenshots
GPU Timing
Basic Workload Metrics
```

固定到仓库/validation artifact 中。

目前已有诊断报告，但还不是完整 freeze package。

---

## 28.3 尚未完成：实际源码 Clean-Cut

当前还没有正式执行：

```text
删除旧 MainRenderPipeline ownership
建立 Next module roots
切 production path
```

这应该是正式代码重构第一刀。

---

## 28.4 尚未完成：Upstream Source Vendor / Mapping

目前只是 source selection。

真正移植时仍需建立类似：

```text
Upstream file/function
→
EEngine local file/function
```

的一对一 mapping。

---

## 28.5 尚未完成：Surface/Shading Rewrite

当前最大的性能相关重构尚未真正进入代码：

```text
Shared Surface
Material Compiler
Adaptive Shading Frequency
```

---

## 28.6 尚未完成：Takram / FSR2 / VSM / SSSR / XeGTAO / PGI 代码迁移

当前都属于：

```text
selected
+
documented
```

但还没有完成真实 WGSL/WebGPU port。

---

# 29. 正式开工后的第一批动作

正式代码实施时，不再讨论兼容方案。

按以下顺序直接执行。

---

## Action 1 — 建立真实工作分支和 pre-refactor commit

确认当前稳定 revision。

把最终：

```text
ADR
Contracts
Porting Plan
Source Ledger
Workstream
Baseline Diagnosis
```

提交到真实 Git 仓库。

这将是 Next 重构的文档起点。

---

## Action 2 — Pin 第一批 upstream

首先固定：

```text
Takram
Timberdoodle
XeGTAO
FidelityFX SSSR
FidelityFX FSR2
FidelityFX SPD
FidelityFX Variable Shading
Filament
```

exact revision。

更新：

```text
docs/sources/eengine-next-renderer.yaml
```

---

## Action 3 — Freeze rendering-lab-basic

加入固定：

```text
near view
far view
resolution
camera transform
basic screenshots
timing
workload
```

不需要复杂 benchmark farm。

---

## Action 4 — 创建六个 Next Module Root

直接建立新的 ownership 边界。

不必等所有实现准备好。

---

## Action 5 — 建 Renderer Runtime Skeleton

先建立真实：

```text
RenderProduct
RenderDemand
RenderProvider
ProductCompiler
ProviderRegistry
GpuWorkRuntime
TemporalFabric
RendererCoordinator
```

---

## Action 6 — 让新路径先跑 Visibility Debug Frame

目标不是第一天恢复旧完整画面。

目标：

```text
Scene
→ GPU Scene
→ Geometry Work
→ Visibility
→ Debug Output
```

通过新的 Next Runtime。

---

## Action 7 — 删除旧 Frame Composition Ownership

一旦新路径拥有 frame：

```text
删除旧 FeatureTopology/MainRenderPipeline production ownership
```

不要留下 runtime switch。

---

## Action 8 — 立即进入 Surface/Shading Rewrite

这是重构后第一个真正高价值目标：

```text
Visibility
→ Shared Surface
→ Material Compiler
→ Shading Frequency
→ New Compute Shading
```

因为它直接解决当前 Near View bottleneck 的架构根源。

---

# 30. 最终定义

EEngine Next 最终定义为：

> # **WebGPU Native Demand-Driven Virtualized Visibility Renderer**

它不是：

```text
GPU-driven Geometry
+
一组高级 Post Effects
```

而是一套统一的 GPU Runtime：

```text
Virtualized Scene
↓
Semantic Render Demand
↓
Render Product Compiler
↓
GPU Work / Residency / Temporal Planning
↓
Visibility
↓
Adaptive Surface & Compute Shading
↓
Light Transport Providers
↓
Physical Environment / Media
↓
Temporal Reconstruction
↓
FrameGraph Lowering
↓
WebGPU
```

其核心技术哲学为：

> **Visibility is Truth**  
> Opaque 世界以 VisibilityKey + Depth 为事实基础。

> **Work is Currency**  
> 昂贵 GPU 工作必须显式生成并接受预算。

> **Shading Rate is a Decision**  
> 可见 pixel 不等于 full-rate expensive shading。

> **Residency is Memory**  
> 大规模 Renderer 的 GPU memory 以 virtual residency 管理。

> **Temporal is Persistent State**  
> History 是 Renderer 基础设施，不是 Effect 私有缓存。

> **Render Products are Semantic**  
> Normal、Motion、Radiance 首先是逻辑需求，再决定物理表示。

> **Providers are Replaceable**  
> VSM、XeGTAO、SSSR、FSR2、Takram Atmosphere、PGI 是实现 Provider，而不是顶层 Renderer architecture。

> **WebGPU Native First**  
> 所有核心设计必须建立在 WebGPU 真正可高效实现的模型上。

最后，EEngine Next 的代码形态应该是：

```text
EEngine Next
│
├ Renderer Runtime & Planning
├ Virtualized Scene & Resources
├ Visibility & Surface Shading
├ Light Transport
├ Physical Environment & Media
└ Temporal Reconstruction & Presentation
```

而当前旧 Renderer：

```text
不再存在于生产源码 ownership 中
```

只保留在：

```text
Git History
+
Frozen Baseline Evidence
```

这就是本次 EEngine Next Renderer 重构的最终设计和执行基线。

---

# 附录 A：最终技术选择速查

```text
Geometry
  Virtual Geometry
  GPU Hierarchy
  Meshlet Work
  Indirect Hardware Raster

Visibility
  VisibilityKey + Depth

Surface
  Shared Deferred Attribute Reconstruction
  Explicit Compute Gradients

Material
  Material Compiler
  Filament-inspired PBR/compiler reference
  Texture Sample Dedup
  bounded Kernel Families

Shading
  Dense / Sparse / Coarse / Reuse
  FidelityFX Variable Shading heuristics adapted to software frequency

Shared Pyramids
  FidelityFX SPD

Shadow
  Directional VSM
  Timberdoodle primary port source

AO
  XeGTAO

Reflection
  FidelityFX SSSR

Near GI
  Screen GI

World GI
  Timberdoodle PGI-inspired Probe / Brick

Infinite GI
  Physical Sky

Environment
  Takram WebGPU non-geospatial atmosphere
  Physical Sun
  Sky Irradiance
  Sky Radiance
  Aerial Perspective

Local Media
  Froxel / VBuffer

Temporal
  Renderer-wide Temporal Fabric

Reconstruction
  FidelityFX FSR2 2.2.1 faithful WGSL port

Execution
  Static Kernel Graph
  + Dynamic GPU WorkStreams

Resource Scale
  Shared Virtual Resource Control Plane

Scheduling
  Render Product Compiler
  → FrameGraph Lowering

Backend
  WebGPU
```

---

# 附录 B：当前工作状态速查

```text
[Done] Final architecture selected
[Done] No-generation decision
[Done] Clean-cut / breaking rebuild decision
[Done] No compatibility / no dual renderer decision
[Done] Six-module split
[Done] rendering-lab-basic diagnosis incorporated
[Done] Adaptive Shading Frequency added to core architecture
[Done] Upstream open-source research round 1
[Done] Main technology selections
[Done] Upstream fidelity contract designed
[Done] Renderer cutover contract designed
[Done] ADR / workstream / source ledger / porting docs generated in packaged workspace
[Done] Documentation routing design updated in packaged workspace

[Pending] Apply/commit final docs to real local Git branch
[Pending] Pin exact upstream revisions
[Pending] Freeze near/far benchmark camera + artifacts
[Pending] Create Next source module roots
[Pending] Cut old Renderer composition ownership
[Pending] Rewrite Surface/Shading runtime
[Pending] Port Takram atmosphere
[Pending] Port FSR2
[Pending] Port Directional VSM
[Pending] Port XeGTAO
[Pending] Port SSSR
[Pending] Implement Hybrid GI
[Pending] Finish Virtual Resource control plane
[Pending] Add Froxel local media
[Pending] Final legacy source cleanup
```
