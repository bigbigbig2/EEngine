# R0 Frame Smoke

对应 `OBS-02`、`OBS-03` 和 `OBS-04` 的真实主帧垂直验证。页面通过相对路径导入 OEngine，创建固定的 9×9 Box 场景、程序化环境纹理、固定相机和方向光，预热 8 帧后采集 24 帧。

```powershell
Set-Location examples
npm install
npm run dev:host
```

打开 Vite 输出的 `/r0-frame-smoke/`。通过条件：

- 状态变为“采集完成”，Measured 显示 `24 / 24`；
- Canvas 显示完整 Box 阵列，没有漏绘、全黑或明显深度错误；
- GPU 支持 `timestamp-query` 时，结果包含至少一个 GPU segment；不支持时明确记录 unavailable；
- Result `schemaVersion` 为 3，`capabilityEvidence.schemaVersion` 为 2，`diagnostics` 中 validation、uncaptured error、device lost、dropped/failed GPU counter sample 全为 0；
- `gpu-counters` readback 只出现在采样帧，采样完成后 `pending=false`；每个有效样本必须包含 `candidateInstances`、`visibleInstances`、`rejectedFrustum`、`candidateClusters`、`selectedClusters`、`rejectedHzb`、`hwClusters`、`alphaClusters`、`hwTriangles`、`shadedPixels`、`emptyVisibilityPixels`、`activeMaterials`、`activeLights` 与 `queueOverflowMask`；`rejectedHzb=0` 是合法真实结果，不能和字段缺失混为一谈；
- `capabilityEvidence.featureSets.hzb-culling` 必须为 `supported`；当前未实现的 `cone-culling/rejectedCone` 仍由 `WORK-04` 阻塞，页面不得伪造该 counter；
- 每个有效样本满足 `candidateInstances = visibleInstances + rejectedFrustum`、`selectedClusters = hwClusters + alphaClusters`、`hwTriangles = selectedClusters × 128`、`shadedPixels + emptyVisibilityPixels = internalWidth × internalHeight`；本场景只有一个已构建非透明材质和 DirectionalLight，所以 `activeMaterials=1`、`activeLights=0`，并且固定小场景必须有 `queueOverflowMask=0`；页面最终显示 `counterMismatches=0`；
- `legacy.hzb.builds` 与 `legacy.hzb.mipPasses` 应和 timestamp 中实际 HZB 执行次数一致；
- 控制台没有 WebGPU validation error、未处理异常或 device lost；
- 保存结果 JSON 和页面截图。

采集完成后，页面会解锁统一 Render Debug View 下拉框。`Visibility Key`、
`反向 Z Depth` 和 `Velocity` 会各自触发一次真实主管线渲染；其他已登记但尚无
逐像素 producer 的模式会明确显示 `unsupported` 和原因，并保持正常输出，不能
把占位颜色当成已经实现。切回“关闭”后不应保留 Debug Pass、瞬态纹理或 readback。

这是验证当前 OEngine 主链可观测性的固定小场景，不是 three.js A/B 性能对齐，也不能用于声称 R0 Gate 完成。
