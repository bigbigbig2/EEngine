# Module C 执行：按需 Surface Fields 与 XeGTAO

> 2026-10-02 方向说明：本文保留 XeGTAO 的已完成来源核对、实现记录和 AO owner 边界；Surface 的执行入口、工作组织和重建必须服从 [SurfaceWork V3](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md) 与 [V3 计划](./surface-work-runtime-v3-rebuild-2026.md)。旧 SurfaceMaterialPass/Dense/Binned 接口不再是当前目标入口。

> 状态：2026-09-27 C0–C8 工程实施与模块集中检查完成；选定 High scalar 已进入唯一 FrameGraph 生产链。真实 GPU 数值消费与画质尚未核对，R05 保持 `not adopted`。设计依据见[Module C 设计](../next-design/surface-fields-xegtao.md)，整体顺序见[架构层计划](./eengine-next-architecture-layer-plan-2026.md)，固定来源与逐阶段对照见[Next 来源账本 R05](../porting/next-renderer.md)。本文是连续编码路线，不是每一小步的许可/验证门禁。

当前实施记录：C0 核对固定源、host 调度及 MIT 许可证；C1 登记 `indirect-visibility` 需求与 Surface 字段语义；C2/C3 实现 reverse-Z 常量、独立 view normal 与五级 weighted depth；C4 实现 64×64 Hilbert LUT、High/Medium scalar MainPass、raw AO 与 packed edges；C5 实现 XeGTAO 对称 edge、leak、四邻/四对角权重、`DenoiseBlurBeta`、非末遍 beta/5、末遍 1.5 恢复与 `max(1,DenoisePasses)`，再用单 writer GPU pass 跨行打包四像素/`u32`，尾字节填 255；C6 以 lit consumer 请求 High scalar，连通 `Visibility depth → preparation → Main → Denoise → pack → Surface`，最宽 Surface 为 16 sampled/16 storage，Dense、Binned、overflow 共用同帧 buffer；`min(materialAO, Xe scalar)` 仅进入 sky/IBL 间接项。C7 清除旧 GTAO/SSGI shader、公开配置/产品模式及无真实消费者的旧 AO debug，记录字段的空间、producer/consumer、过滤与失效、有限候选布局；源码确认粗频规划器只接受同键 Unlit 块，受光像素始终 full rate，AO 私有 scratch/最终 buffer 同帧，LUT/pipeline 随 device epoch 重建。C8 对照上游 point sampler 返工奇数尺寸 Main mip 定位：scratch 保持 16×16 padded reduction，采样 footprint 则按上游真实 mip 的 `max(1, floor(viewport/2^level))`；另运行 typecheck、正式 build、test 构建、15 个 Frame Program/Surface/frequency contract tests，reverse-Z/奇数尺寸 weighted mip 与 split schedule、High/Medium horizon、donor gather/denoise 与跨行 pack 的局部 CPU oracle；修正原有 Surface contract test 的过时五字段假设，并核对 16 sampled/16 storage。Directional/bent、独立 AO history 均未实现。Surface 整体 WGSL 需要 `unrestricted_pointer_parameters`，Renderer 初始化已预检；现用 Naga WASI 不支持该扩展。此前 headless Chrome/Edge 未取得 WebGPU adapter，C8 未跑真实 GPU 输出/消费、browser 或 benchmark；R05 因此仍为 `not adopted`。

## 0. 完成的准确含义与节奏

Module C 结束时，唯一生产链必须存在：`VisibilityKey + reverse-Z depth → XeGTAO depth-normal / weighted depth mip / MainPass / edge-aware denoise → indirect-visibility → Dense/Binned/overflow Surface 间接光 → HDR/motion → Sky/Aerial/FSR3/Present`。选定 scalar High profile 的上游核心阶段和参数保留；directional profile 若声明支持，bent normal 的积分、编码、降噪、消费同样完整。没有独立 frame submit、当前帧 GPU→CPU→GPU work 决策、旧 Three.js GTAO 生产回路或两条 Renderer。

`indirect-visibility` 是这轮的真实跨 owner 字段；XeGTAO working normal、五级 depth mip、raw AO 和 edges 只是 AO owner 的瞬态中间值。**不以全屏 material normal/roughness sidecar 或完整 delayed Lighting topology 作为 AO 接通前提。**仍实现 consumer→semantic demand→有限物理布局的扩展边界，但只分配有真实消费者的资源。

