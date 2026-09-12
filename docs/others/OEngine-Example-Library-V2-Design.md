# OEngine Example Library V2 设计文档

> Status: Design Approved  
> Target: Development-only Example Library  
> Baseline Repository: `bigbigbig2/EEngine`  
> Baseline Commit: `c06859cd2e9d8f4581398e4cb836e226b07ce664`  
> Related ADR: `docs/adr/0012-example-library-reset.md`

---

## 1. 背景

OEngine 已完成旧示例体系清理。

旧 `examples/` 曾同时承担教学示例、Storybook 导航、独立 WebGPU Runtime、Browser Validation Fixture、Validation Runner、Rendering Lab、Formal Benchmark 和性能/截图证据采集。这些责任长期耦合在同一个目录和运行体系中，使示例、验证、性能基准、Storybook 与生产 Renderer 之间边界模糊。

ADR-0012 已明确将旧体系清空，当前 `examples/` 只保留 Storybook 空壳。下一代 Example Library 不再兼容旧 URL、旧 Case Registry、旧 Runner、旧 Rendering Lab 或旧 Storybook 组织方式。

本设计重新定义 OEngine 开发示例系统。

## 2. 设计目标

Example Library V2 的核心目标是：

> 为 OEngine Renderer 开发提供一套独立、颗粒化、可直接运行、可通过 Storybook 浏览的功能示例库。

它不是用户教程，也不是性能面板，更不是自动化验证 Runner。

每一个 Example 应尽可能对应一个 Renderer Feature、一个 GPU Product、一个核心算法、一个生产 Owner 或一个明确的渲染阶段，例如 GTAO、SSGI、SSR、Visibility Key、Clustered Lighting、Cascaded Shadow Maps、TAA、Bloom。

## 3. 核心设计原则

### 3.1 Example 是独立页面

一个 Example 必须是一个真正独立运行的 HTML Document。

基本结构：

```text
example/
├─ index.html
├─ main.ts
├─ example.json
└─ style.css        # 可选
```

Example 自己拥有 Renderer、Scene、Camera、Tweakpane、RAF、GPU Resource Lifecycle、DOM 和 Feature State。不同 Example 之间不共享运行状态。

### 3.2 Storybook 只是 Example Catalog

Storybook 不拥有 Renderer Runtime。

禁止在 Story 中直接创建：

```ts
new Renderer()
new Scene()
navigator.gpu.requestAdapter()
```

Storybook 只负责左侧分类导航、Example 名称、Description、iframe 宿主和 Example URL 跳转。

架构关系：

```text
                         ┌───────────────┐
                         │   yarn dev    │
                         │   Vite MPA    │
                         └───────┬───────┘
                                 │
                                 ▼
                        Independent Example
                       index.html + main.ts
                                 ▲
                                 │
                         ┌───────┴───────┐
                         │   Storybook   │
                         │ iframe entry  │
                         └───────────────┘
```

因此 `yarn dev` 和 `yarn storybook` 最终运行的是同一份 Example Runtime。

## 4. 总体目录结构

建议新目录：

```text
examples/
│
├─ .storybook/
│  ├─ main.ts
│  ├─ manager.ts
│  └─ preview.tsx
│
├─ scripts/
│  ├─ generate-stories.mjs
│  └─ discover-examples.mjs
│
├─ stories/
│  └─ generated/
│
├─ assets/
│  ├─ three/
│  │  ├─ models/
│  │  ├─ hdr/
│  │  ├─ textures/
│  │  └─ licenses/
│  └─ oengine/
│
├─ demos/
│  ├─ 00-foundations/
│  ├─ 01-assets-scene/
│  ├─ 02-gpu-geometry/
│  ├─ 03-visibility/
│  ├─ 04-materials-surface/
│  ├─ 05-lighting/
│  ├─ 06-shadows/
│  ├─ 07-environment-gi/
│  ├─ 08-screen-space-diffuse/
│  ├─ 09-reflections/
│  ├─ 10-transparency/
│  ├─ 11-temporal-reconstruction/
│  ├─ 12-hdr-post/
│  ├─ 13-framegraph-runtime/
│  └─ 14-integrated/
│
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
└─ README.md
```

