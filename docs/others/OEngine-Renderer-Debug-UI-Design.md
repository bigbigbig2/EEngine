# OEngine Renderer Debug UI 设计文档

> Status: Design Approved  
> Target: Development-only Renderer Debug Console  
> Baseline Repository: `bigbigbig2/EEngine`  
> Baseline Commit: `c06859cd2e9d8f4581398e4cb836e226b07ce664`  
> Related Design: `OEngine Example Library V2`  
> Related ADR: `docs/adr/0012-example-library-reset.md`

---

# 1. 背景

OEngine 当前已经具备比较完整的 GPU-driven Renderer 架构，包括：

- Runtime Asset / Residency
- GpuScene / GpuRenderWorld
- GPU Hierarchy / Meshlet Work
- Visibility Buffer
- Compute Material / SurfaceLite
- Clustered Lighting
- Shadow
- Long-range GI
- GTAO / SSGI
- SSR
- Transparency
- TAA / TAAU / NSS / DRS
- HDR / Bloom / Exposure / Final Output
- FrameGraph
- Temporal History
- FrameProfiler / GPU Counters / Runtime Metrics

当前项目也已经存在一套 `Performance Inspector`。

但是，现有 Performance Inspector 的定位更偏：

- 实时 Profiler
- Timeline
- Record
- High Detail
- Work / Graph / Memory / Diagnostics 分析
- 有界历史
- 选帧
- Benchmark / Evidence 辅助

对于日常 Renderer 开发、Feature 调参、Example 调试而言，这套 UI 太重。

新的需求是建立一个：

> **轻量、常驻、面向 Renderer 开发的 Debug UI。**

它既可以修改完整 Renderer 参数，也可以展示当前 Renderer 的核心状态、管线、GPU、资源和性能摘要。

---

# 2. 核心目标

新的 Renderer Debug UI 应满足：

1. 初始化 Renderer 时可选开启。
2. 使用 Tweakpane 作为 UI 基础。
3. 完整暴露 Renderer 的主要可调参数。
4. 参数按目录组织，默认折叠。
5. GTAO / SSGI / SSR / Shadow / GI / TAA / Bloom 等都包含完整可调参数。
6. Example 可以自动展开当前 Feature 对应目录。
7. Example 仍可附加自己的 Scene / Camera / Test 参数。
8. 内置独立的 `Renderer Info` 页面。
9. `Renderer Info` 展示渲染状态、性能摘要、渲染管线、资源、GPU 和 Diagnostics。
10. 不再使用现有 Performance Inspector 作为日常调试 UI。
11. 保留底层 FrameProfiler / GPU Counter / Runtime Metric 等数据采集能力。
12. Debug UI 不成为 Renderer 状态 owner。
13. `RenderSettings` 仍然是唯一运行时配置事实。
14. Debug 功能关闭时不创建 UI，也不应引入明显额外运行时开销。

---

# 3. 非目标

第一阶段明确不做：

- Threepipe 完整 Editor
- Scene Hierarchy Editor
- Material Editor
- Undo / Redo
- 自动 Serialization
- Preset 系统
- UI Decorator
- 自动反射生成所有控件
- 插件市场
- Dock Layout
- Timeline Viewer
- Frame Capture Viewer
- Benchmark Dashboard
- 复杂图表系统
- 完整 Performance Inspector 替代实现

本设计只实现：

> **Renderer Controls + Renderer Info**

---

# 4. 总体架构

推荐结构：

```text
Renderer
│
├─ MainRenderPipeline
│
├─ RenderSettings
│
├─ FrameProfiler / Evidence
│
└─ optional DebugController
      │
      └─ TweakpaneDebugUI
            │
            ├─ Controls
            │
            └─ Renderer Info
```

其中：

```text
RenderSettings
```

仍然是 Renderer 配置的唯一事实来源。

Debug UI 只是：

```text
View + Controller
```

而不是：

```text
State Owner
```

---

# 5. Renderer 初始化 API

推荐允许：

```ts
const renderer = new Renderer({
  debug: true
});
```

等价于：

