---
id: reviews/eengine-source-truth-audit-2026-10-05
state: history
---
# EEngine 源码真值审计报告

- 审计对象：`D:\code\EEngine`，`OEngine/src`（581 个 `.ts`，132,841 行；WGSL 全部以 TS 字符串生成器存在，无独立 `.wgsl`）
- 基线 revision：`09449d6d`（2026-10-05 14:01，工作区 clean）
- 审计方式：**只读源码逐行核对 + 静态计数 + 结构成本推导**
- 审计约束（用户指定）：**未运行任何代码、测试、构建、benchmark、浏览器宿主；未修改、未新增、未删除任何既有文件**。本报告是本次审计唯一新增的文件。
- 结论口径：`源码事实` / `源码推导`（可由源码公式算出但依赖未在本机确认的运行时参数）/ `推断`（明确标注）三类严格区分。

---

## 0. 审计方法与可信度边界（必须先读）

### 0.1 本次审计**没有**做的事

| 事项 | 状态 | 影响 |
|---|---|---|
| 运行渲染器 / benchmark | **未运行** | 报告不含任何实测 ms、FPS、P50/P95。所有"性能账"是结构账本与工作量核算，不是测量值 |
| 运行 typecheck / test / build | **未运行** | "类型是否通过"不在本次结论内 |
| GPU timestamp / counter 读取 | **未运行** | pass 级 GPU 耗时归属为**推断**，标注依据 |
| 修改任何源码或文档 | **未做** | 本报告是唯一新增文件 |
| 读取设计/Phase/进度文档作为事实 | **仅用于反查矛盾** | 见 §12.4、§14.4 的"文档失真"清单 |

### 0.2 因此，哪些结论是**硬的**，哪些是**待测的**

**硬结论（纯源码可证，不依赖运行时参数）**

1. Surface 链在 FrameGraph 上按"批次"整体复制：每个批次都重新发射完整生产链（`SurfaceCellClassifierPass.ts:230-372` + `SurfaceWorkRuntime.ts:197-253`）。
2. `batchCount = ceil(tileCount / batchTileCapacity)`，而 `batchTileCapacity` 由 512 MiB envelope 反推（`SurfaceOptimizationCapacity.ts:102-240`），与场景复杂度无关，只与像素数有关。
3. FrameGraph 执行器对每个 pass 都做一次全资源表扫描（`FrameGraph.ts:927-932`），复杂度 O(passes × resources)。
4. 每个 FrameGraph node = 一次真实的 `beginComputePass/end`，**没有任何 pass 合并**（`FrameGraph.ts:899-933`）。
5. classify kernel 的 21 平面固定树在 **plane 循环内部**重建（`surface_cell_classify.ts:134-286`），每个 plane 都重新走 3 层归约。
6. 默认配置下 FSR3 / Bloom / XeGTAO / VSM 全链每帧无条件执行，且 `renderScale = 1` 时 FSR3 在 1:1 分辨率上跑完整 upscaler（`RendererCore.ts:359-360`，`Fsr3UpscalerRuntime.ts:213-307`）。
7. 集群 fallback 路径在每个 shading sample 上遍历全 active light list（`SurfaceLightingWorkPass.ts:200-217`）。
8. 73 个 `.ts` 文件（14,710 行）无人 import（其中约 8 个是合法入口 barrel/worker）。
9. 同一 ABI 结构体在多处独立定义（`LightList` ×4、`OEngineDrawIndirectArgs` ×4、VSM page record ×6、`AppearanceRoute` ×3、28 个重名 WGSL struct），且**没有任何生成器断言 TS↔WGSL 的 size/stride/offset 一致**（§12.6）。

**待测结论（源码可证形状，数值需实机）**

- 具体 `batchTileCapacity` / `batchCount`：取决于 `maxBufferSize`、`maxStorageBufferBindingSize`。本报告用 Chromium 桌面常见值（`maxBufferSize = 256 MiB`、`maxStorageBufferBindingSize = 128 MiB`）推导出 **≈707 tiles / batch，≈46 batches @1080p**（附录 A 给出完整推导，可被任何一次 `capacityEvidence()` 打印证伪）。
- 各 pass 的真实 GPU 时间占比。
- barrier 的真实代价（取决于 occupancy 与 SM 数量）。

---

## 1. 当前真实架构（源码事实）

### 1.1 所有权拓扑（按 import 方向实证）

```
core / math / scene / camera / light / geometry / material / texture      (CPU 领域)
        ↓
loaders / assets / assets:codec / assets:web-cook / assets:geometry-product
        ↓
gpu/*                    GPU Render World、table、allocator、residency
        ↓
framegraph/*             Pass 依赖、资源生命周期、命令编码编排
        ↓
render/* + shaders/*     管线与 Pass 编排、WGSL 生成器
        ↓
render/pipeline/RendererCore.ts   composition root（1841 行的 God class）
```

依赖方向本身没有明显越界：`render/passes/*` 不 import `scene/*` 的 Application World 写接口，Loader 不持有长期 GPU owner（`GpuAssetStore` 由 `gpu` 拥有）。**但 `RendererCore` 已经不是"composition root"，它是 1841 行的编排+状态+恢复+诊断混合体**（§12.1）。

### 1.2 一帧的装配方式：FrameProgram（语义）+ FrameProgramLowering（拓扑）

- `FrameProgram.ts` 把"这一帧需要哪些 product / stage / binding role"表达成一个 **20 字段的 key**（`FrameProgram.ts:282-295`）：`outputWidth/Height/Format`、`internalWidth/Height`、`capabilityProfile`、`virtualGeometry(+bankCount)`、`previousHzb`、`currentHzbLateRecheck`、`activeSets`、`textureBankMask`、`hasLit`、`aoProfile`、`shadowProfile`、`physicalEnvironment`、`authoredEnvironment`、`fsr3Enabled`、`bloomEnabled`、`debugView`。
- `FrameProgramLowering.ts` 把这个语义计划 lower 成一个 `FrameGraph`（`lowerFrameProgram`）。
- `CompiledFrameGraphCache(8)` 与 `FrameProgramCache(8)` 缓存编译结果（`RendererCore.ts:348-349`），key 带 `surface-diagnostics` 模式（`RendererCore.ts:1576`）。

**关键结构事实**：`activeSets` / `textureBankMask` 是**每帧**从 `runtime.activeShadingSummary.binRefCounts` 现算的（`RendererCore.ts:1395-1402`），并且它们进入 program key。因此流式加载/材质变化会改变 key → 触发重新 lower（含 `createCompiledDump()`，O(resources × passes)）。容量只有 8，现实场景下会 thrash。

### 1.3 一帧的真实执行主体：**Surface 批次链**

`FrameProgramLowering.compileSceneGraph()` 里最重的一段是 `owners.surfaceWork.addToGraph(...)`（`FrameProgramLowering.ts:393-457`）。它内部：

```
SurfaceWorkRuntime.addToGraph()
  ├─ SurfaceDependencyEpochPass  ×4 节点（每帧一次）
  └─ SurfaceCellClassifierPass.addToGraph()
        └─ for (batch = 0 .. batchCount-1)              ← 关键循环
              ├─ batch workspace reset（4× clearBuffer）
              ├─ coverage addRange（1 pass + 1 copy）
              ├─ SurfaceCellGeometrySetup ×6 stages
              ├─ facts / addresses（各 1 pass）
              ├─ field lookup ×5（4 stage + 1 copy）
              ├─ proof tiles（2 pass + 1 copy）
              ├─ certificates ×7（1 geometry + 3 family × 2）
              ├─ classify ×2（planes 0-14 / 15-20）
              ├─ signal witnesses ×1
              ├─ signal lookup ×1
              └─ consumeBatch()                          ← 又发一条完整消费链
                    ├─ SurfaceDemandPass ×11 stages + 2 copies
                    ├─ SurfaceGeometryPass ×1
                    ├─ Appearance material fields ×P（每个已发布 material program 一个 pass）
                    ├─ FieldStore publish ×3
                    ├─ SurfaceLighting ×1
                    ├─ SignalStore publish ×3
                    └─ SurfaceReconstruction ×1
```

**这条链的每一层都被 `batchCount` 乘了一次。** 这是本工程当前性能形态的第一原因，也是 §7 的核心。

---

## 2. 一帧真实执行流程

### 2.1 CPU 帧入口（真实调用链）

```
Renderer.render(camera, scene, dt)                        RendererCore.ts:1310
├─ FrameCoordinator.canBeginFrame（in-flight ≤ 2 背压）    FrameCoordinator.ts:32-34
├─ SurfaceWorkRuntime.canPrepareFrame                      RendererCore.ts:1315
├─ Profiler.beginFrame + FrameCoordinator.beginFrame       RendererCore.ts:1343-1344
├─ 单 CommandEncoder 建立（全帧唯一）                      ShadeGPUCommandContext.ts:165
├─ scene-prepare：radiometry/temporal/hzb/surface/fsr3 prepare  RendererCore.ts:1355-1500
├─ ViewContext.obtain + view.update                        RendererCore.ts:1410-1427
├─ FrameProgramCache.getOrCreate(20 字段 key)              RendererCore.ts:1556-1574
├─ CompiledFrameGraphCache.getOrCreate(graphKey)           RendererCore.ts:1577-1585
├─ command.encodeCompiledGraph(compiled, bindings)         RendererCore.ts:1593
│     └─ FrameGraph.executeCompiled：逐 pass 执行 + 逐 pass 全表扫描
├─ view.finish_frame + FrameCoordinator.submitFrame（单次 submit）  RendererCore.ts:1608-1610
└─ commit：fsr3 / surfaceWork / radiometry / temporal / environment / streaming
```

**同步边界**：全帧只有 1 个 `GPUCommandEncoder`、1 次 `queue.submit`（`FrameCoordinator.ts:64-88`，`ShadeGPUCommandContext.finish`）。`gpuDone` 只是 `onSubmittedWorkDone()` 的 Promise，用于资源退休；**没有任何本帧 GPU→CPU→GPU 的可见性回读**，符合红线要求。

### 2.2 非 Surface 阶段（每帧一次）

| 阶段 | FG 节点 | 计算 pass | 渲染 pass | dispatch | draw | copy | clear | 关键事实 |
|---|---|---|---|---|---|---|---|---|
| Hierarchical Work Gen（R3-B/D） | 1（side-effect） | 1 root + (roundCount-1) traversal + 1 dispatchPrep + 1 expansion | — | 4+ | — | roundCount 次 evidence copy | 2 queue ×2 + 3 args + drawIndirect 4B + pageDemand 全量 mask | `HierarchicalWorkGenerator.ts:938-1026`；`roundCount = maxHierarchyDepth+1`（CPU 决定） |
| MeshletWork bucket producer | 并入上节点 | ×2（portable/subgroup 路径共 9 个 entry 的 4 次 indirect） | — | 4 | — | — | — | `MeshletWorkCandidate.ts:341-349` |
| RasterWorkPartitions | 并入 | 4 | — | 4 | — | — | — | `RasterWorkPartitions.ts:128-135` |
| 几何硬件光栅 | 并入 | — | 1 | — | `programs×2×(product?1:4)` 次 `drawIndirect` | — | — | `MeshletBucketRaster.ts:151-159`；`programs = publishedRasterPrograms()` |
| HZB build | 1 | 1（内含 mipCount 次 dispatch） | — | 10 @1080p | — | — | — | `FrameProgramLowering.ts:554-560`，半分辨率 960×540，10 mip |
| Late recheck | 0（默认关） | 3 + 第二次完整几何光栅 | 1 | 3 | 同上 | — | — | `RendererCore.ts:363` 默认 false；开启后是**第二遍完整可见性** |
| Visibility counters | 1 | 1 | — | 1 | — | — | — | `VisibilityCounterPass.ts:128` |
| LightCluster | 4 | 5 | — | 5 | — | 2 | 4 | `LightClusterPass.ts:293/352/413/499` |
| VSM | ~10 | 5 | 1（4096² depth load/store） | 5 | 1 + `programs×2` | — | 7 | `FrameProgramLowering.ts:137-292` |
| XeGTAO | 8 | 8（全分辨率） | — | 8 | — | — | — | `FrameProgramLowering.ts:317-341` |
| Radiometry（Surface 拥有） | 1 | 1 | — | 1 | — | — | — | `SurfaceCellClassifierPass.ts:177` |
| TemporalFacts | 1 | 1 | — | 1 | — | — | — | `TemporalFactsPass.ts:130-170` |
| Physical Sky | 1 | — | 1 | — | 1（fullscreen） | — | — | `PhysicalSkyPass.ts:69` |
| Aerial Perspective | 1 | 1（全分辨率逐像素） | — | 1 | — | — | — | `AerialPerspectivePass.ts:69` |
| FSR3 | 32 | 31 | 1（clear） | 32 | — | — | 1 | `Fsr3UpscalerRuntime.ts:233-307` |
| Radiometry post | 2 | 2 | — | 2 | — | — | — | `GpuRadiometryPass.ts:186/202` |
| Bloom | 10 | 10 | — | 10 | — | — | — | `BloomPass.ts:148-169` |
| Debug view | 0（默认 None） | — | — | — | — | — | — | `FrameProgram.ts:380-381` |
| Present | 1 | — | 1 | — | 1（`draw(3)`） | — | — | `SurfacePresentPass.ts:178-186` |

小计（默认配置，1080p）：**约 88 个 pass、~90 次 dispatch、约 10–40 次 drawIndirect、roundCount+2 次 copy、约 14 次 clear**。

### 2.3 Surface 批次链的每批次构成（逐节点，源码枚举）

下表是**一个批次**的节点与命令数（源码逐行核对，`SurfaceCellClassifierPass.ts` / `SurfaceWorkRuntime.ts` / `SurfaceDemandPass.ts` / `SurfaceCellGeometrySetup.ts` / `SurfaceFieldLookupPass.ts` / `SurfaceStorePublishPass.ts` / `SurfaceReconstructionPass.ts`）：

| # | FG 节点 | 计算 pass | dispatch 形态 | copy | clear | writeBuffer |
|---|---|---|---|---|---|---|
| 1 | `Surface/cell batch N workspace reset` | 0 | — | — | 4 | 1×32B |
| 2 | `Surface/publish actual active range` | 1 | `ceil(capacity/64)` | — | — | 1×16B |
| 3 | `Surface/active indirect publication` | 0 | — | 1×16B | — | — |
| 4 | `SurfaceGeometry/reset_cell_geometry` | 1 | `ceil(referenceCapacity/64)` | — | — | 1×80B |
| 5 | `request_cell_geometry` | 1 | indirect | — | — | — |
| 6 | `finalize_cell_geometry` | 1 | `dispatchWorkgroups(1)` | — | — | — |
| 7 | `build_cell_geometry` | 1 | indirect | — | — | — |
| 8 | `publish_cell_geometry_memo` | 1 | indirect | — | — | — |
| 9 | `commit_cell_geometry_memo` | 1 | indirect | — | — | — |
| 10 | `Surface/cell publish geometry and lighting facts batch N` | 1 | indirect | — | — | — |
| 11 | `Surface/canonical field addresses batch N` | 1 | indirect | — | — | — |
| 12 | `lookup_surface_fields` | 1 | indirect | — | — | 1×48B |
| 13 | `finalize_field_support` | 1 | `dispatchWorkgroups(1)` | — | — | — |
| 14 | `Field support publish indirect` | 0 | — | 1×16B | — | — |
| 15 | `validate_field_support` | 1 | indirect | — | — | — |
| 16 | `commit_field_support` | 1 | indirect | — | — | — |
| 17 | `Surface/actual proof family tiles batch N` | 2 | 1 indirect + 1 `(1,)` | 1×112B | — | — |
| 18 | `Surface/shared …certificates batch N` ×7 | 7 | indirect（`queue*16` 偏移） | — | — | — |
| 19 | `Surface/cell classify continuity domains {0,1} batch N` | 2 | indirect | — | — | — |
| 20 | `Surface/admitted signal witnesses batch N` | 1 | indirect | — | — | — |
| 21 | `Surface/kind-specific signal value lookup` | 1 | indirect | — | — | — |
| 22 | `Surface/actual demand reset` | 0 | — | — | 2 | 1×96B |
| 23 | `Surface/<11 demand stages>` | 11 | 3 个 `(1,)` + 8 indirect | — | — | — |
| 24 | `Surface/publish actual indirect arguments` ×2 | 0 | — | 2 | — | — |
| 25 | `Surface/unique GeometryRecord` | 1 | indirect（word 32） | — | — | — |
| 26 | `Surface/unique missing Appearance fields` | P（= 已发布 material program 数） | indirect | — | — | 若干 |
| 27 | `Surface/Store admission settings`（field） | 0 | — | — | — | 1×64B |
| 28 | `Surface/field Store {0,1,2}` | 3 | indirect（word 12/12/20） | — | — | — |
| 29 | `Surface/unique dirty Lighting` | 1 | indirect（word 128） | — | — | 2（32B+16B） |
| 30 | `Surface/Store admission settings`（signal） | 0 | — | — | — | 1×64B |
| 31 | `Surface/signal Store {0,1,2}` | 3 | indirect（word 16/16/24） | — | — | — |
| 32 | `Surface/cheap batched reconstruct` | 1（首批次 +1 背景全屏） | indirect（targets/64,1,1） | — | — | 1×48B |
| 33 | `Surface/cell batch N consumed` | 0 | — | — | — | — |
| | **合计（P=1）** | **48** | 见右 | **5** | **6** | **~13** |

**每批次约 48 个 compute pass、5 次 `copyBufferToBuffer`、6 次 `clearBuffer`、~13 次 uniform staging write。**

