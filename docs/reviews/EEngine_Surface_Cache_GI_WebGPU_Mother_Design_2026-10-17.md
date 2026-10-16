---
id: review/eengine-surface-cache-gi-mother-2026-10-17
state: history
---

> 需求与研究原稿，正文保留供逐项追踪；不作为第二份施工 authority。当前完整裁决、源码勘误与执行分别见[详细设计](../next-design/eengine-surface-cache-gi-2026-10.md)和[执行计划](../next-execution/eengine-surface-cache-gi-execution-2026-10.md)。原文的 V1/V2、4GB目标、L1压缩说明与移植边界按详细设计修正。

# EEngine Surface Cache GI / Indirect Diffuse 架构设计母稿

> **状态**：Mother Design v1.0\
> **研究截止时间**：2026-10-17\
> **EEngine 基线**：`bigbigbig2/EEngine` / `master` / `3000de2ab7caee2f5a20d86ded367ff3ba2e32c5`\
> **设计对象**：下一代动态间接漫反射（Indirect Diffuse / Global Illumination）\
> **目标平台**：WebGPU 主路径；允许为了完整实现引入 Compute World Query / Software Ray Query；未来可替换或扩展 Native Hardware RT backend，但本稿不设计未来高端 RT / ReSTIR / Path Tracing 总架构。\
> **核心目标**：高性能、现代 AAA 画质、动态世界、无强制烘焙、与 EEngine 现有 Virtualized GPU Scene / Visibility / Native Surface 架构自然融合。\
> **实施原则**：成熟算法/开源实现优先跨语言移植；不为了“WebGPU 简单能跑”而阉割 Unity Surface Cache GI 的核心机制；允许大胆删除、重构和替换 EEngine 中已经不适合当前生产路径的旧 GI 资产。

---

## 0. 结论先行

这份母稿正式选择的主路线不是传统的：

```text
SSGI
+
传统 Light Probe Volume
+
一个独立的 World GI
```

而是：

```text
                    Indirect Diffuse
                           │
                           ▼
              Cascaded Sparse Surface Cache
                 world-space authoritative
                           │
           ┌───────────────┴───────────────┐
           │                               │
           ▼                               ▼
  Sparse world-cache update        Half-res screen query
  directional irradiance           directional L1 irradiance
           │                               │
           └───────────────┬───────────────┘
                           ▼
                Edge-aware reconstruction
                           │
                           ▼
                Native Surface integration
                           │
                           ▼
                Final indirect diffuse
```

后续可在这套世界缓存上再增加：

```text
Screen Radiance Gather
    ├─ Horizon-based near-field gather
    └─ Screen Probes
```

但它们不是另一套独立“SSGI”，而是 **Surface Cache 的近场高频补偿/反馈层**。

本稿推荐直接把 **Unity 6.7 Surface Cache GI（SCGI）** 当作目前最重要的生产级算法参考和行为规范 donor，同时：

1. **不照搬 Unity Renderer 架构**；
2. **不为了 WebGPU 简化成 Probe GI**；
3. **保留其稀疏 patch cache、camera-follow cascades、方向分桶、visible/bounce patch allocation、multi-bounce、temporal/spatial filtering、half-res directional resolve、edge-aware reconstruction 等核心机制**；
4. **把 Unity UnifiedRayTracing 的 compute fallback 思想迁移到 EEngine，但实现层直接优先参考原始 RadeonRays，而不是复制 Unity Companion License 下的移植代码**；
5. **针对 EEngine Visibility Buffer + Native Surface 做一次有目的的重构**：不恢复宽 GBuffer，而让 GI 继续作为“入射漫反射 irradiance”进入 Native Surface；
6. **用 EEngine 自己的 GeometryProduct / VirtualGeometryResidency / AppearanceGraph / VT / Temporal Identity 作为事实源**，不维护第二套独立世界。

最终 EEngine 的非硬件 RT 动态 GI 主路径建议收敛为：

```text
GpuRenderWorld / GeometryProduct
            │
            ├───────────────────────────────┐
            │                               │
            ▼                               ▼
     Primary Visibility              SurfaceCache Query Scene
            │                         compute world visibility
            ▼                               │
     Screen Cache Requests                   │
            │                               │
            └──────────────┬────────────────┘
                           ▼
                 Surface Radiance Cache
            sparse + cascaded + directional
                           │
                           ▼
                 Half-res L1 SH field
                           │
                           ▼
               Native Surface fused resolve
                           │
                           ▼
               Indirect Diffuse Radiance
```

这条路线和 EEngine 现有的 Virtual Geometry、Virtual Texture、Virtual Shadow 的“**虚拟地址 + 稀疏物理资源 + GPU 驱动更新 + 有界预算**”思想是一致的，值得作为 Raster/Hybrid Core 闭合前的正式 GI 主线。

---

# 1. 当前 EEngine 到底已经推进到哪里

本稿不是从文档想象 EEngine，而是以当前 `master` 源码为基线。

当前真正的生产链已经可以概括为：

```text
GpuRenderWorld
     │
GeometryProduct / Geometry Residency
     │
GPU Hierarchy / LOD / Meshlet Work
     │
Visibility + Depth
     │
HZB
     │
├── LocalLightWork
├── VSM
└── XeGTAO
     │
Native Surface
     │
├── Native Material / PBR
├── Environment diffuse/specular
├── Physical Sun / local lights
├── AO
├── VT feedback
├── temporal identity / response
└── SSSR receiver publication
     │
SSSR
     │
Physical Sky / Aerial
     │
Native Temporal / FSR3
     │
Radiometry / Bloom / Present
```

其中以下部分已经不应被未来 GI 设计反复推翻：

- Virtual Geometry / GeometryProduct / GPU hierarchy traversal；
- Geometry Residency / page streaming；
- Streaming Virtual Texture；
- Visibility Buffer / Depth / HZB；
- Native material evaluation；
- Native Surface；
- VSM；
- XeGTAO；
- SSSR；
- Physical Environment / Sky / IBL；
- Native Temporal / FSR3；
- FrameProgram / FrameProgramLowering 的 semantic-product 组织方式。

这意味着现在缺的不是“另一个 renderer”，而是一个真正能和上述链路对接的 **authoritative indirect diffuse provider**。

## 1.1 当前 FrameProgram 是必须保护的资产

`OEngine/src/render/program/FrameProgram.ts` 已经把 frame 组织成：

```text
Semantic Product
    ↓
Producer
    ↓
Consumer
    ↓
Domain / Extent / Format / Lifetime
```

而不是随意执行的 pass list。

当前生产 stage 已经包括：

```text
visibility
hzb
local-light-work
vsm
xe-gtao
surface
sssr
physical-sky
aerial
temporal
fsr3
radiometry
bloom
present
```

因此新 GI 不应该把内部：

```text
scroll
allocate
estimate
temporal filter
spatial filter
lookup
upsample
```

全部暴露成 FrameProgram 一级 stage。

推荐只增加一个真正有语义意义的 stage：

```text
surface-cache-gi
```

以及一个真正跨模块的语义 publication：

```text
indirect-diffuse-field
```

内部二十个 compute pass 仍然由 `SurfaceCacheGIRuntime` 私有拥有。

这和当前 `SssrRuntime` 的模式一致，但 GI 必须比 SSSR 更严格地控制 full-resolution intermediates。

---

# 2. 为什么应该推翻旧 GI 主线，而不是继续接回去

仓库中已经存在一批早期 GI 资产：

```text
OEngine/src/shaders/long_range_diffuse_provider.ts
OEngine/src/shaders/screen_space_diffuse_resolve.ts
OEngine/src/gpu/GPULightProbeVolume.ts
OEngine/src/gpu/LightProbeAtlas.ts
Brick4 / Probe Volume 相关代码
```

这些代码不是毫无价值，但它们代表的是早期架构：

