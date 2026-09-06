# Rendering Lab 性能与架构分析报告

日期：2026-09-06  
状态：已完成本地 Chrome 完整 11 case 正式长跑、相机距离/锁定 LOD 归因和运动路径实验；目标桌面硬件复测待执行。

## 1. 本次实际执行

测试入口是 `examples/rendering-lab/`，通过 Playwright 控制本地 Chrome，正式长跑 WebGPU canvas 为 1920×1080、DPR 1；固定 seed `20260906`。正式长跑为每个 case 120 warm-up + 480 measured frames；GPU timestamp cadence 为 8，GPU counter cadence 为 11，readback ring 为 16 slots。另保留 1280×720、30+60 的快速 smoke 配置用于开发迭代。

工作负载 manifest 已固定并写入报告：816 instances、806 geometries、34 materials、2 个透明实例，Dungeon GLB 与 Venice HDR 都记录 SHA-256。全效果请求包含 CSM、GTAO、SSR、MBOIT、TAA、motion blur、自动曝光、Bloom、color grading、sharpening 和 tonemap。

## 2. 正式完整套件结果（本地 Chrome）

以下数据来自 `rendering-lab-none-automatic-1920x1080.json`，11 个 case 均完成，诊断错误为 0；timestamped GPU phase 的有效窗口为 436/480，GPU counter readback 为 5–6/480，CPU/runtime counters 为 480/480。该次运行时工作区处于 dirty 状态，因此 artifact 的 evidence gate 按安全规则标记为不可提交基线；本次代码已提交，后续需在 clean workspace 重新跑 gate 才能升级为发布基线，但不影响本轮数值和 feature-off 归因。

| Case | CPU P50 / P95 / P99 (ms) | GPU phase P50 / P95 / P99 (ms) | timestamp frames | diagnostics |
| --- | ---: | ---: | ---: | ---: |
| `base` | 10.10 / 12.30 / 13.22 | 0.678 / 0.697 / 0.970 | 436/480 | 0 |
| `full` | 16.80 / 20.80 / 22.60 | 1.442 / 1.716 / 1.767 | 436/480 | 0 |
| `full-minus-shadow` | 13.70 / 16.31 / 17.80 | 0.989 / 1.017 / 1.307 | 437/480 | 0 |
| `full-minus-gtao` | 16.40 / 21.91 / 25.74 | 1.196 / 1.468 / 1.763 | 436/480 | 0 |
| `full-minus-ssr` | 15.40 / 18.40 / 20.04 | 1.438 / 1.712 / 1.746 | 437/480 | 0 |
| `full-minus-transparency` | 14.40 / 17.31 / 18.40 | 1.354 / 1.639 / 1.703 | 436/480 | 0 |
| `full-minus-temporal` | 16.90 / 21.40 / 23.70 | 1.441 / 1.717 / 1.767 | 437/480 | 0 |
| `full-minus-bloom` | 16.10 / 19.20 / 21.10 | 1.443 / 1.547 / 1.898 | 436/480 | 0 |
| `full-minus-exposure` | 16.20 / 19.11 / 20.62 | 1.441 / 1.692 / 1.948 | 437/480 | 0 |
| `full-minus-motion-blur` | 16.70 / 19.80 / 21.01 | 1.442 / 1.711 / 1.798 | 436/480 | 0 |
| `full-minus-sharpen` | 16.60 / 20.61 / 22.66 | 1.442 / 1.720 / 1.769 | 436/480 | 0 |

从 `full` 到 minus case 的 counter/active-pass gate 全部通过。CPU 端最明显的去除项是 CSM shadow（P50 下降 3.1 ms），其次是 transparency（2.4 ms）、SSR（1.4 ms）和 GTAO（0.4 ms）；这些是当前 workload 的相关性结果，不等同于单个 feature 的纯 GPU 成本。`full` 相对 `base` 的 CPU P50 增量为 6.7 ms，timestamped GPU phase 增量为 0.764 ms。

### 2.1 测量配置 A/B 与 counter 覆盖

为排除 Inspector 自身和异步 readback 对结果的影响，新增了同一页面、同一 workload 的可见/隐藏 A/B，以及独立 counter-coverage profile。可复跑入口是 `examples/yarn test:rendering-lab:profiles 1920 1080`，产物写入 gitignored 的 `temp/rendering-lab-profiles-1920x1080.json`：

| Profile | Inspector | Counter cadence / ring | GPU wait | `full` CPU P50 / P95 | `full` GPU phase P50 | counter coverage |
| --- | --- | --- | --- | ---: | ---: | ---: |
| visible | visible | 11 / 16 | no | 16.40 / 19.71 ms | 1.441 ms | 6/60，0 dropped |
| hidden | hidden | 11 / 16 | no | 16.45 / 18.41 ms | 1.440 ms | 5/60，0 dropped |
| counter-coverage | hidden | 1 / 64 | every frame | 15.80 / 18.61 ms* | unavailable† | 60/60，0 dropped |

