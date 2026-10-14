---
id: eengine-ao-functionality-2026-10
state: current
verifies:
  files:
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/index.ts
    - OEngine/src/render/RendererConfig.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program/FrameProgram.ts
    - OEngine/src/render/program/FrameProgramBindings.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/render/ao
    - OEngine/src/shaders/xegtao_preparation.ts
    - OEngine/src/shaders/xegtao_main.ts
    - OEngine/src/shaders/xegtao_denoise.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/render/temporal/NativeTemporalV2.ts
    - OEngine/src/render/passes/fsr3/Fsr3UpscalerRuntime.ts
    - OEngine/src/render/TemporalFabric.ts
    - OEngine/src/debug/RenderDebugView.ts
    - OEngine/src/render/passes/RenderDebugViewPass.ts
    - OEngine/src/shaders/render_debug_view.ts
    - OEngine/src/framegraph/CompiledFrameGraphCache.ts
    - OEngine/src/framegraph/FrameGraph.ts
    - OEngine/tests/contract/frame-program.test.mjs
    - OEngine/tests/contract/xegtao-scalar-product.test.mjs
    - OEngine/tests/oracle/native-surface-production-gpu.mjs
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/main.ts
    - tools/gpu-oracle/registry.mjs
---

# AO 功能完善设计：现有 XeGTAO 的配置、调校与诊断

## 1. 决定与范围

这是[功能粗路线](eengine-feature-expansion-roadmap-2026-10.md)的首个细设计模块，按 `efd62c3f` 的生产代码复查。实际单元状态与结果只读[执行文档](../next-execution/eengine-ao-functionality-execution-2026-10.md)，全局约束沿 [V4 母稿](eengine-v4-native-shading-2026-10.md)。本轮只设计，尚未实现。

继续使用当前完整 scalar XeGTAO：Depth→私有 normal/五级 weighted view-depth→Medium/High Main→edge-aware denoise/最终恢复→R8 visibility→Native diffuse IBL。补齐七项公开设置、AO-only 视图、示例调校和状态恢复；默认保持当前 High/1遍、1m半径/每单位1m、power2.2、固定 noise0 的画面。

不新增 AO temporal/history、bent normal、镜面遮蔽、低分辨率 AO、SSR 基础框架或通用 EffectsManager；不把 AO 私有 depth mip 换成 culling HZB。不扩大为所有 XeGTAO profile 的完整移植声明，支持的 Medium/High scalar 各自保留必要算法。

## 2. 实际接线与需要修改的边界

| 当前事实 | 本模块决定 |
|---|---|
| Renderer 已有公开 `xe_gtao_enabled=true`，FrameProgram 仅 off/scalar-high；半径/尺度/noise 在 Lowering 写死 | 替换为唯一 settings owner，迁移全部实际调用方；保留 noise0，补 Medium 和 denoise 结构需求 |
| 三个 XeGtao pass owner 在 device 初始化创建；Main 的 quality、Denoise 的遍数固定在构造时 | 同一 device 的稳定 owner 保存有限 PSO 变体，图按结构选择，不每次切换 new owner |
| Main 已有 Medium2×双向2步、High3×双向3步；Denoise 已支持0..3 | 暴露已有完整 profile；0 仍执行一次 final pass，不能把 raw AO 当最终值 |
| 当前 uniform80B；最终 scalarTexture 被 Native binding11读取，未消费的 packed pass 被图裁掉 | 共享常量前80B保留，追加16B输出控制；强度只作用于最终输出，继续不新增全屏 pass/binding |
| Native 为 diffuse IBL 乘 screen visibility×material occlusion，coat衰减随后保留；不作用于直接光/镜面IBL | 维持该能量边界，强度不覆盖材质 occlusion，不增加第二次 AO 乘法 |
| 当前 Occlusion debug 表示材质 AO，不能当 XeGTAO 诊断 | 新增独立 AmbientOcclusion 视图，直接看实际有效 screen visibility |
| graph key 已区分 aoProfile，但数值从逐帧 bindings晚绑定；cached graph 捕获 pass owner | 数值不进图/材质 ProgramKey，quality/遍数进结构key，owner不因设置变化失效 |
| recovery checkpoint 目前不保存运行期 AO 开关/设置 | 保存 desired settings 并在 replacement 正常准备前恢复；不靠应用重发 UI 状态 |

