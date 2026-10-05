---
id: next-design/vsm
state: current
verifies:
  - OEngine/src
---
# Module E：Virtual Shadow Maps 与 Shadow Visibility

> 状态：E0-E7 已接入候选生产主链；E8 生命周期与 E9 模块收口仍待完成。来源 adoption 仍保持 `not adopted`，因为正式 oracle/GPU evidence 后置。
> 执行顺序见 [vsm execution](../next-execution/vsm.md)。整体边界见 [Next overall architecture](./eengine-extreme-performance-rebuild-2026-10.md) §3、§7。

## 来源速览

- **主要完整 donor**：[Timberdoodle](https://github.com/Ipotrick/Timberdoodle/tree/1987cf3b8ddda42585d2470bb5806efbc96c6cae)，负责页需求、页表、分配、失效、dirty page、caster page 和采样闭环。
- **WebGPU 工程参考**：[Render-Tech-Lab](https://github.com/pasquelin/Render-Tech-Lab/tree/f7557b7d4af6846a5378525820211a213eb64a74)，负责 GPU-driven、Hi-Z、compaction 和 bounded indirect 的工程对照。
- **阴影/后处理参考**：[WickedEngine](https://github.com/turanszkij/WickedEngine/tree/4323a33c94d021d45404adaf863e9b01673ab365) 与 [Falcor](https://github.com/NVIDIAGameWorks/Falcor/tree/759aad033ff610fb0d82c74f7e0a508d0096d5f2)，不是完整 VSM donor。
- **概念交叉检查**：[Unity VirtualShadowMaps](https://github.com/huming971336/VirtualShadowMaps/tree/9dbdbcce022c033405e1ebaf189e25a1e58c99fb)、[VirtualShadowMap_VSM](https://github.com/HTMA2024/VirtualShadowMap_VSM/tree/cb00535dbc1beddb1087954cce22978d70d5ffa7) 和 [VSM thesis](https://github.com/MatejSakmary/VSM_masters_thesis/tree/863693ab6ef6338819d2b370c4a9a705add9ae1e)，只作参考。
- **论文/技术背景**：Giegl/Wimmer 的 Fitted/Queried VSM、Olsson 等人的 Many Lights VSM，以及 Unreal VSM 官方说明。完整 revision、license、入口和采用边界见 §3.1-§3.3 与 [来源账本](../porting/next-renderer.md#r07-supplement-webgpu-comparison-and-backend-boundary-2026-09-27)。

## 1. 决策摘要

E 采用**方向光优先、receiver-driven、GPU-produced residency、固定 FrameGraph topology、有限页批次 raster** 的 VSM profile。第一版只解决太阳/主方向光的高质量虚拟阴影；点光和聚光灯保留为后续 profile，不通过复制一套页表偷偷扩大范围。

主链为：

```text
Visibility hit/depth + receiver footprint
  -> GPU receiver page demand
  -> bounded page-table allocation / eviction
  -> GPU caster-page records
  -> fixed atlas raster batches
  -> page generation / valid mask
  -> direct-light shadow visibility sampling
  -> Surface Standard/Coated direct lighting
```

该主链在同一帧 command context 内完成。GPU 产生的 demand 不回读 CPU，也不触发额外 `queue.submit`。页面超预算时保留粗级页面或显式缺页行为，不能等待 CPU 才决定本帧可见工作。

### 1.1 完成定义

模块 E 只有在下列条件同时成立后才算 production integration 完成：

1. `ShadowVisibility` 语义产品在 Frame Program 中有真实 producer 和 direct-light consumer。
2. 方向光页表、物理 atlas、元数据、代际和失效规则固定，并能在 resize、camera cut、太阳变化和 device replacement 后重建。
3. receiver demand、分配、caster records、atlas 内容生产和采样在 GPU 上闭合，容量和 overflow 有明确行为。
4. 现有 CSM producer/consumer 不再是 Next production path；不得保留 Legacy/Next 阴影 A/B 桥梁。
5. Timberdoodle 的页管理不变量、关键分支、输入输出和缺页语义已逐项映射；WebGPU raster 后端的差异已单独标注为本地实现。
6. WGSL/CPU oracle 与真实 GPU producer→consumer 检查具备后，才允许把来源 ledger 的状态从 `not adopted` 提升。

日常编码不因浏览器矩阵、formal evidence、claims 或 benchmark 停止；模块闭合后集中 typecheck、build 和必要 targeted tests。

## 2. 当前源码事实

以下是 2026-09-27 的源码事实，不是目标实现：

| 事实 | 证据 | 影响 |
| --- | --- | --- |
| direct lighting 已有 shadow sampling 分支 | `OEngine/src/shaders/lighting_direct.ts`：`shadowmap_sample_5`、CSM cascade、point/spot atlas sampling | 新 consumer 必须替换 shadow visibility 语义，不能只新增一张纹理 |
| 旧 producer 是 packed CSM depth-only | 历史提交中的 `packed_csm_shadow.ts`：regular scene 与 Product meshlet 两套 vertex/fragment、alpha mask 和 counter shader | 文件已从 production source 删除；历史 CSM 不是 VSM fallback |
| 旧合同冻结 3 cascade 和 PCF 参数 | `OEngine/src/gpu/ShadowContract.ts` | VSM 不应继续以 `cascadeCount=3` 伪装 page hierarchy |
| `ShadowVisibilityFrame` 已存在旧 atlas 形状 | `OEngine/src/render/pipeline/FrameProducts.ts::shadowVisibilityFrame` | 需要迁移为 virtual page table、atlas generation、缺页语义；旧字段不能继续主导新算法 |
| GPU Scene/meshlet/Product work 已可提供 caster 数据 | `OEngine/src/gpu/GpuScene.ts`、`VsmCasterRecordPass.ts` | VSM caster 后端复用这些 owner 的 geometry records，不新建 CPU caster 列表 |
| Frame Program 已有 owner 注入和 late binding | `OEngine/src/render/program/FrameProgramLowering.ts`、`FrameProgramBindings.ts` | VSM 要作为 owner 注册固定拓扑，动态页数只进入 late-bound resources |
| Temporal Facts/FSR3 已共用单一 submit | `OEngine/src/render/temporal/TemporalFactsPass.ts`、`RendererCore.ts` | VSM 只共享 temporal facts；不建立自己的 history transaction 或 submit |
| 当前 `docs/domains/shading.md` 将 VSM 列为后续 provider | 该文档的 Surface/Lighting 说明 | 设计完成后才能更新为真实 current fact；文档本身不是编码门禁 |

当前主链仍可暂时无影，但不得恢复 CSM 作为 Next production fallback。离线 CSM 对照可以留在研究目录或历史提交。

## 3. 来源、论文与采用边界

### 3.1 主要 donor：Timberdoodle

- 仓库：[Ipotrick/Timberdoodle](https://github.com/Ipotrick/Timberdoodle/tree/1987cf3b8ddda42585d2470bb5806efbc96c6cae)
- revision：`1987cf3b8ddda42585d2470bb5806efbc96c6cae`
- license：Apache-2.0，根 `LICENSE` 已核对。
- 关键入口：
  - `src/rendering/virtual_shadow_maps/mark_required_pages.hlsl`
  - `allocate_pages.hlsl`
  - `invalidate_pages.hlsl`
  - `free_wrapped_pages.hlsl`
  - `force_always_resident_pages.hlsl`
  - `find_free_pages.glsl`
  - `clear_pages.hlsl`
  - `clear_dirty_bit.glsl`
  - `gen_dirty_bit_hiz.hlsl`
  - `vsm_state.hpp`、`vsm.inl`
  - `src/shader_lib/vsm_sampling.hlsl`
  - `cull_and_draw_directional_pages.hlsl`

可移植的是页语义闭环：receiver demand、page table/meta table、free/not-visited allocation、wrapped clipmap invalidation、dirty bit、page render 和 sample fallback。不能直接移植的是 amplification/task/mesh shader、`DispatchMesh`、Daxa pointer-style resource access，以及基于其 API 的 dynamic draw 调度。设计因此保留算法不变量，重写 WebGPU 执行后端。

### 3.2 对照来源

| 来源 | revision/license | 结论 |
| --- | --- | --- |
| [Unreal Virtual Shadow Maps documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/virtual-shadow-maps-in-unreal-engine) | 官方技术文档；不是可复制代码 donor | 用于验证 page space、clipmap、cache、coarse page 和 missing-page 的产品语义；不把 Epic 私有实现登记为开源移植 |
| [MatejSakmary/VSM_masters_thesis](https://github.com/MatejSakmary/VSM_masters_thesis/tree/863693ab6ef6338819d2b370c4a9a705add9ae1e) `863693ab6ef6338819d2b370c4a9a705add9ae1e` | 研究仓库，含 `VSM_Thesis.pdf`；license/可再分发条件待核清 | 作为论文与误差/overdraw 分析参考；不能替代 shader producer |
| [pasquelin/Render-Tech-Lab](https://github.com/pasquelin/Render-Tech-Lab/tree/f7557b7d4af6846a5378525820211a213eb64a74) `f7557b7d4af6846a5378525820211a213eb64a74`, MIT | 有 GPU-driven、Hi-Z、virtualized integration，但没有完整 VSM page producer | 用于 WebGPU bounded indirect、GPU compaction、固定工作队列的工程参考；不是 VSM donor |
| [huming971336/VirtualShadowMaps](https://github.com/huming971336/VirtualShadowMaps/tree/9dbdbcce022c033405e1ebaf189e25a1e58c99fb) `9dbdbcce022c033405e1ebaf189e25a1e58c99fb` | Unity Built-in pipeline；仓库未发现独立宽松 license 文件，需法律核对 | 可交叉检查 indirection texture、tile pool、LRU、PCF/PCSS；不作为生产移植来源 |
| [HTMA2024/VirtualShadowMap_VSM](https://github.com/HTMA2024/VirtualShadowMap_VSM/tree/cb00535dbc1beddb1087954cce22978d70d5ffa7) `cb00535dbc1beddb1087954cce22978d70d5ffa7` | Unity 课程/演示型工程；license 与完整 runtime 范围待核清 | 仅作概念和采样对照，不宣称完整 donor |
| WickedEngine `turanszkij/WickedEngine` revision `4323a33c94d021d45404adaf863e9b01673ab365`, MIT | 核对到 shadow map、RT shadow 与 denoiser；未发现完整 VSM page-management 闭环 | 可参考 indirect/denoise 组织，不能作为 VSM page donor |
| Falcor `NVIDIAGameWorks/Falcor` revision `759aad033ff610fb0d82c74f7e0a508d0096d5f2` | 根 license 不是可直接假设的单一宽松授权 | 可参考 render-pass/resource reflection；未找到可直接移植的完整 VSM producer |

论文与技术背景：

- [Giegl and Wimmer, Fitted Virtual Shadow Maps](https://doi.org/10.1145/1268517.1268545) 用于理解虚拟页拟合和过滤的基本问题。
- [Giegl and Wimmer, Queried Virtual Shadow Maps](https://doi.org/10.1145/1230100.1230112) 用于对照 receiver query 与按需页生成。
- [Olsson et al., More Efficient Virtual Shadow Maps for Many Lights](https://doi.org/10.1109/TVCG.2015.2418772) 用于比较多光源页共享和缓存成本；第一版不因此扩大到 point/spot VSM。
- [Practical Real-Time Strategies for Accurate Indirect Occlusion](https://www.activision.com/cdn/research/Practical_Real_Time_Strategies_for_Accurate_Indirect_Occlusion_NEW%20VERSION_COLOR.pdf) 不属于 VSM，本模块不拿 AO 论文冒充 shadow donor。
- VSM 的正式实现依据以 Timberdoodle 源码和 Unreal 技术说明的页需求/缓存语义为主；论文、学位论文和技术文章只用于解释 clipmap、page cache、receiver-driven update 和 filtering，不替代具体源函数核对。
- 任何新增 donor 必须在 `docs/porting/next-renderer.md` 固定 revision、license、入口和检索缺口后才可进入实现。

### 3.3 源阶段到本地产物映射

| Timberdoodle 阶段/函数 | 保留的输入、输出、不变量 | EEngine 本地产物/阶段 | WebGPU 差异与降级 |
| --- | --- | --- | --- |
| `mark_required_pages` | receiver footprint、clip projection、page LOD、required bit；同一虚拟页只产生一个逻辑需求 | `VsmReceiverDemandPass` 写 bounded `VsmDemandRecord` | 不使用 CPU 读回；overflow 只设置 GPU mask 并提升 coarse fallback |
| `find_free_pages` + `allocate_pages` | free pages 优先，随后回收本帧未访问页；page table 与 reverse meta table 原子一致；失败显式标记 | `VsmAllocatePagesPass`、`VsmPageTable`、`VsmMetaTable` | 固定 storage buffers/textures；容量由 profile 固定，不能动态创建 page pass |
| `invalidate_pages`、`free_wrapped_pages` | clipmap 移动、sun/geometry generation 变化使旧映射失效；旧物理页不能被错误采样 | `VsmInvalidatePass`、generation/dirty masks | clipmap 只在 GPU record 中更新；大范围失效采用 bounded clear queue |
| `gen_dirty_bit_hiz` + `clear_dirty_bit` | caster 变化与 dirty page 关联；渲染成功后清 dirty；未成功仍保持 dirty | `VsmDirtyPagePass` + `VsmCommitPageGenerationPass` | HZB 复用必须证明空间和 reduction 一致；否则使用 page-bounds culling |
| `cull_and_draw_directional_pages` | page-local transform、caster cull、masked alpha branch、只写 dirty allocated page | `VsmCasterRecordPass` + `VsmAtlasRasterPass` | 去除 mesh/amplification shader，改固定 indirect raster batches；alpha-tested 保持独立分支 |
| `vsm_sampling` | virtual UV→page table→physical atlas，缺页/未生成页行为与 demand 一致，PCF/PCSS taps 不越界 | `vsm_sampling.wgsl` 进入 `lighting_direct` | baseline 采用 bounded PCF；PCSS 只有在页过滤和成本 profile 单独闭合后开启 |

状态：上述映射是设计目标，尚未有本地产物或 GPU 证据，不能写成 adopted。

## 4. Shadow Visibility 语义产品

### 4.1 产品字段

`ShadowVisibilityFrame` 替换旧 cascade atlas 语义，至少包含：

| 字段 | 语义 |
| --- | --- |
| `virtualPageTable` | 每个 virtual page 的 physical slot、valid、dirty/in-flight、fallback mip、generation |
| `physicalAtlasDepth` | 物理深度 atlas；每个 slot 包含 border/gutter，采样坐标不可越界 |
| `pageMeta` | physical slot → virtual page、last-used/visited、generation、dirty state 的反向记录 |
| `lightProjection` | 方向光 clipmap levels 的 world→virtual shadow coordinates |
| `pageSize` / `border` / `atlasPagesPerAxis` | 固定 profile 参数，不进入每帧 topology key |
| `validGeneration` | 当前 atlas 内容与页表映射一致的代际；不匹配时使用缺页规则 |
| `overflowMask` / `allocationFailedCount` | GPU work telemetry；不可被本帧 CPU 读回控制可见工作 |
| `fallbackPolicy` | coarse resident、neutral visibility 或 shadow-disabled 的明确选择 |

所有坐标、深度比较和 bias 以同一方向光空间定义。direct lighting 只读取 `visibility`，不读取页表管理器的内部 free list。

### 4.2 可见性值和缺页策略

- 完整有效页：返回过滤后的 `[0,1]` visibility；`0` 为完全遮挡，`1` 为完全可见。
- 有映射但 generation 不匹配：采样该页的 fallback mip；不可把旧 generation 当新页使用。
- 未分配/分配失败：优先向更粗 mip 查找有效页；若没有，则返回 `1` 并设置缺页统计。第一版不返回黑色阴影，避免 page budget 紧张时产生大片错误全黑。
- receiver demand 与 sampling 使用相同的 virtual coordinate、mip 和 border 规则；不能采样一次再用另一套坐标请求页面。
- `ReceivesShadow` 未设置、unlit、emissive 或没有有效主光源时不读取 VSM。

### 4.3 与 Surface/Lighting 的能量合同

VSM 只作用于 direct-light incident radiance：

```text
L_direct = visibility_vsm * (sun_or_local_light * BRDF)
L_indirect = sky/GI/SSSR providers by their own visibility contracts
L_emissive = emissive
```

不把 VSM visibility 乘到 XeGTAO、sky irradiance、emissive 或整张 HDR。Coated 的 base/coat direct lobe 都使用同一主光 visibility，但 coat attenuation 仍由 Material Closure 自己负责。SSSR/GI 接入后，必须明确其是否消费已遮蔽 radiance，禁止重复乘 shadow。

## 5. 坐标空间与页层级

第一版方向光使用稳定的 clipmap levels：

1. level 0 覆盖相机附近最高密度区域。
2. 每升一级，world coverage 加倍，virtual texel footprint 变粗。
3. clipmap 原点按固定 page 尺寸量化，避免相机亚页移动导致整张缓存抖动。
4. level 边界使用 overlap/border，采样可以向相邻粗 mip 回退。
5. sun direction、world origin rebasing、camera cut 或 scene generation 变化会提升 invalidate generation。

页坐标转换必须在 receiver demand、caster raster 和 sample 三处共享同一 WGSL helper/常量。不得在 TS 中生成每页矩阵并为每页创建 render pass。

推荐初始 profile（实际值在实现前由 adapter limits 协商）：

| 参数 | 目标 profile | 约束 |
| --- | --- | --- |
| clip levels | 6 | 至少保留 level 5 coarse coverage；少于 4 时降级为 shadow-disabled profile |
| virtual resolution/level | 16k logical | 逻辑页表可用 `r32uint` 或 storage buffer；不要求物理 16k 纹理 |
| page interior | 128 texels | 另加 2--4 texels border，具体由 filter kernel 固定 |
| physical atlas | 4096² 或 8192² depth | 由 GPU budget/profile 选择，不能越过 max texture dimension |
| resident slots | 1024--4096 pages | 固定上限，allocation overflow 明确记录 |
| filter | 2x2/4-tap PCF baseline | 5x5/PCSS 为后续 profile，不在 baseline 偷换实现 |

预算示例：4096² `depth32float` atlas 约 64 MiB，8192² 约 256 MiB；页表、meta、records 和 dirty masks 另计。实现前必须使用 adapter limits 和实际 format 支持重算，而不是把示例当硬编码。

## 6. GPU 数据流与固定拓扑

### 6.1 FrameGraph producer/consumer

```text
Visibility/depth/TemporalFacts
  -> VsmReceiverDemandPass
  -> VsmInvalidatePass
  -> VsmAllocatePagesPass
  -> VsmCasterRecordPass
  -> VsmAtlasClearPass
  -> VsmAtlasRasterPass (fixed batch count)
  -> VsmCommitPageGenerationPass
  -> SurfaceWork V3 direct-light signal packet consumer
  -> Sky/Aerial, FSR3, Present
```

`VsmReceiverDemandPass` 读取 receiver hit/world position/depth、main-light projection 和 pixel footprint，写：

```text
VsmDemandHeader { attempted, written, overflow, generation }
VsmDemandRecord { virtualPage, mip, priority, receiverBounds, flags }
```

`VsmAllocatePagesPass` 通过 bounded atomic reservation 写 `pageTable`、`metaTable` 和 `VsmPageWorkRecord`。同一逻辑页必须幂等；排序可按 mip/priority 的固定 GPU radix/atomic policy，但不得依赖 CPU。

`VsmCasterRecordPass` 读取 GPU Scene hierarchy、meshlet/product records、instance transforms 和 allocated dirty pages，写：

```text
VsmCasterRecord { pageSlot, casterId, geometryId, materialId, transformIndex, flags }
VsmRasterIndirect { indexCount, instanceCount, firstIndex, baseVertex, firstInstance }
```

每个 record 明确指向 page slot 和 light-space transform。记录数量有固定 cap；overflow 时优先保留 coarse/near pages，并把未覆盖页保持 dirty，下帧继续请求。

### 6.2 Raster 后端选择

比较结果：

| 后端 | 优点 | WebGPU 风险 | 决策 |
| --- | --- | --- | --- |
| Timberdoodle mesh/amplification | caster cull 和 page-local transform 最完整 | baseline WebGPU 无 mesh shader/DispatchMesh；Daxa pointer API 不可用 | 不采用为 baseline，保留算法映射 |
| 每页独立 render pass | 语义直观 | 动态 render pass/viewport/scissor、CPU 调度和 submit 爆炸 | 禁止 |
| atlas-space vertex transform + fixed batches | 符合单 topology、复用 GPU Scene、可用 indirect | 需要定义 page record 到 draw instance 的硬件路径；draw 数和 page/caster cap 需固定 | **主方案** |
| software shadow raster | 不依赖 render pass 数，理论上完全 GPU | 大量 atomic、深度/三角形边界实现复杂，质量与性能风险高 | 仅作 capability/profile 兜底，不作为首个 production path |

主方案的关键约束：WebGPU baseline 没有可假设的 multi-draw indirect。实现可以选择固定数量的 indirect batch draw（每个 batch 的容量和 topology 固定），或者使用一个固定 draw 的 expanded record/instance 组织；具体选择必须由 GPU Scene 的现有 index/meshlet ABI 和设备 limits 决定。不得在设计文档中把“动态任意页数 draw”当成现成 API。

### 6.3 资源与绑定

VSM owner 负责 device-local 的：

- `pageTable`（storage texture 或 storage buffer profile）
- `metaTable`（反向 slot ownership）
- `physicalAtlasDepth`
- `demandBuffer`、`allocationBuffer`、`casterRecordBuffer`
- `dirtyMask`、`generationBuffer`、`overflowCounters`
- 固定 page constants、light projection constants

FrameGraph 负责 transient demand/caster scratch 的生命周期；VSM owner 负责 persistent atlas/page table 的 epoch 重建。Surface 只获得只读 `ShadowVisibilityFrame` view，不拥有 free list 或 atlas eviction。

## 7. 分配、失效与缓存

### 7.1 分配不变量

1. `pageTable[v] = slot` 当且仅当 `metaTable[slot] = v` 且 generation 匹配。
2. 一个 slot 同一时刻只能被一个 virtual page 拥有。
3. 已访问页不能在当前 frame 被 eviction。
4. dirty/in-flight 页不能在 raster commit 前被复用。
5. allocation failure 必须是可观测 GPU 状态，不得静默映射到 slot 0。
6. eviction 先选择 coarse/远端/未访问页；near receiver page 的优先级高于 predictive page。

### 7.2 失效触发

| 触发 | 失效范围 |
| --- | --- |
| camera move 小于 page quantum | 仅新增/离开 clipmap 页；复用未失效 slot |
| camera move 跨 page quantum | wrapped 区域页失效，保留未覆盖区域 |
| main-light direction/intensity 大变 | 方向光全部 page generation 递增并重新 dirty；可保留映射但不得采旧深度 |
| caster transform/geometry/material alpha generation 改变 | 受影响页 dirty；若无法得到影响范围则 bounded full invalidate |
| resize/output resolution | 物理 receiver footprint 变化；atlas 可复用，demand 重新生成 |
| camera cut/scene replacement | 全部 page invalid，先填 coarse fallback，再按 budget 生产 near pages |
| device loss/epoch change | 销毁并重建 atlas/page table/pipelines，不复用旧 GPU handle |

### 7.3 回收与代际

页表 generation、atlas content generation、scene/geometry publication generation 分开记录。只有 `pageTable generation == atlas content generation == light/scene generation` 的页可返回高质量 visibility。旧页在回收前可以作为 debug telemetry，但不能被采样。

## 8. 采样与过滤

采样步骤固定为：

1. 将 receiver world position 投影到方向光 clipmap virtual UV 和 mip。
2. 以 receiver footprint 估计所需 mip，向 coarse level 限制。
3. 查 page table；若缺页，沿 fallback mip 搜索最近有效页。
4. 将 virtual UV 映射到 physical slot interior，保留 border。
5. 执行固定 PCF taps；每个 tap 必须重复有效页检查或使用同一页级别的安全坐标。
6. 进行 depth bias/normal offset，输出 visibility 与 telemetry flags。

深度比较使用 reverse/forward 约定中的显式 shadow-space depth，不借用 camera HZB 的 reduction 方向。PCF 先用固定 2x2 或 4 tap；PCSS 需要额外 blocker search、跨页过滤和预算，必须作为独立 profile 完整实现后再开启。

masked caster 保留 alpha-test 分支：材质 alpha generation 变化会使对应页 dirty。透明/半透明接收和投射不在本模块偷偷近似为 opaque；由后续 Transparency/Media 模块定义。

## 9. 能力协商与降级

创建 VSM owner 前检查：

- `maxTextureDimension2D` 是否容纳 atlas；
- depth format 的 render attachment + sampled/storage 使用组合；
- `maxStorageBufferBindingSize` 是否容纳 page/caster records；
- bind group storage texture/buffer 数量；
- indirect draw/dispatch 的可用限制；
- shader atomic、texture array 和 depth compare 的实际支持；
- 设备是否能在单一 frame command context 内容纳固定 pass 数和预算。

能力 profile：

| profile | 条件 | 行为 |
| --- | --- | --- |
| `vsm-directional-high` | atlas、page table、indirect raster 和固定预算均满足 | 6 clip levels，近页高分辨率，4-tap PCF |
| `vsm-directional-bounded` | page system 可用但 atlas/records 较小 | 减少 levels/slots，强制 coarse fallback；仍保持 VSM 语义 |
| `shadow-disabled` | 无法创建合法 VSM 资源或固定 raster 后端不可用 | direct visibility=1；不恢复 CSM，不创建伪 VSM 纹理 |

能力失败发生在资源和 pipeline 创建前；运行中 overflow 只改变 GPU fallback/telemetry，不触发 CPU 读回或重新编译 topology。

## 10. 生命周期和时序

- camera move：只更新 demand 和 wrapped pages；不重编译 Frame Program。
- temporal facts：VSM 可读取 current/previous transform revision，用于判断 caster local change；VSM 不拥有 FSR3 history。
- resize：重新计算 receiver footprint 和 transient buffer extents；若 atlas profile 不变可保留 persistent pages，否则一次性 invalidate。
- camera cut：将 page generation 递增，coarse pages 优先恢复，near pages 按 budget 填充。
- sun change：根据角度变化阈值选择局部/全量 dirty；第一版允许保守全量 dirty，不能采旧深度。
- scene patch：GPU Scene 发布 generation，caster records 只接受同代数据。
- device loss：新 device epoch 重建所有 pipelines、atlas、page tables、bind groups；CPU scene truth 重新发布。

## 11. 性能模型与风险

主要成本：

```text
receiver demand + allocation + caster cull + atlas raster + shadow taps
```

预算必须按 `pagesRequested`, `pagesAllocated`, `pagesDirty`, `casterRecords`, `atlasPixelsWritten`, `samplingTaps`, `overflowMask` 分项统计。P50/P95 留到整个 Next Renderer 完成后做；模块内只修明显的容量、同步和 GPU 错误。

高风险点：

1. 没有 mesh shader 时，caster record 到固定 indirect draw 的扩展可能成为主要瓶颈。
2. WebGPU depth atlas 的 render/sample 用法和 storage texture 限制会影响物理布局。
3. receiver demand 过量时，coarse fallback 的视觉边界可能抖动；需要 page hysteresis 和优先级，而不是 CPU 追帧。
4. alpha-tested caster 会增加 material texture 访问和 dirty 范围。
5. software raster 作为兜底可能在高三角形量下不如无影；必须显式 profile，而不是默认打开。

## 12. 明确不采用的方案

- 恢复 `packed_csm_shadow.ts` 或旧 `ShadowContract.ts` 作为 Next fallback。
- CPU 读取 demand 数量后逐页创建 render pass、viewport 或 draw。
- 为每个 page 添加独立 `queue.submit`。
- 以固定黑色/白色纹理冒充 VSM 已完成。
- 只写 page table 而没有 atlas 内容生产和采样一致性。
- 把 Timberdoodle mesh shader 源码直接翻译成 WGSL 并声称完整 port。
- 把 Unity 演示仓库的 LRU/PCSS 片段拼接成“完整 VSM donor”。
- 把 point/spot VSM 与 directional VSM 同时塞入第一版，扩大预算和验证面。

## 13. 采用状态与后续证据

当前实现状态为 `E0-E7 integrated / deferred acceptance`；来源状态仍为 `not adopted`。要提升为 `traceable local port`，必须完成：

1. source ledger 的逐项映射、revision/license 和缺口记录；
2. CPU page-table/allocation oracle；
3. WGSL demand/allocation/sampling 数值检查；
4. 固定 raster batch 的真实 GPU producer→consumer 检查；
5. direct-light consumer 与 Surface Standard/Coated 的同帧连接（E7 已接入，待真实 GPU 核对）；
6. 模块完成后的 typecheck、build、必要 targeted tests。

browser matrix、resize/camera cut/device loss 组合、不同场景材质、画质对照、GPU P50/P95、formal evidence 和 claims 仍属于整个 Next Renderer 完成后的最终验收。
### E8 implementation note

The lifecycle owner is local integration rather than a new upstream algorithm. `VsmGeneration` keeps device-epoch and publication facts on the CPU, while `VsmInvalidationPass` publishes only bounded generation/telemetry control in the existing FrameGraph. The implementation preserves page demand and allocation on the GPU; it does not add a readback or a second submit. The current ABI uses the bounded full-generation fallback for page-quantum shifts because toroidal remap metadata is not yet part of the page table. Full acceptance remains deferred to E9 and the renderer-wide final validation phase.
