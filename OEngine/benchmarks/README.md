# OEngine R0 Benchmark Harness

本目录是 R0 性能证据入口。当前已完成 Result Schema v3、feature-to-counter 能力证据矩阵、CPU frame timeline、submit/readback/upload 证据、可选 GPU timestamp、256-byte GPU counter ABI、至少三槽异步 readback、diagnostics 和 percentile 汇总；A/B/C 的 manifest、实际资产 hash、固定相机、共享 runner 与三个浏览器入口也已接入。`OBS-02` 代码交付已经收口，尚差一次可用 WebGPU 浏览器中的 smoke 验收。

A/B 只是 OEngine 必须达到的最低垂直功能与性能基线：覆盖 GPU LOD/work generation、SW/HW Visibility、材质重建和 PBR/IBL。它们不是产品范围或完成上限。C 与通用 vertical/lifecycle cases 还必须证明多 geometry/material、动态对象与 Packed Instances、GPU Render World、层次 LOD、完整效果和 device/resource 生命周期。A/B/C 必须复用同一 OEngine 主管线，不能为 benchmark 创建样例专用 Renderer。

## 采样约束

- 固定浏览器、GPU、分辨率、DPR、feature set、seed、warm-up 和采样帧数。
- profiler 默认关闭；benchmark 显式开启。
- CPU 和 submit/readback 每个测量帧记录；GPU timestamp 默认每 60 帧采样一次。
- GPU counter 默认每 60 帧采样一次，ring 满时丢样本并写入 diagnostics，绝不阻塞主帧。
- GPU timestamp 不可用时 `gpu.available=false`，不能用 CPU 时间冒充。
- `legacy.*` counters 描述当前 reconstructed 管线，只用于建立迁移前基线。
- `gpuCounters.values` 只包含真实登记 producer 的字段。对当前 feature set 的 required/supported counter，字段必须存在且允许真实值为 `0`；对 `capabilityEvidence` 声明为 unsupported 的字段，必须缺失并携带 blocker，不能写假 `0`。

## 浏览器侧接入

```ts
import {
  BenchmarkRunController,
  captureWebGpuLimits,
  createEnvironmentManifest,
  serializeBenchmarkResult
} from "../src/index.js";

renderer.profiler.configure({
  enabled: true,
  gpuSampleInterval: 60,
  gpuCounterSampleInterval: 60,
  readbackRingSlots: 3,
  historyCapacity: 2048
});

const environment = createEnvironmentManifest({
  engine: {
    commit: BUILD_COMMIT,
    dirty: BUILD_DIRTY,
    dirtyReasons: BUILD_DIRTY_REASONS
  },
  platform: {
    os: navigator.platform,
    browser: BROWSER_VERSION,
    userAgent: navigator.userAgent
  },
  adapter: renderer.adapter_info,
  webgpu: {
    features: renderer.device.features,
    limits: captureWebGpuLimits(renderer.device.limits),
    powerPreference: "high-performance"
  },
  frame: {
    canvasWidth: renderer.output_resolution.x,
    canvasHeight: renderer.output_resolution.y,
    internalWidth: INTERNAL_WIDTH,
    internalHeight: INTERNAL_HEIGHT,
    dpr: renderer.pixel_ratio
  },
  run: {
    baselineRole: "minimum-a",
    featureSet: ENABLED_FEATURE_NAMES,
    warmupFrames: 120,
    sampleFrames: 600,
    gpuSampleInterval: 60,
    gpuCounterSampleInterval: 60,
    readbackRingSlots: 3
  }
});

const controller = new BenchmarkRunController(renderer.profiler, environment, {
  id: "A",
  name: "Compute Rasterizer alignment",
  sceneAssetHashes: [ASSET_HASH],
  seed: 42,
  cameraPathHash: CAMERA_PATH_HASH
});

// controller 统一执行 warm-up/sample，并等待延迟 GPU 结果后再完成。
const result = await controller.run({
  frame: () => renderer.render(camera, scene, 1 / 60),
  settle: () => renderer.device.queue.onSubmittedWorkDone()
});
const json = serializeBenchmarkResult(result);
```

`BUILD_COMMIT`、浏览器版本、资产 hash 和相机轨迹 hash 必须由宿主/构建脚本提供；浏览器无法可靠推断这些值。

## 可运行浏览器示例

根目录现有五个垂直入口：

- [r0-observability](../../examples/r0-observability/README.md)：真实初始化 `Renderer`/WebGPU，隔离验证观测设施与 `GraphicsContext.update()`。
- [r0-frame-smoke](../../examples/r0-frame-smoke/README.md)：固定 81 Box 场景，运行真实 `Renderer.render()` 并采集 GPU timestamp。
- [benchmark-a](../../examples/benchmark-a/index.html)：7 级 Teapot 资产、160k 布局和 A 相机契约。
- [benchmark-b](../../examples/benchmark-b/index.html)：Damaged Helmet PBR 输入、15,625 布局和 B 相机契约。
- [benchmark-c](../../examples/benchmark-c/index.html)：多 geometry/material、alpha-tested、灯光和动态 transform 配方。

