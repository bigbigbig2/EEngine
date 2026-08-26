# 09 · 迁移与删除计划

## 目标

大胆重写当前 reconstructed 主链，但保持每个阶段都有一个可运行的垂直切片。迁移不是长期维护 Legacy/New 两套 Renderer；旧路径只作为短期对照，替代完成后立即删除，由 git 历史和 benchmark artifact 保存证据。

## 原则

- 先记录 R0 基线，再删除可对照的旧主链。
- 新路径必须先接通 producer → consumer，再切默认，最后删除旧 owner/ABI。
- 不为内部 reconstructed/Shade 名称保留 adapter。
- 公开 `OEngine/src/index.ts` 的破坏性变化单独列出；内部变化默认直接迁移调用方。
- 删除范围以真实 `rg` 调用/生成链为准，不能只按文件名猜。
- 被删除功能若仍有研究价值，保留 benchmark/ADR/lesson，不保留死运行时代码。

## 模块处置矩阵

| 现有模块 | 目标处置 | 删除/保留门槛 |
|---|---|---|
| WebGPU device/canvas、`WebGPUTypes` | 保留并重验 | feature/limit、resize、device lost 通过 R1 |
| Pipeline/BindGroup caches | 保留概念，修正 owner/key | cache hit/miss 可测且无 stale resource |
| Buffer/Texture allocators | 保留概念，修正生命周期 | in-flight reuse、grow、device lost 测试通过 |
| `SceneChangeSet` | 深化重构 | WORLD-04 覆盖结构/字段/residency |
| `GPUSceneContext`/`SceneDatabase` | 迁移到 GPU Render World | 新表接通后删除重复 record/submit owner |
| `MeshletGeometryBase`/`niMeshlets` runtime 格式 | 用 Cooker v1 替换 | COOK-10；程序化几何走同 schema |
| `GeometryBlasPool` | 按 BVH8/ResidentGeometry 重写或删除 | COOK-09/WORK-04 |
| `MeshletDrawList` | 删除 | WORK-08 新 HW 垂直闭环通过 |
| `MaterialMeshletDrawList` | opaque 删除；透明/阴影迁移 | FX-04/FX-05 新 work consumer 接通 |
| `VisibilityPass` | 由 WorkGenerator + HybridVisibility 替换 | VIS-10 |
| `HierarchicalZBuffer` render 实现 | Compute 重写 | R1-C01～C06 正确性/性能通过 |
| `MaterialExpandPass` | 删除 | MAT-10 单次 Resolve consumers 迁完 |
| 独立 opaque `VelocityPass` | 合并/删除 | MAT-06；特殊对象需求单独证明 |
| `Renderer.render()` 编排 | 重写为 FrameCoordinator + cached graph | R1-A02～A07、R1-B01～B06 |
| `ShadeGPUCommandContext` 隐式 submit | 删除或降为 encode-only façade | R1-A02、R1-A07 |
| oracle/generated shaders | 逐个追溯 source-of-truth | OBS-07 后，无 consumer/generator 者删除 |
| Lighting/Shadow/Transparency/Post 算法 | 隔离、逐项重接 | FX-01..12；存在不等于默认启用 |
| LPV/Brick4/NSS/SDF/volumetrics | 可选节点，默认断开直到验证 | off 零成本、owner/history/counters 完整 |
| Path tracer | reference/tool 或后续明确入口 | 不进入实时稳定帧，不污染主 graph |
| package 名与 Shade 历史符号 | 分波次改名 | 公共 API/资产版本有明确迁移说明 |

## 计划中的目标模块边界

最终目录不要求一次性搬家，职责应逐步收敛为：

```text
src/assets/                    Runtime Asset schema/reader/registry
tools/cooker/                  offline cook/validate
src/world/ or src/scene/       Application World + RenderChangeSet
src/gpu/world/                 stable tables/residency/upload
src/render/work/               instance/hierarchy/classification queues
src/render/visibility/         HW/SW/Hybrid + unified attachments
src/render/material/           single resolve + surface ABI
src/render/lighting/           lights/IBL/shadows
src/render/effects/            transparency/temporal/post feature nodes
src/framegraph/                compiled topology/resource lifetime
src/debug/                     profiler/counters/debug views
```

具体命名要遵守局部 `AGENTS.md`，但不得重新把资产、GPU World、工作生成和材质解析塞回一个巨型 Pass。