## 5. Example 独立性约束

Example 之间禁止共享 Runtime Helper。

禁止出现：

```text
examples/shared/createRenderer.ts
examples/shared/createScene.ts
examples/shared/exampleRuntime.ts
examples/shared/globalState.ts
```

开发示例的目标之一就是直接暴露真实生产 API 的使用路径。如果所有 Example 都依赖一个大型 shared runtime，Renderer API 的问题、生命周期问题和依赖问题都会被 Shared Runtime 隐藏。

因此推荐：

```text
GTAO Example
  └─ 自己初始化 Renderer

SSGI Example
  └─ 自己初始化 Renderer

SSR Example
  └─ 自己初始化 Renderer
```

允许一定程度代码重复。在开发型 Example Library 中，可读性和隔离性优先于 DRY。

## 6. 允许共享的内容

唯一鼓励共享的是 Immutable Asset。

允许共享：`.glb`、`.gltf`、`.hdr`、`.ktx2`、`.png`、`.jpg`、`.exr`、license、source metadata。

禁止共享：Renderer、Scene、Camera、RAF、Controls Runtime、GPUDevice、GPUTexture、GPUBuffer、Tweakpane、FrameGraph、History、Feature State。

## 7. 第三方资产来源

需要模型资源时，可从 Three.js Example Library 等固定来源下载至本地。资产必须本地化，Example Runtime 不依赖远程 CDN。

每个第三方资产目录应包含：

```text
asset/
├─ model.glb
├─ SOURCE.md
└─ LICENSE.txt
```

`SOURCE.md` 至少记录：

```text
Source:
Revision:
Original URL:
Downloaded At:
Used By:
```

这样保证 Example 可离线运行、Git Revision 可重现、不受上游 URL 变化影响，并可审计 License。

## 8. 引擎源码引用策略

Example 直接通过相对路径引用 OEngine 源码。

例如：

```ts
import {
  Renderer,
  Scene,
  PerspectiveCamera
} from "../../../../OEngine/src/index.ts";
```

不推荐为 Example 创建 `@oengine` alias。

默认优先通过 `OEngine/src/index.ts` 使用生产公开 API。只有开发低层 GPU Feature 时，才允许明确引用 `OEngine/src/render/...` 或 `OEngine/src/gpu/...` 等内部模块，这类 Example 应明确标记为 Internal Development Example。

## 9. Example Metadata

每个 Example 放置 `example.json`。

推荐 schema：

```json
{
  "id": "screen-space-diffuse-gtao",
  "title": "GTAO",
  "category": "08-screen-space-diffuse",
  "order": 10,
  "description": "Ground Truth Ambient Occlusion production path.",
  "tags": ["render", "ao", "temporal"]
}
```

Example Metadata 不执行任何引擎代码，只用于 Storybook Catalog、Dev Index、搜索、排序和 URL discovery。

## 10. Storybook 自动生成

Storybook Story 不建议手写一份又一份。

推荐：

```text
demos/**/example.json
        ↓
discover-examples.mjs
        ↓
generate-stories.mjs
        ↓
stories/generated/*.stories.tsx
```

Generated Story 只负责创建 iframe。

概念结构：

```tsx
export const Example = () => (
  <iframe
    src="http://localhost:5173/demos/08-screen-space-diffuse/gtao/"
  />
);
```

Story 不导入 OEngine、Renderer、Scene、WebGPU 或 Tweakpane。

## 11. Storybook Preview 规则

Storybook Preview 应使用 `layout: fullscreen`，而不是 `layout: centered`，因为每个 Example 都是完整 WebGPU viewport。

Storybook addon panel 默认关闭。Storybook 只保留 Sidebar、Search、Description、Canvas 和 iframe。

不使用 Storybook Controls 操作 Renderer 参数。Renderer 参数全部交给 Example 内的 Tweakpane。

## 12. Dev Runtime

`yarn dev` 使用 Vite Multi Page Application。

目录 URL 与源码目录一一对应。

例如：

