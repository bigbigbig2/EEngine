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
yarn test:rendering-lab:profiles
yarn test:visibility-key-oracle
```

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
- `profile-smoke.mjs` 用于开发探查；`profile-formal.mjs` 用于发布级候选证据。

报告必须区分 CPU wall、GPU timestamp、counter coverage、memory、submit 和 diagnostics。缺失或 unsupported 的样本保持 unavailable；不能以 0 代替，也不能把 CPU/GPU 时钟相加。

## Feature-off 与归因

`full-minus-*` case 必须证明对应 Pass、资源、history、readback、counter copy 和额外 submit 缺席。相机拉近导致的成本变化应分别观察像素、LOD/几何、Visibility、阴影、SSR、Post 和 CPU/UI；证据不足时报告 `inconclusive`。

本机 smoke 与大型原始 capture 是可删除的临时产物。只有符合 [`docs/VALIDATION.md`](../../docs/VALIDATION.md) 的 clean、可复算结果才能成为接受基线。
