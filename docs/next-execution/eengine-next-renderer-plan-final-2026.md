# EEngine Next 整体渲染架构执行计划与完成情况（Renderer Plan / WebGPU 2026）

> 状态：第一层整体执行计划基线  
> 日期：2026-09-27  
> 对应设计：`docs/design/renderer.md`（《EEngine Next 整体渲染架构设计》）  
> 建议落位：`docs/plans/renderer.md`  
> 目标：在**持续可运行、持续可 benchmark、不中断现有 Geometry/Visibility 生产链**的前提下，把当前 Renderer 逐步迁移到 GPU-Resident Scene + Demand-Driven GPU Work + Hybrid Visibility + Decoupled Surface/Lighting + Virtualized Resources + Temporal Reconstruction 的最终架构。  
> 文档职责：只规划“整体 Renderer 第一层架构如何落地、按什么顺序落地、每一步如何验证以及当前做到哪里”。VSM、Surface v2、SSSR、GI、VT、Transparency 等进入独立模块后，各自再建立 `design/<module>.md + plans/<module>.md`，本文件不提前替它们设计内部算法。

---

## 1. 计划判断：这不是一次重写，而是一次受控的主链迁移

当前 EEngine 已经拥有一条真实工作的现代 WebGPU 主链，因此整体架构升级不能采用“创建 RendererV3，然后把旧代码一次性搬过去”的方式。那样会同时失去性能基线、功能基线、回归定位能力和已有 GPU-driven 资产，最后很难判断新架构究竟更好还是只是更新。

正确策略应当是：**冻结 Geometry/Visibility 已经证明有效的资产，把 Visibility 之后的职责边界重新切开；每次只替换一个可验证的纵向切片；新旧路径在关键阶段允许短期 A/B 共存；每一阶段必须在进入下一阶段前产生真实 GPU evidence。**

因此，这份计划遵循五条执行原则。

第一，任何架构迁移都不能破坏“本帧动态 workload 不回 CPU”的原则。CPU 可以读取延迟 telemetry、做资源流送和下一帧/未来帧的低频控制，但不能因为新 Planner、VSM、Surface 分类或 GI 再引入本帧 GPU→CPU→GPU 闭环。

第二，优先建立稳定语义 ABI，再替换物理实现。`Visibility Facts`、`Temporal Facts`、`Surface Field Demand`、`Shadow Visibility`、`World Query`、`Radiance Field` 等边界先成为代码中的真实类型和 ownership，再逐步切换 kernel、resource layout 和 pass。这样后面的 donor 移植不会直接侵入 RendererCore。

第三，旧路径只能作为迁移桥梁，不能永久“双轨”。A/B 的存在必须有明确删除门槛。若新路径通过正确性、性能和稳定性验证，旧路径应删除，避免后续每个效果维护两套 Renderer。

第四，不以“代码完成”作为阶段完成。一个阶段只有同时通过 Contract、Integration、Correctness、Performance、Telemetry 五类证据，才能进入 Production。没有 benchmark 的优化只能叫实现，不能叫完成。

第五，外层计划不提前决定内层算法。比如本计划会要求 VSM 验证 `GPU-produced residency`，但不决定 page size、atlas page packing、caster raster 方案；会要求 Surface v2 支持 Dense/Binned 与 Field Demand，但不在这里决定具体 closure record 或 physical surface packing。那些属于下一层文档。

整体迁移顺序不是按“最酷效果”排列，而是按**依赖关系和返工风险**排列：

```text
Current Production Renderer
        │
        ▼
[0] Baseline + Guardrails
        │
        ▼
[1] Semantic ABI + Frame Program Skeleton
        │
        ▼
[2] Surface / Material / Lighting Boundary v2
        │
        ▼
[3] Temporal + Radiometry + Presentation Contract
        │
        ▼
[4] VSM as First Cross-System Architecture Proof
        │
        ▼
[5] Reflection / GI / VT / Transparency Expansion
        │
        ▼
Next Renderer Production Baseline
```

这里最重要的一点是：**Phase 4 不是“第四个效果”，而是整体架构验收。** VSM 会同时穿过 GPU Scene、Geometry Work、Virtual Resource、GPU-produced residency、Raster、Lighting。如果到那一步仍必须在 `RendererCore` 中新增大量 VSM 专用分支、current-frame CPU orchestration 或独立资源旁路，就说明前面的整体架构边界仍然没有切对，应停下来修架构，而不是继续堆功能。

