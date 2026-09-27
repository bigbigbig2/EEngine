# EEngine Next：整体架构层执行计划（2026）

> 设计依据：[整体架构 final](../next-design/eengine-next-overall-architecture-final-2026.md)。本文把整体边界变成可连续实施的切断顺序；具体 VSM 页表、Surface 物理打包、GI probe 格式等仍在各自模块设计时决定。
> 当前状态：文档和开发校验流程的第一层重构已完成，workstream 已转向 Frame Program。Phase 3 旧计划中的 FSR3 production integration 已记录完成，但新架构的 Frame Program、Surface v2、统一 Temporal Facts 尚未完成。
> 执行原则：每次只保留一条 production renderer path；一个大模块内部连续实现，原理与消费者连通后才集中检查；最终系统验证在主要架构和 planned providers 完成后进行。

## 0. 目标、范围和判断方法

本计划服务于高几何密度桌面 WebGPU 场景的极致 GPU 吞吐与现代 3A 画质。目标链是 `GPU Scene → Geometry Work → Visibility Facts → Surface/Lighting → Temporal/Presentation`，同时允许 Shadow、World Query、Radiance Field、Virtual Resource 和 Media 在各自 owner 中接入。CPU 负责资产发布、capability、Frame Program、命令编码与提交；本帧可见性、页/射线/着色工作量由 GPU 产生并被 GPU 消费。

本文不把旧文档或现有类名当成目标结构。判断一个阶段是否在实施，是看目标语义有没有生产者、真正的 GPU consumer、唯一帧图路径和生命周期，而非是否新增一个接口或测试。历史代码只用来识别可复用的数学、资源与 ABI；删除旧路径后可在 Git 历史中查回。

**实施检查与验收分开。** 日常对照设计、源码和当前 workstream 编码；针对真实疑点可以跑 typecheck、build 或单个 targeted test。模块完整连接后集中跑一次 typecheck、build、必要 targeted tests，修复明显问题，更新 workstream 并进入下一模块。整个 Next Renderer 完成后才做跨浏览器、生命周期、质量、性能与正式证据。文档暂时滞后、旧 claim 未 accepted 或最终验收尚未满足，不阻止继续实现。

## 1. 当前工程位置与旧切片的准确含义

| 当前源码位置 | 已有资产/实际问题 | 对新架构的处理 |
| --- | --- | --- |
| `OEngine/src/render/pipeline/RendererCore.ts` | `Renderer` 仍直接拥有 Graph 拼装、Surface、环境、FSR3、Present 和生命周期；`build` 相关方法从约 1400 行开始拼资源和 Pass | 收缩成 composition root；把语义需求规划、FrameGraph lowering 与各 owner 的 pass registration 分开，不建并行 Renderer |
| `OEngine/src/framegraph/FrameGraph.ts`、`CompiledFrameGraphCache.ts` | 已有 compile、late-bound bindings、执行和缓存基础 | 保留物理资源依赖/生命周期层；不要把语义 feature 决策塞入 Graph |
| `OEngine/src/gpu/GpuRenderWorld.ts`、`OEngine/src/render/features/VisibilityFeature.ts` | 已有 GPU Scene/Visibility 工作资产 | 保留生产主干；定义稳定 Visibility/Temporal facts，避免为了重写后半段重做 Geometry |
| `OEngine/src/render/surface/SurfaceMaterialPass.ts` | 当前按 active material class 构造程序、pipeline、pass 和 bind group；class 还混入 texture set | 在 Surface v2 中拆 authoring、execution class、resource binding；将 pipeline warmup 移出帧热路径 |
| `OEngine/src/render/surface/SurfaceFrequencyResolvePass.ts` | 已有粗频结果回填与 motion 路径 | 重新审视 coverage、identity 与运动边界，接入真正的 field demand；不把现有策略直接改名为 v2 |
| `OEngine/src/render/TemporalFabric.ts`、`TemporalGpuHistory.ts` | 已有事务和 color/depth/motion 生命周期 | 保留 begin/commit/abort 与 GPU 资源管理思想；重建跨消费者事实和各自 confidence |
| `OEngine/src/render/passes/fsr3/` | FSR3 Upscaler 阶段存在且旧 Phase 3 已完成 | 作为 Temporal Reconstruction backend 接入新事实；旧完成记录不等于新 Motion/Reactive/Presentation 合同完成 |

