# Module A 执行：Frame Program 与语义事实层

> 状态：模块 A 已按当前生产链完成（2026-09-27）；本文件保留迁移路线供后续追溯。实现事实见[Frame Runtime](../domains/frame-runtime.md)，目标与取舍见[模块 A 设计](../next-design/frame-program-module-a.md)。workstream 的 `currentSlice` 已推进到 Surface v2；浏览器矩阵和性能验收仍在最终阶段。

## 0. 执行纪律与边界

在这一大模块内连续实现，沿唯一生产 `Renderer` 逐段切断旧手写构图；不创建 `RendererNext`、旧新开关、兼容桥梁、独立提交或无消费者的未来 Pass。普通中间修改不用 `verify --changed`、浏览器、evidence、claim、clean revision、benchmark、workstream exit check，也不用逐批同步 current docs。遇到真实编译失败直接修；其余只在本模块主链连通后集中做 typecheck、build 和必要 targeted tests。

Module A 是**本地语义编排与 WebGPU 资源生命周期集成**，不是复杂效果移植。已核查 Granite/Filament/GDC FrameGraph 资料，固定 source/revision/license 与源职责→本地职责对照见[来源账本 R21](../porting/next-renderer.md)；它们不提供可直接移入的 Semantic Frame Program。若工作中涉及新算法或完整效果，先查 GitHub 完整实现，再查论文/详细文章，固定 donor 的具体源码与许可并建立逐阶段映射；WGSL/CPU oracle 和新主链 GPU 消费齐备后才更新采用状态。简单 key、ABI、绑定和生命周期胶水标为本地集成，不能借拆任务把复杂算法归进去。

### 完成边界

本模块交付的是 `Renderer → Frame Program → FrameGraph → GPU consumer → Present` 的**真实单链**，以及正确的 topology/cache/late binding。它不交付 Surface v2、AO、VSM、SSSR、GI、VT、新 Temporal backend 或正式性能声明。FSR3 原算法阶段仍完整运行，但它的历史纹理必须变成执行期绑定；这只是 host 改写，不是重新选 FSR3 算法。

## 1. 开工前的源码定位与风险图

先按当前规则运行 `node tools/vibe.mjs context OEngine/src/render/pipeline/RendererCore.ts`，读当前设计、现有 owner 与下表源码。不运行检查矩阵。源码可能继续变化，实施时以实际调用和 Graph dump 为准；如果表中某调用已移动，沿真正的 producer/consumer 追踪，不创建同名空接口。

| 位置 | 要读的实际入口 | 预期发现/动作 |
| --- | --- | --- |
| `render/pipeline/RendererCore.ts` | `render`、`renderEmptyScene`、`compileVisibilityGraph`、`compileEmptyGraph`、`shutdown/recoverAfterDeviceLoss` | 标出 CPU preparation、Graph 结构、每帧物理绑定、submit/abort 四类职责 |
| `render/features/VisibilityFeature.ts` | `prepare`、`addToGraph`、late HZB recheck | 区分 GPU work 真实数与结构性 lane/容量；保留 Visibility producer |
| `render/surface/ShadingWorkPass.ts`、`SurfaceMaterialPass.ts`、`SurfaceFrequencyResolvePass.ts` | `addToGraph` 与当前 class/frequency 输入 | 识别本模块仍必须随结构 key 变化的 class/layout；不提前重写材质算法 |
| `render/passes/fsr3/Fsr3UpscalerRuntime.ts` | `prepareFrame`、`addToGraph`、`commit`、`invalidate` | 枚举所有直接导入的 A/B history、constants、mask 与纹理格式；找注册期捕获点 |
| `render/environment/PhysicalEnvironmentRuntime.ts`、`AtmosphereLutResources.ts`、Sky/Aerial Pass | record、LUT publication/retirement、资源 import | 分离 LUT profile/descriptor 与 generation；保留旧资源的 GPU 完成后退役 |
| `framegraph/FrameGraph.ts`、`CompiledFrameGraphCache.ts`、`FrameGraphKey.ts` | binding slot、import、compile、execute、key/LRU | 在现有编译器上 lowering，裁掉陈旧并行 key 描述 |
| `render/FrameCoordinator.ts`、`framegraph/ShadeGPUCommandContext.ts` | begin/submit/abort/finish | 核对帧内只有一个 command owner，错误时不提交半帧 |
| `render/pipeline/FrameProducts.ts`、`Phase3Products.ts`、`surface/SurfaceProducts.ts` | 产品类型/工厂与状态 | 只借用真实语义；已声明但未接线的事实不标 production |

