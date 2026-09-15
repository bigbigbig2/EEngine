# ADR-0016-D: Progressive Texture Residency

Status: proposed

## Context

当前 TextureAssetPackage V2、GPU-native variants、TextureResidency 和 TextureBindingSet 已解决格式选择与稳定绑定；全量重写会丢失这些已验证边界。仍缺少的是按预算渐进提升纹理细节。

## Decision

在现有纹理 ownership 上增加始终 resident 的 mip tail 和可独立请求/发布的高 mip。texture handle、material routing 与 binding identity 保持稳定；promotion/eviction 通过 generation 和提交边界生效。

先用现有 container 能否表达 partial mip range 作为实现约束。只有 range/压缩/内容身份证据证明必要时才引入新 `.oetpack`。Virtual Texturing、反馈贴图和 tiled physical atlas 不是本决策基线，若需要必须另立 ADR。

## Consequences

第一阶段只解决渐进 mip residency，不与 geometry pages 强行共用 heap/queue。需要独立 budget、请求优先级、sampling completeness 与 compressed mip alignment 规则。

## Verification

验证首帧 mip tail、逐级 promotion、缺页采样正确性、稳定 binding、eviction/device loss、upload budget、feature-off 和固定 workload 的画质/内存/帧时间证据。
