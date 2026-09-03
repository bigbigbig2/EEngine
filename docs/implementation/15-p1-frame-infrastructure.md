# P1：FrameGraph 与 Render Feature 基础设施执行记录

状态：Implemented（算法重构留给 P2+）  
阶段：P1 统一帧图与资源生命周期基础设施  
对应设计：[13-product-render-pipeline-redesign.md](./13-product-render-pipeline-redesign.md)  
对应 ADR：[ADR-0012](../wiki/adr/0012-product-render-pipeline-redesign.md)

## 工作包定义

| 字段 | 冻结内容 |
| --- | --- |
| ID | `P1-FEATURE-01` |
| 目标 | 为主帧建立唯一 Render Feature 拓扑选择入口，并输出编译后 FrameGraph 的资源生命周期摘要。 |
| 依赖 | P0 目标/源码映射、R1 已有 FrameCoordinator/CompiledFrameGraph。 |
| 当前入口 | `resolveMainFrameFeatureTopology()`、`CompiledFrameGraph.dump()`、`Renderer.mainFrameGraphEvidence()`。 |
| 边界 | 本包不改变 TAA、SSR、SSAO/GTAO、Lighting 或 Visibility 算法；不新增 GPU submit，不改变既有 GPU ABI。 |
| Producer | `RenderFeatureRegistry.resolve()` 生产启用 Feature、persistent owner、history；`summarizeFrameGraphResources()` 生产 imported/transient/未使用资源计数。 |
| Consumer | `resolveMainFrameFeatureTopology()` 和 Renderer 的主帧拓扑/运行证据消费上述结果；调试与阶段 Gate 可读取 `mainFrameGraphEvidence().resources`。 |
| ABI/容量 | Feature ID/owner/history 为稳定字符串拓扑标识；无 GPU queue。FrameGraph 资源数量来自已声明资源表，不截断、不静默溢出。 |
| Overflow | 注册表构造时拒绝空 ID、重复 ID、自依赖和未知依赖；启用 Feature 的关闭依赖立即报错。资源摘要不修改资源表，故不会掩盖容量问题。 |
| Owner/Lifetime | Registry 不持有 GPU 对象；资源仍由 FrameGraph resource manager 管理，transient 遵循同 command 的 last-use 生命周期，imported 由原 owner 管理。 |
| 外部实现 | 本包没有移植新的算法；使用仓库现有 FrameGraph 编译/lifetime 实现。算法移植仍须按 `docs/references/README.md` 路由并登记。 |

## 实现内容

- 新增 `RenderFeatureRegistry`，统一校验依赖并在 Feature 关闭时不返回 owner/history。
- `MainFrameFeatureTopology` 改为通过注册表生成 persistent owner/history，保留现有 feature bits 和效果拓扑语义。
- 新增 `FrameResourceSummary`，从 compiled dump 统计 imported、transient、transient texture/buffer 及无消费者资源。
- `Renderer.mainFrameGraphEvidence()` 暴露上述摘要；摘要只读取 CPU 侧编译结果，不创建资源、不 readback、不增加 submit。
- 新增 P1 单元测试覆盖 Feature-off 零 owner/history、依赖校验、资源类型与被裁剪资源统计。

## 正确性与性能 Gate

- Feature-off：注册表不产生对应 owner/history；既有 FrameGraph pruning 测试保持通过。
- 依赖：启用 Feature 而依赖关闭时必须失败，防止半启用拓扑。
- 资源：摘要中的 `imported + transient` 与 compiled dump 资源总量一致，未使用资源单独计数。
- 稳定帧：摘要只在 graph compile/cache 命中后读取，不引入 GPU pass、readback、额外 command encoder 或 submit。
- 算法画面：本阶段不宣称 TAA/SSR/SSAO 画质改善；P2 起按各算法 Gate 验证。

## 验证记录

已运行：

```text
cd OEngine
npm run build:test
node --test tests/p1-frame-infrastructure.test.mjs
```

待阶段收尾继续运行：`npm run build`、`npm test`、命中的浏览器示例/生产构建，以及仓库文档链接与 diff 检查。若浏览器环境不可用，必须在提交说明中明确记录。

## 删除与后续迁移

P1 不保留新的兼容运行时。旧 Material Expand、旧效果算法和重复 owner 仍因尚未完成 P2+ consumer 迁移而保留；迁移完成后按 [14-p0-source-mapping-and-deletion.md](./14-p0-source-mapping-and-deletion.md) 和主设计文档逐项删除。每项删除前必须再次确认 producer、consumer、lifetime、overflow、correctness、performance。

## 阶段提交约束

本阶段代码、测试、文档和验证完成后使用独立中文提交，提交正文列出实现范围、未改变的算法边界、已运行命令、未运行命令及原因；不得把 `three.js` 用户现有 gitlink 修改带入提交。
