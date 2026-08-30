# R5 人工测试与验收手册

本文是 `08-lighting-temporal-post.md` 的人工执行 companion。每个 FX 合入前至少完成对应的自动测试、production build、相关 WebGPU 页面和人工结果检查；每个子 Gate（G5-L/G5-S/G5-T/G5-P）再升级为 clean/full 证据。

## 0. 通用预检

Windows CMD：

```bat
cd /d D:\code\EEngine\OEngine
set NODE_OPTIONS=
npm test
npm run audit:shaders

cd ..\examples
npm run build
npm run dev:host
```

PowerShell：

```powershell
Set-Location D:\code\EEngine\OEngine
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
npm test
npm run audit:shaders

Set-Location ..\examples
npm run build
npm run dev:host
```

自动测试必须 `exit code 0`。`audit:shaders` 必须写出 `OEngine/benchmarks/shader-source-audit.json`；任何新增 `dead/unknown` realtime shader 都需要在当前 FX 解释 owner 或 generator。

## 1. 每次人工采集必须保存

建议目录：

```text
temp/r5/<gate-or-fx>/<commit>/
├─ environment.txt
├─ console.txt
├─ result.json
├─ graph.json
├─ counters.json
├─ screenshot-*.png
└─ sequence-notes.md
```

`environment.txt` 至少记录：

```text
git rev-parse HEAD
git status --porcelain
OS
Chrome/Chromium version
GPU adapter description
WebGPU features/limits
canvas resolution
internal resolution
DPR
feature set
warmup/sample/counter cadence
```

阶段 Gate 的性能采集统一使用：
- 历史可比 profile：`1280×720`, DPR 1；
- 产品质量 profile：`1920×1080 output`，internal scale 由对应 Temporal case 指定；
- `60` warm-up + `180` sample frames；
- GPU timestamp/counter 每 `6` 帧采样；
- profiler-off run 用于最终总时间，sampled profiler run 用于 phase 定位；
- 必须保存 P50/P95/P99，不能只保存平均 FPS。

出现以下任意条件，本轮 Gate 直接失败：

```text
WebGPU validation error > 0
uncaptured error > 0
device lost > 0
queue overflow 未触发明确 fallback
invalid VisibilityKey > 0
feature-off 仍存在该 feature 的 pass/resource/history
dirty=true 却声明 clean Gate
```

---

# R5-00 · Contract / Baseline Freeze

## 自动测试预期

新增或扩展测试应覆盖：
- Surface ABI format/semantic；
- velocity 坐标与 invalid/reactive bit；
- benchmark base manifest 不再把 optional `software-visibility` 写成实际 feature；
- feature/capability evidence 对 R5 base feature 可解释；
- FrameGraph feature-off assertions。

建议测试文件：

```text
OEngine/tests/r5-surface-contract.test.mjs
OEngine/tests/benchmark-scene-manifest.test.mjs
OEngine/tests/benchmark-evidence-gate.test.mjs
OEngine/tests/framegraph-compiled.test.mjs
```

期望：全部 PASS。

## 人工测试

1. 打开 Benchmark B、C。
2. 确认实际 featureSet 是 HW-only R5 base，不包含尚未运行的 R4-C software/hybrid。
3. 关闭 Shadow/Transparency/TAA/AO/SSR/Bloom/Exposure 等 R5 feature，只保留 Packed Visibility + Single Material Resolve + Background。
4. 连续运行至少 240 帧。

预期：
- 一个 steady main submit；
- graph warm 后 build/compile 为 0；
- `invalidVisibilityKeys=0`；
- `queueOverflowMask=0`；
- console/WebGPU diagnostics 为 0；
- feature-off 的 pass/resource/history 不存在；
- Surface debug 能区分 empty / valid / unlit / reactive / motion-invalid。

保存：B/C `result.json`、graph dump、Surface debug 截图。

---

# FX-01 · Surface Debug + Background / G5-L 前置

## 自动测试用例

至少覆盖：
- empty Visibility → background，不读随机 Surface；
- metallic/roughness decode；
- normal decode 后单位长度；
- emissive 与 unlit；
- velocity valid/invalid；
- reactive flag exact；
- reverse-Z depth empty sentinel。

建议 `r5-surface-contract.test.mjs` 使用固定 packed bytes 做 TS decode oracle；WGSL micro fixture 对同一像素输出 readback。

