# OEngine 模块化架构讨论记录

> 本文档按照“一个模块、逐层深入”的方式记录 OEngine 架构讨论。  
> 它不是最终设计正文；只有达到“已敲定”的结果，才会在后续同步到正式设计文档。

## 1. 权威与记录规则

### 1.1 权威来源

1. `docs/source/` 是当前产品方向、研究结果和设计想法的核心来源。
2. 当前对话中的最新确认，用于处理 `docs/source/` 内部的新旧变化或冲突。
3. `docs/00–09`、现有代码和 examples 只表示早期拆分或验证，不反向约束新架构。
4. `docs/source/` 内部出现冲突时，必须显式讨论，不使用派生文档或当前代码自动裁定。

### 1.2 讨论推进方式

采用模块树，而不是平铺功能列表：

```text
全局架构基线
    ↓
选定一个一级模块
    ↓
逐层讨论该模块内部设计
    ↓
该模块形成稳定设计
    ↓
进入下一个模块
```

具体纪律：

- 不再横向扫过所有模块后才回头补细节。
- 当前模块先讨论到足以输出稳定语义契约；如果某个物理决定真实依赖相邻模块、原型或性能数据，则明确移交，不为了“完成当前模块”凭空锁死。
- TAA、SSR、Shadow、GI 等效果若会约束当前模块，可以在当前模块中讨论其需求，但不顺势展开整个效果实现。
- 架构模块不等于 npm 包、目录或开发阶段；包结构最后再确定。
- 助手建议和用户初步想法都不能自动标记为“已敲定”。
- 允许为当前模块建立最小跨模块 dependency checkpoint，例如 M01 只确定 Transform 权威和 Change 输出，M04 再确定 GPU 物理表；这不等于横向展开全部模块。

### 1.3 状态

| 状态 | 含义 |
|---|---|
| `待讨论` | 已识别模块或层次，但尚未展开 |
| `讨论中` | 正在比较方案和边界 |
| `暂定` | 已有倾向，仍有关键问题未解决 |
| `已敲定` | 可以成为后续正式设计约束 |
| `已否决` | 明确不采用，并保留原因 |
| `已替代` | 被后续决定替换 |

### 1.4 决策质量与复杂度纪律

“已敲定”必须区分敲定的是哪一层，不能把产品方向、语义契约和物理实现混成一个结论：

| 决策层级 | 可以敲定的内容 | 不应顺带锁死的内容 |
|---|---|---|
| 产品硬约束 | 单一 Runtime、GPU-resident、无 CPU Render List、three.js 作为输入生态 | 某个 Buffer 字段、某种排序算法、某种缓存结构 |
| 模块/语义契约 | 谁拥有数据、谁可以修改、输入输出和生命周期关系 | TypedArray 数量、Dense/Sparse 形式、Pass 精确数量 |
| 物理实现 | 已有基准或原型支持的数据布局和算法 | 尚未测量却仅凭完整性推导出的通用框架 |

后续讨论遵守以下规则：

1. 先列出必须满足的真实约束，再提出最简单能走通的设计。
2. 不为了形式完整固定制造“两种极端 + 一种复杂折中”。只有真实可行且会影响选择的方案才进入候选表。
3. 折中方案只有在两部分分别解决不同生命周期、不同数据权威或不同消费者时才成立；如果只是同时承担两边机制，则优先删除。
4. 能推迟到相邻模块、原型或性能数据后决定的物理结构，不提前标记为已敲定。
5. “最终希望拥有的能力”不等于“第一版必须实现的基础设施”。第一版优先窄接口、固定路径和可测闭环。
6. 优化设计必须说明工作量相对 `N`（场景总量）、`K`（变化量）、`V`（可见量）或其他核心规模变量如何增长。
7. 任何宣称“最优”的算法或布局都必须有代表性场景、目标设备和可重复基准；没有数据时只能记录为目标、假设或候选。

为避免单一状态表达不清，关键决策可以同时记录：

```text
方向状态：已敲定
物理实现：待讨论
性能结论：待原型验证
```

## 2. 全局架构基线

全局基线约束所有模块，但不代替模块内部设计。

### G-001 · 分层模块树

- **状态：** 已敲定

采用“稳定一级模块 → 内部分层 → 可组合能力”的组织方式。

一级模块是职责域和稳定讨论边界，不自动等于 npm 包、源码目录、运行时对象或独立框架。实现时允许相邻职责共处一个包，只要数据权威和依赖方向不被破坏。

不采用：

- 按 TAA、SSR、GI、Meshlet、MVP 等效果或阶段平铺整个工程。
- 把全部渲染能力塞进单体 Renderer Core。

### G-002 · 单一 OEngine Runtime

- **状态：** 已敲定

OEngine 只有一个正式 Runtime、一个 GPU Scene 和一个 Renderer Core。

three.js 是 Loader、资产、场景创建和参数语义的导入来源；导入完成后，OEngine World 是唯一运行时真源。

不实现：

- three.js 官方 Renderer 与 OEngine Renderer 双核心并存。
- three.js Scene 的长期自动同步。
- 每帧 Scene traverse、tracked object 扫描或双向状态同步。

### G-003 · GPU-resident / GPU-driven 硬约束

- **状态：** 已敲定

1. Geometry、Instance Transform、Material 参数、Bounds 等场景数据长期驻留 GPU。
2. Frustum、Occlusion 等剔除主要在 GPU compute 完成，并写出 Visible List。
3. 大规模排序、分桶、scan 和 compaction 尽量在 GPU 完成。
4. GPU 生成 Indirect Args；CPU 不按可见对象数量逐个提交 draw。
5. 大场景不透明三角几何以 Meshlet/Cluster 作为核心工作表示；GPU 展开和剔除 Meshlet 工作项。粒子、调试几何和特殊程序化表面可在同一 Renderer 内使用受控的其他 Work Type，不因此形成第二套 Renderer。
6. 使用 HZB、Visibility Buffer 等手段先确认可见性，再支付昂贵材质成本。
7. Skinning、Instance Animation、部分 Transform/Bounds 等大规模工作可以在 GPU 完成。
8. Light Clustering、Probe Sampling、Shadow 数据处理等大规模工作可以在 GPU 完成。

CPU 保留 Gameplay、结构变化、用户控制、资产请求和少量高层参数，不恢复为传统 CPU Render List 生成器。

### G-004 · 唯一 Visibility-Deferred 主管线

- **方向状态：** 已敲定
- **精确 Resolve/Texture 路由：** 待原型验证

```text
GPU Scene
  → GPU Culling / Meshlet Work Generation
  → Indirect Visibility Raster
  → Visibility Buffer + Depth/HZB
  → Material Resolve
  → Surface Buffer / GBuffer
  → Clustered Deferred Lighting
  → Temporal / Effects
  → Present
```

不维护完整 Forward Renderer 与完整 Deferred Renderer 两套平级主管线。

透明、粒子、玻璃、水、头发等无法用单层可见表面表达的能力，可以进入同一 Renderer 内受控的 GPU-driven Forward/OIT Special Pass，但不得回退到 JS Render List、CPU sort 或逐对象 draw。

这里敲定的是产品主管线和数据流方向，不代表以下物理实现已经确定：

- Material Resolve 是单一 Uber、Raster Grouped、Material-ID depth trick 还是其他受控路由。
- 每个 View 是否都执行 Sort、Bin、Scan、Compact 的完整组合。
- Previous HZB、Current HZB、Maybe Set 和二次 Raster 的准确次序。
- Surface Buffer/GBuffer 的字段、带宽和压缩方式。
- 无完整 bindless 条件下 Texture Group、Binding Group 和 Material Group 的组织。

这些问题必须通过至少一个可运行的 Visibility → Material Resolve → Lighting 垂直原型验证。原型需要记录 GPU 时间、Pass/Draw 数、显存与带宽、材质/纹理规模和目标设备差异，不能仅凭参考架构宣布最优。

### G-005 · three.js 材质是输入语义

- **状态：** 已敲定

`MeshStandardMaterial`、`MeshPhysicalMaterial` 等可以转换为 OEngine Material Descriptor/MaterialRecord。

运行时不执行 three.js WebGPURenderer、Material Shader、NodeBuilder 或完整 TSL 路径。不透明材质以 OEngine Visibility-Deferred 主管线为目标；Material Resolve 的具体路由仍按 G-004 的原型门槛确定。

### G-006 · 优先复用和迁移 three.js 的成熟实现

- **状态：** 已敲定

OEngine 不以“全部从零重写”为目标。对于 three.js 已经长期验证、语义适合 OEngine 的数学实现、数据转换、颜色处理、几何算法、Loader 和工具能力，默认优先直接使用、复制迁移或做等价实现，以减少重复工作、降低基础算法错误率，并保持与 three.js 生态的迁移一致性。

但“复用 three.js”不等于把 three.js Runtime 和 Renderer 带进 OEngine 核心。具体分为四类：

| 类别 | 采用方式 | 典型内容 |
|---|---|---|
| 导入期/工具期能力 | 可以直接依赖 three.js API | Loader、`Matrix4.decompose()`、`Box3`、`Sphere`、Geometry/Texture/Animation 数据读取与转换 |
| CPU Runtime 基础算法 | 优先从 three.js 复制或迁移，并改造成 OEngine 数据布局 | Vector、Quaternion、Matrix、Frustum、Bounds、插值、曲线和几何辅助算法 |
| GPU 算法与渲染公式 | 迁移数学语义和参考实现，重写为 WGSL | PBR/BRDF、Color、Tone Mapping、Skinning、采样、光照和部分后处理公式 |
| 调度和对象模型 | 不复用，按 OEngine 架构重写 | Scene traversal、RenderLists、WebGPURenderer、CPU draw 提交、NodeBuilder、完整 TSL Runtime、EffectComposer 调度 |

#### CPU 热路径迁移规则

three.js 的 `Vector3`、`Quaternion`、`Matrix4` 等对象式 API 可以直接用于导入、转换、验证、编辑器和低频工具路径，但不能因此规定 OEngine 热路径的数据布局。

Scene Runtime、GPU Scene extraction 和大规模批处理中的数学实现，应将已经验证的 three.js 算法迁移成适合 `TypedArray`、SoA/AoSoA、批量索引和无临时对象分配的函数。例如：

```text
M00 导入期：
  直接使用 THREE.Matrix4.decompose(sourceMatrix)

M01 CPU 热路径：
  使用由 three.js Matrix4/Quaternion 算法迁移的
  TypedArray + entityIndex 批量函数

M04/M07/M08 GPU 路径：
  使用保持相同约定和数值语义的 WGSL 实现
```

这保证复用的是成熟算法和语义，而不是把每个 Entity 重新包装成多个 JS 数学对象。引擎内部还必须明确矩阵主序、乘法方向、坐标系、Quaternion 约定、颜色空间和精度，不能仅以“与 three.js 类似”作为隐式契约。

#### 算法迁移规则

- three.js 已有且符合需求的算法，先评估直接使用或迁移，不无理由重新发明。
- 如果 three.js 实现依赖其对象模型、Renderer 状态或 CPU 每对象流程，则保留算法思想和数值语义，重写数据接口与调度方式。
- 如果 OEngine 的 GPU-driven 设计需要不同算法，例如 GPU HZB、Meshlet Culling、GPU Sort/Scan/Compaction，则不为了源码复用而迁就 three.js 的 CPU 架构。
- 导入期和 Runtime 的等价实现需要建立数值一致性测试；必要时用 three.js 结果作为 reference oracle。
- 复制或改写 MIT 源码时必须保留许可证要求，并记录来源文件、three.js revision/commit、迁移日期和 OEngine 修改说明，便于升级、审计和回归。

#### 该决定的工程后果

- OEngine 可以复用 three.js 成熟的基础设施，降低数学、Loader、资产语义和常用算法的初始工作量。
- three.js 生态变化主要由 M00 Integration 和迁移层吸收，不把核心 Runtime 绑定到某个 three.js 内部版本。
- 同一算法可能存在导入工具版、CPU 批处理版和 WGSL 版，但三者共享明确的语义测试，而不是各自随意实现。
- OEngine 仍需自行实现与其产品方向直接相关的 GPU Scene、Meshlet、Visibility、Indirect、Material Resolve、Lighting、FrameGraph 和 GPU 资源管理。

#### 明确否决

| 方案 | 否决原因 |
|---|---|
| 所有基础数学和常见算法全部从零重写 | 工作量和错误风险无必要增加，也不利于 three.js 资产迁移一致性 |
| Runtime 热路径直接堆叠 three.js 数学对象 | 大规模 Entity 下会带来对象跳转、临时分配和不适合 GPU 上传的数据布局 |
| 为了复用源码而采用 three.js Renderer/Scene 调度 | 会破坏单一 OEngine Runtime 和 GPU-driven 硬约束 |
| 无来源地复制源码 | 无法满足许可证、升级追踪、差异审计和回归维护要求 |

## 3. 一级模块地图

> 这里记录模块边界状态，不在本节展开模块内部算法。

| ID | 一级模块 | 边界状态 | 内部设计状态 |
|---|---|---|---|
| M00 | Ecosystem Integration | 已敲定 | 待讨论 |
| M01 | Scene Runtime | 已敲定 | **讨论中（当前）** |
| M02 | Asset Runtime | 已敲定 | 待讨论 |
| M03 | GPU Runtime | 已敲定 | 待讨论 |
| M04 | GPU Scene | 已敲定 | 待讨论 |
| M05 | Shader Kernel | 已敲定 | 待讨论 |
| M06 | FrameGraph | 已敲定 | 待讨论 |
| M07 | Geometry | 已敲定 | 待讨论 |
| M08 | Visibility Pipeline | 已敲定 | 待讨论 |
| M09 | Texture System | 已敲定 | 待讨论 |
| M10 | Material System | 已敲定 | 待讨论 |
| M11 | Lighting Domain | 待讨论 | 待讨论 |
| M12 | Temporal / Effects Domain | 待讨论 | 待讨论 |
| M13 | Host / Diagnostics / Tooling | 待讨论 | 待讨论 |

### 3.1 模块 ID 不表示讨论或实现顺序

`M00–M13` 是稳定引用编号，主要按架构位置和职责命名：

- M00 位于用户/three.js 生态输入边界，所以编号靠前。
- M01/M02 是 CPU Runtime 数据真源。
- M03–M06 是 GPU/Shader/Frame 基础。
- M07–M12 是主要渲染数据与管线模块。
- M13 是平台、诊断和工具横切域。

编号不表示：

- 必须按 M00 → M13 顺序讨论。
- 必须按该顺序实现。
- 编号越小优先级越高。

### 3.2 推荐的详细设计顺序（可随依赖调整）

```text
第一组 · 先确定运行时数据真源
  M01 Scene Runtime
  → M02 Asset Runtime
  → M04 GPU Scene

第二组 · 确定 GPU-driven 主数据流
  M07 Geometry
  → M08 Visibility Pipeline
  → M09 Texture System
  → M10 Material System
  → M11 Lighting Domain
  → M12 Temporal / Effects Domain

第三组 · 根据上层真实需求冻结基础设施内部设计
  M05 Shader Kernel
  → M06 FrameGraph
  → M03 GPU Runtime

第四组 · 完成外部生态与产品外壳
  M00 Ecosystem Integration
  → M13 Host / Diagnostics / Tooling
```

这是“详细架构设计顺序”，不是代码实现顺序。实现最小闭环时，M03 GPU Runtime 等底层模块显然会更早出现；但其最终 allocator、pipeline cache、FrameGraph 和 ABI 设计，应当由 GPU Scene、Geometry、Material、Effects 的实际需求反推，避免先做一个过度通用的底层框架。

M00 的产品边界已经先行敲定；其内部 Import Contract、白名单和转换数据结构，等 M01/M02/M07/M09/M10 的目标结构稳定后再深入，避免导入层反向规定核心数据模型。

## 4. M00 · Ecosystem Integration

- **模块边界：** 已敲定
- **内部设计：** 待讨论

### 4.1 模块定位

Ecosystem Integration 是 OEngine 与 three.js 生态之间的单向翻译边界：

```text
three.js Loader / Scene / Camera / Geometry / Material / Texture
                              ↓ import / convert / validate
                 OEngine World + Asset Registry
```

它的目标是保留 three.js 的资产入口、场景创建习惯和参数语义，同时阻止 three.js 对象模型、Renderer、TSL 和每帧 Scene traversal 进入 OEngine Runtime。

### 4.2 已敲定职责

- 读取 `THREE.Scene`、`Object3D`、`Camera`、`BufferGeometry`、`Material`、`Texture` 和 Loader 结果。
- 将 Scene 节点转换为 OEngine Entity 创建命令和层级描述。
- 将 Geometry、Material、Texture、Animation 等共享数据转换为 Asset Descriptor。
- 执行兼容白名单验证，并返回明确的错误、警告或迁移报告。
- 必要时返回一次性的 `THREE.Object3D → EntityHandle` 查询结果，供导入结果定位和调试；该映射不用于持续同步。
- 保留 glTF/three.js 材质参数、颜色空间、纹理变换、相机和动画数据的可迁移语义。
- 将受支持的 `THREE.Object3D.visible` 初始值转换为 OEngine `localRenderEnabled`；导入后仍由 OEngine World 权威，不持续追踪 three.js 对象。

### 4.3 明确不负责

- 导入后持续追踪 `mesh.position`、`material.color`、Scene 节点增删等 three.js 修改。
- 每帧 traverse three.js Scene 或扫描 tracked objects。
- Proxy、monkey patch 或 three ↔ OEngine 双向状态同步。
- 创建 GPUBuffer、GPUTexture、BindGroup 或 Pipeline。
- 决定 GPU Scene table 布局、渲染 Pass、Culling 或 Material Resolve 算法。
- 直接运行 three.js WebGPURenderer、完整 TSL、NodeBuilder 或 EffectComposer 路径。

### 4.4 数据权威与运行时后果

导入完成后：

```text
OEngine World       = Entity/Transform/Visibility 等运行时真源
OEngine Asset       = Geometry/Material/Texture 等逻辑资产真源
three.js objects    = 可释放或仅由应用保留的源对象
```

运行时修改必须通过 OEngine World/Entity/Material API 完成。旧 three.js 动态逻辑需要迁移，不以牺牲 GPU-driven CPU 性能换取无修改运行。

这意味着：

- 静态大场景导入后不再承担 Scene 树维护成本。
- Dirty 信息在 OEngine 写入发生时直接产生，不需要比较 three.js 新旧状态。
- 大量动画、Transform 和 Bounds 更新可以直接进入 OEngine CPU/GPU 数据路径。
- three.js 版本变化主要影响 Integration，不扩散到核心模块。

### 4.5 已否决方案

| 方案 | 否决原因 |
|---|---|
| three.js Scene/Object3D 作为长期运行时真源 | 需要持续遍历、比较或侵入式追踪，数据权威不清楚，并削弱大场景 CPU 性能 |
| three authoring + OEngine runtime 长期受控同步 | 增加双份状态、映射、遗漏 Dirty 和一致性维护成本；当前采用 OEngine-first Runtime |
| Integration 直接上传 GPU 资源 | 会越过 Asset/Scene/GPU Runtime 边界，使 three.js 依赖渗透内核 |
| 完整 TSL/NodeMaterial 直接运行 | 绑定 three.js NodeBuilder 和官方渲染路径，与固定 GPU Scene ABI 和 Visibility-Deferred 主线冲突 |