这次同页 A/B 的 `full` CPU P50 差为 0.05 ms、GPU phase 差为 0.001 ms，低于该短 smoke 的运行噪声；因此目前只能确认 Inspector shell 没有可见的 GPU 成本，不能把一次 A/B 宣称为固定 CPU 开销。该 A/B 保留 profiler 记录本身，只隔离 Inspector shell 的 DOM/layout/paint；若要测 profiler instrumentation，还应另跑 profiler disabled 的渲染 smoke。后续目标硬件需重复多轮并报告置信区间。*counter-coverage 为逐帧等待 GPU 的测量 profile，CPU 数值不与普通实时 cadence 直接横比。†逐帧 counter 会使所有帧进入 instrumented 集合，普通 GPU timing summary 按合同排除这些帧，因此显示 unavailable 而不是 0。

## 3. Smoke 结果（快速回归，1280×720）

| Case | CPU frame P50 | CPU frame P95 | timestamped GPU phase P50 | counter sampled | diagnostics |
| --- | ---: | ---: | ---: | ---: | --- |
| `base` | 12.85 ms | 14.41 ms | 0.767 ms | 6/60 | 0 dropped，0 validation |
| `full` | 17.50 ms | 20.11 ms | 1.289 ms | 6/60 | 0 dropped，0 validation |
| `full-minus-ssr` | 15.25 ms | 16.70 ms | 1.574 ms | 5/60 | 0 dropped，0 validation |

完整 11 case smoke 已全部完成，9 个 feature-off gate（shadow、GTAO、SSR、MBOIT、temporal、Bloom、自动曝光、motion blur、sharpen）全部通过：full 中存在 feature-owned GPU labels，而对应 minus case 中不存在。这一节只用于快速回归；正式基线以 1920×1080 表格为准。

报告中的 GPU 数值是 timestamped pass/phase sum，不是完整 GPU frame time，不能和 CPU frame 相加。Chrome headless 的 timestamp 可用且无失败，但 counter 只有 5–6 个有效样本，因此 counter 适合确认 producer 有工作，不适合声称稳定 P95。

## 4. 相机距离归因

距离集合为 4、6、10、18、32、56 m。`fixed-fov` 固定 FOV 50°，`projection-normalized` 调整 FOV，使参考物体投影高度恒定。以下为 1920×1080、DPR 1 的 30 warm-up + 60 measured 相机归因 smoke；每个距离独立 warm-up/measure epoch。

### 4.1 CPU frame

| 距离 | fixed FOV automatic P50 / P95 | fixed FOV locked P50 / P95 | projection-normalized automatic P50 / P95 | 归一化 FOV |
| ---: | ---: | ---: | ---: | ---: |
| 4 m | 12.80 / 14.20 ms | 12.80 / 14.20 ms | 12.95 / 14.40 ms | 129.04° |
| 6 m | 12.90 / 14.20 ms | 13.10 / 14.30 ms | 12.60 / 14.10 ms | 108.88° |
| 10 m | 12.90 / 14.20 ms | 12.70 / 14.10 ms | 12.75 / 14.20 ms | 80.02° |
| 18 m | 12.60 / 14.00 ms | 12.70 / 14.10 ms | 12.70 / 14.10 ms | 50.00° |
| 32 m | 12.80 / 14.30 ms | 12.70 / 14.10 ms | 12.70 / 14.10 ms | 29.39° |
| 56 m | 12.20 / 13.70 ms | 12.70 / 14.10 ms | 12.70 / 14.10 ms | 17.05° |

### 4.2 GPU/counter 观察

固定 FOV automatic 下，`shadedPixels` 从约 1.92M（4 m）下降到约 158k（56 m），SSR trace pixels 从约 479k 下降到约 40k；同时 `selectedClusters` 从约 357 上升到 746，`hwTriangles` 从约 26.6k 上升到约 49.4k。近处的屏幕工作量更大，但几何/可见性量在中远距离更高，二者方向相反，因此不能用单一像素因素解释总时间。

投影归一化后，`shadedPixels` 约维持在 1.30M–1.44M，SSR trace 约 324k–359k，CPU P50 维持在 12.6–12.95 ms；fixed-FOV automatic 与 locked 的 P50 基本重合（差异不超过约 0.2 ms）。这说明当前“拉近性能下降”不能归因于自动 LOD 选择，CPU 也没有出现随距离单调恶化。GPU phase 仍受可见性、材质和后处理组合影响，需要目标硬件进一步复测。正式运动路径已加入 overview、遮挡密集段、透明近景和一次显式 cut，并将 segment/cutId/lodMode 写入每个 benchmark frame 的 metadata；路径报告另行排除了 cut 前后稳定窗口之外的样本。

