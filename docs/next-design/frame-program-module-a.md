# Module A 设计：Frame Program 与语义事实层

> 状态：模块 A 已接入当前生产链（2026-09-27）；后续 Surface v2 仍按[最终架构](./eengine-next-overall-architecture-final-2026.md)继续。对应迁移记录见[模块 A 执行文档](../next-execution/frame-program-module-a.md)。第 2 节的“当前事实”表保留实施前的问题定位，实施后的事实以[Frame Runtime](../domains/frame-runtime.md)及源码为准；本状态不代表浏览器或性能验收。

## 1. 要解决的实际问题

EEngine 当前已经有 GPU Scene、GPU 工作生成、Visibility、Surface、物理环境、FSR3、FrameGraph 与唯一帧提交。它缺少的是位于 Renderer 与 FrameGraph 之间的**薄语义编排层**：谁需要哪些事实、哪些 owner 提供这些事实、有限的物理 lane 与尺寸是什么、哪些资源身份仅在本帧绑定。现在这些决策散在 `RendererCore.ts` 的主帧构图和各 Pass 的 `addToGraph` 调用之间。继续把 AO、VSM、反射和 GI 插入该方法，会把 Renderer 再次变成集中式效果调度器。

模块 A 的目标是：保留一条生产 Renderer、一条 GPU Scene→Visibility→Surface→Environment→FSR3→Present 路径及唯一 submit；将**静态/半静态 topology 与语义需求**编译为 Frame Program，再降低到现有 FrameGraph。当前帧真实 meshlet、Surface、页、射线等数量仍由 GPU 产生并消费。Frame Program 不读取 GPU counter 决定本帧工作，也不为未来模块创建空 Pass。

本模块只重构边界和现有生产链。Surface v2 的材质类/采样/频率算法、Fuse 与字段物化策略、统一 Temporal Facts 的完整生产、VSM/SSSR/GI 的算法都属于后续模块。允许本模块期间暂时只运行 full-rate Surface，以维持相机运动下的时序正确性；Surface v2 再恢复更高效的 dense/binned/adaptive 组合。

### 1.1 成功的工程形态

```text
Render Intent + Capability Profile + Scene Publication Shape + View Family
                              │
                              ▼
                   EEngine Semantic Frame Program
                   ├─ consumer demand closure
                   ├─ finite topology / lane decision
                   ├─ semantic products and owner edges
                   └─ structural topology identity
                              │ lower
                              ▼
              existing FrameGraph: resource/pass dependency,
              culling, transient lifetime, compile and encode
                              │ runtime binding
                              ▼
             GPU Scene → Visibility → Surface → FSR3 → Present
                              │
                              ▼
                 FrameCoordinator: one frame submit
```

这里的 Program 是本地架构集成，**不是 Granite、Filament 或 Frostbite 的算法移植**。源码对照、许可证和未能直接移植的语义缺口登记在[来源账本 R21](../porting/next-renderer.md)。本模块不引入新的完整图算法或效果；若实施中加入这种算法，先按[通用移植规则](../porting/README.md)重新选完整 donor、固定源码，并建立源阶段映射。

## 2. 现有源码事实与设计推断分开