第一份工作笔记用一张**当前资源边表**，无需新验证框架。至少记：VisibilityKey、depth/HZB、GPU ShadingWork、Surface radiance/motion、Physical Environment、FSR3 每个 history read/write、swapchain；每项列 producer、consumer、Graph ResourceId、物理 GPU 对象 owner、尺寸/格式、是否进入当前 key、失效/退役条件。还要列图外的 `encodeFrameMaintenance`、environment LUT record、direct light upload 与 view update，避免“图里无节点”被误认为这部分没有成本。

## 2. 代码切断的顺序总览

```text
A0 源码资源边与来源核查
  → A1 最小语义 Product / Program Request
  → A2 demand closure 与唯一 topology key
  → A3 当前 Visibility→Surface→Environment→FSR3→Present lowering
  → A4 FSR3/Environment 等物理资源的执行期绑定
  → A5 空场景、feature-off、abort、resize 与 recovery 收敛
  → A6 删除旧构图和死 key；大模块集中检查
  → Surface v2
```

这不是七个需要逐批验收的小模块。A0–A6 在同一 currentSlice 连续推进，编译/单项测试只用于定位真实技术问题。跨步骤的桥接必须短暂且不可作为第二条可运行生产 Renderer；每次新 owner 的 Graph 输出被当前 downstream 消费后，立即切走原 `RendererCore` 对应片段。

## 3. A0：把当前主帧图变成可迁移资源边

1. 按实际 `RendererCore.ts::compileVisibilityGraph` 顺序列出所有 `graph.import_resource`、owner `addToGraph`、手工 `graph.add`、Present 写入、side effect 与编译结果。区分 `Graph` 的结构参数和 `FrameGraphBindingLayout` 的动态对象。
2. 对每个绑定追查注册时是否读取**实际对象**。尤其当前 FSR3 `addToGraph` 在构图时取 `readIndex/writeIndex` 和 `histories.color/luma/...`；当前环境 LUT views 直接传给 `import_resource`。记录为什么现有 key 必须包含它们，避免先删 key 造成跨帧错读。
3. 从 `render` 主帧逐项记录 frame prepare→encode→submit→commit 的实际顺序；从 `renderEmptyScene` 记录缺少 runtime 的路径；从 catch/finally 记录 abort/FSR3 invalidate/环境 abort/帧计数。只迁移结构决策，不更改这些事务的相对顺序，除非有明确生命周期理由。
4. 对照 R21 的 Granite/Filament：源 `add_pass/addPassInternal` 与本地注册、源 `bake/compile` 与本地图编译、源 physical resource/import 与本地生命周期的职责相似；标明它们**没有**提供 Semantic Product closure。本步骤不复制外部源函数或创建“Granite port”。

输出是一份可在 PR 描述或本模块设计附录中阅读的资源边表。它用于指导实施，不是每次改动都更新的 formal evidence。

