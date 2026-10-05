---
id: next-execution/surface-work-v3-classifier-store-repair-progress-2026-10
state: current
verifies:
  - OEngine/src
---
# Surface V3 五步修复执行记录

> 2026-10-04 后续状态：run06已完成同场景诊断，约801.7ms、accepted=false；本页历史“尚未运行步骤5”描述的是各提交当时状态。当前代码已保存14c17078；新重构见[执行计划](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)和[当前记录](surface-work-v3-cost-bounded-final-refactor-progress-2026-10.md)。

目标：[五步计划](surface-work-v3-classifier-store-repair-plan-2026-10.md)。起点为 `0bc4e68752ab187a1b508f7a1952e6ebe18bec02` 加计划已核对的 dirty 修改；起点 diff 保存在本机 `.local/surface-repair/start-dirty.patch`。不将 dirty 起点宣称为 clean HEAD。

## 步骤 1：独立引用、物理合同和发布边界

实现：代表并集与字段/信号需求保留，明确传递 batchTileCapacity/firstTile；input witness 只修改自己的身份位，不覆盖字段需求。Constant/Default/Zero/Transient 字段引用从实际 plane 与便宜 publication 身份解析；纯常量和 E-only 不分配完整 GeometryRecord。实际 reconstruct 读取独立 E、baseColor/metallic、occlusion、scalar AO；Denv 为未着色 irradiance，`1/pi` 只在 compose 使用一次，direct 保留生产 BRDF 已着色 residual，specular/coat 仍为独立 radiance。工作色域转换和 pre-exposure 保持在最终合成边界。

FieldStore/SignalStore 独立 state CAS 选唯一 slot writer，payload/key 写完后由后续 dispatch 发布可读状态；没有按首 key word 相等共享 writer，也没有跨 workgroup 自旋。SignalStore packet semantic/spill 与 state/generation 分开；touched epoch CAS 使用实际旧值，同一 submitted frame 至多推进一次 age/confidence。HDR spill 每个 packet 有有界精度位置，不在 spill 满时发布半精度 Inf。容量 profile 包含当前最坏 packet/request/owner 字节。

已运行：`npm --prefix OEngine run build:test`；18 项 `surface-cell-plan / surface-field-store / surface-signal-store / surface-batch-consumption / surface-history-binding` 定向测试通过。真实 Chrome 154 GPU fixture 执行独立代表映射 192 次、FieldStore/SignalStore 各四个同前缀完整 key 碰撞、RESERVED→下一 dispatch PUBLISHED、实际 production packet shader 语法与 planner pipeline 编译，以及 production reconstruct 的 E-only、棋盘 albedo×irradiance×细率 AO、direct residual+E、部分覆盖、空 tile（每例 64 像素）；无 GPU validation/page error。报告 `.local/validation/surface-repair-step-one/repair-step-one-browser.json`。

检查期间修复：共享字段 reader 使用 WGSL 保留字 `ref`；GPU fixture AO buffer 不足。修复后只重跑受影响 GPU fixture。最后补正缺失 alpha 的默认值及 FieldStore published gate。

未运行：1080p Showcase、完整 Lighting GPU 出图、连续画质与性能采样；按计划归属步骤 4/5。仍需步骤 2 共享可组合证书、步骤 3 前置完整 value/certificate lookup 与精确失效、步骤 4 full-key request dedup 与实际需求调度；旧 19-word record gate 不是最终 FieldStore 身份，后续替换，不能将本步骤称为整链完成。

## 步骤 2：共享、可组合的 leaf certificate

实现：实际 Appearance graph DAG 发布 per-output input/sample/product/domain 闭包；只保留 live 属性槽，并在同上下文按需计算、复用相同 compiler sample 的 RGBA interval。cheap facts 一次生成 primitive 表。Geometry 与 Field certificate 各按 primitive/quad 生成一次，f32 known/range 窄编码；固定 hierarchy 用 bounded domain masks 合并共享 leaf proof。parent 重新判断字段区间、方向锥、roughness、provider 与相对于自己 plane 的几何残差。删除旧完整候选 graph validator 与 member×previous 去重，未保留备用链。

所有证书、primitive表、mask、field payload、HDR与当前request/owner占用进入现有容量profile，包含总workspace绑定限制与最后batch；没有 node×domain×plane 巨表。diagnostics按workgroup聚合；timing不写detailed证书计数。另修复实际 signed normalTS重复解码、coat normal未变换到world basis、specularColor被强制至少1的接线错误；unlit读取独立baseColor，pure E/empty语义保留，tile coverage从Visibility facts发布而非借用field0覆盖。

