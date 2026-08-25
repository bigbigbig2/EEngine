# 非目标与「不是什么」

> 严格依据：设计 v2 §0、§1.3、§2；docs/source/comparison-three-vs-shade.md；docs/source/webgpu-browser-limits.md；Shade v3 §2–§3

## 1. 项目身份上的「不是」

### 1.1 不是 three.js fork

```txt
不复制 three 主仓库再在 WebGPURenderer 上硬改。
three 的职责停在：资产生态、authoring 习惯、数学与材质语义参考。
```

### 1.2 不是 three.js 的普通插件包

```txt
不是「在现有 WebGPURenderer 上挂 TAAPass / SSRPass」就结束。
docs/source/comparison-three-vs-shade.md：后处理堆叠 ≠ 重写「谁管场景、谁剔除、谁可见性」。
```

### 1.3 不是 Babylon Lite 的 three 换皮

```txt
Babylon Lite 解决：包体、启动、CPU frame、tree-shake、WebGPU-only runtime。
本工程还要：Shade 方向的 GPU scene / visibility / 现代 frame stack。
可以吸收 Lite 的工程纪律，目标集合 strictly 更大（设计 v2 §0 第 3 点）。
```

### 1.4 不是「WebGPU 版 Unreal 原生进程」

```txt
docs/source/webgpu-browser-limits.md 核心结论：
  管线可以接近现代引擎；
  标签页不能变成原生游戏进程。
禁止把分发优势（点开即用）偷换成原生独占资源的假设。
```

## 2. 架构上的「不是」

来自docs/source/comparison-three-vs-shade.md + 设计 v2 §2.1：

```txt
不是：继续以 Object3D render list 为主路径，只换 WebGPU backend
不是：每帧 CPU 遍历场景图决定全部绘制任务作为长期架构
不是：material shader 对大量 overdraw 像素白跑却无可见性结构
不是：把 TSL/NodeMaterial 全体系当作 GPU-resident 场景的主编译路径
```

来自 Shade v3：

```txt
不是：讨论「WebGPU 版 three 能不能快一点」就停
而是：GPU-resident / GPU-driven 是否成立
```

## 3. 兼容性上的「不是」（第一阶段不承诺，母本原意）

```txt
完整 ShaderMaterial / 任意自定义 shader 钩子
完整 NodeMaterial / TSL 作为内核
WebGL fallback
复杂透明优先路径
WebXR 立即完整
全 glTF 扩展一次到位
编辑器级任意 live 改拓扑且零约束
```

说明：这些是 **阶段与范围** 问题，不是「永远禁止研究」；母本用「不适合第一阶段」表述，docs 沿用。

## 4. 性能叙事上的「不是」

来自docs/source/comparison-three-vs-shade.md §11、§15：

```txt
不是：Shade / 本架构在任何小场景都一定更快
不是：WebGPU > WebGL 的简单不等式
不是：用一个小 demo 证明架构上限
而是：大场景、多实例、多材质、复杂遮挡与集成后处理时上限拉开
```

## 5. 文档与工程上的「不是」

```txt
不是：用 docs 重新发明一套与设计 v2 不同的产品公式
不是：把母本高级效果（TAA/SSR/GI…）从目标里静默删除
不是：把docs/source/webgpu-fundamentals.md 当成产品规格
```
