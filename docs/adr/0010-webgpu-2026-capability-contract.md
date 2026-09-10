# ADR-0010 · WebGPU 2026 Desktop 能力合同

Status: accepted

## Context

ADR-0001、0004 和 0006 形成时，OEngine 用“WebGPU baseline”表达跨设备正确性，并把 subgroup 等能力统一视为 optional accelerator。2026 WebGPU/WGSL 已加入 core/compatibility feature level、subgroups、primitive index、texture format tiers、subgroup size control、Immediate Data 和 Transient Attachments。继续使用旧表述会让产品目标、Renderer device creation 和 ADR-0007/0008/0009 的设计中心互相冲突。

与此同时，进入规范不等于所有目标浏览器已经暴露；有些能力通过 `GPUFeatureName` 协商，有些通过 WGSL language feature、limit 或 API surface 暴露。multi-draw-indirect、mesh/task shader、buffer device address、通用 bindless 和 64 位通用原子仍不能作为标准 WebGPU 生产前提。

## Decision

- 采用 [WebGPU 2026 Desktop](../WEBGPU.md) 作为唯一目标能力线，要求 core adapter 和 `core-features-and-limits`，不把 compatibility mode 当作目标性能平台。
- 主路径优先使用 adapter 实际支持且生产 owner 实际消费的 `subgroups`、`primitive-index`、`shader-f16`、texture format/compression 等规范能力。
- Immediate Data 与 Transient Attachments 按 2026 core API 能力处理，通过 API/WGSL/limit 探测，不伪装成 `GPUFeatureName`。
- 所有 capability specialization 共享 Renderer、GPU queue/asset ABI、FrameProducts 和验证 oracle。能力缺失只允许等价 specialization 或创建资源前的明确拒绝。
- Renderer 只请求实际会使用的 feature/limit，并冻结完整 capability record；pipeline/FrameGraph cache 与 benchmark provenance 记录最终启用集合和 specialization。
- 正式性能验证使用目标 adapter 最终选择的一个综合 profile，不维护 Desktop/Portable 双正式基准；fallback 以命中的正确性和 parity 验证覆盖。
- Draft proposal 和 native-only 能力只有经新 ADR 扩大产品能力线后才能成为生产依赖。

本 ADR 只替代 ADR-0001、0004、0006 中关于“不能假设 subgroup/旧 WebGPU baseline”的能力口径，不改变它们的 GPU producer→consumer、统一 Surface、单主管线、owner 和 feature-off 决策。

## Consequences

- `docs/WEBGPU.md` 成为 feature、limit、WGSL/API 探测和 specialization 的权威事实页；`PRODUCT.md` 只描述产品边界，`STATUS.md` 区分目标与当前落地。
- V2 可以把 subgroups、primitive-index 和 f16 当作主要性能实现，而不再把 workgroup/f32 路径定义为设计中心；fallback 仍保持相同逻辑结果。
- 设备初始化、Shader 生成、asset variant、cache key、evidence schema 和工具链版本需要一并升级。
- 新规范能力不会自动获得生产资格；没有 consumer、正确 fallback、feature-off 和证据时不得仅因 feature 存在而启用。

## Verification

- 在目标 Chrome/device 上保存 adapter/device features、limits、WGSL language features、API probes 和 selected specialization。
- 对 subgroups、primitive-index、f16、texture format/compression、Immediate Data 与 Transient Attachments 分别执行 capability-on 的真实 WebGPU case，以及命中 fallback 时的 parity case。
- 综合 benchmark 固定 adapter、浏览器、capability fingerprint、workload、画质、分辨率、warm-up 和采样窗口，并遵循 [VALIDATION.md](../VALIDATION.md)。
- 检查没有 CPU 最终可见列表、第二 Renderer/FrameProducts、无消费者资源或 feature-off 残留。
