# EEngine 文档/守门/成本模型一致性审计

- 审计对象：`D:\code\EEngine - 副本`，revision `09449d6d`（2026-10-05，工作树 clean，仅两份既有 untracked 审计文档）
- 审计方式：**只读**。未修改生产源码、测试、fixture、配置或既有文档；未执行 typecheck/build/test/benchmark/browser
- 已运行的命令：纯 planner 调用（`OEngine/.test-dist` 既有产物，见 §1.2）、五个治理 runner 的直接调用（只读，见 §4.2）、`node tools/vibe.mjs context --claims`、文件系统/import/正则静态扫描
- 与既有审计的关系：本文不重复 [`eengine-source-truth-audit-2026-10-05.md`](eengine-source-truth-audit-2026-10-05.md) 与 [`eengine-independent-source-gpu-performance-audit-2026-10-05.md`](eengine-independent-source-gpu-performance-audit-2026-10-05.md) 的源码普查。本文回答它们没有回答的问题：**当前权威设计文档是否与源码事实一致、成本模型能否达成自己的目标、守门机制是否真的生效。**

## 0. 结论摘要

三项独立问题，严重性递减，但第一项否决当前执行路线：

| # | 结论 | 证据强度 |
|---|---|---|
| **A** | **当前权威成本设计的目标（B=32 batch）在它自己的容量记账下不可达，上限是 B=47；把 batch 压到目标值只能带来约 1.5×，而达到 60fps 需要约 16.8×。** 因此按现设计继续推进 Phase 7 不能达成目标，与 Phase 7 投入多少无关。 | 实测运行 planner + 源码算术 |
| **B** | 容量事实在权威文档里有**三个版本**（23,296/364/90 与 25,536/399/82 都被称作"当前"，实测是 44,800/700/47），且 §17.1 的根因归因也已过期。三个入口文件（根 `README`/`docs/README`/根 `AGENTS`）状态均停在 Phase 5，HEAD 已是 Phase 7。 | 实测运行 planner + 全文检索 |
| **C** | **`verify --full` 在当前 revision 上必然失败**，唯一原因是退休清单把生产中的 `BloomPass.ts` 标为已退休（实测 `guard-legacy -> failed`，其余四个 guard 通过），且该 guard 的核心行为**没有任何测试覆盖**。叠加：73 个源文件无任何 importer、**整个依赖图是 15 个顶层目录的单一 SCC**（声明的分层是不存在的 DAG）、`platform.yaml:9` 的 catch-all 使 ownership 成为空门、`changed-ownership`/`changed-coverage` 在 `--full` 下结构性空转、18 个空 case 目录、证据层停在 9 月且原 artifact 已丢失。**10 月的全部重构是在没有可用集成门禁的条件下积累的。** | 实测运行治理 runner + 静态扫描 |

---

## 1. 方法、证据分级与边界

### 1.1 证据分级

- **实测**：本次运行命令产生的输出。
- **源码事实**：仅由本次读到的源码/配置直接支持，不依赖运行时参数。
- **推导**：由源码事实经算术得到，标注所用公式。
- **未验证**：需要真实 GPU/browser 才能确定，本次未做。

### 1.2 两次可执行验证

本次激活的非静态动作有两项，脚本均为一次性诊断、已删除：

**(1) 容量 planner 调用**（复现方式）：

```text
import { planSurfaceOptimizationCapacity } from "../OEngine/.test-dist/gpu/SurfaceOptimizationCapacity.js";
planSurfaceOptimizationCapacity(1920, 1080, {
  maxBufferSize: 256 * 1024 * 1024,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxTextureDimension2D: 8192
});
```

`.test-dist` 是仓库既有构建产物（时间戳 2026-10-05 09:03），本次**未重新构建**。因此该调用证明的是「当前源码的 planner 逻辑」，不等于「当前源码已通过 build」。

**(2) 治理 runner 直接调用**：

```text
import { loadModel } from "../tools/vibe-lib.mjs";
import { runCheckImplementation } from "../tools/check-runners.mjs";
for (const id of ["guard-legacy","guard-ownership","guard-docs","guard-generated-source","guard-public-api"])
  runCheckImplementation(model.checks.find(c => c.id === id),
    { repoRoot, model, changedOnly: false, changedPaths: [], uncovered: [], routingAmbiguities: [], evidence: null });
```

这是**单个轻量文件系统断言**的直接调用，**不是** `verify --full`（后者还会跑 engine-suites / validation-suites 等重型门禁）。

### 1.3 本次明确未做

未运行 typecheck、build、build:test、任何 test runner、GPU、browser、benchmark、`verify --module`、`verify --full`。此处"运行治理 runner"指直接调用 `runCheckImplementation()` 执行单个轻量 check（文件系统断言），**不是**运行 `verify --full`。

因此本文**不主张**任何测试通过、不主张任何性能验收、不主张任何 claim 晋级。§4.2 的 `guard-legacy -> failed` 是可复现的 check 结果，不是完整验收结论。

---

## 2. 结论 A：成本模型的目标在其自身约束下不可达

### 2.1 设计目标

[`surface-work-v3-cost-bounded-final-refactor-design-2026-10.md`:509](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md) §17.1 原文：