```text
examples/demos/08-screen-space-diffuse/gtao/
```

浏览器：

```text
http://localhost:5173/demos/08-screen-space-diffuse/gtao/
```

其他示例：

```text
/demos/03-visibility/visibility-key/
/demos/08-screen-space-diffuse/ssgi/
/demos/09-reflections/ssr/
/demos/11-temporal-reconstruction/taa/
/demos/12-hdr-post/bloom/
```

不增加 `?id=ssr`、`?case=gtao`、`#/renderer/example` 之类虚拟 Router。目录即路由。

## 13. Storybook Runtime

推荐启动模式：

```text
yarn storybook
```

内部同时启动：

```text
Vite Example Server
+
Storybook
```

Storybook iframe 指向 Vite Example Server，因此 `yarn dev` 和 `yarn storybook` 看到的 Example Runtime 完全一致，不存在 Storybook 版本 Renderer 与 Dev 版本 Renderer 两套生命周期。

## 14. 推荐 Scripts

设计目标：

```json
{
  "scripts": {
    "dev": "...",
    "storybook": "...",
    "typecheck": "...",
    "build": "...",
    "build:examples": "...",
    "build:storybook": "...",
    "generate:stories": "..."
  }
}
```

具体命令在 Implementation Plan 阶段决定。

## 15. Tweakpane 约定

所有开发参数 UI 使用 Tweakpane。

不使用 Storybook Controls、Performance Inspector 或自定义大型 Debug Panel。

Tweakpane 属于 Example 自己的 Runtime。Example unload 时，Pane、Renderer、RAF、EventListener 和 Scene Resources 全部随 Document 一起销毁。

## 16. Tweakpane 参数分类

推荐统一 Folder 风格：

```text
Renderer
Feature
Scene
Camera
Debug
```

例如 GTAO：

```text
GTAO
├─ Enabled
├─ Radius
├─ Thickness
├─ Intensity
├─ Resolution Scale
├─ Temporal
├─ Slice Count
├─ Step Count
└─ Debug View
```

SSGI：

```text
SSGI
├─ Sampling Domain
├─ Radius
├─ Thickness
├─ GI Intensity
├─ AO Intensity
├─ Resolution Scale
├─ Slice Count
├─ Step Count
├─ Temporal
└─ Debug View
```

SSR：

```text
SSR
├─ Enabled
├─ Resolution Scale
├─ Max Distance
├─ Base Thickness
├─ Distance Thickness Scale
├─ Max Roughness
├─ Mirror Bias
├─ Temporal
├─ Temporal Strength
└─ Debug View
```

## 17. Production Path 原则

Example 默认必须使用生产 Renderer 路径。

例如 GTAO：

```text
Renderer
   ↓
Renderer.configure()
   ↓
AOService
   ↓
GtaoPass
```

不应该为了方便直接 `new GtaoPass()`。否则 Example 测试的是单独 Pass，而不是 Production Renderer Feature。

只有专门研究内部 Pass 时才能绕过 Renderer，这类 Example 必须明确标记 Internal。

## 18. 不接 Performance Inspector

Example Library 明确禁止默认加载 `OEngine/src/addons/inspector`，也不加载 Profiler Timeline、Performance Panel、FrameGraph Panel 或 GPU Counter Panel。

这些仍属于生产 Inspector / Evidence 系统。

Example 允许显示少量即时信息，例如：

```text
Resolution: 1920 × 1080
Internal Scale: 0.5
History Valid: true
```

但不得重新创建一套性能分析 UI。

## 19. Example 粒度原则

一个 Example 一般对应一个 Production Feature、一个核心 GPU Product 或一个主要算法。

以下应独立 Example：GTAO、SSGI、SSR、TAA、Bloom、Visibility Key、Clustered Lighting、CSM。

以下不独立 Example：GTAO Radius、GTAO SliceCount、SSR maxDistance、SSR temporalStrength、Bloom intensity。这些是参数，应放 Tweakpane。

## 20. Example 是否拆分的判断规则

