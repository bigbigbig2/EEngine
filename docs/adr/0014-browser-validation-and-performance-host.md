# ADR-0014: 独立浏览器验证与性能宿主

Status: accepted

## Context

Node 测试和示例页无法证明真实 WebGPU 初始化、GPU error、device loss、像素结果、资源销毁或可复现性能。

## Decision

`validation/` 是独立 package，拥有 case registry、浏览器生命周期、版本化协议、内容身份、新鲜度、错误聚合、capture/readback/counter、artifact 和 dispose gate。正式 PERF 使用同一宿主的固定 workload 与 clean revision。

## Consequences

示例和测试不能冒充 MILESTONE/PERF。Case 结果必须区分 pass/fail/unsupported；大型 artifact 可外置，但稳定 id/hash 和机器可读摘要必须保留。

## Verification

宿主自身验证协议版本、stale result、console/page/request/GPU error、device loss、timeout、artifact 完整性和资源销毁；证据字段遵循 [VALIDATION](../VALIDATION.md)。
