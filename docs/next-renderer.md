# EEngine Next：单路径破坏式重建执行路线

本页是 [ADR-0020](./adr/0020-clean-cut-renderer.md) 的实施边界；[workstream](../project/workstreams/active/eengine-next.yaml) 只记录当前切片，[来源账本](./porting/next-renderer.md) 记录算法版本与移植映射。用户的[终版设计讨论](./reviews/EEngine_Next_Renderer_Final_Architecture.md)是设计输入，不是当前代码事实。重构期间允许功能暂退，旧实现留在 Git；不建第二条 Renderer，也不以旧功能全量通过作为每一步门禁。

## 六个一级模块与决策时间

| 模块 | 拥有的结果 | 边界 |
| --- | --- | --- |
| Renderer Core | 帧入口、Render Demand、有限 Product Plan、FrameGraph lowering、GPU Work 协议、预算、submit/recovery | Renderer 是 composition root；CPU 不扫描全场景生成最终可见列表 |
| Scene & Virtual Resources | GPU Scene、VG/纹理/阴影/radiance 的控制面和专用驻留 | 共用身份、需求、优先级、预算、版本、退役；不共用物理缓存 |
| Visibility & Surface | GPU 可见性、VisibilityKey/Depth、Surface 重建、材质程序、求值频率和 compute shading | Visibility 产 hit；Surface 提供明确几何/材质语义；下游不私自再解析一套材质 |
| Light Transport | Direct Light Visibility、Indirect Radiance、Reflection | VSM/XeGTAO/SSSR/Screen GI/World GI 是 Provider；能量和 fallback 各有语义 |
| Environment & Media | Sun/Sky/Atmosphere、aerial perspective、局部参与介质 | 给光照、GI、反射与体积提供统一物理环境 |
| Temporal & Presentation | motion/depth/exposure/jitter/history 生命周期、最终重建与输出 | 信号自己的方差/拒绝/滤波仍由信号 owner 负责 |

资产/材质编译期确定材质能力、kernel family 与保守频带；场景发布/配置变化时选 Provider、Product topology、有限物理方案和 pipeline；本帧 GPU 决定 occupancy、ray/page/probe/shade 数量和有效历史。Product Planner 不做每帧万能 CPU 优化器。dense/direct、融合、重算、compact 物化和 history reuse 都是合法的有限方案，按带宽、重复解析、dispatch、绑定和重建成本取舍。

每个新逻辑 Product 写清语义（几何法线与着色法线不同）、空间/分辨率/过滤、精度、单位/色彩空间、pre-exposure、覆盖/缺失行为及时间身份。新 typed GPU 队列须写元素 ABI、容量、计数器、溢出行为、生产者、GPU 消费者和间接执行；CPU readback 仅用于异步反馈或诊断。历史不能以帧内 VisibilityKey 当长期身份。跨 owner 目标先见[候选 v2 合同](./contracts/render-product-work-history-v2.md)；稳定的精确布局与状态机再写入 `docs/specs/`，不先冻结猜测。

## Keep / Extract / Rewrite / Delete

| 现有资产或 owner | 决定 | 新去向和条件 |
| --- | --- | --- |
| `GpuRenderWorld`、GPU Scene publication、VG 页与层次、GPU meshlet work、hardware indirect visibility、VisibilityKey、FrameGraph | Keep / move | 新主链基础；修剪旧 pipeline 依赖，保留 GPU 闭环和 Nyx 来源约束 |
| visibility decode、透视插值、解析梯度、显式采样梯度、material packing、PBR 数学；有界队列检查、程序缓存/绑定隔离、历史失效逻辑 | Extract | 提取数学、不变量与可复用实现到新 owner；旧 Feature/Pass 不作 adapter |
| `Renderer`、`FrameProducts`、`OpaqueShadingDemand`、`TemporalHistoryRegistry`、Surface/材质/照明 owner | Rewrite | Renderer 脱离继承；Product schema 和时间身份按新语义重建；不强制保行为 |
| `MainRenderPipeline`、`MainFrameFeatureTopology`、`OptionalFrameFeatures`、现 `FramePlan`、`MainRenderPipelineGraphKey`、仅服务旧 recipe 的 registry/manager | Delete | Phase 1 从生产路径切掉；无其他合法消费者后删文件，不设平行新旧链 |
| 旧 AO/SSGI/SSR/GI/CSM/TAA/NSS/Bloom Feature/Service、`SurfaceFeature`/`SparseShadingResolvePass` owner | Delete after extraction | 先搬 Surface 算法，再删 owner；Next 阴影没有 CSM fallback，未完成 VSM 时可暂时无影 |

