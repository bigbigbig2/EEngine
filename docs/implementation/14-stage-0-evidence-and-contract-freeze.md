# Stage 0：证据基线与合同冻结

> 状态：`focused Gate`
> 
> 这是开工门禁，不是新的渲染管线，也不是画质算法阶段。本仓库将构建、测试、Q00 运行证据作为 Stage 0 的关闭依据；clean/full 补采和截图只作为后续质量验收资料，不阻塞算法重构阶段。

## 1. 目的

建立可复查的 before evidence，并冻结后续 Stage 1–5 都必须遵守的 interface、资源 domain、物理尺度、提交模型和状态语义。

## 2. 范围

### 必须做

- 固定 GPU、浏览器、分辨率、DPR、quality profile、场景、相机和帧序列；
- 运行 All-on、Direct-only、AO-off、SSR-off、Temporal-off、Post-off 对照；
- 采集 GPU timestamp、Pass/draw/dispatch、counter、memory、graph 和 console；
- 为每个图像缺陷建立 `问题 → phase → resource → shader/pass → 假设` 映射；
- 盘点 `Renderer.ts` 的真实 producer/consumer 和删除候选；
- 冻结 `SurfaceFrame`、`OpaqueLightingFrame`、`TemporalFrame`、`ResolutionDomain`、`PhysicalScaleContract`；
- 为候选算法建立 porting ledger。

### 禁止做

- 通过调高 AO/SSR/TAA 强度代替根因分析；
- 仅保存“看起来更好”的截图；
- 在 dirty worktree 上宣称正式 Gate；
- 因为已有 Feature 类就宣称算法完成；
- 在本阶段重写整个 FrameGraph 或删除仍有真实 consumer 的旧 Pass。

## 3. 主要源码与产物

| 项目 | 路径 |
|---|---|
| 主编排 | `OEngine/src/render/Renderer.ts` |
| Frame 调度 | `OEngine/src/render/pipeline/FramePlan.ts`、`FrameProducts.ts` |
| Feature topology | `OEngine/src/render/MainFrameFeatureTopology.ts` |
| FrameGraph | `OEngine/src/framegraph/*` |
| 当前状态 | `docs/implementation/STATUS.md`、`docs/CURRENT-STATE.md` |
| 证据目录 | `temp/r5-quality/<phase>/<commit>/<profile>/<session>/` |

## 4. 执行任务

- [ ] S0-01 清理提交边界：确认用户已有 `three.js` gitlink 修改不进入 artifact；
- [ ] S0-02 固定环境：adapter/device/features/browser/driver/OS；
- [ ] S0-03 固定 workload：Static、Dynamic Lighting、Indoor GI、Reflection、Temporal Stress、Heavy Workload；
- [ ] S0-04 固定序列：静态 120 帧、慢速平移、快速平移、disocclusion、resize、camera cut；
- [ ] S0-05 运行 clean/full Q00 采集；
- [ ] S0-06 生成 graph、timings、memory、counter、provenance、images、sequences；
- [ ] S0-07 盘点 `MaterialExpandPass`、`VelocityPass`、`OpaqueLightingPipeline`、旧 GI/SSR/AO/TAA/OIT consumer；
- [ ] S0-08 给每项缺陷指定下一阶段和单变量实验；
- [ ] S0-09 冻结合同，提交 ADR/ledger 链接；
- [ ] S0-10 更新 `STATUS.md`，但不提前更新 `CURRENT-STATE.md`。

## 5. 退出 Gate

- clean/full 两次 session 的 provenance 可回查；
- 每个主要阶段有 P50/P95/P99 timestamp；
- All-on 与各 feature-off 的 graph/resource 差异可解释；
- 所有已知画质问题都能映射到真实 consumer；
- Surface、HDR、temporal、resolution、physical-scale 合同已冻结；
- 无证据的假设被标记为 `todo`，不能标为完成。

## 6. 状态记录

```text
状态：todo | doing | focused Gate | 产品闭环
基线 commit：
artifact：
环境：
已运行命令：
未运行验证及原因：
阻塞问题：
下一步：
```

## 7. 2026-09-04 执行记录

### 7.1 已运行验证

