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

本 ADR 决策时的旧 Surface V1 主要持久附件约为如下规模；该权威已经在 Step 3 cutover 后由 `OEngine/src/gpu/GpuComputeMaterialAbi.ts` 取代并删除：

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

radius domain 是显式配置而不是隐含单位切换：

```text
samplingDomain = world:
  activeRadius = radiusMeters / metersPerWorldUnit
  projectedStep = max(activeRadius * halfProjectionScale / -viewZ, stepCount)

samplingDomain = screen:
  activeRadius = screenSpaceRadius
  projectedStep = activeRadius * (traceWidth / 2) / 16
```

两者必须进入同一个 SSGI producer；不得据此复制 pass、history 或 FrameProduct。OEngine production 默认使用 `world` 以保持场景物理尺度，`screen` 保留 pinned Three.js 原生画面半径行为。`screenSpaceRadius` 与 `radiusMeters` 是不同单位的两个有界字段，非 active 字段不得被重新解释；domain/radius 改变必须失效 SSGI history，并在 runtime evidence/profiler 中暴露 active domain/radius。temporal 关闭时 direction rotation 与 offset 的上游基值都是 1；initial step 必须保留 Three.js `rand((uv + direction × 0.02) × 2 - 1)`，slice direction 使用 `interleavedGradientNoise(screenCoordinate)`。单侧 ray 的 quadratic offset 单调增大，所以越过 `(0,1)` viewport 后必须 `break`，不得继续产生无效 depth/HZB sample。

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

这里的 bent normal 是几何可见性产品，不是 radiance-weighted light direction：`newlyOccludedZones > 0` 后必须立即以 zone coverage 累计遮挡方向，后续 `receiverFacing`、`emitterFacing`、backface-lighting 或 radiance/firefly 条件只能门控 incident GI 与 GI confidence，不能反过来门控 bent normal。否则无发光/背向的遮挡物仍会进入 AO bitfield，却不会改变 bent normal，破坏同域合同。

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

**Implementation record（2026-09-12，上游一致性修正已落地，verification reopened）**

- `mode=gtao` 的唯一 production owner 是 `AOService → GtaoPass`，固定 three.js r186 commit `148ef33ecb6d2502ff796d4554abd1549c95d519`。旧 SSAO/GTAO shader、独立 bent-normal pass、旧 history owner、Three.js `TRAANode`/RenderTarget 均不在 production topology。
- raw trace 保留 5×5 magic-square slice rotation、六帧 temporal rotation、四帧 offset、Three.js 精确 `interleavedGradientNoise + rand` step phase、3/5 directions、quadratic bidirectional stepping、physical world radius、view-space thickness、squared falloff 与 Activision Eq. 7。`rand` 使用 pinned `MathNode.js` 的 `dot → % PI → sin → fract`，不以统计性质相似的本地 hash 代替表达级移植。
- bent normal 复用同一 horizon integration；raw `rgba16float` 同时携带 visibility/second moment/oct bent，spatial/temporal 一起过滤，唯一 full-resolution bilateral resolve 拆为 `r8unorm visibility + rg16uint bent`。high profile 是 half-resolution `3 × 6 × 2` depth samples；feature-off 不保留 pass、transient、两张 history、counter dispatch 或 submit。
- linear/view-depth producer、raw horizon trace与joint bilateral resolve都直接绑定主管线`depth32float` attachment；其WGSL现统一声明`texture_depth_2d`、BindGroupLayout统一声明`sampleType: depth`，且`textureLoad`直接消费reverse-Z标量。旧实现把同一depth view伪装成`texture_2d<f32> + unfilterable-float`，会在真实WebGPU bind-group validation失败。Spatial/Temporal过滤读取的是GTAO自产`r32float` view-depth/moments color texture，仍合法保留普通`texture_2d<f32>`及`.r`，不得机械改成depth texture。
- 历史 `advanced-frame-pipeline-v2-step4.json` 记录修正前 candidate 的三个独立 Chrome context：518,400 GTAO pixels、GPU P50/P95 1.962/2.284 ms、相对 Step 3 phase P50 +0.089 ms。由于本次把 step rand 从本地 hash 收敛为 pinned Three.js 公式，旧 artifact 只能作为历史对照，不能证明当前 commit。按“不跑代码测试”约束，类型/WGSL compile、`surface.gtao-replacement`、薄几何/边界视觉与唯一 `comprehensive-full` PERF 均未重跑，因此 Step 4 Exit 暂时重开。

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

**Implementation record（2026-09-12，implementation landed，verification open）**

