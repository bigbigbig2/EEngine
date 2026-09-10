# OEngine Performance Architecture V2

> 状态：Design Draft
>
> 作用：完整合并三份性能重构分析，统一下一代性能架构的目标、边界、算法候选、数据流、跨系统合同、长期扩展和实施依赖。
>
> 非作用：本文不是 ADR，不代表设计已经被接受，也不授权直接删除当前生产路径。
>
> 输入分析：[`性能优化重构1.md`](./性能优化重构1.md)、[`性能优化重构v2.md`](./性能优化重构v2.md)、[`性能优化重构3.md`](./性能优化重构3.md)。本文不以精简这些输入为目标；所有重要提案都必须被吸收、展开，或在保留完整设计后明确标注为证据触发/长期阶段。

本文篇幅较长，阅读结构如下：

- 第 1–23 节：架构目标、全局合同、目标数据流、第一版实施阶段和验证；
- 第 24–31 节：WebGPU capability、Asset/OAsset/OPack、Geometry/Texture/Streaming、Queue 和 Meshlet Frontend 深化设计；
- 第 32–42 节：Compute Material、SurfaceLite、AO、SSR、Temporal、Transparency、Shadow、GI、Volumetric、VRS、Post 和 Budget 深化设计；
- 第 43–46 节：端到端推演、完整优先级、三份来源映射和外部实现/规格研究清单。

## 1. 文档目的

OEngine 当前已经完成 GPU-ready Runtime Asset、`GpuAssetStore`、`GpuScene`、`GpuRenderWorld`、Hardware-first Visibility、VisibilityKey、Surface、统一 `MainRenderPipeline` 和单次主提交的架构收敛。

Performance Architecture V2 不重新建设这些所有权边界，而是在保留其核心不变量的基础上，重新设计以下性能关键路径：

1. Asset Cook、纹理格式和 Runtime Residency；
2. Geometry Work Generation、Raster Work 粒度和 VisibilityKey；
3. Material Classification、Surface 数据流和 Lighting；
4. AO、SSR、Temporal、Transparency 和 Post 的共享资源；
5. GPU 时间、内存、队列容量和质量预算控制。

本文把三份性能分析完整合并为一个目标架构，但不会把“完整收录”误写成“已经接受”。文档中的能力使用四种成熟度标记：

| 标记 | 含义 |
|---|---|
| **V2 Core** | 下一代架构闭环需要具备的核心能力 |
| **V2 Candidate** | 已进入完整设计，必须通过同条件 benchmark 才能替换当前实现 |
| **Evidence-triggered** | 设计上保留位置和接口，只有出现产品阻塞与证据后实施 |
| **Long-term Extension** | 属于完整性能架构的后续能力，需要新的产品范围或 ADR |

因此，Streaming、VSM、Sparse GI、Volumetric Fog、Software VRS 等不会再从总设计中被删掉。它们会完整出现在本文的系统关系、资源需求、算法候选、生命周期和实施条件中，只是不与第一轮核心迁移混为同一个提交。

## 2. 核心结论

下一代架构采用以下总方向：

```text
GPU-native cooked assets
    → compact geometry / compressed textures
    → meshlet-granularity work generation
    → hardware-first visibility
    → compute material classification
    → minimal Surface preparation
    → single full material evaluation + lighting
    → bandwidth-aware screen-space effects
    → temporal reconstruction and fused post
```

它不是三条独立管线，也不是 `Core / Quality / Experimental` 三套实现。生产结果仍然只有一条统一主管线；可选能力必须在同一管线中按 capability 和 feature 配置启停，关闭后接近零成本。

V2 的主要性能策略是减少工作放大，而不是追求更少的类名、Pass 数或 Shader 数：

- 从 per-triangle 常规工作转向 per-meshlet 常规工作；
- 从通用 Runtime 顶点解码转向有限的 canonical GPU format；
- 从永久完整 Surface 转向仅保留跨阶段真正需要的 SurfaceLite；
- 从各效果重复构建派生资源转向共享 depth/color products；
- 从无统一约束的局部质量参数转向可测量的预算输入；
- 从模糊的 Pass 时间求和转向真实 GPU frame envelope 和稳定 phase 证据。

## 3. 当前基线与 V2 的关系

### 3.1 保留的现有架构

V2 保留以下已经成立的边界：

- `Renderer` 继续只负责公开生命周期和顶层组合；
- `MainRenderPipeline` 继续是唯一 FrameGraph recipe、Feature 顺序和单帧 encode owner；
- Runtime Asset 继续是设备无关事实；
- Loader、Importer 和临时 Scene 对象不得拥有长期 GPU 资源；
- `GpuAssetStore`、`GpuScene`、`GpuMaterialStore`、Texture Residency 和 `GpuRenderWorld` 的所有权继续分离；
- Packed source 与普通 Scene adapter 继续进入同一个 Render World；
- 普通 mostly-static Scene 继续采用 bulk upload 和显式 transform/material patch；
- 稳定帧不得扫描对象树构建最终可见列表；
- GPU Work Generation 必须形成 GPU producer → GPU consumer 闭环；
- 稳定帧继续保持一个 main submit；
- Feature 关闭时不得留下无消费者 Pass、资源、readback 或独立 submit。

### 3.2 计划替换的现有实现

V2 的候选替换范围是：

- per-triangle `RasterWork`；
- 所有普通三角形必经的 `ExactRasterWork` 过滤路径；
- 当前直接寻址 exact-triangle work 的 VisibilityKey；
- Runtime 通用 vertex stream 解码；
- `MaterialClassDepth + active kernel fullscreen draws`；
- Surface ABI V1 的完整持久化附件；
- AO、SSR、Exposure、Bloom 等效果的重复派生资源和固定分辨率策略；
- RGBA8 size-class texture bank、运行时 mip 生成和 bank grow 全量搬迁；
- 缺乏统一反馈的 geometry/effect/residency 预算参数。

### 3.3 不自动进入 V2 第一轮、但保留完整设计的能力

以下内容属于长期候选，不因出现在输入文档中就进入第一轮实现：

- 超大世界或无边界世界 streaming；
- Virtual Texture；
- Virtual Shadow Maps；
- Sparse GI；
- Volumetric Fog；
- 完整 Software/Hybrid Raster；
- mesh/task shader；
- multi-draw-indirect；
- 依赖 native-only API 的资源寻址；
- 完整 Gameplay/ECS 生命周期；
- 完整 animation/skinning 生态。

它们只有在当前目标 workload 出现可测量阻塞，并通过后续 ADR 扩大产品范围后才能进入生产路线。本文后续章节仍然完整定义它们如何接入 Asset、Render World、Visibility、FrameProducts、Temporal 和 Budget System，避免将来通过旁路形成第二套架构。

## 4. 设计目标

### 4.1 产品目标

V2 继续服务桌面 WebGPU、中大型高几何密度、静态或 mostly-static 场景。

目标包括：

1. 普通路径不再为每个候选三角形生成长期 RasterWork record；
2. 减少 Visibility 到 Shading 之间的随机 buffer fetch 和通用格式分支；
3. 完整材质语义在每个可见像素上最多执行一次；
4. 不再永久落地 Lighting 不需要跨阶段保存的 albedo/emissive 等值；
5. 显著降低纹理 resident bytes、加载峰值和 runtime mip 工作；
6. 所有主要 GPU queue、attachment 和 history 都有预算、峰值和 overflow 证据；
7. 在固定 adapter、分辨率、DPR、画质和 workload 下建立可信的 GPU/CPU/内存基线；
8. 保留 Hardware-first Visibility 和统一主管线；
9. optional WebGPU feature 只作为加速器，不制造第二套产品架构。

### 4.2 性能目标的表达方式

本文不预先承诺“提升 2 倍”或固定百分比。每一阶段必须声明自己的局部指标和系统指标。

系统指标至少包括：

- CPU frame P50/P95；
- GPU frame envelope P50/P95；
- GPU phase P50/P95；
- stable frame submit 数；
- resident/transient/history/shadow bytes；
- upload/readback bytes per frame；
- work queue produced/consumed/overflow；
- visible meshlet/triangle/pixel 数；
- material evaluation 数；
- effect ray/sample 数；
- image parity、数值误差和 temporal stability。

### 4.3 非目标

V2 不以以下结果为目标：

- 仅减少 Pass 数；
- 仅减少 Shader 文件数；
- 仅创建新的抽象类；
- 为所有场景建立完整 ECS；
- 保持旧内部 ABI 的兼容层；
- 在证据不足时同时长期维护新旧渲染后端；
- 为单一 adapter 的结果宣称跨设备结论；
- 为使用新 WebGPU feature 而使用新 feature。

## 5. 全局设计不变量

### 5.1 GPU 队列合同

每个新增队列必须定义：

- 元素语义和 CPU/WGSL ABI；
- header、stride、alignment 和版本；
- capacity 来源；
- append/compact 算法；
- overflow 行为；
- producer；
- consumer；
- indirect command 的生成方式；
- cleared/reset 的生命周期；
- produced、consumed、rejected、overflow 计数器；
- feature-off 时的资源裁剪。

只生成 GPU Buffer，但最终仍由 CPU 遍历原始列表，不算 GPU-driven 完成。

### 5.2 单主管线合同

候选实现可以在短期 benchmark branch 或 evidence seam 中存在，但只能有三种最终结果：

1. 达到门禁，替换旧实现并删除旧路径；
2. 未达到门禁，删除候选实现；
3. 证据不充分，保持设计状态，不进入生产代码。

禁止把候选永久固化成 `legacy/new`、`core/high` 或 `hardware/compute` 两套产品管线。

### 5.3 Capability 合同

V2 采用 [WebGPU 2026 Desktop](../WEBGPU.md) 作为主要产品能力线，要求 core adapter 与 `core-features-and-limits`。主路径优先使用 adapter 实际支持且 device 显式启用的：

- subgroups；
- shader-f16；
- primitive-index；
- indirect-first-instance；
- texture-formats-tier1/2；
- texture compression BC/ETC2/ASTC；
- timestamp-query；
- 按 API/WGSL/limit 探测的 Immediate Data 与 Transient Attachments。

仍不得把以下 native-only 或 Draft 能力作为生产前提：64 位原子、multi-draw-indirect、mesh/task shader、buffer device address、bindless/resource table、sized binding arrays、subgroup matrix 或 view instancing。

每个 optional accelerator 都必须定义：

- capability probe；
- 是否影响资产变体选择；
- 标准能力 fallback；
- feature-off 的资源和 Pass 裁剪；
- 综合 benchmark 中的同条件性能差异；
- 是否改变输出精度。

Fallback 是同一主管线中的局部实现选择，不是另一条管线。

### 5.4 ABI 版本合同

V2 涉及的 ABI 必须显式版本化：

- Runtime Asset Package；
- Compact Geometry；
- Meshlet metadata；
- Meshlet Raster Work；
- Exact/Risky Raster Work；
- VisibilityKey；
- Material Classification；
- SurfaceLite；
- Texture descriptor/residency page；
- GPU counters/evidence。

ABI 变更默认直接迁移调用方并删除死代码，不保留无需求的兼容层。Cooked asset 的磁盘兼容策略需要在正式 ADR 中单独决定。

## 6. 目标架构总览

```text
                           OFFLINE / LOAD BOUNDARY

 glTF / source formats
          │
          ▼
   Canonical Import IR
          │
          ▼
     OEngine Cooker
          │
          ├──────── Geometry Package V2
          │           compact vertex profiles
          │           meshlet topology + bounds
          │           hierarchy + LOD metadata
          │           material-homogeneous ranges
          │
          ├──────── Texture Package V2
          │           offline mip chain
          │           GPU compressed variants
          │           color-space + usage metadata
          │
          └──────── Runtime Package Manifest
                      stable IDs + dependencies
                      byte ranges + integrity

                              RUNTIME OWNERS

 Runtime Asset Package
          │
          ▼
 GpuAssetStore / TextureResidency / GpuMaterialStore
          │
          ▼
 GpuScene / GpuRenderWorld
          │
          ▼
 Hierarchy + Cluster Cull
          │
          ▼
 Meshlet Raster Work + Risky Triangle Work
          │
          ├──────── bucket indirect hardware raster
          │
          └──────── selective exact/setup path
                              │
                              ▼
                    VisibilityKey V2 + Depth
                              │
                              ▼
                   Compute Material Classification
                              │
                  ┌───────────┴───────────┐
                  ▼                       ▼
            Surface Preparation      Shared Depth Products
                  │                       │
                  └───────────┬───────────┘
                              ▼
              Single Full Material Evaluation + Lighting
                              │
                     HDR + SurfaceLite
                              │
             AO / SSR / Transparency / Temporal
                              │
                       Fused Post / Output
```

## 7. Performance Truth

Performance Truth 是 V2 的前置基础设施，不是最后补做的统计功能。

### 7.1 GPU frame envelope

必须记录同一主 command context 中：

- 第一个生产 GPU command 前的 timestamp；
- 最后一个生产 GPU command 后的 timestamp；
- 两者差值作为 GPU frame envelope。

`gpuPassSum` 继续保留，但不得命名为 `gpuFrameMs`。Pass sum 可以用于局部诊断，不等价于 GPU wall-clock frame time，也不能处理重叠或 timestamp gap 语义。

### 7.2 Phase 分类

至少建立以下互斥 phase：

1. scene update/upload；
2. hierarchy and cluster cull；
3. work generation；
4. exact/setup；
5. hardware visibility；
6. material classification；
7. surface preparation；
8. AO；
9. lighting/IBL；
10. shadow；
11. SSR/reflection；
12. transparency；
13. temporal；
14. exposure/bloom/post；
15. debug/capture；
16. unclassified。

任何 production timestamp label 必须命中恰好一个 phase。`unclassified` 在正式 artifact 中必须为零，不能把所有未知 `Renderer/main` 标签折叠成 frame 时间。

### 7.3 Work amplification counters

需要同时记录：

- hierarchy nodes tested/accepted/rejected；
- clusters tested/accepted；
- meshlet works generated；
- risky meshlets/triangles generated；
- triangles submitted；
- vertex shader invocations；
- visible pixels；
- material classified pixels/tiles；
- full material evaluations；
- SurfaceLite writes；
- AO/SSR rays and resolved pixels；
- history accepted/rejected；
- every queue overflow。

目标不是计数器越多越好，而是可以计算以下放大比：

```text
generated triangle work / visible triangle
submitted triangle / visible triangle
vertex invocation / visible triangle
material evaluation / shaded pixel
Surface bytes written / shaded pixel
effect samples / output pixel
```

### 7.4 固定工作负载

所有候选必须使用相同 adapter、浏览器版本、分辨率、DPR、画质、camera path、warm-up 和 measured frame 数比较。

至少覆盖：

- 高几何密度远景；
- 近距离大三角形；
- 大量微三角形；
- 高频遮挡；
- near-plane 穿越；
- alpha MASK；
- double-sided；
- 多 material class；
- 纹理高 residency；
- full effects；
- feature-off matrix；
- camera cut/resize/device loss 生命周期。

## 8. Asset Architecture V2

### 8.1 边界

Asset Architecture V2 是现有 Runtime Asset 边界的升级，不是重新让 Loader 拥有 GPU 资源。

```text
Importer
    → Canonical Import IR
    → Cooker
    → immutable Runtime Asset Package
    → GPU owner upload/residency
```

