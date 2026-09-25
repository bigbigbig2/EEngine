---
id: shading-work-v1
kind: spec
owner: shading
---
# ShadingWork V1：可见样本队列

Status: draft

Owners: Visibility & Surface / shading

## Version/Compatibility

本规范只冻结 Phase 2 当前 GPU producer → indirect GPU consumer 的工作协议。当前消费者显示材质记录中的 base-color factor，是**材质发布诊断**；它不是 Surface Radiance、完整材质求值、PBR 或 direct lighting。此队列不复用旧 `ShadingBin` 的 microtile、layout revision 或物理 binding slot。

## Contract

## 身份与布局

`ShadingWorkRecord` 占 8 字节：`pixel: u32` 是内部分辨率线性坐标 `y * width + x`；`visibility_key: u32` 是同帧 VisibilityKey V2。两个字段都仅在本帧和同一 MeshletWork queue generation 内有效，不能当历史身份。队列头占 20 字节，依序为 `attempted: atomic<u32>`、`written: atomic<u32>`、`overflow: atomic<u32>`、`capacity: u32`、`dispatch_x: u32`。CPU/WGSL 唯一事实源是 `ShadingWorkAbi.ts`。

容量为 `width * height`，每个有效 VisibilityKey 最多产生一项；创建前按 `maxBufferSize`、`maxStorageBufferBindingSize` 与 `maxComputeWorkgroupsPerDimension` 协商。超过限制直接拒绝本帧资源方案，不能静默截断。producer 首先初始化头，再以 8×8 workgroup 分类；`atomicAdd(attempted)` 预留索引，超容量时只增加 `overflow`。本配置下容量覆盖所有像素，因此正常 `overflow = 0`；若出现意外超容量，最终 Present 读取 GPU 队列头并将整帧标为错误色，不显示局部结果。无有效 hit 时 `written = 0`，GPU finalize 写零 X 的合法 indirect dispatch。

finalize 在分类 dispatch 完成后读取 `written`，按 64 个元素/workgroup 写三个 `u32` 间接参数 `(x, y, 1)`，并写头部 `dispatch_x`。二维分派保证任一轴不超过协商上限；消费者从 `(group.y * dispatch_x + group.x) * 64 + lane` 求记录索引，超过 `written` 的 lane 不读队列。物理 indirect buffer 同时具备 `STORAGE | INDIRECT`，CPU 不读队列计数决定本帧执行量。

## Producer、消费者与结果边界

GPU producer 读取 VisibilityKey 并写紧凑队列；GPU finalize 写 indirect args；GPU consumer 通过 `dispatchWorkgroupsIndirect` 读取队列、MeshletWork 与当前发布的材质记录。无 hit 的像素由诊断目标 clear 提供背景；无效队列/材质身份写醒目错误色。frame graph 记录上述读写与先后关系。CPU readback 仅能作后续诊断，不能成为本帧消费者。

此 consumer **还没有**消费纹理 bank、重建梯度、法线、PBR、灯光和频率分类，因此不能将其输出标为 `SurfaceProduct.Radiance`，也不能据此删除旧 Surface/Sparse 数学 owner。完成新 Surface material consumer 和 direct lighting 后再依 [执行路线](../next-renderer.md) 切换输出语义、删除旧 owner 与替换旧 claim。

## Validation

`OEngine/tests/contract/shading-work-capacity.test.mjs` 检查协商边界；`node tools/vibe.mjs verify --changed` 验证受影响代码；当前 GPU 闭环通过独立 validation 宿主的 `phase1-visibility` diagnostic case 检查编译、实际帧图、GPU 错误和 device-loss 重建。该 case 只提供诊断，不晋级 Runtime Validated 或画质声明。
