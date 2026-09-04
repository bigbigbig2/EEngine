# OEngine 内部文档系统精简设计

## 目标

把当前 `docs/` 从按历史阶段、专项 Gate 和研究过程累积的文档库，重构为只服务内部开发者和 Agent 的当前事实系统。

最终工作树只保留当前有效的产品边界、架构、帧管线、状态、验证合同、长期决策和运行代码来源。已经完成或失效的实施过程、旧示例说明、历史性能流水账和 deferred 研究直接删除，由 Git 历史承担追溯。

## 当前问题

基于提交 `f95ae36` 的只读审计：

- `docs/` 共有 95 个 Markdown、约 7759 行、636 KB。
- `references/` 有 40 个文件，`implementation/` 有 12 个文件；大量内容描述已经结束的 R/P/Q/FX/Stage 过程。
- 至少 84 行仍引用已删除的 `three.js/`、`webgpufundamentals/`、旧 examples、旧 browser runner 或 `performance-targets.json`。
- `CURRENT-STATE.md`、`implementation/STATUS.md`、`ROADMAP.md` 和各 Stage 文档重复维护状态，已经出现先后状态并存。
- `11-render-pipeline-reconstruction.md` 与 `13-product-render-pipeline-redesign.md` 合计约 1700 行，同时承担设计、计划、状态和验收职责。
- 25 份文档无法从 `docs/README.md` 到达。
- 当前代码和测试直接引用若干旧实施/移植文档，删除前必须迁移这些依赖。

## 范围

### 包含

- 重写 `docs/` 的信息架构和权威关系。
- 从当前 TypeScript/WGSL、测试和 Rendering Lab 重新提取事实。
- 合并仍有效的 ADR。
- 合并仍被运行代码消费的算法、资产和许可证记录。
- 更新根 `AGENTS.md`、`CONTEXT-MAP.md`、`OEngine/**/AGENTS.md` 中的文档路由。
- 更新源码注释、测试、benchmark README 和 examples README 中的旧文档/路径引用。
- 删除过时文档，不创建 archive 目录。
- 增加自动化文档结构、内部链接和禁用旧路径检查。

### 不包含

- 修改 Renderer、FrameGraph、GPU ABI、WGSL 算法或运行时行为。
- 声称尚未通过的 GPU、画质、显存或性能 Gate 已完成。
- 恢复已经删除的 examples、browser runner、第三方源码镜像或 `performance-targets.json`。
- 为外部用户编写教程、API 手册或发布文档。

## 最终结构

最终只保留以下 15 份 Markdown：

```text
docs/
├── README.md
├── PRODUCT.md
├── ARCHITECTURE.md
├── PIPELINE.md
├── STATUS.md
├── VALIDATION.md
├── adr/
│   ├── README.md
│   ├── 0001-gpu-first-scope.md
│   ├── 0002-runtime-assets-and-gpu-driven.md
│   └── 0003-unified-render-pipeline.md
└── porting/
    ├── README.md
    ├── geometry.md
    ├── visibility.md
    ├── shading.md
    └── platform.md
```

本次设计规格和实施计划是临时执行材料。重构完成、验证通过后从工作树删除，仍可从 Git 历史查阅。

## 权威职责

### `README.md`

唯一文档入口。只提供六份核心文档的阅读顺序、ADR/porting 路由和“历史只查 Git”的规则，不重复正文事实。

### `PRODUCT.md`

唯一产品范围。合并现有 `CONTEXT.md`、`DIRECTION.md` 和 `TARGETS.md` 中仍有效的信息：

- 桌面浏览器 WebGPU、桌面独立 GPU 为主要 profile；
- 中大型、高几何密度、静态或 mostly-static 场景；
- Hardware-first Visibility、Packed Instances 和统一主管线；
- 明确列出非目标和 deferred 能力；
- 保留 1920×1080、DPR 1、60 FPS、16.667 ms GPU 产品目标，但标记为尚未证明。