按 C0→C8 顺序推进，在 currentSlice 连续编码。日常 `node tools/vibe.mjs context <path>` 只负责导航；typecheck、build、某个 targeted test 可随调试主动运行，不逐步强制。真实编译失败立即修。只有模块原理与生产链贯通后，集中一次 typecheck、build、必要 targeted tests，修明显问题、同步当前事实/workstream，然后进入 Module D。未运行的检查如实记录；browser matrix、画质/性能基准、P50/P95、formal evidence 和 claims 留到整条 Next Renderer 完成后。

## 1. 开工前读图：owner、入口与实际边

先运行 `node tools/vibe.mjs context OEngine/src/render/surface`、`context OEngine/src/render/program/FrameProgram.ts`，沿真实源码确认当前调用；Surface 接线服从 SurfaceWork V3，不把旧 Surface 名称、`RenderSettings`、`gtao.ts` 或生成状态当生产证据。

| Owner / 当前入口 | C 的动作 | 禁止的误读 |
| --- | --- | --- |
| visibility：`VisibilityFeature`、`RenderTargets.ts`、`FrameProgramLowering.lowerVisibility` | 输出同帧 reverse-Z depth 与有效 VisibilityKey；AO 只读已写完的 depth，背景有明确 mask | `rg16float` HZB 的 min/max 不是 XeGTAO weighted view-depth mip |
| frame-runtime：`FrameProgram.ts`、`FrameProgramLowering.ts`、`FrameProgramBindings.ts`、`FrameCoordinator.ts` | 加 AO 语义产物、producer/consumer 边、有限结构 profile 和 late-bound constants；同一 Graph/submit | 不能让 RendererCore 手写一个不在 Program 中的隐藏 effect，不能私自提交 |
| shading/AO：拟新增 `render/ao/XeGtaoPass.ts` 与 `shaders/xegtao_*.ts` | 管理 donor 阶段、短生命周期 scratch、GPU dispatch 与最终可见性 | 不直接复用旧 `shaders/gtao.ts` 并换名，也不把单个常量 AO 伪装为 provider |
| shading/Surface：`SurfaceMaterialPass.ts`、`SurfaceProducts.ts`、`SurfaceKernelBindingPlan.ts`、`surface_execution.ts`、`surface_material_kernel.ts` | Dense/Binned/fallback 同一 AO 绑定与照明组合，保留现有 work/overflow 互斥 | 不给 AO 增第 17 个 sampled texture；不在 HDR 最后整图相乘 |
| materials/environment：glTF AO 参数、PhysicalSky IBL | glTF occlusion strength 与 Xe scalar 合成；sky diffuse/env specular 各在正确间接分支消费 | 不改 direct Sun 的 shadow 语义，不让未来 SSSR/GI 双重受 AO |
| temporal/presentation：`TemporalFabric.ts`、FSR3、Present | 继续消费已合成 HDR/motion；决定可靠 history 前使用固定 noise index | 不宣称 XeGTAO 已有自己的时序重投影降噪 |

拟新增文件名只是 owner 位置建议。实施时若源码目录重排，保持上述职责和边，不为文档的文件名制造空类。修改稳定跨 owner ABI 时再写 `docs/specs/` 或 `docs/contracts/`；中间类型不强迫单独立约。

## 2. 切换路线总览

```text
C0  固定 donor 与当前事实，核对 source→local profile
 → C1  Frame Program AO 语义需求、profile 和 Graph 边
 → C2  reverse-Z 投影/尺度常量与 depth-normal stage
 → C3  五级 weighted view-depth prefilter
 → C4  XeGTAO horizon MainPass 与 scalar/directional profile
 → C5  edge-aware denoise、最终 packed AO 产物
 → C6  Surface 绑定预算与直接/间接能量接入
 → C7  单链切断、字段物化边界和生命周期
 → C8  大模块一次集中检查、来源状态与 currentSlice 收口
```