- 公开 `RenderFeatureSettings` 已从 `ambientOcclusion: boolean` 直接迁移为 `screenSpaceDiffuseMode: "off" | "gtao" | "ssgi"`；初始化便利配置同样只接受单值 mode，不保留 GTAO/SSGI 双布尔兼容层。
- production owner 为 `ScreenSpaceDiffuseService → SsgiPass`，固定上游 three.js r186 commit `148ef33ecb6d2502ff796d4554abd1549c95d519`。本地 WGSL 保留 32-zone occlusion bitfield、slice/双向 step、quadratic stepping、Three.js `rand`/`interleavedGradientNoise`、六帧 rotation、四帧 offset、screen/world radius、thickness/backface control、newly-occluded radiance accumulation、AO/GI dual output 与 luminance 7 firefly bound。复核上游后冻结 temporal-off direction/offset 为 1，并把出屏处理从继续空跑改为单侧 ray 提前终止。
- `SsgiSettings` 现在显式分离 `samplingDomain`、物理 `radiusMeters` 与上游单位 `screenSpaceRadius`。默认 `world + 2m` 保持 OEngine 物理尺度；`screen + 12` 保留 Three.js 原生公式，范围冻结为 `[1,25]`。两种模式共享相同 64 B uniform、trace/filter/resolve owner 和资源拓扑；切换 domain/radius 只触发 SSGI history invalidation。runtime evidence 暴露 configured domain、两种 radius、换算后的 world radius、physical scale，以及带 `world-units | screen-radius | disabled` 单位的 active radius；profiler 的 `ssgi.activeRadius` 在 feature-off 时严格为 0，不允许用 pass 名或残留配置值证明分支已生效。
- OEngine bent-normal extension 在 newly-occluded bitfield zone 确认后立即累计几何遮挡方向；receiver/emitter facing 只影响 incident GI，不能影响 bent。这样 AO、bent 与 GI 使用同一 depth/thickness/radius 命中域，同时保持 bent 不依赖 radiance source 内容。
- high topology 为半分辨率 `2 slices × 8 steps × 2 sides`；raw 输出 `rgba16float AO/second moment/oct bent` 与 `rgba16float incident GI/confidence`，joint spatial 和统一 temporal 后，一次 full-resolution depth+normal bilateral resolve 输出 `r8unorm visibility`、`rg16uint bent`、`rgba16float incident GI`、`r8unorm confidence`。Bent normal在spatial、temporal和full-resolution resolve三层都先逐sample oct-decode，在方向空间加权；temporal将history翻到current同半球，随后normalize并重新oct-encode。禁止直接插值oct坐标，因为跨fold seam会产生非物理方向；方向加权复用原AO fetch，不增加texture、pass或AO sample count。复核还发现full-resolution resolve虽已绑定`normal_source`却未消费，只做depth edge stop；现启用center+4 candidate compact-normal load和`dot^32` normal weight，使实现与“joint depth+normal”合同一致。新增5次normal load必须由本Step PERF Gate验收。TemporalHistoryRegistry只管理generation/commit/invalidation；SSGI owner持有两组AO+GI ping-pong，共四张history，不引入Three.js `TRAANode`。`SurfaceValidity` ABI固定为 `r=reactive, g=motionValid`；temporal history weight必须使用 `g >= 0.5 && r < 0.5`，并继续乘shared disocclusion confidence。旧实现曾误把`.r`直接当validity，导致稳定表面拒绝history、reactive表面反而接受history；现已纠正并由静态oracle禁止回流，实际稳定性仍等待本Step temporal visual Gate。
- `PreExposedOpaqueRadianceSource` 直接冻结 GI baseline 写入后的 HDR resource version，trace 对它只读；当帧 `ScreenSpaceDiffuseResolve` 是后继 writer，因此 FrameGraph 依赖阻止 self-feedback。`DiffuseSurfaceLite` 逻辑产品复用 compact `albedoAo + roughnessFlags`，没有第二次 VisibilityKey/material texture evaluation，也没有额外 full Surface attachment。
- SSGI topology 强制 IBL/Brick4/Probe baseline 临时物化 `resolved long-range diffuse + baseline specular`。最终 resolve 以 additive delta 只替换这些间接分量：long-range diffuse 乘 screen visibility，incident GI 乘 receiver diffuse/energy remainder/Material AO 一次；direct、emissive、unlit 保持原 HDR。SSR off 时在这里应用 bent-normal specular occlusion；SSR on 时 baseline specular 暂不改变，交给 Reflection correction replacement，避免双重 subtract。
- `LongRangeDiffuseProviderPass` 输出始终是未乘 receiver cavity 的 raw irradiance。`OpaqueLightingResolve` 在共同 receiver point 对 Brick4、Probe、IBL 与 deterministic fallback 统一施加 `MaterialAO × ScreenAmbientVisibility`；fallback sampler 不再提前私自乘 Material AO。由此 `mode=off|gtao|ssgi` 都恰好应用一次 Material AO，SSGI component baseline 已含 Material AO，后继 `ScreenSpaceDiffuseResolve` 只再乘 screen visibility，不会漏乘或双乘。
- 新增唯一 production `LongRangeDiffuseProviderPass`，在一个 full-resolution producer 内对每个有效 receiver 严格执行 `Brick4 spatial validity → Probe Volume tetra coverage → IBL → black`。控制流在 Brick4 命中后立即返回，Probe lookup 只为 Brick4 落空 receiver 执行，IBL 只在两个空间 provider 都落空后采样；不会先运行三个 fullscreen GI candidate 再丢弃两个。`selectedDiffuse.a`/`selectedSpecular.a` 以精确整数浮点编码 `1=Brick4, 2=Probe, 3=IBL, 4=black`，diffuse irradiance 与 baseline specular radiance 来自同一次 authoritative selection。SSGI evidence 不再重复写 provider counters。
- `Brick4LightMap` 现在公开单调 generation、non-empty residency 与显式 invalidate；`GPULightProbeVolume` 强制 zero-version source 首帧初始化，并只在 source/GPU generation 一致、probe 数量足够且 tetra mesh 非空时声明 available。GPU counter schema v21 增加 `invalid_generation/nonresident/unassigned/duplicate`，provider producer 在所有 screen-space diffuse mode 下成为唯一统计 owner；unassigned/duplicate 由单一早返回控制流结构性保持为零。
- Brick4 V1 明确采用 monolithic residency，而不是伪装成尚不存在的 sparse paging：`Brick4LightMapPackageV1` 保留既有 shader payload 偏移，以 32 B bounds + tree/probe storage 作为设备无关包；validator 遍历 64-probe node、3×3×3 occupancy/child pointer，拒绝越界 probe、越界 branch、reserved bit、cycle/alias 和非有限/退化 bounds。完整树与所有被引用的 7-word SH probe 必须在一次 publication 中存在，因此 V1 的 `required bricks resident` 等价于“该 generation 的已验证 monolithic package 已原子发布”。
- `Renderer.uploadBrick4LightMap(scene, package)` 是 frame loop 外的显式 production 入口。GPU owner 为每个 generation 创建 immutable storage，先完成 mapped upload 再原子替换 active binding，旧 buffer 等待已提交工作完成后退役；不会在 in-flight frame 仍读取时原地覆盖/销毁。`invalidateBrick4LightMap(scene, nextGeneration)` 先推进 expected generation 并令 resident=false，期间 shader 以 `actual != expected` 拒绝旧 mapping、计数并回退 Probe/IBL；matching package 发布后 actual/expected 再一致。这里的 receiver mapping 是 world-space bounds/tree 的隐式映射，不另造 per-instance mapping record。
- scene-wide `indirect_lighting_mode`、公开 `ShadeIndirectLightingMode`、topology key bit 与三段不可达主管线分支已经删除；GIService 不再构造 `Brick4IndirectPass`、`LpvIndirectDiffusePass`、`IblBaselinePass` 或 `OpaqueLightingPipeline`。这些旧 pass/shader 文件也已删除，shared camera ABI 从 LPV shader 拆为中性的 `packed_camera.ts`。现在只有 receiver-local provider producer → `OpaqueLightingResolvePass` 一条 production path，不保留兼容层。
- 同时修正 unified provider cutover 暴露的 SSR seam：provider 的 specular 输出是未乘 receiver BRDF 的 radiance，不能直接作为可 subtract baseline。`OpaqueLightingResolvePass` 新增 SSR-only 两 MRT 变体，在 `SSR on + SSGI off` 时只额外物化 BRDF-weighted、bent/AO-occluded `PreExposedBaselineSpecular`；只有 SSGI consumer 才写第三个 resolved-diffuse MRT。GIService 的返回 ABI 进一步把 `selectedDiffuseIrradiance`/`selectedSpecularRadiance` 与 `resolvedDiffuse`/`baselineSpecular` 分成不同字段，不允许 fallback 表达式把 raw radiance 冒充 baseline。由此避免错误 subtract，也避免 SSR-only 为 diffuse component 支付无消费者写带宽。
- `surface.ssgi-production` 现在还定义了两阶段 Brick4 oracle：resident generation 的覆盖 receiver 必须只计 Brick4；推进 expected generation 后 Brick4 必须为零、`invalid_generation > 0` 且 receiver 回退 IBL。同时以 `samplingDomain=screen, screenSpaceRadius=12` 覆盖 pinned native-radius GPU branch，并保留 pinned path、GTAO owner/history 缺席、source-before-resolve、component product、temporal closure 与 one-main-submit 检查；静态 oracle 冻结 temporal-off direction/offset=1、Three.js rand/IGN、双 radius branch、viewport break 与 history invalidation。按本轮明确“不跑代码测试”的约束，这些测试尚未执行，也没有 build、真实 Chrome、world-domain visual review 或 `comprehensive-full` 结果，因此 Step 5 当前仍只能记为 implementation-landed / verification-open，不能判定 Exit 已满足。

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

