---
id: archive/eengine_next_renderer_final_architecture
state: history
---
# EEngine Next Phase 3 — Codex 强推进 Prompt Pack

# Prompt 0 — 先解除 Phase 3 的文档阻塞

把这一段先给 Codex。

```
你现在不是重新设计 EEngine Next Renderer。

ADR-0020 的 Clean-Cut Renderer 总方向已经接受，Phase 1 / Phase 2 已经完成或进入收口状态。

当前问题是：

Phase 3 的 workstream / 文档把：

- Physical Environment
- Temporal Fabric
- FSR3 Upscaler
- Minimal Virtual Resource Contract

绑定成了一个过大的 currentSlice / exit gate，导致 Coding Agent 把“Phase 3 最终完成条件”错误理解为“当前每个 commit 都必须一次满足全部条件”，从而停止推进。

现在首先修订执行文档，然后立即继续代码。

==================================================
一、原则
==================================================

ADR-0020 不修改。

Clean-Cut 不修改。

以下原则继续保持：

- 单 Renderer production path；
- 不恢复 MainRenderPipeline；
- 不恢复 CSM fallback；
- 不恢复旧 SSR / GTAO / SSGI / TAA；
- 不建立 Legacy/Next 双轨；
- breaking API 允许；
- upstream port 必须忠实；
- 不允许为了推进而自行简化 Takram / FSR3 / VSM / SSSR 等算法。

但必须新增一条执行原则：

“Phase-level exit criteria 不得阻塞 phase 内已经具备输入条件的 vertical slice。”

换句话说：

Phase 3 最终需要 Atmosphere + Temporal + FSR3 + minimal virtual contract，

不代表：

完成 Atmosphere 的 commit 必须同时完成 FSR3。

==================================================
二、把 Phase 3 拆成执行 Slice
==================================================

仍然只有一个 Phase 3，不增加新的架构世代。

把当前 environment-temporal 大任务拆成：

Phase 3A
environment-production-closure

Phase 3B
temporal-production-closure

Phase 3C
fsr3-source-and-port

Phase 3D
phase3-integration-close

执行顺序：

3A
→ 3B
→ 3C
→ 3D
→ Phase 4

==================================================
三、修订 eengine-next-clean-rebuild workstream
==================================================

当前 currentSlice 改为：

environment-production-closure

Phase 3A exit criteria 只包含 Physical Environment 本身。

不要包含：

- FSR3 完成；
- Temporal 完成；
- VSM；
- Full Virtual Resource Runtime；
- Full VT。

将这些保留在 Phase 3 总体任务或后续 slice。

==================================================
四、增加“Agent 不得因下游 Gate 停工”的规则
==================================================

在 workstream 或合适 contract 中明确：

如果当前 vertical slice：

- upstream source 已固定；
- 本地已有所需输入；
- 不依赖尚未实现的后续系统；

则 Coding Agent 必须继续实现该 slice。

不得因为：

- 下一 slice 尚未完成；
- Phase 总 exit criteria 尚未全部满足；
- Phase 4 需要的系统尚未存在；

而停止当前实现。

例如：

Physical Sun 不需要等待 VSM。

Phase 3A 时：
DirectVisibility = 1
是明确允许的临时 production 语义。

这不等于恢复 fallback。

==================================================
五、增加“文档冲突时”的处理规则
==================================================

如果执行过程中发现：

- workstream；
- AGENTS；
- current docs；
- contract wording；

与 ADR-0020 或当前已接受的 slice 顺序冲突，

不要停止并等待人工。

先判断：

1. 是否属于架构级冲突？
2. 还是执行文档已经过时？

如果只是执行文档过时：

直接在同一个 change batch 修订文档，然后继续代码。

只有真正需要改变 ADR-0020 总架构时才停止。

==================================================
六、不要做
==================================================

此次文档修订不要：

- 新建 ADR-0021；
- 重写整个 docs 系统；
- 增加十几个新 contract；
- 重新设计 Renderer；
- 开始 FSR3；
- 开始 VSM；
- 开始 VT；
- 开始 Product Compiler 大重构。

只解除 Phase 3 的执行粒度阻塞。

==================================================
七、完成后立即继续
==================================================

不要在文档修完后停下来汇报“等待下一步”。

完成文档修订后：

立即进入 Phase 3A Physical Environment production closure。

除非遇到真实代码或上游 source 阻塞，否则不要再要求用户确认。
```

