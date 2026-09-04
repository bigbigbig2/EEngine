# OEngine 产品边界

## 定位

OEngine 是面向桌面浏览器 WebGPU 的 GPU-first 渲染引擎核心，服务中大型、高几何密度、静态或 mostly-static 场景。它优先构建 GPU-ready 资产、紧凑 GPU 表、Packed Instances、层次工作生成、Hardware-first Visibility、单次材质解析、动态光照与时域管线。

## 目标平台与工作负载

- 主要 profile：支持 WebGPU 的桌面浏览器和独立 GPU。
- 能力基线：WebGPU 标准能力；不默认依赖 64 位原子、multi-draw-indirect、mesh/task shader、buffer device address 或 subgroup。
- 场景：多个资产和材质、大量实例、高三角形密度、少量显式 transform/material patch。
- 更新模型：bulk/mostly-static GPU Scene，不为当前阶段扩张完整 ECS 或 Gameplay 生命周期。

## 核心能力

- Cooker 生成可验证、可复现的 GPU-ready Runtime Asset。
- Runtime Asset 与 `GpuAssetStore`、`GpuScene`、Packed Scene GPU 资源所有权分离。
- hierarchy/SSE/culling/work generation 在 GPU producer 到 indirect consumer 之间闭环。
- Hardware-first Visibility 输出直接 `VisibilityKey`，材质按可见像素分类并解析一次。
- 一条主管线组合 direct lighting、shadow、GI、AO、reflection、transparency、temporal 和 post。
- Feature 关闭时移除对应 Pass、资源、history、readback 和独立 submit。

## 产品目标

固定目标为 1920×1080、DPR 1、60 FPS，即 16.667 ms GPU 帧预算。该目标目前没有在目标设备、固定工作负载和完整画质下得到可复现证明，不得写成已达成。

## 非目标

- 不兼容 three.js 运行时或生态。
- 不建设超大世界、完整 Gameplay 引擎、通用 ECS 或网络同步。
- 不为 benchmark、效果档位或实验路径复制 Renderer 主管线。
- 不以 Pass/Shader/类名数量代替运行证据。
- 不把 Loader 临时对象变成长生命周期 GPU owner。

## Deferred

Software/Hybrid raster、超大世界 streaming、完整动画/蒙皮生态、native-only GPU 能力和外部插件系统均延后。它们只有在当前 Hardware-first 产品路径出现可测量阻塞时才进入 ADR。
