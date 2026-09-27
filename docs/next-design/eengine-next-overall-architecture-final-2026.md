# EEngine Next 整体渲染架构设计（Final Architecture Baseline / WebGPU 2026）

> 状态：整体架构最终基线（后续模块设计必须以本边界为起点，但允许被真实 benchmark 反证后修订）  
> 日期：2026-09-27  
> 目标：极致性能、现代 3A 画质、WebGPU-first、GPU-driven、长期可演进  
> 文档职责：只冻结未来不希望频繁推翻的**整体架构、核心事实层、模块边界、执行原则与性能约束**。VSM、SSSR、GI、VT、Surface Closure、Transparency、Volumetric 等模块内部的数据格式和算法细节，在对应模块进入开发阶段后继续设计。  
> 重要说明：本设计不把当前已有文档当作既定约束。现有源码只作为工程事实与已有资产，用来判断哪些路径已经证明值得保留，哪些结构应尽早重构。

---

## 1. 最终架构判断：EEngine Next 应该成为怎样的 Renderer

EEngine Next 不应该被定义成“WebGPU 版传统 Deferred Renderer”，也不应该被定义成“WebGPU 版 Nanite/Lumen”。WebGPU 到 2026 年已经拥有足够成熟的 compute、storage、indirect、subgroups、primitive index，以及 Immediates、Transient Attachment、Subgroup Size Control、`buffer_view` 等新能力，可以支撑真正 GPU-first 的现代渲染架构；但标准 WebGPU 仍然不能把 Mesh Shader、硬件 Ray Tracing Pipeline、真正通用的 bindless descriptor heap、标准 Multi-Draw Indirect 当作跨浏览器主链前提。因此 EEngine 的上限不应该建立在“等待 WebGPU 变成 D3D12/Vulkan”上，而应该围绕 WebGPU 今天最强、最稳定的能力重新组织工作。

最终建议把 EEngine Next 的长期技术路线定义为：

> **GPU-Resident Scene + Demand-Driven GPU Work + Hybrid Visibility + Decoupled Surface/Lighting + Virtualized Resources + Temporal Reconstruction。**

这里真正需要冻结的不是某一个 Pass，而是几个长期原则。

第一，**CPU 决定能力和拓扑，GPU 决定本帧实际工作量。** CPU 负责场景发布、资源生命周期、capability negotiation、少量 Frame Program 编译、GPU command 编码和 submit；GPU 根据本帧 Visibility、历史、预算和局部复杂度决定实际可见 meshlet、阴影页、Surface work、reflection ray、GI update 等数量。任何需要“GPU 先判断，再回 CPU 决策，再回 GPU 执行”的当前帧闭环，都应视为架构失败或仅允许在低频控制面存在。

第二，**Visibility 是稳定事实层，不是最终渲染模式。** Geometry 的任务是确定“某个 sample 上哪个表面获胜”，并提供可恢复该表面的 token、depth 和必要 coverage 信息。之后 Surface、Lighting、SSR、GI、Temporal 不应被固定 GBuffer，也不应被固定 Compute Shading 实现绑死。这样 Geometry 能长期稳定，Surface/Lighting 可以继续演进。

第三，**Material Evaluation 与 Lighting 在逻辑上解耦，但物理执行允许融合。** 逻辑架构必须能单独描述 Surface Closure、Direct Lighting、Indirect Diffuse、Specular Indirect；物理实现则可以根据消费者和成本把它们融合成一个 kernel，或者按需物化紧凑的 Surface fields。EEngine 不选择“Forward 或 Deferred”的二元答案，而是在 Visibility 之后根据本帧需求决定哪些结果只活在寄存器、哪些结果值得写入可复用中间表示。

第四，**Visibility、Surface appearance、Direct Lighting、Indirect Lighting、Volumetric 的采样频率互相独立。** Coverage 和深度必须保持可靠；材质高频细节、直接镜面、漫反射 GI、SSR、体积效果可以使用不同频率和不同 temporal reconstruction。长期性能上限来自“只在真正需要的 domain 上支付 full-rate 成本”，而不是简单把整个 PBR kernel 从 1×1 改成 2×2。

第五，**共享的是语义事实和控制面，不是所有模块的物理实现。** Virtual Geometry、VT、VSM、GI cache 都会涉及 Logical ID、Demand、Budget、Generation、Priority、Eviction、Telemetry，但它们的 fulfillment model 和 physical storage 不同；Temporal consumer 都需要 Motion、Identity、Local Change，但各自的 HistoryConfidence 不同；GI 和 Reflection 都需要世界信息，但 World Query 与 Radiance Field 不能合成一个万能系统。

第六，**架构必须对 WebGPU capability 演进开放，但不能依赖尚未普及的能力成立。** 新 feature 只能产生有限的 physical specialization，不允许改变核心语义 ABI。今天只有 hardware raster，也能完整运行；未来 `atomic-vec2u-min-max` 普及后增加 software micro-raster，不应该改 Visibility 语义。未来 bindless 出现，也只是 TextureHandle 的新 lowering，不应该重写 Material ABI。

基于这些原则，当前工程中最值得长期保留的是 `GpuRenderWorld / GPU Scene`、Virtual Geometry residency、hierarchical GPU work、bounded work queue、HZB、Packed Visibility、FrameGraph 的基础资源生命周期；最值得趁早重设计的是 Visibility 之后的 Surface/Material execution、texture routing、Lighting ordering、Temporal facts、history binding，以及 RendererCore 对 Frame topology 的手工拼装方式。

整体主架构建议稳定为下面这张图：