```powershell
Set-Location examples
npm install
npm run dev:host
```

`benchmark-a/b/c` 默认无查询参数时运行完整契约；`?profile=smoke` 缩小实例与帧数并强制把 Result 标成 dirty/non-gate。只有达到各自固定采样帧数、控制台无 WebGPU validation error、结果 JSON 可导出且主帧页面截图正确时，才算浏览器侧 smoke 通过。

`validateBenchmarkEvidence(result)` 负责 Result JSON 的最低机器判定：Schema、clean commit、A/B/C role、真实 hash、环境、能力矩阵、diagnostics、采样完成状态、GPU timestamp/counter 与 phase 汇总任一缺失都会返回机器可读错误；`gpuMs`、`gpuPhaseMs`、`gpuCounters` 都从逐帧样本反算核对，不能只补一个同名空对象过关。

报告中的两个结论不得混用：

- `gateEligible=true`：artifact 结构、采样和 supported/unsupported 声明可信，可以作为 G0 证据。
- `capabilityComplete=true`：本次启用的 feature set 及其所有必需 counter 都已支持；否则查看 `blockedCapabilities` 的任务 ID。

带 blocker 的当前能力 artifact 可以前者为 true、后者为 false。A/B 最终通过还要求 `capabilityComplete=true`、固定功能/画质/性能契约以及仓库外截图和控制台 run bundle；validator 不会仅凭 JSON 宣告性能达标。已采集旧数据的结论见 [`docs/BASELINE-ARTIFACTS.md`](../../docs/BASELINE-ARTIFACTS.md)。

## 当前 CPU/GPU 证据字段

```text
cpuMs.frame
cpuMs.graphics-update
cpuMs.world-and-view-update
cpuMs.graph-build
cpuMs.graph-compile
cpuMs.graph-execute
cpuMs.queue-submit

submits.labels[*]
readbacks.labels[*] + bytes
uploads.labels[*] + bytes
graph.builds / compiles / executes
gpu.segments[*].label/type/durationMs
gpu.segments[*].phase
summary.gpuMs[*]              # 原始 Pass label
summary.gpuPhaseMs[*]         # 每帧先按稳定逻辑阶段求和
gpuCounters.schemaVersion/sampled/pending/dropped/values
counters.legacy.*
counters.lighting.*
counters.gpu.residentBytes
diagnostics.validationErrorCount/uncapturedErrorCount/deviceLostCount
diagnostics.failedGpuTimestampBatches
diagnostics.droppedGpuCounterSamples/failedGpuCounterSamples
capabilityEvidence.schemaVersion
capabilityEvidence.featureSets[*].status/requiredGpuCounters
capabilityEvidence.gpuCounters[*].status/producer
capabilityEvidence.gpuCounters[*].blockerTaskId/reason
```

采样帧会自动登记该帧创建的每个 OEngine `ShadeGPUCommandContext`，原始 label 采用 `<command-context>/<pass>` 形式。不同 context 的 readback 即使乱序完成，也按 GPU command context 的注册顺序归档；非采样帧不会创建 timer/query/readback，采样本身不增加 submit。timestamp 只覆盖 context 内实际存在的 compute/render Pass，纯 copy/write 区间仍不可见；当前也没有横跨多个 submit 的 whole-frame GPU 起止 marker，因此各 Pass/phase 之和不能冒充完整 GPU frame latency。

GPU counter ABI 当前是 256-byte `u32` 固定布局，定义见 `src/debug/GpuFrameCounters.ts`；Result Schema 当前为 v3，能力证据矩阵 schema 当前为 v2，定义见 `src/debug/BenchmarkCapabilityEvidence.ts`。`BenchmarkHarness` 根据 manifest 的 feature set 自动写入冻结矩阵，未知 feature set 会在 Result 完成时失败，要求先登记证据契约。主帧已完成 buffer clear、采样 copy、submit 后异步 map 与 frame-index 归档。最终 Visibility Buffer 是首个真实 producer：采样帧通过 8×8 工作组归约输出 `shadedPixels` 与 `emptyVisibilityPixels`；前者当前表示 mesh-id 非 sentinel 的最终可见性覆盖像素，不代表 Material/Lighting shader invocation。每个有效样本必须满足：

`FrameProfiler` 在采样帧会直接拒绝注册矩阵中仍为 unsupported 的字段，不能把 counter buffer 清零后的槽位导出为假证据。实现真实 GPU producer、更新冻结矩阵和相应测试之后，该字段才可进入 sampled values。

```text
shadedPixels + emptyVisibilityPixels
== environment.frame.internalWidth × environment.frame.internalHeight
```

