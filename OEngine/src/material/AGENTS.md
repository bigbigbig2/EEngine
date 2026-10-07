# Material 所有权

- 拥有设备无关 Standard PBR 参数、feature flags、材质身份和纹理引用。
- 不拥有逐帧全屏调度、GPU residency 或具体 BindGroup 生命周期。
- 材质目标服从根 V4 authority：图编译为 native GPU code，实例参数与 Program 分离；保留真实 dependency/frequency/CSE/DCE/C/X/Y 与采样数学，不以 General VM 或全局 Closure Cache 统一生产执行。当前源码事实和目标分开。
- 新材质 feature 需要说明 GBuffer/Surface 数据、纹理 residency、Shader variant 和 benchmark 影响。
