# OEngine 产品级渲染管线重构设计

> 状态：**已确认设计，尚未实施**  
> 确认来源：2026-09-03 与产品方向讨论  
> 适用范围：OEngine 桌面 WebGPU、中大型高几何密度场景的渲染效果与管线重构

本文记录已确认的目标渲染架构。它描述的是目标设计，不代表当前源码已经具备这些能力。实施时必须区分目标合同、当前事实和验证证据。

## 1. 设计目标

- 面向桌面 WebGPU 和独立 GPU，不以低端设备兼容为目标。
- 以 AAA 级画质和性能优先，默认配置为“中等偏高”。
- 以 1920×1080、DPR1、60 FPS 作为开发测试基线；该基线用于测量和校准，不是运行时自动降级机制。
- 保留并强化 GPU-driven、GPU Scene、层次工作生成、Hardware-first Visibility 和 Visibility Buffer。
- 采用一条统一主管线，不创建 Core / Quality / Experimental 三套真实管线。
- 所有效果默认开启，但可通过初始化配置单独关闭或调整参数。
- Feature 关闭后不保留无消费者 Pass、资源、历史、readback 或独立 submit。
- 以画质正确性、GPU-driven 闭环、性能证据和可观测性作为完成条件。

## 2. 总体架构

```text
CPU Scene / Asset Updates
          ↓
GPU Scene + ViewContext
          ↓
GPU-driven Visibility
  (Culling / LOD / Work Generation / HW Raster)
          ↓
Visibility Buffer + Depth
          ↓
Single Material Resolve
          ↓
Unified HDR PBR Lighting
  ├─ GPU Clustered Direct Lighting
  ├─ Shadow Service
  ├─ GI Service
  ├─ Reflection Service
  └─ AO Service
          ↓
Transparency (Forward / OIT)
          ↓
Temporal Reconstruction (TAAU + DRS)
          ↓
HDR Post Processing
          ↓
Present
```

FrameGraph 是唯一的执行编排层，Render Feature 是功能接入边界。模块声明输入、输出、依赖和启用状态，由 FrameGraph 管理顺序、资源生命周期、Pass 剔除和资源复用。

## 3. 固定概念阶段

阶段边界稳定，阶段内部的 Pass 和算法可以替换：

1. **Scene Update**：GPU Scene Patch、Camera、Light、ViewContext。
2. **Visibility**：GPU Culling、LOD、Hierarchy、Raster Work、Visibility Buffer、Depth/HZB。
3. **Surface**：Material Resolve、Normal、Velocity、Surface Metadata。
4. **Lighting**：Direct Light、Shadow、GI、Reflection、AO 的统一 HDR 合成。
5. **Transparency**：Alpha Blend、粒子和其他透明对象的 Forward/OIT。
6. **Temporal**：TAAU、DRS、History、Reactive Mask 和 Disocclusion。
7. **HDR Post**：Exposure、Bloom、Color Grading、Tone Mapping。
8. **Present**：Swapchain 和最终输出。

## 4. GPU Scene 与职责边界

GPU Scene 是渲染数据的长期真相。CPU 不再每帧遍历全部对象生成最终可见列表，只负责：

- 资产上传和显式变更 Patch；
- Camera、Light、Frame 参数；
- ViewContext 创建与销毁；
- Render Feature 初始化配置；
- FrameGraph 构建和一次主提交。

GPU 负责：

- 场景驻留数据消费；
- Visibility、LOD、Hierarchy 和工作队列生成；
- Indirect Draw 参数生成；
- Material Resolve、Clustered Lighting 和屏幕空间效果。

静态几何、层次结构和烘焙数据长期缓存；动态 Transform、灯光、动画和局部变化通过 Patch 与局部缓存失效传播。不得把当前阶段扩张为完整 Gameplay/ECS 生命周期。

## 5. Visibility 与材质路径

### 5.1 Visibility

- 默认采用 Hardware-first GPU Visibility。
- GPU 生成可见性和绘制工作，硬件光栅化写入 Visibility Buffer。
- CPU 不构建最终可见对象列表。
- Compute Raster、Mesh/Task Shader、硬件光追只能作为未来可替换 Backend，不作为当前 WebGPU baseline。
- 所有 Backend 消费同一 GPU Scene 和工作队列协议。

### 5.2 Material Resolve

- Opaque 和 Alpha-Test 继续走 Visibility Buffer → Single Material Resolve。
- Resolve 输出标准 PBR Surface 数据、Normal、Velocity、AO、Emissive 和元数据。
- Material Resolve 是唯一的表面重建入口，删除每材质全屏扫描和重复 Surface 解释链。
- 当前支持 Standard Metallic-Roughness PBR、Normal、Occlusion、Emissive、Clear Coat、Sheen。
- Anisotropy、Transmission、Refraction、Subsurface、Iridescence 只保留扩展接口，不纳入本轮必做范围。

### 5.3 Transparency

- Alpha-Blend、粒子和透明对象使用独立 Forward/OIT 路径。
- 透明路径复用统一的 Light、Shadow、GI、Reflection 服务，但不强行适配 Opaque Visibility Buffer。
- 当前不实现 Transmission、Refraction 和透明对象动态 GI。

## 6. 统一 HDR PBR 光照

Material Resolve 只产生表面数据；Lighting 阶段统一合成：

```text
Surface Data
  → Direct Lighting + Shadow Visibility
  → Indirect Diffuse
  → Specular Reflection
  → AO Visibility / Bent Normal
  → HDR Lighting Result
```

禁止在最终颜色阶段用互不知情的后期 Pass 硬乘或硬覆盖光照结果。所有计算保持线性 HDR 和物理光单位，Exposure、Bloom、Color Grading、Tone Mapping 在后段统一处理。

### 6.1 Clustered Lighting

所有动态 Directional、Point、Spot（以及未来 Area）灯光由 GPU 分配到视锥 Cluster/Froxel。像素只遍历所属 Cluster 的相关灯光。Cluster overflow、灯光数量和实际遍历量必须有统计计数。

### 6.2 Shadow Service

所有灯光默认 `castsShadow = true`，内部由统一 Shadow Service 管理：

- Directional：CSM；
- Point / Spot：Shadow Atlas；
- 近距离：Contact Shadow；
- 高质量软阴影过滤；
- 阴影缓存、更新调度和失效传播。

外部不绑定 CSM、Atlas 或过滤算法；未来可替换 VSM、Virtual Shadow Maps 或硬件光追。

## 7. GI、反射与 AO 服务

### 7.1 GI Service

```text
Static GI Provider   → Lightmap
Dynamic GI Provider  → Probe Volume
```

