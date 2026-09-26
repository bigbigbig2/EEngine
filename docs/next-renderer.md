# EEngine Next：单路径破坏式重建执行路线

本页是 [ADR-0020](./adr/0020-clean-cut-renderer.md) 的实施边界；[workstream](../project/workstreams/active/eengine-next-clean-rebuild.yaml) 只记录当前切片，[来源账本](./porting/next-renderer.md) 记录算法版本与移植映射。用户的[终版设计讨论](./reviews/EEngine_Next_Renderer_Final_Architecture.md)是设计输入，不是当前代码事实。重构期间允许功能暂退，旧实现留在 Git；不建第二条 Renderer，也不以旧功能全量通过作为每一步门禁。

## 权威与完成口径

ADR-0020 决定架构，本页决定阶段范围与顺序，active workstream 记录当前切片和未完成项；workstream 不得自行扩大阶段退出条件。ADR-0019 是历史决定，学习指南和设计讨论只解释目标。实现事实见 `docs/domains/` 和源码；声明等级由当前 revision 的 evidence 推导，过期生成状态页不代表当前进度。

结构完成、选定功能实现、正式质量/性能验证分别记录。旧 owner 删除不依赖双机性能结论；结构结束也不自动获得 RuntimeValidated 或 Performance。一个批次完成连贯的 owner 切换、合同、路由与相关检查，不以重复增加局部诊断替代阶段收口。

## 六个一级模块与决策时间

| 模块 | 拥有的结果 | 边界 |
| --- | --- | --- |
| Renderer Core | 帧入口、Render Demand、有限 Product Plan、FrameGraph lowering、GPU Work 协议、预算、submit/recovery | Renderer 是 composition root；CPU 不扫描全场景生成最终可见列表 |
| Scene & Virtual Resources | GPU Scene、VG/纹理/阴影/radiance 的控制面和专用驻留 | 共用身份、需求、优先级、预算、版本、退役；不共用物理缓存 |
| Visibility & Surface | GPU 可见性、VisibilityKey/Depth、Surface 重建、材质程序、求值频率和 compute shading | Visibility 产 hit；Surface 提供明确几何/材质语义；下游不私自再解析一套材质 |
| Light Transport | Direct Light Visibility、Indirect Radiance、Reflection | VSM/XeGTAO/SSSR/Screen GI/World GI 是 Provider；能量和 fallback 各有语义 |
| Environment & Media | Sun/Sky/Atmosphere、aerial perspective、局部参与介质 | 给光照、GI、反射与体积提供统一物理环境 |
| Temporal & Presentation | motion/depth/exposure/jitter/history 生命周期、最终重建与输出 | 信号自己的方差/拒绝/滤波仍由信号 owner 负责 |

规划链是 `Consumer Demand → Semantic Product → Provider Selection → Representation Plan → Execution Domain → FrameGraph Lowering`。资产/材质编译期确定材质能力、kernel family、合法的纹理采样等价关系与保守频带；场景发布/配置变化时选 Provider、Product topology、有限物理方案、pipeline/layout 和 history topology；本帧 GPU 决定 occupancy、ray/page/probe/shade 数量、频率与历史有效性。CPU 编译可能性，GPU 决定这一帧的工作量。Product Planner 不做每帧万能 CPU 优化器。dense/direct、融合、重算、compact 物化和 history reuse 都是合法的有限方案，按带宽、重复解析、dispatch、绑定和重建成本取舍。FrameGraph 执行合法计划、管理依赖/瞬态生命周期和裁剪，不替 Renderer Core 决定产品策略。

每个新逻辑 Product 写清语义（几何法线与着色法线不同）、空间/分辨率/过滤、精度、单位/色彩空间、pre-exposure、覆盖/缺失行为及时间身份。新 typed GPU 队列须写元素 ABI、容量、计数器、溢出行为、生产者、GPU 消费者和间接执行；CPU readback 仅用于异步反馈或诊断。历史不能以帧内 VisibilityKey 当长期身份。跨 owner 目标先见[候选 v2 合同](./contracts/render-product-work-history-v2.md)；稳定的精确布局与状态机再写入 `docs/specs/`，不先冻结猜测。

