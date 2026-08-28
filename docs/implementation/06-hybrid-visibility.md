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

工作项已于 2026-08-28 验收，治理状态为 `Integrated`。生产 `PackedVisibilityPass` 继续直接消费 R3 `RasterWork + 16 B drawIndirect`，在同一次 Hardware draw 中新增 `r32uint VisibilityKey v1` MRT，并保持 `depth32float / clear 0 / greater` reverse-Z；当前帧没有 count readback、额外 submit 或第二次几何 draw。旧 triangle/instance MRT 只为尚未迁移的 Material/Velocity consumer 临时保留，是 R4-B 的显式删除对象，不是第二套 Visibility contract。

`VisibilityKey` 由 FrameGraph transient texture owner 创建，descriptor 冻结 width/height/format/usage，随 graph signature/resize 重建并由资源池回收；Packed feature 不进入 graph 时不创建该 attachment。device lost 后只允许随 `GraphicsContext/Renderer` 重建恢复，不保留跨 device handle；对应 live device-lost/in-flight 压力测试仍属于 `R4-A-05`。producer 在 hierarchy prepare 前用 VisibilityKey 与 adapter storage-buffer limit 校验 RasterWork capacity，失败明确抛错，不 mask/truncate。

采样帧的 `VisibilityCounterPass` 已按 `legacy-id | visibility-key-v1` 双 contract 工作，`shadedPixels` 作为 final useful fragments，新增 `invalidVisibilityKeys` 统计 reserved-slot marker。当前 WebGPU baseline 没有已协商的 pipeline-statistics producer，因此 submitted fragments 明确登记为 `unsupported / WEBGPU-01-PIPELINE-STATISTICS`，不伪造 submitted/useful 比例。`examples/r4-hardware-opaque-producer` 的真实 Chrome WebGPU 门禁已通过：GPU work 写出 `[384, 1, 0, 0]`，有效/empty 像素为 `6820/69980`、invalid/unresolved/depth mismatch 均为 `0`、visible reverse-Z depth 为 `0.025`，WGSL/validation/uncaptured diagnostics 为空；本地 JSON 与截图保存于 `temp/r4-a-02/`。生产 Renderer 的 Benchmark A smoke 也完成 3 个 sampled frame，均导出 `invalidVisibilityKeys=0`，且 validation/uncaptured/device-lost/timestamp/counter diagnostics 全为 `0`；它因 smoke profile 与既有 Software Visibility blocker 不具备 Gate 资格。这只关闭 opaque producer 工作项，不关闭 alpha、debug Resolve、lifecycle Gate 或整个 G4-A。

- Packed Hardware vertex/fragment path 写 `VisibilityKey v1 + reverse-Z depth`。
- 继续消费 R3 `RasterWork + drawIndirect`；当前帧不得 readback count。
- 定义 attachment owner、FrameGraph lifetime、resize/device-lost 和 feature-off 行为。
- 增加 submitted/useful fragments 可观测值（能力允许时）与 invalid-key counter。

### R4-A-03 · Material Visibility 与 alpha-tested

工作项已于 2026-08-28 验收，治理状态为 `Integrated`。`GpuMaterialVisibilityAbi.ts` 冻结 64 B `MaterialVisibilityRecord v1`：`materialId/alphaMode/flags/textureRef`、`baseColorFactorAlpha/alphaCutoff/uvSet/samplerClass`、`offset+scale` 与 `cos/sin rotation`；invalid texture sentinel 为 `0xFFFFFFFF`。opaque 不读取 alpha，mask 在 fragment discard 后才写 key/depth，blend 全部排除出 opaque Visibility；invalid/未驻留纹理和缺失 UV 都只使用 factor alpha，不随机采样，也不静默强制 opaque。

`GpuMaterialVisibilityTable` 是 R4-A 的有界临时 owner：随首个 Packed Scene staging 惰性创建，容量为 4,096 个 material record 与 256 个 64×64 alpha tile，固定资源约 `256 KiB + 4 MiB`；material handle 超界在 staging 前明确失败，纹理无效或 tile 容量不足记录 fallback 并继续 factor-only。owner 不私有 submit，stage 写入调用方 command，abort 回滚 CPU residency 状态，随 `GraphicsContext`/device 销毁；`R4-B-02` 必须接管或无损映射并删除该临时表。Packed feature 从未 staging 时资源成本为零。

