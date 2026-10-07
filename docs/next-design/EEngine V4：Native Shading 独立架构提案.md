---
id: next-design/eengine-v4-native-shading-2026-10-07
state: history
supersededBy: ./eengine-v4-native-shading-2026-10.md
---

> 2026-10-07 V4 authority 切换：本文保留当时的提案、决定或实施记录，仅供历史追溯。正文的“current / 当前 / 必须 / 已完成”均属原快照，不再定义未来生产架构；其中性能结果、失败和未验证声明不改写。唯一当前依据见 [V4 authority](./eengine-v4-native-shading-2026-10.md)，文档切换不表示代码已切换。
# EEngine V4：Native Shading 独立架构提案

日期：2026-10-07。性质：待评审的设计提案，不是实现声明，不替换已接受的设计、workstream 或执行计划。`state: current` 表示本文作为本次分析仍有效，不表示 V4 已成为生产架构。下文预算是设计约束，性能数字是未校准模型，除明确标注的历史报告外均非实测。

## 1. 决策与证据边界

推荐 **Visibility + GPU execution-bin pixel compaction + native specialized shading**。普通不透明路径融合 Geometry reconstruction、Material、直接 Lighting 和环境光，写 HDR 与有消费者的 SurfaceAux。删除通用 GPU Typed Tape、全局 Closure Cache、通用 Signal History、六路全屏信号和 SurfaceWorkRuntime。保留材质编译器前端、数学、资产、GPU Scene、Virtual Geometry、Visibility、FrameGraph 及各效果的独立资源 owner。

这不是“所有场景只有一个 fused pass”。需要跨像素/跨帧处理的 ReSTIR、GI、反射，由其依赖决定必要的阶段边界。同一套 native compiler、几何入口、材质语义和 provider contract 生成这些阶段，不恢复另一条旧 renderer。默认融合，按真实消费者拆分；不再为了潜在复用先落一套通用全屏 Surface 数据。

**不能宣称这是所有硬件、场景上最快的架构。** Forward+ 在大三角形、低 overdraw、少 program 的场景可能更快；compact deferred 在复杂跨像素光照下可能更快。选择 V4 的依据是：它能利用本仓库的 Virtual Geometry/Visibility 投入，去掉已经可见的解释器与中间产品成本，又允许针对真实跨 pass 依赖作有限拆分。

本次执行了 `git fetch origin master`，本地 `master` 与 `origin/master` 均为 **b69a0a60b13930212fdc98f988443186fad024e4**；开始时工作区干净。源码分析固定在这一 revision。本文未实现 V4，未启动新的 GPU benchmark，也没有把旧报告升级为当前快照性能证据。

事实分三层：

| 层级                | 本文可支持的结论                                          | 不可据此声称                               |
| ------------------- | --------------------------------------------------------- | ------------------------------------------ |
| 固定 master 源码    | 调度、分配公式、数据依赖、解释器访问、生产接线存在        | 实际 cache hit、DRAM 流量、occupancy、帧时 |
| 本地历史 JSON       | 指定 fixture、旧 build、短时间序列的原始 timestamp 和计数 | 正式 P50/P95、所有场景性能、GTX 型号已识别 |
| V4 analytical model | 在显式吞吐/流量假设下的数量级、敏感性、break-even         | V4 已达到模型帧时、AAA 已达 60 FPS         |

