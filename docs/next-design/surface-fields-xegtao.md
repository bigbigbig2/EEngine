# Module C 设计：按需 Surface Fields 与 XeGTAO

> 状态：2026-09-27 已完成设计，尚未实施。对应[执行文档](../next-execution/surface-fields-xegtao.md)、[整体架构](./eengine-next-overall-architecture-final-2026.md) §3、[架构层计划](../next-execution/eengine-next-architecture-layer-plan-2026.md) §5 和[来源账本 R05](../porting/next-renderer.md)。以下“当前事实”来自源码；目标和成本假设不是已实现、已测量或已通过画质验收的事实。

## 1. 要解决的问题

Module B 已将 Standard/Coated 材质、Dense/有界异常工作和直接/环境光接到唯一生产 Surface。现在 `FrameProgram` 只认识 Visibility、depth、HZB、Surface HDR/motion 等产物；没有屏幕空间 AO producer，也没有为下游按需交付法线/粗糙度的物理布局。继续简单给 Surface 输出一张全屏法线图，看似实现了 “Surface Field Demand”，却可能增加一次几何或材质求值、全屏写读以及绑定成本，且 XeGTAO 本身并不必然需要这张图。

**本模块目标**：把固定 revision 的 XeGTAO 核心完整移到 WGSL 和唯一 Frame Program 主链，以 Visibility depth 为输入，经过法线准备、视空间深度预滤、horizon 可见性求值和边缘感知降噪，产生被 Standard/Coated 间接光真实消费的 AO；同时让 Frame Program 能表达消费者的语义字段需求及有限物理布局，但只物化当前真实需要跨 pass 复用的值。维持一个 Renderer、一个 frame submit、GPU 内 producer→consumer，不恢复旧 GTAO/SSGI owner。

**性能目标**是减少重复解码、材质贴图采样、sidecar 往返、绑定压力和不必要的全屏 pass；画质目标是接近上游 XeGTAO 的薄遮挡、接触区、远近尺度、稳定边缘和可选方向遮蔽。两者都需最终在目标设备和场景上量测，不能由上游毫秒数据或静态 pass 数推断。

本模块不实施 SSSR/GI/VSM、完整 Temporal Fabric、全局光照 AO、多材质全场 GBuffer、通用自动成本模型或正式画质/性能声明。后续 SSSR/GI 若提出真正的 Normal/Roughness 复用需求，再选有限 Surface sidecar。现有 FSR3 生产链继续接收 Surface HDR/motion；Module D 负责统一时序事实和呈现生命周期。

## 2. 当前源码主链与耦合

| 已核对事实（2026-09-27） | Module C 的含义 |
| --- | --- |
| `OEngine/src/render/program/FrameProgram.ts` 的 `FrameProduct`/`FrameProgramStage` 无 AO 或 surface normal；`dependencies()` 将 `surface-radiance` 直接连到 Visibility/meshlet/depth/cluster | 新 AO 必须成为有 producer、consumer、domain、invalid 值的真实语义产物，而不是 Lowering 中没有 Frame Program fact 的隐藏 Pass |
| `FrameProgramLowering.ts::compileSceneGraph` 在 Visibility/HZB/cluster 后调用 `SurfaceMaterialPass.addToGraph()`，再进入 Sky/Aerial/FSR3/Present | AO 可以插在 Surface 前，由同一 Graph 管理依赖；Lighting consumer 仍是唯一 Surface HDR writer |
| `SurfaceMaterialPass.ts` 的频率 planner → Dense + 七条异常 lane 写 `rgba16float` HDR、`rg16float` motion；`surface_material_kernel.ts::sparse_direct` 在一次返回值中合并直接光、PhysicalSun、环境漫反射/镜面与 emissive | AO 不能后乘完整 HDR；要在内部间接项的位置读 AO，且 Dense/Binned/fallback 使用同一规则 |
| `shading_frequency.ts::frequency_eligible` 目前只允许特定静态 opaque Unlit factor/1×1 texture 粗频；lit 与 Coated 均为 full rate | 当前 AO 不会因受光 2×2/4×4 代表点复制而丢失接触变化；将来扩展 lit 粗频时，必须重新纳入 AO 变化或改成逐像素间接组合 |
| `SurfaceKernelBindingPlan.ts` 最宽 lit/VG 布局有 16 sampled textures、15 storage buffers、2 storage textures；`PhysicalSamplingProfile.ts` admission 至少要求 16/16/2 | 在最宽布局直接加 AO sampled texture 将到 17，不能只追加一个 binding；第 16 个 storage buffer 是当前可行但需核对的输出消费槽 |
| `RenderTargets.ts` 的 depth 为 reverse-Z `depth32float`；`HierarchicalZBuffer.ts` 的 HZB 为 `rg16float` 深度范围 | XeGTAO 的视空间加权过滤 depth mip 是另一种语义，不共享/重命名 HZB |
| `RenderSettings.ts` 仍有旧 Three.js GTAO/SSGI 设置；`shaders/gtao.ts` 留有旧 WGSL，但 Frame Program 没有旧 AO stage | 这些是迁移对照或待清理代码，不等于当前生产 AO；不可重新挂回并宣称 XeGTAO 移植 |