---

## 2. 当前工程基线：哪些已经是资产，哪些是迁移对象

以下状态基于当前工程源码审阅，不把旧文档里的“Phase Done”直接当成完成证据。这里的目的不是打分，而是明确迁移时哪些东西应该保护、哪些东西应该替换。

当前 `GpuRenderWorld / GPU Scene`、Virtual Geometry residency、geometry product publication、hierarchical work、meshlet work queue、Packed Visibility、HZB 和 current-HZB late recheck 已经形成较完整的 GPU-driven 几何链路。`RendererCore.compileVisibilityGraph()` 中，Visibility 先生成 `VisibilityFrame`，随后构建 HZB，并可对 candidate MeshletWork 做 current-HZB late recheck。这个方向与最终架构一致，应被视为**保留并逐步 ABI 化的生产资产**，而不是下一轮重写对象。

当前 Surface 已经不再是空壳：`ShadingWorkPass` 可以按屏幕 Visibility 分类、生成 queue/class/indirect，并存在 adaptive frequency plan；`SurfaceMaterialPass` 根据 active class 生成/缓存 compute pipeline，执行 surface reconstruction、材质求值和 direct lighting；主链后面已有 Physical Sky、Aerial Perspective、FSR3 和 Present。因此下一步不能简单地说“把材质接上”，而应该承认当前已经有第一代 Surface Compute Shading，再针对它的结构性成本做 v2。

但当前第一代 Surface 也恰好暴露了要迁移的核心问题：

```text
Visibility
  → full-screen classify
  → finalize
  → full-screen scatter
  → up to 64 material classes
  → per-class compute indirect
```

这里 Material Program、Texture Binding Set 与执行 class 仍然耦合；简单区域同样支付 classify/scatter 成本；`SurfaceMaterialPass` 在帧图节点执行时会为 active program 建 bind group；物理调度仍然以 class 为中心，而不是以 Dense Fast Lane / Expensive Lane / Sampling Policy / Closure Cost 这些 GPU 执行属性为中心。这一段是整体迁移的首要对象。

当前 Temporal 与 Presentation 也处于“基础合同已出现、生产闭环未完成”的状态。`TemporalFabric` 已经集中维护 color/depth/motion history，并使用 scene/representation/light 等 revision；但整体设计已经明确，未来不能用全局 `representationRevision` 粗暴代表局部 history confidence。`SurfaceMaterialPass` 当前编译 kernel 时仍使用 `outputDependencyMask: 0`，而 FSR3 的 reactive/transparency 输入仍使用默认 zero mask；`RadiometryRuntime` 有统一 pre-exposure contract，但 multiplier 当前只是一条可设置状态，还没有 auto exposure 主链；最终 Present 也还不是完整的 exposure/tone-map/color-grade/display transform。这里属于必须在架构扩展前补齐的基础设施。

`FrameProducts.ts` 已经出现很多很好的语义产品苗头，例如 `ShadingSurfaceLiteFrame`、`DiffuseSurfaceLiteFrame`、`OpaqueColorPyramidFrame`、`ReflectionCorrectionFrame`、`TemporalReconstructionFrame`；这证明工程已经在向语义产品演进。但现在 `RendererCore` 仍然主要通过固定顺序手写 `addToGraph()`：Visibility → ShadingWork → LightCluster → Surface → FrequencyResolve → Sky → Aerial → FSR3 → Present。也就是说，**产品语言已经存在，Frame Program 还没有真正成为 owner。**

当前基线因此可以归纳为：

