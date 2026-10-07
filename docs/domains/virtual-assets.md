---
id: virtual-assets
kind: domain
owner: virtual-assets
state: current
verifies:
  - OEngine/src/gpu/GeometryProductAdmission.ts
  - OEngine/src/gpu/GeometryProductMultiRuntime.ts
  - OEngine/src/gpu/GeometryProductGpuAbiV1.ts
  - OEngine/src/render/program/FrameProgramLowering.ts
---
# Virtual Assets

## 当前 owner 与生产连接

已核对入口为 [GeometryProductAdmission](../../OEngine/src/gpu/GeometryProductAdmission.ts)、[GeometryProductMultiRuntime](../../OEngine/src/gpu/GeometryProductMultiRuntime.ts)、VirtualGeometrySceneSourceV1、FrameProgramLowering 和当前 Product GPU ABI。

Loader/Cooker 提供 Product descriptor/pages；admission 负责验证/激活，multi-runtime 管理 Product/shard slots 与 replacement/release，residency 发布当前页位置。FrameProgramLowering 将 virtual metadata/banks 与选中 frame geometry 传给唯一 SurfaceWork；GPU hierarchy/work/raster 消费当前产品，不由 Loader 长期持有 GPU owner。

当前 GeometryProductGpuAbiV1 的 ABI version 常量为 2；page-location 编码分开 geometry/resident 地址及 generation。测试 fixture 调用当前 codec 构造合法输入，独立检查 draw counts、overflow、invalid 与 compacted IDs；旧 ABI 有真实拒绝用例。不能把 API 名称中的 V1 当作当前数值版本。

## 边界与验证

来源及阶段映射集中在[geometry ledger](../porting/geometry.md)，既有 ABI/容器细节保留在对应 specs。本页不复制旧 Phase 标签、固定 asset 字节数、预算或 claim accepted 状态。

真实 GPU handoff/culling 的检查覆盖所选 producer/consumer 与输入；cook、替换、取消、device recovery、全几何容量和大型场景需要各自生产验证。已存在 virtual 输入绑定不等于未来完整 Virtual Geometry 工作域或完整 VT/Virtual Shadow。

目标和退出要求见[当前设计](../next-design/eengine-v4-native-shading-2026-10.md)及[执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)。paused 工作保留其历史/待做范围，不成为活跃 currentSlice 或源码完成证明。
