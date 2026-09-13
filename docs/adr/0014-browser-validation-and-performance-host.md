# ADR-0014 · 独立浏览器验证与性能宿主

Status: accepted

## Context

ADR-0012 已完成旧示例/验证混合体系的清理。此后 Example Library V2 以 standalone Vite MPA 页面和 Storybook iframe catalog 的形式恢复，当前包含 Basic Scene 与 Rendering Lab；这些页面用于开发和人工观察，不拥有验证协议、结果新鲜度、错误聚合或 formal benchmark 语义。

ADR-0013 的 Step 4–8 必须取得真实 WebGPU component、FrameGraph、生命周期、视觉和 GPU timestamp 证据。继续把这些责任塞进 Storybook 或每个 Example 会再次制造第二套 runtime；只写 Node oracle 又不能关闭 L3–L5。需要一个独立、可复算、无旧协议兼容负担的浏览器宿主。

本 ADR 只定义通用宿主边界。具体算法 Gate、workload 和 adapter 是否阻塞仍由各功能 ADR 决定；ADR-0013 当前只要求本机指定的 `NVIDIA GeForce RTX 2060 SUPER`，其他 adapter 结果为非阻塞补充。

## Decision

### 1. 所有权与目录

新增顶层 `validation/` 包，独立拥有：

```text
validation/
├─ cases/                 # 唯一机器可读 Case/Workload registry
├─ src/host/              # 浏览器 protocol、case lifecycle、artifact producers
├─ src/cases/             # deterministic browser cases
├─ src/runner/            # Node/Playwright orchestration 与 evidence gate
├─ public/                # 仅验证所需的 immutable fixtures
├─ artifacts/README.md    # 本机输出策略；raw artifact 不提交
├─ package.json
├─ playwright.config.ts
├─ tsconfig.json
└─ vite.config.ts
```

- `examples/` 继续只做 Example Library；Storybook、Example metadata 和 Tweakpane 不成为验证 owner。
- `validation/` 可以直接导入 `OEngine/src/index.ts`；只有 candidate case 可显式导入 OEngine 内部模块，并必须在 registry 标为 `internal-candidate`。
- `OEngine/src/index.ts` 不导出验证协议、GPU buffer、Pass、Shader 或 candidate switch。
- 不恢复旧 Case Registry、Bridge、Runner、URL、artifact schema 或 ADR-0005 兼容层。

### 2. 一个 case 一个独立 Document

每个 case 在独立页面上下文中运行，拥有自己的 Renderer/device/Scene/Camera/RAF/resources，并在结束时显式销毁。Runner 不在同一页面串行切换多个 GPU runtime。

Case 状态机固定为：

```text
created → negotiating → ready → warming → sampling → draining → passed|failed|unsupported → disposed
```

`failed` 表示能力存在但 correctness、error、lifecycle 或 performance Gate 失败；`unsupported` 只用于 case 声明的能力无法满足。两者不能互相转换以让结果变绿。

### 3. 唯一 registry 与 build-time target

`validation/cases/registry.json` 是 Case identity、route、kind、owner ADR/requirement、workload、timeout、artifact 和 changed-path mapping 的唯一 owner。id 永久唯一且使用 kebab-case。

Candidate 与 production 不以 URL 参数、环境变量或运行时开关在同一 binary 选择 backend：

- candidate 在 candidate clean commit 构建，只暴露内部 candidate page；
- cutover 后 production case 只通过公开 Renderer 入口运行；
- 两类入口遵循同一 registry/schema/workload contract；每个 artifact 保存本次内容 hash，允许每个 clean revision 有自己的 compile-time adapter module。
- ADR-0013 只要求当前 revision 的绝对正确性/性能验收，不要求旧 baseline worktree、新旧 A/B 或删除前后比较，也不为历史比较恢复旧 backend。

Runner 遇到同一构建同时暴露 legacy/candidate backend switch 时直接失败。

### 4. 新鲜度与协议

浏览器只在 `window.__OENGINE_VALIDATION__` 暴露 versioned protocol。Runner 为每次运行生成不可复用的 `runId` 与随机 `nonce`；页面必须回显二者，并报告：

