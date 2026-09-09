# OEngine 验证合同

## 本地构建与测试

纯文档改动运行静态路径、链接、allowlist 和 provenance 检查。涉及 TypeScript/WGSL 或运行路径时再运行工程构建与命中测试：

```powershell
Set-Location OEngine
npm ci
npm test
```

## 文档门禁

- `docs/` 只包含入口、五份核心事实页、ADR 和 porting ledger。
- Markdown 相对链接必须存在。
- 权威文档不得引用 `temp/`、本机绝对路径或已删除的 owner。
- `STATUS.md` 之外不保存阶段 checkpoint、逐提交日志或“当前测试总数”。
- ADR 保持 Context、Decision、Consequences 和 Verification。
- porting ledger 保持来源、revision、license、adoption、差异、fallback 和本地验证字段。

## Rendering Lab

综合浏览器 fixture 位于 `examples/rendering-lab/`。它使用共享 Performance Inspector 作为唯一统计面板；场景控制和 debug view 仍由 Rendering Lab 提供。具体运行命令见 `examples/rendering-lab/README.md`。

运行证据必须记录 commit/dirty state、浏览器、adapter、分辨率、DPR、feature set、场景/相机输入、warm-up、采样窗口和 diagnostics。

## WebGPU 正确性

渲染功能不能只靠 typecheck。至少需要与改动匹配的 GPU counter、timestamp、readback、debug view 或数值回归；截图只用于确实需要视觉判断的项目。必须记录 validation error、uncaptured error 和 device loss。

## 性能比较

比较必须保持相同 adapter、浏览器版本、canvas/internal resolution、DPR、画质、feature set、workload、seed、camera path、warm-up、采样帧数与 cadence。报告 P50/P95、GPU phase、CPU frame/build/submit、submit 数、counter 和内存；不可用的 GPU timestamp 明确标为 unavailable，不能用 CPU 时间代替。

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

- GPU-driven：GPU producer 的输出由 GPU consumer 直接消费。
- 管线功能：正确性、fallback/lifecycle、feature-off 和性能证据齐全。
- 外部算法：来源、revision、路径、license、差异和本地验证已登记。
- 性能完成：固定条件下可复现达标，不以一次截图、单机临时报告或类名存在作为证明。

## 提交前清单

- 当前事实与源码 owner 一致，无旧阶段状态。
- 没有指向已删除文档、example、runner 或第三方镜像的本地路径。
- 文档相对链接存在，`docs/` 符合 allowlist。
- 运行过的检查及未运行原因写入交付说明。
- 工作区没有无关 lockfile、生成站点或其他副作用。