为避免超过 WebGPU baseline `maxStorageBuffersInVertexStage=8`，没有新增 vertex storage binding。内部 Geometry GPU ABI 升级为 v2/160 B，在已有 record 中增加 `uv0/uv1 byteOffset/stride/format` fast path，支持 `float32x2` 与 glTF 合法的 normalized `uint8x2/uint16x2`；device-independent Geometry Package ABI 不变。vertex 从现有 `vertexStreamData` 同时输出 UV0/UV1，fragment 只增加一个 Material storage table 与一个 alpha atlas texture binding；sampler address/filter 由 record 手动执行 clamp/repeat/mirror 与 nearest/linear，非法 sampler 使用冻结的 linear-repeat fallback。`KHR_texture_transform` 按 glTF 的 scale → rotation → offset 语义解析，extension `texCoord` 覆盖 texture info `texCoord`。

生产 `PackedVisibilityPass` 仍只有一个 GPU `RasterWork → drawIndirect → VisibilityKey/depth` producer，没有 current-frame readback、CPU 最终可见对象循环或 per-material draw。`front_facing` 与 object-to-world 3×3 determinant 一起处理 mirrored winding；double-sided 跳过单面 discard。旧 CPU material bucket 仍只可作为画面 oracle，未接回 Packed producer。

`examples/r4-alpha-tested-visibility` 的真实 Chrome WebGPU 门禁使用 8 个 RasterWork slot 和一次 `[384, 8, 0, 0] drawIndirect`：opaque/mask-texture/mask-factor/blend/double-sided/mirrored/invalid-texture/sampler-fallback 像素分别为 `2892/2177/0/0/2913/2849/2850/1440`；invalid key 与 depth mismatch 为 `0`，WGSL compilation、validation、uncaptured 与 device-lost diagnostics 均为空。JSON、整页截图和 canvas screenshot 保存于 `temp/r4-a-03/`。该证据关闭 alpha producer，不关闭 R4-A-04 debug Resolve、R4-A-05 lifecycle 或 R4-A-06 paired Gate。

- 冻结 `MaterialVisibilityRecord` TS/WGSL layout 或到现有 material table 的无损映射。
- 从 GPU record 完成 alpha factor/texture/UV transform/cutoff discard。
- 覆盖 opaque/mask/blend classification、double-sided、mirrored transform、invalid texture 和 sampler fallback。
- CPU per-material bucket 只能作为迁移 oracle；生产 Packed alpha consumer 不得按最终可见对象回读或循环提交。

### R4-A-04 · Hardware debug Resolve

工作项已于 2026-08-28 验收，治理状态为 `Integrated`。生产 `RenderDebugView.VisibilityKey` 在 Packed 路径切换为单个全屏 debug pass：直接读取 Hardware producer 本帧写出的 `VisibilityKey`，并消费同一组 `RasterWork`、`VisibleCluster`、Meshlet、Instance 与临时 Material Visibility GPU table；没有第二次工作生成、几何 draw、CPU 可见列表、readback、独立 encoder 或 submit。legacy Scene 继续使用原 mesh/triangle ID debug shader，不建立平行的 Packed debug 架构。

`GpuVisibilityDebugResolve.ts` 冻结 32 B settings ABI、15 个状态和 14 组 fail-visible color。lookup 依次检查 empty/reserved key、RasterWork queue written/physical range、VisibleCluster queue written/physical range、Cluster、Meshlet、triangle、Instance active、Geometry、Instance/VisibleCluster identity、Material valid 与 blend-in-opaque；最大合法 key 会稳定落入 RasterWork 越界色。有效像素对 RasterWork/VisibleCluster/Meshlet/triangle/instance debug ID/geometry/cluster/material identity 做稳定哈希，mask 与 double-sided 叠加可识别 tint。