已运行：build:test；21项依赖闭包/field specialization/texture bounds/容量/batch定向测试通过。真实Chrome GPU production fixture（含实际publication与Geometry setup）通过：32份geometry + 32份field context服务所有plane/hierarchy，共64次context；普通albedo32次query，ORM场景64次query/96次复用，Denv8×8、字段与Senv4×4、无coat需求。八个独立GPU certificate用例覆盖连续parent、child全安全但parent颜色超预算、child plane到parent anchor转换、unknown局部细化、部分覆盖、parent方向锥拒绝、glossy fine和unknown normal。actual reconstruct/packet fixture六组含unlit通过，GPU validation/page error为零。

初版geometry/field certificate shader冷编译分别约85/91秒；属性槽表重写后普通geometry约2.5秒、field约24秒，ORM field约64秒。这是冷pipeline编译诊断，不是每帧GPU耗时或性能通过。最终步骤仍须量完整Surface总成本。原容量fixture的固定8batch/412MiB断言已改为新profile的独立容量/完整覆盖约束；测试导入新鲜.test-dist，未恢复旧layout。

未运行：独立native地址/appearance全矩阵oracle（当前入口需外部webgpu runtime），完整Lighting生产小链、1080p采样、连续画质；生产小链和实测归属步骤4/5。持久certificate/value hit前置旁路与选择性失效归属步骤3，实际unique miss/dirty producer和scratch最终清理归属步骤4。

## 步骤 3：前置字段/信号查询、有效域和实际依赖版本

实现：便宜地址由 Geometry 的既有 primitive setup/Winner 数学生成，按实际输入闭包发布 UV/有限差分、颜色、world 原始输入与 normal flip stencil，不生成第二份 GeometryRecord。FieldRef/SignalRef 为独立三 word 引用；字段请求用 `(leaf,field)`，完整 20-word identity + 68-word 精确点见证在 getter 中生成，不在生产流为每请求复制宽 key。字段 producer 使用完整不可变 DAG/data 见证的精确 interning；逐字段纹理 revision snapshot 通过 lookup/reserve/publish/resolve 发布不可复用 version ID，hash 仅选集合。无关 publication/camera 不进入 UV-local 字段身份。

ValueHit 与 CertificateHit 独立。已发布且支持域覆盖的证书先填入 leaf bounds；真实 field certificate producer 只求 unresolved 闭包。新增 UV 参数矩形与梯度包络的独立 canonical certificate；边界、未知、多个 chart/world/view 闭包不借用该证书。参数域和屏幕域是不同编译入口，三个有限 family 保留 ORM 同上下文 RGBA 查询复用。grid anchor 在发布处写入 packed map，热读取用公式与有界 loads。

Signal key 按 kind 选择实际 FieldRef 的不可变 producer/version 证明；Store slot/generation 是精确不可变 payload 证明，publication 使用 producer ID/实际字段 numeric version，未使用旧 19-word record digest。72-word key 逐 word 相等；Denv 不绑定颜色/E/AO/direct provider/view epoch，spec/coat/direct 保留真实闭包。太阳读取实际参数与 provider generation。VSM 增加 GPU content version/owner namespace，allocation/dirty atlas 写后由单独 dispatch 发布，未改变时保留版本，耗尽不 wrap。VSM 生产资源版本实际传给 Surface；未用生命周期 generation 代替内容更新。

已运行：切断旧 consumer 前 build:test；18 项字段身份、完整 key、容量与原 field identity oracle 通过。Chrome 154 实际 GPU field lookup 八组、纹理依赖 snapshot 与 RESERVED 拒绝通过；signal lookup 十一组（冷/热、重复 epoch、env/light/实际 GPU shadow/sun/view、compose 变化、所选 roughness Store generation）通过。VSM allocation pipeline 与实际 content-version shader 的初始化、未变、变更、generation、耗尽检查通过，无 GPU validation/page error。报告分别在 `.local/validation/surface-repair-step-three-field-lookup-03/` 与 `surface-repair-step-three-signal-lookup-final/`。

实际 ORM production publication/setup→address→lookup→两种 certificate→classifier 用例通过（`surface-repair-step-three-production-cold-04`）：32 geometry、64 screen field family context、64 parameter family context，共 160 context；128 query/192 reuse；fields/Senv 4×4，Denv 8×8。参数域 family 0/1 冷编译约 56/68 秒，屏幕域约 25/29 秒；这是编译耗时，不是 GPU 帧耗时。早先未拆开的入口及组合 family 达到宿主 300 秒预算，分别记录 cold-02/cold-03 未完成；不写通过。宿主已关闭 HMR 并支持显式有限冷编译等待预算。

最后切断旧 `SurfaceMaterialCachePass`、`SurfaceCacheIdentityPass` 及 Lighting 的 record planner、全容量 pack、旧 pass bindings，保留原完整 BRDF/IBL 数学。切断后的 build:test 如预期报告三处跨步骤缺口：Runtime 尚引用删除的 Material/Identity owner 与已删除 Lighting class。依据计划 §1/§8，这些 consumer/queue 接线由紧接的步骤 4 实现；未恢复旧链或建立适配桥。当前不具备生产出图条件，不以组件结果宣称整链通过。

