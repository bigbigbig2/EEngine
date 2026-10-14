---
id: frame-runtime
kind: domain
owner: frame-runtime
state: current
verifies:
  files:
    - OEngine/src/render/FrameCoordinator.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/render/lighting/FinalPixelLightingPublication.ts
    - OEngine/src/gpu/GpuVsmFilterAbi.ts
    - OEngine/src/render/vsm/VsmFilterNoise.ts
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
    - OEngine/src/render/environment/PhysicalSkyIblResources.ts
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/frame-pacing.ts
    - OEngine/src/render/program/FrameProgram.ts
    - OEngine/src/render/RendererConfig.ts
    - OEngine/src/render/ao/AmbientOcclusionSettings.ts
    - OEngine/src/render/DynamicResolutionScaling.ts
    - OEngine/src/render/RenderFeatureRegistry.ts
    - OEngine/src/render/surface/SurfacePresentPass.ts
    - OEngine/src/render/surface/DisplayColorGrading.ts
    - OEngine/src/render/passes/SharedColorPyramidPass.ts
    - OEngine/src/render/passes/ColorGradingPass.ts
    - OEngine/src/render/passes/MotionBlurPass.ts
---

# Frame Runtime

## 当前源码接线

2026-10-13：VSM圆盘滤波的完整64相位STBN及256-entry旋转表存于FinalPixelLighting buffer的不可变tail，复用现有binding；每个fenced allocation创建时上传一次，稳定帧不复制该段。Native采样constants发布当前tail word offset与提交frame相位；AA-off固定相位零。point/gather/零半径/无VSM不分配噪声GPU段；最多3份1,050,624B段，prepare/abort/retry/模式切换/resize/empty/device loss/最后consumer fence退休由共享物理owner闭合。Loader只保留CPU资产，不持有GPU对象。

核对日期：2026-10-14，底座复查基线`2caf5fe2`，本日AO增量见下文。这里记录当前owner与主链注册；实际验证结果及阶段状态只在对应模块执行计划。

[RendererCore](../../OEngine/src/render/pipeline/RendererCore.ts) 创建 FrameCoordinator、SurfaceV4、LocalLightWorkGenerator、NativeTemporalSeed 等长期 owners。[FrameProgramLowering](../../OEngine/src/render/program/FrameProgramLowering.ts) 将场景产品逐帧绑定到缓存 FrameGraph，连接最终 winner/depth→LocalLightWork→native Surface→Temporal/FSR3。

FrameProgram的实际stage/product及lowering决定当前功能依赖；独立RenderFeatureRegistry类没有进入这条生产选择链。Renderer以显式renderScale改变内部尺寸并选择Native/FSR域，DynamicResolutionScaling类未接入实际反馈控制。SSR/GI/透明/局部体积效果没有当前生产stage；仅存在数据owner、reference或debug名字不算接入。

