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

OEGPACK V3 现在已有 `OegPackProductProvider`、producer-neutral Product V1 validator 和 Product-aware bootstrap heap 的 DEV seam，但尚未完成生产 Visibility 浏览器证据。Web Runtime Cooker 已有 container-neutral decoded Product assembly、browser-first Nyx C++/WASM target 与 canonical/recipe/result ABI，但尚无实际 Emscripten artifact、GLB accessor canonicalizer 和 Worker entry。接受的迁移是在同一 hierarchy/work/raster 闭环中替换 geometry/hierarchy 地址来源并加入 resident ancestor fallback 与 page demand；producer ABI 存在不等于 Web Runtime 路线完成。

### Sparse shading

可见像素经 classifier/finalizer 进入有界 Shading Bin，active bins 直接驱动 specialized compute shading。完整材质求值只发生一次；下游只消费按需产生的 compact Surface、velocity 和 HDR products。旧 material class/tile backend 不作为 fallback。

### Lighting、Temporal 与 Post

Shadow、direct/indirect lighting、AO/GI/SSR、transparency、temporal 和 post 通过 typed `FrameProducts` 连接。颜色 pyramid、history 和中间 Surface 必须按语义区分，不因物理 allocation 可复用而合并逻辑产品。任一 history consumer 关闭时，对应 history owner 必须退出。

## GPU 队列合同

每个队列必须同时具备：固定元素 ABI、容量来源、overflow 行为、GPU producer、GPU consumer、有效计数和 debug/evidence seam。CPU readback 只用于有界诊断或异步调度反馈，不得重建最终 draw/material list。

## Runtime-first Virtual Geometry 迁移边界

- Web 主路线：GLB/glTF Range source、versioned Worker CookSession/whole-page credit lease、Nyx geometry-builder WASM build target、GLB accessor canonicalization、CPU/WASM-only Dedicated Worker host/async module entry、Product content identity 和逐页 credit-copy ABI 已有 DEV 实现；真实 Emscripten artifact、progressive immutable Product scene admission 与生产 consumer 仍未闭环。
- A：独立 Offline Cooker/OEGPACK 第二路线已有基础能力，通过 adapter 接入共同 Product，不拥有独立 renderer。
- B：Producer-neutral admission、page residency、feedback、provider/cook/decode/upload/eviction，尚未形成生产闭环。
- C：把 active Product generation 接入现有 hierarchy/work/visibility，不创建新 raster backend。
- D：先区分纹理渐进传输与真实物理 residency；在现有 TextureAssetPackage/TextureResidency/TextureBindingSet 上推进，Virtual Texturing 不是基线。

当前顺序和退出条件见 [0016 实施文档](./implementation/0016-virtualized-assets.md)。
## Product Consumer Status (2026-09-17)

The Product path now reaches the unified production graph through GPU-generated
hierarchy/work, Product MeshletWork, VisibilityKey, Sparse Shading and Packed
CSM shadow depth. Product and package geometry are not mixed in one publication;
browser validation and the real Emscripten Worker artifact remain open.