未运行：1080p Showcase、完整 appearance/lighting/reconstruct 小链、实际 full-key producer dedup、最终计量与生命周期小集；归属步骤 4/5。第三步提交不等于 Phase 7、来源采用或性能验收完成。

## 步骤 4：实际需求、唯一值 producer 与完整消费链

实现：删除 union sample coordinator、sample_map、旧 Geometry hit/replay/source decode、独立 Appearance cache owner/PSO/resource 与六层半精度字段链。请求是共享地址上的 narrow handle；完整字段/信号 key 去重后，只 compact 实际 Geometry、material closure 和 signal dirty groups。hash 弱 CAS 空位失败立即结束 nomination；后续 dispatch 精确恢复 owner，有限表用尽仍保持覆盖和唯一 producer。材质按真实 program/resource set 分组，重叠缺失闭包一次求值，坐标 ancestors 和输入受实际 missing mask 约束，独立 f32 值目的地不按 union record 改源。

GeometryRecord 唯一 producer 只消费 Geometry 地址产品；14 种语义各保留 center/X/Y、完整 RGBA、三套 UV 梯度、world/view 和 handedness。double-sided interval 包含实际朝向翻转；奇异 normal transform 不清除合法 winner 的位置/UV/颜色。Lighting 重接完整 clustered BRDF、VSM、太阳与 IBL；从原 BRDF 中分别发布已计算的 base specular 和 coat，原 attenuation 使用一次，删除旧结果上的重复 coat 分配。Reconstruct 直接解析独立 Publication/Default/Zero/Transient/Store 引用、compose factors 和 TemporalFacts，保留色域/pre-exposure，不执行 PBR 或材质采样。

Field/Signal Store 从 narrow unique request 生成完整 key、f32 payload 和可用 canonical certificate；RESERVED 与 epoch-pinned slot 不复用，不将其他 producer 折叠为同 slot。admit→commit→publish refs 为独立 dispatch，满表维持正确 transient。WebGPU 检查发现 writable storage 与 indirect 不能同 buffer；已独立 GPU-copy 发布 512-byte control + program args，全部 count 来自 GPU，无 CPU work 回读。submitted epoch 使用每次编码的 late binding，避免 cached FrameGraph 固定旧 epoch。batch 消费结束再复用 scratch，诊断最后一 batch 合并实际计数并 readback；timing 不运行详细诊断。容量 ledger 逐项列真实 workspace/setup/720-byte record/field values/signal values/demand/indirect/settings/dependency owners，默认 1080p scratch 82,624,960 bytes，总预留 342,671,808 bytes，单份退休 overlap 单列；不以旧名义 stride 冒充占用。

已运行：OEngine typecheck/build/build:test；25 项字段/信号/plan、capacity、batch、scratch resize/retirement、abort/reconstruct 与 timing 定向测试通过；Showcase BenchmarkMetrics 四项通过。真实 Chrome 154 GPU surface-repair-step-four-demand-03 覆盖六模块编译、实际重复完整 key 唯一 producer、empty/all-hit/one field miss/one signal dirty、满表 pinned transient、70000 的 f32 精度和独立 commit。surface-repair-step-four-compose 的六组 E-only、细率棋盘颜色/AO×irradiance、direct residual+E、部分/空/unlit 数值用例通过。surface-repair-step-four-production-07 真实 publication/setup/address/lookup/certificates/classifier→demand→geometry→compiled Appearance→Stores→Lighting→HDR 通过：冷帧 geometry=4、fields=8、signals=10；热帧全部 heavy work=0；只改 environment 后 geometry=4、fields=0、signals=5；三帧完整且相同 HDR，无 GPU validation/page error。

失败与修复记录保留：production-01 宿主缺少真实 texture allocator；02–04 未及时读取 error scope，覆盖失败；05 定位 storage/indirect 同 buffer 的真实同步域错误；06 修复后 HDR 已正确，诊断宿主重复 getMappedRange 失败；07 修正宿主并覆盖冷/热/provider 更新通过。这些失败不写成通过；冷 certificate family 编译约 62/27 秒属于编译诊断，不是 GPU 帧时间。删除依赖退休 ABI 的旧 demand fixtures，重接独立数字合成用例，没有为旧测试恢复接口。

未运行：本轮 1080p Showcase 截图、30 帧固定 timing、运动/显露/返回；紧接步骤 5。完整 Phase 7 多浏览器、所有材质/Product/形变矩阵和四版本严格性能比较仍未完成，不提升 claims 或来源采用等级。
