# 02 · R1 运行时提交、Compiled FrameGraph 与 Compute HZB

## 阶段状态

R1 已完成代码与 R0 artifact 调查，执行计划于 2026-08-26 冻结。`R1-A` 已完成代码、自动门禁与 Frame Smoke/A/B/C 浏览器功能验收；`R1-B` 于 2026-08-27 完成代码与自动门禁，等待 Frame Smoke/A/B/C 浏览器 after smoke 后关闭。

R1 解决与场景规模不成比例的运行时固定成本和错误生命周期边界。它不会实现 R2 的 Runtime Asset/Packed Instance、R3 的 Geometry Hierarchy/SSE LOD、R4 的 Compute Software Raster，也不把 three.js 两个示例当作引擎完成上限。

## 阶段目标

完成 R1 后，同一个 render tick 的 upload、scene change、animation、shadow、visibility、lighting、post 和采样 copy 必须由一个主要 `GPUCommandEncoder` 编码，并由唯一 owner 执行一次主要 `queue.submit()`；稳定 FrameGraph 拓扑只在 key miss 时编译；HZB 不再为每个 mip 创建 Render Pass；关闭 feature 后不残留 Pass、资源、readback、timestamp 或 submit。

阶段退出必须同时证明：

- 提交所有权唯一，而不是把额外 submit 改了名字；
- scene preparation 每个 scene 每帧至多一次，shadow view 不重复 flush scene；
- compiled topology 与本帧 GPU handle、相机和动态数据已经分离；
- HZB history 在 resize、camera cut 和 feature toggle 后不会错误复用；
- 被替代的旧提交、旧图构建入口和旧逐 mip Render Pass 已删除；
- A/B/C 与通用生命周期示例有前后 JSON、截图和控制台证据。

## 非目标与范围边界

- 不冻结新的 Geometry/Cluster/Visibility ABI。
- 不实现 Core/Quality/Experimental 三档真实管线；所有功能仍进入同一主管线 recipe。
- 不为“一个 submit”把资产离线烘焙、用户显式预上传、环境贴图预滤波或调试工具强塞进 render tick。
- 不要求把所有 `queue.writeBuffer()` 机械改成 staging copy。它不是 `queue.submit()`，先记录 owner、字节和发生顺序，再由数据决定是否迁移。
- 不把所有逻辑塞进 `Renderer.render()`；`Renderer` 继续是 composition root，不成为 Graphics、Scene、HZB 或 FrameGraph 算法 owner。
- 不在 R1 实现复杂的跨资源全局 alias allocator。Compiled graph 先冻结 pass order、pruning 和 last-use，瞬态资源继续通过现有 pool 复用；更激进 alias 必须有单独内存证据。
- 不承诺 second chance 永久开启。它是同一 recipe 中可裁剪的条件节点，不是另一条管线。

## R0 输入证据与根因

本节只使用 `temp/` 中 2026-08-26 Schema v3 acceptance-smoke 解释当前路径。它们不是正式性能 gate，R1 第一次修改代码前仍要采集 clean/full 入口基线；这属于 R1 的前测，不会重新打开 G0。

| Case | CPU frame P50 / P95 | Submit | Graph build / compile / execute | HZB build / mip Render Pass | HZB GPU P50 / P95 |
|---|---:|---:|---:|---:|---:|
| Frame Smoke | 2.150 / 2.985 ms | 3 | 1 / 1 / 1 每帧 | 2 / 20 | 0.114 / 0.116 ms |
| A smoke | 2.800 / 3.800 ms | 3 | 1 / 1 / 1 每帧 | 2 / 20 | 0.125 / 0.127 ms |
| B smoke | 3.050 / 3.860 ms | 3 | 1 / 1 / 1 每帧 | 2 / 20 | 0.126 / 0.128 ms |
| C smoke | 9.300 / 18.555 ms | 13 | 1 / 1 / 1 每帧 | 3 / 30 | 1.040 / 1.051 ms |

### Submit 的精确来源

Frame Smoke、A、B 的三次提交固定为：

```text
GraphicsContext.update                         × 1
GPUSceneContext/animation-flush                × 1
Renderer/main-0                                × 1
```

C 的十三次提交固定为：

```text
GraphicsContext.update                         × 1
GPUSceneContext/animation-flush                × 10
GPUSceneContext/database-incremental-update    × 1
Renderer/main-0                                × 1
```

C 的放大不是“阴影天然需要十三次提交”。`GPUViewContext.update()` 当前会调用 `scene.update()`；主 view 与 shadow views 更新时反复进入同一个 scene，因而每次都无条件创建 animation command。动态 transform 随后又触发 database incremental command。scene preparation 与 per-view preparation 没有分开，才是这里的根因。

