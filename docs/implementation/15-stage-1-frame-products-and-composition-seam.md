# Stage 1：Surface、Opaque HDR 与组合边界

> 状态：边界已接入（提交 `fcd53d1`）；不是算法完成。
> 
> 目的：让后续效果消费稳定的 frame products，停止由 `Renderer` 按 attachment 顺序猜测语义。

## 1. 当前代码事实

- `PackedMaterialResolvePass` 已产生 `SurfaceFrame`；普通 `Scene` 仍可能走 `MaterialExpandPass` 和 `VelocityPass`。
- `OpaqueLightingPipeline` 已返回统一 `OpaqueLightingFrame`，底层仍是现有 direct/IBL/indirect Pass。
- `Renderer.ts` 仍是大型 composition root，SSR、AO、Temporal、Post 仍有直接分支。

## 2. 目标产品合同

```ts
interface SurfaceFrame {
  depth: ResourceId;
  pbr: ResourceId;
  normal: ResourceId;
  albedoAo: ResourceId;   // alpha 只表示 Material AO
  emissive: ResourceId;
  velocity: ResourceId;
  metadata: ResourceId;
  domain: TextureDomain<"internal-full">;
}

interface OpaqueLightingFrame {
  hdr: ResourceId;
  iblSpecular: ResourceId;
  indirectDiffuse: ResourceId;
  domain: TextureDomain<"internal-full">;
}
```

产品必须 immutable；消费者只能读，AO 不得写回 Material AO，SSR 只能提交 specular correction。

## 3. 实施顺序

1. 由 Visibility owner 绑定 reverse-Z depth，完成 `SurfaceFrame.depth`，消除当前 `null` 过渡语义。
2. 将 Packed 与普通 `Scene` 的 Surface 输出适配到同一 ABI；适配器只存在于迁移边界，不得成为第三条生产管线。
3. `Renderer` 改为只接收 `SurfaceFrame` 和 `OpaqueLightingFrame`，移除 attachment 顺序重组。
4. 建立统一 `OpaqueTemporalValidity` 输入，供 AO、SSR、最终 Temporal 共享。
5. 每次 producer 输出都记录 domain、资源版本和 completion-safe lifetime。

## 4. 验证

- TypeScript/build/test：产品冻结、非法 ResourceId、domain mismatch、缺失输入；
- GPU：Surface producer→consumer 计数、资源版本和 depth/velocity 对齐；
- 浏览器：静态场景与相机运动序列无黑屏、无错位、无未初始化纹理；
- 性能：与 Stage 0 对比，不增加重复 Material Resolve 或 CPU 全量扫描。

## 5. 退出条件

Packed 和普通 Scene 的真实 consumer 都通过同一 Surface/Lighting ABI；`Renderer` 不再直接解释 attachment；所有效果都能列出自己的输入、输出、history 和 domain。只有满足这些条件，才开始 Stage 2 的算法替换。

