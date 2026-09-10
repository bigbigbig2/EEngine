# OEngine Performance Architecture V2 — 实施顺序与迁移计划

> 面向当前 EEngine / OEngine 下一轮性能架构重构。
> 目标：优先获得结构级性能收益，同时保持高级游戏级渲染能力；允许使用 2026 年较新的 WebGPU 能力；成熟算法优先采用/移植开源实现；验证体系保持轻量，不让测试本身成为主要开发成本。

---

## 0. 总原则

这一轮不是“逐个 Pass 做微优化”，而是把整个运行时数据流重新设计为：

```text
Source Assets
    ↓
Asset Cook / Compression
    ↓
Compact Runtime Data
    ↓
GPU Residency
    ↓
Meshlet Visibility
    ↓
Compute Shading
    ↓
Compact Surface / HDR
    ↓
Adaptive Effects
    ↓
Temporal Reconstruction
    ↓
Fused Post
    ↓
Present
```

核心原则：

1. [WebGPU 2026 Desktop](../WEBGPU.md) 作为主要性能路径，Portable 路径作为同一逻辑 ABI 的兼容 fallback。
2. 成熟算法优先使用开源项目/库，只自研真正和 OEngine 架构强绑定的部分。
3. Importer 可以通用，Runtime GPU Format 必须专用且紧凑。
4. 减少 Work Amplification、显存带宽和重复数据解码优先于单个 Shader 微优化。
5. 完整材质语义尽量只执行一次。
6. 低分辨率、Temporal Reuse、共享派生资源和 GPU Work Queue 要作为主管线能力。
7. 验证分 DEV / MILESTONE / PERF 三档，不要求每次改动都跑完整 Benchmark。
8. 不要求某个小模块单独带来固定百分比 FPS 提升才值得做。
9. 重大阶段完成后再做完整性能比较。

---

# 1. 总实施顺序

```text
Sprint 0
WebGPU 2026 Desktop Capability Profile
+ 简化 Validation
+ Performance Baseline
+ Frame Products V2
        ↓
Sprint 1
Three.js SSAO
+ Three.js SSR
+ Temporal Reprojection
+ Recurrent Denoise
        ↓
Sprint 2
Texture / Asset Pipeline V2
        ↓
Sprint 3
Compact Geometry
+ Instance ABI V2
        ↓
Sprint 4
Meshlet GPU Frontend V2
        ↓
Sprint 5
Material / Compute ShadeLighting V2
        ↓
Sprint 6
Shared Derived Products
+ AO / SSR 正式接入
+ History / Resolution
        ↓
Sprint 7
Temporal / DRS / PreExposure
+ Post Fusion
        ↓
Sprint 8+
Transparency / GI / Virtual Texture / VSM / Volumetric / Software VRS
```

---

# 2. Sprint 0：WebGPU 2026 Desktop Capability Profile

主性能路径优先依赖：

```text
core-features-and-limits
subgroups
shader-f16
primitive-index
indirect-first-instance
texture-formats-tier1
timestamp-query

Desktop:
texture-compression-bc
```

建议逐步利用：

```text
Immediate Data: setImmediates + immediateSize + maxImmediateSize + immediate_address_space
Transient Attachments: GPUTextureUsage.TRANSIENT_ATTACHMENT
subgroup-size-control
texture-component-swizzle
texture-compression-unaligned
```

截至 2026-09-10，`subgroups`、`primitive-index`、`subgroup-size-control` 已是 `GPUFeatureName`；Immediate Data 与 Transient Attachments 已合入 core API，但不是 feature name，必须分别按 API/WGSL/limit 暴露探测。`texture-compression-unaligned` 已进入 2026-09 GPUWeb 编辑草案，但要先升级本地类型并验证目标浏览器。`bindless`、`sized-binding-arrays`、`subgroup-matrix`、`view-instancing` 等 Draft 能力不得进入生产依赖。

## 2.1 primitive-index

目标：

```text
MeshletWork Slot
+
primitive_index
        ↓
VisibilityKey V2
```

推荐：

