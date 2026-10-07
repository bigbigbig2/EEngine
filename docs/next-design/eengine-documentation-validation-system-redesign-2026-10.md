---
id: eengine-documentation-validation-system-redesign-2026-10
kind: design
status: accepted
state: current
verifies:
  files:
    - tools/docs-verify.mjs
    - tools/vibe.mjs
    - tools/vibe-acceptance.mjs
    - tools/vibe-lib.mjs
    - tools/check-runners.mjs
    - validation/src/shared/registry.mjs
    - validation/src/shared/artifact.mjs
    - validation/src/runner/run-case.mjs
---
# EEngine 文档与测试体系轻量收口方案

日期：2026-10-05。用户已要求按本方案实施。本文保留轻量约束，并将评审发现与收口核对合并在本文件；不另建审计/进度文档。工具重构已实施，Renderer 目标架构不因此完成。

事实依据是本次对当前工具、生产主链接线和真实执行的核对。引擎目标仍由[极致性能母稿](./eengine-v4-native-shading-2026-10.md)负责。

## 1. 要解决什么

用户要求的重点是：**测试能发现真实问题，文档与源码及引擎目标一致，删除旧内容并合并重复总结，维护过程轻量。**

因此不新建 claims 层、工作流平台、统一证据数据库、逐 patch 门禁或复杂 manifest/schema 系统。沿用现有 CLI、测试目录和 Markdown/YAML；只有真实发现缺陷的检查值得保留。

“准确”分成三件事：测试调用当前生产入口；预期有独立依据且能拒绝错误行为；结论只覆盖实际运行的内容。文档同样分清当前实现、目标设计和历史观察。

## 2. 文档保留结构，减少维护位置

| 内容 | 放哪里 | 维护要求 |
| --- | --- | --- |
| 长期目标与架构约束 | 当前极致性能设计母稿 | 唯一目标依据，不复制到每份文档 |
| 当前阶段 | workstream 的 currentSlice | 入口仅链接，不复述阶段 |
| 切换步骤、模块退出条件 | 当前执行计划 | 不再维护竞争的阶段计划 |
| 已实现原理与缺口 | 现有 6 个 docs/domains 页面 | 每个 owner 一份总结；源码是事实依据 |
| 稳定 ABI/跨 owner 合同 | contracts/specs | 确有生产 producer/consumer 才保留 |
| 来源、映射与采用 | sources/porting | 来源身份和本地采用分开，不复制 adoption |
| 日期化审计、性能诊断 | reviews/performance/archive | history，只供追溯 |

不要合成一本混杂所有内容的大文档，也不为每个实现新增总结。模块完成后，将散落的实施说明归入对应 domain；设计里保留理由和目标，执行里保留顺序，报告里保留当时结果。

state 三值继续遵守根规则。current 表示正在使用，**不表示设计已经实现**；history 不能成为当前规范。已有 kind 可继续区分 design/contract/domain/report，不强制全仓增加新字段。

verifies.files 继续作为依赖提示，不宣传为自动证明正文真实；文件存在只证明没有断路径。源码变化时先复核受影响页面，不自动把整份文档判为错误，也不要求每次 patch 同步全部文档。

## 3. 清理与合并，逐份决定

### 3.1 先处理已确认的漂移

- README、docs/README：统一当前母稿/计划的名称，删除旧阶段叙述与重复入口。
- VALIDATION：按根规则写真实开发节奏；删除旧 Phase5→5.5→6→7 和退休命令。
- claims-and-evidence：标记 history，退出当前合同入口。claim 层已退休，不能继续描述它是现行实现。
- browser-harness、validation-case、project-routing、generated-registry：保留真实协议，删除不存在的 promotion/preflight/claims 承诺。
- platform/domain 索引：总结现有导航、checks、诊断宿主和 GPU oracle，明确 --full 尚未自动调度全部 browser cases。
- 旧架构层计划：退出当前执行入口，避免第二套阶段顺序。

### 3.2 再核实已实现内容，按 owner 合并

不能因为文件写着“完成”就归纳为完成。每个模块只做一轮核对：

1. 找真实生产入口、产品和全部直接 consumer；确认实际接线。
2. 找保留价值：算法/数据流、不变量、失败行为、关键设计理由。
3. 将这些内容合并进对应 domain；稳定 ABI 保留独立合同，来源映射仍在 porting。
4. 记录尚未实现或未验证的部分；旧计划、重复进度、失效接口退出当前阅读路径。
5. 最后删除或归档原文，修其直接引用，不先批量删掉再找语义。

