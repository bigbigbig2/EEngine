# ADR-0003 · 统一渲染管线

Status: accepted

## Context

多套 Core/Quality/Experimental 管线会复制材质、光照、时域和资源生命周期，且让功能关闭仍保留固定成本。Visibility 之后的消费者需要稳定产品而不是共享 attachment 顺序知识。

## Decision

- 一条主管线承载 Visibility、Single Material Resolve、Surface、Lighting、Transparency、Temporal 和 Post。
- `FrameProducts.ts` 定义跨 Pass 产品；Feature/Service 拥有功能生命周期，Renderer 只做 composition。
- `FrameGraph` 声明资源依赖并裁剪 disabled/unconsumed work；`FramePlan` 只处理跨图顺序。
- 正常主帧使用单 command encoder/main submit。
- 功能关闭时不创建对应 Pass、资源、history、readback 或额外 submit。
- 完成必须有正确性、counter/timestamp、内存和同条件性能证据。

## Consequences

Packed/legacy 只能作为迁移期分支，不能演化成永久独立主管线。算法可以替换，但必须维持 Surface/Lighting/Temporal 等产品合同。没有运行证据的类、Pass 或 Shader 不构成完成。

## Verification

检查 FrameGraph dump、FramePlan order、产品 domain、main submit 数、history invalidation、feature-off 资源缺席和 [VALIDATION.md](../VALIDATION.md) 的目标场景证据。
