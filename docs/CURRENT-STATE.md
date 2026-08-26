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
- R0 Result Schema v2、CPU/submit/readback/upload 观测、可选 GPU timestamp、256-byte GPU counter ABI、至少三槽异步 readback ring、diagnostics、percentile 汇总和统一 `BenchmarkRunController` 已接入；根目录已有 observability 与真实主帧 smoke 页面。
- 最终 Visibility Buffer 已有首个真实 GPU counter producer：采样帧通过 8×8 工作组归约统计非空/空 mesh-id 像素，异步归档 `shadedPixels` 与 `emptyVisibilityPixels`；两者之和必须等于内部渲染像素数。非采样帧不添加该 Pass，也不编码 counter clear/copy/readback。
- HZB legacy 观测会分别记录同帧 build 数、最终 mip 数与累计 mip pass 数。

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
- A/B/C 固定 benchmark、instance/meshlet/reject/SW-HW/material/light 等其余 GPU counter producer、统一 debug views 和可用于 gate 的浏览器实机截图/性能 artifact 尚未完成；counter 字段缺失表示 producer 未接入，不能解释为真实零工作量。
- 用户已完成旧 Schema smoke 数据采集；Schema v2 与 readback ring 接入后的两个页面仍需手动复测，因此 R0 Gate 尚未通过。
- package 和大量内部符号仍保留 reconstructed/Shade 历史名称。

## 参考代码状态

- `three.js/` 是 gitlink 形式的本地上游参考；根仓库当前没有 `.gitmodules`。
- `three.js/examples/webgpu_compute_rasterizer.html` 有本地注释修改，属于用户现有改动。
- `webgpufundamentals/` 是学习资料。
