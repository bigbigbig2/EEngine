# 0019 · Web 版 Nyx 收敛切片

Status: active

Owners: Web Runtime Cooker、Geometry Product admission/residency、GPU hierarchy/work、Renderer capability、examples Rendering Lab、validation host

Outcome: 把「首帧模型是 partial → atomic full」「缺页 fallback 全表扫描」「activation 传输串行」「默认单线程」这四条会互相抵消虚拟几何收益的路径，收敛为可测量的 per-asset visible-first 运行时，并把能力线推进到 WebGPU 2026 specialization。

Slices: S1 visible-first 生效（P0）；S2 稳定 SceneCatalog 与相机（P0）；S3 运行时 profile 与阶段可见性（P0）；S4 Scene 稳定与 per-asset coarse activation（P1）；S5 缺页 fallback 直接映射（P1）；S6 activation transport 并行化（P1）；S7 正式 PERF 与旧路径删除审计（P2）。

Shared gates: `docs/PRODUCT.md`、`docs/WEBGPU.md`、`docs/VALIDATION.md`、ADR-0014、ADR-0016 系列、ADR-0017、`docs/specs/geometry-product-v1.md`、`docs/specs/virtual-geometry-runtime-v1.md`、`docs/porting/visibility.md`。

审查快照：2026-09-20。本页是活跃执行清单，不是新 ADR，也不替代 spec。所有「代码事实」段落均由本 revision 源码逐条核对得出，并标注了核对位置。

## Outcome

当前 OEngine 已经具备一条真实的生产主轴与可用的多 Product GPU 底座：

```text
GLB/glTF
  -> Range source / SceneCatalog
  -> Worker + WASM Nyx cooker
  -> immutable Geometry Product
  -> Product admission / shared page residency
  -> GPU hierarchy + SSE/HZB traversal
  -> GPU demand -> delayed readback -> bounded scheduler -> upload
  -> indirect raster -> VisibilityKey -> Sparse Shading
```

下一阶段不推翻这条主轴，而是收敛四条会抵消其收益的路径：

1. 首帧仍以「部分场景 bootstrap → 全场景 richer revision 原子替换」为主要组织方式，剩余 asset 不是「更粗」，而是「不存在」。
2. 缺页 fallback 在 WGSL 中反向扫描整个 hierarchy 找 parent，最坏 `O(depth × hierarchyNodeCount)`，且发生在最易大量触发的路径上。
3. activation cut 从 producer 到 residency 是严格串行 `await`，并伴随多余的整页拷贝。
4. 默认运行配置是单 Worker、小 credit 窗口，把「几何变多」放大成「几何与镜头同时跳变」。

目标拓扑：

```text
完整 SceneCatalog identity（首帧前稳定）
  -> per-asset coarse Product 独立激活
  -> 同一 Product revision 内 page refinement
  -> GPU demand 驱动细化
  -> 缺页走直接 parent/refine 映射
```

## 与其他文档的关系

本页是 `docs/implementation/` 当前唯一的活跃计划。此前四篇 implementation 文档已按治理规则退休，其 durable 内容去向如下；需要历史过程叙述时使用 Git 历史查询。

| 已退休文档 | durable 内容去向 |
| --- | --- |
| 0016 Virtualized Assets（切片母文档） | Nyx provenance、7 个源 hash、function map、license、不变量与 differential corpus 进入 [Geometry porting ledger](../porting/geometry.md)；跨线程命令/事件与 credit ownership 进入 [Web CookSession Protocol V1](../specs/web-cook-session-protocol-v1.md) |
| 0016 当前差距与后续交付计划 | 剩余项并入本页 S1–S7；评审结论校正中仍成立的事实进入 [STATUS](../STATUS.md) |
| 0017 Geometry Product 增量发布 | 四步全部落地；identity 上卷与两阶段 ABI 进入 [Geometry Product V1](../specs/geometry-product-v1.md)，运行证据进入 [STATUS](../STATUS.md) |
| 0018 Web 版 Nyx + WebGPU 性能路线图 | P0–P2 范围由本页吸收；ABI 与 per-asset 取舍待 S4/S5 开设 ADR |

- `STATUS.md` 仍是唯一汇总可变进度与开放 gate 的页面。本页只描述活跃切片、退出证据与删除目标。
- ABI 与 Scene 聚合语义进入 [specs](../specs/README.md)；长期取舍进入 [adr](../adr/README.md)。本页不自行决定 ABI 编号。

## 已核实的代码事实

以下断言全部由 2026-09-20 revision 源码核对，不是推测。

### 首帧发布模型