Importer 负责格式语义转换；Cooker 负责性能布局；Runtime Package 负责稳定设备无关事实；GpuAssetStore 和 TextureResidency 负责设备相关资源。

### 8.2 Canonical Import IR

Canonical Import IR 只统一 Cooker 所需的输入语义，不应成为长期 Scene 或 GPU owner。

最小内容包括：

- indexed primitives；
- position、normal、tangent、UV、color 等有类型 attribute；
- material ranges；
- topology；
- local transforms；
- texture usage、color space 和 alpha semantic；
- source provenance；
- animation/skinning 的显式 unsupported 或保留字段。

是否立即抽取独立公共 IR，需要由 importer drift 和多格式需求证明。V2 设计必须允许它存在，但第一阶段不因架构美观而强制实现。

### 8.3 Geometry Package V2

Geometry Package V2 应包含：

- package/header version；
- stable geometry ID；
- vertex profile ID；
- compact vertex payload；
- compact index payload；
- meshlet vertex/index tables；
- meshlet bounds and cone；
- material-homogeneous meshlet/range metadata；
- hierarchy nodes；
- LOD/error metadata；
- decode scale/bias；
- optional page table；
- checksums and byte ranges；
- source/cooker provenance。

Cooker 必须保证同一 recipe 和输入产生可复现结果。

### 8.4 Canonical Compact GPU Geometry

V2 不允许可见像素热路径继续支持任意输入顶点格式组合。目标是少量、显式、可预编译的 GPU vertex profile。

建议的 static profile 语义为：

| 属性 | 首选表达 | Fallback |
|---|---|---|
| Position | geometry-local quantized 16-bit + scale/bias | float32x3 |
| Normal | octahedral signed normalized | packed/f32 diagnostic fallback |
| Tangent | packed signed normalized + handedness | explicit tangent profile |
| UV | float16x2 或 bounds-relative unorm16x2 | float32x2 |
| Color | rgba8unorm | absent/default |
| Index | meshlet-local 8/16-bit | package-level 16/32-bit |

具体格式不是在本文中永久冻结的 ABI。每个 profile 必须证明：

- cook/decode 数值误差；
- position crack 和 bounds 保守性；
- normal/tangent 角度误差；
- UV 精度和 wrap 行为；
- vertex/index resident bytes；
- Visibility/SurfacePrep GPU 时间；
- shader 分支和 pipeline variant 数。

Production profile 数量必须保持有界。遇到不支持的 source attribute 时，应在 Cook 阶段失败、降级到显式 fallback profile，或标记 feature unsupported；不得恢复任意 Runtime decoder。

### 8.5 Meshlet Cook 合同

Meshlet 是 V2 Geometry Frontend 的基本调度粒度。Cooker 必须产生：

- bounded local vertex count；
- bounded local triangle count；
- compact local indices；
- conservative sphere/AABB/cone；
- material/raster-state homogeneous guarantee，或显式 subrange；
- hierarchy leaf mapping；
- stable local meshlet index；
- coverage/risk hints；
- recommended raster bucket；
- optional large-triangle/setup hints。

Bucket 只能是建议值。Runtime 可以根据实际 meshlet metadata 重新选择，但不得依赖 CPU 每帧遍历。

### 8.6 Texture Package V2

Texture Package V2 必须把颜色空间、用途、mip 和 GPU 变体视为资产事实。

每张纹理至少记录：

- stable texture ID；
- semantic：base-color、normal、ORM、emissive、data 等；
- color space；
- dimensions and mip count；
- alpha semantic；
- sampler constraints；
- GPU format variant；
- mip byte ranges；
- decode/transcode requirement；
- source/cooker provenance。

Cook 阶段负责：

- 生成完整 mip chain；
- normal map 的正确过滤和重归一化；
- alpha coverage 保持；
- 颜色空间正确的缩小过滤；
- 为目标平台输出 BC、ETC2、ASTC 或 RGBA fallback 变体；
- 记录每个变体的实际 resident bytes。

Runtime 不应在普通加载路径为完整资产重新生成 mip。

### 8.7 Texture Residency V2

第一阶段目标不是完整 Virtual Texture，而是解决当前 residency 的三个直接问题：

1. 所有纹理落到 RGBA8；
2. size-class array grow 需要搬迁旧数据；
3. 逻辑 resident、allocated、transaction peak 和 retiring 生命周期不够解耦。

Texture Residency V2 应支持：

- 按 adapter capability 选择已 Cook 的压缩变体；
- immutable allocation group 或分段 bank，避免频繁整体 grow；
- 明确 logical resident、physical allocated、retiring、transaction peak；
- batch upload budget；
- stable texture handle 与物理位置分离；
- mip/page readiness；
- device loss 后确定性重建；
- format/usage 相容的默认纹理；
- feature-off 或无纹理材质不创建额外资源。

Page table 和 partial mip residency 可以预留 ABI，但在固定 workload 证明需要前，不实现复杂 streaming scheduler。

## 9. Geometry and Visibility Frontend V2

### 9.1 目标

普通路径的工作粒度从 triangle 改为 meshlet。Triangle 仍是硬件光栅化和 Visibility 的最终 primitive，但不再要求每个候选 triangle 都拥有独立的常规 RasterWork record。

### 9.2 Work Generation 数据流

```text
GpuScene instances
    → hierarchy traversal
    → visible clusters/leaves
    → meshlet cull
    → GpuMeshletRasterWork table
    → bucket queues
    → indirect draws
    → VisibilityKey V2
```

Risky triangle 路径从 meshlet metadata 和运行时投影条件产生：

```text
meshlet work
    → risk classification
    → normal bucket OR risky triangle queue
    → optional triangle setup
    → hardware visibility
```

### 9.3 GpuMeshletRasterWork

逻辑字段至少包括：

```text
instance_slot
geometry_slot
meshlet_slot
material_slot
packed_raster_flags
packed_lod_and_profile
```

目标 stride 为 24 bytes，但最终 stride 必须由字段和 alignment oracle 决定，不能为了数字删除必要语义。

`packed_raster_flags` 至少表达：

- opaque/mask；
- single/double-sided；
- winding；
- vertex profile；
- risk/setup eligibility；
- valid/debug bits。

每个 meshlet work 必须可以独立恢复：

- instance transform；
- compact vertex/index payload；
- material kernel class；
- meshlet-local triangle；
- previous transform/motion data；
- debug identity。

### 9.4 Meshlet Bucket Raster

候选 bucket 为：

- 32-triangle；
- 64-triangle；
- 96-triangle；
- 128-triangle。

每个 bucket 对应一个 bounded indirect draw。Vertex shader 通过 `instance_index` 定位 bucket work，通过 `vertex_index` 计算 meshlet-local triangle/vertex corner。

Bucket padding 会产生无效 vertex invocation，因此必须记录：

```text
padded_vertex_invocations
actual_triangle_invocations
padding_ratio
bucket_meshlet_count
```

Bucket 集合不是永久固定值。最终选择必须依据实际 meshlet triangle distribution、pipeline 切换成本和 padding 比完成 benchmark。

### 9.5 Bucket Queue 合同

每个 bucket queue 必须定义：

- header：count、capacity、overflow、reserved；
- element：`meshlet_work_slot`；
- producer：meshlet/risk classification compute；
- consumer：bucket indirect render；
- capacity：由本帧 geometry budget 和 resident meshlet 上限推导；
- overflow：设置 counter，本帧不得越界写；
- correctness fallback：overflow 必须使验证失败，不能静默丢失；
- stable frame：CPU 不读取 queue 内容；
- reset：由主 FrameGraph 中唯一 clear/reset owner 完成。

生产实现不得因为有四个 bucket 就产生四个独立 submit。

### 9.6 Risky/Exact 路径

ExactTriangleFilter 不再是所有 triangle 的强制中间层，只处理明确风险项。

风险条件候选包括：

- near-plane/camera-plane 交叉；
- clip-space 数值风险；
- degenerate 或接近 degenerate；
- 大屏幕覆盖三角形；
- MASK alpha conservative 问题；
- double-sided/winding 特例；
- debug/oracle 强制 exact；
- setup cache 命中候选。

Risky queue 仍需定义 record ABI、capacity、overflow、producer 和 consumer。TriangleSetup 保留为显式可裁剪加速器；关闭时不分配 setup buffer、不增加 clear、不增加无消费者 Pass。

普通路径和 risky 路径必须写出完全相同的 VisibilityKey V2 语义。

### 9.7 VisibilityKey V2

建议的逻辑语义是：

```text
VisibilityKeyV2 = meshlet_work_slot + local_triangle
```

候选 32-bit 布局：

```text
bits  0..23  meshlet_work_slot
bits 24..31  local_triangle
```

这个布局成立的前提是：

- meshlet local triangle 不超过 255；
- 单帧 meshlet work table 不超过 24-bit 可表达容量；
- material kernel class 可以从 meshlet work/material table 恢复；
- empty/invalid 值有无歧义编码；
- 普通/risky/setup 路径都能生成同一 key；
- overflow 在写 key 前被捕获。

最终 bit layout 必须通过容量 workload 和 CPU/WGSL oracle 冻结。若 24-bit work slot 不够，应调整 table 分区或 key 设计，不允许静默截断。

### 9.8 Hardware-first 不变量

V2 继续以 hardware raster 为普通路径。Meshlet Bucket 是使用标准 indirect draw 的调度方案，不意味着 Software Raster 或 Mesh Shader。

只有在硬件路径出现经过验证且无法通过 work granularity、LOD、risk classification 解决的阻塞时，才重新讨论 Software/Hybrid Raster。

## 10. Material Classification V2

### 10.1 目标

Material Classification V2 负责把 Visibility 中的可见像素按有限 material kernel class 组织为 compute-friendly 工作，同时避免每个 active class 对全屏像素重复执行无关工作。

### 10.2 两阶段迁移

Material V2 不与 Surface V2 一次性上线。

第一阶段：

```text
VisibilityKey V2
    → compute tile/class classification
    → current Surface ABI producer
```

用于单独证明 classification backend 的成本和正确性。

第二阶段：

```text
VisibilityKey V2
    → compute tile/class classification
    → SurfacePrep + ShadeLighting V2
```

只有第一阶段达到门禁，第二阶段才替换 current material backend。

### 10.3 Tile-Class 设计

屏幕被划分为固定 tile。每个 tile 记录：

- valid pixel count；
- material class mask；
- optional dominant class；
- dispatch/worklist offset；
- overflow/complex tile 标记。

第一版优先采用 bounded tile dispatch，不立即做全屏 pixel compaction。只有 tile occupancy 证明确有大量空线程浪费时，才增加 pixel worklist。

### 10.4 Material Work Queue

若引入 material work queue，必须满足全局队列合同。候选元素可以是：

```text
tile_id
material_class
pixel_mask_or_range
```

WebGPU 2026 Desktop 主实现优先使用已启用的 subgroup compact；不得假设固定 subgroup size。无 `subgroups` 时使用 workgroup/shared-memory/atomic specialization，并与主实现输出一致。

### 10.5 Binding Budget

Compute Material 设计必须在写 Shader 前完成 binding budget 表，至少统计：

- Visibility/Depth；
- Meshlet Work；
- Geometry table；
- Vertex/index streams；
- Instance table；
- Material table；
- Texture banks/samplers；
- Light/environment；
- SurfaceLite/HDR storage outputs；
- Counters/debug buffers。

禁止假设现有六个 Surface render attachments 可以一对一改成同一次 compute dispatch 的 storage texture。若超过 adapter limit，优先减少持久输出、合并 buffer/texture table或重排阶段，而不是无条件拆成更多全屏 dispatch。

## 11. Surface and Lighting V2

### 11.1 核心原则

V2 不再把完整材质结果作为永久 GBuffer 保存。完整材质语义只在最终 shading 阶段求值一次；跨阶段只保留屏幕空间消费者真正需要的数据。

### 11.2 SurfaceLite 语义

SurfaceLite 的逻辑字段候选为：

- shading normal；
- perceptual roughness；
- material/shading flags；
- surface validity；
- 可选 specular/metallic 分类；
- 可选 compact material reference。

以下内容默认不进入持久 SurfaceLite：

- base color；
- emissive radiance；
- 完整 ORM；
- 可从 Visibility/Material table 恢复的 instance/geometry identity；
- 只被 Lighting 使用一次的中间值。

Velocity、reactive、occlusion confidence 等时域信号继续作为独立 FrameProduct，根据 feature topology 裁剪，不强塞进 SurfaceLite。

SurfaceLite 的目标是 4–8 B/pixel，但最终物理格式必须同时满足：

- storage/render write capability；
- filter/load requirement；
- normal 精度；
- AO/SSR quality；
- adapter binding limit；
- read/write bandwidth；
- debug capture。

### 11.3 AO normal 依赖

AO 当前需要 normal，而完整材质又计划在 Lighting 中单次求值。V2 明确采用以下拆分：

```text
VisibilityKey V2
    → SurfacePrep：只解析屏幕空间必需的 normal/roughness/flags
    → AO
    → ShadeLighting：单次完整材质求值 + lighting
```

SurfacePrep 不是完整 Material Resolve。它只能执行构造 SurfaceLite 所需的最小几何和材质工作。

SurfacePrep 必须评估三种候选：

1. depth-derived geometric normal；
2. compact vertex-interpolated normal；
3. material normal-map-aware shading normal。

默认选择必须由 AO/SSR 图像差异和 GPU 时间决定。如果 material normal map 使 SurfacePrep 接近完整材质求值，则应重新评估 AO 顺序或允许 AO 使用 geometric normal，而不是把完整 Resolve 隐藏在新名字后面。

### 11.4 ShadeLighting

ShadeLighting 按 material class/tile 执行：

1. 读取 VisibilityKey V2；
2. 恢复 meshlet work、local triangle 和 barycentric；
3. 读取 canonical compact vertices；
4. 执行一次完整 material evaluation；
5. 读取 AO、shadow、light/environment；
6. 写 pre-exposed HDR；
7. 写或补全 SurfaceLite 中后续 SSR/Temporal 需要的字段；
8. 更新 material/shading counters。

完整材质求值次数应接近 shaded valid pixel 数。任何重复求值必须能由计数器解释。

### 11.5 HDR 格式和 Pre-Exposure

V2 默认使用 pre-exposed HDR 语义，以降低高动态范围格式压力并改善 temporal 稳定性。

物理格式候选包括：

- `r11g11b10ufloat`；
- `rgba16float`；
- 其他经过 capability 验证的 storage/render-compatible format。

HDR 格式不能只按字节数选择。必须验证：

- storage/render attachment 支持；
- alpha 是否被其他消费者使用；
- bloom/exposure 精度；
- negative value 需求；
- temporal history 误差；
- transparent composite；
- tone mapping 输出差异。

不支持目标紧凑格式的 adapter 使用同一 HDR 语义的 fallback format，而不是另一条渲染管线。

## 12. Shared Derived Products

### 12.1 目的

AO、SSR、Exposure、Bloom 和 Temporal 不应分别重复构建相同或高度重叠的深度/颜色派生资源。

V2 引入统一的 FrameProduct owner，而不是对外暴露新的全局 service locator。

### 12.2 Shared Depth Products

候选产品：

- resolved depth；
- linear depth；
- min/max HZB；
- motion-dilated depth；
- geometric normal derivative，可选。

