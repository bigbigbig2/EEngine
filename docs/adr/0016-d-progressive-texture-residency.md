# ADR-0016-D: Progressive Texture Delivery 与 Physical Residency

Status: accepted

## Context

当前 TextureAssetPackage V2、GPU-native variants、`TextureResidency` 和稳定 TextureBindingSet 已解决格式选择与绑定，但“分批下载 mip”与“实际减少物理纹理内存”是两个不同问题。向一个已按完整尺寸分配的普通 `GPUTexture` 逐步写入高 mip，只改善网络和首帧，不等于释放未上传 mip 的显存。

## Decision

保留现有纹理 owner 和稳定 handle/material routing，并明确两种独立模式：

- Mode A，渐进传输：先取得始终可采样的 mip tail，再按预算下载/解码/上传高分辨率 mip。它优化首帧和带宽，但不得宣称未上传 mip 带来真实物理 residency 节省。
- Mode B，物理分级：只有通过独立 texture allocation、尺寸层级/整纹理替换或未来另立 ADR 的 Virtual Texturing 实际降低 allocation 时，才称为 physical residency。promotion 先构造并填充新 physical tier，再通过稳定 logical handle/generation 原子切换，旧 tier 在提交安全边界后释放。

两种模式都要求始终存在 sampling-complete 的 fallback，保持 texture handle 和材质 identity 稳定。Geometry 与 texture 可共享高层优先级信号，但各自拥有 budget、请求队列、publication 和 failure policy。

优先验证现有 container 是否可表达独立 mip range、variant identity 和压缩对齐；只有证据证明不足时才设计新 `.oetpack`。KTX2/Basis 是否 runtime transcode 由网络、Worker、峰值内存、上传和 CDN variant 成本决定。Virtual Texturing 不是本决策基线。

## Consequences

实现和指标必须分别报告下载字节、decode/upload、allocated texture bytes 与稳定帧成本，不能把 Mode A 的收益记作 Mode B。物理 tier 替换会带来瞬时双份内存，必须在 admission 时计入 transaction peak。

纹理 streaming 不与 geometry page heap 强行共用状态机；共同点仅限统一 scene publication、generation、安全退休和全局预算协调。跨 CPU/GPU 的精确 mip/tier 合同必须在实现前进入独立 spec。

本 ADR 不把 Nyx 的 geometry 算法来源扩展为纹理算法来源。纹理 codec、mip/tier 和 binding 只沿 OEngine 现有 TextureAssetPackage/TextureResidency 合同演进；不得以“Nyx 移植”名义自创未经登记的 Virtual Texturing 算法。

## Verification

Mode A 验证首帧 mip tail、sampling completeness、逐级清晰度、Range/codec failure、upload budget 和 cache-off；Mode B 额外验证真实 allocation bytes、transaction peak、稳定 handle、原子 promotion/rollback、eviction 和 device loss。所有性能与画质结论使用固定 workload，feature-off 不保留请求、资源、readback 或 submit。