| 事实 | 位置 |
| --- | --- |
| `load_gltf()` 是同步函数，直接返回 `WebCookRuntimeAsset` | `OEngine/src/loaders/load_gltf.ts` |
| 自动 bootstrap 上限为 24 个 primitive 与 16 MiB source，且按 `bootstrapCoverage` 重排 | `OEngine/src/assets/web-cook/WebCookCoordinator.ts` |
| richer revision 会先 `canonicalizeDomains(全部 units)`，再 `planCanonical` 冻结全场景 descriptor | `OEngine/src/assets/web-cook/NyxWebRuntimeCooker.ts` |
| Scene publication 只有一份 `published` 状态（单 residency / source / materials），`settled()` 语义是「任一 queued richer-revision swap」 | `OEngine/src/render/pipeline/MainRenderPipeline.ts` |
| `GpuRenderWorldRuntime.assetHandles` 是数组，说明渲染世界本身可承载多资产 | `OEngine/src/gpu/GpuRenderWorld.ts` |
| metadata heap 按 `productCapacity = productTableSlot + 1` 为单个 descriptor 新建，未共享 | `OEngine/src/gpu/VirtualGeometryResidency.ts` |
| 4 个 bank 绑定跨 Product 与 generation 不变，靠 device 级单例引用计数共享；总量固定 512 MiB / 2048 page slot | `OEngine/src/gpu/GeometryProductSlotPool.ts` |

### visible-first 优先级当前三重失效

1. `examples/demos/14-integrated/shared/RenderingLab.ts` 在同步返回后立即判断 `sourcePriorities`，而 `onSceneCatalogReady` 经 Worker 异步到达，条件恒为假，`applyCatalogPriorities` 从不执行。
2. Worker 用 `setTimeout(..., 0)` 在 flush catalog 后开始 cook，没有确定性的优先级提交时序。
3. 即使优先级送达，`defaultBootstrapSelection` 仍以 `bootstrapCoverage` 为主排序键，priority 只作为 coverage 相同时的 tie-break；`selectBootstrapUnits` 的 `custom` 分支还会用 `comparePrimitiveOrder` 覆盖自定义选择器给出的顺序。

### 缺页 fallback

`OEngine/src/shaders/hierarchical_work_generation.ts` 的 `hierarchy_virtual_find_resident_ancestor_v1()` 外层循环 256 层，内层遍历 `asset.hierarchy_count` 并用 child range 反查 parent，最坏复杂度接近 `O(depth × hierarchyNodeCount)`。

产物侧已具备但未被遍历使用的信息：

- `OEngine/src/shaders/virtual_geometry_product.ts` 的 meshlet header 已含 `refine_group_id`；group header 只有 `parent_error` 与 `lod_level`，没有 refine 链接。
- hierarchy node 固定 48 字节 = 12 个 u32：`bounds_sphere`(4) + `bounds_min`(3) + `bounds_max`(3) + `max_parent_error`(1) + `packed_node_data`(1)。
- `packed_node_data` 位域已全部占满：bit0 `is_group`，bits1-24 `group_id`（组节点）/ bits1-27 `child_begin`（非组节点），bits25-27 `meshlet_count-1`，bits28-31 `child_count`。**节点内没有可用空位，也没有 parent 字段。**

### activation 传输

| 事实 | 位置 |
| --- | --- |
| activation cut 的逐页 emit 是串行 `await` | `OEngine/src/assets/web-cook/WebCookCoordinator.ts` |
| `emitPageNow()` 每页先 `await waitForOutputCredit(...)`，即 activation 流被输出信信用卡住 | 同上 |
| `#fillActivationCut()` 是严格串行循环：`readPage` → `digest(SHA-256, page.bytes.slice(0))` → `writeBuffer` | `OEngine/src/gpu/VirtualGeometryResidency.ts` |
| 需求路径已有有界并发读（`maxConcurrentReads`）与按帧批量上传（`maxUploadBytesPerFrame`） | `OEngine/src/gpu/GeometryPageScheduler.ts` |
| 需求路径每页有两处整页 `slice(0)` 拷贝（digest 输入与保留 page） | 同上 |

### 运行时配置

`examples/demos/14-integrated/shared/RenderingLab.ts` 仅在显式 `?profile=isolated-pthreads` 时切换到 pthread，否则一律 `portable-single`；同时传入 `maxConcurrentWorkers: 1`、`initialOutputPageCredits: 64`、`maxBufferedPages: 64`。

## 优先级总表

