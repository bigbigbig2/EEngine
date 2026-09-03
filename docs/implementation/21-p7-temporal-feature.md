# P7：TemporalFeature、TAAU 与 DRS 执行记录

状态：Implemented（Temporal owner/lifecycle 已统一；最终 TAAU 画质和 G5-T/G5-P GPU Gate 仍待 production 验收）
阶段：P7 Temporal Reconstruction、TAAU 和 DRS
对应设计：[13-product-render-pipeline-redesign.md](./13-product-render-pipeline-redesign.md)
对应参考：[R5-04 temporal/upscale ledger](../references/porting/R5-04-temporal-upscale.md)
对应上下文：[shading CONTEXT](../contexts/shading/CONTEXT.md)

## 工作包定义

| 字段 | 冻结内容 |
| --- | --- |
| ID | `P7-TEMPORAL-FEATURE-01` |
| 目标 | 以单一 `TemporalFeature` 收拢 TAA/TAAU、Temporal Classification、颜色 history、jitter 与 DRS 控制边界。 |
| 输入 | Opaque/Final HDR、Depth、Velocity、Disocclusion Confidence、Reactive Mask、Surface Metadata、internal/output resolution 与 jitter。 |
| 输出 | 重建后的 HDR Scene Color、rgba16float output-resolution color history；classification 输出 Reactive/Motion validity，供 Temporal consumer 使用。 |
| GPU producer/consumer | `TemporalClassificationPass` 生产 transient classification；`TemporalAntiAliasingPass` 或 NSS 消费 current/history/velocity/depth/classification 并写入 history output；所有工作继续进入同一 FrameGraph 与主 command submit。 |
| History owner | `TemporalHistoryRegistry` 继续作为 submitted-aware CPU 状态真相；`TemporalFeature` 独占两张颜色 history GPU texture，AO/SSR history 仍由各自 Service 独立拥有。 |
| 容量/溢出 | 本阶段无新增 GPU 队列；Temporal sampled evidence 沿用全局 counter ABI 和异步 readback ring，不增加私有队列、readback、encoder 或 submit。 |
| 生命周期 | TAA、Classification、颜色 history 惰性创建；关闭或拓扑变化通过 `onSubmittedWorkDone()` retirement；commit 只在 command finished，abort/cut/resize/scale/format/view 变化由 Registry 失效。 |
| DRS 语义 | `DynamicResolutionScaling` 由 `TemporalFeature` 持有并公开原有控制器 seam；只消费已完成且至少延迟一帧的 profiler timestamp。默认产品配置由初始化 `RendererConfig.renderScale` 决定，不自动启动 GPU Budget Governor。 |

## 实现内容

- 新增 [TemporalFeature](../../OEngine/src/render/features/TemporalFeature.ts)，作为 Renderer 唯一时域 owner。
- Renderer 删除对 `TemporalAntiAliasingPass`、`TemporalClassificationPass`、`DynamicResolutionScaling` 和颜色 history 的直接构造/销毁/导入；统一经 Feature 方法接入 FrameGraph。
- 统一保留 internal/output resolution 分离、jitter、current-minus-previous internal-pixel velocity、Depth/Disocclusion、透明 Reactive 输入与 output-resolution history。
- 颜色 history 与 AO/SSR history 保持物理和逻辑隔离；Temporal 不覆盖上游 AO/SSR 历史，也不使用自身 history 掩盖上游错误。
- 保留 NSS 作为同一 Temporal 节点的可选 consumer，不建立第二条主管线；Sharpen、Motion Blur 仍位于后续 Post/可选阶段。
- feature-off 不创建 TAA、Classification、history、私有 readback 或独立 submit。

## 开源参考与适配

本包没有新增 shader 算法移植，只迁移 owner/lifecycle seam。TAA/TAAU 的 jitter、reprojection、variance clip、history lock、Reactive/Disocclusion 和 internal/output contract 继续依据 [R5-04](../references/porting/R5-04-temporal-upscale.md) 中登记的 Karis、Playdead Temporal 和 FSR2 integration invariants；OEngine 保持独立 WGSL、FrameGraph 和既有 Surface ABI，不复制第三方表达性代码。

## 正确性、性能与删除边界

- TAA/TAAU 仅负责最终重建，不替代 AO/SSR 自己的历史；透明 Reactive、快速变化和 invalid motion 保守拒绝或降权 history。
- history 始终使用 output resolution；resize、camera cut、scene/view switch、render-scale、feature-toggle、format-change 和 abort 都通过 Registry 失效，禁止 frame parity 猜测提交状态。
- DRS 反馈只接受已完成延迟 timestamp；本阶段没有隐藏自动降级，初始化 render scale 仍是产品默认控制面。
- 旧 pass 类仍作为 TemporalFeature 内部算法实现保留；完成 production 画质、GPU timestamp、性能和 deletion Gate 后，按 FX-12 清理重复旧 owner。

## 验证记录

已运行：

```text
cd OEngine
npm run build
npm run build:test
node --test tests/p7-temporal-feature.test.mjs
```

本阶段还应保持既有 Temporal 合同：

```text
node --test tests/r5-fx06-temporal.test.mjs tests/r5-fx06b-final-temporal.test.mjs tests/r5-q04-q05-reconstruction.test.mjs
```

未在本包运行：浏览器人工截图、真实 GPU timestamp/DRS 压力、四档 resolution sweep 和 production G5-T/G5-P 视觉 Gate。原因是本包只统一 owner/lifecycle，不改变 TAA/TAAU shader 数学；这些 Gate 必须按 [R5-BROWSER-GATES](./R5-BROWSER-GATES.md) 和固定 benchmark 独立执行。

## 阶段提交约束

代码、合同测试、文档和验证完成后使用独立中文提交；提交不得包含用户已有的 `three.js` gitlink 修改。
