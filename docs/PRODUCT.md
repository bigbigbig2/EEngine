---
id: product
state: current
verifies:
  - OEngine/src
  - docs/next-design
---
# OEngine 产品边界

## 定位

OEngine 是面向桌面浏览器 WebGPU 的 GPU-first 渲染引擎核心，服务中大型、高几何密度、静态或 mostly-static 场景。EEngine Next 的目标是 GPU-ready 资产、紧凑 GPU 表、Packed Instances、层次 GPU Work、Hardware-first Visibility、Visibility-driven Surface、按需求和频率着色、统一 Light Transport 与 Temporal Reconstruction。目标方向不代表当前生产链已完成这些能力。

## 目标平台与工作负载

- 主要 profile：支持 core WebGPU 的桌面浏览器和独立 GPU；以 `core-features-and-limits` 明确验证，不把 compatibility mode 当作目标性能平台。
- 能力线：采用 [WebGPU 2026 Desktop](./WEBGPU.md)。主路径优先使用已进入 2026 WebGPU/WGSL 规范且设备实际暴露的 subgroup、primitive identity、f16、texture format/compression、Immediate Data 与 Transient Attachment 能力；所有 specialization 共享一条 Renderer 和逻辑 ABI。
- 非基线能力：不默认依赖 64 位原子、multi-draw-indirect、mesh/task shader、buffer device address、bindless/resource table 或仍处于 Draft 的扩展。
- 场景：多个资产和材质、大量实例、高三角形密度、少量显式 transform/material patch。
- 更新模型：bulk/mostly-static GPU Scene，不为当前阶段扩张完整 ECS 或 Gameplay 生命周期。

## 核心能力

- Web 主路线从 GLB/glTF 通过有界 WASM + Worker Runtime Cooker 渐进生成可验证的 GPU-ready Geometry Product；独立 Native/OEGPACK 预处理是第二输入路线。两者共享 Runtime admission、Residency 与唯一 Renderer，不要求共享 Cooker 实现。
- Runtime Asset 与 `GpuAssetStore`、`GpuScene`、Packed Scene GPU 资源所有权分离。
- hierarchy/SSE/culling/work generation 在 GPU producer 到 indirect consumer 之间闭环。
- Hardware-first Visibility 输出 `VisibilityKey + Depth`，为按需 Surface 重建提供 opaque fact；Surface 产品可按消费者需求重算、物化或复用。
- Demand-driven GPU Work 将可见性、材质、ray/page/probe 等有界工作接到真实 GPU consumer；Adaptive Shading 的 full/coarse/reconstructed/reused 结果必须满足各自合法性和质量边界。
- 一条主管线组织统一 Light Transport、物理环境、参与介质和 Temporal Reconstruction；Shadow、GI、AO、Reflection 等是具名 Provider，不各自复制 Renderer 主链。
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