| 级别 | Slice | 结果 | 依赖 | 退出证据 |
| --- | --- | --- | --- | --- |
| P0 | S1 visible-first 生效 | 首个 cut 真的包含相机可见的大 asset | 无 | targeted test 断言优先级为主排序键；真实浏览器 case 中首个 cut 的像素覆盖高于同条件 baseline |
| P0 | S2 稳定 SceneCatalog 与相机 | 首帧按最终场景 framing，publication 不改相机 | 无 | camera matrix 在 bootstrap→replacement→page refinement 前后不变 |
| P0 | S3 profile 与阶段可见性 | 默认路径使用设备可用并行能力；UI 按阶段报告 | COOP/COEP 宿主 | capability 选择记录 requested/selected/fallback reason；阶段计时进入 evidence |
| P1 | S4 per-asset coarse activation | 可见 asset 不等待整场景；pending asset 不阻塞首帧 | S1、S2、spec 变更 | 高 RTT 多 asset case：首个可见 Product 像素早于非可见 asset 的 Range/Cook |
| P1 | S5 fallback 直接映射 | 缺页走 `O(depth)`，不再全表扫描 | ABI 版本化、spec、validator | `fallbackNodeProbes / fallbackRequests` 接近 `O(depth)`；无画面回退回归 |
| P1 | S6 activation transport 并行化 | 有界并发读 + ready queue + 批量上传，且无冗余整页拷贝 | page identity 合同 | 同页数下 activation 时间随并发下降；`slice(0)` 归零且 hash 仍在 |
| P2 | S7 正式 PERF 与删除审计 | 证明目标或明确差距 | S1–S6、clean revision | ADR-0014 artifact、GPU timestamp、旧 V2 三层审计结论 |

## Slices

### S1 · 让 visible-first 真正生效（P0）

**问题**：`rankCatalogByVisibility` 的结果从未影响首帧。三道关卡见上文，第三道最关键——只修 demo 接线不会改变行为。

**设计**：

1. 把 `applyCatalogPriorities` 移进 `onSceneCatalogReady` 回调内，使优先级在 catalog 到达后立即发出。
2. 用显式握手替代 `setTimeout(..., 0)`：Worker 在 flush catalog 后等待「优先级提交」命令或一个**有界 deadline**（例如 50 ms）再开始 cook。必须保留无优先级调用方不被拖住的行为，因此 deadline 是必需项而不是优化项。协议命令进入 `docs/specs/web-geometry-cooker-abi-v1.md` 的合同面。
3. 让 priority 成为 bootstrap 的主排序键：`defaultBootstrapSelection` 需要接收优先级访问器，排序改为 `(priority desc, coverage desc, catalog index asc)`；同时停止在 `selectBootstrapUnits` 的 `custom` 分支用 `comparePrimitiveOrder` 覆盖自定义顺序。显式 `bootstrapUnitCount` 路径当前已经尊重 priority 顺序，可作为对照基线。
4. `applyCatalogPriorities` 的静默 `catch` 改为记录计数并进入 evidence，「优先级晚到」必须可观测，不能当作无事发生。

**代码落点**：`examples/demos/14-integrated/shared/RenderingLab.ts`、`OEngine/src/assets/web-cook/WebCookCoordinator.ts`、`OEngine/src/assets/web-cook/WebCookWorkerHost.ts`、`OEngine/src/assets/web-cook/WebCookClient.ts`。

**退出证据**：`OEngine/tests/web-cook-visible-first.test.mjs` 扩展为断言「camera-facing 大 primitive 必进首个 cut，即使它不是 coverage 最大者」；真实浏览器 case 记录首个 cut 的 asset 列表与像素覆盖，且与显式 `bootstrapUnitCount` 基线对比。

**删除目标**：删除 demo 中「优先级晚到算 lost optimisation」的注释与对应静默分支，因为该分支不再需要存在。

**已落地（DEV，2026-09-20）**：

- `CommitCatalogPriorities` 加入 CookSession 协议，作为**同一 major version 内的增量**（不递增 `protocolVersion`，理由与握手时序见 [Web CookSession Protocol V1](../specs/web-cook-session-protocol-v1.md) 的「Catalog 优先级握手」一节）。
- `WebCookWorkerHost` 改为在收到 commit 或 `catalogPriorityWindowMs`（默认 250 ms）到期后开始 cook，不再依赖 `setTimeout(..., 0)` 的时序假设；窗口是安全网，不是固定延迟。
- `WebCookClient` 在调用方 catalog hook 返回后提交（`finally`，使抛错的 hook 也不会让 Worker 白等一整个窗口），并在 `WebCookClientEvidence.catalogPrioritiesCommitted` 报告。
- `defaultBootstrapSelection` 的排序改为 `(priority desc, coverage desc, catalog index asc)`：调用方的相机感知排序成为主键，coverage 只在没有优先级时决定，catalog 顺序兜底确定性。
- `selectBootstrapUnits` 的 custom 分支不再用 `comparePrimitiveOrder` 覆盖调用方顺序（该排序只会影响 byte-cap 截断的取舍）；返回集合仍按 catalog 顺序。
- `WebCookCoordinatorEvidence.lateSourcePriorities` 统计首个 cut 算出之后到达的优先级；demo 把 `applyCatalogPriorities` 移进 catalog 回调，并把原来的静默 `catch` 改为可观测告警。

