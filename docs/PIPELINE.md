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

OEGPACK V3 当前止于可校验 metadata、独立页和 bootstrap residency proof；Web Runtime Cooker 尚不存在。接受的目标迁移是先建立 Producer-neutral Geometry Product admission，让 Web live product 与 OEGPACK adapter 在此汇合，再在上述闭环中替换 geometry/hierarchy 地址来源并加入 resident ancestor fallback 与 page demand。在任何 Product 真正到达现有 Visibility consumer 之前，不能称为虚拟几何运行时完成。

### Sparse shading

可见像素经 classifier/finalizer 进入有界 Shading Bin，active bins 直接驱动 specialized compute shading。完整材质求值只发生一次；下游只消费按需产生的 compact Surface、velocity 和 HDR products。旧 material class/tile backend 不作为 fallback。

### Lighting、Temporal 与 Post

Shadow、direct/indirect lighting、AO/GI/SSR、transparency、temporal 和 post 通过 typed `FrameProducts` 连接。颜色 pyramid、history 和中间 Surface 必须按语义区分，不因物理 allocation 可复用而合并逻辑产品。任一 history consumer 关闭时，对应 history owner 必须退出。

## GPU 队列合同

每个队列必须同时具备：固定元素 ABI、容量来源、overflow 行为、GPU producer、GPU consumer、有效计数和 debug/evidence seam。CPU readback 只用于有界诊断或异步调度反馈，不得重建最终 draw/material list。

## Runtime-first Virtual Geometry 迁移边界

- Web 主路线：GLB/glTF Range source、WASM/Worker CookSession 与 progressive immutable Product，尚未实现。
- A：独立 Offline Cooker/OEGPACK 第二路线已有基础能力，通过 adapter 接入共同 Product，不拥有独立 renderer。
- B：Producer-neutral admission、page residency、feedback、provider/cook/decode/upload/eviction，尚未形成生产闭环。
- C：把 active Product generation 接入现有 hierarchy/work/visibility，不创建新 raster backend。
- D：先区分纹理渐进传输与真实物理 residency；在现有 TextureAssetPackage/TextureResidency/TextureBindingSet 上推进，Virtual Texturing 不是基线。

当前顺序和退出条件见 [0016 实施文档](./implementation/0016-virtualized-assets.md)。
