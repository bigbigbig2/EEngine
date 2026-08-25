# 架构对比矩阵

状态含义：`待追踪`、`已定位`、`已验证`。本页是研究索引，详细证据放到独立专题。

| 维度 | three.js 初始观察 | reconstructed 初始观察 | 状态 |
|------|------------------|--------------------------------|------|
| 产品范围 | 通用 3D 库，WebGL/WebGPU、广泛对象与材质生态 | WebGPU-only，聚焦 GPU-driven 现代实时渲染 | 已定位 |
| 公共 interface | `Scene` / `Object3D` / `Mesh` / `Material` / renderer | 自有 `Scene` / `Node3D` / `Mesh` / `ShadeMaterial` / `Renderer` | 已定位 |
| renderer seam | common `Renderer` 与 `Backend` 分离；存在 WebGPU 和 WebGL2 adapter | 当前首先表现为直接围绕 WebGPU 组织 | 待追踪 |
| 场景数据所有权 | 场景图对象及 renderer 内部缓存共同参与 | CPU 场景对象加 GPU scene/database | 待追踪 |
| 单帧主编排 | common `Renderer` | `Renderer` + 明确的 frame phases | 待追踪 |
| pass / 依赖表达 | renderer 内部阶段、render context、post processing 等 | 显式 `FrameGraph` 与 pass 目录 | 待追踪 |
| 可见性 | 需追踪 scene projection、frustum culling、render list | 存在 instance / meshlet / HZB culling shader 与 pass | 待追踪 |
| 绘制任务生成 | 需追踪 render item 到 backend draw | 存在 expand、prefix scan、sort、bucket 和间接工作相关路径 | 待追踪 |
| 几何粒度 | object / geometry / draw range / instance 等多种路径 | geometry、instance 与 meshlet 数据结构并存 | 待追踪 |
| GPU 常驻模型 | 资源有 backend 缓存；常驻程度与更新纪律需按类型分析 | 显式 GPU database、allocator、table、resident material context | 待追踪 |
| 材质与 shader | Material + Nodes/TSL + backend shader builder | ShadeMaterial + WGSL shader 模块 + material bucket/resolve | 待追踪 |
| 透明渲染 | 需追踪 render list 排序与材质透明路径 | 存在 transparent OIT shader；完整接线待查 | 待追踪 |
| 光照与阴影 | common lighting/nodes 与 backend 路径 | light database、cluster、shadow atlas、多个 lighting pass | 待追踪 |
| 时域与后处理 | PostProcessing / TSL 能力，具体默认路径待查 | TAA、SSR、motion blur、exposure、bloom、tonemap 等显式 pass | 待追踪 |
| 资源生命周期 | textures/attributes/geometries/bindings 与 backend data maps | 多类 allocator、manager、framegraph reusable resources | 待追踪 |
| 扩展方式 | 对象/材质/Node/TSL/addon/backend 等多层扩展面 | pass、shader、数据库和 renderer 配置；稳定 interface 待查 | 待追踪 |
| 可观测性 | renderer info、inspector、timestamp 等 | GPU timer、statistics history、framegraph DOT 等 | 待追踪 |
| 平台与降级 | WebGPU 优先，可使用 WebGL2 fallback 路径 | WebGPU-only | 已定位 |

## 每个维度必须继续问的问题

1. 调用者真正需要学习的 interface 有多大？
2. 复杂度被哪个 module 隐藏，还是泄漏到多个调用者？
3. 数据的唯一事实源在哪里？什么时候发生复制和失效？
4. 是 CPU 还是 GPU 决定“画什么、怎么分组、何时执行”？
5. 热路径的工作量随 object、instance、meshlet、material、light 数量如何增长？
6. 该设计优化了什么场景，又让什么场景更昂贵？
7. 测试和调试能否通过相同 seam 完成？

## 结论记录纪律

避免写：

> reconstructed 没有 render list，所以 CPU 开销更低。

应写成：

> `[事实]` 在某版本、某调用链中，绘制候选数据由 X 写入 GPU 表，Y compute pass 生成 Z。  
> `[推断]` 因此 CPU 不再逐对象生成最终绘制项。  
> `[假设]` 当实例数量达到 N 时，这会减少主线程时间；需要用指定 benchmark 验证。

