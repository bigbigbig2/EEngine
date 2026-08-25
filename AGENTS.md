# OEngine 仓库协作约束

## 项目定位

OEngine 是面向 WebGPU 的 GPU-first 游戏引擎核心。当前优先建设资产编译、数据导向运行时世界、GPU Render World、层次几何工作生成、软硬件混合 Visibility、材质解析、光照与时域渲染管线。

当前阶段不以兼容 three.js 生态为目标。`three.js/` 与 `webgpufundamentals/` 是本地参考，不是 OEngine 运行时依赖或代码所有权来源。

## 开始任务前

1. 完整阅读 `CONTEXT-MAP.md`。
2. 阅读任务命中的 `docs/contexts/*/CONTEXT.md`。
3. 修改 `OEngine/` 时阅读 `OEngine/AGENTS.md`，并继续读取更近的 `AGENTS.md`。
4. 架构变更先检查 `docs/wiki/adr/`；性能判断先检查 `docs/PERFORMANCE.md`。

## 全局强制约束

- WebGPU 是当前能力基线；不得把 64 位原子、multi-draw-indirect、mesh/task shader 或 buffer device address 当作默认能力。
- GPU-driven 必须形成 GPU producer → GPU consumer 闭环。只生成 Buffer、但最终仍由 CPU 遍历原列表，不算完成。
- 新增 GPU 队列必须定义元素 ABI、容量、溢出行为、生产者、消费者和统计计数。
- Runtime Asset 与 GPU Residency 必须分离；Loader 临时对象不得成为长期 GPU 资源 owner。
- Application World 与 GPU Render World 通过显式 Change Set/Extract 同步；Renderer 不得全量扫描对象猜测变化。
- 一条统一主管线承载渲染功能；功能可按配置和依赖启停，但不得设计 Core/Quality/Experimental 等三档独立管线。
- Feature 关闭时必须接近零成本，不得保留无消费者 Pass、资源分配、readback 或独立 submit。
- 不以 Pass 数量、Shader 数量或“已存在类名”证明能力完成；必须有运行证据、计数器和 benchmark。
- 当前 reconstructed 实现不是不可推翻的权威。性能证据可以要求删除或重写现有 Visibility、HZB、Material Expand 和帧提交路径。
- 具体算法、GPU 数据结构和 Shader 实现应先检查 `docs/references/GPU-DRIVEN.md` 已登记的开源项目；存在许可证兼容且经过验证的实现时，优先做可追溯移植，不凭空重写同一算法。移植必须记录上游仓库、commit/tag、源码路径、许可证、保留的不变量和为 WebGPU/OEngine 做出的差异。

## 代码与生成物

- `OEngine/src/index.ts` 是公开 interface；内部 GPU、Pass、Shader 类型默认不向外泄漏。
- `three.js/build` 和 `three.js/docs` 是生成物；普通任务不得修改。
- `*.generated.ts` 和 oracle Shader 不是设计权威；变更时必须确认真实运行路径和生成来源。
- 重构默认直接迁移调用方并删除死代码，不保留无需求的兼容层。

## 验证

- 类型与构建：`cd OEngine; npm ci; npm run build`。
- 性能改动必须使用 `docs/PERFORMANCE.md` 的固定 benchmark、相同分辨率/DPR/画质和 warm-up 规则。
- 渲染正确性不能只靠 typecheck；需要 GPU timestamp、计数器、debug view 或截图/数值回归。
- 可运行的垂直验证逐步放在根目录 `examples/`，通过相对路径引用 `OEngine` 源码。渲染改动至少运行一个命中的浏览器示例；必要时保存结果并检查截图和控制台，不能只跑 TypeScript 单元测试。
- 默认采用与风险匹配的中等验证：本地检查、构建/测试和命中示例。除非用户明确要求或变更风险确实需要，不为普通验证扩散多个 review 子任务。
- 最终说明必须列出已运行验证、未运行验证和原因。

## 文档权威顺序

1. `AGENTS.md` 与更近的局部 `AGENTS.md`：协作和所有权约束。
2. `docs/wiki/adr/`：已接受的长期决策。
3. `docs/DIRECTION.md`：产品方向与非目标。
4. `docs/ARCHITECTURE.md`、`docs/RENDER-PIPELINE.md`：目标架构。
5. `docs/CURRENT-STATE.md`：当前实现事实与已知缺陷。
6. `docs/references/`、`three.js/`：外部证据，不自动决定本项目设计。
