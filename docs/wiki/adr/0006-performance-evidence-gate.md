# ADR-0006 · 性能证据是架构门槛

Status: accepted

## 背景

旧文档大量使用静态源码推断，并在没有同机同画质 benchmark 时保护现有 reconstructed 架构。用户实测已证明 OEngine 显著慢于两个 three.js compute rasterizer 示例。

## 决策

现有实现不享有保留优先权。Visibility、HZB、Material Expand、FrameGraph 和提交方式都可被性能与正确性证据推翻。

## 后果

- three.js A/B 对齐 benchmark 是长期回归基线。
- “功能更多”“更通用”“GPU-driven”不能替代分段数据。
- 架构优化必须说明减少了哪一种工作及其他场景退化。

## 验证

所有性能 PR/Issue 使用 `docs/PERFORMANCE.md` 的数据字段和对齐条件。