# Prompt 1 — Phase 3A：Physical Environment 直接推进

文档解锁后马上给这一段。

```
继续执行 ADR-0020 Phase 3A：

environment-production-closure

不要重新分析整个 EEngine。

不要开始 FSR3。

不要开始 VSM。

不要开始 Virtual Texture。

不要恢复旧 EnvironmentBackgroundPass / DirectionalLight world-sun owner。

当前仓库已经具有：

- pinned Takram source；
- tools/atmosphere-port；
- source digest / license；
- Takram LUT WGSL generation；
- AtmosphereLutResources；
- PhysicalEnvironmentState。

现在任务不是继续搭空抽象。

任务是：

把 Takram Physical Environment 接成真正 production vertical slice。

==================================================
目标生产数据流
==================================================

Atmosphere Profile
        ↓
Atmosphere LUT
        ↓
Physical Environment Generation
        │
        ├ Physical Sun
        ├ Sky Radiance
        ├ Sky Irradiance
        ├ Transmittance
        └ Aerial Scattering

Physical Sun
        ↓
Surface Direct Lighting

Sky
        ↓
Background / Environment lighting

Scene Radiance + Depth
        ↓
Aerial Perspective
        ↓
Atmosphere-composited Radiance

==================================================
Step 1 — 建立真正的 owner
==================================================

建立 production PhysicalEnvironmentRuntime。

名字可以根据现有目录调整，但职责必须明确。

它负责：

- pinned atmosphere profile；
- LUT resource lifetime；
- environment generation；
- Physical Sun state；
- Sky state；
- FrameGraph registration；
- commit / abort / replacement 生命周期。

不要让 RendererCore 直接拥有大量 Takram pass 细节。

RendererCore 只负责：

- 获取当前 environment；
- 将 environment products 传给 frame planning / lowering。

==================================================
Step 2 — 当前 profile 先冻结
==================================================

第一版继续使用当前 pinned Takram Earth atmosphere profile。

不要在这一 slice 扩成：

- 通用 planet editor；
- 可动态修改所有 Rayleigh/Mie 参数；
- geospatial engine。

EEngine 世界保持：

- local world；
- Y-up；
- meter unit。

只建立必要的 local frame adapter。

==================================================
Step 3 — 忠实迁移 Runtime Sun
==================================================

沿当前 pinned Takram source 建 source→local mapping。

迁移真正的：

- sun transmittance；
- direct solar irradiance；
- atmosphere-dependent Sun output。

不要用：

- white DirectionalLight；
- hard-coded color；
- constant intensity；

冒充 Physical Sun。

==================================================
Step 4 — 接入当前 Surface Direct Lighting
==================================================

让当前新 Surface path 消费：

PhysicalSun direction
PhysicalSun irradiance

当前没有 VSM。

明确：

DirectVisibility = 1

这是 Phase 3A 的合法生产语义。

不得恢复 CSM。

不得等待 Phase 4 VSM。

==================================================
Step 5 — Sky
==================================================

迁移 Takram runtime Sky sampling。

建立真实：

SkyRadiance Product

并接到 production background / environment path。

不要重新启用旧 EnvironmentBackgroundPass。

==================================================
Step 6 — Sky Irradiance
==================================================

迁移 Takram indirect irradiance 语义。

作为 Environment Lighting 输入。

不要简单恢复旧 HDR cubemap IBL owner。

==================================================
Step 7 — Aerial Perspective
==================================================

建立真正的 atmospheric transport consumer：

Scene Radiance
+
Depth
+
Atmosphere
+
Sun / Environment generation
↓
Aerial Perspective
↓
Atmosphere-composited Radiance

不能简化成：

distance fog

或：

color = mix(scene, sky, depth)

必须忠实迁移 Takram 对应算法语义。

==================================================
Step 8 — Generation consistency
==================================================

Sun / Sky / Aerial 必须消费：

同一个 immutable Environment Generation。

不能：

Sun 用 generation N
Sky 用 N+1
Aerial 用另一个 LUT

LUT replacement 必须遵守：

record
→ commit

失败：

→ abort / retain old valid generation

==================================================
Step 9 — FrameGraph
==================================================

不要增加独立 submit。

所有 atmosphere / environment GPU work 进入当前 FrameGraph / frame encoder。

LUT 如果无需更新：

不应每帧重算。

==================================================
Step 10 — Validation
==================================================

只做 focused validation：

- LUT source mapping；
- environment generation lifecycle；
- Sun direct output；
- Sky output；
- Aerial depth behavior；
- device loss / resource replacement；
- 一个 production diagnostic scene。

不要为 Phase 3A 建立重型 benchmark suite。

==================================================
完成条件
==================================================

必须达到：

[ ] PhysicalEnvironmentRuntime 已是 production owner
[ ] LUT 在生产路径生成/缓存
[ ] Physical Sun 已进入新 Surface direct-light path
[ ] Sky 真正显示
[ ] Sky irradiance 有真实 consumer
[ ] Aerial Perspective 真正进入 frame
[ ] Sun/Sky/Aerial 同 generation
[ ] 无独立 submit
[ ] 无 CSM
[ ] 无旧 HDR world-environment owner

完成后：

更新 docs/domain/current facts
更新 porting mapping
更新 workstream

然后自动把 currentSlice 推进为：

temporal-production-closure

不要停下来等待用户确认。
```

