# Rendering Lab 综合场景与性能基准设计

日期：2026-09-06  
状态：核心实现已落地；本地 Chrome 完整长跑已完成，目标桌面硬件复测待执行

## 1. 决策摘要

`examples/rendering-lab/` 作为唯一综合浏览器 fixture，同时承担两种职责：

1. `interactive`：用户观察画面、调节参数，Performance Inspector 实时显示当前引擎状态。
2. `benchmark`：锁定输入并串行运行可复算的性能 case，生成结构化报告。

Renderer、GPU owner 和 FrameProfiler 是唯一性能事实生产者。Inspector 和 Benchmark 只消费这些证据，不从 DOM、RAF 文本或推测值重建性能数据。Inspector 继续是实时 profiler 与 Timeline 工具，不增加 Capture 导入、回放或跨会话数据库。

本设计特别增加“相机距离归因实验”。相机拉近导致的性能下降必须拆分为像素、LOD/几何、Visibility、阴影、SSR、后处理和 CPU/UI 成本，不能只报告一个总耗时。

## 2. 目标与非目标

### 目标

- 默认加载有真实输入的综合 Packed 场景。
- 固定分辨率、DPR、内部比例、seed、资产和相机输入，支持复算。
- 使用同一 Renderer/FrameProfiler 数据源生成 P50/P95/P99、GPU phase、counter、submit、I/O 和 diagnostics。
- 通过 `base`、`full`、`full-minus-*` 定量分析 Feature 成本。
- 验证 Feature 关闭后对应 Pass、history、资源、readback、counter copy 和额外 submit 消失。
- 通过相机距离和投影面积实验定位近景性能下降原因。
- 用 Playwright 控制本地 Chrome，保存截图、控制台/WebGPU diagnostics 和 JSON 报告。
- 将场景、质量配置、相机路径、Benchmark、报告和浏览器桥接拆成独立 owner。

### 非目标

- 不将 Inspector 改造成离线 Capture Viewer。
- 不声称 WebGPU 未暴露的物理 VRAM、SM occupancy、驱动排队或 Presented FPS。
- 不同时启用互斥的 Lightmap、LPV 和 IBL Provider；默认使用有真实 HDR 输入的 IBL。
- 不引入新的外部算法、资产或第二套 Renderer/主管线。
- 不把单机结果写成跨设备性能结论。

## 3. 综合场景工作负载

继续使用已登记的 `dungeon_warkarma.glb` 和 `venice_sunset_1k.hdr`。场景由固定 seed 构造，并输出 workload manifest：

- Dungeon Packed Instances 按固定 2×2 布局复制，Geometry/Material 资产保持共享。
- 添加近景遮挡物、远景密集物和多层深度的程序化 box。
- 添加粗糙、金属、低粗糙反射、自发光、alpha-blend 材质区域。
- 少量程序化实例通过确定性 transform patch 周期运动，为 velocity、temporal classification 和 motion blur 提供真实输入。
- 使用一盏投射 CSM 的 DirectionalLight 和 HDR 环境；不伪造没有 producer 的 LPV 或 Lightmap。

manifest 必须记录 seed、资产 hash、复制布局、实例/几何/材质/灯光数量、透明实例数量、运动实例数量和生成参数。任一输入变化都产生新的 workload identity。

### Full 质量配置

`full` 请求开启所有当前兼容且有真实输入的效果：

- Packed Hardware Visibility、normal-cone、HZB 和 hierarchy/SSE。
- CSM shadows。
- GTAO：半分辨率、temporal filter。
- SSR：半分辨率、temporal filter、IBL fallback。
- Packed transparency/MBOIT。
- TAA/TAAU temporal resolve。
- Bloom、automatic exposure、motion blur、color grading、sharpen、tonemap/present。

“请求开启”不能直接等价于“已产生工作”。报告同时记录：

```text
requested feature
active renderer feature
evidence-backed active pass/history/counter
```

如果 Feature 没有真实输入、Pass 被裁剪或 counter 不可用，必须显示 `no-input`、`not-applicable` 或 `unsupported`，不能声称该效果已被测量。

调试视图默认关闭；动态分辨率自动调节关闭；默认使用 1920×1080、DPR 1、内部比例 1。浏览器无法提供该 viewport 时，报告记录实际 canvas/internal resolution，不伪装成 1080p。

## 4. 运行状态与所有权

状态机：

```text
loading → interactive → benchmark-running → benchmark-settling
                              │                       │
                              ├→ failed              ├→ completed
                              └───────────────────────┘
```

`interactive` 由普通 RAF、OrbitControls 和用户参数拥有帧推进。`benchmark-running` 暂停普通 RAF，锁定控件、分辨率、Feature、动画和相机输入，由 `BenchmarkRunController` 串行推进。`benchmark-settling` 等待异步 timestamp/counter/readback 到达；超时或 dropped 必须进入报告。

