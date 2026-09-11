# ADR-0009 · Compute Shading 与 Advanced Frame Pipeline V2

> **Status:** accepted
> **Date:** 2026-09-11
> **Scope:** Material Classification、ShadeLighting、Surface/HDR、Three.js-derived GTAO/SSGI/SSR、Hybrid GI、Reflection、Temporal、Post、Frame Products/Budget
> **Depends on:** ADR-0008 VisibilityKey V2；ADR-0007 Texture/Geometry Runtime contracts
> **Proposed supersession:** 接受并完成 cutover 后，替代 ADR-0004 的 VisibilityKey material-class、MaterialClassDepth/fullscreen Surface Resolve 与重型 Surface 决策；此前 ADR-0004 仍是当前权威
> **Design source:** `OEngine Performance Architecture V2` Design Draft

[ADR-0011](./0011-asset-codec-and-gpu-native-texture-pipeline-v3.md) 负责产生有界 `TextureBindingSetId` 与 generation-safe material routing；本 ADR 继续负责 `KernelClassId × TextureBindingSetId` 的 GPU classification 和 consumer closure，不允许恢复 CPU visible-material list。

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
- 当前 GI 以 Brick4、Probe Volume、IBL 的全局 mode/fallback 为主，尚未定义同一 frame 内按 surface validity 选择 authoritative long-range provider 的产品合同；
- 当前没有 dynamic near-field diffuse GI；GTAO 只提供 visibility/bent normal，SSR 只负责 specular correction，二者都不能代替 SSGI；
- Three.js WebGPU SSGI 同时输出 diffuse GI 与 AO，Three.js GTAO/SSGI upstream 却都没有 OEngine 间接光消费者已经依赖的 bent-normal 输出，直接照搬会造成 IBL/specular-occlusion 退化；
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
    → direct lighting + one authoritative long-range GI provider
    → optional screen-space diffuse/specular correction
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
        │            └─ Three.js-derived GTAO（仅 mode=gtao）
        │                         ↓
        │          ScreenAmbientVisibility + BentNormal
        │
        ▼
Material Classification
        ↓
Compute ShadeLighting
  ├─ full material evaluation
  ├─ direct light / shadow
  ├─ emissive / unlit
  └─ pre-exposure
        ↓
PreExposedDirectEmissive
+ ShadingSurfaceLite
+ DiffuseSurfaceLite（仅 SSGI consumer 存在时）
        ↓
Long-range GI / baseline specular selection
  ├─ Diffuse：valid Brick4 > valid Probe Volume > IBL
  └─ Specular：valid Local Probe > IBL
        ├─ mode=off
        │    └─ ScreenAmbientVisibility=1 + ShadingNormal fallback
        │
        ├─ mode=gtao
        │    └─ 使用前置 GTAO 的 AO + BentNormal
        │
        └─ mode=ssgi
             └─ PreExposedOpaqueRadianceSource（不包含当帧 SSGI）
                    ↓
                Three.js-derived SSGI
                  ├─ SSGI.AO + BentNormal extension
                  └─ SSGI.DiffuseGI
                         ↓
                  ScreenSpaceDiffuseResolve
        ↓
PreExposedOpaqueHDRBaseline
+ PreExposedBaselineSpecular（仅 SSR consumer 存在时）
        ↓
OpaqueColorPyramid（仅反射/折射 consumer 需要时）
        ↓
Three.js-derived SSR Trace（若启用）
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

完整 opaque material shading 只能在主 `ShadeLighting` 语义中执行一次。`mode=gtao` 时，独立 GTAO 在它之前只消费 geometric/visibility data，结果可直接进入 fused long-range lighting；`mode=off` 使用 `ScreenAmbientVisibility=1` 和已求值 `ShadingNormal` fallback；`mode=ssgi` 时，SSGI 必须看到已着色 radiance source，因此 AO、bent normal 与 near-field diffuse GI 在 material evaluation 之后产生，并由 `ScreenSpaceDiffuseResolve` 合成。为避免第二次 material evaluation，SSGI topology 可以按 consumer demand 写 `DiffuseSurfaceLite`，但不得恢复无条件常驻的完整 Surface V1。

`ShadeLighting` 是一次完整材质求值语义，不要求所有 lighting composition 在所有 feature topology 下强行塞进同一个 dispatch。`mode=off|gtao` 时允许 fuse direct、long-range GI 和 baseline specular；`mode=ssgi` 时允许把 long-range diffuse/specular composition 延后到只读取 compact receiver products 的 resolve。无论采用哪种物理排布，都必须满足：

```text
full material evaluation count = shaded valid pixel count
second material evaluation count = 0
```

Three.js 的算法/数学是移植来源，TSL、NodeMaterial、RenderPipeline、RenderTarget ownership 和 example 最终 composite 都不是 OEngine 生产架构。

这里故意不让 SSGI 与 SSR 无条件共享同一颜色金字塔：SSGI 的 source 必须排除当帧 SSGI，SSR 的 scene color 则应看到已经完成 screen-space diffuse resolve 的 opaque baseline。第一版 SSGI 直接读取 full-resolution `PreExposedOpaqueRadianceSource`；若后续 benchmark 证明 SSGI 必须使用 radiance mip chain，必须新增语义独立的 `ScreenSpaceDiffuseSourcePyramid`，不能把 pre-SSGI 与 post-SSGI 两种内容伪装为同一个 `OpaqueColorPyramid`。

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
PreExposedDirectEmissive

PreExposedOpaqueRadianceSource
  only when SSGI consumes it
  excludes current-frame SSGI and screen-space AO

PreExposedOpaqueHDRBaseline

PreExposedBaselineSpecular
  only when SSR/reflection correction consumes it

ShadingSurfaceLite
  shading normal
  roughness
  surface/shading flags
  optional metallic/specular classification

DiffuseSurfaceLite
  only when SSGI receiver/composite consumes it
  diffuse reflectance / base color
  material AO
  receiver validity / flags