| 当前事实（源码入口） | 对 Module A 的影响 |
| --- | --- |
| `RendererCore.ts::render` 准备场景、View、HZB、Visibility job、Temporal/FSR3，并生成 graph key；`compileVisibilityGraph` 按固定顺序注册 Visibility、HZB、ShadingWork、Surface、Sky、Aerial、FSR3、Present | Renderer 同时决定语义、物理绑定和生命周期；Frame Program 应接管前两者中的**语义与拓扑选择**，Renderer 保留帧所有权 |
| `RendererCore.ts::renderEmptyScene` 和 `compileEmptyGraph` 另造清屏图，仍通过同一 `FrameCoordinator` 提交 | 空场景是同一 Program 的合法结构 profile；无需假 Geometry work，也不是第二条 Renderer |
| `FrameGraph.ts::compile` 依据显式 read/write 构依赖、裁剪无消费者节点并排序；`FrameGraphBindingLayout` 支持执行时解析对象 slot | 现有 FrameGraph 可复用；Program 不重写图编译器，late binding 可以建立在已有 slot 上 |
| `CompiledFrameGraphCache.ts::getOrCreate` 缓存编译图并 LRU 淘汰 | key 必须只描述实际图结构；淘汰/设备销毁必须释放图持有的资源引用 |
| `FrameCoordinator.ts::submitFrame` 负责当前帧唯一 finish/submit；`RendererCore.ts` 正常与空场景均调用它 | owner 迁移不得让 feature 自行 submit、finish 或同步 readback |
| `Fsr3UpscalerRuntime.ts::addToGraph` 在注册时读 `readIndex/writeIndex` 并直接导入 history GPUTexture | **不能只删 key 中的 history index**；须先把 read/write 资源变成每帧绑定，证明同一编译图可跨 ping-pong 重用 |
| `RendererCore.ts` 的 key 含 environment generation、FSR3 generation/index、active classes、texture bank mask，且相机移动可改变 `adaptiveShading` | 当前 key 混有资源版本和运动驱动决策；必须按结构/绑定/运行时量分类迁移 |
| `FrameGraphKey.ts` 定义旧 `sparseShadingRevision` key 类型，但生产 Renderer 自行 `JSON.stringify`，没有引用该函数 | 这是陈旧的并行 key 描述；模块 A 应以唯一的 Program key 类型替换或删除，而非保留两套权威 |
| `SurfaceProducts.ts` 与 `Phase3Products.ts` 已声明部分产品语义，但并非每个名字都有独立物理输出 | 新 Program 只把有真实生产者与消费者的字段纳入当前需求闭包；目标事实可先定义语义，不伪称完成 |

上述表描述本次设计时的源码现状，不是性能测量。现有 FrameGraph 的 pass culling 也不自动保证 owner 在图外预创建的 pipeline、LUT 或 buffer 会被裁剪；feature-off 必须同时检查图内节点与图外生命周期。

## 3. 所有权与边界

| 层 | 拥有什么 | 不拥有 |
| --- | --- | --- |
| Renderer composition root | device/capability 协商、scene/view 发布、frame begin/commit/abort、Program 调用、统一编码与 submit、resize/recovery | 各 effect 内部算法、跨 feature 手写资源顺序 |
| Frame Program Builder/Compiler | 有限语义产品、consumer demand closure、启用的 owner/lane、结构 key、Program→Graph lowering 顺序 | 实际 GPU 工作数量、材质 shader 数学、WebGPU command submit |
| 各 producer/consumer owner | 输入/输出语义、Graph 注册、内部资源与 pass 生命周期 | 修改其他 owner 的字段定义或创建第二条生产 Renderer |
| FrameGraph | read/write/create/import 依赖、裁剪、顺序、瞬态复用、编译图、执行时绑定 | 判断某产品该由哪个算法产生或哪种画质策略应启用 |
| GPU Work | Visibility/Surface 等 bounded queue 的实际 records/count/indirect args、溢出与 GPU consumer | 让 CPU 用本帧 readback 重新编排可见/工作量 |

首次 Builder 使用**显式、有限的 owner 列表**，而不是通用插件注册表或字符串 service locator。当前 owner 之间的需求边可以在 TypeScript 中用稳定枚举与类型检查表达；后续模块按已有语义边界注册新 provider。Program 的编译结果是可检查的静态结构，不是每帧重新组装一组临时闭包。

## 4. 语义产品与需求闭包

### 4.1 最小词汇

当前生产链的根需求从 `Present/output-full color` 逆推：FSR3 输出要求内部 scene radiance、Visibility depth、Surface motion；环境和 Aerial 在其启用且资源可用时修改 scene radiance；Surface 要求 VisibilityKey、depth、GPU ShadingWork、材质/纹理 publication；Visibility 要求 GPU Scene/Geometry work 和 View。HZB 既服务 Visibility 历史/late recheck，也服务后续消费者，但不能为了未来用途产生无消费者 HZB。

