# OEngine 目标架构

## 总体分层

```text
Importer / Cooker / Profiler
          │
Runtime Asset Package
          │
Application World
          │ Change Set / Extract
GPU Render World
          │
GPU Work Generator
          │
Hybrid Visibility Renderer
          │
Material Resolve / Lighting / Temporal / Post
          │
Present
```

## 所有权

### Asset Pipeline

拥有设备无关的 GeometryAsset、Meshlet、Cluster Group、LOD hierarchy、BVH、几何误差、压缩顶点流和纹理预处理。输出必须可序列化和版本化。

### Application World

拥有 Gameplay/编辑语义、对象身份、层级、动画意图和 Packed Instance Set。它不持有 GPU Buffer 地址。

### GPU Render World

拥有 GPU 常驻表、稳定 handle、resident geometry/material/texture/light、容量和销毁。建议的核心表为 Instance、Geometry、Cluster、Material、Light。

### GPU Work Generator

从实例剔除进入 BVH/Cluster traversal，完成 SSE LOD、frustum/cone/HZB culling、compact、软硬件队列分类和 indirect 参数生成。

### Hybrid Visibility Renderer

Compute 处理微三角形，固定功能硬件处理普通/大三角形。两条路径输出同一 VisibilityKey 与深度语义。

### Shading Pipeline

一次 Material Resolve 动态读取 MaterialTable 和 resident texture pages，生成紧凑表面数据；后续光照、透明、时域和后处理共享 Depth/HZB/Velocity/Lighting 数据。

### FrameGraph

拥有 Pass 依赖、资源生命周期、裁剪、复用和命令编码。图拓扑由 feature set、尺寸和目标决定，并可缓存编译结果。

## 关键 seam

| Seam | 输入 | 输出 | 禁止泄漏 |
|---|---|---|---|
| Asset → Resident | Runtime Asset handle | GPU resident handle | 临时 Loader 对象、裸地址 |
| World → GPU World | Change Set | 增量表更新 | Renderer 全量遍历 |
| Hierarchy → Raster | SelectedCluster/Work Queue | SW/HW queues + indirect args | CPU 可见列表 |
| Raster → Resolve | VisibilityKey + depth | Surface/GBuffer | 光栅路径特有材质逻辑 |
| Pass → FrameGraph | 完整 read/write/create | 编码后的命令 | 隐式跨 Pass 资源 |

## WebGPU 基线与增强能力

浏览器 WebGPU 是默认契约。subgroups 等能力只能通过 capability profile 选择增强实现；64 位原子、multi-draw-indirect、mesh/task shader 和 buffer device address 不得成为正确性前提。

Native/WebGPU 增强路径尚未决策，若引入必须新增 ADR。