**Implementation record（当前为 implementation-landed / verification-open）**

- adopted upstream 冻结为 three.js `148ef33ecb6d2502ff796d4554abd1549c95d519`（r186）。`docs/porting/shading.md#shade-ssr--screen-space-reflections` 分别登记 `SSRNode.js + SpecularHelpers.js`、`TemporalReprojectNode.js`、`RecurrentDenoiseNode.js` 与 SSR denoise example；本地没有引入 TSL、NodeMaterial、QuadMesh、Three RenderTarget、RenderPipeline 或最终 example composite。
- trace 的 stochastic lobe 已由旧采样替换为上游 bounded GGX VNDF spherical-cap translation：perceptual roughness 先平方为 alpha，应用可配置 `mirrorBias`，背向 sample 做一次 deterministic retry。OEngine shared noise resource 保持 STBN vec2；VNDF `.xy` 读取 STBN，mirror-bias 需要的独立 `.w` 由 pixel/frame hash 确定性生成，避免错误读取双通道纹理的隐式 alpha。Trace 与 hit shading 共同嵌入一个 `ssr_stochastic_sample` WGSL source；hit shading 复用同一 trace pixel、frame index、STBN texel、hash、roughness 与 mirror bias，确定性复演发射时的 sample direction，再用该方向计算 Three `BRDF·cos/pdf` 权重。权重不得从量化后的 HZB hit coordinate 反推，否则 half-resolution/full-resolution 映射和整数命中点会改变随机估计量。Resolve 只复用已有 blue-noise texture 与 trace-settings uniform，没有新增 attachment、pass 或 submit。OEngine 保留 reverse-Z shared HZB hierarchical traversal、max-distance、distance-scaled thickness、edge/roughness confidence 与 `rg32uint` evidence ABI。Three 的固定 64-step nonlinear screen DDA 和独立 8-step binary loop不与 HZB叠跑；其“远区跳过、近交点细化”行为由 HZB coarse skip + mip descent承担，避免建立第二个 ray marcher。
- packed trace word 继续保存 full-resolution hit xy、8-bit trace confidence、iteration count、outcome 与 distance/high-roughness flags，原 GPU counter reducer仍直接消费；hit shading 的 `rgba16float.a` 单独保存 specular-dominant ray length，避免为了 denoiser 破坏 counter/debug ABI。粗糙度、最大距离、thickness、步数、resolution scale、mirror bias与 temporal strength均来自一个 `SsrSettings`/job contract。
- 旧 resolve 的 48-neighbor PDF resampling、environment octahedral fallback 与 LPV specialized resolve 已删除。新的 hit shading从 post-screen-space-diffuse `OpaqueColorPyramid` 采样 incident radiance，按 Three `ggxReflectionSample` 的 chromatic Fresnel、Smith geometry 与复演的 bounded-VNDF sample direction计算 `BRDF·cos/pdf` weight，直接生成 receiver-resolved、working-linear、current-pre-exposed `SSRSpecular`；alpha发布 dominant ray length。half-resolution trace receiver 由 fragment-center `coord.xy / traceSize` 映射到 full-resolution surface，不能在已经含 `0.5` center offset 的 `@builtin(position)` 上再加半 texel。SSR miss 不再由 shader注入 environment color。
- 主 `depth32float` 的 sampled ABI 已在完整 SSR 链统一：trace、hit shading resolve、TemporalReproject、RecurrentDenoise 和 conditional half→full joint upscale 都通过 depth-only view 绑定 `texture_depth_2d + sampleType: depth`，`textureLoad` 直接取得 reverse-Z `f32` 标量。旧代码把同一 depth attachment 声明为 `texture_2d<f32> + unfilterable-float`，后三段还通过通用 color view 绑定，无法满足 WebGPU texture-view/BGL/WGSL 类型一致性；现已删除这些非法组合。shared HZB 仍是独立 `rg16float` color pyramid，继续按普通 float texture 读取对应通道，不能随主深度一起改成 depth texture。
- production filter 顺序已重排为 `raw SSR → TemporalReproject(accumulate=false) → RecurrentDenoise(accumulate=true)`。Temporal分别建立surface与reflected-hit两个物理history candidate：surface从receiver center减receiver velocity并以receiver geometry校验；hit从当前hit texel center减hit velocity并以hit geometry校验。每个candidate各做一次4-tap；采样结果额外发布max/min geometry confidence。共享3×3 current neighborhood除HDR YCoCg moments外，同步用Welford统计screen-hit ray-length标准差和命中覆盖率。hit trust恢复pinned组合：`minConfHit × reflectionEdge × (1-curvature) × maxConfHit`，其中reflection edge由ray-length stddev与motion得到，curvature由uniform-control-flow中的`fwidth(centerNormal)×50`得到，再用screen-hit probability抑制miss边界。receiver与hit分别读取自己的`OcclusionConfidence`和`SurfaceValidity`：motion-invalid/reactive/disoccluded只拒绝对应history candidate，并在hit raw trust阶段归零；它们不得乘进raw `current_confidence`，否则新显露区域会连当前帧真实SSR一起丢失，recurrent也无法从raw分支恢复。motion factor仍按surface/receiver path计算。该路径不再重建view position，因此temporal pass删除current-camera binding与frame-graph read。surface-history UV在任何per-pixel early return之前求`dpdx/dpdy`，由reprojection Jacobian最小奇异值产生stretch confidence；平方后衰减history并参与clamp intensity。该结构恢复Three specular temporal的双候选、edge/curvature trust与stretch不变量，但以OEngine velocity field代替Three previous-matrix world-hit projection；half-resolution history fetch从4增至8，3×3循环没有重复建设。HDR variance clip按pinned `1/(1+10L)`、motion gamma `0.5..1`、box-center clip、original-scale restore和clip-distance confidence执行。history/pre-exposure均execution-time late-bound，compatible history按`current/previous`重标定，且仅在main command成功submit后推进；全部成本等待Step 6 PERF验收。
- RecurrentDenoise 使用固定8-tap golden-angle Vogel disk，在view-space specular-lobe tangent basis中投影sample；越过viewport的投影按Three r186的mirror transform返回屏内，不通过`continue`缩减边缘kernel。ray length先按上游5-tap cross和inverse-length weight求局部代表值；ray edge stop按REBLUR frustum-height normalization比较hit-distance factor，而不是直接比较不同深度下不可比的绝对长度。normal weight恢复GGX inverse-CDF lobe half-angle/falloff；normal encoding error从Three 8-bit输入的`1.5/255`适配到OEngine 16-bit packed normal的`1.5/65535`。depth使用`depthPhi(5) × 500` plane-distance scale，raw luminance与roughness分别保持上游`lumaPhi(5) × 10`和`roughnessPhi(100)`，共同组成`exp(-(kernelDiff × aggressivity + depthDiff)) × lobeNormalWeight`。这些输入不含history confidence/color，temporal history不能反过来改变当帧kernel形状。该原始spatial weight以pinned `adapt=0.5`更新radius shrink/polar feedback，polar direction blend同样只使用`0.5 × history aggressivity`。temporally filtered分支额外乘sample history confidence，raw-current分支则独立乘当帧trace/raw validity，不能因history confidence低而丢弃刚显露或刚命中的raw sample。两个空间过滤结果随后才做accumulate/Karis-style汇合，denoised result写双缓冲external history；旧的temporal前置3×3 spatial blur不再存在。新增5-tap ray statistic比此前center-only多4组raw/trace load，连同双history candidate成本必须由Step 6 PERF验收；half-resolution topology继续只增加一次full-resolution joint bilateral upscale。
- `temporalEnabled=false` 时不再构造两张 SSR history；recurrent pass直接从 trace word恢复 current confidence。SSR feature关闭时 `ReflectionService` owner、trace/prefilter/temporal/denoise/upscale、history、baseline-specular consumer 与 correction 仍由 topology整体裁剪。
- reflection domain 已修正为单次 receiver evaluation：`OpaqueLightingResolvePass` 的 baseline 是已经 BRDF-weighted/occluded的 `PreExposedBaselineSpecular`，新的 SSR hit shading也是 receiver-resolved specular。因此 `SpecularCorrectionPass` 删除 normal/bent/albedo/PBR/split-sum/environment/AO/camera bindings，只执行 `confidence × (SSRSpecular - BaselineSpecular)` additive delta；等价于 ADR 冻结的 `lerp(BaselineSpecular, SSRSpecular, confidence)`，不会 double energy或把黑色 miss 当有效反射。
- 新增 canonical `surface.ssr-replacement` real-Chrome oracle；场景使用专用镜面地面与多组前景反射遮挡物，避免普通悬浮盒场景只能依赖偶然侧面 hit。oracle 冻结 pinned algorithm/format/alpha semantic、phase/history closure、GPU trace/hit/step counters、one-main-submit、SSR feature-off完整裁剪与 temporal-off history裁剪；case标记为 always-screenshot，并通过 source-domain selector覆盖 SSR shader/pass变更。它不以 pass类名代替 GPU counter和物理资源证据。
- 按本轮明确“不跑代码测试”的约束，没有执行 TypeScript/build、WGSL/browser compilation、`surface.ssr-replacement`、MILESTONE、真实 Chrome visual review、feature topology matrix或 `comprehensive-full` PERF。静态 oracle 已增加 trace/resolve 共享 sample replay、resolve noise/settings binding、fragment-center 映射、temporal receiver/hit双候选、recurrent mirror/raw-independent/feedback，以及五阶段主深度 view/BGL/WGSL 一致性约束，但也没有执行。因而上述记录只证明 production implementation/cutover 已落地，不证明本 Step 的 quality、temporal stability、numerical energy和 performance Exit 已通过；不得写“Step 6 完成”。