```text
Surface GBuffer-like publication
        ↓
Brick4
        ↓ miss
Probe Volume
        ↓ miss
IBL
        ↓
Screen-space diffuse delta resolve
```

`long_range_diffuse_provider.ts` 甚至已经具备：

- Probe tetrahedral lookup；
- BVH；
- SH irradiance；
- depth moments visibility；
- Brick4 → Probe → IBL provider precedence。

问题不在“技术太老”四个字，而在于它和现在的 Native Surface 生产路径发生了架构错位。

现在真正的 Surface 已经是：

```text
Visibility
    ↓
reconstruct geometry/material
    ↓
Native Surface
    ↓
direct + environment + AO + temporal + reflection receiver
```

如果为了旧 GI 再恢复：

```text
normal texture
bent normal texture
albedo texture
material texture
metadata texture
```

就等于重新制造一套宽 GBuffer。

这会带来：

- full-resolution 写入带宽；
- full-resolution 读取带宽；
- material response 重复计算；
- AO/IBL/GI double count；
- 与 Visibility Buffer 的价值相冲突；
- 新 GI 被旧架构绑死。

因此本稿建议：

> **旧 GI 的数学资产可以保留，但旧 GI 的生产拓扑应退出主路径。**

推荐处理：

| 现有资产 | 决策 |
|---|---|
| `long_range_diffuse_provider.ts` | 不作为新主线；完成新 GI 后删除/归档 |
| `screen_space_diffuse_resolve.ts` | 不接回生产；由 Native Surface 原生消费 GI 取代 |
| `GPULightProbeVolume` | 暂时保留为历史/可选 fallback；无实际 consumer 后删除 |
| Probe SH / oct / visibility 数学 | 可提取为共享数学工具 |
| Brick4 | 仅当未来有真实 consumer；否则不为兼容而保留 |
| 旧 BLAS/TLAS 实现 | 不作为新 GI authoritative query scene，允许推翻 |

---

# 3. 选定的技术：Surface Cache GI 到底是什么

它不是传统 Reflection Probe，也不是传统均匀 Irradiance Probe Grid。

核心思想是：

> **只在“真正有表面、真正需要间接光”的世界位置分配方向性 irradiance patch，然后把昂贵世界可见性计算跨空间、跨像素、跨帧摊薄。**

抽象成：

```text
World Space
    │
Camera-follow Cascades
    │
Spatial Cell
    │
Directional Bin (normal orientation)
    │
Sparse Physical Patch
    │
Directional L1 Irradiance
    │
Temporal / Spatial Reuse
    │
Screen Query
```

传统 Probe Grid：

```text
3D 空间中均匀放 Probe
→ 很多 Probe 在空气、墙体内部、无人区域
→ 仍要分配内存/更新
```

Surface Cache：

```text
3D 逻辑地址空间
→ 只有真实 surface 请求才创建 patch
→ 世界逻辑覆盖范围大
→ 物理 lighting storage 稀疏
```

这和：

```text
Virtual Texture
Virtual Geometry
Virtual Shadow
```

是同一类思想：

```text
大逻辑空间
+
小物理预算
+
按需驻留
+
时间复用
```

---

# 4. Unity 6.7 SCGI 源码解剖：哪些机制必须完整迁移

Unity 2026 的 SCGI 不是单个 shader。它实际上由一个完整的缓存运行时组成。

公开源码主要位于：

```text
Packages/com.unity.render-pipelines.core/Runtime/Lighting/SurfaceCache/
Packages/com.unity.render-pipelines.universal/Runtime/RendererFeatures/SurfaceCacheGIRendererFeature/
Packages/com.unity.render-pipelines.core/Runtime/UnifiedRayTracing/
```

## 4.1 Cascaded Surface Cache Volume

Unity 当前实现：

```text
SpatialResolution = R
CascadeCount = C
AngularResolution = 4
```

每个 spatial cell 有：

```text
4 × 4 = 16
```

个方向 cell。

逻辑 cell 数：

```text
Ncell = R³ × 16 × C
```

默认：

```text
R = 32
C = 4
```

所以：

```text
32³ × 16 × 4
= 2,097,152 logical cells
```

但是逻辑 cell 不直接存 200B lighting data。

逻辑层只存：

```text
allocation mark
patch index
```

每个两个 `u32`：

```text
~8B / logical cell
```

默认 cell table：

```text
≈ 16 MiB
```

真正昂贵的 lighting 数据放在一个 **bounded physical patch pool**。

这是必须保留的设计。

---

## 4.2 Directional cell addressing

Surface 不能只按 world position 查 cache。

同一位置不同朝向的表面可能接收完全不同的 irradiance，因此地址是：

```text
(world cell, surface orientation bin)
```

Unity 使用：

```text
4 × 4 octahedral orientation bins
```

即 16 个方向。

本稿建议 EEngine V1 保持相同 `A=4`。

不要为了节省内存降成：

```text
position only
```

那会显著增加：

- 薄墙漏光；
- opposite-facing surface 混光；
- 室内外串色；
- cache spatial filter 错误。

方向分桶是 Surface Cache 高质量的核心之一。

---

## 4.3 Sparse Patch Pool

Unity patch 逻辑布局大致为：

```text
geometry:
    position + normal                  ~24B

cell index:
    logical cell id                     4B

irradiance:
    3 × 12 floats                     144B

statistics:
    running moments / counters        ~28B
------------------------------------------
logical total                         ~200B/patch
```

因此：

```text
32K patches  ≈ 6.25 MiB
64K patches  ≈ 12.5 MiB
128K patches ≈ 25 MiB
256K patches ≈ 50 MiB
```

不含 allocator/scratch/对齐。

注意：Unity patch 中的 irradiance 是运行时 filter 需要的工作表示；屏幕 resolve 的方向性 L1 SH 会进一步压缩存储。

EEngine 不应该一开始“聪明地”把这 200B 改成 64B。

先保留算法语义，真实 profiling 后再压缩。

---

## 4.4 Ring allocation、eviction、scrolling、defrag

SCGI 不是 `Map<cell, probe>`。

它是 bounded cache。

必须完整具备：

```text
camera cascade scrolling
     ↓
logical cells remap
     ↓
stale patch unmap
     ↓
ring allocation
     ↓
eviction
     ↓
bounded defragmentation
```

Unity 的 cascade follow camera。

相机移动后：

- 不重新创建整个 cache；
- 逻辑 cascade offset 改变；
- 超出新 volume 的 cell 被取消映射；
- 物理 patch 重新回到可分配 ring。

这对于大场景是必须的。

EEngine 不能做：

```text
camera moved
→ clear all GI
→ rebuild
```

否则 temporal convergence、稳定性和性能都会崩。

---

## 4.5 Screen-visible patch allocation

Unity 每帧从当前可见 surface 产生 cache demand。

关键不是：

```text
每 pixel 一个 patch
```

而是：

```text
low-res screen sample
    ↓
world position + flat normal
    ↓
resolve cascade + cell + orientation
    ↓
patch already exists?
    ├─ yes: touch/update rank/access
    └─ no : sparse allocate
```

新 patch 还会尝试从上一帧 screen GI history **seed irradiance**，避免刚看到一个区域时从全黑开始收敛。

Unity 的 seed 逻辑包括：

- motion-vector reprojection；
- previous depth/world position；
- plane-distance validation；
- cache voxel-scale tolerance；
- valid history 才初始化。

这一机制必须迁移。

EEngine 不能简单：

```text
new patch = 0
```

然后等几十帧。

---

## 4.6 Visible patch 与 bounce patch rank

Unity cache patch 有 rank 概念。

最核心：

```text
rank 0 = 当前摄像机可见 surface
rank 1 = indirect bounce 中发现的 surface
```

可见 patch 优先级更高。

bounce-generated patch 让 cache 不局限于摄像机看到的表面，因此可以传播到：

- 拐角后；
- 屏幕外；
- 第二跳间接区域。

