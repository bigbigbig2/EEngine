# P5：GI、Reflection 与 AO Service 执行记录

状态：Implemented（GI/Reflection/AO owner 边界已接入；画面质量与性能 Gate 仍需 production GPU artifact）
阶段：P5 GI Service + Reflection Service + AO Service
对应设计：[13-product-render-pipeline-redesign.md](./13-product-render-pipeline-redesign.md)
对应 P4：[18-p4-lighting-shadow-composition.md](./18-p4-lighting-shadow-composition.md)

## 工作包定义

| 字段 | 冻结内容 |
| --- | --- |
| ID | `P5-GI-REFLECTION-AO-01` |
| 目标 | 将间接光、反射修正和环境遮蔽接入统一 Lighting Composition，明确 fallback、历史和资源 owner。 |
| 输入 | P3 Surface、P4 Direct HDR、Depth/HZB、Velocity/Validity、Environment、Lightmap/Probe provider 数据。 |
| 输出 | GI diffuse/specular、Reflection correction/confidence、独立 AO visibility/bent normal，以及统一 HDR 结果。 |
| GI producer/consumer | `GIService` 组合 IBL diffuse/specular 基线与后续 LPV/Brick4 provider；`OpaqueLightingPipeline` 的 IndirectComposite 是唯一 HDR 间接光合成入口。 |
| Reflection producer/consumer | `ReflectionService` 调度 SSR trace/prefilter/denoise/temporal，随后由 SpecularCorrection 以 `resolved - baseline` 修正完整 opaque HDR；miss 回退 IBL。 |
| AO producer/consumer | `AOService` 调度 GTAO raw/spatial/temporal/upsample，输出 ambient visibility/bent normal；Lighting 消费 AO，Material AO 不被覆盖。 |
| Fallback | Diffuse：`Lightmap → Probe Volume/LPV → IBL → 无间接光`；Reflection：`Local Probe/IBL baseline → SSSR correction → IBL fallback`。 |
| 生命周期 | AO/Reflection Service 按 topology 和 resolution 配置惰性创建，关闭或重配置通过 GPU completion fence retirement；GIService 随 Renderer 生命周期销毁。 |

## 实现内容

- 新增 [GIService](../../OEngine/src/render/features/GIService.ts)，封装 `OpaqueLightingPipeline` 的 IBL baseline、IndirectComposite 和 provider 接入口。
- 新增 [ReflectionService](../../OEngine/src/render/features/ReflectionService.ts)，封装 SSR pass 与 SpecularCorrection，统一历史纹理、resize、reset 和 correction 输出。
- 新增 [AOService](../../OEngine/src/render/features/AOService.ts)，封装 GTAO pass 的独立 visibility/bent normal 输出和历史生命周期。
- Renderer 迁移到三个 Service owner，删除直接构造 `OpaqueLightingPipeline`、`ScreenSpaceReflectionsPass`、`SpecularCorrectionPass`、`ScreenSpaceAmbientOcclusionPass` 的路径。
- 保持完整 opaque HDR → SSR → delta correction 的顺序；AO visibility、bent normal 与 Material AO 继续独立。
- 新增 P5 合同测试，验证 Service owner、fallback/独立产品和 feature-off retirement 边界。

## 开源参考与适配

本包没有新增算法移植。IBL/BRDF 来源与适配见 `docs/references/porting/R5-01-surface-lighting.md`；SSSR 当前 authored 实现与替代评估见 `R5-Q`/FX-08 记录；GTAO 来源与保留决策见 FX-07 ledger。Service 只迁移 owner/composition seam，不复制算法，不引入额外 submit、readback、每材质扫描或非 WebGPU baseline 能力。

## 正确性、性能与删除边界

- SSR miss、低置信度、越界和粗糙表面继续使用 IBL 连续兜底，不产生黑色覆盖；AO 输出不写回 Material AO。
- GI/Reflection/AO 的 texture、history 和 counters 由各 Service/FrameGraph 归属；关闭时不保留无消费者 owner、history 或 pass。
- 本包不宣称修复 TAA、SSR、GTAO 画质，也不宣称通过 G5-T/G5-P；必须在实际算法变更后运行 browser/GPU timestamp、截图、数值和显存 Gate。
- 旧 Pass 类仍作为 Service 内部算法实现保留；完成 producer/consumer、画面、性能和 lifecycle 验证后，按后续删除任务清理重复旧路径。

## 验证记录

已运行：

```text
cd OEngine
npm run build
npm run build:test
node --test tests/p5-gi-reflection-ao-service.test.mjs
node --test tests/r5-clustered-lighting.test.mjs tests/r5-fx07-ambient-occlusion.test.mjs tests/r5-fx08-screen-space-reflections.test.mjs
npm test
npm run audit:shaders
```

示例验证：

```text
cd examples
npm run build
npm run test:evidence
```

浏览器人工截图和真实 GPU 画面 Gate 未在本包执行；本包只迁移 Service owner/composition seam，不改变 GI/SSR/GTAO 数学。

## 阶段提交约束

代码、测试、文档、shader 审计和验证完成后使用独立中文提交；正文列出三个 Service owner、fallback/独立 AO 语义、GPU producer/consumer、验证命令和未运行的 browser/GPU Gate，并排除 `three.js` 用户现有 gitlink 修改。
