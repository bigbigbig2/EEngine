# Material 所有权

- 拥有设备无关 Standard PBR 参数、feature flags、材质身份和纹理引用。
- 不拥有逐帧全屏调度、GPU residency 或具体 BindGroup 生命周期。
- 主路径编译并发布到现有 Material/Appearance 体系；按第三版设计区分 constant/static、stable local cache 与 dynamic/view/nonlocal signal，cache lookup 在 miss compact 前，hit 不进入重材质 worker，不要求每像素执行一次 Material Resolve。
- 新材质 feature 需要说明 GBuffer/Surface 数据、纹理 residency、Shader variant 和 benchmark 影响。