```

Velocity、Reactive、OcclusionConfidence 等继续作为独立 FrameProducts，不强塞进 SurfaceLite。

`PreExposedDirectEmissive` 是 SSGI topology 可按需暴露的稳定 radiance/source 分量，包含 direct lighting、emissive 与 unlit，但绝不包含当帧 SSGI 输出。它不是所有 topology 强制常驻的额外 HDR attachment；SSGI 关闭且没有其他 consumer 时允许与最终 baseline HDR 融合或物理别名。

第一版 `PreExposedOpaqueRadianceSource` 冻结为完成 material evaluation、但尚未施加 screen-space AO/SSGI 的 opaque radiance：

```text
DirectDiffuse
+ DirectSpecular
+ EmissiveOrUnlit
+ MaterialAO * SelectedLongRangeDiffuse
+ SelectedBaselineSpecular
```

这是对 Three.js SSGI `beautyNode` 的 OEngine 等价适配：允许 direct、emissive 和稳定的 long-range baseline 成为一次 screen-space bounce source，但不包含 `ScreenAmbientVisibility`、当帧 `SSGIIncidentDiffuse`、SSR correction、transparency 或 post。该 source 是逻辑产品；实现可以由已有分量数值等价地 compose，也可以在证明 bandwidth 更低时直接物理写出，但 `mode!=ssgi` 时不能留下独立 attachment。

`PreExposedOpaqueHDRBaseline` 是完成 GTAO/SSGI screen-space diffuse resolve、但尚未做 SSR correction 的完整 opaque HDR：包含 direct、emissive/unlit、resolved long-range indirect diffuse、resolved near-field SSGI diffuse（若启用），以及经过 AO/bent-normal specular-occlusion 的 Local Probe/IBL baseline specular。SSR 启用时，`ShadeLighting` 或后续 baseline resolve 额外输出同一 pre-exposure 约定的 `PreExposedBaselineSpecular`，使 Reflection Resolve 可以替换而不是叠加 baseline；SSR 关闭时不创建该额外产品，baseline HDR 直接成为 complete opaque HDR。

`DiffuseSurfaceLite` 不是恢复旧的无条件 `Albedo/AO` GBuffer。它只在 SSGI 需要 receiver diffuse reflectance/material AO 时存在，物理格式优先比较 32-bit packed/`rgba8unorm`；SSGI 关闭且没有 refraction 等其他合法 consumer 时必须被 FrameGraph 裁剪。禁止为了 SSGI 在 resolve 中重新从 VisibilityKey 完整采样材质。

### 1.4 Indirect-lighting products and provider selection

长程 diffuse GI 的逻辑产品为 `LongRangeDiffuseGI`。Provider 能力可以同时注册，但同一个 receiver 只能选择一个 authoritative provider：

```text
if valid Brick4 mapping for receiver:
    LongRangeDiffuseGI = Brick4
else if valid Probe Volume coverage for receiver:
    LongRangeDiffuseGI = ProbeVolume
else:
    LongRangeDiffuseGI = IBLDiffuse
```

这里的 `>` 表示 validity/fallback 优先级，不表示相加。目标允许同一 frame 内静态建筑选择 Brick4、动态对象选择 Probe Volume、无覆盖表面回退 IBL；不得通过三个全屏 GI pass 计算全部候选后再丢弃两个结果。第一轮若仍保留 scene-wide mode，必须把它标为迁移阶段限制，不能把全局 mode 固化为最终 FrameProduct ABI。

Provider validity 不是单个配置布尔值，而是 receiver-local、generation-safe 的解析结果：

```text
Brick4 valid
  = mapping exists
  && mapping generation matches
  && required bricks are resident
  && sample lies inside declared validity domain

ProbeVolume valid
  = volume selected
  && probe data generation matches
  && receiver lies inside valid coverage
  && required coefficients are resident

IBLDiffuse valid
  = environment product valid
  else deterministic black fallback
```

实现可以在同一 ShadeLighting/resolve kernel 内按 compact provider id 分支，也可以在性能证据支持时生成 provider-specific GPU work queue。若新增队列，必须另行冻结元素 ABI、capacity、overflow、GPU producer/consumer 和 indirect dispatch；不能由 CPU 逐 receiver 分流。无论物理策略如何，都必须输出至少以下统计：

```text
receivers_brick4
receivers_probe_volume
receivers_ibl
receivers_black_fallback
invalid_generation_count
nonresident_fallback_count
provider_unassigned_count == 0
provider_duplicate_count == 0
```

Baseline specular 独立选择：

```text
if valid local reflection probe:
    SelectedBaselineSpecular = LocalProbeSpecular
else:
    SelectedBaselineSpecular = IBLSpecular

BaselineSpecular
  = ApplySpecularOcclusion(
        SelectedBaselineSpecular,
        ResolvedAmbientVisibility,
        BentNormal,
        roughness,
        NdotV)
```

`PreExposedBaselineSpecular` 指经过上述 ambient/specular-occlusion 解析后的 fallback contribution，不是未遮蔽的 environment sample。SSR 是对它的 screen-space correction，不参与 long-range diffuse provider 选择，也不再被 `ScreenAmbientVisibility` 粗暴逐通道相乘。SSGI 是对选定 `LongRangeDiffuseGI` 的 near-field correction，不成为第二个 authoritative long-range provider。

新增逻辑 `ScreenSpaceDiffuseFrame`：

```text
ScreenAmbientVisibility scalar [0, 1], excludes MaterialAO
BentNormal              normalized world/view-space direction with explicit convention
IncidentDiffuseGI       pre-exposure-aware RGB incident radiance
Confidence/Validity     edge, miss, disocclusion and temporal trust
ResolutionDomain        internal-full or internal-half with explicit resolve owner
```

`IncidentDiffuseGI` 是 pre-exposed、未乘 receiver material color 的 irradiance-like RGB；Three.js-derived integration 已经包含 receiver-facing direction/visibility weighting，不是待逐 ray 再求一次 `N·L` 的原始 radiance。它仍需 receiver diffuse reflectance/BRDF normalization 才成为最终 outgoing diffuse contribution，但 resolve 不得重复施加方向余弦。不能把它与已经 material-modulated 的颜色混用。若实现选择直接输出 material-modulated `ResolvedNearFieldDiffuse`，必须改用不同 ABI 名称并更新 oracle，禁止同一字段在不同 topology 下改变语义。

### 1.5 Why two surface layers

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
GTAO using geometric data（mode=gtao）
   ↓
Full material evaluation once
   ↓
ShadingSurfaceLite + optional DiffuseSurfaceLite
   ↓
SSGI / SSR / temporal consumers
```

`mode=ssgi` 时 AO 与 GI 来自同一 screen-space diffuse algorithm family，发生在 radiance source 已建立之后；这不授权第二次 material evaluation。需要 receiver 数据时由第一次 evaluation 按 consumer demand 输出 compact product。

如果独立 GTAO 证明必须 material-aware normal 才满足目标质量，需要单独比较：

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
8. 处理 emissive/unlit。
9. 应用统一 pre-exposure。
10. 写后续真正需要的 `ShadingSurfaceLite` 字段。
11. SSGI consumer 存在时写 `DiffuseSurfaceLite`，否则不写。
12. `mode=gtao` topology 消费 GTAO AO/bent normal，并可 fuse authoritative long-range GI 与 baseline specular；`mode=off` 使用 `ScreenAmbientVisibility=1` 和 `ShadingNormal` fallback，不调度 AO producer。
13. `mode=ssgi` topology 写稳定 `PreExposedDirectEmissive`/radiance source 所需分量，把 long-range GI 与 AO/SSGI composition 延后到 compact receiver resolve；不得再次 `EvaluateShading()`。
14. SSR consumer 存在时单独保留 `PreExposedBaselineSpecular`；没有 consumer 时不物理化。
15. 发布 `PreExposedOpaqueHDRBaseline`，其语义不随物理 fused/unfused topology 改变。
16. 更新 shading/material/provider-selection counters。

Screen-space diffuse mode 只是同一主管线的依赖裁剪，不是多套独立 Renderer：