### 4.6 后续内部层次

| 层次 | 内容 | 状态 |
|---|---|---|
| M00-L1 | Import Contract 与导入生命周期 | 待讨论 |
| M00-L2 | Scene/Geometry/Material/Texture 白名单 | 待讨论 |
| M00-L3 | 错误、降级和兼容报告 | 待讨论 |
| M00-L4 | Animation/Light/Camera 导入 | 待讨论 |
| M00-L5 | three.js 效果、TSL 和工具迁移 | 待讨论 |

### 4.7 尚未敲定

- 导入过程是一次性事务、可取消任务，还是支持增量提交。
- Three Import 第一版白名单和失败策略。
- 原始 three.js 对象、Image/ArrayBuffer 与转换后 Asset 数据由谁持有。
- 动画 Clip、Skeleton、Light 和 Camera 的标准描述。
- three.js 后处理和既有效果迁移到 FrameGraph/Effects 的工具形态。

## 5. M01 · Scene Runtime

- **模块边界：** 已敲定
- **内部设计：** 讨论中
- **当前活动模块：** 是

### 5.1 已敲定边界

OEngine 自己实现小型、渲染专用的 ECS-like World，不绑定完整通用 ECS 框架。

```text
Stable EntityId / Handle
+ 渲染相关组件或数据表
+ Systems
+ Dirty / Change Journal
+ 面向 GPU Scene 的连续数据布局
```

Scene Runtime 主要管理：

```text
Entity 生命周期
Transform / Hierarchy
Renderable Instance
Bounds
Hierarchy Render Gate / 渲染参与控制
Camera
Light 控制状态
Animation 控制状态
```

不默认承担 Gameplay、Physics、AI、Audio、Networking 或通用脚本系统。

Geometry、Material、Texture、Animation Clip 等可共享资产属于 Asset Runtime；Entity 只保存稳定 AssetId。

### 5.2 内部分层讨论顺序

| 层次 | 问题 | 状态 |
|---|---|---|
| M01-L1 | 数据权威与模块范围 | 已敲定 |
| M01-L2 | EntityId、Generation、Handle 与生命周期 | 已敲定 |
| M01-L3 | Component/Store 数据布局 | 已敲定 |
| M01-L4 | Hierarchy 与 Transform 更新 | **讨论中** |
| M01-L5 | Mutation Tracker / SceneDelta / GPU Propagation Contract | **已敲定（架构）；物理细节待讨论** |
| M01-L6 | CPU 控制状态与 GPU 派生状态边界 | 待讨论 |
| M01-L7 | 对外 World/Entity API | 待讨论 |
| M01-L8 | 并发、Worker 与批量命令 | 待讨论 |

### 5.3 M01-L1 · 数据权威与模块范围

- **状态：** 已敲定

- OEngine World 是导入后的唯一运行时场景真源。
- 动态对象通过 World/Entity/Handle API 修改。
- 修改发生时直接产生 Dirty/Change 信息，不读取 three.js 对象比较变化。
- World 管逻辑和控制状态；高成本 Transform、Animation、Bounds 等派生计算可以后续迁移到 GPU。
- Scene Runtime 不生成 CPU Render List，不对海量可见对象排序，不逐对象提交绘制。

### 5.4 M01-L2 · EntityId、Generation、Handle 与生命周期

- **状态：** 已敲定

#### 已敲定：Runtime Handle 采用 index + generation

```text
EntityHandle
  index: u32
  generation: u32
```

World 为每个 Entity slot 保存当前 generation 和 lifecycle state。外部 Handle 访问时先验证 index、generation 和 state，再用 index 直接定位 Component/Store。

示例：

```text
Tree 创建：
  Handle { index: 42, generation: 7 }

Tree 删除，slot 42 后续复用给 Car：
  Handle { index: 42, generation: 8 }

旧 Tree Handle 的 generation=7
不再匹配 slot 42 当前 generation=8
因此不能误操作 Car
```

#### 采用该方案的要求

- 百万级 Entity 下 O(1) 定位。
- Store 访问不经过 HashMap。
- Slot 可以回收复用。
- 旧 Handle 必须能检测为 stale。
- 适合批量创建、删除、修改和 Streaming。
- Handle 安全检查不能进入每个内部热循环。

#### 性能模型

API 边界访问：

```text
检查 index 范围
→ 读取 generations[index]
→ 比较 generation
→ 检查 lifecycle state
→ 使用 index 访问 Store
```

generation 可以保存为连续 `Uint32Array`。相较裸 index，只增加一次连续读取和整数比较，仍然是 O(1)、无 HashMap、适合缓存和批处理。

内部 System 在入口已经得到有效 dirty index/work list 后，可以直接批量使用 index，不在每次 Component 访问时重复验证 generation：

```text
公开 World/Entity API：验证 Handle
内部批量 System：处理已验证 index
```

#### 内存后果

- 每个 capacity slot 至少需要一个 `u32 generation`。
- lifecycle/alive 可以使用紧凑状态数组或 bitset，具体布局后续讨论。
- 概念模型是两个 u32，但 TypeScript 公共表示暂不确定，不承诺每次创建 `{ index, generation }` 临时对象。

#### 已否决：简单整数 index 直接作为安全 Handle

裸 index 虽然访问最快，但 slot 复用后无法识别旧引用。如果永不复用，又会使 Streaming 和频繁增删产生持续增长和稀疏问题。

裸 index 仍可作为 World 内部 Store 位置，但不单独作为外部安全 EntityHandle。

#### 已否决：永久 ID + Dense Slot 作为默认 Runtime Handle

永久 ID 需要 ID → dense slot 映射，增加 Map/稀疏表成本和内存，并且 GPU 仍需另一套紧凑索引。跨会话、存档、网络或编辑器身份以后可以另设 PersistentObjectId，不污染 Runtime 热路径。

#### 已敲定：PendingDestroy + commit 后复用

Entity 删除采用两阶段生命周期，避免同一更新周期内 slot 被新 Entity 复用导致旧 index 工作误操作新数据。

最小状态：

```text
Free
  ↓ create
Alive
  ↓ destroy
PendingDestroy
  ↓ update/frame commit
Free
```

调用已经通过语义验证的 Leaf/Subtree Destroy 时，每个实际被销毁的 Entity：

```text
验证 index + generation
→ state[index] = PendingDestroy
→ append pendingDestroyList
→ 公开 API 立即把该 Handle 视为无效
```

Component 数据可以暂时保留到 commit，供系统生成 Destroy Change、解除 Hierarchy、释放 Asset 引用和通知 GPU Scene，但用户不能继续修改该 Entity。

在 update/frame commit 阶段批量处理：

```text
生成下游 Destroy Change
→ 清理 Component presence
→ 解除 Parent/Child
→ 释放 Asset 引用
→ generation[index]++
→ state[index] = Free
→ slot 加入下一更新周期可用的 free list
```

同一更新周期内不复用刚删除的 slot。最早在下一 update epoch/frame 才能重新分配，避免旧 Dirty/Animation/Hierarchy 工作列表只保存 index 时出现 ABA 问题。

#### 删除性能

Leaf Destroy 热路径只处理一个 Entity，保持 O(1)。Subtree Destroy 必须处理实际销毁的 S 个 Entity，因此生命周期成本为 O(S)；这是 Handle 失效、Asset 引用、专用 Set 和 GPU Record 删除所要求的真实成本，不能伪装成 O(1)。两者都不扫描目标子树之外的场景总实体 N。

延迟一个更新周期复用的容量成本，只需要覆盖单周期最大 Entity churn，不要求为 GPU in-flight frame 保留相同 CPU slot。

#### 已否决：立即删除并同周期复用

立即复用可能使旧 DirtyTransform、Animation、Hierarchy 或 Change 工作列表中的 index 指向新 Entity。内部批量热循环不会为每个 index 重做 generation 验证，因此即使外部 Handle 安全，仍可能发生同周期 ABA。

#### 已否决：CPU Entity slot 等待 GPU Fence 后复用

这会把 Scene Runtime 生命周期与 GPU 物理执行绑死，增加回收延迟、Fence 追踪和 Streaming capacity 压力。CPU Entity slot 与 GPU Scene slot 暂不要求一一对应；GPU slot 和物理资源的安全延迟释放由 M04 GPU Scene 与 M03 GPU Runtime 处理。

#### 已敲定：DestroyLeaf 与 DestroySubtree 使用明确不同语义

不提供一个对带 Children Entity 暗中选择 cascade/detach/promote 的模糊 Destroy 默认行为。核心生命周期提供两种明确操作语义；最终公开命名由 M01-L7 决定。

Leaf Destroy：

```text
destroyLeaf(entity)
  → 验证 Handle/Alive
  → firstChild 必须为 INVALID_ENTITY
  → 进入 PendingDestroy
```

如果 Entity 仍有 Children，操作原子失败并返回 `EntityHasChildren` 或等价错误；Hierarchy、生命周期和 GPU Scene 均不修改。

Subtree Destroy：

```text
destroySubtree(root)
  → 迭代收集 root + all descendants
  → 全部立即对公开 API 失效
  → 全部进入 PendingDestroy
  → commit 批量输出 Destroy
```

它用于 Group、Streaming chunk、角色/Skeleton、导入 Scene 和完整对象组卸载。破坏范围通过操作名称显式表达，避免一个普通 `destroy()` 意外级联删除巨大场景。

#### 不提供隐式 Keep Children DestroyMode

如果用户要删除中间 Transform 节点但保留 Children，必须先显式处理直接 Children：

```text
for each direct child:
  setParent(child, parentOfDeletedNode)
  或 setParentKeepingWorld(...)

destroyLeaf(node)
```

这样保持 Local/保持 World、GPU-authored ancestor 限制和 Affine 结果都复用已经敲定的 Reparent 契约。高层编辑器可以封装 `spliceNode` 工具，但不在核心生命周期增加 `keepChildren + preserveWorld` 组合模式。

#### Subtree 收集与清理顺序

不使用 JS 递归，使用可复用 TypedArray/linear work stack 迭代收集：

```text
stack.push(root)

while stack not empty:
  entity = stack.pop()
  append subtreeEntities(entity)
  enumerate direct children through intrusive links
  push children
```

收集结果可以是 preorder；正式解除关系、释放引用和清理 Component 时按反向顺序处理，使 Children 先于 Parent 退出：

```text
collect: root → child → grandchild
cleanup: grandchild → child → root
```

`destroySubtree()` 完成后，所有已收集 Entity Handle 立即失效。Component/Hierarchy 数据可保留到 commit 完成 SceneDelta、Asset release、Block update 和 Diagnostics，但用户不能继续读取或修改。

#### 与 Compiled Hierarchy Block 的关系

销毁范围完整覆盖 Block：

```text
remove active Block descriptor
→ 不重建 Block 内容
→ old GPU segment 延迟释放
```

只删除 Block 内部分支：

```text
mark Block affected
→ rebuild remaining entities as new version
→ atomically publish
→ old version delayed release
```

一个 Subtree Destroy 可以在 commit 中分类为：

```text
wholeBlocksToRemove[]
partialBlocksToRebuild[]
```

避免对已经完整删除的 Block 做无意义重编译。

#### 大型 Streaming Retirement

普通 Subtree Destroy 的 O(S) 生命周期处理不可避免，但超大 Streaming block 不应由应用逐 Entity 调用公开 Destroy API。内部 Block-aware retirement 可以利用连续 `entityIndices` 批量失效 Handle、释放引用和生成 Destroy records：

```text
逻辑上立即从新 Visibility/World 版本移除
→ CPU/GPU 物理资源按预算和 in-flight 安全逐步回收
```

未来内部可使用 `Retiring` 状态协调分预算回收，但它不进入普通公开 Entity 生命周期，也不要求所有 System 长期处理。精确 retirement budget 和取消协议移交 M02/M03/M04/M13。

#### 已敲定：完整初始化后原子发布 Alive

普通同步创建不把 `Reserved` 发展成所有 System 都必须理解的长期生命周期状态。最小正式生命周期仍是：

```text
Free
  ↓ create(desc)
Alive
  ↓ destroy
PendingDestroy
  ↓ commit
Free
```

`create(desc)` 必须一次提供并验证该 Entity 的必需初始数据，在函数完成前不把 slot 暴露给普通 System：

```text
从 free list 取 slot或增长 capacity
→ 在函数内部初始化 Transform/Hierarchy/可选专用 Set
→ 验证必需 Asset 引用和字段
→ 初始化成功后 state = Alive
→ 追加一个完整 Create Change
```

如果初始化失败，slot 在发布前回滚。普通调用者不会获得一个需要后续逐项补齐才能安全使用的半初始化 Entity。

`Reserved` 仍可以作为以下实现中的短期内部标记：

- `create()` 调用尚未完成时的调试状态。
- 批量导入事务内部尚未发布的 slot。
- Worker/Command Buffer 在解析临时 Entity Token 时的内部状态。

但 `Reserved` 不进入普通公开生命周期契约，不要求每个 System、Query 和渲染阶段长期处理它。批量事务是否需要跨调用保留 Reserved 状态，留给 M01-L8 根据真实 Worker/Streaming 需求决定。

创建与删除共用统一提交边界：

```text
pendingCreate
pendingUpdate
pendingDestroy
      ↓
World Commit
      ↓
Change Journal
      ↓
GPU Scene
```

#### 创建性能与一致性后果

- 导入和 Streaming 可以批量初始化，不暴露部分 Component 状态。
- 创建失败可以在发布前回滚。
- GPU Scene 收到一个完整 Create Change，而不是 Create 后连续补齐多次更新。
- Transform、Hierarchy、Asset 引用和必需专用数据在创建发布前完成验证。
- 普通同步 API 不需要为创建支付长期事务状态和额外一帧可见延迟。

#### 已否决：先发布空 Entity、再逐项补 Component

这里否决的不是“函数结束后立即 Alive”，而是先把空 slot 发布为 Alive，再通过多次公开调用逐项补 Transform、Renderable、Bounds 或 Asset 引用。后者会产生半初始化状态、细碎 Change、回滚困难和 GPU Scene 初始化顺序问题。

#### 已否决：所有创建强制只通过 Command Buffer

全命令缓冲适合 Worker 和批量导入，但会让普通同步 API 变得笨重，并引入临时 Entity Token 和读后写语义。Command Buffer 保留为 M01-L8 的批量/Worker 能力，不作为所有创建操作的唯一入口。

#### 已移交后续层次的问题

- Handle 最终是对象、opaque type、两个参数还是其他无分配表示：M01-L7。
- 批量 Handle 验证、Command Buffer 和错误策略：M01-L7/M01-L8。
- CPU Entity index 与 GPU Scene slot 的映射：M04。
- GPU 物理资源和 in-flight frame 的延迟释放：M03/M04。

### 5.5 M01-L3 · 固定 Render World Database

- **状态：** 已敲定

#### 总体决定

OEngine 不实现 Bevy-style 通用 ECS，也不实现允许任意 Component 注册、Archetype 迁移和通用 Query 的混合 ECS 框架。

采用固定的渲染专用数据库：

```text
RenderWorld
├─ EntityRegistry
├─ TransformTable
├─ HierarchyTable
├─ RenderableSet
├─ CameraSet
├─ LightSet
├─ SkinningSet
└─ AnimationControlSet
```

底层仍然体现 Entity + 分离数据 + Systems 的 ECS-like 思想，但所有数据类别由 OEngine 固定，不向用户提供通用 Gameplay Component 系统。

这里敲定的是“固定渲染数据类别 + 专用访问路径”，不是以上每一项都必须成为独立 class、npm 包或永久不变的物理表。Skinning/Animation 等尚未深入的领域可以在其模块讨论时调整内部合并与拆分，只要不退回任意 Component 注册、通用 Archetype 和运行时 Query 框架。

#### 与 Bevy ECS 的区别

| 维度 | Bevy ECS | OEngine Render World |
|---|---|---|
| 产品范围 | 完整游戏世界 | 渲染专用数据库 |
| Component | 任意注册与组合 | 引擎固定 |
| 存储 | Archetype Table + SparseSet | 固定 Table/Set |
| Query | 通用泛型 Query | 专用 System 直接遍历 |
| Component 增删 | 可能迁移 Archetype | 更新固定专用 Set |
| 调度 | 通用并行 Scheduler | 固定渲染更新阶段 |
| Gameplay | ECS 内部职责 | 留在外部系统/ECS |
| GPU 映射 | 需要额外 extraction/render world | 从一开始围绕 GPU Scene |

Bevy 内部比 OEngine 目标复杂得多，只是由成熟框架隐藏。OEngine 不重新实现小号 Bevy。

#### EntityRegistry

按 Entity slot 直接索引，至少保存：

```text
generation
lifecycle state
```

Component/Set presence、debug flags 等字段是否进入 EntityRegistry，后续按需要确定。

#### TransformTable 与 HierarchyTable

规定所有 Scene Entity 都有 Transform 和 Hierarchy 基础行，通过 Entity index 直接访问：

```text
TransformTable[entityIndex]
HierarchyTable[entityIndex]
```

不需要 Transform presence bit 或 sparse lookup。全局 Renderer Settings、Quality Settings 等没有空间身份的数据不建模成 Entity。

Transform/Hierarchy 的字段、世界矩阵和 GPU 派生边界在 M01-L4 讨论。

#### RenderableSet

只有实际可渲染 Entity 进入连续 RenderableSet：

```text
Renderable row
  entityIndex
  meshAssetId
  materialAssetId
  renderFlags
```

通过专用反查表定位：

```text
renderableRowByEntity[entityIndex] → dense row / INVALID
```

Renderable 删除可以使用固定的 dense swap-remove 或其他专用策略；具体 row 稳定性在相关内部层次讨论，不发展成通用 SparseSet API。

#### Camera/Light/Skinning/Animation 专用 Set

这些数据只属于少量 Entity，并且 System 经常需要连续遍历全部同类对象，因此使用各自固定 Dense Set：

```text
CameraSet
LightSet
SkinningSet
AnimationControlSet
```

每个 Set 保存 `entityIndex`，需要 Transform 时通过该 index 直接读取 TransformTable。

#### Bounds 暂不归类

Bounds 可能只属于 Renderable，也可能部分由 GPU 根据 Transform、Skinning、Morph 生成。其 CPU Store、GPU Table 和更新权威必须结合 M01-L4、M01-L6、M04 和 M07 再决定，当前不强行放进 Direct Table 或 Dense Set。

#### Systems 不使用通用 Query

系统直接消费固定 Store：

```text
TransformSystem.update(TransformTable, HierarchyTable)
LightSystem.update(LightSet, TransformTable)
AnimationSystem.update(AnimationControlSet, SkinningSet)
```

不存在运行时解析 `Query<Transform, Light>` 或遍历 Archetype 的通用层。

