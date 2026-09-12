# OEngine 验证合同

## 本地构建与测试

纯文档改动运行静态路径、链接、allowlist 和 provenance 检查。涉及 TypeScript/WGSL 或运行路径时再运行工程构建与命中测试：

```powershell
Set-Location OEngine
npm ci
npm test
```

ADR-0012 生效期间，`examples/` 只提供 Storybook 空壳，不提供 WebGPU runtime、Browser Case、Validation Runner 或 formal benchmark。空壳验证从 `examples/` 执行：

```powershell
yarn typecheck
yarn build
```

这两个命令只验证 Storybook 工具链，不能作为 Renderer 或 GPU 证据。

## 验证层级

验证强度分为三档；它们描述证据要求，不覆盖仓库或更近 `AGENTS.md` 的安装、构建和交付约束。

### DEV

用于普通迭代，目标是快速发现 ABI、数学和静态资源合同错误。按改动选择 typecheck、targeted unit/oracle 与 WGSL 组合检查。替代浏览器宿主落地前，DEV 无法关闭真实 WebGPU 集成、GPU validation、uncaptured error、device loss 或视觉 Gate。

DEV 不运行全量 Browser matrix 或 formal benchmark，也不产生可接受的性能基线。

### MILESTONE

用于 ADR Step 完成、production candidate 判断、consumer cutover 和旧路径删除前。MILESTONE 必须包含真实目标浏览器中的 correctness seam、GPU diagnostics、生命周期和必要视觉/数值证据。当前仓库没有能够产生这些证据的宿主，因此新渲染工作最多记录为 Implementation Complete；不得用 `npm test` 或 Storybook build 代替 MILESTONE。

### PERF

用于阶段 baseline/final、重大 keep/revise/reject 决策、正式性能声明或重大回归调查。PERF 必须 clean、固定比较条件、运行独立 run group 并持久化可复算证据。当前 formal runner 已随旧示例体系移除，在后续 ADR 恢复固定综合 workload 和浏览器宿主前，不得产生新的 PERF 结论。

正确性、画质和性能 Gate 分开判断：ABI、identity、overflow、lifecycle 与 producer/consumer 闭环不能由 FPS 改善替代；视觉算法使用数值 seam 加少量代表性视角，不默认要求与旧算法 pixel-identical；性能优化只有受控 A/B 才能声明改善。

## Browser Validation 重建边界

旧 Fixture、Case Registry、ChromeRunner、Rendering Lab 和 artifact schema 已按 ADR-0012 删除，不是新体系的兼容目标。新宿主落地时至少重新定义：独立 runtime 和 GPU owner、唯一 Case identity、结果新鲜度、Chrome/adapter provenance、console/page/request error、GPU validation/uncaptured error、device loss、截图/readback/counter、资源销毁、三态或替代失败语义，以及本机 artifact 清理策略。

在此之前：

- 不创建返回固定成功的占位 Fixture 或空 Runner。
- 不把 Storybook iframe、静态页面或 CPU-only test 标成 Browser Validation。
- 不更新冻结 benchmark 来暗示当前 revision 已运行。
- 需要真实 GPU 证据的 Gate 保持 open，并在交付说明中列为未运行。

## WebGPU 2026 capability 门禁

- 未来每个真实浏览器 artifact 必须记录 `core-features-and-limits`、adapter/device feature 集、requested limits、实际 device limits、WGSL language features、Immediate Data/Transient Attachment API 探测和最终 specialization。
- 使用 `subgroups`、`primitive-index`、`shader-f16` 或 format tier 的改动，必须覆盖对应 WGSL enable、缺失能力 specialization、边界输入和同一 CPU/oracle 语义；subgroup 测试覆盖 partial workgroup 和 adapter 报告的 size 范围。
- Immediate Data 验证 `maxImmediateSize`、4-byte slot/range、pipeline layout 与未初始化 slot；Transient Attachment 验证 pass-local lifetime、usage、dimension/mip/layer、clear/discard、禁止 resolve/cross-pass consumer，并报告 transient bytes/traffic 变化。
- 正式性能结论只运行目标 adapter 实际选择的一个综合 profile，不为 WebGPU 2026 Desktop 与 Portable 复制双基准。capability/fallback 变更运行命中的正确性与 parity case；综合 benchmark 把完整 capability fingerprint 固定为比较条件。
- `texture-compression-unaligned` 等规范已出现但本地类型/浏览器尚未稳定暴露的能力，必须先升级工具链并通过 typecheck、CTS/validation 和目标浏览器 probe，不能靠字符串断言“已支持”。