**复杂算法/效果迁移强制顺序**：实施 Surface 重建/材质、频率重建、VSM、XeGTAO、SSSR、GI、环境散射、Froxel Media、FSR3 等完整算法或效果前，先查 GitHub 完整开源实现，再查论文与足以复现决策条件、阶段和数据流的详细技术文章；不限源语言。固定上游 revision、许可证和具体源文件/入口，写入[来源账本](./porting/next-renderer.md)，建立源函数/阶段 → 本地产物/阶段的逐项对照，保留关键分支、输入输出、不变量和降级条件。WebGPU API 改写可以调整绑定和调度，不能把完整算法简化成同名近似效果；缺少完整 donor 时先记录检索范围与缺口，并明确具名本地方案，不得宣称已完成上游移植。来源核对、WGSL/CPU oracle 和新主链 GPU 消费证据齐备后，才更新采用状态。简单确定性工具、ABI 编解码及绑定/生命周期胶水不强制外部调研，但应标注本地集成；不得把复杂算法拆小后按“简单”豁免。

## Keep / Extract / Rewrite / Delete

| 现有资产或 owner | 决定 | 新去向和条件 |
| --- | --- | --- |
| `GpuRenderWorld`、Geometry Product、VG 页/驻留/Streaming、`HierarchicalWorkGenerator`、MeshletWorkCandidate、`MeshletBucketRaster`、`PackedVisibilityPass`、VisibilityKey ABI、HZB/Current-HZB Late Recheck、FrameGraph/CompiledFrameGraph | Keep / move | 新主链基础；修剪旧 pipeline 依赖，保留 GPU 闭环、Nyx 来源约束和图的生命周期/依赖/裁剪能力 |
| visibility decode、透视重建/插值、解析 `ddx/ddy`、UV transform、显式 `textureSampleGrad`、material texture bank、PBR；有界队列 preflight、程序缓存/绑定隔离、历史 begin/commit/abort 等机制 | Extract | 提取数学、不变量与可复用实现到新 owner；旧 Feature/Pass 不作 adapter，不从零重写已有梯度数学 |
| `Renderer`、`FrameProducts`、`OpaqueShadingDemand`/`compileOpaqueSurfaceProductPlan`、`TemporalHistoryRegistry`、Surface/材质/照明 owner | Rewrite | Renderer 脱离继承；删除旧 effect-bound 产品方案实现，只保留有限计划思想；Product schema 和时间身份按新语义重建，不强制保行为 |
| `MainRenderPipeline`、`MainFrameFeatureTopology`、`OptionalFrameFeatures`、现 `FramePlan`、`MainRenderPipelineGraphKey`、仅服务旧 recipe 的 registry/manager | Delete | Phase 1 从生产路径切掉；无其他合法消费者后删文件，不设平行新旧链 |
| 旧 AO/SSGI/SSR/GI/CSM/TAA/NSS/Bloom Feature/Service 与其旧 Pass | Delete | Phase 1 同旧 recipe 一起切断，不等待新效果移植；Next 阴影没有 CSM fallback，未完成 VSM 时可暂时无影 |
| `SurfaceFeature`、`SparseShadingResolvePass` 和旧 sparse candidate owner | Extract, then delete | Phase 2 搬走 Surface 数学、材质/梯度/PBR 与必要 ABI 后删除旧 owner；不保留新旧双着色链 |

