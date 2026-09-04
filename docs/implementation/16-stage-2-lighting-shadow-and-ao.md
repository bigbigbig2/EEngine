# Stage 2：不透明光照、阴影与 GTAO

> 状态：`todo`
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

- [ ] S2-01 固定 Light GPU ABI：directional/point/spot 对齐、单位、shadow index；
- [ ] S2-02 GPU 生成 cluster header/index list；
- [ ] S2-03 记录 cluster overflow、链长、像素遍历灯数；
- [ ] S2-04 重写 direct BRDF，处理 roughness、metallic、normal、energy conservation、NaN/Inf；
- [ ] S2-05 Direct-only 输出线性 HDR，不接 GI/SSR/AO/Temporal；
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