## 人工场景

使用单个 2×3 材质板：
1. dielectric rough；
2. dielectric smooth；
3. metallic rough；
4. metallic smooth；
5. emissive；
6. unlit。

另留至少 25% 背景区域。

依次打开 debug：
`Depth / Normal / PBR / AlbedoAO / Emissive / Velocity / Reactive / SurfaceFlags`。

预期：
- background 不出现 NaN/随机颜色；
- normal 连续且方向正确；
- metallic/roughness 板位置与输入一致；
- emissive/unlit 不受 direct light 开关影响；
- 静态物体 velocity 为 0；
- motion-invalid 输出 zero velocity + invalid flag；
- 所有 debug pass feature-off 后从 graph 消失。

---

# FX-02 · Clustered Direct Lighting / G5-L

## 必须先实现的 correctness contract

Light list 不得只有一个 raw atomic count。必须可区分：

```text
attempted
written
capacity
overflow
```

所有 consumer 只遍历 `written`。Per-cluster point/spot 上限溢出必须设置显式 overflow，并走 conservative fallback；禁止 `continue` 后静默丢灯。

## 自动测试

CPU/reference：
- inverse-square attenuation；
- point radius/cutoff；
- spot cone/penumbra；
- cluster grid index/depth slice；
- light-vs-cluster intersection；
- attempted/written clamp；
- overflow flag/fallback。

WebGPU micro：
- 0/1 directional；
- 1 point；
- 1 spot；
- list capacity 恰好等于、少 1、多 1；
- 单 cluster 超过 128 point 或 spot；
- GPU result 与 CPU conservative set 比较。

期望：
- 无 overflow 时 GPU cluster light set == CPU reference；
- overflow 时画面不能缺灯，counter/fallback 必须非零；
- buffer 无 OOB。

## 人工/性能 sweep

`C-light`：
- local lights：0 / 1 / 16 / 64 / 256 / 1024；
- 两种布局：`spread` 与 `overlap`（全部覆盖中心 cluster）。

每档保存：
- active/tested/written lights；
- average/P95/max lights per cluster；
- overflow clusters；
- fallback lights；
- cluster-build GPU P50/P95/P99；
- direct-lighting GPU P50/P95/P99。

预期：
- 0 light = 只有环境/背景，无随机 direct contribution；
- overlap pressure 可以触发 overflow test，但不能静默少灯；
- unrelated B baseline P50/P95 不超过已冻结回归阈值。

---

# FX-03 · IBL Alignment / G5-L

## Reference fixture

建立 `B-shading-oracle`：单个固定 Damaged Helmet、固定 LOD/pose/camera、同一线性 HDR environment、固定 exposure，关闭 hierarchy variation、Shadow、AO、SSR、Temporal、Bloom。

Reference environment 若上游格式 runtime 不支持，允许在 benchmark 准备阶段离线转换成冻结的 linear HDR asset，但必须记录 source hash、转换工具/版本和 result hash。

## 自动/数值测试

至少验证：
- environment orientation；
- diffuse irradiance；
- specular prefilter roughness → mip mapping；
- BRDF LUT 范围；
- metallic 0/1；
- roughness 0/0.5/1；
- normal/tangent orientation；
- emissive；
- exposure 前 linear HDR。

期望：先在线性 HDR 对比，tonemap screenshot 只能作为第二层证据。

## 人工测试

保存：
- baseColor；
- normal；
- roughness/metallic；
- diffuse IBL；
- specular IBL；
- final linear HDR；
- final tonemapped。

G5-L 退出前必须：
- FX01/02/03 全部通过；
- B-shading-oracle 无 blocker；
- C-light sweep 无 silent overflow；
- Lighting source-of-truth 不再依赖未登记的 `lighting_ch_oracle.ts`。

---

# FX-04 · Packed CSM Shadow / G5-S

## 架构预期

Caster selection：

```text
Packed Instance
→ Cluster hierarchy
→ per-cascade ShadowRasterWork
→ GPU indirect draw
→ shadow atlas
```

不得恢复 CPU final visible list，也不得继续依赖 legacy `MeshletDrawList` 作为 Packed caster producer。

## 自动测试

