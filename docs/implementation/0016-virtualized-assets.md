# 0016 Runtime-first Virtualized Assets 实施

Status: active

Owners: Web Runtime Cooker、geometry product/admission、`GpuAssetStore`、`GpuRenderWorld`、GPU hierarchy/work/visibility、texture residency、validation host

## Outcome

保留应用侧 `load("scene.glb")` / glTF 体验，把 Web Runtime Cooker 作为默认生产路线：浏览器通过 WASM + Worker 有界、渐进地产生 Geometry Product，首个完整 bootstrap revision 可立即进入现有 GPU-driven 管线，后续 Page 和 richer revision 在后台提升质量。Native Offline Cooker/OEGPACK 是独立第二路线，但从 Geometry Product admission 开始复用同一 residency、hierarchy/work、VisibilityKey、Sparse Shading 和 `MainRenderPipeline`。

完成态不是“能解析/上传一个 Page”，而是两类 producer 都形成以下闭环：

```text
GLB/glTF -> Web Runtime Cooker ─┐
                               ├-> Geometry Product admission
OEGPACK -> Offline adapter ─────┘          |
                                          v
                                Virtual Geometry Residency
                                          |
                         GPU hierarchy -> demand/fallback
                                          |
                         indirect raster -> VisibilityKey
                                          |
                              Sparse Shading / lighting
```

## 权威输入与当前基线

- 长期取舍：[ADR-0016](../adr/0016-virtualized-assets.md) 及 A/B/C/D。
- Producer 合同：[Geometry Product V1](../specs/geometry-product-v1.md)。
- Runtime 合同：[Virtual Geometry Runtime V1](../specs/virtual-geometry-runtime-v1.md)。
- Offline 文件合同：[OEGPACK V3](../specs/oegpack-v3.md)。
- 能力与证据：[WEBGPU](../WEBGPU.md)、[VALIDATION](../VALIDATION.md)、[ADR-0014](../adr/0014-browser-validation-and-performance-host.md)。

当前已有：Native OEGPACK writer、TS Range reader/validator、`GeometryAbiV3.ts`、`GeometryBootstrapResidencyV3`、V2 GeometryAssetPackage/GeometryCooker、`AssetWorkerPool`、GpuAssetStore/GpuScene/GpuRenderWorld、GPU hierarchy/work、`MeshletBucketRaster`、VisibilityKey 和 Sparse Shading；S1 已加入 Product-aware admission、hierarchy/work/raster 生产接线、真实 Chrome GPU page/group/meshlet 解码 oracle，以及 Sparse Shading 的 Product metadata/page-bank binding 和 virtual work geometry lookup plumbing。

当前已补齐第一批：Producer-neutral Product TS 类型/validator、OEGPACK adapter、Product-aware bootstrap/page heap/location table、GLB Range source、按 accessor 精确 Range 的 compact scene catalog/cook units、带 source/WASM/output budget 与取消/credit 的 `WebCookCoordinator`、generation-filtered Dedicated Worker transport、把 live descriptor/page 事件映射到 revision source 的有界 Web Product provider、versioned CookSession credit seam、PageDemand ABI 与 Product GPU location mirror；S2a 又抽出 Native/Web 共同消费但不拥有容器语义的 `DecodedGeometryProductV1`，加入 browser-first WASM canonical/recipe/result ABI、Nyx geometry-builder C++ target、逐页 credit-copy wrapper、native determinism/negative oracle、GLB canonicalizer、CPU/WASM Worker host 与异步 module entry。当前 S3 admission seam 已将 Web Product provider 接入共享 `GeometryProductAdmissionController` 和 `VirtualGeometryResidency`：完整 activation cut 后才发布，失败保留旧 active revision，replacement 旧 generation 延迟到显式安全边界回收，取消与 source ownership 有界且可验证。真实 Emscripten module/wasm artifact 已纳入源码树并接入 Dedicated Worker；它们仍不构成 production GPU demand/readback 闭环，仍缺 portable-pool/isolated-pthreads、真实 GPU demand producer/consumer 的浏览器证据、ancestor fallback 和 device-loss recovery 故障证据，以及所有 consumer 的 V2 cutover。

`AssetWorkerPool` 可复用其优先级、并发、estimated bytes、Transferable 和取消原则，但“一项 task 返回一次 Promise”的模型不能承担持续 CookSession；不要在其上堆无限 Page event。

## Nyx 移植工作流（强制）

本实施的几何、层次和 streaming 算法不允许重新设计简化版。唯一移植基线是用户提供的本地 Nyx 只读快照（核验日期 2026-09-16）；该目录无可验证 `.git` metadata，因此不把声明的 `moonlovelj/Nyx@bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b` 当作已验证 commit。实现分支必须在提交前重新计算下表 hash，发生变化就暂停并重新审查：