每个产品必须有明确 consumer。若 AO、SSR、Occlusion 均关闭，对应派生资源和构建 Pass 必须被裁剪。

### 12.3 Shared Color Products

候选产品：

- pre-exposed HDR base level；
- luminance pyramid；
- color pyramid；
- exposure reduction input；
- bloom source levels。

是否使用 SPD 风格单 dispatch pyramid 由 adapter、format、mip 数和同条件 benchmark 决定。共享产品的价值是消除重复读写，不是为了引入特定算法名称。

### 12.4 Owner

共享产品由 `MainRenderPipeline` 的 FrameGraph recipe 声明和连接。可以由内部 Feature/Service 实现 encode，但不得：

- 自行 submit；
- 在 FrameGraph 外隐式缓存 transient view；
- 在无 consumer 时创建资源；
- 让多个效果分别声称同一个 pyramid 的生命周期所有权。

## 13. Effects Pipeline V2

### 13.1 AO V2

AO V2 的目标是：

- 保持 half/internal resolution 工作；
- 使用 Shared Depth Products；
- 避免无必要的 full-resolution 中间展开；
- temporal/spatial 阶段拥有独立计数和时间；
- 输出 compact AO/bent-normal，仅在真实 consumer 存在时生成 bent normal；
- 明确使用 geometric normal 还是 shading normal。

AO 不能仅因为 Pass 多就被判定重写；必须由 bandwidth、GPU phase 和图像稳定性证明。

### 13.2 SSR V2

SSR V2 的候选方向是：

- 使用共享 depth/color pyramid；
- tile/ray classification；
- roughness-aware resolution；
- compact ray list；
- spatial/temporal resolve；
- 无 SSR consumer 时完全裁剪相关 pyramid 分支。

SSR 必须记录 rays generated、rays traced、hit/miss、steps、resolved pixels 和 history acceptance。

固定半分辨率不是永久合同。具体 resolution 由 quality 配置和预算输入决定，但第一版不引入每 tile 任意分辨率。

### 13.3 Transparency

当前统一透明路径继续保留，直到固定透明 workload 证明成为瓶颈。

未来可按内容区分：

- simple forward alpha；
- weighted blended；
- moment-based/OIT；
- refractive/special material。

但分类会扩张 material contract、draw/work queue 和 temporal reactive 语义，因此不进入 Surface V2 的首批阻塞项。

### 13.4 Temporal Reconstruction

Temporal V2 统一处理：

- internal-to-output reconstruction；
- velocity；
- reactive；
- disocclusion/occlusion confidence；
- history validity；
- camera cut；
- resize；
- exposure change。

升级到 Temporal Upscaler 必须单独验证静态细节、运动边缘、透明、MASK、粒子、SSR、AO 和 camera cut。不能只以平均 GPU 时间替代图像稳定性证据。

### 13.5 Exposure、Bloom 和 Post

Exposure 优先从共享 luminance pyramid 或低分辨率输入归约，不默认扫描完整 HDR。

Bloom 与 Post 可以融合相邻阶段，但仅在以下条件下进行：

- 减少了可测量的 texture traffic；
- 不破坏 feature-off 裁剪；
- 不制造大而不可复用的 shader variant；
- debug capture 仍可在必要边界获取；
- tone mapping、grading、sharpen 输出通过数值/截图回归。

Color grading LUT、motion blur 和其他效果不是 V2 基础闭环的前置条件。

## 14. Frame Pipeline V2

目标帧序如下：

```text
1.  Encode pending scene/material/texture patches
2.  Build/update view and previous-frame state
3.  Hierarchy + cluster + meshlet cull
4.  Generate Meshlet Raster Work and Risky Work
5.  Encode bucket/risky indirect commands
6.  Hardware Visibility → VisibilityKey V2 + Depth
7.  Build Shared Depth Products as demanded
8.  Compute Material Classification
9.  SurfacePrep → SurfaceLite
10. AO, if enabled
11. Shadow consumers/producers required by the frame
12. ShadeLighting → pre-exposed HDR
13. Shared Color Products as demanded
14. SSR/reflection, if enabled
15. Transparency + reactive
16. Temporal Reconstruction
17. Exposure/Bloom/Post
18. Debug/Capture, if requested
19. One main submit
```

这个顺序是依赖设计，不等同于要求每一项都是独立 Pass。实现可以在不破坏资源生命周期、feature-off 和证据边界的前提下融合相邻阶段。

## 15. FrameProduct 合同

建议的主要产品关系：

| Product | Producer | Consumer | 生命周期 |
|---|---|---|---|
| Scene bindings | GpuRenderWorld | cull/raster/shading | resident/imported |
| Meshlet Work | work generation | bucket raster/shading | transient frame buffer |
| Risky Work | risk classifier | exact/setup raster | transient, feature-dependent |
| VisibilityKey V2 | visibility | classification/SurfacePrep/shading/debug | transient texture |
| Depth | visibility | HZB/AO/shading/SSR/temporal | transient texture |
| Shared Depth Products | derived product feature | AO/SSR/occlusion | transient, demand-created |
| Material Classification | material classifier | SurfacePrep/ShadeLighting | transient buffer/texture |
| SurfaceLite | SurfacePrep/ShadeLighting | AO/SSR/temporal/debug | transient texture(s) |
| AO | AO | ShadeLighting/reflection | transient/history |
| HDR | ShadeLighting | SSR/transparency/temporal/post | transient/history input |
| Shared Color Products | derived product feature | SSR/exposure/bloom | transient, demand-created |
| Velocity | visibility/SurfacePrep | temporal/motion effects | optional transient |
| Reactive | transparency/material | temporal | optional transient |
| Temporal history | temporal | next-frame temporal | persistent history |

任何新增 Product 都必须补充格式、分辨率域、owner、consumer、clear/load/store、history validity 和 feature-off 行为。

## 16. Budget System

### 16.1 预算种类

V2 统一定义但分阶段实现以下预算：

- geometry work budget；
- risky/exact work budget；
- texture resident/transaction/upload budget；
- geometry resident/upload budget；
- shadow budget；
- AO/SSR ray/sample budget；
- transient/history memory budget；
- readback budget；
- CPU graph/encode budget；
- GPU frame target。

### 16.2 控制原则

预算控制必须：

- 以 GPU counters 和延迟反馈为主；
- 避免每帧同步 readback；
- 使用 hysteresis，避免 LOD/resolution 震荡；
- camera cut/teleport 时有显式重置策略；
- 不改变 deterministic validation 的可重复性；
- 提供 fixed-budget 模式用于 benchmark；
- 记录 budget requested/granted/rejected/deferred。

### 16.3 优先退化顺序

发生预算压力时，候选退化顺序是：

1. 延迟不可见或低优先级 residency 请求；
2. 调整 geometry LOD/SSE；
3. 降低 SSR/AO sample 或 internal resolution；
4. 调整 shadow update；
5. 调整 temporal internal scale；
6. 保持 Visibility、Depth、核心 Lighting 正确性。

不得通过静默丢弃 queue overflow 项实现预算控制。

## 17. 实施依赖与阶段

本文定义架构依赖，但不是实施 ADR。正式执行前需要把每一步转成可审计 implementation plan。

### Phase 0：Performance Truth

范围：

- true GPU frame envelope；
- `gpuPassSum` 重命名和保留；
- 互斥 phase 分类；
- work amplification counters；
- 固定 workload 和 artifact schema。

验证：

- CPU 单元测试覆盖 phase 分类和 artifact 聚合；
- 浏览器 timestamp sample 无 pending/dropped；
- `unclassified = 0`；
- GPU envelope 与 phase/pass sum 语义明确；
- 同一 workload 三次独立 context 可重复；
- 不改变渲染截图和 FrameGraph topology。

退出条件：后续所有候选都能使用同一个可信证据合同。

### Phase 1：Cross-System ABI Design

范围：

- Geometry Package V2；
- compact vertex profiles；
- Meshlet Work；
- Risky Work；
- VisibilityKey V2；
- Material Classification；
- SurfaceLite semantic ABI；
- Texture Package V2。

验证：

- CPU pack/unpack；
- WGSL layout/oracle；
- boundary/invalid/overflow cases；
- package deterministic serialization；
- binding budget；
- capacity calculation；
- FrameProduct consumer matrix 完整。

退出条件：不存在一个子系统修改字段后迫使另一个子系统重新定义 identity 的未解决冲突。

### Phase 2：Texture Pipeline V2

范围：

- offline mip；
- compressed format variants；
- capability-based variant selection；
- Texture Residency V2 allocation；
- upload/retiring/transaction accounting。

验证：

- color-space、normal、alpha coverage 数值/截图回归；
- BC/ETC2/ASTC/RGBA fallback；
- resident/allocated/transaction peak；
- cold load、warm load、resize、device loss；
- 固定纹理 workload；
- 无纹理和 feature-off 资源裁剪。

退出条件：在至少两个相关 adapter/format 路径上降低 resident 或加载成本，且没有不可接受图像回退。

### Phase 3：Compact Geometry V2

范围：

- canonical compact profiles；
- meshlet metadata；
- hierarchy/LOD metadata；
- GpuAssetStore upload and binding；
- current renderer 临时消费新格式以建立基线。

验证：

- position/normal/tangent/UV error；
- bounds conservative；
- indexed topology parity；
- MASK/double-sided/material range；
- package bytes、resident bytes、upload bytes；
- current Visibility/Resolve GPU 时间；
- unsupported attribute 明确失败。

退出条件：compact profile 的质量与内存门禁满足，并删除对应 generic production format 分支。

### Phase 4：Geometry Frontend V2

范围：

- GpuMeshletRasterWork；
- bucket queues and indirect draw；
- selective risky/exact path；
- VisibilityKey V2；
- current material consumer 迁移。

验证：

- CPU/WGSL VisibilityKey oracle；
- near-plane、degenerate、large triangle；
- MASK、double-sided、reverse-Z；
- normal/risky/setup off/on parity；
- queue capacity/overflow；
- producer/consumer 计数闭合；
- triangle work bytes、vertex invocation、GPU phase；
- fixed far/near/microtriangle workload；
- 至少一个命中浏览器示例和截图。

退出条件：candidate 在目标 workload 达到预先冻结的收益门禁；成功则替换并删除 per-triangle normal path，失败则删除 candidate。

### Phase 5：Material Classification V2

范围：

- tile/class classification；
- bounded compute dispatch；
- current Surface ABI 输出；
- optional subgroup accelerator。

验证：

- 所有 material kernel class；
- empty/sparse/dense tile；
- alpha MASK、normal/ORM/emissive；
- storage/buffer binding limits；
- classified/shaded pixel counters；
- ClassDepth/ClassDiscard/Compute 同条件 A/B；
- 第二 GPU vendor；
- feature-off 无队列和资源。

退出条件：满足正式 ADR 规定的多 vendor 性能和正确性门禁后替换旧 backend。

### Phase 6：SurfaceLite and ShadeLighting

范围：

- SurfacePrep；
- SurfaceLite；
- single full material evaluation；
- lighting fusion；
- pre-exposed HDR；
- AO/SSR/debug consumer 迁移。

验证：

- Surface consumer matrix；
- material evaluation counter；
- normal-map-aware/geometric normal A/B；
- AO/SSR/IBL/shadow/emissive/unlit；
- velocity/reactive/temporal；
- Surface bytes/pixel 和 transient peak；
- material+lighting GPU phase；
- HDR format precision；
- screenshot/numeric regression；
- feature-off 资源裁剪。

退出条件：所有生产 consumer 迁移完成，Surface V1 producer/attachments/shaders 被删除，不保留双 Surface。

### Phase 7：Effects and Shared Products V2

范围：

- Shared Depth/Color Products；
- AO/SSR consumers；
- exposure reduction；
- bloom/post fusion candidate；
- temporal reconstruction candidate。

验证：

- 每个 feature 单独 off；
- shared product consumer 裁剪；
- AO/SSR ray/sample/history counters；
- camera cut、motion、resize、transparency；
- transient/history bytes；
- GPU phase；
- screenshot/video temporal review；
- no extra submit/readback。

退出条件：每个替换独立达到收益门禁；没有收益的融合或算法候选被删除。

### Phase 8：Budget Controller and Evidence-Triggered Extensions

范围：

- geometry/effect/residency hysteresis；
- fixed/dynamic budget modes；
- optional page residency；
- optional software shading rate；
- 其他由证据触发的能力。

验证：

- camera approach/retreat/teleport；
- workload pressure ramps；
- oscillation and recovery；
- delayed readback；
- deterministic benchmark mode；
- image quality floor；
- queue/memory budget 无静默越界。

退出条件：预算系统能在固定质量下证明开销，在动态模式下证明稳定性，且不会隐藏 correctness failure。

## 18. 验证矩阵

每一阶段至少检查以下层次：

| 层次 | 必须证据 |
|---|---|
| ABI | CPU/WGSL layout、round-trip、invalid/overflow |
| Build | `npm ci`、`npm run build`、命中单元测试 |
| GPU correctness | validation error、uncaptured error、device loss 为零 |
| Rendering | 浏览器示例、截图或数值回归 |
| Lifecycle | resize、toggle、camera cut、abort、device loss |
| Graph | pass/resource topology、feature-off 裁剪、一个 main submit |
| Work | producer/consumer/capacity/overflow counters |
| Timing | CPU/GPU P50/P95、true frame envelope、phase |
| Memory | resident/transient/history/shadow/upload/readback/peak |
| Portability | capability matrix，必要阶段至少两个 GPU vendor |

性能结果必须报告没有运行的矩阵项和原因，不允许把未测场景写成通过。

## 19. 迁移和删除策略

### 19.1 垂直切片

每个阶段采用最小可闭合垂直切片：

```text
Asset/Producer
    → ABI
    → GPU Consumer
    → Counters
    → Browser Evidence
```

禁止只完成“生成 Buffer”但仍让 CPU 或旧 consumer 使用原列表。

### 19.2 短期候选

为了正式 A/B，可以短期保留 candidate selection seam，但必须：

- 不公开为稳定 API；
- 不形成独立 submit；
- 不让 candidate-off 创建资源；
- artifact 记录确切实现；
- 阶段退出时立即选择 replace 或 reject。

### 19.3 删除要求

替换完成后删除：

- 旧 ABI；
- 旧 shader/layout/pipeline；
- 旧 counter 和 label；
- 旧 FrameGraph resource；
- 旧配置开关；
- 无消费者 helper；
- generated source 的旧生成入口；
- 临时 compatibility adapter。

不得只通过停止调用来宣称迁移完成。

## 20. 风险

### 20.1 跨系统 ABI 同时变化

Geometry、VisibilityKey、Material 和 Surface 同时变化容易形成大爆炸迁移。解决方式是先冻结逻辑 identity，再按阶段让新 producer 临时服务当前 consumer，避免一次修改整帧。

### 20.2 Meshlet padding 抵消 work record 收益

Bucket 越少，padding 越高；bucket 越多，draw/pipeline 切换越多。必须用真实 meshlet 分布和 vertex invocation 计数选择，不预设四 bucket 永远最优。

### 20.3 Compute binding pressure

Compute Shading 可能受 storage texture/buffer、sampled texture、sampler 和 workgroup storage limit 限制。必须先建立 binding budget，并保留标准能力 fallback。

### 20.4 SurfaceLite 破坏效果语义