| 旧文件/职责 | 新 owner | 切断阶段 |
| --- | --- | --- |
| `Renderer.ts`、`MainRenderPipeline.ts`、`FramePlan.ts`、`OpaqueShadingDemand.ts`、`FrameProducts.ts` | 薄 Renderer shell；Renderer Core 的需求、有限计划和**重定义**的 Product schema | Phase 1 建骨架；Phase 2 完善 Surface schema |
| `BoundedGpuWorkProtocol`、MeshletWork/ShadingBin 控制信息 | Renderer Core 的 typed Work 协议，队列物理 ABI 仍归各 producer/consumer | Phase 1 Meshlet，Phase 2 Shading，Phase 4 Ray/Page 检验跨域复用 |
| `SurfaceFeature.ts`、`SparseShadingResolvePass.ts`、material/shader 数学 | Visibility & Surface 的重建、材质求值、频率和光照输入 | Phase 2 提取后删旧 owner |
| 旧 AO/SSR/SSGI/GI/CSM owner/pass | Phase 1 删除；Phase 4 从上游重新建立 Light Transport Provider | 不做过渡 adapter |
| 旧 sky/fog owner | Environment & Media | Phase 3 环境、Phase 5 局部介质 |
| 旧 TAA/NSS、`TemporalHistoryRegistry` | Temporal & Presentation；只提取 lifecycle，重建 public contract | Phase 1 断旧效果；Phase 3 新时间基础 |

这是**删除和重建指令**，不要求维持类名或旧 API。新代码直接落在现有 `render/` 主树，可按 `runtime/scene/visibility/surface/lighting/environment/temporal/` 等粗 owner 划分；不建 `render-next/` 并行树，也不把目录名称当作架构验收条件。

Phase 1 的旧效果删除清单明确包含 `AOService`、`ScreenSpaceDiffuseService`、`ReflectionService`、`GIService`、`ShadowFeatureManager`、`TemporalFeature`，以及旧 `GtaoPass`、`SsgiPass`、`ScreenSpaceReflectionsPass`、`SpecularCorrectionPass`、`PackedCsmShadowPass`、`TemporalAntiAliasingPass`、`TemporalClassificationPass`、`NeuralSuperSamplingPass`、`LongRangeDiffuseProviderPass`、`OpaqueLightingResolvePass` 和 `ScreenSpaceDiffuseResolvePass`。它们若仍被别处引用，先切断引用并删无消费者图节点；不把旧 Pass 改名为新 Provider。Phase 2 再提取并删除旧 Surface/Sparse owner。

## 文档和声明切断清单

| 旧权威 | 处理 | 代码切换时必须同步处理 |
| --- | --- | --- |
| ADR-0003、0013、0015、0019 | 标记 superseded；新目标以 ADR-0020 为准 | 一条主管线、GPU 闭环和需求裁剪等相容原则仍有效；旧 owner/exactly-once/CSM fallback 不再指挥新实现 |
| `render-product-work-history-v1` | 停止作为 Next 冻结目标，保留历史现状说明 | 新 Product、Work 和 History 语义进入新的 contract/spec；旧消费者删除时移除旧引用 |
| `shading.one-eval` 等旧路径 claim 和既有 evidence | `shading.one-eval` 与 `shading.pipeline-pruning` 已 retired，历史 evidence 不转授给新 Renderer | Phase 2 建立新 Surface 声明、检查与 case 期待；新 claim 从新 revision 的证据开始 |
| 旧 M1 workstream | 从 active 移除；历史留在 Git，新建 `eengine-next-clean-rebuild` | 不再要求 split main pipeline 且 preserve behavior |

## 切断顺序

| 阶段 | 直接切断/新建 | 该阶段允许暂缺的能力 |
| --- | --- | --- |
| 0 | 冻结旧代码基线和固定来源；废止旧决策/合同/workstream | 不产生新 runtime 完成声明 |
| 1 | 删旧 Composition 与效果栈；启动唯一 GPU Scene → Visibility → Debug/Base Color → Present | Surface/PBR、AO、Shadow、GI、Reflection、Temporal、Bloom |
| 2 | 提取 Surface 数学，删旧 Surface/Sparse owner；接 Material、频率和基本 direct light | 无有效 history 时不做 temporal reuse；后半段效果仍缺 |
| 3 | Takram 环境、Temporal Fabric、FSR3 Upscaler | VSM 未接入时太阳可暂时无影 |
| 4 | 独立 VSM、XeGTAO、SSSR、Screen/Atlas DDGI/Sky Provider | 完整 VT 与局部介质仍后置 |
| 5 | 收敛虚拟资源控制面，接 Adria Froxel Media | 体积云后置 |

