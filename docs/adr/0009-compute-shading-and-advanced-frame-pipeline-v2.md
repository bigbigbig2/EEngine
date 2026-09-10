# ADR-0009 · Compute Shading 与 Advanced Frame Pipeline V2

> **Status:** proposed
> **Date:** 2026-09-10
> **Scope:** Material Classification、ShadeLighting、Surface/HDR、AO/SSR、Reflection、Temporal、Post、Frame Products/Budget
> **Depends on:** ADR-0008 VisibilityKey V2；ADR-0007 Texture/Geometry Runtime contracts
> **Proposed supersession:** 接受并完成 cutover 后，替代 ADR-0004 的 VisibilityKey material-class、MaterialClassDepth/fullscreen Surface Resolve 与重型 Surface 决策；此前 ADR-0004 仍是当前权威
> **Design source:** `OEngine Performance Architecture V2` Design Draft

## Context

当前 OEngine 已经具备 Visibility Buffer、Surface、clustered lighting、AO、SSR、Transparency、Temporal/Post 等高级渲染能力。问题不是“效果太少”，而是从 Visibility 到 Present 的数据流仍存在明显的 bandwidth/work amplification：

```text
Visibility
   ↓
MaterialClassDepth / material classification
   ↓
active material class fullscreen resolve
   ↓
完整 Surface MRT
   ↓
Lighting 再读取 Surface
   ↓
AO / SSR / Temporal / Post 各自维护部分派生资源
```

当前 `OEngine/src/gpu/GpuSurfaceAbi.ts` 的主要持久 Surface 约为：

```text
PBR        2 B/pixel
Normal     8 B/pixel
Albedo/AO  4 B/pixel
Emissive   4 B/pixel
Velocity   4 B/pixel
Metadata   4 B/pixel
--------------------
Total     26 B/pixel
```

在 1920×1080 下，仅完整写一次约 51 MiB；再由 Lighting 读回，已经形成显著中间 bandwidth，而这还未计 Depth、Visibility、HDR、AO、SSR 与 history。

当前 Material Resolve 还需要从 VisibilityKey 反查 geometry/meshlet/triangle/vertices，并承担通用 vertex decode、barycentric/gradient 与 material texture sampling。

同时：

- AO 当前存在 half/internal 计算再 full-res resolve 的成本；
- SSR 自己构建 scene-color pyramid；
- Bloom 维护自己的 mip 链；
- Exposure 再独立读取/归约 HDR；
- Temporal/SSR/AO 各自维护 history lifecycle；
- RGBA16F 等历史/中间 HDR 格式可能造成额外 resident/bandwidth；
- 高级效果的 resolution/sample 工作量缺乏统一 frame budget。

ADR-0009 的目标不是回退到传统 Deferred，也不是全部改 Forward+，而是建立：

> **Visibility-driven Compute Hybrid Frame Pipeline**

核心思想：

```text
Visibility identity
    → only required screen-space geometry data
    → compute material classification
    → one full opaque material evaluation
    → lighting
    → compact persistent shading products
    → bandwidth-aware effects
    → temporal reconstruction
    → fused final output
```

## Decision

目标生产链路：

```text
VisibilityKey V2 + Depth
        │
        ├── Shared Depth / geometric inputs
        │            ↓
        │           AO
        │
        ▼
Material Classification
        ↓
Compute ShadeLighting
  ├─ full material evaluation
  ├─ direct light / shadow
  ├─ AO / GI / IBL
  ├─ emissive / unlit
  └─ pre-exposure
        ↓
PreExposedOpaqueHDRBaseline
+
PreExposedBaselineSpecular（仅 SSR consumer 存在时）
+
ShadingSurfaceLite
        ↓
OpaqueColorPyramid (on demand)
        ↓
SSR Trace
→ Temporal Reproject
→ Recurrent Denoise
→ Reflection Resolve
        ↓
PreExposedOpaqueHDRComplete
        ↓
Transparency + Reactive
        ↓
Temporal Reconstruction / TAAU / DRS
        ↓
Output-resolution HDR
        ↓
FinalColorPyramid (on demand)
        ├─ Exposure
        └─ Bloom
        ↓
Fused Final Output
        ↓
Present
```

本 ADR 明确修正 Design Draft 中容易误实现的 `SurfacePrep`：

> **SurfacePrep 不得成为第二次完整 Material Resolve。**

完整 opaque material shading 只能在主 `ShadeLighting` 语义中执行一次。AO 在它之前只消费 geometric/visibility data；normal-map-aware shading normal 在 full material evaluation 后进入 `ShadingSurfaceLite`，供 SSR/Temporal 等后续消费者使用。

---

## 1. Frame Product contract

### 1.1 VisibilityProducts

ADR-0008 输出：

```text
Depth
VisibilityKey V2
Velocity / MotionValidity（按拓扑需要）
RepresentationChange / validity signal（如需要）
```

### 1.2 GeometryProducts

用于 full material evaluation 之前的 screen-space geometry effects：

```text
GeometricNormal (optional physical product)
Shared Depth/HZB
```

`GeometricNormal` 不一定必须落 full-res texture。

必须比较：

```text
A. depth-derived geometric normal
B. VisibilityKey → triangle-derived geometric normal
C. compact stored geometric normal
```

依据：

```text
AO quality
GPU fetch/ALU
bandwidth
temporal stability
```

### 1.3 ShadingProducts

完整 Material + Lighting 后产生：