| 语义产品 | 当前真实 producer → consumer | 语义要标明 | 本模块不声称 |
| --- | --- | --- | --- |
| Visibility Fact | VisibilityFeature → ShadingWork/Surface/FSR3 depth | view、internal-full、coverage、无效背景、depth 方向、frame identity | stable temporal identity 已完整输出 |
| Geometry Work | GPU Scene/Visibility prepare + GPU work pass → Visibility raster | record ABI、容量、counter、overflow、indirect 消费 | CPU 本帧可见列表 |
| Surface Radiance | SurfaceMaterial + 可选 frequency resolve → Sky/Aerial/FSR3 | scene-linear/pre-exposed、internal-full、coverage、invalid policy | v2 closure 与 demand-materialized fields |
| Surface Motion | SurfaceMaterial + 可选 resolve → FSR3 | 方向、单位、当前/前帧矩阵、有效域 | reactive/local change/稳定跨 LOD identity 已完成 |
| Environment Radiance | PhysicalSky/Aerial → FSR3 | 曝光域、场景线性、背景与几何覆盖 | VSM shadow 产品或局部 media |
| Reconstructed Color | FSR3 → Present | output-full、曝光约定、history 读写版本 | FSR3 等于整个 Temporal/Presentation 系统 |
| Swapchain Output | Present → 外部画布 | output format、alpha/composition | 将 swapchain 当成可缓存物理纹理 |

`Temporal Facts` 和 `Surface Field Demand` 在模块 A 有顶层**语义框架**：字段记录 producer、consumer、坐标空间、分辨率、数值/色彩单位、有效域、缺失行为、版本与 history 条件。第一版只纳入上表可实际流转的 motion/depth/radiance/visibility；reactive、stable identity、roughness 等保留名字和需求接口，只有后续真实消费者到来才物化/宣称生产。不要把 `PrimitiveToken` 的 frame-local work index 当跨帧身份。

### 4.2 Demand closure 的确定性规则

1. 从输出 intent（目前为 Present）与已启用的真实消费者开始，逆向收集必需语义产品；没有 producer 的必需产品是明确错误，可选产品走有说明的缺失行为。
2. 同一语义与 view/domain 下只允许一个权威 producer；允许多个 consumer。若有多个物理实现，先由 capability/profile 选择**有限且确定**的一项，不能从 GPU 本帧计数反向改图。
3. owner 声明输入、输出及 feature-off 行为；闭包排序只包含从输出可达的节点，检测循环、重复生产者、空间/曝光/分辨率不匹配和未消费输出。
4. demand 决定是否存在 lane、字段和 persistent history binding；**GPU Work** 决定 lane 中实际 work 数。Module A 先只表达当前 lane，不为 VSM/SSSR/GI 分配队列。
5. 编译后的计划可 dump 为 owner→product→consumer 图，便于代码审查。dump 是调试工具，不是 formal evidence 或逐批门禁。

Program 不复制 FrameGraph 的 per-resource DAG。它处理的是“为何需要该资源”的跨 owner 语义；FrameGraph 处理“这一个物理资源被哪个 pass 读写”的执行依赖。语义闭包必须先完成，才能让各 owner 注册 Pass 并由 FrameGraph 裁剪内部无消费者资源。

## 5. 两层身份：Topology 与每帧物理绑定

编译只应在可执行图结构、资源 descriptor 或 pipeline specialization 真正改变时触发。下表是 Module A 的**初始分类**；每个 owner 的注册函数必须复查有没有闭包捕获了右列资源。

| 结构 key，改变时允许重编译 | 每帧绑定/运行时量，不进入 key |
| --- | --- |
| negotiated capability/layout profile、选定 raster backend、启用的实际 feature/owner | camera/view 矩阵、jitter、scene/object 运动、frame index |
| internal/output 尺寸、sample count、output format、resolution topology | swapchain 当前 texture view、history read/write A/B 物理对象 |
| 可用 lane、Surface kernel/profile、真实 consumer field demand、Pass 资源形状 | HZB 当前/上一帧对象、environment LUT generation 与参数 revision |
| 影响 buffer/texture descriptor 的容量、VG bank 数或 texture binding layout shape | 相同 layout 下的 scene/material Product generation、active object 数、GPU queue counter |
| 当前 Surface v1 的 active execution-class 集合与 bank layout（仅当确实改变 Pass/pipeline/绑定数；Surface v2 将继续收敛） | 同一 class/layout 的材质 ID 与 texture 内容、FSR3 history 有效性 |

