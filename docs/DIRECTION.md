# OEngine 产品方向

## 当前定位

OEngine 当前阶段是一套面向桌面 WebGPU、服务于中大型高几何密度场景的 GPU-first 渲染引擎核心。它优先消除 CPU 驱动和无效 GPU 工作，让 GPU 直接完成 LOD、剔除、工作生成、Visibility、材质解析、光照与时域处理。

OEngine 当前不建设“浏览器版完整 AAA 引擎”，也不以超大世界为产品前提。所谓高画质与高性能，必须在固定中大型场景、目标桌面 GPU、统一主管线和可复现 benchmark 中证明。

## 核心主链

```text
GPU-ready Asset
→ Compact GPU Tables + Packed Instances
→ Hierarchical LOD / Cull / Work Generation
→ GPU Indirect Hardware Visibility
→ Unified VisibilityKey + Depth
→ Single Material Resolve
→ Clustered Lighting + IBL + CSM
→ Temporal Reconstruction / Upscaling / Post
```

Compute Software Raster 是微三角形场景的 profile optimization。它在 Hardware-first 主链、统一 VisibilityKey 和单次 Material Resolve 已正确且可测后接入，不是引擎正确性前提。

## 当前核心范围

- 桌面浏览器 WebGPU capability profile、设备协商和统一主管线。
- 离线 GPU-ready Geometry/Texture Cooker、版本化 Runtime Asset ABI。
- 紧凑 GPU Geometry/Instance/Material/Texture/Light 表与 Packed Instance Set。
- Meshlet、Cluster hierarchy、BVH8、SSE LOD、frustum/cone/HZB culling。
- GPU producer → GPU queue/indirect args → GPU consumer 闭环。
- Hardware Visibility baseline、统一 VisibilityKey/Depth、单次 Standard PBR Material Resolve。
- 经过 benchmark 证明有收益的 Compute Micro Raster 与 SW/HW Hybrid。
- Clustered Lighting、IBL、现有 CSM 与 Transparency；保留 Decal 接入 seam，但其实现和 Gate 当前延期。
- Velocity、Temporal Reconstruction、Dynamic Resolution、Upscaling 与 Post。
- GPU timestamp、工作量计数、显存/瞬态内存、上传/readback 字节和固定 benchmark。

## 当前场景模型

当前优先验证中大型、高密度、静态或 mostly-static 场景。几何先按渲染行为分类，而不是提前建设内容专用系统：

```text
Opaque static
Alpha-tested
Transparent
Skinned/deformed        deferred
Procedural/particle     deferred
```

建筑可走通用 Opaque；植被首先作为 alpha-tested 压力 workload；地形、角色、粒子不在当前阶段建设专用 Renderer。

## 基线不是产品上限

three.js 的 `webgpu_compute_rasterizer` 与 `webgpu_compute_rasterizer_ibl` 只定义最低垂直功能和性能下界。A/B 至少证明 GPU LOD、工作生成、SW/HW Visibility、材质重建与 PBR/IBL 闭环不落后。

OEngine 当前阶段的完成还要求 C 和通用 workload 证明：

- 多 geometry/material、Packed Instances、alpha-tested 和 CSM；
- hierarchy/SSE 在展开 Meshlet 前减少工作；
- GPU 生成的队列由 indirect/compute consumer 直接消费；
- 单次 Material Resolve 不随活跃材质数执行全屏扫描；
- 动态灯光、Temporal/Upscaling 和可选效果成本可解释、可关闭；
- 工作量、GPU 时间、显存、上传和 overflow 均有真实证据。

A/B/C 是同一主管线的不同 manifest 与 feature set，不是三档产品或三条 Renderer。

## 可选后续

- 场景分块、资源预取与轻量 World Partition。
- Texture mip residency/streaming；只有显存证据需要时再研究 Virtual Texture。
- 更多动态灯光、Probe/已有 GI 项目迁移。
- 粒子、Skinned Mesh、复杂透明和专用内容路径。
- Geometry streaming、Virtual Shadow Map、ReSTIR 等远期研究。

## 当前非目标

- 超大世界坐标、camera-relative rendering 和双精度世界坐标。
- 完整 World Partition、虚拟几何或开放世界 streaming 作为近期前提。
- 地形、植被、角色、云、海洋、大气等专用系统。
- 完整 ECS、Gameplay、Editor 和高频动态对象生命周期系统。
- three.js API、Scene、Material、TSL 或 Loader 兼容层。
- WebGL fallback，或自研 Vulkan/D3D12/Metal RHI。
- 未经 benchmark 证明的 Compute Raster 全量替换。
- Core/Quality/Experimental 三档独立渲染管线。

GPU 资源的 in-flight 安全、resize/history 失效和 owner 正确性仍是底层正确性要求，不因动态世界不在范围内而取消。

## 成功标准

- CPU 不遍历最终可见 Meshlet/triangle 列表决定绘制。
- GPU 选择 LOD、生成 compact work 和 indirect args，并由 GPU consumer 直接消费。
- Hardware-first 主链在普通场景稳定；Hybrid 只在目标 workload 有收益时启用，其他场景不明显退化。
- 材质数量增长时，主材质解析不再退化为材质数 × 全屏像素。
- 中大型场景下 CPU/GPU P50、P95、P99、显存和上传成本均可解释。
- 功能关闭时不保留无消费者 Pass、资源、history、readback 或独立 submit。
