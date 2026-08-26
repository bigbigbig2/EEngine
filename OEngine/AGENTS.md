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
- 任何全屏 Pass、每材质循环或逐 mip Pass 都必须有 GPU 时间和替代方案对比。
- 新算法先加入计数器和 debug view，再宣称优化。

## 开源实现与基础库复用

- 新增渲染算法、数学函数、材质模型、资产处理、压缩、动画、ECS 或调试能力前，先检查 docs/references/GPU-DRIVEN-RESEARCH.md 和 docs/references/OPEN-SOURCE-REUSE.md。
- 优先使用许可证兼容且经过测试/benchmark 的成熟库或实现；C++/Rust/native 项目默认作为 Cooker、WASM/native tool 或 CPU reference，不把其线程模型、allocator、descriptor 或高级 GPU capability 直接带入 WebGPU runtime。
- 每次直接依赖、局部移植或按论文重实现都要记录 upstream URL、commit/tag、源码/测试路径、许可证、不变量、ABI/精度差异、WebGPU 改造、fallback 和本地回归。
- 数学和材质实现也必须对齐坐标系、矩阵布局、深度范围、切线空间、颜色空间、BRDF 和数值容差；短函数不能成为无验证重写的理由。
- 上游实现如果导致额外的 JS allocation、全量复制、固定全屏扫描、每材质 draw、CPU readback 或不可解释的 GPU 长尾，必须保留算法参考但拒绝其 runtime 结构。
- 只有完成许可证追踪、真实 producer/consumer、生命周期/overflow、正确性和性能验证后，才能删除当前实现或标记任务完成。

## 验证

```powershell
npm ci
npm run build
```

当前 `tests/` 尚未建立；新增高风险 ABI、数学、资产解析和 GPU producer/consumer 路径时必须同步补验证入口。

