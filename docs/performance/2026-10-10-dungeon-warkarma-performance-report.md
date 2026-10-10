---
id: performance/dungeon-warkarma-2026-10-10
state: current
verifies:
  files:
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/main.ts
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/cooked-scene.ts
    - OEngine/src/gpu/GraphicsContext.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/shaders/vsm_receiver_demand.ts
    - validation/tools/run-dungeon-performance.mjs
    - validation/tools/analyze-dungeon-performance.mjs
---

# Dungeon Warkarma 近景性能诊断（2026-10-10）

对象：`examples/demos/14-integrated/dungeon-warkarma-texture-compression`。结论依据当前工作区的真实源码、独立 Chrome / WebGPU 测量、GPU timestamp、CPU sampling profile、Windows 进程内存与 NVIDIA 遥测。这里是一次诊断报告，未做生产渲染算法优化，也不代表正式 R4 性能验收。

## 1. 可以直接指导下一步的结论

1. **默认近景不能稳定达到 60 FPS。主要限制是 GPU 像素处理。** 新鲜默认基线三轮提交吞吐为 37.89 / 47.06 / 44.27 帧/s；CPU 提交 P50 为 1.83–2.12 ms，GPU command span 的多轮 P50 为约 19–23 ms。16.67 ms 只是本报告用于对照的 60 FPS 预算。不要把 CPU 的 2 ms 误读成整帧只需 2 ms。
2. **GPU 最大热点是 native winner shading，其次是 FSR 时域链、VSM demand。** 可比默认重复轮中 native 着色 P50 9.157 ms；temporal stage 5.671 ms；VSM receiver demand 1.776 ms。VSM 的采样成本还包含在 native 着色里。三者不是三个完全独立、可直接相加的 effect 总费用。
3. **显存预算与面板统计有明显问题。** 1080p 默认的 API 资源账本为 2348.30 MiB；Chrome 的 Windows 专用 GPU 内存约 2564 MiB；引擎面板只有 436.67 MiB。几何 banks + metadata 本身就占 1664 MiB。应先让全局账本覆盖全部真实 owner。
4. **同样近景、同样页面与画质，几何 banks 从 1536 改成 512 MiB 能确实节约 1024 MiB。** 512 对照保持 1207 resident pages / 381 pinned，未出现 eviction、reload、失败或 thrash；GPU P50 21.18 ms，没有证据表明帧率变快。它解决的是 4 GB 卡的资源余量问题。
5. **本地 cooked 加载仍需约 14–16 秒才首次可用。** 不是实时纹理压缩：该路径没有纹理解码、编码、转码、运行时 mip 生成。主要可见成本是读取/分层校验、几何 LZ4 解包、GPU 世界发布、异步管线准备和首帧 GPU 完成等待。
6. **CPU 优先改两个明确热点：几何反馈处理与示例统计刷新。** 驻留反馈 consumeCompleted 在 6.28 秒 CPU profile 中占 575 ms inclusive；snapshot 占 206 ms，其中材质图查询/编译占 175 ms inclusive。它们影响主线程余量与抖动，但单独修它们不足以消除 20 ms GPU 瓶颈。

## 2. 测试条件、近景证明与测量口径

| 项目 | 实际条件 |
|---|---|
| GPU | NVIDIA GeForce GTX 1650 Ti，4096 MiB，Turing，D3D12 WebGPU |
| CPU / RAM | i7-10750H，6C/12T；约 15.87 GiB 可见 RAM |
| OS / 驱动 / Chrome | Windows 11 Pro 10.0.22621；NVIDIA 581.42 / D3D 32.0.15.8142；Chrome 154.0.8037.98 |
| 电源 | 接通电源；Windows 平衡方案；没有改用户系统电源/风扇配置 |
| 实际运行 | 新 Chrome profile；主测试headless并补独立headed复核；Vite生产构建、localhost HTTP Range、COOP/COEP、DPR=1 |
| 输出 / 默认内部 | 1920×1080 / 1920×1080；FSR 开启且 renderScale=1 |
| 默认功能 | VSM high 4096² / 6 clip / PCF 4×4；jitter、HZB、cone 开；GTAO/Bloom 关 |
| 光照 | 物理天空、aerial 开；日历太阳 day44 / 13:00 / lat35 / lon0；sky=3 / sun=2.2 / fixedExposure=5 |
| 未包含成本 | 没有 authored local lights；SSR、screen-space GI 未接入当前 frame program |
| 场景 | Dungeon + 独立 playground；86875 源三角形、842 实例、33 材质、24 个唯一驻留纹理 Product |
| 工作区 | HEAD 6fb20fdc1969b73bc43aef152d6a354c8f547332，存在未提交修改；每套 raw 保存 source-fingerprint.json 与 dirtyPaths |

相机 position = (0.303839, 6.044173, -2.558241)，target = (-4.412154, 0.935180, -6.220996)，FOV=60°。相机在首次渲染之前应用。测量结束暂停并等待队列完成，通过真实 VisibilityKey → MeshletWork → instance slot 分类，只把 Dungeon 的 798 个实例纳入分子，排除地面与 playground。**默认 Dungeon 覆盖为 90.66–90.71%，完整画面有效几何覆盖 100%，invalid key=0。** 不是用模型包围盒或地面冒充 80%。对应截图见本地 .local/validation/dungeon-performance-baseline-2026-10-10/full.png。