### 2.4 一帧总量核算（1080p，renderScale=1，VSM+AO+FSR3+Bloom 开，无 debug view）

| 指标 | 数值 | 推导 |
|---|---|---|
| FrameGraph node | **≈ 2,700** | 46 × 56（批次节点数：§2.3 表 33 行展开 certificate×7、classify×2、demand×11、Store×3+3、copy×2）+ ~120（固定） |
| Compute pass | **≈ 2,300** | 46 × 48 + ~88 |
| Render pass | **4 ~ 5** | 几何光栅 1 + VSM atlas 1 + Sky 1 + Present 1（+ FSR3 reactivity clear 1） |
| dispatch | **≈ 2,400** | 与 pass 近似 1:1（每 pass 1 次 dispatch，个别 2 次） |
| draw / drawIndirect | **约 10 ~ 40**（普通场景） | 几何 `programs×2×4`；VSM `1 + programs×2`；Sky 1；Present 1 |
| copyBufferToBuffer | **≈ 245** | 46 × 5 + 固定 ~15 |
| clearBuffer | **≈ 290** | 46 × 6 + 固定 ~14 |
| BindGroup 请求（Surface scratch 路径） | **≈ 6,000 ~ 9,000** | 每 pass 2–4 次 `obtainBindGroup`；另有 ~46 次绕过缓存直接 `createBindGroup` |
| Pipeline 切换 | **≈ 2,400 + 光栅切换** | 每 pass 至少 1 次 `setPipeline`；光栅按 `programs×2×sizes` 再切 |
| GPU timestamp | **0（默认）** | `FrameProfiler.enabled = false`；开启后每 pass 2 个 → ~4,800 个/帧，超出单页 1024 pass 容量（需 3 页） |
| uniform staging write | **≈ 600+** | 每次 `writeBuffer` = 1 次 staging 分配 + `queue.writeBuffer` + 1 次 `copyBufferToBuffer`（`ShadeGPUCommandContext.ts:438-450`） |

**同一帧在 4K（3840×2160）下**：`tileCount = 129,600` → `batchCount ≈ 184` → **≈ 9,000 compute pass / 帧**。envelope 是分辨率无关的常数，而 tile 数随像素线性增长，所以 **pass 数随分辨率线性膨胀**。

> 这直接回答"一帧有多少 pass"：**当前生产路径的一帧不是几十个 pass，而是两千个以上**，其中 96% 是同一个 Surface 链被 envelope 切了 46 遍。

---

## 3. 架构有没有"越优化越复杂"

**有，而且已经形成了教科书式的模式。** 工程里存在完整的三轮"补丁式复杂化"链条，每一轮都留下永久层：

### 3.1 链条一：正确性压力 → certificate / proof / witness 三层中间表示

```
最初问题：Sparse surface 如何证明"这一格可以用粗粒度"？
→ 加 CellTree（21 平面固定树）                      surface_cell_classify.ts
→ 树需要"证据"，加 certificate 家族（3 家族 × 2 参数化）  SurfaceCellClassifierPass.ts:133-142
→ 证书需要"排队"，加 proof_requests + 7 路独立 indirect   GpuSurfaceProofAbi.ts / :288-317
→ 每个 proof 需要"依赖"，加 dependency epoch（15 字段 ×4 stage）  SurfaceDependencyEpochPass.ts:61
→ 树节点需要"记忆"，加 domain cache + provider cache（workgroup 内）  surface_cell_classify.ts:131,173
→ 字段需要"边界"，加 AppearanceBound4 区间算术 + residual/scale/flags  surface_cell_group_validation.ts:38-123
→ 最终：为了"少算"，每帧多算了 7 个 certificate dispatch × 46 批次 = 322 个 pass
```

### 3.2 链条二：缓存收益论证 → 巨型 key + 巨型 entry

```
原问题：material/field 求值贵
→ 加 FieldStore（key 32 words=128B，entry 256B，value 16B）   GpuSurfaceFieldStoreAbi.ts:6-23
→ 命中需要"精确相等"，于是每次比较都重新生成 key word       surface_field_request.ts:49-86
→ 加 SignalStore（key 72 words=288B，entry 352B，value 16B） GpuSurfaceSignalStoreAbi.ts:5-21
→ 加 4-way probe + 全量 equality + CAS 发布
→ 加 namespace/generation/epoch/touched 四套生命周期计数器
→ 最终：**缓存命中路径的成本已经接近甚至超过直接重算**（§8.5）
```

### 3.3 链条三：容量预算 → 批次 → 每批次重复整链

```
原问题：不能对全屏 100% 预留
→ 加 512 MiB envelope + 13 项 BUDGET_MIB                   SurfaceOptimizationCapacity.ts:13-19
→ 加"每批次必须自洽"约束（workspace/setup/demand/publish 都按 batch 分配）
→ 加"退休重叠"双倍记账（retiredOverlapBytes = scratchTotalBytes）  :222-224
→ 加 batchTiles 逐格递减搜索（while(batchTiles>0){...batchTiles--}）  :160-171
→ 最终：batchTiles 被压到 ≈707，batchCount 膨胀到 ≈46，
        每条链被复制 46 次（pass 数、clear 数、copy 数、bind group 数同步 ×46）
```

### 3.4 判断

> **系统为了管理"优化"而付出的成本，已经超过了被优化的原始计算成本。**

具体证据（可量化）：
- FieldStore 存 16B 需要 ~60 次 atomic store + ~30 次 load（key:value = 8:1）（§8.5）。
- 为了"少算精细 shading"，每帧多发射 **~2,200 个 pass** 和 **~46 MB 级 clear**。
- 为了"低成本 publish"，`SurfaceDependencyEpochPass` 每帧对 `directoryCount × 15` 做 4 趟全量 pass，与可见性无关。
- 为了"保持正确"，`SurfaceCellClassifierPass.ts:307` 把 `previous` 从 `addresses` 重接，导致 proof-tile 阶段脱离依赖链，正确性只剩 WAW 边兜底（脆弱，且说明链条本身已经失控）。

---

## 4. GPU-Driven 是真的吗

**结论：GPU-Driven 只做了一半——"谁被看见"在 GPU，"多少工作被编码"仍在 CPU，并且因为批次化，CPU 侧的固定成本被放大 46 倍。**

### 4.1 真实 GPU-Driven 的部分（做得好）

| 机制 | 证据 |
|---|---|
| 分层遍历的 round 数由 GPU 用 `hierarchy_update_dispatch` 的 atomicMax 产出 | `HierarchicalWorkGenerator.ts:1005` |
| RasterWork 展开的 dispatch 参数由 GPU `r3_prepare_raster_dispatch` 写 | `:1016-1023` |
| MeshletWork 4 路 indirect 由 `prepare_*_dispatch` 写 | `MeshletWorkCandidate.ts:342-348` |
| 光栅 draw 参数由 GPU `prefix` 写（64 bucket × 16B） | `MeshletBucketRaster.ts:157` |
| Surface 各阶段用 `dispatchWorkgroupsIndirect` + GPU 发布的 `activeIndirect`/`demand.indirect` | 全链 20+ 处 |
| **间接参数从不由 CPU 每帧写入**（只在 prepare 时初始化，CPU 只做 12B clear） | `HierarchicalWorkGenerator.ts:1344` |

### 4.2 退化的部分（CPU 仍然知道并编码了太多）

| 退化形态 | 证据 | 影响 |
|---|---|---|
| **批次是 CPU 固定展开**：46 个批次，每批 48 个 pass，全部由 CPU 静态编码 | `SurfaceCellClassifierPass.ts:230` | ~2,300 pass/帧的 CPU 编码 + 每 pass 全表扫描 |
| **按 capacity 形状 dispatch，而不是按实际工作量**：`dispatchWorkgroups(visibleClusterCapacity)`（虚几何 candidate）、root pass 按实例容量、`reset_cell_geometry` 按 `referenceCapacity`（100% 预留）、coverage scan 全屏 `tiles` | `MeshletWorkCandidate.ts:726`、`HierarchicalWorkGenerator.ts:978`、`SurfaceCellGeometrySetup.ts:126`、`SurfaceCoveragePass.ts:41` | 逻辑 sparse、物理 dense |
| **无工作的 pass 仍然存在并编码**：`dispatchWorkgroups(1)` 的 5 个 finalize 节点 ×46 批次 = 230 个 1-workgroup pass | `SurfaceCellGeometrySetup.ts:126`、`SurfaceFieldLookupPass.ts:105`、`SurfaceDemandPass.ts:145`、`SurfaceCellClassifierPass.ts:299` | 每次 ~微秒级 GPU，但 CPU 编码 + pass 边界不受益 |
| **CPU 仍持有 GPU workload 的容量与拓扑知识**：`roundCount`、batch 划分、certificate 家族数、proof queue 数 7、classify stage 划分（15+6 平面） | `HierarchicalWorkGenerator.ts:478`、`SurfaceOptimizationCapacity.ts`、`surface_cell_group_validation.ts:1-10` | 工作集变化无法在 GPU 侧自适应 |
| **SSE 阈值硬编码 4，且没有运行时工作预算进入 shader**：`GeometryAdaptiveSseController` 从未被实例化 | `RendererCore.ts:351`、`GeometryWorkBudget.ts:67` | 近景几何爆炸只能靠 capacity 溢出兜底（父节点回退/静默丢弃） |

### 4.3 判断

> 当前不是"GPU-Driven Execution Model"，而是 **"GPU-Decided Visibility + CPU-Encoded Batched Shading"**。
> `dispatchWorkgroupsIndirect()` 存在且正确，但它控制的是 shader invocation，**没有减少调度总量**：CPU 依然为每一批次发射完整 pass 序列，GPU 侧仍是"capacity 形状的网格 + 提前返回"。

---

## 5. FrameGraph 审计

### 5.1 真实机制（源码事实）

| 项 | 实现 | 位置 |
|---|---|---|
| Pass 声明 | `graph.add(name, data, execute)` → `PassNode`，id 按声明序 | `FrameGraph.ts:705-721` |
| 资源版本 | `write()` 非自创资源会 `clone_resource` 递增 `resource_version`，WAR/WAW 变成不同版本的 producer 边 | `:294-305`、`:681-697` |
| 编译 | `compile()`：清 refcount → 校验多生产者 → **按引用计数反向剔除死 pass** → 校验 domain → Kahn 拓扑排序 | `:728-842` |
| 缓存 | `if (this.__compiled !== null) return this.__compiled`；外层 `CompiledFrameGraphCache(8)` | `:729`、`CompiledFrameGraphCache.ts:19-45` |
| 资源生命周期 | `entry.producer` / `entry.last` 在**执行序**上标注，`last === pass` 时立即释放 | `:821-834`、`:927-932` |
| 透明资源复用 | 按 descriptor 匹配的池（buffer 按 size+usage；texture 按全字段精确匹配），**没有生命周期 alias** | `:438-538` |
| WebGPU 同步 | **没有任何 barrier/transition 抽象**。同步完全依赖：pass 顺序 + `loadOp/storeOp` + usage flags + `ensure_cleared`（实现为真 `clearBuffer`） | `:446-466`、各 pass descriptor |
| 执行 | 每条 pass 独立 `beginComputePass/beginRenderPass` + `end()`；**无 pass 合并、无 bundle、无 encoder 复用** | `:899-933` |

### 5.2 三个真实的 FrameGraph 层面缺陷

**缺陷 1：O(passes × resources) 的每帧扫描（CPU）**

```ts
for (const pass of this.__execution_order) {          // ~2,300
  ...
  for (const entry of this.__resource_registry) {      // ~2,000+
    if (entry.last === pass && isTransientEntry(entry)) { rm.release(entry.resource); entry.resource = null; }
  }
}
```
`FrameGraph.ts:899-933`。每帧 ~2,300 × ~2,000 ≈ **4.6M 次属性比较**。这是纯 CPU 开销，随批次线性增长。（资源数的推导见附录 A.3；用 `mainFrameGraphEvidence()` 可直接证实。）

**缺陷 2：每条 pass 一个真实 pass 边界**

Surface 每批次的 5 个 finalize/1-workgroup 节点、11 个 demand stage、7 个 certificate、2 个 classify —— 这些都是"换 pipeline 就结束 pass"的形态。它们**之间确有真实依赖**（同 buffer 的读写序），但依赖只要求**命令顺序**，不要求 pass 边界：
- 同一 storage buffer 的写读在 WebGPU 内由 dispatch 顺序保证（storage buffer 无 layout transition）。
- 只有 texture 的 storage↔sampled 切换、render attachment 的 load/store、`copyBufferToBuffer` 与 dispatch 的配对才需要真边界。

**审计结论：**
- **必须分开**：所有 texture 作为 storage 写入 → 后续作为 sampled/textureLoad 读取（Surface radiance / reactiveMask / visibility key / HZB / VSM atlas / FSR3 的历史纹理）；VSM atlas 的 render pass（load/store depth）；`clearBuffer`→读取的批次 reset；`copyBufferToBuffer` 的间接参数发布；FSR3 reactivity 的 render clear。
- **可以同 compute pass**：Surface demand 的 11 个 stage 中，写读同一 arena 且都是 storage buffer 的相邻阶段（`emit→finalize`、`nominate→resolve`、`compact→finalize`、`order`）；3 个 certificate 家族；`Surface/field Store {0,1,2}`；`Surface/{signal} Store {0,1,2}`；field lookup 的 `validate→commit`。至少 **18 个 pass/批次**可以合并，≈ 830 pass/帧。
- **可以 shader 合并**：`coverage scan` 与 `active range`（同一 workspace，不同 workgroup 形状）、`facts` 与 `addresses`（同一 lane 数据）、`finalize_*` 三个 1-workgroup 节点（可做成一个 flag 驱动的收尾 dispatch）。
- **可以 indirect chain 化**：所有 `dispatchWorkgroups(1)` 的 finalize 节点可以由前一个 kernel 的最后一个 workgroup 直接写下一级 indirect 参数，去掉 CPU 侧节点。
- **反而应当拆开**：无。当前没有发现"为了性能被错误合并"的节点。

**缺陷 3：graph key 包含每帧现算的字段**

`activeSets` / `textureBankMask` 进入 program key（`RendererCore.ts:1395-1402`、`FrameProgram.ts:290`），容量 8。真实场景下（流式加载 + 多个 debug view + AO/shadow profile 组合）必然 thrash；每次 miss 都要 `lowerFrameProgram` + `createCompiledDump()`（后者本身 O(resources × passes)，`FrameGraph.ts:1108-1115`）。

### 5.3 FrameGraph 层面正确的部分

- pass 死代码剔除、多生产者保护、domain 校验、拓扑排序都实现了，且有测试入口（`listExecutablePasses`、`exportToJson`、`exportToDot`）。
- 资源池复用避免了每帧 create/destroy（`availableBuffers`/`availableTextures`）。
- 每帧单 encoder/单 submit 的红线保持。

---

## 6. 资源与内存架构

### 6.1 主要驻留资源（源码常量）

| 资源 | stride / entry | 容量来源 | 默认保留 | 实际使用 |
|---|---|---|---|---|
| `Surface/FieldStore` | **256 B**（64 w，4-way） | 128 MiB − 8 MiB 依赖 | **120 MiB 常驻** | 命中率未知；value 只有 16 B |
| `Surface/SignalStore` | **352 B**（88 w，4-way） | 64 MiB | **64 MiB 常驻** | value 16 B；key 288 B |
| `Surface/local texture variation` | 8 w + bounds | min(32 MiB, binding) | 32 MiB | — |
| Surface schema scratch（workspace+setup+arenas） | per-tile 45,792 B + setup 32,768 B/tile | envelope 反推 | ~120 MiB ×2（活跃+退休） | — |
| Geometry Product banks | 4 × 128 MiB (Portable) | `GEOMETRY_PRODUCT_GPU_CAPACITY_LIMIT` 512 MiB | **512 MiB** | 页面级 |
| GpuAssetStore 实体 + `asset-metadata`/`vertex-payload` 堆 | 240/128/128 B 等 | cursor 增长 | **同一份几何存两遍**（+ 退休期第三遍） | — |
| GpuScene instances | **176 B** | 实例数 | 776k 实例 ≈ 136 MB | — |
| GpuMaterialStore | **592 B** + 10×64 B route | 8192（= 2×4096 最坏预留） | 9.63 MiB | — |
| Frame geometry arena | 顶点 1M×16B、三角 1M×4B、字典 256K×8B、系数 128K×48B | owner cap 256 MiB | ≈40 MiB/arena | — |
| VSM atlas | depth32float 4096² | profile | **67 MiB**，且每帧 load+store | 只有脏页变化 |
| Cluster data | 12.7 MB transient | grid 60×34×24 | 每帧新建 | — |

**预声明预算合计 ≈ 2.6–3.1 GiB**（Surface 736 MiB + Geometry Product 512 MiB + metadata 256 MiB + AssetStore 512 MiB + 双份 sparse heap + texture banks 42.6 MiB + variation 32 MiB + material 9.6 MiB + DB 上限），而目标机是 **GTX 1650 Ti / 4 GB**。这是"为了性能把预算做大 → 预算反过来限制批大小 → 批次数膨胀 → 性能更差"的闭环。

### 6.2 ABI 宽度问题（实测字段级）

