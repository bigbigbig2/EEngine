# ADR-0002 · Runtime Asset 与 GPU-driven

Status: accepted

## Context

Loader 对象、运行时资产事实和设备 GPU 对象若混为一体，会导致重复解析、生命周期不清和每帧 CPU 扫描。高实例/高几何场景需要稳定紧凑表和有界 GPU 工作队列。

## Decision

- Cooker 输出验证过、带 recipe/provenance 的设备无关 Runtime Asset。
- `GpuAssetStore`、`GpuScene` 和 Packed registry 分别拥有 residency、instance patch 与 Packed runtime。
- Geometry/Meshlet/Cluster/Material/Texture/Instance 使用明确紧凑 ABI。
- hierarchy/SSE/culling 产生有界 GPU work；GPU producer 直接连接 indirect GPU consumer。
- `VisibilityKey` 是可见像素到 instance/geometry/primitive/material 重建的稳定合同。
- 每个队列定义 header、element stride、capacity、overflow、producer、consumer 和 counter。

## Consequences

Loader 临时对象不能拥有长期 GPU 资源；共享资产与实例分离。Overflow 是可观测失败，不能静默丢工作。新数据表必须同步 TypeScript/WGSL schema、版本和验证；不得通过兼容层长期保留重复 owner。

## Verification

验证 package reopen/determinism、handle generation、显式 patch、capacity 边界、overflow counter、indirect args、CPU oracle 和 GPU consumer 闭环。外部算法来源见 [porting](../porting/README.md)。