主基线每组先预热至少 60 个提交帧，再取精确 240 帧；每组 CPU n=240、提交间隔 n=239。GPU 每 4 帧采样一帧，complete 且非 truncated，n=60。另有 360 帧复测，GPU n=90。小幅移动场景只有终点覆盖率读回（90.70%），没有连续覆盖率下界证明，因此它只是运动诊断，静态主结论来自固定相机。

口径必须分开：CPU 提交耗时包围 controls/camera/render 的同步调用，不包含所有异步反馈、DOM 或驱动进程；提交间隔是两次成功提交的回调时间差；GPU command span 是 timestamp 包围的命令区间，包含 pass 内工作和区间内空隙；queue completion 是提交至完成回调的延迟，包含排队、IPC/驱动和观察延迟；headless 的提交吞吐**不是显示器实际 presented FPS，也不是输入延迟**。CPU 与 GPU 会重叠，不能相加求整帧。

### 机器热状态

GPU 通常 89–91°C，默认主基线的遥测全部报告 thermal slowdown Active；正常轮 GPU utilization P50 99–100%，显存频率 6000 MHz。较稳默认第二轮 graphics MHz 为 1215–1245；最后 full 轮采到 300–1170 MHz。不同轮热状态显著变化。其他用户进程未被关闭，确认套开始时整卡已有 569 MiB 显存使用。遥测约 1.5 秒一次，不能把单个 P95 尖峰严格归因给温度。尤其不能把不同时间段的开关差值包装成精确百分比加速，也不使用粗暴频率归一化。

## 3. 默认帧时间完整分布

| 测量 | n | Mean ms | P50 | P90 | P95 | P99 | Max |
|---|---|---|---|---|---|---|---|
| 默认，无 timestamp #1 / CPU 提交 | 240 | 2.33 | 2.12 | 3.22 | 3.52 | 4.34 | 6.94 |
| 默认，无 timestamp #1 / 提交间隔 | 239 | 26.39 | 24.88 | 35.31 | 37.13 | 44.36 | 47.62 |
| 默认，无 timestamp #2 / CPU 提交 | 240 | 2.24 | 2.11 | 3.06 | 3.30 | 3.84 | 4.52 |
| 默认，无 timestamp #2 / 提交间隔 | 239 | 21.25 | 20.38 | 24.08 | 30.13 | 48.14 | 52.43 |
| 默认，无 timestamp #3 / CPU 提交 | 240 | 1.98 | 1.83 | 2.61 | 3.04 | 3.56 | 4.55 |
| 默认，无 timestamp #3 / 提交间隔 | 239 | 22.59 | 20.67 | 27.26 | 32.89 | 62.71 | 92.35 |
| 默认，coarse timing / CPU 提交 | 240 | 2.43 | 2.27 | 3.26 | 3.57 | 4.03 | 5.22 |
| 默认，coarse timing / 提交间隔 | 239 | 21.80 | 21.50 | 23.97 | 32.45 | 36.46 | 43.28 |
| 默认，coarse timing / GPU span | 60 | 21.61 | 21.45 | 21.94 | 22.09 | 35.20 | 35.20 |
| 默认，full timing / CPU 提交 | 240 | 2.57 | 2.41 | 3.50 | 3.89 | 4.61 | 4.81 |
| 默认，full timing / 提交间隔 | 239 | 25.20 | 21.46 | 32.42 | 50.96 | 90.36 | 153.29 |
| 默认，full timing / GPU span | 60 | 23.97 | 20.97 | 28.58 | 41.38 | 59.20 | 59.20 |

三组无 timestamp 的默认轮分别有 98.33% / 95.82% / 97.91% 的提交间隔超过 16.67 ms。第二轮均值 21.25 ms、P95 30.13 ms，第三轮 P99 62.71 ms。full GPU 60 个样本全部超过 16.67 ms；P95 41.38 ms、P99 59.20 ms。coarse GPU P50 21.45 / P95 22.09 ms，说明约 21 ms 的 GPU 中位成本并非仅由逐 pass timing 产生。

默认 normal-2 queue completion P50/P95 = 38.84/55.37 ms，normal-3 = 39.18/64.38 ms，full = 39.98/92.00 ms。该延迟不能当作单帧 GPU 执行时间。FrameCoordinator 持续报告 gpu-completion deferral，反映提交节奏受完成/在途约束；本次没有独立证明当前在途策略是最佳策略。

### 重复轮与尖峰

另以**独立有界面Chrome**复核三组各240帧，输出与内部仍1920×1080，相机覆盖90.66–90.71%，errors=[]。该轮graphics遥测稳定1350MHz，GPU利用率高，headless主结论得到复核：

| 有界面复核 | CPU P50/P95 ms | 提交吞吐帧/s | 提交间隔 P50/P95 ms | GPU P50/P95 ms |
|---|---|---|---|---|
| 默认，无 timestamp #1 | 2.34 / 3.49 | 41.58 | 19.64 / 36.41 | 未启用timestamp |
| 默认，coarse timing | 2.33 / 3.58 | 52.96 | 18.88 / 22.08 | 18.77 / 19.09 |
| 默认，full timing | 2.23 / 3.78 | 52.49 | 18.92 / 22.27 | 19.02 / 19.33 |