| 记录 | stride | 死宽 / 空洞 |
|---|---|---|
| `OEngineInstanceRecord` | 176 B | 静态 64 + 动态 112 |
| `GpuGeometryRecord` | 240 B | 尾部 4 B pad |
| `GpuClusterRecord` | 128 B | 36–47 的 12 B 空洞 |
| `GpuMeshletRecord` | 128 B | 120–127 的 8 B 空洞 |
| `OEngineMaterialVisibilityRecord` | 272 B | 尾 4 B pad；`reserved0` 无 shader 读 |
| `OEngineClosureMaterialRecord` | 272 B | 5×4 B `_pad` 死宽；与 route 5..9 重复编码同一组 texture 信息 |
| `OEngineShadingMaterialRecord` | 592 B | `_temporal_pad1/2` 8 B 死宽 |
| `SurfaceGeometryRecord` | 128 B hot + 528 B cold 预留/target | `identity.yzw`、`metrics.zw`、cold 只在冷路径读 |
| `SurfaceSignalStore` entry | 352 B | 81–87 共 **28 B 未使用**；key 72 w 中 64 w 只服务 hash+equality |
| `SurfaceFieldStore` entry | 256 B | 60–63 共 **16 B 未使用** |
| address tuple | 96 B/lane | + uv_witness 72 B + signal_witness 48 B = **216 B/target**（文档写 96 B） |

**同址重复存储**：
1. 几何：`GpuAssetStore` 分表 + `asset-metadata`/`vertex-payload` 堆（`GpuAssetStore.ts:1142-1176` 两条 copy 链证明两份同时存在，退休期三份）。
2. 材质 texture 引用：visibility record 一份 + 10 条 route 一份 + closure role 五条第三份。
3. `display-color` product 声明了 producer `present`，但没有任何 pass 产出该资源（`FrameProgram.ts:94-95`）。

### 6.3 内存层的真实缺陷

- `GPUBufferAllocator.destroy()` / `GPUTextureAllocator.destroy()` **不销毁 `pending`**（`GPUBufferAllocator.ts:162-173`、`GPUTextureAllocator.ts:136-141`）→ 等待 `reuseAfter` 的 buffer 泄漏。
- `GPUBufferAllocator.ageRecent` 用 `insertSorted` 维持有序，但 `destroyOldestAged` 按任意下标 splice（`:218` vs `:254`），破坏 `lowerBound`（`:195-316`）依赖的顺序 → 可复用 buffer 被漏掉。
- 回收 buffer **不清零**（除显式 `ensure_cleared`），shader 读到上一帧脏数据（`:90-98`）。
- `SurfaceFieldStore.reset()` / `SurfaceSignalStore.reset()` 在 CPU 上分配 120 MiB / 64 MiB 的零 `ArrayBuffer` 再 `writeBuffer`（`GpuSurfaceFieldStore.ts:118`、`GpuSurfaceSignalStore.ts:83`），而同类里已经有 `clearBuffer` 用法。
- `GPUTextureAllocator` 的内存证据只统计 cache+pending，不统计 active → 显存账目系统性偏低。

---

## 7. Batch / Capacity 模型（本工程最大的单一结构问题）

### 7.1 全工程容量/批次常量总表

| 常量 | 值 | 为什么存在 | 判定 |
|---|---|---|---|
| `SURFACE_OPTIMIZATION_DEFAULT_BATCH_PIXELS` | 262,144 px（4096 tiles） | 无任何设备上限依据 | **人为** |
| `SURFACE_OPTIMIZATION_ENVELOPE_BYTES` | 512 MiB | 人为 envelope，超限 throw | **人为** |
| `SURFACE_OPTIMIZATION_SCRATCH_ENVELOPE_BYTES` | 240 MiB | 人为，`SurfaceFrameResources` 强制 | **人为** |
| `SURFACE_OPTIMIZATION_BUDGET_MIB` | 13 项 MiB | 混用"每批次 scratch 上限"和"整池上限"两种语义 | **人为 + 单位混用** |
| `GEOMETRY_PRODUCT_GPU_CAPACITY_LIMIT` | 512 MiB | 被 4×128 MiB bank 精确吃满，零余量 | **人为，且无弹性** |
| `ASSET_UPLOAD_TRANSACTION_BUDGET_BYTES` | **8 MiB** | 单个 >8 MiB 的几何包无法常驻，而旁边有 512 MiB | **人为，且构成硬限制** |
| `TEXTURE_RESIDENCY_BUDGET_BYTES` | 2 GiB | 默认 bank 容量上限只有 42.6 MiB，永不触发 | **人为、失效** |
| `VIRTUAL_GEOMETRY_PRODUCT_REQUIRED_STORAGE_BUFFERS_PER_SHADER_STAGE` | 16 | 由 Product cell layout 反推，排除 portable-limit 设备 | **最坏情况预留** |
| `GPU_SPARSE_SHADING_REQUIRED_LIMITS.storageBuffersPerShaderStage` | 10 | 与上一行自相矛盾（`GpuSparseShadingCapability.ts:20`） | **内部矛盾** |
| `GPU_MATERIAL_*_CAPACITY` | 8192 = 2×4096 | 为"unlit 可能需要两条记录"翻倍 | 最坏预留 |
| `MeshletWork` key 上限 | 16,777,216 records × 24 B = 402 MB | 超 binding 即 throw | 最坏预留（多数适配器直接抛错） |
| `GeometryPageScheduler` | 8 MiB/帧、64 MiB/s、3 次重试 | 人为限速 | 人为 |
| `FrameGeometryArena.maxBytes` | 256 MiB owner / 128 MiB arena | 两级人为上限 | 人为 |

### 7.2 为什么会有 batch（真实原因）

**不是因为 `maxStorageBufferBindingSize` 不够，而是因为"每批次必须自洽"的设计 + 512 MiB envelope。**

推导（完整算式见附录 A）：

```
batchTiles 初值 = min(tileCount, 262144/64) = 4096
  ↓ 被 per-pool stride 限制压到 1024（geometryHot 8 MiB / (128 B × 64)）
  ↓ 被 failures() 的 retirementEnvelope 检查继续压到 ≈707
    (错误条件：scratch*2 + 224 MiB persistent + 48 MiB output ≤ 512 MiB)
batchCount = ceil(32400 / 707) = 46   @1080p
batchCount = ceil(129600 / 707) = 184 @4K
```

而 224 MiB persistent（FieldStore 128 + SignalStore 64 + Variation 32）**与每帧实际需求无关**，它只是被减掉了。**如果去掉 persistent 项的固定 224 MiB 与 ×2 退休重叠，batchTiles 可回到 ~1024 甚至更高，batchCount 直接减半**——这是 P0 里最便宜的一项。

### 7.3 批次化的连锁代价

| 代价 | 每帧量 | 说明 |
|---|---|---|
| pass 数 | ×46 | 48 pass/批次 |
| clearBuffer | 46 × 6 = 276 次（≈280 MB 写入） | workspace reset 4 段（≈4 MB/批次）+ demand reset 2 段（≈2.1 MB/批次） |
| copyBufferToBuffer | 46 × 5 = 230 次 | 其中多数是 16 B 的间接参数发布 |
| staging uniform write | ~600 次 | 每次都走 staging + copy（`ShadeGPUCommandContext.ts:438-450`） |
| JS 对象分配 | ~1,700 个 node + 标签字符串、~6,000 个 bind group key 字符串、~24,000 个 bind group entry | `SurfaceFrameResources.ts:81`、`ClassifierPass.ts:208-225` |
| `reset_cell_geometry` | 46 × `ceil(65536/64)=1024` workgroups | 100% 容量 reset，实际只用到覆盖子集 |

---

## 8. Surface V3 深挖

### 8.1 每批次真实数据流（按依赖）

```
coverage(全帧 1 次) ─→ addRange(批次) ─→ activeIndirect ─┐
                                                          ↓
cell geometry setup(reset→request→finalize→build→publish memo→commit memo)
                                                          ↓
facts + addresses ─→ field lookup(store 命中/未命中) ─→ proof tiles ─→ 7 certificate ─→ classify(2 stage)
                                                          ↓
signal witnesses ─→ signal lookup ─→ demand(11 stage) ─→ GeometryRecord ─→ material fields
                                                          ↓
                              FieldStore publish(3) ─→ Lighting(1) ─→ SignalStore publish(3) ─→ reconstruct(1)
```

### 8.2 Fixed Tree：真实 GPU 成本（不是 O(N²)→O(N) 的故事）

树结构：`16 leaves + 4 parents + 1 root = 21 nodes`（`surface_cell_classify.ts:161-163`），**在 plane 循环内部**：

```wgsl
for (var plane = planeStart; plane < planeStart + planeCount; plane++) {   // :134  共 21 个平面
  for (var level = 0u; level < 3u; level++) {                              // :161  3 层
    for (var ordinal = 0u; ordinal < 4u; ordinal++) { ... }                // :176  每层 4 个子
    workgroupBarrier();                                                    // :201
  }
  cell_tree_validate_plane(plane, lane);                                   // :203
}
```

**同一棵 21 节点树、同一份区间算术，被重建 21 次/格**（fields 15 次 + signals 6 次）。

每格 barrier 计数（源码逐行统计，最坏情况）：

| 位置 | barrier 数 |
|---|---|
| 平面循环固定部分（`:135,138,147,156` + 3 层 `:201`） | 7 |
| `cell_tree_validate_plane` 入口/出口（`:173,195`） | 2 |
| 字段循环 15 × (3 层 `:258` + `:261`) | **60** |
| 依赖归拢（`:248,250`） | 2 |
| signal 平面的 provider 前缀扫描（`:201,211,215,217,222,239,243`） | 16 |
| 代表者前缀扫描 6×(2 barrier)（`:217-226`） | 12 |
| 其余（`:212,238,269,285` + `:275` storageBarrier） | 5 |
| **字段平面合计** | **≈88 / plane** |
| **signal 平面合计** | **≈102 / plane** |
| **单格两 stage 最坏合计** | **≈ 15×88 + 6×102 = 1,932** |

× 32,400 格 = **最坏约 6,260 万次 barrier/帧**（实际值取决于 `dependencies` 掩码与 mode 分布，量级不变）。

其它成本：
- workgroup 共享内存 **15,616 B**（`GpuSurfaceCellTreeAbi.ts:23`）——**超过 `GpuSparseShadingCapability.ts:19` 声明的 9,216 B 上限**，能力门禁低估了真实需求（内部矛盾）。
- workgroup 形状只有 64 lane，而每个 plane 的有效 lane 是 21（树）+64（facts）→ occupancy 与 SIMD 利用率极低。
- `cell_tree_prepare_geometry` 做 AppearanceBound4 区间算术 + residual/scale 修正，每个 plane 对每个子节点重算（`surface_cell_group_validation.ts:38-123`）。

### 8.3 Prefix Scan：可以 ballot 化的地方

| 位置 | 产物 | 成本 | 能否 ballot/popcount |
|---|---|---|---|
| `surface_cell_classify.ts:216-227` | 代表者 rank | 6 步 × 2 barrier = 12 | **可以**：值是严格 0/1，`countOneBits(ballot(rep))` 前缀等价 |
| `surface_cell_group_validation.ts:200-221` | provider proof rank | 12 barrier | **可以**（同 0/1 形状） |
| `surface_cell_geometry_setup.ts:157-166` | run 前缀 → setup slot | 12 barrier | 部分（需要分段 ballot） |
| `surface_demand.ts:52-63` `demand_scan` | 队列偏移 | 每调用 12 barrier；`emit_surface_requests` 调 2 次、`emit_signal_cache_requests` 1 次、`compact_surface_groups` 2 次 → **单 workgroup 最多 60 barrier** | 分量扫描；`admission_fields` 那一路是 mask→rank，可 ballot+popcount |
| `surface_demand.ts:351-362` | program partition 前缀 | 在 `wg=1` 上串行跑 256 次 | 可并行，但绝对量小 |

### 8.4 Geometry Setup：过重

- **Bitonic sort**：`surface_cell_geometry_setup.ts:142-153`，`log²n/2 + log n/2 = 21` 个比较阶段 × 2 barrier = **42 barrier / 排序，64 元素**。有 `mixed==0` 快速路径（`:131-139`），但混合格一定走排序。
- **全量 reference reset**：`:100-101` 对 `id.x < reference_capacity` 全量写 `0xffffffff`，dispatch `ceil(65536/64)=1024` workgroups（`SurfaceCellGeometrySetup.ts:126`）→ 每批次 100% 容量写，×46 批次 ≈ 16 MB 纯 reset/帧。
- **Memo**：`SURFACE_CELL_GEOMETRY_MEMO_ENTRY_BYTES = 528`（512 B setup + 16 B），容量 32,768 → **17.3 MiB**，4-way 探测 + CAS 发布。它救下的是 `cell_build_geometry_setup` 的 3 角点×多属性解码 + 512 B 写入；在 4 次探测就可能全 miss 的访问下，**收益依赖命中率，而命中率没有任何计数器**。

### 8.5 Cache 值不值得存在：FieldStore vs SignalStore

| | FieldStore | SignalStore |
|---|---|---|
| key | 32 w = **128 B** | 72 w = **288 B** |
| value | 16 B | 16 B |
| entry | 256 B | 352 B |
| probe | 4-way 线性 | 4-way 线性 |
| equality | **全 32 word 比较**，且 key word 由 metadata **重新生成**（`surface_field_request.ts:49-86`，20 分支 switch + 元数据间接） | 全 72 word 比较 |
| 单次命中成本 | 最多 **~260 次依赖式 global/atomic load + ~216 次 key word 生成**，换回 16 B | ~290 次 load 换回 16 B |
| 单次发布成本 | admit 36 次 atomic store + 证书块 ~20 次 → **~60 次 atomic store 存 16 B**（key:value = 8:1） | 72 次 atomic store |
| 替代方案 | 直接重算一个 field：几十条 ALU + 少量 texture sample | 直接重算 = 完整 PBR（direct + clustered + VSM + IBL + DFG + coat） |

**判定**
- **SignalStore 值得留**：避免的是一次完整 PBR 求值（数百至数千指令 + 3 个以上纹理采样），命中成本同量级但更低。真正要修的是 72 次 atomic store 的发布路径（应改为 bulk copy）。
- **FieldStore 当前形态不值得留**：key 宽、equality 每次重新生成 witness、发布成本 8:1。**必须先用 A/B（cache on/off + 命中率计数器）证明收益，否则应直接 DELETE 或改成"便宜索引 key + 批量发布"**。当前代码里连命中率都没有可读计数器（`surface_field_lookup.ts:126` 的 `certificate_hits` 从未自增，`:182` 却把它当计数器上报）。

### 8.6 Surface 里的只写不读 / 纯诊断开销

| 位置 | 现象 |
|---|---|
| `surface_field_lookup.ts:126,182` | `certificate_hits` 恒为 0 却参与计数 |
| `surface_field_lookup.ts:176` | `field_known_masks` 由常量 0 写入 |
| `surface_store_publish.ts:161` | proof flag word 写入，无 reader |
| `surface_coverage.ts:105-108`、`surface_cell_classify.ts:278-282` | plan header word 6/7/8/9 无 reader（≈0.5 MB/帧纯写） |
| `SurfaceDiagnosticsPass.ts:52-60` | `wg=1` 单 invocation 串行遍历 `counters[127] × 64` → 700 tiles/批次 × 46 ≈ **210 万次串行 fact load/帧**，只为 4 个计数器（detailed 模式） |
| `SurfaceDemandPass.ts:95-102` | 为 2 个计数器多跑一整趟 12-barrier 的 `demand_scan` |
| `SurfaceCellClassifierPass.ts:307` | `previous = addresses` 把 proof-tile 阶段踢出依赖链（只剩 WAW 兜底） |
| 死文件 | `WinnerPrimitiveInterpolation.ts`（234 行，无人 import）、`SurfaceCellReference.ts:93-131`、`surfaceCellClassifyWgsl` |
| 未使用输入 | `SurfaceWorkRuntime.addToGraph` 声明并解析了 `arena`/`frameAttributes`/`materialLookup`/`surfaceIdentity`/`materials`/`nonlocalRevision`，运行时从不引用 |

---

## 9. Visibility / Geometry 管线

### 9.1 做得对的部分

- `HierarchicalWorkGenerator.encode()` **不是 CPU 热点**：无逐实例/逐 meshlet JS 循环、无排序、无每帧 typed array 分配，只有 256 B uniform 打包和 O(roundCount) 命令编码（`:876-1030`）。
- 间接参数从不由 CPU 每帧写入（只有 12 B clear），真正的 GPU work generation。
- HZB 每帧只构建 1 次（半分辨率 960×540，10 mip，1 个 compute pass 内 10 次 dispatch）。
- MeshletWork 溢出采用 fail-closed（清零 64 个 bucket draw）而不是静默绘制错误内容。

### 9.2 问题

