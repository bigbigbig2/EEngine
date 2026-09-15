# ADR-0007: GPU-native Runtime Assets 与 Residency

Status: accepted

## Context

运行时即时转换和整包上传无法稳定控制格式、峰值内存、上传量与资源寿命。

## Decision

Cooker 输出带内容身份、变体、边界和校验的设备无关 package。GPU owner 按 capability 选择现成变体，以 stable handle/generation 发布 residency；logical asset 与 physical allocation 分离。

## Consequences

Cook 成为产品链路，fallback 必须显式存在于 package 或配置中。旧 geometry V2 只有在 [ADR-0016-C](./0016-c-v3-geometry-consumption.md) 完成生产 cutover 后才可删除；纹理 V2 ownership 继续作为后续渐进 residency 的基础。

## Verification

对 package 做 golden/corruption 验证，对 residency 做 dedupe、budget、generation、atomic publish、retire 和 device-loss 验证；GPU consumer 必须使用发布后的 handle。