debug source 只暴露 `PackedVisibilityPass` 当帧已经生成并由 Hardware draw 消费的 buffer；Packed runtime release/destroy 时清除引用。debug 关闭时 `MainFrameFeatureTopology` 不添加 pass、输出纹理、32 B transient uniform、readback、encoder 或 submit；开启时只新增一个 `rgba16float` 输出与执行期 transient uniform，FrameGraph 对 `VisibilityKey` 的 read 建立 producer → debug consumer 顺序。

`examples/r4-debug-resolve` 使用带 `MASK`、alpha texture、double-sided 与 `KHR_texture_transform` 的静态 glTF，真实经过 `load_gltf_packed → Cooker → uploadPackedScene → production Renderer`。Chrome WebGPU 生产画面保存了 alpha cutout ID heatmap；同页使用生产 authored WGSL 注入 empty、reserved、maximum-valid key 与 RasterWork/VisibleCluster/Cluster/Meshlet/triangle/Instance/active/Geometry/identity/Material/blend 全部异常层级，16 个 case 全部命中冻结颜色，WGSL compilation、validation、uncaptured 与 device-lost diagnostics 为零。JSON、整页截图和 canvas screenshot 保存于 `temp/r4-a-04/`。该证据只关闭 debug Resolve，不关闭 `R4-A-05` lifecycle/overflow、`R4-A-06` paired Gate 或整个 G4-A。

- 单次 debug pass 从 key 回查 RasterWork/VisibleCluster/Meshlet/Instance/Material。
- 对 empty/invalid/max key fail-visible，debug 模式记录具体越界层级。
- 保存 ID heatmap 和至少一个真实 glTF alpha fixture screenshot。

### R4-A-05 · Overflow、生命周期与 feature-off

工作项已于 2026-08-28 验收，治理状态为 `Integrated`。生产 `PackedVisibilityPass.prepareHierarchy()` 在调用 `HierarchicalWorkGenerator.prepare()` 前统一执行 `validatePackedVisibilityPreparation()`：同时检查 VisibilityKey v1 的 25-bit RasterWork slot 上界、`maxBufferSize`、`maxStorageBufferBindingSize` 与 32 B queue header，并保存 required capacity/bytes 和 key/adapter/effective capacity 证据。失败直接抛出 `RangeError`，不会调用 generator、创建 frame-local queue、编码 producer 或截断高位；exact boundary 可以通过同一函数验证而不分配对应大 Buffer。

prepared hierarchy cache 仍以 runtime + counter buffer + asset/scene epoch + SSE/counter mode 为 identity。epoch replacement、Packed runtime release 统一通过 `ShadeGPUCommandContext.destroyAfterGpuDone()` 退休旧 work；即使 replacement/release command abort，也必须等待 `queue.onSubmittedWorkDone()` 后才销毁可能被先前 submission 引用的资源。`ViewManager.remove()` 先从 lookup 删除 view，再按相同 fence 退休 HZB/history；下一次 `obtain()` 创建不同 view owner。resize 进入 VisibilityKey descriptor/FrameGraph key，并由 HZB revision 标记 `resize`；`indicate_view_change()` 增加 camera revision，使 previous HZB 以 `camera-cut` fail-open。

device lost 边界保持显式：当前 Renderer 收到 `device.lost` 后只返回 `false` 并停止渲染，不复用旧 adapter/device/resource；恢复由 fresh `Renderer/GraphicsContext`、fresh adapter/device 和 device-independent cooked package 重新上传完成。intentional `device.destroy()` 只验证 `reason=destroyed` 的停止/重建路径，不伪装成浏览器无法可靠注入的 `unknown` recovery。