有界面full的GPU P50 19.02ms、P95 19.33ms仍超过16.67ms。即使这轮频率稳定，也没有达到默认60FPS的GPU预算。此复核同样只测提交吞吐，未获得display presented计数。

另一个完整对照套的默认 full / full-repeat GPU P50 是 19.19 / 20.77 ms，P95 是 26.02 / 22.86 ms。360 帧套的默认 full / full-repeat / full-end 为 21.40 / 21.72 / 22.73 ms，P95 为 35.19 / 48.66 / 44.40 ms。这些分布共同说明热状态和调度影响尾部，不能仅挑最好的一轮作为 baseline。

主基线 full frame1972 的 GPU span 59.20 ms，passSum 57.70 ms：native winner shading 27.71 ms、FSR Accumulate 7.57 ms、aerial 2.78 ms、reactivity 2.71 ms、VSM demand 2.43 ms。尖峰发生时多个 pass 同时膨胀；主要不是 JS render 调用偶发几十毫秒，也不是 timestamp 区间外单一空洞。GC、OS 观察器、其他任务与降频仍可能参与，未做逐尖峰硬件计数器归因。

## 4. GPU 架构与模块分解

下面使用确认套 full-repeat（默认，60 个 GPU 样本）。这是多轮主热点顺序一致的代表轮，避免将不同热状态下的 pass 拼成虚拟一帧。

| Profiler stage | P50 ms | P95 ms | Mean ms |
|---|---|---|---|
| native-surface | 9.59 | 10.87 | 10.04 |
| temporal | 5.67 | 6.68 | 5.93 |
| shadow | 2.50 | 3.20 | 2.58 |
| unclassified | 2.06 | 2.64 | 2.16 |
| lighting-and-ibl | 0.63 | 0.84 | 0.66 |
| hzb | 0.12 | 0.15 | 0.13 |
| local-light-work | 0.00 | 0.01 | 0.00 |
| observability | 0.00 | 0.00 | 0.00 |

| 真实 pass label（同名 pass 每帧聚合） | P50 ms | P95 ms | Mean ms |
|---|---|---|---|
| SurfaceV4/native winner shading | 9.157 | 10.392 | 9.574 |
| FSR3 Accumulate | 1.995 | 2.431 | 2.107 |
| VSM/receiver demand | 1.776 | 2.284 | 1.811 |
| FSR3 Prepare Reactivity | 0.856 | 1.093 | 0.897 |
| FSR3 Shading SPD | 0.646 | 0.844 | 0.684 |
| Native Temporal Facts/resolve | 0.658 | 0.797 | 0.675 |
| Environment/Aerial Perspective | 0.609 | 0.823 | 0.642 |
| FSR3 Prepare Inputs | 0.564 | 0.685 | 0.587 |
| SurfaceV4/bins classify | 0.407 | 0.523 | 0.433 |
| FSR3 Luma Instability | 0.374 | 0.616 | 0.403 |
| HZB/compute-pyramid | 0.362 | 0.459 | 0.377 |
| Surface/present radiance | 0.317 | 0.399 | 0.336 |
| Visibility/native material winner | 0.297 | 0.609 | 0.330 |
| FSR3 RCAS | 0.222 | 0.291 | 0.243 |
| S1 Product MeshletWork | 0.157 | 0.681 | 0.229 |
| R3-B/Hierarchy round 2 | 0.098 | 0.623 | 0.174 |
| FSR3 Luma SPD | 0.153 | 0.199 | 0.164 |
| R3-B/Hierarchy round 3 | 0.104 | 0.591 | 0.150 |
| Geometry/frame_instance_select | 0.077 | 0.597 | 0.144 |
| R3-B/Hierarchy round 1 | 0.103 | 0.230 | 0.132 |

stage 名称不是算法精确边界：native-surface 包含分 bin 管理；VSM 阴影采样在 native winner 内；lighting-and-ibl 的约 0.625 ms 主要是独立 aerial，而 IBL/BRDF 已融合在 native shader；HZB stage 只有约 0.118 ms，但按全部 HZB/compute-pyramid labels 聚合约 0.362 ms。不能据 stage 名字声称“所有 IBL 只花 0.6 ms”或“全部 HZB 只花 0.1 ms”。分位数不可相加，stage 的均值与逐 pass 原始帧更适合成本核算。

### Native winner shading：第一 GPU 优先级

GPU counter 的独立诊断轮每帧 shadedPixels=2073600；对应固定近景 Dungeon 自身约 188 万 pixels。native shader 包括 VisibilityKey 解码、meshlet/几何访问、重建插值与导数、材质纹理、PBR、天空 diffuse/specular IBL、太阳 irradiance、VSM query/PCF、曝光与色彩输出。源码 [OEngine/src/shaders/native_surface.ts:313](<D:/code/EEngine - 副本/OEngine/src/shaders/native_surface.ts:313>)、[OEngine/src/shaders/native_surface_lighting.ts:42](<D:/code/EEngine - 副本/OEngine/src/shaders/native_surface_lighting.ts:42>)、[OEngine/src/shaders/vsm_sampling.ts:81](<D:/code/EEngine - 副本/OEngine/src/shaders/vsm_sampling.ts:81>)。

