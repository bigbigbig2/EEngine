
# Three.js Lite / Shade-like WebGPU Renderer 详细设计文档 v2

> 目标：设计一个 **Three.js 生态兼容入口 + Babylon Lite 风格轻量化 runtime + Shade-like 纯 WebGPU 高性能渲染管线**。  
> 本文档不是“改一改 WebGPURenderer”的方案，而是一个新 renderer/runtime 的工程设计：上层兼容 three.js 资产与习惯，底层按 GPU-resident / GPU-driven / visibility-buffer renderer 重新设计。  
> 版本：v2 完整设计稿  
> 日期：2026-06-18

---

## 0. 先把目标说死

你想做的不是三个项目之一：

1. 不是 **three.js fork**：不是把 three.js 主仓库复制一份，然后在 `WebGPURenderer` 上硬改。
2. 不是 **three.js WebGPU 插件**：不是加一个 TAA pass、SSR pass、compute particle 就结束。
3. 不是 **Babylon Lite 的 three.js 复刻版**：Babylon Lite 主要解决包体、启动、CPU frame time 和内存；你还要解决 Shade 那种高性能可见性管线。

你真正想做的是：

```txt
Three.js Lite / ThreeShadeLite
  = three.js 生态输入层
  + Babylon Lite 风格轻量 runtime
  + Shade-like GPU scene / visibility buffer / deferred material resolve
  + 高级效果管线：TAA / SSR / GI / Shadow / Bloom / PostProcess
```

一句话：

> **three.js 负责“用户熟悉的输入与资产生态”；Three.js Lite 负责“真正的 WebGPU 高性能渲染内核”。**

---

## 0.1 文档范围

本文档覆盖：

- 项目定位
- 非目标
- 与 three.js、Babylon Lite、Shade 的关系
- 轻量化 runtime 设计
- three.js 资产兼容层设计
- GPU scene tables 设计
- Meshlet / cluster 几何管线
- GPU culling 与 visible list
- Visibility buffer raster path
- Material resolve / G-buffer / Lighting
- TAA / SSR / GI / Shadow / Postprocess
- WebGPU 资源限制与应对
- 模块目录
- TypeScript API 草案
- WGSL 数据结构与 pass 伪代码
- 分阶段路线图
- 测试与 benchmark 体系
- 许可证与代码复用边界
- 风险清单与裁剪策略

---

## 0.2 参考资料

本文档参考的公开资料包括：

- Babylon Lite welcome / philosophy / architecture docs  
  - `https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/master/docs/lite/00-welcome.md`
  - `https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/master/docs/lite/architecture/07-scene.md`
  - `https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/master/docs/lite/architecture/14-render-pipeline.md`
  - `https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/master/docs/lite/architecture/21-shader-composition.md`
  - `https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/master/philosophy.md`
- three.js docs
  - `https://threejs.org/docs/pages/WebGPURenderer.html`
  - `https://threejs.org/docs/pages/TSL.html`
- three.js license
  - `https://github.com/mrdoob/three.js/blob/dev/LICENSE`
- Shade forum technical breakdown
  - `https://discourse.threejs.org/t/shade-webgpu-graphics/66969/86`
  - `https://discourse.threejs.org/t/shade-webgpu-graphics/66969/92`

---



# 1. 产品定位

## 1.1 项目一句话

**Three.js Lite 是一个 WebGPU-only、data-oriented、three.js-compatible 的高性能实时渲染 runtime。**

它的目标不是替代 three.js，而是提供一个面向高端实时渲染场景的专用 renderer：

```txt
three.js:
  通用、易用、生态大、兼容广

Three.js Lite:
  轻量、WebGPU-only、数据导向、高性能、高级效果

Shade:
  技术参考方向：GPU-resident / visibility-buffer renderer
```

## 1.2 为什么叫 Lite，但目标又很高级？

“Lite” 有两层含义：

第一层，参考 Babylon Lite：

```txt
轻量 runtime：
  - WebGPU-only
  - 去掉 WebGL fallback
  - 去掉历史兼容层
  - 去掉 class-heavy API
  - 用 plain data + functions
  - 强 tree-shaking
  - 按需模块
  - flat scene context
```

第二层，区别于 Babylon Lite：

```txt
高级 renderer：
  - GPU scene tables
  - GPU culling
  - meshlet / cluster
  - visibility buffer
  - material pass only visible pixels
  - TAA / SSR / GI / shadow / postprocess
```

因此它不是“功能少”的 Lite，而是“运行时轻、渲染内核重”的 Lite。

## 1.3 适用场景

适合：

```txt
1. 大规模 Web 3D 场景
2. 建筑可视化 / archviz
3. 城市场景 / 大量实例
4. 大量 static mesh + 不透明 PBR
5. 高级后处理
6. SSR / TAA / GI / contact shadow / soft shadow
7. WebGPU-only 产品
8. 需要 three.js 资产生态，但不满足 three.js renderer 性能上限的项目
```

不适合第一阶段：

```txt
1. 需要 WebGL fallback 的项目
2. 需要完整 three.js ShaderMaterial 兼容的项目
3. 需要复杂透明材质的项目
4. 需要 WebXR 立即完整支持的项目
5. 移动端低端设备优先的项目
6. 需要编辑器任意拖拽动态改材质/拓扑的项目
7. 需要完整 glTF extension 一次性全支持的项目
```

## 1.4 核心设计原则

```txt
P0: WebGPU-only
P1: three.js-compatible input, not three.js-compatible internals
P2: Data-oriented first
P3: GPU-resident when profitable
P4: Visibility first, shading later
P5: No hidden scene graph in render core
P6: Feature modules must be tree-shakable
P7: Static path first, dynamic path second
P8: Opaque PBR first, transparent/custom material later
P9: Performance features must be measurable
P10: Browser constraints are first-class constraints
```



# 2. 不是 fork three.js：总体架构边界

## 2.1 为什么不能直接改 WebGPURenderer

three.js 的 `WebGPURenderer` 仍然是 three.js 体系内的 renderer。它目标是作为 `WebGLRenderer` 的新替代方案，并且可以 target WebGPU / WebGL2 backend。它必须服务：

```txt
- Scene / Object3D / Mesh / Material
- existing loaders
- existing material concepts
- TSL / NodeMaterial
- WebGPU backend
- WebGL2 fallback
- existing three.js usage model
```

这和你的目标冲突。

你的目标需要：

```txt
- 不再按 Object3D render list 主导 draw
- 不再按 Mesh/Material 直接 forward draw
- 不再每帧依赖 JS scene traversal 作为主性能路径
- 不再让 material shader 对 overdraw 像素运行
- 不再让 CPU 逐对象决定渲染任务
```

因此：

```txt
WebGPURenderer:
  three.js 架构的 WebGPU 化

Three.js Lite:
  使用 three.js 生态输入，但重新设计 renderer 核心
```

## 2.2 Three.js 在项目中的角色

three.js 应该作为：

```txt
1. 资产生态层
   - GLTFLoader
   - KTX2Loader
   - TextureLoader
   - ImageBitmapLoader
   - DRACOLoader / MeshoptDecoder

2. Authoring 数据层
   - Scene
   - Object3D
   - Mesh
   - BufferGeometry
   - Material 参数
   - Camera
   - AnimationClip
   - Skeleton 数据

3. 数学与约定参考
   - Color management
   - PBR shading model
   - glTF material conventions
   - texture transform conventions
```

three.js 不应该作为：

```txt
1. 主 renderer
2. render list 构建系统
3. WebGPURenderer backend
4. Scene graph runtime
5. Material shader compiler 主路径
6. 每帧渲染调度核心
```

## 2.3 架构关系图

```txt
┌──────────────────────────────────────────────┐
│                User Application              │
│  three.js-like API / Lite API / editor input  │
└───────────────────────┬──────────────────────┘
                        │
┌───────────────────────▼──────────────────────┐
│          Three Compatibility Layer            │
│  THREE.Scene / GLTF / Texture / Material      │
└───────────────────────┬──────────────────────┘
                        │ flatten / import / sync
┌───────────────────────▼──────────────────────┐
│             Lite Runtime Layer                │
│  Plain data scene / asset registry / modules  │
└───────────────────────┬──────────────────────┘
                        │ build GPU tables
┌───────────────────────▼──────────────────────┐
│              GPU Scene Layer                  │
│ InstanceTable / MeshTable / MeshletTable      │
│ MaterialTable / TextureTable / LightTable     │
└───────────────────────┬──────────────────────┘
                        │ frame graph
┌───────────────────────▼──────────────────────┐
│         Shade-like WebGPU Renderer Core       │
│ culling → visibility → material → lighting    │
│ TAA / SSR / GI / shadows / postprocess        │
└──────────────────────────────────────────────┘
```



# 3. 从 Babylon Lite 借鉴什么

Babylon Lite 的关键不是“WebGPU 更快”，而是：

```txt
- WebGPU-exclusive
- No classes, pure data + functions
- obsessively tree-shakable
- flat SceneContext
- one-way ownership
- material-owned builders
- FrameGraph + RenderTask
- ShaderFragment composition
- bundle/perf/parity CI
```

你的 Three.js Lite 可以直接吸收这些工程原则，但要适配 Shade-like renderer。

## 3.1 WebGPU-only

项目不支持 WebGL fallback。

原因：

```txt
1. Visibility buffer / compute / storage buffer / indirect workflow 依赖 WebGPU。
2. 保留 WebGL fallback 会污染架构。
3. WebGL 路径不能实现完整目标，只会拖慢工程。
4. Lite 的定位是现代 WebGPU runtime，不是 universal renderer。
```

配置：

```ts
export interface EngineOptions {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  powerPreference?: GPUPowerPreference;
  requiredFeatures?: GPUFeatureName[];
  requiredLimits?: Partial<GPUSupportedLimits>;
  debug?: boolean;
  enableTimestamps?: boolean;
}
```

初始化：

```ts
const adapter = await navigator.gpu.requestAdapter({ powerPreference });
const device = await adapter.requestDevice({
  requiredFeatures,
  requiredLimits
});
```

设计要求：

```txt
- 所有模块假设 WebGPU 存在。
- 不写 WebGL compatibility layer。
- 不写 renderer backend abstraction for WebGL。
- 需要 feature fallback，但只在 WebGPU feature 内 fallback。
```

## 3.2 No classes / plain data + functions

参考 Babylon Lite，但要更严格。

不推荐：

```ts
class Mesh {
  geometry: Geometry;
  material: Material;
  add(child) {}
  dispose() {}
}
```

推荐：

```ts
export interface LiteMesh {
  id: MeshId;
  geometry: GeometryId;
  material: MaterialId;
  transform: TransformId;
  bounds: BoundsId;
  flags: MeshFlags;
}

export function addMesh(world: LiteWorld, mesh: LiteMeshDesc): MeshId;
export function removeMesh(world: LiteWorld, id: MeshId): void;
```

原因：

```txt
1. class 实例带方法，不利于 tree-shaking。
2. 复杂原型链增加 bundle 和 runtime 心智成本。
3. 对象反向引用容易产生循环引用和生命周期问题。
4. Plain data 更容易序列化、缓存、diff、上传 GPU。
```

## 3.3 Flat WorldContext

替代 three.js 的 Scene graph runtime。

```ts
export interface WorldContext {
  engine: EngineContext;
  assets: AssetRegistry;
  transforms: TransformStore;
  meshes: MeshStore;
  instances: InstanceStore;
  materials: MaterialStore;
  textures: TextureStore;
  lights: LightStore;
  cameras: CameraStore;

  frameGraph: FrameGraph;

  // GPU-resident layer
  gpuScene: GPUScene | null;

  // staging / dirty flags
  dirty: DirtyTracker;

  // modules
  modules: RuntimeModule[];
}
```

WorldContext 只持有数组/表，不让 child 反向引用 world。

```txt
Engine ← WorldContext → Stores[]
No store item references WorldContext back.
```

## 3.4 强 tree-shaking

模块必须按功能拆分：