- Lightmap 和 Probe Volume 可独立存在，不强制同时提供。
- Lightmap 保存静态间接光，不保存运行时动态直射。
- Probe Volume 负责动态灯光对静态场景的间接影响。
- Static Lightmap 可离线多次反弹；动态 Probe 以一阶传播为首版目标，后续再评估更多传播。
- 静态 Lightmap、Probe Volume 基础数据由离线 Cooker 生成；运行时只消费 GPU-ready 数据，并对受影响区域进行局部更新。

Diffuse fallback：`Lightmap → Probe Volume → IBL → 无间接光`。

### 7.2 Reflection Service

本轮只实现并固定组合：

```text
Local Reflection Probe → SSSR 修正 → IBL fallback
```

- Local Probe 是稳定基底，SSSR 使用命中置信度做局部校正，不替换整个 Probe。
- SSSR miss、低置信度、越界和粗糙表面自动回退 Probe/IBL。
- 不实现特殊材质反射路径、Planar Reflection 或透明折射。
- Probe 基础数据可离线生成；受灯光或场景事件影响时刷新受影响区域，不每帧刷新全部 Probe。

### 7.3 AO Service

首版默认使用 GTAO。AO 必须保持独立语义：

- Material AO；
- Diffuse Visibility；
- Specular Visibility；
- Bent Normal。

GTAO 不再写回并破坏 Material AO，也不能简单把 AO 乘到最终颜色。SSAO/SSDO/SSGI 只保留未来 Provider 扩展位。

## 8. Temporal Reconstruction

Temporal 是独立子系统，默认 `TAAU + DRS`，未来可替换 TSR、FSR、DLSS 等实现。

- 最终颜色、AO、Reflection/Confidence 等历史在系统内部隔离管理。
- Depth、Velocity、Reactive Mask 和 Disocclusion 参与历史决策。
- 透明、粒子和快速变化区域通过 Reactive Mask 降低历史权重。
- 摄像机切换、场景重载、重大灯光变化和输出尺寸变化会使相关历史失效。
- Temporal 不负责掩盖 AO、SSR 或材质算法错误。

## 9. FrameGraph、资源与提交

资源分为两类：

```text
Persistent：GPU Scene、Asset Tables、Lightmap、Probe、IBL、Shadow Cache、Temporal History
Transient：Visibility、Depth/HZB、Surface、AO/SSR 中间结果、Post Targets
```

Persistent 资源跨帧存在；Transient 资源只在当前 FrameGraph 中存在，由图自动管理生命周期和复用。Feature 关闭后不创建无消费者资源，也不维护无消费者 History。

默认提交模型：一个 FrameGraph、一个 CommandEncoder、一次主 Queue Submit。Feature 不拥有独立 submit 权，不主动进行 CPU 等待或 readback。未来 Async Compute 也必须由统一调度器管理。

## 10. ViewContext

GPU Scene 全局共享，View 状态隔离：

- Main Camera View；
- Shadow View；
- Reflection Probe View；
- Probe Volume Update View；
- 未来 Editor、Capture 和多视口 View。

每个 View 拥有独立相机参数、裁剪结果、临时资源和 Temporal History，但复用相同 Render Feature 和 GPU Scene。

## 11. 初始化配置与默认策略

不设计 Low / Medium / High 三套真实管线。默认是固定的中等偏高配置，初始化时可通过一个 `RendererConfig` 覆盖数值参数和功能开关：

```ts
new Renderer({
  renderScale: 1.0,
  aoScale: 0.5,
  ssrScale: 0.5,
  shadowResolution: 2048,
  cascadeCount: 4,
  probeUpdateBudget: /* medium-high default */,
  enableGTAO: true,
  enableSSSR: true,
  enableTAAU: true,
});
```

参数调整由初始化配置决定，不通过运行时 GPU Budget Governor 自动降级。所有效果默认开启；单独关闭某项时必须满足 Feature-off 零成本规则。

目标平台为桌面 WebGPU。Renderer 初始化时检查必需能力；不满足目标能力则明确报错并拒绝启动，不维护低端兼容路径。

## 12. 开源实现复用策略

实现采用“参考实现优先、完整移植、验证后删除旧路径”：

1. 为每个能力检索成熟开源实现、论文和官方规格。
2. 确认许可证、commit/tag、源码路径和可移植性。
3. 选择一个主参考实现，保留核心不变量、历史处理、边界条件和资源生命周期。
4. 只为 WebGPU/WGSL/OEngine GPU-driven 数据模型做必要适配。
5. 用固定场景进行画质、稳定性、GPU 时间、显存和计数器 A/B 验证。
6. 验证通过后删除旧实现，不保留长期双路径。

推荐参考方向：

- Filament：PBR、IBL、Clustered Lighting、FrameGraph；
- Unreal Engine：GPU Scene、Temporal Reconstruction、系统化 Feature 组织；
- The Forge / Wicked Engine：Visibility Buffer、GPU-driven 工作生成；
- Babylon.js / PlayCanvas：WebGPU 下的模块化 Graph 和资源管理；
- AMD FidelityFX SSSR：完整的层级遍历、随机采样和去噪思路。

所有移植记录必须进入 `docs/references/porting/`，不得只保留口头来源。

## 13. 重构与删除策略

采用硬切换式重构，不做过渡方案：

```text
删除冲突旧架构
  ↓
实现新 FrameGraph / Feature 基础设施
  ↓
实现目标 Visibility / Surface / Lighting / Secondary / Temporal / Post
  ↓
统一接入 Renderer
  ↓
建立回归与性能示例
  ↓
删除剩余旧 consumer、shader 和资源 owner
```

重点删除或重写候选：

- 旧 TAA 和重复 Temporal Composite；
- 当前 SSR 读取不完整 Scene Radiance 的组合路径；
- GTAO 写回 Material AO 的合并路径；
- 旧 Material Expand、每材质全屏扫描和重复 Surface 解释；
- 与新 FrameGraph 冲突的手工 Pass 顺序、无消费者资源和独立提交；
- 旧 Visibility/HZB/Lighting/Post consumer（以真实源码引用和验证结果为准）。

不得因为“已有类名”或旧路径能出画面而继续保留。删除前必须确认真实生产 consumer、shader 所有权和生成来源。

## 14. 实施顺序

实施过程中不要求保持旧画面，也不建立临时兼容管线。推荐顺序：

1. FrameGraph、Render Feature、ViewContext、Persistent/Transient 资源和统一提交基础设施；
2. GPU Scene Patch、Visibility、Material Resolve 和 Surface Contract 重构；
3. Clustered Lighting、Shadow Service 和统一 HDR 光照组合；
4. GI Service（Lightmap + Probe Volume）、Reflection Service（Probe + SSSR）和 AO Service；
5. Temporal Reconstruction（TAAU + DRS）、Transparency 和 HDR Post；
6. 删除旧路径、shader、资源 owner 和无效配置；
7. 新管线主体完成或大部分完成后，再建立固定回归和性能示例；
8. 运行完整 Browser/GPU 验证并更新 `CURRENT-STATE`、性能 artifact 和 ADR。

