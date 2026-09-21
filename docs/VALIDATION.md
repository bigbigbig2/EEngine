# OEngine 验证合同

验证只证明当前 revision 的声明。文档、类名、Pass 数量、旧 benchmark 或研究资料不能替代运行证据。机器路由来自 `project/claims/`、`checks/` 和每个 case 的 `case.yaml`；结果由 `validation/evidence/index.json` 和 `node tools/vibe.mjs status` 推导。

## 证明等级

| 等级 | 证明内容 | 典型检查 |
| --- | --- | --- |
| L0 | manifest、文档、链接、路径和静态 guard | model、changed-coverage、docs、ownership、legacy |
| L1 | CPU 单元、ABI/contract、oracle 和源码 guard | `engine-suites`（`OEngine/tests/unit|contract|oracle|guard`）、registry |
| L2 | 单个真实 WebGPU smoke | 命中的 component/candidate case、GPU diagnostics、readback |
| L3 | lifecycle、feature-off、cutover、device-loss/recovery | production case、替换/取消/恢复 gate |
| L4 | 固定环境正式 PERF | 固定 adapter、workload、warm-up、多 run 和可复算报告 |

旧术语只作为交付语境映射：DEV = L0 + L1（必要时 L2），MILESTONE = L0 + L1 + L2/L3，PERF = L0-L4。`kind` 描述验证性质，`level` 描述证明强度，两者不能互换。

普通修改默认执行最低命中的 L0/L1。GPU、render graph、资源生命周期、feature-off 或 capability 变更时，`node tools/vibe.mjs verify --changed` 会列出命中的 L2/L3 case；命令只报告 `notRun`，不会隐式启动浏览器。正式 L4 必须显式运行。

验证等级只从**产品面**推导：仅 `OEngine/src/**` 与 `validation/**` 参与 L2/L3 判定。测试、工具、检查、路由与文档路径属于工具面，即使文件名里写着 `framegraph`、`cutover` 这类概念，也只计 L1。

`verify` 把「拓扑一致」与「改动已被验证」分开报告，用退出码区分：

- `0`：检查全部通过，且没有本应运行却被跳过的 case；
- `1`：存在失败的检查、无主路径或路由歧义；
- `2`：检查全部通过，但改动所需等级的浏览器 case 未运行。`notRun` 的 case id 会打印到 stderr，且 `verificationComplete` 为 `false`；显式接受该缺口时传 `--allow-not-run`，它把退出码降为 `0` 但不会修改报告内容。

`engine-suites` 是 L1 的实际执行体：它先构建测试产物再跑 `OEngine/tests/unit|contract|oracle|guard`。这一步不能省略 —— `.test-dist` 过期会让 `node --test` 静默测试旧产物。套件内部禁止再回调整套门禁，重入时该检查报 `not-run` 并说明原因。

纯文档修改只需要静态检查。依赖或 lockfile 变化、clean reproduction、CI 和正式 PERF 才运行 `npm ci`。TypeScript/WGSL 改动按命中 owner 运行 typecheck 与 targeted tests；本地无法提供真实 GPU 时必须保留 `notRun`、`blocked` 或 `unsupported`，不能升级声明。

## Browser 宿主和 evidence

真实浏览器验证只能由 ADR-0014 的独立 `validation/` 宿主承担。自动 case 位于 `validation/cases/<id>/`，观察实验位于 `validation/labs/<id>/`；二者都由 case-local manifest 描述，registry 由 `node tools/vibe.mjs registry` 生成。`examples/` 和 Storybook 不产生 Runtime Validated、Performance 或 Pipeline 完成声明。

共享 harness 负责 WebGPU 初始化、canvas/resize、error scope、console/page/request error、nonce/run identity、readback、screenshot、dispose 和 artifact manifest。Case 只负责 setup、业务动作、采样和断言；lab 必须显式标记 `lab: true`、`automatic: false`。

每条 evidence 至少绑定 case、claim、check、commit/tree/dirty、registry/workload hash、contract hash、browser、adapter/capability、resolution/DPR、结果、artifact hash 和 freshness gate。raw artifact 只写入被忽略的 `.local/validation/<run-id>/`。接受条件是 clean revision、case passed、所有 gate 通过、artifact 完整且 required checks 覆盖；否则状态只能是 `unproven`、`diagnostic`、`stale` 或 `blocked`。

## 正确性门禁

- 新二进制或 GPU ABI：边界、非法输入、endianness/stride/offset、hash/checksum 和 CPU/GPU oracle 或 golden。
- 新 GPU 队列：元素 ABI、容量、overflow、counter、producer → consumer、零工作和 feature-off。
- 资源生命周期：replace、resize、toggle、camera cut、aborted submit、异步取消和 device loss/recovery。
- Renderer cutover：旧 source/public symbol、compiled graph/shader producer 和 CPU visible-list traversal 清除；真实 topology/counter 证明新 consumer 闭环。
- Nyx 迁移：按 `docs/porting/README.md` 对照源函数/Shader entry、决策分支、不变量、差异和 fallback；用 differential/negative corpus 加真实 GPU consumer 证明，未完成映射不能声明完成。
- 视觉算法：稳定数值 seam 加代表性视角；截图只用于确实需要视觉判断的项目。

## 性能和完成声明

正式比较固定 adapter、browser、canvas/internal resolution、DPR、画质、feature set、workload、seed、camera path、warm-up、sample window 和 cadence，并报告 GPU P50/P95、关键 phase、CPU build/submit、submit 数、counter 和按 owner 的内存。GPU timestamp 不可用时标记 unavailable，不能用 CPU 时间代替。

关闭 feature 时不得保留无消费者 Pass、资源、history、readback、counter copy 或独立 submit。`ImplementationComplete` 只表示实现和 DEV 门禁，`RuntimeValidated` 需要命中的 L2/L3 evidence，`PerformanceEvaluated/Improved` 需要 L4，`PipelineFeatureComplete` 和 `ADRComplete` 还要求对应 lifecycle、feature-off、cutover 和事实文档同步。claim 的当前声明永远不能超过 evidence 推导等级。
