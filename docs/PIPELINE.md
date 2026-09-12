# OEngine 帧管线

## 当前主帧

```text
scene-update
  → optional shadow-update
  → main-view-graph
  → VisibilityKey + depth
  → Surface + optional velocity
  → clustered direct light + shadow + GI/AO/reflection
  → transparency
  → temporal/upscale
  → HDR post + present
```

`FramePlan` 只验证跨图依赖顺序；`MainRenderPipeline` 把启用阶段记录到唯一主 command context。`main-view-graph` 必须等待本帧启用的 scene 和 shadow 更新。旧对象 runtime 驱动的 probe-atlas 更新已经删除；现有 LPV atlas 是只读采样资源，不会生成独立更新图或 submit。

主管线的 WebGPU specialization 遵循 [WEBGPU.md](./WEBGPU.md)：先冻结 capability record，再选择 Shader、format、compressed asset 和 pass-local resource 实现。能力差异只能改变同一节点/产品的内部实现和 cache key，不能复制 FramePlan、FrameProducts 或 Renderer。Visibility 在 `primitive-index` 已启用时消费 fragment builtin，缺失时消费 vertex 派生的 flat local triangle；两者写同一 VisibilityKey。Immediate Data 只替代小常量传递；Transient Attachment 只用于不离开当前 render pass 的 attachment。

`FrameContext` 是每次 encode 的冻结值合同，只发布 camera/view、internal/output resolution、feature topology、history validity、单一 Render World scene bindings、instrumentation 和一次性 capture 请求。Pass 不接收公开 Renderer 或 GraphicsContext service locator。`MainRenderPipeline` 是 Feature 顺序、FrameProducts 连接、FrameGraph recipe、compiled graph cache 与 graph evidence 的唯一 owner；cache key 覆盖 capability、分辨率、feature topology、唯一 visibility 实现的可变配置、instrumentation 和 history format，不再包含路径选择维度。

`scene-update` 开始前必须从 `GpuRenderWorld` 解析已注册 runtime；未注册 Scene 直接失败。Packed source 的显式 batch 与普通 Scene adapter 的 `SceneChangeSet` 都由 `GpuRenderWorld.encodePendingPatch()` 转为同一 `GpuScene` patch。Instance record 的前 64 B 是低频 static identity/bounds，后 112 B 是 current/previous-from-current affine、revision 与 motion state；static、transform、material、visibility/lifecycle patch 分流，稳定帧不写入，transform patch 只上传 dynamic region。普通 Scene 稳定帧不扫描对象树；transform/material assignment 增量提交，add/remove/geometry 变化要求调用 `resyncScene()`。共享 `GPUSceneEnvironmentContext` 独立同步 light/environment，`GPUViewContext` 只绑定环境和 camera/view/HZB。

材质纹理的 CPU-heavy preparation 位于主帧外：GPU-native package 直接使用，KTX2 UASTC/ETC1S 则由惰性 `AssetCodecService → bounded Worker pool → pinned libktx WASM` 产生相同 Encoded Variant/package；Worker 不接收 GPU object。随后在同一 scene stage 事务内由 `TextureResidency` 选择 exact physical variant、直接写入完整离线 mip chain，并发布 stable handle、material-local TextureRef routing 和 `TextureBindingSetId`。每个 material 的所有 texture semantic 必须 preflight 到一个有界 set；GPU classification 以 `KernelClassId × TextureBindingSetId` 驱动固定数量的 Material Resolve、Visibility MASK、Shadow MASK 和 Transparency consumer，不回读可见材质。未 Cook `ShadeImage` 只作为 development fallback，仍可进入 RGBA8 size-class 与 runtime mip 路径，但不能作为 Texture Package V3 完成证据。

`shadow-update` 由 Scene-scoped `ShadowFeature` 单入口编码。该 Feature 同时拥有 atlas、directional cascade fit/texel snapping、camera/content revision cache、统一 Render World hierarchy work generation/raster 和 GPU-completion retire；Packed source 与普通 Scene adapter 发布同一 `ShadowVisibilityFrame`、atlas、counter 与设置合同。关闭阴影时 `ShadowFeatureManager` 不创建 owner；已有 owner 在当前提交完成后销毁，Lighting 收到 cascade count 为零的产品。

