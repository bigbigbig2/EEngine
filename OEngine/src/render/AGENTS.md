# Render 所有权

- 拥有 View、RenderTargets、统一主管线及 Pass 编排。
- 主管线是单一架构，功能按依赖启停；禁止复制成三档独立管线。
- Visibility 工作生成、软/硬光栅和材质解析必须共享稳定 VisibilityKey 契约。
- 不得以每材质全屏扫描作为长期通用材质路径。
- HZB 构建次数、全屏附件带宽、second-chance 和后处理固定成本必须可观测、可关闭。
- `Renderer` 只负责所有权与编排，算法下沉到相应 module。