| 问题 | 证据 | 影响 |
|---|---|---|
| **MeshletWork 记录是"每三角形 24 B"** | `GpuMeshletRasterWorkAbi.ts:5` | 显存与队列流量随三角形数线性增长；容量上限对应 402 MB，多数适配器直接 throw |
| **LOD/SSE 硬编码 4，且无运行时预算反馈** | `RendererCore.ts:351`，`GeometryAdaptiveSseController` 从未实例化 | 近景 meshlet 数量无界增长，只能靠 capacity 溢出回退父节点或静默丢弃 |
| **capacity 形状 dispatch** | `MeshletWorkCandidate.ts:726`（虚几何 candidate 按 `visibleClusterCapacity`）、root pass 按实例容量、`RasterWorkPartitions` stage0 按 `programs*8` | 空工作仍然占满调度 |
| **late recheck 是"第二遍完整可见性"** | `current_hzb_late_recheck.ts:263-289` 逐条读全部源记录 + 第二次完整几何光栅（`MeshletBucketRaster.ts:112-115`） | 默认关，一旦针对虚几何打开就是 ~2× 可见性成本；同时多分配一整条队列 + 过滤目录（拒绝阈值 256 MiB） |
| **`rasterExpansionEnabled=false` 但资源已分配** | `PackedVisibilityPass.ts:628`；`HierarchicalWorkGenerator.ts:432-451,679-689` | RasterWork 队列/args/2 个 pipeline/1 个 bind group 白建 |
| **`fused-leaf` 实现不可达** | `selectHierarchicalWorkImplementation` 要求 depth==0 且实例/raster 容量小，而生产场景 depth>0；且 `virtualGeometryEnabled` 强制 wavefront（`:509-513`） | leaf/HZB-leaf 的 pipeline/layout/bind group 全是死资源 |
| **page streaming 侧有每帧 JS 排序** | `GeometryPageScheduler.ts:256-259,272-276`（spread+filter+sort）、`VirtualGeometryResidency.ts:322-331`（全量排序，比较函数内两次算分） | CPU 长尾；且 `pump` 每帧被调用多次（`GeometryPageStreamingRuntime.ts:158,187,212,245,266`） |
| **同一 readback 载荷解码两次** | `GeometryPageScheduler.ts:219-229` + `GeometryPageStreamingRuntime.ts:211-219` | 冗余 |
| **重复计数器同值** | `hierarchical_work_generation.ts:947-951`（3 个计数器写同一个 `visited`）、`VisibilityCounterPass.ts:61-62` | 掩盖真实工作量，破坏可观测性 |
| **`peak` 不是峰值** | `HierarchicalWorkGenerator.ts:1251-1257` 把 `visibleInstances` 同时写进 written 和 peak | 证据字段误导 |
| **`MeshletRangeAllocator` 固定 131,072 空闲链表节点（3.67 MiB/分配器）** | `MeshletRangeAllocator.ts:109-113` | 与 `MeshletGpuPool` 一起是死代码（§13） |

### 9.3 "Surface 慢" 还是 "Geometry 喂太多"

**两者都有，但当前证据更支持"Surface 算法/调度结构自伤"**：

- Geometry 侧每帧只发 **~12 次 compute dispatch + 1 次 render pass**（约 10–40 draw），与 Surface 的 **~2,300 pass** 完全不在一个量级。
- 但 **Surface 的输入负载（tile 数、cover 格数）是 Geometry 决定的**：SSE 无预算反馈意味着近景可见 meshlet/图元数可以任意膨胀，直接线性推高 coverage scan、classify、addresses、demand、lighting 的 lane 数。
- **判别方法（必须实测，见 §22）**：固定相机，比较 `sse=4` / `sse=8` / `sse=16` 三档下 `Surface/*` 的 pass 内 dispatch 覆盖与 GPU 时间；若时间随可见目标数线性上升且 classify 的 plane 命中率高，则归因 Geometry→Surface 负载；若时间与 sse 无关而恒定，则归因 classify 的固定结构成本。

---

## 10. Lighting / Shadow

### 10.1 Clustered lighting

- 网格：32 px tile × 24 深度层 → 1080p = 60×34×24 = **48,960 clusters**（`light_cluster.ts:19-20`，`LightClusterPass.ts:281-284`）；lookup 783 KB，data **12.7 MB transient**（每帧重建）。
- 三段式构建，全部每帧执行：
  1. visible list（point/spot 分页，**只做 frustum，无 tile 测试**，`light_cluster.ts:217`）；
  2. HZB filter（每灯 AABB 投影 + 4-tap HZB min，`:338-357`）；
  3. **assign：每个 cluster 遍历整个 filtered list**（`:503-525`）→ 成本 = `clusters × active_lights`。1000 灯时 ≈ **4,900 万次迭代/帧**，其中 spot 每次还要重建视锥包围球（8×`intersect_three_planes`，`:84-143`）。
- 每 cluster 上限 128 point + 128 spot（`:502,526-527`），列表容量 16,380，超限由 CPU throw（`LightClusterPass.ts:303-306`）。

### 10.2 灾难路径：cluster fallback（P0 级正确性/性能风险）

```wgsl
if ((metadata.flags & CLUSTER_METADATA_FLAG_FALLBACK) != 0u) {
  for (var i = 0u; i < cluster_data.active_written; i++) {   // 全 active list
    ... re_surface_direct(incident, ...)                     // 完整 BRDF + coat
  }
}
```
`SurfaceLightingWorkPass.ts:200-217`。触发条件：某 cluster 的 point/spot 计数 >128（`light_cluster.ts:535-543`）或全局 data 预留失败（`:546-554`）。

- `active_written` 是所有通过 frustum+HZB 的 point+spot 灯数（`light_cluster.ts:432-445`），上限 16,380。
- **生产变体没有 `color != 0` 提前 continue**（对比 `lighting_direct.ts:663,672`）：每个 fallback 灯都付完整 BRDF。
- 量级：一个 shading sample × 16,380 灯 × 完整 BRDF（GGX + Smith + Schlick 5 次幂 + coat 第二瓣）≈ **10⁵ 量级指令**；若落到逐像素路径则 2.07M × 16,380 ≈ 3.4×10¹⁰ 次求值。
- 一旦某个 cluster 溢出，**它的像素会永久走这条路径**（fallback flag 由 allocate 阶段写入 metadata），是典型的"一个局部溢出导致整块画面雪崩"。

### 10.3 VSM

| 项 | 值 | 证据 |
|---|---|---|
| page / border / stride | 128 / 4 / 136 | `VsmCapabilities.ts:40-44` |
| atlas | 4096²（high）/ 2048（bounded）= **67 MiB depth32float** | `VsmResources.ts:51-57` |
| 常驻 slot | 900 / 225 | `VsmCapabilities.ts:65-66` |
| clip level × mip | 6 × 6 → 131,040 虚拟条目 | `VsmPageState.ts:62-72` |
| 分配策略 | CAS 去重（8 次重试）→ generation 复用 → **全 slot 线性扫描** → 第二次全扫描找最老 | `vsm_allocate_pages.ts:117-205` |
| 最坏分配成本 | 每 demand 记录最多 1,800 次 atomic load × 8,192 记录 | `VsmAllocatePagesPass.ts:124` |
| 每帧 atlas 附件 | **整张 4096² depth `load` + `store`**，与脏页数无关 | `VsmAtlasRasterPass.ts:200` |
| 每帧带宽 | **≈67 MB 读 + 67 MB 写**（≈1 ms @128 GB/s，仅这一项） | 同上 |
| receiver 采样 | 6 level × 6 mip 最多 **36 次随机 page-table load**，再 4×4 tap | `vsm_sampling.ts:100-127` |
| 每帧 dispatch | demand **32,400 workgroups / 2,073,600 invocations（逐像素）** + allocate 128 + caster 2 + commit 1,024 + 1 | `VsmReceiverDemandPass.ts:169` 等 |

**两个高危静态缺陷（需实机确认，但源码证据明确）**
1. **`VsmResources.pageConstants` 从未被写入**：grep 全 `render/vsm/` 只有创建（`VsmResources.ts:69`，零初始化）、getter（`:88`）、FrameGraph import（`FrameProgramLowering.ts:271-272`），6 处 `writeBuffer` 都不含它。若属实，所有 receiver 读到 `level=0, uv=(0,0), reference_depth=0.5, taps=1`——**阴影静默错误，但依然付完整采样成本**。
2. **`fallbackPolicy:"coarse-resident"` 与 `entry.fallback_mip` 声明了但没人读**：`fallback_mip` 只在 allocate shader 写（`vsm_allocate_pages.ts:98-100,155,248`），`vsm_sampling.ts` 从不使用。另外 `pcfTapCount` 只进入 `shadowVisibilityFrame`（`FrameProgramLowering.ts:286`），从未打包到 GPU。
3. **caster 溢出时 `DIRTY_COMMIT_WGSL` 直接 return**（`VsmAtlasRasterPass.ts:36`）→ 脏页永不 commit → 所有 receiver 永远走 36 槽查找并返回 1.0（阴影整体消失）。

### 10.4 阴影采样

- 生产方向光走 VSM（`SurfaceLightingWorkPass.ts:41` 选择 `(true,"vsm")`）。
- 传统 CSM 路径 `shadowmap_csm_compute_cascade_blended` + 最多 2 cascade × `shadowmap_sample_5` = **18 次 `textureGatherCompare` / 72 次深度比较 per shading sample**（`lighting_direct.ts:351-443`）。
- **Point/spot 阴影在生产里被 stub 成 `return 1.0`**（`lighting_direct.ts:763-780`），但 `shadow_enabled` 分支仍然存在并参与控制流（`SurfaceLightingWorkPass.ts:184-186`）。

### 10.5 Environment / IBL / AO / SSR

- 大气 LUT：5 张 rgba16float，其中两张 **256×128×32 3D LUT ≈16.8 MB**（`AtmosphereLutResources.ts:4-7`）。更新是**门控的**（sun 方向量化 0.002 rad、探针 25 m 网格，未变化返回 null，`PhysicalEnvironmentRuntime.ts:29-38`），单次重建 ~18 dispatch。**这部分设计是对的。**
- Sky：1 次全屏 `draw(3)`，逐像素读 4 个 LUT；Aerial：1 次 compute，**2,073,600 invocations 逐像素 ray-march 穿 3 个 LUT**（`AerialPerspectivePass.ts:85`）。
- XeGTAO：门控于 `aoProfile==="scalar-high" && hasLit`，**全分辨率**：normals + prefilter + 3 mip + main（3 slices × 3 steps = 9 次迭代/像素 → 1,870 万次）+ denoise + pack（`XeGtaoMainPass.ts:93`，`xegtao_main.ts:15-16`）。
- **AO 只作用于重建期的 irradiance**（`SurfaceReconstructionPass.ts:95-99`），**没有衰减直接光与 specular IBL**；`SurfaceLightingWorkPass` 声明了 `scalarAo` 输入但从未绑定（`SurfaceLightingPass.ts:37-44,138-143`）。
- **SSR 全链已死**：`ssr_trace/ssr_denoise/ssr_resolve/screen_space_diffuse_resolve/long_range_diffuse_provider` 无任何 importer；`RenderDebugViewPass` 的 4 个 SSR 槽永久绑 `null`。
- **Surface IBL 成本**：octahedral 4 load + prefiltered 8 load + irradiance 4 + DFG 1，带 coat 再加 8 → **最多 21 次纹理读/sample**（`SurfaceLightingWorkPass.ts:236-257`）。

---

## 11. Temporal / Post

### 11.1 后处理/时间性链：每帧固定约 46 个全屏/近全屏 pass（与 Surface 的 46 个**批次**无关，数字巧合）

| Pass | 分辨率 | 次数/帧 | 默认开关 |
|---|---|---|---|
| TemporalFacts resolve | internal-full | 1 | 强制 |
| Radiometry histogram + reduce | 1/2 px 采样 + 1×1 | 2 | `autoExposure=true` |
| FSR3 全链 | internal / output | **32** | `fsr3_enabled=true`，且 `fsr3` 是**必需 stage**（`FrameProgramLowering.ts:102-104`） |
| Bloom | output/2 … /32 + composite | **10** | `bloom_enabled=true` |
| Present | output-full | 1 | 强制 |
| Debug view | output-full | 0（默认 None） | 关 |

### 11.2 关键结论：默认配置下 FSR3 在 1:1 分辨率上运行

- `DEFAULT_RENDERER_CONFIG.renderScale = 1`（`RendererConfig.ts:30`），`_render_resolution = floor(output × scale)`（`RendererCore.ts:1268-1270`）。
- `Fsr3UpscalerRuntime.addToGraph` 只在 `input.enabled === false` 时旁路（`:222-227`），而传入的是 `plan.request.fsr3Enabled`（默认 true）。
- 结果：**32 个 dispatch 的完整 upscaler（含两条 11 级 pyramid）在 render == output 时不提供任何放大收益**，只提供时间性重建；但 SDK 的 accumulate/RCAS 阶段是按"放大"假设设计的。

### 11.3 FSR3 内部重复与带宽

- 两条独立的 11 级 luma/shading pyramid：**23 个 dispatch + 46 张 transient 纹理 + 23 个每帧新建 bind group**（WebGPU 无跨 workgroup barrier，所以每 mip 一次 dispatch）。
- `Fsr3AccumulateShader.ts:236-237` **把同一像素颜色写两遍**（history + upscaled output）→ 每帧多 16.6 MB 全分辨率写。
- `PrepareReactivity` 每个像素约读 25 个 texel（≈88 B）。
- 反应性信号被算/推导 **3 次**：TemporalFacts（emissive/alpha/identity mismatch）、Surface reconstruct（surface reactive）、FSR3 自己的 dilate+disocclusion+thin-feature。
- 朴素带宽合计 ≈ **1.35 GB/帧 ≈ 81 GB/s @60fps**（未计 L1/L2 复用），其中 FSR3 Accumulate 一项约 446 MB 读 + 33 MB 写。
- Bloom composite 产出一张全分辨率 rgba16f，Present 只是采样它——融合可省 16.6 MB 写 + 16.6 MB 读。

### 11.4 History / 生命周期

- 实际分配 12 张时间性纹理（color×2、luma×2、lumaHistory×2、accumulation×2、frameInfo×2、identity×2 + depth 双缓冲 + HZB 乒乓），但 `TemporalFabric.ts:31-36` 只注册 2 个（color、identity）。
- 后果：`TemporalHistoryRegistry.invalidate/invalidateNames` **无法触及 luma/lumaHistory/accumulation/frameInfo**，只有 `Fsr3UpscalerRuntime.invalidate()` 另一条路径能做。相机 cut / resize / 设备丢失时存在失效遗漏风险。
- 帧内 `copyTextureToTexture` **为 0**（全部乒乓索引），唯一每帧 GPU 拷贝是 camera → previous camera（`ViewContext.ts:180-181`）。这点是对的。

### 11.5 死代码（grep 证明，无 importer）

`nss_model.generated.ts`（1520 行）+ `NssModel.ts` + `shaders/nss.ts`；`shaders/taa.ts` + `shaders/temporal_classification.ts`（**TAA 在运行时不存在**，只有计数器和注释残留）；`SharedColorPyramidPass`、`AutomaticExposurePass`、`ColorGradingPass`、`MotionBlurPass`、`SharpenPass`、`OcclusionConfidencePass`、`AnalyticTemporalBaselinePass`、`DynamicResolutionScaling`（310 行，`get_scale/set_scale` 是 `null!`）、`TemporalResolveContract`；对应 WGSL：`automatic_exposure`、`color_grading`、`motion_blur`、`sharpen`、`occlusion_confidence`、`shared_color_pyramid`、`bloom`（重复实现）、`tonemap_hdr`、`tonemap_sdr`、`final_output_input`。

**结论：Temporal/Post 当前不是"次要项"。** FSR3 32 + Bloom 10 + TemporalFacts 1 + Radiometry 2 + 5 个逐像素全分辨率 pass（VSM demand、Aerial、XeGTAO main+denoise、Sky）= **约 55–60 个 pass**，加上 1.35 GB/帧的朴素带宽，是仅次于 Surface 的第二大结构性成本。**如果只把 Surface 优化到 20 ms，整帧仍可能被这一层拖住。**

---

## 12. 代码质量与模块边界

### 12.1 God class / God file（按职责跨界判定，非按行数）

| 文件 | 行数 | 混杂的职责 |
|---|---|---|
| `RendererCore.ts` | 1841 | composition root + 帧编排 + 容量决策 + 恢复检查点（`checkpointRecovery`/`recoverAfterDeviceLoss`）+ 相机/HZB 失效策略 + 诊断接线 + streaming 压力反馈 |
| `TextureResidency.ts` | 1982 | bank 分配 + package 分段 + 上传事务 + 绑定集发布 + 退休引用计数 + 设备丢失恢复 |
| `GpuRenderWorld.ts` | 1803 | runtime 生命周期 + 发布/切换 + patch 编码 + 证据汇总 |
| `GPUDatabase.ts` | 1577 | 页分配 + 上传批 + 脏范围 + 增长策略 |
| `GpuAssetStore.ts` | 1569 | 常驻表 + 两种堆（重复存储）+ 上传事务 + 增长 + 谱系 epoch 退休 |
| `GpuScene.ts` | 1443 | 实例表 + 字段级脏同步 + 变换打包 + 容量协商 |
| `FrameGraph.ts` | 1326 | 图模型 + 编译 + 执行 + 资源池 + 证据导出 + **Oklch/DOT 可视化（约 155 行）** |
| `HierarchicalWorkGenerator.ts` | 1967（+93 未计入） | pipeline 家族缓存 + bind group 缓存 + queue 布局 + 证据采样 + 调度网格 |

### 12.2 单调用点 / 纯转发抽象

- `Phase3Products.ts`（97 行）、`SurfaceProducts.ts`（61 行）、`RenderFeatureRegistry.ts`（132 行）、`PackedCameraUniform.ts`、`IblAlignment.ts`：**外部引用 0**（§13）。
- `SurfaceWorkRuntime.addToGraph` 声明了 6 个从不使用的输入（`arena`/`frameAttributes`/`materialLookup`/`surfaceIdentity`/`materials`/`nonlocalRevision`），仍在每帧解析 binding —— 纯负担。
- `SurfaceFrameResources.obtainBindGroup` 每次请求都 `entries.map(e=>e.binding).join(",")` 造字符串 key（`:81`），在 ~2,300 pass/帧下产生约 6,000–13,000 次字符串构造。

### 12.3 隐式 ABI（必须手工同步的双份常量）