### Step 7 · Shared Pyramids + History Contract

**Scope**

Shared Depth/HZB、post-screen-space-diffuse `OpaqueColorPyramid`、`FinalColorPyramid`、unified GTAO/SSGI/SSR/temporal history lifecycle、exposure/bloom consumer migration。若 SSGI radiance mip chain 经证据获准，增加语义独立的 `ScreenSpaceDiffuseSourcePyramid`。

**Verification:** MILESTONE + PERF

**Exit**

同语义重复 pyramid/reduction 减少；pre-SSGI 与 post-SSGI source 不混淆；consumer-off 能裁剪；无多余 submit/readback。

**Implementation record（当前为 implementation-landed / verification-open）**

- 新增 typed `OpaqueColorPyramidFrame` 与 `FinalColorPyramidFrame`。前者强制 `internal-full + post-screen-space-diffuse-pre-ssr`，后者强制 `output-full + post-transparency-temporal`；两者分别携带 source generation、mip count、PreExposure 和 domain validation。`FinalColorPyramidFrame.source` 明确指向未 Bloom composite 的 output-full mip0 identity；当 temporal off 且 internal/output extent不同，共享 producer的 mip0 copy以线性 UV resolve到 output domain，consumer不会把 internal source误当 full-resolution textureLoad 输入。
- `SharedColorPyramidPass` 是唯一生产 owner，但不是一个可互换的通用颜色 mip。它为 `OpaqueColorPyramid` 与 `FinalColorPyramid` 建立两张独立 transient `rgba16float` texture、独立 FrameGraph resource name、source stage和 evidence。Opaque 最多 5 mip，mip0 复制完成 screen-space diffuse 的 baseline，第一级 reduction 保留原 SSR depth-aware/background rejection 和 inverse-luminance weighting，后续为有界线性 reduction；Final 最多 6 mip，在 transparency、TAA/NSS 和可选 motion blur后生成。每个 logical product 只有 consumer 存在时才进入 graph；Shared 不表示两个 source stage 可以 alias。
- Shared Depth/HZB 已经由 per-view `HierarchicalZBuffer` 以一张 current `rg16float` mip hierarchy、一次 compute pass和多 mip dispatch生产，GTAO/SSGI/SSR 都读取该同一 FrameGraph resource；本 Step 没有为了形式统一重写一个已经闭合的 producer，也没有让任何 effect增加私有 HZB。canonical case明确检查一个 `hzb_current`、一个 graph producer、一个 build和正数 mip dispatch。
- SSR production consumer 已从 `sceneColor → pass-local prefilter texture` 改为直接绑定 typed `OpaqueColorPyramid.texture`。`ScreenSpaceReflectionsPass` 中 copy/depth-aware/downsample pipeline、private pyramid allocation和 `ssr_prefilter.ts` 已删除；`ScreenSpaceReflectionsRuntimeEvidence.prefilterOwner` 明确报告 `shared-opaque-color-pyramid`。这次只迁移 pyramid owner，Three.js r186-derived GGX VNDF hit shading、TemporalReproject、RecurrentDenoise 与 OEngine confidence replacement 算法保持 Step 6 冻结语义。
- Bloom 不再维护第二条等价 HDR downsample chain。它从 shared Final mip1 开始，先在最低使用 mip提取高光，再逐 mip向上执行当前 mip high-light extract + 3×3 lower-bloom reconstruction，最终与 `FinalColorPyramid.source` 合成。保留的 `Bloom reconstructed pyramid` 只包含 Bloom 专用阈值/滤波结果，不冒充共享 scene-color pyramid；旧 `Bloom downscale map`、prefilter/downsample/upsample shader ownership 已退出 production。
- Automatic Exposure 的 128-bin log-luminance histogram 改为读取 `FinalColorPyramid` 最低可用 mip并按该 mip extent dispatch；percentile reduce和 adapted scalar buffer语义不变。Bloom 与 Exposure 同时开启时 `finalConsumerCount=2` 但 `FinalColorPyramid finalBuilds=1`，不会各自 full-resolution 读取并重建同义 mip。全部关闭时 shared owner退役，opaque/final build、bytes、pass 与 resource 为零。
- 没有 benchmark 证明 SSGI 需要 radiance mip chain，因此本 Step 没有擅自增加 `ScreenSpaceDiffuseSourcePyramid`。SSGI 仍直接读取 full-resolution、pre-SSGI `PreExposedOpaqueRadianceSource`；post-SSGI `OpaqueColorPyramid` 只在 SSR consumer存在时创建。runtime evidence将 `screenSpaceDiffuseSourcePyramidBuilds` 固定为 0，canonical graph oracle同时检查该 resource缺席和 `ScreenSpaceDiffuseResolve → OpaqueColorPyramid → SSR` 顺序。
- `TemporalHistoryRegistry` 从“统一 validity/index 外壳”升级为逻辑声明与提交边界权威。当前注册 `color`、`gtao`、`ssgi`、`ssr`、`nss-feedback`、`exposure`，每项冻结 semantic、resolution domain、format、physical buffer count和 `none | working-linear-rescale | invalidate-on-change` PreExposure policy。state 对外给出 active/valid/readValid、read/write slot、generation、invalidation count/reason和本帧 exposure scale；同名重复注册、未知 active/produce、嵌套 frame、错误 commit/abort均显式失败。
- history ping-pong只在 main command `onFinished` 后推进；encode/submit abort 保持旧 committed index并使 active history以 `abort` 失效。global revision覆盖 camera cut、output/internal resize、render-scale generation、feature topology、format、lighting、scene、view、representation、device 与 pre-exposure generation，其中 NSS model replacement会推进实际 representation revision；算法参数的非 topology change用 targeted `invalidateNames` 只失效 `RenderSettings` 声明的 history。首帧只产生一次 `initial` invalidation；feature change不会再先 explicit、后 topology双重失效，同时仍会使保持 active 的 downstream color history换代。
- TAA、SSGI 与 SSR shader在任何旧 history textureLoad/textureSample之前检查有效性/scale，并在 compatible PreExposure generation下把 history RGB乘 `current multiplier / committed multiplier`；generation不兼容时 scale为 0。NSS 的 color history与 feedback validity联合门控，feedback read/write texture改用 registry slot而不是 frame index；Exposure adapted buffer同样改用 registry slot，history invalid时 adaptation从当帧 goal开始且不读取 stale previous value。GTAO history不含 HDR，因此 policy为 `none`。
- `FrameContext.history` 现包含 color/GTAO/SSGI/SSR/NSS-feedback/Exposure validity；公开 `sharedDerivedProductsEvidence()` 与 `sharedPyramid.*` profiler counters报告两种 build/render-pass/mip/bytes、consumer count、Bloom reconstruction、Exposure metering extent以及全部 history声明。新增 `surface.shared-derived-products` canonical real-Chrome case，覆盖单 producer共享、source-stage顺序、SSGI source不 alias、SSR-only/Final-only/all-off裁剪、camera cut、output resize、GTAO↔SSGI reset、one-main-submit和 profiler一致性；source-domain selector会由 shared/post/temporal/SSR/SSGI 代码变更选中该 case。pure ABI tests另外冻结 Final product validation、提交后推进、abort、feature reset、exposure ratio与 non-HDR history隔离。
- 本 Step 没有采用新的外部算法。原 SSR depth-aware reduction的来源关系仍归 Step 6/`SHADE-SSR`；移动到 shared owner是 OEngine资源架构变更。Bloom reconstruction与低 mip exposure接线是本地实现，不虚构 three.js/FSR/SPD adoption；SPD/subgroup single-dispatch仍需实际 adapter PERF后才能替换当前 portable multi-render-pass producer。
- 按本轮明确“不跑代码测试”的约束，没有执行 TypeScript/build、WGSL compilation、pure tests、source selector、真实 Chrome `surface.shared-derived-products`、MILESTONE、visual review或唯一 `comprehensive-full` PERF。Step 5/6 的验证 Gate 同样仍未关闭；本记录只表示 Step 7 production implementation 已落地，不表示它已通过 Exit。后续 Step 的实现落地不能倒推这些未运行 Gate 已通过。