### Readback、upload 和图重建

- 所有普通帧都调用 `GPUCollectionLimits.update()`，复制 6,144 bytes collection history 并异步 map；非 GPU timestamp/counter 采样帧仍有一次 collection readback。
- A/B/Frame Smoke 每帧 upload 728 bytes；C 每帧 8,456 bytes，其中相机状态 6,240 bytes、view uniform 960 bytes、TLAS dirty nodes 896 bytes、HZB clip 144 bytes、staging copy 216 bytes。
- 所有记录帧都 `new FrameGraph()`、build、compile、execute 一次；12 帧 A/B/C 各发生 12 次 compile，没有 warm cache hit。
- A/B/Frame Smoke 每帧构建两次 10-mip HZB；C 因 alpha/shadow/visibility 路径构建三次。C 的 `hierarchy-and-cluster-cull` GPU P50 另有 2.596 ms，因此 R1 不能把总慢简单归因于 HZB。

### 当前提交 owner 分类

| 当前 owner | 当前分类 | R1 处理 |
|---|---|---|
| `Renderer/main-0` | steady-frame | 保留为 render tick 唯一 submit owner，并迁入 `FrameCoordinator` |
| `GraphicsContext.update()` | steady-frame | 改为只做 CPU maintenance 和向主 context 编码真实 dirty work |
| `GPUSceneContext` animation/database flush | steady-frame | scene 每帧只准备一次，全部并入主 context |
| `LightDatabase.update()` | render tick 的 dirty work | encode-only；environment prefilter 若显式预处理则分类 one-shot |
| `GPUVolumetrics.update()` | render tick 的 dirty work | encode-only；无 version change 时零编码 |
| `GPUResidentMaterialContext.update()` | residency dirty work | render 前发生时并入主 context；显式预上传可 one-shot |
| Shadow draw/view update | steady-frame | 多 view 可有多个 Pass，不得产生多个 submit，也不得重复 scene prepare |
| LPV bake/probe placement/read | explicit tool/bake | 可独立提交，但必须有 one-shot label，不能出现在普通 render tick |
| database grow/compact/read、camera clone、mipmap fallback | one-shot/tool/recovery 候选 | 逐项登记调用条件；一旦每帧出现即迁入主 context 或删除 |

`createCommandEncoder()`、`submitGpuCommands()`、`mapAsync()` 的完整 allowlist 是 `R1-A01` 的交付物。上表不是允许跳过未知调用的白名单。

## 目标架构：三个需要守住的 seam

R1 不新增一组薄 wrapper。目标是三个具有足够 depth 和 leverage 的 module：帧协调器隐藏编码/提交/采样生命周期；compiled graph 隐藏拓扑编译和瞬态生命周期；HZB 隐藏 pyramid 算法与 history 状态。

```text
Renderer.render()                         composition root
  │
  └─ FrameCoordinator                    唯一 render-frame submit owner
       ├─ GraphicsContext.encodeFrameMaintenance()
       ├─ GPUSceneContext.encodeFrame()  每 scene / frame 至多一次
       ├─ GPUViewContext.encodeViewState()
       ├─ ShadowContext.encodeViews()     N views，仍在同一 encoder
       ├─ CompiledFrameGraph.execute(bindings)
       │    └─ HierarchicalZBuffer.encodeBuild()
       └─ Profiler.encodeSampleCopies()  仅采样帧
```

### Seam 1：一帧唯一提交 owner

建议内部 interface：

```ts
type FrameEncoding = {
  readonly frameIndex: number;
  readonly command: FrameEncodeContext;
  readonly instrumentation: "none" | "timestamps" | "counters" | "debug";
};

class FrameCoordinator {
  beginFrame(input: FrameBeginInput): FrameEncoding;
  submitFrame(frame: FrameEncoding): FrameExecutionEvidence;
  abortFrame(frame: FrameEncoding, cause: unknown): void;
  destroy(): void;
}
```

`FrameEncodeContext` 可以由现有 `ShadeGPUCommandContext` 直接重构而来，但它只能 encode，不再公开会隐式 submit 的 `finish()`。只有 coordinator 能关闭 encoder、resolve timer、生成 command buffer、submit、推进 staging/readback ring 和发出完成信号。

必须明确区分三个时刻：

- `closed`：CPU 已结束编码；
- `submitted`：command buffer 已交给 queue；
- `gpuDone`：`queue.onSubmittedWorkDone()` 或 map 完成证明 GPU 已消费。

