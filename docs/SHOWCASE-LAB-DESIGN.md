# OEngine Storybook 颗粒化 Example Lab 设计

版本：v0.2（2026-09-05）

## 设计定位

Storybook 左侧 Sidebar 是整个测试库目录。一个 Story 只验证一个明确阶段或一个明确 Feature，并对应一个独立 iframe 和一个独立 Runtime：

```text
Storybook Sidebar
      ↓
一个颗粒化 Story
      ↓
一个独立 iframe
      ↓
一个完全独立 Runtime
      ↓
OEngine
```

测试库同时承担 Learning、Debug 和 Regression 三个职责。

## Runtime 隔离原则

不引入共享 `ExampleHarness`。每个 Runtime 自己拥有：

- `index.html` 和 `main.ts`
- WebGPU Canvas、Renderer、Camera、OrbitControls、DirectionalLight
- Renderer feature 配置、ResizeObserver、RAF loop
- device lost、dispose、资源释放
- 当前案例的说明面板、可视化、截图和 JSON fixture

Runtime 之间不共享 Renderer、GPUDevice、Scene、Camera、Light、History、Profiler 或 Panel 状态。

允许共享的只有 Storybook 外层无 GPU 状态：

- Storybook 配置
- Sidebar 分组
- 纯 iframe 挂载组件
- 可选的 metadata 类型

原则是：

> 统一规范，不统一运行时代码。

## Story 粒度

一个处理阶段就是一个独立 Story。禁止在一个页面内用 Tab、按钮或下拉框切换多个阶段：

```text
01 Geometry
├─ Source Geometry
├─ Vertex Attributes
├─ Meshlet Partition
├─ Meshlet Bounds
├─ Meshlet Cone
├─ Cluster Build
├─ Cluster Hierarchy
├─ SSE / LOD Selection
├─ BVH8
├─ Runtime Asset Package
└─ Package Validation
```

每一个条目都是 Storybook 左侧的独立页面和独立 iframe。

## Storybook 目录规则

Storybook 使用 `title` 的 `/` 建立左侧分类。一个 `.stories.tsx` 文件只能导出一个 Story：

```text
00 Foundations
├─ 01 Pure Geometry
├─ 02 Pure Model Loading
└─ 03 Renderer Baseline

01 Geometry
└─ 90 Legacy Geometry Preprocess

12 Integrated
└─ 01 Rendering Lab
```

现阶段只有已有 Runtime 才能注册到目录；不存在真实 Runtime 的阶段不能先创建空 Story 冒充完成。

## Runtime 基础规范

基础渲染 Story 默认包含：

```text
PerspectiveCamera
OrbitControls
DirectionalLight（castsShadow = false）
```

纯净 baseline：

```text
DPR = 1
internalScale = 1
Shadows = OFF
AO = OFF
SSR = OFF
TAA = OFF
Bloom = OFF
Auto Exposure = OFF
Motion Blur = OFF
Sharpen = OFF
Performance Inspector = OFF
```

只有 Shadow、TAA、IBL 等目标 Story 才显式打开对应 Feature。综合场景放在 `12 Integrated`，不能混入基础 Story。

## Runtime 自己的说明面板

说明面板属于 iframe Runtime，不属于 Storybook Shell。每个页面自行实现当前案例需要的内容：

- Overview：案例名和测试目的
- Pipeline：当前阶段在链路中的位置
- Input：当前阶段真实输入
- Output：当前阶段真实输出
- Visualization：颜色、线框、Bounds、Cone 等编码方式
- Metrics：当前案例有意义的指标
- Baseline：实际 DPR、Feature 和 Renderer 配置

主页面仍由独立 iframe 铺满，Storybook 不创建第二个左侧面板。

## Geometry Pipeline 拆分

```text
SourceGeometry
  → Cook
  → Meshlet Partition
  → Meshlet Bounds
  → Meshlet Cone
  → Cluster Build
  → Cluster Hierarchy
  → SSE / LOD Selection
  → BVH8
  → Runtime Asset Package
  → Package Validation
```

中间结果优先空间可视化：

- Source Geometry：原始三角形、顶点、index、Bounds
- Vertex Attributes：Normal、Tangent、UV、Color
- Meshlet：按 Meshlet ID 着色、选中 outline、vertex/triangle count
- Meshlet Bounds：sphere、AABB、选中 Meshlet
- Meshlet Cone：axis、cutoff、cone-cull 状态
- Cluster：层级颜色、Parent/Child、Bounds
- BVH8：depth、internal/leaf、node Bounds
- Package：section、bytes、hash、validation issue

任何阶段的结论必须来自当前阶段真实 artifact，不能用后续阶段渲染结果代替。

## Debug 链路

不同 Story 可以组成定位链，但不能共享运行时状态：

```text
05 Material / Base Color
        ↓
05 Material / GPU Material Record
        ↓
05 Material / Material Resolve
        ↓
05 Material / Surface Albedo
        ↓
06 Lighting / Direct Lighting
        ↓
10 Post / Linear HDR
        ↓
10 Post / Tonemap
```

如果画面变灰，逐个打开对应 Story 定位颜色开始异常的阶段。

## Fixture 和性能

每个 Runtime 自己暴露 fixture，例如：

```ts
window.__OENGINE_MESHLET_PARTITION_FIXTURE__
window.__OENGINE_CLUSTER_HIERARCHY_FIXTURE__
window.__OENGINE_TAA_FIXTURE__
```