#### Gameplay 与用户自定义数据

- 用户不能向 OEngine Render World 注册任意 Gameplay Component。
- Health、Inventory、Enemy、Physics Body、Script、Network State 等保留在应用自己的对象模型或外部 ECS。
- 应用只把渲染所需控制状态提交给 OEngine Entity/专用 Set。

#### 性能与内存后果

- Entity/Transform/Hierarchy 使用直接索引，访问 O(1)、无 HashMap、无 Archetype 迁移。
- Light、Camera、Skinning 等只为实际存在的对象分配 dense 数据。
- 专用 Set 连续遍历，不扫描百万 Entity 的空 Component。
- 不为每个 Entity 创建 JS class 或嵌套对象，减少 GC。
- Store 布局可以直接围绕 Dirty、批量更新和 GPU Scene extraction 设计。
- 代价是 OEngine 需要为每种固定 Set 明确维护映射、删除和 Dirty 规则，但范围远小于通用 ECS。

#### 已否决方案

| 方案 | 否决原因 |
|---|---|
| 每 Entity 一个 JS 对象/组件对象树 | GC、内存局部性和 GPU table 转换不符合大场景目标 |
| 所有 Component 全部按 Entity capacity 直接分配 | Camera、Light、Skinning 等稀有重数据浪费大量内存 |
| 所有 Component 使用通用 SparseSet | 高频 Transform/Hierarchy 增加间接访问、Join 和 row 移动复杂度 |
| 通用混合 Store/Archetype ECS | 需要通用 Component 注册、Query 和调度，复杂度接近重新实现 ECS 框架 |
| 直接采用完整 Gameplay ECS 作为 OEngine World | 扩大产品范围，并使渲染数据布局受通用 Gameplay 需求约束 |

#### 已移交后续层次的问题

- Transform/Hierarchy 字段和更新算法：M01-L4。
- Dirty 和 Set 变更提交：M01-L5。
- GPU 派生 Transform/Bounds/Animation：M01-L6/M04。
- World/Entity/Set 对外 API：M01-L7。
- 批量 Command/Worker：M01-L8。
- Renderable dense row、Bounds 和 GPU Instance 映射：M01-L5/M04/M07。

### 5.6 M01-L4 · Hierarchy 与 Transform 更新

- **状态：** 讨论中

#### 已敲定语义：Editable Hierarchy + Compiled Transform Schedule

- **语义与职责：** 已敲定
- **CPU Editable TypedArray/邻接结构：** 已敲定
- **Compiled GPU Block packing/容量参数：** 待 M04 原型验证

Hierarchy 需要同时满足两个真实且不同的工作负载：

```text
结构编辑表示
  支持 parent、children 枚举、add/remove/reparent、cycle 检查

编译执行表示
  支持 parent-before-child 的连续批量处理和 GPU hierarchy propagation
```

它们属于同一个 Hierarchy/Transform 系统，Compiled Schedule 是 Editable Hierarchy 的派生执行数据，不是第二棵场景树，也不是另一份用户可编辑真源。

#### Editable Hierarchy

CPU Editable Hierarchy 使用 entity-indexed intrusive doubly-linked forest：

```text
parent[entityIndex]
firstChild[entityIndex]
nextSibling[entityIndex]
previousSibling[entityIndex]

World scalar:
  firstRoot
```

Root Entity 使用同一套 sibling links：

```text
parent == INVALID_ENTITY
  → nextSibling/previousSibling 连接其他 Root
  → firstRoot 指向 Root List 起点

parent != INVALID_ENTITY
  → nextSibling/previousSibling 连接同 Parent 的 Children
  → firstChild[parent] 指向 Child List 起点
```

因此 Root 与普通 Child 不需要两套容器。该表示支持：

- O(1) 基础 link/unlink。
- Add/remove/reparent。
- Cycle 检查。
- 不扫描 N 地枚举直接 Children。
- Scene Import、Streaming block detach 和编辑器结构操作。

不使用 JS `children[]`、递归 Object3D 树、分散对象引用或通用动态 adjacency object。

`previousSibling` 是明确保留的字段。它每百万 Entity 约增加 4 MB CPU 内存，但避免在大扁平 Group、Streaming detach 和频繁删除时扫描 F 个同级节点。对于大场景目标，这个固定成本换取稳定 unlink/reparent 成本是合理的。

不保存 `lastChild[entity]`。新 Child/Root 默认插入 sibling list 头部，保持 O(1)；Importer 需要保持来源顺序时可以倒序批量建立 links。Sibling 顺序不定义为：

- GPU Draw 顺序。
- Transparent/Material 排序顺序。
- Gameplay update 顺序。
- 编辑器 z-order。

需要显式顺序的领域使用独立 sort key/metadata，避免 Hierarchy link 顺序暗中控制 Renderer。

Cycle 检查从 New Parent 向祖先方向执行：

```text
cursor = newParent
while cursor != INVALID_ENTITY:
  if cursor == child:
    reject cycle
  cursor = parent[cursor]
```

成本与 Hierarchy Depth D 相关，不遍历 Child Subtree S。除 Cycle 检查外，常规 link/unlink 为 O(1)。

#### Compiled Transform Schedule

Hierarchy 在结构 commit 后编译为适合 CPU/GPU 批量执行的 parent-before-child 顺序。概念上可能包含：

```text
transformOrder / topological order
可选 depth 或 level ranges
可选 per-root / per-animation-block schedule
```

它用于：

- CPU 导入验证、调试或受控小规模批处理。
- GPU 按层级/深度 Dispatch Transform 计算。
- 后续 Bounds、Animation 和 Skinning 派生更新。
- 避免普通帧沿 sibling links 指针跳转或递归遍历。

当前敲定“存在可复用的编译执行顺序”。M01-L5 进一步确定 GPU 稀疏传播需要等价的 Depth、连续 Child Adjacency 和 per-depth queue capacity 契约，但不要求它们一定以四个独立 Buffer 或一个全局 `levelOffsets` 数组存在。大场景静态根、GPU 动画骨架、Streaming block 的 block packing、压缩和增量重建仍需结合 M04 GPU ABI 和动画工作负载验证。

#### 已敲定：Compiled Hierarchy Block

整个 World 不永久编译成一个不可分割的巨型 CSR。Compiled GPU Hierarchy 由多个内部 Block 构成：

```text
CompiledHierarchy
├─ Environment/Streaming Block
├─ Static Root Batch Block
├─ Character Transform Block
├─ Skeleton/GPU Animation Block
└─ Other bounded hierarchy blocks
```

Block 是结构编译、上传和版本发布单位，不是用户 Entity、Gameplay Component、Scene class、npm 包或第二套 World。

概念 Header/数据：

```text
HierarchyBlockHeader
  blockId
  version
  nodeOffset
  nodeCount
  maxLocalDepth
  externalParent / parentBlock
  flags

Block execution data
  entityIndices[]
  localDepth[]
  parent references
  contiguous child offsets/indices
  level/queue capacity metadata
```

具体字段压缩和 Buffer 数量属于 M04；语义上必须提供连续 Children adjacency、Parent-before-child、Depth Queue capacity、Entity → Block 定位和版本信息。

#### Block 边界

强边界来源：

- Streaming chunk。
- Skeleton/GPU Animation hierarchy。
- 独立加载的 Scene Asset。
- 显式动态 hierarchy root。

大量很小、互不依赖的 Root 可以合并为 Static Root Batch Block，避免百万单节点 Root 产生百万 Block。过大的静态结构允许按目标容量拆 Block；目标容量不凭感觉锁死，结合 CPU compile、GPU queue、upload bytes 和浏览器内存基准决定。

CPU/Compiled metadata 保存等价于以下映射：

```text
blockIdByEntity[entityIndex]
```

用于从 Hierarchy Mutation 定位受影响 Block、GPU Seed 映射、Streaming 卸载、Debug 和 version 更新。默认概念为 `u32`；是否可压缩为 `u16` 取决于实际 Block 数量和稳定性要求。

#### 已敲定：Block Rebuild + Full Rebuild Fallback

无结构变化时：

```text
H = 0
→ 不重编译 Block
→ 普通 Transform/Gate 只走 GPU Propagation
```

普通结构事务的默认路径是收集并重建受影响 Block：

```text
Hierarchy Mutation Journal
→ old/new/moved subtree block ids
→ collect affected blocks
→ rebuild block execution data
→ upload new block segments
→ publish new descriptors/version
```

成本与受影响 Block 总节点数 B 相关，而不是固定 N。

以下情况使用 Full Rebuild 作为可靠回退：

- 大量 Root/Block 同时创建或删除。
- Streaming 场景整体切换。
- 结构变化覆盖 World 很大比例。
- Block merge/split 或碎片过多。
- Device Lost 后结构恢复。
- Block rebuild 无法满足一致性验证。

Full Rebuild 不是普通 frame 路径，但必须存在，避免局部编译器为了覆盖所有异常情况无限复杂化。

#### 明确不采用：Compiled GPU Hierarchy 逐节点原地 Patch

不在正在使用的 GPU CSR/Depth/Level 数据中逐节点插入、删除和修补 offset。该路径会引入可变 GPU 数组、空洞 allocator、offset 连锁失效、跨字段事务回滚、in-flight 数据竞争和难以验证的局部不一致。

采用不可变 Block segment 的版本化替换：

```text
Active Block version 7
→ 在 staging/new segment 构建 version 8
→ 验证 node/parent/depth/child ranges
→ commit/frame boundary 原子发布 descriptor version 8
→ version 7 在 GPU 安全后延迟释放
```

M04 负责 Block descriptor/GPU Scene 引用，M03 负责物理 segment 的 in-flight 安全和延迟释放。

#### Block merge/split 原则

跨 Block Reparent 不自动立即把两个 Block 永久合并。Compiler 根据强边界、节点规模和容量目标选择：

- Child Subtree 保持独立 Block，只修改 external parent。
- 小而稳定的普通 Block 在后续 rebuild 合并。
- 目标 Block 超过容量时保持独立或拆分。
- Streaming/Skeleton/GPU Animation 强边界不自动合并。

Detach 成 Root 时可以保持原 Block并把 external parent 改为 INVALID；不为追求每次都最紧凑而立即大范围重打包。

#### 批量导入与 Streaming

Importer/Worker 不逐 Entity 调用 `setParent()` 并反复 rebuild。批量路径直接提供 Parent/Block 描述，一次建立 Editable links 和 Compiled Blocks：

```text
entity indices
parent indices
block boundary metadata
asset/skeleton/streaming metadata
```

Streaming block 先离线/Worker 准备，commit 时发布；卸载先从 Active descriptors 移除，再按 CPU/GPU 生命周期规则延迟释放。Command 和异步发布协议在 M01-L8/M02/M04 深入。

#### 结构变化时序

```text
reparent/add/remove
  → Hierarchy Mutation Journal
  → World Commit
  → 验证 Handle、Parent 和 Cycle
  → 更新 Editable Hierarchy
  → 收集 affected Block
  → Block Rebuild 或 Full Rebuild fallback
  → 验证并版本化发布 Compiled Hierarchy
  → SceneDelta hierarchy/block updates + PropagationSeed
```

Hierarchy 没有结构变化时，跨 frame 复用已有 Transform Schedule。

#### Transform 变化时序

Local Transform 变化只标记 Transform Dirty。按照后文 W3，正式渲染使用的 World Transform 由 GPU 根据 Compiled Schedule 或其 GPU 等价执行数据传播；CPU 不为全部节点运行一套平行的 `matrixWorld` 更新。

父节点变化时，其后代 World Transform 可能全部失效。如何表示 subtree dirty、是否由 GPU 扩散，以及是否按 level 处理，将在本层后续讨论。

#### 性能与内存后果

CPU 基础索引概念成本：

```text
parent/firstChild/next/previous  16 bytes × Entity capacity
blockIdByEntity                   4 bytes × Entity capacity
```

百万 Entity 约 20 MB，不包含临时编译 staging 和 GPU Compiled Block。换来的收益是：

- 无 JS children arrays 和对象递归。
- 普通 frame 复用稳定顺序。
- CPU 低频查询和 GPU 批量传播来自同一结构真源。
- 不为支持 GPU Transform 而重做 Scene Runtime。

结构变化需要更新 links 和 Compiled Block，因此默认假设 Hierarchy 结构变化远少于 Local Transform/Animation 变化。性能模型：

```text
link/unlink                 O(1)
cycle check                 O(D)
enumerate direct children   O(F)
collect changed blocks      O(H)
block rebuild               O(B)
full rebuild fallback       O(N)
```

其中 D 是层级深度、F 是直接 Child 数、H 是结构 Mutation 数、B 是受影响 Block 总节点、N 是 World 总节点。普通 Transform/Gate 修改不 rebuild Block，只进入 O(S) GPU 稀疏传播。

#### 已敲定语义：默认 TRS + 受控 Affine 例外

- **Local Transform 语义：** 已敲定
- **Affine 物理 Store：** 待讨论

Local Transform 采用受控混合表示，但不是为每个 Entity 永久保存一份 TRS 和一份 Matrix。

默认路径：

```text
TransformTable[entityIndex]
  positionX / positionY / positionZ
  rotationX / rotationY / rotationZ / rotationW
  scaleX / scaleY / scaleZ
  transformMode
```

绝大多数普通节点、动态物体、相机、灯光、刚体控制节点和动画节点使用 TRS。`transformMode` 至少能区分普通 TRS 与 Affine Override；最终字段打包和 bit 布局后续结合 Dirty 与 GPU ABI 决定。

只有无法用 TRS 无损表达的 Local Transform 才进入 Affine 模式，例如包含 Shear、特殊 DCC 变换或不能稳定分解的导入矩阵。

Affine 模式最终可以使用稀有 Dense Set、tagged fixed record、资产级矩阵节点表或其他紧凑表示。当前不敲定 `AffineOverrideSet + affineRowByEntity`，因为其额外 reverse map、访问分支和内存收益尚未与更简单的固定宽度表示比较。

两种 Local 表示都必须在 Transform 传播阶段产生相同语义的 World Affine/World Matrix，Hierarchy、Renderable、Camera、Light 和下游 GPU Scene 不建立两套对象模型。

#### 导入与编辑规则

three.js/glTF 节点导入时：

```text
源节点提供明确 TRS
  → 直接写入默认 TRS

源节点提供 Matrix
  → 尝试按 three.js 等价算法分解并重组验证
  → 在容差内无损：保存 TRS
  → 存在 Shear / 分解不稳定 / 重组误差超限：保存 Affine Override
```

导入判断必须包含数值容差和重组校验，不能只因为 `Matrix4.decompose()` 返回结果就认为原矩阵可以由 TRS 无损表达。这里优先直接使用或迁移 three.js 已验证的 Matrix/Quaternion 分解算法，并增加 OEngine 的可表达性检查。

运行时 API 规则：

- `setPosition/setRotation/setScale/setTRS` 将节点切换到 TRS 模式，并结束其 Affine 当前语义。
- `setLocalMatrix` 先尝试无损 TRS 化；不能表达时进入 Affine 模式。
- Affine 节点是否允许直接参加骨骼动画或常规 TRS Animation Track，默认不做隐式混合；精确规则在 Animation/Skinning 接口讨论时敲定。
- Reparent 默认保持 Local；显式保持 World 的操作如果计算结果不能无损 TRS 化，必须允许进入 Affine 语义。完整契约见本层后文。

#### 为什么采用该方案

- TRS 是 Gameplay、Animation、插值、网络同步和用户编辑最自然的控制表示。
- 普通节点不保存冗余 Local Matrix，降低 CPU 内存和 Dirty 同步量。
- Affine Override 保留 three.js/DCC/glTF 中特殊矩阵节点的表达能力，不因核心走 TRS 而破坏导入结果。
- 物理实现应让 Affine 例外的成本可测，不能为了节省少量 float 引入大于收益的映射和分支系统。
- 下游仍只面对统一 World Transform，不形成 TRS Renderer 与 Matrix Renderer 两条路径。

#### 性能与复杂度后果

- 普通动态节点可以直接修改连续 TRS 字段，适合批量动画和 Dirty 标记。
- TRS 到 Local/World Matrix 的组合存在计算成本；当前决定是不建立全量 CPU Local Matrix Cache，后续只根据明确消费者和基准考虑局部缓存。
- Affine 物理布局需要用 A（Affine 数量）、N（全部节点）和实际导入资产分布比较内存、访问和转换成本。
- 如果实际资产中 Affine 节点占比异常高，需要由导入诊断报告暴露，不能静默让稀有路径退化成主路径。

#### 已否决的 Local Transform 方案

| 方案 | 否决原因 |
|---|---|
| 所有 Entity 只保存 TRS | 不能无损表达 Shear 和任意 Affine Matrix，会破坏部分 three.js/DCC/glTF 场景迁移 |
| 所有 Entity 只保存 Local Matrix | 动画、插值、Gameplay 修改和编辑器操作不自然；普通节点每次局部属性修改需要矩阵分解或额外控制状态 |
| 所有 Entity 永久同时保存 TRS + Local Matrix | 增加百万级场景 CPU 内存、同步和双真源一致性成本；Local Matrix 是否值得缓存应由变化模式决定 |
| TRS Entity 与 Matrix Entity 使用两套 Hierarchy/Renderer | 会复制 Transform、GPU Scene 和渲染路径，违背单一核心设计 |

#### 已敲定：W3——CPU 控制 Local，GPU 权威 Render World

采用分工明确、渲染真源唯一的 Transform 权威模型：

```text
CPU Scene Runtime
  ├─ Entity / Hierarchy 结构真源
  ├─ CPU-controlled 节点的 Local TRS/Affine 真源
  ├─ GPU Animation / Procedural Transform 的控制参数
  └─ Active Camera 专用 World 计算 + 低频按需查询
                       ↓ Dirty / Control Upload
GPU Transform Domain
  ├─ 接收 CPU Local 变化
  ├─ 生成 GPU Animation / Procedural Local Transform
  ├─ 按 Compiled Transform Schedule 传播 World Transform
  ├─ 维护 Render Current/Previous World Transform
  └─ 驱动动态 Bounds、Skinning 和后续 Culling
                       ↓
GPU Scene / Visibility / Rendering
```

最重要的单一真源规则是：

> 对所有渲染工作，GPU 中的 Render World Transform 是唯一权威表示。

Visibility、Meshlet、Bounds、Material Resolve、Lighting、Shadow、Motion Vector 和实际绘制不得转而消费一套 CPU `matrixWorld` 表。Camera 专用计算和低频查询不构成第二套 Renderer 或第二条 Transform 渲染路径。

#### Local Transform 权威

每个节点在任一时刻只能有一种“当前 Local Transform 生成权威”，不能让 CPU 和 GPU 同时自由写同一当前值：

```text
CPU-controlled：
  CPU Local TRS/Affine 是权威
  → 变化时只上传 Dirty Local/控制数据

GPU-animated / GPU-procedural：
  CPU 只拥有 Clip、Playback、State、Parameters 等控制状态
  → 当前动画 Local Transform 由 GPU 生成并保持在 GPU
```