GPU 原生着色在 scale50 降至 2.345 ms，scale75 为 5.712 ms；默认重复为 9.157 ms，说明像素相关成本高度重要。当前没有 shader occupancy、寄存器 spill、L2 命中、实际 DRAM 吞吐硬件计数器，**不能进一步宣判是纯 ALU bound、带宽 bound 或单一纹理 bound**。应先在同质量条件下拆量 reconstruction / material samples / IBL / sunlight / PCF，再决定优化。当前路径是 native GPU code 与 execution bins，不应恢复材质 VM 或每材质全屏扫描。

### VSM：静态热点在 demand 与 sampling

静态暂停读回 demand header 为 fine323–324 / written437–438 / overflow0；dirtyHeader written=0 / overflow0；casterHeader written=0 / failure0 / dirty_count0。该瞬间没有脏页需重绘，并不代表整个测试永远无脏页。独立 shadow stage 仍约 2.50 ms，其中 receiver demand 约 1.78 ms。另有约数毫秒的 query/PCF 费用融合在 native 着色中。

receiver demand 每个有效 receiver 像素读取 depth/key、解码 meshlet、读取 instance flags、重建 world/clip/page，最终 atomicOr 到 requested bitset：[OEngine/src/shaders/vsm_receiver_demand.ts:52](<D:/code/EEngine - 副本/OEngine/src/shaders/vsm_receiver_demand.ts:52>)。本相机大面积墙体落在少数页，atomic 地址集中可能有竞争，这是**待验证推断**。优先研究保持完整 receiver 覆盖的 workgroup 去重/聚合和查询成本，必须保留溢出、dirty、提交/中止/重试语义；不能靠漏像素、减少必需 demand 或恢复 GPU→CPU→GPU 控制换速度。

PCF1×1 对照 native shading P50 7.057 ms，默认前/后轮为 8.358 / 9.157 ms；PCF1 全 GPU 18.29 ms，仍超 16.67 ms。缩小 taps 可以定位采样成本，但改变阴影滤波质量，不是免费优化。太阳路径只按 ReceivesShadow 决定调用 VSM，没有先按背光面排除：[OEngine/src/shaders/native_surface_lighting.ts:43](<D:/code/EEngine - 副本/OEngine/src/shaders/native_surface_lighting.ts:43>)；是否可以跳过必须先证明法线、双面、BRDF 与能量语义，暂不作改动。

### FSR：在 100% 内部分辨率仍有显著成本

temporal stage 默认约 5.67 ms，包含约 0.66 ms Native Temporal Facts；FSR Accumulate 约 2.00 ms、reactivity0.86、prepareInputs0.56、shadingSPD0.65，再加 luma、locks、RCAS 等。关闭 FSR 后 temporal stage 仍约 0.64 ms，说明不能把整个 temporal 都算 FSR。FSR 在 100% 有时域抗锯齿/历史意义，不应因不放大就视为无功能。

scale50 时 Accumulate 仍约 1.77 ms（输出仍1080p），temporal stage 2.84 ms；内部像素减少到25%，输出分辨率部分不随之等比下降。这是后续降分辨率时会碰到的固定成本。

### 几何与 FrameGraph

固定近景 counter 观测：nodesTested666、clustersAccepted279、meshletWorksProduced601。暂停实际队列约601–605 written，invalid/overflow=0。计数器中的 rasterTriangles、meshletQueueWritten 等部分字段为0，但没有对应真实 producer 完整接线证据，**这些0不代表没有光栅三角形或没有 meshlet**；实际队列和截图证明有工作。

每个默认 full 帧的命令计数中位：83 compute pass、7 render pass、107 dispatch、27 draw、55 clearBuffer（8335168 B）、42 copyBuffer（112608 B）。full timing 另有26 marker pass、206 timestamp queries，仅用于诊断；不能把26个marker算生产图开销。宏图 declared transient44，live28（27textures+1buffer），culled16。Visibility raster约0.30 ms、所有HZB合计约0.36 ms、bins classify约0.41 ms，均明显小于着色9ms。dispatch/pass多值得分析 CPU 固定税，但本场景优先级低于最大 GPU 热点；不据数量直接合 megakernel。

## 5. 关闭/开启模块与分辨率对照

同场景、同相机、输出1080p；每组240帧、GPU n=60，唯一改变见行名。此套 CPU callback 环只能保留最后600个回调，部分 CPU/提交数据会截短，所以表中只用完整GPU样本；默认CPU采用后续修正后的主基线。

| 对照 | GPU P50 ms | P95 | P99 | 温度°C P50 | MHz P50 | Dungeon覆盖% | GPU n |
|---|---|---|---|---|---|---|---|
| 默认，coarse timing | 18.81 | 19.15 | 19.44 | 89 | 1350 | 90.70 | 60 |
| 默认，full timing | 19.19 | 26.02 | 31.91 | 90 | 885 | 90.71 | 60 |
| PCF 1×1 | 18.29 | 19.09 | 50.47 | 90 | 1245 | 90.69 | 60 |
| 默认重复，full | 20.77 | 22.86 | 56.18 | 90 | 1215 | 90.68 | 60 |
| VSM 关闭 | 16.02 | 16.87 | 25.32 | 90 | 1125 | 90.69 | 60 |
| FSR 关闭 | 14.65 | 28.74 | 33.34 | 89 | 1215 | 90.68 | 60 |
| 内部 1440×810 | 14.80 | 16.89 | 55.44 | 90 | 1170 | 90.68 | 60 |
| 内部 960×540 | 7.92 | 8.30 | 8.46 | 90 | 1350 | 90.68 | 60 |
| GTAO 开启 | 26.58 | 46.42 | 175.32 | 90 | 1170 | 90.68 | 60 |
| Bloom 开启 | 23.13 | 35.88 | 63.86 | 90 | 1170 | 90.68 | 60 |
| 微小相机运动 | 22.43 | 30.03 | 55.52 | 91 | 1125 | 90.70 | 60 |