| ABI 常量 | TS 位置 | WGSL 侧硬编码 |
|---|---|---|
| SignalStore entry/payload | `GpuSurfaceSignalStoreAbi.ts:5-7` | `surface_reference_values.ts:35` 写 `index*88u+72u`；`surface_store_publish.ts:23` 写 `88/72/76/77/80/79` |
| Surface workspace 各段 | `GpuSurfaceCellPlanAbi.ts:33-64` | `surfaceCellWorkspaceWgsl` 由同文件的模板生成（这一处是对的） |
| proof result words | `GpuSurfaceCellPlanAbi.ts:26`（52 w） | `surface_cell_group_validation.ts:78-83` 按 `at+24..31` 直接下标 |
| shading bin 计数常量 | `GpuShadingBinAbi.ts:30-35` | `GPU_SHADING_BIN_INDIRECT_BYTES`/`MUTABLE_BYTES` **无任何引用点** |
| signal store spill words | `GpuSurfaceSignalStoreAbi.ts:20-21` | 无引用 |

### 12.4 命名失真与注释失真（源码与注释冲突清单）

| 位置 | 注释/命名 | 源码实际 |
|---|---|---|
| `MeshletWorkCandidate.ts:98-99` | "non-production compact/bucket/indirect producer" | `PackedVisibilityPass.ts:540` 明确它是生产路径 |
| `RasterWorkPartitions.ts:29` | "No CPU work-count readback, duplicate geometry queue" | late recheck 确实分配了重复队列与目录 |
| `shaders/current_hzb_late_recheck.ts:9-12` | "subset/conservative candidates" | `:265-289` 过滤**全部**源记录 |
| `FrameProgram.ts:18-19` | "AO only off is requested by production until C4–C6" | `RendererCore.ts:357,1565-1566` 只要 hasLit 就开 `scalar-high` |
| `framegraph/AGENTS.md` | "feature set 与尺寸不变时应缓存图编译结果" | key 含每帧现算的 `activeSets`/`textureBankMask`，容量 8 |
| `GpuSparseShadingCapability.ts:20` | 最小 storage buffer 需求 10 | `SurfaceCellPipelineLayout.ts:10` 实际需要 16 |
| `GpuSparseShadingCapability.ts:12` | workgroup storage 768 B | `GpuSurfaceCellTreeAbi.ts:23` 实际 15,616 B |
| `FrameProgram.ts:94-95` | `display-color` 由 `present` 产出 | 无任何 pass 创建该资源 |
| `GpuSurfaceFieldStore.ts:121` | `allocatedBytes` | 把 8 MiB 依赖预算重复计入（容量计划里已扣掉一次） |
| `TemporalFabric.ts:31-36` | 注册的时间性历史 | 实际分配 12 张，注册 2 张 |

### 12.5 耦合

- **CPU 领域 → render（真实的方向违规）**：`scene/Scene.ts:23` `import { PhysicalEnvironmentInput } from "../render/environment/PhysicalEnvironmentState.js"`。AGENTS 规定 `scene` 位于 `gpu/render` 之下，Application World 现在依赖 render 的状态类型。
- `render/passes/*` 直接 import `gpu/*` 内部 ABI 与 allocator（`GPUDescriptorCaches`、`GPUBufferAllocator`），越过"render 只作编排"的边界。
- `framegraph/FrameGraph.ts` 自己持有 `FrameGraphGraphicsResources`（`buffer_allocator_main`、`allocator_textures`）并直接创建原生纹理（`:18-20` 的 `GPUTextureAllocator`/`GPUTextureContext`/`createNativeTexture`）—— 图模型与分配器/原生资源耦合。
- `shaders/*` → `render/*` 与 `gpu/*`（与声明的 `gpu ↑ framegraph+render+shaders` 顺序相反）：`shaders/lighting_direct.ts:14,17,18`、`shaders/light_cluster.ts:9,16`、`shaders/render_debug_view.ts:18`、`shaders/xegtao_*.ts`、`shaders/brick4_indirect.ts:5`、`shaders/surface_cell_lighting_risk.ts:2,3`。
- `SurfaceFrameResources` 同时承担 scratch 池、bind group 缓存、texture view 缓存、字节预算、退休语义（5 个职责）。

### 12.6 ABI 安全缺口与生命周期泄漏（本报告最重要的"隐性正确性"发现）

**(a) 同一 ABI 结构体在多处独立定义，没有单一事实源**（已逐一核实行号）：

| 结构体 | 定义处 | 份数 |
|---|---|---|
| `LightList` | `render/passes/LightClusterPass.ts:161`、`shaders/lighting_direct.ts:81`、`shaders/light_cluster.ts:230`、`shaders/light_cluster.ts:383` | **4** |
| `ClusterMetadata` | `LightClusterPass.ts:162`、`lighting_direct.ts:74`、`light_cluster.ts:390` | 3 |
| `ClusterData` | `LightClusterPass.ts:163`、`lighting_direct.ts:89`、`light_cluster.ts:396` | 3 |
| `AppearanceRoute` | `shaders/appearance_coverage.ts:15`、`appearance_resident_kernel.ts:152`、`appearance_surface_demand.ts:51` | 3 |
| `OEngineDrawIndirectArgs` | `hierarchical_work_generation.ts:234`、`meshlet_work_compaction.ts:89`、`virtual_geometry_work.ts:55`、`vsm_caster_records.ts:138` | **4** |
| VSM page record | `vsm_atlas_raster.ts:21`、`vsm_caster_records.ts:28`、`vsm_page_table.ts:14`、`vsm_allocate_pages.ts:34` + TS `VsmAtlasRasterPass.ts:22` | 6 |

扫描还发现 **28 个 WGSL 结构体名在 ≥2 个文件里被定义**（`Settings` ×5、`Constants` ×5、`VertexOutput` ×5 等）。

**反证**：`CLUSTER_METADATA_FLAG_FALLBACK` 是**正确共享**的（`render/ClusteredLightingReference.ts:7` → `shaders/light_cluster.ts:40`、`lighting_direct.ts:44`、`surface_cell_lighting_risk.ts:73`）。说明工程具备单一事实源的做法，只是在别处没用。

**(b) 没有任何生成器断言 TS ABI 与 WGSL 的字节/stride/offset 一致。** 现有守卫全是"源文本存在性检查"：`shaders/lighting_direct.ts:815,823,827,842`（marker/function/body/unterminated）、`surface_geometry_reader.ts:141-146`、`surface_cell_production_facts.ts:94,106,145`、`surface_cell_classify.ts:10`。它们能证明"文本在"，**无法发现布局错位**。这是整个工程最根本的 ABI 安全缺口。

**(c) 已在生产路径上的具体发散风险**

| 风险 | 位置 | 后果 |
|---|---|---|
| 导出的 workgroup size 常量只用在其中一个入口 | `appearance_resident_kernel.ts:10`（`=64`）在 `:166` 被插值，但 `:177` 与 `appearance_surface_demand.ts:75` 硬编码 `@workgroup_size(64)` | 改常量即静默错配两个入口 |
| 用 `String.includes` 探测另一个生成串来决定发射哪段代码 | `surface_cell_classify.ts:9-15`（`includes("fn surface_cell_load(")`、`includes("fn surface_cell_domain_token(")`）+ `:186` `${domainCache ? "!reuse_domain && " : ""}` | fact library 改名 → 静默走 `false` 分支，不报错 |
| 字段序号硬编码在发射点 | `surface_cell_production_facts.ts:318-321,465-468`（按 field ordinal 写 fallback 常量） | 字段枚举重排即错，无编译期链接 |
| 几何记录偏移按字段名在生成期解析 | `surface_geometry_reader.ts:132-146`（找不到就 throw） | ABI 重排改变生成偏移，无类型检查 |
| 默认参数陷阱：方向光阴影模式默认 `"legacy"` | `shaders/lighting_direct.ts:746`（`directionalShadowMode = "legacy"`），唯一生产调用点显式传 `"vsm"`（`SurfaceLightingWorkPass.ts:41`） | 生产当前正确（VSM），但任何省略该参数的调用点会**静默退回 legacy CSM 路径**（这也是 legacy 路径至今仍在发行包里的原因） |
| `fallbackPolicy:"coarse-resident"` 硬编码进活帧 | `FrameProgramLowering.ts:281` | 与"未接线"的 `fallback_mip` 形成第二处失配（§10.3） |

**(d) 生命周期：`destroy()` 定义了但没有任何调用路径可达**

| 对象 | 创建点 | `destroy()` 定义 | 调用点 |
|---|---|---|---|
| `FrameProfiler` | `RendererCore.ts:304`（唯一实例，`GraphicsContext.ts:123` 的默认参数被 `RendererCore.ts:1190` 覆盖） | `FrameProfiler.ts:1094` | **0** |
| `GPUDatabase` | `gpu/LightDatabase.ts:666` | `GPUDatabase.ts:1321` | 0 |
| `MeshletWorkCandidate` | `PackedVisibilityPass.ts:245` | `MeshletWorkCandidate.ts:361` | 0 |
| `HierarchicalWorkGenerator` | `PackedVisibilityPass.ts:240` | `HierarchicalWorkGenerator.ts:1101` | 0 |
| `RasterWorkPartitions` | `GraphicsContext.ts:300` | `RasterWorkPartitions.ts:147` | 0 |
| `MipmapGenerator` | `GPUTextureManager.ts:27` | `MipmapGenerator.ts:125` | 0 |
| `GPUVolumetrics` / `LightProbeAtlas` | `GPUSceneEnvironmentContext.ts:51` / `GPULightProbeVolume.ts:77` | `:129` / `LightProbeAtlas.ts:66,168` | 0 |
| `TemporalHistoryRegistry` | `TemporalFabric.ts:36` | 有 | 0（`TemporalFabric` 自身也没有 `destroy()`） |
| `GpuReadbackRing` | `GpuFrameCounters.ts:233`、`SurfaceDiagnosticsCapture.ts:33` | `GpuReadbackRing.ts:200` | 0 |

**后果链**：`FrameProfiler.destroy()` 不可达 → `GpuFrameCounters.destroy()`（只从 `FrameProfiler.ts:1156` 调用）不可达 → **整个 profiler/counters/readback-ring 的释放链在 `RendererCore.shutdown()` 之外，从未执行**。设备丢失重建（`recoverAfterDeviceLoss`，最多 2 次）场景下这些 owner 会被重复创建而不释放。

> 更正：独立扫描曾报"两个 live profiler"（`GraphicsContext.ts:123` 与 `RendererCore.ts:304`）。经核实 `GraphicsContext` 的 profiler 是**默认参数**，唯一构造点 `RendererCore.ts:1189-1190` 传入了 `this._profiler`，**运行时只有一个实例**。此条不成立，已排除。

**(e) 第二所有权**：`FrameGraph.fallbackOwned`（`FrameGraph.ts:396`，`:485`/`:533` 加入，`:555-572` 释放/销毁）跟踪的是**图没有创建、但图会销毁**的外来 GPU 资源，且不记录第一所有者是谁 —— 一个隐式的双所有权集合，在设备丢失/重建路径上难以推理。

### 12.7 WGSL 字符串生成：真实风险点与实测

**风险度量（静态计数）**

| 项 | 实测 | 说明 |
|---|---|---|
| WGSL 生成器文件 | `shaders/` 下 96 个 `.ts`，18,054 行 | 全工程**没有独立 `.wgsl` 文件**——WGSL 只以 TS 模板字符串存在，无法被独立 tooling 静态检查 |
| 最高插值密度文件 | `meshlet_work_compaction.ts`（540 行，84 处 `${}`）、`appearance_demand_inputs.ts`（136 行，81 处）、`winner_primitive_work.ts`（236 行，71 处）、`surface_cell_production_facts.ts`（575 行，68 处） | 大量条件片段拼接，生成结果与 TS ABI 的对应关系无法自动校验 |
| `.replace()` 改写 WGSL | 仅 11 个文件、最多 8 处（`loaders/usd/usdAttrs.ts`） | 比预期克制；但存在 3 处**语义级改写**见下 |

**确认的危险模式**

1. **`packed_transparent_oit.ts:19-46` 用 `removeWgslFunction(source, name)` 按名字删除已嵌入的 WGSL 函数**（`read_gBuffer_material`、`shade_direct_pixel`、`finite_f32`），而 `LIGHTING_DIRECT_WGSL` 在 `:12` 与 `:35` 被嵌入两次。这是"用字符串手术解决模块组合"的典型形态：一旦被删除的函数改名，删除会静默失效（无断言证明删除成功）。
2. **同一 fact library 被参数化成 9 个独立 shader module**：`SurfaceCellClassifierPass.ts:121-149` 用 `surfaceCellProductionFactsWgsl(...)` 的不同参数（家族集合、`parameterBounds`、profile 序号）生成 1 个 facts 模块 + 6 个 certificate 模块 + 2 个 classify 模块。每个模块都完整包含几何/材质 fact DAG。
3. **pipeline 缓存无淘汰**：`SurfaceCellClassifierPass.pipelines` 以 `` `${product}:${referenceCapacity}:${surfaceProgramCount}:${surfaceCacheGeneration}:${targetCapacity}` `` 为 key（`:126-127`），**只增不减**（`destroy()` 才 clear，`:376`）。每次 appearance publication 换代（材质程序集合变化）都会新建 **9 个 shader module + 约 10 个 compute pipeline** 并永久保留 → 长时间编辑/流式加载会话下是显存与编译时间泄漏。`surfaceProgramCount`/`surfaceCacheGeneration` 进入 key 这一点本身也与 `:123-125` 的注释"resize 不应重编译证书 shader"相矛盾。
4. **`/${...}/` 条件片段无静态校验**：`surface_cell_group_validation.ts:21-26,46-51,68-70,85-98,115-120,142-167,179-192,196-244` 用 `signals ? ... : ""` 决定是否发射**整段结构体成员与 barrier**。一旦 `planeStart/planeCount` 参数变化导致 `signals` 翻转，worker 的 barrier 结构随之改变——这类结构性分支在同一模块内已经很难人工核对。

**结论**：WGSL 生成方式目前**没有达到"难以维护、容易产生隐藏错误"的最坏程度**（没有大规模 `.replace()` 链、没有嵌套模板），但已经出现两个必须修的形态：**（a）按名删除函数、以字符串手术做模块去重；（b）以发布代数为 key 的 pipeline 缓存无淘汰**。二者都属于函数级重构范围，不需要重写整个生成层。

---

## 13. 过度工程与死代码

### 13.1 死代码实测（自动 import 图分析，只读）

- **73 个 `.ts` 文件从未被任何其他源码文件 import，合计 14,710 行**（≈ 全部 132,841 行的 11%）。扣除合法入口（`src/index.ts`、`core/index.ts`、`framegraph/index.ts`、`addons/inspector/index.ts`、两个 worker entrypoint、`assets/*/index.ts`，约 1,100 行），**约 13,600 行是真正的死代码**。
- 其中体量最大的：`geometry/GeometryCooker.ts`(1686)、`shaders/ssr_denoise.ts`(678)、`render/passes/PackedTransparentOitPass.ts`(553)、`gpu/MeshletGpuPool.ts`(537)、`gpu/ShadowAtlas.ts`(463)、`shaders/long_range_diffuse_provider.ts`(417)、`shaders/nss.ts`(416)、`render/passes/SharedColorPyramidPass.ts`(351)、`render/passes/AutomaticExposurePass.ts`(339)、`debug/profiling/PerformanceCapture.ts`(328)、`debug/FormalPerfFreeze.ts`(319)、`render/DynamicResolutionScaling.ts`(310)、`gpu/GpuShadingProgramOracle.ts`(293)、`shaders/ssr_trace.ts`(271)、`debug/VisibilitySurfaceMigrationGates.ts`(271)、`render/NssModel.ts`(208)+`nss_model.generated.ts`(1520)。

### 13.2 "只被测试引用"的生产 fallback

- `Runtime = null/disabled*` 系列占位 buffer：`SurfaceDemandPass.disabledSun/disabledShadow`、`SurfaceLightingPass.parameters/pages/depth/transmittance`、`SurfaceStorePublishPass.sun/shadow`、`SurfaceFieldLookupPass.disabledStore`、`GpuSurfaceSignalStore.disabled*`。这些是"未点亮场景"的合法 ABI 填充（注释也这么说），但同一条路径上同时存在 `importUnlitProviders` 一整套空 provider 绑定（`SurfaceWorkRuntime.ts:392`、`SurfaceLightingPass.importUnlitProviders`）——**为"unlit"单独维护了第二套绑定图**。

### 13.3 重复的 cache / 重复的 generation

- 两套 bind group 缓存：`GraphicsContext.bind_groups`（两级 WeightedCache）与 `SurfaceFrameResources.bindings`（WeakMap 形状缓存）；FSR3/Bloom/XeGTAO 又**完全绕过两者**，每帧 `createBindGroup`（约 46 次/帧）。
- **无淘汰的 pipeline 缓存**：`SurfaceCellClassifierPass.pipelines` 以"发布代数"为 key 只增不减（`SurfaceCellClassifierPass.ts:126-127,376`），每次 appearance 换代泄漏 9 个 shader module + ~10 个 compute pipeline。
- 四套生命周期计数器同时存在：`generation`、`publicationGeneration`、`namespace`、`submissionEpoch`/`touched`（FieldStore/SignalStore 各自一遍）。
- 两套 `GPUStatisticsHistory` 定义（`framegraph/GPUPerformanceTimer.ts:17-50` 与 `gpu/GPUStatisticsHistory.ts:5`）。
- 两份 128 MiB 常量：`GEOMETRY_PRODUCT_PORTABLE_BANK_BYTES_V1` 与 `GEOMETRY_PRODUCT_SHARED_BANK_BYTES`。
- 两组 group budget：`GPU_SHADING_BINDING_GROUP_BUDGETS`（g0 storageTextures 4）vs `GPU_SPARSE_SHADING_BINDING_GROUP_LIMITS`（g0 storageTextures 5）。

### 13.4 无意义 wrapper / 单调用抽象