```text
有独立 Production Owner？
        ↓ YES
通常独立 Example

有独立 GPU Product？
        ↓ YES
通常独立 Example

是独立算法？
        ↓ YES
独立 Example

只是 numeric parameter？
        ↓ NO
放 Tweakpane

只是 Debug View？
        ↓ NO
放 Tweakpane

只是同算法不同质量级别？
        ↓ NO
放 Tweakpane
```

## 21. Storybook 左侧目录

```text
Examples
│
├─ 00 Foundations
│  ├─ Minimal Renderer
│  ├─ Basic PBR Scene
│  ├─ Camera & Orbit
│  ├─ Renderer Resize
│  └─ Renderer Configuration
│
├─ 01 Assets & Scene
│  ├─ GLTF Model Loading
│  ├─ Geometry Asset Package
│  ├─ Texture Asset Package
│  ├─ KTX2 Texture
│  ├─ Texture Binding Sets
│  ├─ Scene Patch
│  ├─ Scene Resync
│  └─ Brick4 Package
│
├─ 02 GPU Geometry
│  ├─ Meshlets
│  ├─ Cluster Hierarchy
│  ├─ SSE LOD Selection
│  ├─ GPU Hierarchy Culling
│  ├─ Cone Culling
│  ├─ Geometry Work Budget
│  └─ Large Triangle Setup
│
├─ 03 Visibility
│  ├─ Reverse-Z Depth
│  ├─ HZB
│  ├─ HZB Occlusion Culling
│  ├─ Visibility Key
│  ├─ Projection Risk Buckets
│  └─ Primitive Index
│
├─ 04 Materials & Surface
│  ├─ PBR Material
│  ├─ Base Color
│  ├─ Normal Mapping
│  ├─ ORM
│  ├─ Emissive
│  ├─ Alpha Mask
│  ├─ Unlit
│  ├─ Material Tile Work
│  ├─ Compute Material
│  └─ Velocity
│
├─ 05 Lighting
│  ├─ Directional Light
│  ├─ Point Lights
│  ├─ Spot Lights
│  ├─ Clustered Lighting
│  └─ Many Lights
│
├─ 06 Shadows
│  ├─ Cascaded Shadow Maps
│  ├─ Shadow Atlas
│  ├─ Shadow Cache
│  ├─ Alpha Tested Shadows
│  └─ Shadow Bias
│
├─ 07 Environment & GI
│  ├─ Environment IBL
│  ├─ Light Probe Volume
│  ├─ Brick4 Light Map
│  ├─ Hybrid GI
│  └─ Specular Ambient Occlusion
│
├─ 08 Screen-Space Diffuse
│  ├─ GTAO
│  ├─ Bent Normal
│  └─ SSGI
│
├─ 09 Reflections
│  ├─ SSR
│  ├─ SSR Denoise
│  └─ Rough Reflections
│
├─ 10 Transparency
│  ├─ Alpha Blend
│  ├─ MBOIT
│  └─ Transparent Reactive
│
├─ 11 Temporal & Reconstruction
│  ├─ TAA
│  ├─ TAAU
│  ├─ NSS
│  ├─ Dynamic Resolution
│  ├─ Temporal History
│  └─ Motion Blur
│
├─ 12 HDR & Post Processing
│  ├─ Bloom
│  ├─ Automatic Exposure
│  ├─ Tone Mapping
│  ├─ Color Grading
│  ├─ Sharpen
│  ├─ HDR Output
│  └─ Final Output Fusion
│
├─ 13 FrameGraph & Runtime
│  ├─ Feature Pruning
│  ├─ Transient Resources
│  ├─ Graph Cache
│  ├─ History Lifecycle
│  ├─ Scene Lifecycle
│  └─ Device Loss
│
└─ 14 Integrated
   ├─ PBR Studio
   ├─ Sponza
   ├─ Dungeon
   └─ Full Pipeline
```

## 22. 分类与当前 Renderer 架构映射