AO、SSR、Temporal、debug 可能依赖当前 Surface 中不明显的字段。删除 attachment 前必须完成 consumer matrix 和图像回归。

### 20.5 Material work 重复

SurfacePrep 可能演变为第二次完整 Material Resolve。必须使用 material evaluation、texture sample 和 shader phase 证据限制其职责。

### 20.6 资产压缩质量

Quantization 和 block compression 会引入误差。必须按语义建立阈值，不能只看文件和显存大小。

### 20.7 Optional feature 分裂实现

Subgroup、f16 或新格式容易形成事实上的第二后端。所有 accelerator 必须共享逻辑 ABI、资源 owner、FrameProducts 和验证用例。

### 20.8 预算控制掩盖问题

自动降低质量可能掩盖 overflow 或性能回退。正式 benchmark 默认使用固定预算；dynamic controller 单独验证。

## 21. 需要在正式 ADR 前关闭的问题

以下问题在本文保持开放，但必须在对应实现阶段前冻结：

1. Geometry Package V2 是否需要稳定磁盘兼容；
2. 是否现在抽取 Canonical Import IR，还是先由现有 importer 直接产生 package recipe；
3. canonical vertex profile 的确切格式和数量；
4. meshlet 最大 vertex/triangle 数；
5. bucket 数和边界；
6. VisibilityKey V2 的最终 bit layout；
7. risky triangle 的保守分类条件；
8. Compute Material 的 tile 大小和 worklist 形态；
9. SurfaceLite 的逻辑字段和物理格式；
10. AO 使用 geometric normal 还是 shading normal；
11. HDR 的默认和 fallback 格式；
12. Shared Depth/Color Product 的精确 owner；
13. Texture Residency V2 是 segmented bank 还是 page table；
14. 哪些 optional feature 值得维护 accelerator；
15. 每阶段的具体性能进入/退出阈值；
16. 哪些长期能力需要扩大 PRODUCT 范围。

开放问题不是允许实现任意发挥。每个答案都必须进入对应 ABI、验证和迁移合同。

## 22. 后续文档拆分建议

总设计稳定后，再把它拆成以下权威文档，不在本文阶段提前创建：

1. Performance Architecture V2 总 ADR；
2. Asset Package and Residency V2 ADR；
3. Geometry Work and VisibilityKey V2 ADR；
4. Compute Material and SurfaceLite V2 ADR；
5. Effects and Shared Products V2 ADR；
6. 分阶段 implementation plan；
7. 对应 `docs/porting/` provenance；
8. `VALIDATION.md` 新 artifact schema 和门禁；
9. `STATUS.md` 的实施状态。

在总 ADR 接受前，本文继续位于 `docs/others/`，不覆盖当前 `ARCHITECTURE.md`、`PIPELINE.md`、`PRODUCT.md` 和已接受 ADR。

## 23. V2 Core 目标状态概览

V2 完成后的目标状态是：

```text
Source Assets
    → deterministic GPU-native Cook
    → compact Geometry + compressed Texture Packages
    → explicit GPU residency owners
    → hierarchy/meshlet GPU work generation
    → bounded indirect hardware visibility
    → VisibilityKey V2
    → compute material classification
    → minimal SurfacePrep
    → one full material evaluation + lighting
    → SurfaceLite + pre-exposed HDR
    → shared-product AO/SSR/Temporal/Post
    → one MainRenderPipeline
    → one main submit
```

完成的判断依据不是新类型全部存在，而是：

- 普通 per-triangle RasterWork 路径已经被替换或被证据保留；
- VisibilityKey、Material、Surface 和 Effects consumer 全部闭合；
- 纹理和几何 resident/transaction 成本达到预算；
- feature-off 真正裁剪；
- CPU/GPU/内存证据可重复；
- 浏览器正确性与生命周期验证通过；
- 没有遗留双 owner、双主管线和无消费者资源；
- 所有未采用候选都已删除或明确留在未来设计中。

## 24. WebGPU Capability Architecture

### 24.1 设计目的

输入文档提出了 `OEngine WebGPU 2026 High Profile`。V2 接受“充分使用现代 WebGPU 能力”的方向，但把它重新定义为 capability architecture，而不是另一条高端产品管线。

同一份 Runtime Asset、Render World、FrameProducts 和 MainRenderPipeline recipe 可以根据 adapter/device capability 选择：

- 资源物理格式；
- 局部 queue compact 算法；
- shader arithmetic 精度；
- primitive identity 获取方式；
- pyramid/histogram reduction 算法；
- texture package variant。

这些选择不得改变场景语义、稳定 handle、VisibilityKey 逻辑含义和最终 FrameProduct 合同。

### 24.2 Capability 角色表

| Capability | V2 用途 | 标准路径 | 成熟度 |
|---|---|---|---|
| `timestamp-query` | true frame envelope、phase timing | CPU timing 仅作辅助，不能替代 GPU 证据 | V2 Core evidence capability |
| BC/ETC2/ASTC compression | 直接采样已压缩 Texture Package | RGBA fallback asset variant | V2 Core asset selection |
| `shader-f16` | compact arithmetic、shared memory、部分中间值 | f32 arithmetic | V2 Candidate accelerator |
| `subgroups` | queue compact、tile classify、reduction、SPD/histogram | workgroup shared memory + atomics | V2 Candidate accelerator |
| `subgroup-size-control` | 对特定 compact/reduction 固定执行宽度 | 不依赖固定 subgroup size | Evidence-triggered |
| `primitive-index` | 简化 primitive identity 的恢复实验 | `vertex_index`/local triangle 和 VisibilityKey V2 | V2 Candidate accelerator |
| texture format tiers | 紧凑 HDR/SurfaceLite storage format | 基线 storage/render-compatible format | V2 Candidate format choice |
| `indirect-first-instance` | bucket draw 定位 work range | 显式可表达的 indirect/instance mapping | 当前基础能力延续 |

### 24.3 High Profile 的正确含义

V2 可以定义一组推荐桌面能力集合，用于 benchmark 和资产变体选择，但不得把它变成完全不同的 Renderer：

```text
Recommended Desktop Capability Set
    texture compression for the adapter
    timestamp-query
    storage/render formats needed by selected SurfaceLite/HDR profile
    optional shader-f16
    optional subgroups
    optional primitive-index
```

运行时的决策顺序是：

1. adapter 暴露 capability；
2. Renderer 只请求实际会被当前配置使用的 optional feature；
3. Asset Store 选择兼容 package variant；
4. MainRenderPipeline 选择同一逻辑阶段的局部 pipeline specialization；
5. evidence 记录实际 capability 和 specialization；
6. feature 关闭后不创建相应 pipeline、buffer 或 texture。

### 24.4 Subgroup 使用边界

Subgroup 优先实验在以下位置：

- meshlet/bucket queue append 和 compact；
- material tile class mask 合并；
- pixel/ray worklist compact；
- HZB/SPD pyramid reduction；
- exposure histogram/reduction；
- prefix sum 和 scan；
- AO/SSR 的局部 ballot/early-out。

每个 subgroup shader 必须：

- 不假设固定 subgroup size，除非已显式启用并验证 size control；
- 与基础 workgroup 路径共享 CPU oracle；
- 对 active lane、partial workgroup 和边界像素有测试；
- 报告减少的 atomic、dispatch 或 shared-memory traffic；
- 在不支持时不加载或编译为生产依赖。

### 24.5 Shader f16 使用边界

`shader-f16` 可用于：

- 临时法线、UV、颜色和 roughness 运算；
- workgroup shared memory；
- pyramid、AO、SSR 的局部中间值；
- temporal/history 的候选紧凑表示。

不默认用于：

- world position 累积；
- 大范围 depth reconstruction；
- hierarchy bounds；
- VisibilityKey、handle 和 counter；
- 需要确定性整数语义的 ABI；
- 未证明误差上限的 lighting accumulation。

每个 f16 candidate 必须同时报告性能、寄存器/occupancy 变化和图像误差。

### 24.6 Primitive Index 和 Multi-Draw 的定位

`primitive-index` 可以用于简化某些 visibility shader 的 primitive identity，但不能成为 VisibilityKey V2 的唯一基础。V2 的 meshlet work + local triangle 语义必须在没有该 feature 时仍然闭合。

Multi-Draw 如果未来进入 WebGPU 可用能力或平台扩展，可以减少 bucket/material draw encode 成本，但不改变 work queue ABI。V2 首先以 bounded 数量的标准 indirect draw 完成 GPU producer → consumer；Multi-Draw 只是提交表达优化，不是架构前提。

## 25. Asset Cooker、OAsset 与 OPack 完整设计

### 25.1 为什么 Asset 系统属于性能架构

V2 不把 Asset Pipeline 视为 Renderer 外围工具。顶点布局、meshlet locality、mip、压缩格式、page 边界和依赖表会直接决定：

- GPU resident bytes；
- Runtime decode 和 transcode；
- upload bytes；
- random fetch locality；
- Meshlet Work 是否能直接消费；
- VisibilityKey 能否紧凑寻址；
- Streaming 是否需要重写稳定 handle；
- 首帧和 camera movement hitch。

因此 Cooker、Runtime Package 和 Renderer ABI 必须共同设计，但继续保持所有权分离。

### 25.2 文件角色

建议区分：

| 文件 | 作用 |
|---|---|
| `.oasset` | 单个逻辑资产的 manifest、recipe、依赖、variant 和 chunk 索引 |
| `.opack` | 多资产/多 chunk 的可寻址二进制容器，可按 page/range 读取 |
| Source file | glTF、图片等导入格式，不作为稳定 Runtime ABI |

`.oasset` 可以内嵌小 payload，也可以引用 `.opack` 中的 byte ranges。名称和扩展名最终由 ADR 冻结；本文冻结的是职责分离。

### 25.3 OAsset Manifest

Manifest 建议包含：

```text
magic
container_version
asset_schema_version
asset_id
asset_type
cooker_version
recipe_hash
source_provenance
dependency_table
variant_table
chunk_table
integrity_table
debug_names(optional)
```

每个 chunk 记录：

```text
chunk_type
compression
alignment
file_offset
compressed_bytes
decoded_bytes
resident_bytes
page_group
checksum
```

Runtime 不通过对象图猜测依赖，而是读取显式 dependency 和 chunk table。

### 25.4 Variant 体系

同一逻辑资产可以包含或引用多个物理 variant：

- Geometry float32 fallback；
- Geometry compact static profile；
- BC texture；
- ETC2 texture；
- ASTC texture；
- RGBA fallback；
- 不同 quality/LOD group；
- debug/uncompressed development variant。

Variant 选择必须由 capability、quality 和内存预算决定。选择结果写入 evidence，不能因为加载顺序随机变化。

### 25.5 Cook 流程

完整 Cook 顺序建议为：

```text
Import source
    → normalize semantic IR
    → validate topology/material ranges
    → generate/recompute required attributes
    → vertex remap and deduplication
    → vertex-cache reorder
    → overdraw-aware reorder where applicable
    → vertex-fetch reorder
    → quantize/pack canonical profiles
    → build meshlets
    → optimize meshlet locality
    → compute bounds/cones/error
    → build hierarchy/LOD metadata
    → partition chunks/pages
    → encode geometry payload
    → cook texture mips and variants
    → write manifest/chunk/provenance
    → run deterministic package validation
```

顺序可以因算法约束调整，但必须解释为什么调整不会破坏 meshlet locality、quantization bounds 或 material homogeneity。

### 25.6 Runtime 加载链路

目标加载链路是：

```text
fetch/read range
    → validate header and manifest
    → select capability variant
    → schedule chunk reads
    → worker decompress/transcode if required
    → validate decoded size/checksum
    → reserve GPU residency transaction
    → batch GPU upload
    → publish stable handle only after completion boundary
    → retire temporary CPU buffers
```

不能在 handle 已公开后再悄悄改变 asset identity。物理 residency 可以变化，但稳定逻辑 handle 和 descriptor 必须通过 table indirection 保持一致。

### 25.7 Worker 设计

Web Worker 适合承担：

- container parsing；
- meshopt/通用 payload 解压；
- Basis/KTX2 transcode；
- checksum；
- 大块 TypedArray 重排；
- page/chunk request preparation。

Worker 不拥有 GPUDevice、GPUTexture 或 GpuAssetStore。主线程负责：

- capability selection 的最终决定；
- GPU transaction reservation；
- command encoding；
- submission lifetime；
- stable handle publication。

Worker 传输必须优先使用 transferable buffer，并记录 transferred bytes、copy bytes、decode time、queue wait 和 peak CPU memory。

### 25.8 CPU RAM 生命周期

一次加载 transaction 需要区分：

```text
source compressed bytes
container staging bytes
decoded canonical bytes
transcode scratch bytes
GPU upload staging bytes
published CPU metadata
retiring bytes
```

不能只报告 GPU resident。需要记录：

- steady CPU metadata；
- cold-load CPU peak；
- concurrent transaction peak；
- worker heap peak；
- upload staging peak；
- transaction 完成后的可回收字节；
- abort/error/device-loss 时的释放。

## 26. Geometry Cook、压缩与局部性

### 26.1 当前矛盾

当前 Geometry Package 已经建立 GPU-ready 边界，但部分非 position vertex stream 保留来源数据类型，Shader 热路径仍需要通用读取和 normalized/type 分支。

这会同时承担两类成本：

- 资产侧没有为固定 Runtime profile 获得最大压缩和局部性收益；
- GPU 侧仍为通用输入格式支付每像素/每顶点 decode 分支。

V2 的目标是把复杂性移到 Cook，把 Runtime 变成少量明确 profile。

### 26.2 Quantization

Position quantization 以 geometry 或 page bounds 为单位：

```text
encoded = round(clamp((position - bias) / scale, 0, 1) * maxInteger)
decoded = bias + encoded / maxInteger * scale
```

必须保存 conservative bounds，防止 decoded position 超出或缩入导致 culling/raster crack。极端长宽比 geometry 可以：

- 使用 per-axis scale；
- 分 page/cluster quantize；
- 回退 float32 profile。

Normal 优先 octahedral encoding；Tangent 必须保留 handedness；UV 可以按实际范围选择 float16 或 normalized integer，不能假设所有 UV 在 `[0, 1]`。

### 26.3 Reorder 和 Meshlet Locality

V2 分别衡量：

- post-transform vertex cache locality；
- overdraw；
- vertex fetch locality；
- meshlet local vertex reuse；
- 相邻 meshlet/page locality；
- material range locality。

优化一个指标可能伤害另一个指标。例如按 material 完全分组可能降低空间 locality；过度 overdraw reorder 可能打乱 streaming page。Cooker recipe 必须明确权重，并用固定 workload 验证最终 GPU 消费而不是只报告离线评分。

### 26.4 Meshoptimizer 的定位

Meshoptimizer 类算法适合用于：

- remap/deduplication；
- vertex cache optimization；
- overdraw optimization；
- vertex fetch optimization；
- meshlet build；
- bounds/cone；
- payload compression。

Runtime Package 不应直接依赖某个 glTF extension 的内存布局。若采用外部实现，必须记录 upstream、commit/tag、源码路径、许可证、保留不变量和 OEngine/WebGPU 差异。

### 26.5 Draco 的定位

Draco 更适合作为传输/导入压缩候选，而不是 OEngine GPU Runtime Geometry ABI。可能的使用方式：

