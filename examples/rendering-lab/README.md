# Rendering Lab

`rendering-lab` 是 GPU-driven mostly-static 场景的综合质量与性能 fixture。它加载固定 GLB/HDR 输入，构建 versioned Runtime Asset，上传到 `GpuAssetStore`，并通过 Packed Instance table 进入真实 OEngine 主管线。

Performance telemetry 由共享 `OEngine/src/addons/inspector` 提供。Rendering Lab 不维护第二套统计面板；场景控制、质量配置和 debug view 仍由本页面拥有。

## 模式

- 默认模式：综合画质与交互调试。
- `?mode=pipeline`：关闭阴影、AO、SSR、TAA、Bloom、曝光和 sharpening，聚焦 Visibility-to-Surface 路径。
- `?textureMaxResolution=1024`：显式纹理质量/长期 residency 实验；它不是无损优化，也不是默认配置。

## 开发运行

从 `examples` 目录执行：

```powershell
yarn storybook
yarn test:rendering-lab:workload
yarn test:rendering-lab:pipeline-matrix
yarn test:rendering-lab:shadow-feature-off
yarn profile:rendering-lab:dev
yarn test:visibility-key-oracle
```

`profile:rendering-lab:dev` 通过统一 ChromeRunner 使用 Playwright 启动本机 Google Chrome（默认 headless），在单个 BrowserContext 中按 30 warm-up + 60 measured cadence 运行。它允许 dirty worktree，只用于短 A/B 和编排检查，不构成正式性能证据。只有显式设置 `OENGINE_ALLOW_CHROMIUM_FALLBACK=true` 才允许退回 Playwright Chromium，且该结果不得标记为 Chrome 证据。

正式 profile：

```powershell
yarn profile:rendering-lab:formal
```

正式 profile 必须使用 clean commit，并固定浏览器、adapter、canvas/internal resolution、DPR、quality profile、feature set、workload、seed、camera path、warm-up 和 measured frames。

## Benchmark 合同

- `benchmark-workloads.ts` 定义稳定 workload identity。
- `quality-profile.ts` 定义质量和 feature 组合。
- `camera-path.ts`、`camera-experiments.ts` 定义固定 FOV、投影归一化、LOD 和 camera-cut 输入。
- `benchmark-suite.ts` 串行执行 base/full/full-minus 与相机实验。
- `benchmark-report.ts` 只消费 Renderer/FrameProfiler 证据并生成结构化报告。
- 开发 profiles、workload smoke、VisibilityKey oracle 和 formal policy 都由 `validation-tools/chrome-runner.mjs` 启动浏览器；Rendering Lab 只拥有 benchmark Fixture 与领域证据。

Formal 默认执行三个独立 browser context，每次 120 warm-up + 480 measured frames，并要求 clean commit、固定 workload/camera、截图、provenance 和全部 BenchmarkEvidenceGate 通过。`OENGINE_BENCHMARK_SMOKE=true` 只用于检查 formal 编排，不构成正式性能证据。

报告必须区分 CPU wall、GPU timestamp、counter coverage、memory、submit 和 diagnostics。缺失或 unsupported 的样本保持 unavailable；不能以 0 代替，也不能把 CPU/GPU 时钟相加。

## Feature-off 与归因

`full-minus-*` case 必须证明对应 Pass、资源、history、readback、counter copy 和额外 submit 缺席。相机拉近导致的成本变化应分别观察像素、LOD/几何、Visibility、阴影、SSR、Post 和 CPU/UI；证据不足时报告 `inconclusive`。

`test:rendering-lab:shadow-feature-off` 在同一个 1920×1080 Chrome/adapter 会话、相同 `comprehensive-full` 动态 workload 和 30+60 smoke cadence 下依次运行 `full` 与 `full-minus-shadow`，记录 main submit、Shadow GPU phase、CPU `shadow-update`、resident/atlas memory，并把关闭态的 Pass、I/O label、GPU counter 和资源 owner 缺席设为机器门禁。它用于 Step 4 编排验收，不替代 clean commit 上的正式性能基线。

`test:rendering-lab:pipeline-matrix` 在同一个 1920×1080 Chrome/adapter 会话中执行 `base`、`full` 和每个 `full-minus-*` 组合；所有 measured frame 必须保持一个 main submit、一次 cached graph execute、零 graph build/compile/miss，且所有 overflow counter 为零。它是 Step 5 的 feature topology 编排门禁，不替代 clean-commit formal run group。

本机 smoke 与大型原始 capture 是可删除的临时产物。只有符合 [`docs/VALIDATION.md`](../../docs/VALIDATION.md) 的 clean、可复算结果才能成为接受基线。