## GPU Work Contract

`GpuWorkGenerationAbi.ts` 定义当前工作队列 ABI。每个新增 GPU 队列必须同时定义元素 schema/stride、header、capacity、overflow、producer、consumer、indirect 参数和统计 counter。`attempted` 反映真实申请，`written` 只能反映安全写入；overflow 不得通过截断伪装成功。

工作生成只有在 GPU producer 产生的 buffer/indirect args 被 GPU raster/compute consumer 直接使用时才完成。CPU 可以配置 dispatch，不能遍历原始对象重建最终可见列表。

## Visibility-to-Surface Contract

Hardware Visibility 使用 reverse-Z depth 并直接输出 `VisibilityKey`。Key 必须稳定定位 exact-raster identity 和材质 kernel class；无效 key 使用明确 sentinel，并由 counter/debug view 暴露。

Geometry consumer 通过共享 byte-addressed decode ABI 读取 `static-pbr-compact-v2`：AABB-relative UNORM16 position、oct SNORM16 normal、SNORM16 tangent、float16 UV 与 UNORM8 color。Meshlet/cluster bounds 必须包含 quantization 误差；Visibility、Shadow、Material Resolve 与 Transparency 不得各自复制或猜测 decode 规则。

SurfaceFeature 消费正式 Visibility/ExactRaster 产品：

1. MaterialTileWork classifier 直接读取 VisibilityKey/material records，在 GPU 上发布固定 28 类 queue 与 indirect args。
2. Compute material evaluator 是唯一 opaque full-material owner；ClassDepth probe/pass 和 class-discard backend 不再初始化、编译或提交。
3. evaluator 直接发布 versioned compact working set 与 `ShadingSurfaceLiteFrame`；consumer 按命名产品绑定，不再经过 Surface V1 格式 bridge，也不根据附件顺序猜测语义。
4. TriangleSetup candidate cache 默认是显式 opt-in；关闭时没有 setup allocation、FrameGraph resource 或 clear。Compute evaluator 的默认 projected-triangle gradient 不依赖该 cache。

旧 Visibility-to-Surface 选择背景见 [ADR-0004](./adr/0004-visibility-to-surface.md)；当前替代决定以 [ADR-0009](./adr/0009-compute-shading-and-advanced-frame-pipeline-v2.md) 为准。

## Frame Products

`FrameProducts.ts` 是跨 Pass 资源字段的事实源：

- `ComputeMaterialEvaluationFrame`：唯一 full-material evaluator 的紧凑工作集，域为 `internal-full`，Velocity 按 consumer topology 可空。
- `ShadingSurfaceLiteFrame`：world-space normal、roughness/flags 与可选 metallic/specular classification；不携带 depth 或 velocity。
- `DiffuseSurfaceLiteFrame`：仅由 SSGI/refraction-like consumer 请求的 receiver diffuse/material-AO/validity 逻辑产品。
- `PreExposedOpaqueHdrBaselineFrame`：screen-space diffuse 之后、SSR correction 之前的 opaque HDR；baseline specular 与 SSR consumer 同生同灭。
- `OpaqueColorPyramidFrame`：`rgba16float`、`internal-full` 的 post-screen-space-diffuse/pre-SSR mip 产品；只允许 SSR/未来折射类 consumer 使用，不能冒充 pre-SSGI radiance source。
- `FinalColorPyramidFrame`：`rgba16float`、`output-full` 的 post-transparency/temporal final HDR mip 产品；`source` 明确指向其 output-full mip0，并由 Bloom 与 Exposure 共享。
- `DirectLightingFrame`：direct-only linear HDR。
- `OpaqueLightingFrame`：完整不透明 HDR、IBL specular、indirect diffuse。
- `LightClusterFrame`：parameters/lookup/data、candidate/active light list 与可选 counters。
- `ShadowVisibilityFrame`：atlas、可选 contact visibility 与 cascade/filter 参数，不拥有 HDR target。
- `AmbientOcclusionFrame`：visibility 与 bent normal。
- `ReflectionFrame`：resolved specular、confidence、variance。
- `TemporalSurfaceFrame`：velocity、history confidence、reactive、classification。
- `TemporalReconstructionFrame`：`internal-full` HDR 到 `output-full` HDR 的权威时域重建产品；TAA 的 confidence 为同一 `rgba16float` 输出 alpha 中的 history lock，NSS 的 confidence 留在独立 feedback history，二者都从统一 history/representation revision source 取代际。

