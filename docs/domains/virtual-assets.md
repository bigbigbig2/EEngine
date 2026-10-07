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
  - OEngine/src/gpu/GeometryPageStreamingRuntime.ts
  - OEngine/src/gpu/GeometryProductResidencyProfile.ts
  - OEngine/src/gpu/GeometryProductSlotPool.ts
  - OEngine/src/render/surface/SurfaceV4.ts
  - OEngine/src/render/pipeline/RendererCore.ts
  - OEngine/src/assets/geometry-product/GeometryProductWorkload.ts
  - OEngine/src/assets/geometry-product/VirtualGeometrySceneSourceV1.ts
  - OEngine/src/gpu/GeometryProductResidentAttributes.ts
---
# Virtual Assets

## 当前 owner 与生产连接

已核对入口为 [GeometryProductAdmission](../../OEngine/src/gpu/GeometryProductAdmission.ts)、[GeometryProductMultiRuntime](../../OEngine/src/gpu/GeometryProductMultiRuntime.ts)、VirtualGeometrySceneSourceV1、FrameProgramLowering 和当前 Product GPU ABI。

Loader/Cooker 提供 Product descriptor/pages；admission 负责验证/激活，multi-runtime 管理 Product/shard slots 与 replacement/release，residency 发布当前页位置。FrameProgramLowering 将 virtual metadata/banks 与选中 frame geometry 传给唯一 SurfaceV4；GPU hierarchy/work/raster 消费当前产品，不由 Loader 长期持有 GPU owner。

当前 GeometryProductGpuAbiV1 的 ABI version 常量为 2；page-location 编码分开 geometry/resident 地址及 generation。不能把 API 名称中的 V1 当作当前数值版本。部分测试 fixtures 尚未符合当前合法 page/地址接口，M1 保存的 Node suite 仍有既有 Geometry/cook 失败；测试存在不等于验证通过，分类和迁移责任见当前执行计划 M2。

Web/Offline/procedural Scene mapper 读取完整 immutable descriptor，按真实 asset forest 与 instance multiplicity 发布 depth/队列上界，合并不再 clamp；RenderWorld 在创建 Scene 资源前检查协商 buffer/binding/dispatch 与 Visibility work namespace。Resident decoder 核实实际 group header 的 meshlet count 与 descriptor 一致，防止页内容突破已声明 work 上界。空 instance list 明确拒绝。合法 page fixtures 已覆盖当前 admission/residency/multi-runtime 的 targeted 合同；原失败记录和仍未关闭的缺口保留在执行计划，不能视为完整 streaming 规模验收。

四 bank 按 GPUDevice 共享而非每 Product 独占；Portable 默认预留512MiB，scene metadata另预留64MiB，各 Product local metadata也仍存在。当前 profile 有512/768/1024 slots/bank，但 GPU地址codec硬编码512；scene metadata ranges append-only不随release回收。多个 Product 渲染已有slot/generation与重定位，Renderer却对多shard recovery要求应用source replay。Streaming已有延迟readback、scheduler与eviction API，本次搜索未见production pressure eviction或shadow demand readback调用；这些是实际缺口，不是M2已经完成的能力。

## 边界与验证

来源及阶段映射集中在[geometry ledger](../porting/geometry.md)，既有 ABI/容器细节保留在对应 specs。本页不复制旧 Phase 标签、固定 asset 字节数、预算或 claim accepted 状态。

真实 GPU handoff/culling 的检查覆盖所选 producer/consumer 与输入；cook、替换、取消、device recovery、全几何容量和大型场景需要各自生产验证。已存在 virtual 输入绑定不等于未来完整 Virtual Geometry 工作域或完整 VT/Virtual Shadow。

目标和退出要求见[当前设计](../next-design/eengine-v4-native-shading-2026-10.md)及[执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)。paused 工作保留其历史/待做范围，不成为活跃 currentSlice 或源码完成证明。