| 领域 | 当前状态 | 第一层计划处理方式 |
|---|---|---|
| GPU Scene / Product Publication | 已形成稳定方向 | 保留，补稳定 handle/generation 语义 |
| Virtual Geometry / Streaming | 生产资产 | 保留，作为 Streamed Residency 第一实现 |
| GPU Hierarchy / Meshlet Work | 生产资产 | 保留，统一到 GPU Work Fabric |
| Visibility / HZB | 主链成立 | 保留，提升为 Visibility Facts ABI |
| FrameGraph | 可用但仍被 RendererCore 固定拼装 | 保留执行器，新增 Frame Program 上层 |
| FrameProducts | 已有语义产品雏形 | 收敛，不让算法名泄漏进长期产品 |
| ShadingWork | 第一代可用 | 逐步替换为 Surface Work Analysis v2 |
| Surface Material | 第一代可用 | 重构执行分类、Field Demand、Fuse/Materialize |
| Texture Bank / Binding Set | 当前可用 | 作为 legacy lowering，建立 Logical TextureHandle 层 |
| Direct Lighting / Clustering | 已接主链 | 保留算法资产，重新定义 energy/ownership |
| Shadow | 尚无生产级主链 | 后续 VSM 作为首个跨系统验收模块 |
| Temporal | 基础 infrastructure 已存在 | 重构为共享 Facts + consumer confidence |
| FSR3 | 算法主体已接 | 在新 Temporal Facts 下重新闭环输入 |
| Radiometry / Presentation | 合同存在，闭环不足 | 本轮基础迁移必须补齐 |
| World Query / Radiance Field | 尚未成为一等语义层 | 先建立边界，具体 backend 后续模块实现 |
| VSM / SSSR / GI / VT | 未进入最终主架构 | 分别在下一层模块文档展开 |

整体完成情况在当前时点应描述为：**Geometry/Visibility 主干可作为下一代基础；整体架构设计已建立；迁移执行尚未开始；Surface、Temporal、Frame Program 是第一批真实重构对象。** 不使用“整体完成百分比”。

---

## 3. 第一阶段实施：先把架构边界切出来，不急着换算法

真正开始改代码时，第一目标不是让画面更好，也不是立刻让 GPU 更快，而是建立几个以后不希望反复变动的语义 ABI，并让当前生产路径先通过这些 ABI 运行。这样后续每个模块替换时才不会重新碰 `RendererCore`。

首先建立 `Frame Program` 的最小骨架。这里不应该出现复杂 Planner、YAML、claim registry 或自动搜索算法。它只需要把当前帧长期稳定的意图编译成有限 topology：分辨率、capability profile、开启的渲染域、所需 semantic products、允许的 Surface lanes、需要物化的 Surface fields、Temporal/Presentation profile。它不决定 visible meshlet 数、不决定本帧 shadow page 数、不决定当前帧 reflection ray 数。

可以把第一版想成一个很小的数据结构：

```ts
interface FrameProgram {
  topologyKey: FrameTopologyKey;
  capabilities: CapabilityProfile;
  products: ProductDemand;
  surface: SurfaceExecutionPolicy;
  temporal: TemporalPolicy;
  presentation: PresentationPolicy;
}
```

这里 `SurfaceExecutionPolicy` 只表达“有哪些 lane 被编译进来”和“哪些 semantic fields 被 consumer 请求”，不能表达“本帧 tile 37 走 Binned”。后者由 GPU 的 Surface Work Analysis 决定。

随后把现有固定 Pass 主链包装到这个 Frame Program 下面。第一阶段甚至允许 Frame Program 仍然生成与现在几乎相同的 topology，目的只是把 ownership 从 `RendererCore` 中切开。`RendererCore` 最终应该逐步退化成设备/Canvas 生命周期、SceneRuntime、FrameProgram 获取、encode/submit、recovery 和顶层 profiler owner，而不是继续知道每个效果的具体 addToGraph 顺序。

与此同时建立四个第一层语义合同：

```text
Visibility Facts
  authoritative depth + primitive token + optional coverage hint

Temporal Facts
  motion + stable identity + local change + reactive/disocclusion facts

Surface Field Demand
  normal / roughness / reflectance / material AO / ... semantic requests

Lighting Stage Contract
  Direct → Indirect Diffuse → Pre-Reflection HDR → Specular Indirect → Final Opaque HDR
```

这一步不要求马上改变物理纹理格式。例如现有 `VisibilityFrame` 可以作为 `Visibility Facts` 的第一实现，现有 motion texture 可以作为 Temporal Facts 的一个字段，现有 `ShadingSurfaceLiteFrame` 可以映射到最初的 Surface Field layout。关键是下游开始消费语义，而不是直接依赖某个 Pass 的私有资源。

这一阶段还必须处理 FrameGraph topology 与 persistent resource binding 的关系。`FrameGraphKey` 应只表达真正改变拓扑和 pipeline/layout closure 的状态：resolution profile、capability profile、feature topology、Surface physical profile、output format、instrumentation profile。History A/B、当前 environment generation、VSM/SSR/GI persistent atlas generation 以后不应该进入 topology key，而应该通过 persistent handle / graph binding slot late-bind。第一阶段就把这个原则落进 API，避免等多套 history 上线后再处理 graph-key 组合爆炸。