历史 JSON 中 adapter 仅识别 `nvidia/turing`，device/description 为空，不能据此确认那张卡就是 GTX 1650 Ti。目标预算按用户指定 GTX 1650 Ti 4GB 建立。NVIDIA 公布其带宽为 **up to 192 GB/s**，不把这一数字当有效吞吐。[NVIDIA 规格](https://www.nvidia.com/en-gb/geforce/laptops/30-series/)

### 1.1 源码入口与实际链

当前 composition 入口是 `OEngine/src/render/pipeline/RendererCore.ts`，由 `render/program/FrameProgramLowering.ts` 接出 publication → TemporalFacts → SurfaceWork → Atmosphere/FSR/Present。`SurfaceWorkRuntime.ts` 的实际工作包含 reset、四个 bank 的 coverage、template prefix/packet、fixed/general Geometry/Appearance、可选 closure key/nomination/unique evaluate/publish、Lighting/history、四个 bank reconstruct；不能把它概括成只有三个廉价 pass。

当前已有 `shaders/appearance_program.ts::lowerAppearanceWgsl`，能从 IR 生成 straight-line WGSL，`AppearanceProgramRegistry.ts` 已有异步编译和去重生命周期。因此 V4 不需要从零发明 native 材质编译器；需要重写其 derivative/frequency lowering 与生产调度接线。现有 native helper 的存在也不证明任意图已经走 native 主链。

## 2. 对四代历史的独立判断

版本名并不严格对应独立完整 commit。实际历史存在交叉：例如 `c48b7df3` 的 `surface_execution.ts` 已有 dense/binned/fallback，`shading_frequency.ts` 在当时只允许非常有限的静态 Unlit sharing；其父提交 `opaque_lighting_resolve.ts` 仍读多个 Surface/Lighting attachment。因此下面用 V1/V2/V3 描述设计范式，不把 prompt 中的示意图冒充每个历史 commit 的精确执行图。

| 范式                   | 独立判断                                                     | 真正问题分类                                                 | V4 保留的教训                                                |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| V1 direct pixel        | 可作为低管理成本正确性基线；O(P) 写颜色本来就合理            | 主要是工作频率/硬件映射；若 geometry、texture、BRDF 全无条件逐像素，coverage 放大成本 | full-rate 可以保留，但必须是 native、按依赖裁剪的 full-rate  |
| V2 signal rate         | 降 Lighting rate 有真实价值，但无法追回此前已支付的材质与几何成本 | 优化边界过晚；中间数据/前端成本模型不完整                    | 先消除不必要工作和读写，再判断降频                           |
| 旧 V3 proof/tree/cache | 身份正确性和唯一 writer 在算法局部是合理工具；把它们变成屏幕级通用运行系统不合理 | 算法选择、物理表示、调度和成本模型共同失败，不只是某段 shader 写慢 | 证明、lookup、publish 必须比省掉的 exclusive work 便宜，不能以 evaluation count 代替时间 |
| 新 V3/R2/R3/C          | 编译期依赖、局部 geometry completion 是进步；General VM、统一历史、六信号再次把管理和带宽放回中心 | execution representation tax、资源产品过宽、owner 边界膨胀；局部优化不解决整体 | 保留 compiler intelligence，删除通用运行协议                 |

在 `09449d6d` 的 `SurfaceCellClassifierPass.ts` 可直接看到 facts、canonical addresses、proof family tiles、shared certificates 等 GPU 阶段；`SurfaceWorkRuntime.ts` 组合 classifier/demand/geometry/field/signal store/publish。这支持“复杂管理链确实存在”，但本次未找到并逐项复现旧 V3 的“几百 ms”统一基准，因此不拿该数字进行跨代加减。

### 2.1 General VM 的税在哪里

当前 `shaders/appearance_exact_dag.ts::appearance_dag_evaluate` 对每条指令读取 code、mask、op、operand、control，执行 switch，并从 `dag_values` 全局 storage 读取和写回 scalar/vector C/X/Y。它不是仅仅“多一个 switch”：它破坏了编译器跨节点常量传播、寄存器分配和指令调度，把临时值的物理位置固定成 memory ABI。

粗算一个 scalar 二元节点：32 B 指令编码逻辑读取，8 B 输入，4 B 输出；若 C/X/Y 全部活跃，数值读写扩大到 36 B。code 可能缓存，不能把全部逻辑字节都算成 DRAM；但 100 个活跃 scalar 节点，仅中心数值读写就有 1,200 B/pixel、1080p 约 2.49 GB，远超最终 HDR。native 中相同中间值可能完全留寄存器。native 也可能 spill，所以 IR 消除无用输出和缩短 live range 必须继续保留。

重新汇总 `.local/b1-b2-review/surface-work-native3.json`：旧 Generic 计时帧的 generic scopes 合计约 73.7–74.7 ms；隔离 straight-line reference 的最后一个帧约 45.4 ms。该 reference **不是生产替代路径**，其他 scope 也变化、样本少且无 clock 控制；它支持 native 值得验证，不能支持“V4 至少快 X 倍”的保证。

### 2.2 Closure Cache 的失败证据比 hit rate 更直接

重新读取 `.local/c-repair/cache-cost-production.json`，按所有 `Surface/` labels 求和：

| 历史测量                     | GPU Surface pass sum |              active bytes |
| ---------------------------- | -------------------: | ------------------------: |
| direct，诊断关，两次         |   27.540 / 27.382 ms | 438,085,360（417.79 MiB） |
| cache，诊断关，首个计时帧    |            60.932 ms | 521,415,664（497.26 MiB） |
| 再八帧预热后的 cache，诊断关 |            59.475 ms |                      同上 |

warm cache 中 generic scope 降到约 6.03 ms，但 closure 相关 labels 合计 **44.827 ms**。原有 phase 分类曾漏掉这些 labels；这是测量归类问题，不能把未分类成本填成 0。独立 diagnostic frame 的 1,184,706 hits / 2,072,520 visible 不能当作该 timestamp frame 的同步计数。

尤其这个 fixture 的 key 是 **7 words**，不是最大 96 words。因此“只要把 key 再缩窄”不是有证据支持的解法。cache 不只是 lookup，还要求 key 输入、处理拒绝/overflow、保存 continuation、nominate、publish；省掉的 exclusive work 才能算收益。

结论：删除它作为常规 Surface 机制。以后某个局部算法需要 cache，必须按自己的输入、失效与成本单独立项。

## 3. 三套候选架构的公平比较

所有候选使用相同 BRDF、纹理 LOD、阴影质量、同一 render resolution；以下不把降低质量算架构收益。时间只比较不透明 shading 阶段；共同的 Scene/VG/Visibility、shadow map 生成、GI/SSR、Temporal/Post 不在内。C 的深度/几何额外开销另列。

| 项目                 | A：Visibility + native compute，默认 fused           | B：Visibility + native material resolve + compact deferred   | C：GPU-driven raster Forward+                                |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| Material flexibility | 任意合法图编译 WGSL；program 维度分派                | 任意图可求值，但 deferred BRDF 必须有有限 closure schema 或扩展 | 任意合法图编译 fragment WGSL                                 |
| 中间产品             | HDR + 按需 Aux                                       | 16–32 B/pixel 紧凑 closure，再读 Lighting                    | HDR + 按需 Aux；高级效果可能要求 prepass                     |
| 材质求值次数         | 可见 pixel 一次                                      | 可见 pixel 一次                                              | 有效 overdraw × quad amplification；prepass 可降低前者       |
| Geometry             | Visibility fetch + analytic derivatives              | 同 A；Lighting 从 depth 重建 position                        | 插值器与 fragment derivatives 有优势；顶点/meshlet 工作受 raster 组织影响 |
| GPU 弱点             | compaction、随机 gather、寄存器压力                  | 全屏 roundtrip、closure schema 对复杂材质限制                | 小三角形 helper lanes、overdraw、每 program/binding set draw |
| 光照复杂度           | 普通 clustered 很合适；极复杂 shader 可能 spill      | 可单独优化 light loops、reservoir、occupancy                 | 普通 clustered 很合适，跨像素效果需额外产品                  |
| CPU commands         | O(resident execution bins)，不按 instance            | O(material bins)+有限 Lighting pipelines                     | O(raster bins/segments)，WebGPU 没有通用 execute-indirect command stream |
| VRAM                 | 最低的通用 Surface 工作集                            | A + closure，可能还需 extra HDR                              | 低；但不能忽略 geometry/draw queues 和高级效果 Aux           |
| WebGPU 友好度        | 高，需解决 texture banks 和 explicit gradients       | 高，binding pressure 通常更低                                | 高；标准 raster 最成熟，但大规模异构几何批处理受 API 限制    |
| AAA 扩展             | 有需要时开放局部阶段边界                             | 跨像素光照最自然                                             | 依赖 Visibility/thin Aux 支持 screen-space 系统              |
| worst case           | native full-rate + bounded queue；不存在 cache storm | full-rate + 固定 roundtrip                                   | 高 overdraw/微三角形可能最坏；depth prepass 不消除 helper lanes |

### 3.1 定量比较与选择条件

高 coverage 普通 PBR，95% 可见、平均 8 个相交 lights，A 的显式模型见 §9：约 **4.1 / 6.9 / 13.0 ms**（optimistic / expected / pessimistic）。

B 若多写再读 24 B closure：额外 `48 × 1,969,920 = 94.56 MB/frame`，90 GB/s 下 1.05 ms 带宽成本。若拆分将有效 ALU 从 0.85 提高至 1.1 TFLOP/s，compute floor 从 2.78 降为 2.15 ms，但普通场景已 bandwidth-bound；按同一混合公式、0.95 ms 管理成本，估计约 **5.0 / 7.9 / 14.5 ms**。这是候选估计，不是测量。

C 假定有效 shading overdraw 1.15、低 helper amplification，省下部分 compute geometry gather/compaction，模型区间约 **3.5–5 / 5.5–8 / 11–17 ms**；另需核算 prepass/顶点重复与 draw bin 成本。若有效 overdraw/quad amplification 从 1.15 升至 2，主要材质/光照成本约乘 `2/1.15`，不再占优。不能把大三角形 Forward+ 优势推广到微三角形 VG 场景。

为使 C 可复算，JSON 给出一个具体样例：无 amplification 时 read=160 B、write=16 B、ALU=1,000 FLOPs、9 samples、6 SFU；read/ALU/samples/SFU 乘1.15，最终write不乘。管理成本0.20/0.35/0.70 ms，额外geometry工作0.20/0.50/1.00 ms，得到 **3.8 / 6.5 / 12.5 ms**。B 的JSON将A总流量增加48 B、ALU有效吞吐乘1.1/0.85、管理成本增加0.15 ms。B 使用聚合近似，实际串行阶段的roofline可能更差；三个候选都必须最终测完整链，不能选择性忽略C的geometry或B的stage tail。

同为32个resident execution bins、Temporal profile时，候选的临时存储和命令示例如下。pipeline数是这一profile的实际编译数量，不乘材质instance数；不含共同的Geometry/Shadow/Post pipelines。

| 物理量                                |                    A |                                            B |                                                            C |
| ------------------------------------- | -------------------: | -------------------------------------------: | -----------------------------------------------------------: |
| 基础Depth/Visibility/HDR/Temporal Aux |            47.46 MiB |                                    47.46 MiB |                        47.46 MiB（保留Visibility给后续效果） |
| shading临时队列/closure               |    ~7.91 MiB+<64 KiB |         A的队列+24 B/pixel closure=47.46 MiB | 无pixel list；GPU draw/vertex工作队列按几何量计，不能按P捏造固定值 |
| shading通用persistent per-pixel store |                    0 |                                            0 |                                                            0 |
| material/shading pipelines            |                   32 |                  32+约1–4 Lighting pipelines |           32 opaque pipelines，另有coverage/raster state变体 |
| shade命令                             | 32 indirect dispatch | 32 material dispatch+约1–4 Lighting dispatch |              至少32 indirect draw，geometry segments可能增加 |
| pipeline switches                     |         约31+binning |                              约32–35+binning |                           约31，额外raster state/segment另计 |

三者共同的程序code/pipeline driver分配、scene textures、geometry和effect histories没有计进上表；标准WebGPU无法准确查询pipeline内部GPU内存，按§12留不透明余量。B的24 B closure若能替代部分Aux，峰值可以下降，不能既复用又重复计费；其写读带宽是否重叠也要按真实consumer重算。

**选择 A 是有条件的架构选择，不是证明 A 永远最快：**

1. 现有 Visibility/VG 已提供遮挡后的唯一 winner，A 直接利用；C 作为透明、毛发或特殊 raster 材质的算法路径，不恢复整套 opaque 双生产链。
2. A 的主要风险可以用两个很小的实验推翻：native fused 相比 compact deferred 的寄存器/带宽结果；GPU binning 相比有限 native 分支的净收益。
3. 如果相同质量下 B 连续在目标典型场景快 ≥10%，且额外 closure ≤32 B/pixel，应采用 B 的阶段边界。架构保留的是 native compiler 与薄数据合同，不是“必须 fused”这个口号。

## 4. 推荐的完整 frame flow 与 owner

```text
CPU asset publication / async native compilation / streaming uploads
        ↓（stable frame 不遍历材质实例编命令）
GPU Scene → Geometry LOD/SSE/culling/HZB → Meshlet work / resident pages
        ↓
opaque + alpha-tested Visibility / Depth
        ├→ depth hierarchy / light clusters / VSM receiver demand
        ├→ VSM dirty-page allocation → caster work → shadow atlas
        ↓
GPU execution-bin count → small prefix → pixel scatter + indirect args
        ↓
native program dispatches
  winner geometry → material → direct/IBL → HDR + requested Aux
        ↓
optional effect-owned GI / SSR / reservoir phases and composition
        ↓
Atmosphere / transparency / reactive contribution
        ↓
Temporal reconstruction or upscaling → post → presentation
```

图中的可并行节点表示无数据依赖，不承诺 WebGPU 能显式使用独立 async compute queue。统一 command encoder/queue submission，跨阶段依赖由 FrameGraph 表达；可有多个 pass，不为特性增加独立 frame submit。

| Owner                | 唯一责任与输出                                               | 不承担                                                |
| -------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| GPU Scene / Assets   | 实例、变换、材质参数、资源引用、资产发布与 streaming 生命周期 | 屏幕级缓存命中决策                                    |
| Geometry             | SSE/LOD、hierarchy traversal、HZB、meshlet culling、deformation、page residency；输出 Visibility 可解析的 geometry 产品 | 依靠 Surface sharing 掩盖过多 geometry work           |
| Material Compiler    | IR、依赖/frequency、CSE/DCE、explicit gradients、native code 和所需字段 | GPU 帧调度、全屏历史                                  |
| Program Registry     | topology/code/layout key、异步编译、ready publication、pipeline 生命周期 | 材质值缓存、GPU 可见性 readback                       |
| Shading Work         | 临时 count/scan/scatter/indirect args，native dispatch composition | closure memoization、history、证明树、retirement 总管 |
| Lighting / VSM / IBL | light lists、shadow/IBL 产品、BRDF 函数、独立算法历史        | 所有材质的执行协议                                    |
| Temporal / GI / SSR  | 自己的历史、disocclusion、质量阈值、reset 和 budget          | 统一 Surface identity 系统                            |
| FrameGraph           | macro dependency、版本、生命周期、资源池复用、提交前后生命周期 | WGSL 内部微调度、寄存器分配、逐像素任务系统           |

FrameGraph 的 alias 在标准 WebGPU 中主要是**不重叠生命周期复用同一兼容 GPUBuffer/GPUTexture**；没有通用显式 heap alias API。不能像 Vulkan placed resource 那样任意让不同格式/usage 的资源共享一块底层 heap。

## 5. Material execution：保留智能编译，退出解释器

### 5.1 IR → native WGSL

`Material Graph → validated scalar/vector IR → CSE/DCE → dependency/frequency partition → derivative liveness → native WGSL`。

保留 Material/Frame/View/Dynamic/Geometry/Texture dependency；把 `ExactAppearanceDag.ts` 中 frequency 和 liveness 分析从 Tape 编码中分离。输出：

- publication-time 常量；
- material/frame/view 改变时更新的边界值；
- sample-frequency native 函数；
- alpha/coverage 所需的最小子图；
- deferred effect 真正需要的响应字段。

只有更新值真的值得存储，才生成 uniform/update 产品。一个便宜乘法每像素重算可能比额外 storage load 更便宜。基于 CPU 输入的更新可由 CPU 编译/求值；GPU 生成动态输入则使用 native update kernel，仍在同一 submit 链，不做 GPU→CPU→GPU 本帧控制。

General 自定义图必须是支持运算集合内的任意合法拓扑，不能只支持 Standard 然后把其他图永久降级。动态循环必须有语言级有界语义；非局部采样和 scene texture 依赖成为显式 graph dependency。材质图不等价于不受限任意 WGSL。

### 5.2 C/X/Y 与导数不能在改 native 时丢失

压紧后相邻 lane 不一定是屏幕邻居，更不一定同 primitive。不能对新 lane 排列使用 implicit derivative，不能拿另一个 primitive 的 UV 作差。Geometry 从同一 winner triangle 的 clip vertices 重建 perspective-correct barycentrics 和 pixel footprint；调用 `textureSampleGrad`/显式 LOD。

对 UV 的非线性或不连续图变换，保留已有 C/X/Y 语义，仅对影响 texture coordinates 的 ancestors 生成三点表达式。不能把 finite-difference 偷换成解析链式微分后声称结果等价；`fract`、clamp、procedural warp、依赖 texture 的坐标尤其需单独验证。只影响最终颜色的节点不执行三遍。近裁面、小/退化三角形、背面/tangent sign、动态变形、不同 UV set 都在 geometry/compiler 的权威入口处理。

### 5.3 Instance、Program、Pipeline、ExecutionBin 是四个不同概念

```text
MaterialInstance = ProgramID + parameter block + logical texture routes
Program         = topology + operation/sampling/derivative semantics
Pipeline        = Program + Aux profile + provider/capability/layout variant
ExecutionBin    = Pipeline + physical texture/resource binding set
```

10,000 instances 可以共享 24 个 programs，但若每个 program 用两个 binding sets，本帧 resident dispatch bins 可能是 48，不能仍报 24。不得把颜色、粗糙度数值、texture layer ID 编进 Program key；也不得把会改变采样含义的 sampler/decode/derivative 语义从 key 中删掉。

Standard PBR、Unlit、Clearcoat 是常见 native templates；按真实使用的 normal/emissive/coat 裁剪，避免每个布尔 feature 笛卡尔积预编译。先维持 3 个 Aux profiles 和少数 provider signatures，仅编译实际组合。发布期统计 `instances/programs/pipelines/executionBins/sourceBytes`，分别显示。

### 5.4 编译与 shader cache

复用 `AppearanceProgramRegistry` 的异步 admission、去重、引用计数和失败处理；重写与旧 field publication 的耦合。编译在资产进入可见生产集合前完成。编译失败报告具体 program；加载期不发布尚未 ready 的材质；热编辑可保留该 program 上一次已编译语义并标明未更新，不用 GPU VM 作隐蔽 fallback。

持久化缓存保存 canonical IR、WGSL、编译器版本、语义与 capability key；device 内缓存 pipeline 对象。标准 WebGPU 不提供应用可导出/重新加载的通用 pipeline binary cache，不承诺 IndexedDB 中的 WGSL 等于免编译。设备丢失重新创建，异步编译并发限制从 2–4 开始，以 CPU/driver 实测调整。

### 5.5 ProgramPage 与 megakernel

默认一 program 一 native pipeline。可将 4–8 个**小且相似**的 native functions 放入一个 page，使用每 workgroup uniform 的 selector；selector 是一次静态 switch，不是每节点 opcode loop。pixel list 必须按 program 分 run 且每 workgroup 不跨 run；否则所谓 uniform page 退化成 divergent megakernel。

不能仅因 dispatch 多就分页：大分支可能使所有分支承担最坏 register allocation、增大 code cache 和编译时间。大/稀有 custom program 单独 pipeline。page 是通过 §10 break-even 才启用的可选表示，不是新的 VM，不预设全场景固定 page 数。

## 6. GPU work organization 与完整容量

### 6.1 首选：分片 histogram + compact pixel list

V4 初始普通路径建议使用**按 execution bin 压紧的 pixel indices**，不直接照搬 `(tile,program)` 每项 64-lane 的做法。原因是 compact list 有简单的 P 容量上界，且不随 tile 中 program 混杂导致大量 inactive lanes。8×8 仍作为分类和局部聚合单位。

算法是具名本地方案 **TileAggregatedPixelBins**，不是宣称已有上游完整移植：

1. 每个 8×8 workgroup 读取 Visibility 与 material→bin 映射；无效/background 不计入。
2. 在 workgroup shared memory 中对实际 bin 计数。目标常用 profile `B≤128` 时使用 B 个 u32 dense counters，所有 lane 初始化/等待；每个有效像素一个 shared atomicAdd，获得局部信息。每个非空 tile-bin 将其 count 原子加到 `count[bin, shard]`。shard 取屏幕宏块映射，例如 64 个，不以全屏同一个热点 counter 承载全部流量。
3. 对 B×S counts 做 prefix，给每个 bin 连续区间及 shard 子区间，生成 dispatch args。B=32、S=64 时只有 2,048 项；保留无 subgroup 的 shared scan，较大的表才使用多 dispatch 分层 scan。没有 cross-workgroup spin wait。
4. 第二次遍历 Visibility，重建 tile-local counts/ranks，为每个非空 tile-bin 一次 atomicAdd 预留其 shard 内区间，把每个像素的线性 index 写入唯一位置。
5. CPU 遍历**已发布且 resident 的 execution-bin 表**，绑定 native pipeline 与资源，`dispatchWorkgroupsIndirect`。空 bin 的 GPU args 为 0，CPU 不读本帧 counts。

每帧count前清零小型histogram；prefix同时初始化scatter cursors与所有bin的indirect args，包括空bin。args使用独立、带STORAGE|INDIRECT usage的buffer，在后续shading dispatch中不再作为可写storage绑定。清零/copy若存在均计入M；无需复制整屏list，也不读取上一帧尚未初始化的queue内容。

队列最多 P 个 u32，1080p **7.91 MiB**；按 GPU count 上取整 dispatch，末组按 count mask，不需要每 bin 额外完整屏幕队列。每个像素只属于一个 opaque winner、一个 bin、一个 list slot、一个 HDR writer；alpha coverage 在 Visibility 前确定。背景由独立 sky/clear 所有。

count 与 scatter 使用同一发布快照，期间不得变更 bin mapping/visibility。`sum(count)≤P` 可结构保证；不通过截断 counter 漏像素。尺寸乘法/dispatch 维度在 CPU 创建前 checked；超过单维 65,535 workgroups 使用合法二维 dispatch。不能让 queue capacity 决定画面是否缺失。

`B>128` 不截断材质。先按实际能力增加 dense counters，直到 shared-memory/成本预算；超过它用局部 64-lane key sort/run aggregation 产生相同 count/scatter 结果，最多 64 个 unique keys/tile。bitonic sort 最多 21 个 compare-exchange stages，必须计入它的高管理成本；这是大 program 数退化路径，不是普通 hot path。长远用资产拓扑规范化、纹理 pooling 和有限 page 降低 B，但不能把 10,000 个真正不同程序谎称几十个。

### 6.2 数量级与最坏情况

1080p：P=2,073,600，tile T=240×135=32,400。95% coverage：V=1,969,920。假设平均 tile unique execution bins U=1.8：

| 工作                                |                                                           量 |
| ----------------------------------- | -----------------------------------------------------------: |
| 两次分类 Visibility 读取            |                           16.59 MB，加 material/bin 索引读取 |
| pixel list 写 + native 读取         |                                     15.76 MB（95% coverage） |
| 全局 append/reserve atomicAdd       |                                      约 2TU=116,640；最坏 2V |
| shared atomicAdd                    |                           约 2V=3.94 million；争用形态需校准 |
| WG barriers                         | count 约 2、scatter 约 3，共约 162,000 次 workgroup barrier events；不是全 GPU barrier |
| histogram/offset/cursor             |    B=32、S=64，三份 u32 表共 24 KiB；加 args/headers <64 KiB |
| binning dispatch                    |         count + prefix + scatter，典型 3；大 prefix 需要更多 |
| shade dispatch                      |             B=32 时 32；pipeline 切换约 31，另加 binning/sky |
| native kernel 内管理 atomic/barrier |                 默认 0 / 0；VT feedback 等算法自己的操作另算 |

list 的像素顺序不保证全局 screen order，但按 tile 聚合、按屏幕 shard 保留局部性。程序一致不等于纹理地址一致、light cluster 一致；随机 gather 必须进入模型，不能把 compaction 后全部读取当顺序读取。

### 6.3 `(tile, program)` 什么时候值得

每项可存 `tileID + maskLow + maskHigh` 共 12 B。CPU dispatch 维度仍为 execution bin，GPU item 为 `(tile,bin)`；mask 只控制哪些 lane 参与，绝不能让 64 lanes 全部执行该 program 再丢结果。

| tile 内 U | 粗略 active-lane fraction | 64-lane group 数 / 全屏一次 | 12 B/item 的有效 queue 大小 |
| --------: | ------------------------: | --------------------------: | --------------------------: |
|         1 |                     ~100% |                          1× |                    0.37 MiB |
|         2 |                      ~50% |                          2× |                    0.74 MiB |
|         4 |                      ~25% |                          4× |                    1.48 MiB |
|         8 |                    ~12.5% |                          8× |                    2.97 MiB |
|        16 |                    ~6.25% |                         16× |                    5.93 MiB |

active fraction 只是均匀分布近似；同 wave 中 mask 的位置决定实际浪费，不能简单把 shader 时间乘 U。每 program 预留 T 项会产生 `12BT` 容量，B=64 已为 **23.73 MiB**，远大于表内“有效元素”。使用 prefix 后紧凑 item pool 可避免这个容量，但增加 scan/scatter，不是免费 append。

判断：大面、少 program、重空间/纹理局部性时 tile item 很合适；高 program entropy 或微三角形时更应考虑 pixel compaction。初始 V4 不同时建设三套自动调度器；先做一个 compact baseline，再用真实 U 分布和 A/B fixture 决定是否增加 tile profile。比较实验不要求保留旧 production renderer。

## 7. Minimal SurfaceAux：具体格式与误差合同

基础已有 Depth、Visibility、HDR。世界位置优先由 depth/camera 重建；View vector 由 position/camera 得到；不保存全屏 position/tangent/CXY。带法线贴图的 shading normal 一旦被多个 screen-space consumer 使用，materialize 一次通常比每个 consumer 重跑材质便宜。

下面是**提出的 profile**，尚非已稳定实现 ABI。设计选择标准可用 storage formats，避免把 `rg16float` storage 或 `r8unorm` storage 当无条件 baseline；它们须按格式 feature 协商。`pack2x16float` 可用于 u32 packing，并不意味着整个 shader 必须启用 `shader-f16`。

| 产品             | 物理格式                        | B/pixel | 写者 → 读者                                                  |
| ---------------- | ------------------------------- | ------: | ------------------------------------------------------------ |
| Depth            | depth32float                    |       4 | raster → HZB/Lighting/GI/SSR/Temporal                        |
| Visibility       | r32uint                         |       4 | raster → shading/按需几何                                    |
| HDR              | rgba16float，pre-exposed linear |       8 | shading/composition → Temporal/Post                          |
| MotionReactive   | rg32uint                        |       8 | shading/temporal producer → Temporal/SSR/GI；x=packed half2 motion，y=reactive/composition/validity flags |
| NormalRoughMetal | rg32uint                        |       8 | shading → GI/SSR；x=oct16×2 normal，y=roughness16+metallic8+flags8 |
| BaseColorAO      | rgba8unorm                      |       4 | shading → GI/standard material response；RGB 显式 sRGB 编码、A=AO，consumer 显式解码 |

| Profile                      | Aux 新增 | Depth+Visibility+HDR+Aux | 1080p 单份 |
| ---------------------------- | -------: | -----------------------: | ---------: |
| Base                         |        0 |               16 B/pixel |  31.64 MiB |
| Temporal                     |        8 |               24 B/pixel |  47.46 MiB |
| Reflection/GI（含 Temporal） |       20 |               36 B/pixel |  71.19 MiB |

Reflection/GI 共 4 个 storage texture outputs：HDR、MotionReactive、NormalRoughMetal、BaseColorAO，匹配 core 默认上限 4。SSR 单独使用时可以裁掉 BaseColorAO，前提是反射 response 有其他明确来源。shader 不声明无 consumer 的 output，资源也不分配。

基础 motion 定义为**未加 jitter 的 current-minus-previous render-pixel displacement**；jitter、render/output extent、depth convention、exposure ratio 作为独立 per-view metadata。FSR adapter 负责转换其要求的方向/单位与 jitter convention。动态分辨率变化不能复用错误坐标域的 motion。透明/粒子独立产生 reactive/composition contribution，不能依靠不透明 Visibility 推导不存在的透明 motion。

### 7.1 精度预算与测试

- Geometry position、barycentric、derivative、depth、world transforms、BRDF 累积保持 f32。不能为“减半”把大世界坐标或 barycentric denominator 全改 fp16。
- HDR fp16 在预曝光空间使用，正常数相对舍入约 ≤0.05%；极暗下溢和强光溢出必须检查，曝光后 clipping 不算合法省显存。
- normal oct16×2 的验收阈值拟定为最大角误差 <0.01°，并对 grazing/clearcoat 镜面误差检查；这是待验证标准，不宣称已证明所有编码实现满足。
- perceptual roughness 的 UNORM16 最大绝对量化误差为 `1/(2×65535)`；不要对 alpha=roughness² 再假设同一绝对误差。metallic/AO UNORM8 误差 ≤1/510。
- BaseColor RGB 在 sRGB 编码空间误差 ≤1/510；线性误差随亮度变化，单独测试暗色梯度、饱和色和多次 composite。不把编码空间误差当线性误差。
- half motion 在 |motion|≤64 px 时，最大舍入约 ≤0.03125 px；大运动时误差增大。高速平移/旋转、细线、粒子、camera cut 单列。若 consumer 要求所有有效 motion 都 <0.05 px，则用 rg32float motion 或 signed fixed-point32 packing 的明确量程合同，新增 4 B/pixel，不能悄悄夹断。
- custom IOR/specularColor、coat normal、anisotropy、transmission 不一定能由 20 B Aux 完整表达。需要延迟求 BRDF 的效果必须声明额外 compact response，通常另加 8–24 B/affected pixel，并作完整清单；不能把 arbitrary graph 默默折成 metallic-roughness。

### 7.2 存一次还是重算

判据为 `C_produce + C_write + n×C_read` 与 `n×C_recompute`，而非“模块解耦”。Depth reconstruction 通常是几十 FLOPs，适合重复；normal map 采样、tangent basis、nonlinear graph 很可能不适合多个 effect 反复做。

例如 12 B 的 normal/rough/albedo 产品，一次写+三个 consumer 读共 48 B/pixel，1080p 99.53 MB；90 GB/s 的纯带宽地板约 1.11 ms。若每次重跑需要 3 个 sample、200 FLOPs、64 B 几何读，三个 consumer 的代价明显可能更高，但仍需实际 cache/texture throughput 校准。重算便宜字段；保存有真实昂贵消费者的最终字段。

## 8. 一个像素从 Visibility 到 HDR

以 opaque、normal-mapped Standard PBR、8 个 cluster lights、一个 shadowed directional、Temporal profile 为例：

| 步骤            | 读                                                           | 算                                                           | 保留/写                                                      |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 1. work address | compact pixel index 4 B                                      | linear index→xy                                              | 寄存器；分类阶段已确定唯一 execution bin                     |
| 2. winner       | Visibility 4 B；work directory/instance/material route       | decode triangle/instance/material；权威发布后不重做 cache identity 协议 | key、引用留寄存器                                            |
| 3. geometry     | index/corner attributes、必要 frame-transformed vertices、camera；depth 可用于 position | perspective-correct barycentrics，normal/tangent、UV/footprint、view direction | 仅所需 inputs 和 CXY 留寄存器，最后一次使用即结束 live range |
| 4. material     | parameter block；base/normal/ORM 三次 texture sample         | decode、UV transforms、normal mapping、roughness filtering、BRDF 参数 | native temporaries 和 closure 留寄存器                       |
| 5. direct       | cluster list、8 个 light records、VSM page lookup/atlas      | attenuation、BRDF、shadow；方向/点/聚光分 loop，避免每 light 大型 type switch | RGB accumulator f32，寄存器                                  |
| 6. environment  | specular prefilter+DFG；diffuse SH 或已存在 irradiance provider | IBL response，AO 和 emissive                                 | 寄存器累积；没有六路全屏 signals                             |
| 7. motion       | 同 winner 的 previous transform/deformation，previous camera | current/previous projection；必要 validity/reactive          | 与 normal 等尽量错开 live range                              |
| 8. publish      | exposure/per-view constants                                  | working-color transform、pre-exposure、pack                  | HDR 8 B + MotionReactive 8 B；Reflection/GI profile 再写 12 B |

当前 frame 的 source/attribute ownership仍存在，这是每几何产品而非每像素“GeometryRecord”。不能同时保留完整 triangle corners、三套 GeometryPoint、所有 texture RGBA、六路 lighting 与 previous geometry 到函数末尾。WGSL 源代码拆成纯函数，codegen 通过 lexical scope、节点排序和按需重新计算廉价值缩短 live ranges；函数内联后的物理寄存器用实测判断。

alpha-tested material 的 coverage 子图在 Visibility 阶段求值，winner shading 可再次采样相关纹理以保持完整 footprint/材质语义；不能宣称它完全没有重复。透明使用同 native compiler/Lighting provider 的独立 raster composition，因为单层 Visibility 无法表达所有透明层。

## 9. 1080p analytical cost model

模型输入与计算结果保存于 [JSON](eengine-v4-cost-model-2026-10.json)。所有有效吞吐都是**规划假设，尚未测量**；模型输出的小数只是算术可复算性，正文按宽区间解释。

### 9.1 先算当前中间产品的带宽地板

`GpuSurfaceWorkAbi.ts`：lit hot=12 u32=48 B，guides=6 f32=24 B，signals=19 u32=76 B。字段只为 varying roots 分配，不应一律算最大：

- fields=0：148 B/pixel；
- 普通例子 fields=8 channels：180 B/pixel；
- retained fields 全活跃为 16 channels：212 B/pixel。

| 假设每项完整写一次、读一次               | 全屏 traffic | 192 GB/s 理论地板 | 90 GB/s 假设有效地板 |
| ---------------------------------------- | -----------: | ----------------: | -------------------: |
| 六路 signal+state，152 B/pixel roundtrip |    315.19 MB |           1.64 ms |              3.50 ms |
| 无 varying fields，296 B/pixel           |    613.79 MB |           3.20 ms |              6.82 ms |
| 8 channel fields，360 B/pixel            |    746.50 MB |           3.89 ms |              8.29 ms |
| 全 retained fields，424 B/pixel          |    879.21 MB |           4.58 ms |              9.77 ms |

这是假设 full-rate 一次 roundtrip 的流量模型，不是从 allocation 推导的实际 DRAM 计数；sparse signal 或字段未读会降低流量，多次 consumer/VM/history/key 会增加。仍未含 source geometry、textures、Lighting provider、HDR、TemporalFacts 和管理队列。它足以说明“容量没超 768 MiB”不等于带宽合理。

当前四 bank 在 1080p 按 8 rows 对齐到 1,088 rows，实际 capacity 为 2,088,960 pixels，比图像多 0.74%。仅 76 B signal 当前帧约 151.41 MiB；history 两套 signal+owner recipes 约 303.81 MiB。代码把 next history slot 用作当前 output，所以不能再重复加第三套。TemporalFacts 的 `rgba32uint` identity 两份另为 63.28 MiB。V4 删除的主要是这些不必要的物理产品，不只是改 pass 名。

### 9.2 V4 必须区分逻辑读取与 DRAM traffic

一个 shaded pixel 逻辑上可能读三顶点 100–200 B、变换/目录数十 B、多个 light records；相邻 pixel 会复用缓存。不能用逻辑 load 总量直接除以 VRAM bandwidth，也不能假设全部命中。

高 coverage profile 的**假设有效外存**预算如下，包含 shader 的 list 读取，不包含 binning pass（归 management）：

| 类别                              |            B/shaded pixel | 访问性质                                          |
| --------------------------------- | ------------------------: | ------------------------------------------------- |
| Visibility + Depth                |                         8 | textureLoad，原屏幕规则、compaction 后局部 gather |
| pixel list                        |                         4 | 顺序 storage                                      |
| directory/instance/material route |                        20 | 依赖索引，缓存后有效流量假设                      |
| triangle/attributes/transforms    |                        64 | 局部/随机 storage，已假设共享缓存                 |
| material parameters               |                        16 | 同 program 不必同 instance                        |
| light/cluster records             |                        48 | tile 局部但有依赖链                               |
| 材质、环境、shadow texture 外存   |                        48 | 9 次采样的有效 DRAM，不是 9×texel size            |
| HDR + Temporal Aux 写             |                        16 | screen-scattered 但 tile 局部                     |
| **总计**                          | **224=208 read+16 write** | 其中 64 B 用于独立 random-storage floor           |

224 B 是可证伪参数：cache miss、压缩纹理、anisotropy、frame arena 布局会改变它。必须校准/采集，不能把这一数字包装成硬件实测。随机 64 B 是总流量的子集，texture traffic 同样已包含，下面不重复累加这些带宽。

### 9.3 workload 与吞吐假设

ALU 以 scalar FLOP-equivalent 计，FMA=2；索引/branch/int 指令不硬套 FLOP，体现在有效吞吐与 residual。sample 指 shader 采样调用，不是 filter taps 或 fetch transactions。SFU 将 sqrt/rsqrt/pow/sin 等作为粗粒度等价操作，实际应逐类校准，不能假设 pow 与 sqrt 吞吐相同。

| workload             |    coverage / V | lights/pixel | 总 B（read/write） | random subset | samples | FLOPs | SFU equiv |
| -------------------- | --------------: | -----------: | -----------------: | ------------: | ------: | ----: | --------: |
| 普通 PBR             | 60% / 1,244,160 |            4 |      208（192/16） |            48 |       7 | 1,000 |         5 |
| 高 coverage 普通 PBR | 95% / 1,969,920 |            8 |      224（208/16） |            64 |       9 | 1,200 |         6 |
| 高 coverage 复杂 PBR |            同上 |            8 |      360（344/16） |            96 |      16 | 3,200 |        18 |
| 高 coverage 多灯     |            同上 |           24 |      384（368/16） |           144 |      15 | 4,000 |        24 |

普通高 coverage 示例：3 material + 2 environment/DFG + 4 shadow comparison samples；diffuse SH 用 ALU。复杂材质约 10 material samples；多灯场景仅有限 shadowed lights，不代表 24 个灯每个都软阴影。场景总灯数不等于每 pixel 的相交灯数，cluster 有效性比总数更重要。

| 有效吞吐假设         | optimistic | expected | pessimistic |
| -------------------- | ---------: | -------: | ----------: |
| 外存混合读写 GB/s    |        130 |       90 |          55 |
| random storage GB/s  |         65 |       35 |          18 |
| ALU TFLOP/s          |       1.40 |     0.85 |        0.45 |
| texture Gsample/s    |         14 |        8 |           4 |
| SFU-equivalent Gop/s |         28 |       15 |           7 |
| 未完全重叠系数 α     |       0.10 |     0.20 |        0.30 |
| GPU management M     |    0.40 ms |  0.80 ms |     1.60 ms |

M 包含 count/scan/scatter 的流量、shared/global atomic/barrier、dispatch/pass/pipeline 固定开销与背景处理。它是假设，不是已经测得的“0.8 ms binning”。参考拆分：0.3–0.7 ms 数据/聚合、0.01–0.08 ms 小 scan、0.1–0.5 ms dispatch/state，存在重叠，不应机械求所有上界。高 entropy B 很大或严重原子争用时 M 可超过表中悲观值。

### 9.4 计算式与结果

```text
tBW  = V × bytes / effectiveBandwidth
tRnd = V × randomBytes / effectiveRandomBandwidth
tALU = V × FLOPs / effectiveALU
tTex = V × samples / effectiveTexture
tSFU = V × SFU / effectiveSFU
f = [max(tBW,tRnd), tALU,tTex,tSFU]
T = M + max(f) + α × (sum(f) - max(f))
```

`max(f)` 是 roofline 风格下界；α 项是**明确的未校准重叠修正**，不是物理定律或统计置信区间。已在 bandwidth 中包含的 random 流量只取 max，不再求和；sampling floor 表示过滤/采样吞吐，与其 DRAM traffic 也不直接重复相加。相关性强时此近似会失真，需要 calibration 与整 kernel 对照修正。

| workload        | expected bandwidth floor | compute floor | texture floor | random floor | optimistic T | expected T | pessimistic T |
| --------------- | -----------------------: | ------------: | ------------: | -----------: | -----------: | ---------: | ------------: |
| 普通 PBR        |                     2.88 |          1.46 |          1.09 |         1.71 |          2.6 |        4.3 |           8.1 |
| 高 coverage PBR |                     4.90 |          2.78 |          2.22 |         3.60 |          4.1 |        6.9 |          13.0 |
| 复杂 PBR        |                     7.88 |          7.42 |          3.94 |         5.40 |          6.7 |       11.4 |          23.4 |
| 多灯            |                     8.41 |          9.27 |          3.69 |         8.11 |          7.2 |       13.1 |          28.1 |

单位 ms。解释为：普通高 coverage 在假设成立时有 **6–9 ms** 的合理工程目标；复杂材质更像 **9–15 ms**；多灯约 **11–18 ms**。没有证据承诺所有复杂 PBR 都 5–8 ms。spill、纹理高熵、所有灯带软阴影、microgeometry 和热降频会落到更坏区域。

CPU command cost 单独计：32 bins 若每次 setPipeline/bind/encode 平均 2–8 μs，是 0.064–0.256 ms CPU 假设；WebGPU validation、JS wrapper、cache miss 会改变它，不能把 CPU encode 时间加进 GPU timestamp 当同一指标。所有 pass sum 与整个 frame GPU span分别报告。

## 10. 所有优化都需要 break-even

以下为显式数字的**示例决策模型**。百分比在每行有不同物理意义，不能统一叫 cache hit。收益正数表示节省时间。

### 10.1 Cache：常规材质直接淘汰

每 query：direct D，lookup L，miss 附加成本 M，命中率 h：

`Tcache=L+(1-h)(D+M)`，`h>(L+M)/(D+M)` 才盈利。这里 D 只能包括确实跳过的 exclusive work，shared setup/必须求的 key 不能算进去。

| 局部模型                                 | 0% hit | 50% hit | 100% hit | break-even              |
| ---------------------------------------- | -----: | ------: | -------: | ----------------------- |
| 普通节点 D=3 ns，L=3.5 ns，M=2 ns        | 8.5 ns |    6 ns |   3.5 ns | h>110%，不存在；淘汰    |
| 真正昂贵独立节点 D=40 ns，L=6 ns，M=8 ns |  54 ns |   30 ns |     6 ns | h>29.2%，仅值得局部研究 |

1 ns/pixel 在 1080p 约 2.07 ms。数字仅演示；旧真实 warm cache 59.475>27.382 ms 已直接否决该 fixture 的方案，无需用虚构 hit model 替它辩护。

### 10.2 Native binning / compaction

设压紧成本 C=0.8 ms，未分 program 的有限 native 分支 kernel 最多有 2.0 ms divergence/执行表示损失可消除，r 为实际消除比例：`saving=2r-0.8`。

| r      |      0% |     50% |    100% | break-even |
| ------ | ------: | ------: | ------: | ---------: |
| 净节省 | -0.8 ms | +0.2 ms | +1.2 ms |      r>40% |

相对 GPU VM，潜在收益可能更大；但普通场景只有一个 program 时，binning 的收益是 0。**单 execution bin 由 CPU 发布信息直接选择 dense native dispatch**，不运行 histogram/scan/scatter；这是相同 native shader 的工作地址特化，不是旧 renderer fallback。不允许为每个 program 全屏扫一遍。

多个不同 pipeline 的 binning 有路由的必要性，仍须控制税。如果测到 C=2 ms 而 ideal saving≤2 ms，拒绝该优化配置，回到小规模 native page/更直接的组织，而非建立缓存去补偿 binning。

pixel compaction 相对 tile-mask：设多付 0.45 ms compact 成本，最多省 1.5 ms inactive-lane cost，消除 0/50/100% 时净收益 -0.45/+0.30/+1.05 ms，break-even 30%。反过来若 U≈1、inactive cost 近零，tile/dense 更有利。不要让动态 GPU→CPU→GPU 控制来逐帧选择；选型在资产/quality profile 或延迟诊断后完成，映射切换在下一发布边界。

### 10.3 ProgramPage

32 pipelines 合并到 8 pages，可少 24 次 dispatch；假设 GPU dispatch/state 平均 8 μs，最多省 0.192 ms。若 page register/code 税为 0.25 ms，理想情况也净亏 0.058 ms，直接不做。

只有测得 page 税约 0.05 ms，才存在空间：0/50/100% 的理想命令节省下，净收益分别 -0.05/+0.046/+0.142 ms，break-even 26%。若这点收益不足以抵消编译/维护风险，也可选择不引入 page。

### 10.4 Software VRS

如果可降频的 expensive shading 为 E=4 ms，2×2 区域省 75%，有效通过率 f，classification+reconstruction 总税 C=0.6 ms：`saving=3f-0.6`。

| f      |      0% |     50% |    100% | break-even |
| ------ | ------: | ------: | ------: | ---------- |
| 净节省 | -0.6 ms | +0.9 ms | +2.4 ms | f>20%      |

这是相同误差预算内的通过率；不是“同 material 就可共享”。如果 E 仅 0.5 ms，理想最多省 0.375<C，直接不做。标准 WebGPU 无 core hardware VRS，软件恢复还有额外带宽。V4 第一版不开全局 software VRS；后续只在有限材质/光照 footprint 里做，full-rate 是正常路径而非“异常污点”。

### 10.5 Fusion 与频率提取

24 B closure 写+读在高 coverage、90 GB/s 下约 1.05 ms。fused 为此承受的 extra spill/occupancy/duplicate work 若超过 1.05 ms，加上拆 pass 固定成本后 B 可能更快。若 extra pressure 为 0/0.5/1.5 ms，融合净节省约 1.05/0.55/-0.45 ms。不能用 pass 数决定。

频率提取也不免费：一个 material/frame 边界值若每 pixel 多读 16 B，在 V=1.97M 时约 31.5 MB，90 GB/s 地板 0.35 ms；被提取的工作必须超过这笔流量加更新成本。已在参数 block 中、同 cache line 的值则边际成本可更低。普通 cheap arithmetic 不强制抽取。

### 10.6 Dynamic Resolution / Upscaling

render scale 是线性尺寸，pixel cost 乘 s²。1080p→720p，s=2/3，P 变 44.4%；不是降低 33%。假设 P 相关成本 10 ms，upscaler 2.5 ms，则相对原生节省 `10(1-4/9)-2.5=3.06 ms`。若 P 相关成本仅 3 ms，同样选择净亏 0.83 ms。

0/50/100% 的 P 相关成本可削减比例下，额外 upscaler 2.5 ms、E=10 ms 的净收益为 -2.5/+2.5/+7.5 ms；break-even pixel reduction 25%。真实 upscaler 与输出分辨率、质量/历史也相关，不能拿这个线性式声称任何分辨率都同样收益。

## 11. 高 coverage：接受正确的 O(P)

不可避免或应直接做：读取 winner/depth、生成最终 HDR、必要 motion/Aux、材质必须依赖 pixel footprint 的采样、不同 light visibility 的有效求值。full-rate native 优化到足够低，胜过用昂贵 proof 跳过一次便宜采样。

首先消除：不可见几何、没被使用的 attributes/outputs、未用 coat/normal 分支、死图节点、逐实例重复 program、资源查询后无消费、没有 effect consumer 的 Aux。

然后利用真实频率：material/frame 更新、同 primitive 的已有变换/clip 产品、texture mips、cluster lists、geometry/texture residency。tile/quad coherence 先用于**调度、资源局部性、共享加载**，不自动授权把多个像素的材质值视为相同。

可选低频 shading 只在可证明图语义等价或有明确视觉误差预算时启用；alpha、细线、法线贴图、高光、shadow boundary、animated UV 是拒绝或 fine 的真实条件。不会建立全屏通用 certificate。复杂高 coverage 的首要质量/性能旋钮是 render scale 和 temporal reconstruction，而不是承诺次线性着色。

## 12. VRAM 与带宽预算：4GB 是整机约束

`TextureResidency.ts` 目前单 owner budget 可到 2 GiB；`FrameGeometryArena` 默认 256 MiB；Surface budget 768 MiB。它们不能分别“合法”后简单相加并认为适合 4GB。浏览器、driver、backbuffer、上传中/退休中资源也占显存，而且标准 WebGPU 无可靠的实时 VRAM budget 查询。

建议 1650 Ti profile 以 **2.75 GiB 引擎目标驻留上限 + 0.5 GiB 应用内突发余量 + 0.75 GiB 外部余量** 起步，并按设备/平台实际压力降低。这是保守配置，不保证 OS 一定提供这些容量。

| 引擎 allocation 预算                       |  MiB 上限示例 | 责任                                     |
| ------------------------------------------ | ------------: | ---------------------------------------- |
| resident texture/VT pools                  |         1,024 | Texture owner，BC/质量/streaming         |
| resident geometry + GPU Scene              |           640 | Geometry/Scene，不计下一项 frame scratch |
| geometry frame work/culling/deformation    |           192 | 实际需求容量与 arena                     |
| VSM atlas/page/caster work                 |           128 | Shadow owner，明确 page budget           |
| render targets/Aux/HDR ping-pong/HZB       |           144 | FrameGraph，按 profile/lifetime          |
| shading queues/control                     |            32 | 通常 pixel list约8 MiB，余量给可选模式   |
| Temporal/upscaler histories/scratch        |           192 | 以选定完整 upscaler profile 核对         |
| GI/SSR/reservoir 合计                      |           160 | 效果间争用这一总额，非每项160            |
| atmosphere/IBL                             |            48 | 独立 LUT/probe budget                    |
| upload/staging/retired/pipeline 不透明余量 |           256 | 跨 owner 汇总，不重复计活跃资源          |
| **总计**                                   | **2,816 MiB** | **2.75 GiB**                             |

Base shading 自身不再拥有数百 MiB persistent working set：临时 list ~7.91 MiB+小 counters；持续的是 scene/program/material resources，不是 per-pixel identity/store。Reflection/GI 的全套单份基础纹理71.19 MiB，加一份 HDR15.82 MiB和 HZB约10.55 MiB，仍在144 MiB示例内；多个 effect histories要计到各自 owner，不能借 alias 掩盖跨帧同时存活。

带宽预算同样按整帧：高 coverage 默认 shade 假设约441 MB/frame，加 binning约35–70 MB，60 FPS约29–31 GB/s。旧8字段中间产品一次roundtrip就746 MB/frame、60 FPS约44.8 GB/s，还没做真正纹理/光照。加入Temporal、GI/SSR、VSM后会竞争同一外存；不能认为低于192 GB/s就有余量，固定延迟、随机性与带宽利用率也限制帧时。

资源 resize/quality/streaming 采用高水位预算并统计 active+pending+retired；旧资源在 fence 完成后退休。V4 删除 Surface 的历史 manager，不删除必要的真实 GPU lifetime 责任。

## 13. WebGPU 能力：直接用、可选用、不能假定

核读 GPUWeb/WGSL revision **454d33cfdf6b8c8a1efafe490623cf0905e6c245** 的规范源码；这份线上 WGSL editor draft 日期为2026-09-23。规范存在不等于目标 Chrome/Dawn/device 实际支持，创建资源前 negotiate。[GPUWeb 源](https://github.com/gpuweb/gpuweb/blob/454d33cfdf6b8c8a1efafe490623cf0905e6c245/spec/index.bs)、[WGSL 源](https://github.com/gpuweb/gpuweb/blob/454d33cfdf6b8c8a1efafe490623cf0905e6c245/wgsl/index.bs)

| 分类                     | 能力                                                         | V4 决策                                                      |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 直接使用 core            | compute、storage buffer、u32 atomics、shared memory/barrier、indirect dispatch/draw、texture arrays、explicit gradients、异步 pipeline 编译 | 完成主路径                                                   |
| 协商 feature             | subgroups、shader-f16、primitive-index、subgroup-size-control、timestamp-query、BC compression、texture format tiers | 按实际 adapter/device feature 生成变体；无 feature 有正确路径 |
| 新 core/API 需运行时探测 | Immediate Data、Transient Attachments                        | 可优化小常量/局部附件；不作为 shading 架构前提；跨 pass Aux 不符合 transient 用法 |
| 不能当标准基线           | unrestricted bindless、GPU-selected arbitrary pipeline、multi-draw-indirect command stream、mesh/task shader、general buffer device address、通用64位atomic、hardware VRS、RT pipeline、显式async compute queue | 不照搬D3D12/Vulkan的调度/descriptor假设                      |

core 默认常见资源上限包括8 storage buffers/stage、16 sampled textures/stage、4 storage textures/stage；adapter可更高，必须 request后以device.limits为准。现有Surface要求16 storage bindings，不应自动成为V4最低要求。初始 fused布局可把只读几何metadata/attributes合并为同owner的少数typed ranges，list、material/scene、light、VSM维持约6–8 storage buffers；不要为降低binding数建立跨owner通用巨型heap。

当前9 material texture banks + Visibility/Depth + IBL/DFG + VSM已接近16 sampled bindings；Atmosphere LUT、VT page table、GI会超过。解决顺序：裁未用bank/consumer；把resource class按有限bank设计；真实跨pass effect独立；最后才在较高limit profile要求更多binding。不能假定所有provider可同时塞进一个fused kernel。

subgroup fallback 使用shared memory和明确workgroup barriers；不能假设warp永远32。compaction后的quad操作没有屏幕邻域语义。WGSL uniformity也不一定从storage中读到“所有lane相同”的selector自动证明uniform；带barrier的page selection须使用规范可证明的控制流，或把collective放在选择外。

VT不是bindless descriptor indexing：page table映射逻辑页到有限physical atlas/array layer，native采样函数使用显式Grad/LOD、border与resident ancestor；不同尺寸/格式/sampler class有明确资源布局。texture array layer数量和纹理尺寸也受limit约束。

## 14. AAA 接入推演：不许靠未来重写兜底

### Virtual Geometry

Geometry owner负责LOD/SSE、HZB、meshlet、page demand/residency、deformation和clip/attribute发布。Visibility key只引用本帧合法work namespace；单帧generation/retirement在生产边界成立。Material只声明所需attributes，native shader从geometry产品取值。Geometry越界/缺页使用其定义的resident ancestor或失败策略，不能由Surface的“fine exception”掩盖漏几何。

### VT

Material compiler把sample node降为ordinary sample或`vtSampleGrad`；逻辑texture/page table/physical atlas由Texture owner发布。shader反馈只写page demand，CPU异步streaming影响后续帧，绝不控制当前帧可见工作。page miss采resident ancestor，边界padding、LOD/bias、anisotropic footprint必须与完整VT算法一致。VT的cache/history归VT，成本另加page lookup和feedback。

### VSM

Depth/Visibility提供receiver demand，VSM负责page allocation、dirty state、caster work和atlas raster；fused Lighting只做page lookup、depth comparison/filter与其fallback。page渲染和sampling是两笔成本。当前VSM存在不等于所有点/聚光/离屏caster覆盖已完成，V4保留时要继承公开缺口，不能借换架构宣布完成。

### ReSTIR

Reservoir属于Lighting/ReSTIR。完整DI需要initial candidates→temporal→spatial（或选定算法明确的变体）→visibility/resolve，跨dispatch全局依赖必须存在。不能在一个fused pixel shader里“顺便”完成邻域reservoir交换。

启用时，native material phase先输出该算法的receiver response（normal/roughness/base/specular或自定义扩展），ReSTIR读取它、保存自己的reservoir和validity；最终Lighting/composite消费selected samples。普通clustered路径不因此分配reservoir。若packed reservoir假设32 B、两个slot：full1080p为126.56 MiB；半宽半高为31.64 MiB，**32 B仅是预算例，必须按所选donor实际layout核算**。

标准WebGPU没有硬件ray-query合同；shadow visibility需VSM或软件traversal等具名方案。1650Ti多灯下ReSTIR可能减少light evaluation，但reservoir traffic与visibility查询可能抵消收益；不把它设成默认“advanced lighting更快”。[RTXDI接口资料](https://github.com/NVIDIA-RTX/RTXDI/blob/main/Doc/Integration.md)、[ReSTIR原论文](https://research.nvidia.com/sites/default/files/pubs/2020-07_Spatiotemporal-reservoir-resampling/ReSTIR.pdf)

### GI/SSGI

屏幕空间算法通常读depth/HZB、shading normal、motion、radiance及需要的albedo。它只看屏幕内信息，不能声称提供完整离屏GI。world-space probes/surfel/voxel产品由GI owner维护。输出明确定义为irradiance或已应用BRDF的radiance，composition不能重复乘albedo/AO。

同帧SSGI如果需要当前color，先native material+direct/emissive形成无GI的seed radiance，再SSGI，再response composition，避免从最终含GI color递归采样。不会为了这个dependency重新引入六路通用SignalStore。

### SSR/SSSR

consumer需要depth hierarchy、normal、roughness、motion、scene radiance与环境fallback。生成ray/tile queue、intersection、denoise/history属于SSR。推荐seed HDR不包含待求SSR contribution；最后使用compiler提供的specular response，将SSR与IBL按可信度混合后加入direct/emissive。不能把完整IBL已经加进HDR后再直接叠加SSR而双计能量。[SSSR官方完整阶段与输入](https://gpuopen.com/manuals/fidelityfx_sdk/techniques/stochastic-screen-space-reflections/)

若只有普通metallic-roughness材质，反射响应可以由基础Aux+常量重建；coat/aniso/custom specular需要额外response或一个有成本的native resolve。这个限制在§7已经公开，不能承诺“任意材质永远20 B Aux够用”。效果中间radiance只为实际consumer分配，有明确first/last use。

### Atmosphere

保持LUT/sky/solar/aerial provider独立。Lighting只读必要太阳/环境输入；aerial perspective按depth/HDR做独立composition或在确认binding/register合适时融合。Atmosphere历史/LUT更新不归Surface。天空也必须生成camera-rotation motion、exposure一致的HDR。

### Temporal / FSR / AI Upscaling

共同接口是current HDR、depth、motion、reactive/composition、jitter、render/output extent、exposure/reset；具体history归upscaler。采用FSR必须选定完整版本/profile并保留其完整阶段，而非把一个bilinear+sharpen叫FSR。现有FSR3相关代码可以保留，Aux packing转换优先通过load callbacks/已有prepare阶段完成；若独立unpack pass不可避免，将其读写/dispatch加入预算。[FSR3官方输入合同](https://gpuopen.com/manuals/fidelityfx_sdk/techniques/super-resolution-upscaler/)

AI upscaling保持相同输入角色，不把某厂商tensor硬件、WebNN共享GPU资源或零拷贝互操作当标准WebGPU必然能力。若backend无法有效互操作，就不能放在实时hot path；无支持设备继续使用完整的非AIupscaler。帧生成不等于降低真实渲染latency，也不用于证明native60。

### AAA全开与1650Ti的现实边界

对“大规模复杂PBR + VSM + GI + SSR + Atmosphere + Temporal”这个目标，**没有现实依据承诺GTX1650Ti native1080p稳定60**。场景极简或质量受限当然可能，但不能当此任务的工程目标。

一个明确的中等质量整帧规划示例：Geometry/Visibility 3 ms + shading 7 ms + VSM生成2 ms + GI4 ms + SSR3 ms + Atmosphere1 ms + Temporal/Post3 ms = **23 ms**。这七项全是规划假设，不是独立P50相加所得的测量；拥塞时可能更坏。复杂材质或大量dynamic shadow可到30–45 ms甚至以上。

假设其中16 ms随像素变化、7 ms较固定：720p internal估计`7+16×4/9=14.1 ms`，可进入60目标附近，但需重新测输出分辨率upscaler成本和P95。建议quality tier控制GI/SSR分辨率/射线预算、VSM pages/filter、材质层数和render scale；不是关闭正确性。先以native1080p普通PBR做baseline，再建设动态分辨率，迟滞和低频反馈避免分辨率振荡。

## 15. 小型 GPU Calibration Profile 值得做，但不是新平台

值得纳入开发方法，范围应限制在一个离线/显式运行的小工具和一份JSON。不要每次启动全测，不创建长期调度框架，不把微基准结果自动当正式性能证据。

测量矩阵：

| 项目                             | 必要变化轴                                                   | 防止误测                                                    |
| -------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| sequential read/write/read+write | 8/64/256 MiB；stride、vec/scalar                             | 工作集超过cache；实际结果checksum；分别报告逻辑bytes        |
| random storage                   | coherent、permuted、dependent pointer chase；不同working set | 区分latency与并发throughput，不能只测完全随机一种           |
| atomicAdd/CAS                    | 全局同地址、sharded、unique、shared；CAS失败率               | 报ops/s与contention；CAS循环重试数不隐藏                    |
| texture                          | cache热/冷、coherent/random、bilinear/trilinear、BC/非BC、anisotropy | 报sample calls与条件，不把texel/s当sample/s                 |
| ALU                              | FMA、integer/address、dependency-chain和多accumulator        | 防constant-fold/DCE，kernel写checksum；FMA按2 FLOPs         |
| sin/pow/sqrt/rsqrt               | 分别测试、有效输入范围                                       | 检查数值；无理由不混成一个“SFU吞吐”                         |
| shared/barrier                   | 64/128/256 lanes、bank冲突、1/多barrier                      | 无效lane仍到barrier；测barrier增量非整个kernel              |
| dispatch/pass/state              | 空/微工作；同pass/多pass；同/不同pipeline；direct/indirect   | 分CPU encode、GPU span、GPU pass sum；计入验证层/driver成本 |
| subgroup                         | runtime支持的size、ballot/shuffle/reduction与shared等价方案  | 不启用未支持feature；两方案结果一致                         |

先warmup，串行GPU作业，记录adapter/browser/backend/driver可见信息、feature/limits、尺寸、工作集、shader hash和样本数。timestamp-query不可用时报告unsupported；CPU `onSubmittedWorkDone` 可粗测整批吞吐，不能冒充单pass timestamp。固定批次持续数ms以避开timestamp量化，分若干批报告median/P95和漂移；任何超时/异常保留原报告。

再加入**两个组合探针**而非几十个renderer fixture：典型native Geometry+PBR+8lights；同语义compact-deferred。微基准对cache共用、register压力和texture/ALU重叠估计不足，组合probe用来修正α与bytes。模型若预测与组合probe差2倍，先修模型，不宣布优化完成。

## 16. 源码保留/删除地图

以下路径均相对仓库根目录，基于本次master。类别针对实际职责；KEEP不表示所有算法已经通过正式验收。DELETE是在V4切换时移除旧producer及直接consumer，不是本次已经删除。

| 分类                  | 当前具体文件/目录                                            | V4动作                                                       |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| KEEP                  | `OEngine/src/gpu/GpuScene.ts`、`GpuRenderWorld.ts`、`GpuAssetStore.ts` | 保留scene/asset ownership，材质发布表改接ProgramID           |
| KEEP                  | `OEngine/src/assets/`、`loaders/`                            | 保留资产/cooker/streaming合同；删除无生产consumer的Surface证明资产时另核 |
| KEEP                  | `OEngine/src/gpu/VirtualGeometryResidency.ts`、`GeometryPageStreamingRuntime.ts`、`GeometryProductMultiRuntime.ts` | 保留VG与residency，真实性能/完整性单独验收                   |
| KEEP                  | `OEngine/src/render/features/VisibilityFeature.ts`、`passes/PackedVisibilityPass.ts`、`gpu/GpuVisibilityKeyAbi.ts` | 保留winner契约、软/硬光栅；alpha native子图接线              |
| KEEP                  | `OEngine/src/render/FrameGeometryArena.ts`、`FrameGeometryVertices.ts`、`FrameInstanceTransforms.ts` | 保留几何产品owner与按实际需要的变换复用，清除旧Surface专属字段/消费者 |
| REUSE MATH ONLY       | `OEngine/src/shaders/surface_geometry_completion.ts`、`surface_geometry_reader.ts`、`surface_frame_geometry.ts`、`surface_work_geometry.ts` | 保留插值/normal/tangent/validity数学，移除每pixel GeometryRecord store和旧binding外壳 |
| KEEP / 分离后端       | `OEngine/src/material/AppearanceGraph.ts`、`AppearanceGraphCompiler.ts`、`AppearanceGraphEvaluation.ts` | 保留IR/CSE/DCE/CPU oracle；native lowering为唯一GPU材质后端  |
| REWRITE               | `OEngine/src/material/ExactAppearanceDag.ts`                 | 抽出frequency/liveness/CXY/demand分析；删除Tape opcode/slot编码作为生产ABI |
| REWRITE               | `OEngine/src/shaders/appearance_program.ts`、`appearance_resident_kernel.ts` | 复用straight-line lowering思想，补全frequency、explicit derivative、Aux/provider signatures |
| REWRITE               | `OEngine/src/gpu/AppearanceProgramRegistry.ts`、`GpuAppearancePublication.ts` | 保留async lifecycle，发布instance/program/pipeline/bin表，删除cache/tape/field-store协议 |
| DELETE                | `OEngine/src/shaders/appearance_exact_dag.ts`、`gpu/GpuAppearanceDagAbi.ts` 的生产Tape协议 | 不再在GPU逐节点解释；CPU独立oracle可保留在material侧         |
| DELETE                | `OEngine/src/render/surface/SurfaceWorkRuntime.ts`、`SurfaceWorkTypes.ts`、旧 `SurfaceFrameResources.ts` | 替换为小型临时work资源+native dispatch composition，不搬运其全套职责 |
| DELETE                | `OEngine/src/shaders/appearance_closure_key.ts`、`appearance_closure_cache.ts`、`gpu/GpuAppearanceClosureCacheAbi.ts` | 删除global exact closure缓存及nomination/publish/continuation |
| DELETE                | `SurfaceWorkRuntime.ts` 中signal histories、`surface_work_lighting.ts`中通用history reuse | algorithm-owned history替代；无全屏Surface历史               |
| DELETE                | `OEngine/src/gpu/GpuSurfaceSignalPacketAbi.ts`、`GpuSurfaceWorkAbi.ts`中六RGB planes；`surface_work_reconstruct.ts` | HDR寄存器合成；效果自己的信号需单独contract，不保留通用六信号ABI |
| DELETE / 审依赖后清理 | `GpuSurfaceProofAbi.ts`、`GpuSurfaceFieldStoreAbi.ts`、`GpuSurfaceSignalStoreAbi.ts`、`GpuSurfaceReferenceAbi.ts` | 无新consumer则删，不把历史名称继续作为V4底座                 |
| REUSE MATH ONLY       | `OEngine/src/shaders/surface_work_lighting_math.ts`、`surface_fixed_formulas.ts`、`material/FixedSurfaceFormulas.ts` | BRDF/color/normal数学重用，接口改为register closure          |
| REWRITE               | `OEngine/src/shaders/surface_work.ts`、`surface_work_coherence.ts`、`surface_work_rate.ts` | 原调度/共享规则退出；局部count/scan/scatter按§6新设计        |
| KEEP                  | `OEngine/src/framegraph/FrameGraph.ts`、`CompiledFrameGraphCache.ts` | macro graph与resource event executor；不表达每个program为庞大永久协议 |
| KEEP / 调整布局       | `OEngine/src/gpu/TextureResidency.ts`、`TextureVariationResidency.ts`、`TextureBindingSetPolicy.ts` | 保留物理residency；重核2GiB预算、binding set数量、VT接入；不用per-pixel variation证明 |
| KEEP                  | `OEngine/src/render/passes/LightClusterPass.ts`、`ClusteredLightingReference.ts` | 保留有效cluster产品，精简fused读取ABI、统计lights/pixel      |
| KEEP                  | `OEngine/src/render/vsm/`                                    | 保留VSM owner/算法，重接native consumer；不掩盖既有覆盖缺口  |
| REWRITE               | `OEngine/src/render/temporal/TemporalFactsPass.ts`、`shaders/temporal_facts.ts` | 保留motion/reset数学，删除强制全屏32B双identity；仅特定算法必要时拥有局部identity历史 |
| KEEP / 收窄职责       | `OEngine/src/render/TemporalFabric.ts`、`TemporalHistoryRegistry.ts`、`TemporalGpuHistory.ts` | 可保留通用frame生命周期工具，history语义由consumer所有；不重建Surface总管 |
| KEEP                  | `OEngine/src/render/passes/fsr3/`、`OEngine/src/shaders/atmosphere/`、`render/passes/PhysicalSkyPass.ts`、`render/passes/AerialPerspectivePass.ts` | 核对实际路径后接Aux/HDR；各自完整算法与验证范围不扩大        |
| REWRITE               | `OEngine/src/render/program/FrameProgramLowering.ts`、`pipeline/RendererCore.ts` 的Surface composition | producer与全部直接consumer同一切换；Renderer不吸收算法       |
| KEEP / 调整诊断       | `OEngine/src/debug/SurfacePhaseTiming.ts`、`debug/profiling/ResourceAccounting.ts` | 所有scope总和、unclassified、工作量与active/pending/retired，杜绝计时盲区 |

### 16.1 切换边界

本任务只交付设计，不启动实现。未来若采纳，切换单元应是“native compiler + binning + opaque shading + Aux + Temporal/effect直接consumer”完整连通后移除旧Surface链。可以先隔离oracle验证native语义，但不把旧/新renderer长期并存，也不为了旧测试恢复旧ABI。

删去旧owner不等于删掉正确性责任：material updates、texture residency变化、device loss、camera cut、动态变形、曝光与motion、shader compilation失败必须在新权威边界重新覆盖。旧测试有价值的语义断言映射到新producer→consumer，不保留以opcode布局/旧class存在为目标的测试。

## 17. 最可能再次失败的地方与淘汰条件

| 风险                           | 早期可观测指标                                               | 决策                                                         |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------ |
| fused shader寄存器爆炸         | native fused慢于同语义split；纹理少仍慢、spills/occupancy异常 | 以真正跨pass closure拆分，不能执着一个pass                   |
| binning管理税过高              | 低entropy/单program仍付count/scan；M>可消除损失              | 单bin dense；验证tile或小page，拒绝构建新复用系统补偿        |
| Program×BindingSet膨胀         | program少但executionBins多、空dispatch多                     | Texture pooling/资源class/有限page；明确CPU/GPU实际成本      |
| 任意图编译爆炸                 | source/pipeline数量、compile latency/CPU峰值                 | topology canonicalization、真实variant裁剪、异步publication；不回VM |
| 压紧破坏texture/light locality | random throughput、texture miss、shard敏感                   | 保留tile局部shard；必要时tile profile；不能只看lane利用率    |
| “最小Aux”漏复杂材质语义        | coat/aniso/IOR在SSR/GI中不匹配                               | 显式response extension和budget，拒绝悄悄降低材质模型         |
| 软件VRS又变proof系统           | 每pixel metadata/全局identity/树重新出现                     | V4核心禁入，只允许效果/局部限定算法                          |
| 重建导数画质错误               | mip闪烁、接缝、细线、高光时域不稳                            | 相同primitive CXY与独立oracle；不以大容差通过                |
| 删history损害Temporal          | camera cut/LOD/mat change ghosting                           | consumer拥有其必要历史与reset，不能用“无identity”拒绝真实需求 |
| 4GB被多个owner预算吃完         | active+pending+retired峰值、OOM/eviction                     | 整机budget，先降resident质量/分辨率，不能只缩counter         |
| microbenchmark给虚假信心       | 模型和组合kernel偏差>2×                                      | 修吞吐/流量/重叠假设，报告未解释残差                         |
| source移植只剩名字             | 缺分支、fallback、stage map、合法失败用例                    | 不标adopted；完整算法另按source合同实施                      |

建议最小设计判别证据：同一真实图的CPU/native数值与Grad oracle；一张普通复杂场景的visible-pixel/texture/light分布；single-bin与32-bin、U=1/2/8/高熵；fused/split相同输出；Aux量化与时域边界；全成本timestamp和allocation。没有这些证据，V4只是有合理上限的设计，不能称“极致性能已实现”。

## 18. 研究来源及物理实现结论

本次先重新获取固定GitHub源码，再读作者文章/规范；具体revision/license/入口和本地阶段映射写入 [来源账本V4条目](../porting/next-renderer.md#v4-native-shading独立设计研究2026-10-07)。不声称完整移植下列引擎，也不从不可公开核读的UE/Nanite源码推断其实现。

- Wicked固定源码：`visibility_analyzeCS`先分primitive uniform/divergent；`visibility_resolveCS`局部bitmask聚合shader type并append tile；`wiRenderer::Visibility_Shade`按material type分别发uniform/divergent indirect dispatch；shade载入Surface并执行TiledLighting→ApplyLighting→HDR。**它不是一个全能VM，也不只有一个dispatch**。上游依赖wave、bindless、push constants，不能直接当WebGPU免费能力。[源码](https://github.com/turanszkij/WickedEngine/tree/df44c3db4c4927492bc9c791eac715d98d7ed091/WickedEngine/shaders)、[作者说明](https://wickedengine.net/category/devblog/2024/12/10/wicked-engines-graphics-in-2024/index.html)
- 同一Wicked工程有独立normal/roughness surface阶段和forward `objectHF.hlsli`，其存在说明按需Aux、compute/raster specialization可以共用材质/lighting数学；**不说明可以免费避免所有重复material work**。
- Forge `VisibilityBufferShade.frag.fsl`读取Visibility、triangle/vertex，`CalcFullBary`和`Interpolate2DWithDeriv`得到导数，再SampleGrad材质并着色；该固定sample是fragment resolve。它用nonuniform texture arrays，V4必须换成显式bank/VT绑定。保留数学与数据流，不照搬descriptor模型。[固定shade](https://github.com/ConfettiFX/The-Forge/blob/cd5046893faba2dc7869243873bf01f02a6f0df9/Examples_3/Visibility_Buffer2/src/Shaders/FSL/VisibilityBufferShade.frag.fsl)
- Intel DeferredCoarsePixelShading从GBuffer出发，通过深度/几何条件决定coarse或per-pixel，再补细粒度工作；它不能直接证明复杂材质图可在材质求值前安全降频。V4只把它作为局部VRS成本/恢复参考。[固定源码](https://github.com/GameTechDev/DeferredCoarsePixelShading/blob/63ad5c1adafbfcc2869a200f50a5ea11f28b4887/ComputeShaderTile.hlsl)
- Filament `FrameGraph::compile/execute`的first/last-use与devirtualize/destroy事件适合作macro生命周期参考；不把其native backend资源管理当WebGPU heap alias能力。[固定源码](https://github.com/google/filament/blob/bb360e80259167c986e94db7b70153bcdb92c0e1/filament/src/fg/FrameGraph.cpp)
- GPUPrefixSums WGSL的reduce/spine/downsweep提供可核验多dispatch scan参考；所读版本使用subgroups，portable fallback不能仅删掉subgroup调用。小B×S表可用本地shared-memory scan，无需照搬通用大数据scan框架。[固定源码](https://github.com/b0nes164/GPUPrefixSums/blob/98d93a4e9ed2f3c8353119515bf9be90a2e137ad/GPUPrefixSumsWebGPUapis/SharedShaders/rts.wgsl)

本次没有完整适用于“arbitrary native programs + WebGPU texture banks + fused providers”的单一donor。该部分明确为本地V4设计。公开论文DAIS链接检索到但本次网络读取失败，因此导数实现判断以已核读Forge函数与Wicked作者资料为依据，不声称已完成DAIS论文审阅。

## 19. 交付与验证范围

本次交付独立V4提案、可复算模型JSON与来源映射；不修改production TS/WGSL，不改workstream阶段，不提交Git commit。检查范围是文档frontmatter/本地链接、JSON算术与源码路径核对。没有运行新GPU calibration、typecheck/build或browser matrix：没有源码变更，性能模型也不冒充编译/实测证据。

此设计的可证伪条件很具体：如果普通高coverage下有效外存显著高于224 B/shaded pixel，或fused吞吐低于假设，或binning管理成本超过其收益，则§9帧时目标失效，须按实际数据改工作组织/阶段边界。不能通过降低图语义、漏像素、减少灯/阴影质量或忽略未分类GPU scope来维持表中的数字。