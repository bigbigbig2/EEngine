# OEngine 移植与来源

这里只登记仍被运行代码、验证资产或当前架构消费的外部来源。历史候选和已拒绝且不再影响设计的研究从 Git 查询。

## 采用状态

- `direct dependency`：直接使用固定版本包并保留许可证。
- `traceable local port`：局部移植，固定上游 revision、路径和差异。
- `specification/reference reimplementation`：只采用规范、论文或数学不变量，表达性代码独立实现。
- `not adopted`：仅保留会影响当前替换决定的候选。

每条记录必须包含本地 owner、Upstream、Revision、Upstream source、License、Adoption、Retained invariants、OEngine/WebGPU differences、Fallback/lifecycle 和 Local validation。

## 领域

- [geometry.md](./geometry.md)：Cooker、Meshlet、hierarchy、camera 和保留资产。
- [visibility.md](./visibility.md)：GPU work、VisibilityKey、硬件可见性和材质分类。
- [shading.md](./shading.md)：Surface、PBR/IBL、光照、阴影、AO、SSR、透明与时域。
- [platform.md](./platform.md)：WebGPU、资源生命周期、cache、readback 和 FrameGraph。

许可证 notice 随依赖包或本地资产保留；ledger 不能替代上游许可证文件。