- `SurfaceProducts.ts`、`Phase3Products.ts`、`RenderFeatureRegistry.ts`、`material/materialBucketId.ts`、`render/VelocityMatrices.ts`、`render/IblAlignment.ts`、`render/PackedCameraUniform.ts`、`render/HilbertNoiseTexture.ts`、`gpu/GPUDefaultMaterialTextures.ts`、`gpu/GPUStatisticsHistory.ts`、`gpu/TopLevelAccelerationStructure.ts`、`geometry/robustPredicatesUtil.ts`：外部引用 0。
- `ReusableResourceManager.ts`(112)、`GPUPerformanceTimer.ts`(180)、`framegraph/index.ts`(30) 无 importer。

---

## 14. Profiler 与测量层审计

### 14.1 默认路径**没有** profiler 开销（这点是好的）

- `FrameProfiler.enabled` 默认 `false`（`FrameProfiler.ts:409`），`beginFrame` 早退（`:711-712`）。
- `GPUTimer` 只在 `enable_debug_timers` 里创建（`ShadeGPUCommandContext.ts:176-183`），而它只被 `attachGpuTimingContext` 调用，后者在未采样帧直接返回（`FrameProfiler.ts:831-838`）。
- 因此**默认没有 query set、没有 `resolveQuerySet`、没有 readback**。生产帧的 `beginComputePass` 直接返回原生 pass（`ShadeGPUCommandContext.ts:300-303`）。

### 14.2 打开 profiler 后的 tax（在 ~2,300 pass/帧下不可忽视）

| 项 | 成本 |
|---|---|
| 每个 pass 2 个 timestamp | ≈4,800 个 query/帧；单页 1024 pass 上限 → 需要 3 页 |
| 每 pass 一个 Proxy wrapper + 方法绑定 | 约 2,300 个 Proxy/帧（`profileComputePass`→`proxyEncoderMethods`，`:587-614`） |
| readback | 每页 1 次 `resolveQuerySet` + 1 次 `copyBufferToBuffer` + `mapAsync` + 约 4,800 个结果对象（`:123-140`） |
| 采样频率 | 默认 `gpuSampleInterval=60`（`FrameProfiler.ts:410-412`），`live` 模式强制 ≥4 |

**结论：profiler 的"每 pass 两时间戳"在当前 pass 数量下，其 readback 与 JS 结果处理成本本身就会改变帧时间形态。** 必须在报告中区分四档：生产无 profiler / 粗粒度帧计时 / stage 计时 / 全 pass 计时，并且**任何性能结论只能采信前两档**。

`cpuPassTimings`（`shouldSampleCpuPasses`，`:476-478`）会在 deep-capture 或显式开启时给**每个 pass** 套一次 `performance.now()` 对（`FrameGraph.ts:924-925`）→ 同样在 2,300 pass 下失真。

### 14.3 测量层自身的缺陷

| 问题 | 证据 |
|---|---|
| `_lastFrameGraph` 每帧 `Object.freeze` + `summarizeFrameGraphResources()`（内含 4 次 `resources.filter` + 每资源字符串 `includes`） | `RendererCore.ts:1586-1592`、`FrameResourceSummary.ts:33-60` |
| `createCompiledDump()` 是 O(resources × passes)，且在每次 graph miss 时执行 | `FrameGraph.ts:1108-1115` |
| `GPUPerformanceTimer` 若被接上会**每帧**无条件 `resolveQuerySet` + `copyBufferToBuffer` | `GPUPerformanceTimer.ts:125-153`（当前无 importer，属于"潜伏的 hook"） |
| `GPUIndexedRecordTable.readBytes` 自建 encoder + 自己 `submitGpuCommands` + `mapAsync`，绕过帧上下文 | `GPUIndexedRecordTable.ts:216-232` |
| 重复计数器同值、`peak` 字段名不符实 | §9.2 |
| Surface 诊断 pass 只为 4 个计数器做 210 万次串行读 | §8.6 |

### 14.4 文档/证据失真（本次审计发现，供清理）

- `OEngine/src/framegraph/AGENTS.md`、`OEngine/AGENTS.md` 声称"同 feature set 与尺寸复用已编译图"——key 含每帧现算字段且容量 8，现实场景必然 miss。
- `FrameProgram.ts:18-19` 关于 AO 的描述已被 `RendererCore.ts:357` 推翻。
- 设计文档 `docs/next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md:550` 自述"144-word 地址提前物化、三份 dense certificate、dense refs 与旧预算映射仍在"——**与源码一致，说明该文档自己承认的缺口至今仍在**；同文档 `:534` 的"≤96R hot address"与物理 216 B/target 不符。

---

## 15. 当前真正的性能账

> **再次强调：本节没有任何实测数字。** 用户明确要求不运行代码/测试。以下是**结构性账本**（pass 数、dispatch 数、字节数、最坏情况工作量），可用于在允许测量后直接对照。**P50/P95、低/高覆盖率、近/远景、静止/运动的分档数据在本次审计中无法产生**（需要浏览器宿主 + timestamp query，见 §22 的测量矩阵）。

### 15.1 结构性账本（1080p / renderScale=1 / 默认开关）

| 层 | pass/帧 | dispatch/帧 | 关键字节量/帧 | 最坏工作量 |
|---|---|---|---|---|
| Geometry / Visibility | ~17 | ~17 | queue/args clear 各 ~几十 KB；pageDemand mask 全量清 | 每三角形 24 B 记录；capacity 形状 dispatch |
| HZB | 1（10 dispatch） | 10 | 半分辨率 10 mip ≈ 691k texel 读写 | — |
| VSM | ~10 | ~1,180（demand 32,400 wg） | **atlas 67 MB 读 + 67 MB 写**；cluster/VSM constants 若干 | allocate 最多 1,800 atomic/记录 × 8,192 |
| XeGTAO | 8 | 8（全分辨率） | normals/mips/edges 全分辨率多趟 | 9 次 horizon 迭代 × 2.07M px |
| LightCluster | 5 | 5 | **12.7 MB transient data 每帧重建** | `clusters × lights` ≈ 4.9×10⁷ @1000 灯 |
| **Surface（46 批次）** | **~2,208** | **~2,208** | **clear ≈280 MB；copy 230 次；uniform staging ≈600 次** | classify 最坏 ~1,932 barrier/格 × 32,400 格 ≈ 6.3×10⁷ barrier |
| Temporal | 1 | 1 | identity rgba32uint 全分辨率写 | — |
| Sky / Aerial | 2 | 1 | 逐像素 4 LUT 读 + 3 LUT ray-march | 2.07M px × 2 |
| FSR3 | 32 | 32 | 朴素 ≈820 MB（Accumulate 446+33、Reactivity 182、Inputs 108…） | Accumulate：16 tap + ~20 次 sin/px |
| Bloom | 10 | 10 | 朴素 ≈185 MB 读 + 27 MB 写 | — |
| Present | 1 | 1 draw | 16.6 MB 读 + 8.3 MB 写 | — |
| **合计** | **≈2,290** | **≈3,470** | **朴素带宽 ≈1.7 GB/帧（≈100 GB/s @60fps）** | — |

### 15.2 结构性归因排序（**未测量**，仅按 pass 数 × 结构复杂度排序）

1. **Surface 链**：pass 数占 96%；其中 classify（barrier 密度）+ geometry setup（bitonic+全量 reset）+ 7 certificate + 11 demand 是四个子块。
2. **FSR3**（32 pass，1:1 分辨率下无收益）+ **Bloom/全屏后处理**：第二梯队。
3. **VSM**：atlas 附件 134 MB/帧 + 逐像素 demand（2.07M invocation）——**即使 shadow 只覆盖一小块屏幕也全量执行**。
4. **LightCluster assign**：`clusters × lights`，随灯数平方级恶化。
5. **XeGTAO + Aerial + Sky**：三个全分辨率逐像素 pass，其中两个只影响间接光/远景。

### 15.3 必须补充的实测项（本次无法给出）

- `capacityEvidence()` 打印真实 `batchTileCapacity` / `batchCount` / `limitingPools`（验证 §7 推导）。
- `mainFrameGraphEvidence()` 打印 `totalPasses` / `executablePasses` / `resources`（验证 §2.4）。
- pass 级 GPU timestamp（区分四档 profiler 模式，且只在生产无 profiler 下取帧时间）。
- Surface 内部分解：临时把 `Surface/cell classify` / `geometry setup` / `certificate ×7` / `demand ×11` / `reconstruct` 各自用 timestamp 包住（或用 A/B 关闭）。
- 覆盖率分档：低覆盖（相机贴墙）/高覆盖（俯视全场）、近景/远景、静止/运动。

---

## 16. 方向判断：A / B / C

> **判断：C —— 核心执行模型已经走偏，需要大规模重构。**
> 但不是"推倒重写引擎"：GPU Scene、allocator、residency、FrameGraph 骨架、HZB、FSR3 移植、Atmosphere 都是可保留的资产。**走偏的是"每个 Surface 批次自洽"的调度模型 + 固定树 classify 的算法形态 + 缓存/证书层的中间表示。**

判据（每条都可回溯到源码）：

1. **性能形态是"固定成本 × 46 遍"**，而不是"热点函数慢"。任何单点 shader 优化都会被 ×46 稀释；反过来，把批次合并成 1–2 遍就能直接砍掉 ~95% 的 pass 数与 ~280 MB clear。
2. **容量预算反噬**：512 MiB envelope 的存在本身在制造 batchCount。这是"架构参数导致的性能损失"的教科书案例。
3. **中间表示 > 收益**：FieldStore 的 key 比 value 大 8 倍且 equality 要重新生成 witness；certificate 家族每批次 7 个 dispatch；dependency epoch 每帧全量 4 趟——这些只有在"批次数=1"时才可能划算。
4. **GPU-Driven 只剩一半**：可见性在 GPU，调度在 CPU，且 CPU 侧的调度量随分辨率线性增长（4K 时 ~9,000 pass/帧）。这不是可扩展执行模型。
5. **正确性红旗**：cluster fallback 灾难路径、VSM `pageConstants` 未写、dirty commit 溢出跳过、`previous = addresses` 断链。这些说明复杂度已经超出可维护范围（细节见 §17.5）。

**不属于 C 的部分**：GPU Scene / 资源驻留 / texture bank / VSM 虚拟页表设计 / FrameGraph 的依赖与生命周期模型 / 大气与 IBL 的 LUT 门控策略 —— 这些是合格的基础，应当保留并作为重构的落点。

---

## 17. Top 5 根因

### 根因 1：Surface 生产被"512 MiB envelope"切成 ~46 个自洽批次，每条链整体复制

- **具体位置**：`OEngine/src/gpu/SurfaceOptimizationCapacity.ts:102-240`（`planSurfaceOptimizationCapacity`，特别是 `:13-19`、`:116-122`、`:149-171`、`:225`）；`OEngine/src/render/surface/SurfaceCellClassifierPass.ts:230-372`（批次循环）；`OEngine/src/render/surface/SurfaceWorkRuntime.ts:197-253`（`consume` 闭包，每批次重建整条消费链）
- **当前实现**：`batchTiles` 从 4096 起，被 per-pool stride 压到 1024，再被 `failures()` 的 `retirementEnvelope` 检查（`scratch*2 + 224 MiB + 48 MiB ≤ 512 MiB`）逐格递减到 ≈707；`batchCount = ceil(tileCount/707)` = 46 @1080p、184 @4K。每个批次重新分配 workspace/setup/demand/arena，重新发射 48 个 pass、6 次 clear、5 次 copy。
- **为什么有问题**：批次的原因是人为字节预算，而不是设备上限；224 MiB 的 persistent（FieldStore+SignalStore+Variation）与实际帧需求无关却参与压制；`×2` 退休重叠使有效预算再减半。固定成本（pass 编码、pass 边界、clear、bind group、uniform staging）与批次数线性相乘，而这些成本与"真正要算的 shading 量"无关。
- **分类**：**架构问题**（容量模型决定执行模型）。
- **实际影响**：≈2,208 个 pass/帧、≈280 MB clear/帧、≈230 次 copy/帧、≈600 次 staging 上传/帧、≈6,000–13,000 次 bind group key 构造/帧；4K 下进一步 ×4。是"CPU 编码成本与 GPU 执行成本同时升高"的直接来源。
- **怎么验证**：(a) 打印 `capacityEvidence()` 的 `batchTileCapacity`/`batchCount`/`limitingPools`；(b) 临时把 `SURFACE_OPTIMIZATION_ENVELOPE_BYTES` 提到 1 GiB、并把 persistent 项从 envelope 计算中剔除，观察 `batchCount` 与帧时间变化；(c) `mainFrameGraphEvidence().totalPasses` 前后对比。

### 根因 2：固定树 classify 的"每平面重建 + 每平面 barrier"

- **具体位置**：`OEngine/src/shaders/surface_cell_classify.ts:134-286`（plane 循环，`:161-202` 树重建，`:216-227` 代表者前缀），`OEngine/src/shaders/surface_cell_group_validation.ts:171-263`（`cell_tree_validate_plane`，`:252-262` 字段循环）
- **当前实现**：21 个平面各自完整重建一次 16+4+1 树（3 层 × 4 子），并各跑一遍 `cell_tree_validate_plane`（含最多 15 字段 × 3 层归约）。每个平面约 88–102 次 barrier；单格最坏 ≈1,932 次 barrier；32,400 格 → 最坏 ≈6.3×10⁷ 次 barrier/帧。workgroup 只有 64 lane，实际有效宽度 21。
- **为什么有问题**：树的构造与区间算术**与平面无关**（几何部分完全可共享），却被复制 21 次；前缀扫描用"6 步共享内存扫描 + 12 barrier"完成本可用 `ballot + countOneBits` 一次完成的事；字段归约每个字段都重新走 3 层树。
- **分类**：**实现问题**（算法正确，组织形态极慢）。
- **实际影响**：classify 是 Surface 内部 barrier 密度最高的 kernel；64-lane workgroup + 千级 barrier 直接压死 occupancy 与 latency hiding，是"理论正确但实现极慢"的核心样本。
- **怎么验证**：把 classify 单独包 timestamp；(b) A/B：几何树从 plane 循环中提出（每格只建一次）、前缀换成 ballot 版本，比较同场景 classify 时间；(c) 统计每个 plane 是否真有 accepted 节点（若大多数 plane 直接落到 publication/fine 模式，说明成本结构错配）。

### 根因 3：FrameGraph 执行器 O(passes × resources) + 每 node 一个真实 pass 边界

- **具体位置**：`OEngine/src/framegraph/FrameGraph.ts:899-933`（逐 pass 全表扫描）、`:1171-1176` / `:885-949`（executeCompiled）、`OEngine/src/framegraph/ShadeGPUCommandContext.ts:285-304`（每 pass 一个真实 `beginComputePass`）
- **当前实现**：执行每个 pass 后遍历**整个资源注册表**（~2,000+ 项）做"是否是本 pass 的最后使用者"判断 → ~4.6M 次比较/帧；同时每个 FrameGraph node 都独立 `beginComputePass/end`，WebGPU 中不存在 pass 合并或 bundle 复用。
- **为什么有问题**：Surface 每批次有 18 个以上的"只换 pipeline"节点（11 demand stage、7 certificate、Store×6、finalize×3），它们之间只要求命令顺序（同一 storage buffer），不要求 pass 边界。pass 边界本身在 DX/Vulkan 后端有固定成本，且彻底阻断后续的 pass 合并优化。
- **分类**：**架构问题**（执行器抽象层级选错）+ CPU 实现问题。
- **实际影响**：~2,300 次 pass 开启/结束 + ~4.6M 次 JS 属性比较/帧；随分辨率线性增长。
- **怎么验证**：给 `executeCompiled` 加粗粒度计时（frame 级，不要开 per-pass）；把 11 个 demand stage 合并成 1–3 个 compute pass 后比较 `totalPasses` 与帧时间；用 `listExecutablePasses()` 统计可合并节点数。

### 根因 4：缓存/证书/依赖三层中间表示的成本已超过被优化对象

- **具体位置**：`OEngine/src/gpu/GpuSurfaceFieldStoreAbi.ts:6-23`、`OEngine/src/shaders/surface_field_request.ts:49-86`（equality 重新生成 key）、`OEngine/src/shaders/surface_store_publish.ts:28-86,133-134`（发布 ~60 atomic store 存 16 B）、`SurfaceCellClassifierPass.ts:288-328`（7 个 certificate dispatch/批次）、`SurfaceDependencyEpochPass.ts:61-62`（每帧 4 趟全量）
- **当前实现**：FieldStore entry 256 B、key 128 B、value 16 B；命中需要 4-way 探测 + 全 32 word 比较，而比较用的 key word 是**每次现算**的（20 分支 switch + 元数据间接）；发布 16 B 值需要 ~60 次 atomic store 且额外写一整个 certificate 块。SignalStore entry 352 B，key 288 B，其中 256 B 只服务 hash 与 equality。
- **为什么有问题**：缓存的收益是"避免一次 field 求值（数十条 ALU + 少量采样）"，而命中路径的成本是"最多 260 次依赖式 global load + 216 次 key 生成"；**key:value = 8:1，发布成本 8:1**。这类缓存在批次数=1 时可能勉强打平，在批次数=46 时每批次都要重建 demand/store 工作集，收益进一步下降。
- **分类**：**架构问题**（中间表示设计）+ 测量问题（**当前没有任何命中率计数器可读**，`surface_field_lookup.ts:126` 的 `certificate_hits` 恒为 0）。
- **实际影响**：每批次 7 个 certificate pass（×46 = 322 pass/帧）、每帧 4 趟 dependency epoch、FieldStore 120 MiB + SignalStore 64 MiB 常驻。
- **怎么验证**：加命中率计数器（真计数，不是恒 0）；A/B：cache on/off（Store `enabled=false` 已存在）比较 Surface 时间；A/B：certificate 家族整体跳过，比较 classify 的 accepted 分布与画质。

