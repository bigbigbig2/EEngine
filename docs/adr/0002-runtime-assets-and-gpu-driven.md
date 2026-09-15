# ADR-0002: Runtime Asset 与 GPU-driven 边界

Status: accepted

## Context

Loader 对象、设备无关资产与 GPU allocation 生命周期不同。把它们混为一个 owner 会导致重复上传、隐式持有和 CPU 每帧重建工作。

## Decision

Cooker 生成可验证 Runtime Asset；`GpuAssetStore`、`GpuScene` 和 GPU work owners 分别管理资源、实例与工作队列。Loader 不持有长期 GPU 资源。GPU producer 输出必须由 GPU consumer 直接消费，并具有容量、overflow 和 counter。

## Consequences

资产身份可以跨设备稳定，GPU generation 和 retire 由 Renderer 生命周期管理。实现复杂度转移到显式 publication、patch、residency 和提交边界，但避免 service locator 与 CPU visible-list fallback。

## Verification

检查 ownership、重复上传、generation/retire、queue overflow 和 GPU producer -> consumer；完成术语遵循 [VALIDATION](../VALIDATION.md)。
