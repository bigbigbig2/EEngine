# ADR-0007 · 桌面 WebGPU 中大型场景与 Hardware-first 主链

Status: accepted

Supersedes: ADR-0001 的当前产品范围；保留其 GPU-first、WebGPU baseline 和不兼容 three.js 生态决定。

## 背景

早期方向把 OEngine 描述为通用游戏引擎核心，后续研究又把 Nanite streaming、超大世界、完整动态生命周期、专用内容系统和高级 GI 混入当前路线。这使“充分发挥 WebGPU GPU-driven”被扩大成“实现浏览器版完整 AAA/开放世界引擎”。

当前真实目标是中大型、高几何密度、静态或 mostly-static 场景：减少 CPU 驱动，让 GPU 完成 hierarchy/SSE、cull/compact、indirect consumption、Visibility、Material Resolve、Lighting 和 Temporal/Upscaling。

当前代码已经存在一条 WebGPU Hardware consumer：GPU 把可见 Meshlet count 写入 indirect `instanceCount`，固定 `vertexCount=384`，`VisibilityPass` 执行 single `drawIndirect`。文档此前仍把 hardware command consumption 描述为完全未决策，与实现事实不一致。

## 决策

1. 主要性能 profile 是桌面浏览器 WebGPU 和桌面级独立 GPU；较低能力 adapter 先保证明确 capability 结果和正确 fallback。
2. 当前 workload 是中大型高密度、静态或 mostly-static、多资产、多材质和 Packed Instances；不以超大世界坐标、完整 World Partition 或完整 Gameplay 生命周期为前提。
3. 现有 single `drawIndirect` + instance-driven visible Meshlet list 成为 WebGPU Hardware Visibility baseline。R3 负责将 hierarchy 输出接通并量化固定 384 vertices、bucket 和随机读取成本。
4. R4 固定顺序为 Hardware Visibility Contract → Single Material Resolve → optional Compute SW/Hybrid。Software Raster 是 profile optimization，不是正确性前提。
5. CSM 是当前阴影 baseline；优先改进 GPU-driven cascade work、稳定性和过滤，不建设 Virtual Shadow Map。
6. 大量动态灯光、Temporal Reconstruction、Dynamic Resolution、Upscaling、Transparency/Decal 是当前画质扩展；高级 GI、terrain/foliage/character/particle、云、水、大气等留作 deferred 或已有项目迁移。
7. Texture resident bytes、压缩和 mip feedback 先于 Texture Streaming/Virtual Texture；是否实现 streaming 由显存证据决定。
8. 完整动态对象生命周期不是当前产品 Gate，但 GPU Buffer/Texture grow/replace/destroy 的 in-flight 安全仍是底层正确性要求。

## 后果

- `DIRECTION/TARGETS/ROADMAP` 不再用世界尺寸或完整 AAA 功能清单定义完成。
- R2 优先 Compact Runtime Asset、GPU tables、Packed Instances、bulk upload 和少量字段 patch，不扩张完整 ECS/Change Set。
- R4-B Single Material Resolve 提前于 R4-C SW Raster，当前每材质全屏 Material Expand 成为更早删除对象。
- Nanite streaming、3D Tiles、VSM、ReSTIR 等研究移入 `references/deferred`，不能直接生成当前任务。
- 一条主管线和共享正确性 ABI 保持不变；capability adapter 不等于三档产品管线。

## 验证

- R3 证明 hierarchy 输出由 GPU indirect consumer 直接消费，CPU 不遍历最终可见列表。
- 报告 indirect instance、submitted/useful vertex/triangle、固定 384-vertex waste、queue/bucket/overflow。
- R4-B 证明 Material Resolve 不随活跃材质数执行全屏扫描。
- C 场景证明 Packed Instances、多资产/材质、alpha-tested、CSM、动态灯光、Temporal/Upscaling、内存和 feature-off。
- SW/Hybrid 只有在目标 adapter/workload 的 paired benchmark 有收益时默认启用。
