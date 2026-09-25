<!--
Source archive: final architecture selected by the user in the shared conversation.
URL: https://chatgpt.com/share/6ab63639-d184-83e8-8994-1e3b9cd1c400
Retrieved: 2026-09-25
Body preserved verbatim. This archive does not change local ADRs or certify implementation/performance.
Review: 2026-09-25-eengine-next-final-architecture-analysis.md
-->

# EEngine Next Renderer — 最终架构设计

> **状态：Final Architecture Proposal**
>
> **目标版本：EEngine Next**
>
> **设计基线：2026-09-25 当前 EEngine GPU-Driven / Virtual Geometry / Visibility Buffer 版本**
>
> 本文不再划分“第一代 / 第二代 / 第三代”。当前版本保留在 Git 历史中，后续 Renderer 允许进行大规模架构重构，直接面向 EEngine Next 的长期最终形态设计。

---

# 0. 最终结论

EEngine Next 不再定义为“一个带 Virtual Geometry 的 WebGPU Renderer”，而定义为：

> # **Demand-Driven Virtualized Visibility Renderer**
>
> **Virtualized Scene + Render Product Compiler + GPU Work Runtime + Visibility-Driven Compute Shading + Temporal Fabric**

它的核心不是继续增加越来越多彼此独立的 Render Feature，而是把整个 Renderer 统一到以下六条原则：

1. **Visibility is Truth**  
   Opaque 世界以 `VisibilityKey + Depth` 作为核心事实，不回退为传统 Fat GBuffer。

2. **Work is Currency**  
   昂贵 GPU 工作必须显式成为 workload；只有真正需要执行的工作才进入 GPU 执行域。

3. **Shading Rate is a Decision**  
   “可见像素”不等于“必须执行一次完整 shading”。Geometry coverage、Shading frequency、Presentation resolution 可以解耦。

4. **Residency is Memory**  
   Geometry / Texture / Shadow / Radiance 均采用 logical virtualized resource 思维，共享 Residency Control Plane。

5. **Temporal is Persistent State**  
   时间不是一个 TAA Post Effect，而是 Renderer 的持久状态维度。

6. **Render Products are Semantic**  
   Normal、Velocity、Radiance、AO、Reflection 等首先是逻辑语义 Product，而不是“必然存在的一张 Texture”。

EEngine Next 的最终目标不是：

```text
Nanite
+ VSM
+ GTAO
+ SSR
+ SSGI
+ TAA
+ Fog
+ Atmosphere
```

而是形成统一的 Renderer Runtime：

```text
Semantic Demand
    ↓
Provider Selection
    ↓
Representation Decision
    ↓
Work Planning
    ↓
Residency / Cache Planning
    ↓
FrameGraph Lowering
    ↓
WebGPU Execute
    ↓
Temporal Reconstruction
```

---

# 1. 为什么当前版本需要进行 Renderer 级重构

当前 EEngine 前半段的架构方向已经基本正确：

```text
GPU Scene
→ Scene Publication
→ Virtual Geometry
→ Geometry Page Residency
→ GPU Hierarchy Traversal
→ Frustum / Cone / HZB Culling
→ GPU LOD / SSE
→ Meshlet Work Generation
→ Indirect Raster
→ VisibilityKey + Depth
→ Shading Classification
→ Sparse Compute Shading
```

真正暴露架构问题的是 **Visibility 后半段**。

`2026-09-25-rendering-lab-basic-gpu-analysis.md` 的诊断表明：

- 全览时 `Sparse Shading Resolve` 约 **0.46 ms**
- 近景完整 PBR 时约 **6.09–6.16 ms**
- Hardware Visibility 同期仅约 **0.33 ms → 0.85 ms**
- 仅材质解析约 **2.56 ms**
- 材质解析 + 直接光约 **3.41 ms**
- 完整 PBR + IBL 约 **5.83 ms**

这说明当前主要扩张成本已经不是几何可见性，而是：

```text
屏幕覆盖率上升
→ 有效 Visibility Pixel 上升
→ 每个可见像素重建 Surface
→ 每个像素执行 Material
→ Direct Lighting
→ Full IBL
```

当前 `direct-single-bin` 路径虽然属于 Sparse Shading 系统，但发射域仍接近：

```text
ceil(width / 8) × ceil(height / 8)
```

再通过 VisibilityKey 跳过无效像素。

这在远景占屏率低时有效，但当模型铺满屏幕后：

```text
几乎所有 pixel 都 valid
```

此时 early-out 已不能减少核心着色成本。

因此 EEngine Next 必须解决的不是“怎么让 Geometry 再快一点”，而是：

> **如何让 Visibility 后面的 Surface / Material / Lighting 也成为真正的 Demand-Driven Runtime。**

---

# 2. EEngine Next 顶层架构

```text
┌────────────────────────────────────────────────────────────────────┐
│                         EEngine Next Renderer                      │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│                       Scene Publication                            │
│                              │                                     │
│                              ▼                                     │
│                    Virtualized Scene Runtime                       │
│                              │                                     │
│                              ▼                                     │
│                    Render Product Compiler                         │
│                                                                    │
│        Demand → Provider → Representation → Budget → Reuse         │
│                              │                                     │
├──────────────────────────────┼─────────────────────────────────────┤
│                              │                                     │
│        GPU Work Runtime      │      Virtual Resource Runtime       │
│                              │                                     │
│   Geometry Work              │   Geometry Pages                    │
│   Shading Work               │   Texture Pages                     │
│   Reflection Work            │   Shadow Pages                      │
│   Shadow Work                │   Radiance Bricks / Probe Data      │
│   GI Work                    │                                     │
│   Media Work                 │                                     │
├──────────────────────────────┴─────────────────────────────────────┤
│                                                                    │
│                       Visibility System                            │
│                                                                    │
│     Hierarchy → LOD → Cull → Meshlet → Indirect Raster            │
│                              │                                     │
│                    VisibilityKey + Depth                           │
│                              │                                     │
├──────────────────────────────▼─────────────────────────────────────┤
│                                                                    │
│                   Surface & Shading Runtime                        │
│                                                                    │
│   Surface Reconstruction                                          │
│   Material Compiler                                               │
│   Material Classification                                         │
│   Shading Frequency Classification                                │
│   Texture Sample Deduplication                                    │
│   Dense / Sparse / Coarse / Reuse Shading                         │
│                              │                                     │
├──────────────────────────────▼─────────────────────────────────────┤
│                                                                    │
│                       Light Transport                              │
│                                                                    │
│   Direct Lighting                                                 │
│   Direct Light Visibility       → Directional VSM                 │
│   Indirect Radiance             → Screen + Probe / Brick          │
│   Specular Radiance             → SSSR + Environment Fallback     │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│                Physical Environment Lighting                       │
│                                                                    │
│   Takram Atmosphere Model                                         │
│   Physical Sun                                                    │
│   Sky Irradiance                                                  │
│   Sky Radiance                                                    │
│   Atmosphere Transmittance                                        │
│   Aerial Perspective                                              │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│                    Participating Media                             │
│                                                                    │
│   Fog / Local Volume / Particles / Future Clouds                  │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│                       Temporal Fabric                              │
│                                                                    │
│   Motion / Depth / Surface ID / Reactive / Disocclusion           │
│   Confidence / Variance / Exposure / History / Resolution State   │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│                   Reconstruction Backend                           │
│                                                                    │
│      Native Temporal / TAAU / Future Neural Reconstruction        │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│                     FrameGraph Lowering                            │
├────────────────────────────────────────────────────────────────────┤
│                             WebGPU                                 │
└────────────────────────────────────────────────────────────────────┘
```

