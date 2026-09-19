# 0017 Geometry Product 增量发布：活跃切片

Status: active

Owners: Web Runtime Cooker、Geometry Cooker WASM ABI、Geometry Product admission/residency、Nyx 移植验证、validation host

本页是 [ADR-0017](../adr/0017-incremental-geometry-product-publication.md) 的活跃执行清单，不是新的 ADR 或 ABI。精确合同由 [Geometry Product V1](../specs/geometry-product-v1.md) 管理；验证分级与证据门禁以 [VALIDATION](../VALIDATION.md) 为准。

## Outcome

把 Geometry Product 的发布粒度从「revision 级原子整包」推进到「revision 内 page 级增量」：descriptor 先于 payload 冻结，activation cut 完整后即激活，其余 page 由 GPU demand 驱动在同 revision 内增量产出并上线。最终用户可见效果是首帧之后几何可以持续上线，而不是等待一次不可中断的全量精化。

完成后必须同时成立：

- 选择增量路线的 Producer 可以在不产生任何 page payload 的前提下冻结完整 ID graph，并证明其 PageID、Group 归属与 activation cut 与单体式路径一致；
- page identity 不再由整页 bytes 单独决定，而是可由 Group payload 摘要确定性上卷，使 descriptor 可先于 payload 冻结；
- cooker ABI 显式区分 descriptor 阶段与 payload 阶段，payload 阶段支持按 PageID 乱序、重复、并发推进，并对未声明 PageID 拒绝；
- 消费侧既有分层（admission、residency、eviction、demand 回读、预算）不变，只增加「page 何时被产生」这一可调度维度；
- Nyx 算法不变量与既有 differential corpus 继续通过，拆分只改变计算与交付时机，不改变任何几何输出。

未完成对照与下游消费证据前，不得宣称增量发布完成。

## Slices

执行依赖为第一步 → 第二步 → 第三步 → 第四步。第一步决定 identity 语义，第二步决定 ABI 形态，两者是后续所有工作的前提；第三步与第四步可以在 ABI 冻结后分别推进，但真实浏览器证据是第四步的退出条件。

### 第一步：确定 page identity 上卷算法并冻结 golden

目标：把 page identity 从「整页 bytes 的 SHA-256」改为「页内 Group payload 摘要按 GroupID 升序的确定性上卷」，并证明该定义与既有整页校验语义等价。

执行：定义上卷输入（每 Group 的 payload 摘要、页内 offset 与 length、GroupID 顺序），选择固定且可复现的上卷算法并写入 spec 与 producer version。保留整页摘要作为传输与存储完整性校验，但不再作为 identity 来源。变更 `AssembleDecodedGeometryProductV1` 使 identity 在 payload 生成之前即可计算，同时保持全局 best-fit 装箱与 stable sort 的确定性。产出 golden bytes 固定 identity，并证明单体式路径在改动前后对同一输入得到相同 identity。

已落地：`ComputeGeometryPageIdentityV1` 采用域分隔 SHA-256，输入为 `u32` 组数与按 GroupID 严格升序的 `(GroupID, payloadBytes, payloadDigest)` 三元组；非升序、重复、长度不匹配与空页均拒绝。`AssembleDecodedGeometryProductV1` 在装箱时收集每 Group payload 摘要，identity 不再读取整页 buffer。整页摘要不进 descriptor，改由 `GeometryPageProductV1.decodedPageHash128` 随页交付，消费者自行重算比对。OEGPACK V3 writer 的 `VerifyPack` 同步改为按上卷算法重算并比对 `decodedContentHash128`；identity 与整页摘要的分离贯穿 WASM、OEGPACK、scheduler、residency 与 Web Cook 协议。

退出条件：identity 上卷算法被 spec 冻结；golden 测试覆盖 identity 与整页完整性校验的分离（篡改 payload 改变 identity 或被抓，篡改 padding 不改变 identity）；不同线程数下 identity 可复现。

### 第二步：扩展 Geometry Cooker 两阶段 ABI

目标：在 `.h` 与实现中提供 descriptor 阶段与 payload 阶段可分离的入口，并递增 ABI 版本。

执行：新增 descriptor 阶段入口，使其返回可在无 payload 前提下查询 page 数量、page identity、page 到 Group 映射与 activation cut 的 handle。新增 payload 阶段入口，支持按 PageID 推进并返回该页字节，保证已完成 PageID 可重复取回且 byte-identical。显式表达「PageID 已声明但 payload 未产出」状态，使消费侧可与「PageID 不存在」区分。对未声明 PageID 的推进请求返回错误而非扩张 ID graph。递增 `kAbiVersion` 并让旧版本 consumer 显式失败。同步更新 TypeScript 侧镜像与 descriptor binary transport 的版本拒绝测试。