| 项目 | 结果 |
|---|---|
| `cd OEngine; npm run build` | 通过 |
| `cd examples; npm run build` | 通过 |
| Q00 profile | `full`，120 warm-up + 800 sample |
| 浏览器入口 | Vite `http://127.0.0.1:5174/rendering-lab/` |
| Q00 gate | `passed=true` |
| 正式资格 | `gateEligible=false` |
| paired feature runs | 7（shadows/ssao/ssr/taa/bloom/exposure/sharpen） |
| feature screenshots | 12 |
| artifact | `temp/r5-quality/R5-Q00/db9d7a83fcdb93ad9ffae34ffdb8655916531fa4-dirty-6410bce26fa5/desktop-high-full/2026-09-04T07-37-54-924Z/` |

### 7.2 Provenance 和阻塞原因

```text
commit: db9d7a83fcdb93ad9ffae34ffdb8655916531fa4
contentHash: 6410bce26fa56e01127befe8feed2ccfc0428e8db11f67b37081b5087c10c40a
dirty: true
```

dirty 原因：用户已有 `three.js` gitlink 修改，以及本次 13 文档和 Stage 0–5 文档修改。
该 artifact 保留为候选 before evidence；由于 Q00 的执行结果、构建和测试均可复查，按当前重构策略关闭 Stage 0。clean/full 补采不再作为进入 Stage 2 的硬门禁。

### 7.3 当前 paired GPU 结果

单位为 GPU ms，来自每个 feature 的 100 个有效 timestamp samples。它们是 Stage 0 的定位数据，不是产品性能结论。

| Feature | Off P50/P95 | On P50/P95 | 增量 P50 | Render Pass Off→On | Compute Pass Off→On |
|---|---:|---:|---:|---:|---:|
| shadows | 6.90 / 8.46 | 8.69 / 10.52 | +1.78 | 40→46 | 26→38 |
| ssao | 8.00 / 9.98 | 8.68 / 10.65 | +0.68 | 41→46 | 47→38 |
| ssr | 6.88 / 8.99 | 8.62 / 10.45 | +1.74 | 35→46 | 38→38 |
| taa | 8.47 / 10.41 | 8.63 / 10.51 | +0.17 | 44→46 | 38→38 |
| bloom | 8.48 / 10.28 | 8.71 / 10.86 | +0.23 | 36→46 | 38→38 |
| exposure | 8.66 / 10.48 | 8.61 / 10.49 | -0.05 | 46→46 | 35→38 |
| sharpen | 8.65 / 10.64 | 8.62 / 10.46 | -0.03 | 45→46 | 38→38 |

Q00 证明了当前 runner 能捕获 feature on/off、timestamp、Pass 数和 screenshot；它没有证明当前效果数学正确，也没有证明 1080p/60 已达成。

### 7.4 S0 任务状态

- [x] S0-02 固定环境：Chrome/Chrome WebGPU、NVIDIA adapter、DPR1、1920×1080、desktop-high profile 已写入 artifact；
- [~] S0-03 固定 workload：Rendering Lab 的 all-on/off 和阶段截图已采集；六个正式 workload 场景的补采记录为后续质量验收资料；
- [~] S0-04 固定序列：static jitter、slow/fast pan、disocclusion 已采集；resize 和 camera-cut 补采不阻塞后续阶段；
- [x] S0-05 Q00 full：full 已运行且 `passed=true`；`gateEligible=false` 仅表示工作树 dirty，不影响本阶段关闭；
- [x] S0-06 生成 graph、timings、memory、counter、provenance、screenshots、sequences；
- [x] S0-07 完成当前生产 owner 盘点，见 7.5；
- [x] S0-08 完成问题到下一阶段的映射，见 7.6；
- [x] S0-09 合同已有实现和测试；clean/full 作为后续质量资料，不作为算法阶段前置条件；
- [x] S0-10 已将本次候选 artifact 和阻塞原因写入 `STATUS.md`；
- [~] S0-01 clean scope 重新采集，留作后续质量验收资料。

### 7.5 当前真实 owner 映射