```text
PreExposedOpaqueHDRBaseline

PreExposedBaselineSpecular
  only when SSR/reflection correction consumes it

ShadingSurfaceLite
  shading normal
  roughness
  surface/shading flags
  optional metallic/specular classification
```

Velocity、Reactive、OcclusionConfidence 等继续作为独立 FrameProducts，不强塞进 SurfaceLite。

`PreExposedOpaqueHDRBaseline` 包含 direct、indirect diffuse、emissive/unlit 与 IBL/probe baseline specular。SSR 启用时，`ShadeLighting` 额外输出相同 pre-exposure 约定的 `PreExposedBaselineSpecular`，使 Reflection Resolve 可以替换而不是叠加 baseline；SSR 关闭时不创建该额外产品，baseline HDR 直接成为 complete opaque HDR。

### 1.4 Why two surface layers

禁止：

```text
SurfacePrep
→ sample normal/ORM/material
→ produce shading normal/roughness
→ AO
→ ShadeLighting
→ sample same normal/ORM/material again
```

这会把旧 Material Resolve 变成两个名字。

主合同：

```text
Visibility / geometry
  ↓
AO using geometric data
  ↓
Full material evaluation once
  ↓
ShadingSurfaceLite
  ↓
SSR / temporal consumers
```

如果未来证明 AO 必须 material-aware normal 才满足目标质量，需要单独比较：

```text
material-aware prepass cost
vs
AO after/within shading
vs
geometric-normal AO
```

而不是默认重复材质。

---

## 2. MASK coverage vs full shading

“完整材质只算一次”不能错误地包含 alpha coverage。

对 MASK：

```text
EvaluateCoverage()
```

属于 Visibility correctness，需要 UV / opacity/baseColor alpha。

然后：

```text
EvaluateShading()
```

属于主 shading。

Opaque：

```text
Visibility
→ no material eval
→ ShadeLighting: EvaluateShading
```

MASK：

```text
Visibility
→ EvaluateCoverage
→ ShadeLighting: EvaluateShading
```

Transparency：

```text
forward/OIT path
→ coverage + shading according to transparent algorithm
```

Profiler 分开记录：

```text
coverage_evaluations
full_shading_evaluations
```

避免把 foliage 的 alpha 成本隐藏在“材质只算一次”的口号里。

---

## 3. Material Classification V2

### 3.1 Goal

当前 active material class fullscreen draw 的问题，不是“Raster 一定比 Compute 慢”，而是：

```text
active class
→ fullscreen coverage
→ each pixel checks/discards
```

V2 改为：

```text
Visibility pixels
→ tile/class discovery
→ only relevant tile/class work
→ ShadeLighting
```

### 3.2 First production candidate

第一版使用有界 `MaterialTileWork` queues，不直接上 full pixel compaction / radix sort。

```text
Visibility pixels
→ one ShadingDispatchClassId per valid pixel
→ one MaterialTileWork record per active tile/dispatch-class pair
→ one dispatchWorkgroupsIndirect per bounded dispatch class
```

候选 tile：

```text
8×8
16×8
16×16
```

最终由：

```text
class diversity
inactive lanes
shared memory
subgroup width
texture locality
output coalescing
```

选择。

`ShadingDispatchClassId` 冻结为：

```text
KernelClassId × TextureBindingSetId
```

CPU 只按初始化时冻结的有界 dispatch-class 表 encode `dispatchWorkgroupsIndirect`；GPU classifier 直接写每个 queue 和完整 indirect record，CPU 不回读 active class/count 后再重建 dispatch list。

### 3.3 MaterialTileWork queue contract

逻辑 element：

```text
tile_linear_id
kernel_class_id
texture_binding_set_id
generation
```

具体 stride/alignment 由统一 CPU/WGSL ABI 冻结。每个 dispatch class 拥有一个 queue；同一 tile 在同一 dispatch class 中最多写一条 record，因此单 queue capacity 固定为当前 internal resolution 的 `tile_count`。合法 dispatch-class 数由 capability/binding policy 初始化时冻结，所有 queue 与 12-byte indirect dispatch record 完整初始化。

Classifier finalize 在 GPU 上写完整 indirect record：

```text
workgroupCountX = written_count
workgroupCountY = 1
workgroupCountZ = 1
```

若任一 correctness counter/overflow 非零，finalize 将所有 ShadeLighting indirect counts 清零并写 GPU-visible frame-invalid signal；FinalOutput 消费该 signal 输出明确 diagnostic clear，而不是呈现部分 shading。异步 readback 只负责随后报告错误，CPU 不需要读取本帧结果即可阻止错误结果冒充成功。

合同：

| 项目 | 决定 |
| --- | --- |
| Producer | Material Classification compute |
| Consumer | 对应 kernel/binding-set 的 `ShadeLightingCS` indirect dispatch |
| Capacity | `tile_count` per dispatch class；class 数由 renderer policy 有界 |
| Counters | `attempted/written/consumed/overflow`、valid/shaded/duplicate/unassigned pixels |
| Overflow | correctness failure；清零相关 indirect args，整帧不呈现部分 shading |
| Feature-off | 没有 opaque shading consumer 时不创建 classifier、queue、indirect args 或 counter copy |

每个 valid opaque pixel 必须确定性映射到且仅映射到一个 `ShadingDispatchClassId`。Consumer 在 tile 内只处理 class id 相符的 lane；`unassigned_pixels` 或 `duplicate_shading_pixels` 非零即 correctness failure。Queue `attempted_count > tile_count` 表示 ABI/producer bug，不是可接受内容压力。