C1–C7 可在同一工作分支连续推进。算法 WGSL/CPU oracle 可在实现中作为调试工具；不在每步跑完整验证。生产切换时一次性让 Frame Program 只编排新 XeGTAO，旧 GTAO/SSGI 不作为兼容桥梁。若某选定算法阶段确实无法在目标 WebGPU 能力下保留，记录确切 API/limit 和 source 缺口，选择具名物理改写或具名本地方案；不能删核心分支后仍宣称完整 XeGTAO。

## 3. C0：来源、选中 profile 和现状冻结

1. 对固定 XeGTAO SHA `a5b1686c7ea37788eeb3576b5be47f7c03db532c` 核查根 MIT LICENSE、`XeGTAO.h`、`XeGTAO.hlsli`、`vaGTAO.hlsl`、`vaGTAO.cpp` 的真实函数/宏、host dispatch 和资源格式。阅读 README 对与原论文不同的 near-field、thin occluder、depth MIP、noise、空间降噪和 bent normal 的解释；以源码常量为最终参数依据。
2. 在[来源账本 R05](../porting/next-renderer.md)维持 `not adopted`，逐条列出 `GenerateNormals → PrefilterDepths16x16 → MainPass → DenoisePass/LastPass` 的输入输出、关键分支、局部目标文件和 oracle。CACAO 固定 SHA `0ddca95e6714727a252ead345591ca8f2598f261`、MIT，记为整套替代候选而非混搭来源。旧 Three.js GTAO、Filament AO 仅为对照/组合来源。
3. 核对现有 depth clear、reverse-Z、投影 `device_depth_to_view_space`、内部尺寸、`metersPerWorldUnit`、FSR3 temporal 状态。核对 `SurfaceMaterialPass` 的最宽 16 sampled/15 storage/2 storage-texture 预算和 `maxStorageBufferBindingSize`，并按目标 adapter 查询 AO 自己的 storage texture/格式限制。
4. 选中首版 High scalar（3 slices × 每侧 3 steps）完整 profile；directional High、Medium scalar 作为同 donor 的明确后续档。即使优先做 scalar，也保留源 `#ifdef` 分支的文档映射，不把未做 bent/Ultra 标为已采用。

本步产物是可直接编码的参数表、合法 WebGPU 资源方案及待删生产引用。不是一次独立测试或 evidence 回合。

## 4. C1：Frame Program 的真实 AO 需求和物理计划

**修改入口**：`FrameProgram.ts`、`FrameProgramLowering.ts`、`FrameProgramBindings.ts`、`RendererCore.ts`、`SurfaceProducts.ts`；新 AO owner 由 Renderer 创建并作为 `FrameProgramOwners` 传入。

1. 为 `indirect-visibility` 增 Frame Program Fact：producer `xe-gtao`，consumer `surface`，`internal-full` 像素域，值为非曝光 scalar `[0,1]` 与可选 view-space bent normal，背景/无效值为 `1`。依赖 `depth` 和需要区分背景时的 `visibility`；不要把 Normal、Roughness 假注册为已存在 Graph 产品。内部 scratch 不升格为 Frame Program 产品。同步补齐 `project/domains/frame-runtime.yaml` 的 `render/program/**` 和 `project/domains/shading.yaml` 的拟新增 `render/ao/**` 路由；当前两者会落到 platform 兜底。
2. Request 仅包含结构性 AO profile：`off`、`scalar-high`、以后 `scalar-medium`/`directional-high`，以及实际影响资源布局的能力/格式变体。`hasLit=false`、无有效受光 consumer、空场景或 AO 关闭时，需求闭包不包含 AO stage/中间资源。FrameIndex、NoiseIndex、radius、投影矩阵、material/texture generation 作为执行期值，不进入 topology key。
3. 在 Lowering 中于 Visibility depth 完成后、Surface 注册前调用 AO owner `addToGraph`，把返回的最终 AO ResourceId 传给 `SurfaceMaterialPass.addToGraph`。Graph 的 `read(depth/key)`、AO 中间 `write/read`、Surface `read(indirect-visibility)` 必须能从资源边解释完整顺序；LightCluster/HZB 可保留原独立分支。
4. 把 Surface Demand 的语义层限定为真实需求：AO final visibility 是生产者交付项，Surface normal/roughness 仍是 register-only。对于未来字段，定义 consumer、space、precision、domain、invalid、producer、重建成本和有限 layout 的选择接口，但不创建闲置 pass、texture 或新 HDR writer。