FSR3 是第一处关键迁移：当前 `addToGraph` 把 read/write 索引和具体 history texture 固定到图中；应把 previous/current 每类 history、constants 和 default mask 的 import 改为注册期只固定**角色与 descriptor**，执行期从本帧绑定解析物理对象。仍在 `prepareFrame` 做资源尺寸/格式准备，Graph 使用当前资源而不是首次构图时的纹理。history 交换、invalidate、resize 不改变节点与边；尺寸/格式变化或设备替换才换结构图。所有 FSR3 原有阶段和输入依赖必须保留，模块 A 仅改变宿主绑定。

Physical Environment 是第二处：`RendererCore` 当前直接导入 LUT views 并把 generation 写入 key。应将 Sun buffer、LUT view 的**语义角色**与每帧实际对象分开；生成或替换 LUT 后，同 layout 的图仍绑定新对象。正在被 GPU 使用的旧 LUT 继续按现有 fence/`gpuDone` 退役。若 LUT 形状/profile 真改变，则对应结构 key 改变。不能为了删 key 而让旧资源提前销毁。

相机运动导致当前 `adaptiveShading` 从 true 变 false，会切换图结构。Module A 采用**保守全速率 Surface profile**作为唯一当前时序安全路径，去掉 camera move 对 topology 的影响；不为保住旧粗频节省而添加假 motion。后续 Surface v2 在固定 topology 中用 GPU lane/有效性决定 dense、binned 和频率工作。该暂时的性能代价明确记录，最终性能评估不以 Module A 的中间态代表 Next 目标。

`FrameGraphKey.ts` 的陈旧 `sparseShadingRevision` 类型不能与 Renderer 内数组 key 继续并存。实现应建立单一、版本化且顺序稳定的结构 key，记录 key 字段对应的实际 descriptor/pass 差异；无差异字段删除。保持 `CompiledFrameGraphCache` LRU 与 device-loss 清空语义；动态资源不允许被编译图闭包长期抓住。

## 6. Program lowering 与帧事务

一次稳定 topology 的生命周期分为：`capability/scene publication → demand closure → Program compile → Graph registration/compile → per-frame binding → encode → one submit → history/environment commit`。Program 只在结构变化时重建；帧内只准备 scene/view/job、绑定最新资源、填入 GPU work 输入并执行已编译图。可用的 `FrameGraphBindingLayout` slot 必须延迟解析到执行时；如果 owner 内部还缓存首次传入的 GPUTexture/BindGroup，就必须先改 owner，不能仅给外层加 Proxy。

| 帧事件 | Program/Graph 行为 | 历史与资源行为 |
| --- | --- | --- |
| 正常帧、相机/对象运动 | 复用 topology，更新 View/scene/job bindings | FSR3/HZB 交换和有效性由各 owner 维护 |
| scene/material publication 改变但 layout/profile 相同 | 复用 topology，发布新 handle/generation | 旧资源等 GPU 完成再退役；不可绑定跨 generation 混合对象 |
| feature、尺寸、能力或 resource shape 改变 | 编译新 Program/Graph，LRU 淘汰旧图 | history 按 owner 条件失效或重建，不能假装上一帧兼容 |
| 空场景 | 相同 Program 入口选择 clear/present profile | 不生成伪 Visibility/Surface/FSR3 工作；仍由同一 FrameCoordinator 提交 |
| encode 失败/abort | 不 commit 当帧 history、environment 或 scene publication | 释放/失效未提交的暂存状态，原始错误不能被 abort 错误掩盖 |
| device loss/recovery | 旧 device 的 Program/Graph 与 GPU handles 全部失效；新设备重建 | 从 CPU authoritative Scene/Product truth 恢复，历史从无效状态开始 |

