# OEngine 内部文档

这里仅保存当前有效的工程事实。历史阶段、旧指标、执行日志和被否决方案不在工作树保留，需要时使用 Git 查询。

## 阅读顺序

1. [PRODUCT.md](./PRODUCT.md)：产品范围、目标平台与非目标。
2. [ARCHITECTURE.md](./ARCHITECTURE.md)：当前模块、owner 和架构债务。
3. [PIPELINE.md](./PIPELINE.md)：真实帧流程与跨模块数据合同。
4. [STATUS.md](./STATUS.md)：唯一可变状态、开放风险和下一步。
5. [VALIDATION.md](./VALIDATION.md)：完成、正确性和性能证据合同。

## 专项入口

- 长期架构决定：[adr/](./adr/README.md)。
- 外部算法、资产和许可证：[porting/](./porting/README.md)。
- Performance Inspector：[`OEngine/src/addons/inspector/README.md`](../OEngine/src/addons/inspector/README.md)。
- 浏览器示例与 Storybook：[`examples/README.md`](../examples/README.md)。
- Rendering Lab：[`examples/rendering-lab/README.md`](../examples/rendering-lab/README.md)。
- 机器可读 benchmark 与审计结果：[`OEngine/benchmarks/README.md`](../OEngine/benchmarks/README.md)。

## 权威关系

- 协作规则由仓库及最近的 `AGENTS.md` 决定。
- 跨模块长期决定进入 ADR；实现事实进入 `ARCHITECTURE.md` 和 `PIPELINE.md`。
- 当前进度、风险和下一步只进入 `STATUS.md`。
- 外部来源、许可证和本地移植边界只进入 porting ledger。
- 源码、WGSL、测试和可复算 artifact 是运行事实；文档与运行事实冲突时修正文档。

## 内容准入

- 顶层 `docs/` 不保存任务计划、阶段 checkpoint、逐提交日志或临时性能报告。
- 本机探索数据不能成为权威事实；被接受的性能基线必须满足 `VALIDATION.md` 并保存可复算 provenance。
- 子系统用法放在 owner 附近的 README；不要在 `docs/` 复制一份。
- 架构变更先查 ADR；采用或改写外部实现前先查 porting ledger。

## 历史查询

工作树不设 archive。使用 `git log -- docs`、`git show <commit>:<path>` 查询旧阶段文档。
