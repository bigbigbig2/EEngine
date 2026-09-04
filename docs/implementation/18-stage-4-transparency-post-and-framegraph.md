# Stage 4：透明、HDR Post 与 FrameGraph Closure

> 状态：`todo`
>
> 前置条件：Stage 2 的 Opaque HDR 与 Stage 3 的 Reflection/Temporal 输入稳定。本阶段解决透明路径、颜色域和资源调度，不再新增 screen-space 算法。

## 1. 目标

```text
CompleteOpaqueHDR
  → Transparency Forward/OIT
  → Final Temporal
  → Motion Blur
  ├→ ExposureSourceHDR
  └→ Bloom Pyramid
  → Bloom Composite
  → HDR-aware Sharpen
  → Tonemap / Present
```

FrameGraph 负责依赖、生命周期、剔除、复用和 debug；FramePlan 负责跨 graph 的 Scene/Shadow/LPV/Main 顺序。两者都不能成为第二个 renderer owner。

## 2. Transparency 任务

- [ ] S4-01 固定透明输入：scene color、depth、cluster、shadow、GI、reflection、velocity、reactive；
- [ ] S4-02 对 MBOIT/weighted OIT 进行误差、内存、容量和排序假设 A/B；
- [ ] S4-03 Packed 与普通透明对象统一进入 `TransparencyFeature`；
- [ ] S4-04 OIT accumulation/node/fragment overflow 有确定性 fallback 和计数；
- [ ] S4-05 透明输出 reactive/velocity，不修改 Opaque Surface；
- [ ] S4-06 删除 `TransparentOitPass` 对旧材质/旧灯光列表的依赖；
- [ ] S4-07 Transparency OFF 时不分配 OIT 资源、不执行空 Pass。

## 3. HDR Post 任务

- [ ] S4-08 固定 linear HDR → Exposure → Bloom → Color Grading → Tone Mapping → Present；
- [ ] S4-09 Exposure 固定读取 `ExposureSourceHDR`，与 Bloom owner 解耦；
- [ ] S4-10 固定 histogram/reduce/adaptation、clamp、reset 和颜色域；
- [ ] S4-11 Bloom 使用独立 pyramid，记录 mip、bandwidth 和 transient bytes；
- [ ] S4-12 Sharpen 放在 Bloom composite 后、Tonemap 前，明确 HDR-aware 语义；
- [ ] S4-13 删除中间 LDR、重复 gamma/sRGB 和隐式 swapchain conversion；
- [ ] S4-14 将 production shader 从 `temporal_post_legacy.generated.ts` 迁回真实 source-of-truth；
- [ ] S4-15 固定 SDR/HDR output、paper white、peak luminance、gamut mapping。

## 4. FrameGraph Closure 任务

- [ ] S4-16 resource/version/read-before-write validation；
- [ ] S4-17 duplicate producer、cycle detection、imported resource validation；
- [ ] S4-18 stable topological scheduling，同优先级保持稳定顺序；
- [ ] S4-19 domain validation 和显式 conversion owner；
- [ ] S4-20 每个 graph node 映射真实 encoder work，并记录 dispatch/draw；
- [ ] S4-21 FramePlan 统一 SceneUpdate、ShadowUpdate、LPVUpdate、MainGraph 顺序；
- [ ] S4-22 验证 single main submit、history lifetime、transient alias 和 feature-off prune；
- [ ] S4-23 在 correctness 通过后才做 pass fusion/bandwidth tuning。

## 5. 退出 Gate

- 透明与不透明 HDR 的颜色域、深度和 reactive 语义正确；
- OIT overflow、fallback、memory 和时间可观测；
- Bloom OFF/ON 不改变 Exposure source；
- SDR/HDR 颜色数值回归通过；截图仅作为可选诊断资料；
- graph dump 能证明依赖和拓扑顺序；
- 所有 feature-off 不保留无消费者资源、history、readback 或 submit。

## 6. 状态记录

```text
状态：todo | doing | focused Gate | 产品闭环
OIT decision：
Post artifact：
FrameGraph validation tests：
memory/timestamp：
feature-off diff：
```