```text
mode = off:
  ShadeLighting(fused direct + selected long-range GI + baseline specular,
                ScreenAmbientVisibility=1, BentNormal=ShadingNormal)

mode = gtao:
  GTAO → ShadeLighting(fused direct + selected long-range GI + baseline specular)

mode = ssgi:
  ShadeLighting(material once + direct/emissive + compact receiver products)
  → full-resolution PreExposedOpaqueRadianceSource
  → SSGI AO/GI
  → ScreenSpaceDiffuseResolve(selected long-range GI + SSGI)
  → baseline specular
```

允许实现把数值等价的相邻阶段重新融合，但不能改变 FrameProduct 语义、不能让 SSGI 读取包含自身的当帧结果，也不能因 fusion 重复材质纹理采样。

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

“默认不持久化”不等于禁止合法 consumer-driven product。SSGI 必须知道 receiver diffuse reflectance/material AO；因此 `mode=ssgi` topology 可以产生独立 `DiffuseSurfaceLite`。它的创建条件、语义和删除条件必须显式：

```text
created iff SSGI/refraction-like declared consumer exists
contains receiver diffuse reflectance + material AO + validity only
must not grow back into generic full material GBuffer
must be pruned when the last consumer is disabled
```

### 6.2 What may persist

候选：

```text
shading normal
perceptual roughness
surface flags
optional metallic/specular classification
```

SSGI topology 的 companion candidate：

```text
DiffuseSurfaceLite
  linear diffuse reflectance RGB
  material AO
  receiver validity / unlit exclusion
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

`ShadingSurfaceLite` 与 `DiffuseSurfaceLite` 可以在证明总 bandwidth 更低时物理合并，但逻辑语义必须独立；SSR-only topology 不得因为物理合并而被迫写 receiver diffuse reflectance。

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

Temporal/SSGI/SSR history 也应尝试 compact HDR format；GTAO 的 scalar/bent-normal history 按自身语义选择更紧凑格式，不为统一而升格成 HDR。

目标是降低：

```text
current HDR
+
double-buffer history
+
SSR history
+
SSGI GI history
+
bloom intermediates
```

的总 bandwidth/resident，而不是只省一张 RT。

---

## 8. Screen-Space Diffuse Lighting V2 — Three.js GTAO / SSGI migration

### 8.1 Decision and mutually-exclusive topology

AO 与 screen-space diffuse GI 采用两种互斥生产拓扑，不同时运行两套 screen-space occlusion：

```text
ScreenSpaceDiffuseMode = off | gtao | ssgi
```

这是一个主管线内的依赖选择，不是三档独立 pipeline。外部配置即使仍暂时暴露 `enableGTAO`/`enableSSGI`，进入 FrameGraph 前也必须规范化为该单值 mode；`enableSSGI = true` 时 `enableGTAO` 不得再产生任何 pass/resource/history。最终公开配置应直接表达 mode，删除互相矛盾的双布尔组合。

```text
if mode == gtao:
    ScreenAmbientVisibility = Three.js-derived GTAO.AO
    NearFieldGI   = 0
    GTAO produces ScreenAmbientVisibility + BentNormal

if mode == ssgi:
    independent GTAO producer is absent
    ScreenAmbientVisibility = Three.js-derived SSGI.AO
    NearFieldGI   = Three.js-derived SSGI.GI
    SSGI produces ScreenAmbientVisibility + BentNormal extension + DiffuseGI

if mode == off:
    ScreenAmbientVisibility = 1
    BentNormal    = ShadingNormal
    NearFieldGI   = 0
    no GTAO/SSGI work or history
```

原 ADR 中“Three.js SSAO 作为默认 replacement、SSGI deferred”的决定被本节替代。生产默认 AO 算法改为 Three.js-derived GTAO；SSAO 不成为另一条常驻质量档管线。若未来极低预算确实需要 SSAO，只能作为经过同一综合 benchmark 证明的 bounded fallback candidate，不能让 GTAO/SSAO/SSGI 三套历史和资源长期并存。

Material texture 中的 AO 与 screen-space AO 是不同语义。启用 SSGI 时只关闭独立 GTAO，不关闭 Material AO：

```text
MaterialAO        = authored/local cavity occlusion
ScreenAmbientVisibility = GTAO.AO or SSGI.AO or 1 when mode=off
ResolvedAmbientVisibility = MaterialAO * ScreenAmbientVisibility
```

### 8.2 Upstream facts that constrain the port

Three.js GTAO 来源：

```text
examples/webgpu_postprocessing_ao.html
examples/jsm/tsl/display/GTAONode.js
```

设计核对链接：[GTAO example](https://github.com/mrdoob/three.js/blob/148ef33ecb6d2502ff796d4554abd1549c95d519/examples/webgpu_postprocessing_ao.html)、[`GTAONode.js`](https://github.com/mrdoob/three.js/blob/148ef33ecb6d2502ff796d4554abd1549c95d519/examples/jsm/tsl/display/GTAONode.js)。

其核心是 horizon/slice integration、sample/step distribution 与 spatiotemporal jitter。上游 `GTAONode` 输出单通道 AO，不输出 bent normal；示例通过 `TRAANode` 对带时域扰动的 GTAO 最终画面降噪，并提示 half resolution 是推荐起点。

Three.js SSGI 来源：

```text
examples/webgpu_postprocessing_ssgi.html
examples/jsm/tsl/display/SSGINode.js
```

设计核对链接：[SSGI example](https://github.com/mrdoob/three.js/blob/148ef33ecb6d2502ff796d4554abd1549c95d519/examples/webgpu_postprocessing_ssgi.html)、[`SSGINode.js`](https://github.com/mrdoob/three.js/blob/148ef33ecb6d2502ff796d4554abd1549c95d519/examples/jsm/tsl/display/SSGINode.js)。

上游 `SSGINode` 同一算法产生两个逻辑结果：

```text
SSGI.AO  : scalar ambient visibility
SSGI.GI  : RGB incident/indirect diffuse lighting
```

当前 upstream 物理 attachment 使用单通道 unsigned normalized AO，以及 `RGB11F/R11G11B10` 类 GI target；WebGPU backend 在 `rg11b10ufloat-renderable` 不可用时需要兼容格式。上游示例以 `sceneColor * AO + diffuseColor * GI` 合成并用 `TRAANode` 稳定结果，但该 example composite 不是 OEngine 的能量合同。

Three.js upstream 的 GTAO/SSGI 都没有输出 OEngine 当前 IBL/GI/specular-occlusion consumer 所需的 bent normal。因此“移植 Three.js”明确包含 OEngine-specific bent-normal extension；不允许以 upstream 没有该 attachment 为由删除现有产品语义。

### 8.3 OEngine AO and diffuse-GI energy contract

AO 不是对 complete HDR 的通用乘数。冻结以下逻辑语义：

```text
SelectedLongRangeDiffuse = Select(Brick4, ProbeVolume, IBLDiffuse)

ResolvedLongRangeDiffuse
  = ResolvedAmbientVisibility * SelectedLongRangeDiffuse