```txt
@three-lite/core
@three-lite/three-adapter
@three-lite/gltf
@three-lite/pbr
@three-lite/meshlet
@three-lite/visibility
@three-lite/taa
@three-lite/ssr
@three-lite/gi
@three-lite/shadows
@three-lite/post
@three-lite/debug
```

package 规则：

```json
{
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": "./dist/index.js",
    "./pbr": "./dist/pbr.js",
    "./taa": "./dist/taa.js",
    "./ssr": "./dist/ssr.js"
  }
}
```

禁止：

```txt
- 顶层自动注册所有材质
- 顶层 import 所有 shader
- 顶层创建 device resource
- 顶层 side effects
```

## 3.5 FrameGraph + RenderTask

FrameGraph 不只是后处理 composer，而是 renderer 内核的 pass 调度器。

```ts
export interface FrameGraph {
  tasks: FrameTask[];
  resources: FrameResourceRegistry;
  build(world: WorldContext): void;
  execute(ctx: FrameContext): void;
  dispose(): void;
}
```

Shade-like 默认任务：

```txt
FrameGraph
  01. BeginFrameTask
  02. UploadDirtySceneTask
  03. CullingTask
  04. MeshletExpansionTask
  05. VisibilityRasterTask
  06. DepthPyramidTask
  07. MaybeSetResolveTask
  08. VisibilityRasterMaybeTask
  09. MaterialIdTask
  10. MaterialResolveTask
  11. LightingTask
  12. ShadowTask
  13. SSRTask
  14. GITask
  15. TAATask
  16. BloomTask
  17. TonemapTask
  18. PresentTask
```

和 Babylon Lite 的区别：

```txt
Babylon Lite FrameGraph:
  固定化传统 render pass 调度，减少 CPU overhead。

Three.js Lite FrameGraph:
  固定化 GPU-driven render pipeline，连接 compute / raster / full-screen / temporal passes。
```



# 4. Three.js 轻量化层设计

你说“先对原本 three.js 进行一层优化设计轻量化”。这个部分要非常谨慎：不是 fork three.js 然后删功能，而是做一个 **three-compatible import/runtime layer**。

## 4.1 轻量化对象模型

three.js 的 Object3D 模型：

```txt
Object3D
  children[]
  parent
  matrix
  matrixWorld
  position / rotation / scale
  layers
  visible
  userData
  callbacks
```

Lite runtime 的对象模型：

```ts
export interface TransformData {
  local: Mat4Id;
  world: Mat4Id;
  parent: TransformId | INVALID_ID;
  firstChild: TransformId | INVALID_ID;
  nextSibling: TransformId | INVALID_ID;
  flags: TransformFlags;
}

export interface InstanceData {
  transform: TransformId;
  mesh: MeshId;
  material: MaterialId;
  bounds: BoundsId;
  flags: InstanceFlags;
}
```

注意：

```txt
- Authoring 层可以有树。
- GPU 渲染层必须是 flat arrays。
- 每帧不要遍历 three.js Object3D 作为主路径。
```

## 4.2 ThreeSceneAdapter

负责把 three.js Scene 转成 Lite World。

```ts
export interface ThreeImportOptions {
  staticScene?: boolean;
  bakeTransforms?: boolean;
  bakeMeshlets?: boolean;
  mergeCompatibleGeometries?: boolean;
  materialMode?: "standard-pbr" | "physical-subset" | "unlit";
  texturePolicy?: TexturePolicy;
  animationPolicy?: AnimationPolicy;
}

export async function importThreeScene(
  world: WorldContext,
  scene: THREE.Scene,
  options?: ThreeImportOptions
): Promise<ImportResult>;
```

工作流程：

```txt
1. traverse THREE.Scene once
2. collect visible Mesh / SkinnedMesh / InstancedMesh
3. extract BufferGeometry
4. normalize attributes
5. build bounds
6. extract Material params
7. extract Texture params
8. assign stable IDs
9. build Lite stores
10. upload GPU scene tables
```

## 4.3 ThreeSyncLayer：动态同步，不是每帧重导入

静态场景只 import 一次；动态场景需要同步 dirty changes。

```ts
export interface ThreeSyncLayer {
  track(object: THREE.Object3D): LiteHandle;
  markTransformDirty(object: THREE.Object3D): void;
  markMaterialDirty(material: THREE.Material): void;
  markGeometryDirty(geometry: THREE.BufferGeometry): void;
  sync(world: WorldContext): SyncStats;
}
```

同步原则：

```txt
- transform dirty：只更新 transform table + instance bounds
- material dirty：只更新 material table + bind group/pipeline key
- geometry dirty：重新上传 geometry，必要时重建 meshlets
- texture dirty：重新上传 texture / atlas page
```

禁止：

```txt
- 每帧 full scene traverse
- 每帧重新 flatten 全部对象
- 每帧重建所有 GPU buffers
```

## 4.4 复用 three.js 基础代码的边界

可复制/移植：

```txt
- Math utilities
- Color management logic
- PBR BRDF 公式参考
- tone mapping 公式参考
- PMREM / IBL 思路参考
- glTF material 参数映射
- texture transform 规则
- tangent/normal handling
- KTX2/DRACO/Meshopt loader 入口
```

不建议复制：

```txt
- WebGLRenderer
- WebGPURenderer backend
- RenderLists
- WebGLPrograms / WebGPU pipeline manager
- NodeMaterial/TSL 全体系
- Object3D runtime as render core
```

许可证注意：

```txt
three.js 是 MIT License。
如果复制 substantial portions of code，必须保留版权和许可声明。
建议：
  - 复制少量公式/utility 时在文件头注明来源。
  - 大模块移植时保留 original copyright。
  - 文档中列出 third-party notices。
  - 尽量“参考实现重新写”，而不是大段照搬。
```



# 5. Renderer Core 总览

## 5.1 Frame 级数据流

目标管线：

```txt
CPU / JS side:
  update input
  update camera
  sync dirty transforms/materials/textures
  issue frameGraph.execute()

GPU side:
  UploadDirtyScene
  Culling
  MeshletExpansion
  VisibilityRaster
  DepthPyramid
  MaybeSetResolve
  MaterialResolve
  Lighting
  TAA / SSR / GI
  Present
```

具体：

```txt
WorldContext
  ↓
GPUSceneTables
  ↓
CullingPass
  ↓
VisibleInstanceList
  ↓
MeshletExpansionPass
  ↓
VisibleMeshletList
  ↓
VisibilityRasterPass
  ↓
VisibilityBuffer + Depth
  ↓
DepthPyramidPass
  ↓
MaybeResolvePass
  ↓
VisibilityBuffer finalized
  ↓
MaterialResolvePass
  ↓
GBuffer
  ↓
LightingPass
  ↓
LitColor
  ↓
SSR / GI / TAA / Bloom / Tonemap
  ↓
Swapchain
```

## 5.2 CPU 侧核心对象

```ts
export interface EngineContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  queue: GPUQueue;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  limits: GPUSupportedLimits;
  features: GPUSupportedFeatures;

  pipelineCache: PipelineCache;
  bindGroupCache: BindGroupCache;
  shaderCache: ShaderCache;
  resourcePool: ResourcePool;
}

export interface RendererContext {
  engine: EngineContext;
  world: WorldContext;
  frameGraph: FrameGraph;
  frameIndex: number;
  settings: RendererSettings;
  stats: RendererStats;
}
```

## 5.3 GPU 侧资源

```ts
export interface GPUScene {
  instanceBuffer: GPUBuffer;
  meshBuffer: GPUBuffer;
  meshletBuffer: GPUBuffer;
  materialBuffer: GPUBuffer;
  transformBuffer: GPUBuffer;
  boundsBuffer: GPUBuffer;
  lightBuffer: GPUBuffer;

  visibleInstanceBuffer: GPUBuffer;
  visibleInstanceCounter: GPUBuffer;
  visibleMeshletBuffer: GPUBuffer;
  visibleMeshletCounter: GPUBuffer;
  maybeInstanceBuffer: GPUBuffer;
  maybeMeshletBuffer: GPUBuffer;

  indirectArgsBuffer: GPUBuffer;
  drawStatsBuffer: GPUBuffer;
}
```

## 5.4 Frame resources

```ts
export interface FrameResources {
  visibility: GPUTexture;       // rg32uint or rgba32uint
  depth: GPUTexture;            // depth32float or depth24plus
  depthPyramid: GPUTexture;     // r32float mip chain
  materialIdDepth: GPUTexture;  // depth or r32uint alternative

  gAlbedo: GPUTexture;
  gNormal: GPUTexture;
  gMaterial: GPUTexture;
  gMotion: GPUTexture;
  gEmissive: GPUTexture;

  lighting: GPUTexture;
  historyColor: GPUTexture;
  historyDepth: GPUTexture;
  ssr: GPUTexture;
  gi: GPUTexture;
  bloomChain: GPUTexture[];
}
```



# 6. GPU Scene Tables 详细设计

这是整个项目的地基。

## 6.1 为什么需要 GPU scene tables

three.js 的数据组织是开发者友好的：

```txt
scene.children[0].children[2].material.map
mesh.geometry.attributes.position
mesh.matrixWorld
```

GPU 需要的是连续内存：

```txt
instanceTable[i]
meshTable[meshId]
materialTable[materialId]
meshletTable[meshletOffset + j]
```

GPU scene tables 的目标：

```txt
1. GPU 可以独立读取场景数据。
2. GPU 可以做 culling。
3. GPU 可以生成 visible list。
4. shader 可以通过 ID 回查 material / texture / transform。
5. CPU 不需要每帧遍历所有 Mesh 来决定 draw。
```

## 6.2 ID 系统

使用 typed id，避免混乱。

```ts
export type InstanceId = number & { __brand: "InstanceId" };
export type MeshId = number & { __brand: "MeshId" };
export type MeshletId = number & { __brand: "MeshletId" };
export type MaterialId = number & { __brand: "MaterialId" };
export type TextureId = number & { __brand: "TextureId" };
export type TransformId = number & { __brand: "TransformId" };
export type LightId = number & { __brand: "LightId" };
```

GPU 中全部是 `u32`。

保留 ID：

```txt
0 = invalid / null
1..N = valid
```

这样 shader 可以快速判断 texture 是否存在：

```wgsl
if (material.baseColorTextureId != 0u) {
  // sample texture
}
```

## 6.3 Instance Table

CPU:

```ts
export interface InstanceRecord {
  meshId: MeshId;
  materialId: MaterialId;
  transformId: TransformId;
  boundsId: BoundsId;
  flags: number;
  objectLayerMask: number;
}
```

WGSL:

```wgsl
struct InstanceRecord {
  meshId: u32,
  materialId: u32,
  transformId: u32,
  boundsId: u32,
  flags: u32,
  layerMask: u32,
  _pad0: u32,
  _pad1: u32,
}
```

用途：

```txt
- culling pass 读取 bounds
- visibility pass 通过 instanceId 找 mesh/material/transform
- material pass 通过 instanceId 找 material
- motion vector pass 通过 transformId 找 prev/current matrix
```

## 6.4 Transform Table

```wgsl
struct TransformRecord {
  world0: vec4f,
  world1: vec4f,
  world2: vec4f,
  world3: vec4f,

  prevWorld0: vec4f,
  prevWorld1: vec4f,
  prevWorld2: vec4f,
  prevWorld3: vec4f,

  normal0: vec4f,
  normal1: vec4f,
  normal2: vec4f,
}
```

说明：

```txt
- current world matrix 用于当前帧 position
- previous world matrix 用于 motion vector / TAA
- normal matrix 可预计算，避免 shader 里 inverse transpose
```

更新策略：

```txt
静态对象：
  上传一次

动态对象：
  每帧只上传 dirty transform range

动画对象：
  可先 CPU 更新，后期 GPU animation
```

## 6.5 Mesh Table

```wgsl
struct MeshRecord {
  vertexOffset: u32,
  indexOffset: u32,
  indexCount: u32,
  vertexCount: u32,

  meshletOffset: u32,
  meshletCount: u32,

  attributeMask: u32,
  flags: u32,

  boundsId: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}
```

属性设计：

