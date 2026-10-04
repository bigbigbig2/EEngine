# Surface V3 Phase 2：Geometry owner 与 bounded setup 实施记录

日期：2026-10-04。入口：[执行计划 §5](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)、[设计 §7、§13](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)。Phase 1 提交为 d07bfa61/03bdd8c；本阶段提交后停止，不进入 Phase 3。

## 实际切换

SurfaceCellGeometrySetup 现在按完整 bounded target 预留 local setup capacity；mandatory local setup 与 frame memo 使用不同物理 buffer/账目。生产 batch 用 `target × 1280B` 的真实 setup/address 预算协商容量，避免旧 `target × 128B` 预算把 setup 压缩到容量不足后再回退解码。memo 物理入口按二次幂容量和 generation 预留，miss/full 不改变 local correctness；本阶段不让未完成的 memo admission 参与主链调度，实际 Candidate/ValueWitness admission 前移到 Phase 3。memo 字节单独计入 `totalReservedBytes`，不从 mandatory local pool 借空间。

tile 内 winner request 改为固定 64-key bitonic compare/exchange 网络：key 与 lane 成对排序，相等 key 按 lane 稳定排序；run leader 才触发 bounded dictionary reservation，prefix propagation 将 slot 传给整段。没有前序 member 搜索。空 lane、相等 key、dictionary overflow 都有确定状态；setup indirect 只来自 GPU count。

setup producer 完整写入 `CellGeometrySetup`；memo storage 由同一 Geometry owner 分配、generation-scoped 并保持独立，实际 admission 留给 Phase 3。所有 facts、address、certificate 和 GeometryRecord consumer 只能读取合法 SetupRef；`cell_ensure_direct_geometry`、`cell_direct_setup` 及容量不足后的 invocation-local 完整 decode 已从生产生成链删除。无效 SetupRef 局部拒绝，不偷偷恢复旧 decoder。

唯一 GeometryRecord producer 继续保留 14 类 center/X/Y finite-difference 语义，记录 metrics.z 发布 demand 的实际 geometry input union mask；记录 hot depth/flags 与 cold 输入共用一个 owner，消费者不再从三顶点或 source heap 补数据。当前 45×vec4 物理 record 仍作为 cold 最坏兼容容量，`SURFACE_GEOMETRY_RECORD_HOT_BYTES=128` 作为后续 hot/cold 压缩合同起点，不删除任何输入能力。

## 物理容量

| 产品 | Phase 2 合同 |
|---|---|
| local setup | 512B/setup；production batch 必须 `setupCapacity >= targetCapacity` |
| local dictionary | 8B/entry，容量为 bounded power-of-two；当前生产目标可覆盖完整 batch key 数 |
| frame memo | 528B/entry 的独立 bounded envelope（key、generation、完整 setup 预留）；本阶段只建立 owner/capacity/lifetime 合同，实际 admission 属于 Phase 3 |
| setup arena | dictionary + local setup；reset/request/build/finalize 由 SurfaceGeometry owner 统一管理 |
| GeometryRecord | 720B 最坏完整语义；metrics.z 记录实际 input union；hot 起始目标 128B，不提前压缩 cold |

`SurfaceOptimizationCapacity` 将 setup、memo、GeometryRecord、field/signal values、demand、coverage、indirect 和 retirement scratch 纳入实际 allocation；资源创建前检查 storage/buffer limit。最终 512MiB 和 R=65536 仍是设计目标，未在 Phase 2 宣称达成。

## 本阶段验证

- `npm --prefix OEngine run typecheck`：exit 0。
- `npm --prefix OEngine run build`：exit 0，生产 tsc、Vite bundle、build declarations。
- `npm --prefix OEngine run build:test`：exit 0，使用新鲜 `.test-dist`。
- 43 项 targeted semantic/oracle tests通过，新增 `surface-geometry-phase2.test.mjs` 覆盖完整 local capacity/memo 分离、bitonic/run leader、direct fallback 删除、Geometry input union/hot depth。
- `phase2-geometry` 真实 Chrome 154 WebGPU 小链：25 个生产 WGSL modules 编译无错误；真实 setup→facts→addresses→certificates→Field/Signal→GeometryRecord→Appearance→Lighting→reconstruct 接线；active `[0,2,5,7]`、空帧、移动 `[1,5]` 三帧均完成，HDR 写域正确，mixed append map cursor 实际出现，page errors/API errors 均为空。

本阶段没有运行跨浏览器、resize/cut/device recovery、完整 Showcase timing、四版本同条件性能比较或 Phase 7 正式质量/性能验收。memo admission/hit/miss 的详细 GPU counter 尚未导出，且 admission 明确留在 Phase 3；本阶段验证的是独立容量、统一 producer、overflow 局部正确性和真实 consumer 接线，不能把 setup 次数或短诊断当正式性能收益。
