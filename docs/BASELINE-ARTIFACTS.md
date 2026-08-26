# R0 基线 Artifact 登记

本文只登记已经实际采集的文件及其证据等级。`exploratory` 可以帮助发现固定成本，不能参与 G0 或后续性能回归 gate；只有 `validateBenchmarkEvidence()` 返回 `gateEligible=true`，并配套截图与浏览器控制台记录的 A/B/C run bundle 才能升级为证据完整的 `gate` artifact。A/B 功能通过还必须 `capabilityComplete=true` 并达到固定画质与性能契约。

## 2026-08-26 · 旧 Schema smoke

来源文件位于用户工作区 `temp/`，不纳入 Git 所有权：

| Artifact | GPU / 尺寸 | CPU frame | submit / readback | 等级 |
|---|---|---:|---:|---|
| `oengine-r0-observability-3bd93630.json` | RTX 2060 SUPER / 1038×178 | P50 0.100 ms，P95 0.300 ms | mean 1 / 1 | exploratory |
| `oengine-r0-frame-smoke-3bd93630.json` | RTX 2060 SUPER / 1038×583 | P50 2.400 ms，P95 3.625 ms | mean 3 / 1.25 | exploratory |

frame-smoke 使用 81 个 Box、单材质、无本地灯光；稳定帧记录 728 bytes upload、约 265.8 MB resident GPU memory。它证明当时主链存在 `GraphicsContext.update`、animation flush 和 Renderer main 三次 submit，并持续产生 collection-limits readback。它不是 160k Teapot A、DamagedHelmet IBL B 或通用性 C，不能外推 A/B 性能。

机器判定的共同 blocker：Result/Environment Schema 1、dirty commit、缺少 `dirtyReasons`、缺少 gate `baselineRole`、资产/相机 hash 为占位值、缺少 Schema v3 diagnostics 与 `capabilityEvidence`、没有 GPU counter 样本和 `gpuPhaseMs`。observability 文件另外没有 GPU timestamp 样本；frame-smoke 的旧 segment 没有逻辑 phase。Schema 1/2 都没有冻结的能力证据矩阵，因此只能作为 exploratory。

旧 frame-smoke 中 `legacy.hzb.builds=1`，但采样帧存在两组 HZB mip timestamp，属于后来已经修正的旧观测缺陷；不得把该 counter 当成真实单次 build 证据。

## 升级条件

重新采集必须满足：

- clean commit、Schema v3、A/B/C gate role、真实资产与相机轨迹 hash；
- `capabilityEvidence` 完整覆盖 feature set 和 GPU counter ABI；当前缺失能力明确给出 blocker，不得伪造零值；
- 固定分辨率、DPR、feature set、warm-up/sample cadence；
- diagnostics 全零，所有异步 timestamp/counter 已完成且无 dropped sample；
- 原始 `gpuMs` 和按帧求和的 `gpuPhaseMs` 同时存在，没有 `unclassified` segment；
- 同一 run bundle 保存截图、控制台错误记录和结果 JSON。

A/B 仍只是最低功能与性能基线；`gateEligible=true` 只代表 artifact 可信，A/B 功能通过还要求 `capabilityComplete=true`。即使升级为 gate artifact，也不能替代 C 和通用 vertical/lifecycle 证据。
