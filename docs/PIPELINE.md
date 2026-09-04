# OEngine 帧管线

## 当前主帧

```text
scene-update
  → optional lpv-update / shadow-update
  → main-view-graph
  → VisibilityKey + depth
  → Surface + optional velocity
  → clustered direct light + shadow + GI/AO/reflection
  → transparency
  → temporal/upscale
  → HDR post + present
```

`FramePlan` 只验证跨图依赖顺序；启用阶段仍记录到 Renderer 的主 command context。`main-view-graph` 必须等待本帧启用的 scene、LPV 和 shadow 更新。

## GPU Work Contract

`GpuWorkGenerationAbi.ts` 当前 ABI version 为 5。每个新增 GPU 队列必须同时定义元素 schema/stride、header、capacity、overflow、producer、consumer、indirect 参数和统计 counter。`attempted` 反映真实申请，`written` 只能反映安全写入；overflow 不得通过截断伪装成功。

工作生成只有在 GPU producer 产生的 buffer/indirect args 被 GPU raster/compute consumer 直接使用时才完成。CPU 可以配置 dispatch，不能遍历原始对象重建最终可见列表。

## Visibility Contract

Hardware-first Visibility 使用 reverse-Z depth 和直接 `VisibilityKey`。Key 必须能稳定定位 instance、geometry/cluster/primitive 与材质重建所需数据；无效 key 使用明确 sentinel，并由 counter/debug view 暴露。Software/Hybrid raster 不是当前正确性依赖。

## Frame Products

`FrameProducts.ts` 是跨 Pass 资源字段的事实源：

- `SurfaceFrame`：`depth`、`pbr`、`normal`、`albedoAo`、`emissive`、可选 `velocity`、可选 `metadata`，域为 `internal-full`。
- `DirectLightingFrame`：direct-only linear HDR。
- `OpaqueLightingFrame`：完整不透明 `hdr`、`iblSpecular`、`indirectDiffuse`。
- `LightClusterFrame`：parameters/lookup/data、candidate/active light list 与可选 counters。
- `ShadowVisibilityFrame`：atlas、可选 contact visibility 与 cascade/filter 参数，不拥有 HDR target。
- `AmbientOcclusionFrame`：visibility 与 bent normal。
- `ReflectionFrame`：resolved specular、confidence、variance。
- `TemporalSurfaceFrame`：velocity、history confidence、reactive、classification。

跨 resolution domain 必须声明转换 owner；消费者不能靠尺寸相同猜测兼容。

## Lighting、Transparency 与 Temporal

Direct lighting 先消费 Surface、cluster 和 shadow。GI/AO/reflection 通过各自 Service 组合到统一 opaque HDR。TransparencyFeature 在 Packed MBOIT 与 legacy OIT 之间选路，Packed 路径额外输出 reactive/counters。Temporal 消费 velocity、reactive、classification 和 history confidence；camera cut、尺寸、配置或提交失败必须使相应 history 失效。

## FrameGraph 与提交

FrameGraph 声明读写依赖、资源域和 enabled 条件，编译后裁剪无消费者节点。正常主帧目标是一个 command encoder/main submit；必要的异步 readback 在提交后完成，不能阻塞下一帧或回控可见工作。

## Feature-off

Feature 关闭时不得构造对应 GPU owner、Pass、attachment、history、readback、counter copy 或额外 submit。延迟创建 owner 必须有明确 destroy/retire 路径。

## 尚未统一的路径

普通 Scene 的 Material Expand、独立 Velocity 和 legacy OIT 仍与 Packed 路径并存；它们是迁移债务。任何新功能只能接入统一产品合同，不得再扩张旧路径。
