# 架构变更流程

架构变更包括：新增/改变模块所有权、公开 interface、GPU ABI、主管线阶段、长期 capability baseline 或资产格式。

变更前回答：

1. 问题由 benchmark、正确性还是产品目标证明？
2. 所有权落在哪个 module？
3. 新 seam 是否有真实变化点，而不是假想抽象？
4. CPU producer、GPU producer、GPU consumer 分别是谁？
5. 数据 ABI、容量、溢出、生命周期是什么？
6. 如何与 three.js A/B 和 OEngine C benchmark 对照？
7. 是否与现有 ADR 冲突？

改变长期决策时新增 ADR；只改变实现且保持契约时更新 CURRENT-STATE 和相关 Context 即可。

