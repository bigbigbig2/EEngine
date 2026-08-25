# 当前实现事实

本文描述当前 `OEngine/src`，不代表长期接受。

## 已存在并接入

- WebGPU Device/Canvas 初始化和资源缓存。
- CPU Scene/Node/Mesh/Light/Animation 基础对象。
- Scene Change Set 与部分 transform/bounds 增量同步。
- GPU Scene、Geometry/Material/Texture 数据库和 allocator。
- Meshlet 数据、实例/Meshlet 剔除、Prefix Scan、Indirect Draw。
- Hardware Visibility Buffer、reverse-Z、previous HZB 和 same-frame second chance。
- Material Expand、Clustered Lighting、IBL、Shadow、SSAO、SSR、OIT、TAA、Bloom、Exposure、Tonemap 等代码路径。

## 关键缺口

- 没有主链 GPU Geometry Hierarchy/SSE LOD。
- 没有 Compute Software Raster 或软硬件统一 VisibilityKey。
- 没有正式离线 Asset Cooker 和版本化 Runtime Asset ABI。
- 没有 Packed Instance Set 的完整公开 seam。
- Material Expand 仍按材质全屏绘制。
- HZB、submit、readback 和中间队列存在明显固定成本。
- FrameGraph 尚未覆盖全部资源依赖和旁路系统。
- 资源销毁、device lost、history 失效与动态资产生命周期未闭环。
- 自动化测试、固定 benchmark、截图/数值回归基本缺失。
- package 和大量内部符号仍保留 reconstructed/Shade 历史名称。

## 参考代码状态

- `three.js/` 是 gitlink 形式的本地上游参考；根仓库当前没有 `.gitmodules`。
- `three.js/examples/webgpu_compute_rasterizer.html` 有本地注释修改，属于用户现有改动。
- `webgpufundamentals/` 是学习资料。