2026-10-14：AO设置是Renderer设备无关desired快照，普通帧捕获后通过SceneFrameBindings晚绑定；图key仅增加有效quality/denoise，off归一化。实际AO内容签名与最后成功submit的签名分开，变化只失效color/当前颜色后端，不标camera cut、不动Seed identity/HZB/VSM/曝光；abort/defer不提交新签名，retry仍处理颜色reset。empty成功提交清空AO签名，unlit不要求AO工作；device recovery checkpoint保存运行期七项设置，replacement首次准备前恢复。无新history、owner容器或独立submit。具体验证范围只读[AO执行](../next-execution/eengine-ao-functionality-execution-2026-10.md#5-ao-1-实施与核对2026-10-14)。

`SurfacePresentPass` 已在当前主图消费 DisplayColorGrading 生成的 SDR/HDR LUT、GT7 与曝光/去预曝光比例；内部 setGrade 可重建 LUT，但 RendererConfig 未提供对应完整公开调色设置。旧独立 ColorGradingPass、MotionBlurPass 与 SharedColorPyramidPass 没有当前生产调度；不能从独立 ColorGradingPass 未调度推断现行显示没有调色/色调映射，也不能从旧 color pyramid 存在推断 SSR/SSGI 已有可直接消费的颜色版本。

Directional VSM 只服务 Physical Sun；初始化关闭 PhysicalEnvironment 时不创建 VSM 资源或 pass owners，无 Physical Sun 的 enabled shadow Frame Program 被拒绝。无 authored/physical IBL 时，Surface 按需提供共享 1×1 RGBA16F 零辐射绑定，authored directional/local lights 仍执行完整 lit 路径。

[FrameCoordinator](../../OEngine/src/render/FrameCoordinator.ts) 持有当前 command context，通过 submitFrame 的 command.finish 收口提交，并依据 gpuDone 退役 inFlight。canBeginFrame 限制未完成帧数量；这是 GPU completion 背压，不是读取本帧 visibility/work 后由 CPU 决策。

Geometry、native Material publication、LocalLightWork、Surface、VSM 与后处理注册同一个 graph。各 pass 消费显式产品，不拥有独立 frame submit。LightDatabase 仍归 Scene environment，generator 只拥有自己的 frame allocation；提交后按真实 gpuDone fence 复用或销毁，abort 不推进产品历史，device loss 退休旧 epoch。

Final Pixel Shadow 主链由 VSM post-content publication 直接写 FinalPixelLighting container 的descriptor区间，PhysicalEnvironment发布原half Solar LUT，LocalLightWork直接写lookup区间；Native只读最后resource version。物理container由独立 `FinalPixelLightingPublication` 负责3个有界 frame allocation、abort/fence/epoch和显存记账，三种逻辑producer各自保留owner。Native单次几何恢复后完成原point-PCF与Sun；独立Shadow Resolve、ShadowVisibility、Sun continuation和第二HDR已删除。Native 在已有 winner/position/instance/material facts 时写 Seed rgba32float、response rgba8unorm 与完整 identity rgba32uint；NativeTemporalSeed 管理 identity pair、camera/jitter、commit/abort/fence/epoch。Native 1:1由 NativeTemporalV2 直接消费 Seed/response/exact identity，并管理 color/depth/luma/confidence/exposure histories；正常 Native 图没有独立 Seed classification。classification仅服务 upscale 和必要 debug；AA-off由完整Surface writer证明identity提交，不执行无consumer分类；空场景成功提交后，两种color backend按最后consumer fence退休；旧 Facts/Aux、material versions、旧 T3 owner 已删除。质量和成本资格只读 V5 execution authority。

`GpuRadiometryPass` 独立持有曝光双槽和有效性：颜色/TAA reset、resize、Sun/Sky edit、camera cut 不重置曝光，commit 换槽，abort 保留，device epoch 初始化与 `resetExposure()` 显式重置。主链保留 P(n−1) render→去预曝光 HDR histogram→percentile/highlight/log adaptation→E(n)，FSR 先读旧两槽，Presentation 再使用 E/P。常规帧没有 CPU 读回；`readExposureDiagnostics()` 是调用者主动请求的单次 32B readback，不能驱动 frame work。

`RendererCore`按两轴实际尺寸选择唯一颜色 writer：Native 1:1为 Measure→Exposure→Shading Pyramid→半域Shading Change→Analyze→Resolve→RCAS；true upscale为原 FSR3 graph；bypass不写color history。Measure以32×32 tile/128lane合作读取34×34 Seed深度halo，Exposure按原顺序完成64×64归约及half边界。Shading Pyramid一次计算源差异并归约2/4/8尺度，半域producer写R8产品供Analyze filtered读取；原Analyze内联四邻域/三个尺度的重复查询已删除。Native previous-depth pull不分配reconstructed-depth buffer、不clear/scatter，不重建Geometry。必要统计由Temporal owner持有；新增R8和log tiles属于FrameGraph transient，不新增history。inactive domain在replacement成功submit后按最后fence退休，abort恢复上一提交角色/validity/jitter；不是同时运行两套Native路径。

两域都只写本帧RGBA16F color history（RGB与SDK alpha lock），RCAS读取`builder.write(currentHistory)`的写版本，仅使用RGB并输出alpha1，不声明重复upscaled color临时纹理。两域各自owner管理color/luma/luma-history/confidence/frame-info双槽与prepare/commit/abort/resize/fence，Native额外拥有raw depth pair；TemporalFabric协调同一提交事务；只有成功submit后commit换槽。policy切换重置history并推进generation，abort恢复原policy/index/generation/jitter。普通camera motion不reset，defer不推进history；源码切换不证明整帧性能已验收。

成功 empty submit 退休 Surface scene working set、Seed、两个颜色后端及 lighting frame pools；成功 all-unlit submit 退休 local-light 与 final-lighting frame pools。提交失败不释放旧场景；已提交资源等最后使用 fence，返回场景重新生成 Seed validity。Surface neutral bindings、owner/pipeline 与 VSM residency 保留各自寿命。Native V2、FSR 和 Seed 的 actual/candidate/retiring bytes 进入 GraphicsContext 共用资源账本；资源 destroy 后撤账，API 全 owner 同时峰值由验证观察器另核，常规生产无该观察器。

## 原则与验证边界

`PhysicalSkyIblResources`保留最近4组不可变天空IBL，身份来自完整producer f32 uniform位、LUT view和sampler；新探针仍执行完整原卷积，返回命中只暂存同资源。commit推进active/LRU，abort保留旧角色，淘汰按覆盖旧使用的提交fence销毁。Dungeon宿主interactive只对已延期的RAF在GPU ready时重试已更新相机状态，成功后重复ready不再提交；输入仍只在RAF消费，FrameCoordinator在途上限不变。实际质量/成本和追加单元状态只读V5执行§8.2。

唯一生产路径、禁止本帧 GPU→CPU→GPU work control、producer 与直接 consumer 同单元切换，继续由根规则和[当前设计](../next-design/eengine-v4-native-shading-2026-10.md)约束。

camera cut/resize/abort/device loss、history 提交、publication 和资源生命周期必须用当前生产入口验证；仅观察这些 owner 存在不能判所有场景通过。Temporal/FSR3 的接线不表示未来 AI Upscaling 已实现。

当前总体/模块计划从workstream导航。单元集中核对编译、接线、正确性、实际画面、资源边界与必要成本；完整browser/质量/性能矩阵在功能组合稳定后集中进行。旧V5正式性能资格保留未完成，不是所有新效果的统一启动前置。

旧阶段与旧状态说明已收回，Git 保留历史。本页只维护已核实 owner/数据流；阶段和每次运行结果不在这里复制。
