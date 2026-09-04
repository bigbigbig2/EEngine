# Stage 5：Legacy 删除与产品闭环

> 状态：`doing`
>
> 本阶段不再增加效果。目标是证明只有一条生产路径，并用综合场景、性能、显存、feature-off 和 provenance Gate 关闭重构。

## 1. 前置条件

Stage 0–4 的退出 Gate 全部有 artifact；任何阶段只有“边界已接入”或“focused Gate”时，不得进入产品闭环。

## 2. 删除策略

按真实 consumer 迁移顺序删除，不使用大范围 reset 或保留永久兼容层：

1. `Renderer.ts` 手工 topology、重复 HDR composite、legacy 私有 owner；
2. `MaterialExpandPass`、重复 Velocity 和普通 Scene 的旧 Surface consumer（先完成其迁移）；
3. `OpaqueLightingPipeline`、旧 IBL/Indirect owner；`OpaqueLightingResolvePass` 保留为唯一解析 owner；
4. `ScreenSpaceAmbientOcclusionPass`、旧 AO alpha composite；
5. `ScreenSpaceReflectionsPass` 的旧 final override；
6. `TemporalClassificationPass`/`TemporalAntiAliasingPass` 的重复路径；
7. `TransparentOitPass` 与旧透明 shader；
8. 无生产引用的 generated/oracle shader、配置键、readback 和 debug panel；
9. `RenderSettings` 中指向具体 legacy Pass 的 owner 名称。

删除每一项前必须通过 `rg` 确认真实引用、shader 来源、resource owner 和测试覆盖。

## 3. 产品 Gate 场景

- Static Geometry：GPU-driven、LOD、Visibility、Surface；
- Dynamic Lighting：Directional/Point/Spot、CSM、Atlas、Contact；
- Indoor GI：Lightmap、Probe Volume、动态灯光间接影响；
- Reflection：Probe、SSSR、IBL fallback、roughness；
- Temporal Stress：快速相机、细小几何、透明、SSR、AO；
- Heavy Workload：多实例、多材质、多灯光和默认 profile。

每个场景需要固定相机/帧序列、Debug View、GPU timestamp、counter、memory、console 和 settings/profile hash；截图仅作为可选诊断附件。

## 4. 产品性能 Gate

固定条件：1920×1080、DPR1、中等偏高 profile、目标整帧 16.667 ms。报告：

```text
GPU Total P50/P95/P99
Phase P50/P95/P99
Pass / Dispatch / Draw
Pixel / Work / Ray / Step
Resident / Transient / History / Retiring bytes
Upload / readback / queue submit
```

不得用单一 FPS、单张截图或 focused Gate 代替整帧证据。必须提交 GPU timestamp、数值、counter、memory 和 provenance。若 Hardware Raster、texture residency 或显存 cap 失败，必须保持 `productPerformanceAchieved=false`。

## 5. 最终删除和审计任务

- [~] S5-01 已完成 shader-source audit 与关键 legacy symbol `rg` 审计；普通 Scene/Lighting/AO/SSR/TAA/OIT 仍有真实 consumer，不能伪报清零；
- [~] S5-02 Renderer 的 Packed/效果路径已调用 Feature/product interface，但普通 Scene 的 Material/Velocity/OIT legacy consumer 仍在；
- [x] S5-03 主帧保持 GPU producer→GPU consumer、无 CPU 最终可见列表、无 steady-frame 私有 submit；已有 frame coordinator/submit contract 测试；
- [~] S5-04 Packed visibility/transparency/light queues 已有 ABI、capacity、overflow、fallback、counter；尚未完成所有 shadow/普通 Scene 队列的统一审计 artifact；
- [x] S5-05 compiled FrameGraph feature-off prune、history/transient 生命周期已有契约测试；浏览器 paired diff 未采集；
- [x] S5-06 Sharpen 已迁移 authored WGSL，删除无 owner 的 `temporal_post_legacy.generated.ts`；保留 CPU/reference/regression evidence；
- [~] S5-07 `npm run build`、`npm test`、shader audit 已运行并通过；按用户要求未运行 Browser/GPU gates；
- [~] S5-08 已更新 `STATUS.md`、`SHADER-SOURCES.md` 与本 Stage 文档；`CURRENT-STATE.md`、`PERFORMANCE.md`、porting ledger/ADR 的产品闭环结论仍待最终 GPU artifact；
- [ ] S5-09 仅在全部 Gate 通过后设置 `productPerformanceAchieved=true`。

## 6. 退出标准

只有同时满足以下条件才能标记 `产品闭环`：

- 单一统一主管线，旧 consumer 和重复 shader 已删除；
- GPU producer → GPU consumer 闭环完整；
- 画质、数值、稳定性和 fallback Gate 通过；
- 性能、显存、带宽和 submit 证据满足目标；
- feature-off 接近零成本；
- clean provenance 可回查；
- 当前事实文档与源码一致。

## 7. 状态记录

```text
状态：`doing`（完成一次可回查的 generated shader 删除，产品 Gate 未关闭）
删除提交：本次 Stage 5 提交记录在 git log；`temporal_post_legacy.generated.ts` 无运行时引用后删除
全仓库审计结果：shader audit `69 shaders / authored-live 65 / unknown 4 / dead 0`；legacy class consumer 仍存在
六场景 artifact：未采集（Browser/GPU gate 按用户要求跳过）
性能结论：未宣称；缺少目标机 1920×1080 GPU timestamp、P50/P95/P99 和 submit 对照
显存结论：未宣称；缺少 resident/transient/history/shadow atlas clean artifact
未关闭 Gate：普通 Scene Material/Velocity/OIT、OpaqueLighting/GI/AO/SSR/TAA legacy consumer；weighted OIT A/B；SDR/HDR 数值；GPU 质量/性能；feature-off browser paired diff
最终 ADR/CURRENT-STATE 更新：暂不写产品闭环结论，待全部退出 Gate 通过后更新

### 本轮删除边界

只删除了经过 `rg` 和 shader-source audit 双重确认的无 owner generated shader，并将其最后一个生产 consumer（Sharpen）迁移到 authored source。没有删除仍被 Renderer/Feature/Pass 真实调用的 MaterialExpand、Velocity、OpaqueLighting、AO、SSR、Temporal 或 TransparentOit 实现，避免把“文件不存在”误写成“consumer 已迁移”。
```