| Nyx source | SHA-256 | 移植任务 | 主要落点 |
| --- | --- | --- | --- |
| `MiniEngine/Model/MeshletBuilder.cpp` | `b749346382b0f9a1574f0c0566a2860bff2acfbc6521df6f153a42653c81e84a` | `Build`、`BuildLOD0Meshlets`、`BuildMeshletsFromIndices`、`GeneratePositionRemap`、`GroupMeshlets`、`BuildVertexLocksByGroups`、`SimplifyGroup`、`SerializeGroup`、`BuildStreamingData`、`BuildHierarchy`、`ValidateBuild` | Web WASM cooker + Native cooker + Product validator |
| `MiniEngine/Model/ModelConvert.cpp` | `8bdf016e0f36e70f0c1aa46d679ab0e1b4f57ea30e0748a6549675620cc8a059` | `WalkGraph`、`ParallelCompileMeshes`、`BuildModel`、`SaveModel` 的 scene/material/mesh 归属和结果组装 | GLB Range canonicalizer、Offline importer |
| `MiniEngine/Model/MeshletStructs.h` | `1edfaa25d2e12067b98d93599142b110e2509be96471fa09a00b029484ef9b23` | Group/Meshlet/Hierarchy 字段语义和布局不变量 | Product V1 decoded profile / ABI mirror |
| `MiniEngine/Model/GeometryStreaming.cpp/.h` | `acb3aa4786eb6367e92b99e9e295c83e0aade516d59578f23ff38496f838a072` / `4bee73ffc0c29ad7670bb7c5ac1567a281b3f33271adfc534d834dc88897c264` | `Initialize`、`PinRootPages`、`Update`、`SyncMemoryAndAddressTable`、`EnqueueAsyncLoad`、`OnPageIOComplete`、`ImmediateEvict` | Product provider、residency、delayed feedback、retire queue |
| `MiniEngine/Model/Shaders/DAGCull.slang` | `6534dd8794248d693acd07488653a625df3b4fac11117f96537a43857dcfee7e` | `ProcessNodeBatch`、`ProcessMeshletBatch`、`computeMain` | WGSL hierarchy/work/demand consumer |
| `MiniEngine/Model/Shaders/VBufferMesh.slang` | `9f374a2437d5ab939ae4d98289c150097bdab17305191ff97abf3fd1d13c621d` | `BuildVertexOutput`、`meshMain`、`pixelMain` | 现有 MeshletBucketRaster / VisibilityKey 适配 |

每一行都必须产出 function map、输入/输出对照、保留不变量、OEngine/WebGPU 差异、fallback/lifecycle、许可证 notice 和 differential/negative oracle。允许把 C++/Slang 翻译为 WASM/WGSL，允许把 DX12 mesh shader、bindless、fence 和 GPU address 映射到 WebGPU 的 buffer/indirect/bank-slot-generation；不允许删除 Nyx 的 seam/attribute lock、attribute-aware simplification、refine/error 传播、BVH/DAG wavefront、HZB/SSE、resident ancestor fallback、request mask、page 独立校验或 local primitive identity。

“Web 与 Offline 不共用源码”只表示实现组织可以独立；两边都必须完成上述 Nyx 算法阶段的逐项移植。`portable-single`、`portable-pool` 和 `isolated-pthreads` 只改变执行 profile，不得成为简化算法的借口。

## 已锁定的实现决策

1. Web 与 Native Cooker 实现独立；共享代码是可选优化，不是交付条件，但两边都必须按本节 Nyx source map 完整移植相关算法。
2. 第一版 Web 输出 `oengine-vg-v1-v3-decoded`：与 OEGPACK V3 decoded Page/Hierarchy/Group/Meshlet ABI 兼容，但不生成完整 OEGPACK。
3. bootstrap 是独立完整 revision；已 offer 的 descriptor/ID/hash immutable。最终质量用新 revision 原子替换，不能修改活跃 DAG。
4. Provider 只产 CPU descriptor/page；GPU object、heap、地址表、publication 只属于 render/GPU owner。
5. 默认上传先用 `queue.writeBuffer` 与批量 publication；staging/GPU decode 只在同 workload benchmark 后引入。
6. 不在帧循环等待 `mapAsync()`、`onSubmittedWorkDone()` 或 Worker；feedback/readback 和 retirement 都延迟推进。
7. pthread/SAB 是 cross-origin-isolated 高吞吐 specialization，不是 correctness 前提；非隔离多 Worker 产生同一 Product 合同。
8. GLB Range 是 URL 主路径；服务器返回 200 或不支持 Range 时可退为有预算的整包 source。超预算必须显式失败或选择预处理 source，不能静默双份常驻。
9. OEGPACK、Web cache 与 live product 不按 PageID 混拼。替换必须是完整新 revision/product transaction。
10. 不创建 Web renderer、OEGPACK renderer 或 Nyx backend；迁移完成后只保留一个 geometry consumer。

## 计划中的 owner 与代码落点

下列路径是实现归属，不是公开 API 承诺；落地时仍需遵守更近的 `AGENTS.md`。