```text
Draco source/transport
    → import/decode
    → Canonical Import IR
    → OEngine Geometry Cook V2
```

如果解码成本、Worker 体积或不可直接 GPU 消费的重排成本高于网络收益，可以拒绝采用。是否支持 Draco 不影响 Runtime Package 的 compact profile。

### 26.6 组合收益

单项优化的收益不能简单相加，但存在明确协同：

```text
Quantization
    ↓ resident/upload bytes
Vertex reorder
    ↓ cache/fetch misses
Meshlet build
    ↓ work generation granularity
Meshlet locality
    ↓ random geometry fetch
Payload compression
    ↓ disk/network bytes
Canonical decode
    ↓ shader variants and hot-path ALU
```

同时存在 bottleneck shift：纹理压缩后 geometry 可能成为 resident 主项；Geometry Work 降低后 Material/Lighting 可能成为主要 GPU phase；SurfaceLite 降低带宽后 SSR/Temporal 可能成为下一瓶颈。V2 的每阶段都必须重跑完整基线，不能沿用上一个瓶颈判断。

### 26.7 Geometry Payload Compression

磁盘/网络 payload compression 与 GPU resident format 是两个层次：

- payload 可以进一步 entropy/meshopt 压缩；
- Worker 解压得到 canonical compact GPU payload；
- GPU upload 后不需要每帧解压；
- decoded peak 必须进入 CPU RAM transaction budget。

只有在 GPU 直接解压能形成生产者到消费者闭环并证明收益时，才考虑 GPU decode。第一轮不把 GPU decompression 作为前置条件。

## 27. Texture Pipeline V2 完整设计

### 27.1 当前成本模型

RGBA8 texture 的基础层字节为：

```text
width × height × 4
```

完整 mip chain 约为基础层的 `4/3`。以 4096×4096 为例：

```text
base level = 4096 × 4096 × 4 = 67,108,864 bytes = 64 MiB
full mip chain ≈ 89,478,485 bytes ≈ 85.33 MiB
```

这还没有计算：

- bank grow 时新旧 texture 同时存在；
- source image decode buffer；
- resize/render intermediate；
- upload staging；
- retiring texture；
- 同一纹理的重复 logical reference。

因此纹理压缩既是 resident 优化，也是 transaction peak、加载时间和带宽优化。

### 27.2 GPU Block Compression

典型 block compression 的相对成本：

| 表达 | 近似 bits/pixel | 4K 完整 mip chain | 适用候选 |
|---|---:|---:|---|
| RGBA8 | 32 | 约 85.33 MiB | 无压缩 fallback/data |
| 8 bpp block format | 8 | 约 21.33 MiB | 高质量 color/normal 候选 |
| 4 bpp block format | 4 | 约 10.67 MiB | 无 alpha/低复杂度候选 |

实际格式必须按 semantic 选择：

- base color 需要正确 sRGB view/format；
- normal map 关注方向误差和通道重建；
- ORM 是线性数据，不使用 sRGB；
- emissive 需要评估动态范围；
- alpha MASK 需要覆盖率稳定；
- UI/data texture 可能不适合有损 block compression。

不能只为压缩率把所有纹理强制进同一种格式。

### 27.3 KTX2 的定位

KTX2 是容器/传输和 mip/format 描述的一部分，不等于某一种 GPU 压缩格式。

V2 支持两类资产策略：

1. Universal Web Asset：保存可转码 payload，Runtime 根据 adapter 转成 BC/ETC2/ASTC；
2. Performance Asset Variant：Cook 阶段直接生成目标 GPU format，Runtime 选择并直接上传。

Universal variant 减少发布变体，但增加 Runtime transcode、CPU peak 和首帧延迟。Performance variant 增加磁盘/CDN 组合，但缩短 Runtime 路径。二者可以同时存在于 variant table，由部署策略决定。

### 27.4 Offline Mip

Mip 必须在 Cook 阶段生成并验证：

- base-color 使用正确颜色空间过滤；
- normal map 过滤后重归一化；
- ORM 每通道保持线性语义；
- alpha MASK 使用 coverage-preserving threshold/scale；
- emissive 避免不必要 clipping；
- 纹理边界、wrap 和 atlas gutter 正确；
- 每级 byte range 可独立读取。

Runtime mip generation 只保留给明确的动态纹理、render target 或开发时输入，不是普通 Runtime Asset 路径。

### 27.5 Texture Size Class 与物理尺寸

如果继续使用 array bank，logical texture size 与 physical bank size 必须分别统计。Resize/补边会产生：

- 像素浪费；
- filter 质量变化；
- UV scale/bias；
- mip 边界行为；
- bank 内不同 logical size 的占用碎片。

V2 需要比较：

- 固定 size-class array；
- segmented immutable arrays；
- 多小 bank；
- atlas/page table；
- per-texture binding/有限 bind group 组合。

选择依据是 binding limit、grow copy、fragmentation、draw/shader binding 成本和 workload，而不是只看某一项容易实现。

### 27.6 Bank Grow 替代方案

候选方案：

1. 预估容量后一次创建；
2. immutable segment，满后增加新 segment；
3. 几何增长但延迟合并；
4. page table indirection；
5. background migration + stable descriptor table。

所有方案都必须维持 stable texture handle。增长时需要统计：

- bytes copied；
- copy operation count；
- old/new overlap peak；
- submission retirement latency；
- descriptor patch bytes；
- frame hitch。

## 28. Page Residency 与 Streaming 完整设计

### 28.1 分阶段定义

Streaming 在 V2 中分为三层：

1. **V2 Core Residency**：完整 asset/chunk 的异步加载、预算、稳定 handle；
2. **Evidence-triggered Partial Residency**：按 mip group 或 geometry page 加载；
3. **Long-term World Streaming**：空间分区、世界级调度、长期 cache。

第一层必须实现；第二层在 resident/load hitch 证据触发后实现；第三层需要扩大产品范围。

### 28.2 Page 设计

`.opack` page/chunk 需要考虑：

- IO range granularity；
- HTTP/cache 行为；
- Worker 解压粒度；
- GPU upload alignment；
- meshlet/texture mip locality；
- wasted tail bytes；
- request count；
- cancellation；
- checksum；
- residency table update。

Page size 不能凭经验固定。候选值需要在真实资源集上比较，例如 32、64、128、256 KiB 或更大块，并报告：

```text
requests
requested bytes
useful bytes
wasted bytes
decode jobs
upload commands
time-to-first-visible
peak CPU RAM
peak GPU transaction
```

### 28.3 Texture Streaming

Texture partial residency 可以按 mip group 表达：

```text
TextureHandle
    → descriptor table
    → resident mip range
    → physical segment/page
```

低 mip 可以作为最低常驻集合，高 mip 按 screen coverage 和预算请求。采样必须在 descriptor 中 clamp 可用 LOD，不能访问未驻留 mip。

需要处理：

- camera 快速接近；
- anisotropic sampling；
- normal/ORM/base-color 多纹理一致性；
- material 首次可用条件；
- request cancellation；
- eviction retirement；
- temporal pop 和 mip transition。

### 28.4 Geometry Streaming

Geometry Package 的 hierarchy、meshlet 和 page table 可以共同支持 partial residency：

- hierarchy node 记录所需 page group；
- coarse LOD/parent representation 先常驻；
- traversal 遇到未驻留 child 时停在可用 ancestor；
- GPU 输出 compact feedback，而不是 CPU 扫描所有 geometry；
- page 到达后 patch residency table；
- eviction 只发生在提交安全边界。

这使 Cluster Hierarchy 同时承担 visibility、LOD 和 residency availability，但不能让 hierarchy 变成世界 Gameplay 管理器。

### 28.5 GPU Visibility Feedback

GPU 可以输出小型、去重或近似去重的反馈：

```text
requested_page_id
priority_class
projected_error_or_coverage
last_visible_frame
```

反馈队列必须有 capacity 和 overflow。CPU 延迟读取并合并请求，不进行每帧同步等待。

优先级候选：

```text
priority = visibility confidence
         × projected coverage/error
         × material importance
         × camera motion prediction
         × age/starvation term
```

必须避免始终被近处高优先级请求饿死的 page，加入 age/hysteresis。

### 28.6 Streaming 生命周期

Page 状态至少包括：

```text
unrequested
requested
reading
decoding
ready-for-upload
uploading
resident
eviction-requested
retiring
failed
```

状态改变由明确 owner 驱动。Abort、device loss、资源销毁和 package invalid 必须有可恢复行为。

### 28.7 Streaming Budget

预算至少包括：

- IO bytes/s；
- concurrent requests；
- Worker decode ms/bytes；
- CPU staging bytes；
- GPU upload bytes/frame；
- resident target；
- transaction peak；
- eviction bytes/frame；
- feedback readback bytes/frame。

Streaming 不能通过突破 upload/readback 或 resident budget 来换取更快可见。

### 28.8 Virtual Texture

Virtual Texture 属于 Long-term Extension，但它不是从架构图中删除的未知项。WebGPU 下的候选是软件管理的 virtual-to-physical 映射，而不是假设底层 API 提供原生 sparse texture。

逻辑结构：

```text
virtual texture descriptor
    → virtual mip/page coordinates
    → GPU page table
    → physical tile cache/atlas
    → fallback mip tail
```

系统组件：

- virtual texture handle；
- page table texture/buffer；
- physical tile allocator；
- mip tail/always-resident fallback；
- shader address translation；
- feedback/request queue；
- Worker transcode/decode；
- upload/page-table patch；
- eviction/retirement；
- page border/gutter generation；
- cache and budget counters。

Shader 采样必须处理：

- virtual UV 到 page 坐标；
- mip selection；
- page border 以支持 filtering；
- anisotropic 跨 page；
- non-resident parent fallback；
- page table 更新的帧边界；
- sRGB、normal、ORM 等不同 semantic cache。

Virtual Texture 可能增加：

- 每次采样的 indirection；
- page table/cache binding；
- feedback 和 upload；
- border storage；
- shader variant；
- temporal mip/page pop。

它只在大纹理集导致 resident 预算或加载延迟无法通过压缩纹理、offline mip 和分段 Residency 解决时进入实现。第一轮 Texture Pipeline V2 必须先提供稳定 handle、variant、mip range 和 transaction accounting，使未来 VT 不需要修改 Material identity。

## 29. Queue Infrastructure V2

### 29.1 统一队列原语

Meshlet、Risky Triangle、Material Tile、SSR Ray、Streaming Feedback 等队列应共享设计原则，但不必强迫所有元素使用同一物理结构。

推荐 header：

```text
produced_count
accepted_count
capacity
overflow_count
dropped_count
generation
reserved0
reserved1
```

`produced_count` 可以超过 capacity 用于观察真实需求；写入索引只有在 `< capacity` 时有效。Correctness-critical queue 的 dropped 必须使 validation 失败。

### 29.2 Append 与 Compact

基础路径候选：

- 每线程 atomic append；
- workgroup local count + 单 atomic reservation；
- two-pass flag + prefix sum + scatter。

Subgroup accelerator 候选：

- ballot active lanes；
- subgroup-local prefix；
- 每 subgroup/workgroup 单次全局 reservation；
- contiguous scatter。

选择必须按元素大小、acceptance ratio、contention 和 dispatch 数验证。低接受率不一定适合两遍 prefix；高密度 append 不一定需要复杂 compact。

### 29.3 Indirect Command

GPU producer 负责生成最终 consumer 的 indirect 参数。CPU 只 encode bounded consumer pass/draw/dispatch，不读取 produced count 再循环发命令。

Indirect 参数必须 clamp 到 capacity，并区分：

- logical produced；
- physical accepted；
- consumer dispatched；
- padding invocation。

### 29.4 Queue Debug View

开发/验证模式可以展示：

- queue occupancy；
- overflow；
- bucket 分布；
- rejected reason；
- page request heatmap；
- material class tile；
- SSR ray density。

Debug view 关闭时不得保留 readback、额外 texture 或独立 submit。

## 30. Meshlet Bucket Raster 深化设计

### 30.1 为什么从 Triangle Work 转向 Meshlet Work

当前候选 triangle 在 Visibility 前可能经历：

```text
cluster/meshlet acceptance
    → per-triangle RasterWork
    → per-triangle ExactRasterWork
    → indirect hardware raster
```

V2 改为：

```text
meshlet acceptance
    → one MeshletRasterWork
    → one bucket entry
    → hardware raster expands local triangles
```

收益来源不是“Meshlet”名称，而是减少：

- queue record 数；
- prefix/scatter bytes；
- exact filtering 输入；
- VisibilityKey 指向的 frame-local table 容量；
- geometry metadata 重复；
- dispatch 间 buffer traffic。

代价包括：

- bucket padding；
- vertex shader 中 local triangle/index 展开；
- 较大 meshlet 的 culling granularity；
- risky triangle 分离；
- material homogeneous 约束；
- work record 随机访问。

### 30.2 Raster Shader 映射

对 triangle-list bucket，每个 meshlet instance 的 `vertex_index` 可以映射为：

```text
local_triangle = vertex_index / 3
corner = vertex_index % 3
```

当 `local_triangle >= meshlet.triangle_count` 时输出 clipped/invalid position，避免产生可见 primitive。有效路径读取 meshlet-local index，再读取 compact vertex。

该设计必须验证：

- 无效 padded vertex 不产生 fragment；
- primitive/local triangle identity 一致；
- strip/restart 等非目标 topology 在 Cook 阶段被转换或拒绝；
- indirect `instance_count` 与 bucket count 完全一致；
- first-instance 或等价映射跨 adapter 正确。

### 30.3 Material Homogeneity

VisibilityKey V2 不再携带 kernel class 的前提是 meshlet work 能恢复唯一 material slot/class。

Cooker 必须选择：

- 在 material boundary 拆 meshlet；或
- 一个 meshlet 含多个显式 subrange，并让 Raster Work 指向 subrange。

第一种简化 Runtime，但可能降低 meshlet 填充率；第二种增加 record 和 shader 复杂度。必须用真实多材质资产比较。

### 30.4 Risk 分类的层次

Risk classification 可以分层：

1. Cook-time static risk：degenerate、极端 aspect、material/raster flag；
2. Meshlet projection risk：near-plane、coverage、clip range；
3. Triangle projection risk：只对风险 meshlet展开；
4. TriangleSetup cache eligibility：大三角形或高复用候选。

这样避免所有普通 meshlet都做 per-triangle exact filter，同时保留保守正确性。

### 30.5 Large Triangle Shading Cache

TriangleSetup 不应简单删除。对于覆盖大量像素的大三角形，可以把它重新定位为 selective large-triangle cache：

- 缓存投影顶点和稳定重心重建系数；
- 避免每个像素重复读取/投影三个顶点；
- VisibilityKey 仍保持 meshlet + local triangle 语义；
- Work record 或辅助 lookup 标记 setup slot；
- 未命中时回退 canonical vertex reconstruction。

启用门槛候选基于 projected pixel coverage，但必须加入：

- setup build GPU 时间；
- setup bytes；
- hit pixel 数；
- reuse ratio；
- near-plane correctness；
- cache capacity/overflow。

不能只因单个大三角形更快就默认给所有三角形分配 setup。

### 30.6 VisibilityKey 到像素重建

Shading 侧根据 key：

```text
meshlet_work_slot
    → instance/geometry/meshlet/material/profile
local_triangle
    → meshlet-local three indices
    → compact vertices
    → barycentric reconstruction
    → SurfacePrep or full material evaluation
```

