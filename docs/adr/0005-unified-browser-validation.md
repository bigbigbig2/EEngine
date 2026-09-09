# ADR-0005 · 统一浏览器验证体系

Status: accepted

## Context

原有浏览器验证由多个 Playwright 脚本分别启动 Chrome、等待各自的全局 Bridge、收集错误和写入结果。普通正确性验证与 Rendering Lab profiling 的职责混在一起，改动到渲染源码后也缺少从变更路径选择最小有效 Case 的统一入口。重复 Runner 容易产生环境判定、失败语义和 artifact 格式不一致，并可能把缺少 Chrome、陈旧结果或 schema 错误误报为通过。

## Decision

- `examples/validation/fixture-protocol.ts` 定义唯一 Browser Validation Fixture 协议；所有 Canonical Fixture 只暴露 `window.__OENGINE_VALIDATION_FIXTURE__`，每次 Scenario 必须携带唯一 `runId` 并返回更新帧证据。
- `examples/validation-tools/cases.mjs` 是 Canonical Case id、route、scenario、domain 和运行要求的唯一 Registry。Fixture 与 Runner 不复制 Case 列表。
- `verify changed` 支持 working tree（staged、unstaged、untracked、rename/delete）、`<base>...HEAD` 和显式路径选择。无法映射的 `OEngine/src/` 路径保守运行 `smoke.basic`、`lifecycle.init-destroy` 和 `visibility.basic`，并在结果中公开 `unmappedPaths`。
- 日常真实 GPU 验证使用四个自持有 Runtime 的 Fixture：Smoke、Visibility、Surface、Lifecycle。Scene、Renderer、Camera、RAF 和 GPU 生命周期留在 Fixture，`validation-tools/` 不持有引擎 Runtime。
- `examples/validation-tools/chrome-runner.mjs` 是唯一 Playwright/Chrome owner，负责 Vite、Chrome resolution、每 Case 独立 Context、错误采集、schema 校验、截图、JSON 和清理。本机 Google Chrome 缺失时结果为 `inconclusive`；Chromium fallback 必须显式启用，且不能冒充 Chrome 证据。
- 状态固定为 `passed`、`failed`、`inconclusive`，进程退出码分别为 0、1、2。浏览器错误、GPU diagnostics、失败断言、陈旧 `runId`/frame 或 schema 错误必须失败。
- Rendering Lab 保持综合/性能 Fixture，不改写其场景和 benchmark owner；开发 profiles、workload smoke、VisibilityKey oracle 与 formal policy 都通过同一个 ChromeRunner 执行。Formal policy 要求 clean provenance、三个独立 Context、固定 workload/camera、120 warm-up + 480 measured frames（非 smoke）、截图和 BenchmarkEvidenceGate；任一 gate error 都失败。

## Consequences

日常验证可以按源码域运行少量真实 WebGPU Case，全量验证仍可显式请求。新增 Canonical Case 必须先进入 Registry，并提供能够独立判定的运行证据；Runner 不允许理解 HZB、材质或资源生命周期等领域语义。Rendering Lab 的专用 browser bridge 仍属于其 benchmark API，但不再拥有独立 Playwright runner。

旧的 per-page validation bridges 和独立 Playwright 脚本不保留兼容层。日常结果与 formal benchmark artifact 进入可清理的本机输出目录，不成为已接受基线。

## Verification

运行 `npm run test:validation-tools` 验证 Registry、Selector、schema 和三态退出语义；运行 `npm run verify -- changed`、`--base <ref>`、`paths <...>`、domain、单 Case 与 `full` 验证选择和真实 Chrome 路径；运行四个 Fixture 检查 GPU counter/state、错误采集和资源销毁；运行 Rendering Lab workload、profiles、oracle，并在 clean commit 上运行 formal policy 验证三个独立 run、固定 cadence、provenance 和 gate failure 传播。具体合同见 [VALIDATION.md](../VALIDATION.md)。
