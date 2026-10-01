# Module E 执行：VSM / Shadow Visibility

> 本文是模块 E 的连续实施顺序。设计语义见 [VSM design](../next-design/vsm.md)。
> E0-E9 已接入单一生产主链；E9 的 typecheck/build、focused CPU/WGSL/epoch 检查于 2026-09-28 完成。R07 adoption、完整场景覆盖和正式浏览器/画质/性能矩阵仍后置。

## 来源入口

执行依据不是临时拼接的算法：完整页管理 donor 是 [Timberdoodle](https://github.com/Ipotrick/Timberdoodle/tree/1987cf3b8ddda42585d2470bb5806efbc96c6cae)；WebGPU GPU-driven 参考是 [Render-Tech-Lab](https://github.com/pasquelin/Render-Tech-Lab/tree/f7557b7d4af6846a5378525820211a213eb64a74)；WickedEngine、Falcor 和 Unity 示例只用于局部交叉检查，不能宣称完整移植。具体 source file、revision、license、阶段映射集中在 [vsm design §3](../next-design/vsm.md#3-来源论文与采用边界) 和 [来源账本 R07](../porting/next-renderer.md#r07-supplement-webgpu-comparison-and-backend-boundary-2026-09-27)。

## 0. 执行规则

### 0.1 硬红线

- 只有一条 Next production renderer path；不得恢复 CSM、旧 SSR/GTAO/SSGI 或 Legacy/Next 双路。
- 不得加入本帧 GPU→CPU→GPU 的 visible/work control。
- 不得为 page、caster 或 light 增加独立 frame submit。
- Timberdoodle 的复杂算法必须保留页需求、分配、失效、渲染、采样的完整语义；WebGPU 后端差异必须具名记录，不能用近似效果冒充移植。
- 真实编译失败必须修复。

### 0.2 开发节奏

E0-E8 期间允许连续编码。typecheck、build、CPU oracle 或一个 targeted test 只是调试工具；不要求每个阶段都跑完整验证。E9 模块闭合后集中做一次 typecheck、build 和必要 targeted tests，修明显问题后更新 currentSlice。

不因 browser 未运行、evidence/claim 未完成、旧文档暂时不同步或未来 SSSR/GI 未完成而停止。正式 browser matrix、质量对照、P50/P95 和 claims 延后到整个 Next Renderer 完成。

### 0.3 目录与 owner

预计 owner：

| owner | 责任 |
| --- | --- |
| `frame-runtime` | Frame Program fact、固定 Graph topology、单一 submit、late binding |
| `shading` | `ShadowVisibilityFrame` 语义、VSM sampling、direct-light consumer |
| `visibility` / `geometry` | receiver hit/depth、GPU Scene caster records、meshlet/product geometry |
| `virtual-assets` | page residency control、generation、budget、eviction telemetry |
| `platform` | adapter limits、format/capability negotiation、device epoch |
| `RendererCore` | 只装配 owner，不拥有 VSM 算法和 free list |

实现前先运行：

```text
node tools/vibe.mjs context docs/next-design/vsm.md
node tools/vibe.mjs context docs/next-execution/vsm.md
node tools/vibe.mjs context OEngine/src/render/program/FrameProgramLowering.ts
```

## 1. E0：来源审计与冻结 profile

### 目标

完成 Timberdoodle 全部 VSM 入口、许可证和关键分支审计，固定方向光第一版 profile，并在来源账本中记录 WebGPU 后端缺口。

### 输入与文件

- `docs/porting/next-renderer.md` 的 R07。
- `temp/vsm-research/timberdoodle/src/rendering/virtual_shadow_maps/`。
- `docs/next-design/vsm.md` §3、§5。

### 必须产物

1. source stage → local stage 表逐项核对。
2. page table/meta table、free/not-visited allocation、wrapped invalidation、dirty page、sampling fallback 的输入/输出/不变量记录。
3. 固定 `vsm-directional-high` 和 `vsm-directional-bounded` profile 参数及其 limit 条件。
4. 研究仓库的完整性和 license 缺口写明；Unity/演示仓库不登记为完整 donor。

### 删除/切断边界

本阶段不改生产代码，不保留“CSM 临时兼容”设计。若旧文档把 CSM 写成 Next fallback，改成“离线对照/待删除”。

### 通过条件

来源和 profile 能被实现者逐项追溯；没有“VSM 已移植”的措辞。可选运行 `git diff --check`，不跑浏览器。

## 2. E1：Shadow semantic product 与 direct consumer

### 目标

先把 shadow visibility 作为真实语义产品接入 Surface/Lighting，建立生产边界，再接页管理。此阶段不创建伪 atlas。

### 主要文件/owner

- `OEngine/src/render/pipeline/FrameProducts.ts`
- `OEngine/src/render/program/FrameProgram.ts`
- `OEngine/src/render/program/FrameProgramBindings.ts`
- `OEngine/src/render/program/FrameProgramLowering.ts`
- `OEngine/src/shaders/lighting_direct.ts`
- `OEngine/src/shaders/surface_material_kernel.ts`
- `OEngine/src/render/pipeline/RendererCore.ts`

### 产物

`ShadowVisibilityFrame` 至少公开：virtual page table view、physical atlas view、light projection、page constants、valid generation、fallback policy、overflow telemetry。Surface 只读取 `shadowVisibility` 和有效性，不读 allocator 内部状态。

Frame Program request 只描述：main light demand、shadow profile、receiver footprint、scene/light generations 和 capability profile。camera move、page demand、atlas generation 不进入 topology key。

### 暂时行为

在 producer 尚未连接时，合法 profile 可以返回 `shadow-disabled` 的 visibility=1，并明确标记为未完成。不能绑定 CSM atlas 来伪装 VSM。

### 重点检查

- direct diffuse/base coat/coat lobe 都只乘 shadow visibility；sky/IBL、emissive、unlit 不被整张 HDR 再乘一次。
- empty/unlit/no-main-light program 裁剪 VSM stage。
- 不新增第二个 submit 或 CPU readback。

## 3. E2：Persistent resources 与 capability preflight

### 目标

在设备创建资源前完成格式、尺寸、绑定、原子和 indirect 能力协商，建立 VSM owner 的 device epoch 生命周期。

### 主要文件/owner

- `OEngine/src/platform/**` 或现有 adapter capability owner
- 新建 `OEngine/src/render/vsm/VsmCapabilities.ts`
- 新建 `OEngine/src/render/vsm/VsmResources.ts`
- `OEngine/src/render/program/FrameProgramBindings.ts`

### 资源

- persistent depth atlas
- page table / meta table
- generation and dirty masks
- bounded demand/allocation/caster buffers
- fixed page constants and light projection buffer

### 产物

`VsmCapabilityProfile` 明确 `vsm-directional-high`、`vsm-directional-bounded`、`shadow-disabled`。所有失败在创建 pipeline/资源前解决；不存在运行中换 layout 的隐式 fallback。

### 生命周期

resize 在 profile 不变时可复用 atlas，只重建 transient buffers；device loss 必须按新 epoch 全量重建；旧 handle 不得进入新 bind group。

## 4. E3：Page table、meta table 与 generation

### 目标

先实现稳定的 virtual→physical 和 physical→virtual 语义，独立于 receiver demand 和 raster。

### 主要文件/owner

- 新建 `OEngine/src/render/vsm/VsmPageTable.ts`
- 新建 `OEngine/src/render/vsm/VsmPageState.ts`
- 新建 `OEngine/src/shaders/vsm_page_table.ts`
- `OEngine/src/render/program/FrameProgramLowering.ts`

### 数据合同

```text
VsmPageEntry { slotX, slotY, mip, allocated, dirty, inFlight, generation, fallbackMip }
VsmMetaEntry { virtualPage, mip, lastVisited, dirty, generation, owner }
VsmPageWork { virtualPage, slot, priority, generation, flags }
```

实现 page-table lookup、slot ownership、generation compare、clear/invalidate 和 fixed-capacity work headers。CPU 端只准备 profile 和场景发布事实，不读取本帧 demand 决定 visible work。

### 不变量

page table 与 meta table 双向一致；in-flight/dirty slot 不可回收；generation 不一致不可采样；overflow 有 mask 和保守 fallback。

## 5. E4：Receiver demand

### 目标

从真实 Visibility/depth receiver 生成 GPU demand，保留 Timberdoodle 的 page LOD、footprint、required 和 priority 语义。

### 主要文件/owner

- 新建 `OEngine/src/render/vsm/VsmReceiverDemandPass.ts`
- 新建 `OEngine/src/shaders/vsm_receiver_demand.ts`
- `OEngine/src/render/pipeline/FrameProducts.ts`
- `OEngine/src/render/program/FrameProgramLowering.ts`

### 输入

- current visibility hit / world position
- reverse-Z depth 与 internal extent
- main-light clipmap constants
- material/instance receive-shadow flags
- current scene/light generation

### 输出

```text
VsmDemandHeader { attempted, written, overflow, generation }
VsmDemandRecord { virtualPage, mip, priority, receiverBounds, flags }
```

同一 virtual page 必须幂等或在 allocation 阶段去重。背景、unlit 和 `ReceivesShadow=0` 不产生 demand。demand overflow 不回读 CPU；提升 coarse fallback 并保留 near page 的优先级。

### 调试工具

可写 CPU projection/footprint oracle 与 WGSL 小输入对照；不需要每次 shader 改动都跑完整浏览器。

## 6. E5：GPU allocation、eviction 与 overflow

### 目标

实现 free pages 优先、not-visited 回收、page table/meta table 原子更新、allocation failure 和 bounded overflow。

### 主要文件/owner

- 新建 `OEngine/src/render/vsm/VsmAllocatePagesPass.ts`
- 新建 `OEngine/src/shaders/vsm_allocate_pages.ts`
- 新建 `OEngine/src/render/vsm/VsmResidency.ts`
- `OEngine/src/gpu/GpuQueueTelemetry.ts` 或现有 queue counter owner

### 执行顺序

1. clear/rotate visited and allocation headers。
2. consume demand records，复用已分配页并更新 visited。
3. 从 free list reservation slot；不足时从 not-visited bounded eviction 取 slot。
4. 原子写 page table/meta table 和 `VsmPageWork`。
5. 无 slot 时写 allocation-failed，保持 coarse mapping/dirty 状态。

### 删除边界

删除任何“CPU 轮询 demand 数量再分配”的试验代码。不得新建 per-page CPU render loop。

## 7. E6：Caster records 与固定 atlas raster

### 目标

把 GPU Scene/meshlet/Product caster work 映射到分配的 dirty pages，并用固定 topology 生产 atlas depth。

### 主要文件/owner

- 新建 `OEngine/src/render/vsm/VsmCasterRecordPass.ts`
- 新建 `OEngine/src/render/vsm/VsmAtlasRasterPass.ts`
- 新建 `OEngine/src/shaders/vsm_caster_records.ts`
- 新建 `OEngine/src/shaders/vsm_atlas_raster.ts`
- 复用 `OEngine/src/gpu/GpuScene.ts`、geometry/meshlet work ABI

### 方案要求

- caster cull 在 GPU 上完成；读取 instance transform、geometry bounds、material alpha flags 和 dirty page bounds。
- 输出 bounded `VsmCasterRecord` 与固定 indirect batch 参数。
- atlas-space vertex transform 把 page slot/border 映射到 atlas viewport；不为每页创建 pass。
- opaque 与 alpha-tested caster 分支都保留；alpha discard 的输入/阈值必须和材质发布一致。
- raster 只写 allocated+dirty+generation-matched page；成功后才允许清 dirty。

### WebGPU backend 选择

优先实现固定数量的 indirect batches。若设备不支持所需的多 draw 组织，则使用固定 batch/固定 record 容量的 expanded instance 方案；仍不允许动态 render pass。software raster 只有在明确 capability profile 中启用，不能默认为主路径。

### 失败行为

caster record overflow：near/高优先级页优先，未覆盖页保持 dirty；atlas raster overflow：不提交错误 generation，采样回退 coarse 页。

## 8. E7：Sampling、direct lighting 切断与 CSM 删除

### 目标

把 VSM sampling 接到唯一 Surface direct-light consumer，随后删除 CSM production owner。

### 主要文件/owner

- `OEngine/src/shaders/lighting_direct.ts`
- 新建 `OEngine/src/shaders/vsm_sampling.ts`
- `OEngine/src/render/pipeline/FrameProducts.ts`
- `OEngine/src/gpu/ShadowContract.ts`
- 历史 `packed_csm_shadow.ts`（已从 production source 删除）
- `OEngine/src/render/**` 中仍引用 packed CSM 的调用点

### 采样合同

virtual UV/mip → page table → fallback mip → atlas border → fixed PCF taps → depth compare/bias。缺页和 generation mismatch 不产生错误黑影，使用 coarse page 或 neutral visibility，并设置 telemetry。

### 切断边界

当 E6 有真实 atlas producer、E7 consumer 已读取 `ShadowVisibilityFrame` 后：

1. 删除或移出生产图的 packed CSM pass、cascade constants 和旧 shadow readback。
2. 删除 `RendererCore` 中 CSM 资源/调用分支。
3. 旧 CSM 代码若保留，只能在 `temp/` 或离线 reference 目录，不能被 production import。
4. 不建立一帧同时跑 CSM/VSM 的比较桥梁。

### E7 实际收口

- `vsm_sampling.ts` 已按 clipmap level、page-table generation、dirty/缺页回退、atlas border 和固定 PCF taps 实现采样。
- SurfaceWork V3 的 direct-light signal packet consumer 通过 `ShadowVisibilityFrame` 读取 VSM page table、depth atlas 和 sampling constants；Standard/Coated direct lobe 共用一次 visibility。
- FrameGraph 使用同一 page-table/atlas resource ID 建立 allocation → raster → Surface sampling 依赖；没有 CPU readback、逐页 render pass 或额外 submit。
- 历史 packed CSM shader 已删除，未建立 CSM/VSM 对照桥梁。
- 已通过 `npm run typecheck`、`npm run build`、`npm run build:test` 和 `node --test tests/contract/frame-program.test.mjs`；真实浏览器 WGSL 编译、画质与性能检查延期到 E9/最终验收。

## 9. E8：失效、Temporal facts、恢复与诊断

### 目标

把页 generation 与相机、太阳、caster publication 和 device epoch 连起来，补齐恢复行为。

### 主要文件/owner

- 新建 `OEngine/src/render/vsm/VsmInvalidationPass.ts`
- 新建 `OEngine/src/render/vsm/VsmGeneration.ts`
- `OEngine/src/render/temporal/TemporalFactsPass.ts`
- `OEngine/src/render/program/FrameProgramBindings.ts`
- `OEngine/src/render/pipeline/RendererCore.ts`

### 触发和行为

| 事件 | 行为 |
| --- | --- |
| sub-page camera move | wrapped/new pages demand，复用稳定页 |
| page-quantum/camera cut | 对应 clipmap 页失效；cut 时全量 generation bump |
| sun direction/scene generation | 局部可证明时局部 dirty，否则 bounded full invalidate |
| caster transform/material alpha change | 受影响页 dirty，代际匹配后重绘 |
| resize | 重新计算 footprint；profile 不变时不强制销毁 atlas |
| device loss | 新 epoch 重建所有 VSM resources/pipelines/bindings |

### 诊断

至少暴露 page demand、allocation failure、dirty pages、caster records、atlas pixels、sampling fallback 和 overflow mask。诊断不能通过 mapAsync 结果控制当前帧工作。

## 10. E9：大模块集中检查与收口

### 进入条件

E1-E8 的 producer→consumer 已在同一 Frame Program、同一 command context、同一 production renderer path 中连通；CSM 已从生产依赖删除。

### 集中检查

按项目现有脚本运行：

1. typecheck；
2. build；
3. VSM page table/allocation CPU oracle；
4. WGSL sampling/overflow/odd-size targeted tests；
5. 能力 profile 和 device epoch focused tests。

浏览器 matrix、resize/camera cut/device loss 全组合、不同场景材质、视觉质量对照、GPU benchmark、formal evidence 和 claims 不在 E9 强制完成，留到全体 planned providers 完成后。

### 文档收口

- 更新 `docs/domains/shading.md`、`docs/domains/frame-runtime.md` 为源码已实现事实。
- 更新 `docs/porting/next-renderer.md` 的 R07 状态：只有 source mapping、WGSL/CPU oracle、真实 GPU producer→consumer 都齐备才可提升；否则保持 `not adopted`。
- 更新 `project/workstreams/active/eengine-next-clean-rebuild.yaml`：`currentSlice` 改为下一个大模块，VSM 放入已完成/模块历史；保留 `deferredValidation`。
- 不把 `requiredEvidence`、browser acceptance 或 claims 塞回 active workstream。

### 收口检查表

- [x] 只有一条 production renderer path。
- [x] 无本帧 GPU→CPU→GPU visible/work control。
- [x] 无额外 frame submit。
- [x] receiver demand、allocation、caster work、atlas raster、sampling 均接到生产 FrameGraph 的 GPU consumer；完整端到端 GPU 证据仍不足以提升 R07 adoption。
- [x] page/meta 双向一致、generation 正确、allocation/caster overflow 可观测。
- [ ] sampling fallback 与 overflow mask 当前只有保留的 telemetry 槽；有效计数留到 provider 交互诊断接通。
- [x] CSM owner 不再被 production import。
- [x] Standard/Coated direct lobe 只按 VSM visibility 乘一次。
- [x] 缺页、旧代际和 dirty 页返回中性 visibility；WGSL 采样检查覆盖该分支。
- [x] resize、camera cut、sun change、scene patch、device epoch 有明确生命周期；真实 device-loss 浏览器组合留到最终验收。
- [x] typecheck/build/必要 targeted tests 的实际状态如实记录。

## 11. 后续模块交接

E 完成后直接进入 SSSR 或整体计划的下一项。SSSR 可以复用 depth、Temporal Facts、有限 page/budget telemetry 和 world-space query 语义，但不能把 VSM page table 当作反射缓存，也不能重新引入第二个 frame submit。GI、VT 和 Transparency 仍按各自模块设计，先明确 streamed residency 与 GPU-produced residency 的区别。
### E8 implemented state (2026-09-28)

- `VsmGeneration` owns a monotonic non-zero generation per device epoch. It observes scene identity/publication, caster publication, sun revision/direction, camera cut, clipmap page quantum, and resize facts.
- `VsmInvalidationPass` publishes generation facts, bounded invalidation flags, and frame-local telemetry clears through the current FrameGraph command context. It never maps demand or page buffers.
- `TemporalFactsPass.invalidate()` drops the next identity history when VSM lifecycle facts require temporal reset.
- `RendererCore` rebuilds VSM resources and passes on a replacement device epoch; VSM frame constants use the lifecycle generation rather than `frameIndex`.
- `Renderer.vsmDiagnostics()` exposes GPU buffer locations for page demand, allocation failure, dirty pages, caster records, atlas pixel capacity, sampling fallback, and overflow mask. These locations are diagnostic only and cannot control current-frame work.
- Page-quantum shifts currently take the bounded full-generation fallback because the existing page-table ABI has no toroidal remap metadata; this prevents stale world-origin content from being sampled. Sub-page motion still keeps the generation and resident slots stable.
- E8 implementation is complete. E9 focused module checks completed on 2026-09-28; browser/lifecycle combinations remain final acceptance.

### E9 focused closeout (2026-09-28)

- 修正页表 32-byte entry 容量和六个独立 mip 平面；128 页轴时每个 clip level 为 21,840 条目。能力协商同时检查 page table、page/slot locks 和各工作 buffer 的 binding/size limit。
- 修正 caster 页范围使用实际 `entry.mip`；新增 GPU allocation indirect 驱动的 dirty 物理槽深度清理，保留 clean 缓存页；caster records 溢出时不提交部分 dirty 页。WGSL 采样的类型/保留字问题已修正。
- `npm run build:test`、`node --test tests/oracle/vsm-e9.test.mjs`（6/6）、`node --test tests/contract/frame-program.test.mjs`（7/7）、`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。CPU oracle 覆盖页表唯一性、容量/profile、奇数尺寸、分配复用/驱逐/溢出和 device epoch。
- 本机 Chrome WebGPU 隔离检查：七份 VSM WGSL 模块无编译 error；普通/Product Atlas 和 dirty-slot clear 的真实 render pipeline 无 validation error。方形 Atlas 的 indirect clear 深度读回为 dirty 槽 0、相邻 clean 槽 1；采样 GPU 读回依次为缺页 1、dirty 页 1、clean 有遮挡页 0、旧代际页 1。2 个物理槽处理 3 个需求的分配微测得到 attempted=3、written=2、overflow=1，未出现 validation error。这些微测是调试检查，未登记为正式 evidence。
- 当前 caster 来源仅为当帧 MeshletWork，不能证明屏幕外遮挡者全覆盖。`samplingFallback` 与 `overflowMask` 诊断位置尚为保留槽，不能解释为有效计数。R07 维持 `not adopted`；VSM/A–D 交互、画质、正式 GPU P50/P95 和跨浏览器矩阵留到整链集成验收。
