# Core 所有权

- 拥有基础集合、数学、信号、内存工具、CPU/WGSL ABI 描述和 WebGPU 公共类型。
- 不依赖 Scene、GPU manager、FrameGraph、Renderer 或具体 Shader Pass。
- ABI/packing 工具必须可在无 GPU 环境测试。
- 数学坐标、矩阵布局、深度约定和 hash/equality 变更必须有明确回归。