VSM关闭总GPU降至16.02ms，native降至6.11ms，独立shadow stages消失；FSR关闭总GPU14.65ms；75%内部14.80ms、50%内部7.92ms；开启GTAO26.58ms、Bloom23.13ms。GTAO/Bloom本来默认关闭，所以它们不是默认性能不达标的现有原因。新增它们会进一步吃掉预算。每个开关改变功能或分辨率/质量，上表用于定位而不作为同画质优化收益。

## 6. CPU、主线程与稳态分配

主基线正常帧 CPU P50 1.83–2.12 ms，P95 3.04–3.53 ms。full中 graph-execute约1.6ms，view-prepare约0.25ms，scene-prepare约0.04ms，submit约0.09ms；这些段有嵌套不能相加。同步render低并不证明整个CPU系统开销低。

normal-2 CDP主线程 TaskDuration/墙钟=32.18%，ScriptDuration=14.85%。Chrome renderer进程总CPU约41.90%一个核、GPU进程37.22%一个核；normal-3约43.61%/35.38%。这是进程CPU秒/采样秒，GPU进程的百分比是**驱动进程的CPU消耗，不是GPU利用率**；不能直接称全机41%CPU，也不应除以核心数掩盖主线程成本。该进程采样间隔约2秒，较短区间只得少数样本。

1ms sampling CPU profile 时长 6278.80 ms，240帧，idle=4451.33 ms（约70.9%），GC=62.91 ms。idle表示被采样线程空闲/等待，不表示GPU空闲。热点如下，inclusive项相互嵌套，不可加总：

| 函数 / 工作 | Self ms | Inclusive ms |
|---|---|---|
| GeometryPageStreamingRuntime.consumeCompleted | 6.55 | 575.03 |
| deduplicateGeometryPageDemandsV1 | 153.76 | 184.24 |
| recordResidencyFeedback | 77.19 | 256.78 |
| ingestDemandReadback | 60.06 | 268.85 |
| 示例 snapshot | 1.15 | 206.09 |
| compileCanonicalMaterial | 10.58 | 174.94 |
| GPUDescriptorCaches.encodeDescriptorValue | 44.60 | 56.32 |

反馈路径存在对象解包、字段校验、字符串Map key、去重、排序，随后同一包再处理residency touch：[OEngine/src/gpu/GeometryPageDemandAbiV1.ts:233](<D:/code/EEngine - 副本/OEngine/src/gpu/GeometryPageDemandAbiV1.ts:233>)、[OEngine/src/gpu/GeometryPageStreamingRuntime.ts:260](<D:/code/EEngine - 副本/OEngine/src/gpu/GeometryPageStreamingRuntime.ts:260>)、[OEngine/src/gpu/GeometryPageStreamingRuntime.ts:398](<D:/code/EEngine - 副本/OEngine/src/gpu/GeometryPageStreamingRuntime.ts:398>)。稳态几何无上传、pending0时该工作仍持续。应研究数据导向解包/去重和驻留用量反馈频率，但不能删除eviction正确性必需的usage反馈。

示例 snapshot 会对runtime全部材质调用materialTextureLeaves，而这个helper调用compileCanonicalMaterial，再进入compileAppearanceGraph：[examples/demos/14-integrated/dungeon-warkarma-texture-compression/main.ts:156](<D:/code/EEngine - 副本/examples/demos/14-integrated/dungeon-warkarma-texture-compression/main.ts:156>)、[OEngine/src/assets/PcMaterialTextures.ts:49](<D:/code/EEngine - 副本/OEngine/src/assets/PcMaterialTextures.ts:49>)。它来自面板刷新及测试report轮询，并不是每帧重新创建GPU管线。应按实际材质/发布revision复用统计结果，减少重复图编译，先优化低风险诊断成本。

默认重复240帧窗口的API observer记录560次createBindGroup，合计同步host10.625ms，约2.33次/提交帧；没有createShaderModule/createComputePipeline/createRenderPipeline。已有descriptor/cache代码仍花CPU，但不能无证据地再加通用cache。观察器也有开销；该host时间只是API调用时长，非完整驱动工作。

## 7. 显存、RAM与容量利用

