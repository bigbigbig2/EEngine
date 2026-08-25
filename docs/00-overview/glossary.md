# 术语表

> 用语对齐：设计 v2、docs/source/comparison-three-vs-shade.md、Shade v3、docs/source/webgpu-fundamentals.md、docs/source/webgpu-browser-limits.md

| 术语 | 在本工程中的含义 | 主要出处 |
|------|------------------|----------|
| **Authoring / 输入层** | 用户侧 three.js：Scene、Mesh、Material、Loader、Camera | 设计 v2 Layer 1 |
| **Lite Runtime** | WebGPU-only、plain data、flat world、tree-shake、FrameGraph | 设计 v2 Layer 2；Babylon Lite 哲学 |
| **Shade-like Renderer** | GPU scene、cull、meshlet、VB、material resolve、集成后处理/GI 方向 | 设计 v2 Layer 3；Shade v3 |
| **CPU-driven** | CPU 管场景、遍历、建 render list、发大量 draw | docs/source/comparison-three-vs-shade.md；Shade v3 §3 |
| **GPU-resident** | 场景关键数据长期在 GPU，非每帧整包由 CPU 组织 | Shade v3 §4.1 |
| **GPU-driven** | 剔除、列表、间接绘制等由 GPU 生成/筛选 | Shade v3 §4.2 |
| **Render list / Render item** | three 传统：按 mesh/material 等形成绘制项再提交 | docs/source/comparison-three-vs-shade.md |
| **GPU scene tables** | instance/mesh/material/transform 等连续表 | 设计 v2 §6 |
| **Meshlet** | 小三角簇，细粒度 cull/可见性 | Shade v3 §8；设计 v2 §8 |
| **Visibility Buffer** | 像素先存可见几何 ID，再 resolve 材质 | Shade v3 §6；设计 v2 §9 |
| **Material Resolve** | 按可见像素/材质组织 shading，目标避免无效 overdraw | Shade #86 思路；对比 §4 |
| **HZB / Depth Pyramid** | 层级深度，供 occlusion | Shade v3 §7 |
| **FrameGraph / RenderGraph** | pass 与临时资源声明、依赖与别名 | 设计 v2；Shade §10 |
| **TAA 侵入性** | TAA 要求整管线感知 jitter/history/motion | Shade v3 §12；对比 §8 |
| **TSL / NodeMaterial** | three 新材质/shader 图路径；本工程不以其为 GPU-resident 内核 | docs/source/comparison-three-vs-shade.md；设计 v2 |
| **Device lost** | WebGPU 设备丢失，资源需重建 | docs/source/webgpu-browser-limits.md |
| **标签页生命周期** | 隐藏节流、Memory Saver、rAF 停止等 | docs/source/webgpu-browser-limits.md |
| **Bindless 缺失** | WebGPU 无 bindless，纹理/材质扩展受限 | Shade v3 §20；对比 §7 |

新增术语时注明出处文档，避免 docs 自造与母本冲突的词。
