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
