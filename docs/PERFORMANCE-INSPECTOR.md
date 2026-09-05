# OEngine Performance Inspector 设计与实施计划

> **实施执行者：** 按本文任务顺序执行；每个任务都必须形成可独立验证的交付，不得把未完成的采集器、占位指标或伪造 fallback 接入公开界面。

**目标：** 为 OEngine 提供一个类似 three.js Inspector 使用体验、但专注于性能与运行证据的可插拔 Inspector，能够实时监视、录制、暂停、选帧、深度捕获，并导出 OEngine Capture JSON 与 Perfetto/Chrome Trace JSON。

**架构：** 保留 `FrameProfiler` 作为 Renderer 的采集门面，在其下建立有类型的指标注册表、帧装配器、历史窗口、资源记账和捕获会话。Inspector UI 作为独立 addon 只消费稳定快照，不直接读取 Renderer、Pass、GPU Buffer 或 Shader 私有状态。

**技术栈：** TypeScript、WebGPU timestamp query、GPU counter readback ring、DOM、Shadow DOM、Canvas 2D、JSON；第一版不引入 UI 框架和图表运行时依赖。

**规格：** 本文同时是设计规格和实施计划。

## 1. 范围

### 1.1 必须完成

- 通过 `oengine/addons/inspector` 独立入口提供 `Inspector`。
- 提供 `Live`、`Record`、`Deep Capture` 三种采集模式。
- 支持打开、关闭、暂停、恢复、清空、选帧、选择帧范围和固定轨道。
- 支持 CPU、GPU timestamp、GPU counters、GPU-driven、FrameGraph、资源、上传、readback、提交、Pipeline、错误与 Inspector 自身开销。
- 所有异步 GPU 结果按产生它的 `frameIndex` 回填。
- 导出可重新导入的 OEngine Capture JSON。
- 导出 Perfetto/Chrome Trace JSON；CPU 与 GPU 使用独立时钟域，未取得时钟映射时不得伪造 CPU/GPU 对齐。
- 指标必须声明单位、来源、作用域、采样方式、可用状态和观测开销。
- Inspector 未挂载且 profiler 关闭时，不得创建 GPU query、counter buffer、readback、DOM、定时器或额外 submit。

### 1.2 第一版不做

- 不做场景树、对象属性、材质编辑器或渲染功能调参面板。
- 不把 Inspector 变成 RenderDoc、PIX、Nsight 或浏览器 DevTools 的替代品。
- 不声称提供 WebGPU 无法可靠暴露的物理 VRAM、GPU 总利用率、硬件 cache miss、真实带宽或最终显示延迟。
- 不默认执行 overdraw 重绘、全量 Buffer 回读或逐像素调试。
- 不复制上游 UI 或 profiler 的表达性代码；当前采用状态为 `specification/reference reimplementation`。

## 2. 当前实现基础与缺口

当前代码已经具备主要采集通道：

- `OEngine/src/debug/FrameProfiler.ts`：CPU section、submit、upload、readback、FrameGraph、GPU timestamp、GPU counter、诊断和 2048 帧有界历史。
- `OEngine/src/debug/GpuFramePhase.ts`：统一 GPU phase 分类。
- `OEngine/src/debug/GpuFrameCounters.ts`：GPU counter ABI、schema version、readback buffer。
- `OEngine/src/debug/GpuReadbackRing.ts`：异步 readback ring 与 dropped/failed 状态。
- `OEngine/src/framegraph/ShadeGPUCommandContext.ts`：实际编码的 render/compute/draw/dispatch 与 timing 接缝。
- `OEngine/src/gpu/GpuQueueEvidence.ts`：submit、upload、readback 接缝。
- `examples/rendering-lab/evidence.ts`：warm-up、epoch、异步替换、P50/P95/P99，以及 counter 插桩帧与生产 timing 帧分离。

主要缺口：

- `cpuMs` 和 CPU `counters` 仍是自由字符串，没有统一语义、单位或聚合规则。
- snapshot 主要是扁平统计，没有 CPU/GPU span 层次、状态化 sample 和范围选择模型。
- GPU timing 只保存 duration，不能可靠表达 GPU 内部时间线起点、时钟域和跨 batch 关系。
- Rendering Lab 中的证据窗口和 UI 逻辑不能作为可复用 addon。
- 资源统计分散在各 owner，缺少统一创建、释放、当前值和峰值账本。
- Pipeline/Shader 创建耗时、缓存命中和首次使用卡顿没有统一指标。
- 没有稳定 Capture schema、导入器、迁移器和 trace exporter。
- 没有可复用 Inspector UI、选帧详情和观测开销面板。

结论：第一版不是推翻现有 profiler，而是把已有约 70% 的采集能力收敛为稳定的数据系统，再在其上添加 Inspector。

## 3. 开源参考基线

以下 revision 固定于 2026-09-04。它们用于机制对照，不代表运行时依赖或代码移植；若实施中需要局部移植，必须先在 `docs/porting/` 登记许可证、源码路径、保留不变量和 OEngine/WebGPU 差异。