## 3. 公开设置与更新语义

新增设备无关 `AmbientOcclusionSettings` 与只读默认值/解析函数，放 `render/ao`，由 index 导出。`RendererConfig.ambientOcclusion` 只提供初始 partial；运行期通过 `renderer.ambientOcclusionSettings` 只读快照和 `setAmbientOcclusionSettings(patch)` 原子更新。接口风格沿现有 VsmSettings，不做通用配置框架。

| 字段 | 默认 | 合法范围与含义 |
|---|---:|---|
| enabled | true | boolean；真实关闭 AO GPU 工作 |
| radiusMeters | 1 | 正有限米数；不能用0冒充启停 |
| metersPerWorldUnit | 1 | 正有限；`radiusWorld = radiusMeters / metersPerWorldUnit`，不是 renderScale |
| strength | 1 | 有限[0,1]；0为无 screen AO，1为完整当前结果；增强外观用独立曲线参数 |
| finalValuePower | 2.2 | 有限[0.5,5]，沿 donor MainPass 原位置执行，不改名冒称线性强度 |
| quality | high | medium/high，对应现有8/18 horizon深度采样；不声称 Low/Ultra 已支持 |
| denoisePasses | 1 | 整数0..3，沿 donor Disabled/Sharp/Medium/Soft 语义 |

未知字段、非法枚举/数字和不能安全表示为 f32 的实际半径/必要派生值，在提交新快照前拒绝；保留旧设置。沿既有 reverse-Z perspective projection/尺度验证，不默默 clamp、不改相机类型。相同 patch 不重复失效；设置允许在 initialize 前保存，不立即触发 GPU API、submit/readback 或新资源。

默认不公开内部 radius multiplier、falloff、sample distribution、thin compensation、mip sampling offset 或 noise phase；它们保留固定 donor 调优值。GUI 可用有限操作范围，但不能悄悄改变 API 值或全场景单位。

**强度定义：** 先完整执行当前 donor filtering、末遍1.5恢复和R8量化，得到 `V`；仅末遍追加 `quantizeR8(1 - strength × (1 - V))`。中间遍、Main 的 power/visibility floor 不改；strength1 保持已有R8结果。它是 EEngine 的输出混合，不伪称 donor 原参数，也不先混 raw AO/edges。最终 scalar 和可选 packed 统一代表有效 visibility，Native 不再另乘 strength。

有效 AO 需求为 `enabled && strength>0 && 有真实lit consumer`。需求为 off 时归一化无关 quality/遍数，使关闭后的参数编辑不制造无用图变体；不强行因为打开 debug 而恢复 AO 工作。此时沿现有中性 visibility1 绑定，材质 occlusion 仍正常生效。

## 4. Producer→产品→消费者与生命周期

设置在一次普通帧准备开始时取得不可变快照，整帧使用同一份；失败或延迟不把未提交状态当作已呈现。`SceneFrameBindings` 携带数值快照，Lowering 的 upload callback 从本帧取 radius/scale/power/strength，禁止闭包捕获首次值。

FrameAoProfile 扩为 off/scalar-medium/scalar-high，并声明0..3的 denoise结构选择。FrameProgram key 包含有效 quality/遍数、既有尺寸/debug；半径、尺度、power、strength不进图key、材质拓扑或 publication identity。绑定检查保证结构匹配。本模块不扩通用 Surface 产品。