# Prompt 2 — Phase 3B：Temporal Fabric 真正闭环

```
继续 ADR-0020 Phase 3B：

temporal-production-closure

Physical Environment 已视为上一 slice 完成。

本 slice 不做 FSR3 shader port。

目标是：

让 Temporal Fabric 从“contract / lifecycle skeleton”
变成真正拥有 production input/history 的 Renderer infrastructure。

==================================================
第一原则
==================================================

先把 Temporal 基础设施做正确，

再接 FSR3。

FSR3 不能替代：

- motion contract；
- surface identity；
- camera revision；
- history lifecycle；
- disocclusion；
- resize/device-loss lifecycle。

==================================================
Step 1 — 修 Temporal transaction
==================================================

检查当前 RendererCore 的：

TemporalFabric.begin
commit
abort

保证与 frame transaction 严格对称。

已知重点检查：

主 render：
begin 之后任何 exception
必须 abort。

empty-scene path：
没有 begin 就不得 abort。

不要让 temporal exception 覆盖原始 render exception。

如果合适，可以用 scoped boolean / transaction guard 收口。

==================================================
Step 2 — 删除假的 revision
==================================================

不允许继续使用 placeholder：

cameraRevision = 1
sceneRevision = 1
representationRevision = 1
lightRevision = "environment:1"

改成真实数据。

至少接：

- Camera revision；
- Scene/GpuRenderWorld publication revision；
- PhysicalEnvironment generation；
- Representation/resolution revision；
- Device epoch；
- Material/geometry revision（只在 contract 需要时）。

==================================================
Step 3 — 真正启用 jitter
==================================================

TemporalFabric.begin() 返回 jitter 后：

真正把 jitter 写入 View / Projection。

不再固定：

setJitter(0, 0)

确保：

current jitter
previous jitter

在 reprojection contract 中一致。

==================================================
Step 4 — Temporal Depth
==================================================

优先检查当前 Visibility Depth 是否满足：

- space；
- resolution；
- precision；
- filtering；
- lifetime；

如果语义兼容：

直接作为 Temporal Depth Product。

不要为了“Temporal 需要 depth”无意义复制一张 depth。

==================================================
Step 5 — Motion
==================================================

当前 Surface shader 已能计算 motion/velocity。

现在只有真正 temporal consumer 出现时才 materialize Motion Product。

建立：

Surface Motion
→ Temporal Motion input

确保：

- current / previous transform；
- jitter convention；
- screen-space convention；

一致。

==================================================
Step 6 — History Resources
==================================================

建立真实 GPU history：

至少：

- color；
- depth；
- motion/必要 auxiliary state。

不要只有 CPU HistoryRegistry entry。

只有本帧真正写出的 Product：

才能 markProduced。

==================================================
Step 7 — History Validity
==================================================

必须覆盖：

- first frame；
- camera cut；
- resize；
- render-scale change；
- scene replace；
- device loss；
- environment generation incompatibility；
- representation change；
- disocclusion；
- invalid motion。

==================================================
Step 8 — Stable Identity
==================================================

不要拿 frame-local VisibilityKey 直接作为跨帧 identity。

Temporal identity 必须依赖更稳定的数据：

- scene instance identity；
- generation；
- geometry/material revision；
- surface semantic identity。

==================================================
Step 9 — PreExposure
==================================================

把 PreExposureContract 从旧 FrameProducts / legacy effect schema 中抽离。

放到中性的：

radiometry / temporal contract

让：

Surface Radiance
Physical Environment
Temporal Backend

共享。

不要让 TemporalFabric 继续依赖旧 Effect FrameProducts。

==================================================
Step 10 — 建一个 Analytic Temporal Baseline
==================================================

为了证明 Fabric 是真的：

允许实现一个明确命名：

EEngine Analytic Temporal Baseline

它可以用于验证：

- reprojection；
- accumulation；
- history rejection；
- disocclusion；
- jitter；
- resize；
- camera cut。

但是：

不得称为 FSR3。

不得用这个 baseline 替换未来 FSR3。

不得复制/混搭一部分 FSR3 stage 然后叫自研 Temporal。

它只是 infrastructure oracle / baseline backend。

==================================================
完成条件
==================================================

[ ] begin/commit/abort 完全对称
[ ] real revisions
[ ] real jitter
[ ] real depth input
[ ] real motion Product
[ ] real GPU history
[ ] history validity/rejection
[ ] camera cut
[ ] resize/render-scale
[ ] device-loss lifecycle
[ ] analytic temporal baseline 能 production render
[ ] 没有声称 FSR3 已完成

完成后：

更新 current facts
更新 temporal contracts
更新 workstream

自动推进：

fsr3-source-and-port

不要等待用户确认。
```

