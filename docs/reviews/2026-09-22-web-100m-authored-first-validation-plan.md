# ADR-0018 Authored-First Validation Plan (2026-09-22)

## Decision

ADR-0018 的架构目标不变：最终仍要用独立 validation host 证明 100M
single-giant geometry 的 bounded producer、Multi-Product runtime、GPU demand、
streaming 和 visibility 闭环。本文件只调整验证顺序，避免在开发机尚未证明
真实 authored 生产链、也尚未关闭已知 publication/planner 债务时直接启动 100M
formal workload。

## Review judgment

上文对 `6a53ce1` 的审评大方向正确：A-J 已从“组件存在”推进到主要生产链相连，
尤其是 Product-per-shard、cook-and-spill、Multi-Product GPU metadata、Product
identity、demand routing、Current-HZB consumer 和 dynamic scheduler runtime
入口都已有实现或 contract/oracle 证据。

但“现在只剩 Phase K 的 100M accepted evidence”不完整。当前还必须把以下内容
作为正式缺口管理：

1. **Planner working set**：giant primitive 的 Morton planning 需要持久化
   scratch/index 或等价的顺序物化策略，证明不会为每个 shard 重扫完整 primitive；
   还要记录取消、失败清理、scratch owner、容量和峰值。
2. **Incremental publication**：当前每个新 shard 都合并已有 Product source，
   release 旧 publication，再 stage/submit 完整 Scene。功能正确，但 Product 数量
   增长时是 O(N²) 的 CPU/提交路径，必须进入 K1。
3. **Unified public route**：调用方仍需在 single Product 与
   `uploadWebCookedMultiProductScene()` 之间选择；长期目标是统一 `load_gltf()` /
   `uploadWebCookedScene()` 路由，内部把单 Product 当作 N=1 特例。
4. **Automatic capacity**：`multiProductSlotCapacity` 和 metadata budget 仍由
   caller 手工传入；Catalog/Spatial Plan 应输出 estimated Product count，并选择
   next-power-of-two capacity，同时遵守 negotiated adapter limits。
5. **Runtime evidence**：Current-HZB dense-occlusion parity、真实 adapter
   Portable/Balanced/HighEnd、scheduler IO/decode/upload telemetry、以及 authored
   large 的 accepted browser receipt 都还没有形成当前 revision 的正式证据。
6. **Optional scale controls**：Zorah 的 bounded `EXT_meshopt_compression` decode
   和 250M/500M/1B 诊断仍是后置 gate，不应阻塞当前 authored-first 路线。

## Validation ladder

| Gate | Workload | Purpose | Promotion rule |
| --- | --- | --- | --- |
| K0 | `large.glb`, 4,871,612 triangles, 1,041 nodes, 1,920 primitives | 验证真实 authored multi-primitive 的 Web Cook → Product → GPU → streaming → Current-HZB/scheduler → dispose 闭环 | 可形成该资产的 Runtime/diagnostic evidence；不得升级为 100M 或 `PerformanceEvaluated` |
| K1 | K0 期间暴露的 scale debt | 关闭或量化 planner scratch、incremental publication、自动 capacity、真实 IO/decode/upload telemetry | 未完成前不得把 K2 的性能数字解释为可扩展性结论 |
| K2 | `single-giant-100m.glb`, 100,000,000 triangles | ADR-0018 正式 clean revision / browser / adapter / sample gate | 只有 accepted evidence 才能提升 ADR 完成状态 |
| L/M | fixed-384 baseline 后的 raster buckets、250M/500M/1B | 后置优化和扩展性诊断 | K2 通过后启动 |

K0 的 source hash、node/primitive/triangle 统计和 owner budgets 必须冻结；它的
TTFMF、total cook、Product count、CPU/WASM/JS/GPU peaks、page demand/churn、GPU
errors、camera-cut recovery 和 disposal receipt 必须完整记录。没有这些字段只能算
调试日志，不能算 K0 pass。K0 也不得引用 100M formal workload 的 evidence index
entry。

## Current status

- A-J：实现/contract/oracle 层面基本闭环；仍缺对应真实 browser/adaptor 的提升证据。
- K0：计划已落文档；当前没有 accepted authored-large browser evidence，之前停止的
 运行不判通过。
- K1：未完成，列为下一组工程任务；不启动 100M 运行来绕过这些问题。
- K2：formal case 可执行但保持后置；没有 accepted clean-run evidence。
- L/M：保持 todo，不提前扩张 workload。

## Non-goals for this machine pass

本轮不启动 `web-100m-formal-perf`，不继续跑 100M 或 Zorah，也不把
`large.glb` 的结果冒充 100M。下一次真正运行时，只运行独立
`web-authored-large-perf`，并在 K0 receipt 完整后再决定 K1 的实现顺序。
