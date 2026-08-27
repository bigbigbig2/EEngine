# World Runtime Context

## 职责

当前 World Runtime 只负责向 GPU Scene 提供静态/mostly-static 实例、Packed Instance Set，以及 transform/material/light 的显式 patch。完整 Gameplay/编辑层级不是当前性能主链的前提。

## 约束

- 大规模重复实例不得要求一对象一 `Node3D/Mesh`。
- bulk create/upload 是主路径；少量 transform/material/light 变化使用显式 patch。
- Renderer 不得全量遍历 World 构建最终可见列表。
- 高频 add/remove/reparent、完整 ECS 和通用卸载生命周期属于 deferred；GPU in-flight 资源安全仍然必须成立。