ResolvedNearFieldDiffuse
  = MaterialAO
  * EvaluateDiffuseReceiver(DiffuseSurfaceLite.diffuseReflectance,
                            SSGIIncidentDiffuse)

ResolvedBaselineSpecular
  = ApplySpecularOcclusion(SelectedBaselineSpecular,
                           ResolvedAmbientVisibility,
                           BentNormal,
                           roughness,
                           NdotV)

OpaqueHDRBaseline
  = DirectDiffuse
  + DirectSpecular
  + EmissiveOrUnlit
  + ResolvedLongRangeDiffuse
  + ResolvedNearFieldDiffuse
  + ResolvedBaselineSpecular
```

禁止：

```text
CompleteSceneColor *= ScreenAmbientVisibility
Brick4 + ProbeVolume + IBLDiffuse
SelectedLongRangeDiffuse + a second unclassified long-range provider
SSGIIncidentDiffuse + material-modulated SSGI result
```

Three.js example 的 `sceneColor * AO` 会在它自己的示例资源分解下工作；OEngine 已经拥有 direct/indirect/baseline 语义，因此不得让 AO 无差别压暗 direct lighting、emissive、unlit 或已经单独解析的 SSR correction。Screen AO 与 bent normal 仍可进入明确的 baseline specular-occlusion 函数；这不是对 complete HDR 的通用乘法。

Material AO 同时调制 long-range indirect diffuse 与 near-field SSGI diffuse，因为它表达当前 receiver 的材质/微遮蔽；它不调制 direct、emissive 或 unlit。`ScreenAmbientVisibility` 不再二次乘 `SSGIIncidentDiffuse`，因为 SSGI ray integration 已经表达近场可见性。任何改变这一能量合同的实现都必须形成新的 ADR 变更，不能让不同 Shader 自行选择。

### 8.4 Three.js-derived GTAO production path

移植算法/行为：

```text
horizon/slice integration
direction and step distribution
world/view-space radius behavior
depth and normal sampling
spatiotemporal direction/offset jitter
distance falloff and thickness/bias semantics
```

保留/适配 OEngine：

```text
Shared Depth/HZB and GeometricNormal inputs
WGSL implementation
AOService/FrameGraph ownership
internal-half/internal-full ResolutionDomain
TemporalHistoryRegistry and invalidation
joint edge-aware resolve where retained by evidence
ScreenAmbientVisibility + BentNormal output contract
one main submit
feature-off pruning
debug views/counters
```

不移植：

```text
TSL
NodeMaterial / QuadMesh
Three.js pass/RenderTarget ownership
builtinAOContext
dedicated Three RenderPipeline
an additional full-frame TRAA owner solely for AO
```

GTAO 的 bent normal 必须从相同 horizon visibility 信息累计或由数学等价的同-pass extension 产生；不能为了 bent normal 继续后台运行旧 GTAO。若 compact AO 在 half resolution 产生，full-resolution consumer 需要的 AO/bent-normal joint resolve 必须有唯一 owner，且比较直接 half-res sampling 与 full-res resolved product 的总成本和边缘稳定性。

### 8.5 Three.js-derived SSGI production path

SSGI 是 dynamic near-field diffuse correction，不替代 Brick4、Probe Volume 或 IBL long-range baseline。输入合同：

```text
PreExposedOpaqueRadianceSource（第一版为 full-resolution input）
Depth / Shared HZB where adopted
ShadingSurfaceLite.normal
DiffuseSurfaceLite.diffuseReflectance + materialAO
Velocity / motion validity
camera matrices and physical radius scale
history validity / pre-exposure delta
```

`PreExposedOpaqueRadianceSource` 必须是稳定、可重放的当帧 source：

```text
includes direct diffuse/specular + emissive/unlit
includes MaterialAO-modulated selected long-range diffuse + unoccluded selected baseline specular
excludes screen-space AO
excludes current-frame SSGI result
excludes post/transparent color unless a later decision explicitly changes the bounce domain
uses the same pre-exposure convention as SSGI output/history
```

禁止形成：

```text
SSGI output → same-frame SSGI source
history SSGI with undeclared exposure conversion → current source
complete final HDR → implicit uncontrolled multi-bounce feedback
```

第一轮移植保留 Three.js 的 hemisphere slice/step sampling、screen/world-space radius、thickness、backface-lighting control、AO/GI 双输出和 temporal sampling invariants。质量/性能默认候选从 upstream example 的低 slice、有限 step、internal-half/internal-resolution 开始，但具体数字必须由综合 benchmark 冻结，不能把 example GUI 默认值当产品合同。

输出合同：

```text
SSGI.ScreenAmbientVisibility : compact scalar, excludes MaterialAO
SSGI.BentNormal        : OEngine extension, normalized and validity-tagged
SSGI.IncidentDiffuseGI : pre-exposed RGB
SSGI.Confidence        : miss/edge/disocclusion/history trust
```

物理格式优先比较：

```text
AO                 r8unorm
GI                 rg11b10ufloat when renderable/filterable requirements pass
GI fallback        rgba16float
BentNormal         packed 32-bit or shared SurfaceLite-compatible encoding
Confidence         packed with another product only if semantic/lifetime match
```

`rg11b10ufloat-renderable` 必须按 `GPUFeatureName` 能力门控；fallback 改变物理格式但不改变 FrameProduct 语义。若 AO、bent normal、GI 和 confidence 能通过 MRT/packing 减少 roundtrip，仍需遵守 adapter 的 color-attachment byte/binding limits。

SSGI bent-normal extension 必须复用本算法已经计算的 horizon/occluded-direction information，在同一 trace 或同一数据生命周期内累计未遮挡方向并归一化；不得另跑完整 GTAO。背景、无有效深度、法线退化或有效方向权重不足时，`BentNormal = SSGIInputNormal` 且 validity 明确为 fallback，不能写未定义向量。`SSGIInputNormal` 第一版即 `ShadingSurfaceLite.normal`；AO、GI 与 bent normal 必须使用相同 depth/thickness/radius domain，避免 AO 判定遮挡而 bent normal 仍指向遮挡体。

### 8.6 SSGI/GTAO temporal ownership

Three.js GTAO/SSGI example 依赖 TRAA 稳定噪声，不表示 OEngine 要引入第二个 Three-style temporal subsystem。OEngine 继续使用 `TemporalHistoryRegistry`，为 AO/SSGI 声明独立 history semantic、resolution、generation、pre-exposure、camera-cut/resize reset，并允许最终 TAA/NSS 继续处理成像边缘。

必须明确区分：

```text
effect temporal accumulation
  stabilizes AO/GI estimate before lighting composite

final temporal reconstruction
  stabilizes/upscales complete frame
```

二者可以共享 velocity、disocclusion、classification 与 history lifecycle，但不能把 noisy SSGI 原样留给最终 TAA，假设 final temporal 会自动成为足够的 GI denoiser。若 evidence 证明只保留一种时域阶段更优，必须用相同 motion/disocclusion workload 验证并删除另一阶段，而不是隐式叠加两个不透明 history weight。

### 8.7 Feature topology and zero-cost-off rules

拓扑必须满足：

```text
mode = gtao:
  no SSGI GI/AO/bent/confidence target
  no SSGI history
  no DiffuseSurfaceLite solely for SSGI

