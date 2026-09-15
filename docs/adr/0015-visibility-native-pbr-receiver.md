# ADR-0015: Visibility-native PBR Receiver

Status: accepted

## Context

固定生成完整 Surface、多个 long-range receiver 和重复 fullscreen composition 会增加显存流量，并让 consumer 需求无法裁剪 producer。

## Decision

从 Visibility 与 active shading revision 直接规划 opaque receiver。receiver、indirect composition 和相关 pyramid/history 由真实 consumer demand 决定；PBR 材质解析、direct lighting 与必要 Surface 输出在 Sparse Shading owner 中融合或共享，不复制 backend。

## Consequences

下游效果必须通过 typed products 声明所需字段；缺失 consumer 时不物化资源。该决策扩展 ADR-0013，不创建新的 Renderer 路径。

## Verification

验证需求裁剪、背景/无效像素、PBR 数值 seam、lighting/GI/AO/SSR/temporal 组合、资源字节、feature-off 和统一正式 PERF；开放项只记录在 [STATUS](../STATUS.md)。
