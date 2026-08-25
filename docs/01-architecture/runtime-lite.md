# Layer 2 · Lite Runtime 设计意图

> 严格依据：设计 v2 §3「从 Babylon Lite 借鉴什么」  
> 渲染上限仍来自 Layer 3 / Shade，不在本章收缩

## 1. 借鉴什么（母本）

Babylon Lite 的关键 **不是**「WebGPU 更快」，而是：

```txt
- WebGPU-exclusive
- No classes（倾向 plain data + functions）
- obsessively tree-shakable
- flat SceneContext
- one-way ownership
- material-owned builders（思路）
- FrameGraph + RenderTask
- ShaderFragment composition
- bundle/perf/parity 工程文化
```

本工程吸收这些 **工程原则**，并接到 Shade-like renderer。

## 2. WebGPU-only（母本 §3.1）

```txt
1. VB / compute / storage / indirect 依赖 WebGPU
2. 保留 WebGL fallback 会污染架构
3. WebGL 路径无法承载完整目标
4. Lite 定位是现代 WebGPU runtime，不是 universal renderer
```

docs/source/webgpu-fundamentals.md 补充：WebGPU 是描述式配置 + 命令录制，不是 WebGL 全局状态机——与 FrameGraph/显式 pass 一致。

## 3. Plain data + flat world（母本 §3.2–3.3）

```txt
Authoring：可以有树（three Object3D）
Runtime：flat stores / tables，避免渲染核 class 场景图

WorldContext 类聚合：
  engine、assets、transforms、meshes、instances、
  materials、textures、lights、cameras、
  frameGraph、gpuScene、dirty、modules
```

原则：

```txt
单向所有权
子项不反向持有 World 形成乱引用
利于序列化、diff、上传 GPU
```

## 4. Tree-shaking 与模块（母本 §3.4）

```txt
按功能分包：core / adapter / gltf / pbr / meshlet /
  visibility / taa / ssr / gi / shadows / post / debug

禁止：
  顶层自动注册全部材质
  顶层 import 全部 shader
  顶层 side effect 创建 device 资源
```

对应设计原则 P6：高级效果是目标集合，但是 **可按需装载的模块**，不是一个无法拆的单体。

## 5. FrameGraph（母本 §3.5）

```txt
FrameGraph 是 renderer 内核的 pass 调度器，
不是 three EffectComposer 的简单换皮。

与 Babylon Lite 的差别（母本）：
  Babylon Lite：固定化传统 render pass，减 CPU
  本工程：固定化 GPU-driven pipeline，
          连接 compute / raster / fullscreen / temporal
```

Shade v3 §10：现代栈 pass 极多，需要资源别名与依赖清晰——与本层一致。

## 6. Runtime 与「高性能」的分工

```txt
Layer 2 解决：可维护、可裁剪、WebGPU 原生、数据面向、调度清晰
Layer 3 解决：可见性、meshlet、VB、集成后处理与 GI 等上限

没有 Layer 2：Layer 3 会做成不可维护的巨石
没有 Layer 3：只做 Layer 2 会退化成「又一个轻量 three 后端」，违背设计 v2 §0
```
