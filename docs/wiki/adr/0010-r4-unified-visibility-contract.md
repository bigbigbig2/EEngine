# ADR-0010 · R4 统一 Visibility Key、光栅语义与 Resolve 边界

Status: accepted

Refines: ADR-0003、ADR-0004、ADR-0007、ADR-0009

## 背景

R3 已输出 `RasterWork(visibleClusterSlot, meshletRecordIndex)` 并由 Hardware `drawIndirect()` 直接消费。一个 selected Cluster 可以包含多个 Meshlet，因此只编码 `visibleClusterSlot + localTriangle` 不能唯一找到三角形。R4 还需要在不依赖 64 位原子、BDA、MDI 或无限 bindless 的 WebGPU baseline 上统一 Hardware、Software 和 Material Resolve。

旧文档还混用了 perspective-correct attribute 与 Hardware fragment depth，并把 D3D top-left 规则写成跨 WebGPU 后端的硬保证。这会让 SW/HW oracle 在 exact-edge 像素上提出规范并不保证的要求。

## 决策

1. R4 固定顺序为 `R4-A Hardware Visibility Contract → R4-B Single Material Resolve → R4-C optional Software/Hybrid`。R4-C 是 profile optimization，不是完整画面的正确性前提。
2. `VisibilityKey v1` 是 32 位、frame-local：

   ```text
   bits 0..6   localTriangle 0..127
   bits 7..31  rasterWorkSlot 0..0x01FFFFFE
   slot 0x01FFFFFF reserved
   0xFFFFFFFF  empty
   ```

   lookup 为 `RasterWork → VisibleCluster + Meshlet → Instance/Geometry/Material`。RasterWork record capacity 最大为 `0x01FFFFFF`，最后一个合法 slot 为 `0x01FFFFFE`；整个 `0x01FFFFFF` slot 保留，避免任何合法 triangle 产生 sentinel。overflow 在 producer 处明确失败或回退，不截断 key。
3. final Visibility 使用 `r32uint`，final depth 使用 `depth32float` reverse-Z。Hardware Raster 是 fragment depth 的规范 oracle；SW 按 WebGPU rasterization 语义插值 post-clip viewport depth。Perspective correction 只用于 UV、position、normal/tangent 等 attributes。
4. OEngine SW Raster 使用像素中心和固定 deterministic top-left rule。非边界样本与 HW 必须 exact/quantified match；像素中心恰在 shared edge 时允许 primitive owner 因后端而异，但不得产生 coverage hole、非法重叠或最终 surface 差异。
5. 两阶段 SW Raster 先以 `atomicMax(depthBits)` 决定 reverse-Z winner，再在相同 depth 下以 `atomicMin(VisibilityKey)` tie-break。它只承诺同一帧 key 集合内不依赖 workgroup 执行顺序，不承诺 frame-local slot 重排后的跨帧 winner 身份稳定。
6. R4-A 提前冻结 `MaterialVisibilityRecord` 逻辑子集：`alphaMode/alphaCutoff/doubleSided/baseColorAlphaTexture/uvSet/uvTransform/samplerClass`。它只服务 opaque/alpha 分类和 alpha discard，不在 R4-A 实现完整 PBR。R4-B 将它扩展或映射到完整 MaterialRecord/Texture residency。
7. R4-B 迁移 R2-D-08 barycentric/gradient/normal-tangent 和 R2-D-09 velocity 已验证实现，不重新发明同一数学；删除按活跃材质重复全屏的 Material Expand。
8. SW feature off 必须零 SW resource/Pass/readback。feature on 但 GPU queue empty 时仍要诚实记录常驻/clear/classifier/indirect/combine 固定成本，不能等同于 feature-off。
9. 研究指南只路由证据；任务 ID、ABI 与 Gate 只由 ADR 和 implementation 文档拥有。正式复用必须另建固定 commit、源码路径、许可证、差异和测试齐全的 porting ledger。

## 后果

- R4-A 必须在 R4-B 前冻结 Key codec、lookup、alpha visibility 子集和 Hardware debug reconstruction。
- Resolve 通过 `rasterWorkSlot` 多一次 table lookup，但能唯一定位 multi-Meshlet Cluster 中的 Meshlet；不得为省一次读取恢复有歧义的 key。
- R4-C 可默认关闭；HW-only 仍完成统一 Visibility 和 Material Resolve。
- exact shared-edge 测试改为 coverage/surface invariant，不再要求所有 adapter 返回相同 primitive ID。
- 若真实场景证明 25-bit RasterWork slot 不足，必须新增 ADR 调整 lookup；不得偷 depth bits 或静默缩小场景。

## 验证

- TS/WGSL codec 覆盖 empty、最大合法 slot、128 triangle 边界、invalid/sentinel 和 multi-Meshlet Cluster round-trip。
- Hardware debug resolve 由 key 唯一输出 instance/meshlet/triangle/material，并覆盖 opaque、alpha-tested、double-sided 和 mirrored transform。
- CPU/SW/HW 小图覆盖 clip、reverse-Z、非边界、shared-edge、degenerate、完全重叠和不同执行顺序。
- R4-B 用 R2-D-08/09 reference cases 验证 barycentric、gradient、normal/tangent 和 velocity。
- A/B/C paired benchmark 分开报告 HW、Resolve、SW classifier/depth/key/merge、资源字节和 feature-off；只有目标微三角形 workload 证明收益时默认启用 Hybrid。
