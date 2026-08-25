# 源码导航地图

这份地图只列研究的首要入口。分析时继续沿 import、字段写入点和调用点向内追踪。

## 1. three.js

### 公共入口与场景语义

| 主题 | 入口 |
|------|------|
| WebGPU 导出面 | [`three.js/src/Three.WebGPU.js`](../../../three.js/src/Three.WebGPU.js) |
| 核心导出面 | [`three.js/src/Three.Core.js`](../../../three.js/src/Three.Core.js) |
| 场景图 | `three.js/src/core/Object3D.js`、`three.js/src/scenes/Scene.js` |
| 可渲染对象 | `three.js/src/objects/Mesh.js` |
| 几何与属性 | `three.js/src/core/BufferGeometry.js`、`BufferAttribute.js` |
| 材质 | `three.js/src/materials/` |

### common renderer

| 主题 | 入口 |
|------|------|
| 主编排器 | [`three.js/src/renderers/common/Renderer.js`](../../../three.js/src/renderers/common/Renderer.js) |
| renderer/backend seam | [`three.js/src/renderers/common/Backend.js`](../../../three.js/src/renderers/common/Backend.js) |
| render list | `three.js/src/renderers/common/RenderLists.js`、`RenderList.js` |
| render object | `three.js/src/renderers/common/RenderObjects.js`、`RenderObject.js` |
| pipeline | `three.js/src/renderers/common/Pipelines.js`、`RenderPipeline.js` |
| binding 与资源 | `Bindings.js`、`Textures.js`、`Attributes.js`、`Geometries.js` |
| nodes/TSL 接入 | `three.js/src/renderers/common/nodes/`、`three.js/src/nodes/` |

### WebGPU 实现

| 主题 | 入口 |
|------|------|
| 门面 | [`three.js/src/renderers/webgpu/WebGPURenderer.js`](../../../three.js/src/renderers/webgpu/WebGPURenderer.js) |
| backend | [`three.js/src/renderers/webgpu/WebGPUBackend.js`](../../../three.js/src/renderers/webgpu/WebGPUBackend.js) |
| WGSL 生成 | `three.js/src/renderers/webgpu/nodes/WGSLNodeBuilder.js` |
| binding / pipeline / texture | `three.js/src/renderers/webgpu/utils/WebGPUBindingUtils.js`、`WebGPUPipelineUtils.js`、`WebGPUTextureUtils.js` |

`three.js/build/` 和 `three.js/docs/` 是生成物，正常源码研究应回到 `src/`、`examples/jsm/`、`manual/` 和 `test/`。

## 2. reconstructed

### 公共入口与场景语义

| 主题 | 入口 |
|------|------|
| 包导出面 | [`research/shade-re/reconstructed/src/index.ts`](../../../research/shade-re/reconstructed/src/index.ts) |
| 场景图 | `src/scene/Scene.ts`、`Node3D.ts`、`Mesh.ts` |
| 几何 | `src/geometry/Geometry.ts`、`Attribute.ts`、`MeshletTypes.ts` |
| 材质 | `src/material/ShadeMaterial.ts`、`StandardShadeMaterial.ts` |

### 帧编排与 GPU 数据

| 主题 | 入口 |
|------|------|
| 主编排器 | [`src/render/Renderer.ts`](../../../research/shade-re/reconstructed/src/render/Renderer.ts) |
| 帧图 | [`src/framegraph/FrameGraph.ts`](../../../research/shade-re/reconstructed/src/framegraph/FrameGraph.ts) |
| GPU 场景同步 | [`src/gpu/GPUSceneManager.ts`](../../../research/shade-re/reconstructed/src/gpu/GPUSceneManager.ts) |
| GPU 数据库 | `src/gpu/GPUDatabase.ts`、`SceneDatabase.ts` |
| 资源分配 | `GPUBufferAllocator.ts`、`GPUTextureAllocator.ts`、`GPUStagingBufferAllocator.ts` |
| meshlet 数据 | `MeshletGpuPool.ts`、`MeshletGpuTable.ts`、`MeshletDrawList.ts` |
| 材质常驻数据 | `GPUResidentMaterialContext.ts`、`GPUMaterialContext.ts` |

### 渲染流程

| 主题 | 入口 |
|------|------|
| pass 实现 | `src/render/passes/` |
| HZB | `src/render/HierarchicalZBuffer.ts` |
| render targets | `src/render/RenderTargets.ts` |
| shader | `src/shaders/` |
| instance / meshlet culling | `mesh_instance_cull*.ts`、`meshlet_hzb_cull*.ts` |
| 工作生成/排序 | `meshlet_expand*.ts`、`meshlet_material_sort.ts`、`meshlet_bucket*.ts` |
| visibility / resolve | `visibility_*.ts`、`material_*.ts` |

`dist/`、`node_modules/` 不是研究入口。文件名带 `.generated.ts` 的内容应先寻找它的生成来源；若生成器缺失，再明确标注为“仅能从生成结果观察”。

## 3. 第一轮建议追踪路径

### three.js

```txt
WebGPURenderer
  → common/Renderer.render()
  → scene traversal / projection
  → RenderList
  → RenderObject / Pipeline / Bindings
  → WebGPUBackend
  → command encoder / queue submit
```

### reconstructed

```txt
Renderer
  → frame phase
  → GPUSceneManager / database sync
  → FrameGraph build
  → culling / visibility / resolve / post passes
  → command encoder / queue submit
```

这两条路径验证完成前，不把“CPU-driven”或“GPU-driven”标签当作足够细的解释。

