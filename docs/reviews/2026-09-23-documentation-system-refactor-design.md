# 文档系统重构设计（2026-09-23）

> 本文保存重构动机和设计边界，不是产品事实或完成声明。D1-D5 已于 2026-09-23 落地；当前机器事实仍由 `project/`、`checks/`、case-local manifest、正式合同和 evidence 提供。

实施结果：`context` 默认输出精简的行动摘要；domain frontmatter 只保留身份；活跃 workstream 已压缩为当前切片；case 使用显式 `evidenceRole`；阶段 review 已退出当前文档入口。后续普通修改遵循本文的文档准入规则，不再为每个阶段创建完成报告。

## 结论

文档系统不需要推倒重建。现有 domain、contract/spec、ADR、claim/evidence 的职责基础是正确的；日常负担来自同一事实被重复写入 domain YAML、domain 页面、workstream、阶段 review、claim 和 case，以及 `context` 把完整关联图一次性塞进开发上下文。

重构目标是把系统收敛为六种信息，并让每种信息只有一个主要 owner：

```text
路径路由        project/domains
当前实现事实    docs/domains
稳定约束        docs/contracts + docs/specs
长期取舍        docs/adr
当前未完成工作  project/workstreams/active
运行证明        validation/evidence + local artifacts
```

`docs/reviews` 只保存少量审计或重构设计，不再为每个开发阶段生成完成报告。普通提交和阶段历史由 Git 保存。

## 当前问题

### 同一事实有太多写入点

一个较大的 Cooker 切片会同时修改实现、测试、domain YAML、domain 页面、ADR/spec、claim、workstream、case、workload 和 review。近期一个相关提交修改了 46 个文件，其中 17 个是文档。很多修改并不是新知识，而是在多个位置同步“目前完成到哪里”。

### 当前事实和历史记录混在一起

活跃 workstream 同时保存当前任务、早期阶段结果、具体 run id、历史故障和未来计划。`web-100m-virtual-geometry.yaml` 已接近 500 行。它仍然可解析，但开发者很难快速回答“现在下一步是什么”。

### 上下文查询缺少信息优先级

查询一个 Cooker 文件会返回多个 domain、claim、check 和十余个 browser case，输出可超过三万字符。关联本身大多正确，但没有区分：

- 本次修改必须遵守的约束；
- 本次建议运行的检查；
- 阶段收口时才需要的验收；
- 仅用于历史追踪的关联。

### 文档 guard 有时冻结了形状而不是含义

固定 case 数量、固定目录全集、源码必须包含某个内部符号等检查，会让合法扩展或内部重构产生维护性失败。文档检查应证明引用、身份、owner 和必需结构有效，不应冻结当前规模。

## 目标信息模型

| 信息类型 | 唯一主要位置 | 允许包含 | 不再包含 |
| --- | --- | --- | --- |
| 路由 | `project/domains/*.yaml` | path、primary owner、直接 watch | 当前实现叙述、阶段进度 |
| 当前事实 | `docs/domains/*.md` | 生产数据流、owner 边界、主要入口、失败语义 | 历史实施过程、运行结果 |
| 稳定合同 | `docs/contracts/`、`docs/specs/` | 跨 owner 约束、ABI、状态机、版本兼容 | TODO、阶段状态、性能宣称 |
| 长期决策 | `docs/adr/` | 背景、选择、替代方案、后果 | 每次实现进展 |
| 活跃工作 | `project/workstreams/active/` | 当前目标、下一批任务、open gates、退出条件 | 完整历史运行明细 |
| 验证声明 | `project/claims/` | durable statement、promotion policy | 普通诊断场景 |
| 运行证明 | evidence/artifact | 环境、identity、receipt、测量结果 | 人工编辑的完成说明 |
| 外部来源 | `docs/sources/`、`docs/porting/` | upstream、revision、license、差异、不变量 | 当前项目任务状态 |

关系表、claim/check/case 列表和状态矩阵应从机器模型生成，不再由 domain 页面手工重复维护。

## 写文档的准入规则

### 普通修复

默认不新增 ADR、review、spec、claim 或 workstream。实现与现有测试足以表达的细节留在代码中；若修复改变已有合同，更新原合同。

### 内部重构

默认不新增文档。只有 owner 边界、生命周期或可观察错误语义发生变化时，更新对应 domain 或 contract。

### 新稳定协议或 ABI

更新或新增一份 contract/spec，并提供对应 contract/oracle。不要再为同一个切片额外创建阶段 review。

### 长期架构选择

只有存在长期替代方案、后续实现需要依赖该选择时才新增 ADR。ADR 接受后保持稳定，进度进入 workstream。

### 阶段执行记录

诊断结果保存在 `.local/validation`；正式结果进入 evidence。Git commit/PR 描述保存普通实施历史。只有跨多个版本仍有独立审计价值的内容才进入 `docs/reviews`。