# Prompt 3 — Phase 3C-1：先 Vendor FSR3，不许直接乱写

```
继续 Phase 3C：

fsr3-source-and-port

现在先不要写 production FSR3 WGSL。

第一任务：

固定完整 upstream source。

==================================================
目标
==================================================

为：

FidelityFX SDK v1.1.4
FSR3 Upscaler

建立与 tools/atmosphere-port 类似的：

tools/fsr3-port/

==================================================
必须固定
==================================================

- exact repository
- exact commit
- exact FSR3 Upscaler source subset
- LICENSE / notice
- host dispatch source
- GPU shader source
- callback/resource declarations
- SHA256 / immutable digest

当前已知 pinned commit：

以 docs/source ledger 中当前固定值为准。

不要自行升级到另一个 SDK revision。

==================================================
要读取完整算法链
==================================================

至少完整理解和映射：

Prepare Inputs
Prepare Reactivity
Luma Pyramid
Shading Change
Shading Change Pyramid
Reproject
Accumulate
Upsample
Luma Instability
RCAS

以及它们依赖的：

common
callbacks
resource declarations
host dispatch order
constant buffer layout

==================================================
禁止
==================================================

禁止：

“我知道 FSR 大概怎么做”
→ 自己重新写一个近似版。

禁止：

只读几个 shader
→ 猜 host resource lifecycle。

禁止：

FSR2 + FSR3 混搭。

禁止：

Frame Generation。

当前只移植：

FSR3 Upscaler。

==================================================
如果当前运行环境无法访问 upstream
==================================================

不要因此停止整个 EEngine 工作。

明确记录：

FSR3 upstream source acquisition blocked

然后：

1. 完成所有不依赖 upstream bytes 的本地 mapping scaffold；
2. 保持 workstream gate；
3. 不写假 FSR3；
4. 继续可以独立完成的 Phase 3D contract cleanup。

但如果可以访问 source：

直接 vendor，不需要用户二次确认。

==================================================
完成条件
==================================================

[ ] 完整 source subset 本地固定
[ ] license 固定
[ ] digest 固定
[ ] source→stage mapping 完成
[ ] host dispatch mapping 完成
[ ] resource table 完成
[ ] 尚未声称 port complete

然后直接进入 FSR3 stage port。
```

