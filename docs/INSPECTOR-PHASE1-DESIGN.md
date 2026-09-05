# Performance Inspector Phase 1 设计

更新时间：2026-09-05

## 目标

将 OEngine Performance Inspector 从“可用的证据面板”提升为接近 three.js
Inspector 的浮动调试工具，同时保持 OEngine 的 GPU-first 数据合同和统一
Renderer 管线不变。本阶段只改变 Inspector 的交互外壳、布局状态和可见性，
不复制 three.js 的对象树、材质编辑或 Renderer 内部实现。

three.js Inspector 的参考点是浮动 toggle、标签式 profiler、深色主题、布局
对齐和用户状态持久化；参考实现见 [Inspector.js](https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/inspector/Inspector.js)
和 [Style.js](https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/inspector/ui/Style.js)。

## 范围

- 浮动 Inspector 按钮保持可发现，并显示当前模式、帧数和采样状态。
- 面板标题栏可拖动，右下角可调整大小；窗口尺寸和位置按版本持久化。
- Live/Record/Deep Capture 与 Overview/Timeline/领域 tab 显示明确的激活状态。
- Shadow DOM 样式使用变量化深色主题，避免污染宿主页面。
- 小屏幕自动限制窗口尺寸，不能遮挡整个 Rendering Lab 控制区。
- 保留现有 Overview、Timeline、GPU-driven、FrameGraph、Resources、Diagnostics
  数据语义；不新增 Renderer 全量扫描、readback 或独立 submit。

## 模块接口

```text
Inspector
  ├─ InspectorViewModel       帧、模式、选择状态
  ├─ InspectorLayoutModel     位置、尺寸、持久化
  ├─ InspectorShell            DOM/Shadow DOM 交互适配器
  └─ domain snapshot adapter   OEngine 领域证据
```

`InspectorLayoutModel` 是无 DOM 的深模块，负责默认值、边界校验、版本化存储
和变更通知；Shell 只负责 pointer event 与样式映射。布局状态不是渲染状态，
不会写入 Renderer、FrameGraph 或 GPU 资源。

## 明确不做

- three.js Object Viewer、Scene Tree、任意对象属性编辑。
- 材质实时修改、Gameplay/ECS 生命周期浏览。
- 全局 console 劫持或由 UI 触发的额外 GPU readback。
- 将 three.js 表达性源码直接复制到 OEngine。

## 完成判据

- Rendering Lab 可在保留场景控制的同时打开/关闭 Inspector。
- Inspector 可以拖动、缩放、刷新后恢复布局，并在小屏幕保持可操作。
- 当前 tab、采样模式和 unsupported/pending 状态可从视觉上识别。
- 布局模型有独立纯测试；OEngine 和 examples 构建通过。