至少提供：

```text
getSnapshot()
captureScreenshot()
downloadJson()
```

性能 Story 一次只改变一个变量。比较必须固定 adapter、浏览器、分辨率、DPR、feature set、workload、camera path、warm-up 和 sample cadence。Inspector 不是性能数据源。

## 第一阶段实施范围

### Phase 1A：Foundations

1. Pure Geometry
2. Pure Model Loading
3. Renderer Baseline
4. Directional Light
5. BaseColor Sanity

### Phase 1A 当前实施状态

| Story | Runtime | 状态 | 说明 |
|---|---|---|---|
| `00 Foundations/01 Pure Geometry` | `runtime/00-foundations/pure-geometry` | 已接入 | Cube + Plane，DPR=1，所有可选效果关闭 |
| `00 Foundations/02 Pure Model Loading` | `model-loading` | 已接入 | Packed glTF 加载、Cook、GPU 驻留，已移除 Inspector/Shadow |
| `00 Foundations/03 Renderer Baseline` | `minimal-scene` | 已接入 | 固定两实例，提供独立 JSON/截图 fixture |
| `00 Foundations/04 Directional Light` | `runtime/00-foundations/directional-light` | 已接入 | 只改变平行光方向/强度，其他效果保持关闭 |
| `00 Foundations/05 BaseColor Sanity` | `runtime/00-foundations/base-color-sanity` | 已接入 | 使用已知蓝/红材质检查 BaseColor 链 |

这五个页面均由独立 iframe Runtime 提供，不共享 Renderer、GPUDevice、Scene 或性能面板。

### Phase 1B 当前实施状态

| Story | Runtime | 状态 | 说明 |
|---|---|---|---|
| `01 Geometry/01 Source Geometry` | `runtime/01-geometry/source-geometry` | 已接入 | 展示 SourceGeometry 的顶点、索引、属性和 Bounds |
| `01 Geometry/02 Vertex Attributes` | `runtime/01-geometry/vertex-attributes` | 已接入 | 单独列出 Position、Normal、UV 等属性流 |
| `01 Geometry/03 Meshlet Partition` | `runtime/01-geometry/meshlet-partition` | 已接入 | 按 Meshlet ID 编码并显示 vertex/triangle 计数 |
| `01 Geometry/04 Meshlet Bounds` | `runtime/01-geometry/meshlet-bounds` | 已接入 | 显示每个 Meshlet 的 AABB、sphere center/radius，并验证 bounds 覆盖 |
| `01 Geometry/05 Meshlet Cone` | `runtime/01-geometry/meshlet-cone` | 已接入 | 显示 cone apex、axis、cutoff，并按当前相机计算 cone-cull 状态 |
| `01 Geometry/06 Cluster Build` | `runtime/01-geometry/cluster-build` | 已接入 | 使用 renderable Cook 生成 Cluster，显示 parent/child、Meshlet range、depth 和 bounds |
| `01 Geometry/07 Cluster Hierarchy` | `runtime/01-geometry/cluster-hierarchy` | 已接入 | 从 clusterChildren 重建树，显示 root、depth levels、parent/child 连线和拓扑验证 |
| `01 Geometry/08 SSE / LOD Selection` | `runtime/01-geometry/sse-lod-selection` | 已接入 | 使用 GeometryHierarchy oracle 计算屏幕空间误差，并显示 threshold 下的 Cluster/Meshlet 选择 |
| `01 Geometry/09 BVH8` | `runtime/01-geometry/bvh8` | 已接入 | 显示 BVH8 节点 depth、valid/leaf mask、child refs 和 child bounds |
| `01 Geometry/10 Runtime Asset Package` | `runtime/01-geometry/runtime-asset-package` | 已接入 | 显示 manifest、section layout、bytes、stride/count、content hash 和 reopen validation |
| `01 Geometry/11 Package Validation` | `runtime/01-geometry/package-validation` | 已接入 | 展示 RuntimeAsset 与 GeometryAsset 的 validation issue、severity、code 和 message |

后续 Geometry 页面继续按一个处理阶段一个 Runtime 的方式增加，不把 Cook、Meshlet、Cluster 等阶段合并回 Source Geometry 页面。

### Phase 1B：Geometry

1. Source Geometry
2. Vertex Attributes
3. Meshlet Partition
4. Meshlet Bounds
5. Meshlet Cone
6. Cluster Build
7. Cluster Hierarchy
8. SSE / LOD Selection
9. BVH8
10. Runtime Asset Package
11. Package Validation

当前已注册可运行的 Foundations、Geometry、Legacy 对照和 Integrated 页面；未完成的 Geometry 阶段仍必须逐个创建独立 Runtime 后再加入 Sidebar。

## 验收标准

1. Storybook Sidebar 是完整技术目录。
2. 一个 Story 只验证一个颗粒目标。
3. 每个 Story 是独立 iframe。
4. 每个 iframe 是独立 Runtime。
5. Runtime 不依赖共享 ExampleHarness。
6. 基础渲染 Story 拥有 Camera、Controls、DirectionalLight。
7. 基础 Story 使用纯净 baseline。
8. 中间结果尽量可视化。
9. 每个 Story 可独立 URL、截图和导出 JSON。
10. 性能 Story 一次只改变一个自变量。
11. 一个 Story 的修改不应改变其他 Story 的运行行为。
