# GPU Render World 所有权

- 拥有 GPU-resident tables、稳定 handle、allocator、cache、resident resource 和增量同步。
- 不拥有 Application World 语义或具体渲染效果顺序。
- 每个 Buffer/Table 必须有唯一 owner、销毁路径、容量与溢出策略。
- `GraphicsContext.update()` 稳定帧不得无条件 submit/readback。
- GPU Scene 的结构变化和字段变化必须区分；单对象变化不得退化为全量 rebuild。