Graph `import_resource`、Pass `read/write/create` 必须完整表达真实依赖。外部副作用（Present、必要上传）标明 owner 与存活理由；不存在消费者的 Pass、readback、资源和独立 submit 不保留。环境 LUT 的生成命令可以在同一个 frame encoder 中发生，但不得在 Program 外另提一次 frame submit。

## 7. 性能与 WebGPU 边界

本模块重点消除 CPU 图重编译与错误资源捕获，不预设 GPU draw 数因“有了 Program”自动减少。性能判断先看结构：稳定 camera move 是否 cache hit、每帧新建 pipeline/bind group 的位置、无消费者 Pass 数、transient peak、外部资源滞留、JS 对象分配和 submit 次数。图 dump/计数用于实现调试；系统 GPU P50/P95 与多场景画质比较在整链验收。

WebGPU baseline 只依赖协商后的标准 render/compute/storage/indirect 能力。Subgroups、shader-f16、immediates、transient attachment 等可作为有限 specialization，只有有真实消费者和测得收益才进入 profile；mesh/task shader、BDA、通用 bindless、64 位原子和动态任意多 draw 不成为本层前提。Program 不能模拟 Vulkan barrier、多队列或通过 GPU→CPU→GPU 同帧闭环改变调度。

Granite 的 `RenderGraph::bake/build_aliases` 与 Filament 的 `FrameGraph::compile/execute` 说明图层可负责依赖和物理生命周期；它们没有提供本工程的语义需求编译器。EEngine 保留现有 FrameGraph，并将 Frame Program 限为薄而可审计的一层，避免引入第二套资源调度器。源文件、revision、许可及差异见 R21。

## 8. 设计取舍、风险与模块完成点

| 方案 | 决定与理由 |
| --- | --- |
| 继续在 RendererCore 中手写全局 Pass 顺序 | 拒绝：每加入 provider 都扩大 composition root，无法表达 field demand 与 owner 合同 |
| 复制 RendererNext 做 A/B | 拒绝：双 production path 违反重建红线，迁移成本和维护分叉会掩盖真实问题 |
| 用通用插件/脚本式 Planner 一次包揽所有算法 | 拒绝：Module A 只有有限现有 owner；普适注册系统会增加 CPU 间接层且无法证明真实消费者 |
| 重写 FrameGraph 为 Granite/Filament 图 | 拒绝：本地依赖/裁剪/late binding 已存在；外部 Vulkan/native 执行与 WebGPU 不同 |
| 保持 FSR3 index 与 LUT generation 在 key | 暂时正确但最终拒绝：避免错误捕获，却使稳定帧图反复编译；必须先完成 late binding 再删 key |
| 为保留旧 adaptive 性能使相机移动换图 | Module A 拒绝：时序安全与结构身份混淆；先保守 full-rate，再由 Surface v2 在 GPU lane 内恢复性能 |

主要风险是：Pass 注册时捕获旧 GPU 对象、history A/B 读写别名、环境 LUT 提前回收、current Surface active-class layout 与 key 不一致、Graph culling 被副作用标记绕过、空场景/错误路径提交次数改变。执行文档针对每项给出源码切入点与小范围检查，不用逐批浏览器矩阵或伪 GPU workload 来“证明”模块完成。

模块 A 完成须满足：唯一 Renderer 调用 Frame Program 的结构计划来 lower 当前真实链；Graph 中 Visibility→Surface→FSR3→Present 与可选环境边实际存在；Program key 不再含 history ping-pong、LUT generation 或相机运动；同尺寸/同 profile 跨帧绑定的是当帧真实资源；empty/feature-off 无无效工作；正常/abort/recovery 保持一个 submit owner。完成后集中 typecheck、build、必要 targeted tests，并更新 currentSlice，进入 Surface v2。正式浏览器、画质与性能证据留在最终集成。

## 9. A0 生产资源边清单（2026-09-27 源码核对）

