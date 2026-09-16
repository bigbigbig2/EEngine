# OEngine 验证合同

验证证明当前 revision 的明确声明。静态结构、类名、Pass 数量、旧 benchmark 或研究文档都不能替代运行证据。

## 等级

| 等级 | 用途 | 最低要求 |
| --- | --- | --- |
| DEV | 普通迭代 | typecheck、命中 unit/oracle、格式/ABI golden、WGSL 组合检查 |
| MILESTONE | consumer cutover、删除旧路径、垂直切片完成 | DEV + ADR-0014 真实浏览器 case + GPU diagnostics + 生命周期/feature-off + 必要截图或数值 readback |
| PERF | 性能判断或发布声明 | MILESTONE + clean revision + 固定 workload/capability + 多个独立 run + 持久化机器可读 evidence |

验证等级按风险和声明触发，不按每次提交或每个小步骤强制升级。默认先运行能证明当前改动的最低等级：

- 普通 ABI、validator、CPU 状态机、shader 组合和局部 owner 改动运行 DEV；不要求同时启动完整浏览器宿主。
- 只有改动会跨越真实 GPU producer/consumer、render graph、资源生命周期、feature-off 或 device capability 边界时，才补命中的 Browser Case 或短 smoke。短 smoke 是开发诊断，不自动升级为 MILESTONE。
- 只有准备声明 consumer cutover、垂直 Slice 完成、Runtime Validated、Pipeline Feature Complete 或 ADR Complete 时，才运行对应 MILESTONE。MILESTONE 可以在一组相关改动完成后集中运行，不要求每个中间提交都通过。
- 只有准备作性能判断、性能回归结论或发布性能数字时，才运行 PERF。性能工作之外不要求重复 PERF。
- 延后运行高等级验证是允许的，但交付说明、状态记录或变更说明必须列出未运行项目、原因和当前不能作出的声明。

纯文档改动只运行静态文档检查。dependency/lockfile 未变化时普通 DEV 不运行 `npm ci`；TypeScript/WGSL 变更运行 `cd OEngine; npm run typecheck` 和命中测试。clean reproduction、CI 或正式 PERF 才运行 `npm ci`。

## 浏览器与 evidence

需要真实浏览器证据时，只能由 [ADR-0014](./adr/0014-browser-validation-and-performance-host.md) 的独立 `validation/` 宿主承担；`examples/` 和 Storybook 只用于示例。ADR-0014 定义证据格式和生命周期，不要求每次开发改动都启动宿主。artifact 至少记录 revision、case/workload identity、内容 hash、浏览器、adapter/device、capability fingerprint、分辨率/DPR、画质、warm-up、采样窗口、console/GPU error 和结果新鲜度。

小型稳定基线可进入 `OEngine/benchmarks/`；大型截图、trace 和逐帧 capture 使用外部 artifact 存储并由稳定标识与 hash 引用。`temp/` 只用于本地探索，不是事实源。

## 正确性门禁

- 新二进制或 GPU ABI：边界值、非法输入、endianness/stride/offset、hash/checksum、CPU/GPU oracle 或 golden。
- 新 GPU 队列：容量、overflow、counter、producer -> consumer、零工作和 feature-off。
- 资源生命周期：replace、resize、toggle、camera cut、aborted submit、异步取消、device loss/recovery。
- Renderer cutover：被替换 source/public symbol 不存在；compiled graph/shader 无旧 producer；真实浏览器 topology/counter 证明 replacement consumer 闭环。
- 视觉算法：稳定数值 seam 加少量代表性视角；截图只用于确实需要视觉判断的项目。

## 性能采样

正式比较必须固定 adapter、浏览器、canvas/internal resolution、DPR、画质、feature set、workload、seed、camera path、warm-up、采样帧与 cadence。报告绝对 GPU P50/P95、关键 phase、CPU build/submit、submit 数、counter 和按 owner 内存；GPU timestamp 不可用时标记 unavailable，不能用 CPU 时间冒充。

产品目标是 1920x1080、DPR 1、60 FPS（16.667 ms GPU），在固定条件证据完成前统一标记未证明。相对性能改善必须有同条件 A/B；仅做当前能力验收时可以只报告绝对结果，但不得声称“改善”。

当前预算上限：resident 512 MiB、transient 256 MiB、history 128 MiB、shadow atlas 128 MiB、upload 8 MiB/frame、readback 256 KiB/frame。按 owner 统计，不重复计数。

## Feature-off

关闭功能时应无对应 live Pass、资源分配、history、readback、counter copy 或独立 submit，CPU 构建和 GPU phase 成本接近零。只设置 uniform 分支但仍执行完整 Pass 不算关闭。

## 完成术语

- **Implementation Complete**：代码存在且 DEV 通过；不表示 production cutover。
- **Runtime Validated**：命中的 MILESTONE case 通过。
- **Performance Evaluated**：有条件完整、可解释的性能 profile。
- **Performance Improved**：同条件证据支持具体相对改善。
- **GPU-driven Complete**：GPU producer 的有效输出由 GPU consumer 直接消费，容量/overflow/counter 闭合。
- **Pipeline Feature Complete**：正确性、fallback/lifecycle、feature-off 和所需性能证据齐全。
- **External Algorithm Complete**：来源、revision、license、差异和本地验证已登记。
- **ADR Complete**：production cutover、要求的 MILESTONE/PERF、旧路径删除和事实文档同步全部完成。

交付说明必须列出已运行验证、未运行验证及原因。