```ts
const renderer = new Renderer({
  debug: {
    enabled: true,
    controls: true,
    info: true
  }
});
```

推荐 Debug 配置：

```ts
interface RendererDebugConfig {
  enabled?: boolean;

  controls?: boolean;
  info?: boolean;

  expanded?: boolean;

  infoRefreshRate?: number;
}
```

例如：

```ts
new Renderer({
  debug: {
    enabled: true,
    controls: true,
    info: true,
    infoRefreshRate: 4
  }
});
```

---

# 6. 默认行为

生产默认：

```text
debug = false
```

因此默认情况下：

```text
0 Debug DOM
0 Tweakpane UI
0 Debug UI Timer
0 Debug UI Refresh
```

如果底层 profiler 本身未启用，则也不应该因为 Debug UI 未开启而额外启用高成本采样。

---

# 7. Lazy Load

Tweakpane 不应该成为 Renderer 主路径的硬依赖。

禁止：

```ts
import { Pane } from "tweakpane";
```

直接长期存在于 Renderer 主入口。

推荐：

```text
RendererConfig.debug
      ↓
enabled?
      ↓
lazy import
      ↓
RendererDebugController
      ↓
TweakpaneDebugUI
```

概念：

```ts
if (debugEnabled) {
  const module = await import("../addons/debug/RendererDebugController.js");
  this.debug = await module.createRendererDebugController(this);
}
```

目标：

> Debug 关闭时，Renderer 主运行路径不依赖 UI Runtime。

---

# 8. 推荐目录结构

```text
OEngine/src/
│
├─ render/
│  ├─ Renderer.ts
│  ├─ RendererConfig.ts
│  └─ ...
│
├─ debug/
│  ├─ FrameProfiler.ts
│  ├─ GpuFrameCounters.ts
│  └─ ...
│
└─ addons/
   │
   ├─ inspector/
   │
   └─ debug/
      ├─ RendererDebugConfig.ts
      ├─ RendererDebugController.ts
      ├─ RendererDebugUI.ts
      ├─ RendererInfoModel.ts
      │
      ├─ controls/
      │  ├─ RendererControls.ts
      │  ├─ ResolutionControls.ts
      │  ├─ MaterialControls.ts
      │  ├─ LightingControls.ts
      │  ├─ ShadowControls.ts
      │  ├─ GiControls.ts
      │  ├─ GtaoControls.ts
      │  ├─ SsgiControls.ts
      │  ├─ SsrControls.ts
      │  ├─ TransparencyControls.ts
      │  ├─ TemporalControls.ts
      │  ├─ PostControls.ts
      │  └─ DebugViewControls.ts
      │
      └─ info/
         ├─ OverviewInfo.ts
         ├─ FrameInfo.ts
         ├─ PipelineInfo.ts
         ├─ SceneGeometryInfo.ts
         ├─ LightingInfo.ts
         ├─ ResourceInfo.ts
         ├─ TemporalInfo.ts
         ├─ GpuInfo.ts
         └─ DiagnosticsInfo.ts
```

第一阶段不强制每个 section 都拆成单独文件。

如果实现较小，可以先聚合，后续再根据复杂度拆分。

---

# 9. UI 顶层结构

推荐使用两个顶层 Tab：

```text
┌──────────────────────────────┐
│ Controls     Renderer Info   │
├──────────────────────────────┤
│                              │
│                              │
│                              │
└──────────────────────────────┘
```

职责：

```text
Controls
    ↓
修改 Renderer

Renderer Info
    ↓
观察 Renderer
```

两边必须保持单向职责。

---

# 10. Controls 总体目录

推荐：

```text
Controls

├─ Renderer
├─ Resolution
├─ Materials
├─ Lighting
├─ Shadows
├─ Environment & GI
├─ Screen-Space Diffuse
│  ├─ GTAO
│  └─ SSGI
├─ Reflections
│  └─ SSR
├─ Transparency
├─ Temporal & Reconstruction
│  ├─ TAA
│  ├─ TAAU
│  ├─ NSS
│  └─ Dynamic Resolution
├─ Post Processing
│  ├─ Bloom
│  ├─ Exposure
│  ├─ Tone Mapping
│  ├─ Color Grading
│  ├─ Sharpen
│  └─ Motion Blur
└─ Debug Views
```

