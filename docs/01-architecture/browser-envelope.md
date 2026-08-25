# 浏览器运行外壳（严格来自 docs/source/webgpu-browser-limits.md）

> 母本：`docs/source/webgpu-browser-limits.md`  
> 作用：所有 Layer 1–3 的设计默认运行在此外壳内

## 1. 最大区别

```txt
原生游戏引擎：独立应用进程，尽可能占满资源
Shade / 本工程：浏览器标签页里的一页
```

```txt
OS → 浏览器 → 标签页 → JS/WASM → WebGPU → canvas
```

## 2. 母本各节对应的设计含义

| 母本章 | 设计含义 |
|--------|----------|
| §2 内存 | 引擎内预算 + 承认浏览器可回收/打断；必须处理 device lost |
| §3 资源加载 | 网络/解码/缓存是一等系统，不是 renderer 附属 |
| §4 CPU→GPU 传输 | 少副本、流式、压缩、worker、增量；resident 前有首次喂入成本 |
| §5 标签页生命周期 | visibility；停重负载；temporal history 恢复策略 |
| §6 主线程 | DOM 与渲染准备争用；worker / OffscreenCanvas 方向；非完整 job system |
| §7 多标签竞争 | 性能叙事必须含浏览器负载，不能只报实验室独占 GPU |
| §8 DPR | 禁止无脑 devicePixelRatio；max DPR、动态分辨率、半分辨率效果 |
| §9 无安装优势 | 用户预期轻量 → 画质档位更强制 |
| §10 对比表 | 与 Unity/Unreal 对照时用母本表，不夸大 |
| §11–12 | 强在 renderer 内；卡在 Web 外围 |

## 3. 核心结论（母本原文结构，保留）

```txt
可以把 WebGPU 渲染器做到接近现代游戏引擎的内部管线，
但不能把浏览器标签页变成原生游戏进程。

真正受限常在：
  浏览器内存管理、标签页生命周期、后台节流、Memory Saver、
  网络加载、资源解码、传输路径、JS 主线程、worker 通信、
  多标签页竞争、device lost、用户对网页的轻量化预期
```

定位：

```txt
在受管理、可回收、跨平台、安全沙盒里，
尽可能接近原生现代 renderer 架构。

不是：
  WebGPU 一来，浏览器 = Unreal/Unity 原生运行环境。
```

## 4. 与docs/source/comparison-three-vs-shade.md / 设计 v2 的衔接

```txt
docs/source/comparison-three-vs-shade.md：解决「内部架构学 Shade 还是停 three」
docs/source/webgpu-browser-limits.md：解决「就算内部学成了，外壳仍是网页」
设计 v2 P10：Browser constraints are first-class
```

三者同时写入工程叙事，缺一不可。