上述判断来自当前文件与调用关系，不能推出质量或性能已经验证。尤其 `RendererCore.ts` 当前在运动相机条件下把 Surface 切到 full rate，并在 `SurfaceMaterialPass` 内对 active classes 建程序；这些是新 Frame Program 与 Surface v2 的真实切入点。已删除的旧 Phase 0–5 阶段概要可在 Git 历史查阅，不能自动把新总架构下的同名阶段标为完成。

### 1.1 保留与直接切断

保留有实际消费者的 GPU Scene、Geometry/Product、Virtual Geometry、Visibility、HZB、FrameGraph 编译与 late binding、FSR3 算法阶段、物理环境数学和历史事务机制。对旧 owner 的任何提取只取算法/ABI/生命周期事实，不保留旧 Feature/Pass 包装作为新主链的兼容桥梁。

直接从唯一生产路径撤下 retired AO/SSR/SSGI/CSM/TAA、旧 Surface/Sparse 与旧 effect registry；依赖被切断后删除无消费者源文件、pass、资源、readback 和独立 submit。允许新模块尚未上线时对应效果暂缺，不能用旧链保持表面功能齐全。**后续用于比较 Fuse 与 Materialize 的 A/B 是同一新架构内的物理 topology 实验，不是旧/新生产路径共存。**

## 2. 第一层：文档与开发流程切断（本轮）

### 2.1 文档入口重建

1. `docs/README.md` 只给四个入口：整体设计、架构层执行计划、活跃 workstream、`vibe context`。删除指向不存在的 `renderer-architecture.md` / `renderer-plan.md` 的首页路由。
2. `docs/next-design/` 放目标架构和进入开发的模块设计；整体 final 文档保持完整，后续模块继续以该边界为起点。`docs/next-execution/` 放人读、详细的顺序与迁移步骤；活跃 workstream 只保留当前切片和下一个模块列表，不复制长计划。
3. `docs/domains/` 只描述已实现事实；`contracts/` 和 `specs/` 只维护已经稳定且有消费者的精确协议；`adr/`、`reviews/`、旧阶段文档保留历史上下文但不作为当前编码许可。旧报告中的逐批门禁视为历史记录。
4. 文档更新与大模块闭合一起做。实现中间态可短期与 current docs 不一致；必要时在本执行文档的当前状态段注明。不要为满足模型链接而生成空 spec、空 claim、伪 evidence。

### 2.2 校验执行重建

1. 日常 `tools/vibe.mjs` 是轻量入口：`context <path>` 只装载路径 owner 与活跃 workstream，输出当前文档和 Next 设计/执行入口；不装载 claim、case、evidence、registry，也不以缺少它们为失败。显式 `--claims`、`--cases`、`--all` 才进入隔离的验收代码。
2. 旧 `verify --changed` 退役。`verify --module` 是主动的大模块收口命令，仅执行引擎 typecheck、build 与显式传入的 targeted tests；不根据每批改动扩张测试组，也不产生 registry/evidence。`verify --full`、claim/case/status 等只在明确调用时装载 `vibe-acceptance.mjs`。
3. 活跃 Next workstream 只含 currentSlice、goal、nextModules、architectureRules、deferredValidation 和最小身份字段。老 workstream 的 claims/exitChecks 不指导 Next 当前编码；正式验收对象留在既有 `validation/` 和合同里，最后再使用。
4. Diagnostic browser case 是观察，运行时不触发仓库级 preflight；只有接受正式 evidence 的 case 才运行或复用 full preflight。针对开发中真正无法编译的问题直接修复；针对 ABI 或数学难点可运行一个相关测试。不要在模块未形成生产闭环时预先搭建浏览器矩阵、GPU 伪工作量或为了旧检查写临时 compatibility 层。

### 2.3 第一层完成后的实际状态

本层只改变**导航与执行行为**，不声称 Frame Program、Surface v2 或 VSM 已实现。检查点是：文档首页链接能到达；`vibe context` 能在当前 claim/evidence 状态下独立返回 owner、currentSlice 与 Next 入口；`verify --module --plan` 只展示模块收口命令；诊断 case 不再触发仓库 preflight；npm 默认脚本不暗示模块检查是日常门禁；workstream 对下一代码模块有正确顺序。此类文档/工具切断仅做轻量语法与导航核对，不跑浏览器或全量引擎验证。

