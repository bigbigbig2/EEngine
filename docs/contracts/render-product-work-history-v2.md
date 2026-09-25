---
id: render-product-work-history-v2
kind: contract
status: proposed
owners:
  - frame-runtime
  - visibility
  - shading
version: 2
consumers:
  - OEngine/src/render/Renderer.ts
invariants:
  - semantic products are declared independently from physical resources and have explicit consumer and failure semantics
  - typed GPU work declares a producer, GPU consumer, capacity, overflow policy, counters, and indirect execution contract
  - visible samples receive valid shading results under full, coarse, spatial reconstruction, or valid temporal reuse
  - temporal histories reject incompatible identity, exposure, space, resolution, or representation before reuse
validation:
  - OEngine/tests/contract/opaque-shading-demand.test.mjs
  - OEngine/tests/contract/bounded-gpu-work-protocol.test.mjs
---
# Next Renderer：Product、Work、History 跨模块目标合同

本合同是 [ADR-0020](../adr/0020-clean-cut-renderer.md) 的**候选目标边界**，尚未落地，不声明上方旧测试能证明 v2。`consumers` 列出当前待替换的帧入口以定位迁移，不表示其已满足本合同。具体 WGSL/二进制 ABI 和队列状态机在真实新消费者出现时另写 spec 与对应 contract/oracle。

## Semantic Product

Producer 声明值的语义、空间/坐标、分辨率及 footprint、过滤规则、精度、物理单位/颜色空间、pre-exposure、覆盖与缺失行为、时间身份；Consumer 声明需求与可接受的表示。几何法线与着色法线、camera HZB 与 AO/SSR 深度层级、辐射与可见性不能只因字段名近似就互换。Renderer Core 在配置/发布变化时从有限合法方案选择融合、重算、物化和有效复用，并在 FrameGraph 中消除无消费者的生产者。物理 texture/buffer 不是 Product 的身份。

## Typed GPU Work

每个 Meshlet、Shading、Ray、Page 或 Probe stream 有自己的元素 ABI、容量、计数器、溢出/空任务行为、GPU producer、GPU consumer、间接执行方式与生命周期。公共 runtime 提供计数、scan/compact、预算和观测协议，不要求共用一张物理 mega-queue 或相同 work header。GPU 生产的本帧决定由 GPU 消费；CPU readback 只供诊断或未来帧异步调度。dense/direct 路径可绕过无净收益的分类与压缩。

## Shading frequency 与历史

Surface/Material owner 用编译/发布时保守频带及廉价几何/时间信息先决定候选频率，再运行昂贵采样与材质求值。所有有效 visibility sample 必须有完整可解释的结果来源：full、coarse、空间重建或经过拒绝/置信度判断的 temporal reuse。边缘、高频法线/贴图、镜面突变、运动和揭露不得被无效粗化；`roughness factor = 1` 不等于有效 roughness 恒为 1。旧 `shading.one-eval` 不是 v2 验收条件。

Temporal owner 管理尺寸域、jitter/exposure/motion 约定、稳定 scene/object generation、提交/中止、失效和 history 生命周期。信号 owner 管理自身方差、置信度、拒绝和去噪；最终超分后端管理自己的内部历史。帧内 VisibilityKey/队列索引不作跨帧稳定身份。表示、分辨率、设备、场景、材质、几何、光照和曝光变化按真实依赖使相关 history 失效或合法 rescale。

## 状态与首次验证

Phase 1 建新主链时先验证 GPU 闭环、队列边界和 feature-off；Phase 2 以第一套新 Surface/频率消费者把本合同从候选收敛为精确实现合同，并在同批次修改旧 claim 与测试。原 [v1](./render-product-work-history-v1.md) 已废弃，现存代码事实仍归原有 domain/spec；不能用 v1 测试结果给 v2 宣称通过。