### Step 8 · Temporal Reconstruction / DRS

**Scope**

evolve existing TemporalFeature、output/internal domain、pre-exposure-aware history、reactive/disocclusion、DRS fixed/adaptive。

**Verification:** MILESTONE + PERF + temporal visual review

**Exit**

static detail、motion edge、MASK、transparency、SSR、camera cut、resize 稳定；benchmark fixed mode 可重复。

**Implementation record（当前为 implementation-landed / verification-open）**

- `TemporalFeature` 仍是唯一时域 subsystem owner，没有新建第二套 reconstruction/DRS 管线。`FrameProducts` 新增 `TemporalReconstructionFrame`，强制 production output 的 source stage 为 `post-transparency-temporal`、输入为 `internal-full`、输出为 `output-full`、PreExposure 为 working-linear contract，并显式声明 history generation 来自 `TemporalHistoryRegistry.color`、representation revision 来自 `MainHistoryRevision.representation`。TAA 的 confidence 与 HDR 共用 `rgba16float` alpha history-lock 通道；NSS 不伪装该 alpha 语义，其 confidence 仍由独立 `nss-feedback-history` 承担。
- Main FrameGraph 在 transparency/SSR correction 后把时域输入 ResourceId冻结为 internal-domain source，TAA/NSS 写唯一 output-domain color history，然后立即构造并消费 typed reconstruction product；若输入与输出意外成为同一个 resource，recipe build 显式失败。后续 Motion Blur、FinalColorPyramid、Exposure、Bloom、Color Grading/Tonemap 继续只沿同一主管线消费重建后的 `hdrRes`，没有增加 parallel quality pipeline、独立 encoder、submit 或 readback。
- TAA与NSS preprocess的closest-depth search都直接读取主管线`depth32float` attachment；两条WGSL binding现统一冻结为`texture_depth_2d`，BindGroupLayout对应`sampleType: depth`。旧实现错误地把这些depth view声明成`texture_2d<f32> + unfilterable-float`，会在真实WebGPU bind-group validation阶段失败；修正后`textureLoad`直接返回同一reverse-Z标量`f32`，不再使用非法`.r` swizzle，也不改变3×3 closest-foreground选择或任何时域权重。
- NSS closest-offset输出保留紧凑`rg8unorm` storage texture，不退化成四通道中间量。它与既有`rg16float` HZB、可选Velocity storage同属WGSL `texture_formats_tier1` language extension：WebGPU host feature名为`texture-formats-tier1`，WGSL language feature名为`texture_formats_tier1`，不能混写。Renderer初始化必须在创建资源前同时验证`device.features`与`navigator.gpu.wgslLanguageFeatures`；命中的HZB/NSS/Velocity Shader在模块首部显式`requires texture_formats_tier1;`，使能力缺口在初始化/Shader creation边界明确失败，而不是依赖后续bind-group validation偶然暴露。
- Motion Blur保持在Temporal Reconstruction之后，因此其color/output属于`output-full`，而Material Resolve velocity与主管线depth仍属于`internal-full`。旧实现错误地用output width/height创建tile grid，并在resolve中直接以output pixel读取internal velocity/depth；DRS小于1时产生错误tile、越界零值与未缩放trail。现有实现不增加full-resolution velocity/depth intermediate：tile/neighbor reduction按internal extent创建，resolve将center及每个output tap显式映射到clamped internal texel，并把internal-pixel velocity乘`output/internal`换算为output-pixel trail。depth rejection同时改用reverse-Z“大值更近”的soft compare，避免forward-Z比较颠倒前后景覆盖关系；输出资源显式标记`output-full`、两张reduction资源标记`tile`。
- TAAU current reconstruction 保留 native internal=output 时的单次 `textureLoad`，仅在 output 大于 internal 时执行 Catmull-Rom。原 separable 4×4 的 16 次逐 tap fetch 已按双线性采样恒等合并为 9 taps：x/y 各将中间两个正权重 tap 合并为一个 bilinear coordinate，再做 3×3 product。该优化保留 cubic footprint和负 lobe，最终对 HDR 负 ringing 做非负 clamp；它是 OEngine 本地 WGSL 表达，不声称直接复制 FSR2 shader或达到已经验证的 FSR2 quality。
- Reprojection 仍使用 Surface ABI 的 `current - previous` internal-pixel velocity，并从 reverse-Z 3×3 邻域选择 closest foreground depth对应的 velocity/motion validity。final-layer transparent reactive 继续取 output pixel并与 selected opaque surface reactive 取最大值，避免 MBOIT foreground因为 closest-depth选择后方 opaque 而丢 mask。TAA shader 现在在任何 history sample 前严格拒绝 global/generation/pre-exposure invalid、motion-invalid、`reactive >= threshold`、disocclusion confidence不足和 reprojected UV越界；删除了“reactive foreground允许 motion-invalid history”的隐式例外。
- accepted history 先按 `current preExposure multiplier / committed multiplier` 重标定，再做 YCoCg cross-neighborhood mean/deviation clip。亮度权重从对绝对 pre-exposed luminance差值敏感的 `1/(1+abs delta)` 改为有 0.1 floor 的相对 luminance delta，并以 `1/(1+4×relative delta)`抑制曝光域内的高对比泄漏；reactive 从 0 到 threshold 使用 smoothstep连续压低积累。history lock 只按 disocclusion confidence与 reactive confidence推进，随后与 motion fade、relative luminance、history strength和 min/max lock weight共同决定 bounded blend；reject 输出 alpha 0，使下一帧从 unlocked 状态重建。
- CPU `TemporalResolveContract.classifyTemporalHistory()` 与 WGSL 的 hard reject、relative luminance、reactive smoothstep和 confidence-gated lock推进保持同一公式。GPU sampled evidence不再把 reactive/disocclusion阈值硬编码为常量：classification job late-bound同一 `RenderSettings.temporal` 阈值，16 B uniform以 `u32 + f32 + f32 + padding`写入 evidence compute，因此 `temporalReactivePixels`、`temporalDisoccludedPixels`、`temporalHistoryRejectedPixels` 表达当前 production policy，而不是与 shader设置漂移的近似统计。
- `RenderSettings.resolution` 从单个 scale 扩展为唯一 fixed/adaptive policy：`mode`、current/fixed `internalScale`、adaptive min/max、target frame rate、tolerance与 settle frames。默认及 Renderer `renderScale` 均为 `fixed, scale=1`；手工设置 `internal_resolution_scale` 会显式切回 fixed，formal benchmark profile也显式写 `mode=fixed`。`mode=adaptive` 在 Temporal Reconstruction 关闭时配置失败，默认范围为 `0.67..1.0`，防止没有时域重建 owner 时后台降 internal resolution。
- 旧公开 `renderer.dynamic_resolution_scaling` mutable side channel与 `index.ts` 的 controller class export已删除；外部只经 `Renderer.configure({ resolution: ... })` 修改策略。内部 `DynamicResolutionScaling` 现在只接收冻结 policy与 completed GPU timing，scale change回调也重新进入相同 RenderSettings seam；因此 scale 变化会自然推进 internal-resolution revision、resize RenderTargets、重算 TAA/NSS jitter sequence并使全部相关 history generation失效，不存在控制器绕过 settings/history 的第二写入口。
- Adaptive controller 的默认稳定 bucket 固定为 `[0.67, 0.75, 0.8, 0.9, 1]`，只在配置 min/max范围内选择。GPU sample必须满足 finite/positive、严格新于已消费 sample且 `currentFrameIndex > sampleFrameIndex`；current-frame完成值先放 pending，后续帧再消费。控制器使用 30-sample warm-up、8/120 sample fast/slow half-life、10%默认 dead band、slow-mean 6× anomaly clamp、settle window、局部 probe slope、无有效 slope bailout与 600-sample boundary lockout。within-budget会清零 settle count，避免进入预算后每个 sample重复决策。
- Adaptive 只在 `timestamp-query` 可用时要求 profiler GPU采样；缺失该 capability 时 mode仍可观察，但保持 current bucket，不以 CPU frame time替代 GPU truth。切回 fixed会停止 DRS timing consumer并在 DRS自己启用 profiler的情况下退役该采样；geometry adaptive budget仍可独立拥有 profiler。formal fixed窗口不会消费 delayed/pending timing，runtime evidence给出 mode、current scale、bucket/range、target、fast/slow GPU mean、accepted sample、scale-change count、last decision、GPU ms与feedback latency。
- `TemporalRuntimeEvidence` 进一步公开 reconstruction owner/input/output domain、confidence channel、PreExposure/reactive/disocclusion consumer状态、representation revision、committed history valid、当帧 `historyReadValid`、history generation与完整 DRS状态。Profiler新增 `temporal.historyReadValid`、`temporal.drsAdaptive`、`temporal.drsAcceptedGpuSamples` 与 `temporal.drsScaleChanges`，同时保留 internal/output pixels、TAA/classification pass、history bytes/revision/invalidation以及三类 GPU sampled rejection counter。
- 新增 pure ABI/oracle覆盖 typed reconstruction domain/confidence、fixed DRS完全不消费 timing、adaptive warm-up后只落到合法 bucket、fixed settings默认/invalid adaptive range以及 CPU/WGSL reactive/motion/pre-exposure/9-tap invariant。新增唯一 canonical real-Chrome `surface.temporal-reconstruction` case：以 fixed 0.75 internal scale检查 output-domain TAA closure、classification→resolve顺序、唯一 history read/write、one-submit、fixed timing sample不增长；再检查 camera cut/resize当帧 read-invalid和提交后恢复，以及 adaptive 0.67..1 policy可观察，最终回到 fixed 0.75保存 screenshot/counter artifact。changed-path routing覆盖 DRS、TemporalFeature/Resolve/Classification、FrameProducts/MainPipeline/RenderSettings和相关 WGSL。
- 本 Step 没有新增外部代码来源。Playdead Temporal与 AMD FSR2 v2.2.1继续作为 `SHADE-TEMPORAL` 已登记的 algorithm/integration invariant reference；9-tap cubic gather、relative-luminance confidence、DRS controller和OEngine history/product wiring均为本地实现。`FSR2/TAAU-class`仍是产品方向，不等价于 AMD FSR2 API兼容、代码移植或质量/性能已经达到其实现。
- 按本轮持续有效的“不跑代码测试”约束，没有执行 TypeScript/build、WGSL compilation、pure tests、source selector、真实 Chrome `surface.temporal-reconstruction`、MILESTONE、temporal visual review或唯一 `comprehensive-full` PERF。因此 static detail、motion edge、MASK、transparency、SSR、camera cut、resize以及 fixed benchmark可重复性均仍是待执行 Gate；本记录只表示 Step 8 production implementation已经落地，不表示 Exit通过，也不把 Step 5–7 的 open Gate改写为完成。

