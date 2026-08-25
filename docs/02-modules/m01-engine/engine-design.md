# M01 · Engine 设计

> 母本：设计 v2 §19；docs/source/webgpu-fundamentals.md；webgpu-browser-limits device lost

## 1. 职责

```txt
Adapter → Device → Queue
Canvas configure
资源创建/销毁池
ShaderModule / Pipeline / BindGroup 缓存
（可选）timestamp query
device.lost 信号
```

## 2. 不职责

```txt
Scene 语义
Material 白名单
Pass 业务算法
```

## 3. 初始化意图

```txt
requestAdapter（powerPreference 等）
requestDevice（requiredFeatures / limits）
getPreferredCanvasFormat + configure
失败：明确错误（无 WebGPU / 无特性）
```

## 4. Limits / Features 意图

```txt
按 Layer 3 需求抬 limits（storage、texture array 层等）
不可用则：功能降级路径或启动失败（可配置）
记录实际 adapter.limits 供调试
```

## 5. Cache 键意图

```txt
PipelineKey：shader 变体 + 顶点布局 + 目标格式 + 深度/混合状态
BindGroupKey：layout + 资源身份版本
避免每帧 createRenderPipeline
```

## 6. Lost 与重建

```txt
lost → 通知 M14/应用
旧 buffer/texture/pipeline 全废
World id 可保留 → 全量 re-upload + 重建 pipeline cache
```

## 7. 与docs/source/webgpu-fundamentals.md

```txt
CommandEncoder / RenderPass / submit
是本模块提供的「动词」
FrameGraph 编排何时调用这些动词
```
