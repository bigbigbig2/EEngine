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

## 当前非目标

- three.js API、Scene、Material、TSL 或 Loader 兼容层。
- WebGL fallback 或自研 Vulkan/D3D12/Metal RHI。
- 在核心性能闭环稳定前扩张编辑器、物理、网络和完整 Gameplay 生态。
- 未经 benchmark 证明的 Compute Raster 全量替换。
- 在全驻留 Geometry Hierarchy 正确前实现虚拟几何 streaming。
- 通用 Shader Graph。
- Core/Quality/Experimental 三档独立渲染管线。

## 成功标准

- 同画质、同分辨率下，OEngine 的基准场景能解释并证明相对 three.js 两个 compute rasterizer 示例的成本与收益。
- 大量实例和高几何密度下，CPU 工作不随最终候选三角形线性增长。
- GPU 选择 LOD、生成工作量并由 indirect consumer 消费，不发生 CPU readback 决策。
- 功能关闭时不创建对应资源、不编码对应 Pass、不产生 readback/submit。
- 每一帧可以回答“处理了多少实例、节点、Cluster、软/硬三角形和像素，时间花在哪里”。

