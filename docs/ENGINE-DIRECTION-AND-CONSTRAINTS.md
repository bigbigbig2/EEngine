# 引擎实现方向与架构约束

> 状态：已接受，作为后续实现、重构和评审的权威约束。
>
> 适用范围：`research/shade-re/reconstructed`、配套资产工具、示例与验证代码。
>
> 当前事实以 [RECONSTRUCTED-FEATURE-GAP-AUDIT.md](./RECONSTRUCTED-FEATURE-GAP-AUDIT.md) 为证据；外部设计参考以 [WEBGPU-GPU-DRIVEN-REFERENCE-REPOSITORIES.md](./WEBGPU-GPU-DRIVEN-REFERENCE-REPOSITORIES.md) 为索引。两者都不能覆盖本文决策。
>
> 本文是前向约束，不表示当前代码已经全部符合；存量违反项按 M0–M4 逐步迁移，新代码不得继续扩大违反范围。

## 1. 文档权威与关键词

发生冲突时按以下顺序处理：

1. 本文的方向、约束与阶段门槛。
2. [CONTEXT.md](../CONTEXT.md) 的领域术语。
3. [ARCHITECTURE.md](./ARCHITECTURE.md) 记录的当前实现事实。
4. 全量审计、对比报告、参考仓库调研和教学文档。

本文使用以下规范词：

- **必须**：违反即不应合入；若确需偏离，先修改本文并记录理由。
- **应该**：默认遵守；偏离时必须在变更说明中给出证据。
- **可以**：允许的实现选择，不构成承诺。
- **暂不**：当前阶段禁止投入主线，不代表永久拒绝。

## 2. 产品定位

`reconstructed` 的目标是：

> 构建一个以浏览器 WebGPU 为基线、面向通用多模型场景、由 GPU 生成主要可见性工作的实验性实时渲染 Runtime。

它优先解决以下问题：

- 大量实例和复杂几何的可扩展场景表示。
- GPU Scene、几何层次、遮挡剔除和 Indirect 执行的闭环。
- Visibility Result 与延迟材质解析。
- 可验证的状态同步、资源所有权和性能观测。
- 从全驻留几何逐步演进到按页驻留与流送。

当前不是以下产品：

- 不以复刻某个 three.js、Nanite 或 Bevy 示例为最终目标。
- 不以完整 Gameplay、编辑器、物理、网络和脚本生态为近期目标。
- 不为了抽象而支持多个图形后端；WebGPU 是当前唯一后端和能力基线。
- 不以 Shader Graph、虚拟几何或 Compute 软件光栅作为近期“功能清单”。

## 3. 总体目标架构

```text
Source Assets
glTF / GLB / textures
        │
        ▼
Asset Compiler
decode → normalize → meshlet → LOD hierarchy → validate
        │
        ▼
Runtime Assets ───────────────┐
                              │ residency
World Objects ─┐              ▼
               ├─ Scene Change Set ─→ GPU Scene
Instance Sets ─┘                         │
                                        ▼
                              Visibility Work Generator
                       instance → hierarchy → meshlet → HZB
                              │                │
                              ├─ HW Work       └─ Second Chance
                              └─ optional SW Work
                                        │
                                        ▼
                               Visibility Result
                                        │
                              Material Resolve → Lighting → Post

Frame Graph owns frame scheduling and resource dependencies.
Telemetry observes every producer/consumer boundary and capacity limit.
```

## 4. 强制架构约束

### C01：WebGPU 能力基线

- 主线实现必须可表达为标准浏览器 WebGPU 能力。
- 不得把 `multi_draw_indirect`、mesh/task shader、buffer device address、64-bit atomics 或 subgroup 当作默认存在。
- 可选能力必须经过 capability profile，并有正确 fallback 或明确拒绝启动。
- 借鉴 Vulkan/wgpu-native 项目时必须区分算法与不可迁移的设备接口。

### C02：GPU-Driven 必须形成 producer/consumer 闭环

