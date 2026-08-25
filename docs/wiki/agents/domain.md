# 领域文档消费流程

```text
AGENTS.md
→ CONTEXT-MAP.md
→ docs/CONTEXT.md
→ 命中的 docs/contexts/*/CONTEXT.md
→ 更近的 OEngine/**/AGENTS.md
→ 相关 ADR
→ CURRENT-STATE / implementation / tracker
```

- 输出、Issue、测试名和代码注释使用 `docs/CONTEXT.md` 词汇。
- Context 解释术语，ADR 约束长期决策，CURRENT-STATE 记录事实；三者不可混写。
- 发现代码与 ADR 冲突时显式报告，不以当前实现静默覆盖决策。
- 新概念只有会跨多个任务长期使用时才进入 Context。

