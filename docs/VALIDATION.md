---
id: validation
state: current
verifies:
  - checks
  - validation
---
# 检查、测试与结论范围

开发节奏以根 AGENTS.md 为准。本页维护通用验证要求与失败分类，说明工具当前能做什么，不复制模块阶段或建立逐 patch 门禁；旧迁移执行计划只保留历史结果。

当前按用户方向先补功能效果，再集中优化完整组合。新增功能不要求比“关闭该效果”更快，也不以V5正式净收益/60FPS先通过为前置；已有性能失败和缺项仍保留，最终性能资格不因此取得。

## 什么时候检查

| 时点 | 工作 |
| --- | --- |
| 日常编码 | context 导航；按调试需要 typecheck/build/targeted test |
| 大模块连通 | 集中 typecheck/build/新鲜build:test/必要targeted tests；真实GPU producer→consumer、实际画面/调节/开关、独立预期、边界、生命周期、资源上界与粗粒度成本 |
| 功能组合稳定后的集中整合 | 生产browser matrix、完整动态画质、CPU/GPU归因与优化、同条件P50/P95/P99、冷启动/交互长尾、4GB同时峰值与OS驻留 |

阶段内可临时断链，单元结束必须编译修复、真实闭合。必需失败或未验证项不因正式验收在后面而忽略；不使用旧链、空 consumer 或占位结果通过。

新增效果的粗粒度成本说明必要新增资源、采样/访存、同步、dispatch与最坏容量，不强制每个模块进行全Renderer多轮ABBA。为提速而引入的cache/低频/压缩候选仍须证明语义及收益。已发现的错误、漏工作、失控资源和实际无法运行不能延期；普通性能调优与正式资格留集中阶段。

## 当前真实入口

| 命令 | 实际范围 | 不证明的事情 |
| --- | --- | --- |
| `node tools/docs-verify.mjs` | 文档元数据、声明路径、部分链接 | 正文正确、设计已实现 |
| `node tools/vibe.mjs doctor` | 模型/registry 结构及只读字节比较 | 正文与源码一致、算法正确 |
| `node tools/vibe.mjs verify --module` | engine typecheck/build | 未指定测试、浏览器或 GPU 已运行 |
| `node tools/vibe.mjs verify --module --test OEngine/tests/...test.mjs` | 上述检查、新鲜 build:test、显式 targeted test | 未覆盖生产分支的算法或整个场景正确 |
| `node tools/gpu-oracle.mjs <name>` | 显式真实 GPU oracle | 其他 oracle/生产场景/性能通过 |
| `node validation/src/runner/run-case.mjs <case-id>` | 选定 browser case 的诊断运行 | claim 晋升或全矩阵通过 |
| `node tools/vibe.mjs verify --full` | 当前 catalog checks 与 engine/validation suites，GPU check 为 environment-probe | matched browser cases 已自动运行、数值 GPU/质量/性能完整验收 |

`--plan` 只显示计划。module 不加载完整验收模型，不要求 clean revision；普通开发不被未实现的未来 provider 或正式证据阻塞。

旧 `verify --changed`、claim 晋升与 case runner 的 `--accept` 已退休。vibe 没有现行 evidence/status/case 命令。当前 artifact v3 只接受 diagnostic 模式，不恢复历史 accepted/receipt 分支。

<a id="validation-failure-contract"></a>

## 测试可信度与失败分类

测试先核对当前生产入口、独立预期、目标分支确实执行，以及错误行为会被拒绝。mock 可验证局部协议和生命周期，源码结构检查可验证架构约束；都不能代替生产 WGSL 数值和实际 GPU 成本。

正常合法成功、边界和局部拒绝必须可区分；永久 fine/miss、零有效 provider、预填正确输出、只断言出图或预算未超，不证明完整算法。正确性与成本分开核对，容量减少不直接证明帧时收益。

失败保留原始输入、输出、日志及 source/build 身份，先分清 implementation bug、architecture bug、retired ABI test、fixture、lifecycle、GPU numerical、environment/tooling 与 performance。核对最小复现和独立预期，修根因并重跑原例及相关回归；无法解释就保持未通过，偶然复跑绿色不追认为修复。

覆盖目标分支、tails/overflow 和完整容量域，证明有效非零 provider 与最终产品消费；opaque HDR 每像素唯一 writer，background 独立完整写域。新闭包的隔离验证与最终 production 验证分开说明，前者不能代替后者。

退休时可删或迁移旧表示测试；material numeric、C/X/Y/LOD、normal、coverage、HDR/preExposure、motion、publication atomicity、update/abort/retry、device loss、唯一 writer 与 fence 退休语义必须留给新 owner。不跳必需断言、吞异常、放宽容差、漏像素、缩最终场景或加测试专用 production fallback；预期变化须有数学/来源/新合同依据，质量或功能范围改变按用户授权处理。新 owner 的已知正确性、生命周期或容量缺陷不得借最终性能延期而后移。

## 新鲜度与报告

最终源码变动后使用新鲜 build，重跑受影响验证；不拼接不同快照。GPU 作业串行。超时、不完整 runner、skip、缺浏览器/adapter、不可用 timestamp 明确列出，不能当完成。

GPU oracle 在运行前后验证 .test-dist 的源码输入/编译产物身份；缺失或过期时显式 build:test。构建会先清理旧产物，避免删除源码后还测到旧 JS。能力需求由 oracle 登记并在资源创建前协商，缺能力不静默改弱设备。环境 probe 只证明 GPU 可达。

Node 用例通过 TestsStream reporter 汇总完成、失败、取消与 skip，不能用打印的“通过数量”冒充执行。`--json` stdout 是单个结果，日志写 stderr；full 区分 complete/incomplete/failed，并明确 browser/performance 未运行。正式完成不能只看命令名。

新增/修改工具回归统一由 checks 的 tooling-suites 调度。真实 GPU oracle 与生产 browser case 仍显式选择，不给普通开发增加自动浏览器门禁。

browser host 的 nonce、身份、错误聚合、dispose、artifact ownership 仍有效，合同见[browser harness](contracts/browser-harness.md)与[validation case](contracts/validation-case.md)。

最终性能比较方法由当前执行计划维护。固定 revision、设备、浏览器、尺寸、camera path、feature/质量、warm-up、热状态与窗口，保存实际样本和 Surface/整帧指标。不从历史诊断或不同条件的数据作性能通过声明。