**DEV 验证**：`npm run typecheck` 通过；`OEngine/tests/web-cook-visible-first.test.mjs` 新增两条断言（priority 必须压过 coverage 且把最小 primitive 提升进 24 单位 cut、被挤出的必须是「低 priority + 低 coverage」者；首个 cut 之后到达的优先级必须被计数），该文件 5/5 通过；命中的 `web-cook-coordinator`/`web-cook-worker-host`/`cook-session-protocol`/`web-cook-client` 测试 12/12 通过；全量 `tests/*.test.mjs` 431/435，4 个失败全部位于原生 Nyx/OEGPACK 路径（本机缺 MinGW `g++`，且 `oegpack-v3.test.mjs` 的 golden 需要先跑 `npm run build:native-cooker`），与本 slice 无 import 关系。

**浏览器证据（`diagnostic-only`）**：新增 `validation/src/cases/glb-bootstrap-priority`，入口 `npm run run:glb-bootstrap-priority`。同一页面两次加载同一 GLB、同一相机（按 catalog 全量 bounds 取景）、同一预算：run A 不设任何优先级（其 cut 必然是 coverage 前 24），run B 把 coverage 第二梯队（rank 24..47）提到最高优先级。由于 run A 的 cut 恰好是 rank 0..23，两个 cut 按构造不相交，两次场景的实例集合必须不同。实测 run A 指纹 `18-b9a8820e`（2307 lit pixels）、run B 指纹 `18-327892f7`（3220 lit pixels），两次均为 24 实例 / 24 resident pages，`status: passed`，6 项 gate 全 true、零浏览器错误。

**该 case 的牙齿已验证**：把 4 个引擎文件还原到 HEAD 后重跑，case **失败**，两条 run 的实例指纹都是 `18-b9a8820e`（完全相同），报错为「the priorities never reached the cooker」。即该 case 能区分「优先级生效」与「优先级被静默丢弃」。

**未完成**：由于工作树带未提交改动，`evidenceStatus` 为 `diagnostic-only`，**不是 `accepted`**。要升级为 Runtime Validated，需要在干净 revision 上重跑该 case 与 `glb-web-product`。

### S2 · 稳定 SceneCatalog 与相机（P0）

**问题**：`settled()` 之后重算 bounds、重设 camera position/lookAt、`controls.reset()` 并 `indicate_view_change()`，使 richer revision 激活瞬间同时发生几何扩展与镜头跳变。

**设计**：

1. `SceneCatalog` 就绪时即计算**最终**保守场景 bounds：`catalog.primitives` 的 `boundsMin/boundsMax` 经 `catalog.instances` 的 `worldMatrix` 变换后取并集。demo 的 `rankCatalogByVisibility` 已在做同一组 min/max 计算，数据通路现成。
2. 相机 near/far 与初始 transform、`controls.target/minDistance/maxDistance` 全部由该 bounds 一次性决定。
3. `settled()` 只更新 progress、evidence 与状态文案，**不再触碰相机或 controls**。
4. SceneCatalog 身份必须显式保存 instance identity、node index、world transform、asset slot 与 pending 状态，使 `pending → coarse-active → refinement-active` 成为状态迁移而不是重新发布。

**代码落点**：`examples/demos/14-integrated/shared/RenderingLab.ts`、`OEngine/src/loaders/gltf/streaming/GlbSceneCatalog.ts`、Web Product scene mapper 与 `sceneAssetIndices`、`validation/src/cases/virtual-product-observer`。

**退出证据**：case 断言 camera matrix 在 catalog 就绪、bootstrap 发布、richer 替换、同 revision page refinement 四个时点完全一致；手动 orbit 与 camera cut 仍能显式触发 `indicate_view_change`。

**删除目标**：删除 `RenderingLab.ts` 中 `settled()` 内的 bounds 重算与相机重置整段，以及为它服务的 `refinedCameraApplied` 标志。

**已落地（DEV，2026-09-20）**：

