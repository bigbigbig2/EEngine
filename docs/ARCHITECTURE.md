# OEngine 目标架构

## 总体分层

```text
Offline Cooker / Validator
          │
Compact Runtime Asset Package
          │
GPU Asset Tables + Mostly-static GPU Scene
          │
Hierarchical Work Generator
          │
Hardware-first Visibility Consumer
          │
Unified VisibilityKey / Depth
          │
Single Material Resolve
          │
Lighting / Shadow / Temporal / Post
          │
Present
```

架构围绕深 module 组织：复杂算法、容量、fallback 和生命周期隐藏在小 interface 后，Renderer 只拥有组合与调度，不吸收算法实现。

## Module 与所有权

### Asset Cooker

拥有源资产规范化、Meshlet、Cluster hierarchy、BVH8、几何误差、压缩顶点流、纹理预处理和 Runtime Asset 校验。输出设备无关、可版本化；Loader 临时对象不得进入 GPU 热路径。

### GPU Asset Tables

拥有 Geometry、Cluster、Material、Texture 和 Light 的紧凑 GPU 记录、容量和 resident bytes。当前优先全驻留和批量上传，给可选 texture residency 保留稳定 handle，不提前实现虚拟几何页系统。

### GPU Scene

拥有 mostly-static Instance Table、Packed Instance Set、当前/上一帧变换和少量增量更新。当前 interface 优先 bulk create/upload 与 transform/material patch，不建设完整 Gameplay 生命周期或通用 ECS。

### Hierarchical Work Generator

从 instance cull 进入 BVH/Cluster traversal，在展开大量 Meshlet 前完成 SSE LOD、frustum/cone/HZB culling，输出 compact `VisibleCluster`、HW/Alpha/SW queue 和 indirect args。所有队列必须定义 ABI、capacity、attempted/written/overflow、producer 和 consumer。

### Hardware Visibility Consumer

WebGPU baseline 采用现有 single `drawIndirect` consumer：GPU 将可见 Meshlet 数写入 `instanceCount`，固定功能光栅通过 `instance_index`/vertex pulling 读取 compact list。当前 `384 vertices × visible meshlet instances` 是已存在 baseline，需要继续验证不足 128 triangles 的无效工作、随机读取和多 bucket 成本。

MDI、mesh/task shader、buffer device address 不属于 baseline。Compute Micro Raster 是同一 Visibility module 的可选 adapter，不替代 Hardware correctness path。

### Unified Visibility

HW、Alpha 和可选 SW 路径输出同一 frame-local VisibilityKey 与 reverse-Z depth。该 module 隐藏 key 分配、depth tie、overflow、transfer 和 debug 逻辑；下游 Material Resolve 不知道像素来自哪种光栅实现。

### Material Resolve

一次扫描可见像素，按 VisibilityKey 回查 VisibleCluster、Geometry、Instance、MaterialTable 和纹理，重建 PBR surface 与 Velocity。当前每材质全屏 Material Expand 属于明确删除对象；未来自定义材质使用有界 Shader Bin，不恢复无界全屏循环。

### Lighting / Temporal

Clustered Lighting、IBL、CSM、Transparency/Decal、Temporal Reconstruction、Upscaling 和 Post 共用 Depth/HZB/Velocity/Surface。地形、植被、角色、云、水等项目通过这些稳定输入输出接入，不进入当前核心实现。

### FrameGraph

拥有 Pass 依赖、feature pruning、瞬态资源生命周期、拓扑缓存和命令编码。算法 module 向 FrameGraph 声明完整 read/write/create；功能关闭后对应节点和资源必须消失。

## 关键 seam

| Seam | 输入 | 输出 | 不允许泄漏 |
|---|---|---|---|
| Source → Runtime Asset | glTF/源资产 | versioned package | Loader 临时对象、GPU handle |
| Runtime Asset → GPU Tables | package handle | resident table ranges | 裸 Buffer 地址、源格式对象 |
| Scene → Work Generator | compact instance tables + view | selected queues | CPU 可见列表 |
| Work Generator → HW Consumer | visible meshlet list + indirect args | VisibilityKey + depth | CPU draw loop、未 clamp raw count |
| Raster → Resolve | VisibilityKey + depth | Surface + Velocity | 光栅实现特有材质逻辑 |
| Resolve → Effects | Surface/Depth/Velocity | HDR/history | 每材质全屏扫描 |
| Pass → FrameGraph | 完整资源依赖 | encoded commands | 隐式跨 Pass 资源 |

## WebGPU capability profile

- 主要性能目标是桌面级 WebGPU adapter。
- 核显或较低能力 adapter 先保证明确 capability 结果与正确 fallback，不作为近期主要性能 Gate。
- 可选 feature 选择同一 module 的 adapter，不产生第二条产品管线。
- `texture-formats-tier1` 等 required feature 必须在设备创建前协商；若无兼容 adapter，则明确拒绝启动该实现或选择共享正确性 ABI 的 fallback。
- 64 位原子、multi-draw-indirect、mesh/task shader、buffer device address 不得成为正确性前提。