```text
draw / drawIndexedIndirect
firstInstance = MeshletWorkSlot

Fragment:
instance_index  → MeshletWorkSlot
primitive_index → localTriangle
```

为删除普通路径的 per-triangle RasterWork / ExactRasterWork 做准备。

## 2.2 subgroups

适合：

```text
Hierarchy queue compaction
Meshlet queue append
Material classification
Visible pixel compaction
SSR ray queue
Transparency queue
Prefix / reduction
```

WebGPU 2026 Desktop：

```text
subgroup ballot / prefix / compact
↓
少量 global atomic
```

Portable fallback：

```text
workgroup shared memory + atomic
```

共用同一逻辑 ABI，不做两套 Renderer。

## 2.3 shader-f16

优先用于：

```text
AO
SSR
Denoise
Temporal weights
Roughness
Metalness
Normal intermediate
部分 HDR intermediate
Bloom / Post
```

暂时保持 f32：

```text
World Position
Large-world Transform
HZB Depth
Bounding Volume
Critical Visibility Math
Shadow comparison critical values
```

## 2.4 Immediate Data

逐步替代极小 UBO / writeBuffer：

```text
frameIndex
passIndex
resolution
mipIndex
featureFlags
near/far
small pass constants
```

主要价值是降低 Tiny Uniform Buffer、Dynamic Offset、BindGroup plumbing 与频繁 writeBuffer 的复杂度。

## 2.5 Transient Attachments

适合：

```text
仅当前 render pass 使用的 temporary attachment
MSAA scratch
resolve 后不再读取的 attachment
临时 color/depth scratch
```

不适合后面仍会被 HZB/AO/SSR/Temporal 读取的资源。

---

# 3. Sprint 0：简化验证体系

不再要求每次提交都运行：

```text
npm ci
全量 test
完整 Rendering Lab
三轮 Benchmark
大量 GPU readback
严格截图 hash
完整 memory budget
```

## DEV

普通改动只要求：

```text
1. typecheck
2. Playwright + 本地 Chrome 跑 1 个相关场景
3. 无 pageerror / console.error / GPUValidationError / device lost
4. 需要时保存 canvas screenshot
```

目标耗时：20~30 秒以内。

截图默认只作为人工观察证据，不做 pixel-perfect gate。

## MILESTONE

一个 Sprint / 大 Phase 完成时：

```text
build / npm test
+
2~4 个相关 browser scenarios
+
关键截图
```

## PERF

只在以下情况运行完整 Rendering Lab：

```text
大型性能阶段开始前
大型性能阶段完成后
正式发布性能结论
重大性能回归
```

开发期：

```text
1 次 warmup
+ 1~2 次 measurement
```

正式声明性能提升时再做 3 independent runs + median + 固定 Chrome/GPU/分辨率/workload。

---

# 4. Sprint 0：Performance Truth

至少补齐：

```text
CPU frame P50 / P95 / P99
GPU Frame Envelope
Geometry phase
Shading phase
Effects phase

RAM peak
GPU logical resident bytes
upload bytes/frame

selected meshlets
expanded triangles
exact triangles
shaded pixels
```

重点是增加真正的 GPU Frame Envelope，不把 pass timestamp sum 当作完整 GPU Frame。

---

# 5. Sprint 0：Frame Products V2

先冻结少量跨系统语义：

```text
Depth
VisibilityKey
Velocity

GeometricNormal
AO

OpaqueHDR

ShadingNormal
Roughness
Metalness
SurfaceFlags

Reflection
ReactiveMask

FinalHDR
```

Resolution Domain：

```text
InternalFull
InternalHalf
InternalQuarter
OutputFull
HistoryInternal
HistoryOutput
Tile8
Tile16
```

同时冻结：

```text
PreExposure convention
Velocity convention
Reactive convention
History reset convention
```

目的是让后续 Three.js SSAO/SSR 依赖稳定的 Frame Products，而不是绑定当前 Material Resolve / Surface 实现。

---

# 6. Sprint 1：迁移 Three.js SSAO

优先来源：

