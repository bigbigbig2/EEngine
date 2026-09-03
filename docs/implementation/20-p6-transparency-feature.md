# P6：TransparencyFeature 统一透明度 owner 执行记录

状态：Implemented（统一 owner 与 OIT producer/consumer seam 已接入；production 画面/性能 Gate 仍待运行）
阶段：P6 Transparency Forward/OIT
对应设计：[13-product-render-pipeline-redesign.md](./13-product-render-pipeline-redesign.md)
对应上下文：[shading CONTEXT](../contexts/shading/CONTEXT.md)

## 工作包定义

| 字段 | 冻结内容 |
| --- | --- |
| ID | `P6-TRANSPARENCY-FEATURE-01` |
| 目标 | 以单一 `TransparencyFeature` 收拢 Packed MBOIT 与 legacy Forward/OIT 的 owner、生命周期和 FrameGraph 接口。 |
| View 输入 | Depth、Clustered Lighting、Shadow Atlas、GI/IBL、Reflection/环境基线、HDR Scene Color；具体 ABI 由两个 pass 的现有接口冻结。 |
| 输出 | HDR Scene Color；Packed 路径额外输出 Reactive Mask 与 GPU counters，供 Temporal Classification 消费。 |
| GPU producer/consumer | HierarchicalWorkGenerator 生产 Packed secondary raster queue；Packed MBOIT 的 `drawIndirect` moment/forward/composite 直接消费队列；overflow、reactive 和 finite-failure 计数写入同一 frame counter buffer。 |
| 容量/溢出 | 沿用 `GPU_RASTER_WORK_SCHEMA`、`GPU_WORK_QUEUE_HEADER_SCHEMA` 与既有 queue capacity/overflow mask；不新增 CPU 可见列表或 readback。 |
| 生命周期 | `TransparencyFeature` 惰性创建具体 pass；Packed 场景释放调用 `releasePacked`，owner 通过 command completion retirement；destroy 同时回收两条路径。 |
| 关闭语义 | transparency topology 关闭时不创建 OIT pass，不分配 OIT 中间纹理，不产生独立 submit。 |

## 实现内容

- 新增 [TransparencyFeature](../../OEngine/src/render/features/TransparencyFeature.ts)，作为 Renderer 唯一透明度 owner。
- Renderer 删除对 `PackedTransparentOitPass`/`TransparentOitPass` 的直接构造、释放和销毁；Packed/legacy 均经 Feature 接口进入统一主管线。
- 保留 Packed MBOIT 的独立 moment、forward、composite 与 reactive 资源，保留 legacy OIT 的独立资源与合成边界；不改变现有 shader 数学和 queue ABI。
- `packedTransparencyEvidence()` 继续暴露 raster bin、draw、pass、瞬时字节和 motion contract，便于后续 G5-S/G5-P Gate。
- 当前明确不实现 Transmission、Refraction 和透明对象动态 GI；这些仅保留后续扩展边界。

## 开源参考与适配

本包只迁移 owner/lifecycle seam，没有新增算法移植。Packed MBOIT 的算法与 ABI 依据 [R5-03 packed MBOIT ledger](../references/porting/r5-03-packed-mboit-transparency.md)；当前实现继续使用现有 WebGPU indirect producer/consumer，不引入 MDI、mesh/task shader 或 64 位原子。

## 验证记录

已运行：

```text
cd OEngine
npm run build
node --test tests/p6-transparency-feature.test.mjs
npm run audit:shaders
```

未在本包运行：浏览器人工截图、真实 GPU timestamp/overflow 压力和 production 视觉 Gate。原因是本次仅收拢 owner 边界，未修改 OIT shader 数学；G5-S/G5-P 仍需按固定 benchmark 与浏览器 Gate 单独验收。

## 阶段提交约束

代码、合同测试、文档和 shader 审计完成后使用独立中文提交；提交不得包含用户已有的 `three.js` gitlink 修改。