```text
                               CPU / Publication Plane

    Asset Cook / Scene Edit
             │
             ▼
    Scene & Asset Publication ───────────────┐
             │                               │
             ▼                               ▼
       GPU Scene Revision             Capability Profile
   Geometry / Material /             Render Intent / Quality
   Texture / Light Tables                    │
             │                               │
             └──────────────┬────────────────┘
                            ▼
                     Frame Program
                semantic demand + topology
                            │
────────────────────────────┼──────────────────────────────────────── GPU / Frame Plane
                            ▼
                         GPU Scene
                            │
              ┌─────────────┼─────────────┐
              │             │             │
       Geometry Work   Shadow System   World Query
              │             │             │
       Raster Backend       │             │
        ┌─────┴─────┐       │             │
        │           │       │             │
    HW Raster   SW Micro    │             │
    baseline    optional    │             │
        └─────┬─────┘       │             │
              ▼             │             │
       Visibility Facts     │             │
              │             │             │
              ▼             │             │
     Surface Work Analysis  │             │
              │             │             │
      ┌───────┼────────┐    │             │
      │       │        │    │             │
    Dense   Binned  Sampling Policy       │
      │       │     Full / Coarse /       │
      │       │     Stochastic / Selective│
      └───────┴────────┘    │             │
              │             │             │
              ▼             │             │
       Surface Evaluation   │             │
              │             │             │
       ┌──────┴─────────┐   │             │
       │                │   │             │
  Fused Work      Requested Surface Fields│
       │                │   │             │
       └────────┬───────┘   │             │
                ▼           ▼             │
          Direct Lighting ← Shadow Visibility
                │
                ▼
          Indirect Diffuse  ←────────── Radiance Field
                │
                ▼
       Pre-Reflection Opaque HDR
                │
       Reflection Source Pyramid
                │
                ▼
          Specular Indirect
        ┌───────┼──────────────┐
        │       │              │
   Screen Hit  World Hit   Environment Fallback
        │       │              │
        └───────┴──────────────┘
                │
                ▼
          Final Opaque HDR
                │
      Transparency / Media
                │
                ▼
        Temporal Reconstruction
                │
                ▼
     Exposure / Tone / Grade / HDR
```

旁边还有三套不属于某一个效果、而是横跨整个 Renderer 的基础设施：

```text
GPU Work Fabric
  bounded reservation / indirect / overflow / telemetry

Virtual Resource Fabric
  streamed residency + GPU-produced residency

Temporal Facts
  motion / stable identity / local change / reactive / disocclusion
```

这张图不是要求一次实现所有框。它的价值是给未来模块定边界：VSM、SSSR、DDGI、VT、透明、植被、体积云以后都必须进入这些边界，而不是继续在 RendererCore 周围新增独立旁路。

---

## 2. Scene、Geometry、Visibility 与空间查询：先稳定“世界事实”，再讨论效果

EEngine 当前最成熟、也最不应该为了新架构而推翻的一层，是 CPU Scene 到 GPU Scene，再到 Virtual Geometry / Hierarchical Work / Visibility 的链路。下一阶段需要做的是把这层从“当前实现”提升成长期 ABI，而不是重新设计一套几何 renderer。

`GPU Scene` 应成为所有实时渲染域的事实源。CPU 侧的 authoring object、Three 风格对象层、编辑器节点都不能在帧内参与 draw scheduling。实例、几何、材质、纹理、灯光都通过稳定 logical handle + generation 发布进 GPU database。Scene mutation 产生 revision 或 patch；frame shader 只看到 GPU-visible immutable/append-compatible revision。当前 `GpuRenderWorld` 已经具备这种方向，应继续强化而不是替换。

Geometry 不需要被统一成一种内部表示。真正值得统一的是“它能产生什么事实”。Static high-poly virtual geometry 继续使用 meshlet hierarchy / SSE / residency；skinned character、foliage、terrain、hair、particle、透明几何未来可以拥有不同 representation backend。只要它们能在对应 composition domain 中输出稳定的 depth/visibility/identity/motion contract，就不要求所有资产都强行转成同一类 meshlet。

对于 Virtual Static Geometry，现有策略继续成立：GPU 根据 view、HZB、screen-space error 与 residency 选择 hierarchy cut，产生 bounded MeshletWork；CPU 只处理延迟的 streaming/upload，不参与当前帧可见性闭环。这里可以继续学习 Nanite 的核心思想——屏幕误差驱动 detail、GPU 选择 hierarchy cut、固定预算 residency——而不是照搬 Native API 的 Mesh Shader、多 draw 或 descriptor heap 假设。

Raster 需要从现在起明确“backend 边界”。Production baseline 仍然是 hardware raster：GPU hierarchy 生成少量大粒度 indirect work，vertex stage 从 storage/virtual geometry 解码，fragment 只写紧凑 Visibility。这个路径最符合标准 WebGPU，且已经被当前 EEngine 实现证明可行。

但 Geometry 不应该把 Visibility bit layout 写死为“只有 fixed-function raster 能产生”。长期允许第二个 backend：software micro-triangle raster。`nanite-webgpu` 已经在浏览器中证明 meshlet hierarchy + compute software raster 是现实路径，其作者当前受限于缺少高效 64-bit atomic，只能把 depth/normal 等压到 32 bit。WebGPU/WGSL 当前规范已经包含 `atomic<vec2<u32>>` 的 min/max 能力，但 Chromium 的公开 rollout 是 Chrome 155 DevTrial、156 ship，因此 2026-09-27 仍不能把它作为产品 baseline。正确策略不是现在重写 Geometry，而是稳定：

```text
GeometryWork → RasterBackend → VisibilityFact
```

未来 capability 成熟以后：

```text
large / regular triangles  → HW raster
micro triangles            → SW raster
```

二者输出相同语义事实，下游不感知来源。

`VisibilityFact` 在整体架构层只固定语义，不提前锁 bit layout：

```text
VisibilityFact
  Depth              // 当前 sample 的 authoritative winning depth
  PrimitiveToken     // 能恢复几何表面的紧凑 frame-local token
  CoverageHint       // 可选，masked/special coverage/composition hint
```

这里必须明确区分 `PrimitiveToken` 和 `Temporal Surface Identity`。前者可以继续使用当前高效的 frame-local work index + local primitive index，因为适合 reconstruction；后者必须来自更稳定的 instance/geometry/material identity 与局部 surface signature。**绝不能把 frame-local work index 直接当成跨帧 identity。**

Temporal identity 也不能要求“所有 LOD 都有完美一一 primitive mapping”。最优情况有 stable mapping；如果没有，仍可以通过 stable instance、reprojected position、depth/normal/material consistency 产生局部置信度。Geometry 的责任是提供足够事实，而不是为了 Temporal 理论完美强加巨大数据成本。

HZB 继续作为 Geometry 和 Screen Query 的核心基础设施。推荐使用 previous-HZB 做 early occlusion，再允许 current-HZB late recheck；但所有当前帧可见性都必须在 GPU 内闭环。延迟几帧回读给 CPU 处理 streaming/budget 是允许的，本帧 GPU→CPU→GPU 不允许进入主路径。