mode = ssgi:
  no independent GTAO pass
  no GTAO-only history/resolve
  SSGI owns screen AO + near-field diffuse GI

mode = off:
  ScreenAmbientVisibility = 1
  BentNormal = ShadingNormal
  no AO/SSGI pass, target, history or readback
```

Material AO 仍由第一次 `EvaluateShading()` 读取；feature off 只移除 screen-space producer，不修改 authored material semantics。

### 8.8 Port boundary and provenance

Three.js 为 MIT。ADR 设计核对时使用的 upstream master revision 为：

```text
148ef33ecb6d2502ff796d4554abd1549c95d519
```

正式实现前必须在 `docs/porting/shading.md` 登记 GTAO 与 SSGI 的 exact adopted revision、源码路径、license、保留数学不变量、OEngine WGSL/FrameGraph 差异和未采用部分。若实现开始时选择更新 revision，需要重新核对输出格式、temporal dependency、sampling 语义与 example composite，不能静默跟随 mutable `master`。

---

## 9. SSR V2 — Three.js SSR + Temporal + Recurrent Denoise

### 9.1 Decision

生产 SSR replacement 优先移植 Three.js WebGPU SSR denoise example 的算法部分，并替换当前 production SSR 的 trace/temporal/denoise 实现：

```text
examples/webgpu_postprocessing_ssr_denoise.html

SSRNode.js
TemporalReprojectNode.js
RecurrentDenoiseNode.js
```

设计核对链接：[SSR denoise example](https://github.com/mrdoob/three.js/blob/148ef33ecb6d2502ff796d4554abd1549c95d519/examples/webgpu_postprocessing_ssr_denoise.html)、[`SSRNode.js`](https://github.com/mrdoob/three.js/blob/148ef33ecb6d2502ff796d4554abd1549c95d519/examples/jsm/tsl/display/SSRNode.js)、[`TemporalReprojectNode.js`](https://github.com/mrdoob/three.js/blob/148ef33ecb6d2502ff796d4554abd1549c95d519/examples/jsm/tsl/display/TemporalReprojectNode.js)、[`RecurrentDenoiseNode.js`](https://github.com/mrdoob/three.js/blob/148ef33ecb6d2502ff796d4554abd1549c95d519/examples/jsm/tsl/display/RecurrentDenoiseNode.js)。

目标：

```text
Stochastic GGX SSR
→ Temporal Reprojection
→ Recurrent Denoise
→ OEngine Reflection Resolve
```

替换的是 SSR 算法核与过滤链，不是 OEngine 的资源所有权和反射语义。以下能力继续由 OEngine 保有：

```text
ReflectionService / FrameGraph scheduling
Shared Depth / HZB
ShadingSurfaceLite ABI
OpaqueColorPyramid ownership
TemporalHistoryRegistry
PreExposure contract
Local Reflection Probe / IBL fallback
confidence-based replacement resolve
feature topology / counters / debug views
one-submit frame ownership
```

Three.js 只作为可追溯的算法和行为来源；不得引入 TSL、NodeMaterial、`RenderPipeline`、`QuadMesh`、Three render target lifecycle 或它的最终示例 composite。

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

生产 trace 输入至少包括：

```text
OpaqueColorPyramid（post-SSGI opaque baseline）
Depth / LinearDepth / HZB
ShadingSurfaceLite.normal
ShadingSurfaceLite.perceptualRoughness
Velocity / MotionValidity
camera/projection constants
```

trace 输出不是“可直接相加的反射色”，而是：

```text
SSRSpecular
HitDistance / RayLength
TraceConfidence
Miss / Edge / Validity flags
```

roughness cutoff、最大距离、thickness、步数、binary refinement 与 internal resolution 都属于有界 budget，不能散落为互相矛盾的 Shader 常量。

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

Three.js example 为突出 SSR，显式压掉 lighting model 的 environment/indirect specular，再把 SSR 加回 scene color。该做法是 example composition，不是 OEngine production contract；直接照搬会使 SSR miss、屏幕外信息、遮挡边缘与粗糙表面失去 Local Probe/IBL fallback。

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

`SSRConfidence` 必须同时受 trace hit、view/normal orientation、screen edge、roughness validity、ray length、disocclusion 与 temporal confidence 约束。miss 或 invalid history 时 confidence 回到 `0`，从而确定性回退 `BaselineSpecular`；不得把黑色 SSR miss 当成有效反射写入。

禁止简单：

```text
LitHDR + SSR
```

造成 double energy。

SSR 关闭时不创建 `PreExposedBaselineSpecular`、trace/denoise/resolve 产品，`PreExposedOpaqueHDRBaseline` 直接别名/发布为 complete opaque HDR，保持 feature-off 近零成本。

### 9.6 Early integration spike

允许在 production cutover 前创建**非生产 example/validation spike**，提前验证 Three.js GTAO/SSGI/SSR 算法质量。

但 production owner cutover 必须等：

```text
FrameProducts
HDR/PreExposure
SurfaceLite inputs
```

稳定，避免迁两次接口。

### 9.7 Port boundary and provenance

ADR 设计核对使用与 8.8 相同的 Three.js upstream master revision：

```text
148ef33ecb6d2502ff796d4554abd1549c95d519
```

正式实现必须在 `docs/porting/shading.md` 分别登记 `SSRNode.js`、`TemporalReprojectNode.js` 与 `RecurrentDenoiseNode.js` 的 exact adopted revision、源码路径、license、保留不变量、未采用的 Three framework 部分，以及 OEngine 在 HZB、velocity、pre-exposure、history validation 和 reflection resolve 上的差异。若 adopted revision 变化，必须重新检查 shader inputs、输出置信度和 example composition。

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
ShadeLighting
→ authoritative long-range diffuse selection
→ GTAO or SSGI diffuse resolve
→ PreExposedOpaqueHDRBaseline
↓
before SSR correction
```

Mip 0 的语义是已经包含 direct、emissive、选定 long-range diffuse、screen-space AO/SSGI correction 和 Local Probe/IBL baseline specular 的 `PreExposedOpaqueHDRBaseline`。它可以直接复用该 texture，或由明确 compose/downsample owner 从分量生成；不能把缺少 baseline specular 或缺少已经启用的 SSGI diffuse correction 的颜色冒充 SSR scene-color source。

消费者：

```text
SSR
refraction（未来按显式依赖接入）
```

SSGI 不默认消费该 product，因为它必须读取不包含当帧 SSGI 的 source。如果先将当帧 SSGI 写进 Mip 0，再由 SSGI 读取，会形成同帧 feedback；如果为了避开 feedback 把 Mip 0 改成 pre-SSGI，又会让 SSR 看不到已经完成的 opaque diffuse result。因此冻结两个不同语义：

