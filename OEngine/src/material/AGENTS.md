# Material 所有权

- 拥有设备无关 Standard PBR 参数、feature flags、材质身份和纹理引用。
- 不拥有逐帧全屏调度、GPU residency 或具体 BindGroup 生命周期。
- 主路径必须能编码到 MaterialTable，并由单次 Material Resolve 消费。
- 新材质 feature 需要说明 GBuffer/Surface 数据、纹理 residency、Shader variant 和 benchmark 影响。