**可观察条件**：`off` 的 Program 无 `xe-gtao` stage；`scalar-high` 有 `depth → AO → surface-radiance` 的完整依赖；改变 scene publication/resource generation 只更新绑定，不产生无意义的新 topology。此时还没有 AO 数学，不能用一张恒等纹理声称 C1 生产集成完成。

## 5. C2：reverse-Z 参数与独立 depth-normal

**上游对照**：`XeGTAO.h::GTAOUpdateConstants`、`XeGTAO.hlsli::XeGTAO_ScreenSpaceToViewSpaceDepth/XeGTAO_ComputeViewspaceNormal`、`vaGTAO.hlsl::CSGenerateNormals`、`vaGTAO.cpp::Compute` 的可选法线分支。

1. 从 EEngine 相机投影和 internal resolution 构造 `ViewportPixelSize`、`DepthUnpackConsts`、`NDCToViewMul/Add`、每像素尺度和 `EffectRadius`。核对 reverse-Z finite/infinite far、Y 翻转、pixel center 与 near/far；不可直接照抄上游正向 depth unpack 常数。`radiusMeters` 经 `metersPerWorldUnit` 只转换一次，实际 shader 半径为 view/world unit。
2. 以 raw `depth32float` 计算 center/L/R/T/B 视空间深度、slope-adjusted edge 和 view-space normal；在 depth 断崖、背景及屏幕边缘 clamp 时保持上游选择。生成的 normal 是 XeGTAO 私有几何尺度 normal，不读材质 normal texture、Surface shading normal 或 coat normal。
3. 选择 WGSL 合法的 normal scratch 编码；优先与上游 `R11G11B10_UNORM` pack/unpack 对照到 `r32uint`，或以数值等价的具名格式适配。WGSL 源与 CPU 数值 oracle 应共用投影/打包常量来源，避免 JS 与 shader 两份“近似参数”。
4. 若未来加入外部 geometry-normal profile，必须单独记录其 VisibilityKey 重建、变换、覆盖/generation 与收益；本轮不为它提前对 Surface 求值、写全屏 sidecar。上游 `GENERATE_NORMALS_INPLACE` 仅在 R32 view depth/精度与性能条件成立时作为明确变体，不能悄悄用 FP16 导致降质。

**局部核对**：近平面、远处/无限 far、斜平面、平面边缘、奇数宽高；normal 单位长度、朝向与 donor 数值关系。可编写一个小 CPU oracle 直接比较投影与 normal，不需要浏览器矩阵。

## 6. C3：weighted view-depth mip 0–4

**上游对照**：`XeGTAO_PrefilterDepths16x16`、`XeGTAO_DepthMIPFilter`、`XeGTAO_ClampDepth`；host 以一个 8×8 工作组覆盖源 16×16，输出五级 view depth。

1. 建立只属于 XeGTAO 的 `r32float` 优先 depth pyramid；Mip0 由 raw reverse-Z 变换得到正 view depth。保留 source 的组内 2×2 取值、最远深度参考、`0.75 × EffectRadius × RadiusMultiplier` 与 falloff 加权过滤，而不是 min/max/平均 HZB 替代。
2. 用 AO owner 自己的 capability preflight 核对五个 storage mip 目标是否允许。同 stage 可合法绑定五个时可保留一 dispatch；仅容四个时将 mip0–3 和 mip4 分成两 dispatch；若只容两个则按同一公式继续分批，每次从前级已完成 mip 取 2×2。核对跨 dispatch 格式量化是否改变边缘结果。不可复用 HZB 的 `rg16float` 资源或过滤代码；所有 dispatch 由相同 FrameCoordinator 命令流编码，无第二次 submit。
3. 所有 mip view 的 baseMipLevel/mipLevelCount、usage、format、逐层尺寸和 workgroup 越界写检查明确；当尺寸不是 16 倍数、mip 变成 1×1 或屏幕边缘落空时采用上游 clamp/有效像素约定。当前分批方案把物理工作 mip 扩至完整 16×16 tile，填充区从 raw depth 点 clamp；消费者须按原 viewport 的逻辑尺寸取样。这样后续 dispatch 能读到 donor 组内的边缘 scratch 值，不能提前裁掉填充区。多 mip 同一纹理读写必须避免同 subresource 同 pass 冲突，并让 FrameGraph 资源边显式表达阶段顺序。
4. `r16float` 可后续作为具名压缩档，但先对照源 FP16/FP32 深度偏置、65504 上限、远景精度与薄物体质量。不能只改格式而继续套 FP32 偏置。