### 3.4 Material kernel classes

Class 必须有界，不是一材质一个 shader。

Material record 先保存正交 feature bits，例如：

```text
coverage: opaque | MASK
normal source: vertex | normal map
ORM source: factors | texture
emissive: absent | factor | texture
lighting model: standard PBR | unlit | registered special model
```

Cooker/runtime 使用版本化映射表把完整 feature-bit 组合确定性映射到唯一 `KernelClassId`。`normal-mapped`、`textured ORM`、`emissive` 不是互斥 class；只有证据表明 specialization 能显著移除昂贵 branch 时才增加独立 kernel。实现必须冻结 `max_kernel_classes` 和一个覆盖所有受支持 standard PBR 组合的 generic kernel；无法进入 generic/registered kernel 的材质在发布前失败，不能静默忽略 feature。

### 3.5 WebGPU 2026 Desktop

优先：

```text
subgroup ballot/prefix
subgroup compact
shader-f16 for safe local intermediates
```

Capability fallback：

```text
workgroup shared-memory classification
```

两者输出同一 logical work contract。

能力协商遵循 [WEBGPU.md](../WEBGPU.md)。Subgroup kernel 必须覆盖设备报告的 size 范围；只有 `subgroup-size-control` 已启用且固定宽度确有综合证据时才生成 `@subgroup_size` variant。`shader-f16` 不用于 depth、world-position accumulation、history identity、queue counter 或 stable handle。

### 3.6 Shading utilization

记录：

```text
valid pixels
tile-class records
active lanes
inactive lanes
classes/tile
shaded pixels
unassigned pixels
duplicate shading pixels
```

得到：

```text
ShadingUtilization
=
useful shading lanes / executed shading lanes
```

如果 tile-class 已经足够高效，不因“Compute 更高级”继续上 pixel list。

---

## 4. Binding Budget is a design input

在写 `ShadeLightingCS` 前必须列 binding budget：

```text
Visibility / Depth
MeshletWork
Geometry metadata
Vertex/index payload
Instance data
Material table
Texture descriptors / one TextureBindingSet / sampler classes

Lights / clusters
Shadow resources
AO
Environment / GI

HDR output
SurfaceLite output
Counters
```

必须按 `WEBGPU.md` 对目标浏览器/adapter 的 features、limits、WGSL language features 和 API surface 做实际 probe，并为 shadow/environment/frame products 预留 binding，而不是把全部 `maxSampledTexturesPerShaderStage` 交给材质纹理。

如果超限，优先：

```text
合并 metadata heaps
减少持久 outputs
分离低频/高频 inputs
压缩 descriptor
```

而不是机械拆出更多 fullscreen stages。

### 4.1 TextureBindingSet execution contract

ADR-0007 的 descriptor indirection 不等于 bindless。标准生产 layout 只声明有界数量的 `texture_2d_array`/sampler bindings；当前 dispatch 只能访问其 `TextureBindingSetId` 对应的 bind group：

```text
MaterialTileWork
  KernelClassId
  TextureBindingSetId
        ↓
set compute pipeline/kernel
set fixed frame/scene bind groups
set TextureBindingSet bind group
dispatchWorkgroupsIndirect
```

同一 material 的全部 TextureHandle 先由 ADR-0007 descriptor 解析到唯一 physical `segment + array_layer`，再由 `GpuMaterialTextureRouting` 映射到当前 set 的 `binding_slot + array_layer + sampler_class`。同一 segment view 可以出现在多个 set 中而不复制 texture residency。WGSL 通过对有界 `binding_slot` 做 `switch` 选择静态声明的 texture binding；不生成运行时长度 resource array，也不假设 sized binding arrays、descriptor indexing 或通用 bindless。

初始化冻结：

```text
texture bindings per set
sampler classes
max TextureBindingSetId
max KernelClassId
max ShadingDispatchClassId
```

并验证乘积对应的 pipeline/layout/bind-group/indirect-dispatch 数仍在 renderer policy 内。资产 colocate、set overflow、relocation 与 publication failure 遵循 ADR-0007；classifier 不允许把同一 material 拆成跨 set 的多次完整 shading。

---

## 5. Compute ShadeLighting

### 5.1 Responsibilities

每个 valid shaded pixel：

1. 从 VisibilityKey V2 恢复 meshlet work/local primitive。
2. 读取 canonical compact vertices。
3. 计算 perspective-correct barycentric。
4. 计算显式 UV gradient/LOD。
5. 执行一次 `EvaluateShading()`。
6. 执行 clustered direct lighting。
7. 消费 shadow visibility。
8. 消费 AO/indirect visibility。
9. 消费 GI/IBL。
10. 处理 emissive/unlit。
11. 应用统一 pre-exposure。
12. 写 `PreExposedOpaqueHDRBaseline`。
13. SSR 启用时单独写 `PreExposedBaselineSpecular`。
14. 写后续真正需要的 `ShadingSurfaceLite` 字段。
15. 更新 shading/material counters。

### 5.2 Explicit derivatives

Compute 没有 fragment implicit derivative，必须正式解决：

```text
barycentric gradients
UV ddx/ddy equivalent
mip LOD
anisotropic/high-frequency stability
```

候选：

- triangle projected gradient；
- ADR-0008 LargeTriangle Setup cache；
- tile/quad neighbor sharing；
- explicit LOD fallback；
- invalid-gradient counter/fallback。

