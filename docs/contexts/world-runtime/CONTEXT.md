# World Runtime Context

## 职责

当前 World Runtime 只负责向 GPU Scene 提供静态/mostly-static 实例、Packed Instance Set，以及 transform/material 的显式 patch。Light 继续由现有独立 owner 管理，等后续 Lighting 阶段收口；完整 Gameplay/编辑层级不是当前性能主链的前提。

## 约束

- 大规模重复实例不得要求一对象一 `Node3D/Mesh`。
- bulk create/upload 是主路径；少量 transform/material 变化使用显式 range/batch patch。
- Renderer 不得全量遍历 World 构建最终可见列表。
- 高频 add/remove/reparent、完整 ECS 和通用卸载生命周期属于 deferred；GPU in-flight 资源安全仍然必须成立。
- 普通 `Scene/Node3D/Mesh` 只是写入相同 Instance table 的 adapter；Packed source 不创建等量 JS 对象。

## 当前状态

- `InstanceSource` 已冻结为 structure-of-arrays：geometry handle dictionary + per-instance geometry/material indices、current/previous transform、bounds、flags 和 debug ID。
- `createInstanceSourceFromScene()` 是普通对象场景的一次性 adapter；相同 geometry handle 去重，输出 typed arrays，不创建 replacement `Mesh/Node3D`。
- Packed 1k/10k/100k、0/1/10/100% transform/material patch 与 stable no-op 已通过 Node 和真实 WebGPU 纵切。生产 A/C fixture 仍需停止构造等量 `Mesh`，这是 R2-D 最后迁移点。
