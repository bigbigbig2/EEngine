# ADR-0016: 虚拟化资产总决策

Status: accepted

## Context

高密度资产需要将离线构建、可寻址内容、GPU residency 和 renderer 消费分离。原始长提案混合了决策、ABI、代码教程和多年阶段，难以判断什么已经生效。

## Decision

虚拟化资产采用 page-oriented、content-addressed Runtime Asset：离线 cooker 生成可独立校验/读取的页和可立即显示的 bootstrap 表示；运行时以显式 residency/generation 发布物理位置；现有唯一 GPU-driven 管线直接消费 resident 数据并产生后续 demand。

拆分为四个窄决策：A 定义 OEGPACK/cooker，B 定义 geometry residency，C 定义现有 renderer 的 V3 消费与 cutover，D 定义基于当前纹理 owner 的渐进 mip residency。GPU decompression、OPFS 强依赖、microtriangle software raster 和 Virtual Texturing 不自动成为基线。

## Consequences

格式与状态机写入 spec，交付切片写入 implementation；研究区完整提案不具有约束力。B 与 C 可以按垂直闭环交错实施，不再按“先写完整基础设施、最后才接消费者”的长阶段推进。

## Verification

每个切片必须产生实际 producer -> consumer、fallback、容量/overflow、生命周期和真实浏览器证据；总体状态见 [STATUS](../STATUS.md)。
