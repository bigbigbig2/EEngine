import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const base = ".local/validation/dungeon-performance-baseline-2026-10-10";
const contrast = ".local/validation/dungeon-performance-confirmation-2026-10-10";
const clean = ".local/validation/dungeon-performance-clean-2026-10-10";
const small = ".local/validation/dungeon-performance-memory-confirmation-2026-10-10";
const headed = ".local/validation/dungeon-performance-headed-2026-10-10";
const json = async (p) => JSON.parse(await readFile(resolve(root, p), "utf8"));
const [a, b, c, m, suite, loading] = await Promise.all([
  json(base + "/analysis.json"),
  json(contrast + "/analysis.json"),
  json(clean + "/analysis.json"),
  json(small + "/analysis.json"),
  json(base + "/suite.json"),
  json(base + "/loading-analysis.json")
]);
const full = a.captures.find((v) => v.name === "full");
const visible = await json(headed + "/analysis.json");
const repeat = b.captures.find((v) => v.name === "full-repeat");
const source = (p, line) =>
  `[${p}${line ? ":" + line : ""}](<${resolve(root, p).replaceAll("\\", "/")}${line ? ":" + line : ""}>)`;
const fmt = (n, digits = 2) => (n == null ? "—" : Number(n).toFixed(digits));
const table = (head, rows) =>
  "| " +
  head.join(" | ") +
  " |\n|" +
  head.map(() => "---").join("|") +
  "|\n" +
  rows.map((r) => "| " + r.join(" | ") + " |").join("\n");
const short = (label) => label.replace("Renderer/visibility-frame/", "");
const statrow = (name, s) => [
  name,
  s?.n ?? 0,
  fmt(s?.mean),
  fmt(s?.p50),
  fmt(s?.p90),
  fmt(s?.p95),
  fmt(s?.p99),
  fmt(s?.max)
];
const head = ["测量", "n", "Mean ms", "P50", "P90", "P95", "P99", "Max"];
const modules = Object.entries(repeat.stages).map(([label, s]) => [
  short(label),
  fmt(s.p50),
  fmt(s.p95),
  fmt(s.mean)
]);
const passes = Object.entries(repeat.passes)
  .slice(0, 20)
  .map(([label, s]) => [short(label), fmt(s.p50, 3), fmt(s.p95, 3), fmt(s.mean, 3)]);
const cpuProfile = a.cpuProfile;
const lookup = (profile, category, fragment) =>
  profile[category].find(([name]) => name.includes(fragment))?.[1] ?? 0;