阶段完成的验收不是“FrameProgram 类写好了”，而是：

- 当前视觉输出在 reference scene 上与迁移前一致，允许只有浮点 epsilon 差异；
- Current Geometry/Visibility 主链没有被重写；
- RendererCore 不再直接拥有新增 module 的物理 pass ordering；
- 关闭新模块时，Frame Program 能编译出最小 topology，不产生无意义 Surface/Temporal 中间资源；
- topology cache key 中不再混入纯粹 persistent read/write index；
- 没有引入任何 current-frame GPU→CPU→GPU 同步；
- CPU encode time、bind group 数和 graph compile cache 命中率有基线 telemetry。

**当前状态：整体合同设计完成；代码实现未开始。** 现有 `FrameProducts.ts` 和 `FrameGraphBindingLayout` 可作为迁移起点，而不是从零创建一套新的产品系统。

---

## 4. 第二、三阶段实施：用 Surface v2 和 Temporal/Presentation 把后半段真正改造成下一代主链

Frame Program 骨架成立之后，最重要的工作不是 VSM，而是 Surface / Material / Lighting v2。原因很简单：以后 GTAO、SSSR、GI、VSM lighting integration、透明、毛发都会经过这条边界；如果这时还沿用“全屏 classify → scatter → 64 class”作为唯一结构，所有新效果都会绑定第一代 Surface 的假设，后面再重构会非常昂贵。

Surface v2 的执行目标已经在总体设计中冻结成三个正交维度：`Work Scheduling`、`Sampling Policy`、`Execution Class`。第一版实现不要一开始追求全自动 cost model，而应该先建立有限、稳定、可 benchmark 的物理 lane，例如：

```text
Dense Fast Lane
Expensive / Divergent Binned Lane
Special Closure Lane（只有真实需求时存在）
Coarse Sample Lane（仅对满足 temporal/continuity 条件的区域开放）
```

GPU 的 Surface Work Analysis 以 tile/sample 为粒度读取 Visibility、Material execution metadata 和局部连续性，简单 coherent 区域直接走 Dense，不先排队；只有昂贵或显著 divergent 的工作才进入 bounded compact queue。这里的关键指标不是“分类效果好不好看”，而是：`analysis + reservation + scatter + indirect` 的总成本必须小于节省的昂贵 shading 成本。

当前以 material class / texture binding set 为执行 class 的结构要逐步退出。Material publication 阶段应把 authoring graph 编译成少量 `Surface Closure / Execution Class`，例如 Standard PBR、Coated/Anisotropic、Subsurface、Transmission/Hair 特殊域、Generic Fallback。材质 ID 仍然是数据索引，texture binding set 仍然可以作为某个物理 lowering，但二者都不再定义 shader execution identity。

纹理侧同时建立稳定 `Logical TextureHandle → Physical Sampling Class`。第一阶段不需要马上实现 VT，也不需要马上删除 texture banks；可以让现有 bank/set 成为一种 legacy physical profile，并增加 Wide Profile 做 benchmark。最终 Material kernel 不应该知道“这是第 3 组第 6 bank 的材质类”，而应该通过 TextureRef/route 获取采样资源。等以后 VT 或更接近 bindless 的 capability 出现，只替换 lowering。

Surface v2 的另一个硬要求是 `Fuse + Field Materialization`。不能先做一份完整 GBuffer，也不能规定所有材质永远重复 reconstruct。Frame Program 根据 consumer demand 得到 semantic fields；Surface Compiler 把这些 field 映射到有限 physical layouts。一个热 kernel可以同时完成 Material Evaluate + Direct Lighting，同时顺手写 Normal/Roughness sidecar 给 GTAO/SSSR；如果多个 consumer 足够多，再选择 materialize 较完整 Surface layout。物理 layout 数量必须有限，禁止每种 feature 组合生成一个新 attachment 组合。

Surface v2 应通过至少三组 A/B 场景证明价值：