旧 `command.done` 当前只表示 context 已 `finish()`，不能继续含糊地兼作 GPU 完成。readback ring 和临时资源回收必须选择正确时刻，不能靠额外 submit 制造同步点。

显式 one-shot 工作允许独立提交，但必须满足：调用者不在 open render frame 中；label 和 `one-shot | tool | recovery` 分类非空；runtime counter 可见；调用点在 allowlist。不要为每个系统创建一套 immediate adapter。

### Seam 2：Compiled topology 与 frame bindings

当前 `FrameGraph` 同时拥有 pass 声明、动态 pass data、imported GPU handle、compile state 和 execute state，导致无法安全缓存。目标拆分为一个 deep `CompiledFrameGraph` module；cache 若只是一个 `Map`，直接由 `FrameCoordinator` 或 Renderer 内部持有，不单独建立浅 `FrameGraphCache` class。

```ts
type CompiledFrameGraph = {
  execute(
    frame: FrameEncodeContext,
    bindings: FrameGraphBindings,
  ): FrameGraphExecutionEvidence;
  dump(): CompiledFrameGraphDump;
  destroy(): void;
};
```

编译结果拥有：

- executable pass order 与被裁剪 pass；
- logical resource slot、读写边和 imported binding slot；
- transient descriptor、first/last use 与现有 pool 的 acquire/release plan；
- pass execute function 和稳定的 binding 索引；
- feature、history 和 instrumentation 条件的 graph dump。

每帧 bindings 只拥有当前 swapchain view、camera buffer、scene/light/material tables、history views、动态常量和 job data。execute 不能修改 compiled topology，也不能把上帧 GPU handle 留在闭包里。

`FrameGraphKey` 使用 canonical plain value 和集中 hash/equality helper，不必成为独立 module。key 至少包含：

```text
capabilityProfile
internalWidth × internalHeight
outputWidth × outputHeight
view/sample count
enabledFeatureBits
visibilityImplementation
historyFormatRevision
instrumentationMode/revision
```

camera matrix、时间、instance/light/material 数、dirty ranges、GPU handle 和当前 history valid 状态不进入 key。相同 key 的 warm frame 必须是 cache hit；resize、DPR/render scale、feature topology、format/capability 和 instrumentation recipe 改变才 miss。采样与非采样允许命中两份稳定 compiled graph，不能每次重新生成。

### Seam 3：per-view HZB 与 history owner

不长期并存 `ComputeHierarchicalZBuffer` 和旧 `HierarchicalZBuffer` 两个 owner。保留 per-view `HierarchicalZBuffer` 概念，直接替换内部算法，并收紧 interface：

```ts
class HierarchicalZBuffer {
  setViewportSize(width: number, height: number): void;
  previousView(): GPUTextureView | null;
  encodeBuild(frame: FrameEncodeContext, depth: GPUTextureView): HzbBuildEvidence;
  commitHistory(frameIndex: number): void;
  invalidate(reason: HzbInvalidationReason): void;
  destroy(): void;
}
```

每个 view 的 history 至少保存：

```text
valid
dimensions + mipCount + formatRevision
cameraCutRevision
renderScaleRevision
featureRevision
lastWrittenFrame
```

previous history 在本帧 initial visibility 期间只读；current/final pyramid 的写入与 history commit 明确分开。需要时使用 ping-pong 或独立 scratch，禁止一个未声明状态的 texture 既冒充 previous 又在中途被覆盖。

## R1 执行顺序

R1 以四个纵向包连续执行。每包都要求代码、测试、命中浏览器示例、删除项和中文详细 commit 一起完成；不要把十个小步骤分别拖成多轮“还差一点”。

```text
R1-A Frame ownership / one-submit
  ↓
R1-B Compiled graph / feature pruning
  ↓
R1-C Compute HZB / history
  ↓
R1-D Lifecycle / deletion / regression gate
```

### R1-A · Frame ownership 与 one-submit 闭环

#### 当前实施状态（2026-08-26）

