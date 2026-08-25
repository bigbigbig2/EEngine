# M14 · Browser Resilience（浏览器韧性）

## 1. 一句话职责

把 **标签页生命周期、device lost、DPR/分辨率策略** 做成一等能力，供 Engine / Post / 主循环使用。

## 2. 为什么独立成模块

这是 Web 相对原生引擎的核心差异（见 `docs/source/webgpu-browser-limits.md`）。若散落在示例代码里，产品级必炸。

## 3. 拥有 / 不拥有

### 拥有

```txt
- Page Visibility 处理策略
- device.lost → 重建流程编排（调用 M01/M04 re-init）
- maxDPR / internal render scale 策略
- 后台降载（停 rAF、停重 pass）
- 恢复时 invalidate temporal history（调 M13）
```

### 不拥有

```txt
- 具体 pass 实现
- 资源加载 CDN 策略的全部（可协作，默认不独吞资产系统）
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | M01；钩子到 M13 history；主循环宿主 |
| 被依赖 | 应用入口、Renderer 门面 |

## 5. 对外概念接口

```txt
attachBrowserHooks(runtime)
setResolutionPolicy({ maxDPR, renderScale })
onVisibilityChange / onDeviceLost 策略表
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `visibility.md` | 前后台 | 未写 |
| `device-lost.md` | 丢失重建 | 未写 |
| `resolution.md` | DPR/动态分辨率 | 未写 |
| `interface.md` | API | 未写 |

## 7. 关联

- 原则：P8  
- 母本：`docs/source/webgpu-browser-limits.md`；设计 v2 风险与浏览器约束  
- 总册（后写）：`06-constraints/`  