- cascade split 单调；
- cascade camera/frustum bounds；
- shadow RasterWork capacity/overflow；
- alpha-tested caster；
- front/double-sided contract；
- atlas allocation/reuse/retirement；
- feature-off 不创建 caster work/atlas update；
- camera cut/resize 不采样无效 shadow history。

## 人工 sequence

1. 静态 directional light，相机每帧移动小于 1 shadow texel，连续 120 帧；
2. 横穿 cascade boundary；
3. alpha foliage/cutout caster；
4. atlas pressure；
5. shadow off→on。

预期：
- sub-texel camera motion 不产生明显 cascade shimmering；
- cascade boundary 无突跳/漏阴影；
- alpha silhouette 与 main Visibility 一致；
- atlas 满时执行明确降级，不覆盖仍被采样 tile；
- off 时 shadow work/timestamp/resource 为 0/不存在。

性能保存：
`shadow-work-generation / shadow-raster / shadow-update`，并按 cascade 分列。

---

# FX-05 · Packed Transparency / MBOIT / G5-S

当前算法按 Moment-Based OIT 验收，不使用不存在的 A-buffer node pool 作为容量模型。

## 架构预期

```text
Hierarchy selection
→ RasterWork expansion
→ alphaMode classification
   ├─ OPAQUE/MASK → Visibility
   └─ BLEND → TransparentRasterWork
                 → bounded raster-state bins
                 → MBOIT moments
                 → transparent forward
                 → composite
```

透明材质继续读取同一 Geometry/Instance/Material/Texture owner。draw count 只能依赖有硬上限的 raster-state bin，不得随 active material 数线性增长。

## 自动测试

最小 fixture：2/3/4 个不同颜色、不同 alpha 的重叠 quad。
- CPU back-to-front sorted alpha 作为质量 reference；
- 改变提交顺序，MBOIT 输出应保持 order-independent；
- moment precision/range 检查 finite；
- transparent queue attempted/written/capacity/overflow；
- BLEND 不写 opaque Visibility/depth；
- transparent reactive/velocity contract。

## 人工/性能 sweep

`C-transparent`：
- coverage：0 / 10 / 50%；
- depth layers：1 / 4 / 8 / 16；
- active materials：1 / 8 / 64。

保存：
- TransparentRasterWork；
- submitted triangles；
- moment/forward/composite GPU time；
- transient bytes；
- raster-state bin/draw count；
- reactive pixels。

预期：
- active materials 1→64 时 draw count 不线性增长；
- overflow 明确；
- 不出现 NaN/Inf；
- order 变化不改变结果超过冻结 tolerance。

G5-S 退出：FX04/05 全部通过，Packed Shadow/Transparency 不再依赖 legacy MeshletDrawList/Material per-loop producer。

---

# FX-06 · Temporal Reconstruction / DRS / Upscaling / G5-T

## Source-of-truth 前置

开始修改 Temporal 算法前，必须先替换或登记 `temporal_post_legacy.generated.ts` 的可重复 generator/source。不能继续扩展无 provenance 的 generated runtime shader。

## Temporal input contract

至少包含：

```text
current HDR
depth
velocity + motion-valid
reactive
disocclusion/history confidence
history color
history validity/revision
jitter
internal/output resolution
exposure/pre-exposure（若算法需要）
```

## 自动测试

- reprojection coordinate；
- velocity convention；
- camera cut invalidation；
- resize/internal scale invalidation；
- feature off→on；
- reactive exact rejection/weight reduction；
- motion-invalid；
- history resource generation/reuse；
- DRS 不进行同步 map/readback。

## 人工 sequence

固定每段 120–240 帧：
1. static；
2. slow pan；
3. fast pan；
4. moving object；
5. disocclusion；
6. alpha/transparent motion；
7. LOD transition；
8. camera cut；
9. resize；
10. render scale 1.0→0.67→1.0。

记录：
- reactive pixels；
- history reject %；
- disoccluded pixels；
- TAA/TAAU GPU ms；
- history bytes；
- internal/output pixels；
- settling frames；
- ghost trail notes/screenshots。

预期：
- camera cut/resize 后第一帧不采样旧尺寸/旧 camera history；
- reactive/transparent trailing 不出现持续 ghost；
- static 序列 variance 应低于 no-temporal；
- DRS 使用延迟 GPU timestamp feedback，不引入第二 submit/readback stall。