---

# 3. Renderer 的职责边界

EEngine Next 必须把“Renderer 想要什么”“GPU 怎么执行”“资源物理放在哪里”分离。

## 3.1 Render Product Compiler

负责：

```text
What should exist?
How accurate should it be?
Who provides it?
Should it be recomputed or stored?
What execution domain should produce it?
```

---

## 3.2 GPU Work Runtime

负责：

```text
How much expensive GPU work actually exists?
How is it classified?
How is it compacted?
How is it executed indirectly?
```

---

## 3.3 Virtual Resource Runtime

负责：

```text
Which logical data is resident?
Where is the physical storage?
What should be evicted?
What must be generated / streamed?
```

---

## 3.4 Temporal Fabric

负责：

```text
Can previous-frame information be reused?
How valid is history?
Where did disocclusion occur?
How confident is the previous result?
```

---

## 3.5 FrameGraph

只负责：

```text
How do the selected kernels and resources execute this frame?
```

FrameGraph 不再承担 Renderer 的高层架构决策。

---

# 4. Render Product Compiler

这是 EEngine Next 最重要的新系统。

当前 Renderer 容易使用：

```text
needsNormal = true
needsVelocity = true
needsSurface = true
```

然后直接创建对应 Texture。

EEngine Next 改为：

```text
Consumer
↓
Semantic Product Demand
↓
Provider Resolution
↓
Representation Planning
↓
Execution Planning
↓
FrameGraph Lowering
```

---

## 4.1 Semantic Product

示例：

```text
Visibility
SurfaceNormal
SurfacePosition
SurfaceMotion
MaterialProperties
DirectRadiance
IndirectRadiance
SpecularRadiance
DirectVisibility
AtmosphericTransmittance
AerialScattering
TemporalConfidence
FinalReconstructedColor
```

这些都是逻辑 Product。

它们不等于 GPU Texture。

---

## 4.2 Representation Decision

例如 `SurfaceNormal` 可以来自：

```text
A. VisibilityKey → triangle → vertex attributes → reconstruct
B. Material shading 顺便输出
C. Tile-local shared scratch
D. Half-resolution materialized texture
E. Full-resolution transient texture
F. Temporal cache
```

Render Product Compiler 根据：

- consumer 数量
- spatial frequency
- reconstruction cost
- bandwidth
- latency
- precision
- lifetime
- temporal stability

进行选择。

---

## 4.3 基本策略

```text
Product
    ↓
Cost Model
    ↓
┌──────────────────────────┐
│ Fuse                     │
│ Recompute                │
│ Materialize              │
│ Cache                    │
│ Temporal Reuse           │
│ Tile-local               │
└──────────────────────────┘
```

例如：

| Product | 默认思路 |
|---|---|
| World Position | Depth reconstruction |
| Triangle identity | VisibilityKey |
| Barycentric | reconstruct |
| Normal | recompute / materialize based on consumers |
| Motion | recompute or materialize |
| Roughness | material output only if needed downstream |
| Base Color | generally do not persist |
| Surface Gradient | reconstruct / tile-local |
| Direct Radiance | fuse into lighting path |
| AO | semantic Indirect Visibility product |
| Reflection | semantic Specular Radiance product |

---

# 5. FrameGraph 的新定位

保留当前 FrameGraph 的正确能力：

- dependency
- imported resources
- transient resources
- lifetime
- pass culling
- topology cache
- aliasing / reuse
- scheduling
- binding
- resource transitions / logical state

但新的关系是：

```text
Render Product Compiler
        ↓
Logical Execution Plan
        ↓
FrameGraph Lowerer
        ↓
Concrete Passes / Resources
        ↓
WebGPU
```

FrameGraph 不应该决定：

```text
是否需要 Normal
是否选择 SSSR
是否选择 VSM
是否 materialize velocity
```

这些决策应该发生在它上层。

---

# 6. GPU Work Runtime

GPU Work Runtime 是 EEngine Next 最值得形成品牌辨识度的系统之一。

但它绝不能变成一个“万能 Generic Queue”。

---

## 6.1 核心原则

> # **Static Kernel Graph + Dynamic Work Streams**

由于 WebGPU 没有 DX12 Work Graph，也没有 GPU 任意生成 pipeline / descriptor state 的自由度，因此：

- CPU / FrameGraph 知道本帧有哪些 kernel family
- GPU 决定每个 kernel 需要执行多少工作

即：

```text
Static:
Classifier
Trace
Shade
Resolve
Denoise
...

Dynamic:
Meshlet count
Shading tile count
Reflection ray count
Shadow page count
GI update count
```

---

## 6.2 Work Runtime 统一什么

统一：

```text
Demand
Classification
Reservation
Compaction
Counter
Capacity
Overflow
Indirect Arguments
Budget
Priority
Telemetry
Producer / Consumer Closure
```

---

## 6.3 不统一什么

不强制统一具体 Work Record：

```text
MeshletWork
ShadingWork
ReflectionRayWork
ShadowPageWork
GIProbeWork
RadianceBrickWork
TexturePageRequest
```

它们可以具有完全不同的数据布局和执行策略。

---

## 6.4 四种 Execution Domain

不是所有系统都必须：

```text
Classify → Compact → Queue
```

EEngine Next 应支持：

### A. Dense Field

适合：

- HZB reduction
- bloom
- tone mapping
- luminance pyramid
- dense GTAO
- froxel integration
- atmosphere LUT

```text
dispatch(width / tile)
```

---

### B. Sparse WorkStream

适合：

- meshlets
- material tiles
- reflection rays
- selective GI
- expensive denoiser tiles
- special material kernels

```text
Demand
→ Classify
→ Compact
→ indirect dispatch
```

---

### C. Virtual Page / Brick Work

适合：

- Geometry Page
- Texture Page
- Shadow Page
- Radiance Brick
- Probe update

---

### D. Temporal / Cache Reuse

适合：

- VSM cached pages
- reflection history
- radiance history
- stable shading regions
- probe reuse
- environment cache

---

# 7. Virtual Resource Runtime

EEngine Next 将 Virtual Geometry、Virtual Texture、Virtual Shadow、Radiance Cache 放进一个统一控制面：

```text
Logical Resource
↓
Virtual Address
↓
Demand
↓
Priority
↓
Residency Decision
↓
Physical Storage
↓
Eviction / Update / Streaming
```

---

## 7.1 统一控制面

共享：

- logical handle
- generation / revision
- virtual address
- demand feedback
- priority
- budget
- residency state
- physical slot lifecycle
- eviction
- fence-safe retirement
- pressure metrics
- telemetry

---

## 7.2 不统一物理数据面

### Geometry

