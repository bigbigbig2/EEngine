# GPU Scene / Tables Context

## 职责

长期管理 Instance、Geometry、Cluster、Material、Texture、Light 等紧凑 GPU 数据，以及 stable handle、capacity、bulk upload、字段 patch 和 resident bytes。R2 当前只冻结 Geometry、Cluster、Instance 三张必需 record table；Material 解析现有 registry handle，Texture/Light 全面重构后移。

## 约束

- 每张表只有一个 owner。
- Handle 不直接等于数组下标、JS 对象地址或裸 Buffer offset。
- 当前优化 mostly-static bulk upload；结构变化与 transform/material 字段 patch 使用不同路径。
- 所有引用可追溯到 Runtime Asset 和 Resident Resource。
- 不建设完整动态对象生命周期，但 grow/replace/destroy 必须等待正确的 GPU completion。
- texture residency 可以后加；geometry streaming 不进入当前主路线。
- R2 的 hierarchy 数据由 Cooker 生成并驻留；每帧 GPU traversal/SSE/work queue 属于 R3。
