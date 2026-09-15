# ADR-0016-B: Virtual Geometry Residency

Status: proposed

## Context

OEGPACK 页只有进入有界 GPU heap、被原子发布并由 renderer 使用，才构成运行时虚拟几何；单纯 range read 或预加载整包没有解决 residency。

## Decision

运行时使用固定 slot bank 管理 decoded geometry page。CPU scheduler 消费有界、延迟的 GPU demand feedback，执行 source range read、Worker decode/verify、批量 upload 和 generation publication；eviction 只能在提交边界安全进行。bootstrap/ancestor 页提供始终可绘制 fallback。

共享语义由 [Virtual Geometry Runtime V1 spec](../specs/virtual-geometry-runtime-v1.md) 起草。OPFS 仅可作为可选 source/cache adapter，不能成为 correctness 或首帧关键路径。

## Consequences

需要显式 budget、优先级、去重、取消、backpressure、retry 和 device-loss 语义。CPU readback 只调度页 I/O，不生成最终可见 meshlet 列表。

## Verification

验证 demand -> resident -> consumer 闭环、重复/过期 request、overflow、budget、eviction race、取消、source failure、device loss、feature-off 和每帧 upload/readback 上限。