跨 resolution domain 必须声明转换 owner；消费者不能靠尺寸相同猜测兼容。

## Lighting、Transparency 与 Temporal

MaterialTileWork 的 8×8 GPU classifier 先按 `KernelClassId × TextureBindingSetId` 生成 28 个有界 queue 和 indirect args。Production material evaluation 从 VisibilityKey V2 恢复 MeshletWork/local primitive，读取 canonical compact vertex，计算 perspective-correct barycentric 与显式 UV `ddx/ddy`，按 7 个 KernelClass × 最多 4 个 TextureBindingSet 执行固定 28 次 `dispatchWorkgroupsIndirect`。有效梯度使用 `textureSampleGrad`，退化梯度明确使用 `textureSampleLevel(..., 0)` 并通过 Surface flag/counter 暴露；active class 和可见材质均不回读 CPU。该 compute evaluator 是 opaque 完整材质求值的唯一 production owner，并写 queue consumed 与 exactly-once pixel claim。

Clustered direct lighting 复用同一 MaterialTileWork，再以一个共享 compute pipeline 固定执行 28 次 indirect dispatch，消费 compact material working set、cluster 和 shadow 并写 HDR；它不再增加 material claim，只验证 evaluator 的 valid/shaded、unassigned、duplicate、overflow 和 generation closure，GPU finalizer 写 `frameInvalid`，Tonemap 将失败帧显示为 diagnostic magenta。旧 MaterialClassDepth probe/pass、class-discard owner、fullscreen raster material/direct-lighting 路径、Surface V1 bridge 及其 26 B/pixel attachments 已删除。

当前 SurfaceLite physical profile 为 `rgba16uint normal + rgba8unorm albedo/AO + rg32uint material/emissive`，无 motion consumer 时 20 B/pixel；Velocity consumer 存在时增加 `rg16float`，为 24 B/pixel。Velocity-off 使用独立静态 shader interface，bind layout、资源创建、clear/store 都不含 velocity，不使用 dummy texture。MaterialId debug 从 `VisibilityKey → MeshletWork` 恢复，不再复制 per-pixel material slot。主 HDR/颜色 history 的独立 ABI 为 `pre-exposed-rgba16float-v1`（8 B/pixel）；`rg11b10ufloat` 因无 alpha、无有符号表示且不能作为统一 render/storage/history 合同而没有成为主管线格式，仍可由 RGB-only companion product 单独门禁采用。

GI/AO/reflection 通过各自 Service 组合到统一 opaque HDR。公开 topology 使用单值 `screenSpaceDiffuseMode = off | gtao | ssgi`，GTAO 与 SSGI 不会同时创建 owner、history 或 Pass。

`mode=gtao` 只运行一个 Three.js r186-derived horizon producer：half-resolution high profile 以 3 directions × 6 bidirectional steps 读取 reverse-Z Depth/shared HZB/compact normal，并保留 magic-square rotation 与精确 Three.js `interleavedGradientNoise + rand` step phase，同一次 trace 累计 ambient visibility 与 world-space bent normal。AO、second moment 与 oct bent normal 打包在 `rgba16float` 中共同经过 spatial/temporal filter，唯一 joint depth/normal resolve 输出 full-resolution `r8unorm` visibility 与 `rg16uint` bent normal；没有旧 AO、独立 bent pass、three.js TRAA/RenderTarget owner 或额外 submit。

