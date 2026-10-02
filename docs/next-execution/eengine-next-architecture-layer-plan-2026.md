# EEngine Next 架构层执行计划

更新：2026-10-02。当前 Surface 方向已统一为用户指定的 [第三版最终设计](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)，实施细节见 [SurfaceWork Runtime V3 计划](surface-work-runtime-v3-rebuild-2026.md)。本页说明整体依赖和交接，不再维护 Surface v2、Signal-Rate 或旧缓存计划的并行路线。

## 1. 权威入口与状态

- 目标：第三版原文；保留系统边界见 [整体架构](../next-design/eengine-next-overall-architecture-final-2026.md)。
- 决策：[ADR-0021](../adr/0021-surface-work-runtime-v3.md) 补充 [ADR-0020](../adr/0020-clean-cut-renderer.md)，替代其旧 Surface 阶段约束。
- 当前切片：[eengine-next-clean-rebuild](../../project/workstreams/active/eengine-next-clean-rebuild.yaml) 的 `surface-work-runtime-v3-refactor`。
- 当前事实：[Shading](../domains/shading.md)、[Frame Runtime](../domains/frame-runtime.md)、[Visibility](../domains/visibility.md) 与源码。
- 来源：[Next porting ledger](../porting/next-renderer.md)；旧条目和组件验证不等于新链实现或 adoption。
- 验收：[VALIDATION](../VALIDATION.md) 与原文 §8–§11。

源码基线已删除旧 SurfaceMaterialPass/Probe/sample worker 主链。当前生产代码已经接通 `SurfaceWorkRuntime` 的 classify、publication cache lookup、GPU-only geometry miss compact/indirect resolve、publication miss evaluation、cluster/VSM/AO/IBL provider、signal-mask 独立 packets、signal/identity/age 双缓冲 history 和 reconstruct；完整 sampler/UV/filtered footprint、材质 view/nonlocal identity、Product/形变、environment/light/VSM revision reject 与正式验收仍未完成。这里描述的是当前结构接线，不把它提升为最终算法或性能完成。

## 2. 保留底座和当前范围

保留 RendererCore composition root、FrameCoordinator 单 submit/背压、FrameGraph、FrameProgram/Bindings/Lowering、GpuRenderWorld/资源 owner、GPU Scene/VG/hierarchy、Packed Visibility/HZB、FrameGeometryArena/Vertices/Winner 数学、材质编译/静态产品/registry、Environment/VSM/AO/Temporal/FSR3/显示。

保留的是职责和正确资产，不是现有所有 Surface consumer、逐像素任务、重复几何恢复和内部黑盒调度。当前 Surface 包含 PixelFacts/SurfaceAddress、implicit/uniform/mixed work、GeometryRecord、前置 cache lookup/miss queue、独立 lighting packets、history、廉价合成、真实 FrameGraph 边和生命周期。

## 3. 连续实施顺序

| Phase | 工作 | 交接产物 |
| --- | --- | --- |
| 0 | 固定 9/25、中间版、第三版 revision 和比较配置 | 独立 checkout 基线身份、同条件采样口径 |
| 1 | 核对已删旧链，切断剩余被替代的 Surface 执行模型 | 无旧 owner/adapter/兼容 consumer 的生产依赖 |
| 2 | 统一 SurfaceWork 和唯一几何恢复 | descriptors/samples/masks/exceptions、GeometryRecord、bounded indirect |
| 3 | Appearance 改为 cache lookup → miss-only compact/evaluate/publish | hit 绕过 geometry/material heavy worker，字段身份和安全发布 |
| 4 | diffuse/specular/coat/IBL 分信号 packets | GeometryRecord consumer、cluster/shadow/environment 依赖和局部例外 |
| 5 | reconstruct 降为结果选择与合成 | 不重复几何/材质/完整 PBR 的 HDR/reactive 输出 |
| 6 | 接通 Environment/VSM/AO/Temporal/FSR3 和资源生命周期 | 真实消费、局部失效、commit/abort/resize/cut/device recovery |
| 7 | 一次集中验证、返工、删除无消费者残留 | 四版本同条件比较、数值/覆盖/连续画质/性能/生命周期结果 |

Phase 1–6 允许中间未编译/缺图，不执行编译、targeted tests、GPU oracle、browser、benchmark 或 verify，不按组件收口设门槛。Phase 0 先记录身份和配置，正式采样在 Phase 7 进行。算法实施前核读完整固定来源。用户后续明确要求的诊断按该次指令执行。

## 4. 接线和所有权

Visibility 生产 winner/depth，SurfaceWork 解析 winner 并建立 sharing/cache domain；SurfaceGeometryPass 唯一恢复 Surface 几何。Appearance 与 Lighting 不再各自解码三顶点或恢复 UV/normal。Material owner 发布编译分类与版本，cache owner 管理 lookup/miss/publish，signal owner 管理独立 work/history/reconstruction。

TemporalFacts 保持唯一 motion/identity/validity/reactive 基础 producer。Environment、AO、VSM 保持各自生产 owner；只使真实依赖的 field/signal/history 失效。Renderer 只组装，各模块不加 frame submit。能力、容量和 overflow 在创建/权威发布边界保证；不存在全局万能 work queue。

## 5. Surface 完成后的方向

| 后续模块 | 方向 | 与 Surface 的边界 |
| --- | --- | --- |
| SSSR | FidelityFX SSSR 完整选定 profile | 消费真实字段和 reflection source；有独立 confidence/denoising，不重复环境镜面计能 |
| Hybrid GI | screen/world/sky providers，固定来源核读 | 消费 GeometryRecord/材质语义和 world/radiance facts；独立 work/history |
| Virtual Resource / VT | 共享身份、预算、需求和退役控制面 | 保留 VG/纹理/VSM/radiance 专用物理表示，不合并大 atlas |
| Transparency / Media | 独立 composition domain | 共享 Scene/Lighting/Temporal/显示，不强塞 opaque winner |

skin/morph/previous deformation、Product 跨 LOD/source/seam、nonlocal/provider、屏外 VSM caster 等当前缺口继续跟踪；不把原文对 owner 的保留表述当成这些能力已经完成。

## 6. 完成和验收口径

Surface 专项完成定义严格使用原文 §11 的 16 项和 §8.3 成功标准。首要目标是 GTX 1650 Ti、1080p 复杂场景。最终报告包含 Surface 全成本和整帧 GPU P50/P95、工作量/命中/IBL/例外/溢出、内存和连续画质；冻结 feature set、camera、browser、adapter 和热状态。

不沿用旧计划的固定 50%/30% 门槛，不承诺 FPS。四版本对比使用独立 checkout，不恢复生产 A/B 开关。实现/来源采用/正式 evidence 和 claims 分别记录。其他 providers 未完成不推迟本次 Surface 专项验收，全部主要架构/providers 完成后再执行整个 Renderer 的正式系统验收。