| 资源 / 指标 | MiB | 含义 |
|---|---|---|
| 几何 page banks | 1536.00 | 4 × 384 MiB，实际预分配，不是当前内容字节 |
| 几何 metadata heap | 128.00 | 示例显式请求，与几何 banks 分开计费 |
| TextureResidency BC7 array | 133.33 | 24 层内容 + 1 层 neutral，2048² / 12 mips |
| VSM | 76.14 | 其中 4096² depth32float atlas 为 64 MiB |
| FSR3 持久资源 | 75.15 | 不包括共享瞬态池中的 FSR 中间纹理 |
| Native Temporal Facts 身份双缓冲 | 63.28 | 2 × 1920 × 1080 × rgba32uint（16 B/px） |
| Atmosphere | 16.16 | 持久 LUT；静态下不是每帧全重建 |
| Geometry shared frame arena | 15.17 | 几何帧数据容量 |
| GpuMaterialStore | 7.13 | 表容量；33 个材质不等于 7 MiB 有效载荷 |
| 未命名资源（合计） | 287.56 | 含共享瞬态池及小 buffer；不能仅凭 label 归给某一个 effect |
| 其余资源 | 10.38 | HZB、native scratch、readback、场景表等 |
| 独立 WebGPU API 资源账本总计 | 2348.30 | 资源规格的 nominal footprint；不包含驱动对齐、swapchain、编译缓存 |
| 引擎 memory.allocatedBytes | 436.67 | 明显不是全 Renderer 的完整资源总计 |
| Windows 测试 Chrome 专用显存 | 2563.77 | 该轮 OS 观测，含驱动/浏览器开销 |
| Windows 测试 Chrome 共享 GPU 内存 | 152.92 | 系统内存映射/使用；不能直接解释成显存溢出 |

引擎全局统计入口 [OEngine/src/gpu/GraphicsContext.ts:327](<D:/code/EEngine - 副本/OEngine/src/gpu/GraphicsContext.ts:327>) 未合并几何全局budget，也没有完整纳入Renderer持有的VSM、FSR历史、时域identity及大气资源。API账本与面板相差约1911.64MiB。必须保留多个维度：allocated capacity、logical/resident payload、retiring、driver resident，不能用其中一个替另一个。

本次所有纹理格式都完成字节核算；早期工具漏了rgba32uint，raw仍保留null，analysis从尺寸/format重建63.28MiB，原始数据未改写。API账本追踪显式create/destroy，nominal texture bytes未加driver alignment，自动GC、后端lazy allocation、swapchain和pipeline内存也不在其中。修正后的512MiB复测每个未destroy资源的WeakRef均alive，没有账本中已GC但未destroy的资源。因此资源规格账本与Windows专用显存差值不能自动当泄漏。

默认几何resident slots占306.00MiB（1207pages，包括381pinned），累计真实上传仅28.97MiB，未evict/reload，slot内有效载荷约9.47%。1536MiB bank容量的slot占用约19.92%，真实上传约1.89%。这是小几何Product与固定page容量/packing的放大问题，不能把306MiB误称全部有效几何数据。源码page/profile容量与metadata分配 [OEngine/src/gpu/GeometryProductResidencyProfile.ts:7](<D:/code/EEngine - 副本/OEngine/src/gpu/GeometryProductResidencyProfile.ts:7>)、[OEngine/src/gpu/GeometryProductMultiRuntime.ts:252](<D:/code/EEngine - 副本/OEngine/src/gpu/GeometryProductMultiRuntime.ts:252>)；示例显式128MiBmetadata [examples/demos/14-integrated/dungeon-warkarma-texture-compression/cooked-scene.ts:149](<D:/code/EEngine - 副本/examples/demos/14-integrated/dungeon-warkarma-texture-compression/cooked-scene.ts:149>)。

修正格式核算后的资源账本首次可用前观测峰值2350.04MiB，整个默认测试生命周期峰值2423.45MiB（含开关/reset事务时重叠资源）；512MiB复测相应峰值1326.04/1399.45MiB。它们不是driver VRAM峰值。主基线所有OS采样的working set峰值1988MiB、private commit峰值4249MiB；该6秒采样峰值只是观察到的下界，不保证捕获短暂上传/事务峰值。

| 同近景容量对照 | 几何总容量MiB | API账本MiB | Windows专用显存MiB | GPU P50/P95 ms | resident/pinned/eviction/reload/failed |
|---|---|---|---|---|---|
| 默认1536 banks | 1664 | 2348.30 | 2563.77 | 20.97 / 41.38 | 1207 / 381 / 0 / 0 / 0 |
| 512 banks复测 | 640 | 1324.30 | 1531.96 | 21.18 / 53.23 | 1207 / 381 / 0 / 0 / 0 |

512方案节约1024MiB实测成立，而不是以删实例、降低纹理mip或变更相机换内存。该单场景容纳证明不保证全部复杂场景都可固定512MiB；后续应做可协商/内容驱动容量与packing，继续测运动、快速切视角、eviction/reload/overflow边界。

24份唯一驻留BC7内容约128.00MiB，RGBA等价512.00MiB，4倍压缩确实有效；纹理array133.33MiB包含neutral layer。没有runtime decode/encode/transcode/mip generation，因此继续优化实时codec不是本示例现有热点。

正常基线独立Chrome全部进程working set约1684–1842MiB，private commit约3786–3951MiB；JS used heap约193–219MiB，total约247–258MiB。working set相加可能重复共享物理页，private commit不是当前实际RAM驻留；ArrayBuffer/WASM/驱动进程不都在JS heap内。不能把4GiB commit解释为4GiB物理RAM，更不能把显存与CPUcommit直接相加。主基线整卡显存约3118–3139MiB，Chrome专用约2556–2566MiB，剩余包含桌面/其他进程，未见必须归因于显存溢出的证据。

## 8. 加载性能与可用性

新profile/baseline firstUseful=15.907s；无加载sampling的确认套14.050s；另一次加载profile14.874s；360帧套14.669s。fresh browser与cache disabled不等于物理磁盘冷缓存，localhost不代表真实网络、磁盘或生产CDN速度。时间从示例started标记算起；profile还包含导航和firstUseful轮询延迟。