| Example Category | Production Architecture |
| --- | --- |
| Foundations | `Renderer`, Camera, Scene |
| Assets & Scene | Runtime Assets, `GpuAssetStore`, `TextureResidency`, `GpuScene`, `GpuRenderWorld` |
| GPU Geometry | Hierarchy, MeshletWork, Geometry Work Generation |
| Visibility | `PackedVisibilityPass`, HZB, VisibilityKey |
| Materials & Surface | `SurfaceFeature`, MaterialTileWork, Compute Material, SurfaceLite |
| Lighting | `LightingFeature`, Light Database, Clustered Lighting |
| Shadows | `ShadowFeature`, Shadow Atlas, CSM |
| Environment & GI | `GIService`, IBL, Probe Volume, Brick4 |
| Screen-Space Diffuse | `AOService`, `ScreenSpaceDiffuseService`, GTAO, SSGI |
| Reflections | `ReflectionService`, SSR |
| Transparency | `TransparencyFeature`, MBOIT |
| Temporal | `TemporalFeature`, TAA/TAAU/NSS/DRS |
| HDR & Post | `PostFeature`, Bloom, Exposure, Final Output |
| FrameGraph & Runtime | FrameGraph, History, Lifecycle |
| Integrated | Full Production Pipeline |

因此 Example Library 的信息架构直接映射生产 Renderer。

## 23. 分类说明

### 23.1 Foundations

用于最小 Renderer 生命周期，包括 Minimal Renderer、Basic PBR Scene、Camera & Orbit、Renderer Resize、Renderer Configuration。

### 23.2 Assets & Scene

重点观察 Runtime Asset → GPU Residency 链，包括 GLTF Model Loading、Geometry Asset Package、Texture Asset Package、KTX2 Texture、Texture Binding Sets、Scene Patch、Scene Resync、Brick4 Package。

### 23.3 GPU Geometry

对应 GPU-driven 几何处理，重点包括 Meshlet、Cluster、Hierarchy、LOD、Cull、Work Budget 和 Large Triangle Setup。

### 23.4 Visibility

重点包括 Reverse-Z、HZB、Occlusion、VisibilityKey、Primitive Identity 和 Projection Risk。

### 23.5 Materials & Surface

OEngine 的核心不是传统 GBuffer，而是：

```text
Visibility
→ MaterialTileWork
→ Compute Material
→ SurfaceLite
```

因此 Material Tile Work、Compute Material、Velocity 应成为重点 Example，而不仅仅是 BaseColor / NormalMap。

### 23.6 Lighting

当前主要路径：

```text
GPU Light Database
→ Candidate Lights
→ Active Lights
→ Cluster
→ Direct Lighting
```

未来 ReSTIR DI landing 后，可自然新增 `ReSTIR Direct Lighting`，无需改分类结构。

### 23.7 Shadows

当前重点为 CSM、Atlas、Cache、Alpha Mask、Bias。未来 Contact Shadow、Virtual Shadow Map、Stochastic Shadow 继续放在此分类。

### 23.8 Environment & GI

当前 Long Range GI 抽象为 Brick4 → Probe Volume → IBL → Black。未来新增 DDGI、SVLM、Radiance Cache、ReSTIR GI 时不需要重构 Storybook 信息架构。

### 23.9 Screen-Space Diffuse

当前核心为 GTAO 和 SSGI。Bent Normal 可作为单独 Visualization Example。

### 23.10 Reflections

重点包括 SSR、SSR Denoise、Rough Reflections。

### 23.11 Transparency

重点包括 Alpha Blend、MBOIT、Transparent Reactive。

### 23.12 Temporal & Reconstruction

包括 TAA、TAAU、NSS、Dynamic Resolution、Temporal History、Motion Blur。Future Upscaler 也放这里。

### 23.13 HDR & Post Processing

包括 Bloom、Automatic Exposure、Tone Mapping、Color Grading、Sharpen、HDR Output、Final Output Fusion。应尽量观察 Production Final Output 路径，不重新创建传统 Postprocessing Chain 绕过主 Renderer。

### 23.14 FrameGraph & Runtime

这是开发者专用分类，重点展示 Feature Pruning、Transient Resource Lifetime、Graph Cache、History Lifecycle、Scene Lifecycle、Device Loss。

### 23.15 Integrated

