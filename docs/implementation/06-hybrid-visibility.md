# 06 · R4-A Hardware Visibility Contract / R4-C Hybrid 优化

## 阶段边界

本包分两次执行：

```text
R3 RasterWork + Hardware drawIndirect
→ R4-A Hardware key/depth/lookup/alpha contract
→ R4-B Single Material Resolve
→ R4-C optional Software/Hybrid profile optimization
```

R4-A 让现有 Hardware-first 主链成为完整、可回查的统一 Visibility producer；R4-C 只在 R4-B 稳定后增加可选 Compute micro-raster consumer。长期决策见 [ADR-0010](../wiki/adr/0010-r4-unified-visibility-contract.md)，来源选择见 [R4 research guide](../references/R4-ALGORITHM-GUIDE.md) 与对应 [porting ledgers](../references/porting/README.md)。

旧 `VIS-*` 编号保留给历史 artifact 和早期计划，不再分配。R4 新工作统一使用 `R4-A-*`、`R4-B-*`、`R4-C-*`。

## 非目标

- 不给旧 `VisibilityPass` 追加一条孤立产品管线。
- 不用 Software Raster 全量替换 Hardware Raster。
- 不依赖 64 位原子、BDA、MDI、mesh/task shader 或无限 bindless。
- 不让 Material Resolve 区分像素来自 HW 还是 SW。
- 不在 R4-A 实现完整 PBR、Texture Streaming、Shader Graph 或 Lighting。
- 不把 HW-only、SW-only、Hybrid 变成三档产品管线；SW-only 只用于验证。

## 当前事实与迁移对象

- R3 已生成 `RasterWork(visibleClusterSlot, meshletRecordIndex)`、完整 16 B `drawIndirect`，生产 `PackedVisibilityPass` 直接消费。
- 当前 Packed Hardware output 还不是 R4 冻结的 `VisibilityKey v1`。
- 当前 alpha-tested 仍依赖按材质 bucket/list 的旧资源组织；它可作为画面 oracle，但必须迁移到 GPU Material Visibility record，不成为最终 per-material CPU draw loop。
- 当前 Material Expand/Velocity 是 R4-B 删除对象，不应在 R4-A 复制成另一套长期 consumer。

## VisibilityKey v1

```text
bits  0..6   localTriangle      0..127
bits  7..31  rasterWorkSlot     0..0x01FFFFFE
slot         0x01FFFFFF         reserved
0xFFFFFFFF   empty

key = (rasterWorkSlot << 7) | localTriangle
```

Lookup：

```text
VisibilityKey
→ RasterWork[rasterWorkSlot]
→ visibleClusterSlot + meshletRecordIndex
→ VisibleCluster[visibleClusterSlot]
→ InstanceRecord + GeometryRecord + Material handle
→ Meshlet triangle indices/attributes
```

约束：

- Cooker/Package validator 保证每 Meshlet 最多 128 triangles。
- 最大合法 `rasterWorkSlot` 为 `0x01FFFFFE`；整个 `0x01FFFFFF` slot 保留。RasterWork record capacity 还要取 adapter buffer limit 与 `0x01FFFFFF` 的较小值；TS/WGSL codec 必须用同一常量。
- key 是 frame-local，不得写入跨帧对象身份、持久 picking ID 或 history identity；稳定 object ID 必须 lookup 后返回。
- producer 无法证明 RasterWork 容量时明确 unsupported/error；不得截断高位或漏绘。
- final visibility 为 `r32uint`，empty clear 为 `0xFFFFFFFF`。

选择 `rasterWorkSlot` 而不是 `visibleClusterSlot` 是必须条件：一个 selected Cluster 可以展开多个 Meshlet，后者不能唯一定位 triangle。

## R4-A Hardware 光栅契约

### Attachment 与深度

| 输出 | 格式 | clear | 语义 |
|---|---|---|---|
| Visibility | `r32uint` | `0xFFFFFFFF` | frame-local key |
| Depth | `depth32float` | `0.0` | reverse-Z far/empty |

