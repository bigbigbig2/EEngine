# SurfaceWork Runtime V3 方向一致性核对

核对日期：2026-10-02。范围：用户指定的 `EEngine-v3-extreme-performance-AAA-final-refactor-design-2026-10.md`、方向入口和当前 SurfaceWork 源码接线。本文核对结构与实现边界，不替代 GPU、画质或性能验收。

## 已对齐入口

| 原文要求 | 当前入口 | 核对结果 |
| --- | --- | --- |
| SurfaceWork implicit/uniform/mixed | `AGENTS.md`、`project/workstreams/active/eengine-next-clean-rebuild.yaml`、`docs/next-execution/surface-work-runtime-v3-rebuild-2026.md` | 64-lane tile classifier、bounded sample/exception、counter/indirect 和 sample map 已实现，Product/形变与正式验收仍待完成 |
| 唯一 SurfaceGeometryRecord | `docs/domains/shading.md`、`docs/domains/visibility.md` | `SurfaceGeometryPass` 已成为当前唯一结构入口；Product/skin/morph/previous deformation 覆盖仍不完整 |
| cache lookup → miss-only compact | V3 原文、V3 执行计划、Shading domain | lookup 已前移并接入 hit mask/miss 节点；GeometryRecord 仍未消费 hit mask，完整 publication kernel 和 key 语义仍未完成 |
| diffuse/specular/coat/IBL packets | V3 原文、架构层计划、workstream rules | 独立 signal 与局部 full-rate 例外已统一 |
| TemporalFacts 唯一基础 owner | `docs/domains/frame-runtime.md`、`docs/next-execution/temporal-radiometry-presentation.md` | 目标和当前边界一致，Surface 不拥有第二套基础 motion |
| 廉价 reconstruct | V3 原文、V3 执行计划、Shading domain | 当前已是 packet-only 结构；signal history、AO/emissive/energy 合成仍未完成 |
| 单 Renderer / 单 submit / 无本帧 CPU work control | `AGENTS.md`、ADR-0021、workstream | 已统一为硬架构规则 |
| Phase 0–7 与最终验收 | `docs/VALIDATION.md`、V3 执行计划、workstream | 统一到原文 §8–§11，移除旧 50%/30% 门槛 |

## 清理结果

- 第三版原文已复制到 `docs/next-design/`，并与下载文件 SHA256 一致。
- 旧 Surface v2、Signal-Rate、缓存 Surface 设计与执行文件已从活动文档树删除；Git 历史仍可追溯。
- 整体架构、docs 入口、AGENTS、workstream、shading/frame-runtime/visibility domain、Surface/Temporal/VSM/AO 入口已指向 V3 或明确标注历史边界。
- 退休 spec/contract 保留为历史记录，不再作为 V3 ABI 或当前实现事实。
- 本轮在保持唯一主链的前提下补齐了 tile classify、bounded sample/exception、indirect dispatch 和 sample map；本页只记录边界，不把未验收实现提升为 claim。

## 未完成但不应被文档掩盖

源码证据：`OEngine/src/render/program/FrameProgramLowering.ts:337-344` 先发布 TemporalFacts，再调用唯一 `owners.surfaceWork.addToGraph`；`FrameProgramLowering.ts:407-429` 将 Surface 结果送入 Sky/Aerial、FSR3、Radiometry、Bloom 和 Present。`OEngine/src/render/surface/SurfaceWorkRuntime.ts:100-136` 注册 classify、cache lookup、`SurfaceGeometryPass`、miss evaluation、四类 lighting packets 和 reconstruct。`SurfaceMaterialCachePass.ts:83-91`、`SurfaceGeometryPass.ts:197`、`SurfaceLightingWorkPass.ts:69`、`SurfaceReconstructionPass.ts:43` 分别证明 lookup/evaluate、唯一 GeometryRecord、packet 和 reconstruct 的结构入口；完整 evaluator、覆盖分类、provider 与 history 仍需实现和验收。

当前源码已经接通 V3 的 SurfaceWork、implicit/uniform/mixed tile classify、bounded sample/exception、唯一 GeometryRecord 结构、cache lookup、indirect dispatch、独立 signal packets、packet reconstruct 和真实 FrameGraph 边，但 GeometryRecord 尚未消费 hit mask，完整 publication kernel、完整 key、cluster/VSM/AO/IBL provider、signal history、skin/morph/previous deformation、Product 跨 LOD/source/seam、nonlocal/provider、屏外 VSM caster、透明 composition、SSSR/GI/VT 等缺口继续有效。实现、来源 adoption、evidence、画质和性能分别验收；本轮实现仍未运行正式验证。
