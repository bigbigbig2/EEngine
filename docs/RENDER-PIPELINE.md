# 统一渲染主管线

OEngine 只有一条主管线。功能按照 capability、配置和资源依赖启停；关闭后不得保留对应 Pass、资源、history、readback 或 submit。

## 一帧

```text
Apply bulk/dirty GPU table updates
→ Update camera and required deformation
→ Clear active counters
→ Instance Cull
→ Cluster Hierarchy Traversal + SSE LOD
→ Cluster Frustum/Cone/previous-HZB Cull
→ Compact VisibleCluster Queue
→ Classify HW / Alpha / optional SW Work
→ GPU writes indirect args
→ Hardware Visibility drawIndirect
→ Optional Software Micro Raster + unified merge
→ Build current HZB / optional late visibility
→ Single Material Resolve + Velocity
→ Clustered Lighting + IBL + CSM
→ Transparency / Decal
→ Temporal Reconstruction / Upscaling
→ Exposure / Bloom / Post
→ Optional unified debug view
→ Tonemap / Present
```

R3 v1 从 Cluster hierarchy roots 形成合法 parent/child cut；当前 R2 BVH8 不直接进入运行热路径，因为其 leaf 同时覆盖多个 LOD 层且没有父子互斥选择语义。Frustum + SSE 先与 CPU reference 对齐，再逐项启用 Cone 和 previous HZB。

## Hardware-first Visibility

当前 WebGPU baseline 是 GPU compact list → GPU indirect args → single `drawIndirect`。固定功能光栅是普通不透明几何、alpha-tested、shadow 和所有 fallback 的正确性路径。

必须报告：

- attempted/written visible Meshlet；
- traversal attempted/written/peak/overflow/fallback 与 encoded/effective/empty rounds；
- indirect instance count 与实际 submitted triangle；
- 固定 384 vertices 带来的无效工作；
- bucket/pass 数、overflow 和 fallback；
- main/CSM view 分别消耗的 traversal 与 raster 时间。

## Unified Visibility 与 Material Resolve

先落地已冻结的 HW VisibilityKey、depth、`RasterWork → VisibleCluster/Meshlet` lookup 和最小属性重建，再完成单次 Standard PBR Material Resolve。主链不得等待 Software Raster 才建立材质闭环。

Material Resolve 一次处理可见像素，动态读取 MaterialTable 和有界 TextureRef/resident handle。array-bank、atlas 或 fixed-bank 由真实资产 benchmark 冻结；不得长期保留“每个材质一个全屏三角形”的通用实现。

当前 Packed production 已在 R4-B 冻结为一次 fullscreen Render Resolve：128 B `MaterialRecord v2`、64-layer `256×256` 9-mip texture array、26 B/pixel Surface + velocity。MaterialRecord v2 的纹理 UV contract 为共享 `TEXCOORD_0/1 + transform`，loader 对 per-texture mapping 分歧显式拒绝；GPU material handle 来自有界 dense resident slot/free-list，不再等于全局 `material.id`。Visibility 不再输出 triangle/instance/material-depth auxiliary MRT，Packed Velocity 也已并入 Resolve。普通 `Scene` legacy MaterialExpand/Velocity 只在对应 consumer 请求时惰性创建，不属于 Packed 主管线；R4-C 只能替换或合并 key/depth producer，必须复用同一个 Resolve。

## Software Micro Raster

Software Raster 是统一 Visibility 后的可选 adapter：

1. Depth 阶段对微三角形执行完整 32 位 ordered depth 原子竞争。
2. Visibility 阶段只为胜出深度写入统一 key，并采用确定性 tie-break。
3. Transfer/merge 与 Hardware path 共享 reverse-Z、sentinel 和 coverage invariant；exact shared-edge 的 primitive owner 不要求跨 WebGPU backend 一致。
4. Alpha/复杂 clip、near-plane 大三角形、超大 bbox、overflow、atomic hotspot 和 MSAA 回退 Hardware。

只有目标 adapter 和 workload 证明 Hybrid 有收益时才默认启用；HW-only 更快也是有效结论。

## HZB

- 使用 Compute 在一个 Pass 中编码多个 mip dispatch，禁止恢复逐 mip Render Pass。
- initial visibility 只读已 commit previous；late/alpha/light/SSR 读 current/final。
- HZB 负责遮挡，不决定当前帧 LOD；SSE 使用当前 view 和 hierarchy error。
- second-chance 由收益和运动证据决定，不无条件运行。

## Lighting、Shadow 与 Temporal

- CSM 暂时是阴影 baseline；优先让每个 Cascade 的工作生成、计数和 indirect consumer 可解释，不建设 VSM。
- 动态灯光走 GPU Light Table、cluster assignment 和有界 light list；attempted/written/overflow 必须可观测。
- IBL 与现有可迁移 GI 是当前间接光基础；高级 GI 留作后续研究。
- internal resolution 与 output resolution 分离，为 Dynamic Resolution、Temporal Reconstruction 和 Upscaling 建立统一 history contract。
- Velocity、disocclusion/reactive 信息、camera cut、resize 和 LOD transition 必须有明确语义。

## 内容扩展

当前只冻结通用输入输出 seam，不实现地形、角色、粒子、云、海洋或大气专用 Renderer。未来项目必须复用 GPU Tables、Visibility/Depth、Surface/Velocity 和 FrameGraph，不复制第二条主管线。

## 统一调试视图

Renderer 只有一个 `render_debug_view`。真实 producer 不存在时报告 `unsupported + blockerTaskId`；`none` 与 `unsupported` 不添加 Pass、瞬态资源或 readback。
