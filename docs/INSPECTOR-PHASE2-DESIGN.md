# Performance Inspector Phase 2 设计

更新时间：2026-09-05

## 目标

完成性能证据的最小可回放闭环：在 Inspector 内启动/停止录制、捕获单帧、
导出 Capture/Chrome Trace，并把 Capture 导回同一视图进行选帧查看。回放只
替换 `InspectorViewModel` 的帧源，不写入 Renderer、FrameGraph 或 GPU 资源。

## 深模块与边界

```text
Inspector facade
  ├─ Capture codec (parse/serialize)
  ├─ InspectorViewModel (live frames | imported capture)
  └─ InspectorShell (actions + file input)
```

- `InspectorViewModel` 是回放 seam：维护单一可见帧源、模式和选择状态。
- `Inspector` 负责生命周期、capture codec 和浏览器下载适配；不向 Shell 暴露
  Renderer 私有对象。
- `InspectorShell` 只绑定按钮、文件选择和文本状态；所有外部文本使用
  `textContent`，导入错误不会改变渲染管线。

## 操作语义

- `Start` 清除当前回放并进入 `record`；`Stop` 等待 pending（默认 1 秒）后下载
  `oengine-capture.json`。
- `Capture` 进入 `deep-capture` 并在下一帧完成后下载单帧 Capture。
- `Export` 导出当前回放或实时历史；`Trace` 导出同一帧集合的 Chrome Trace。
- `Import` 通过既有 `parsePerformanceCapture` 校验 schema，再替换可见帧源；
  可继续使用 Timeline 的选帧和范围。
- `Clear` 清除实时历史和导入回放，恢复空历史。

## 明确不做

- 不新增 GPU readback、query、submit 或每帧 CPU 对象扫描。
- 不实现 Perfetto 上传、Console/Settings/Viewer 面板或跨页面云存储。
- 不把导入 Capture 写回 `FrameProfiler` 的生产历史；导入数据是只读回放。

## 完成判据

- Capture/Trace 操作在无 DOM 环境下仍不影响核心 profiler 生命周期。
- 导出→清空→导入后帧索引、模式和选帧可恢复；非法 Capture 被拒绝。
- OEngine 全量测试、构建和 Rendering Lab 示例构建通过。