页面 dispose 必须取消 RAF、Benchmark、订阅和浏览器 bridge，并释放 Inspector、Renderer 和场景资源。失败时恢复交互模式，保留已完成 case 和错误，不生成伪装完整报告。

## 5. Benchmark Suite

固定 case 顺序：

```text
base
full
full-minus-shadow
full-minus-gtao
full-minus-ssr
full-minus-transparency
full-minus-temporal
full-minus-bloom
full-minus-exposure
full-minus-motion-blur
full-minus-sharpen
```

每个 `full-minus-*` 只删除一个 Feature，其余 full 参数、workload、相机输入和配置 hash 保持一致。默认完整套件使用 120 warm-up + 480 measured frames；浏览器 smoke suite 使用 30 warm-up + 60 measured frames。

GPU timestamp 与 GPU counter 使用固定 cadence。counter-instrumented 帧按现有 `BenchmarkHarness` 规则从普通 GPU timing baseline 排除。readback ring 至少 3 slots。

每个 case 输出：

- CPU wall、GPU instrumented pass sum、phase P50/P95/P99。
- sample count、coverage、pending/dropped/unsupported/invalid。
- GPU counter、draw/dispatch、submit、upload/readback。
- FrameGraph active/pruned、resource accounting、memory evidence。
- Feature-off gate 结果。
- workload identity、camera experiment、browser/adapter/build 信息。

`gpu.passSumMs` 明确表示 timestamped pass sum，不命名为完整 GPU frame time；CPU 和 GPU 没有统一时钟映射时不得相加。

## 6. 相机距离归因实验

### 6.1 固定 FOV 距离扫描

使用固定目标点和 FOV，在以下距离分别进行静止测量：

```text
4m、6m、10m、18m、32m、56m
```

每个距离使用独立 sample epoch，建议 120 warm-up + 240 measured frames。相机不移动，只保留静止帧，避免把运动模糊和 history 重建混入距离成本。

### 6.2 投影面积归一化扫描

调整 FOV，使参考物体在屏幕上的投影高度保持不变。保持投影尺寸的关系为：

```text
distance × tan(FOV / 2) = constant
```

如果固定 FOV 下近距离变慢，而投影面积归一化后差异显著减小，主要原因是 shaded pixels、AO、SSR 和全屏后处理工作量增加。

如果归一化后仍然变慢，则继续检查 LOD、Meshlet、Visibility、阴影级联和材质复杂度。

### 6.3 固定 LOD 扫描

增加诊断用 LOD 模式：

```text
automatic
locked
```

同一距离同时运行 automatic 和 locked：

- locked 后性能恢复，说明主要是 LOD/几何量增长。
- locked 后仍然变慢，说明更可能是像素、SSR、AO、阴影或后处理成本。

该模式只用于归因实验，不能改变正式 full case 的默认 LOD 语义。

### 6.4 相机 cut 和运动段

正式相机路径包含：

1. 静止 overview：稳定画质和 temporal history。
2. 穿过遮挡密集区的平滑运动：观察 HZB、Visibility、SSR、Temporal。
3. 透明/反射近景：观察 MBOIT 和 SSR。
4. 一次显式 camera cut：cut 后重新 warm-up，不把 history 无效过渡帧混入稳定样本。

静止距离实验、运动段和 camera cut 必须分别标记，不能合并为一个平均值。

### 6.5 相机元数据

每个样本关联：

```text
camera.distanceM
camera.fovDeg
camera.segment
camera.projectedReferenceHeightPx
camera.cutId
camera.lodMode
```

这些字段通过 FrameProfiler external metrics 或 Benchmark frame metadata 记录，不能只依赖截图或 DOM 文本。

## 7. 判因规则

### 像素成本

`shadedPixels`、AO/SSR/Post 阶段随距离变化，Visibility 数量基本稳定，且投影面积归一化后差异减小。

### LOD/几何成本

`selectedClusters`、`hwClusters`、`hwTriangles`、material resolve 增加；locked LOD 后差异减小。

### Visibility/work generation

hierarchy/cluster cull、HZB、queue reservation、CAS retry 或 queue overflow 增加，而像素数量不一定同步增加。

### SSR

SSR trace pixels、平均/max trace steps、resolve/temporal 时间和 hit/miss 统计增加。

### 阴影

shadow phase、cascade 覆盖或 atlas 工作增加。

### CPU/UI/Inspector

CPU frame 或 `profiler.overheadMs` 增加，而 GPU phase 基本稳定。这类结果标记为 CPU/UI 成本，不能写成 GPU 渲染下降。

没有直接证据时，报告输出 `inconclusive`，不能根据单个总耗时猜测原因。

