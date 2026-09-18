# OEngine 当前渲染管线

本页只描述生产数据流和跨 owner 合同。具体算法、格式偏移和迁移步骤分别由 [porting](./porting/README.md)、[specs](./specs/README.md) 与 [implementation](./implementation/README.md) 管理。

## 单帧主路径

```text
explicit scene/asset patches
  -> atomic GPU publication
  -> hierarchy + culling + work generation
  -> indirect hardware meshlet raster
  -> VisibilityKey + depth
  -> visible-pixel classification/finalize
  -> active-bin indirect sparse shading
  -> demanded Surface/velocity + direct lighting
  -> shadow / GI / AO / reflection / transparency
  -> temporal reconstruction
  -> final output
```

`MainRenderPipeline` 生成一份冻结的 `FrameContext` 和一张主 FrameGraph。功能由 dependency demand 启停，但不形成 Core/Quality/Experimental 等独立主管线。FrameGraph 中已声明但无 live consumer 的节点不算实际产品。

## 关键闭环

### Scene publication

`GpuRenderWorld` 把资产、实例、材质和纹理路由作为同一 revision 发布。Pass 只能读取该帧冻结的 revision；半发布状态、CPU 每帧全量对象扫描和 Loader 持有 GPU 资源都不允许。

### Geometry 与 Visibility

生产路径从 resident geometry 和 GPU Scene 生成 hierarchy/work queue，再由 indirect hardware raster 直接消费并写 `VisibilityKey + depth`。VisibilityKey 必须稳定标识 work/instance/local primitive；overflow 和无效 identity fail closed。

OEGPACK V3 与 Web Runtime Cooker 都已通过 producer-neutral Product admission、residency 进入现有 hierarchy/work/raster/Visibility/Sparse Shading；真实 GLB 和 Offline 浏览器 case 已记录成功路径，Emscripten artifact、GLB accessor canonicalizer 和 Worker entry 均存在。GPU miss、resident ancestor fallback、延迟 page demand 和后续上传已有浏览器闭环。仍未闭合的是失败换版回滚、visible-first 大场景 Cook、跨会话 source/WASM 预算、作者纹理保真、公开入口/V2 删除及正式 PERF；细目见 [0016 后续计划](./implementation/0016-remaining-work-plan.md)。

### Sparse shading

可见像素经 classifier/finalizer 进入有界 Shading Bin，active bins 直接驱动 specialized compute shading。完整材质求值只发生一次；下游只消费按需产生的 compact Surface、velocity 和 HDR products。旧 material class/tile backend 不作为 fallback。

### Lighting、Temporal 与 Post

Shadow、direct/indirect lighting、AO/GI/SSR、transparency、temporal 和 post 通过 typed `FrameProducts` 连接。颜色 pyramid、history 和中间 Surface 必须按语义区分，不因物理 allocation 可复用而合并逻辑产品。任一 history consumer 关闭时，对应 history owner 必须退出。

## GPU 队列合同

每个队列必须同时具备：固定元素 ABI、容量来源、overflow 行为、GPU producer、GPU consumer、有效计数和 debug/evidence seam。CPU readback 只用于有界诊断或异步调度反馈，不得重建最终 draw/material list。

## Runtime-first Virtual Geometry 迁移边界

- Web 主路线：GLB Range、versioned Worker CookSession、Nyx geometry-builder Emscripten artifact、GLB accessor canonicalization、Product content identity 与逐页 credit-copy ABI 已进入真实生产 consumer；当前整个 catalog 仍作为一次 bootstrap Cook 的依赖，未实现按可见 asset/shard 出首帧。
- A：独立 Offline Cooker/OEGPACK 第二路线已经通过共同 Product admission/residency/renderer，不拥有独立 renderer。
- B：Producer-neutral admission、page residency、feedback、provider/cook/decode/upload/eviction 已有成功浏览器闭环，但失败事务、全局 bank 预算和策略证据未齐。
- C：active Product generation 已进入现有 main/shadow hierarchy/work/visibility；普通 Scene 与旧 V2 owner 仍待 cutover/delete，不创建新 raster backend。
- D：先区分纹理渐进传输与真实物理 residency；在现有 TextureAssetPackage/TextureResidency/TextureBindingSet 上推进，Virtual Texturing 不是基线。

当前顺序和退出条件见 [0016 实施文档](./implementation/0016-virtualized-assets.md)。
## Product Consumer Status (2026-09-18)

The Product path now reaches the unified production graph through GPU-generated
hierarchy/work, Product MeshletWork, VisibilityKey, Sparse Shading and Packed
CSM shadow depth. Product and package geometry are not mixed in one publication;
real GLB/Offline browser cases and the Emscripten Worker artifact exist. The
remaining gates are failed-publication rollback, bounded visible-first Cook,
authored-material fidelity, Nyx reference differential and V2 cutover.
