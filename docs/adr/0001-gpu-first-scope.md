# ADR-0001: GPU-first 产品范围

Status: accepted

## Context

OEngine 面向桌面 WebGPU 的中大型、高几何密度、mostly-static 场景。通用 Gameplay/ECS、超大世界和 three.js 兼容会稀释当前最关键的 GPU 数据与渲染闭环。

## Decision

优先 GPU-ready 资产、紧凑 GPU 表、Packed Instances、GPU hierarchy/work、hardware visibility、一次材质解析及统一 lighting/temporal/post 管线。CPU 只处理导入、显式 patch、配置与编排，不构建最终可见列表。

## Consequences

公开 API 和生命周期围绕渲染核心设计；完整 ECS、Gameplay、网络同步、超大世界和生态兼容均不进入当前范围。新增能力必须证明适合目标 workload，而非仅追求通用性。

## Verification

范围审查以 [PRODUCT](../PRODUCT.md) 为准；GPU-driven 声明必须满足 [VALIDATION](../VALIDATION.md) 的 producer/consumer 与运行证据要求。