GPU 动画节点在 CPU 侧可以保留 bind pose、导入值或重置所需的静态资产数据，但这些数据不是每帧当前动画姿态的同步镜像。Authority 切换、混合和状态迁移的精确协议留给 M01-L6 与 Animation Domain 讨论。

#### 已敲定：不为全部 Entity 永久缓存 CPU Local Matrix

CPU Scene Runtime 的默认 Local 真源是上一节确认的 TRS + 稀有 Affine Override：

- 普通 TRS 节点不额外永久保存一份 Local Matrix。
- Affine 节点的当前 Local 语义本身就是 Matrix/Affine，不再额外为它维护一份需要同步的 TRS Matrix Cache；具体物理字段仍待定。
- 导入验证、Reparent、Camera World 计算和调试可以临时 compose Local Matrix，并复用调用方提供的 scratch/out 参数。
- GPU 侧为了层级传播采用何种 packed local record，属于 M04 GPU ABI，不反向要求 CPU 为所有 Entity 保存对象式 `Matrix4`。

因此 CPU Local Matrix 的内存和更新成本不会固定随全部 Entity capacity N 增长。当前不建立通用 Local Matrix Cache；只有未来性能数据证明某个明确消费者反复计算成为瓶颈时，才为该消费者增加局部缓存。

#### 已敲定：GPU Current World Transform

渲染相关节点的 Current World Transform 长期驻留 GPU，并由 GPU Transform Domain 根据稳定的 Compiled Transform Schedule 更新：

```text
CPU Dirty Local + GPU-generated Local
  → GPU hierarchy propagation
  → GPU Current World Transform
  → Bounds / Skinning / Culling / Raster / Shading
```

静态节点上传和计算完成后可以跨很多帧复用；CPU-controlled 动态节点只上传变化的 Local/控制字段；GPU Animation 不把每帧姿态和 World Matrix 回传 CPU。具体是更新 Dirty Subtree、按 level dispatch，还是为某些 workload 使用其他批量策略，将与本层 Dirty 传播及 M04 数据布局继续敲定。

#### 已敲定：不建立通用 HostWorldSet

当前真实同步需求使用最小机制处理：

```text
Active Camera
  → 每帧沿 CPU 可解析 Parent Chain 计算一次 World Transform
  → 生成 View/Projection 并上传 Camera 数据

编辑器 / 调试 / 偶尔的外部查询
  → computeWorldMatrix(entity, out)
  → 沿 Parent Chain 临时组合，完成后不建立持久缓存
```

不实现通用 `HostWorldSet`、`acquire/release`、祖先引用计数、Host World dense table 或自动缓存所有查询对象。Light、Renderable、Bounds 和普通动画节点不会仅因为存在 CPU World API 就获得 CPU `matrixWorld` 镜像。

`computeWorldMatrix(entity, out)` 的基本契约：

- 使用调用方提供的输出对象或 TypedArray，不制造临时 Matrix 对象链。
- 时间复杂度与查询节点的 Parent Chain 深度 D 相关，不扫描场景总量 N。
- 只对 CPU 可解析的 Local/祖先链提供当前精确结果。
- 遇到当前值由 GPU Animation/GPU Procedural 生成的祖先时，返回明确的不可同步解析结果。
- 普通同步查询不得隐式触发 GPU stall 或 Readback。

如果未来出现“每帧重复查询同一批大量节点”的已测瓶颈，再为明确消费者设计选择性缓存或 CPU mirror；当前不提前建设通用系统。Physics、Audio 和 Gameplay 也不默认通过 Renderer 反向读取整个场景，它们应拥有自己的逻辑状态，并只在确有桥接需求时调用显式查询。

#### 已敲定：Previous World Transform 由 GPU 维护

用于 Motion Vector、TAA、Temporal Effects 和动态遮挡判断的 Previous World Transform 属于 GPU 渲染历史：

- 不由 CPU 每帧保存并上传全量 Previous Matrix。
- GPU Transform/History Pass 在更新 Current World 时维护所需历史。
- Camera 的 previous view/projection 等 Host 控制历史可以单独上传，但不改变 Instance Previous World 的 GPU 权威。
- Static/unchanged 节点应允许以 Current World 等价表示 Previous World，避免无意义复制。

Previous World 最终采用全量双缓冲、动态稀疏 History Set、dirty-copy + motion flag，还是分类型混合布局，属于 M04 GPU Scene ABI 与 Temporal/Motion Vector 契约，当前只敲定其权威和维护位置。

#### 已敲定：Reparent 默认保持 Local，保持 World 必须显式请求

Reparent 的核心默认语义是只改变 Hierarchy，不隐式改写 Local Transform：

```text
setParent(child, newParent)
  → child Local TRS/Affine 保持不变
  → Parent 关系改变
  → child 及受影响后代的 Render World 由 GPU 重新传播
```

例如：

```text
旧 Parent World X = 10
Child Local X      = 2
Child World X      = 12

新 Parent World X = 100
Reparent 后 Child Local X 仍为 2
新的 Child World X = 102
```

采用该默认语义的原因：

- Reparent 是结构修改，不应默认隐藏一次 Local Transform 重写。
- 不需要 CPU 先取得 Child/New Parent 的精确 World Matrix。
- 即使节点属于 GPU Animation/GPU Procedural 权威，也可以表达结构关系变化。
- 与 glTF 常规层级语义和 three.js `Object3D.add()` 的使用直觉一致。
- Change Journal 可以明确记录 Hierarchy Change，并将 Child Subtree 标记为需要重新传播 World。

默认 Reparent 的概念变化：

```text
HierarchyChanged
  child
  oldParent
  newParent

Transform consequence
  Local unchanged
  World subtree invalidated
```

#### 显式低频操作：保持 World Transform

编辑器换挂点、相机 Rig 调整、装备节点切换等场景可能要求 Hierarchy 改变但画面中的 World Transform 保持不变。该需求使用显式辅助操作，而不是改变默认 Reparent：

```text
setParentKeepingWorld(child, newParent)  // 概念名称
```

数学语义：

```text
oldChildWorld = currentWorld(child)
newParentWorld = currentWorld(newParent)

newChildLocal = inverse(newParentWorld) × oldChildWorld
```

然后原子提交：

```text
验证 Handle、Cycle 和 Authority
→ 计算并验证 newChildLocal
→ 更新 Parent
→ 写入新的 Local Transform
→ 产生 Hierarchy + Local Transform Change
→ GPU 重新传播受影响 World
```

具体公开 API 名称由 M01-L7 决定；M01-L4 只确定两种操作语义。three.js 生态迁移可以建立如下对应：

```text
THREE.Object3D.add()    ≈ 默认保持 Local
THREE.Object3D.attach() ≈ 显式保持 World
```

矩阵求逆、矩阵乘法、TRS 分解和重组校验优先直接使用或迁移 three.js 的成熟数学实现，但运行时数据接口仍使用 OEngine 的 TypedArray/无临时对象路径。

#### 保持 World 的同步执行限制

`setParentKeepingWorld()` 只支持 CPU 能够取得精确当前值的 Transform 链：

- Child 当前 World 可以由 CPU Local/Hierarchy 解析。
- New Parent 当前 World 可以由 CPU Local/Hierarchy 解析。
- 所需祖先链中不存在当前值仅由 GPU Animation/GPU Procedural 生成的节点。

如果必要节点是 GPU-authored，普通同步操作返回明确的不可执行结果，不允许：

- 隐式 GPU Readback。
- 等待 GPU 完成造成 stall。
- 使用上一帧结果伪装成当前精确 World。
- 为一次 Reparent 在 CPU 镜像完整 GPU Animation/Skeleton。

未来如果确有 GPU-authored attachment 需求，可以单独设计异步 Readback、延迟操作或选择性 CPU anchor/bone mirror；它们不进入当前同步 Reparent 契约。

#### Affine 与失败原子性

`inverse(newParentWorld) × oldChildWorld` 的结果不保证仍能由纯 TRS 无损表达。非均匀缩放与旋转组合可能产生 Shear，因此：

```text
newChildLocal
  → 尝试 TRS 分解
  → 重组并按容差验证
  → 无损：保存 TRS
  → 不能无损：保存 Affine 语义
```

如果 New Parent World 不可逆，例如某个缩放轴为零，则无法可靠保持 World。操作必须在修改 Hierarchy 前失败：

```text
Parent 不改变
Local 不改变
不产生部分 Change
返回 NonInvertibleParentTransform 或等价错误
```

Cycle、无效 Handle、PendingDestroy、跨 World 非法 Parent 和矩阵计算失败都遵守同样的原子失败规则。

#### 与 Previous World / Motion Vector 的契约

默认保持 Local 的 Reparent 通常会改变 World Transform：

```text
Previous World = 改挂前的位置
Current World  = 新 Parent 下的位置
→ 产生真实 Object Motion
```

显式保持 World 的 Reparent 理论上不改变最终世界位置：

```text
Previous World ≈ Current World
→ 不应仅因 Hierarchy 改变产生额外 Motion Vector
```

两种操作都会使 GPU Transform/Bounds 的依赖关系失效并要求重新传播，但 History 系统必须以最终 Previous/Current World 数值决定运动，而不是把所有 Hierarchy Change 无条件标记为大幅运动。

#### 性能后果

- 默认 Reparent 不做矩阵求逆或 Local 重写，CPU 成本主要是结构验证、Cycle 检查、邻接更新和 Change append。
- 保持 World 是低频工具操作，额外成本与两条 CPU 可解析 Parent Chain 深度和常数次矩阵计算相关，不进入普通每帧 Transform 热路径。
- 两种操作的 GPU 成本都与受影响的 World Subtree S 相关；是否能局部 schedule rebuild 和 dirty propagation 留给本层后续决定。
- 不为低频保持 World 操作建设通用 CPU World Cache 或 GPU Readback 通道。

#### 已敲定：RenderWorld 是多根森林

一个 RenderWorld 不强制创建真实 Scene Root Entity。任何满足以下条件的 Entity 都是 Root：

```text
parent = INVALID_ENTITY
```

因此同一个 World 可以自然包含多个独立根子树：

```text
RenderWorld
├─ EnvironmentRoot
│  ├─ Buildings
│  └─ Vegetation
├─ CharacterRoot
└─ CameraRigRoot
```

Root Entity 仍是普通 Entity，拥有正常 Local TRS/Affine。其 World Transform 定义为：

```text
World(root) = Local(root)
```

如果用户希望整体移动一个导入场景、Streaming block 或对象组，可以显式创建普通 Group Root；不需要 Scene class、特殊 Root Component 或隐藏用户 Entity。

Compiled Transform Schedule 可以在内部使用 Virtual Root 统一组织多个 Root，但 Virtual Root：

- 没有 EntityHandle。
- 不占普通 Entity slot。
- 没有用户可编辑 Transform。
- 不写入普通 GPU Entity/Transform Record。
- 只存在于 Schedule 编译或调度概念中。

将 Entity 解除 Parent 时，新 Parent 使用 `INVALID_ENTITY`：

```text
setParent(child, INVALID_ENTITY)
  → 默认保持 Local
  → 新 World = 原 Local

setParentKeepingWorld(child, INVALID_ENTITY)
  → Virtual Parent World 视为 Identity
  → 新 Local = 原 World
```

后者如果不能无损 TRS 化，进入 Affine 语义。

#### 已敲定：Entity 只能属于一个 RenderWorld

Entity 在其生命周期内由唯一 RenderWorld 拥有，Hierarchy 边只能连接同一个 World 内的 Entity。跨 World Parent 属于非法输入，不能伪装成普通 Reparent。

跨 World 移动涉及：

- 新的 Entity slot/Handle 归属。
- Asset 引用与 Change Journal。
- GPU Scene slot 和派生状态。
- Animation/Skinning、Bounds、Light/Camera 等专用数据。
- 旧 World 删除与新 World 创建的提交顺序。

因此未来若有需要，应提供显式的 `cloneToWorld`、`transferToWorld` 或 serialize/import 事务，而不是扩展 `setParent()`。

应用可以创建多个独立 RenderWorld，但它们使用同一套 OEngine Scene Runtime/GPU Scene/Renderer 架构，不形成 StaticWorld/DynamicWorld 或 three.js/OEngine 双核心。每个 World 内可以拥有多个 Root 和多个 Camera。以下内容后续再确定：

- EntityHandle 如何在 API/Debug 中检测传错 World；移交 M01-L7。
- 多 World 是否共享同一 Engine 级 Asset Registry/Residency。
- 多 World 同帧渲染、切换、叠加和合成；移交 M04/M06/M13。

#### 已敲定：不引入通用 Entity.enabled

Scene Runtime 不给所有 Entity 定义一个可以隐式控制全部模块的通用 `enabled`。否则一个 boolean 会同时产生以下不明确问题：

- Transform 是否停止传播。
- Children 是否全部停止。
- Animation timeline 是否暂停。
- Light、Camera、Particle 是否失效。
- GPU Scene/Asset Residency 是否释放。
- 再启用时是否追赶动画和派生状态。

这些行为属于不同领域和生命周期，不能由一个通用 Entity 状态暗中联动。各领域使用自己的明确状态，例如：

```text
Renderable.renderEnabled
Light.lightEnabled
Animation.playing / paused
Camera 是否被选为 Active View
ParticleEmitter.emitting
```

这些 Component 状态只控制其声明的能力，不自动删除 Entity、停止 Transform 或修改其他 Component。

#### 已敲定：Hierarchy Render Gate

为了支持 Group/Scene 子树隐藏以及迁移 three.js `Object3D.visible` 语义，Hierarchy 提供一个明确的本地渲染参与开关：

```text
localRenderEnabled
```

GPU/Hierarchy 派生状态：

```text
effectiveRenderEnabled(root)
  = localRenderEnabled(root)

effectiveRenderEnabled(entity)
  = localRenderEnabled(entity)
  AND effectiveRenderEnabled(parent)
```

`localRenderEnabled` 是子树 Render Gate，不使用 `visible` 命名。`Visible` 专门保留给某个 View 在 Frustum/HZB/Meshlet Culling 后产生的每帧 GPU 可见结果，避免“用户允许渲染”和“这一帧实际可见”混为一谈。

three.js 导入的基础语义对应为：

```text
THREE.Object3D.visible
  → OEngine localRenderEnabled
```

具体白名单和特殊对象行为由 M00 Import Contract 再验证。

#### Hierarchy Gate 与 Component Gate 的组合

Hierarchy Gate 控制子树是否允许参与渲染领域；Component Gate 只控制当前 Entity 上的具体能力：

```text
Renderable participates
  = effectiveRenderEnabled(entity)
  AND Renderable.renderEnabled

Light participates
  = effectiveRenderEnabled(entity)
  AND Light.lightEnabled
```

这两个状态解决不同真实需求：

- `localRenderEnabled = false`：隐藏整个 Group 子树的渲染参与。
- `Renderable.renderEnabled = false`：只隐藏当前 Entity 的 Mesh，Children 仍可参与。
- `Light.lightEnabled = false`：只关闭当前 Light，不影响同一节点或子树的其他渲染能力。

后续 Probe、Decal、Emitter 等渲染参与组件遵循相同的显式组合原则，但不因此要求一个通用 Component Framework。

#### Render Gate 不暂停更新或释放资源

`effectiveRenderEnabled = false` 只表示当前不进入渲染相关 Work Generation，不自动执行：

- 停止 Transform/Hierarchy 更新。
- 暂停 Animation timeline。
- 停止 Gameplay、Physics 或 Audio。
- 删除 GPU Scene Record。
- 释放 Mesh、Material、Texture 或其他 Asset Residency。
- 清除 Previous Transform/Temporal 所需状态。

这样重新显示子树时，它可以直接处于当前正确姿态，不需要先恢复一套被通用 enabled 隐式冻结的状态。

不可见时是否降低 Animation、Bounds、Skinning 或 Streaming 更新频率，属于后续领域 Budget/Update Policy，例如：

```text
AnimationUpdatePolicy
  Always
  WhenRenderEnabled
  Budgeted
```

这些策略必须由对应模块显式定义，不能改变 Render Gate 的基础语义。

#### Camera 规则

Camera 的 Transform 正常继承 Parent，但它是否作为 View 使用由 Renderer/View 显式选择，不由 Hierarchy Render Gate 决定：

```text
renderer.render(world, camera)
```

因此隐藏 CameraRig 的辅助 Mesh 或其他渲染内容，不会意外让已选 Camera 失效。Camera 自身的 enabled/active API 是否需要存在，移交 Camera/View 输入契约；基础规则是“View 选择显式，Render Gate 不接管 View 生命周期”。

#### GPU 派生与性能模型

CPU 修改 Group 的 Render Gate 时：

```text
setRenderEnabled(entity, value)
  → 验证 Handle
  → 写 localRenderEnabled
  → append HierarchyRenderGate Change
```

CPU 不立即遍历并改写全部后代 Renderable。GPU 可以复用 Compiled Hierarchy/Transform Schedule 或其等价执行数据传播 `effectiveRenderEnabled`，Visibility 在早期读取该 Gate：

```text
if (!effectiveRenderEnabled) {
  reject work before expensive culling/material processing
}
```

设受影响子树大小为 S：

```text
CPU 修改：O(1) Handle/field/change append
Upload：O(1) local gate change
GPU 派生：目标随受影响子树 S 增长，而不是 CPU O(S) 展开上传
```

具体是合并进 Transform/Hierarchy Pass，还是使用独立轻量 Hierarchy State Pass，留给 M04/M06 根据数据布局和更新频率决定。无结构或 Gate 变化时复用 GPU 中已有 `effectiveRenderEnabled`，不每帧由 CPU 重建。

#### W3 性能模型

设：

```text
N = 场景全部节点
K = 本帧 CPU 修改的 Local Transform 数量
G = 本帧 GPU Animation/Procedural 更新及其受影响节点
R = 本帧 localRenderEnabled 修改数量
C = 本帧需要 CPU 计算的 Active Camera 数量
D = Camera 或一次性查询的平均 Parent Chain 深度
Q = 本帧显式一次性 World 查询数量
```

目标工作分布：

```text
CPU：约随 K + R + (C + Q) × D 变化
GPU：约随 K/R 的受影响子树 + G 变化
Upload：约随 K + R + 少量控制参数变化
```

不接受普通帧 CPU 工作和上传固定退化为 O(N)。Hierarchy 结构变化仍可能触发更大范围的 schedule/depth 更新，但它被定义为低频结构事务，不等同于每帧 Transform 传播。

#### 采用 W3 的原因

- 保留 Camera 和低频工具查询所需的同步 CPU 空间能力，但不建立全量镜像或通用缓存系统。
- 大规模动画、层级传播、Bounds 和 Skinning 可以直接留在 GPU，不经过 CPU 回传。
- CPU 修改只上传 Local/控制差量，而不是上传全部 World Matrix。
- Static World 数据可以长期驻留并跨帧复用。
- Renderer 始终只有一份 GPU World Transform 真源，不形成 CPU 与 GPU 双渲染路径。

#### 已否决的 World Transform 权威方案