- Hardware Raster 是 final fragment depth 的规范 oracle。
- SW/CPU reference 按 WebGPU rasterization 规则，对 clip 后顶点的 viewport depth 使用 framebuffer-space barycentric 插值。
- reciprocal-W perspective correction 只用于 UV、position、normal/tangent 等 attributes，不套给 final Hardware depth。
- alpha-tested 在 fragment discard 后才写 key/depth；opaque 和 alpha 必须共享 lookup 与 sentinel。

### Material Visibility 子集

R4-A 冻结逻辑字段，不提前决定完整 MaterialRecord 的物理布局：

```text
MaterialVisibilityRecord
├─ alphaMode: opaque | mask
├─ alphaCutoff
├─ doubleSided
├─ baseColorFactorAlpha
├─ baseColorAlphaTextureRef | invalid
├─ uvSet
├─ uvTransformRef | identity
└─ samplerClass
```

要求：

- `blend` 不进入 opaque Visibility，路由后续 Transparency。
- 无纹理时只使用 factor alpha；invalid/未驻留纹理使用明确 fallback，不随机采样。
- R4-A 可以用有界临时 visibility texture binding/table 接通正确性，但不得建立 per-material fullscreen 或 CPU 最终可见循环。
- R4-B 的 Material/Texture owner 必须接管或无损映射该子集；不允许维护两个长期 alpha 真相来源。

### Hardware debug reconstruction

R4-A 不做 PBR，但必须通过 key 唯一回查并输出 debug color：

- rasterWork slot；
- visible cluster；
- meshlet/triangle；
- instance/object；
- material/alpha class；
- invalid/empty。

它是 R4-B 开始前的结构 Gate，而不是“已有类名”证明。

## R4-A 执行任务

### R4-A-01 · 冻结来源、Key 与 lookup ABI

工作项已于 2026-08-28 验收，治理状态为 `Implemented`。`OEngine/src/gpu/GpuVisibilityKeyAbi.ts` 已以同一组 TS 常量生成 WGSL codec，并冻结 `0xFFFFFFFF` empty、完整 reserved slot、最大 RasterWork capacity、adapter limit 与显式 producer failure；`OEngine/tests/gpu-visibility-key-abi.test.mjs` 已覆盖 multi-Meshlet 唯一回查。R3 Work Generation/Package ABI 未修改；生产接线、GPU 证据与 `Completed` 状态属于 `R4-A-02..06`。

- 完成 [R4-A porting ledger](../references/porting/R4-A-01-unified-visibility-contract.md)。
- 新建共享 TS schema/WGSL codec，覆盖 encode/decode/empty/invalid/max values。
- 以 multi-Meshlet Cluster fixture 证明 `rasterWorkSlot → meshletRecordIndex` 唯一回查。
- 冻结 capacity、sentinel 和 producer failure，不改 R3 Package ABI。

### R4-A-02 · Hardware opaque producer

- Packed Hardware vertex/fragment path 写 `VisibilityKey v1 + reverse-Z depth`。
- 继续消费 R3 `RasterWork + drawIndirect`；当前帧不得 readback count。
- 定义 attachment owner、FrameGraph lifetime、resize/device-lost 和 feature-off 行为。
- 增加 submitted/useful fragments 可观测值（能力允许时）与 invalid-key counter。

### R4-A-03 · Material Visibility 与 alpha-tested

- 冻结 `MaterialVisibilityRecord` TS/WGSL layout 或到现有 material table 的无损映射。
- 从 GPU record 完成 alpha factor/texture/UV transform/cutoff discard。
- 覆盖 opaque/mask/blend classification、double-sided、mirrored transform、invalid texture 和 sampler fallback。
- CPU per-material bucket 只能作为迁移 oracle；生产 Packed alpha consumer 不得按最终可见对象回读或循环提交。

### R4-A-04 · Hardware debug Resolve

- 单次 debug pass 从 key 回查 RasterWork/VisibleCluster/Meshlet/Instance/Material。
- 对 empty/invalid/max key fail-visible，debug 模式记录具体越界层级。
- 保存 ID heatmap 和至少一个真实 glTF alpha fixture screenshot。