---

# 11. Controls 展开策略

所有目录默认：

```text
collapsed
```

原因：

Renderer 参数数量会持续增加。

如果所有 Feature 默认展开，Tweakpane 会迅速变成不可维护的大型表单。

推荐：

```text
Renderer                collapsed
Resolution              collapsed
Materials               collapsed
Lighting                collapsed
Shadows                  collapsed
Environment & GI         collapsed
Screen-Space Diffuse     collapsed
Reflections              collapsed
Transparency             collapsed
Temporal                 collapsed
Post Processing          collapsed
Debug Views              collapsed
```

Example 可自动 focus 当前 Feature。

---

# 12. GTAO Controls

GTAO 不只是提供基础开关。

需要完整暴露 production settings。

例如：

```text
Screen-Space Diffuse
└─ GTAO
   ├─ Enabled
   ├─ Resolution Scale
   ├─ Radius
   ├─ Thickness
   ├─ Intensity
   ├─ Slice Count
   ├─ Step Count
   ├─ Temporal
   ├─ Temporal Weight
   ├─ Spatial Filter
   ├─ Bent Normal
   └─ Debug Mode
```

具体字段以当前 `RenderSettings` 为准。

原则：

> Production 中可配置的 GTAO 参数，应尽可能全部可通过 Debug UI 修改。

---

# 13. SSGI Controls

例如：

```text
Screen-Space Diffuse
└─ SSGI
   ├─ Enabled
   ├─ Resolution Scale
   ├─ Radius
   ├─ Sampling Domain
   ├─ Thickness
   ├─ GI Intensity
   ├─ AO Intensity
   ├─ Slice Count
   ├─ Step Count
   ├─ Temporal
   ├─ Temporal Weight
   ├─ Spatial Filter
   ├─ Bent Normal
   └─ Debug Mode
```

---

# 14. SSR Controls

例如：

```text
Reflections
└─ SSR
   ├─ Enabled
   ├─ Resolution Scale
   ├─ Max Distance
   ├─ Base Thickness
   ├─ Distance Thickness Scale
   ├─ Max Roughness
   ├─ Mirror Bias
   ├─ Temporal
   ├─ Temporal Strength
   ├─ Denoise
   ├─ Upsample
   └─ Debug Mode
```

---

# 15. Shadows Controls

例如：

```text
Shadows
├─ Enabled
├─ Cascades
├─ Max Distance
├─ Split Lambda
├─ Bias
├─ Normal Bias
├─ Atlas Resolution
├─ Cache
└─ Debug Cascades
```

未来新增：

```text
Virtual Shadow Map
Contact Shadow
Stochastic Shadow
```

仍放在该目录。

---

# 16. Environment & GI Controls

例如：

```text
Environment & GI
├─ Environment IBL
│  ├─ Enabled
│  ├─ Intensity
│  └─ Rotation
│
├─ Probe Volume
│  ├─ Enabled
│  └─ ...
│
├─ Brick4
│  ├─ Enabled
│  └─ ...
│
└─ Long-range GI
   ├─ Provider
   └─ Debug Provider
```

未来：

```text
DDGI
SVLM
Radiance Cache
ReSTIR GI
```

也继续进入这个目录。

---

# 17. Temporal Controls

推荐：

```text
Temporal & Reconstruction

├─ TAA
├─ TAAU
├─ NSS
├─ Dynamic Resolution
└─ History
```

完整暴露生产参数，例如：

```text
Temporal Mode
History Weight
Jitter
Reactive
Disocclusion
Sharpen
Internal Scale
Target GPU Time
Min Scale
Max Scale
Scale Step
```

实际字段以当前 RenderSettings 为准。

---

# 18. Post Processing Controls

包括：

```text
Post Processing

├─ Bloom
├─ Exposure
├─ Tone Mapping
├─ Color Grading
├─ Sharpen
└─ Motion Blur
```

