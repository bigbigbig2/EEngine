# Stage 4：透明、HDR Post 与 FrameGraph Closure

> 状态：`doing`
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

- [x] S4-01 Packed 透明固定读取 working-linear HDR、reverse-Z depth、cluster/light/shadow、GI/IBL；v1 明确输出 `reactive=1`、`velocity invalid`，不伪造透明 velocity 输入；
- [~] S4-02 MBOIT 已按 R5-03 的四阶 moments 不变量接入并保留 sorted-alpha CPU oracle；weighted OIT 的同场景误差/内存/容量 A/B 尚未采集，不能关闭产品 Gate；
- [x] S4-03 Packed 与普通透明对象统一由 `TransparencyFeature` 选择，Renderer 不再直接构造具体 OIT pass；
- [x] S4-04 bounded `SecondaryRasterWork`、moment finite failure、queue overflow 均有确定性 conservative fallback 与 GPU counter；
- [x] S4-05 透明只写独立 resolved/reactive 产品，不写回 Opaque Surface；motion contract 固定为 `reactive-all-velocity-invalid-v1`；
- [ ] S4-06 尚未删除 `TransparentOitPass` 的 `GPUMaterialRegistry`/legacy light-list consumer；该迁移依赖普通 Scene 的 material/light producer 收敛，留给 Stage 4 后半段/Stage 5；
- [x] S4-07 Packed/legacy 均 lazy 创建；无透明对象或 feature-off 时不加入 OIT node、不分配 OIT transient、不产生独立 submit/readback。

## 3. HDR Post 任务

- [x] S4-08 Renderer 的唯一 HDR 顺序为 linear HDR → Exposure → Bloom → Color Grading → Sharpen → Tone Mapping → Present；
- [x] S4-09 `exposureSourceHdr` 在 Bloom 前冻结为同一 HDR resource，Bloom 开关不改变 exposure producer；
- [x] S4-10 histogram/reduce/adaptation 使用固定 log-luminance 域、百分位裁剪、空 histogram reset 和 adaptation clamp；
- [~] S4-11 Bloom 使用独立 rgba16float pyramid（最多 5 mip）；mip 数与 `29 B/pixel` 透明预算可见，但逐帧 bandwidth/timestamp 仍需 GPU artifact；
- [x] S4-12 Sharpen 位于 Bloom composite/Color Grading 后、Tonemap 前，输入输出均为 working-linear HDR；
- [x] S4-13 生产路径不创建中间 LDR/gamma pass；唯一 sRGB/PQ encode 在 Tonemap shader，swapchain 只作为最终写入目标；
- [x] S4-14 Exposure/Bloom production WGSL 已迁移到 `src/shaders/automatic_exposure.ts` 与 `src/shaders/bloom.ts`，`temporal_post_legacy.generated.ts` 不再是直接 consumer；
- [~] S4-15 Tonemap 已固定 SDR/HDR、paper-white/peak-nits 与 Rec709→Rec2020→Display-P3 路径；SDR/HDR 数值回归和真实显示能力仍待 focused artifact。

## 4. FrameGraph Closure 任务

- [x] S4-16 resource/version/read-before-write validation；
- [x] S4-17 duplicate producer、cycle detection、imported resource validation；
- [x] S4-18 stable topological scheduling，同优先级保持稳定顺序；
- [x] S4-19 domain validation 和显式 conversion owner；
- [x] S4-20 graph node 通过 `declareEncoderWork` 映射真实 dispatch/draw，并记录 work kind/count；
- [x] S4-21 `FramePlan` 统一 SceneUpdate、ShadowUpdate、LPVUpdate、MainGraph 顺序；
- [x] S4-22 compiled graph 固定 single-main-submit 边界，history/transient 生命周期和 feature-off prune 有契约测试；
- [ ] S4-23 correctness/quality/perf Gate 尚未全部关闭，暂不做 pass fusion 或 bandwidth tuning。

## 5. 退出 Gate

- 透明与不透明 HDR 的颜色域、深度和 reactive 语义正确；
- OIT overflow、fallback、memory 和时间可观测；
- Bloom OFF/ON 不改变 Exposure source；
- SDR/HDR 颜色数值回归通过；截图仅作为可选诊断资料；
- graph dump 能证明依赖和拓扑顺序；
- 所有 feature-off 不保留无消费者资源、history、readback 或 submit。

## 6. 状态记录

```text
状态：`doing`（FrameGraph/Post 架构 Gate 已通过，Transparency 与颜色数值产品 Gate 未关闭）
OIT decision：`MBOIT = port mathematical invariants / reimplement WebGPU owner`（见 R5-03）；weighted OIT A/B pending
Post artifact：production shader 已从 generated 迁至 authored source；无浏览器截图 artifact
FrameGraph validation tests：`framegraph-compiled.test.mjs`、FrameGraph contract suite 全部通过
memory/timestamp：静态 transient/计数合同已通过；未运行 GPU timestamp/memory clean/full artifact
feature-off diff：lazy owner/resource prune 已通过单元契约；未运行浏览器 paired diff

### 6. 本轮实际变更

1. `automatic_exposure.ts` 不再 re-export `temporal_post_legacy.generated.ts`，改为维护 histogram、percentile reduce 和 adaptation 的生产 WGSL；
2. `bloom.ts` 不再 re-export generated shader，改为维护 prefilter/downsample/upsample/composite 与 fullscreen vertex 的生产 WGSL；
3. 更新 shader-source audit，使 generated 文件只保留 Sharpen 的历史引用，避免将旧 generated 文件误判为 Exposure/Bloom 的 owner；
4. 增加 P8 契约测试，阻止后处理生产 shader 再次直接依赖 legacy generated 文件；
5. 本轮不修改用户已有的 `three.js` gitlink，也不执行浏览器/截图测试。

### 7. 当前退出 Gate 结论

当前只能关闭 Stage 4 的架构/源码 focused Gate，不能宣称产品闭环。阻塞项是：

- legacy `TransparentOitPass` 仍依赖旧材质 registry 和旧 light-list consumer（S4-06）；
- weighted OIT 对照、透明综合画质和 SDR/HDR 数值回归尚未有 GPU artifact；
- Bloom bandwidth、GPU timestamp、显存和 feature-off paired browser evidence 未采集。
```
