# P3：Visibility → Surface 统一合同执行记录

状态：Implemented（Packed 主链 Feature 边界已接入；普通 Scene legacy consumer 的最终删除留待后续迁移）
阶段：P3 GPU Visibility、Surface Contract 和 Material Resolve
对应设计：[13-product-render-pipeline-redesign.md](./13-product-render-pipeline-redesign.md)
对应 P2：[16-p2-scene-contract-and-config.md](./16-p2-scene-contract-and-config.md)

## 工作包定义

| 字段 | 冻结内容 |
| --- | --- |
| ID | `P3-VIS-SURFACE-01` |
| 目标 | 将 Packed GPU work generation/Hardware VisibilityKey 与单次 Material Resolve 的 Surface 输出收拢到明确的 Feature 边界。 |
| 依赖 | R3-D hierarchy producer、R4-A VisibilityKey v2、R4-B MaterialRecord/Surface ABI、P1 Render Feature、P2 RenderFrameContract。 |
| 当前入口 | `PackedVisibilityPass`、`PackedMaterialResolvePass`、`Renderer` 主图构建、`GpuVisibilityKeyAbi`、`GpuSurfaceAbi`。 |
| 改动边界 | 新增 `VisibilityFeature` 与 `SurfaceFeature` 组合边界并迁移 Renderer owner；不修改已验证的 hierarchy、VisibilityKey、Surface 数学和 GPU ABI。 |
| Producer | `VisibilityFeature` 持有 Packed Visibility 实现：GPU hierarchy/work generation 写 RasterWork/indirect record，Hardware consumer 写 VisibilityKey/depth；`SurfaceFeature` 持有 Resolve：GPU classifier/indirect kernel draw 写 Surface attachments/velocity/metadata。 |
| Consumer | FrameGraph 的 direct/alpha Visibility、Material Resolve、Lighting/AO/SSR/Temporal/debug 读取相同的 Key、Depth 与 Surface 资源；Renderer 证据读取 Feature 计数。 |
| ABI/容量 | VisibilityKey v2 仍为 32-bit `r32uint`（empty/reserved/max sentinel 不变）；Surface ABI v1 保持 26 B/pixel（velocity-off 为 22 B/pixel）；RasterWork 与 MaterialRecord 容量/overflow 沿用 R3/R4 合同。 |
| Overflow | hierarchy/indirect capacity 在 producer 前检查，all-or-nothing queue reservation 和 invalid key counter 保持；Resolve kernel/classifier 使用有界 capacity，invalid/fallback/gradient fallback 计数不静默截断。 |
| Owner/Lifetime | `VisibilityFeature` 唯一持有 PackedVisibilityPass 及其 prepared hierarchy/debug binding；`SurfaceFeature` 唯一持有 PackedMaterialResolvePass/classifier；资源由 FrameGraph 管理，release/destroy 继续等待 owning command 的 GPU completion。 |
| Upstream | 本包没有新增算法移植。R3/R4 既有算法来源、许可证、不变量和 WebGPU 差异分别见 `docs/references/porting/`；本包只做 owner/composition seam 重构。 |

## 实现内容

- 新增 `VisibilityFeature`，以 Feature owner 形式封装已验证的 Packed Visibility producer/Hardware consumer，并转发 release、destroy、准备证据和 `drawIndirect` 统计。
- 新增 `SurfaceFeature`，以 Feature owner 形式封装一次 Packed Material Resolve；Surface/velocity/metadata 输出继续通过 `GpuSurfaceAbi` 统一定义。
- Renderer 不再直接构造 `PackedVisibilityPass` 或 `PackedMaterialResolvePass`，而是构造 `VisibilityFeature`/`SurfaceFeature`；FrameGraph、GPU work generation、indirect draw 和 counters 仍使用原生产路径。
- Feature-off 逻辑保持在主图拓扑与 FrameGraph pruning：没有 Packed consumer 时不创建 VisibilityKey/Surface owner；稳定帧不增加 submit、readback 或额外 command encoder。
- 新增 P3 源码合同测试，验证 Feature owner 接线、GPU producer→consumer、单次 Resolve draw 和 feature-off 边界。

## 正确性与性能 Gate

- Opaque/Alpha Visibility 仍从 GPU RasterWork 直接消费 `drawIndirect`，CPU 不读取 count 生成最终可见列表。
- Resolve draw 不随 active material 数增长；Surface bytes、invalid key、fallback、reactive、gradient fallback 继续由现有 counters/debug 验证。
- Surface 只写 Material AO、emissive、normal、velocity、metadata，不把 GTAO 合并回 Material AO；后续 Lighting/AO 服务继续独立消费。
- 本包不宣称修复 TAA/SSR/SSAO 画质，也不宣称解决 R4 Hardware Raster/Resolve 性能风险；必须使用后续 P4–P8 的同条件 GPU/截图 Gate。

## 验证记录

已运行：

```text
cd OEngine
npm run build:test
node --test tests/packed-material-resolve.test.mjs tests/packed-visibility-r4.test.mjs tests/hierarchical-work-generator.test.mjs
node --test tests/p3-visibility-surface-feature.test.mjs
npm run build
npm run audit:shaders
npm test
```

示例验证：

```text
cd examples
npm run build
npm run test:evidence
```

浏览器人工截图/真实 GPU Gate 未在本包执行；本包只迁移 owner/composition seam，不改变画面算法，首个画面变化阶段必须重新采集 production artifact。

## 删除与后续迁移

本包没有删除普通 `Scene` 的 `MaterialExpandPass`，因为当前仍有真实 legacy consumer；也没有删除 `PackedVisibilityPass`/`PackedMaterialResolvePass` 实现，它们现在由 Feature owner 唯一持有。P3 后续工作必须把普通 Scene consumer 迁移到统一 Packed/Surface 合同，验证 producer/consumer、lifetime、overflow、画面和性能后，在同一工作包删除旧类、旧 shader 和旧配置，禁止长期双路径。

## 阶段提交约束

代码、测试、文档和验证完成后使用独立中文提交，正文列出 Feature owner、ABI 未变更边界、GPU producer/consumer、验证命令和未运行的浏览器 Gate；排除 `three.js` 用户现有 gitlink 修改。
