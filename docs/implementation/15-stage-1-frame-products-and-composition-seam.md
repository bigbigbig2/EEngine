# Stage 1：Surface、Opaque HDR 与组合 Seam

> 状态：`doing`
>
> 本阶段的核心不是新增 Feature，而是把 `SurfaceFrame → OpaqueLightingFrame` 变成一个有深度的模块 seam，让复杂实现集中在 owner 内部。

## 1. 目标

- 冻结 immutable frame products；
- 统一 resolution domain 和 physical scale；
- 让 Renderer 只组合产品，不解释具体 texture、Pass 或 shader；
- 消除 Renderer 中三段 GI/SSR/IBL 手工拼接的接口泄漏。

## 2. 目标 interface

```ts
interface SurfaceFrame {
  readonly depth: ResourceId;
  readonly pbr: ResourceId;
  readonly normal: ResourceId;
  readonly albedoAo: ResourceId;
  readonly emissive: ResourceId;
  readonly velocity: ResourceId | null;
  readonly metadata: ResourceId | null;
  readonly domain: TextureDomain & { readonly domain: "internal-full" };
}

interface OpaqueLightingFrame {
  readonly hdr: ResourceId;
  readonly iblSpecular: ResourceId | null;
  readonly domain: TextureDomain & { readonly domain: "internal-full" };
}
```

Interface 还包括 ordering、缺失资源语义、错误模式、history 依赖和 GPU 成本；不是只有 TypeScript 字段。

## 3. 执行任务

- [x] S1-01 检查 `FrameProducts.ts` 的资源 id、domain 和 immutable 语义；
- [x] S1-02 检查 `PackedMaterialResolvePass` 是否是 Packed Surface 唯一 producer；
- [x] S1-03 明确普通 Scene legacy 的迁移范围，不提前删除有 consumer 的 `MaterialExpandPass`；
- [x] S1-04 清理 `Renderer.ts` 对 attachment 顺序、内部 texture 和 Pass 类型的依赖；
- [x] S1-05 将 Material AO、Ambient Visibility、Bent Normal 分离；
- [x] S1-06 固定 `ExposureSourceHDR`，禁止 Bloom 改变曝光输入；
- [x] S1-07 将 `ResolutionDomain` 校验放入 FrameGraph build；
- [x] S1-08 将 `PhysicalScaleContract` 作为 AO/SSR/Shadow 唯一 meters→world 转换 owner；
- [x] S1-09 为 product interface 建立 CPU/contract tests；
- [~] S1-10 删除无调用方的旧 composition helper；当前没有可安全删除的 helper，旧 consumer 仍由 Stage 2–5 迁移。

## 4. 不变量

- SurfaceFrame 产生后只能读，后续效果不得写回 Surface；
- 所有 internal/output/tile/fixed/swapchain 跨域都必须显式声明转换；
- Velocity 已包含 current/previous jitter 差值，Temporal 不得二次补偿；
- Renderer 只调用深模块的少量 interface；Pass、shader、bind group 是内部实现；
- feature-off 时产品不会被伪造为全黑资源，也不会创建无消费者 history。

## 5. 退出 Gate

- graph build 能拒绝未声明 domain conversion；
- GTAO OFF 时 BaseColor 和 Material AO bit-identical；
- Bloom OFF/ON 时 Exposure meter 输入语义不变；
- Packed Surface 通过静态、LOD、alpha-test、运动和 invalid key 回归；
- Renderer 不再出现重复 Surface 解释或手工 HDR composite。

## 6. 状态记录

```text
状态：边界已接入 | focused Gate | 产品闭环
变更提交：
涉及 interface：
删除对象：
contract tests：
artifact：
未完成算法：
```

## 7. 2026-09-04 执行记录

### 7.1 本次实现

- `MaterialExpandPass` 现在和 `PackedMaterialResolvePass` 一样产出 `SurfaceFrame`；legacy producer 的 metadata/velocity 缺失语义显式为 `null`；
- 新增 `surfaceFrameWithVelocity()`，以创建新 immutable product 的方式补入 legacy velocity，禁止原地修改 Surface；
- `Renderer.ts` 改为消费 `packedResolveOut.surface ?? matOut.surface`，不再从 `matOut.gPbr/gNormal/gAlbedo/gEmissive` 重新解释 attachment；
- `RENDER_FEATURE_CONTRACTS` 的 owner 改为 `AOService`、`ReflectionService`、`TemporalFeature`，不再把具体旧 Pass 当作公共 contract owner；
- 新增 S1 contract/source test，验证 Packed/legacy 两个 producer 跨同一个 Surface seam。

### 7.2 验证

| 命令/验证 | 结果 |
|---|---|
| `cd OEngine; npm run build` | 通过 |
| `cd OEngine; npm run build:test` | 通过 |
| Stage 1/P2/P3/R5 contract tests | 38/38 通过 |
| `cd OEngine; npm test` | 367/367 通过 |
| `cd examples; npm run build` | 通过 |
| `FX-01 Surface Debug` 浏览器 Gate | `passed=false` |

### 7.3 浏览器 Gate 未关闭项

FX-01 运行完成且 WebGPU/console/page diagnostics 为零，但 `Reactive`、`HistoryValidity` 截图失败，debug view distinct hash 为 `10/11`。这说明 Surface debug Gate 仍有未解释的图像/分类问题；当前不能标记 `focused Gate`，也不能把它归因于本次 legacy seam 迁移。该问题留在 Stage 1 的 Gate 阻塞清单，下一步必须用单独的 debug source/metadata 对照定位，而不是修改 AO/SSR/TAA 算法。

Artifact：`temp/r5/fx-01/ebdf80648f35f0bf0062ea5b3da2b69899f88f37-dirty-fb365ebcbb39/`。

### 7.4 Stage 1 下一步

1. 对 `Reactive` 和 `HistoryValidity` debug view 做 source/metadata/invalid-pixel 的单变量对照；
2. 在 clean scope 上重跑 FX-01，排除当前用户已有 `three.js` gitlink 修改；
3. 只有 FX-01 和 Surface contract Gate 通过后，才进入 Stage 2 Direct-only；
4. `MaterialExpandPass`、`VelocityPass` 和 `OpaqueLightingPipeline` 暂不删除，等待真实 consumer 迁移。
