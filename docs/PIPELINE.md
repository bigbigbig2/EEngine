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

`FrameContext` 是每次 encode 的冻结值合同，只发布 camera/view、internal/output resolution、feature topology、history validity、单一 Render World scene bindings、instrumentation 和一次性 capture 请求。Pass 不接收公开 Renderer 或 GraphicsContext service locator。`MainRenderPipeline` 是 Feature 顺序、FrameProducts 连接、FrameGraph recipe、compiled graph cache 与 graph evidence 的唯一 owner；cache key 覆盖 capability、分辨率、feature topology、唯一 visibility 实现的可变配置、instrumentation 和 history format，不再包含路径选择维度。

`scene-update` 开始前必须从 `GpuRenderWorld` 解析已注册 runtime；未注册 Scene 直接失败。Packed source 的显式 batch 与普通 Scene adapter 的 `SceneChangeSet` 都由 `GpuRenderWorld.encodePendingPatch()` 转为同一 `GpuScene` patch。普通 Scene 稳定帧不扫描对象树；transform/material assignment 增量提交，add/remove/geometry 变化要求调用 `resyncScene()`。共享 `GPUSceneEnvironmentContext` 独立同步 light/environment，`GPUViewContext` 只绑定环境和 camera/view/HZB。

`shadow-update` 由 Scene-scoped `ShadowFeature` 单入口编码。该 Feature 同时拥有 atlas、directional cascade fit/texel snapping、camera/content revision cache、统一 Render World hierarchy work generation/raster 和 GPU-completion retire；Packed source 与普通 Scene adapter 发布同一 `ShadowVisibilityFrame`、atlas、counter 与设置合同。关闭阴影时 `ShadowFeatureManager` 不创建 owner；已有 owner 在当前提交完成后销毁，Lighting 收到 cascade count 为零的产品。

## GPU Work Contract

`GpuWorkGenerationAbi.ts` 定义当前工作队列 ABI。每个新增 GPU 队列必须同时定义元素 schema/stride、header、capacity、overflow、producer、consumer、indirect 参数和统计 counter。`attempted` 反映真实申请，`written` 只能反映安全写入；overflow 不得通过截断伪装成功。

工作生成只有在 GPU producer 产生的 buffer/indirect args 被 GPU raster/compute consumer 直接使用时才完成。CPU 可以配置 dispatch，不能遍历原始对象重建最终可见列表。

## Visibility-to-Surface Contract

Hardware Visibility 使用 reverse-Z depth 并直接输出 `VisibilityKey`。Key 必须稳定定位 exact-raster identity 和材质 kernel class；无效 key 使用明确 sentinel，并由 counter/debug view 暴露。

SurfaceFeature 消费正式 Visibility/ExactRaster 产品：

1. 初始化时对 `depth32float/equal` 做真实设备 probe。
2. probe 成功时使用 MaterialClassDepth；失败时在创建 Surface owner 前选择 `class-discard` fallback。
3. fullscreen material kernel 通过统一 `GpuSurfaceAbi` 输出 Surface；consumer 不根据附件顺序猜测语义。
4. TriangleSetup candidate cache 默认是显式 opt-in；关闭时没有 setup allocation、FrameGraph resource 或 clear。
5. Tile backend 目前只有 evidence gate，不存在生产 queue、pass、shader 或 submit。

长期决定和进入新 backend 的门槛见 [ADR-0004](./adr/0004-visibility-to-surface.md)。

## Frame Products

`FrameProducts.ts` 是跨 Pass 资源字段的事实源：

- `SurfaceFrame`：depth、PBR、normal、albedo/AO、emissive、必有 metadata 与可选 velocity，域为 `internal-full`。
- `DirectLightingFrame`：direct-only linear HDR。
- `OpaqueLightingFrame`：完整不透明 HDR、IBL specular、indirect diffuse。
- `LightClusterFrame`：parameters/lookup/data、candidate/active light list 与可选 counters。
- `ShadowVisibilityFrame`：atlas、可选 contact visibility 与 cascade/filter 参数，不拥有 HDR target。
- `AmbientOcclusionFrame`：visibility 与 bent normal。
- `ReflectionFrame`：resolved specular、confidence、variance。
- `TemporalSurfaceFrame`：velocity、history confidence、reactive、classification。

跨 resolution domain 必须声明转换 owner；消费者不能靠尺寸相同猜测兼容。

## Lighting、Transparency 与 Temporal

Direct lighting 先消费 Surface、cluster 和 shadow。GI/AO/reflection 通过各自 Service 组合到统一 opaque HDR。生产 Scene runtime 统一使用有界 TransparentRasterWork 与 MBOIT，并输出 reactive/counters。Temporal 对两种输入消费相同 velocity、reactive、classification 和 history confidence；camera cut、尺寸、配置或提交失败必须使相应 history 失效。Lighting、GI、SSR correction 和 debug view 只接受带 metadata 的统一 Surface，不再编译无 metadata shader 变体。

## FrameGraph 与提交

FrameGraph 声明读写依赖、资源域和 enabled 条件，编译后裁剪无消费者节点。正常主帧目标是一个 command encoder/main submit；必要的异步 readback 在提交后完成，不能阻塞下一帧或回控可见工作。

## Feature-off

Feature 关闭时不得构造对应 GPU owner、Pass、attachment、history、readback、counter copy 或额外 submit。延迟创建 owner 必须有明确 destroy/retire 路径。Shadow 关闭态的机器门禁额外检查 atlas/work owner、Shadow GPU/CPU phase、I/O label 和 counter 均缺席或为零，同时保持一个 main submit。

## 已收敛的运行路径

生产代码只有一个 GPU Render World、一个 VisibilityKey-to-Surface 合同和一条主管线。旧 owner、Pass、shader、attachment、公开 evidence 字段与 packed/legacy graph 分支已删除；新增功能只能扩展统一合同，不能恢复隐藏 fallback。

收敛顺序与验证合同由 [ADR-0006](./adr/0006-packed-render-world-convergence.md) 固定。
