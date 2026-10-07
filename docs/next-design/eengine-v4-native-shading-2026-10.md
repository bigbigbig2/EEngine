---
id: eengine-v4-native-shading-2026-10
state: current
verifies:
  files:
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program/FrameProgram.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/material/AppearanceGraphCompiler.ts
    - OEngine/src/material/ExactAppearanceDag.ts
    - OEngine/src/shaders/appearance_program.ts
    - OEngine/src/shaders/appearance_exact_dag.ts
    - OEngine/src/gpu/AppearanceProgramRegistry.ts
    - OEngine/src/gpu/GpuAppearancePublication.ts
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/gpu/GpuVisibilityKeyAbi.ts
    - OEngine/src/render/passes/PackedVisibilityPass.ts
    - OEngine/src/render/FrameGeometryArena.ts
    - OEngine/src/render/surface/SurfaceWorkRuntime.ts
    - OEngine/src/gpu/GpuSurfaceWorkAbi.ts
    - OEngine/src/render/temporal/TemporalFactsPass.ts
    - OEngine/src/render/passes/fsr3/Fsr3UpscalerRuntime.ts
    - OEngine/src/framegraph/FrameGraph.ts
    - OEngine/src/framegraph/ShadeGPUCommandContext.ts
---

# EEngine V4：Native Shading 架构母稿

本文件是唯一 **current renderer architecture authority**；[执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)是唯一 renderer execution authority。[workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml)只维护当前模块导航，不另列完整任务。源码定义当前实现事实，`docs/domains/`在真实代码切换后更新。本文采纳 V4 目标，不声称 V4 已实现、校准、通过 GPU 验证或提升来源 adoption。

2026-10-07 执行 `git fetch origin` 后，HEAD、master、origin/master 均为 `b69a0a60b13930212fdc98f988443186fad024e4`；开始时仅两份 V4 提案未跟踪。下文源码定位以该快照为审查起点，实施必须重新检查 HEAD/工作区与直接消费者。

## 1. Authority 与设计输入

主方案来自[Native Shading 独立提案](<./EEngine V4：Native Shading 独立架构提案.md>)。从[辅助研究提案](<./EEngine V4：以 Native Material Shading 为核心的独立渲染架构设计.md>)吸收 AAA composition、VRAM/带宽、风险、one-route→multi-route、calibration、来源映射及可证伪方法；其路线、预算与实施顺序不自动采纳。两份提案保留为 history 研究输入，不能形成第二份 current authority。

[R3/R4 设计](./eengine-extreme-performance-rebuild-2026-10.md)、[R3/R4 执行记录](../next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md)及 ADR-0021 退出 current；旧实验、C cache 负收益、B1/B2 数值问题原文保留。历史文本中的“必须修旧 cache”“General VM”“六 signal”“A0→F”不再约束 V4。发生冲突时，以本母稿、最新源码事实、协商到的 WebGPU 能力和可检验成本模型共同裁决；实现事实不因目标改变而重写。

长期目标仍是 Extreme Performance、GPU Driven、WebGPU Native、AAA 画质、复杂场景 streaming 和可持续扩展；GTX 1650 Ti 4GB/1080p 是首要约束之一。VG、VT、VSM、clustered lighting、ReSTIR、GI/SSGI、SSR/SSSR、Atmosphere、Temporal、Dynamic Resolution、FSR/未来 AI Upscaling、Transparency/Media 保留为能力方向。本轮只展开 Surface V4；其他模块仅定义连接边界。

## 2. 当前源码与真正的切断边界

下表是审查快照的接线事实，不是 V4 实现声明；路径均相对于 `OEngine/src/`。实际调用和依赖须用符号检索，历史行号不能替代源码。

