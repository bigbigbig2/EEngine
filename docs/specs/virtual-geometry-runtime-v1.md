# Virtual Geometry Runtime V1

Status: draft

Owners: future geometry residency owner、`GpuAssetStore`、GPU hierarchy/work owner

## Version/Compatibility

本文件冻结语义边界，不冻结尚未实现的 WGSL struct offset。任何 GPU-visible record 在实现前必须补齐字段/stride/align、TypeScript mirror 和 oracle，然后才能把本 spec 提升为 candidate。

V1 消费 [OEGPACK V3](./oegpack-v3.md)，不改变 VisibilityKey、material identity 或 shading ABI。

## Contract

### 物理位置

decoded page 放入固定 256 KiB slot；bank 默认 128 MiB/512 slots。GPU-visible 位置至少表达 `bankIndex + slotIndex/byteOffset + generation + flags`。generation 不匹配视为 non-resident，禁止读取旧 occupant。

### 状态与 publication

逻辑页状态至少区分 non-resident、requested、decoding、uploading、resident 和 retiring/failed。只有校验、upload 和地址表写入完成后才能发布 resident generation；eviction 先撤销可见映射，再等待 submitted-work 安全边界复用 slot。

bootstrap 页在资产可绘制期间 pinned。非 bootstrap 页可以驱逐；任何 desired group 缺页时必须找到 resident ancestor/bootstrap fallback，或 fail closed，不得访问无效地址。

### Demand feedback

GPU traversal 产生 page demand，运行时以 bitset 或等价去重结构聚合。合同必须包含容量、overflow 标志、有效计数和 frame/generation identity。CPU 只读取有界、延迟 feedback 来安排 I/O；最终 work/visibility 仍由 GPU 生成。

优先级至少能表达当前可见缺页、预计 refinement 与后台预取。重复 request 合并；过期 generation、已 resident 页和已取消资产的 request 丢弃。

### I/O、decode 与 upload

source 遵循异步 range-readable 接口。memory/HTTP 是基础适配器；OPFS/cache 可选且失败时退回 source。decode/verify 在有界 Worker/任务池执行，具有最大并发、队列长度、取消和 backpressure。

upload 按帧预算批处理，不为每页独立 submit。默认上限受 [VALIDATION](../VALIDATION.md) 的 8 MiB/frame 约束，改变需 evidence。readback 同样受 256 KiB/frame 上限约束。

### 故障与恢复

range、checksum、decode 或 upload 失败不得发布页；retry 有界并可观测。scene/asset replace 取消旧任务；device loss 使所有 physical location/generation 失效，恢复从 bootstrap 重建。feature-off 不保留 scheduler、feedback、heap 或 readback。

## Validation

候选 ABI 必须具备 CPU mirror/WGSL oracle、capacity/overflow、generation ABA、重复/过期 demand、budget/backpressure、corruption、cancel/replace、eviction race、aborted submit、device loss/recovery 与 feature-off 测试。

MILESTONE 需要真实浏览器证明 `GPU desired LOD -> demand -> async resident -> GPU consumer`，并在缺页全过程持续由 ancestor/bootstrap 输出合法像素。