- `examples/webgpu_postprocessing_ao.html`
- `examples/jsm/tsl/display/SSAONode.js`
- `examples/jsm/tsl/display/GTAONode.js`

第一版建议 SSAO 作为便宜默认 AO：

```text
Depth + Normal
    ↓
rotated Vogel disk
    ↓
SSAO
    ↓
separable depth-aware blur
    ↓
AO
```

Three.js 当前 SSAO 默认：

```text
resolutionScale = 0.5
samples = 16
```

定位为比 GTAO horizon ray marching 更便宜的方案。

## 迁移原则

不要迁：

```text
TSL
NodeMaterial
QuadMesh
RenderTarget wrapper
RendererUtils
```

只迁：

```text
数学
采样模式
参数
blur
质量策略
```

实现成：

```text
OEngine WGSL
+
OEngine FrameGraph Pass
+
现有 AOFeature
```

Three.js 为 MIT License，移植时保留必要许可说明。

GTAO 可作为后续 High/Ultra 质量档位。

---

# 7. Sprint 1：迁移 Three.js SSR + Denoise

来源：

```text
examples/webgpu_postprocessing_ssr_denoise.html
SSRNode.js
TemporalReprojectNode.js
RecurrentDenoiseNode.js
```

目标：

```text
Stochastic GGX SSR
        ↓
Temporal Reprojection
        ↓
Recurrent Denoise
        ↓
History Feedback
```

## 7.1 SSR Trace

迁移：

```text
stochastic GGX
roughness-driven direction
metalness
mirror bias
maxDistance
thickness
screen-edge fade
environment miss
binary refine
non-linear ray step distribution
```

## 7.2 Temporal Reproject

迁移：

```text
velocity / world reprojection
previous depth
previous normal
geometry confidence
4-tap weighted history
YCoCg variance clipping
HDR luminance damping
disocclusion handling
```

## 7.3 Recurrent Denoise

迁移：

```text
Vogel disk
depth edge stopping
normal edge stopping
roughness-aware specular lobe
ray length
Karis temporal blend
adaptive trust
flicker suppression
```

未来可继续吸收 NRD / REBLUR 思路。

## 7.4 Reflection Composition 不照搬 Three.js 示例

OEngine 保持：

```text
IBL / Probe Reflection Baseline
            ↓
SSR Result + Confidence
            ↓
Reflection Resolve
            ↓
Resolved Specular
```

避免直接 `IBL + SSR` 导致 double energy。

---

# 8. Sprint 2：Texture / Asset Pipeline V2

优先使用：

```text
KTX-Software
Basis Universal
```

## 8.1 Texture Encoding

```text
PNG / JPG / WebP / EXR / HDR
        ↓
Offline Texture Cooker
        ↓
Semantic Classification
        ↓
Offline mip
        ↓
GPU-native compression
```

Desktop：

```text
BaseColor → BC7 sRGB
Normal    → BC5
Mask      → BC4
ORM       → BC7 / 合适的 BC family
HDR       → BC6H
```

Mobile：

```text
ASTC
```

Fallback：

```text
ETC2 / uncompressed
```

## 8.2 Texture Packaging

支持：

```text
KTX2
Basis Universal
```

发布模式：

```text
Universal:
KTX2/Basis → runtime adapter transcode

Performance Variant:
desktop-bc.opack
mobile-astc.opack
portable.opack
```

## 8.3 Offline Mip

生产资源改成：

```text
Cooker
→ 预生成 mip
→ Runtime 直接 upload compressed blocks
```

## 8.4 Texture Residency V2

当前 grow-copy texture bank 逐步替换成：

```text
Segmented / Paged Immutable Allocation
```

例如：

```text
BC7-1024 Page0
BC7-1024 Page1
BC7-2048 Page0
```

扩容只新增 page，不整体 copy。

第一轮不要求完整 Virtual Texture。

---

# 9. Sprint 3：Canonical Compact Geometry

继续复用 `meshoptimizer`：

