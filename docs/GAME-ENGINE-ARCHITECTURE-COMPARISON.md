# 常见游戏引擎架构与当前 GPU-Driven 引擎对比

> 文档角色：架构背景与横向比较。本文的 P0–P6 建议用于解释取舍，不覆盖 [ENGINE-DIRECTION-AND-CONSTRAINTS.md](./ENGINE-DIRECTION-AND-CONSTRAINTS.md) 的正式方向。

> 核实日期：2026-08-23。本文优先引用各引擎官方文档、官方源码仓库和第一方技术资料。带版本号的事实只保证对应所列版本；商业引擎未公开的内部实现会明确标成边界，而不会把推测写成事实。

## 0. 阅读结论：先比较“同一层”

`reconstructed` 当前更准确的定位是：**浏览器/WebGPU 优先、专注 GPU-Driven Visibility 与现代实时渲染的 renderer core**。它已经包含 CPU 场景对象、GPU Scene、Meshlet 工作生成、FrameGraph 和完整的光照/后处理链，但还不是 Unity、Unreal Engine、Godot、Bevy 那种覆盖 gameplay、物理、音频、输入、网络、编辑器、资产烘焙、脚本生命周期和多平台发布的完整游戏引擎。

因此本文使用两条比较轴：

1. **完整引擎轴**：对象/实体模型、调度与线程、插件、编辑器、资产流水线、运行时服务、发布平台。
2. **渲染器轴**：Render World/GPU Scene、Render/Frame Graph、RHI/GAL、底层图形 API、GPU-Driven 几何与材质管线。

先给出核心判断：

- 若目标是尽快制作并发布完整游戏，四个成熟引擎都比当前工程覆盖面完整；这不是对 `reconstructed` 渲染算法质量的否定，而是产品边界不同。
- 若目标是研究 WebGPU、Visibility Buffer、HZB、Meshlet 和 GPU work generation，当前工程比通用引擎更直接、更易改动，且不需要穿过庞大的编辑器和兼容层。
- Unity 的长处是商业工具链、SRP 与 Jobs/Burst/DOTS 组合；UE 的长处是大型内容管线、线程/RDG/RHI 和 Nanite/VSM 产品化；Godot 的长处是 Node/Scene 易用层与可绕过的 Server/RID 底层；Bevy 的长处是 Rust ECS、Plugin/SubApp 和可组合的渲染调度。
- 对当前工程最值得借鉴的是**层间边界和可观测性**，不是把四个引擎的所有抽象都复制一遍。

## 1. 常见游戏引擎的总体分层

一个通用引擎通常可以用下面的纵向结构理解：

```text
Editor / Importer / Cooker / Build / Profiler
                    │
Game code / Scripting / Gameplay framework
                    │
Scene Graph or ECS World / Serialization / Prefab-Scene
                    │
Scheduler / Job System / Events / Main Loop
                    │
Physics / Audio / Input / UI / Animation / Network / Navigation
                    │
Render front-end: Camera / Light / Mesh / Material / Render features
                    │  extract / snapshot / proxy / upload
Render World or GPU Scene
                    │
Render Graph / Frame Graph ── resource lifetime, pass dependency, barriers
                    │
RHI / GAL / RenderingDevice / wgpu ── resource and command abstraction
                    │
Vulkan / D3D12 / Metal / WebGPU / OpenGL
                    │
Driver / OS / GPU
```

不是每个引擎都严格按这些目录切分。例如 Godot 把高层 Node 架在 Server API 上；Bevy 用 ECS `App`、`SubApp` 和 schedules 组合；Unity 的 SRP 是 C# 可脚本化渲染层，下面仍有原生低层图形架构；UE 则有 Renderer、RDG、RHI 和平台后端。但它们都必须处理三种不同的数据寿命：

- **Gameplay 数据**追求易修改、可序列化和清晰语义；
- **Render World/GPU Scene 数据**追求稳定快照、批处理和连续布局；
- **GPU 资源**追求显存生命周期、同步、绑定和正确的使用状态。

当前工程已经有第一种的精简版本（`Node3D`/`Scene`）、第二种（`GPUSceneManager`/`SceneDatabase`/GPU tables）和第三种（`GraphicsContext`、allocators、FrameGraph resources）。它缺少的主要不是“再写一个 Pass”，而是围绕这些层的通用 gameplay、并行调度、工具和平台产品化能力。

## 2. 四个经常混淆、但彼此正交的概念

### 2.1 Scene Graph / ECS

它回答“世界怎样表示、逻辑怎样找到对象”：

- Scene Graph 以父子层级、变换传播和对象生命周期为中心；
- ECS 以 Entity 身份、Component 数据和 System 查询/调度为中心；
- 两者可以共存，ECS 也不会自动产生 GPU-Driven 渲染。

### 2.2 Render Graph / Frame Graph

它回答“这一帧有哪些 Pass、读写哪些资源、什么可以裁掉或复用”。成熟实现还可能生成 barrier、做 transient alias、跨 graphics/compute queue 调度和图可视化。它不会自己决定 LOD，也不会自动生成 Meshlet 工作列表。

### 2.3 RHI / GAL

RHI（Render Hardware Interface）或 GAL（Graphics Abstraction Layer）回答“引擎的 Buffer、Texture、Pipeline、Command List、Fence 如何映射到平台 API”。RHI 的目的通常是隔离 Vulkan/D3D12/Metal 的差异；它不等于 Render Graph，也不等于 GPU Scene。

### 2.4 GPU-Driven

GPU-Driven 回答“由谁决定本帧画什么、画多少，并生成后续 GPU 工作”。实例/Meshlet 剔除、LOD、compaction、indirect draw/dispatch 属于这一层。当前 `reconstructed` 的几何可见性链是 GPU-Driven，但 FrameGraph 拓扑、场景建库以及一部分材质调度仍由 CPU 组织；完整细节见 [GPU-DRIVEN-COMPARISON.md](GPU-DRIVEN-COMPARISON.md)。

```text
RHI：怎样向 GPU 表达命令
Render Graph：命令/Pass 怎样依赖和复用资源
GPU-Driven：GPU 怎样生成真正需要执行的几何工作
Scene/ECS：游戏世界怎样表达和更新
```

## 3. 底层图形 API 与引擎抽象

### 3.1 从 OpenGL 到现代显式 API

