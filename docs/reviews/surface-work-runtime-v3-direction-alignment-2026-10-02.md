# SurfaceWork Runtime V3 方向一致性核对

核对日期：2026-10-02。范围：用户指定的 `EEngine-v3-extreme-performance-AAA-final-refactor-design-2026-10.md`、方向入口和当前 SurfaceWork 源码接线。本文核对结构与实现边界，不替代 GPU、画质或性能验收。

## 已对齐入口

| 原文要求 | 当前入口 | 核对结果 |
| --- | --- | --- |
| SurfaceWork implicit/uniform/mixed | `AGENTS.md`、`project/workstreams/active/eengine-next-clean-rebuild.yaml`、`docs/next-execution/surface-work-runtime-v3-rebuild-2026.md` | 64-lane tile classifier、bounded sample/exception、counter/indirect 和 sample map 已实现，Product/形变与正式验收仍待完成 |
| 唯一 SurfaceGeometryRecord | `docs/domains/shading.md`、`docs/domains/visibility.md` | `SurfaceGeometryPass` 已成为当前唯一结构入口；Product/skin/morph/previous deformation 覆盖仍不完整 |
| cache lookup → miss-only compact | V3 原文、V3 执行计划、Shading domain | lookup 已前移，publication identity、每 program indirect miss compaction 和真实 AppearanceResidentKernel 已接入；GeometryRecord 仍未消费 hit mask，sampler/UV/filtered footprint key 仍不完整 |
| diffuse/specular/coat/IBL packets | V3 原文、架构层计划、workstream rules | 独立 signal 与局部 full-rate 例外已统一 |
| TemporalFacts 唯一基础 owner | `docs/domains/frame-runtime.md`、`docs/next-execution/temporal-radiometry-presentation.md` | 目标和当前边界一致，Surface 不拥有第二套基础 motion |
| 廉价 reconstruct | V3 原文、V3 执行计划、Shading domain | 当前已是 packet-only 结构，接入双缓冲 signal history、基础 AO/emissive/energy 合成；完整 age/revision 语义仍待验收 |
| 单 Renderer / 单 submit / 无本帧 CPU work control | `AGENTS.md`、ADR-0021、workstream | 已统一为硬架构规则 |
| Phase 0–7 与最终验收 | `docs/VALIDATION.md`、V3 执行计划、workstream | 统一到原文 §8–§11，移除旧 50%/30% 门槛 |

## 清理结果

- 第三版原文的目标架构、阶段顺序、容量/身份/质量不变量已纳入 `docs/next-design/`；仓库副本另外记录当前源码核对，因此不与下载文件逐字节相同。下载原文 SHA256 为 `6d229211f8aab8e8efcf9e10a253452a57ed98b84557869e7049928502aa5401`。
- 旧 Surface v2、Signal-Rate、缓存 Surface 设计与执行文件已从活动文档树删除；Git 历史仍可追溯。
- 整体架构、docs 入口、AGENTS、workstream、shading/frame-runtime/visibility domain、Surface/Temporal/VSM/AO 入口已指向 V3 或明确标注历史边界。
- `docs/porting/next-renderer.md`、`docs/performance/2026-10-02-surface-work-runtime-v3-phase7-verification.md` 已同步到当前 provider/history 接线和 Phase 7 未完成状态；AO 设计中的旧 SurfaceMaterialPass 仅保留为历史基线，当前入口改为 SurfaceWork packet。
- 退休 spec/contract 保留为历史记录，不再作为 V3 ABI 或当前实现事实。
- 本轮在保持唯一主链的前提下补齐了 tile classify、bounded sample/exception、indirect dispatch、sample map、publication miss evaluator、真实 clustered/VSM/AO/IBL provider 和双缓冲 history；本页只记录边界，不把未验收实现提升为 claim。

## 未完成但不应被文档掩盖

源码证据：`OEngine/src/render/program/FrameProgramLowering.ts` 先发布 TemporalFacts，再调用唯一 `owners.surfaceWork.addToGraph`；随后将 Surface 结果送入 Sky/Aerial、FSR3、Radiometry、Bloom 和 Present。`OEngine/src/render/surface/SurfaceWorkRuntime.ts` 注册 classify、cache lookup、`SurfaceGeometryPass`、publication miss evaluation、四类 lighting packets 和 reconstruct。`SurfaceMaterialCachePass.ts`、`GpuAppearancePublication.ts`、`SurfaceGeometryPass.ts`、`SurfaceLightingWorkPass.ts`、`SurfaceReconstructionPass.ts` 分别证明 lookup、真实 publication evaluator、唯一 GeometryRecord、packet 和 reconstruct 的结构入口；覆盖分类、signal age/revision、Product/形变和正式验收仍需完成。

当前源码已经接通 V3 的 SurfaceWork、implicit/uniform/mixed tile classify、bounded sample/exception、唯一 GeometryRecord 结构、publication cache lookup、per-program indirect miss dispatch、真实 AppearanceResidentKernel、cluster/VSM/AO/IBL provider、独立 signal packets、双缓冲 history reconstruct 和真实 FrameGraph 边，但 GeometryRecord 尚未消费 hit mask，sampler/UV/filtered footprint key、signal age/revision reject、skin/morph/previous deformation、Product 跨 LOD/source/seam、nonlocal/provider、屏外 VSM caster、透明 composition、SSSR/GI/VT 等缺口继续有效。实现、来源 adoption、evidence、画质和性能分别验收；正式 GPU/browser 验证仍未通过。

## 最终静态对照

| V3 目标 | 源码证据 | 结论 |
| --- | --- | --- |
| 单一 Surface 主链与真实 FrameGraph 边 | `FrameProgramLowering.ts:354-389` → `SurfaceWorkRuntime.addToGraph`；`SurfaceWorkRuntime.ts:238-316` | 结构已对齐；旧 owner 未出现在当前生产接线 |
| lookup 在 miss evaluation 前，命中绕过重工作 | `SurfaceMaterialCachePass.ts:68-74` | lookup、hit mask、bounded miss queue 和 indirect evaluator 已接通；`SurfaceGeometryPass.ts:201-232` 仍按 record range dispatch，命中尚未绕过 GeometryRecord |
| 唯一 GeometryRecord | `SurfaceWorkRuntime.ts:298-310`、`SurfaceGeometryPass.ts:174-232` | producer 已唯一；Product/skin/morph/previous deformation 覆盖仍不完整 |
| diffuse/specular/coat/IBL 独立 packet | `SurfaceLightingWorkPass.ts:297-351` | packet 资源和计数器已分离；lighting 消费真实 cluster/VSM/AO/IBL 输入并复用生产 direct-light 数学 |
| 廉价 reconstruct 与 TemporalFacts 基础事实 | `SurfaceReconstructionPass.ts:84-166`、`FrameProgramLowering.ts:347-390` | packet-only 输出边和双缓冲 history 已接通；完整 signal age/revision reject 与正式验收未完成 |
| 真实 cluster/VSM/AO/IBL 输入进入 lighting owner | `FrameProgramLowering.ts:354-390`、`SurfaceWorkRuntime.ts:318-320` | 资源句柄已传入 lighting owner，Phase 4 结构接线完成；正式 GPU/画质验收仍待 Phase 7 |

因此，当前工程与 V3 的**方向和结构边界一致**，与 V3 的**最终算法、AAA provider、命中几何裁剪及性能验收尚不一致**；后续应继续在唯一主链内补齐这些缺口，不恢复旧 owner 或兼容桥。