这是 Compute Shading 的 correctness blocker，不允许用“看起来差不多”跳过。

WebGPU 2026/WGSL 路径以计算得到的显式 `ddx/ddy` 调用 `textureSampleGrad`；无有效 gradient 时使用经过质量验证的 `textureSampleLevel` fallback 并增加 invalid/fallback counter。两种调用都必须在目标浏览器实际创建 shader/pipeline 并覆盖高频、斜视角和 anisotropy 场景，不能仅凭类型定义判断支持。

### 5.3 Texture sampling

通过 ADR-0007 stable texture handle：

```text
MaterialSlot
→ TextureHandle
→ descriptor: physical segment/layer/resident mip/generation
→ GpuMaterialTextureRouting: binding_set/binding_slot/sampler_class
```

当前 `MaterialTileWork.TextureBindingSetId` 必须与 material routing 的 `binding_set` 一致，且 routing 中每个 slot 必须覆盖对应 descriptor 的 physical segment。descriptor/routing generation 或 set 不匹配时使用明确 non-resident fallback 并计数，不能采样同 slot 的新资源。

记录：

```text
texture samples
fallback samples
non-resident fallback
mip clamp
```

---

## 6. SurfaceLite V2

### 6.1 What does not persist

默认不再持久化：

```text
baseColor
emissive
full ORM
data only consumed once by Lighting
```

它们尽量只存在于 shading registers/intermediates。

### 6.2 What may persist

候选：

```text
shading normal
perceptual roughness
surface flags
optional metallic/specular classification
```

目标逻辑 budget：

```text
~4–8 B/pixel
```

但这是目标，不是先验硬 ABI。

### 6.3 Physical format candidates

例如：

```text
Profile Balanced
normal 4B
roughness/flags 2–4B

Profile Compact
packed/oct normal
roughness/flags packed into remaining bits
```

每个 profile 必须比较：

```text
normal angular error
SSR stability
specular shimmer
storage write support
filter/load needs
bandwidth
binding count
```

---

## 7. HDR and PreExposure contract

### 7.1 Semantic

全主管线统一：

```text
pre_exposed_color
=
scene_referred_color * pre_exposure
```

涉及：

```text
opaque lighting
emissive
transparency
SSR/history
bloom
exposure
temporal
tone mapping
debug capture
```

不允许不同 Feature 私自假设 HDR 是否已曝光。

### 7.2 Physical formats

优先比较：

```text
rg11b10ufloat
rgba16float
```

以及目标浏览器真正可写/可采样的 format profile。

不能只看 bytes；还要验证：

```text
alpha need
negative values
highlights
bloom
temporal history
transparent composite
storage/render support
```

### 7.3 History

Temporal/SSR history 也应尝试 compact HDR format。

目标是降低：

```text
current HDR
+
double-buffer history
+
SSR history
+
bloom intermediates
```

的总 bandwidth/resident，而不是只省一张 RT。

---

## 8. AO V2 — Three.js SSAO migration

### 8.1 Decision

第一轮 AO replacement 优先移植 Three.js 当前 WebGPU SSAO 算法，作为便宜默认路径。

参考上游：

```text
examples/webgpu_postprocessing_ao.html
examples/jsm/tsl/display/SSAONode.js
```

GTAO 可继续作为需要独立证据的候选算法，但不形成另一条质量档位管线，也不阻塞第一轮 AO replacement。

### 8.2 Port algorithm, not framework

移植：

```text
sample pattern / Vogel disk
depth/normal AO math
quality parameters
depth-aware separable blur
```

不移植：

```text
TSL
NodeMaterial
QuadMesh
Three.js RenderTarget ownership
Renderer framework
```

OEngine 实现保持：

```text
WGSL
AOFeature
FrameGraph products
one main submit
```

Three.js 为 MIT；实现前在 `docs/porting/shading.md` 固定 exact revision、license 与本地差异。

### 8.3 Target OEngine pipeline

最终：

```text
Depth + GeometricNormal
       ↓
Half/Internal SSAO
       ↓
Depth-aware blur
       ↓
Compact AO
       ↓
ShadeLighting samples AO
```

优先取消：

```text
half AO
→ full-res AO texture
→ Lighting full-res read
```

除非同一综合 benchmark/profile 内的受控对照证明 full-res resolved texture 总成本更低或质量明显更好。

### 8.4 Bent normal

只有真实 IBL/GI consumer 需要时生成，不作为第一轮 SSAO 默认成本。

---

## 9. SSR V2 — Three.js SSR + Temporal + Recurrent Denoise

### 9.1 Decision

生产 SSR replacement 优先移植 Three.js WebGPU SSR denoise example 的算法部分：

```text
examples/webgpu_postprocessing_ssr_denoise.html

SSRNode.js
TemporalReprojectNode.js
RecurrentDenoiseNode.js
```

目标：

```text
Stochastic GGX SSR
→ Temporal Reprojection
→ Recurrent Denoise
→ OEngine Reflection Resolve
```

### 9.2 SSR Trace

移植/适配：

```text
stochastic GGX sampling
roughness-aware ray
max distance
thickness
edge fade
nonlinear step distribution
binary refinement where useful
environment/miss handling
```

OEngine 可以继续结合 Shared Depth/HZB 做 hierarchical trace；若 Three.js upstream 的 trace 与 OEngine HZB 表达不同，按行为/数学移植，不照抄数据结构。

### 9.3 TemporalReproject

重点复用：