| 方案 | 否决原因 |
|---|---|
| W1：CPU 为全部节点维护 World Matrix | 大量动态节点和父级变化会产生 CPU 层级传播与上传压力；GPU Animation 最终仍被迫绕回 CPU |
| W2：全部节点只允许 GPU World、CPU 无任何同步计算 | Camera 和低频工具查询只能依赖 Readback，产品 API 过于僵硬 |
| CPU/GPU 同时自由写同一 Current Local/World | 数据竞争、覆盖顺序和历史语义不明确，无法建立可靠 Dirty 与 Motion Vector 契约 |
| CPU 保存完整 World Mirror 但声明 GPU 是权威 | 实际上仍承担 O(N) 内存、一致性和潜在计算成本，并诱导下游模块读取错误真源 |

#### 已否决：传统对象树

Object + `children[]` 会引入大量 JS Array、对象跳转、GC 和不连续访问，并重新走向 three.js Object3D Scene Tree。

#### 已否决：只使用 intrusive hierarchy links 执行 Transform

`parent/firstChild/nextSibling` 适合结构编辑，但直接沿 links 传播 Transform 会产生跳跃访问，也不适合 GPU 层级并行。

#### 已否决：只有 parent 数组、每次需要时扫描全 World 找 children

该方案结构极简，但 subtree dirty、remove/reparent 和局部重编译都可能退化为扫描 N 个 Entity，不符合大场景要求。

#### 本层尚未敲定

- Local Authority 模式切换以及 CPU-controlled/GPU-animated 节点混合的精确协议。
- GPU Current/Previous World Transform 的物理布局和历史更新算法；移交 M04/Temporal 契约。
- `computeWorldMatrix()` 的错误返回形式、scratch 复用和 GPU-authored ancestor 诊断；移交 M01-L7。
- Compiled GPU Hierarchy 的增量重建、Depth 上限和 Buffer packing；基础传播契约移交 M01-L5/M04。
- Reparent/attach 的最终公开命名、返回错误类型和批量 Command 表达；移交 M01-L7/M01-L8。
- `localRenderEnabled` 的 CPU 字段打包和 GPU `effectiveRenderEnabled` 物理位置；Change 语义由 M01-L5 敲定，物理位置移交 M04。
- 多 World 的 Handle 调试、共享 Asset/GPU Residency 和同帧合成协议；移交 M01-L7/M02/M04/M06/M13。

### 5.7 M01-L5 · Mutation Tracker / SceneDelta / GPU Propagation Contract

- **架构与语义状态：** 已敲定
- **CPU TypedArray/Record packing：** 待讨论
- **GPU Queue/Depth/Capacity packing：** 待 M04 细化与原型验证

#### 5.7.1 总体数据流

Change Architecture 分成三个连续阶段，每个阶段只承担一种职责：

```text
World/API Mutation
        ↓
CPU Mutation Tracker
  记录直接变化、生命周期和结构事务
        ↓ commit
SceneDelta Compiler
  合并最终状态，生成稳定只读差量协议
        ↓
GPU Scene Apply + Hierarchy Propagation
  写入常驻表，传播 World/Gate/Bounds 派生状态
        ↓
Visibility / Lighting / Rendering
```

| 阶段 | 负责 | 明确不负责 |
|---|---|---|
| Mutation Tracker | 谁被直接修改、修改类别、生命周期和结构事务 | 不展开后代，不计算 World，不操作 GPU |
| SceneDelta Compiler | 覆盖 Create/Update/Destroy、合并最终状态、生成模块间协议 | 不执行 GPU Transform，不保存 setter 历史 |
| GPU Apply/Propagation | 写入 GPU Scene、传播 World/Gate/Bounds | 不理解用户调用了多少次 setter，不读取 three.js 对象 |

这是一条 Change Pipeline，不是三套互相同步的 Dirty 系统。

#### 5.7.2 Mutation Epoch

Scene Runtime 以 Mutation Epoch 组织一次提交周期：

```text
Epoch begin
  → create/update/reparent/destroy
  → Mutation Tracker coalesce
  → commit
  → 生成 SceneDelta(epoch)
  → GPU Scene 消费
  → 清理本 Epoch 临时状态
```

Epoch 可以对应普通 frame update，也可以对应显式批量导入/Streaming 事务。它是确定 Change 边界的内部概念，不要求所有公开 API 暴露 `begin/end`；同步 API 可以在 World 当前 Epoch 中直接写入。

SceneDelta 只代表一个 Epoch 的最终差量，不是永久 Event Log。需要 Undo/Redo、Gameplay Event 或操作回放时，必须使用独立系统。

#### 5.7.3 CPU Mutation Tracker

所有直接变化通过 Entity index 聚合：

```text
changeMask[entityIndex]: u32
touchedEntities: dense u32 list
```

建议的语义位：

```text
LOCAL_TRANSFORM
HIERARCHY
LOCAL_RENDER_GATE
RENDERABLE
CAMERA
LIGHT
ANIMATION_CONTROL
SKINNING_CONTROL
```

Mask 只表示 CPU/上层直接修改了什么，不放入 `WORLD_TRANSFORM`、`EFFECTIVE_RENDER_GATE` 或 `WORLD_BOUNDS` 等 GPU 派生状态。

标记规则：

```text
touch(index, bits):
  old = changeMask[index]
  if old == 0:
    append touchedEntities(index)
  changeMask[index] = old OR bits
```

同一 Entity 在一个 Epoch 内多次修改 Position、Rotation、Scale、Renderable 和 Gate，`touchedEntities` 仍只有一个 index，Mask 合并全部直接变化。

Commit/消费完成后只清理 `touchedEntities` 中的项：

```text
for index in touchedEntities:
  changeMask[index] = 0
clear touchedEntities
```

不执行每帧 `changeMask.fill(0)`，因此 CPU 清理成本随实际变化量 K 增长，不随 capacity N 增长。

#### 5.7.4 Sparse Hierarchy Mutation Journal

Hierarchy 变化除 `HIERARCHY` bit 外，还需要保留 Epoch 开始时的原始 Parent，以支持事务合并、Schedule Compiler 和诊断。

稀疏记录：

```text
HierarchyMutation
  child: u32
  originalParent: u32
```

第一次修改某个 Child Parent 时：

```text
if child 尚未带 HIERARCHY bit:
  append HierarchyMutation(child, currentParent)

验证 Handle/World/Cycle
→ 更新 Editable Hierarchy 当前 Parent
→ 设置 HIERARCHY bit
```

最终 Parent 不在每次操作中追加，而是在 commit 时读取当前 `parent[child]`：

```text
A → B → C → D

Journal:
  originalParent = A

Commit:
  finalParent = D
```

如果最终 Parent 又回到 originalParent，并且没有其他净结构后果，Commit Compiler 可以把它识别为无净 Reparent。中间每次同步操作仍必须立即验证 Cycle 和跨 World 引用，不能为了合并而允许 World 暂时进入非法环。

Journal 只随实际结构变化数量 H 增长，不为全部 N 个 Entity 固定保存 `oldParentSnapshot`。

#### 5.7.5 Lifecycle Transaction

生命周期使用独立紧凑列表：

```text
createdEntities[]
destroyedEntities[]
wholeBlocksToRemove[]
partialBlocksToRebuild[]
```

`destroyedEntities` 对 Subtree Destroy 使用可复用迭代 work stack 收集，并以 Children-before-Parent 的清理顺序编译；不在 SceneDelta Compiler 中重新递归遍历 World。

覆盖规则：

| Epoch 内行为 | SceneDelta 输出 |
|---|---|
| Create 后多次 Update | 一个包含最终完整状态的 Create |
| 已存在 Entity Update 后 Destroy | 只输出 Destroy，普通 Update 被覆盖 |
| Create 后在首次 GPU commit 前 Destroy | 可以取消 Create/Destroy GPU 事务，CPU Handle 仍按生命周期规则失效 |
| PendingDestroy 后再次 setter | 拒绝，不产生普通 Change |

所有进入 PendingDestroy 的 Entity，其普通 `changeMask` 在 SceneDelta 编译时被 Destroy 覆盖。完整 Block 删除优先输出 descriptor removal，不重建其内部 Hierarchy；只有部分覆盖 Block 才进入 rebuild。

Create/Destroy 的 generation、slot 回收和 CPU/GPU 延迟释放仍遵守 M01-L2 与 M03/M04 的边界。

#### 5.7.6 SceneDelta 模块间协议

Commit 生成只读的语义差量：

```text
SceneDelta
  epoch

  creates
  destroys

  changedEntities
  changeMasks

  hierarchyMutations
  compiledHierarchyBlockUpdates
  hierarchyBlocksToRemove
  propagationSeeds
```

示例：

```text
creates:
  [12, 18]

destroys:
  [91]

changes:
  entity 27: LOCAL_TRANSFORM | RENDERABLE
  entity 35: LOCAL_RENDER_GATE
  entity 42: HIERARCHY

hierarchy:
  child 42
  originalParent 8
  finalParent 16
```

逻辑结构不等于为每条记录创建 JS object。物理实现使用可复用 TypedArray、linear arena、chunk 或 ring；具体 packing 在 M01-L5 后续物理层和 M03 Upload 讨论。

SceneDelta 是：

- M01 Scene Runtime 的正式输出。
- M04 GPU Scene 的正式输入。
- Diagnostics/Stats 可以观察的确定性提交边界。
- 单 Epoch 临时协议；GPU Scene 消费后即可复用其 staging memory。

SceneDelta 不是：

- Undo/Redo 历史。
- Gameplay Event Bus。
- 网络复制协议。
- three.js 对象同步日志。
- Device Lost 后唯一恢复来源；恢复仍从 World/Asset 稳定真源重建。

#### 5.7.7 CPU Change Mask 与 GPU Propagation Mask 分离

CPU Change 表示“直接改了什么”；GPU Propagation 表示“哪些派生状态必须沿 Hierarchy 重新计算”。两者不能共用一个不断膨胀的 Enum。

基础 GPU 传播位：

```text
PROPAGATE_WORLD       = 1 << 0
PROPAGATE_RENDER_GATE = 1 << 1
```

语义映射：

```text
CPU LOCAL_TRANSFORM
  → PROPAGATE_WORLD

CPU HIERARCHY
  → PROPAGATE_WORLD
  → PROPAGATE_RENDER_GATE

CPU LOCAL_RENDER_GATE
  → PROPAGATE_RENDER_GATE

GPU Animation 生成 Local
  → PROPAGATE_WORLD
```

World 更新时，对存在 Renderable/Light/Probe 等空间组件的节点更新其 World-space 派生数据和 Bounds。Skinning/Morph 在 World 不变时也可能改变 Bounds，这类额外传播请求由 Animation/Geometry Domain 增加，不污染 CPU Scene Change Mask。

SceneDelta Compiler 为派生失效生成紧凑 Seed：

```text
PropagationSeed
  entityIndex: u32
  propagationMask: u32
```

同一 Entity 的 Seed 在 CPU touched pass 中合并一次；不同祖先/后代 Seed 的覆盖关系不由 CPU setter 向上遍历判断。

#### 5.7.8 Commit 逻辑顺序

固定逻辑顺序：

```text
1. Freeze 当前 Mutation Epoch
2. 解析 Create/Update/Destroy 覆盖关系
3. 得到最终 Parent 关系
4. 完成 Handle、World、Cycle 和结构一致性验证
5. 更新/编译必要 Editable/Compiled Hierarchy 派生数据
6. 汇总 Direct Change 与最终 Store 行
7. 生成 PropagationSeed
8. 生成只读 SceneDelta
9. GPU Scene Apply Direct Changes
10. GPU Animation/Procedural 等 Local Producer 写入当前 Local，并合并 PropagationSeed
11. GPU Hierarchy Propagation
12. 完成 Visibility 前必需的 Bounds/空间派生更新
13. Visibility/Culling/Rendering
14. 清理/复用本 Epoch CPU staging
```

这是语义顺序，不要求十四个独立函数或 Pass。实现可以合并 CPU 循环和 GPU Pass，但必须保证所有 CPU/GPU Local Producer 已完成，并且新的 World/Bounds/Gate 在 Visibility 读取前已经可用。

#### 5.7.9 GPU 稀疏层级传播架构

- **传播方向：** 已敲定
- **具体 Buffer packing、Depth 上限与 Dispatch 组合：** 待 M04 原型验证

Compiled GPU Hierarchy 提供等价于以下信息的连续执行表示：

```text
depth[entity]
childOffsets[entity + 1]
childIndices[]
levelCapacityOffsets[]
```

CPU Editable Hierarchy 可以采用 links/其他邻接结构；GPU 执行表示在结构 commit 后编译，面向连续 Children 读取和 parent-before-child 传播。

GPU 长期状态概念：

```text
pendingPropagationMask[entity]: atomic<u32>
propagationQueue[entityCapacity]
queueCountByDepth[maxDepth]
dispatchArgsByDepth[maxDepth]
```

Seed 阶段：

```text
old = atomicOr(pendingMask[entity], seed.mask)

if old == 0:
  depth = depth[entity]
  append entity to queue segment of depth
```

按 Depth 从浅到深执行：

```text
mask = pendingMask[entity]

if mask contains PROPAGATE_WORLD:
  update Previous/Current World according to History contract
  currentWorld = parentWorld × local
  update required World Bounds/spatial data

if mask contains PROPAGATE_RENDER_GATE:
  effectiveRenderEnabled =
    parentEffectiveRenderEnabled AND localRenderEnabled

for child in contiguous children:
  atomicOr child pending mask with propagated bits
  enqueue child once into its depth queue
```

按 Depth 处理是必要依赖，不是任意复杂化：WebGPU 单个 Dispatch 不提供跨 Workgroup 全局 Barrier，必须保证 Parent World/Gate 完成后 Child 才读取。

该结构的目标：

- CPU 不展开子树。
- 多个重叠 Dirty Root 的 Mask 在 GPU 合并。
- Parent 和 Child 同时直接变化时，Child 在自己 Depth 执行前得到完整合并 Mask。
- 一个 Entity 在一个传播 Epoch 中最多进入对应 queue 一次。
- GPU 派生工作随实际受影响节点 S 增长，不每帧固定扫描 N。

`maxDepth`、queue segment、atomic contention、多个 Depth 是否能合并 Pass，以及极深异常 Hierarchy 的诊断/降级，需要 M04 原型验证。验证失败时可以调整物理算法，但不能退回 CPU 展开所有后代或全量上传 World Matrix。

#### 5.7.10 Direct Upload 与 Derived Propagation 分离

例如 Local Transform 修改：

```text
CPU/GPU Upload：
  新 Local TRS/Affine 行

GPU Derived：
  Current World
  Previous World 关系
  Descendant World
  World Bounds
```

M04/M03 可以根据 K 和数据离散程度选择：

- 合并少量连续 Dirty Range 后直接 `writeBuffer`。
- 将大量离散 Row 打包为连续 Staging Records，再用 Compute Scatter 写入长期 GPU Table。

两种上传物理策略消费同一个 SceneDelta，不改变 M01 Change 语义，也不允许 CPU 计算后代 World 再逐行上传。

#### 5.7.11 Worker/Command Buffer 演进

长期并发结构采用“Worker 生成 Command，单一 Commit 合并”，而不是让多个 Worker 直接 Atomics 修改共享 World Store：

```text
Main/API Mutations
Worker Import/Streaming Commands
Animation Control Commands
              ↓
       Command Merge Boundary
              ↓
        Single Mutation Epoch
              ↓
             Commit
```

这样 generation、Hierarchy、生命周期和 Change 顺序仍由一个确定性提交点管理。Command 格式、临时 Entity Token、冲突规则和 Worker memory ownership 在 M01-L8 深入。

#### 5.7.12 性能模型

设：

```text
N = World 全部 Entity
K = 本 Epoch 直接变化 Entity
H = 净 Hierarchy Mutation 数量
C = Create 数量
D = Destroy 数量
S = GPU 实际受影响的 Hierarchy 节点数量
L = 实际最大受影响 Depth/编码的 Depth Dispatch 数
```

目标：

```text
Setter/mark CPU        O(1)
Mutation coalesce CPU  O(K)
Hierarchy Journal CPU  O(H)
Commit CPU             O(K + H + C + D)
CPU Upload             随直接变化数据增长
GPU Propagation        O(S) + O(L) dispatch overhead
```

明确禁止：

- 每帧扫描或清空全部 N 个 Change 项。
- Setter 时向上遍历祖先做 Dirty Root 覆盖判断。
- CPU 为 Dirty Root 展开全部后代。
- CPU 重算并上传所有后代 World/Bounds/Gate。
- 把 Visible/Propagation 结果 Readback 后再决定绘制。

#### 5.7.13 明确不做

- 不实现通用 ECS Observer/Reactive Component Framework。
- 不为每次 setter 分配 JS Event Object。
- 不把 SceneDelta 扩展为通用 Event Bus、Undo、Network Replication 或脚本事件系统。
- 不要求所有 Worker 直接共享和原子写 Mutation Tracker。
- 不在 CPU 进行全量 Subtree Dirty expansion。
- 不把 GPU Propagation Mask 暴露成用户 API。

#### 5.7.14 尚未敲定的物理细节

- `changeMask` 位宽、TypedArray packing 和 Store-specific payload 描述。
- SceneDelta linear arena/ring 的容量增长、跨 frame 生命周期和 Debug capture。
- Hierarchy Mutation Record 的具体编码和 no-op Reparent 消除时机。
- Direct Upload 的 range merge 与 compute scatter 阈值。
- GPU CSR/adjacency 的增量重建或 block rebuild。
- Depth Queue、Indirect Args、atomic mask 和异常深层级处理。
- Propagation 与 Transform/Bounds/Animation Pass 的 FrameGraph 合并方式。

### 5.8 Scene Runtime 总体性能与复杂度后果

- 修改发生时直接标记 Dirty，CPU 工作主要随本帧变化量 K 增长，而不是随场景总实体数 N 增长。
- 固定 Table/Set 可以批量写入和上传，避免为每个渲染对象创建复杂 JS class。
- Scene Runtime 保留结构与控制权，但最终 Transform、Animation、Bounds 等高成本派生状态可以按模块设计迁移到 GPU。
- OEngine 只承担渲染需要的 Entity 生命周期、Transform 层级、专用 Set、Dirty 和 Handle 安全性，不承担完整游戏 ECS。

### 5.9 Scene Runtime 明确不做

- 不让 Scene Runtime 变成完整 Gameplay World。
- 不保存 three.js Object3D 作为组件真源。
- 不允许用户注册任意 Gameplay Component。
- 不实现通用 Archetype、Query 和 ECS Scheduler。
- 不在 World 中拥有 Geometry、Material、Texture 资产本体。
- 不在 CPU World 中构造可见 Render List、材质排序或逐对象 Draw Command。

### 5.10 M01 尚未讨论的问题

