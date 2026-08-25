# 设计原则

> 严格依据：设计 v2 §1.4（P0–P10）  
> 补充解释：docs/source/comparison-three-vs-shade.md、docs/source/webgpu-browser-limits.md、Shade v3、docs/source/webgpu-fundamentals.md

母本原则 **原文保留编号**，下列「含义」只做解释，不改优先级。

| ID | 原则（母本） | 含义（用本地文档解释） |
|----|--------------|------------------------|
| **P0** | WebGPU-only | 系统学习：显式现代 API + compute。设计 v2：visibility/compute/storage/indirect 依赖 WebGPU；保留 WebGL 会污染架构。 |
| **P1** | three.js-compatible **input**，不是 three-compatible **internals** | 设计 v2 §2：Scene/Loader/Material 参数可进；Object3D render-list、WebGPURenderer 内核不进。 |
| **P2** | Data-oriented first | 设计 v2 §3：plain data、flat world；对比：CPU 遍历 Object3D 是 three 路径瓶颈来源之一。 |
| **P3** | GPU-resident when profitable | Shade v3 §4：场景关键数据长期在 GPU；对比：Shade 与 three 的根本差在数据结构。 |
| **P4** | Visibility first, shading later | Shade：先 VB/可见性，再昂贵材质；对比：0-overdraw 思路的 material pass。 |
| **P5** | No hidden scene graph in render core | 设计 v2：渲染核不藏 Object3D 树主路径；Authoring 可以有树。 |
| **P6** | Feature modules tree-shakable | Babylon Lite 纪律进 Layer 2；按需 TAA/SSR/GI 等模块。 |
| **P7** | Static path first, dynamic path second | 设计 v2：静态大场景先；GPU animation 等后置但仍在母本路线中。 |
| **P8** | Opaque PBR first, transparent/custom later | 设计 v2；复杂透明不挡主架构。 |
| **P9** | Performance features must be measurable | docs/source/comparison-three-vs-shade.md 全程用瓶颈类型说话；禁止空口「更快」。 |
| **P10** | Browser constraints first-class | docs/source/webgpu-browser-limits.md 全文：标签页、Memory Saver、device lost、DPR、网络与主线程。 |

## 由母本推出的工程推论（不新增产品目标）

```txt
C1  使用 WebGPU ≠ 自动拥有现代 renderer（docs/source/comparison-three-vs-shade.md + Shade v3 §3.3）
C2  three 90% 可参考 shading model 语义；架构必须重做（Shade 帖态度 + 设计 v2）
C3  高级效果（TAA/SSR/GI）应是主管线集成，不是 EffectComposer 外挂堆叠（对比 §9 + Shade）
C4  资源加载与解码在 Web 上可能比「渲染核」更先成为体验瓶颈（webgpu-browser-limits §3–4）
```

## 文档原则

```txt
D1  母本优先于 docs 表述习惯
D2  分册不得删减母本 Layer 3 能力集合的「目标身份」
D3  实现细节后置；架构意图先写清
```
