---
id: adr/0020-clean-cut-renderer
state: current
verifies:
  - project/workstreams/active
---
# ADR-0020: EEngine 单路径重建渲染架构

> V4 范围限定：本 ADR 仅继续提供单生产路径、破坏式切换、GPU-first、owner 与唯一提交原则。下文旧 Surface 频率/复用、统一 Work/资源/Temporal 协议、算法选择与阶段顺序保留为原决策背景，不构成 V4 authority 或当前实施任务。唯一未来架构与执行分别见 [V4 母稿](../next-design/eengine-v4-native-shading-2026-10.md) 和 [V4 执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)。

Status: accepted

## Context

当前 `Renderer extends MainRenderPipeline`，主管线同时拥有场景发布、可见性、Surface、效果、历史与提交。旧 M1 路线要求拆分时保持旧功能行为，因而持续为即将删除的 owner 建适配层。EEngine 尚未发布；用户决定允许重构期间暂时失去 AO、阴影、GI、反射与时域画质，并用 Git 保存旧实现。现有 GPU Scene、Virtual Geometry、GPU 层次工作生成、hardware visibility、VisibilityKey、FrameGraph 和显式梯度数学是应提取的技术资产，不是必须保留的旧主管线。

## Decision

EEngine 的目标是**单路径、需求驱动的虚拟化可见性 Renderer**：Renderer Core、Scene & Virtual Resources、Visibility & Surface、Light Transport、Environment & Media、Temporal & Presentation 六个一级模块。`Renderer` 仅负责设备和帧生命周期、组装、提交与恢复；新产品规划在配置/发布变化时从有限合法方案中选择表示并降低到一条 FrameGraph。资产/材质编译决定可能性，本帧 GPU 分类与计数决定实际工作量。不得建立并行 `RendererNext` 或兼容旧效果的长期 adapter。

第一刀直接解除 `Renderer` 对 `MainRenderPipeline` 的继承，删除旧 composition/feature ownership。新链先允许 `GPU Scene → VisibilityKey + Depth → 简单 Surface/颜色 → Present`；后续按完整算法切片恢复画质，不以保住旧功能为前提。FrameGraph、GPU Scene/VG/Visibility 的正确实现和 Surface 数学可搬迁到新 owner，旧文件生命周期见 [执行路线](../next-execution/eengine-next-architecture-layer-plan-2026.md)。

逻辑 Product 不是纹理。每个 Product 明确语义、坐标/分辨率/过滤、精度、物理单位/色彩空间、曝光、时间身份与缺失行为；有限计划选择融合、重算、物化或合法复用。Visibility 后重建 Surface，先用保守材质元数据和廉价几何/时间分类决定求值频率，再按需要执行材质与光照；所有可见样本必须得到有效结果，可来自 full、coarse、空间重建或时间复用。原“每个 opaque hit 恰好一次完整材质求值”不再是目标语义。

GPU Work Runtime 统一 typed work stream 的生产者/消费者、元素 ABI、容量、计数、溢出、间接执行与观测协议；meshlet、shade、ray、page、probe 保留专用元素和执行器，不制造万能物理队列，也不强制本来更便宜的 dense/direct 路径先 compact。Virtual Resource 控制面共享逻辑身份、需求、优先级、预算、驻留版本和退役；VG、纹理、VSM 和 radiance 各自保留物理缓存与更新机制。

Light Transport 以 Direct Light Visibility、Indirect Radiance、Reflection 为语义 owner。定向阴影直接做 VSM，Next 不保留 CSM fallback；caster 从光空间/页需求独立生成，不能只用主相机可见 meshlet。AO 选 XeGTAO，反射选 FidelityFX SSSR 与环境/Probe fallback，World GI 首选 Atlas DDGI + software BVH 样本生产，组合近场 screen GI 与远场 Sky。Physical Environment 以 Takram 的 Sun/Sky/Atmosphere 为来源，局部介质以 Adria Froxel 为候选。Temporal Fabric 统一运动、曝光、jitter、身份、history 生命周期；信号去噪归信号 owner，最终重建优先移植 FidelityFX SDK v1.1.4 **FSR3 Upscaler**，不包含 frame generation。FSR2 是独立研究备选，不混接内部阶段。Neural 只保留后端边界。

WebGPU 采用静态有界 kernel graph + GPU 动态工作量，协商设备 feature/limit 后建资源。当前设计不依赖 mesh/task shader、Work Graph、硬件 RT、自由 bindless heap、BDA、64 位原子或 multi-draw-count。1650 Ti 4 GiB 为较低配置预算基线，2060 机器另行实测；60 FPS/1080p 是目标而非已达性能声明。

## 阶段收口约束

Phase 2 先完成 Surface 提取、旧 owner 删除、精确合同和路由收口；有限空间频率 profile 之外由同一新链 full-rate 正确消费，不等待通用 lit/normal 降频或双机性能实验才删除旧 owner。广泛受光降频随 Phase 4 的真实 Light Transport 消费者推进；history reuse 必须等待 Phase 3。这不降低选定上游算法的完整移植要求。

结构退出、选定功能实现与正式质量/性能声明分别记录。跨消费者 Product 计划随实际消费者落地；最小虚拟身份、generation、预算和安全退役合同在 Phase 4 前明确，Phase 5 收敛控制面。workstream 只能细化执行路线，不得自行添加阻塞阶段收口的研究任务。

## Consequences

本 ADR 取代 [ADR-0003](./0003-unified-render-pipeline.md) 的 `MainRenderPipeline` owner、[ADR-0013](./0013-sparse-shading-bin-pipeline.md) 的每 hit 完整求值目标、[ADR-0015](./0015-visibility-native-pbr-receiver.md) 的旧 Sparse Shading owner，以及 [ADR-0019](./0019-eengine-next-renderer.md) 的保行为迁移和 CSM fallback。仍保留一条主管线、需求裁剪、GPU 闭环、Visibility-native Surface 等相容原则。旧代码运行事实和现有 evidence 不因 ADR 被接受而自动消失；失效的 claim/contract 与测试期待在相应大模块收口或最终验收时集中清理，不阻塞生产代码切断。

优先迁移[固定来源](../porting/next-renderer.md)的完整选定算法 profile。迁移映射必须保留源 entry、关键决策、依赖、失败/历史行为、平台差异和对照。选定算法在 WebGPU 下确有不可保留的核心语义时，明确修改采用决定，不把简化近似称为原 port。全 VT、VSM 页光栅成本、动态 GI 样本生产与自适应着色收益仍需在对应阶段证明。

## Verification

文档阶段只核对入口、链接、模型语法与源码对应关系。破坏式重构期间可按调试需要运行编译或 targeted test；大模块连通后主动运行 `vibe verify --module`，完整旧 Renderer 行为和浏览器效果矩阵不作为中途门禁。主要架构与 planned providers 完成后再做系统集成与正式性能声明，按 [VALIDATION](../VALIDATION.md) 的证据规则执行。目标决定本身不提升 claim。
