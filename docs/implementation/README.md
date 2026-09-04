# OEngine 实施文档入口

本目录只描述如何执行、迁移、验证和删除。产品方向由 [DIRECTION](../DIRECTION.md) 与 [TARGETS](../TARGETS.md) 拥有，长期决策由 [ADR](../wiki/adr/README.md) 拥有，当前源码事实和阶段状态分别由 [CURRENT-STATE](../CURRENT-STATE.md) 与 [STATUS](./STATUS.md) 拥有。

## 阅读顺序

1. [STATUS](./STATUS.md)：当前唯一阶段状态、真实 owner、算法完成度和未关闭 Gate。
2. [13-product-render-pipeline-redesign](./13-product-render-pipeline-redesign.md)：已确认的目标架构，不是当前完成报告。
3. [11-render-pipeline-reconstruction](./11-render-pipeline-reconstruction.md)：阶段总路线、依赖和删除规则。
4. 按当前阶段阅读详细设计：
   - [Stage 0：证据基线与合同冻结](./14-stage-0-evidence-and-contract-freeze.md)
   - [Stage 1：Surface、Opaque HDR 与组合边界](./15-stage-1-frame-products-and-composition-seam.md)
   - [Stage 2：不透明光照、阴影与 GTAO](./16-stage-2-lighting-shadow-and-ao.md)
   - [Stage 3：Local Probe、SSSR 与 TAA/TAAU](./17-stage-3-reflection-and-temporal-reconstruction.md)
   - [Stage 4：透明、HDR Post 与 FrameGraph](./18-stage-4-transparency-post-and-framegraph.md)
   - [Stage 5：旧路径删除与产品闭环](./19-stage-5-legacy-deletion-and-product-closure.md)
5. [R5-BROWSER-GATES](./R5-BROWSER-GATES.md)：浏览器/GPU 证据格式和 Gate。
6. [R5-BENCHMARK-MATRIX](./R5-BENCHMARK-MATRIX.md)：性能、显存和带宽测量轴。

## 当前执行入口

```text
Stage 0 证据基线与合同冻结
  → Stage 1 Surface / Opaque HDR 组合边界
  → Stage 2 Lighting / Shadow / GTAO
  → Stage 3 Local Probe / SSSR / TAAU
  → Stage 4 Transparency / HDR Post / FrameGraph
  → Stage 5 Legacy Deletion / Product Closure

每个 Stage 是一个可独立提交的纵向切片；文档内再列出实现顺序，但不再拆成 P1-P9 wrapper 子阶段。
```

R5-Q 不建立第二条管线，也不推翻已经接受的 GPU Scene、Hierarchy、VisibilityKey、Surface ABI、GPU producer→consumer 和单主提交合同。当前重点是把现有算法从局部修正推进到综合画质、性能和删除闭环。

## 已接受的基础边界

R0–R4 的历史实现与证据已经合并进当前事实摘要和 porting ledger；不再维护按阶段重复的实施分册。需要追溯旧文档时使用 Git 历史，当前判断只看 [STATUS](./STATUS.md) 和 [CURRENT-STATE](../CURRENT-STATE.md)。

## 完成规则

只有同时满足以下条件，阶段或效果才能标为 `产品闭环`：

1. 真实 GPU producer→consumer、ABI、capacity、overflow、fallback 和 lifecycle 成立；
2. 算法实现和 shader 来源可追溯，未把参考实现简化成不完整版本；
3. CPU/reference/GPU/browser 正确性证据与风险匹配；
4. 性能、显存、上传和整帧预算有固定条件证据；
5. feature-off 接近零成本；
6. 被替代的旧 consumer、shader、资源 owner 和配置已删除，或有明确的截止任务；
7. `CURRENT-STATE`、Context、ADR、porting ledger 与真实代码一致。

“类已经创建”“Pass 已注册”“focused screenshot 通过”只能标为 `边界已接入` 或 `focused Gate`，不能标为产品完成。

## 阶段提交要求

每个阶段代码、测试、文档和验证完成后使用独立中文提交。提交正文必须写明实现范围、未改变的算法边界、已运行命令、未运行验证及原因；不得带入用户已有的 `three.js` gitlink 修改。