# Prompt 4 — Phase 3C-2：完整 FSR3 WGSL Port

```
现在 upstream 已经完整固定。

开始忠实移植 FSR3 Upscaler。

不要重新设计 Temporal Algorithm。

不要使用 EEngine Analytic Temporal Baseline 替换 FSR3 stage。

==================================================
整体关系
==================================================

Temporal Fabric
负责：

- current/previous camera
- motion/depth contract
- jitter
- exposure
- history lifecycle
- invalidation
- frame transaction

FSR3 Backend
负责：

- FSR3 private resources
- locks
- FSR3 reprojection
- accumulate
- shading change
- luma instability
- upsample
- RCAS
- 其他 upstream-defined internal state

==================================================
逐 stage 移植
==================================================

严格按 pinned upstream host dispatch dependency 顺序推进。

建议按：

1. shared callbacks / constants / resource ABI
2. Prepare Inputs
3. Prepare Reactivity
4. Luma Pyramid
5. Shading Change
6. Shading Change Pyramid
7. Reproject
8. Accumulate
9. Upsample
10. Luma Instability
11. RCAS

不要因为某个 stage 初看“似乎没有必要”就删除。

==================================================
每个 stage 都做
==================================================

Upstream function/shader
↓
Local WGSL file
↓
Binding/resource mapping
↓
Dispatch dimension
↓
Required invariant
↓
Focused oracle / fixture

记录进：

docs/porting

==================================================
WebGPU Adaptation
==================================================

允许：

HLSL
→ WGSL

native backend callback
→ EEngine WebGPU resource/bind group

native render scheduling
→ EEngine FrameGraph

但是：

不得改变算法语义。

==================================================
FrameGraph
==================================================

FSR3 所有 stage 进入当前 FrameGraph。

不允许：

独立 command encoder submit

不允许：

FSR3 自己掌控整个 frame。

==================================================
Feature-off
==================================================

如果 Temporal Reconstruction 不被请求：

FSR3 private resource / pass 不应该出现在 graph。

==================================================
输出
==================================================

建立正式：

TemporalReconstructedColor Product

明确：

input resolution
output resolution
exposure convention
color space
pre-exposure
history generation

==================================================
完成条件
==================================================

[ ] 所选 upstream stage 全部移植
[ ] source→local mapping 完整
[ ] host dispatch order preserved
[ ] resource semantics preserved
[ ] Temporal Fabric integration
[ ] resize/camera-cut/device-loss
[ ] no independent submit
[ ] no FSR2 stage mixing
[ ] no frame generation
[ ] production diagnostic
[ ] FSR3 claim 只有真实证据后才升级

完成后推进 phase3-integration-close。
```

# Prompt 5 — Phase 3D：收口 Phase 3，然后自动进 Phase 4