| 主基线阶段边界差 | 时长s | 边界含义 |
|---|---|---|
| 开始→目录读取阶段 | 3.305 | Renderer初始化等，包含并发管线准备；不是纯网络 |
| 材质catalog及转入texture阶段 | .035 | JSON / scene dictionary处理 |
| 读取并校验BCProducts | 3.047 | fetch + 多层hash，24/25源product条目读取 |
| 打开geometry→GPU世界发布前 | 2.880 | pack目录、resident属性、root pages/解包等 |
| GPU世界发布→full mip promotion | 4.576 | 资源上传与native appearance pipeline准备，阶段存在并发 |
| mip promotion→首个GPU完成帧 | 2.063 | 首帧管线、上传、渲染与完成等待；不能全归为mip生成 |
| 首可用→fullQuality | 0.000205 | 约0.205ms，几乎同时，当前没有提前可用低mip帧的收益 |

主加载sampling时长16.703s，其中SubtleCrypto.digest self2151.57ms，LZ4 decode330.05ms，GC118.50ms，writeTextureProductPlane100.65ms。GPU审计在首次可用时记录1907次hash、644487648B（614.63MiB）hash输入，总promise elapsed2225.72ms（重叠不能直接当墙钟节约）。raw保留每次bytes/at/elapsed。TextureProduct、package section、runtime chunk、geometry page分别校验，重复扫描/拷贝是可信候选成本：[OEngine/src/assets/RuntimeAssetPackage.ts:431](<D:/code/EEngine - 副本/OEngine/src/assets/RuntimeAssetPackage.ts:431>)、[OEngine/src/assets/RuntimeAssetManifestV2.ts:274](<D:/code/EEngine - 副本/OEngine/src/assets/RuntimeAssetManifestV2.ts:274>)、[OEngine/src/assets/TextureProduct.ts:482](<D:/code/EEngine - 副本/OEngine/src/assets/TextureProduct.ts:482>)。不能直接删掉完整性校验，应先建立各层验证覆盖，避免已验证字节重复扫描，隔离主线程同步复制，再测。

原生appearance异步pipeline从create到resolve有3.99–4.29s，某些geometry pipelines约3.37s。这是promise延迟，包含驱动队列、并发编译及等待，不是函数同步CPU耗时，更不能把所有pipeline延迟加总成加载时间。稳态无新pipeline创建。加载优先看预热/去除重复构建与初始化并行关系，不能引入材质VM换管线数量。

初次可用前ResourceTiming有462项、encodedBodySize约143.50MiB；启动涉及大量小range请求，单纯源GLB的8.03MB不是实际runtime下载量。主基线观察到31个long task、累计2417ms、最长199ms，证实加载有明显主线程长任务。异步digest CPUprofile的self与promise计时含原生处理/复制，不等同hashworker纯CPU时间。

示例纹理Product用串行for/await读取与校验 [examples/demos/14-integrated/dungeon-warkarma-texture-compression/cooked-scene.ts:98](<D:/code/EEngine - 副本/examples/demos/14-integrated/dungeon-warkarma-texture-compression/cooked-scene.ts:98>)；可研究有界并发与tail-first，但要控制峰值内存。fullQuality只检查texture minimum mip0；cooked-scene.settled实际上是空async函数 [examples/demos/14-integrated/dungeon-warkarma-texture-compression/cooked-scene.ts:223](<D:/code/EEngine - 副本/examples/demos/14-integrated/dungeon-warkarma-texture-compression/cooked-scene.ts:223>)，不意味着所有几何streaming完成。近景稳态捕获另确认pending0、没有最近页面变化、uploaded plateau；本报告不会把firstUseful≈fullQuality解释成完整几何已加载。

## 9. 优化顺序与验收方式

| 优先级 | 具体行动 | 依据与预期作用 | 优化后必须测什么 |
|---|---|---|---|
| P0 测量 | 合并全Renderer显存owner；修面板shader统计；保存冷/热条件 | 避免把437MiB当完整资源，避免错误判零工作；使后续对照可信 | API规格账本 vs registered owners vs WDDM；相机覆盖≥80%；同温度/电源 |
| P0 显存 | 几何banks/metadata按场景与平台协商，研究小Product page packing | 512对照已节约1GiB；28.97MiB payload占306MiB slots，容量放大显著 | 相同内容/画质；长轨迹、evict/reload、overflow、generation、abort/retry |
| P1 GPU | 拆量并优化native reconstruction、IBL、BRDF、太阳与VSM query/PCF | 9ms级最大热点，近景像素数驱动；具体ALU/带宽瓶颈仍待硬件分析 | 相同分辨率与材质numeric/导数LOD/normal/HDR；P50/P95；新cost card |
| P1 GPU | VSM receiver demand完整覆盖前提下聚合/去重请求 | 静态脏页0仍付1.8ms demand；atomic热点是待证假设 | 完整demand、fine/coarse、dirty、invalid、overflow；实际GPU成本而非仅dispatch数 |
| P1 GPU | FSR内部过程与输出过程分别优化，分析100% temporal工作 | 约5ms级；scale50输出Accumulate仍1.77ms | 运动、jitter、history invalidation、disocclusion、pre-exposure与画质；不默认删功能 |
| P1 CPU | 反馈typed-data解包/去重、减少两次消费；usage反馈按owner优化 | consumeCompleted575ms/6.28s，稳态无上传仍持续 | resident usage、失效和淘汰不能漏；主线程profile、GC、P95 |
| P1 示例 | 按材质/发布revision缓存面板统计结果 | snapshot206ms，其中图编译175ms；低风险去掉重复查询 | report准确；动态材质变更与release刷新；正常模式CPUprofile |
| P1 加载 | 有界并发、tail-first、消除重复hash扫描/复制、pipeline准备前移 | 14–16s首可用，digest2.15s采样热点，pipeline延迟4.3s | 冷browser/OS缓存分开、峰值RAM/VRAM、实际首帧画质与几何settled |
| P2 编排 | 再看小pass、清零、descriptor序列化与资源寿命 | graph CPU1.6ms；带宽/命令税有证据但低于着色/FSR主热点 | 单一submit；相同工作量；不会以遗漏consumer换收益 |

