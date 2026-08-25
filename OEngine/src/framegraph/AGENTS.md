# FrameGraph 所有权

- 拥有 Pass 依赖、资源生命周期、裁剪、复用和命令编码编排。
- 不决定 LOD、材质模型或光照算法。
- Pass 必须完整声明 read/write/create/import；旁路命令必须有明确理由并逐步消除。
- feature set 与尺寸不变时应缓存图编译结果，不默认每帧重建完整拓扑。
- 主帧目标是一个主要 CommandEncoder/submit；readback 和调试采样必须显式。

