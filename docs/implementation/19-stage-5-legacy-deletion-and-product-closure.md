# Stage 5：Legacy 删除与产品闭环

> 状态：`todo`
>
> 本阶段不再增加效果。目标是证明只有一条生产路径，并用综合场景、性能、显存、feature-off 和 provenance Gate 关闭重构。

## 1. 前置条件

Stage 0–4 的退出 Gate 全部有 artifact；任何阶段只有“边界已接入”或“focused Gate”时，不得进入产品闭环。

## 2. 删除策略

按真实 consumer 迁移顺序删除，不使用大范围 reset 或保留永久兼容层：

1. `Renderer.ts` 手工 topology、重复 HDR composite、legacy 私有 owner；
2. `MaterialExpandPass`、重复 Velocity 和普通 Scene 的旧 Surface consumer（先完成其迁移）；
3. `OpaqueLightingPipeline`、`IndirectCompositePass`、旧 IBL/Indirect owner；
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

每个场景需要固定相机/帧序列、截图、Debug View、GPU timestamp、counter、memory、console 和 settings/profile hash。

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

不得用单一 FPS、单张截图或 focused Gate 代替整帧证据。若 Hardware Raster、texture residency 或显存 cap 失败，必须保持 `productPerformanceAchieved=false`。

## 5. 最终删除和审计任务

- [ ] S5-01 全仓库引用审计：class、shader、binding、resource、配置键；
- [ ] S5-02 检查 Renderer 是否只调用统一 Feature/product interface；
- [ ] S5-03 检查没有 CPU 最终可见列表、GPU readback 遍历或私有 submit；
- [ ] S5-04 检查所有队列 ABI、capacity、overflow、fallback、计数器；
- [ ] S5-05 检查所有 feature-off 的 compiled graph/resource diff；
- [ ] S5-06 删除无 owner 的测试和生成物，但保留 CPU/reference/regression evidence；
- [ ] S5-07 运行 npm build、相关 Node tests、Browser/GPU gates；
- [ ] S5-08 更新 `STATUS.md`、`CURRENT-STATE.md`、`PERFORMANCE.md`、porting ledgers 和 ADR；
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
状态：todo | doing | focused Gate | 产品闭环
删除提交：
全仓库审计结果：
六场景 artifact：
性能结论：
显存结论：
未关闭 Gate：
最终 ADR/CURRENT-STATE 更新：
```
