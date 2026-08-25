# World Runtime Context

## 职责

Application World 表达对象身份、层级、Gameplay/编辑状态、动画意图和 Packed Instance Set，通过 Change Set 向 GPU Render World 提交变化。

## 约束

- World Object 与 GPU handle 不等同。
- 大规模重复实例不得要求一对象一 `Node3D/Mesh`。
- add/remove/reparent/transform/material/light 必须产生显式变化记录。
- Renderer 不得全量遍历 World 构建最终可见列表。