```text
A. cheap + coherent scene
   Dense Fast Lane 应明显优于强制 classify/scatter。

B. expensive mixed-material scene
   Binned Lane 的 analysis/queue 成本应被昂贵 shading 节省覆盖。

C. multi-consumer scene
   GTAO/Reflection 等请求 Surface fields 时，按需 materialize
   应优于多个 consumer 重复 reconstruction，同时不能退化成固定全量 GBuffer。
```

这一阶段只有 Standard PBR 主路径跑通即可，不要求 Hair/Transmission/SSS 全部完成。特殊 closure 先保留 ABI 和 bounded lane，等对应模块真正进入开发再实现。

随后进入 Temporal + Radiometry + Presentation。这个阶段与 Surface v2 紧邻，因为极致性能路线会越来越依赖低频/稀疏采样 + 时域重建；如果 Temporal identity、motion 和 local change 不可靠，Adaptive Surface、SSSR、GI、VSM cache 都会被质量问题反噬。

共享的 `Temporal Facts` 至少需要覆盖 authoritative motion、stable instance/surface identity、depth、local geometry/LOD/material/texture-residency/shading-rate change、reactive/disocclusion/transparency 事实。这里不创建全局 `HistoryConfidence`。FSR3、SSR、GI、AO 等 consumer 根据自己的敏感度读取这些 facts 并计算自己的 history confidence。

现有 `TemporalFabric` 可以继续作为 history registry / transaction owner，但需要减少“全局 revision = 全局失效”的依赖。Scene/device/format 等真正改变所有历史语义的 revision 仍可以全局 invalidation；LOD、texture residency、material change 等必须尽量落成局部 change mask 或局部 identity mismatch。无法稳定跨 LOD 映射时降低局部 confidence，而不是要求 Geometry 为所有 LOD 建昂贵的完美 primitive correspondence。

Presentation 在这个阶段必须真正闭环：

```text
Scene-referred HDR
  → pre-exposure
  → temporal reconstruction
  → auto exposure
  → bloom / selected lens stages
  → tone mapping
  → color grading
  → SDR/HDR display transform
```

当前 `RadiometryRuntime` 可以成为 pre-exposure owner，但必须接入真实 exposure adaptation；FSR3 重新接 Temporal Facts，motion、reactive、transparency 不再使用占位输入；Present 不再只是把 HDR radiance 直接写 swapchain。这里不是“做几个后处理”，而是建立之后所有 3A lighting 的最终评判环境。

Surface + Temporal/Presentation 两阶段完成后，必须重新建立新的 Renderer baseline。这个 baseline 才是后续 VSM、SSSR、GI 的性能对照，而不能继续使用旧 SparseShadingResolve 的历史数据直接推断新 Surface v2。

**当前状态：Surface v1 已集成；Surface v2 未实现。Temporal infrastructure 已有基础；Temporal Facts/consumer confidence 未完成。Radiometry contract 已存在；生产级 exposure/presentation 闭环未完成。**

---

## 5. 第四阶段实施：用 VSM 验证整体架构，而不是仅增加阴影效果

当 Frame Program、Surface v2、Temporal/Presentation 都有稳定主链后，才进入第一个真正跨系统的新模块：VSM。届时单独创建：

```text
docs/design/vsm.md
docs/plans/vsm.md
```

本计划只规定 VSM 对整体架构的验收责任，不规定内部 page size、clipmap、filtering 或 raster 实现。

VSM 必须验证四件事。

第一，`Shadow Visibility` 是否真的是一等语义产品。Direct Lighting 只消费 shadow result，不直接知道 page allocator、caster work、atlas layout。如果 Surface kernel 必须直接依赖大量 VSM 私有结构才能运行，说明 Shadow/Lighting 边界过度泄漏。

第二，`Virtual Resource Fabric` 是否真的能同时容纳两种 fulfillment model。Virtual Geometry 是 Streamed Residency：GPU demand 可以延迟反馈 CPU/IO，再在未来帧驻留。VSM 则要求 GPU-Produced Residency：当前帧 receiver demand 产生后，GPU 必须在已有固定 topology 中分配/更新 page mapping、生成 caster work 并产生 shadow contents，不能等待 CPU 下一帧补页。二者共享 logical ID、budget、generation、priority、eviction、telemetry，但不能共享“延迟 CPU fulfillment”的执行假设。

