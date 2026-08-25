# 性能架构定位（严格来自 docs/source/comparison-three-vs-shade.md）

> 母本：`docs/source/comparison-three-vs-shade.md` 全文判断  
> 作用：决定 Layer 3 为什么必须存在，以及不能把 WebGPURenderer 当终点

## 1. 三者关系（母本开篇）

```txt
WebGLRenderer：
  three.js 传统 CPU-driven renderer + WebGL 状态机

WebGPURenderer：
  three.js 传统 CPU-driven scene/render-list 架构
  + WebGPU/WebGL2 backend
  + TSL/Node 系统

Shade：
  WebGPU GPU-resident / GPU-driven renderer
  从数据结构和渲染管线层面重写
```

因此不能说：

```txt
WebGPU > WebGL
```

更准确：

```txt
WebGPURenderer 的底层 API 更现代；
上层 scene/render-list 仍是 three。

Shade（及本工程 Layer 3）不只是换 API，
而是改：谁管理场景、谁剔除、谁生成绘制任务、谁做可见性。
```

## 2. 总体定位表（母本 §1 精神）

| 维度 | WebGLRenderer | WebGPURenderer | Shade / 本工程 Layer 3 方向 |
|------|---------------|----------------|-----------------------------|
| 核心目标 | 成熟兼容 | three 新 renderer，可 fallback WebGL2 | GPU-resident 高端 WebGPU renderer |
| 性能来源 | 驱动优化、render list、instancing | 现代 API、pipeline、TSL、compute | GPU cull、meshlet、VB、GPU scene、deferred |
| CPU | 高（Object3D/draw） | API 层更好，场景遍历仍在 | 目标极低 CPU overhead |
| 大场景 | 中等，靠合并/实例 | 有潜力，非根本重构 | 最强方向 |
| 小中型场景 | 稳 | 未必总更快 | 架构成本可能不划算 |
| 高端效果 | pass 堆 | 更适合新效果 | 从一开始为 TAA/GI/SSR/deferred 设计 |

**工程推论：** Three.js Lite 的价值锚在 **Shade 那一列的架构方向**，同时用 **three 输入层** 保留生态；**不是**停在 WebGPURenderer 列。

## 3. CPU：最大差异之一（母本 §2）

### three 路径（WebGL / WebGPURenderer 共性）

```txt
CPU:
  scene.traverse
  update matrixWorld
  frustum culling
  build render list
  sort
  bind material / geometry / texture
  draw
```

瓶颈典型：

```txt
Object3D / Mesh / Material 数量
draw call
透明排序
JS 遍历与状态
```

WebGPURenderer：**减的是 WebGL API/backend 旧负担，不消除 scene graph/render list 负担。**

### Shade / 目标路径

```txt
CPU:
  加载与上传
  少量全局参数
  提交少量 compute/render pass

GPU:
  instance / meshlet cull
  occlusion
  visibility
  material / lighting
  TAA / SSR / GI / post
```

## 4. Draw call 模型差异（母本 §3）

```txt
WebGL / WebGPURenderer：
  draw 与 render item / mesh / material 强相关

Shade 方向：
  几何阶段 draw 被压低（可见性结构 + 间接）
  material 阶段可按材质组织
  （Shade 案例：几何阶段极少 draw，material ≈ 材质数）
```

## 5. Overdraw 与可见性（母本 §4）

```txt
传统 forward-like：
  可能对最终被挡住的像素做昂贵 shading

Shade 方向：
  visibility 之后，材质对最终可见像素执行
  代价：GPU bandwidth 与结构复杂度上升
```

性能账从：

```txt
CPU draw + overdraw + material switch
```

换到：

```txt
GPU compute + VB + depth pyramid + bandwidth
```

## 6. 何时架构优势明显（母本 §11–§12）

优势明显：

```txt
大量 mesh / instance
大量材质
复杂遮挡
复杂 post / lighting
TAA/SSR/GI 集成需求
CPU draw 已是瓶颈
```

未必划算：

```txt
几十 mesh、少材质、简单 PBR、无复杂 GI、产品查看器级
```

**设计文档必须同时写上这两句**——与docs/source/comparison-three-vs-shade.md 一致，禁止只宣传上限。

## 7. 本工程在表中的位置

```txt
输入与生态：靠向 three（易用、loader、材质语义）
运行时形态：靠向 Babylon Lite（轻、WebGPU-only、data-oriented）
渲染架构：靠向 Shade（GPU-resident / visibility / 现代 frame stack）
运行环境叙事：靠向 docs/source/webgpu-browser-limits.md（沙盒内尽可能强）
```
