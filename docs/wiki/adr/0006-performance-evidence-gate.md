# ADR-0006 · 性能证据是架构门槛

Status: accepted

## 背景

旧文档大量使用静态源码推断，并在没有同机同画质 benchmark 时保护现有 reconstructed 架构。用户实测已证明 OEngine 显著慢于两个 three.js compute rasterizer 示例。

## 决策

现有实现不享有保留优先权。Visibility、HZB、Material Expand、FrameGraph 和提交方式都可被性能与正确性证据推翻。

两个 three.js compute rasterizer 示例被定义为最低垂直功能与性能基线，而不是 OEngine 的产品范围或完成上限。A/B 必须覆盖 GPU LOD、work generation、SW/HW Visibility 和 PBR/IBL；通过 A/B 后仍必须以 C 和通用 vertical/lifecycle cases 验证多资产、动态世界、完整效果、生命周期和扩展性。所有基线共享一条 OEngine 主管线。

## 后果

- three.js A/B 对齐 benchmark 是长期回归基线。
- A/B 通过只证明最低闭环不落后，不能作为 OEngine 完成声明。
- C 的扩展性、效果和生命周期门禁不能被 A/B 的单场景性能数字替代。
- “功能更多”“更通用”“GPU-driven”不能替代分段数据。
- 架构优化必须说明减少了哪一种工作及其他场景退化。

## 验证

所有性能 PR/Issue 使用 `docs/PERFORMANCE.md` 的数据字段和对齐条件。