### Phase 0 — 冻结与废止旧目标

固定当前 Git 基线和来源 revision；接受 ADR-0020 并废止冲突决策/旧 A 批次合同；旧 workstream 从 active 移除，新 clean-rebuild workstream 接手。Git 提供回退，不维护运行时 fallback。本页完成即结束 Phase 0 的文档部分；**生产代码切断前仍须给旧 Renderer 基线打 tag**，并在切断批次同步调整失效 claim。

### Phase 1 — 直接切断旧 Composition

1. 解除 `Renderer extends MainRenderPipeline`，建立唯一新帧入口、场景发布、FrameGraph lowering、提交与恢复；Phase 1 骨架先到 `Scene → GPU Scene → GPU Visibility → Debug/Base Color → Present`，Phase 2 再接新 Surface 与基本光照。
2. 接入 GPU Work typed 协议及能力/预算协商，保留现有 GPU Scene/VG/visibility 真正消费者。删除旧 recipe、topology、`OptionalFrameFeatures`、`MainFrameFeatureTopology`、现 `FramePlan` 与无消费者资源/submit；`RenderFeatureRegistry` 若无其他消费者也删。旧 AO、CSM、SSR、SSGI、TAA 等效果及 Pass 同批切断，不等新 Provider 替换。
3. 检查空/单场景、resize/device loss、队列容量/溢出与基本输出。旧端到端画质测试可暂不通过，并明确记录已撤销的目标。

### Phase 2 — Surface / Material / Shading

1. 提取旧 visibility 解码、透视属性、解析梯度、UV/贴图和 Filament-derived PBR；用固定 The Forge 来源对照数学，建立新 Product schema 与材质程序/绑定闭包。
2. 频率分类同时看三层：**Coverage/Identity**（深度、轮廓、运动、揭露和连续性），**Material Appearance**（贴图/法线/颜色频带、有效粗糙度范围、emissive/alpha/特殊材质），**Lighting**（阴影边界、镜面瓣、局部光变化、反射/GI 方差）。先用保守元数据和廉价几何/时间信息选候选，再执行 full、2×2 或 4×4 的真实消费与空间重建；不能完整采样后才决定降频，也不能只凭 roughness factor 降频。Phase 2 无合法 history 时一律不启用 temporal reuse，Phase 3 建成身份/拒绝合同后再开放。高频材质、法线、镜面、边缘和 disocclusion 保留所需频率；每个可见样本有合法结果。
3. 程序身份只由 shader/layout/capability/kernel specialization 等稳定闭包决定；scene/publication revision、纹理/实例 generation 只进入 revision-local bindings。基本 direct lighting 接通后完成剩余依赖提取并删除旧 Surface/Sparse owner；建立新 Surface 声明和检查，旧 `shading.one-eval` 保持 retired。按真实消费者迁移必要 ABI/资源，不按 Sparse 名称批量删除。

**本阶段收口顺序与退出条件：**

- 先完成数学/ABI/生命周期提取与旧 owner 删除，同批删除仅服务旧链的测试和检查、登记实际 retiredPaths、收窄 shading 宽泛路由；仍有合法消费者的代码必须明确新 owner。
- 新 Surface 的程序/绑定闭包、GPU producer/consumer、容量/溢出和每个可见样本的有效结果具有精确合同及受影响验证。逻辑值声明不等于对应产品已生产；法线、运动等逐项区分 schema 与实际消费者。
- 本阶段采用有限频率 profile：静态 opaque unlit factor 与已认证 1×1 unlit base texture 可作 coarse 候选；未证明安全的纹理、受光、法线及其他材质由同一新链 full-rate 求值。保留覆盖/身份边界与运动检查，禁止 history reuse。本地 profile 不冒称完整 CPS/VRS 移植或通用自适应着色。
- 补齐当前 Surface 有限计划的需求、资源角色、配置/发布失效与 lowering 边界；不要求此阶段实现尚无消费者的通用规划器。完整跨消费者表示选择随 Phase 3/4 落地。
- 大模块完成时集中运行 typecheck、build 和必要的 targeted tests，修复已知正确性问题；`verify --full` 留到整个 Next Renderer 最终集成。正式浏览器验收与双机净收益不作为继续编码的前置条件。