```txt
vertexBuffer:
  positions packed
  normals packed
  tangents packed
  uvs packed
  colors optional

indexBuffer:
  u32 global index or u16 local meshlet index

meshletBuffer:
  meshlet metadata
```

MVP 阶段可以先使用统一 vertex layout：

```txt
position: float32x3
normal: snorm16x4 or float32x3
tangent: snorm16x4
uv0: float32x2 or unorm16x2
```

后期再做压缩。

## 6.6 Bounds Table

```wgsl
struct BoundsRecord {
  centerRadius: vec4f,  // xyz center, w radius
  aabbMin: vec4f,
  aabbMax: vec4f,
}
```

两种 bounds：

```txt
object-space bounds:
  mesh local bounds

world-space bounds:
  instance bounds, CPU/GPU 更新
```

GPU culling 最好读取 world-space bounds，避免 compute shader 每次变换 8 个 AABB 点。

## 6.7 Material Table

MVP PBR material：

```wgsl
struct MaterialRecord {
  baseColorFactor: vec4f,

  metallic: f32,
  roughness: f32,
  alphaCutoff: f32,
  flags: u32,

  baseColorTextureId: u32,
  normalTextureId: u32,
  ormTextureId: u32,
  emissiveTextureId: u32,

  emissiveFactor: vec4f,

  uvTransform0: vec4f,
  uvTransform1: vec4f,
}
```

flags：

```txt
HAS_BASE_COLOR_TEXTURE
HAS_NORMAL_TEXTURE
HAS_ORM_TEXTURE
HAS_EMISSIVE_TEXTURE
ALPHA_TEST
DOUBLE_SIDED
UNLIT
RECEIVE_SHADOW
CAST_SHADOW
```

注意：第一阶段不做透明 blend。只做：

```txt
opaque
alpha-test / hashed alpha
```

透明要后面单独管线。

## 6.8 Texture Table

WebGPU 没有真正 bindless。Texture table 不能简单写成 shader 里 `textures[id]`，除非使用 texture arrays 或特定绑定策略。

需要抽象：

```ts
export interface TextureRegistry {
  mode: "array" | "atlas" | "virtual" | "bind-group-batches";
  textures: TextureRecord[];
}
```

TextureRecord：

```ts
export interface TextureRecord {
  id: TextureId;
  width: number;
  height: number;
  format: GPUTextureFormat;
  mipCount: number;
  samplerId: SamplerId;
  arrayLayer?: number;
  atlasRect?: [number, number, number, number];
  virtualPageTableId?: number;
}
```

策略：

```txt
MVP:
  texture array / atlas with constraints

Production:
  virtual texture or material batching
```



# 7. GPU Culling 设计

## 7.1 Culling 阶段目标

输入：

```txt
InstanceTable
BoundsTable
CameraUniform
DepthPyramid(previous frame)
```

输出：

```txt
VisibleInstanceList
MaybeInstanceList
Counters
```

概念：

```txt
Visible:
  通过 frustum check，并且 conservative occlusion check 明确可见

Maybe:
  frustum 内，但 occlusion 不确定，需要后续更细粒度或当前帧 depth pyramid 处理

Rejected:
  frustum 外，或被 occlusion 明确遮挡
```

Shade 的思路是把 instance 分 visible/maybe，后续 meshlet 和 triangle 也有 visible/maybe 分组。你可以先简化为：

```txt
Phase 1:
  visible only, no maybe

Phase 2:
  visible + maybe

Phase 3:
  previous-frame HZB + current-frame resolve
```

## 7.2 Frustum Culling

WGSL 伪代码：

```wgsl
@compute @workgroup_size(64)
fn cullInstances(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= scene.instanceCount) { return; }

  let inst = instanceTable[i];
  let bounds = boundsTable[inst.boundsId];

  if (!sphereInFrustum(bounds.centerRadius, camera.frustumPlanes)) {
    return;
  }

  let dst = atomicAdd(&visibleInstanceCounter.count, 1u);
  visibleInstanceList[dst] = i;
}
```

优化：

```txt
- bounding sphere 先判
- AABB 后判
- layer mask / visibility flags 早判
- 使用 workgroup_size 64/128 测试
```

## 7.3 Occlusion Culling

基于 depth pyramid / HZB。

基本逻辑：

```txt
1. 把 bounding box 投影到 screen rect。
2. 根据 rect size 选择 depth pyramid mip。
3. 读取该 mip 的最大/最小深度。
4. 判断 object near depth 是否被已有 depth 遮挡。
```

注意 reversed-Z / depth convention 要统一。

伪代码：

```wgsl
fn occludedByHZB(bounds: BoundsRecord, viewProj: mat4x4f) -> bool {
  let rect = projectBoundsToScreenRect(bounds, viewProj);
  let mip = chooseMip(rect.size);
  let hzbDepth = sampleDepthPyramid(rect.center, mip);
  let objectDepth = rect.nearestDepth;
  return objectDepth > hzbDepth + bias;
}
```

风险：

```txt
- HZB 来自上一帧会有 temporal lag。
- camera 快速移动会误剔除。
- dynamic object 需要 conservative 处理。
- alpha-tested foliage 遮挡不可靠。
```

策略：

```txt
- first frame disable occlusion
- camera cut disable occlusion for N frames
- use maybe set
- inflate bounds
- track disocclusion
```

## 7.4 Visible List Compaction

MVP 用 atomic append：

```wgsl
let dst = atomicAdd(&counter.value, 1u);
visibleList[dst] = instanceId;
```

优点：

```txt
简单
快速实现
```

缺点：

```txt
atomic contention
输出顺序不稳定
material grouping 后面困难
```

后期改 prefix sum：

```txt
1. 每个 instance 写 0/1 visibility mask
2. parallel prefix sum
3. scatter visible IDs
```

收益：

```txt
稳定输出
可排序/分桶
适合后续 indirect args
```

## 7.5 Culling Debug

必须提供 debug layer：

```txt
- 显示 frustum culled count
- 显示 occlusion culled count
- 显示 maybe count
- 显示 HZB mip
- 显示 bounds overlay
- 显示被剔除对象颜色
```

API：

```ts
renderer.debug.showCulling = true;
renderer.debug.showHZB = true;
renderer.debug.freezeCullingCamera = true;
```



# 8. Meshlet / Cluster 管线

## 8.1 为什么要 Meshlet

Instance 粒度太粗：

```txt
一个高模建筑 mesh：
  instance 可见，不代表所有三角形都可见。
```

Meshlet 粒度更细：

```txt
一个 mesh 拆成很多小 cluster：
  每个 cluster 64~128 triangles
  每个 cluster 有 bounds/cone
  GPU 可以更细粒度 cull
```

目标：

```txt
Instance culling
  → Meshlet expansion
  → Meshlet culling
  → Triangle raster / visibility buffer
```

## 8.2 Meshlet Builder

输入：

```txt
THREE.BufferGeometry
```

输出：

```txt
MeshletRecord[]
MeshletIndexBuffer
MeshletVertexRemapBuffer
MeshletBounds[]
```

简单算法：

```txt
1. 遍历 index buffer triangle
2. 累积三角形到 current meshlet
3. 保证 triangleCount <= 128
4. 保证 uniqueVertexCount <= 128
5. 满了就 flush
6. 计算 bounds / cone
```

后续可使用 meshoptimizer 的 meshlet 构建逻辑。

## 8.3 MeshletRecord

```wgsl
struct MeshletRecord {
  meshId: u32,
  firstIndex: u32,
  triangleCount: u32,
  vertexCount: u32,

  vertexRemapOffset: u32,
  indexOffset: u32,

  centerRadius: vec4f,
  coneAxisCutoff: vec4f,
}
```

## 8.4 Meshlet Expansion Pass

输入：

```txt
VisibleInstanceList
MeshTable
```

输出：

```txt
VisibleMeshletList
MaybeMeshletList
```

伪代码：

```wgsl
@compute @workgroup_size(64)
fn expandMeshlets(@builtin(global_invocation_id) gid: vec3u) {
  let visibleIdx = gid.x;
  if (visibleIdx >= visibleInstanceCount) { return; }

  let instanceId = visibleInstanceList[visibleIdx];
  let inst = instanceTable[instanceId];
  let mesh = meshTable[inst.meshId];

  for (var m = 0u; m < mesh.meshletCount; m++) {
    let meshletId = mesh.meshletOffset + m;
    // MVP: append all meshlets
    let dst = atomicAdd(&visibleMeshletCounter.count, 1u);
    visibleMeshletList[dst] = pack(instanceId, meshletId);
  }
}
```

问题：

```txt
一个 mesh 可能有 1 个 meshlet，也可能有几千个 meshlet。
单个 thread 循环大量 meshlet 会造成 workload 不均匀。
```

解决：

```txt
Phase 1:
  simple loop

Phase 2:
  meshlet batch:
    一个 batch = 32/64 meshlets
    expansion 输出 batch，而不是一个 instance thread 展开全部

Phase 3:
  prefix sum 计算 meshlet output ranges
```

## 8.5 Meshlet Culling

测试：

```txt
- frustum
- backface cone
- occlusion HZB
- screen size / LOD
```

伪代码：

```wgsl
fn isMeshletVisible(meshlet, instanceTransform, camera) -> bool {
  let worldBounds = transformBounds(meshlet.centerRadius, instanceTransform);
  if (!sphereInFrustum(worldBounds, camera.frustum)) { return false; }
  if (coneBackfacing(meshlet.cone, camera)) { return false; }
  if (occludedByHZB(worldBounds)) { return false; }
  return true;
}
```



# 9. Visibility Buffer 设计

## 9.1 Visibility Buffer 是什么

传统 forward/deferred：

```txt
geometry pass:
  vertex shader
  fragment shader
  PBR/material shading
  output color or G-buffer
```

Visibility buffer：

```txt
visibility pass:
  vertex shader
  very cheap fragment shader
  output primitive identity

material pass:
  read primitive identity
  reconstruct attributes
  shade only visible pixels
```

优势：

```txt
- 避免 material shader 对 overdraw 像素运行
- 大场景材质/纹理数量扩展更好
- 可见性和 shading 解耦
- 适合 TAA/SSR/GI 后续统一处理
```

代价：

```txt
- 需要额外 visibility buffer
- 需要重建 barycentric / attributes
- bandwidth 高
- 材质系统更复杂
- WebGPU 没 bindless 会卡纹理采样
```

## 9.2 Buffer 格式选择

方案 A：

```txt
rg32uint:
  R = meshId or instanceId
  G = triangleId
```

方案 B：

```txt
rgba32uint:
  R = instanceId
  G = meshletId
  B = triangleLocalId
  A = materialId
```

MVP 建议：

```txt
rgba32uint
```

原因：

```txt
调试简单
不用复杂 pack/unpack
信息冗余但开发快
```

生产优化：

```txt
rg32uint packed
```

pack 示例：

```txt
u32 A:
  20 bits instanceId
  12 bits triangleLocalId

u32 B:
  16 bits meshletId local
  16 bits materialId or flags
```

## 9.3 Raster Path

WebGPU 没 mesh shader，所以要用普通 vertex/fragment pipeline 或 compute rasterizer。

方案 1：普通 raster pipeline

```txt
vertex shader:
  根据 draw/instance/meshlet 读取 triangle vertices
fragment shader:
  output primitive ids
```

优点：

```txt
使用硬件 rasterizer
depth test 免费
MSAA/early depth 更自然
```

缺点：

```txt
draw organization 难
WebGPU multi-draw/indirect 限制
meshlet driven draw 不够自然
```

方案 2：compute software rasterizer

优点：

```txt
完全 GPU-driven
适合 meshlet list
可以自己写 tile/binning
```

缺点：

```txt
工程极难
性能不一定好
要处理 depth/coverage/edge rules
```

建议：

```txt
MVP 用普通 raster pipeline。
后期只对特殊路径研究 compute raster。
```

## 9.4 Visibility Shader 伪代码

Vertex:

