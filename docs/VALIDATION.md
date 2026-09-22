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

普通修改默认执行最低命中的 L0/L1。`verify --changed` 根据改动选择保守的测试组，先增量构建最新 `.test-dist`；共享构建配置、未映射路径或无法安全缩小范围时自动扩大到全套。`verify --changed --plan` 只显示选择结果和原因，不运行检查或写生成物；默认执行输出是摘要，完整 payload 使用 `--json`，同时完整报告始终写入 ignored verification report。阶段集成与 browser acceptance 使用 `verify --full`。GPU、render graph、资源生命周期、feature-off 或 capability 变更会列出命中的 L2/L3 case；命令只报告 `notRun`，不会隐式启动浏览器。正式 L4 必须显式运行。

验证等级只从**产品面**推导：仅 `OEngine/src/**` 与 `validation/**` 参与 L2/L3 判定。测试、工具、检查、路由与文档路径属于工具面，即使文件名里写着 `framegraph`、`cutover` 这类概念，也只计 L1。

`verify` 把「拓扑一致」与「改动已被验证」分开报告，用退出码区分：

- `0`：检查全部通过，且没有本应运行却被跳过的 case；
- `1`：存在失败的检查、无主路径或路由歧义；
- `2`：检查全部通过，但改动所需等级的浏览器 case 未运行。`notRun` 的 case id 会打印到 stderr，且 `verificationComplete` 为 `false`；显式接受该缺口时传 `--allow-not-run`，它把退出码降为 `0` 但不会修改报告内容。

进入 required check set 的检查若返回 `not-run`，与未运行 browser case 一样令 `verificationComplete` 为 `false` 和退出码为 `2`。不适用于当前改动面的检查应从 required set 中省略，而不是以 `not-run` 假装完成。每次执行的 check 产生绑定 revision、tree、dirty、runner、registry hash 和结果的 receipt；receipt 只能记录真实 runner 结果。

`engine-suites` 是引擎 L1 的实际执行体：它先增量构建测试产物，再运行改动命中的 `OEngine/tests/unit|contract|oracle|guard`；full 模式运行全套。这一步不能省略 —— `.test-dist` 过期会让 `node --test` 静默测试旧产物。Native Nyx/Slang reference 只由相关参考源、WASM/native 工具或 ABI 变更触发。套件内部禁止再回调整套门禁，重入时该检查报 `not-run` 并说明原因。`validation-suites` 独立运行 validation typecheck 与 Node tests。

纯文档修改只需要静态检查。依赖或 lockfile 变化、clean reproduction、CI 和正式 PERF 才运行 `npm ci`。TypeScript/WGSL 改动按命中 owner 运行 typecheck 与 targeted tests；本地无法提供真实 GPU 时必须保留 `notRun`、`blocked` 或 `unsupported`，不能升级声明。

## Browser 宿主和 evidence

真实浏览器验证只能由 ADR-0014 的独立 `validation/` 宿主承担。自动 case 位于 `validation/cases/<id>/`，观察实验位于 `validation/labs/<id>/`；二者都由 case-local manifest 描述，registry 由 `node tools/vibe.mjs registry` 生成。`examples/` 和 Storybook 不产生 Runtime Validated、Performance 或 Pipeline 完成声明。

每个 manifest 显式声明 `evidenceRole: promotion | diagnostic`。promotion case 必须覆盖 claim，并通过该 claim 的 policy 参与提升；diagnostic case 可以使用空 `covers`，不能进入任何 promotion policy，也不能发布 accepted evidence。lab 固定为 diagnostic。

`case <id> --run` 是日常 diagnostic 路径：它执行 changed preflight，即使工作树干净也只能写 `diagnostic-only`。`case <id> --run --accept` 是正式验收路径：要求 clean revision，并执行或复用同 revision/tree/registry 的完整 full preflight。artifact schema v2 携带真实 check receipts 和 `validationMode`。Evidence index 只能从 artifact 中读取 receipts，不得根据 claim 的 `requiredChecks` 反向合成。receipt 的 revision、tree、dirty、registry hash 或 full scope 与 artifact 不一致时，evidence 不能晋级。

共享 harness 负责 WebGPU 初始化、canvas/resize、error scope、console/page/request error、nonce/run identity、readback、screenshot、dispose 和 artifact manifest。Case 只负责 setup、业务动作、采样和断言；lab 必须显式标记 `lab: true`、`automatic: false`、`evidenceRole: diagnostic`。

每条 evidence 至少绑定 case、claim、check、commit/tree/dirty、registry/workload hash、contract hash、browser、adapter/capability、resolution/DPR、结果、artifact hash 和 freshness gate。raw artifact 只写入被忽略的 `.local/validation/<run-id>/`。接受条件是 clean revision、case passed、所有 gate 通过、artifact 完整且 required checks 覆盖；否则状态只能是 `unproven`、`diagnostic`、`stale` 或 `blocked`。

Claim 的 `evidencePolicy` 显式区分 `allOf`、`anyOf`、`diagnosticCases` 与 `checkOnly`。只有 promotion 集合影响状态；lab/manual case 只能进入 diagnostic 集合。模型拒绝低等级 case 作为高等级 claim 的 promotion case。L4 只允许 `kind: perf` 且使用 `formal-1080p` profile；普通 GPU correctness 与 lifecycle 的上限是 L3。

`node tools/vibe.mjs evidence` 使用临时文件原子替换 compact index。若 `.local/validation/` 为空或缺少已有 case，命令默认拒绝删除 compact 记录；只有明确删除全部或部分 evidence 时才使用 `--force-empty` 或 `--force-prune`。`evidence --check` 只比较规范化输出，不写 index，也不要求 destructive override。

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
