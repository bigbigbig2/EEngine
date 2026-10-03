# Surface V3 第一版优化进度记录

日期：2026-10-03。当前 HEAD：`ec2b3fec`。本记录只描述真实源码、提交和验证状态，不把组件 oracle 或设计文档当作生产链完成证据。

## 已完成阶段

| 阶段 | 状态 | 提交/证据 | 结论 |
|---|---|---|---|
| Phase 0：基线、容量和删除边界 | 已完成 | `3c0113d8` | GTX 1650 Ti/1080p、Dungeon 指纹、412 MiB/512 MiB policy、来源和旧产品清单已冻结 |
| Phase 1：连续域、LOD lineage、局部纹理 variation | 已完成 | `5057c8dd`；Phase 1 发布记录 | Native/WASM、普通 Geometry metadata、Product lineage、32 MiB variation pool 和实际纹理摘要发布已检查 |
| Phase 2：连续域 classifier、跨 VisibilityKey、多率 SurfaceWork、Geometry setup | 实现切换完成，完整验收延期 | 当前工作树；生成器静态检查与 `build:test` 通过 | 已移除 runtime 旧 classifier 源码并修复多字段 WGSL 未声明 `field`；Chromium production fixture 仍受长时间 pipeline 编译限制，未宣称整链通过 |
| Phase 3：FieldStore 与 demand Geometry | 核心代码已切换，正式验收延期 | 当前工作树；`build:test` 与 `git diff --check` 通过 | 已加入首帧初始化、lookup 前置 gate、compact field buffer、评估后 publish/admit；旧六层全屏 fields 与 pixel-capacity 分配已删除，仍保留 19-word compact identity 元数据和 4-word admission 摘要 |
| Phase 4：SignalStore、紧凑 packet、稀疏 history | 代码收口完成，正式验收延期 | `b882cc5a`；`git diff --check` 与静态 ABI/WGSL 检索通过 | 六类独立 signal family、按 record 紧凑 packet、lighting 前 SignalStore probe、lighting 后 miss-only pack/publish 已接入；20-word entry、HDR precision spill、age/confidence 与四路 packet plane/dense signal witness 删除已完成。正式整链验收统一留到 Phase 7 |
| Phase 5：reconstruct/batch | 代码收口完成，正式验收延期 | 当前工作树；`git diff --check`、导航解析和旧 history 静态检索通过 | 已删除四路 Surface history、dense identity/age 与历史交换；reconstruct 只消费 packet/precision packet、TemporalFacts 和 sample map；batch 上限按 extent/profile 推导，GPU 生成每批 indirect count，尾批按 output region 有界写入 |
| Phase 6：真实 provider/lifecycle | 代码收口完成，正式验收延期 | 本次工作树；`git diff --check` 与静态依赖检索 | 容量预检、Surface 512 MiB ledger、Field/Signal publication generation + submitted epoch、VSM 初始化顺序和真实 FrameGraph provider 依赖已接通；浏览器、GPU、画质与性能统一留到 Phase 7 |
| Phase 6.5：Production Cutover Fix | 代码与 bounded production cutover 完成，正式 Phase 7 验收待执行 | 当前提交；`typecheck`、`build`、`build:test`、Surface reconstruct/FieldStore/profiler 定向测试、`git diff --check` 通过 | classifier 使用固定 batch workspace 与 `firstTile/tileCount`，geometry setup/facts/continuity/compact 逐批串接并写回全帧 sampleMap；lighting precision spill 使用稀疏 spill storage 与 flags index，普通 packet 不再写 full mirror；single-segment store policy、overflow flags、非 8 对齐 tail 与 batch lifecycle 已接通 |
| Phase 7：整链验收 | 未开始 | 无 | 没有正式 browser matrix、画质对照或四版本性能比较 |

因此当前真正完成的是 **Phase 0–1，Phase 2–5 已完成对应代码切换但尚未完成正式生产验收**。Phase 3 的完整跨帧 FieldStore value 消费、Phase 4/5 的正式 GPU、浏览器与连续画质验收统一留到 Phase 7。

## Phase 6 收口

