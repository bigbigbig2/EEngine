# EEngine Next 协作规则

用户2026-10-16的持续协作要求：只使用本仓库 `.agents/skills/` 内的 skill，不调用仓库外 skill；不使用子 agent。参考资料和工具不等同于 skill，仍按下文来源与验证要求使用。

目标是极致 GPU 性能、现代 GPU-Driven、WebGPU Native、AAA 画质与可持续扩展，低内存设备按实际工作集与能力分档；按用户2026-10-17要求，不承诺 GTX 1650 Ti 4GB 能运行复杂大场景或全效果。全局架构不变量依据 [V4 Native Shading 母稿](docs/next-design/eengine-v4-native-shading-2026-10.md)；当前模块唯一设计/执行依据读取 [workstream.authority](project/workstreams/active/eengine-next-clean-rebuild.yaml)，Texture Compression 分别使用 [Texture 设计](docs/next-design/eengine-v4-texture-compression-2026-10.md)与 [Texture 执行计划](docs/next-execution/eengine-v4-texture-compression-execution-2026-10.md)。当前大模块只读 workstream.currentSlice，详细单元状态只读对应执行计划；入口文件不复制状态。

源码是当前实现事实的最高依据；文档采纳不证明代码切换、性能、claim 或来源 adoption。R3/R4 的 Surface C、General VM、六 signal、全局 closure cache/history、proof/store/reference 规则已退为历史，不再约束未来生产架构。旧数值失败不被追认为修复；存活语义按当前模块执行计划迁移新 owner。

当前按用户2026-10-14的方向先完善功能效果，再对完整组合集中优化性能。workstream.roadmap 保留总体粗设计/粗执行入口，workstream.authority 只导航当前模块唯一设计/执行一对；粗计划不预建未来模块详案。用户启动一个模块后，依据当时源码细设计，再按该轮授权实施并闭合，结束停在下一模块边界。V5 已完成实现保留，未完成的正式性能资格延期，不作为 AO、VT 等新功能的统一启动前置。每个模块仍需完成真实正确性、能力/容量、生命周期与必要成本检查；新增效果允许增加有界的必要工作，不因缺少相对“关闭效果”的净提速而拒绝功能开发。

## 开发节奏

1. 用 `node tools/vibe.mjs context <path>` 查询 owner/文档入口，阅读当前源码、直接消费者和近目录约束。导航不是许可或验证门禁。
2. 按当前 architecture unit 连续完成 producer→产品→全部直接 consumer、绑定/reset/capacity、提交/中止/重试与退休。替换已有架构时先完整构建并验证新闭包，再于一个原子单元切换全部 production ownership 并立即删除旧依赖；不逐步迁移 production consumers。阶段内允许暂时不可运行，稳定边界仅一套生产 ownership；Git 用于追溯，不建 A/B bridge、adapter 或 fallback VM。
3. 开发中按需要 typecheck、shader compile、build 或极小 targeted/oracle；不每 patch 跑全套、browser、benchmark、evidence、claims、clean revision 或文档门禁。阶段内可临时断链，单元结束修复真实编译失败并闭合实际产品。按用户2026-10-17再次确认，优先连续实现新架构；不按宽泛文件名扫整类测试，不为无关测试修复、旧ABI兼容或完整Renderer宿主反复中断当前开发。
4. 单元实现完成后做 architecture review，并集中进行与改动直接相关的编译及少量独立语义/生命周期检查；GPU算法按需用最小真实GPU输入→输出验证，GPU作业串行。既有未受影响结果不反复重跑。实际模块基本连通后，再集中做新鲜build:test、完整接线/画面、组合生命周期、资源上界与粗粒度成本检查；不要求每个前置单元先通过完整Renderer宿主。功能模块不要求先通过整 Renderer FPS/净收益验收。保存原失败、分类定位根因、局部修复并重跑受影响验证；尚未运行的集成验证明确归属后续集成阶段，不冒称通过。
5. 单元关闭后停在下一单元边界；用户已连续授权的后续单元按该授权推进。大模块完成后暂停，依据实际代码重新设计下一模块；不能自动跨多个大模块。正式全 Renderer browser/画质/同条件 P50/P95、evidence/claims 留最终集成；已发现的实现错误、漏工作和失控容量不得当作“只欠集成测试”延期。禁止为了运行旧测试把新旧production owner混接、恢复退休实现或增加临时兼容桥；退休表示测试删除/迁移，必要语义由新owner直接验证。

