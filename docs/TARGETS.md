# OEngine 当前目标契约

本文只定义当前阶段要优化的对象，避免把“AAA-like”误写成超大世界或完整游戏引擎。具体数值门槛由 `docs/PERFORMANCE.md` 和 `performance-targets.json` 冻结。

## 目标平台

- 主要性能 profile：桌面浏览器 WebGPU、桌面级独立 GPU。
- 兼容 profile：较低能力 adapter 明确协商 feature/limit，并保持正确 fallback 或清晰拒绝原因。
- 所有 profile 共用一条资源图和正确性 ABI，不形成三档独立管线。

## 目标 workload

- 中大型、高几何密度、静态或 mostly-static 场景。
- 多 geometry、多 material、大量 Packed Instances。
- Opaque 为主，必须覆盖 alpha-tested；Transparency/Decal 为下一层能力。
- PBR/IBL/CSM、动态灯光与 Temporal/Upscaling 逐步形成完整画质闭环。
- 不以世界公里数、超大坐标、地形/植被/角色专用系统作为当前 Gate。

## 必须量化

- CPU：table update、graph/encode、submit 前总时间和 submit 次数。
- GPU：cull/traversal、HZB、HW/SW raster、resolve、lighting、shadow、temporal/post。
- 工作量：instance、BVH node、selected cluster、HW/SW triangle、shaded pixel、material、light。
- 内存：GPU table、geometry/texture resident bytes、transient peak、history、每帧 upload/readback。
- 稳定性：平均、P50、P95、P99、cold compile 与 warm frame。

## 尚待冻结的数字

在下一次正式性能阶段开始前，按目标机器和场景冻结：

- 主要输出分辨率、内部 render scale 和目标帧率；
- 目标 GPU 与最低正确运行 adapter；
- A/B/C 的绝对帧时间和相对 three.js 门槛；
- C 场景的 instance/triangle/material/light 扩展曲线；
- resident/transient memory 与每帧 upload 上限。

未填写数字前可以验证架构和相对变化，但不得宣称已经达到最终“AAA 级性能”。
