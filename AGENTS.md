# EEngine Next 协作规则

目标是极致 GPU 性能、现代 GPU-Driven、WebGPU Native、AAA 画质与可持续扩展，首要约束之一为 GTX 1650 Ti 4GB、1080p 复杂场景。唯一未来架构依据是 [V4 Native Shading 母稿](docs/next-design/eengine-v4-native-shading-2026-10.md)，唯一实施依据是 [V4 执行计划](docs/next-execution/eengine-v4-native-shading-execution-2026-10.md)。当前大模块只读 [workstream.currentSlice](project/workstreams/active/eengine-next-clean-rebuild.yaml)，详细单元状态只读执行计划；入口文件不复制状态。

源码是当前实现事实的最高依据；文档采纳不证明代码切换、性能、claim 或来源 adoption。R3/R4 的 Surface C、General VM、六 signal、全局 closure cache/history、proof/store/reference 规则已退为历史，不再约束未来生产架构。旧数值失败不被追认为修复；存活语义按 V4 执行计划迁移新 owner。

## 开发节奏

1. 用 `node tools/vibe.mjs context <path>` 查询 owner/文档入口，阅读当前源码、直接消费者和近目录约束。导航不是许可或验证门禁。
2. 按当前 architecture unit 连续完成 producer→产品→全部直接 consumer、绑定/reset/capacity、提交/中止/重试与退休。Surface V4 先在非生产环境完整构建并验证内部闭包，再于一个原子单元切换全部 production ownership 并立即删除旧依赖；不逐步迁移 production consumers。阶段内允许暂时不可运行，稳定边界仅一套 Surface 架构；Git 用于追溯，不建 A/B bridge、adapter 或 fallback VM。
3. 开发中按需要 typecheck、shader compile、build 或极小 targeted/oracle；不每 patch 跑全套、browser、benchmark、evidence、claims、clean revision 或文档门禁。阶段内可临时断链，单元结束修复真实编译失败并闭合实际产品。
4. 单元闭合后 architecture review，再集中 typecheck/build、新鲜 build:test、必要独立语义/生命周期与真实 GPU 接线/成本检查，GPU 作业串行。保存原失败、分类定位根因、局部修复并重跑受影响验证；未运行/缺项/必需失败如实未完成。
5. 单元关闭后停在下一单元边界。大模块完成后暂停，依据实际代码重新设计下一模块；不能自动跨多个大模块。正式全 Renderer browser/画质/同条件 P50/P95、evidence/claims 留最终集成；当前单元必需正确性与成本不因此后移。

详细验证和失败分类见 [执行计划](docs/next-execution/eengine-v4-native-shading-execution-2026-10.md#validation-failure-contract) 与 [VALIDATION](docs/VALIDATION.md)。旧 ABI 退休可删/迁移表示测试；material numeric、导数/LOD、normal、HDR、motion、publication atomicity、abort/retry、device loss、唯一 writer 等语义必须留给新 owner。禁止吞异常、跳必需断言、放宽容差、缩最终场景、漏工作、测试专用 production fallback；预期改变须有数学/来源依据，质量或功能范围改变按用户授权处理。

## 架构与成本纪律

- Full-rate native 是正常正确路径；Material Graph 编译为 native GPU code，不为减少 shader 数引入高成本 VM。命令可随 unique Program/ExecutionBin 增长，不与材质实例数同比增长。
- 默认 fused opaque；实际跨 pass consumer/limits/成本才支持有限 compact deferred。无 consumer 不声明产品、不分配资源，不造 Universal SurfaceRecord。
- Surface 不统一管理 effect history/cache/proof/identity；VT、VSM、SSR、GI、ReSTIR、Temporal 各有真实 owner。
- 重要机制先有 Cost Card：新增/删除 bytes、ALU、samples、random/sequential access、atomics/barriers、dispatch/pipeline、working set、ideal/expected/worst 与 0/50/100%收益和 break-even。理想条件都不赚钱则拒绝，零收益高税不得常规 hot path。
- 测试失败先分类，不恢复旧架构；性能慢先定位，不立即加 cache/proof/history；dispatch 多不立即造 megakernel；单元未闭合不陷入 patch→benchmark→改架构循环。

## 红线与来源

- 不恢复 retired renderer/effect owner；不引入本帧 GPU→CPU→GPU visible/work control，不为功能增加独立 frame submit。
- 能力/limit 在创建资源前协商；GPU producer、consumer、容量、溢出与完整写域清楚，不能截断身份或漏像素换预算。Loader 不拥有长期 GPU 资源；Renderer 只作 composition root；FrameGraph 管宏依赖、资源寿命与编码，不管 shader 内部微调度。
- 完整算法/效果实施前先查 GitHub 可核验完整开源实现，再查论文和足以复现决策、阶段、数据流的技术文章；固定 revision、license、具体文件/函数，记录在 `docs/porting/next-renderer.md`，映射输入/输出、关键分支、不变量和降级条件。WebGPU 绑定/调度适配不等于可删完整算法步骤。缺 donor 记录检索范围/缺口及具名本地方案，不宣称移植完成；复杂算法不得拆小豁免。简单确定性工具/ABI/绑定寿命胶水可标本地集成。
- 来源核对、WGSL/CPU oracle、真实新 production GPU 消费证据齐备后才提升 adoption。数字目标不是测试阈值；不能以测试通过或预算有界宣称性能改善。

## 文档、目录与提交

`docs/**` frontmatter 必须声明 `state: current/history/generated`，current 声明 `verifies.files`。改 docs 后运行 `node tools/docs-verify.mjs`；history 只供追溯，不能当 current authority。设计/执行各一份 renderer authority；不增重复 progress/status。`docs/domains/`只记录已实现事实，真实代码切换后更新；稳定 ABI/跨 owner 合同再写 `docs/specs/`、`docs/contracts/`。

`docs/next-design/`放目标，`docs/next-execution/`放单元与实施结果，`project/domains/`放路由，`project/workstreams/active/`只放当前模块导航/少量规则/延期分类；`docs/porting/`记录来源；`validation/`、`project/claims/`、`checks/`是显式验证机制，生成 registry/evidence/status 不是设计依据。无需为中间状态制造文档或伪测试。

Commit message 使用中文，标题写对象与意图，正文写动机、范围、实际验证和未运行原因；一个提交一个连贯意图。近目录 AGENTS 可补充 owner 约束，旧文档/规则不得覆盖用户授权的 V4 方向与本开发节奏。