需要记录每像素 buffer load、vertex decode、setup hit 和 fallback 次数，用于判断 VisibilityKey V2 是否真正减少随机访问。

## 31. Geometry Path、LOD 与 Hysteresis

### 31.1 不是所有 Geometry 都走完整 Hierarchy

统一主管线不等于每个 geometry 必须执行相同深度的 hierarchy traversal。Cooker 可以为 asset 给出 path hint：

- flat/small geometry；
- shallow hierarchy；
- full hierarchy；
- streaming-aware hierarchy。

Runtime 根据显式 metadata 和 workload 选择同一 Work Generation Feature 内的局部路径，不建立第二个 Renderer。

### 31.2 Flat Path

Flat path 适合：

- meshlet 数很少；
- hierarchy node 成本高于直接 meshlet cull；
- geometry 长期完全可见；
- UI/debug/simple proxy 等明确对象。

Flat path 仍由 GPU 读取 instance/geometry table 并写 Meshlet Work queue。不能退化为 CPU 每帧遍历 meshlet。

### 31.3 GeometryWorkBudget

Geometry budget 控制：

- hierarchy nodes；
- clusters/meshlets tested；
- meshlet work produced；
- risky triangle expansion；
- bucket triangle/padding；
- geometry upload/residency；
- optional setup bytes。

预算输入可以影响 LOD/SSE threshold，但不得直接静默截断已经选择的可见 work。

### 31.4 Dynamic SSE

静态 SSE threshold 容易在负载变化时失控。V2 候选：

```text
next_threshold = clamp(
    current_threshold × response(measured_work / target_work),
    minimum,
    maximum
)
```

需要加入：

- 上升/下降不同速率；
- dead zone；
- camera velocity；
- camera cut reset；
- minimum quality floor；
- asset importance；
- deterministic fixed threshold benchmark mode。

### 31.5 Hysteresis

LOD、hierarchy path 和 residency 都需要 hysteresis：

- refine threshold 与 coarsen threshold 分离；
- 最小驻留帧数；
- request age；
- camera cut 时明确失效；
- 避免在 threshold 附近每帧切换；
- 记录 transition count 和 rejected transition。

Temporal 系统需要知道 LOD/geometry representation 变化，以调整 reactive/history confidence。

## 32. Compute Material Binning 与 Shading 深化设计

### 32.1 为什么不是直接把 Fullscreen Draw 改成 Compute

Compute Material 的目标不是机械地把 fragment shader 翻译成 compute shader。真正需要改变的是工作组织：

```text
当前候选模型
    active material class
        → fullscreen triangle
        → 每像素读取 Visibility/Class
        → discard 不匹配像素

V2 候选模型
    Visibility pixels
        → tile/class discovery
        → bounded class work
        → 只处理相关 tile/pixel
```

Compute 的潜在收益来自减少无效像素、复用 tile 数据和更灵活的输出，而不是 Compute 本身必然更快。

### 32.2 分类粒度候选

V2 保留三种候选粒度：

1. **Tile mask**：每个 tile 记录 class bitmask，每个 class 对相关 tile dispatch；
2. **Tile-class records**：只生成存在的 `(tile, class)`；
3. **Pixel worklist**：为每个 class 压缩有效 pixel。

比较维度：

| 方案 | 优点 | 代价 |
|---|---|---|
| Tile mask | 简单、有界、连续访问 | tile 内仍有 inactive lane |
| Tile-class records | 避免不存在的 class dispatch | queue/compact 成本 |
| Pixel worklist | 最少无效 pixel | 大 worklist、scatter、邻域/梯度困难 |

第一版从 tile mask 或 tile-class records 开始。只有 material diversity 和空 lane 证据足够高时才进入 pixel compaction。

### 32.3 Tile 大小

候选 tile 大小包括 `8×8`、`16×8`、`16×16`。选择需要平衡：

- workgroup threads；
- material class diversity；
- shared memory；
- Visibility/Depth locality；
- Surface/HDR write coalescing；
- 屏幕边界浪费；
- adapter occupancy。

Tile size 是 pipeline specialization，不进入公开 API。Artifact 必须记录实际 tile size。

### 32.4 材质 Kernel Class

Material class 不是每个材质一份 shader，而是有限功能组合，例如：

- opaque standard；
- MASK standard；
- normal mapped；
- ORM/textured；
- emissive；
- unlit；
- 后续扩展的特殊 shading model。

Class 数必须有上限。Texture presence、double-sided 等应尽量通过数据和 flags 表达，只有显著移除昂贵分支时才增加 class。

每个 material slot 在 `GpuMaterialStore` 中记录稳定 kernel class。Meshlet Work 可以缓存该 class，但 material patch 后必须保证 class 更新和 work generation 的 revision 一致。

### 32.5 Compute 中的 Barycentric 与梯度

Compute shader 不应假设 fragment implicit derivative。V2 必须显式解决：

- pixel center 到 projected triangle 的 barycentric；
- perspective-correct interpolation；
- UV gradient/LOD；
- normal/tangent interpolation；
- near-plane 和小三角形数值稳定性。

候选方式：

1. 从 projected triangle 解析 barycentric gradients；
2. LargeTriangle Setup 缓存 gradient；
3. workgroup 邻近像素共享 triangle 时计算 quad gradient；
4. 使用显式 texture LOD 的保守估计；
5. 对异常梯度使用 fallback 标记和计数。

验证必须覆盖 anisotropic/high-frequency texture、UV seam、mip transition 和 camera motion。若显式梯度质量明显低于 fragment path，Compute backend 不能仅凭较低 GPU 时间进入生产。

### 32.6 Texture Sampling

Compute Shading 的纹理访问需要与 Texture Residency V2 共同设计：

- material slot 恢复 texture handle；
- handle 经 descriptor table 定位 bank/segment/layer；
- descriptor 提供 logical/physical UV scale；
- streaming descriptor 提供 resident mip clamp；
- sampler 组合保持有界；
- normal/base-color/ORM residency 不一致时有确定性 fallback。

需要记录 texture samples、fallback samples、non-resident samples 和 material texture class。

### 32.7 Compute 输出策略

候选输出：

- storage texture；
- storage buffer，后续以纹理视图/转换消费；
- compact packed `u32`；
- render pass attachment 与 compute classification 混合。

选择依据：

- WebGPU format 可写性；
- per-stage storage binding limit；
- texture filtering requirement；
- 后续 AO/SSR sampling；
- layout/alignment；
- write combining；
- conversion Pass 成本。

禁止为了宣称“全 Compute”增加额外格式转换，最终总带宽和 GPU envelope 才是判断标准。

### 32.8 Material Classification Overflow

Tile-class/pixel queue overflow 不能丢材质像素。候选保守处理：

- capacity 按 resolution × bounded classes/tile 推导；
- overflow 设置 fatal validation counter；
- 开发时可以使用 full-screen fallback 仅用于发现容量问题；
- 生产预算必须在 encode 前保证 worst-case 或接受明确受限的 material class contract。

长期不能保留每帧“先试 Compute，overflow 再重画全屏”的双倍路径。

## 33. SurfaceLite、HDR 与带宽模型深化设计

### 33.1 当前 Surface 成本

当前完整 color Surface 在 velocity 开启时是 26 B/pixel：

| 语义 | Bytes/pixel |
|---|---:|
| PBR | 2 |
| Normal | 8 |
| Albedo/AO | 4 |
| Emissive | 4 |
| Velocity | 4 |
| Metadata | 4 |
| 合计 | 26 |

1920×1080 下：

```text
2,073,600 pixels × 26 bytes
= 53,913,600 bytes
≈ 51.42 MiB
```

仅一次完整写入和一次完整读取的理论流量已经约 102.84 MiB/frame。实际还包括 attachment store/load、cache miss、Depth、Visibility、HDR、AO、SSR 和 history。

其中 8 B/pixel 的 normal 是最值得重新设计的单项，但不能在未验证 AO/SSR 精度前直接删除。

### 33.2 SurfaceLite Profile 候选

本文冻结语义，不立即冻结格式。候选 profile：

#### Profile A：8 B/pixel balanced

```text
normal                 4 B
roughness/metal/flags  4 B
```

#### Profile B：4 B/pixel compact

```text
packed normal          2–3 B equivalent
roughness/flags        remaining bits
```

#### Profile C：No persistent normal

```text
Depth + VisibilityKey only
SSR/AO reconstruct on demand
```

Profile C 带宽最低，但会重复 geometry/material work，且可能破坏 normal-map-aware AO/SSR。它属于研究候选，不作为默认结论。

### 33.3 SurfaceLite 字段分配原则

每个字段必须回答：

1. 哪个下游 consumer 需要；
2. 是否可以从 Depth/Visibility 重建；
3. 重建需要多少随机读取和 ALU；
4. 是否影响 temporal stability；
5. feature-off 后字段能否裁剪；
6. 是否需要过滤；
7. 精度误差是否可见。

例如：

- albedo 只被 Lighting 使用一次，优先不持久化；
- emissive 同理，直接进入 HDR；
- roughness 被 SSR/denoise 使用，适合保留；
- normal 被 AO/SSR/denoise 使用，适合紧凑保留或按质量重建；
- material slot 若只用于 debug，可按 debug feature 创建单独输出；
- velocity/reactive 属于 temporal contract，不与基础 SurfaceLite 强耦合。

### 33.4 Material + Lighting Fusion 的准确含义

Fusion 表示完整材质参数不先写入完整 Surface 再被 Lighting 读回：

```text
Visibility + Material + Geometry
    → full material evaluation
    → BRDF/direct/IBL/emissive
    → HDR
```

SurfacePrep 只提前产生 AO/SSR 所需最小字段。若某实现先写出完整 albedo、emissive、normal、ORM，再运行 Lighting，即使它叫 Compute Shading，也没有完成 Fusion。

### 33.5 ShadeLighting 内部阶段

逻辑过程：

1. 恢复 visible primitive；
2. canonical vertex interpolation；
3. texture/material sampling；
4. normal mapping；
5. material model evaluation；
6. shadow/direct lighting；
7. environment/IBL；
8. AO/indirect visibility；
9. emissive/unlit；
10. pre-exposure；
11. HDR write；
12. SurfaceLite final field write；
13. counters。

Direct 和 indirect 是否在同一 dispatch 内完成由 light list、shadow bindings 和 storage limit 决定。若拆分，仍应避免重复完整 material evaluation，可以保存紧凑中间或让第二阶段只消费 HDR/SurfaceLite。

### 33.6 Pre-Exposure

Pre-exposure 由前一稳定曝光值或显式 camera exposure 缩放 HDR：

```text
pre_exposed_color = scene_referred_color × pre_exposure
```

需要统一：

- Lighting 输出；
- emissive；
- transparent shading；
- SSR/history；
- bloom threshold；
- exposure update；
- tone mapping；
- debug capture。

Camera cut、曝光突变和 history rescale 必须有显式处理。不能让不同 Feature 各自假设 HDR 是否 pre-exposed。

### 33.7 R11G11B10 与 RGBA16F

`r11g11b10ufloat` 的潜在优势是 4 B/pixel，而 `rgba16float` 为 8 B/pixel。选择前必须解决：

- 是否需要 alpha；
- format 是否同时满足当前写入和读取用途；
- 无负值表达是否影响中间算法；
- 高亮、bloom 和 temporal 精度；
- transparent composite；
- adapter capability/fallback；
- screenshot/数值差异。

若某阶段需要负值或额外 alpha，应使用独立 compact field 或 fallback format，不能无说明 clamp。

## 34. AO V2 完整设计

### 34.1 当前链路的保留价值

当前 AO 已经包含 linear depth、half-resolution raw、spatial、temporal 和 full-resolution joint resolve。V2 不否定其算法基础，优化重点是：

- normal 输入合同；
- Shared Depth 复用；
- full-resolution 展开是否必要；
- bent normal 是否有真实 consumer；
- temporal/history 格式；
- sample/ray budget。

### 34.2 AO V2 数据流候选

```text
Depth/HZB + SurfaceLite normal
    → half/internal AO trace
    → spatial filter
    → temporal accumulation
    → compact AO history
    → ShadeLighting or indirect composite
```

如果 AO 必须在 ShadeLighting 前提供给 IBL，则 SurfacePrep 先产生 normal。如果 AO 改为 ShadeLighting 后独立调制，需要区分 direct/indirect lighting，不能把 AO 无差别乘到最终 HDR。

### 34.3 Normal 模式

AO 允许三种质量模式，但共享同一 Feature：

- geometric：Depth reconstruction；
- vertex：SurfacePrep 插值 normal；
- material-aware：SurfacePrep 包含 normal map。

它们是算法参数/输入选择，不是三条主管线。默认模式由质量和性能证据决定。

### 34.4 Bent Normal

只有 IBL/GI consumer 实际使用 bent normal 时才生成并保存。若生成：

- 使用 compact encoding；
- resolution 与 AO 一致或明确 upscale；
- temporal validity 与 AO 共享；
- feature-off/consumer-off 完全裁剪。

### 34.5 Full-Resolution Resolve

V2 优先让 Lighting 或后续消费者直接采样 half/internal AO，通过 depth/normal aware lookup 获取结果。只有下游确实需要 full-resolution AO texture 时才执行 joint bilateral resolve。

需要 A/B：

- 直接低分辨率采样；
- on-the-fly bilateral lookup；
- full-resolution resolved texture。

总成本包含 resolve 写入和所有 consumer 读取。

### 34.6 AO Budget

Budget 控制：

- internal resolution；
- directions/steps；
- radius；
- temporal history weight；
- spatial filter radius；
- bent-normal enable。

质量下限和切换 hysteresis 必须固定。Artifact 记录每帧实际配置。

## 35. SSR、Pyramid 与 Exposure 完整设计

### 35.1 SSR V2 目标链路

```text
Depth/HZB + SurfaceLite + HDR/Color Pyramid
    → classify reflective tiles/pixels
    → compact ray work
    → hierarchical trace
    → hit validation
    → spatial resolve/denoise
    → temporal accumulation
    → roughness-aware upscale/composite
```

该设计吸收 FidelityFX SSSR 一类成熟实现的 tile classification、ray list、hierarchical traversal 和 denoise 思路，但具体移植必须先进入 `docs/porting/`，记录源码、commit、许可证、不变量和 WebGPU 差异。

### 35.2 SSR Classification

分类输入：

- surface validity；
- roughness；
- normal/view relation；
- material reflection flags；
- depth range；
- screen edge；
- resolution/budget。

输出 ray queue，必须遵守统一 Queue ABI。Roughness 高或贡献低的像素可以走环境 reflection，不生成 SSR ray。

### 35.3 Hierarchical Trace

Trace 使用共享 min/max depth hierarchy。需要验证：

- reverse-Z；
- thickness；
- near/far plane；
- edge crossing；
- mip selection；
- maximum steps；
- hit confidence；
- off-screen fallback。

每条 ray 记录聚合 counters，不保存昂贵 per-ray debug 数据，除非显式 capture。

### 35.4 Shared Pyramid

V2 的 `ImagePyramid` 不是长期全局对象，而是 MainRenderPipeline 中按 consumer demand 构建的 FrameProduct：

```text
Depth producer
    → HZB variants demanded by visibility/AO/SSR

HDR producer
    → color/luminance mips demanded by SSR/exposure/bloom
```