| Owner | 建议位置 | 职责 | 明确不做 |
| --- | --- | --- | --- |
| Product types/validator | `OEngine/src/assets/geometry-product/` | descriptor/page 类型、binary mirror、跨表 validator、provider interface | GPU allocation、HTTP、Cook 算法 |
| OEGPACK provider | 同上 `OegPackProductProvider.ts` | `OegPackV3` -> Product descriptor/page reader | 独立 residency/renderer |
| Streaming source | `OEngine/src/loaders/gltf/streaming/` | GLB header/JSON/BIN Range、`.gltf` URI source、fallback budget | GPU ownership、全场景对象常驻 |
| Web cook coordinator | `OEngine/src/assets/web-cook/` | session、priority、credit、Worker/thread budget、cancel/restart | mesh algorithm、GPU publication |
| Worker protocol | `OEngine/src/assets/web-cook/protocol/` | versioned command/event、session generation、Transferable ownership | Product/GPU ABI 重复定义 |
| Browser-first WASM cooker | `OEngine/tools/oengine-web-geometry-cooker/` | import/canonicalize、meshlet/group/hierarchy/page、bootstrap/final revision | Native CLI wrapper、OEGPACK writer 要求 |
| Admission/residency | `OEngine/src/gpu/VirtualGeometryResidency.ts` 及 ABI 文件 | reservation、page state、heap、upload、mapping、demand、eviction、evidence | source parsing、最终可见 CPU list |
| Renderer consumer | 现有 `GpuAssetStore`、`GpuRenderWorld`、`HierarchicalWorkGenerator`、`MeshletBucketRaster` | active product generation、fallback/demand、现有 raster/Visibility | 新 backend |
| Public facade | 现有 loader/scene adapter，最终由 `OEngine/src/index.ts` 暴露 | 保持 GLB/glTF load 入口与取消/错误语义 | 暴露内部 Page/GPU 类型 |

`load_gltf()` 的最终 facade 应返回可加入 Scene 的 Runtime Asset 引用；Promise 只表示 scene metadata 和首个可用 CPU-side bootstrap product 已准备，而不是 GPU 已完成。真正 GPU activation 由 Scene/GpuRenderWorld admission 完成。Loader 可以持有 Provider/session handle，但不能持有 GPUBuffer 或 physical slot。

## Web CookSession 设计

### 线程拓扑

提供同一 versioned Worker protocol 的三种执行 profile：

| Profile | 用途 | 约束 |
| --- | --- | --- |
| `portable-single` | 最小 correctness/oracle 与故障隔离 | 一个 Dedicated Worker、单线程 WASM；不作为最终吞吐目标 |
| `portable-pool` | 非隔离部署 | 多个 Dedicated Worker，各自单线程 WASM；只分发独立 asset/material-domain/shard，不共享可变 DAG |
| `isolated-pthreads` | 高吞吐候选 | 一个 coordinator Worker + 预热 pthread/SAB pool；要求 `crossOriginIsolated`、COOP/COEP 与跨域资产策略 |

Runtime 根据 capability/deployment 选择 profile；选择只影响 Provider 内部，不影响 Product/Residency/Renderer。首个实现先建立 `portable-single` oracle，再交付另外两种并用固定 workload 决定默认。不能让 `portable-pool` 中每个 Worker 再开 pthread pool。

全局并行上限由 WebCookCoordinator 计算：`activeWasmThreads + activeSingleThreadWorkers <= configuredCookConcurrency`。默认值从 `navigator.hardwareConcurrency` 扣除 render/main-thread reserve 后 clamp，具体 clamp 只能由真实设备 PERF 固化；每个 session 不得自行创建“核数级”线程。

### Versioned protocol

内部命令至少包括：

```text
CreateSession(sessionId, generation, recipe, runtimeProfile, budgets)
OpenSource(source descriptor / transferable metadata)
SetSourcePriority(asset/shard key, score, camera hint revision)
RequestPages(ProductID, revision, PageID[], priority)
GrantOutputCredits(blockCount, bytes)
ReturnOutputCredits(blockCount, bytes)
CancelScope(session/product/shard)
DisposeSession
```

事件至少包括：

```text
SceneCatalogReady
RevisionOffered(descriptor transport)
PageReady(key, hash, exclusive ArrayBuffer)
Progress(stage, units, bytes, timings)
RecoverableFailure(scope, code, retry metadata)
FatalSessionFailure(code, diagnostics)
```

所有命令/事件携带 protocol version、session id 和 session generation。迟到 generation 在进入 Product admission 前丢弃。`PageReady` 只有取得 output credit 才能发送；GPU owner 消费或拒绝 buffer 后返还 credit。Worker crash/WASM OOM 使 generation 整体失效，不尝试继续使用其 descriptor 内部指针。

### Source 与任务粒度

GLB URL 主路线：

```text
12 B GLB header
  -> chunk headers
  -> exact JSON chunk Range
  -> Worker JSON parse / compact scene catalog
  -> resolve bufferView/accessor/image ranges
  -> visible-first bounded range coalescing
  -> canonical primitive/domain cook units
```

每个 cook unit 必须有 source byte estimate、WASM peak estimate、output page estimate、priority、AbortSignal 和 owner。不能把完整 GLB 作为一个 Worker task，也不能通过 Emscripten 虚拟文件系统调用 Native CLI 再读回完整 pack。