| 当前 producer / 入口 | 产品与真实 direct consumers | V4 处理 |
|---|---|---|
| `render/pipeline/RendererCore.ts`；`render/program/FrameProgramLowering.ts` | prepare/sync publication、TemporalFacts、SurfaceWork、FSR；commit/abort；Sky/Aerial→FSR→Radiometry/Bloom→Present | KEEP composition、唯一提交；REWRITE owner 接线和需求/key |
| `render/surface/SurfaceWorkRuntime.ts::addPublicationToGraph/addToGraph` | Tape 更新→coverage/work/coherence/cache→Geometry+Appearance→Lighting 六 signals→Reconstruct→radiance/reactive | DELETE 中央 runtime；换 native opaque 及简单 execution bins |
| `SurfaceFrameResources.ts`；`gpu/GpuSurfaceWorkAbi.ts` | 四 bank closed heap、field/guides、六 RGB+state、cache 控制/请求与 history；供旧 Surface shaders | DELETE 旧产品/预算协议；REUSE limits、物理计账、fence 退休和 bind caching 方法 |
| `material/AppearanceGraphCompiler.ts::compileAppearanceGraph` | scalar typed IR、CSE/DCE、依赖、共享 sample、过滤语义；publication/compiler consumers | KEEP 图语义/分析；去除 runtime cache policy 推导 |
| `material/ExactAppearanceDag.ts`；`shaders/appearance_exact_dag.ts` | frequency、C/X/Y、liveness 和 Tape packing；GPU `dag_code` 循环及 `dag_values` 全局 scratch | REUSE 分析/数学；DELETE GPU Tape 编码/解释执行及热 scratch |
| `shaders/appearance_program.ts::lowerAppearanceWgsl` | 已有 straight-line native 生成、实例常量槽；当前 sample callback 仅传 UV | REWRITE 为完整 native backend；存在 helper 不代表已经有 production native 路径，必须补显式导数/全部采样语义 |
| `gpu/AppearanceProgramRegistry.ts` | async pipeline lease、资源 preflight、有限 compile admission、device loss；publication 消费 | KEEP 生命周期；REWRITE ProgramKey/profile；DELETE 仅服务旧 cache 的 field witness interning |
| `gpu/GpuAppearancePublication.ts`；`gpu/GpuRenderWorld.ts::prepareAppearance` | 图/实例/coverage/kernel、Tape/metadata、事务；`CoverageRasterBindings`、`MeshletBucketRaster`、`RasterWorkPartitions`、`VsmAtlasRasterPass`、TemporalFacts、Surface | REWRITE native publication；参数/资源更新、abort/retry、coverage 和 VSM alpha consumers 同步切换 |
| `render/passes/PackedVisibilityPass.ts`；`gpu/GpuVisibilityKeyAbi.ts` | `r32uint` winner、Depth、MeshletWork、frame geometry；Surface、TemporalFacts、VSM demand、HZB/debug | KEEP winner 契约；32-bit key 携带 slot/primitive，generation/partition 外置；不把 Temporal identity 当 winner |
| `render/FrameGeometryArena.ts`；`shaders/surface_geometry_completion.ts` | metadata/source/filtered directories、clips/triangles/attributes、prepared/resident recovery；Visibility/Coverage/Surface，相关 VSM geometry | KEEP arena owner；REUSE reconstruction/normal/tangent/bary/gradient 数学；去除写旧 Surface heap 的 wrapper |
| `gpu/TextureResidency.ts`；`TextureBindingSetPolicy.ts` | residency/版本/采样 route；当前每 set 九 texture banks、最多四 resident sets；coverage/native consumers | KEEP 真实 residency；REWRITE 执行绑定政策与整机预算，不把未来 VT 宣称已完成 |
| `render/passes/LightClusterPass.ts`；`shaders/surface_work_lighting.ts`及 BRDF/provider helpers | cluster lookup/data/active list、溢出处理；VSM table/atlas/constants、IBL/sun/AO 被旧 Lighting 消费 | KEEP providers/数学；REWRITE native consumer；DELETE packet/history/rate orchestration |
| `render/temporal/TemporalFactsPass.ts`；`shaders/temporal_facts.ts` | motion `rg16float`、mask `rgba8unorm`、双份 `rgba32uint` identity；Surface 与 FSR/debug 消费 motion/mask，下一帧 facts 读 identity | KEEP 有效语义；REWRITE publication 接口与需求；history 留 Temporal owner，审查是否值得保存，不能无依据删掉身份拒绝 |
| `render/passes/fsr3/Fsr3UpscalerRuntime.ts`及 PrepareInputs/Reactivity/Accumulate | color/depth/motion/reactive/validity/两帧 exposure→FSR history/output→Radiometry/Bloom/Present | KEEP 已有算法 owner/曝光语义；REWRITE Surface inputs |
| `framegraph/FrameGraph.ts`；`ShadeGPUCommandContext.ts` | compiled dependency/resource events、late bindings、事务编码、submit/completion fence；所有 pass | KEEP 宏依赖/生命周期/兼容资源复用；不接管 shader 内部调度 |