已落地：`kAbiVersion` 递增到 2，`OengineWebGeometryCookPageStatusV1` 定义 `READY`/`PENDING`/`UNDECLARED`，并新增 `oengine_web_geometry_cook_plan`、`oengine_web_geometry_cook_produce_page`、`oengine_web_geometry_cook_page_status` 三个导出入口。装箱与 identity 推导抽成共享核心 `PackDecodedGeometryProductV1`，单体式与两阶段走同一条路径，`DecodedGeometryProductPlanV1` 承载无 payload 的 descriptor 阶段结果，`MaterializeDecodedGeometryPageV1` 在物化时重算 identity 并与 plan 比对，防止两阶段漂移。TypeScript 镜像同步到版本 2 并提供 `planWebGeometryWasmV1` 与 `WebGeometryCookWasmPlanV1.producePage/pageStatus/produceAll`。已签入的 Emscripten 产物用 SDK 6.0.9 重新构建并刷新哈希，产物测试在真实 wasm 上验证 descriptor-before-payload、乱序与重复产出、`UNDECLARED` 语义，以及与单体式逐页 byte-identical。

退出条件：C++ ABI 测试覆盖两阶段分离、乱序/重复/并发推进、未声明 PageID 拒绝、阶段失败隔离；TypeScript 镜像与 C++ 行为一致；旧 ABI 版本被显式拒绝。

### 第三步：Producer 侧切到两阶段调度

目标：让 Web Runtime Cooker 与普通 Scene 路径按 GPU demand 安排 payload 阶段，而不是一次算完全部 page。

执行：改造 `NyxWebRuntimeCooker`，把 `cookProgressive` 从「bootstrap revision + 完整 revision 原子替换」改为「descriptor 一次冻结 + activation cut payload 先产出 + 其余 page 按 demand 增量产出」。确认 `WebCookCoordinator.requestPages` 能把 GPU demand 的 `(slot, generation)` 反查为 `(productId, revision)` 并触发 payload 推进；补齐当前缺失的反查链。保持 output credit、并发预算与 generation 失效语义不变。确认 activation cut 完整 resident 前不激活的既有约束不被放宽。

已落地：`WasmGeometryProductV1.ts` 抽出 `GeometryProductPageSourceV1` 抽象，`MonolithicPageSource` 与 `WasmPlanPageSource` 分别承载「payload 已全量物化」与「descriptor 已冻结、payload 待产出」两种 producer。plan-backed revision 的 `readPage` 由 `plan.producePage(pageId)` 驱动并按 PageID 缓存，`UNDECLARED` 直接抛弃、`PENDING` 在下次 demand 重试，因此重复 demand 不会重算同一页。`WasmGeometryProductRevision` 增加只读 `hasPendingPages`（plan-backed 由 `produced.size < pageCount` 决定），`pageCount` 改从 `pageRecords.byteLength / 32` 推导。`NyxWebRuntimeCooker` 的 bootstrap 仍走单体式 `cookCanonical`（首帧必须完整 resident），只有 richer revision 走 `planCanonical`；plan-backed revision 因为 descriptor 阶段拿不到覆盖全部 payload 的 manifest，改用零 manifest 加独立 `NYX_WEB_RUNTIME_PLAN_PRODUCER_VERSION` 推导 Provisional ProductID，替换链仍由 JSON 的 `replaces.productId` 指向 bootstrap 真 ProductID 维持不断。`WebCookCoordinator.cookBootstrap` 用 first-revision 完成屏障保持「返回时首个 activation cut 已完整 streamed」的原契约，后续 revision 的 streaming 在后台继续；activation 循环与 `requestPages` 共用经 `#emitTail` 串行化的 `emitPage`，因此 credit 记账与 `PageReady` 发布保持原子。`(slot, generation) → (productId, revision)` 反查链经核查已完整存在，无需新增代码：`GeometryPageSchedulerV1.ingestDemands` 按 `productGeneration` 查已注册产品，`produce()` 调 `product.source.readPage`，`VirtualGeometryResidency.sourceForStreaming()` 转发到 `LiveWebCookRevisionSource.readPage`，缺页时经 `WebCookProductProvider._requestPage` 走到 `WebCookClient.requestPages` 再到 coordinator。coordinator 侧新增 6 例测试覆盖 descriptor 冻结、demand 触发产出、已 streamed activation page 重发、以及 cancel 与 replacement 后已产出页不被重算。

退出条件：同一 revision 内 page 可逐批产出并被 `requestPages` 触发；activation cut 完整前不激活；取消与 replacement 不污染已产出 page。

### 第四步：真实浏览器增量上线验证与文档收尾

目标：在 ADR-0014 宿主上证明增量发布的可见效果，并把文档与代码事实对齐。

执行：新增或扩展 validation case，证明首帧后几何持续上线、GPU demand 正确消费增量 page、activation cut 不完整时不激活、payload 阶段失败不影响已上线 page。按 ADR-0014 保存真实浏览器、console、GPU diagnostics 与截图证据。同步校正 `STATUS.md` 与既有 implementation 中关于 cook 发布粒度的过时表述。

