---
id: frame-runtime
kind: domain
owner: frame-runtime
state: current
verifies:
  - OEngine/src/render/FrameCoordinator.ts
  - OEngine/src/render/pipeline/RendererCore.ts
  - OEngine/src/render/program/FrameProgramLowering.ts
---
# Frame Runtime

## 当前源码接线

核对日期：2026-10-05；源码基准 11a7af962dd4eae54e900e31d28dc856d540d443。本轮核对 owner 与主链注册，未重新认证所有生命周期分支。

[RendererCore](../../OEngine/src/render/pipeline/RendererCore.ts) 创建 FrameCoordinator、SurfaceWorkRuntime、TemporalFactsPass 等长期 owners。[FrameProgramLowering](../../OEngine/src/render/program/FrameProgramLowering.ts) 将场景产品绑定并注册到 FrameGraph，其中包含 SurfaceWork 与后续 FSR3 链。

[FrameCoordinator](../../OEngine/src/render/FrameCoordinator.ts) 持有当前 command context，通过 submitFrame 的 command.finish 收口提交，并依据 gpuDone 退役 inFlight。canBeginFrame 限制未完成帧数量；这是 GPU completion 背压，不是读取本帧 visibility/work 后由 CPU 决策。

SurfaceWork 的 demand、geometry、Appearance、lighting、Store 发布和 reconstruction 注册同一个 graph。各 pass 消费共享资源，不拥有独立 frame submit。

## 原则与验证边界

唯一生产路径、禁止本帧 GPU→CPU→GPU work control、producer 与直接 consumer 同单元切换，继续由根规则和[当前设计](../next-design/eengine-v4-native-shading-2026-10.md)约束。

camera cut/resize/abort/device loss、history 提交、publication 和资源生命周期必须用当前生产入口验证；仅观察这些 owner 存在不能判所有场景通过。Temporal/FSR3 的接线不表示未来 AI Upscaling 已实现。

旧 Phase0–6 不做中间检查的文字已失效。按[当前执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)集中核对单元编译、接线、正确性与成本；完整 browser/质量/性能矩阵在整个 Renderer/providers 完成后进行。

旧阶段与旧状态说明已收回，Git 保留历史。本页只维护已核实 owner/数据流；阶段和每次运行结果不在这里复制。