### Shadow 必须从 Lighting Provider 提升为一等系统

VSM 不能只是“Direct Lighting 需要时调用的一个 provider”。Shadow Visibility 同时跨 Geometry、Virtual Resource、GPU Work、Raster、Lighting 与 Temporal Cache，它应该是顶层一等子系统；Lighting 只消费它的结果。

外层合同应该是：

```text
Camera Depth / Receiver Facts
            │
            ▼
      Shadow Page Demand
            │
            ▼
 Virtual Shadow Residency
            │
            ▼
     Caster Work Generation
            │
            ▼
      Shadow Page Rendering
            │
            ▼
      Shadow Visibility
            │
            ▼
       Direct Lighting
```

这条边界现在就需要冻结，因为 WebGPU 下 VSM 最大难点并不是页表本身，而是**same-frame demand → allocation → caster work → page rendering**的物理执行。Virtual Geometry 的缺页可以 GPU 请求后延迟到 CPU/IO，再在未来帧满足；VSM 新页若同样等 CPU，移动视角时阴影会直接滞后。因此 Virtual Resource 的控制面可以共享，但 VSM 必须拥有 GPU-produced residency 路径。

WebGPU 也不能假设 GPU 在需求产生后动态创建任意数量 RenderPass、viewport/scissor 或多视口 draw。未来 VSM 详细设计必须在“固定 FrameGraph topology”内解决动态页工作，例如 atlas-space vertex transform、固定页 batch、GPU-generated caster-page records、必要时 software shadow raster 等。整体架构今天不选择其中哪个，只冻结：**Shadow topology 稳定，页和 caster 数量由 GPU 决定。**

### World Query 与 Radiance Field 是两个长期基础边界

如果目标是 3A 画质，不能让 SSSR、GI、contact shadow、未来 reflection 各自发展一套“世界信息”。但也不能造一个无所不包的 `WorldQueryManager`。更稳的方式是固定两个语义层。

`World Query` 回答的是“世界哪里有东西”：

```text
Query Work
  ray / cone / point / segment
        ↓
World Query Backend
        ↓
Query Result
  hit / miss
  distance
  surface identity
  normal / material proxy
  confidence
```

它的 backend 可以逐步来自 Screen HZB、software BVH、virtual-geometry hierarchy、SDF、voxel/brick proxy；不同 query 可以根据成本和能力选不同 backend。WebGPU 没有标准硬件 RT pipeline，所以“screen-space + software world-space + cached proxy”长期共存是正常状态。

`Radiance Field` 回答的是“那个方向/位置有多少可复用辐射”：

```text
Screen Radiance
Sky / Environment
DDGI Probe
Radiance Brick / Cache
Previous-frame Radiance
```

Reflection 可以先 Screen Query，失败后 World Query，再从 Radiance Field 或 environment 获取辐射；GI 可以使用 world visibility/probe visibility + radiance representation。这样 SSSR、DDGI、未来 world reflection 不会发展成完全割裂的三个世界。

这两个边界只冻结语义和 GPU work contract，不在整体架构阶段决定 BVH、SDF、probe 格式，也不要求所有算法都走同一个 backend。

---

## 3. Surface / Material / Lighting：整体架构最关键的重新设计

本节冻结整体方向；选定的 Standard/Coated 来源、材质/纹理/光照合同、Dense/异常队列与 WebGPU 物理方案见[Module B 独立设计](./surface-material-lighting-v2.md)，逐步单链切换见[Module B 执行文档](../next-execution/surface-material-lighting-v2.md)。两份模块文档在本节框架内展开，不把当前过渡源码当作最终限制。

Visibility 之后是 EEngine 下一阶段最值得重做的地方。当前“全屏 classify → scatter → 最多 64 material/texture-set class → 每 class compute dispatch”的实现解决了第一版 WebGPU material binding 问题，但长期会把逻辑材质、纹理 residency 与 GPU execution class 绑死。新的 Surface 架构必须从根上把这几个维度拆开。

### Surface execution 不是 Dense / Binned / Adaptive 三选一

新的 Surface Work 应被设计成三个正交维度：

```text
                    Visibility Facts
                           │
                           ▼
                 Surface Work Analysis
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
 Work Scheduling      Sampling Policy      Execution Class
       │                   │                   │
 Dense / Binned      Full / Coarse /      Standard PBR
                    Stochastic / Selective Expensive PBR
                                         Hair / Special...
       └───────────────────┼───────────────────┘
                           ▼
                    Surface Evaluation
```

`Dense / Binned` 是工作调度方式；`Full / Coarse / Stochastic` 是采样策略；`Execution Class` 是 closure/成本/资源复杂度。它们不能再被写成三个互斥模式。

Frame Program 不应该说“这一帧选 Binned Surface”。它只应该准备有限的物理 lane，例如：

```text
Dense Fast Lane
Expensive Surface Lane
Special Closure Lane
Coarse Sampling Lane
```

GPU 根据当前 Visibility、材质复杂度、局部连续性和预算把 tile/sample 送进互斥的有界 work queue，再通过 indirect 执行。**简单区域默认不为分类付费，复杂区域才进入 compact lane。** 这是新架构最重要的性能原则之一。

也就是说，不再采用：

```text
full-screen classify
→ everyone scatter
→ everybody waits for bin dispatch
```

而倾向：

```text
cheap + coherent
→ Dense Fast Lane

expensive / divergent / special
→ GPU compact → Binned Lane

stable + reconstructable
→ lower-frequency Sample Lane
```

Queue 数量必须固定且小，不能因为有很多 material 就创建很多 queue。WebGPU 可以用 `dispatchWorkgroupsIndirect` 驱动实际计数，但物理 dispatch slot 应保持有限和可 warmup。

### Material authoring 与 GPU execution class 必须分离

Material 系统的长期形态应从“纹理组合 program”升级为 Surface Closure Compile：

```text
Material Authoring Graph / Standard Material
                 │
                 ▼
        Surface Closure Compile
                 │
                 ▼
 Closure Family + Feature Mask + Params + Texture Handles
                 │
                 ▼
            GPU Publication
```

大多数 glTF/Standard PBR 应落入少数热路径 family，feature mask 只控制 base/normal/ORM/emissive 等可选采样，不让每种纹理组合都变成新 PSO。只有会显著改变 BSDF/closure 结构、register pressure 或 composition domain 的能力才升级 execution class，例如 Standard PBR、Coated/Anisotropic、Subsurface/Skin、Hair、Generic Fallback。

