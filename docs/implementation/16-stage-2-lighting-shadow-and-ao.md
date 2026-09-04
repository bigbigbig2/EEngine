# Stage 2：不透明光照、阴影与 GTAO

> 状态：`doing`
>
> 这是第一個真实算法重构阶段。必须先完成 Direct-only，再接入 AO；不要在基础光照未稳定时修 SSR/TAA。

## 1. 目标

建立单一 Opaque Lighting 深模块：

```text
SurfaceFrame
 + LightClusterFrame
 + ShadowVisibilityFrame
 + EnvironmentFrame
 + AmbientOcclusionFrame
 → OpaqueLightingFrame
```

Renderer 不再知道 Direct、IBL Diffuse、IBL Specular、Background、Indirect Composite 的内部 Pass。

## 2. 主要源码 owner

| 当前实现 | Stage 2 动作 |
|---|---|
| `LightingFeature.ts` | 收敛为深模块入口，不再只是转发器 |
| `LightClusterPass.ts` | 重写/验证 cluster producer |
| `LightingPass.ts` | 重写 direct BRDF 与 HDR composition |
| `ShadowService`、`PackedCsmShadowPass` | 收拢 shadow visibility |
| `ScreenSpaceAmbientOcclusionPass.ts`、`ssao.ts` | GTAO 2.0 候选实现 |
| `OpaqueLightingPipeline.ts`、`IndirectCompositePass.ts` | 迁移 consumer 后删除 |

## 3. 开源参考与采用规则

- Filament：PBR/IBL 数值不变量、光单位、split-sum 语义；按已登记 commit 做局部移植或规格重实现；
- The Forge/Filament：CSM split、stabilization、bias、filter 语义；
- XeGTAO：采样、linear/view depth、temporal 和 bilateral resolve 候选；
- clustered shading 论文与现有 R5 ledger：cluster ABI 和 overflow 统计。

每个选择必须进入 `docs/references/porting/`，不能仅写“参考某项目”。

## 4. 执行顺序

### 2A Direct-only

- [x] S2-01 固定 Light GPU ABI：directional/point/spot 对齐、单位、shadow index；现有 `LightDatabase`/cluster ABI 已冻结，并由 `LightClusterFrame` 暴露固定 producer/consumer 产品；
- [x] S2-02 GPU 生成 cluster header/index list；`LightClusterPass` 保持 candidate → HZB filtered → cluster lookup/data 的 GPU 闭环；
- [x] S2-03 记录 cluster overflow、链长、像素遍历灯数；FX-02 stats producer 已接入 counters，空灯光走零成本 fast path；
- [x] S2-04 重写 direct BRDF，处理 roughness、metallic、normal、energy conservation、NaN/Inf；本轮修正 Fresnel 与 direct energy split，并加入有限值保护；
- [x] S2-05 Direct-only 输出线性 HDR，不接 GI/SSR/AO/Temporal；`LightingFeature` 现在返回 `DirectLightingFrame`（仅边界接入，尚未代表算法完成）；
- [x] S2-06 FX-02 full direct/cluster Gate 与 CPU PBR numeric oracle 已通过；按用户明确指示跳过 clean/timestamp Gate，保留 dirty exploratory artifact 作为当前基线，不将其描述为 clean 性能证据。

### 2B Shadow

- [~] S2-07 收拢 CSM、spot atlas、point atlas、contact shadow；CSM/spot/point atlas 已统一到 ShadowContext，contact visibility producer 尚未接入；
- [x] S2-08 固定 cascade split、stabilization、bias、normal offset、PCF/filter；参数已冻结到 `ShadowContract.ts` 并由 Packed CSM/direct shader 共用；
- [x] S2-09 Shadow Service 只输出 visibility，不写最终颜色；`ShadowVisibilityFrame` 已成为 LightingFeature 的唯一阴影输入；
- [~] S2-10 验证 shadow cache、dirty propagation、atlas capacity 和 fallback；已有 FX-04 计数与生命周期测试，Stage 2B 专用 cache/pressure 证据待补。

### 2C GTAO

- [ ] S2-11 radius/falloff 统一使用 PhysicalScaleContract；
- [ ] S2-12 raw sampling 使用 linear/view depth 和适当 HZB mip；
- [ ] S2-13 默认 half-resolution；
- [ ] S2-14 temporal blend 消费 velocity、history confidence、validity；
- [ ] S2-15 joint bilateral upsample 同时处理 visibility 和 bent normal；
- [ ] S2-16 输出独立 `AmbientOcclusionFrame`，禁止写回 Surface；
- [ ] S2-17 对当前 GTAO 与 XeGTAO 做 A/B，完成 adopt/port/reimplement/reject 决策。

### 2D 删除

- [ ] S2-18 迁移 Renderer 的 direct/IBL/indirect 分支到单一 OpaqueLighting interface；
- [ ] S2-19 删除 `IndirectCompositePass`、重复 IBL composite 和旧 direct owner；
- [ ] S2-20 删除 GTAO alpha-min composite、nearest bent-normal upsample 和 dead uniforms。

## 5. 退出 Gate

- Direct-only、Direct+Shadow、Direct+Shadow+AO 三组都通过；
- PBR 数值与 CPU reference 在容差内；
- CSM/Atlas/Contact 的 tile、overflow、dirty、fallback 可观测；
- AO 0.1x/1x/10x scale、pan、disocclusion 通过；
- Opaque HDR 的组成顺序只有一个 owner；
- GPU timestamp 和显存没有无法解释的回归。

## 6. 状态记录