| 项目 | 固定 revision | 参考机制 | OEngine 采用边界 |
| --- | --- | --- | --- |
| three.js Inspector | [`c4ffe022`](https://github.com/mrdoob/three.js/tree/c4ffe022f2a4f982b42b7da5af79a87066a138ae/examples/jsm/inspector) | addon 入口、自动挂载、Performance/Memory/Timeline 分区、有限帧历史、异步 GPU 结果 | 只参考交互与组件边界，不复制 UI 源码 |
| Babylon.js | [`bccbecf0`](https://github.com/BabylonJS/Babylon.js/tree/bccbecf0efc67a947de3313bad778136f10aa03e) | 可注册采集策略、实时与低干扰录制分离、昂贵 instrumentation 显式启用 | 采用 collector 注册思想，不依赖 Babylon |
| Godot | [`34d06658`](https://github.com/godotengine/godot/tree/34d06658a85845111a50db9e485ec4a0701d4298) | Monitors、Visual Profiler、分阶段 CPU/GPU、远程目标与自定义 monitor | 采用覆盖范围和目标设备证据理念；不沿用聚合指标的模糊命名 |
| Bevy | [`379a758d`](https://github.com/bevyengine/bevy/blob/379a758d9bbbd371cae50f6055f394f2899e489b/crates/bevy_render/src/diagnostic/mod.rs) | 可选 diagnostics plugin、time/pass span、pipeline statistics、GPU Buffer 数值回读、Tracy 输出 | 采用关闭时 no-op、Pass 自声明和输出端解耦 |
| bgfx | [`fcdc7116`](https://github.com/bkaradzic/bgfx/blob/fcdc7116a6d276bad8ad05a3cbb2d13a04c7f57b/include/bgfx/bgfx.h) | timer frequency、`gpuFrameNum`、waitRender/waitSubmit、per-view stats、资源与内存统计 | 采用来源帧、等待时间和 per-view 语义；WebGPU 不可用项保持 unsupported |
| Falcor | [`eb540f67`](https://github.com/NVIDIAGameWorks/Falcor/blob/eb540f6748774680ce0039aaf3ac9279266ec521/Source/Falcor/Utils/Timing/Profiler.h) | 嵌套 CPU/GPU event、作用域 API、GPU 查询双缓冲、历史统计 | 采用 span tree 和无阻塞异步查询 |
| Wicked Engine | [`70ec32cc`](https://github.com/turanszkij/WickedEngine/blob/70ec32cc62f3dadbf796fd5574ff3e34c3c47301/WickedEngine/wiProfiler.cpp) | scoped CPU/GPU range、轮转 query/readback、内嵌曲线与内存显示 | 采用作用域便利性；异常 timestamp 必须是 invalid，不能归零 |
| Filament | [`97b6c662`](https://github.com/google/filament/blob/97b6c6621872fb82031c44d72cdb10bdf2139531/filament/include/filament/Renderer.h) | frameId、GPU duration、backend frame、VSync、Present、Deadline、`PENDING/INVALID` | 采用帧状态语义；浏览器不暴露的数据保持 unsupported |
| The Forge | [`cd504689`](https://github.com/ConfettiFX/The-Forge/tree/cd5046893faba2dc7869243873bf01f02a6f0df9) | 嵌入式 MicroProfiler、CPU/GPU 时间线、HTML capture、目标设备 UI | 采用时间线和离线捕获工作流 |
| MicroProfile | [`a469709c`](https://github.com/jonasmr/microprofile/tree/a469709c55b973099c1600b78a503912150e2c69) | 多线程 scope、帧历史、缩放和范围统计 | 采用交互模型，不直接依赖 native profiler |
| Perfetto | [`269b4e55`](https://github.com/google/perfetto/tree/269b4e55f8486d9ad461dedd1cfbe07c8de42b0e) | slice、counter、track、clock domain、trace 导入分析 | 采用 trace 概念和兼容导出，不嵌入 Perfetto UI |

WebGPU 能力和精度以 [GPUWeb 规范](https://www.w3.org/TR/webgpu/) 为权威：`timestamp-query` 是可选特性，结果精度可能被实现量化。Inspector 必须呈现 capability 和状态，不得用 CPU 时间填充 GPU 空缺。

## 4. 总体架构

```text
Renderer / FrameGraph / GPU owners / Queue
  │
  ├─ CPU spans and counters
  ├─ GPU timestamp batches
  ├─ GPU counter ABI
  ├─ resource and pipeline accounting
  └─ diagnostics
          │
          ▼
FrameProfiler facade
  ├─ MetricRegistry
  ├─ FrameAssembler
  ├─ ProfileHistory
  └─ ProfilerOverheadTracker
          │ immutable snapshots / frame patches
          ▼
CaptureSession
  ├─ OEngine Capture codec
  └─ Perfetto/Chrome Trace exporter
          │
          ▼
Inspector addon
  ├─ Overview
  ├─ Timeline
  ├─ GPU-driven
  ├─ FrameGraph
  ├─ Resources
  └─ Diagnostics
```

### 4.1 所有权

- `Renderer`：只负责在正确的帧边界调用 profiler，不拥有 UI。
- `FrameProfiler`：采集生命周期和 GPU 资源生命周期 owner。
- `MetricRegistry`：指标语义的唯一 owner。
- `FrameAssembler`：异步结果和原始帧的对应关系 owner。
- 各 GPU/资源 owner：只上报自身真实事实，不扫描其他 owner。
- `CaptureSession`：录制窗口、环境清单、导出和导入 owner。
- `Inspector`：DOM、交互和展示 owner；销毁时完整解除订阅和 DOM。

### 4.2 公开入口

```ts
import { Renderer } from "oengine";
import { Inspector } from "oengine/addons/inspector";

const renderer = new Renderer();
const inspector = new Inspector(renderer, {
  container: document.body,
  initialMode: "live",
  historyCapacity: 2048
});

inspector.open();
```

第一版公开接口：

```ts
type InspectorMode = "live" | "record" | "deep-capture";

interface InspectorOptions {
  container?: HTMLElement;
  initialMode?: InspectorMode;
  historyCapacity?: number;
  uiRefreshHz?: number;
  nonce?: string;
  styles?: "inline" | "external" | "none";
}

interface RecordingStopOptions {
  awaitPending?: boolean;
  timeoutMs?: number;
}

class Inspector {
  constructor(renderer: Renderer, options?: InspectorOptions);
  open(): void;
  close(): void;
  pause(): void;
  resume(): void;
  startRecording(): void;
  stopRecording(options?: RecordingStopOptions): Promise<PerformanceCapture>;
  captureNextFrame(): Promise<PerformanceCapture>;
  selectFrame(frameIndex: number): void;
  exportCapture(capture?: PerformanceCapture): Blob;
  exportTrace(capture?: PerformanceCapture): Blob;
  dispose(): void;
}
```

`stopRecording()` 默认等待当前捕获窗口中的 pending GPU 样本完成；达到有界超时后保留其 `pending`/`dropped` 状态并完成 Capture，不调用 `device.queue.onSubmittedWorkDone()` 阻塞正常帧循环。

`Inspector` 只从 addon 入口导出，不加入根入口；核心 profiler 类型仍由 `OEngine/src/index.ts` 导出。`renderer.inspector = ...` 不作为要求，避免 Renderer 持有可变 UI 属性。

## 5. 数据契约

### 5.1 指标描述

```ts
type MetricUnit = "ms" | "bytes" | "count" | "ratio" | "pixels" | "triangles";
type MetricSource =
  | "cpu-clock"
  | "gpu-timestamp"
  | "gpu-counter"
  | "engine-accounting"
  | "browser-observer";
type MetricMeasurement = "measured" | "counted" | "derived" | "estimated";
type MetricCost = "none" | "low" | "instrumented";
type MetricScope = "frame" | "pass" | "resource-lifetime" | "capture";
type MetricAggregation = "last" | "sum" | "max" | "min" | "mean" | "percentile";

interface MetricDescriptor {
  id: string;
  label: string;
  group: string;
  unit: MetricUnit;
  source: MetricSource;
  measurement: MetricMeasurement;
  cost: MetricCost;
  scope: MetricScope;
  aggregation: MetricAggregation;
  description: string;
}
```

指标 ID 使用稳定点分命名，例如：

- `frame.rafIntervalMs`
- `cpu.frameMs`
- `gpu.passSumMs`
- `gpu.visibility.hzbRejects`
- `gpu.queue.workOverflow`
- `memory.resident.accountedBytes`
- `framegraph.cache.hitCount`
- `pipeline.create.hostCallMs`
- `profiler.readbackBytes`

UI 标签可以变化，指标 ID 和语义不能静默变化；语义变化必须提升 Capture schema 或 metric revision。

### 5.2 样本状态

```ts
type MetricAvailability =
  | "available"
  | "pending"
  | "unsupported"
  | "invalid"
  | "dropped";

interface MetricSample {
  metricId: string;
  value: number | null;
  availability: MetricAvailability;
  sourceFrameIndex: number;
  resolvedAtFrameIndex: number | null;
  instrumented: boolean;
}
```

约束：

- 非 `available` 样本的 `value` 必须为 `null`。
- `pending` 只允许转换为 `available`、`invalid` 或 `dropped`。
- `resolvedAtFrameIndex` 只描述结果何时回到 CPU，不改变 `sourceFrameIndex`。
- 被历史容量淘汰的帧到达延迟结果时直接丢弃并增加诊断计数，不重新创建残缺帧。

### 5.3 Span

```ts
type ProfileClockDomain = "cpu-main" | "gpu-device";

interface ProfileSpan {
  id: number;
  parentId: number | null;
  frameIndex: number;
  name: string;
  category: string;
  clockDomain: ProfileClockDomain;
  start: number | null;
  duration: number | null;
  availability: MetricAvailability;
  instrumented: boolean;
}
```

GPU timestamp 应尽可能保存原始 begin/end 和 timestamp period；若 backend 只能返回 duration，则 `start=null`，UI 只能显示 duration 列表，不能构造虚假重叠关系。

### 5.4 帧记录

```ts
interface ProfileFrame {
  schemaVersion: number;
  frameIndex: number;
  epoch: number;
  warmup: boolean;
  visibilityState: DocumentVisibilityState;
  samples: Readonly<Record<string, MetricSample>>;
  spans: readonly ProfileSpan[];
  gpuCounterSchemaVersion: number;
  timestampInstrumented: boolean;
  counterInstrumented: boolean;
  complete: boolean;
}
```

帧通过 immutable replacement 更新：首次 `endFrame()` 发布 CPU snapshot；GPU timestamp 和 counter 到达后发布同一个 `frameIndex` 的新版本。Listener 不得收到被原地修改的旧对象。

## 6. 采集模式

| 模式 | 默认采集 | GPU readback | 用途 |
| --- | --- | --- | --- |
| `Live` | RAF、CPU frame、命令/提交/上传/资源计数；UI 5 Hz 刷新 | timestamp 降频；counter 默认关闭 | 长期开着观察趋势 |
| `Record` | 有界连续帧；CPU 与顶层 GPU phase；完整环境和采样 manifest | timestamp 默认每帧；counter 独立低频 | 找 spike、选帧、范围统计和导出 |
| `Deep Capture` | 武装下一帧；完整 pass timestamp、GPU counters、队列容量/溢出和 profiler 开销 | 单帧完整 readback ring | 深挖一个异常帧 |

规则：

- counter 插桩帧标记 `counterInstrumented=true`，不进入正常 GPU timing baseline。
- Record 开始时建立新 epoch，执行显式 warm-up；环境、分辨率、DPR、feature set 或 camera sample key 改变时开启新 epoch。
- 浏览器切到后台、canvas 尺寸变化、device lost 或 timestamp capability 改变时记录事件并切断可比区间。
- UI repaint cadence 与采集 cadence 分离；暂停 UI 不暂停异步结果回填，暂停录制才冻结捕获窗口。

## 7. 指标目录

### 7.1 帧与 CPU

- RAF interval、FPS、frame budget、超预算帧、连续 spike、P50/P95/P99。
- Renderer CPU frame、graphics update、world/view update、FrameGraph build/compile/execute、queue submit host call。
- upload/readback 准备和回调耗时。
- `PerformanceObserver` long task；不可用时显示 unsupported。
- document visibility、resolution、DPR、内部渲染比例和 feature set。

### 7.2 GPU 时间

- timestamp capability、采样间隔、query 数、readback 延迟和失败数。
- `GpuFramePhase` 各 phase duration。
- 每个 render/compute pass duration、类型、父 phase 和 command context。
- GPU pass sum 明确命名为 `GPU Pass Sum`，不命名为 `GPU Frame Time`。
- 没有跨时钟映射时不展示 CPU/GPU overlap。

### 7.3 GPU-driven 与几何

- candidates、visible instances、visited hierarchy/BVH nodes、selected clusters。
- frustum、cone、HZB rejection 及 rejection ratio。
- SW/HW/alpha clusters 与 triangles。
- work reservation、CAS、dispatch update、queue occupancy、capacity、peak 和 overflow。
- invalid visibility key、material key、gradient fallback 和 numeric failure。

任何新增 GPU 队列都必须同步注册 ABI、容量、生产者、消费者、overflow 和指标描述。

### 7.4 Surface、光照、阴影和时域

- shaded/empty pixels、active materials、material kernel pixels、feature pixels。
- clustered lighting attempts/writes/overflow/fallback 和 lights-per-cluster histogram。
- IBL mip 分布。
- CSM 各 cascade work、atlas pixels、draws 和 overflow。
- transparency work、triangles、reactive pixels、overflow 和 numeric failure。
- temporal reactive/disocclusion/history accept/reject。
- AO evaluated/history accepted/rejected。
- SSR trace/hit/steps 和 reject reason。

### 7.5 FrameGraph、命令和 I/O

- build/compile/execute、cache hit/miss/eviction。
- render pass、compute pass、draw、dispatch、bundle execution、submit。
- upload writes/bytes、copy bytes、readback count/bytes、readback latency。
- active/pruned pass、临时资源逻辑峰值、持久 history 和 feature-off 资源。

### 7.6 资源和 Pipeline

- Buffer、Texture、Sampler、BindGroup、BindGroupLayout、PipelineLayout、RenderPipeline、ComputePipeline 数量。
- 当前 accounted bytes、分类 bytes、峰值、每帧创建/释放和 owner。
- resident、transient、history、shadow atlas、upload 和 readback 分账。
- pipeline 创建次数、host call duration、cache hit/miss、首次使用帧和错误。

`createRenderPipeline()` 返回耗时只能命名为 host call duration；浏览器或驱动可能延迟编译，不能将其宣传为完整 shader compile time。

### 7.7 正确性与观测开销

- validation、uncaptured error、device lost。
- timestamp batch failure、counter dropped/failed、历史帧淘汰后到达的 orphan result。
- Inspector CPU collection、frame assembly、serialization 和 UI repaint 耗时。
- profiler query 数、counter clear/copy、readback bytes 和 observability GPU phase。

## 8. UI 设计

顶部工具栏始终显示：模式、Live/Pause、Record、Capture Next Frame、Clear、Import、Export Capture、Export Trace、采样状态和观测开销徽标。

### 8.1 Overview

- 当前 FPS、RAF P95、CPU P50/P95、GPU Pass Sum P50/P95。
- 16.667 ms / 8.333 ms 等可配置预算线。
- CPU、GPU、upload/readback 和 memory 小型趋势图。
- 自动列出当前最高成本 phase、最大变化指标、overflow 和错误。

### 8.2 Timeline

- 顶部帧条展示正常帧、超预算帧、counter 插桩帧、pending、invalid 和 dropped。
- 选中帧后显示 CPU Main 与 GPU Device 两个独立轨道。
- GPU 未取得可靠起点时显示层次 duration table，不画虚假绝对位置。
- 支持缩放、平移、框选范围、固定轨道和按名称过滤。
- 范围详情显示 count、min、max、mean、P50、P95、P99 和 sample coverage。

### 8.3 GPU-driven

- 用 funnel 展示 candidate → hierarchy → cluster → raster → shaded pixel。
- 每个 rejection、fallback、overflow 都显示数量和相对比例。
- 队列显示 current/capacity/peak/overflow，不只显示最终元素数。

### 8.4 FrameGraph

- 展示执行顺序、pruned pass、phase、类型、GPU duration 和资源读写数量。
- 展示 cache、build/compile/execute 以及 feature-off 是否真正没有 Pass 和资源。
- 第一版不绘制完整资源依赖大图；先提供可搜索表和选中 Pass 详情。

### 8.5 Resources

- 按 owner 和资源类型查看 count/current/peak/accounted bytes。
- 区分 resident、transient、history、atlas、upload 和 readback。
- 所有内存值标注 `accounted` 或 `estimated`，绝不显示为物理 VRAM。

### 8.6 Diagnostics

- capability 表、采样 cadence、pending age、dropped、errors 和 device loss。
- 显示哪些指标 unsupported 以及原因。
- 显示 Inspector 自身 overhead，避免监视器掩盖被测对象。

UI 使用 Shadow DOM 隔离宿主样式；严格 CSP 环境使用导出的外部 CSS，inline 模式支持 `nonce`。图表使用 Canvas 2D，文本、表格和交互使用 DOM，避免每帧创建大量节点。

## 9. Capture 与 Trace

### 9.1 OEngine Capture JSON

```ts
interface PerformanceCapture {
  format: "oengine-performance-capture";
  schemaVersion: 1;
  createdAt: string;
  engine: BenchmarkEngineIdentity;
  environment: BenchmarkEnvironmentManifest;
  sampling: {
    mode: InspectorMode;
    warmupFrames: number;
    timestampInterval: number;
    counterInterval: number;
    historyCapacity: number;
  };
  metricCatalog: readonly MetricDescriptor[];
  frames: readonly ProfileFrame[];
  diagnostics: FrameProfilerDiagnostics;
}
```

导入要求：

- 严格校验 `format`、schema、metric ID、有限数值和帧号单调性。
- 未知的未来字段忽略；未知的未来 schema 拒绝并给出版本错误。
- 导入仅创建离线数据源，不接触 Renderer 和 GPUDevice。
- JSON 中的错误文本按纯文本展示，不写入 `innerHTML`。

### 9.2 Perfetto/Chrome Trace JSON

- CPU span 输出 duration event，使用 `cpu-main` track。
- GPU span 输出 `gpu-device` track；保留原始 GPU timestamp 时只在 GPU 时钟域内部对齐。
- 没有 CPU/GPU clock snapshot 时，在 trace metadata 明确写入 `cpuGpuClockAligned=false`。
- GPU 只有 duration 而无 begin/end 时作为 per-frame duration counter 输出，不伪造 slice 起点。
- MetricSample 输出 counter event；frameIndex、instrumented、availability 放入 args。
- trace 导出器使用流式/分块字符串构建，避免一次性复制多个完整捕获对象。

## 10. 准确性合同

| 指标 | 可以声明 | 必须同时说明 | 禁止声明 |
| --- | --- | --- | --- |
| RAF/FPS | 浏览器回调间隔 | visibility、VSync/节流影响、窗口状态 | 显示器真实 present FPS |
| CPU frame | OEngine render 调用 wall time | 包含边界和 clock 来源 | 完整应用 CPU frame，除非应用显式接入 |
| GPU timestamp | 被 timestamp 包围的工作 duration | feature、采样帧、量化、pending | 物理 GPU 总利用率 |
| GPU Pass Sum | 已采样 Pass duration 的和 | coverage、未覆盖 copy/gap/present | 完整 GPU frame wall time |
| GPU counter | 插桩范围内的计数 | schema、采样 cadence、instrumented | 未采样帧的真实值 |
| GPU memory | OEngine owner 记账字节 | accounted/estimated、资源类别 | 浏览器进程或物理 VRAM 占用 |
| Pipeline 创建 | API host call duration | 驱动可能 lazy compile | 完整 shader compilation time |
| Present latency | unsupported | 浏览器 API 限制 | 推算出的“真实输入延迟” |

验证规则：

- 用确定性 fake clock 验证 CPU span 和 percentile。
- 用乱序完成的 GPU promise 验证 frame identity 和 immutable replacement。
- 用 query/readback ring 满载验证 dropped，而不是等待 GPU。
- 用已知 descriptor 集合验证资源字节计算和释放回零。
- 用 schema golden file 验证 Capture 稳定性与导入拒绝路径。
- 用 trace golden file 验证时钟域和 `cpuGpuClockAligned=false`。
- 对同一固定场景运行 profiler off、Live、Record、Deep Capture A/B，分别报告 CPU P50/P95、GPU Pass Sum、readback bytes 和 submit 数；不得隐藏观测成本。

## 11. 文件结构

```text
OEngine/src/debug/profiling/
  Metric.ts                 指标描述、sample 和稳定 ID
  MetricRegistry.ts         唯一指标目录与冲突检查
  ProfileSpan.ts            CPU/GPU span 数据契约
  ProfileFrame.ts           immutable frame 与 patch
  ProfileHistory.ts         有界历史、选帧和异步替换
  ProfileStatistics.ts      min/max/mean/P50/P95/P99 与 coverage
  ResourceAccounting.ts     WebGPU descriptor 记账
  PerformanceCapture.ts     Capture schema、校验、导入导出
  ChromeTraceExporter.ts    Perfetto/Chrome Trace JSON

OEngine/src/addons/inspector/
  index.ts                  addon 公开入口
  Inspector.ts              生命周期、模式和数据源协调
  InspectorViewModel.ts     选帧、范围、过滤和派生展示数据
  InspectorShell.ts         Shadow DOM、toolbar、tab 和布局
  charts/FrameChart.ts      帧条与预算线
  charts/SeriesChart.ts     有界数值序列
  panels/OverviewPanel.ts
  panels/TimelinePanel.ts
  panels/GpuDrivenPanel.ts
  panels/FrameGraphPanel.ts
  panels/ResourcesPanel.ts
  panels/DiagnosticsPanel.ts
  inspector.css             可外部加载的 CSP-safe 样式
```

现有 `FrameProfiler.ts`、`GpuFrameCounters.ts` 和 `GpuFramePhase.ts` 保持稳定入口，逐步改为消费这些小模块；不得把新的注册表、序列化或 UI 继续堆进 `Renderer.ts`。

## 12. 实施计划

### Task 1：建立指标注册表和统计内核

**文件：**

- 新建 `OEngine/src/debug/profiling/Metric.ts`
- 新建 `OEngine/src/debug/profiling/MetricRegistry.ts`
- 新建 `OEngine/src/debug/profiling/ProfileStatistics.ts`
- 新建 `OEngine/tests/performance-metric-registry.test.mjs`

**产出接口：** `MetricDescriptor`、`MetricSample`、`MetricRegistry.register()`、`MetricRegistry.get()`、`summarizeProfileSeries()`。

- [x] 写失败用例：重复 ID 但语义不同必须抛错；空序列返回 `null`；非有限值被拒绝；P50/P95/P99 使用固定 nearest-rank 规则。
- [x] 运行 `npm run build:test` 和单个 Node 测试，确认失败原因只来自缺失模块。
- [x] 实现冻结 descriptor、稳定排序和统计函数，不引入 UI 依赖。
- [x] 注册第一批 frame、CPU、GPU、I/O、FrameGraph 和 profiler overhead 指标。
- [x] 运行单测与 typecheck，提交 `feat(profiler): add typed metric registry`。

### Task 2：建立 immutable 帧、Span 和历史窗口

**文件：**

- 新建 `OEngine/src/debug/profiling/ProfileSpan.ts`
- 新建 `OEngine/src/debug/profiling/ProfileFrame.ts`
- 新建 `OEngine/src/debug/profiling/ProfileHistory.ts`
- 新建 `OEngine/tests/profile-history.test.mjs`

**产出接口：** `ProfileFrame`、`ProfileFramePatch`、`ProfileHistory.add()`、`ProfileHistory.patch()`、`ProfileHistory.subscribe()`、`ProfileHistory.selectRange()`。

- [x] 写失败用例：GPU 结果乱序返回仍更新原始帧；旧 snapshot 不被原地修改；淘汰帧 patch 返回 `orphaned`；状态转换不合法时抛错。
- [x] 实现以 `frameIndex` 为键的有界 Map 和单调 revision。
- [x] 实现 CPU/GPU 独立 clock domain 的 span，并允许 GPU `start=null`。
- [x] 实现范围统计时对 pending/invalid/dropped 的 coverage 计算。
- [x] 运行相关单测与 typecheck，提交 `feat(profiler): add asynchronous frame history`。

### Task 3：将 FrameProfiler 迁移到新数据契约

**文件：**

- 修改 `OEngine/src/debug/FrameProfiler.ts`
- 修改 `OEngine/src/debug/GpuFramePhase.ts`
- 修改 `OEngine/src/framegraph/ShadeGPUCommandContext.ts`
- 修改 `OEngine/src/gpu/GpuQueueEvidence.ts`
- 修改 `OEngine/tests/r0-observability.test.mjs`
- 新建 `OEngine/tests/frame-profiler-sampling.test.mjs`

**产出接口：** 保留 `Renderer.profiler` 和 `FrameProfiler`；新增 `setMode()`、typed `recordMetric()`、span API 和 `historyStore` 只读访问。

- [x] 先为现有 snapshot、GPU batch 合并、counter ring、disabled no-op 写回归用例。
- [x] 把自由字符串调用迁移到已注册 metric ID；未知 ID 在开发构建抛错。
- [x] 将 GPU timing 保存为原始可用字段；backend 缺少 begin/end 时保留 duration-only 状态。
- [x] 实现 Live/Record/Deep Capture cadence 和 epoch/warm-up 切换。
- [x] 保持 counter 插桩帧不进入生产 timing baseline。
- [x] 运行 observability、readback ring、GPU phase、counter ABI 测试和 build，提交 `refactor(profiler): adopt typed frame records`。

### Task 4：补齐资源、Pipeline 和 FrameGraph 指标

**文件：**

- 新建 `OEngine/src/debug/profiling/ResourceAccounting.ts`
- 修改 `OEngine/src/gpu/GraphicsContext.ts`
- 修改 `OEngine/src/gpu/GPUDescriptorCaches.ts`
- 修改 `OEngine/src/gpu/GpuAssetStore.ts`
- 修改 `OEngine/src/gpu/GpuScene.ts`
- 修改 `OEngine/src/gpu/GpuPackedSceneRegistry.ts`
- 修改 `OEngine/src/framegraph/FrameGraph.ts`
- 新建 `OEngine/tests/resource-accounting.test.mjs`
- 新建 `OEngine/tests/pipeline-profile-evidence.test.mjs`

**产出接口：** `ResourceAccounting.created()`、`destroyed()`、`snapshot()`；Pipeline host-call/cache 指标；FrameGraph active/pruned/resource lifetime 指标。

- [x] 写 Buffer、Texture mip/sample/layer 字节估算 golden cases，并覆盖压缩格式和未知格式拒绝。
- [x] 在真实 owner 创建和销毁边界记账；禁止 Inspector 扫描对象重建账本。
- [x] 分开 resident、transient、history、atlas、upload 和 readback owner。
- [x] 为 Pipeline host call、cache hit/miss 和 first-use frame 插桩，明确 lazy compile 限制。
- [x] 为 FrameGraph 记录 active/pruned pass 和逻辑临时资源峰值，不增加独立 submit。
- [x] 运行资源、FrameGraph、feature-off 和 build 验证，提交 `feat(profiler): account resources and pipelines`。

### Task 5：实现 Capture schema、导入和 Trace 导出

**文件：**

- 新建 `OEngine/src/debug/profiling/PerformanceCapture.ts`
- 新建 `OEngine/src/debug/profiling/ChromeTraceExporter.ts`
- 新建 `OEngine/tests/performance-capture.test.mjs`
- 新建 `OEngine/tests/chrome-trace-exporter.test.mjs`

**产出接口：** `createPerformanceCapture()`、`parsePerformanceCapture()`、`serializePerformanceCapture()`、`exportChromeTrace()`、`streamChromeTrace()`、`serializeChromeTrace()`。

- [x] 写 schema golden file，覆盖正常导入、未知字段、未来 schema、NaN/Infinity、重复帧和非单调帧。
- [x] 捕获 engine/environment/sampling/metric catalog/frame/diagnostics，不包含 GPU 对象或 DOM。
- [x] 实现 CPU slice、GPU 独立 track、metric counter、不可用状态和 clock alignment metadata；Trace 分块序列化使用独立 golden file 验证。
- [x] GPU duration-only 数据只导出 counter，不生成伪造起点的 slice。
- [x] 验证两次序列化字节稳定、导入后派生统计一致，提交 `feat(profiler): add capture and trace codecs`。

### Task 6：建立 Inspector addon 生命周期和无框架 UI Shell

**文件：**

- 新建 `OEngine/src/addons/inspector/index.ts`
- 新建 `OEngine/src/addons/inspector/Inspector.ts`
- 新建 `OEngine/src/addons/inspector/InspectorViewModel.ts`
- 新建 `OEngine/src/addons/inspector/InspectorShell.ts`
- 新建 `OEngine/src/addons/inspector/inspector.css`
- 修改 `OEngine/package.json`
- 新建 `OEngine/tests/inspector-view-model.test.mjs`

**产出接口：** 本文 4.2 定义的 `Inspector`、`InspectorOptions` 和 `InspectorMode`。

- [x] 先测试 mode transition、pause/resume、选帧、范围、异步 replacement 和 dispose 后不再接收更新。
- [x] 在 package exports 添加 `./addons/inspector` 和 `./addons/inspector/style.css`，不污染根入口。
- [x] 实现 Shadow DOM shell、toolbar 和 tab 生命周期；所有外部文本使用 `textContent`。
- [x] 实现 inline/nonce/external/none 样式策略和完整 `dispose()`。
- [x] 用 `requestAnimationFrame` 限制 UI 刷新，数据回填与 UI cadence 解耦。
- [x] 运行 view-model 测试和 build，提交 `feat(inspector): add addon shell`。

### Task 7：实现 Overview 和 Timeline

**文件：**

- 新建 `OEngine/src/addons/inspector/charts/FrameChart.ts`
- 新建 `OEngine/src/addons/inspector/charts/SeriesChart.ts`
- 新建 `OEngine/src/addons/inspector/panels/OverviewPanel.ts`
- 新建 `OEngine/src/addons/inspector/panels/TimelinePanel.ts`
- 新建 `OEngine/tests/inspector-timeline-model.test.mjs`

**产出接口：** 帧条、趋势图、预算线、帧/范围选择、CPU/GPU 轨道和统计详情。

- [ ] 为状态颜色、预算分类、frame selection 和范围 percentile 写纯 view-model 测试。
- [ ] Canvas 图表只保存有界 typed arrays；resize 时按 DPR 重建 backing store。
- [ ] Timeline 明确区分 available/pending/unsupported/invalid/dropped 和 instrumented。
- [ ] GPU 无起点时切换为 duration table，并显示“CPU/GPU clock not aligned”。
- [ ] 验证 2048 帧下 UI 更新不重建完整 DOM，提交 `feat(inspector): add overview and timeline`。

### Task 8：实现领域面板

**文件：**

- 新建 `OEngine/src/addons/inspector/panels/GpuDrivenPanel.ts`
- 新建 `OEngine/src/addons/inspector/panels/FrameGraphPanel.ts`
- 新建 `OEngine/src/addons/inspector/panels/ResourcesPanel.ts`
- 新建 `OEngine/src/addons/inspector/panels/DiagnosticsPanel.ts`
- 新建 `OEngine/tests/inspector-domain-model.test.mjs`

**产出接口：** GPU-driven funnel、队列容量、FrameGraph 表、资源账本和 diagnostics/capability 表。

- [ ] 测试 funnel 分母为零、缺失 counter、overflow、feature-off 和资源释放后的展示。
- [ ] GPU-driven 面板从注册指标组合数据，不读取 GPU buffer。
- [ ] FrameGraph 面板展示 active/pruned 和资源读写摘要。
- [ ] Resources 强制附带 accounted/estimated 标签。
- [ ] Diagnostics 列出 unsupported 原因和 Inspector 自身开销。
- [ ] 运行面板模型测试和 build，提交 `feat(inspector): add engine performance panels`。

### Task 9：接入 Rendering Lab 并完成准确性门禁

**文件：**

- 修改 `examples/rendering-lab/main.ts`
- 修改 `examples/rendering-lab/style.css`
- 修改 `examples/rendering-lab/evidence.ts`
- 修改 `examples/rendering-lab/README.md`
- 修改 `docs/VALIDATION.md`

**产出：** Rendering Lab 中可直接打开 Inspector；现有 evidence 统计迁移到共享核心；固定场景下有 off/Live/Record/Deep Capture 开销报告。

- [ ] 用 Inspector 替换 Rendering Lab 中重复的性能展示逻辑，保留场景控制和必要 debug view。
- [ ] 对 capture 导出→清空→导入→选帧执行浏览器闭环。
- [ ] 导出 trace 并在 Perfetto UI 打开，核对轨道、frameIndex、counter 和未对齐警告。
- [ ] 固定 1920×1080、DPR 1、相同 adapter/浏览器/feature set/camera/warm-up，运行 profiler off、Live、Record、Deep Capture。
- [ ] 报告 CPU P50/P95、GPU Pass Sum P50/P95、submit、readback bytes、dropped/invalid 和 Inspector UI CPU 开销。
- [ ] 检查 profiler disabled 时无 query、counter buffer、readback、DOM 和额外 submit。
- [ ] 运行命中单测、`npm run build`、Rendering Lab 浏览器示例和文档静态检查，提交 `feat(inspector): integrate performance inspector`。

## 13. 完成门禁

以下条件全部满足才算第一版完成：

- `import { Inspector } from "oengine/addons/inspector"` 可工作，生命周期完整。
- Live、Record、Deep Capture 都有明确 cadence、状态和开销显示。
- 选中任意帧时，延迟 GPU 数据不会串到其他帧。
- 所有指标来自 registry，UI 中不存在未声明单位和来源的数字。
- pending/unsupported/invalid/dropped 在 UI、Capture 和 Trace 中保持不同状态。
- Capture 可导入并恢复帧、范围、指标目录和诊断。
- Perfetto/Chrome Trace 可打开，且不伪造 CPU/GPU 时钟对齐。
- counter 插桩帧不进入生产 timing baseline。
- 资源字节有 owner、分类、创建、释放和峰值证据，无物理 VRAM 误导。
- profiler disabled 的 feature-off 成本接近零。
- 固定条件下有 off/Live/Record/Deep Capture A/B 数据，而不只是一张 UI 截图。

## 14. 实施顺序结论

不得先写漂亮面板再补数据。执行顺序固定为：

```text
指标语义
  → 帧与异步状态
  → 迁移现有 FrameProfiler
  → 补资源/Pipeline/FrameGraph
  → Capture/Trace
  → Inspector Shell
  → Overview/Timeline
  → 领域面板
  → Rendering Lab 与准确性门禁
```

Task 1–5 形成无 UI 的可靠 profiler 核心；Task 6–8 只把这些事实可视化；Task 9 证明监视器本身没有破坏被测性能。