UE5 Substrate 值得学习的是“authoring 表达 → closure → 根据复杂度和平台预算选择 lighting execution”，而不是复制它的 Slab/GBuffer 存储。EEngine 的目标是把 closure complexity 映射到有限 GPU lanes，并允许未来按平台预算简化 closure。

还必须把三个容易混淆的轴彻底分开：

```text
Geometry Representation
  Triangle / Strand / Particle / Volume / ...

Coverage / Composition Domain
  Opaque / Masked / Transparent / Refractive / Stochastic / ...

Surface Closure
  Unlit / Standard PBR / Coat / Subsurface / Transmission / Hair BSDF / ...
```

Hair 不是简单“一个 Surface family”；它可能是 Strand representation + Hair coverage/composition + Hair closure。Transmission 也不是简单跟 Opaque PBR 并列，它会改变 composition path。这样未来透明、毛发、植被不会再次把材质系统和 raster path 搅在一起。

### Fuse 与 Materialize 必须允许同帧并存，并且按字段决定

上一版架构最需要修正的地方，是把 Fused Path 与 Materialized Surface 画成两个替代路径。真正合理的是：**一个 Surface Evaluation kernel 可以一边计算并融合某些 lighting，一边顺手物化被消费者要求的少量字段。**

因此逻辑上不再定义“Surface Cache on/off”，而定义 `Surface Field Demand`：

```text
GTAO
  needs Normal

SSSR
  needs Normal + Roughness + ReflectionSource

Temporal Upscaler
  needs Motion + Reactive

GI
  may need WorldPosition proxy / Normal / Diffuse response
```

然后 Frame Program 做 demand closure，Surface Compiler 决定：

```text
register-only values
fused lighting values
materialized sidecar fields
```

例如：

```text
Surface Evaluate
     │
     ├─ BSDF/closure in registers
     ├─ Direct Lighting fused → Base Radiance
     ├─ Normal → compact sidecar
     └─ Roughness → compact sidecar
```

这里要防止另一个极端：逻辑 field demand 很细，并不意味着每个 field 都是一张 texture。必须存在一层：

```text
Semantic Field Demand
          ↓
Finite Physical Layout Selection
```

例如 `Normal + Roughness` 可以选择一个紧凑 layout；`Normal + Roughness + F0 + DiffuseColor` 可能选择另一个更完整 layout。物理 layout 数量必须少且可 benchmark，避免 feature 组合导致 PSO/layout 组合爆炸。

所以新的 Surface Working Set 更准确的定义是：

> **Demand-Materialized Surface Fields**：只物化当前消费者真正复用的语义字段，并映射到有限物理 layout；其余结果可以在寄存器内直接参与 fused execution。

这既不是传统 GBuffer，也不是“永远从 Visibility 重算所有材质”。

### Texture Architecture：Logical Handle 稳定，物理采样方式可演进

当前 9 类 `texture_2d_array` bank + `TextureRef` 的稳定 logical handle 思想值得保留，但“binding set”不能继续成为 material execution class 的长期组成部分。

新的合同应是：

```text
Material
   │
Logical TextureHandle
   │
Texture Resource Table
   │
Physical Sampling Class
   ├─ Resident Array Pool
   ├─ Atlas / Packed Pool
   ├─ Virtual Texture
   └─ Future Bindless Lowering
```

2026 高 limit 设备可以提供 `Wide Texture Profile`，一次绑定更多 resident arrays，降低 dispatch/bind group 切换；但它只能是实测候选，不是终局。Chrome 146 的新 limit tier 可以到每 shader stage 48 sampled textures、16 storage buffers，这使 Wide Profile 值得实验，但绑定几十张 texture 也可能带来更大 shader、更多分支、更高 register pressure 和更差 locality。因此最终目标不是“把 bank 数乘四”，而是稳定 logical handle，控制 physical sampling classes 数量。

长期 VT 也应只是 TextureHandle 的新 physical lowering：material 不知道自己采的是 resident layer 还是 virtual page。未来 WebGPU 真正出现 bindless descriptor，只增加新的 lowering，同样不改变 Material ABI。

### Lighting 必须明确顺序与能量归属

为了真正做到 3A 画质，Lighting 不能再只是“Direct + Environment + GI + Reflection 全部加起来”。必须从整体架构层规定能量归属，避免 SSR 与 IBL 双重计光、AO 错压 direct、GI 与 environment diffuse 重复。

建议冻结下面的逻辑顺序：

```text
Surface Closure
      │
      ├──────── Emissive
      │
      ▼
Direct Diffuse / Specular
 + Shadow Visibility
      │
      ▼
Indirect Diffuse
  ├─ Sky / Environment diffuse
  ├─ World GI / Radiance Cache
  └─ AO / Bent-normal visibility modulation
      │
      ▼
Pre-Reflection Opaque HDR
      │
      ├─ Build Reflection Source Pyramid
      │
      ▼
Specular Indirect Integrator
  ├─ Screen hit
  ├─ World hit
  └─ Environment fallback
      │
      ▼
Final Opaque HDR
```

`Screen Reflection / World Reflection / Environment Specular` 不是三个 additive effect，而是同一个 specular indirect integral 的不同信息源。一般语义应类似：screen hit 高置信度时使用 screen radiance；screen miss 或低置信度时走 World Query；world miss 再 fallback environment，并结合 roughness、BRDF、temporal confidence 进行 blend。

AO 主要调制低频 indirect diffuse visibility，可进一步提供 bent normal/specular occlusion；它不应该简单 `finalColor *= AO`，也不应该替代 Shadow Visibility 对 direct light 的职责。

`Pre-Reflection Opaque HDR` 与其 pyramid 是一个重要产品，因为 SSSR 通常需要已经照亮的 opaque color。它与 `Final Opaque HDR` 要区分开，否则 reflection source 容易出现 feedback/self-reflection 逻辑混乱。

### Transparency 与 Media 不进入 Opaque Visibility 强行统一

Opaque/Masked 是 Visibility-first 主链的核心。Transparency、Refraction、Hair composition、Volumetric 不应该为了“统一”强塞进同一 Visibility Buffer。它们可以拥有独立 raster/resolve/composition path，但必须共享 GPU Scene、Lighting facts、Physical Environment、Temporal Facts 与 Presentation，并为 temporal reconstruction 提供 reactive/transparency/local-change 事实。