Screen visibility 重新遇到 rank 1 patch 后可以提升其优先级。

EEngine 应保留这个层次，而不是把所有 patch 当等价。

未来可以扩 rank，但 V1 不需要提前泛化。

---

## 4.7 Estimation：真正的世界间接光来源

每个需要更新的 patch 对 hemisphere 做少量世界 query。

Unity 的 cache sample 可以得到：

```text
environment miss
directional direct light
punctual direct light
emissive material
existing cache multi-bounce
```

如果 hit 到 surface：

```text
Lo =
    emissive
  + direct diffuse
  + cached indirect diffuse
```

再乘：

```text
diffuseAlbedo / π
```

得到 outgoing diffuse radiance。

新入射 sample 最终投影到 L1 SH，并做 cosine convolution，形成 directional irradiance。

这意味着 SCGI 不是：

```text
把屏幕颜色抄进世界缓存
```

而是真正有 world visibility 的动态 irradiance estimator。

---

## 4.8 Multi-bounce

多 bounce 的性能关键不是每次 sample 真追很多 bounce。

而是：

```text
ray
  ↓
first hit
  ↓
query existing surface cache
  ↓
approximate remaining transport
```

因此：

```text
昂贵 visibility
+
便宜 cache lookup
```

组合出 multi-bounce。

如果 bounce hit 处还没有 cache patch，Unity 可以：

```text
emit bounce patch allocation request
```

让未来帧补齐该区域。

这也是必须保留的设计。

---

## 4.9 Temporal filtering

Surface Cache 自己必须有 temporal history。

最终 Native Temporal / FSR3 不能代替它。

Unity 使用 variance-guided temporal filter：

```text
sample irradiance
    ↓
short-term mean / variance
    ↓
compare long-term irradiance
    ↓
estimate drift
    ↓
adaptive hysteresis
```

稳定区域：

```text
长 history
```

光照改变区域：

```text
快速降低 hysteresis
```

新 patch：

```text
incremental convergence
```

EEngine 必须保留这种 **signal-local temporal**。

否则最终 TAA 只能稳定画面，无法稳定 world lighting state。

---

## 4.10 Spatial filtering

Patch temporal filter 后还会做 world-space spatial filtering。

采样位置不是简单 3D 邻格平均，而是围绕：

```text
patch position
patch normal tangent plane
cascade voxel scale
```

做 jittered nearby cache lookup。

这样可以平滑稀疏 sampling noise，同时保持 surface orientation。

低质量档可以关闭；中高档保留。

---

## 4.11 Half-resolution directional screen resolve

Unity 的最终 screen query 不在 full resolution 查询 world cache。

固定：

```text
upscaleFactor = 2
```

即：

```text
half linear resolution
quarter pixel count
```

1080p：

```text
1920×1080
→ 960×540
→ 518,400 GI query pixels
```

而不是：

```text
2,073,600 pixels
```

每个 low-res sample：

```text
depth
flat normal
world position
    ↓
world cache directional lookup
    ↓
RGB L1 irradiance
```

输出：

```text
L0
L10
L11
L12
depth
```

然后 full-res reconstruction。

这个结构非常适合 EEngine。

---

## 4.12 L1 directional irradiance compression

Unity 没有只存 RGB ambient。

它保留：

```text
RGB L0
+
3 × RGB L1 coefficients
```

以表示 incoming diffuse lighting 的方向性。

在 screen history 中，L1 coefficient 使用 direction + relative magnitude 形式压缩：

```text
direction
→ oct encode

length
→ relative to L0
→ nonlinear encoding
```

保存在 4 张 `RGBA16F` 中。

这样最后可以用 **真正的 shaded normal** 评估 irradiance。

这对于：

- normal map；
- curved surface；
- fine shading normal；

非常重要。

不能为了省 texture binding 改成：

```text
RGB irradiance only
```

否则高频 normal response 会明显丢失。

---

# 5. Unity 实现不能逐字复制：许可证与 donor 策略

这里必须严格区分“完整移植算法”和“逐行复制代码”。

Unity Graphics 仓库根许可证是 **Unity Companion License**，用途与 Unity-dependent project 绑定。

因此对于独立 EEngine：

> **不能默认 Unity SCGI 代码可以直接脱离 Unity 逐行复制。**

本稿建议：

### Unity Graphics

用途：

```text
算法行为规范
pass dependency
data layout
quality parameters
filter math
reference implementation
```

除非以后完成独立许可证审查，否则：

```text
不以 verbatim copy 作为实现策略
```

### RadeonRays

Unity 自己的 compute ray tracing fallback README 明确说明它的 C# RadeonRays 部分来自 RadeonRays 4.1 C++ port。

原始：

```text
GPUOpen-LibrariesAndSDKs/RadeonRays_SDK
```

采用宽松 MIT-like 许可，可在保留 notice 的前提下：

- 使用；
- 修改；
- 分发；
- sublicensing；
- 商用。

因此 EEngine compute world-query backend 应优先：

```text
Original RadeonRays C++ / HLSL
        ↓
TypeScript host + WGSL port
```

而不是：

```text
copy Unity C# port
```

这既减少许可风险，也更符合你的“跨语言完整移植”原则。

> 本节是工程风险提示，不构成法律意见。

---

# 6. EEngine 目标架构

最终建议结构：

```text
                           GpuRenderWorld
                                │
            ┌───────────────────┴───────────────────┐
            │                                       │
            ▼                                       ▼
     Raster Scene Truth                    GI Query Scene View
 GeometryProduct / Instances          derived from same scene truth
 Materials / VT / Lights                       │
            │                                  │
            ▼                                  ▼
     Visibility + Depth             Compute Acceleration Structure
            │                                  │
            │                    closest / visibility queries
            │                                  │
            └────────────────┬─────────────────┘
                             ▼
                     SurfaceCacheGIRuntime
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
    Logical Cascades   Sparse Patch Pool   Cache Filtering
          │                  │                  │
          └──────────────────┼──────────────────┘
                             ▼
                   Half-res Directional Field
                  L0/L1 + depth + flat normal
                             │
                             ▼
                       Native Surface
                edge-aware upsample + SH eval
                             │
                             ▼
                 authoritative diffuse incident
                             │
                             ▼
                 Material diffuse response
                             │
                             ▼
                   Surface HDR Radiance
```

这里最重要的架构约束：

> **只有一个 Scene Truth；可以有多个 GPU View。**

不能：

```text
GpuRenderWorld
+
独立 SurfaceCacheWorld
+
独立 GI material database
+
独立 GI texture system
```

长期各走各的。

Unity 为了通用 RenderPipeline 有 `SurfaceCacheWorld` adapter。

EEngine 自己没有必要复制这种宿主层。

应该直接从：

```text
GpuRenderWorld
GeometryProduct
GpuNativeMaterialScene
LightDatabase
TextureResidency
VirtualTextureResidency
```

派生 GI view。

---

# 7. 新模块的建议所有权

本稿建议新建：

```text
OEngine/src/render/gi/
    SurfaceCacheGISettings.ts
    SurfaceCacheGIAbi.ts
    SurfaceCacheGIRuntime.ts
    SurfaceCacheGIPublication.ts
    SurfaceCacheGIQueryScene.ts
    SurfaceCacheGIMaterialView.ts
    SurfaceCacheGIDebug.ts
```

shader：

```text
OEngine/src/shaders/gi/
    surface_cache_common.ts
    surface_cache_patch.ts
    surface_cache_scroll.ts
    surface_cache_allocate.ts
    surface_cache_evict.ts
    surface_cache_defrag.ts
    surface_cache_estimate.ts
    surface_cache_temporal.ts
    surface_cache_spatial.ts
    surface_cache_screen_anchor.ts
    surface_cache_screen_lookup.ts
    surface_cache_irradiance.ts

    query/
        rr_bvh_build.ts
        rr_tlas_build.ts
        rr_traversal.ts
        rr_intersection.ts
```