Range response 必须验证 status、`Content-Range`、identity encoding 和精确长度。200 fallback 只在 `wholeSourceFallbackBytes` 预算内接受；重定向、credential、CORS/CORP 和 content validator 纳入 source identity。`.gltf` 的外部 buffer/image URI、data URI、sparse accessor、interleaved stride 和 normalized attribute 在对应 slice 显式交付，不能由 GLB proof 暗示支持。

### Bootstrap 与 richer revision

bootstrap revision 必须：

- 覆盖 scene catalog 中被准入的每个可见 asset/shard；
- 具有完整 root/hierarchy/Group/Page/VertexFormat 和 activation cut；
- 在不读取非 activation page 的情况下产生合法 coarse pixels；
- 保守 bounds/error，material domain 不跨 Group；
- 在 offer 后 immutable。

Runtime Cooker 后台可以构建更高质量 revision。若算法必须完成全局 hierarchy 才能冻结 ID，则在完成前只保留 bootstrap revision；不得暴露半完成 DAG。大单 primitive 若仍需完整 accessor 才能 bootstrap，先记录为明确限制；后续通过确定性 spatial shard slice 解决，而不是靠无限 Worker/内存。

### 联合背压账本

Coordinator 必须记录并限制以下 live bytes：

```text
source ranges fetched/not consumed
+ Worker message ownership
+ WASM committed/peak memory
+ transferable output blocks
+ Product pages verified/not uploaded
+ per-frame upload queue
+ cache write queue
+ GPU resident/pinned/retiring reservations
```

初始硬上限只有仓库已有全局预算：upload 8 MiB/frame、readback 256 KiB/frame、总 resident 512 MiB、transient 256 MiB。Geometry 在这些总预算中的份额、source/WASM/output 上限由 S2/S3 的峰值证据固化；在此之前使用显式可配置值和 admission failure，不把猜测写成永久常量。

## Runtime 状态与帧集成

### Admission transaction

1. Provider offer immutable descriptor。
2. Validator 检查 profile、table、hash/range、activation cut 和依赖。
3. Admission 预留 metadata、activation slots、pinned/resident 与 transaction peak budget。
4. Scheduler 请求 activation pages；Provider 可以 Range/decode 或 live cook。
5. Residency 校验 exclusive page buffer，分配 slot，按帧 upload budget 编码 page 与 location update。
6. activation cut 全部 submitted/resident 后，与 asset/material/scene revision 一次 publication。
7. future `FrameContext` 只见新 product generation；失败则回滚 reservation。

### 单帧闭环

```text
active product table + page location table
  -> GPU hierarchy traversal/SSE
  -> desired Group resident?
       yes -> existing bounded raster work
       no  -> resident ancestor/bootstrap work + deduplicated PageDemand
  -> indirect MeshletBucketRaster
  -> VisibilityKey/Sparse Shading

previous feedback ring map completion
  -> CPU scheduler dedupe/stale filter
  -> Provider readPage/cook
  -> verify/upload within next-frame budgets
  -> future publication
```

Demand readback、page upload 和 retire completion 都不能阻塞当前帧。`queue.writeBuffer` 的 offset/size 保持 4-byte aligned；多 page 在同一帧批量编码/提交，不为每页 submit。

### Replacement 与 retirement

bootstrap Web revision、richer Web revision 或 Offline product 互换都走同一事务：新 descriptor 使用新 product generation，完整 activation cut resident 后切换 scene root/product reference；旧 generation 先从未来帧不可见，再进入 submission-indexed retire queue。任何失败保留旧 active revision。

device loss 丢弃全部 GPU publication 与 pending upload，重建 device/pipeline/heap/table 后从有效 Provider 重新准入 activation cut。旧 device 的 `GPUBuffer`、completion 和 generation 不可复用。

## Slices

每个 slice 都必须以真实 producer -> production consumer 结束。表中“删除/收敛”是 slice 的组成部分，不是可选清理。

### S1 · Producer-neutral bootstrap 到生产 Visibility

可运行结果：用现有 OEGPACK artifact 作为最短 test producer，经 `OegPackProductProvider -> GeometryProductAdmission -> V3-compatible bootstrap residency -> existing hierarchy/work/raster` 输出真实 VisibilityKey 和 shaded pixel。这里使用 Offline artifact 只为建立共同边界，不改变 Web Runtime-first 产品优先级。

实施项：

- 建立 Product V1 TS 类型、descriptor/page validator、binary page record mirror 和 conformance errors。
- 实现 OEGPACK 到 Product 的确定性 adapter；file offset/codec 不越过 Provider。
- 将 `GeometryBootstrapResidencyV3` 拆为 Product-aware 最小 admission/heap owner；地址表带 product generation。
- 为现有 hierarchy/work 提供 V3-compatible root/Group/page address view；接到 `MeshletBucketRaster` 和 VisibilityKey，不建新 raster pass。
- 加入 bootstrap pinned budget、失败回滚、destroy 和 evidence counters。

退出证据：CPU golden/corruption/conformance；真实浏览器 screenshot/Visibility readback；GPU work/invalid generation/page counters；feature-off 无额外 heap/pass/readback；OEGPACK candidate 的第一个 production consumer 条件满足。

