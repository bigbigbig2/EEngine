# OEngine R0 Benchmark Harness

本目录是 R0 性能证据入口。当前已完成 Result Schema v2、CPU frame timeline、submit/readback/upload 证据、可选 GPU timestamp、256-byte GPU counter ABI、至少三槽异步 readback、diagnostics 和 percentile 汇总；A/B/C 的实际场景资产与自动相机轨迹仍需后续 `OBS-02` 工作包接入。

A/B 只是 OEngine 必须达到的最低垂直功能与性能基线：覆盖 GPU LOD/work generation、SW/HW Visibility、材质重建和 PBR/IBL。它们不是产品范围或完成上限。C 与通用 vertical/lifecycle cases 还必须证明多 geometry/material、动态对象与 Packed Instances、GPU Render World、层次 LOD、完整效果和 device/resource 生命周期。A/B/C 必须复用同一 OEngine 主管线，不能为 benchmark 创建样例专用 Renderer。

## 采样约束

- 固定浏览器、GPU、分辨率、DPR、feature set、seed、warm-up 和采样帧数。
- profiler 默认关闭；benchmark 显式开启。
- CPU 和 submit/readback 每个测量帧记录；GPU timestamp 默认每 60 帧采样一次。
- GPU counter 默认每 60 帧采样一次，ring 满时丢样本并写入 diagnostics，绝不阻塞主帧。
- GPU timestamp 不可用时 `gpu.available=false`，不能用 CPU 时间冒充。
- `legacy.*` counters 描述当前 reconstructed 管线，只用于建立迁移前基线。
- `gpuCounters.values` 只包含真实登记 producer 的字段；字段缺失表示未接入，不能按 0 解读。

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

根目录现有两个垂直入口：

- [r0-observability](../../examples/r0-observability/README.md)：真实初始化 `Renderer`/WebGPU，隔离验证观测设施与 `GraphicsContext.update()`。
- [r0-frame-smoke](../../examples/r0-frame-smoke/README.md)：固定 81 Box 场景，运行真实 `Renderer.render()` 并采集 GPU timestamp。

```powershell
Set-Location examples
npm install
npm run dev:host
```

这些页面不是 A/B/C 性能结果。只有达到各自固定采样帧数、控制台无 WebGPU validation error、结果 JSON 可导出且主帧页面截图正确时，才算浏览器侧 smoke 通过。

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
gpuCounters.schemaVersion/sampled/pending/dropped/values
counters.legacy.*
counters.lighting.*
counters.gpu.residentBytes
diagnostics.validationErrorCount/uncapturedErrorCount/deviceLostCount
diagnostics.droppedGpuCounterSamples/failedGpuCounterSamples
```

GPU counter ABI 当前是 256-byte `u32` 固定布局，定义见 `src/debug/GpuFrameCounters.ts`。主帧已完成 buffer clear、采样 copy、submit 后异步 map 与 frame-index 归档。最终 Visibility Buffer 是首个真实 producer：采样帧通过 8×8 工作组归约输出 `shadedPixels` 与 `emptyVisibilityPixels`；前者当前表示 mesh-id 非 sentinel 的最终可见性覆盖像素，不代表 Material/Lighting shader invocation。每个有效样本必须满足：

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

非采样帧不添加统计 Pass，也不编码 counter clear/copy/readback。cone/HZB reject reason、SW raster 和 material overflow producer 仍是 Partial。

## Shader source 审计

```powershell
npm run audit:shaders
```

命令确定性生成 `benchmarks/shader-source-audit.json`。schema v2 覆盖每个 `src/shaders/*.ts` 的 direct/runtime consumers、最近 runtime pipeline owners、generator candidates、分类与删除候选。当前为 55 个 `authored-live`、5 个 `dead` candidate 和 6 个正在运行但 ownership 未闭环的 oracle/generated `unknown`。人工解释与静态分析限制见 `../../docs/SHADER-SOURCES.md`。

## 尚未完成的 R0 工作

- A：160k Teapot 的同资产/同相机/同输出对齐页面。
- B：相同 glTF、LOD、环境贴图与 PBR/IBL 对齐页面。
- C：geometry/material/alpha/shadow/dynamic-transform 分轴场景。
- GPU pass producer：cone/HZB reject reason、SW raster 与 material overflow bit。
- VisibilityKey、HZB mip、reject reason、material ID 等统一 debug views。
