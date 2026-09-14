# ADR-0015 — Visibility-Native PBR Receiver & Lighting Pipeline

> **Status:** proposed；推荐的重构设计，尚未实现或证明性能收益。
> **Date:** 2026-09-15
> **Source revision:** `2337eb05853a253c9ac429cc2c29f0510982ac0f`
> **Scope:** 基础 opaque PBR 的像素成本、着色调度、属性重建、材质访问与环境光数据流；高级效果的依赖边界。
> **Supersedes on adoption:** [ADR-0013](./0013-sparse-shading-bin-pipeline.md) 对所有 opaque publication 强制执行 classifier/queue 的物理要求，以及基础 IBL 必须经过 Surface → provider → lighting resolve 的组织方式。
> **Preserves:** Hardware Visibility、VisibilityKey、Packed Instances、单次完整材质求值、统一主管线、真实高级效果语义与提交感知的资源生命周期。
> **Iteration policy:** 本次按用户要求采用轻量自动检查、以两个 Rendering Lab 示例的手动测试为主，不增加大型自动化矩阵或 formal PERF 前置流程。

## Context

### 1. 要解决的现象与证据边界

用户已手动确认：关闭高级效果、保留真实材质的 Full 场景，远景 GPU 利用率不到 30%，拉近后可超过 80%。本 ADR 将这项可重复的近景性能问题作为直接优化目标，不要求先达到任何覆盖率门槛才优化。

两个目标示例是 [Rendering Lab Basic](../../examples/demos/14-integrated/rendering-lab-basic/main.ts) 和 [Rendering Lab Full](../../examples/demos/14-integrated/rendering-lab/main.ts)。Full 的 UI 高级效果全关后，材质、基础 direct lighting 和 Environment IBL 仍属于基础 PBR。Basic 的 UnlitFactor 则不承担同等着色工作。

2026-09-14 的两份本地导出是本设计的探索输入，文件名为 `oengine-basic-1789397422285.json`、`oengine-full-1789397619866.json`。以下数字用于确定调查优先级，不登记为正式性能基线：

| 观测 | Basic | Full | 对设计的意义 |
| --- | ---: | ---: | --- |
| GPU Pass Sum P50 | 5.964 ms | 16.384 ms | Full 基础渲染成本明显更高 |
| GPU Pass Sum P95 | 6.291 ms | 61.080 ms | Full 还存在需要独立跟踪的长尾 |
| 有效前景像素 | 1,747,809 | 1,089,452 | 捕获视角不同，不能直接相减得到 PBR 成本 |
| 可见输出三角形 | 23,585 | 59,937 | 两次捕获几何工作量也不同 |
| non-zero shading bin | 1 | 1 | 支持研究无需分类的单 bin 调度 |
| Full 材质纹理逻辑驻留 / 分配 | — | 约 533 / 704 MiB | 需要核实访问工作集和物理表示 |

GPU Pass Sum 是已计时节点的和，未覆盖所有 copy/clear、间隙、排队及 present。利用率是 GPU 引擎忙碌程度的采样指标；它既不是某个 Shader 的执行时间，也不是 wave occupancy。帧率、刷新节奏和 GPU 频率会影响利用率，不能把 30% → 80% 直接换算为着色慢了 2.67 倍。

这些限制不否定用户的复现。它们决定后续应记录 Full 自身的远、中、近机位与 GPU 时间，而不以不同视角 Basic/Full 的差值作为唯一证据。此前长尾中多个无关 GPU Pass 同时变慢，不能提前断言同一处着色重构一定消除全部长尾。

### 2. 当前代码为什么会随近景像素增加而变贵

当前主链为：

```text
Hardware Visibility：Depth + VisibilityKey + ShadingBinId
  → 64×64 classifier / 8×8 sparse queues / finalize
  → specialized material + direct lighting
      ├─ HDR
      └─ SurfaceLite：normal、albedo/AO、packed material
  → LongRangeDiffuseProvider：provider selection + diffuse/specular sampling
      └─ 两张全分辨率 selected lighting 纹理
  → OpaqueLightingResolve：间接 BRDF + AO + HDR 合成
  → Environment Background / Final Output 等后续工作
```

源码与成本对应如下：

| 当前 owner | 已确认的工作 | 重构方向 |
| --- | --- | --- |
| [MainRenderPipeline](../../OEngine/src/render/pipeline/MainRenderPipeline.ts)，`createSparseShadingPublicationContext` | 有 opaque lit receiver 就要求两类 SurfaceLite | 由真正的后续消费者决定 Surface 输出 |
| [SurfaceFeature](../../OEngine/src/render/features/SurfaceFeature.ts)，`addToGraph` | 有 opaque pipeline 就创建并执行分类、队列、finalize | 单 bin publication 直接着色，多 bin 才分类 |
| [sparse_shading_resolve](../../OEngine/src/shaders/sparse_shading_resolve.ts)，`sparse_evaluate_geometry` | 每个有效像素读取 work/instance/geometry，取三个顶点、变换、计算重心与属性 | 缩小 receiver 工作集，分开 triangle setup 与逐像素求值 |
| [GpuTextureRefAbi](../../OEngine/src/gpu/GpuTextureRefAbi.ts)，`GPU_TEXTURE_BANK_SAMPLE_WGSL` | 共享采样函数包含 9 bank × 6 sampler 路由 | publication 已知访问集合时静态收窄 |
| [GIService](../../OEngine/src/render/features/GIService.ts)，`resolveOpaqueLighting` | 先 provider，再 lighting resolve | effects-off 基础 IBL 直接进入 receiver kernel |
| [long_range_diffuse_provider](../../OEngine/src/shaders/long_range_diffuse_provider.ts)，`environment_sample` | oct 手动 bilinear/mip 插值，重复读取 Surface | SH diffuse + filtered cube specular，移除基础中间产品 |
| [opaque_lighting_resolve](../../OEngine/src/shaders/opaque_lighting_resolve.ts)，`indirect_contribution` | 再解码 Surface、重建位置/视线，并先算 fallback irradiance 再 `select` | 共用 receiver/PBR 数学；有效 provider 时跳过无用 fallback |

近景可能同时放大三种成本：

1. **有效像素数增加。** 几何身份、材质、direct/IBL、Surface 写入都按像素执行；同一三角形覆盖更多像素时，当前 triangle setup 也重复更多次。
2. **材质访问成本变化。** 拉近改变梯度和选用 mip，可能改变有效纹理工作集、缓存命中和采样延迟；“选到更细 mip”不等于必然 cache miss，需用实际梯度/材质采样隔离确认。
3. **算术、访问与中间输出共同达到 GPU 瓶颈。** Shader 即使没有高级效果，仍可能受 ALU、访存带宽或依赖链延迟限制；较大的寄存器占用还可能降低延迟隐藏能力。

用以下近似成本模型组织判断，不能把它当硬件预测器：

```text
P = 有效前景像素，N = 内部分辨率像素，W = 排队 microtile 数

当前基础 PBR 成本 ≈
  classification(N) + queue(W)
  + receiver_setup(P) + material_sampling(P) + direct(P)
  + Surface 写读(P) + provider(P) + indirect_resolve(P)
  + 其他几何/背景/输出成本

每个阶段的耗时受下列量共同约束：
  算术工作 / 实际算术吞吐
  实际内存流量 / 有效带宽
  未隐藏的数据依赖与访问延迟
```

目标是减少上式中的重复工作和每像素成本，并降低近景的成本增长斜率；不能只减少 Pass 名称。

### 3. 已有优化必须承认，未定位问题不能写成根因