Integrated 不是主要开发入口，数量保持很少。推荐 PBR Studio、Sponza、Dungeon、Full Pipeline。禁止重新演化成旧 Rendering Lab。

## 24. 不建立 Experimental 空分类

当前尚未正式进入生产的技术，例如 ReSTIR DI、ReSTIR GI、SVLM、VSM、GPU Animation、Virtual Texturing，不应该提前创建空 Story。

原则：

> Example Library 表达当前真实能力，而不是 Roadmap。

等 production owner landing 后再增加对应 Example。

## 25. 生命周期规范

每个 Example 的生命周期：

```text
HTML Load
   ↓
create Renderer
   ↓
initialize Renderer
   ↓
load local asset
   ↓
create Scene
   ↓
configure feature
   ↓
start RAF
   ↓
Tweakpane interaction
   ↓
Page unload
   ↓
Document destroyed
```

因为 iframe 会销毁整个 Document，因此 Example 切换天然形成强隔离。

## 26. Error Handling

Example 初始化失败应直接在页面显示错误，例如 WebGPU unavailable、Renderer initialization failed、Asset load failed、Unsupported capability。

不要静默吞掉错误，同时保留：

```ts
console.error(error);
```

当前 Example Library 不需要重新引入旧 Browser Runner Error Protocol。

## 27. Device Loss

Device Loss 属于 Renderer Runtime Example。普通 Example 不需要实现复杂 recovery harness，可以在 `13 FrameGraph & Runtime / Device Loss` 单独演示。

## 28. Example 与 Validation 的边界

Example Library V2 当前不是正式 Browser Validation 系统。

Example 成功运行只意味着该页面在开发环境可运行，不能自动升级为 Runtime Validated、Performance Improved 或 ADR Complete。

未来 Browser Validation 可以复用这些真实 Example URL 作为宿主，但 Validation Registry、Runner、Screenshot、Console Capture、GPU Diagnostics、Benchmark Policy 必须是独立系统。

## 29. Example 与 Performance Benchmark 的边界

不恢复旧 Rendering Lab。

正式 PERF 应属于未来独立 Performance Host。

Example 可以用于视觉调试、功能开发、局部 A/B 和参数观察，但不能作为 Formal Benchmark 唯一宿主。

## 30. 为什么不共享 Runtime Harness

旧 Example System 的一个主要风险是：

```text
Example
  ↓
Shared Canonical Runtime
  ↓
Renderer
```

时间久了 Shared Runtime 会变成第二套 Engine，然后出现 Renderer API 与 Example Runtime API 不一致。

因此 V2 明确禁止这种结构。

允许非常小的无状态工具，例如 `formatNumber()`、`assetPath()`，但不建议初期创建。优先让 Example 完全自包含。

## 31. 推荐首批 Example

第一阶段不需要一次实现完整分类。

建议最先做：

```text
00 Foundations
└─ Minimal Renderer

04 Materials & Surface
└─ PBR Material

05 Lighting
└─ Directional Light

08 Screen-Space Diffuse
├─ GTAO
└─ SSGI

09 Reflections
└─ SSR

11 Temporal & Reconstruction
└─ TAA

12 HDR & Post Processing
└─ Bloom

14 Integrated
└─ Sponza
```

这样最快覆盖当前最核心 Renderer 链。

## 32. 首批推荐资产

建议第一批只引入少量高价值资产：Damaged Helmet、Sponza、Dungeon、Venice Sunset HDR。

| Asset | 用途 |
| --- | --- |
| Damaged Helmet | PBR / IBL / Material |
| Sponza | GTAO / SSGI / SSR / Shadow |
| Dungeon | GI / Reflection / Low-light |
| Venice Sunset HDR | Environment / IBL / Exposure |

避免一开始复制整个 Three.js asset repository。

## 33. 命名规范

目录使用 kebab-case：

```text
screen-space-diffuse
visibility-key
clustered-lighting
automatic-exposure
```

Storybook Title 使用正常英文：

```text
Screen-Space Diffuse
Visibility Key
Clustered Lighting
Automatic Exposure
```

Category 数字只用于稳定排序：`00` 到 `14`。不要让数字进入用户可见 Example 名。