建议的日常文件预算：

| 修改类型 | 通常新增文档数 |
| --- | ---: |
| 普通 bug fix | 0 |
| 内部重构 | 0 |
| 修改已有合同 | 0，更新原文件 |
| 新跨 owner 协议 | 1 份 contract/spec |
| 新长期架构决策 | 1 份 ADR，必要时更新一个 workstream |

## `context` 的新输出

默认 `context <path>` 只输出可行动摘要：

```text
owner
本次直接约束的 contract/spec
主要实现入口
建议检查及选择原因
需要 browser acceptance 的触发条件
```

详细信息改为显式展开：

```text
context <path> --claims
context <path> --cases
context <path> --all
```

默认输出不得展开完整 claim、case、workload 对象。每个关联项只显示 id、作用和为什么命中。目标是常规查询控制在约 100 行以内。

## Workstream 收敛

活跃 workstream 只保留：

```yaml
goal:
currentSlice:
nextTasks:
openGates:
exitCriteria:
links:
```

已完成任务只保留短摘要和 commit/evidence 链接，不内嵌大段指标或历史日志。超过一个阶段的详细结果迁移到 evidence 或 Git 历史；确有长期价值的审计最多保留一份汇总 review。

ADR-0018 的现有 Phase A-J 历史先不删除。等 K0/K1 边界稳定后，将其压缩为“已建立的不变量”和相关 commit/evidence 链接，活跃区只保留 K0、K1、K2 与 deferred S1。

## Claim 和诊断 case 解耦

正式 promotion case 必须继续绑定 claim，并进入明确的 evidence policy。普通 diagnostic case 可以只声明 domain、scenario、输入和断言，不要求制造一个 durable claim，也不要求在 claim 中反向登记。

建议给 case 增加：

```yaml
evidenceRole: promotion | diagnostic
```

规则：

- `promotion` 必须有非空 `covers`，并出现在对应 claim policy；
- `diagnostic` 的 `covers` 可为空，即使运行失败也不改变 claim promotion；
- lab 固定为 diagnostic；
- 从 diagnostic 提升为 promotion 是一次显式合同修改。

## Guard 重构原则

保留以下严格检查：

- id 唯一、引用存在、frontmatter 可解析；
- 每个生产路径有明确 primary owner；
- 生成物不能被手工当作权威；
- 退休入口不能复活；
- ABI、状态机和 evidence receipt 满足精确合同。

移除或替换以下检查：

- 当前 case、claim 或目录的固定总数；
- 文档目录必须与一个完整列表完全相等；
- 内部函数名或变量名必须出现在特定文件；
- 仅仅重复模型已经验证过的断言。

源码文本 guard 只用于无法通过公开行为观察的禁止性边界，并必须解释为什么 AST、类型或行为测试不能承担该证明。

## 实施顺序

### D1：缩短读取路径

实现精简 `context`，增加显式详细选项；输出直接引用 `verify --plan` 的测试选择结果。这个阶段不改变现有信息模型。

### D2：减少重复写入

从 machine manifests 生成 domain 页中的 claim/check/case 关系表；删除人工重复列表。建立上述文档准入规则和 review 新增规则。

### D3：压缩活跃 workstream

先处理 ADR-0018 workstream：保留当前 slice、open gates 和退出条件，把已完成阶段压缩成链接。随后处理 Nyx workstream。

### D4：诊断与声明解耦

引入 `evidenceRole`，允许无 claim 的 diagnostic case；更新模型、registry 和 artifact 测试。正式 promotion 路径保持当前严格度。

### D5：历史清理

按引用关系审计 `docs/reviews`。重复且只描述旧阶段状态的文件从当前入口移除，必要内容合并到一份历史汇总；不做一次性全仓库搬迁。

## 验收标准

- 普通 bug fix 不需要新增文档文件。
- 一个内部重构不因 case 总数、目录总数或内部符号位置变化而失败。
- `context` 默认输出少于约 100 行，并能直接说明建议测试。
- domain 当前事实只维护一份，关系表由模型生成。
- 活跃 workstream 首屏可以看到当前 slice、下一步和 open gates。
- 新增 diagnostic case 最多需要 case manifest 和实现，不要求新增 claim、ADR 或 review。
- promotion case、ABI、owner 和正式 evidence 的严格性不降低。

## 与当前开发计划的关系

验证流程 A/B/C 已先行解决等待时间、重复 preflight 和脆弱测试问题。文档重构按 D1-D5 单独推进，不阻塞 ADR-0018 的 Product identity、纯 Producer K0、activation-first 和增量 publication。后续每完成一个相关实现切片，只更新真正发生变化的当前事实或合同，不再创建阶段完成报告。