**局部核对**：每层尺寸与四邻权重；平面应保持平滑、深度断层不被远侧错误拉近；上游等价 16×16 tile 的 mip4 与分 dispatch 结果比较。只需一两个小输入 oracle，不造普遍 HZB 测试框架。

## 7. C4：完整 XeGTAO MainPass

**上游对照**：`XeGTAO_MainPass`、`XeGTAO_CalculateEdges`、Hilbert/R2 `SpatioTemporalNoise`、`XeGTAO_OutputWorkingTerm` 和可选 bent normal 分支。

1. 以 view-depth mip、view-space normal 和执行期常量输入，按上游同一方向/双侧 step 更新 horizon。保留 `EffectRadius`、`FalloffRange`、depth mip LOD 选择、sample distribution power、thin-occluder compensation、horizon 下限、角度积分、最终 power=2.2 和 visibility floor。High 为 3 slices × 3 steps/side，不得以 3×3 误计/缩成 9 taps。
2. 使用固定源码默认常量：radius multiplier 1.457、falloff 0.615、distribution 2、thin occluder 0、final power 2.2、MIP offset 3.30；读取 runtime radius 与合法 override。`XE_GTAO_FP32_DEPTHS`/FP16 偏置、`XE_GTAO_GENERATE_NORMALS_INPLACE` 与 `XE_GTAO_USE_DEFAULT_CONSTANTS` 各有清楚 profile 条件。编译期常量可在 WGSL 特化中固化，动态变体不能无缘由扩大 PSO 数。
3. 保留 64×64 Hilbert/R2 双维噪声和 `%64` temporal index。可一次生成小 LUT 后绑定，或用源 Hilbert 算法直接算；上游称 LUT 更快只作为优化假设。Module D 未定义可靠的 history/noise 时先用上游允许的 `NoiseIndex=0`，无需另造 AO 时域滤波。
4. raw AO 与 depth edges 分开输出，edge 四方向各 2 bit 的包码及边界权重对照 source。screen 边界按 point clamp；使用 `textureLoad`/显式合法 LOD 实现 source point sampling，而非把采样器换成线性过滤。无有效 Visibility hit 写中性 AO/edges，不能让背景 depth 变成遮挡者。
5. Directional High 在同一核心积分中得到 bent normal，按 source 可见性+方向打包；标量 High 的无方向结果使用明确 neutral direction。未实现 directional 时不要在 UI、账本或文档写“已完整移植 bent normal”。

**局部核对**：同半径下平面接近 1、墙角/接触区下降、薄遮挡的 near-field 行为、screen edge 不产生远处假影、Medium/High 采样数与常量正确；对 source 数学做 CPU/WGSL oracle，而非只检查 shader 能编译。

## 8. C5：edge-aware denoise 与最终 AO 产物

**上游对照**：`XeGTAO_Denoise`、`XeGTAO_Output`、`vaGTAO.cpp::Compute` 的 `max(1,DenoisePasses)`、非末遍 ping-pong、末遍 finalApply。

