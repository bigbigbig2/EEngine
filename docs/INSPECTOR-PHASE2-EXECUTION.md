# Inspector v2 Phase 2：执行记录

本文件用于记录实时 Timeline 录制阶段的实现与验收，不记录离线 Capture 或回放流程。

## 验收清单

- [x] `LiveProfilerStore` 使用有界环形历史，不在稳定帧执行无消费者的 readback。
- [x] Record/Stop/Clear 的状态转移可观察且不会停止 Renderer。
- [ ] Pin frame 后 Graph/Memory/Diagnostics 也读取同一个 `ProfileFrame` 的 domain evidence（当前版本先避免混入实时数据）。
- [x] GPU pending、dropped、not-sampled 与 unsupported 的文案和颜色可区分。
- [x] Rendering Lab Playwright 验收保存 Inspector 截图并检查控制台。
- [x] `cd OEngine; npm run build`、命中测试和文档静态检查全部通过。

## 备注

如果未来需要持久化记录，应另立产品决策；它不属于本阶段的实时 Inspector 主流程。