```text
velocity/world reprojection
previous depth/normal validation
geometry confidence
weighted history
YCoCg/variance clipping
HDR luminance damping
disocclusion handling
```

并适配 OEngine：

```text
PreExposure
History Contract
Reactive
RepresentationChange
```

### 9.4 RecurrentDenoise

重点：

```text
Vogel sampling
depth edge stopping
normal edge stopping
roughness/specular lobe weighting
ray-length awareness
temporal/Karis-style blending
flicker suppression
```

必要时继续参考 NRD/REBLUR 思路，但 provenance 单独记录。

### 9.5 Preserve OEngine reflection semantics

不照搬 example 的最终 composite。

OEngine 保持：

```text
PreExposedOpaqueHDRBaseline
+ PreExposedBaselineSpecular
+ SSR Result / Confidence
        ↓
Reflection Resolve
        ↓
PreExposedOpaqueHDRComplete
```

Resolve 语义冻结为等价形式：

```text
ResolvedSpecular = lerp(BaselineSpecular, SSRSpecular, SSRConfidence)
OpaqueHDRComplete
  = OpaqueHDRBaseline - BaselineSpecular + ResolvedSpecular
```

`BaselineSpecular`、`SSRSpecular` 与 HDR 必须使用同一 pre-exposure convention。Resolve 可在数值等价的 fused kernel 中实现，但不能依赖从已组合 HDR 反推出 baseline specular。

禁止简单：

```text
LitHDR + SSR
```

造成 double energy。

SSR 关闭时不创建 `PreExposedBaselineSpecular`、trace/denoise/resolve 产品，`PreExposedOpaqueHDRBaseline` 直接别名/发布为 complete opaque HDR，保持 feature-off 近零成本。

### 9.6 Early integration spike

允许在 production cutover 前创建**非生产 example/validation spike**，提前验证 Three.js SSR/SSAO 算法质量。

但 production owner cutover 必须等：

```text
FrameProducts
HDR/PreExposure
SurfaceLite inputs
```

稳定，避免迁两次接口。

---

## 10. Shared Derived Products

### 10.1 Shared Depth

按 consumer demand 构建：

```text
Depth
LinearDepth
Min/Max HZB
other derived depth only if consumed
```

Occlusion/AO/SSR 共享同一语义 product，不各自复制等价 hierarchy。

### 10.2 OpaqueColorPyramid

生成时点：

```text
Opaque ShadeLighting / reflection baseline
↓
before SSR correction
```

Mip 0 的语义是已经包含 IBL/probe baseline 的 `PreExposedOpaqueHDRBaseline`。它可以直接复用该 texture，或由明确 compose/downsample owner 从分量生成；不能把缺少 baseline specular 的颜色当作 SSR scene-color source。

消费者：

```text
SSR
future SSGI
future refraction
```

### 10.3 FinalColorPyramid

生成时点：

```text
Transparency
+
Temporal Reconstruction
↓
output/final HDR domain
```

消费者：

```text
Bloom
Exposure
DOF
Lens effects
```

不要为了“共享”把 `OpaqueColorPyramid` 与 `FinalColorPyramid` 混成一个。

### 10.4 Pyramid implementation

可以研究：

```text
SPD-style single dispatch
subgroup reduction
simple multi-dispatch
```

决定因素是总 GPU envelope、format/binding、mip count，不是算法名字。

---

## 11. History Contract

现有 `TemporalFeature` 继续演化，不新建第二套 Temporal subsystem。

所有 persistent history 声明：

```text
semantic
resolution domain
format
buffer count
generation
validity
preExposure convention
camera-cut behavior
resize/DRS behavior
device-loss behavior
```

包括：

```text
Temporal color
SSR history
AO history
Exposure
future SSGI/GI histories
```

统一 reset reason：

```text
camera cut
resize
internal scale change
scene replace
representation/LOD change
device loss
exposure discontinuity
```

ADR-0008 的物理 `VisibilityKeyV2.meshlet_work_slot` 仅在当前 frame/queue generation 内有效，任何 history 不得跨帧比较或保存它作为 stable identity。Temporal/SSR history 使用 Velocity、MotionValidity、RepresentationChange 和各自 persistent generation；debug capture 跨帧保存 key 时必须连同可重放 queue generation，否则按 invalid 处理。

---

## 12. Temporal Reconstruction and DRS

### 12.1 Product target

正式区分：

```text
Output resolution
vs
Internal rendering resolution
```

1080p output target 不等于必须 native 1080p internal shading。

### 12.2 Inputs

```text
Internal HDR
Depth
Velocity
Reactive
Disocclusion
Surface validity
Exposure/PreExposure
Jitter
History
RepresentationChange
```

输出：

```text
Output-resolution HDR
Next history
Confidence/debug
```

### 12.3 DRS

Adaptive game mode 可在有限档位调节，例如：

```text
~0.67 → 1.0
```

具体档位由 benchmark/quality 决定。

Formal benchmark 默认：

```text
fixed internal resolution
fixed quality/budget
```

防止 DRS 隐藏 regression。

---

## 13. Transparency integration

本 ADR 当前范围不要求重写现有 Packed OIT。

透明继续共享：

```text
GpuMaterialStore
TextureResidency
clustered lighting
shadow/GI
PreExposure
Reactive
MainRenderPipeline
one submit
```

后续按内容研究：