```text
glTF
 ↓
Canonical IR
 ↓
Remove unused attributes
 ↓
Deduplicate vertices
 ↓
meshopt_optimizeVertexCache
 ↓
meshopt_optimizeOverdraw
 ↓
meshopt_optimizeVertexFetch
 ↓
Quantization
 ↓
Meshlet generation
 ↓
Meshlet optimize
 ↓
LOD
 ↓
Hierarchy
 ↓
Page packing
 ↓
meshopt encoding
```

## Runtime Vertex Profile

第一轮只做少数 profile：

### Static PBR

```text
Position → local AABB quantized u16
Normal   → oct16
Tangent  → packed oct + sign
UV       → f16x2 / unorm16x2
Color    → rgba8
```

### Skinned PBR

在 Static PBR 基础上增加 joint indices / weights。

### Position-only / depth-only

按需要加入。

目标是删除 Runtime shader 的万能 datatype/normalized/stride/offset 解码热路径。

---

# 10. Sprint 3：Instance ABI V2

拆成：

```text
StaticInstanceData
├ geometry
├ material
├ bounds
├ flags
└ debug

DynamicInstanceData
├ current transform
├ previous transform
└ motion state
```

目标：

```text
降低 GPU resident bytes
降低 CPU shadow bytes
降低 transform update bandwidth
```

第一轮不强求 quaternion / transform 极限压缩。

---

# 11. Sprint 4：Meshlet GPU Frontend V2

这是整轮核心性能重构之一。

当前：

```text
Selected Meshlet
     ↓
expand triangle
     ↓
RasterWork / triangle
     ↓
ExactTriangleFilter
     ↓
ExactRasterWork / triangle
     ↓
Visibility
```

目标：

```text
Selected Meshlet
     ↓
MeshletWork
     ↓
Indirect Raster
     ↓
VisibilityKey V2
```

## 11.1 MeshletWork

包含：

```text
instance
geometry
meshlet
material / flags
```

尽量维持 16~20B 级别。

## 11.2 Meshlet Bucket Raster

WebGPU 无 mesh shader 时：

```text
<= 32 triangles
<= 64
<= 96
<= 128
```

每 bucket 一次 indirect raster。

利用：

```text
instance_index → MeshletWork
primitive_index → local triangle
```

## 11.3 Subgroup Queue Compaction

```text
subgroup ballot
prefix
少量 global atomic
```

替代每 thread global append。

## 11.4 Selective Exact

```text
Normal
→ Hardware Raster

Correctness Risk
→ Selective Exact
```

Risk 只包含 near-plane / degenerate / clip-space numerical edge 等 correctness case。

## 11.5 Triangle Setup Cache

和 Risky Exact 分离。

只用于大屏幕覆盖 triangle 的 barycentric setup amortization。

---

# 12. Sprint 5：Material / Shading V2

从：

```text
Visibility
→ MaterialClassDepth
→ N × Fullscreen Material Resolve
→ Surface
→ Lighting
```

迁移到：

```text
Visibility
→ Material Classification
→ Compact Pixel Work
→ Compute ShadeLighting
```

## 12.1 Material Classification

```text
8x8 / 16x16 tile
        ↓
material class
        ↓
subgroup compact
        ↓
indirect dispatch
```

第一版不做全屏 GPU radix sort。

记录：

```text
active material classes/tile
empty pixels
wasted lanes
shading utilization
```

## 12.2 Compute ShadeLighting

```text
Geometry attribute recovery
        ↓
Full Material Evaluation
        ↓
Direct Lighting
Shadow
AO
IBL
GI
        ↓
Pre-exposed HDR
+
ShadingSurfaceLite
```

完整材质语义尽量只执行一次。

## 12.3 Coverage 与 Shading 分离

MASK：

```text
Visibility → EvaluateCoverage
ShadeLighting → EvaluateShading
```

Opaque：

```text
Visibility → no material evaluation
ShadeLighting → EvaluateShading
```

---

# 13. Surface ABI V2

不再长期维持完整：

```text
PBR
Normal
AlbedoAO
Emissive
Velocity
Metadata
```

