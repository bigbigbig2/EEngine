# reconstructed 引擎全量代码审计与能力缺口报告

> 审计对象：`research/shade-re/reconstructed`
>
> 审计日期：2026-08-25
>
> 审计方式：全仓静态源码审计、调用点反查、资源所有权检查、TypeScript 类型检查与构建验证
>
> 范围：公共 API、Core/Math、场景、相机与输入、几何与 Meshlet、资产加载、纹理、GPU 基础设施、GPU Scene、动画/蒙皮、材质、灯光/阴影、FrameGraph、完整实时渲染链、GI/PathTracer/SDF/Volumetrics、生命周期、平台与测试
>
> 文档角色：这是 2026-08-25 的现状与缺陷证据快照，不再作为持续维护的重构路线图。后续方向和阶段门槛统一见 [ENGINE-DIRECTION-AND-CONSTRAINTS.md](./ENGINE-DIRECTION-AND-CONSTRAINTS.md)。

## 1. 先给结论

`reconstructed` 不是只有几段 GPU-Driven 演示代码。它已经是一套约 8 万行 TypeScript、以 WebGPU 为唯一图形后端、围绕 GPU Scene、Meshlet、Visibility Buffer 和延迟材质展开构建的实验性实时渲染器。

它真正做成并接入主帧的部分很多：多模型 GPU Scene、实例与 Meshlet 级 GPU 剔除、HZB 遮挡剔除、Indirect Dispatch/Draw、硬件 Visibility Buffer、固定 Standard PBR Material Expand、阴影、Clustered Lighting、IBL、SSAO、SSR、透明 OIT、TAA、NSS、Bloom、自动曝光和 Tonemap。

但它还不能被视为一套可稳定承担通用游戏生产的完整引擎。主要障碍并不只在“没有 Draco、LOD、虚拟几何”，而是在更基础的正确性与工程闭环上：

1. CPU 场景变换、灯光和材质修改没有可靠地同步到 GPU。
2. 场景树和 `SceneInstances` / `SceneLights` 注册表可能失配。
3. Renderer、GraphicsContext、GPU Scene 和若干旁路系统的销毁链不完整。
4. glTF/USD/自定义 SHADE loader 存在明确兼容缺口和确定性 bug。
5. FrameGraph 已经在主帧使用，但还不是能够完整表达依赖、自动调度与验证资源状态的 RenderGraph。
6. 大量功能是“有实现但只提供手工旁路”，或“只有消费者，没有数据生产管线”。
7. 主链仍依赖大量 oracle/generated 逆向迁移 shader，测试体系几乎为空。

因此，当前最准确的定位是：

> 一套渲染能力很深、GPU-Driven 主链真实可见，但运行时对象语义、资源生命周期、资产生态、自动化验证和可维护性仍处于研究/重建阶段的 WebGPU Renderer，而不是完整的通用游戏引擎。

## 2. 审计口径

本文不再用“仓库里搜到某个类或 shader”作为“功能已完成”的依据。每项能力按以下状态分类：

| 状态 | 含义 |
|---|---|
| 主帧已接入 | `Renderer.render()` 的正常帧路径会创建、更新并消费它 |
| 条件主帧 | 已在主帧接线，但受 feature flag 或渲染模式控制 |
| 主帧外接入 | 每帧会执行，但命令或资源绕过主 FrameGraph |
| 手工旁路 | 有真实实现和 API，但默认 `render()` 不调用，用户必须自行驱动 |
| 部分实现 | 核心路径存在，但数据、格式、动态更新或生命周期不闭环 |
| 孤立实现 | 数据结构、producer、shader 或 utility 存在，但当前无有效消费者/调用点 |
| Stub / no-op | 明确抛出 `Not implemented`、空方法或占位行为 |
| 未找到 | 全仓调用点和数据布局审计都没有发现该能力 |

“未找到”表示本次审计在当前源码版本中未找到，不代表作者未来不会加入，也不把注释、命名或相近功能当作实现。

## 3. 仓库规模与模块边界

`src` 下共有 282 个文件，其中 274 个 TypeScript 文件，约 7.5～8.3 万行 TypeScript（统计方式是否包含空行、生成文件和非 `.ts` 资源会造成差异）。模块包括：

| 模块 | 主要职责 | 成熟度概述 |
|---|---|---|
| `core` / `core/math` | 容器、哈希、信号、颜色、向量、矩阵、WGSL 布局 | 基础较多，仍有公开空实现和逆向命名残留 |
| `scene` / `camera` / `light` | CPU 世界模型、层级、相机、输入、灯光 | 静态场景够用，动态 dirty 与结构变更语义不完整 |
| `geometry` | Geometry、Attribute、Meshlet 构建、压缩、BVH | Meshlet 实现真实且较深，无多级 LOD/流送 |
| `loaders` | glTF、USD、SHADE、AVIF、环境图 | 覆盖多格式，但兼容范围有限，存在确定性 bug |
| `texture` | CPU 图像、纹理描述、采样器数据 | 基础数据模型存在，动态纹理更新语义缺失 |
| `gpu` | 分配器、数据库、缓存、GPU Scene、TLAS、材质、纹理、动画 | 功能最深，同时也是资源所有权风险最集中的区域 |
| `framegraph` | 命令上下文、资源版本、瞬态池、计时 | 已进入主帧，依赖表达和调度仍不完整 |
| `render` / `render/passes` | Renderer、View、RT 与全部渲染 Pass | 主链覆盖很广；旁路、history 和销毁管理仍分散 |
| `shaders` | WGSL、oracle 与 generated shader | 可运行实现与迁移技术债并存 |

公共包入口集中在 [`src/index.ts`](../reconstructed/src/index.ts)。它导出了 Renderer、Scene、Mesh、Node3D、PerspectiveCamera、OrbitalCameraController、三种灯光、Standard 材质、纹理、动画数据以及 glTF/USD/SHADE loader。内部模块不是稳定 API，这个边界本身是合理的。

## 4. 全量功能矩阵