```text
Compressed page
Disk / network / CPU streaming
Multi-frame latency acceptable
```

### Texture

```text
Mip / tile sampling
Filter border
Texture cache
```

### Shadow

```text
GPU generated
Receiver driven
Same-frame urgency
Strong temporal reuse
```

### Radiance

```text
GPU synthesized
Budgeted update
Temporal convergence
Spatial cache
```

因此：

> **One Control Plane, Multiple Data Planes**

而不是一个 Universal Cache。

---

# 8. Visibility System

当前 EEngine 的 GPU Scene / Virtual Geometry / Visibility 主脊柱应坚决保留。

最终主路径：

```text
GpuRenderWorld / Scene Snapshot
        ↓
Hierarchy Roots
        ↓
GPU Traversal
        ↓
Frustum
Cone
HZB
SSE / LOD
        ↓
Cluster / Meshlet Work
        ↓
Indirect Hardware Raster
        ↓
VisibilityKey + Depth
```

---

## 8.1 VisibilityKey

VisibilityKey 仍然是 Opaque Renderer 的核心 identity contract。

推荐继续表达：

```text
Frame-local Work Identity
+
Local Primitive Identity
```

不要让 Pixel Buffer 承担大型 global scene identifier。

---

## 8.2 Hardware Raster 仍为主路径

EEngine Next 不追求“为了像 Nanite 而全 compute raster”。

WebGPU 当前缺少：

- 通用 Mesh Shader baseline
- DX12 Work Graph
- 成熟硬件 RT Pipeline
- unrestricted native bindless
- 适合所有目标平台的 64-bit atomic raster assumptions

因此：

```text
Hardware Raster = Primary
```

Selective Compute Raster 只作为：

- pathological tiny triangles
- special procedural geometry
- experimental path

而不是核心 baseline。

---

# 9. Surface & Shading Runtime

这是 EEngine Next 针对当前近景 `Sparse Shading Resolve` 成本增长的核心改造。

新的 Surface Runtime：

```text
VisibilityKey + Depth
        │
        ▼
Surface Reconstruction
        │
        ▼
Material Compiler / Metadata
        │
        ▼
Material Classification
        │
        ▼
Shading Frequency Classification
        │
        ▼
Shading Planner
        │
 ┌──────┼─────────┬─────────┬─────────┐
 ▼      ▼         ▼         ▼
Dense  Sparse    Coarse    Reuse
1x1    work      2x2/4x4   temporal/cache
 │      │         │         │
 └──────┴─────────┴─────────┘
              │
              ▼
       Compute Material
              │
              ▼
        Lighting Products
```

---

# 10. Surface Reconstruction

Opaque shading 不回传统 GBuffer。

根据 Visibility 重建：

```text
Instance
Meshlet / primitive
Triangle indices
Vertex attributes
World / view transforms
Barycentric / screen interpolation
Material reference
```

Surface Reconstruction 输出的不是永久存储结构，而是逻辑 Surface State。

---

## 10.1 Surface 数据默认不持久化

默认：

```text
Position      ← depth reconstruct
Normal        ← geometry / normal map reconstruct
UV            ← triangle attributes
Material ID   ← visibility / scene lookup
Motion        ← current + previous geometry state
```

只有 consumer demand 足够高时才物化。

---

# 11. Compute Material Derivatives

Compute Shading 长期必须原生支持 texture LOD / anisotropic filtering 所需梯度。

Fragment Shader 有天然：

```text
dpdx / dpdy
implicit texture LOD
```

Compute Shader 不应假定这一点。

因此 Surface Runtime 必须提供：

```text
Visibility
+
Projected Triangle
+
Vertex Attributes
+
Screen Position
↓
Analytic Attribute Gradient
↓
dUVdx / dUVdy
↓
textureSampleGrad
```

这是 Compute Material 能否成为完整 PBR 主路径的架构能力。

不能留到“以后 shader 优化”。

---

# 12. Material Compiler

当前 Material System 不应该继续只是 runtime PBR shader 参数集合。

EEngine Next 建议增加真正的 Material Compiler / Lowering。

职责：

```text
Material Graph / Material Description
        ↓
Feature Analysis
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

## 12.1 Texture Sample Deduplication

当前诊断已经发现 ORM / AO 可能引用同一纹理和同一 UV。

Next Material Compiler 必须比较：

```text
Texture logical handle
Sampler
UV set
UV transform
LOD policy
Channel interpretation
```

如果采样位置与 sampler contract 相同：

```text
Sample Once
→ Reuse Channels
```

而不是 AO、ORM、Roughness、Metallic 各自发起 texture sample。

---

## 12.2 Kernel Family

必须坚持：

> **Kernel Family ≠ Material Instance**

不要发生：

```text
normalMap
× clearcoat
× anisotropy
× transmission
× detailNormal
× ...
```

导致 permutation explosion。

推荐：

### Hard specialization

只区分真正改变 execution structure 的材质族：

```text
Rough Opaque
General Opaque
Complex Specular
Transmission
Special Surface
```

### Soft features

通过：

```text
flags
data
compact branch
optional sampled fields
```

表达。

---

# 13. Adaptive Shading Frequency

这是 EEngine Next 在当前设计基础上新增的一条核心原则：

> # **Shading Rate is a Decision**

Geometry 必须 full coverage 地回答：

```text
这个 pixel 看见什么？
```

但 Radiance 不一定需要 full-resolution 计算。

---

## 13.1 Shading Frequency Inputs

根据：

- material roughness
- normal variance
- depth variance
- primitive / material boundaries
- motion magnitude
- lighting variance
- specular frequency
- temporal confidence
- disocclusion
- reactive state
- screen-space projected footprint

决定 shading frequency。

---

## 13.2 可能的频率

```text
1×1 Full Rate
2×2 Coarse
4×4 Coarse
History / Cache Reuse
```

---

## 13.3 必须强制 Full Rate 的区域

- silhouette
- depth discontinuity
- material boundary
- high-frequency normal map
- mirror / low roughness specular
- disocclusion
- high motion
- reactive transparency adjacency
- strong lighting discontinuity

---

## 13.4 可以 Coarse 的区域

典型：

```text
rough dielectric
metallic ≈ 0
roughness ≈ 1
low normal variance
large stable wall / floor
low motion
stable lighting
```

这正是当前 `rendering-lab-basic` 资产暴露出来的潜在类型。

---

## 13.5 Visibility / Shading / Presentation 三种分辨率解耦

EEngine Next 应接受：

```text
Visibility Resolution
≠
Shading Resolution
≠
Presentation Resolution
```

例如：

```text
Visibility      1920×1080

Base Shading    1600×900

Rough regions   effective 800×450-like sample density