```wgsl
struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) instanceId: u32,
  @location(1) triangleId: u32,
  @location(2) materialId: u32,
}

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32,
          @builtin(instance_index) drawIndex: u32) -> VSOut {
  let item = visibleTriangleList[drawIndex];
  let v = fetchTriangleVertex(item, vertexIndex);
  let world = transformTable[item.transformId];
  var out: VSOut;
  out.position = camera.viewProj * world * vec4f(v.position, 1.0);
  out.instanceId = item.instanceId;
  out.triangleId = item.triangleId;
  out.materialId = item.materialId;
  return out;
}
```

Fragment:

```wgsl
@fragment
fn fsMain(in: VSOut) -> @location(0) vec4u {
  return vec4u(in.instanceId, in.triangleId, in.materialId, 0u);
}
```

## 9.5 Triangle List 问题

要 raster triangles，需要 GPU 有一个 triangle draw list。

路径：

```txt
visible meshlets
  -> expand to visible triangles
  -> triangle list
  -> raster
```

但 triangle 数量可能很大。

优化路线：

```txt
MVP:
  Meshlet visible 后直接画 meshlet geometry，不展开 triangle list 到 buffer。

Phase 2:
  Expand visible meshlets to compact triangle list.

Phase 3:
  Batch meshlets into indirect draw groups.

Phase 4:
  Software raster / tile binning experiment.
```

## 9.6 Depth

Visibility pass 同时写 depth。

```txt
depth texture:
  used for HZB
  used for reconstruct position
  used for SSR/TAA/GI
```

使用 reversed-Z：

```txt
优点：
  远处精度更好

代价：
  所有 depth compare / HZB 逻辑要统一
```

建议：

```txt
MVP:
  standard depth

Production:
  reversed depth optional
```



# 10. Material Resolve / G-buffer

## 10.1 Material resolve 的目标

输入：

```txt
VisibilityBuffer
Depth
InstanceTable
MeshTable
Triangle/Vertex buffers
MaterialTable
Texture system
Camera
```

输出：

```txt
G-buffer:
  albedo
  normal
  roughness/metallic/ao
  emissive
  motion
  material flags
```

核心目标：

```txt
只对最终可见像素运行 material shader。
```

## 10.2 两种实现路线

### 路线 A：Full-screen resolve

每个屏幕像素：

```txt
read visibility id
fetch instance
fetch triangle vertices
reconstruct barycentric
interpolate uv/normal/tangent
fetch material
sample textures
write g-buffer
```

优点：

```txt
- pass 少
- 结构清晰
- 适合先实现
```

缺点：

```txt
- 材质分支多
- texture binding 难
- 没 bindless 时很痛
```

### 路线 B：Material-ID depth trick

Shade 参考路线：

```txt
1. 从 visibility buffer 读 mesh/material id
2. 生成 material-id depth
3. 每个 material 一次 draw pass
4. depth test equal
5. material shader 只在属于该 material 的可见像素执行
```

优点：

```txt
- 每个 material shader uniform
- texture switching 低
- shader 分支少
- 可以实现近似 0 overdraw material shading
```

缺点：

```txt
- material 数量多时 pass 多
- depth trick 设计绕
- WebGPU pass overhead 需要控制
```

建议：

```txt
MVP:
  Full-screen resolve

Advanced:
  Material grouped resolve
```

## 10.3 Barycentric 重建

Visibility buffer 只存 triangle ID。Material resolve 要恢复插值属性。

方法：

```txt
1. 根据 triangleId 获取三个 vertex index
2. 读取 clip-space 或 world-space position
3. 根据当前 pixel position + triangle screen position 计算 barycentric
4. perspective-correct interpolate uv/normal/tangent
```

需要的数据：

```txt
- current clip position of vertices
- previous clip position for motion vector
- world position
- normal/tangent
- uv
```

可选优化：

```txt
- visibility pass 输出 barycentric partial? 不推荐，buffer 太大
- material resolve 重新计算 barycentric
- precompute triangle plane data? 可能占内存
```

## 10.4 G-buffer 格式

推荐初始：

```txt
gAlbedo: rgba8unorm or rgba16float
gNormal: rgba16float or rgb10a2
gMaterial: rgba8unorm / rgba16float
gMotion: rg16float
gEmissive: rgba16float
depth: depth32float
```

性能档：

```txt
High:
  albedo rgba16float
  normal rgba16float
  material rgba16float
  motion rg16float

Balanced:
  albedo rgba8unorm
  normal rgb10a2 / rg16 encoded
  material rgba8unorm
  motion rg16float

Low:
  half-res SSR/GI
  packed normal
  no emissive buffer unless needed
```

## 10.5 PBR 子集

第一版只支持：

```txt
MeshStandardMaterial subset:
  baseColor
  metallic
  roughness
  normal map
  ORM map
  emissive
  alpha test
  double sided
```

暂缓：

```txt
MeshPhysicalMaterial:
  clearcoat
  sheen
  transmission
  thickness
  iridescence
  anisotropy
```

原因：

```txt
PBR 子集稳定后，再扩展 physical features。
```

## 10.6 three.js shading model 复用

建议参考 three.js：

```txt
- color space handling
- metal/roughness semantics
- normal map convention
- environment BRDF
- tone mapping
- alpha test behavior
- glTF material mapping
```

但是 shader 组织不要照搬 three.js ShaderChunk。  
应该设计自己的 shader fragment system。



# 11. Lighting Pass

## 11.1 Lighting 基础路径

输入：

```txt
G-buffer
Depth
LightTable
Shadow maps
IBL textures
GI buffer
SSR buffer
```

输出：

```txt
LitColor
```

第一版：

```txt
- Directional light
- Hemispheric ambient
- IBL diffuse/specular
- PBR BRDF
```

第二版：

```txt
- Point lights
- Spot lights
- clustered/tiled lights
- shadowed lights
```

## 11.2 Deferred Lighting

Full-screen pass：

```wgsl
@fragment
fn lightingFS(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = fragCoord.xy / viewportSize;
  let depth = textureLoad(depthTex, pixel, 0);
  let normal = decodeNormal(textureLoad(gNormal, pixel, 0));
  let material = textureLoad(gMaterial, pixel, 0);
  let albedo = textureLoad(gAlbedo, pixel, 0);
  let worldPos = reconstructWorldPos(uv, depth, camera.invViewProj);

  var color = vec3f(0.0);
  color += evaluateIBL(albedo, normal, material);
  color += evaluateDirectionalLights(worldPos, normal, material);
  color += evaluateGI(worldPos, normal, material);
  color += evaluateSSR(worldPos, normal, material);

  return vec4f(color, 1.0);
}
```

## 11.3 Clustered / Tiled Light

大量动态灯光需要 clustered lighting。

Pipeline：

```txt
1. Build depth min/max per tile/cluster
2. Assign lights to clusters
3. Lighting pass reads cluster light list
```

数据：

```wgsl
struct LightRecord {
  kind: u32,
  flags: u32,
  shadowId: u32,
  _pad: u32,
  positionRadius: vec4f,
  directionAngle: vec4f,
  colorIntensity: vec4f,
}
```

MVP 可以先限制光源数量，比如 8/16 个。

## 11.4 IBL

输入：

```txt
irradiance cubemap
prefiltered specular cubemap
BRDF LUT
```

可以参考 three.js/Babylon 的 PMREM/IBL 逻辑，但 runtime 要轻。

方案：

```txt
- 第一版直接使用预处理好的 .hdr/.ktx/.env 资源
- 不在 runtime 做复杂 PMREM
- 后续提供 offline tool
```



# 12. Texture System 设计

## 12.1 核心难点

WebGPU 没有 bindless resources。  
你不能随便在 shader 里写：

```wgsl
let tex = allTextures[material.baseColorTextureId];
```

这会影响：

```txt
- visibility material resolve
- 大量材质
- 大量贴图
- glTF 场景
- SSR/GI/path tracing
```

Shade 作者也提到大型场景几百张 texture 会撞上 texture array layer limit，而理想方案是 bindless 或 virtual textures。

## 12.2 Texture 策略分级

### Strategy 0：单材质/少材质绑定

适合最小 demo：

```txt
每个 material pass 绑定自己的 textures。
```

问题：

```txt
不适合 full-screen resolve 统一处理多材质。
```

### Strategy 1：Texture Array

```txt
baseColorArray
normalArray
ormArray
emissiveArray
```

要求：

```txt
- 同 array 内格式一致
- 尺寸一致或强制 resize
- mip 一致
- layer 数有限
```

优点：

```txt
shader 里可以用 texture2DArray + layer index
```

缺点：

```txt
大场景容易超 layer
resize 会损画质
```

### Strategy 2：Texture Atlas

```txt
把多张 texture packing 到 atlas。
material 存 atlas rect。
```

优点：

```txt
减少 binding 数量
兼容不同数量贴图
```

缺点：

```txt
mip bleeding
padding 复杂
anisotropic filtering 复杂
不同格式要不同 atlas
```

### Strategy 3：Virtual Texture

```txt
logical texture space
page table
physical texture cache
streaming pages
```

优点：

```txt
最适合大场景
显存可控
cache utilization 好
```

缺点：

```txt
工程巨大
需要 page table / feedback / streaming
WebGPU 无 sampler feedback，需要自己做 feedback
```

### Strategy 4：Material Batching

按 texture set / material group 分 pass：

```txt
Group A binds textures 0..15
Group B binds textures 16..31
```

优点：

```txt
兼容 WebGPU limits
材质 shader uniform
```

缺点：

```txt
pass 数增加
调度复杂
```

## 12.3 推荐路线

MVP：

```txt
- texture array for baseColor/normal/ORM
- 限制 texture 尺寸集合，比如 1024/2048
- 超出则 resize 或 fallback to atlas
- 支持 KTX2/Basis
```

中期：

```txt
- atlas for miscellaneous textures
- material batching
```

长期：

```txt
- virtual texture
```

## 12.4 TextureRecord

```wgsl
struct TextureRecord {
  mode: u32,        // array / atlas / virtual
  arrayLayer: u32,
  samplerId: u32,
  flags: u32,

  atlasRect: vec4f, // uv scale/offset
  sizeMip: vec4u,   // width height mipCount format
}
```

## 12.5 Sampler Cache

```ts
export interface SamplerKey {
  minFilter: GPUFilterMode;
  magFilter: GPUFilterMode;
  mipmapFilter: GPUMipmapFilterMode;
  addressModeU: GPUAddressMode;
  addressModeV: GPUAddressMode;
  maxAnisotropy?: number;
}
```

同配置复用一个 sampler。



# 13. TAA 设计

## 13.1 为什么 TAA 是核心

Visibility-buffer renderer 和高级效果天然需要 temporal stability：

```txt
- visibility aliasing
- specular aliasing
- SSR noise
- GI noise
- shadow noise
- alpha test noise
```

TAA 不是后期滤镜，而是整个 renderer 的稳定器。

## 13.2 输入

```txt
current color
history color
current depth
history depth
motion vector
camera jitter
exposure
reactive mask
disocclusion mask
```

## 13.3 Jitter

相机 projection 每帧加入 subpixel jitter：

```ts
const jitter = halton2D(frameIndex);
camera.projectionMatrix = jitterProjection(baseProjection, jitter, viewport);
```

需要：

```txt
- current jitter
- previous jitter
- unjittered projection for some reconstruction
```

## 13.4 Motion Vector

来源：

```txt
current world matrix
previous world matrix
current viewProj
previous viewProj
depth
```

在 material resolve 或单独 motion pass 写：

```txt
gMotion.rg = prevClip.xy/prevClip.w - currClip.xy/currClip.w
```

需要处理：

```txt
- camera motion
- object motion
- skinned/morphed motion
- disocclusion
```

MVP：

```txt
static objects + camera motion
```

## 13.5 Reprojection

```wgsl
let motion = textureLoad(gMotion, pixel, 0).xy;
let historyUv = currentUv + motion;
let historyColor = sample(historyTex, historyUv);
```

## 13.6 Clamp

基本策略：

```txt
- 3x3 current neighborhood min/max clamp
- YCoCg color space clamp
- depth rejection
- normal rejection
- materialId rejection
```

## 13.7 TAA 与材质采样

