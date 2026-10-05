---
id: next-execution/surface-work-v3-cost-bounded-final-refactor-phase3-implementation-2026-10
state: current
verifies:
  - OEngine/src
---
# Surface V3 Phase 3：Field 候选、验证与有界证明实施记录

**2026-10-05 复审补注**

本页是Phase3当时实现/检查记录；bounded proof受理已实现，但三份dense证书结果与eager地址仍在，不能把前者当成后者已compact。前端物理要求由必需Phase5.5补齐，Phase6不再代为承接。具体责任和成本门槛见[阶段复审与准备](surface-work-v3-cost-bounded-refactor-review-and-readiness-2026-10.md)。历史Surface subtotal保留当时计时分类口径，不覆盖此次发现的pass漏项。


日期：2026-10-04（Asia/Hong_Kong）。基于 2ae78f33；实现对应本轮中文提交。入口：[执行计划 §6](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)、[最终设计 §7–10](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)。本轮完成 Phase 3，并补齐实查发现的 Phase 2 前置缺口；Phase 4–7 未实施。

## 更正此前的阶段判定

2ae78f33 的 Phase 2 收口不足：预留 local 容量后仍依赖八次哈希 reservation，满表可留下无效 SetupRef；排序和 prefix 缺少读完后再写的同步；memo 只有分配/虚假 graph 依赖，没有实际 admission；720B record 仍整块写；新增测试含源码正则，不能证明竞态/数值/覆盖；Phase 1 metadata readback 断言被移除。本轮没有按这些记录继续宣称前置已闭合，而是修复生产链、恢复断言并重新运行真实 GPU 检查。原提交保留在 Git 历史，当前事实以本页及更正后的 Phase 2 记录为准。

## 实际生产切换

### Geometry 前置

- uniform winner 直接分组；mixed tile 以固定 64-key bitonic 网络及 inclusive run prefix 分配 guaranteed local slots。每轮先读取比较/前缀结果，统一 barrier 后写，再 barrier 后进入下一轮；相等 key 以 lane 定序，空 lane 不申请 slot。
- 每个 leaf 发布显式 key/SetupRef，所有直接 reader 按 local tile/lane 读取；旧哈希目录、probe admission 和 consumer 直接完整解码已经删除。facts 的 primitive 等价类直接使用 SetupRef，删除前序 lane 搜索。
- frame memo 独立 528B/entry，四次有界 probe。build 查询前批 Published payload；miss 由 local producer 完整解码。publish 和 commit 为独立 dispatch，后批只能读已提交内容；满 memo 不影响 local 输出。每帧首批 reset；没有空对象 graph resource 或无消费者的 memo 分配。
- 唯一 GeometryRecord 改为同一物理 buffer 中的 128B hot header 与按 input union append 的 cold C/X/Y。14 个语义 kind 保留；三组同源 position/normal/tangent alias 共用物理槽，语义 mask 独立。最坏 11×3×16B cold，加 hot 为 656B/target。Appearance 用实际 cold offset/rank，Lighting 用 hot position/normal/tangent/view，二者均已接通。
- allocation 计算计入显式 refs、memo、hot/cold、proof/control、双 scratch retirement 与双输出；scratch owner 记录实际 active/retired bytes，超过物理配额在新 buffer 创建前拒绝。GPU 完成 fence 后才释放退休资源。

### Field 查询与完整身份

- Field identity 为 9 words：0–6 不变身份，7 专属于 GPU dependency epoch，8 专属于不可变 execution-profile 地址。此前二者共用 word 7 的错误已修复，Signal reader 一并切换；版本更新不会覆盖画像地址。
- publication/default 使用公式 ref；便宜 input、view/dynamic/nonlocal 及本 profile 不支持的复杂 witness 走 DirectTransient，保留完整本批求值。普通 sampled UV、UV normal 及纯 UV 的复杂表达式仍有正式 StableCache；证明不支持不妨碍完整 ExactPoint 复用。
- 候选 hash 只读取 8 个定位字。命中后完整比较 20-word 身份和必要的 6-word UV center/DX/DY；其余 key padding 为零，最大 32 words。静态完整 DAG、参数/纹理/sampler/Product 身份由完整字符串 interning 表示，GPU texture/content epoch 与数值版本单独比较。不能纳入该 profile 的多 chart/world/color witness 不截断，也不使用同一不完整 key 合并 transient requests。
- UV0/UV1 的 logical chart 与完整坐标证明值有效性；其 key 不使用局部 primitive 作为额外值依赖。Meshlet/representation、instance/generation、geometry/generation、side、deformation 等仍保留；UV2 继续 primitive-local。execution token 进入身份，证明/质量策略改变会失效旧支持项。
- FieldStore 从 120×4=480B 改为 64×4=256B/entry；value 在 word 32、bounds 36、domain 44、gradient 48、flags/generation/state/touched 在 56–59。生产 writer、reader、publisher 与数值 fixture 同时切换。

