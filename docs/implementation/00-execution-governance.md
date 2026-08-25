# 00 · 执行治理与交付规则

## 目标

把架构路线约束成小批量、可回滚、可量化的工程工作，避免再次产生“文档已经完成，但运行路径、容量和性能没人能证明”的状态。

## 权威与变更规则

执行前按以下顺序核对：

1. 根 `AGENTS.md` 和命中目录最近的 `AGENTS.md`；
2. [ADR](../wiki/adr/README.md)；
3. [DIRECTION](../DIRECTION.md)、[ARCHITECTURE](../ARCHITECTURE.md)、[RENDER-PIPELINE](../RENDER-PIPELINE.md)；
4. [CURRENT-STATE](../CURRENT-STATE.md)；
5. 本实施手册。

如果实现发现长期决策不可行，先用 benchmark/正确性证据新增 ADR 来替代旧 ADR，再修改实施手册。不得静默把主管线改回三档管线、three.js 兼容路线或纯硬件/纯软件单一路径。

## 工作包模板

每个任务在 tracker 或 PR 描述中使用以下字段：

```md
ID: VIS-04
目标：一句话描述减少或建立的工作
依赖：已经完成的任务 ID/冻结 ABI
当前入口：现有真实运行文件和调用点
改动边界：新增、修改、删除的文件/模块
Producer：谁写什么数据、何时写
Consumer：谁读什么数据、何时读
ABI：字段、字节、对齐、版本
容量：默认值、上限、来源
Overflow：检测、fallback、counter
Owner/Lifetime：创建、复用、销毁、device lost
正确性：单元/GPU/截图/数值验证
性能：场景、对照、指标、允许回退
删除项：被替代的旧代码
文档更新：Context/ADR/CURRENT-STATE/Lesson
```

缺少 `Producer/Consumer`、`Overflow` 或验证方法的 GPU 队列任务不进入实现。

## 完成状态

| 状态 | 含义 |
|---|---|
| Designed | 契约已写明，但未进入真实主帧 |
| Implemented | 代码存在，可能仍是孤立原型 |
| Integrated | 主帧 producer/consumer 已接通 |
| Measured | 有固定条件的正确性与性能证据 |
| Completed | 通过退出门槛，旧链已删除，文档已更新 |

文档中的“完成”只指最后一种。原型和迁移开关不得被写成已交付能力。

## ABI 冻结流程

所有 Runtime Asset、GPU table、Work Queue、VisibilityKey 和 history resource 按以下顺序冻结：

1. 写出逻辑字段、producer、consumer 和可表达范围；
2. 给出 TypeScript 与 WGSL 共享的字节布局、对齐和 sentinel；
3. 增加布局断言和小型 encode/decode 测试；
4. 增加 capacity/overflow 测试；
5. 用最小垂直场景接通；
6. 冻结版本号后再展开下游实现。

TypeScript/WGSL 结构必须从一个可审查的 schema 或显式常量生成/验证。`*.generated.ts` 只能是生成物，生成来源和命令必须进入仓库。

## 性能实验纪律

- 每个优化只改变一个主要变量；记录 commit、浏览器、GPU、driver、分辨率、DPR、feature set 和 warm-up。
- 先保留变更前数据，再运行变更后数据；只报 FPS 不通过评审。
- 报告 CPU encode、submit 数、GPU 各段、工作量、显存、P50/P95/P99。
- 首次 pipeline/shader 编译与 warm frame 分开报告。
- 回退必须说明发生在哪类场景，而不是只展示最佳样例。
- 基线数据和截图是结果产物，不覆盖手工挑选的旧结果。

建议结果目录采用：

```text
OEngine/benchmarks/results/<yyyy-mm-dd>-<commit>/
├─ environment.json
├─ benchmark-a.json
├─ benchmark-b.json
├─ benchmark-c.json
├─ screenshots/
└─ notes.md
```

这是计划目录；在 `OBS-01` 创建 benchmark harness 前不存在不算缺陷。

## 迁移开关规则

允许短期存在 `legacy/new`、`HW/SW/Hybrid` 或算法 A/B 开关，但必须同时满足：

- 开关只用于验证，不进入公开 API；
- 两条路径共享相同输入、相机、分辨率和输出语义；
- 创建开关的任务同时写删除任务；
- 阶段退出时删除旧实现和开关，保留结果文件与 git 历史；
- HW/SW/Hybrid 是同一 Visibility 模块的实现选择，不是三套产品管线。

## 删除规则

删除前先用 `rg` 确认真正调用方与生成来源。替换完成后同一个工作包内删除：

- 无 consumer 的 Pass 和资源；
- 只服务旧 ABI 的 adapter、bucket、scan、shader 和统计字段；
- 已被新 owner 接管的缓存与 allocator；
- 过期 oracle/generated 文件及其死生成脚本；
- 永久保持 `false` 或只用于旧对照的 feature flag。

不为 reconstructed 命名或内部类保留兼容层。公开 `OEngine/src/index.ts` 若受影响，必须单独列出破坏性变化。

## 每阶段收尾

阶段负责人必须完成：

1. 更新 [CURRENT-STATE.md](../CURRENT-STATE.md) 的“已接入/关键缺口”；
2. 更新命中的 `docs/contexts/*/CONTEXT.md`；
3. 若长期决策改变，新增 ADR；
4. 若得到可复用性能结论，更新 `docs/wiki/lessons/performance.md`；
5. 把 benchmark 和验证命令链接进任务；
6. 运行构建、测试、链接检查和 `git diff --check`；
7. 确认下一阶段依赖的 ABI 已冻结。

## 总体停止条件

出现以下任一情况时停止扩展下游功能，回到最近一个 gate：

- 同一 ABI 在连续任务中反复破坏且没有 owner；
- benchmark 不能做到同场景、同画质、同分辨率对照；
- 队列 overflow 会静默漏绘；
- 设备丢失、resize 或 history invalidation 无法恢复；
- 新路径只增加 Pass/队列，却不能说明减少了哪种工作；
- 旧路径长期保留并迫使所有修改双写。
