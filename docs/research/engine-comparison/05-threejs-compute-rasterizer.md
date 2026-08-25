# three.js `webgpu_compute_rasterizer`：它是不是 GPU-Driven？

> 状态：源码与官方 PR 初步核验完成  
> three.js 基线：package `0.185.0`，commit `7cda7e710d884827fc73ff1a3aa63270846513d7`  
> 核验日期：2026-08-04

## 结论

`webgpu_compute_rasterizer` **确实实现了真实的 GPU-driven 工作流**：GPU 决定实例与 cluster 的可见性、LOD、工作队列大小、compute dispatch 数量，以及交给硬件光栅路径的三角形数量。

但要加上三个限定词：

> 它是一个**示例级、专用、混合式**的 GPU-driven compute rasterizer。

它证明了 three.js 的 WebGPU、TSL、storage buffer 和 indirect 能力已经足以承载 GPU-driven 渲染实验；它不代表 `WebGPURenderer.render( scene, camera )` 的默认通用场景渲染路径已经整体变成 GPU-driven，也不是完整 Nanite 实现。

## 1. 一帧到底做了什么

基础示例的实际顺序是：

```txt
CPU：更新相机矩阵和视锥平面 uniform
  ↓
Compute Clear
  清 visibility buffer、work queue counter、HW queue counter
  ↓
Compute Frustum
  GPU instance frustum culling
  GPU screen-space-error LOD
  GPU 64-triangle chunk frustum culling
  原子追加可见 chunk 到 work queue
  ↓
Compute Dispatch
  GPU 根据 work queue count 写 dispatch indirect 参数
  ↓
Compute Rasterize（dispatchWorkgroupsIndirect）
  小三角形 → compute shader 软件光栅
  大三角形 → GPU 追加到 hardware queue
  ↓
Compute HW Args
  GPU 写 drawIndirect 参数
  ↓
Fullscreen Resolve
  从 triangle/instance visibility buffer 重建属性并着色
  ↓
Hardware Raster
  vertex pulling + drawIndirect 处理大三角形
```

一帧的固定调度顺序直接写在示例的 `animate()` 中：

