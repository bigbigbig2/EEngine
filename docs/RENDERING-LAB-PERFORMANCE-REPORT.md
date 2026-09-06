# Rendering Lab 性能与架构分析报告

日期：2026-09-06  
状态：已完成本地 Chrome 完整 11 case 正式长跑、相机距离/锁定 LOD 归因和运动路径实验；目标桌面硬件复测待执行。

## 1. 本次实际执行

测试入口是 `examples/rendering-lab/`，通过 Playwright 控制本地 Chrome，WebGPU canvas 为 1280×720、DPR 1，固定 seed `20260906`。正式长跑为每个 case 120 warm-up + 480 measured frames；GPU timestamp cadence 为 8，GPU counter cadence 为 11，readback ring 为 16 slots。另保留 30+60 的快速 smoke 配置用于开发迭代。

工作负载 manifest 已固定并写入报告：816 instances、806 geometries、34 materials、2 个透明实例，Dungeon GLB 与 Venice HDR 都记录 SHA-256。全效果请求包含 CSM、GTAO、SSR、MBOIT、TAA、motion blur、自动曝光、Bloom、color grading、sharpening 和 tonemap。

## 2. 正式完整套件结果（本地 Chrome）

以下数据来自 `rendering-lab-none-automatic-1920x1080.json`，11 个 case 均完成，诊断错误为 0；timestamped GPU phase 的有效窗口为 436/480，GPU counter readback 为 5–6/480，CPU/runtime counters 为 480/480。工作区处于 dirty 状态，因此 evidence gate 仍按安全规则标记为不可提交基线，但不影响数值和 feature-off 归因。

| Case | CPU P50 / P95 / P99 (ms) | GPU phase P50 / P95 / P99 (ms) | timestamp frames | diagnostics |
| --- | ---: | ---: | ---: | ---: |
| `base` | 10.00 / 11.40 / 12.30 | 0.682 / 0.703 / 0.971 | 436/480 | 0 |
| `full` | 17.00 / 19.20 / 20.80 | 1.445 / 1.636 / 1.793 | 436/480 | 0 |
| `full-minus-shadow` | 14.00 / 16.00 / 16.74 | 0.995 / 1.255 / 1.324 | 437/480 | 0 |
| `full-minus-gtao` | 17.50 / 22.20 / 23.62 | 1.205 / 1.436 / 1.506 | 436/480 | 0 |
| `full-minus-ssr` | 16.05 / 18.30 / 19.12 | 1.446 / 1.727 / 1.849 | 437/480 | 0 |
| `full-minus-transparency` | 15.10 / 16.90 / 17.74 | 1.356 / 1.632 / 1.699 | 436/480 | 0 |
| `full-minus-temporal` | 17.40 / 20.40 / 25.58 | 1.443 / 1.712 / 1.753 | 437/480 | 0 |
| `full-minus-bloom` | 17.00 / 19.61 / 21.24 | 1.445 / 1.724 / 1.764 | 436/480 | 0 |
| `full-minus-exposure` | 17.00 / 18.80 / 19.62 | 1.444 / 1.730 / 1.906 | 437/480 | 0 |
| `full-minus-motion-blur` | 16.90 / 19.00 / 19.80 | 1.444 / 1.720 / 1.753 | 436/480 | 0 |
| `full-minus-sharpen` | 17.30 / 19.50 / 20.84 | 1.442 / 1.569 / 1.774 | 436/480 | 0 |

从 `full` 到 minus case 的 counter/active-pass gate 全部通过。CPU 端最明显的去除项是 CSM shadow（P50 下降 3.0 ms），其次是 transparency（1.9 ms）、SSR（1.0 ms）和 motion blur（0.1 ms）；这些是当前 workload 的相关性结果，不等同于单个 feature 的纯 GPU 成本。`full` 相对 `base` 的 CPU P50 增量为 7.0 ms，timestamped GPU phase 增量为 0.763 ms。

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
| overview | 10 | 10 | 0 | 22.50 | 8.605 |
| occlusion-run | 20 | 20 | 0 | 23.60 | 10.228 |
| transparent-close | 9 | 9 | 0 | 22.50 | 11.117 |
| cut-recovery | 21 | 15 | 2 | 24.70 | 7.738 |

这组结果说明运动段的成本明显高于静止 full summary，尤其是遮挡和透明近景；但它仍是短 smoke，不能替代正式稳定基线。路径原始帧、稳定帧数量和 cut 标记都保留在 JSON 的 `camera.segments` 中，后续目标硬件可以直接复跑同一统计口径。

## 5. 渲染链路架构证据

`full` 的 FrameGraph 在本次运行中包含 42 个 executable passes、24 个 imported resources、44 个 transient resources（36 textures、8 buffers），无被错误保留的 culled resources。图中可以直接看到：

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
- 报告明确区分 CPU wall、timestamped GPU pass sum、counter coverage 和 diagnostics，避免把缺采样写成 0 ms 或把 CPU/GPU 时钟相加。

## 7. 当前限制与后续执行顺序

1. 本次完整套件已在本地 Chrome headless adapter、1920×1080 DPR 1 下完成；仍需在目标桌面 Chrome、有固定 adapter 的同条件下复测，才能形成发布基线。
2. 当前 counter cadence 仍较稀疏；若需要稳定 counter P95，应在目标硬件上提高有效样本数量，或单独运行 counter profile，不能复用 timestamp baseline。
3. `automatic`/`locked` LOD 双轨、运动相机段和一次 cut 已实现；路径样本已覆盖 `overview`、`occlusion-run`、`transparent-close`、`cut-recovery`，并把每帧 camera distance/FOV/segment/cutId/lodMode 写入 profiler metadata。目标硬件仍需重复该实验。
4. 当前 1080p resident logical 超出 512 MiB 预算约 30.4 MiB，transient 仅剩约 4.7 MiB 余量；需要先优化纹理 residency 和 transient 峰值，再评估目标硬件是否满足预算。
5. Inspector 的实时页应优先显示 phase P50/P95、counter coverage、history bytes、FrameGraph active/pruned 和 evidence status；不显示没有 producer 的“估算 GPU 利用率”。

原始浏览器产物保存在工作区外部临时目录的 `rendering-lab-none-automatic.json`、`rendering-lab-fixed-fov-locked.json`、`rendering-lab-path-automatic.json` 等文件；仓库只提交可复核的实现与本报告，避免把单机瞬时数值伪装成稳定基线。
