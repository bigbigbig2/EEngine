# Surface V3 第一版优化执行文档

当前推进：Phase 4 代码收口已提交（`b882cc5a`），Phase 5 代码已完成；正式整链验收延期至 Phase 7，下一阶段为 Phase 6。

日期：2026-10-03。基线：`0676cf28`。状态：**执行中；Phase 0–1 完成，Phase 2–3 已完成代码切换但正式验收延期，Phase 4–5 代码收口完成但正式验收延期，Phase 6–7 尚未开始**。详细状态见[进度记录](surface-work-v3-optimization-v1-progress-2026-10.md)、[Phase 0 清单](surface-work-v3-optimization-v1-phase0-inventory-2026-10.md)、[Phase 1 发布记录](surface-work-v3-optimization-v1-phase1-implementation-2026-10.md)。

唯一配套细化设计：[Surface V3 第一版优化设计](../next-design/surface-work-v3-optimization-v1-design-2026-10.md)。保留[第三版总设计](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)的 owner 边界，按用户最新要求替换初版物理实现。历史执行记录见[原 V3 计划](surface-work-runtime-v3-rebuild-2026.md)；历史测量见[1080p 报告](../performance/2026-10-03-surface-v3-work-bandwidth-report.md)。

## 1. 执行目标与节奏

本轮不是先做一组保守 patch 再讨论架构，而是一次连续切换：

```text
相同 winner 才共享 → 连续域内跨 primitive、按字段/信号共享
mixed 全率 → 局部 cell 多档率与 implicit addressing
pixel/camera cache → canonical surface/chart 字段缓存
全屏 192 B GeometryRecord → 按需求 64 B hot + cold
dense fields / 四 packet planes → 稳定 FieldStore + 稀疏信号引用
四路全屏 Surface histories → 有界 SignalStore
全屏最大 scratch → 固定预算 batch scratch
```

按用户最新执行指令，**逐 Phase 完整实现，完成本阶段必要检查并返工后，每 Phase 只做一个中文提交，提交成功再进入下一 Phase**。这覆盖原文“开发阶段不检查”的时点安排。各阶段运行能验证其实际产物的定向检查，不以未连接消费者的单元检查证明整链完成；中间可以缺消费者或无法出图，不保留旧生产桥接路径。整个新链与真实 providers 连通后，Phase 7 集中完成整帧数值、浏览器、连续画质与同条件性能验收。

各 phase 下的“完成产物”必须逐项核查，不得简化阶段范围或以占位接口代替实际producer/consumer。检查失败就在本阶段返工，不碎片化提交；来源核读在相应复杂算法实施前完成，来源采用与正式性能claim仍独立于阶段完成。

## 2. 不可交付的伪完成

- 改了 SharingKey 类型，内部仍以 VisibilityKey 相等决定共享。
- 新跨 primitive 分支默认关闭、误差阈值全为零，或所有非空 tile 仍 full-rate。
- 直接使用 cooker 的任意 risk→domain0，把原有保守性换个位置。
- 粗率前先全屏恢复 geometry/material，或重建时再跑一遍 PBR。
- hit 不跑重 shader，却照样重写完整 GeometryRecord、材质结果与所有 packet。
- 引入紧凑 cache，却仍保留六层全屏 fields、pixel keys 或旧四路 histories。
- 用跨帧 CPU readback 分配本帧可见 work、额外 submit、GPU 全局 spinlock 维持新链。
- 只在静止、低覆盖、VSM 关闭时有效，移动相机仍全 miss，但报告为最终优化完成。
- 只比较某个 pass，忽略 classifier、lookup、batch、history、冷启动和额外显存。

## 3. 修改、保留与删除地图

下列路径相对仓库根。现有文件可在职责变化后合理更名，但不得借更名保留双 owner。

