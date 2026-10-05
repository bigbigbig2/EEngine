---
id: visibility
kind: domain
owner: visibility
state: current
verifies:
  - OEngine/src/render/program/FrameProgramLowering.ts
  - OEngine/src/render/surface/SurfaceWorkRuntime.ts
---
# Visibility

## 当前源码边界

核对日期：2026-10-05；本轮核对 FrameProgramLowering→SurfaceWork 的直接输入关系，不重新认证全部 traversal/raster 算法。

[FrameProgramLowering](../../OEngine/src/render/program/FrameProgramLowering.ts) 向 SurfaceWorkRuntime 提供当前 visibility/depth、选中 work/frame geometry、几何 source heaps、可选 virtual product、纹理/材质 publication 与版本。SurfaceWork 再注册 demand、唯一 geometry records 和 Appearance/lighting consumers。

本页删除了“当前按 hit mask 持久化 geometry cache bypass”描述：它来自旧文档，不能据此恢复旧 owner。当前具体身份、缓存及 geometry 生产行为以 SurfaceWorkRuntime、SurfaceGeometryPass 和其生产 ABI 为准。

Visibility owner 的 traversal、work generation、hardware raster、HZB 与 frame geometry 为 Surface 提供选中源；winner 身份不能直接充当跨帧 sharing/cache 身份。完整 source/seam/LOD、skin/morph/previous mapping、溢出与生命周期仍需逐项生产检查，不从旧 raster fixture 推导完成。

## 目标与验证

目标见[极致性能设计](../next-design/eengine-extreme-performance-rebuild-2026-10.md)；执行和退出条件见[当前计划](../next-execution/eengine-extreme-performance-rebuild-execution-2026-10.md)。未来 Virtual Geometry 完整工作域属于该计划，不因已有 virtual 输入绑定就判定完成。

历史组件检查与来源集中在[porting ledger](../porting/next-renderer.md)。旧 cache/阶段说明由 Git 追溯，不能用作当前实现或完整性能/画质证明。
