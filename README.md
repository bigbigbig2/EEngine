# OEngine

OEngine 是面向桌面浏览器 WebGPU、中大型高几何密度场景的 GPU-first 渲染引擎核心，目标是极致 GPU 性能与现代 AAA 画质。

当前方向按用户指定的[第三版最终重构设计](docs/next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)统一：SurfaceWork Runtime、唯一 GeometryRecord、miss-only Appearance、独立 signal packets 和廉价重建。方向已确定，实现和性能验收尚未完成。

## 从这里开始

- 协作和开发节奏：[AGENTS.md](AGENTS.md)。
- 当前设计：[Surface V3 最终性能重构设计](docs/next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)。
- 当前执行：[有界前端重构计划](docs/next-execution/surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)，[进度与基线](docs/next-execution/surface-work-v3-cost-bounded-final-refactor-progress-2026-10.md)。
- **当前阶段状态只在 [workstream](project/workstreams/active/eengine-next-clean-rebuild.yaml) 与进度文档中维护，不在本文件重复。** 本文件曾把"Phase5 实施中"写死在此，HEAD 已是 Phase 7 提交时仍在说 Phase 5；任何复制状态到入口文件的做法都会这样漂移。
- 整体边界、源码现状、来源和验收：[docs/README.md](docs/README.md)。
- 路径导航：`node tools/vibe.mjs context <path>`。
- 浏览器示例：[examples/README.md](examples/README.md)。
- 引擎包约束：[OEngine/AGENTS.md](OEngine/AGENTS.md)。

旧 Surface 设计/执行页标明历史范围，保留追溯，不作为并行实施路线。重构前代码已保存为 14c17078，性能尚未达标。