### 根因 5：默认开启的全帧级 pass 在 1:1 分辨率下不产生收益，且逐像素重算

- **具体位置**：`RendererCore.ts:357-363`（`xe_gtao_enabled/fsr3_enabled/bloom_enabled/...=true`）、`RendererConfig.ts:30`（`renderScale=1`）、`Fsr3UpscalerRuntime.ts:213-227`（只有显式 `enabled=false` 才旁路）、`VsmReceiverDemandPass.ts:169`、`AerialPerspectivePass.ts:85`、`PhysicalSkyPass.ts:86`、`XeGtaoMainPass.ts:93`、`VsmAtlasRasterPass.ts:200`
- **当前实现**：默认 render == output，但 FSR3 的 32 个 dispatch（含 23 个只做金字塔的 dispatch）照常运行；Bloom 10 个 pass 照常运行，composite 全分辨率往返；VSM demand 逐像素（2.07M invocation）+ 整个 4096² atlas load/store；Aerial 与 Sky 逐像素；XeGTAO 全分辨率。
- **为什么有问题**：这些 passes 的**几何/负载是"屏"而不是"工作"**：无论可见内容多少、阴影覆盖多少、是否真的在放大，都全额执行。而这一层的总 pass 数（~55–60）虽然远小于 Surface，但每一项都是全分辨率逐像素或全屏带宽，属于"Surface 优化完之后仍然压在帧上的固定成本"。
- **分类**：**测量问题**（默认配置从未被量化评估）+ 实现问题（缺少"无收益即旁路"的判断）。
- **实际影响**：朴素带宽 ≈1.35 GB/帧（其中 FSR3 ≈820 MB）；VSM atlas 134 MB/帧；三个全分辨率逐像素 pass（VSM demand/Aerial/XeGTAO）。
- **怎么验证**：逐项 A/B（`fsr3_enabled=false`、`bloom_enabled=false`、`xe_gtao_enabled=false`、`enableVsm=false`、`packed_visibility_hzb_enabled=false`），在**生产无 profiler** 下取帧时间；再叠加粗粒度 stage 计时。这是投入产出比最高的一次测量。

### 17.5 正确性红旗（不属于 Top5 根因，但必须与性能同批处理）

| 红旗 | 位置 | 后果 |
|---|---|---|
| cluster fallback 每 sample 遍历全 active light list（无 `color!=0` 早退） | `SurfaceLightingWorkPass.ts:200-217` | 局部溢出 → 该区像素雪崩；实测必须覆盖"高灯数 + 溢出"场景 |
| VSM `pageConstants` 似乎从未写入 | `VsmResources.ts:69,88`（无 writeBuffer 调用点） | 阴影静默错（level=0/固定 depth），但仍付完整采样成本 |
| caster 溢出 → dirty 页永不 commit | `VsmAtlasRasterPass.ts:36` | 脏页永远跳过 → 阴影整体返回 1.0 |
| `previous = addresses` 断链 | `SurfaceCellClassifierPass.ts:307` | proof-tile 阶段脱离声明依赖，只剩 WAW 兜底 |
| 生产变体缺 `color != 0` 早退 | 同上 | 空灯也付 BRDF |
| Point/spot 阴影在生产链被 stub 成 1.0 | `lighting_direct.ts:763-780` | 与 `shadow_enabled` 分支共存，语义误导 |
| `TemporalFabric` 只注册 2/12 张 history | `TemporalFabric.ts:31-36` | resize/camera-cut/device-loss 存在失效遗漏 |
| `GPUBufferAllocator.destroy()` 漏 `pending` | `GPUBufferAllocator.ts:162-173` | 设备销毁/重建时泄漏 |
| 能力门禁低估 classify 共享内存（768/9,216 vs 15,616） | `GpuSparseShadingCapability.ts:12,19` vs `GpuSurfaceCellTreeAbi.ts:23` | 在低限设备上可能创建失败或行为未定义 |
| 设备申请 16 storage buffer，而自报下限 10 | `RendererCore.ts:1139` vs `GpuSparseShadingCapability.ts:20` | 无法在 portable-limit 设备上运行 |
| 导出的 workgroup size 常量与同文件硬编码值失配 | `appearance_resident_kernel.ts:10,166` vs `:177` | 改常量即静默错配两个入口 |
| 用 `String.includes` 探测另一生成串决定发射哪段代码 | `surface_cell_classify.ts:9-15,186` | 改名即静默走错误分支 |
| `FrameProfiler.destroy()` 零调用点 → 下游 counters/readback-ring 释放链整体不可达 | `FrameProfiler.ts:1094`、`:1156` | 设备丢失重建（最多 2 次）场景下 owner 重复创建不释放 |
| `FrameGraph.fallbackOwned` 是外来资源的第二所有权集合，不记录第一所有者 | `FrameGraph.ts:396,485,533,555-572` | 设备丢失/重建路径难以推理 |
| CPU 领域反向依赖 render | `scene/Scene.ts:23` → `render/environment/PhysicalEnvironmentState.js` | 违反声明的依赖方向，Application World 被 render 类型污染 |

---

## 18. P0 / P1 / P2

### P0（现在必须做，3–5 项）

1. **把批次合并成"少批次或单批次"**：去掉 envelope 计算里的 persistent 固定项与 ×2 退休重叠；允许按 `maxStorageBufferBindingSize` 而非 512 MiB 预算决定 batchTiles；把"每批次自洽"的 workspace/setup 改为"整帧一份、按 tile 分段"。目标：`batchCount ≤ 2`。验证：`capacityEvidence()` + `mainFrameGraphEvidence().totalPasses` + 生产帧时间。
2. **classify kernel 结构重写**：几何树移出 plane 循环（每格一次）；两个 0/1 前缀换成 ballot/popcount；字段归约改为一次性合并所有 plane 的字段需求后再走树；workgroup 宽度按实际有效宽度重新评估。验证：classify 单独 timestamp + 覆盖率正确的 A/B 出图。
3. **FrameGraph 执行器两处硬修**：(a) 把 `entry.last === pass` 的释放改为"pass → 待释放列表"（编译期算好，执行期 O(1)），消除 O(passes × resources)；(b) 合并同一 storage-buffer 依赖链上的相邻 compute 节点（demand 11 → ≤3，certificate 7 → 1–2，Store 3+3 → 2）。验证：`totalPasses` 与 CPU 帧时间。
4. **修正确性红旗**：VSM `pageConstants` 写入（或删除该绑定并改为 GPU 侧计算）、dirty commit 溢出策略、cluster fallback 加 `color!=0` 早退 + 上限、`previous = addresses` 断链修复。验证：定向 oracle/数值测试 + 已知场景出图对照。
5. **建立可信测量基线**：生产无 profiler 的帧时间 + 粗粒度 stage 计时 + 逐项 A/B（FSR3/Bloom/XeGTAO/VSM）。**在做完 P0.1–P0.4 之前不要用它去证明收益**，但必须先把这条链路建起来，否则后续所有判断继续失真。

### P1（P0 完成后重新 profile 再决定）

- **补 ABI 布局断言**：在生成器里对每个结构体断言 `size/stride/field offset` 与 TS 侧常量一致（当前只有"文本存在性"检查），并把 6 组重复结构体（`LightList` ×4、`ClusterMetadata` ×3、`ClusterData` ×3、`AppearanceRoute` ×3、`OEngineDrawIndirectArgs` ×4、VSM page record ×6）收敛到单一 WGSL 片段。这属于**正确性**工作，不应等到性能验收。
- 修 `appearance_resident_kernel.ts:177` 的硬编码 `@workgroup_size(64)`（与 `:10`/`:166` 的导出常量失配）；把 `surface_cell_classify.ts:9-15` 的 `String.includes` 能力探测换成显式 feature 集。
- 修生命周期：`FrameProfiler.destroy()`（`FrameProfiler.ts:1094`）不可达 → 其下游 `GpuFrameCounters`/`GpuReadbackRing` 释放链整体不可达；补齐 `RendererCore.shutdown()` 与 `recoverAfterDeviceLoss()` 的 owner 释放清单（另有 7 个 owner 的 `destroy()` 为 0 调用点，见 §12.6(d)）。
- 修 pipeline/module 泄漏：`SurfaceCellClassifierPass.pipelines` 加容量上限与淘汰（当前按发布代数只增不减，泄漏 9 module + ~10 pipeline/代）。
- FieldStore 的去留：先加真命中率计数器，再 A/B。若命中收益 < 成本，直接删除并把字段求值内联。
- certificate 家族合并（3 家族 × 2 参数化 → 1–2 个 dispatch；`proofIndirect` 7 路 → 更少）。
- `SurfaceDependencyEpochPass` 从"每帧全量 directory"改为"实际变更集合"。
- VSM：atlas 附件从"整张 load/store"改为按 dirty 区域；allocate 的线性 slot 扫描改为空闲位图；raw demand 从逐像素改为按 tile/cluster。
- Cluster assign：把 `clusters × lights` 改成"每 cluster 只测试 AABB 覆盖的灯"（现在只做 frustum，没有 tile 关联）。
- FSR3：在 `render == output` 且无时间性需求时旁路；合并两条 pyramid；去掉 Accumulate 的重复全分辨率写；Bloom composite 并入 Present。
- 死代码整体删除（§19）与 ABI 死宽/空洞清理。
- 共享内存/能力门禁数字对齐（768/9,216/15,616）。

### P2（当前不要动）

- GPU Scene / 实例表 ABI（176 B）与增量同步：结构合理，且被多个 owner 依赖。
- Texture bank / geometry product bank / package segment 机制：复杂但方向正确，等虚拟纹理真正落地时再调。
- FrameGraph 的 20 字段 program key：先解决容量与 miss 频率，再谈重新设计 key。
- 大气 LUT 的量化门控（0.002 rad / 25 m）：设计正确。
- MeshletWork 24 B/三角形的记录宽度：需要与虚拟几何的实际 profile 一起改，不要单独动。

---

## 19. 建议直接删除 / 替换的模块（DELETE 清单）

### 19.1 直接删除（无 importer，已用 import 图证明）

**渲染/后处理死链**
- `render/passes/SharedColorPyramidPass.ts`（351）
- `render/passes/AutomaticExposurePass.ts`（339）、`render/passes/ColorGradingPass.ts`（138）、`render/passes/SharpenPass.ts`（112）、`render/passes/MotionBlurPass.ts`（210）、`render/passes/OcclusionConfidencePass.ts`（211）、`render/passes/AnalyticTemporalBaselinePass.ts`（86）、`render/passes/PackedSurfaceCounterPass.ts`（139）、`render/passes/PackedTransparentOitPass.ts`（553，OIT 未接入生产）
- `render/DynamicResolutionScaling.ts`（310）、`render/TemporalResolveContract.ts`（243）、`render/HierarchyOcclusionReference.ts`（166）、`render/TriangleFilterReference.ts`（144）、`render/MomentOitReference.ts`（132）、`render/DirectLightingReference.ts`（95）、`render/VelocityMatrices.ts`（110）、`render/RenderFeatureRegistry.ts`（132）
- `render/NssModel.ts` + `render/nss_model.generated.ts`（1520）+ `shaders/nss.ts`（416）
- `shaders/taa.ts`（243）、`shaders/temporal_classification.ts`（151）（TAA 运行时不存在）
- `shaders/ssr_trace.ts`(271) / `ssr_denoise.ts`(678) / `ssr_resolve.ts`(143) / `screen_space_diffuse_resolve.ts`(103) / `long_range_diffuse_provider.ts`(417)
- `shaders/automatic_exposure.ts` / `color_grading.ts` / `motion_blur.ts` / `sharpen.ts` / `occlusion_confidence.ts` / `shared_color_pyramid.ts` / `bloom.ts`（重复实现）/ `tonemap_hdr.ts` / `tonemap_sdr.ts` / `final_output_input.ts` / `specular_ambient_occlusion.ts` / `specular_correction.ts`
- `render/pipeline/Phase3Products.ts`(97)、`render/surface/SurfaceProducts.ts`(61)、`render/surface/WinnerPrimitiveInterpolation.ts`(234)、`render/surface/SurfaceCellReference.ts`(129，保留 93 行前的部分)、`render/PackedCameraUniform.ts`、`render/IblAlignment.ts`、`render/HilbertNoiseTexture.ts`
- `gpu/MeshletGpuPool.ts`(537) + `gpu/MeshletRangeAllocator.ts`（伴随的 3.67 MiB×2 CPU 预分配）+ `gpu/ShadowAtlas.ts`(463) + `gpu/TopLevelAccelerationStructure.ts`(178) + `gpu/GeometryBlasPool.ts`(246) + `gpu/GpuShadingProgramOracle.ts`(293) + `gpu/GpuSparseShadingFrameAbi.ts`(152) + `gpu/GpuSparseLightingAbi.ts`(66) + `gpu/GPUStatisticsHistory.ts`(29) + `gpu/GPUDefaultMaterialTextures.ts`(33)
- `geometry/GeometryCooker.ts`(1686)、`geometry/robustPredicatesUtil.ts`(109)
- `framegraph/GPUPerformanceTimer.ts`(180)、`framegraph/ReusableResourceManager.ts`(112)、`framegraph/index.ts`(30)
- `debug/VisibilitySurfaceMigrationGates.ts`(271)、`debug/GpuListCounterAccumulator.ts`(261)、`debug/GpuCounterAtomicAdder.ts`(78)、`debug/FormalPerfFreeze.ts`(319)、`debug/profiling/PerformanceCapture.ts`(328)、`debug/profiling/ChromeTraceExporter.ts`(109)
- `assets/codec/ReferenceTextureCodec.ts`(269)、`material/materialBucketId.ts`(157)、`camera/OrthographicCamera.ts`(64)
- `render/Renderer.ts`（3 行纯 re-export，应直接 import `RendererCore`）、`render/VisibilityBufferContract.ts`（2 行只含一个魔数 `VIS_MESH_CLEAR_SENTINEL = 1<<24`，唯一消费者是 `shaders/render_debug_view.ts:18`）
- `texture/ShadeImage.ts:143` 的 `ShadeImage as ShadeImageStub` 别名 + `texture/ShadeTexture.ts:12` 的第二次别名跳转（两层无行为别名）、`geometry/BoxGeometry.ts:26` 的 `MeshletsStub`（生产几何模块里的 stub 类）
- `gpu/GPUDatabase.ts` 中的 WGSL 生成器（256-600 行，`wgsl_gen_read_code:356`/`write_code:378`/`iterate_code:422`）——不是删除，而是**移出 `gpu/` 并与真实布局断言配对**

> 独立扫描（另一条 import 图路径，排除 `dist`/`.test-dist`/`.codex-temp`）给出 **49 个零 import 文件 / ≈12,000 行**的保守下界；本报告的全量扫描给出 73 文件 / 14,710 行。两者在全部重大条目上一致，差异来自入口 barrel/worker 与别名跳转的计入口径。**按 12,000–14,700 行、60–73 个文件估计是安全的。**

> 合计删除约 **11,000+ 行**（其中约 8,000 行是渲染/着色器路径）。删除后必须同步把 `OEngine/benchmarks/*.json`、`project/domains/*.yaml` 中引用它们的条目一并撤销，否则又会产生一层"文档孤儿"。

### 19.2 删除但要先替换（有真实功能，只是当前形态是纯负担）

- **FieldStore**（`GpuSurfaceFieldStore*`）：先用命中率证明，否则 DELETE；若保留，必须改成"便宜索引 key + bulk 发布"。
- **certificate 家族 7 dispatch**：合并为 ≤2；`proofIndirect` 从 7 路收缩。
- **`SurfaceDependencyEpochPass`**：从每帧全量改为变更驱动。
- **FSR3 的两条 pyramid 之一**（luma SPD 与 shading SPD 的输入重叠度需要在测量后决定保留哪条）。
- **`render/scale` = 1 时的 FSR3 全链**：改成条件旁路（保留时间性重建的最小集合）。
- **VSM 全 atlas 附件**：改为按 dirty 区域 attach/清屏，或把 page 级刷新做成小附件 + copy。

### 19.3 取消的中间表示 / 兼容路径

- `dispatchWorkgroups(1)` 的 finalize 节点（5 个/批次 → 0，改为前一级 kernel 写 indirect）。
- `SurfaceWorkRuntime.addToGraph` 的 6 个未使用输入与 `importUnlitProviders` 第二套绑定图。
- 双份 `GPUStatisticsHistory`、双份 128 MiB 常量、双份 group budget。
- `GPUBufferAllocator`/`GPUTextureAllocator` 的 `pending` 泄漏路径与坏掉的有序不变量（改成简单的 FIFO 淘汰）。

---

## 20. 最终问题：为什么用了现代设计，性能仍然这么差？

### 架构层

**执行模型 = "GPU 决定可见性 + CPU 逐批次编码完整着色链"**。GPU-Driven 只覆盖了"谁被看见"，没有覆盖"多少工作被提交"。批次是人为字节预算的产物（512 MiB envelope），与场景复杂度无关、与像素数线性相关；因此固定成本（pass 编码、pass 边界、clear、copy、bind group、uniform staging）被乘以 ≈46（1080p）/ ≈184（4K）。**这是"性能随分辨率恶化"而不是"随场景恶化"的原因**——也是为什么看起来像"某个 Surface 模块慢"，实际是整个调度形态错。

### GPU shader 层