| 已切断的旧行为 | 当前落点 | 实际效果 |
| --- | --- | --- |
| 文档首页指向不存在的设计/计划文件且旧阶段概要仍在活动树 | `docs/README.md`、旧 `docs/next-renderer.md` | 直接导航到 final 设计与本文；旧阶段概要删除，历史留在 Git |
| 根规则和近 owner 规则要求逐批 GPU 时间或文档记录 | 根与 `OEngine/AGENTS.md` | 大模块闭合前可连续实现；算法来源在选择 donor 时固定，完整映射在模块收口集中记录 |
| validation 目录的协议修改要求立即全套测试 | `validation/AGENTS.md` | 先使协议模块连通，再做针对性代码检查，浏览器和正式证据后置 |
| `context` 需要完整 claim/case/check 模型 | `tools/vibe.mjs`、`tools/vibe-acceptance.mjs` | 日常入口不 import 验收模型；显式验收命令才按需装载 |
| `verify --changed` 用 claim watch 和 changed paths 扩张检查并写 evidence report | `tools/vibe.mjs` | 命令退役；`verify --module` 只运行 typecheck、build 与显式 targeted tests，无正式报告 |
| 诊断浏览器 case 自动执行 changed preflight | `validation/src/runner/run-case.mjs` | 诊断只记录诊断 artifact；`--accept` 仍使用完整正式 preflight |
| 旧 guard 测试要求 workstream 保留 tasks、claims 和生成 registry | `OEngine/tests/guard/documentation-system.test.mjs` | 删除旧测试，不为满足它恢复过期 workstream 字段 |
| 根 npm 脚本暴露日常 registry/evidence/doctor 操作 | `package.json` | 默认导航，模块检查和最终检查都需要明确调用 |
| 活跃 workstream 把旧 Phase 3 完成后直接列 VSM | `project/workstreams/active/eengine-next-clean-rebuild.yaml` | 当前模块改为 Frame Program，后续 Surface、Temporal、VSM 顺序与 final 设计一致 |
| domain `currentDocs` 混入旧路线、来源账本和验收合同 | `project/domains/*.yaml` | 当前事实只指向对应 domain 文档，目标设计/执行由 `context` 独立给出 |
| 验证合同与开发节奏混写 | `docs/VALIDATION.md` | 本页只说明检查时点；artifact/claim 细节留在既有验收合同 |

## 3. 模块 A：Frame Program 与语义事实层

本节是整体顺序摘要；源码事实、关键取舍与详细迁移步骤分别展开在[模块 A 设计](../next-design/frame-program-module-a.md)和[模块 A 执行](./frame-program-module-a.md)。

### 3.1 为什么它先于 VSM

当前 `RendererCore` 直接选择环境、Surface、FSR3 与 Present 的资源/Pass 顺序。若现在插入 VSM，它需要在这里再加页需求、分配、caster、atlas 与 lighting 分支，进一步固化巨型 composition root。先建立 Frame Program 的消费者需求与物理 lowering，才可使 VSM 通过 Shadow owner 注册固定 topology，动态页量留给 GPU。

### 3.2 目标边界

`Renderer` 只负责接收配置、场景快照、device/capability 与 frame 生命周期，调用 Frame Program Builder、Graph compiler、编码和**唯一 submit**。Frame Program Builder 在 CPU 上基于稳定 feature profile、语义需求、capability 与 view family，决定本帧存在的**拓扑**、可用 lane、哪些 Surface 字段要物化、哪些可以融合、哪些历史要读写。GPU Work Fabric 负责在该 topology 内生成实际 meshlet、shading、page、ray、probe 工作数和 indirect args。FrameGraph 只负责编译依赖、资源生命周期、裁剪、别名机会与执行，不替上层判断产品语义。

定义 `Visibility Fact`（可见身份、深度、coverage/primitive、合法性）、`Temporal Facts`（motion、stable identity、local change、reactive/disocclusion、jitter/exposure）、`Surface Field Demand`（normal、roughness、albedo、material/closure、motion 等按消费者要求）。字段须标空间、分辨率、精度、无效值、生产者、消费者与缺失时行为。这里冻结语义，不先冻结每个贴图的物理格式。

### 3.3 实施顺序