这可以避免两种坏结果：一是把 opaque 主链为了透明变复杂；二是透明形成完全独立、重复 lighting/temporal 的第二套 Renderer。

---

## 4. Frame Program、GPU Work 与 FrameGraph：逻辑架构和物理执行必须彻底分开

当前 RendererCore 手工按固定顺序拼 Visibility、ShadingWork、SurfaceMaterial、Sky、FSR3、Present，是当前架构继续扩功能最大的风险。VSM、GTAO、SSSR、GI、Transparency 一旦继续塞进去，很快就会重新变成巨型 MainRenderPipeline。

但解决办法不是再造一个“万能 Planner”。新的 `Frame Program` 必须非常有限，只负责低频、静态或半静态决策：

- 当前 capability 允许哪些 backend；
- 当前 Render Intent 开启哪些功能；
- 哪些语义产品被消费者需要；
- Surface 哪些 fields 需要 materialize；
- 哪些 physical layout / execution lane 需要存在；
- 各 domain 的 resolution/frequency profile；
- 哪些 persistent history 需要挂接。

它不应该每帧计算“有多少 tile 走 Dense”“有多少 shadow page dirty”“多少 SSR ray 命中”。这些是 GPU 的工作。

概念上可以把它理解为：

```text
Scene Support + Capabilities + Render Intent
                  │
                  ▼
              Frame Program
                  │
   ┌──────────────┼────────────────┐
   │              │                │
Product Demand  Execution Lanes  Resolution Domains
   │              │                │
   └──────────────┼────────────────┘
                  ▼
          FrameGraph Topology
                  │
                  ▼
          GPU Dynamic Work
```

Frame Program 的 compile trigger 应尽可能少：feature topology 变化、resolution topology 变化、capability profile 变化、material architecture/profile 变化、输出模式变化。正常 camera move、scene object move、shadow page demand、history ping-pong 都不应该导致 topology 重新编译。

这也意味着必须严格区分 `Topology Identity` 与 `Physical Resource Identity`。FSR history A/B、SSR history A/B、VSM atlas generation、environment LUT revision、GI cache generation 都应该通过 persistent handle / late binding 进入已编译 topology，而不是进入 graph key 造成组合爆炸。

FrameGraph 只做它擅长的事情：semantic dependency、pass culling、resource lifetime、physical transient reuse/alias、render/compute encoding、persistent handle binding、单 submit。WebGPU 没有暴露完整 Vulkan 式 barrier/queue/subpass 控制，所以不要做过度复杂的 barrier optimizer 或 async queue scheduler。应该把精力放在 WebGPU 真正可控的性能点：资源生命周期、transient attachment、pass merge 机会、pipeline warmup、bind group reuse、避免 frame-hot-path pipeline/bind-group construction。

### GPU Work Fabric 不是一个万能 Queue，而是一组共享协议

Geometry Work、Shadow Page Work、Caster Work、Surface Work、Reflection Ray Work、GI Update Work 数据结构不同，不应强行共用一个 record。但它们可以共享：

```text
bounded reservation
attempted / written / overflow counters
fallback policy
indirect arguments
subgroup-local aggregation
budget / priority
telemetry
```

当前 `GpuWorkGenerationAbi` 已经是很好的起点。下一代应继续推广这种模式：**GPU 产生有限工作，工作永远有上界，溢出有可观测 fallback。** 这样性能不会因为场景极端输入突然失控，也利于动态预算系统。

Surface 的有界 lanes、VSM 的 page/caster queue、SSSR ray queue、GI probe update queue 都应该服从同一哲学，但保留自己的语义 record。

### Pipeline / Bind Group 生命周期必须前移

任何 `createComputePipeline()`、`createRenderPipeline()`、大量 `createBindGroup()` 都不应该发生在稳定帧内 hot path。Material publication、Scene publication 或 Frame Program compile 阶段应尽量完成：

```text
resolve closure
→ resolve execution classes
→ create shader modules
→ createPipelineAsync / warmup
→ create persistent layouts/bind groups
→ publish runtime revision
```

帧内只允许真正变化的 transient output/history handle、indirect args 和少量 Immediates。当前 Surface 每 active class 每帧创建 bind group，应作为明确迁移目标。

---

## 5. Virtual Resource：共享控制面，但必须区分两种完全不同的 fulfillment model

“虚拟资源”是 EEngine 可以从现有 Virtual Geometry 继续放大的一个核心资产，但不能过度抽象成“一套 page allocator 解决所有事情”。

真正值得共享的是：

```text
Logical Handle / Product ID
Generation / Revision
Demand Record
Priority / Importance
Budget
Residency State
Retirement Safety
Eviction / Hysteresis
Telemetry
```

但 fulfillment 至少分成两类。

**A. Streamed Residency**：Virtual Geometry、Virtual Texture。GPU 产生 demand，CPU/IO/worker 延迟读取、解压、上传，未来帧 resident。当前帧必须有 fallback LOD/page/mip，不能等 CPU。

```text
GPU Demand
   ↓ delayed feedback
CPU / IO / Decompress
   ↓
Future-frame Residency
```

**B. GPU-Produced Residency**：VSM、部分 GI cache/radiance brick。GPU 产生 demand 后，当前帧或非常近的 GPU 阶段内完成 page/slot allocation、work generation 和内容生产。

```text
GPU Demand
   ↓
GPU Allocation / Page Table Update
   ↓
GPU Content Generation
   ↓
Same-frame / Near-frame Consumption
```

这两类可以共用 budget、generation、telemetry、retirement 思想，但不能共用“延迟 CPU 流送”假设。VSM 是这一区分最重要的验证模块。

物理 data plane 继续独立：

```text
VG   → compressed geometry page heap
VT   → texture page / physical atlas
VSM  → shadow depth atlas
GI   → probe / radiance brick atlas
```

因此所谓 `Virtual Resource Fabric` 更像统一控制协议和预算模型，而不是一个巨大继承层或 manager。

---

## 6. Temporal 与 Presentation：共享事实，不共享统一 HistoryConfidence

现代 3A Renderer 的高性能很大程度来自“低采样率 + 时空重建”，因此 Temporal 不能只是 FSR3 Pass 的辅助数据。它必须成为 Renderer 一级合同。