- schema/case/workload id 与内容 hash；
- engine commit、tree/content hash、dirty state；
- host build id、浏览器 executable/version/user agent；
- 页面 `startedAt`、每阶段时间和 `completedAt`；
- adapter/device capability fingerprint；
- case 状态、错误、counter、FrameGraph、resource、submit 和 artifact manifest。

结果必须由本次页面导航产生。缺失/重复 nonce、case/hash 不符、过期时间、页面 reload、Runner disconnect 或未执行 dispose 均使 run 失败，禁止读取上一次全局变量或磁盘结果。

### 5. WebGPU 初始化与错误收集

Host 使用生产 Renderer 的协商流程，并额外冻结原始浏览器证据：

1. 检查 secure context 与 `navigator.gpu`；
2. `requestAdapter({ featureLevel: "core", powerPreference: "high-performance" })`；
3. 记录 adapter info/features/limits 并计算精确 required feature/limit；
4. `requestDevice()` 后、创建任何资源前注册 `device.lost` 和 `uncapturederror`；
5. 记录 requested 与 actual device capability、WGSL language features 和 specialization；
6. 每个可归因的 shader/pipeline/resource 创建由 validation/OOM/internal error scope 包围，Shader 同时读取 `getCompilationInfo()`。

Playwright 额外收集 page error、console error/warn、failed request、response >= 400、crash 和 navigation。任一未 allowlist 的错误阻止通过；allowlist 必须位于 registry，包含理由和 owner requirement，不能用模糊正则吞掉未知错误。

Device loss 分为 intentional destroy 与 unexpected loss。前者只允许在 dispose/fault case 的冻结阶段出现；后者立即失败并保存原因。Recovery case 必须重新请求 adapter/device、重建所有资源且不复用旧对象，重试次数有界。

### 6. Correctness 与生命周期证据

每个渲染 case 同时提供与其 requirement 匹配的证据：

- live FrameGraph pass/resource/edge 与 feature-off 物理缺席；
- GPU queue attempted/written/consumed/overflow/invalid closure；
- one-main-submit 与额外 submit 列表；
- bounded GPU readback/numeric oracle；
- 必要的最终截图和内容 hash；
- resident/transient/history/shadow/upload/readback bytes；
- dispose 后 owner/resource/RAF/listener 状态。

Screenshot 不能替代 identity、overflow、feature-off 或 GPU producer→consumer readback。CPU oracle 不能替代真实 shader execution。Diagnostics case 与 production case 是不同 build-time pipeline variant；production capture 中 claims/readback owner 必须物理不存在。

### 7. 性能采样

Formal PERF 只在功能 ADR 指定的 adapter 和条件下运行。ADR-0013 固定：1920×1080、DPR 1、render scale 1、fixed quality/features/seed/camera、同一 workload hash、固定 warm-up 和 sample cadence、至少三个独立 browser context run group。

- GPU timestamp-query 可用是进入 formal PERF 的前提；不可用只保留 correctness 证据。
- 保存 GPU frame/phase P50/P95、CPU build/submit、Present/RAF cadence、submit count、memory 和所有 correctness counter。
- 原始逐帧样本保存到本机 artifact，提交的 summary 必须引用 raw content hash、clean commit/tree、host/workload hash。
- FPS overlay、任务管理器利用率和 CPU wall time不能替代 GPU timestamp。
- Runner 不自动降低分辨率、画质、采样窗口或切换更快 adapter。

### 8. Playwright 与 Chrome 所有权

Runner 使用版本锁定的 Playwright 控制本机 Chrome stable executable，并创建一次性隔离 profile；不复用用户登录数据、扩展、缓存或已有 tab。浏览器版本和 executable hash 进入 evidence。默认 headed/headless 必须由 registry profile 固定，同一比较组不得混用。

Vite server 由 Runner 以可观察子进程启动，等待健康检查后运行；结束时先 drain GPU/readback，再 dispose page/context/browser，最后终止 server。进程退出、端口占用和 timeout 都必须显式失败，不允许后台遗留进程被下一次运行复用。

