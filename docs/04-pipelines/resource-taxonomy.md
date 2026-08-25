# 帧资源分类（设计层）

> 母本：设计 v2 §17.2

## 1. 三类

| 类 | 生命周期 | 例子 |
|----|----------|------|
| **transient** | 单帧，可 alias | 多数中间 RT、临时 buffer |
| **persistent** | 跨帧 | TAA history、GI probes、部分 shadow cache |
| **external** | 外源 | swapchain、导入纹理 |

## 2. 与模块

```txt
transient：FrameGraph 主责
persistent：声明在 Graph，语义拥有在 Post/GI/Shadow
external：Engine 配置 + 导入器
```

## 3. history 失效（跨 局限 + TAA）

```txt
页隐藏过久 / device lost / 分辨率突变 / 相机切镜
→ persistent history 进入 Invalid
→ 下一帧无 accum 或 fade-in
```

## 4. 别名意图

```txt
Bloom 与 SSR 等可复用临时 RT（Shade）
别名不得破坏「仍被后续 pass 读」的资源
```