不保存阶段编号、历史提交或旧 artifact。

### `ARCHITECTURE.md`

唯一模块和 owner 事实源。内容来自当前源码，而不是旧 Stage 计划：

- `core → runtime assets → gpu → framegraph/render → index.ts` 依赖方向；
- Runtime Asset、GpuAssetStore、GpuScene、Packed Scene、FrameGraph、Feature/Service 和 Renderer 的 owner；
- 当前仍存在的 Packed/legacy 双路径；
- 当前约 3853 行的 `Renderer.ts` 仍是大型 composition root；
- 当前架构与目标架构之间的明确差距。

每个事实使用源码路径作为下一跳，不复制实现细节。

### `PIPELINE.md`

唯一帧管线和跨模块数据合同：

```text
Scene/Packed updates
→ hierarchy/SSE/culling/work generation
→ drawIndirect VisibilityKey + reverse-Z
→ Surface + Velocity resolve
→ direct/shadow/GI/AO/reflection
→ transparency
→ temporal/upscale
→ HDR post/present
```

只保留当前运行合同：GPU producer/consumer、queue capacity/overflow、VisibilityKey、SurfaceFrame、OpaqueLightingFrame、resolution domain、history invalidation、单 command encoder/main submit 和 feature-off pruning。

目标能力必须放入“差距”段，不能混入当前帧流程。

### `STATUS.md`

唯一频繁更新的状态文件，按真实模块而不是历史编号组织：

- 已验证基础；
- 当前运行 owner；
- 未完成的 legacy consumer；
- correctness、quality、performance、memory 和 provenance 风险；
- 下一步最多保留 5 个按依赖排序的工作项。

禁止 R0–R5、P0–P9、Q、FX 和 Stage 多套状态矩阵；必要的旧名称只可出现在 Git 提交或迁移来源说明中。

### `VALIDATION.md`

唯一验证合同。合并现有 `PERFORMANCE.md`、`BASELINE-ARTIFACTS.md`、R5 browser gate 和 benchmark matrix 中仍适用的规则：

- `cd OEngine; npm ci; npm test`；
- `cd examples; yarn install; yarn build` 和 Rendering Lab/Storybook 运行入口；
- WebGPU validation、device loss、counter、GPU timestamp、memory、upload/readback、feature-off 和单 submit 要求；
- 固定的 1080p 产品目标与内存/I/O 上限；
- 性能比较必须同 adapter、浏览器、分辨率、DPR、配置、workload、warm-up 和样本数；
- 数值/readback/diagnostics 是必需证据，截图只在视觉判断确有必要时使用。

历史测量值、已经删除的 A/B/C 页面、旧 runner 和 temp artifact 路径不迁移。

## ADR 合并

现有 12 份 ADR 合并为三份当前决策：

1. `0001-gpu-first-scope.md`
   - 桌面 WebGPU、mostly-static 高密度场景；
   - Hardware-first；
   - 非目标与 capability 边界。
2. `0002-runtime-assets-and-gpu-driven.md`
   - GPU-ready Runtime Asset；
   - compact GPU tables、Packed Instances、hierarchy/SSE；
   - GPU work producer → indirect consumer；
   - VisibilityKey 与容量/fallback/lifecycle。
3. `0003-unified-render-pipeline.md`
   - Single Material Resolve；
   - Surface/Lighting/Temporal/Post 统一主管线；
   - FrameGraph、单 submit、feature pruning；
   - 性能证据是完成门槛。

旧 ADR 的 superseded 历史不复制，Git 保存演化过程。

## Porting 合并

算法和许可证记录不能因精简而丢失。每条仍运行的记录必须包含：

- 本地 owner/source；
- 上游项目与 URL；
- commit/tag 和上游源码路径；
- license；
- 采用状态：直接依赖、局部移植、按规格实现或拒绝采用；
- 保留的不变量；
- OEngine/WebGPU 差异；
- fallback/lifecycle；
- 本地验证入口。