当前 `GpuAppearancePublication` 同时耦合 coverage、材质数值更新、旧 field/cache identity 和 Tape；不能整类当 KEEP。Geometry 的复用对象是源产品和正确数学，不能继续要求所有 Appearance/Lighting 读取一个跨 pass GeometryRecord。V4 fused 内部可以直接把重建值留寄存器。

## 3. 历史教训与候选裁决

V1 的 O(P) 不是算法错误，昂贵 Geometry/Material 无条件 pixel-rate 才限制上限；V2 只 sparsify Lighting，前段与中间带宽仍在。旧 V3 把 proof/tree/cache 的管理当便宜，失败同时属于成本模型、抽象和 GPU 映射。R3/R4 的编译期分析、局部 Geometry 与事务发布有价值；General interpreter 的执行表示税、global closure cache 的精确 key/随机访问/atomic/publish 税和六 signal/history 产品不能因已写完就保留。

旧记录的 direct 27.540/27.382ms、warm cache 59.475ms，以及 cache scopes 分类漏计 44.827ms，仍只属于对应历史夹具/指纹。cache hit、预算有界、旧 oracle `passed` 均不证明净收益；本次没有新 GPU 测量。出处和原始限制保留在 [R4 执行 §2](../next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md#2-当前事实与开放责任)。

| 候选 | 物理工作/成本 | 灵活性与 WebGPU/AAA 影响 | 裁决 |
|---|---|---|---|
| A Visibility + native compute + fused opaque | 一次 winner reconstruction/material/light→HDR；默认不落 closure/signals。多 route 增 compact indices 与调度 | native graph 灵活；固定 banks + 每 bin dispatch；寄存器/随机 gather 是风险 | 默认 V4 |
| B Visibility + compact material resolve + deferred light | 若 closure 24B，一写一读增加48B/visible pixel；缩短 live range，真实跨 pass consumer 可获益 | GI/ReSTIR 等可有实际阶段需求；必须说明 energy/composition、产品 owner，不能恢复通用六 signals | 有数据/consumer 时允许有限 profile |
| C Forward+/GPU-driven raster specialization | 插值/derivatives 硬件便宜，opaque overdraw 执行材质/灯；WebGPU CPU 仍编码已发布 pipeline/binding scopes，不能 GPU 自动切 pipeline | 对部分透明/低 overdraw 适合；VG/winner 与复杂 alpha/pass duplication成本需核 | 不作为 M1 的第二 opaque production；透明模块将来独立论证 |

同主提案普通95% coverage模型：A optimistic/expected/pessimistic 约4.1/6.9/13.0ms；B 加48B roundtrip、提高有效 ALU 的假设下约5.0/7.9/14.5ms。均是未校准预测。C 的额外材质/灯执行以有效 overdraw d 乘对应 pixel 工作项；例如 d=1.5、原 useful pixel shading 6ms 时先增加约3ms，再扣去 A reconstruction/bin 税，不宣称跨路线实测优劣。A/B 的真实分界由 S4.0/S4.2 数据决定。

## 4. 目标帧流与 ownership

```text
GPU Scene / asset publication / texture residency / native programs
  → Geometry work / Virtual Geometry residency + LOD/SSE/HZB/meshlets
  → Visibility winner + Depth + frame geometry sources
  → dense one-route 或 GPU CompactPixelBins
  → native specialized opaque shading
      winner geometry reconstruction → material → direct/VSM/IBL
  → pre-exposed HDR + demanded SurfaceAux
  → effect-owned composition / Sky + Aerial / Temporal + FSR
  → Radiometry / Post / Presentation
```

Geometry owns LOD、SSE、HZB culling、meshlet queues/page residency；Surface 不能用 cache 为过度 Geometry 工作补偿。Visibility owns coverage/depth winner，包括 alpha test；被 alpha 拒绝的 primitive 不能在后续才擦除，否则后方 winner 已丢。主光栅/软光栅/阴影 coverage 使用同一材质语义。

Material compiler owns typed IR、依赖/频率、CSE/DCE、导数及 native source，设备无关图不拥有 GPU queue。Program registry owns source/layout/profile key、异步编译/lease/device epoch；publication owns instance parameters、resource routes 与事务提交。Native shading owner 只拥有输入绑定、执行和 HDR/Aux 写域；bins owner 只拥有 count/offset/index/indirect 的瞬态产品。它们都不拥有所有 effect 的 history/cache。

Lighting providers 保留 cluster/overflow、VSM query、BRDF、IBL/DFG、sun/atmosphere 和 AO 语义；模块化 WGSL helpers 由生成器组合进 native kernel，模块解耦不要求写显存。Renderer 只 composition；Frame Program 只有限需求/图结构与绑定角色；FrameGraph 只宏 dependency、lifetime、兼容资源 alias 和 execute，最终 submit 仍由现有帧 owner 完成。

## 5. Material execution 与工作组织

```text
Material Graph → validated typed IR → CSE/DCE + dependency/frequency
              → required geometry + C/X/Y coordinate ancestry
              → native WGSL → explicit layouts → async pipeline
Material Instance → parameter/resource publication → Program reference
```

Standard PBR、Unlit、Clearcoat 与合法 custom graph 都生成 native GPU code；custom 不回退 General VM。保留已有 graph 节点、normal filtering、texture decode/transform/sampler/minimum resident mip、cooked Product 和原 C/X/Y 语义。compute 不用隐式 fragment derivatives；winner triangle 连续扩展得到 C/X/Y，坐标祖先必须完整传播，包括非线性/嵌套 texture；采样用正确 `textureSampleGrad` 或等价显式 LOD，不能对 compact list 邻 lane 求屏幕导数。

Material/Frame/View/Dynamic frequency extraction 是编译期真实依赖分析。便宜值可 CPU/inline；需要保留 GPU 数学或资源查询的 uniform 子图生成 native update kernels，用同一 encoder 发布后消费。只物化实际跨频率边界，变化才更新，stable frame 不无条件重算；不是通用动态 proof 或 memo store。CSE 是共享 source query，不是按输出数重复计收益。

Instance count、unique Program、Pipeline、ExecutionBin 分开计：`ExecutionBin = Pipeline + compatible physical BindingSet/profile`。参数值/texture layer/实例数量不制造 ProgramKey；拓扑、采样语义、resource layout、output/profile/真实 specialization 可进入 key。10000 instances/几十 programs 合法；几十 native dispatch 合法。registry 的现有128 admission不是永久性能常量；发布期协商 capacity/compilation，未 ready 的新 publication不进入当前帧，保持已提交资产或显式失败/等待，不用 fallback VM 或默认材质遮错。

最初只两种组织：单 execution route 直接 dense；多 route 用 CompactPixelBins。8×8 tile 做局部计数/聚合→按屏幕 shard 的 histogram→small prefix→重访 Visibility、局部 rank/预留、compact pixel indices→每个已发布 bin 的 native indirect dispatch。pipeline/bind group 由 CPU 已知 publication 编码；count 由 GPU 决定，空 bin 的 indirect work 为零。无本帧 readback，CPU命令可随 unique execution bins 增长，不随实例数同比增长；不要求所有场景固定几个 dispatch。

给出首版计量参数而非冻结 ABI：B execution bins、S shards、P screen pixels、V valid winners、T tiles、U mean unique bins/tile。queue最多V个u32 index，约4V；按P保守容量4P；histogram约4BS，offset/cursor/args另计。tile dense counters需4B shared bytes，B增长会增加初始化/scan成本；portable实现不能依赖固定wave宽度。容量/2D dispatch/整数范围在发布与extent边界协商，越界不得丢像素。超 profile 显式拒绝发布/降低有依据的资源预算，或实现经过验证的新本地布局；不偷切旧 renderer。

SortedTileRoutes、额外PixelCompaction层、ProgramPage、NativeSwitch、Software VRS、缓存和自动策略选择系统均不在初版 M1 必需范围。CompactPixelBins 本身已经包含 pixel compaction，不能另加一个同名必经层。若 bins 的管理税/破坏 locality 不赚钱，先重新设计工作组织；不能造 cache/VM 补偿。

## 6. 像素、产品和精度边界

一个 opaque winner：读 visibility + queue context→MeshletWork/instance/material mapping；按 Geometry 要求读 arena或resident corners/attributes，重建 position/bary/UV gradients/normal/tangent；读实例参数与texture routes，native graph共享采样；寄存器内构造 PBR closure→cluster indices/lights→VSM table/atlas→IBL/DFG/sun/AO→应用正确 radiometry/pre-exposure→写 HDR。Geometry、C/X/Y临时值、Material closure、BRDF/direct/IBL累积默认留寄存器，不写旧 fields/六 signals。背景由明确 background producer 写一次，Sky/Aerial是后续 graph version；多route只写各自 winner，图内完整HDR域不能留下未初始化像素。

天然产品为 Depth、Visibility、HDR，Aux从真实 consumers倒推。以下是有限语义 profile，格式是预算起点，稳定 ABI 在 producer/consumer 实现后另写；未有 consumer 的字段不声明、不分配、不写。

| Profile | 可能需要的跨 pass产品 | 逻辑 budget / consumer |
|---|---|---|
| Base | HDR `rgba16float`；既有Depth `depth32float`、当前Visibility `r32uint`+外置context | 8+4+4=16B/pixel，1080p约31.64MiB；不是每个pass全读写 |
| Temporal | motion `rg16float` 4B；reactive/validity/change mask按实际consumer布局，当前mask合并候选 `rgba8unorm` 4B | 新增≤8B/pixel起点约15.82MiB；FSR/debug需求；identity history归Temporal，单独计账 |
| Reflection/GI（有真实consumer才启用） | world normal+perceptual roughness、albedo/metallic或有限response/flags | 8–16B/pixel候选；SSR/GI完整profile可能要求coat/response额外字段，须cost card，不能预分配 |

当前 Temporal identity 双 `rgba32uint` 是32B/pixel持久数据、1080p约63.28MiB，与winner16/32/64-bit选择无关。S4.2先保正确change/reprojection语义，S4.4再决定重算、有限签名/存储或删去无 consumer字段；不是硬性预算要求一定压缩。若新winner contract确实需要2×u32，使用8B并记多出7.91MiB；不能截断身份以达4B。现有32-bit winner+完整外部context是可用起点，不预先改宽。

内部 f32 数学默认保留；fp16或packed storage必须说明坐标系、值域、invalid编码、误差预算及图像验证。建议待验证预算：motion投影误差≤0.1 render pixel（越界/溢出显式invalid），普通normal方向≤0.5°、低roughness高光单独更严格评估，roughness quantization≤1/255、response线性域≤1/255；这些不是放宽旧测试的授权。若候选格式无法满足，保留更高精度。HDR保留已有pre-exposure与fp16范围契约，高亮/暗部/coat不只用均值误差。CPU reference不把JS transcendental结果视为GPU逐bit oracle。

## 7. 成本模型、4GB约束和可证伪性

沿主提案统一规划模型，不拼两份提案的不同假设：1080p P=2,073,600，8×8 T=32,400；95% V=1,969,920。普通PBR平均8相交lights、9个抽象texture queries（material/IBL/VSM合计，PCF tap另明细）、约1200 scalar FLOP-equivalent与6个sqrt/pow等special ops/visible pixel。FMA按2 FLOPs计；索引、整数、branch指令不硬换成FLOPs，其成本纳入实测有效吞吐与residual；special ops逐类校准，不假定pow与sqrt同吞吐。外存等效208B read+16B write=224B，其中64B random storage是总量子集。texture query不是单texel，filter taps/压缩/cache必须在校准模型单列；不得把峰值硬件带宽当预测。

沿主提案 expected 假设：有效 mixed memory 90GB/s、ALU 0.85TFLOP/s、texture 8G queries/s、random storage 35GB/s、special-op 等效 15Gop/s；全部是未测参数，需按具体 access pattern/操作类别校准。约441.26MB/frame外存、2.78ms compute floor、4.90ms bandwidth floor、2.22ms texture floor、3.60ms random floor、0.79ms special-op floor。主提案近似式是 `M + max(f) + α × (sum(f) − max(f))`，其中 `f=[max(tBW,tRandom),tALU,tTexture,tSpecial]`，expected `M=0.8ms, α=0.2`；重叠修正不是物理定律，须与真实混合 kernel核对。Texture/random均已包含bytes，不能在bandwidth再重复加一份流量。224B模型含 compact-list读取及管理假设；S4.0/2 one-route没有该queue，必须单独减掉对应读写/管理，不能把6.9ms直接当其测量预期。

| 工作负载 | 主提案预测 optimistic / expected / pessimistic ms | 规划解释 |
|---|---:|---|
| 高coverage普通PBR | 4.1 / 6.9 / 13.0 | 6–9ms量级目标，需S4.0/2校准 |
| 复杂PBR | 6.7 / 11.4 / 23.4 | 9–15ms量级目标，sample/ALU/spill敏感 |
| 高多灯 | 7.2 / 13.1 / 28.1 | 11–18ms量级目标，light/VSM预算单列 |

这些是 Surface/shading 规划，不是整帧60Hz承诺或 `<X ms`测试断言。旧 closed geometry48B+guides24B、six signals76B，再加实际varying fields F，单次写→读至少 `2×(148+F)` B/pixel，F=0也约613.8MB/fullscreen/frame，在90GB/s为6.82ms纯带宽地板；额外request、history、clear、Tape与不同真实coverage另计。必须按实际producer/consumer次数核，而非把所有字段假定每帧都全写。

24B compact closure写读为48V≈94.56MB，在90GB/s约1.05ms，拆kernel必须用occupancy/跨pass消费者收益覆盖这个成本和dispatch税。4B index queue一次写一次读约8V≈15.76MB、理论0.18ms，另有两遍winner/mapping、histogram/scan/atomics/随机gather。U=1.8 时两遍global tile-bin reservation约2TU=116,640；shared atomic约2V，barriers依实际kernel记录；B=32、S=64的单count plane8192B，不含offset/cursor。binning总管理不可只报prefix时间。

对optional机制令C为新增管理ms、W为可删除useful work ms、r为有效收益比例，净节省rW−C，break-even r=C/W；0/50/100%分别为−C、0.5W−C、W−C。100%仍无明显收益即拒绝；0%高税不能进普通hot path。binning是程序正确派发的组织成本，不假装cache hit率；比较against等价native分派（1-route bypass、或隔离probe的受控N-route扫描），按它实际减少的divergence/无效work和locality损失计算break-even，不能只拿VM当唯一对手。

4GB按物理对象去重记resident/transient/history/upload/retired及resize峰值。当前TextureResidency最高2GiB、Arena256MiB、旧Surface768MiB不能独立取满后称满足4GB。V4规划示例：texture pools1024MiB、geometry/scene640MiB、VSM256MiB、Temporal/Post192MiB、HDR/depth/visibility/Aux/bins128MiB、environment128MiB、inflight/upload/retired384MiB，合计2752MiB；剩余1344MiB是浏览器/driver/未核产品与安全余量，绝不是可用VRAM实测。M1必须按真实live/peak重新账算，streaming/质量/在途容量不能各自吞同一余量。native1080p/60的全开VSM+GI+SSR+Atmosphere+Temporal在1650Ti不作为现实保证；quality tiers、render scale/DRS/Upscaling由后续owner预算协同，不能隐藏减少材质语义/漏工作。

小型 calibration值得作为开发方法：顺序读/写/read-write、随机gather、unique/sharded/contended atomicAdd/CAS、texture sampling（过滤/LOD/locality）、ALU/transcendental、shared/barrier、dispatch/pass overhead，optional subgroup。固定输入/结果sink防DCE，GPU作业串行，timestamp可用才报GPU时间；不可用标明缺口，不将CPU wall冒充GPU ms。记录effective吞吐范围而非单峰值；微基准模型不代替混合PBR kernel/真实production。不扩成一个大型runtime校准/自动调度系统。

## 8. WebGPU物理约束

以[WebGPU](https://www.w3.org/TR/webgpu/)及[WGSL](https://www.w3.org/TR/WGSL/)规范、运行时features/limits与实际编译验证为准。标准compute、u32 atomics、workgroup memory、显式Grad、indirect dispatch和async pipeline可直接用于基线；`shader-f16`、timestamp、subgroups等需协商，portable算法不得假定32-lane wave、全局barrier、cross-workgroup spin progress或设备上的subgroup吞吐。

CPU仍需选择pipeline/bind groups再编码各indirect command；GPU不能仅通过一个program ID执行任意pipeline切换。固定显式texture banks/arrays-of-layers是当前可用入口，不能把D3D12/Vulkan bindless descriptor arrays、ExecuteIndirect pipeline切换、mesh shader、硬件VRS或ray tracing当portable基线。若目标实现暴露额外能力，另做有限profile与本地降级，不建另一renderer。标准FrameGraph alias是兼容资源不重叠寿命复用，没有通用placed-resource heap alias。

fused shader 的bindings必须包括winner、geometry sources、instances/publication、material banks/samplers、cluster、VSM、IBL、exposure、AO/atmosphere和实际outputs的完整资源清单；逐stage/storage/sampled texture/sampler/workgroup limits在资源创建前preflight。当前九banks＋provider slots正好接近已有profile预算，不能只用现有policy的“reserved7”常量证明完整fused legal。不同stage可用不同资源布局；必要pass边界由limits/实际成本决定，不许以重建通用record逃避审查。

## 9. AAA连接合同（只到接口）

| 系统 owner | 连接核心的输入/输出 | composition/history约束 |
|---|---|---|
| Geometry / VG | Scene+view→LOD/SSE/HZB/meshlets/page residency→winner可恢复源 | Geometry正确coarse/missing profile由Geometry负责 |
| VT | native sampler→page table/atlas/feedback→texture value+footprint/resident mip | pages/cache归VT；异步streaming影响后续帧，不GPU→CPU→GPU本帧控制 |
| Lighting / VSM | position/normal/light→query page table/atlas/constants→visibility | VSM owns residency/cache/content revisions；native query保既有PCF/missing政策 |
| ReSTIR | finite material response+geometry/light candidates→reservoir/evaluated direct→HDR composition | reservoir/reprojection/normalization/visibility归ReSTIR；替换对应direct项，不能又加一遍fused direct |
| GI / SSGI | Depth/normal及实际算法需要的response/radiance→indirect | GI history归GI；指定替换/补充diffuse IBL的权重/置信条件，避免重复能量 |
| SSR / SSSR | Depth/HZB/normal/roughness及response→reflection/confidence | SSR history归SSR；指定replacement/blend of specular IBL，coat需明确响应，不能直接再加完整IBL |
| Atmosphere | camera/depth/exposure+LUT providers→Sky/Aerial HDR graph versions | provider独立；background与opaque writer/颜色域明确 |
| Temporal / FSR / future AI | HDR/depth/motion/reactive/validity/exposure→reconstructed output | history属于具体重建owner；AI按实际SDK契约设计，不预建统一history |
| Transparency / Media | 独立ordered/integration work→HDR和实际reactivity/motion需求 | 不冒充opaque winner；blend/order/energy由该模块设计 |

跨pass理由真实存在时，可引入finite compact deferred profile或effect-owned response产品；recipe从consumer反推，不把Surface变成“Universal SurfaceRecord”。详细算法、格式、阶段、质量条件和完整donor在该模块成为currentSlice时再设计。

## 10. 来源、风险与未来修订

固定来源、license、具体函数及拟本地阶段见[来源账本 V4条目](../porting/next-renderer.md#v4-planning-source-map)。Wicked的analyze/resolve/shade/host支持分类与native消费的物理参考；Forge支持bary/derivative/SampleGrad数学；现有Filament/MaterialX/scan来源支持owner/编译/扫描边界。不把其bindless/wave/nativeAPI照搬为WebGPU，也不把几个参考文件叫完整算法采用。

最容易再次失败：native program×BindingSet膨胀、编译/发布卡顿、fused live ranges导致spill、compact indices破坏texture/cluster locality、高coverage随机Geometry访问、误改C/X/Y/LOD/normal、bindings超limits、Aux膨胀、history中央化、计时scope漏算和微基准过拟合。分别在 S4.0–5用native数据、程序/route矩阵、独立oracle、真实consumer、完整物理账和failure分类核对。

母稿不保存阶段状态。改变选择必须写明被证伪假设、真实work/quality/limits与Cost Card；不能为了pass少、dispatch固定、cache hit高或旧测试形状恢复R3。当前实施单元及边界只读[执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)和workstream。