名字可以在实现时调整，但 ownership 建议保持清晰。

## `SurfaceCacheGIRuntime`

负责：

```text
cache resources
cache lifetime
cache update
patch allocator
history
query dispatch
screen field
commit/abort
device loss
resource accounting
```

它应该像：

```text
SssrRuntime
Fsr3UpscalerRuntime
```

一样拥有 transaction semantics：

```text
prepare
attach / encode
commit
abort
invalidate
destroy
```

不能把 persistent cache 资源扔给 FrameGraph 随帧创建。

---

# 8. FrameProgram 如何接入

新增 semantic stage：

```text
surface-cache-gi
```

推荐逻辑顺序：

```text
visibility
→ hzb
→ local-light-work
→ vsm
→ xe-gtao
→ surface-cache-gi
→ surface
→ sssr
→ physical-sky / aerial
→ temporal
```

GI 与 AO 之间没有算法依赖，这个顺序只是生产 scheduling。

真正依赖：

```text
surface-cache-gi consumes:
    visibility
    depth
    scene/material/light publications

surface consumes:
    indirect-diffuse-field
```

新增 semantic product 建议：

```text
indirect-diffuse-field
```

语义：

```text
scene-linear
unexposed
directional diffuse incident irradiance field
```

注意它不一定是一张 texture。

实际 publication 可以包含：

```text
current low-res compressed L1 SH × 4
current low-res depth
current low-res flat normal
validity/generation
settings/constants
```

FrameProgram 只知道：

```text
“Surface 所需的 authoritative indirect-diffuse publication ready”
```

不要把：

```text
patch statistics
allocator
defrag scratch
trace scratch
temporal moments
```

暴露成 FrameProduct。

---

# 9. EEngine 最大的优化点：不要照 Unity 生成 full-res GI 再让 Surface 读取

Unity URP：

```text
low-res cache lookup
      ↓
4× low-res L1 textures
      ↓
full-res edge-aware upsample
      ↓
full-res RGBA16F irradiance
      ↓
lighting consumes
```

EEngine 如果完全照这个物理 pass，会多出：

```text
full-res irradiance write
+
Native Surface full-res irradiance read
```

1080p 一张 `RGBA16F`：

```text
15.82 MiB
```

单次写 + 单次读：

```text
31.64 MiB/frame
≈ 1.90 GiB/s @ 60 FPS
```

仅这是理论最低流量。

EEngine 已经有 Visibility Buffer + Native Surface，因此建议做一个 **架构等价、物理执行更合适的移植**：

```text
Half-res L1 field
        ↓
Native Surface
        ├─ reconstruct current world position
        ├─ exact geometric flat normal
        ├─ exact shaded normal
        ├─ sample neighboring low-res GI anchors
        ├─ depth/plane/normal edge weighting
        ├─ decompress weighted L1
        └─ evaluate L1 with shaded normal
        ↓
incident diffuse irradiance
```

这样：

- Unity 的 directional information 保留；
- edge-aware upsample 保留；
- shaded-normal evaluation 保留；
- 不需要 full-res GI texture；
- 不需要 full-res shaded-normal GBuffer；
- 少一次 full-res write/read；
- Material response 仍然只算一次。

这是本稿最推荐的 EEngine-specific adaptation。

---

# 10. 为此需要增加一个 GI Screen Anchor pass

Unity 使用 full-res flat-normal buffer。

EEngine 不应该因为 SCGI 恢复 full-res normal GBuffer。

建议增加 GI 私有：

```text
SurfaceCacheScreenAnchor
```

运行在：

```text
half linear resolution
```

每个 anchor 从：

```text
VisibilityKey + GeometryProduct + Depth
```

直接重建：

```text
world position
flat geometric normal
depth
previous position / motion identity
```

输出至少：

```text
depth       R32F
flatNormal  packed
```

以及 patch allocation / history seeding 所需的 motion facts。

Native Surface 当前 full-res pixel 已经可以重建自己的：

```text
world position
geometric normal
shaded normal
```

因此 final upsample 时：

```text
current full-res flat normal
vs
low-res anchor flat normal
```

即可完成 Unity 同类 edge rejection。

这避免：

```text
full-res flat-normal texture
```

的永久成本。

---

# 11. Temporal dependency：不要形成 GI ↔ Surface 环

Unity 可以直接消费已有 motion vector。

EEngine 当前很多 temporal data 是 Surface 产生的。

但 GI 要在 Surface 前完成。

不能：

```text
GI needs Surface motion
Surface needs GI
```

形成环。

解决方案不是把 GI 放回 Surface 后，而是抽取 **共享的 primary geometry temporal math**。

推荐新增内部 WGSL helper：

```text
PrimarySurfaceIdentity
```

从：

```text
VisibilityKey
instance current transform
instance previous transform
primitive/barycentric identity
camera current/previous
```

计算：

```text
current world position
previous world position
previous clip position
motion
identity validity
```

它被：

```text
Native Surface
SurfaceCacheScreenAnchor
```

共同 include。

这样没有 duplicate semantics，也不需要 full-res prepass。

---

# 12. Query Scene：完整 SCGI 必须有世界可见性，不能假装没有

这里明确纠正之前的误解。

既然现在选的是完整 SCGI 路线：

> **需要 world-space visibility query，就应该实现。**

不是为了避免“光追”这个词把算法阉割成屏幕 GI。

但是这不是现在要建立的未来：

```text
RTXDI / ReSTIR / Path Tracing general Ray Work architecture
```

而是 GI 私有的：

```text
SurfaceCacheQueryScene
```

职责只包括：

```text
build/update acceleration
trace closest
trace visibility
fetch hit geometry/material
```

未来闭合 Raster Core 后，可以再决定是否把它升级为通用 RayScene。

现在不要提前做超级 Ray Framework。

---

# 13. Query backend：优先完整移植 RadeonRays compute 路线

建议 donor：

```text
GPUOpen RadeonRays 4.x
```

原因：

- Unity 自己的 UnifiedRayTracing compute fallback 就采用 RadeonRays port；
- 原实现可读；
- 有 GPU HLBVH / TLAS / traversal；
- 许可证宽松；
- 非 NVIDIA-only；
- 非硬件 RT；
- 很适合 WebGPU compute。

迁移：

```text
C++ host
→ TypeScript / EEngine runtime

HLSL compute
→ WGSL

DX/Vulkan resource assumptions
→ WebGPU storage buffers / indirect dispatch
```

需要完整迁移：

```text
HLBVH / Morton
internal / leaf nodes
BLAS build
TLAS build
scratch management
instance transform
instance id/mask
closest hit
any hit / shadow visibility
```

不建议从当前 `GeometryBlasPool` 继续堆。

当前：

```text
GeometryBlasPool
TopLevelAccelerationStructure
DynamicBvh
```

是旧式 CPU/meshlet BVH 资产，没有和现在 GeometryProduct / VirtualGeometryResidency 形成统一真值。

除非实际 benchmark 证明其中 node layout 对新 backend 有明显复用价值，否则：

> **直接替换，比兼容旧代码更健康。**

---

# 14. Virtual Geometry 与 Query Scene：这是 EEngine 迁移最重要的差异

Unity 的 Mesh 世界相对传统。

EEngine 已经是 Virtual Geometry。

如果简单为 SCGI 再复制一套：

```text
all vertex/index triangles
```

会破坏内存目标。

推荐把 query representation 放入 GeometryProduct 体系，而不是独立资产数据库。

长期结构：

```text
GeometryProduct
     │
     ├── Raster hierarchy / page payload
     │
     └── Query section
            ├── stable triangle positions
            ├── primitive/material mapping
            ├── UV / attribute references
            └── query hierarchy metadata
```

## 14.1 Query LOD 不必等于 Raster LOD

GI cache 是低频信号。