与引擎目标的核对只看：GPU-Driven、WebGPU Native、性能与 AAA 质量、唯一生产路径、可扩展 provider 合同。未来 VG/VT/VS/ReSTIR/SSGI/Atmosphere/Temporal/AI Upscaling 仍是目标的，不能混成“已实现”；缺消费者的通用基础设施也不能当作架构完成。

已归档的历史文件不逐句重写。确认已被归纳且无追溯价值的重复文档可以删除；保存原始审计与性能身份，避免改写历史结果。

### 3.3 小份处理表，不长期维护新登记系统

执行清理时使用一次性表：

| 文件/主题 | 当前生产依据 | 动作 | 保留的语义 | 合并去向 | 未验证项 |
| --- | --- | --- | --- | --- | --- |

表完成后转成日期化记录。不要另建一份永久 current 状态清单，否则又制造漂移。

## 4. 测试先审有效性，再考虑数量

### 4.1 每个关键测试只回答四个问题

| 问题 | 必须看到的东西 |
| --- | --- |
| 测了谁？ | 当前生产入口或真实生成 WGSL；mock 的范围明确 |
| 预期从哪来？ | 独立数学/CPU reference、规范或可解释 fixture |
| 错了会失败吗？ | 能区分正确输出与原缺陷/受控错误行为 |
| 实际测到了吗？ | 目标分支、非零产品和真实 consumer 的执行证据 |

不增加复杂测试审批表。测试本身和少量注释说明生产入口/独立预期；审查模块时用上述问题检查。

### 4.2 测试分类处理

- **保留**：能发现身份、生命周期、数值、边界、错误传播、容量/写域等真实缺陷。
- **改写**：旧 ABI 或 fixture 与新生产接口脱节，但原来的语义仍需要验证。
- **删除/退休**：只服务已删除 producer/合同、源码字符串镜像、预填正确输出、只断言“有结果/未超预算”却没有有效分支依据的重复测试。
- **新增**：已有设计要求或真实缺陷没有覆盖，补最小敏感回归；不追求测试数量。

源码结构检查仍可验证“禁止第二 submit/禁止旧 owner”等架构规则；它不能证明算法数值或 GPU 性能。mock 也可验证资源生命周期/调用协议，不能升格为真实 WGSL 执行。

### 4.3 防伪通过的关键要求

- 有普通合法成功与局部拒绝/失败，不能永久 fine/miss/零 provider。
- 原缺陷或受控错误 fixture 能让测试失败；不在 production 加故障开关。
- 预期修改必须有独立依据；不能复制生产结果作为 oracle。
- 真实 GPU 调用生产 shader，核对数值产品；错误 scope 为零不能代替结果断言。
- 完整身份、generation/reset、唯一 writer、互斥写域分别核对；预算未超不等于实际工作已经删除。
- 正确性与性能分开：实际 dispatch/写入/资源量/计时，不能从 counter 缩小或容量减少推导帧时改善。
- 不拼接不同 build 的通过结果，超时/skip/环境不可用单列。

这些约束沿用根规则与当前执行计划，工具不会创造第二份质量合同。

## 5. 校验工具只修必要断点

### 5.1 必须修

1. **context 坏路径与重复路由**：读取现有 workstream/domain 文档角色；两份 context 共用路由函数，不保留旧设计 JS 常量。
2. **docs parser**：复用已有 yaml，检查重复 key/错误；链接按真正 Markdown 语义处理，避免空格/reference links 漏报、代码示例误报。
3. **增量检查**：全量轻索引检查唯一 ID/当前入口，正文可增量；staged 与 changed 分开，包含相应 rename/delete，changed 包含 untracked；Git 失败不能变成“0 文件通过”。
4. **生成物**：check 和 write 分开；检查不得先重新生成来掩盖漂移。marker 不能被描述为防手改校验。
5. **结果说清范围**：列实际执行项、失败、未运行与原因；--json 输出纯 JSON。--full 当前只跑 integration checks，不能声称生产 cases/性能已通过。
6. **GPU build 新鲜度**：一次 build:test 后关联源码输入与 .test-dist；oracle 检查匹配关系。无需每个 oracle 重复 build，不把新鲜度建立在目录存在或 dirty 布尔值上。

### 5.2 不做大一统重写

checks 继续现有 runner 注册；browser case 继续现有 YAML/host；GPU oracle 继续现有 CLI。只共享解析/路由和最小结果字段，不统一所有内部协议。

