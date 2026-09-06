# Inspector v2 Phase 1：实时 Profiler 外壳与状态合同

本阶段把 Inspector 定义为实时工具，而不是离线数据查看器。目标是建立 three.js 风格的 Profiler Shell，并为 OEngine 的实时证据提供稳定 seam。

## 范围

- Monitor、Record、High detail 三种实时采样状态。
- Follow latest 与 Pin frame 两种查看语义。
- 底部/右侧 Dock、浮动开关、最大化、调整尺寸和布局持久化。
- Performance、Timeline、Work、Graph、Memory、Diagnostics Tab Registry。
- 所有 Tab 从同一个实时 `ProfileFrame` 快照读取数据。

## 非目标

本阶段不设计 Capture 文件、离线回放、Trace 导入或独立 Viewer。Timeline 只保留内存中的有限帧历史。

## 数据原则

CPU wall time、GPU pass sum 和 GPU counter 保持独立时钟域。缺失数据使用 `pending`、`not-sampled` 或 `not-applicable` 等明确状态，不以零或 unsupported 冒充真实值。

## 参考来源

three.js Inspector 的 Dock、Tab 和 Profiler 交互作为 MIT 许可下的可追溯参考；OEngine 只迁移交互范式，不引入 three.js runtime 对象。