Presentation    1920×1080
```

最后由 spatial + temporal reconstruction 恢复。

这比简单整帧 Dynamic Resolution 更高级。

---

# 14. Current Sparse Shading 如何重构

当前：

```text
Full-screen tile dispatch
→ VisibilityKey early-out
→ Surface reconstruction
→ PBR
→ IBL
```

Next：

```text
Visibility
↓
Occupied Tile Classification
↓
Surface Complexity Classification
↓
Material Kernel Classification
↓
Shading Frequency Classification
↓
Compact Work
↓
Indirect Kernel Execution
↓
Edge-aware Resolve
↓
Temporal Reconstruction
```

但要保留 fast path：

如果屏幕几乎全部是同一 simple kernel，classification + compaction 成本大于收益，则可以选择：

```text
Dense Simple Kernel
```

因此 Shading Planner 必须能在：

```text
Dense
Sparse
Coarse
Reuse
```

之间切换。

---

# 15. Light Transport 顶层重构

EEngine Next 不再把：

```text
Shadow
GTAO
SSGI
SSR
```

看成 Renderer 一级系统。

顶层改为：

```text
Direct Lighting
Direct Light Visibility
Indirect Radiance
Specular Radiance
Physical Environment Lighting
Participating Media
```

具体技术是 Provider。

---

# 16. Direct Lighting

Direct Lighting 负责：

```text
Light evaluation
BRDF interaction
Direct visibility
Environment direct sun
```

它不直接拥有 Shadow System。

而是消费：

```text
DirectVisibility
```

---

# 17. Directional Shadow — 最终选型：VSM

EEngine Next 的主太阳阴影直接以：

> # **Directional Virtual Shadow Map**

为最终主路径。

当前 CSM 保留为：

```text
Fallback
Validation backend
Migration aid
Low-end profile
```

不再作为长期中心。

---

## 17.1 Directional VSM 架构

```text
Main Camera Visibility / Depth
        ↓
Receiver Analysis
        ↓
Shadow Virtual Page Demand
        ↓
Virtual Resource Runtime
        ↓
Page Residency / Cache
        ↓
GPU Work Runtime
        ↓
Virtual Geometry Traversal
        ↓
Meshlet Shadow Work
        ↓
Shadow Page Raster
        ↓
DirectVisibility Product
```

---

## 17.2 必须复用 Virtual Geometry

绝对不要形成：

```text
ShadowScene
ShadowCullSystem
ShadowMeshletSystem
ShadowStreaming
```

VSM 必须成为现有：

```text
GPU Scene
Virtual Geometry
Hierarchy Traversal
Meshlet Work
```

的另一个消费者。

---

## 17.3 VSM Cache

核心不是“超高分辨率 shadow map”，而是：

```text
Only demanded pages
+
Temporal page cache
+
Precise invalidation
```

推荐至少区分：

```text
Static / stable geometry contribution
Dynamic geometry contribution
```

避免小量动态对象让大片静态 Page 失效。

---

# 18. Indirect Radiance — Hybrid GI

EEngine Next 不以纯 SSGI 为 GI 架构。

最终：

```text
                  Indirect Radiance
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
      Near Field      World Field      Infinite
          │              │              │
   Screen-space GI   Probe / Brick    Atmosphere
                    Radiance Field      / Sky
```

---

## 18.1 Near Field

采用 Screen-space GI。

优势：

- 利用当前 Visibility / Depth / Surface
- 捕获近距离 contact GI
- 细节高
- WebGPU 友好

不足：

- off-screen 缺失
- disocclusion
- 屏幕边缘
- history dependency

因此只作为 Near Field Provider。

---

## 18.2 World Field

采用：

> **DDGI-like Probe / Brick Radiance Field**

注意是“DDGI-like architecture”，不是绑定 RTXGI。

Probe 更新 backend 可以来自：

```text
Screen injection
Raster capture
Software BVH
Surfel
Future ray query
Future neural
```

---

## 18.3 Infinite Field

直接来自：

```text
Physical Environment
→ Sky Irradiance / Sky Radiance
```

它是整个 GI 的边界条件。

---

## 18.4 Provider 输出 Contract

所有 GI Provider 不只输出 Radiance。

至少要逻辑上提供：

```text
Radiance
Confidence
Validity
Range / Distance relevance
Temporal stability
```

最后由：

```text
IndirectRadianceComposer
```

融合。

---

# 19. AO — 最终选型：XeGTAO Provider

EEngine Next 仍然推荐：

> # **XeGTAO**

但它的架构身份不是 `GtaoSystem`。

而是：

```text
IndirectVisibilityProvider
```

---

## 19.1 为什么选 XeGTAO

原因：

- compute-native
- pipeline 清晰
- 可共享 depth pyramid
- 可以使用重建 normal
- 容易嵌入 EEngine Render Product / Work Runtime
- 不需要把 CACAO 的完整 pipeline architecture 搬入引擎

基本形式：

```text
Depth / Depth Mips
↓
GTAO Evaluation
↓
Spatial Denoise
↓
IndirectVisibility
```

---

## 19.2 与 GI 的关系

当 World GI / Screen GI 成熟后：

```text
AO weight
```

应该逐步变成辅助项，而不是永久固定：

```text
FinalIndirect *= AO
```

必须避免 double darkening。

---

# 20. Specular Radiance — 最终选型：SSSR-style Reflection

EEngine Next 不再设计传统 Fullscreen SSR。

顶层：

```text
SpecularRadiance
```

Provider：

```text
ScreenTrace
Environment
Probe
Future WorldRay
Future Neural
```

---

## 20.1 Screen Provider 使用 SSSR 思路

最终流程：

```text
Specular Demand
↓
Tile Classification
↓
Pixel / Ray Classification
↓
Ray List
↓
Indirect Trace
↓
Hit Validation
↓
Hit Confidence
↓
Denoise Work
↓
Temporal Reuse
↓
Fallback Composition
```

---

## 20.2 Roughness-driven Work

```text
Mirror / very glossy
→ detailed screen ray

Medium roughness
→ sparse stochastic ray

Very rough
→ environment / GI approximation

Invalid screen hit
→ probe / sky fallback
```

避免所有 pixel 都执行同等昂贵 ray march。

---

# 21. Temporal Reconstruction — 不再以传统 TAA 为核心

EEngine Next 不把：

```text
TAA
```

作为 Renderer 最后一个 Post Effect。

改为：

> # **Temporal Reconstruction**

参考 FSR-style temporal contract，但用 EEngine 自己的 WGSL implementation / backend architecture。

---

## 21.1 输入 Contract

统一提供：

```text
Color / Radiance
Depth
Motion
Jitter
Surface Identity
Exposure
Reactive
Disocclusion
Shading Change
Confidence
Variance
Resolution State
```

---

## 21.2 Reconstruction Backend

```text
ReconstructionBackend
├ Native Temporal AA
├ Temporal Upscaling / TAAU
└ Future Neural Reconstruction
```

默认目标是：

```text
Temporal Upscaling
```

而不是“永远 full-res shading + TAA”。

---

## 21.3 Dynamic Resolution 联动

EEngine Next 的性能体系应该统一：

```text
Dynamic Resolution
+
Adaptive Shading Frequency
+
Temporal Reconstruction
```

三者由同一 Budget / Quality Controller 协作。

---

# 22. Temporal Fabric

Temporal Fabric 比 Reconstruction 更底层。

它服务：

- TAAU
- Reflection
- SSGI
- AO
- VSM stability
- Volumetric
- Radiance field
- Future Neural

---

## 22.1 统一管理

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
History Generation
History Validity
Resolution Change
Camera Cut
```

---

## 22.2 不统一滤波器