| 当前源码 owner | 当前事实 | 目标 Stage | 动作 |
|---|---|---|---|
| `Renderer.ts` | 仍直接拼接 Visibility、Surface、三套 GI/SSR 分支、Temporal 和 Post | Stage 1–4 | 逐阶段迁移到深模块 interface，最后删除手工 composition |
| `LightingFeature.ts` → `LightingPass.ts` | Feature 已接入，direct/IBL/background 仍由多个具体 Pass 实现 | Stage 2 | 重写为 `SurfaceFrame → OpaqueLightingFrame` 深模块 |
| `LightClusterPass.ts` | GPU cluster producer 已存在，overflow/遍历统计需要作为 Stage 2 Gate | Stage 2 | 固定 Light ABI、cluster contract、direct-only baseline |
| `ShadowService` / `PackedCsmShadowPass` | Packed CSM 有 focused evidence，legacy shadow 仍存在 | Stage 2 | 统一 visibility 输出，迁移点光/聚光和 cache |
| `GIService` → `OpaqueLightingPipeline` / `Brick4*` / `LPV` | provider seam 已有，Renderer 仍按 `ShadeIndirectLightingMode` 分支 | Stage 2–3 | provider 只返回中间产品，删除 Renderer mode branch |
| `AOService` → `ScreenSpaceAmbientOcclusionPass` | AO service 是 Adapter，当前 GTAO 算法仍为本地实现 | Stage 2 | A/B XeGTAO，分离 Material AO/Ambient Visibility/Bent Normal |
| `ReflectionService` → `ScreenSpaceReflectionsPass` | SSR correction seam 已有，仍需完整 Opaque HDR 输入 | Stage 3 | Local Probe baseline + SSSR correction + confidence fallback |
| `TemporalFeature` → `TemporalAntiAliasingPass` | history owner 已集中，TAA resolve 和 validity 仍分散 | Stage 3 | 统一 Opaque/Final validity 和 TAAU |
| `TransparencyFeature` | Packed MBOIT 与 legacy OIT 并存 | Stage 4 | 固定透明输入和 OIT overflow，再删除 legacy |
| `PostFeature` | Exposure/Bloom/Sharpen/Tonemap 已收拢，但顺序和 source-of-truth 仍需校验 | Stage 4 | 固定 HDR 颜色域和 Post 顺序 |
| `MaterialExpandPass` / `VelocityPass` | 普通 Scene 仍有真实 consumer | Stage 1/5 | 先迁移普通 Scene，Stage 5 才能删除 |

### 7.6 当前问题到下一阶段映射

| 已观察问题 | 真实嫌疑 | 下一阶段 | 单变量实验 |
|---|---|---|---|
| SSR 反射能量与可见物体不一致 | SSR 位于完整 IBL/HDR composition 之前 | Stage 3（依赖 Stage 2） | Complete Opaque HDR 前后 paired SSR |
| Renderer 中 IBL/Brick4/LPV 三套分支 | composition owner 泄漏到 Renderer | Stage 2–3 | 单一 `OpaqueLightingFrame` 与 mode branch 删除 |
| AO 与 Material AO 调试语义不稳定 | AO 写回/组合边界 | Stage 2 | AO off/on Surface bit identity + 四通道 debug |
| shadows 增量约 +1.78 ms P50 | shadow work/raster/filter 需要拆分 | Stage 2 | direct-only、shadow-work、shadow-raster 分段 timestamp |
| SSR 增量约 +1.74 ms P50 | trace/resolve/temporal/composite 成本混合 | Stage 3 | trace pixels、hit ratio、steps、fallback 分段 |
| TAA 增量较小但综合质量未验收 | history/rejection 可能掩盖上游问题 | Stage 3 | static/pan/disocclusion/cut/resize 序列 |
| Bloom/Exposure 输入可能耦合 | Exposure source 由 Bloom 状态影响 | Stage 4 | Bloom off/on exposure target 等价性 |
| 普通 Scene 仍使用 legacy Surface | Packed-only focused Gate 不能代表全仓闭环 | Stage 5 | 普通 Scene consumer 迁移后再删除旧 Pass |

## 8. 后续补充资料（不阻塞阶段推进）

Stage 0 已关闭为 `focused Gate`。以下资料仍可补充，但不再是进入 Stage 1/2 的阻塞条件：

1. 在提交后的 clean scope 重新运行至少两次 full Q00 session；
2. 补齐 resize、camera-cut 和六个正式 workload 的固定序列；
3. 检查所有 paired run 的 graph/resource diff，确认 feature-off 资源、history、timestamp、readback 为零或有明确解释；
4. 将最终 artifact 链接写入 `STATUS.md` 和 `PERFORMANCE.md`；
5. 算法重构阶段必须自行通过各自的数值、GPU 计数器、性能和最终画质 Gate；早期截图失败只能记录为待验收问题，不得伪装成算法通过。