### R4-A-05 · Overflow、生命周期与 feature-off

- RasterWork/key capacity 不足必须 prepare 失败或明确 fallback，不截断画面。
- resize、camera cut、view recreate、device lost 和 in-flight replacement 有测试。
- debug/counter sampling 关闭时不保留无消费者 reducer/readback。

### R4-A-06 · Paired 浏览器 Gate

- A/B/C 使用相同分辨率、DPR、画质与 warm-up 规则运行旧画面 oracle/new key producer。
- 保存 key/depth/debug screenshot、GPU time、queue/counter 与 WebGPU diagnostics。
- R4-A 关闭只证明 Hardware contract；不宣称 Single Resolve 或 SW Raster 已完成。

## R4-C Software/Hybrid 资源与固定成本

| 资源 | 格式/大小 | Producer | Consumer |
|---|---|---|---|
| SW RasterWork queue | 任务 ABI 在 R4-C-05 冻结 | classifier | depth/key stages |
| `swDepthAtomic` | `width × height × u32` | SW depth | SW key/merge |
| `swVisibilityAtomic` | `width × height × u32` | SW key | merge |
| indirect args | 12 B dispatch record | classifier/prepare | SW stages |
| final Visibility/Depth | 与 R4-A 相同 | merge + HW | R4-B Resolve |

两个原子屏幕缓冲约为 `8 B/pixel`，还需计入 clear、classifier、indirect 和 transfer/combine。

```text
feature off
→ 不分配 SW queue/atomic buffers
→ 不编码 classifier/SW/transfer Pass
→ 零 SW readback

feature on + GPU queue empty
→ 可以用 indirect 令 triangle work为零
→ 仍可能存在常驻资源、clear/classifier/combine 固定成本
```

后一种情况必须实测，不能冒充 feature-off。CPU 若不 readback，就不能因为本帧 GPU classifier 输出零而在同帧撤销已经编码的所有图节点。

## R4-C 两阶段 Software Raster

### 共享 coverage/depth 核心

1. 从 SW RasterWork 读取 Meshlet/triangle。
2. clip near plane/viewport；复杂 clip 或 overflow 路由 HW。
3. 统一 winding、front-face、double-sided 和负 determinant 规则。
4. 计算有限保守屏幕 bbox。
5. 使用固定点 edge function 和 OEngine deterministic top-left 规则测试像素中心。
6. 按 WebGPU 语义插值 post-clip viewport reverse-Z depth，clamp/validate 后 `bitcast<u32>`。

由于有效 depth 在 `[0,1]`，正有限 float 的 bit pattern 保序。NaN、负值、超范围和 `w <= epsilon` 不进入 atomic；路由 HW 或按明确退化规则处理。

### Stage 1 · depth winner

```wgsl
atomicMax(&swDepthAtomic[pixel], depthBits)
```

0 是 reverse-Z far/empty。

### Stage 2 · key winner

重复同一 coverage/depth 函数，仅当 `depthBits == atomicLoad(swDepthAtomic[pixel])` 时：

```wgsl
atomicMin(&swVisibilityAtomic[pixel], visibilityKey)
```

key clear 为 `0xFFFFFFFF`。这只保证当前帧、当前 key 集合内执行顺序无关；frame-local RasterWork slot 重排时不承诺跨帧 winner ID 稳定。

### HW/SW merge

首版允许 fullscreen transfer 写 final key 和 `frag_depth`，随后 Hardware path 以 reverse-Z `greater` 消费同一 attachments。必须测量 fullscreen cost，以及写 `frag_depth` 对 early-depth 优化的限制。若换成其他 combine，R4-B 看到的 attachment 与 lookup 契约不能变化。

## Coverage 与 HW oracle 规则

- OEngine SW 固定 top-left 是自身 deterministic 规则，不是所有 WebGPU HW 后端的 exact-edge 保证。
- 非边界像素：CPU/SW/HW depth/key 必须 exact 或在冻结容差内。
- 像素中心正好位于 shared edge：允许 HW/SW primitive owner 不同，但不得有 coverage hole、非法双 winner 或 surface 差异。
- near clip/viewport edge 不越界；clip overflow、超大 bbox、unsupported primitive、alpha、MSAA 全部保守路由 HW。
- MSAA 不进入 v1；未来需要 sample-level key/depth 时新增 ADR。