Temporal Fabric 不等于：

```text
One TemporalResolve Shader
```

Reflection、GI、Volumetric、Final Reconstruction 可以有完全不同的 temporal filter。

统一的是：

```text
Reprojection Contract
History Lifecycle
Validity
Confidence
```

---

# 23. Physical Environment Lighting — Takram non-geospatial

EEngine Next 的环境与主太阳系统采用 Takram `three-geospatial` WebGPU atmosphere 的物理模型和算法思路。

目标不是引入一个 Sky Effect。

而是建立：

> # **Physical Environment Lighting System**

---

# 24. Main Sun 不再是普通 DirectionalLight

当前类似：

```text
DirectionalLight
intensity = 2.8
+
HDR environment
```

的 Main Sun 模型应退出核心 World Lighting。

EEngine Next：

```text
PhysicalEnvironment
        │
        ├ Physical Sun
        ├ Sky Irradiance
        ├ Sky Radiance
        ├ Atmosphere Transmittance
        ├ Atmospheric Scattering
        └ Aerial Perspective
```

---

## 24.1 普通 DirectionalLight 仍保留

两种概念区分：

### World Physical Sun

来自 Atmosphere：

```text
PhysicalSun
```

用于世界主太阳。

### User Directional Light

普通：

```text
DirectionalLight
```

仍可用于：

- editor artificial light
- stylized scene
- test
- indoor directional setup
- non-physical lighting

---

# 25. Takram 迁移边界

迁移：

- Atmosphere parameters
- Bruneton-style atmosphere LUT
- Hillaire multiple scattering
- transmittance
- sky radiance
- sky irradiance
- sun direct lighting
- atmospheric scattering
- aerial perspective
- shadow-aware atmospheric lighting concepts
- environment cache update policy

不迁移：

- Three.js Node architecture
- `AtmosphereLight extends DirectionalLight` 的 OO 结构
- React / R3F integration
- geospatial scene graph
- Three renderer binding model

---

# 26. Non-geospatial World Mapping

EEngine 使用自己的 local world：

```text
World Space
Y-Up
Meter units
```

建立轻量：

```text
EEngine World
↓
Atmosphere Local Frame
```

不把：

```text
WGS84
ECEF
Geodetic transforms
```

作为 Renderer 基础依赖。

只迁移非地理场景真正需要的：

- atmosphere scale
- planet radius / ground radius model
- local observer reference
- sun direction
- camera altitude interpretation

---

# 27. Environment Products

Physical Environment 对外提供语义 Product：

```text
SunDirection
SunDirectIrradiance
SkyDiffuseIrradiance
SkyRadiance
AtmosphereTransmittance
AerialScattering
EnvironmentRadianceCache
```

这些统一供：

```text
PBR Direct Lighting
GI
Reflection
Participating Media
Aerial Perspective
```

消费。

---

# 28. IBL 重构

当前性能报告指出 IBL 是 Sparse Shading 中最值得优先调查的重成本之一。

EEngine Next 不应该简单：

```text
Every visible pixel
→ same full IBL path
```

而应该：

```text
Material Classification
+
Shading Frequency
+
Environment Product
```

协同。

---

## 28.1 建议 IBL Kernel Class

逻辑上可以存在：

```text
Diffuse / Rough Dielectric
Rough Specular
General Specular
Glossy / Mirror
Complex Material
```

例如：

```text
metallic = 0
roughness ≈ 1
```

的大面积稳定 surface，应允许进入低成本环境光路径。

---

## 28.2 Environment Cache

从 Atmosphere Sky 产生：

```text
EnvironmentRadianceCache
```

仅当：

- sun angle 变化达到阈值
- atmosphere 参数变化
- environment revision 变化

时更新。

避免每帧重新构造 environment representation。

---

# 29. Aerial Perspective

Aerial Perspective 不应只是普通 Post Effect。

在架构上定义为：

```text
AtmosphericTransport
```

输入：

```text
Scene Radiance
Depth
Atmosphere State
Sun Visibility
```

输出：

```text
Atmosphere-composited Radiance
```

未来与 Participating Media 在同一 radiometric model 下组合。

---

# 30. Participating Media

统一：

```text
Participating Media
├ Global Fog
├ Local Volume
├ Particle Medium
├ Atmospheric Medium
└ Future Clouds
```

局部体积表示采用：

> **Froxel / VBuffer-style representation**

语义：

```text
Extinction
Scattering
Emission
Phase
```

---

## 30.1 Atmosphere 与 Froxel 不强行统一物理存储

Planet-scale Atmosphere 和 local fog 尺度差异巨大。

因此：

```text
Atmosphere = global physical boundary
Froxel = local participating medium
```

在 radiance / transmittance 层组合，而不是塞进同一个 3D grid。

---

# 31. 技术选型最终表

| 领域 | EEngine Next 最终推荐 |
|---|---|
| Opaque geometry | Virtual Geometry + GPU Hierarchy |
| Visibility | VisibilityKey + Depth |
| Opaque shading | Visibility-driven Compute Shading |
| Surface data | Semantic Product / Recompute-or-Materialize |
| Shading rate | Adaptive Compute Shading Frequency |
| AA | Temporal Reconstruction |
| Upscaling | FSR-style TAAU contract / EEngine WGSL backend |
| Reflection | SSSR-style Classified Screen Reflection |
| AO | XeGTAO as IndirectVisibility Provider |
| Near GI | Screen-space GI |
| World GI | DDGI-like Probe / Brick Radiance Field |
| Infinite GI | Physical Sky / Atmosphere |
| Main Sun | Takram-derived Physical Sun |
| Shadow | Directional VSM |
| IBL | Atmosphere / Environment Radiance Cache + adaptive evaluation |
| Atmosphere | Takram WebGPU non-geospatial model |
| Aerial Perspective | Atmospheric Transport Product |
| Local Fog | Froxel Participating Media |
| Transparency | Forward+ / special forward |
| Temporal State | Renderer-wide Temporal Fabric |
| Neural | Backend slot only; not WebGPU baseline |
| Frame scheduling | Render Product Compiler → FrameGraph |
| Dynamic GPU work | GPU Work Runtime |
| Virtual memory | Virtual Resource Runtime |

---

# 32. WebGPU Native 约束

EEngine Next 必须以 WebGPU 的真实能力作为架构底线。

---

## 32.1 可以成为核心的能力

- Compute Shader
- Storage Buffer
- Atomics
- `drawIndirect`
- `drawIndexedIndirect`
- `dispatchWorkgroupsIndirect`
- `primitive_index`
- `shader-f16`
- Subgroups
- Storage Texture
- Timestamp / Query capability where available

这些足以支持：

```text
GPU Scene
GPU Work Generation
Queue / Counter
Compaction
Indirect Draw
Indirect Compute
Visibility Buffer
Compute Shading
VSM Page Work
SSSR Work
GI Update Work
```

---

## 32.2 Optimization Tier

可以利用但不能成为全部 target 的硬前提：

```text
subgroup-size-control
f16
advanced texture format tiers
future sized binding arrays
future resource tables
future WebNN interop
```

---

## 32.3 当前不要依赖

