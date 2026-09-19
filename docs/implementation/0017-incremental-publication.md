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

退出条件：identity 上卷算法被 spec 冻结；golden 测试覆盖 identity 与整页完整性校验的分离（篡改 payload 改变 identity 或被抓，篡改 padding 不改变 identity）；不同线程数下 identity 可复现。

### 第二步：扩展 Geometry Cooker 两阶段 ABI

目标：在 `.h` 与实现中提供 descriptor 阶段与 payload 阶段可分离的入口，并递增 ABI 版本。

执行：新增 descriptor 阶段入口，使其返回可在无 payload 前提下查询 page 数量、page identity、page 到 Group 映射与 activation cut 的 handle。新增 payload 阶段入口，支持按 PageID 推进并返回该页字节，保证已完成 PageID 可重复取回且 byte-identical。显式表达「PageID 已声明但 payload 未产出」状态，使消费侧可与「PageID 不存在」区分。对未声明 PageID 的推进请求返回错误而非扩张 ID graph。递增 `kAbiVersion` 并让旧版本 consumer 显式失败。同步更新 TypeScript 侧镜像与 descriptor binary transport 的版本拒绝测试。

退出条件：C++ ABI 测试覆盖两阶段分离、乱序/重复/并发推进、未声明 PageID 拒绝、阶段失败隔离；TypeScript 镜像与 C++ 行为一致；旧 ABI 版本被显式拒绝。

### 第三步：Producer 侧切到两阶段调度

目标：让 Web Runtime Cooker 与普通 Scene 路径按 GPU demand 安排 payload 阶段，而不是一次算完全部 page。

执行：改造 `NyxWebRuntimeCooker`，把 `cookProgressive` 从「bootstrap revision + 完整 revision 原子替换」改为「descriptor 一次冻结 + activation cut payload 先产出 + 其余 page 按 demand 增量产出」。确认 `WebCookCoordinator.requestPages` 能把 GPU demand 的 `(slot, generation)` 反查为 `(productId, revision)` 并触发 payload 推进；补齐当前缺失的反查链。保持 output credit、并发预算与 generation 失效语义不变。确认 activation cut 完整 resident 前不激活的既有约束不被放宽。

退出条件：同一 revision 内 page 可逐批产出并被 `requestPages` 触发；activation cut 完整前不激活；取消与 replacement 不污染已产出 page。

### 第四步：真实浏览器增量上线验证与文档收尾

目标：在 ADR-0014 宿主上证明增量发布的可见效果，并把文档与代码事实对齐。

执行：新增或扩展 validation case，证明首帧后几何持续上线、GPU demand 正确消费增量 page、activation cut 不完整时不激活、payload 阶段失败不影响已上线 page。按 ADR-0014 保存真实浏览器、console、GPU diagnostics 与截图证据。同步校正 `STATUS.md` 与既有 implementation 中关于 cook 发布粒度的过时表述。

退出条件：clean revision 上取得 accepted 级浏览器证据；文档与当前 ABI、identity 语义一致。

## Shared gates

- 每个 slice 完成后运行 `cd OEngine` 下的 `npm run typecheck` 与命中的 targeted tests；触及 ABI 或 identity 时额外运行 C++ ABI 测试与 golden 测试。
- 触及依赖或 lockfile 时运行 `cd OEngine` 下的 `npm ci`。
- 任何渲染正确性声明必须有 GPU timestamp、计数器、debug view 或截图/数值回归，不能只靠 typecheck。
- 浏览器证据必须来自 ADR-0014 的 `validation/` 宿主；采集前工作区必须 clean，否则 `provenance.dirty` 会把全部浏览器证据降级为 `diagnostic-only`。
- Nyx 算法不变量与既有 differential corpus 在每次拆分改动后必须继续通过；若平台限制导致核心语义无法保留，停止该 slice 并请求方向确认，不用简化实现顶替。
- 文档改动必须满足 `documentation-system.test.mjs` 的结构约束，并在提交前运行文档治理检查。