```text
PreExposedOpaqueRadianceSource
  full-resolution, pre-SSGI, SSGI input, excludes current-frame SSGI

OpaqueColorPyramid
  mipmapped, post-screen-space-diffuse, SSR/refraction input,
  excludes current-frame SSR correction
```

第一版 SSGI 直接读取 full-resolution source。只有采样/质量 benchmark 证明 mip chain 对 SSGI 必要时，才增加 `ScreenSpaceDiffuseSourcePyramid`。该 product 必须独立声明 producer、consumer、格式、生成时点、字节成本和 off-pruning；`mode!=ssgi` 时不创建。由于它与 post-screen-space-diffuse `OpaqueColorPyramid` 在同一 SSGI frame 中内容版本不同，不得以相同 logical product 或同时可读的物理 alias 冒充共享。

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

“Shared”指同一语义的多个 consumer 共享唯一 producer，不代表把不同生成时点、不同 exposure domain 或不同内容版本强行合并。每个 pyramid 必须用 semantic/version 标识 source generation；debug/capture 应能显示 source stage，防止 pre-SSGI、post-SSGI、post-SSR 与 post-temporal 颜色被错误互换。

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
GTAO history（仅 GTAO topology）
SSGI AO/GI/bent/confidence histories（仅 SSGI topology）
Exposure
```

GTAO 与 SSGI 的 screen-space AO owner 互斥，因此它们的 history allocation 也互斥。模式切换必须递增相应 semantic generation 并清空/作废旧 history；即使分辨率和物理格式碰巧相同，也不能把 GTAO scalar visibility history 当成 SSGI AO/GI history 直接继承。允许 FrameGraph 在 lifetime 不重叠且 descriptor 兼容时复用物理 texture，但逻辑 history identity 必须保持分离。

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

ADR-0008 的物理 `VisibilityKeyV2.meshlet_work_slot` 仅在当前 frame/queue generation 内有效，任何 history 不得跨帧比较或保存它作为 stable identity。Temporal、GTAO、SSGI 与 SSR history 使用 Velocity、MotionValidity、RepresentationChange 和各自 persistent generation；debug capture 跨帧保存 key 时必须连同可重放 queue generation，否则按 invalid 处理。

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
ScreenSpaceDiffuseBudget
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

`ScreenSpaceDiffuseBudget` 只在当前 `ScreenSpaceDiffuseMode` 内调节已冻结的 bounded knobs，例如 internal scale、slice/step count、temporal update cadence 和可接受 ray radius；它不能在没有显式产品策略时自动把 `ssgi` 切成 `gtao`，因为两者的 GI 能量、history semantic 和最终画面不是同一种质量参数。任何 mode 切换都按拓扑变更处理：重建依赖、递增 history generation，并记录可观测 reason。

### Candidate degradation order

在保证 correctness 的前提下：

```text
defer low-priority residency
↓
adjust geometry LOD budget
↓
reduce SSGI/GTAO/SSR sample count or internal resolution within frozen bounds
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

