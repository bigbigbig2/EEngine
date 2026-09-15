# ADR-0008: GPU-driven Geometry 与 Hardware Visibility

Status: accepted

## Context

高几何密度场景不能依赖 CPU 逐对象/逐 meshlet 生成最终 draw，也不能用 Pass 数量代替 GPU-driven 闭环。

## Decision

GPU hierarchy/SSE/culling 产生有界 work queue 和 indirect args，hardware meshlet raster 直接消费并输出稳定 `VisibilityKey + depth`。队列定义容量、overflow、有效计数和 fail-closed identity。

## Consequences

CPU 可做有界调度 readback，但不得重建最终列表。虚拟几何只替换 resident geometry/hierarchy 的来源与地址解析，继续使用这条 visibility 管线，不创建 Nyx 专用 backend。

## Verification

验证 GPU producer -> indirect consumer、near/far 与遮挡边界、overflow、VisibilityKey 唯一性、零工作、feature-off 和真实像素结果。
