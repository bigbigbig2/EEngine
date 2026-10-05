---
id: visibility
kind: domain
owner: visibility
state: current
verifies:
  - project/domains
---
# Visibility

## 当前源码事实

核对：2026-10-02，基线 `11d906ab`。Visibility 拥有 GPU hierarchy traversal、bounded MeshletWork、indirect hardware raster、VisibilityKey/depth 和 HZB。普通与 Product 工作进入同一 GPU Scene。可见工作在 GPU 生产和消费，readback 只供诊断或延迟反馈，模块不拥有私有 frame submit。

当前 FrameProgramLowering 将 VisibilityKey/depth/MeshletWork 与共享 frame geometry 送入 SurfaceWorkRuntime；SurfaceWork 先做 cache lookup，再注册唯一 GeometryRecord 和后续 packet/reconstruct，GeometryRecord 已按 hit mask 走包含代表像素与 object-to-clip 签名的持久化 geometry cache bypass，miss 进入 bounded queue 并由 indirect resolve 独立压缩。AppearanceCachePass、SparseLightingPass、旧 frequency planner、Dense/exception MaterialPass、Probe/sample 链均不是当前生产 consumer。

选中工作经过 shared instance transforms、FrameGeometryVertices 和 FrameGeometryArena，为 raster/Appearance winner 消费准备 clips、triangle directory 和真实 attributes。Product late HZB 重排工作目录而共享底层几何存储。WinnerPrimitiveInterpolation 已在 Appearance 实际消费，不再是“仅 diagnostic、尚未接入”的状态。

当前 frame attributes 并不代表完成持久静态 resident packing、skin/morph 或跨 meshlet/LOD 的完整对应。Product 跨 LOD/source/seam、形变 previous mapping 和完整几何容量缺失下的 Surface 供给仍需结合最终新链核对；不能把旧 raster fixture 覆盖当成完整 Surface 验收。

## 第三版目标边界

[用户指定原文](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)保留 Geometry/Visibility 和 frame geometry owners。Visibility 发布 winner/depth，SurfaceWork 入口解析 frame-local winner；SurfaceGeometryPass 唯一恢复 SurfaceGeometryRecord，Appearance/Lighting 不再各自解析 MeshletWork/三顶点/UV/normal。

Winner、Sharing 和 Cache identity 分开，VisibilityKey 不作跨帧 cache 身份。能力/容量先协商，每个 queue/indirect 有 bounded overflow 和消费者安全空状态；Surface 最终例外不交回旧 queue，不以 CPU 第二次 submit 修补。

入口：`render/passes/PackedVisibilityPass.ts`、`HierarchicalWorkGenerator.ts`、`MeshletBucketRaster.ts`、`HierarchicalZBuffer.ts`、`FrameGeometryArena.ts`、`FrameGeometryVertices.ts`、`program/FrameProgramLowering.ts`。

历史 Native/Chrome 组件诊断保留在[ledger](../porting/next-renderer.md)与[geometry lab](../../validation/labs/surface-geometry/README.md)，其日期和范围不转授第三版完整性能/画质。当前重构执行和验收见[SurfaceWork V3 计划](../next-execution/surface-work-runtime-v3-rebuild-2026.md)。
