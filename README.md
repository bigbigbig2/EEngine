# OEngine

OEngine 是面向桌面浏览器 WebGPU、中大型高几何密度场景的 GPU-first 渲染引擎核心，目标是极致 GPU 性能与现代 AAA 画质。

当前方向按用户指定的[第三版最终重构设计](docs/next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)统一：SurfaceWork Runtime、唯一 GeometryRecord、miss-only Appearance、独立 signal packets 和廉价重建。方向已确定，实现和性能验收尚未完成。

## 从这里开始

- 协作和开发节奏：[AGENTS.md](AGENTS.md)。
- 当前重构：[SurfaceWork V3 执行计划](docs/next-execution/surface-work-runtime-v3-rebuild-2026.md)。
- 整体边界、源码现状、来源和验收：[docs/README.md](docs/README.md)。
- 路径导航：`node tools/vibe.mjs context <path>`。
- 浏览器示例：[examples/README.md](examples/README.md)。
- 引擎包约束：[OEngine/AGENTS.md](OEngine/AGENTS.md)。

旧 Surface 设计和执行记录使用 Git 历史追溯，不在活动文档树保留并行路线。