当前源码核对后的完整资源边、逻辑 ResourceId、物理 owner、尺寸/格式、结构 key 与退役条件已写在[模块 A 设计 §9](../next-design/frame-program-module-a.md#9-a0-生产资源边清单2026-09-27-源码核对)，包括五组 FSR3 read/write history 和图外维护工作。后续调整以源码实际 producer/consumer 为准。

## 4. A1：最小语义 API，不预造未来模块

建议在 `OEngine/src/render/program/` 新建少量文件；实际命名可随代码调整，但下列职责不能重新散回 `RendererCore`：

| 建议文件 | 职责 | 不放入此文件 |
| --- | --- | --- |
| `FrameProgram.ts` | `RenderIntent`、`ProductDemand`、`ProgramRequest`、`ProgramPlan`、有限产品/owner ID 与需求闭包规则 | WebGPU texture/buffer 实例、每帧 GPU counter |
| `FrameProgramLowering.ts` | 将已闭合计划交给明确列出的现有 owner `addToGraph`，记录 producer→consumer 资源句柄，并编译一张现有 FrameGraph | 第二个图编译器、通用插件扫描器、算法 shader |
| `FrameProgramBindings.ts` | 执行时 View/Scene/job/history/environment/swapchain 等物理对象的 typed binding map 与必要的 shape assert | 能改变 topology 的本帧 readback 决策 |

首版 `ProgramRequest` 至少表达 capability/layout profile、输出与内部尺寸、view family（当前单主视图）、scene publication shape、enabled owner/feature profile、现有 material execution-class/layout shape、所需输出 intent。它**不**装本帧 meshlet 数、材质实例数、FSR3 readIndex、LUT generation、camera motion flag 或资源对象 identity。

首版 `ProgramPlan` 只包含当前真实链上的产品需求、owner 顺序、有限 lane/资源 descriptor、结构 key 与 binding 角色。最小根需求是 `Present/output-full color`；它收集 FSR3 的 color/depth/motion、Surface 的 Visibility/ShadingWork 等，再交给 lowering。可选 PhysicalSky/Aerial 以真实启用和输入可用为条件；缺少可选产品按明确 fallback 跳过。缺少必需 producer、多个权威 producer、未声明空间/曝光转换或依赖循环，直接抛出具名错误。

`Visibility Fact`、`Temporal Facts`、`Surface Field Demand` 的第一版元数据记录空间、尺寸、coverage、无效值、数值/曝光、producer、consumer 和版本条件。仅对当前已接线字段形成生产状态；roughness/reactive/local change/stable identity 不分配纹理或空实现。不要让 `FrameProducts` 中历史遗留的宽类型自动成为新 Program 的物理资源清单。

## 5. A2：收敛结构 key 与 Program 缓存

先建立一份“每个 key 字段改变哪项 Graph 结构”的表，并在代码中只对结构字段做稳定序列化。尺寸、format、capability specialization、启用的实际 owner、Pass 资源 descriptor、必要的 class/bank layout shape 可进 key；current swapchain、camera/view/jitter、scene generation、HZB read/write、环境 LUT generation、FSR3 generation/readIndex/writeIndex 不进 key。`FrameGraphKey.ts` 当前无人引用、保留 `sparseShadingRevision`；选择**重写为唯一 Program key 或删除**，不与 `RendererCore` 的数组 key 并行。

实施时保持 `CompiledFrameGraphCache(8)` 的 LRU 行为；新 key 的 owner 与编译图缓存必须在同一个 device epoch 内一致，resize/format/capability 导致新图，device loss 直接清空旧图。每次命中图时断言当前绑定仍符合注册时的 descriptor/profile；不一致时以结构重编译或明确错误处理，不能静默复用。

当前 `activeClasses`、texture bank mask 和 virtual bank 数可能确实改变 Graph 的 pass/binding 数，Module A 暂可把**规范化后的形状**放进 key。相同形状下的材质 ID、纹理内容或场景对象变动不能改变 key。Surface v2 再把 class/layout family 收敛为更少的稳定 kernel；Module A 不假装这项后续优化已经完成。

相机运动当前会关闭 `adaptiveShading`，造成不同图。Module A 先固定当前生产 profile 为 full-rate Surface，明确记录空间降频在此阶段暂停；配置字段不触发 camera-driven graph rebuild，也不回退到代表点常量 motion。Surface v2 负责在固定 topology 内恢复 dense/binned/adaptive。该过渡正确性选择不可被写成已达最终性能目标。

## 6. A3：把当前 Graph 注册迁到 Program lowering

按消费者依赖搬迁，不复制完整 Graph：

1. `RendererCore.render` 仍负责准备 runtime、streaming、scene patch、View、HZB、Visibility job、FSR3 frame constants、环境 publication 和 swapchain。它生成 `ProgramRequest` 与**当前帧** `FrameProgramBindings`，调用 Program cache/Graph encode。不能让 Program 直接调用 `queue.submit`。
2. `FrameProgramLowering` 先接 Visibility 的 `prepare` 结果、depth、camera、counters、meshlet work；调用现有 `VisibilityFeature.addToGraph`，然后注册 HZB 及可选 current-HZB late recheck。晚期 recheck 的资源边由实际结果决定，不因未来 provider 增添空节点。
3. 以 Visibility 结果注册 ShadingWork、材质/实例/几何/texture/light imports、当前 `SurfaceMaterialPass` 与必要 frequency resolve。Motion、radiance 要流向 FSR3/环境，不允许只生成一个 ResourceId 而无人读取。注册期的 `activeClasses` 结构形状须与 A2 key 完全一致。
4. PhysicalSky、Aerial 与 FSR3 只在闭包中确有消费者时注册；Present 是最终输出消费者。所有进口资源由对应 owner/typed binding 提供；不得为了降低 `RendererCore` 行数简单把原方法整块粘到一个超大 `FrameProgramLowering`。
5. 每搬完一个 owner，即删除 `RendererCore.compileVisibilityGraph` 中该片手工排序/导入逻辑，让唯一 `render` 路径消费新 lowering。完成时 `RendererCore` 不再决定效果间顺序，只保留 owner 初始化、帧事务和 Program 调用。

内部可保留极薄的当前 owner adapter，但 adapter 必须明确返回语义产品和资源边，不能包住旧私有“大构图函数”继续让它作真实调度。静态结构由 Program 决定，FrameGraph `read/write` 决定实际 Pass 顺序；两者的 dump 要能互相对应。

## 7. A4：逐个解除注册期物理对象捕获

### 7.1 FSR3 history 与常量

`Fsr3UpscalerRuntime.addToGraph` 现在在图构造时取 `histories`、`readIndex/writeIndex`，并直接 import 具体 `GPUTexture`。先给 FSR3 的 previous/current color、luma、lumaHistory、accumulation、frameInfo、constants、RCAS constants、default mask 建稳定语义 binding 角色；再让每个 import 使用 `FrameGraphBindingLayout` 或同等执行期解析机制。读/写角色仍由 `Fsr3UpscalerRuntime.prepareFrame/commit` 的事务决定，Graph 只知道读写不同角色，不能让同一实际 history 在同帧既读又写。

实现时逐 Pass 检查是否在注册期另行捕获历史纹理、texture view 或 bind group。只在**所有**相关入口都从当帧绑定取资源，且 resize/device loss 能更新 binding 后，才从 topology key 删除 FSR3 generation/index。不得为了 cache hit 删除或跳过 Prepare Inputs、luma/shading pyramid、reactivity、instability、accumulate、RCAS 的既有阶段。

### 7.2 Physical Environment 与 HZB

把 Sun 参数 buffer、transmittance/scattering/higher-order/irradiance LUT 的 Graph import 改为 owner 提供的稳定角色和 per-frame 对象；相同 profile/尺寸的环境 generation 不再参与结构 key。`PhysicalEnvironmentRuntime.record/commit/abort` 与 `AtmosphereLutResources` 的 pending/retired 状态保持原语义，旧 LUT 在其最后 GPU 使用完成后退役。LUT profile/descriptor 真变时换结构图。HZB 的 current/previous 也按角色绑定，但其构建和 late recheck 仍保留真实 GPU producer/consumer 边。

### 7.3 每帧绑定校验

`FrameProgramBindings` 在 graph encode 前核对必要对象存在、device epoch 一致、尺寸/format/layout 与 plan 匹配、同一 publication 的相关 buffer/texture 成组发布。若校验失败，不 submit 半帧；走已有 abort。校验只读取 CPU 已知元数据，不 map GPU buffer、读回 queue counter 或做本帧 CPU 可见列表。动态图/对象 identity 通过 binding slot 而非闭包常量进入 Pass。

## 8. A5：空场景、feature-off 与生命周期

`renderEmptyScene` 改为调用同一个 Program/Graph 获取与执行入口，使用合法的 `empty/present-clear` 结构 profile：清色并写 swapchain，不构造 Visibility/ShadingWork/Surface/FSR3 的假工作。两个 profile 是同一 Renderer 中的两种拓扑，不是两条可选 production Renderer。Renderer 的 begin/submit/abort 代码尽量共享，保持原错误处理与帧计数语义。

逐项检查以下状态转移：

| 事件 | 必须保持的实际行为 |
| --- | --- |
| feature-off | 没有 downstream consumer 的 Pass、GPU buffer、readback、history 或 submit 都不出现；图外 LUT/owner 初始化也要核对 |
| resize / render scale | 结构 key 体现 descriptor 变化；history 明确失效或重建；旧 GPU 资源按现有完成边界退役 |
| camera cut | 不换 topology；HZB、FSR3/Temporal 按现有 invalidation 重置 |
| scene/Product replacement | 相同 layout 可换 binding；layout/容量变化才编新图；不能把不同 generation 混在一次 frame binding 中 |
| encode error / abort | 不 commit FSR3、Temporal、环境或 Product 暂存状态；无半帧 submit；保留原始异常 |
| device loss/recovery | 销毁旧 cache/Program GPU 关联，按 CPU authoritative Scene/Product truth 建新 device owner，history 从无效状态恢复 |

`FrameCoordinator.submitFrame` 是唯一 frame submit owner。搜索新增/迁移范围中的 `queue.submit`、`finish`、`mapAsync` 等调用，核对它们不是功能私有的同帧可见/work 控制。异步 streaming/telemetry 只影响后续帧或低频预算。

## 9. A6：删除旧职责与模块闭合检查

完成真实 lowering 后，删除 `RendererCore` 的旧 `compileVisibilityGraph`、`compileEmptyGraph` 结构拼装及 `VisibilityGraphBindings/EmptyGraphBindings` 中不再需要的形态；旧 `FrameGraphKey.ts` 选择收敛或删除，旧 test 对旧方法的文本匹配相应重写为新产品边检查。没有消费者的辅助资源、Pass 与缓存字段直接删除，不把旧路径挂在 debug 开关后。`Renderer.ts` 继续只 re-export 唯一 Renderer，不新增第二个 entry point。

本模块完成时集中运行一次引擎 typecheck、build 和**确有风险的** targeted tests。例如现有 `fsr3-frame-lifetime.test.mjs`、`temporal-fabric.test.mjs`、`phase3-production.test.mjs`、`render-layer-ownership.test.mjs` 中与实际迁移有关者；如现有测试不能证明同一编译图跨 history A/B 与环境 generation 复用、或空场景/feature-off 单 submit，就在对应稳定 seam 补少量有意义的 contract 测试。测试必须读取真实 Program/Graph 结果或 binding 行为，不靠字符串包含、空 Pass 或伪 GPU 记录镜像实现。

完成判据逐项核实：

1. 唯一生产 Renderer 的非空帧确由 Frame Program 决定 owner 需求与 Graph topology，VisibilityKey/depth 经真实 ShadingWork/Surface 到 FSR3/Present；空帧由同一入口生成 clear/present profile。
2. camera move、FSR3 A/B、同 layout 环境 LUT generation 变化仍命中结构 cache，实际绑定为当帧对象；尺寸/format/layout 变化则重编译。没有为了 cache hit 把错误 history、旧 LUT 或过期 scene 对象绑定给 Pass。
3. FrameGraph dump 中产品生产者和消费者均可追到实际资源读写；feature-off 不保留无消费者节点或图外 GPU 工作。
4. 正常/错误/resize/replacement/device recovery 的 owner 事务保持一致，当前帧仅由 `FrameCoordinator` 提交一次，不出现 GPU→CPU→GPU visible/work control。
5. typecheck、build 和所选 targeted tests 通过；明显问题修复。来源账本仍把 R21 标为架构参考，不虚报 donor port。随后集中同步当前事实文档、更新 workstream 的 currentSlice/nextModules，并**直接进入 Surface v2**。

### 暂缓到整体 Next Renderer 完成

浏览器矩阵、resize/camera cut/device loss 的系统化组合、不同场景/材质/feature interactions、视觉质量比较、GPU benchmark、P50/P95、formal evidence 和 claims。模块 A 的代码检查只确认结构与真实当前消费者连通，不产生 Runtime Validated 或 Performance 声明。

## 模块 A 逐项复核（2026-09-27）

| 步骤 | 已落地的生产行为与核对位置 |
| --- | --- |
| A0 | [设计附录 §9](../next-design/frame-program-module-a.md#9-a0-生产资源边清单2026-09-27-源码核对)逐项记录 Graph 逻辑 ID、物理 owner、尺寸/格式、key、绑定、失效与图外维护；来源账本 R21 仍为架构参考。 |
| A1 | `FrameProgram.ts` 的 `FrameProductFact` 限于已有真实产品，`present`/`main` 单视图请求形成最小根；闭包逐项验证必需 producer 和循环。单一产品规范表保证每个产品只有一个权威 producer；实际 texture descriptor 在 lowering 校对。 |
| A2 | `FrameProgramCache(8)` 和 `CompiledFrameGraphCache(8)` 共用版本化结构 key；同形状请求复用对象，未采样 bank mask 归零，动态 scene/history/LUT/swapchain 身份留在绑定。旧并行 `FrameGraphKey.ts` 已删除。 |
| A3 | `RendererCore.render` 只准备当前帧并调用 `lowerFrameProgram`；`FrameProgramLowering` 按 Visibility/HZB→ShadingWork→Surface→Sky/Aerial→FSR3→Present 注册真实 owner。空场景从同一 Program 入口选择 clear/present。当前 HZB late recheck 的过滤队列被后续 ShadingWork 消费。 |
| A4 | FSR3 五类 history 与 constants/mask 均经执行期 Graph slot；Sky/Aerial 的 Sun/LUT import、HZB 当前/上一角色、Scene/Product bank 与 View 使用当帧 binding。编码前检查 epoch、View/Scene 分组、深度/HZB/FSR3 尺寸格式、history 非别名、环境 LUT 完整性。FSR3 旧 history 与 LUT 旧 generation 依提交完成退役。 |
| A5 | `FrameCoordinator` 保持唯一 render-tick submit；Graph 编码异常走 abort，FSR3/Temporal/Environment 不推进，HZB 显式失效；resize 重新选择 key 并重建 history，camera cut 仅失效 history，新 Renderer recovery 拥有空 cache。空场景不记录 Visibility/Surface/FSR3。产品上传和诊断 readback 是非本帧可见决策路径。 |
| A6 | `RendererCore` 旧手写构图和并行 key 已切除；Surface motion 由真正 clear Pass 生产，空分配 Pass 删除；旧构图文本断言更新为 Program/Graph 边检查。已集中运行 typecheck、build 和相关合同测试；详细命令/结果以本次提交记录为准。 |

**当前边界**：Module A 使用固定 full-rate Surface。旧 `spatial_shading_frequency_enabled` 仍被独立 browser diagnostic 引用，但对生产图无效；Surface v2 应恢复固定拓扑内的 GPU 频率计划并迁移该诊断。此遗留开关不作为模块 A 性能达标声明。模块级测试检查 CPU 语义、Graph 编译与绑定事务，未执行最终浏览器矩阵或 GPU P50/P95。
