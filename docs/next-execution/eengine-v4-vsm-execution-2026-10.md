---
id: eengine-v4-vsm-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-v4-vsm-2026-10.md
    - OEngine/tools/oengine-asset-core
    - OEngine/src/render/vsm
    - OEngine/src/render/ShadowGeometryWork.ts
    - OEngine/src/render/program
    - OEngine/src/shaders
    - OEngine/src/gpu/GpuInstanceAbi.ts
    - OEngine/tests/oracle
---

# VSM V4 执行计划

唯一模块设计见[VSM V4 design](../next-design/eengine-v4-vsm-2026-10.md)，全局规则继承[V4 母稿](../next-design/eengine-v4-native-shading-2026-10.md)。旧Module E只提供追溯，不定义V4实施或状态。用户已授权启动V4-R0，当前workstream切至VSM V4；Minimal GPU Work仍暂停。R0不自动跨入R1生产重构。

## 1. 状态与停止点

| 单元 | 状态 | 完整责任闭包 |
|---|---|---|
| V4-R0 源码与来源设计 | complete（设计/当前实现基线） | GPU原失败与当前设备基线、SOURCE分类、独立坐标算术、固定donor核对、候选成本与路线 |
| V4-R1 实例语义与稳定投影 | not-started | Cooker/Scene→cast/receive→Geometry/Surface；world page key、稳定depth、epoch/prepare/commit/abort→全部consumer |
| V4-R2 完整需求与驻留 | not-started | bitset→unique request/touch→slot选择→page/meta/dirty/coarse→采样和页工作 |
| V4-R3 caster与页面完成 | not-started | Geometry bounds/source→compact explicit或implicit全工作→native raster→per-page completion→Surface |
| V4-R4 完整场景验收 | not-started | 真实cook Bistro、动态/压力/生命周期、正确性/画质/成本和资源峰值 |

本轮闭合R0后停止在R1入口。设计不代表实现采用，未关闭任意production VSM故障；R0完成不等于VSM已修复或验收。

## 2. V4-R0 设计依据与已做检查

- 源码基线HEAD `821ed4eeb96d4d0ab1da5523a8cdbfa25be017b9`；太阳日历与暂停导航的现有未提交改动保留。
- 定向审查Importer/Scene、ShadowGeometryWork、VSM全部producer/owner及native partitions/raster、Physical Sun consumer、Renderer生命周期和测试范围。
- 已有GPU诊断：full cooked Bistro原始0cast/0ready；补标记78172 attempted、65536 written、12636 overflow、0ready；诊断容量131072有515ready。原件路径与限制见Design §2，不重新解释为修复或新验收。
- 本轮独立double算术：页内UV不变而relative signature变动；沿light-axis移动1在extent64时depth偏移0.001953125。artifact `.local/validation/vsm-v4-design/math-probe.json`。不是production GPU实验。
- 从固定GitHub revision重取页标记/slot管理/滚动/失效/page commit/task-mesh-fragment/sampling及host入口；Apache-2.0原LICENSE已读，文件SHA已保存。本地memory/work算式为估算，未测新GPU净收益。
- 当前设备：RTX2060 SUPER 8192MiB、driver591.86；新基线保存到 `.local/validation/vsm-v4-r0-2060-super`，与旧诊断原件分开。GPU作业串行，HTTP标记/容量诊断不改生产TS/WGSL或cooked资产；不启动另一个大模块。

### 当前设备GPU基线（2026-10-10）

完整cooked Bistro，1591instances，960×640、固定曝光1、原camera/default Sun、calendar关闭、FSR3/jitter关闭；启用VSM后等待30+30帧读取真实GPU instance/caster/page产品。保持原诊断脚本的两种HTTP标记实验，容量扩展为独立串行作业。原件分别为 `result.json` 与 `result-capacity-131072.json`，两份均无pageerror/console error。该分辨率只用于复现故障，R4成本/质量仍必须1080p。

| 诊断 | GPU投影实例数 | settled attempted / written / overflow | dirty / ready页 |
|---|---:|---|---|
| 原始资产，capacity65536 | 0 / 1591 | 0 / 0 / 0 | 516 / 0 |
| HTTP补cast+receive，capacity65536 | 1591 / 1591 | 76515 / 65536 / 10979 | 517 / 0 |
| HTTP补cast+receive，capacity131072 | 1591 / 1591 | 0 / 0 / 0（steady缓存状态） | 0 / 515 |