`mode=ssgi` 先让选定 long-range provider 产生不含 screen AO/SSGI/SSR 的 `PreExposedOpaqueRadianceSource`，并仅在该 topology 下物化 resolved long-range diffuse 与 baseline specular。Three.js r186-derived 32-zone horizon-bitfield trace 从该 full-resolution source 采集 incident diffuse radiance，同时产生 AO、bent normal 与 confidence；joint spatial/TemporalHistoryRegistry filter 后一次 full-resolution resolve 发布 `r8unorm visibility + rg16uint bent + rgba16float incident GI + r8unorm confidence`。同一个 trace 显式支持 `samplingDomain=world|screen`：默认 `world` 将 `radiusMeters` 按 `metersPerWorldUnit` 投影，`screen` 则保留 Three.js 的 `screenSpaceRadius × (traceWidth/2)/16` 步进；切换只失效 SSGI history，不创建第二套 pass/resource。temporal-off direction/offset 都固定为上游值 1，initial-step rand 与 slice interleaved-gradient noise 保留上游公式，单侧射线出屏后提前结束剩余 step。`ScreenSpaceDiffuseResolve` 只替换 long-range diffuse/specular 的 screen-space visibility 并对 incident GI 施加一次 receiver diffuse/Material AO；direct、emissive、unlit 不乘 AO。SSR 开启时 baseline specular 留给 reflection correction 替换，避免重复 subtract。

长程 GI 的 production owner 是单个 `LongRangeDiffuseProviderPass`。它在每个有效 receiver 内按 `Brick4 bounds/tree validity → Probe Volume tetra coverage → IBL → black` 早返回：Brick4 命中时不执行 Probe/IBL，Probe 只处理 Brick4 miss，IBL 只处理两个空间 provider 的 miss；不会先生成三张 fullscreen candidate。输出的两张 `rgba16float` transient 分别携带 selected diffuse irradiance 与 selected specular radiance，alpha 精确编码唯一 provider id；raw radiometric products 与 receiver-resolved `resolvedDiffuse`/`baselineSpecular` 在 TypeScript ABI 中也是不同字段，禁止互换。Brick4 V1 使用保持现有 WGSL storage 偏移的设备无关 package；validator 保证完整 tree/probe 闭包，整个 generation 以 immutable GPUBuffer 原子驻留，replacement buffer 在 submitted-work boundary 后退役。world-space bounds/tree 就是 receiver mapping；`actual generation != expected generation` 或未驻留时不读取旧 buffer，直接计数并回退。LPV 使用 source/GPU generation parity 和 tetra coverage；schema v21 统一统计选择与失败。旧 scene-wide mode、公开枚举、topology bit、不可达分支及其 pass/shader 已删除。SSGI 关闭时 `DiffuseSurfaceLite` 只是已存在 compact Surface 通道的逻辑别名，不产生 SSGI-only attachment；SSGI owner、四张 history、component MRT、trace/filter/resolve 与 evidence dispatch 全部裁剪。

选定 provider 的 diffuse irradiance/specular radiance 只进入一个 `OpaqueLightingResolvePass`。该 pass 唯一负责 receiver BRDF energy compensation、Material AO/screen visibility、bent-normal specular occlusion 与 additive HDR composition：无 correction consumer 时只写 HDR；SSR-only 时用两 MRT 额外写 BRDF-weighted/occluded `PreExposedBaselineSpecular`；SSGI 时才用三 MRT 再写 resolved long-range diffuse。raw provider specular radiance 绝不能直接作为 SSR subtract baseline。生产 Scene runtime 统一使用有界 TransparentRasterWork 与 MBOIT，并输出 reactive/counters。Temporal 对两种输入消费相同 velocity、reactive、classification 和 history confidence；camera cut、尺寸、配置或提交失败必须使相应 history 失效。GI、SSR correction 和 debug view 只接受命名 compact products，不再编译 Surface V1 变体。