广泛 lit/normal 降频和跨光照不连续的频带研究移到 Phase 4 的真实 Light Transport 消费者集成；Temporal reuse 移到 Phase 3 身份/拒绝合同之后。分类、队列、着色、重建及整帧净收益在固定条件下与同链 full-rate 比较，决定默认策略；未证明收益不得宣称性能提升，也不强制所有便宜工作先 compact。这是阶段范围的明确调整，不表示这些目标已完成。

### Phase 3 — Physical Environment + Temporal

1. 以 Takram 固定来源迁移非地理物理环境；保留 Bruneton/Hillaire LUT、太阳透射、直射/间接散射及 shadow-aware aerial transport 的选定 profile，建立 Sun direct、Sky indirect、atmosphere/aerial 共用的单位、坐标和环境版本接口。Phase 3 先保留合法无影输入和阴影接口，Phase 4 再接 VSM；去 Three/TSL 宿主不等于删行星/观察高度模型。
2. 建公共时间身份、motion、depth、jitter、exposure、history 生命周期；将 FidelityFX SDK v1.1.4 的 **FSR3 Upscaler** 作为首选最终重建完整 profile 移植，不包含 frame generation。解析型重建可作具名最小后端；FSR2 是需重新决策的独立替代来源，**不作为同时保留的运行时 fallback**，也不与 FSR3 内部阶段拼接。
3. 静态/运动/遮挡揭露/分辨率和曝光变化逐项检查；信号去噪不与最终超分内部历史混为一体。以真实环境和重建消费者落实 Product 的空间、单位、曝光、表示选择与 history 失效，不能只增加产品枚举。
4. 进入 Phase 4 前明确虚拟资源最小控制合同：逻辑身份、generation、预算归属、缺页/溢出及 submission 安全退役；不提前构造万能缓存。VSM/GI 接入时沿用该边界，Phase 5 再收敛跨域调度。

### Phase 4 — Light Transport

1. **VSM**：按 Timberdoodle 的页需求、分配、失效、回收、层次与采样完整映射；WebGPU 以独立光空间 caster 工作、storage indirection 和有界 indirect raster 取代 mesh shader/BDA；不留 CSM fallback。页吞吐与缺页必须可解释。
2. **AO + Reflection**：XeGTAO 的 prefilter/evaluate/denoise；FidelityFX SSSR 的 classification、ray/denoiser work queues 与 indirect args/trace、hit validation、reprojection/prefilter/temporal resolve；共用语义深度需求，仅在表示兼容时共享物理 HZB。反射 miss 进入一致的环境/Probe fallback。
3. **Hybrid GI**：近场 Screen GI、Atlas DDGI + software BVH 世界样本生产/Probe 更新、无限 Sky。明确 `World Sample Producer → radiance/distance samples → probe/brick update → World Radiance Field → shading consumer`；software BVH 是第一候选，raster capture、screen injection 或未来 ray backend 只能作为具名且可核验的来源。动态几何与动态光源驱动加速结构、受影响区域、历史和置信度。Probe 存储不等于样本生产；静态烘焙或纯 SSGI 不算目标完成。Screen GI 已找到 [UnitySSGIURP 完整信号链与 Wicked Engine compute 链候选](./porting/next-renderer.md)，但**尚未选定可直接移植的 WebGPU profile**；实施前须固定近/世界/天空的能量及缺失行为，不能将旧 SSGI 包装后冒称完成。