- Compiled Block 的目标容量、Root batch/静态拆分启发式和 Full Rebuild 阈值。
- Editable → Compiled Block Compiler 的 block rebuild、Depth 限制和 GPU Buffer packing。
- Affine 例外的最终 Store 布局。
- Local Authority 切换、GPU Animation 混合和同步诊断。
- RenderableSet row 稳定性、删除与 Dirty 映射。
- Bounds 的 CPU/GPU 权威和 Store 位置。
- SceneDelta 的物理字段、staging arena、capture 和 upload 策略。
- World/Entity API、`computeWorldMatrix()` 错误行为和无分配 Handle 表示。
- Worker/Command Buffer 与 Streaming 批量接入。

## 6. M02 · Asset Runtime

- **模块边界：** 已敲定
- **内部设计：** 待讨论

### 6.1 模块定位

Scene Runtime 管“场景中有哪些实例及其动态状态”；Asset Runtime 管“这些实例共享的资源是什么，以及逻辑上是否存在”。

```text
Entity A ─┐
Entity B ─┼──> MeshAsset 7 / MaterialAsset 3 / TextureAsset 12
Entity C ─┘
```

Entity 只保存稳定 AssetId，不复制 Geometry、Material、Texture 或 Animation Clip 本体。

### 6.2 已敲定架构

采用“稳定 Asset Registry + 独立 Residency 状态 + 可演进 Streaming Policy 边界”：

```text
Asset Registry
  稳定 AssetId、Descriptor、共享引用和逻辑生命周期

GPU Residency
  GPUBuffer/GPUTexture 的物理驻留、上传和回收

Streaming Policy
  第一版为简单 All-resident/显式加载策略
  后续才按相机、LOD、优先级和预算演进
```

第一阶段可以全部常驻，但不得把“逻辑资产存在”和“已经驻留 GPU”设计成同一状态。

这里的“可演进/可替换”表示状态和调用边界不阻止未来 Streaming，不表示第一版立即建设 Plugin Registry、多策略热切换或通用 Streaming Framework。

### 6.3 三层职责

#### Asset Registry

- 稳定 AssetId、Asset Type 和 Descriptor。
- Geometry、Material、Texture、Animation、Skeleton 等共享资产的逻辑身份。
- 共享引用、依赖关系和逻辑生命周期。
- 与 Scene Runtime Entity 引用建立稳定关系。

#### GPU Residency

- 逻辑 Asset 到 GPUBuffer/GPUTexture/地址范围的物理驻留映射。
- 上传、占位、替换和回收状态。
- 依赖 GPU Runtime 的物理资源能力，但保留资产级语义。

#### Streaming Policy

- 后续根据 Camera、LOD、优先级、可见性预测和预算决定加载/淘汰。
- 第一版允许只有 `AllResidentPolicy`、显式 `load/unload` 或同等简单策略。
- 只有第二种真实策略出现后，才抽取稳定的可插拔接口；不为假设中的多种策略预先建设注册、反射和生命周期框架。

### 6.4 与其他模块的边界

- Scene Runtime 只引用 AssetId，不拥有资产本体。
- Ecosystem Integration 生成 Asset Descriptor，不直接上传 GPU。
- GPU Runtime 管物理 Buffer/Texture allocator，不管理 Mesh/Material 等逻辑身份。
- Geometry、Texture、Material 等领域模块定义各自运行时表示和 Residency 需求。
- GPU Scene 引用已经建立逻辑身份和可用 Residency 的资产。

### 6.5 选择该方案的原因

- 多个 Entity 可以共享资源，不重复占用 CPU/GPU 内存。
- 第一版可采用全部常驻，避免立即实现完整 Streaming Runtime。
- 后续增加城市/开放世界流式加载时，不需要修改 Entity 的资产引用模型。
- 逻辑资产存在、CPU 数据可用和 GPU 已驻留可以独立表达，避免异步加载状态混乱。
- 支持未来 GPU-ready Scene Format、预构建 Meshlet、压缩纹理和 BVH。

该分层是必要语义分离，而不是为了兼顾两种极端建立的折中系统：逻辑 AssetId 必须在资源暂未驻留、被淘汰或 Device Lost 时仍然稳定存在；因此 Registry 与 Residency 不能合并。Streaming Policy 则是对 Residency 决策的后续能力，可以推迟实现。

### 6.6 已否决方案

| 方案 | 否决原因 |
|---|---|
| 把“AssetId 存在”直接等同于“GPU 已驻留” | 首版状态少，但资源淘汰、异步上传和 Device Lost 时无法保持稳定逻辑身份，后续 Streaming 重构代价大 |
| 第一版直接实现完整 Streaming Runtime | 过早引入网络、Worker、取消、压缩、优先级、预算和淘汰等大量复杂度 |
| 第一版先搭建通用可插拔 Policy Framework | 只有一种策略时抽象没有实际消费者，会增加注册、配置和状态组合复杂度 |
| 把资产本体放进 Scene World | World 会同时承担实体、文件、纹理、几何、GPU 驻留和 Streaming，形成巨型模块 |

### 6.7 后续内部层次

| 层次 | 内容 | 状态 |
|---|---|---|
| M02-L1 | AssetId、类型与 Descriptor | 待讨论 |
| M02-L2 | 引用、所有权与释放 | 待讨论 |
| M02-L3 | 逻辑状态与 Residency 状态 | 待讨论 |
| M02-L4 | Upload、Placeholder、失败与取消 | 待讨论 |
| M02-L5 | Streaming Policy | 待讨论 |
| M02-L6 | GPU-ready Scene Format 与离线构建 | 待讨论 |

### 6.8 尚未敲定

- AssetId、类型编码和 Descriptor 结构。
- 引用计数、所有权、依赖图和释放规则。
- 逻辑状态与 Residency 状态是否使用两套状态机。
- Upload、Placeholder、失败、取消和重试协议。
- Streaming 优先级、预算和淘汰算法。
- Meshlet、压缩纹理、BVH 和动画数据属于导入期构建还是离线构建。

## 7. M03 · GPU Runtime

- **模块边界：** 已敲定
- **内部设计：** 待讨论

### 7.1 模块定位

GPU Runtime 是 OEngine 专用、内部优先的 WebGPU 基础模块。它向上提供窄而稳定的物理 GPU 服务，不发展成通用 WebGPU Framework。

```text
GPU Scene / Geometry / Texture / FrameGraph / Shader Kernel
                         ↓
                    GPU Runtime
                         ↓
                       WebGPU
```

### 7.2 已敲定职责

#### Device 与能力

- Adapter、Device、Queue、Canvas Context。
- Feature/Limit 检查、格式选择和能力描述。
- WebGPU error scope 与 Device Lost 基础处理。

#### Resource Memory

- GPUBuffer/GPUTexture 的通用创建和生命周期。
- 大块 Buffer、Suballocation、容量增长、Free List 和延迟释放基础。
- Texture Pool、Sampler Cache 和通用物理内存预算基础。

#### Upload / Readback

- Dirty Range 合并、批量 `writeBuffer`、Staging Buffer。
- Texture Copy、Copy Command、Upload Budget 和受控 Readback。
- 为 M01 SceneDelta/M04 GPU Scene 提供可复用连续 staging 和 compute-scatter 所需物理 Buffer 能力，但不理解 Entity Change Mask 或 Propagation 语义。

#### WebGPU 对象缓存

- GPUShaderModule、BindGroupLayout、PipelineLayout。
- Render/Compute Pipeline、Sampler 等实际 WebGPU 对象缓存。
- 接收 Shader Kernel 的 Signature/Key，不定义领域 Shader Variant。

#### Command Execution

- Command Encoder、Render/Compute/Copy Pass 的底层创建。
- Command Buffer 提交、GPU 使用期追踪、延迟回收和 Timestamp Query。
- 执行 FrameGraph 的稳定 Frame Plan，不理解 Pass 的领域含义。

#### Recovery 基础

- 新 Device 创建和底层通用状态重建。
- 通知 GPU Scene、Geometry、Texture 重建 Residency。
- 使 Pipeline Cache 和 FrameGraph History 等依赖状态失效。

#### 第一版最小范围

以上是 GPU Runtime 最终职责边界，不表示第一条渲染闭环先实现完整 allocator、预算器和自动恢复框架。第一版最小范围可以是：

```text
Device/Capabilities
+ 明确的 Buffer/Texture 创建与销毁
+ 简单 Upload Batch
+ Pipeline/Layout Cache
+ Command Encode/Submit
+ Device Lost 通知和可控失败
```

Suballocation、Texture Pool、Staging Ring、精确 Budget、自动 Residency 重建和复杂延迟释放，按 GPU Scene/Geometry/Texture 的真实分配模式逐项引入。底层接口必须为这些能力保留演进空间，但不能先做一个没有上层消费者的通用 WebGPU Framework。

### 7.3 明确不负责

- Entity、Mesh、Material、Light 等场景语义。
- GPU Scene table 字段与场景 ABI。
- Culling、Meshlet、Visibility、PBR、Lighting 或 Effects 算法。
- FrameGraph 的依赖关系和逻辑资源所有权。
- Asset 的逻辑身份、引用和 Streaming Policy。
- three.js/TSL 兼容。

### 7.4 对外边界

普通扩展优先经过：

```text
Shader 扩展 → Shader Kernel
Pass 扩展   → FrameGraph
Asset 扩展  → Asset Runtime
能力查询    → GPU Capabilities
```

专家级 `GPUDevice` Escape Hatch 可以后续讨论，但用户自行创建的资源不自动获得 OEngine 的预算、恢复和生命周期保证。

### 7.5 GPU-driven 性能约束

- GPU Scene 和资产 Residency 使用长期分配，不在普通帧反复创建场景 Buffer。
- Dirty Upload 集中批处理，不全量重传稳定场景。
- Pipeline/Layout 不在普通帧重复编译。
- FrameGraph 临时资源使用池化、生命周期分析和后续 alias。
- 普通 frame 主要执行稳定 Frame Plan 和少量增量上传。

### 7.6 已否决方案

| 方案 | 否决原因 |
|---|---|
| Raw WebGPU 薄封装 | Allocator、Upload、Cache 和 Recovery 会在各模块重复实现，不足以支撑 GPU 常驻资源 |
| 通用公开 WebGPU Framework | 与 FrameGraph/Shader/GPU Scene 重叠，公开面过大，偏离 OEngine Renderer 产品目标 |
| GPU Runtime 理解 Scene/Material/Pass 语义 | 会污染底层边界并形成新的核心巨石 |

### 7.7 后续内部层次

| 层次 | 内容 | 状态 |
|---|---|---|
| M03-L1 | Device、Capabilities 与初始化 | 待讨论 |
| M03-L2 | Buffer Allocator 与资源 Handle | 待讨论 |
| M03-L3 | Texture Pool 与物理预算 | 待讨论 |
| M03-L4 | Upload/Readback 与 Staging | 待讨论 |
| M03-L5 | Pipeline/Layout/Binding Cache | 待讨论 |
| M03-L6 | Command Execution 与延迟释放 | 待讨论 |
| M03-L7 | Device Lost 跨模块恢复 | 待讨论 |

### 7.8 尚未敲定

- Buffer allocator、Texture pool 和 Suballocation 算法。
- GPU 资源句柄、generation、延迟释放和使用期追踪。
- Upload Queue、Staging Ring 和每帧上传预算。
- 显存估算、预算层级和压力反馈。
- Pipeline 异步创建、预热与持久化。
- Raw WebGPU 专家接口的准确范围。


## 8. M04 · GPU Scene

- **模块边界：** 已敲定
- **内部设计：** 待讨论

### 8.1 模块定位

GPU Scene 是独立模块：

```text
Scene Runtime ─────┐
                   ├──> GPU Scene ──> Renderer Modules
Asset Runtime ─────┘
```

它是 CPU Scene/Asset Runtime 与 GPU Renderer 之间的长期场景数据库层。GPU Runtime 只提供通用 Buffer/Allocator 能力，Renderer 模块只消费场景数据；GPU Scene 独立拥有场景语义和稳定 GPU ABI。

GPU Scene 不是 CPU 每帧全量覆盖的被动镜像，必须允许 GPU pass 生成和维护部分派生状态。

### 8.2 已敲定职责

- OEngine 场景数据在 GPU 上的长期常驻表示。
- Entity/Instance、Transform、Mesh、Material、Bounds、Light 等逻辑 ID 到 GPU 记录的稳定映射。
- 场景专用 GPU table 的创建、容量、增长、版本和访问契约。
- 接收 M01 编译的只读 SceneDelta，应用 Create/Destroy、直接 Row 更新、Hierarchy Mutation 和 PropagationSeed。
- 接收 Asset Runtime/GPU Residency 产生的 Mesh、Material、Texture 等可用地址或句柄。
- 向 Visibility、Material、Lighting、Shadow、Animation 和 Debug 提供统一只读/受控写入接口。
- 支持 GPU pass 生成、更新和持续维护部分派生状态。
- 拥有 Compiled GPU Hierarchy、Propagation pending mask/depth queue 以及 World/Gate/Bounds 派生执行所需的场景语义资源；具体物理 Buffer 与 Pass 由 M04/M06 共同细化。
- 管理 Compiled Hierarchy Block descriptor/version 的 GPU 常驻映射；新 Block segment 原子发布，旧 segment 通过 M03 in-flight 延迟释放。

### 8.3 GPU-resident 约束

```text
稳定数据：
  上传后跨很多 frame 留在 GPU

少量变化：
  只上传变化行或控制参数

GPU 派生：
  Visibility、LOD、Animation、Bounds 等部分状态由 GPU 生成或更新
```

禁止：

- 每帧从 Scene Runtime 重新组装完整场景表。
- CPU 每帧覆盖所有 Transform、Bounds、Material 和 Instance 数据。
- 为了 CPU 查询方便而强制 Readback GPU 派生状态。

### 8.4 与 CPU World 的权威关系

已经确定：

- CPU World 拥有 Entity 结构、用户控制状态、Asset 引用和低频结构变化。
- CPU-controlled 节点的 Local TRS/Affine 由 CPU Scene Runtime 权威；GPU-animated/GPU-procedural 节点的当前 Local 派生值由 GPU 权威。
- GPU Scene 拥有渲染所需常驻表示；正式渲染使用的 Current/Previous World Transform 由 GPU 权威并长期驻留。
- CPU Scene Runtime 权威保存 `localRenderEnabled`；GPU 根据 Hierarchy 派生并长期维护 `effectiveRenderEnabled`，Visibility 只消费派生 Gate 和每 View Culling 状态。
- CPU 只为 Active Camera 做专用 World 计算，并为低频工具查询提供无缓存的 `computeWorldMatrix(entity, out)`；不维护全场景 World Matrix mirror。
- Gameplay 不上 GPU；GPU 只接管适合大规模并行的渲染相关计算。

尚未确定的是物理布局和更细字段协议，例如 Current/Previous World 的 full/sparse/history 形式、Animation Pose、Skinning Matrix、动态 Bounds、Authority 切换和 GPU 写入阶段。这些在 M04/M01/Animation/Temporal 对应内部层次逐项讨论，不能推翻已经确定的 Render World GPU 权威。

#### SceneDelta 与传播顺序契约

M04 不重新扫描 CPU World，也不自行比较新旧 Scene 状态。每个提交 Epoch 只消费 M01 输出的 SceneDelta：

```text
SceneDelta
  → Apply Direct CPU Changes
  → Apply Entity/Block Logical Removal
  → GPU Animation/Procedural Local Producers
  → Merge PropagationSeed
  → Depth-ordered Hierarchy Propagation
  → Bounds/Spatial Derived Update
  → Visibility
```

SceneDelta 的 CPU Change Mask 不能直接充当所有 GPU 派生状态 Dirty Mask；M04 使用 M01-L5 定义的 Propagation Mask，将 Local/Hierarchy/Gate/Animation 变化统一合并到 GPU 稀疏传播队列。

Destroy/Block Removal 的逻辑生效必须早于本帧 Visibility：PendingDestroy Instance 不得进入新的 Visible Work。旧 GPU Buffer segment、Block version 和物理资源可以因为 in-flight frame 延迟释放，但它们必须先从新的 Active descriptor/valid record 集合中移除。

完整 Block Destroy 直接移除 Block descriptor；部分 Subtree Destroy 才发布剩余节点的新 Block version。M04 不对已经完整删除的 Block重新运行 Compiled Hierarchy builder。

Compiled GPU Hierarchy 至少提供与以下信息等价的能力：

```text
entity depth
contiguous child adjacency
per-depth queue capacity/range
parent-before-child execution contract
```

具体是否采用独立 `depth[]/childOffsets[]/childIndices[]` Buffer、字段压缩、block-local adjacency 或其他等价 packing，在 M04-L4/L5 验证；不得因为物理调整而让 CPU 展开全部 Dirty Subtree。

### 8.5 明确不负责

- WebGPU Device、通用 allocator、Pipeline Cache；属于 GPU Runtime。
- three.js 导入；属于 Ecosystem Integration。
- Geometry/Meshlet 资产构建；属于 Geometry。
- Culling、Sort、Indirect、Visibility Raster；属于 Visibility Pipeline。
- Material、Lighting、Shadow、GI 算法。
- FrameGraph Pass 调度。

### 8.6 为什么必须独立

| 放置方式 | 问题 |
|---|---|
| 放入 GPU Runtime | 使通用 WebGPU 资源层理解 Entity、Material、Bounds 等场景语义 |
| 放入 Visibility | Material、Lighting、Shadow、Animation、Debug 都需要 GPU Scene，Visibility 会吞并整个 Renderer |
| 独立模块 | 可以固定场景 ABI，并允许上游 World 与下游算法分别演进 |

### 8.7 后续内部层次

| 层次 | 内容 | 状态 |
|---|---|---|
| M04-L1 | Table Family 与 GPU ABI | 待讨论 |
| M04-L2 | CPU ID 到 GPU Slot/Address 映射 | 待讨论 |
| M04-L3 | Capacity、Free List、Block Segment 与 Compaction | 待讨论 |
| M04-L4 | SceneDelta Apply、Compiled Block Publish、Direct Upload/Scatter 与 PropagationSeed | 待讨论 |
| M04-L5 | 已定 Transform 权威的物理化；Animation/Bounds 等剩余字段权威 | 待讨论 |
| M04-L6 | Add/Remove 与 Streaming 事务 | 待讨论 |
| M04-L7 | Readback、Debug 与恢复 | 待讨论 |

### 8.8 尚未敲定

- 具体有哪些 Tables 以及字段布局。
- Entity/Instance/Transform/Mesh/Material/Bounds 的表关系。
- Stable ID、Dense Slot、GPU Address 和 generation 的映射。
- Visible List、Indirect Args、LOD State 属于 GPU Scene 还是 Visibility 工作资源。
- GPU Animation/Bounds 结果的持久化位置。
- Compiled GPU Hierarchy 的 CSR/等价 packing、Depth Queue、pending atomic mask 和异常深层级处理。
- Block descriptor/version、segment replace、merge/split 和旧版本延迟释放协议。
- Direct range upload 与 staging + compute scatter 的选择阈值。
- Device Lost、Streaming 和 Compaction 时的稳定引用协议。

## 9. M05 · Shader Kernel

- **模块边界：** 已敲定
- **内部设计：** 待讨论

### 9.1 模块定位

