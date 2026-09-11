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
- `DirectLightingFrame`：direct-only linear HDR。
- `OpaqueLightingFrame`：完整不透明 HDR、IBL specular、indirect diffuse。
- `LightClusterFrame`：parameters/lookup/data、candidate/active light list 与可选 counters。
- `ShadowVisibilityFrame`：atlas、可选 contact visibility 与 cascade/filter 参数，不拥有 HDR target。
- `AmbientOcclusionFrame`：visibility 与 bent normal。
- `ReflectionFrame`：resolved specular、confidence、variance。
- `TemporalSurfaceFrame`：velocity、history confidence、reactive、classification。

跨 resolution domain 必须声明转换 owner；消费者不能靠尺寸相同猜测兼容。

## Lighting、Transparency 与 Temporal

MaterialTileWork 的 8×8 GPU classifier 先按 `KernelClassId × TextureBindingSetId` 生成 28 个有界 queue 和 indirect args。Production material evaluation 从 VisibilityKey V2 恢复 MeshletWork/local primitive，读取 canonical compact vertex，计算 perspective-correct barycentric 与显式 UV `ddx/ddy`，按 7 个 KernelClass × 最多 4 个 TextureBindingSet 执行固定 28 次 `dispatchWorkgroupsIndirect`。有效梯度使用 `textureSampleGrad`，退化梯度明确使用 `textureSampleLevel(..., 0)` 并通过 Surface flag/counter 暴露；active class 和可见材质均不回读 CPU。该 compute evaluator 是 opaque 完整材质求值的唯一 production owner，并写 queue consumed 与 exactly-once pixel claim。

Clustered direct lighting 复用同一 MaterialTileWork，再以一个共享 compute pipeline 固定执行 28 次 indirect dispatch，消费 compact material working set、cluster 和 shadow 并写 HDR；它不再增加 material claim，只验证 evaluator 的 valid/shaded、unassigned、duplicate、overflow 和 generation closure，GPU finalizer 写 `frameInvalid`，Tonemap 将失败帧显示为 diagnostic magenta。旧 MaterialClassDepth probe/pass、class-discard owner、fullscreen raster material/direct-lighting 路径、Surface V1 bridge 及其 26 B/pixel attachments 已删除。

当前 SurfaceLite physical profile 为 `rgba16uint normal + rgba8unorm albedo/AO + rg32uint material/emissive`，无 motion consumer 时 20 B/pixel；Velocity consumer 存在时增加 `rg16float`，为 24 B/pixel。Velocity-off 使用独立静态 shader interface，bind layout、资源创建、clear/store 都不含 velocity，不使用 dummy texture。MaterialId debug 从 `VisibilityKey → MeshletWork` 恢复，不再复制 per-pixel material slot。主 HDR/颜色 history 的独立 ABI 为 `pre-exposed-rgba16float-v1`（8 B/pixel）；`rg11b10ufloat` 因无 alpha、无有符号表示且不能作为统一 render/storage/history 合同而没有成为主管线格式，仍可由 RGB-only companion product 单独门禁采用。

GI/AO/reflection 通过各自 Service 组合到统一 opaque HDR。`mode=gtao` 只运行一个 Three.js r186-derived horizon producer：half-resolution high profile 以 3 directions × 6 bidirectional steps 读取 reverse-Z Depth/shared HZB/compact normal，同一次 trace 累计 ambient visibility 与 world-space bent normal。AO、second moment 与 oct bent normal 打包在 `rgba16float` 中共同经过 spatial/temporal filter，唯一 joint depth/normal resolve 输出 full-resolution `r8unorm` visibility 与 `rg16uint` bent normal；没有旧 AO、独立 bent pass、three.js TRAA/RenderTarget owner 或额外 submit。关闭 GTAO 时 owner、两张 history、全部相关 pass/attachment/evidence dispatch 均裁剪。

IBL 与 Probe Volume diffuse、BRDF energy compensation、environment specular、bent-normal specular occlusion 和 additive HDR composition 由一个 fused baseline pass 完成；第二个 `PreExposedBaselineSpecular` MRT 仅在 SSR correction consumer 存在时创建。Brick4 在 SSR off 时同样走 fused HDR path。生产 Scene runtime 统一使用有界 TransparentRasterWork 与 MBOIT，并输出 reactive/counters。Temporal 对两种输入消费相同 velocity、reactive、classification 和 history confidence；camera cut、尺寸、配置或提交失败必须使相应 history 失效。GI、SSR correction 和 debug view 只接受命名 compact products，不再编译 Surface V1 变体。

## FrameGraph 与提交

FrameGraph 声明读写依赖、资源域和 enabled 条件，编译后裁剪无消费者节点。正常主帧目标是一个 command encoder/main submit；必要的异步 readback 在提交后完成，不能阻塞下一帧或回控可见工作。

## Feature-off

Feature 关闭时不得构造对应 GPU owner、Pass、attachment、history、readback、counter copy 或额外 submit。延迟创建 owner 必须有明确 destroy/retire 路径。Shadow 关闭态的机器门禁额外检查 atlas/work owner、Shadow GPU/CPU phase、I/O label 和 counter 均缺席或为零，同时保持一个 main submit。

## 已收敛的运行路径

生产代码只有一个 GPU Render World、一个 VisibilityKey-to-Surface 合同和一条主管线。旧 owner、Pass、shader、attachment、公开 evidence 字段与 packed/legacy graph 分支已删除；新增功能只能扩展统一合同，不能恢复隐藏 fallback。

收敛顺序与验证合同由 [ADR-0006](./adr/0006-packed-render-world-convergence.md) 固定。
