# Inspector v2 Phase 1：执行记录

## 已完成

- 从 Inspector Shell 移除 Capture、Trace、Import 和单帧 Capture 按钮。
- 将 Live/Deep capture 文案改为 Monitor/High detail。
- 增加 Follow latest 状态，并把选帧行为改为自动 Pin frame。
- 修复 Inspector 面板隐藏规则，避免 Overview 样式覆盖其他 Tab。
- Pause 只冻结 Inspector 视图，不停止 Renderer 产生实时帧。
- 构建通过：`cd OEngine; npm run build`。

## 当前验证

- `cd OEngine; npm test`：410 个测试通过；3 个文档系统测试因缺少本阶段文档而失败，文档补齐后应重新运行。
- 浏览器验收待 Phase 2 的实时 Timeline 接线完成后执行。

## 后续

下一阶段建立 `LiveProfilerStore`，统一历史帧、录制状态、选中帧和所有领域证据，彻底避免历史 Timeline 与当前 Renderer 状态混用。