每个 Feature 完整暴露当前 production settings。

---

# 19. Debug Views

统一提供当前 Renderer 已支持的 Debug View。

例如：

```text
Debug Views

View
├ Final
├ Linear HDR
├ Depth
├ Normal
├ Albedo
├ Material
├ Velocity
├ Visibility Key
├ Meshlet
├ AO
├ Bent Normal
├ SSGI
├ SSR
└ Reactive
```

只展示真实存在的 Debug View。

不要提前创建不存在的选项。

---

# 20. RenderSettings 是唯一配置事实

Debug UI 绝对不能保存一份长期独立参数状态。

错误：

```text
Tweakpane State
      ↓
Renderer 每帧读取
```

正确：

```text
Tweakpane Change
      ↓
renderer.configure(...)
      ↓
RenderSettings
      ↓
MainRenderPipeline
```

即：

> Tweakpane 只是 Controller。

---

# 21. UI 与 Renderer 状态同步

Renderer 参数可能不只通过 Tweakpane 修改。

例如：

```ts
renderer.configure(...)
```

也可能由 Example 或其他开发工具调用。

因此 Debug UI 应能够：

```text
Renderer state changed
      ↓
Debug UI refresh
```

保证显示值与真正 `RenderSettings` 一致。

---

# 22. Example Focus

Example Library 可以调用：

```ts
renderer.debug?.focus("screen-space-diffuse.gtao");
```

效果：

```text
Screen-Space Diffuse   expanded
└─ GTAO                expanded
```

其他全部保持 collapsed。

SSGI：

```ts
renderer.debug?.focus("screen-space-diffuse.ssgi");
```

SSR：

```ts
renderer.debug?.focus("reflections.ssr");
```

Bloom：

```ts
renderer.debug?.focus("post.bloom");
```

---

# 23. Example 自定义 Controls

Renderer 内置 Controls 只负责 Renderer 自己。

Example 仍然可以追加：

```text
Example
├─ Scene
├─ Camera
├─ Animation
└─ Test Setup
```

例如 SSR Example：

```text
Example
└─ Scene
   ├─ Animate Sphere
   ├─ Floor Roughness
   ├─ Camera Speed
   └─ Light Rotation
```

这些不属于 Renderer。

---

# 24. Renderer Info 定位

`Renderer Info` 是：

> 当前 Renderer 状态的轻量实时摘要。

它不是：

- Timeline
- Frame Capture Viewer
- Benchmark Dashboard
- Full Profiler

设计目标：

> 打开面板后，几秒钟内就能看懂 Renderer 当前正在做什么、性能大概如何、当前 Pipeline 开启了哪些 Feature、资源使用如何、GPU 是否正常。

---

# 25. Renderer Info 目录

推荐：

```text
Renderer Info

├─ Overview
├─ Frame
├─ Pipeline
├─ Scene & Geometry
├─ Lighting
├─ Resources
├─ Temporal
├─ GPU
└─ Diagnostics
```

同样使用折叠目录。

推荐默认：

```text
Overview expanded
其余 collapsed
```

---

# 26. Overview

Overview 提供最常用的信息。

例如：

```text
Overview

FPS                 143

CPU Frame           4.8 ms
GPU Frame           5.9 ms

Output              2560 × 1440
Internal            1920 × 1080
Render Scale        0.75

Frame               18292
Submit              1

Render Passes       7
Compute Passes      18

HDR                 On
Temporal            TAAU
Screen Diffuse      SSGI
Reflections         SSR
```

原则：

> Overview 一屏内完成 Renderer 健康状态判断。

---

# 27. Frame

Frame 展示当前 CPU/GPU 时间摘要。

例如：

```text
Frame

CPU
  Frame             4.83 ms
  Scene Prepare     0.21 ms
  View Prepare      0.08 ms

GPU
  Frame             5.91 ms
  Visibility        0.43 ms
  Surface           1.08 ms
  Lighting          1.26 ms
  SSGI              0.74 ms
  SSR               0.61 ms
  Temporal          0.49 ms
  Post              0.35 ms

Commands
  Render Pass       7
  Compute Pass      18
  Dispatches        52
  Draws             14
```

