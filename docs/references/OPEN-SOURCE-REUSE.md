# 开源实现复用与算法移植规范

## 目标

OEngine 的默认策略不是凭空重写已有成熟能力，而是先查找经过实际项目、论文或开源测试验证的实现，再选择直接依赖、局部移植、独立重实现或拒绝采用。范围包括：

- 渲染算法和 WGSL/GLSL/HLSL shader；
- GPU culling、HZB、scan、compact、indirect work generation；
- Meshlet、BVH、LOD、geometry compression 和 asset cooker；
- PBR、BRDF、IBL、shadow、OIT、TAA、SSR、GI 和 denoising；
- 矩阵、向量、四元数、hash、noise、sampling、color science 等数学库；
- glTF/USD、KTX2/BasisU、Draco、MikkTSpace 等资产处理；
- animation、ECS、空间结构、调试和 benchmark 工具。

## 采用优先级

### 1. 可直接依赖

适用于许可证兼容、API/平台适配、维护成本和包体都可接受的库。例如离线工具、格式 validator、纹理压缩工具和纯数学库。要求版本锁定、许可证记录、输入输出契约测试、升级策略和安全审查。

### 2. 可追溯局部移植

适用于实现成熟但平台不同的算法。例如把 Vulkan/C++ 的 meshlet builder、GPU culling 或 visibility buffer 逻辑适配到 TypeScript/WGSL。要求保留上游 commit/tag、源码路径、测试路径、许可证、不变量和 OEngine 差异；不能把上游平台能力隐含成 WebGPU baseline。

### 3. 按论文或规格独立实现

适用于论文、官方规格或无兼容代码实现。必须先建立 CPU reference/property test，再实现 GPU 版本；不能把论文中的伪代码当作已经通过的工程实现。

### 4. 拒绝采用

上游无许可证、许可证不兼容、依赖不可用 WebGPU 能力、性能假设不成立、维护成本过高或语义不适合时，必须记录 reject 和原因，不复制代码。

## 搜索要求

实现新的基础功能前，至少检查以下来源：

1. docs/references/GPU-DRIVEN-RESEARCH.md 的算法卡片；
2. docs/references/GPU-DRIVEN.md 的已登记移植记录；
3. 任务命中的领域 Context 和 ADR；
4. 官方仓库、论文、规格、测试和 benchmark；
5. 当前 OEngine 代码中的真实 owner、调用点和 ABI。

搜索结果只用于定位候选。README、博客或项目宣传不能独立证明算法正确性或性能。

## 迁移记录

每次采用外部实现必须记录：

~~~text
Reference ID
upstream project
repository URL
commit/tag
source file/path
test/example path
license and retained notice
maturity class
algorithm scope
input/output ABI
retained invariants
OEngine/WebGPU adaptation
precision and semantic differences
performance hypothesis
benchmark case
fallback and failure behavior
local test/regression
decision: adopt / port / reimplement / reject
reason
~~~

记录必须进入相关任务、ADR、Context 或 references/porting 文档。不能只写在聊天、提交说明或个人笔记中。

## 性能约束

复用成熟代码不等于无条件接受其成本。移植前必须明确：

- 上游优化减少了哪一种工作；
- OEngine 的 WebGPU 适配增加了哪些 dispatch、buffer、texture、branch 或 readback；
- 数据布局是否破坏 GPU coalescing、cache locality 或 bind limit；
- 是否引入全屏扫描、每材质循环、固定最大队列或每对象 JS allocation；
- overflow、fallback、device lost 和 in-flight lifetime 是否完整；
- 与当前实现相比的 A/B/C 单变量 benchmark。

如果开源实现更通用但更慢，优先提取算法不变量和测试，不直接移植其抽象层。性能退化必须能由 counter、timestamp、bandwidth 和 P50/P95/P99 解释。

## WebGPU 适配规则

- 64-bit atomic、multi-draw-indirect、mesh/task shader、buffer device address、subgroup 和 bindless descriptor 不得默认使用；
- 原生项目优先迁移算法和数据契约，另行设计 WebGPU producer/consumer；
- GPU 生成命令后必须由 WebGPU baseline 真正消费，不能 CPU readback 后遍历；
- 原子、storage texture、indirect dispatch、texture array、format 和 binding 数量都必须运行 capability validation；
- enhanced profile 可以使用额外能力，但必须共享正确性 ABI、fallback 和 benchmark schema。

## 数学和基础库规则

数学库、材质库和资产库也属于可复用实现，不能因为代码短就随意重写。采用时必须确认坐标系、矩阵布局、handedness、深度范围、clip convention、quaternion 插值、normal/tangent convention、color space、BRDF、NaN/Inf、边界值、bundle size、运行时分配和 CPU/GPU 结果容差。

## 依赖边界

- Core 可以依赖无 GPU、无场景语义的数学/ABI 工具，但不能反向依赖 Renderer；
- Loader 可以调用资产解析和验证库，但不能持有长期 GPU owner；
- Geometry/Cooker 可以调用 meshlet、压缩和空间结构库，但最终 package ABI 由 OEngine 冻结；
- Material 可以参考 Filament/glTF Sample Viewer 的 PBR 语义，但不能让外部材质对象进入 GPU 热路径；
- GPU/Render 可以使用外部生成的数据，但必须验证 owner、usage、capacity、residency 和 lifetime；
- public API 不得暴露不稳定的外部内部类型，除非明确将该库作为公开依赖。

## 完成门槛

使用外部实现的任务只有在以下条件全部满足后才能完成：source、license 和 commit 可追溯；上游算法与 OEngine ABI 的差异已记录；CPU reference 或上游测试通过；WebGPU producer/consumer 主链已接通；overflow、fallback、lifecycle 和 feature-off 已验证；benchmark 证明性能假设或明确记录采用它的非性能原因；旧实现和重复实现已删除，或者有明确截止任务 ID。