删除/收敛：删除只验证 upload 的 `GeometryBootstrapResidencyV3` 旁路或将其变成新 owner 的薄测试 adapter；禁止两套 V3 page bank。

### S2 · Web GLB -> bootstrap Product -> 同一像素路径

可运行结果：URL `.glb` 不经 Native/OEGPACK，在 Dedicated Worker + browser-first WASM 中产生完整 bootstrap revision，经 S1 相同 admission 和 renderer 出图；`load_gltf()` facade 保持可用。

实施项：

- 实现 GLB header/JSON/BIN Range source、精确 206 validation 和有预算 200 fallback。
- Worker 解析 JSON 并返回 compact scene catalog；按 node/material/accessor dependency 形成 visible-first cook units。
- 新建独立 Web WASM cooker 的 Nyx import/canonicalize、meshlet、Group、LOD simplification、refine/error、hierarchy、page packing 完整移植；首个可运行 profile 可以限制输入范围，但不得删除算法阶段；输出 V3-compatible decoded profile，不写 OEGPACK。
- 实现 `portable-single` CookSession protocol、session generation、Abort、output block credit 和 exclusive buffer transfer。
- 把 scene node/material reference 与 Product Provider 挂到 Runtime Asset；GPU owner 仍由 GpuRenderWorld 创建。

退出证据：GLB Range 与 200 fallback 都有首个像素；主线程无 bulk JSON/hash/cook；bootstrap revision 独立可绘制；Nyx function map 与 meshlet/Group/LOD/refine/hierarchy differential oracle 通过；取消、Worker crash、WASM OOM、非法 source 不发布；报告 catalog/bootstrap/first meaningful frame 时间与峰值内存。

删除/收敛：主路线不再调用 `GltfLoader.loadFromUrl()` 的 full `arrayBuffer()` + V2 cook 组合；保留未完成 Nyx function map 的临时开发选择器必须标明 consumer，并在 S7 删除。

### S3 · 并行 Runtime Cook 与 progressive richer revision

可运行结果：Web 主路线在全局预算下并行 Cook，多 asset 场景先显示 bootstrap，后台 offer 一个 immutable richer revision；即使尚无 GPU demand，activation/refinement page 也能按 bounded prefetch 渐进就绪。

实施项：

- 实现 `portable-pool`，只切分独立 asset/material-domain/确定性 shard；合并结果时稳定排序并验证 byte determinism。
- 实现 `isolated-pthreads`，预热 pool、固定/受控 WASM memory growth，并验证 COOP/COEP/CORS/CORP 部署。
- Coordinator 统一限制 thread/Worker/session、source/WASM/output/upload bytes，加入 asset fairness 和 age。
- richer revision 的 descriptor 仅在 identity 全部冻结后 offer；activation cut 齐备前不请求 scene switch。
- 比较两种并行 profile，按同一总线程预算报告 throughput、TTFMF、main-thread cost、copy、peak memory 和稳定帧抖动。

退出证据：不同 Worker/thread count 下同 profile byte-identical；credit 耗尽时所有上游稳定暂停而非增长；两种部署 profile 输出相同 conformance；revision build 失败时 bootstrap 持续渲染；选择默认 profile 的 PERF artifact。

删除/收敛：移除无背压的 Page event 队列、每 session 私有核数级 pool 和任何“共享 mutable DAG 跨独立 Worker”的实验代码。

### S4 · GPU Page demand 与异步 residency 闭环

可运行结果：GPU traversal 选择 desired LOD；缺页时画 resident ancestor/bootstrap 并写 `GeometryPageDemandV1`，延迟 readback 驱动 Provider 生产/读取 Page，后续帧 GPU 直接消费新 resident page。

实施项：

- 实现 page location ABI、product table slot/generation 和 WGSL/TS oracle。
- 在 `HierarchicalWorkGenerator` 加 desired/fallback/demand，使用 all-or-nothing bounded reservation；不让 CPU重建可见 Meshlet。
- 实现 GPU 去重 bitset、Demand queue header/record、overflow/fallback counter 和 rotating readback ring。
- 实现 scheduler 的 stale filter、dedupe、priority、retry、Provider request、hash/payload verify 和 8 MiB/frame batch upload。
- Web Provider 把稳定 PageID demand 映射到 cook unit；OEG Provider 映射到精确 Range/decode。

退出证据：`GPU demand -> delayed CPU scheduling -> async producer -> upload/publication -> GPU consumer` 浏览器闭环；缺页全程像素连续；overflow、重复/过期 demand、source failure、readback/upload budget、camera cut 都有 counter/截图或 readback。

删除/收敛：删除 CPU 最终 LOD/Meshlet 选择 seam、整包预载伪 streaming 和每页独立 submit。

### S5 · Replacement、eviction、取消与 device loss

可运行结果：bootstrap -> richer Web revision、Web -> Offline revision 均能原子替换；非 pinned page 可安全驱逐；replace/cancel/aborted submit/device loss 不暴露旧数据。