三个既有 pass owner 保持设备期稳定：Main 同一LUT/layout提供两个固定PSO；Denoise 提供常规末遍beta1.2、Disabled末遍beta1e4、非末遍beta1.2/5三个固定PSO，按图的遍数选择。沿现有初始化预建这些有限变体，不按任意数值扩缓存；稳定编码不编译 shader，不销毁 cached graph 捕获的 owner。off 只保留这些可复用 device 对象，不分配AO全屏scratch或执行AO dispatch。

`XeGtaoPreparationAbi` 将 uniform80B扩为96B，末尾输出控制vec4存 strength及零填充，前80B数学/偏移不动；CPU pack、共享WGSL、全部pass和必要fixture同一单元切换。`XE_GTAO_PREP_BYTES`为唯一布局来源，不留80/96兼容分支。原有五级FP32、16×16 padded gutter、逻辑floor-halved采样范围和2/4 storage-texture split全部保留。

画面相关设置变化在下一实际AO内容变化帧重置颜色累计，避免调节后拖影；沿既有 TemporalFabric color、Native/FSR reset链处理。**不将AO编辑冒作camera cut，不重置HZB、几何/材质identity、VSM或曝光。** Native Seed 与颜色后端仍须满足既有reset/role合同。desired设置与最后成功提交的有效AO签名分开；abort/defer不提交该签名，retry继续处理必要颜色reset，普通motion与无效no-op设置不重置。off状态的无效数值编辑不改变当前画面。

resize/renderScale沿内部全分辨率尺寸重建图/瞬态，all-unlit/empty取消AO需求；AO没有新history。FrameGraph沿现有提交/fence管理瞬态及池，GPU在途对象不提前销毁。device loss按现有恢复协议重建device对象，重放desired设置，首帧使用正常新epoch invalidity。引擎销毁释放LUT/constants；不增加独立submit、mapping ring、异步scheduler或owner容器。

## 5. 诊断、接入与旧入口退休

增加 `RenderDebugView.AmbientOcclusion`，灰度显示当前有效scalar，白为无遮挡，场景背景/关闭显示中性白。明确区别于现有材质 Occlusion；直接读真实产品，经现有debug→Present bypass输出，不经过曝光/LUT或颜色AA伪造“AO结果”。内部/输出尺寸映射跟随现有debug域。没有AO时明确显示关闭/无lit consumer状态和中性值，不能声称算法已运行；空Scene沿现有clear-present并标注无AO产品，不为debug额外运行AO。

Dungeon 既有AO开关处增加七项设置/只读值与该debug入口，便于实际场景调校。其余示例只迁移实际开关/快照调用，不强制复制一套面板。新设置成为唯一入口后删除 `xe_gtao_enabled` 普通字段，迁移 showcase、plane-cube、zorah、validation、Dungeon、Bistro、生产GPU用例与仍运行的诊断脚本；无兼容别名或第二状态。清理此次触及的旧C阶段/non-production误导注释，退休labs不恢复旧Renderer；仅真实消费者需要更新。

新模块结果完成后才更新domain事实。本轮不修改未来SSR/VT设计，不重做旧C0–C8迁移；旧记录仍为history，旧缺GPU证据等限制不凭本设计改成已通过。

## 6. 必要成本与能力

设内部像素数P，16对齐后的像素Pp，D=max(1,denoisePasses)。下列为逻辑资源/工作上界，FrameGraph可复用，不能冒充物理峰值或帧时预测。

