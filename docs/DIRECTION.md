# OEngine 产品方向

## 愿景

OEngine 建设一套面向 WebGPU 的 GPU-first 游戏引擎核心。它不只包含 Renderer，还要形成资产编译、运行时世界、GPU Render World、渲染管线和性能工具的连续系统。

## 核心技术主张

```text
GPU-ready Asset
→ Data-oriented Runtime World
→ GPU-resident Render World
→ Hierarchical Work Generation
→ Software/Hardware Hybrid Visibility
→ Single Material Resolve
→ Lighting + Temporal/Post
```

高性能来自尽早消除无效工作、紧凑且稳定的数据布局、GPU producer/consumer 闭环和按证据启用的算法；不是来自堆叠更多 Pass。

高画质来自统一 Visibility、正确的材质属性重建、PBR/IBL、阴影、透明、时域稳定性和后处理共享数据；不是维护另一套独立“高画质管线”。

## 当前范围

- 浏览器 WebGPU 能力基线和设备生命周期。
- GPU-ready 资产、Meshlet、Cluster hierarchy、几何误差和 BVH。
- 独立对象与 Packed Instance Set。
- GPU Render World、稳定 handle 和增量 Change Set。
- GPU instance/hierarchy/cluster culling、LOD、compact、indirect。
- Compute 微三角形与 Hardware Raster 混合 Visibility。
- 单次通用 Standard PBR Material Resolve。
- Clustered Lighting、IBL、Shadow、Transparency、TAA/SSR/AO/Bloom/Exposure/Tonemap 等一条主管线上的可选功能。
- GPU timestamp、计数器、debug view、固定 benchmark 和回归验证。

## 基线不是产品上限

three.js 的 `webgpu_compute_rasterizer` 与 `webgpu_compute_rasterizer_ibl` 只定义 OEngine 的最低垂直能力与性能下界：GPU LOD、GPU work generation、Software/Hardware Visibility、材质重建以及 PBR/IBL 必须至少形成同等级的可运行闭环，并在同条件 benchmark 中达到冻结的目标。

通过这两个示例的 A/B 门禁，只能证明基础闭环没有落后，不能宣告 OEngine 已完成。OEngine 的产品目标在它们之上，还必须同时具备并验证：

- 多 geometry、多 material、alpha-tested 与异构资产；
- 独立动态对象与 Packed Instance Set；
- 增量 GPU Render World、稳定 handle 与 GPU residency 生命周期；
- hierarchy/SSE LOD、紧凑工作生成与可靠 overflow/fallback；
- Lighting、IBL、Shadow、Transparency、Temporal/Post 的完整效果链；
- resize、feature toggle、asset unload/reload、device lost 和跨设备 capability fallback；
- 可扩展接口、debug/性能工具，以及功能关闭时接近零成本。

A/B/C 是同一主管线在不同 manifest 与 feature set 下的验证场景，不是三档产品、三套 Renderer 或三条真实管线。

## 当前非目标

- three.js API、Scene、Material、TSL 或 Loader 兼容层。
- WebGL fallback 或自研 Vulkan/D3D12/Metal RHI。
- 在核心性能闭环稳定前扩张编辑器、物理、网络和完整 Gameplay 生态。
- 未经 benchmark 证明的 Compute Raster 全量替换。
- 在全驻留 Geometry Hierarchy 正确前实现虚拟几何 streaming。
- 通用 Shader Graph。
- Core/Quality/Experimental 三档独立渲染管线。

## 成功标准

- 同画质、同分辨率下，A/B 至少覆盖 three.js 两个 compute rasterizer 示例的功能闭环，并达到 `performance-targets.json` 冻结的最低性能目标。
- A/B 通过后，C 和通用 vertical cases 继续证明多资产、动态世界、完整效果、生命周期与扩展性；不得把“追平两个示例”写成产品完成。
- 大量实例和高几何密度下，CPU 工作不随最终候选三角形线性增长。
- GPU 选择 LOD、生成工作量并由 indirect consumer 消费，不发生 CPU readback 决策。
- 功能关闭时不创建对应资源、不编码对应 Pass、不产生 readback/submit。
- 每一帧可以回答“处理了多少实例、节点、Cluster、软/硬三角形和像素，时间花在哪里”。