1. 从 `RendererCore.ts` 的当前主帧构图读取真实 producer/consumer 表，标记 Graph 中当前 imported、transient 和 persistent 资源；记录历史 A/B 纹理与拓扑 key 的关系。只为**当前有消费者的事实**建新接口。
2. 抽出 Frame Program 的请求与结果：scene/view 的结构形状、feature profile、semantic products、field demand、available lanes、persistent binding 角色；本帧 scene/view revision 与真实物理对象只走执行期 bindings。首次仅表达当前 Visibility → Surface → Environment → FSR3/Present，不预先造所有未来效果节点。
3. 把 `RendererCore` 内按固定顺序的 pass 注册逐步迁到各 owner 的 `addToGraph`/registration API。每移动一段，即从当前主链切走原调用；不维护第二套可运行主链。Graph 编译后的节点必须存在实际输入/输出依赖，feature-off 无消费者节点自然裁剪。
4. 将 graph key 定义为有限的 topology identity（profile、layout/capability specialization、consumer demand）。history ping-pong、atlas generation、环境 LUT revision、当前 active scene generation 由 persistent handle 与 per-frame binding 传入，不使 graph cache 组合爆炸。
5. 将 pipeline/layout/bind group 生命周期分为 device 创建、product publication、frame reuse、device recovery。`SurfaceMaterialPass.ts` 当前按 active class 动态建 pipeline 的热路径留给 Surface v2 修改；本模块先给 Frame Program 预热入口和稳定资源依赖。
6. 保持 `FrameCoordinator.submitFrame` 唯一 owner；替换或重排任何功能时核对没有隐藏 `queue.submit`。工作队列的 count/overflow 仍在 GPU 消费路径内，不回读决定本帧下一 pass。

### 3.4 源码级切断清单

| 当前切入处 | 本模块要做的动作 | 同批撤下的旧职责 | 不提前做的事 |
| --- | --- | --- | --- |
| `RendererCore.ts` 的主帧构图和 `compileVisibilityGraph` | 把帧级输入收成稳定 Program request；以各 owner 注册的节点 lowering 到现有 FrameGraph | Renderer 内对效果的手写全局顺序和无消费者分支 | 新建第二个 Renderer 或复制完整旧 Graph |
| `RendererCore.ts` 的 `compileEmptyGraph` | 用相同 Program/Graph lowering 表达空场景 | 特例路径中重复的资源生命周期决策 | 为通过空场景测试制造假 Geometry work |
| `FrameGraphKey.ts`、`CompiledFrameGraphCache.ts` | key 只描述稳定 topology 与 capability specialization；persistent handle 晚绑定 | 将场景 generation、history A/B、环境 revision 当 topology key | 无依据扩大缓存组合数 |
| `VisibilityFeature.ts` 与 Visibility Binding | 把真正的 depth、identity、coverage/HZB consumer 关系写进 Program 产品连接 | Renderer 手工传递无语义标注的 GPU 对象 | 重写当前已经工作的 Geometry hierarchy |
| `SurfaceMaterialPass.ts` | 第一阶段继续作为真实 Surface consumer，由 Program 提供输入/输出需求 | Renderer 对 Surface 资源顺序的隐式拥有 | 在本模块重写所有 material class，留给 Surface v2 |
| `TemporalFabric.ts`、`TemporalGpuHistory.ts` | persistent history 作为产品句柄和 per-frame binding；保留 begin/commit/abort | history identity 进入 Graph topology | 此时强行统一所有 consumer 的 confidence |
| `FrameCoordinator.ts` | Renderer 仍只在统一路径 begin/encode/submit/abort | 任一效果独立提交或隐式等待 | 为观察而增加同步 readback |

切断顺序按真正依赖推进：先表达当前存在的产品，再让 Graph lowering 吃到这些产品，最后删除旧构图分支。不能先造一个空 Program API，再让旧 `RendererCore` 继续决定一切；也不能先删全部构图代码导致没有真实 Visibility→Surface→Present 输出。每搬迁一个 owner，就检查最终 Graph 中是否有真实资源边和唯一 consumer；这属于代码阅读/调试，不要求跑浏览器矩阵。

### 3.5 第一版语义字段的最小完整定义

本层的 schema 以**语义**为中心，避免过早写死物理纹理。每个字段在模块设计/代码中回答：谁生产、谁消费、视图/空间和分辨率是什么、缺失时如何降级、如何判断同一帧或历史版本。先覆盖当前路径中真实存在的字段，再让 VSM/SSSR/GI 的具体需求增量扩展。

| 字段组 | 必须冻结的语义 | 暂不冻结的物理选择 |
| --- | --- | --- |
| Visibility identity | 稳定 instance/product generation、primitive、coverage 与背景无效值 | HW/software raster 的具体 payload packing |
| Depth/HZB | 深度方向、归一范围、mip reduction 和屏幕空间对应 | VSM/SSSR 是否复用同一 physical pyramid |
| Motion | 当前像素对应的上一帧位置、单位、遮挡/新显露边界 | 压缩格式与是否单独 materialize |
| Surface normal/roughness | 几何与着色法线区分、粗糙度语义、法线有效域 | sidecar 格式、是否与其他 field 共包 |
| Surface radiance | scene-linear HDR、曝光域、覆盖和 alpha/composition 关系 | fused 或 materialized 的具体 texture layout |
| Temporal changes | scene/publication、材质、照明和相机局部变化的身份 | 各 denoiser/history 的 confidence 公式 |
| Shadow visibility | receiver 与光源空间的可见性、缺页与版本语义 | VSM 页表、atlas 格式和过滤核 |
| World radiance | 来源、能量归属、有效距离和 confidence | DDGI probe/brick/atlas 的内部格式 |