旧文件 → 新 owner：`Renderer.ts` → 薄 composition root；`MainRenderPipeline.ts`/`FramePlan.ts` → Renderer Core 的需求、有限计划与 FrameGraph lowering；`SurfaceFeature.ts`/`SparseShadingResolvePass.ts` → Visibility & Surface 的数学、材质与频率 owner；旧 AO/SSR/SSGI/GI/CSM → Light Transport Provider；旧 sky/fog → Environment & Media；旧 TAA/NSS/`TemporalHistoryRegistry` → Temporal & Presentation。这是**删除和重建指令**，不要求维持类名或旧 API。

## 文档和声明切断清单

| 旧权威 | 处理 | 代码切换时必须同步处理 |
| --- | --- | --- |
| ADR-0003、0013、0015、0019 | 标记 superseded；新目标以 ADR-0020 为准 | 一条主管线、GPU 闭环和需求裁剪等相容原则仍有效；旧 owner/exactly-once/CSM fallback 不再指挥新实现 |
| `render-product-work-history-v1` | 停止作为 Next 冻结目标，保留历史现状说明 | 新 Product、Work 和 History 语义进入新的 contract/spec；旧消费者删除时移除旧引用 |
| `shading.one-eval` 等旧路径 claim 和既有 evidence | 目前仍描述旧代码事实，不转授给新 Renderer | Phase 1/2 同批次撤销或重写声明、检查与 case 期待；新 claim 从新 revision 的证据开始 |
| 旧 M1 workstream | 关闭旧任务，重置同一个 active workstream | 不再要求 split main pipeline 且 preserve behavior |

## 切断顺序

### Phase 0 — 冻结与废止旧目标

固定当前 Git 基线和来源 revision；接受 ADR-0020 并废止冲突决策/旧 A 批次合同；重置 workstream。Git 提供回退，不维护运行时 fallback。本页完成即结束 Phase 0 的文档部分；代码基线 tag 与 claim 调整在 Phase 1 第一刀前落实。

### Phase 1 — 直接切断旧 Composition

1. 解除 `Renderer extends MainRenderPipeline`，建立唯一新帧入口、场景发布、FrameGraph lowering、提交与恢复；主链先到 `Scene → GPU Visibility → Debug/Base Color → Present`。
2. 接入 GPU Work typed 协议及能力/预算协商，保留现有 GPU Scene/VG/visibility 真正消费者。删除旧 recipe、topology、optional-feature 包装和无消费者资源/submit；不迁回旧 AO、CSM、SSR、SSGI、TAA。
3. 检查空/单场景、resize/device loss、队列容量/溢出与基本输出。旧端到端画质测试可暂不通过，并明确记录已撤销的目标。

### Phase 2 — Surface / Material / Shading

1. 提取旧 visibility 解码、透视属性、解析梯度、UV/贴图和 Filament-derived PBR；用固定 The Forge 来源对照数学，建立新 Product schema 与材质程序/绑定闭包。
2. 先用保守材质频带及廉价 coverage/motion/连续性分类，再执行 full/coarse/reuse 的真实消费与重建；不能完整采样后才决定降频。高频材质、法线、镜面、边缘和 disocclusion 保留所需频率；每个可见样本有合法结果。
3. 基本 direct lighting 接通后删旧 Surface/Sparse owner；同步替换 `shading.one-eval` 旧声明。验证梯度、材质/纹理、边界、运动和队列净收益。