| ID | 状态 | 已落地证据 / 剩余验收 |
|---|---|---|
| `R1-A01` | 完成 | `GpuQueueEvidence` 冻结 submit owner 分类；未知 label 在 queue 前失败；静态门禁禁止主帧模块自建 encoder/submit；Frame/A/B/C runtime label 均只有 `Renderer/main-0`。 |
| `R1-A02` | 完成 | 新增 `FrameCoordinator`，统一 begin/submit/abort/destroy；command 暴露 `closed`、`submitted`、`gpuDone`，abort 会取消 readback ticket并释放未提交资源。in-flight GPU 完成后资源复用的完整矩阵仍属于 `R1-D03`。 |
| `R1-A03` | 完成 | Graphics maintenance、geometry/texture/material maintenance 与按需 collection sampling 编码到主 command；保留的 `GraphicsContext.update()` 明确降级为非 render-frame 的 one-shot tool。 |
| `R1-A04` | 完成 | `GPUSceneContext.encodeFrame()` 每 scene/frame 幂等；主/阴影视图只准备 camera/view uniform；animation、database、BLAS、TLAS dirty work 共用主 command；abort 后强制重建。 |
| `R1-A05` | 完成 | Light、environment prefilter、Volumetrics、resident material、mipmap、GPUDatabase grow、Geometry BLAS grow/upload 与 TLAS copy 已迁入调用方 command。 |
| `R1-A06` | 完成 | 非采样帧不发起 collection readback；采样 copy 编入主 encoder；readback ring 支持 abort/cancel，不为 map 制造额外 submit。 |
| `R1-A07` | 完成 | 旧 animation/database/Graphics/BLAS grow self-submit 已删除；修复 B mipmap 生命周期后 `npm test` 55/55 和 examples build 通过。Frame/A/B/C 均为一次 `Renderer/main-0` submit；diagnostics、真实 counter 与画面通过。 |

保留的独立 submit 只允许 `one-shot | tool | debug-readback | recovery` 分类；`GPUDatabase/read`、LPV bake/read、texture preserve resize、meshlet compact 等不属于 steady render tick。`queue.writeBuffer()` 不等于额外 submit，按本文件非目标约束继续记录 owner/bytes，不在 R1-A 机械改写全部 Pass settings upload。

第一次浏览器验收使用 commit `4de81f7a` 的 smoke artifact。Frame Smoke、A、C 均证明 `submit P50/max=1/1`、非采样 `readback P50=0`、`scenePrepareCount=1` 且 diagnostics 为 0；C 的 `viewPrepareCount=10` 对应 1 个主视图与 9 个实际阴影视图，没有放大 scene preparation 或 submit。B 同样达到 submit/scene 指标，但 3 个采样帧出现 `Buffer used in submit while destroyed`，截图为空蓝画面，因此第一轮 B artifact 无效。根因是并入主 encoder 的 mipmap 参数 Buffer/临时纹理仍沿用旧 one-shot 生命周期，在主 submit 前销毁；现已改为 command finish/abort 后回收。

修复后第二轮用户重新采集五个 smoke 页面，B 恢复为 `submit P50/max=1/1`、`readback P50=0`、`scenePrepareCount=1`、`shadedPixels P50=259190`、`validation/uncaptured/deviceLost=0`，画面人工确认正常；Frame/A/C 也继续正常。所有主管线帧的 submit label 唯一为 `Renderer/main-0`。该轮 dev server 没有重启，JSON 的 build-time commit 字段仍为 `4de81f7a`，因此只作为 R1-A non-gate 功能验收；R1-D clean/full paired benchmark 必须重启 server 并保存准确 commit/dirty 元数据。

#### 输入

- R0 Schema v3 submit/readback/upload/graph counter；
- 当前 `ShadeGPUCommandContext`、`GraphicsContext`、`GPUSceneContext`、`ViewContext`、shadow 与 profiler ring；
- 修改前 clean/full Frame Smoke + A/B/C 入口 artifact。

#### 任务

| ID | 实施内容 | 必须产出 |
|---|---|---|
| `R1-A01` | 静态与 runtime submit owner 审计 | 所有 encoder/submit/map 调用的分类表；render-frame submit allowlist 测试；未知 label 直接失败 |
| `R1-A02` | 重构 command 生命周期 | encode-only context；coordinator 唯一 close/submit；`closed/submitted/gpuDone` 语义；异常 abort 不泄漏资源 |
| `R1-A03` | 合并 Graphics maintenance | `GraphicsContext.encodeFrameMaintenance(frame)`；无 dirty GPU work 不创建额外 encoder；collection sampling 从 update 解耦 |
| `R1-A04` | 分离 scene 与 view preparation | `GPUSceneContext.encodeFrame()` 每 scene/frame 至多一次；view/shadow 只更新自身 camera/uniform；animation update/tick 与 database dirty upload 用主 context |
| `R1-A05` | 迁移其他 dirty owner | LightDatabase、Volumetrics、resident material、TLAS 与命中的 mipmap/upload fallback 在 render tick 内只 encode |
| `R1-A06` | 收口 sampled copy/readback | 非采样帧零 collection readback；采样 copy 位于主 encoder 尾部；异步 map 旧 ring slot，不阻塞当前 frame |
| `R1-A07` | 删除旧提交旁路并验收 | 删除无条件 animation flush、incremental self-submit、Graphics self-submit 和主帧可达的 `finish()` 调用 |