性能上的第一批设计检查只看热路径：是否按帧扫描全部材质、创建 pipeline/bind group、重编译 topology、额外 submit、全屏无消费者 Pass、同步读回动态工作数。发现这些结构问题直接改代码；正式 GPU 时间与质量比较留到真正消费者和完整场景都连通后。

### 3.6 本模块真正连通的定义

唯一生产 Renderer 使用 Frame Program 产生 Graph；Visibility、当前 Surface、Environment、FSR3/Present 由实际 owner 注册并消费；移走的旧构图分支没有残留生产引用；empty/feature-off 不保留无消费者资源和 pass；动态 history identity 不改变 topology key。模块闭合后再做 typecheck、build、FrameGraph/Renderer 相关 targeted tests，修真实问题，然后进入 Surface v2。跨浏览器画质/性能留待最终集成。

## 4. 模块 B：Surface / Material / Lighting v2

本模块的逐来源、数据流与性能取舍见[独立设计](../next-design/surface-material-lighting-v2.md)；B0–B8 的单链迁移、旧职责切断和模块收口见[独立执行文档](./surface-material-lighting-v2.md)。以下保留架构层顺序摘要，具体实施以两份模块文档和当前源码为准。

### 4.1 先设计的核心，不写三选一总开关

Surface 执行分成三个正交选择：**Work Scheduling**（dense 或 GPU binned）、**Sampling Policy**（full/coarse/temporal reuse 的合法范围）、**Execution Class**（closure、计算代价、所需资源）。同帧简单连续区域走 Dense Fast Lane，昂贵且发散的片元才支付 classify/compact/indirect 成本。材质 authoring ID 与 texture set 不能直接成为 shader class；程序身份只由稳定 shader/layout/capability/kernel specialization 决定。

### 4.2 迁移与数据流

1. 从现有 Visibility ABI 和 `SurfaceMaterialPass` 提取透视插值、解析梯度、UV/normal、贴图采样与标准 PBR 数学，核对完整上游来源；只迁移真实数学和资源消费，不延续旧 Sparse owner。
2. 先让标准 PBR 在新 `Visibility Fact → Surface eval → Direct light → Radiance` 路径中闭合。对 alpha、normal map、disocclusion 和运动边界保持 full-rate 安全边界；不能用粗频结果掩盖漏采样。
3. 以 GPU 产生的 bounded work records 为昂贵 execution class 分类；明确 record ABI、容量、溢出策略、counter、producer、consumer 与 indirect dispatch。Overflow 要在 GPU 上有可解释的保守覆盖，不能等待 CPU 回读后本帧补救。
4. Texture logical handle 与物理 Resident Array / Wide Profile / 未来 VT 解耦。所有 profile 必须维持同一材质语义；binding 上限与纹理驻留在 publication 前确定，帧热路径不因 active material set 创建大量 pipeline。
5. 固定 Lighting energy contract：Direct、Indirect Diffuse、Pre-Reflection HDR、Specular Indirect、Final Opaque 的顺序与归属。即使尚无 AO/SSSR/GI，也先有明确缺失行为，不把未来 provider 伪接入。
6. 接入真正消费者后删旧 Surface/Sparse 文件、Graph 节点、shader 变体、无消费者的 buffer 和检查期待。后续 VSM/SSSR/GI 只能要求新 semantic fields，不得重新定义一套材质主链。

### 4.3 性能决策与完成点

开发时先以 GPU 工作数量、pass 数、内存占用和热路径对象创建作静态/局部核对，不提前跑正式 benchmark。模块完成指标准 PBR 能从唯一 Visibility 输入到 final radiance、Dense Fast Lane 与有限 Binned Lane 有真实 GPU consumer、material authoring 与 execution class 分离、热路径不再按 active material class 建 pipeline、旧 owner 已退出生产链。届时集中 typecheck/build/必要 targeted tests。按需物化字段和融合布局属于下一独立模块。

## 5. 模块 C：Fuse + Demand-Materialized Surface Fields / XeGTAO

