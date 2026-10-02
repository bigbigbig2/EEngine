# SurfaceWork Runtime V3 Phase 7 验证记录

日期：2026-10-02。目标：GTX 1650 Ti、1080p、复杂场景。该记录只报告本轮实际执行，不提升性能或画质 claim。

已通过：

- `OEngine`: `npm run typecheck`
- `OEngine`: `npm run build`
- `OEngine`: `npm run build:test`
- `OEngine`: `npm run audit:shaders`
- `git diff --check`

未通过或未完成：

- 旧 `tests/contract/appearance-publication.test.mjs` 的 5 个用例仍假设已删除的 scalar coverage/task ABI；失败原因是测试与 V3 新 publication 边界不一致，不恢复旧实现。
- `tests/contract/frame-program.test.mjs` 的 1 个 lowering 用例 owner mock 没有新 SurfaceWork 绑定所需的真实 frame-attributes shape；该旧 fixture 不能证明新主链运行失败或通过。
- 未运行浏览器整帧、GPU shader oracle、连续画质、camera cut/resize/device loss 矩阵、NVIDIA 传感器采样和四版本 P50/P95 对比，因此没有性能结论。

当前实现状态：唯一 SurfaceWork 生产接线、真实 GeometryRecord 属性发布、前置 cache lookup/miss queue、完整 `AppearanceResidentKernel` miss evaluator、cluster/VSM/AO/authored+physical IBL provider、独立 diffuse/specular/coat/IBL packets、双缓冲 signal history 和 TemporalFacts/pre-exposure reconstruct 已接线。GeometryRecord hit mask 尚未绕过 geometry heavy work，sampler/UV/filtered-footprint identity、Product/skin/morph/previous deformation、signal age/revision reject、浏览器画质和正式覆盖率/性能仍未完成；本记录不作性能通过声明。