下表的 `ResourceId` 是 lowering 中的逻辑句柄或 Graph 导入名；数值 ID 随编译图分配，不能作为跨帧身份。尺寸均为当前内部分辨率 `I` 或输出分辨率 `O`。结构 key 记录形状和启用的 owner；右列所列当前对象均从本帧 binding 解析。依据为 `RendererCore.render/renderEmptyScene`、`FrameProgramLowering`、`PackedVisibilityPass`、`ShadingWorkPass`、`SurfaceMaterialPass`、`Fsr3UpscalerRuntime` 和 `AtmosphereLutResources` 的当前生产调用。

| 产品/逻辑 ResourceId | 生产者 → 消费者 | 物理 owner；尺寸/格式 | key、绑定与失效/退役 |
| --- | --- | --- | --- |
| `meshlet-work`、`visibility-counters`、`camera` | Visibility prepare 的 GPU 工作队列 → Visibility raster；camera/counters 也供 late recheck | `PackedVisibilityPass` 的 prepared work set、`GpuRenderWorldRuntime.counterSink`、`GPUViewContext` buffers；有界结构 buffer | Graph 形状只取 VG 与 late recheck 的实际启用；work 数量、队列容量与 scene 对象由当前 job 绑定；旧 prepared set 经 frame command 的 GPU 完成回调退役 |
| `depth`、`Packed VisibilityKey` | Visibility raster → HZB、ShadingWork、Surface、Sky/Aerial、FSR3 | `RenderTargets.depth`：`I/depth32float`；Visibility transient：`I/r32uint`、背景 sentinel | `I` 与深度格式是结构；depth view 随帧/resize 换；VisibilityKey 每图执行 transient；camera cut 不改变图 |
| `previous-hzb`、`current-hzb` | 上一已提交帧 HZB → Visibility；本帧 depth → HZB → light cluster/可选 late recheck | 每 View `HierarchicalZBuffer` 双纹理：`max(1,I/2)/rg16float` mip 链 | HZB 使用与 late recheck 启用状态进 key，read/write 物理索引不进 key；camera cut、resize、帧中断与 feature revision 使 history 无效；graph binding 每帧取 owner 当前/上一对象 |
| `ShadingWork queue/classes/indirect` | VisibilityKey、MeshletWork、材质记录 → ShadingWork 分类/压紧 → Surface 每类 indirect dispatch、Present 统计 | `ShadingWorkPass` 的当前图 transient buffers，容量由 `I` 与设备 limit 算出 | `I` 与 active execution-class 集合影响结构；GPU counter 不进入 key 或 CPU 同帧决策；full-rate 是模块 A 暂时固定 profile |
| `Surface/radiance`、`Surface/motion` | Surface clear 和每类 shader → Sky/Aerial 或 FSR3；motion → FSR3 Prepare Inputs | `SurfaceMaterialPass` 当前图 transient：`I/rgba16float` 工作线性 pre-exposed，`I/rg16float` 当前减上一帧 UV，背景 motion 清零 | `I`、class 集合、实际纹理 bank mask 进 key；材质/实例内容经当前 publication 绑定；无活跃 class 时 clear 仍提供合法色和零 motion |
| `material-records`、`scene-instances`、`geometry-*`、`texture-routes`、`texture-set-*-bank-*`、`virtual-geometry-*` | 已发布 Scene/Product/Asset → Visibility、ShadingWork 与 Surface | `GpuRenderWorldRuntime`、`GpuAssetBindings`、当前 job；buffers 与 texture bank views | VG bank 数、被纹理 class 实际采样的 bank mask 进 key；同 layout 的 scene/material/texture generation 只换绑定；publication 由 render world 事务管理，不能混合两个 generation |
| `physical-environment-sun`、`physical-environment-*-transmittance/scattering/higher-order/irradiance` | 帧内 environment record/参数上传 → Surface direct、PhysicalSky、Aerial | `PhysicalEnvironmentRuntime.parameters`：64 B；`AtmosphereLutResources`：transmittance 256×64、scattering/higher-order 256×128×32、irradiance 64×16，均 `rgba16float`；multipleScattering 64×64 只供 LUT 内部构建 | 环境 owner 开关进 key；固定 Earth LUT profile 的 generation、Sun revision 不进 key；Graph import 每帧取 pending/active view；旧 LUT 在提交完成 promise 后退役，abort 丢弃 pending |
| `light-records`、cluster lookup/data/params | lit class 的 direct-light upload → HZB light cluster → Surface | `GPUViewContext.environment.lights` 与 `LightClusterPass`；GPU buffers，cluster 容量随 `I` | lit class 是否存在决定 light cluster 结构；灯内容每帧上传；unlit profile 不产生 cluster/readback |
| FSR3 `previous/current color` | 上帧历史 → Accumulate；本帧 Accumulate → 后续帧历史 | `Fsr3UpscalerRuntime` 双纹理：`O/rgba16float` | output 尺寸进 key；A/B index、generation、reset 不进 key；提交后交换，abort 不交换，重分配旧纹理等上次提交完成 |
| FSR3 `previous/current luma`、`previous/current luma history` | Prepare Inputs/金字塔 → Shading Change、Instability → 后续帧 | FSR3 双纹理：分别 `I/r16float`、`I/rgba16float` | `I` 进 key；每帧 read/write 角色绑定；resize/reset 重建并等待 GPU 完成退役 |
| FSR3 `previous/current accumulation`、`previous/current frame info` | Reactivity 与 Luma Pyramid 读写 → Accumulate/下一帧 | FSR3 双纹理：`I/r8unorm`、`1×1/rgba32float` | `I` 进 key；两个角色不能别名；frame info 初始化由 owner 完成，abort 不推进 index |
| FSR3 `constants`、`RCAS constants`、`default mask` | 当前 View/jitter/radiometry 与 owner 默认值 → FSR3 所有相关阶段 | FSR3 owner buffers 与 `1×1/r8unorm` 零 mask | 常量内容每帧写当前 frame command；mask/常量的物理角色由 graph slot 解析；不可因 cache hit 跳过 Prepare Inputs、金字塔、Reactivity、Instability、Accumulate 或 RCAS |
| FSR3 RCAS 输出、`swapchain` | Accumulate/RCAS → Present → canvas | 当前图 `O/rgba16float` transient；canvas `O/outputFormat` 当前 view | `O`、output format 进 key；当前 swapchain view 不进 key；empty profile 只写 clear/present，不创建上述 scene/FSR3 资源 |