判因结论：当前本地 adapter 的静态距离实验为 `inconclusive`，没有足够证据把“拉近变慢”归因到单一像素、LOD、Visibility、SSR 或阴影因素；下一步必须在目标硬件上用同一矩阵复测，并结合 GPU counter 和 phase 共同判定。

运动路径的 1920×1080 smoke（30+60）稳定窗口统计如下。`cut-recovery` 原始 21 帧中有 2 个 cut 标记，报告只将 15 帧作为稳定样本，另外 4 帧作为 cut 前后 settling 窗口排除：

| segment | 原始帧 | 稳定帧 | cut 帧 | CPU P50 (ms) | GPU phase P50 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| overview | 10 | 10 | 0 | 21.70 | 1.446 |
| occlusion-run | 20 | 20 | 0 | 22.90 | 1.281 |
| transparent-close | 9 | 9 | 0 | 21.00 | 1.235 |
| cut-recovery | 21 | 15 | 2 | 23.20 | 1.446 |

这组结果说明运动段的成本明显高于静止 full summary，尤其是遮挡和透明近景；但它仍是短 smoke，不能替代正式稳定基线。路径原始帧、稳定帧数量和 cut 标记都保留在 JSON 的 `camera.segments` 中，后续目标硬件可以直接复跑同一统计口径。

## 5. 渲染链路架构证据

`full` 的 FrameGraph 在本次运行中包含 48 个 executable passes、24 个 imported resources、43 个 transient resources（35 textures、8 buffers），无被错误保留的 culled resources。图中可以直接看到：

```text
Packed Visibility → Material Resolve → HZB/Hierarchy → Clustered Lighting
                 → GTAO / IBL → SSR → MBOIT Transparency
                 → Temporal Classification/TAA → Motion Blur
                 → Exposure → Bloom → Color Grade → Sharpen → Present
```

内存 evidence（1920×1080 full）：allocated 约 1.510 GiB，resident logical 约 542.4 MiB，transient pool 约 251.3 MiB，history 约 43.5 MiB，shadow atlas 64 MiB。该 allocated 值包含 transient pool capacity、纹理及表容量，不能当作物理 VRAM；报告同时保留 owner、reclaimable 和 fragmentation 字段，便于后续优化 allocator，而不是只看一个总数。

按 `docs/VALIDATION.md` 的预算合同，当前结果如下：

| owner / metric | 实测 | 预算 | 结论 |
| --- | ---: | ---: | --- |
| resident logical | 542.4 MiB | 512 MiB | 超出 30.4 MiB，需优化材质纹理 residency |
| transient pool | 251.3 MiB | 256 MiB | 余量约 4.7 MiB，接近上限 |
| history | 43.5 MiB | 128 MiB | 通过 |
| shadow atlas | 64 MiB | 128 MiB | 通过 |
| upload / frame | 1.85 KiB | 8 MiB | 通过 |
| readback / frame | 1.50 KiB | 256 KiB | 通过 |

resident 超预算的直接来源是 `materials.residentLogicalBytes` 约 533.1 MiB（25 张高分辨率纹理）；这不是 GPU 利用率，也不是物理 VRAM 查询。下一步应优先做纹理 mip/residency 降档和按材质 owner 的峰值拆分，而不是先动 visibility 或 post pass。

Feature-off 对照已经对全部 9 个 minus case 执行 active-pass gate；报告中的 `featureOffGates` 保存 full/variant labels 和 pass/fail reason。dirty 工作区会使底层 `validateBenchmarkEvidence().gateEligible=false`，这是故意的安全门禁，不影响 exploratory smoke 的数值分析；提交干净后即可复用同一 JSON 进行正式 gate。

## 6. 已修复的数据可靠性问题

