# OEngine 当前目标契约

本文只定义当前阶段要优化的对象，避免把“AAA-like”误写成超大世界或完整游戏引擎。具体数值门槛由 `docs/PERFORMANCE.md` 和 `performance-targets.json` 冻结。

## 目标平台

- 主要性能 profile：桌面浏览器 WebGPU、桌面级独立 GPU。
- 兼容 profile：较低能力 adapter 明确协商 feature/limit，并保持正确 fallback 或清晰拒绝原因。
- 所有 profile 共用一条资源图和正确性 ABI，不形成三档独立管线。
- R4-C Software/Hybrid Visibility 是 optional performance profile，不是 R5 correctness/quality 的前置能力。

## 目标 workload

- 中大型、高几何密度、静态或 mostly-static 场景。
- 多 geometry、多 material、大量 Packed Instances。
- Opaque/MASK 已由 R4 core 闭合；R5 将 BLEND Transparency、CSM、Lighting、Temporal/Upscaling 正式迁入同一 Packed 数据面。
- PBR/IBL/CSM、动态灯光与 Temporal/Upscaling 形成当前完整画质闭环。
- 不以世界公里数、超大坐标、地形/植被/角色专用系统作为当前 Gate。

## R5 固定分辨率角色

历史回归 profile 保持：

```text
1280×720
DPR 1
```

用于与 R1–R4 A/B/C artifact 保持可比。

产品质量 profile 从 R5 开始同时采：

```text
1920×1080 output
DPR 1
```

Temporal/DRS 阶段在 1080p output 下增加 `1.00 / 0.85 / 0.67 / 0.50` internal scale sweep。最终目标帧率和绝对毫秒预算必须由目标机器实测后写入 `performance-targets.json`，本文不猜硬件数字。

## 必须量化

- CPU：table update、graph/encode、submit 前总时间和 submit 次数。
- GPU：cull/traversal、HZB、HW/SW raster、resolve、light-cluster、direct/IBL、shadow、transparency、temporal、AO/SSR/post。
- 工作量：instance、hierarchy node、selected cluster、RasterWork、triangle、shaded/transparent pixel、material、light、lights-per-cluster、shadow caster。
- 内存：GPU table、geometry/texture resident bytes、transient peak、history、shadow atlas、每帧 upload/readback。
- 稳定性：平均、P50、P95、P99、cold compile 与 warm frame。
- R5 增量：同 commit/同 GPU 的 `feature-on - feature-off`，不能用跨机器历史绝对值冒充 feature cost。
- 归一化：lighting `ms / 1M shaded pixels`、shadow `ms / 1M caster triangles`、transparency `ms / 1M covered pixels`、temporal/post `ms / output/internal MP`。

## R5 必跑扩展轴

A/B/C 继续作为统一 Renderer 的基础角色，R5 另用同一 C recipe 做参数 sweep：

```text
B-shading-oracle
C-light
C-shadow
C-transparent
C-temporal
C-resolution
```

详细参数见 `implementation/R5-BENCHMARK-MATRIX.md`。

## R5-00 必须冻结的数字

在 G5-L 的正式性能结论前，按目标机器和场景写入 `performance-targets.json`：

- 目标 GPU 与最低正确运行 adapter；
- 1080p output 的目标帧率/总 GPU budget；
- A/B/C 的绝对回归上限；
- light/shadow/transparency/temporal 的 feature-on 增量预算；
- resident/transient/history/shadow atlas memory 上限；
- 每帧 upload/readback 上限。

未填写数字前可以验证架构、正确性和相对变化，但不得宣称已经达到最终“AAA 级性能”或追平特定 reference。