第三，GPU Work Fabric 是否足够通用。VSM 的 page request、caster work、page batch/indirect args 应使用与 Geometry/Surface 一致的 bounded reservation / overflow / indirect / telemetry 思路；但不要求共享同一种 record layout。若为 VSM 重新创建完全独立的 queue/counter/overflow 机制，应先判断 GPU Work Fabric 是否抽象不足。

第四，Frame Program / FrameGraph 是否真的不需要 current-frame CPU orchestration。WebGPU 无法让 GPU 动态创建任意 RenderPass/viewport，所以 VSM 物理实现必须在预先编译的有限 topology 中消费 GPU-generated demand。最终可能使用 atlas coordinate transform、固定 page batch、受限 raster slot 或软件/混合深度 raster，但这些都必须由 `design/vsm.md` 基于 benchmark 决定。整体架构只验收：GPU demand 出来后，不回 CPU 决定本帧有哪些 shadow passes。

VSM 进入 Production 的整体架构门槛应至少包括：

- receiver-driven demand 能在 GPU 内完成 same-frame fulfillment；
- caster work 不错误复用 camera-visible list，而是有 light-space 查询；
- page cache/invalidation 可通过 delayed telemetry 观测 dirty rate、reuse rate、overflow、raster cost；
- Direct Lighting 不拥有 VSM private lifecycle；
- FrameGraph topology 不随着本帧 page count 动态增长；
- 不因为加入 VSM 改写 Visibility Facts、Surface Closure 或 Temporal Facts 的核心 ABI；
- VSM 关闭时相关资源/pass 被 topology culling 掉，不产生固定常驻成本。

如果这些条件满足，就可以认为“整体架构第一层”已经通过一个足够复杂的真实模块验证。之后 SSSR、GI、VT、Transparency 的风险会明显下降。

**当前状态：VSM 尚未进入本计划实施；仅完成总体架构边界定义。**

---

## 6. 后续扩展顺序、性能验证与停止条件

VSM 之后不建议一次同时推进 SSSR、GI、VT、透明。第一层计划只定义推荐依赖顺序和每个模块为什么在那个时间点进入，具体内容由各自两份文档负责。

建议顺序是：先 GTAO/轻量 Screen Diffuse consumer，再 SSSR，再 World Query/Radiance Field 的第一套 world-space backend，再 GI，再根据真实纹理 residency 数据决定 VT，Transparency/Media 则在 Opaque + Temporal + Presentation 稳定后接入。GTAO 之所以可以在 VSM 前后作为小模块穿插，是因为它非常适合验证 `Surface Field Demand`：只请求 depth/normal/bent-normal/ambient visibility，不需要重构整个 Lighting。SSSR 则是 `Pre-Reflection Opaque HDR + Pyramid + Surface Fields + Temporal Facts` 的第一次综合验收。GI 再进一步验证 World Query、Radiance Field 和独立低频 sampling domain。VT 最后由真实 texture working-set 和 upload/memory telemetry 驱动，而不是因为“现代引擎应该有 VT”就提前实现。

每个阶段都必须拥有固定 benchmark 套件，至少包含以下场景：

```text
Geometry Stress
  大量实例 / 高 meshlet count / near-view heavy coverage

Surface Cheap
  大面积简单 Standard PBR，验证 Dense lane 开销

Surface Mixed
  简单 + textured + expensive closure 混合，验证 Binned lane

Texture Stress
  高纹理工作集、不同 resolution/sampler class，验证 routing/locality

Lighting Stress
  多 light / high cluster occupancy

Temporal Motion
  camera pan / fast motion / disocclusion / LOD change

Presentation HDR
  high dynamic range + emissive + sky + bright sun / dark interior

Streaming Stress
  VG upload/eviction，同时保持 render-frame stability
```

正式 benchmark 必须固定 camera path、internal/output resolution、browser build、GPU/driver、capability profile、quality profile、热机帧数和测量窗口。自适应 budget 在架构 benchmark 中默认关闭，否则无法知道优化是“更快”还是“偷偷降质量”。动态质量模式另测。

推荐每次记录至少：

```text
CPU
  frame encode P50/P95
  graph compile count/cache hit
  pipeline creation count
  bind-group creation count

GPU
  total frame P50/P95
  geometry / visibility
  surface analysis
  dense shading
  binned shading
  direct lighting
  shadow
  temporal
  presentation

Work
  visible meshlets
  Surface lane counts
  queue occupancy/overflow
  material execution classes
  shadow page demand/dirty/reuse
  reflection/GI work（模块上线后）

Memory
  persistent GPU memory
  transient peak
  virtual residency
  history/cache memory

Quality
  temporal ghosting/disocclusion
  shading edge stability
  reflection fallback continuity
  HDR/exposure stability
```