```text
alpha test / foliage → visibility coverage path
simple alpha         → sorted/forward candidate
particles/smoke      → WBOIT candidate
layered transparent  → MBOIT candidate
water/glass          → refraction/special forward
```

所有 transparent path 输出统一 Reactive/Temporal semantics。

---

## 14. Exposure / Bloom / Post

### Exposure

优先从：

```text
FinalColorPyramid low mip
or
subgroup/workgroup histogram
```

获取 exposure input，不默认重新扫描 full-res HDR。

### Bloom

复用 `FinalColorPyramid` 或兼容专用分支，减少独立 full pyramid 与重复 HDR reads。

### FinalOutput fusion

适合研究融合：

```text
Exposure application
Bloom composite
Tone map
Color grading LUT
Sharpen
Dither
Output gamut/transfer
```

不适合把具有独立 history/resolution 的 Temporal、DOF 等盲目塞进 mega shader。

只有 bandwidth/GPU envelope、feature-off topology、variant count 都更好时保留 fusion。

---

## 15. FrameGraph physical/resource policy

### 15.1 Lifetime-aware reuse

WebGPU 下重点是：

```text
logical resource lifetime
+
descriptor-compatible reuse
```

而不是假设 Vulkan 式任意 heap aliasing。

### 15.2 `GPUTextureUsage.TRANSIENT_ATTACHMENT`

若目标浏览器/adapter 暴露 `GPUTextureUsage.TRANSIENT_ATTACHMENT` 且适用，FrameGraph 可为真正 pass-local 的 2D attachment 使用 `RENDER_ATTACHMENT | TRANSIENT_ATTACHMENT`。它不是 `GPUFeatureName`，不得加入 `requiredFeatures`。

不允许附带 sampled/storage/copy usage，不允许用于 canvas、resolve target 或后续还会 sample/load 的 Depth、History、Surface products；texture 固定单 mip/单 layer，相关 aspect 使用 clear/discard。缺失时使用普通 `RENDER_ATTACHMENT`，不改变 FrameProduct 语义。

### 15.3 Immediate Data

若目标环境同时暴露 `setImmediates()`、`GPUPipelineLayoutDescriptor.immediateSize`、足够的 `maxImmediateSize` 和 WGSL `immediate_address_space`，可用于小型 pass constants，减少：

```text
tiny UBO
writeBuffer
dynamic offset
bind group noise
```

它是 backend simplifier，不改变 FrameProduct contract。

---

## 16. FrameBudgetController

### Role

Budget Controller 不是新的资源 owner/Renderer。

读取延迟 evidence，为下一帧提供：

```text
GeometryBudget
ShadowBudget
AOBudget
SSRRayBudget
ResolutionBudget
StreamingBudget
```

Evidence 只能通过有界 cadence 的异步 timestamp/counter readback 到达 Controller。主帧不得等待 `mapAsync()`、`onSubmittedWorkDone()` 或同步 readback；evidence 缺失/延迟时保持上一份安全 budget，不能回读本帧 queue 后控制本帧可见工作。

### Fixed vs Adaptive

必须有：

```text
Fixed
```

用于 benchmark/validation。

以及：

```text
Adaptive
```

用于实际游戏运行。

Adaptive 不允许通过降质量掩盖 correctness 或 queue overflow。

### Candidate degradation order

在保证 correctness 的前提下：

```text
defer low-priority residency
↓
adjust geometry LOD budget
↓
reduce SSR/AO sample/resolution
↓
reduce shadow update
↓
adjust internal resolution
```

Visibility/Depth/core lighting correctness 不作为静默降级对象。

---

## 17. Advanced effect seams

以下不阻塞 ADR-0009 当前范围，但新 FrameProducts 必须给它们留合法插入点：

```text
Virtual Shadow Atlas / VSM
Contact Shadows
SSGI
Sparse Probe / Radiance Cache GI
Volumetric Fog
DOF
Motion Blur
Specular AA
Software VRS
Water / Refraction
Hair
Particles
```

### Shadow seam

Lighting 消费逻辑 `ShadowVisibility`，不把 consumer 锁死为 CSM。

### GI seam

Lighting 消费逻辑 `IndirectLightingProduct`，不锁死为当前某个 probe/lightmap 实现。

### VRS seam

Material Classification record 不应堵死未来：

```text
(tile, materialClass, shadingRate)
```

但第一轮不因此实现 Software VRS。

---

## 18. Migration plan

### Step 0 · Freeze cross-system Frame ABI

**Scope**

冻结逻辑语义：

```text
VisibilityProducts
GeometryProducts
ShadingSurfaceLite
HDR/PreExposure
PreExposedBaselineSpecular / Reflection Resolve
Reflection
Velocity/Reactive
ResolutionDomain
History reset
```

并完成 binding budget、`TextureBindingSet`/dispatch-class 上限和 `MaterialTileWork` ABI/overflow 合同。

允许 Three.js SSAO/SSR algorithm spike，但不切 production owner。

**Verification:** DEV + MILESTONE

**Exit**

AO/SSR/Temporal 可以只依赖稳定 product 语义，不直接依赖旧 `GpuSurfaceAbi` 全字段；SSR 能从明确的 baseline specular 生成能量正确的 complete HDR。

### Step 1 · Material Classification validation

**Scope**

```text
VisibilityKey V2
→ compute tile/class classification
→ MaterialTileWork + indirect args
→ 暂时服务 current shading consumer
```

单独验证 classification，不同时改 Surface。

**Verification:** MILESTONE + PERF

**Exit**