[GpuShadingProgramOracle](../../OEngine/src/gpu/GpuShadingProgramOracle.ts) 与 Shader generator 已经按 program 特化。PbrOrm 不生成 base texture、normal map、emissive texture 采样，也不生成 normal-map tangent 路径；UnlitFactor 无 velocity 时已可不重建 triangle。它们不是本 ADR 可以再次领取的优化收益。

仍需审计的具体点是：

- velocity 未输出时，源码仍构造 previous/current clip 与 velocity；编译器是否已消除不能仅凭源码判断。
- lit 的 vertex color 仍按 geometry flag 分支，不能因为 Dungeon 不使用就对所有 PbrOrm 删除。
- packed position 的 byte/word 解码、重复 geometry metadata 查询和三个顶点的变换存在收窄空间；不能假定每条源码 load 都变成独立 DRAM transaction。
- 当前材质记录包含 32 B shading header + 240 B payload，但不能以 272 B × P 宣称实际带宽，编译器可能只取用字段。
- 9×6 路由代表 Shader 源码与绑定选择空间，**不代表一次采样执行 54 次 texture sampling**。
- 当前已有 EnvironmentPrefilterPass 和 split-sum LUT；本 ADR 改善其表示和消费位置，不把 prefilter/split-sum 描述成首次引入。

还有一处需要随共享光照语义核实的冲突：IBL/Probe provider 已将 diffuse irradiance 乘 material AO，OpaqueLightingResolve 又乘 material AO，其注释却要求 raw irradiance。新合同必须明确 AO 只应用一次；Brick4 的 cone 积分也不能不加区分地重复遮蔽。此处是源码语义冲突，尚未由本次手动视觉测试确认影响程度。

### 4. 论文、工业实现与可移植结论

研究遵循“原理 → 开源源码 → 可移植部分 → 本地设计”，不因某引擎使用 Visibility Buffer 就假定其整套方案更快。