区分：

```text
VisibilityProducts
GeometryProducts
ShadingProducts
```

## VisibilityProducts

```text
Depth
VisibilityKey
Velocity / motion validity
```

## GeometryProducts

AO / Contact 需要 geometric normal。

优先比较：

```text
A. depth reconstruct
B. VisibilityKey → triangle reconstruct
C. compact stored geometric normal
```

## ShadingProducts

只保留：

```text
Shading Normal
Roughness
Surface Flags
Velocity
HDR
```

目标 SurfaceLite 约 4~8B/pixel。

---

# 14. HDR / MRT 压缩

重点比较：

```text
RGBA16F
vs
R11G11B10
```

适用：

```text
Opaque HDR
Temporal History
Bloom
SSR Radiance
```

配合 PreExposure 降低 bandwidth 与 history memory。

---

# 15. Sprint 6：Shared Derived Products

建立：

```text
Shared Depth / HZB
OpaqueColorPyramid
FinalColorPyramid
History Contract
Resolution Domains
```

## OpaqueColorPyramid

生成于 opaque shading 后、SSR 前。

消费者：

```text
SSR
future SSGI
Refraction
```

## FinalColorPyramid

生成于 Transparency + Temporal Reconstruction 后。

消费者：

```text
Bloom
Exposure
DOF
Lens Effects
```

---

# 16. AO 最终接入

Three.js SSAO 算法保留，最终管线：

```text
Depth + Geometric Normal
        ↓
Half-res SSAO
        ↓
Depth-aware Blur
        ↓
保持 Half-res
        ↓
ShadeLighting 中 joint sample
```

取消默认 Half-res → Full-res AO texture → Lighting full-res read。

---

# 17. SSR 最终接入

输入：

```text
OpaqueHDR
Depth / HZB
ShadingNormal
Roughness
Metalness
Velocity
OpaqueColorPyramid
```

算法：

```text
Stochastic GGX Trace
→ Temporal Reproject
→ Recurrent Denoise
→ Reflection Resolve
```

---

# 18. Sprint 7：Temporal / DRS / History

保留现有 TemporalFeature，强化统一 History Contract：

```text
semantic
resolution domain
format
double/triple buffer
validity generation
camera cut
resize
DRS change
preExposure convention
device loss
```

目标 Temporal Reconstruction：

```text
Internal Resolution HDR
+
Depth
Velocity
Reactive
Disocclusion
Exposure / PreExposure
Jitter
        ↓
Temporal Reconstruction
        ↓
Output-resolution HDR
```

---

# 19. Dynamic Resolution

正式接受：

```text
1080p output
≠
native 1080p internal
```

主管线允许：

```text
约 0.67 ~ 1.0 internal scale
```

真实游戏 Adaptive，Benchmark 必须提供 Fixed 模式。

---

# 20. Post Fusion

```text
FinalColorPyramid
├ Exposure
└ Bloom
```

最终考虑：

```text
FinalOutputPass
├ Exposure
├ Bloom
├ Color LUT
├ Tone Mapping
├ Sharpen
├ Output Gamut
└ HDR/SDR conversion
```

减少 fullscreen roundtrip。

---

# 21. Sprint 8+：后续高级渲染

不阻塞 Performance V2：

```text
Transparency Strategy
Virtual Shadow Atlas / VSM
Contact Shadows
Sparse Probe GI
SSGI
Volumetric Fog
DOF
Motion Blur
Water / Refraction
Hair
Particles
Software VRS
Virtual Texture
Geometry Streaming
```

Transparency 候选：

```text
Alpha Test / foliage → Visibility mask path
Simple alpha         → Sorted Forward+
Particles / smoke    → WBOIT
复杂多层透明         → MBOIT
Water / glass        → special refraction
```

---

# 22. Global Frame Budget

最终建立：

```text
GeometryBudget
ShadowBudget
SSR Ray Budget
GI Update Budget
Volumetric Budget
Streaming Budget
Resolution Budget
```

Adaptive 模式协调质量；Benchmark 继续使用 Fixed 模式，避免自动质量下降掩盖回归。

