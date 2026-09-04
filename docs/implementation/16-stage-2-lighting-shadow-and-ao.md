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
- [ ] S2-04 重写 direct BRDF，处理 roughness、metallic、normal、energy conservation、NaN/Inf；
- [x] S2-05 Direct-only 输出线性 HDR，不接 GI/SSR/AO/Temporal；`LightingFeature` 现在返回 `DirectLightingFrame`（仅边界接入，尚未代表算法完成）；
- [ ] S2-06 通过 direct-only screenshot、numeric oracle 和 timestamp Gate。

### 2B Shadow

- [ ] S2-07 收拢 CSM、spot atlas、point atlas、contact shadow；
- [ ] S2-08 固定 cascade split、stabilization、bias、normal offset、PCF/filter；
- [ ] S2-09 Shadow Service 只输出 visibility，不写最终颜色；
- [ ] S2-10 验证 shadow cache、dirty propagation、atlas capacity 和 fallback。

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
- 公开类型从 `OEngine/src/index.ts` 导出，P4 owner 测试同步检查新 seam。

当前仍未完成：Filament 数值对照、Direct-only screenshot/numeric/timestamp Gate、Shadow 和 GTAO。
早期阶段截图不作为本切片的阻塞条件；Stage 2 的 Direct-only 算法 Gate 仍必须在 S2-06 独立关闭。

### 6.1 Stage 2A ABI/cluster 切片

- 新增 `LightClusterFrame` immutable 产品，固定 `parameters/lookup/data`、candidate/active list、counter
  资源以及 `32×32×24` cluster layout；
- `LightClusterPass` 返回该产品，LightingFeature 仅消费产品字段，不向 Renderer 泄漏 list/lookup 的构造细节；
- 该切片复用已登记的 FX-02 clustered-lighting 论文/Filament numeric ledger，不复制外部表达性代码；
- direct shader 尚未改写，当前切片只完成 ABI、GPU producer→consumer seam 和统计可观测性冻结。
