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
- R0 环境清单、CPU/submit/readback/upload 观测、可选 GPU timestamp、percentile 汇总和统一 `BenchmarkRunController` 已接入；根目录已有 observability 与真实主帧 smoke 页面。

## 关键缺口

- 没有主链 GPU Geometry Hierarchy/SSE LOD。
- 没有 Compute Software Raster 或软硬件统一 VisibilityKey。
- 没有正式离线 Asset Cooker 和版本化 Runtime Asset ABI。
- 没有 Packed Instance Set 的完整公开 seam。
- Material Expand 仍按材质全屏绘制。
- HZB、submit、readback 和中间队列存在明显固定成本。
- FrameGraph 尚未覆盖全部资源依赖和旁路系统。
- 资源销毁、device lost、history 失效与动态资产生命周期未闭环。
- 自动化测试目前只覆盖 R0 观测公共 seam；固定 benchmark、截图和数值回归仍基本缺失。
- A/B/C 固定 benchmark、GPU counter readback ring、统一 debug views 和浏览器实机截图/性能 artifact 尚未完成；现有 smoke 页面构建通过但尚未在可连接浏览器中验收。
- package 和大量内部符号仍保留 reconstructed/Shade 历史名称。

## 参考代码状态

- `three.js/` 是 gitlink 形式的本地上游参考；根仓库当前没有 `.gitmodules`。
- `three.js/examples/webgpu_compute_rasterizer.html` 有本地注释修改，属于用户现有改动。
- `webgpufundamentals/` 是学习资料。