Shade 作者提到 TAA 会导致纹理糊，需要处理 jitter 对 UV/mip 的影响。你的设计中要把这件事列为一等问题：

```txt
- material sampling 不应该被 screen jitter 破坏
- mip bias 可根据 temporal sample count 调整
- normal/specular aliasing 需要额外 clamp 或 specular AA
```

## 13.8 TAA Debug

```txt
- show motion vector
- show disocclusion mask
- show history weight
- show clamped pixels
- freeze jitter
- disable object motion
```



# 14. SSR 设计

## 14.1 SSR 输入

```txt
depth
normal
roughness
lit color / prelighting color
motion vector
history
```

## 14.2 Ray March

screen-space ray marching：

```txt
1. reconstruct world position
2. compute reflection vector
3. project ray into screen
4. march in depth buffer
5. binary search hit
6. sample color buffer
7. temporal denoise
```

## 14.3 分辨率策略

```txt
High:
  full-res SSR

Balanced:
  half-res SSR + bilateral upsample

Low:
  only roughness < threshold
```

## 14.4 与 TAA 关系

SSR 必须 temporal denoise：

```txt
raw SSR
  -> spatial filter
  -> temporal accumulation
  -> composite
```

否则会闪。

## 14.5 Fallback

```txt
SSR miss:
  use IBL specular
  use GI/specular probe
```



# 15. GI 设计

## 15.1 目标

你的目标说“全量实现 Shade 的特性”，GI 是长期目标，不应该 MVP 就做完整。

分级：

```txt
GI Level 0:
  Ambient / IBL only

GI Level 1:
  Light probes / irradiance volume

GI Level 2:
  DDGI-style probes

GI Level 3:
  SVLM / spatially varying light map style

GI Level 4:
  Hybrid path trace bake + runtime sampling
```

## 15.2 Probe Volume

数据：

```wgsl
struct ProbeRecord {
  positionRadius: vec4f,
  gridInfo: vec4u,
  irradianceOffset: u32,
  visibilityOffset: u32,
  flags: u32,
  _pad: u32,
}
```

采样：

```txt
1. 找到 world position 所在 probe cell
2. trilinear interpolate probes
3. visibility/depth test
4. normal-weighted irradiance
```

## 15.3 Bake / Update

Web 端策略：

```txt
- first version: offline baked probe data
- second version: low-frequency runtime update
- third version: path tracing bake in worker/GPU
```

## 15.4 与 Material / Lighting 关系

GI 不应该直接在 material resolve 做。  
应在 lighting pass 或 GI pass：

```txt
G-buffer
  -> GI sample
  -> Lighting composite
```

## 15.5 GI 风险

```txt
- 显存大
- update 慢
- temporal noise
- browser GPU time budget
- asset streaming
- debug 难
```



# 16. Shadow 设计

## 16.1 阴影目标

支持：

```txt
- directional CSM
- contact shadows
- soft shadow / PCF / PCSS
- shadow denoise
```

## 16.2 Shadow Pass 与 Visibility Buffer

Shadow map 可以走传统 raster：

```txt
shadow caster meshlets
  -> shadow depth
```

未来可以用 GPU culling：

```txt
light frustum culling
  -> shadow visible meshlets
  -> shadow raster
```

## 16.3 CSM

```txt
1. split camera frustum
2. build light matrices
3. cull casters per cascade
4. render depth per cascade
5. lighting pass sample cascade shadow
```

## 16.4 Contact Shadow

screen-space contact shadow：

```txt
depth + normal
  -> ray march toward light in screen space
  -> short-distance occlusion
  -> temporal filter
```

## 16.5 Shadow Cache

静态场景可以缓存 shadow maps：

```txt
- static casters
- static lights
- only update when camera split changes or dynamic caster moves
```



# 17. FrameGraph 详细设计

## 17.1 FrameGraph 类型

```ts
export interface FrameTask {
  name: string;
  type: "compute" | "render" | "fullscreen" | "copy" | "present";
  inputs: ResourceHandle[];
  outputs: ResourceHandle[];
  build(ctx: BuildContext): void;
  execute(ctx: FrameContext): void;
  dispose(): void;
}
```

## 17.2 Resource Registry

```ts
export interface FrameResourceDesc {
  name: string;
  kind: "texture" | "buffer";
  format?: GPUTextureFormat;
  usage: GPUTextureUsageFlags | GPUBufferUsageFlags;
  size: ResourceSizeExpr;
  persistent?: boolean;
  history?: boolean;
}
```

资源类型：

```txt
transient:
  每帧可复用/alias

persistent:
  history buffer / TAA / GI probes

external:
  swapchain / imported texture
```

## 17.3 默认 Shade-like Graph

```txt
BeginFrame
UploadDirtyScene
ResetCounters
CullInstances
ExpandMeshlets
CullMeshlets
RasterVisibility
BuildDepthPyramid
ResolveMaybe
RasterMaybeVisibility
MaterialResolve
DeferredLighting
SSR
GI
TAA
Bloom
Tonemap
Present
```

## 17.4 Pass Fusion

浏览器/WebGPU 中 pass 太碎会有 CPU overhead。  
需要支持 pass fusion：

```txt
- combine small compute passes
- merge postprocess passes if possible
- batch mip generation
- reuse bind groups
```

## 17.5 RenderBundle

对稳定 draw 可用：

```txt
- static shadow caster
- static debug geometry
- fallback forward pass
```

但核心 visibility path 可能更依赖 generated lists。



# 18. Shader System 设计

## 18.1 不使用完整 TSL

TSL 很强，但对这个项目可能太重：

```txt
- 你需要高度控制 WGSL layout
- 需要固定 GPU table ABI
- 需要 pass-specific shader
- 需要 shader fragment tree-shaking
```

建议做轻量 ShaderFragment system。

## 18.2 ShaderFragment

```ts
export interface ShaderFragment {
  id: string;
  wgsl: string;
  bindings?: BindingDecl[];
  structs?: string[];
  functions?: string[];
  varyings?: VaryingDecl[];
  defines?: Record<string, string | number | boolean>;
  dependencies?: ShaderFragment[];
}
```

示例：

```ts
export const NormalMapFragment: ShaderFragment = {
  id: "normal-map",
  wgsl: `
fn applyNormalMap(...) -> vec3f {
  ...
}
`,
  bindings: [
    { group: 2, binding: 4, kind: "texture_2d_array" }
  ]
};
```

## 18.3 Shader Composer

```ts
export function composeShader(desc: ShaderCompositionDesc): ComposedShader {
  // 1. collect fragments
  // 2. topological sort
  // 3. merge bindings
  // 4. assign group/binding
  // 5. generate WGSL
  // 6. compute pipeline key
}
```

## 18.4 ABI 稳定

所有 pass 共享：

```txt
group(0): frame/camera/scene
group(1): GPU scene tables
group(2): material/textures
group(3): pass-specific resources
```

示例：

```wgsl
@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(1) @binding(0) var<storage, read> instances: array<InstanceRecord>;
@group(1) @binding(1) var<storage, read> meshes: array<MeshRecord>;
@group(1) @binding(2) var<storage, read> materials: array<MaterialRecord>;
```

## 18.5 Pipeline Key

```ts
export interface PipelineKey {
  pass: string;
  materialModel: string;
  fragments: string[];
  vertexLayout: string;
  targetFormats: string[];
  depthFormat: string;
  sampleCount: number;
  flags: number;
}
```



# 19. WebGPU Engine Layer

## 19.1 Device 初始化

```ts
export async function createEngine(options: EngineOptions): Promise<EngineContext> {
  if (!navigator.gpu) throw new Error("WebGPU not supported");

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: options.powerPreference ?? "high-performance"
  });
  if (!adapter) throw new Error("No GPU adapter");

  const device = await adapter.requestDevice({
    requiredFeatures: options.requiredFeatures,
    requiredLimits: options.requiredLimits
  });

  const context = options.canvas.getContext("webgpu") as GPUCanvasContext;
  const format = navigator.gpu.getPreferredCanvasFormat();

  context.configure({
    device,
    format,
    alphaMode: "opaque"
  });

  return createEngineContext(adapter, device, context, format);
}
```

## 19.2 Device Lost

必须处理：

```ts
device.lost.then(info => {
  console.warn("GPU device lost", info);
  renderer.recoverDevice();
});
```

恢复策略：

```txt
1. stop frame loop
2. release JS references to old resources
3. request new device
4. recreate engine resources
5. reupload GPU scene tables
6. recreate persistent frame resources
7. clear temporal history
8. resume rendering
```

## 19.3 Resource Pool

```ts
export interface ResourcePool {
  buffers: BufferAllocator;
  textures: TextureAllocator;
  samplers: SamplerCache;
  bindGroups: BindGroupCache;
  pipelines: PipelineCache;
}
```

## 19.4 Buffer Allocator

支持：

```txt
- static vertex/index large buffer
- dynamic uniform ring buffer
- storage buffer with resize
- staging upload buffer
```

策略：

```txt
Large static buffers:
  append-only + compaction later

Dynamic tables:
  capacity doubling
  dirty range upload

Uniforms:
  ring buffer per frame
```

## 19.5 Upload Queue

```ts
export interface UploadCommand {
  target: GPUBuffer | GPUTexture;
  offset: number;
  data: ArrayBufferView | ImageBitmap;
}
```

Batch 上传：

```txt
- 合并 small writeBuffer
- 尽量使用 mapped staging buffer
- texture upload 用 copyExternalImageToTexture / copyBufferToTexture
```



# 20. Runtime API 草案

## 20.1 快速入口：three.js 兼容

```ts
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createThreeLiteRenderer } from "@three-lite/core/three-adapter";

const renderer = await createThreeLiteRenderer({ canvas });

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();

const gltf = await new GLTFLoader().loadAsync("/scene.glb");
scene.add(gltf.scene);

await renderer.importScene(scene, {
  bakeMeshlets: true,
  materialMode: "standard-pbr",
  texturePolicy: "array-or-atlas",
});

renderer.setCamera(camera);

renderer.setAnimationLoop((dt) => {
  renderer.sync(scene);
  renderer.render();
});
```

## 20.2 原生 Lite API

```ts
const engine = await createEngine({ canvas });
const world = createWorld(engine);

const mesh = await loadMesh(world, "/model.glb");
const material = createPbrMaterial(world, {
  baseColor: [1, 1, 1, 1],
  metallic: 0,
  roughness: 0.7,
});

const instance = addInstance(world, {
  mesh,
  material,
  transform: createTransform({ position: [0, 0, 0] }),
});

const renderer = createRenderer(engine, {
  pipeline: "visibility-deferred",
  taa: true,
  ssr: true,
  gi: "probes",
});

await compileWorld(world);
startLoop(() => renderer.render(world));
```

## 20.3 设置项

```ts
export interface RendererSettings {
  pipeline: "forward" | "visibility-deferred";

  resolutionScale: number;
  maxDevicePixelRatio: number;

  culling: {
    frustum: boolean;
    occlusion: boolean;
    hzb: boolean;
    freeze?: boolean;
  };

  meshlets: {
    enabled: boolean;
    maxTriangles: number;
    maxVertices: number;
  };

  visibility: {
    format: "rg32uint" | "rgba32uint";
    clearValue: number;
  };

  taa: {
    enabled: boolean;
    jitter: "halton" | "r2";
    historyWeight: number;
    clamp: "rgb" | "ycocg";
  };

  ssr: {
    enabled: boolean;
    resolutionScale: number;
    maxSteps: number;
  };

  gi: {
    mode: "off" | "ibl" | "probes" | "svlm";
  };
}
```



# 21. 项目目录设计

