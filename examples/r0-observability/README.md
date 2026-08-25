# R0 Observability Smoke

对应 `OBS-01`、`OBS-03` 和 `OBS-04` 的首个浏览器垂直验证。页面通过 `../../OEngine/src/index.ts` 引用引擎，真实创建 WebGPU adapter/device 和 `Renderer`，再对 `GraphicsContext.update()` 预热 4 帧、采集 20 帧。

```powershell
Set-Location examples
npm install
npm run dev:host
```

打开 Vite 输出的 `/r0-observability/`。通过条件：

- 状态变为“采集完成”，Measured 显示 `20 / 20`；
- Result JSON 包含真实 adapter、features、limits、CPU frame、submit/readback/upload 和 counter；
- 控制台没有 WebGPU validation error 或未处理异常；
- 页面截图能识别 adapter 和汇总结果。

这不是 A/B/C 性能基线，也不渲染场景。它只验证 R0 观测设施能在真实浏览器/WebGPU/OEngine 初始化路径运行；正式 GPU timestamp、画面和性能结论仍由后续示例负责。
