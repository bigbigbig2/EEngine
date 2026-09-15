# ADR-0010: WebGPU 2026 Desktop 能力合同

Status: accepted

## Context

以浏览器版本或 GPU 型号猜测 feature 会产生错误 Shader、不可复现 benchmark 和多套管线。

## Decision

产品能力线为 WebGPU 2026 Desktop。初始化读取 adapter/device feature、limit、WGSL language feature 和 API surface；只请求真实 consumer 所需能力，并冻结 capability record。可选能力使用同一逻辑 ABI 的 specialization，或在资源创建前明确拒绝配置。

## Consequences

不提供独立 portable renderer。64 位原子、multi-draw-indirect、mesh/task shader、buffer device address、通用 bindless 和 draft 能力不作为默认依赖。具体当前能力表由 [WEBGPU](../WEBGPU.md) 维护。

## Verification

真实浏览器 artifact 保存 capability fingerprint、requested/actual limits 和 specialization；缺失能力路径验证等价语义或显式失败。
