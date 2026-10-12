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
  - OEngine/src/render/temporal/NativeTemporalV2.ts
  - OEngine/src/render/temporal/NativeTemporalSeed.ts
  - OEngine/src/render/lighting/LocalLightWorkGenerator.ts
  - OEngine/src/shaders/native_temporal_amd.ts
  - OEngine/src/render/passes/fsr3/Fsr3UpscalerRuntime.ts
---

# Frame Runtime

## 当前源码接线

核对日期：2026-10-12，当前生产工作树。这里记录当前 owner 与主链注册；实际验证结果及阶段状态只在模块执行计划。

[RendererCore](../../OEngine/src/render/pipeline/RendererCore.ts) 创建 FrameCoordinator、SurfaceV4、LocalLightWorkGenerator、NativeTemporalSeed 等长期 owners。[FrameProgramLowering](../../OEngine/src/render/program/FrameProgramLowering.ts) 将场景产品逐帧绑定到缓存 FrameGraph，连接最终 winner/depth→LocalLightWork→native Surface→Temporal/FSR3。

Directional VSM 只服务 Physical Sun；初始化关闭 PhysicalEnvironment 时不创建 VSM 资源或 pass owners，无 Physical Sun 的 enabled shadow Frame Program 被拒绝。无 authored/physical IBL 时，Surface 按需提供共享 1×1 RGBA16F 零辐射绑定，authored directional/local lights 仍执行完整 lit 路径。

[FrameCoordinator](../../OEngine/src/render/FrameCoordinator.ts) 持有当前 command context，通过 submitFrame 的 command.finish 收口提交，并依据 gpuDone 退役 inFlight。canBeginFrame 限制未完成帧数量；这是 GPU completion 背压，不是读取本帧 visibility/work 后由 CPU 决策。

Geometry、native Material publication、LocalLightWork、Surface、VSM 与后处理注册同一个 graph。各 pass 消费显式产品，不拥有独立 frame submit。LightDatabase 仍归 Scene environment，generator 只拥有自己的 frame allocation；提交后按真实 gpuDone fence 复用或销毁，abort 不推进产品历史，device loss 退休旧 epoch。

Final Pixel Shadow 主链由 VSM post-content publication 直接写 FinalPixelLighting container 的descriptor区间，PhysicalEnvironment发布原half Solar LUT，LocalLightWork直接写lookup区间；Native只读最后resource version。物理container由独立 `FinalPixelLightingPublication` 负责3个有界 frame allocation、abort/fence/epoch和显存记账，三种逻辑producer各自保留owner。Native单次几何恢复后完成原point-PCF与Sun；独立Shadow Resolve、ShadowVisibility、Sun continuation和第二HDR已删除。Native 在已有 winner/position/instance/material facts 时写 Seed rgba32float、response rgba8unorm 与完整 identity rgba32uint；NativeTemporalSeed 管理 identity pair、camera/jitter、commit/abort/fence/epoch。Native 1:1由 NativeTemporalV2 直接消费 Seed/response/exact identity，并管理 color/depth/luma/confidence/exposure histories；正常 Native 图没有独立 Seed classification。classification仅服务 upscale 和必要 debug；AA-off由完整Surface writer证明identity提交，不执行无consumer分类；空场景成功提交后，两种color backend按最后consumer fence退休；旧 Facts/Aux、material versions、旧 T3 owner 已删除。质量和成本资格只读 V5 execution authority。

`GpuRadiometryPass` 独立持有曝光双槽和有效性：颜色/TAA reset、resize、Sun/Sky edit、camera cut 不重置曝光，commit 换槽，abort 保留，device epoch 初始化与 `resetExposure()` 显式重置。主链保留 P(n−1) render→去预曝光 HDR histogram→percentile/highlight/log adaptation→E(n)，FSR 先读旧两槽，Presentation 再使用 E/P。常规帧没有 CPU 读回；`readExposureDiagnostics()` 是调用者主动请求的单次 32B readback，不能驱动 frame work。

`RendererCore`按两轴实际尺寸选择唯一颜色 writer：Native 1:1为 Measure→Exposure→Shading Pyramid→Analyze→Resolve→RCAS；true upscale为原 FSR3 graph；bypass不写color history。Native previous-depth pull不分配reconstructed-depth buffer、不clear/scatter，不重建Geometry。Shading Pyramid一次计算源差异并归约2/4/8尺度；必要统计由新owner持有。inactive domain在replacement成功submit后按最后fence退休，abort恢复上一提交角色/validity/jitter；不是同时运行两套Native路径。

两域都只写本帧RGBA16F color history（RGB与SDK alpha lock），RCAS读取`builder.write(currentHistory)`的写版本，仅使用RGB并输出alpha1，不声明重复upscaled color临时纹理。两域各自owner管理color/luma/luma-history/confidence/frame-info双槽与prepare/commit/abort/resize/fence，Native额外拥有raw depth pair；TemporalFabric协调同一提交事务；只有成功submit后commit换槽。policy切换重置history并推进generation，abort恢复原policy/index/generation/jitter。普通camera motion不reset，defer不推进history；源码切换不证明整帧性能已验收。

成功 empty submit 退休 Surface scene working set、Seed、两个颜色后端及 lighting frame pools；成功 all-unlit submit 退休 local-light 与 final-lighting frame pools。提交失败不释放旧场景；已提交资源等最后使用 fence，返回场景重新生成 Seed validity。Surface neutral bindings、owner/pipeline 与 VSM residency 保留各自寿命。Native V2、FSR 和 Seed 的 actual/candidate/retiring bytes 进入 GraphicsContext 共用资源账本；资源 destroy 后撤账，API 全 owner 同时峰值由验证观察器另核，常规生产无该观察器。

## 原则与验证边界

唯一生产路径、禁止本帧 GPU→CPU→GPU work control、producer 与直接 consumer 同单元切换，继续由根规则和[当前设计](../next-design/eengine-v4-native-shading-2026-10.md)约束。

camera cut/resize/abort/device loss、history 提交、publication 和资源生命周期必须用当前生产入口验证；仅观察这些 owner 存在不能判所有场景通过。Temporal/FSR3 的接线不表示未来 AI Upscaling 已实现。

旧 Phase0–6 不做中间检查的文字已失效。按[当前执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)集中核对单元编译、接线、正确性与成本；完整 browser/质量/性能矩阵在整个 Renderer/providers 完成后进行。

旧阶段与旧状态说明已收回，Git 保留历史。本页只维护已核实 owner/数据流；阶段和每次运行结果不在这里复制。