- 新增并导出 `webCookCatalogSceneBounds()` 与 `webCookCatalogSceneFraming()`（`OEngine/src/assets/web-cook/WebCookSceneBounds.ts`）。前者把 catalog 每个 primitive 的局部 AABB 经**所有**引用它的实例变换后取并集；后者用同一套公式解出可直接传给 mapper 的 `scale`/`offset`，并返回**已 fit 的** bounds（即相机该取景的盒子）。两者都报告 `unknownBoundPrimitives`：bounds 缺失时不谎称保守覆盖。
- `ProductSceneOptions` 现在暴露 `scale`/`offset`（`WebCookedSceneOptions` 与 `OegPackSceneOptions` 都继承），两个 `upload*Scene` facade 都转发给各自的 scene source。此前 mapper 支持这两个字段而 facade 没有透出，调用方只能被迫使用 `fitHeight`。
- demo 在 `onSceneCatalogReady` 里从 catalog 解出 framing；`settled()` 不再触碰相机或 controls，只更新计数与文案；`sceneBounds` 由 `let` 变 `const`；`refinedCameraApplied` 与 `computeSphereBounds` 已删除。

**顺带修复的两个真问题**：

1. **`fitHeight` 是按被映射的 revision 解析的**，因此 bootstrap 子集与 richer revision 得到**不同的 scale**，几何会在提交瞬间整体改变大小。这正是旧代码不得不在 `settled()` 里重设相机的原因之一。改为从 catalog 解析 fit 并传显式 `scale`/`offset` 后，变换与 revision 无关。
2. **第一版实现引入了死锁**：曾在 `uploadWebCookedScene` 之前 `await` catalog。但 client 只在 `revisions()` 被迭代时才 drain Worker 事件，而迭代正由该 upload 启动——于是「等 catalog，而 catalog 等 upload」。改为传入一个**在映射时才读取**的 options 对象，由 catalog 回调填充 `scale`/`offset`：首个 revision 必然晚于 catalog，因此顺序安全且无需 await。

**DEV 验证**：`OEngine/tests/web-cook-scene-bounds.test.mjs` 8/8（含「按子集解析 fit 会得到不同 scale」这一守卫）；`OEngine`、`examples`、`validation` 三个项目 typecheck 通过；全量 `tests/*.test.mjs` 439/443，4 个失败是既有的原生 Nyx/OEGPACK 路径（本机缺 MinGW `g++`），与本 slice 无关。

**浏览器观察（`diagnostic-only`）**：同一 demo，4 秒至 17 秒共 10 次采样相机 position/target。修复前（HEAD）`视角 position` 从 `33.389, 21.207, 40.067` 跳到 `28.455, 16.876, 34.146`；修复后全程只有一个值 `28.455, 18.576, 34.146`。截图确认取景正确、798/798/25 实例全部 resident、GPU Pass Sum 3.24 ms、60.0 FPS。

**Governance 说明**：本 slice 的改动落在 `examples/`，而 ADR-0014 明确 `examples/` 不是验证宿主，因此「camera matrix 四时点一致」这条退出证据**无法以 `accepted` 形式取得**。当前证据是：引擎侧纯函数有确定性单测，demo 侧是 playwright 观察（`diagnostic-only`）。若要升级为 MILESTONE，需要把「按 catalog 取景、publication 不改相机」这一不变量做成 `validation/` 内的独立 case。

### S3 · 运行时 profile 与阶段可见性（P0）

**问题**：默认 `portable-single` 且单 Worker；加载面板把 catalog、bootstrap cook、activation、refinement 全部称作「精细化」，进度条按 elapsed 时间伪造。

**设计**：

1. 自动选择 profile：`crossOriginIsolated && SharedArrayBuffer && logicalCores >= 4` → `isolated-pthreads`；否则 `logicalCores >= 4` → `portable-pool`；否则 `portable-single`。
2. 总线程预算 `maxTotalCookThreads = min(configuredCap, max(1, hardwareConcurrency - rendererReserve))`；Worker pool 与 pthread pool 不得嵌套扩张。
3. profile record 记录 requested、selected、fallback reason、worker count、pthread count、hardwareConcurrency、renderer reserve，并进入 case artifact。
4. 进度按真实阶段命名并携带分阶段耗时：`catalog`、`bootstrap-cook`、`activation-stream`、`refinement-canonical`、`refinement-plan`。协议中 `Progress.timings` 已是 `Record<string, number>` 且已被 provider 转发、客户端读取，因此这是**填充既有字段**，不是新增 ABI。
5. activation 阶段的等待必须区分「等输出信用」与「读页」，否则无法判断首帧是 producer-bound 还是 credit-bound。

