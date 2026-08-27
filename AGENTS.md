# OEngine 仓库协作约束

## 项目定位

OEngine 当前阶段是面向桌面 WebGPU、中大型高几何密度场景的 GPU-first 渲染引擎核心。当前优先建设 GPU-ready 资产、紧凑 GPU 表与 Packed Instances、层次工作生成、Hardware-first Visibility、单次材质解析、光照与时域渲染管线；不以超大世界或完整 Gameplay 引擎为前提。

当前阶段不以兼容 three.js 生态为目标。`three.js/` 与 `webgpufundamentals/` 是本地参考，不是 OEngine 运行时依赖或代码所有权来源。

three.js 的两个 compute rasterizer 示例只是 OEngine 必须达到的最低垂直功能与性能基线，不是产品范围、架构方向或完成上限。通过该基线只能证明 GPU LOD、工作生成、SW/HW Visibility 和 PBR/IBL 基础闭环不落后；OEngine 还必须由多资产、Packed Instances、hierarchy/SSE、单次 Material Resolve、动态灯光、CSM、Temporal/Upscaling、内存和 feature-off 门禁证明。

## 开始任务前

1. 完整阅读 `CONTEXT-MAP.md`。
2. 阅读任务命中的 `docs/contexts/*/CONTEXT.md`。
3. 修改 `OEngine/` 时阅读 `OEngine/AGENTS.md`，并继续读取更近的 `AGENTS.md`。
4. 架构变更先检查 `docs/wiki/adr/`；范围判断读取 `docs/TARGETS.md`；性能判断先检查 `docs/PERFORMANCE.md`。

## 全局强制约束

- WebGPU 是当前能力基线；不得把 64 位原子、multi-draw-indirect、mesh/task shader 或 buffer device address 当作默认能力。
- GPU-driven 必须形成 GPU producer → GPU consumer 闭环。只生成 Buffer、但最终仍由 CPU 遍历原列表，不算完成。
- 新增 GPU 队列必须定义元素 ABI、容量、溢出行为、生产者、消费者和统计计数。
- Runtime Asset 与 GPU 资源表必须分离；Loader 临时对象不得成为长期 GPU 资源 owner。
- 当前优先 bulk/mostly-static GPU Scene 和显式 transform/material patch；Renderer 不得全量扫描对象构建最终可见列表，也不得为当前阶段扩张完整 ECS/Gameplay 生命周期。
- 一条统一主管线承载渲染功能；功能可按配置和依赖启停，但不得设计 Core/Quality/Experimental 等三档独立管线。
- Feature 关闭时必须接近零成本，不得保留无消费者 Pass、资源分配、readback 或独立 submit。
- 不以 Pass 数量、Shader 数量或“已存在类名”证明能力完成；必须有运行证据、计数器和 benchmark。
- 当前 reconstructed 实现不是不可推翻的权威。性能证据可以要求删除或重写现有 Visibility、HZB、Material Expand 和帧提交路径。
- 具体算法、GPU 数据结构和 Shader 实现应先从 `docs/references/README.md` 路由到当前核心参考；存在许可证兼容且经过验证的实现时，优先做可追溯移植，不凭空重写同一算法。移植必须记录上游仓库、commit/tag、源码路径、许可证、保留的不变量和为 WebGPU/OEngine 做出的差异。

## 开源实现与算法复用

- 开源复用优先适用于所有基础能力，不只适用于 GPU-driven：渲染算法、数学函数、PBR/BRDF、材质模型、资产解析、Meshlet/压缩、纹理格式、动画、ECS、验证和调试工具都必须先检索成熟开源实现、论文或官方规格。
- 外部实现只能采用“直接依赖、可追溯局部移植、按规格独立实现、拒绝采用”四种状态；无许可证或许可证不兼容的代码只能做概念参考，不得复制、翻译或改写其表达性代码。
- 详细搜索从 `docs/references/README.md` 路由；许可证、迁移记录、性能评估和 WebGPU 适配规则见 `docs/references/OPEN-SOURCE-REUSE.md` 与 `docs/references/porting/`。
- 复用外部实现不豁免性能门禁；必须说明减少的工作、增加的资源/dispatch/branch 成本、fallback/lifecycle 语义，并用同条件 A/B/C 或局部 benchmark 证明。

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
4. `docs/TARGETS.md`：当前目标平台与 workload。
5. `docs/ARCHITECTURE.md`、`docs/RENDER-PIPELINE.md`：目标架构。
6. `docs/CURRENT-STATE.md`：当前实现事实与已知缺陷。
7. `docs/references/`、`three.js/`：外部证据，不自动决定本项目设计。