## Classifier

首版只使用可测字段：

```text
projected cluster rectangle
triangle count
estimated pixels/triangle
clip / alpha / double-sided flags
adapter profile threshold
SW queue pressure
```

阈值不按 benchmark 名称分支，也不写死成跨 GPU 通用常数。alpha-tested、复杂 clip、超大 bbox、queue overflow 与 atomic hotspot 默认 HW。发布默认值来自目标 adapter 的 HW-only/SW-only/Hybrid paired sweep。

## R4-C 执行任务

### R4-C-01 · CPU coverage/depth oracle

固定 edge precision、pixel center、clip、viewport depth 和退化规则；生成小分辨率 coverage/depth/key images。

### R4-C-02 · WGSL coverage prototype

直接输入少量三角形，不接主帧；对 winding、subpixel、near clip、viewport edge、shared edge 和 degenerate 做 GPU/CPU 对照。

### R4-C-03 · SW depth stage

接 `u32 atomicMax`、clear 和 counter；验证 reverse-Z winner、NaN/invalid 拒绝、atomic contention 和资源字节。

### R4-C-04 · SW key tie stage

接共享 coverage/depth 和 `atomicMin`；验证完全重叠、多 workgroup、不同 dispatch 顺序、empty sentinel 和帧内 order independence。

### R4-C-05 · R3 seam classifier/queue

从同一 selected Cluster/RasterWork seam 产生 HW/SW work 与完整 indirect args。队列登记 ABI、capacity、attempted/written/peak/overflow/fallback；SW overflow 整组回退 HW。

### R4-C-06 · Unified merge

SW/HW/Alpha 写 R4-A final attachments。逐像素对照 Hardware oracle，按“非边界 exact、exact-edge invariant”判定。

### R4-C-07 · Profile 与固定成本

扫 triangle size、bbox、visible ratio、atomic overdraw 和 queue pressure；报告 SW buffers、clear、classifier、depth/key/merge P50/P95/P99。B/C 普通三角形不能因 feature-on 固定成本明显退化。

### R4-C-08 · same-frame late visibility（条件任务）

只有 R1/R3 evidence 证明 second chance 有收益才接入；复用相同 queue/key/merge，不建立第二套 Visibility。

### R4-C-09 · 默认策略与删除

- 若目标微三角形 workload 有稳定收益：按 adapter profile 默认 Hybrid。
- 若无收益：SW 默认关闭，保存 reject/profile 证据；HW-only 仍是完整产品主链。
- 新模块覆盖 opaque/alpha 后，删除旧 Visibility owner、旧 shader 和只服务旧 ID attachment 的资源。

## Counters 与 debug

至少记录：SW/HW/Alpha classified work、triangles、bbox pixels、coverage、depth atomic attempts/wins、tie attempts、clip/queue fallback、transfer pixels、invalid lookup、atomic buffer bytes 和各阶段 GPU time。

Debug views：path classification、SW depth、SW key、final key、lookup layer、shared-edge、triangle-size heatmap、atomic overdraw、invalid/empty。

## Gate

### G4-A

- `VisibilityKey v1` 对 multi-Meshlet Cluster 唯一。
- Hardware opaque/alpha 输出正确 key/depth；overflow/fallback/lifecycle 明确。
- debug reconstruction 和真实浏览器 glTF fixture 通过，无 validation/uncaptured error。
- 生产 consumer 保持 GPU producer → `drawIndirect` → GPU output，当前帧不读回可见数。

### G4-C

- CPU/SW/HW 在支持域内按冻结规则一致；路径交界无裂缝或漏绘。
- feature off 真正零 SW 资源/Pass；feature-on empty 固定成本被单独报告。
- A 微三角形 sweep 给出收益区间和 crossover；B/C 无不可解释回退。
- 没有跨 adapter 通用收益时，默认 HW，并把该结论视为合法 profile 结果而不是强开 SW。