Surface cache voxel size 本身给了一个天然几何误差尺度。

因此 query geometry 应允许：

```text
near cascade
→ finer query LOD

far cascade
→ coarser query LOD
```

而不是：

```text
GI always traces raster finest LOD
```

这对性能非常重要。

## 14.2 但必须保证世界覆盖

Query scene 不能依赖：

```text
“这个 mesh 当前是否被相机看到”
```

否则屏幕外 GI 会消失。

每个 asset 至少要有一个：

```text
always traceable coarse representation
```

在 GI active 时保证世界 coverage。

更细 resident pages 可以后续提升 accuracy。

这是 Virtual Geometry 与 World GI 的关键差异：

```text
raster residency
= view driven

GI query residency
= world lighting driven
```

两者可以共享 source/product identity，但不能假设完全相同的 resident set。

---

# 15. Material hit：不能创建第二套 GI 材质系统

SCGI hit 需要：

```text
diffuse albedo
emissive
coverage/opacity
UV
```

未来可能还需要 transmission classification。

不要新建：

```text
GIMaterial
```

手工复制 PBR 参数。

应该从当前：

```text
AppearanceGraph / GpuNativeMaterialScene
```

编译出一个：

```text
IndirectDiffuseMaterialProjection
```

语义只包括：

```text
base diffuse reflectance
metallic-derived diffuse energy
emissive
coverage
```

同一个 material truth：

```text
AppearanceGraph
    ├── Raster Native Closure
    └── GI Diffuse Hit Closure
```

这样：

- material edits 一致；
- VT dependency 一致；
- texture transform 一致；
- 不会出现 GI 和屏幕颜色不同步。

---

# 16. Alpha Test / Coverage 不能偷懒

完整迁移不能把：

```text
foliage
fence
cutout cloth
```

全部当 opaque box。

EEngine 已经有 coverage texture dependency / residency 逻辑。

Query scene 需要支持：

```text
candidate triangle hit
    ↓
interpolate UV
    ↓
evaluate alpha/coverage
    ↓
reject or accept
```

对 performance：

- coverage-critical texture mip 必须保证 resident；
- query 使用 bounded/coarser LOD；
- 避免 GI random ray 触发无限 VT feedback。

最终 V1 acceptance 应包含 alpha-tested geometry。

可以分阶段实现 opaque milestone，但不能把“opaque only”当最终版本。

---

# 17. VT 与离屏 GI：必须防 streaming storm

GI world query 会 hit 到：

```text
屏幕外 geometry
```

如果每个 GI hit 都：

```text
请求最高分辨率 VT page
```

整个 VT 系统会被拖爆。

建议：

```text
GI texture sampling
    ↓
derive texture LOD from:
    cascade voxel size
    hit distance
    projected world footprint
```

并限定：

```text
GI max texture detail
```

优先使用：

```text
pinned mip tail / resident coarse mip
```

只有必要时才产生：

```text
low-priority GI VT feedback
```

Raster visibility feedback 优先级始终高于 GI。

这与 cache 低频性质一致。

---

# 18. Cache irradiance 表示：保持 L1，不降成 scalar RGB

建议 V1 保持：

```text
RGB L1 SH
```

即：

```text
L0
L1x
L1y
L1z
```

意义：

```text
incoming irradiance has directionality
```

最终：

```text
E(normal)
```

可以根据真实 shaded normal 变化。

如果只存：

```text
RGB irradiance
```

normal map 会失去真实间接光方向响应。

这一点对 AAA 材质非常明显。

EEngine 应移植 Unity 的 L1 coefficient compression 思路：

```text
coefficient direction
→ oct encoding

coefficient magnitude
→ relative-to-L0 normalized encoding
```

但由于 Unity source license，建议根据数学行为重新实现 WGSL，而不是逐行复制。

---

# 19. World cache 应存 unexposed scene-linear lighting

缓存里绝对不要存：

```text
pre-exposed color
```

否则 exposure adaptation 会污染历史。

定义：

```text
SurfaceCache irradiance
=
scene-linear
absolute relative radiometric scale
unexposed
```

最终在 Native Surface：

```text
material response
+
other lighting
    ↓
preExposure
    ↓
HDR output
```

这与当前 Exposure/Temporal 体系更一致。

---

# 20. Native Surface 集成：GI 是 authoritative diffuse incident source

当前 Native Surface 已经 sample：

```text
environment diffuse
```

并计算：

```text
diffuse response
```

新 GI 不能：

```text
existing environment diffuse
+
SCGI full contribution
```

直接相加。

因为 SCGI 本身已经包含：

```text
environment first bounce
+
world bounce
```

会 double-count sky/environment。

推荐语义：

```text
E_fallback = environmentDiffuse

E_gi = surfaceCache directional irradiance

confidence ∈ [0,1]

E_indirect =
    mix(E_fallback, E_gi, confidence)
```

然后：

```text
diffuseRadiance =
    materialDiffuseResponse(E_indirect)
```

只算一次。

`confidence` 可以来自：

```text
cache validity
patch age
history convergence
lookup weight
```

第一版可以较简单，但 publication 应预留这一语义。

---

# 21. XeGTAO 与 SCGI：不能继续全局相乘

XeGTAO 是：

```text
near-field ambient visibility approximation
```

SCGI 已经有真实 world-space visibility sampling。

如果：

```text
SCGI × AO
```

无条件执行，会产生：

- corner double-darkening；
- GI color bleeding 被压黑；
- 室内能量损失。

建议第一版：

```text
fallbackVis = XeGTAO

E_indirect =
    mix(
        EnvironmentDiffuse * fallbackVis,
        SurfaceCacheGI,
        giConfidence
    )
```

即：

```text
cache confidence 高
→ AO 对 diffuse GI 影响趋近 0

cache 无效/低置信度
→ AO 帮助 environment fallback
```

Material 自己的 occlusion texture 仍可以作为材质属性参与间接响应。

Specular AO 保持独立，不由本模块改变。

这个公式是 EEngine adaptation，需要用 Cornell/Sponza/Bistro 场景验证，不是声明为唯一物理真理。

---

# 22. Cache update 的逻辑流水

实现时应保持如下完整生命周期：

```text
1. Query scene update / refit
        │
2. Cascade camera scrolling
        │
3. stale cell unmap / eviction
        │
4. bounded defrag
        │
5. screen anchor generation
        │
6. visible patch allocation
        │
7. previous-screen-history seed
        │
8. bounce allocation request consume
        │
9. light candidate preparation
        │
10. patch irradiance estimation
        │
11. new bounce patch requests
        │
12. temporal filtering
        │
13. spatial filtering
        │
14. half-res screen cache lookup
        │
15. GI publication
        │
16. Native Surface fused upsample / SH evaluate
```

具体 dispatch 顺序应以 port 后数据依赖重新确认。

不要为了减少 pass 在第一版过早 fusion。

先保证算法正确。

---

# 23. 不允许 GPU → CPU → GPU 的每帧决策

以下全部留在 GPU：

```text
patch demand
allocation
eviction
rank
last access
bounce requests
active patch list
trace work
temporal validity
cache lookup
```

CPU 只负责：

```text
settings changes
capacity admission
scene structural publication
device lifecycle
```

不要：

```text
readback patch count
CPU decide patch work
GPU dispatch
```

除 debug delayed readback 外，生产 control loop 必须 GPU-driven。

---

# 24. 内存模型

## 24.1 Logical cell table

公式：

```text
Cells = R³ × 16 × C

CellBytes = Cells × 8
```

示例：

| R | Cascades | Cell table |
|---:|---:|---:|
| 24 | 3 | ~5.1 MiB |
| 32 | 4 | ~16 MiB |
| 48 | 4 | ~54 MiB |
| 48 | 5 | ~67.5 MiB |
| 64 | 5 | ~160 MiB |

这里可以看出：

> `R³` 非常敏感。

不能把 `resolution=64` 当默认“Ultra 就开”。

