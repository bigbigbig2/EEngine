# OEngine

OEngine 是面向桌面浏览器 WebGPU、中大型高几何密度场景的 GPU-first 渲染引擎核心，目标是极致 GPU 性能与现代 AAA 画质。

当前方向按用户指定的[第三版最终重构设计](docs/next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)统一：SurfaceWork Runtime、唯一 GeometryRecord、miss-only Appearance、独立 signal packets 和廉价重建。方向已确定，实现和性能验收尚未完成。

## 从这里开始

- 协作和开发节奏：[AGENTS.md](AGENTS.md)。
- 当前设计：[Surface V3 最终性能重构设计](docs/next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)。
- 当前执行：[有界前端重构计划](docs/next-execution/surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)，[进度与基线](docs/next-execution/surface-work-v3-cost-bounded-final-refactor-progress-2026-10.md)；Phase5实施中、未收口。按[复审决定](docs/next-execution/surface-work-v3-cost-bounded-refactor-review-and-readiness-2026-10.md)先修Phase5并完成合同，再执行必需Phase5.5物理布局/成本补齐，之后Phase6/7；历史阶段检查不代表前置要求全部落实。
- 整体边界、源码现状、来源和验收：[docs/README.md](docs/README.md)。
- 路径导航：`node tools/vibe.mjs context <path>`。
- 浏览器示例：[examples/README.md](examples/README.md)。
- 引擎包约束：[OEngine/AGENTS.md](OEngine/AGENTS.md)。

旧 Surface 设计/执行页标明历史范围，保留追溯，不作为并行实施路线。重构前代码已保存为 14c17078，性能尚未达标。