实施项：

- 建立 product/page/slot generation 和 submission-indexed retire queue。
- 实现 admission preflight、transaction peak、rollback、active revision 保留和 stale async result 丢弃。
- 驱逐基于 budget、last-use/benefit 与 pinned policy；先撤映射、后安全回收。
- device loss 重建所有 GPU owner并从 Provider 恢复 activation cut；Worker/session 是否复用由 generation 检查决定。
- feature-off 完整销毁 scheduler、heap、feedback/readback 和 Worker session。

退出证据：generation ABA、slot reuse race、replace failure、scene detach、abort、Worker crash、submit failure/device loss/recovery、feature-off；旧/新 revision 从不在同一冻结 FrameContext 混用。

删除/收敛：删除无限 residency cache、同步 queue wait、旧 bootstrap-only owner 和绕过 admission 的直接 page upload。

### S6 · Offline 第二路线 production parity

可运行结果：Native OEGPACK 通过同一 public asset/source selection 与同一 admission/renderer 工作，支持 HTTP Range、memory source 与 source failure；与 Web 路线仅在 Provider 前分叉。

实施项：

- 补齐 OEG ProductID/revision/producer identity 与 adapter determinism。
- 让 scene/deployment manifest 可显式选择或发现 pre-cooked source，但失败回退策略由调用方配置，不静默换质量。
- 在同一 workload 记录 Web cook、cold OEG Range、warm HTTP cache 的 loading/residency/GPU 指标。
- 证明 Offline 更优 packing/hierarchy 不要求新 shader path；若需新 profile，停止并先更新 spec/consumer。

退出证据：两类 producer 通过同一 Product conformance、admission、demand、replacement、Visibility 和 lifecycle case；source selection 不改变 GPU topology。

删除/收敛：删除 OEGPACK 专用 renderer/residency seam、file offset 泄漏和 Offline/Web PageID 互换逻辑。

### S7 · Geometry consumer cutover 与 V2 删除

可运行结果：普通 Scene adapter、main view、shadow 和 production entry 全部消费 active Geometry Product；V2 GeometryAssetPackage 不再是生产 geometry owner。

实施项：

- 迁移 `GpuAssetStore`/`GpuRenderWorld` recovery、asset publication、instance geometry reference 和 shadow consumer。
- 检查 VisibilityKey/local primitive identity、material/texture routing 与 replacement 后稳定性。
- 迁移或删除 `load_gltf_packed`、`GeometryCooker.ts`、V2 upload/hierarchy 的生产调用；保留纯 oracle 前必须有明确 owner。
- 做 source、compiled graph/shader、browser counter 三层 legacy 审计。

退出证据：MILESTONE 全 consumer 截图/diagnostics/lifecycle；同 workload PERF 不回退或有接受记录；production graph 无 V2 buffer/bind group/pass/counter。

删除/收敛：删除被替换的 V2 geometry package、上传、consumer、runtime switch 和无命中 shader；文档事实写回 ARCHITECTURE/PIPELINE/STATUS。

### S8 · `.gltf` 外部资源与巨大 primitive

可运行结果：主路线覆盖 `.gltf` 外部 buffer、data URI 和明确支持的 accessor 组合；巨大单 primitive 可以按确定性 spatial shard 或独立 bootstrap strategy 出图，而不是占满一次 CookSession。

实施项：

- URI resolution、credentials/CORS、content identity、external buffer Range 和 image/texture handoff。
- sparse accessor、interleaved stride、normalized attribute、non-indexed primitive 的 conformance matrix。
- 为巨大 primitive 设计确定性 spatial shard；每 shard 仍产生合法 product/revision，不修改已发布 ID。
- 不支持的 Draco/meshopt extension 走显式 codec capability/error，不能悄悄 full fallback。

退出证据：多文件 glTF、corruption/cancel、跨域策略和 giant primitive 的 TTFMF/peak memory；不同 shard 并行度保持 producer determinism。

删除/收敛：删除整 GLB/primitive 单任务临时上限与 silent unsupported-extension fallback。

### S9 · 可选持久 cache（证据触发）

仅当 S2-S8 profile 证明重复 cook/source latency 是主要瓶颈时实施。cache 使用独立 journaled Product/Page schema、完整 key、size/quota eviction 和 corruption fallback；不冒充增量 OEGPACK，不拥有 GPU residency。

退出证据：cold/warm/cache-off parity、quota、部分事务、版本失效、corruption 与真实收益。没有收益证据则保持未实现并关闭本 slice。

### S10 · Texture Mode A：渐进传输

可运行结果：在现有 TextureAssetPackage/TextureResidency/TextureBindingSet 上先发布 sampling-complete mip tail，再按独立预算请求高 mip；logical handle/material routing 稳定。

实施项：验证 container 的 partial mip range、compressed block/row alignment、variant identity；加入 texture 自有 request/publication/counter；与 geometry 只共享 scene priority 和全局预算协调。

退出证据：首帧 tail、逐级清晰度、Range/decode/upload failure、stable binding、device loss、feature-off 和网络/TTFMF 收益。不得把未上传 mip 宣称为显存节省。

