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

## 验证

```powershell
npm ci
npm run build
```

当前 `tests/` 尚未建立；新增高风险 ABI、数学、资产解析和 GPU producer/consumer 路径时必须同步补验证入口。

