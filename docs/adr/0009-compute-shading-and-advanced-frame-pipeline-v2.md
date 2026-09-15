# ADR-0009: Advanced Frame Pipeline

Status: accepted

## Context

Lighting、GI/AO/SSR、transparency、temporal 与 post 若各自复制 receiver、pyramid、history 或 submit，会放大带宽和生命周期错误。

## Decision

所有渲染功能接入统一 FrameGraph，通过 typed `FrameProducts` 按 consumer demand 生成 Surface、velocity、pyramid、lighting 和 history。公共 reduction/receiver 只存在一个语义 owner；功能关闭时依赖链被裁剪。

## Consequences

效果实现必须声明输入语义和 history invalidation，不能私建等价 fullscreen 产品或独立主管线。物理 allocation 可以复用，但不同语义产品不能混同。

## Verification

以 compiled graph、resource accounting、history lifecycle、feature-off、截图/数值 seam 和统一 PERF workload 证明；当前完成状态只写入 [STATUS](../STATUS.md)。
