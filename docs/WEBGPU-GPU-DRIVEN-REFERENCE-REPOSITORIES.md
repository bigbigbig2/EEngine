# GitHub WebGPU / wgpu GPU-Driven 开源项目调研报告

> 文档角色：外部证据与阅读索引。本文中的推荐顺序不构成本项目路线；实现方向以 [ENGINE-DIRECTION-AND-CONSTRAINTS.md](./ENGINE-DIRECTION-AND-CONSTRAINTS.md) 为准。

本文为 [`reconstructed`](../reconstructed/README.md) 筛选 GitHub 上可直接学习的 WebGPU / wgpu GPU-Driven 渲染项目。重点不是罗列“支持 WebGPU”的引擎，而是回答：它是否真的让 GPU 决定本帧绘制工作、是否有 Meshlet/LOD/HZB/Indirect/Visibility Buffer，以及哪些设计能映射到当前引擎。

核实日期：**2026-08-23**。维护状态以 GitHub 仓库未归档、默认分支最新提交时间和仓库自述为依据；Star 只视为弱信号，不参与技术分级。源码链接固定到本次核实的 commit，避免默认分支后续变化导致本文与代码不一致。

## 0. 调研目标、范围与方法

调研目标：为 `reconstructed` 寻找可以实际阅读源码、验证算法和辅助后续架构设计的参考项目，重点回答以下问题：

1. 哪些项目真正实现了 GPU Scene、GPU culling、LOD、Meshlet、HZB、工作紧凑化或间接执行，而不只是提供 WebGPU API 封装。
2. 哪些实现能直接运行在浏览器 WebGPU，哪些只使用 native wgpu/Vulkan，但算法仍值得迁移。
3. 每个项目最值得学习的模块是什么，与当前引擎已经拥有或仍然缺少的能力如何对应。
4. 仓库的维护状态和许可证是否允许克隆、修改、复制或派生代码。

调研范围包括浏览器 WebGPU 引擎、Rust/wgpu renderer、GPU-Driven 教学样例，以及少量非 WebGPU 但对 Meshlet/HZB/Indirect 架构有直接参考价值的 Vulkan 实现。纯 2D、纯 Compute、只有 Clustered Lighting、仅封装 `GPUDevice`，或者没有可核实 GPU 工作生成证据的仓库，不进入主推荐序列。

证据优先级如下：

```text
固定 commit 的 Shader/Pass/资源源码
    > 同 commit 的 README、文档和测试
    > GitHub 仓库元数据
    > Star、项目宣传或二手文章
```

所有“已经实现”的判断均尽量附固定 commit 源码入口；只有 README 计划但未接入 consumer 的功能，会明确标为开发中或未闭环。调研不以仓库代码量、Star 数或品牌知名度代替技术证据。

## 1. 先说结论

如果只选三个项目：

