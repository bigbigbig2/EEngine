# three.js：复用什么、不复用什么

> 严格依据：设计 v2 §2.2、§4.4；docs/source/comparison-three-vs-shade.md（内核不是 WebGPURenderer）；Shade v3（可参考 shading model）

## 1. 复用（设计意图）

### 1.1 资产生态（Layer 1）

```txt
GLTFLoader
KTX2Loader / TextureLoader / ImageBitmapLoader
DRACOLoader / MeshoptDecoder
（以及 three 生态中与上述配合的加载习惯）
```

### 1.2 Authoring 与数据含义

```txt
Scene / Object3D / Mesh / InstancedMesh 等作为输入描述
BufferGeometry 属性语义
Material 参数语义（尤其 Standard/Physical 子集方向）
Camera、Light 的用户侧表达
AnimationClip / Skeleton 作为数据源（GPU animation 为路线能力）
```

### 1.3 数学与外观约定

```txt
Math 库（Vector/Matrix/Color/Quaternion…）用于 authoring 与适配
Color management 约定
PBR / glTF 材质参数映射约定
texture transform、tangent/normal 处理参考
tone mapping / IBL / PMREM 等思路参考（设计 v2 §4.4）
```

### 1.4 Shading 语义

Shade 帖态度与设计 v2：可大量 **参考 three 的 shading model 工作**，让「原来的 PBR 想法」可延续，而不是故意另造一套艺术家语言。

## 2. 不复用为渲染内核（硬边界）

```txt
WebGLRenderer
WebGPURenderer backend
RenderLists / 每帧 render item 主路径
WebGLPrograms / 以 three 为中心的 pipeline 管理作为唯一核
完整 NodeMaterial / TSL 作为 GPU-resident 场景主编译器
Object3D 树作为 render core 的场景运行时
```

理由：docs/source/comparison-three-vs-shade.md + 设计 v2 §2.1——这些正是 CPU-driven three 架构本体。

## 3. 许可证意识（设计 v2 §4.4）

```txt
three.js MIT
peer 依赖优先
若复制 substantial 代码：保留版权与许可
大模块倾向「参考语义重新实现」而非整包搬 WebGPURenderer
```

## 4. 与用户期望的关系

```txt
用户期望：尽量继续用 three 的东西搭场景
工程承诺：兼容输入与语义，不兼容 three 渲染内核内部
不承诺：所有 Material/扩展开箱与 WebGPURenderer 行为一致
```