| 成本项 | ADD / 工作边界 |
|---|---|
| 相对当前默认 | uniform仅+16B，有限PSO对象增加；既有16KiB Hilbert LUT只一份；无新全屏texture/history/binding/pass |
| 数值/quality | High18 / Medium8次双侧horizon depth taps，加原有中心/边/normal取样；强度仅末遍少量ALU和R8量化 |
| AO scratch | normal4P、raw+edges2P、denoise输出合计DP、五级weighted depth为4Pp×341/256；未消费的packed继续图裁掉 |
| 1080p例 | 1920×1080、padded1920×1088：D1逻辑合计约24.46MiB，D3约28.41MiB；不含全Renderer、池中/在途/退休/其他尺寸资源 |
| dispatch | normal1+prefilter1+(5-firstMipCount)+Main1+D；storage≥4时D+4，storage=2时D+6；无额外pack consumer时不执行pack |
| denoise取样 | 每遍9次AO点读+5次edges点读，保留中心/四邻/四对角，不能为达到表内成本删对角、边对称或leak步骤 |
| 访问/同步 | 同帧纹理点读、每像素唯一输出，无新增atomics/barriers；阶段依赖交FrameGraph，不新增CPU读回/提交 |
| 能力/最坏情况 | 沿既有tier1、sampled/storage数量、viewport/padding/buffer/dispatch limits；medium不减少分配，D3必要增加2P输出，尺寸或合法容量不满足显式拒绝，无隐藏低质fallback |

ideal为off、逐帧AO工作为零；expected为当前默认High/D1；worst按合法extent与D3、实际池/在途/退休组合计算，不截断像素。启用效果不要求比关闭更快。全局池/在途同时峰值按实际资源账观察，不能把24.46MiB直接当整机AO占用；不扩现有图缓存容量、不增加按设置值增长的资源池。完整组合4GB/FPS/P95仍留最终整合，本模块只检查资源数量、必要ADD与明显失控成本。

## 7. 来源与不简化边界

固定来源：[GameTechDev/XeGTAO](https://github.com/GameTechDev/XeGTAO/tree/a5b1686c7ea37788eeb3576b5be47f7c03db532c)，revision `a5b1686c7ea37788eeb3576b5be47f7c03db532c`，MIT，许可证保留 `render/ao/LICENSE-XeGTAO.txt`。本轮重新读取该revision的 README、XeGTAO.h/hlsli、vaGTAO.hlsl与vaGTAO.cpp的相关资源/调度路径；未运行上游D3D工程，不提升来源adoption。

| Source | 本地映射/必须保留 |
|---|---|
| XeGTAO.h::GTAOSettings/GTAOUpdateConstants | PreparationAbi的reverse-Z/尺度与原调优值；FinalValuePower沿Main原数学位置；新增strength是本地输出混合 |
| vaGTAO.hlsl::CSGTAOMedium/High、SpatioTemporalNoise | Main的2×2/3×3双侧积分、Hilbert/R2、noise0；不删除falloff/薄遮挡分支、mip语义、visibility floor |
| XeGTAO.hlsli::ComputeViewspaceNormal/PrefilterDepths16x16/DepthMIPFilter | 私有深度法线、五级weighted depth、边缘与奇数尺寸；不以box/min-max层级替代 |
| vaGTAO.cpp::Compute、XeGTAO_Denoise/Output | passCount=max(1,D)，beta0模式1e4、非末遍/5、末遍1.5恢复/量化；0不是删final pass，也不是严格零邻域权重 |
| XeGTAO_Denoise | 完整中心/四邻/四对角、对称edges和leak；现有point loads对应HLSL gather footprint，不能减采样冒称平台适配 |

沿用已完成的FP32/reverse-Z、显式point取样与按WebGPU storage限额拆分的执行适配；没有必要步骤的删减。Medium是上游具名较低quality，不是偷偷减少High采样。不存在AO专属时序积累，本阶段继续固定noise0，不仅因为主图有TAA就擅自引入时变噪声。Local/Reference/Adapt边界集中在本文及既有[来源账本R05](../porting/next-renderer.md)，不另建来源流程。

## 8. 退出口径

只设一个完整实现单元，具体清单见执行文。通过少量CPU配置/图合同与一个小型真实GPU生产场景核对设置真正生效、默认不变、Medium/High与0..3未跳必要阶段、尺度、启停/debug、缓存晚绑定和生命周期；不要求完整oracle重跑、长序列画质矩阵或ABBA跑分。实现若触动原积分/过滤数学，补受影响的独立数值验证，不能以减负为由放宽旧断言或省算法。本模块关闭后停在SSR细设计之前。