```text
状态：todo | doing | focused Gate | 产品闭环
算法决策：adopt | port | reimplement | reject
上游 ledger：
Direct-only artifact：
Shadow artifact：
AO artifact：
删除的旧 consumer：
未解决问题：
```

## 6. 2026-09-04 执行记录（Stage 2A 首个切片）

本轮开始 Stage 2，不新增第二套管线，也不先改 AO/SSR/TAA。先把 Direct-only 的产品边界从
`LightingFeature` 中明确出来：`LightClusterPass → LightingPass → DirectLightingFrame`。新的
`DirectLightingFrame` 只承载 `internal-full` 线性 HDR 和 domain，不携带 GI、AO 或 temporal
资源，避免 Renderer 把“direct 已运行”误认为“完整 OpaqueLightingFrame 已完成”。

已修改：

- `FrameProducts.ts` 新增 immutable `DirectLightingFrame` 与 `directLightingFrame()` 校验；
- `LightingFeature` 将 `LightingPass` 的结果包装为 `direct` 产品；
- `Renderer` 消费 `lightingFeatureOutput.direct.hdr`，不再读取裸 `hdr` 字段；
- P4 owner 测试同步检查新 seam。

当前仍未完成：Direct-only 专用 screenshot/clean timestamp Gate、Shadow 和 GTAO。
早期阶段截图不作为本切片的阻塞条件；Stage 2 的 Direct-only 算法 Gate 仍必须在 S2-06 独立关闭。

### 6.1 Stage 2A ABI/cluster 切片

- 新增 `LightClusterFrame` immutable 产品，固定 `parameters/lookup/data`、candidate/active list、counter
  资源以及 `32×32×24` cluster layout；
- `LightClusterPass` 返回该产品，LightingFeature 仅消费产品字段，不向 Renderer 泄漏 list/lookup 的构造细节；
- 该切片复用已登记的 FX-02 clustered-lighting 论文/Filament numeric ledger，不复制外部表达性代码；
- direct shader 已完成首轮 BRDF 修正，独立 CPU numeric oracle 已建立，Stage 2A 产品 Gate 仍待 clean/timestamp 对照。

### 6.2 Direct BRDF 修正与 FX-02 验证

`lighting_direct.ts` 的 Fresnel helper 已从错误的四次方 `(F90 - cosine)` 插值改为 Filament
语义的 Schlick 五次方 `F0 + (F90 - F0) * (1 - cos)^5`。direct diffuse 现在按同一 Fresnel
响应做能量分配，并在累加前拒绝 NaN/Inf contribution。没有复制 Filament 表达性源码，差异和
保留不变量登记在 [R5-FX02 porting ledger](../references/porting/R5-FX02-clustered-direct-lighting.md)。

FX-02 full（dirty exploratory artifact）结果：

```text
artifact: temp/r5/fx-02/7127427cab7fed462f076a1345036e17bcb3eb2d-dirty-d97a52c3c1df/full/
passed: true
issues: []
diagnostics: validation=0, uncaptured=0, deviceLost=0
coverage: point 0/1/16/64/256/1024, spot, directional, dynamic same graph
directLightingGpuMs: 0.03 ms (zero-light) → 18.55 ms P50 (1024 overlap)
```

该结果证明真实 shader 与 GPU producer/consumer 闭环仍可执行。按用户明确指示，本轮跳过
clean/full timestamp 对照并关闭 S2-06；该例外不改变后续产品性能 Gate 的要求。

### 6.3 Stage 2B Shadow：visibility 产品 seam

本轮开始 Shadow，不新增第二套管线，也不把 shadow atlas 当成 HDR/color owner：

- `FrameProducts.ts` 新增不可变 `ShadowVisibilityFrame`，固定 atlas、可选 contact visibility、CSM 数量、PCF、normal offset、depth bias、slope scale 与 atlas 尺寸；
- `LightingFeature` 改为消费 `ShadowVisibilityFrame`，禁止继续接收裸 `shadowAtlas` 字段；
- `Renderer` 在 shadow-update 完成后创建 visibility 产品，LightingPass 只读取 `shadow.atlas`；Shadow Service/ShadowContext 仍负责 atlas 写入，绝不写最终 HDR；
- 新增 `ShadowContract.ts`，冻结 3 级 CSM、PCF kernel、normal offset、depth bias 和 slope scale，Packed CSM pipeline 与 direct shader 共用同一常量；
- CSM 的 practical split、texel snapping、Packed hierarchy producer、spot/point atlas 与现有 shadow counters 继续复用已登记的 FX-04 实现；contact visibility 目前明确为 `null`，不得冒充已实现。

当前 2B 状态：S2-07 `[~]`、S2-08 `[x]`、S2-09 `[x]`、S2-10 `[~]`。尚未完成的是 contact-shadow producer、Shadow cache/dirty/atlas-pressure 的新增专用验证和 Direct+Shadow browser evidence。

验证记录：在未包含本轮改动的 `d653351` clean worktree 中运行 FX-04（1280×720、DPR 1、CSM on/off/on），
结果仍为 `passed=false`，`gateEligible=true`，`issues=[one or more CSM cascades produced no RasterWork, material-patched CastsShadow instances stopped producing ShadowRasterWork]`；
采样 cascade RasterWork 为 `[0, 684, 720]`，overflow 为 `0`，feature-off atlas bytes 为 `0`，submit mean 为 `1`。
这确认 cascade 0 空工作是 Stage 2B 进入前的既有算法 blocker，不是本轮 `ShadowVisibilityFrame` seam 引入的回归；本轮不伪造 Shadow Gate 通过。