```txt
packages/
  core/
    src/
      engine/
        createEngine.ts
        deviceLost.ts
        resourcePool.ts
        bufferAllocator.ts
        textureAllocator.ts
      world/
        createWorld.ts
        stores/
          transforms.ts
          meshes.ts
          instances.ts
          materials.ts
          textures.ts
          lights.ts
      framegraph/
        frameGraph.ts
        resourceRegistry.ts
        tasks.ts
      shader/
        shaderFragment.ts
        composeShader.ts
        wgslMinify.ts
      renderer/
        renderer.ts
        frameContext.ts
        settings.ts

  three-adapter/
    src/
      importThreeScene.ts
      syncThreeScene.ts
      materialMap.ts
      geometryMap.ts
      textureMap.ts
      cameraMap.ts

  pbr/
    src/
      pbrMaterial.ts
      pbrFragments.ts
      pbrResolve.wgsl.ts
      brdf.wgsl.ts

  meshlet/
    src/
      buildMeshlets.ts
      meshletTypes.ts
      meshletCulling.wgsl.ts

  visibility/
    src/
      gpuScene.ts
      cullInstances.wgsl.ts
      expandMeshlets.wgsl.ts
      rasterVisibility.wgsl.ts
      materialResolve.wgsl.ts

  taa/
    src/
      taaPass.ts
      taa.wgsl.ts
      jitter.ts

  ssr/
    src/
      ssrPass.ts
      ssr.wgsl.ts

  gi/
    src/
      probeVolume.ts
      svlm.ts
      giPass.wgsl.ts

  shadows/
    src/
      csm.ts
      contactShadow.ts
      shadowPass.wgsl.ts

  post/
    src/
      bloom.ts
      tonemap.ts
      colorGrading.ts

  debug/
    src/
      debugOverlay.ts
      bufferInspect.ts
      passProfiler.ts

examples/
  minimal/
  gltf-viewer/
  sponza/
  bistro/
  many-instances/
  visibility-debug/
  taa-debug/

tests/
  unit/
  gpu/
  visual/
  perf/
```



# 22. Benchmark / 测试体系

## 22.1 为什么测试体系必须早做

这个项目的目标是性能。没有 benchmark，就无法判断：

```txt
- GPU scene table 是否比 three.js render list 快
- visibility buffer 是否值得
- occlusion culling 是否误剔除
- TAA 是否稳定
- SSR/GI 是否过重
- WebGPU pass overhead 是否拖垮收益
```

## 22.2 测试场景

```txt
1. OneCube
2. 1000 Static Meshes
3. 100k Instances
4. Sponza
5. Bistro subset
6. Alpha Test Foliage
7. High Material Count
8. Texture Stress 256/512/1024 textures
9. Dynamic Camera Flythrough
10. Animated Characters
```

## 22.3 指标

CPU：

```txt
- frame CPU time
- sync time
- graph execute command encoding time
- upload time
- JS heap
- GC count
```

GPU：

```txt
- culling pass time
- meshlet pass time
- visibility pass time
- depth pyramid time
- material resolve time
- lighting time
- TAA/SSR/GI time
- total GPU frame time
```

Rendering：

```txt
- visible instance count
- visible meshlet count
- culled count
- triangle rasterized count
- material count
- texture count
- bandwidth estimate
```

## 22.4 Visual Tests

```txt
- screenshot comparison
- depth buffer comparison
- visibility ID debug comparison
- TAA stability video test
- SSR flicker test
```

## 22.5 Regression Gate

CI 中设置：

```txt
- bundle size ceiling
- CPU frame time ceiling
- GPU frame time ceiling on reference machine
- visual diff threshold
- no device lost
```



# 23. 分阶段路线图

## Phase 0：基础工程

目标：

```txt
WebGPU engine 可运行
framegraph 可执行
fullscreen pass 可画
```

交付：

```txt
- createEngine
- createWorld
- createRenderer
- FrameGraph
- ResourcePool
- basic shader compiler
- examples/minimal
```

不做：

```txt
three.js import
PBR
visibility buffer
```

## Phase 1：three.js / glTF 输入

目标：

```txt
能导入 THREE.Scene 静态不透明 mesh。
```

交付：

```txt
- ThreeSceneAdapter
- geometry extraction
- material extraction
- texture upload
- camera mapping
- basic forward PBR
```

性能不要求超过 three.js，只要求数据链路通。

## Phase 2：GPU scene tables

目标：

```txt
渲染完全基于 GPU scene tables。
```

交付：

```txt
- InstanceTable
- MeshTable
- MaterialTable
- TransformTable
- TextureTable
- dirty upload
```

## Phase 3：GPU frustum culling

目标：

```txt
GPU 输出 visible instance list。
```

交付：

```txt
- cullInstances compute
- visible list
- debug culling
- stats
```

## Phase 4：Meshlet

目标：

```txt
geometry 被 meshlet 化，并可在 GPU 上处理 meshlet list。
```

交付：

```txt
- meshlet builder
- meshlet table
- meshlet culling
- meshlet debug
```

## Phase 5：Visibility Buffer MVP

目标：

```txt
可 raster visibility buffer，并显示 primitive ID debug。
```

交付：

```txt
- visibility texture
- depth output
- reconstruct primitive
- debug visualization
```

## Phase 6：Material Resolve + G-buffer

目标：

```txt
只对可见像素输出 G-buffer。
```

交付：

```txt
- barycentric reconstruction
- PBR material resolve
- G-buffer
- lighting pass
```

## Phase 7：Depth Pyramid + Occlusion

目标：

```txt
HZB culling 可用。
```

交付：

```txt
- depth pyramid
- previous-frame occlusion
- maybe set
- false negative mitigation
```

## Phase 8：TAA

目标：

```txt
稳定 temporal pipeline。
```

交付：

```txt
- jitter
- motion vector
- history
- clamp
- debug tools
```

## Phase 9：SSR / Shadows

目标：

```txt
高级效果开始集成。
```

交付：

```txt
- SSR
- CSM
- contact shadow
- temporal denoise
```

## Phase 10：GI

目标：

```txt
Probe / SVLM / bake-based GI。
```

交付：

```txt
- probe volume
- GI sampling
- optional bake path
```

## Phase 11：动态对象 / animation / skinning

目标：

```txt
支持动态角色与 GPU animation 方向。
```

交付：

```txt
- CPU animation sync
- GPU skinning
- motion vector for skinned mesh
- dynamic bounds
```



# 24. 风险清单

## 24.1 纹理系统风险最高

问题：

```txt
WebGPU 没 bindless。
大量材质/纹理场景很难通用。
```

应对：

```txt
- MVP 限制材质
- texture array + atlas
- material batching
- 长期 virtual texture
```

## 24.2 Visibility Buffer 工程复杂

问题：

```txt
attribute reconstruction
barycentric
normal/tangent
motion vector
skinning
alpha test
```

应对：

```txt
先静态不透明
再 alpha test
最后 skinning/transparent
```

## 24.3 WebGPU pass overhead

问题：

```txt
pass 太碎，浏览器 command encoding 成本高。
```

应对：

```txt
- pass fusion
- pipeline/bindgroup cache
- render bundle
- 避免 tiny compute dispatch
```

## 24.4 GPU bandwidth

Visibility buffer + G-buffer + history buffers 很吃 bandwidth。

应对：

```txt
- format packing
- half-res SSR/GI
- dynamic resolution
- max DPR
- packed normal/material
```

## 24.5 TAA 会拖慢开发

TAA 需要全管线稳定。

应对：

```txt
TAA 放到 G-buffer/lighting 稳定后。
```

## 24.6 与 three.js 兼容期望

用户可能希望所有 three.js material 都能跑。

应对：

```txt
明确只支持 subset。
unsupported material fallback 或报错。
```



# 25. 第一版功能裁剪

## 25.1 必须支持

```txt
- WebGPU engine
- static glTF import
- BufferGeometry position/normal/tangent/uv
- MeshStandardMaterial subset
- baseColor/normal/ORM/emissive texture
- opaque
- alpha test
- directional light
- IBL
- GPU scene tables
- GPU frustum culling
- meshlet builder
- visibility buffer
- material resolve
- deferred lighting
- basic TAA
```

## 25.2 暂不支持

```txt
- WebGL fallback
- ShaderMaterial
- NodeMaterial/TSL compatibility
- complex transparency
- transmission
- clearcoat
- sheen
- morph target
- skeletal animation
- WebXR
- editor live editing
- full GI
```

## 25.3 Fallback 策略

Unsupported material：

```txt
- try convert to PBR subset
- else unlit fallback
- else unsupported placeholder material
```

Unsupported geometry：

```txt
- missing tangent：generate or fallback normal mapping off
- missing normal：generate
- unsupported attribute：ignore
```



# 26. MVP 技术实现 Checklist

## 26.1 Week 1-2：Engine

```txt
[ ] createEngine
[ ] canvas configure
[ ] frame loop
[ ] shader module cache
[ ] pipeline cache
[ ] bind group cache
[ ] resource pool
[ ] fullscreen triangle
```

## 26.2 Week 3-4：World / Adapter

```txt
[ ] createWorld
[ ] flat stores
[ ] import THREE.Scene
[ ] extract geometries
[ ] extract materials
[ ] extract textures
[ ] upload buffers
```

## 26.3 Week 5-6：Forward PBR Baseline

```txt
[ ] basic PBR WGSL
[ ] IBL placeholder
[ ] texture sampling
[ ] camera uniform
[ ] transform uniform/storage
[ ] draw imported mesh
```

## 26.4 Week 7-9：GPU Tables + Culling

```txt
[ ] InstanceTable
[ ] MeshTable
[ ] MaterialTable
[ ] TransformTable
[ ] BoundsTable
[ ] culling compute
[ ] visible list debug
```

## 26.5 Week 10-12：Meshlet

```txt
[ ] meshlet builder
[ ] meshlet bounds
[ ] meshlet table
[ ] meshlet debug view
[ ] meshlet culling
```

## 26.6 Week 13-16：Visibility Buffer

```txt
[ ] visibility raster
[ ] ID texture
[ ] depth texture
[ ] debug view
[ ] primitive reconstruction
```

## 26.7 Week 17-20：Material Resolve

```txt
[ ] barycentric reconstruction
[ ] material table fetch
[ ] texture fetch policy
[ ] G-buffer output
[ ] lighting pass
```

## 26.8 Week 21-24：Advanced

```txt
[ ] depth pyramid
[ ] occlusion culling
[ ] TAA
[ ] SSR prototype
[ ] benchmark suite
```



# 27. 最终架构总结

这个项目应该被设计成三层：

```txt
Layer 1: Three-compatible Input
  - three.js Scene / GLTF / Material / Texture / Camera

Layer 2: Lite Runtime
  - WebGPU-only
  - plain data
  - flat world
  - tree-shakable modules
  - frame graph
  - shader fragments

Layer 3: Shade-like Renderer
  - GPU scene tables
  - GPU culling
  - meshlets
  - visibility buffer
  - material resolve
  - deferred lighting
  - TAA / SSR / GI / shadows
```

最重要的判断：

```txt
不要把 three.js 的 Object3D / WebGPURenderer 当作 renderer 内核。
要把 three.js 当作资产生态和输入格式。
```

项目的技术价值在于：

```txt
1. 继承 three.js 生态入口。
2. 使用 Babylon Lite 的轻量 runtime 思路。
3. 使用 Shade 的 GPU-resident / visibility-buffer 高性能渲染思路。
4. 专注 WebGPU-only，放弃 WebGL fallback。
5. 在浏览器限制中做接近现代游戏引擎 renderer 的架构。
```



# 附录 A：核心数据结构汇总

## A.1 CPU Store Layout

```ts
export interface Store<T> {
  dense: T[];
  freeList: number[];
  version: Uint32Array;
  dirtyRanges: DirtyRange[];
}
```

## A.2 Dirty Range

```ts
export interface DirtyRange {
  start: number;
  count: number;
}
```

合并规则：

```txt
- 连续 range 合并
- range 太多时 full upload
- 每帧 upload budget 限制
```

## A.3 GPU Buffer Usage

| Buffer | Usage | Update Frequency |
|---|---|---|
| VertexBuffer | STORAGE / VERTEX / COPY_DST | static |
| IndexBuffer | STORAGE / INDEX / COPY_DST | static |
| InstanceTable | STORAGE / COPY_DST | dynamic |
| TransformTable | STORAGE / COPY_DST | dynamic |
| MaterialTable | STORAGE / COPY_DST | medium |
| MeshTable | STORAGE / COPY_DST | static |
| MeshletTable | STORAGE / COPY_DST | static |
| VisibleList | STORAGE / COPY_SRC | per frame |
| Counters | STORAGE / COPY_DST | per frame |
| IndirectArgs | INDIRECT / STORAGE | per frame |

