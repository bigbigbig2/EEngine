# R2-A-01 · Bevy Meshlet hierarchy 参考登记

## Reference

- Reference ID：`R2-A-01-BEVY-MESHLET`
- upstream project：Bevy
- repository URL：https://github.com/bevyengine/bevy
- locked tag：`v0.18.0`
- locked commit：`5f8270f2e049f90139a503d1e930070d926f9427`
- verified on：2026-08-27
- license：MIT OR Apache-2.0；OEngine 若局部移植选择 MIT，并保留 `LICENSE-MIT` notice 与源码归属
- maturity：生产级游戏引擎中的实验/可选 Meshlet renderer；不能据此推定 OEngine 性能收益

## 源码与测试入口

- hierarchy/Cooker：`crates/bevy_pbr/src/meshlet/from_mesh.rs`
- serialized/runtime records：`crates/bevy_pbr/src/meshlet/asset.rs`
- module/capability boundary：`crates/bevy_pbr/src/meshlet/mod.rs`
- residency manager 对照：`crates/bevy_pbr/src/meshlet/meshlet_mesh_manager.rs`

固定 commit 的上述路径及 `LICENSE-MIT`、`LICENSE-APACHE` 已通过 raw source 核验。R2-B 实现前还需定位命中的内嵌 unit tests/Bevy example，并把具体函数级来源补入移植记录；本任务不复制 Rust 实现。

## 算法范围与 ABI

- 参考范围：Meshlet grouping、可绘制父级简化、LOD error propagation、BVH build、reachability 和 CPU validator。
- 不采用：Bevy Renderer/ECS、native backend resource binding、64 位原子、subgroup 或平台 feature policy。
- 输入：OEngine `SourceGeometry` 与固定 `GeometryCookRecipe`。
- 输出：OEngine strict runtime tree、Cluster records、BVH8 payload 和 CPU reference data；不直接序列化 Rust struct。

## 保留不变量

- 父级具有可 raster 的简化表示；
- 父/子选择互斥，树无 cycle/multi-parent/orphan；
- parent geometric error 不小于 child；
- decoded spatial bounds 保守；
- hierarchy depth、root reachability 和 fallback 可验证。

## OEngine/WebGPU 适配

- Cooker 可以按固定 Rust 实现做局部移植或 CPU oracle，但 package 只保存 WebGPU 可表达的 `u32` record/range；
- v1 recipe 的 `hierarchyTargetFanout = 8` 对齐 `TARGET_MESHLETS_PER_GROUP`，`simplificationFailureRatio = 0.60` 对齐 `SIMPLIFICATION_FAILURE_PERCENTAGE`；simplify 使用 0.5 target 与 absolute error mode。以上只冻结输入与验证语义，R2-B 函数级移植仍需补 provenance；
- BVH8 与 LOD tree 保持不同记录；不引入 streaming page；
- R2 只生成/验证/驻留数据，R3 才实现 WGSL traversal；
- 任何并行任务/allocator 抽象不迁入浏览器 runtime。

## 性能假设与验证

- 假设：可绘制 hierarchy 与 BVH8 让 R3 在 flat Meshlet expand 前减少候选；
- R2-B 只验证 Cook time、bytes、node/depth/error 和 CPU selected set；
- R3 使用相同场景比较 flat/hierarchy 的 visited/selected/raster 工作与 GPU timestamp；层次基础开销更高时允许禁用但必须共享 flat fallback。

## Fallback / failure

- hierarchy/error 无法证明：输出 single-level geometry；
- BVH8 量化不保守：使用未量化 bounds；
- 许可证或函数级 provenance 不完整：只做概念/测试对照，不复制表达性源码；
- native capability 不可映射 WebGPU：拒绝对应 runtime 设计，不影响 Cooker 数据验证。

## 本地验证与决定

- R2-A：只锁定 source/license/ABI 边界；
- R2-B：CPU selector、cycle/reachability/error/bounds property tests 与黄金 package；
- decision：`port` 候选，须在 R2-B-02/03 完成函数级 provenance 后才允许移植；
- reason：复用 hierarchy/BVH/error 的成熟不变量和负面经验，同时拒绝 Bevy 的 ECS/backend/capability 结构进入 OEngine。

## R2-B-02/03 函数级补充（2026-08-27）

固定源码再次按 tag `v0.18.0` / commit
`5f8270f2e049f90139a503d1e930070d926f9427` 核对：

- `crates/bevy_pbr/src/meshlet/from_mesh.rs` SHA-256：`a7253d45c819cdc8aaf014a1a60152bf25cedff8f9cac38e6e347ff598dfc68b`；
- `crates/bevy_pbr/src/meshlet/asset.rs` SHA-256：`c536fab4cdd24769df2e3b934d86e28286cd5cd64d972979d4ffee0f51946b05`；
- `LICENSE-MIT` SHA-256：`508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1`。

命中的上游函数/区段：

| 固定源码区段 | 采用的不变量 | OEngine 适配 |
|---|---|---|
| `from_mesh.rs:101-123` | shared-vertex adjacency、分组和 group border lock | 确定性 shared-vertex 贪心/BFS；不引入 rayon/METIS owner |
| `from_mesh.rs:136-164` | 约 50% simplify、失败判定、parent error ≥ child | 直接调用登记的 meshoptimizer simplifier；`LockBorder + Sparse + ErrorAbsolute`；失败写入可绘制 aggregation parent 与 warning |
| `from_mesh.rs:440-483` | 按 shared vertex grouping、目标 fanout 8 | 保留 fanout 8；用稳定 index tie-break 替代 native METIS partition |
| `from_mesh.rs:521-564` | absolute error、sparse simplify、0.60 failure ratio | 参数进入 `GeometryCookRecipe` identity；不在 runtime 修改 |
| `from_mesh.rs:792-860` | BVH8 平衡分裂与 SAH 排序 | 确定性三轴 surface-area cost + balanced 8-way；输出 WebGPU `u32` refs/ranges 和未量化 `vec4` bounds |
| `from_mesh.rs:991-1033` | error/sphere 单调、reachability validation | 最终 package reopen 后检查 cycle/multi-parent/orphan、error/bounds monotonic 与 leaf ownership |

采用状态从候选更新为 `traceable local port`。OEngine 没有翻译 Rust
类型、控制流或表达性实现；只移植上述算法不变量和测试策略，并重新实现为
TypeScript 深接口。许可证按 MIT 路径记录。

BVH8 v1 刻意不采用相对 parent 量化：当前 recipe 固定
`quantizeBvhBounds=false / bvhQuantizationBits=0`。352 B node 使用 8 个
`u32` ref、8 个 Cluster range count、valid/leaf mask 与 8 组 16-byte-aligned
`vec4` min/max；leaf 当前 range count 为 1，但 ABI 不使用裸地址。量化只有在
后续同条件 bytes/decode benchmark 且 conservative property tests 通过后才能改变
recipe/schema identity。

本地定向验证覆盖：可绘制 root fallback、parent/child selector 互斥、capacity
fallback、cycle/multi-parent/orphan/non-monotonic error、平面/线/点状/极端尺度
BVH bounds、BVH cycle 与非保守 decoded bounds。真正的 GPU traversal 与
flat-vs-hierarchy counter 属于 R3，R2-B 不声称 GPU 性能收益。