LightCluster 的 frustum-visible 与 HZB-filtered 两级 list 都通过同一 GPU reducer 检查 overflow，filtered list 另外输出 `activeLights`：它表示通过 GPU frustum + HZB filter、实际可由列表容纳并送入 cluster assign 的 Point/Spot light 数量，不包含 DirectionalLight。两级列表都是 4-byte count header + `u32` elements，capacity 从 64 KiB Buffer 的实际尺寸推导为 16,383；任一级 raw count 超容量都会设置 `queueOverflowMask` bit 3。

Material Expand 在采样帧结束实际 draw 循环后，通过 GPU atomic add 输出 `activeMaterials`。该字段精确定义为已构建、非透明、实际编码了一次全屏 Material Expand draw 的去重材质数；它不是最终可见像素中出现的材质数。当前每增加 1 就意味着本帧多一次全屏 GBuffer 扫描，可直接暴露旧材质路径的固定成本。

现有 Visibility GPU list 会在采样帧直接累计 `candidateInstances`、`visibleInstances`、`rejectedFrustum`、cluster/HW 工作量。计数器以 Buffer size、16-byte header 与元素 stride 推导 capacity，只累计实际可容纳的 safe count；scene-mesh/meshlet raw count 超容量时分别设置 `queueOverflowMask` bit 0/1。前三个 instance 字段仅描述 GPU scene frustum filter：candidate 是所有执行 job 的输入 row 总和，visible 是输出 safe count，rejected 是未通过 sphere/AABB frustum test 的 row；initial/second-chance/alpha 可重复出现同一逻辑 instance。cluster 字段同样是所有真实 wave/bucket 的队列项总和，均不声明跨 wave 唯一；`hwTriangles` 是固定功能路径提交的 primitive。无 overflow 时满足：

```text
candidateInstances == visibleInstances + rejectedFrustum
selectedClusters == hwClusters + alphaClusters
hwTriangles == selectedClusters × 128
```

现有三种 Visibility HZB cull Shader 在采样 variant 中直接产生 `rejectedHzb`。它只累计 `visibility_query_depth_from_screen_space_bb()` 的真实遮挡分支；frustum、投影失败和 offscreen/texel-center 裁剪不计入。该字段是 initial、dual、second-chance 与 alpha wave 的 reject event 总和，不声明跨 wave 唯一。非采样 variant 没有 counter bind group 或额外 atomic。

非采样帧不添加统计 Pass，也不编码 counter clear/copy/readback。能力矩阵把 `hzb-culling` 与 `hardware-visibility` 分开；当前不存在独立 Meshlet cone culling，所以 `cone-culling/rejectedCone` 以 `unsupported + WORK-04` 表达。`visitedBvhNodes` 同样以 `unsupported + WORK-04` 表达；SW counter 以 `unsupported + VIS-05` 表达。Packed Instances 是 feature capability 而非单个 counter，以 `unsupported + WORLD-07` 表达。material overflow bit 仍未接线，不得从现有 `queueOverflowMask` 推断 bit 2 已受保护。

## Shader source 审计

```powershell
npm run audit:shaders
```

命令确定性生成 `benchmarks/shader-source-audit.json`。schema v2 覆盖每个 `src/shaders/*.ts` 的 direct/runtime consumers、最近 runtime pipeline owners、generator candidates、分类与删除候选。当前为 55 个 `authored-live`、5 个 `dead` candidate 和 6 个正在运行但 ownership 未闭环的 oracle/generated `unknown`。人工解释与静态分析限制见 `../../docs/SHADER-SOURCES.md`。

## 固定剩余的 R0 工作

只剩两个顺序工作包：

1. `OBS-02`：实现已完成；只需在可用 WebGPU 浏览器中复测两个既有 smoke 与 A/B/C smoke 页面，保存控制台/截图并确认 Schema v3 可导出。该验收不得再扩出新 schema、counter、debug view 或后续算法任务。
2. `OBS-08`：在主要开发/目标 adapter 上采集当前实现的 A/B/C clean Schema v3 cold/warm JSON、截图、控制台记录和分析 bundle，并登记到 `docs/BASELINE-ARTIFACTS.md`。

`r0-observability` 与 `r0-frame-smoke` 的 Schema v3 浏览器复测并入 `OBS-02` 验收。当前 artifact 可以对 Packed Instances（`WORLD-07`）、Hierarchy/SSE LOD/cone culling（`WORK-04`）和 SW Visibility（`VIS-05`）诚实报告 unsupported；这不妨碍 G0 artifact 合格，也不等于 A/B 功能已通过。

以下内容不再列为 R0 剩余：material overflow 保留 bit 2、更多逐像素 debug producer、纯 copy/write GPU timestamp 和跨 submit whole-frame query。它们没有被当前 feature evidence 宣称为 supported，或超出 WebGPU Pass timestamp 范围；未来在对应 owner/算法任务中实现，禁止用占位 counter 收口。
