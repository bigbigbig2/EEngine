# three.js 与 reconstructed 引擎对比研究

本目录用于长期、基于源码地研究以下两个工程：

| 工程 | 源码位置 | 当前基线 |
|------|----------|----------|
| three.js | [`../../../three.js/`](../../../three.js/) | `r185` / package `0.185.0` |
| reconstructed | [`../../../research/shade-re/reconstructed/`](../../../research/shade-re/reconstructed/) | package `0.0.0` |

基线记录日期：**2026-08-04**。

研究重点不是判断“谁更先进”，而是理解两条不同渲染路线分别把复杂度放在哪里：

```txt
three.js
  通用场景与材质生态
  → CPU 侧对象/渲染项组织
  → common Renderer
  → WebGPU 或 WebGL2 backend

reconstructed
  WebGPU-only
  → GPU scene / GPU-resident 数据
  → FrameGraph 与显式 pass
  → GPU-driven 可见性、meshlet、间接工作生成
```

上图只是研究起点，不是最终结论。所有重要结论都应回到具体源码、调用链或运行证据。

## 阅读顺序

1. [00-study-charter.md](./00-study-charter.md) — 研究边界、方法和证据规则
2. [01-source-navigation.md](./01-source-navigation.md) — 两边源码入口地图
3. [02-comparison-matrix.md](./02-comparison-matrix.md) — 持续维护的架构对比矩阵
4. [03-render-frame-trace.md](./03-render-frame-trace.md) — 单帧调用链追踪工作台
5. [04-learning-backlog.md](./04-learning-backlog.md) — 后续专题与推荐学习顺序
6. [05-threejs-compute-rasterizer.md](./05-threejs-compute-rasterizer.md) — three.js GPU-driven compute rasterizer 专题
7. [06-performance-and-tradeoffs.md](./06-performance-and-tradeoffs.md) — compute rasterizer 与 reconstructed 的性能及工程权衡

专题分析统一从 [_template-topic-note.md](./_template-topic-note.md) 复制开始。

## 文档定位

- 本目录记录研究过程，可以包含尚未验证的假设。
- [`../../source/`](../../source/) 仍是现有产品设计母本；本目录不会静默改写产品方向。
- 当研究结果影响 OEngine 架构时，应另行更新工程分册或新增 ADR。

## 证据标签

正文中的关键判断使用以下标签：

| 标签 | 含义 |
|------|------|
| `[事实]` | 可由源码、测试、提交或运行结果直接确认 |
| `[推断]` | 根据多个事实形成的架构解释 |
| `[假设]` | 尚需继续读源码、写实验或采样验证 |

尽量在标签后附源码路径和符号名。性能结论必须注明场景、数据规模、浏览器、GPU 和测量方式。