### S11 · Texture Mode B：真实物理分级（证据触发）

仅当目标 workload 证明物理纹理 allocation 是瓶颈时实施。用独立 size tier/texture replacement 减少实际 allocation，promotion 计入双份 transaction peak，stable handle 原子切换，旧 tier 提交安全后销毁。Virtual Texturing 仍需独立 ADR。

退出证据：浏览器可观测 allocation ledger、peak、promotion/rollback、eviction、画质和 frame cost；与 Mode A 分开报告。

## S2 function-level production map (current cut)

The first real Web GLB cut is limited to the admitted static profile (embedded
BIN, TRIANGLES, no skins/morphs/Draco/external buffers). Unsupported inputs are
reported as capability errors; they never silently enter the V2 path.

| Nyx source function / entry | Current production implementation | Retained semantics | WebGPU/runtime difference | Evidence in this cut |
| --- | --- | --- | --- | --- |
| `MeshletBuilder::Build`, `BuildLOD0Meshlets`, `BuildMeshletsFromIndices`, `GeneratePositionRemap`, `GroupMeshlets`, `BuildVertexLocksByGroups`, `SimplifyGroup`, `SerializeGroup`, `BuildStreamingData`, `BuildHierarchy`, `ValidateBuild` | `NyxWebRuntimeCooker.cookBootstrapBatch` -> `canonicalizeGlbPrimitiveV1` -> pinned Emscripten cooker -> `GeometryProductDescriptorV1` | Canonical domain identity, attribute-aware input, meshlet/group/LOD/refine/error/hierarchy/page stages and immutable activation cut remain in the WASM producer; mixed material domains are rejected rather than merged incorrectly | JS performs bounded Range reads; WASM owns cook memory; Product bytes use OEngine little-endian V3 decoded pages instead of Nyx DX12 memory layout | `nyx-web-runtime-cooker.test.mjs`, `glb-primitive-canonicalizer.test.mjs`, Product validator |
| `GeometryStreaming::Initialize`, `PinRootPages`, `Update`, `SyncMemoryAndAddressTable`, `EnqueueAsyncLoad`, `OnPageIOComplete`, `ImmediateEvict` | `GeometryProductAdmissionController`, `VirtualGeometryResidency`, `GeometryPageStreamingRuntimeV1`, `GeometryPageSchedulerV1` | Complete activation/bootstrap pin, delayed demand, bounded retry/upload, hash validation, generation checks, revoke-before-slot-reuse and ancestor fallback are preserved | WebGPU uses rotating MAP_READ readback rings and bank/slot buffers; retirement waits on a submission completion token | `geometry-product-admission.test.mjs`, `geometry-page-scheduler.test.mjs`, `geometry-page-streaming-runtime.test.mjs`; browser evidence pending |
| `DAGCull::ProcessNodeBatch`, `ProcessMeshletBatch`, `computeMain` | `hierarchical_work_generation.ts`, `virtual_geometry_work.ts`, `PackedVisibilityPass` | GPU root seeding, hierarchy wavefront, frustum/HZB/SSE decisions, resident check, coarse fallback, refinement demand and bounded indirect reservation remain GPU-produced | WGSL replaces Slang wave intrinsics with existing work queues and explicit Product generation/page-location ABI | existing virtual geometry ABI/oracle cases; real GLB browser readback pending |
| `VBufferMesh::BuildVertexOutput`, `meshMain`, `pixelMain` | `MeshletBucketRaster` Product decode path plus `VisibilityKey` and sparse shading consumers | Page-local vertex pulling, meshlet-local primitive identity and VisibilityKey material routing are consumed by the existing raster/shading path | WebGPU uses indirect indexed raster buckets instead of DX12 mesh shader dispatch; no second renderer is introduced | `virtual-product-production` synthetic Product case; real GLB screenshot/console evidence pending |
| `ModelConvert::WalkGraph`, `ParallelCompileMeshes`, `BuildModel`, `SaveModel` | `GlbSceneCatalog` + `WebCookRuntimeAsset` catalog callback + `glb-web-product` validation host | Node instances, world transforms, material factors and primitive ownership are carried into one immutable scene publication | JSON metadata is transferred as structured data; GPU scene arrays are built only at explicit admission/publication | `glb-scene-catalog.test.mjs`, `web-cook-coordinator.test.mjs`; `glb-web-product` Chrome bootstrap case accepted |

`validation/src/cases/glb-web-product` is a registered automated case
(`run:glb-web-product`) that also keeps its manual UI. It uses the real
Worker/WASM cooker, the common Product admission/residency and
`MainRenderPipeline`; it does not create a second renderer or a hand-authored
triangle. The current revision reaches a complete single-asset bootstrap
Product and passes in Chrome. Multi-material/multi-primitive mapping, richer
revisions and demand feedback remain open.

## Slice dependency 与并行边界

