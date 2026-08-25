# M09 · Shading Baseline — 设计意图

> 依据：设计 v2 静态 opaque PBR first；对比「先能画对」；**不替代** Layer 3

## 1. 为什么存在

```txt
Layer 3（VB/HZB/TAA…）路径长
若没有「table-driven + PBR 语义正确」的底座：
  无法判断错误来自适配、表、还是可见性
```

## 2. 它是什么

```txt
使用 GPU tables 的绘制/着色路径
MeshStandard 子集语义
方向光 + IBL 等基础
为后续 deferred/VB 提供可对比的视觉锚
```

## 3. 它不是什么

```txt
不是工程终点
不是「我们决定不做 Shade-like」
不是 WebGPURenderer 换皮
```

设计 v2 的最终身份仍是 visibility / 集成后处理那条 Layer 3。
