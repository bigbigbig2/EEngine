# SurfaceWork Runtime V3 方向一致性核对

核对日期：2026-10-02。范围：用户指定的 `EEngine-v3-extreme-performance-AAA-final-refactor-design-2026-10.md` 与仓库方向入口。本文是文档核对，不是实现、GPU、画质或性能验收。

## 已对齐入口

| 原文要求 | 当前入口 | 核对结果 |
| --- | --- | --- |
| SurfaceWork implicit/uniform/mixed | `AGENTS.md`、`project/workstreams/active/eengine-next-clean-rebuild.yaml`、`docs/next-execution/surface-work-runtime-v3-rebuild-2026.md` | 目标与执行阶段一致，源码尚未实现 |
| 唯一 SurfaceGeometryRecord | `docs/domains/shading.md`、`docs/domains/visibility.md` | 当前差距明确记录为 Appearance 与 SparseLighting 仍有两套恢复 |
| cache lookup → miss-only compact | V3 原文、V3 执行计划、Shading domain | 命中绕过重 worker 已成为目标规则，当前仍有逐像素 demand |
| diffuse/specular/coat/IBL packets | V3 原文、架构层计划、workstream rules | 独立 signal 与局部 full-rate 例外已统一 |
| TemporalFacts 唯一基础 owner | `docs/domains/frame-runtime.md`、`docs/next-execution/temporal-radiometry-presentation.md` | 目标和当前边界一致，Surface 不拥有第二套基础 motion |
| 廉价 reconstruct | V3 原文、V3 执行计划、Shading domain | 当前重 reconstruct 差距明确记录 |
| 单 Renderer / 单 submit / 无本帧 CPU work control | `AGENTS.md`、ADR-0021、workstream | 已统一为硬架构规则 |
| Phase 0–7 与最终验收 | `docs/VALIDATION.md`、V3 执行计划、workstream | 统一到原文 §8–§11，移除旧 50%/30% 门槛 |

## 清理结果

- 第三版原文已复制到 `docs/next-design/`，并与下载文件 SHA256 一致。
- 旧 Surface v2、Signal-Rate、缓存 Surface 设计与执行文件已从活动文档树删除；Git 历史仍可追溯。
- 整体架构、docs 入口、AGENTS、workstream、shading/frame-runtime/visibility domain、Surface/Temporal/VSM/AO 入口已指向 V3 或明确标注历史边界。
- 退休 spec/contract 保留为历史记录，不再作为 V3 ABI 或当前实现事实。
- 用户已有的源码、示例和 validation 工作树修改未处理；本次没有修改实现代码。

## 未完成但不应被文档掩盖

当前源码仍未完成 V3 的 SurfaceWork、唯一 GeometryRecord、miss-only cache、信号重建和真实 FrameGraph 阶段。skin/morph/previous deformation、Product 跨 LOD/source/seam、nonlocal/provider、屏外 VSM caster、透明 composition、SSSR/GI/VT 等缺口继续有效。实现、来源 adoption、evidence、画质和性能分别验收；本次文档对齐不提升任何 claim。