## A.4 Frame Texture Usage

| Texture | Format | Usage |
|---|---|---|
| Visibility | rgba32uint | RENDER_ATTACHMENT / TEXTURE_BINDING |
| Depth | depth32float | RENDER_ATTACHMENT / TEXTURE_BINDING |
| DepthPyramid | r32float | STORAGE_BINDING / TEXTURE_BINDING |
| GAlbedo | rgba8unorm / rgba16float | RENDER_ATTACHMENT / TEXTURE_BINDING |
| GNormal | rgba16float | RENDER_ATTACHMENT / TEXTURE_BINDING |
| GMaterial | rgba8unorm | RENDER_ATTACHMENT / TEXTURE_BINDING |
| GMotion | rg16float | RENDER_ATTACHMENT / TEXTURE_BINDING |
| Lighting | rgba16float | STORAGE_BINDING / RENDER_ATTACHMENT / TEXTURE_BINDING |
| History | rgba16float | TEXTURE_BINDING / COPY_DST / RENDER_ATTACHMENT |



# 附录 B：Debug / Tooling 设计

## B.1 Debug Views

```txt
- Visibility ID
- Material ID
- Instance ID
- Meshlet ID
- Depth
- Depth pyramid mip
- Normal
- Roughness
- Metallic
- Motion vector
- TAA history weight
- SSR hit/miss
- GI contribution
- Culling rejected objects
```

## B.2 Runtime Inspector

```ts
renderer.debug.openInspector();
```

面板：

```txt
Frame
  CPU frame
  GPU frame
  pass timings

Scene
  instances
  meshes
  meshlets
  materials
  textures

Culling
  total
  frustum culled
  occlusion culled
  visible
  maybe

Memory
  buffers
  textures
  render targets
  history buffers

Passes
  enable/disable
  resolution scale
  format
```

## B.3 GPU Profiling

使用 timestamp query，如果 feature 可用：

```txt
- timestamp begin/end per pass
- rolling average
- min/max
- export JSON
```

如果不可用：

```txt
- CPU command encoding timings
- frame fence approximation
```



# 附录 C：和 three.js / Babylon Lite / Shade 的对比

| 维度 | three.js | Babylon Lite | Shade | Three.js Lite 目标 |
|---|---|---|---|---|
| WebGPU-only | 否 | 是 | 是 | 是 |
| WebGL fallback | 是/可有 | 否 | 否 | 否 |
| classless | 否 | 是 | 大体是 | 是 |
| three.js 生态 | 原生 | 否 | 部分熟悉 | 输入兼容 |
| GPU scene tables | 否 | 不是主目标 | 是 | 是 |
| GPU culling | 否/局部 | 不是主目标 | 是 | 是 |
| meshlet | 否 | 否 | 是 | 是 |
| visibility buffer | 否 | 否 | 是 | 是 |
| material only visible pixels | 否 | 否 | 是 | 是 |
| TAA/SSR/GI 深度集成 | 部分 | 部分 | 是 | 是 |
| 主要优化 | 易用/生态 | 包体/CPU/内存 | 大场景 renderer | 生态输入 + 高性能 renderer |



# 附录 D：命名建议

不建议叫：

```txt
three.js lite
```

原因：

```txt
容易被理解为 three.js 官方轻量版或 fork。
```

建议：

```txt
ThreeGPU Lite
Three Shade Runtime
ThreeGPU Renderer
LiteShade
WebGPU Scene Renderer
Three Scene GPU Runtime
```

如果内部代号可以叫：

```txt
three-lite
```

公开项目名建议避免直接暗示官方 three.js 关联。



# 附录 E：术语表

## GPU-resident scene

渲染所需的主要场景数据长期驻留 GPU buffer/texture 中，GPU 可以直接读取 instance、mesh、material、texture、light 等数据。

## GPU-driven rendering

GPU 不只是执行 draw，还参与决定“画什么”。典型包括 GPU culling、visible list、indirect draw args。

## Visibility buffer

一种先写 primitive identity，再延迟材质 shading 的渲染方式。它存的是“像素看到了哪个三角形/实例/材质”，而不是直接存颜色。

## Meshlet

小型 triangle cluster。通常包含几十到一百多个三角形，用于更细粒度 culling 和 GPU 处理。

## HZB / Depth Pyramid

深度金字塔。把 depth buffer 多级降采样，用于快速 occlusion culling、SSR、屏幕空间效果。

## Material Resolve

从 visibility buffer 中读取 primitive ID，重建材质属性并输出 G-buffer 的过程。

## G-buffer

Deferred rendering 中保存几何/材质中间信息的 render targets，例如 albedo、normal、roughness、metallic、motion vector。

## TAA

Temporal Anti-Aliasing。通过多帧 jitter + history accumulation 抗锯齿，但需要 motion vector、history clamp、disocclusion 处理。

## SSR

Screen Space Reflection。基于当前帧 depth/color 在屏幕空间追踪反射。

## GI

Global Illumination。间接光照。WebGPU 中可用 probes、lightmaps、SVLM、低频 path trace bake 等方式实现。



# 附录 F：FrameGraph Task 伪代码

```ts
export class CullInstancesTask implements FrameTask {
  name = "CullInstances";
  type = "compute" as const;

  build(ctx: BuildContext) {
    this.pipeline = ctx.pipelineCache.compute("cullInstances", cullInstancesWGSL);
    this.bindGroup = ctx.bindGroups.create([
      ctx.frame.cameraBuffer,
      ctx.world.gpuScene.instanceBuffer,
      ctx.world.gpuScene.boundsBuffer,
      ctx.world.gpuScene.visibleInstanceBuffer,
      ctx.world.gpuScene.counterBuffer,
    ]);
  }

  execute(ctx: FrameContext) {
    const pass = ctx.encoder.beginComputePass({ label: this.name });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(ctx.world.instanceCount / 64));
    pass.end();
  }

  dispose() {}
}
```

```ts
export class VisibilityRasterTask implements FrameTask {
  name = "VisibilityRaster";
  type = "render" as const;

  build(ctx: BuildContext) {
    this.pipeline = ctx.pipelineCache.render("visibility", {
      vertex: visibilityVS,
      fragment: visibilityFS,
      colorFormats: ["rgba32uint"],
      depthFormat: "depth32float",
    });
  }

  execute(ctx: FrameContext) {
    const pass = ctx.encoder.beginRenderPass({
      colorAttachments: [ctx.resources.visibility.clear()],
      depthStencilAttachment: ctx.resources.depth.clear(),
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, ctx.frame.cameraBG);
    pass.setBindGroup(1, ctx.world.sceneTablesBG);

    // MVP 可以用固定 draw 或 per-meshlet batches
    pass.drawIndexedIndirect(ctx.world.gpuScene.indirectArgsBuffer, 0);

    pass.end();
  }
}
```



# 附录 G：WebGPU Bind Group Layout 设计

## G.1 Group 0：Frame / Camera

```wgsl
@group(0) @binding(0) var<uniform> frame: FrameUniform;
@group(0) @binding(1) var<uniform> camera: CameraUniform;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var nearestSampler: sampler;
```

## G.2 Group 1：GPU Scene

```wgsl
@group(1) @binding(0) var<storage, read> instances: array<InstanceRecord>;
@group(1) @binding(1) var<storage, read> meshes: array<MeshRecord>;
@group(1) @binding(2) var<storage, read> meshlets: array<MeshletRecord>;
@group(1) @binding(3) var<storage, read> materials: array<MaterialRecord>;
@group(1) @binding(4) var<storage, read> transforms: array<TransformRecord>;
@group(1) @binding(5) var<storage, read> bounds: array<BoundsRecord>;
```

## G.3 Group 2：Geometry Buffers

```wgsl
@group(2) @binding(0) var<storage, read> positions: array<vec4f>;
@group(2) @binding(1) var<storage, read> normals: array<u32>;
@group(2) @binding(2) var<storage, read> tangents: array<u32>;
@group(2) @binding(3) var<storage, read> uvs: array<vec2f>;
@group(2) @binding(4) var<storage, read> indices: array<u32>;
```

## G.4 Group 3：Textures / Pass Resources

MVP texture array：

```wgsl
@group(3) @binding(0) var baseColorTex: texture_2d_array<f32>;
@group(3) @binding(1) var normalTex: texture_2d_array<f32>;
@group(3) @binding(2) var ormTex: texture_2d_array<f32>;
@group(3) @binding(3) var emissiveTex: texture_2d_array<f32>;
@group(3) @binding(4) var materialSampler: sampler;
```

Material resolve pass：

```wgsl
@group(3) @binding(5) var visibilityTex: texture_2d<u32>;
@group(3) @binding(6) var depthTex: texture_depth_2d;
```



# 附录 H：未来高级路线

## H.1 GPU Animation

目标：

```txt
animation curves
  -> GPU evaluate local transforms
  -> GPU hierarchy resolve
  -> GPU bounds update
  -> GPU skinning
  -> culling consumes updated bounds
```

分阶段：

```txt
1. CPU AnimationMixer sync to transform table
2. GPU skinning into skinned vertex buffer
3. GPU animation curve evaluation
4. GPU hierarchy
5. GPU dynamic bounds
```

## H.2 Streaming

大场景需要 streaming：

```txt
- meshlet pages
- texture pages
- material pages
- BVH/HZB metadata
- probe pages
```

## H.3 Virtual Texture

长期必做：

```txt
- page table texture
- physical texture cache
- feedback pass
- worker streaming
- GPU/CPU residency manager
```

## H.4 Ray / Path Trace Bake

用于 GI bake：

```txt
- software BVH in storage buffers
- low-res material texture path
- probe update
- SVLM bake
```

## H.5 WebXR

后期支持：

```txt
- multiview if supported
- per-eye visibility
- shared culling?
- TAA changes
- foveated rendering if available
```




# 附录 I：详细模块职责说明

## I.1 `@three-lite/core`

职责：

```txt
- WebGPU device/context 初始化
- frame loop
- resource pool
- FrameGraph
- WorldContext
- typed stores
- renderer settings
- debug hooks
```

不负责：

```txt
- three.js import
- glTF loader
- PBR 具体 shader
- TAA/SSR/GI 具体算法
```

核心 API：

```ts
export async function createEngine(options: EngineOptions): Promise<EngineContext>;
export function createWorld(engine: EngineContext, options?: WorldOptions): WorldContext;
export function createRenderer(engine: EngineContext, options?: RendererOptions): Renderer;
export function startLoop(callback: FrameCallback): LoopHandle;
```

## I.2 `@three-lite/three-adapter`

职责：

```txt
- 把 THREE.Scene 转成 WorldContext
- 把 THREE.Camera 转成 LiteCamera
- 把 THREE.BufferGeometry 转成 LiteGeometry
- 把 THREE.Material 转成 LiteMaterialDesc
- 把 THREE.Texture 转成 TextureDesc
- 同步 dirty transform/material/geometry
```

必须保持可选依赖：

```txt
core 不 import three。
只有 three-adapter import three 类型。
```

原因：

```txt
这样不使用 three 兼容层的用户，不会把 three.js 打进 bundle。
```

## I.3 `@three-lite/visibility`

职责：

```txt
- GPU scene table layout
- culling pass
- meshlet expansion pass
- visibility raster pass
- material id pass
- depth pyramid pass
```

不负责：

```txt
- PBR 公式
- TAA
- SSR
- GI
```

## I.4 `@three-lite/pbr`

职责：

```txt
- PBR material desc
- PBR material table encode
- material resolve shader fragment
- BRDF utility
- IBL sampling
- G-buffer layout
```

## I.5 `@three-lite/taa`

职责：

```txt
- jitter sequence
- history resource management
- motion vector validation
- temporal resolve shader
- TAA debug view
```

## I.6 `@three-lite/debug`

职责：

