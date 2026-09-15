# OEngine 文档系统

`docs/` 只保存仍影响当前产品、代码或交付的事实。已经完成的实施过程、被推翻的方案、逐提交记录和旧指标由 Git 历史保存，不在权威文档中复述。

## 六类文档

| 类型 | 位置 | 回答的问题 | 允许的内容 |
| --- | --- | --- | --- |
| 产品事实 | `PRODUCT.md`、`WEBGPU.md` | 做什么、面向什么平台 | 目标、非目标、能力线 |
| 当前事实 | `ARCHITECTURE.md`、`PIPELINE.md`、`STATUS.md` | 代码现在是什么 | owner、数据流、差距、下一步 |
| 决策 | `adr/` | 为什么选择这条长期方向 | Context、Decision、Consequences、Verification |
| 规范 | `specs/` | 两端必须精确一致什么 | ABI、格式、状态机、版本、兼容与验证 |
| 实施 | `implementation/` | 下一批可交付切片怎么闭环 | 活跃切片、退出条件、删除目标 |
| 来源 | `porting/` | 外部实现来自哪里 | revision、license、不变量、适配与验证 |

`others/` 是非权威研究区，不参加上述结构约束。研究结论只有被提升到产品页、ADR、spec 或 porting ledger 后才生效。

## 最短阅读路径

1. [PRODUCT.md](./PRODUCT.md) 与 [WEBGPU.md](./WEBGPU.md) 确认范围和平台。
2. [ARCHITECTURE.md](./ARCHITECTURE.md) 与 [PIPELINE.md](./PIPELINE.md) 找当前 owner 和真实数据流。
3. [STATUS.md](./STATUS.md) 看实现差距；[VALIDATION.md](./VALIDATION.md) 看证据等级。
4. 只有发生长期取舍时读 [adr/](./adr/README.md)，需要精确互操作时读 [specs/](./specs/README.md)，执行活跃迁移时读 [implementation/](./implementation/README.md)。

## 写入规则

- ADR 不保存阶段日志、代码清单、当前测试数或大段实现教程；`accepted` 只表示决策获准。
- spec 可以很精确，但必须声明状态、owner、版本/兼容和验证；未冻结字段不得伪装成 ABI。
- implementation 只保留活跃工作。切片完成并同步当前事实后删除过程叙述，由 Git 留档。
- `STATUS.md` 是唯一汇总可变进度和开放 gate 的页面；owner 附近 README 保存局部用法。
- 验证策略写入 `VALIDATION.md`；机器可读 case 和证据分别由 `validation/` 与 `OEngine/benchmarks/` 管理。
- 权威文档不得引用本机绝对路径、`temp/` 或研究区作为规范来源。

## 变更映射

| 变更 | 必须同步 |
| --- | --- |
| 产品范围或能力线 | PRODUCT/WEBGPU；必要时新增 ADR |
| 跨模块长期取舍 | ADR；实现状态另写 STATUS |
| 二进制、GPU 或跨线程合同 | spec + 对应 oracle/golden test |
| 新迁移阶段 | implementation；完成后回写 ARCHITECTURE/PIPELINE/STATUS |
| 外部代码或算法 | porting ledger |
| 运行或性能结论 | STATUS + 可复算 evidence，不塞进 ADR |

历史查询统一使用 `git log -- docs` 和 `git show <revision>:<path>`，不建立 archive 目录。