详细验证和失败分类见 [VALIDATION](docs/VALIDATION.md#validation-failure-contract)。旧 ABI 退休可删/迁移表示测试；material numeric、导数/LOD、normal、HDR、motion、publication atomicity、abort/retry、device loss、唯一 writer 等语义必须留给新 owner。禁止吞异常、跳必需断言、放宽容差、缩最终场景、漏工作、测试专用 production fallback；预期改变须有数学/来源依据，质量或功能范围改变按用户授权处理。

## 架构与成本纪律

- Full-rate native 是正常正确路径；Material Graph 编译为 native GPU code，不为减少 shader 数引入高成本 VM。命令可随 unique Program/ExecutionBin 增长，不与材质实例数同比增长。
- 默认 fused opaque；实际跨 pass consumer/limits/成本才支持有限 compact deferred。无 consumer 不声明产品、不分配资源，不造 Universal SurfaceRecord。
- Surface 不统一管理 effect history/cache/proof/identity；VT、VSM、SSR、GI、ReSTIR、Temporal 各有真实 owner。
- 重要机制先有 Cost Card：新增/删除 bytes、ALU、samples、random/sequential access、atomics/barriers、dispatch/pipeline、working set 与 ideal/expected/worst。新增功能记录达到画面/能力目标所需的 ADD、上界与取舍，不要求比未开启功能更快。为节省工作引入的优化候选另算0/50/100%收益和 break-even；理想条件都不赚钱则拒绝该优化，零收益高税不得常规 hot path。
- 测试失败先分类，不恢复旧架构；性能慢先定位，不立即加 cache/proof/history；dispatch 多不立即造 megakernel；单元未闭合不陷入 patch→benchmark→改架构循环。

## 红线与来源

- 不恢复 retired renderer/effect owner；不引入本帧 GPU→CPU→GPU visible/work control，不为功能增加独立 frame submit。
- 能力/limit 在创建资源前协商；GPU producer、consumer、容量、溢出与完整写域清楚，不能截断身份或漏像素换预算。Loader 不拥有长期 GPU 资源；Renderer 只作 composition root；FrameGraph 管宏依赖、资源寿命与编码，不管 shader 内部微调度。
- **成熟算法能复用就复用、能移植就优先忠实移植，不先自行重写。** 按用户2026-10-20追加要求，复杂、高风险、性能敏感或易踩硬件执行坑的模块，先搜索并研究成熟实现；存在许可证允许、质量/能力匹配且可适配WebGPU的实现时，优先固定版本直接依赖或移植其算法内核，以减少工作量和正确性风险，不以个人偏好、熟悉程度或“更容易接线”为由另写近似替代。不要求引入上游整个框架。仅当许可、平台、语义或有依据的成本约束确实阻止复用时，记录具体缺口、候选否决原因及本地方案；涉及质量/能力变化先获用户确认。简单、局部、低风险的glue、数据转换、小helper、资源绑定与普通工程代码可直接实现；不通过拆小任务回避复杂算法整体研究。
- **移植与参考实现不得暗中简化算法。** 选定profile的必要阶段、关键分支/接受拒绝条件、数值与精度、数据依赖、边界、历史更新/失效、缺页/溢出和生命周期语义必须保留；仅参考后独立表达也遵守此要求，不以“只是参考”绕过。语言、布局、绑定、dispatch和调度可适配，不能以减少工作量、提高性能或平台不同为由省步骤、降质量后仍称同一算法。确需改变算法/profile时先说明差异、影响与依据，按授权修订设计；无法保留核心语义则报告缺口，不以简化版冒称完成。
- **每个已启动模块明确复用/移植点。** 在该模块设计/执行及既有来源账本记录固定revision、license、源文件/函数/阶段→本地owner/产物/consumer、保留步骤、适配差异和未覆盖项；区分直接复用、忠实移植、参考实现与本地集成。按完整算法闭包核对并验证，不用论文名或项目名代替真实映射，不为尚未启动的未来模块预建详案，也不新建重型流程。
- 研究真实源码 hot path、数据流、GPU work、布局、平台假设、性能边界和失败经验；吸收算法与物理执行方式，不照搬 C++ 框架、D3D12/Vulkan 封装或不适合 WebGPU 的 bindless/ExecuteIndirect/wave 假设。无合适参考或平台差异要求时自主设计，简述依据即可；可在既有实施记录或 `docs/porting/next-renderer.md` 留很短的 Local / Reference / Adopt / Adapt / Original Source Map，不新建重型流程。实际引用或移植的来源记录 revision、license、具体文件/函数及本地映射；平台适配不能无依据删掉算法必要步骤。
- 开源参考不自动证明在 EEngine/WebGPU 上更快；最终 hot path 仍需本项目 Cost Card 与真实 GPU 验证。涉及来源 adoption 的声明，须在来源核对、WGSL/CPU oracle、真实新 production GPU 消费证据齐备后才提升；自主实现不伪称移植。数字目标不是测试阈值；不能以测试通过或预算有界宣称性能改善。

## 文档、目录与提交

`docs/**` frontmatter 必须声明 `state: current/history/generated`，current 声明 `verifies.files`。改 docs 后运行 `node tools/docs-verify.mjs`；history 只供追溯，不能当 current authority。设计/执行各一份 renderer authority；不增重复 progress/status。`docs/domains/`只记录已实现事实，真实代码切换后更新；稳定 ABI/跨 owner 合同再写 `docs/specs/`、`docs/contracts/`。

`docs/next-design/`放目标，`docs/next-execution/`放单元与实施结果，`project/domains/`放路由，`project/workstreams/active/`只放当前模块导航/少量规则/延期分类；`docs/porting/`记录来源；`validation/`、`project/claims/`、`checks/`是显式验证机制，生成 registry/evidence/status 不是设计依据。无需为中间状态制造文档或伪测试。

Commit message 使用中文，标题写对象与意图，正文写动机、范围、实际验证和未运行原因；一个提交一个连贯意图。近目录 AGENTS 可补充 owner 约束，旧文档/规则不得覆盖用户授权的 V4 方向与本开发节奏。