```text
Mesh Shader
DX12 Work Graph
hardware RT pipeline
native unrestricted bindless heap
multiDrawIndirectCount-style command generation
vendor neural API
64-bit atomic raster assumptions
```

所以：

> **Static Kernel Graph + Dynamic GPU WorkStream**

仍然是 EEngine Next 最合理的 WebGPU execution model。

---

# 33. Resource Binding 策略

当前 bounded material / texture residency 思路应保留其精神。

不要为了“bindless”提前设计一个 WebGPU 不稳定的架构。

上层：

```text
LogicalTextureRef
```

不变。

后端可支持：

```text
Bounded Texture Bank
Virtual Texture
Future Binding Array / Resource Table
```

Material Compiler 只依赖 logical resource identity，不依赖当前物理 binding 策略。

---

# 34. Shading Bin 策略

继续保留 bounded shading families。

但重新定义：

```text
ShadingBin
=
Kernel Family
× Resource Residency Class
× Execution Variant
```

不要变成：

```text
One Material = One Bin
```

---

## 34.1 Bin 数量约束

必须严格控制：

```text
small bounded count
```

这样 CPU 可以预先录制：

```text
Kernel0 → dispatchIndirect
Kernel1 → dispatchIndirect
...
```

GPU 只控制每个 bin 的 work count。

这是 WebGPU 下非常重要的现实优势。

---

# 35. ShadingBinId MRT 不再是永久架构

当前可继续作为一个实现路径。

但 Next Product Compiler 应支持：

```text
A. Visibility 时直接写 Material/Shading Class
B. 从 VisibilityKey 后重建
C. Tile-local classification
```

最终通过实际 GPU benchmark 决定 representation。

原则：

> 不把“当前最快的实现细节”升级成永远不变的 Renderer contract。

---

# 36. Main Frame Flow

EEngine Next 每帧的逻辑流程建议为：

```text
1. Scene Publication
        ↓
2. Scene Snapshot / Revisions
        ↓
3. Product Demand Collection
        ↓
4. Render Product Compiler
        ↓
5. Resource Residency Planning
        ↓
6. Geometry Work Generation
        ↓
7. Visibility Raster
        ↓
8. Shared Hierarchy / Pyramids
        ↓
9. Surface / Material Classification
        ↓
10. Shading Frequency Planning
        ↓
11. Direct Visibility Demand
        ↓
12. VSM Page Work
        ↓
13. Compute Material / Direct Lighting
        ↓
14. Indirect Radiance Work
        ↓
15. Specular Radiance Work
        ↓
16. Participating Media
        ↓
17. Atmospheric Transport
        ↓
18. Temporal Fabric Validation
        ↓
19. Temporal Reconstruction / Upscale
        ↓
20. Tone / Presentation
```

注意：

这不是固定“20 个 Pass”。

每一步是逻辑阶段。

Render Product Compiler 可以：

- fuse
- skip
- materialize
- recompute
- use cached result

最终 FrameGraph 可能只有部分具体 kernel。

---

# 37. Shared Data / Shared Infrastructure

下一代最大的目标之一就是避免高级效果各自重复基础工作。

---

## 37.1 Shared Depth Hierarchy

消费者：

```text
Occlusion
SSSR
GTAO
SSGI
VSM receiver analysis
Contact effects
```

统一构建、统一 contract。

---

## 37.2 Shared Surface Reconstruction

消费者：

```text
Material shading
Reflection
GI
AO
Motion
Temporal validation
```

不允许每个 effect 各写一套 triangle / normal reconstruction。

---

## 37.3 Shared Material Metadata

消费者：

```text
Shading classifier
Reflection roughness classifier
GI
Reactive mask
Shading rate
```

---

## 37.4 Shared Temporal State

消费者：

```text
TAAU
Reflection
GI
AO
Volumetric
Radiance cache
```

---

## 37.5 Shared Work Runtime

消费者：

```text
Geometry
Shading
Reflection
VSM
GI
Media
```

---

## 37.6 Shared Virtual Resource Runtime

消费者：

```text
VG
VT
VSM
Radiance Field
```

---

# 38. 当前代码：坚决保留

以下设计思想应该保留并作为 Next 基础：

```text
GpuRenderWorld / retained GPU scene
Scene Publication
Virtual Geometry
Geometry Page Streaming
Geometry Residency
GPU Hierarchy Traversal
Frustum / Cone / HZB
GPU LOD / SSE
Meshlet Work Generation
Indirect Raster
VisibilityKey
Visibility Buffer
ShadingBin
Sparse Compute Shading
FrameGraph
Dynamic Resolution
Texture logical handles
GPU generated indirect work
```

这些不是需要推翻的历史包袱。

---

# 39. 当前代码：重构升级

## MainRenderPipeline

从大型 composition/god object：

```text
feature topology
resource creation
history
shadow
GI
SSR
post
debug
```

改为：

```text
Renderer Coordinator
        ↓
Product Compiler
        ↓
Provider Registry
        ↓
FrameGraph Lowerer
```

---

## OpaqueShadingDemand

从：

```text
bool needsNormal
bool needsVelocity
...
```

升级为：

```text
Semantic Product Demand
+
Representation Cost Model
```

---

## SparseShadingResolve

从：

```text
dense dispatch + pixel early-out
```

升级为：

```text
Adaptive Shading Runtime
```

支持：

```text
Dense Simple
Sparse
Coarse
Reuse
```

---

## SSR

删除传统 effect ownership。

重构为：

```text
SpecularRadiance ScreenTrace Provider
```

采用 SSSR-style work generation。

---

## SSGI

从独立最终 GI effect 降级为：

```text
NearFieldIndirectRadiance Provider
```

---

## GTAO

改为：

```text
IndirectVisibility Provider
```

算法换为 / 参考 XeGTAO。

---

## TemporalFeature

升级为：

```text
Temporal Fabric
+
Reconstruction Backend
```

---

## Shadow System

当前 CSM 保留 fallback。

主架构重写到：

```text
DirectVisibility
+
Directional VSM Provider
```

---

## Environment / Directional Sun

当前：

```text
Main DirectionalLight + HDR IBL
```

退出默认 World Lighting 主路径。

改为：

```text
PhysicalEnvironment
+
Takram-derived Physical Sun / Sky
```

---

# 40. 当前代码：应该逐渐删除的概念

不再让以下概念成为核心 Renderer 一级接口：

```text
SSRSystem
GTAOSystem
SSGISystem
TAASystem
SkyEffect
ShadowEffect
```

这些名称可以存在于 provider implementation 层，但不能成为 Renderer architecture。

---

# 41. `rendering-lab-basic` 问题如何被 Next Architecture 解决

当前问题：

```text
Near Camera
↓
Large Screen Coverage
↓
Almost all pixels valid
↓
Full Surface Reconstruction
↓
General Material
↓
Direct Lighting
↓
Full IBL
↓
Sparse Shading Resolve ≈ dominant cost
```

---

## 41.1 Occupancy 不再等于 Full Shading

Next：

```text
Visible Pixel
↓
Shading Frequency Class
↓
1x1 / 2x2 / 4x4 / Reuse
```

因此模型铺满屏幕不再自动意味着：

