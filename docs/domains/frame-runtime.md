---
id: frame-runtime
kind: domain
owner: frame-runtime
---
# Frame Runtime

## 当前生产链

核对：2026-10-02，基线 `e7296be9`。`RendererCore` 是 composition root，`FrameCoordinator` 是唯一 frame command context/submit owner。当前 FrameProgramLowering 连接 GPU Scene/hierarchy/MeshletWork/Visibility → AppearanceCachePass fields → TemporalFacts → SparseLighting → Sky/Aerial → FSR3/Radiometry/Bloom/Present。HZB、cluster、lit-consumer XeGTAO 和 directional VSM 使用同一 FrameGraph；空场景沿用同一个帧入口和 submit owner。

旧 SurfaceProbe/Work Builder/sample workers/Resolve 与 SurfaceMaterialPass 不再是生产路径。当前 Appearance/SparseLighting 接线不表示 SurfaceWork V3 已实现。

FrameProgram 关闭有限产品需求，FrameProgramBindings 在 encode 前检查当前 publication/descriptor/device shape，Lowering 注册实际资源边。拓扑与 GPU 资源/版本身份应区分；camera motion、history ping-pong 和局部 generation 不用于 CPU 选择本帧 work。新 Surface 的 work/GeometryRecord/cache/packet 真实阶段仍需显式接入 FrameGraph，不能继续藏在 Appearance 单回调中。

## 帧事务与历史

TemporalFactsPass 从 depth、instance 和 current/previous camera 发布 motion/identity/masks，SparseLighting 读取基础 facts 并产生自己的 signal history/reactive，FSR3 使用这些真实产品。Surface 不拥有第二套基础 motion。

TemporalFabric 管理 begin/commit/abort 与读写角色，各 consumer 管理实际纹理。Camera cut、resize、scene/representation/environment 变化和 device recovery 根据真实依赖失效；GPU completion 延迟资源退役。FrameCoordinator 在创建新帧资源前限制最多两个已提交未完成帧，是 completion 背压，不是本帧 visible/work readback 控制。

Environment 发布完整 LUT generation，abort 不提升未提交状态；FSR3 仍保留选定 upscaler 算法阶段。Pre-exposure/working color space、motion/jitter 和 history 输入不能由新 Surface 重新定义。当前基础接线不证明完整形变、signal change/reactive、透明或全场景生命周期验收。

## 当前目标和验证边界

唯一 Surface 目标是[第三版原文](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)，实施见[SurfaceWork V3](../next-execution/surface-work-runtime-v3-rebuild-2026.md)。保留现有 frame/scene/visibility/resource owner，重构 SurfaceWork、唯一 GeometryRecord、cache lookup/miss、signal packets、history 和廉价 reconstruct。

禁止 private frame submit、本帧 GPU→CPU→GPU control、旧/新双路径和临时 adapter。当前 Surface 开发中的编译/tests/GPU/browser/benchmark 推迟到完整目标与真实接线后；来源核读提前，formal evidence/claims 分别记录。本次仅文档核对，未运行 renderer 验证。

SSSR、Hybrid GI、VT、Transparency/Media 是后续模块。Surface 专项验收按原文 §8–§11，其他主要模块完成后再做完整 Renderer 系统验收。

入口：`render/pipeline/RendererCore.ts`、`FrameCoordinator.ts`、`program/FrameProgram.ts`、`FrameProgramBindings.ts`、`FrameProgramLowering.ts`、`framegraph/FrameGraph.ts`、当前 `surface/AppearanceCachePass.ts` 和 `SparseLightingPass.ts`。过去 VSM/Temporal 组件检查见[ledger](../porting/next-renderer.md)，不转授新主链验收。