## 文档门禁

- `docs/` 只包含入口、六份核心事实页、ADR、porting ledger 和非权威研究输入 `others/`。
- 公共验证政策只进入本文件；领域不变量和完成条件进入对应 ADR；当前 Gate 状态只进入 `STATUS.md`。
- 新示例库落地后，Case id、domain、changed-path 映射和 profile 名称必须由单一机器可读 owner 管理；当前不存在该 owner。
- 顶层 `docs/` 不保存独立验证计划、阶段总矩阵或逐 Step 执行手册；完成融合的设计输入由 Git 历史保留。
- Markdown 相对链接必须存在。
- 权威文档不得引用 `temp/`、本机绝对路径或已删除的 owner。
- `STATUS.md` 之外不保存阶段 checkpoint、逐提交日志或“当前测试总数”。
- ADR 保持 Context、Decision、Consequences 和 Verification。
- porting ledger 保持来源、revision、license、adoption、差异、fallback 和本地验证字段。

## 综合性能宿主

当前没有综合浏览器 fixture 或 formal runner。下一代宿主必须使用唯一综合 workload，并把场景、相机、分辨率、DPR、画质、feature set、warm-up、采样窗口和 cadence 冻结为机器可读输入；正式结果仍要求 clean commit、多个独立 run、截图/provenance、GPU diagnostics 和 BenchmarkEvidenceGate。短 smoke 只能用于编排，不构成正式证据。

## WebGPU 正确性

渲染功能不能只靠 typecheck。至少需要与改动匹配的 GPU counter、timestamp、readback、debug view 或数值回归；截图只用于确实需要视觉判断的项目。必须记录 validation error、uncaptured error 和 device loss。

## 性能比较

比较必须保持相同 adapter、浏览器版本、canvas/internal resolution、DPR、画质、feature set、workload、seed、camera path、warm-up、采样帧数与 cadence。报告 P50/P95、GPU phase、CPU frame/build/submit、submit 数、counter 和内存；不可用的 GPU timestamp 明确标为 unavailable，不能用 CPU 时间代替。

Temporal/DRS 的正式 A/B 必须使用 `resolution.mode=fixed` 并记录固定 `internalScale`；adaptive 只做有界 bucket、迟到 timestamp、hysteresis/lockout、scale-change history reset 与无 timestamp 保持当前 scale 的 smoke，不得把 adaptive 降分辨率后的帧时间当成算法回归已消失。Temporal visual review 至少覆盖 static subpixel detail、运动边缘、MASK/foliage、MBOIT transparency、SSR correction、camera cut、output resize 与 internal bucket change；证据同时报告 history read-valid、generation、reactive/disoccluded/rejected pixel counter 和 output/internal extent。

Post fusion必须用FrameGraph资源/Pass evidence证明normal topology恰有一个Final Output、没有`Bloom composited`/`Color graded color`/`Sharpened color` full-resolution intermediate，并分别检查Bloom-off binding裁剪、Sharpen-off邻域读取裁剪、Automatic Exposure on/off、SDR/HDR output format与one-main-submit。所有FrameGraph资源存在/缺席断言必须过滤到`firstUsePass !== undefined`的live resource，不能把已声明但零use/culled的节点当成实际分配或消费者闭环。`FrameResourceSummary.imported/transient/transientTextures/transientBuffers`只保留为declared topology计数；实际资源门禁必须读取`liveImported/liveTransient/liveTransientTextures/liveTransientBuffers`。`post-color-grading` capture允许仅在请求帧materialize精确HDR boundary并产生既有有界readback；下一帧必须恢复fusion。Debug view必须选择不重复Bloom/grading/sharpen的Final Output variant，并证明无消费者的Bloom pass/resource被裁剪、consumer count与live graph一致。性能结论比较相同画质下实际HDR traffic与post GPU phase，不能只用Pass数量推断收益。