## 24.2 Patch pool

按 Unity 当前约 200B logical patch 估算：

| Patch capacity | 约容量 |
|---:|---:|
| 32K | 6.25 MiB |
| 64K | 12.5 MiB |
| 128K | 25 MiB |
| 256K | 50 MiB |

实际 WGSL alignment / allocator / scratch 另算。

## 24.3 Half-res L1 history

Unity equivalent：

```text
4 × RGBA16F × current/previous
+
R32F depth × current/previous
```

每 half-res pixel：

```text
64B SH history
+
8B depth history
=
72B
```

因此：

| internal size | half-res pixels | L1+depth history |
|---|---:|---:|
| 1920×1080 | 518,400 | ~35.6 MiB |
| 2560×1440 | 921,600 | ~63.3 MiB |
| 3840×2160 | 2,073,600 | ~142.4 MiB |

EEngine 还会增加当前 low-res flat normal：

```text
~2–4B / anchor
```

1080p 大约再增加 1–2 MiB。

这也是为什么：

> **GI 应运行在 internal resolution，而不是 display resolution。**

如果 1080p output 使用：

```text
renderScale ≈ 0.667
```

internal 约：

```text
1280×720
```

half-res history 会显著下降。

---

# 25. Fused Native Surface resolve 的 bandwidth 收益

如果照 Unity 创建 full-res `RGBA16F` GI：

1080p：

```text
write = 15.82 MiB/frame
read  = 15.82 MiB/frame
------------------------
~31.64 MiB/frame
```

60 FPS：

```text
~1.9 GiB/s
```

这还没有算 cache misses。

把 final upsample/SH evaluation 融进 Native Surface，可以消掉这次 full-res roundtrip。

代价：

- Surface 增加低分辨率 GI texture reads；
- bind group/binding pressure 上升；
- shader ALU 增加 SH decode/evaluation。

这是合理 tradeoff。

必须通过：

```text
binding-limit preflight
GPU timing
bandwidth counter
```

验证。

如果某些 WebGPU device binding limits 不够，再启用 Unity-like standalone upsample fallback。

但默认设计应优先 fused path。

---

# 26. Ray/query 工作量模型

这个算法的关键不是：

```text
1 ray / pixel
```

而是：

```text
sample / active patch
```

假设：

```text
64K active patches
2 samples / patch
```

主 GI sample 数：

```text
~128K queries/frame
```

即使额外有 shadow visibility query，也仍然和：

```text
1080p × 1 ray/pixel
= 2.07M primary rays/frame
```

不是一个量级。

真正性能风险来自：

- query BVH quality；
- triangle intersection；
- alpha test；
- offscreen VT fetch；
- cache miss；
- too many active patches；
- dynamic BLAS rebuild；
- large-instance TLAS；
- multi-bounce request growth。

因此最关键的 performance knobs 不是只有 sample count，而是：

```text
patch capacity
update fraction
rank scheduling
cascade resolution
query LOD
BVH build/refit policy
VT hit LOD
```

---

# 27. 建议的质量档位不是最终数值，只是初始实验区间

这些不是 contract，必须真实 benchmark 后改。

## 4GB / WebGPU Compatibility

建议起点：

```text
R = 24–32
C = 3–4
Patch = 32K–64K
Estimation = 1–2 spp
Spatial = off / 4 samples
Half-res screen lookup
Upsample = 1–2 taps
Query geometry = voxel-scale LOD
```

目标：

```text
GI persistent cache + history
尽量控制在 ~80–160 MiB 量级
```

不含 Query BVH。

当前 Dungeon 4GB profile 已经给 non-geometry/effect/transient 预留约 1408 MiB；GI 不应侵蚀掉所有 SSSR/VSM/VT/Temporal 空间。

## 8GB High

建议实验：

```text
R = 32–48
C = 4–5
Patch = 64K–128K
Estimation = 2–4 spp
Spatial = on
Upsample = 2–4 taps
```

## 12GB+ Ultra

不要简单：

```text
R=64 everything max
```

优先增加：

```text
sample quality
patch capacity
near-cascade query geometry detail
screen gather quality
```

因为 R³ cell table 增长非常快。

---

# 28. 性能目标应该写成预算，不应该伪造 benchmark

Unity 社区已有 4060 Laptop 在 Sponza 1080p 默认设置约 1.5–1.6ms 的报告，但这不是 EEngine 预测数据。

Unity 官方只明确：

```text
SCGI 被设计为 high performance / broad platform reach
compute fallback 会比 HWRT 慢
```

因此 EEngine 第一阶段不要承诺：

```text
GTX1650Ti = 2ms
```

建议制定 gate：

```text
必须记录：
    query build/refit ms
    cache maintenance ms
    estimate ms
    temporal ms
    spatial ms
    screen lookup ms
    Native Surface incremental ms
    total GI ms
```

并分别：

```text
static camera
moving camera
dynamic light
dynamic object
cold cache
warm cache
```

测试。

---

# 29. Screen Radiance Gather：作为第二阶段扩展，不与 SCGI 平行造第二套 GI

选定的长期架构仍然包含 Screen Radiance Gather。

但本稿推荐：

> **先完整闭合 Surface Cache GI，再加 near-field screen layer。**

原因：

- SCGI 已经解决 authoritative world diffuse；
- 先有 world baseline 才能正确定义 screen contribution；
- 避免一开始 double-count。

后续可研究两种实现：

### Horizon Gather

借鉴：

```text
GTAO-like hemisphere slices
depth hierarchy
mip-aware radiance sampling
```

优势：

- 和 XeGTAO 数据准备有潜在共享；
- 连续噪声低；
- 非随机 per-pixel many-rays。

### Screen Probes

借鉴 AMD Brixelizer GI：

```text
visible screen
→ sparse screen probes
→ 8×8 oct incoming radiance
→ temporal reuse
→ SH projection
```

然后：

```text
screen probe
→ near-field residual
and/or
→ feed Surface Cache
```

但最终不做：

```text
SCGI + SSGI 全量相加
```

推荐数学语义：

```text
E_final =
    E_worldCache
  + confidence_screen * HighFrequencyResidual(
        E_screen,
        Prediction(E_worldCache)
    )
```

即 screen 负责修正 cache 低频缺失，而不是重复完整 GI。

这是 V2 研究问题，不阻塞 V1。

---

# 30. Emissive、Sun、Environment、Local Light

完整 SCGI 最终应支持：

```text
environment
physical sun
local lights
emissive
multi-bounce
```

实施顺序可以分阶段，但最后不能用：

```text
“只支持太阳和天空”
```

冒充完整迁移。

### Environment

直接使用当前：

```text
PhysicalSkyIblResources
GpuAuthoredEnvironment
```

的 scene-linear environment source。

### Physical Sun

GI estimator 自己通过 QueryScene 做：

```text
shadow visibility
```

不强依赖当前 VSM。

### Local Lights

最终接：

```text
LightDatabase
```

做 bounded candidate sampling。

第一阶段可先少量遍历验证算法，再替换成当前 `LocalLightWork` / spatial light data 的 world-compatible sampling 结构。

不要为了 GI 单独建第三套 LightManager。

### Emissive

通过 GI material projection sample。

需要支持动态 emissive 变更影响 cache update/convergence。

---

# 31. 动态对象与 Skinned Mesh

Unity 6.7 beta 当前 moving-world / large assembly 仍有稳定性问题。

EEngine 不应该隐藏这个风险。

需要区分：

```text
Rigid dynamic instances
Skinned/deformed geometry
world-origin moving assemblies
```

## Rigid instance

优先：

```text
BLAS reusable
TLAS transform update/refit
cache patches on old world position naturally age/evict
new position receives new patch
```

## Skinned

最终需要：

```text
dynamic query geometry update
or
coarse proxy/query LOD
```

可以后续优化，但最终产品不能默默把 skinned 从 GI scene 删除。