用默认GPU P50约21ms对比16.67ms，需要减少约4.3ms（约21%的GPU时间）才刚够中位60FPS，仍未覆盖P95余量。这只是预算算术，不是承诺可获得的加速。资源账本、几何容量与面板重复编译可先作为局部工程优化；之后按单个GPUarchitecture unit做Cost Card、正确性闭包、同条件复测，避免同时改多个模块后失去归因。

## 10. 有效性、已知缺项与复现

- 主基线5组、确认套14组、headed3组全部完成，页面/console/GPU验证聚合errors=[]，没有失败allowlist；另512MiB复测完成。typecheck:dungeon与build:dungeon通过（bundle size / externalization warnings保留日志）。单次诊断不替代全引擎测试/正式验收。
- 360帧套只捕获11组，运行在会话边界中断，没有completedAt；这些已落盘capture只用于重复一致性，不称整套完成。早期camera calibration中无≥80%时会主动报失败，失败保留；最终所有主静态camera guards通过。
- 早期600callback环有截断，2048profiler history有快照复制膨胀，均不用于主CPU结论；最终显式performanceCapture模式把callback上限增到8000，profiler每组clear、history512。正常演示上限仍600。无生产renderer算法变更。
- API observer、1秒report轮询、500ms面板刷新、1.5秒NVIDIA/2秒CDP/6秒Windows CIM观察器都有诊断税；CPU profile单独跑，GPU counters另跑，不把它们当无开销生产测量。coarse与full、无timing基线分开列，但热状态变化阻止精确相减诊断税。
- 未拿到shader硬件occupancy、cache/DRAM/PCIe吞吐、CPU温度/频率、真实presented FPS、swapchain驻留或长期泄漏曲线。没有替这些字段编造数值。BC7功能证据成立，完整画质numeric验收尚未做。
- release后textureOwnerZero=true且geometry budget归零；示例report的memory字段可能来自lastSnapshot，不能据stale snapshot判断仍分配/泄漏。Windows采样也太稀，不把单次release当长期泄漏证明。

原始证据目录（均为本地artifact，未提交）：

| 目录 | 用途 |
|---|---|
| .local/validation/dungeon-performance-baseline-2026-10-10 | 修正后的默认完整CPU窗口、GPU基线、load/steady CPU profile、源码maps |
| .local/validation/dungeon-performance-confirmation-2026-10-10 | 14组开关、分辨率、运动与counters完整GPU对照 |
| .local/validation/dungeon-performance-clean-2026-10-10 | 11组360帧重复；套中断，局部capture有效 |
| .local/validation/dungeon-performance-memory-confirmation-2026-10-10 | 修正后的512MiB同场景显存验证 |
| .local/validation/dungeon-performance-headed-2026-10-10 | 独立有界面Chrome、稳定1350MHz复核，3组完成 |
| .local/validation/dungeon-performance-near-final-2026-10-10 | 早期history膨胀诊断，非主baseline |
| .local/validation/dungeon-performance-loading-2026-10-10 | 辅助加载hash/pipeline observer复测，包含一个误命名capture，不用于对照 |

每组原始JSON包含精确targetStart/targetEnd、CPUcallbacks、GPU段的start/end ticks、网络ResourceTiming/CDP事件、进程CPU秒、RAM/WDDM与NVIDIA时间戳、完整资源规格、覆盖计数与VSMheader。analysis.json采用nearest-rank分位数，不剔除异常值。相机/分辨率/功能开关均保存在renderState。dashboard.html包含同数据的分布、pass与资源图；frame-samples.csv与gpu-pass-summary.csv供进一步分析。

复现（GPU作业串行，先构建，输出目录使用新名字）：

```powershell
cd examples
npm run build:dungeon
cd ..
node validation/tools/run-dungeon-performance.mjs --near --frames 240 --scenarios normal-1,normal-2,normal-3,coarse,full --load-profile --cpu-profile --out .local/validation/dungeon-new-baseline
node validation/tools/analyze-dungeon-performance.mjs .local/validation/dungeon-new-baseline
node validation/tools/analyze-dungeon-performance.mjs .local/validation/dungeon-new-baseline load.cpuprofile
node validation/tools/run-dungeon-performance.mjs --near --geometryMiB 512 --frames 240 --scenarios full --out .local/validation/dungeon-new-memory
```

独立headed复核已完成；后续正式对照仍应固定热状态/无竞争任务环境，并加入较长相机轨迹。本报告已经定位当前示例的真实热运行瓶颈，不把其他未测条件当已经达标。