## 15. 验收标准

### 画质与稳定性

- PBR、HDR、阴影、GI、反射、AO 和后处理组合正确；
- 无明显 TAA 拖影、抖动、SSR 断裂、AO 黑边或历史污染；
- 动态灯光能正确影响静态场景的直接和间接光；
- 所有 fallback 不产生黑块、未初始化值或能量突变。

### GPU-driven 闭环

- GPU 生成 Visibility、LOD、工作队列和间接绘制参数；
- CPU 不生成最终可见列表；
- producer、consumer、capacity、overflow、fallback 和统计计数可验证。

### 性能与内存

- 在固定 1920×1080、DPR1、中等偏高配置下使用 GPU timestamp 分析各阶段；
- 统计 GPU Scene、Transient、History、Shadow、Probe 和纹理显存；
- 单一主提交，无无意义 readback、空 Pass 或重复资源；
- Feature-off 接近零成本。

### 可观测性

每个 Render Feature 至少提供：

- GPU timestamp；
- 输入输出资源统计；
- 命中、回退、拒绝、overflow 计数；
- 独立 Debug View；
- 固定序列截图或数值回归。

## 16. 固定验证场景

新管线主体完成后建立以下基准场景：

1. Static Geometry：GPU-driven、层次裁剪、Visibility、Material Resolve；
2. Dynamic Lighting：Directional/Point/Spot、CSM、Atlas、Contact Shadow；
3. Indoor GI：Lightmap、Probe Volume、动态灯光间接影响；
4. Reflection：Local Probe、SSSR、IBL fallback、粗糙度变化；
5. Temporal Stress：快速相机、细小几何、透明、反射和 AO 稳定性；
6. Heavy Workload：大量实例、多材质、多灯光和默认配置性能。

每个场景支持固定相机和帧序列、最终截图、Debug View、GPU timestamp、关键计数器以及 Feature-off 验证。

## 17. 文档与决策后续

本文是本次讨论形成的产品级重构设计。实施前需要：

- 对应长期决策已登记为 [ADR-0012](../wiki/adr/0012-product-render-pipeline-redesign.md)，明确替代现有冲突决策；
- 建立“现有源码 → 目标模块 → 上游参考 → 重写/删除动作”映射表，见第 19 节和第 30.1 节；后续若拆分为独立文档，必须保持本节为入口。
- 为每次开源移植补充 porting ledger；
- 用实现证据更新 `CURRENT-STATE.md`，不能提前把目标写成已完成事实。

## 18. 可执行的阶段实施蓝图

本节把前面的目标架构转换为执行顺序。阶段是依赖边界，不是兼容版本，也不是要求长期同时存在的新旧管线。实施采用硬切换：旧实现可以在开发中被删除，直到新阶段完成前不建立第二条生产路径。

### 18.1 总体依赖图

```text
P0 目标冻结 / 源码盘点 / ADR
 ↓
P1 FrameGraph + Feature + View + Resource 基础设施
 ↓
P2 GPU Scene / Frame Contract / Config / Capability
 ↓
P3 GPU Visibility + Surface Contract + Material Resolve
 ↓
P4 Clustered Lighting + Shadow Service + HDR Composition
 ↓
P5 GI Service + Reflection Service + AO Service
 ↓
P6 Transparency Forward / OIT
 ↓
P7 Temporal Reconstruction + TAAU / DRS
 ↓
P8 HDR Post + Present + Debug Composition
 ↓
P9 旧路径删除、示例、Browser/GPU Gate、性能闭环
```

依赖关系的含义：

- P1 先提供承载新实现的图、资源和调试边界；不要求保留旧画面。
- P2 冻结 GPU Scene、View 和初始化配置，避免后续效果各自定义数据来源。
- P3 先稳定 Surface 数据，P4 以后所有光照效果只消费 Surface，不再重复解释材质。
- P4 先解决直接光照和阴影组合，P5 再接入间接光、反射和 AO，避免同时排查所有能量来源。
- P6 透明路径在不透明 HDR 场景颜色稳定后接入。
- P7 必须在 AO、SSR、透明和运动矢量输入稳定后实现，不使用 Temporal 掩盖上游错误。
- P8 是最终色彩和输出边界；P9 才开始建立正式产品示例和完整 Gate。

### 18.2 每阶段统一交付格式

每个阶段的实现任务必须包含以下内容：

1. 目标合同：输入、输出、依赖和不变量；
2. 源码 owner：新增、迁移、删除的模块和 shader；
3. 开源参考：仓库、commit/tag、路径、许可证和适配差异；
4. 运行证据：GPU producer/consumer、计数器、timestamp、Debug View；
5. 删除清单：旧 consumer、资源 owner、shader、配置和死代码；
6. 退出 Gate：正确性、性能、显存、feature-off 和回归结果。

不以“类已经创建”“Pass 已注册”或“能显示一张图”作为完成依据。

## 19. P0：目标冻结与源码盘点

### 目标

把本设计转成可执行的重构边界，明确哪些现有文档和实现被替代，避免实现过程中重新引入旧路线。

### 架构动作

- 为本设计创建对应 ADR，明确替代与现有 ADR/实施文档冲突的部分；
- 冻结 `RendererConfig`、ViewContext、FrameProducts、Surface 和 Lighting 的概念接口；
- 建立“现有模块 → 目标 Feature → 参考实现 → 重写/删除”的映射表；
- 标注每个现有 Pass 是保留、完整移植、重写或删除，不建立 `V2` 命名体系。

### 当前代码盘点重点

- `OEngine/src/render/Renderer.ts`：当前主图编排、资源绑定和提交 owner；
- `OEngine/src/render/MainFrameFeatureTopology.ts`、`pipeline/FramePlan.ts`、`pipeline/FrameProducts.ts`：目标编排边界候选；
- `OEngine/src/framegraph/*`：现有 FrameGraph、编译缓存、资源管理和计时能力；
- `OEngine/src/render/passes/*`：逐项标注迁移到哪个 Feature 或删除；
- `OEngine/src/gpu/GpuScene.ts`、`GpuPackedSceneRegistry.ts`、`GpuAssetStore.ts`：GPU Scene 与资产 owner；
- `OEngine/src/shaders/*`：确认真实生产 shader、生成来源和 legacy 文件。

### 退出条件

- 映射表完整覆盖生产 consumer；
- 冲突文档和 ADR 有替代关系；
- 删除清单通过源码引用检查；
- 不存在“先保留以防万一”的未归属生产路径。

## 20. P1：FrameGraph、Feature、View 和资源基础设施

### 目标

把当前手工主图改造成统一的 Feature 贡献模型，为后续新效果提供稳定承载层。

P1 的首个执行包已落地，详见第 20 节和第 30.2 节：
注册表、输入/输出声明、依赖校验、compiled FrameGraph 资源摘要和主帧证据已经接线。
具体效果 Pass 的完整 Feature 化迁移仍按 P2–P8 的算法重构顺序进行，不能把本基础设施包解释为
TAA/SSR/SSAO 画质已经修复。

