# Performance Inspector Phase 1 执行记录

执行日期：2026-09-05
设计依据：[INSPECTOR-PHASE1-DESIGN.md](./INSPECTOR-PHASE1-DESIGN.md)

## 执行内容

- 新增无 DOM 的 `InspectorLayoutModel`，提供默认布局、数值边界、版本化
  `localStorage` 持久化和订阅接口。
- Inspector Shell 增加 three.js 风格深色主题变量、模式/tab 激活态、状态
  badge、标题栏拖动、右下角 resize 和 Reset Layout 操作。
- Rendering Lab 保留外部“性能 Inspector”开关；Inspector 仍通过现有 facade
  使用共享 profiler，不改变 GPU producer/consumer 和提交路径。
- 文档入口和文档 allowlist 同步更新。

## 验证记录

- `OEngine npm run build`：通过。
- `OEngine npm test`：411/411 通过，包含布局模型与既有 Inspector 套件。
- `examples npm run build`：通过。
- Rendering Lab 浏览器截图：依赖可连接的 Codex Browser 会话；若会话不可用，
  记录为未运行，不以静态构建替代。

## 未纳入本阶段

Capture/Trace 操作区、Console/Settings/Viewer tab、Perfetto 闭环和固定 adapter
性能 A/B 属于后续阶段，不能在本记录中宣称已完成。
