# Performance Inspector

Inspector 是 OEngine 的实时 Profiler 与有界 Timeline，不是离线 Capture Viewer。公共交互只有 Monitor、Record 和 High detail；内部 capture/trace codec 只服务 benchmark 与测试，不从公共入口暴露。

## 数据流

```text
Renderer / GPU owners
  → ProfilerEvidenceSource
  → LiveProfilerStore
  → InspectorViewModel
  → InspectorShell
     Performance | Timeline | Work | Graph | Memory | Diagnostics
```

`LiveProfilerStore` 拥有有界历史、录制状态、选帧、Follow latest、异步 GPU patch、coverage、pending 和 dropped 语义。所有面板读取同一个 `ProfileFrame` 快照，不直接拼接 Renderer 当前状态。

## 运行合同

- Inspector 未打开且 profiler 关闭时，不创建 DOM、GPU query、counter buffer、readback 或额外 submit。
- Monitor 使用低频 timestamp/counter；High detail 明确承担更高采样开销。
- Record 只控制内存中的有界 Timeline，不停止 Renderer；Clear 清除历史和选帧状态。
- GPU 结果异步回填来源帧，不阻塞主提交等待队列完成。
- unsupported、pending、dropped 和 failed 必须保持不同状态；缺失样本不能显示为 0。

UI shell 的 three.js 参考来源、revision、许可证和 OEngine 差异登记在 [`docs/porting/platform.md`](../../../../docs/porting/platform.md)。Rendering Lab 的使用入口见 [`examples/rendering-lab/README.md`](../../../../examples/rendering-lab/README.md)。