| 入口 | 动作与最终责任 |
|---|---|
| `OEngine/tools/oengine-asset-core/include/oengine_asset/SurfaceMetadata.h` | 重写域/字段 seam 构建；几何连续域与完整顶点字节相等分开 |
| `OEngine/tools/oengine-asset-core/src/geometry/GeometryCooker.cpp` | 发布独立风险、域 lineage、LOD 有效域；删除 any-risk→domain0 的全局语义 |
| `OEngine/src/gpu/SurfacePrimitiveAbi.ts` | 同步新 publication metadata；最终布局稳定后再写合同 |
| `OEngine/src/gpu/TextureVariation.ts` | whole-texture summary 不再承担局部共享决策；加入局部 mip/footprint 摘要入口 |
| `OEngine/src/render/FrameGeometryVertices.ts`、`FrameGeometryArena.ts` | 保留现有资源 owner，扩展按需求 primitive setup/共享属性入口 |
| `OEngine/src/render/surface/SurfaceWorkRuntime.ts` | 替换 winner-uniform classifier、pixel sample allocator 和映射；拥有多率 work/rate plan |
| `OEngine/src/gpu/GpuSurfaceWorkAbi.ts` | 删除旧固定 pixel-capacity 分区；定义 batch/template/ref 的真实布局 |
| `OEngine/src/render/surface/SurfaceCacheIdentityPass.ts` | 删除 dense 13-u32/pixel witness；必要轻量逻辑并入地址/lookup 发布边界，旧 pass 无消费者后删文件 |
| `OEngine/src/render/surface/SurfaceDependencyEpochPass.ts` | 改成字段/信号选择性依赖；去掉 camera epoch 对稳定字段的 blanket invalidation |
| `OEngine/src/render/surface/SurfaceGeometryPass.ts` | 唯一 producer；address helper、需求并集、hot/cold、按需分配；删除全屏持久 record cache |
| `OEngine/src/render/surface/SurfaceMaterialCachePass.ts` | 替换为有界 FieldStore 的 lookup/admit/publish；删除 dense keys、重复 values 与 pixel cache |
| `OEngine/src/gpu/GpuAppearancePublication.ts` | 字段闭包、Constant/Persistent/Transient 路由、masked miss、有限 program dispatch；缓存绑定 |
| `OEngine/src/gpu/GpuSurfaceProgramSpecialization.ts` | 维护有限 profile 与最大资源需求，不按材质实例制造 PSO |
| `OEngine/src/render/surface/SurfaceLightingWorkPass.ts` | 保留 direct/IBL/coat 数学，拆信号率与 SignalStore，删除四路 pixel planes |
| `OEngine/src/render/surface/SurfaceReconstructionPass.ts` | 模板/map 解析、有限插值、compose；删除四 history pairs 及私有 dense identity/age |
| `OEngine/src/render/surface/SurfaceFrameResources.ts`、`SurfaceProducts.ts` | 明确 scratch/persistent/output 生命周期、预算、代际与 alias 时点 |
| `OEngine/src/render/program/FrameProgramLowering.ts` | 编码固定最大 batch 和真正资源边；维持唯一 encoder/submit |
| `OEngine/src/render/temporal/TemporalFactsPass.ts` | 保留事实权威；新增 consumer 不另造同类事实 producer |
| `OEngine/src/render/vsm/VsmAtlasRasterPass.ts` | 在现有 VSM owner 内修复已有初始化失败并连通最终验收配置 |
| `OEngine/src/render/surface/SurfaceDiagnosticsPass.ts` | 更新真实工作/物理产品计数，不把旧统计名称覆盖到新语义 |
| `OEngine/src/gpu/WebGpuCapabilityRecord.ts` | 区分发现、device 启用、profile 消费；基础算法不依赖可选扩展 |

不得重新接入 `WinnerPrimitiveInterpolation` 旧 coordinator 或 retired SurfaceMaterial/Probe/SparseLighting 主链。可复用其需要的数学和仍有效的数据合同；无消费者代码在确定最终依赖后删除，不为旧测试保留运行桥。

## 4. Phase 0：固定身份、预算与删除边界

### 工作

1. 固定 `0676cf28`、GTX 1650 Ti/1080p、Dungeon asset fingerprint 和既有报告；保留 timing/detailed 分开的口径。
2. 记录 VSM 关闭/jitter 关闭的已有基线，明确它与未来完整功能验收不是同一个配置。已有报告不改写成 VSM-on 成绩。
3. 按设计分清 WinnerIdentity、SharingDomain、三种地址、FieldRef/SignalRef；完整 logical key 比较与近似 footprint validity 分开。
4. 固定 412 MiB 初始资源预算、512 MiB Surface envelope、R=262144 初始 batch 上限及最坏 profile 推导方法。
5. 在来源账本核对采用入口、未覆盖算法和本地扩展，不宣称已移植。
6. 列出旧 dense 产品的分配、producer、consumer、debug consumer 和销毁入口，准备一次切断。

