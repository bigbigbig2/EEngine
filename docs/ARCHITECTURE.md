# 当前架构

> 本文只记录当前已经接入的运行时事实。未来目标、强制约束与推进门槛见 [ENGINE-DIRECTION-AND-CONSTRAINTS.md](./ENGINE-DIRECTION-AND-CONSTRAINTS.md)。

## 总体数据流

```text
Loader / application
        ↓
Scene + Camera + Geometry + Material + Texture
        ↓
GPUSceneContext + GraphicsContext
        ↓
FrameGraph
        ↓
Visibility → Material Expand → Lighting/GI → Temporal/Post
        ↓
Swapchain
```

## 外部 interface

`reconstructed/src/index.ts` 是唯一公开 seam。示例和未来消费者只依赖这里，不能直接导入 `gpu`、`render/passes` 或 `shaders`。

这使外部调用者只需要理解 Renderer、Scene、Camera、资源和 Loader；GPU 数据库、FrameGraph 与 Pass 实现可以在不修改示例的情况下重构。

## 运行时所有权

```text
Renderer
├─ GraphicsContext                  device 级共享资源
│  ├─ buffer / texture allocators
│  ├─ shader / pipeline / bind-group caches
│  ├─ shared MeshletGpuTable
│  └─ shared GPUMaterialRegistry
├─ GPUSceneManager
│  └─ GPUSceneContext               每个 Scene
│     ├─ SceneDatabase
│     ├─ LightDatabase / Shadow
│     ├─ Animation / Skinning
│     ├─ TLAS / Probe / Volumetrics
│     └─ 引用共享 geometry/material
├─ ViewManager
│  └─ GPUViewContext                每个 Camera + Scene
│     ├─ current/previous camera
│     ├─ view uniform
│     └─ HZB
├─ RenderTargets / temporal history
└─ Pass owners
```

每次 GPU 提交创建 `ShadeGPUCommandContext`；每帧主渲染创建临时 `FrameGraph`。FrameGraph 声明 Pass 的 read/write/create 关系，裁剪无消费者 Pass，并在资源最后使用后归还 transient 资源。

## 主渲染管线

```text
GPUScene update
→ shadow selection/raster
→ mesh/meshlet frustum + HZB culling
→ GPU compact / prefix scan / indirect args
→ visibility ID + reverse-Z depth
→ material expansion to GBuffer
→ clustered direct lighting + indirect lighting
→ transparent OIT
→ velocity + TAA/NSS
→ motion blur + sharpen + bloom + exposure
→ tonemap
```

## 模块设计原则

1. `src/index.ts` 是外部 interface，内部目录不是公开 interface。
2. `Renderer` 是 composition root，只负责编排和所有权，不继续吸收算法实现。
3. GPU 常驻数据由明确 owner 管理；临时资源由 command context 或 FrameGraph 管理。
4. Pass 通过 `addToGraph()` 声明依赖，避免绕过 FrameGraph 创建跨 Pass 临时资源。
5. CPU 与 WGSL 的结构布局必须共享明确 ABI，不允许在调用点重复硬编码 offset。