只有 GPU 产生或修改工作数量、紧凑列表或 Indirect 参数，并由后续 GPU consumer 实际消费，才可称为主链 GPU-Driven 能力。

- 只创建 Compute Shader 不算完成。
- 只写 Indirect Buffer、但最终仍由 CPU 遍历原列表不算完成。
- 每条新增工作队列必须标明 producer、consumer、容量、溢出行为和统计计数。

### C03：World 表示与 GPU Scene 表示分离

- World Object 负责独立身份、层级和游戏侧状态。
- GPU Scene 负责 GPU 查询和工作生成的数据布局。
- 两者之间必须通过 Scene Change Set 同步，禁止 Renderer 通过全量扫描和零散 version 猜测变化。
- GPU Scene 的稳定 handle 不得直接等同于 JavaScript 对象地址或数组下标。

### C04：普通对象与大规模实例使用两个真实 adapter

GPU Scene 必须接受两种场景来源：

1. World Object adapter：适合数量有限、独立更新、具有层级的对象。
2. Packed Instance Set adapter：适合共享几何/材质的大规模实例。

16 万个重复实例不得要求创建 16 万个 `Mesh`/`Node3D` 对象。静态 Instance Set 在稳定帧不得进行全实例 CPU 遍历或全量上传。

### C05：变更同步必须显式、增量且可验证

- transform、bounds、geometry、material、light 和 residency 变化必须产生明确的变更记录。
- 单对象变化必须只更新相关 GPU range 和派生结构。
- add/remove/reparent 必须对 World、GPU Scene、TLAS/层次和材质分类具有一致语义。
- 每种更新路径必须有“修改后下一帧可见”的集成测试。

### C06：资产内容与 GPU 驻留分离

- Geometry Asset 是设备无关且可序列化的内容。
- Resident Geometry 表示 GPU 当前可安全引用的内容。
- Loader 不得把临时解析对象直接变成长期 GPU 数据所有者。
- 所有 GPU 引用必须能追溯到 owner、生命周期和失效策略。

### C07：先全驻留 LOD，再页面流送

Geometry Hierarchy 必须先在全驻留条件下完成正确闭环：

- object-space geometric error。
- projected screen-space error。
- parent/child 互斥选择。
- bounds、hysteresis 和 debug view。
- GPU traversal、Indirect consumer 和 overflow fallback。

在上述能力通过验证前，暂不实现虚拟几何 page feedback、eviction 或磁盘流送。

### C08：Meshlet 不等于 Geometry Page

- Meshlet 是剔除和光栅工作的局部单元。
- Geometry Page 是驻留、流送和回收单元。
- 两者可以形成包含关系，但不得为了省一个结构而强制一一对应。

### C09：硬件 Visibility 是基线，软件光栅由证据驱动

- Hardware Visibility Raster 是默认正确性基线。
- Compute Raster 暂不进入主线里程碑前半段。
- 只有 GPU 统计证明亚像素/微三角形是主要瓶颈、LOD 已无法合理降低工作量，并且目标 adapter 上有稳定收益，才可以启动 SW/HW hybrid 原型。
- SW 与 HW 必须产生相同的 Visibility Result 语义和可比较的回归结果。

### C10：Visibility Work Generator 是深模块

实例筛选、层次遍历、Meshlet 展开、HZB、positive/maybe、Second Chance、材质分类、Indirect 参数和容量管理必须收口在一个模块接口之后。

Renderer 和示例不得知道：

- 工作 Buffer 的内部 offset。
- compact 使用 atomic 还是 prefix scan。
- positive/maybe Buffer 如何交换。
- Indirect 参数写在何处。
- 某一算法需要多少内部 Pass。

模块接口必须返回可消费的 Visibility Work 和可观测统计，而不是暴露内部可变 Buffer 集合。

### C11：Frame Graph 最终拥有单帧调度权