### 产物

一份真实生产依赖删除清单、字段/信号依赖表和容量推导。这里只固定配置，不启动新采样。历史基线需要重现时在 Phase 7 的独立 checkout 进行，不在新生产路径里放 A/B switch。

## 5. Phase 1：连续域、LOD 与局部 variation 发布

### 5.1 连续域

- Cooker 的连通构建拆成几何身份、UV0/UV1 chart、normal/tangent/color 连续性；保留反向边和 manifold 判断。
- 同材质但不连接的表面不合并；跨 meshlet 的真实连接保留稳定 domain。
- two-sided 用 side 语义处理，不自动撤销整个表面的可共享身份。
- LOD simplification 传递 source domain/seam lineage 与误差；混合来源超界时只发布该字段/局部的 LOD-local identity。
- 普通 Geometry 和 Product 接同一 metadata 合同，Native/WASM 生产者同步更新格式与 recipe identity。需要 recook 时明确版本切换，禁止静默读取旧 metadata。

### 5.2 纹理摘要

- 为实际材质所用纹理发布按 mip/局部块的颜色、normal cone、roughness、emissive bounds。
- 包含 sampler/filter/wrap/anisotropic footprint 邻域语义；摘要缺页和内容失效通过 TextureResidency 管理。
- 压缩纹理优先使用 cooker 摘要；运行时生成资源用同帧图 publication 构建，不能追加 private submit。
- 32 MiB 是摘要 pool 的总目标，不是仅数值 payload；metadata、mip offsets、页表和更新 scratch 都需登记。

### 产物

从 CPU 产品到 GPU Surface consumer 的实际 publication 资源，含版本与容量；不只增加一个 Surface 读不到的接口。字段风险分开，旧全局 domain0 语义在新链上消失。

## 6. Phase 2：切掉旧 classifier，建立默认跨 primitive 工作

### 当前状态（代码切换完成，正式验收延期）

Phase 2 的 plan ABI、CPU/GPU synthetic oracle、Geometry setup 和 production facts 组件已经存在；`SurfaceCellClassifierPass` 已接入 `SurfaceWorkRuntime`，runtime 旧 `CLASSIFY_WGSL` 源码已删除，多字段生成器的 `field` 未声明错误已修复。当前只完成了降低范围的源码生成检查和 TypeScript 构建检查；Chromium fixture 在 pipeline compile 阶段长时间无终态，因此不把正式 producer/consumer 验收记作通过。Phase 3 已完成 compact record 字段、FieldStore lookup gate、评估后 publish/admit 与 bounded GeometryRecord arena 的接线；完整跨帧 value 消费及正式 GPU/browser 验收仍后置。

1. 删除 VisibilityKey equality 的共享准入；winner 只用于覆盖、属性来源和 exact identity。
2. 接入 domain/side、轻量 depth plane 与 field variation；默认生成 2×2 候选，按设计合并 4×4/低频8×8 或局部细分。
3. 让单组可包含多个 primitive/meshlet，不把 primitive 边界当固定 full-rate exception。
4. 输出字段率和照明率，不再只有一套 sample rate 控制全部材料与光照。
5. 实现 nonempty implicit template、uniform-domain 与 mixed-domain 的正交表示；全率连续 span 也不能生成每 pixel 宽 task。
6. compact 实际代表与少量显式 remap；局部 group/map 溢出转同一新链的 implicit fine cell。
7. 引入 batch 范围和 bounds，后续阶段只消费本批有界目标；最后一批、空 tile 和局部覆盖有明确写域。

### 6.1 Phase 2 的激进硬门槛

本阶段不能用“SharingDomain 已存在”代替真正的工作量变化。实现完成前必须满足以下代码级条件：

