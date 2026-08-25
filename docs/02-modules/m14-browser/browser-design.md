# M14 · Browser 设计

> 母本：docs/source/webgpu-browser-limits.md；P10

## 1. 钩子清单

```txt
visibilitychange → 暂停/恢复策略
device.lost → 重建编排
resize / DPR 变化 → 分辨率策略
page lifecycle（若可用）→ 加强回收意识
```

## 2. 可见性策略意图

```txt
hidden：
  停 rAF 或降到极低
  停重 pass（GI/SSR 更新）
  标记 history 可能过期

shown：
  检查 device
  invalidate 或 fade history
  可选 warm-up 一帧
```

## 3. 分辨率策略意图

```txt
maxDPR clamp
internal render scale
与 GBuffer/后处理分辨率一致
禁止默认无限 devicePixelRatio
```

## 4. Lost 重建顺序意图

```txt
1. 丢弃 GPU 对象
2. 重建 device/context（或新 device）
3. 重建 pipeline cache
4. 按 World 全量 re-upload
5. 重建 FrameGraph 持久资源
6. 清 history
```

## 5. 与主循环所有权

```txt
应用或 Renderer 门面拥有 rAF
M14 提供策略回调，不强制独吞循环
```
