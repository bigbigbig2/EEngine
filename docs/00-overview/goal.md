# 项目目标

> 严格依据：`docs/source/design-v2-full.md` §0–§1  
> 判断依据：`docs/source/comparison-three-vs-shade.md`（架构差）· `docs/source/webgpu-browser-limits.md`（环境）· `docs/source/shade-reference-v3.md`（上限参照）

## 1. 一句话（母本原文结构）

**Three.js Lite** 是一个：

```txt
WebGPU-only、data-oriented、three.js-compatible 的高性能实时渲染 runtime
```

它不是要替代 three.js 成为通用 3D 框架，而是提供 **面向高端实时渲染场景的专用 renderer/runtime**：

```txt
three.js:
  通用、易用、生态大、兼容广

Three.js Lite:
  轻量 runtime + 高性能、高级效果的 WebGPU 渲染核

Shade:
  技术参考方向：GPU-resident / visibility-buffer renderer
```

## 2. 工程等式（母本 §0）

你要做的不是下面三个：

```txt
1. 不是 three.js fork（复制主仓库硬改 WebGPURenderer）
2. 不是 three.js WebGPU 插件（加几个 TAA/SSR pass 结束）
3. 不是 Babylon Lite 的 three 复刻（只做包体与 CPU frame，不做 Shade 级可见性管线）
```

你要做的是：

```txt
Three.js Lite / ThreeShadeLite
  = three.js 生态输入层
  + Babylon Lite 风格轻量 runtime
  + Shade-like GPU scene / visibility buffer / deferred material resolve
  + 高级效果管线：TAA / SSR / GI / Shadow / Bloom / PostProcess
```

一句话（母本）：

> **three.js 负责「用户熟悉的输入与资产生态」；Three.js Lite 负责「真正的 WebGPU 高性能渲染内核」。**

## 3. 「Lite」的两层含义（母本 §1.2）

### 3.1 运行时轻（Babylon Lite 方向）

```txt
- WebGPU-only
- 去掉 WebGL fallback
- 去掉历史兼容层
- 去掉 class-heavy API 作为内核
- plain data + functions
- 强 tree-shaking
- 按需模块
- flat scene context
```

### 3.2 渲染核重（Shade 方向）

```txt
- GPU scene tables
- GPU culling
- meshlet / cluster
- visibility buffer
- material pass 面向最终可见像素
- TAA / SSR / GI / shadow / postprocess
```

因此：**不是功能少的 Lite，而是「运行时轻、渲染内核重」的 Lite。**

## 4. 适用场景（母本 §1.3）

适合：

```txt
1. 大规模 Web 3D 场景
2. 建筑可视化 / archviz
3. 城市场景 / 大量实例
4. 大量 static mesh + 不透明 PBR
5. 高级后处理
6. SSR / TAA / GI / contact shadow / soft shadow
7. WebGPU-only 产品
8. 需要 three.js 资产生态，但不满足 three.js renderer 性能上限的项目
```

不适合作为 **第一阶段就承诺** 的（母本原列表，不是永久删除目标）：

```txt
1. 需要 WebGL fallback
2. 需要完整 three.js ShaderMaterial 兼容
3. 需要复杂透明材质优先
4. 需要 WebXR 立即完整支持
5. 移动端低端设备优先
6. 需要编辑器任意拖拽动态改材质/拓扑
7. 需要完整 glTF extension 一次性全支持
```

## 5. 成功标准（与docs/source/comparison-three-vs-shade.md / Shade 对齐的架构成功）

从 `docs/source/comparison-three-vs-shade.md` 看，成功 **不是**「换成 WebGPU 以后默认更快」，而是：

```txt
1. 场景管理、剔除、绘制任务生成、可见性 不再由 three CPU render-list 主导
2. 关键场景数据可以 GPU-resident
3. 大场景 / 多实例 / 多材质 / 复杂后处理路径上，架构上限对齐 Shade 方向
4. 小中型简单场景不自欺「一定更快」（docs/source/comparison-three-vs-shade.md：架构成本可能不划算）
5. 全程承认浏览器沙盒（docs/source/webgpu-browser-limits.md），不宣称原生进程等价
```

从 Shade 解读看，讨论的问题是：

```txt
浏览器里能否实现接近现代主机/PC 游戏引擎的 GPU-resident 架构？
```

本工程的答案方向是：**在浏览器约束内尽可能做，而不是否认约束。**

## 6. 与docs/source/webgpu-fundamentals.md 的关系

`docs/source/webgpu-fundamentals.md` 不定义产品，只定义能力前提：

```txt
WebGPU 两件事：渲染；compute。
显式 pipeline / bind group / command encoder。
这是 Layer 2/3 能存在的 API 地基。
```