| 子系统 | 当前状态 | 关键判断 |
|---|---|---|
| WebGPU 初始化 | 已实现 | 可自行请求 adapter/device，也可注入 device |
| 多模型 GPU Scene | 主帧已接入、动态更新部分完成 | 多 geometry/material/instance 可驻留；变换与 dirty 闭环有断链 |
| Meshlet 构建与上传 | 已实现 | CPU meshoptimizer + 自定义压缩/BVH + GPU pool/table |
| GPU 实例/Meshlet 剔除 | 主帧已接入 | 视锥、上一帧 HZB、同帧 second chance |
| Indirect Dispatch/Draw | 主帧已接入 | GPU 生成 work queue 与间接命令 |
| Visibility Buffer | 主帧已接入 | 硬件 raster，不是 compute 软件光栅 |
| HZB / 遮挡剔除 | 主帧已接入 | 实例与 Meshlet 两级，含同帧补救 |
| Standard PBR 材质 | 主帧已接入 | 固定材质模型与固定 GBuffer 展开 |
| 通用材质系统 | 未完成 | 无 shader graph、材质域、可扩展参数反射或多模型框架 |
| 阴影 | 主帧外接入 | Directional/Point/Spot、atlas/cascade 路径存在，但绕过主图 |
| Clustered Lighting | 主帧已接入 | 点光/聚光簇，固定容量溢出会丢灯 |
| IBL | 条件主帧，默认启用 | 环境背景、diffuse/specular、预过滤路径存在 |
| SSAO | 条件主帧，默认启用 | 有 history/denoise 资源 |
| SSR | 条件主帧，默认关闭 | trace/resolve/spatial/temporal 链真实存在 |
| Transparent OIT | 主帧已接入 | 独立透明几何路径，支持固定 Standard PBR |
| TAA | 条件主帧，默认启用 | jitter/history 路径存在 |
| NSS | 条件主帧 | 神经超采样实现存在，与 TAA 开关耦合 |
| Motion Blur | 条件主帧，默认关闭 | 内部分辨率缩放时存在坐标空间风险 |
| Bloom / Exposure / Tonemap | 主帧已接入 | Bloom/自动曝光默认启用，最后 Tonemap |
| LPV | 条件主帧 | LPV atlas 更新和间接漫反射消费存在 |
| Brick4 | 部分实现 | 渲染消费者存在，仓库内缺 baker/loader/自动 producer |
| Path Tracer | 手工旁路 | 有真实 compute path tracing，但不属于默认主帧 |
| Scene SDF | 手工旁路 | build/update/load/download 存在，无默认主帧消费 |
| Participating Media | 孤立 producer | CPU/GPU 数据上传存在，没有体积渲染 Pass 消费 |
| GPU 动画/蒙皮 | 部分实现 | GPU 数据库、曲线、骨骼和 skinning 较深；loader 不自动注册播放 |
| Dynamic Resolution Controller | 手工 utility | 算法存在，未自动绑定 Renderer |
| glTF | 部分实现 | JSON/GLB/PBR/skin/animation 可用；压缩、morph、部分扩展缺失 |
| USD | 实验性子集 | USDA 与少量 USDZ；无 USDC、composition、纹理网络和动画系统 |
| Draco / meshopt / KTX2 | 明确缺失 | loader 会将相关扩展报告为不支持 |
| GPU SSE 几何 LOD | 未找到 | 无 LOD group、误差指标和 GPU 选择输出 |
| Compute 小三角形光栅 | 未找到 | 当前 Visibility 是固定功能硬件 raster |
| 几何流送 / 虚拟几何 | 未找到 | 无 page table、请求反馈、IO/上传/回收闭环 |
| 虚拟纹理 / 虚拟材质 | 未找到 | resident atlas 不等于虚拟纹理 |
| 自动化测试 | 基本缺失 | 只有 typecheck/build scripts，无 test/lint/runtime regression |

## 5. 公共 API、初始化与设备模型

### 5.1 WebGPU 初始化