详细的目标、来源映射、WebGPU 物理方案和 C0–C8 顺序分别见[Module C 设计](../next-design/surface-fields-xegtao.md)与[Module C 执行](./surface-fields-xegtao.md)。这个模块不能被 Surface v2 基本 PBR 闭合吞掉。先让 Frame Program 从真实 consumer 收集语义需求，再降低到少量合法物理布局；同一 Surface kernel 将来可融合光照并物化少量真正复用的字段，不把全场 fused/materialized 当永久总开关。

1. XeGTAO 的法线输入是 view-space normal，固定源允许从 raw depth 独立生成；**不需要**先生产 full-screen material/shading normal sidecar。当前首个真实产品是 `indirect-visibility`：Visibility depth → XeGTAO normal/weighted depth prefilter/horizon/edge-aware denoise → Surface 间接光。
2. 对字段记录实际消费者、空间/精度/分辨率/无效值、曝光域、产生时刻与重新求值代价。当前 normal/roughness 留在 Surface 寄存器，XeGTAO 私有 normal/depth mip 属瞬态 scratch；无材质字段消费者就不分配 sidecar、不建完整 delayed Lighting 链。SSSR/GI 真正需要时再比较重建与写读带宽，并选有限布局。
3. 在唯一 Graph 中先让 AO 与 fused Surface Lighting 连通；GPU 决定本帧 work 数，Frame Program 决定固定 stage/layout，generation 和 frameIndex 不进入 topology key。最宽 Surface 已用满 16 sampled textures、15/16 storage buffers；AO 纹理不能直接加第 17 个 sampled slot，需按详细设计选合法输出编码。XeGTAO 五级 storage mip 与本设备 limit 也需按完整算法做调度适配。
4. 大模块原理连通后集中一次 typecheck、build 和必要 targeted tests，更新 currentSlice 随即进入 D。最终画质、GPU 时间、P50/P95、browser 与跨 feature 组合仍留整链验收，不为中间无消费者拓扑制造伪测试。

### 5.1 XeGTAO 的完整生产闭环

以 pinned XeGTAO 的 depth-normal、weighted depth prefilter、main evaluate、edge-aware denoise 完整选中 profile 为 donor。先对齐 WebGPU 的 reverse-Z、尺度、噪声、半径、法线和边界；既不要求全场固定 GBuffer，也不把旧 HZB 冒充 Xe depth mip。AO 仅在未遮蔽的间接光分支被消费，不能无差别乘最终 HDR。详细 source→local 阶段见[来源账本 R05](../porting/next-renderer.md)。没有原理闭合前不造常量 AO Pass 满足测试。

## 6. 模块 D：Temporal / Radiometry / Presentation

本模块的事实 ABI、history 事务、GPU 曝光、色彩和显示决策见[Module D 独立设计](../next-design/temporal-radiometry-presentation.md)；D0–D6 的源码入口、单链切断和一次模块收口见[Module D 执行](./temporal-radiometry-presentation.md)。以下保留架构层摘要。

1. 定义跨模块的 motion、stable identity、local change、reactive/transparency、disocclusion、jitter、pre-exposure 事实。明确当前/上一帧矩阵、空间与方向，避免由 FSR3 backend 自行定义运动语义。Surface 的 motion 必须来自真实几何/相机变化；不能因粗频着色把移动边界变成代表点的常量 motion。
2. 将 `TemporalFabric` 的 begin/commit/abort、resize/replacement/device loss 事务提升到共享生命周期。每个 consumer（FSR3、SSSR、GI、VSM cache）各自计算 history confidence；共享输入事实而不造全局单一置信度。
3. 让现有 FSR3 Upscaler 完整阶段消费上述 facts，记录缺失 reactive/transparency 或局部变化事实时的显式行为。旧 FSR3 production integration 是可复用 backend，不代表新 Temporal 合同已经成立；不要为了接线删上游算法阶段。
4. 建立 radiometric contract：scene-linear HDR、pre-exposure、auto exposure、tone map、color grading、SDR/HDR output profile 与最终 UI/composition 顺序。Temporal reconstruction、denoiser、aerial/sky 必须知道输入输出曝光和色彩空间。
5. 接通 camera cut、resize、空场景、替换和恢复的内部状态转移；模块闭合后集中 typecheck/build/针对 facts 与 lifecycle 的 targeted tests。最终浏览器画质、不同屏幕/场景矩阵另行验收。

## 7. 模块 E：Shadow Visibility 与 VSM

VSM 是新架构的跨 owner 压力测试，不只是 Lighting 内部一个采样器。它跨 GPU Scene 的 caster、receiver demand、GPU-produced residency、caster-page work、atlas raster、采样、cache invalidation 和 Temporal 事实。进入模块时先写详细 `next-design/vsm.md` 与 `next-execution/vsm.md`，选择固定 revision 的完整可移植算法来源；逐项对照其页表、裁剪/clipmap、分配、失效、回收、渲染、过滤与缺页行为。

