# ADR-0012: Example Library 边界

Status: accepted

## Context

把示例、浏览器验证和正式性能 runner 混在一起会使生命周期、错误采集和 evidence 语义不可靠。

## Decision

`examples/` 只作为 standalone Vite MPA + Storybook iframe catalog，不提供 Browser Case 或 PERF Runner。真实验证由 [ADR-0014](./0014-browser-validation-and-performance-host.md) 的独立 `validation/` package 承担。

## Consequences

新功能可以有示例，但示例成功不构成 Runtime Validated。旧 fixture/runner 不作为兼容目标，也不恢复占位成功 case。

## Verification

检查 examples 无验证协议和正式 benchmark ownership；所有运行声明都能路由到 validation registry 与新鲜 artifact。
