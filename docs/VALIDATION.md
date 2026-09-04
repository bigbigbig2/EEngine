# OEngine 验证合同

## 本地构建与测试

文档改动使用静态路径、链接和 allowlist 检查。涉及 TypeScript/WGSL 或运行路径时才运行工程构建与命中测试：

```powershell
Set-Location OEngine
npm ci
npm test
```

## Rendering Lab

唯一浏览器 fixture 位于 `examples/rendering-lab/`：

```powershell
Set-Location examples
yarn install
yarn storybook
yarn build
yarn build:storybook
```

运行证据应记录 commit/dirty state、浏览器、adapter、分辨率、DPR、feature set、场景/相机输入和控制台 diagnostics。

## WebGPU 正确性

渲染功能不能只靠 typecheck。至少需要与改动匹配的 GPU counter、timestamp、readback、debug view 或数值回归；截图仅用于确实需要视觉判断的项目。必须记录 validation error、uncaptured error 和 device loss。

## 性能比较

比较必须保持相同 adapter、浏览器版本、canvas/internal resolution、DPR、画质、feature set、workload、seed、camera path、warm-up、采样帧数与采样 cadence。报告 P50/P95、GPU phase、CPU frame/build/submit、submit 数、counter 和显存；不可用的 GPU timestamp 明确标为 unavailable，不能用 CPU 时间代替。

产品目标是 1920×1080、DPR 1、60 FPS（16.667 ms GPU），在固定证据完整前一律标记未证明。

## 显存与 I/O

当前预算上限：resident 512 MiB、transient 256 MiB、history 128 MiB、shadow atlas 128 MiB、upload 8 MiB/frame、readback 256 KiB/frame。预算必须按 owner 分类，禁止重复计数或遗漏长期资源。

## Feature-off

关闭能力时检查：无对应 Pass、资源分配、history、readback、counter copy、独立 submit；CPU 构建成本和 GPU phase 应接近零。仅设置 uniform 分支但仍执行全屏 Pass 不算关闭。

## 完成语义

- GPU-driven：GPU producer 的输出由 GPU consumer 直接消费。
- 管线功能：正确性、fallback/lifecycle、feature-off 和性能证据齐全。
- 外部算法：来源、revision、路径、license、差异和本地验证已登记。
- 性能完成：固定条件下可复现达标，不以一次截图或类名存在作为证明。

## 提交前清单

- 当前事实与源码 owner 一致，无旧阶段状态。
- 没有指向已删除文档、example、runner 或第三方镜像的本地路径。
- 文档相对链接存在，`docs/` 只含 allowlist 文件。
- 运行过的检查及未运行原因写入交付说明。
- 工作区没有 lockfile、生成站点或其他无关副作用。
