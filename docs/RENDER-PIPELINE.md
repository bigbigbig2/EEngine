# 统一渲染主管线

OEngine 只有一条主管线。功能按照配置、资源依赖和场景需要启停；关闭后不得保留对应 Pass 或资源成本。

## 一帧

```text
Apply Change Set / Upload Dirty
→ Update animation and camera
→ Clear active counters
→ Instance Cull
→ BVH/Cluster Hierarchy Traversal + SSE LOD
→ Cluster Frustum/Cone/HZB Cull
→ Compact Selected Clusters
→ Classify SW / HW / Alpha Work
→ Software Micro Raster
→ Transfer SW Visibility/Depth
→ Hardware Visibility Raster
→ Optional current-HZB late visibility
→ Unified Material Resolve
→ Clustered Lighting + IBL + Shadows
→ Transparency
→ Temporal and screen-space effects
→ Exposure / Bloom
→ Optional unified Render Debug View override
→ Tonemap
→ Present
```

## 软件微三角形光栅

WebGPU baseline 没有 64 位原子。目标实现使用两阶段、完整 32 位深度：

1. Depth 阶段遍历微三角形小包围盒，原子竞争完整 ordered depth。
2. Visibility 阶段再次处理微三角形，只为胜出深度写 VisibilityKey；深度相同时使用确定性 key 裁决。
3. Fullscreen transfer 把软件结果写入统一 Visibility attachment 和 `depth32float`。
4. Hardware Raster 以 load + depth test 合并大三角形。

是否采用更紧凑 packed 单阶段实现，由目标 GPU benchmark 决定，不能牺牲无法接受的深度或 ID 正确性。

## HZB

- 使用 Compute 在一个 Pass 内编码多个 mip dispatch，避免每 mip 一个 Render Pass。
- previous-HZB-only 与 same-frame late visibility 是同一主管线的调度选项，不是不同档位。
- second-chance 必须由运动、遮挡收益和性能数据决定，不无条件运行。
- 最终 Depth/HZB 的跨帧语义必须明确，不能用历史相机错误决定当前 LOD。

## Material Resolve

- Standard PBR 主路径一次扫描可见像素，动态读取 MaterialTable 和纹理页。
- 禁止长期保留“每个材质一个全屏三角形”的通用实现。
- 自定义材质未来使用少量 Shader Bin；不得退化为材质数 × 全屏像素扫描。
- Velocity 在 resolve 中根据当前/上一帧变换和可见几何生成，并处理 LOD 切换稳定性。

## 光照与效果

Clustered direct lighting、IBL、Shadow、Transparency、AO、SSR、TAA、Bloom、Exposure 和 Tonemap 属于同一资源图。每项必须：

- 声明资源依赖和历史失效条件；
- 支持关闭且接近零成本；
- 复用已有 Depth/HZB/Velocity，避免重复构建；
- 记录 GPU 时间和分辨率；
- 根据画质允许半分辨率、时域重建或 pass fusion。

## 统一调试视图

Renderer 只有一个 `render_debug_view` 选择。可运行视图在时域与后处理之后覆盖最终 HDR 输入，再复用主管线 Tonemap/Present；这样不会被 TAA、Bloom 或 Sharpen 改写，也不形成第二条渲染管线。尚无可靠 GPU producer 的条目必须报告 `unsupported`，不能输出占位颜色。`none` 和 `unsupported` 状态不添加 Pass、瞬态资源、readback 或 submit。
