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

- 创建或更新对应 ADR，明确替代现有冲突决策；
- 建立“现有源码 → 目标模块 → 上游参考 → 重写/删除动作”映射表；
- 为每次开源移植补充 porting ledger；
- 用实现证据更新 `CURRENT-STATE.md`，不能提前把目标写成已完成事实。