- 修复 Packed MBOIT forward WGSL 从共享 lighting core 引入 `finite_f32` 后的重复声明；此前会产生真实 shader validation error。
- Benchmark 独占 `record` profiler mode，确保 manifest 中声明的 GPU counter cadence 真正启用，结束后恢复实时 profiler mode。
- readback ring 从 3 增大到 16，避免 headless/慢 adapter 在 benchmark window 内溢出；本次 smoke 和相机实验 dropped counter 均为 0。
- 增加 Inspector visible/hidden A/B 和逐帧 GPU counter coverage profile；后者在 60/60 measured frames 完成 readback，0 dropped/failed，证明 counter producer→readback consumer 链路可独立验证。
- 报告明确区分 CPU wall、timestamped GPU pass sum、counter coverage 和 diagnostics，避免把缺采样写成 0 ms 或把 CPU/GPU 时钟相加。
- 修正 `TextureResidency.evidence().residentTextureBytes`：它现在只统计仍被材质引用的 live layers；整张 texture-array bank 的物理 capacity 继续由 `allocatedBytes` 表示。此前该字段错误复用了 capacity，导致 Profiler 的 `packed.material.residentTextureBytes` 与 `GraphicsContext.memoryEvidence().owners.materials.residentLogicalBytes` 口径冲突。
- 尝试过把 FrameGraph 的创建/释放表和 `PassResources` 预编译复用；同条件浏览器回归未证明 `graph-execute` 下降，因此已撤回该实验。`graph-execute` 包含所有 pass callback 的命令编码时间，不能再把它整体误判为 FrameGraph 调度器自身开销；下一步需先取得逐 pass CPU encoding 分解。

## 7. 当前限制与后续执行顺序

1. 本次完整套件已在本地 Chrome headless adapter、1920×1080 DPR 1 下完成；仍需在目标桌面 Chrome、有固定 adapter 的同条件下复测，才能形成发布基线。
2. 当前 counter cadence 仍较稀疏；若需要稳定 counter P95，应在目标硬件上提高有效样本数量，或单独运行 counter profile，不能复用 timestamp baseline。
3. `automatic`/`locked` LOD 双轨、运动相机段和一次 cut 已实现；路径样本已覆盖 `overview`、`occlusion-run`、`transparent-close`、`cut-recovery`，并把每帧 camera distance/FOV/segment/cutId/lodMode 写入 profiler metadata。目标硬件仍需重复该实验。
4. 当前 1080p resident logical 超出 512 MiB 预算约 30.4 MiB，transient 仅剩约 4.7 MiB 余量；需要先优化纹理 residency 和 transient 峰值，再评估目标硬件是否满足预算。
5. Inspector 的实时页应优先显示 phase P50/P95、counter coverage、history bytes、FrameGraph active/pruned 和 evidence status；不显示没有 producer 的“估算 GPU 利用率”。
6. 已增加一个只在 Inspector `High detail`/`deep-capture` 模式启用的逐 pass CPU 编码分解 seam。一次 1280×720 本地 Chrome 探查中，`Packed Visibility/exact OPAQUE+MASK producer` 约 5.5 ms、`Material Resolve/classified visible pixels` 约 5.1 ms；由于 deep-capture 同时逐帧启用 timestamp/counter，样本速率很低（本次仅 1 个稳定样本），这些数字只用于定位候选，不是发布基线。下一步应在目标硬件以独立 deep-capture profile 收集至少 30 个稳定样本，再决定是否采用 render bundle、持久 bind group 或 pass 合并。
7. 针对上述热点已将 Packed Visibility 的 opaque/mask bind group，以及 Material Resolve 的静态 lookup bind group，移入资源 epoch 驱动的缓存。60 帧 `cpuPassTimings` smoke 中缓存前后 Packed Visibility 约为 4.8→4.6 ms、Material Resolve 约为 4.4→4.4 ms；总 CPU P50 在 28.45–29.15 ms 间波动，尚不足以宣称稳定收益。该切片的确定收益是减少每帧 descriptor 数组构造和 BindGroupCache key 计算；是否继续引入 render bundle，必须以目标硬件的稳定 pass 级样本为准。
8. 方向光 CSM 的相机投影重算已增加输入缓存，并用 1e-5 容差匹配矩阵/布局；同时增加 scene change revision + Packed GPU epoch 的 raster dirty gate。阴影 raster 只有投影变化、场景/实例内容变化或首次渲染时提交，静态帧跳过重复的 CSM 编码；动态 patch 会把当前帧显式标脏，避免 stale shadow。该阶段把 `shadow-update` 纳入 CPU section，并记录 `shadow.directionalCameraUpdates` / `shadow.directionalCameraCacheHits` / `shadow.directionalRasterDraws` / `shadow.directionalRasterSkips`。同一 1280×720、30+60 full smoke 中，静止段 60/60 帧命中相机缓存；运动 path 中 58/60 帧重算、2/60 命中，说明相机变化仍会使缓存失效。Rendering Lab 当前每帧注入动画 Packed patch，因此 smoke 中 raster skip 不会出现；需要后续增加静态 workload 以量化真正的 GPU/CPU 节省。当前 `shadow-update` P50 在 6.7–7.5 ms 间波动，仍不足以宣称固定收益。

原始浏览器产物保存在工作区外部临时目录的 `rendering-lab-none-automatic.json`、`rendering-lab-fixed-fov-locked.json`、`rendering-lab-path-automatic.json` 等文件；仓库只提交可复核的实现与本报告，避免把单机瞬时数值伪装成稳定基线。