Final cutover/deletion 验证必须同时包含三类证据：源树/公开符号不存在退役backend、已编译FrameGraph/shader audit没有旧producer、真实Chrome topology/counter证明replacement consumer闭环与feature-off。GPU counter schema删除字段时必须升版；若保留空洞避免重排live WGSL offset，必须oracle明确冻结reserved index。任何尚未通过对应MILESTONE/PERF/visual Gate的旧数学或对照source必须保留并列为deletion target，不得为了“代码干净”提前删除。

产品目标是 1920×1080、DPR 1、60 FPS（16.667 ms GPU），在固定证据完整前一律标记未证明。

## 证据持久化

- `temp/` 只用于本机探索，随时可以删除，不能被权威文档引用为事实源。
- 被接受的基线必须来自 clean commit，并保存机器可读 schema、workload identity、adapter/browser provenance、内容 hash 和 gate 结果。
- 小型、稳定、可复算的基线进入 `OEngine/benchmarks/`；大型截图、trace 和逐帧 raw capture 放在外部 artifact 存储，并由稳定标识和内容 hash 引用。
- Narrative 文档只总结已接受结论，不复制长篇单机运行日志。

## 显存与 I/O

当前预算上限：resident 512 MiB、transient 256 MiB、history 128 MiB、shadow atlas 128 MiB、upload 8 MiB/frame、readback 256 KiB/frame。预算必须按 owner 分类，禁止重复计数或遗漏长期资源。

## Feature-off

关闭能力时检查：无对应 Pass、资源分配、history、readback、counter copy、独立 submit；CPU 构建成本和 GPU phase 应接近零。仅设置 uniform 分支但仍执行全屏 Pass 不算关闭。

## 完成语义

- Implementation Complete：代码存在且类型/单元验证通过；不代表 production cutover。
- Runtime Validated：命中的 MILESTONE 浏览器正确性、错误和生命周期 Gate 通过。
- Performance Evaluated：至少有条件完整且可解释的短 profile；不等于性能改善。
- Performance Improved：只有受控 A/B 或 formal evidence 支持具体声明时使用。
- GPU-driven Complete：GPU producer 的输出由 GPU consumer 直接消费，容量、overflow 和计数闭合。
- Pipeline Feature Complete：正确性、fallback/lifecycle、feature-off 和所需性能证据齐全。
- External Algorithm Complete：来源、revision、路径、license、差异和本地验证已登记。
- ADR Complete：production 已 cutover，要求的 MILESTONE 与最终 PERF 已通过，被替换旧路径已删除，当前事实文档和 porting provenance 已同步，且没有未解决的 correctness-critical overflow。

## 测试治理

- 新增测试前先判断现有 unit/oracle 能否覆盖；需要 GPU runtime、浏览器生命周期或视觉证据时，将缺口登记到后续示例库/验证宿主设计，不得用假的 Browser Case 填补。
- 一个 ADR Step 默认新增 0–1 个 Browser Scenario；超过一个必须说明彼此独立的 seam。
- 新 GPU Queue 通常由一个 CPU/GPU oracle 加一个集成 Browser Case 覆盖；不为每个 counter 单独建测试。
- 视觉效果使用稳定数值 seam 加少量代表性 camera，不扩张大规模 snapshot matrix。
- 性能阈值不进入普通 unit test，避免环境波动制造随机失败。

## 提交前清单

- 当前事实与源码 owner 一致，无旧阶段状态。
- 没有指向已删除文档、example、runner 或第三方镜像的本地路径。
- 文档相对链接存在，`docs/` 符合 allowlist。
- 运行过的检查及未运行原因写入交付说明。
- 工作区没有无关 lockfile、生成站点或其他副作用。