```
继续 Phase 3D：

phase3-integration-close

不要再增加 Phase 3 新功能。

现在只做收口。

==================================================
检查 1 — Physical Environment
==================================================

必须：

Physical Sun production
Sky production
Sky irradiance production
Aerial Perspective production
shared immutable environment generation

不允许：

old world DirectionalLight owner
old HDR-environment owner
CSM fallback

==================================================
检查 2 — Temporal
==================================================

必须：

real jitter
real motion
real depth
real history
real revisions
history rejection
camera cut
resize
device loss

==================================================
检查 3 — FSR3
==================================================

必须：

pinned upstream
faithful selected profile port
source mapping
production backend
FrameGraph integration

==================================================
检查 4 — Product semantics
==================================================

至少把 Phase 3 实际出现的 Product 明确：

PhysicalSun
SkyRadiance
SkyIrradiance
AerialScattering / AtmosphericTransport
Motion
TemporalDepth
PreExposure
TemporalReconstructedColor

不要为了“未来完整”提前定义几十个未生产 Product。

==================================================
检查 5 — Minimal Virtual Resource Contract
==================================================

这里只定义 Phase 4 真正需要的最小公共语义：

Logical Identity
Generation
Budget
Residency / validity state
Safe retirement
Telemetry seam

不要实现：

UniversalVirtualResourceManager

不要实现：

Full VT

不要实现：

VSM Physical Cache

那些属于后续真实 consumer 驱动的实现。

==================================================
检查 6 — 删除过时文档
==================================================

同步：

docs/domains current facts
claims
workstream
porting status
source status

删除已经过时的 Phase 3 placeholder 说明。

不要删除 historical evidence。

==================================================
检查 7 — Phase 3 Completion
==================================================

只有真实做到才把 Phase 3 标记完成。

然后：

自动推进 currentSlice 到 Phase 4 第一项。

建议 Phase 4 第一项：

Directional VSM production port

不要停下来要求用户重新确认总体架构。

ADR-0020 已经批准 Phase 4。
```

# 最后一段：给 Codex 的“防卡死总规则”

如果它后面又开始不动，把这一段单独发给它：

```
从现在开始，执行 EEngine Next 时遵守以下防卡死规则：

1. ADR-0020 是已批准架构，不要每个 slice 重新论证它。

2. Phase exit criteria 是 phase 最终门禁，不是每个 commit 的前置条件。

3. 当前 vertical slice 的输入已经具备时，必须继续实现，不得因未来 slice 尚未完成而停止。

4. 如果文档 wording 与已经批准的执行顺序冲突：
   - 若不是架构冲突，直接修订文档并继续；
   - 不要因为过时文档等待人工确认。

5. 如果 upstream algorithm 已 pin 且源码可访问：
   直接读取并忠实 port，不要反复问是否继续。

6. 如果 upstream source 暂时拿不到：
   不得伪造算法；
   记录该 dependency gate；
   然后继续其他不依赖该 source 的工作，不得让整个 phase 停摆。

7. 不要为了“先保持功能”恢复已经删除的 Legacy owner。

8. replacement 尚未完成，不妨碍 Clean-Cut 删除 Legacy owner。
   但不得因此宣称 replacement complete。

9. 不要把 RendererCore 再长成 MainRenderPipeline 2.0。
   新算法放自己的 module/runtime/provider，RendererCore 只负责协调、planning、lowering、submit。

10. 不要把所有 GPU work 强制 queue 化。
    保持：
    Dense
    Sparse
    Coarse
    Reuse
    四种 execution domain。

11. 不要为了架构完整提前造万能抽象。
    Real consumer first。
    第二个或第三个真实 consumer 出现后再抽共享 runtime。

12. 每完成一个 vertical slice：
    - 更新 current facts；
    - 更新 workstream；
    - 更新 porting/source status；
    - 更新必要 guard；
    然后自动推进下一个 slice。

13. 除非发现会改变 ADR-0020 的真正架构问题，否则不要停止等待用户确认。

14. 当前目标不是写分析报告。
    当前目标是：
    阅读真实代码
    → 修改
    → 编译/验证
    → 更新文档
    → 进入下一刀。
```