[`Renderer.initialize()`](../reconstructed/src/render/Renderer.ts#L274) 支持两种方式：外部传入 `GPUDevice`，或内部调用 `requestAdapter()` / `requestDevice()`。后者集中在 [`Renderer.ts:298`](../reconstructed/src/render/Renderer.ts#L298) 和 [`Renderer.ts:330`](../reconstructed/src/render/Renderer.ts#L330)。

这层职责划分是合理的：

- `GPUAdapter` 代表浏览器找到的物理/逻辑 GPU 适配器及其能力集合。
- `GPUDevice` 是引擎真正创建 buffer、texture、pipeline 和 command encoder 的逻辑设备。
- 外部注入 device 允许宿主应用与其他 WebGPU 子系统共享设备。

问题在于平台要求偏高。初始化强制请求 `timestamp-query`、`indirect-first-instance`、`float32-blendable`，并要求每 shader stage 至少 10 个 storage buffer（[`Renderer.ts:313-337`](../reconstructed/src/render/Renderer.ts#L313)）。其中 timestamp query 更多是 profiling 能力，将它设为硬要求会排除本可正常渲染的设备。

建议把 feature 分成 correctness 必需、optional fast path、diagnostics 三类。`timestamp-query` 应只影响 profiler。

`device.lost` 当前只被监听并设置 `_deviceLost`（[`Renderer.ts:341`](../reconstructed/src/render/Renderer.ts#L341)），没有资源重建、重新申请 device 或可恢复状态机。

### 5.2 公共 API 边界

优点：包入口集中，内部实现没有大面积泄露；loader、场景、相机、材质和 Renderer 已能组成最小应用；支持外部 device 与自行初始化两种宿主方式。

缺口：

- `OrthographicCamera` 有完整类，但未从 [`index.ts`](../reconstructed/src/index.ts) 导出。
- `SceneBundle` 等 loader 高层结果类型没有形成清晰的公共使用指南。
- GPU 动画播放必须绕到 `renderer.scenes.obtain(scene).animation_manager`，高层 API 不自然。
- PathTracer、SceneSdf、Probe 等旁路能力暴露方式不一致。
- 资源对象没有统一 `dispose()`/`destroy()` 约定和所有权文档。

## 6. Core、Math 与集合

Core 并非空壳。它包含向量、四元数、矩阵、Transform、AABB、颜色、BitSet、HashMap/HashSet、Signal、缓存、表布局、WGSL struct 与 buffer I/O。这些为 GPU 数据库和 shader 接口生成提供了真实基础。

需要注意的缺陷：

- [`HashSet.entries()`](../reconstructed/src/core/HashSet.ts#L72) 直接抛出 `Not implemented`。
- [`WebGPUTypes`](../reconstructed/src/core/WebGPUTypes.ts#L43) 的基类 `declaration_chunk` 抛出 `Not Implemented`；若只允许子类调用，应声明成抽象契约。
- 代码中仍保留大量 deprecated throw、逆向短名和别名，增加误用概率。
- 缺少单元测试来验证矩阵约定、AABB、半精度/打包、WGSL 对齐和 Hash/Equals 一致性。

这里最值得补的不是更多工具类，而是把容器、数学与 WGSL layout 做成有 property test / golden test 的可信底座。

## 7. Scene、Node、Camera 与输入

### 7.1 场景图和注册表是两套结构

`Node3D` 维护 `parent/children` 和 local/global transform；`Scene` 另有 `SceneInstances`、`SceneLights` 和 `SceneVolumetrics`。这种“层级树 + 类型化注册表”设计适合渲染器，但当前没有统一维护二者一致性的机制。

[`Node3D.addChild()`](../reconstructed/src/scene/Node3D.ts#L87) 只更新 parent/children。[`Scene.add()`](../reconstructed/src/scene/Scene.ts#L1321) 只递归登记 Mesh/Light，却没有把传入 root 挂到 `Scene.children`。因此会出现两类失配：

1. `scene.add(root)` 后，root 在实例/灯光注册表中，却不一定在 Scene 的变换递归树中。
2. 已加入 Scene 的 root 后续再 `root.addChild(mesh)`，新 Mesh 不会自动登记到 `SceneInstances`。

Scene 也没有统一的公开 subtree remove/reparent API。动态场景下，Node tree、GPU instance table、灯光表和 TLAS 很容易各自看到不同世界。

### 7.2 普通 CPU Transform → GPU Scene 同步断链（P0）

- [`Node3D.position` setter](../reconstructed/src/scene/Node3D.ts#L41) 只改 local position，不调用 `updateMatrices()`，也没有 dirty signal。
- [`Mesh.updateMatrices()`](../reconstructed/src/scene/Mesh.ts#L72) 虽会更新 bounds 和 `mesh.version`，但 GPU Scene 的 rebuild 条件主要比较 `scene.instances.version`。
- [`GPUSceneContext.update()`](../reconstructed/src/gpu/GPUSceneContext.ts#L305) 只有在 `SceneInstances.version` 变化时重建实例数据库。
- [`SceneInstances.version`](../reconstructed/src/scene/Scene.ts#L977) 只在 add/remove/显式 `needsUpdate` 时增长。
- `GPUSceneContext.build()` 会调用 `scene.updateMatrices()`（[`GPUSceneContext.ts:220`](../reconstructed/src/gpu/GPUSceneContext.ts#L220)），但 root 不在 `Scene.children` 时仍无法覆盖它。

结果是普通非动画 Mesh 移动或父节点变化后，CPU global transform、bounds、GPU node transform、instance table 和 TLAS 可能不一致。

建议建立唯一 dirty 闭环：

```text
Node local changed
  -> subtree world-transform dirty
  -> Mesh world bounds dirty
  -> Scene instance dirty set
  -> GPU Scene partial upload
  -> TLAS refit/reinsert
  -> temporal history / shadow invalidation as needed
```

### 7.3 TLAS 增量更新本身也有 bug（P0）

[`TopLevelAccelerationStructure.instance_update()`](../reconstructed/src/gpu/TopLevelAccelerationStructure.ts#L80) 没有找到调用点；而且它先从 `instanceNodes` 取得 leaf，却没有使用该 leaf，反而把 `instanceIndex` 直接传给 `node_move_aabb()`（[`TopLevelAccelerationStructure.ts:82`](../reconstructed/src/gpu/TopLevelAccelerationStructure.ts#L82)）。这很可能把实例索引错误地当成 BVH 节点索引。

### 7.4 其他 Scene/API 问题

- [`Mesh.updateBoundsTight()`](../reconstructed/src/scene/Mesh.ts#L92) 遇到旋转直接抛 `not implemented`。
- `SceneLights` 只有 collection version。修改灯光颜色、强度、transform、radius、distance、angle 或 penumbra 不会自动标 dirty。
- [`DirectionalLight.type`](../reconstructed/src/light/DirectionalLight.ts#L10) 错误返回 `GpuSceneManager`；[`PointLight.type`](../reconstructed/src/light/PointLight.ts#L13) 错误返回 `AtlasPacker`。

### 7.5 Camera 与输入

Perspective 和 Orthographic 投影实现都存在。`Camera.update()` 会刷新投影、view、view-projection 和 frustum。Camera 基类的 [`update_projection()`](../reconstructed/src/camera/Camera.ts#L96) 是空方法；如果 Camera 允许直接实例化，会静默保留 identity projection，建议改为 abstract 或受保护的明确契约。

`OrbitalCameraController` 的 Pointer/Keyboard 子对象有 `start()`/`stop()`，构造函数会自动注册 DOM/window 事件（[`OrbitalCameraController.ts:647-652`](../reconstructed/src/camera/OrbitalCameraController.ts#L647)），但 Controller 自身没有统一 `dispose()`。用户必须手工停止两个输入对象，否则容易泄漏 listener。

## 8. Geometry、Meshlet 与空间结构

### 8.1 已实现的真实能力

几何子系统包含 Geometry/Attribute、normal/tangent 计算、meshoptimizer Meshlet 构建、自定义打包压缩、Meshlet bounds、CPU/CS BVH，以及 GPU pool/table。

[`buildMeshletBatchFromGeometry()`](../reconstructed/src/geometry/niMeshlets.ts#L1259) 到 GPU table 的链路是真实实现。`MeshletsStub` 这个名字容易误导；它承载的数据并不是整体 Stub。真正的空实现只是 [`MeshletsStub.optimize()`](../reconstructed/src/geometry/BoxGeometry.ts#L85)，而构建、压缩和 bounds 都有代码。

### 8.2 几何基本是“注册后不可变”

`MeshletGeometryBase` 没有正式的 version/dirty API。运行时修改 CPU geometry、meshlet metadata 或 data buffer 没有清晰的重上传入口。

[`MeshletGpuTable.remove()`](../reconstructed/src/gpu/MeshletGpuTable.ts#L155) 只删除 map/record，没有调用 pool allocation 释放。动态卸载几何会导致 GPU pool 内存继续增长。

pool compact 后 address changed callback 目前只打印警告（[`MeshletGpuTable.ts:121`](../reconstructed/src/gpu/MeshletGpuTable.ts#L121)）。地址一致性仍应由测试证明。

### 8.3 没有 GPU SSE LOD

当前 Meshlet 元数据主要包含 bounds、address、primitive/vertex count 和 flags。没有发现 LOD group、parent-child hierarchy、object-space geometric error、projected SSE 计算、GPU LOD 选择、过渡策略或同一对象多级几何的资产管线。

所以“GPU 做 Meshlet 剔除”不等于“GPU 做几何 LOD”。目前每个 geometry 本质上仍是一份全驻留单级 Meshlet 数据。

### 8.4 没有 Compute 小三角形软件光栅

当前 Visibility 路径由 compute 生成 work queue 和 indirect 参数，最终仍进入 WebGPU render pipeline，让固定功能 rasterizer 产生深度/visibility。没有 tile/binning、软件边函数覆盖测试、atomic depth/visibility 写入以及硬件/软件光栅结果合并。

准确名称是 **Compute work generation + hardware visibility rasterization**，不能称为 Compute Rasterizer。

### 8.5 没有虚拟几何和流送

`MeshletGpuPool` 是 GPU 内存池，不是虚拟几何系统。完整虚拟几何还需要 page ID、驻留表、GPU feedback、请求去重、异步 IO/解压/上传、预算、驱逐、fallback page 和跨页依赖。当前没有这套闭环。

## 9. 资产加载全审计

### 9.1 glTF：基础能力较完整，但不是通吃

已实现 JSON/GLB、外部 URI/data URI/bufferView image、interleaved stride、sparse accessor、多 primitive、Standard PBR、punctual lights、skins，以及 STEP/LINEAR/CUBICSPLINE animation。相关证据见 [`gltfGeometry.ts:172`](../reconstructed/src/loaders/gltf/gltfGeometry.ts#L172)、[`gltfGeometry.ts:202`](../reconstructed/src/loaders/gltf/gltfGeometry.ts#L202) 与 [`gltfAnimations.ts:68-72`](../reconstructed/src/loaders/gltf/gltfAnimations.ts#L68)。

明确限制：

- 只支持 triangle primitive；非 `TRIANGLES` 会被拒绝（[`gltfGeometry.ts:446`](../reconstructed/src/loaders/gltf/gltfGeometry.ts#L446)）。
- 没有 morph targets / blend shapes 和 glTF camera 高层导入。
- 没有完整 `KHR_texture_transform`、多 UV set、alphaCutoff 语义。
- occlusion 与 metallicRoughness 使用不同纹理时明确不支持（[`gltfMaterials.ts:173-181`](../reconstructed/src/loaders/gltf/gltfMaterials.ts#L173)）。
- spec-gloss/specular/transmission 只转换部分 factor；扩展纹理和完整光学参数被忽略。

### 9.2 Draco、meshopt 和 KTX2/Basis 明确缺失

loader 的 unsupported extension 诊断明确列出 `KHR_draco_mesh_compression`、`EXT_meshopt_compression` 和 KTX2/Basis（[`GltfLoader.ts:427-438`](../reconstructed/src/loaders/gltf/GltfLoader.ts#L427)）。这不是“可能支持但没找到示例”，而是 loader 自己报告不支持。

### 9.3 glTF 确定性问题

1. **单双面材质可能被错误去重（P0）**：`ShadeMaterial.equals/hash` 遗漏 `draw_side`（[`ShadeMaterial.ts:26-35`](../reconstructed/src/material/ShadeMaterial.ts#L26)）；glTF 会设置 double-sided（[`gltfMaterials.ts:108`](../reconstructed/src/loaders/gltf/gltfMaterials.ts#L108)）并随后按 hash/equals 去重。
2. **缺少 PBR block 时默认 metallic 错误**：`StandardShadeMaterial.metallic_factor` 默认是 0（[`StandardShadeMaterial.ts:28`](../reconstructed/src/material/StandardShadeMaterial.ts#L28)），只有存在 `pbrMetallicRoughness` 时才按 glTF 默认 1 写入（[`gltfMaterials.ts:141-159`](../reconstructed/src/loaders/gltf/gltfMaterials.ts#L141)。
3. selective image loading 可能留下 `undefined` image，后续 texture/material build 仍可能无条件访问。
4. 同一 node 同时含 mesh 和 punctual light 时，构建逻辑可能让一个对象覆盖另一个。
5. 多 scene 文档中，skin/animation 的 node 索引绑定使用共享构建状态，可能只对应最后一次构建的节点集合。

这些 importer 问题应使用 Khronos Sample Models 和小型定制 fixture 自动回归。

### 9.4 USD：实验性 USDA 子集

当前能处理 USDA 文本、USDZ 中未压缩的 USDA root、Mesh/Xform/Scope、face-varying geometry、基础 `UsdPreviewSurface` 常量，以及 up-axis/metersPerUnit。

但它不是通用 USD 实现：

- USDC binary crate 明确未实现（[`load_usd.ts:158-160`](../reconstructed/src/loaders/load_usd.ts#L158)）。现实中大量 USDZ 的 root 是 USDC。
- references/payload composition 只警告并跳过（[`parseUsda.ts:241-249`](../reconstructed/src/loaders/usd/parseUsda.ts#L241)）。
- 缺少纹理网络、复杂 shader graph、骨骼、动画播放、blend shapes、实例化和 variants。
- `unpackUsdz()` 只支持 stored/uncompressed ZIP entry。
- `LoadUsdOptions.extensions` 存在疑似接线 bug：最终 `buildNodes()` 只传 `assetFiles`（[`load_usd.ts:197-198`](../reconstructed/src/loaders/load_usd.ts#L197)），没有传 registry。

### 9.5 自定义 SHADE 与环境加载

Native SHADE 反序列化在 [`deserialize_scene.ts:148`](../reconstructed/src/loaders/deserialize_scene.ts#L148) 只写 `mesh.transform_global`。local transform 仍为 identity，后续 `updateMatrices()` 会由 local 重算并覆盖 global。这是明确的 transform 丢失风险（P0）。

环境 AVIF 的太阳方向估算也有确定性 bug：第一遍寻找最大亮度时循环变量是 `p`，实际索引却使用常量像素总数 `i * channels`（[`load_environment_avif.ts:42-47`](../reconstructed/src/loaders/load_environment_avif.ts#L42)）。这会重复越界读取，阈值计算失真。

## 10. Texture、Sampler 与 GPU 纹理资源

### 10.1 已有能力

`ShadeImage` 可包装 ImageBitmap、Sampler2D 和 raw ArrayBuffer；`ShadeTexture` 描述 flags/filter/wrap/dimensions；GPU upload 支持 external image 和 raw typed data；3-channel raw data会扩为 4-channel；MipmapGenerator、transient texture allocator 和 resident material atlas 都存在。

### 10.2 动态纹理和生命周期不闭环

`ShadeImage` 没有 version/needsUpdate；它的 source、size、color space 都可变。`GPUTextureManager` 按 `ShadeTexture` 对象和 image ID/descriptor 缓存（[`GPUTextureManager.ts:18-30`](../reconstructed/src/gpu/GPUTextureManager.ts#L18)），首次 `obtain()` 时上传（[`GPUTextureManager.ts:46`](../reconstructed/src/gpu/GPUTextureManager.ts#L46)），之后没有重新上传、remove 或 destroy API。

因此修改 CPU image/source、filter/wrap 不会可靠刷新 GPU 纹理与 bind group；manager 的两个 Map 还会长期持有对象。`GraphicsContext.destroy()` 又没有销毁 texture manager/mipmap generator。

`GPUTextureContext` 自身的 allocate/resize/destroy 较清晰，但上层 manager 没有把版本和所有权传递下来。

### 10.3 Resident atlas 不是虚拟纹理

Resident atlas 是“把已知纹理装进一个常驻 atlas”，没有 GPU page table、稀疏 tile、feedback、异步 tile upload、LRU 驱逐与 fallback mip。它能解决统一采样和绑定数量问题，但不能称为 Virtual Texture。

## 11. GPU 基础设施与资源数据库

### 11.1 已实现

`GraphicsContext` 集中了 main/native/staging buffer allocator、transient texture allocator、shader/pipeline/bind group cache、texture/mipmap、geometry table/pool、material registry、sampler cache、collection limits 和 resident material context。GPU database、typed table、indexed record table、scene database 都是真实基础设施。

### 11.2 每帧 collection stats readback

[`GraphicsContext.update()`](../reconstructed/src/gpu/GraphicsContext.ts#L129) 每帧调用 `collectionLimitsValue.update()`（[`GraphicsContext.ts:137`](../reconstructed/src/gpu/GraphicsContext.ts#L137)。后者包含 GPU copy、完成 Promise 和 mapAsync readback。它虽不在当前 JS 帧同步等待，但 GPU 落后时可能积压。建议只在 debug/profiling 开启或降低频率。

### 11.3 GraphicsContext.destroy() 严重不完整

[`GraphicsContext.destroy()`](../reconstructed/src/gpu/GraphicsContext.ts#L152) 只销毁 resident materials、三个 buffer allocator 和 collection limits，遗漏 geometries、materials、textures/mipmap、texture allocator、sampler 以及 cache 所拥有/引用的资源。

这会让热重载、切场景、反复创建 Renderer 和 device-lost 恢复无法建立可验证的资源边界。

## 12. GPU Scene 与 GPU-Driven 主链

### 12.1 主架构

```text
CPU Scene / Mesh / Material / Light / Animation
                    │
                    ▼
       GPUSceneContext + GPU databases
                    │
          instance / node / geometry tables
                    │
                    ▼
  GPU instance cull → Meshlet work generation
                    │
      previous HZB occlusion + frustum cull
                    │
                    ▼
       Indirect hardware Visibility raster
                    │
        current depth → current-frame HZB
                    │
                    ▼
        second-chance occlusion/raster
                    │
                    ▼
 Visibility IDs + depth → Material Expand/GBuffer
                    │
                    ▼
 lighting / indirect / transparent / temporal / post
```

这一链路在 [`Renderer.render()`](../reconstructed/src/render/Renderer.ts#L451)、[`VisibilityPass`](../reconstructed/src/render/passes/VisibilityPass.ts)、[`MeshletDrawList`](../reconstructed/src/gpu/MeshletDrawList.ts) 与 HZB 中有真实接线。

### 12.2 多模型 GPU Scene 的准确评价

它确实支持多个 Mesh、geometry、material、instance 同时存在于 GPU 数据库，不是只能画单模型的示例。但只能判为**主干完成、动态生命周期部分完成**：静态驻留主链存在；普通 transform dirty、动态 geometry/material/texture update、remove/unload allocation 回收和 TLAS 增量更新都不完整。

### 12.3 HZB 与遮挡剔除

这是当前最成熟的 GPU-Driven 能力之一：instance 级 frustum/occlusion、Meshlet 级 work generation/occlusion、上一帧 HZB 提前拒绝、当前 HZB 和 second chance 均已接入。

## 13. 动画与 GPU Skinning

动画系统具有 GPU database、curve/keyframe blocks、track/clip、playback rate/weight/flags、GPU curve evaluate、pose flush、hierarchy update、skin matrix preparation、GPU skinning 和 previous position 支持。

`register_skin()`、`register_clip()`、`start()/stop()` 和 `tick()` 都存在（[`AnimationDatabase.ts:1039-1183`](../reconstructed/src/gpu/AnimationDatabase.ts#L1039)，而 GPU Scene tick 会进入主帧。

主要问题是高层接线：`load_gltf()` 只返回 skins/clips，不会自动注册；用户必须穿过内部场景上下文；仓库没有标准播放示例；unregister 后容量回收不清晰；CPU transform 与 GPU animation transform 是两套路径。

结论：GPU 动画/蒙皮内核较深，但产品级 API 与生命周期尚未完成。

## 14. 材质系统

### 14.1 已实现

Standard 材质支持 base color、normal、emissive、ORM、metallic/roughness/IOR/transmission factor、opaque/alpha-tested/transparent、draw side/mode、GPU uniform/texture bind group/metadata、Material Expand，以及透明和 path tracing 对应读取。

所以准确说法是“有固定 Standard PBR 材质系统”，不是“没有材质系统”。

### 14.2 为什么不是通用材质系统

当前没有 shader graph/node material、surface/decal/volume/post-process material domain、每材质自定义 WGSL/反射布局、可插拔 BSDF、统一 variant 管理和材质实例参数覆盖层。主架构围绕固定 Standard schema，增加新 shading model 要跨 loader、CPU layout、metadata、expand、lighting、transparent、path tracer 多处改动。

### 14.3 动态材质更新断链（P0/P1）

`GPUMaterialContext` 构造时一次性打包 uniform 并取得纹理（[`GPUMaterialContext.ts:79-91`](../reconstructed/src/gpu/GPUMaterialContext.ts#L79)。registry 命中缓存后直接返回；`update()` 只更新 metadata table（[`GPUMaterialContext.ts:344-365`](../reconstructed/src/gpu/GPUMaterialContext.ts#L344)。

材质字段没有统一 version/needsUpdate。因此运行时修改参数、纹理、transparency 或 draw side 后，GPU uniform、metadata、pipeline/bind group 分类都可能继续使用旧值。

## 15. 灯光、Shadow 与 Cluster

Directional、Point、Spot light 都有 CPU/GPU 数据布局。ShadowContext/ShadowRasterPass 包含 shadow atlas、directional cascades、point cube/face、spot shadow、shadow camera、adaptive layout/resolution 和 alpha-tested shadow raster。

阴影在主帧调用链执行，但部分命令发生在主 FrameGraph 外，所以是“主帧外接入”。

动态问题是 `GPULightCollection.update()` 主要比较 `SceneLights.version`，而灯光属性是普通字段。阴影视图可能刷新，但颜色/强度/radius/distance/cone 等数据库仍可能陈旧。

Clustered lighting 每 cluster 固定最多 128 point + 128 spot；溢出没有可靠 CPU 可见诊断或自适应扩容，会丢灯。应增加 overflow counter/debug view 和容量策略。

## 16. FrameGraph 与命令架构

### 16.1 它不是空壳

FrameGraph 已具备 resource import/create/clone/version、pass read/write/create、side effect、ref count、transient 资源获取/释放、JSON/DOT debug export，以及和 `ShadeGPUCommandContext`/资源池的接合。主 Renderer 大量 pass 通过 graph 组织。

### 16.2 它还不是完整 RenderGraph

- [`validate()`](../reconstructed/src/framegraph/FrameGraph.ts#L440) 恒为 true。
- compile 不做拓扑排序，execute 按插入顺序运行（[`FrameGraph.ts:499-505`](../reconstructed/src/framegraph/FrameGraph.ts#L499)。
- Visibility 仍直接携带 raw HZB view 和多个 GPUBuffer，图看不到全部依赖。
- HZB build 没有完整表达内部 HZB texture 写入。
- Shadow、scene tick、LPV update 的部分命令在主 graph 外编码。
- Visibility write 后的新 ResourceId/版本没有在所有调用层完整传播。

因此它是“已在主帧使用、能做基础 transient 生命周期和 pass culling 的 FrameGraph”，但仍有大量隐式依赖和图外工作。

## 17. Renderer 完整主帧

默认配置位于 [`Renderer.ts:178-190`](../reconstructed/src/render/Renderer.ts#L178)：阴影、SSAO、TAA、Bloom、自动曝光、Sharpen 默认开；SSR/Motion Blur 默认关；间接光默认 IBL。

主帧顺序大致为：

1. 更新 GraphicsContext/GPU Scene/动画与相机。
2. 图外准备 shadow、可选 LPV。
3. Visibility 第一阶段：work generation + indirect hardware raster。
4. depth 构建当前 HZB。
5. Second chance 剔除与再次 raster。
6. Material Expand 生成固定 GBuffer。
7. Velocity 与 occlusion confidence。
8. Light Cluster、direct lighting。
9. SSAO、Environment background。
10. IBL，或 LPV/Brick4 条件路径。
11. 可选 SSR trace/resolve/denoise/composite。
12. Transparent OIT。
13. TAA 或 NSS upscale。
14. 可选 Motion Blur、Sharpen。
15. Bloom、Automatic Exposure、Tonemap。

这是一条相当完整的现代实时渲染链。当前风险主要是不同分辨率、history reset、资源所有权和 feature 组合。

### 17.1 动态分辨率与历史资源风险

- 修改 `internal_resolution_scale` 主要 resize render targets（[`Renderer.ts:217-224`](../reconstructed/src/render/Renderer.ts#L217)，没有统一重置 TAA/NSS/SSR/SSAO history、previous depth 与 HZB。
- Motion Blur 在 TAA/NSS 后按 output resolution 执行（[`Renderer.ts:1367-1384`](../reconstructed/src/render/Renderer.ts#L1367)，却直接读取 render-resolution velocity/depth，scale < 1 时存在坐标空间错位。
- `feature_taa_enabled` 同时控制 temporal/upscale 分支；禁用 TAA 时 NSS 也可能无法运行。
- camera cut、FOV/near/far 突变、feature toggle 和 resize 没有统一 history invalidation 状态机。

## 18. GI、PathTracer、SDF 与 Volumetrics

### 18.1 IBL

IBL 是默认间接光模式，环境背景、diffuse/specular pass、environment prefilter 和 split-sum 资源都存在。它属于真实主帧能力。环境 AVIF 太阳估算 bug 会影响辅助方向结果，但不代表 IBL 整体不存在。

### 18.2 LPV

当 `indirect_lighting_mode === LPV` 时，Renderer 调用 `update_lpv()`（[`Renderer.ts:419-423`](../reconstructed/src/render/Renderer.ts#L419)并执行 LPV indirect diffuse pass。它是条件主帧能力。

同时还有手工 probe placement/bake/dering 路径。`GPULightProbeVolumeRenderer` 不是每帧自动 bake，且其 [`destroy()`](../reconstructed/src/gpu/GPULightProbeVolumeRenderer.ts#L314) 为空实现。

### 18.3 Brick4

Brick4 的 diffuse/specular/fused sampling pass 和透明消费路径存在。但 `Brick4LightMap` 基本只是 storage buffer + `upload()`；全仓没有 loader、baker 或自动 producer 调用 `volumetric_light_map.upload()`。

因此 Brick4 shader/pass 消费已接入条件主帧，数据生产与资产管线则缺失。

### 18.4 Path Tracer

PathTracer 有独立 compute tracing、TLAS/BLAS/scene/material 读取和 history accumulation。Renderer 有 lazy getter（[`Renderer.ts:261`](../reconstructed/src/render/Renderer.ts#L261)，但默认 `Renderer.render()` 不调用；它属于真实手工旁路。它持有 history texture，却没有完整 destroy/Renderer 级清理。

### 18.5 Scene SDF

`SceneSdf` 有 build/update/download/load/destroy，Renderer 通过 `obtains_scene_sdf(scene)` 提供缓存（[`Renderer.ts:400`](../reconstructed/src/render/Renderer.ts#L400)。主帧没有自动消费，因此是独立工具能力。

### 18.6 Participating Media / Volumetrics

`SceneVolumetrics` 和 `GPUVolumetrics` 能上传 participating media volume；`GPUSceneContext.update()` 每帧调用 update（[`GPUSceneContext.ts:312`](../reconstructed/src/gpu/GPUSceneContext.ts#L312)。但全仓没有 Renderer pass/shader 有效消费该 table。它属于 producer 存在、消费者缺失的孤立子系统，不能称为体积雾/体积光实现。

生命周期也有两层遗漏：`GPUSceneContext.destroy()` 没调用 `volumetrics.destroy()`；而 [`GPUVolumetrics.destroy()`](../reconstructed/src/gpu/GPUVolumetrics.ts#L134) 又只销毁 gpuTable，遗漏 metadata buffer。

## 19. 虚拟材质、虚拟纹理与几何流送

- **通用材质**：支持多个 shading model、可扩展参数/纹理和 shader variant。
- **虚拟材质**：材质数据按页/按需驻留，或由统一解释/编译系统在大规模材质集合间虚拟化。
- **虚拟纹理**：纹理 tile/page 按需驻留，shader 通过 page table 采样。
- **虚拟几何**：几何 cluster/page 按需驻留，并与 GPU LOD/feedback/streaming 结合。

当前引擎有 material ID、GPU registry、resident texture atlas 和 Meshlet GPU pool。这些是未来做虚拟化的基础，但不等于虚拟化本身。

当前未找到 page table、feedback、IO scheduler、budget/eviction、fallback page、异步解压上传和引用安全闭环，因此虚拟材质、虚拟纹理、虚拟几何和几何流送都应判未实现。

## 20. 生命周期、销毁和所有权

### 20.1 Renderer.destroy() 不完整（P0/P1）

[`Renderer.destroy()`](../reconstructed/src/render/Renderer.ts#L388) 当前只处理 Transparent OIT、MeshletDrawList、NSS、scene manager，并清空 probe map。明确遗漏或没有证明被间接销毁的包括：

- `_graphics`、`_renderTargets`；
- `_views` 和每 View 的 HZB；
- `_cameraStates`、`_taaHistory`；
- SSAO/SSR/Exposure histories/buffers；
- `_sceneSdfs` 内对象；
- `_probeRenderers` 内对象（clear map 不等于 destroy）；
- lazy PathTracer 及 history；
- 大多数 Pass 的自有 buffer/texture。

### 20.2 其他泄漏/所有权缺口

- `GraphicsContext.destroy()` 遗漏 geometry/material/texture/texture allocator 等。
- `GPUSceneContext.destroy()` 遗漏 GPUVolumetrics。
- `GPUVolumetrics.destroy()` 遗漏 metadata buffer。
- `GPULightProbeVolumeRenderer.destroy()` 为空。
- `MeshletGpuTable.remove()` 不释放 pool allocation。
- `GPUTextureManager` 没有 destroy/remove。
- `OrbitalCameraController` 没有顶层 dispose。
- DynamicResolutionScaling、SceneSdf、PathTracer 等旁路对象由谁拥有不统一。

建议建立明确所有权树：

```text
Renderer
  ├─ GraphicsContext
  │   ├─ allocators / caches
  │   ├─ textures / materials / geometries
  │   └─ shared GPU resources
  ├─ GPUSceneManager
  │   └─ GPUSceneContext per Scene
  ├─ ViewManager / CameraState / histories
  ├─ RenderTargets
  ├─ Pass instances
  └─ optional services: PathTracer / SDF / Probe
```

每个 owner 必须 destroy 所有 children；缓存要区分“强拥有资源”和“只保存 descriptor/reference”。

## 21. Shader 迁移与可维护性

主链仍大量依赖逆向/迁移产物：`oracle_visibility_work_generation.ts`、`lighting_ch_oracle.ts`、`material_*_oracle.ts`、`temporal_post_legacy.generated.ts` 和 `probe_legacy.generated.ts`。

与此同时，`mesh_instance_cull.ts`、`meshlet_expand_counts.ts`、`meshlet_expand.ts`、`material_expand.ts`、`material_sr.ts` 这些较可读的重写 shader 当前没有 TS import 入边。

`LightingPass` 还保留 `LIGHTING_MIGRATION_GAP`，说明 fixed P0/P1 command/resource 差异未完全匹配。

风险是 shader layout 与 TS bind group 难核对、typecheck 不验证 WGSL、缺少 golden image 时无法确认迁移等价、双实现并存容易修错文件。

## 22. 测试、构建与工程化

`package.json` 只有：

```json
{
  "build": "tsc --noEmit && vite build && tsc -p tsconfig.build.json",
  "typecheck": "tsc --noEmit"
}
```

没有 test、lint、format、shader validation、headless WebGPU 或 screenshot regression script，也没有测试 runner 配置。

TypeScript typecheck 无法覆盖 WGSL 编译、pipeline/bind group 错误、GPU buffer 越界、importer 规范差异、dirty 生命周期、resize/history、浏览器/adapter 差异、视觉回归和 destroy 后的显存增长。

最低限度应增加：

1. Core/math/layout 单元测试。
2. glTF/USD/SHADE loader fixture tests。
3. GPU database pack/unpack golden tests。
4. WGSL 全模块编译 smoke test。
5. 小型场景 frame capture / screenshot regression。
6. 动态 add/remove/transform/material/light/resize/camera-cut tests。
7. 重复 create-render-destroy 生命周期测试。

## 23. 缺陷清单与优先级

### P0：先修正确性和资源闭环

| 问题 | 影响 | 建议 |
|---|---|---|
| CPU Transform → GPU Scene/TLAS dirty 断链 | 移动物体仍用旧 transform/bounds | 建统一 dirty graph 与增量上传 |
| Scene tree 与 instances/lights registry 失配 | 动态 add/reparent 后对象缺失或矩阵不更新 | Scene 统一管理 attach/detach subtree |
| TLAS `instance_update()` 索引错误且无调用 | 光追/空间结构陈旧或错误 | 使用 leaf id，接入 refit/reinsert |
| 材质修改不重传 | 运行时参数和纹理显示旧值 | Material version + repack + reclassify |
| `draw_side` 未参与 hash/equals | glTF 单双面材质错误合并 | 修 hash/equals 并加 importer test |
| SHADE 只写 global transform | update 后变换被 identity 覆盖 | 写 local 或正确 parent-space transform |
| 环境太阳扫描索引错误 | 太阳方向估算失真 | `base = p * channels`，补数值测试 |
| Renderer/GraphicsContext destroy 不完整 | 热重载/反复创建造成显存和 listener 泄漏 | 按所有权树补齐 destroy |

### P1：通用可用性、动态场景和资产生态

| 问题 | 建议 |
|---|---|
| 灯光属性不自动 dirty | Light setters/version 或 Scene change signal |
| Texture/Geometry 注册后不可变 | 统一 version、partial upload、remove/release |
| glTF Draco/meshopt/KTX2 缺失 | 接成熟 decoder/transcoder |
| glTF morph/camera/扩展语义缺失 | 按实际项目资产优先补齐 |
| USD 只支持很小 USDA 子集 | 标实验性；生产使用考虑可靠 USD 解析层 |
| FrameGraph 隐式依赖与图外 pass | 资源句柄全覆盖、validate、topological schedule |
| 动态分辨率/history invalidation 不统一 | 建 ViewHistoryState 和统一 reset reason |
| Cluster overflow 静默丢灯 | overflow counter/debug/自适应容量 |
| Brick4 无 producer | 补 baker/loader，或移出公共能力表 |
| 动画 loader 不自动注册播放 | 提供 Renderer/Scene 高层 animation service |

### P2：维护性、平台和开发体验

| 问题 | 建议 |
|---|---|
| oracle/generated shader 主导主链 | 分 pass 迁移，配对 golden image 后替换 |
| 孤立清理版 shader | 完成切换或删除，避免双实现 |
| 强制 timestamp-query | 改 optional diagnostics feature |
| device lost 无恢复 | 提供 fatal callback，再设计资源重建 |
| Controller 无 dispose | 增加统一生命周期 API |
| Public API 缺 OrthographicCamera 等 | 建 public API contract tests |
| 每帧 stats readback | debug-only 或降频 |
| 空实现/错误 type 名 | 清理 reconstructed 残留 |

## 24. 路线迁移说明

本节原有建议已迁移并深化到 [ENGINE-DIRECTION-AND-CONSTRAINTS.md](./ENGINE-DIRECTION-AND-CONSTRAINTS.md)。保留本标题是为了避免旧链接失效；新的阶段顺序、进入条件、退出门槛与强制约束只在权威文档维护。

## 25. 对用户关心问题的直接回答

### glTF Draco 解码有没有？

没有。`EXT_meshopt_compression` 和 KTX2/Basis 同样没有。

### GPU Screen-Space Error 几何 LOD 有没有？

没有找到。当前 GPU 会剔除 Meshlet，但没有多级几何和 SSE 选择。

### Compute 软件光栅化小三角形有没有？

没有。当前是 compute 生成工作 + WebGPU render pipeline 硬件光栅。

### 通用多模型 GPU Scene 有没有？

静态主干有，而且是真实主帧能力；动态 transform、add/remove、geometry/material update 和 TLAS 生命周期仍不完整，所以判“部分完成”。

### 通用材质系统有没有？

有固定 Standard PBR 材质系统，没有通用 shader graph/多材质域/可插拔 shading model。

### FrameGraph 有没有？

有，并进入主帧；但资源依赖表达不完整、validate 为空、无拓扑调度、仍有图外工作，所以不是完整 RenderGraph。

### 遮挡剔除和 HZB 有没有？

有，而且是当前最完整的部分之一：实例级、Meshlet 级、上一帧 HZB 和同帧 second chance 均已接入。

### 几何流送与虚拟几何页面有没有？

没有。GPU pool/table 是全驻留内存管理，不是 page streaming。

### 虚拟材质、虚拟纹理有没有？

没有。material registry 和 resident atlas 是基础设施，但没有按页驻留与反馈/驱逐闭环。

## 26. 最终评价

如果只看 GPU-Driven 主路径，这个项目已经明显超过教学 demo：它有真实的多模型 GPU Scene、Meshlet work generation、HZB 两级遮挡、Indirect Visibility、Material Expand 和宽广的实时后处理链。

如果看完整引擎代码，最需要重构的却不是继续叠加高阶图形名词，而是让所有子系统形成可靠闭环：场景变更能传到 GPU，资源能确定释放，loader 的结果符合规范，旁路系统有清晰所有权，FrameGraph 能看到真实依赖，shader 迁移有自动化视觉验证。

建议把下一阶段目标定义为：

> 先把 reconstructed 从“功能丰富的研究渲染器”提升为“状态一致、资源可回收、资产可验证的稳定 GPU-Driven runtime”；之后再依次加入全驻留 GPU LOD、流送/虚拟几何，最后根据性能数据决定 Compute Raster。