### 目标架构

```text
Renderer
  └─ FrameCoordinator
      └─ FrameGraph
          ├─ SceneUpdateFeature
          ├─ VisibilityFeature
          ├─ SurfaceFeature
          ├─ LightingFeature
          ├─ SecondaryFeature
          ├─ TransparencyFeature
          ├─ TemporalFeature
          └─ PostFeature
```

每个 Feature 只声明输入、输出、依赖、配置和调试信息。FrameGraph 负责拓扑排序、Pass 剔除、资源生命周期和 transient 复用。

### 实现顺序

1. 把现有 FrameGraph 的资源句柄、编译缓存、计时器和单 submit 逻辑收拢到 `FrameCoordinator`；
2. 定义 `ViewContext` 与每帧 `FrameProducts` 的生命周期；
3. 定义 Persistent/Transient 资源注册和 feature-off 剔除规则；
4. 把当前主图的每个现有 Pass 迁移为 Feature 的内部贡献，不保留独立 submit；
5. 加入统一 Debug View、GPU timestamp 和资源统计；
6. 删除 Renderer 中重复的手工拓扑、资源创建和 feature 开关分支。

### 退出条件

- 单一 FrameGraph 可编译并执行；
- 默认单 CommandEncoder、单主 Queue Submit；
- 关闭 Feature 时无无消费者 Pass、资源、History、readback；
- 主视图、阴影视图和 Probe/Reflection 辅助视图都能使用同一 Feature 接口；
- 资源生命周期和 timestamp 可在 Debug 输出中解释。

## 21. P2：GPU Scene、Frame Contract、配置和能力检查

### 目标

冻结所有 Feature 消费的场景、视图和初始化配置边界，消除效果模块各自读取旧 Scene/Renderer 状态的问题。

P2 基础合同执行记录见第 21 节和第 30.3 节。
该工作包先冻结配置、能力检查和 CPU 帧合同；具体 GPU Scene consumer 迁移与算法改造仍按 P3–P8 顺序执行。

### 实现顺序

1. 以 `GpuScene`、`GpuPackedSceneRegistry`、`GpuAssetStore` 为基础，确认 Runtime Asset 与 GPU owner 分离；
2. 定义静态数据、动态 Patch、灯光变化和局部缓存失效的统一事件；
3. 定义 `ViewContext` 的相机、输出尺寸、jitter、历史句柄和辅助视图标识；
4. 定义中等偏高默认 `RendererConfig`，所有数值参数和 Feature 开关从初始化配置进入；
5. 在 Renderer 创建阶段检查目标 WebGPU 能力，不满足则 fail-fast；
6. 删除各 Pass 内部自行推导分辨率、场景 owner 和默认参数的重复逻辑。

### 退出条件

- CPU 只提交 Patch、Frame 参数和 Graph 配置；
- GPU Scene 是所有可见性和光照 Feature 的唯一场景数据来源；
- 多 View 使用同一 GPU Scene、独立 View 状态；
- 初始化配置能完整控制默认开关和预算；
- 能力不足时有明确错误，不进入半兼容路径。

## 22. P3：GPU Visibility、Surface Contract 和 Material Resolve

### 目标

保留 GPU-driven 前端，但重建从 VisibilityKey 到 Surface 的单链路，删除重复材质解释和旧 Surface consumer。

P3 Packed 主链执行记录见第 22 节和第 30.4 节。
本阶段先完成 Feature owner/composition seam；普通 Scene legacy consumer 的最终删除必须在后续迁移和证据满足后进行。

### 实现顺序

1. 冻结 Visibility Buffer、Depth、Velocity 和 Surface ABI；
2. 迁移 `PackedVisibilityPass`、Hierarchy/SSE/Work Generation 和 Hardware Raster consumer 到 `VisibilityFeature`；
3. 确认 GPU producer 直接生成 indirect draw/work，并由 GPU consumer 消费；
4. 将 `PackedMaterialResolvePass` 和 `VisiblePixelClassifier` 收拢为唯一 `SurfaceFeature`；
5. 统一输出 Standard PBR Surface、Normal、Velocity、Material AO、Emissive 和 metadata；
6. 迁移 Alpha-Test 规则到同一 Visibility/Surface 合同；
7. 删除旧 `MaterialExpandPass`、每材质全屏扫描、重复 Material Expand shader 和 Packed 旧 Surface consumer。

### 退出条件

- Opaque/Alpha-Test 只有一条 Visibility → Material Resolve → Surface 路径；
- Resolve draw、Surface bytes、overflow、invalid 和 fallback 有 GPU 计数；
- CPU 不生成最终可见列表；
- Material AO 不再与 GTAO 合并；
- Surface Debug View 能单独显示 BaseColor、Normal、AO、Velocity、Emissive 和 material classification。

## 23. P4：Clustered Lighting、Shadow Service 和 HDR Composition

P4 owner/composition 执行记录见第 23 节和第 30.5 节。本工作包已接入 LightingFeature 与 ShadowService；具体光照/阴影画质和性能 Gate 仍以 production GPU artifact 为准。

### 目标

先建立稳定的直接光照和阴影组合，为 GI、Reflection 和 AO 提供明确的光照输入。

### 实现顺序

1. 将动态 Directional/Point/Spot 灯光统一写入 GPU Light Buffer；
2. 迁移 `LightClusterPass` 为 GPU Cluster/Froxel assignment Feature；
3. 统一直接光照、物理光单位和线性 HDR 输出；
4. 将 `PackedCsmShadowPass`、`ShadowRasterPass`、Shadow Atlas 和 Contact Shadow 收拢为 Shadow Service；
5. 统一 shadow visibility 采样和软阴影过滤入口；
6. 删除直接光照前后重复的颜色 composite、旧灯光列表和独立阴影组合路径；
7. 接入 Lighting Debug View、cluster overflow、灯光遍历和阴影 tile/cascade 统计。

### 退出条件

- 每个像素只消费所属 Cluster 的动态灯光；
- Directional、Point、Spot 默认产生阴影；
- Shadow Service 输出只表示可见性/过滤结果，不直接改写最终颜色；
- Direct Lighting + Shadow 在统一 HDR 方程中稳定；
- 没有依赖未来 GI/SSR 才能成立的直接光照结果。

## 24. P5：GI、Reflection 和 AO

P5 owner/composition 执行记录见第 24 节和第 30.6 节。本工作包已接入 GIService、ReflectionService 与 AOService；具体算法画质和性能 Gate 仍以 production GPU artifact 为准。

### 目标

把所有间接光、反射和环境遮蔽接入统一 Lighting Composition，解决当前效果互相覆盖、错误 fallback 和顺序错误。

### 实现顺序