**前置依赖（需要先确认）**：`examples/` 宿主当前是否提供 COOP/COEP header。`isolated-pthreads` 需要 `crossOriginIsolated`，而目前只有 `validation/` 宿主确认提供。若 examples 宿主未提供，自动选择在 demo 中会永久落到 `portable-pool`，这是可接受结果但必须记录为 fallback reason，而不是伪装成 pthread。

**代码落点**：`OEngine/src/assets/web-cook/WebCookWorkerFactory.ts`、`examples/demos/14-integrated/shared/RenderingLab.ts`、validation host 的 profile selector。

**退出证据**：同一 GLB、同一 recipe、同一总线程预算下三个 profile 的 Product identity/descriptor/page 不变量一致；cancel、worker crash、stale generation 不发布旧页；只比较 cook 时间与 CPU 峰值，不把线程数本身当性能结论。

**删除目标**：删除 demo 中按 elapsed 时间伪造的进度爬升逻辑。

### S4 · Scene 稳定与 per-asset coarse activation（P1）

**问题**：当前首帧只包含 24 / N 个 primitive，其余 asset 在 richer revision 提交前**根本不存在**；缺页 fallback 只能解决「asset 存在但目标 page 不 resident」，无法解决「asset 不在当前 Product 中」。

**前置门禁（必须先完成，否则实现与冻结合同冲突）**：

1. `docs/specs/geometry-product-v1.md` 现写明「快速首帧应以一个完整 bootstrap revision 表达，更高质量 revision 用 `replaces` 指向当前 active revision」。该句把单 Product 原子替换写成了首帧的表达方式。per-asset activation 需要把首帧语义改为「每个可见 asset 各自的 complete coarse revision」，并定义 Scene 层 asset slot 聚合合同。
2. 长期取舍（多 Product 共存于一个 Scene、slot 生命周期）应先落 ADR，再写 spec 字段。

**设计**：

1. Scene publication record 扩展为按 asset slot 索引：

```text
SceneId
AssetSlotId
ProductId + revision
Instance range / sceneAssetIndices
coarse state: pending | staging | active | failed
activation cut status
material/texture dependency status
```

2. 约束：已 active Product 的 hierarchy、GroupID、PageID 不可变；未完成 DAG 不得拼入 active Product；每个 coarse Product 自身必须是完整可绘制的合法 Product；scene publication 走 `candidate → ready-to-commit → commit → retire`，失败时已 active 的 asset 保持可绘制；asset slot 激活不得改变其他 slot 的 generation 或 page table。
3. GPU 侧必须解决两件事：
   - **metadata heap 共享化**：当前每个 Product 自带一块 metadata buffer。要么改为单 buffer + 多 product record（`productTableByteOffset` 已为此预留），要么明确提高 `maxStorageBuffersPerShaderStage` 需求并把每 Product 的绑定成本写进 capability record。demo 当前请求 16，按 `STATUS.md` 记录最宽 consumer variant 已消耗 15 个，因此现状只容得下极少数同时绑定的 Product。
   - **512 MiB 是全部 Product 共享的固定 ABI 预算**，per-asset activation 是在同一预算内提高并发粒度，不是扩容。
4. Cooker 侧：`cookProgressive` 改为按 priority queue 授予有限 active unit credit，每个 unit 完成 Nyx 完整阶段（meshlet → group → seam/attribute lock → simplify/refine/error → hierarchy → page），coarse descriptor 先冻结，activation cut 进 ready queue，非当前 camera 相关 unit 不得阻塞首个 meaningful frame。
5. 巨大 primitive 必须二选一并进入 spec：确定性 spatial shard（冻结 shard bounds、seam、attribute lock、identity、跨 shard visibility 与合并规则），或独立 coarse bootstrap Product。任意三角形切片、破坏 Nyx seam/lock 或改变 primitive identity 都不合格。

**代码落点**：`OEngine/src/render/pipeline/MainRenderPipeline.ts`、`OEngine/src/gpu/GeometryProductAdmission.ts`、`OEngine/src/gpu/VirtualGeometryResidency.ts`、`OEngine/src/assets/web-cook/WebCookCoordinator.ts`、`OEngine/src/assets/web-cook/NyxWebRuntimeCooker.ts`、`docs/specs/geometry-product-v1.md`。

**退出证据**：高 RTT 多 asset GLB 中，首个可见 Product 的像素早于非可见 asset 的 Range/Cook 完成；priority 变化不改变 Product semantic identity；并行度变化不改变 deterministic output；cancel/failure 后 Range、WASM、output credit、page queue、GPU staging 全部归零。