不要求展示每一个 Pass。

只展示主要阶段。

---

# 28. Pipeline

Pipeline 展示当前真正激活的生产 Renderer 流程。

例如：

```text
Pipeline

✓ Scene Prepare
↓
✓ GPU Hierarchy
↓
✓ Meshlet Work
↓
✓ Visibility
↓
✓ Material Tile
↓
✓ Compute Material
↓
✓ SurfaceLite
↓
✓ Clustered Lighting
↓
✓ Shadow
↓
✓ Brick4 / IBL
↓
✓ SSGI
↓
✓ SSR
↓
○ Transparency
↓
✓ TAAU
↓
✓ Bloom
↓
✓ Exposure
↓
✓ Final Output
```

状态：

```text
✓ active
○ inactive
```

也可以带摘要：

```text
SSGI       active · 0.5x · temporal
SSR        active · 0.5x
MBOIT      inactive
TAAU       active · 0.75 → 1.0
```

---

# 29. Pipeline 数据来源

Pipeline 不应该靠 UI 自己猜。

应该来自：

- 当前 RenderSettings
- FrameGraph Evidence
- Feature Topology
- Runtime Feature State

推荐通过一个格式化层：

```text
Renderer
   ↓
RendererInfoModel
   ↓
PipelineInfo
```

而不是直接在 UI 里访问多个 Renderer private 字段。

---

# 30. Scene & Geometry

例如：

```text
Scene & Geometry

Instances            12,482
Visible Instances     4,118

Geometry Assets          87
Resident Assets          82

Meshlet Capacity     500,000
Meshlet Work         182,412

Visibility Draws          28

Geometry Resident     312 MiB
Geometry Allocated    384 MiB
```

---

# 31. Lighting

例如：

```text
Lighting

Directional Lights       1
Local Lights            84

Clusters              3456
Active Clusters        921

Shadow Cascades          4
Shadow Atlas        4096²

Long Range GI
  Provider            Brick4

Screen Diffuse
  Mode                SSGI
```

---

# 32. Resources

例如：

```text
Resources

GPU Resident          824 MiB

Geometry              312 MiB
Textures              384 MiB
Surface                48 MiB
HDR                    16 MiB
History                42 MiB
Shadow Atlas           64 MiB
GI                     24 MiB

Texture Binding Sets     2 / 4

Resident Textures      246
Compressed Textures    211
```

---

# 33. Temporal

例如：

```text
Temporal

Mode                  TAAU
Internal Scale        0.75

Color History         valid
Depth History         valid
SSGI History          valid
SSR History           valid
Exposure History      valid

History Revision      27

DRS                   adaptive
GPU Target            8.0 ms
Current GPU           6.1 ms
```

---

# 34. GPU

例如：

```text
GPU

Adapter
  Vendor              NVIDIA
  Architecture        ...
  Device              ...

Features
  timestamp-query       ✓
  subgroups             ✓
  primitive-index       ✓
  texture-formats-tier1 ✓

Texture Binding Sets    4
HDR Format              rgba16float
Depth Format            depth32float
```

可以进一步折叠：

```text
Limits
```

只显示关键 Limits。

---

# 35. Diagnostics

例如：

```text
Diagnostics

Validation Errors       0
Uncaptured Errors       0
Device Lost             0

Geometry Overflow       0
Visibility Invalid      0
Material Invalid        0

GPU Timing              available
GPU Counters            available
```

不在 Debug UI 中建立完整日志系统。

详细错误继续使用浏览器 Console。

---

# 36. Performance Inspector 的处理方式

新的 Debug UI 不再使用当前 Performance Inspector 作为日常 UI。

但是必须明确：

> 不删除底层性能数据采集能力。

当前 Performance Inspector 的数据链大致是：

```text
Renderer / GPU owners
  ↓
ProfilerEvidenceSource
  ↓
LiveProfilerStore
  ↓
InspectorViewModel
  ↓
InspectorShell
```