- `SurfaceWorkRuntime`/classifier 中不存在 `allVisibilityKeysEqual`、`samePrimitive` 或等价的共享准入分支；`VisibilityKey` 只能用于 winner coverage、属性来源和 exact identity。
- 一个真实 cell 的代表集合可以同时包含两个以上 `VisibilityKey`，且可以跨 meshlet；primitive/meshlet 边界不能自动写入 full-rate exception。
- 默认 profile 必须实际产生 2×2 或更粗的 field/signal cell。若所有非空 tile 都发布 1×1，直接判定失败，不得以“保守画质”为理由接受。
- 8×8 低频 diffuse/environment 路径必须有独立 rate plan；normal、specular、coat 或 direct 的细分只能影响对应信号。
- 生产诊断必须输出 `cross_visibility_key_group_count`、`cross_meshlet_group_count`、`multi_key_cell_pixels`、`forced_fine_reason_mask` 和每档 rate 覆盖数。只输出总 sample 数不能证明本阶段有效。
- 微三角形连续墙、跨 meshlet 平面、UV seam + 高频 normal 三组 fixture 必须分别证明：跨 key 合并、meshlet 不强制断开、字段/信号局部细分。

任一硬门槛失败就留在 Phase 2 返工；不能通过把阈值设为零、关闭跨 key 路径或保留旧 pixel sample 展开器来“通过”。

切断时同步去掉旧 `sample = pixel` 的跨 owner 假设。允许后续 consumer 暂时不匹配，不写长期 adapter 把新 work 展开回全屏旧 work。

## 7. Phase 3：稳定 FieldStore 与唯一 demand Geometry

> 当前进度（核心代码已接通，正式验收延期）：Phase 3 已完成 compact record 字段缓冲、FieldStore 初始化与 lookup gate、评估后 publish/admit，以及 bounded GeometryRecord arena 的生产接线；旧六层全屏 field texture、pixel-capacity witness/value 分配已删除。仍保留 19-word compact identity 作为发布元数据，FieldStore value 当前为 4-word admission 摘要，完整跨帧 value 消费、溢出/驱逐与 Phase 7 GPU/browser 验收继续后置。

### 7.1 先确定字段依赖和持久地址

- Appearance 编译器对每字段给出 constant、stable-local、geometry、view、dynamic、nonlocal 依赖闭包。
- canonical chart/cell key 不含无关 camera epoch；完整 sampler/纹理内容/程序版本继续严格比较。
- 实现 footprint validity 与局部误差预算；exact hit 和 bounded-footprint hit 分开。
- 常量发 ConstantRef；unsupported 参数化的字段进入 transient，不影响同材质其他稳定字段。

### 7.2 有界 lookup / miss / publish

- FieldStore 的128 MiB含key、值、目录和管理元数据；有限 probe、有限 admission、generation/pin。
- Lookup → request dedup/admit → evaluate → Publish → Consume 分 dispatch；collision/full 转 transient，不跨组 spin。
- per-field miss compact 和 per-program indirect 消费真实任务；部分 miss 不再重算命中字段。
- 删除 dense material key、duplicate value、六层全屏 field texture 的分配与所有 producer/consumer。

### 7.3 Geometry demand 与布局

- 廉价地址/footprint 从现有 FrameGeometry setup 和同一 SurfaceGeometry owner 取得；不新增全屏 probe。
- 合并 geometry-dependent 字段 miss 与潜在 dirty lighting 需求；同一地址只生产一份记录。
- hot core64 B目标，cold按consumer mask分配；每个profile推导最大stride、字段数和R。
- 重 worker 只处理需求集合；完全复用项不刷新 36 B metadata，也不预分配192 B/pixel。
- 记录 speculative geometry、setup命中/直接计算和cold实际字节，避免优化成本藏在前置阶段。

### 产物

移动视角可复用的正式 FieldStore 和新 GeometryRecord 生产链，旧 dense cache/witness/geometry 生命周期彻底切断。此处不运行中间 hit benchmark。

## 8. Phase 4：拆分信号率、紧凑 packet 和稀疏 history

收口状态（2026-10-03）：Phase 4 代码实现已完成；正式 WGSL、数值、GPU、浏览器和整链验收统一延期到 Phase 7。Phase 5 负责删除 Surface 自有 history/identity/age 并建立批处理 reconstruct。