scene change、view update 的目标调用顺序固定为：

```text
consume Scene Change Set once
encode scene database / animation dirty work once
encode main view state
encode selected shadow view states
encode shadow + main graph work
encode sampled copies when requested
submit once
```

`SceneFrameEvidence` 至少记录 `scenePrepareCount`、structure/transform/bounds/material/light/animation dirty counts、upload bytes 和 view count。它不是让所有调用方学习的大型 `FrameUploadBatch` DTO；复杂合并逻辑留在 GPUScene/Graphics deep module 内部。

#### 允许的临时状态

- FrameGraph 仍可每帧 build/compile；旧 HZB 仍可逐 mip Render Pass。
- `ShadeGPUCommandContext` 类名可暂留，但 `finish()` 不能再被 steady-frame helper 调用。
- 显式 tool/one-shot 路径可暂时使用独立 submit，前提是分类表和 runtime label 完整。

#### 必删项

- `GraphicsContext.update()` 内自建 command/submit；
- `GPUSceneContext/animation-flush` 无条件 command；
- database incremental/full build 在 render tick 内自建 command；
- `GPUCollectionLimits.update()` 每帧 readback；
- main-frame helper 的 owned-command fallback。

#### 验收

- Frame Smoke、A、B、C 的 warm non-sampled frame 均为 `Renderer/main` 一次 submit；C 的 shadow views 不增加 submit。
- 非采样帧 readback 为 0；timestamp/counter 采样帧仍为一次 main submit。
- scene preparation counter 每 scene/frame 为 1，C 不再出现 10 次 animation flush。
- 动态 transform、动画、灯光/阴影和材质 residency 变化实际生效，不得为一 submit 丢掉 dirty work。
- `npm test`、根目录 Frame Smoke + A/B/C 浏览器 smoke、控制台 validation 和截图通过。

### R1-B · Compiled graph 与 feature pruning

#### 当前实施状态（2026-08-27）

| ID | 状态 | 已落地证据 / 剩余验收 |
|---|---|---|
| `R1-B01` | 代码完成，浏览器待验收 | `framegraph-compiled.test.mjs` 冻结 pass pruning、logical slot、first/last-use dump 和同 topology 换 bindings；主图真实 dump/画面仍随 after artifact 确认。 |
| `R1-B02` | 完成 | `FrameGraph.compile()` 返回不可变 `CompiledFrameGraph`；编译后 topology mutation 失败；execute 异常也会释放已取得的 transient。 |
| `R1-B03` | 完成 | 主管线 recipe 只在 miss 运行；swapchain、scene/camera/light/material、HZB、history 与动态 job 使用命名 binding slot，compiled closure 不保留首帧 GPU handle。 |
| `R1-B04` | 完成 | canonical key 覆盖 capability、尺寸、feature、format/history 与 instrumentation；LRU cache 拥有 hit/miss/evict/destroy；Profiler 保存对应计数。 |
| `R1-B05` | 代码完成，浏览器待验收 | shadows/SSAO/SSR/TAA/Bloom/Exposure/debug 从 recipe 入口裁剪；Bloom/Exposure 已解耦，Exposure off 不再添加 fallback Pass，shadow off 不登记 atlas resource。 |
| `R1-B06` | 完成 | steady main hit 路径只调用 `encodeCompiledGraph()`；`new FrameGraph(MAIN_FRAME_GRAPH_NAME)` 只存在 cache builder；LPV/tool 继续 one-shot。 |

自动验证为 `npm test` 全通过和根目录 examples production build 通过。浏览器插件在 runtime 初始化阶段失败，未取得新的 WebGPU after artifact；因此本表不会用自动测试冒充 A/B/C 画面、真实 GPU counter 或 validation 验收。手动验收必须看到：首个 key 帧 `build=1/compile=1/execute=1/cacheMiss=1`，随后相同 key 为 `build=0/compile=0/execute=1/cacheHit=1`，且 submit、readback、diagnostics 与 R1-A 不退化。

#### 任务