新的日常 Debug UI 建议：

```text
Renderer / GPU owners
       ↓
FrameProfiler / Evidence
       ├──────────────→ Benchmark / Validation
       │
       └──────────────→ RendererInfoModel
                               ↓
                         Tweakpane Debug UI
```

---

# 37. 保留的底层能力

保留：

- `FrameProfiler`
- GPU Timestamp
- GPU Counter
- Runtime Metric
- Resource Accounting
- Validation Error Count
- Device Lost Evidence
- FrameGraph Evidence
- History Evidence

这些数据不仅服务 Debug UI，也服务未来：

- Benchmark
- Browser Validation
- Performance Regression
- Formal PERF

---

# 38. 不再依赖的旧 Inspector UI

日常 Example / Renderer 开发不再依赖：

- `LiveProfilerStore`
- `InspectorViewModel`
- `InspectorLayoutModel`
- `InspectorShell`
- Inspector Timeline UI
- Inspector Record UI
- Inspector High Detail UI

是否后续真正删除这些文件，需要在独立 Cleanup ADR 中决定。

本设计阶段只决定：

> 新 Example / Debug UI 不再依赖它们。

---

# 39. RendererInfoModel

需要一个独立格式化层：

```ts
interface RendererInfoSnapshot {
  overview: RendererOverviewInfo;
  frame: RendererFrameInfo;
  pipeline: RendererPipelineInfo;
  scene: RendererSceneInfo;
  lighting: RendererLightingInfo;
  resources: RendererResourceInfo;
  temporal: RendererTemporalInfo;
  gpu: RendererGpuInfo;
  diagnostics: RendererDiagnosticsInfo;
}
```

它负责把原始 metric 转换为可读状态。

---

# 40. 格式化示例

原始：

```text
packed.material.surfaceAttachmentBytes = 49766400
```

显示：

```text
Surface Memory
47.5 MiB
```

原始：

```text
gpu frame = 5.912847
```

显示：

```text
GPU Frame
5.91 ms
```

原始：

```text
ssgi.historyValid = 1
```

显示：

```text
SSGI History
valid
```

原始：

```text
timestamp-query unsupported
```

显示：

```text
GPU Timing
unsupported
```

---

# 41. Availability 语义

以下状态必须区分：

```text
available
pending
unsupported
dropped
failed
```

禁止：

```text
missing → 0
```

否则：

```text
GPU Frame = 0 ms
```

会产生错误结论。

---

# 42. Renderer Info 更新频率

Renderer 可能运行：

```text
60 Hz
120 Hz
144 Hz
240 Hz
```

UI 不需要同步每一帧刷新。

推荐：

```text
Renderer
  144 Hz
    ↓
Profiler
    ↓
RendererInfoModel
    ↓
Debug UI
   4 Hz
```

默认：

```text
infoRefreshRate = 4 Hz
```

即约：

```text
250 ms
```

刷新一次。

可配置范围建议：

```text
1–10 Hz
```

---

# 43. Controls 更新频率

Controls 不需要固定轮询刷新。

只有以下情况刷新：

- UI 参数修改
- Renderer.configure 外部修改
- Feature topology 改变
- Debug focus 改变
- Renderer resize / mode 改变
- 必要的 runtime state change

避免每帧 rebuild Tweakpane。

---

# 44. Debug UI 性能原则

Debug UI 开启后允许有开发开销。

但仍应避免：

- 每帧创建 DOM
- 每帧 rebuild folder
- 每帧 format 全部 metric
- 每帧同步 GPU readback
- 每帧强制 timestamp query
- 每帧刷新几十个 monitor

数据采集仍遵守异步与采样间隔策略。

---

# 45. Example Library 集成

Example Library 中：

```ts
const renderer = new Renderer({
  debug: true
});
```

即可获得完整 Debug UI。

Example 不再重复创建：

```text
GTAO controls
SSGI controls
SSR controls
Bloom controls
TAA controls
```

Renderer 已经自带。

---