已落地：新增 validation case `glb-incremental-publication`（`validation/src/cases/glb-incremental-publication/`），复用 Rendering Lab 的 `examples/assets/three/rendering-lab/dungeon_warkarma.glb` 作为输入，在 ADR-0014 宿主上采集真实 Chrome 证据。四条断言分别对应本步四个证明点：activation cut 必须在 demand 之前完整 resident 且不得覆盖模型全部 page（否则增量不可观测），richer revision 必须落地，GPU demand 必须到达延迟调度器并把 resident page 数推高，demand 期间画面必须仍可绘制且 `WebCookClientEvidence.recoverableFailures` 必须为 0。case 附带 `activationCut`、`demand`、`residency` 三组证据写入 `evidence`，便于用数值复现结论；cook 侧把 `initialOutputPageCredits` 与 `maxBufferedPages` 提到 256、`maxOutputBytes` 提到 256 MiB，避免第三步已知的 credit 上限成为观测瓶颈。`STATUS.md` 与相关文档中「后台 cook 完整 richer revision 后原子替换」的表述同步校正为 descriptor 先冻结、activation cut 先产出、其余 page 由 demand 增量产出。

新 case 在首次运行中暴露出四个此前被既有 case 掩盖的产物缺陷，已随本步一并修复：

- `WebCookRuntimeAsset.readImageSource` 用 cook session 的 `state !== "open"` 作为贴图可用性判据，但贴图字节来自该 handle 自己的 GLB range source，与 cook session 生死无关；替换 revision 在 cook 已 `complete` 之后仍要映射材质，于是正常流程被判死（症状为 `Web Cook image source is unavailable in 'failed' state`，并把整个 cook 记为一次 provider failure）。改为按真正的失效条件判断：只有 `cancel` 或 `dispose` 之后才拒绝读图。
- `WebCookClient.revisions()` 的 `for await` catch 把消费者循环体抛出的错误也算成 session fatal，把上一条的局部失败放大成整个 session failed。改为只把 producer 侧 `iterator.next()` 的错误判为 fatal，消费者错误照常向调用方传播。
- 替换期同一张 authored 贴图被前后两个 revision 各解码并驻留一份，把 2048px 纹理 bank 撑到 33 层，超过 `GPU_TEXTURE_BANK_MAX_CAPACITIES` 的 32 层策略上限（设备侧 `maxTextureArrayLayers` 远高于此，所以是策略而非硬件限制）。因为 `TextureResidency` 是引用计数、`release()` 只在计数归零时释放，改为在同一场景生命周期内按 image index 共享 `ShadeTexture`。
- `PageReady` 事件经 `postMessage(event, [event.bytes])` 转移了 payload 的 ArrayBuffer，而 `WasmPlanPageSource` 把同一个 buffer 既当缓存又当交付物，导致缓存被 detach，同一页第二次被 demand 时返回 0 字节（症状为 coordinator 报 `got page ... with 0 bytes`，demand 侧表现为大量 failed 且 resident 页数不增长）。改为缓存持 master copy、每次交付 `slice(0)` 得到的独立副本。单体式路径不受影响，因为它的 payload 已全量物化、每次都是拷贝。

这四个缺陷在既有 `glb-web-product` case 上不显现：该 case 的 output credit 只有 32 且停在首帧附近，既跑不到替换后的材质映射，也跑不到 plan-backed 页的重复 demand。后两条已补回归测试（wasm 产物上的「transfer 后重读同一页」与 async mapper 上的「跨 revision 共享贴图」），前者在回退修复时会失败，确认测试有牙齿。

第四步退出条件已满足：revision `fd33257`（工作区 clean）上该 case 取得 `evidenceStatus: accepted`，证据为 ADR-0014 宿主采集的真实 Chrome 153 运行，具体数值归档在该 runId 的 `result.json` 与 `screenshot.png` 中。该次运行的关键读数：activation cut 24/53 页全 resident，替换 `replacements 1` / `activated 2` / `rejected 0` / `activeGeneration 2`，demand `requested 330` / `deduplicated 12` / `failed 0` / `residentBefore 374` → `residentAfter 375`，coverage 17394 lit pixels，cook 终态 `state open` / `transport.failures 0` / `provider.failures 0` / `recoverableFailures 0`，`errors` 为空。注意 demand 侧的 `requested` 与 `discardedPages` 随帧时序与相机停留时长变化，引用时必须注明是单次观测；cut 页数、覆盖率与 `replacements` 是跨 revision 可复现的。

退出条件：clean revision 上取得 accepted 级浏览器证据；文档与当前 ABI、identity 语义一致。

## Shared gates

- 每个 slice 完成后运行 `cd OEngine` 下的 `npm run typecheck` 与命中的 targeted tests；触及 ABI 或 identity 时额外运行 C++ ABI 测试与 golden 测试。
- 触及依赖或 lockfile 时运行 `cd OEngine` 下的 `npm ci`。
- 任何渲染正确性声明必须有 GPU timestamp、计数器、debug view 或截图/数值回归，不能只靠 typecheck。
- 浏览器证据必须来自 ADR-0014 的 `validation/` 宿主；采集前工作区必须 clean，否则 `provenance.dirty` 会把全部浏览器证据降级为 `diagnostic-only`。
- Nyx 算法不变量与既有 differential corpus 在每次拆分改动后必须继续通过；若平台限制导致核心语义无法保留，停止该 slice 并请求方向确认，不用简化实现顶替。
- 文档改动必须满足 `documentation-system.test.mjs` 的结构约束，并在提交前运行文档治理检查。
