# OEngine 内部文档

这里仅保存当前有效的工程事实。历史阶段、旧指标和被否决方案不在工作树保留，需要时使用 Git 查询。

## 阅读顺序

1. [PRODUCT.md](./PRODUCT.md)：产品范围、目标平台与非目标。
2. [ARCHITECTURE.md](./ARCHITECTURE.md)：当前模块、owner 和架构债务。
3. [PIPELINE.md](./PIPELINE.md)：真实帧流程与跨模块数据合同。
4. [STATUS.md](./STATUS.md)：唯一可变状态和下一步。
5. [VALIDATION.md](./VALIDATION.md)：完成与性能证据合同。

专项设计：

- [PERFORMANCE-INSPECTOR.md](./PERFORMANCE-INSPECTOR.md)：性能监视器的数据合同、UI、开源参考和实施步骤。
- [SHOWCASE-LAB-DESIGN.md](./SHOWCASE-LAB-DESIGN.md)：Storybook 颗粒化 Example Lab v0.2 设计和实施边界。
- [RENDERING-LAB-BENCHMARK-DESIGN.md](./RENDERING-LAB-BENCHMARK-DESIGN.md)：综合 Rendering Lab、实时 Inspector、Benchmark Suite 与相机距离归因实验设计。
- [RENDERING-LAB-PERFORMANCE-REPORT.md](./RENDERING-LAB-PERFORMANCE-REPORT.md)：Rendering Lab 浏览器实测、相机距离归因与渲染链路架构证据。
- [RENDERING-LAB-ARCHITECTURE-REPORT.md](./RENDERING-LAB-ARCHITECTURE-REPORT.md)：Rendering Lab 的 FrameGraph、GPU producer/consumer、资源生命周期与预算分析。
- [OEngine_Visibility_to_Surface_WebGPU_RFC.md](./OEngine_Visibility_to_Surface_WebGPU_RFC.md)：VisibilityKey → Surface 执行架构、分阶段迁移、回滚与量化 Gate。
- [OEngine_Visibility_to_Surface_WebGPU_EXECUTION.md](./OEngine_Visibility_to_Surface_WebGPU_EXECUTION.md)：RFC 的 M0-M7 测试驱动执行计划、阶段依赖与证据记录。

## 权威关系

- 协作规则：仓库及最近的 `AGENTS.md`。
- 长期决策：[adr/](./adr/README.md)。
- 外部算法、资产和许可证：[porting/](./porting/README.md)。
- 当前事实：源码、WGSL、测试和 Rendering Lab；文档与代码冲突时先修正文档。

## 决策与来源

架构变更先查 ADR。采用或改写外部实现前先查 porting ledger；未登记的表达性代码不得进入运行路径。

## 历史查询

工作树不设 archive。使用 `git log -- docs`、`git show <commit>:<path>` 查询旧阶段文档。