最后一行的0记录来自页面已完成后的steady状态，不表示initial raster没有caster。结论仍是实例语义首先阻断投影，修语义后现有全局容量又阻断ready；扩容能让该诊断视角完成页面，但不是正式修复、完整receiver覆盖或新架构性能证据。与旧实验attempted/页数的差异不作为机器加速比；去重前容量截断与执行时序问题仍须独立集合验证。

`adapter.json`为使用RendererCore相同选择参数的独立WebGPU capability查询：NVIDIA/Turing、非fallback，浏览器未披露具体device/description；具体型号由 `hardware.json` 的nvidia-smi结果确认。支持BC、timestamp-query、shader-f16、indirect-first-instance；本设计portable baseline不依赖subgroups/实验multi-draw。adapter maxTextureDimension2D=16384，而实际Renderer device协商值8192；device maxStorageBuffersPerShaderStage=16、maxBufferSize=2147483648、maxStorageBufferBindingSize=2147483644。不能把adapter上限当已申请device能力。初次capability查询访问无根目录入口失败，修为独立本地诊断页后查询成功；原失败不归类为VSM故障。

### R0架构审查与出口

按producer→产品→全部consumer复核：资产语义由Scene发布；页面/需求/驻留/完成由VSM持有；Geometry提供完整独立shadow work；native raster提供实际执行状态；Physical Sun只消费ready。生产切换和旧职责删除落在R1–R3相应原子单元，单frame submit与GPU-only work control保持。R0未改变production，因此不存在新owner已接线的声明。

仍需实施否证：隐式W×D模式的最坏顶点税/u32域、tight meshlet bounds在shear与Product下的完整性、coarse页真实生产与质量、稳定depth范围和coverage/resident-cut失效。Cost Card为估算，不能据此验收性能。R0出口是设计依据、来源映射、失败分类和当前机器复现齐备；R1仍not-started。

## 3. V4-R1：实例语义与稳定投影

1. 统一实例默认与显式关闭、GPU instance语义与meshlet分类的不同ABI；Native/WASM/source/public Scene所有producer遵循同合同。补recipe/identity边界并重cook合法测试资产和当前Bistro；不把旧0flags猜成默认on。
2. receiver与Surface同时遵守ReceivesShadow；cast切换/transform/material classification patch保留语义；BLEND/unsupported light请求保持明确能力边界。
3. VSM owner构建完整world key/floor-modulo/投影epoch；GPU Scene caster bounds reduction建立稳定light Z anchor/range。Camera-relative数学不再定义缓存身份，camera沿光轴不改变存储depth。
4. 生命周期candidate prepare/submit commit/abort完整切换；only-Sun-intensity不失效depth，Scene/sun方向/coverage/source revision有真实input。
5. 冻结并原子切换TS/WGSL page/constant/header ABI与所有需求、分配、caster、raster、采样、FrameProgram/debug消费者；删除旧relative signature/advance-before-submit职责。

退出：fresh typecheck/build:test/build；独立page地址/negative/深度/变换数学；真实GPU页内、跨页、light-axis camera和sun方向/光强；cook→binary→GPU cast/receive语义与显式off；abort→retry/device epoch。失败保原件并局部修，不恢复旧CSM/relative cache。该单元结束不宣称需求/caster容量已闭合。

## 4. V4-R2：完整需求、slot回收与coarse产品

1. 非生产完整构建receiver全域bitset+prefix、共同clip/mip selector；取完整request域，不接旧8192像素append。
2. touch全部requested后扫描S slots生成free/reclaim，再分配唯一miss；同epoch多frame回收、dirty无人需求撤销、mapping/meta完整发布。
3. 实现high96 coarse页优先保留/生产与fine pressure策略；coarse pinned不等于永久采样旧内容。物理能力不足保证完整coarse集合则明确拒绝。
4. clear/raster/commit改为接收唯一dirty page产品，为R3提供完整input；先保证无caster空页和现有caster成功域合法完成，不声称此时显式caster overflow已有恢复。
5. 集中切全部需求/allocator/采样/诊断consumer并删除旧append、页锁去重和generation-LRU；不得两allocator写同pool。

退出：>8192可见receiver独立预期页集合；高entropy/不同GPU执行顺序集合相同；相同content epoch替换页面/循环回收；touch-vs-evict竞争；free/clean/dirty/pinned的complete映射；全部coarse覆盖域可用、fine压力明确归类；0caster页ready；failure不ready；稳定页面移动；abort/resize/Scene/loss；真实管理税及内存。GPU串行，不把固定容量微测代替完整receiver集合。