SSR production owner 使用 pinned three.js r186-derived 算法链，但保留 OEngine reverse-Z HZB、FrameGraph 与 reflection replacement 语义：bounded GGX VNDF trace 先写 `rg32uint` hit/confidence/diagnostics，`SharedColorPyramidPass` 在 screen-space diffuse resolve 后、SSR correction 前生成唯一 `OpaqueColorPyramid`，hit shading 从它读取 mip radiance，再写 receiver-resolved pre-exposed specular RGB 与 dominant ray length。SSR 已不再持有私有 `ssr_prefilter` shader、pipeline 或 texture。过滤顺序固定为 `TemporalReproject(specular, external history) → 8-tap Vogel RecurrentDenoise(history owner)`，时域输入联合 receiver/hit-point velocity、shared occlusion confidence、surface validity、YCoCg variance clipping、HDR luminance damping和 pre-exposure ratio；半分辨率才增加一次 joint bilateral upscale。最终 correction 只加 `confidence × (SSRSpecular - PreExposedBaselineSpecular)`，miss/edge/roughness/distance/disocclusion invalid 均保持 Local Probe/IBL baseline。SSR 不直接采样 environment/LPV，不采用 Three example 的 environment suppression 或 additive composite；temporal 关闭时不分配 SSR history，SSR feature 关闭时 opaque pyramid、trace/filter/baseline attachment/correction 全部裁剪。

Shared Depth/HZB 继续由 per-view `HierarchicalZBuffer` 以一个 current resource、一次 compute pass和有界 mip dispatch生产，GTAO/SSGI/SSR 不创建 effect-local HZB。共享派生颜色由一个 `SharedColorPyramidPass` 管理，但两个颜色语义绝不物理或逻辑混同。`OpaqueColorPyramid` 固定最多 5 mip：mip0 复制完整 opaque baseline，第一次 reduction 以 reverse-Z depth 去除背景并按 inverse luminance 加权，后续 mip 使用有界 2×2 线性 reduction；当前唯一 consumer 是 SSR。`FinalColorPyramid` 固定最多 6 mip，在 transparency、TAA/NSS 和可选 motion blur 后从 output-domain HDR 生成，Bloom 与 Automatic Exposure 同时打开时仍只有一个 producer。两者均为 transient `RENDER_ATTACHMENT | TEXTURE_BINDING`，没有 readback、private submit 或跨帧 owner。第一版 SSGI 继续直接读取 full-resolution `PreExposedOpaqueRadianceSource`；没有性能/质量 benchmark 授权，因而不创建 `ScreenSpaceDiffuseSourcePyramid`，也不将 pre-SSGI source 与 post-SSGI opaque pyramid alias。

Bloom 不再生成自己的 downsample texture。它从 `FinalColorPyramid` mip1 起逐层做高光提取，以最小 mip 为重建起点，再按 mip 由低到高做 3×3 filtered reconstruction，只保留 half-resolution 起始的 Bloom 专用重建 pyramid。普通帧不再把它先合成到一张 full-resolution HDR：唯一 `Final Output` swapchain pass按静态 specialization直接读取 scene HDR与Bloom mip0，依次执行 `Bloom composite → Color Grading → optional Sharpen → Exposure → SDR/HDR Tone Mapping → output encoding/dither`。Bloom-off variant物理移除 bloom texture/sampler binding，Sharpen-off variant物理移除四个邻域 scene/Bloom/grade读取；color grading参数继续late-bound，不产生独立 `rgba16float` attachment。

`post-color-grading` one-shot capture 是唯一需要 materialize post HDR boundary 的例外。该 instrumentation topology按原顺序执行 Bloom composite与ColorGrading到 `rgba16float COPY_SRC`，在同一 main command中copy到有界readback buffer；Final Output识别输入已经grade/bloom，只融合可选Sharpen和display mapping，避免双重处理。capture完成后的普通帧返回fusion recipe；capture-only ColorGrading owner不持有GPU资源，首次惰性创建后保留仅用于安全复用已编译graph回调。Render debug output同样由Final Output选择无Bloom/grade/sharpen的静态variant，只执行exposure/display mapping；它的输入固定为post-temporal/motion-blur、pre-post-effects HDR，同帧capture instrumentation不得改变debug观察值。Automatic Exposure histogram仍固定读取 `FinalColorPyramid` 最低可用 mip，而不是再次扫描 full-resolution HDR；128-bin log-luminance percentile reduction与adapted scalar history保持独立语义。

