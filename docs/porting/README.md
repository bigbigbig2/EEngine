# OEngine 移植与来源

这里只登记仍被运行代码、验证资产或当前架构消费的外部来源。历史候选和已拒绝且不再影响设计的研究从 Git 查询。

## 采用状态

- `direct dependency`：直接使用固定版本包并保留许可证。
- `traceable local port`：局部移植，固定上游 revision、路径和差异。
- `specification/reference reimplementation`：只采用规范、论文或数学不变量，表达性代码独立实现。
- `not adopted`：仅保留会影响当前替换决定的候选。

每条记录必须包含本地 owner、Upstream、Revision、Upstream source、License、Adoption、Retained invariants、OEngine/WebGPU differences、Fallback/lifecycle 和 Local validation。

## Nyx 算法忠实移植门禁（ADR-0016）

Nyx 移植以**算法与语义忠实度**为准，不以逐行翻译、相同语言/API、相同 struct 布局或 Native/Web 产物字节相同为准。命中 Nyx 来源范围的 Web Cooker、Offline Cooker 和 GPU consumer 必须分别建立源函数/Shader entry point → 生产实现的映射，逐项保留算法阶段、关键分支/接受拒绝条件、数据依赖和正确性不变量。语言转换、WASM/Worker 编排、DX12/Slang → WebGPU/WGSL 的资源与执行模型转换，以及为 OEngine 生命周期增加的安全约束，属于允许且必须记录的适配；不能借此用自研简化器、扁平层次、CPU 最终可见列表或仅有 root pin 的路径替代 Nyx 核心算法。

每个映射记录还必须写明输入/输出、实际生产 owner、与源算法不同的行为及其原因、所需 fallback、许可证和验证。对照验证比较拓扑、bounds/error、refinement、合法 cut、Page 独立性、缺页回退、需求/驻留和 Visibility identity 等结构与语义，不要求不同 Producer 的 ID、布局、压缩字节相同。若平台限制导致上述核心语义无法保留，必须停止该切片并请求方向确认，不得自行换成另一算法或把语义变化默认为“平台适配”。只有命中的 differential/negative oracle 与真实下游 consumer 证据齐备，才可称相应 Nyx 移植项完成。未覆盖的函数和证据须明确标记为未完成，不得用“沿用 Nyx 思路”概括为已移植。

## 领域

- [geometry.md](./geometry.md)：Cooker、Meshlet、hierarchy、camera 和保留资产。
- [visibility.md](./visibility.md)：GPU work、VisibilityKey、硬件可见性和材质分类。
- [shading.md](./shading.md)：Surface、PBR/IBL、光照、阴影、AO、SSR、透明与时域。
- [platform.md](./platform.md)：WebGPU、资源生命周期、cache、readback 和 FrameGraph。
- [next-renderer.md](./next-renderer.md)：Next 当前选型所需的固定版本候选、源码入口、许可证与 WebGPU 适配；候选不等于已采用，不覆盖上述 ledger 的既有 revision。

## Next 通用算法迁移规则（ADR-0020）

完整算法或效果开工前，先查 GitHub 上可核验的完整开源实现，再查论文及足以复现决策条件、阶段和数据流的详细技术文章；不限制源语言。优先迁移许可证兼容的完整实现，而不是根据算法名字自行写近似替代。每个迁移切片先声明有边界的 algorithm profile，固定 upstream revision、许可证、具体源文件/entry point 与第三方来源，写入 [Next 来源账本](./next-renderer.md)；以逐项表映射源函数/阶段、关键分支、输入输出、数据依赖、不变量和降级条件到本地 owner、产物、Pass/WGSL 阶段、差异/fallback/未覆盖项及对照入口。

**不得以降低工作量为由简化选中算法。** 必要阶段、接受/拒绝条件、历史更新与失效、边界/缺页/溢出语义均须保留；不能跳过分类、降噪、状态管理或样本生产后宣称完整移植。语言、资源布局、bindings、dispatch 和生命周期可以适配 WebGPU，但算法行为变化必须单独记录。若平台无法保留核心语义，说明具体缺口并确认调整后的算法/profile，未完成部分不得升级状态。

这不要求搬走上游整个引擎、所有可选模式或依赖宿主；事先明确排除无关功能是合法范围选择。若需要替换为另一完整算法，显式改变来源和采用决定，不在同一个名称下暗中换成简化近似。最终设计未预定的本地编排或新算法研究须如实标记，不能虚构 donor。

找不到完整 donor 时，先记检索范围、各候选缺口和具名本地方案，不得把该方案写成已完成上游移植。简单确定性工具、ABI 编解码、WebGPU 绑定与生命周期胶水标为本地集成，不强制外部调研；不得把复杂算法拆成小任务后按此豁免。来源核对、WGSL/CPU oracle 和新生产主链的真实 GPU producer→consumer 证据齐备，才可把 `not adopted` 改为对应采用状态；模块代码收口的 typecheck/build/targeted tests 与最终 browser、性能、formal evidence 的时机仍按 [VALIDATION](../VALIDATION.md) 执行。

验证按完整切片组织：优先复用受影响测试、一组关键算法对照和独立 validation 场景，不为每个函数/机械搬迁新建 case；队列/ABI/数学风险补必要的针对性检查。正式集成和性能声明仍沿用仓库规则。Nyx 的专门不变量继续适用，不被这项通用规则降低。

许可证 notice 随依赖包或本地资产保留；ledger 不能替代上游许可证文件。