不要用单一平均 FPS 做架构决策。对于 GPU-driven renderer，P95、queue overflow、热路径 dispatch 数、bind group/PSO churn、transient bandwidth、历史稳定性同样重要。

整体迁移还需要明确停止条件。出现以下任一情况时，不应继续增加新效果，而应返回前一层修架构：

- RendererCore 再次开始为每个新效果新增大量专用资源和条件分支；
- 某模块要求 current-frame GPU readback 才能继续执行；
- 新 semantic product 只能通过泄漏具体 donor 算法名才能描述；
- Surface field 组合导致 physical layout/pipeline variant 数量快速组合爆炸；
- 每个高级效果各自维护 World BVH/HZB/radiance cache/temporal identity，而无法共享语义事实；
- FrameGraph topology key 开始包含大量 history index/page generation 等物理状态；
- 为统一架构付出的 classify/queue/materialize 成本在简单场景持续显著高于旧路径；
- 质量下降只能通过“降低阈值/多 blur”掩盖，而没有稳定 identity/reconstruction 解释。

这些停止条件非常重要。EEngine 的目标不是“按路线图做完所有名词”，而是保持主架构长期有性能上限。

---

## 7. 完成情况与长期维护方式

这份 `plans/renderer.md` 以后只维护整体层状态，不记录 VSM page allocator、SSSR ray march、GI probe update 等模块级 task。状态采用五级成熟度：

```text
Contract Established
  语义边界和 owner 已明确，设计可进入代码。

Implemented
  核心实现存在，可独立运行或被测试。

Integrated
  已进入真实主帧链，不再只是 demo/prototype。

Validated
  已通过 correctness + benchmark + telemetry 证据。

Production
  已成为唯一/主要生产路径，旧迁移路径已删除或只保留明确 fallback。
```

截至 2026-09-27，整体层建议记录如下：

| 工作域 | 当前成熟度 | 当前判断 | 下一动作 |
|---|---|---|---|
| Overall Renderer Architecture | Contract Established | 最终第一层设计已形成 | 进入 Frame Program / ABI 落地 |
| GPU Scene / Publication | Integrated / 部分 Validated | 当前路径应保留 | 收敛 stable logical handle/generation |
| Virtual Geometry / Streaming | Integrated / 已有生产证据 | 作为 Streamed Residency 基线 | 不重写，补统一 telemetry/control plane |
| Geometry GPU Work / Visibility / HZB | Integrated / 已有生产证据 | 下一代主资产 | 提升为 Visibility Facts / GPU Work ABI |
| FrameGraph | Integrated | 执行基础可保留 | topology ownership 移交 Frame Program，history late-bind |
| Frame Program | Contract Established | 目前只有设计，没有真实 owner | 第一批实现 |
| Surface v1 | Integrated | 可作 A/B baseline，不是长期终态 | 建立 Surface v2 独立 design/plan 后逐步替换 |
| Surface Field Demand / Fuse+Materialize | Contract Established | 仅设计 | 随 Surface v2 实现 |
| Texture Logical Handle / Sampling Class | Contract Established | 现有 bank 为 legacy lowering | 先建立逻辑层，不急于实现 VT |
| Lighting Energy Contract | Contract Established | 当前 direct lighting 可复用 | 与 Surface v2 一起接入 |
| Temporal Facts | Contract Established | 当前 history infra 可复用，facts 不完整 | motion/reactive/local change 闭环 |
| FSR3 Production Integration | Integrated but Incomplete | 主算法已接，输入 facts 未闭环 | 迁移到 Temporal Facts 后重新验证 |
| Radiometry / Auto Exposure / Presentation | Implemented in part | pre-exposure contract 有，最终成像链不足 | Temporal 阶段完成生产闭环 |
| Shadow Visibility / VSM | Contract Established | 尚无最终生产实现 | Surface/Temporal 稳定后单独启动 VSM 模块 |
| World Query | Contract Established | 仅边界 | SSSR/GI 阶段设计首个 backend |
| Radiance Field | Contract Established | 仅边界 | GI/Reflection 阶段逐步实现 |
| VT | Not Started | 暂无证据证明是当前优先瓶颈 | 等 texture working-set telemetry 再启动 |