### PendingValidation、证明与失败覆盖

- ExactPoint 仅确认当前值。需要 domain/support 的候选先写 PendingValidation，pin 候选，再由 GPU count 生成独立 indirect；validate 完成后由每 leaf 单一 commit 合并结果，避免多个字段并发覆盖同一 demand/known mask。
- 点值支持与完整 quad certificate 独立判定：value 可复用时仍可能没有共享许可。未受理、Unknown、域外、旧版本、side 不一致及 Reserved entry 均保持完整 miss/细化工作。
- detailed support 从无条件逐 leaf 地址生产移到实际获准的验证队列。地址前置只产出身份与实际所需 point/C/X/Y；验证使用唯一 setup 和原齐次/interval 数学计算真实 quad support，保留分母穿零、舍入、gradient 与截边分支。
- support、Geometry 和全部 Field families 共用 C≤R/2 总账，每 slot 32B。Field 的相同 leaf/context 与等价依赖组共用受理项，不让 ORM 三个 channel 各占一份容量。
- 模板从原始 DAG 计算 bound SSA value、两轴 coordinate derivative 与 RGBA query declaration 的完整 node 成本；每 Field candidate 累计 ≤64 节点、≤4 独立 query。每 query 的 mip/level 选择及 summary payload 访问一起计入 32 visits；punctual risk 最多 8 lights。超限返回完整 Unknown，不能接受截断结果。
- 等价 RGBA texture/Product query 在相同 context 内复用。保留 wrap/filter/halo/LOD、原 interval 关键分支与 f32 outward margin。
- canonical proof 发布实际 UV cell 和梯度 envelope；不会把另一屏幕 footprint 冒充计算域。ExactPublication、ExactPoint、ConstantDomain、BoundedDomain 和 Unknown/Pending 的用途分开。
- BoundedDomain 必须 finite、anchor 在完整值域内，使用半份 cache 容差；空间阶段合并完整 interval，包含 cache anchor，不能再分别花一次完整容差。normal box 的半角和合成 normal/tangent 角度相应收紧，控制整体方向误差。
- Field/Signal hash 满时删除扫描全部先前 request 的回退；未接纳的请求有自己的 transient producer/物理值槽，仍完成全部真实求值。Store owner 四路、有界 CAS，reserve→produce→后续 commit→ref，命中 pin 与 generation 不变量保留。

## 物理账与剩余工作

128MiB binding、1080p 的当前 planner：R=25,536、399 tiles/batch、最大 82 batch；GPU actual ranges 仍裁掉空工作。Workspace=38,926,960B，setup/refs/memo/control=21,929,984B，Geometry product=16,751,616B，Field values=6,128,640B，Signal values=2,451,456B，Demand=24,277,504B。账面 reserve（含 retirement 与双输出）508,657,088B，未把 Renderer 共用的 GPU Scene/资产输入当作 Surface 私有产品。

这不是 R=65,536 的最终完成声明。当前共享 Workspace 的地址/leaf certificate 输出布局及 arbitrary classifier 仍由真实读者使用；Phase 4 将切固定空间树，Phase 5 切 worker/source/Signal 合同，Phase 6 收口 payload clear、编码/绑定与生命周期。当前没有恢复旧 renderer 或建立桥梁。

## 实际验证

源码身份为 `2ae78f33888510d06527c53c05f18c62df4e73c4` 加本轮工作树改动；Showcase 报告保存 dirty 清单、source diff 与 fingerprints。文档同步在 GPU 检查之后，未改动已验证的生产源码。所有下列运行 exit 0；没有把归档 WGSL 或旧 `.test-dist` 当作本阶段证据。

复现入口（仓库根目录，GPU fixture 串行运行）：

