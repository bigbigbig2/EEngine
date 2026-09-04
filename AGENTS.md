# OEngine 仓库协作约束

## 项目定位

OEngine 当前阶段是面向桌面 WebGPU、中大型高几何密度场景的 GPU-first 渲染引擎核心。当前优先建设 GPU-ready 资产、紧凑 GPU 表与 Packed Instances、层次工作生成、Hardware-first Visibility、单次材质解析、光照与时域渲染管线；不以超大世界或完整 Gameplay 引擎为前提。

当前阶段不以兼容 three.js 生态为目标。外部项目只能作为已登记的算法、行为或性能参考，不是 OEngine 运行时依赖或代码所有权来源。

## 开始任务前

1. 完整阅读 `CONTEXT-MAP.md`。
2. 按路由阅读 `docs/PRODUCT.md`、`docs/ARCHITECTURE.md` 或 `docs/PIPELINE.md`。
3. 修改 `OEngine/` 时阅读 `OEngine/AGENTS.md`，并继续读取更近的 `AGENTS.md`。
4. 架构变更先检查 `docs/adr/`；范围判断读取 `docs/PRODUCT.md`；验证或性能判断读取 `docs/VALIDATION.md`。

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
- 具体算法、GPU 数据结构和 Shader 实现先检查 `docs/porting/`；存在许可证兼容且经过验证的实现时，优先做可追溯移植。移植必须记录上游仓库、commit/tag、源码路径、许可证、保留不变量和 WebGPU/OEngine 差异。

## 开源实现与算法复用

- 开源复用优先适用于所有基础能力，不只适用于 GPU-driven：渲染算法、数学函数、PBR/BRDF、材质模型、资产解析、Meshlet/压缩、纹理格式、动画、ECS、验证和调试工具都必须先检索成熟开源实现、论文或官方规格。
- 外部实现只能采用“直接依赖、可追溯局部移植、按规格独立实现、拒绝采用”四种状态；无许可证或许可证不兼容的代码只能做概念参考，不得复制、翻译或改写其表达性代码。
- 来源、许可证、迁移记录和 WebGPU 适配规则统一见 `docs/porting/`。
- 复用外部实现不豁免性能门禁；必须说明减少的工作、增加的资源/dispatch/branch 成本、fallback/lifecycle 语义，并用同条件固定 workload 或局部 benchmark 证明。

## 代码与生成物

- `OEngine/src/index.ts` 是公开 interface；内部 GPU、Pass、Shader 类型默认不向外泄漏。
- `*.generated.ts` 和 oracle Shader 不是设计权威；变更时必须确认真实运行路径和生成来源。
- 重构默认直接迁移调用方并删除死代码，不保留无需求的兼容层。

## 验证

- 类型与构建：`cd OEngine; npm ci; npm run build`。
- 性能改动必须遵守 `docs/VALIDATION.md` 的相同 adapter、分辨率/DPR、画质、workload 和 warm-up 规则。
- 渲染正确性不能只靠 typecheck；需要 GPU timestamp、计数器、debug view 或截图/数值回归。
- 可运行的垂直验证逐步放在根目录 `examples/`，通过相对路径引用 `OEngine` 源码。渲染改动至少运行一个命中的浏览器示例；必要时保存结果并检查截图和控制台，不能只跑 TypeScript 单元测试。
- 默认采用与风险匹配的中等验证：本地检查、构建/测试和命中示例。除非用户明确要求或变更风险确实需要，不为普通验证扩散多个 review 子任务。
- 最终说明必须列出已运行验证、未运行验证和原因。

## 文档权威顺序

1. `AGENTS.md` 与更近的局部 `AGENTS.md`：协作和所有权约束。
2. `docs/adr/`：已接受的长期决策。
3. `docs/PRODUCT.md`：产品方向、目标平台、workload 与非目标。
4. `docs/ARCHITECTURE.md`、`docs/PIPELINE.md`：当前架构、owner 与帧合同。
5. `docs/STATUS.md`：当前实现状态、风险与下一步。
6. `docs/VALIDATION.md`：验证和性能证据合同。
7. `docs/porting/`：外部来源与许可证，不自动决定项目设计。
