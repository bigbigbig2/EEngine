---
id: frame-runtime
kind: domain
owner: frame-runtime
state: current
verifies:
  - OEngine/src/render/FrameCoordinator.ts
  - OEngine/src/render/pipeline/RendererCore.ts
  - OEngine/src/render/program/FrameProgramLowering.ts
  - OEngine/src/render/temporal/GpuRadiometryPass.ts
  - OEngine/src/render/temporal/ExposureSettings.ts
---
# Frame Runtime

## 当前源码接线

核对日期：2026-10-10，当前生产工作树。这里记录当前 owner 与主链注册；实际验证结果及阶段状态只在模块执行计划。

[RendererCore](../../OEngine/src/render/pipeline/RendererCore.ts) 创建 FrameCoordinator、SurfaceV4、LocalLightWorkGenerator、NativeTemporalFactsPass 等长期 owners。[FrameProgramLowering](../../OEngine/src/render/program/FrameProgramLowering.ts) 将场景产品逐帧绑定到缓存 FrameGraph，连接最终 winner/depth→LocalLightWork→native Surface→Temporal/FSR3。

[FrameCoordinator](../../OEngine/src/render/FrameCoordinator.ts) 持有当前 command context，通过 submitFrame 的 command.finish 收口提交，并依据 gpuDone 退役 inFlight。canBeginFrame 限制未完成帧数量；这是 GPU completion 背压，不是读取本帧 visibility/work 后由 CPU 决策。

Geometry、native Material publication、LocalLightWork、Surface、VSM 与后处理注册同一个 graph。各 pass 消费显式产品，不拥有独立 frame submit。LightDatabase 仍归 Scene environment，generator 只拥有自己的 frame allocation；提交后按真实 gpuDone fence 复用或销毁，abort 不推进产品历史，device loss 退休旧 epoch。

`GpuRadiometryPass` 独立持有曝光双槽和有效性：颜色/TAA reset、resize、Sun/Sky edit、camera cut 不重置曝光，commit 换槽，abort 保留，device epoch 初始化与 `resetExposure()` 显式重置。主链保留 P(n−1) render→去预曝光 HDR histogram→percentile/highlight/log adaptation→E(n)，FSR 先读旧两槽，Presentation 再使用 E/P。常规帧没有 CPU 读回；`readExposureDiagnostics()` 是调用者主动请求的单次 32B readback，不能驱动 frame work。

## 原则与验证边界

唯一生产路径、禁止本帧 GPU→CPU→GPU work control、producer 与直接 consumer 同单元切换，继续由根规则和[当前设计](../next-design/eengine-v4-native-shading-2026-10.md)约束。

camera cut/resize/abort/device loss、history 提交、publication 和资源生命周期必须用当前生产入口验证；仅观察这些 owner 存在不能判所有场景通过。Temporal/FSR3 的接线不表示未来 AI Upscaling 已实现。

旧 Phase0–6 不做中间检查的文字已失效。按[当前执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)集中核对单元编译、接线、正确性与成本；完整 browser/质量/性能矩阵在整个 Renderer/providers 完成后进行。

旧阶段与旧状态说明已收回，Git 保留历史。本页只维护已核实 owner/数据流；阶段和每次运行结果不在这里复制。
