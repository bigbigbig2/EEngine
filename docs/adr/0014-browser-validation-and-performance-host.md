# ADR-0014: 独立浏览器验证与性能宿主

Status: accepted

## Context

Node 测试和示例页无法证明真实 WebGPU 初始化、GPU error、device loss、像素结果、资源销毁或可复现性能。

## Decision

`validation/` 是独立 package，拥有 case registry、浏览器生命周期、版本化协议、内容身份、新鲜度、错误聚合、capture/readback/counter、artifact 和 dispose gate。正式 PERF 使用同一宿主的固定 workload 与 clean revision。

`validation/` 是按需调用的证据宿主，不是每次提交的必跑步骤。验证等级由改动风险和当前声明触发：局部实现默认使用 DEV；跨越真实 GPU producer/consumer、FrameGraph、资源生命周期或设备能力边界时使用命中的 Browser Case 或短 smoke；准备声明 consumer cutover、垂直 Slice 完成或 Runtime Validated 时才运行 MILESTONE；准备作性能结论时才运行 PERF。相关改动可以先合并为一组后集中运行高等级 Case，中间提交不得提前使用尚未取得的完成术语。

## Consequences

示例和测试不能冒充 MILESTONE/PERF。Case 结果必须区分 pass/fail/unsupported；大型 artifact 可外置，但稳定 id/hash 和机器可读摘要必须保留。

## Verification

宿主自身验证协议版本、stale result、console/page/request/GPU error、device loss、timeout、artifact 完整性和资源销毁；证据字段遵循 [VALIDATION](../VALIDATION.md)。

验证延期是允许的开发状态。延期时必须在状态或交付说明中记录未运行的 Case、延期原因和受限声明；延期不能被写成 `Runtime Validated`、`Performance Evaluated`、`Pipeline Feature Complete` 或 `ADR Complete`。这条规则只约束声明的真实性，不把 MILESTONE/PERF 变成每个小步骤的固定成本。
