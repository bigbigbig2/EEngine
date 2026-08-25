# 分层模型

> 严格依据：设计 v2 §2.3、§27 最终架构总结  
> 约束：docs/source/webgpu-browser-limits.md（所有层都在浏览器内）

## 1. 三层（母本最终总结，不得改写成别的层数）

```txt
Layer 1: Three-compatible Input
  - three.js Scene / GLTF / Material / Texture / Camera
  - loaders、authoring 习惯、数学与约定参考

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

母本最重要判断：

```txt
不要把 three.js 的 Object3D / WebGPURenderer 当作 renderer 内核。
要把 three.js 当作资产生态和输入格式。
```

## 2. 架构关系图（母本 §2.3）

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
│ Instance / Mesh / Meshlet / Material / ...    │
└───────────────────────┬──────────────────────┘
                        │ frame graph
┌───────────────────────▼──────────────────────┐
│         Shade-like WebGPU Renderer Core       │
│ culling → visibility → material → lighting    │
│ TAA / SSR / GI / shadows / postprocess        │
└──────────────────────────────────────────────┘
```

（GPU Scene 可视为 Layer 2 与 Layer 3 的接合部：表由 runtime 维护，由 renderer 消费。）

## 3. three.js 在各层的角色（母本 §2.2）

### 应该作为

```txt
1. 资产生态：GLTF / KTX2 / DRACO / Meshopt / Texture loader
2. Authoring 数据：Scene、Object3D、Mesh、BufferGeometry、
   Material 参数、Camera、AnimationClip、Skeleton 数据
3. 数学与约定：Color management、PBR 语义、glTF 材质约定、
   texture transform、tangent/normal 处理参考
```

### 不应该作为

```txt
1. 主 renderer
2. render list 构建系统
3. WebGPURenderer backend
4. Scene graph runtime（渲染主路径）
5. Material shader 编译主路径（完整 TSL 体系）
6. 每帧渲染调度核心
```

## 4. 为何不能「只改 WebGPURenderer」（母本 §2.1 + docs/source/comparison-three-vs-shade.md）

WebGPURenderer 必须服务：

```txt
Scene / Object3D / Mesh / Material
existing loaders 与 material 概念
TSL / NodeMaterial
WebGPU backend + WebGL2 fallback
existing three usage model
```

本工程目标需要：

```txt
不再按 Object3D render list 主导 draw
不再按 Mesh/Material 直接 forward 作为唯一模型
不再每帧依赖 JS scene traversal 作为主性能路径
不再让 material shader 对 overdraw 像素无结构地浪费
不再让 CPU 逐对象决定全部渲染任务
```

故：

```txt
WebGPURenderer = three 架构的 WebGPU 化
Three.js Lite  = three 生态输入 + 重新设计的 renderer 核心
```

## 5. 层与浏览器沙盒（docs/source/webgpu-browser-limits.md）

三层全部运行在：

```txt
OS → 浏览器进程 → 标签页 → JS/WASM → WebGPU → canvas
```

因此 Layer 2/3 的设计必须内建：

```txt
可回收内存与 device lost
可见性节流与 temporal history 失效
网络加载与解码路径
主线程与 worker 分工
DPR / 多标签页竞争
用户对网页的轻量预期
```

**层模型解决的是架构；沙盒解决的是上限叙事。** 二者同时成立。

## 6. 技术价值声明（母本 §27，保留）

```txt
1. 继承 three.js 生态入口
2. 使用 Babylon Lite 的轻量 runtime 思路
3. 使用 Shade 的 GPU-resident / visibility-buffer 高性能渲染思路
4. 专注 WebGPU-only，放弃 WebGL fallback
5. 在浏览器限制中做接近现代游戏引擎 renderer 的架构
```
