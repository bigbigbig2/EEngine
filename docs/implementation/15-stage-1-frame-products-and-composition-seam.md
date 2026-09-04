# Stage 1：Surface、Opaque HDR 与组合 Seam

> 状态：`边界已接入，待合同复核`
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

- [ ] S1-01 检查 `FrameProducts.ts` 的资源 id、domain 和 immutable 语义；
- [ ] S1-02 检查 `PackedMaterialResolvePass` 是否是 Packed Surface 唯一 producer；
- [ ] S1-03 明确普通 Scene legacy 的迁移范围，不提前删除有 consumer 的 `MaterialExpandPass`；
- [ ] S1-04 清理 `Renderer.ts` 对 attachment 顺序、内部 texture 和 Pass 类型的依赖；
- [ ] S1-05 将 Material AO、Ambient Visibility、Bent Normal 分离；
- [ ] S1-06 固定 `ExposureSourceHDR`，禁止 Bloom 改变曝光输入；
- [ ] S1-07 将 `ResolutionDomain` 校验放入 FrameGraph build；
- [ ] S1-08 将 `PhysicalScaleContract` 作为 AO/SSR/Shadow 唯一 meters→world 转换 owner；
- [ ] S1-09 为 product interface 建立 CPU/contract tests；
- [ ] S1-10 删除无调用方的旧 composition helper，而不是新增 V2 wrapper。

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