1. 建立 `GIService`：Lightmap Provider、Probe Volume Provider 和 IBL fallback；
2. 接入离线 Lightmap、静态 Probe 数据和运行时局部 Probe 更新；
3. 建立 `ReflectionService`：Local Reflection Probe、SSSR correction、IBL fallback；
4. 确保 SSSR 读取完整 Scene Radiance，使用命中置信度做修正而非替换 Probe；
5. 建立 `AOService`：Material AO、GTAO diffuse visibility、specular visibility、bent normal 分离；
6. 迁移现有 `ScreenSpaceAmbientOcclusionPass`、`ScreenSpaceReflectionsPass`、IBL、Indirect Composite 和 Probe Pass 到对应 Service；
7. 删除 GTAO 写回 Material AO、SSR 重复 final composite、读取不完整 Scene Radiance 的旧组合路径；
8. 加入 GI 来源、SSR hit/miss/confidence、AO 通道和 fallback Debug View。

### 退出条件

- Diffuse fallback 为 `Lightmap → Probe Volume → IBL → 无间接光`；
- Reflection fallback 为 `Local Probe → SSSR correction → IBL`；
- SSSR miss/低置信度不会产生黑色反射；
- GTAO 不修改 Material AO，也不直接乘最终颜色；
- 动态灯光能通过 Probe Volume 影响静态场景间接光；
- AO、SSR、GI 的资源和历史归属明确且可单独关闭。

## 25. P6：透明 Forward/OIT

### 目标

在不透明 HDR 场景和光照服务稳定后，接入透明对象，不让透明路径反向污染 Opaque Surface 合同。

### 实现顺序

1. 定义透明 View 输入：Depth、Clustered Lighting、Shadow、GI、Reflection 和 HDR Scene Color；
2. 迁移 `PackedTransparentOitPass`、`TransparentOitPass` 和透明 shader 到 `TransparencyFeature`；
3. 保留 Forward/OIT 的独立资源与合成边界；
4. 为透明对象输出 Velocity、Reactive Mask 和必要的历史分类；
5. 删除透明路径对旧 Material Expand、旧最终颜色 composite 和重复光照列表的依赖；
6. 明确当前不实现 Transmission、Refraction 和透明对象动态 GI。

### 退出条件

- 透明路径复用统一灯光和阴影服务；
- 不透明 Visibility Buffer 不被透明路径破坏；
- OIT overflow、容量和 fallback 有计数；
- 透明关闭时不分配 OIT 资源、不提交 OIT Pass。

当前执行记录见第 25 节和第 30.7 节。本阶段先完成 owner/lifecycle 收拢，OIT 数学与 G5-S 生产 Gate 仍按后续验证门禁执行。

## 26. P7：Temporal Reconstruction、TAAU 和 DRS

### 目标

在上游 Surface、Lighting、AO、SSR、Transparency 和 Velocity 都稳定后，彻底替换旧 TAA 组合，建立统一时域服务。

### 实现顺序

1. 冻结输出分辨率、内部渲染分辨率、jitter、Velocity、Depth 和 Reactive Mask 合同；
2. 建立 Temporal History Registry 的颜色、AO、Reflection/Confidence 独立历史；
3. 迁移 `TemporalClassificationPass`、`TemporalAntiAliasingPass`、`DynamicResolutionScaling` 和历史导入/导出到 `TemporalFeature`；
4. 实现 TAAU + DRS 默认路径，初始化参数控制预算，不接入运行时自动降级；
5. 实现历史失效：摄像机切换、场景重载、重大灯光变化、输出尺寸变化和资源重建；
6. 删除旧 `taa`、重复 final temporal composite、错误的固定 history blend 和无 owner 的历史资源；
7. 加入 history weight、rejection、disocclusion、reactive 和 reset Debug View。

### 退出条件

- TAA/TAAU 只负责最终重建，不替代 AO/SSR 自己的历史；
- 透明和快速变化区域不会污染不透明历史；
- 快速相机运动、细小几何和 SSR 变化没有明显拖影或抖动；
- DRS 只由初始化配置决定，不存在隐藏自动 Governor；
- resize、cut 和资源重建后的历史行为可验证。

当前执行记录见第 26 节和第 30.8 节。本阶段完成时域 owner/lifecycle 收拢，最终 TAAU 画质、DRS sweep 与 G5-T/G5-P 生产 Gate 仍需独立验证。

## 27. P8：HDR Post、Present 和最终调试组合

### 目标

固定最终颜色边界，保证所有后处理在正确的线性 HDR/显示变换顺序中执行。

### 实现顺序

1. 统一 Scene HDR、Exposure、Bloom、Color Grading、Tone Mapping 和 Present 的资源域；
2. 迁移 `AutomaticExposurePass`、`BloomPass`、`TonemapPass`、`SharpenPass` 等到 `PostFeature`；
3. 删除中间 LDR、重复 gamma/sRGB 转换和旧 Post composite；
4. 将 Motion Blur 保持为可选扩展，默认关闭，不让它承担 TAA 修复职责；
5. 将最终 Debug View 接在 Post 前后，避免调试输出改变真实产品链；
6. 统一 Swapchain format、HDR output 和颜色空间错误处理。

### 退出条件

- 线性 HDR 贯穿 Lighting → Temporal → Post；
- Exposure、Bloom、Color Grading、Tone Mapping 顺序固定且可观察；
- Feature-off 不保留无消费者 Post 资源或 Pass；
- 最终输出与截图/数值回归工具使用同一颜色域定义。

## 28. P9：硬切换、删除、示例和完整 Gate

### 目标

新管线主体完成后一次性进入产品验证，清理全部旧 owner 和兼容残留。

### 删除顺序

1. 删除旧 Renderer 手工编排和重复 FramePlan；
2. 删除旧 Visibility/HZB/Material Expand consumer；
3. 删除旧 Lighting、IBL、Indirect Composite、AO、SSR、TAA 和 Post 组合路径；
4. 删除未被新 Feature 引用的 shader、generated owner、资源表和配置；
5. 删除旧 readback、调试面板和只服务旧路径的统计；
6. 使用全仓库引用搜索确认没有死代码、重复 owner 或隐式 fallback。

### 示例接入时机

只有在 P1–P8 的主要模块完成、FrameGraph 拓扑稳定、旧路径已删除大部分后，才正式建立固定验证场景。示例不作为临时兼容层，也不反向决定架构。

### 最终 Gate

- Static Geometry；
- Dynamic Lighting；
- Indoor GI；
- Reflection；
- Temporal Stress；
- Heavy Workload。

每个场景必须输出截图、固定帧序列、GPU timestamp、Debug View、关键计数器、显存统计和 Feature-off 结果。最终 Gate 通过后，才更新 `CURRENT-STATE.md` 和相关 ADR 的实施状态。

## 29. 阶段之间的禁止事项