### Step 9 · Post fusion

**Scope**

FinalColorPyramid、exposure reduction、bloom、final output fusion candidate。

**Verification:** MILESTONE + PERF

**Exit**

减少实际 HDR roundtrip，且 feature-off/topology/debug capture 不破坏。

**Implementation record（当前为 implementation-landed / verification-open）**

- Step 7 后的 normal post链仍是 `FinalColorPyramid/Bloom reconstruct → Bloom composited rgba16float → Color graded rgba16float → optional Sharpened rgba16float → Tonemap swapchain`。这意味着Bloom+grading+sharpen全开时，在共享Final pyramid之外仍有三张output-full HDR intermediate和三个额外full-screen read/write boundary。Step 9选择融合这些逐像素/局部操作，不改动Temporal之前的HDR、Bloom multi-resolution reconstruction或Automatic Exposure reduction语义。
- 现有 `TonemapPass` 演化为唯一 `Final Output SDR/HDR` owner，而不是叠加第二个post pipeline。normal frame直接绑定post-temporal/motion-blur scene HDR、可选half-resolution Bloom reconstructed mip0、可选adapted Exposure和material diagnostic control，在同一个swapchain render pass内严格执行 `Bloom add → linear HDR Color Grading → optional RCAS-like Sharpen → Exposure → SDR ACES或HDR GT7/display transform → encode/dither`。invalid material frame仍在任何scene sampling结果呈现前输出diagnostic magenta。
- 新增 `final_output_input.ts` 作为SDR/HDR共用的source-stage WGSL generator与binding-plan权威。variant key冻结 `output range(SDR/HDR) × Bloom on/off × Sharpen on/off × ColorGrading apply/already-applied`。Bloom off时layout和WGSL都没有bloom texture/sampler；Sharpen off时WGSL没有north/west/east/south四个邻域load；无需任何post effect的debug variant甚至不声明effects uniform。不存在dummy texture、无消费者Pass或仅靠uniform if保留的feature cost。
- `FinalOutputEffects` ABI固定为64 B：三个16-byte对齐的scalar-expanded lift/gamma/gain槽，随后为saturation、contrast、sharpening与normalized bloom intensity。TypeScript binding plan和WGSL生成调用同一`finalOutputBindingPlan()`；SDR/HDR只在该plan之后追加各自display settings（仅HDR）、Exposure uniform和frame-control storage，避免手写variant时binding号漂移。Canvas format改变会清空descriptor variant map，由既有pipeline cache按新target format惰性创建实际GPU pipeline。
- 融合后的sample顺序与原算法保持一致。每个center/neighbor先clamp到output extent，读取scene HDR并以与旧Bloom composite相同的normalized intensity和linear-clamp UV加入reconstructed Bloom，再执行原lift/gamma/gain、Rec.709 saturation与log2 contrast；Sharpen variant对五个已经完成Bloom+grading的值计算原luminance contrast和0.1875 bound，最后才做Exposure/Tonemap。边缘从旧robust-OOB隐式零值改为显式clamp，避免边框被虚假黑邻居过锐化。
- `BloomPass` 的multi-resolution reconstruction与shared `FinalColorPyramid` consumer保持不变，但graph接入增加`composite`静态选项。normal frame在reconstruction后直接返回`input.source`作为未物化composited identity，旧composite node/resource根本不加入graph，Final Output读取reconstructed结果；Bloom product同时返回由实际resolution-clamped mip count计算的`bloomWeightNormalization(mipCount)`，Final Output与旧composite消费同一权威值，避免极小输出不足5 mip时亮度偏差。只是intensity uniform移动到Final Output。Bloom reconstructed mip0实际从Final mip1开始、extent为output的半分辨率，因此FrameGraph domain现明确为`output-half`，只有capture exception生成的`Bloom composited`才是`output-full`；禁止用`output-full`标签掩盖半分辨率中间产品。Bloom evidence在标准workload的normal frame报告reconstruct=5、composite materialization=0。
- one-shot `post-color-grading` capture是唯一合法materialization exception。capture instrumentation已经进入MainGraph cache key；该recipe令BloomPass增加一次原composite、再惰性创建`ColorGradingPass`写`COPY_SRC rgba16float`，随后在同一main command中执行现有有界copy/readback。Final Output对该输入选择`colorGrading=false, bloom=false`避免双重处理，但仍可融合capture boundary之后的Sharpen与display mapping。下一非capture frame恢复normal fusion recipe。capture-only ColorGrading owner不持有GPU资源，首次惰性创建后保留，以保证缓存compiled capture graph的回调不指向已退役owner；该CPU descriptor不会在normal frame产生pass、texture、readback或submit。
- Render Debug仍覆盖最终scene HDR而不改写history。debug topology即使scene配置Bloom/grading/sharpen也选择三者全false的Final Output source variant，仅保留既有Exposure/display mapping；debug source显式固定在post-temporal/motion-blur、pre-post-effects HDR，与post capture同帧开启也不改变观察值。没有debug consumer的Bloom reconstruction会被FrameGraph裁剪。Automatic Exposure继续从pre-Bloom `FinalColorPyramid` lowest mip生成adapted scalar，不被融合为full-resolution scan，也不改变提交感知history slot。
- Normal lifecycle不再创建`SharpenPass`或为普通帧创建`ColorGradingPass`；旧类暂只保留Step 10 deletion gate所需的capture materialization（ColorGrading）与待删除dead Sharpen source。Bloom、Exposure、MotionBlur与Final Output仍由一个PostFeature组合，feature toggle通过既有topology key选择静态recipe；automatic exposure off只换成已有transient scalar exposure uniform，不产生新pass。RenderSettings新增post参数finite/range门禁，拒绝NaN/Infinity、负Bloom、越界Sharpen、无效gamma/gain/saturation/contrast和无界exposure speed进入uniform。
- 新增公开bounded `FinalOutputRuntimeEvidence`，不泄漏GPU handle：报告Final Output pass数、Bloom/ColorGrading/Sharpen各自是否融合、capture-only Bloom composite/ColorGrading materialization pass、standalone Sharpen pass、三个已知output-full HDR intermediate实际resource数、debug bypass和one-shot materialization。Profiler同步发布`post.finalOutputPasses`、三个fused flag与`post.fullResolutionHdrIntermediates`；GPU phase classifier将`Final Output`继续归入post而不是unknown。
- pure ABI/source oracle冻结无effect与full-effect binding plan、SDR plain variant物理缺少Bloom/grade/sharpen表达、HDR full variant包含Bloom/grade/neighbor load、Main graph normal fusion/capture exception以及不再调用standalone Sharpen。新增唯一canonical real-Chrome `surface.post-fusion`：all-on normal frame要求一个Final Output、零`Bloom composited/Color graded/Sharpened` resource、零独立三pass和one-submit；Bloom/Sharpen off要求静态裁剪；one-shot capture要求恰好两个HDR materialization、finite rgba16float readback且下一帧恢复zero-intermediate fusion。
- 本Step没有引入新的外部算法。Color Grading继续沿用`SHADE-GRADING`已登记的Filament invariant reference；Bloom reconstruction、RCAS-like bounded sharpen、SDR ACES近似、HDR GT7路径均保留现有OEngine实现，本次只改变资源/Pass ownership和表达组合。不能把“融合代码存在”当作性能提升；只有相同adapter/browser/output/internal resolution/画质下的HDR traffic、post GPU phase与整帧PERF A/B才能证明收益。
- 按本轮持续有效的“不跑代码测试”约束，没有执行TypeScript/build、WGSL compilation、pure tests、source selector、真实Chrome `surface.post-fusion`、SDR/HDR/debug/capture visual、MILESTONE或唯一`comprehensive-full` PERF。因此实际HDR roundtrip减少、variant binding正确性、capture像素语义与性能收益仍是待执行Gate；本记录只表示Step 9 production implementation landed，不表示Exit通过，也不关闭Step 5–8的open验证项。

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

