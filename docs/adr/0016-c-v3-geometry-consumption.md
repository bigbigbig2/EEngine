# ADR-0016-C: Virtual Geometry 生产消费与原子切换

Status: accepted

## Context

OEngine 已有 `GpuAssetStore -> GpuRenderWorld -> hierarchy/work -> MeshletBucketRaster -> VisibilityKey -> Sparse Shading` 的唯一生产闭环。为 Web Cooker 或 OEGPACK 另建 Nyx renderer/backend 会复制 scene、visibility、material、shadow 和证据体系，也无法完成现有路径迁移。

## Decision

Geometry Product 必须接入现有唯一 GPU-driven 管线。首个 runtime profile 使用 OEGPACK V3-compatible decoded hierarchy、Group、Meshlet 和 256 KiB page 布局；来源是 Web live product 还是 OEGPACK adapter 对 renderer 不可见。

`GpuAssetStore`/新的 geometry residency owner 发布 product-scoped metadata、root、Group 到 physical address 和 generation。GPU traversal 依据 SSE 选择 desired Group：目标页 resident 时产生现有 raster work，缺页时产生去重 demand 并使用 resident ancestor/bootstrap Group。最终可见 work 继续由 GPU 直接驱动 indirect hardware raster，VisibilityKey、material identity 和 Sparse Shading ABI 不因 source 改变。

Product revision 替换只允许在新 descriptor 和完整 activation cut 已验证并 resident 后，于 scene/GPU publication 边界一次切换 product generation。一个冻结 `FrameContext` 不得混用旧 hierarchy 与新 page table；旧 revision 在提交安全边界后退休。

迁移期可以使用受控开发选择器做同 workload 对照，但完成后只能保留一个生产 geometry consumer。Web 与 Offline 路线不保留不同 raster、visibility、shadow 或 shading backend。

GPU consumer 必须逐项移植 Nyx `DAGCull.slang` 的 `ProcessNodeBatch`、`ProcessMeshletBatch`、`computeMain` 和 `VBufferMesh.slang` 的 `BuildVertexOutput`、`meshMain`、`pixelMain` 语义。WGSL/现有 WebGPU indirect raster 是平台适配，不是删除 HZB/SSE、wavefront reservation、resident fallback、refinement request 或 local primitive identity 的理由；不允许以普通 triangle/per-object draw 取代 Nyx consumer。

## Consequences

Residency 与 renderer consumption 必须按垂直切片交错推进：先让 producer-neutral bootstrap product 进入真实 Visibility，再加入 demand/refinement，最后切换普通 Scene adapter、main view、shadow 和生命周期。不能先建无 consumer 的完整 scheduler，也不能用整包常驻冒充 streaming 完成。

现有 V2 GeometryAssetPackage 只有在 source、compiled graph/shader 与 browser counter 三层证明所有生产 consumer 已切换后才删除；不保留永久兼容层。新 runtime layout 需要新 profile/spec 和有证据的 consumer specialization，不能分叉主管线。

## Verification

验证 Web 与 OEGPACK product 的真实 Visibility 像素、SSE/ancestor fallback、demand/refinement、main/shadow 共享、bounded work overflow、scene patch/replace、camera cut、device loss 和 feature-off。最终 cutover 需要生产入口、GPU topology/counter、截图/数值回归与同条件性能证据，并完成三层旧路径删除审计。