1. **[`Scthe/nanite-webgpu`](https://github.com/Scthe/nanite-webgpu)**：浏览器 WebGPU 中与当前目标最接近，完整覆盖 Meshlet LOD hierarchy、实例/Meshlet 两级剔除、上一帧深度金字塔、SW/HW 混合光栅和大量统计。先读它。
2. **[Bevy Meshlet Renderer](https://github.com/bevyengine/bevy/tree/4805ca792c3e94eef07afd6fa9a2712f388c9a67/crates/bevy_pbr/src/meshlet)**：工程成熟度、两阶段遮挡、BVH8 LOD traversal、Visibility Buffer 和材质接入最值得与 `reconstructed` 对照；但当前只支持 Vulkan/Metal，不是浏览器 WebGPU 路径。
3. **[`schell/renderling`](https://github.com/schell/renderling)**：最适合学习 GPU-resident scene、统一 slab 数据模型、GPU frustum/HZB culling 与 multi-draw-indirect 的工程边界；没有 Meshlet hierarchy，遮挡仍标记为开发中。

针对 `reconstructed`，最值得吸收的顺序不是先上软件光栅器，而是：

```text
Bevy / nanite-webgpu 的层次 LOD 与误差模型
    → Bevy 的 BVH queue + indirect traversal
    → nanite-webgpu / Bevy 的 SW-HW 一致性与统计
    → renderling / rendiation 的 GPU Scene 数据所有权
    → 实测微三角形瓶颈后再决定是否加入 SW Raster
```

## 2. 分级标准

| 类别 | 本文含义 |
| --- | --- |
| A | 浏览器 WebGPU 上已经运行真实 GPU 工作生成：Meshlet/LOD、Compute culling、GPU compact、Indirect 或 Visibility 中至少形成闭环，最接近当前目标 |
| B | 完整 WebGPU 引擎，拥有 Compute、Indirect、Render Graph 等基础设施，但通用 Mesh 渲染主链尚不是 `reconstructed` 这种深度的 GPU-Driven |
| C | 教学/sample/reference，适合单独学某个机制，不应当作完整引擎架构 |
| D | wgpu native 或 Vulkan 等非浏览器输出，但算法/架构与当前引擎直接相关 |

“Clustered Lighting”中的 Cluster 是屏幕灯光分区，不是几何 Meshlet；“支持 Compute/Indirect API”也不等于引擎已经让 GPU 接管通用场景可见性。

## 3. 总览

| 类别 | 项目 | 语言 / 后端 | 已核实的 GPU-Driven 深度 | License | 最近提交 / 状态 |
| --- | --- | --- | --- | --- | --- |
| A | [nanite-webgpu](https://github.com/Scthe/nanite-webgpu) | TypeScript + WGSL / 浏览器 WebGPU | Meshlet LOD hierarchy、两级 frustum/HZB、SW/HW raster | MIT | 2026-05-10；未归档 |
| A | [RedGPU](https://github.com/redcamel/RedGPU) | TypeScript + WGSL / 浏览器 WebGPU | 实例级 GPU frustum、GPU distance LOD、compact、Indirect | **仓库无许可证文件** | 2026-07-17；未归档 |
| B | [PlayCanvas Engine](https://github.com/playcanvas/engine) | JavaScript + WGSL / WebGPU + WebGL2 | Indirect draw/dispatch 基础设施；GSplat 有 GPU cull/prefix/sort | MIT | 2026-08-22；未归档 |
| B | [Babylon.js](https://github.com/BabylonJS/Babylon.js) | TypeScript + WGSL/GLSL / WebGPU + WebGL | Compute indirect dispatch、FrameGraph、clustered lights；通用 Mesh 仍非 Meshlet GPU chain | Apache-2.0 | 2026-08-20；未归档 |
| B | [Orillusion](https://github.com/Orillusion/orillusion) | TypeScript + WGSL / 浏览器 WebGPU | 新增 GPU mesh cull、Hi-Z 和 indirect 输出，但主 ColorPass 尚未消费 | MIT | 2026-08-02；Beta、未归档 |
| C | [WebGPU Render Bundle Culling](https://github.com/toji/webgpu-bundle-culling) | JavaScript + WGSL / 浏览器 WebGPU | 实例 frustum → compact instance list → indirect instanced draw | MIT | 2024-03-13；未归档、低频维护 |
| C | [WebGPU Samples](https://github.com/webgpu/webgpu-samples) | TypeScript + WGSL / 浏览器 WebGPU | 官方样例索引：occlusion query、clustered shading、bundle culling | BSD-3-Clause | 2026-08-05；未归档 |
| D | [Bevy Meshlet Renderer](https://github.com/bevyengine/bevy/tree/4805ca792c3e94eef07afd6fa9a2712f388c9a67/crates/bevy_pbr/src/meshlet) | Rust + WESL / wgpu Vulkan、Metal | BVH8 LOD、两阶段 HZB、SW/HW raster、Visibility Buffer | MIT OR Apache-2.0 | 2026-08-22；实验特性、未归档 |
| D | [renderling](https://github.com/schell/renderling) | Rust + rust-gpu / wgpu | GPU-resident scene、GPU frustum/HZB、multi-draw-indirect | MIT OR Apache-2.0 | 2026-03-22；Alpha、未归档 |
| D | [voidin](https://github.com/pannapudi/voidin) | Rust + WGSL / wgpu native | Compute frustum 生成 indexed indirect、deferred/TAA/BVH | MIT | 2026-04-23；未归档、小型研究项目 |
| D | [rendiation](https://github.com/mikialex/rendiation) | Rust shader EDSL / wgpu | GPU-indirect scene、GPU parallel compute/task graph、LOD graph 模块 | **仓库无许可证文件** | 2026-08-20；活跃、Web viewer 自述 incomplete/buggy |
| D | [Kóoch](https://github.com/lobinuxsoft/kooch) | Rust + WGSL / wgpu native | Meshlet、LOD DAG、two-pass Hi-Z、Visibility/Deferred、Indirect | **All Rights Reserved** | 2026-08-05；Early Development、未归档 |
| D | [Niagara](https://github.com/zeux/niagara) | C++ + GLSL / Vulkan | GPU scene submission、LOD、HZB、Meshlet/Cluster cull、MDI/mesh shader | MIT | 2026-07-31；未归档 |

> License 是硬约束。RedGPU 与 rendiation 没有根许可证文件，默认不能假定可复制、修改或分发；Kóoch 明确禁止使用、复制、修改和逆向。它们可以帮助辨认架构问题，但不应把代码移入本工程。

## 4. A 类：浏览器 WebGPU 上真正接近的实现

### 4.1 Scthe/nanite-webgpu

- 仓库：[GitHub](https://github.com/Scthe/nanite-webgpu)
- 核实版本：[`b9cd33f`](https://github.com/Scthe/nanite-webgpu/commit/b9cd33f65bb3cdba0464717e0fa621d330d2116f)
- 技术栈：TypeScript、WGSL、浏览器 WebGPU；也可通过 Deno 离线运行。
- License：[MIT](https://github.com/Scthe/nanite-webgpu/blob/b9cd33f65bb3cdba0464717e0fa621d330d2116f/LICENSE)。
- 状态：未归档；最新提交为 2026-05-10，仍可运行，但定位始终是研究/教学实现，不是通用游戏引擎。

GPU-Driven 证据：

- [README 的能力与限制清单](https://github.com/Scthe/nanite-webgpu/blob/b9cd33f65bb3cdba0464717e0fa621d330d2116f/README.md)：明确声明 Meshlet LOD hierarchy、实例/Meshlet 两级 frustum + occlusion、SW raster 和 GPU-driven/CPU 模式切换。
- [`meshPreprocessing/createMeshlets.ts`](https://github.com/Scthe/nanite-webgpu/blob/b9cd33f65bb3cdba0464717e0fa621d330d2116f/src/meshPreprocessing/createMeshlets.ts)：Meshoptimizer + METIS 的 Meshlet 分组和 LOD hierarchy 构建入口。
- [`cullInstancesPass.wgsl.ts`](https://github.com/Scthe/nanite-webgpu/blob/b9cd33f65bb3cdba0464717e0fa621d330d2116f/src/passes/cullInstances/cullInstancesPass.wgsl.ts)：实例级剔除。
- [`cullMeshletsPass.wgsl.ts`](https://github.com/Scthe/nanite-webgpu/blob/b9cd33f65bb3cdba0464717e0fa621d330d2116f/src/passes/cullMeshlets/cullMeshletsPass.wgsl.ts)：Meshlet 可见性与 LOD 选择。
- [`depthPyramidPass.ts`](https://github.com/Scthe/nanite-webgpu/blob/b9cd33f65bb3cdba0464717e0fa621d330d2116f/src/passes/depthPyramid/depthPyramidPass.ts)：上一帧深度金字塔。
- [`rasterizeSwPass.wgsl.ts`](https://github.com/Scthe/nanite-webgpu/blob/b9cd33f65bb3cdba0464717e0fa621d330d2116f/src/passes/rasterizeSw/rasterizeSwPass.wgsl.ts) 与 [`rasterizeHwPass.ts`](https://github.com/Scthe/nanite-webgpu/blob/b9cd33f65bb3cdba0464717e0fa621d330d2116f/src/passes/rasterizeHw/rasterizeHwPass.ts)：软件/硬件光栅分流。

建议阅读顺序：`README → src/passes/README.md → createMeshlets.ts → nanite.wgsl.ts → cullInstances → cullMeshlets → depthPyramid → rasterizeSw/Hw → rasterizeCombine`。

最值得借鉴：

- 几何误差、父子 Meshlet group 与连续 LOD 的数据关系。
- 将实例与 Meshlet 剔除统计、SW/HW 三角形数量和 profiler 暴露到 UI。
- 同一份场景能切换 CPU/GPU path，便于验证 GPU 工作生成是否正确。
- 微三角形阈值、Billboard impostor 和 LOD 必须协同，而不是孤立看 SW Raster。

不能误认为：

- 它没有 two-pass/second-chance occlusion；只使用上一帧深度。
- 作者明确说明没有 Visibility Buffer、没有 shader work queue、没有 streaming/residency。
- 它按 Meshlet 派线程，Buffer 根据演示场景上界预分配；异构资产很多时并不具备 `reconstructed` 的 GPU Scene 扩展性。
- SW raster 采用受 32-bit atomic 限制的低精度打包，不能直接替代当前独立 Triangle/Mesh/Depth attachments。

### 4.2 RedGPU：实例级 GPU LOD/Indirect 的短实现

- 仓库：[GitHub](https://github.com/redcamel/RedGPU)
- 核实版本：[`64e5a3b`](https://github.com/redcamel/RedGPU/commit/64e5a3b8ffb6c7ddf7c91e07f7534b3088b8c324)
- 技术栈：TypeScript、WGSL、浏览器 WebGPU。
- License：README 指向 `LICENSE.md`，但该 commit 仓库中不存在该文件；按**未授予开源许可**处理。
- 状态：未归档；最新提交为 2026-07-17，维护活跃。

源码证据：

- [`instanceCullingCompute.wgsl`](https://github.com/redcamel/RedGPU/blob/64e5a3b8ffb6c7ddf7c91e07f7534b3088b8c324/src/display/instancingMesh/shader/instanceCullingCompute.wgsl)：每实例 sphere-frustum test、按相机距离选择最多 8 级 LOD、`atomicAdd` 紧凑可见实例，并直接写各 LOD 的 indirect `instanceCount`。
- [`InstancingMesh.ts`](https://github.com/redcamel/RedGPU/blob/64e5a3b8ffb6c7ddf7c91e07f7534b3088b8c324/src/display/instancingMesh/InstancingMesh.ts)：创建 `INDIRECT | STORAGE` Buffer、清 counter、dispatch Compute、为各 LOD 发间接绘制。
- [`InstanceMeshGPULOD` 示例](https://github.com/redcamel/RedGPU/blob/64e5a3b8ffb6c7ddf7c91e07f7534b3088b8c324/examples/3d/lod/InstanceMeshGPULOD/index.js)：用不同 geometry 演示距离 LOD。

最值得借鉴的是它的可读性：`instance → cull → lod bucket → atomic compact → indirect draw` 几乎是最短闭环，适合先理解 GPU LOD Buffer 布局。

不能误认为：它没有 Meshlet、HZB、Visibility Buffer、误差驱动 LOD 或层次 traversal；它的固定 `BOUNDING_RADIUS = 1` 和距离阈值是实例化演示约束，不是通用几何系统。由于缺失许可证，**不要复制源码**。

## 5. B 类：完整 WebGPU 引擎，但通用 Mesh GPU-Driven 较弱

### 5.1 PlayCanvas Engine

- 仓库：[GitHub](https://github.com/playcanvas/engine)，核实版本 [`0aaef5e`](https://github.com/playcanvas/engine/commit/0aaef5e432c4797ed23c1f966e2cc43232ec0613)，MIT，2026-08-22，未归档。
- WebGPU 后端入口：[`webgpu-graphics-device.js`](https://github.com/playcanvas/engine/blob/0aaef5e432c4797ed23c1f966e2cc43232ec0613/src/platform/graphics/webgpu/webgpu-graphics-device.js)。
- 最直接学习入口：[Indirect Draw 示例](https://github.com/playcanvas/engine/blob/0aaef5e432c4797ed23c1f966e2cc43232ec0613/examples/src/examples/compute/indirect-draw.example.mjs) 与 [WGSL](https://github.com/playcanvas/engine/blob/0aaef5e432c4797ed23c1f966e2cc43232ec0613/examples/src/examples/compute/indirect-draw.compute-shader.wgsl)。
- 更高级的 Compute 数据流：[`compute-gsplat-interval-cull.js`](https://github.com/playcanvas/engine/blob/0aaef5e432c4797ed23c1f966e2cc43232ec0613/src/scene/shader-lib/wgsl/chunks/gsplat/compute-gsplat-interval-cull.js) 结合 prefix sum/scatter、project、radix sort 和间接参数生成，适合参考 GPU compact/sort。

优点是完整引擎的资源、Shader chunk、GSplat 和 compute/indirect API 已工程化；缺点是通用三角 Mesh 主链没有 `reconstructed` 式 GPU Scene → Meshlet → HZB → Visibility。WebGPU 当前也没有标准 multi-draw-indirect，源码仍通过 CPU 循环发多个 `drawIndirect`；不要把 GSplat 专用 compute 管线等同于所有 Mesh 已 GPU-Driven。

### 5.2 Babylon.js

- 仓库：[GitHub](https://github.com/BabylonJS/Babylon.js)，核实版本 [`f22fdbe`](https://github.com/BabylonJS/Babylon.js/commit/f22fdbe48b108ab1ffb5586a12fa5a7b3060d09d)，Apache-2.0，2026-08-20，未归档。
- WebGPU 设备层：[`thinWebGPUEngine.ts`](https://github.com/BabylonJS/Babylon.js/blob/f22fdbe48b108ab1ffb5586a12fa5a7b3060d09d/packages/dev/core/src/Engines/thinWebGPUEngine.ts)。
- Compute 间接执行：[`computeShader.pure.ts`](https://github.com/BabylonJS/Babylon.js/blob/f22fdbe48b108ab1ffb5586a12fa5a7b3060d09d/packages/dev/core/src/Compute/computeShader.pure.ts) 和 [`engine.computeShader.pure.ts`](https://github.com/BabylonJS/Babylon.js/blob/f22fdbe48b108ab1ffb5586a12fa5a7b3060d09d/packages/dev/core/src/Engines/WebGPU/Extensions/engine.computeShader.pure.ts)。
- Render 间接 Buffer：[`webgpuDrawContext.ts`](https://github.com/BabylonJS/Babylon.js/blob/f22fdbe48b108ab1ffb5586a12fa5a7b3060d09d/packages/dev/core/src/Engines/WebGPU/webgpuDrawContext.ts)。这里常规 draw 参数由 CPU 的 `setIndirectData()` 上传，因此“用了 indirect draw”不等于 GPU 生成场景工作。
- Clustered Lighting：[`Lights/Clustered`](https://github.com/BabylonJS/Babylon.js/tree/f22fdbe48b108ab1ffb5586a12fa5a7b3060d09d/packages/dev/core/src/Lights/Clustered)，这是灯光分簇，不是几何 Meshlet。

它最适合学习大规模 Web 引擎的 WebGPU backend、兼容模式、pipeline/bind-group cache、FrameGraph 和 Compute API 设计，不适合作为 Meshlet/HZB Visibility 主链参考。

### 5.3 Orillusion

- 仓库：[GitHub](https://github.com/Orillusion/orillusion)，核实版本 [`908fd3d`](https://github.com/Orillusion/orillusion/commit/908fd3d65c8d4b6b4fc11117e3323bee047faa76)，MIT，2026-08-02，Beta、未归档。
- GPU culling shader：[`GPUFrustumCull_cs.ts`](https://github.com/Orillusion/orillusion/blob/908fd3d65c8d4b6b4fc11117e3323bee047faa76/src/assets/shader/compute/GPUFrustumCull_cs.ts)，包含 AABB frustum、可选 Hi-Z、atomic compact 和 indexed-indirect args。
- GPU culling 资源层：[`GPUCullSystem.ts`](https://github.com/Orillusion/orillusion/blob/908fd3d65c8d4b6b4fc11117e3323bee047faa76/src/gfx/renderJob/cull/GPUCullSystem.ts)。
- Render Graph 接口：[`GPUCullPass.ts`](https://github.com/Orillusion/orillusion/blob/908fd3d65c8d4b6b4fc11117e3323bee047faa76/src/gfx/renderJob/graph/passes/GPUCullPass.ts)。
- Hi-Z：[`HiZPass.ts`](https://github.com/Orillusion/orillusion/blob/908fd3d65c8d4b6b4fc11117e3323bee047faa76/src/gfx/renderJob/graph/passes/HiZPass.ts) 与 [`HiZGenerate_cs.ts`](https://github.com/Orillusion/orillusion/blob/908fd3d65c8d4b6b4fc11117e3323bee047faa76/src/assets/shader/compute/HiZGenerate_cs.ts)。

这是一个很有价值的“正在迁移到 GPU-Driven”案例：代码已经生成 Visibility/DrawCmd/DrawCount，但 `GPUCullPass` 的注释明确说 ColorPass 默认仍遍历 CPU opaque/transparent list，`drawIndexedIndirect` 消费是下一步；Hi-Z 也默认关闭或处于接线阶段。因此它应放 B 类，而不是依据文件名提前宣称已经完成闭环。

## 6. C 类：教学和单机制参考

### 6.1 WebGPU Render Bundle Culling

- 仓库：[GitHub](https://github.com/toji/webgpu-bundle-culling)，核实版本 [`3098596`](https://github.com/toji/webgpu-bundle-culling/commit/3098596aef18acd91e93d85156b49f08fcee9831)，MIT，2024-03-13，未归档但低频维护。
- 全部关键逻辑位于单文件 [`index.html`](https://github.com/toji/webgpu-bundle-culling/blob/3098596aef18acd91e93d85156b49f08fcee9831/index.html)：Compute frustum test 后 `atomicAdd(instanceCount)`，写 compact instance list，再用 `drawIndexedIndirect`/`drawIndirect`；还可对照 direct 与 Render Bundle 模式。

它是理解 `GPU producer → indirect args → render consumer` 的最佳短样例之一。限制是仅实例视锥剔除，没有 HZB、LOD、Meshlet、材质分类或通用 GPU Scene。

### 6.2 WebGPU Samples

- 仓库：[GitHub](https://github.com/webgpu/webgpu-samples)，核实版本 [`4944c70`](https://github.com/webgpu/webgpu-samples/commit/4944c705dcbf34c6d9d7ea88cf0a61586e0ce93b)，BSD-3-Clause，2026-08-05，未归档。
- [`bundleCulling/meta.ts`](https://github.com/webgpu/webgpu-samples/blob/4944c705dcbf34c6d9d7ea88cf0a61586e0ce93b/sample/bundleCulling/meta.ts) 指向上面的独立样例。
- [`occlusionQuery/main.ts`](https://github.com/webgpu/webgpu-samples/blob/4944c705dcbf34c6d9d7ea88cf0a61586e0ce93b/sample/occlusionQuery/main.ts) 展示标准 Occlusion Query；它会产生查询与读回，不等于 HZB GPU culling。
- [`clusteredShading/meta.ts`](https://github.com/webgpu/webgpu-samples/blob/4944c705dcbf34c6d9d7ea88cf0a61586e0ce93b/sample/clusteredShading/meta.ts) 是灯光分簇入口。

它适合核对 WebGPU API 的最小正确用法，不负责生产级场景/资源架构。

## 7. D 类：非浏览器输出，但算法直接相关

### 7.1 Bevy experimental Meshlet Renderer

- 仓库：[Bevy](https://github.com/bevyengine/bevy)，核实版本 [`4805ca7`](https://github.com/bevyengine/bevy/commit/4805ca792c3e94eef07afd6fa9a2712f388c9a67)，MIT OR Apache-2.0，2026-08-22，未归档。
- 限制由 [`meshlet/mod.rs`](https://github.com/bevyengine/bevy/blob/4805ca792c3e94eef07afd6fa9a2712f388c9a67/crates/bevy_pbr/src/meshlet/mod.rs) 明确写出：需要 texture int64 atomic、shader int64、subgroup 等特性，当前**仅 Vulkan 和 Metal**，不兼容 MSAA。

关键源码：

- [`from_mesh.rs`](https://github.com/bevyengine/bevy/blob/4805ca792c3e94eef07afd6fa9a2712f388c9a67/crates/bevy_pbr/src/meshlet/from_mesh.rs)：Meshoptimizer + METIS、group simplification、误差传播和 BVH8 构建。
- [`asset.rs`](https://github.com/bevyengine/bevy/blob/4805ca792c3e94eef07afd6fa9a2712f388c9a67/crates/bevy_pbr/src/meshlet/asset.rs)：压缩顶点、BVH8、LOD bounds、Meshlet cull data 的资产 ABI。
- [`cull_instances.wesl`](https://github.com/bevyengine/bevy/blob/4805ca792c3e94eef07afd6fa9a2712f388c9a67/crates/bevy_pbr/src/meshlet/cull_instances.wesl)、[`cull_bvh.wesl`](https://github.com/bevyengine/bevy/blob/4805ca792c3e94eef07afd6fa9a2712f388c9a67/crates/bevy_pbr/src/meshlet/cull_bvh.wesl)、[`cull_clusters.wesl`](https://github.com/bevyengine/bevy/blob/4805ca792c3e94eef07afd6fa9a2712f388c9a67/crates/bevy_pbr/src/meshlet/cull_clusters.wesl)：实例 → BVH → Cluster 的 GPU queue、LOD/occlusion 和 SW/HW 分类。
- [`visibility_buffer_raster_node.rs`](https://github.com/bevyengine/bevy/blob/4805ca792c3e94eef07afd6fa9a2712f388c9a67/crates/bevy_pbr/src/meshlet/visibility_buffer_raster_node.rs)：first cull/raster → current depth pyramid → second cull/raster → depth/material resolve 的完整编排，广泛使用 indirect dispatch/draw。
- [`visibility_buffer_software_raster.wesl`](https://github.com/bevyengine/bevy/blob/4805ca792c3e94eef07afd6fa9a2712f388c9a67/crates/bevy_pbr/src/meshlet/visibility_buffer_software_raster.wesl) 与 [`visibility_buffer_hardware_raster.wesl`](https://github.com/bevyengine/bevy/blob/4805ca792c3e94eef07afd6fa9a2712f388c9a67/crates/bevy_pbr/src/meshlet/visibility_buffer_hardware_raster.wesl)。

它和 `reconstructed` 的 second-chance HZB 最接近，且补齐了当前最缺的 BVH8 + geometric error LOD。不能误认为它已经支持浏览器、所有材质、MSAA 或所有 wgpu backend。

### 7.2 renderling

- 仓库：[GitHub](https://github.com/schell/renderling)，核实版本 [`a7b44f7`](https://github.com/schell/renderling/commit/a7b44f796a38cb2c734d69354fa35f1288aa02a1)，MIT OR Apache-2.0，2026-03-22，Alpha、未归档。
- [`README`](https://github.com/schell/renderling/blob/a7b44f796a38cb2c734d69354fa35f1288aa02a1/README.md) 明确说明 geometry、texture、material、lighting 和 scene graph 常驻 GPU slab。
- [`cull/shader.rs`](https://github.com/schell/renderling/blob/a7b44f796a38cb2c734d69354fa35f1288aa02a1/crates/renderling/src/cull/shader.rs)：rust-gpu 写的 frustum、深度金字塔和 occlusion compute。
- [`cull/cpu.rs`](https://github.com/schell/renderling/blob/a7b44f796a38cb2c734d69354fa35f1288aa02a1/crates/renderling/src/cull/cpu.rs)：构建上一帧 HZB 并 dispatch cull。
- [`draw/cpu.rs`](https://github.com/schell/renderling/blob/a7b44f796a38cb2c734d69354fa35f1288aa02a1/crates/renderling/src/draw/cpu.rs)：GPU 修改 indirect `instance_count` 后 `multi_draw_indirect`。

它最值得学习 GPU-resident scene/统一 slab，而不是 Meshlet。README 把 occlusion 标为 in progress，代码也依赖 `MULTI_DRAW_INDIRECT`；浏览器 WebGPU 基线没有 multi-draw-indirect，fallback path 的驱动深度不同。

### 7.3 voidin

- 仓库：[GitHub](https://github.com/pannapudi/voidin)，核实版本 [`36e84bb`](https://github.com/pannapudi/voidin/commit/36e84bb4e6c1bf4619df076cd2acdbeba1e63306)，MIT，2026-04-23，未归档。
- [`emit_draws.wgsl`](https://github.com/pannapudi/voidin/blob/36e84bb4e6c1bf4619df076cd2acdbeba1e63306/shaders/emit_draws.wgsl)：Compute frustum test 后为每实例写 `DrawIndexedIndirect`，不可见项的 `instance_count = 0`。
- [`visibility.rs`](https://github.com/pannapudi/voidin/blob/36e84bb4e6c1bf4619df076cd2acdbeba1e63306/crates/app/src/pass/visibility.rs)：Compute producer 后通过 `multi_draw_indexed_indirect` 进入硬件 GBuffer。

它适合读一个较小 Rust/wgpu renderer 的“GPU 发 Draw 参数”实现，并可顺带看 Deferred、TAA 和手写 BVH。不能误认为其 `Visibility` 名称就是 Visibility Buffer；该 Pass 实际直接输出 GBuffer。README 引用了 two-pass occlusion 文章，但当前主 shader 只有 frustum，不能据参考链接宣称已经实现 HZB。

### 7.4 rendiation

- 仓库：[GitHub](https://github.com/mikialex/rendiation)，核实版本 [`d0f6f41`](https://github.com/mikialex/rendiation/commit/d0f6f419929c7d9346fd99b6a02946f6fa4af1f2)，2026-08-20，未归档。
- License：根目录和各核实 Cargo manifest 未发现许可证声明；按未授权处理。
- [`scene/rendering/gpu-indirect`](https://github.com/mikialex/rendiation/tree/d0f6f419929c7d9346fd99b6a02946f6fa4af1f2/scene/rendering/gpu-indirect)：GPU storage、draw classification、GPU 生成 indirect provider 的通用 scene renderer。
- [`scene/rendering/occlusion-culling`](https://github.com/mikialex/rendiation/tree/d0f6f419929c7d9346fd99b6a02946f6fa4af1f2/scene/rendering/occlusion-culling)：可组合 culling 模块。
- [`content/mesh/lod-graph`](https://github.com/mikialex/rendiation/tree/d0f6f419929c7d9346fd99b6a02946f6fa4af1f2/content/mesh/lod-graph)：Nanite-like LOD graph 的内容构建模块。
- [`shader/task-graph`](https://github.com/mikialex/rendiation/tree/d0f6f419929c7d9346fd99b6a02946f6fa4af1f2/shader/task-graph)：on-device task graph runtime。

最有价值的是“关系数据库 + incremental query + GPU resource hook + indirect scene”的架构思想。它并没有在上述入口中证明 LOD graph、occlusion、task graph 已组成一条类似 Bevy 的 Meshlet Visibility 生产链；README 也称 wasm viewer incomplete/buggy。架构复杂且无许可证，不建议作为第一个阅读对象或复制来源。

### 7.5 Kóoch

- 仓库：[GitHub](https://github.com/lobinuxsoft/kooch)，核实版本 [`100fb18`](https://github.com/lobinuxsoft/kooch/commit/100fb18db948601693e7b58ca3dbed9f6858fc27)，2026-08-05，Early Development、未归档。
- License：[All Rights Reserved](https://github.com/lobinuxsoft/kooch/blob/100fb18db948601693e7b58ca3dbed9f6858fc27/LICENSE.md)，明确禁止使用、复制、修改、分发和逆向。
- [`meshlet` 模块](https://github.com/lobinuxsoft/kooch/tree/100fb18db948601693e7b58ca3dbed9f6858fc27/crates/kooch_render/src/meshlet)：Meshlet pool、cull、scene、visibility、deferred 和 material pass。
- [`render_hi_z_2pass.rs`](https://github.com/lobinuxsoft/kooch/blob/100fb18db948601693e7b58ca3dbed9f6858fc27/crates/kooch_render/src/meshlet/render_stage/frame/render_hi_z_2pass.rs)：previous Hi-Z cull/raster A → current Hi-Z → cull/raster B → deferred。
- [`atomic_hi_z.wgsl`](https://github.com/lobinuxsoft/kooch/blob/100fb18db948601693e7b58ca3dbed9f6858fc27/crates/kooch_render/shaders/meshlet_cull/atomic_hi_z.wgsl)：Hi-Z Meshlet culling。
- [`builder/lod_chain`](https://github.com/lobinuxsoft/kooch/tree/100fb18db948601693e7b58ca3dbed9f6858fc27/crates/kooch_render/src/meshlet/builder/lod_chain)：Meshopt simplification 与 LOD DAG。

技术映射非常接近当前工程，尤其 two-pass Hi-Z 与 Visibility/Deferred；但许可证使其只适合确认“另一种系统也遇到了哪些边界”。**不要 clone、复制、翻译或移植其中实现；如要深入使用先联系作者获得许可。** 模块顶层注释仍保留部分“Deferred/future work”旧文字，而代码已有实现，阅读时以实际编排和测试为准。

### 7.6 Niagara

- 仓库：[GitHub](https://github.com/zeux/niagara)，核实版本 [`eefec27`](https://github.com/zeux/niagara/commit/eefec2794681a1f8416e1fcc2771c1cdc11a86cb)，MIT，2026-07-31，未归档。
- [`README`](https://github.com/zeux/niagara/blob/eefec2794681a1f8416e1fcc2771c1cdc11a86cb/README.md) 的 stream 索引按顺序覆盖 MDI、GPU frustum、draw compaction/LOD、depth pyramid、automatic occlusion、triangle/Meshlet culling 和 task submission。
- [`drawcull.comp.glsl`](https://github.com/zeux/niagara/blob/eefec2794681a1f8416e1fcc2771c1cdc11a86cb/src/shaders/drawcull.comp.glsl)：实例/Draw culling 与 early/late 路径。
- [`depthreduce.comp.glsl`](https://github.com/zeux/niagara/blob/eefec2794681a1f8416e1fcc2771c1cdc11a86cb/src/shaders/depthreduce.comp.glsl)：Depth Pyramid。
- [`clustercull.comp.glsl`](https://github.com/zeux/niagara/blob/eefec2794681a1f8416e1fcc2771c1cdc11a86cb/src/shaders/clustercull.comp.glsl) 与 [`clustersubmit.comp.glsl`](https://github.com/zeux/niagara/blob/eefec2794681a1f8416e1fcc2771c1cdc11a86cb/src/shaders/clustersubmit.comp.glsl)：Cluster compute culling/提交。
- [`scene.h`](https://github.com/zeux/niagara/blob/eefec2794681a1f8416e1fcc2771c1cdc11a86cb/src/scene.h)：Mesh、LOD、Meshlet 和场景 GPU ABI。

这是理解 GPU-driven work generation 的高质量基线，代码小、演进过程可按视频/commit 追踪。它是 Vulkan 1.4 renderer，可使用 `drawIndirectCount`、mesh/task shader、buffer device address 等 WebGPU 不具备的能力；迁移时应借鉴算法而不是 API 调用。

## 8. 与 reconstructed 的映射

| reconstructed 当前模块/问题 | 首选参考 | 为什么 |
| --- | --- | --- |
| `GPUSceneContext` / SceneDatabase 数据所有权 | renderling、rendiation | GPU-resident slab 与增量/关系式 GPU resource 管理分别代表简单和复杂两端 |
| 当前平坦 Meshlet 展开前缺 GPU 几何 LOD | Bevy `from_mesh + BVH8`、nanite-webgpu preprocessing | 都把 geometric error、group bounds 和父子结构带到运行时选择 |
| 实例 → Meshlet 多级工作生成 | Bevy `cull_instances/cull_bvh/cull_clusters` | GPU queue + indirect traversal，比“全部 Meshlet 展开后再剔除”更接近下一阶段目标 |
| previous HZB + second chance | Bevy raster node、Kóoch 2-pass | 与当前 positive/maybe/current-HZB 补绘语义最接近；Kóoch 仅概念观察 |
| Prefix Scan / compact list | PlayCanvas GSplat、rendiation parallel-compute | 可对照 scan/scatter、multi-range dispatch 和通用并行原语 |
| DrawIndirect 最小闭环 | bundle-culling、RedGPU、voidin | 分别展示实例 compact、LOD bucket、每实例零化命令三种策略 |
| Visibility Buffer + Material Expand | Bevy、Kóoch | Bevy 可合法深入；Kóoch 只能观察模块边界，不得复制 |
| 微三角形与 SW/HW hybrid | nanite-webgpu、Bevy | 两者都有屏幕尺寸分类、software atomic raster 和 hardware indirect path |
| FrameGraph 接入 GPU cull | Orillusion | 清楚展示“已生成 Buffer，但 consumer 尚未接通”的迁移中间态，可避免当前工程出现孤儿 Pass |
| 统计与 Debug View | nanite-webgpu、Bevy、Kóoch tests | 前两者可作为实际实现参考；Kóoch 测试名只作为需求清单提示 |
| Vulkan 原生算法上限 | Niagara | 帮助区分算法价值与 WebGPU API 限制 |

关键差异：`reconstructed` 已经拥有 GPU Scene、实例/Meshlet 两级剔除、Prefix Scan、Indirect、硬件 Visibility Buffer、reverse-Z min/max HZB 和 second chance。多数候选只覆盖其中一段。因此参考目标应该是**补齐层次几何 LOD并提升可观测性**，而不是退回单模型 Demo 或重写现有 Visibility。

## 9. 推荐阅读顺序

### 第一轮：一天内建立共同词汇

1. `webgpu-bundle-culling/index.html`：看懂 atomic compact 与 indirect args。
2. RedGPU 的 `instanceCullingCompute.wgsl`：在上一步增加 GPU LOD bucket。
3. nanite-webgpu 的 README“Features/Limitations”和 `passes/README`：建立完整 Meshlet pipeline 地图。

### 第二轮：三到五天研究当前引擎最缺的 LOD

1. nanite-webgpu `createMeshlets.ts` 与 `nanite.wgsl.ts`。
2. Bevy `from_mesh.rs`：重点读 group、simplify error、LOD bounds、BVH8 build。
3. Bevy `asset.rs → cull_bvh.wesl → cull_clusters.wesl`：跟踪同一份 error/bounds 如何到 GPU。
4. 把字段映射到当前 `MeshletGpuTable/GeometryMeta`，先写设计笔记，不立即改 raster path。

### 第三轮：验证遮挡与 Visibility 集成

1. Bevy `visibility_buffer_raster_node.rs` 对比本地 `VisibilityPass.ts`。
2. Niagara `drawcull → depthreduce → clustercull`，观察 early/late pipeline 的最小 Vulkan 表达。
3. 对照 nanite-webgpu 的明确限制，确认当前 second chance 不应被 simpler previous-HZB 方案替换。

### 第四轮：工程架构

1. renderling GPU slab 和 draw/cull 的数据所有权。
2. PlayCanvas/Babylon 的 WebGPU device/cache/compatibility 边界。
3. 最后再读 rendiation；它适合已有整体认知后研究 task graph 和 incremental GPU resources。

## 10. 克隆与阅读计划

建议在工程外建立只读参考目录，固定 commit，避免参考仓库更新后结论漂移：

```powershell
$referenceRoot = 'D:\shu\reference-renderers'
New-Item -ItemType Directory -Force -Path $referenceRoot

git clone https://github.com/Scthe/nanite-webgpu.git "$referenceRoot\nanite-webgpu"
git -C "$referenceRoot\nanite-webgpu" checkout b9cd33f65bb3cdba0464717e0fa621d330d2116f

git clone --filter=blob:none --sparse https://github.com/bevyengine/bevy.git "$referenceRoot\bevy"
git -C "$referenceRoot\bevy" checkout 4805ca792c3e94eef07afd6fa9a2712f388c9a67
git -C "$referenceRoot\bevy" sparse-checkout set crates/bevy_pbr/src/meshlet examples/3d

git clone https://github.com/schell/renderling.git "$referenceRoot\renderling"
git -C "$referenceRoot\renderling" checkout a7b44f796a38cb2c734d69354fa35f1288aa02a1

git clone https://github.com/zeux/niagara.git "$referenceRoot\niagara"
git -C "$referenceRoot\niagara" checkout eefec2794681a1f8416e1fcc2771c1cdc11a86cb
```

然后建立一份只记录结论、不复制实现的阅读表：

| 周期 | 输出 |
| --- | --- |
| 第 1 天 | 画出每个项目一帧 pipeline；标注 CPU/GPU producer/consumer |
| 第 2–3 天 | 抽取 LOD asset ABI：bounds、error、parent/child、Meshlet range |
| 第 4 天 | 对照 current `MeshletGpuTable` 写字段兼容表和容量预算 |
| 第 5 天 | 写 GPU traversal 伪代码，定义 overflow、fallback、debug counter |
| 第 2 周 | 只实现统计/Debug View 与静态 opaque LOD prototype，做 GPU capture |

以下项目不要进入自动 clone 清单：

- Kóoch：All Rights Reserved，许可证明确禁止复制/使用。
- RedGPU、rendiation：仓库没有可核实的开源许可证；得到作者授权前，不应复制或派生代码。

## 11. 被筛选但不建议优先投入的项目

- [`hexops/mach`](https://github.com/hexops/mach)：Zig 游戏引擎/图形工具包，GitHub 只是主站代码仓库的镜像；2026-05-22 有更新，MIT OR Apache-2.0。它适合研究 Zig + native WebGPU binding 和引擎模块化，但本次未在仓库入口找到 Meshlet/HZB/Visibility GPU chain 证据，故不纳入主参考序列。
- [`BVE-Reborn/rend3`](https://github.com/BVE-Reborn/rend3)：Rust/wgpu renderer、RenderGraph 和 PBR 的工程结构清晰，MIT OR Apache-2.0 OR Zlib；但仓库已归档，最后提交为 2024-05-03，且没有与当前目标同等级的 Meshlet/HZB work generation。适合读旧式 wgpu renderer 架构，不适合投入为 GPU-Driven 主参考。

## 12. 最终选择建议

按当前工程的现实缺口，建议维护三套参考基线：

- **算法基线**：Bevy Meshlet + Niagara。
- **浏览器约束基线**：nanite-webgpu + WebGPU bundle culling。
- **工程数据基线**：renderling；需要更复杂的增量模型时再看 rendiation，但不复制无许可代码。

第一项可落地工作应是给 `reconstructed` 增加候选/可见 Meshlet、屏幕尺寸、LOD error、positive/maybe/second-chance 和 indirect workload 的 GPU 统计，然后再以 Bevy/nanite-webgpu 的数据模型设计 GPU geometric LOD。Compute 软件光栅化排在性能证据之后。