const out = resolve(root, ".local/validation/dungeon-performance-report-2026-10-10");
await mkdir(out, { recursive: true });
const labels = {
  "normal-1": "默认，无 timestamp #1",
  "normal-2": "默认，无 timestamp #2",
  "normal-3": "默认，无 timestamp #3",
  coarse: "默认，coarse timing",
  full: "默认，full timing",
  "full-repeat": "默认重复，full",
  "pcf-1": "PCF 1×1",
  "no-vsm": "VSM 关闭",
  "no-fsr": "FSR 关闭",
  "scale-75": "内部 1440×810",
  "scale-50": "内部 960×540",
  "ao-on": "GTAO 开启",
  "bloom-on": "Bloom 开启",
  motion: "微小相机运动",
  counters: "额外 GPU counters",
  "baseline-repeat": "默认末轮，无 timing"
};
const frameRows = a.captures.flatMap((v) => [
  statrow(labels[v.name] + " / CPU 提交", v.cpuHost),
  statrow(labels[v.name] + " / 提交间隔", v.submissionInterval),
  ...(v.gpu ? [statrow(labels[v.name] + " / GPU span", v.gpu)] : [])
]);
const contrasts = b.captures.filter((v) => v.gpu && v.name !== "counters");
const diffRows = contrasts.map((v) => [
  labels[v.name],
  fmt(v.gpu.p50),
  fmt(v.gpu.p95),
  fmt(v.gpu.p99),
  fmt(v.sensors.temperatureC?.p50, 0),
  fmt(v.sensors.graphicsMHz?.p50, 0),
  fmt(v.coverage.ratio * 100),
  v.gpu.n
]);
const memoryRows = [
  ["几何 page banks", "1536.00", "4 × 384 MiB，实际预分配，不是当前内容字节"],
  ["几何 metadata heap", "128.00", "示例显式请求，与几何 banks 分开计费"],
  ["TextureResidency BC7 array", "133.33", "24 层内容 + 1 层 neutral，2048² / 12 mips"],
  ["VSM", "76.14", "其中 4096² depth32float atlas 为 64 MiB"],
  ["FSR3 持久资源", "75.15", "不包括共享瞬态池中的 FSR 中间纹理"],
  ["Native Temporal Facts 身份双缓冲", "63.28", "2 × 1920 × 1080 × rgba32uint（16 B/px）"],
  ["Atmosphere", "16.16", "持久 LUT；静态下不是每帧全重建"],
  ["Geometry shared frame arena", "15.17", "几何帧数据容量"],
  ["GpuMaterialStore", "7.13", "表容量；33 个材质不等于 7 MiB 有效载荷"],
  ["未命名资源（合计）", "287.56", "含共享瞬态池及小 buffer；不能仅凭 label 归给某一个 effect"],
  [
    "其余资源",
    fmt(
      full.memory.independentGpuMiB -
        1536 -
        128 -
        133.33396911621094 -
        76.14464569091797 -
        75.14651489257812 -
        63.28125 -
        16.164154052734375 -
        15.17236328125 -
        7.125 -
        287.5552291870117
    ),
    "HZB、native scratch、readback、场景表等"
  ],
  [
    "独立 WebGPU API 资源账本总计",
    fmt(full.memory.independentGpuMiB),
    "资源规格的 nominal footprint；不包含驱动对齐、swapchain、编译缓存"
  ],
  ["引擎 memory.allocatedBytes", fmt(full.memory.engineMiB), "明显不是全 Renderer 的完整资源总计"],
  ["Windows 测试 Chrome 专用显存", fmt(full.memory.os[0].dedicatedMiB), "该轮 OS 观测，含驱动/浏览器开销"],
  [
    "Windows 测试 Chrome 共享 GPU 内存",
    fmt(full.memory.os[0].sharedMiB),
    "系统内存映射/使用；不能直接解释成显存溢出"
  ]
];
const report = `---
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

对象：\`examples/demos/14-integrated/dungeon-warkarma-texture-compression\`。结论依据当前工作区的真实源码、独立 Chrome / WebGPU 测量、GPU timestamp、CPU sampling profile、Windows 进程内存与 NVIDIA 遥测。这里是一次诊断报告，未做生产渲染算法优化，也不代表正式 R4 性能验收。

## 1. 可以直接指导下一步的结论

1. **默认近景不能稳定达到 60 FPS。主要限制是 GPU 像素处理。** 新鲜默认基线三轮提交吞吐为 ${a.captures
  .slice(0, 3)
  .map((v) => fmt(v.submissionFPS))
  .join(
    " / "
  )} 帧/s；CPU 提交 P50 为 1.83–2.12 ms，GPU command span 的多轮 P50 为约 19–23 ms。16.67 ms 只是本报告用于对照的 60 FPS 预算。不要把 CPU 的 2 ms 误读成整帧只需 2 ms。
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
| OS / 驱动 / Chrome | Windows 11 Pro 10.0.22621；NVIDIA 581.42 / D3D 32.0.15.8142；Chrome ${suite.chromeVersion} |
| 电源 | 接通电源；Windows 平衡方案；没有改用户系统电源/风扇配置 |
| 实际运行 | 新 Chrome profile；主测试headless并补独立headed复核；Vite生产构建、localhost HTTP Range、COOP/COEP、DPR=1 |
| 输出 / 默认内部 | 1920×1080 / 1920×1080；FSR 开启且 renderScale=1 |
| 默认功能 | VSM high 4096² / 6 clip / PCF 4×4；jitter、HZB、cone 开；GTAO/Bloom 关 |
| 光照 | 物理天空、aerial 开；日历太阳 day44 / 13:00 / lat35 / lon0；sky=3 / sun=2.2 / fixedExposure=5 |
| 未包含成本 | 没有 authored local lights；SSR、screen-space GI 未接入当前 frame program |
| 场景 | Dungeon + 独立 playground；86875 源三角形、842 实例、33 材质、24 个唯一驻留纹理 Product |
| 工作区 | HEAD ${suite.revision}，存在未提交修改；每套 raw 保存 source-fingerprint.json 与 dirtyPaths |

相机 position = (0.303839, 6.044173, -2.558241)，target = (-4.412154, 0.935180, -6.220996)，FOV=60°。相机在首次渲染之前应用。测量结束暂停并等待队列完成，通过真实 VisibilityKey → MeshletWork → instance slot 分类，只把 Dungeon 的 798 个实例纳入分子，排除地面与 playground。**默认 Dungeon 覆盖为 90.66–90.71%，完整画面有效几何覆盖 100%，invalid key=0。** 不是用模型包围盒或地面冒充 80%。对应截图见本地 ${base}/full.png。

主基线每组先预热至少 60 个提交帧，再取精确 240 帧；每组 CPU n=240、提交间隔 n=239。GPU 每 4 帧采样一帧，complete 且非 truncated，n=60。另有 360 帧复测，GPU n=90。小幅移动场景只有终点覆盖率读回（90.70%），没有连续覆盖率下界证明，因此它只是运动诊断，静态主结论来自固定相机。

口径必须分开：CPU 提交耗时包围 controls/camera/render 的同步调用，不包含所有异步反馈、DOM 或驱动进程；提交间隔是两次成功提交的回调时间差；GPU command span 是 timestamp 包围的命令区间，包含 pass 内工作和区间内空隙；queue completion 是提交至完成回调的延迟，包含排队、IPC/驱动和观察延迟；headless 的提交吞吐**不是显示器实际 presented FPS，也不是输入延迟**。CPU 与 GPU 会重叠，不能相加求整帧。

### 机器热状态

GPU 通常 89–91°C，默认主基线的遥测全部报告 thermal slowdown Active；正常轮 GPU utilization P50 99–100%，显存频率 6000 MHz。较稳默认第二轮 graphics MHz 为 1215–1245；最后 full 轮采到 300–1170 MHz。不同轮热状态显著变化。其他用户进程未被关闭，确认套开始时整卡已有 569 MiB 显存使用。遥测约 1.5 秒一次，不能把单个 P95 尖峰严格归因给温度。尤其不能把不同时间段的开关差值包装成精确百分比加速，也不使用粗暴频率归一化。

## 3. 默认帧时间完整分布

${table(head, frameRows)}

三组无 timestamp 的默认轮分别有 ${a.captures
  .slice(0, 3)
  .map((v) => fmt(v.submissionInterval.over16_67Percent) + "%")
  .join(
    " / "
  )} 的提交间隔超过 16.67 ms。第二轮均值 21.25 ms、P95 30.13 ms，第三轮 P99 62.71 ms。full GPU 60 个样本全部超过 16.67 ms；P95 41.38 ms、P99 59.20 ms。coarse GPU P50 21.45 / P95 22.09 ms，说明约 21 ms 的 GPU 中位成本并非仅由逐 pass timing 产生。

默认 normal-2 queue completion P50/P95 = 38.84/55.37 ms，normal-3 = 39.18/64.38 ms，full = 39.98/92.00 ms。该延迟不能当作单帧 GPU 执行时间。FrameCoordinator 持续报告 gpu-completion deferral，反映提交节奏受完成/在途约束；本次没有独立证明当前在途策略是最佳策略。

### 重复轮与尖峰

另以**独立有界面Chrome**复核三组各240帧，输出与内部仍1920×1080，相机覆盖90.66–90.71%，errors=[]。该轮graphics遥测稳定1350MHz，GPU利用率高，headless主结论得到复核：

${table(
  ["有界面复核", "CPU P50/P95 ms", "提交吞吐帧/s", "提交间隔 P50/P95 ms", "GPU P50/P95 ms"],
  visible.captures.map((v) => [
    labels[v.name],
    fmt(v.cpuHost.p50) + " / " + fmt(v.cpuHost.p95),
    fmt(v.submissionFPS),
    fmt(v.submissionInterval.p50) + " / " + fmt(v.submissionInterval.p95),
    v.gpu ? fmt(v.gpu.p50) + " / " + fmt(v.gpu.p95) : "未启用timestamp"
  ])
)}

有界面full的GPU P50 19.02ms、P95 19.33ms仍超过16.67ms。即使这轮频率稳定，也没有达到默认60FPS的GPU预算。此复核同样只测提交吞吐，未获得display presented计数。

另一个完整对照套的默认 full / full-repeat GPU P50 是 19.19 / 20.77 ms，P95 是 26.02 / 22.86 ms。360 帧套的默认 full / full-repeat / full-end 为 21.40 / 21.72 / 22.73 ms，P95 为 35.19 / 48.66 / 44.40 ms。这些分布共同说明热状态和调度影响尾部，不能仅挑最好的一轮作为 baseline。

主基线 full frame1972 的 GPU span 59.20 ms，passSum 57.70 ms：native winner shading 27.71 ms、FSR Accumulate 7.57 ms、aerial 2.78 ms、reactivity 2.71 ms、VSM demand 2.43 ms。尖峰发生时多个 pass 同时膨胀；主要不是 JS render 调用偶发几十毫秒，也不是 timestamp 区间外单一空洞。GC、OS 观察器、其他任务与降频仍可能参与，未做逐尖峰硬件计数器归因。

## 4. GPU 架构与模块分解

下面使用确认套 full-repeat（默认，60 个 GPU 样本）。这是多轮主热点顺序一致的代表轮，避免将不同热状态下的 pass 拼成虚拟一帧。

${table(["Profiler stage", "P50 ms", "P95 ms", "Mean ms"], modules)}

${table(["真实 pass label（同名 pass 每帧聚合）", "P50 ms", "P95 ms", "Mean ms"], passes)}

stage 名称不是算法精确边界：native-surface 包含分 bin 管理；VSM 阴影采样在 native winner 内；lighting-and-ibl 的约 0.625 ms 主要是独立 aerial，而 IBL/BRDF 已融合在 native shader；HZB stage 只有约 0.118 ms，但按全部 HZB/compute-pyramid labels 聚合约 0.362 ms。不能据 stage 名字声称“所有 IBL 只花 0.6 ms”或“全部 HZB 只花 0.1 ms”。分位数不可相加，stage 的均值与逐 pass 原始帧更适合成本核算。

### Native winner shading：第一 GPU 优先级

GPU counter 的独立诊断轮每帧 shadedPixels=2073600；对应固定近景 Dungeon 自身约 188 万 pixels。native shader 包括 VisibilityKey 解码、meshlet/几何访问、重建插值与导数、材质纹理、PBR、天空 diffuse/specular IBL、太阳 irradiance、VSM query/PCF、曝光与色彩输出。源码 ${source("OEngine/src/shaders/native_surface.ts", 313)}、${source("OEngine/src/shaders/native_surface_lighting.ts", 42)}、${source("OEngine/src/shaders/vsm_sampling.ts", 81)}。

GPU 原生着色在 scale50 降至 2.345 ms，scale75 为 5.712 ms；默认重复为 9.157 ms，说明像素相关成本高度重要。当前没有 shader occupancy、寄存器 spill、L2 命中、实际 DRAM 吞吐硬件计数器，**不能进一步宣判是纯 ALU bound、带宽 bound 或单一纹理 bound**。应先在同质量条件下拆量 reconstruction / material samples / IBL / sunlight / PCF，再决定优化。当前路径是 native GPU code 与 execution bins，不应恢复材质 VM 或每材质全屏扫描。

### VSM：静态热点在 demand 与 sampling

静态暂停读回 demand header 为 fine323–324 / written437–438 / overflow0；dirtyHeader written=0 / overflow0；casterHeader written=0 / failure0 / dirty_count0。该瞬间没有脏页需重绘，并不代表整个测试永远无脏页。独立 shadow stage 仍约 2.50 ms，其中 receiver demand 约 1.78 ms。另有约数毫秒的 query/PCF 费用融合在 native 着色中。

receiver demand 每个有效 receiver 像素读取 depth/key、解码 meshlet、读取 instance flags、重建 world/clip/page，最终 atomicOr 到 requested bitset：${source("OEngine/src/shaders/vsm_receiver_demand.ts", 52)}。本相机大面积墙体落在少数页，atomic 地址集中可能有竞争，这是**待验证推断**。优先研究保持完整 receiver 覆盖的 workgroup 去重/聚合和查询成本，必须保留溢出、dirty、提交/中止/重试语义；不能靠漏像素、减少必需 demand 或恢复 GPU→CPU→GPU 控制换速度。

PCF1×1 对照 native shading P50 7.057 ms，默认前/后轮为 8.358 / 9.157 ms；PCF1 全 GPU 18.29 ms，仍超 16.67 ms。缩小 taps 可以定位采样成本，但改变阴影滤波质量，不是免费优化。太阳路径只按 ReceivesShadow 决定调用 VSM，没有先按背光面排除：${source("OEngine/src/shaders/native_surface_lighting.ts", 43)}；是否可以跳过必须先证明法线、双面、BRDF 与能量语义，暂不作改动。

### FSR：在 100% 内部分辨率仍有显著成本

temporal stage 默认约 5.67 ms，包含约 0.66 ms Native Temporal Facts；FSR Accumulate 约 2.00 ms、reactivity0.86、prepareInputs0.56、shadingSPD0.65，再加 luma、locks、RCAS 等。关闭 FSR 后 temporal stage 仍约 0.64 ms，说明不能把整个 temporal 都算 FSR。FSR 在 100% 有时域抗锯齿/历史意义，不应因不放大就视为无功能。

scale50 时 Accumulate 仍约 1.77 ms（输出仍1080p），temporal stage 2.84 ms；内部像素减少到25%，输出分辨率部分不随之等比下降。这是后续降分辨率时会碰到的固定成本。

### 几何与 FrameGraph

固定近景 counter 观测：nodesTested666、clustersAccepted279、meshletWorksProduced601。暂停实际队列约601–605 written，invalid/overflow=0。计数器中的 rasterTriangles、meshletQueueWritten 等部分字段为0，但没有对应真实 producer 完整接线证据，**这些0不代表没有光栅三角形或没有 meshlet**；实际队列和截图证明有工作。

每个默认 full 帧的命令计数中位：83 compute pass、7 render pass、107 dispatch、27 draw、55 clearBuffer（8335168 B）、42 copyBuffer（112608 B）。full timing 另有26 marker pass、206 timestamp queries，仅用于诊断；不能把26个marker算生产图开销。宏图 declared transient44，live28（27textures+1buffer），culled16。Visibility raster约0.30 ms、所有HZB合计约0.36 ms、bins classify约0.41 ms，均明显小于着色9ms。dispatch/pass多值得分析 CPU 固定税，但本场景优先级低于最大 GPU 热点；不据数量直接合 megakernel。

## 5. 关闭/开启模块与分辨率对照

同场景、同相机、输出1080p；每组240帧、GPU n=60，唯一改变见行名。此套 CPU callback 环只能保留最后600个回调，部分 CPU/提交数据会截短，所以表中只用完整GPU样本；默认CPU采用后续修正后的主基线。

${table(["对照", "GPU P50 ms", "P95", "P99", "温度°C P50", "MHz P50", "Dungeon覆盖%", "GPU n"], diffRows)}

VSM关闭总GPU降至16.02ms，native降至6.11ms，独立shadow stages消失；FSR关闭总GPU14.65ms；75%内部14.80ms、50%内部7.92ms；开启GTAO26.58ms、Bloom23.13ms。GTAO/Bloom本来默认关闭，所以它们不是默认性能不达标的现有原因。新增它们会进一步吃掉预算。每个开关改变功能或分辨率/质量，上表用于定位而不作为同画质优化收益。

## 6. CPU、主线程与稳态分配

主基线正常帧 CPU P50 1.83–2.12 ms，P95 3.04–3.53 ms。full中 graph-execute约1.6ms，view-prepare约0.25ms，scene-prepare约0.04ms，submit约0.09ms；这些段有嵌套不能相加。同步render低并不证明整个CPU系统开销低。

normal-2 CDP主线程 TaskDuration/墙钟=32.18%，ScriptDuration=14.85%。Chrome renderer进程总CPU约41.90%一个核、GPU进程37.22%一个核；normal-3约43.61%/35.38%。这是进程CPU秒/采样秒，GPU进程的百分比是**驱动进程的CPU消耗，不是GPU利用率**；不能直接称全机41%CPU，也不应除以核心数掩盖主线程成本。该进程采样间隔约2秒，较短区间只得少数样本。

1ms sampling CPU profile 时长 ${fmt(cpuProfile.durationMs)} ms，240帧，idle=${fmt(lookup(cpuProfile, "self", "(idle)"))} ms（约70.9%），GC=${fmt(lookup(cpuProfile, "self", "garbage collector"))} ms。idle表示被采样线程空闲/等待，不表示GPU空闲。热点如下，inclusive项相互嵌套，不可加总：

${table(
  ["函数 / 工作", "Self ms", "Inclusive ms"],
  [
    [
      "GeometryPageStreamingRuntime.consumeCompleted",
      fmt(lookup(cpuProfile, "self", "consumeCompleted")),
      fmt(lookup(cpuProfile, "inclusive", "consumeCompleted"))
    ],
    [
      "deduplicateGeometryPageDemandsV1",
      fmt(lookup(cpuProfile, "self", "deduplicateGeometryPageDemandsV1")),
      fmt(lookup(cpuProfile, "inclusive", "deduplicateGeometryPageDemandsV1"))
    ],
    [
      "recordResidencyFeedback",
      fmt(lookup(cpuProfile, "self", "recordResidencyFeedback")),
      fmt(lookup(cpuProfile, "inclusive", "recordResidencyFeedback"))
    ],
    [
      "ingestDemandReadback",
      fmt(lookup(cpuProfile, "self", "ingestDemandReadback")),
      fmt(lookup(cpuProfile, "inclusive", "ingestDemandReadback"))
    ],
    [
      "示例 snapshot",
      fmt(lookup(cpuProfile, "self", "main.ts:156")),
      fmt(lookup(cpuProfile, "inclusive", "main.ts:156"))
    ],
    [
      "compileCanonicalMaterial",
      fmt(lookup(cpuProfile, "self", "compileCanonicalMaterial")),
      fmt(lookup(cpuProfile, "inclusive", "compileCanonicalMaterial"))
    ],
    [
      "GPUDescriptorCaches.encodeDescriptorValue",
      fmt(lookup(cpuProfile, "self", "encodeDescriptorValue")),
      fmt(lookup(cpuProfile, "inclusive", "encodeDescriptorValue"))
    ]
  ]
)}

反馈路径存在对象解包、字段校验、字符串Map key、去重、排序，随后同一包再处理residency touch：${source("OEngine/src/gpu/GeometryPageDemandAbiV1.ts", 233)}、${source("OEngine/src/gpu/GeometryPageStreamingRuntime.ts", 260)}、${source("OEngine/src/gpu/GeometryPageStreamingRuntime.ts", 398)}。稳态几何无上传、pending0时该工作仍持续。应研究数据导向解包/去重和驻留用量反馈频率，但不能删除eviction正确性必需的usage反馈。

示例 snapshot 会对runtime全部材质调用materialTextureLeaves，而这个helper调用compileCanonicalMaterial，再进入compileAppearanceGraph：${source("examples/demos/14-integrated/dungeon-warkarma-texture-compression/main.ts", 156)}、${source("OEngine/src/assets/PcMaterialTextures.ts", 49)}。它来自面板刷新及测试report轮询，并不是每帧重新创建GPU管线。应按实际材质/发布revision复用统计结果，减少重复图编译，先优化低风险诊断成本。

默认重复240帧窗口的API observer记录560次createBindGroup，合计同步host10.625ms，约2.33次/提交帧；没有createShaderModule/createComputePipeline/createRenderPipeline。已有descriptor/cache代码仍花CPU，但不能无证据地再加通用cache。观察器也有开销；该host时间只是API调用时长，非完整驱动工作。

## 7. 显存、RAM与容量利用

${table(["资源 / 指标", "MiB", "含义"], memoryRows)}

引擎全局统计入口 ${source("OEngine/src/gpu/GraphicsContext.ts", 327)} 未合并几何全局budget，也没有完整纳入Renderer持有的VSM、FSR历史、时域identity及大气资源。API账本与面板相差约1911.64MiB。必须保留多个维度：allocated capacity、logical/resident payload、retiring、driver resident，不能用其中一个替另一个。

本次所有纹理格式都完成字节核算；早期工具漏了rgba32uint，raw仍保留null，analysis从尺寸/format重建63.28MiB，原始数据未改写。API账本追踪显式create/destroy，nominal texture bytes未加driver alignment，自动GC、后端lazy allocation、swapchain和pipeline内存也不在其中。修正后的512MiB复测每个未destroy资源的WeakRef均alive，没有账本中已GC但未destroy的资源。因此资源规格账本与Windows专用显存差值不能自动当泄漏。

默认几何resident slots占306.00MiB（1207pages，包括381pinned），累计真实上传仅28.97MiB，未evict/reload，slot内有效载荷约9.47%。1536MiB bank容量的slot占用约19.92%，真实上传约1.89%。这是小几何Product与固定page容量/packing的放大问题，不能把306MiB误称全部有效几何数据。源码page/profile容量与metadata分配 ${source("OEngine/src/gpu/GeometryProductResidencyProfile.ts", 7)}、${source("OEngine/src/gpu/GeometryProductMultiRuntime.ts", 252)}；示例显式128MiBmetadata ${source("examples/demos/14-integrated/dungeon-warkarma-texture-compression/cooked-scene.ts", 149)}。

修正格式核算后的资源账本首次可用前观测峰值2350.04MiB，整个默认测试生命周期峰值2423.45MiB（含开关/reset事务时重叠资源）；512MiB复测相应峰值1326.04/1399.45MiB。它们不是driver VRAM峰值。主基线所有OS采样的working set峰值1988MiB、private commit峰值4249MiB；该6秒采样峰值只是观察到的下界，不保证捕获短暂上传/事务峰值。

${table(
  [
    "同近景容量对照",
    "几何总容量MiB",
    "API账本MiB",
    "Windows专用显存MiB",
    "GPU P50/P95 ms",
    "resident/pinned/eviction/reload/failed"
  ],
  [
    [
      "默认1536 banks",
      "1664",
      fmt(full.memory.independentGpuMiB),
      fmt(full.memory.os[0].dedicatedMiB),
      fmt(full.gpu.p50) + " / " + fmt(full.gpu.p95),
      "1207 / 381 / 0 / 0 / 0"
    ],
    [
      "512 banks复测",
      "640",
      fmt(m.captures[0].memory.independentGpuMiB),
      fmt(m.captures[0].memory.os[0].dedicatedMiB),
      fmt(m.captures[0].gpu.p50) + " / " + fmt(m.captures[0].gpu.p95),
      "1207 / 381 / 0 / 0 / 0"
    ]
  ]
)}

512方案节约1024MiB实测成立，而不是以删实例、降低纹理mip或变更相机换内存。该单场景容纳证明不保证全部复杂场景都可固定512MiB；后续应做可协商/内容驱动容量与packing，继续测运动、快速切视角、eviction/reload/overflow边界。

24份唯一驻留BC7内容约128.00MiB，RGBA等价512.00MiB，4倍压缩确实有效；纹理array133.33MiB包含neutral layer。没有runtime decode/encode/transcode/mip generation，因此继续优化实时codec不是本示例现有热点。

正常基线独立Chrome全部进程working set约1684–1842MiB，private commit约3786–3951MiB；JS used heap约193–219MiB，total约247–258MiB。working set相加可能重复共享物理页，private commit不是当前实际RAM驻留；ArrayBuffer/WASM/驱动进程不都在JS heap内。不能把4GiB commit解释为4GiB物理RAM，更不能把显存与CPUcommit直接相加。主基线整卡显存约3118–3139MiB，Chrome专用约2556–2566MiB，剩余包含桌面/其他进程，未见必须归因于显存溢出的证据。

## 8. 加载性能与可用性

新profile/baseline firstUseful=15.907s；无加载sampling的确认套14.050s；另一次加载profile14.874s；360帧套14.669s。fresh browser与cache disabled不等于物理磁盘冷缓存，localhost不代表真实网络、磁盘或生产CDN速度。时间从示例started标记算起；profile还包含导航和firstUseful轮询延迟。

${table(
  ["主基线阶段边界差", "时长s", "边界含义"],
  [
    ["开始→目录读取阶段", "3.305", "Renderer初始化等，包含并发管线准备；不是纯网络"],
    ["材质catalog及转入texture阶段", ".035", "JSON / scene dictionary处理"],
    ["读取并校验BCProducts", "3.047", "fetch + 多层hash，24/25源product条目读取"],
    ["打开geometry→GPU世界发布前", "2.880", "pack目录、resident属性、root pages/解包等"],
    ["GPU世界发布→full mip promotion", "4.576", "资源上传与native appearance pipeline准备，阶段存在并发"],
    ["mip promotion→首个GPU完成帧", "2.063", "首帧管线、上传、渲染与完成等待；不能全归为mip生成"],
    ["首可用→fullQuality", "0.000205", "约0.205ms，几乎同时，当前没有提前可用低mip帧的收益"]
  ]
)}

主加载sampling时长16.703s，其中SubtleCrypto.digest self2151.57ms，LZ4 decode330.05ms，GC118.50ms，writeTextureProductPlane100.65ms。GPU审计在首次可用时记录1907次hash、644487648B（614.63MiB）hash输入，总promise elapsed2225.72ms（重叠不能直接当墙钟节约）。raw保留每次bytes/at/elapsed。TextureProduct、package section、runtime chunk、geometry page分别校验，重复扫描/拷贝是可信候选成本：${source("OEngine/src/assets/RuntimeAssetPackage.ts", 431)}、${source("OEngine/src/assets/RuntimeAssetManifestV2.ts", 274)}、${source("OEngine/src/assets/TextureProduct.ts", 482)}。不能直接删掉完整性校验，应先建立各层验证覆盖，避免已验证字节重复扫描，隔离主线程同步复制，再测。

原生appearance异步pipeline从create到resolve有3.99–4.29s，某些geometry pipelines约3.37s。这是promise延迟，包含驱动队列、并发编译及等待，不是函数同步CPU耗时，更不能把所有pipeline延迟加总成加载时间。稳态无新pipeline创建。加载优先看预热/去除重复构建与初始化并行关系，不能引入材质VM换管线数量。

初次可用前ResourceTiming有462项、encodedBodySize约143.50MiB；启动涉及大量小range请求，单纯源GLB的8.03MB不是实际runtime下载量。主基线观察到31个long task、累计2417ms、最长199ms，证实加载有明显主线程长任务。异步digest CPUprofile的self与promise计时含原生处理/复制，不等同hashworker纯CPU时间。

示例纹理Product用串行for/await读取与校验 ${source("examples/demos/14-integrated/dungeon-warkarma-texture-compression/cooked-scene.ts", 98)}；可研究有界并发与tail-first，但要控制峰值内存。fullQuality只检查texture minimum mip0；cooked-scene.settled实际上是空async函数 ${source("examples/demos/14-integrated/dungeon-warkarma-texture-compression/cooked-scene.ts", 223)}，不意味着所有几何streaming完成。近景稳态捕获另确认pending0、没有最近页面变化、uploaded plateau；本报告不会把firstUseful≈fullQuality解释成完整几何已加载。

## 9. 优化顺序与验收方式

${table(
  ["优先级", "具体行动", "依据与预期作用", "优化后必须测什么"],
  [
    [
      "P0 测量",
      "合并全Renderer显存owner；修面板shader统计；保存冷/热条件",
      "避免把437MiB当完整资源，避免错误判零工作；使后续对照可信",
      "API规格账本 vs registered owners vs WDDM；相机覆盖≥80%；同温度/电源"
    ],
    [
      "P0 显存",
      "几何banks/metadata按场景与平台协商，研究小Product page packing",
      "512对照已节约1GiB；28.97MiB payload占306MiB slots，容量放大显著",
      "相同内容/画质；长轨迹、evict/reload、overflow、generation、abort/retry"
    ],
    [
      "P1 GPU",
      "拆量并优化native reconstruction、IBL、BRDF、太阳与VSM query/PCF",
      "9ms级最大热点，近景像素数驱动；具体ALU/带宽瓶颈仍待硬件分析",
      "相同分辨率与材质numeric/导数LOD/normal/HDR；P50/P95；新cost card"
    ],
    [
      "P1 GPU",
      "VSM receiver demand完整覆盖前提下聚合/去重请求",
      "静态脏页0仍付1.8ms demand；atomic热点是待证假设",
      "完整demand、fine/coarse、dirty、invalid、overflow；实际GPU成本而非仅dispatch数"
    ],
    [
      "P1 GPU",
      "FSR内部过程与输出过程分别优化，分析100% temporal工作",
      "约5ms级；scale50输出Accumulate仍1.77ms",
      "运动、jitter、history invalidation、disocclusion、pre-exposure与画质；不默认删功能"
    ],
    [
      "P1 CPU",
      "反馈typed-data解包/去重、减少两次消费；usage反馈按owner优化",
      "consumeCompleted575ms/6.28s，稳态无上传仍持续",
      "resident usage、失效和淘汰不能漏；主线程profile、GC、P95"
    ],
    [
      "P1 示例",
      "按材质/发布revision缓存面板统计结果",
      "snapshot206ms，其中图编译175ms；低风险去掉重复查询",
      "report准确；动态材质变更与release刷新；正常模式CPUprofile"
    ],
    [
      "P1 加载",
      "有界并发、tail-first、消除重复hash扫描/复制、pipeline准备前移",
      "14–16s首可用，digest2.15s采样热点，pipeline延迟4.3s",
      "冷browser/OS缓存分开、峰值RAM/VRAM、实际首帧画质与几何settled"
    ],
    [
      "P2 编排",
      "再看小pass、清零、descriptor序列化与资源寿命",
      "graph CPU1.6ms；带宽/命令税有证据但低于着色/FSR主热点",
      "单一submit；相同工作量；不会以遗漏consumer换收益"
    ]
  ]
)}

用默认GPU P50约21ms对比16.67ms，需要减少约4.3ms（约21%的GPU时间）才刚够中位60FPS，仍未覆盖P95余量。这只是预算算术，不是承诺可获得的加速。资源账本、几何容量与面板重复编译可先作为局部工程优化；之后按单个GPUarchitecture unit做Cost Card、正确性闭包、同条件复测，避免同时改多个模块后失去归因。

## 10. 有效性、已知缺项与复现

- 主基线5组、确认套14组、headed3组全部完成，页面/console/GPU验证聚合errors=[]，没有失败allowlist；另512MiB复测完成。typecheck:dungeon与build:dungeon通过（bundle size / externalization warnings保留日志）。单次诊断不替代全引擎测试/正式验收。
- 360帧套只捕获11组，运行在会话边界中断，没有completedAt；这些已落盘capture只用于重复一致性，不称整套完成。早期camera calibration中无≥80%时会主动报失败，失败保留；最终所有主静态camera guards通过。
- 早期600callback环有截断，2048profiler history有快照复制膨胀，均不用于主CPU结论；最终显式performanceCapture模式把callback上限增到8000，profiler每组clear、history512。正常演示上限仍600。无生产renderer算法变更。
- API observer、1秒report轮询、500ms面板刷新、1.5秒NVIDIA/2秒CDP/6秒Windows CIM观察器都有诊断税；CPU profile单独跑，GPU counters另跑，不把它们当无开销生产测量。coarse与full、无timing基线分开列，但热状态变化阻止精确相减诊断税。
- 未拿到shader硬件occupancy、cache/DRAM/PCIe吞吐、CPU温度/频率、真实presented FPS、swapchain驻留或长期泄漏曲线。没有替这些字段编造数值。BC7功能证据成立，完整画质numeric验收尚未做。
- release后textureOwnerZero=true且geometry budget归零；示例report的memory字段可能来自lastSnapshot，不能据stale snapshot判断仍分配/泄漏。Windows采样也太稀，不把单次release当长期泄漏证明。

原始证据目录（均为本地artifact，未提交）：

${table(
  ["目录", "用途"],
  [
    [base, "修正后的默认完整CPU窗口、GPU基线、load/steady CPU profile、源码maps"],
    [contrast, "14组开关、分辨率、运动与counters完整GPU对照"],
    [clean, "11组360帧重复；套中断，局部capture有效"],
    [small, "修正后的512MiB同场景显存验证"],
    [headed, "独立有界面Chrome、稳定1350MHz复核，3组完成"],
    [".local/validation/dungeon-performance-near-final-2026-10-10", "早期history膨胀诊断，非主baseline"],
    [
      ".local/validation/dungeon-performance-loading-2026-10-10",
      "辅助加载hash/pipeline observer复测，包含一个误命名capture，不用于对照"
    ]
  ]
)}

每组原始JSON包含精确targetStart/targetEnd、CPUcallbacks、GPU段的start/end ticks、网络ResourceTiming/CDP事件、进程CPU秒、RAM/WDDM与NVIDIA时间戳、完整资源规格、覆盖计数与VSMheader。analysis.json采用nearest-rank分位数，不剔除异常值。相机/分辨率/功能开关均保存在renderState。dashboard.html包含同数据的分布、pass与资源图；frame-samples.csv与gpu-pass-summary.csv供进一步分析。

复现（GPU作业串行，先构建，输出目录使用新名字）：

\`\`\`powershell
cd examples
npm run build:dungeon
cd ..
node validation/tools/run-dungeon-performance.mjs --near --frames 240 --scenarios normal-1,normal-2,normal-3,coarse,full --load-profile --cpu-profile --out .local/validation/dungeon-new-baseline
node validation/tools/analyze-dungeon-performance.mjs .local/validation/dungeon-new-baseline
node validation/tools/analyze-dungeon-performance.mjs .local/validation/dungeon-new-baseline load.cpuprofile
node validation/tools/run-dungeon-performance.mjs --near --geometryMiB 512 --frames 240 --scenarios full --out .local/validation/dungeon-new-memory
\`\`\`

独立headed复核已完成；后续正式对照仍应固定热状态/无竞争任务环境，并加入较长相机轨迹。本报告已经定位当前示例的真实热运行瓶颈，不把其他未测条件当已经达标。
`;
await mkdir(resolve(root, "docs/performance"), { recursive: true });
await writeFile(resolve(root, "docs/performance/2026-10-10-dungeon-warkarma-performance-report.md"), report);
await writeFile(resolve(out, "REPORT.zh-CN.md"), report);