- 不在 P1/P2 引入第二条“临时新管线”并长期维护；
- 不在 P3 之前为 AO、SSR 或 GI 增加新的独立表面解释；
- 不在 Surface Contract 稳定前通过后期乘法修正光照；
- 不在 Temporal 之前用 TAA 掩盖上游闪烁、黑块或错误 fallback；
- 不因为现有类名、旧 shader 或旧示例仍能运行而推迟删除；
- 不把某个上游实现改写成只剩几步的简化版；
- 不在没有 GPU producer/consumer、计数器和浏览器证据时宣称阶段完成；
- 不为兼容低端设备扩张当前 WebGPU 主路径。

## 30. 颗粒度重构任务清单

本节是实施清单，不是新的架构层。每个任务都必须在真实调用方、真实 shader 和真实 GPU consumer 上完成；只新增接口、注册类或包装类不算完成。任务状态只能使用 `todo`、`doing`、`blocked`、`done`，并且 `done` 必须附带运行证据。

### 30.1 P0-BASE：冻结边界和删除对象

| ID | 动作 | 主要源码 | 完成证据 |
|---|---|---|---|
| P0-01 | 导出 `Renderer.ts` 的实际 Pass/资源/提交调用图 | `OEngine/src/render/Renderer.ts` | 生成一份带 producer/consumer 的调用图 |
| P0-02 | 为每个 Pass 标记 `retain / port / rewrite / delete` | `OEngine/src/render/passes/*` | 全部生产 consumer 均有归属 |
| P0-03 | 冻结 `FrameProducts`、`SurfaceFrame`、`OpaqueLightingFrame`、`TemporalFrame` 字段 | `OEngine/src/render/pipeline/FrameProducts.ts` | TypeScript 合同测试和一份 ABI 表 |
| P0-04 | 冻结 Feature-off 规则 | `MainFrameFeatureTopology.ts`、`RenderSettings.ts` | 关闭每项功能时 compiled graph 无无消费者节点 |
| P0-05 | 检查生成 shader 的真实来源 | `OEngine/src/shaders/*`、构建脚本 | 每个生产 shader 能追溯到源文件 |
| P0-06 | 建立旧代码删除清单 | Renderer、legacy passes、旧 shader | `rg` 无未归属生产引用 |
| P0-07 | 将上游来源登记到 `docs/references/porting/` | 相关 ledger | 仓库、commit、路径、许可证、不变量齐全 |

P0 禁止改算法。它的目标是先回答“谁生产、谁消费、谁删除”，防止重构继续在旧路径外面加壳。

### 30.2 P1-FRAME：统一 FrameGraph 和资源生命周期

| ID | 动作 | 具体要求 |
|---|---|---|
| P1-01 | 收拢主帧入口 | `Renderer.render()` 只创建一个 `FrameCoordinator`、一个 encoder、一个主 submit |
| P1-02 | 定义 Feature 注册表 | 每项 Feature 声明 `enabled`、输入、输出、依赖、debug、统计 |
| P1-03 | 定义资源声明 | Persistent 由 owner 创建；Transient 只能由 FrameGraph 创建和复用 |
| P1-04 | 增加拓扑校验 | 禁止读未声明资源、写后读冲突、循环依赖和无消费者输出 |
| P1-05 | 增加 compiled graph 摘要 | 输出节点、资源、别名复用、timestamp 和被剔除节点 |
| P1-06 | 迁移历史资源 | TAA/AO/SSR 历史必须通过 History Registry 注册，不能由 Pass 私自持有 |
| P1-07 | 清除手工顺序 | 删除 Renderer 中与 Graph 重复的排序、资源释放和 feature 分支 |

P1 完成后仍然允许画面不正确；但不允许出现第二套提交器、私有 readback 或脱离 Graph 的资源生命周期。

### 30.3 P2-SCENE：GPU Scene、ViewContext 和配置合同

| ID | 动作 | 具体要求 |
|---|---|---|
| P2-01 | 固定 Runtime Asset/GPU owner 边界 | Loader 临时对象不能进入长期 GPU 表 |
| P2-02 | 固定实例 ABI | current/previous transform、geometry handle、material handle、flags、bounds 的字节布局和对齐写入文档 |
| P2-03 | 固定 Patch 流程 | transform/material/light patch 具有容量、overflow、失效传播和计数器 |
| P2-04 | 固定 ViewContext | main、shadow、probe、probe-volume view 共享 GPU Scene，独立相机、裁剪、临时资源和 history |
| P2-05 | 固定配置入口 | 所有缩放、shadow cascade、probe budget、feature 开关从 `RendererConfig` 进入 |
| P2-06 | 能力检查 | 不把 64-bit atomic、MDI、mesh/task shader、BDA、bindless 当作 baseline；缺失能力明确 fail-fast 或使用已定义 fallback |
| P2-07 | 删除隐式全局读取 | Pass 不得直接读取 Renderer 私有状态、旧 Scene 列表或自行推导默认值 |

### 30.4 P3-VIS-SURFACE：Visibility 到 Surface 的硬切换

| ID | 动作 | 具体要求 |
|---|---|---|
| P3-01 | 冻结 VisibilityKey ABI | key 必须能唯一索引 RasterWork → VisibleCluster/Meshlet → triangle/local primitive |
| P3-02 | 冻结可见性队列 ABI | 定义元素、容量、生产者、消费者、overflow、parent fallback、计数器 |
| P3-03 | 迁移 hierarchy/LOD/culling | SSE、frustum、cone、previous-HZB 的判定都在 GPU producer 中完成 |
| P3-04 | 迁移 indirect consumer | `drawIndirect`/`dispatchIndirect` 直接消费 GPU 生成参数，禁止 readback 后 CPU 遍历 |
| P3-05 | 统一硬件可见性 | opaque/mask 使用同一 Visibility Buffer、reverse-Z depth 和 key 编码 |
| P3-06 | 统一 Material Resolve | `PackedMaterialResolvePass` 成为唯一 opaque/mask surface producer |
| P3-07 | 冻结 Surface ABI | baseColor、normal、roughness、metallic、emissive、material AO、velocity、bent normal、metadata 分通道定义 |
| P3-08 | 迁移 alpha-test | alpha cutoff 与材质纹理采样发生在同一 resolve/visibility 语义内 |
| P3-09 | 删除旧路径 | 删除 `MaterialExpandPass`、每材质 fullscreen loop、legacy velocity 和重复 surface 解释 |

P3 的质量验证必须包含 normal map、alpha-test、快速运动、LOD 切换、遮挡恢复和 invalid key，而不是只验证一张静态颜色图。

### 30.5 P4-LIGHT：Clustered Lighting、Shadow 和统一 HDR