| ID | 实施内容 | 必须产出 |
|---|---|---|
| `R1-B01` | 冻结 topology/binding 测试面 | 当前主图 graph dump 金标；同 topology 换 GPU handles 不重新 compile 的测试 |
| `R1-B02` | 建立 compiled representation | pass order、pruning、logical slots、last-use plan 与 immutable execute interface |
| `R1-B03` | 迁移主管线 recipe | 把 `Renderer.ts` 每帧 pass/resource 声明迁为 recipe；动态闭包数据改为 binding slot |
| `R1-B04` | canonical key 与 cache | hit/miss/compile/evict counter；resize、feature、instrumentation invalidation；destroy 清理 |
| `R1-B05` | feature pruning | feature 从 recipe 入口控制；off 时 graph dump、资源、timer、readback、submit 中都不存在该功能 |
| `R1-B06` | 删除每帧 build/compile 入口 | steady main path 不再 `new FrameGraph()`；LPV/tool graph 保留明确 one-shot owner |

先完成固定 A/B/C feature set 和尺寸的最小 vertical cache，再验证 resize/toggle；不要先把 cache 设计成支持尚不存在的任意多 view/streaming ABI。

#### 允许的临时状态

- HZB 仍使用旧 Render 实现，但已经作为同一 recipe 节点执行。
- transient resource 继续使用现有 allocator/pool；本阶段只缓存 lifetime plan，不承诺跨 descriptor 的激进 alias。

#### 必删项

- main frame 每帧 `new FrameGraph(MAIN_FRAME_GRAPH_NAME)`；
- compiled pass closure 捕获本帧 GPU handle 的路径；
- feature off 后仍被 `make_side_effect()` 强制保留的无消费者 Pass；
- cache 迁移完成后的旧 mutable compile/execute interface 与只服务旧 interface 的测试。

#### 验收

- 首帧/key miss：build=1、compile=1、execute=1；相同 key warm frame：build=0、compile=0、execute=1、cacheHit=1。
- 替换 swapchain view、camera/scene buffer、动态 light/instance count不产生 miss。
- resize、DPR/render scale、feature topology、capability/format 和 instrumentation recipe 改变各产生一次可解释 miss，随后恢复 hit。
- shadows/SSAO/SSR/TAA/Bloom/Exposure/debug 等命中 feature 关闭时，对应 Pass/resource/history/readback/timestamp label 全部缺席。
- graph cache 不改变 A/B/C 画面与真实 GPU counters。

### R1-C · Compute HZB 与 history contract

#### 算法选择规则

先检查 [GPU-DRIVEN.md](../references/GPU-DRIVEN.md) 已登记项目中的 HZB/Hi-Z/Single-Pass Downsampler 实现。优先移植许可证兼容、已有 GPU 验证且满足 WebGPU baseline 的算法；必须登记上游仓库、commit/tag、源码路径、许可证、保留不变量和 OEngine/WebGPU 差异。没有合适实现时，先记录调查结论，再实现最小自有算法。

候选实现必须通过 WebGPU prototype 后才能进入主链：

- 验证目标 adapter 对 storage texture format 的读写支持，不能假设当前 `rg16float` 可直接转为 storage；
- 验证同一 texture 不同 mip 在同一 Compute Pass 中的 binding/usage 是否合法；
- 若 pass 内 subresource hazard 不合法，选择 ping-pong、多 mip 单 dispatch 或少量分段 Compute Pass；
- 不依赖 64 位原子、mesh shader、MDI 或 buffer device address；
- 禁止以“Compute”名义退化为每 mip 一个 Render Pass。

#### 任务

| ID | 实施内容 | 必须产出 |
|---|---|---|
| `R1-C01` | 上游与设备原型 | 可追溯移植记录；格式/usage/dispatch validation 页面；选型结论与接受的 pass/dispatch 上界 |
| `R1-C02` | CPU reference 与数值测试 | reverse-Z reduce/compare；1×1、8×8、奇数尺寸、全远/全近、边界 texel、NaN/clear policy |
| `R1-C03` | history owner | per-view valid/revision/lastWrittenFrame；previous/current/final；resize/cut/toggle invalidation |
| `R1-C04` | 替换 HZB encode | 直接替换 `HierarchicalZBuffer` 内部 Render pipeline；输出 build、dispatch/pass、pixels 与 GPU phase evidence |
| `R1-C05` | second-chance/alpha 调度 | initial、late visibility、alpha 共享一份 recipe 与明确依赖；根据配置和真实收益裁剪节点 |
| `R1-C06` | 删除旧实现并前后对比 | 删除 `hzb_reduce` Render shader/pipeline/attachments；A/B/C paired JSON 与截图 |

#### 允许的临时状态

GPU prototype 可在独立 example 中与旧实现对照。主链迁移期间可有测试专用双算结果，但 `R1-C` 提交结束时不能长期双轨，也不能暴露两套产品开关。

#### 验收