可以使用 SPD 风格 single-dispatch/multi-mip reduction，也可以使用多个简单 dispatch。选择依据：

- mip 数；
- storage bindings；
- workgroup memory；
- subgroup availability；
- texture format；
- 小分辨率 dispatch overhead；
- 总 GPU envelope。

### 35.5 Pyramid 生命周期与别名

Depth/Color pyramid 必须明确：

- base mip 是否 alias 原始产品；
- min、max、average、luminance 的 reduction semantic；
- 每个 consumer 要求的 mip 数；
- resolution change 重建；
- feature-off 裁剪；
- transient alias 是否安全。

不能让 SSR 私自重建一份与 Occlusion/AO 相同语义的 HZB。

### 35.6 Exposure

Exposure 优先从 luminance pyramid 的低 mip 或局部 histogram 获得，而不是再次扫描 full-resolution HDR。

候选：

- pyramid average/log luminance；
- workgroup histogram；
- subgroup-local histogram + global merge；
- percentile/trimmed luminance。

需要处理：

- 极亮 emissive；
- 小面积高光；
- UI/overlay 排除；
- camera cut；
- adaptation speed；
- pre-exposure history rescale。

## 36. Temporal Reconstruction 完整设计

### 36.1 从 TAA 到 Temporal Reconstruction

V2 将 Temporal 视为 internal resolution 到 output resolution 的重建系统，而不仅是抗锯齿 Pass。

输入：

- internal HDR；
- Depth；
- Velocity；
- Reactive；
- Surface validity；
- disocclusion/occlusion confidence；
- exposure/pre-exposure；
- camera jitter/matrices；
- history color/depth/confidence；
- geometry/LOD representation change。

输出：

- output-resolution HDR/LDR 前结果；
- next history；
- confidence/debug；
- optional sharpen input。

### 36.2 History Validation

History rejection 至少检查：

- out-of-bounds reprojection；
- depth disagreement；
- normal disagreement，若可用；
- surface validity/material class change；
- reactive/transparency；
- camera cut；
- resize；
- exposure discontinuity；
- LOD/page/geometry representation change。

需要记录 accepted/rejected reason counters，而不是只有总 acceptance。

### 36.3 History Compression

候选压缩：

- 更紧凑 HDR history format；
- luma/chroma 分离；
- compact moments/variance；
- confidence/lock 合并；
- depth lower precision；
- half/internal resolution 辅助 history。

每种压缩必须验证静态细节、subpixel motion、高亮、暗部、透明、SSR 和曝光变化。History 预算下降不能以持续 ghosting/shimmer 为代价。

### 36.4 Temporal Upscaling

V2 允许 internal resolution 小于 output resolution。Upscaler 负责：

- jitter sequence；
- reconstruction filter；
- history sample；
- neighborhood clamp；
- reactive/disocclusion；
- sharpening；
- resolution transition。

不预先指定必须复制某个外部 TSR/FSR 实现。采用外部算法前遵守 porting/provenance，并验证 WebGPU binding、workgroup、format 和质量差异。

### 36.5 Camera Cut 与 Resize

Camera cut：

- 立即失效相关 history；
- 清除 lock/confidence；
- 重置或平滑 exposure；
- 不产生额外 submit；
- evidence 标记 cut frame，正式稳定样本排除规则明确。

Resize/internal scale change：

- history 可以丢弃或重投影，但策略必须确定；
- old resources 在提交边界 retirement；
- transient/history bytes 记录峰值；
- 不同时保留无界多尺寸 history。

## 37. Transparency V2 完整设计

### 37.1 为什么不立即统一重写

Transparency 的最佳算法高度依赖内容。简单玻璃、粒子、头发、烟雾、折射和大量层叠透明的需求不同。当前 workload 中透明占比不足以证明它应早于 Geometry、Texture、Surface。

因此 V2 完整定义分类方向，但将生产替换设为 Evidence-triggered。

### 37.2 内容分层

| 类别 | 候选路径 | 关键语义 |
|---|---|---|
| simple alpha | sorted/forward | 少层、顺序可控 |
| particles/foliage | weighted blended | 大量低成本近似 |
| layered translucent | moment-based/OIT | 层叠稳定性 |
| refractive | dedicated forward/composite | scene color/depth sampling |
| additive | direct HDR accumulation | 无排序或弱排序 |

分类由 material asset metadata 决定，不允许运行时通过对象类型猜测。

### 37.3 Reactive 与 Temporal

所有透明路径必须输出统一 reactive/coverage 语义，供 Temporal Reconstruction 使用。需要处理：

- 新出现/消失透明；
- 折射导致的背景运动；
- 粒子 alpha 变化；
- OIT resolve；
- pre-exposed HDR；
- internal/output resolution。

### 37.4 与 Compute Shading 的关系

不透明 Visibility/Compute Shading 不强迫透明也使用同一 Material Binning。透明可以继续硬件 forward/OIT，但共享：

- GpuMaterialStore；
- Texture Residency；
- Light/Shadow/Environment；
- pre-exposure；
- MainRenderPipeline；
- temporal signals；
- one main submit。

## 38. Shadow Architecture V2

### 38.1 当前阶段

Directional CSM 继续是 V2 Core 的可用 shadow 路径。第一轮优化重点是：

- shared geometry residency；
- meshlet work reuse 或 shadow-specific GPU work；
- shadow update budget；
- static/mostly-static cache；
- atlas resident/transient accounting；
- feature-off 裁剪。

### 38.2 Virtual Shadow Atlas

Virtual Shadow Atlas/VSM 属于 Long-term Extension，但完整接入关系如下：

```text
Light/View demand
    → virtual page request
    → page residency/cache
    → meshlet shadow work
    → physical atlas pages
    → page table
    → ShadeLighting sampling
```

需要定义：

- virtual page ID；
- physical page allocator；
- per-light page table；
- request/dirty/render queue；
- static/dynamic invalidation；
- cache lifetime；
- overflow/fallback；
- shadow page budget；
- camera/light movement hysteresis。

VSM 必须复用 Queue/Residency/Budget 原语，不能建立独立隐藏 scheduler 和 submit。

### 38.3 Static/Dynamic 分离

Mostly-static 产品方向适合将 shadow caster 分为：

- static cacheable；
- transform-patched dynamic；
- material/alpha-changing；
- always-dynamic。

静态和动态可以在 page/atlas 更新中分开，避免小型动态对象让大面积静态 shadow 失效。但分类必须来自 SceneChangeSet/material revision，而不是每帧扫描对象。

### 38.4 Contact Shadows

Contact Shadow 是补充小尺度接触和远处低成本细节的 Evidence-triggered Feature：

- 使用 Depth/HZB；
- 屏幕空间 bounded steps；
- 与主 shadow visibility 组合；
- 只影响设定距离/光源；
- 有 sample budget；
- temporal/noise 策略明确。

它不能替代大尺度 CSM/VSM，也不能无条件常开。

## 39. GI、Specular AA 与 Volumetric 完整设计

### 39.1 GI 接口

V2 保留统一 indirect lighting 输入：

```text
IndirectLightingProduct
    diffuse irradiance
    specular environment/reflection
    confidence/validity
    optional bent-normal visibility
```

当前 LPV/IBL 或后续 probe/SSGI 可以实现该产品，但不各自绕过 ShadeLighting 建立主管线。

### 39.2 Sparse Probe GI

Sparse Probe GI 属于 Long-term Extension。设计关系：

- probe volume/clipmap residency；
- update queue；
- visibility/ray source；
- irradiance/history；
- camera movement；
- scene change invalidation；
- GPU update budget；
- static/dynamic contribution。

它需要明确数据来源和更新闭环，不能只有一个可采样 atlas 而没有受预算控制的 producer。

### 39.3 Screen-Space GI

SSGI 可以复用：

- Depth/HZB；
- SurfaceLite normal；
- HDR/color pyramid；
- SSR-style ray classification；
- temporal denoise。

它与 SSR 共享很多基础设施，但 diffuse/specular estimator、history 和 composite 语义不同。共享代码不能导致错误复用同一个 history 或把 GI 成本隐藏在 SSR phase。

### 39.4 Specular Anti-Aliasing

Specular AA 是成本较低、可较早实验的 quality candidate：

- 使用 normal variance/derivative 调整 roughness；
- 可在 SurfacePrep 或 material evaluation 中完成；
- 不需要独立 Pass；
- 必须验证 normal map、微表面高光、运动和 temporal；
- feature-off 只移除局部 shader work。

它不应强行常开，需证明 ALU 与质量收益。

### 39.5 Volumetric Fog

Volumetric Fog 属于 Long-term Extension。候选 froxel pipeline：

```text
froxel grid
    → density/material injection
    → light/shadow injection
    → scattering integration
    → temporal reprojection
    → HDR composite
```

需要定义：

- froxel resolution/depth slicing；
- light list；
- shadow sampling；
- temporal history；
- camera cut；
- memory/sample budget；
- transparency interaction；
- feature-off 完全裁剪。

它必须进入 MainRenderPipeline 和统一 Budget，不拥有独立 submit。

## 40. Content-Adaptive Resolution 与 Software VRS

### 40.1 Resolution Domain

V2 不把所有 Feature 限定为 `0.5 | 1.0`。FrameContext 可以发布有限、可缓存的 resolution domain：

- output resolution；
- internal shading resolution；
- half/quarter effect resolution；
- tile/froxel dimensions；
- history resolution。

每个 Feature 必须声明自己消费和输出的 domain。任意每帧浮点比例会破坏 graph cache 和 history，因而 dynamic scale 应从有限档位选择并带 hysteresis。

### 40.2 Content-Adaptive Resolution

SSR、AO、Shadow update 等可以依据内容调整：

- roughness；
- projected size；
- motion；
- depth complexity；
- history confidence；
- ray/sample budget；
- GPU frame pressure。

第一阶段只允许 per-feature 有限档位，不立即允许每 tile 任意分辨率。更细粒度方案必须证明 worklist 和边界处理成本。

### 40.3 Software Shading Rate

Visibility Buffer 为 software shading rate 提供可能：多个 output pixel 可以共享较低频率的材质/光照结果，再进行 edge-aware reconstruction。

候选分类依据：

- depth/normal discontinuity；
- material ID；
- motion；
- roughness；
- luminance contrast；
- reactive/transparency；
- foveation/importance，可选。

候选 rate：

```text
1×1
2×1 / 1×2
2×2
4×4 (only very low-frequency regions)
```

### 40.4 Shading Rate Work

需要产生：

- tile shading rate map；
- representative sample/worklist；
- edge/invalid mask；
- reconstruction inputs；
- rate distribution counters。

它必须与 Material Classification 合并或明确串联，不能再创建一套完全独立的 pixel classifier。

### 40.5 软件 VRS 风险

- 小几何和 subpixel detail 消失；
- material/normal discontinuity 泄漏；
- specular highlight 破坏；
- motion/temporal ghosting；
- reactive/透明边缘错误；
- classification 和 reconstruction 抵消 shading 节省。

因此 Software VRS 位于 Surface/Temporal 稳定后的 Evidence-triggered 阶段。

## 41. Post Pipeline V2 完整设计

### 41.1 目标

Post V2 通过共享低分辨率产品和相邻算子融合降低 HDR/LDR 往返，不以把所有效果塞进一个不可维护 shader 为目标。

候选逻辑链：

```text
pre-exposed HDR
    → temporal reconstruction
    → exposure/bloom composite
    → tone mapping
    → color grading LUT
    → output transfer/gamut
    → optional sharpen/grain/dither
```

Motion Blur 如启用，需要在 temporal/output domain、velocity 和 reactive 的顺序上单独设计，不能被模糊地归入 fused post。

### 41.2 Bloom

Bloom 可以复用 luminance/color pyramid：

- prefilter threshold 使用 pre-exposed semantic；
- downsample 与 shared pyramid 合并候选；
- upsample 可以逐级或在有限级合并；
- composite 可以与 tone mapping 前阶段融合；
- bloom-off 不构建专属 mip/Pass。

必须验证高亮能量、半径、边缘、分辨率和 temporal 闪烁。

### 41.3 Color Grading LUT

LUT 候选替代大量逐像素解析曲线：

- 3D LUT 或等价 2D layout；
- working color space 明确；
- tone-map 前后顺序明确；
- capability/format/filter 支持；
- identity LUT feature-off；
- LUT 更新频率和 upload budget。

静态 identity grading 不应分配 LUT 或增加采样。

### 41.4 Fusion 边界

适合融合：

- tone mapping + grading + output transfer；
- bloom final composite + tone mapping；
- simple sharpen/dither + output。

不适合盲目融合：

- 需要独立 resolution/history 的 temporal；
- 多级 bloom reduction；
- 需要 debug capture 的关键中间；
- feature variant 导致组合爆炸的效果。

每次融合必须比较 shader variant、pipeline creation、bandwidth、GPU phase 和 feature-off graph。

## 42. FrameBudgetController 完整设计

### 42.1 角色

`FrameBudgetController` 是预算决策逻辑，不是新的 FrameGraph、Renderer 或资源 owner。它读取延迟 evidence/state，向下一帧 FrameContext 提供有界决策：

```text
GeometryBudget
ResidencyBudget
ShadowBudget
EffectBudget
ResolutionBudget
```

各 Feature 仍拥有自己的算法和资源。

### 42.2 输入

- true GPU frame envelope；
- phase P50/滑动统计；
- CPU frame/encode；
- queue occupancy/overflow pressure；
- resident/transient/history/transaction；
- camera velocity/cut；
- visible coverage；
- material/transparent complexity；
- AO/SSR ray count；
- streaming request age；
- user quality floor/target frame time。

### 42.3 输出

- geometry SSE/LOD 档位；
- maximum work/risky/setup；
- texture/geometry upload allowance；
- residency eviction target；
- AO/SSR resolution/sample 档位；
- shadow update/page allowance；
- internal resolution 档位；
- optional software shading rate aggressiveness。

### 42.4 控制频率

不是所有预算都每帧变化：

- hard queue/memory safety 每帧执行；
- resolution/effect quality 低频调整；
- residency scheduler 按 request/completion 事件调整；
- exposure 由图像算法调整但向 Temporal 发布；
- static scene 可以更慢地调整 hierarchy/streaming。

### 42.5 Hysteresis 和优先级

Controller 必须定义：

- target 和 emergency threshold；
- degradation order；
- recovery order；
- minimum hold frames；
- cooldown；
- camera cut override；
- starvation prevention；
- fixed benchmark mode。

降级和恢复顺序不必完全对称，避免质量来回跳变。

### 42.6 不能控制的事项

Controller 不得：

- 忽略 correctness-critical queue overflow；
- 通过跳过可见对象满足时间；
- 突破内存 hard limit；
- 改变 ABI；
- 在运行时创建另一条管线；
- 用同步 readback 阻塞 GPU；
- 隐藏实际使用的质量档位。

## 43. End-to-End 场景推演

### 43.1 首次加载大型静态场景

```text
Manifest fetch
    → select Geometry/Texture variants
    → Worker decode canonical payload
    → reserve resident/upload transaction
    → coarse geometry + low texture mips first
    → publish stable handles
    → GpuRenderWorld bulk scene upload
    → MainRenderPipeline visibility
    → delayed feedback requests detail
```