- 单帧 GPU producer/consumer 依赖必须由 Frame Graph 资源句柄表达。
- 新 Pass 不得绕过图直接提交跨 Pass 共享资源。
- 现有图外工作必须逐项迁入或在代码中标注 owner、原因和迁移门槛。
- Frame Graph 必须发展出读前未写、stale handle、冲突写、cycle 和 history 失效验证。
- transient、persistent 与 history 资源必须是不同生命周期类别。

### C12：资源必须有唯一 owner 和完整销毁链

- 每个 GPUBuffer、GPUTexture、pipeline cache、history 和 readback 资源必须能回答“谁创建、谁持有、何时销毁”。
- `Renderer.destroy()` 必须传递到所有 owned 资源；共享资源使用明确引用或 device 生命周期。
- resize、device lost、scene removal 和 feature toggle 必须定义资源失效行为。
- 重复 create/render/destroy 必须成为自动化压力测试。

### C13：CPU/WGSL ABI 必须单一来源

- 结构字段、对齐、offset、位宽和版本不得在多个调用点手写复制。
- Runtime Asset 和 GPU 表必须携带可验证版本。
- ABI 变更必须同时更新 packer、shader consumer、fixture 和兼容/拒绝策略。

### C14：任何容量上限都不得静默丢工作

Work Queue、Meshlet list、page request、material bucket 和 readback 都必须：

- 记录 capacity 与 high-water mark。
- 暴露 overflow counter。
- 采取增长、降级或明确报错中的一种策略。
- 禁止因越界而静默消失几何。

### C15：Telemetry 是功能完成条件

下列能力没有 counter、debug view 或 GPU timer 时不得标记完成：

- 实例/层次/Meshlet 剔除。
- LOD 选择。
- First/Second Chance。
- Indirect workload。
- Residency、page request 和 eviction。
- SW/HW 分类。

统计读回必须可关闭或降频，不能默认每帧同步阻塞 CPU。

### C16：材质先 Schema 化，不先做 Shader Graph

- Standard PBR 必须拆出 Material Schema、packer、分类和各渲染域 consumer。
- 新 shading model 不应要求在 loader、GPU metadata、Visibility、Material Resolve、透明、光追等位置重复判断同一语义。
- 在至少两个 shading model 通过同一 seam 工作前，暂不引入通用 Shader Graph。

### C17：资产导入与资产编译分离

资产路径应逐步形成：

```text
source decode → semantic normalization → validation
→ meshlet/LOD/hierarchy compile → Runtime Asset
→ residency/upload
```

- Draco、EXT_meshopt、KTX2/Basis 是 source decode 能力。
- Meshlet、LOD error 和 hierarchy 应优先离线生成。
- Runtime 必须能够拒绝损坏或 ABI 不兼容资产，而不是部分加载后继续渲染。

### C18：公开 seam 保持小而稳定

- `reconstructed/src/index.ts` 继续作为唯一公开 seam。
- 示例不得直接导入 `gpu`、`render/passes`、`framegraph` 或 shader 内部模块。
- 临时研究功能通过内部实验入口或 feature profile 接入，不把 Buffer 和 Pass 细节扩散到公共 interface。
- 公共 interface 的行为、错误模式、生命周期和性能特征必须有契约测试。

### C19：测试穿过模块 interface

- 测试验证 Scene Change Set、GPU Scene、Visibility Work Generator、Frame Graph 和资产编译器的可观察结果。
- 不为方便测试而把内部 Buffer、pipeline 或辅助 Pass 公开。
- 深模块 interface 测试建立后，重复测试内部浅模块的脆弱用例应删除。

### C20：许可证是实现约束

- 可复制或派生的实现必须来自许可证兼容且已记录固定版本的来源。
- 无许可证仓库仅用于理解思想，不复制、翻译或移植源码。
- All Rights Reserved 项目不得进入本地参考克隆、自动提取或派生流程。

## 5. 目标模块及 seam