## 5. V4-R3：紧致配对、完整压力模式与逐页提交

1. Geometry bounds产品覆盖ordinary/Product真实meshlet、shear/negative scale和border；source invalid/缺页保合法coarse cut，不能悄悄跳caster。
2. 完整构建16B显式pair/actualcount/native classification与GPU mode选择；shader绑定profile在分配前完整preflight。
3. 同时构建隐式W_partition×D模式；容量超C不使用partial显式records，使用同source/MASK/depth/gutter；CPU只编码有限native classes，动态count完全GPU产生。u32域/资源limit预flight不截断。
4. per-page completion读取真实Geometry/pair/partition成功状态；invalid不发布，空页与零visible fragment页合法ready；每页/内容version唯一writer。
5. sampler读取完整gutter并使用实际mip texel/bias；统一main/VSM coverage源码与publication事务，native Sun visibility仍只乘一次。
6. 原子切全部VSM caster ABI/NativeVisibilityPass/NativeRasterWorkPartitions/FrameProgram/诊断，立即删旧32B全局append-success模型与caster-driven commit。不以新pair适配旧casterconsumer过渡。

退出：显式vs隐式同帧独立depth/MASK/visibility oracle；容量C-1/C/C+1和单meshlet跨多页/单页超C；强制geometry或partition失败不ready；空页、全opaque、全MASK、cutoff与TextureResidency变更；off-camera/occluded、页边缘PCF、fine/coarse seam；VG refinement失效；所有reset/capacity/abort/epoch/retirement；0/50/100%dirty与rare/worst implicit成本，indirect draw/dispatch精确计数。隐式成本过高不是删除必需caster的理由，正常场景反复触发则保成本验收开放。

## 6. V4-R4：完整Bistro与模块验收

采用完整当前cooked Bistro的源码身份和重新cook产品，记录1591instances、2829226source triangles、132materials、405images及完整mips。不得裁剪模型或禁用MASK换通过。保存原无影与补语义仍overflow的失败原件，先同相机/太阳复现→新production→同条件修复证据，再扩大多相机、太阳高度/方位和动态caster/coverage/streaming。

功能检查：cast/receive/default/explicitoff；全receiver需求；fine/coarse/missing/stale/dirty/outside-domain真实分类；空页提交；mode/overflow正确性；camera三个方向与negative-world滚动；only-intensity与sun方向；VG coarse→fine；alpha纹理promote/demote；Scene replace/release、resize/toggle/abort→retry、2/3frame in-flight和controlled loss/recovery。每个试验保证目标分支被执行，断言要能拒绝原错误。

成本检查：当前RTX2060 SUPER 8GB、1080p/renderScale1、完整材质/纹理、固定曝光与camera、相同VSM/FSR/Atmosphere设置，GPU串行。1650Ti4GB保留低显存适配目标，当前无实机结果、不记性能通过。分列receiver/compact/slot management、shadow Geometry、pairs/partitions、clear/raster/commit、Surface、CPUencode与整帧P50/P95；静态和slow/fast、0/50/100%dirty、sun变化、normal/pressure。thermal/clock/working-set不同不宣称提升，缺timestamp/driver显存或硬件counter记UNKNOWN。记录binding/dispatch/draw、E/W/D、implicit帧比例、coarse比例和physical/reserved/live/peak/retiring资源。

模块关闭要求：必要正确性/生命周期/真实GPU接线全部完成，完整场景功能恢复，成本结果和目标设备限制明确；不能只写“build通过”。仍未达成本目标则保持相应验收OPEN。完整Renderer其他effect matrix/跨GPU/browser留最终集成，不替代本模块必需验证。关闭后STOP，再依据届时源码设计VT或下一模块。

## 7. 本轮验证结果

本轮完成源码/固定来源审查、独立double算术、当前实现GPU诊断及文档/导航检查。太阳日历独立4项测试（包含80组天文比较）、Bistro typecheck/build通过；build存在既有node:module浏览器externalization和chunk-size提示。`git diff --check`通过；`node tools/docs-verify.mjs`报告1 finding/74 historical warnings，唯一finding来自本轮未修改且被Git忽略的旧 `docs/status.generated.md` 缺frontmatter，新增设计/执行与本轮来源记录无finding；全库文档检查不记为通过。`vibe context`已指向VSM V4设计/执行与active模块。engine build:test、shader compile、新WGSL/CPU oracle、新V4 production GPU、Bistro新架构画质与P50/P95 **未运行**，因为R0未实施production。现有实现诊断不提升新设计采用状态。