classifier assignment、queue/indirect ABI、occupancy 与 binding 成本明确；`unassigned/duplicate/overflow = 0`。性能只进入同一综合 benchmark/profile 的受控比较；成功继续，失败删除 candidate，不永久双 backend。

### Step 2 · Compute ShadeLighting

**Scope**

canonical vertex reconstruction、explicit gradients、`EvaluateShading()`、clustered lights/shadow/AO/GI/IBL、PreExposure。

**Verification:** MILESTONE + PERF

**Exit**

材质/光照 parity 通过；除明确不着色像素外，`full_shading_evaluations == shaded_valid_pixels`；无 duplicate/unassigned pixel、无隐性第二次完整 material resolve。

### Step 3 · SurfaceLite/HDR cutover

**Scope**

删除 albedo/emissive/full ORM 等一次性持久 attachment；freeze chosen SurfaceLite physical profile；冻结 `PreExposedOpaqueHDRBaseline` 与 SSR-only `PreExposedBaselineSpecular`；compact HDR/history candidate；consumer 迁移。

**Verification:** MILESTONE + PERF

**Exit**

生产 consumer 不再依赖 Surface V1；Surface/HDR/reflection-baseline bytes/pixel 与 GPU bandwidth evidence 达标；SSR off 时 baseline-specular 产品被裁剪；旧附件删除。

### Step 4 · Three.js SSAO replacement

**Scope**

port SSAO algorithm/math、half/internal resolution、geometric normal contract、depth-aware blur，并让 ShadeLighting 直接消费 compact AO。

**Verification:** MILESTONE + PERF

**Exit**

新 SSAO 通过目标质量与性能门禁后成为 default，旧 default AO path 删除。若该移植被证据拒绝，现有 production AO 保留到另一替代算法通过同一门禁；不得因 candidate 被拒绝就留下无 AO 的完成状态，也不得保留 `legacy/new` 双开关。

### Step 5 · Three.js SSR + Temporal + Denoise replacement

**Scope**

```text
SSR trace
TemporalReproject
RecurrentDenoise
OEngine Reflection Resolve
```

接入 Shared Depth/OpaqueColorPyramid/SurfaceLite。

**Verification:** MILESTONE + PERF

**Exit**

reflection quality/temporal stability 通过；`OpaqueHDRBaseline - BaselineSpecular + ResolvedSpecular` 数值/能量语义和 SSR-off pruning 通过；旧 SSR production path 删除。若 Three.js-derived candidate 被拒绝，现有 production SSR 保留到另一 replacement 通过，IBL fallback/correction 语义始终保持。

### Step 6 · Shared Pyramids + History Contract

**Scope**

Shared Depth/HZB、OpaqueColorPyramid、FinalColorPyramid、unified history lifecycle、exposure/bloom consumer migration。

**Verification:** MILESTONE + PERF

**Exit**

重复 pyramid/reduction 减少；consumer-off 能裁剪；无多余 submit/readback。

### Step 7 · Temporal Reconstruction / DRS

**Scope**

evolve existing TemporalFeature、output/internal domain、pre-exposure-aware history、reactive/disocclusion、DRS fixed/adaptive。

**Verification:** MILESTONE + PERF + temporal visual review

**Exit**

static detail、motion edge、MASK、transparency、SSR、camera cut、resize 稳定；benchmark fixed mode 可重复。

### Step 8 · Post fusion

**Scope**

FinalColorPyramid、exposure reduction、bloom、final output fusion candidate。

**Verification:** MILESTONE + PERF

**Exit**

减少实际 HDR roundtrip，且 feature-off/topology/debug capture 不破坏。

### Step 9 · Cutover/deletion

只有对应 replacement 已通过门禁并完成 consumer cutover 后，才删除被替换的：

```text
MaterialClassDepth
old fullscreen material resolve
Surface V1 attachments
old default AO path
old SSR path
duplicate pyramids/reductions
dead histories/counters
```

只保留确有独立产品需求和证据的算法选择，不复制主管线，不保留迁移用 `legacy/new` 开关。

**Verification:** final MILESTONE + PERF

---

## 19. Verification

公共 DEV/MILESTONE/PERF 强度、Browser Runner、证据持久化和性能比较遵循 [`VALIDATION.md`](../VALIDATION.md)。本 ADR 只增加以下领域 Gate：

- Frame ABI 与 binding budget：Frame Product semantic、resolution domain、history generation、PreExposure、velocity/reactive、class/binding-set packing 和设备 limit 必须有 oracle；capability artifact 记录最终 specialization。
- Material Classification：synthetic visibility/material map 覆盖 empty、single/multi-class、high-diversity、partial tile、invalid key 和 capacity boundary；GPU 输出必须满足 unassigned、duplicate、overflow 为零，并报告 occupancy 与 shading utilization。
- Compute ShadeLighting：triangle reconstruction、barycentric/perspective correction、explicit gradient/LOD、normal/tangent frame、PBR 与 PreExposure 只为高风险数学 seam 建 oracle；集成 Gate 证明 MASK coverage 与 full shading 分离、每个有效像素恰好完整着色一次、无第二次 material resolve。
- SurfaceLite/HDR：normal、roughness/flags、sentinel、HDR encode/decode 有 ABI oracle；候选格式只有在高光、负值语义、Bloom、SSR 和 temporal history 的质量与数值 Gate 通过后才能 cutover。
- AO/SSR 移植：来源、revision、license、adoption 和 OEngine 差异先进入 porting ledger；AO 检查 depth reconstruction、range 和 edge stopping，SSR 检查 ray boundary、confidence、history、denoise 和 IBL baseline replacement，不复制上游框架测试。
- Shared Products/History：graph oracle 必须证明 consumer-on 才生产、全部 consumer-off 时裁剪、多 consumer 共享唯一 producer、invalid history 不读取旧内容；resize、camera cut 和 recreate 覆盖 reset reason。
- Temporal/DRS：代表性 camera sequence 覆盖 static、motion、disocclusion、transparency、SSR、camera cut 和 resize；正确性与正式 A/B 使用 fixed scale，adaptive 只做 bounded/hysteresis smoke。
- Post fusion：代表性 feature 组合证明真实减少 fullscreen roundtrip 和 HDR intermediate，且 all-off、debug/capture 与 feature-off topology 不破坏；不跑完整 `2^N` 组合。