当前源码状态（2026-10-03）：Phase 4 代码收口已完成。`SurfaceLightingWorkPass` 已将 direct diffuse、environment diffuse、direct specular、environment specular、coat direct、coat environment 作为六个独立 signal family，使用按 record 的紧凑半精度 packet，并在异常值时写入 16 B precision spill；四路全屏 lighting packet plane 与 dense signal witness 已从该主链移除。`GpuSurfaceSignalStore` 负责有界 64 MiB resident store，lighting classify 在重 worker 前直接 probe，lighting 后通过独立 miss-only pack/publish 节点发布，entry 使用 20-word ABI 并维护 generation、valid、age/confidence。`SurfaceReconstructionPass` 已进入 Phase 5，删除 Surface history/identity/age，改为按 extent/profile batch 规划、GPU indirect count 和 packet/TemporalFacts 合成。正式 WGSL/数值、GPU、浏览器和整链验收统一留到 Phase 7。

1. 将当前 IBL 拆成 Denv、Senv、E；direct diffuse/specular 与 coat direct/env 分开依赖和需求。
2. 使用有限 diffuse、specular/coat worker families；保留原 direct/BRDF、atmosphere、cluster、shadow 与环境数学。
3. 明确 irradiance/radiance、`1/π`、Fresnel/coat attenuation、AO、色域、pre-exposure 合同；每项只由一个阶段负责。
4. 能分离的 diffuse 高频反射率在 compose 使用字段值；不能分离的BRDF残差留在lighting worker，不退化数学、不搬到reconstruct。
5. 建立64 MiB总预算 SignalStore，含读写epoch、key、validity、age、generation及结果。
6. 信号lookup在重worker前发生；view/normal/roughness/light/shadow/environment按分量判定，稳定材质hit不冒充lighting hit。
7. Absent coat只发ZeroRef；E直接引用字段。packet默认8 B，高动态范围/精度异常转16 B slot，最坏spill纳入预算。
8. 删除四路pixel packet planes及dense signal witness；旧计数迁移为求值、存储、复用、spill分列。

历史读写不在同一dispatch互相竞态。重复cell每submitted frame只推进一次age；跨批cache消费和驱逐按有序发布/pin处理。正常miss必须在当前帧产出结果，不能等FSR3填洞。

## 9. Phase 5：廉价 reconstruct 与完整 batch 复用

当前状态（2026-10-03）：代码收口完成；正式 GPU、浏览器、画质与整链验收延期到 Phase 7。

- Reconstruct按本批output region写入；规则cell用模板，mixed用紧凑映射。
- 同domain/字段seam/side内选择合法source；默认单tap，必要插值至多4 tap/信号，按真实tap统计读取。
- 实现必要compose factors、AO/energy、Rec.709→Rec.2020和pre-exposure边界；不读材质纹理、不恢复完整几何、不执行PBR。
- 删除四路Surface history pairs、私有dense identity/age、相应交换与清零pass。TemporalFacts与FSR3各保留自己的权威职责。
- 每批reconstruct结束后才复用scratch；FrameGraph显式表达最后consumer到下批producer的顺序，禁止按阶段遍历全部批次却复用同一份未消费scratch。
- 固定batch上界来自extent/profile；每批实际count/indirect由GPU写。1920×1080默认8批，但编码不得把8硬写成所有分辨率的常数。
- 全miss/全率也使用同一链完整处理。persistent store不足转transient；cold或packet最坏stride较大时发布阶段降低R。

产物是从Visibility到最终HDR/reactive的唯一闭合新链。此阶段结束仍先完成Phase6真实providers与生命周期，再统一验收。

## 10. Phase 6：资源、真实 providers 和能力接线

### 固定预算

- 资源账本按设计表列payload、metadata、queues、alignment、scratch、persistent、history与retired overlap；不能只显示allocator申请总数或逻辑active字节。
- Surface 512 MiB envelope与全引擎账本同时记录；共享基础资源另列，新增Surface成本不得挪账。
- 推导所有queue上限：目标像素、唯一地址、字段数、signal数、program分区和precision spill；R不能直接充当每种多分量队列的上限。
- 原512 MiB约束不能容纳某profile时先调整批大小/物理分段或缓存分配，不能等GPU越界。未支持的device/config明确失败，不静默降画质或漏像素。

### 生命周期

- 覆盖submit/abort、同一提交多批、上一提交在途、resize retirement、scene unload、slot reuse、LOD/纹理更新、camera cut、device loss。
- 使用发布generation和submitted epoch，不以CPU帧号假定GPU已完成。
- 绑定、view、sampler、pipeline按publication/profile/extent缓存；避免每材质每批重复创建。
- 可选immediates/subgroup-size-control/buffer_view仅作为有限specialization，基础语义一致；先发现再申请再消费，记录三种状态。

