# WebGPU 平台约束（设计层）

> 来源：Shade v3 §20 等；设计 v2 风险；系统学习（显式资源模型）

## C-G1 无 bindless（母本反复强调）

```txt
约束：不能按原生 bindless 引擎假设海量独立纹理随意索引
设计：texture array / atlas / 分档 / 未来 VT 等策略；材质数量扩展要算绑定账
```

## C-G2 Storage / 绑定数量上限

```txt
约束：storage buffer 等 per-stage 数量有限（Shade 讨论过 path tracer 撞限）
设计：表合并、绑定布局收敛、功能分 pass 而不是无限绑
```

## C-G3 无 mesh shader

```txt
约束：meshlet 不能靠硬件 mesh shader 全家桶
设计：compute + indirect 路径（Shade §8）
```

## C-G4 无「完整原生调试器默认体验」

```txt
约束：相对 PIX/RenderDoc/Nsight 生态，浏览器 GPU profiling 更弱（局限文档）
设计：自研 stats/debug view 是一等能力（设计 v2 可测原则）
```

## C-G5 显式 API 成本

```txt
约束：pipeline/bind group/command 比 WebGL 啰嗦（系统学习）
设计：用 FrameGraph + cache 消化复杂度，而不是退回隐式全局状态机
```

## C-G6 带宽

```txt
约束：VB + G-buffer + history 吃带宽（对比 + Shade）
设计：格式打包、分辨率策略、半分辨率效果；承认「不是免费更快」
```
