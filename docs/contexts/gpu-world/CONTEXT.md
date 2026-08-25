# GPU Render World Context

## 职责

管理 Instance、Geometry、Cluster、Material、Light 等 GPU 常驻表，以及 stable handle、capacity、residency、增量上传和销毁。

## 约束

- 每张表只有一个 owner。
- Handle 不直接等于数组下标、JS 对象地址或裸 Buffer offset。
- 结构变化与字段变化使用不同更新路径。
- 所有引用可追溯到 Runtime Asset 和 Resident Resource。
- device lost 后必须能判定重建或失效。