## Large moving assembly

建议未来增加：

```text
GI cache reference frame / world origin transform
```

作为高级能力。

不是 V1 必须，但 Unity 当前暴露出的这个问题值得提前在数据模型里避免把 cache 坐标绝对绑死到不可变世界。

---

# 32. Debug / Profiling 是算法的一部分

建议至少有：

```text
GI/patch occupancy
GI/cascade index
GI/direction bin
GI/patch rank
GI/patch age
GI/update count
GI/cache irradiance
GI/low-res field
GI/final diffuse irradiance
GI/confidence
GI/query LOD
GI/query hit/miss
```

GPU counters：

```text
patch requests
patch allocations
allocation failures
evictions
defrag moves
visible rank0
bounce rank1
bounce request overflow
active patches
rays/queries
closest hits
misses
alpha rejects
VT fallback hits
history seeds accepted/rejected
temporal drift resets
screen lookup misses
```

没有这些 counters，Surface Cache 很难调。

---

# 33. 当前仓库需要怎样大胆重构

建议以 **cutover** 而不是兼容桥梁为原则。

## 保留

```text
FrameProgram / Lowering
GpuRenderWorld
GeometryProduct / VirtualGeometryResidency
GpuNativeMaterialScene
VT
Visibility / Depth / HZB
NativeSurface
XeGTAO
SSSR
Physical Environment
NativeTemporal / FSR3
ResourceAccounting
```

## 重构

### Native Surface

增加：

```text
IndirectDiffusePublication
```

并把：

```text
environment diffuse
```

从固定唯一 provider 改成：

```text
GI-aware diffuse provider:
    SCGI if valid
    environment fallback otherwise
```

但不要建立 generic “LightingProvider Framework”。

只为真实 consumer 增加最小边界。

### Primary temporal identity helper

把 GI 与 Surface 都需要的：

```text
current/previous geometry identity
motion math
```

提取为共享 WGSL helper。

### GeometryProduct cook

增加 query geometry section / GI trace view。

这可能是较大的资产 ABI 变化，允许大胆做。

---

## 替换/退役

```text
long_range_diffuse_provider.ts
screen_space_diffuse_resolve.ts
```

新 GI 正式生产后移除。

旧：

```text
GeometryBlasPool
TopLevelAccelerationStructure
```

如果 RadeonRays-style query backend 接入后没有生产 consumer，则删除，而不是保留两套 BLAS/TLAS。

`GPULightProbeVolume`：

只有当未来明确作为 low-tier/baked fallback 才保留。

否则完成 SCGI 后退役。

---

# 34. 开发阶段

这次不建议一开始就做大量 benchmark-driven micro optimization，但每个大阶段必须能连起来。

## Phase A — 架构 Cutover

目标：

```text
FrameProgram 增加 GI semantic stage/product
SurfaceCacheGIRuntime 生命周期
settings / capacity / accounting
Native Surface GI binding contract
```

不追求画面。

完成条件：

```text
GI disabled = zero owner/resource cost
GI enabled = stable owner lifecycle
graph cache 不因 numerical setting 无意义爆炸
device loss / abort / retry 正确
```

---

## Phase B — Sparse Cache Core

实现：

```text
cascades
direction bins
cell maps
patch pool
ring allocation
scrolling
eviction
defrag
rank/statistics
```

先用 debug fake irradiance 验证 addressing。

完成条件：

```text
camera move 不清全缓存
无 CPU readback control
capacity overflow 可观测且安全
cell↔patch 映射无泄漏
```

---

## Phase C — Screen Demand / History Seeding

实现：

```text
half-res anchors
world pos / flat normal
patch allocation
previous depth/history seed
motion validation
rank 0
```

完成条件：

```text
静态 camera patch 分配迅速稳定
转镜头新区域不是长时间黑
history seed 不跨 disocclusion 污染
```

---

## Phase D — Compute Query Scene

从 RadeonRays donor 移植：

```text
BLAS
TLAS
HLBVH build
compute traversal
closest
visibility
```

接：

```text
GpuRenderWorld
GeometryProduct query section
instances
```

完成条件：

```text
static scene query
dynamic transform
instance id
primitive id
barycentrics
opaque visibility
```

然后补：

```text
alpha test
material lookup
```

---

## Phase E — Irradiance Estimation

实现完整：

```text
environment
sun
punctual
emissive
L1 projection
cosine convolution
bounce cache lookup
bounce allocation
```

完成条件：

```text
single bounce
multi-bounce
emissive bounce
dynamic light
off-screen indirect
```

---

## Phase F — Filtering

实现：

```text
variance-guided temporal
spatial filtering
rank/update scheduling
```

重点对付：

```text
shimmer
pulsing
light change lag
cascade transition
```

---

## Phase G — Screen Field + Native Surface

实现：

```text
half-res L1 compressed field
depth / flat normal
Surface fused edge-aware upsample
shaded-normal SH evaluate
environment fallback
AO de-dup
```

然后删除旧 diffuse GI production code。

这是第一次真正画面闭合。

---

## Phase H — Full Scene Validation

真实场景：

```text
Dungeon
Bistro
large outdoor
indoor rooms
day/night
dynamic sun
dynamic emissive
moving rigid objects
alpha-tested vegetation
VT pressure
```

重点不是 unit test 数量。

而是：

```text
效果正确
生命周期正确
容量正确
性能量级正确
```

---

## Phase I — Screen Radiance Gather V2

完成 world cache 之后再决定：

```text
Horizon GI
or
Screen Probes
```

作为近场高频增强。

不提前阻塞主 SCGI。

---

# 35. 验收场景与画质标准

必须看：

### Cornell-like room

验证：

```text
color bleeding
corner energy
thin wall leaking
multi-bounce
```

### Bistro

验证：

```text
大规模复杂几何
室内/室外过渡
cache cascades
off-screen response
```

### Dungeon

验证：

```text
4GB
VT
VG
SSSR
VSM
AO
GI simultaneously
```

### Moving emissive

验证：

```text
temporal response
cache convergence
ghosting
```

### Door opening

验证：

```text
indoor sunlight update
off-screen cache
history invalidation
```

### Camera teleport / 180°

验证：

```text
scrolling
new patch seed
screen history rejection
black-frame avoidance
```

---

# 36. 性能验收必须记录什么

每帧：

```text
SurfaceCache total ms

query scene:
    BLAS build/refit
    TLAS build/refit
    query scratch bytes

cache:
    scroll ms
    eviction ms
    defrag ms
    allocation ms
    estimate ms
    temporal ms
    spatial ms

screen:
    anchor ms
    lookup ms
    Surface incremental GI ms

memory:
    cell bytes
    patch bytes
    screen history bytes
    query BVH bytes
    query geometry bytes
    scratch bytes
    retired bytes
```

以及：

```text
rays / frame
active patch count
patch update ratio
cache occupancy
allocation failure
VT feedback from GI
```

不能只看：

```text
FPS
```

---

# 37. 已知风险

## Unity upstream 仍然是 6.7 Beta 新系统

截至 2026-10：

- 已有 shimmering / pulsing 报告；
- moving geometry / moving whole assemblies 有稳定性问题；
- 大项目出现 ring buffer exhaustion 的用户报告；
- sample count / temporal smoothing 会明显影响质量和收敛。

因此：

> **我们选择的是“现代架构方向”，不是宣布 Unity 当前实现已经完美。**

EEngine 移植应把这些公开问题当成测试案例，而不是照搬 bug。

## Query scene 内存可能成为最大变量

Surface cache 本体几十 MiB 可以控制。

真正未知大头可能是：

```text
query geometry
BLAS/TLAS
scratch
```

必须从一开始做：

```text
admission budget
resource accounting
query LOD
```

## Native Surface binding pressure

Fused L1 resolve 需要多张 low-res textures。

必须检查：