scene-wide GI exclusive plumbing 已在 Step 5 cutover 时提前删除；Step 10 只需验证公开符号、topology key、FrameGraph owner 与 shader audit 中均无回流。若未来引入 coarse scene default，它只能作为 provider availability/default policy，不能绕过 receiver-level selection ABI。

只保留确有独立产品需求和证据的算法选择，不复制主管线，不保留迁移用 `legacy/new` 开关。

**Verification:** final MILESTONE + PERF

**Implementation record（当前为 cutover-cleanup-landed / final-verification-open）**

- Step 10 不再设置第二套backend或`legacy/new`切换。静态consumer audit显示主管线只从`SurfaceFeature → PackedMaterialResolvePass → MaterialTileClassificationPass + ComputeMaterialResolvePass`进入material evaluation；`MaterialClassDepth`、active-class fullscreen resolve、`GpuSurfaceAbi`、`ComputeMaterialSurfaceBridgePass`、三个旧IBL fullscreen pass与`OpaqueLightingPipeline`均已在Step 2–3的consumer cutover中物理删除。本Step进一步删除仅有单一`"tile-compute"`值、不具备选择语义的`MaterialResolveBackend.ts`类型壳；对外bounded migration evidence仍只报告当前production identity，不提供可变backend入口。
- GPU counter ABI从v21提升为v22，删除没有producer的旧Pixel Queue kernel-class字段`kernelBaseFactorPixels..kernelGenericFallbackPixels`、已消失`ShadeWork` queue的`shadeWorkOverflow`，以及为被删除MaterialClassDepth/fullscreen kernel每帧人工写0的`classDepthPixels/classDraws`。`PackedMaterialResolvePass`不再编码这些zero publisher，capability evidence不再宣称它们是supported runtime truth，Main pipeline也不再注册`classDraws`。indices 88–97保留为空洞，后续live counter仍保持原index 98–139，buffer仍由最高live index决定为560 B；这避免为“删逻辑字段”付出全部WGSL offset重排和证据漂移。
- 同时删除始终为0的CPU profiler metric `packed.material.kernelDraws`、`PackedMaterialResolvePass.lastKernelDrawCount`与Surface转发getter。这些值只能证明一个已不存在的fullscreen draw没有运行，不是MaterialTileWork正确性证据；保留的是`materialTileRecords/ValidPixels/ShadedPixels/Unassigned/Duplicate/OverflowQueues/FrameInvalid`这组GPU producer→consumer闭环计数。
- old default AO在当前源树中没有并行SSAO/legacy owner；唯一`mode=gtao` owner是Three-derived `GtaoPass`。old SSR也没有并行reflection pipeline；唯一SSR service指向Three-derived trace/resolve/recurrent-denoise/temporal chain和baseline replacement correction。但Step 4 corrected-rand及Step 5–6的真实Chrome、视觉、topology matrix与PERF Gate仍未执行，因此本Step不删除任何仍可用于回退/对照的AO/SSR数学或history，也不宣称replacement Exit已关闭。
- duplicate pyramid audit只找到一个`SharedColorPyramidPass`：SSR消费`OpaqueColorPyramid`，Bloom/Exposure消费`FinalColorPyramid`；SSGI继续直接读取语义不同的full-resolution pre-SSGI source。effect-local SSR scene-color pyramid、Bloom downsample pyramid或Exposure full-resolution reduction没有生产owner。由于Step 7 Gate仍open，不进一步合并语义不同的opaque/final source，也不删除它们各自的typed contract。
- history audit保留`color/gtao/ssgi/ssr/nss-feedback/exposure`六个已登记semantic；每一个都有可配置consumer、独立resolution/format/pre-exposure policy与submission-aware lifecycle，没有可靠静态判定的dead history。scene-wide exclusive GI mode、`enableGTAO/enableSSGI`双布尔和矛盾组合均不在public config/topology key中；唯一入口是receiver-level long-range provider selection加单值`ScreenSpaceDiffuseMode=off|gtao|ssgi`。
- Step 9已使normal production graph不再调用`SharpenPass`，但其Final Output画面、WGSL variant和PERF Gate未执行。严格按“replacement通过后才删除”，`SharpenPass.ts`/`sharpen.ts`暂保留为待Gate关闭后的明确deletion target，但它没有公开switch、normal FrameGraph consumer、GPU allocation或submit。capture-only `ColorGradingPass` 不是dead code；它是`post-color-grading` instrumentation boundary的唯一物化owner，不得与Sharpen一起删除。
- source oracle增加counter schema v22的退役字段禁止回流与reserved-hole断言；既有Step 2–7 ABI/source oracle继续检查被删文件不存在、不含`PackedMaterialClassDepthPass`、Surface V1不回流、GI无scene-wide mode、single-valued screen-space diffuse topology以及共享pyramid唯一producer。这些oracle已更新但本轮未执行。
- 按本轮持续有效的“不跑代码测试”约束，没有执行type/build、pure/source oracle、shader audit、Browser MILESTONE、视觉检查或唯一`comprehensive-full` PERF。因此Step 10只能记为“已完成可证明属于此前已过门禁范围的静态cutover cleanup”；Step 4 也已因 corrected Three.js rand 重新打开验证，GTAO/SSGI/SSR/shared products/temporal/post的最终deletion Gate与ADR-0009整体completion仍保持open。

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
- Feature topology matrix：至少验证 `mode=gtao + SSR off/on`、`mode=ssgi + SSR off/on`、`mode=off + SSR off/on`。最终公开配置已经直接使用单值 mode，旧 `enableGTAO/enableSSGI` 双布尔不再属于可表达输入；类型/API contract 必须证明矛盾组合已被删除，而不是在运行时静默选一个。每种组合记录实际 pass、texture、history、dispatch、bytes 与 counter，证明关闭功能接近零成本，而不是只看最终截图。
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