---

# 23. 开源算法采用原则

```text
优先级 1
成熟 Library
→ 直接调用

优先级 2
成熟开源 Renderer / Engine
→ 迁算法与数学，不迁框架

优先级 3
论文 + Reference Implementation
→ 移植

优先级 4
没有成熟实现
→ OEngine 自研
```

建议：

| 模块 | 优先来源 |
|---|---|
| Mesh optimization | meshoptimizer |
| Meshlet / LOD / geometry codec | meshoptimizer |
| Texture container | KTX2 / KTX-Software |
| Texture compression | Basis Universal / KTX-Software |
| SSAO | Three.js SSAONode |
| GTAO | Three.js GTAONode / Activision GTAO |
| SSR | Three.js SSRNode |
| SSR temporal | Three.js TemporalReprojectNode |
| SSR denoise | Three.js RecurrentDenoiseNode |
| Temporal clipping | Three.js + Playdead reference |
| Specular denoise ideas | NRD / REBLUR |
| GPU-driven Visibility | OEngine 自研 |
| Compute ShadeLighting | OEngine 自研 |
| Frame Budget / Work Scheduling | OEngine 自研 |

---

# 24. 关键开源来源

Three.js SSR + denoise example:

https://github.com/mrdoob/three.js/blob/master/examples/webgpu_postprocessing_ssr_denoise.html

Three.js AO example:

https://github.com/mrdoob/three.js/blob/master/examples/webgpu_postprocessing_ao.html

SSR:

https://github.com/mrdoob/three.js/blob/master/examples/jsm/tsl/display/SSRNode.js

SSAO:

https://github.com/mrdoob/three.js/blob/master/examples/jsm/tsl/display/SSAONode.js

GTAO:

https://github.com/mrdoob/three.js/blob/master/examples/jsm/tsl/display/GTAONode.js

Temporal Reprojection:

https://github.com/mrdoob/three.js/blob/master/examples/jsm/tsl/display/TemporalReprojectNode.js

Recurrent Denoise:

https://github.com/mrdoob/three.js/blob/master/examples/jsm/tsl/display/RecurrentDenoiseNode.js

Three.js License:

https://github.com/mrdoob/three.js/blob/master/LICENSE

meshoptimizer:

https://github.com/zeux/meshoptimizer

KTX-Software:

https://github.com/KhronosGroup/KTX-Software

Basis Universal:

https://github.com/BinomialLLC/basis_universal

GPUWeb proposals:

https://github.com/gpuweb/gpuweb/blob/main/proposals/README.md

Subgroups:

https://github.com/gpuweb/gpuweb/blob/main/proposals/subgroups.md

Primitive Index:

https://github.com/gpuweb/gpuweb/blob/main/proposals/primitive-index.md

Immediate Data:

https://github.com/gpuweb/gpuweb/blob/main/proposals/immediate-data.md

Transient Attachments:

https://github.com/gpuweb/gpuweb/blob/main/proposals/transient-attachments.md

---

# 25. 每阶段最小验收

不采用“必须提升 X% 总 FPS 才做”的统一规则。

## SSAO / SSR

看：

```text
正确性
稳定性
artifact
GPU phase cost
维护复杂度
```

## Texture

看：

```text
VRAM resident bytes
download bytes
load time
runtime mip cost
bank grow/copy
```

## Geometry / Instance

看：

```text
runtime package size
GPU resident bytes
CPU shadow bytes
vertex fetch
asset load
```

## Meshlet Frontend

看：

```text
per-triangle queue bytes
Exact work
Geometry GPU phase
selected meshlets
submitted triangles
near-camera worst case
```

## Material / Shading

看：

```text
Material phase
Lighting phase
Surface bytes/pixel
Shading utilization
full material evaluations
```

## Effects / Temporal / Post

看：

```text
full-res intermediate count
history bytes
SSR/AO GPU cost
Bloom/Exposure duplicate work
P95/P99 frame stability
```

---

# 26. 优化类型分别评价

## Architecture Enabler