### 真正 provider

- 修复已有VSM初始化错误，接真实shadow页/content依赖；direct粗率不越过未知shadow风险。
- LightCluster、AO、authored/physical environment、Atmosphere、TemporalFacts与FSR3消费真实frame产品。
- 保留既有太阳diffuse `1/π`与曝光修复；新packet单位合同不能再次引入泛白。
- 清理无消费者旧资源、debug模式和兼容helper；不为旧tests恢复旧ABI。

只有新链真实接通后，集中更新workstream currentSlice与当前实现事实。来源采用状态仍等待Phase7相关证据。

## 11. Phase 7：统一编译、正确性、画质与性能

本阶段在新链完整接线之后执行。各早期阶段检查不能替代这里的完整范围；验证失败就在新链修复，不回接旧renderer。

### 11.1 编译与数值/合同

集中运行typecheck、build和必要targeted tests；Native/WASM metadata生产者与真实WGSL profiles一并覆盖。测试应检查独立不变量/数值参考，不写复制实现的镜像测试。

| 场景/不变量 | 必须观察到的结果 |
|---|---|
| 一面由大量微三角形组成的连续墙 | 某真实group含多个VisibilityKey；material/lighting代表少于覆盖像素；不能仅测试同大三角形 |
| 跨meshlet的同一连续表面 | meshlet边界不强制降为1×1 |
| 同材质的前后墙、缝隙、双面 | 不跨不相连域/side借用结果 |
| UV0 seam、UV1连续、常量roughness | 仅依赖UV0的字段细分；其他字段仍共享 |
| 高频normal与平滑base | normal/spec可局部全率，base不被连带重算 |
| 低roughness、coat亮点、spec env | 高频反射保留；Denv降频不吞掉Senv |
| light/cluster/shadow边界与移动遮挡 | 只复用依赖有效的信号；新遮挡没有持续拖影 |
| 相机移动/旋转、footprint改变 | stable-local字段继续合法命中；过细/跨缝footprint拒绝；不靠像素地址撞中 |
| LOD、Product页、纹理内容更新 | 失效关联字段/页，未关联内容继续有效 |
| 程序partial miss | 命中字段不求值；geometry仅按真实依赖生成 |
| 没有coat的整帧 | coat求值/写入/历史占用均为零 |
| HDR超半精度范围 | precision spill保能量，无硬裁剪 |
| cache collision/full、局部map full | 同帧transient/fine处理，覆盖完整，无越界/全局自旋 |
| 全屏每像素不同域、全字段miss | 最坏容量成立，按固定批完成，像素恰好写一次 |
| resize/cut/abort/device loss | 无stale ref、错误history推进或超预算退休重叠 |

数值参考覆盖透视插值/导数、canonical footprint判断、字段过滤误差、normal编码、signal能量、half/full精度与色域/exposure。独立CPU oracle与真实producer→consumer GPU证据分开记录。

### 11.2 画质

固定曝光、相机、场景、灯光、环境和功能开关；包含静止、慢移、快速转动、disocclusion、近远LOD与纹理驻留变化。截图加连续序列，不能单张静止截图代替时域质量。

观察轮廓/遮挡、纹理清晰度、UV缝、法线细节、金属/coat高光、阴影边界、emissive、细线、噪声、闪烁/拖影和整体能量。对比linear HDR误差与最终呈现，避免曝光/tone mapping掩盖能量偏差。

空间误差阈值、view有效域和history age在此统一校准；不得为了成绩关闭coat/spec/VSM/AO或把默认激进profile改成所有像素全率。某特性需1×1时保留该局部结果，并报告占比。

### 11.3 性能实验组

1. **历史可复现组**：与`0676cf28`报告一致的VSM-off、jitter-off、1080p配置。
2. **完整功能组**：真实VSM-on及最终时域配置；旧版本如不能运行该配置，报告不可比较，不造旧数值。
3. **受控结构组**：微三角形墙、大三角形墙、纹理/normal频率梯度、复杂材质、coat缺席/存在、极端混合域。
4. **生命周期/冷路径组**：cache cold、warm、camera cut、快速移动、纹理发布、LOD变化、显存预算压力。