所有 temporal consumer 共享的是**事实**：

```text
Temporal Facts
  Motion
  Stable Instance Identity
  Surface Signature / Identity
  Depth
  Local Change Flags
  Reactive
  Transparency
  Disocclusion Evidence
```

其中 `Local Change Flags` 应能表达局部语义变化，例如：

```text
GeometryChanged
LODChanged
DeformationChanged
MaterialChanged
TextureResidencyChanged
ShadingRateChanged
CompositionChanged
```

但绝不能存在“某个全局 RepresentationRevision 一变，整屏 history 清空”的粗暴策略。纹理页换入、局部 LOD 切换、局部材质更新都应该尽可能变成屏幕局部/instance 局部 facts。

更重要的是：**HistoryConfidence 不是共享事实，而是 consumer decision。**

FSR、SSR、GI、AO 对同一种变化的容忍度不同。轻微 roughness 变化对 upscale 可能只需要降低一点权重，对 reflection history 可能是重大变化；LOD 切换对低频 GI cache 可能可以继续复用，对高频 specular 可能需要快速衰减。因此架构应该是：

```text
Shared Temporal Facts
        │
        ├── FSR/TAA confidence logic
        ├── SSR confidence logic
        ├── GI confidence logic
        └── AO/Volumetric confidence logic
```

而不是 Renderer 算一个统一 `HistoryConfidence` 再让所有人消费。

Motion 的 owner 也必须明确为跨 Geometry/Surface/Temporal 的事实，而不是“Surface shader 顺便写一张 motion texture”。Rigid transform 可以通过 current/previous transform + reconstructed local position 得到；skinned/deformed representation 需要提供 previous mapping；sky/background 有独立规则。Motion 必须与 dynamic resolution / jitter convention 有明确坐标合同，并且一旦某 representation 无法给出可靠 motion，就通过 local confidence/reactive 标注，而不是伪造零 motion。

FSR3 只是 Temporal Reconstruction backend。未来可以存在 TAA、自研 upscaler 或其它 temporal backend，但它们不能重新定义 Motion/Reactive/Disocclusion 语义。当前工程里 production Surface 尚未真正发布 motion dependency，reactive/transparency mask 仍走默认，这恰好说明新 Temporal Contract 应优先闭环。

### Presentation 是物理渲染主链，不是最后补几个 postprocess

内部 radiometry 应坚持 scene-linear HDR，并明确 pre-exposure 与 display-referred 阶段：

```text
Scene-referred Radiance
        ↓
    Pre-Exposure
        ↓
Opaque + Transparency + Media
        ↓
Temporal Reconstruction / Upscale
        ↓
Bloom / Lens-domain Effects
        ↓
Automatic Exposure
        ↓
Tone Mapping
        ↓
Color Grading
        ↓
Display Transform
   ├─ SDR
   └─ HDR Output
```

这里不在整体架构层决定 ACES、AgX 或自研 tone mapper，也不提前锁 Working RGB gamut；只冻结：Lighting 输出 scene-referred HDR，Temporal 与后处理在统一 pre-exposure contract 中工作，最终 display transform 与场景辐射严格分离。

HDR 输出不应被架构锁死为 `rgba8unorm`。WebGPU/Canvas 对 HDR 与 extended tone mapping 的能力可以作为 capability specialization，但 SDR 仍是 baseline display profile。

---

## 7. WebGPU 2026 Capability Policy：语义 ABI 单一，物理 specialization 有限

EEngine 的目标不是最低公分母兼容 renderer，而是高端 WebGPU renderer；但“使用最新 feature”本身不是目标。所有 capability 必须服从一个规则：

> **新能力可以改变数据布局、dispatch、binding 和 kernel fast path，但不能改变模块之间的语义合同。**

建议把当前能力分成生产 baseline、增强 fast path 和未来实验路径。

### Production Baseline

主架构围绕标准 Compute、Storage Buffer/Texture、Texture Arrays、Indirect Draw/Dispatch、Primitive Index、Subgroups、常规 HW Raster 建立。缺少 subgroups/primitive-index 的设备可以有 portable fallback，但不作为“极致性能 + 3A”目标档。

### 2026 Enhanced Fast Paths

- `subgroups`：meshlet/work compaction、tile classification、scan/reduction、page/ray queue reservation；
- `subgroup-size-control`：只在 benchmark 证明 32/64 lane 固定大小能显著提升某 hot kernel 时启用；
- `primitive-index`：HW visibility 直接生成 primitive identity，减少额外编码；
- `shader-f16`：适合 normal/roughness/部分 work/intermediate 在质量误差可接受时降 bandwidth/register；
- Immediates：frame/pass/class/offset 等小量高频常量，替代 transient uniform + bind group churn；
- `TRANSIENT_ATTACHMENT`：仅 pass 内使用的 render attachment/MSAA transient，在 tile GPU 上减少 VRAM traffic/allocation；
- texture format tiers：允许更紧凑/read-write storage intermediate；
- `buffer_view`：适合作为 Enhanced path 的 GPU arena 分区工具，减少大量逻辑 buffer binding，但不应成为核心 ABI 唯一表达；
- higher binding limit tiers：支持 Wide Texture Profile，但必须与 shader size/register/locality 一起 benchmark。

### Future / Experimental Paths

`atomic-vec2u-min-max` 已进入当前 WebGPU/WGSL 规范，用 `atomic<vec2<u32>>` 表达有限 64-bit min/max，正好适合 software visibility/depth+payload competition；但截至 2026-09-27，Chromium 公布的 rollout 是 Chrome 155 DevTrial、156 ship，因此仍属于未来 fast path，而不是当前 baseline。

Experimental MultiDrawIndirect、未来 bindless、未来 mesh/RT 能力都只能放实验 backend。任何实验 capability 若被移除，主 Renderer 仍必须成立。

WebGPU FrameGraph 也要服从 API 现实：不模仿 Vulkan 做应用层无法真正控制的多 queue/barrier 微调。优化重点应是 transient memory、resource reuse、pass topology cache、pipeline warmup、bind group reuse、减少 CPU encode/binding overhead。

---

## 8. 性能与质量策略：极致性能不能靠单点技巧，而要靠“工作预算 + 可重建性”

EEngine 的性能目标不能只定义成“GPU-driven”。真正需要的是每种昂贵 work 都可以量化、限额、降级并观测。