## 删除波次

### DEL-00 · 保存基线与 source map

依赖命中场景在迁移前完成一次 clean/full 基线刷新。保存基准 artifact、graph dump、shader source map 和关键截图。建立一个可定位的 git commit/tag 作为历史对照；不复制整套 Legacy 源码到新目录。

### DEL-01 · 清提交与图旁路

依赖 `R1-A07`、`R1-B06`、`R1-C06`。删除稳定帧独立 encoder/submit、无条件 animation flush、每帧统计 readback、每帧 main graph build/compile、逐 mip HZB render pipelines 和无 owner history。

### DEL-02 · 清旧资产/世界 owner

依赖 `WORLD-10`、`COOK-10`。删除 Loader GPU owner、旧 Meshlet runtime layout、重复 GPUScene tables/address maps 和无法通过 device lost 重建的 cache。

### DEL-03 · 清旧工作生成与 Visibility

依赖 `WORK-10`、`VIS-10`。删除旧 bucket/expand/prefix-scan/scatter/second-chance 主链、旧 mesh/triangle ID attachments、旧 visibility shaders 和 runtime switch。

### DEL-04 · 清 Material Expand

依赖 `MAT-10`。删除 material depth、每材质 fullscreen pipeline/bind groups、旧 GBuffer-only helpers 和 opaque 独立 Velocity。

### DEL-05 · 清效果旁路与历史命名

依赖 `FX-12`。删除旧效果对 MeshletDrawList/MaterialExpand/HZB 的 adapter、无 consumer pass/shader/resource。随后逐步把 public/package/internal Shade 名称改为 OEngine 领域名。

## 每次切换的垂直步骤

任何主模块替换都按同一顺序：

1. 在旧输出旁建立新 ABI 的最小 producer；
2. 增加 debug/CPU reference 比较，不影响默认输出；
3. 让一个真实 consumer 读取新 ABI；
4. 用同一场景、同一帧输入比较旧/new；
5. 新路径成为默认，旧路径只保留临时验证开关；
6. 迁移所有 consumers；
7. 删除开关、旧 producer、旧资源、旧 shader 和旧统计；
8. `rg` 确认无死引用，运行完整验证。

不允许在第 5 步后长期停留。若消费者迁移规模过大，先缩小新 ABI 的切换范围，而不是永久双写。

## Shader 删除清单方法

`OBS-07` 生成清单后，每个 shader 标为：

- `authored-live`：真实 pipeline 直接使用；
- `generated-live`：有仓库内 generator/source；
- `oracle-reference`：仅用于核对，设删除截止任务；
- `dead`：无 pipeline consumer，立即删除；
- `unknown`：阻塞对应模块迁移，必须追到 pipeline 创建点。

删除 `.generated.ts` 时同时删除或调整 generator；保留生成物时必须让 CI 能检测陈旧输出。

## 数据/资产迁移

- Runtime package v1 不猜测加载旧 reconstructed 二进制；旧源资产重新 Cook。
- 若用户拥有无法重建的唯一旧资产，先写一次性离线 converter，并在迁移结束删除 runtime converter。
- GPU handle/table ABI 不做跨帧兼容；切换时整表重建并 invalidate histories。
- Benchmark result schema 只追加版本字段或提供显式 converter，避免历史数据失去可比性。

## 回退策略

代码回退依赖版本控制，而不是在 runtime 永久保留 Legacy。只有阶段内短期允许开关：

- 新路径 correctness 失败：切回最近已通过 gate 的 commit，修新路径；
- 新路径性能失败：保留数据，定位减少/增加的工作；若架构假设被否定，新增 ADR；
- asset ABI 失败：拒绝 package 并重新 Cook，不在 shader 猜格式；
- 已删除高级效果尚未迁移：保持 feature unavailable/disabled，不恢复旧主链拖累核心。

## 删除验收

每一波必须证明：

- `rg` 无旧类、旧 shader、旧 feature flag 和旧 attachment 的 live consumer；
- build/test 与 A/B/C 通过；
- graph dump 无旧 Pass/resource；
- package/bundle 不再包含死 shader；
- public export 没有悬空类型；
- `CURRENT-STATE` 不再把已删除路径写成存在；
- 删除了什么、替代是什么、能否通过 git 恢复写入交付说明。
