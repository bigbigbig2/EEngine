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

许可证 notice 随依赖包或本地资产保留；ledger 不能替代上游许可证文件。