| ID | 动作 | 具体要求 |
|---|---|---|
| P4-01 | 固定 Light GPU ABI | directional/point/spot 的位置、方向、颜色、强度、范围、cookie、shadow index 对齐 |
| P4-02 | 重写 Cluster assignment | GPU 生成 cluster header/index list；记录 overflow、最大链长度和像素遍历灯数 |
| P4-03 | 固定光单位和坐标 | 明确世界单位、radiometric unit、view/depth convention、NaN/Inf 处理 |
| P4-04 | 重写 direct BRDF | 采用已登记的 Filament PBR 数值不变量；不得把上游材质对象或渲染器抽象带入热路径 |
| P4-05 | 收拢 Shadow Service | CSM、spot atlas、point atlas、contact shadow、filter 只输出 visibility/filtered visibility |
| P4-06 | 固定 CSM 规则 | cascade split、稳定化、bias、normal offset、PCF kernel、atlas tile 生命周期可复现 |
| P4-07 | 建立 Opaque HDR composition | direct、shadow、emissive、environment 在一个明确方程中合成，禁止后期 pass 互相硬乘/覆盖 |
| P4-08 | 删除重复 owner | `ShadowRasterPass`、旧灯光列表、旧 direct composite 只保留一个真实生产 owner |

P4 必须先通过“只有 direct + shadow”的基准，再接入 GI/SSR/AO；否则无法判断能量错误来自哪一层。

### 30.6 P5-SECONDARY：GI、Reflection、AO

| ID | 动作 | 具体要求 |
|---|---|---|
| P5-01 | GI provider 合同 | provider 返回 diffuse indirect、有效性、来源和局部失效范围，不返回最终颜色 |
| P5-02 | Lightmap provider | 校验 UV、解码、颜色域、曝光和静态/动态灯光边界 |
| P5-03 | Probe Volume provider | 定义 probe brick、更新预算、传播次数、局部更新和缺失 brick fallback |
| P5-04 | 固定 GI fallback | `Lightmap → Probe Volume → IBL → no indirect`，每次选择有统计 |
| P5-05 | Reflection probe producer | 定义 probe atlas、更新触发、box projection、粗糙度 mip 和失效传播 |
| P5-06 | SSSR correction | 采用命中置信度校正 probe，不替换稳定基底；miss、越界、roughness 过高回退 |
| P5-07 | SSSR 输入合同 | 必须消费完整 opaque HDR scene radiance、linear depth、normal、roughness、velocity |
| P5-08 | AO 四通道语义 | Material AO、diffuse visibility、specular visibility、bent normal 不得复用同一含义 |
| P5-09 | AO 算法重评估 | 当前 GTAO 与 XeGTAO 进行固定序列 A/B；决定 port/reimplement/retain 必须写 ledger |
| P5-10 | 删除重复 composite | 删除 SSR final override、GTAO 写回 Material AO、重复 IBL/indirect composite |

### 30.7 P6-TRANSPARENCY：Forward/OIT

| ID | 动作 | 具体要求 |
|---|---|---|
| P6-01 | 固定透明输入 | scene color、depth、cluster、shadow、GI、reflection、velocity、reactive mask |
| P6-02 | 选择 OIT 算法 | 对 MBOIT/加权 OIT 记录误差、内存、overflow 和排序假设，不以现有实现自动作为正确答案 |
| P6-03 | 迁移 transparent producer | Packed 和 legacy 透明对象统一进入 `TransparencyFeature`，但不污染 Opaque Visibility ABI |
| P6-04 | 固定容量行为 | fragment/node/accumulation overflow 必须有计数和确定性 fallback |
| P6-05 | 删除旧透明 consumer | 清除旧 material expand、旧 light list 和重复透明 composite |

### 30.8 P7-TEMPORAL：TAAU、History、DRS

| ID | 动作 | 具体要求 |
|---|---|---|
| P7-01 | 固定 internal/output resolution | 所有 pass 使用同一 `ViewContext` 尺寸合同，禁止各自乘 DPR 或 renderScale |
| P7-02 | 固定 jitter 序列 | 记录序列、phase、projection offset、camera cut 行为 |
| P7-03 | 固定 velocity 语义 | motion vector 的方向、单位、像素/UV 域、反转深度规则有 CPU/GPU 对照测试 |
| P7-04 | 分离 history | color、AO、reflection confidence、reactive/disocclusion mask 不能共享未声明的 ping-pong 资源 |
| P7-05 | 重写 resolve | history reprojection、neighborhood clamp、variance/weight、disocclusion 和 sharpen 顺序固定 |
| P7-06 | DRS 只改配置 | 本轮不引入隐藏 runtime governor；DRS sweep 只用于验证质量/性能曲线 |
| P7-07 | 删除旧 TAA | 迁移 `TemporalClassificationPass`、`TemporalAntiAliasingPass` 后删除重复 temporal composite 和固定 blend |

### 30.9 P8-POST：HDR Post 和 Present

| ID | 动作 | 具体要求 |
|---|---|---|
| P8-01 | 固定颜色域 | Lighting/Temporal 保持线性 HDR；只在 Post/Present 明确完成显示变换 |
| P8-02 | 固定顺序 | exposure → bloom extraction/blur/composite → color grading → tone mapping → output transform |
| P8-03 | 重写曝光 | histogram/average luminance、adaptation speed、min/max clamp、history reset 可观测 |
| P8-04 | 重写 tone mapping | 明确 SDR/HDR 输出、paper white、peak luminance、gamut mapping 和 gamma |
| P8-05 | 删除重复转换 | 删除中间 LDR、重复 gamma/sRGB、旧 post composite 和隐式 swapchain conversion |
| P8-06 | 固定 debug 位置 | Debug View 可选择 Post 前或 Present 前，但不得改写产品资源 |

### 30.10 P9-DELETE-GATE：删除和产品 Gate

| ID | 动作 | 完成条件 |
|---|---|---|
| P9-01 | 删除旧字段 | `Renderer` 不再持有被替代 Pass 的私有 owner |
| P9-02 | 删除旧配置 | `RenderSettings` 不再把具体 legacy Pass 作为 contract owner |
| P9-03 | 删除旧 shader | 生产 shader 无调用点后才删除；generated 文件必须从源头清理 |
| P9-04 | 删除旧资源 | 无消费者的 history、HZB、OIT、shadow、readback 资源不再分配 |
| P9-05 | 全仓库引用审计 | `rg` 检查 class、shader、binding、资源名和配置键，无隐式 fallback |
| P9-06 | Browser/GPU Gate | 固定场景截图、timestamp、计数器、显存、console 无误和 feature-off 全部通过 |
| P9-07 | 更新事实文档 | 只有 Gate 通过后才能更新 `CURRENT-STATE.md`、`STATUS.md` 和 ADR 状态 |

## 31. 算法来源与移植决策矩阵

下表规定候选来源，不代表已经完成移植。每一项必须先在对应 ledger 中完成许可证、commit、源码路径和测试路径登记。