## 34. Example HTML 规范

`index.html` 保持极小，主要职责是 canvas、main.ts entry 和 viewport CSS。

不在 HTML 写业务逻辑。UI 控件由 Tweakpane 创建。

## 35. Example CSS 规范

推荐 `html`、`body`、`canvas` 占满 viewport。Tweakpane 固定在右上角或左上角。

不创建大量 Dashboard UI。Example 是 Renderer viewport，而不是工具页面。

## 36. Storybook UI 规范

Storybook 左侧保留分类、Example、搜索。

主区域为 100% iframe。

隐藏不必要的 Addon Panel、Controls、Actions、Docs Toolbar。

如果未来需要 Source Link，可以作为 metadata 展示，不运行额外 Runtime。

## 37. Success Criteria

Example Library V2 第一阶段完成后，应满足：

1. `yarn dev` 可以通过目录 URL 打开任意 Example。
2. 每个 Example 是独立 `index.html + main.ts`。
3. Example 之间没有共享 Renderer Runtime。
4. Storybook 左侧按 Renderer 架构分类。
5. Storybook 点击 Example 后运行同一个 standalone page。
6. Storybook 不创建 Renderer。
7. 所有调参使用 Tweakpane。
8. 不接入 Performance Inspector。
9. Example 可直接相对引用 OEngine 源码。
10. Third-party asset 本地化并保留 Source/License。
11. GTAO、SSGI、SSR 等核心 Feature 有独立颗粒化 Example。
12. Integrated Example 不承担 Feature 的主要开发入口。
13. Validation 与 Performance Benchmark 仍保持独立边界。

## 38. 最终架构

```text
                     OEngine Source
                          ▲
                          │ relative import
                          │
             ┌────────────┴─────────────┐
             │                          │
       GTAO Example                SSR Example
   index.html + main.ts        index.html + main.ts
             │                          │
             └───────────┬──────────────┘
                         │
                standalone browser
                         ▲
                ┌────────┴────────┐
                │                 │
             Vite Dev         Storybook
                │                 │
                │              iframe
                └────────┬────────┘
                         │
                same Example Runtime
```

Storybook 不进入生产 Renderer 生命周期。

## 39. 最终决策摘要

Example Library V2 采用以下原则：

1. 一个 Example 一个独立 HTML Document。
2. Storybook 仅作为 Example Catalog。
3. Storybook 通过 iframe 打开 standalone Example。
4. `yarn dev` 和 `yarn storybook` 使用同一 Runtime。
5. Example 之间不共享 Renderer / Scene / State / GPU Resource。
6. 只共享 immutable assets。
7. Example 使用 Tweakpane 调试。
8. 不接入 Performance Inspector。
9. Example 尽量走正式 Renderer production path。
10. 示例分类直接映射 OEngine 当前渲染架构。
11. GTAO / SSGI / SSR 等按 Feature 颗粒化。
12. 参数差异通过 Tweakpane，而不是拆多个页面。
13. Story 自动从 `example.json` 生成。
14. 目录路径即开发 URL。
15. Example Library 不重新承担 Validation Runner 或 Formal Benchmark。

## 40. 后续实施方向

本设计批准后，下一阶段应单独制定 Implementation Plan，至少包含：

```text
Phase 1
Example/Vite 基础运行框架

Phase 2
Storybook iframe catalog

Phase 3
Metadata + Story generation

Phase 4
Tweakpane 基础依赖

Phase 5
Minimal Renderer Example

Phase 6
GTAO / SSGI / SSR

Phase 7
Assets + License provenance

Phase 8
更多 Renderer Feature Example
```

实现阶段应优先建立一条完整 Vertical Slice：

```text
Minimal Renderer
   ↓
Vite Route
   ↓
Storybook Entry
   ↓
Standalone Runtime
   ↓
Tweakpane
```

证明架构正确后，再批量增加 Example。

---

## Decision

采用：

> **Standalone Vite MPA Examples + Storybook iframe Catalog + Tweakpane per Example**

作为 OEngine Example Library V2 的正式设计方向。