**删除目标**：确认 S4 通过后删除 `cookProgressive` 的「bootstrap subset + 全场景 richer revision」主路径；richer revision 仅保留给 recipe/拓扑变化与完整 recook。

### S5 · 缺页 fallback 直接映射（P1）

**问题**：`hierarchy_virtual_find_resident_ancestor_v1()` 为找 parent 反向扫描整个 hierarchy，且在缺页时触发。

**设计**：

1. Step A：在**保持 48 字节 node 布局不变**的前提下新增独立 `parentIndex` 表（每节点 u32，`INVALID` 表示根）。节点内加字段不可行——`packed_node_data` 的 32 位已全部占满。遍历改为一跳一读：

```text
current = node_id
for depth = 0 .. maxDepth:
  if current group page resident: return current group
  current = parentIndex[current]
  if current == INVALID: break
return invalid
```

复杂度降为 `O(depth)`，并保留现有 ancestor fallback 语义。

2. Step B（在 Step A 有 differential 与 GPU consumer 证据之后）：把 `refine_group_id` 从 meshlet header 提升到 group header，使 traversal 直接获得 refine 链接，贴合 Nyx `DAGCull` 的「当前 group 保持可画，refinement 作为可选提升」语义。该字段已经存在于 `OEngineVirtualMeshletHeaderV1`，因此这是**提升作用域**，不是新增概念。
3. ABI 必须版本化（编号由 spec 决定），旧 revision 不得静默按新布局读取。
4. Producer、validator、WGSL mirror、traversal、evidence 必须同步：validator 增加 root parent、parent-child 一致性、无环、depth 单调、bounds containment、refine 合法性检查；evidence 增加 `fallbackAncestorSteps`、`fallbackNodeProbes`、`fallbackInvalid`、`refineResident`、`refineMissing`。
5. 不得先删除 ancestor fallback 再补 refine 证据；`fallbackGroupId`、root pin、request mask、generation mismatch 与 fail-closed 必须保留。

**代码落点**：`OEngine/src/shaders/hierarchical_work_generation.ts`、`OEngine/src/shaders/virtual_geometry_product.ts`、`OEngine/src/assets/GeometryAbiV3.ts`、`OEngine/src/assets/geometry-product/`、`docs/specs/geometry-product-v1.md`、`docs/porting/visibility.md`。

**退出证据**：相同 Product/page residency 下 fallback selected cluster 与像素覆盖一致或有解释性差异；`fallbackNodeProbes / fallbackRequests` 接近 `O(depth)` 且不再随 node count 线性增长；零 GPU validation error；overflow、stale generation、device loss、eviction race 仍 fail closed。

**删除目标**：确认 S5 通过后删除 `hierarchy_virtual_find_resident_ancestor_v1()`。

### S6 · activation transport 并行化与去冗余拷贝（P1）

**问题**：activation cut 从 coordinator 逐页串行 emit、再由 `#fillActivationCut()` 逐页串行 read → hash → upload；同时存在多处整页 `slice(0)`。

**设计**：

1. `WebCookCoordinator` 的 activation emit 改为有界并发，禁止无界 `Promise.all`：

```text
concurrency = min(pageReadConcurrency, outputCredits, maxInFlightBytes / pageBytes)
```

每个 page 有明确 owner 状态：`producing → verified → ready → transferred → consumed/discarded`。credit 必须在 transferable ownership 释放时归还，而不是 message 发出时提前归还。

2. `#fillActivationCut()` 改为：先按并发上限批量分配 slot（`GeometryProductSlotPool.allocate()` 是同步的，可批量取），再并行 `readPage` + 校验，最后按帧 upload budget 批量 `writeBuffer`。失败路径必须逐 slot 归还，保持现有 `#slotOwners` 一致性。
3. 拷贝消除按此顺序：确认 `bytes` 是独占可 transfer 的 `ArrayBuffer` 且 source cache 不依赖同一 backing store → 在 Worker/source owner 内完成 decode + 完整性校验后 transfer verified buffer → 必须在校验侧 digest 时允许直接消费 `Uint8Array` view，不再 `slice` → 校验后仅在 ownership 需要时复制一次。
4. **hash 不得删除**。它是 Product correctness/integrity 合同的一部分；优化的是 owner 与复制次数。
5. 需求路径已经是并发 + 批量，**不要改动**；S6 只处理 activation 路径与共享的拷贝点。

**代码落点**：`OEngine/src/assets/web-cook/WebCookCoordinator.ts`、`OEngine/src/gpu/VirtualGeometryResidency.ts`、`OEngine/src/gpu/GeometryPageScheduler.ts`。