```powershell
npm --prefix OEngine run typecheck
npm --prefix OEngine run build
npm --prefix OEngine run build:test
$phase3Tests = @(
  'surface-cell-plan', 'surface-frame-resources', 'surface-geometry-phase2',
  'surface-batch-consumption', 'surface-field-store', 'surface-execution-profile',
  'surface-optimization-capacity', 'surface-field-publication',
  'surface-field-dependency-profile', 'surface-bound-specialization',
  'geometry-surface-publication'
) | ForEach-Object { "OEngine/tests/contract/$_.test.mjs" }
node --test @phase3Tests OEngine/tests/oracle/appearance-field-identity.test.mjs
$phase3Fixtures = @('phase3-geometry', 'phase3-record', 'repair-field-lookup', 'phase3-proof', 'phase3-production')
foreach ($fixture in $phase3Fixtures) {
  node validation/labs/surface-optimization-v1/run-production-cell-browser.mjs $fixture ".local/validation/surface-phase3-recheck-$fixture" 60
  if ($LASTEXITCODE -ne 0) { throw "GPU fixture failed: $fixture" }
}
node validation/labs/surface-optimization-v1/run-phase1-showcase-smoke.mjs .local/validation/surface-phase3-showcase-recheck
```

- typecheck、production build、build:test：exit 0；使用本轮新鲜 .test-dist。
- 12 个 targeted 文件，45 项 contract/semantic/oracle tests：通过；之后受影响的 11 项检查重跑通过。Phase 2 的源码正则完成证明已删除，新增实际 physical alias/retirement 检查。
- phase3-geometry：真实 setup→refs→memo→后批消费。64 个不同 winner 得到 64 个合法 local slots；warm memo 51 hits/13 decodes；强制满 memo 0 hits/64 decodes/64 rejected admission，输出完整；uniform 与 mixed partial 均通过。
- phase3-record：真实 hot/cold producer→同一生产 reader，3 records、14 semantic kinds×C/X/Y；包含 normal/tangent 非线性与邻点翻面，最大误差 9.556957947e-8。
- repair-field-lookup：真实 bounded candidate、PendingValidation、独立 commit、Store publication 及 GPU dependency-version producer；冷 miss、Reserved 拒绝、warm/域外、proof full、局部纹理变化、跨点 bounded/constant 值与 side 失效全部通过。最后补查分别断言 BoundedDomain=4、ConstantDomain=3，并重跑通过；画像地址在版本更新后保持不变。
- phase3-proof：真实 decoded TextureVariation hierarchy；局部 query Known，mip/level/payload 总 visits=32 时返回 Unknown，旧 texture revision 被拒绝；无截断接受。
- phase3-production：26 个实际生成 modules 编译无错误；真实 publication/version→coverage→setup→lookup/proof→demand→Geometry→Appearance→Lighting→publish→reconstruct。sparse、empty、moved、warm 四帧所有 HDR 写域完整；warm 读到 16 个真实 Store hits；所有 families 总账不超过 64（R=128）。最后删除 primitive 前序搜索后重跑通过。
- Showcase final：Chrome154 / GTX1650Ti / 1080p overview，AO/FSR3/Bloom 开，VSM/jitter 关；3 timing + 1 detailed；两份 capture complete，coverage=pass，sourceDrift=false，GPU/API/device loss 错误为零。

本机诊断：.local/validation/surface-phase3-production-setupref-final、surface-phase3-geometry、surface-phase3-record、surface-phase3-field-final、surface-phase3-proof-verified、surface-phase3-showcase-final。不是正式 evidence，也未提交生成 WGSL、图片和报告。

第一次 Showcase detailed 在诊断 reader 的旧 45-vector stride 判定失败；修为新 ABI 和 schema 4 后重跑通过。其他编译/数值 fixture 失败均在本阶段修复，不放松检查。恢复的 metadata readback 断言全程保留。

## 性能与验收边界

最终短诊断 GPU pass sum P50=569.002336ms，Surface pass sum P50=434.887776ms，frame span P50=645.216480ms，CPU P50=108.430ms；仅 3 samples。此前同轮另一份成功短诊断约 490ms/367ms，说明不能用几次小样本宣称固定收益；正式同条件历史性能比较尚未运行。最终性能尚未验收，不以该阶段短诊断判断最终目标或收益；当时两份 classifier、lookup 与调度仍是后继任务。

未运行完整跨浏览器、resize/cut/device loss、所有 skin/morph/材质/provider 组合、连续质量及 V1/V2 同条件正式比较；这些属于 Phase 7。当前截图仍有历史版本也可见的黑斑，不把短 smoke 推广为画质验收。完整来源 adoption 和 claims 未提升。