## 8. Inspector 实时视图

Inspector 继续使用实时 ProfileFrame 和选中区间：

- Performance：显示 CPU/RAF/GPU、稳定阶段 P50/P95/P99、coverage 和 16.667 ms 预算比例。
- Timeline：显示实时录制窗口、选中帧、camera segment 和 sample epoch。
- Work：Visibility 漏斗，以及材质、光照、阴影和透明队列容量、峰值、overflow。
- Graph：规范化 Pass label 与 GPU span 的匹配、active/pruned、读写、draw/dispatch 和 duration。
- Memory：resident、transient、history、atlas、upload、readback、profiler 的 accounted/estimated、peak、budget 和 headroom。
- Diagnostics：validation、uncaptured error、device lost、timestamp/counter failure、pending/dropped、coverage 和 Inspector overhead。

正式 Benchmark 的 case 列表、进度、相机实验选择和 JSON 下载属于 Rendering Lab 控制面板，不进入 Inspector 的离线回放职责。

## 9. 模块边界

### OEngine

- `src/debug/BenchmarkComparison.ts`：纯函数比较结果、阶段 delta、coverage 和 gate。
- `src/debug/BenchmarkHarness.ts`：单 case 证据收集和现有统计口径。
- Inspector panels：只消费 ProfileFrame 和 Renderer domain evidence。
- `src/index.ts`：只导出稳定 Benchmark comparison 类型/函数；内部 panel 类型不进入主入口。

### Rendering Lab

- `scenario.ts`：PackedSceneSource、manifest、seed 和运动 patch。
- `quality-profile.ts`：base/full/full-minus 配置事实源。
- `camera-path.ts`：确定性演示路径、camera segment、camera cut 和 hash。
- `camera-experiments.ts`：距离、投影归一化、固定 LOD 实验。
- `benchmark-suite.ts`：case 串行编排和状态机。
- `benchmark-report.ts`：schema、gate、比较和 JSON 下载。
- `controls.ts`：交互控件、Benchmark 进度和错误显示。
- `fixture.ts`：Playwright 使用的版本化浏览器 API。
- `main.ts`：初始化、装配、RAF ownership、恢复和 dispose；性能统计、场景生成和相机算法仍有少量 legacy glue，后续继续下沉到上述 owner。

不要让 `main.ts` 继续拥有场景构造、采样摘要、相机实验和报告组装。

## 10. 报告合同

`RenderingLabBenchmarkReport` schema v1 包含：

- build commit、dirty state、content hash。
- browser/userAgent、executable/version、WebGPU adapter、limits/features。
- canvas/internal resolution、DPR、HDR 状态。
- workload manifest、资产 hash、seed、实例/几何/材质/灯光数量。
- camera path id/hash、实验矩阵、距离、FOV、投影尺寸和 LOD 模式。
- 每个 case 的完整 `BenchmarkResult`。
- 同帧 FrameGraph、resource accounting 和 memory snapshots。
- phase/metric comparison、Feature-off gate、预算检查。
- diagnostics、coverage、unsupported/pending/dropped 原因。
- suite started/completed 时间和总耗时。

只有所有 case 完成且异步样本 settle 后才允许 `status: complete`。失败报告可以下载，但必须标记 `incomplete`，列出已完成 case、camera segment 和错误。

## 11. 验证与验收

实现阶段至少运行：

```text
OEngine: npm run typecheck
OEngine: npm run build:test
命中的单元测试和 npm test
examples: yarn build
examples: yarn build:storybook
Playwright + 本地 Chrome smoke suite
```

浏览器验证记录：

- 默认 full Feature 实际配置和 evidence-backed active pass。
- 固定分辨率/DPR/内部比例/seed/workload identity。
- 每个相机距离的 timing、phase、counter、FrameGraph、memory 和 diagnostics。
- 固定 FOV 与投影归一化的差异。
- automatic 与 locked LOD 的差异。
- full 与 full-minus 的 gate。
- console/page error、WebGPU validation、uncaptured error、device loss。

验收条件：

- 默认场景所有声明为 full 的 Feature 都有真实输入或明确的 `no-input/unsupported` 状态。
- 相机距离实验能够区分像素、LOD/几何、Visibility、SSR、阴影、Post 和 CPU/UI 成本；无法区分时输出 `inconclusive`。
- full case 在稳定条件下每帧一个 main submit；异步 readback 不回控可见工作。
- GPU queue 不发生静默 overflow。
- Inspector 与 Benchmark 使用同一 ProfileFrame/Renderer evidence 口径。
- 完整 suite 生成可重新解析的 schema v1 JSON，并包含全部 case 与相机实验元数据。
- 没有目标设备证据时，不宣称 1920×1080、DPR 1、60 FPS 已达成。
