# ADR-0004 · Visibility-to-Surface

Status: accepted；能力口径由 [ADR-0010](./0010-webgpu-2026-capability-contract.md) 修订

## Context

Hardware Visibility 已能为可见像素输出 reverse-Z depth 和稳定 `VisibilityKey`。旧 Pixel Queue、ShadeWork 和按可见像素散射的材质路径增加了中间队列、扫描和生命周期成本，也让 Surface producer 与消费者共享了过多迁移状态。64 位原子、multi-draw-indirect 或 mesh shader 仍不是标准生产前提；subgroup 等 2026 规范能力按 ADR-0010 specialization 使用。

## Decision

- Hardware Visibility 直接输出 `VisibilityKey + depth`，Surface 不从 CPU 或旧可见像素队列重建工作。
- `VisibilityKey` 使用有界 exact-raster identity 和 3-bit material kernel class；无效 key 使用明确 sentinel 并计数。
- 首选 `MaterialClassDepth + fullscreen Surface Resolve`。启动时对 `depth32float/equal` 组合做真实设备 probe；不成立时在创建 Surface owner 前选择 `class-discard` 正确性 fallback。
- `GpuSurfaceAbi.ts` 是唯一 Surface 格式和编码事实源。Producer 与 consumer 校验同一 ABI，不创建第二套压缩或质量管线。
- TriangleSetup candidate cache 是显式 opt-in 加速器；关闭时不分配 setup 资源、不增加 FrameGraph 节点或 clear。只有正确性、near-plane、命中率、性能和内存门禁都满足后才能改变默认值。
- Tile material backend 只在至少两个 GPU vendor 的独立同条件证据表明 ClassDepth 的 P50 或 P95 相对已验证 tile 对照慢至少 10% 时进入实现；证据不足时不创建 queue、pass、shader 或 submit。
- 旧 Pixel Queue 与 ShadeWork 不再恢复为生产 fallback。历史比较从对应 Git commit 复跑。

## Consequences

Surface 路径只有一个 FrameProduct/ABI，但可以在初始化时选择 class-depth 或 class-discard 的正确性 backend。可选加速器必须保持 feature-off 近零成本。迁移过程、旧测试数量、单机 run 和逐提交 checkpoint 不属于长期决策，统一从 Git 历史或可复算 artifact 查询。

普通 Scene 的 legacy Material Expand、独立 Velocity 和旧 OIT 仍是调用方迁移债务；它们不能扩张新合同，最终应迁移到统一 Surface、Temporal 和 Transparency 产品后删除。

## Verification

验证 `VisibilityKey` CPU/WGSL oracle、invalid/overflow counter、class-depth probe 与 class-discard fallback、Surface attachment/ABI parity、near-plane 和 alpha 场景、TriangleSetup off/on 资源裁剪、GPU P50/P95、内存峰值、device loss/resize/toggle 生命周期，以及两个 vendor 才能触发的 Tile gate。具体证据要求遵循 [VALIDATION.md](../VALIDATION.md)。