采用“最小中央机制、领域代码归领域模块”的结构：

```text
领域模块拥有 WGSL
        ↓
Shader Kernel 先处理固定 ABI、共享模块、Pipeline Signature 和基础诊断
        ↓
GPU Runtime 创建实际 Shader/Pipeline 对象
```

Shader Kernel 不拥有 PBR、Culling、Lighting、TAA、SSR 等领域算法，也不执行完整 three.js TSL/NodeBuilder Runtime。它首先是 OEngine 内部的窄 Shader Infrastructure，不预设为通用 Shader Graph、宏语言或任意 Fragment Composer。

### 9.2 Shader Kernel 职责

第一版必须职责：

- Frame、Camera、GPU Scene、Geometry、Texture 和 Pass Resource 的固定公共 ABI 契约。
- 共享 WGSL module/chunk 的明确引用和确定性展开。
- Pipeline Signature、Layout Signature 和最小 Variant Key。
- 为 GPU Runtime 输出可创建 ShaderModule/Pipeline 的稳定描述。
- 保留原始文件/module/label 的基础编译错误定位。

只有真实领域 Shader 出现重复需求后才增加：

- 通用依赖图和拓扑排序。
- Struct、Binding、Varying 的自动合并与冲突校验。
- 任意 Shader Fragment Composer。
- 完整 Source Map、热重载协议和用户扩展语言。

第一版允许依赖显式、ABI 固定、组合点有限。重复少量显式 glue code 比过早实现一套通用 Shader 编译框架风险更低。

### 9.3 领域模块职责

- Visibility 拥有 Cull、Expand、Sort/Compact、Indirect 和 Raster WGSL。
- Material 拥有 PBR、表面属性重建和 Material Resolve WGSL。
- Lighting 拥有 Light Clustering、Deferred Lighting、IBL 和 Shadow Evaluation WGSL。
- Temporal/Effects 分别拥有 TAA、SSR、GTAO、Bloom 等 WGSL。

领域模块声明所需 WGSL Module、入口点和资源契约。第一版可以通过显式模板/模块列表组合；只有出现多种真实组合关系后，Shader Kernel 才升级为更通用的 Fragment 组合器。无论机制如何演进，领域算法都不复制到中央模块。

### 9.4 GPU Runtime 职责

GPU Runtime 根据 Shader Kernel 输出创建和缓存：

- `GPUShaderModule`。
- `GPUBindGroupLayout`、`GPUPipelineLayout`。
- `GPUComputePipeline`、`GPURenderPipeline`。

Shader Kernel 不直接管理 Device 和实际 WebGPU 对象生命周期。

### 9.5 与 three.js/TSL 的边界

- 不直接依赖 TSL、NodeBuilder 或 NodeMaterial Runtime。
- 完整 TSL 不作为 OEngine Shader 执行路径。
- 若后续迁移受支持的 TSL/NodeMaterial 子集，应先转换成 OEngine Material Descriptor 或受控 Shader Fragment。

### 9.6 选择该方案的原因

- 所有 GPU-driven Pass 可以共享稳定 GPU Scene/Geometry/Texture ABI。
- 避免各模块各自定义不兼容的 Binding、Pipeline Key 和布局约定。
- 避免中央 Shader System 吞并所有算法成为代码巨石。
- 领域模块仍可以 tree-shake，并通过窄描述接入 FrameGraph/GPU Runtime。

### 9.7 已否决方案

| 方案 | 否决原因 |
|---|---|
| 每个模块各自管理全部 Shader/Pipeline 机制 | ABI 漂移、缓存重复、Binding 冲突和共享代码重复 |
| 所有领域 Shader 集中在中央系统 | 中央模块会理解全部算法，形成另一个 Renderer Core 巨石 |
| 完整 three.js TSL 作为主 Shader Runtime | 绑定官方编译路径，限制固定 GPU ABI 和 WebGPU 专用优化 |
| 第一版实现通用 Shader Graph/Fragment 编译器 | 在真实组合、变体和扩展需求出现前建设复杂 DSL、合并和诊断系统，工程成本过高 |

### 9.8 后续内部层次

| 层次 | 内容 | 状态 |
|---|---|---|
| M05-L1 | 最小 Shader Module/Entry 描述 | 待讨论 |
| M05-L2 | 公共 ABI 与 Binding Groups | 待讨论 |
| M05-L3 | 显式 Dependency/Composition；通用 Composer 演进门槛 | 待讨论 |
| M05-L4 | Variant 与 Pipeline Signature | 待讨论 |
| M05-L5 | 基础 Diagnostics；Source Map 演进 | 待讨论 |
| M05-L6 | Pipeline 预热与缓存；热重载后置 | 待讨论 |
| M05-L7 | 自定义 WGSL/Fragment 扩展门槛 | 待讨论 |

### 9.9 尚未敲定

- 第一版 Module/Entry 描述格式和显式依赖表达。
- Binding 是完全固定，还是固定基础组加受控扩展组。
- 静态 Variant、override constant、运行时分支的组合策略。
- Pipeline Signature 与 Material/Texture Binning 的关系。
- 何时真实需要通用 Fragment Composer、Source Map 和热重载。
- 自定义 WGSL 和用户 Pass 的公开范围；第一版默认内部优先。

## 10. M06 · FrameGraph

- **模块边界：** 已敲定
- **内部设计：** 待讨论

### 10.1 模块定位

Renderer 模块声明 Pass 与逻辑资源；FrameGraph 首先管理明确依赖、资源生命周期和稳定 Frame Plan；GPU Runtime 负责物理资源与命令执行。Graph Variant、Alias、Fusion 和通用扩展是按实际需要增加的能力，不是第一版完整框架的前置条件。

```text
Visibility / Material / Lighting / Temporal / Effects
  声明 Pass 和逻辑资源
                    ↓
FrameGraph
  依赖、生命周期、稳定 Frame Plan
                    ↓
GPU Runtime
  物理资源和 Command 执行
```

普通 frame 复用已编译 Frame Plan。可见工作量变化只改变 GPU Buffer/Counter/Indirect Args，不改变 CPU Pass 数量。

### 10.2 已敲定职责

- Pass 输入、输出、读写和依赖声明。
- Logical Resource Handle。
- Transient、Persistent/History、External/Imported Resource 分类。
- 确定性执行顺序和稳定 Frame Plan。
- 临时 Buffer/Texture 生命周期与基础池化。
- 已编译 Frame Plan 的缓存与执行入口。
- Debug Capture、Pass Timing 和资源检查接入点。

第一版可以围绕一张窄而固定的 OEngine 主管线图工作：

```text
固定 Pass 集合
+ 少量质量档/效果开关
+ Resize/History 失效
+ Imported/Persistent/Transient 资源
```

第一版不要求实现任意动态图编辑器、通用 RenderTask 插件系统、自动 Pass Fusion、复杂跨类型 Alias 或任意用户 Pass 注入。

### 10.3 明确不负责

- Culling、Meshlet、Material、Lighting、TAA、SSR 等领域算法。
- GPU Scene table 和 Asset 数据。
- 领域 WGSL 与 Shader 组合。
- GPUBuffer/GPUTexture allocator 和物理内存策略。
- Entity、Mesh 或 Material 级别的每帧工作组织。

### 10.4 长期资源与帧资源

GPU Scene、Geometry Residency、Texture Residency 等长期资源以 Imported Resource 进入 FrameGraph，FrameGraph 不取得其逻辑所有权。

FrameGraph 主要组织：

```text
SceneDelta Apply/Scatter
GPU Local Producers
Hierarchy Propagation Queue/Args
Visible Work
Sort/Scan Scratch
Indirect Args
Visibility Buffer
Depth/HZB
Surface/GBuffer
Lighting Output
Temporal History
SSR/GTAO/Bloom 临时资源
```

具体 Buffer 的领域所有权由相应模块决定，FrameGraph 只持有逻辑句柄和生命周期信息。

### 10.5 GPU-driven 约束

- 普通 frame 不重新扫描 Scene Runtime。
- Frame Plan 仅在能力、质量档、尺寸或已支持的管线结构变化时重新构建。
- Visible Meshlet 数量变化只改变 GPU 数据和 Indirect Args。
- CPU 提交少量稳定 Pass，不根据对象数量生成 Draw Command。

Scene 更新相关依赖必须形成稳定顺序：

```text
CPU Upload / SceneDelta Apply
  → GPU Animation / Procedural Local Evaluation
  → Propagation Seed Merge
  → Depth-ordered World/Gate Propagation
  → Visibility 所需 Bounds/Spatial Update
  → Instance/Meshlet Visibility
```

具体 Pass 可以在验证后合并，但 FrameGraph 不能把 Visibility 排在未完成的 Local/World/Bounds 派生之前，也不能因可见数量变化在 CPU 动态生成对象级 Pass。

### 10.6 效果接入

TAA、SSR、GTAO、Bloom、GI 等通过声明 Pass 和依赖接入。第一版可以为受支持的效果组合生成有限数量的 Frame Plan；不要求先实现可表达任意组合的通用 Graph Variant 系统。关闭某个效果时，对应 Pass 和专用临时资源不进入该 Frame Plan，不要求其他模块保存该效果的私有状态。

### 10.7 已否决方案

| 方案 | 否决原因 |
|---|---|
| FrameGraph 放入 GPU Runtime | 会让通用物理资源层理解 History、Visibility、Lighting 等管线语义 |
| FrameGraph 放入 Renderer 巨型对象 | 算法、调度和资源生命周期混合，Effects/History 会持续膨胀 Renderer |
| 每帧动态构造对象级 Graph | 违背固定 Pass、GPU 生成可见工作量的方向 |
| 第一版建设完全通用的 Render Graph Framework | Alias、Fusion、插件、任意 Graph 修改会在主管线尚未验证时扩大基础设施工作量 |

### 10.8 后续内部层次

| 层次 | 内容 | 状态 |
|---|---|---|
| M06-L1 | Pass/Resource Declaration | 待讨论 |
| M06-L2 | Dependency 与 Graph Compile | 待讨论 |
| M06-L3 | Resource Lifetime、Pool 与 Alias 演进门槛 | 待讨论 |
| M06-L4 | Persistent/History/Imported Resource | 待讨论 |
| M06-L5 | 有限 Frame Plan Variant 与缓存 | 待讨论 |
| M06-L6 | Execute、Profiling 与 Debug | 待讨论 |
| M06-L7 | Mip/Multi-view；Pass Fusion 后置 | 待讨论 |

### 10.9 尚未敲定

- Pass/Resource API 和 Variant Key。
- 第一版资源池范围；Transient alias 是否有足够收益值得实现。
- History resize、失效和 Device Lost 协议。
- mip chain、multi-view 和 shadow graph 的最小表达。
- Pass fusion 的收益门槛。
- 自定义 Pass 是否以及如何公开；第一版默认不提供任意注入。

## 11. M07 · Geometry

- **模块边界：** 已敲定
- **内部设计：** 待讨论

### 11.1 模块定位

Geometry 管“几何资产长什么样以及如何在 GPU 中被读取”；Visibility 管“这一帧哪些 Instance/Meshlet 可见”。二者独立但通过稳定 Geometry/Meshlet ABI 协作。

Geometry 管跨帧稳定的 Vertex/Index、Meshlet、Meshlet Bounds、LOD/Cluster、压缩和 Geometry Residency 描述。

Meshlet 的构建、压缩、Bounds 和资产数据属于 Geometry。Meshlet/Cluster 是大场景不透明三角几何的核心表示，不等于要求粒子、Debug Geometry、特殊程序化表面和所有动态拓扑都伪装成 Meshlet。

主路径支持动态 Instance、Skinning、Morph、Vertex Animation；注册后的 Geometry Topology 默认不可高频修改，真正拓扑变化通过异步重建或重新注册处理。

### 11.2 已敲定职责

- Vertex/Index 数据规范化和布局描述。
- Meshlet 构建、编码、压缩和持久数据。
- Meshlet Bounds、Cone/LOD/Cluster 等剔除辅助数据。
- 静态 Geometry Pool 与动态变形 Geometry 的逻辑边界。
- Geometry Residency 所需 Descriptor 和稳定 GPU 读取契约。
- 为 Visibility、Shadow、GI/Ray、Material Resolve 和 Debug 提供统一几何访问。

### 11.3 明确不负责

- 当前 Camera、Frustum、HZB 和 Visible List。
- Instance/Meshlet 的每帧展开和剔除。
- GPU sort/bin/scan/compact 和 Indirect Args。
- Material/Texture/Lighting 算法。
- Entity Transform 和 Scene 层级。

### 11.4 Meshlet 边界

```text
Geometry：
  Meshlet 构建、压缩、Bounds、LOD 和资产数据

Visibility：
  Instance → Meshlet Work 展开、剔除、排序、压缩和间接绘制
```

该边界允许同一 Geometry 被主视图、Shadow View、GI/Ray 和 Debug 共享，而不把资产构建逻辑复制进各渲染 Pass。

受控非 Meshlet Work Type 必须满足：

- 仍由同一个 GPU Scene、FrameGraph、Shader/GPU Runtime 和 Renderer 提交。
- 不建立 JS Render List 或第二个公开 Renderer。
- 只服务无法合理 Cluster 化或数量明确受控的几何类型。
- 不得让普通大场景不透明 Mesh 静默绕过 Meshlet/GPU-driven 主路径。

是否值得让极小普通 Mesh 也强制 Meshlet 化，需要比较预处理体积、Work Expansion 成本和实际可见数量；在基准前不把“所有 Geometry 一律 Meshlet”写成物理格式硬约束。

### 11.5 动态性约束

支持：

- Instance Transform 变化。
- Skinning、Morph Target、Vertex Animation。
- 拓扑稳定条件下的 GPU Vertex/Bounds 更新。

不作为高频主路径：

- 每帧增加/删除 Vertex 或 Index。
- 每帧重建 Meshlet、Bounds、LOD。
- 任意拓扑编辑直接覆盖常驻 Geometry。

真正拓扑变化通过重新构建或重新注册 Geometry 处理，仍使用同一 Renderer。是否需要通用异步拓扑重建框架，等真实动态拓扑需求出现后再设计；第一版可以只支持显式替换 Geometry Asset。

### 11.6 性能与复杂度后果

- 一个 MeshAsset 可以被大量 Instance 共享，Meshlet 数据只保存一次。
- Meshlet 可在导入期或离线构建，避免每帧 CPU 处理。
- Geometry ABI 需要兼顾 Visibility 重建属性、Material Resolve、Shadow 和 GPU Animation。
- Skinning/Morph 可能要求 GPU 更新 Bounds，但不需要改变 Meshlet 拓扑。

### 11.7 已否决方案

| 方案 | 否决原因 |
|---|---|
| Geometry 与 Visibility 合成一级巨型模块 | 资产生命周期与每帧可见工作混合，Streaming/Shadow/GI 复用困难 |
| Culling/Draw Generation/VB/HZB 全部平级拆分 | 数据流过紧，产生大量内部 Buffer 契约和伪模块边界 |
| 高频任意拓扑修改作为主路径 | 需要持续重建 Meshlet/Bounds/LOD，破坏长期常驻和 GPU-driven 目标 |

### 11.8 后续内部层次

| 层次 | 内容 | 状态 |
|---|---|---|
| M07-L1 | Geometry Descriptor 与 Vertex Schema | 待讨论 |
| M07-L2 | GPU Geometry ABI 与地址模型 | 待讨论 |
| M07-L3 | Meshlet Record 与 Builder | 待讨论 |
| M07-L4 | Compression 与 LOD/Cluster | 待讨论 |
| M07-L5 | Static/Dynamic Geometry Pool | 待讨论 |
| M07-L6 | Skinning/Morph 与 Bounds | 待讨论 |
| M07-L7 | 拓扑替换；异步重建演进门槛 | 待讨论 |

### 11.9 尚未敲定

- Vertex Schema、量化和索引格式。
- Meshlet 大小上限、Record、压缩和 LOD 层级。
- GPU 地址、Suballocation 与 Streaming 稳定性。
- Skinning/Morph 后 Meshlet Bounds 的更新策略。
- 第一版拓扑替换协议；是否需要异步重建、失败回滚和旧资源保留。

## 12. M08 · Visibility Pipeline

- **模块边界：** 已敲定
- **内部设计：** 待讨论

### 12.1 模块定位

Visibility Pipeline 管“这一帧 GPU 最终需要处理和绘制哪些工作项”，是 OEngine GPU-driven 主路径的核心执行模块。

它消费 GPU Scene 与 Geometry 的长期常驻数据，生成 Visible Work、Indirect Args、Visibility Buffer 和 Depth/HZB，供 Material、Lighting、Shadow 和 Effects 使用。

### 12.2 已敲定能力方向，不锁死每帧固定序列

```text
Instance Culling
→ Visible/Active Instance Work
→ Meshlet/Geometry Work Generation
→ Fine Culling
→ 按需 Bin / Scan / Compact / Sort
→ Indirect Args
→ Visibility Raster
→ Depth/HZB
→ 可选 Occlusion refinement
```

这些能力以后在 M08 内部分层，不拆成互相平级的一级模块。但它们是 Visibility 拥有的能力集合，不表示主视图、Shadow View、Debug View 和小工作集每帧都必须执行完整 Sort/Scan/Maybe 流程。

第一条能验证架构的最小 GPU-driven 路径可以是：

```text
GPU Frustum Cull
→ Compact Visible Instances
→ Meshlet Work Generation
→ GPU Indirect Args
→ Visibility Raster + Depth
```

HZB Occlusion、Small Primitive、复杂排序、Current-frame refinement 和 Multi-view 复用在最小路径正确且可测后逐项加入。

### 12.3 已敲定职责

- GPU Instance Frustum Culling。
- GPU Occlusion Culling 能力；Previous/Current HZB 组合待验证。
- Visible/Culled 以及可选 Maybe 工作集管理。
- Visible Instance → Meshlet Work/Batch 展开。
- Meshlet Frustum、Occlusion 和可选 Small Primitive Culling。
- 按工作负载需要提供 GPU Bin、Prefix Scan、Compaction 和 Sort，不规定所有阶段同时执行。
- GPU 生成 Indirect Draw/Dispatch Args。
- Visibility Raster、Depth 和 HZB 构建。
- 可选的当前帧 Occlusion refinement；是否采用 Maybe Set 与二次 Raster 待原型验证。
- 输出 Material Resolve、Shadow、SSR/GTAO/TAA 和 Debug 所需的可见性数据。

### 12.4 明确不负责

- Meshlet 构建、压缩、LOD 资产数据；属于 Geometry。
- GPU Scene 的长期 table、ID 映射和容量；属于 GPU Scene。
- Material、Texture、Lighting 和 Effects 算法。
- FrameGraph 的通用资源生命周期和执行计划。
- CPU Scene traversal、JS sort 或逐对象 Draw Command。

### 12.5 GPU-driven 性能约束

