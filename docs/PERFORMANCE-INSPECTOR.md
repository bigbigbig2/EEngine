# OEngine Inspector v2：实时 Profiler 与 Timeline

## 产品结论

Inspector v2 是实时工具，不是离线 Capture Viewer。主流程只有 Monitor、Record 和 High detail：Record 只把最近一段 Timeline 保存在内存环形缓冲中，High detail 只在实时模式开启更密集的 timestamp/counter。

不提供 Capture Import、Capture Replay、Trace 导入或单帧 Capture 按钮。未来若需要持久化记录，必须另立产品决策。

实时 Inspector 也不从 `OEngine/src/index.ts` 暴露 Capture/Chrome Trace 编解码器；仓库中的 codec 仅保留给现有内部 benchmark/test，不属于 Inspector 运行时路径。

## 参考边界

three.js revision [`c4ffe022`](https://github.com/mrdoob/three.js/tree/c4ffe022f2a4f982b42b7da5af79a87066a138ae/examples/jsm/inspector) 作为 MIT 许可下的交互参考：Dock、浮动开关、Tab Registry、Performance 层级树、Memory 列表和 Timeline Record/Clear。OEngine 只做可追溯的本地交互移植，不引入 three.js runtime 对象。

采用的参考文件：[`Profiler.js`](https://raw.githubusercontent.com/mrdoob/three.js/c4ffe022f2a4f982b42b7da5af79a87066a138ae/examples/jsm/inspector/ui/Profiler.js)、[`Performance.js`](https://raw.githubusercontent.com/mrdoob/three.js/c4ffe022f2a4f982b42b7da5af79a87066a138ae/examples/jsm/inspector/tabs/Performance.js)、[`Timeline.js`](https://raw.githubusercontent.com/mrdoob/three.js/c4ffe022f2a4f982b42b7da5af79a87066a138ae/examples/jsm/inspector/tabs/Timeline.js)、[`Memory.js`](https://raw.githubusercontent.com/mrdoob/three.js/c4ffe022f2a4f982b42b7da5af79a87066a138ae/examples/jsm/inspector/tabs/Memory.js)。

## 模块 seam

```text
Renderer / GPU owners
        -> ProfilerEvidenceSource
        -> LiveProfilerStore
        -> ProfilerViewModel
        -> ProfilerShell
           Performance | Timeline | Work | Graph | Memory | Diagnostics
```

`LiveProfilerStore` 是深模块：它拥有有界历史、录制状态、选帧、Follow latest、异步 GPU patch、coverage、pending 和 dropped 语义。UI 不直接读取 Renderer 或 GPU owner。

## 实时状态

- `Follow latest`：视图跟随最新帧。
- `Pin frame`：选择某帧后固定所有 Tab 的数据源。
- `Record` / `Stop`：只控制内存中的 Timeline 窗口，不停止 Renderer。
- `Clear`：清理历史帧和选帧状态。
- `Pause` 若保留，只能冻结视图，不能伪装成停止渲染。

## 帧合同

每帧使用 `{ epoch, frameIndex }` 标识，并携带 CPU spans、GPU spans、GPU counters、队列 current/capacity/peak/overflow、FrameGraph、资源 accounting、estimated size、validation、device lost、pending、dropped 和 sampling coverage。

历史帧的所有面板必须读取同一个 `ProfileFrame` 快照，禁止把旧 Timeline 与当前 Renderer 状态拼接展示。

## 数据准确性规则

1. CPU wall time、GPU pass sum 和 GPU frame total 分开显示；没有时钟映射时不计算 `CPU + GPU`。
2. 所有 ratio 只能在相同单位和相同 producer/consumer 语义之间计算。
3. GPU counter 缺失显示 `not-sampled`、`pending`、`dropped` 或 `unsupported`，不显示伪造零。
4. RAF 频率标记为 `RAF FPS`，不称为 Presented FPS；浮动开关显示四舍五入后的整数 FPS，底层序列仍保留小数精度。
5. owner accounting、estimated GPU size 和真实物理显存必须分栏显示。
6. 指标 descriptor 必须声明 unit、source、measurement、scope、aggregation 和 cost。

## OEngine 专属 Tab

### Performance

层级树展示 CPU frame、GPU pass sum、Visibility、Raster、Surface/Material、Lighting、Temporal 和 Idle。列使用 `CPU | GPU | Coverage | Budget`，不使用误导性的 Total。

### Timeline

展示 CPU lane、GPU lane、FrameGraph pass lane、帧选择器和当前帧详情。Record/Stop/Clear 只操作内存环形缓冲，默认容量 512 帧。

### Work

展示 candidate/visible instances、BVH nodes、candidate/selected/hardware clusters、shaded pixels、RasterWork 和所有有 ABI 合同的 queue。

### Graph

支持 Pass 搜索、资源读写、schedule index、pruned/active 状态、GPU timestamp 和选中 Pass 详情。

### Memory

展示 Category、Owner、Count、Accounted Size、Estimated GPU Size 和 Budget，明确 transient、staging、runtime asset 与 GPU owner。

### Diagnostics

展示 GPU validation、device lost、timestamp/counter failure、pending/dropped、metric coverage 和 Inspector overhead，并在 Shell 顶部显示错误/警告徽标。

## 性能合同

- Inspector 未打开且 profiler 关闭时，不创建 DOM、GPU query、counter buffer、readback 或额外 submit。
- Monitor 模式使用低频 timestamp/counter；High detail 必须显式显示额外开销。
- Timeline 历史为有界 ring，不能因为 UI 录制无限增长。
- GPU 结果异步回填其来源帧，不能阻塞正常提交等待 `queue.onSubmittedWorkDone()`。

## 分阶段交付

1. **已完成** Phase 1：Profiler Shell、Monitor/Record/High detail、Follow latest、面板切换和状态合同。
2. **已完成** Phase 2：LiveProfilerStore、实时 Timeline Record/Stop/Clear、统一 ProfileFrame。
3. **已完成基线** Phase 3：Performance、Timeline、Work、Graph、Memory、Diagnostics 已迁移；后续只增加更多 OEngine 证据。
4. **已完成基线** Phase 4：Rendering Lab Playwright 验收、GPU counter/coverage 证据、Inspector 公共路径移除 Capture/Trace；内部 codec 仅供 benchmark/test 使用。

设计与执行记录：
