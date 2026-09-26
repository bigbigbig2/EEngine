# OEngine 实现约束

## 职责

`OEngine` 拥有引擎运行时库、WebGPU 后端、GPU Render World、渲染管线与运行时资产加载。

## 依赖方向

```text
core
  ↑
scene / camera / light / animation / geometry / material / texture
  ↑
loaders

core + runtime assets
  ↑
gpu
  ↑
framegraph + render + shaders
  ↑
src/index.ts
```

- CPU 领域模块不得依赖 `render/passes`。
- Loader 不得创建长期 GPU owner。
- Pass 不得直接修改 Application World。
- `Renderer` 是 composition root，不继续吸收算法实现。

## Public interface

- 公开能力由 `src/index.ts` 导出。
- 新公开类型必须说明生命周期、错误模式和性能特征。
- GPU 表布局、内部 Buffer、Pass 和 Shader 变体默认保持内部。

## 性能纪律

- 稳定帧不得无条件 readback、创建临时 command encoder 或提交空命令。
- 相同 feature set 和尺寸应复用已编译 FrameGraph/Pipeline/BindGroup。
- 全屏 Pass、每材质循环与逐 mip Pass 应记录预期成本和替代方案；真实 GPU 时间与正式对比在整链性能验收时集中测量，不阻止模块编码。
- 新算法先加入计数器和 debug view，再宣称优化。

## 开源实现与基础库复用

- 新增渲染算法、数学函数、材质模型、资产处理、压缩或调试能力前，先检查 `docs/porting/` 的当前来源和采用边界。
- 优先使用许可证兼容且经过测试/benchmark 的成熟库或实现；C++/Rust/native 项目默认作为 Cooker、WASM/native tool 或 CPU reference，不把其线程模型、allocator、descriptor 或高级 GPU capability 直接带入 WebGPU runtime。
- 复杂算法选择 donor 时固定 upstream URL、commit/tag、许可证与源入口；完整源函数/阶段映射和本地回归可在该大模块收口时集中记录，不要求每个中间修改批次同步文档。
- Next 重构先查 `docs/porting/next-renderer.md`，遵循 `docs/porting/README.md` 的完整算法 profile 迁移规则；不能为省事删掉关键阶段、条件、历史/失效或边界处理后仍称完整移植。WebGPU 执行模型适配与算法行为变化必须区分，后者明确记录并确认调整方向。
- 数学和材质实现也必须对齐坐标系、矩阵布局、深度范围、切线空间、颜色空间、BRDF 和数值容差；短函数不能成为无验证重写的理由。
- 上游实现如果导致额外的 JS allocation、全量复制、固定全屏扫描、每材质 draw、CPU readback 或不可解释的 GPU 长尾，必须保留算法参考但拒绝其 runtime 结构。
- ADR-0020 明确列入 Clean-Cut 的旧 owner 可在替代算法尚未完成时删除；同批撤销或重写失效的 claim/check，并把真实删除的路径加入 retired-path guard。删除旧实现不代表新算法完成。
- 新的上游算法移植须完成许可证与源函数映射、真实 GPU producer/consumer 和生命周期；模块收口运行 typecheck、build 与必要的 targeted tests。正式质量、性能证据和 claim 晋级留到 Next Renderer 最终验收，不能提前宣称这些等级。

## 验证

- 普通 DEV 在 dependency/lockfile 未变化时不运行 `npm ci`；TypeScript/WGSL 改动可按调试需要运行 typecheck 和 targeted tests，大模块完成时集中检查。
- dependency/lockfile 变化、clean reproduction、CI 或正式 PERF 前运行 `npm ci`。
- `examples/` 不承担 Browser Case 或 formal runner；`npm test` 不能替代真实 GPU 证据。渲染改动必须由 ADR-0014 的独立 `validation/` 宿主产生合格证据，才可升级为 Runtime Validated、Performance Evaluated/Improved、Pipeline Feature Complete 或 ADR Complete。
- MILESTONE 与正式 PERF 必须使用 ADR-0014 的真实浏览器宿主，并遵循 `docs/VALIDATION.md` 的 fixed-condition policy。

现有 `tests/unit|contract|oracle|guard/` 覆盖关键公共 seam；新增高风险 ABI、数学、资产解析和 GPU producer/consumer 路径时，在大模块收口阶段补必要的 targeted coverage。Browser Case 留到 Next Renderer 最终验收。