结果最少说明：操作与范围、通过/失败/未完成、执行时间、实际输入/build 身份、原始日志或 artifact。复用现有报告，必要时补字段；不为日常检查建设长期 receipt 数据库。

正式整体验收仍需要 browser/画质/生命周期/性能矩阵。先由当前执行计划明确要跑什么并实际调用现有 runner；仅有一个 --full 标签不能替代它。日后调度确实繁琐再补小型自动化，不先设计大系统。

### 5.3 参考库与采用边界

复用已有 [yaml parseDocument](https://eemeli.org/yaml/)；Markdown 可直接使用 [mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown) 替代手写正则，按 [CommonMark links](https://spec.commonmark.org/0.31.2/#links) 建真实 corpus。不引入文档平台或完整 unified 插件链。

Node 的机器测试统计参考 [test runner/reporters](https://nodejs.org/api/test.html#test-reporters)，不要靠人读输出正则推断测试完成。实施前核对当前 Node 支持与包 lock；本轮锁定 mdast-util-from-markdown 2.0.2（MIT，gitHead 5f537c628bba1bb419057de13205d304ad44abbd），核对包源码入口/API，并通过真实 YAML/Markdown corpus；只采用解析 API，不引入文档平台。已有 TypeScript parser 用于修复构建 URL 的格式依赖。

## 6. 轻量执行顺序

### S0：清理已确认错误

修当前入口、已退休合同说明和 platform 事实；保留有效源码/测试语义，退休无消费者分支。跑 docs checker 与 diff check，人工核对正文是否对齐实际 CLI。这些工具通过不能代替正文 review。

### S1：逐 owner 审测试和源码，再归纳文档

建议从本次当前重建核心 Surface/FrameGraph 开始，不先全仓扫未来效果。核对生产链、关键断言、正常/失败与成本覆盖；将实现总结收进现有 domain，目标缺口留在执行计划。其他 owner 逐模块推进。

单元退出：真实生产接线和有效测试都有依据，旧测试的有效语义未丢失，文档未把未实现目标写成已完成。缺必需用例如实未完成，不靠删除测试过关。

### S2：修校验工具的小模块

先 docs/context，再生成检查/输出，再 GPU build 身份。每次集中跑对应 targeted tests；先用本次真实坏例证明新 checker 能拒绝它们。不为文档清理重建全部测试平台。

单元退出：相关故障敏感测试通过，日常 context/module 仍独立于正式验收；旧重复 parser/路由可删除。

### S3：整体验收收口

Renderer/providers 完成后，按当前执行计划真正运行生产 browser matrix、质量和同条件性能比较。结果列范围及未运行项，保留原始 artifacts。工具自身完整检查放在其模块完成后，不要求每 patch 全测。

## 7. 完成标准

- 当前阅读路径没有退休命令、旧阶段和不存在的设计入口。
- 每个已实现模块有一份清楚的原理/边界/缺口总结，不重复维护“当前状态”。
- 关键测试确实能发现生产错误；伪通过与失效 fixture 被修正或退休，而非以测试数量证明质量。
- 日常检查轻量；真实 GPU/性能结论来自真实执行且有明确范围。
- 文档变更按模块收口同步；源码变化不靠更多制度阻止，而靠少量有效回归和单一维护位置减少漂移。

## 8. 本次评审发现与实施核对

原评审报告和三份重复的漂移快照已合并/删除，Git 保留旧正文。原始源码/GPU 性能审计、来源与必要历史记录保留。

| 原问题 | 实际收口 | 对应验证 |
| --- | --- | --- |
| current 入口复制旧阶段、旧命令 | root/docs 入口统一；6 个 domain 总结，退休 claims/旧计划/合同退出 current authority | docs/model、主链 producer→consumer 核对 |
| archive 文档仍为 current | 修正 21 份归档状态，另将 5 份明确退休合同/spec 标 history | archive 必须 history、历史 authority 拒绝 |
| 两套 context 与坏 JS 常量 | project-navigation 共享路由、active workstream authority、paused 分组 | CLI 两种模式一致，缺失/history authority 失败 |
| 手写 YAML/链接正则、增量漏检 | 共享真实 parser；全局 ID/入边；changed 含 untracked；staged 使用 index 内容 | duplicate key、复杂 YAML、reference/空格/转义链接、代码样例、跨文件 ID、删除、Git 失败 |
| registry 先写再检查 | check/write 分开；doctor/full/prevalidate 只读比较 | 输入保持 stale 时检查必须失败，不自动修复 |
| 重复 docs-frontmatter receipt | 删除重复声明；保留真实 docs-contract，新增 tooling-suites 调度实际回归 | runner 绑定、实际 CLI/工具用例 |
| accepted/receipt 残留拒绝真实诊断 | artifact v3 仅 diagnostic；保留 nonce/identity/errors/dispose/ownership；内容 hash 区分 dirty 输入 | validator 正常/失败/非法 fixture + 真实 browser cases |
| 测旧 .test-dist、统计靠人读文本 | fresh build 清理旧 JS；源码/产物 hash；TestsStream reporter 和纯 JSON stdout | 真实 tsc、修改输入/产物、打印假 pass 与真实失败/skip |
| GPU 宿主未协商能力、API 错误被数值失败掩盖 | registry 声明 feature/limit，创建资源前协商；GPU error 优先报告；不静默弱设备重试 | 真实 HZB、VG 与 host contract |
| 错误 kernel 因其他问题失败也被算负控制 | 先跑生产 normal-depth 正控制，再运行指定错误 kernel | 仅指定 min=1 超 source=0.5 的 assertion 作为预期拒绝 |
| VG oracle 用旧 ABI 输入 | 迁移 current ABI version/page-location codec，原数值预期保留，新增旧 ABI 拒绝 | handoff 的合法/拒绝/overflow/IDs；instance culling 原缺陷对照 |
| 构建插件把源码格式当 URL 合同 | TypeScript AST 找唯一实际 URL expression | 单行/多行、comment/string 冒充、重复/缺失 URL + 真实 build |

真实失败定位过程中未改 Renderer 算法、放宽 GPU 容差、减少生产 oracle 场景或关闭功能。首次 HZB/VG 失败分别来自宿主能力缺失与旧 fixture ABI；定位后重跑原用例，不能只凭 API errors=0 判通过。

### 8.1 覆盖范围

- 文档结构/导航和本次工具行为已收口；历史链接断链单列 warning，不改写旧证据。
- Surface/FrameGraph CPU contracts 验证调用/ABI/参考数学范围；不冒充 shader 数值或完整 renderer 画质。
- 注册的真实 GPU oracles 明确消费生产代码，并有独立数字/原缺陷对照。环境 probe 单列。
- 真实 browser protocol/webgpu component 验证诊断 producer→artifact validator；不自动晋升 claims。
- 全 Renderer 的材质/生命周期/画质/最终性能矩阵，仍按母稿和执行计划在 Renderer/providers 完成后运行，属于产品后期验收范围，不是这次工具重构的遗漏。

### 8.2 收口记录

源码/工具变化后的最终执行结果在此集中记录，不新增状态文件。机器输出保存在 ignored .local；不是新的长期证据数据库。

| 最终检查 | 实际结果与范围 |
| --- | --- |
| docs verifier / doctor / registry --check / diff check | 当前结构与导航通过；155 份文档，0 findings；34 条历史断链 warning 保留原始语境 |
| OEngine module close | typecheck、真实 build、新鲜 build:test、check-runners 通过；JSON stdout 已独立解析 |
| validation build | typecheck 与 Vite build 通过；有既有 bundle-size warning，不等于正确性失败 |
| 工具/协议/runner CPU tests | 39 通过，无 skip；包括真实 CLI/Git/index/tsc 受控失败回归 |
| Surface/FrameGraph CPU contracts | 72 通过，无 skip；ABI/调用/独立 CPU reference 范围 |
| host plumbing | 45 contract checks 通过，stub device，仅协议范围 |
| HZB 生产 GPU oracle | 16,384 half boundaries + 1,296 footprints 通过，GPU error 为零且独立数值断言通过 |
| VG 生产 GPU oracles | handoff 45 cases、instance culling 20 frames 通过；旧变换缺陷产生 8 次独立 false rejection 对照 |
| 指定错误 kernel | 生产正控制先通过；随后仅因 min=1 > source=0.5 assertion 失败，exit 1 为预期负控制 |
| 真实 browser diagnosis | protocol-self-test / webgpu-component 通过，artifact v3 的 producer→validator 连通 |

收口重新对照 §3–§7：未留下旧 current authority、双 parser/路由、自动修复生成物、假统计、旧 acceptance 或无构建身份的 GPU 入口。Renderer 全矩阵与最终性能未运行，不从以上局部结果推导它们完成。
