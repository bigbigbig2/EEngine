---
id: frame-runtime
kind: domain
owner: frame-runtime
---
# Frame Runtime

## 当前生产链

核对：2026-10-02，以当前工作树源码为准。`RendererCore` 是 composition root，`FrameCoordinator` 是唯一 frame command context/submit owner。FrameProgramLowering 已切换到唯一 SurfaceWorkRuntime，SurfaceWork 的 classify、lookup、GeometryRecord、miss evaluation、cluster/VSM/AO/IBL 输入、packet 和 reconstruct 都注册为独立 FrameGraph 节点；HZB、cluster、XeGTAO 和 directional VSM 继续使用同一 FrameGraph。

旧 SurfaceProbe/Work Builder/sample workers/Resolve 与 SurfaceMaterialPass 不再是生产路径。当前 V3 主链已经真实接线；GeometryRecord hit 绕过、完整 identity/footprint 语义、signal age/revision reject 和整帧验收仍未完成。

FrameProgram 关闭有限产品需求，FrameProgramBindings 在 encode 前检查当前 publication/descriptor/device shape，Lowering 注册实际资源边。SurfaceWork 的固定前缀、GeometryRecord、cache key/value、packet 与 HDR/reactive 边界均可被 FrameGraph 看到；camera motion、history ping-pong 和局部 generation 不用于 CPU 选择本帧 work。

## 帧事务与历史

TemporalFactsPass 从 depth、instance 和 current/previous camera 发布 motion/identity/masks；SurfaceWork reconstruct 直接读取其 mask，FSR3 使用同一真实产品。Surface 不拥有第二套基础 motion。当前 reconstruct 已接入双缓冲 signal history、基础 feedback 和 pre-exposure，但仍需接入 signal identity/version/history age 的完整 reject 条件。

TemporalFabric 管理 begin/commit/abort 与读写角色，各 consumer 管理实际纹理。Camera cut、resize、scene/representation/environment 变化和 device recovery 根据真实依赖失效；GPU completion 延迟资源退役。FrameCoordinator 在创建新帧资源前限制最多两个已提交未完成帧，是 completion 背压，不是本帧 visible/work readback 控制。

Environment 发布完整 LUT generation，abort 不提升未提交状态；FSR3 仍保留选定 upscaler 算法阶段。Pre-exposure/working color space、motion/jitter 和 history 输入不能由新 Surface 重新定义。当前基础接线不证明完整形变、signal change/reactive、透明或全场景生命周期验收。

## 当前目标和验证边界

唯一 Surface 目标是[第三版原文](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)，实施见[SurfaceWork V3](../next-execution/surface-work-runtime-v3-rebuild-2026.md)。保留现有 frame/scene/visibility/resource owner，重构 SurfaceWork、唯一 GeometryRecord、cache lookup/miss、signal packets、history 和廉价 reconstruct。

禁止 private frame submit、本帧 GPU→CPU→GPU control、旧/新双路径和临时 adapter。Phase 0–6 的实现期不设置中间验证门；当前已完成 typecheck/build/build:test/shader audit，正式 GPU/browser/benchmark/evidence 仍集中留在 Phase 7。来源核读提前，formal evidence/claims 分别记录。

SSSR、Hybrid GI、VT、Transparency/Media 是后续模块。Surface 专项验收按原文 §8–§11，其他主要模块完成后再做完整 Renderer 系统验收。

入口：`render/pipeline/RendererCore.ts`、`FrameCoordinator.ts`、`program/FrameProgram.ts`、`FrameProgramBindings.ts`、`FrameProgramLowering.ts`、`framegraph/FrameGraph.ts`、`surface/SurfaceWorkRuntime.ts`。过去 VSM/Temporal 组件检查见[ledger](../porting/next-renderer.md)，不转授新主链验收。