PERF 重点比较 GPU frame envelope、classification/shading/lighting/effect phase、Surface/HDR/history bytes、shading utilization、material evaluation、AO/SSR work 和 P50/P95。单个算法 candidate 先使用 MILESTONE short A/B，只有 production replacement、重大 keep/reject 或 ADR final 才进入 formal group。

---

## 20. Consequences

### Positive

- 从重型 Surface deferred bandwidth 转向 visibility-driven compute hybrid。
- 完整 opaque material shading 只在主 shading 阶段执行一次。
- AO/SSR 获得成熟开源算法基础，减少自研维护成本。
- Reflection 保持 OEngine 现有 IBL/probe baseline + SSR correction 语义。
- Shared products 避免 AO/SSR/Bloom/Exposure 各建一套相似派生资源。
- Temporal/DRS/History 形成统一产品级能力。
- 2026 WebGPU 的 subgroup/f16/Immediate Data/Transient Attachment 能力有明确落点；后两者按 API/WGSL/limit 探测，不伪装成 feature flag。

### Costs

- Compute Shading 必须显式解决 derivative/LOD/barycentric。
- Binding budget 可能成为 WebGPU 约束。
- Surface/HDR format 压缩会引入精度 tradeoff。
- Three.js 算法移植仍需要 WGSL/FrameGraph 重实现，并非复制文件即可。
- AO 使用 geometric normal 可能与 material-aware AO 产生质量差异。
- History/PreExposure contract 会波及多个 Feature。
- Post fusion 可能增加 shader variant，需要控制。

### Deferred

```text
VSM
SSGI
Sparse Probe GI
Volumetric Fog
Software VRS
Virtual Texture
advanced transparency
```

---

## 21. Porting and provenance

主要进入：

```text
docs/porting/shading.md
docs/porting/platform.md
```

Three.js 目标来源：

```text
examples/webgpu_postprocessing_ao.html
examples/webgpu_postprocessing_ssr_denoise.html
examples/jsm/tsl/display/SSAONode.js
examples/jsm/tsl/display/GTAONode.js
examples/jsm/tsl/display/SSRNode.js
examples/jsm/tsl/display/TemporalReprojectNode.js
examples/jsm/tsl/display/RecurrentDenoiseNode.js
```

移植规则：

```text
移植算法 / 数学 / 行为
不移植 Three.js TSL / NodeMaterial / Renderer ownership
```

必须记录 exact revision、MIT license notice、本地 WGSL 差异与验证。

其他研究：

```text
NRD / REBLUR concepts
FidelityFX SSSR / SPD
Playdead temporal clipping references
Filament PBR / pre-exposure / specular-AA references
```

这些不是自动依赖；先进入 porting/research ledger，再决定 direct port / reimplementation / reject。

---

## 22. Completion criteria

ADR-0009 当前范围完成时：

- Production opaque path 不再依赖 `MaterialClassDepth + active-class fullscreen material resolve`。
- `EvaluateShading()` 没有被 `SurfacePrep` 偷偷执行两次。
- MASK coverage 与 full shading 计数/语义分离。
- Surface V1 的一次性 albedo/emissive/full-ORM attachment 已退出 production。
- `ShadingSurfaceLite` 只保留下游真实需要的字段。
- HDR/PreExposure contract 在 opaque/transparency/SSR/temporal/post 中一致。
- `MaterialTileWork` ABI、capacity、GPU producer/consumer、indirect args、counter 与 overflow 行为闭合，valid pixel 恰好 shading 一次。
- `KernelClassId × TextureBindingSetId` 有界，所有 material texture 在一次 dispatch 中合法可绑定，不依赖 bindless/sized binding arrays。
- SSR 使用显式 `PreExposedBaselineSpecular` 做 replacement resolve；SSR off 时其资源和 Pass 被裁剪。
- Three.js-derived SSAO 成为约定 default AO；若被证据拒绝，必须先有另一 replacement 通过门禁，才能删除现有 production AO。
- Three.js-derived SSR+Temporal+Denoise 成为 production reflection correction；若被证据拒绝，必须先有另一 replacement 通过门禁，才能删除现有 production SSR。
- `OpaqueColorPyramid` 与 `FinalColorPyramid` 语义分开并按 consumer 创建。
- 现有 `TemporalFeature` 演化为统一 history/resolution contract，而不是出现第二套 Temporal。
- DRS benchmark 有 fixed 模式。
- 被替换的 old backend/shader/resource/history 已删除。
- `PIPELINE.md` 与 `ARCHITECTURE.md` 只在实际 cutover 后更新为当前事实。
