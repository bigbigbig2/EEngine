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
  - node tools/vibe.mjs verify --module
state: history
verifies:
  - checks
  - project/domains
---
# Next Renderer：Product、Work、History 跨模块目标合同

本合同是 [ADR-0020](../adr/0020-clean-cut-renderer.md) 的**候选目标边界**，整体尚未落地。Phase 2 已在 `SurfaceProducts.ts` 定义部分逻辑 Surface 值及程序/发布期绑定身份；当前 Renderer 的 GPU ShadingWork、间接 Surface/PBR/direct consumer 与有限频率计划已有**诊断**，精确边界见 [ShadingWork V1](../specs/shading-work-v1.md) 与[频率计划 V1](../specs/shading-frequency-plan-v1.md)。完整的材质频带、净性能收益、Temporal 与正式 Surface Radiance claim 仍缺证据。frontmatter 的 `validation` 目前仅检查文档模型，不证明 runtime 语义。`consumers` 列出帧入口以定位迁移，不表示其已满足本合同。

## Semantic Product

Phase 2 已实现的有限 Surface/Work 边界单独冻结在 [Surface/Work V1](./surface-work-v1.md)。本 v2 整体继续 proposed：独立 motion/normal 产品、跨消费者表示规划、Temporal 与跨域 Work Runtime 不因旧 owner 删除而自动完成。

Producer 声明值的语义、空间/坐标、分辨率及 footprint、过滤规则、精度、物理单位/颜色空间、pre-exposure、覆盖与缺失行为、时间身份；Consumer 声明需求与可接受的表示。几何法线与着色法线、camera HZB 与 AO/SSR 深度层级、辐射与可见性不能只因字段名近似就互换。Renderer Core 按 `Consumer Demand → Semantic Product → Provider → Representation → Execution Domain → FrameGraph` 在配置/发布变化时从有限合法方案选择融合、重算、物化和有效复用，并消除无消费者的生产者。FrameGraph 拥有执行依赖与资源生命周期，不代替 Product 决策。物理 texture/buffer 不是 Product 的身份。

## Typed GPU Work

每个 Meshlet、Shading、Ray、Page 或 Probe stream 有自己的元素 ABI、容量、计数器、溢出/空任务行为、GPU producer、GPU consumer、间接执行方式与生命周期。公共 runtime 提供 `Demand → Classify → Compact → Typed Work → Indirect Execute` 的可组合算子、计数、预算和观测协议，不要求共用一张物理 mega-queue 或相同 work header。GPU 生产的本帧决定由 GPU 消费；CPU readback 只供诊断或未来帧异步调度。dense/direct 路径可绕过无净收益的分类与压缩。

## Shading frequency 与历史

Surface/Material owner 综合 coverage/identity、material appearance 和 lighting 三类频率信息，用编译/发布时保守元数据及廉价几何/时间信息先决定候选频率，再运行昂贵采样与材质求值。所有有效 visibility sample 必须有完整可解释的结果来源：full、coarse、空间重建或经过拒绝/置信度判断的 temporal reuse。没有相容 history 时必须走本帧求值/空间重建；不能在 Phase 2 尚无 Temporal Fabric 时冒称已支持 reuse。边缘、高频法线/贴图、镜面突变、运动和揭露不得被无效粗化；`roughness factor = 1` 不等于有效 roughness 恒为 1。旧 `shading.one-eval` 不是 v2 验收条件。

Temporal owner 管理尺寸域、jitter/exposure/motion、disocclusion/reactive 的公共输入约定、稳定 scene/object generation、begin/commit/abort、ping-pong、局部/整帧失效和 history 生命周期。信号 owner 管理自身方差、置信度、拒绝和去噪；最终超分后端管理自己的内部历史。帧内 VisibilityKey/队列索引不作跨帧稳定身份。表示、分辨率、设备、场景、材质、几何、光照、阴影和曝光变化按真实依赖使相关 history 失效或合法 rescale；pre-exposure generation 与 multiplier 不能被一个笼统的“曝光已处理”掩盖。

## Program 与 publication

Device-lifetime program identity 包含 shader、layout、能力和 kernel specialization；scene revision、texture generation、instance revision 与具体 GPU 资源只进入 publication-local binding identity。无关资产 append 不应重建所有程序；设备丢失使程序缓存失效，旧 submission 引用的 binding/资源仍须安全退役。这是新代码要重新实现的所有权边界，旧 sparse shading cache 的已有行为不构成 v2 验证。

## 状态与首次验证

Phase 1 建新主链时先验证 GPU 闭环、队列边界和 feature-off。Phase 2 收敛已实现的 Surface/Work 部分至精确合同/spec 与新 claim，明确 schema-only 产品、有限频率 profile 和生产消费者；不把本合同整体（特别是 Temporal）提前标记完成。旧 shading claims 已 retired，新声明不得继承其 evidence。Phase 3 再关闭 History 与实际跨消费者表示边界，Phase 4 用 Ray/Page 检验 Work 共享控制语义。有限 profile 之外 full-rate 是合法结果，不要求所有材质在 Phase 2 降频。删除旧 owner 不以双机性能为前置条件；净收益与正式质量仍须独立证明。原 [v1](./render-product-work-history-v1.md) 已废弃，现存代码事实仍归原有 domain/spec；不能用 v1 测试结果给 v2 宣称通过。