### Phase 3 — Physical Environment + Temporal

1. 以 Takram 固定来源迁移非地理物理环境，建立 Sun direct、Sky indirect、atmosphere/aerial 的单位与能量接口。
2. 建公共时间身份、motion、depth、jitter、exposure、history 生命周期；将 FidelityFX SDK v1.1.4 的 **FSR3 Upscaler** 作为首选最终重建完整 profile 移植，不包含 frame generation。解析型重建可作具名最小后端；FSR2 只是需重新决策的独立替代来源。
3. 静态/运动/遮挡揭露/分辨率和曝光变化逐项检查；信号去噪不与最终超分内部历史混为一体。

### Phase 4 — Light Transport

1. **VSM**：按 Timberdoodle 的页需求、分配、失效、回收、层次与采样完整映射；WebGPU 以独立光空间 caster 工作、storage indirection 和有界 indirect raster 取代 mesh shader/BDA；不留 CSM fallback。页吞吐与缺页必须可解释。
2. **AO + Reflection**：XeGTAO 的 prefilter/evaluate/denoise；FidelityFX SSSR 的 classification、ray work/indirect trace、验证、reprojection/filter/temporal；共用语义深度需求，仅在表示兼容时共享物理 HZB。反射 miss 进入一致的环境/Probe fallback。
3. **Hybrid GI**：近场 Screen GI、Atlas DDGI + software BVH 世界样本生产/Probe 更新、无限 Sky；动态几何与动态光源驱动加速结构、受影响区域、历史和置信度。Probe 存储不等于样本生产；静态烘焙或纯 SSGI 不算目标完成。

### Phase 5 — Virtual Resource Control Plane + Media

在已工作的 VG、纹理驻留、VSM、radiance field 上收敛统一预算/优先级/版本/退役/遥测，保留各自页格式、采样和物理缓存。Texture Residency 不改名冒充完整 VT；完整 VT 的反馈、页表、上传与采样要有合格来源或明确本地实现和收益。以 Adria 为候选迁移 Froxel 注入、历史、积分与合成，给 Fog、Local Volume、Light Scattering 统一介质表示；体积云后置。

## 迁移、验证和待证明风险

完整算法 profile 的源函数/entry、分支、依赖、历史、fallback、差异和本地对照记录在[来源账本](./porting/next-renderer.md)。GPUPrefixSums、The Forge、Filament、XeGTAO、FidelityFX SSSR/FSR3、Timberdoodle VSM、Atlas DDGI、Takram、Adria 均为固定候选；候选存在不等于 port 完成。不得删必要阶段还沿用原名。

重构中每个连贯批次运行 `node tools/vibe.mjs verify --changed`；优先修编译/静态、受影响合同和关键算法错误。完整旧 Renderer 测试无需作为每刀前提；新链完成后按功能逐一做浏览器场景与参考对照，阶段集成才 `verify --full`。正式 Runtime Validated、Performance、Pipeline 完成声明只由当前 revision 的正式 evidence 推出。

GTX 1650 Ti 4 GiB/16 GiB RAM 是较低配置设计基线，RTX 2060 的实际 adapter/limits 待该机读取；1080p/60 FPS、动态内部分辨率和可配置预算是目标，尚非实测保证。记录 shading/ray/page/probe 工作量、分类/重建成本、物化带宽和质量；不为少几个全屏 Pass 强制所有任务进队列。WebGPU feature/limit 先协商；mesh shader、DX12 Work Graph、硬件 RT、自由 bindless、BDA、64 位原子、multi-draw-count 不作主链前提。

对应阶段必须证明：VSM 页 raster 的 WebGPU 命令上界；Atlas software BVH 的动态更新与样本预算；adaptive compute shading 的净收益；完整 VT 来源；FSR3 profile 的 WGSL/capability 转换。它们不能以复活旧链作为默认解决方案。