### 9. Artifact 与提交策略

本机 raw 输出进入 `validation/artifacts/<runId>/` 并由 `.gitignore` 排除；Runner 每次运行前只清理自己的 runId 目录，不递归删除未知目录。正式接受的小型 summary 进入 `OEngine/benchmarks/`，截图/trace 等大文件留在外部存储并以 hash 引用。

只有 clean commit 的 evidence 可以关闭 MILESTONE/PERF。Dirty run 可用于调试，但 status 固定为 `diagnostic-only`。

### 10. 首批实现顺序

1. 冻结 protocol、registry、artifact schema 和静态 validator。
2. 建立 Vite host、Playwright Chrome runner、错误/新鲜度/清理闭环，并以不创建 Renderer 的 protocol self-test 验证编排。
3. 增加真实 WebGPU capability/component case，接入 shader compilation、error scope、device loss 和 bounded readback。
4. 增加 ADR-0013 的 `BasicCubeNear/Far`、`UnlitVertexColor`、`UnlitTexture`、`MixedBins`、`RenderingLabFixed` 与生命周期矩阵。
5. 在当前 clean candidate revision 上运行 Step 6 的完整 correctness/lifecycle 与绝对 PERF；通过后才允许 ADR-0013 Step 7 cutover，不设旧 baseline 或新旧 A/B 前置门禁。
6. Cutover 后用 production Renderer 重跑同一 registry/workload，再执行 ADR-0013 Step 8 final acceptance。

## Consequences

### Positive

- Example、验证和性能三种责任不再共享 runtime owner。
- Candidate 能取得真实 GPU 证据而不向产品暴露 backend switch。
- 每次结果都有新鲜度、能力、错误、资源和内容 provenance，可复算且不会误用历史页面状态。
- 单设备或多设备要求由功能 ADR 决定，宿主本身不硬编码设备数量。

### Negative

- 新增独立 package、Chrome/Playwright 工具链和 artifact 生命周期维护成本。
- candidate 与 production 的入口验证各需对应 clean revision/build，component evidence 不能代替公开 Renderer 入口验证。
- device-loss、截图和 GPU readback case 需要专门的测试接口，但这些接口必须保持 validation-internal。

### Rejected alternatives

- **直接把 Runner 塞入 Storybook/Example**：会重新耦合 catalog 与验证 owner。
- **恢复旧 Runner**：旧协议和场景已被 ADR-0012 明确删除，不再兼容。
- **公开 Renderer candidate flag**：会形成长期双 backend 和错误的产品 API。
- **只用 Playwright 截图/FPS**：缺少 GPU identity、queue、error、timestamp 与 feature-off 证据。
- **同 binary legacy/candidate 开关**：无法证明删除旧路径，也污染 cache、资源和当前采样条件。

## Verification

- 文档静态检查证明 ADR-0012 的重置历史、Example Library V2 当前事实与本宿主边界一致。
- Registry validator 拒绝重复 id、未知 requirement、无界 timeout、无 artifact owner、模糊 error allowlist 和 backend runtime switch。
- Protocol self-test 覆盖 fresh/stale/replayed nonce、reload、timeout、page crash、failed request、console/page/GPU error 和 dispose failure。
- Runner lifecycle test 证明 isolated Chrome profile、server/browser 子进程、端口和 artifact 目录均按 runId 创建与回收。
- WebGPU component case 记录真实 adapter/device/WGSL fingerprint、compilation info、error scopes、uncaptured error 和 device loss。
- ADR-0013 cases 按其 L3–L5 requirement matrix 产出 queue closure、live graph、one-submit、readback/screenshot/timestamp/memory 证据。
- `examples/` 源码不导入 validation protocol/runner，`validation/` 不成为 `OEngine/src/index.ts` 的依赖。
- Formal summary 的 commit/tree/host/workload/raw hashes 可由 validator 重算；dirty、adapter mismatch 或 timestamp unavailable 的 run 不能关闭 PERF。