# 46. Example 自动 Focus

例如 GTAO：

```ts
renderer.debug?.focus("screen-space-diffuse.gtao");
```

SSGI：

```ts
renderer.debug?.focus("screen-space-diffuse.ssgi");
```

SSR：

```ts
renderer.debug?.focus("reflections.ssr");
```

Bloom：

```ts
renderer.debug?.focus("post.bloom");
```

自动展开当前 Feature。

---

# 47. Example 额外参数

例如 GTAO Example 可能额外需要：

```text
Example

Scene
├─ Object Count
├─ Animate Objects
├─ Floor Height
└─ Camera Path
```

这些由 Example 自己提供。

推荐 API：

```ts
const folder = renderer.debug?.addExampleFolder("Scene");
```

或者第一阶段直接暴露：

```ts
renderer.debug?.pane
```

由 Example 自己使用 Tweakpane API。

---

# 48. 是否暴露 Tweakpane API

当前阶段推荐允许：

```ts
renderer.debug?.pane
```

原因：

如果为了隐藏 Tweakpane 而重新设计：

```text
DebugFolder
DebugBinding
DebugSlider
DebugCheckbox
DebugMonitor
```

本质上会重复发明一套 UI Framework。

当前这是 Development-only API。

因此可以接受对 Tweakpane 类型的直接依赖。

---

# 49. 未来可能升级

如果未来 Feature 数量显著增加，可以引入：

```text
DebugSectionRegistry
```

例如：

```ts
renderer.debug.registerSection({
  id: "ssgi",
  title: "SSGI",
  build(folder, renderer) {
    ...
  }
});
```

但第一阶段不需要。

当前采用显式 section 构建即可。

---

# 50. 与 Threepipe 的关系

参考 Threepipe 的核心思想：

```text
Runtime Feature
      ↓
Configuration
      ↓
Optional UI Layer
```

但不复制其完整：

- uiConfig
- decorator
- editor
- serializer
- undo / redo
- plugin editor
- material editor
- hierarchy editor

OEngine 当前采用更轻的方式：

```text
RenderSettings
      ↓
RendererDebugController
      ↓
Tweakpane
```

---

# 51. Renderer Info 与 Formal PERF 的边界

Renderer Info 只负责：

```text
实时开发观察
```

例如：

```text
GPU Frame 5.9 ms
```

不应该被直接当成：

```text
正式性能结论
```

Formal PERF 仍必须遵循：

- fixed adapter
- fixed browser
- fixed resolution
- fixed workload
- warmup
- repeated samples
- provenance
- machine-readable result

Renderer Info 不取代 Benchmark Harness。

---

# 52. Renderer Info 与 Validation 的边界

Renderer Info 可以显示：

```text
Validation Errors 0
Device Lost 0
Overflow 0
```

但它不是自动化 Browser Validation。

未来 Validation Runner 可以读取相同 evidence source。

---

# 53. 生命周期

Debug UI 生命周期：

```text
Renderer constructor
      ↓
Renderer initialize
      ↓
debug enabled?
      ↓
lazy load DebugController
      ↓
create Tweakpane
      ↓
bind RenderSettings
      ↓
start Info Refresh
      ↓
Renderer running
      ↓
Renderer.destroy()
      ↓
stop timers
destroy pane
unsubscribe listeners
release DOM
```

---

# 54. Destroy 约束

`Renderer.destroy()` 必须保证：

- Debug refresh timer 停止
- Tweakpane destroy
- Event listener 移除
- RenderSettings subscription 移除
- Profiler listener 移除
- Example custom folders 释放
- DOM 不残留

---

# 55. Error Handling

Debug UI 初始化失败：

```text
Renderer 本身仍可继续运行
```

推荐：

```ts
console.warn("[OEngine Debug] Failed to initialize debug UI", error);
```

除非 Debug UI 被明确声明为 required。

默认 Debug UI 属于 development addon，不应导致 Renderer 生产路径失败。

---

# 56. Success Criteria

第一阶段完成后应满足：