Lighting 消费逻辑 `LongRangeDiffuseGI`，按 receiver validity 在 Brick4、Probe Volume、IBL 中只选择一个 authoritative provider；不得让每个 provider 都跑一遍 fullscreen shading 后相加。SSGI 作为独立 `ScreenSpaceDiffuseFrame` 只做 near-field correction，并通过 `DiffuseSurfaceLite` 在单独 resolve 中施加 receiver BRDF。未来 Sparse Probe/Radiance Cache 可以替换或参与 long-range provider selection，但不能静默成为第四个叠加项。

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
DiffuseSurfaceLite（consumer-driven）
HDR/PreExposure
PreExposedOpaqueRadianceSource
ScreenSpaceDiffuseFrame
LongRangeDiffuseGI provider selection
PreExposedBaselineSpecular / Reflection Resolve
Reflection
Velocity/Reactive
ResolutionDomain
History reset
```

并完成 binding budget、`TextureBindingSet`/dispatch-class 上限和 `MaterialTileWork` ABI/overflow 合同。

允许 Three.js GTAO/SSGI/SSR algorithm spike，但不切 production owner。

**Verification:** DEV + MILESTONE

**Exit**

GTAO/SSGI/SSR/Temporal 可以只依赖稳定 product 语义，不直接依赖旧 `GpuSurfaceAbi` 全字段；SSGI source 明确排除当帧 SSGI，SSR 能从明确的 baseline specular 生成能量正确的 complete HDR；Brick4/Probe Volume/IBL 的 provider precedence 与 validity 语义已冻结。

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

canonical vertex reconstruction、explicit gradients、`EvaluateShading()`、clustered lights/shadow、long-range GI/IBL、PreExposure，以及按 topology 输出 `PreExposedDirectEmissive`、`ShadingSurfaceLite`、`DiffuseSurfaceLite`、`PreExposedBaselineSpecular`。

**Verification:** MILESTONE + PERF

**Exit**

材质/光照 parity 通过；除明确不着色像素外，`full_shading_evaluations == shaded_valid_pixels`；无 duplicate/unassigned pixel、无隐性第二次完整 material resolve；consumer-off 时对应 companion product 不分配、不写入。

### Step 3 · SurfaceLite/HDR cutover

**Scope**

删除无 consumer 的 albedo/emissive/full ORM 等一次性持久 attachment；freeze chosen `ShadingSurfaceLite` 和 conditional `DiffuseSurfaceLite` physical profile；冻结 `PreExposedOpaqueRadianceSource`、`PreExposedOpaqueHDRBaseline` 与 SSR-only `PreExposedBaselineSpecular`；compact HDR/history candidate；consumer 迁移。

**Verification:** MILESTONE + PERF

**Exit**

生产 consumer 不再依赖 Surface V1；Surface/HDR/reflection-baseline bytes/pixel 与 GPU bandwidth evidence 达标；`mode!=ssgi` 时 `DiffuseSurfaceLite` 和 pre-SSGI radiance source 的独立物理 attachment 被裁剪或合法融合，SSR off 时 baseline-specular 产品被裁剪；旧附件删除。

### Step 4 · Three.js-derived GTAO replacement

**Scope**

移植 Three.js `GTAONode` 的 horizon/slice 数学、sampling distribution、radius/thickness/falloff、depth/normal reconstruction，并用 OEngine FrameGraph、Shared Depth/HZB、resolution domain 和 temporal/history owner 实现。扩展同一 GTAO producer 输出 `ScreenAmbientVisibility + BentNormal`，保留 joint depth/normal resolve；不得为了 bent normal 继续运行旧 GTAO，也不得引入第二套 Three.js TRAA/RenderTarget owner。

**Verification:** MILESTONE + PERF

**Exit**

Three.js-derived GTAO 的 AO、bent normal、temporal stability、thin geometry/edge correctness 与综合性能通过门禁后成为 `mode=gtao` topology 的唯一 production screen-space AO，旧 AO algorithm path 删除。若 candidate 被证据拒绝，现有 production GTAO 保留到另一 replacement 通过同一门禁；不得留下无 AO 的完成状态，也不得长期保留 `legacy/new` 双开关。

### Step 5 · Three.js-derived SSGI integration

**Scope**

移植 `SSGINode` 的 hemisphere slice/step tracing、radius/thickness/backface control、AO/GI dual output 与 stochastic invariants；输入接入 full-resolution `PreExposedOpaqueRadianceSource`、Shared Depth/HZB、geometric normal、Velocity 与 conditional `DiffuseSurfaceLite`。在 OEngine history owner 中实现 AO/GI/bent/confidence 的 temporal filtering，并以 `ScreenSpaceDiffuseResolve` 完成长程 GI baseline 与 near-field GI 的能量正确组合。

同时把 GI owner 从 scene-wide exclusive mode 演进为 receiver-level validity selection：

```text
valid Brick4 > valid Probe Volume > IBL
```

这表示按接收点选择一个 long-range provider，不表示三个 provider 都做 fullscreen work。`mode=ssgi` 时独立 GTAO 的 pass、targets、history、counters 必须全部裁剪；`mode!=ssgi` 时 SSGI、`DiffuseSurfaceLite` 和其专用 history 必须全部裁剪。

**Verification:** MILESTONE + PERF + temporal visual review

**Exit**

SSGI 同时成为 near-field diffuse GI 与 screen AO 的唯一 owner；bent-normal extension 不低于被替换 AO 合同；无同帧 self-feedback、无第二次完整 material evaluation、无 `CompleteHDR *= AO`、无 Brick4/Probe/IBL 全部叠加；SSGI/GTAO 两种 topology 的 graph pruning、history reset 和综合 benchmark 均通过。

### Step 6 · Three.js SSR + Temporal + Denoise replacement

**Scope**

```text
SSR trace
TemporalReproject
RecurrentDenoise
OEngine Reflection Resolve
```

接入 Shared Depth/HZB、post-screen-space-diffuse `OpaqueColorPyramid`、`ShadingSurfaceLite`、Velocity 与 OEngine History Contract。Three example 的 environment-specular suppression 不进入生产 composite。

**Verification:** MILESTONE + PERF

**Exit**

reflection quality/temporal stability 通过；miss/edge/roughness/disocclusion confidence 能确定性回退 Local Probe/IBL；`OpaqueHDRBaseline - BaselineSpecular + ResolvedSpecular` 数值/能量语义和 SSR-off pruning 通过；旧 SSR production path 删除。若 Three.js-derived candidate 被拒绝，现有 production SSR 保留到另一 replacement 通过，baseline fallback/correction 语义始终保持。

### Step 7 · Shared Pyramids + History Contract

**Scope**

Shared Depth/HZB、post-screen-space-diffuse `OpaqueColorPyramid`、`FinalColorPyramid`、unified GTAO/SSGI/SSR/temporal history lifecycle、exposure/bloom consumer migration。若 SSGI radiance mip chain 经证据获准，增加语义独立的 `ScreenSpaceDiffuseSourcePyramid`。

**Verification:** MILESTONE + PERF

**Exit**

同语义重复 pyramid/reduction 减少；pre-SSGI 与 post-SSGI source 不混淆；consumer-off 能裁剪；无多余 submit/readback。

### Step 8 · Temporal Reconstruction / DRS

**Scope**

evolve existing TemporalFeature、output/internal domain、pre-exposure-aware history、reactive/disocclusion、DRS fixed/adaptive。

**Verification:** MILESTONE + PERF + temporal visual review

**Exit**

static detail、motion edge、MASK、transparency、SSR、camera cut、resize 稳定；benchmark fixed mode 可重复。

### Step 9 · Post fusion

**Scope**

FinalColorPyramid、exposure reduction、bloom、final output fusion candidate。

**Verification:** MILESTONE + PERF

**Exit**

减少实际 HDR roundtrip，且 feature-off/topology/debug capture 不破坏。

### Step 10 · Cutover/deletion

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

同时删除仅为迁移存在的 scene-wide GI exclusive plumbing；若仍需保留 coarse scene default，它只能作为 provider availability/default policy，不能绕过 receiver-level selection ABI。

只保留确有独立产品需求和证据的算法选择，不复制主管线，不保留迁移用 `legacy/new` 开关。

**Verification:** final MILESTONE + PERF

---

## 19. Verification

公共 DEV/MILESTONE/PERF 强度、Browser Runner、证据持久化和性能比较遵循 [`VALIDATION.md`](../VALIDATION.md)。本 ADR 只增加以下领域 Gate：

- Frame ABI 与 binding budget：Frame Product semantic、resolution domain、history generation、PreExposure、velocity/reactive、class/binding-set packing 和设备 limit 必须有 oracle；capability artifact 记录最终 specialization。
- Material Classification：synthetic visibility/material map 覆盖 empty、single/multi-class、high-diversity、partial tile、invalid key 和 capacity boundary；GPU 输出必须满足 unassigned、duplicate、overflow 为零，并报告 occupancy 与 shading utilization。
- Compute ShadeLighting：triangle reconstruction、barycentric/perspective correction、explicit gradient/LOD、normal/tangent frame、PBR 与 PreExposure 只为高风险数学 seam 建 oracle；集成 Gate 证明 MASK coverage 与 full shading 分离、每个有效像素恰好完整着色一次、无第二次 material resolve。
- SurfaceLite/HDR：normal、roughness/flags、sentinel、HDR encode/decode 有 ABI oracle；候选格式只有在高光、负值语义、Bloom、SSR 和 temporal history 的质量与数值 Gate 通过后才能 cutover。
- GTAO 移植：来源、revision、license、adoption 和 OEngine 差异先进入 porting ledger；数值 oracle 覆盖 depth reconstruction、horizon/range/falloff、edge stopping、AO 与 bent-normal normalization/validity；浏览器示例覆盖 thin geometry、近远景交界、移动物体、camera cut 和 half/internal resolve。必须证明旧 AO producer 已退出 production，不能只验证一个孤立 candidate pass。
- SSGI 移植与 GI 组合：固定场景分别覆盖无 probe、IBL-only、Probe Volume valid/invalid、Brick4 valid/invalid、动态遮挡物、屏幕边界、disocclusion、高反照率与 emissive source。oracle/计数器必须证明每个 receiver 只选择一个 long-range provider，SSGI source 不含当帧 SSGI，独立 GTAO 在 `mode=ssgi` 时 work count 为零，`DiffuseSurfaceLite` 在 `mode!=ssgi` 时无独立写入；画面对比必须检查 AO 不压暗 direct/emissive/unlit，near-field GI 不被重复 receiver modulation。
- SSR 移植：检查 ray boundary、roughness cutoff、hit distance、trace/temporal confidence、history rejection、denoise、pre-exposure 和 baseline replacement。内容 Gate 覆盖屏外/miss、粗糙表面、Local Probe/IBL fallback、快速相机和动态物体；不得以 Three example 的 environment suppression 作为正确性 oracle。
- Feature topology matrix：至少验证 `mode=gtao + SSR off/on`、`mode=ssgi + SSR off/on`、`mode=off + SSR off/on`，并额外验证迁移期矛盾输入 `enableGTAO=true + enableSSGI=true` 被规范化为 `mode=ssgi`。每种组合记录实际 pass、texture、history、dispatch、bytes 与 counter，证明关闭功能接近零成本，而不是只看最终截图。
- Shared Products/History：graph oracle 必须证明 consumer-on 才生产、全部 consumer-off 时裁剪、同语义多 consumer 共享唯一 producer、不同 source stage 不错误别名、invalid history 不读取旧内容；GTAO↔SSGI 切换、resize、camera cut、recreate 与 pre-exposure discontinuity 覆盖 reset reason。
- Temporal/DRS：代表性 camera sequence 覆盖 static、motion、disocclusion、transparency、SSGI、SSR、camera cut 和 resize；正确性与正式 A/B 使用 fixed scale，adaptive 只做 bounded/hysteresis smoke。
- Post fusion：代表性 feature 组合证明真实减少 fullscreen roundtrip 和 HDR intermediate，且 all-off、debug/capture 与 feature-off topology 不破坏；不跑完整 `2^N` 组合。

PERF 重点比较 GPU frame envelope、classification/shading/lighting/effect phase、Surface/HDR/history bytes、shading utilization、material evaluation、GTAO/SSGI/SSR work 和 P50/P95。综合 workload 必须固定 adapter、分辨率/DPR、internal scale、warm-up、camera path、内容、feature topology 和 budget；不要求双基准体系。单个算法 candidate 先使用 MILESTONE short A/B，只有 production replacement、重大 keep/reject 或 ADR final 才进入 formal group。

---

## 20. Consequences

### Positive

- 从重型 Surface deferred bandwidth 转向 visibility-driven compute hybrid。
- 完整 opaque material shading 只在主 shading 阶段执行一次。
- GTAO/SSGI/SSR 获得同一成熟 WebGPU reference family 的算法基础，减少自研数学与验证盲区。
- SSGI 提供 dynamic near-field diffuse GI，同时与 Brick4/Probe Volume/IBL 的 long-range 职责分开。
- GTAO 与 SSGI 互斥拥有 screen AO，避免双重遮蔽和重复 pass。
- Reflection 保持 OEngine 现有 IBL/probe baseline + SSR correction 语义。
- receiver-level GI provider selection 允许同帧不同区域使用最有效的 long-range source，而不把所有 GI 全量叠加。
- Shared products 避免同语义的 AO/SSR/Bloom/Exposure 派生资源重复建设，同时保留 pre/post-SSGI source 边界。
- Temporal/DRS/History 形成统一产品级能力。
- 2026 WebGPU 的 subgroup/f16/Immediate Data/Transient Attachment 能力有明确落点；后两者按 API/WGSL/limit 探测，不伪装成 feature flag。

### Costs

- Compute Shading 必须显式解决 derivative/LOD/barycentric。
- Binding budget 可能成为 WebGPU 约束。
- Surface/HDR format 压缩会引入精度 tradeoff。
- Three.js 算法移植仍需要 WGSL/FrameGraph 重实现，并非复制文件即可。
- Three GTAO/SSGI 没有现成 bent-normal output，OEngine 必须维护并验证自有扩展。
- SSGI 增加 radiance source、conditional receiver data、history 和 resolve 成本；与 final temporal 之间需要明确去噪职责。
- receiver-level GI provider selection 要求 Brick4/Probe Volume/IBL 统一 validity、优先级和计数合同。
- History/PreExposure contract 会波及多个 Feature。
- Post fusion 可能增加 shader variant，需要控制。

### Deferred

```text
VSM
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
examples/webgpu_postprocessing_ssgi.html
examples/webgpu_postprocessing_ssr_denoise.html
examples/jsm/tsl/display/GTAONode.js
examples/jsm/tsl/display/SSGINode.js
examples/jsm/tsl/display/SSRNode.js
examples/jsm/tsl/display/TemporalReprojectNode.js
examples/jsm/tsl/display/RecurrentDenoiseNode.js
```

本 ADR 设计时核对 revision：

```text
three.js master @ 148ef33ecb6d2502ff796d4554abd1549c95d519
```

它只用于让设计讨论可复现，不自动锁定未来实现 revision。开始每个 port 时必须在 ledger 冻结 actual adopted revision；若不同于此 SHA，需要重做相应 upstream 差异核对。

移植规则：

```text
移植算法 / 数学 / 行为
不移植 Three.js TSL / NodeMaterial / Renderer ownership
不移植 example 的 environment suppression、sceneColor 全局乘 AO 或 render-target lifecycle
OEngine-specific bent-normal、provider selection、PreExposure、history 和 correction resolve 明确记录为本地扩展
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
- Three.js-derived GTAO 成为 `mode=gtao` topology 的唯一 production screen-space AO，并从同一算法 producer 输出 `ScreenAmbientVisibility + BentNormal`；若被证据拒绝，必须先有另一 replacement 通过门禁，才能删除现有 production AO。
- `ScreenSpaceDiffuseMode = off | gtao | ssgi` 是唯一规范化 topology；迁移期矛盾布尔配置不能产生 GTAO+SSGI 双 producer，mode 切换会重置对应 history generation。
- Three.js-derived SSGI 成为可配置的 production near-field diffuse GI；启用时它独占 screen AO、输出 AO/GI/bent/confidence，独立 GTAO 的 pass/resource/history/work count 为零。
- SSGI 关闭时，不存在仅为 SSGI 服务的 `DiffuseSurfaceLite`、radiance-source attachment、history、resolve 或 dispatch；GTAO 仍提供 screen AO 与 bent normal。
- Material AO 在 GTAO/SSGI 两种 topology 下始终保留；screen AO 只调制 long-range indirect/ambient 语义，不无差别乘 direct、emissive、unlit 或 SSR correction。
- Brick4、Probe Volume、IBL 使用 receiver-level validity 只选择一个 authoritative long-range diffuse provider；SSGI 只做 near-field correction，不成为另一个 long-range provider。
- `PreExposedOpaqueRadianceSource` 明确排除当帧 SSGI；`OpaqueColorPyramid` 明确位于 screen-space diffuse resolve 之后、SSR correction 之前；没有同帧 SSGI feedback 或 source-stage 混用。
- Three.js-derived SSR+Temporal+Denoise 成为 production reflection correction；若被证据拒绝，必须先有另一 replacement 通过门禁，才能删除现有 production SSR。
- SSR miss、edge、roughness invalid 或 rejected history 能以 confidence `0` 回退 Local Reflection Probe/IBL；Three example 的 environment suppression 不进入生产路径。
- `OpaqueColorPyramid` 与 `FinalColorPyramid` 语义分开并按 consumer 创建。
- 现有 `TemporalFeature` 演化为统一 history/resolution contract，而不是出现第二套 Temporal。
- DRS benchmark 有 fixed 模式。
- 被替换的 old backend/shader/resource/history 已删除。
- `PIPELINE.md` 与 `ARCHITECTURE.md` 只在实际 cutover 后更新为当前事实。