> 初始 desktop profile 目标 R=65,536，即 1,024 tiles；1080p 最大范围 B=ceil(32,400/1,024)=32。

### 2.2 容量决策的真实输入

[`OEngine/src/gpu/SurfaceOptimizationCapacity.ts:116-122`](../../OEngine/src/gpu/SurfaceOptimizationCapacity.ts) 决定 `batchTiles`：

```ts
let batchTiles = Math.min(tileCount, SURFACE_OPTIMIZATION_DEFAULT_BATCH_PIXELS / 64);  // = 4096
for (const [pool, field] of scratchProfile) {
  const poolLimit = Math.min(bindingLimit, SURFACE_OPTIMIZATION_BUDGET_MIB[pool] * MIB);
  batchTiles = Math.min(batchTiles, Math.floor(poolLimit / (stride * 64)));
}
```

随即 [`:161-171`](../../OEngine/src/gpu/SurfaceOptimizationCapacity.ts) 逐 tile 递减直到 `failures()` 为空。其中 [`failures()`:157](../../OEngine/src/gpu/SurfaceOptimizationCapacity.ts)：

```ts
if (physical.envelope > SURFACE_OPTIMIZATION_ENVELOPE_BYTES) result.push("retirementEnvelope");
```

而 [`physicalFor()`:146`](../../OEngine/src/gpu/SurfaceOptimizationCapacity.ts)：

```ts
envelope: scratch * 2 + 224 * MIB + 48 * MIB
```

`SURFACE_OPTIMIZATION_ENVELOPE_BYTES = 512 MiB`。**推导**：稳定帧的 scratch 上限不是 240 MiB（源码里声明的 `SURFACE_OPTIMIZATION_SCRATCH_ENVELOPE_BYTES` 在该路径上未被使用），而是

```text
(512 − 224 − 48) / 2 = 120 MiB
```

因为 `retirementOverlapBytes` 被赋为整份 scratch（[`:222`](../../OEngine/src/gpu/SurfaceOptimizationCapacity.ts)），`reservedBytes = scratch + retiredOverlap + persistent + output × 2`（[`:224`](../../OEngine/src/gpu/SurfaceOptimizationCapacity.ts)）。

### 2.3 实测结果

```text
=== Chromium desktop (maxBufferSize 256MiB / maxStorageBufferBindingSize 128MiB) ===
  tileCount=32400  batchTileCapacity=700  batchTargetCapacity=44800  batchCount=47
  limitingPools=["retirementEnvelope"]
  reservedBytes=511.8MiB  scratch=119.9MiB  retiredOverlap=119.9MiB
  scratch/tile = 179608 B

=== Chrome-146 tier (512MiB / 256MiB) ===
  tileCount=32400  batchTileCapacity=700  batchTargetCapacity=44800  batchCount=47
  limitingPools=["retirementEnvelope"]      ← 提高硬件 limit 完全无效
```

**源码事实 + 推导**：`limitingPools` 唯一项是 `retirementEnvelope`。提高 `maxBufferSize`/`maxStorageBufferBindingSize` 到 Chrome 146 tier 后 `batchTileCapacity` 不变。因此 batch 大小的约束**不是硬件 limit，是这条自定义记账规则**。

### 2.4 目标不可达的算术

```text
设计目标 1024 tiles 需要 scratch = 179,608 × 1024 / MiB ≈ 175.4 MiB
记账允许的 scratch 上限                        ≈ 120.0 MiB
=> 该记账下最大 batchTiles = floor(120 MiB / 179608) = 700   ← 实测确认
```

**结论**：R=65,536 / B=32 在 §17.2 的 512 MiB 记账下**数学上不可达**。当前 700 tiles / 47 batch 已经是这条规则的饱和值，不是"还没调好"。

### 2.5 杠杆量化：为什么这不是"再优化一轮"

设计自己在 [§19:603-608](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md) 给出模型：

```text
D = Dframe + B × (Dfrontend + Dstore + PpublishedPrograms + FproofFamilies + LworkerFamilies + Dcompose)
```

**推导**：

```text
把 B 从 47 压到设计目标 32        → 1.47×
达到 60fps 所需（最好一次实测 pass sum 280.374ms） → 280.374 / 16.67 ≈ 16.8×
达到 60fps 所需（设计文档引用的 run06 801.730ms）  → 801.73 / 16.67 ≈ 48.1×
```

即：**完全实现 §17.1 的目标，也只走完所需距离的约 9%**。设计自身在 [§23:736](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md) 已把"只删clear/扩batch/加setup"标为"有价值但不足"，但 §17.1 仍把它列为阶段目标，而 §21 的执行顺序没有任何一项处理 B×整链展开本身。

**结论 A**：需要在重新设计中删除的是 **B（CPU 逐 batch 展开整条消费链）作为主要成本因子**这一执行模型，而不是把 B 调小。设计在 [§19:608](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md) 已经写明"GPU 零 count 省 shader 工作，不省 CPU 编码"——即已经知道 B 是 CPU 侧固定成本，但没有据此改变结构。

### 2.6 需要用户判断的设计矛盾（我不单方面裁决）

512 MiB envelope 与"稳定帧不应按 resize 最坏重叠限制吞吐"之间存在设计级取舍：

- 稳定帧队列序执行下，前后 batch 的 scratch 能否复用，取决于是否存在跨 batch 并发或其他 pin。若不需要双份，当前 `scratch × 2` 使 batch 容量腰斩。
- 但该双份若确实是 resize/replacement 正确性所需，则应改为**只在 resize 路径支付**，稳定帧用单位 scratch。

这属于正确性与容量的联合取舍，本文只记录矛盾，不建议直接改 `× 2`。（对应可测退出条件：空/低覆盖场景 CPU command 数应为小常数；稳定帧不应因 retirement 永久 47 批。）

---

## 3. 结论 B：容量事实在权威文档里有三个版本

### 3.1 先纠正我自己的初判

初判为「§2.3 与 §17.1 互相矛盾」不够准确。实际读到原文后：

- §2.3 表（`:95-96`）写 `batch target capacity 23,296，即 364 tiles`、`batch 数 90`；
- §17.1（`:509`）写 `相对当前 23,296，这是待物理 layout/limits 算出的设计目标`。

两组数字各自内部自洽（`364×64=23,296`，`ceil(32,400/364)=90`，`ceil(32,400/1024)=32`），且 §17.1 明确把 23,296 称为"当前"。所以这是**「已测基线 vs 设计目标」的关系，不是算术冲突**。真正的缺陷是**那个"当前"值本身已过期**。

### 3.2 实际存在三个容量事实

| 版本 | 取值 | 出处 |
|---|---|---|
| V-a | `R=23,296 / 364 tiles / 90 batch` | 设计 §2.3:95-96、§17.1:509 称其为"当前" |
| V-b | `R=25,536 / 399 tiles / 82 batch` | `docs/domains/shading.md:74`、`phase3:46`、`phase4:34`、`phase5:53`、`phase55:23`、`review-and-readiness:24,38`、`progress:33` —— **共 8 处称其为"当前"** |
| V-c | `batchTileCapacity=700 / batchTargetCapacity=44,800 / batchCount=47` | **本次实测 planner**（§2.3） |

V-b 的 8 处还给出统一且可核验的根因归因：`floor(16MiB / (656B × 64)) = 399 tiles`，即"完整 656B record 套入 16 MiB geometryHot 配额"（`review-and-readiness:24`、`phase5:55`、`progress:33`）。

**实测**：当前 `limitingPools=["retirementEnvelope"]`，`geometryHot` 不再是直接约束。即**连 V-b 的根因归因也已过期**。

### 3.3 后果

1. 设计文档的成本基线不是当前代码的实际成本基线。
2. 「当前 23,296 → 目标 65,536」被表述为待实现的提升；实际是当前 44,800 已比 V-a 高 92%、比 V-b 高 75%，但离目标仍差 5.4× **且不可达**（§2.4）。
3. §2.2 的全部 P50 数据来自 run06（revision `daaed9c7` + dirty），而仓库已存在 `09449d6d` 身份的独立实测（两份 untracked 审计）。**权威设计仍以 run06 为成本基线，未采纳更新的同身份实测。**
4. 三个容量版本同时被称作"当前"，读者无法判断哪个是现在的约束——**修一个 bug 前先得确认约束是哪一条**。

### 3.4 文档日期与状态漂移

| 文件 | 声明 | 实际情况 |
|---|---|---|
| `README.md`:11 | "Phase5实施中、未收口" | HEAD 已是 `09449d6d`「Phase 7」；Phase 5/5.5/6 均已提交 |
| `docs/README.md`:8 | "Phase5工作树实施中、未收口" | 同上 |
| `AGENTS.md` §当前状态 | "另有未提交Phase5实现，当前未收口" | 同上 |

`docs/next-execution/...-progress-2026-10.md` 已更新到 Phase 7，但三个入口文件（根 `README`、`docs/README`、根 `AGENTS`）仍停在 Phase 5。**新 agent 按 AGENTS 的指示读到的第一条状态就是错的**——这与用户的"被低级 agent 改乱"体验直接相关。

### 3.5 每个 Phase 文档的表头都停在阶段开始时

**源码事实**：把每份 phase 文档第 3 行的状态与其最后一次提交对比：

| 文档 | 第 3 行状态 | 最后提交 |
|---|---|---|
| `...-phase5-implementation-2026-10.md` | 起点 `0c8caf30`（无完成状态） | `d5783b95` Surface Phase 5：修复唯一写者与证书包含性 |
| `...-phase55-implementation-2026-10.md` | **"状态：实施中、未完成"** | `a7e415d2` Surface Phase 6：收口重置、稳定绑定与真实生命周期 |
| `...-phase6-implementation-2026-10.md` | "实现与集中检查完成，**待中文提交**；Phase7未开始" | `a7e415d2`（即该提交） |
| `...-phase7-acceptance-2026-10.md` | "实施/验收中，未完成" | `09449d6d`（即 HEAD） |

即：**表头写于阶段开始时，阶段结束时没有回写**。Phase 5.5 的表头在 Phase 6 已提交后仍写"未完成"。执行计划 `...-execution-2026-10.md`:3 同样仍写"Phase 5 工作树实施中、未收口"，而它正是根 `AGENTS.md` 指向的"当前执行计划"。

后果：**读者无法通过文档判断任何阶段的真实状态**，必须去读 git log。这是"文档系统乱"最具体、最可修的一处。

### 3.6 证据层在 10 月重构期间完全停摆，且原始证据已不可恢复

**源码事实**（本次核对）：

| 项 | 状态 |
|---|---|
| `docs/status.generated.md` 声明的 revision `9462e5ac` | 是 HEAD 的祖先，**落后 153 个提交** |
| `docs/status.generated.md` | 在 `.gitignore:7` 中（未被追踪），但存在于工作树；mtime 2026-09-26 |
| 该文件是**域级**页面写在项目级路径 | 标题为 `# Project Status: virtual-assets`；生成器 `vibe-acceptance.mjs:437` 按 `domainId` 过滤 claim，`:439-440` 却固定写入 `docs/status.generated.md`。**17 条 claim 中有 12 条（frame-runtime / materials-textures / platform / shading / visibility）不在其中**，它无法充当项目状态页 |
| `validation/evidence/index.json` | 最后变更 `33af1de2`（2026-09-24）；顶层 revision `b35aad29`，**落后 201 个提交** |
| `validation/evidence/verification.json` | 在 `.gitignore:8` 中；revision `9462e5ac`（落后 153），`dirty: true`，claim 标为 `unproven` |
| 两份证据文件**互相矛盾** | `index.json` 描述 `b35aad29`/`7a494b7c`，`verification.json` 描述 `9462e5ac`；**两者都不是 HEAD** |
| 4 条 evidence 的 `artifactPath` 全部指向 `.local/validation/...` | **磁盘上全部不存在**（`onDisk=false`）⇒ 原始证据不可恢复，且不重跑 case 无法重建 |

**推导**：10 月全部重构工作（`14c17078` → `09449d6d`，含 Surface V3 Phase 0–7）**没有任何一项进入证据层**。这与 `AGENTS.md` 的开发节奏（"正式 evidence/claims 留最终验收"）一致，但结论是：

1. 整个 claim/evidence/registry 机制在 10 月是**只增负债、未产出**的状态。
2. `vibe verify --full` 的"正式验收"路径从未在 10 月源码上跑过。
3. 最关键的：**现存证据描述的是 9 月的代码，原始 artifact 已丢失**。任何"与历史版本比较"的正式验收都无法复用它们。

### 3.7 生成物策略自相矛盾

| 生成物 | 是否 git-tracked | 是否被 gitignore | guard 是否覆盖 |
|---|---|---|---|
| `docs/status.generated.md` | 否 | 是（`.gitignore:7`） | `check-runners.mjs:294` 显式在"被追踪"时报错 |
| `validation/evidence/verification.json` | 否 | 是（`.gitignore:8`） | — |
| `validation/registry.generated.json` | **是** | 否 | **无** |

`tools/vibe-lib.mjs:532` 把 `validation/registry.generated.json` 当作生成/忽略路径，`checks/guards/generated-source.yaml:8` 的 `patterns` 只匹配 `\.generated\.(?:ts|js)$`——**不含 `.json`**。因此该 guard 的声明的意图（`generated-source.yaml:4-5`"Keep generated JSON and generated source outputs out of the editable design authority"）**对它自己的例子里那个 JSON 不生效**：一个生成物被提交进版本控制，且没有任何检查发现。

**核实（本次未重跑生成器）**：registry 的 7 条 case id 与 7 份 `case.yaml` 一致，字段逐项相同；28 条 `changedPaths` 全部存在；场景 sha256 与磁盘文件重算结果一致。**即内容目前是对的，问题在策略不一致**，不是内容损坏。

### 3.8 度量身份歧义（已修正一次误判）

`docs/next-execution/eengine-next-dungeon-performance-2026-09.md:5` 写 `设备：NVIDIA RTX 2060 SUPER（Turing，8 GB）`，而冻结的项目身份是 `validation/registry.generated.json:400` `"NVIDIA GeForce GTX 1650 Ti"`。

**本次核实：这不是错误。** `docs/adr/0019-eengine-next-renderer.md:23` 明确 `目标设备以用户的 GTX 1650 Ti 与 RTX 2060 开发机为基线`，`docs/porting/next-renderer.md:92-93` 记录 RTX 2060 SUPER 上的 GPU readback 验证。第二台开发机是**经 ADR 认可的既有事实**。

真正的问题是**该文件没有任何状态标记**：它既不是当前设备基线，也未被标注为"另一台机器上的历史测量"。在 §3.3 那种"入口状态全是错的"环境里，读者很容易把 RTX 2060 SUPER 的数字与 GTX 1650 Ti 的数字当同条件比较——而 `docs/VALIDATION.md` 的 fixed-condition policy 明确禁止这件事。

### 3.9 死脚手架：18 个空的 case 目录

**实测**：`validation/cases/` 下 24 个目录中 **18 个完全为空**（0 文件、无 `case.yaml`）：

```text
glb-bootstrap-priority            sparse-shading-candidate
glb-incremental-publication       sparse-shading-production
glb-web-product                   virtual-product-device-loss
glb-web-product-authored-texture  virtual-product-observer
glb-web-product-isolated-pthreads virtual-product-offline
glb-web-product-portable-pool     virtual-product-production
phase1-visibility                 virtual-product-replacement
shading-bin-component             web-authored-large-perf
shading-resolve-component         web-authored-large-runtime-k1
```

只有 6 个目录非空，对应 registry 的 7 条 case（含 `validation/labs/` 下的 1 条）。

**推导**：Git 不追踪空目录，所以这些目录**在 clone 后不存在**，但它们在当前工作树上会误导任何按目录枚举 case 的人或脚本。`registry.generated.json` 的 `generatedFrom.source`（`:272-275`）也只列 `cases/` 与 `labs/`，未列真实输入 `profiles/`、`workloads/`——即生成物对自己来源的描述不完整。

---

## 4. 结论 C：守门机制失效

> 本节部分条目由并行只读审计确认，标注各自的验证等级。

### 4.1 Ownership 路由声明了零匹配的路径

`project/domains/*.yaml` 共 117 条 pattern，**12 条匹配不到任何文件**。分两类：

**A. 路径根本不存在（5 条，逐条 `Test-Path` 验证）**

| owner | 路径 |
|---|---|
| frame-runtime | `OEngine/src/render/runtime/**`（`paths` 与 `watch` 各写一次） |
| virtual-assets | `OEngine/src/render/scene/**` |
| virtual-assets | `OEngine/src/render/virtual/**` |
| visibility | `OEngine/src/render/LargeTriangleSetupCache.ts` |
| visibility | `OEngine/src/render/visibility/**` |

**B. 目录存在但为空（对应 §3.9 的 18 个空 case 目录）**

`frame-runtime`、`materials-textures`、`shading`、`virtual-assets`、`visibility` 各自的 `validation/cases/*/**` glob 指向 0 文件的目录。

`node tools/vibe.mjs context OEngine/src/render/program` 能正确返回 `frame-runtime`，说明基本路由可用；但 `render/runtime/**`、`render/visibility/**` 这类**规划期的目录**被写成已存在路径，会让读者以为那里有实现。

**注意**：这类问题之所以长期无告警，是因为没有任何工具检查"声明的 pattern 是否匹配到文件"——见 §4.3。

### 4.2 退休路径清单含假条目，且它使 `verify --full` 当前必然失败

`checks/guards/legacy.yaml` 的 `retiredPaths` 中，`OEngine/src/render/passes/BloomPass.ts` **当前存在且在生产路径上被使用**：

| 位置 | 内容 |
|---|---|
| `RendererCore.ts:35` | `import { BloomPass } from "../passes/BloomPass.js";` |
| `RendererCore.ts:1243` | `this._bloom = new BloomPass(device);` |
| `RendererCore.ts:1293` | `bloom: this._bloom,`（作为 `FrameProgramOwners` 成员传入） |
| `FrameProgramLowering.ts:38` | `bloom: BloomPass;` |
| `FrameProgramLowering.ts:486` | `owners.bloom.addToGraph(...)` |

runner 实现（[`tools/check-runners.mjs:212-217`](../../tools/check-runners.mjs)）是硬失败：

```js
"retired-paths": (check) => {
  for (const path of config.retiredPaths ?? []) {
    if (existsSync(resolve(REPO_ROOT, path))) findings.push(`retired path still exists: ${path}`);
  }
  return findings.length === 0 ? passed() : failed(findings);
}
```

该 check 被真实引用：`project/domains/platform.yaml:59`、`project/claims/platform.yaml:34`、`project/claims/shading.yaml:8`。

**实测**（只读运行治理 runner，未跑 build/test/browser）：

```text
=== guard-legacy -> failed ===
   retired path still exists: OEngine/src/render/passes/BloomPass.ts

=== guard-ownership        -> passed ===
=== guard-docs             -> passed ===
=== guard-generated-source -> passed ===
=== guard-public-api       -> passed ===
   OEngine/src/index.ts resolves every relative re-export
```

**推导**：`vibe-acceptance.mjs` 把 `failedChecks` 计入结果并使进程以退出码 1 结束。因此 **`npm run vibe:final` / `node tools/vibe.mjs verify --full` 在 `09449d6d` 上必然失败**，唯一原因是这份退休清单里的一条错误条目。

这是本次审计最可操作的一条，也解释了 §3.6：**10 月的正式整合门禁从未通过，整个 10 月的漂移是在没有集成门禁的情况下积累的。**

**这条假条目是怎么来的（git 证据）**：`bbfbfda5` 删除 `BloomPass.ts` 的**同时**加入了这条 guard 条目；随后 `53523212`（"完成模块 D 辐射度与呈现链路"）**重新加回了该文件（+110 行）**，而 guard 条目**从未同步移除**。`docs/adr/0020-clean-cut-renderer.md` 全文未提到 Bloom——它从未被正式列为清理对象。

**为什么没有测试拦住它**：`OEngine/tests/guard/check-runners.test.mjs:48-52` 只测两种输入——`["OEngine/package.json"]`（必须存在）与 `["no/such/path"]`。**没有任何用例断言"一个真实存在的路径会导致 failed"**。guard 的核心行为从未被测试覆盖，假条目因此长期存活。

另外，62 条清单中其余条目的抽检（`MainRenderPipeline`、`SceneFrameBindings`、`shading_bin_classify`、`GpuShadingPublicationPlan`、`FrameContext`、`RendererDebug*` 等 12 条）**均确认为正当退休，没有第二处误判**。最强证据：对 `OEngine/src`、`OEngine/tests`、`validation/` 共 1,450 个文件解析全部相对 import，**悬空 import = 0**。

其余四个 guard 实测通过，说明守门机制骨架是好的——问题是**没有任何一次集成运行来暴露这条错误配置**。

### 4.3 Ownership 路由实际上是空门（比"声明了零匹配路径"严重）

**源码事实**：`project/domains/platform.yaml:9` 声明了 `- OEngine/src/**`。这一条 catch-all **单独匹配 616 个文件**，因此：

- **未归属的 `OEngine/src` `.ts` 文件 = 0 / 581**。不是因为归属做得好，而是因为 catch-all 让每一个文件都有归属。
- **173 / 581** 个文件**仅**被 platform 的通用 pattern 匹配（`gpu/` 86、`debug/` 27、`render/` 17、`addons/` 15、`texture/` 8、`scene/` 5…）。其中最大的几个本该有明确 owner：

| 文件 | 字节 | 只被 platform 匹配 |
|---|---:|---|
| `gpu/GpuAssetStore.ts` | 61,345 | 是 |
| `gpu/GpuScene.ts` | 60,012 | 是 |
| `gpu/GPUDatabase.ts` | 52,885 | 是 |
| `debug/FrameProfiler.ts` | 51,858 | 是 |
| `gpu/GpuAppearancePublication.ts` | 48,087 | 是 |
| `scene/Scene.ts` | 36,328 | 是 |

- **推导**：`guard-ownership` 的 runner 只在 `context.uncovered.length > 0 || context.routingAmbiguities.length > 0` 时失败（`check-runners.mjs:198-203`）。`uncovered` 由 `paths` 匹配计算，catch-all 使其恒空；`routingAmbiguities` 实测为 0。**因此 `guard-ownership` 对 `OEngine/src` 不是有效门禁。**

**没有任何工具检查"声明的 pattern 是否匹配到文件"**：`domain.paths` 只在 `vibe-acceptance.mjs:187` 与 `vibe.mjs:69` 被读取。这就是 §4.1 那 12 条零匹配声明能长期存在而不被发现的原因——**5 条路径不存在，另 6 条指向 18 个空 case 目录（§3.9）**，两种都无告警。

### 4.4 孤儿文件

**源码事实**：扫描 `OEngine/src` 581 个 `.ts` 的静态相对 import 后，**73 个文件（15,224 行）没有任何 importer**（`src/index.ts` 作为 entry 排除）。

最大的几个：

| 行数 | 文件 |
|---:|---|
| 1759 | `geometry/GeometryCooker.ts` |
| 717 | `shaders/ssr_denoise.ts` |
| 587 | `render/passes/PackedTransparentOitPass.ts` |
| 580 | `gpu/MeshletGpuPool.ts` |
| 512 | `gpu/ShadowAtlas.ts` |
| 452 | `shaders/long_range_diffuse_provider.ts` |
| 443 | `shaders/nss.ts` |
| 376 | `render/passes/SharedColorPyramidPass.ts` |
| 365 | `render/passes/AutomaticExposurePass.ts` |
| 296 | `shaders/ssr_trace.ts` |

其中整套 SSR 生成器（`ssr_trace` + `ssr_resolve` + `ssr_denoise` = 1,227 行）是 `nextModules` 里 SSSR 的**未接线**素材，`nss.ts`/`MotionBlurPass`/`SharpenPass`/`ColorGradingPass` 等是未接线的效果。它们不是垃圾，但**当前没有任何机制区分「为未来保留的未接线素材」与「已退休残留」**，两者混在同一个 `src/` 里同样不可见。

注意：guard `retired-paths` 只检查"清单里的文件不应存在"，**没有反向检查"不存在的 importer"**——所以这 73 个文件对任何 guard 都是不可见的。

### 4.5 分层反向依赖：不是"几处越界"，而是整个依赖图是一个 SCC

根 `AGENTS.md` 声明 `core + runtime assets → gpu → framegraph + render + shaders`。**源码事实**（581 文件 / 2,346 条边）：**143 条向上边 = 70 runtime + 73 type-only**。

| 违反方向 | 位置 |
|---|---|
| `gpu` → `render`（8，全部 runtime） | `GpuRenderWorld.ts:30` → `render/MeshletBucketRaster.ts`、`:31` → `render/vsm/VsmAtlasRasterPass.ts`（gpu 需要 render 来建自己的 pipeline）；`GraphicsContext.ts:8,40,41,42,43,46` |
| `scene` → `render`（1，runtime） | `Scene.ts:23` → `render/environment/PhysicalEnvironmentState.js` |
| `core` → 上层（6 runtime + 2 type-only） | `core/index.ts:8` re-export `texture/Sampler2D`（且 `texture/Sampler2D.ts:5-6` 反向 import core ⇒ 成环）；`core/TableSpec.ts:18,22`；`core/WgslBufferIO.ts:6` |
| `loaders` → `gpu`（1，runtime） | `loaders/load_gltf.ts:8` `GPU_INSTANCE_FLAGS`，`:405-413` 使用（loader 直接写 GPU ABI 位） |

其余：`gpu→framegraph` 25（3 runtime）、`gpu→shaders` 11 runtime、`assets→material/texture/loaders` 12、`render→debug` 13、`shaders→debug` 5 等。

**关键发现（本次审计新增，比"8 处越界"严重得多）**：

- **21 对互相依赖**，含 `gpu↔render`、`gpu↔framegraph`、`core↔loaders`、`core↔texture`、`scene↔render`、`assets↔gpu`…
- **整个依赖图是 15 个顶层目录的单一强连通分量**：`{animation, assets, camera, core, debug, framegraph, geometry, gpu, light, loaders, material, render, scene, shaders, texture}`。

**推导**：`AGENTS.md`、`OEngine/AGENTS.md`、`render/AGENTS.md` 里的"依赖方向"图**不是当前依赖图的抽象，而是一个不存在的 DAG**。没有可用拓扑序，因此"某层不得依赖某层"这类规则在当前代码上**无法被机械执行**，只能逐条特判。

**而且唯一的守门测试是无效的**（本次逐字核对）：`OEngine/tests/guard/render-layer-ownership.test.mjs:19-27` 的正则是

```js
/(?:\.\.\/render\/(?:passes\/|ViewContext|GPUCameraState))/u
```

它只匹配 `render/passes/`、`ViewContext`、`GPUCameraState` 三种形式（历史形态）。真实的 8 条 `gpu→render` 边指向 `render/MeshletBucketRaster`、`render/vsm/VsmAtlasRasterPass`、`render/STATIC_GRAPHICS_ENGINE_ASSETS` 等，**全部不匹配 ⇒ 测试通过，8 条真实边全部未检查**。

注意该测试文件其余断言用的是源码正则匹配（`assert.match(core, /lowerFrameProgram\(/u)` 等），而项目自己的规则（执行计划 §1.4）明确"**源码正则不证明生产算法完成**"。这类断言只证明字符串存在，不证明行为。

### 4.6 `verify --full` 里有结构性空转的门禁

**源码事实**：`vibe-acceptance.mjs:182-187,193,199`：

```ts
const routingAmbiguities = changedOnly ? ... : [];
const uncovered = changedOnly ? changedPaths.filter(...) : [];
if (changedOnly) checkIds.add("changed-coverage");
for (const claim of claims) for (const checkId of claim.requiredChecks ?? []) checkIds.add(checkId);
```

**推导**：在 `--full` 模式下 `uncovered` 与 `routingAmbiguities` 恒为 `[]`，于是：

| check | 在 `--full` 的实际行为 |
|---|---|
| `changed-ownership` | 条件恒假 ⇒ **必然通过**（空转） |
| `changed-coverage` | 不在 full 的 checkIds 中（仅 changed 模式注入） |

但 `changed-coverage` 被 **9 个 claim** 列为 `requiredChecks`（`platform.yaml:21,34`、`shading.yaml:36`、`virtual-assets.yaml:8,36,50,64`、`visibility.yaml:23`），而 `vibe-lib.mjs:718,758` 表明 claim 只接受 `scope: "full"` 的 receipt。**即 claim 要求一个在 full 模式下不被执行的 check。** 这与 §3.7 生成物策略矛盾是同一类问题：**声明与执行不一致**。

另外 `model` 与 `docs-frontmatter` 共用 runner `project-model`，而该 runner 的实现是常量 `() => passed([...])`（`check-runners.mjs:190`）——真正的断言在 `validateModel` 里。**读 runner 代码会得出"这个 check 是空壳"的错误结论**；问题在于这种"runner 名与断言位置不一致"的结构本身容易误导。

---

## 5. 用户提问的直接回答

> "文档系统、代码架构实现我感觉都有点乱了，之前被其他低级的 agent 给改乱了"

**"乱"是真实存在的，但三个层次的原因不同：**

1. **不是品味问题，是缺生命周期机制。** 文档本身质量高（口径、可信度边界、未运行声明都很硬）。真正的问题是**没有一条从"当前"退到"历史"的自动化路径**：`docs/next-execution/` 有 47 份文件，同一 slice 的 phase 记录 11 份，每个 Phase 都新增文件而不收敛。加上三个入口（根 README / docs/README / 根 AGENTS）状态停在 Phase 5，新 agent 读到的第一条就是错的——**低质量 agent 的表现是"跟着错的入口做错的事"，不一定是它自己判断错。**

2. **不是设计错误，是无人守门——而且门禁本身是坏的。** `verify --full` 在当前 revision 上因一条错误配置必然失败（§4.2）。73 个孤儿文件、`gpu→render` 反向依赖、ownership 声明不存在的路径，全都生长在"没有可用的集成门禁"这个条件下。**这不是"有 guard 但 agent 不遵守"，而是"唯一的整体门禁从 10 月起就是红的，于是没人再看它"。**

3. **最关键的一条不是"乱"，是"方向错了但文档没承认"。** 权威设计 §2.2 自己就写明"主要成本发生在决定怎么计算、查询复用和准备证明，而非实际 BRDF/材质"，§23 也拒绝"只删clear/扩batch"。但 §17.1 仍把 B 从 47 压到 32 当阶段目标，而 §2.4 证明那个目标不可达、且即使达成也只是所需距离的 9%。**这不是 agent 执行跑偏，是设计与自身分析脱节。**

**因此我的建议顺序（与你的选择一致）：**

```text
0. 立刻：从 checks/guards/legacy.yaml 删除 BloomPass.ts 条目 → 让 verify --full 重新可用
   （唯一一条"一行改动解除整体门禁不可用"的问题；BloomPass 已确认在生产路径上）
   + 补一个测试用例：真实存在的路径必须导致 failed（当前该行为无测试覆盖）
1. 修入口状态漂移（低成本、立即止血）
   → 根 README / docs/README / AGENTS.md / 执行计划与设计表头 与 progress 对齐
   → 建立"阶段收尾必须回写表头"的规则
2. 修守门（让"乱"重新可见）
   → platform.yaml:9 的 OEngine/src/** catch-all 是 ownership 空门的根源，需收紧
   → retired-paths 反向检查（无 importer 的文件）
   → 新增"声明的 pattern 必须至少匹配一个文件"的检查
   → 修 render-layer-ownership.test.mjs 的正则（当前漏掉全部 8 条真实 gpu→render 边）
   → 认清：整个依赖图是单 SCC，声明式分层无法机械执行，需要先决定分层是"目标"还是"现状"
3. 再做成本模型重新设计（§2 的结论 A）
   → 删除 B 作为主要成本因子；FrameGraph O(n×m) 改预编译 release list
4. 最后收敛文档（next-execution 26 份的归档规则）
```

**关于第 2 步的一个前置判断**：分层既然已经是单 SCC，改 guard 之前需要你先定：`AGENTS.md` 里的依赖方向图是**要实现的目标**（那么 guard 应该报错，且要先修代码），还是**已过时的理想描述**（那么应该改文档，承认现状）。我倾向后者为主、前者只保留 `gpu`/`scene` 不得依赖 `render` 这类有明确架构理由的少数约束——但这是你的设计决定。

先做 0/1/2 再做 3，是因为**成本模型重设计需要可信的测量与可信的导航**。当前状态是：正式门禁失败、入口状态错误、没有任何集成信号——在这种状态下改架构，新设计会像 §3 那样很快与源码脱节。

---

## 6. 待核实项（本次未完成，如实列出）

| 项 | 状态 |
|---|---|
| BloomPass 是否**确实**不属于要退休的对象 | **已核实为生产使用**（§4.2 五处引用）。但"它是否其实应该被退休、清单才是对的"需要设计判断，本次未裁决。 |
| 其余 60 条 retiredPaths 是否另有错误 | **部分核实**：60 条中仅 `BloomPass.ts` 存在。未逐条核对"该路径本应存在却被误删"。 |
| 73 个孤儿文件各自的真实状态（未来素材 / 已退休 / 可删） | **未完成**。需要逐文件判断 importer 意图，不能只按 import 图删。已知 `shaders/ssr_*` 属 `nextModules` 的 SSSR 未接线素材。 |
| `validation/registry.generated.json` 内容与当前 `validation/cases/` 是否一致 | **未完成**。已确认它是 git-tracked 生成物且最后写入早于 10 月重构。 |
| `docs/reviews/temp/` 2780 行 blueprint 的权威性 | **未完成**。该目录在 `reviews/` 下，而 `docs/README.md` 把 `reviews/` 定位为"日期化检查与历史诊断"，不是设计依据；`temp/` 子目录的定位在任何文档中都未被定义。 |
| `project/claims/*.yaml` 每条 claim 的 lifecycle 与 requiredChecks 交叉核对 | **未完成**。已确认 `docs/status.generated.md` 中 5 条 claim 全部 `retired`/`stale`，未逐条核对 claim 定义本身。 |
| canonical 文档集合规模 | **源码事实（已完成）**：`docs/` 140 份 md / 19,072 行；全仓库（不含 node_modules）474 份 md / 62,519 行；`docs/next-execution/` 下 25 份 md。 |
| `.local` / `temp` / `.codex-temp` 空间占用 | **源码事实（已完成）**：`.local` 13.25 GB / 7,517 文件；`temp` 770 MB / 2,081 文件；`.codex-temp` 30 MB / 238 文件。三者均不在版本控制内，不影响仓库内容，但影响本机磁盘与同步。 |

## 7. 本次结论不主张的内容

- 不主张当前源码编译/测试通过（未运行）。
- 不主张任何性能收益或回退（未运行 benchmark）。
- 不主张具体 FPS 或百分比。
- 不主张 73 个孤儿文件应被删除——其中部分是 `nextModules` 的未接线素材，删除需先确认意图。
- §2.6 的 512 MiB 取舍是设计判断，本文只记录矛盾，未建议直接改 `× 2`。
