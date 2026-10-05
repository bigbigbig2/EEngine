---
id: shading-work-v1
kind: spec
owner: shading
state: history
verifies:
  - OEngine/src
---
# ShadingWork V1：可见样本队列

Status: retired historical 64-class queue contract. The old owner and sample ABI were removed before the V3 direction; current facts are in [Shading](../domains/shading.md), and the target ABI is defined only when SurfaceWork V3 stabilizes. The following text is not a current execution contract.

Owners: Visibility & Surface / shading

## Version/Compatibility

本规范描述 Phase 2 当前 GPU producer → 按材质类 indirect GPU consumer 的工作协议。消费者执行 Surface 重建、材质求值与基本直接光照；纹理和非零直射已有独立浏览器数值诊断。可选的[频率计划](./shading-frequency-plan-v1.md)已让队列承载 full/2×2/4×4 的代表样本，适用材质仍很窄，整体性能未证明。此队列不复用旧 `ShadingBin` 的 microtile、layout revision 或物理 binding slot。

## Contract

## 身份与布局

`ShadingWorkRecord` 占 8 字节：`pixel: u32` 是内部分辨率线性坐标 `y * width + x`；`visibility_key: u32` 是同帧 VisibilityKey V2。两个字段都仅在本帧和同一 MeshletWork queue generation 内有效，不能当历史身份。队列头占 20 字节，依序为 `attempted: atomic<u32>`、`written: atomic<u32>`、`overflow: atomic<u32>`、`capacity: u32`、`dispatch_x: u32`。CPU/WGSL 唯一事实源是 `ShadingWorkAbi.ts`。

容量为 `width * height`，每个有效 VisibilityKey 最多产生一项；频率计划启用时只有代表样本入队，未启用时每个 hit 入队。创建前按 `maxBufferSize`、`maxStorageBufferBindingSize` 与 `maxComputeWorkgroupsPerDimension` 协商。超过限制直接拒绝本帧资源方案，不能静默截断。producer 初始化队列头和 64 个材质程序类计数器，第一次 8×8 可见性扫描只读真实 MeshletWork/材质发布身份，并按计划跳过非代表样本后做每类计数。身份或容量失败进入 `overflow`，最终 Present 将整帧标为错误色。无有效 hit 时 `written = 0`，GPU finalize 写零 X 的合法 indirect dispatch。

finalize 在分类后扫描固定 64 个计数器，给每类写 `start`、重置散射 cursor、求总 `written`，并按 64 个元素/workgroup 写全局和各类的二维 indirect args。类表共 1024 字节，每项为 `count: atomic<u32>`、`start: u32`、`cursor: atomic<u32>`、`dispatch_x: u32`。indirect buffer 共 1040 字节，首个 16-byte slot 是全局 `(x,y,1,pad)`，之后 64 个 16-byte slot 各有同类参数；类 `i` 的间接 offset 为 `(i+1)*16`。第二次 8×8 可见性扫描通过类 cursor 将每个有效 hit 散射到一份 8-byte-record 紧凑队列。与逐材质全屏扫描不同，两次扫描次数与活跃材质数无关，且无需第二份逐像素队列。当前 Surface 程序分别使用类 args 和 `[start,start+count)` 间接消费。所有 dispatch 维度在创建队列前受设备上限约束。CPU 不读队列计数决定本帧执行量。

## Producer、消费者与结果边界

GPU producer 两次读取 VisibilityKey，GPU finalize 写类区间和 indirect args，scatter 写紧凑队列；GPU Surface consumer 通过各类 `dispatchWorkgroupsIndirect` 读取队列、MeshletWork、Surface/纹理绑定和灯光簇。无 hit 的像素由辐亮度目标 clear 提供背景；无效队列/材质身份写醒目错误色。frame graph 记录上述读写与先后关系。CPU readback 仅能作后续诊断，不能成为本帧消费者。

程序 WGSL 覆盖重建、显式纹理梯度、PBR 和无阴影直接光；浏览器诊断已覆盖纹理、混合材质、近裁剪与非共面 Product。当前常量不透明 unlit factor 与发布时证明为 1×1 的不透明 unlit base texture 可 2×2/4×4；普通纹理和受光类仍 full。Present 依据同一计划对当前帧代表样本做身份安全的空间重建，缺失/故障仍显错；无 temporal reuse。性能净收益与更广泛材质频带仍开放，旧 Surface/Sparse owner 和旧 claim 暂不删除或替换。

## Validation

`OEngine/tests/contract/shading-work-capacity.test.mjs` 和 `shading-frequency-plan.test.mjs` 检查协商边界；`node tools/vibe.mjs verify --module` 验证受影响代码；独立 validation 宿主的 `phase1-visibility` diagnostic case 检查数值材质输出、GPU 频率计划和真实队列计数、空间覆盖、错误显色与 device-loss 重建。该 case 只提供诊断，不晋级 Runtime Validated、Performance 或完整画质声明。