```txt
- live stats overlay
- GPU timestamps
- debug render targets
- culling visualization
- pass toggle UI
```

调试层必须可 tree-shake：

```txt
import "@three-lite/debug"
```

不 import debug 时不能进入生产 bundle。




# 附录 J：错误处理与降级策略

## J.1 WebGPU 不支持

```ts
if (!navigator.gpu) {
  return {
    supported: false,
    reason: "WebGPU is not available",
    recommendation: "Use regular three.js WebGLRenderer fallback in app layer"
  };
}
```

注意：Three.js Lite 本身不提供 WebGL fallback，但应用层可以选择：

```txt
if WebGPU available:
  use Three.js Lite
else:
  use regular three.js WebGLRenderer
```

这比 runtime 内部维护 WebGL fallback 更干净。

## J.2 Feature 不支持

Feature detection：

```ts
const features = adapter.features;
const hasTimestamp = features.has("timestamp-query");
```

策略：

```txt
timestamp-query 不支持：
  关闭 GPU profiler，但 renderer 可运行

texture-compression-bc 不支持：
  使用 rgba8 fallback 或 basis transcoding fallback

float32-filterable 不支持：
  改用 half/nearest 或 prefiltered resources

subgroups 不支持：
  使用普通 compute path
```

## J.3 Limits 不足

关键 limits：

```txt
maxStorageBuffersPerShaderStage
maxSampledTexturesPerShaderStage
maxTextureArrayLayers
maxBufferSize
maxStorageBufferBindingSize
maxBindGroups
```

启动时生成 capability profile：

```ts
export interface CapabilityProfile {
  tier: "low" | "medium" | "high" | "ultra";
  maxTextureArrayLayers: number;
  maxMaterialsPerBatch: number;
  maxInstances: number;
  maxMeshlets: number;
  recommendedVisibilityFormat: GPUTextureFormat;
  recommendedGBufferMode: "compact" | "balanced" | "high";
}
```

## J.4 Device lost

用户可监听：

```ts
renderer.on("device-lost", (info) => {});
renderer.on("device-restored", () => {});
```

内部恢复：

```txt
- 清空 pipeline cache
- 重建 bind group layout
- 重建 sampler cache
- 重新上传 GPU scene
- 清空 TAA/SSR/GI history
- 恢复 framegraph resources
```

## J.5 Out of memory

检测：

```txt
- createTexture/createBuffer 抛错
- device lost reason
- upload fail
```

降级策略：

```txt
1. 降低 internal resolutionScale
2. 降低 history buffer format
3. SSR/GI half-res
4. 禁用 bloom high mip
5. 压缩 G-buffer
6. 降低 texture budget
7. 禁用 GI
8. fallback forward-lite
```




# 附录 K：资源预算系统

## K.1 为什么需要预算

浏览器标签页不是原生游戏进程。  
大场景 renderer 必须自己做预算，否则容易：

```txt
- GPU memory pressure
- device lost
- tab memory saver
- stutter
- upload spike
```

## K.2 BudgetConfig

```ts
export interface BudgetConfig {
  gpuMemorySoftMB: number;
  gpuMemoryHardMB: number;

  textureBudgetMB: number;
  geometryBudgetMB: number;
  renderTargetBudgetMB: number;
  historyBudgetMB: number;

  uploadBudgetMBPerFrame: number;
  maxPipelineCompilesPerFrame: number;
  maxTextureUploadsPerFrame: number;
}
```

## K.3 Render Target Memory Estimate

```ts
function estimateTextureBytes(width, height, format, mipCount = 1): number {
  const bpp = bytesPerPixel(format);
  let total = 0;
  for (let i = 0; i < mipCount; i++) {
    total += Math.max(1, width >> i) * Math.max(1, height >> i) * bpp;
  }
  return total;
}
```

示例：

```txt
1920x1080 rgba16float:
  1920 * 1080 * 8 ≈ 15.8 MB

4 个 rgba16float G-buffer:
  ≈ 63 MB

TAA history rgba16float:
  ≈ 15.8 MB

depth32:
  ≈ 8.3 MB
```

DPR=2 时像素数 4 倍，所以必须控制 max DPR。

## K.4 Resolution Policy

```ts
export interface ResolutionPolicy {
  maxDpr: number;
  internalScale: number;
  dynamicResolution: boolean;
  targetFrameMs: number;
  minScale: number;
  maxScale: number;
}
```

动态调节：

```txt
if GPU frame > target for 20 frames:
  scale *= 0.9

if GPU frame < target * 0.75 for 120 frames:
  scale *= 1.05
```




# 附录 L：数据更新策略

## L.1 Static Scene

静态场景：

```txt
- import once
- build meshlets once
- upload GPU scene once
- no per-frame scene sync
```

性能最佳。

## L.2 Dynamic Transform

动态 transform：

```txt
- CPU 更新 transform store
- mark dirty range
- upload transform buffer range
- update world bounds
```

如果对象很多，bounds 更新可转 GPU。

## L.3 Dynamic Material

材质参数变动：

```txt
- update MaterialTable row
- if texture set unchanged: no pipeline rebuild
- if feature flags changed: material pipeline key dirty
```

## L.4 Dynamic Geometry

几何变动最贵：

```txt
- reupload vertex/index range
- rebuild meshlet
- update mesh table
- update bounds
```

建议：

```txt
动态几何单独走 dynamic mesh pool。
不要频繁改 static geometry pool。
```

## L.5 Add / Remove Instance

添加：

```txt
- allocate instance id
- write instance table row
- write bounds
- mark instance buffer dirty
```

删除：

```txt
- mark dead flag
- add id to free list
- optional compaction later
```

渲染时 culling pass 忽略 dead flag。




# 附录 M：场景格式设计

长期需要一个自己的 scene cache 格式，避免每次从 glTF/three 重新转换。

## M.1 `.tlscene` 目标

```txt
- 已经 meshlet 化
- 已经生成 bounds
- 已经压缩 vertex/index
- 已经整理 material table
- 已经打包 texture atlas/array metadata
- 可直接 streaming 到 GPU
```

## M.2 文件结构

```txt
header
chunks:
  transforms
  instances
  meshes
  meshlets
  vertices
  indices
  materials
  textures metadata
  lights
  animations
  probes
```

## M.3 Chunk Header

```ts
interface ChunkHeader {
  type: number;
  offset: bigint;
  byteLength: bigint;
  compression: number;
  version: number;
}
```

## M.4 为什么需要自己的格式

glTF 是交换格式，不是高性能 runtime 格式。

glTF 优点：

```txt
生态强
工具多
标准化
```

glTF 不适合作为最终 GPU scene format：

```txt
- 需要解析 JSON
- 需要处理 extension
- meshlet 不标准
- texture packing 不一定符合 runtime
- material feature 太灵活
```

因此：

```txt
Authoring:
  glTF / three.js scene

Runtime:
  .tlscene
```




# 附录 N：Forward Fallback Path

虽然核心目标是 visibility-deferred，但需要一个 forward-lite path 用于：

```txt
- debug
- unsupported material
- transparent object
- very small scenes
- fallback on low tier devices
```

## N.1 Forward-lite

```txt
GPU scene tables
  -> frustum culling
  -> direct draw visible meshes
  -> PBR forward shader
```

依然不走 three.js render list。

## N.2 Transparent Path

透明物体第一版可走 forward：

```txt
1. opaque visibility/deferred path
2. transparent forward pass
3. sorted by CPU or GPU approximated depth
```

透明材质不进入 visibility material resolve。

## N.3 Alpha Test

alpha test 可以进入 visibility path，但要在 visibility pass 判断 alpha：

```txt
visibility fragment:
  sample alpha texture
  if alpha < cutoff discard
  write id
```

问题：

```txt
需要在 visibility pass 采样 baseColor alpha。
这又触发 texture binding 问题。
```

简化：

```txt
MVP:
  alpha test forward path

Phase 2:
  alpha test visibility path with limited texture arrays

Phase 3:
  hashed alpha + TAA
```




# 附录 O：编码规范

## O.1 TypeScript

```txt
- strict: true
- no implicit any
- no classes unless justified
- prefer functions + plain objects
- no global singleton registry
- no top-level side effects
```

## O.2 WGSL

```txt
- 每个 pass 单独文件
- 公共 ABI 单独 include/string module
- 明确 group/binding
- 禁止 magic binding number 散落
- shader key 可追踪
```

## O.3 Performance Rules

```txt
- 每帧不得分配大量 JS object
- 每帧不得 full scene traverse
- 每帧不得重建 pipeline
- 每帧不得重建 bind group，除非资源真的变
- 小 buffer update 合并
- debug code 必须可裁剪
```

## O.4 API Rules

```txt
- 兼容层 API 可以像 three.js
- 原生 API 必须 data-oriented
- unsupported feature 明确报错或 fallback
- 不做“看似支持但画错”的隐式降级
```




# 附录 P：关键决策记录 ADR

## ADR-001：WebGPU-only

决策：

```txt
项目不实现 WebGL backend。
```

原因：

```txt
核心管线依赖 compute/storage/visibility。
WebGL fallback 会污染架构。
```

后果：

```txt
应用层自行选择 fallback 到 three.js WebGLRenderer。
```

## ADR-002：不 fork three.js

决策：

```txt
不以 fork three.js 为主线。
```

原因：

```txt
维护成本高，和 upstream 冲突，难以大改 renderer 内核。
```

替代：

```txt
three-adapter 读取 three.js 数据。
```

## ADR-003：Visibility-deferred 是主路径

决策：

```txt
核心高性能路径采用 visibility buffer + material resolve。
```

原因：

```txt
减少 overdraw material shading，适合大场景和高级效果。
```

代价：

```txt
bandwidth 高，材质系统复杂。
```

## ADR-004：MVP 不做透明

决策：

```txt
MVP 只做 opaque + limited alpha test。
```

原因：

```txt
透明排序与 visibility buffer 冲突，工程复杂。
```

## ADR-005：MVP texture array / atlas，不做 virtual texture

决策：

```txt
第一版不做 virtual texture。
```

原因：

```txt
工程量过大。
```

长期：

```txt
virtual texture 是大场景正式路线。
```




# 附录 Q：性能目标

## Q.1 CPU 目标

在 100k static instances 场景中：

```txt
CPU scene sync:
  < 1 ms when no dirty changes

CPU command encoding:
  < 2 ms balanced mode

JS heap allocation:
  near-zero per frame in stable scene
```

## Q.2 GPU 目标

1080p balanced mode：

```txt
Culling:
  < 0.5 ms for 100k instances

Visibility:
  scene dependent, target < 2 ms for medium scene

Material resolve:
  < 2 ms

Lighting:
  < 1.5 ms basic lights + IBL

TAA:
  < 1 ms

Total:
  60 fps target on mid/high desktop GPU
```

这些是目标，不是保证。

## Q.3 Bundle 目标

按模块：

```txt
core minimal:
  < 50 KB gzip

core + three-adapter + basic PBR:
  < 150 KB gzip excluding three.js

full renderer without GI:
  < 300 KB gzip excluding three.js

debug tools:
  separate chunk
```

注意：

```txt
如果用户 import three.js / GLTFLoader，本身包体另算。
```




# 附录 R：开发优先级最终建议

如果你一个人或小团队做，最实际路线是：

```txt
1. 不要先写完整设计中的所有模块。
2. 先做一个能导入 glTF 并显示的 WebGPU renderer。
3. 再做 GPU scene tables。
4. 再做 culling。
5. 再做 visibility buffer。
6. 最后再做 TAA/SSR/GI。
```

真正的第一里程碑应该是：

```txt
Milestone 1:
  同一个 Sponza 场景，
  three.js WebGPURenderer 和 Three.js Lite forward path 视觉接近。

Milestone 2:
  GPU culling 后 visible count 正确。

Milestone 3:
  visibility buffer debug view 正确。

Milestone 4:
  material resolve 画面正确。

Milestone 5:
  大量 instances 下 CPU frame time 明显优于 three.js。
```

不要用“功能全”作为早期目标。  
要用“管线正确 + 性能数据成立”作为早期目标。