路径 owner：Visibility 提供 hit/depth；shading 拥有 XeGTAO provider、Surface 需求编译和间接能量组合；frame-runtime 拥有 Frame Program/Graph 顺序与唯一提交；environment 提供 sky/IBL 辐亮度；materials-textures 提供 glTF AO 与材质 generation。Renderer 只是 composition root，不把 XeGTAO 数学塞进 `RendererCore.ts`。当前 `vibe context` 对 `render/program/**` 仍落到 platform 兜底，拟新增 `render/ao/**` 也尚无专门路由；实施时分别补到 frame-runtime 与 shading 的 domain manifest，让导航结果与职责一致。

## 3. 固定来源与取舍

完整开源实现先于论文/文章核对。选定 [GameTechDev/XeGTAO `a5b1686c7ea37788eeb3576b5be47f7c03db532c`](https://github.com/GameTechDev/XeGTAO/tree/a5b1686c7ea37788eeb3576b5be47f7c03db532c)，MIT，仓库 archived；`Source/Rendering/Shaders/XeGTAO.hlsli` 是核心数学，`XeGTAO.h` 是常量/参数，`vaGTAO.hlsl` 是 shader 入口，`Source/Rendering/Effects/vaGTAO.cpp` 是资源格式和调用顺序。作为原理对照，使用 [Jimenez 等 GTAO 论文](https://www.activision.com/cdn/research/Practical_Real_Time_Strategies_for_Accurate_Indirect_Occlusion_NEW%20VERSION_COLOR.pdf)、XeGTAO [README](https://github.com/GameTechDev/XeGTAO/blob/a5b1686c7ea37788eeb3576b5be47f7c03db532c/README.md) 的差异与性能说明、[Scalable Ambient Obscurance](https://research.nvidia.com/sites/default/files/pubs/2012-06_Scalable-Ambient-Obscurance/McGuire12SAO.pdf) 的 depth-mip 背景。详尽逐项映射与 adoption 条件见[账本 R05](../porting/next-renderer.md)。

替代完整 donor [AMD FidelityFX CACAO `0ddca95e6714727a252ead345591ca8f2598f261`](https://github.com/GPUOpen-Effects/FidelityFX-CACAO/tree/0ddca95e6714727a252ead345591ca8f2598f261)，MIT；其 `ffx-cacao/src/ffx_cacao.hlsl` 和 `ffx_cacao_impl.cpp` 包含 depth/normal 准备、四路 deinterleave、adaptive importance、blur、apply/上采样，是有效的替代 AO 家族。它增加资源/阶段/调度复杂度，与本模块希望首先闭合的单一 AO 主链不匹配；不拼接 CACAO 的 adaptive 阶段到 XeGTAO 后仍宣称完整 XeGTAO。当前旧 [Three.js GTAO](https://github.com/mrdoob/three.js/blob/148ef33ecb6d2502ff796d4554abd1549c95d519/examples/jsm/tsl/display/GTAONode.js) 仅作数值/历史对照。Filament 固定来源的 `surface_ambient_occlusion.fs` 用于间接光 AO 组合，不是 XeGTAO 遮蔽求值的 donor。

XeGTAO README 的 full-resolution High 为 3 slices × 每 slice 双向 3 steps，即 18 depth taps；Medium 为 2×双向 2，即 8 taps。其空间降噪是 5×5 edge-aware；它**没有自带完整时间重投影降噪**。README 的 RTX 3070/2060/iGPU 毫秒数只代表上游原生测试，不能填入 EEngine 的 WebGPU 性能预算。Bent normal 增加约 25% 成本也只是上游自述，需本地量测。

### 3.1 源函数/阶段 → 本地产物/阶段

下表右侧均为**拟新增产物**，不是当前已存在的代码。

| 固定 XeGTAO 源入口 | 本地目标 | 保留的输入、输出和关键分支 |
| --- | --- | --- |
| `XeGTAO.h::GTAOUpdateConstants`、`XeGTAO.hlsli::XeGTAO_ScreenSpaceToViewSpaceDepth` | `XeGtaoConstants` / depth projection oracle | 从本项目 reverse-Z 投影与尺寸构造 `DepthUnpackConsts`、`NDCToViewMul/Add`、世界半径；透视/无限远/奇数尺寸与背景深度不得借用正向 Z 常数 |
| `XeGTAO.hlsli::XeGTAO_ComputeViewspaceNormal`、`vaGTAO.hlsl::CSGenerateNormals` | depth → view-space normal scratch | 四邻深度/斜率边缘权重/视空间位置；独立法线 pass 是上游默认主链，`XE_GTAO_GENERATE_NORMALS_INPLACE` 是有精度代价的明确变体；不以材质 normal map 冒充几何遮蔽法线 |
| `XeGTAO_PrefilterDepths16x16`、`XeGTAO_DepthMIPFilter` | raw depth → 五级 view-space weighted depth pyramid | 16×16 区域、工作组共享内存、由最远样本深度和 effect radius/falloff 计算加权值；不是 min/max HZB。WebGPU 若不能同 stage 绑定五个 storage mip，按实际 storage-texture limit 分批生产后续 mip，过滤公式不变 |
| `vaGTAO.hlsl::SpatioTemporalNoise`、`XeGTAO_MainPass` | depth pyramid + normal → raw AO + packed edges | Hilbert/R2 的 64×64 空间序列、条件性 `NoiseIndex`、slice/horizon 双向采样、LOD、半径/薄遮挡、near-field falloff、edge 输出、power 与可见性下限；High/Medium 是各自完整 profile，不把 18 taps 悄悄缩到 4 taps |
| `XeGTAO_MainPass` 的 `XE_GTAO_COMPUTE_BENT_NORMALS` 与 `XeGTAO_EncodeVisibilityBentNormal` | directional profile：raw AO + bent normal | 保留同一 horizon 积分产生的方向、编码/解码与 denoiser 联动；不开启时明确为 scalar profile，不能把 shading normal 假称 bent normal |
| `XeGTAO_Denoise`、`vaGTAO.cpp::Compute` 的 `DenoisePasses` | raw AO/edges → 最终 `indirect-visibility` | 5×5 edge-aware 权重、ping-pong、最终 `XE_GTAO_OCCLUSION_TERM_SCALE=1.5` 恢复、passCount 至少一次；WebGPU 输出可改为 bit-packed buffer，数值/邻域和边界不删减 |
| `vaGTAO.cpp::Compute` 的调用顺序 | Frame Program AO owner | GenerateNormals（仅 depth-normal profile）→ Prefilter → Main → Denoise → Surface；Graph 资源读写边和一个 frame submit。原生 DX descriptor/barrier 类不移植 |

默认 tuned 常量不能因 WebGPU 改写丢失：radius multiplier 1.457、falloff 0.615、sample distribution power 2、thin occluder compensation 0、final power 2.2、depth MIP sampling offset 3.30，以及预降噪可见性 scale 1.5。开发时可暴露具名参数，但默认 profile 与源码对照，并说明改变常量造成的画质/带宽权衡。原 README 部分文字保留旧数值，固定源码 `XeGTAO.h` 是本设计默认值依据。

## 4. 语义需求：AO 并不强迫 Surface 法线 sidecar

XeGTAO 源支持 depth + **可选** screen-space normal。其默认集成在没有外部 normal 时，从原始深度单独生成视空间 normal；也保留在 MainPass 就地生成的宏路径，但源码指出 FP16 working depth 会导致可见降质。EEngine 当前 Visibility depth 已可供此路径使用。因此第一真实需求应是：

| 字段 | Producer / consumer | 语义与物理化 |
| --- | --- | --- |
| reverse-Z depth | Visibility → XeGTAO、Surface、FSR3 | internal-full `depth32float`，背景为 depth clear；现有事实，不能当作 view-space pyramid |
| XeGTAO working normal | XeGTAO normal stage → MainPass | internal-full view-space 几何尺度 unit normal，过渡资源；与材质 shading normal、coat normal 分开，生命周期止于 AO MainPass |
| weighted view depth mip 0–4 | XeGTAO prefilter → MainPass | positive view depth；半径/过滤语义由 donor 固定；仅 AO scratch，不能暴露为通用 HZB |
| indirect-visibility | XeGTAO denoise → Surface 间接光 | internal-full 标量 `[0,1]`、可选 bent normal；非辐亮度、不预曝光、不用于直接光；无效/背景中性 visibility=1 |
| Surface geometric/shading normal、roughness | 当前 Surface 寄存器；未来 SSSR/GI 可要求跨 pass 复用 | 本模块没有确定的跨 pass 消费者，不分配全屏 sidecar；需求类型、空间和候选有限布局可以先定义，不制造空 producer |

`Surface Field Demand` 应从**具体 consumer** 反向闭包到 producer，记录字段名、空间、精度、domain、缺失值、身份/generation 和重算成本，再降低为**有限**物理方案：`RegisterOnly/Fused`、`AO-only visibility`、以后确需的 `CompactNormalRoughness` 等。语义字段数不等于纹理数；当前只能将前两种实际接主图。将来同一帧不同工作 lane 可既融合光照又输出少量 sidecar，但不能为了证明架构先并行保留两套完全独立的 Surface Lighting 生产路径。

当前整体架构中的 “GTAO needs Normal” 应解读为算法的视空间法线输入，**来源可以是 XeGTAO 自己的 depth-normal stage**。执行计划里“先同时建立完整 fused 与全 materialized 两种 topology”不适合用 XeGTAO 来证明性能收益：后者没有真实的材质字段消费。Module C 先让需求编译/布局选择具备扩展点，且以真实 AO producer→Lighting consumer 闭合；SSSR 到来时再比较几何/材质重建与 sidecar 往返，并决定实际混合布局。

## 5. 单生产路径的 GPU 数据流

```text
Frame Program: AO enabled only when lit opaque/Masked indirect consumer exists
  VisibilityKey + reverse-Z depth ────────┬───────────────→ Surface work/identity
                                          │
                                          ▼
                               XeGTAO depth-normal stage
                                          │ view-space geometric normal
                                          ├──→ MainPass
  reverse-Z depth → weighted view-depth mips 0..4 ────────┘
                                          │ raw AO + edge (+ optional bent)
                                          ▼
                                  edge-aware denoise
                                          │ indirect-visibility
                    ┌─────────────────────┴─────────────────────┐
                    ▼                                           ▼
            Dense Standard lighting                  Binned/overflow Coated lighting
            direct + Sun unchanged                    direct + Sun unchanged
            indirect diffuse/specular × visibility    base/coat indirect × visibility
                    └─────────────────────┬─────────────────────┘
                                          ▼
                                 one HDR/motion writer domain
                                          ▼
                                  Sky/Aerial → FSR3 → Present
```

AO owner 的内部 normal、depth mip、raw、edges 和 ping-pong 是 Graph transient 资源，只把最终 AO 声明为 Frame Program 跨 owner 产物。`hasLit=false`、AO 显式 off 或空场景时，不创建无消费者的 AO Graph work；Surface 使用中性可见性 `1` 的静态 shader 路径。AO Profile（off/scalar/directional）、尺寸、格式/布局能力是结构性 key；NoiseIndex、frameIndex、投影常数、resource generation、场景内容和值不是结构性 key。Resize/device epoch 可重建资源和 pipeline；不能因当前帧 GPU AO 统计回读再改变本帧 topology。

## 6. WebGPU 资源布局与绑定预算

### 6.1 最宽 Surface 的物理瓶颈

当前九个 texture bank + VisibilityKey/depth/frequency plan + 四个环境纹理恰好占 **16 sampled texture**；最宽 VG/lit Shader 占 **15 storage buffers**，设备 admission 至少要 16。直接把 AO `texture_2d` 塞进 Surface 会要求第 17 个 sampled slot，在当前 profile 不合法。不能靠“WebGPU 2026 新特性”默认拥有 bindless、无限 texture 数或 read-only storage texture。

选定的首版物理候选：最终 scalar AO 每四个 8-bit visibility 打包到一个 `u32` storage buffer；directional AO 将 bent normal + visibility 打包成每像素一个 `u32`，按照 XeGTAO 编解码规则核对。Surface 增加一个 `read-only-storage` binding，使最宽布局达到 16 storage buffers；Dense/Binned/fallback 都从像素坐标解析 AO。Denoiser 的 GPU 输出可以直接按四像素组写一个字，避免相邻线程对同一字竞争；若这种组织损害源邻域计算或寄存器成本，可先使用中间纹理加一次受控 GPU pack，再做局部性能比较。任何路径都不能要求 CPU 当帧 readback。

这是一项**待量测的物理布局选择**，不是已证明最快。若后续证据表明纹理采样更优，先从实际 texture bank mask/环境 LUT 布局释放一个 sampled slot，再选择 AO texture variant；不得默默减少合法材质 bank 或丢失 IBL。一个单独的后乘 HDR Pass 会迫使 direct/indirect 拆写或错误乘光，只能作为真正拆分 Lighting 时的另一物理方案，不能作为当前捷径。

### 6.2 XeGTAO 自身资源

上游 `PrefilterDepths16x16` 单 dispatch 写五个 storage mip view。EEngine 当前 Surface preflight 只保证两张 storage texture 的别处布局预算，**不能推断 AO stage 可绑定五张**。AO owner 单独协商自己的 `maxStorageTexturesPerShaderStage`：若至少四张，可先写 mip 0–3、第二 dispatch 从 mip3 用同一 `XeGTAO_DepthMIPFilter` 写 mip4；若只容两张，则继续按有界批次拆分，每级从已完成的前级过滤。若设备允许五个目标，再比较一个 dispatch 的等价特化。每种拆分都需 oracle 核对中间格式量化与边缘值；所有 dispatch 仍在 `FrameCoordinator` 的同一命令流和 submit 中。

质量档优先以 `r32float` 存 view depth：上游指出“就地法线 + FP16 working depth”会明显降质。`r16float` 只能作为量测后具名压缩档，并保留深度偏置、视距范围和失效条件。可选 normal 可用 packed `r32uint`；raw AO、edges、final 的 `r8uint`/`r8unorm` 等小格式须按目标 WebGPU 设备的 texture format/usage 能力实际 preflight；无法合法写入时改用 `r32uint` 或 packed buffer，但不删 donor 算法阶段。`r32float` depth 的点采样/四邻 gather 可用合法 WGSL texel load/显式 LOD 适配，保留上游 point-clamp 地址、LOD 与边界语义，不依赖未经协商的 float32 filtering。

静态容量粗估：4K 视空间 `r32float` 五级 mip 约 44 MB；三个全分辨率 8-bit AO/edge/final 面各约 8.3 MB；单独 `r32uint` normal 再增约 33 MB。实际峰值取决于 lifetime/alias、工作格式与 directional 档；这些数字**不是带宽或 GPU 时间实测**。优化应看 full-frame XeGTAO+Surface+FSR3 总成本，不能只看 MainPass 毫秒数。重复法线/材质求值、extra pass、binding 与 transient 存储要一起比较。

### 6.3 可复核的容量与总成本判断

下表是按十进制 MB、完整内部渲染分辨率计算的**单份资源容量**，不含读写重复、压缩、对齐、Graph alias 和 history；实际 FSR3 内部分辨率应代入当帧尺寸重新算。

| 资源形状 | 1920×1080 | 3840×2160 | 设计判断 |
| --- | ---: | ---: | --- |
| `r32float` 五级 view-depth mip（约 `4/3 × pixels × 4 B`） | 11.1 MB | 44.2 MB | 画质档基线；它是 AO 特定 weighted pyramid，不能拿 HZB 免费复用 |
| 一张 `r8` raw AO 或 edge/final 面 | 2.1 MB | 8.3 MB | raw、edge、final 在 denoise 时至少有同时存活的读写面 |
| AO 私有 `r32uint` normal 或 directional final | 8.3 MB | 33.2 MB | bent normal/profile 或独立法线的额外成本，不能视为零 |
| 一个全屏 4 B/pixel Surface normal/roughness sidecar | 8.3 MB | 33.2 MB | 除容量还要计 producer 写、每个 consumer 读和可能的第二次 reconstruction |

上游单 dispatch prefilter 写五个 mip；WebGPU AO owner 若只允许四个 storage 输出，预滤至少两个 dispatch，若只允许两个则可能三次。加独立 normal、MainPass 和单遍 denoise，当前选中链静态约为 4–6 次 compute dispatch；多遍 denoise再增加 ping-pong。这里仅用于规划 command 与资源开销，不是已测 GPU 时长，也不允许为了压低 pass 数删掉 weighted filter 或 5×5 denoise。若以后 SSSR/GI 需要 normal/roughness，比较同一场景的 `重复重建+重复材质采样` 与 `字段 producer 增量+sidecar 写+所有 consumer 读+占用率/绑定变化`；比较对象是整帧 GPU 成本和画质，而不是单个 Pass 名称。

## 7. 投影、边界、时间与质量档

- **投影**：从本项目 reverse-Z `depth32float` 和真实投影构造上游 `DepthUnpackConsts`；透视/无限 far、near/far 极端值、像素中心/Y 方向、off-screen/背景 clamp 必须数值对照。`EffectRadius` 是 view/world 长度，不是屏幕像素或 arbitrary LUT 单位；若 UI 使用米，依 `metersPerWorldUnit` 转换一次。
- **几何法线**：优先照上游单独从 raw depth 生成，保留边缘斜率选择。几何法线只解释遮蔽表面朝向；normal map/shading normal 继续用于 BSDF。遮挡远处采样必须经 donor 的 mip 与薄物体分支，而非直接用现有 HZB。
- **有效域**：Visibility 无命中、天空和裁剪外像素给中性 AO，不能把清屏值解释为近处实体；被拒绝或 generation 不匹配的 Surface hit 仍按现有 fail-visible 路径显示错误，不让 AO 掩盖身份故障。Masked 在 Visibility 真实覆盖处参与；透明/头发另有 composition domain，不套 opaque AO。
- **时序**：XeGTAO README 明确靠空间降噪 + 外部 TAA。当可靠的 FSR3/Temporal history 事实尚未建立时，`NoiseIndex=0` 是上游条件允许的稳定空间模式；启用时序噪声后使用上游 Hilbert/R2 与 `%64` 步进。不能把 FSR3 当成 XeGTAO 自带 reprojection，也不在 Module C 造一套同名近似时域 denoiser。
- **档位**：首选 High scalar（18 taps）建立完整闭环；directional 高画质档保留 bent normal 积分、打包和消费；Medium scalar（8 taps）为有名字的较低成本完整 donor profile。分辨率/format、是否启用方向输出必须明确写在 profile 中，不能在相同名称下悄悄降采样。Ultra 如实施，按上游 9 slices × 双向 3 steps 与所有分支核对，不因未实施就宣称全档位已 port。

## 8. 间接能量与未来 provider 交界

在 Surface 内保留 `L_direct`（cluster + PhysicalSun）、`L_indirectDiffuse`（sky/未来 GI）、`L_indirectSpecular`（env/未来 SSSR）、`L_emissive` 的内部语义分项，只在需要间接可见性的位置注入 AO，再统一预曝光写 HDR。现在的 `material.occlusion = surface.material_ao` 不能在添加 Xe 后简单改成 `materialAO * xeAO` 并宣称物理正确：两者可能描述重叠的凹槽。Module C 首版以 `min(materialAO, xeAO)` 作为避免双重压暗的**本地合成政策**，保留 glTF occlusion strength；这个政策需在最终场景画质比较中核对，并非 XeGTAO 算法移植内容。

`L_direct`、PhysicalSun 和 emissive 均不受 XeGTAO 乘暗；VSM 以后仅提供某光源的直接可见性。环境漫反射使用合成 scalar visibility；环境镜面与 clearcoat 用当前 Filament-derived cone/cap specular AO，directional 档传入真实 bent normal，scalar 档明确以 shading/coat normal 作无 bent 的 cone 近似，不能称后者为 XeGTAO bent 输出。未来 SSSR 替换 env specular 时，其已可见反射不可再乘一遍 AO；GI provider 必须声明输出是否已遮蔽、是 total indirect 还是 delta indirect，避免 sky/GI 与 AO 双重计能。

## 9. 取舍、风险与观察点

| 方案 | 优点 | 代价和本轮决定 |
| --- | --- | --- |
| Depth-normal XeGTAO → fused Surface Lighting | 无第二次材质/几何解码，不新增全屏 Surface normal sidecar，AO 先于间接光 | 需 AO 独立 normal/depth scratch、绑定解决；选为首版真实生产主链 |
| VisibilityKey 重建 geometry normal → XeGTAO | 对薄几何或深度边缘可能有更好法线；也可为 SSSR 复用 | 需一次 GPU 几何属性重建、normal 写读和身份/覆盖语义；当前无已证实收益，不作为默认 |
| Full materialized Surface Fields → delayed Lighting | 多个下游反复使用 normal/roughness/closure 时可能省重复采样 | 当前 XeGTAO 不消费材质字段，额外全屏带宽没有被抵消；留给 SSSR/GI 真需求和成本比较 |
| CACAO 整套替代 | 完整 adaptive SSAO donor，可选半分辨率/上采样策略 | 大量 deinterleave/importance/blur 资源及调度；本轮不引入第二 AO owner，也不混搭其核心阶段 |

模块 C 实施前仍需确认：目标 WebGPU runtime 的 R8 格式 storage 能力和同纹理多 mip view 绑定规则；`r32float` 深度 LOD/point-clamp 的 WGSL 等价写法；packed buffer vs 缩窄 texture bank 的局部 GPU 成本；glTF AO 与 XeGTAO 的场景组合画质；FSR3 对开启/关闭 64 帧噪声序列的响应。除非法定资源无法创建或 WGSL 无法合法表达 source 核心，未知的最终成本不阻止编码；不可用时选择具名合法物理布局并记录真实降级条件。

## 10. 完成边界与文档角色

完成 Module C 意味着：固定 XeGTAO selected profile 的法线/预滤/求值/降噪在唯一 Graph 中有真实 GPU producer，最终 AO 在 Standard/Coated 间接漫反射和镜面消费，关闭时完全裁剪，原有直接光/emissive/天空有效域不被误乘；Surface field planner 仅物化真实需求且绑定预算合法；旧 GTAO 不回到 production；FrameCoordinator 仍只 submit 一次。WGSL/CPU oracle、source stage 核对和生产 GPU 消费是**来源采用状态**的条件；模块工程闭合时未齐的项如实标缺，不以 formal evidence/claim 阻断下个大模块。集中 typecheck、build、必要 targeted tests 后更新 workstream，随即进入 Module D。

浏览器矩阵、resize/camera cut/device loss 系统组合、材质/场景/效果交互、最终画质、GPU P50/P95、formal evidence/claims 均在整个 Next Renderer 完成后集中开展。设计文档用于架构导航和实现取舍，不是逐批编码许可。