**算法对，组织形态错。** 固定树在 plane 循环里重建 21 次；两个 0/1 前缀用 6 步共享内存扫描 + 12 barrier；字段归约每字段重走 3 层；64-lane workgroup 装 21 节点。单格最坏 ~1,932 次 barrier，32,400 格 → 最坏 6.3×10⁷ 次 barrier/帧。这不是"少了 10 条指令"的问题，是**把 O(1) 可共享的工作重复了 21 倍，并用 6 倍于必要的同步完成前缀**。

### 内存层

**逻辑 sparse，物理 dense。** FieldStore 120 MiB + SignalStore 64 MiB + Variation 32 MiB 常驻与需求无关；workspace 每批次按 100% 容量预留并 100% reset；`reset_cell_geometry` 按 `referenceCapacity` 全量重置；coverage 全屏扫；demand arena 的 8 个数组按 targets 全量分配。**同时 key 比 value 大 8 倍，entry 4–5.5 倍 cache line**，还有 5 处字段级死宽与 3 处同址重复存储。内存既宽又空。

### 调度层

**没有 pass 合并、没有 bundle、没有间接链收敛。** 每个 FrameGraph node 一个真实 pass，`dispatchWorkgroups(1)` 的收尾节点占 5 个/批次；间接参数用 16 B `copyBufferToBuffer` 发布（230 次/帧）；executeCompiled 每 pass 扫全资源表（~4.6M 次比较/帧）。调度层付出的成本与其收益完全脱钩。

### CPU 层

主要是**同一批固定成本的 46 倍放大**：~2,300 次 pass 编码、~600 次 staging 上传（每次 1 次 `queue.writeBuffer` + 1 次 `copyBufferToBuffer`）、~6,000–13,000 次 bind group key 字符串构造、~1,700 个节点对象与标签字符串、每帧 `Object.freeze` 的证据对象 + 4 次资源表 filter。此外还有 streaming 侧的每帧 `spread+filter+sort`。**注意：`HierarchicalWorkGenerator` 本身不是 CPU 热点**（这点与直觉相反，必须纠正）。

### 测量层

- 默认 profiler 关闭（正确），但**一旦打开就会给 2,300 个 pass 各加 2 个时间戳与一个 JS Proxy** → 测出来的形态本身就变了。
- **没有收益/命中率计数器**：FieldStore 命中率、memo 命中率、certificate 复用率、cluster fallback 触发率全部不可读（`certificate_hits` 恒 0）。
- 证据字段失真：重复计数器同值、`peak` 不是峰值、`limitingPools` 被覆盖。
- 因此**过去所有基于这些数字的优化判断都需要重新验证**；这也是为什么"Phase 一路做完，性能仍然不对"——因为中间没有可信的反馈通道。

---

## 21. 面向未来的架构承载评估

| 未来系统 | 当前底层是否承载 | 判断依据 |
|---|---|---|
| **Virtual Geometry** | **部分可承载** | 已有 page/slot/streaming/生产表（`GeometryProductSlotPool`、`GeometryPageScheduler`、`VirtualGeometryResidency`），但 MeshletWork 记录是每三角形 24 B、容量来自适配器而非场景、SSE 无预算反馈、slot pool 无淘汰。需要：per-cluster 记录 + 真正的预算反馈 + 淘汰策略 |
| **Virtual Texture** | **部分可承载** | texture bank + package segment + variation pool 已在，但**没有 LRU/压力淘汰**，2 GiB 预算永不触发，8 MiB 上传事务是硬限制。需要：真正的页表 + 淘汰 + 反馈 |
| **Virtual Shadow** | **方向对，实现有硬缺陷** | 虚拟页表/clip level/内容版本齐全，但 `pageConstants` 未写、dirty commit 溢出即停、整张 4096² 附件每帧 load/store。修好这三处才谈扩展 |
| **ReSTIR / SSGI** | **当前不可承载** | 需要低成本的 GBuffer/几何属性 + 稳定的 reservoir 存储 + 无雪崩的 light list。当前 Surface 是唯一几何来源且成本极高、cluster fallback 会雪崩、没有独立的 GBuffer 复用层 |
| **Atmosphere** | **可承载** | LUT 门控 + 量化 key 的设计是正确的，可以直接沿用 |
| **高级 Temporal / AI Upscale** | **需要先重建 temporal 层** | 12 张历史纹理只注册 2 张；FSR3 在 1:1 下空转；无 TAA/无 motion 复用契约的单一 owner。要接 AI upscaler，必须先有"历史所有权 + 失效域 + motion/coverage 契约" |
| **可持续扩展（新 pass / 新 feature）** | **当前不承载** | 每加一个 feature 就多一个 stage 字段与一条 Full-screen pass；批次模型使任何新 pass 都被 ×batchCount |

**结论**：**当前底层不适合直接作为上述系统的基础**，但也不需要在所有方向上重建。**最需要先固定的是三件事**：(1) 单批次/少批次执行模型（否则一切都被 ×46 稀释）；(2) classify 的共享工作与同步形态；(3) 历史/中间表示的所有权与失效域（否则 temporal 与 AI 放大无法落地）。

---

## 22. 诊断测试矩阵（**本次未执行**，供允许运行时按顺序执行）

> 原则：先证明成本归属，再动结构。所有测量必须在**生产无 profiler** 下取帧时间；stage/pass 级只在定位阶段使用，并且要单独报告 profiler tax。

### 22.1 第 0 步：先读真相（零成本）

| 动作 | 期望产出 | 判定 |
|---|---|---|
| 打印 `renderer.surfaceWork.capacityEvidence()` | `batchTileCapacity`/`batchTargetCapacity`/`batchCount`/`limitingPools`/`reservedBytes` | 验证 §7 推导（预期 ≈707 / ≈46 @1080p） |
| 打印 `renderer.mainFrameGraphEvidence()` | `totalPasses`/`executablePasses`/`resources` | 验证 §2.4（预期 ≈2,300 pass） |
| 打印 `gpuSceneEvidence()`/`memoryEvidence()` | 驻留字节 | 验证 §6.1 |

### 22.2 第 1 步：逐项 A/B（粗粒度，按收益排序）

| 编号 | A/B | 目的 | 必看指标 |
|---|---|---|---|
| A1 | `fsr3_enabled = false` | FSR3 在 1:1 下的真实成本 | 帧时间、`totalPasses`（-32） |
| A2 | `bloom_enabled = false` | Bloom 10 pass + 全分辨率往返 | 帧时间 |
| A3 | `xe_gtao_enabled = false` | 全分辨率 AO | 帧时间、画质差异 |
| A4 | `enableVsm = false` | VSM atlas 134 MB/帧 + 逐像素 demand | 帧时间 |
| A5 | `packed_visibility_hzb_enabled = false` | HZB 与 late recheck 的贡献 | 帧时间、可见性正确性 |
| A6 | `temporal_jitter_enabled = false` | 时间性依赖链 | 帧时间 |
| A7 | VSM demand 从逐像素改 8×8 tile（临时） | 证明逐像素 demand 的成本 | 帧时间 |

### 22.3 第 2 步：Surface 内部分解（关键）

| 编号 | A/B（临时开关或 timestamp 包裹） | 目的 |
|---|---|---|
| S1 | classify stage 0 / stage 1 分别计时 | 21 平面重复的真实占比 |
| S2 | 几何树移出 plane 循环 | 共享化收益 |
| S3 | 前缀 scan 换 ballot 版本 | 同步成本 |
| S4 | `reset_cell_geometry` 从全量 reset 改按需 | 100% 预留成本 |
| S5 | certificate 7 dispatch → 1 | 证书层收益 |
| S6 | demand 11 stage → 3 | pass 边界成本 |
| S7 | FieldStore `enabled=false` / SignalStore `enabled=false` | 缓存净收益（**必须先有命中率计数器**） |
| S8 | batchCount 人为限制为 1 / 2（放大 envelope） | 批次模型的总代价 |
| S9 | Geometry memo `enabled=false` | memo 收益 |

### 22.4 第 3 步：分档（P50/P95 与条件分层）

| 维度 | 档位 |
|---|---|
| 覆盖率 | 低（贴墙/近距离小物体）、高（俯视全场） |
| 相机 | 近景 / 远景 / 相机 cut / 静止 / 匀速运动 |
| 场景 | 静态 / 单实例移动 / 大量实例移动 / 流式加载中 |
| 分辨率 | 1080p / 1440p / 4K（验证"batchCount 随像素线性增长"的推断） |
| 灯数 | 少量方向光 / 100 灯 / 1000 灯（验证 cluster assign 与 fallback） |

每档记录：帧时间 P50/P95、`totalPasses`、`batchCount`、GPU stage 计时（粗粒度）、`limitingPools`。

### 22.5 禁止事项（避免测出假结论）

- 不要在 per-pass timestamp 全开的情况下得出性能结论。
- 不要只测单帧或只测平均；必须给 P50/P95。
- 不要在 `renderScale != 1` 时把 FSR3 的收益/成本混进 1:1 结论。
- 不要用"capacity 减少"当作"帧时间收益"（AGENTS 已经写明，这里再确认）。

---

## 附录 A：关键数字推导（可被一次 `capacityEvidence()` 证伪）

### A.1 Surface 批次容量

```
输入（Chromium 桌面常见值）：maxBufferSize = 256 MiB，maxStorageBufferBindingSize = 128 MiB
bindingLimit = floor(min(256,128) MiB / 256) * 256 = 128 MiB

1080p：tilesX = 240，tilesY = 135，tileCount = 32,400

batchTiles 初值 = min(32400, SURFACE_OPTIMIZATION_DEFAULT_BATCH_PIXELS/64 = 4096) = 4096

per-pool stride 限制（SurfaceOptimizationCapacity.ts:117-122）：
  addresses      216 B/target → floor(32 MiB / (216*64)) = 2427
  geometryHot    128 B/target → floor( 8 MiB / (128*64)) = 1024   ← 约束
  geometryCold   528 B/target → 1489
  fields         240 B/target → 1092
  demandAndRefs  192 B/target → 2730
  signals         96 B/target → 1365
  resolveMaps    176 B/target → 2978
→ batchTiles = 1024

failures() 检查（:149-158）在 t=1024 时：
  workspace  = 512 + 45,792*1024                      = 46.9 MB
  setup      = 65,536*512 + 524,288 + 32,768*528 + 512 = 51.3 MB
  geometryHot= 65,536*128                              =  8.4 MB
  geometryCold=65,536*528                              = 34.6 MB
  fields     = 65,536*240                              = 15.7 MB
  signals    = 65,536*96                               =  6.3 MB
  demand     = surfaceDemandLayout(65,536,256).bytes   =  9.2 MB
  → scratch ≈ 173.7 MB
  envelope   = scratch*2 + 224 MiB + 48 MiB            = 619.4 MB > 512 MiB  → 拒绝
逐格递减至 scratch ≤ 120 MiB：
  scratch(t) = 151,520*t + 18,577,392  →  t ≤ 707.8
→ batchTileCapacity = 707，batchTargetCapacity = 45,248，batchCount = ceil(32,400/707) = 46

4K：tileCount = 129,600 → batchCount = ceil(129,600/707) = 184
```

每 tile 的 workspace 字节（`surfaceCellWorkspaceLayout`）合计 ≈ **45,792 B**：
plans 568 + maps 2,016 + proof_results 6,656 + geometry_proofs 256 + screen_proof_slots 256 +
screen_field_proofs 3,840 + persistent_field_proofs 256 + field_known_masks 256 +
persistent_field_masks 256 + primitives 256 + addresses 6,144 + uv_witnesses 4,608 +
signal_witnesses 3,072 + field_references 7,680 + signal_references 3,072 + field_store_masks 256 +
signal_store_masks 256 + demands 1,024 + facts 1,024 + proofs 1,024 + proof_requests 1,024 +
pending_support 3,840 + proof_tile_counts 28 + proof_dispatch 112 + proof_tiles 28

### A.2 每帧 clear / copy 字节

```
workspace reset 4 段（surfaceCellWorkspaceResetRanges）:
  [0,512] + [geometryProofs, primitives-geometryProofs] + [fieldStoreMasks, demands-fieldStoreMasks] + [proofTileCounts,28]
  = 512 + 5,120*707 + 512*707 + 28 ≈ 3.99 MB / 批次  → ×46 ≈ 183 MB
demand reset 2 段（surfaceDemandResetRanges）:
  offsets.field_requests(=128+2048+262,144+131,072 words ≈ 1.58 MB) + targets*3*4(=543 KB) ≈ 2.12 MB / 批次 → ×46 ≈ 97 MB
合计 ≈ 280 MB/帧 的 clearBuffer 流量（不含 VSM atlas 的 134 MB load/store）
```

### A.3 FrameGraph 规模

```
每批次新增节点 ≈ 56（§2.3 表列 33 项，其中 certificate ×7、classify ×2、demand ×11 展开）
每批次新增资源 ≈ 40-60（workspace/setup/demand/arena/memo/各 settings + 每节点的 import）
固定节点 ≈ 120
→ 资源注册表 ≈ 2,000-2,800 项；执行序 ≈ 2,300
→ executeCompiled 的每帧扫描 ≈ 2,300 × 2,400 ≈ 5.5M 次属性比较
```

### A.4 classify barrier（最坏）

```
字段平面（planes 0-14，signals=false）：7（循环固定）+ 2（validate 入口出口）+ 60（15 字段×4）
  + 2 + 12（代表者前缀）+ 3（:212/:238/:269）+ 1（storageBarrier）+ 1（:285） = 88
signal 平面（planes 15-20，signals=true）：7 + 2 + 16（provider 前缀）+ 60 + 2 + 12 + 3 + 1 + 1 = 102
单格两 stage = 15*88 + 6*102 = 1,932
× 32,400 格 = 62,596,800 次 barrier（最坏；实际取决于 dependencies 掩码与 mode）
```

---

## 附录 B：证据索引（按主题）

| 主题 | 关键文件:行 |
|---|---|
| 帧入口 | `render/pipeline/RendererCore.ts:1310-1648` |
| 单 encoder / 单 submit | `framegraph/ShadeGPUCommandContext.ts:165,461-486`；`render/FrameCoordinator.ts:32-88` |
| FrameGraph 编译/执行 | `framegraph/FrameGraph.ts:728-842,885-949` |
| 每 pass 全表扫描 | `framegraph/FrameGraph.ts:927-932` |
| 图缓存容量与 key | `render/pipeline/RendererCore.ts:348-349,1576-1585`；`render/program/FrameProgram.ts:282-295` |
| Surface 批次循环 | `render/surface/SurfaceCellClassifierPass.ts:230-372` |
| Surface 消费链 | `render/surface/SurfaceWorkRuntime.ts:197-253` |
| 批次容量计划 | `gpu/SurfaceOptimizationCapacity.ts:102-240` |
| workspace 布局/重置 | `gpu/GpuSurfaceCellPlanAbi.ts:33-106` |
| classify 主循环 | `shaders/surface_cell_classify.ts:117-294` |
| 树验证与字段循环 | `shaders/surface_cell_group_validation.ts:171-263` |
| geometry setup（bitonic/reset/memo） | `shaders/surface_cell_geometry_setup.ts:100-229`；`render/surface/SurfaceCellGeometrySetup.ts:46,89-128` |
| demand 11 阶段 | `render/surface/SurfaceDemandPass.ts:48-172` |
| certificate 7 路 | `render/surface/SurfaceCellClassifierPass.ts:288-328` |
| Store 发布 | `render/surface/SurfaceStorePublishPass.ts:40-80`；`shaders/surface_store_publish.ts:28-134` |
| FieldStore/SignalStore ABI | `gpu/GpuSurfaceFieldStoreAbi.ts:6-23`；`gpu/GpuSurfaceSignalStoreAbi.ts:5-21` |
| 集群 fallback | `render/surface/SurfaceLightingWorkPass.ts:200-217` |
| 直接光 BRDF | `shaders/lighting_direct.ts:232-320` |
| VSM 常量与附件 | `render/vsm/VsmCapabilities.ts:40-72`；`render/vsm/VsmAtlasRasterPass.ts:36,200`；`shaders/vsm_sampling.ts:100-127` |
| light cluster assign | `shaders/light_cluster.ts:503-543` |
| FSR3 全链 | `render/passes/fsr3/Fsr3UpscalerRuntime.ts:213-307` |
| Bloom | `render/passes/BloomPass.ts:148-169` |
| Present | `render/surface/SurfacePresentPass.ts:155-186` |
| HZB | `render/HierarchicalZBuffer.ts:137-237` |
| 工作生成 | `render/HierarchicalWorkGenerator.ts:876-1030` |
| 光栅 draw 循环 | `render/MeshletBucketRaster.ts:151-159` |
| 内存分配器缺陷 | `gpu/GPUBufferAllocator.ts:90-98,162-173,195-316` |
| Profiler 默认关 | `debug/FrameProfiler.ts:409,711-712,831-838` |

---

## 附录 C：本次审计的自我限制

1. **没有实测**：所有"性能"结论是结构性核算与代价模型；任何"X 比 Y 慢"的断言都标注了推导链，而不是测量。
2. **批次数量依赖设备上限**：本报告用 `maxStorageBufferBindingSize = 128 MiB` / `maxBufferSize = 256 MiB`。不同适配器会得到不同的 `batchTileCapacity` 与 `batchCount`，但**结论的形态（batchCount 随像素线性增长、每批次复制整链）与具体数值无关**。
3. **两处高危缺陷需要实机确认**：VSM `pageConstants` 未写、cluster fallback 的实际触发率。源码证据强，但语义后果（阴影是否正确、fallback 是否常发生）需要运行验证。
4. **barrier 的真实代价**未被量化：本报告给出的是 barrier **数量**与其在源码中的位置；真实时间取决于 occupancy、SM 数与 barrier 实现。
5. 本报告没有修改任何既有文件；唯一新增文件为本报告。
