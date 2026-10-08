# OEngine

OEngine 是面向桌面浏览器 WebGPU、中大型高几何密度场景的 GPU-first 渲染引擎核心，目标是极致 GPU 性能与现代 AAA 画质。

当前目标是极致性能、GPU-Driven、WebGPU Native、AAA Rendering 与可持续扩展，由[V4 Native Shading 架构母稿](./docs/next-design/eengine-v4-native-shading-2026-10.md)统一。目标采纳不表示实现或性能验收完成。

## 从这里开始

- 协作和开发节奏：[AGENTS.md](AGENTS.md)。
- 全局架构：[V4 Native Shading 架构母稿](./docs/next-design/eengine-v4-native-shading-2026-10.md)。
- 模块设计/执行：读取 [workstream.authority](project/workstreams/active/eengine-next-clean-rebuild.yaml)；[原 V4 执行记录](./docs/next-execution/eengine-v4-native-shading-execution-2026-10.md)保留 M1/M2/CPU 结果与通用验证纪律。
- 当前阶段：读取 [workstream 的 currentSlice](project/workstreams/active/eengine-next-clean-rebuild.yaml)；本页不复制状态。
- 整体边界、源码现状、来源和验收：[docs/README.md](docs/README.md)。
- 路径导航：`node tools/vibe.mjs context <path>`。
- 浏览器示例：[examples/README.md](examples/README.md)。
- 引擎包约束：[OEngine/AGENTS.md](OEngine/AGENTS.md)。

旧设计和诊断保留历史身份，仅供追溯；源码与实际验证决定实现及性能结论。