为了防止这份计划再次膨胀成 Project OS，它只维护三类信息：**当前阶段、阶段出口证据、整体成熟度。** 每完成一个大阶段，在对应表格中更新成熟度和 3～8 行结论即可；具体 benchmark 数字放 benchmark 文件/报告，具体实现任务放模块 plan 或 issue，不把所有日志复制进来。

当前整体执行状态可简写为：

```text
ACTIVE
  Phase 0 — Baseline / Guardrails
  Phase 1 — Frame Program + Semantic ABI（下一步）

READY FOR MODULE DESIGN
  Surface / Material / Lighting v2

BLOCKED BY ABOVE
  VSM production integration
  SSSR
  World Query / GI
  VT

PROTECTED ASSETS
  GPU Scene
  Virtual Geometry
  Hierarchical GPU Work
  Visibility / HZB
  FrameGraph execution core
```

这里的 `Phase 0` 不要求重新做一次大规模工程治理。它只需要在开始改主链之前固定一组可重复 benchmark、保存当前 reference captures、记录 capability/browser/GPU 环境，并确认现有 Geometry/Visibility 的性能不因后半段重构而无意回退。

---

## 8. 第一层完成定义：什么时候可以说“整体架构迁移完成”

第一层 Renderer 计划不是等 VSM、SSSR、GI、VT、体积云、毛发全部做完才完成。那会把“架构完成”和“功能完成”混为一谈。

当下面这些条件同时成立时，就可以把 `plans/renderer.md` 标记为 **Production Architecture Baseline**，之后整体架构只做低频演进，各模块进入自己的 design/plan：

1. `RendererCore` 已经不再手工拥有所有效果 pass 顺序；Frame Program 成为 topology / semantic demand owner，FrameGraph 成为执行与资源生命周期 owner。
2. GPU Scene、Visibility Facts、Temporal Facts、Surface Field Demand、Lighting Stage、Shadow Visibility、World Query、Radiance Field 等第一层合同在代码中有真实类型/owner，而不是只存在文档。
3. Current-frame dynamic work（Geometry、Surface、Shadow 等）由 GPU queue/indirect/bounded budget 驱动，不存在主路径 GPU→CPU→GPU 回环。
4. Surface v2 已成为生产路径：简单区域可 Dense，昂贵/divergent 区域可 bounded Binned，Sampling Policy 独立，Material execution 不再被 material ID/texture set 定义。
5. Fuse + Demand-Materialized Fields 已被至少一个真实 consumer 验证，且 physical layouts 数量有限，没有退回固定大 GBuffer。
6. Logical TextureHandle 已与 physical sampling profile 解耦，现有 texture bank 只是实现之一。
7. Temporal Facts 已闭环，FSR3/未来 consumer 不依赖占位 motion/reactive，局部 representation/material/residency 变化不会造成无必要的全屏 history reset。
8. Pre-exposure、auto exposure、tone mapping、color grade、SDR/HDR display transform 构成统一 Presentation 主链，3A lighting 可以在稳定 radiometry 下评价。
9. VSM 至少完成一个生产级 vertical slice，证明 GPU-produced residency、Shadow Visibility、GPU Work Fabric 与 Frame Program 边界真实可用，而不是纸面抽象。
10. 新主链在固定 benchmark 中达到或超过旧路径的综合目标：简单场景不能因统一架构产生明显持续回退；复杂 mixed-surface 场景能证明 Surface v2 的收益；CPU encode/PSO/bind-group churn 不随 material/feature 数量线性恶化；P95 和 overflow 可控。
11. 旧 Surface/旧临时 topology 等迁移桥梁已删除或明确降为 fallback，不保留永久双轨。
12. 后续 SSSR、GI、VT、Transparency 可以只通过自己的两份模块文档接入，而不要求再次重写 Renderer 第一层。

满足这些条件以后，整体 Renderer 的“外层设计”才真正从文档变成了工程现实。此后即使某个 VSM page layout、GI backend、Surface physical packing、软件 raster 算法发生变化，也应该只是模块内部迭代，而不是重新推翻整个 EEngine Next。

这就是本计划最重要的最终目标：**不是一次把所有 3A 技术做完，而是尽早把未来 3A 技术都能长期生长的主干做对。**