需要观察 time-to-first-visible、CPU/GPU peak、upload bytes、pipeline warm-up 和首批缺失资源 fallback。

### 43.2 相机快速接近高密度模型

```text
coverage/error rises
    → hierarchy requests finer LOD/page
    → GeometryWorkBudget prevents spike
    → streaming priority rises
    → available ancestor remains renderable
    → page completion patches residency
    → temporal receives representation change
```

不得让 CPU 同步等待 page，也不得突然提交无界 meshlet work。

### 43.3 多材质复杂画面

```text
VisibilityKey V2
    → tile class masks
    → bounded material work
    → SurfacePrep
    → AO
    → class-based ShadeLighting
```

观察 class diversity、inactive lanes、texture samples、material evaluations、binding/pipeline 切换和 Surface bytes。

### 43.4 Effects Full 场景

```text
Depth
    → shared HZB
SurfaceLite + HDR
    → AO/SSR shared inputs
HDR pyramid
    → SSR + Exposure + Bloom
Transparency reactive
    → Temporal Reconstruction
```

观察 shared product 是否真正减少重复构建，以及 consumer-off 时图是否裁剪。

### 43.5 Capability 较低的 adapter

```text
no subgroup / no f16 / limited formats
    → standard workgroup queues
    → f32 arithmetic
    → baseline SurfaceLite/HDR format
    → compatible texture asset variant
```

逻辑 VisibilityKey、FrameProducts、主 pipeline 和验证用例保持一致。

## 44. 完整优化优先级与组合关系

### 44.1 S0：性能事实

1. GPU frame envelope；
2. phase 拆分；
3. amplification counters；
4. 内存/transaction/CPU RAM；
5. 固定 workload 和 artifact。

这是所有后续工作的裁判，不能被其他实现跳过。

### 44.2 S1：GPU-native Asset 基础

1. Texture Package V2；
2. offline mip；
3. GPU compression variants；
4. Texture Residency V2；
5. Geometry Package V2；
6. canonical compact vertex；
7. meshlet/hierarchy metadata；
8. Worker/load transaction accounting。

其中纹理与几何可以拆成独立垂直切片，但必须共享 package/variant/lifecycle 设计。

### 44.3 S2：Geometry Frontend

1. Meshlet Work ABI；
2. bucket queue；
3. risky/exact selective path；
4. VisibilityKey V2；
5. LargeTriangle Setup candidate；
6. flat/hierarchy path；
7. GeometryWorkBudget/hysteresis。

### 44.4 S3：Compute Shading

1. material tile classification；
2. explicit barycentric/gradient；
3. current Surface 输出的 A/B；
4. SurfacePrep；
5. SurfaceLite；
6. single material evaluation + lighting；
7. pre-exposed compact HDR。

### 44.5 S4：Bandwidth Effects

1. Shared Depth Products；
2. AO normal/resolve 优化；
3. Shared Color/Luminance Pyramid；
4. SSR ray classification/denoise；
5. Exposure reduction；
6. Temporal Reconstruction/history compression；
7. Bloom/Post fusion。

### 44.6 S5：内容与预算扩展

1. selective transparency；
2. Contact Shadow；
3. content-adaptive resolution；
4. software shading rate；
5. unified FrameBudgetController；
6. partial texture/geometry residency。

### 44.7 S6：长期高级能力

1. Virtual Shadow Atlas/VSM；
2. Sparse Probe GI；
3. SSGI；
4. Volumetric Fog；
5. world-scale streaming；
6. 由硬件路径证据触发的 Software/Hybrid Raster。

这些能力在本文拥有完整接入设计，但不阻塞 V2 Core 的成立。

### 44.8 组合顺序原则

不能按三个来源文档顺序逐本实现。正确组合顺序是：

```text
Performance Truth
    ↓
Asset/Geometry/Texture ABI
    ↓
Compact Runtime Data
    ↓
Meshlet Visibility Frontend
    ↓
Compute Material Classification
    ↓
SurfaceLite + Lighting
    ↓
Shared Effects + Temporal/Post
    ↓
Budget/Streaming/Advanced Features
```

这样避免 Geometry ABI、VisibilityKey 和 Surface consumer 被重复迁移。

### 44.9 七大性能系统评分表

输入文档提出按完整系统而不是零散 Pass 评价性能。V2 采用以下统一评分维度：

| 系统 | 时间指标 | Work 指标 | 内存/IO 指标 | 正确性/质量 |
|---|---|---|---|---|
| Asset Ingest | parse/decode/transcode/cook/load | jobs/chunks/variants | disk/network/CPU peak | package determinism、semantic parity |
| Residency | upload/evict/hitch | requests/pages/transactions | resident/allocated/retiring/peak | missing/fallback correctness |
| Geometry Frontend | cull/work/exact/raster phase | node/meshlet/triangle/padding | queue/geometry bytes | visibility、near-plane、overflow |
| Material/Shading | classify/prep/lighting phase | tiles/pixels/evaluations/samples | Surface/HDR traffic | material/BRDF/image parity |
| Effects | AO/SSR/shadow/GI phase | rays/steps/samples/pages | transient/history | stability、noise、漏光/伪影 |
| Temporal/Post | temporal/exposure/post phase | accepted/rejected/history | history/output traffic | ghosting、shimmer、色彩 |
| Frame Control | CPU/GPU envelope/submit | budget decisions/oscillation | total budgets/readback | quality floor、determinism |

微优化只有在能够改善某个评分维度且不破坏系统指标时才进入。例如减少一条 ALU 指令不是独立里程碑；改变数据布局、减少 material evaluation 或消除大块 attachment traffic 才属于优先事项。

### 44.10 Architecture Enabler、Hot Path、Residency 和 Micro 分类

所有候选在排期时标记为：

- **Architecture Enabler**：Performance Truth、ABI、stable handle、shared FrameProduct；
- **Hot-path Optimization**：Meshlet Work、Material Classification、Surface/Lighting fusion；
- **Residency/Memory Optimization**：compression、offline mip、segmented/page residency、history format；
- **Quality/Scalability**：Temporal、VRS、VSM、GI、dynamic budgets；
- **Micro Optimization**：局部 arithmetic、branch、packing、shader instruction。

Enabler 不一定直接让帧更快，但必须说明它解锁哪一个可验证优化。Micro 项只有 profiler 证明命中热点后执行。

## 45. 三份输入文档内容映射

这一节用于确认合并过程没有通过“暂缓实施”删除设计内容。

### 45.1 `性能优化重构1.md`

| 原始主题 | 本文位置 |
|---|---|
| 目标 GPU 管线 | 第 2、6、14、23 节 |
| Triangle Work amplification | 第 3、9、30 节 |
| Meshlet Bucket Raster | 第 9、30 节 |
| ExactTriangleFilter 选择性化 | 第 9.6、30.4 节 |
| MaterialClassDepth/N×Fullscreen | 第 10、32 节 |
| Tile-Class Compute Shading | 第 10、32 节 |
| VisibilityKey V2 | 第 9.7、30.6 节 |
| 通用 Vertex 解码迁出热路径 | 第 8、26 节 |
| Canonical GPU Vertex Format | 第 8.4、26 节 |
| 26 B/pixel Surface | 第 11、33 节 |
| Surface ABI V2/SurfaceLite | 第 11、33 节 |
| Geometry flat/hierarchy path | 第 31 节 |
| GeometryWorkBudget/SSE/Hysteresis | 第 16、31、42 节 |
| Effects pipeline 瘦身 | 第 12、13、34–41 节 |
| Software VRS | 第 40 节 |
| TriangleSetup/LargeTriangle cache | 第 9.6、30.5 节 |
| Loader/Cook 配合 | 第 8、25–28 节 |
| 保留统一主管线 | 第 3、5、19 节 |
| Performance Truth | 第 7 节 |
| 阶段与验收 | 第 17、18、44 节 |

### 45.2 `性能优化重构v2.md`

| 原始主题 | 本文位置 |
|---|---|
| RGBA8 与 4K texture 成本 | 第 27.1 节 |
| GPU Block Compression | 第 27.2 节 |
| glTF 是 Import Format | 第 8、25 节 |
| Asset Cooker/Runtime OAsset | 第 25 节 |
| Canonical GPU Vertex | 第 8.4、26 节 |
| WebGPU 2026 High Profile | 第 24 节 |
| primitive-index | 第 24.6 节 |
| subgroup queue | 第 24.4、29 节 |
| shader-f16 | 第 24.5 节 |
| Meshoptimizer | 第 26.4 节 |
| Draco | 第 26.5 节 |
| Quantization/Reorder/Meshlet synergy | 第 26.2、26.3、26.6 节 |
| KTX2 universal/performance variant | 第 27.3 节 |
| Offline Mip | 第 27.4 节 |
| TextureResidency/Bank Grow | 第 27.5、27.6 节 |
| Virtual Texture | 第 28.8 节 |
| Texture/Geometry Streaming | 第 28 节 |
| Hierarchy 驱动 Streaming | 第 28.4 节 |
| GPU Streaming Feedback | 第 28.5 节 |
| `.opack` page | 第 25、28.2 节 |
| Web Worker | 第 25.7 节 |
| RAM/Peak Memory/Ownership | 第 25.8、28.6 节 |
| 七大系统与优先级 | 第 44 节 |
| FrameBudgetController | 第 42 节 |
| Multi-Draw 定位 | 第 24.6 节 |

### 45.3 `性能优化重构3.md`

| 原始主题 | 本文位置 |
|---|---|
| Visibility-Driven Compute Hybrid Renderer | 第 2、6、14 节 |
| 重 Surface/GBuffer 问题 | 第 11、33 节 |
| Material Resolve + Lighting fusion | 第 11.4、33.4、33.5 节 |
| SurfaceLite | 第 11、33 节 |
| Normal 8 B/pixel | 第 33.1 节 |
| High Profile | 第 24 节 |
| R11G11B10 HDR | 第 11.5、33.7 节 |
| Pre-Exposure | 第 11.5、33.6 节 |
| AO V2 | 第 34 节 |
| SSR V2/SSSR | 第 35 节 |
| Shared Derived Products | 第 12、35.4、35.5 节 |
| SPD Pyramid | 第 12.3、35.4 节 |
| Exposure | 第 35.6 节 |
| Temporal Reconstruction/Upscaler | 第 36 节 |
| Reactive/History compression | 第 36.1–36.3、37.3 节 |
| Selective Transparency | 第 37 节 |
| Virtual Shadow Atlas/VSM | 第 38.2 节 |
| Contact Shadows | 第 38.4 节 |
| GI/SSGI | 第 39.1–39.3 节 |
| Specular AA | 第 39.4 节 |
| Volumetric Fog | 第 39.5 节 |
| Content-Adaptive Resolution | 第 40.1、40.2 节 |
| Software VRS | 第 40.3–40.5 节 |
| Post Fusion/Color Grading LUT | 第 41 节 |
| Fixed Work Budget | 第 42 节 |
| 最终完整 Frame | 第 14、43 节 |

### 45.4 映射规则

“进入长期阶段”不等于删除；它表示：

- 目标架构中有明确位置；
- 与现有系统的输入/输出关系已经说明；
- 生命周期和预算要求已经说明；
- 第一轮实现不因此扩大产品范围；
- 触发后仍必须经过 ADR、porting 和验证门禁。

后续修改三份来源分析时，应同步更新本映射；正式 ADR 接受后，来源分析可以归档，但本设计中的完整主题不能无记录消失。

## 46. 外部实现、论文与规格研究清单

### 46.1 使用原则

本文提到的外部项目是算法、行为或性能参考，不自动成为 Runtime dependency，也不代表已经接受移植。

每项在实现前必须进入以下四种状态之一：

1. 直接依赖；
2. 可追溯局部移植；
3. 按论文/规格独立实现；
4. 拒绝采用。

记录内容至少包括 upstream repository、commit/tag、源码路径、许可证、保留不变量、OEngine/WebGPU 差异、增加的资源/dispatch/branch 和固定 workload 证据。

### 46.2 Geometry 与压缩

研究项：

- meshoptimizer：vertex remap/cache/fetch、meshlet、bounds、payload compression；
- glTF meshopt extension：作为 Import/Transport，而不是 Runtime ABI；
- Draco：传输收益与 Runtime decode/重排成本；
- KTX2/Basis Universal：Universal Web Asset transcode；
- BC/ETC2/ASTC 官方规格和各 adapter 支持；
- normal/alpha coverage aware mip 与压缩实现。

需要回答：

- 哪些能力已有当前 `docs/porting/geometry.md` 记录；
- 哪些代码可合法局部移植；
- quantization/bounds 的不变量；
- Worker/WASM 体积和峰值；
- 输出是否可直接成为 OEngine canonical payload。

### 46.3 Visibility 与 Material

研究项：

- Nanite/GPU-driven material classification 的公开技术资料；
- visibility-buffer compute shading 论文和实现；
- meshlet indirect raster without mesh shader；
- barycentric/gradient reconstruction；
- large triangle setup/cache；
- GPU queue append/scan/compact。

需要回答：

- 外部方案依赖哪些不在 `docs/WEBGPU.md` 能力线内的能力；
- primitive identity 如何表达；
- material classification 是否需要 wave/subgroup；
- Compute texture LOD/gradient 如何保持质量；
- binding layout 是否适配 OEngine Texture Residency。

### 46.4 Shading 与颜色

研究项：

- Filament PBR/IBL、pre-exposure、specular AA 的公开实现和文档；
- 当前 OEngine shading porting 记录；
- HDR compact format 精度；
- Surface normal packing；
- BRDF/material fusion。

需要回答：

- BRDF 不变量和工作色域；
- pre-exposure 对透明、SSR、Bloom、Temporal 的统一规则；
- f16/packed normal 的误差；
- material evaluation 是否确实只有一次。

### 46.5 AO、SSR 和 Pyramid

研究项：

- GTAO/相关 AO 参考；
- FidelityFX SSSR；
- FidelityFX SPD；
- hierarchical depth traversal；
- temporal/spatial denoise。

需要回答：

- 来源许可证和 shader 表达是否适合移植；
- wave/subgroup 假设如何改成 WebGPU fallback；
- depth convention/reverse-Z 差异；
- texture/storage format 和 binding 差异；
- shared pyramid 是否实际减少总 bandwidth。

### 46.6 Temporal、Shadow 与 GI

研究项：

- Unreal TSR 的公开行为/论文级资料；
- FidelityFX temporal upscaling 参考；
- Unreal Virtual Shadow Maps 的 page/cache/invalidation 设计；
- screen-space contact shadow；
- sparse probe/clipmap GI；
- screen-space GI；
- volumetric froxel rendering。

这些高级能力在研究完成前不得以“行业方案”作为性能正确性的证据。必须重新建立符合 OEngine FrameProducts、one-submit、feature-off 和 WebGPU capability 的设计。

### 46.7 WebGPU/WGSL 规格

所有具体 API、format、feature、limit 和 Shader 能力最终以实现时的 WebGPU/WGSL 官方规格与目标浏览器为准，重点核对：

- `GPUFeatureName` 和 device request；
- per-stage storage/sampled/sampler limits；
- storage texture format；
- indirect draw/dispatch；
- first-instance；
- primitive index；
- subgroup 和 f16；
- timestamp-query；
- shader stage restriction；
- buffer alignment and binding size。

规格确认是 capability matrix 的输入，不替代真实 adapter benchmark。