| 模块 | 对外 interface 应表达 | 必须隐藏的实现 |
|---|---|---|
| Asset Compiler | source → validated Runtime Asset | 解码器、meshlet/LOD 构建器、序列化布局 |
| Runtime Asset Store | load/acquire/release、版本与错误 | 缓存、IO、解压、上传准备 |
| Scene Synchronizer | World/Instance Set → Scene Change Set | dirty tracking、range 合并、handle 回收 |
| GPU Scene | apply changes、稳定查询句柄 | GPU table、slot allocator、TLAS/派生更新 |
| Geometry Residency | request/acquire/release resident content | page table、budget、upload、eviction |
| Visibility Work Generator | view + scene → work + counters | compact、scan、bucket、HZB、indirect args |
| Visibility Raster | work → Visibility Result | vertex pulling、HW/SW pipeline、深度写入 |
| Material System | schema + instance → resolved shading data | packing、metadata、variant 和分类 |
| Frame Graph | resources + passes → validated execution | 调度、别名、生命周期、timestamp |
| Telemetry | frame snapshot / capture | counter buffer、异步 readback、采样频率 |

新建 seam 前必须满足“至少两个真实 adapter”或测试替身确有价值；否则优先保留为模块内部 seam，避免只增加转发层。

## 6. 依赖方向

```text
domain types / math / ABI descriptions
                ↑
world + source assets + material schemas
                ↑
asset compiler / scene synchronization
                ↑
GPU residency + GPU Scene
                ↑
visibility work + raster + material resolve
                ↑
Frame Graph orchestration
                ↑
Renderer composition root
                ↑
public interface / examples
```

约束：

- Renderer 是 composition root，不吸收算法实现。
- Frame Graph 可以调度模块，但不拥有领域数据。
- GPU 模块不能反向依赖示例或 Loader 的临时对象。
- Material、Geometry 和 Scene ABI 由描述层产生，shader 与 CPU consumer 共同使用。

## 7. 推进阶段与门槛

### M0：可验证基线与 P0 正确性

交付：

- 静态、动态、蒙皮、透明和重复销毁 fixture。
- CPU/GPU frame timing 与 Visibility counters。
- transform/material/light/texture dirty 闭环。
- Scene attach/detach/reparent 一致性。
- GPU 资源 owner 清单与完整 destroy tree。

退出门槛：动态修改下一帧正确；稳定静态场景不重复全量上传；自动化测试能发现资源和状态回归。

### M1：Packed Instance Set

交付：

- Instance Set 公共 interface。
- World Object 与 Packed Instance 两个 GPU Scene adapter。
- stable handle、partial transform update 和 GPU compact。
- 16 万茶壶基准的 CPU/GPU 分项统计。

退出门槛：16 万重复实例不创建 16 万个 World Object；稳定帧无全实例 CPU 遍历和全量上传；最终仍由 Indirect consumer 绘制。

### M2：全驻留 Geometry Hierarchy 与 GPU SSE LOD

交付：

- 离线 LOD/hierarchy compiler。
- Runtime Asset ABI。
- GPU hierarchy traversal、SSE、hysteresis、互斥选择。
- LOD debug view、counter 与 overflow fallback。

退出门槛：同一模型在相机移动时保持无洞、无父子重复；GPU 输出三角形数量随投影误差可解释地变化。

### M3：深化 Visibility Work Generator

交付：

- 收口当前 MeshletDrawList/VisibilityPass 的状态与内部 Buffer。
- Instance → hierarchy → Meshlet → HZB → bucket → Indirect 的统一 interface。
- First/Second Chance 可验证语义。

退出门槛：Renderer 不再了解工作列表 ABI；每个 producer 都有 consumer、capacity、overflow 和 counter。

### M4：Frame Graph、材质与资产可用性

交付：

- 主帧 GPU 工作进入可验证 Frame Graph。
- history reset 和 resize/device-lost 契约。
- Material Schema、Standard/Unlit 两个模型。
- Draco、EXT_meshopt、KTX2/Basis 与 Runtime Asset 编译链。

退出门槛：graph dump 能解释完整帧；新增材质模型不跨多个 consumer 复制分类逻辑；主要 glTF fixture 可确定性导入。