OpenGL 以 Context 和隐式状态机为中心，很多内存、同步和状态跟踪由驱动承担；Vulkan、D3D12 和 Metal 更强调预先创建 Pipeline、记录 Command Buffer/List、显式资源使用和提交。Khronos 将 Vulkan 定义为高效率、跨平台访问现代 GPU 的 graphics/compute API，并明确指出它比 OpenGL 给应用更多控制，也把更多责任交给应用；Microsoft 说明 D3D12 降低了硬件抽象层级，应用负责更多内存管理，并通过 command lists/queues 改善多核 CPU 扩展；Apple 的 Metal 模型同样从 `MTLDevice` 获取 command queue，再编码和提交 command buffers。[Khronos Vulkan Guide](https://github.com/KhronosGroup/Vulkan-Guide/blob/main/chapters/what_is_vulkan.adoc) · [Microsoft：What is Direct3D 12](https://learn.microsoft.com/en-us/windows/win32/direct3d12/what-is-directx-12-) · [D3D12 Work submission](https://learn.microsoft.com/en-us/windows/win32/direct3d12/command-queues-and-command-lists) · [Apple：GPU devices and work submission](https://developer.apple.com/documentation/metal/gpu-devices-and-work-submission)（核实：2026-08-23）

| API | 主要平台/定位 | CPU 侧核心模型 | 对引擎的意义 |
|---|---|---|---|
| Vulkan | 跨厂商、Windows/Linux/Android 等；Apple 常借助 portability/translation | Instance/physical device/logical device、queue、command buffer、descriptor、pipeline、显式同步 | 控制强、跨平台，但后端与同步/内存管理成本高 |
| D3D12 | Windows/Xbox 生态 | Device、command queue/list、descriptor heap、PSO、fence | Windows 平台能力直接，应用承担更多资源与同步责任 |
| Metal | Apple 平台 | `MTLDevice`、command queue/buffer/encoder、pipeline/resource | 与 Apple GPU/OS 紧密结合，非 Apple 平台不可用 |
| WebGPU | Web 标准，也有 native 实现/封装 | `GPU` → `GPUAdapter` → `GPUDevice`/`GPUQueue` → encoder/pass → submit；WGSL | 现代、可验证且可移植，浏览器安全模型和标准能力集合限制了原生专有能力 |
| OpenGL / OpenGL ES / WebGL | 桌面、移动和旧/低端兼容路径 | Context + 全局/绑定状态 + draw calls | 上手和兼容性好，但驱动隐式工作较多，不适合直接表达许多现代显式调度策略 |

表中是架构心智模型而不是性能排名；性能取决于驱动、目标硬件和工作负载。OpenGL 4.6 的正式契约见 [Khronos OpenGL 4.6 Core Specification](https://github.com/KhronosGroup/OpenGL-Registry/blob/main/specs/gl/glspec46.core.pdf)，Vulkan 的规范源码入口见 [Khronos Vulkan-Docs](https://github.com/KhronosGroup/Vulkan-Docs)（核实：2026-08-23）。

### 3.2 WebGPU 本身已经像一层受约束的 RHI

WebGPU 规范把 `GPUAdapter` 定义为实现/硬件能力的适配入口；由 Adapter 请求 `GPUDevice`，Device 持有默认 `GPUQueue`，应用通过 command encoder 和 render/compute pass encoder 记录命令后提交。Features 和 Limits 必须在创建设备时协商，不能假定所有机器支持同一能力。[W3C WebGPU Specification](https://gpuweb.github.io/gpuweb/#navigator-gpu)（核实：2026-08-23）

这解释了为何 `reconstructed` 没有再写一套 Vulkan/D3D12/Metal RHI：它直接把 WebGPU 当作底层契约。`GraphicsContext` 在它之上提供 allocator、texture/material manager、pipeline/bind group cache 等引擎服务，但类中直接保存 `GPUDevice`，大量 Pass 也直接使用 WebGPU 类型，所以它是 **WebGPU façade**，不是可切换多后端 RHI。

相比之下，Rust 的 `wgpu` 把类似 WebGPU 的 API 暴露给 native 与 Web：wgpu 30.0.0 官方后端枚举包含 Vulkan、Metal、DX12、Browser WebGPU，并把 GL 列为 secondary backend。[wgpu 30 `Backends`](https://docs.rs/wgpu/30.0.0/wgpu/struct.Backends.html)（核实：2026-08-23）Bevy 因而能使用一套 Rust API 覆盖多种原生后端，而当前 TypeScript 工程依赖浏览器提供的 `navigator.gpu`。

### 3.3 “有抽象层”不等于“失去所有底层控制”

优秀 RHI 会统一资源/命令/同步中真正稳定的公共语义，同时保留 capability query、feature flags 和平台扩展。过薄会让平台差异渗入所有 Pass；过厚、以最低共同能力设计，则可能阻碍 bindless、ray tracing、mesh shader 等特性。是否需要自研 RHI 取决于产品目标：

- 若 `reconstructed` 明确只做 WebGPU，直接依赖 WebGPU 是合理的深模块边界；
- 若要输出 Windows/Linux/macOS 原生程序并使用平台专有能力，可以考虑 native WebGPU/wgpu/Dawn，未必需要自己实现三套后端；
- 只有必须精确控制多个原生 API 且愿意承担长期驱动适配时，自研 RHI 才划算。

## Unity：可脚本化渲染管线之上的商业通用引擎

### 1. 先建立正确的分层心智模型

Unity 不是“一个 C# 引擎”。更准确的公开模型是：项目脚本和可见的渲染管线大量使用 C#，它们下面还有 Unity 的原生引擎与低层图形架构，最后才落到平台图形 API。Unity 官方把 SRP 描述为一个“薄 API 层”：C# 代码负责调度和配置渲染命令，Unity 再把命令交给低层图形架构，由它送给图形 API。[Unity 6.0：SRP fundamentals](https://docs.unity3d.com/6000.0/Documentation/Manual/scriptable-render-pipeline-introduction.html)

```text
Gameplay
├─ 传统路线：GameObject / Component / MonoBehaviour
└─ 数据导向路线：Entities (ECS) / Systems / Components
                 │
                 ├─ C# Job System ── Burst ── CPU worker threads / native machine code
                 │
                 └─ RenderPipeline.Render()
                    ├─ URP / HDRP / 自定义 SRP
                    ├─ Culling + renderer lists + passes
                    └─ Render Graph（管线集成的帧图）
                               │
                     Unity low-level graphics architecture
                               │
                   DirectX / Metal / Vulkan / OpenGL
```

这张图里有四个不能互相替代的概念：

- **SRP** 决定“这一帧如何组织渲染”；
- **Render Graph** 根据 Pass 的资源读写关系管理帧内顺序、生命周期和同步；
- **Job System + Burst** 解决 CPU 工作如何并行和高效执行；
- **DOTS/Entities** 解决大量游戏对象的数据布局、查询和系统更新方式。

因此，“用了 Render Graph”“用了 ECS”或“用了 Burst”都不自动意味着 GPU-Driven。GPU-Driven 更具体地要求可见性、LOD、工作列表/间接参数等关键工作由 GPU 生成并继续消费；Render Graph 管的是依赖，ECS 管的是 CPU 侧数据，而不是自动替开发者生成 GPU 可见性算法。

### 2. Built-in、URP、HDRP 与自定义 SRP

Render Pipeline 的共同职责，是把场景内容经过一系列操作显示到屏幕。Unity 同时保留 Built-in Render Pipeline，并提供基于 SRP 的 URP、HDRP 和自定义管线；URP 面向跨越较宽的平台范围，HDRP 面向高端高保真图形。[Unity 6.0：Render pipelines](https://docs.unity3d.com/6000.0/Documentation/Manual/render-pipelines.html)

SRP 管线由两个核心对象构成：

- `RenderPipeline` 实例定义实际功能，派生类覆盖 `Render()`；
- `RenderPipelineAsset` 是项目资产，保存要创建哪一种管线以及管线配置，派生类覆盖 `CreatePipeline()`。

这不是简单的“换一组 Shader”。它把相机、剔除、阴影、绘制列表、Pass 顺序以及后处理等渲染循环决策开放给 C# 管线代码；URP 和 HDRP 本身也是构建在这个接口之上的产品管线。[Unity 6.0：SRP fundamentals](https://docs.unity3d.com/6000.0/Documentation/Manual/scriptable-render-pipeline-introduction.html)

对当前 `reconstructed` 引擎而言，最接近 SRP 的不是某个 WGSL Shader，而是 `Renderer`、各个 render pass 与 Frame/Render Graph 一起形成的上层渲染编排层。区别在于，Unity 把跨平台后端、编辑器资产、对象生命周期及大量产品功能放在 SRP 下面和周围；当前引擎更接近“应用直接拥有渲染器与 WebGPU 资源模型”，层次少、控制直接，但通用平台和工具链责任也由自身承担。

### 3. Unity Render Graph 到底解决什么

Unity 6.0 的 URP 文档把 Render Graph 描述为 Core SRP package 提供的一组 API。编写 Scriptable Render Pass 时，先在 **recording** 阶段声明纹理等资源和用法，再在 **execution** 阶段提交使用这些资源的图形命令；自定义 Pass 被注入 URP 内部每帧执行的 render graph。[Unity 6.0：Introduction to the render graph system in URP](https://docs.unity3d.com/6000.0/Documentation/Manual/urp/render-graph-introduction.html)

因为每个 Pass 先声明输入和输出，系统获得了整帧依赖信息，官方列出的自动优化包括：[同一官方页面](https://docs.unity3d.com/6000.0/Documentation/Manual/urp/render-graph-introduction.html)

- 不分配本帧未使用的资源；
- 如果最终帧不使用某个 Pass 的输出，裁掉该 Pass；
- 在属性兼容时复用先前纹理的显存；
- Compute Shader 参与时，自动同步 compute 与 graphics GPU command queue；
- 在部分 TBDR 移动 GPU 上，把多个 Pass 合并为 native render pass，以便让纹理留在 tile memory；
- 内部资源在第一次写之前才分配，在最后一次读之后释放；跨帧或来自外部的资源则必须显式 import。

Render Graph 的核心收益是**正确性约束 + 全帧优化机会**，不是让 GPU 自己决定渲染什么。它可以调度一个 GPU culling pass，也能调度 indirect draw pass，却不会仅凭资源声明自动产生 meshlet、HZB、LOD 或 indirect argument。

与当前引擎比较：两者在“Pass 声明资源、图编译后执行、瞬态资源复用/生命周期管理”这一层目标相同；当前引擎的优势是图结构能围绕自身的 Visibility、HZB second-chance、Material Expand 和 Deferred 链做专门设计，Unity 的优势是管线、编辑器、Frame Debugger/分析工具与多平台后端已有产品化集成。需要警惕的是，不应仅比较 `RenderGraph` 类的 API 外形，还要比较 pass culling、资源 alias、跨队列同步、外部/跨帧资源以及调试可观测性是否完整。

### 4. Job System 与 Burst：CPU 侧的两块拼图

Unity Job System 允许项目把工作拆成 job，调度到可用 CPU 核心并行执行；Unity 将其定位为编写“简单且安全的多线程代码”的机制。[Unity 6.0：Write multithreaded code with the job system](https://docs.unity3d.com/6000.0/Documentation/Manual/job-system.html)

Job 之间不是靠开发者随意读写共享对象来协调。`Schedule()` 返回 `JobHandle`，后续 job 把它作为依赖；依赖 job 只有在前置 job 完成后才运行，多个依赖可用 `JobHandle.CombineDependencies` 合并。[Unity 6.0：Job dependencies](https://docs.unity3d.com/6000.0/Documentation/Manual/job-system-job-dependencies.html) 这和 Render Graph 有相似的“声明依赖”思想，但前者调度 CPU 工作，后者组织 GPU Pass 与资源，二者不是同一个调度器。

Burst 则是编译器而非线程池。Burst 1.8 将受支持的 C# 子集（Unity 称为 High-Performance C#）从 .NET IL 经 LLVM 编译成面向目标 CPU 架构优化的原生代码；它最初面向 Job System，也可以编译符合约束的静态方法，入口通常使用 `[BurstCompile]`。[Burst 1.8.30 官方手册](https://docs.unity3d.com/Packages/com.unity.burst@1.8/manual/index.html)

所以常见组合是：

```text
ECS/System 或普通 C# 代码
        │ 拆分数据并声明依赖
        ▼
Job System 调度到 worker threads
        │ 编译受支持的热点代码
        ▼
Burst 生成 CPU native code
```

Burst 不是 Shader 编译器，也不会把 C# job 自动搬到 GPU。对于 GPU-Driven 渲染，它更适合加速上传前的场景变更整理、动画、剔除数据构建或其他 CPU producer；真正的 GPU work generation 仍需 Compute Shader、GPU buffer 和 indirect command 路径。

### 5. DOTS / Entities：数据导向世界，不等于整个 Unity 已经 ECS 化

Entities 1.3 是一个可安装 package，也是 DOTS 的组成部分；官方定义是“ECS 架构的数据导向实现”。[Entities 1.3.15：Entities overview](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/index.html) Entity 是身份，Component 主要承载数据，System 按查询匹配实体并执行行为；同一组件集合形成 archetype，这是面向连续数据布局和批处理的重要基础。[Entity concepts](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/concepts-entities.html) · [Component concepts](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/concepts-components.html) · [System concepts](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/concepts-systems.html) · [Archetype concepts](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/concepts-archetypes.html)

这里要避免两个误解：

1. **Entities 是可选的数据导向栈，不是传统 GameObject/MonoBehaviour 已消失。** 实际项目可以使用传统对象模型、ECS，或通过 baking/authoring 边界混合二者。
2. **ECS 主要先改变 CPU 侧存储和执行。** 如果最终仍由 CPU 逐对象发出传统 draw，单凭 ECS 并不会得到完整 GPU-Driven；反过来，GPU Scene 也不要求整个 gameplay 必须采用 ECS。

Unity 还提供 `BatchRendererGroup` 这样的高级渲染接口，让开发者接管批次和 culling 回调，作为自定义高性能渲染器与 Unity 渲染系统之间的接口。[Unity 6.0：BatchRendererGroup API](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Rendering.BatchRendererGroup.html) 但具体项目是否形成 GPU LOD、meshlet work queue 和 GPU indirect draw，仍取决于建立在接口之上的实现。

### 6. 图形 API 抽象层

Unity 6.0 官方列出的图形 API 家族包括 DirectX、Metal、OpenGL 和 Vulkan，具体可用项取决于目标平台。[Unity 6.0：Graphics API support](https://docs.unity3d.com/6000.0/Documentation/Manual/GraphicsAPIs.html) SRP 代码通常操作 `CommandBuffer`、纹理/缓冲区和 Unity Shader 抽象，而不是直接创建 `ID3D12Device`、`VkDevice` 或 `MTLDevice`；后端选择、资源映射、同步和驱动调用由 Unity 的低层图形架构完成。

这与当前工程直接使用 WebGPU 的差异很关键：WebGPU 本身已经是一层现代、显式而受验证约束的跨平台 API，`GPUDevice`、`GPUQueue`、bind group、pipeline、command encoder 和 pass encoder 都直接暴露给引擎；Unity 则在原生 API 之上再提供稳定的引擎级资源、Shader 和渲染管线接口。前者便于精确塑造自己的 GPU Scene，后者换来更成熟的平台覆盖和工具集成。

### 7. Unity 路线相对当前引擎的优缺点

| 维度 | Unity 的主要优势 | 相对当前 `reconstructed` 的代价或限制 |
|---|---|---|
| 产品范围 | Gameplay、物理、动画、音频、编辑器、资产导入、打包与渲染形成完整产品 | 大量系统和生命周期已固定，难以像自研引擎一样任意改变底层约定 |
| CPU 扩展 | Jobs + Burst + Entities 提供成熟的数据并行路径 | 高性能路径有 HPC#、容器、安全系统和 package 版本约束；传统对象与 ECS 的边界需要设计 |
| 渲染扩展 | SRP 在可移植后端上开放渲染循环，URP/HDRP 可直接使用 | 不能等同于直接拥有 D3D12/Vulkan/WebGPU 后端；某些低层策略只能通过 Unity 暴露的接口实现 |
| 帧图 | Render Graph 已集成 pass culling、资源生命周期、队列同步及移动端 native pass 优化 | 它是渲染调度基础设施，不会自动补齐 GPU Scene、meshlet hierarchy 或 GPU LOD |
| GPU-Driven | 可通过 SRP、Compute、indirect、BRG 等机制建设，并继承 Unity 的资产与平台生态 | 通用接口和兼容范围会增加抽象层；能否达到当前引擎特定 Visibility/HZB 算法的可控性必须按功能实测 |
| 学习与验证 | 文档、Profiler、Frame Debugger 和现成管线降低工程门槛 | 商业原生核心不是完整公开实现，无法像本地源码一样逐层审计所有调度与后端细节 |

### 8. Unity 的版本与闭源边界

- 本节的引擎手册固定引用 **Unity 6.0 / 6000.0**，Burst 固定为 **1.8.30**，Entities 固定为 **1.3.15**。不同 Unity 6 更新版、URP/HDRP/Core package 组合可能改变 Render Graph 接入方式、功能开关和支持平台，升级时必须重新核对对应版本文档。
- Unity 官方公开了 [UnityCsReference](https://github.com/Unity-Technologies/UnityCsReference) 以及 [Scriptable Render Pipeline 的 Graphics 仓库](https://github.com/Unity-Technologies/Graphics)，可以核实大量 managed API 和 URP/HDRP/SRP package 代码；这不等于 Unity Player 原生核心、所有图形后端、编辑器内部和平台集成已经完整开源。
- 因而本文可以可靠讨论公开 SRP、Render Graph、Jobs、Burst 与 Entities 契约，但不会声称 Unity 内部如何具体实现所有 driver workaround、RHI command submission、线程唤醒或平台专有优化。与当前源码工程比较时，这一“不可完全审计”本身就是架构边界，而不是性能好坏的证据。

## Unreal Engine：分线程渲染、RDG/RHI 与虚拟化几何的重型通用引擎

### 1. 从 Gameplay 世界到 GPU 的公开主干

Unreal 的关键点不是“C++ 比 TypeScript 更底层”，而是它在大型通用引擎中明确划分了 Gameplay 对象、渲染世界副本、渲染任务图、跨平台 RHI 命令以及平台后端的所有权。

```text
Game Thread
Actor / UObject / Component / gameplay simulation
        │ 创建或更新线程安全的渲染侧表示，enqueue render command
        ▼
Render Thread
Scene / FPrimitiveSceneProxy / Renderer / RDG setup
        │ 并行记录平台无关的 RHI command lists
        ▼
RHI Thread（支持和启用时）
翻译、执行 RHI commands，并进入具体平台 graphics API
        ▼
D3D12 / Vulkan / console backend / ...
        ▼
GPU graphics + compute queues
```

这是一张所有权和命令流示意图，不表示三个线程始终严格串行。Epic 的并行渲染文档说明，Render Thread 是前端，把平台无关的图形命令放入 renderer command list；RHI Thread 在后端用相应图形 API 翻译/执行这些命令。支持的平台上，前后端都可进一步并行；某些 `Lock`/`Unlock` 等命令会绕过 command list，由 Render Thread 直接发出并产生 flush、等待或复制排队等不同处理。[UE 5.8：Parallel Rendering Overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/parallel-rendering-overview-for-unreal-engine)

### 2. Game Thread 与 Render Thread 为什么需要两份世界表示

官方文档明确指出，Unreal 的整个 renderer 在自己的线程运行，通常落后 Game Thread 一到两帧。Game Thread 拥有 `AActor`/`UObject` 状态；如果 Render Thread 直接保存并解引用这些指针，就可能与 Gameplay 写入或 Garbage Collection 形成竞态，甚至访问已经回收的对象。[UE 5.8：Threaded Rendering](https://dev.epicgames.com/documentation/en-us/unreal-engine/threaded-rendering-in-unreal-engine)

因此常见模式是：Game Thread 的 `UPrimitiveComponent` 对应 Render Thread 自己拥有的 `FPrimitiveSceneProxy`。需要渲染的数据在代理创建或更新时被**镜像**过去，而不是让 Render Thread 任意读取 gameplay object。资源初始化与释放也通过 render command 和 fence 协调；`FlushRenderingCommands` 可以让 Game Thread 阻塞到 Render Thread 追上，但官方把这种阻塞主要定位在需要安全修改渲染线程正在使用的数据等场景，频繁使用会形成 stall。[同一 Threaded Rendering 官方文档](https://dev.epicgames.com/documentation/en-us/unreal-engine/threaded-rendering-in-unreal-engine)

这层设计解决的是 CPU 多线程正确性和吞吐，不等于 GPU-Driven。即使 CPU 已经分成 Game/Render/RHI 三层，如果 Render Thread 仍为每个可见对象逐个决定和提交工作，渲染仍可能是 CPU-driven；Nanite 等系统是在这条线程化基础上进一步把细粒度可见性、LOD 和实际几何工作交给 GPU。

与当前工程比较：`reconstructed` 已将 SceneDatabase/GPU tables 和 Visibility work generation 组织成长期驻留 GPU 数据路径，但从公开 TypeScript 源码中不能看到一个与 UE 的 `Game Thread → Render Thread → RHI Thread` 同构的应用级三线程所有权模型。WebGPU 实现和浏览器/原生运行时内部可能使用额外线程，却不应把实现内部线程自动算成当前引擎自己的场景快照、render proxy 和 RHI thread 架构。若未来 gameplay 与渲染更新量变大，UE 最值得借鉴的是**线程拥有数据、跨线程发送不可变快照/命令**，而不是照搬类名。

### 3. RDG：Unreal 的 Render Dependency Graph

Epic 将 RDG 定义为一种 immediate-mode API：调用方按当前帧逻辑记录 render command 和资源依赖，形成图结构，然后统一 compile 和 execute。这里的 “immediate-mode” 指每帧直接用代码描述图，而不是 `AddPass` 当场立刻执行 GPU 命令；Pass lambda 通常延迟到 `FRDGBuilder::Execute()` 阶段执行。[UE 5.8：Render Dependency Graph](https://dev.epicgames.com/documentation/en-us/unreal-engine/render-dependency-graph-in-unreal-engine)

典型流程是：

```text
FRDGBuilder(RHICmdList)
   ├─ CreateTexture / CreateBuffer / RegisterExternal...
   ├─ AllocParameters（Shader 参数同时表达资源依赖）
   ├─ AddPass(..., ERDGPassFlags, lambda)
   └─ Execute()
        ├─ 编译依赖与资源生命周期
        ├─ 调度/并行记录 command lists
        └─ 交给 RHI
```

官方列出的 RDG 能力包括：[同一 RDG 官方文档](https://dev.epicgames.com/documentation/en-us/unreal-engine/render-dependency-graph-in-unreal-engine)

- 调度 asynchronous compute fence；
- 按最优生命周期分配 transient resource，并进行 memory aliasing；
- 使用 split barrier 转换 subresource，以隐藏延迟并增加 GPU overlap；
- 并行记录 command list；
- 裁掉图中未使用的资源和 Pass；
- 校验 API 用法和资源依赖；
- 在 RDG Insights 中可视化图结构与内存生命周期。

RDG 同时优化 **CPU 录制并行性、GPU 调度和显存生命周期**，比把一串回调命名为 FrameGraph 更完整。与当前 `FrameGraph` 对比时，应逐项核实：资源读写是否细化到 subresource、是否真的做 alias、是否能裁 Pass、是否生成 barrier/跨队列同步、是否并行编码、是否有 graph capture/可视化。当前引擎的优点是 GPU Scene、HZB 双阶段和 Material Expand 可以成为第一等领域 Pass；RDG 的优势则是多年产品化后拥有更强的资源校验、RHI 集成和分析工具。

同 Unity Render Graph 一样，RDG 自身也不是 GPU-Driven 算法。它负责让 Nanite culling、Virtual Shadow Map page marking、lighting 等 Pass 正确高效地协同，但不会仅靠一张依赖图自动得到 Nanite。

### 4. RHI：跨平台图形后端边界

RHI（Render Hardware Interface）是 Unreal 在 renderer 和平台 graphics API 之间的抽象。Epic 的并行渲染文档直接称其为进入不同平台图形 API 的 cross-platform interface，并以 console、DX12、Vulkan 为支持后端并行化的例子。[UE 5.8：Parallel Rendering Overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/parallel-rendering-overview-for-unreal-engine) RHI 的公开 API 类型覆盖 buffer/texture/resource view、graphics/compute/ray-tracing pipeline state、render pass、fence、readback、command list 等对象。[UE 5.8：RHI API](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/RHI)

要区分三件事：

- **RDG**：知道一帧内哪些 Pass 读写哪些逻辑资源；
- **RHI**：把引擎渲染器的资源与命令表达成跨平台接口；
- **D3D12/Vulkan/Metal 等后端**：把 RHI 契约映射到具体原生 API 和驱动。

当前工程直接面向 WebGPU，WebGPU 同时承担了相当一部分“现代跨平台 RHI”的角色：资源使用标志、bind group、pipeline、encoder、render/compute pass 和 queue submit 已经标准化。自研层仍需补充缓存、分配器、FrameGraph、设备丢失处理和引擎资源系统，但不必再为每个平台实现完整 D3D12/Vulkan/Metal backend。代价是能力边界由 WebGPU 标准和实现暴露决定，无法默认使用某个原生 API 的全部专有特性。

### 5. Nanite：不只是“把模型切成 Meshlet”

Nanite 是 UE 的 virtualized geometry system。UE 5.8 官方说明，它使用内部 mesh format 和专用 rendering technology，只处理屏幕可见的必要细节；数据高度压缩，支持 fine-grained streaming 和 automatic LOD。[UE 5.8：Nanite Virtualized Geometry](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine)

导入阶段，Nanite 会分析网格并把它拆成**有层级的 triangle-group clusters**；渲染时按相机视角在不同细节级别的 cluster 之间切换，同一对象内相邻 cluster 保持无裂缝连接，所需数据按需流入内存。Nanite 使用自己的 rendering pass，并绕过传统逐对象 draw-call 路径。[同一 Nanite 官方文档](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine)

因此 Nanite 至少把下列问题组成一个闭环：

```text
离线构建 hierarchical clusters + 压缩数据
                │
运行时按需 streaming / residency
                │
GPU 细粒度可见性 + screen-dependent automatic LOD
                │
Nanite 专用 raster/material integration
                │
调试视图、Fallback 与平台能力边界
```

当前 `reconstructed` 已具备 Meshoptimizer meshlet、实例/meshlet 两级 HZB、GPU work generation、Indirect Draw 和 Visibility Buffer，这是“GPU 决定画哪些 meshlet”的坚实部分；但固定大小 meshlet 表加剔除并不自动等于 Nanite。Nanite 更关键的差异是**cluster hierarchy、连续误差驱动 LOD、压缩/streaming/residency 和专用渲染路径的共同设计**。所以演进优先级通常应是补齐层级几何与误差选择，再依据规模加入 streaming，而不是先模仿 Nanite 的品牌术语或直接替换现有硬件 Visibility Raster。

Nanite 也不是“无限几何”。官方页面仍要求按实例数、每网格三角形、材质复杂度、输出分辨率和目标硬件实测，并列出 Forward Rendering、VR stereo、MSAA、部分材质/变形等当前限制；这些支持项随 UE 版本快速变化，不能脱离版本复制一张永久功能表。[UE 5.8：Nanite 的 Supported Features/Platforms](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine)

### 6. Virtual Shadow Maps：把阴影纹理也做成按需虚拟资源

VSM 是为 Nanite 高密度几何和大型动态场景设计的高分辨率 shadow mapping 路径。UE 5.8 的实现把每张 VSM 看成虚拟分辨率 `16K × 16K` 的 shadow map，拆成 `128 × 128` pages；系统分析 depth buffer，只分配和渲染当前屏幕着色所需的 page。Directional Light 进一步使用 clipmap。[UE 5.8：Virtual Shadow Maps](https://dev.epicgames.com/documentation/en-us/unreal-engine/virtual-shadow-maps-in-unreal-engine)

Page 会跨帧缓存，直到移动的 light 或 geometry 等事件使其失效。官方特别指出，缓存复用是维持性能的关键；任意光源移动/旋转会使该灯的缓存 page 全部失效，shadow caster 的移动、增删和 WPO/PDO 等顶点位置变化会使重叠 page 失效。[同一 VSM 官方文档的 Caching 章节](https://dev.epicgames.com/documentation/en-us/unreal-engine/virtual-shadow-maps-in-unreal-engine)

VSM 和 HZB 都利用层级/稀疏性，但解决的问题不同：

- HZB 回答“相机看得到这个实例或 meshlet 吗”；
- VSM page marking 回答“为当前可见像素计算阴影，需要 light-space 虚拟图的哪些页”；
- VSM cache invalidation 回答“上一帧的哪些阴影页还能复用”。

因此当前引擎已有 previous-frame HZB 和 second-chance 补绘，并不意味着已有 VSM。若要称为等价虚拟阴影路径，至少还要看到 virtual address/page table、需求标记、物理 page pool、按灯/clipmap 的 LOD、caster 工作压缩、跨帧 cache 与精确 invalidation。

### 7. Unreal 路线相对当前引擎的优缺点

| 维度 | Unreal Engine 的主要优势 | 相对当前 `reconstructed` 的代价或限制 |
|---|---|---|
| CPU 架构 | Game/Render/RHI 所有权与命令流适合大型场景和复杂编辑器 | 跨线程镜像、fence、延迟释放和一两帧流水延迟显著增加正确性难度 |
| Render Graph | RDG 将资源 alias、barrier、async compute、并行录制、校验和 Insights 集成起来 | API 和调试模型复杂，Pass 必须遵守 RDG 资源生命周期与参数声明规则 |
| 图形后端 | RHI 支撑多平台原生图形 API 与主机平台 | 后端、驱动 workaround 和平台矩阵本身是巨大维护系统；当前 WebGPU 路线简单得多 |
| GPU-Driven 几何 | Nanite 把 cluster hierarchy、自动 LOD、streaming 和专用渲染路径产品化 | 资产构建、磁盘/显存 residency、材质和平台限制绑定成整套系统，不能低成本拆出一个类复制 |
| 阴影 | VSM 与 Nanite/Lumen/动态大世界配套，按需分配并跨帧缓存 | 动态失效可造成高开销；物理 page 管理、clipmap、调试和非 Nanite caster 都很复杂 |
| 通用引擎能力 | World、编辑器、动画、物理、网络、资产烘焙、分析工具和渲染形成成熟闭环 | 代码规模、编译时间、硬件要求和概念数量远高于面向研究的专用 WebGPU 引擎 |
| 可研究性 | 获得许可后能阅读和修改大量完整引擎源码，第一方文档/演讲丰富 | 源码受 Epic EULA 约束，不是可随意再许可的 permissive open-source 项目 |

### 8. Unreal 的版本与源码许可边界

- 本节页面在核实日显示为 **Unreal Engine 5.8 Documentation**。Nanite、VSM、RDG 与 RHI 都持续演进，尤其是支持平台、材质/变形限制、ray tracing、raster 路径和 console variable；面向 UE 5.3、5.5、5.8 或未来版本的结论不能混写。
- Unreal Engine 源码可通过 Epic 关联的 GitHub 账户获取，授权用户可以查看和修改；访问、分享和发布受 Unreal Engine EULA 约束。[Epic 官方：Downloading Source Code，UE 5.6](https://dev.epicgames.com/documentation/en-us/unreal-engine/downloading-source-code-in-unreal-engine?application_version=5.6) 因而它比 Unity 原生核心更容易做逐源码研究，但不应称为 MIT/Apache 这类开放源代码许可。
- 官方架构文档能证明 Game/Render/RHI 的契约和 RDG/Nanite/VSM 的公开设计，却不能证明每个平台闭源驱动、主机 SDK 或特定厂商扩展内部如何实现。本文也不会用 Epic 的“数量级提升”等产品表述代替在用户目标场景、目标 GPU 上的 profiling。

## Godot：Node/Scene 易用层、Server 底层和 RenderingDevice

### 1. SceneTree、Scene 与 Node

Godot 的主世界模型是 Node 层级。可复用的 Node 子树保存为 Scene，运行时由 `SceneTree` 管理节点层级、当前 Scene、Group、暂停和切换场景；`SceneTree` 同时是默认 `MainLoop`，因此它不仅是容器，也负责游戏循环。[Godot 4.7：Nodes and Scenes](https://docs.godotengine.org/en/stable/getting_started/step_by_step/nodes_and_scenes.html) · [`SceneTree`](https://docs.godotengine.org/en/stable/classes/class_scenetree.html)（核实：2026-08-23）

```text
SceneTree / MainLoop
└─ Window / current scene
   └─ Node
      ├─ Node2D / Control
      └─ Node3D
          ├─ MeshInstance3D
          ├─ Camera3D
          └─ Light3D
```

这种设计把组合、生命周期回调、父子变换、编辑器可视化和序列化统一起来，适合教学、工具开发和以场景组合为中心的游戏。它不是纯 ECS：Node 同时包含身份、数据和行为。Godot 的官方 FAQ 也明确讨论了为什么不强制 ECS/DOD；项目仍可在热点处使用数组、MultiMesh、Server API 或 GDExtension 构建数据导向子系统。[Godot FAQ：Does Godot use an ECS?](https://docs.godotengine.org/en/stable/about/faq.html#does-godot-use-an-ecs-entity-component-system)（核实：2026-08-23）

当前 `Node3D`/`Scene` 与 Godot 表面上相似，都有父子树和 Scene 收集；区别是 Godot 的 Node 生态还包括完整的通知、信号、Group、脚本生命周期、编辑器序列化、2D/UI、物理和插件。当前工程的 Node 层更像向 GPU Scene 提供数据的轻量 front-end。

### 2. Server 与 RID：高层 Scene 可以绕过

Godot 的重要架构特点是：Scene system 建在低层 Servers 上，而不是低层系统只能从 Node 进入。`RenderingServer`、`PhysicsServer2D/3D`、`AudioServer` 等以不透明 `RID` 访问内部资源；官方性能文档明确说 Scene system 可以被完全绕过，适用于节点/对象层本身成为瓶颈的数万实例场景。[Godot 4.7：Optimization using Servers](https://docs.godotengine.org/en/stable/tutorials/performance/using_servers.html)（核实：2026-08-23）

`RenderingServer` 是“所有可见内容”的引擎级后端：它仍然理解 viewport、scenario、canvas、mesh、light 等 Godot 渲染概念；它可以绕过 Node，但不是 Vulkan 风格的命令 API。[`RenderingServer`](https://docs.godotengine.org/en/stable/classes/class_renderingserver.html)（核实：2026-08-23）

```text
Node / Resource convenience layer
          │ owns/updates RID
          ▼
RenderingServer ── viewport / scenario / instance / mesh / light
          │
Renderer implementation
          │
RenderingDevice ── buffer / texture / pipeline / draw-compute list
          │
Vulkan / D3D12 / Metal
```

这条分层对当前工程很有启发：公开 `Mesh`/`Scene` 可以保持简单，同时把稳定 GPU record handle、resource registry 和 draw list 作为独立深模块。目前 `SceneDatabase` 已经承担类似“opaque handle + GPU table”的部分职责，但还没有像 Godot Server 那样成为跨渲染、物理、音频等通用运行时边界。

### 3. RenderingDevice 和图形后端

`RenderingDevice` 是 Godot 面向现代低层图形 API 的抽象，比 `RenderingServer` 更低层，可直接创建 buffer、texture、uniform set、pipeline 和 compute/draw list；官方文档称它用于减少支持多个低层 API 时的重复，也可供项目运行 compute shader。[`RenderingDevice`](https://docs.godotengine.org/en/stable/classes/class_renderingdevice.html)（核实：2026-08-23）

Godot 4.7 的内部渲染文档给出了准确边界：

- Forward+ 是 clustered forward renderer；Mobile 是为 tile-based/mobile GPU 约束设计的 forward 路径；Compatibility 面向旧/低端硬件。
- Forward+ 和 Mobile 建在 `RenderingDevice` 上，可使用 Vulkan、D3D12、Metal；Compatibility 使用 OpenGL ES 3/OpenGL 3.3/WebGL 2，不经过 RenderingDevice。
- Godot 官方把 RenderingDevice 的抽象层级类比 WebGPU，并强调渲染贡献者通常不需直接写 Vulkan/D3D12/Metal。

来源：[Godot 4.7 Internal rendering architecture](https://docs.godotengine.org/en/stable/engine_details/architecture/internal_rendering_architecture.html) · [Overview of renderers](https://docs.godotengine.org/en/stable/tutorials/rendering/renderers.html)（核实：2026-08-23）。

因此 Godot 的 `RenderingDevice` 和当前 WebGPU 的概念层级接近，但产品边界不同：Godot 自己维护多原生后端并在其上实现三套 rendering methods；当前工程只有一套 WebGPU renderer，直接获得浏览器的跨平台实现。

### 4. Godot 相对当前工程的优缺点

| 维度 | Godot 的主要优势 | 相对 `reconstructed` 的代价或差异 |
|---|---|---|
| 世界模型 | Scene/Node、Signal、Group、编辑器和资源序列化高度一致 | Node 大量细粒度对象在极端规模下可能成为 CPU/内存开销，需转向 MultiMesh/Server/自定义数据 |
| 分层 | 高层 Node 可逐步下沉到 Server/RID，再到 RenderingDevice | 多套 renderer/driver 和兼容矩阵增加长期维护与测试成本 |
| 图形 API | Vulkan/D3D12/Metal + OpenGL/WebGL 兼容路径广 | 最低端兼容性会限制统一采用某些 compute/storage-heavy 算法 |
| GPU-Driven | 有自动 Mesh LOD、occlusion、instancing 等产品能力 | 官方默认渲染架构并不等同于当前的 Meshlet 两级 HZB + Visibility Buffer 工作链 |
| 可研究性 | MIT 开源，场景到各图形驱动可沿源码追踪 | C++ 代码规模远大于当前 TypeScript renderer，迭代反馈更重 |
| 使用场景 | 独立游戏、2D/3D、编辑器驱动开发和广平台发布 | 若唯一目标是实验 WebGPU GPU work generation，完整引擎层会分散注意力 |

### 5. 版本风险

本节固定在核实日的 **Godot 4.7 stable 文档**。D3D12 在早期 4.x 曾是实验路径，Metal、渲染方法和平台组合也持续变化；不要把 4.2/4.3 教程中的驱动状态当成 4.7 永久事实。Godot 是 MIT 开源，可用 [官方源码仓库](https://github.com/godotengine/godot) 核对实现，但平台 SDK/第三方库仍各有许可与版本约束（核实：2026-08-23）。

## Bevy：ECS/App/Plugin 驱动的 Rust 引擎与 wgpu 渲染器

### 1. App、World、Schedule 和 Plugin

Bevy 的中心不是 Node 树，而是 ECS `World`。Entity 是身份，Component 是数据，System 查询并处理匹配数据；`App` 建立主生命周期并保存一个或多个 `SubApp`，`Plugin` 向 App 注册资源、systems、schedules 和其他插件。官方 API 特别说明 Bevy 把模块化作为核心原则，连 rendering 这种复杂功能也是插件。[Bevy 0.19.1 `App`](https://docs.rs/bevy/0.19.1/bevy/app/struct.App.html) · [`Plugin`](https://docs.rs/bevy/0.19.1/bevy/app/trait.Plugin.html) · [官方 ECS quick start](https://bevy.org/learn/quick-start/getting-started/ecs/)（核实：2026-08-23）

```text
App
├─ Main World
│  ├─ Entities / Components / Resources
│  └─ Schedules → Systems（按数据访问并行）
├─ Plugins（组合引擎与游戏功能）
└─ SubApps
   └─ RenderApp / Render World
```

优势是数据访问声明同时服务正确性和并行调度，插件可以把功能完整封装；代价是使用者必须理解 ECS 数据流、schedule ordering、deferred commands、change detection 和跨 World 同步。当前工程没有通用 ECS/scheduler/plugin contract，更新和渲染主要由 `Renderer.render()` 的固定流程组织。

### 2. Main World 与 Render World：Extract 边界

Bevy renderer 运行在 `RenderApp` 这个 SubApp 中，render world 与 main/app world 分离。`ExtractSchedule` 把渲染所需组件/资源从 app world 复制或转换到 render world；`ExtractComponent` 的官方定义正是“在 ExtractSchedule 中从 app world 传到 render world”。[Bevy 0.19.1 `RenderPlugin` 源码](https://github.com/bevyengine/bevy/blob/v0.19.1/crates/bevy_render/src/lib.rs) · [`ExtractComponent`](https://docs.rs/bevy/0.19.1/bevy/render/extract_component/trait.ExtractComponent.html)（核实：2026-08-23）

Native 平台可启用 `PipelinedRenderingPlugin`，把 render app 移到独立线程，使第 N 帧渲染与第 N+1 帧 simulation 并行；官方 API 明确标注它不用于 WebAssembly，并描述 sync → extract → apply extract commands → rendering schedule 的边界。[Bevy 0.19.1 `PipelinedRenderingPlugin`](https://docs.rs/bevy/0.19.1/bevy/render/pipelined_rendering/struct.PipelinedRenderingPlugin.html)（核实：2026-08-23）

这与 UE 的 render proxy 思路在目的上相似：不要让 GPU command encoding 直接读取正在变化的 gameplay world。当前工程已有 CPU scene → `SceneDatabase`/GPU tables 的同步，却没有独立 render world、通用 extract trait 或 simulation/render CPU pipeline。若未来加入复杂 gameplay，Bevy 的“明确快照边界”比直接把 ECS 原样搬入引擎更值得先借鉴。

### 3. Extract / Prepare / Queue / Render 到底是什么

常见 Bevy 教程把渲染阶段概括成：

```text
Extract：把 main world 所需数据送到 render world
Prepare：生成/上传 GPU-ready resources
Queue：把可绘制项放入 render phases，选择/专门化 pipeline
PhaseSort / Batch：排序、合批和生成工作
Render：执行相机/阴影/后处理等渲染
Cleanup：回收临时渲染状态
```

但**不要把旧阶段顺序当成 0.19 的精确 API**。Bevy 0.19.1 的 `RenderSystems` 当前列出 `ExtractCommands → PrepareAssets → PrepareMeshes → CreateViews → Specialize → PrepareViews → Queue/QueueMeshes → PhaseSort → Prepare/PrepareResources/PrepareBindGroups → Render → Cleanup`。也就是说“Extract-Prepare-Queue-Render”仍是有用的职责词汇，实际 schedule/set 顺序已进一步细分，并出现 Queue 在部分 Prepare 之前的安排。[Bevy 0.19.1 `RenderSystems` 源码](https://github.com/bevyengine/bevy/blob/v0.19.1/crates/bevy_render/src/lib.rs)（核实：2026-08-23）

### 4. Bevy 0.19 的 RenderGraph 已经换了含义

Bevy 0.18 及更早版本的许多资料使用 Node/edge RenderGraph。**Bevy 0.19 已将该架构替换为 ECS schedules**：render pass 是 render world 中的普通 systems，`renderer::RenderGraph` 现在是驱动整套渲染的 root schedule label，而不是旧的节点图容器。官方 0.19 发布说明明确说明替换原因是成熟 ECS Schedule 已足以表达 render graph pattern。[Bevy 0.19 release：Render Graph as Systems](https://bevy.org/news/bevy-0-19/#render-graph-as-systems) · [`renderer::RenderGraph`](https://docs.rs/bevy/0.19.1/bevy/render/renderer/struct.RenderGraph.html)（核实：2026-08-23）

当前工程 `FrameGraph` 仍是显式 Pass/resource graph：`read/write` 建资源版本和引用，compile 可裁掉无消费者且无 side effect 的 Pass，并确定 transient resource 最后使用点；execute 则按添加顺序运行可执行 Pass，当前源码中没有发现依赖拓扑重排、subresource barrier 规划或多队列调度。这并不比 Bevy schedule “过时”，只是两种表达方式：

- Bevy 0.19 复用 ECS dependency/scheduling，让插件作者使用统一 system 模型；
- 当前 FrameGraph 的显式资源句柄更容易表达 transient texture/buffer 生命周期；
- 若需要 RDG 级 alias/barrier/async compute，二者都必须有更深的资源与后端集成，改名不会自动获得能力。

### 5. wgpu 与 Bevy 的 GPU-Driven 能力

Bevy 默认渲染后端基于 `wgpu`，代码通过 `RenderDevice`/`RenderQueue` 等资源持有 wgpu 的 Device/Queue/Adapter。wgpu 再选择 Vulkan、Metal、DX12、Browser WebGPU 等后端，因此 Bevy 的 RHI/GAL 角色主要由 wgpu 承担，而 Bevy 在其上提供资产、pipeline cache、render phases 和 ECS scheduling。[Bevy 0.19.1 renderer source](https://github.com/bevyengine/bevy/blob/v0.19.1/crates/bevy_render/src/renderer/mod.rs) · [wgpu `Backends`](https://docs.rs/wgpu/30.0.0/wgpu/struct.Backends.html)（核实：2026-08-23；wgpu 独立版本演进，不表示 Bevy 0.19 固定依赖 wgpu 30）

Bevy 标准 renderer 也有 GPU preprocessing：`GpuPreprocessingMode::Culling` 表示 compute + indirect draw + GPU culling，且官方 API 标成默认模式。它说明 Bevy 并非只能 CPU 逐对象 draw，但这仍不能直接等同于当前 Meshlet Visibility 链。[Bevy 0.19.1 `GpuPreprocessingMode`](https://docs.rs/bevy/0.19.1/bevy/render/batching/gpu_preprocessing/enum.GpuPreprocessingMode.html)（核实：2026-08-23）

更接近当前工程的是 crate feature `meshlet` 下的**实验性** `MeshletPlugin`：官方 API 描述它对高密度网格做单 Meshlet 剔除、遮挡剔除、单 draw batching 和近乎无缝 LOD，但明确列出更高基础开销、预处理/材质限制、需要 `TEXTURE_INT64_ATOMIC`、当前仅 Vulkan/Metal 后端、与 MSAA 不兼容等边界。[Bevy 0.19.1 `MeshletPlugin`](https://docs.rs/bevy/0.19.1/bevy/pbr/experimental/meshlet/struct.MeshletPlugin.html)（核实：2026-08-23）

因此比较不能写成“Bevy 不 GPU-Driven”或“Bevy 已完全等于 Nanite”：标准 renderer 有 GPU preprocessing，实验插件有更激进的 Meshlet 路径，但平台和功能约束与当前直接 WebGPU 的实现不同。

### 6. Bevy 相对当前工程的优缺点

| 维度 | Bevy 的主要优势 | 相对 `reconstructed` 的代价或差异 |
|---|---|---|
| Gameplay/CPU | ECS、并行 System、Schedule、Plugin 组成统一模型 | 学习曲线和 system ordering 较高；不是所有对象逻辑都天然适合纯 ECS |
| Render 隔离 | Main/Render World + Extract + 可选 native render thread 边界清晰 | Extract 会复制/转换状态并引入一帧流水线思维；Wasm 没有该 pipelined plugin |
| 可扩展性 | Render feature 能通过 Plugin、systems、resources 组合 | 0.x API 演进快，渲染阶段和 RenderGraph 在 0.19 已有重大变化 |
| 图形后端 | wgpu 覆盖 native 多后端和 Web | wgpu 公共能力与后端差异仍需 feature/limit 分支；额外抽象并非零成本 |
| GPU-Driven | 标准 GPU preprocessing + 实验 MeshletPlugin 可选择 | 实验 Meshlet 路径当前 Vulkan/Metal 和硬件特性限制强；不等于默认通用路径 |
| 当前工程特长 | 可借 Bevy ECS/Plugin 管好非渲染系统 | 若只研究 Visibility/HZB，当前固定 TypeScript 管线更短、更容易逐 Shader 定位 |

### 7. 版本风险

本节固定 **Bevy 0.19.1**。Bevy 仍是 0.x，渲染扩展点、schedule 名称、meshlet feature 与 wgpu 版本都可能快速变化；代码应锁定 Bevy crate 版本并读该版本 docs.rs/source，不应把 0.12～0.18 的 RenderGraph 教程直接应用于 0.19。

## 当前 `reconstructed`：它已经有哪些引擎层

### 1. 精确定位与源码边界

本节依据 2026-08-23 的本地源码，不把 README 目标当成已实现事实。包描述为 “A WebGPU renderer focused on GPU-driven visibility and modern real-time rendering”，公开入口集中在 [`src/index.ts`](../reconstructed/src/index.ts)，并没有 Editor、Physics、Audio、Networking 或通用 Gameplay Plugin/Job API。

```text
Public API / loaders / scene objects
       │
Node3D / Scene / Mesh / Light / Camera / Animation
       │
GPUSceneManager / GPUSceneContext / SceneDatabase
       │
FrameGraph + Renderer passes
       │
Meshlet cull/work generation → Visibility Buffer → Material Expand
       │
Clustered lighting / IBL / SSR / OIT / temporal / post
       │
GraphicsContext → browser WebGPU GPUDevice / GPUQueue
```

### 2. Scene front-end 不是 ECS

[`Node3D.ts`](../reconstructed/src/scene/Node3D.ts) 保存 parent/children、local/global transform 并递归传播矩阵；[`Scene.ts`](../reconstructed/src/scene/Scene.ts) 把 Node 收集成 instances、lights、probe volume 和 volumetrics。它与 Godot 的 Node 树有相似外观，但没有 Godot 的完整 MainLoop/notification/group/editor contract，也不是 Bevy archetype ECS。

优点是对象模型小、容易从 loader 创建并理解；缺点是大规模 gameplay 更新、并行 query、change tracking、跨线程所有权和通用系统组合没有统一基础设施。不要为了“现代”立即把它改成 ECS；先确认引擎是否真的要承载复杂 gameplay，而不是作为 renderer 被外部宿主驱动。

### 3. WebGPU 初始化和 `GraphicsContext`

[`Renderer.initialize()`](../reconstructed/src/render/Renderer.ts) 在自动创建设备的路径中直接调用 `navigator.gpu.requestAdapter({ powerPreference: "high-performance" })` 与 `adapter.requestDevice()`，也允许调用方注入 `GPUDevice`/`GPUCanvasContext`。自动创建设备路径当前硬性请求：

- `timestamp-query`
- `indirect-first-instance`
- `float32-blendable`
- 每 shader stage 至少 10 个 storage buffers
- `maxColorAttachmentBytesPerSample = 32`

如果 Adapter 支持，还请求 `subgroups` 与 `texture-formats-tier1`。这比“浏览器支持 WebGPU”更严格，必须把 capability failure 作为真实平台矩阵管理。

[`GraphicsContext.ts`](../reconstructed/src/gpu/GraphicsContext.ts) 直接持有 `GPUDevice`，组织 buffer/texture allocator、staging、pipeline/layout/bind group cache、Meshlet table、material/texture/sampler manager。它是很有价值的 GPU 服务 façade，但 WebGPU 类型穿透到各 Pass，因此不是 Unity/UE/Godot 那种多后端 RHI。Device lost 回调当前只设置 `_deviceLost` 并在非主动销毁时记录错误；源码中未见完整的资源重建和恢复状态机。

### 4. FrameGraph 能力应准确描述

[`FrameGraph.ts`](../reconstructed/src/framegraph/FrameGraph.ts) 有逻辑资源版本、Pass read/write/create、无消费者 Pass culling、transient buffer/texture obtain/release 和 debug 图信息；[`ShadeGPUCommandContext.ts`](../reconstructed/src/framegraph/ShadeGPUCommandContext.ts) 负责 WebGPU command encoder、pass 和 submit。

当前 `compile()` 主要计算引用、producer 和最后使用点，`execute()` 按 Pass 添加顺序执行；没有在本地实现中找到 UE RDG 那种 subresource state/barrier 规划、transient memory alias、async compute queue 调度或并行 command-list recording。因此文档称其为“实用的 WebGPU FrameGraph”，不称其已与 RDG/Unity Render Graph 功能等价。

### 5. GPU-Driven Visibility 是当前最深的模块

主链由 [`GPUSceneContext.ts`](../reconstructed/src/gpu/GPUSceneContext.ts)、[`SceneDatabase.ts`](../reconstructed/src/gpu/SceneDatabase.ts)、[`MeshletGpuTable.ts`](../reconstructed/src/gpu/MeshletGpuTable.ts)、[`MeshletDrawList.ts`](../reconstructed/src/gpu/MeshletDrawList.ts) 和 [`VisibilityPass.ts`](../reconstructed/src/render/passes/VisibilityPass.ts) 组成：

```text
CPU Scene → stable GPU tables
    │
GPU mesh/instance filtering + material/render-state buckets
    │
instance frustum/HZB dual cull
    │
mesh → meshlet counts + prefix scan + expansion
    │
meshlet frustum/HZB dual cull
    │
GPU indirect arguments
    │
hardware raster → Triangle ID + Mesh ID + reverse-Z Depth
    │
current-frame HZB second chance 补绘
    │
Material Expand → GBuffer → lighting/post
```

与 Godot/Unity 的通用实例 batching、Bevy 标准 GPU preprocessing 相比，这条 Meshlet/Visibility 链更专门；与 UE Nanite、Bevy 实验 MeshletPlugin 相比，它已经有细粒度 GPU work generation，但当前主 Visibility 链没有核实到 Nanite 式 cluster hierarchy、连续 geometric error LOD、virtualized geometry streaming/residency。详细算法和限制见 [GPU-DRIVEN-COMPARISON.md](GPU-DRIVEN-COMPARISON.md)。

### 6. 完整 Deferred/时序管线

[`Renderer.ts`](../reconstructed/src/render/Renderer.ts) 编排 Visibility、Material Expand、Velocity、light clustering/direct lighting、SSAO、IBL/LPV/Brick4、SSR、transparent OIT、TAA/NSS、motion blur、bloom、automatic exposure 和 tonemap。这说明它远超单个 GPU-Driven demo；但“渲染功能丰富”仍与“完整游戏引擎”不同：缺少编辑器、内容烘焙、统一插件生命周期、CPU job/simulation、物理音频网络和产品级平台发布。

## 横向总对比

### 1. 完整引擎能力

| 维度 | Unity | Unreal Engine | Godot | Bevy 0.19 | `reconstructed` |
|---|---|---|---|---|---|
| 主要世界模型 | GameObject/Component；可选 Entities ECS | UObject/Actor/Component + World | SceneTree/Node/Scene | ECS World/Entity/Component/System | Node3D/Scene 轻量对象树 |
| 调度/并行 | Player loop + Jobs/Burst；DOTS schedules | Game/Render/RHI ownership + task systems | MainLoop + engine servers/threads | ECS schedules/task pools；native 可 pipelined render | JS frame loop + 固定 Renderer 编排；无通用 Job System |
| 插件/模块 | Package、SRP、Editor tooling | Module/Plugin、Build Tool、反射 | Plugin/GDExtension/module | Plugin 是核心组合单元 | 类/模块导出；无统一 Plugin 生命周期 |
| Editor/资产 | 成熟商业编辑器/import/build/profiler | 重型 AAA editor/cook/stream/profile | 完整开源 editor/import/export | 代码优先，编辑器生态仍发展 | 无编辑器；有 glTF/USD/自定义 loader |
| 物理/音频/网络 | 完整 | 完整 | 完整 | 生态/插件组合，成熟度按子系统不同 | 未提供通用系统 |
| 典型适用 | 多平台商业 2D/3D、移动/主机 | 高端 3D、AAA、大世界/影视 | 独立游戏、2D/3D、开源定制 | Rust/data-oriented、代码驱动项目 | WebGPU 渲染研究、定制 renderer/library |

### 2. 渲染与底层 API

| 维度 | Unity | Unreal Engine | Godot 4.7 | Bevy 0.19 | `reconstructed` |
|---|---|---|---|---|---|
| 渲染 front-end | Built-in/URP/HDRP/custom SRP | Engine Renderer + feature modules | RenderingServer + Forward+/Mobile/Compatibility | RenderApp + render phases/systems/plugins | 固定 Renderer + Pass classes |
| 帧图 | SRP Render Graph | RDG | 渲染器内部组织；RenderingDevice 不是帧图 | 0.19 改为 ECS schedule “Render Graph as Systems” | 显式资源版 FrameGraph |
| RHI/GAL | Unity native low-level graphics architecture | RHI + per-platform backends | RenderingDevice；OpenGL Compatibility 特例 | wgpu | 直接 WebGPU + GraphicsContext façade |
| 图形 API | D3D/Metal/Vulkan/OpenGL，按平台 | D3D/Vulkan/Metal/主机后端，按版本平台 | Vulkan/D3D12/Metal；OpenGL/WebGL compatibility | wgpu → Vulkan/Metal/DX12/Browser WebGPU/GL | 浏览器 WebGPU |
| GPU Scene | 引擎内部 + SRP/BRG/DOTS 等路径 | Render proxies/scenes + Nanite 等系统 | RenderingServer resource/instance/RID | Render World + extracted/prepared GPU data | 显式 SceneDatabase 与多个 GPU resident tables |
| GPU-Driven | 可由 SRP/BRG/Compute/indirect 建设，具体管线不同 | Nanite 是产品化代表 | 有 instancing/LOD/occlusion，但不是同一 Meshlet Visibility 架构 | 默认 GPU preprocessing；实验 MeshletPlugin | 核心定位：两级 HZB、prefix/compaction、indirect、Visibility Buffer |
| 几何虚拟化 | 不应仅凭通用 Unity 名称推定 | Nanite cluster hierarchy/streaming/LOD | 自动 LOD，不等同 Nanite | 实验 Meshlet LOD 路径，有限制 | 当前无已核实的 cluster hierarchy/virtual streaming |

### 3. 优缺点不能脱离目标

| 目标 | 更合适的起点 | 原因 |
|---|---|---|
| 现在做一款多平台商业游戏 | Unity/Godot/UE，按团队和内容选 | 完整工具、资产、输入、物理、音频、发布链比单项渲染算法更关键 |
| 高端大场景、虚拟化几何、成熟主机管线 | Unreal Engine | Nanite/VSM/RDG/RHI 和内容工具形成闭环，代价是复杂与重量 |
| 开源、易上手、2D/中型 3D、需要改 C++ 底层 | Godot | Node/Scene 易用、Server 可下沉、源码和编辑器完整 |
| Rust、ECS/data-oriented、希望高度模块化 | Bevy | App/Plugin/Schedule/Render World 统一，需接受 0.x 演进和工具成熟度 |
| WebGPU、GPU-Driven/Visibility 算法研究 | `reconstructed` | 代码短路径、直接 WGSL/WebGPU、现有 Meshlet/HZB/Deferred 基础深 |
| 自己拥有完整原生 RHI/主机平台能力 | UE 或专门自研团队 | 这是多年持续维护工作，不应从“加一个接口”开始估算 |

## 对当前工程的具体建议

### P0：先把定位写死，避免错误扩张

建议公开描述为“WebGPU GPU-Driven renderer/core library”，并明确宿主负责哪些能力。若产品目标仍是 renderer，就不需要为了看起来像 Unity/UE 而加入 Physics、Audio 或通用 ECS；应优先稳定渲染公共 API、资源生命周期、错误处理和 profiling。

### P1：建立 App World → Render World 的显式同步契约

借鉴 Bevy Extract、UE render proxy 和 Unity culling/input snapshot 的共同思想：

- gameplay 对象不能被编码 GPU 命令的代码任意读取；
- 变换、Mesh、材质、灯光用 dirty/version 增量同步；
- GPU table row 的创建、更新、删除和延迟释放有清晰所有者；
- 记录本帧 snapshot/previous-frame 数据的时间边界。

不必先加线程。即使都在一个 JS thread，明确 ownership 和 extract 阶段也能减少动画、Visibility、Velocity、second chance 之间的时序错误。

### P2：深化 FrameGraph，而不是只增加 Pass 数量

按需求逐步增加：

1. compile 后的 dependency/order 校验，检测“依赖添加顺序”的隐式假设；
2. texture subresource、usage/state 的验证；
3. transient descriptor 兼容性和实际复用统计；
4. Pass/resource graph dump、GPU timestamp 和每 Pass 显存生命周期视图；
5. 若未来 native backend 真能利用，再评估 async compute/multi-queue，不在浏览器能力不支持时预先抽象。

Unity Render Graph/RDG 值得学的是正确性工具和观测能力，不是 API 命名。

### P3：把 capability profile 变成一等产品配置

当前 `timestamp-query`、`indirect-first-instance`、`float32-blendable` 和 storage buffer 限制会直接决定设备能否启动。建议：

- 启动时输出结构化 Adapter/Device capability report；
- 区分真正渲染必需与仅 profiling 必需的 feature，评估 `timestamp-query` 是否应有降级；
- 为 optional subgroups/tier1 写明确 shader/pipeline variant；
- 增加 Device Lost 后的停止、通知、资源重建或页面重载策略；
- 建立浏览器/GPU/驱动回归矩阵。

这是当前直接 WebGPU 路线比“虚构一层 RHI”更急迫的问题。

### P4：补齐 GPU 几何层级与流送前，先建立数据

借鉴 Nanite/Bevy meshlet/three.js 示例时，优先顺序仍应是：

1. Meshlet 屏幕尺寸、候选/可见量、HZB 各阶段命中、second-chance、带宽和 primitive setup 统计；
2. GPU screen-space error LOD；
3. 带 geometric error 的 cluster hierarchy；
4. 只有资产规模证明显存/上传是瓶颈时，再设计 virtual geometry streaming/residency；
5. Compute software rasterizer 仍应最后按硬件 profile 决定。

Nanite 的价值来自闭环，不是单独使用 “cluster” 一词。

### P5：建立 Render Feature/Plugin 边界，但不要让核心管线碎片化

可借 Bevy Plugin、Unity SRP feature 和 UE module 的思路，为 SSAO/SSR/Bloom/Indirect Lighting 等建立统一生命周期：

```text
initialize(graphics)
resize(view/output)
extract-or-prepare(frame state)
registerPasses(frameGraph, inputs) -> outputs
destroy()
```

Visibility、Material Expand、Depth/HZB 这类紧耦合核心仍可保持深模块；可选后处理和调试功能适合插件化。目标是减少 `Renderer` 总控膨胀，同时保持一眼能看懂的一帧主干。

### P6：如果目标升级为“完整游戏引擎”，再单独立项

完整引擎至少还需要：

- input/window/app lifecycle；
- fixed update、simulation scheduler/jobs；
- gameplay serialization/prefab、反射或 schema；
- physics/audio/UI/navigation/network；
- asset database、import/cook/cache/hot reload；
- editor、profiler、debug capture、build/export；
- native/console platform policy 与测试矩阵。

这些工作与优化 Visibility Pass 是不同产品路线。应先决定是“renderer 被别的引擎/应用嵌入”，还是“自己拥有完整 runtime/editor”，再选 Bevy ECS、Godot Node/Server 或自定义混合模型。

## 不建议直接照搬的架构

- **不为 WebGPU-only 目标自研 Vulkan/D3D12/Metal RHI**：浏览器 WebGPU 已承担关键跨平台契约；先把 WebGPU capability/recovery 做扎实。
- **不照搬 UE 三线程类名**：浏览器与 C++ 主机的线程/队列条件不同；先定义数据所有权和 snapshot，再决定 Worker 或 native thread。
- **不因 Bevy 流行就重写为 ECS**：ECS 解决大规模 CPU 数据与调度；若宿主只需要 renderer，当前 Node + GPU database 可能更深、更简单。
- **不把 RenderGraph 当 GPU-Driven**：Pass dependency 再先进，也不会自动生成 LOD、cull 或 indirect work。
- **不把普通 Meshlet culling 称为 Nanite**：缺少 hierarchy、error metric、streaming/residency 时应使用准确术语。
- **不推断 Unity/UE 闭源部分**：官方接口和公开源码能证明契约，不能证明所有平台内部实现或性能结论。

## 版本、证据和复核方法

### 外部基线

| 项目 | 本文基线 | 一手资料范围 | 变化风险 |
|---|---|---|---|
| Unity | Unity 6.0/6000.0；Burst 1.8.30；Entities 1.3.15 | Unity Manual/API、package docs、UnityCsReference/Graphics repo | Unity 6 更新版与 SRP package 可独立变化 |
| Unreal Engine | UE 5.8 文档 | Epic docs/API、授权源码获取说明 | Nanite/VSM/RDG/平台限制每版本变化快 |
| Godot | 4.7 stable | Godot docs 与 MIT 源码 | renderer/driver 状态随 4.x 变化 |
| Bevy | 0.19.1 | docs.rs 固定版本、Bevy release、v0.19.1 source | 0.x API 变化快；旧 RenderGraph 教程已过时 |
| wgpu | 架构对照使用 30.0.0 docs | docs.rs 与 gfx-rs 官方仓库 | 不代表 Bevy 固定使用同版 wgpu |
| WebGPU | 核实日 GPUWeb/W3C 规范 | WebGPU specification | 浏览器 feature/limit 支持仍随实现变化 |

所有外部链接均在 2026-08-23 核实；固定版本链接优先于 `latest`。Unity/UE 章节只把官方公开契约当事实，未知原生内部实现不参与结论。

### 本地 `reconstructed` 代码索引

- [README.md](../reconstructed/README.md)：工程定位和目录分层。
- [package.json](../reconstructed/package.json)：TypeScript/Vite/WebGPU types 构建边界。
- [index.ts](../reconstructed/src/index.ts)：当前稳定公共 API。
- [Renderer.ts](../reconstructed/src/render/Renderer.ts)：Adapter/Device、固定帧管线和 feature 编排。
- [GraphicsContext.ts](../reconstructed/src/gpu/GraphicsContext.ts)：直接 WebGPU façade、allocators/caches/managers。
- [FrameGraph.ts](../reconstructed/src/framegraph/FrameGraph.ts)：Pass/resource version、culling 和 transient 生命周期。
- [Node3D.ts](../reconstructed/src/scene/Node3D.ts) 与 [Scene.ts](../reconstructed/src/scene/Scene.ts)：轻量场景树。
- [GPUSceneContext.ts](../reconstructed/src/gpu/GPUSceneContext.ts) 与 [SceneDatabase.ts](../reconstructed/src/gpu/SceneDatabase.ts)：GPU Scene 所有权和 records。
- [MeshletDrawList.ts](../reconstructed/src/gpu/MeshletDrawList.ts)：GPU cull、scan、expand、indirect work generation。
- [VisibilityPass.ts](../reconstructed/src/render/passes/VisibilityPass.ts)：Visibility attachments、硬件 raster 和 second chance。
- [MaterialExpandPass.ts](../reconstructed/src/render/passes/MaterialExpandPass.ts)：Visibility 到 GBuffer。

复核本文时，建议先确认外部版本，再从本地 `Renderer.initialize()`、`FrameGraph.compile/execute()` 和 Visibility 主链三个入口验证；不要仅根据类名推断能力。