按领域合并：

- `geometry.md`：meshoptimizer、Meshlet、hierarchy、SSE、Cooker 和 camera controls。
- `visibility.md`：work generation、HZB、VisibilityKey、Hardware raster、Material classification。
- `shading.md`：PBR/IBL、clustered lighting、CSM、AO、SSR、OIT、Temporal、Color Grading、GI provider。
- `platform.md`：WebGPU capability、资源生命周期、cache、readback 和 FrameGraph 参考。

已经拒绝且不再影响当前设计的研究候选不迁移。运行中的四个 oracle/generated shader 风险写入 `STATUS.md`，详细 runtime owner 写入对应 porting 文档。

## 测试和源码引用迁移

以下引用必须与文档迁移同时处理：

- `p6-transparency-feature.test.mjs` 不再读取大型产品设计文档，改为验证真实 Feature/source contract。
- CSM、Temporal、AO、SSR 的 provenance 测试改读 `docs/porting/shading.md` 中稳定记录 ID。
- Geometry hierarchy 与 work-generation 源码注释改指向 `docs/porting/geometry.md` 或 `visibility.md`。
- Color grading 的错误 `R5-0x` 路径改指向 `docs/porting/shading.md`。
- `OEngine/benchmarks/README.md` 删除旧 examples、旧计数和旧 artifact 工作流。
- 根/局部 `AGENTS.md` 与 `CONTEXT-MAP.md` 只引用最终结构。

新增 `OEngine/tests/documentation-system.test.mjs`，至少验证：

1. `docs/` Markdown 正好匹配最终 allowlist；
2. 所有相对 Markdown 链接存在；
3. 不含已删除本地路径和旧 runner；
4. 不把历史阶段编号当作当前状态路由；
5. 核心代码/测试引用的文档存在；
6. 四份 porting 文档包含所需 provenance 字段。

## 删除范围

完成内容迁移后删除：

- 现有顶层 `CONTEXT.md`、`CURRENT-STATE.md`、`DIRECTION.md`、`TARGETS.md`、`RENDER-PIPELINE.md`、`ROADMAP.md`、`PERFORMANCE.md`、`BASELINE-ARTIFACTS.md`、`SHADER-SOURCES.md`；
- 整个 `docs/contexts/`；
- 整个 `docs/implementation/`；
- 整个 `docs/references/`；
- 整个 `docs/wiki/`；
- 临时 `docs/superpowers/` 执行材料。

其中仍有效内容先进入最终文档；不得先删除后凭记忆重写。

## 执行顺序

1. 添加文档系统失败测试，冻结最终 allowlist、禁用路径和链接规则。
2. 从当前代码和现有文档生成六份核心文档。
3. 合并三份 ADR。
4. 合并四份 porting 记录并迁移 provenance 测试。
5. 更新 AGENTS、CONTEXT-MAP、源码注释、tests、benchmark/examples README 的路径。
6. 删除旧文档树。
7. 运行文档专项测试、shader audit、`npm test` 和 examples build。
8. 确认 Git diff 中只有本任务文件，且最终文档数量和链接检查通过。
9. 删除本次临时规格和计划，重新运行 allowlist 测试。

## 验收标准

- `docs/` 最终只有 15 份 Markdown，不存在 archive。
- 核心文档合计目标为 1500–2200 行；任何单文件原则上不超过 500 行。
- 当前事实只出现在 `STATUS.md` 和 `ARCHITECTURE.md` 的明确职责范围内，不再多点维护。
- 不存在指向已删除本地资源的路径。
- 当前 legacy consumer、Renderer composition debt、未完成产品 Gate 和 shader provenance 风险均被保留。
- 所有运行代码的外部来源与许可证仍可追溯。
- `npm test`、shader audit、examples build 和文档专项检查全部通过。
- 工作区不包含测试或包管理器产生的额外修改。

