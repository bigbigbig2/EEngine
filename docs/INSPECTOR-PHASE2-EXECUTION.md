# Inspector v2 Phase 2：执行记录

本文件用于记录实时 Timeline 录制阶段的实现与验收，不记录离线 Capture 或回放流程。

## 验收清单

- [x] `LiveProfilerStore` 使用有界环形历史，不在稳定帧执行无消费者的 readback。
- [x] Record/Stop/Clear 的状态转移可观察且不会停止 Renderer。
- [x] Pin frame 后 Graph/Memory 读取该帧保存的 domain evidence；Diagnostics 明确标注为 session cumulative，帧级 coverage/pending 仍读取选中 `ProfileFrame`。
- [x] GPU pending、dropped、not-sampled 与 unsupported 的文案和颜色可区分。
- [x] Rendering Lab Playwright 验收保存 Inspector 截图并检查控制台。
- [x] `cd OEngine; npm run build`、命中测试和文档静态检查全部通过。

## 备注

如果未来需要持久化记录，应另立产品决策；它不属于本阶段的实时 Inspector 主流程。