例如：

```text
VisibilityKey V2
FrameProducts
History Contract
Canonical Geometry
```

不要求立即产生巨大 FPS。

## Hot-path Optimization

例如：

```text
subgroup queue
meshlet work
compute material
```

看局部 GPU phase 和工作量。

## Memory / Residency Optimization

例如：

```text
BC7
geometry quantization
instance packing
```

看 RAM、VRAM、bandwidth、loading、P99 hitch。

## Micro Optimization

例如：

```text
少几条 ALU
少一次 Map lookup
```

这种才要求明确测量收益后保留。

---

# 27. 最终目标架构

```text
                         OFFLINE / COOK

Source Assets
        ↓
Canonical Import IR
        ↓
Geometry Cook
├ quantization
├ meshoptimizer
├ meshlet
├ LOD
├ hierarchy
└ page packing

Texture Cook
├ semantic classify
├ offline mip
├ BC / ASTC / ETC2
└ KTX2
        ↓
Runtime Package V2


                         RUNTIME

Runtime Package
        ↓
GpuAssetStore / Texture Residency / Materials
        ↓
GpuRenderWorld
        ↓

──────────────────── FRAME ────────────────────

Scene Patch
   ↓
Instance / Meshlet Cull
   ↓
Hierarchy / Flat Fast Path
   ↓
Subgroup Meshlet Queue
   ↓
Meshlet Indirect Raster
   ↓
primitive_index
   ↓
VisibilityKey V2 + Depth
   │
   ├────────→ Shared Depth / HZB
   │               ↓
   │             SSAO
   │
   ▼
Material Classification
   ↓
Compute ShadeLighting
├ Full Material Evaluation
├ Clustered Direct Light
├ Shadow
├ AO
├ GI
└ IBL
   ↓
Pre-exposed HDR
+
ShadingSurfaceLite
   ↓
OpaqueColorPyramid
   ↓
Three.js-derived Stochastic SSR
   ↓
Temporal Reproject
   ↓
Recurrent Denoise
   ↓
Reflection Resolve
   ↓
Opaque HDR
   ↓
Transparency
   ↓
Temporal Reconstruction
   ↓
Output-resolution HDR
   ↓
FinalColorPyramid
├ Exposure
└ Bloom
   ↓
Fused Final Output
   ↓
Present
```

横跨整个 Frame：

```text
WebGPU 2026 Desktop Capability
History Contract
Resolution Domains
Frame Budget
FrameGraph
Profiler
Lightweight Validation
```

---

# 28. 推荐立即开始的第一个实施批次

```text
Step 1
WebGPU 2026 Desktop Capability Profile

Step 2
简化 Validation 到 DEV / MILESTONE / PERF

Step 3
补 GPU Frame Envelope baseline

Step 4
冻结 Frame Products V2

Step 5
迁 Three.js SSAO

Step 6
迁 Three.js SSR Trace

Step 7
迁 TemporalReproject

Step 8
迁 RecurrentDenoise

Step 9
接回 OEngine ReflectionService
保留 IBL baseline + SSR correction

Step 10
做 Sprint 1 milestone benchmark
```

完成后再进入 Texture V2。

---

# 29. 结论

下一轮 Performance Architecture 不应该追求：

```text
每个 Pass 独立优化
```

而应该围绕：

```text
更少的数据
+
更粗的 GPU Work 粒度
+
更少的中间显存写回
+
更少的重复材质计算
+
更低的 Effect Resolution
+
更多 Temporal Reuse
+
更多 Shared Products
+
更多 GPU-driven indirect work
```

2026 WebGPU 的：

```text
subgroups
primitive-index
shader-f16
Immediate Data
Transient Attachments
```

应该真正进入架构。

成熟算法：

```text
Three.js SSR / SSAO
meshoptimizer
KTX2 / Basis
```

优先移植或直接复用，把开发时间集中到真正属于 OEngine 的核心：

```text
GPU-driven Geometry
Visibility
Runtime Data Layout
Compute Shading
Frame Scheduling
Global Budget
```
