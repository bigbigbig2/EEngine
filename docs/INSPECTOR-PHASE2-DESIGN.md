# Inspector v2 Phase 2：实时 Timeline 录制与 OEngine 证据

## 目标

建立一个有界、内存内的实时 Timeline 录制器。录制停止后冻结查看窗口，但不生成离线 Capture 文件，也不改变 Renderer 的提交循环。

## 模块 seam

```text
Renderer / GPU owners
        -> ProfilerEvidenceSource
        -> LiveProfilerStore (ring, recording, selection)
        -> ProfilerViewModel
        -> ProfilerShell and Tabs
```

`LiveProfilerStore` 是深模块：对外只暴露开始/停止录制、清理、跟随最新帧、选择帧和读取快照；环形容量、异步 GPU patch、coverage 与丢帧处理都隐藏在实现中。

## 帧合同

每一帧由 `{ epoch, frameIndex }` 标识，并同时携带 CPU spans、GPU spans、GPU counters、FrameGraph、资源 accounting 和 Diagnostics。历史帧所展示的所有数据必须来自同一个帧快照。

## OEngine 专属 Tab

- Work：visibility、raster、shading 和 queue producer/consumer 证据。
- Graph：可搜索的 pass、资源读写、裁剪状态和 GPU timestamp。
- Memory：owner accounting、estimated GPU size、transient 与 budget 分栏。
- Diagnostics：validation、device lost、pending、dropped 和 sampling coverage。

## 验收

Record/Stop/Clear、Follow latest、Pin frame、异步 GPU 结果和跨 Tab 帧一致性必须通过浏览器自动化验证，并保存截图和控制台结果。