```text
2M visible pixels
=
2M expensive PBR evaluations
```

---

## 41.2 Rough Dielectric Fast Path

当前诊断资产中大量：

```text
metallic = 0
roughness = 1
```

不再进入完全相同的 general IBL kernel。

Material Compiler 可以选择：

```text
Rough Opaque Kernel
```

并允许更低 shading frequency。

---

## 41.3 Texture Sample Dedup

ORM / AO 等重复 sample 可以在 Material Lowering 时消除。

---

## 41.4 Product Compiler 裁剪 Debug 无效工作

Geometry debug 如果只需要：

```text
Visibility
Depth
Meshlet ID
```

则自动删除：

```text
Sparse shading
Lighting
IBL
GI
Reflection
unused surface outputs
```

不再出现“看上去是 Meshlet Debug，但后台完整 shading 仍在跑”。

---

## 41.5 Temporal Reuse

稳定近景大面积 surface 可以利用：

```text
motion
surface identity
confidence
variance
```

减少重复 expensive shading。

---

## 41.6 Dynamic Resolution

当 GPU Budget 超限：

```text
Dynamic Resolution
+
Adaptive Shading Frequency
+
Temporal Reconstruction
```

联合控制，而不是只有单一 internalScale。

---

## 41.7 IBL 自适应

Physical Sky / Environment Radiance 根据 roughness / material class 选择成本不同的 evaluation。

---

# 42. 当前诊断中 Next Architecture 不负责解决的内容

报告中还存在：

```text
GPU ≈ 90°C
thermal slowdown active
SM clock ≈ 450 MHz
```

这是硬件热状态。

新 Renderer 可以降低持续负载，从而间接降低 thermal pressure，但不能把 thermal throttling 当成 Renderer bug。

正式性能验收必须固定：

```text
Git revision
camera matrix
render resolution
browser
GPU driver
warm-up
temperature window
clock state
sample window
P50 / P95
```

---

# 43. Virtual Texture 的定位

Virtual Texture 进入：

```text
Virtual Resource Runtime
```

但不作为当前 `Sparse Shading Resolve` 问题的解决方案。

VT 解决：

```text
Texture working set
Capacity
Streaming
Residency
Large world texture scale
```

不解决：

```text
PBR ALU
IBL samples
Surface reconstruction
Visible pixel shading count
```

---

# 44. Performance Budget Runtime

EEngine Next 可以把 Render Budget 变成一级概念：

```text
Frame Budget
        ↓
Visibility
Shading
Shadow
Reflection
GI
Media
Reconstruction
```

系统根据：

```text
importance
variance
confidence
screen coverage
motion
temporal stability
```

调整：

- shading rate
- reflection ray budget
- GI update budget
- VSM page update priority
- radiance probe updates
- dynamic resolution

不允许每个 Feature 独立“尽可能做满”。

---

# 45. GPU Telemetry

Work Runtime / Virtual Runtime 必须提供统一 telemetry：

```text
Produced Work
Executed Work
Rejected Work
Overflow
Peak Queue
Indirect Count
Page Demand
Resident Hit Rate
Eviction
Cache Reuse
History Reuse
Full-rate Shading Pixels
Coarse-rate Shading Pixels
Reused Shading Pixels
Reflection Rays
VSM New Pages
VSM Cached Pages
GI Updates
```

这让性能分析从：

```text
某 Pass 6ms
```

进一步变成：

```text
为什么是 6ms？
多少 pixel full-rate？
多少 IBL kernel？
多少 sample？
多少 history reuse？
```

---

# 46. Debug / Validation 必须成为 Product Compiler 的消费者

Debug View 不再通过“主 Renderer 正常跑完再覆盖 Color”实现。

而是：

```text
Debug Product Demand
```

例如：

```text
MeshletID View
```

只请求：

```text
Visibility
Meshlet identity
Depth
```

FrameGraph 只生成依赖闭包。

---

# 47. Provider Registry

Renderer 顶层只认语义接口。

例如：

```text
DirectVisibilityProvider
IndirectRadianceProvider
SpecularRadianceProvider
EnvironmentProvider
ReconstructionProvider
```

默认 Provider：

```text
DirectVisibility
→ DirectionalVSM

IndirectRadiance.Near
→ ScreenGI

IndirectRadiance.World
→ ProbeBrickField

IndirectRadiance.Infinite
→ PhysicalEnvironment

SpecularRadiance.Screen
→ SSSR

SpecularRadiance.Fallback
→ EnvironmentRadiance

IndirectVisibility
→ XeGTAO

Reconstruction
→ TemporalUpscaler
```

---

# 48. Suggested Source / Module Topology

这不是要求立刻使用这些具体类名，而是推荐职责边界：

```text
render/
├ core/
│  ├ RenderProduct
│  ├ RenderDemand
│  ├ ProductCompiler
│  ├ ProviderRegistry
│  └ RendererCoordinator
│
├ work/
│  ├ WorkRuntime
│  ├ WorkCounters
│  ├ WorkCompaction
│  ├ IndirectArgs
│  ├ WorkBudget
│  └ WorkTelemetry
│
├ virtual/
│  ├ VirtualResourceRuntime
│  ├ ResidencyBudget
│  ├ PhysicalCache
│  └ Feedback
│
├ visibility/
│  ├ GpuScene
│  ├ VirtualGeometry
│  ├ HierarchyTraversal
│  ├ MeshletWork
│  └ VisibilityRaster
│
├ surface/
│  ├ SurfaceReconstruction
│  ├ SurfaceGradients
│  ├ MaterialCompiler
│  ├ MaterialClassifier
│  ├ ShadingFrequency
│  └ ComputeShading
│
├ lighting/
│  ├ DirectLighting
│  ├ DirectVisibility
│  ├ IndirectRadiance
│  ├ SpecularRadiance
│  └ LightCluster
│
├ shadow/
│  └ vsm/
│
├ gi/
│  ├ screen/
│  └ radiance-field/
│
├ reflection/
│  └ screen-trace/
│
├ environment/
│  ├ atmosphere/
│  ├ physical-sun/
│  ├ sky-radiance/
│  └ aerial/
│
├ media/
│  └ froxel/
│
├ temporal/
│  ├ TemporalFabric
│  ├ History
│  ├ Reprojection
│  ├ Disocclusion
│  └ Reconstruction
│
├ graph/
│  └ FrameGraph
│
└ backend/
   └ webgpu/
```

---

# 49. 不应该做的事情

EEngine Next 明确避免：

### 1. 重回 Fat GBuffer

```text
Albedo RT
Normal RT
Roughness RT
Metallic RT
Velocity RT
...
```

作为核心 opaque architecture。

---

### 2. 所有效果各自 full-screen

```text
SSR fullscreen
SSGI fullscreen
AO fullscreen
Fog fullscreen
...
```

每个系统各建一套 pyramid / history / normal reconstruction。

---

### 3. 把所有工作都 Queue 化

Dense cheap pass 不需要为了架构“统一”付出 classification / atomic / compaction 成本。

---

### 4. 一个 Universal Virtual Cache

VG / VT / VSM / GI 共享 control plane，不共享完全相同 physical data plane。

---