建议所有高级 domain 都有独立 budget：

```text
Geometry Detail Budget
Surface Expensive-Closure Budget
Coarse Shading Budget
VSM Dirty-Page / Caster Budget
Reflection Ray Budget
GI Update Budget
Volumetric Step Budget
Temporal History Budget / Quality
```

预算变化读取延迟 telemetry 和 P50/P95 趋势，不能在当前帧制造 GPU→CPU→GPU 同步。正式 benchmark 反而必须关掉自适应，固定 camera、分辨率、capability、feature profile 和热状态，避免“架构更快”其实只是系统偷偷降质量。

Surface Work Builder 的成功标准不应该是“分类率越高越好”，而是：分类/queue/scatter 的成本小于节省的昂贵 shading；简单 dense 区域不因为架构统一而多付代价。新的 Surface v2 必须同时测：

```text
classification cost
queue reservation cost
indirect dispatch cost
material evaluation cost
surface sidecar bandwidth
reconstruction/temporal cost
register pressure / occupancy
```

Fuse/Materialize 也不能靠理念判断。第一阶段要用真实 topology A/B 对比：

```text
A: Visibility → Fused Surface + Direct Lighting → Radiance
B: Visibility → Surface Fields → Lighting → Radiance
```

然后增加 GTAO/SSSR 这样的真实 consumer，找出“重复材质求值”与“Surface write/read bandwidth”之间的分界。最终 Frame Program 的策略可以先由固定 rule 驱动，积累 telemetry 后再升级成 profile-driven decision；不要第一版就造复杂自动 cost model。

3A 画质同样必须被系统性约束。所有低频/temporal 技术都必须在 identity/disocclusion/change facts 下工作，不允许为了省性能简单 blur 或跨边界复用。所有 indirect/reflection source 必须有能量归属，避免 double counting。所有 quality downgrade 必须是可解释的 domain budget，而不是在 shader 内散落 magic threshold。

---

## 9. 从当前工程迁移：不重写 Geometry，先把后半段边界改对

> 执行口径（2026-09-27）：下文提到的 A/B benchmark 仅指**同一新架构内的物理 topology/算法比较**，不要求维护旧/新两条可运行生产 Renderer。旧路径在新消费者接通时直接切断；模块完成后才做轻量代码检查，系统画质和正式性能比较留到整体集成。具体顺序见[架构层执行计划](../next-execution/eengine-next-architecture-layer-plan-2026.md)。

这次架构重定不应该表现为创建一个全新的 EEngine-v3。正确方式是保持当前 Geometry/Visibility 作为稳定生产输入，在它后面逐步替换 Frame/Surface/Temporal；同一新架构内的物理方案在真实消费者连通后比较，正式性能 benchmark 留待最终集成。

第一阶段只建立最顶层 ABI：`Frame Program`、`Visibility Fact`、`Temporal Facts`、`Surface Field Demand`。RendererCore 可以暂时继续调用当前 Pass，但 topology 不再由固定手写顺序定义，而是由一个很薄的 Frame Program Builder 产生。这个阶段不扩新效果，目标是把职责边界切开。

第二阶段实现 Surface v2，只支持当前 Standard PBR。先证明几个关键点：简单区域可以走 Dense Fast Lane；昂贵/分化区域可以 GPU compact 到有限 Binned Lane；material execution class 不再绑定 material ID/texture binding set；pipeline/bind-group warmup 前移；Frame hot path 不再按 active material class 动态创建大量对象。

第三阶段实现 `Fuse + Demand-Materialized Surface Fields`。先做两种 topology A/B，再接一个简单真实 consumer（优先 GTAO），验证按字段 materialize 是否能减少重复 reconstruction/texture fetch，同时控制 bandwidth。这个阶段还不需要 SSSR/GI 全部上线。

第四阶段补齐 Temporal/Radiometry/Presentation：authoritative motion、local change、reactive/transparency、pre-exposure、auto exposure、tone mapping、color grade、SDR/HDR profile。FSR3 作为一个 backend 重新接入新的 facts，而不是继续拥有自己独立的数据定义。

第五阶段用 VSM 验证整个架构是否真正成立。VSM 是第一项同时跨 GPU Scene、Virtual Resource、Geometry Work、GPU-produced residency、Lighting 的大模块。如果 VSM 接入仍然需要 RendererCore 新增大量专用 if、资源旁路和 current-frame CPU 调度，说明整体边界还没设计正确。

之后 SSSR/GI/VT/Transparency 都遵守同一规则：先声明消费/生产哪些语义事实，再设计内部算法。不能因为 donor code 使用传统 GBuffer 就把 EEngine 改回固定 GBuffer；不能因为某个 GI donor 使用硬件 RT 就把 WebGPU 主链围绕 RT 假设重构。

### 这份整体架构现在冻结的决策

下面这些是最终建议作为整体设计基线的内容；如果未来要推翻其中一条，必须有真实 GPU benchmark、质量证据或 WebGPU capability 变化，而不是因为局部实现不方便。