WebGPU 主链不能假设 mesh shader、BDA、多 draw 或 GPU 生成任意数量 render pass。VSM 设计必须在**固定 FrameGraph topology**中解决 GPU 同帧 receiver demand → bounded page/slot allocation → caster-page records → atlas 内容生产；在实现前比较 atlas-space vertex transform、固定页 batch、软件 shadow raster 等物理方案。不可把 VG 的 CPU 延迟流送套到 VSM 的同帧页需求。需要定义预算、溢出、页失效、缺页显示策略、代际回收与采样一致性。

接入顺序：先 Shadow semantic product 和 direct-lighting consumer；再 receiver demand / GPU page allocation；再 caster work / atlas render；最后 cache invalidation、Temporal/recovery 与能量归属。每段从唯一 production Graph 接入并移走过时影子 owner。大模块原理连通后集中 typecheck/build/必要 targeted tests；最终再做移动视角、复杂场景、阴影质量和 GPU 性能矩阵。

## 8. 模块 F：Reflection 与 Hybrid GI

### FidelityFX SSSR

完整映射 tile/ray classification、indirect args、trace、hit validation、reprojection、prefilter、temporal resolve、denoiser 与 miss/fallback。Ray 队列记录容量、counter、溢出、GPU producer/consumer。Screen miss 必须与 World Radiance/Environment 有一致能量归属，不能简单把多个 specular 来源相加；只在语义兼容时共享 physical HZB。

### Screen / World / Sky GI

先冻结 World Query 和 Radiance Field 两个独立边界。Screen GI 提供近场信号，software world query 或具名替代方案提供遮挡/辐亮度样本，Atlas DDGI/brick cache 管理长期 radiance，Sky 负责无限远缺失。`World Sample Producer → radiance/distance sample → probe/brick update → field → lighting consumer` 必须闭合；probe 存储本身不算 GI。动态几何/灯光、失效半径、更新预算、历史置信度和能量守恒进入模块设计。

SSSR 与 Hybrid GI 是两个独立大模块，各自生产链闭合后集中代码检查并更新 workstream；不要为了等其他 provider 的正式验证而停工。完整跨 feature 质量与性能留到最终集成。

## 9. 模块 G：Virtual Resource、Transparency 与 Media

Virtual Resource 共享 logical ID、demand、budget、generation、priority、eviction 和 telemetry 思想，但明确 **streamed residency**（VG/VT，可延迟 CPU/IO fulfillment）与 **GPU-produced residency**（VSM、部分 GI cache，同帧或近帧 GPU fulfillment）两种物理模型。先在已工作模块中收敛控制面，再决定 VT 页表/物理采样和反馈格式；不能给现有 texture residency 改名冒充完整 VT。

Transparency/Hair/Transmission 不塞进 opaque Visibility 或 material class；coverage/composition、geometry representation、surface closure 分轴。Media 以 Froxel 等独立表示参与环境、局部体积与散射，定义与 sky、direct light、shadow、presentation 的合成次序。此阶段按各大模块内部真正闭合后做代码级集中检查，不要求全链提前通过。

## 10. 跨模块所有权与产物

| 语义层 | 主要 owner | 向下游交付 | 不拥有 |
| --- | --- | --- | --- |
| Asset/Scene publication | GPU Scene / Product / Loader | 稳定 logical handle、revision、实例/几何数据 | 本帧最终可见列表 |
| Geometry/Visibility | GPU work / Visibility owner | depth、coverage、primitive/instance identity、HZB | 材质闭包与 Lighting 能量策略 |
| Frame Program | Renderer composition / planner | topology、semantic demand、lane availability、persistent bindings | GPU 动态 work 数和 FrameGraph 资源细节 |
| FrameGraph | graph runtime | dependency、transient lifetime、compiled topology、encoding | feature 语义和质量决策 |
| Surface/Material | Surface owner | 按需 fields、radiance input、motion/change facts | Shadow 页管理或最终 display transform |
| Light Transport | Shadow、AO、Reflection、GI 各 owner | 阴影可见性、AO、specular/indirect radiance | 第二条主渲染链 |
| Temporal/Presentation | Temporal 与 presentation owner | reconstruction、曝光/色彩变换、final output | 重新定义几何身份与 world query |