保留原V3四版本同条件比较要求，逐一固定可获取的revision、资产和功能。旧full-resolution基线在独立checkout运行，不建运行时桥；不能获取可运行等条件基线时明确缺失，不从文档推测成绩。

正式timing关闭会显著干扰时间的detailed counters/readback，work/bytes单独跑同轨迹；记录预热、样本数、P50/P95、失败帧、timestamp精度和CPU帧间隔。分阶段P50不相加推整帧；整帧首尾跨度另报。

### 11.4 必须交付的数据表

| 类别 | 指标 |
|---|---|
| 条件 | GPU/driver/browser/revision/asset hash、内外分辨率、renderScale、曝光、所有功能、轨迹与预热 |
| Tile | empty/single-domain/mixed-domain；implicit/explicit addressing；非空implicit；各细分原因 |
| 共享 | 跨VisibilityKey/跨meshlet的组数和覆盖像素；组内winner数量分布；1×1/2×1/1×2/2×2/4×4/8×8分字段/信号占比 |
| Sample | 地址并集、各字段代表、各信号代表、mixed贡献、V/P归一化比率 |
| Geometry | 需求并集、实际record、setup/直接计算、speculative需求、hot/cold字节、完全复用零写项 |
| Field cache | constant、exact hit、bounded-footprint hit、各字段miss、camera/footprint/版本/容量/冲突拒绝原因 |
| Lighting | Ddirect/Denv/Sdirect/Senv/Cdirect/Cenv/E引用、dirty/hit、实际求值和写入、zero ref、precision spill |
| History | 合法复用、版本/视角/遮挡拒绝、age分布、占用和淘汰，不能只报hit率 |
| 逻辑字节 | 分类/setup、keys/values、queues/maps、geometry hot/cold、packet、history、reconstruct读写、摘要更新 |
| 物理容量 | active/reserved/peak/retired，各产品与全引擎总量；MiB单位；不把capacity当traffic |
| GPU时间 | Visibility、分类/address、lookup/admit、Geometry、Material、Lighting、publish/maintenance、Reconstruct、Surface总、FSR3、VSM、XeGTAO、整帧 |
| CPU/调度 | batch数、dispatch数、command encoding、提交等待、bindgroup/PSO创建、实际页面帧间隔 |

如果没有硬件DRAM counter，只能写“逻辑字节减少”，不能写“实际显存带宽降低了相同百分比”。所有新增metadata/queue/summary pass都计入，不只计被优化掉的大record。

## 12. 验收结论如何做

分别回答以下问题，不能用一个“通过”覆盖：

1. **结构兑现**：跨primitive、多率、稳定缓存、按需geometry、稀疏history和预算是否真的在唯一生产路径消费？
2. **正确性与画质**：边界、HDR能量、时域、LOD/资源变化与极端容量是否满足要求？
3. **GPU工作收益**：移动段字段miss/geometry/lighting是否减少；哪些字段仍被高频限制？
4. **字节与容量收益**：删除了哪些dense产品；新增lookup/map/history是否抵消收益？
5. **总体性能**：Surface总和整帧P50/P95是否改善；FSR3、VSM或CPU编码是否成为新主导？

若mixed仍占大量样本，检查domain fragmentation、seam lineage、variation UNKNOWN和默认拒绝原因，而不是再次把“mixed就全率”当理所当然。若hit高但时间不降，检查lookup随机访问、宽key、batch/program dispatch、reconstruct taps与maintenance。若record少但峰值仍大，检查残留dense分配、cold最坏预留和退休重叠。

失败在新链内返工。没有数据支持时不承诺固定FPS/百分比，也不以“V3更先进”替代比较结论。

## 13. 最终文档与交付

整个主链完成后集中更新：

- workstream的currentSlice、goal、architectureRules与deferredValidation；完成与未完成项分开。
- `docs/domains/`的当前事实；最终稳定ABI/协议才写入`docs/contracts/`或`docs/specs/`。
- 来源账本的本地阶段映射和真实采用状态；不因编译通过就提升adoption。
- 一份固定条件性能报告、连续画质对照、资源峰值/溢出与生命周期记录。
- 中文commit说明动机、删除/替换范围、实际已运行通过/失败/未运行的验证与原因。

阶段实现与检查按最新用户指令持续进行；未完成项目不得写成完成。Phase 0 固定输入及capacity policy不代表production renderer已经采用新方案。