### M5：Geometry Residency 与流送

交付：

- Geometry Page、page table、fallback page。
- GPU feedback/request compact。
- IO/worker/decode/upload budget。
- eviction、引用安全和 telemetry。

退出门槛：在受控显存预算下运行大于预算的资产集，无错误消失、悬空引用或不可解释抖动。

### M6：可选 SW/HW Hybrid Raster

进入条件：M0–M5 的统计证明固定功能光栅在微三角形工作负载中是主要瓶颈，并有目标设备基准支持。

退出门槛：SW/HW Visibility Result 一致；分类阈值可观测；在目标 adapter 集合上有稳定净收益。

## 8. 暂不推进清单

在相应前置门槛完成前，暂不投入：

- 为了茶壶示例复制 three.js 专用 mega-buffer 架构。
- 以固定巨大 Work Queue 代替容量管理。
- 虚拟几何、虚拟纹理和虚拟材质的页面系统。
- Compute 软件光栅主线实现。
- 通用 Shader Graph。
- ECS、Gameplay、编辑器或多图形后端大重构。
- 仅增加新后处理效果而不修状态、所有权和验证闭环。

## 9. 变更评审清单

每个影响渲染架构的变更必须回答：

1. 它属于哪个目标模块，是否跨越了不应跨越的 seam？
2. CPU producer、GPU producer 和 GPU consumer 分别是谁？
3. 数据 owner、stable handle 和销毁路径是什么？
4. 静态帧是否产生不必要的扫描、上传或 readback？
5. Buffer 容量、high-water mark 和 overflow 行为是什么？
6. Frame Graph 是否能看到真实资源依赖？
7. CPU/WGSL ABI 是否来自单一描述？
8. 用什么 counter、debug view、timer 和 fixture 证明正确及有效？
9. WebGPU baseline 与可选 capability 的 fallback 是什么？
10. 是否引入许可证不兼容代码？

无法回答其中任一项时，变更仍处于实验状态，不应宣称完成主线能力。

## 10. 外部参考的使用方式

| 目标 | 首选参考 | 只学习什么 |
|---|---|---|
| 浏览器 Meshlet LOD 闭环 | nanite-webgpu | 几何误差、层次、统计、SW/HW 分类方式 |
| 成熟层次遍历与 two-pass | Bevy Meshlet | Asset ABI、BVH8、LOD traversal、Second Chance 编排 |
| GPU-resident 数据所有权 | renderling | slab、scene residency、draw/cull seam |
| GPU work generation 基线 | Niagara | producer/compact/indirect 的算法演进 |
| WebGPU 工程基础设施 | PlayCanvas、Babylon | device、cache、Frame Graph 与兼容性 |

参考实现用于验证设计问题，不决定本项目模块接口；迁移前必须重新检查许可证、WebGPU 能力和本地 ABI。

## 11. 已知存量违反项

下列事项是迁移输入，不是对约束的例外授权：

- CPU transform、材质、灯光等变化尚未统一产生 Scene Change Set。
- 普通 Mesh 注册表与场景层级仍是两套可能失配的状态来源。
- 大规模重复实例仍需要创建大量 `Mesh` 对象，尚无 Packed Instance Set。
- `MeshletDrawList`、`VisibilityPass` 和 Renderer 仍共同了解较多工作列表内部状态。
- 部分 GPU 工作和资源依赖仍位于 Frame Graph 之外。
- GPU 资源销毁链、device lost 和 history 失效尚未闭环。
- 示例中的实验几何仍可能直接导入内部 geometry 模块，迁移到正式 Runtime Asset 或公开 geometry seam 前不得把这种方式扩散到新示例。
- 全驻留 Geometry Hierarchy、GPU SSE LOD、Geometry Residency 与流送尚未实现。

每完成一个阶段，应从本节删除已经由代码和测试证明关闭的条目，并在 `ARCHITECTURE.md` 更新新的当前事实。
