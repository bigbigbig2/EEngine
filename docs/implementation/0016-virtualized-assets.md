# 0016 Virtualized Assets 实施

Status: active

Owners: asset cooker/runtime、`GpuAssetStore`、GPU hierarchy/work/visibility、texture residency、validation host

## Outcome

以 OEGPACK V3 和渐进纹理 residency 扩展现有唯一生产管线：首帧有可绘制 bootstrap/mip tail，后续细节由 GPU demand 和有界异步调度提升；不复制 renderer，不用 CPU 生成最终可见列表。

## Slices

| Slice | 可运行结果 | 退出证据 | 完成后删除/收敛 |
| --- | --- | --- | --- |
| S1 V3 bootstrap consumer | native cooker 产物经 TS parser/bootstrap upload，进入现有 hierarchy/work/raster 并输出真实 Visibility 像素 | golden/corruption + browser screenshot/readback + GPU diagnostics | 删除仅为 bootstrap proof 存在的旁路；OEGPACK spec 可冻结 |
| S2 LOD demand/fallback | GPU 选择 desired LOD；缺页时画 resident ancestor 并写去重 demand | SSE oracle、fallback 连续性、queue capacity/overflow/counter | 删除 CPU 选择最终 meshlet 的任何临时 seam |
| S3 async residency loop | feedback 驱动 range/decode/verify/batched upload/generation publish，下一帧 GPU 直接消费 | I/O failure、budget、backpressure、stale demand、真实 refinement 像素 | 合并 bootstrap owner 与正式 page heap，删除重复地址表 |
| S4 lifecycle/eviction | slot 回收、取消、replace、aborted submit 和 device loss 均不暴露旧页 | generation ABA、retire boundary、recovery、feature-off | 删除无限缓存和同步等待 fallback |
| S5 geometry cutover | main view、shadow、普通 Scene adapter 全部消费 V3；生产 graph 无 V2 geometry path | source + compiled graph/shader + browser topology/counter + PERF | 删除被替换 V2 geometry package/上传/consumer；无永久 switch |
| S6 progressive texture | mip tail 首帧可采样，高 mip 按预算 promotion/eviction，binding identity 稳定 | sampling/readback、compressed alignment、lifecycle、画质/内存/PERF | 删除 runtime mip generation 或整纹理重传的命中旧路径 |
| S7 optional cache | 仅当 profile 证明 source/decode 是瓶颈时加入 OPFS/内容缓存 | cold/warm、quota/eviction/corruption、cache-off parity | 无证据则不实施，不把 cache 设为 correctness 依赖 |

## Slice rules

### S1 before general infrastructure

先接通一个真实生产 consumer，再冻结地址和资源布局。测试专用 upload 成功不算 S1；像素必须由现有 `MeshletBucketRaster -> VisibilityKey -> sparse shading` 路径产生。

### B/C interleave

Residency（ADR-0016-B）与 renderer consumption（ADR-0016-C）按 S2/S3 交错推进。不得先造一个没有 consumer 的完整 scheduler，也不得先用整包常驻伪装 streaming 完成。

### Cutover

S5 前允许受控开发开关做对照，完成后只保留 V3 生产路径。删除需满足 [VALIDATION](../VALIDATION.md) 的三层审计；未命中的 legacy consumer 不能因“代码更干净”提前删除。

### Texture scope

S6 复用 TextureAssetPackage、GPU-native variant、TextureResidency 和 TextureBindingSet。是否需要新 container 由 partial range/identity 证据决定；Virtual Texturing 不在本实施文档中。

## Shared gates

- 所有 queue/table 有 ABI、capacity、overflow、producer、consumer 和 counter。
- upload/readback、resident/transient 内存遵循 VALIDATION 预算，超限需同条件证据和决策。
- bootstrap/ancestor 与 mip tail 在 I/O 失败时仍产生合法输出。
- scene replace、camera cut、feature toggle、异步取消、aborted submit 和 device loss 不发布过期 generation。
- 每个 slice 先 DEV，再由 ADR-0014 宿主完成命中 MILESTONE；只有性能声明才进入 PERF。
- 当前完成度只更新 [STATUS](../STATUS.md)，不在本页累积逐提交记录。