```text
maxSampledTexturesPerShaderStage
maxBindingsPerBindGroup
storage/buffer limits
```

必要时：

- 独立 GI bind group；
- texture array/atlas；
- fallback standalone upsample。

但不为了省 binding 降低算法质量。

---

# 38. 为什么最终推荐这条路线

从 **效果** 看：

它真正解决：

```text
dynamic diffuse bounce
off-screen indirect
color bleeding
environment/skylight transport
emissive bounce
multi-bounce approximation
dynamic time-of-day
procedural world
```

比传统 SSGI 完整得多。

从 **性能** 看：

昂贵 visibility 是：

```text
per sparse patch
```

而不是：

```text
per full-res pixel
```

world state 跨帧缓存。

screen query 在 quarter pixel count。

从 **内存** 看：

逻辑世界和 physical patch storage 解耦。

可以：

```text
固定 patch budget
```

而不是 world size 线性爆炸。

从 **EEngine 架构匹配** 看：

它和：

```text
Virtual Geometry
Virtual Texture
VSM
```

拥有一致的：

```text
virtual / sparse / demand / budget / residency
```

思想。

从 **未来扩展** 看：

以后即使加入：

```text
better screen gather
hardware visibility backend
ReSTIR
advanced radiance cache
```

也不需要推翻：

```text
IndirectDiffuse semantic
Surface Cache ownership
Native Surface integration
```

因此，它比：

```text
SSGI + Probe Volume + IBL
```

更适合作为 2026 EEngine 的主 dynamic diffuse GI 架构。

---

# 39. 本稿最终架构图

```text
                            EEngine GPU Scene Truth
                                      │
                 ┌────────────────────┴────────────────────┐
                 │                                         │
                 ▼                                         ▼
       GeometryProduct / VG                       Material / VT / Lights
                 │                                         │
                 └────────────────────┬────────────────────┘
                                      │
                         ┌────────────┴────────────┐
                         │                         │
                         ▼                         ▼
                 Raster Visibility          GI Query Scene
                    + Depth                Compute BVH / TLAS
                         │                         │
                         ▼                         │
                Half-res Screen Anchors           │
                         │                         │
                         └────────────┬────────────┘
                                      ▼
                      Cascaded Sparse Surface Cache
                                      │
                  ┌───────────────────┼───────────────────┐
                  ▼                   ▼                   ▼
              Allocation          Estimation           Filtering
           visible / bounce       world query       temporal/spatial
                  │                   │                   │
                  └───────────────────┼───────────────────┘
                                      ▼
                           Directional L1 Irradiance
                                      │
                             Half-res Screen Field
                                      │
                                      ▼
                               Native Surface
                  ┌───────────────────┼───────────────────┐
                  │                   │                   │
                  ▼                   ▼                   ▼
            edge-aware           SH evaluate       env/AO fallback
             upsample          shaded normal          de-dup
                  │                   │                   │
                  └───────────────────┼───────────────────┘
                                      ▼
                       Authoritative Indirect Diffuse
                                      │
                                      ▼
                            Surface HDR Radiance
                                      │
                                      ▼
                      SSSR / Sky / Aerial / Temporal
```

---

# 40. 一句话施工原则

> **完整迁移 Unity Surface Cache GI 的算法机制，不完整复制 Unity 的 Renderer 架构；用 RadeonRays 等允许移植的 donor 补齐 WebGPU world query，用 EEngine 自己的 GeometryProduct、GpuRenderWorld、AppearanceGraph、VT、Visibility、Native Surface 和 Temporal 体系重构宿主接口；世界缓存做稀疏、方向性、级联、跨帧复用，最终 GI 作为 incident diffuse irradiance 在 Native Surface 内只应用一次。**

---

# 41. 参考源码与资料

## EEngine 当前源码

基线：

```text
bigbigbig2/EEngine
master
3000de2ab7caee2f5a20d86ded367ff3ba2e32c5
```

重点：

```text
OEngine/src/render/program/FrameProgram.ts
OEngine/src/render/program/FrameProgramLowering.ts
OEngine/src/render/pipeline/RendererCore.ts
OEngine/src/render/surface/SurfaceV4.ts
OEngine/src/shaders/native_surface.ts

OEngine/src/gpu/GpuRenderWorld.ts
OEngine/src/gpu/VirtualGeometryResidency.ts
OEngine/src/gpu/VirtualTextureResidency.ts
OEngine/src/gpu/GpuNativeMaterialScene.ts

OEngine/src/render/reflections/SssrRuntime.ts
OEngine/src/render/ao/*
OEngine/src/render/temporal/*
OEngine/src/render/passes/fsr3/*

OEngine/src/shaders/long_range_diffuse_provider.ts
OEngine/src/shaders/screen_space_diffuse_resolve.ts
OEngine/src/gpu/GPULightProbeVolume.ts
OEngine/src/gpu/GeometryBlasPool.ts
OEngine/src/gpu/TopLevelAccelerationStructure.ts
```

## Unity 6.7 Surface Cache GI

仓库：

```text
https://github.com/Unity-Technologies/Graphics
```

核心：

```text
Packages/com.unity.render-pipelines.core/Runtime/Lighting/SurfaceCache/
Packages/com.unity.render-pipelines.universal/Runtime/RendererFeatures/SurfaceCacheGIRendererFeature/
Packages/com.unity.render-pipelines.core/Runtime/UnifiedRayTracing/
```

重点文件：

```text
SurfaceCache.cs
SurfaceCacheWorld.cs
PatchUtil.hlsl
PathTracing.hlsl
Estimation.hlsl
TemporalFiltering.hlsl
SpatialFiltering.compute
Scrolling.compute
IrradianceCompression.hlsl

PatchAllocation.compute
ScreenResolveLookup.compute
ScreenResolveUpsampling.compute
SurfaceCacheGIRendererFeature.cs
SurfaceCacheGIVolumeOverride.cs
```

官方资料：

```text
https://discussions.unity.com/t/surface-cache-gi-preview/1720494
https://docs.unity.com/en-us/engine/6000.7/manual/lighting-overview/lighting/surface-cache-gi-volume-override-reference
https://unity.com/ja/topics/the-path-to-a-single-render-pipeline-in-unity-7
```

## RadeonRays

```text
https://github.com/GPUOpen-LibrariesAndSDKs/RadeonRays_SDK
```

用于：

```text
Compute BVH build
HLBVH
TLAS
Traversal
Closest hit / visibility
```

## AMD Brixelizer GI

```text
https://gpuopen.com/fidelityfx-brixelizer/
https://gpuopen.com/manuals/fidelityfx_sdk/techniques/brixelizer-gi/
```

主要用于后续 Screen Radiance Gather / Screen Probe 研究，不作为本次 Surface Cache 基线替代品。

## 其他算法背景

建议继续对照：

```text
Frostbite GIBS
Kajiya Irradiance Cache
NVIDIA SHaRC
Radiance Cache / Surfel GI literature
```

它们主要用于理解 Surface Cache 为什么采用：

```text
sparse surface representation
camera-follow world cache
directional irradiance
temporal amortization
```

而不是要求 EEngine 同时实现四套 GI。

---

## 最终状态

本稿建议从此将 EEngine 后续的：

```text
“World GI”
```

正式收敛为：

```text
EEngine Surface Cache GI
```

其主语义是：

```text
Cascaded Sparse Surface Radiance Cache
+
Directional L1 Irradiance
+
Compute World Visibility
+
Temporal / Spatial Reuse
+
Half-res Screen Resolve
+
Native Surface Integration
```

传统：

```text
SSGI
Probe Volume
Post-surface diffuse delta
```

不再是主生产路线。

在这一版闭合之前，不再并行设计 ReSTIR / Path Tracing / Neural GI 主线。

等 Raster/Hybrid Core 和 Surface Cache GI 真正跑通、真实场景性能数据出来后，再重新开启 Advanced Transport 设计。