const samples = [];
for (const [set, analysis] of [
  [base, a],
  [contrast, b],
  [small, m]
]) {
  for (const capture of analysis.captures) {
    const raw = await json(set + "/" + capture.name + ".json");
    const rows = raw.raw.callbacks.filter(
      (v) => v.submitted && v.frameIndex >= raw.targetStart && v.frameIndex < raw.targetEnd
    );
    samples.push(
      ...rows.map((v, i) => ({
        set: set.split("/").at(-1),
        scenario: capture.name,
        frame: v.frameIndex,
        cpu: v.cpuMs,
        interval: i ? v.atMs - rows[i - 1].atMs : null,
        gpu:
          raw.raw.frames.find(
            (f) =>
              f.frameIndex === v.frameIndex &&
              f.gpu.sampled &&
              !f.gpu.pending &&
              !f.counters["gpu.timing.truncated"]
          )?.gpu.cost?.commandSpanMs ?? null
      }))
    );
    const retained = new Set(rows.map((v) => v.frameIndex));
    for (const f of raw.raw.frames) {
      if (
        f.frameIndex >= raw.targetStart &&
        f.frameIndex < raw.targetEnd &&
        !retained.has(f.frameIndex) &&
        f.gpu.sampled &&
        !f.gpu.pending &&
        !f.counters["gpu.timing.truncated"]
      )
        samples.push({
          set: set.split("/").at(-1),
          scenario: capture.name,
          frame: f.frameIndex,
          cpu: null,
          interval: null,
          gpu: f.gpu.cost?.commandSpanMs ?? null
        });
    }
  }
}
samples.sort(
  (x, y) => x.set.localeCompare(y.set) || x.scenario.localeCompare(y.scenario) || x.frame - y.frame
);
await writeFile(
  resolve(out, "frame-samples.csv"),
  "set,scenario,frame,cpu_ms,submission_interval_ms,gpu_span_ms\n" +
    samples.map((s) => [s.set, s.scenario, s.frame, s.cpu, s.interval, s.gpu].join(",")).join("\n")
);
await writeFile(
  resolve(out, "gpu-pass-summary.csv"),
  "pass,n,mean_ms,p50_ms,p95_ms,p99_ms,max_ms\n" +
    Object.entries(repeat.passes)
      .map(([k, s]) => [JSON.stringify(k), s.n, s.mean, s.p50, s.p95, s.p99, s.max].join(","))
      .join("\n")
);
const data = { labels, baseline: a, contrasts: b, small: m, samples, reportPath: "REPORT.zh-CN.md" };
await writeFile(resolve(out, "dashboard-data.json"), JSON.stringify(data));
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dungeon 近景性能报告</title>
<style>body{background:#101822;color:#e3ebf5;font:15px system-ui;margin:0;padding:28px;max-width:1400px}h1{font-size:28px}h2{font-size:19px;margin-top:28px}p{color:#aebdce;line-height:1.7}a{color:#72caff}select,button{padding:8px;background:#243449;color:white;border:1px solid #55708b;border-radius:5px}svg{width:100%;background:#152130;border-radius:8px}text{fill:#c9d7e8;font:12px system-ui}.cards{display:flex;gap:14px;flex-wrap:wrap}.card{background:#203247;padding:18px;border-radius:8px;min-width:180px}.card strong{display:block;font-size:24px;margin-bottom:5px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:8px;text-align:left;border-bottom:1px solid #304458}.two{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media(max-width:900px){.two{grid-template-columns:1fr}}</style>
<h1>Dungeon Warkarma · 90.7% 模型近景</h1><p>GTX 1650 Ti 4GB · 1920×1080 · VSM / FSR 开启 · 热降频实测。提交吞吐不是显示器FPS；开关对照改变质量，频率不锁定。</p><div class="cards"><div class="card"><strong>≈21 ms</strong>默认 GPU P50</div><div class="card"><strong>1.83–2.12 ms</strong>正常 CPU 提交 P50</div><div class="card"><strong>2348 MiB</strong>默认 API 资源规格</div><div class="card"><strong>14–16 s</strong>本地首次可用</div></div>
<p><a href="REPORT.zh-CN.md">完整中文报告</a> · <a href="frame-samples.csv">逐帧CSV</a> · <a href="gpu-pass-summary.csv">GPU pass CSV</a> · <a href="dashboard-data.json">完整图表数据</a></p>
<h2>场景对照 · GPU P50 / P95</h2><p>蓝色为P50，浅色延长至P95。参考线16.67ms；每组GPU n=60。仅用于定位，不能直接当同画质加速比。</p><svg id="comparison" viewBox="0 0 1100 530"></svg>
<h2>逐帧分布</h2><select id="set"><option value="baseline">主基线（完整CPU窗口）</option><option value="contrasts">功能对照（部分callback截短）</option><option value="small">512MiB几何容量</option></select> <select id="scenario"></select> <select id="metric"><option value="interval">成功提交间隔 ms</option><option value="cpu">CPU同步提交 ms</option><option value="gpu">GPU command span ms（间隔采样）</option></select><p id="summary"></p><div class="two"><svg id="trace" viewBox="0 0 640 240"></svg><svg id="hist" viewBox="0 0 640 240"></svg></div>
<h2>默认 full-repeat · 真实 pass 耗时</h2><p>同名pass每帧聚合；native包含IBL/太阳/VSM采样，不额外把它们加到shadow stage。</p><svg id="passes" viewBox="0 0 1100 560"></svg>
<h2>显存规格分解</h2><p>合并几何4 banks；共享瞬态池不靠未命名label强行归属effect。API规格2348MiB，WDDM专用约2564MiB；引擎registered统计437MiB。</p><svg id="memory" viewBox="0 0 1100 480"></svg>
<script type="application/json" id="data">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script><script>
const d=JSON.parse(document.getElementById('data').textContent);const el=id=>document.getElementById(id);const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function bars(id,rows,max,height,unit){const left=330,w=680,step=(height-30)/rows.length;let s='';rows.forEach((r,i)=>{const y=12+i*step;const median=r[1],tail=r[2]??median;s+='<text x="8" y="'+(y+13)+'">'+esc(String(r[0]).length>45?String(r[0]).slice(0,42)+'?':r[0])+'</text><rect x="'+left+'" y="'+y+'" width="'+(tail/max*w)+'" height="15" fill="#394d67"/><rect x="'+left+'" y="'+y+'" width="'+(median/max*w)+'" height="15" fill="#58b9ed"/><text x="'+(left+tail/max*w+8)+'" y="'+(y+13)+'">'+median.toFixed(2)+(r[2]!=null?' / '+tail.toFixed(2):'')+' '+unit+'</text>';});if(unit==='ms'&&max>=16.67)s+='<line x1="'+(left+16.67/max*w)+'" x2="'+(left+16.67/max*w)+'" y1="0" y2="'+height+'" stroke="#ff9e72" stroke-dasharray="5 5"/>';el(id).innerHTML=s;}
const rep=d.contrasts.captures.find(c=>c.name==='full-repeat');bars('comparison',d.contrasts.captures.filter(c=>c.gpu&&c.name!=='counters').map(c=>[d.labels[c.name],c.gpu.p50,c.gpu.p95]),65,530,'ms');bars('passes',Object.entries(rep.passes).slice(0,17).map(([k,s])=>[k.replace('Renderer/visibility-frame/',''),s.p50,s.p95]),20,560,'ms');const groups=rep.allocationGroups;const merged=[['几何banks',1536],...Object.entries(groups).filter(([k])=>!k.includes('HighEnd bank')).slice(0,13).map(([k,v])=>[k,v.bytes/1048576])];bars('memory',merged,1664,480,'MiB');
function options(){el('scenario').innerHTML=d[el('set').value].captures.map(c=>'<option value="'+c.name+'">'+esc(d.labels[c.name]??c.name)+'</option>').join('');render();}
function render(){const set=el('set').value,n=el('scenario').value,k=el('metric').value;const dirname=d[set]===d.baseline?'dungeon-performance-baseline-2026-10-10':d[set]===d.contrasts?'dungeon-performance-confirmation-2026-10-10':'dungeon-performance-memory-confirmation-2026-10-10';const rows=d.samples.filter(r=>r.set===dirname&&r.scenario===n&&r[k]!=null);if(!rows.length){el('summary').textContent='此模式没有该指标样本。';el('trace').innerHTML=el('hist').innerHTML='';return;}const vals=rows.map(r=>r[k]),sorted=[...vals].sort((a,b)=>a-b),p=q=>sorted[Math.max(0,Math.ceil(sorted.length*q)-1)],max=Math.max(...vals,16.67),x=i=>40+i/(vals.length-1||1)*570,y=v=>210-v/max*180;el('summary').textContent='n='+vals.length+' · P50 '+p(.5).toFixed(3)+' / P95 '+p(.95).toFixed(3)+' / P99 '+p(.99).toFixed(3)+' / Max '+sorted.at(-1).toFixed(3)+' ms（坐标上界至少16.67ms）';el('trace').innerHTML='<line x1="40" x2="610" y1="'+y(16.67)+'" y2="'+y(16.67)+'" stroke="#ff9e72" stroke-dasharray="5 4"/><polyline fill="none" stroke="#58b9ed" points="'+vals.map((v,i)=>x(i)+','+y(v)).join(' ')+'"/><text x="40" y="232">采样顺序 →</text><text x="40" y="18">耗时 ms / 上界 '+max.toFixed(2)+'</text>';const bins=Array(24).fill(0);vals.forEach(v=>bins[Math.min(23,Math.floor(v/max*24))]++);const peak=Math.max(...bins);el('hist').innerHTML=bins.map((v,i)=>'<rect x="'+(40+i*23.5)+'" y="'+(210-v/peak*175)+'" width="22" height="'+(v/peak*175)+'" fill="#66cab3"/>').join('')+'<text x="40" y="232">0 ms</text><text x="540" y="232">'+max.toFixed(2)+' ms</text><text x="40" y="18">样本数 / bin</text>';}
el('set').onchange=options;el('scenario').onchange=render;el('metric').onchange=render;options();
</script></html>`;
await writeFile(resolve(out, "dashboard.html"), html);
console.log(
  JSON.stringify({
    report: "docs/performance/2026-10-10-dungeon-warkarma-performance-report.md",
    out,
    samples: samples.length
  })
);