`C-resolution`：internal scale 1.0 / 0.85 / 0.67 / 0.5，报告 `ms/output MP` 与 `ms/internal MP`。

---

# FX-07 · AO / G5-T

默认先验证现有 SSAO；只有质量/性能不达标才评估 XeGTAO 等替换。

测试：
- flat plane：无遮挡区域接近无 AO；
- corner/crevice：AO 增强；
- near/far depth；
- half/full resolution；
- temporal off/on；
- camera pan/disocclusion；
- feature off graph/resource/history 为零。

保存：
AO raw、denoise/temporal、final HDR，GPU phase 与 history bytes。

---

# FX-08 · SSR / G5-T

测试：
- mirror plane + 可见反射物；
- screen miss；
- roughness 0 / 0.5 / 1；
- offscreen target；
- camera pan/disocclusion；
- feature off；
- miss 必须 fallback 到 IBL/声明的 environment，不输出随机黑洞。

保存：
SSR hit/miss debug、roughness、history confidence、trace/denoise/composite GPU time。

G5-T 退出：FX06/07/08 sequence 全通过，Temporal source ownership 闭合，resize/cut/scale 无错误 history。

---

# FX-09 · Exposure / Bloom / Tonemap / Motion Blur / Sharpen / G5-P

测试顺序必须固定：

```text
linear HDR
→ exposure
→ bloom/composite
→ temporal-dependent post（按 contract）
→ tonemap
→ output transform
```

用例：
- exposure step：暗→亮、亮→暗；
- 单 HDR impulse：检查 bloom 半径/能量；
- SDR output；
- HDR-capable output（能力存在时）；
- invalid velocity + Motion Blur；
- sharpen off/on；
- 每个 feature off graph pruning。

预期：
- 无 double exposure；
- SDR/HDR color transform 明确；
- invalid velocity 不产生长 blur streak；
- 关闭 feature 后无 owner/history/pass。

---

# FX-10 · Optional Project Effects

LPV/Brick4/NSS/SDF/volumetrics 等逐个作为独立 feature node 验收。

每项至少：
- source-of-truth/provenance；
- inputs/outputs；
- off-state graph；
- GPU time/memory；
- 与 R5 core disabled 时完全不影响 G5。

未完成的 optional effect 不阻塞 R5。

---

# FX-11 · Fusion Experiments

只有 profiler 证明 bandwidth/pass overhead 是热点才允许。

每次实验必须同时保存：
- independent implementation；
- fused implementation；
- 相同输入输出 semantic；
- same-device paired performance；
- feature-off behavior；
- screenshot/numeric equivalence。

没有明确 P50/P95 收益则 reject，不为了“pass 更少”合入。

---

# FX-12 · Legacy Deletion / G5-P

建议检查：

```bat
cd /d D:\code\EEngine
git grep -n "MeshletDrawList"
git grep -n "MaterialExpandPass"
git grep -n "VelocityPass"
git grep -n "lighting_ch_oracle"
git grep -n "temporal_post_legacy.generated"
```

只有确认 remaining consumer 属于明确 legacy/public compatibility 或 tool/reference，才能删除；不能靠文件名猜 dead。

最后运行：

```bat
cd OEngine
set NODE_OPTIONS=
npm test
npm run audit:shaders

cd ..\examples
npm run build
```

G5-P 目标：
- realtime shader `dead=0`；
- realtime `unknown=0`，或剩余项都有 generator/tool-only/reference-only 明确分类；
- Packed core 不再经过 legacy Material/Visibility/Shadow/Transparency work producer；
- feature-off exact；
- clean/full A/B/C + R5 axis sweeps；
- performance-targets 已填写目标机器绝对门槛。

---

# 最终交给复核者的材料

每完成一个 FX，可以把以下内容发给代码审查者/ChatGPT：

```text
1. commit SHA
2. git diff / GitHub commit URL
3. npm test 最后一段（通过数 + exit code）
4. audit:shaders 输出
5. examples build 输出
6. 浏览器 console / WebGPU diagnostics
7. result.json / counters.json
8. 关键 screenshot
9. sequence-notes.md
10. 如果是性能任务：before/after 或 on/off 同机 P50/P95/P99
```

不要只发 FPS 或一张“看起来正常”的截图。