4. 随真实阴影/反射/GI 消费者推进受光材质频率策略，按完整来源映射保留必要阶段；未证明安全者保持 full-rate。检验 Meshlet/Shading/Ray/Page 专用 ABI 下的共享预算、计数、溢出和生命周期，不能以 CPU preflight helper 代替 GPU Work Runtime 完成证据。固定场景测量完整成本后决定频率默认策略，双机结论仅在两台实际验证后声明。

### Phase 5 — Virtual Resource Control Plane + Media

在已工作的 VG、纹理驻留、VSM、radiance field 上收敛统一预算/优先级/版本/退役/遥测，保留各自页格式、采样和物理缓存。Texture Residency 不改名冒充完整 VT；[Wicked Engine 地形 VT 与 LibVT 通用 VT](./porting/next-renderer.md) 是已核实的互补候选，并非单一合格 WebGPU 整套 donor。完整 VT 的反馈、页表、上传与采样须在实施前选定 profile、核实本地闭环及收益。以 Adria 为候选迁移 Froxel 注入、历史、积分与合成，给 Fog、Local Volume、Light Scattering 和 Particles 统一介质表示；体积云后置。

## 迁移、验证和待证明风险

完整算法 profile 的源函数/entry、分支、依赖、历史、fallback、差异和本地对照记录在[来源账本](./porting/next-renderer.md)。GPUPrefixSums、The Forge、Filament、XeGTAO、FidelityFX SSSR/FSR3、Timberdoodle VSM、Atlas DDGI、Takram、Adria 均为固定候选；候选存在不等于 port 完成。不得删必要阶段还沿用原名。

高速重构期间按 currentSlice 连续实现；typecheck、build 和 targeted test 可用于调试，不作为每批门禁。FSR3、VSM 等大模块完成时集中运行一次 typecheck、build 和必要的 targeted tests，更新 workstream 后继续下一模块。主要架构与 planned providers 全部完成后，集中做 browser matrix、生命周期、不同场景与材质、feature 交互、质量和 P50/P95 性能比较，再处理正式 evidence 与 claims。正式 Runtime Validated、Performance、Pipeline 完成声明只由当前 revision 的正式 evidence 推出。

GTX 1650 Ti 4 GiB/16 GiB RAM 是较低配置设计基线，RTX 2060 的实际 adapter/limits 待该机读取；1080p/60 FPS、动态内部分辨率和可配置预算是目标，尚非实测保证。记录 shading/ray/page/probe 工作量、分类/重建成本、物化带宽和质量；不为少几个全屏 Pass 强制所有任务进队列。WebGPU feature/limit 先协商；`shader-f16`、subgroups、`primitive-index` 等按实际 adapter/WGSL 能力选择 specialization，不能仅凭 GPU 型号假定存在。mesh shader、DX12 Work Graph、硬件 RT、自由 bindless、BDA、64 位原子、multi-draw-count 不作主链前提；详见 [WebGPU 能力合同](./WEBGPU.md)。

对应阶段必须证明：VSM 页 raster 的 WebGPU 命令上界；Atlas software BVH 的动态更新与样本预算；Screen GI 候选完整阶段、WebGPU 改写与能量边界；adaptive compute shading 的净收益；通用 VT 来源组合后的本地完整闭环；FSR3 profile 的 WGSL/capability 转换。FidelityFX VRS 只供频率分类参考，WebGPU 没有默认硬件 shading-rate attachment；分类之后的 compute work 与重建属本地集成。它们不能以复活旧链作为默认解决方案。

原讨论没有给透明/折射的最终表示、alpha 特殊材质的全链覆盖，也没有决定局部光源阴影是否虚拟化。它们不阻塞 Phase 1 的 opaque 骨架；宣称完整 Renderer 前必须在同一 Product/FrameGraph 主链内确定合法 Provider、时域和合成边界，不能为此恢复第二条 Renderer。体积云仍后置。
