---
id: frame-runtime
kind: domain
owner: frame-runtime
state: current
verifies:
  - project/domains
---
# Frame Runtime

## 当前生产链

核对：2026-10-04，重构前代码14c17078。RendererCore是composition root，FrameCoordinator是唯一frame command context/submit owner。FrameProgramLowering连接唯一SurfaceWorkRuntime，前置Field/Signal查询、证书/分类、实际需求、GeometryRecord、Appearance/Lighting、Store发布和reconstruct均在同一FrameGraph；HZB、cluster、XeGTAO、VSM保留原owner。当前[有界前端执行计划](../next-execution/surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)仅准备完成，尚未实施。

退休SurfaceMaterialPass/Probe及旧协调器不是生产路径。当前已使用独立FieldStore/SignalStore与唯一GeometryRecord，不再将旧Material/Geometry cache bypass当作当前实现。详细事实见[Shading](shading.md)；run06约801.7ms为diagnostic，完整质量/生命周期/性能验收未完成。

FrameProgram 关闭有限产品需求，FrameProgramBindings 在 encode 前检查当前 publication/descriptor/device shape，Lowering 注册实际资源边。SurfaceWork 的固定前缀、GeometryRecord、cache key/value、packet 与 HDR/reactive 边界均可被 FrameGraph 看到；camera motion、history ping-pong 和局部 generation 不用于 CPU 选择本帧 work。

## 帧事务与历史

TemporalFactsPass从depth、instance和current/previous camera发布motion/identity/masks；Surface reconstruct和FSR3消费同一基础产品，Surface没有第二套motion。当前signal复用由独立SignalStore/ref及其epoch/generation管理，不是早期四路dense history合同；完整reject/abort/camera cut/device recovery仍待集中验收。

TemporalFabric 管理 begin/commit/abort 与读写角色，各 consumer 管理实际纹理。Camera cut、resize、scene/representation/environment 变化和 device recovery 根据真实依赖失效；GPU completion 延迟资源退役。FrameCoordinator 在创建新帧资源前限制最多两个已提交未完成帧，是 completion 背压，不是本帧 visible/work readback 控制。

Environment 发布完整 LUT generation，abort 不提升未提交状态；FSR3 仍保留选定 upscaler 算法阶段。Pre-exposure/working color space、motion/jitter 和 history 输入不能由新 Surface 重新定义。当前基础接线不证明完整形变、signal change/reactive、透明或全场景生命周期验收。

## 当前目标和验证边界

唯一 Surface 目标是[第三版原文](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)，实施见[SurfaceWork V3](../next-execution/surface-work-runtime-v3-rebuild-2026.md)。保留现有 frame/scene/visibility/resource owner，重构 SurfaceWork、唯一 GeometryRecord、cache lookup/miss、signal packets、history 和廉价 reconstruct。

禁止 private frame submit、本帧 GPU→CPU→GPU control、旧/新双路径和临时 adapter。Phase 0–6 的实现期不设置中间验证门；当前 revision 尚未运行本轮 typecheck/build/build:test/shader audit，正式 GPU/browser/benchmark/evidence 统一留在 Phase 7。来源核读提前，formal evidence/claims 分别记录。

SSSR、Hybrid GI、VT、Transparency/Media 是后续模块。Surface 专项验收按原文 §8–§11，其他主要模块完成后再做完整 Renderer 系统验收。

入口：`render/pipeline/RendererCore.ts`、`FrameCoordinator.ts`、`program/FrameProgram.ts`、`FrameProgramBindings.ts`、`FrameProgramLowering.ts`、`framegraph/FrameGraph.ts`、`surface/SurfaceWorkRuntime.ts`。过去 VSM/Temporal 组件检查见[ledger](../porting/next-renderer.md)，不转授新主链验收。