```text
S1 common Product consumer
 ├─> S2 Web bootstrap
 │    └─> S3 parallel/progressive Web cook
 └─> S4 GPU demand/residency <─ S3
       └─> S5 lifecycle/replacement
             ├─> S6 Offline parity
             └─> S7 cutover/delete
                   └─> S8 input completeness

S9 cache waits for S2-S8 profile
S10 texture Mode A can start after publication conventions stabilize
S11 waits for S10 physical-memory evidence
```

可以并行的只有不共享未冻结 ABI 的工作，例如 Web cooker 内部算法与 S1 consumer oracle。Product descriptor transport、page location、demand record 或 Visibility identity 变化时，先更新 spec/oracle，再继续下游；不得让多个 slice 各自发明结构。

## Shared gates

- Nyx 移植是硬门禁：每个相关 slice 必须引用固定本地源文件/hash，提交 function map、保留不变量、平台差异、license/notice、differential corpus 和 negative corpus；没有这些材料不得标记完成。
- 不得以“先做一个简化版本，后续再替换”为正式生产路径。临时 oracle/fixture 必须隔离、标注未完成 Nyx 覆盖范围，并且不能成为 Runtime Asset 或 Renderer owner。
- 每个完成 slice 都必须有真实 producer -> production GPU consumer；只生成文件、CPU object、GPUBuffer 或测试专用 upload 不算完成。
- Web 与 Offline 只能在 Product admission 前分叉；不得新增 renderer、raster、Visibility、shadow 或 shading backend。
- Product revision offer 后 immutable；activation/replacement 原子，旧 generation 经过提交安全边界才回收。
- 所有 queue/table 明确 ABI/version、capacity、overflow、producer、consumer、counter 和 feature-off 行为。
- Worker/thread、source/WASM/output/upload、resident/pinned/retire 形成端到端 byte credit；不得以 GC 或浏览器 OOM 充当背压。
- 当前帧不等待 Worker、`mapAsync()`、upload 或 submitted work；CPU feedback 只调度资源，不生成最终可见 work。
- upload/readback、resident/transient/history/shadow 服从 [VALIDATION](../VALIDATION.md) 总预算；调整必须有同 workload evidence。
- cancel、replace、camera cut、source failure、Worker crash、aborted submit 与 device loss 都不得发布旧 generation。
- 每个 slice 先按改动风险完成命中 DEV；准备把 slice 标记为完成或声明 Runtime Validated 时，再由 ADR-0014 宿主集中完成 MILESTONE。只有性能声明才运行固定条件 PERF；中间实现步骤不要求重复高等级验证。
- 完成事实写回 ARCHITECTURE/PIPELINE/STATUS，稳定 ABI 写回 spec，外部算法/代码写回 porting ledger。

## Validation plan

### DEV

- Product/OEG adapter/Web producer conformance、golden、corruption、determinism。
- TS/WASM/WGSL ABI mirror 与 reserved/version rejection。
- scheduler/state-machine 的 cancel、duplicate、stale、retry、budget、overflow、generation/ABA。
- 只运行命中 slice 的 targeted checks；纯文档阶段不运行实现测试。

### MILESTONE

在 ADR-0014 独立宿主新增而非 `examples/` 塞入：

- `virtual-geometry-web-glb-bootstrap`
- `virtual-geometry-demand-refinement`
- `virtual-geometry-revision-replacement`
- `virtual-geometry-oegpack-parity`
- `virtual-geometry-device-loss`
- `progressive-texture-mode-a`，以及证据触发后的 Mode B case

每个 case 保存 capability fingerprint、events、console/GPU diagnostics、screenshot/数值 readback、counter snapshot 和 workload identity。

### PERF workload

至少覆盖：小 GLB 基准、多 asset/多材质场景、Bistro-class 场景、巨大单 primitive、限速/高 RTT、corrupted/partial source；Web `portable-pool`、Web `isolated-pthreads`、cold OEG Range 和 cache-off 对照固定总线程预算、source、画质、camera path、adapter、分辨率/DPR 和 warm-up。

报告：scene catalog time、bootstrap Product time、first meaningful frame、final revision time、source bytes、cook/decode/hash/upload CPU、main-thread blocking、WASM/JS/transfer peak、resident/pinned/retire bytes、page hit/fallback/demand/overflow、GPU frame/timestamp 和稳定帧方差。`load Promise` 时间不能替代这些指标。

## Completion gate

以下全部满足才可把本 implementation 标为 complete：

- Web GLB/glTF 是默认 Runtime-first 生产路线；Offline OEGPACK 是可选第二路线。
- 两条路线通过同一 frozen/candidate Product ABI、admission、residency 和唯一 renderer。
- bootstrap、GPU demand、async page refinement、replacement、eviction、cancel 与 device loss 有真实浏览器闭环。
- main/shadow/普通 Scene adapter 均 cut over；V2 geometry 生产路径和永久 runtime switch 已删除。
- 所有 queue/table 有 ABI、capacity、overflow、producer、consumer 和 counters；feature-off 接近零成本。
- 文档事实已回写 ARCHITECTURE、PIPELINE、STATUS；implementation 中已完成的过程描述按治理规则删除或归档到 Git 历史。

ADR accepted、spec draft/candidate、代码存在或 targeted test 通过均不等于上述完成。
