---
id: frame-runtime
kind: domain
owner: frame-runtime
state: current
verifies:
  - OEngine/src/render/FrameCoordinator.ts
  - OEngine/src/render/pipeline/RendererCore.ts
  - OEngine/src/render/program/FrameProgramLowering.ts
  - OEngine/src/render/lighting/FinalPixelLightingPublication.ts
  - OEngine/src/shaders/native_resolved_position.ts
  - OEngine/src/render/temporal/GpuRadiometryPass.ts
  - OEngine/src/render/temporal/ExposureSettings.ts
  - OEngine/src/render/passes/fsr3/Fsr3AccumulatePass.ts
  - OEngine/src/render/passes/fsr3/Fsr3AccumulateShader.ts
  - OEngine/src/render/passes/fsr3/Fsr3RcasPass.ts
  - OEngine/src/render/passes/fsr3/Fsr3UpscalerRuntime.ts
  - OEngine/src/render/temporal/NativeTemporalPasses.ts
  - OEngine/src/shaders/native_temporal.ts
---
# Frame Runtime

## 当前源码接线

核对日期：2026-10-11，当前生产工作树。这里记录当前 owner 与主链注册；实际验证结果及阶段状态只在模块执行计划。

[RendererCore](../../OEngine/src/render/pipeline/RendererCore.ts) 创建 FrameCoordinator、SurfaceV4、LocalLightWorkGenerator、NativeTemporalFactsPass 等长期 owners。[FrameProgramLowering](../../OEngine/src/render/program/FrameProgramLowering.ts) 将场景产品逐帧绑定到缓存 FrameGraph，连接最终 winner/depth→LocalLightWork→native Surface→Temporal/FSR3。

[FrameCoordinator](../../OEngine/src/render/FrameCoordinator.ts) 持有当前 command context，通过 submitFrame 的 command.finish 收口提交，并依据 gpuDone 退役 inFlight。canBeginFrame 限制未完成帧数量；这是 GPU completion 背压，不是读取本帧 visibility/work 后由 CPU 决策。

Geometry、native Material publication、LocalLightWork、Surface、VSM 与后处理注册同一个 graph。各 pass 消费显式产品，不拥有独立 frame submit。LightDatabase 仍归 Scene environment，generator 只拥有自己的 frame allocation；提交后按真实 gpuDone fence 复用或销毁，abort 不推进产品历史，device loss 退休旧 epoch。

Final Pixel Shadow 主链由 VSM post-content publication 直接写 FinalPixelLighting container 的descriptor区间，PhysicalEnvironment发布原half Solar LUT，LocalLightWork直接写lookup区间；Native只读最后resource version。物理container由独立 `FinalPixelLightingPublication` 负责3个有界 frame allocation、abort/fence/epoch和显存记账，三种逻辑producer各自保留owner。Native单次几何恢复后完成原point-PCF与Sun；独立Shadow Resolve、ShadowVisibility、Sun continuation和第二HDR已删除。当前Temporal仍读NativeTemporalFacts，Seed production cutover与Native V2不在此项实现事实内。

`GpuRadiometryPass` 独立持有曝光双槽和有效性：颜色/TAA reset、resize、Sun/Sky edit、camera cut 不重置曝光，commit 换槽，abort 保留，device epoch 初始化与 `resetExposure()` 显式重置。主链保留 P(n−1) render→去预曝光 HDR histogram→percentile/highlight/log adaptation→E(n)，FSR 先读旧两槽，Presentation 再使用 E/P。常规帧没有 CPU 读回；`readExposureDiagnostics()` 是调用者主动请求的单次 32B readback，不能驱动 frame work。

`Fsr3UpscalerRuntime`按两轴实际internal/output尺寸选择服务域：1:1采用`NativeTemporalPasses`的Depth Classification→Native Resolve；真实upscale继续FSR Prepare Reactivity→Luma Instability→Accumulate。两域共享原Prepare Inputs、Luma/Shading SPD、Shading Change与RCAS质量功能，1:1不再注册旧三个compute和独立new-lock/instability产品。Native Resolve融合四帧亮度响应、thin lock与重建，96B当前滤波权重由classification完整写入并经下一dispatch依赖读取；没有额外history或frame submit。

两域都只写本帧RGBA16F color history（RGB与SDK alpha lock），RCAS读取`builder.write(currentHistory)`的写版本，仅使用RGB并输出alpha1，不声明重复upscaled color临时纹理。仍由同一runtime管理color/luma/luma-history/confidence/frame-info双槽与prepare/commit/abort/resize/fence；只有成功submit后commit换槽。policy切换重置history并推进generation，abort恢复原policy/index/generation/jitter。普通camera motion不reset，defer不推进history；源码切换不证明整帧性能已验收。

## 原则与验证边界

唯一生产路径、禁止本帧 GPU→CPU→GPU work control、producer 与直接 consumer 同单元切换，继续由根规则和[当前设计](../next-design/eengine-v4-native-shading-2026-10.md)约束。

camera cut/resize/abort/device loss、history 提交、publication 和资源生命周期必须用当前生产入口验证；仅观察这些 owner 存在不能判所有场景通过。Temporal/FSR3 的接线不表示未来 AI Upscaling 已实现。

旧 Phase0–6 不做中间检查的文字已失效。按[当前执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)集中核对单元编译、接线、正确性与成本；完整 browser/质量/性能矩阵在整个 Renderer/providers 完成后进行。

旧阶段与旧状态说明已收回，Git 保留历史。本页只维护已核实 owner/数据流；阶段和每次运行结果不在这里复制。