Graph 外仍有同一 frame encoder 上的 `encodeFrameMaintenance`、pending Scene/Product patch、direct-light record upload、View/camera update、FSR3 constants upload 与 Environment LUT record。它们的成本没有被 Graph dump 计入；这些路径不得另做 frame submit。诊断 readback 是显式异步行为，不控制本帧可见工作。R21 的 Granite/Filament 对照仍只是架构参考，不是 donor port。

### 结构 key 字段与对应 Graph 差异

| 字段 | 改变的实际结构 |
| --- | --- |
| device epoch/capability profile | 所有 device-local pipeline、limit 及 cache 所属世代 |
| `kind`、intent、view family | scene 全链或 empty clear/present；目前 intent/view 仅支持 present/main |
| `I`、`O`、output format | texture descriptor、FSR3 domain、dispatch/Present 目标 |
| virtual geometry 与 bank 数 | VG imports、Surface binding 数及 visibility Product 路径 |
| HZB 和 late recheck 开关 | HZB build/import、late GPU filter/raster 节点 |
| active class 集合及被采样的 texture bank mask | 每类 Surface pass/pipeline、对应 bank imports/binding layout；未采样的 bank mask 被规范化为零 |
| physical environment 开关 | Sun/LUT imports、PhysicalSky/Aerial 与 Surface 环境绑定 |

MeshletWork 本帧容量、compaction/primitive-index 实际选项当前由 Visibility job 的 prepared GPU owner 决定，不改变 `FrameProgramLowering` 的 pass/资源描述，因此不进这版 Graph key；若以后某选项真改变注册形状，必须先补结构字段或固定注册形状再启用。camera/view/jitter、scene/material generation、HZB A/B、FSR3 A/B、LUT generation、swapchain view 均不进 key。`FrameGraphKey.ts` 的旧并行 key 已移除。