所有 typed GPU queue 记录元素 ABI、容量、计数器、overflow、生产者、GPU 消费者、feature-off 行为。所有新 semantic product 标空间、尺度、单位、颜色/曝光约定、覆盖、无效值、版本与生命周期。只在字段已经被真实消费者使用且边界稳定时形成精确 contract/spec；不要为未来节点提前写空实现。

## 11. WebGPU 2026 的实施约束

生产 baseline 使用协商后的 compute、storage、texture array、indirect 与常规 HW raster；subgroups、primitive-index、shader-f16、immediates、transient attachment、buffer view 与更高 binding tiers 可做有限 specialization。能力先协商再创建资源，增强路径只改变物理布局、kernel 或 binding，不改变跨 owner 语义。实验性 multi-draw、mesh/task shader、BDA、硬件 RT、64-bit 原子与通用 bindless 都不得成为主链前提。

对每个增强路径同时记录 WebGPU 公开规范状态、目标浏览器实测能力、资源 limit、fallback 和真正收益；前期可只留设计空位，不必为了“最新特性”生成没有消费者的分支。FrameGraph 重点优化内存复用、transient、graph cache、pipeline warmup 与 CPU encode/binding；不模拟 WebGPU 无法直接控制的 Vulkan barrier 或多队列语义。

## 12. 何时检查与何时进入下一模块

模块内部持续实现，允许阶段性画质、历史效果或旧测试暂退。只有六项硬红线要求即时处理：retired owner 复活、双 production path、本帧 GPU→CPU→GPU visible/work control、独立 frame submit、pinned 复杂算法近似冒充完整 port、真实编译失败。发现这些问题就修；其他待办进当前代码工作或 deferredValidation，不停工等人确认。

**模块闭合检查**：核心 producer → consumer 真正连通，原理上的 pass/资源/队列受 owner 管理，旧生产调用被切走；然后集中运行 typecheck、build 和相关 targeted tests。未运行的浏览器、性能、claim 明确记录为未运行即可。修明显问题，更新 workstream 的 currentSlice/nextModules，再直接开始下一个模块。无需 clean revision 或 formal evidence 才能继续。

**全链验收**：计划的核心架构、Shadow/AO/Reflection/GI、Temporal/Presentation 与必要 Virtual Resource/Media 都进入唯一生产链后，集中运行独立 validation host：浏览器矩阵、resize、camera cut、device loss/recovery、不同场景/材质和 feature interactions、画质对照、GPU pass/CPU encode/submit、内存预算、P50/P95。此时再修跨模块问题、生成正式 evidence 并更新 claims。任何诊断记录不得伪称正式通过。

## 13. 上游实现、研究与移植节奏

复杂算法进入代码前查 GitHub 完整开源实现、论文和详细文章，优先固定可移植源码的 commit/revision、许可证、入口与阶段。模块设计表需列“源入口/数据/决策分支/输出 → 本地 owner/资源/Pass/WGSL 差异/保留的不变量”；源算法没有的阶段不编造，有的必要阶段不删除。选择完整 donor 与 WebGPU 调度可分开：语义/数学忠实迁移，物理执行适配 WebGPU。缺少完整 donor 时用具名本地方案，并说明检索范围与不可照搬之处。

已可作架构研究的项目包括 [The Forge](https://github.com/ConfettiFX/The-Forge) 的 Visibility Buffer 组织、[Granite](https://github.com/Themaister/Granite) 的图和资源生命周期、[Filament](https://github.com/google/filament) 的材质/光照数学。它们不是整套 EEngine 架构 donor：The Forge 的 native draw/binding 假设、Granite 的 Vulkan 原生调度与 Filament 的材质/后处理接口都需按 WebGPU 与本工程语义重映射。细算法来源及当前移植映射见 [Next 来源账本](../porting/next-renderer.md)。

## 14. 下一次动手的具体起点

workstream 已将 currentSlice 切到 `frame-program`。下一次代码实施先读取 `RendererCore.ts` 主帧构图、`FrameGraph.ts` 编译与 late binding、`VisibilityFeature.ts` 产物、`SurfaceMaterialPass.ts` 热路径和 `TemporalFabric.ts` 的生命周期；画出当前资源生产/消费表。再写最小 Frame Program 请求/结果和语义产品边界，以现有生产链的真实消费者完成首个 lowering。随着新路径接通，逐块删除 RendererCore 的旧手写拼图代码；不要建立第二个 Renderer，也不要为未实现的 VSM/SSR/GI 预造空 Pass。

这一模块的首个大完成点是唯一生产 Renderer 完全由 Frame Program 选择 topology，并且仍有真实 Visibility→Surface→Presentation 输出；达到该点再做一次代码级集中检查，然后开始 Surface v2。