| 能力 | 主参考 | OEngine 采用方式 | 当前动作 |
|---|---|---|---|
| PBR/IBL/BRDF | Filament，Apache-2.0，commit 见 `R4-ALGORITHM-GUIDE.md` | 移植数值不变量和边界测试；保留 OEngine Surface ABI | 对当前 shader 做差异审计和 A/B |
| Meshlet/几何分块 | meshoptimizer、Bevy Meshlet | 复用 cooker/算法，GPU ABI 由 OEngine 冻结 | 保留已登记移植，补齐质量 benchmark |
| GPU hierarchy/visibility | The Forge TVB、Scthe/nanite-webgpu、three.js baseline | 移植 producer/consumer 协议，不复制 renderer abstraction | 重写错误的 fallback 和容量策略 |
| Clustered lighting | clustered shading 论文、Filament/Babylon 参考 | 按 OEngine Light ABI 重实现并保留 overflow 统计 | 以 P4 direct-only 场景验收 |
| CSM/Shadow filtering | The Forge、Filament、官方规格 | 移植 split/stabilization/filter 不变量 | 重写 CSM/atlas 的组合 owner |
| AO | XeGTAO，MIT；当前 `R5-05` | 通过 A/B 决定直接 port 或按规格重实现 | 当前保留决定重新开启质量审查 |
| SSR | FidelityFX SSSR，MIT；当前 `R5-06` | 只移植层级遍历、confidence、fallback；不复制 API | 对当前结果进行 paired screenshot/GPU A/B |
| FrameGraph/history | Babylon.js，Apache-2.0 | 只移植 resource lifetime、history ping-pong 和 graph 组织 | 不引入 Babylon Scene/Material 类型 |
| TAAU | 上游算法/规格先行 | CPU reference → WGSL → 固定序列回归 | 当前实现不能以“已有 TAA”视为完成 |
| OIT | The Forge/论文和当前 MBOIT ledger | 记录误差/内存/overflow 后选择 | 透明独立于 opaque Surface |
| Color science | Filament、官方 HDR/色彩规格 | 迁移曝光、色调映射、颜色空间不变量 | 先固定 SDR，再验证 HDR |

如果候选实现依赖 WebGPU baseline 不具备的能力，必须记录为“按规格重实现”或“拒绝采用”，不能通过增加隐式 capability 把它伪装成 baseline。

## 32. 每个算法包的实际执行模板

每个算法不得直接在 `Renderer.ts` 中边查边改，必须按以下顺序执行：

1. **建立输入样本**：固定相机、几何、材质、灯光、输出尺寸和随机种子。
2. **建立 CPU reference**：至少覆盖正常值、边界值、空输入、overflow、NaN/Inf 和历史 reset。
3. **登记上游来源**：填写 `docs/references/porting/<task>-<algorithm>.md`。
4. **冻结 GPU ABI**：写明 buffer/texture 的字段、stride、format、usage、容量和所有权。
5. **移植最小算法核心**：先只实现一个明确输出，例如 visibility、shadow visibility、AO visibility 或 reflection confidence。
6. **接入真实 consumer**：必须由后续 GPU Pass 直接消费，不允许 readback 或 CPU 重建列表。
7. **做 A/B/C**：A=当前实现，B=移植实现，C=禁用/参考基线；同时比较截图、数值和 GPU 时间。
8. **处理生命周期**：验证 resize、device lost、in-flight frame、feature-off、overflow 和 fallback。
9. **迁移调用方**：删除旧 owner 和重复资源，不能保留同义 `Legacy`/`V2` 长期路径。
10. **更新状态**：只有所有 Gate 通过后才将 ledger 和 `STATUS.md` 标为完成。

## 33. 后续实际提交顺序

推荐按以下垂直切片提交，而不是按目录批量改名：

### Slice A：P0 + P1 基础承载

- 完成 owner/consumer 映射；
- 修正 FrameGraph 资源和 feature-off 剔除；
- 输出 compiled graph 摘要；
- 保持现有算法，但禁止新增旧路径调用。

### Slice B：P2 + P3 Surface 闭环

- 冻结 GPU Scene/View/Surface ABI；
- 让 VisibilityKey → Material Resolve → Surface 成为唯一 opaque/mask 路径；
- 删除 `MaterialExpandPass` 和重复 velocity；
- 验证静态、LOD、alpha-test、运动和遮挡恢复。

### Slice C：P4 Direct Lighting 闭环

- 只启用 direct + shadow；
- 重写 cluster assignment、BRDF、CSM/atlas 和 HDR composition；
- 通过 direct-only 画质和 timestamp Gate 后再继续。

### Slice D：P5 Secondary Lighting

- 依次接入 GI、Reflection、AO，每次只启用一个 provider；
- 每个 provider 输出中间产品，不输出最终颜色；
- 完成 fallback、confidence、AO 四通道和局部失效验证。

### Slice E：P6 Transparency

- 在稳定 opaque HDR 上接入透明 Forward/OIT；
- 验证排序近似、overflow、reactive mask 和关闭零成本。

### Slice F：P7 Temporal

- 先关闭 SSR/AO/透明验证基础 TAAU；
- 再逐项开启并验证 history contamination、disocclusion、camera cut 和 resize；
- 最后验证 DRS sweep。

### Slice G：P8 + P9 产品输出和删除

- 固定曝光、Bloom、Color Grading、Tone Mapping 和 Present；
- 删除全部无 owner 的 legacy 路径；
- 建立六个固定 Browser/GPU 场景并完成最终 Gate。

## 34. 重构期间的代码审查清单

每个提交都要回答以下问题：

- 这个改动替换的是哪个真实算法 owner，而不是增加了哪一个 wrapper？
- 上游来源、commit、许可证和源码路径在哪里？
- GPU producer 生成的结果由哪个 GPU consumer 直接消费？
- 新增的 buffer/texture/queue 的 ABI、容量、overflow 和统计是什么？
- 关闭功能后哪些 Pass、资源、history、readback 和 submit 被剔除？
- 是否仍然存在旧路径、重复 composite 或 Renderer 手工拼接？
- 是否验证了截图、数值、GPU timestamp、显存和 console？
- 是否需要更新 `CURRENT-STATE.md`，还是当前只能标记为 partial？

任何一个问题没有证据时，任务只能标记为 `partial`，不能声称该算法或阶段已经完成。

## 35. 文档维护规则

- 本文件维护目标架构和阶段执行顺序；不记录未经验证的“已完成”事实。
- `docs/references/porting/` 维护每个外部算法的来源和差异；禁止只在本文件写一句“参考 Babylon/three.js”。
- `docs/implementation/STATUS.md` 只记录当前阶段和 Gate 证据链接。
- `docs/CURRENT-STATE.md` 只记录源码已经达到并经过运行验证的状态。
- 若实现过程中发现目标设计与 WebGPU baseline、性能或画质证据冲突，必须新增/更新 ADR，并在本文件标注替代关系，不得悄悄改变架构语义。