- 与场景规模相关的剔除、展开、必要分桶/排序和压缩主要在 GPU 完成。
- CPU 只提交少量稳定 Compute/Render Pass。
- 可见数量变化只改变 GPU Counter、List 和 Indirect Args。
- 不把 Visible List readback 到 CPU 再决定绘制。
- 对主视图、Shadow View 等复用工作生成机制时，不复制 CPU Render List 逻辑。

GPU-driven 不等于“所有数据都先完整排序”。阶段选择遵循：

```text
只需连续可见列表
  → compact

只需按有限 Key 归类
  → bin/count/scan

确实需要有序结果
  → sort

工作量小且固定
  → 允许更直接的 GPU 处理，但 CPU 仍不逐对象构造 Draw List
```

### 12.6 与 Geometry/Meshlet 的边界

```text
Geometry：
  Meshlet Record、Bounds、LOD、压缩和持久数据

Visibility：
  每帧 Work Generation、Cull、必要组织、Indirect 和 Raster
```

一个 Geometry 的 Meshlet 数据可以被大量 Instance 和多个 View 复用；Visibility 只创建本帧工作项。

### 12.7 对后续模块的输出契约

- Material Resolve 读取 Visibility ID、Depth 和 Geometry 引用，重建最终表面属性。
- Shadow 可以用 Light View 复用 Culling/Work Generation，但不把 Shadow 算法塞入 Visibility。
- SSR/GTAO 读取 Depth/HZB 和后续 Surface 数据。
- TAA 读取 Motion、Depth 和可见性相关历史。
- Debug/Stats 读取 Cull Counts、Visible Counts、可选 Maybe Counts 和 Heatmap 数据。

### 12.8 已否决的拆分方式

| 方式 | 否决原因 |
|---|---|
| 永久把 Visibility 定义成只做简单 Frustum Culling | 无法承载后续 Meshlet Work Generation、Indirect、VB 和 HZB；但简单 Frustum 路径可以作为第一条验证切片 |
| Culling、Expansion、Sort、Indirect、VB、HZB 全部作为一级模块 | 数据流高度耦合，制造大量内部 Buffer 契约和循环关系 |
| Visibility 拥有 GPU Scene/Geometry | 会吞并长期场景和资产职责，形成新的 Renderer 巨石 |

### 12.9 后续内部层次

| 层次 | 内容 | 状态 |
|---|---|---|
| M08-L1 | View/Camera 输入与 Culling Contract | 待讨论 |
| M08-L2 | Instance Cull 与 Visible Set；Maybe 是否采用 | 待讨论 |
| M08-L3 | Meshlet Work Expansion/Batch | 待讨论 |
| M08-L4 | Meshlet Cull 与按需 Bin/Scan/Compact/Sort | 待讨论 |
| M08-L5 | Indirect Args 与 Work Buffer | 待讨论 |
| M08-L6 | Visibility Raster 与编码 | 待讨论 |
| M08-L7 | Depth/HZB 与 Occlusion Refinement 候选 | 待讨论 |
| M08-L8 | Multi-view/Shadow 复用 | 待讨论 |

### 12.10 尚未敲定

- Visible/Maybe/Indirect Buffer 的模块所有权和生命周期。
- Culling、Sort、Scan、Compaction 的具体算法。
- Meshlet Batch 大小和 Expansion 数据结构。
- Previous HZB、Current HZB 和二次 Raster 的准确顺序。
- Visibility Buffer 字段、格式、背景编码和 Primitive 标识。
- Multi-view、Shadow View 和 LOD 的共享方式。

### 12.11 原型验证门槛

M08 的精确流程不能仅从参考架构复制，至少需要以下垂直验证：

| 场景 | 主要验证 |
|---|---|
| 大量实例、低可见率 | GPU Cull/Compact 是否显著降低后续工作；CPU frame 是否不随 N 线性增长 |
| 大 Mesh + Meshlet | Expansion 和 fine cull 是否抵消自身调度/Buffer 成本 |
| 高遮挡城市/室内 | Previous HZB、Current refinement 和 Maybe Set 的收益与错误率 |
| 小场景/低工作量 | GPU Sort/Scan 是否反而成为固定开销 |
| 多材质/多 Texture Group | Binning 是否能直接服务 Material Resolve，而不是重复组织工作 |
| 主流集成/独显设备 | 不同 subgroup、带宽和驱动条件下算法是否稳定 |

每个候选流程至少记录：CPU frame、各 GPU Pass 时间、Visible/Rejected 数量、Indirect/Pass 数、工作 Buffer 峰值、显存流量近似值和错误/闪烁案例。通过数据后，才把具体 HZB/Sort/Maybe 顺序升级为已敲定物理实现。

## 13. M09 · Texture System

- **模块边界：** 已敲定
- **内部设计：** 待讨论

### 13.1 模块定位

Texture System 负责“逻辑 TextureAsset 如何变成材质和长期渲染资源可以稳定索引、驻留和采样的纹理表示”，并集中处理 WebGPU 缺少完整 bindless textures 带来的资产纹理架构问题。

Texture 是独立模块，负责 TextureId、Sampling Descriptor、Color Space、Sampler、Mipmap 和最终选定的材质纹理 Binding/Indirection 策略，以及与 Residency/Streaming 的纹理专用协作。Array、Atlas、Binding Group Class 和 Virtual Texture 是候选能力，不表示第一版全部实现。

Asset Runtime 管逻辑 TextureAsset；GPU Runtime 管实际 GPUTexture 和物理分配。

### 13.2 三层边界

```text
Asset Runtime
  TextureAsset、来源数据、稳定 AssetId、逻辑生命周期
                    ↓
Texture System
  资产采样表示、TextureId、Mipmap、选定 Binding/Indirection、纹理专用 Residency
                    ↓
GPU Runtime
  GPUTexture、Sampler、Copy、Pool、物理内存
```

Material Asset 纹理和可共享长期纹理通过 Texture System 的受控采样契约使用。Renderer 在帧内生成的 Depth、Visibility、GBuffer、Shadow Map、Temporal History 和 Post 临时纹理仍由 FrameGraph/相应领域模块声明和拥有逻辑语义，不强制转成 TextureAsset/TextureId。

### 13.3 已敲定职责

- TextureId 与 Texture Sampling Descriptor。
- Color Space、格式、通道和用途语义。
- Sampler 管理与缓存协作。
- Mipmap 生成和过滤策略入口。
- 根据 Material Resolve 和目标设备验证结果，选择并维护有限的 Binding/Indirection 策略。
- 与 Asset Residency/Streaming 的纹理专用上传、替换和占位协作。
- 为 Material 和可共享长期采样资源提供明确资源类别与采样接口。
- 保留 Texture Array、Atlas、Format/Resolution Class、Indirection 和 Virtual Texture 的演进空间，但按真实需求逐项引入。

### 13.4 明确不负责

- PBR、BRDF、Material Model 和 Surface 输出；属于 Material。
- Image/glTF/KTX2 等外部导入；属于 Ecosystem Integration/Asset Runtime。
- 通用 GPUTexture allocator 和 Device；属于 GPU Runtime。
- FrameGraph 临时资源的通用生命周期；属于 FrameGraph。
- Visibility、GBuffer、Shadow、History 和 Post 中间纹理的领域语义与 Pass 依赖。
- Lighting、Shadow、GI、SSR 等领域算法。

### 13.5 无 bindless 性能约束

WebGPU 不能简单通过任意整数索引任意独立 `texture_2d`。主路径需要把大量材质纹理组织为有限、可绑定和可缓存的 Sampling Group。候选工具包括：

```text
Texture Array
Atlas
Format Class
Resolution Class
Compression Class
Sampler Class
未来 Virtual Texture
```

第一版不同时实现以上所有策略，而是通过 Material Resolve 垂直原型选择一条最小可用主策略。目标是让 Material/Visibility 在 GPU 分桶后按有限 Texture Binding Group 执行，而不是 CPU 为每个 Mesh 单独绑定纹理。

选择必须比较：

- 支持的格式、尺寸、压缩和 mip 组合。
- 材质纹理槽数量与 Sampler 变化。
- Array/Atlas 的填充浪费、重打包和 Streaming 更新成本。
- Binding Group 数量、Material Group 数量和 CPU/GPU 切换成本。
- 导数、Mip、Anisotropy、Alpha Coverage 和 Normal Map 过滤正确性。
- Web 浏览器内存峰值与 Device Lost 后重建成本。

### 13.6 已否决方案

| 方案 | 否决原因 |
|---|---|
| Texture 作为 Material 内部子系统 | Material 会同时承担加载、显存、Sampler、Mipmap、Binding Strategy 和 Streaming，并被 IBL 等共享长期采样资源反向依赖 |
| Texture 只是 GPU Runtime 的裸资源 | 无法表达 Color Space、Mipmap、Array/Atlas、TextureId Indirection 和采样契约 |
| 大场景主路径永久按每个材质绑定独立纹理集合 | Material Group 数量可能接近材质数，CPU/Pipeline/Binding 提交失控；小规模或特殊 Pass 是否允许有限独立绑定另行讨论 |
| 第一版同时实现 Array、Atlas、Indirection 和 Virtual Texture | 多套重叠系统会扩大导入、Streaming、Mip 和材质路由复杂度，且无法知道哪套真正适合目标负载 |

### 13.7 后续内部层次

| 层次 | 内容 | 状态 |
|---|---|---|
| M09-L1 | TextureAsset → Sampling Descriptor | 待讨论 |
| M09-L2 | TextureId 到采样资源的映射；是否需要 Indirection Table | 待讨论 |
| M09-L3 | Format/Color Space/Compression Class | 待讨论 |
| M09-L4 | Sampler 与 Mipmap | 待讨论 |
| M09-L5 | 第一主 Binding Strategy：Array/Atlas/Group/Indirection 比较 | 待讨论 |
| M09-L6 | Residency、Placeholder 与 Streaming | 待讨论 |
| M09-L7 | Virtual Texture 的触发条件与后续演进 | 待讨论 |

### 13.8 尚未敲定

- TextureId 到实际采样资源的 Indirection 结构。
- 第一版到底选择 Array、Atlas、有限 Binding Group、Indirection 或组合中的哪一个最小主策略。
- 不同尺寸、格式、Color Space 和压缩格式的分组。
- Mipmap、Alpha Coverage、Normal Map 过滤策略。
- Sampler 数量和动态状态边界。
- IBL/长期 Probe 等共享采样资源与普通 Material Texture 的复用边界。
- Shadow/GI/History/Post 生成资源与 TextureAsset 系统的精确接口；默认保持领域/FrameGraph 所有权。

## 14. M10 · Material System

- **模块边界：** 已敲定
- **内部设计：** 待讨论

### 14.1 模块定位

Material System 负责“最终可见表面是什么”，不负责“哪些几何可见”或“灯光如何照亮表面”。

Material 负责 Material Model、MaterialRecord、Feature Mask、领域 WGSL、Material Resolve 和 Surface/GBuffer 输出契约。

Material 通过 TextureId 使用 Texture System，不直接拥有 GPUTexture、Atlas、Streaming 或 Mipmap。

### 14.2 已敲定职责

- OEngine Material Model 与参数语义。
- MaterialId、MaterialRecord、Feature Mask 和 Shader Variant 描述。
- Material 领域 WGSL 和 Shader Kernel 输入。
- 通过 Visibility/Geometry 重建 UV、Normal、Tangent 和其他表面属性。
- 通过 TextureId 使用 Texture System 的采样契约。
- Material Resolve。
- Surface Buffer/GBuffer 输出契约。
- Unlit、Opaque PBR、Alpha Test 和后续特殊材质分类。

### 14.3 明确不负责

- three.js Material Runtime、NodeBuilder 和完整 TSL。
- GPUTexture、Sampler、Array/Atlas、Mipmap 和 Streaming。
- Geometry/Visibility 工作生成。
- Light Clustering、Shadow、GI 和最终 Lighting。
- FrameGraph 资源调度。

### 14.4 已敲定产品路径，Resolve 实现待验证

- Opaque PBR：Visibility → Material Resolve → Deferred Lighting。
- Alpha Test：Visibility 阶段执行必要 Alpha Test，再进入延迟主路径。
- Unlit：Visibility → Resolve，跳过普通 Lighting。
- Transparent/特殊表面：同一 Renderer 内受控 GPU-driven Forward/OIT Pass。

完整不透明流程：

```text
Visibility Buffer + Depth
  → 定位 Instance/Mesh/Primitive/Material
  → Geometry 重建表面属性
  → MaterialRecord + TextureId
  → OEngine Material WGSL
  → Surface Buffer/GBuffer
  → Deferred Lighting
```

第一次 Visibility Raster 不执行完整 PBR 和 Lighting，先确认最终可见像素，再支付材质采样成本。

这里敲定的是“不透明表面先可见性、后昂贵材质、再统一光照”的产品方向。Material Resolve 的 Pass 数、Raster/Compute 形式、Texture Binding 和 Surface Buffer 布局尚未敲定，不因本节流程图自动成为固定实现。

### 14.5 与 three.js 材质的关系

```text
THREE.MeshStandard/PhysicalMaterial
  → OEngine Material Descriptor
  → MaterialRecord / GPU Material Table
  → OEngine Material Resolve WGSL
```

可以复用 three.js/glTF 的参数语义、颜色空间和 BRDF 参考，但不使用其前向材质执行路径。

### 14.6 受控特殊路径

| 材质类型 | 路径与约束 |
|---|---|
| Opaque PBR | Visibility-Deferred 主路径 |
| Alpha Test | Visibility 阶段执行必要采样/测试，再进入主路径 |
| Unlit | Resolve 输出 Unlit 标记或颜色，不执行普通 Lighting |
| Transparent / Alpha Blend | GPU-driven Forward/OIT Special Pass |
| 粒子、玻璃、Transmission、水、头发 | 后续按能力进入受控专用 Pass |

Special Pass 必须复用 GPU Scene、Geometry、Material、Texture、GPU Work Generation、Lighting Contract 和 FrameGraph，不得形成第二个公开 Renderer 或 CPU Render List。

### 14.7 性能约束

- 昂贵 Material Shader 尽量只运行在最终可见像素。
- Material/Texture 工作通过 GPU Material Group/Texture Group 排序和分桶组织。
- CPU 工作量不能随 Mesh 数量线性增长。
- Pipeline/Binding 的数量应随有限 Material/Texture Group 增长，而不是默认每 Mesh 一套。
- 透明和特殊材质不能破坏不透明 GPU-driven 主路径。

### 14.8 Material Resolve 候选方案（未敲定）

| 候选 | 优点 | 主要风险 | 状态 |
|---|---|---|---|
| 单一 Uber Resolve | Pass 少、GPU 直接按 MaterialId 分支 | 无 bindless、Shader divergence、巨型 Shader、纹理绑定困难 | 待讨论 |
| 每个独立 Material 一个 Raster Resolve | 纹理绑定直接、正常纹理导数、接近 Shade Material Pass | Pass/Draw 数可能随唯一材质数增长 | 待讨论 |
| Raster-based Grouped Material Resolve | 按 MaterialModel/Feature/TextureBindingClass 分组，兼顾导数与较少 Group | 依赖 Texture Group、GPU Binning 和稳定 Group Key | **建议，未敲定** |

纯 Compute Resolve 也可作为后续研究，但纹理 `dpdx/dpdy`、Mip/Anisotropy、三角形边界和无 bindless 会显著增加复杂度，不作为当前已确认主方案。

候选比较必须使用同一组场景和输出质量：

- 少量标准材质与大量实例。
- 大量唯一材质和多 Texture Binding Class。
- 高频细节 Normal/ORM、Alpha Test 和高各向异性采样。
- 屏幕高覆盖与低覆盖两种 Visibility 分布。
- 不同 Surface Buffer 精度/带宽配置。

记录 GPU Pass 时间、Material Group/Draw 数、Pipeline 数、Binding 切换、纹理采样正确性、显存峰值和 Shader 编译规模。只有验证后才将某个 Resolve Routing 标记为已敲定。

### 14.9 后续内部层次

| 层次 | 内容 | 状态 |
|---|---|---|
| M10-L1 | Material Model 与参数语义 | 待讨论 |
| M10-L2 | MaterialRecord 与 Feature Mask | 待讨论 |
| M10-L3 | three.js/glTF 材质转换白名单 | 待讨论 |
| M10-L4 | Material Resolve Routing | 待讨论 |
| M10-L5 | Surface Buffer/GBuffer Contract | 待讨论 |
| M10-L6 | Alpha Test 与特殊材质 | 待讨论 |
| M10-L7 | 自定义材质/WGSL 扩展 | 待讨论 |

### 14.10 尚未敲定

- Material Resolve 的具体路由方式。
- Material Model 和 Feature 体系。
- Surface Buffer/GBuffer 布局。
- three.js 材质白名单和迁移细节。
- 自定义材质和 WGSL 扩展边界。

> 先前提出的 Raster-based Grouped Material Resolve 只是建议，尚未敲定；等 M10 成为当前活动模块时再逐层讨论。

## 15. M11–M13 · 尚未开始的模块域

### M11 · Lighting Domain

Lighting Core、Shadow、GI 的层级与组合尚未敲定。

### M12 · Temporal / Effects Domain

Temporal 基础、TAA、SSR、GTAO、Bloom、Exposure、Tonemap 等边界尚未敲定。

### M13 · Host / Diagnostics / Tooling

Browser lifecycle、DPR/quality、Device Lost 协调、Debug、Stats、Benchmark 和离线工具边界尚未敲定。

## 16. 当前推进点

当前只讨论：

```text
M01 Scene Runtime
  ├─ M01-L2/L4 Lifecycle + Hierarchy：DestroyLeaf/Subtree、Editable Forest、Compiled Block 已敲定
  ├─ M01-L4 Transform：剩余 Local Authority 切换与 Affine 物理细节
  └─ M01-L5 Change Architecture：架构已敲定，物理 packing 移交后续层次
```

下一项继续 M01-L4/M01-L6 的交界，敲定 Entity 如何在 `CPU-controlled`、`GPU-animated` 和后续 `GPU-procedural` Local Authority 之间切换，包括切换帧姿态连续性、Animation 状态、Change/PropagationSeed 和同步查询限制。需要 M04 实测才能决定的 Buffer packing、Depth Queue 和 upload threshold 保持待验证，不在 M01 中伪造性能结论。M10 Material Resolve 仍等其依赖的 Geometry/Visibility/Texture 契约稳定后再深入。

## 17. 模块内决策记录模板

```markdown
### Mxx-Ln · 层次名称

- 方向状态：待讨论 | 讨论中 | 暂定 | 已敲定 | 已否决 | 已替代
- 物理实现：不适用 | 待讨论 | 暂定 | 已验证
- 性能结论：无 | 待原型 | 已验证
- 日期：YYYY-MM-DD

#### 问题

#### source 依据

#### 必须满足的真实约束

#### 最简单可行设计

#### 真实候选与取舍（没有则不强行列）

#### 已敲定结果

#### 性能与复杂度后果

必须说明主要工作量随 N/K/V/材质数/纹理数/Pass 数等哪个变量增长。

#### 原型与验证门槛（如涉及性能/兼容风险）

#### 对其他模块的接口约束

#### 明确推迟或尚未敲定
```