1. `new Renderer({ debug: true })` 可以开启 Debug UI。
2. Debug UI 通过 lazy loading 创建。
3. Controls / Renderer Info 两个顶层 Tab 可用。
4. Renderer 所有主要生产 Feature 都有 Controls 目录。
5. GTAO / SSGI / SSR 等完整参数可调。
6. 所有 Feature Folder 默认 collapsed。
7. Example 可以 focus 指定 Feature。
8. Example 可以添加 Scene-specific controls。
9. Renderer Info 默认显示 Overview。
10. Renderer Info 可以显示 CPU/GPU frame 摘要。
11. Renderer Info 可以显示当前 Pipeline。
12. Renderer Info 可以显示 Scene / Geometry / Resource / Temporal / GPU / Diagnostics。
13. Renderer Info 数据来自已有 profiler/evidence，不重新发明 profiler。
14. 不使用现有 Performance Inspector UI。
15. RenderSettings 仍是唯一配置事实。
16. Debug UI 关闭时不创建 DOM。
17. Renderer.destroy() 可以完全释放 Debug UI。
18. Example Library 不需要单独维护 Feature 参数 UI。

---

# 57. 第一阶段推荐实现顺序

```text
Phase 1
RendererConfig.debug

Phase 2
RendererDebugController + lazy import

Phase 3
Tweakpane shell
Controls / Renderer Info tabs

Phase 4
RenderSettings Controls
Renderer / Resolution / GTAO / SSGI / SSR

Phase 5
剩余 Lighting / Shadow / GI / Temporal / Post Controls

Phase 6
RendererInfoModel

Phase 7
Overview / Frame / Pipeline

Phase 8
Scene / Resources / Temporal / GPU / Diagnostics

Phase 9
Example focus API

Phase 10
Example custom folder API
```

---

# 58. 第一条 Vertical Slice

实现时不要一次做完全部 Controls。

先完成：

```text
RendererConfig.debug
      ↓
lazy DebugController
      ↓
Tweakpane
      ↓
Controls Tab
      ↓
GTAO Folder
      ↓
renderer.configure()
      ↓
Renderer Info
      ↓
Overview
```

证明完整架构正确后，再批量增加 Feature。

---

# 59. 最终架构图

```text
                         Renderer
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
          ▼                 ▼                 ▼
 MainRenderPipeline    RenderSettings    FrameProfiler
          │                 ▲                 │
          │                 │                 │
          │                 │                 ▼
          │           configure()        Raw Evidence
          │                 ▲                 │
          │                 │                 ▼
          │          Debug Controller   RendererInfoModel
          │                 │                 │
          │                 └────────┬────────┘
          │                          │
          │                          ▼
          │                    Tweakpane UI
          │                   ┌───────────────┐
          │                   │ Controls      │
          │                   │ Renderer Info │
          │                   └───────────────┘
          │
          ▼
       GPU Frame
```

---

# 60. 最终决策

OEngine Renderer Debug UI 采用：

> **Optional Lazy Tweakpane Debug Console**

包含：

```text
Controls
+
Renderer Info
```

其中：

### Controls

完整覆盖：

- Renderer
- Resolution
- Materials
- Lighting
- Shadows
- Environment / GI
- GTAO
- SSGI
- SSR
- Transparency
- TAA / TAAU / NSS / DRS
- Bloom
- Exposure
- Tone Mapping
- Color Grading
- Sharpen
- Motion Blur
- Debug Views

全部按目录组织，默认折叠。

### Renderer Info

轻量展示：

- Overview
- Frame
- Pipeline
- Scene & Geometry
- Lighting
- Resources
- Temporal
- GPU
- Diagnostics

### 数据源

保留：

- FrameProfiler
- GPU timestamps
- GPU counters
- Runtime metrics
- Resource accounting
- diagnostics evidence

但不再使用现有 Performance Inspector UI 作为日常开发入口。

### 状态原则

```text
RenderSettings = Source of Truth
Tweakpane = View + Controller
RendererInfoModel = Read-only formatted view
```

这构成 OEngine 当前阶段的轻量 Renderer 开发控制台。