- [基础示例 animate](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer.html:1084)
- [官方 GitHub 固定版本源码](https://github.com/mrdoob/three.js/blob/7cda7e710d884827fc73ff1a3aa63270846513d7/examples/webgpu_compute_rasterizer.html#L1084-L1136)

## 2. 为什么它可以叫 GPU-Driven

判断 GPU-driven 的关键不是“用了 compute”，而是**谁决定本帧实际执行多少工作**。

这个示例中：

- `[事实]` GPU 对每个 instance 做视锥剔除，并选择 LOD。
- `[事实]` GPU 对 64-triangle chunk 做第二级剔除。
- `[事实]` 可见 chunk 通过 `atomicAdd` 写入 GPU work queue。
- `[事实]` GPU 根据 work queue count 生成 indirect compute dispatch 参数。
- `[事实]` GPU 将过大的三角形追加到 hardware queue，并生成 indirect draw 参数。
- `[事实]` CPU 不把可见数量读回后再逐项提交 draw。

关键代码：

- [GPU culling、LOD 与工作分配](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer.html:392)
- [GPU 生成 indirect dispatch 参数](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer.html:522)
- [indirect compute rasterizer](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer.html:547)
- [GPU 生成 hardware draw 参数](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer.html:754)

因此，虽然 CPU 仍然提交固定的几个 pass，但 GPU 决定了这些 pass 内部的实际工作规模。这是 GPU-driven，而不仅是“GPU 做计算”。

## 3. 混合式光栅化

这个示例没有坚持所有三角形都走 software rasterizer。

### 小三角形

每个 compute thread 处理一个三角形：

1. vertex pulling。
2. MVP 变换和 back-face rejection。
3. 计算屏幕 bounding box。
4. 遍历 bounding box 内像素。
5. 用 edge function 判断覆盖。
6. 将 depth 与 triangle/instance payload 打包后，通过 `atomicMax` 写入 visibility buffer。

源码：

- [compute software raster 核心](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer.html:547)
- [packed atomic visibility 写入](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer.html:690)

### 大三角形

software rasterizer 单线程遍历大 bounding box 会产生接近面积级的像素循环，因此示例设置 `MAX_RASTER_SIZE`。超过阈值的三角形不会由 compute 扫像素，而是进入 hardware queue。

之后 GPU 写入 `drawIndirect` 参数，普通硬件 raster pipeline 通过 vertex pulling 绘制这些三角形。

源码：

- [大三角形保护与入队](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer.html:624)
- [hardware raster mesh](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer.html:783)

所以 `Both` 模式的准确描述是：

```txt
GPU-driven work generation
  + compute software raster for small triangles
  + indirect hardware raster for large triangles
```

## 4. Visibility Buffer 与 Resolve

software rasterizer 不直接计算最终 PBR 颜色，而是写入紧凑 visibility 信息：

- triangle index
- instance index
- packed depth

全屏 resolve 再根据这些 ID：

1. 读取三角形的三个顶点。
2. 重新投影到屏幕空间。
3. 重建 barycentric coordinates。
4. 做 perspective-correct UV 插值。
5. 显式计算 texture gradients。
6. 读取纹理并输出最终结果。

这已经具备典型 visibility-buffer / deferred material resolve 路线的核心形态。

源码：[基础示例 fullscreen resolve](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer.html:864)。

## 5. IBL 版本增加了什么

[`webgpu_compute_rasterizer_ibl.html`](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer_ibl.html) 更接近现代 GPU-driven renderer 的完整演示：

- 使用 `MeshoptClusterizer` 构建 meshlet。
- 使用 `MeshoptSimplifier` 生成 LOD。
- 使用上一帧 depth 构建 HZB。
- 对 instance 和 meshlet/chunk 做 occlusion culling。
- 在 visibility resolve 中重建 world position、normal、UV 和导数。
- 通过 `MeshStandardNodeMaterial` 接入 IBL/PBR lighting。
- 支持 normal、roughness、metalness、AO、emissive。
- 加入 specular antialiasing。

关键源码：

- [加载单个 glTF source mesh/material](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer_ibl.html:169)
- [meshoptimizer meshlet 打包](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer_ibl.html:318)
- [instance/chunk HZB occlusion 与 LOD](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer_ibl.html:693)
- [PBR fullscreen resolve](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer_ibl.html:1266)
- [整帧与下一帧 HZB 构建](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer_ibl.html:1717)

官方 PR #33783 对它的描述是：在原 compute rasterizer 上增加标准 lighting pipeline、occlusion culling 和 specular antialiasing。PR 讨论中，作者同时说明当时接入 lighting 的实现仍有 “hacks”，更正式的 deferred renderer pipeline 尚在后续。

来源：[three.js PR #33783](https://github.com/mrdoob/three.js/pull/33783)。

## 6. three.js 核心已经提供了哪些 GPU-driven 积木

这两个示例不是直接调用裸 WebGPU，而是大量复用 three.js WebGPU/TSL 基础设施：

| 能力 | three.js 实现 |
|------|----------------|
| GPU 可读写 buffer | `StorageBufferAttribute` + TSL `storage()` |
| 原子操作 | TSL `atomicAdd`、`atomicMax`、`atomicLoad/Store` |
| GPU 写 dispatch 参数 | `IndirectStorageBufferAttribute` |
| indirect compute | `dispatchWorkgroupsIndirect()` |
| GPU 写 draw 参数 | `BufferGeometry.setIndirect()` |
| indirect draw | `drawIndirect()` / `drawIndexedIndirect()` |
| shader 表达 | TSL `Fn`、`If`、`Loop`、NodeMaterial |

源码入口：

- [`IndirectStorageBufferAttribute`](/D:/shu/engine/three.js/src/renderers/common/IndirectStorageBufferAttribute.js:3)
- [`BufferGeometry.setIndirect()`](/D:/shu/engine/three.js/src/core/BufferGeometry.js:247)
- [WebGPU indirect compute](/D:/shu/engine/three.js/src/renderers/webgpu/WebGPUBackend.js:1917)
- [WebGPU indirect draw](/D:/shu/engine/three.js/src/renderers/webgpu/WebGPUBackend.js:2142)

`IndirectStorageBufferAttribute` 的官方 PR 明确将目标描述为：compute shader 填充 draw buffer，之后由 `drawIndirect` 使用，从而把 visibility check 从 CPU 移到 GPU。

来源：[three.js PR #29594](https://github.com/mrdoob/three.js/pull/29594)。

## 7. 为什么不能说 WebGPURenderer 已经整体 GPU-Driven

默认 `renderer.render( scene, camera )` 仍然执行传统通用 scene/render-list 路径：

1. CPU 更新 `scene.matrixWorld`。
2. CPU 递归 `_projectObject()`。
3. CPU 测试对象 visibility、layers 和 frustum。
4. CPU 将对象、geometry、material 推入 `RenderList`。
5. CPU 对 opaque/transparent 列表排序和遍历。
6. backend 编码最终 draw。

源码：

- [默认 render 入口](/D:/shu/engine/three.js/src/renderers/common/Renderer.js:1488)
- [scene 更新与 RenderList 构建](/D:/shu/engine/three.js/src/renderers/common/Renderer.js:1739)
- [CPU `_projectObject()` 与 frustum test](/D:/shu/engine/three.js/src/renderers/common/Renderer.js:3235)
- [CPU 遍历 render objects](/D:/shu/engine/three.js/src/renderers/common/Renderer.js:3462)

compute rasterizer 示例没有把 16 万个实例作为 16 万个 `Object3D` 交给该路径。它把实例、顶点、索引、LOD 和 bounds 放进自定义 storage buffers；普通 renderer 最后只看到 fullscreen resolve quad/mesh 和 hardware fallback mesh 等极少数对象。

因此更准确的表述是：

> WebGPURenderer 的默认通用路径仍以 CPU scene traversal 和 RenderList 为中心；但它已经开放了足够的底层 interface，让应用在 three.js 之上构建 GPU-driven 子管线，甚至绕过大量默认几何提交逻辑。

## 8. 当前示例的工程限制

### 示例级实现

整套算法位于示例 HTML 中，没有形成可复用的 `GPUScene`、`VisibilitySystem`、`WorkGenerator` 或 `FrameGraph` module。

### 专用数据模型

- 基础版针对一个 teapot geometry 模板及大量实例。
- IBL 版遍历 glTF 后保存一个 `sourceMesh`，使用它的 geometry/material 构建专用 mega buffers。
- 不是把任意 three.js `Scene` 自动编译成 GPU scene。

### 固定容量和位预算

基础示例包含固定限制：

- `MAX_WORK_ITEMS = 2,820,000`
- `MAX_HW_TRIANGLES = 100,000`
- triangle index：14 bit
- instance index：18 bit

IBL 版本同样有固定 work/HW queue 和 payload bit budget，并在超过预算时抛错或截断工作。

### 不是完整 Nanite

它没有展示完整 Nanite 体系中的：

- virtual geometry pages
- geometry streaming/residency
- hierarchical cluster DAG
- page request feedback
- 通用多资产/多材质 GPU database

基础示例最初名为 `webgpu_compute_nanite-style`，随后官方将其改名为 `webgpu_compute_rasterizer`，后者更准确。

来源：

- [初始 PR #33605](https://github.com/mrdoob/three.js/pull/33605)
- [重命名 commit `4c83d5e`](https://github.com/mrdoob/three.js/commit/4c83d5e32dc8ef3f46d4024689a752eeb7df4561)

## 9. 与 reconstructed 的架构差别

两边都出现了 GPU culling、meshlet、visibility buffer、resolve 和 indirect work，但它们所处的层级不同。

| 维度 | three.js compute rasterizer 示例 | reconstructed |
|------|----------------------------------|---------------|
| 定位 | 一个垂直、专用实验 | 引擎主渲染路径 |
| GPU scene | 示例局部 storage buffers | `GPUSceneManager`、数据库、表和 allocator |
| 帧调度 | `animate()` 手写固定 compute/render 顺序 | `Renderer` + `FrameGraph` + pass modules |
| 场景接入 | 手工转换一个 geometry/material 模板 | scene tick、GPU 数据同步和长期资源管理 |
| visibility | 示例内 kernel | `VisibilityPass` 及多轮 HZB/second-chance/alpha-tested 路径 |
| material resolve | 示例内专用 resolve material | `MaterialExpandPass` + 后续 lighting/indirect passes |
| 生命周期 | demo 初始化和 resize 时手工重建 | manager/allocator/reusable resource 体系 |
| 扩展范围 | 证明 TSL/WebGPU 能力 | 尝试形成完整 renderer architecture |

reconstructed 证据入口：

- [`Renderer` 的完整帧阶段](/D:/shu/engine/research/shade-re/reconstructed/src/render/Renderer.ts:70)
- [`GPUSceneManager`](/D:/shu/engine/research/shade-re/reconstructed/src/gpu/GPUSceneManager.ts:10)
- [`FrameGraph`](/D:/shu/engine/research/shade-re/reconstructed/src/framegraph/FrameGraph.ts:352)
- [主帧 visibility/HZB/material expand](/D:/shu/engine/research/shade-re/reconstructed/src/render/Renderer.ts:489)

所以原先“three.js 是 CPU-driven、reconstructed 是 GPU-driven”的说法需要变得更精确：

```txt
three.js 默认通用 renderer：仍以 CPU scene traversal / RenderList 为中心
three.js WebGPU/TSL 能力层：已经支持构建真实 GPU-driven 子管线
three.js compute rasterizer：示例级 GPU-driven 垂直原型
reconstructed：把 GPU-driven 作为引擎级、跨模块的主架构
```

## 10. 官方与社区演进

### 官方时间线

- [PR #29594](https://github.com/mrdoob/three.js/pull/29594)：引入 `IndirectStorageBufferAttribute`，让 compute 写 draw 参数。
- [PR #30394](https://github.com/mrdoob/three.js/pull/30394)：TSL `struct`，改善结构化 GPU 数据表达。
- [PR #33605](https://github.com/mrdoob/three.js/pull/33605)：最初的 experimental GPU-driven software rasterizer。作者称其为 study、first step，并指出示例仍然技术化。
- [PR #33783](https://github.com/mrdoob/three.js/pull/33783)：加入 IBL/PBR、HZB occlusion、meshoptimizer meshlet 和 specular AA。

### 社区探索

PR #33605 的讨论中，Needle 团队展示了基于该示例的 fork：加入浏览器内 GLB meshlet 化、multi-object 和更多材质属性；讨论同时记录了大 mesh 性能、边缘闪烁等问题。

- [官方 PR 中的社区讨论](https://github.com/mrdoob/three.js/pull/33605)
- [Needle 社区分支](https://github.com/needle-tools/three.js/tree/feature/meshlet-creation-sample)

这说明社区已经开始把实验向通用资产流程推进，但尚不能视为 three.js upstream 的稳定通用 GPU-driven renderer。

## 最终判断

一句话：

> `webgpu_compute_rasterizer` 已经实现了真正的 GPU culling、GPU work generation、indirect dispatch/draw 和 visibility resolve；但它是建立在 three.js WebGPU/TSL 积木之上的专用研究原型，不等于 three.js 默认 renderer 已经完成 GPU-driven 架构迁移。

对 OEngine/reconstructed 最值得研究的，不是“three.js 也做了，所以路线相同”，而是：three.js 证明了 **TSL + 通用 renderer interface 可以容纳一条高度定制的 GPU-driven 旁路**。这可能为 OEngine 的兼容层、shader 表达层和渐进式接入方式提供很有价值的参照。