1. GPU Scene revision / stable logical handle 是所有渲染域的事实源，帧内不回 CPU Scene 做 draw scheduling。
2. CPU 负责 capability、publication、Frame Program 和 command submit；GPU 决定本帧动态 workload。
3. Geometry 允许多 representation、多 raster backend；长期统一点是 Visibility Facts + Temporal Facts，不是同一种 meshlet。
4. HW visibility 是当前 production baseline；software micro-raster 是 capability specialization，不改变 Visibility ABI。
5. Shadow Visibility 是跨 Geometry/Virtual Resource/Lighting 的一等系统，不是 Lighting 内部普通 provider。
6. World Query 与 Radiance Field 是独立长期语义层；screen-space、software world-space、cache backend 可以组合。
7. Surface execution 拆成 Work Scheduling、Sampling Policy、Execution Class 三个正交维度；Dense/Binned/Adaptive 不再是整帧三选一。
8. 简单/coherent Surface 默认走 Dense Fast Lane，只有昂贵/divergent work 才支付分类和 compact 成本。
9. Material Evaluation 与 Lighting 逻辑解耦、物理可融合；不强制固定 GBuffer，也不强制永远重复 compute reconstruction。
10. Surface 中间结果按 Semantic Field Demand 物化，并映射到少量 finite physical layouts；Fuse 与 Materialize 同帧可以共存。
11. Coverage/Composition、Geometry Representation、Surface Closure 是三个独立轴，避免 Hair/Transmission/Transparency 再次混成 material class。
12. Material 分类以 Closure/Execution Cost/Resource Demand 为中心，不让 material ID 或 texture binding set 成为长期 shader class。
13. Texture 使用稳定 logical handle；resident array、wide profile、VT、future bindless 都只是 physical sampling lowering。
14. Lighting 顺序和能量归属固定：Direct → Indirect Diffuse → Pre-Reflection HDR → Specular Indirect → Final Opaque；SSR/World/Environment 是 specular indirect 的不同来源，不简单相加。
15. Virtual Resource 共享控制面，但至少区分 Streamed Residency 与 GPU-Produced Residency；VG 的 CPU 延迟流送不能直接推广到 VSM。
16. Temporal 共享 Motion/Identity/Local Change/Reactive/Disocclusion 等事实；HistoryConfidence 由每个 consumer 自己计算，不做全局粗暴 invalidation。
17. Frame Program 决定 topology、semantic demand、available lanes 和 fuse/materialize；GPU Work 决定本帧实际数量；FrameGraph 只负责依赖、资源生命周期和编码。
18. Persistent history/atlas generation 与 FrameGraph topology 分离，通过 handle late-bind，避免 graph-key 组合爆炸。
19. 新 WebGPU 能力只产生有限 physical specialization，不允许 experimental capability 成为核心语义 ABI 的前提。
20. 所有高级效果必须拥有独立 GPU budget、fallback 和 telemetry；正式 benchmark 与动态质量模式严格分离。

这 20 条如果保持稳定，后续 VSM、SSSR、GI、VT、植被、透明、体积、毛发即使内部实现多次变化，也不应该再要求推翻 Renderer 主架构。

---

## 参考体系与下一层设计边界

本设计不是复制单一引擎，而是组合不同系统里与 WebGPU/EEngine 匹配的思想：Nanite / nanite-webgpu / Bevy Virtual Geometry 用来研究 GPU hierarchy、meshlet work、hybrid raster 与 virtualized geometry；Microsoft Visibility Buffer 与早期 Decoupled Sampling/Lazy Shading 用来研究 Visibility 和 Shading sample 解耦；UE5 Substrate 用来研究 material closure 与复杂度驱动 execution；UE5 Virtual Shadow Maps 用来研究 receiver-driven demand、page cache 与 invalidation；AMD FidelityFX SSSR/XeGTAO 适合作为 screen-space reflection/AO 的算法 donor；RTXGI/DDGI、RTXGI v2 的 radiance cache 思路以及 Activision GI 适合研究 world-space radiance representation；Granite 适合学习 RenderGraph 的 lifetime、transient、history、alias 思想；WebGPU/WGSL 规范与 Chrome WebGPU 更新则决定哪些能力是 baseline、哪些只能做 specialization。

当前设计深度到此只冻结**整体 Renderer 架构**。下一层最应该单独深入的是 `Surface / Material / Lighting v2`，因为它决定 Work Lanes、Closure Compile、Field Demand、Fuse/Materialize、Texture Sampling Class 和 Lighting energy contract 如何真正落地。VSM 内部 page table、caster work、atlas raster、cache invalidation；SSSR 的 ray format、denoise；GI 的 probe/brick/cache；VT page layout；Surface physical packing；最终 tone mapper等，都不应在本文件提前拍板。

按照当前文档规则，整体架构只需要：

```text
docs/next-design/eengine-next-overall-architecture-final-2026.md
docs/next-execution/eengine-next-architecture-layer-plan-2026.md
```

开始 Surface v2 和 VSM 时分别增加对应的 `next-design/` 与 `next-execution/` 模块文档。模块内部不再继续拆很多 Markdown，而是在一份设计文档中逐层深入。

### 主要参考资料

- W3C WebGPU Specification — https://www.w3.org/TR/webgpu/
- W3C WGSL Specification — https://www.w3.org/TR/WGSL/
- Chrome WebGPU 146（Transient Attachment / higher binding limit tiers）— https://developer.chrome.com/blog/new-in-webgpu-146
- Chrome WebGPU 149-150（Immediates）— https://developer.chrome.com/blog/new-in-webgpu-149-150
- Chrome WebGPU 151-152（Subgroup Size Control）— https://developer.chrome.com/blog/new-in-webgpu-151-152
- Chrome WebGPU 153-154（WGSL `buffer_view`）— https://developer.chrome.com/blog/new-in-webgpu-153-154
- WebGPU atomic vec2u min/max proposal / spec feature — https://github.com/gpuweb/gpuweb/blob/main/proposals/atomic-64-min-max.md
- Chromium Intent to Ship: atomic-vec2u-min-max — https://www.mail-archive.com/blink-dev%40chromium.org/msg17518.html
- Nanite SIGGRAPH 2021 — https://advances.realtimerendering.com/s2021/Karis_Nanite_SIGGRAPH_Advances_2021_final.pdf
- nanite-webgpu — https://github.com/Scthe/nanite-webgpu
- Microsoft Visibility Buffer Sample — https://learn.microsoft.com/en-us/samples/microsoft/xbox-gdk-samples/visibilitybuffer/
- Decoupled Sampling for Graphics Pipelines — https://dspace.mit.edu/entities/publication/e5786a69-8c3a-4d92-8cdc-ed668f88330d
- UE5.8 Virtual Shadow Maps — https://dev.epicgames.com/documentation/unreal-engine/virtual-shadow-maps-in-unreal-engine
- UE5.8 Substrate Materials — https://dev.epicgames.com/documentation/unreal-engine/overview-of-substrate-materials-in-unreal-engine
- FidelityFX SSSR — https://github.com/GPUOpen-Effects/FidelityFX-SSSR
- XeGTAO — https://github.com/GameTechDev/XeGTAO
- RTXGI DDGI — https://github.com/NVIDIAGameWorks/RTXGI-DDGI
- RTXGI v2 / Radiance Cache research code — https://github.com/NVIDIA-RTX/RTXGI
- Granite — https://github.com/Themaister/Granite
- The Forge — https://github.com/ConfettiFX/The-Forge （Visibility Buffer/资源组织参考；原生 API 的 draw 与绑定模式需重映射到 WebGPU）
- Filament — https://github.com/google/filament （材质与物理光照数学参考；不直接套用其 Renderer topology）