1. 保留 source 每遍中心、四邻、四对角的 3×3 edge-aware 权重（双遍的有效邻域可扩至 5×5）、edge packing/unpacking、DenoiseBlurBeta 和 finalApply 的 1.5 scale 恢复；`DenoisePasses=0` 时仍跑一次最终 apply，这不是“可省掉 denoise 阶段”。多个 pass 各有清楚 ping-pong 与 Graph 顺序，不允许同一纹理未定义读写。
2. 标量 raw、edge、final 优先考虑 8-bit 小格式，格式/usage 由设备能力和 WGSL layout 实证决定。最终面向 Surface 的物理产物首选 packed storage buffer：连续四像素的 8-bit scalar visibility 为一个 `u32`；输出线程/工作组必须对每个字有唯一 writer，边界的剩余 1–3 像素填中性值。Directional 为每像素 `u32`，保持 source bent-normal/visibility 编码的精度和方向约定。
3. 如果 source 两像素 denoise 组织改为四像素打包使 register/吞吐退化，可使用完整 denoise → 小格式纹理 → GPU pack 的两阶段物理后端。两者都保留 source 邻域数学，选项需以局部总 GPU 成本和 buffer/texture cache 行为决定；不可因“多一次 pass”就不量测，也不能为省 pass 删中心/四邻/四对角过滤。
4. 最终 buffer 长度、行 pitch、奇数宽度、4K `maxStorageBufferBindingSize`、out-of-bounds load 和 `visibility=1` 的 bit encoding 需预先确定；Surface 的每个合法像素都只读本帧对应 index。若 AO 关闭不保留孤儿 raw/edges/depth pyramid。

**局部核对**：常量 1、孤立遮挡、水平/竖直边、奇数宽、四像素字跨行、末遍 scale、directional 解码后单位长度/可见性，packed buffer 与未打包 reference 逐像素一致。

## 9. C6：Surface 绑定与能量消费

**修改入口**：SurfaceWork V3 的 Work/GeometryRecord/cache/signal owners，以及现有 Filament-derived `specular_ambient_occlusion.ts`；旧 SurfaceMaterialPass/绑定入口仅作为历史基线。

1. 增 `indirect-visibility` 语义角色，按 `AO off/scalar/directional` 编译有限 Surface layout。最宽 `sampledTextures=16` 不得变 17；buffer 后端增一个 read-only storage binding 后 `storageBuffers=16`，仍受设备 admission 检查。布局签名和 Program key 包含 AO 物理 profile，不含 AO 数据版本、frameIndex 或 material generation。Dense、每条 Binned、overflow fallback 都绑定同一当前帧 AO 产品；中性关闭档无 AO 绑定。
2. 在 `sparse_direct` 内把 `direct diffuse/specular`、PhysicalSun、sky diffuse、env specular/base coat/coat lobe、emissive 作为可辨内部语义项。`V = min(glTF materialAO, Xe scalar)` 是首版**本地**合成政策，保留 glTF occlusion strength；它只进入未含遮蔽的间接项。direct、Sun 和 emissive 的算式不乘 V。Material unlit 直接返回 emissive，AO 无意义。
3. Standard 与 Coated 的环境漫反射使用合成 visibility；环境镜面维持 Filament cone/cap specular AO。Directional 档使用 Xe bent normal，经明确 view→world 变换后供反射方向/coat 方向计算；scalar 档说明用 shading/coat normal 的无 bent 近似。不要把 AO scalar 当成某盏光源阴影，也不要在 FSR3 前把整张 HDR 再乘一次。
4. 保留 Sky/IBL 有效 generation、texture route、材质身份与 exception overflow 的既有守卫。AO 的 producer 独立于 Surface queue；Dense 在 AO 前不执行，Binned/fallback 不读上一帧 AO。`SurfaceMaterialPass.addToGraph` 对 AO ResourceId 注册 read；输出 HDR/motion writer 域不因 AO 增加第二 producer。
5. 与后续 provider 固定接口：VSM 只影响 direct light visibility；SSSR 替代对应 env specular 时不能重复 AO；GI 明示 total/delta 和已遮蔽/未遮蔽；glTF AO 是材质微遮蔽输入而不是屏幕空间算法本身。

**局部核对**：无 AO 时原 HDR 同参数等价；AO=0.5 时环境间接变、direct/Sun/emissive 不变；Coated base/coat 两层均按选定可见性处理；Dense/Binned/overflow 同材质输出不因路径而出现不同 AO 规则。Binding layout 在 16 sampled/16 storage 的 profile 下合法。

## 10. C7：字段需求边界、旧路径切断与生命周期