- CPU reference 与 GPU readback 在固定/奇数尺寸输入一致，遮挡比较无漏绘；
- R0 的 20/30 个 HZB mip Render Pass 归零；每次 build 的 compute pass/dispatch 数不超过 `R1-C01` 冻结上界，且不随 mip 数一比一创建 Render Pass；
- previous history 只读，final history 只在完整深度结束后 commit；camera cut/resize/feature off-on 后首帧不使用无效 history；
- A/B/C `legacy.hzb.*` 迁移为真实 compute counters，不能通过改 counter 名隐藏重复 build；
- 同条件 HZB GPU P50/P95 不劣于 R1-C 入口基线，目标是显著低于旧逐 mip Render 路径；若某 adapter 回退，必须有 WebGPU 合法、画面正确且被记录的 compute fallback。

### R1-D · 删除、生命周期与回归 Gate

#### 任务

| ID | 实施内容 | 必须产出 |
|---|---|---|
| `R1-D01` | feature-off 矩阵 | 每个主管线 feature 的 pass/resource/history/readback/submit/timestamp 断言 |
| `R1-D02` | 生命周期矩阵 | resize、DPR、dynamic resolution、camera cut/switch、view 删除、asset unload/reload、device lost/recovery |
| `R1-D03` | in-flight 资源回收 | compiled graph、texture view、bind group、staging/readback slot 与 transient 在正确 GPU completion 后复用/销毁 |
| `R1-D04` | paired benchmark | clean/full cold + warm Frame Smoke/A/B/C；同机同浏览器同 GPU/尺寸/DPR/feature set；JSON、截图、console |
| `R1-D05` | replace-don't-layer 收口 | 删除 adapter、fallback、旧测试和死 shader；更新 Context、CURRENT-STATE、PERFORMANCE、lesson/ADR |

device lost 若当前浏览器无法可靠自动触发，必须至少完成可注入的 owner 单测和一次人工恢复记录；不能把资源 owner 未定义留作“以后再说”。

## 自动测试设计

Interface 是 R1 的稳定测试面，测试不依赖内部数组或私有 helper 名称。

| 测试面 | 核心断言 |
|---|---|
| `FrameCoordinator` | begin/submit 状态机；一帧一次 submit；double-submit/未关闭 Pass/abort 失败；one-shot 不得嵌套 render frame |
| `GPUSceneContext.encodeFrame` | 同 frame 重入不重复编码；不同 change kind 的 evidence；无 dirty work 零 upload/dispatch |
| submit allowlist | main render 可达路径只有 coordinator；新 `createCommandEncoder/submitGpuCommands` 调用必须分类 |
| readback ring | 非采样零 copy/map；采样 copy进入主 encoder；map旧 slot；pending/drop/error 可收尾 |
| graph key/cache | value equality；动态 bindings不影响 key；resize/toggle miss；destroy/evict；两种 instrumentation recipe 稳定命中 |
| compiled graph | pass pruning、import binding、last-use release、异常 cleanup、dump确定性 |
| feature off | Pass/resource/history/readback/timer/submit label 都不存在 |
| HZB | CPU/GPU pyramid 数值、reverse-Z compare、奇数尺寸、history invalidation、accepted dispatch bound |

## 浏览器验证矩阵

R1 每个纵向包完成时运行命中 example；`R1-D` 再运行完整矩阵。默认使用中等验证，不启动多个 review agent。

| 页面/动作 | R1-A | R1-B | R1-C | R1-D |
|---|---:|---:|---:|---:|
| `r0-frame-smoke` | 必跑 | 必跑 | 必跑 | clean/full paired |
| Benchmark A | smoke | smoke | 必跑并截图 | clean/full paired |
| Benchmark B | smoke | smoke | 必跑并截图 | clean/full paired |
| Benchmark C | 必跑并检查 13→1 | 必跑 | 必跑并检查 30 HZB pass | clean/full paired |
| resize + DPR/render scale | — | 必跑 | 必跑 | 必跑 |
| shadow/alpha/SSAO/SSR/TAA/Bloom toggle | 命中 shadow | 必跑 | 命中 HZB consumers | 必跑 |
| camera cut/switch | — | — | 必跑 | 必跑 |
| device lost/recovery | — | destroy 单测 | history 单测 | 自动或人工记录 |

每次浏览器验证保存：结果 JSON、最终画面截图、console validation/error、GPU/浏览器/分辨率/DPR/feature set、commit 与 dirty reasons。`temp/` 是用户本地 artifact 目录，不纳入 Git commit。

## 量化 Gate

