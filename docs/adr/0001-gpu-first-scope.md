# ADR-0001 · GPU-first 范围

Status: accepted

## Context

OEngine 需要在桌面浏览器中处理高几何密度和大量 mostly-static 实例。WebGPU 没有跨设备保证 native 引擎常用的 MDI、mesh shader、64 位原子或 buffer address。

## Decision

- 以桌面 WebGPU、独立 GPU 和中大型 mostly-static 场景为当前产品范围。
- 以 Hardware-first Visibility 为生产路径；Software/Hybrid 只作为未来适配器，不是正确性前提。
- 资产、工作生成、可见性、材质和效果按 GPU-first 数据流设计。
- 不建设完整 Gameplay/ECS、超大世界或 three.js 兼容层。

## Consequences

所有核心方案必须在 WebGPU baseline 上工作；可选能力只能产生显式加速路径。CPU patch 可以存在，但 CPU 不负责构建最终可见列表。产品范围外能力进入 `PRODUCT.md` Deferred，而不是预埋第二套主管线。

## Verification

检查 adapter capability、GPU producer/consumer、Hardware Visibility debug/counter、feature-off 和目标 workload。性能结论遵循 [VALIDATION.md](../VALIDATION.md)。