counter sampling 关闭时不 import GPU counter buffer、不创建 `VisibilityCounterPass`、不编码 reducer/readback；debug 关闭时不创建 debug pass/output/uniform/readback。Packed runtime 仍保留 hierarchy shader binding ABI 必需的 256 B `disabled-counter-sink`，但它没有可选 reducer、每帧 clear/copy、readback、独立 encoder 或 submit。`examples/r4-visibility-lifecycle` 的 Chrome WebGPU 结果为 `passed=true`：feature-off frame `readbacks=0`、counter sampled=false；sampled frame `queueOverflowMask=0`、`invalidVisibilityKeys=0`；resize `768×432 → 640×360`、camera invalidation `1 → 2`、view id `0 → 1`；提交后立即 release/re-upload Packed Scene 成功。目标 adapter 的 effective capacity 为 VisibilityKey 上界 `33,554,431`，exact boundary 为 `268,435,480 B`，`33,554,432` 在零分配验证中明确失败。intentional device destroy 后旧 Renderer 停止，fresh NVIDIA Turing Renderer 连续 3 帧零 validation/uncaptured/device-lost diagnostics。JSON、整页截图和 canvas screenshot 保存于 `temp/r4-a-05/`。该证据关闭 lifecycle/overflow 工作项，不关闭 `R4-A-06` paired Gate 或整个 G4-A。

- RasterWork/key capacity 不足必须 prepare 失败或明确 fallback，不截断画面。
- resize、camera cut、view recreate、device lost 和 in-flight replacement 有测试。
- debug/counter sampling 关闭时不保留无消费者 reducer/readback。

### R4-A-06 · Paired 浏览器 Gate

工作项已于 2026-08-28 验收，治理状态为 `Integrated`。A/B/C 继续运行各自冻结 manifest、production `Renderer.render()`、同一 Packed hierarchy 主链与既有 Material Resolve final-color oracle；Gate 只添加完成后的浏览器 capture hook，不建立 benchmark 专用 Renderer、替代 producer 或第二条提交路径。每组固定为 `1280×720`、DPR 1、60 warm-up + 180 sample，GPU timestamp/counter 每 6 帧采样。

Gate artifact 同时验证 clean provenance、full profile、冻结 cadence、steady frame 单 submit、每帧一次 Packed `drawIndirect`、`r32uint` Key attachment 字节、sampled useful/empty 像素分区、zero invalid key/overflow、Hardware timestamp phase 和全部 WebGPU diagnostics。完成采样后，在相同 scene ordinal 上分别渲染 final-color oracle、`VisibilityKey` GPU lookup heatmap 与 reverse-Z depth；每个 capture 等待自身显式工具帧完成，但不修改被统计的 180 个 steady sample。JSON、三种 canvas screenshot 与整页截图保存于 `temp/r4-a-06/full/`，`temp/` 不纳入 Git。

Packed `alphaClusters` 不再伪填零：只在 counter sampled frame 编码一个 64-lane GPU reducer，从真实 `RasterWork → VisibleCluster → MaterialVisibilityRecord` 统计 `MASK` RasterWork 子集；它不读取本帧 count 决定渲染、不创建私有 encoder/submit，也不在 counter-off frame 存在。C 的 127 个 Hardware RasterWork 中有 40 个 alpha-tested RasterWork；A/B 为真实零。

最终 A/B/C 均满足 `invalidVisibilityKeys=0`、`queueOverflowMask=0`、`shadedPixels + emptyVisibilityPixels = 921,600`、一个 main submit、一个 Packed drawIndirect，并且 validation/uncaptured/device-lost/timestamp/counter failure 与浏览器 console/page error 全为零。oracle/key/depth 三种截图轮廓一致，无 blank output、明显孔洞或 depth/key silhouette 分离。`capabilityComplete=false` 仍只来自后续 `VIS-05` Software Visibility，不阻塞 Hardware G4-A；submitted fragments 继续诚实登记为平台能力 `unsupported / WEBGPU-01-PIPELINE-STATISTICS`。

该 Gate 发现必须保留的性能风险：相对 clean R3 `aff3ab8` 的 A/B Hardware Raster P50 约 `10.486/10.355 ms`，R4-A full 重跑约升至 `35–44 ms`，B 另有一次 `P95=60.679 ms / P99=84.260 ms` 长尾；RasterWork 数量仍约为 `273,750/281,191`，因此不能用工作量变化解释，也不能宣称 R4-A 性能改善。高概率热点是 R4-A-03 fragment 的 Material Visibility lookup/alpha 分支，但运行间波动和 adapter/browser 稳定性也必须由后续同条件单变量 profile 排查；R4-B 不得把这段成本静默并入 Single Resolve 数据。

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