### 5. 一个万能 Temporal Filter

共享 validity，不共享所有 signal 的 filter。

---

### 6. 为了追 Nanite 而完全 compute raster

Hardware Raster 仍是 WebGPU 最可靠的 primary raster path。

---

### 7. 依赖尚不存在的 WebGPU 能力

不让架构建立在：

```text
Mesh Shader
Work Graph
Hardware RT
True Bindless
GPU variable pipeline generation
```

之上。

---

### 8. 让 AI / Neural 侵入核心 Renderer Contract

只预留：

```text
ReconstructionBackend
RadianceProvider
DenoiseProvider
```

未来 WebNN / WebGPU ML 可接，但 baseline 不依赖。

---

# 50. EEngine Next 最终设计原则

可以把整个 Renderer 的技术哲学浓缩为：

## Visibility is Truth

Opaque renderer 的 primary fact 是 Visibility，不是 GBuffer。

---

## Work is Currency

昂贵工作必须先证明“确实需要执行”。

---

## Shading Rate is a Decision

可见不代表必须 full-rate expensive shading。

---

## Residency is Memory

大世界必须从 virtual address / physical residency 的角度管理 GPU memory。

---

## Temporal is Persistent State

History 是 Renderer 数据，不是 Post Effect 私有缓存。

---

## Render Products are Semantic

Normal、Radiance、Motion 首先是逻辑需求，再决定物理表现。

---

## Providers are Replaceable

SSSR、XeGTAO、VSM、ScreenGI、ProbeGI、Takram Atmosphere 都是 Provider，而不是不可替换的 Renderer architecture。

---

## WebGPU Native First

设计必须在标准 WebGPU 的 compute + storage + atomics + indirect + subgroup 模型下成立。

---

# 51. 最终 Renderer 定义

EEngine Next 的最终定义：

> **EEngine Next 是一套 WebGPU Native 的 Demand-Driven Virtualized Visibility Renderer。**
>
> 它以 Virtualized GPU Scene 和 Visibility Buffer 为几何事实基础，以 Render Product Compiler 决定每帧真正需要产生的语义结果，以 GPU Work Runtime 组织动态 workload，以 Virtual Resource Runtime 统一大规模资源 residency，以 Adaptive Shading Frequency 控制实际着色密度，并通过 Physical Environment、Virtual Shadow、Hybrid GI、Classified Reflection 与 Temporal Fabric 构建现代 AAA Light Transport。
>
> FrameGraph 只负责把这些决策 lower 成 WebGPU 可执行图；具体的 XeGTAO、SSSR、Screen GI、VSM、Takram Atmosphere、Temporal Upscaler 都只是可替换 Provider。
>
> 这使 EEngine 的优化方向不再是“给每个高级效果各写几个更快的 Pass”，而是让整个 Renderer 对 **Work、Bandwidth、Residency、Shading Frequency 和 Temporal Reuse** 进行统一调度。

---

# 52. 最终默认技术栈

```text
Scene
  GPU Scene / Scene Publication

Geometry
  Virtual Geometry
  GPU Hierarchy Traversal
  HZB / Frustum / Cone / SSE
  Meshlet Work
  Hardware Indirect Raster

Visibility
  VisibilityKey + Depth

Surface
  Deferred Attribute Reconstruction
  Compute Material
  Analytic Gradients
  Material Compiler
  Adaptive Shading Frequency

Direct Lighting
  Clustered / GPU-driven lights
  Physical Sun

Shadow
  Directional VSM
  CSM fallback

Indirect Visibility
  XeGTAO

Indirect Radiance
  Screen GI
  + Probe / Brick Radiance Field
  + Physical Sky

Specular Radiance
  SSSR-style screen tracing
  + Environment fallback
  + future world-ray backend

Physical Environment
  Takram-derived WebGPU Atmosphere
  Non-geospatial integration
  Physical Sun
  Sky Irradiance
  Sky Radiance
  Aerial Perspective

Participating Media
  Froxel / VBuffer-style local media

Temporal
  Renderer-wide Temporal Fabric

AA / Upscale
  Temporal Reconstruction / TAAU
  FSR-style semantic input contract

Resource Scale
  Virtual Resource Runtime
  VG / VT / VSM / Radiance caches

Execution
  Static Kernel Graph
  + Dynamic GPU WorkStreams

Scheduling
  Render Product Compiler
  → FrameGraph Lowering

Backend
  WebGPU
```

---

# 53. 参考资料

## EEngine 当前性能诊断

- `2026-09-25-rendering-lab-basic-gpu-analysis.md`
  - 当前 Near View 主要成本位于 Sparse Shading Resolve
  - Hardware Visibility 并非主要增量
  - IBL 是当前 shading path 中最值得优先调查的部分
  - 当前结果同时受到 thermal throttling 影响
  - 当前证据不支持用 Virtual Texture 解决这一近景性能问题

## Takram Atmosphere

- Takram Design Engineering — `@takram/three-atmosphere/webgpu`
- https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/atmosphere/WEBGPU.md
- https://takram-design-engineering.github.io/three-geospatial-webgpu/?path=/story/atmosphere-non-geospatial--non-geospatial

重点参考：

- Bruneton atmospheric scattering
- Hillaire multiple scattering LUT
- AtmosphereLight
- direct + indirect sunlight
- Sky Environment
- Aerial Perspective
- WebGPU implementation

## FidelityFX SSSR

- https://gpuopen.com/manuals/fidelityfx_sdk/techniques/stochastic-screen-space-reflections/

重点参考：

- tile classification
- ray list
- indirect intersection
- hierarchical depth traversal
- denoiser work classification

## Temporal Reconstruction / FSR

- https://gpuopen.com/manuals/fidelityfx_sdk/techniques/super-resolution-upscaler/

重点参考 semantic contract：

- depth
- motion
- jitter
- reactive mask
- transparency/composition
- exposure
- shading change
- history

## XeGTAO

- https://github.com/GameTechDev/XeGTAO

作为 EEngine `IndirectVisibilityProvider` 的默认 AO 算法参考。

## Unreal Virtual Shadow Maps

- https://dev.epicgames.com/documentation/unreal-engine/virtual-shadow-maps-in-unreal-engine

重点参考：

- virtual pages
- receiver-driven demand
- page caching
- clipmaps
- invalidation
- static / dynamic cache separation

## The Forge Visibility Buffer

- https://github.com/ConfettiFX/The-Forge

重点参考：

- Visibility Buffer
- deferred attribute interpolation
- triangle filtering
- GPU-driven visibility
- memory / bandwidth-oriented design

## WebGPU / WGSL

- https://www.w3.org/TR/webgpu/
- https://www.w3.org/TR/WGSL/

EEngine Next 必须以标准 WebGPU / WGSL 可表达能力为 baseline。

---

# 54. 一句话版本

> **EEngine Next 不再是一套“GPU-Driven Geometry + 一堆高级效果 Pass”的 Renderer，而是一套以 Visibility 为事实、以 Work 为货币、以 Shading Rate 为决策、以 Virtual Residency 为内存模型、以 Temporal State 为持久状态、以 Semantic Product 为编译目标的 WebGPU Native AAA Renderer。**
