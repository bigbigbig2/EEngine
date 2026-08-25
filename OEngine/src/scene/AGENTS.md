# Scene / Application World 所有权

- 拥有对象身份、层级、变换、Mesh/Light 注册和 Change Set。
- 不拥有 GPU Buffer、resident handle offset、Pass 或可见列表。
- add/remove/reparent/transform/material/light 变化必须产生确定性增量语义。
- 大规模重复实例通过 Packed Instance Set seam 表达，不扩张一实例一对象路径。

