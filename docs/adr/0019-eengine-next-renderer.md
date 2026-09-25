# ADR-0019: EEngine Next 的需求驱动虚拟化可见性架构

Status: superseded by ADR-0020

本方案的保行为拆分与 CSM fallback 已被用户撤销；单路径破坏式重建见 [ADR-0020](./0020-clean-cut-renderer.md)。下文保留原决定，不能作为下一批任务依据。

## Context

用户已确认 [EEngine Next 最终设计](../reviews/2026-09-25-eengine-next-final-architecture-source.md)，并要求按大模块组织重构、优先忠实迁移开源实现。现有 GPU Scene、Virtual Geometry、hardware visibility、sparse shading 与统一 FrameGraph 方向正确；主管线集中多个 owner、程序与 publication 绑定、独立效果的全屏工作和历史管理妨碍下一阶段演进。

## Decision

EEngine Next 定位为 **Demand-Driven Virtualized Visibility Renderer**：Virtualized Scene + Render Product Compiler + GPU Work Runtime + Visibility-driven Compute Shading + Temporal Fabric。只面向一个 Next 目标，允许重构主干。

以六个交付模块组织：渲染规划与执行；GPU 场景/工作/驻留；Surface 与自适应着色；光传输；物理环境与参与介质；时域重建与质量预算。具体边界和实施依赖见 [模块路线](../next-renderer.md)，不在 ADR 维护任务状态。

Opaque visibility 以 VisibilityKey + Depth 为事实。Logical Product 与物理纹理解耦，用有界、可解释的计划选择融合、重算、物化与复用。着色频率按信号与有效性决定，不以粗糙度标量统一降低完整材质精度。透明/折射等有专门表示需求的路径仍通过同一产品规划与主管线接入。

WebGPU 使用静态有界 kernel graph 与 GPU 动态工作量。工作共享基础算子、容量/溢出与生命周期协议，保留 typed streams 和专用执行器；不依赖 mesh shader、Work Graph、硬件 RT、通用 bindless 或 multi-draw-count。虚拟资源共享控制面与预算，保留 VG/Texture/Shadow/Radiance 各自数据面。

目标光照包括 Directional VSM、XeGTAO、SSSR-style Reflection、Screen/World/Sky Hybrid GI、Takram-derived 非地理物理环境、局部 Froxel 介质及 Temporal Upscaling。CSM 保留为对照和必要 fallback；体积云后置。Temporal 的共享状态先于后半段效果落地，信号去噪和最终重建分别拥有算法语义。Neural 只预留可协商后端，不绑定 DLSS。

首版 World GI 支持动态几何与动态光源，包括相应样本生产、追踪结构更新、Probe 更新与历史失效；允许预算内渐进收敛，不能以静态烘焙替代完成。目标设备以用户的 GTX 1650 Ti 与 RTX 2060 开发机为基线，实测配置与工程预算维护在模块路线，不依赖 2060 的硬件 RT 能力。

成熟开源算法优先按固定版本迁移。不得删除关键阶段、分支、历史/失效机制后仍宣称完成原算法移植；平台适配及原创建模必须明确标记。采用边界、许可证和源码入口见 [来源账本](../porting/next-renderer.md)。

## Consequences

本 ADR 接受的是目标架构，不宣称已有实现完成，也不一次性废止 ADR-0010、0013、0015、0016 等现行 capability/ABI/生命周期合同。特别是自适应频率与现行 exactly-once 声明的关系，必须在对应切片显式更新 contract、claim 和验证，不能继承旧证据。

GPU Work Runtime 值得成为特色，但特色来自产品规划、工作削减、着色频率、驻留与历史共同减少成本，而非统一队列类名。允许 dense/direct 快路径和确有全域需求的全屏步骤。

现有 FrameGraph、GPU publication、Nyx VG、hardware indirect visibility 和 sparse/direct shading 基础保留；主管线所有权与稳定程序缓存需要重构。新旧迁移与 fallback 必须有明确退出/存续理由，不保留双 production pipeline。全 VT 与动态世界 GI 的执行来源、VSM WebGPU 页光栅成本仍须独立验证。

## Verification

文档准备使用现有 `vibe verify --changed`。实施按完整算法切片运行受影响检查，复用独立 validation 场景做关键算法对照和 GPU 闭环检查；不为每个函数增加测试流程。集成和正式性能声明沿用仓库现有规则。

当前任务、开放项和退出条件仅维护在 [workstream](../../project/workstreams/active/eengine-next.yaml)。本 ADR 不提升任何 runtime/performance claim。