1. 为 future field demand 保存清楚的语义记录：`normal` 分 geometric/view vs shading/world、`roughness` 的 perceptual 定义、`material identity` generation、`motion` 空间、每个字段的实际 consumer/producer、filter/invalid/重算成本。物理布局只定义有限候选，不提前创建纹理或独立 Graph Pass。SSSR 真正接入时再决定 `CompactNormalRoughness` 是否胜过 Visibility 重建，并允许同一 Surface kernel 在寄存器融合光照同时写少量 sidecar。
2. 核对旧 `shaders/gtao.ts` 及 `RenderSettings`/`FrameProducts` 的旧 AO/SSGI API 仍有无非生产调用。生产入口必须只指向 XeGTAO；无消费者的旧源码、配置/历史类型和 debug 说明可直接删或更名，若保留离线 reference 须标离线、不得 import 到 runtime。无需给用户旧/新 AO 开关或桥梁。
3. Size、device epoch、camera cut、scene replacement 和 AO profile 切换只按真实资源及 history 依赖处理：XeGTAO 当前帧 scratch 不持久化；Hilbert LUT/pipeline 是 device-local，丢设备重建；最终 AO buffer 属同帧 Graph。Temporal noise 与 FSR3 history 的事务边界交给 Module D，C 不偷偷持有未经定义的跨帧 AO history。
4. 维持 `FrameCoordinator` 唯一 submit 和 GPU 内资源链；没有 `mapAsync` 等本帧 AO/visible/work 回读决定执行，没有单独 AO queue.submit，没有常量 fallback 掩盖 shader/limit 失败。非支持的格式/资源限制需在创建设备或产品前明确处理，不能把同名近似 AO 当自动降级。

**切断后主链观察表**：

| 场景 | 预期生产事实 |
| --- | --- |
| 空场景 / AO off / 无受光材质 | AO 阶段被需求闭包裁剪；Surface 使用中性间接可见性，仍唯一 Present |
| Standard hot profile | 完整 XeGTAO GPU 链在 Dense 前写最终 visibility，direct/emissive 不变、env 间接受影响 |
| Coated / 其他 texture set | Binned 或 overflow fallback 读同帧 AO，base 与 coat 物理关系一致，无错绑 set 0 |
| 墙角、薄物体、远景、屏幕边缘 | radius、depth mip、thin occluder、edge denoise 条件走 donor 对应分支，无背景假遮挡 |
| 2×2/4×4 Unlit 粗频 | AO 不影响 emissive/Unlit；受光像素当前为 full rate，接触区不随代表点整块复制 |
| resize / device replacement | 同尺寸的新 AO scratch 与 buffer 安全创建，旧 device-local LUT/pipeline 不复用到新 device；无第二 submit |

## 11. C8：大模块集中检查和下一模块交接

等 `depth → normal/prefilter → MainPass → denoise → Surface 间接消费` 在唯一生产 Graph 内闭合后，一次集中执行 engine typecheck、build 与**必要的** focused targeted tests。优先复用/添加少量能证明差异的检查：reverse-Z 投影/尺寸/单位 CPU oracle，XeGTAO 深度 MIP/horizon/edge/denoise 数学对照，packed buffer 编解码和奇数尺寸，Frame Program 裁剪/late binding，16 sampled/16 storage 预算，AO direct/indirect 能量位置，Dense/Binned/overflow 共同消费。不是每修改一个 WGSL 函数就跑全套，不以 browser、formal evidence 或 claim 作为继续编码许可。

收口时逐项读本执行文档：源函数和关键分支有对应 WGSL/CPU oracle；选中 High scalar 确实完成，directional/Medium/Ultra 只按实际完成状态记载；上游许可证与源入口、source→local 阶段表完整；AO scratch 不冒充 HZB；无无用 Surface sidecar；最宽布局合法；direct/emissive 无误乘；一个 production Renderer、一个 submit、无当帧回读控制。更新 `docs/domains/shading.md`/必要 current facts、[来源账本 R05](../porting/next-renderer.md) 的**实际**状态与 active workstream 的 currentSlice/nextModules。只有来源核对、WGSL/CPU oracle 和新主链真实 GPU 消费证据齐备时才提升采用状态；缺其中任何一项就明确保留 `not adopted`，但不因此阻塞下一个模块。

完成 C 后直接进入 Module D（Temporal / Radiometry / Presentation）。整条 Next Renderer 的 browser matrix、resize/camera cut/device loss 系统组合、材质/场景/feature 交互、画质对照、GPU benchmark/P50/P95、正式 evidence 和 claims 留到全架构及计划 providers 完成后集中验收。