| 论文 / 原理 | 开源实现核对 | 本 ADR 采用什么 | 不直接采用什么 |
| --- | --- | --- | --- |
| Burns / Hunt，2013，[Visibility Buffer](https://jcgt.org/published/0002/02/04/paper.pdf)：用可见身份代替逐像素大量属性存储 | The Forge 的 Visibility/Forward++ | 可见性与着色解耦，在消费身份后尽量直接完成光照 | 不把论文结果当成本机加速倍数 |
| Schied / Dachsbacher，2015，[DAIS](https://cg.ivd.kit.edu/publications/2015/dais/DAIS.pdf)：triangle 表示、属性插值及导数；明确讨论逐像素重复顶点变换的代价 | The Forge `CalcFullBary`、Bevy receiver resolve | 分离 triangle-invariant setup 与 pixel evaluation；验证 perspective gradients | 不照搬 geometry shader、全局 memoization cache 或 MSAA 链表 |
| 材质/光照局部性与 primitive 一致性 | Wicked 的 `visibility_shadeCS.hlsl`、`surfaceHF.hlsli` | 相同阶段完成材质和光照；区分同 bin 与同 primitive | 不移植 bindless、ray tracing 资源模型；不照搬 native quad 映射 |
| 预积分环境光与低频 irradiance 表示 | Filament 的 IBL Shader、CubemapIBL、CubemapSH | 配套 SH、prefiltered cube、DFG、能量与 AO 规则 | 不混用不匹配的 cooker、LOD 和 BRDF 公式 |
| [Roofline](https://escholarship.org/uc/item/5tz795vq) 与 GPU 延迟隐藏原理 | [AMD 对 occupancy/寄存器/访存的说明](https://gpuopen.com/learn/occupancy-explained/) | 同时考虑计算量、访问量和寄存器代价，指导逐项隔离 | 不把利用率当作 Roofline、DRAM 带宽或 wave occupancy 的实测 |

进一步核对所得：

- [The Forge 对 Forward++ 的说明](https://github.com/ConfettiFX/The-Forge/blob/master/README.md) 证明 Visibility 后可以用一次常规 draw 配合 tiled light list 完成 shading。其 pinned 数学文件同时保留 ray differential 与投影重心路径，并注明前者在该实现中有更多寄存器/MUL 成本。不能因为 ray differential 看起来简洁就判定它更快。
- [Wicked 的 compute derivative 说明](https://turanszkij.wordpress.com/2022/05/08/derivatives-in-compute-shader/) 强调三角形边界的梯度问题。邻居像素属于别的 primitive 时，不能直接相减其 UV 充当本三角形的梯度。
- Bevy 的 receiver 是有价值的 WESL 参考，但其 [meshlet plugin 能力要求](https://github.com/bevyengine/bevy/blob/f3ab9ad5a433867d1c57fa1ec390048b457236ec/crates/bevy_pbr/src/meshlet/mod.rs) 包含 64 位纹理原子等能力，整条前端不能作为浏览器 WebGPU 方案移植。它的 tangent 重建也不应替换 OEngine 已 Cook 的切线约定而不验证。
- DAIS 的全局 triangle buffer 能把 setup 从像素频率移到 triangle 频率，但增加构建、存储、间接寻址和容量处理。OEngine 当前更适合先做局部复用；若融合后仍是 receiver setup 主导，再研究有界 triangle setup buffer。

#### 固定源码与采用记录

下表是设计选择，不表示已经完成移植。既有生产 provenance 仍以 [shading ledger](../porting/shading.md) 为准。表达性代码迁移时按表中固定版本登记本地函数、改写内容、许可证与验证；现有旧版本记录不得被悄悄覆盖。

| 来源 | 固定 revision / 文件 | 许可证 | 采用状态与适配 |
| --- | --- | --- | --- |
| The Forge | `9d43e69141a9cd0ce2ce2d2db5122234d3a2d5b5`，[vb_shading_utilities.h.fsl](https://github.com/ConfettiFX/The-Forge/blob/9d43e69141a9cd0ce2ce2d2db5122234d3a2d5b5/Common_3/Renderer/VisibilityBuffer2/Shaders/FSL/vb_shading_utilities.h.fsl) | Apache-2.0 | 计划可追溯局部移植 `CalcFullBary` / interpolation 数学；适配 reverse-Z、像素中心、内部尺寸和 WGSL |
| Bevy | `f3ab9ad5a433867d1c57fa1ec390048b457236ec`，[visibility_buffer_resolve.wesl](https://github.com/bevyengine/bevy/blob/f3ab9ad5a433867d1c57fa1ec390048b457236ec/crates/bevy_pbr/src/meshlet/visibility_buffer_resolve.wesl) | MIT OR Apache-2.0 | 按规格独立实现：参考 receiver 组织、与 The Forge 交叉核对，不引入 ECS/meshlet 前端 |
| Filament | `aab101b4c038da83f71a16accb8279516a0247b9`，[surface_light_indirect.fs](https://github.com/google/filament/blob/aab101b4c038da83f71a16accb8279516a0247b9/shaders/src/surface_light_indirect.fs)、[CubemapIBL.cpp](https://github.com/google/filament/blob/aab101b4c038da83f71a16accb8279516a0247b9/libs/ibl/src/CubemapIBL.cpp)、[CubemapSH.cpp](https://github.com/google/filament/blob/aab101b4c038da83f71a16accb8279516a0247b9/libs/ibl/src/CubemapSH.cpp) | Apache-2.0 | 计划可追溯局部移植配套 IBL 数学和 preparation；使用 OEngine 环境 owner 与四组绑定 |
| Wicked Engine | `5e07e3bfd7f89633a468009e0620b14e508dd8b7`，[visibility_shadeCS.hlsl](https://github.com/turanszkij/WickedEngine/blob/5e07e3bfd7f89633a468009e0620b14e508dd8b7/WickedEngine/shaders/visibility_shadeCS.hlsl)、[surfaceHF.hlsli](https://github.com/turanszkij/WickedEngine/blob/5e07e3bfd7f89633a468009e0620b14e508dd8b7/WickedEngine/shaders/surfaceHF.hlsli) | MIT | 按规格独立实现：借鉴融合和 primitive 一致性组织；本 ADR 的 subgroup setup 复用是本地设计，不冒充上游已有实现 |
| WebGPU / WGSL | [WebGPU](https://gpuweb.github.io/gpuweb/)、[WGSL](https://gpuweb.github.io/gpuweb/wgsl/)，2026-09-15 查阅 | 规范引用 | 按规格独立实现；能力、uniformity、格式与 limit 按实际 device 验证 |

本次不引入新的第三方运行时依赖。论文与文章用于原理推导；不复制无明确代码授权的表达性实现。

## Decision

### 1. 推荐主管线与优先级

采用 **Visibility-native、按已发布材质集合选择调度、基础 IBL 就地求值、复杂间接光按消费者后置** 的单一主管线。

```text
GPU Work Generation → Hardware Visibility
                           ↓
              已发布 opaque bin 集合
                ├─ 0 bin：无 opaque shading
                ├─ 1 bin：DirectSingleBin，直接覆盖内部像素网格
                └─ 多 bin：ADR-0013 SparseMicrotile，GPU 产生队列与 indirect args
                           ↓
                同一 Receiver / Material / Direct 库
                ├─ 无复杂间接光消费者：同 kernel 计算 Environment IBL → HDR
                └─ 有复杂间接光消费者：HDR direct + demanded Surface
                                            ↓
                                按依赖执行 GI/AO/SSGI/SSR composition
                           ↓
                  Transparency / Temporal / Final Output
```

本次重构核心顺序：

1. 将基础 IBL 接入 receiver，并同时移除 effects-off 的 Surface/provider/resolve 往返。
2. 单 bin publication 使用直接调度，删除这类 publication 的分类/队列依赖。
3. 收窄 receiver 与材质访问；用局部 setup 复用进一步降低近景逐像素重复计算。
4. 高级效果按下文合同继续可用；纹理实际尺寸/mip/格式核对纳入定位，已有资产管线优先复用。

前两项属于推荐生产结构。第三项中的新增协作优化只有在短手动对照确认有收益后保留；不为了架构图完整而永久保留变慢的实现。

### 2. DirectSingleBin：不采用覆盖率切换

调度选择只由 immutable publication 的完整 opaque bin 集合决定：

```text
publishedOpaqueBinCount == 0 → None
publishedOpaqueBinCount == 1 → DirectSingleBin
publishedOpaqueBinCount > 1  → SparseMicrotile
```

不使用覆盖率阈值、上一帧 visible-bin count、迟滞状态机或 GPU 利用率控制调度。相机远近不会切换模式。单 bin 可以包含多个材质、实例和三角形，不能把它误写成单材质或单 primitive。

首版 DirectSingleBin 采用 8×8 compute 网格，由内部尺寸产生固定 `ceil(width/8) × ceil(height/8)` dispatch；每像素读取当前 VisibilityKey，背景尽早结束，命中像素调用同一 specialized receiver。固定像素网格由 CPU 编排不等于 CPU 构建可见列表，GPU 产生的 VisibilityKey/MeshletWork 仍直接驱动真实着色。

必须满足：

- publication 的 bin 集合覆盖当前已注册 opaque 材质/TextureBindingSet 的全部可能输出，包含 MASK；不是 GPU counter 中“这一帧恰好看到一个 bin”。
- material/association/texture set patch 改变集合时，与 pipeline、绑定和 mode 原子发布；新 revision 准备完成前保留上一完整 publication。禁止在旧 single-bin kernel 上渲染新 bin。
- 保留 bounds、VisibilityKey、work/asset/material/routing generation 检查；意外 bin 输出标记 invalid，不能静默漏画。
- DirectSingleBin 不分配 sparse record heap、bin layout、indirect args，不执行 classifier/finalizer；多 bin 继续使用现有 queue ABI、overflow 与 GPU consumer。
- 从 bin heap 中抽离所有模式共用的轻量 `ShadingFrameStatus`。它只承载帧错误标志、generation 与必要有效性；复用原 storage 绑定预算。每帧清零并连接 Final Output 的 invalid-frame 处理，不为了取一个 frame_flags 保留整套 sparse heap。
- 固定 dispatch 不新增 GPU 队列，不引入 occupancy reduction、逐帧 readback 或额外 submit。
- HDR/background 保持确定性初始化。首版保留一次必要的 HDR clear 与既有背景 owner，不能让背景 early-return 留下旧帧像素；不得顺手把全环境 cube 绑定带入最窄 UnlitFactor。

低覆盖率时会有全屏的轻量 key 检查，但不执行背景上的 PBR。它是否优于 sparse 仍需远景手动确认；这是一项明确的成本取舍，不声称任何场景都更快。多 bin 不采用“每个 bin 各扫全屏”的方案。

### 3. Receiver Core：分离 setup、插值和材质

内部 Shader 库按数据作用域组织，而不是构造一个永远完整的 Surface 大结构：

```text
Identity validation
  → TriangleSetup：顶点索引、所需属性、投影系数、primitive 常量
  → PixelReceiver：当前像素的 position / normal / UV / gradients
  → MaterialInputs：因子与该 program 真正使用的纹理
  → PbrTerms：direct 与可选 environment
  → demanded output stores
```

依赖在 source generation / pipeline creation 时确定：

| Program / consumer | 必需工作 | 不能无条件计算 |
| --- | --- | --- |
| UnlitFactor，HDR only | identity + factor | triangle、normal、UV、lighting |
| PbrFactor | 位置、法线、BRDF 所需视线；有顶点色时插值 | UV gradients、材质纹理、tangent |
| PbrOrm | PbrFactor 基础 + UV/gradients + ORM | normal-map tangent、base/emissive 纹理 |
| Normal-textured PBR | 对应纹理与 Cooked tangent frame | 不存在的其他纹理 |
| Velocity consumer | current/previous transform 与运动有效性 | 关闭时的 previous matrix/clip 运算 |

具体要求：

- 三个顶点的 decode 所需 metadata 在函数作用域提取复用；packed word 能一次加载后解出多个分量时，不重复经 byte helper 访问。对未对齐输入保留正确边界语义。
- 不因默认资产缺少 color、某种 format 或 UV transform 就删除通用支持；能从整个 publication 证明统一的条件才静态特化。
- 保留逆转置法线、非均匀缩放、镜像切线与已 Cook tangent handedness 语义。当前数学若不满足这些条件，应按参考不变量修正，不能仅追求与旧图像一致。
- analytic differential 与邻点 finite difference 是不同梯度定义。选用 The Forge 投影修正时同时更新 CPU oracle，明确坐标和 mip 语义；不把替换公式本身当性能收益。
- near-plane、退化三角形、零 UV 面积、非有限梯度采用有界 fallback。保留并观察 gradient fallback 计数，不能让错误梯度大量落到 mip 0 后再用降纹理质量掩盖。
- 本次不以 f16 保存位置、重心分母、身份或深度；f16 BRDF 属另一次有精度证据的局部优化。

#### 局部 triangle setup 复用

近景大三角形具有局部 identity 一致性的潜力。推荐在基础融合完成后尝试 subgroup 内 **完整 VisibilityKey 一致** 的 setup 复用：

1. 所有参与 lane 在 collective 之前完成安全的 key/validity 读取；不先让背景或越界 lane 提前退出 collective。
2. 用规范支持的 subgroup 操作判断该组是否全部有效、是否为同一个完整 key；比较 meshlet work slot 与 primitive 的组合，不能只比较 material/bin/local triangle。
3. 一致时由一个 lane 计算被证明相同的 triangle setup，向同组 lane 广播所需字段；每个像素仍独立求自己的重心、UV/gradients、纹理和光照。
4. 不一致时使用同一非协作 receiver 数学；这是同一 kernel 的数据依赖分支，不是另一套 renderer。
5. collective 的调用符合 WGSL uniformity，支持设备实际 subgroup size；不假设 `local_invocation_index` 与 lane ID 的特定映射。需要屏幕 quad 时必须单独建立并验证映射，不能复制 HLSL `remap_lane_quads` 就视为完成。

参考 [WGSL subgroup / quad 规范](https://gpuweb.github.io/gpuweb/wgsl/#subgroup-builtin-functions)。首版不增加全局 triangle cache、hash table、跨帧 history 或新的工作队列。收益只来自相同 setup 的复用，纹理和最终着色仍为逐像素一次。广播、分支和寄存器可能抵消收益；若如此，删除协作分支，保留已经收窄的 receiver。

### 4. 材质访问特化：利用真正已知的 bank / sampler 集合

保留 `ShadingProgramId × TextureBindingSetId` 的逻辑 identity，不因该优化增加新的 material bin 编码。

在资产发布和显式 patch 的冷路径，按 bin 建立派生 `MaterialAccessSignature`，包括实际使用的语义、bank 集合、sampler 类集合、必要的 texture routing 与 UV transform 条件。它来自已验证的材质表，不来自 CPU 每帧遍历或 GPU 可见性 readback。

- 某语义在整个 bin 中只使用一个 bank / sampler 时，生成直接引用对应资源的采样表达式。
- 存在多个选择时，只保留该 publication 的有限候选；不得从单个 capture 的可见材质推断完整候选集合。
- 只裁剪纹理句柄选择和无用 descriptor，不改变 mip/filter/address/color-space/通道语义。纹理 layer 与材质因子仍按实际材质读取。
- signature、layout revision、output mask、lighting placement、execution mode 与 capability 纳入缓存 key。相机移动不触发编译；改变访问集合的 patch 原子发布新 closure。
- 不为每个材质构建独立全屏 pipeline。相同 signature 复用；场景变化后旧 pipeline/绑定按既有提交边界退役，缓存保持有界。
- 最窄 Unlit 不引入纹理资源；通用 multi-bank shader 仍是相同 program 的合法 specialization。

这是针对当前 WGSL 有界资源路由的本地设计，不是从原生 bindless 引擎直接移植。其实际收益需以生成 WGSL、绑定数与材质采样阶段的短对照确认。

### 5. Environment IBL：一套 preparation / sampling 合同

基础环境光采用：

```text
Diffuse：三阶带数 SH（l = 0..2，共 9 个 RGB 系数）
Specular：prefiltered cubemap mip chain + filtering sampler
BRDF：共享 DFG LUT + 与之匹配的能量补偿
```

SH 的“9 项”不能称作 9 阶。SH 系数冻结为 working-linear、未乘 receiver albedo/AO、未乘 pre-exposure 的 irradiance 表示；是否折叠 1/π 必须在 ABI 中固定，本 ADR 推荐保存 irradiance、在共享 BRDF 中应用 1/π 一次。若从 Filament 的预缩放系数移植，需显式转换到该约定。

Specular cube 推荐 `rgba16float`，DFG 沿配套公式选择 filterable LUT 格式。Cube 采用六个 2D layer 的纹理、cube sampled view；preparation 通过 2D face view 写入。HDR 背景与 PBR reflection 的环境旋转、强度和颜色空间一致。

[LightDatabase](../../OEngine/src/gpu/LightDatabase.ts)、[EnvironmentPrefilterPass](../../OEngine/src/gpu/EnvironmentPrefilterPass.ts) 和场景环境 owner 共同迁移 preparation；不新增 Loader 长期 GPU owner。优先使用已有异步加载/准备入口，在环境改变时生成 SH 和 cube，完成后一起发布。稳定帧不重滤环境、不回读 SH、不额外 submit；初始化/环境更新的 preparation 记录为独立资源生命周期工作。

必须配套冻结：

- cube face 方向、旋转与 seam 处理；
- diffuse SH basis/归一化、irradiance 与 radiance 的区别；
- GGX roughness 参数、每级预过滤分布与 runtime roughness-to-LOD；
- DFG LUT 坐标、通道、F0/F90 与能量补偿；
- material AO、ambient visibility、specular AO 的应用位置；
- 无环境/资源未就绪时的确定性黑环境或上一完整有效环境；
- device recovery、环境 replacement 与旧纹理提交后退役。

不在 runtime 将现有 oct 纹理直接解释成 cube，也不把换表示造成的暗化、模糊或高光损失算作性能提升。

### 6. 基础 IBL 融合与高级效果的明确边界

为每个 publication 派生 `IndirectLightingPlacement`，它是 FrameGraph 的依赖选择，不能作为公开质量档：

| Placement | 适用条件 | receiver 输出与后续工作 |
| --- | --- | --- |
| `InlineEnvironment` | 没有 AO/SSGI/SSR、空间 GI query 或要求光照分量的 debug consumer | material + direct + IBL + emissive → HDR；其他 consumer 所需 velocity/Surface 按需输出 |
| `DeferredIndirect` | GTAO、SSGI、SSR、Brick4/Probe 或光照分量消费者之一存在 | material + direct + emissive → HDR direct 与所需 Surface；间接光由后置 owner 完成 |
| `Unlit` | 无 lit receiver | 不绑定、不计算环境光；背景可独立存在 |

TAA/Motion Blur 本身不要求把 IBL 后置，只要求真实 velocity/metadata；Surface debug 也不自动要求后置，只有光照分量 debug 才需要对应分量合同。Binning 与 lighting placement 独立：多 bin 场景在无复杂间接光消费者时同样可融合基础 IBL，不能把收益只做给 Dungeon。

**基础 effects-off 的硬结果：** 除 HDR 外没有 SurfaceLite/velocity 输出；没有 long-range provider、OpaqueLightingResolve、selected diffuse/specular textures，以及为它们存在的 clear、copy、readback 或历史。IBL 计算仍存在于 receiver 中，不能把 UI 上“IBL Pass absent”显示成“IBL 耗时 0”。

高级路径优先复用当前 Service 的真实语义及共享 PBR/IBL 数学，不要求第一轮将其合并成一个巨型 kernel：

- **GTAO：** 先取得 Surface/depth，再产生 ambient visibility 与 bent normal，之后完成间接光；direct/emissive 不被统一乘 AO。
- **SSGI：** 保留 `PreExposedOpaqueRadianceSourceFrame`，其 source 排除本帧 SSGI、屏幕 AO 和 SSR；先形成该 source，再 trace/temporal，最后按现有分量规则合成。不能用已经包含本帧 correction 的 HDR 自反馈。
- **SSR：** 保留 post-screen-space-diffuse/pre-SSR 的 opaque color pyramid 与 `baselineSpecular`。按 confidence 替换该 specular，不能在最终 HDR 上直接再加 SSR。
- **Brick4 / Probe：** 保持 generation/residency/空间有效性与 `Brick4 → Probe → IBL → black` 优先级。Brick4 不仅提供 diffuse，也可提供 GGX specular，不能迁移为仅 diffuse 替换。
- **AO 责任：** 普通 IBL/Probe irradiance 与 receiver AO 分离；已包含 cone visibility 的 Brick4 输出必须显式标注遮蔽是否已应用，composition 不重复相乘。

可进一步合并高级路径的 provider 与 BRDF resolve，但必须先证明绑定预算与真实消费者允许；这不是本次基础性能目标的前置项。保留有消费者的后置资源是合法的，关闭消费者后则应全部消失。

### 7. FrameProducts、资源预算与错误通路

改造 [FrameProducts](../../OEngine/src/render/pipeline/FrameProducts.ts)，用可区分的结果表达光照是否已完成，不再给所有输出写一个恒为 true 的 `directAndEnvironmentResolved`：

```ts
// 概念合同；具体字段复用已有 domain / preExposure / Surface 类型。
type OpaqueShadingResult =
  | { kind: "lit-complete"; hdr: ResourceId; demandedSurface: SurfaceProducts | null }
  | { kind: "lit-needs-indirect"; directHdr: ResourceId; receiver: SurfaceProducts }
  | { kind: "unlit"; hdr: ResourceId; demandedSurface: SurfaceProducts | null };
```

每种结果均携带 internal domain、pre-exposure、publication generation 与 `ShadingFrameStatus`。复杂场景的 unlit/lit 混合通过 Surface flags 维持消费者识别；上述 `kind` 描述帧级组合，不为每个像素创建 CPU 对象。

约束如下：

- `lit-complete` 不能再无条件调用 GIService；`lit-needs-indirect` 不能作为完整 PBR baseline 直接送后处理。
- HDR 中 direct、indirect、emissive 均在 working-linear 域，pre-exposure 恰好一次；SSGI/SSR 的分量与 source 使用一致尺度。
- 已有 frame invalid 状态必须覆盖两种调度。某 workgroup 发现错误时，不依赖跨 workgroup barrier 来阻止已写像素；后续 Final Output 在有序阶段统一拒绝 invalid frame，不能呈现部分结果。
- 正常帧的统计按现有 instrumentation cadence 采样；不增加 per-pixel atomic success counter。错误路径可记录必要标志，production 不启用 pixelClaims。
- FrameGraph cache key 包含 execution、placement、access signature 与 output layout；GPU counter 的变化不触发 graph rebuild。

[GpuSparseShadingPipelineContract](../../OEngine/src/gpu/GpuSparseShadingPipelineContract.ts) 的当前最宽 direct descriptor 为 13 sampled textures、7 samplers、10 storage buffers、5 storage textures、3 uniforms。基础融合增加 cube + DFG、一个共享过滤 sampler、SH/frame uniform 时，名义预算为 **15 / 8 / 10 / 5 / 4**，可保持现有 16 / 8 / 10 / 5 / 4 ceiling。

这只是预算推导，仍需按最终 descriptor 计算：cube 与 DFG 可以共享过滤 sampler；SH 不能额外占用第 11 个 storage buffer；新增 cube view 必须贯通 descriptor、WGSL、layout 和 cache；DirectSingleBin 的轻量 status 替换 heap，不能与之重复计费。高级光照分量留在后置 owner，避免强行把 HDR、全 Surface、velocity、diffuse、specular 同时塞进最宽 compute 输出。

所有资源通过既有 publication 和 submitted-work retirement 管理；resize、texture relocation、环境替换、scene replacement 和恢复设备时，不复用旧 device/generation 的绑定。

### 8. 纹理与整体成本：本次纳入核实，不另造资产系统

将纹理工作集视作同等重要的解释变量。当前 Full 25 张材质纹理、约 533 MiB 逻辑驻留与 704 MiB 分配不能证明物理 VRAM 换页，但足以要求核实。

利用已有 [TextureResidency](../../OEngine/src/gpu/TextureResidency.ts) 与 [ADR-0011](./0011-asset-codec-and-gpu-native-texture-pipeline-v3.md)，在加载完成或导出时记录实际物理 width/height、mip count、format、layer/capacity、logical/resident/allocated bytes 与资产 identity。不要增加每帧纹理表扫描。

已查看的当前 Dungeon 源图为 2048²，而旧捕获逻辑总量接近 25 张 4096² RGBA8 完整 mip 链。捕获缺资产 hash 和逐图物理尺寸，因此不能断言发生了 4× 放大；首先确认捕获资产与当前资产是否相同、统计口径和上传尺寸是否一致。

若证据显示现有路由/上传/计数错误，本重构可修正该窄问题。若主要成本来自未 Cook RGBA8，则使用已有 GPU-native package/KTX2/BC 支持做独立手动对照，保留相同尺寸与正确通道；压缩质量变化与结构性优化分开报告。ORM 包含 roughness/metallic/AO，不能不经通道设计直接使用仅两通道的 BC5。

本 ADR 不重建 codec/residency 系统，不通过降低 DPR、分辨率、强制粗 mip 或删掉环境光获得默认收益。Final Output、几何/HZB 与系统级 GPU 长尾继续显示在整体报告中，但只有进一步定位后才扩展相应重构。

### 9. 三阶段执行计划

三个阶段按依赖顺序实施。每个阶段都先完成资源合同和运行证据，再进入下一阶段；不维护长期双 backend，也不把阶段性诊断路径写成生产路径。

#### 阶段一：Demand-driven 基础光照融合

**目标。** 让真实 consumer 决定需要哪些 opaque 产品，并把 effects-off 的基础 PBR 收敛为 receiver-local 的 direct lighting + IBL + HDR。高级效果没有 consumer 时，Surface、provider、opaque resolve 及其 transient 资源必须从 live graph 消失。

**代码边界。** 主要修改 `MainRenderPipeline.ts`、`SurfaceFeature.ts`、`GIService.ts`、`FrameProducts.ts`、`GpuSparseShadingPipelineContract.ts`、`sparse_shading_resolve.ts`；必要时调整 `LongRangeDiffuseProviderPass.ts`、`OpaqueLightingResolvePass.ts` 与环境 preparation owner。

**执行步骤。**

1. 定义不可变 `OpaqueShadingDemand`，至少包含 `needsHdr`、`needsSurface`、`needsDiffuseSurface`、`needsVelocity`、`needsIndirectComponents` 和 `needsLightingDebug`。从 feature topology、材质输出和真实下游读集合一次计算，传入 publication/context 和 FrameGraph recipe。
2. 将基础路径固定为 `Visibility → Receiver/Material → Direct Lighting → Environment IBL → HDR`。receiver kernel 复用现有材质和 `lighting_direct` 数学；direct、emissive、unlit 与 Material AO 的责任要写在同一 ABI 注释和产品字段上，AO 只能应用一次。
3. 只有 AO/SSGI/SSR/Brick4/Probe 或 lighting debug 请求时，才创建 Surface、velocity、indirect components、long-range provider 和后置 resolve。effects-off 时删除没有消费者的 attachment、bind group、Pass、readback 与独立 submit。
4. 为 IBL 准备明确表示：diffuse 使用 SH9，specular 使用 prefiltered cubemap mip chain，BRDF 使用匹配的 DFG LUT。preparation 由环境变化触发，稳定帧只读已准备的资源；不在 receiver 内重复构建环境数据。
5. 迁移完成后删除 effects-off 的独立 IBL provider/opaque resolve 往返和重复基础 IBL 数学。旧函数若只剩无消费者调用，直接删除；不保留只为兼容而存在的第二条基础路径。

**完成证据。**

- FrameGraph 的 live topology 中，effects-off 没有 Surface/provider/opaque-resolve 的无消费者节点或资源。
- PBR/ORM、环境旋转与亮度、HDR/pre-exposure、背景和阴影关闭语义保持正确；没有重复 AO 或重复 HDR 合成。
- 性能面板记录 Surface bytes/pixel、live transient texture 数量、provider/resolve Pass 数，以及 receiver/HDR 的 GPU 时间。收益按同一相机和分辨率的绝对 GPU 时间报告，不能把被搬入 receiver 的工作重复相加。
- 高级效果开启时，所需的 Surface/indirect products 仍按 dependency 出现，且下游只读取命名的有效产品。

**轻量手动测试。** 两个 Rendering Lab 都跑 Full effects-off 的远、中、近固定机位；Basic 只作同机位参照。加载和 Shader preparation 完成后，每个位置静置约 5--10 秒导出一次，检查 PBR/IBL 画面、live graph 和 GPU 面板。再逐项开启 AO、SSGI、SSR 和 temporal，确认对应资源出现、关闭后在提交边界退役。只保留必要截图、配置和导出，不建立新的压力矩阵。

#### 阶段二：单 bin 调度与资源声明收窄

**目标。** 在阶段一基础路径稳定后，让 publication 的 `0 / 1 / >1` bin 结果决定执行形态。单 bin 省去不需要的分类和队列；多 bin 继续保持 ADR-0013 的 GPU producer → GPU consumer 闭环。

**代码边界。** 主要修改 `SparseShadingPublicationCoordinator.ts`、`GpuShadingPublicationPlan.ts`、`SurfaceFeature.ts`、`PackedVisibilityPass.ts`、`ShadingBinPass.ts`、`SparseShadingResolvePass.ts`、`sparse_shading_resolve.ts` 和 `FrameProducts.ts`。

**执行步骤。**

1. 在 immutable publication 中冻结 execution mode：`0 bin` 不创建 opaque shading；`1 bin` 选择 `DirectSingleBin`；多 bin 选择现有 SparseMicrotile classifier/finalizer/indirect 路径。该决定来自已发布 summary，不来自每帧 CPU 可见性扫描。
2. 首版 `DirectSingleBin` 使用固定 8×8 compute 网格和轻量 status。它不创建 sparse heap、classifier/finalizer、768 B indirect args 或逐 bin queue；除非 debug 或多 bin consumer 明确需要，也不创建 `ShadingBinId` attachment。背景 lane 通过 VisibilityKey/depth validity 早返回。
3. `PackedVisibilityPass` 接受 execution mode 作为产品需求，只有确实需要 bin identity 时才写第二个 MRT。多 bin 仍保留 `r32uint VisibilityKey + r8uint ShadingBinId`、bounded reservation、finalizer fail-closed 和 indirect dispatch ABI。
4. 把 `MaterialAccessSignature` 从 WGSL specialization 扩展为 FrameGraph 实际 read set。每个 TextureBindingSet 只导入和声明 shader descriptor 真正使用的 bank，避免无用 residency、barrier 和生命周期。
5. 对单 bin 和多 bin分别记录有效像素 `P`、内部像素 `N`、coverage、classifier、receiver 和总 GPU 时间。DirectSingleBin 不得因为“少一个 Pass”就默认更快；Full 约 62% coverage 时必须实测背景 early-out 是否抵消全屏 invocation 放大。若回退，删除慢实现或改成单 bin 稀疏 consumer，不恢复固定 70--75% 门槛。

**完成证据。**

- 单 bin graph 中 classifier/finalizer/queue/indirect 资源按预期不存在；多 bin 中 producer、consumer、capacity、overflow 和 error counter 完整存在。
- VisibilityKey sentinel、背景写入、material association patch、resize 和 invalid identity 正确；无 queue overflow、invalid key 或 generation mismatch。
- shader descriptor、FrameGraph read set 和 texture residency accounting 一致；未使用 texture bank 不再延长资源生命周期。
- 面板能区分 publication mode 与本帧非零 bin，并同时显示 `P/N`，避免把 mode 当作性能结论。

**轻量手动测试。** Basic 和 Full 使用完全相同的 camera、窗口、DPR 与画质，分别观察远、中、近机位；单 bin 场景再用一个人工多材质/多 association 场景确认多 bin 回路。做一次 resize 和一次 material patch，检查材质、背景、错误日志、截图及少量性能导出。不要把两种场景的不同视角直接做差。

#### 阶段三：Receiver 热路径与纹理驻留核查

**目标。** 只有前两阶段证明基础工作流和调度合同稳定后，才处理逐像素 receiver setup、packed decode、材质读取和纹理工作集。该阶段的收益必须由 shader 实际工作或 residency 证据支持。

**代码边界。** 主要修改 `sparse_shading_resolve.ts`、`GpuShadingProgramOracle.ts`、`GpuComputeMaterialAbi.ts`、`GpuTextureRefAbi.ts`、`TextureResidency.ts`、`GpuAssetStore.ts`、环境 preparation owner；若证据支持，再评估 `LargeTriangleSetupCache.ts` 的有界局部复用。

**执行步骤。**

1. 审计 velocity-off 是否仍加载 previous/current clip，PbrOrm 是否仍进入 base/normal/emissive/tangent 分支，packed geometry metadata 是否被重复读取或解码。以生成 WGSL、真实 bind layout 和 shader source audit 为准，不能从 TypeScript 字段大小推算带宽。
2. 收窄 material record 和 texture route 的实际字段读取，保持 `MaterialAccessSignature`、pipeline cache key、binding declaration 与 FrameGraph read set 同步。若编译器已经消除某段路径，不重复实现同一“优化”。
3. 为每张纹理记录 source/decoded dimensions、GPU format、mip count、layer/capacity、logical/resident/allocated bytes 和 asset identity，核对 2048→4096 差异是统计错误、上传放大还是确有物理驻留。必要时用已有 GPU-native/KTX2/BC package 做一次同尺寸手动对照，不以降低 DPR、粗 mip 或删环境光换取收益。
4. 只有 receiver setup 仍占主导时，才实验有界 subgroup/triangle setup 复用。定义 producer、容量、溢出、fallback、统计和生命周期；不建立无界跨帧 cache 或新的长期队列。若 off/on 没有稳定收益，删除实验实现。

**完成证据。**

- 生成 WGSL 不再包含实际未使用的字段、纹理路径或 velocity 读取；shader validation 和布局检查通过。
- logical/physical texture evidence 一致；若驻留修复有效，报告中同时出现内存和长尾变化，不能只报纹理数量。
- receiver setup 复用若采用，能显示命中率、fallback、额外字节和 GPU 时间；没有正确性回退。
- 近裁剪面、斜视纹理、退化三角形、normal-map 和 mip 语义保持稳定。

**轻量手动测试。** 以 Full effects-off 的 ORM 近景为主，补充斜视纹理、近裁剪面、退化三角形和一个带 normal map 的材质视角，检查 mip、UV、normal、tangent、颜色和闪烁。纹理 residency 做一次完整核查；subgroup/setup 实验只在前两阶段稳定后运行，不扩展成大型资产矩阵。

三个阶段完成后，再清理被替代的基础路径、过时计数名称和无消费者 shader；保留多 bin scheduler 及高级效果实际需要的 GI/AO/SSR owner。当前实现状态只写入 `STATUS.md`，ADR 仍需满足验证章节的运行证据后才能改变状态。

### 10. 比较过但不作为当前默认决策的方案

| 候选 | 可能优势 | 当前决策 |
| --- | --- | --- |
| Fullscreen fragment Visibility shading | render attachment 写入、硬件 raster 调度，The Forge 有成熟实践 | 有证据时可替换 DirectSingleBin 的物理 consumer；首版采用与现有 shader 最接近的 compute，不长期维护两种单 bin backend |
| 全局 triangle setup buffer / DAIS cache | 将部分重建从 P 次降到可见 triangle 次 | 推迟到局部 setup 仍主导时；新增 producer/容量/字节/dispatch 可能抵消收益 |
| 传统 Forward+ / Deferred G-buffer | Forward 可由硬件插值属性；G-buffer 可降低后续几何追索 | 若新基础链仍受重建主导，允许正式重新选择；当前先利用已有效的 Hardware Visibility，避免未经测量重做几何路径 |
| 减频 shading / VRS / temporal material cache | 直接减少 PBR 求值次数，理论节省更大 | 会引入画质、运动和边缘重建合同，本次保留逐像素完整着色；不拿它替代结构性成本修正 |
| 原生 bindless、mesh shader、64 位原子路径 | 可简化某些资源/前端设计 | 不属于当前 WebGPU 默认能力，不作为性能承诺依赖 |
| 更复杂的 GI / ReSTIR | 改善特定照明算法的采样效率 | 不解释当前高级效果全关的成本，不纳入 |

如果后续证据要求改变 Visibility 或数据结构，可以另行修改相应决策；本 ADR 不把现有架构或外部引擎的实现当不可推翻的权威。

### 11. 架构审计补充：当前实现的强项与真实缺口

#### 已经合理、暂不建议推翻的部分

- `PackedVisibilityPass` 已经把层次工作生成、Hardware Visibility、VisibilityKey 和 MeshletWork 接成 GPU producer -> GPU consumer 闭环。它与 Nanite/meshlet 类方案的基本方向一致；当前数据中的队列溢出、无效 key 和 identity 错误也没有显示异常。没有同视角证据前，不应因为 Full 比 Basic 慢就重写这条几何前端。
- `ShadingBinPass` 使用 GPU classifier、GPU heap 和 indirect dispatch，没有把可见像素读回 CPU。这符合 Visibility Buffer 和现代 GPU-driven 渲染的核心不变量。WebGPU 没有标准 multi-draw-indirect，因此保留有限 bin 的 indirect dispatch 是可移植的折中。
- `FrameGraph` 已有 transient lifetime、pass culling 和 compiled topology。问题不在“缺少一个 render graph”，而在上层没有把真实 consumer demand 传到 graph recipe；这应通过收窄产品合同解决，而不是再造第二套管线。

#### P0：需求驱动没有贯穿到发布上下文

当前 [MainRenderPipeline](../../OEngine/src/render/pipeline/MainRenderPipeline.ts) 的
`createSparseShadingPublicationContext` 在存在 opaque-lit receiver 时无条件加入
`ShadingSurfaceLite | DiffuseSurfaceLite`。随后主图在这些资源存在时调用
`GIService.resolveOpaqueLighting`，因此即使 GTAO/SSGI/SSR 和光照分量 debug 都关闭，仍会创建
Surface 输出、long-range provider 和 OpaqueLightingResolve。这个行为正是当前 Full effects-off
仍有约 5.368 ms provider + resolve 的代码层证据。

高性能实现的共同模式是“consumer 先声明所需产品，producer 再生成产品”：Filament 的 IBL
只在材质光照阶段消费，Bevy/The Forge 的 visibility resolve 不为不存在的后处理建立 G-buffer
产品。EEngine 应把 `OpaqueShadingDemand`（HDR、Surface、velocity、indirect components）作为
不可变 frame plan 先计算，再由 `SurfaceFeature` 和 `GIService` 按 demand 建图。effects-off 的
lit 基础路径应只有 `Visibility -> Receiver/Material/Direct/IBL -> HDR`；无 consumer 时
Surface、provider、resolve 的资源和 Pass 必须从 live graph 消失。

#### P1：单 bin 模式没有向 Visibility 资源合同反向传播

`PackedVisibilityPass.addToGraph` 目前始终创建 `Packed ShadingBinId` attachment。DirectSingleBin
不需要读取每像素 bin identity；只有多 bin sparse consumer 或对应 debug view 才需要它。单 bin
publication 应把 execution mode 传入 Visibility 产品规划，使 raster MRT 在不需要时省略该
attachment。这样可减少一份全内部分辨率的 r32uint 写入和后续资源生命周期，但收益属于带宽/资源
压力，不能直接按 Pass 数量折算毫秒。

同样，`SurfaceFeature` 的 resolve 目前对每个 active `TextureBindingSet` 的 9 个 texture bank
都声明 `read`，即使生成的 pipeline 只绑定其中一部分。`MaterialAccessSignature` 不应只收窄
WGSL binding；它还必须成为 FrameGraph 的实际 read set，只导入和声明被 descriptor 使用的 bank。
否则 shader 可能少采样了，但 residency、barrier 和资源存活范围仍被放大。

#### P1：主管线和 GIService 承担了过多决策

`MainRenderPipeline` 同时决定 publication、资源导入、材质 bank 路由、Surface 输出、GI/SSGI/SSR
组合和 debug 产品，`GIService.resolveOpaqueLighting` 又把 provider 与最终 resolve 固定成一个
调用。这样的 god-object 边界会让“关闭一个 consumer 后删除所有无用 producer”变得困难，也容易
让同一 HDR 在多个 owner 之间重复解释。

建议保留现有统一主管线，但把实现拆成三个纯计划层和三个资源 owner：

1. `VisibilityPlan`：可见性 attachment、MeshletWork 和 execution mode；
2. `OpaqueReceiverPlan`：按 material/receiver demand 生成 Direct/IBL 或 demanded Surface；
3. `IndirectCompositionPlan`：仅接收真实存在的 AO/GI/SSR products。

计划层只产生 immutable `FrameProducts` 合同，owner 负责 pipeline/bind group/resource 生命周期。
这属于降低耦合和避免错误工作的架构重构；在 P0 demand 修正前，不应为了目录拆分单独做大规模搬迁。

#### P2：单 bin 的“减少调度”不能预先当成收益

当前 Full 捕获 foreground coverage 约 62.12%。Sparse resolve 的有效 invocation 约 1.089 M，
而 DirectSingleBin 的固定全屏网格会处理约 1.754 M 像素。若两者每个命中的 receiver 成本相同，
全屏路径的 receiver 部分理论上会放大到约 1.61 倍；它只有在省掉 classifier/queue、背景 early-out
和更好的 locality 足以抵消这项放大时才会变快。Basic 的约 99.65% coverage 更有利于 DirectSingleBin，
但不能把这个结论外推到 Full 或近景。

因此不恢复 70--75% 的固定切换门槛，也不把 `binCount == 1` 写成性能承诺。保留 0/1/>1 的
publication ABI 选择；单 bin 实现必须在同一 camera、同一 GPU 状态下同时记录
`P`（有效像素）、`N`（内部像素）、classifier 时间和 receiver 时间。若 DirectSingleBin 回退，
应删除它的实现或改成单 bin 的稀疏 consumer，而不是保留一个只因架构图好看的慢路径。

#### 与高性能方案的边界

Nanite、The Forge、Wicked Engine 和 Bevy 的共同点是紧凑可见性身份、GPU 侧工作生成、按材质/几何
局部性组织 shading，以及只为真实 consumer 物化中间产品。它们在 bindless、mesh/task shader、
原生 subgroup/64 位原子或平台专用缓存上有额外能力；这些能力不能直接成为 WebGPU 默认依赖。
EEngine 当前最值得移植的是 demand-driven product graph、receiver-local fusion 和有限的
triangle setup 复用，不是照搬它们的资源模型或前端调度器。

## Consequences

### 1. 预期收益与不能承诺的部分

最有把握的结构性减少是 effects-off 的 Surface 往返与 provider/resolve，以及 single-bin 的分类/队列。材质访问特化和局部 setup 复用有进一步收益机会。

旧 Full 捕获中 provider + opaque resolve 的全帧平均合计约 5.368 ms，占已测 Pass Sum 的 26.9%。这是要重新组织的工作预算，不是可全部删除的时间；IBL 采样/BRDF 会搬进 receiver。再移除 single-bin classifier，可触及另一笔固定成本，但不能把不同 Pass 的 P50 直接相加当整帧收益。

净收益按以下思路解释：

```text
减少的时间 = 中间产品与重复计算 + 单 bin 分类/队列 + 真实访问/重建裁剪
             - 融合新增的寄存器/访问代价 - 直接调度的背景检查
             - 协作分支/广播成本
```

设计具有降低数毫秒级基础成本的机会，但目前不冻结“10–12 ms”“翻倍”或各项毫秒收益。最终报告应同时写近景绝对 GPU 时间、同条件改善幅度和画质；达不到目标时据阶段数据继续定位。

GPU 利用率不是越低越好：若解除了帧率限制，优化后帧率更高而利用率仍高也可能是成功。判断重点是固定条件下每帧 GPU 工作时间、近景稳定性与输入响应。

### 2. 代价与风险

- 基础融合延长某些变量的存活期，可能增加寄存器压力；需缩小局部作用域，不把空间 GI/SSR 全塞入 receiver。
- SH 是低频表示，cube filtering 与当前手动 oct 不会逐像素完全相同；用恒定环境、材质响应和少量视觉例子确认质量，不以旧算法作为唯一正确答案。
- 静态访问特化增加 publication/cache 管理，但不增加每帧可见性 CPU 工作；patch 的原子性不能省略。
- 单 bin 直接调度保留少量背景检查；远景必须手动看成本，不能只展示近景收益。
- subgroup 局部复用可能变慢；不增加跨帧缓存来强行提高命中率。
- 本 ADR 不能保证修复所有 GPU 长尾。重构后若 HZB、compact、Final Output 仍同步突增，应继续查频率/驻留/其他 GPU 工作或调度，不再反复重写 PBR 解释所有问题。

## Verification

### 1. 轻量自动检查

本次文档调整只做 Markdown 结构、链接、路径和差异检查，不运行 Renderer 测试或 GPU benchmark。

未来实现按用户偏好采用中等强度的最小检查：

- 修改 TypeScript/WGSL 后运行 `cd OEngine; npm run typecheck` 与命中的现有 targeted tests，不跑默认全量构建/测试链；依赖未变化不运行 `npm ci`。
- 数学变化复用现有 barycentric/gradient/BRDF oracle，只补关键边界；不要为每个输出位、counter 或文件另建测试。
- 使用现有入口检查实际会用到的生成 WGSL/layout，重点是最窄 Unlit、PbrOrm、Normal+Velocity、multi-bin 和最宽带 shadow 组合。运行时通过真实浏览器确认 Shader 编译与 GPU validation。
- publication/调度至少覆盖 single→multi 的材质或 association patch、非 8 整除尺寸和 invalid identity。可以合在现有一个小用例里，不新建大型 Runner。

不增加多机、多浏览器、全 feature 笛卡尔矩阵、逐提交 formal benchmark 或历史 renderer 恢复任务。保留必要的数学、identity 和资源边界检查；手动截图不能替代这些不变量。

### 2. 两个示例的手动主验收

用户手动操作为主，每个 revision 一轮远/中/近通常足以决定下一步，不要求每批次重复全套。

1. 保持当前示例 `window.devicePixelRatio`、internalScale、浏览器、窗口尺寸、灯光、画质与 instrumentation 相同。记录实际 internal/output 尺寸，避免将 DPR 变化当性能收益。
2. Full 关闭所有高级效果，保留 PBR/环境/基础灯光；固定远、中、近三个 camera position/target。先让加载与 Shader preparation 完成，再每个位置静置约 5–10 秒并导出。拉近后原地转向可观察材质/几何变化。
3. Basic 使用相同机位做轻量参照，检查没有回退；它不替代 Full 自身的前后或远近观察。
4. 看一轮材质近景和斜视纹理：metallic/roughness、AO、环境亮度/旋转、mip、闪烁、triangle seam；用一个已有 normal-map 材质补上 Dungeon 未覆盖的切线语义。
5. 手动依次开启 AO、SSGI、SSR、TAA/Motion Blur、shadow，确认图像、无重复间接光和恢复关闭后的资源；不要求测试每种开关组合。
6. 做一次 resize 和 single/multi-bin 变化，查看 console/GPU diagnostics；不为手动验收添加自动压力循环。

保留少量截图、配置/机位、导出和错误信息即可。不以“正式 PERF artifact 未完成”阻塞这轮用户指定的手动优化迭代；它仍不能被标成仓库全局的 formal PERF / ADR Complete，正式声明沿用 [VALIDATION](../VALIDATION.md) 与 [ADR-0014](./0014-browser-validation-and-performance-host.md) 的含义。

### 3. 性能面板需要显示真实工作

复用已有面板和导出，不新建性能系统。优先保留或补充：

| 数据 | 目的与开销边界 |
| --- | --- |
| GPU Pass Sum / shading phase P50、P95；CPU 与 RAF 分开 | 区分 GPU 工作、提交与呈现节奏；不把 GPU Pass Sum 标成完整端到端时间 |
| execution mode、published bin count；采样时的 non-zero bin count | 区分 publication 决策与这一帧可见结果 |
| shading 像素 P、screen 像素 N；sparse 的 W | 解释近景工作量；按既有 cadence 采样，Direct 模式不伪造 queue counters |
| Surface bytes/pixel、live textures、shader bindings | 验证减少了真实物化工作；以 live graph 为准 |
| 纹理物理尺寸/mips/格式与 logical/allocated bytes | 定位 working set；仅在加载、patch 或导出时整理 |
| gradient fallback、identity/overflow/error | 防止错误 mip 或漏画制造假提升 |
| subgroup setup 复用命中率（仅启用该实验时） | 说明节省机会；有界采样，无默认逐像素全局 atomic |

融合后不再有独立 IBL timestamp。面板显示“IBL fused / 独立耗时不可用”，总成本计入 receiver shading；不凭 CPU 标记把单一 dispatch 内的 material/direct/IBL 分成虚假的 GPU 耗时。

只有融合后仍不清楚成本分布时，临时使用同一 Shader 库的诊断 variant，在固定近景逐项观察：仅输出材质属性、完整材质+direct、完整 PBR、ORM 采样以固定因子替代。每次只改变一个工作项，注明图像不等价；这些只定位成本，不作为性能完成指标，也不留成公开质量模式。

现有时间戳粒度约 65.536 μs，短 Pass 的 0 不代表零执行成本。新旧结果只在条件相同且有导出时报告相对改善；没有对照时报告当前绝对时间。超过 30 ms 的慢帧可单列比例用于追踪此前现象，这只是报告分组，不参与渲染调度。

### 4. 本次重构的实用完成条件

- Full effects-off 的 single-bin 真实图中没有 classifier/finalizer/sparse queue，以及 Surface/provider/opaque indirect resolve；PBR 图像仍包含正确基础光照。
- 同条件近景手动记录证明基础 GPU 成本下降，远景没有抵消收益的明显回退；若未改善，明确指出剩余主导阶段，不宣布完成性能目标。
- multi-bin、所需高级效果、patch/resize 与背景 identity 正确，关闭后释放资源；无 GPU validation/uncaptured error/device loss。
- 只有实际采用且有效的局部优化留在生产；被替代的基础物理路径完成清理，来源与当前文档同步。

这些是本次轻量迭代的完成条件，不把尚未运行的自动化、手动视觉或正式性能验证标为通过。