本阶段已完成固定预算与生命周期接线：`SurfaceOptimizationCapacity` 在 Surface extent 资源创建前执行 negotiated-limit/profile preflight，并输出 payload、metadata、queues、alignment、scratch、persistent、history、retired overlap 和 Surface envelope 账本；共享 Visibility、TemporalFacts、材质纹理、VSM、FSR3 等仍单列在全引擎 memory evidence。FieldStore 与 SignalStore 按 publication generation 推进 cache generation，在每次单一 frame submit 登记 submitted epoch，并在 `gpuDone` resolve/reject 后退休。VSM 的 `VsmAtlasRasterPass` 现在只在 `GraphicsContext` 初始化完成后构造，receiver demand、page allocation、caster raster 和 content commit 继续通过同一 FrameGraph 声明依赖真实资源。

本阶段未运行 typecheck、build、targeted tests、GPU oracle、browser 或 benchmark；SurfaceWork V3 规则将这些集中到 Phase 7。当前提交只证明代码接线和静态边界，不提升整链画质、性能或来源 adoption 声明。

## Phase 4 收口与 Phase 5 完成

Phase 4 已完成六类独立 signal、紧凑 packet、lighting 前 SignalStore probe、lighting 后 miss-only pack/publish、20-word entry、HDR precision spill 与 age/confidence 更新。Phase 5 已完成 Surface dense history/identity/age 删除、packet/TemporalFacts 合成、按 extent/profile 的固定 batch 与 GPU indirect count；正式整链验收留到 Phase 7。

## Phase 2 当前事实

已经完成的组件工作包括：

- `GpuSurfaceCellPlanAbi`、`SurfaceCellReference` 和多率 field/signal plan；8 组 synthetic GPU plan case 通过，包含跨 winner、交错域、fine unique、tail/empty tile。
- `SurfaceCellGeometrySetup` 和普通 Geometry GPU fixture；64 covered pixels、2 winners、2 setups、1024 B setup 写入通过。
- Appearance bound、cell address、texture variation 和 FieldStore GPU diagnostic 通过；当前 `build:test` 通过，32 项相关 contract/oracle checks 通过。
- `SurfaceCellClassifierPass` 已尝试接入 `SurfaceWorkRuntime`，并新增 production facts、material constants、lighting facts、cell plan 和 compact representative work 的 FrameGraph 边界。

这些结果还不能证明 Phase 2 完成，原因是：

- `SurfaceWorkRuntime.ts` 的旧 `CLASSIFY_WGSL` 源码已删除；`GpuSurfaceWorkAbi` 的旧 record/layout 仍被后续 Geometry/Material consumer 使用，属于 Phase 3–5 的待替换边界。
- 多字段生成器中的 `unresolved value 'field'` 已修复并通过生成源码检查；真实 Chromium fixture 在 pipeline compile 阶段长时间无终态，未把它记作通过。
- 当前 production classifier 没有通过真实 producer → consumer → compact → GeometryRecord 的完整 GPU fixture；synthetic facts 不能替代它。
- Product profile、overflow direct path、tail batch、真实 field/signal coverage 和跨 meshlet production case 尚未完成。

本阶段不能用 cheap/skip-bound 的诊断 variant 作为完成证据；那类 variant 只用于定位 Chromium 编译问题，不能进入生产路径或提升采用状态。

## 下一步顺序

1. 在后续收口中重新运行真实 Chromium production-cell fixture，覆盖 ordinary/Product、跨 key/meshlet、UV seam、normal 高频、direct shadow 风险、tail/overflow；当前不把长时间 compile 当成通过。
2. 继续删除 `GpuSurfaceWorkAbi` 的旧 pixel-capacity/record 分区，让 plans/compact representative work 的真实 consumer 使用 bounded batch 与 demand Geometry。
3. 完成 FieldStore 的完整 value 消费和 19-word identity 元数据最终收敛；当前 lookup gate、compact field buffer、评估后 publish 已接入，剩余工作集中在跨帧 value 复用、admission 溢出与真实 GPU 覆盖。
4. 在 Phase 6 接入真实 providers、资源预算和生命周期；不恢复 Surface history 或旧协调器。
5. 全部生产 providers 接线完成后才执行 Phase 7 的整链浏览器、画质和性能报告。

当前 Phase 4–5 已完成核心生产切换；正式 GPU/浏览器验收按 Phase 7 集中执行。