**退出证据**：固定页数下 activation stream 时间随并发上限下降并趋于平台；两处 `slice(0)` 归零且 hash 校验仍在；re-demand、retry、cancel、device-loss、page cache reread、transfer-detach 全部通过；upload batch 统计 page count、bytes、queue calls、hash time、decode time、wait-for-credit time。

**删除目标**：确认 S6 通过后删除串行 activation 循环与冗余拷贝路径。

### S7 · 正式 PERF 与旧路径删除审计（P2）

**设计**：

1. 在干净 revision、固定 adapter、1920×1080、DPR 1、固定画质与 workload、固定 warm-up 与线程总预算下运行 ADR-0014 宿主，报告 GPU P50/P95、关键 phase、TTFMF、submit 数、counter、按 owner 内存。
2. steady-state 优化顺序：先 subgroup specialization（读 `adapter.info.subgroupMinSize..subgroupMaxSize`，不硬编码 32/64），再 primitive-index 与 vertex pulling，最后 f16 与 meshlet/page 参数 A/B。每项必须有同 adapter、同 workload 的 GPU timing/画质/内存证据。
3. 对仍有内部消费者的 `GeometryAssetPackage`、`GeometryCooker`、`GpuAssetStore` 做 source → compiled graph/shader → 浏览器 counter 三层调用图审计，确认无真实生产消费者后再删除。
4. 把完成事实写回 [ARCHITECTURE](../ARCHITECTURE.md)、[PIPELINE](../PIPELINE.md)、[STATUS](../STATUS.md)，稳定字段写回 spec，来源写回 porting ledger。

**退出证据**：ADR-0014 artifact 含 revision、source hash、capability fingerprint、截图或数值 readback、GPU diagnostics；未达成的目标明确列出剩余瓶颈，不用架构名词代替证据；旧 V2 owner 在 source/compiled/browser 三层均无生产消费者。

**删除目标**：已替代的 V2 geometry package/cook/upload/runtime switch 及其公开 symbol。

## 执行顺序与依赖

```text
S1 ──┐
S2 ──┼─→ S4 ─→ S5 ─→ S7
S3 ──┘         S6 ──┘
```

- S1、S2、S3 互不依赖，可并行开工，且都不改 ABI。
- S4 依赖 S1（优先级必须真的生效）与 S2（场景身份必须稳定），并且必须先完成 spec 变更。
- S5 与 S6 可在 S4 进行中并行，但 S5 的 Step B 必须在 Step A 有证据之后。
- S7 依赖全部前置 slice 与干净 revision。

## 不要做的事

- 不要为省事把未完成 hierarchy 拼成一个「看起来能画」的 Product。
- 不要把 richer revision 原子替换当作普通 page refinement 的默认机制。
- 不要删除 hash/integrity 只为规避 copy 成本。
- 不要在 WGSL 中保留全 hierarchy parent scan 作为长期路径。
- 不要默认开启无限 Worker 或 Worker×pthread 嵌套扩张。
- 不要并行化需求路径——它已经有 `maxConcurrentReads` 与按帧上传预算。
- 不要把逻辑 resident bytes 当作真实物理 VRAM 节省。
- 不要把 subgroup、f16、primitive-index 或 draft 能力写成所有设备默认能力。
- 不要复制第二套 Renderer、shadow、Visibility 或 shading pipeline。
- 不要用类名、Pass 数量或「代码已存在」代替运行证据。

## Shared gates

1. 每个 slice 交付前对照 [PRODUCT](../PRODUCT.md)、[WEBGPU](../WEBGPU.md)、[VALIDATION](../VALIDATION.md) 与对应 ADR，列出保留的 Nyx 阶段、平台差异与未覆盖项；发现简化实现时直接重构，不以注释或 TODO 代替。
2. 修改共享 Product、GPU location、demand、Worker 协议或二进制字段时，先更新 spec、TS/WGSL/WASM mirror 与 golden/negative 测试；不得并行发明第二 ABI 或第二 Renderer。
3. 默认只运行 `npm run typecheck`、命中的 targeted tests 与构建；跨越 GPU publication、材质保真或 consumer cutover 时集中运行 `validation/` 浏览器 case。`npm ci` 与正式 PERF 只按 [VALIDATION](../VALIDATION.md) 的触发条件执行。
4. 每个 slice 提交前检查实际 producer → consumer、feature-off、budget/overflow/counter、失败/取消/device-loss，并确认删除目标已删除。
5. 本页记录的是活跃工作；切片完成后把事实回写当前事实文档并删除本页中的过程叙述。