所有 persistent effect history 的逻辑生命周期归 `TemporalHistoryRegistry`，GPU texture/buffer 仍归具体 Feature。当前显式声明 `color`、`gtao`、`ssgi`、`ssr`、`nss-feedback`、`exposure` 六种 semantic，各自冻结 resolution domain、format、physical buffer count、pre-exposure policy、generation、validity、read/write index 与 reset reason。camera cut、output/internal resize、render scale、feature topology、format、lighting、scene/view、representation、device/pre-exposure generation、explicit change 和 aborted encode 都通过统一 invalidation path；只有 main command 成功完成才切换 ping-pong index并发布 valid。GTAO 的非 HDR history 不做 exposure 变换；TAA、SSGI、SSR 的 working-linear history在同 generation 内按 `current multiplier / committed multiplier` 重标定，不兼容时 shader 在采样旧内容前拒绝；NSS feedback 与 Exposure scalar 使用 generation-discontinuity invalidation。NSS feedback 与 Exposure 不再用 frame parity自行推进，均消费 registry 的 submission-aware read/write slot。

Temporal production resolve 显式区分 internal 与 output domain。当前 TAA owner 在 output resolution 执行：从 reverse-Z 最接近表面选择 internal-pixel velocity，消费 compact surface validity、MBOIT reactive mask 与 shared disocclusion confidence，先拒绝 invalid motion、阈值以上 reactive、disocclusion、越界或不兼容 pre-exposure history，再对剩余 history 做 YCoCg neighborhood variance clip、相对亮度抑制、motion fade 与渐进 history lock。internal color 的放大重建使用九次 bilinear gather 的 Catmull-Rom footprint，而不是 16 次逐 tap gather；native-resolution 路径保持直接 `textureLoad`。输出是唯一 `rgba16float` output-domain color history，RGB 为 pre-exposed working-linear HDR，alpha 为可观察 history-lock confidence；FinalColorPyramid、Exposure、Bloom 与 Tonemap 只消费该时域结果之后的 source。

分辨率策略同样只有一套 `RenderSettings.resolution` 权威。`mode=fixed` 是默认和所有 formal benchmark 的强制模式，`internalScale` 在整个采样窗口固定且不消费 GPU timing；手工设置 `internal_resolution_scale` 也会明确切回 fixed。`mode=adaptive` 只在 Temporal Reconstruction 开启时合法，默认范围为 `0.67..1.0`，只在 `[0.67, 0.75, 0.8, 0.9, 1]` 稳定 bucket 间变化，并声明 target frame rate、tolerance 与 settle frames。控制器只接受产生帧之后完成的 GPU timestamp，忽略 current-frame/duplicate/invalid sample，使用 fast/slow mean、warm-up、dead band、异常值 clamp、probe slope、boundary lockout 与 delayed feedback；每次 bucket 变化走同一 `RenderSettings` mutation seam，触发 internal resize、jitter sequence重算和统一 history invalidation。缺少 `timestamp-query` 时 adaptive 保持当前 bucket而不是用 CPU 时间伪装 GPU 反馈。公开 evidence/counters 区分 mode、bucket/range/target、accepted sample、scale change、last decision 与 feedback latency。

## FrameGraph 与提交

FrameGraph 声明读写依赖、资源域和 enabled 条件，编译后裁剪无消费者节点。正常主帧目标是一个 command encoder/main submit；必要的异步 readback 在提交后完成，不能阻塞下一帧或回控可见工作。

## Feature-off

Feature 关闭时不得构造对应 GPU owner、Pass、attachment、history、readback、counter copy 或额外 submit。延迟创建 owner 必须有明确 destroy/retire 路径。Shadow 关闭态的机器门禁额外检查 atlas/work owner、Shadow GPU/CPU phase、I/O label 和 counter 均缺席或为零，同时保持一个 main submit。

## 已收敛的运行路径

生产代码只有一个 GPU Render World、一个 VisibilityKey-to-Surface 合同和一条主管线。旧 owner、Pass、shader、attachment、公开 evidence 字段与 packed/legacy graph 分支已删除；新增功能只能扩展统一合同，不能恢复隐藏 fallback。

收敛顺序与验证合同由 [ADR-0006](./adr/0006-packed-render-world-convergence.md) 固定。