结构正确性是硬门槛，性能数值使用同条件 paired run 判断，不能用 smoke 与 three.js 不同场景直接相除。

| 指标 | R0 smoke 输入 | G1 退出要求 |
|---|---:|---|
| Frame Smoke/A/B steady submit | 3 | warm non-sampled = 1 main submit |
| C steady submit | 13 | warm non-sampled = 1 main submit；shadow view 数不改变 submit |
| collection readback | 每帧 1 | 非采样帧 0；采样 copy不增加 submit |
| scene prepare | C 间接表现为 10 次 animation flush | 每 scene/frame = 1 |
| graph build/compile | 每帧 1/1 | key hit 帧 0/0；execute=1；cacheHit=1 |
| HZB Render Pass | A/B 20，C 30 | 0 个逐 mip HZB Render Pass |
| feature off | 未形成统一证据 | 对应 pass/resource/history/readback/timestamp/submit 全部不存在 |
| queue overflow/diagnostics | A/B/C 为 0 | 继续为 0，counter invariants 继续通过 |

性能 paired gate：

- CPU/GPU P50、P95、P99 都保存，不用单个最快帧；
- CPU frame P95 和非 HZB GPU phase P95 原则上不得回退；小于 5% 的差异需要重复 run 判断噪声，不能直接宣称提升或退化；
- HZB phase 必须与 `R1-C` 入口 clean/full 基线比较，至少不回退，并说明减少的是 pass/dispatch、像素工作还是同步固定成本；
- one-submit 主要预期降低 CPU 固定开销和 queue 调度，不预先承诺虚假的 GPU 百分比；
- 若总帧改善但某 phase 明显退化，仍需定位，不能用总数掩盖局部回归。

## 失败处理与禁止回退

- 单 encoder 暴露 uploader 生命周期冲突：修正 owner、ring 或 completion 状态，不恢复每帧独立 submit。
- graph cache 因动态数据频繁 miss：把非 topology 数据移到 bindings，不扩大 key 吞掉问题。
- compiled graph 暂时无法覆盖 tool/bake：明确保留 one-shot graph，不让它进入 steady main path。
- Compute HZB validation 失败：回到 `R1-C01` 更换 storage 格式、ping-pong 或分段策略；旧逐 mip Render 只可作为短期测试 oracle，不能通过 G1。
- second chance 没有收益：从默认 recipe 裁掉，保留同一主管线中的条件节点和证据，不创建第二套管线。
- 一 submit 后画面错误：先用 graph dump、resource lifetime、history revision 和 GPU counter定位；禁止以恢复旧 submit 作为长期修复。

## 提交切分

R1 默认四个主要实现提交，包内先在工作区完成自动测试和命中浏览器验证，再一次性收口，避免每个 helper 一次提交。必要的算法原型可单独提交，但不得与产品主链长期并存。

建议中文详细 commit：

```text
重构（R1-A）：收口单帧 GPU 命令所有权并删除多提交旁路

- 建立 FrameCoordinator 唯一提交状态机
- 合并 Graphics、Scene、Animation、Shadow 与采样 copy
- 分离每 scene 与 per-view 更新，修复 C 场景重复 flush
- 删除稳定帧自建 encoder 和持续 collection readback
- 补充 submit allowlist、动态场景和浏览器证据
```

后续三个主提交分别以 `重构（R1-B）`、`性能（R1-C）`、`收口（R1-D）` 开头，并在正文列出 interface 变化、删除项、验证命令、浏览器 artifact 和已知限制。

不得提交用户现有的 `three.js` 修改、`examples/yarn.lock` 或 `temp/` artifact。

## 阶段退出清单

- [x] `R1-A01～A07`：一帧唯一提交 owner 与按 dirty 编码完成。
- [ ] `R1-B01～B06`：代码与自动门禁完成；等待 Frame Smoke/A/B/C 浏览器 after smoke 后关闭。
- [ ] `R1-C01～C06`：Compute HZB、history 与旧 Render HZB 删除完成。
- [ ] `R1-D01～D05`：生命周期、paired benchmark、文档和死代码收口完成。
- [ ] `npm test` 通过；命中浏览器示例无 WebGPU validation/console error。
- [ ] Frame Smoke/A/B/C 前后 JSON、截图和环境记录完整。
- [ ] `CURRENT-STATE`、platform/performance Context、`PERFORMANCE.md` 和相关 ADR/lesson 与真实实现一致。

全部完成后 G1 才能关闭，随后进入 R2 Runtime Asset、GPU Render World 与 Cooker。仅把 submit 从 13 降到 1、仅缓存图或仅改 Compute HZB 都不单独等于 R1 完成。
