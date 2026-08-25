# 性能契约与 Benchmark

## 原则

性能结论必须基于同机、同浏览器、同 GPU、同分辨率、同 DPR、同画质、相同 warm-up 的数据。FPS 只用于体验总览；定位必须使用 CPU 分段、GPU timestamp、计数器和带宽/资源信息。

## 强制基线

### A · three.js Compute Rasterizer 对齐

- 相同 Teapot LOD 数据和 160k instances。
- 相同实例布局、相机、分辨率和 DPR。
- 分别比较 Hardware、Software、Hybrid。
- 输出简单 Visibility Resolve。

### B · three.js Compute Rasterizer IBL 对齐

- 相同 glTF、Meshopt LOD/Meshlet、实例布局和环境贴图。
- 相同 HZB、PBR/IBL、分辨率和输出格式。
- 额外效果必须关闭或单独列出。

### C · OEngine 通用性压力

- 多 geometry、多 material、alpha-tested、shadow、动态 transform。
- 分别增加实例、Cluster、可见比例、活跃材质和灯光数量。

## 每组必须记录

- CPU：World/Change Set、graph/encode、提交前总时间、submit 次数。
- GPU：upload、cull/traversal、SW raster、HW raster、HZB、resolve、lighting、每个效果。
- 数量：候选/可见 instance、BVH node、Cluster、SW/HW triangle、材质、灯光。
- 内存：常驻 Buffer/Texture、transient 峰值、每帧上传与 readback 字节。
- 统计：平均、P50、P95、P99、首次编译和 warm frame。

## 当前已确认的性能风险

- `GraphicsContext.update()` 稳定帧独立 submit，并触发 collection statistics readback。
- `GPUSceneContext.update()` 无条件提交 animation flush。
- 主帧之外存在多次 GPU submit。
- FrameGraph 每帧重建和 compile。
- HZB 每次逐 mip 开 Render Pass，普通帧构建两次，alpha-tested 时可能三次。
- Visibility 的 bucket/scan/expand/second-chance 中间队列和 clear 成本高。
- 当前 Material Expand 先写 material depth，再对每个材质画全屏三角形。
- Visibility、material depth、四张 GBuffer、HDR 和 history 产生较大全分辨率带宽。
- 主链缺少 hierarchy/SSE LOD 和 Compute micro-raster。
- oracle/generated Shader 尚未建立系统的性能和视觉回归。

这些是待测风险，不得在没有分段数据时把总慢归因于单一 LOD 或单一 Pass。

## 性能变更完成标准

1. 提供基线和变更后的同条件数据。
2. 说明优化减少了哪一种工作，而非只移动到另一个 Pass。
3. 不引入漏绘、遮挡错误、LOD 闪烁、深度不一致或时域历史错误。
4. 给出其他场景是否退化以及 fallback。
5. 更新相关 lesson 或 ADR（若结论改变调查顺序或长期架构）。

